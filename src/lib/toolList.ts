// The MCP tool descriptor shape and the endpoint→tool projection.
//
// Split out of mcpTools.ts so it is a LEAF: mcpTools.ts imports the advisor
// package (for name-collision resolution) and the advisor package needs
// buildToolList (to fingerprint exactly what tools/list serves). Keeping both
// in mcpTools.ts would make that a runtime import cycle; this module depends
// on nothing but the IR.

import type { Action } from './ir';

export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [k: string]: unknown };
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
};

export function buildToolList(actions: Action[]): ToolDescriptor[] {
  return actions.map((a) => ({
    name: a.name,
    description: a.description,
    inputSchema: a.paramsSchema as { type: 'object'; [k: string]: unknown },
    annotations: {
      title: `${a.method} ${a.path}`,
      readOnlyHint: a.safety === 'read',
      destructiveHint: false,
      openWorldHint: true,
    },
  }));
}
