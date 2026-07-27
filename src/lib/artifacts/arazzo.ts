// Emits an Arazzo 1.0.1 workflow document (spec.openapis.org/arazzo) from the
// lineage graph — a portable, standards-based artifact any Arazzo-aware tool
// can consume, not just Spotcheck's own MCP server.
//
// Scope, deliberately: Arazzo's native `parameters[].value` runtime-expression
// binding (`$steps.<id>.outputs.<name>`) is only a clean fit for a
// deterministic, single-valued producer — a POST/PUT whose response yields
// exactly the value needed next. A GET-list producer ("pick one id from
// many") has no single value to bind statically; that dependency is still
// recorded, but via the `x-spotcheck-requires` extension rather than a native
// binding that would misrepresent a real choice as an automatic one. Same
// reasoning for body-field dependencies: Arazzo's Parameter Object only
// covers path/query/header/cookie, not request bodies, so those are always
// extension-only.
//
// `operationId` here is Spotcheck's own derived tool name, not necessarily
// the source spec's literal operationId (not tracked separately today) —
// sourceDescriptions still points at the original spec, so a consumer can
// cross-reference by method+path if it needs the literal one.

import type { Action, ImportRecord } from '../ir';
import { fieldMapFor } from '../fieldMap';
import { type LineageEdge, lineageFor, producersFor } from '../lineage';

const MAX_WORKFLOWS = 50;
const MAX_STEPS_PER_WORKFLOW = 6;

type Dependency = { field: string; edge: LineageEdge };

type ArazzoParameter = { name: string; in: 'path' | 'query'; value: string };
type RequiresNote = { field: string; from: string; confidence: string };
type ArazzoStep = {
  stepId: string;
  operationId: string;
  description: string;
  parameters?: ArazzoParameter[];
  outputs?: Record<string, string>;
  'x-spotcheck-requires'?: RequiresNote[];
};
type ArazzoWorkflow = { workflowId: string; summary: string; steps: ArazzoStep[] };

export type ArazzoDocument = {
  arazzo: '1.0.1';
  info: { title: string; version: string; description: string };
  sourceDescriptions: Array<{ name: string; url: string; type: 'openapi' }>;
  workflows: ArazzoWorkflow[];
};

function slugId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

function pathParamsOf(action: Action): string[] {
  const matches = action.path.match(/\{([^}]+)\}/g) ?? [];
  return matches.map((m) => m.slice(1, -1));
}

function dependenciesFor(record: ImportRecord, action: Action): Dependency[] {
  const graph = lineageFor(record);
  const deps: Dependency[] = [];

  for (const param of pathParamsOf(action)) {
    const edges = producersFor(graph, action.name, `path.${param}`);
    if (edges.length) deps.push({ field: `path.${param}`, edge: edges[0] });
  }

  const map = fieldMapFor(action);
  for (const field of map.request) {
    if (field.location !== 'body' || field.readOnly || field.container || !field.required) continue;
    const edges = producersFor(graph, action.name, field.path);
    if (edges.length) deps.push({ field: field.path, edge: edges[0] });
  }

  return deps;
}

// A producer whose response yields ONE definite value the next call can bind
// to statically — a create/update, not a list a caller must choose from.
function isDeterministicProducer(edge: LineageEdge, actionsByName: Map<string, Action>): boolean {
  const producer = actionsByName.get(edge.from.tool);
  return edge.confidence === 'high' && Boolean(producer) && (producer!.method === 'POST' || producer!.method === 'PUT');
}

// Best-effort JSON-pointer guess for a producer's own output field —
// deliberately only attempted for a shallow, non-array field path, since a
// deeper/array path needs an index Arazzo has no static way to express.
function outputPointer(fieldPath: string): string | null {
  const withoutLocation = fieldPath.replace(/^(response|body)\./, '');
  if (withoutLocation.includes('[]') || withoutLocation.includes('.')) return null;
  return `$response.body#/${withoutLocation}`;
}

export function buildArazzoDocument(record: ImportRecord, sourceUrl: string): ArazzoDocument {
  const actionsByName = new Map(record.actions.map((a) => [a.name, a]));
  const workflows: ArazzoWorkflow[] = [];

  for (const target of record.actions) {
    if (target.safety === 'destructive') continue; // never script a destructive call automatically
    if (workflows.length >= MAX_WORKFLOWS) break;

    const deps = dependenciesFor(record, target);
    if (!deps.length) continue;

    const steps: ArazzoStep[] = [];
    const seenProducers = new Set<string>();
    for (const dep of deps.slice(0, MAX_STEPS_PER_WORKFLOW - 1)) {
      const producerTool = dep.edge.from.tool;
      if (seenProducers.has(producerTool)) continue;
      seenProducers.add(producerTool);
      const producerAction = actionsByName.get(producerTool);
      const deterministic = isDeterministicProducer(dep.edge, actionsByName);
      const pointer = deterministic ? outputPointer(dep.edge.from.field) : null;
      steps.push({
        stepId: slugId(producerTool),
        operationId: producerTool,
        description: producerAction ? `${producerAction.method} ${producerAction.path}` : producerTool,
        ...(pointer ? { outputs: { value: pointer } } : {}),
      });
    }

    const targetParameters: ArazzoParameter[] = [];
    const targetRequires: RequiresNote[] = [];
    for (const dep of deps) {
      const isPathParam = dep.field.startsWith('path.');
      const deterministic = isDeterministicProducer(dep.edge, actionsByName);
      const pointer = deterministic ? outputPointer(dep.edge.from.field) : null;
      if (isPathParam && pointer && seenProducers.has(dep.edge.from.tool)) {
        targetParameters.push({
          name: dep.field.slice('path.'.length),
          in: 'path',
          value: `$steps.${slugId(dep.edge.from.tool)}.outputs.value`,
        });
      } else {
        targetRequires.push({ field: dep.field, from: `${dep.edge.from.tool}.${dep.edge.from.field}`, confidence: dep.edge.confidence });
      }
    }

    steps.push({
      stepId: slugId(target.name),
      operationId: target.name,
      description: `${target.method} ${target.path}`,
      ...(targetParameters.length ? { parameters: targetParameters } : {}),
      ...(targetRequires.length ? { 'x-spotcheck-requires': targetRequires } : {}),
    });

    workflows.push({
      workflowId: slugId(`${target.name}_flow`),
      summary: `Call ${target.name} (needs: ${deps.map((d) => d.field).join(', ')})`,
      steps,
    });
  }

  return {
    arazzo: '1.0.1',
    info: {
      title: `${record.name} — Spotcheck-derived workflows`,
      version: '1.0.0',
      description:
        "Machine-derived from the field-level data-lineage graph Spotcheck computed for this API. operationId values are Spotcheck's own derived tool names — cross-reference sourceDescriptions for the literal spec.",
    },
    sourceDescriptions: [{ name: record.name, url: sourceUrl, type: 'openapi' }],
    workflows,
  };
}
