import sql from 'mssql';

const dbConfig = {
  server: process.env.DB_SERVER,
  port: parseInt(process.env.DB_PORT, 10),
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false },
  requestTimeout: 60000,
  connectionTimeout: 30000,
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 }
};

let poolPromise = null;
function getPool() {
  if (!poolPromise) poolPromise = new sql.ConnectionPool(dbConfig).connect();
  return poolPromise;
}

export function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

function fmt(d) { return d.toISOString().slice(0, 10); }

// YTD actual = 1 enero del año en curso hasta hoy.
// YTD anterior = mismo rango de dias, un año antes (comparacion homogenea).
export function dateRanges() {
  const now = new Date();
  const curYear = now.getFullYear();
  const curStart = new Date(Date.UTC(curYear, 0, 1));
  const curEnd = now;
  const prevStart = new Date(Date.UTC(curYear - 1, 0, 1));
  const prevEnd = new Date(Date.UTC(curYear - 1, now.getUTCMonth(), now.getUTCDate()));
  return {
    curStart: fmt(curStart), curEnd: fmt(curEnd),
    prevStart: fmt(prevStart), prevEnd: fmt(prevEnd),
    curYear, prevYear: curYear - 1
  };
}

// ── Definiciones oficiales de negocio (segun vista SQL de Nico) ─────────────
// "Sales" = vBI_SALES_DATA: lo que se ha VENDIDO (pedido), con conversion a EUR
// a tipo de cambio fijo de reporting (no el spot). Filtra Type y excluye unos
// DocNum concretos marcados como erroneos/duplicados en el origen.
const SALES_TYPE_FILTER = ['Frames', 'Others Flagship'];
const SALES_EXCLUDED_DOCNUMS = [
  '0185001486', '121124672', '0060003093', '0075099698',
  '0075099696', '0075101049', '0185001487', '0060012201'
];

function salesAmountEurExpr(a) {
  return `CASE
    WHEN ${a}.DocDate >= '2026-01-01' AND ${a}.Sucursal = 'US' THEN ${a}.Amount / 1.20
    WHEN ${a}.DocDate >= '2026-01-01' AND ${a}.Sucursal = 'CA' THEN ${a}.Amount / 1.60
    WHEN ${a}.DocDate >= '2025-01-01' AND ${a}.DocDate < '2026-01-01' AND ${a}.Sucursal = 'US' THEN ${a}.Amount / 1.18
    WHEN ${a}.DocDate >= '2025-01-01' AND ${a}.DocDate < '2026-01-01' AND ${a}.Sucursal = 'CA' THEN ${a}.Amount / 1.56
    WHEN ${a}.Sucursal = 'BCN' THEN ${a}.Amount / 1
    ELSE NULL
  END`;
}

// "Invoicing" = vBI_INVOICING_DATA: lo que se ha FACTURADO realmente.
// Misma logica de FX fijo que Sales, pero sobre Amount y con fallback a
// Amount sin convertir para fechas fuera de rango (asi es la query oficial
// de Nico, a diferencia de Sales que en ese caso devuelve NULL).
// No filtra Anulada ni excluye DocNum - tal cual la vista oficial de Nico.
function invoicingAmountEurExpr(a) {
  return `CASE
    WHEN ${a}.DocDate >= '2026-01-01' AND ${a}.Sucursal = 'US' THEN ${a}.Amount / 1.20
    WHEN ${a}.DocDate >= '2026-01-01' AND ${a}.Sucursal = 'CA' THEN ${a}.Amount / 1.60
    WHEN ${a}.DocDate >= '2025-01-01' AND ${a}.DocDate < '2026-01-01' AND ${a}.Sucursal = 'US' THEN ${a}.Amount / 1.18
    WHEN ${a}.DocDate >= '2025-01-01' AND ${a}.DocDate < '2026-01-01' AND ${a}.Sucursal = 'CA' THEN ${a}.Amount / 1.56
    WHEN ${a}.Sucursal = 'BCN' THEN ${a}.Amount / 1
    ELSE ${a}.Amount
  END`;
}

const SOURCES = {
  sales: {
    table: '[dbo].[vBI_SALES_DATA]',
    alias: 's',
    amountExpr: salesAmountEurExpr('s'),
    cols: { market: 's.CountryName', rep: 's.DocSlpName', brand: 's.Marca', channel: 's.OrderType' },
    extraWhere: (req) => {
      const typeParams = SALES_TYPE_FILTER.map((t, idx) => { req.input(`ty${idx}`, sql.NVarChar, t); return `@ty${idx}`; });
      const excParams = SALES_EXCLUDED_DOCNUMS.map((d, idx) => { req.input(`ex${idx}`, sql.NVarChar, d); return `@ex${idx}`; });
      return [
        `s.Type IN (${typeParams.join(',')})`,
        `s.DocNum NOT IN (${excParams.join(',')})`,
        `s.DocDate >= '2023-01-01'`
      ];
    }
  },
  invoicing: {
    table: '[dbo].[vBI_INVOICING_DATA]',
    alias: 'i',
    amountExpr: invoicingAmountEurExpr('i'),
    cols: { market: 'i.Country', rep: 'i.DocSlpName', brand: 'i.Marca', channel: 'i.OrderType' },
    extraWhere: (req) => {
      const typeParams = SALES_TYPE_FILTER.map((t, idx) => { req.input(`ity${idx}`, sql.NVarChar, t); return `@ity${idx}`; });
      return [
        `i.Type IN (${typeParams.join(',')})`,
        `i.DocDate >= '2023-01-01'`
      ];
    }
  }
};

function getSource(source) {
  const s = SOURCES[source];
  if (!s) throw new Error(`source desconocido: ${source} (usa 'sales' o 'invoicing')`);
  return s;
}

