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

// ── Definiciones oficiales de negocio (validadas contra el informe de Nico) ─
// Base: vBI_SALES_DATA ("Sales" = vendido/pedido) y vBI_INVOICING_DATA
// ("Invoicing" = facturado real), cruzadas SIEMPRE con vBI_CUSTOMER_DATA por
// idCustomer (INNER JOIN: un cliente sin ficha es una cuenta intercompania /
// placeholder, p.ej. "Etnia Barcelona LLC" - no cuenta como venta real).
// El "Market" (pais agrupado, p.ej. CEE/MEA/APAC/LATAM) sale de mapear
// Customer.AreaName -> vBI_GROUPINGS.Option (Type='areaname') -> Group.
const TYPE_FILTER = ['Frames', 'Others Flagship'];
// Exclusiones exactas de la query oficial de Sales (DocNum erroneos/duplicados).
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

// Invoicing usa la misma logica de FX pero con fallback a Amount sin
// convertir (asi es la query oficial de Nico, a diferencia de Sales).
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

// Exclusion exacta del Power Query de Sales: ajustes ZG3 de tiendas
// flagship concretas (importes negativos de correccion, no venta real).
const SALES_EXCLUDED_FLAGSHIP_ZG3 = ['FLAG0001', 'FLAG0002', '0200000030'];

const SOURCES = {
  sales: {
    table: '[dbo].[vBI_SALES_DATA]',
    alias: 's',
    amountExpr: salesAmountEurExpr('s'),
    // La query oficial hace JOIN (no LEFT JOIN) con vBI_ITEM_DATA por idItem.
    extraJoin: (a) => `JOIN [dbo].[vBI_ITEM_DATA] it ON it.idItem = ${a}.idItem`,
    extraWhere: (req) => {
      const typeParams = TYPE_FILTER.map((t, idx) => { req.input(`ty${idx}`, sql.NVarChar, t); return `@ty${idx}`; });
      const excParams = SALES_EXCLUDED_DOCNUMS.map((d, idx) => { req.input(`ex${idx}`, sql.NVarChar, d); return `@ex${idx}`; });
      const flagParams = SALES_EXCLUDED_FLAGSHIP_ZG3.map((c, idx) => { req.input(`flag${idx}`, sql.NVarChar, c); return `@flag${idx}`; });
      return [
        `s.Type IN (${typeParams.join(',')})`,
        `s.DocNum NOT IN (${excParams.join(',')})`,
        `s.DocDate >= '2023-01-01'`,
        `s.SeriesName <> 'DZCO'`,
        `NOT (s.CardCode IN (${flagParams.join(',')}) AND s.SeriesName = 'ZG3')`
      ];
    }
  },
  invoicing: {
    table: '[dbo].[vBI_INVOICING_DATA]',
    alias: 'i',
    amountExpr: invoicingAmountEurExpr('i'),
    extraWhere: (req) => {
      const typeParams = TYPE_FILTER.map((t, idx) => { req.input(`ity${idx}`, sql.NVarChar, t); return `@ity${idx}`; });
      return [
        `i.Type IN (${typeParams.join(',')})`,
        `i.DocDate >= '2023-01-01'`
      ];
    }
  }
};

// Dimensiones: "market" sale de Customer.AreaName -> vBI_GROUPINGS, el resto
// vive directamente en la fila de Sales/Invoicing.
function dimExprFor(a, dimension) {
  switch (dimension) {
    case 'market': return `ISNULL(UPPER(g.[Group]), 'Sin asignar')`;
    // El representante es el asignado al CLIENTE (Customer.SlpName), no el de
    // la linea de venta (DocSlpName puede diferir si el pedido lo registro
    // otra persona) - validado contra el informe: SlpName cuadra al centimo.
    case 'rep': return `ISNULL(c.SlpName, 'Sin asignar')`;
    case 'channel': return `ISNULL(${a}.OrderType, 'Sin asignar')`;
    case 'brand': return `ISNULL(${a}.Marca, 'Sin asignar')`;
    default: throw new Error(`Dimension desconocida: ${dimension}`);
  }
}

function getSource(source) {
  const s = SOURCES[source];
  if (!s) throw new Error(`source desconocido: ${source} (usa 'sales' o 'invoicing')`);
  return s;
}

