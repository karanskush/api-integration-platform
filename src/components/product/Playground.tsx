'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Action, AuthPlacement, AuthScheme } from '@/lib/ir';

type Props = {
  id: string;
  actions: Action[];
  baseUrls: string[];
  auth: AuthScheme;
  authIn?: AuthPlacement;
};

type RunResult = {
  status: number;
  latencyMs: string;
  contentType: string;
  body: string;
};

type SchemaProp = Record<string, unknown>;

function fieldsOf(action: Action): Array<[string, SchemaProp]> {
  return Object.entries((action.paramsSchema.properties ?? {}) as Record<string, SchemaProp>);
}

function placeholderFor(schema: SchemaProp): string {
  if (schema.example !== undefined) return String(schema.example);
  if (schema.default !== undefined) return String(schema.default);
  return '';
}

function initialBody(action: Action): string {
  const body = ((action.paramsSchema.properties ?? {}) as Record<string, SchemaProp>).body;
  if (!body) return '';
  const example = action.examples[0]?.params?.body ?? body.example;
  if (example !== undefined) return JSON.stringify(example, null, 2);
  const props = (body.properties ?? {}) as Record<string, SchemaProp>;
  const stub: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props).slice(0, 6)) {
    stub[k] = v.example ?? (v.type === 'integer' || v.type === 'number' ? 0 : v.type === 'boolean' ? false : '');
  }
  return Object.keys(stub).length ? JSON.stringify(stub, null, 2) : '{}';
}

export default function Playground({ id, actions, baseUrls, auth }: Props) {
  const runnable = useMemo(() => actions.filter((a) => a.safety !== 'destructive'), [actions]);
  const [actionId, setActionId] = useState(runnable[0]?.id ?? '');
  const action = runnable.find((a) => a.id === actionId) ?? runnable[0];
  const [baseUrl, setBaseUrl] = useState(baseUrls[0]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [bodyText, setBodyText] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);

  // BYOK: the key lives in sessionStorage for this import only — never in
  // URLs, never sent anywhere but our same-origin proxy.
  useEffect(() => {
    setKey(sessionStorage.getItem(`docentapi:key:${id}`) ?? '');
  }, [id]);
  const saveKey = (v: string) => {
    setKey(v);
    if (v) sessionStorage.setItem(`docentapi:key:${id}`, v);
    else sessionStorage.removeItem(`docentapi:key:${id}`);
  };

  useEffect(() => {
    setValues({});
    setBodyText(action ? initialBody(action) : '');
    setResult(null);
    setError(null);
  }, [actionId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!action) return <p style={{ color: 'var(--fg-mute)' }}>No runnable (non-destructive) actions.</p>;

  const fields = fieldsOf(action).filter(([name]) => name !== 'body');
  const hasBody = fieldsOf(action).some(([name]) => name === 'body');
  const required = new Set(
    Array.isArray(action.paramsSchema.required) ? (action.paramsSchema.required as string[]) : [],
  );

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const params: Record<string, unknown> = {};
      for (const [name, raw] of Object.entries(values)) if (raw !== '') params[name] = raw;
      if (hasBody && bodyText.trim()) {
        try {
          params.body = JSON.parse(bodyText);
        } catch {
          throw new Error('Body is not valid JSON');
        }
      }
      const res = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, actionId: action.id, params, baseUrl, auth: key ? { token: key } : undefined }),
        signal: AbortSignal.timeout(30_000),
      });
      const contentType = res.headers.get('x-upstream-content-type') ?? res.headers.get('content-type') ?? '';
      let text = await res.text();
      if (/json/.test(contentType)) {
        try {
          text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          // leave as-is
        }
      }
      if (!res.headers.get('x-upstream-latency-ms') && !res.ok) {
        // proxy-level error (validation, allowlist, rate limit) — surface message
        try {
          const parsed = JSON.parse(text);
          if (parsed.error) throw new Error(parsed.error);
        } catch (e) {
          if (e instanceof Error && e.message !== 'Unexpected end of JSON input') throw e;
        }
      }
      setResult({
        status: res.status,
        latencyMs: res.headers.get('x-upstream-latency-ms') ?? '—',
        contentType,
        body: text.slice(0, 100_000),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label htmlFor="pg-action">Action</label>
          <select id="pg-action" value={action.id} onChange={(e) => setActionId(e.target.value)}>
            {runnable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.method} {a.path} — {a.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="pg-key">
            {auth === 'none' ? 'API key (optional)' : `Your API key (${auth}) — stays in this browser tab`}
          </label>
          <input
            id="pg-key"
            type="password"
            placeholder={auth === 'basic' ? 'user:password' : 'paste key / token'}
            value={key}
            onChange={(e) => saveKey(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>

      {baseUrls.length > 1 && (
        <div>
          <label htmlFor="pg-base">Base URL</label>
          <select id="pg-base" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}>
            {baseUrls.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>
      )}

      {fields.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
          {fields.map(([name, schema]) => (
            <div key={name}>
              <label htmlFor={`pg-f-${name}`}>
                {name}
                {required.has(name) ? ' *' : ''}{' '}
                <span style={{ color: 'var(--fg-mute)' }}>({String(schema['x-docentapi-in'])})</span>
              </label>
              {Array.isArray(schema.enum) ? (
                <select
                  id={`pg-f-${name}`}
                  value={values[name] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
                >
                  <option value="">—</option>
                  {(schema.enum as unknown[]).map((opt) => (
                    <option key={String(opt)} value={String(opt)}>
                      {String(opt)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`pg-f-${name}`}
                  type="text"
                  placeholder={placeholderFor(schema)}
                  value={values[name] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {hasBody && (
        <div>
          <label htmlFor="pg-body">Request body (JSON)</label>
          <textarea
            id="pg-body"
            rows={6}
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            spellCheck={false}
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button type="button" className="btn primary" onClick={run} disabled={busy}>
          {busy ? 'Running…' : `Run ${action.method}`}
        </button>
        {result && (
          <span className="mono" style={{ fontSize: 12.5 }}>
            <span style={{ color: result.status < 400 ? 'var(--accent-green)' : 'var(--accent-red)' }}>
              {result.status}
            </span>
            <span style={{ color: 'var(--fg-mute)' }}> · {result.latencyMs}ms · {result.contentType.split(';')[0]}</span>
          </span>
        )}
      </div>

      {error && <p style={{ color: 'var(--accent-red)', fontSize: 13 }}>{error}</p>}
      {result && <pre className="codeblock" style={{ maxHeight: 420, overflow: 'auto' }}>{result.body || '(empty body)'}</pre>}
    </div>
  );
}