function buildCommonWhere(req, src, filters, ranges) {
  const a = src.alias;
  const parts = [
    `${a}.DocDate BETWEEN @prevStart AND @curEnd`,
    ...src.extraWhere(req)
  ];
  req.input('curStart', sql.Date, ranges.curStart);
  req.input('curEnd', sql.Date, ranges.curEnd);
  req.input('prevStart', sql.Date, ranges.prevStart);
  req.input('prevEnd', sql.Date, ranges.prevEnd);

  if (filters.market) { parts.push(`${src.cols.market} LIKE @market`); req.input('market', sql.NVarChar, `%${filters.market}%`); }
  if (filters.rep) { parts.push(`${src.cols.rep} LIKE @rep`); req.input('rep', sql.NVarChar, `%${filters.rep}%`); }
  if (filters.channel) { parts.push(`${src.cols.channel} LIKE @channel`); req.input('channel', sql.NVarChar, `%${filters.channel}%`); }
  if (filters.brand) { parts.push(`${src.cols.brand} = @brand`); req.input('brand', sql.NVarChar, filters.brand); }
  if (filters.nameQuery) { parts.push(`${a}.CardName LIKE @nameQuery`); req.input('nameQuery', sql.NVarChar, `%${filters.nameQuery}%`); }
  return parts.join(' AND ');
}

function withVariation(r) {
  const ytd_cur = r.ytd_cur || 0;
  const ytd_prev = r.ytd_prev || 0;
  const variacion_pct = ytd_prev !== 0
    ? +(((ytd_cur - ytd_prev) / Math.abs(ytd_prev)) * 100).toFixed(1)
    : (ytd_cur !== 0 ? null : 0);
  return {
    ytd_actual: round2(ytd_cur),
    ytd_anterior: round2(ytd_prev),
    variacion_pct,
    variacion_abs: round2(ytd_cur - ytd_prev)
  };
}

export async function aggregateBy(source, dimension, filters = {}) {
  const src = getSource(source);
  const dimCol = src.cols[dimension];
  if (!dimCol) throw new Error(`Dimension desconocida: ${dimension}`);
  const dimExpr = `ISNULL(${dimCol}, 'Sin asignar')`;
  const a = src.alias;

  const pool = await getPool();
  const req = pool.request();
  const ranges = dateRanges();
  const where = buildCommonWhere(req, src, filters, ranges);

  const query = `
    SELECT
      ${dimExpr} AS grp,
      SUM(CASE WHEN ${a}.DocDate BETWEEN @curStart AND @curEnd THEN ${src.amountExpr} ELSE 0 END) AS ytd_cur,
      SUM(CASE WHEN ${a}.DocDate BETWEEN @prevStart AND @prevEnd THEN ${src.amountExpr} ELSE 0 END) AS ytd_prev,
      COUNT(DISTINCT CASE WHEN ${a}.DocDate BETWEEN @curStart AND @curEnd THEN ${a}.CardCode END) AS clientes_activos
    FROM ${src.table} ${a}
    WHERE ${where}
    GROUP BY ${dimExpr}
  `;
  const result = await req.query(query);
  return result.recordset.map(r => ({
    nombre: r.grp || 'Sin asignar',
    clientes_activos: r.clientes_activos,
    ...withVariation(r)
  }));
}

export async function getCompanyTotal(source, filters = {}) {
  const src = getSource(source);
  const a = src.alias;
  const pool = await getPool();
  const req = pool.request();
  const ranges = dateRanges();
  const where = buildCommonWhere(req, src, filters, ranges);
  const query = `
    SELECT
      SUM(CASE WHEN ${a}.DocDate BETWEEN @curStart AND @curEnd THEN ${src.amountExpr} ELSE 0 END) AS ytd_cur,
      SUM(CASE WHEN ${a}.DocDate BETWEEN @prevStart AND @prevEnd THEN ${src.amountExpr} ELSE 0 END) AS ytd_prev,
      COUNT(DISTINCT CASE WHEN ${a}.DocDate BETWEEN @curStart AND @curEnd THEN ${a}.CardCode END) AS clientes_activos
    FROM ${src.table} ${a}
    WHERE ${where}
  `;
  const result = await req.query(query);
  const r = result.recordset[0] || {};
  return { clientes_activos: r.clientes_activos || 0, ...withVariation(r), ...ranges };
}

// Agregado a nivel cliente individual (para riesgo, crecimiento y busqueda).
export async function aggregateClients(source, filters = {}) {
  const src = getSource(source);
  const a = src.alias;
  const pool = await getPool();
  const req = pool.request();
  const ranges = dateRanges();
  const where = buildCommonWhere(req, src, filters, ranges);
  const query = `
    SELECT
      ${a}.CardCode AS cardCode,
      MAX(${a}.CardName) AS cardName,
      ISNULL(MAX(${src.cols.market}), 'Sin asignar') AS market,
      ISNULL(MAX(${src.cols.rep}), 'Sin asignar') AS rep,
      ISNULL(MAX(${src.cols.channel}), 'Sin asignar') AS channel,
      SUM(CASE WHEN ${a}.DocDate BETWEEN @curStart AND @curEnd THEN ${src.amountExpr} ELSE 0 END) AS ytd_cur,
      SUM(CASE WHEN ${a}.DocDate BETWEEN @prevStart AND @prevEnd THEN ${src.amountExpr} ELSE 0 END) AS ytd_prev
    FROM ${src.table} ${a}
    WHERE ${where}
    GROUP BY ${a}.CardCode
  `;
  const result = await req.query(query);
  return result.recordset.map(r => ({
    cliente: r.cardName || r.cardCode,
    pais: r.market,
    representante: r.rep,
    canal: r.channel,
    ...withVariation(r)
  }));
}
