import SceneStage from '@/components/landing/SceneStage';
import { LatticePoster } from '@/components/landing/posters';
import { appHost } from '@/lib/origin';

// The landing page is a conversion surface, not the product's argument. The
// argument — lineage, field origins, the score, the clarification archetypes —
// moved to /how-it-works when paid traffic became the primary visitor. What is
// left states the offer, sells three things, and shows the two steps it takes
// to start. Anything that cannot survive an eight-second read does not belong
// here; it belongs one click away.
//
// Deliberately not on this page: SmoothScroll. Lenis exists to make the
// chaptered page's scrubbed scenes readable, and there is nothing to scrub
// here — so an ad click does not pay to download it.

// Every hostname this page shows is the one it is actually served from.
// Hardcoding `docentapi.dev` meant the page promised URLs that did not
// resolve — the single thing on a page about not overclaiming that overclaimed.
// Resolved once here: PUBLIC_APP_ORIGIN is fixed for a deployment's lifetime.
const HOST = appHost();

// A right-pointing arrow, drawn rather than typed: the glyph in a system font
// sits on a different baseline in every fallback, and this one has to line up
// inside a button.
function Arrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8h10" />
      <path d="M9 4l4 4-4 4" />
    </svg>
  );
}

// The only tick on the page, and it is earned: it marks a probe result. See
// the palette contract at the top of landing.css before adding a second one.
function Check() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 7.5l3 3 6-7" />
    </svg>
  );
}

// What the two steps buy you, stated as outcomes rather than features. Keyline
// bullets, not ticks — none of this has been verified for the visitor yet.
const AFTER = [
  'Every read-safe endpoint run and recorded',
  'Your MCP server, live at a URL you own',
  'Docs that answer questions, not just describe fields',
];

// A worked example of the shape of an answer, not a claim about any real API.
// The `.disclaimer` under the panel says so, which is the standing rule for
// anything illustrative on this page.
const ANSWER_SOURCES = [
  { n: '01', text: 'a token id from POST /tokens → .id' },
  { n: '02', text: 'a saved card id from GET /customers/{id}/sources' },
];

const TOOLS = [
  { name: 'list_customers', kind: 'read' as const },
  { name: 'create_charge', kind: 'write' as const },
  { name: 'refund_charge', kind: 'write' as const },
  { name: 'get_invoice', kind: 'read' as const },
];

// Three entries chosen to show the three outcomes the watcher can reach: a
// widened contract, an additive one, and a real disagreement between the spec
// and the running service. The last is the one that earns its keep.
const CHANGES = [
  {
    when: 'today 09:41',
    op: <>POST /charges · new field <em>statement_descriptor_suffix</em></>,
    tag: 'non-breaking',
    caught: false,
    note: 'docs updated · MCP tool re-typed · 6 min later',
    reverified: true,
  },
  {
    when: '02 sep',
    op: <>GET /invoices · <em>status</em> gained <em>&quot;uncollectible&quot;</em></>,
    tag: 'non-breaking',
    caught: false,
    note: 'enum widened · agents picked it up automatically',
    reverified: false,
  },
  {
    when: '28 aug',
    op: <>DELETE /cards · returns <strong>204</strong>, spec still said <strong>200</strong></>,
    tag: 'drift caught',
    caught: true,
    note: 'corrected in docs and MCP · you were told before they were',
    reverified: false,
  },
];

