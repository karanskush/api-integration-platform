'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from 'ai';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { describeToolCall, isAdvisorToolName, isProbeBacked } from '@/lib/askTrace';
import type { AskSeed } from '@/lib/askSeeds';
import AskAnswer from './AskAnswer';
import AskToolTrace, { type TraceRow } from './AskToolTrace';

// Ask is a channel, not a form.
//
// The component it replaces was built as a form — one field, one submit, one
// response, setResult(null) on the next question. That is the right shape for a
// lookup, where the previous value is worthless. But what sits underneath is a
// provenance engine: eight read-only tools over an evidence graph, nearly all of
// which return an explicit "is this measured or inferred?" discriminator. The
// old surface kept result.answer and a comma-joined list of tool NAMES, throwing
// away every argument and every basis field — which made it the one place in
// this product that laundered inference into assertion.
//
// So: an evidence-cited transcript you watch being assembled. Evidence owns the
// time (the trace is the only thing on screen while you wait, which is when
// trust is formed) and the frame (an attribution slug above, citations below).
// Prose owns the middle.

const MAX_QUESTION_LENGTH = 1000;

export type AskChannelProps = {
  apiName: string;
  endpoint: string;
  seeds: AskSeed[];
  /** Endpoint names on this page, so citations only link where a card exists. */
  actionNames: string[];
  /** ISO string when probes last ran, or null. The only source of header lime. */
  verifiedAt: string | null;
};

export default function AskChannel({
  apiName,
  endpoint,
  seeds,
  actionNames,
  verifiedAt,
}: AskChannelProps) {
  const reduce = useReducedMotion();
  const [draft, setDraft] = useState('');
  // Which assistant messages the reader has manually re-expanded. Collapse is
  // automatic; expansion is not, so it must survive re-renders.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const firstQuestionRef = useRef<HTMLLIElement>(null);
  const names = useMemo(() => new Set(actionNames), [actionNames]);

  const { messages, sendMessage, status, error, stop, clearError } = useChat({
    transport: new DefaultChatTransport({ api: endpoint }),
  });

  const busy = status === 'submitted' || status === 'streaming';

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      clearError();
      setDraft('');
      sendMessage({ text: trimmed });
      // Once, on submit, and `nearest` so nothing moves if it is already
      // visible. Never again — this is an inline panel inside a long document,
      // and following tokens would steal the page from the reader.
      requestAnimationFrame(() =>
        firstQuestionRef.current?.scrollIntoView({
          block: 'nearest',
          behavior: reduce ? 'auto' : 'smooth',
        }),
      );
    },
    [busy, clearError, reduce, sendMessage],
  );

  const turns = useMemo(() => groupIntoTurns(messages), [messages]);

  return (
    <section className="ask" aria-label={`Ask ${apiName}`}>
      <header className="ask-head">
        <span className="ask-who">agent ›</span>
        <h2 className="ask-title">Ask this API</h2>
        <span className="ask-basis">
          {verifiedAt ? (
            <>
              <span className="ask-dot ok" aria-hidden="true" /> probe-verified
            </>
          ) : (
            'from this API’s spec and field graph'
          )}
        </span>
      </header>

      <div className="ask-body">
        <AnimatePresence initial={false}>
          {turns.length === 0 && (
            <motion.div
              key="empty"
              className="ask-empty"
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.12 }}
            >
              <p className="ask-lede">
                Answers are assembled from this API’s own spec and field graph — you watch each
                check happen, and nothing is asserted that a tool did not return.
              </p>
              <ul className="ask-seeds">
                {seeds.map((seed) => (
                  <li key={seed.question}>
                    <button type="button" className="ask-seed" onClick={() => submit(seed.question)}>
                      {seed.question}
                      {seed.tool && <span className="ask-seed-tool">{seed.tool}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>

        {turns.length > 0 && (
          <ol className="ask-thread">
            {turns.map((turn, index) => {
              const isLast = index === turns.length - 1;
              const rows = traceRows(turn.assistant);
              const answer = answerMarkdown(turn.assistant);
              const streaming = busy && isLast;
              // Collapse on the first token of prose, not on stream finish.
              const collapsed = !expanded.has(turn.key) && answer.length > 0;
              return (
                <motion.li
                  key={turn.key}
                  className="ask-turn"
                  ref={isLast ? firstQuestionRef : undefined}
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: reduce ? 0 : 0.26, ease: [0.16, 1, 0.3, 1] }}
                >
                  <p className="ask-q">{turn.question}</p>
                  <AskToolTrace
                    rows={rows}
                    collapsed={collapsed}
                    onToggle={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(turn.key)) next.delete(turn.key);
                        else next.add(turn.key);
                        return next;
                      })
                    }
                    actionNames={names}
                  />
                  {answer && (
                    <AskAnswer
                      markdown={answer}
                      streaming={streaming}
                      endsWithCode={endsInOpenFence(answer)}
                    />
                  )}
                </motion.li>
              );
            })}
          </ol>
        )}

        {/* Streamed text is announced without stealing focus. The old surface
            had no live region at all, so a screen-reader user heard a button
            label change and then silence. */}
        <p className="ask-sr" role="status" aria-live="polite">
          {busy ? 'Assembling an answer…' : turns.length ? 'Answer complete.' : ''}
        </p>

        {error && (
          <motion.div
            className="ask-error"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduce ? 0 : 0.2 }}
          >
            <span className="ask-error-cause">{visitorMessage(error)}</span>
            <button type="button" className="ask-error-act" onClick={() => submit(lastQuestion(turns))}>
              Try again
            </button>
          </motion.div>
        )}
      </div>

      <div className="ask-composer">
        <textarea
          ref={inputRef}
          className="ask-input"
          aria-label={`Ask a question about ${apiName}`}
          placeholder={turns.length ? 'Ask a follow-up…' : 'Ask anything about this API…'}
          rows={2}
          maxLength={MAX_QUESTION_LENGTH}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit(draft);
            }
            if (e.key === 'Escape' && busy) stop();
          }}
          // Deliberately NOT disabled while busy. Disabling the focused textarea
          // blurs it to <body> for the length of the answer and never restores
          // focus — a real a11y bug in the surface this replaces.
        />
        <div className="ask-controls">
          <span className="ask-hint">
            {busy ? 'Esc to stop' : 'Enter to send · Shift+Enter for a new line'}
          </span>
          {busy ? (
            <button type="button" className="btn ask-send" onClick={stop}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="btn primary ask-send"
              onClick={() => submit(draft)}
              disabled={!draft.trim()}
            >
              Ask
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

type Turn = { key: string; question: string; assistant: UIMessage | null };

// The transport returns a flat message list; the UI reads in question/answer
// pairs, so the pairing happens once here rather than inside the render.
function groupIntoTurns(messages: UIMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ key: message.id, question: textOf(message), assistant: null });
    } else if (turns.length) {
      turns[turns.length - 1].assistant = message;
    }
  }
  return turns;
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function answerMarkdown(message: UIMessage | null): string {
  return message ? textOf(message) : '';
}

