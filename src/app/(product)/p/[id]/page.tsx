import { auth } from '@clerk/nextjs/server';
import type { Metadata } from 'next';
import ActionCard from '@/components/product/ActionCard';
import AskAssistant from '@/components/product/AskAssistant';
import AuthGuide from '@/components/product/AuthGuide';
import ClaimBanner from '@/components/product/ClaimBanner';
import McpBlock from '@/components/product/McpBlock';
import Playground from '@/components/product/Playground';
import ScorePreviewPanel from '@/components/product/ScorePreviewPanel';
import TtlNotice from '@/components/product/TtlNotice';
import { aiReady } from '@/lib/ask';
import { dbReady } from '@/lib/db';
import { isValidId } from '@/lib/ids';
import { kv } from '@/lib/kv';
import { appOrigin } from '@/lib/origin';

export const dynamic = 'force-dynamic';

// Claiming needs both Clerk (to know who's signed in) and Postgres (to
// persist into) — matches the same xReady() gate every other Phase 1
// integration uses.
const claimReady = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) && dbReady();

const SOURCE_LABEL: Record<string, string> = {
  openapi: 'OpenAPI 3.x',
  swagger: 'Swagger 2.0',
  postman: 'Postman collection',
  curl: 'cURL import',
};


export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const record = isValidId(id) ? await kv().getImport(id) : null;
  return {
    title: record ? `${record.name} — DocentAPI` : 'Expired — DocentAPI',
    robots: { index: false }, // ephemeral pages stay out of search indexes
  };
}

function Expired() {
  return (
    <div style={{ display: 'grid', gap: 14, maxWidth: 560, margin: '60px auto', textAlign: 'center' }}>
      <span className="eyebrow">page expired</span>
      <h1 className="display" style={{ fontSize: 24 }}>This page has expired</h1>
      <p style={{ color: 'var(--fg-dim)' }}>
        Anonymous imports self-destruct after 24 hours — the page, the playground, and the MCP
        server. Re-import your spec to mint a fresh one, or join the waitlist for permanent pages.
      </p>
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
        <a className="btn primary" href="/">
          Re-import a spec
        </a>
        <a className="btn" href={process.env.SITE_WAITLIST_URL || 'http://localhost:5173/#start'}>
          Join the waitlist
        </a>
      </div>
    </div>
  );
}

export default async function IntegrationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const record = isValidId(id) ? await kv().getImport(id) : null;
  if (!record || record.expiresAt <= Date.now()) return <Expired />;

  const mcpUrl = `${appOrigin()}/mcp/${record.id}`;
  const signedIn = claimReady && Boolean((await auth()).userId);

  return (
    <div className="product-page wrap" style={{ display: 'grid', gap: 20 }}>
      <TtlNotice expiresAt={record.expiresAt} />
      {signedIn && <ClaimBanner ephemeralId={record.id} />}

      <header>
        <h1 className="display" style={{ fontSize: 26 }}>{record.name}</h1>
        <p className="mono" style={{ color: 'var(--fg-mute)', fontSize: 12.5, marginTop: 6 }}>
          {SOURCE_LABEL[record.source] ?? record.source} · {record.counts.total} endpoint
          {record.counts.total === 1 ? '' : 's'} · {record.counts.read} read / {record.counts.write}{' '}
          write / {record.counts.destructive} destructive
          {record.truncated ? ' · truncated to first 300' : ''}
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

      {claimReady && (
        <section className="panel" style={{ padding: 20, display: 'grid', gap: 8 }}>
          <h2 style={{ fontSize: 15 }}>This was the instant pass</h2>
          <p style={{ color: 'var(--fg-dim)', fontSize: 13.5 }}>
            Everything above came from the spec alone, in seconds. Deep analysis is the second
            pass: we crawl the provider&apos;s own docs, verify field by field, and email you when
            it&apos;s done — or if something needs your word rather than our guess.
          </p>
          <a
            className="btn"
            href={record.sourceUrl ? `/analyze?src=${encodeURIComponent(record.sourceUrl)}` : '/analyze'}
            style={{ justifySelf: 'start' }}
          >
            Start deep analysis <span aria-hidden="true">→</span>
          </a>
        </section>
      )}
      {aiReady() && (
        <AskAssistant
          slug={record.id}
          endpoint={`/api/p/${record.id}/ask`}
          subtitle={`Ask in plain language, free — no sign-in needed. Grounded in this API's own spec, capped to a few questions per paste.`}
        />
      )}
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

      <footer style={{ textAlign: 'center', padding: '20px 0', color: 'var(--fg-mute)', fontSize: 13 }}>
        This page self-destructs in {Math.max(0, Math.round((record.expiresAt - Date.now()) / 3_600_000))}h.{' '}
        <a href={process.env.SITE_WAITLIST_URL || 'http://localhost:5173/#start'}>Want it permanent? →</a>
      </footer>
    </div>
  );
}
