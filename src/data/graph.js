// The Entity Dependency DAG that powers the hero + layers scenes.
// Nodes are API endpoints; edges are "produces the ID the next one needs".
// `kind: 'agent'` nodes belong to the blue MCP/agent path.

export const NODES = [
  { id: 'users',    label: 'POST /users',          pos: [-5.6,  1.9, -0.6], kind: 'api',   show: true },
  { id: 'customers',label: 'POST /customers',      pos: [-5.2, -1.7,  0.8], kind: 'api',   show: true },
  { id: 'accounts', label: 'POST /accounts',       pos: [-2.4,  1.1, -1.4], kind: 'api',   show: true },
  { id: 'kyc',      label: 'POST /kyc',            pos: [-2.8, -2.2,  1.2], kind: 'api',   show: false },
  { id: 'pi',       label: 'POST /payment_intents',pos: [-0.2, -0.7, -0.3], kind: 'api',   show: true },
  { id: 'balance',  label: 'GET /balance',         pos: [-0.6,  2.6,  0.6], kind: 'api',   show: false },
  { id: 'transfer', label: 'POST /transfer',       pos: [ 2.6,  1.4, -1.0], kind: 'api',   show: true },
  { id: 'confirm',  label: 'POST /confirm',        pos: [ 2.2, -1.2,  0.9], kind: 'api',   show: false },
  { id: 'webhook',  label: 'webhook: payment.*',   pos: [ 4.9, -0.2, -0.4], kind: 'api',   show: true },
  { id: 'refund',   label: 'POST /refunds',        pos: [ 4.4,  2.3,  0.7], kind: 'api',   show: false },
  // blue agent / MCP path
  { id: 'mcp',      label: 'MCP server',           pos: [ 0.4,  3.0, -1.8], kind: 'agent', show: true },
  { id: 'agent',    label: 'agent',                pos: [-3.4,  3.0, -2.0], kind: 'agent', show: false },
  { id: 'idmap',    label: 'cross-provider id',    pos: [ 5.6,  1.4, -1.6], kind: 'agent', show: false },
];

const idx = Object.fromEntries(NODES.map((n, i) => [n.id, i]));

export const EDGES = [
  ['users', 'accounts'],
  ['accounts', 'transfer'],
  ['accounts', 'balance'],
  ['transfer', 'webhook'],
  ['customers', 'kyc'],
  ['customers', 'pi'],
  ['kyc', 'pi'],
  ['pi', 'confirm'],
  ['confirm', 'webhook'],
  ['webhook', 'refund'],
  ['agent', 'mcp'],
  ['mcp', 'transfer'],
  ['mcp', 'pi'],
  ['webhook', 'idmap'],
].map(([a, b]) => [idx[a], idx[b]]);

// Call sequences the pulse traces, by node id.
export const CHAINS = [
  ['users', 'accounts', 'transfer', 'webhook'],
  ['customers', 'pi', 'confirm', 'webhook', 'refund'],
  ['agent', 'mcp', 'pi', 'confirm'], // blue agent path
].map((chain) => chain.map((id) => idx[id]));

export const NODE_INDEX = idx;
