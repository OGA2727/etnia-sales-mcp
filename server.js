import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { getData, sum, round, groupBy, summarizeGroup } from './data.js';

const PERSONA = `Eres el analista de ventas senior de ETNIA (marca de moda de gafas). Cuando uses estas
herramientas para responder, actua como un experto en analitica comercial retail/eyewear:
- Da siempre el numero Y la lectura de negocio (que significa, si es bueno o malo, por que podria estar pasando).
- Prioriza palancas de mejora concretas y accionables: concentracion de cartera en pocos clientes,
  representantes o zonas por debajo de la media, clientes con caida de YTD que conviene visitar,
  diferencias de mix EB vs LO, estacionalidad.
- Compara siempre contra el año anterior (YTD 2025 vs YTD 2026) y contra la media del grupo (pais, red, canal).
- Si detectas un dato con muy pocos clientes o volumen bajo, adviertelo (baja significatividad).
- Se directo y conciso, con listas y numeros, no rodeos.`;

const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function applyFilters(rows, { market, rep, channel } = {}) {
  let r = rows;
  if (market) r = r.filter(x => x.market.toLowerCase().includes(market.toLowerCase()));
  if (rep) r = r.filter(x => x.rep.toLowerCase().includes(rep.toLowerCase()));
  if (channel) r = r.filter(x => x.channel.toLowerCase().includes(channel.toLowerCase()));
  return r;
}

