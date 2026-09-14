'use client';

import { useCallback, useEffect, useState } from 'react';
import { describeInference, inferEnvironment } from '@/lib/credentialInference';

// The owner's surface for the vault. Two lanes: a SANDBOX key the probes may
// use for writes with cleanup and for rate-limit discovery (every plan), and a
// production key (Team+). The panel never sees plaintext back — the route
// returns metadata and the audit trail, and the secret leaves this component
// with one POST.

type Meta = {
  id: string;
  environment: string;
  hint: string;
  label: string | null;
  createdAt: string;
  rotatedAt: string | null;
  lastUsedAt: string | null;
  lastProbeRunAt: string | null;
  writeConsentAt: string | null;
  burstConsentAt: string | null;
  inferredEnvironment: string | null;
  inferenceBasis: string | null;
};

type AuditRow = { id: number; action: string; actorType: string; environment: string | null; detail: string | null; createdAt: string };

type Payload = { credentials: Meta[]; audit: AuditRow[]; gates: { sandbox: boolean; production: boolean } };

function when(value: string | null): string {
  if (!value) return 'never';
  return new Date(value).toISOString().slice(0, 10);
}

export default function SandboxCredentialPanel({ slug, baseUrls }: { slug: string; baseUrls: string[] }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [writeConsent, setWriteConsent] = useState(false);
  const [burstConsent, setBurstConsent] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const endpoint = `/api/apis/${slug}/credentials`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(endpoint);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setLoadError(body.error ?? 'Could not load credentials');
        return;
      }
      setData((await res.json()) as Payload);
      setLoadError(null);
    } catch {
      setLoadError('Could not load credentials');
    }
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  const sandbox = data?.credentials.find((c) => c.environment === 'sandbox') ?? null;
  const production = data?.credentials.find((c) => c.environment === 'production') ?? null;
  const inference = secret.trim() ? inferEnvironment(secret, { baseUrls }) : null;
  const looksLive = inference?.environment === 'production' && inference.basis === 'known_prefix';

  const store = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret,
          environment: 'sandbox',
          label: label || undefined,
          confirmedNoRealData: confirmed,
          writeConsent,
          burstConsent,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not store the key');
      setSecret('');
      setLabel('');
      setConfirmed(false);
      setNotice(body.note ?? 'Stored.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not store the key');
    } finally {
      setBusy(false);
    }
  };

  const patch = async (change: { writeConsent?: boolean; burstConsent?: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not update');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${endpoint}?environment=sandbox`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not revoke');
      setConfirmRevoke(false);
      setNotice('Sandbox key revoked. Probing with it stops now; facts already recorded stay, labelled sandbox.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" style={{ padding: 20, display: 'grid', gap: 12 }}>
      <h2 style={{ fontSize: 15 }}>Sandbox credential</h2>
      <p style={{ color: 'var(--fg-mute)', fontSize: 12.5 }}>
        A test key DocentAPI keeps, encrypted, to exercise this API for you — including writes with cleanup.
        It is used only against your test environment, every use is logged here, and you can revoke it at
        any time.
      </p>

      {loadError && <p style={{ color: 'var(--accent-red)', fontSize: 12.5 }}>{loadError}</p>}

      {data && !sandbox && data.gates.sandbox && (
        <div style={{ display: 'grid', gap: 10 }}>
          <div>
            <label htmlFor="sbx-label">Label</label>
            <input id="sbx-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Dub test workspace" maxLength={60} disabled={busy} />
          </div>
          <div>
            <label htmlFor="sbx-secret">Test key</label>
            <input
              id="sbx-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="sk_test_…"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
            {inference && (
              <p className="mono" style={{ fontSize: 11.5, color: looksLive ? 'var(--accent-red)' : 'var(--fg-dim)', marginTop: 4 }}>
                {describeInference(inference)}
              </p>
            )}
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 }}>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} />
            <span>This key has no real customers, money or messages behind it.</span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 }}>
            <input type="checkbox" checked={writeConsent} onChange={(e) => setWriteConsent(e.target.checked)} disabled={busy} />
            <span>
              DocentAPI will create, update and delete its own test records, named <code>docentapi-probe-…</code>, in this
              environment and remove them afterwards. Nothing pre-existing is touched.
            </span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 }}>
            <input type="checkbox" checked={burstConsent} onChange={(e) => setBurstConsent(e.target.checked)} disabled={busy} />
            <span>
              Let DocentAPI discover this API&apos;s rate limit by sending a short burst of identical cheap reads (at most 120 in a
              minute, stopping at the first 429) and then checking that Retry-After is honoured. Runs last, only with this
              sandbox key.
            </span>
          </label>
          <div>
            <button type="button" className="btn primary" onClick={store} disabled={busy || !secret.trim() || !confirmed || looksLive}>
              {busy ? 'Storing…' : 'Store sandbox key'}
            </button>
          </div>
        </div>
      )}

      {sandbox && (
        <div style={{ display: 'grid', gap: 8, fontSize: 12.5 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <strong>{sandbox.label ?? 'Sandbox key'}</strong>
            <span className="mono" style={{ color: 'var(--fg-dim)' }}>••••{sandbox.hint}</span>
            <span className="chip">sandbox</span>
          </div>
          <p className="mono" style={{ color: 'var(--fg-dim)', fontSize: 11.5 }}>
            stored {when(sandbox.createdAt)} · rotated {when(sandbox.rotatedAt)} · last probe {when(sandbox.lastProbeRunAt)}
            {sandbox.inferredEnvironment && sandbox.inferredEnvironment !== 'unknown' ? ` · looked like ${sandbox.inferredEnvironment}` : ''}
          </p>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={Boolean(sandbox.writeConsentAt)} onChange={(e) => patch({ writeConsent: e.target.checked })} disabled={busy} />
            <span>Writes with cleanup (create, update and delete DocentAPI&apos;s own <code>docentapi-probe-…</code> records)</span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={Boolean(sandbox.burstConsentAt)} onChange={(e) => patch({ burstConsent: e.target.checked })} disabled={busy} />
            <span>Rate-limit discovery burst (at most 120 cheap reads in a minute, stops at the first 429)</span>
          </label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {confirmRevoke ? (
              <>
                <span style={{ color: 'var(--fg-mute)' }}>Revoke the sandbox key? Probing stops immediately.</span>
                <button type="button" className="btn" onClick={revoke} disabled={busy}>
                  Yes, revoke
                </button>
                <button type="button" className="btn" onClick={() => setConfirmRevoke(false)} disabled={busy}>
                  Keep it
                </button>
              </>
            ) : (
              <button type="button" className="btn" onClick={() => setConfirmRevoke(true)} disabled={busy}>
                Revoke
              </button>
            )}
          </div>
        </div>
      )}

      {data && (
        <p style={{ color: 'var(--fg-mute)', fontSize: 12 }}>
          {data.gates.production
            ? production
              ? `Production credential stored (••••${production.hint}).`
              : 'A production credential can be stored through the API; the sandbox key is all the probes need.'
            : 'Production credentials are a Team feature. Your sandbox key is all the probes need.'}
        </p>
      )}

      {error && <p style={{ color: 'var(--accent-red)', fontSize: 12.5 }}>{error}</p>}
      {notice && <p style={{ color: 'var(--fg-mute)', fontSize: 12.5 }}>{notice}</p>}

      {data && data.audit.length > 0 && (
        <details>
          <summary style={{ fontSize: 12.5, cursor: 'pointer' }}>Recent activity ({Math.min(10, data.audit.length)})</summary>
          <ul className="mono" style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--fg-dim)' }}>
            {data.audit.slice(0, 10).map((row) => (
              <li key={row.id}>
                {when(row.createdAt)} · {row.action} · {row.actorType}
                {row.environment ? ` · ${row.environment}` : ''}
                {row.detail ? ` · ${row.detail}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