export default function Home() {
  return (
    <div className="landing" id="top">

      {/* ═══════════ 01 · HERO ═══════════ */}
      <section className="hero">
        {/* The lattice sits under the steps card, never under the headline —
            copy over a scene at any opacity is copy you have to fight to read. */}
        <div className="hero-scene">
          <SceneStage scene="lattice" poster={<LatticePoster />} />
        </div>

        <div className="wrap-l hero-inner">
          <div className="hero-grid">
            <div className="hero-copy">
              <p className="kicker">For founders shipping an API</p>
              <h1 className="display hero-title">
                Make your API the
                <span className="hl">easiest one they ever integrated.</span>
              </h1>
              <p className="hero-lead">
                DocentAPI learns your API by actually running it — then answers every question your
                customers&rsquo; engineers ask, hands their agents a hosted MCP server, and keeps
                both in sync every time you ship.
              </p>

              <div className="hero-actions">
                <a className="btn primary" href="/sign-up">
                  Connect your API <Arrow />
                </a>
                <a className="btn" href="/how-it-works">
                  See what you get
                </a>
              </div>

              <p className="hero-note">
                Sign in, paste your spec and a dev key. About a minute.
                <br />
                Read-safe calls only — the key is never stored.
              </p>
            </div>

            {/* The whole commitment, visible without scrolling. This is the
                point of the page: an ad click can see both steps at once. */}
            <div className="steps-card">
              <div className="steps-head">
                <span>Two steps to live</span>
                <span className="est">~1 min</span>
              </div>

              <div className="steps-body">
                <div className="step">
                  <span className="step-n" aria-hidden="true">01</span>
                  <div className="step-body">
                    <h3>Sign in</h3>
                    <p>Google, GitHub, or email. No card.</p>
                  </div>
                </div>

                <div className="step">
                  <span className="step-n" aria-hidden="true">02</span>
                  <div className="step-body">
                    <h3>Paste your spec and a dev key</h3>
                    <p>OpenAPI, a Postman collection, or one cURL command.</p>
                    <div className="field-stack" aria-hidden="true">
                      <div className="field focus">https://api.acme.com/openapi.json</div>
                      <div className="field">sk_test_••••••••••••••••••••</div>
                    </div>
                  </div>
                </div>

                <div className="steps-after">
                  <p className="lbl">Then, without you</p>
                  <ul>
                    {AFTER.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════ 02 · PROOF ═══════════ */}
      {/* Marked placeholders, not invented logos. Every one of these must be
          filled before the page carries ad spend — see .placeholder. */}
      <section className="proof-strip" aria-label="Customers">
        <div className="wrap-l proof-inner">
          <p className="proof-label">Live on</p>
          <div className="proof-logos">
            {[1, 2, 3, 4, 5].map((slot) => (
              <span className="logo-slot" key={slot}>[LOGO]</span>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════ 03 · THE THREE ═══════════ */}
      <div className="wrap-l sec-head">
        <p className="kicker">What you get</p>
        <h2 className="display">Three things, from one paste.</h2>
      </div>

      {/* ---- 01 · it knows your API ---- */}
      <section className="wrap-l value">
        <div className="value-copy">
          <p className="value-n">01</p>
          <h3>It knows your API as well as your own team does.</h3>
          <p>
            Not because it read the spec — because it ran it. Every read-safe call executed, every
            field traced to where its value actually comes from, every answer backed by a recorded
            response.
          </p>
          <ul className="value-list">
            <li>Anyone can ask it anything — in your docs, in Slack, in their editor</li>
            <li>It knows which call produces the id the next one needs</li>
            <li>When it does not know, it says so — it never invents a field</li>
          </ul>
          <p className="outcome">
            <span>Integrations that took</span>
            <span className="placeholder">[3 WEEKS]</span>
            <span>now take</span>
            <span className="placeholder">[2 DAYS]</span>
          </p>
        </div>

        <div>
          <div className="value-panel">
            <div className="panel-head">
              <span>Your customer&rsquo;s engineer, 11:04</span>
              <span className="lo">docs · slack · editor</span>
            </div>
            <div className="panel-body qa">
              <p className="qa-q">
                <span className="who">you ›</span>
                <span>what do I put in <code>source</code> on POST /charges?</span>
              </p>

              <div className="qa-answer">
                <p>
                  <b>source</b> is <span className="origin">caller_supplied</span> — the only field
                  on this call you actually choose. It takes either:
                </p>
                <ul className="qa-sources">
                  {ANSWER_SOURCES.map((source) => (
                    <li key={source.n}>
                      <span className="n">{source.n}</span>
                      <span>{source.text}</span>
                    </li>
                  ))}
                </ul>
                <p>The other nine fields are server-generated or fixed. You do not need to send them.</p>
                <p className="qa-verified">
                  <Check />
                  Verified against a live call · 2h ago
                </p>
              </div>
            </div>
          </div>
          <p className="disclaimer">Worked example — not an answer about any real API.</p>
        </div>
      </section>

      {/* ---- 02 · the MCP server ---- */}
      <section className="wrap-l value flip">
        <div className="value-copy">
          <p className="value-n">02</p>
          <h3>A hosted MCP server, from the same paste.</h3>
          <p>
            One URL your customers drop into Claude, Cursor or Copilot — and their agents are
            calling your API. You are the vendor with an MCP server, and you built nothing.
          </p>
          <ul className="value-list">
            <li>Zero infrastructure on your side — we host it and run it</li>
            <li>Tools verified by execution, not transpiled from the spec and hoped over</li>
            <li>Every tool marked read or write, so nothing destructive fires blind</li>
          </ul>
        </div>

        <div>
          <div className="value-panel">
            <div className="panel-head">
              <span className="lo"><span className="dim">{HOST}/mcp/</span>acme</span>
              <span className="ready"><i aria-hidden="true" />ready</span>
            </div>
            <div className="panel-body">
              <div className="mcp-tools">
                {TOOLS.map((tool) => (
                  <div className="mcp-tool" key={tool.name}>
                    <span>{tool.name}</span>
                    <span className={`tag ${tool.kind}`}>{tool.kind}</span>
                  </div>
                ))}
                <p className="mcp-foot">
                  <span>+ 34 more tools · auth handled · rate-limited</span>
                  <span>0 lines of your code</span>
                </p>
              </div>
            </div>
          </div>
          <p className="disclaimer">Illustrative tool list — your API decides the real one.</p>
        </div>
      </section>

      {/* ---- 03 · it stays in sync ---- */}
      <section className="wrap-l value">
        <div className="value-copy">
          <p className="value-n">03</p>
          <h3>You ship a change. It updates itself.</h3>
          <p>
            We watch your spec and your live endpoints. The moment something moves we classify it,
            re-run the checks, and update the docs and the MCP tools together. Nothing drifts.
            Nobody gets paged.
          </p>
          <ul className="value-list">
            <li>Breaking changes flagged before your customers find them</li>
            <li>Docs and MCP tools update in the same pass — never one without the other</li>
            <li>A dated ledger of every change, so you can prove what moved and when</li>
          </ul>
        </div>

        <div>
          <div className="value-panel">
            <div className="panel-head">
              <span>Change ledger · acme</span>
              <span className="lo">watching, always</span>
            </div>
            <div className="chglog">
              {CHANGES.map((change) => (
                <div className={change.caught ? 'chg-row caught' : 'chg-row'} key={change.when}>
                  <span className="chg-when">{change.when}</span>
                  <div className="chg-what">
                    <span className="op">{change.op}</span>
                    <span className="chg-tags">
                      <span className={change.caught ? 'tag caught' : 'tag flat'}>{change.tag}</span>
                      <span className={change.reverified ? 'note reverified' : 'note'}>{change.note}</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <p className="disclaimer">Worked example — the shape of a real ledger, not one API&rsquo;s.</p>
        </div>
      </section>

      {/* ═══════════ 04 · THE TWO STEPS, IN FULL ═══════════ */}
      <section className="onboard" id="start">
        <div className="wrap-l">
          <div className="onboard-head">
            <div>
              <p className="kicker">Getting started</p>
              <h2 className="display">Two steps. No integration project.</h2>
            </div>
            <p>
              Nothing to install, no SDK to adopt, and no change to your API. You give us a spec and
              a dev key; we do the rest.
            </p>
          </div>

          <div className="onboard-grid">
            <article className="ob-card">
              <div className="ob-head">
                <span className="step-n" aria-hidden="true">01</span>
                <h3>Sign in</h3>
              </div>
              <p>Google, GitHub or email. Ten seconds, no credit card, nothing to configure.</p>
              <div className="ob-mock" aria-hidden="true">
                <div className="mock-row"><span>Continue with Google</span></div>
                <div className="mock-row"><span>Continue with email</span></div>
              </div>
            </article>

            <article className="ob-card active">
              <div className="ob-head">
                <span className="step-n" aria-hidden="true">02</span>
                <h3>Paste spec + dev key</h3>
              </div>
              <p>
                An OpenAPI URL, a Postman collection, or a single cURL command. The key runs
                read-safe calls and is never stored.
              </p>
              <div className="ob-mock" aria-hidden="true">
                <div className="field focus">https://api.acme.com/openapi.json</div>
                <div className="field">sk_test_••••••••••••••••••••</div>
              </div>
            </article>

            <article className="ob-card">
              <div className="ob-head">
                <span className="step-n" aria-hidden="true">
                  <Arrow />
                </span>
                <h3>That is the whole setup</h3>
              </div>
              <p>
                Minutes later your answers, your docs and your MCP server are live — and stay that
                way on their own.
              </p>
              <div className="ob-mock" aria-hidden="true">
                <div className="mock-row"><span>docs</span><span className="state">live</span></div>
                <div className="mock-row"><span>mcp server</span><span className="state">live</span></div>
                <div className="mock-row"><span>change watch</span><span className="state">on</span></div>
              </div>
            </article>
          </div>
        </div>
      </section>

      {/* ═══════════ 05 · CLOSING ═══════════ */}
      <section className="cta-final">
        <div className="wrap-l">
          <h2 className="display">Your API is good. Make it obvious in a day.</h2>
          <p className="lead">
            Paste a spec and a dev key. See what your customers would see — before you decide
            anything.
          </p>
          <a className="btn primary" href="/sign-up">
            Connect your API <Arrow />
          </a>
          <p className="cta-note">
            Free while your API is public · keys never stored · cancel by deleting the project
          </p>
        </div>
      </section>
    </div>
  );
}
