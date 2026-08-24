import sql from 'mssql';

const dbConfig = {
  server: process.env.DB_SERVER,
  port: parseInt(process.env.DB_PORT, 10),
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false },
  requestTimeout: 120000,
  connectionTimeout: 30000
};

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min

let cache = null;
let lastLoad = 0;
let loadingPromise = null;

async function loadFromSQL() {
  const pool = await sql.connect(dbConfig);
  const result = await pool.request().query(`
    SELECT CardName, CustomerID, ZipCode, Address, City,
           SlpName, AreaName, Market, ChannelName,
           EB_2025_FY, EB_2025_YTD, EB_2026_YTD,
           LO_2025_FY, LO_2025_YTD, LO_2026_YTD
    FROM [ETN_REPORTING].[conf].[CLAUDE_MAP]
  `);
  await sql.close();

  cache = result.recordset.map(r => {
    const eb25 = r.EB_2025_YTD || 0;
    const eb26 = r.EB_2026_YTD || 0;
    const lo25 = r.LO_2025_YTD || 0;
    const lo26 = r.LO_2026_YTD || 0;
    const ytd25 = eb25 + lo25;
    const ytd26 = eb26 + lo26;
    const fy25 = (r.EB_2025_FY || 0) + (r.LO_2025_FY || 0);
    const varPct = ytd25 > 0 ? +(((ytd26 - ytd25) / ytd25) * 100).toFixed(1) : (ytd26 > 0 ? null : 0);
    return {
      customerId: r.CustomerID,
      cardName: r.CardName || '(sin nombre)',
      city: r.City || '',
      zipCode: r.ZipCode || '',
      market: r.Market || 'Sin asignar',
      rep: r.SlpName || 'Sin asignar',
      area: r.AreaName || 'Sin asignar',
      channel: r.ChannelName || 'Sin asignar',
      eb25, eb26, lo25, lo26, ytd25, ytd26, fy25, varPct
    };
  });
  lastLoad = Date.now();
  return cache;
}

// Evita cargas en paralelo si llegan varias peticiones a la vez con la cache fria
export async function getData() {
  if (cache && Date.now() - lastLoad < CACHE_TTL_MS) return cache;
  if (!loadingPromise) {
    loadingPromise = loadFromSQL().finally(() => { loadingPromise = null; });
  }
  return loadingPromise;
}

export function sum(rows, field) {
  return rows.reduce((acc, r) => acc + (r[field] || 0), 0);
}

export function round(n) {
  return Math.round((n || 0) * 100) / 100;
}

export function groupBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const key = keyFn(r) || 'Sin asignar';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

export function summarizeGroup(name, rows) {
  const ytd25 = sum(rows, 'ytd25');
  const ytd26 = sum(rows, 'ytd26');
  const eb26 = sum(rows, 'eb26');
  const lo26 = sum(rows, 'lo26');
  const fy25 = sum(rows, 'fy25');
  const varPct = ytd25 > 0 ? +(((ytd26 - ytd25) / ytd25) * 100).toFixed(1) : null;
  const varAbs = round(ytd26 - ytd25);
  return {
    nombre: name,
    clientes: rows.length,
    ytd_2025: round(ytd25),
    ytd_2026: round(ytd26),
    variacion_pct: varPct,
    variacion_abs: varAbs,
    eb_2026_ytd: round(eb26),
    lo_2026_ytd: round(lo26),
    fy_2025: round(fy25)
  };
}