function createServer() {
  const server = new McpServer(
    { name: 'etnia-sales-analytics', version: '1.0.0' },
    { instructions: PERSONA }
  );

  server.registerTool(
    'company_overview',
    {
      title: 'Vision general de la compañia',
      description: 'KPIs globales de ETNIA: ventas YTD 2025 vs 2026 (EB+LO), variacion %, numero de clientes activos, y ranking de los 5 paises y 5 representantes con mayor volumen. Punto de partida para cualquier pregunta general sobre "como va la compañia".',
      inputSchema: {}
    },
    async () => {
      const rows = await getData();
      const total = summarizeGroup('ETNIA (total)', rows);

      const byMarket = groupBy(rows, r => r.market);
      const topMarkets = [...byMarket.entries()]
        .map(([name, g]) => summarizeGroup(name, g))
        .sort((a, b) => b.ytd_2026 - a.ytd_2026)
        .slice(0, 5);

      const byRep = groupBy(rows, r => r.rep);
      const topReps = [...byRep.entries()]
        .map(([name, g]) => summarizeGroup(name, g))
        .sort((a, b) => b.ytd_2026 - a.ytd_2026)
        .slice(0, 5);

      return textResult({
        resumen: total,
        top_5_paises: topMarkets,
        top_5_representantes: topReps,
        num_paises: byMarket.size,
        num_representantes: byRep.size
      });
    }
  );

  server.registerTool(
    'sales_by_country',
    {
      title: 'Ventas por pais / mercado',
      description: 'Desglosa las ventas (YTD 2025 vs 2026, variacion %, numero de clientes) por pais/mercado (columna Market). Usalo para responder "como van las ventas por pais" o para comparar paises entre si.',
      inputSchema: {
        top_n: z.number().int().min(1).max(100).optional().describe('Cuantos paises devolver, ordenados de mayor a menor venta YTD 2026. Por defecto 20.'),
        sort_by: z.enum(['ytd_2026', 'variacion_pct', 'clientes']).optional().describe('Criterio de ordenacion. Por defecto ytd_2026.')
      }
    },
    async ({ top_n = 20, sort_by = 'ytd_2026' }) => {
      const rows = await getData();
      const groups = groupBy(rows, r => r.market);
      const list = [...groups.entries()].map(([name, g]) => summarizeGroup(name, g));
      list.sort((a, b) => (b[sort_by] ?? -Infinity) - (a[sort_by] ?? -Infinity));
      return textResult({ paises: list.slice(0, top_n), total_paises: list.length });
    }
  );

  server.registerTool(
    'sales_by_rep',
    {
      title: 'Ventas por representante comercial',
      description: 'Desglosa las ventas (YTD 2025 vs 2026, variacion %, numero de clientes) por representante (columna SlpName), opcionalmente filtrado por pais. Usalo para responder "como van los comerciales", detectar quien crece/decrece, o comparar reps de un mismo pais.',
      inputSchema: {
        market: z.string().optional().describe('Filtra a un pais/mercado concreto (coincidencia parcial, insensible a mayusculas).'),
        top_n: z.number().int().min(1).max(100).optional().describe('Cuantos representantes devolver. Por defecto 20.'),
        sort_by: z.enum(['ytd_2026', 'variacion_pct', 'clientes']).optional().describe('Criterio de ordenacion. Por defecto ytd_2026.')
      }
    },
    async ({ market, top_n = 20, sort_by = 'ytd_2026' }) => {
      const rows = applyFilters(await getData(), { market });
      const groups = groupBy(rows, r => r.rep);
      const list = [...groups.entries()].map(([name, g]) => summarizeGroup(name, g));
      list.sort((a, b) => (b[sort_by] ?? -Infinity) - (a[sort_by] ?? -Infinity));
      return textResult({ filtro_pais: market || null, representantes: list.slice(0, top_n), total_representantes: list.length });
    }
  );

  server.registerTool(
    'sales_by_channel',
    {
      title: 'Ventas por canal',
      description: 'Desglosa las ventas (YTD 2025 vs 2026, variacion %, numero de clientes) por canal (columna ChannelName), opcionalmente filtrado por pais o representante.',
      inputSchema: {
        market: z.string().optional().describe('Filtra por pais/mercado (coincidencia parcial).'),
        rep: z.string().optional().describe('Filtra por representante (coincidencia parcial).')
      }
    },
    async ({ market, rep }) => {
      const rows = applyFilters(await getData(), { market, rep });
      const groups = groupBy(rows, r => r.channel);
      const list = [...groups.entries()]
        .map(([name, g]) => summarizeGroup(name, g))
        .sort((a, b) => b.ytd_2026 - a.ytd_2026);
      return textResult({ filtros: { market: market || null, rep: rep || null }, canales: list });
    }
  );

  server.registerTool(
    'client_risk_alerts',
    {
      title: 'Clientes en riesgo (caida de ventas)',
      description: 'Lista clientes cuya venta YTD ha caido mas de un % respecto al año anterior, ordenados por importe perdido (mayor a menor). Pensado para generar una lista de visitas prioritarias / accion comercial. Ignora clientes con muy poco volumen para evitar ruido.',
      inputSchema: {
        min_drop_pct: z.number().min(0).max(100).optional().describe('Caida minima en % para considerarse en riesgo. Por defecto 15.'),
        min_ytd_2025: z.number().min(0).optional().describe('Venta minima en YTD 2025 para que el cliente cuente (evita ruido de clientes muy pequeños). Por defecto 500.'),
        market: z.string().optional().describe('Filtra por pais/mercado.'),
        rep: z.string().optional().describe('Filtra por representante.'),
        limit: z.number().int().min(1).max(200).optional().describe('Numero maximo de clientes a devolver. Por defecto 30.')
      }
    },
    async ({ min_drop_pct = 15, min_ytd_2025 = 500, market, rep, limit = 30 }) => {
      const rows = applyFilters(await getData(), { market, rep });
      const risk = rows
        .filter(r => r.ytd25 >= min_ytd_2025 && r.varPct !== null && r.varPct <= -min_drop_pct)
        .map(r => ({
          cliente: r.cardName,
          ciudad: r.city,
          pais: r.market,
          representante: r.rep,
          canal: r.channel,
          ytd_2025: round(r.ytd25),
          ytd_2026: round(r.ytd26),
          variacion_pct: r.varPct,
          importe_perdido: round(r.ytd25 - r.ytd26)
        }))
        .sort((a, b) => b.importe_perdido - a.importe_perdido)
        .slice(0, limit);
      return textResult({
        criterios: { min_drop_pct, min_ytd_2025, market: market || null, rep: rep || null },
        clientes_en_riesgo: risk,
        importe_total_en_riesgo: round(risk.reduce((a, r) => a + r.importe_perdido, 0))
      });
    }
  );

  server.registerTool(
    'growth_opportunities',
    {
      title: 'Clientes con mayor crecimiento',
      description: 'Lista clientes cuya venta YTD ha crecido mas de un % respecto al año anterior, ordenados por importe ganado. Utilo para identificar cuentas en las que redoblar apuesta, o para entender que esta funcionando bien.',
      inputSchema: {
        min_growth_pct: z.number().min(0).optional().describe('Crecimiento minimo en % para incluir al cliente. Por defecto 15.'),
        market: z.string().optional().describe('Filtra por pais/mercado.'),
        rep: z.string().optional().describe('Filtra por representante.'),
        limit: z.number().int().min(1).max(200).optional().describe('Numero maximo de clientes a devolver. Por defecto 30.')
      }
    },
    async ({ min_growth_pct = 15, market, rep, limit = 30 }) => {
      const rows = applyFilters(await getData(), { market, rep });
      const growth = rows
        .filter(r => r.varPct !== null && r.varPct >= min_growth_pct)
        .map(r => ({
          cliente: r.cardName,
          ciudad: r.city,
          pais: r.market,
          representante: r.rep,
          canal: r.channel,
          ytd_2025: round(r.ytd25),
          ytd_2026: round(r.ytd26),
          variacion_pct: r.varPct,
          importe_ganado: round(r.ytd26 - r.ytd25)
        }))
        .sort((a, b) => b.importe_ganado - a.importe_ganado)
        .slice(0, limit);
      return textResult({
        criterios: { min_growth_pct, market: market || null, rep: rep || null },
        clientes_en_crecimiento: growth,
        importe_total_ganado: round(growth.reduce((a, r) => a + r.importe_ganado, 0))
      });
    }
  );

  server.registerTool(
    'search_clients',
    {
      title: 'Buscar clientes concretos',
      description: 'Busca clientes por nombre/ciudad y devuelve su detalle de ventas (YTD 2025 vs 2026, variacion, representante, pais, canal). Usalo cuando el usuario pregunte por una optica o cliente concreto por nombre.',
      inputSchema: {
        query: z.string().describe('Texto a buscar en el nombre del cliente o la ciudad (coincidencia parcial, insensible a mayusculas).'),
        market: z.string().optional().describe('Filtra por pais/mercado.'),
        rep: z.string().optional().describe('Filtra por representante.'),
        limit: z.number().int().min(1).max(100).optional().describe('Numero maximo de resultados. Por defecto 20.')
      }
    },
    async ({ query, market, rep, limit = 20 }) => {
      const q = query.toLowerCase();
      const rows = applyFilters(await getData(), { market, rep })
        .filter(r => r.cardName.toLowerCase().includes(q) || r.city.toLowerCase().includes(q));
      const list = rows.slice(0, limit).map(r => ({
        cliente: r.cardName,
        ciudad: r.city,
        pais: r.market,
        representante: r.rep,
        canal: r.channel,
        ytd_2025: round(r.ytd25),
        ytd_2026: round(r.ytd26),
        variacion_pct: r.varPct,
        fy_2025: round(r.fy25)
      }));
      return textResult({ query, total_encontrados: rows.length, resultados: list });
    }
  );

  return server;
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', async (req, res) => {
  try {
    const rows = await getData();
    res.json({ status: 'ok', clientes_en_cache: rows.length, timestamp: new Date() });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

function checkAuth(req, res) {
  if (!AUTH_TOKEN) return true; // sin token configurado = sin auth (solo para pruebas locales)
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token !== AUTH_TOKEN) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// Modo stateless: cada peticion crea su propio server+transport, tal y como
// recomienda el SDK para despliegues sin sesion persistente entre requests.
app.post('/mcp', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get('/mcp', (req, res) => {
  res.status(405).json({ error: 'Method not allowed. Este servidor MCP es stateless (solo POST).' });
});

const PORT = process.env.PORT || 3100;
app.listen(PORT, () => console.log(`🚀 Etnia Sales MCP escuchando en http://localhost:${PORT}/mcp`));
