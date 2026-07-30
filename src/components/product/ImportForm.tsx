'use client';

import { useEffect, useRef, useState } from 'react';

type ImportMode = 'url' | 'paste' | 'curl';

const MODES: Array<{ id: ImportMode; label: string }> = [
  { id: 'url', label: 'Spec URL' },
  { id: 'paste', label: 'Paste spec' },
  { id: 'curl', label: 'cURL' },
];

const EXAMPLES = [
  { label: 'Petstore', value: 'https://petstore3.swagger.io/api/v3/openapi.json' },
  { label: 'Stripe', value: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json' },
];

const STAGES = ['Fetching source', 'Parsing endpoints', 'Normalizing actions', 'Minting MCP server'];

function detectedMode(value: string): ImportMode | null {
  const text = value.trim();
  if (/^curl(?:\s|$)/i.test(text)) return 'curl';
  if (text.startsWith('{') || text.includes('\n') || /(?:openapi|swagger)\s*:/i.test(text)) return 'paste';
  return null;
}

// `deep` comes from the server component: when the visitor is signed in, the
// submission routes through /api/apis/analyze — same fast parse, but it
// persists to their org and starts the deep pipeline automatically, landing
// on /[slug] where the analysis-in-progress banner gates the page. If the
// deep path can't run (no quota, persistence not configured, session
// expired), we fall back to the anonymous instant import rather than fail —
// the magic moment must survive every misconfiguration.
export default function ImportForm({ deep = false }: { deep?: boolean }) {
  const [mode, setMode] = useState<ImportMode>('url');
  const [values, setValues] = useState<Record<ImportMode, string>>({ url: '', paste: '', curl: '' });
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  useEffect(() => clearTimers, []);

  const selectMode = (next: ImportMode) => {
    if (busy) return;
    setMode(next);
    setError(null);
  };

  const startProgress = () => {
    clearTimers();
    setStage(0);
    timers.current = [1, 2, 3].map((next) => setTimeout(() => setStage(next), next * 1100));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    let value = values[mode].trim();
    if (!value) {
      setError(mode === 'url' ? 'Paste a spec URL first.' : `Paste ${mode === 'curl' ? 'a cURL command' : 'a spec'} first.`);
      return;
    }

    if (mode === 'url' && !/^https?:\/\//i.test(value)) {
      if (/^[\w-]+(?:\.[\w-]+)+(?:[/:?#].*)?$/.test(value)) {
        value = `https://${value}`;
        setValues((current) => ({ ...current, url: value }));
      } else {
        setError('That does not look like a URL. Use Paste spec for raw JSON or YAML.');
        return;
      }
    }

    setBusy(true);
    startProgress();
    try {
      if (deep) {
        const deepResponse = await fetch('/api/apis/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(mode === 'url' ? { url: value } : { text: value }), docUrls: [] }),
          signal: AbortSignal.timeout(45_000),
        });
        const deepData = await deepResponse.json().catch(() => ({}));
        if (deepResponse.ok && typeof deepData.slug === 'string') {
          clearTimers();
          setStage(STAGES.length);
          window.location.assign(`/${deepData.slug}`);
          return;
        }
        // Quota exhausted, persistence/queue unconfigured, or session gone —
        // fall through to the instant import. Anything else (a bad spec) would
        // fail there identically, so surface the deep error as the error.
        if (![401, 429, 503].includes(deepResponse.status)) {
          throw new Error(
            typeof deepData.error === 'string' ? deepData.error : `Import failed (${deepResponse.status}).`,
          );
        }
      }

      const response = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'url' ? { url: value } : { text: value }),
        signal: AbortSignal.timeout(45_000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data.pageUrl !== 'string') {
        throw new Error(
          response.status === 429
            ? 'Rate limit reached. Try again in a few minutes.'
            : typeof data.error === 'string'
              ? data.error
              : `Import failed (${response.status}).`,
        );
      }
      clearTimers();
      setStage(STAGES.length);
      window.location.assign(data.pageUrl);
    } catch (err) {
      clearTimers();
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
      setError(
        timedOut
          ? 'Import timed out after 45 seconds — the source may be slow or unreachable. Try again.'
          : err instanceof Error
            ? err.message
            : 'Import failed.',
      );
      setBusy(false);
    }
  };

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = MODES.findIndex((item) => item.id === mode);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % MODES.length;
    else if (event.key === 'ArrowLeft') next = (index + MODES.length - 1) % MODES.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = MODES.length - 1;
    else return;
    event.preventDefault();
    selectMode(MODES[next].id);
    document.getElementById(`import-tab-${MODES[next].id}`)?.focus();
  };

  const sharedFieldProps = {
    value: values[mode],
    disabled: busy,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setValues((current) => ({ ...current, [mode]: event.target.value }));
      if (error) setError(null);
    },
  };

  return (
    <form onSubmit={submit} className="panel import-panel">
      <div className="import-tabs" role="tablist" aria-label="Import source" onKeyDown={onTabKeyDown}>
        {MODES.map((item) => (
          <button
            id={`import-tab-${item.id}`}
            key={item.id}
            type="button"
            role="tab"
            aria-selected={mode === item.id}
            aria-controls={mode === item.id ? `import-panel-${item.id}` : undefined}
            tabIndex={mode === item.id ? 0 : -1}
            onClick={() => selectMode(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div id={`import-panel-${mode}`} role="tabpanel" aria-labelledby={`import-tab-${mode}`} className="import-field">
        <label htmlFor={`import-${mode}`}>
          {mode === 'url' ? 'OpenAPI, Swagger, or Postman URL' : mode === 'paste' ? 'OpenAPI, Swagger, or Postman content' : 'cURL command'}
        </label>
        {mode === 'url' ? (
          <input
            {...sharedFieldProps}
            id="import-url"
            type="text"
            inputMode="url"
            autoComplete="url"
            placeholder="https://api.example.com/openapi.json"
            onPaste={(event) => {
              const next = detectedMode(event.clipboardData.getData('text'));
              if (!next) return;
              event.preventDefault();
              const pasted = event.clipboardData.getData('text');
              setValues((current) => ({ ...current, [next]: pasted }));
              selectMode(next);
            }}
          />
        ) : (
          <textarea
            {...sharedFieldProps}
            id={`import-${mode}`}
            rows={7}
            spellCheck={false}
            placeholder={mode === 'curl' ? "curl 'https://api.example.com/v1/users?limit=10'" : 'openapi: 3.1.0\ninfo:\n  title: Example API'}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
        )}
      </div>

      {mode === 'url' && (
        <div className="import-examples" aria-label="Example specifications">
          <span>Try an example</span>
          {EXAMPLES.map((example) => (
            <button
              key={example.label}
              type="button"
              disabled={busy}
              onClick={() => setValues((current) => ({ ...current, url: example.value }))}
            >
              {example.label}
            </button>
          ))}
        </div>
      )}

      {busy && (
        <div className="import-progress" role="status" aria-live="polite">
          {STAGES.map((label, index) => (
            <span key={label} data-state={index < stage ? 'done' : index === stage ? 'active' : 'waiting'}>
              {index < stage ? '✓' : index + 1} {label}
            </span>
          ))}
        </div>
      )}

      {error && <p className="form-error" role="alert">{error}</p>}

      <button className="btn primary btn-block" type="submit" disabled={busy}>
        {busy ? STAGES[Math.min(stage, STAGES.length - 1)] : 'Generate workspace'}
        <span aria-hidden="true">→</span>
      </button>
    </form>
  );
}
