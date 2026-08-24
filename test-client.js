import 'dotenv/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL('http://localhost:3100/mcp');
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } }
});
const client = new Client({ name: 'test-client', version: '1.0.0' });

await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map(t => t.name).join(', '));

const toCall = [
  { name: 'company_overview', args: {} },
  { name: 'sales_by_country', args: { top_n: 5 } },
  { name: 'sales_by_rep', args: { market: 'USA', top_n: 5 } },
  { name: 'sales_by_channel', args: {} },
  { name: 'sales_by_brand', args: {} },
  { name: 'client_risk_alerts', args: { limit: 5 } },
  { name: 'growth_opportunities', args: { limit: 5 } },
  { name: 'search_clients', args: { query: 'Vision', limit: 3 } }
];

for (const { name, args } of toCall) {
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.[0]?.text || '(sin contenido)';
    console.log(`\n=== ${name} ===`);
    console.log(text.slice(0, 500));
  } catch (err) {
    console.log(`\n=== ${name} === ERROR: ${err.message}`);
  }
}

process.exit(0);
