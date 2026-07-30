import type { ImportRecord } from '@/lib/ir';
import { mcpExposedActions } from '@/lib/ir';
import CopyButton from './CopyButton';

export default function McpBlock({ record, mcpUrl }: { record: ImportRecord; mcpUrl: string }) {
  const exposed = mcpExposedActions(record).length;
  const needsKey = record.auth !== 'none';

  const clientConfig = JSON.stringify(
    {
      mcpServers: {
        [record.id]: {
          url: mcpUrl,
          ...(needsKey ? { headers: { 'x-docentapi-upstream-key': '<your API key>' } } : {}),
        },
      },
    },
    null,
    2,
  );

  return (
    <section className="panel" style={{ padding: 20 }}>
      <h2 style={{ fontSize: 15, marginBottom: 10 }}>
        Hosted MCP server{' '}
        <span className="chip" style={{ marginLeft: 8 }}>
          {exposed} tools
        </span>
      </h2>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <code
          style={{
            background: 'var(--bg-soft)',
            border: '1px solid var(--hair-soft)',
            borderRadius: 6,
            padding: '8px 12px',
            color: 'var(--accent-blue)',
            fontSize: 13,
            flex: 1,
            overflowX: 'auto',
            whiteSpace: 'nowrap',
          }}
        >
          {mcpUrl}
        </code>
        <CopyButton text={mcpUrl} label="Copy URL" />
      </div>
      <p style={{ color: 'var(--fg-dim)', fontSize: 13, marginBottom: 8 }}>
        Add to Claude Code / Cursor / any Streamable-HTTP MCP client:
      </p>
      <div style={{ position: 'relative' }}>
        <pre className="codeblock">{clientConfig}</pre>
        <div style={{ position: 'absolute', top: 8, right: 8 }}>
          <CopyButton text={clientConfig} />
        </div>
      </div>
      {needsKey && (
        <p style={{ color: 'var(--fg-mute)', fontSize: 12.5, marginTop: 10 }}>
          BYOK: put your upstream API key in the <code>x-docentapi-upstream-key</code> header — it is
          passed through to the API and never stored. Clients that can’t set headers can append{' '}
          <code>?key=&lt;value&gt;</code> to the URL (careful: URLs can end up in logs).
        </p>
      )}
      {record.counts.destructive > 0 && (
        <p style={{ color: 'var(--fg-mute)', fontSize: 12.5, marginTop: 6 }}>
          {record.counts.destructive} destructive action{record.counts.destructive > 1 ? 's are' : ' is'}{' '}
          excluded from the MCP tool list by default.
        </p>
      )}
    </section>
  );
}
