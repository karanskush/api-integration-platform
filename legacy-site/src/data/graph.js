// The tool graph that powers the hero scene.
// Cyan nodes are the API's normalized tools; steel nodes are the agent path
// (`kind: 'agent'`) — clients calling the hosted MCP server. Green packets
// are verification probes tracing valid call chains.

export const NODES = [
  { id: 'users',    label: 'create_user',         pos: [-5.6,  1.9, -0.6], kind: 'api',   show: true },
  { id: 'customers',label: 'create_customer',     pos: [-5.2, -1.7,  0.8], kind: 'api',   show: true },
  { id: 'accounts', label: 'create_account',      pos: [-2.4,  1.1, -1.4], kind: 'api',   show: true },
  { id: 'kyc',      label: 'verify_identity',     pos: [-2.8, -2.2,  1.2], kind: 'api',   show: false },
  { id: 'pi',       label: 'create_payment',      pos: [-0.2, -0.7, -0.3], kind: 'api',   show: true },
  { id: 'balance',  label: 'get_balance',         pos: [-0.6,  2.6,  0.6], kind: 'api',   show: false },
  { id: 'transfer', label: 'create_transfer',     pos: [ 2.6,  1.4, -1.0], kind: 'api',   show: true },
  { id: 'confirm',  label: 'confirm_payment',     pos: [ 2.2, -1.2,  0.9], kind: 'api',   show: false },
  { id: 'webhook',  label: 'webhook: payment.*',  pos: [ 4.9, -0.2, -0.4], kind: 'api',   show: true },
  { id: 'refund',   label: 'create_refund',       pos: [ 4.4,  2.3,  0.7], kind: 'api',   show: false },
  // blue agent / MCP path
  { id: 'mcp',      label: 'mcp.spotcheck.dev/you', pos: [ 0.4,  3.0, -1.8], kind: 'agent', show: true },
  { id: 'agent',    label: 'Claude',              pos: [-3.4,  3.0, -2.0], kind: 'agent', show: true },
  { id: 'idmap',    label: 'Cursor',              pos: [ 5.6,  1.4, -1.6], kind: 'agent', show: true },
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
  ['idmap', 'mcp'],
].map(([a, b]) => [idx[a], idx[b]]);

// Call sequences the pulse traces, by node id. Blue agent paths lead.
export const CHAINS = [
  ['agent', 'mcp', 'pi', 'confirm'],
  ['idmap', 'mcp', 'transfer', 'webhook'],
  ['users', 'accounts', 'transfer', 'webhook'],
  ['customers', 'pi', 'confirm', 'webhook', 'refund'],
].map((chain) => chain.map((id) => idx[id]));

export const NODE_INDEX = idx;
