'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useState } from 'react';
import type { TraceLabel } from '@/lib/askTrace';

export type TraceRow = {
  key: string;
  label: TraceLabel;
  /** false while the call is in flight — the row shows its running form. */
  done: boolean;
  /** True only when a live probe produced this. See askTrace.isProbeBacked. */
  probed: boolean;
};

// The waiting time is the proof. For the first few seconds this is the ONLY
// thing on screen, which is when a reader decides whether to trust the answer —
// so the trace is not a spinner with extra steps, it is the evidence arriving.
//
// It collapses on the first token of prose, not on stream finish: the moment an
// answer exists, the trace's job is over and the answer needs the space.
// Collapsing at finish instead would fold it away under the reader's eyes
// mid-paragraph, which is the worst possible moment.
export default function AskToolTrace({
  rows,
  collapsed,
  onToggle,
  actionNames,
}: {
  rows: TraceRow[];
  collapsed: boolean;
  onToggle: () => void;
  actionNames: Set<string>;
}) {
  const reduce = useReducedMotion();
  const [id] = useState(() => `ask-trace-${Math.random().toString(36).slice(2, 9)}`);
  if (!rows.length) return null;

  const probedCount = rows.filter((r) => r.probed).length;
  const allDone = rows.every((r) => r.done);

  if (collapsed) {
    const verbs = rows.slice(0, 2).map((r) => r.label.done.split(' ').slice(0, 2).join(' '));
    const extra = rows.length - verbs.length;
    return (
      <button
        type="button"
        className="ask-trace-summary"
        aria-expanded={false}
        aria-controls={id}
        onClick={onToggle}
      >
        <span>
          {rows.length} {rows.length === 1 ? 'check' : 'checks'} · {verbs.join(', ')}
          {extra > 0 ? `, +${extra}` : ''}
        </span>
        {/* The only lime permitted in the collapsed state, and what makes a
            verified API visibly different from a spec-only one at a glance. */}
        {probedCount > 0 && <span className="ask-probed"> · {probedCount} probed</span>}
        <span aria-hidden="true" className="ask-trace-chevron">▾</span>
      </button>
    );
  }

  return (
    <div className="ask-trace" id={id}>
      <div className="ask-trace-head">
        <span>{allDone ? 'CHECKED' : 'CHECKING'}</span>
        {!allDone && <span className="ask-dot" aria-hidden="true" />}
      </div>
      <ol className="ask-trace-rows">
        {rows.map((row, index) => (
          <motion.li
            key={row.key}
            className="ask-trace-row"
            // From the left, along the rail the rows hang from. No stagger:
            // rows arrive when tools actually fire, which is real stagger —
            // a synthetic delay would misrepresent the timing.
            initial={reduce ? { opacity: 0 } : { opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: reduce ? 0 : 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            <span className="ask-trace-n" aria-hidden="true">
              <AnimatePresence mode="popLayout" initial={false}>
                {row.done ? (
                  <motion.span
                    key="n"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: reduce ? 0 : 0.18, delay: reduce ? 0 : 0.06 }}
                  >
                    {index + 1}
                  </motion.span>
                ) : (
                  <motion.span key="dot" exit={{ opacity: 0 }} className="ask-dot" />
                )}
              </AnimatePresence>
            </span>

            <span className="ask-trace-label">
              {row.done && row.label.tool && actionNames.has(row.label.tool) ? (
                // Navigable while the trace is still running.
                <LinkedLabel text={row.label.done} tool={row.label.tool} />
              ) : (
                <span className="ask-trace-verb">{row.done ? row.label.done : row.label.running}</span>
              )}
              {row.done && row.label.count && (
                <span className={row.label.tone === 'drift' ? 'ask-trace-count drift' : 'ask-trace-count'}>
                  {' · '}
                  {row.label.count}
                </span>
              )}
              {row.probed && <span className="ask-probed"> · probed</span>}
            </span>
          </motion.li>
        ))}
      </ol>
    </div>
  );
}

// Renders the endpoint name inside the sentence as a link to its card on the
// same page, leaving the rest of the label as plain text.
function LinkedLabel({ text, tool }: { text: string; tool: string }) {
  const at = text.indexOf(tool);
  if (at === -1) return <span className="ask-trace-verb">{text}</span>;
  return (
    <span className="ask-trace-verb">
      {text.slice(0, at)}
      <a className="ask-ref" href={`#action-${tool}`}>
        {tool}
      </a>
      {text.slice(at + tool.length)}
    </span>
  );
}
