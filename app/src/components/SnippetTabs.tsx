'use client';

import { useState } from 'react';
import CopyButton from './CopyButton';

export type Snippets = { curl: string; typescript: string; python: string };

const TABS: Array<{ key: keyof Snippets; label: string }> = [
  { key: 'curl', label: 'cURL' },
  { key: 'typescript', label: 'TypeScript' },
  { key: 'python', label: 'Python' },
];

export default function SnippetTabs({ snippets }: { snippets: Snippets }) {
  const [active, setActive] = useState<keyof Snippets>('curl');
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className="btn"
            style={{
              padding: '3px 10px',
              fontSize: 12,
              borderColor: active === t.key ? 'var(--accent)' : 'var(--hair)',
              color: active === t.key ? 'var(--accent)' : 'var(--fg-dim)',
            }}
            onClick={() => setActive(t.key)}
          >
            {t.label}
          </button>
        ))}
        <div style={{ marginLeft: 'auto' }}>
          <CopyButton text={snippets[active]} />
        </div>
      </div>
      <pre className="codeblock">{snippets[active]}</pre>
    </div>
  );
}
