'use client';

import { useEffect, useRef, useState } from 'react';

const SPEC_URL = 'https://api.stripe.com/openapi.json';

// Timeline phases: 1 = URL typed, 2–5 = log lines, 6 = result panels, 7 = cta.
const FINAL_PHASE = 7;
const TYPE_MS = 900;
const LOG_AT = [1150, 1600, 2050, 2500];
const RESULT_AT = 3050;
const CTA_AT = 3500;

export default function LandingDemo() {
  // Server HTML (and no-JS visitors) get the finished state; the effect below
  // rewinds and replays it only when JS + IntersectionObserver are available.
  const [chars, setChars] = useState(SPEC_URL.length);
  const [phase, setPhase] = useState(FINAL_PHASE);
  const [reduced, setReduced] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const typer = useRef<ReturnType<typeof setInterval> | null>(null);
  const started = useRef(false);

  const clearAll = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (typer.current) clearInterval(typer.current);
    typer.current = null;
  };

  const play = () => {
    started.current = true;
    clearAll();
    setChars(0);
    setPhase(0);
    const t0 = performance.now();
    typer.current = setInterval(() => {
      const frac = Math.min(1, (performance.now() - t0) / TYPE_MS);
      setChars(Math.round(frac * SPEC_URL.length));
      if (frac >= 1 && typer.current) {
        clearInterval(typer.current);
        typer.current = null;
        setPhase((p) => Math.max(p, 1));
      }
    }, 30);
    timers.current = [
      ...LOG_AT.map((at, index) => setTimeout(() => setPhase((p) => Math.max(p, 2 + index)), at)),
      setTimeout(() => setPhase((p) => Math.max(p, 6)), RESULT_AT),
      setTimeout(() => setPhase(FINAL_PHASE), CTA_AT),
    ];
  };

  useEffect(() => {
    let io: IntersectionObserver | null = null;
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) {
      setReduced(true); // stay on the finished state, hide replay
    } else if ('IntersectionObserver' in window && rootRef.current) {
      // rewind so the replay runs the first time the window scrolls into view
      setChars(0);
      setPhase(0);
      io = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting) && !started.current) {
            io?.disconnect();
            play();
          }
        },
        { threshold: 0.35 },
      );
      io.observe(rootRef.current);
    }
    // without IntersectionObserver: keep the finished state; replay still works
    return () => {
      io?.disconnect();
      clearAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const typing = chars < SPEC_URL.length && started.current;

  return (
    <div className="demo-window inst" ref={rootRef}>
      <div className="term-bar">
        <span className="term-title">spotcheck import · openapi.json</span>
        {!reduced && (
          <button className="demo-replay" type="button" onClick={play}>
            <span aria-hidden="true">↻</span> replay
          </button>
        )}
      </div>
      <div className="demo-body">
        <div className="demo-url">
          <span className="du-tag">spec</span>
          <span className="du-text">
            {SPEC_URL.slice(0, chars)}
            {typing && <span className="du-caret" aria-hidden="true" />}
          </span>
          <span className="du-btn" data-on={phase >= 1}>Generate →</span>
        </div>
        <div className="demo-log">
          <div className="dlog" data-on={phase >= 2}><span className="ok">✓</span> parsed <b>42 endpoints</b> · OpenAPI 3.1</div>
          <div className="dlog" data-on={phase >= 3}><span className="ok">✓</span> auth detected · <b>bearer token</b></div>
          <div className="dlog" data-on={phase >= 4}><span className="ok">✓</span> <b>38 tools</b> normalized · unsafe ops flagged</div>
          <div className="dlog" data-on={phase >= 5}><span className="ok">✓</span> playground ready · MCP server minted</div>
        </div>
        <div className="demo-result" data-on={phase >= 6}>
          <div className="demo-play">
            <div className="dp-head">Live playground</div>
            <div className="dp-row"><span className="dp-m get">GET</span><span className="dp-path">/v1/charges</span><span className="dp-try">Try it</span></div>
            <div className="dp-row active"><span className="dp-m post">POST</span><span className="dp-path">/v1/payment_intents</span><span className="dp-chip">200 OK · 142ms</span></div>
            <div className="dp-resp">{'{ "id": "pi_3Ok…", "status": "succeeded" }'}</div>
            <div className="dp-row"><span className="dp-m post">POST</span><span className="dp-path">/v1/refunds</span><span className="dp-try">Try it</span></div>
          </div>
          <div className="demo-mcp">
            <div className="dm-head">Hosted MCP server</div>
            <div className="dm-url"><span>spotcheck.dev/mcp/stripe</span><span className="dm-copy">copy</span></div>
            <div className="dm-hint">Drop into Claude · Cursor · Copilot</div>
            <div className="dm-score">
              <span className="dm-score-label">Agent-Ready</span>
              <b>87</b>
              <span className="dm-score-max">/100</span>
            </div>
          </div>
        </div>
        <p className="demo-cta" data-on={phase >= FINAL_PHASE}>
          That was a replay — the live importer is at the top of this page.{' '}
          <a href="#top">Import your API <span aria-hidden="true">→</span></a>
        </p>
      </div>
    </div>
  );
}