// Reads parts in document order, so an interleaved "check, answer, check again"
// turn keeps its real sequence rather than being reordered into two blocks.
function traceRows(message: UIMessage | null): TraceRow[] {
  if (!message) return [];
  const rows: TraceRow[] = [];
  for (const part of message.parts) {
    if (!isToolUIPart(part)) continue;
    const name = getToolName(part);
    // Names are read off the part rather than through typed `tool-<name>` keys:
    // buildAskTools returns an untyped ToolSet, so InferUITools cannot produce
    // literal keys for these.
    if (!isAdvisorToolName(name)) continue;
    const done = part.state === 'output-available' || part.state === 'output-error';
    const output = part.state === 'output-available' ? part.output : undefined;
    rows.push({
      key: part.toolCallId,
      label: describeToolCall(name, part.input, output),
      done,
      probed: done && isProbeBacked(name, output),
    });
  }
  return rows;
}

function endsInOpenFence(markdown: string): boolean {
  return (markdown.match(/```/g)?.length ?? 0) % 2 === 1;
}

function lastQuestion(turns: Turn[]): string {
  return turns.length ? turns[turns.length - 1].question : '';
}

// Every error string the reader can see, in one place. The routes' own messages
// are operator diagnostics — a misconfigured deploy used to tell an anonymous
// visitor to "set AI_GATEWAY_API_KEY and redeploy", which they do not own.
function visitorMessage(error: Error): string {
  // HttpChatTransport throws with the raw response body as the message.
  try {
    const parsed = JSON.parse(error.message) as { error?: string };
    const server = parsed.error ?? '';
    if (/not configured/i.test(server)) {
      return 'The assistant is not available on this deployment yet.';
    }
    if (/limit reached|too many/i.test(server)) return server;
    if (/Pro plan/i.test(server)) return server;
    if (/sign in/i.test(server)) return 'Sign in to ask questions about this API.';
    if (server) return server;
  } catch {
    // Not JSON — a network drop or an aborted stream.
  }
  return 'That answer did not finish. Try again.';
}
