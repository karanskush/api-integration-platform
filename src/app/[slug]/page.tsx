import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import ActionCard from '@/components/ActionCard';
import AuthGuide from '@/components/AuthGuide';
import McpBlock from '@/components/McpBlock';
import Playground from '@/components/Playground';
import ScorePreviewPanel from '@/components/ScorePreviewPanel';
import { loadPersistentRecord } from '@/lib/persistentApi';

// Time-based ISR for now — Phase 1 has no "re-import into an existing
// persistent api" path yet, so there's nothing to on-demand revalidateTag()
// against. Add tag-based revalidation once that write path exists (Phase 2+).
export const revalidate = 3600;

const SOURCE_LABEL: Record<string, string> = {
  openapi: 'OpenAPI 3.x',
  swagger: 'Swagger 2.0',
  postman: 'Postman collection',
  curl: 'cURL import',
};

function appOrigin(): string {
  return process.env.PUBLIC_APP_ORIGIN?.replace(/\/$/, '') || 'http://localhost:3000';
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const record = await loadPersistentRecord(slug);
  return { title: record ? `${record.name} — Spotcheck` : 'Not found — Spotcheck' };
}

export default async function PersistentApiPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const record = await loadPersistentRecord(slug);
  if (!record) notFound();

  const mcpUrl = `${appOrigin()}/mcp/${record.id}`;

  return (
    <div className="product-page wrap" style={{ display: 'grid', gap: 20 }}>
      <header>
        <h1 className="display" style={{ fontSize: 26 }}>{record.name}</h1>
        <p className="mono" style={{ color: 'var(--fg-mute)', fontSize: 12.5, marginTop: 6 }}>
          {SOURCE_LABEL[record.source] ?? record.source} · {record.counts.total} endpoint
          {record.counts.total === 1 ? '' : 's'} · {record.counts.read} read / {record.counts.write}{' '}
          write / {record.counts.destructive} destructive
        </p>
        {record.baseUrls.length > 0 ? (
          <p className="mono" style={{ color: 'var(--fg-dim)', fontSize: 12.5, marginTop: 4 }}>
            base URL: {record.baseUrls.join(' · ')}
          </p>
        ) : (
          <p style={{ color: 'var(--accent-red)', fontSize: 12.5, marginTop: 4 }}>
            No public base URL detected in the spec — playground and MCP calls are disabled.
          </p>
        )}
      </header>

      <AuthGuide record={record} />
      <ScorePreviewPanel record={record} />
      <McpBlock record={record} mcpUrl={mcpUrl} />

      {record.baseUrls.length > 0 && (
        <section className="panel" style={{ padding: 20 }}>
          <h2 style={{ fontSize: 15, marginBottom: 12 }}>Playground</h2>
          <Playground
            id={record.id}
            actions={record.actions}
            baseUrls={record.baseUrls}
            auth={record.auth}
            authIn={record.authIn}
          />
        </section>
      )}

      <section style={{ display: 'grid', gap: 14 }}>
        <h2 style={{ fontSize: 15 }}>Actions</h2>
        {record.actions.map((a) => (
          <ActionCard key={a.id} action={a} record={record} />
        ))}
      </section>
    </div>
  );
}
