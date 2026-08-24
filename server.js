import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { aggregateBy, getCompanyTotal, aggregateClients, round2 } from './data.js';

const PERSONA = `Eres el analista de ventas senior de ETNIA (marca de moda de gafas). Cuando uses estas
herramientas para responder, actua como un experto en analitica comercial retail/eyewear:
- Hay dos fuentes de datos distintas, elegibles con el parametro "source":
  - "sales": lo que se ha VENDIDO/pedido (vista vBI_SALES_DATA), en EUR a tipo de cambio fijo de reporting.
  - "invoicing": lo que se ha FACTURADO realmente (vista vBI_INVOICING_DATA), en EUR.
  Si el usuario no especifica cual quiere, usa "sales" por defecto pero acláralo, y ofrece comparar
  ambas si la pregunta es ambigua (p.ej. "vendido" vs "facturado" pueden diferir por plazos de envio/cobro).
- Da siempre el numero Y la lectura de negocio (que significa, si es bueno o malo, por que podria estar pasando).
- Prioriza palancas de mejora concretas y accionables: concentracion de cartera en pocos clientes,
  representantes o zonas por debajo de la media, clientes con caida de YTD que conviene visitar,
  diferencias de mix por marca, estacionalidad.
- Compara siempre contra el año anterior (mismo rango de dias YTD) y contra la media del grupo (pais, rep, canal).
- Si detectas un dato con muy pocos clientes o volumen bajo, adviertelo (baja significatividad).
- Se directo y conciso, con listas y numeros, no rodeos.`;

const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

const sourceSchema = {
  source: z.enum(['sales', 'invoicing']).optional().describe('"sales" = lo vendido/pedido (vBI_SALES_DATA). "invoicing" = lo facturado (vBI_INVOICING_DATA). Por defecto "sales".')
};

const filterSchema = {
  ...sourceSchema,
  market: z.string().optional().describe('Filtra por pais/mercado (coincidencia parcial, insensible a mayusculas).'),
  rep: z.string().optional().describe('Filtra por representante comercial (coincidencia parcial).'),
  channel: z.string().optional().describe('Filtra por canal/tipo de pedido (OrderType: p.ej. IPAD, POS, EDI...).'),
  brand: z.string().optional().describe('Filtra por codigo de marca exacto (p.ej. EB, LO, PE, CH, TR, AP).')
};

