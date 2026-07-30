'use client';

import { useEffect, useRef } from 'react';
import { Streamdown } from 'streamdown';

// Renders one streamed answer.
//
// Two things here are load-bearing and easy to mistake for polish:
//
// 1. --font-display is BANNED inside an answer (enforced in globals.css). An
//    LLM's `##` is a paragraph label, not a document section, and rendering it
//    at display size hands a machine's outline the authority of the page's own
//    headings. Display type is the page's voice, not the model's.
//
// 2. The min-height guard is layout stability, not motion — so it is kept even
//    under prefers-reduced-motion. Without it the panel rubber-bands every time
//    a fenced code block finishes parsing, which is the single most distracting
//    thing a streaming surface can do.
export default function AskAnswer({
  markdown,
  streaming,
  endsWithCode,
}: {
  markdown: string;
  streaming: boolean;
  endsWithCode: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const tallest = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!streaming) {
      // New turn, or finished: release the floor so the next answer can be
      // shorter than this one was.
      tallest.current = 0;
      el.style.minHeight = '';
      return;
    }
    tallest.current = Math.max(tallest.current, el.scrollHeight);
    el.style.minHeight = `${tallest.current}px`;
  }, [markdown, streaming]);

  return (
    <div
      ref={ref}
      className="ask-answer"
      // Suppressed on a trailing fenced block: a blinking caret inside a <pre>
      // reads as a syntax error rather than a cursor.
      data-streaming={streaming && !endsWithCode ? '' : undefined}
    >
      <Streamdown
        // Half-written markdown is the normal state here, not an edge case. This
        // is the whole reason for streamdown over react-markdown: an unclosed
        // fence or a dangling ** must not flash as broken syntax on every token.
        mode="streaming"
        parseIncompleteMarkdown
        // Third-party API text reaches this surface through tool results, so the
        // renderer must never become a path to raw HTML. Streamdown sanitizes by
        // default; images are additionally refused because a model-authored
        // <img src> is a data-exfiltration channel — the browser fetches it, and
        // the path can carry whatever the model was told to encode into it.
        disallowedElements={['img', 'script', 'iframe', 'object', 'embed', 'form', 'input']}
        unwrapDisallowed
      >
        {markdown}
      </Streamdown>
    </div>
  );
}