// Cliente debe existir en Customer (INNER JOIN por idCustomer) - excluye
// cuentas intercompania/placeholder que no representan venta real a terceros.
// Se excluye tambien el canal EB GROUP (grupo interno), salvo la cuenta
// idCustomer='USEB SpainEB' que Power Query reclasifica a OPTICS.
function buildFromAndWhere(req, src, filters, ranges) {
  const a = src.alias;
  const from = `
    FROM ${src.table} ${a}
    JOIN [dbo].[vBI_CUSTOMER_DATA] c ON c.idCustomer = ${a}.idCustomer AND c.ChannelName <> 'EB GROUP' AND c.Sucursal <> 'HK'
    LEFT JOIN [dbo].[vBI_GROUPINGS] g ON g.[Option] = c.AreaName AND g.[Type] = 'areaname'
    ${src.extraJoin ? src.extraJoin(a) : ''}
  `;
  const parts = [
    `${a}.DocDate BETWEEN @prevStart AND @curEnd`,
    ...src.extraWhere(req)
  ];
  req.input('curStart', sql.Date, ranges.curStart);
  req.input('curEnd', sql.Date, ranges.curEnd);
  req.input('prevStart', sql.Date, ranges.prevStart);
  req.input('prevEnd', sql.Date, ranges.prevEnd);

  if (filters.market) { parts.push(`UPPER(g.[Group]) LIKE @market`); req.input('market', sql.NVarChar, `%${filters.market.toUpperCase()}%`); }
  if (filters.rep) { parts.push(`c.SlpName LIKE @rep`); req.input('rep', sql.NVarChar, `%${filters.rep}%`); }
  if (filters.channel) { parts.push(`${a}.OrderType LIKE @channel`); req.input('channel', sql.NVarChar, `%${filters.channel}%`); }
  if (filters.brand) { parts.push(`${a}.Marca = @brand`); req.input('brand', sql.NVarChar, filters.brand); }
  if (filters.nameQuery) { parts.push(`${a}.CardName LIKE @nameQuery`); req.input('nameQuery', sql.NVarChar, `%${filters.nameQuery}%`); }
  return { from, where: parts.join(' AND ') };
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
  const a = src.alias;
  const dimExpr = dimExprFor(a, dimension);

  const pool = await getPool();
  const req = pool.request();
  const ranges = dateRanges();
  const { from, where } = buildFromAndWhere(req, src, filters, ranges);

  const query = `
    SELECT
      ${dimExpr} AS grp,
      SUM(CASE WHEN ${a}.DocDate BETWEEN @curStart AND @curEnd THEN ${src.amountExpr} ELSE 0 END) AS ytd_cur,
      SUM(CASE WHEN ${a}.DocDate BETWEEN @prevStart AND @prevEnd THEN ${src.amountExpr} ELSE 0 END) AS ytd_prev,
      COUNT(DISTINCT CASE WHEN ${a}.DocDate BETWEEN @curStart AND @curEnd THEN ${a}.CardCode END) AS clientes_activos
    ${from}
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
  const { from, where } = buildFromAndWhere(req, src, filters, ranges);
  const query = `
    SELECT
      SUM(CASE WHEN ${a}.DocDate BETWEEN @curStart AND @curEnd THEN ${src.amountExpr} ELSE 0 END) AS ytd_cur,
      SUM(CASE WHEN ${a}.DocDate BETWEEN @prevStart AND @prevEnd THEN ${src.amountExpr} ELSE 0 END) AS ytd_prev,
      COUNT(DISTINCT CASE WHEN ${a}.DocDate BETWEEN @curStart AND @curEnd THEN ${a}.CardCode END) AS clientes_activos
    ${from}
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
  const { from, where } = buildFromAndWhere(req, src, filters, ranges);
  const query = `
    SELECT
      ${a}.CardCode AS cardCode,
      MAX(${a}.CardName) AS cardName,
      ISNULL(MAX(UPPER(g.[Group])), 'Sin asignar') AS market,
      ISNULL(MAX(c.SlpName), 'Sin asignar') AS rep,
      ISNULL(MAX(${a}.OrderType), 'Sin asignar') AS channel,
      SUM(CASE WHEN ${a}.DocDate BETWEEN @curStart AND @curEnd THEN ${src.amountExpr} ELSE 0 END) AS ytd_cur,
      SUM(CASE WHEN ${a}.DocDate BETWEEN @prevStart AND @prevEnd THEN ${src.amountExpr} ELSE 0 END) AS ytd_prev
    ${from}
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