function createServer() {
  const server = new McpServer(
    { name: 'etnia-sales-analytics', version: '1.0.0' },
    { instructions: PERSONA }
  );

  server.registerTool(
    'company_overview',
    {
      title: 'Vision general de la compañia',
      description: 'KPIs globales de ETNIA: YTD del año en curso vs mismo periodo del año anterior, variacion %, clientes activos, y ranking de paises/representantes/marcas. Usa "source" para elegir entre "sales" (vendido) e "invoicing" (facturado). Punto de partida para cualquier pregunta general sobre "como va la compañia".',
      inputSchema: { ...sourceSchema }
    },
    async ({ source = 'sales' }) => {
      const [total, byMarket, byRep, byBrand] = await Promise.all([
        getCompanyTotal(source),
        aggregateBy(source, 'market'),
        aggregateBy(source, 'rep'),
        aggregateBy(source, 'brand')
      ]);
      const top = (list, n = 5) => [...list].sort((a, b) => b.ytd_actual - a.ytd_actual).slice(0, n);
      return textResult({
        fuente: source,
        periodo: { desde: total.curStart, hasta: total.curEnd, comparado_con: `${total.prevStart} a ${total.prevEnd}` },
        resumen_total: {
          ytd_actual: total.ytd_actual, ytd_anterior: total.ytd_anterior,
          variacion_pct: total.variacion_pct, variacion_abs: total.variacion_abs,
          clientes_activos: total.clientes_activos
        },
        top_5_paises: top(byMarket),
        top_5_representantes: top(byRep),
        ventas_por_marca: byBrand.sort((a, b) => b.ytd_actual - a.ytd_actual),
        num_paises: byMarket.length,
        num_representantes: byRep.length
      });
    }
  );

  function registerDimensionTool(name, dimension, title, description) {
    server.registerTool(name, {
      title,
      description,
      inputSchema: {
        ...filterSchema,
        top_n: z.number().int().min(1).max(100).optional().describe('Cuantos resultados devolver, ordenados de mayor a menor YTD actual. Por defecto 20.'),
        sort_by: z.enum(['ytd_actual', 'variacion_pct', 'clientes_activos']).optional().describe('Criterio de ordenacion. Por defecto ytd_actual.')
      }
    }, async ({ source = 'sales', market, rep, channel, brand, top_n = 20, sort_by = 'ytd_actual' }) => {
      const list = await aggregateBy(source, dimension, { market, rep, channel, brand });
      list.sort((a, b) => (b[sort_by] ?? -Infinity) - (a[sort_by] ?? -Infinity));
      return textResult({
        fuente: source,
        filtros: { market: market || null, rep: rep || null, channel: channel || null, brand: brand || null },
        resultados: list.slice(0, top_n),
        total_grupos: list.length
      });
    });
  }

  registerDimensionTool(
    'sales_by_country', 'market',
    'Ventas o facturación por pais / mercado',
    'Desglosa por pais/mercado (actual vs año anterior, variacion %, clientes activos). Usa "source": "sales" para lo vendido/pedido, "invoicing" para lo facturado. Usalo para "como van las ventas por pais" o comparar paises.'
  );
  registerDimensionTool(
    'sales_by_rep', 'rep',
    'Ventas o facturación por representante comercial',
    'Desglosa por representante comercial (cartera asignada). Usa "source" para elegir vendido/facturado. Usalo para ver quien crece/decrece o comparar reps de un mismo pais (filtro market).'
  );
  registerDimensionTool(
    'sales_by_channel', 'channel',
    'Ventas o facturación por canal',
    'Desglosa por canal/tipo de pedido (OrderType). Usa "source" para elegir vendido/facturado.'
  );
  registerDimensionTool(
    'sales_by_brand', 'brand',
    'Ventas o facturación por marca',
    'Desglosa por marca (codigo interno: EB, LO, PE, CH, TR, AP). Usa "source" para elegir vendido/facturado.'
  );

  server.registerTool(
    'client_risk_alerts',
    {
      title: 'Clientes en riesgo (caida de ventas)',
      description: 'Lista clientes cuyo YTD ha caido mas de un % respecto al año anterior, ordenados por importe perdido. Pensado para generar una lista de visitas prioritarias. Ignora clientes con poco volumen para evitar ruido. Usa "source" para elegir vendido/facturado.',
      inputSchema: {
        ...filterSchema,
        min_drop_pct: z.number().min(0).max(100).optional().describe('Caida minima en % para considerarse en riesgo. Por defecto 15.'),
        min_ytd_anterior: z.number().min(0).optional().describe('Venta minima el año anterior para que el cliente cuente (evita ruido de clientes muy pequeños). Por defecto 500.'),
        limit: z.number().int().min(1).max(200).optional().describe('Numero maximo de clientes a devolver. Por defecto 30.')
      }
    },
    async ({ source = 'sales', market, rep, channel, brand, min_drop_pct = 15, min_ytd_anterior = 500, limit = 30 }) => {
      const clients = await aggregateClients(source, { market, rep, channel, brand });
      const risk = clients
        .filter(c => c.ytd_anterior >= min_ytd_anterior && c.variacion_pct !== null && c.variacion_pct <= -min_drop_pct)
        .map(c => ({ ...c, importe_perdido: round2(c.ytd_anterior - c.ytd_actual) }))
        .sort((a, b) => b.importe_perdido - a.importe_perdido)
        .slice(0, limit);
      return textResult({
        fuente: source,
        criterios: { min_drop_pct, min_ytd_anterior, market: market || null, rep: rep || null },
        clientes_en_riesgo: risk,
        importe_total_en_riesgo: round2(risk.reduce((a, c) => a + c.importe_perdido, 0))
      });
    }
  );

  server.registerTool(
    'growth_opportunities',
    {
      title: 'Clientes con mayor crecimiento',
      description: 'Lista clientes cuyo YTD ha crecido mas de un % respecto al año anterior, ordenados por importe ganado. Util para identificar cuentas en las que redoblar apuesta. Usa "source" para elegir vendido/facturado.',
      inputSchema: {
        ...filterSchema,
        min_growth_pct: z.number().min(0).optional().describe('Crecimiento minimo en % para incluir al cliente. Por defecto 15.'),
        limit: z.number().int().min(1).max(200).optional().describe('Numero maximo de clientes a devolver. Por defecto 30.')
      }
    },
    async ({ source = 'sales', market, rep, channel, brand, min_growth_pct = 15, limit = 30 }) => {
      const clients = await aggregateClients(source, { market, rep, channel, brand });
      const growth = clients
        .filter(c => c.variacion_pct !== null && c.variacion_pct >= min_growth_pct)
        .map(c => ({ ...c, importe_ganado: round2(c.ytd_actual - c.ytd_anterior) }))
        .sort((a, b) => b.importe_ganado - a.importe_ganado)
        .slice(0, limit);
      return textResult({
        fuente: source,
        criterios: { min_growth_pct, market: market || null, rep: rep || null },
        clientes_en_crecimiento: growth,
        importe_total_ganado: round2(growth.reduce((a, c) => a + c.importe_ganado, 0))
      });
    }
  );

  server.registerTool(
    'search_clients',
    {
      title: 'Buscar clientes concretos',
      description: 'Busca clientes por nombre y devuelve su detalle YTD (actual vs año anterior, variacion, representante, pais, canal). Usa "source" para elegir vendido/facturado.',
      inputSchema: {
        query: z.string().describe('Texto a buscar en el nombre del cliente (coincidencia parcial, insensible a mayusculas).'),
        ...filterSchema,
        limit: z.number().int().min(1).max(100).optional().describe('Numero maximo de resultados. Por defecto 20.')
      }
    },
    async ({ query, source = 'sales', market, rep, channel, brand, limit = 20 }) => {
      const clients = await aggregateClients(source, { market, rep, channel, brand, nameQuery: query });
      return textResult({ fuente: source, query, total_encontrados: clients.length, resultados: clients.slice(0, limit) });
    }
  );

  return server;
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', async (req, res) => {
  try {
    const total = await getCompanyTotal('sales');
    res.json({ status: 'ok', total, timestamp: new Date() });
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
