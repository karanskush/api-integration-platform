import type { Action, ImportRecord } from '@/lib/ir';
import { fieldMapFor, type FieldNode } from '@/lib/fieldMap';
import { curlSnippet, pythonSnippet, tsSnippet } from '@/lib/snippets';
import SnippetTabs from './SnippetTabs';

// The parameter table used to walk one level of paramsSchema.properties, so
// every body-bearing operation rendered a single row reading `body | object`
// and nothing else. The data was never the problem — add_pet's stored schema
// carries required [name, photoUrls], a status enum, and a nested category and
// tags[] — the renderer simply never descended into it.
//
// fieldMapFor already flattens exactly this, with addressable dotted paths,
// requiredness resolved through allOf, nullability, and enums. Reusing it also
// means the table and the advisor tools answer "what can I send?" from one
// implementation rather than two that can disagree.
function rowsFor(action: Action): FieldNode[] {
  const map = fieldMapFor(action);
  return map.request;
}

// 'body.category.name' renders as 'category.name': the `body.` prefix is on
// every row of a body-bearing operation and carries no information, while the
// location column already says where the value goes.
function displayPath(node: FieldNode): string {
  return node.path.startsWith('body.') ? node.path.slice('body.'.length) : node.path;
}

function typeLabel(node: FieldNode): string {
  const base = node.nullable ? `${node.type} | null` : node.type;
  return node.format ? `${base} · ${node.format}` : base;
}

// An enum IS the description when there is no prose one — it is the most
// actionable thing the schema knows about that field.
function describe(node: FieldNode): string {
  if (node.description) return node.description;
  if (node.enum?.length) return node.enum.map((v) => String(v)).join(' · ');
  return '';
}

export default function ActionCard({ action, record }: { action: Action; record: ImportRecord }) {
  const rows = rowsFor(action);
  const snippets = {
    curl: curlSnippet(action, record),
    typescript: tsSnippet(action, record),
    python: pythonSnippet(action, record),
  };

  return (
    <article className="panel" style={{ padding: 20 }} id={`action-${action.name}`}>
      <header style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className={`chip ${action.method.toLowerCase()}`}>{action.method}</span>
        <code style={{ color: 'var(--fg)', fontSize: 13.5 }}>{action.path}</code>
        <span className={`chip ${action.safety}`}>{action.safety}</span>
        {action.safety === 'destructive' && (
          <span style={{ fontSize: 11.5, color: 'var(--fg-mute)' }}>not exposed to agents</span>
        )}
        <code style={{ marginLeft: 'auto', color: 'var(--fg-mute)', fontSize: 12 }}>{action.name}</code>
      </header>
      <p style={{ color: 'var(--fg-dim)', fontSize: 13.5, margin: '8px 0 14px' }}>{action.description}</p>

      {rows.length > 0 && (
        <div style={{ marginBottom: 14, overflowX: 'auto' }}>
          <table className="params">
            <thead>
              <tr>
                <th>Param</th>
                <th>In</th>
                <th>Type</th>
                <th>Req</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.path}>
                  <td className="name">{displayPath(r)}</td>
                  <td>{r.location}</td>
                  <td className="type">{typeLabel(r)}</td>
                  <td>{r.required ? '✓' : ''}</td>
                  <td className="desc">{describe(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SnippetTabs snippets={snippets} />
    </article>
  );
}
