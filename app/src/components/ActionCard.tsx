import type { Action, ImportRecord, JSONSchema } from '@/lib/ir';
import { curlSnippet, pythonSnippet, tsSnippet } from '@/lib/snippets';
import SnippetTabs from './SnippetTabs';

type Row = { name: string; where: string; type: string; required: boolean; description: string };

function schemaRows(schema: JSONSchema): Row[] {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(props).map(([name, p]) => ({
    name,
    where: String(p['x-spotcheck-in'] ?? 'query'),
    type: Array.isArray(p.type) ? p.type.join(' | ') : String(p.type ?? 'any'),
    required: required.has(name),
    description: String(p.description ?? ''),
  }));
}

export default function ActionCard({ action, record }: { action: Action; record: ImportRecord }) {
  const rows = schemaRows(action.paramsSchema);
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
                <tr key={r.name}>
                  <td className="name">{r.name}</td>
                  <td>{r.where}</td>
                  <td className="type">{r.type}</td>
                  <td>{r.required ? '✓' : ''}</td>
                  <td className="desc">{r.description}</td>
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
