import ImportForm from '@/components/ImportForm';
import LandingDemo from '@/components/landing/LandingDemo';
import LandingEffects from '@/components/landing/LandingEffects';
import ScoreGauge from '@/components/landing/ScoreGauge';
import VerificationStamp from '@/components/landing/VerificationStamp';
import WaitlistForm from '@/components/landing/WaitlistForm';
import { FIELD_ORIGINS } from '@/lib/fieldMap';

// The masthead states the terms of the report before it makes any claim —
// what gets assessed, how, and how often. Each line is a fact about the
// pipeline, not a promise: read-safe is the actual probe constraint
// (src/lib/probes/run.ts), and re-issue on spec change is what ciSync and
// the reverify cron really do.
// Keyed off the real union rather than restated, so the page cannot claim a
// set of origins the engine no longer has. landingClaims.test.ts pins this.
const ORIGIN_COPY: Record<(typeof FIELD_ORIGINS)[number], { means: string; by: string }> = {
  server_generated: {
    means: 'The API produces it. Anything you send is ignored or rejected.',
    by: 'readOnly in the schema',
  },
  constant: {
    means: 'Exactly one legal value, so there is nothing to decide.',
    by: 'const in the schema',
  },
  produced_by_api: {
    means: 'Another operation returns it — and we name which one, per field.',
    by: 'Lineage, § 03',
  },
  enum_constrained: {
    means: 'Pick from a fixed list. We can show you the list.',
    by: 'enum in the schema',
  },
  caller_supplied: {
    means: 'Genuinely yours to choose. This is the only one that needs you.',
    by: 'Nothing else matched',
  },
};

const ORIGINS = FIELD_ORIGINS.map((key) => ({ key, ...ORIGIN_COPY[key] }));

const MASTHEAD = [
  { label: 'Subject', value: 'Any HTTP API — OpenAPI, Postman, or a single cURL command' },
  { label: 'Method', value: 'Read-safe operations executed against the running service' },
  { label: 'Issued', value: 'On import, and re-issued whenever the spec changes' },
];

const LAYERS = [
  {
    title: 'Integration page',
    body: 'A public, shareable page for your API — docs, examples, and a try-it playground. Every page is a landing page for your API, findable and linkable.',
  },
  {
    title: 'Live playground',
    body: 'Visitors test real calls with their own key — used for that one request, never stored, never logged. No signup, no sandbox to provision.',
  },
  {
    title: 'Hosted MCP server',
    body: 'spotcheck.dev/mcp/you — a drop-in endpoint Claude, Cursor, and Copilot call directly. Typed tools, auth handled, zero infrastructure on your side.',
  },
  {
    title: 'Agent-Ready Score',
    body: 'A 0–100 grade of how well agents can drive your API — measured by executing the tools, not reading the spec. Your number to beat.',
  },
  {
    title: 'Embeddable badge',
    body: '“Agent-Ready 87” in your README and docs — proof your API works for agents, and a live link back to your page for everyone who sees it.',
  },
  {
    title: 'Claim & verify',
    body: 'Prove you own the domain — DNS, meta tag, or email — and the page is yours. Run read-safe probes and the score turns from preview to verified.',
  },
];

const SUBSCORES = [
  { name: 'Auth clarity', value: 92, why: 'Can an agent discover and satisfy auth without a human in the loop?' },
  { name: 'Error quality', value: 78, why: 'Do failures explain themselves — or dead-end at an unlabeled 400?', warn: true },
  { name: 'Doc drift', value: 84, why: 'Does the spec match what the API really returns, field for field?' },
  { name: 'Idempotency', value: 95, why: 'Can a retried call ever double-charge? Agents retry. This matters.' },
];

// A report indexes itself. The numbers are the page's spine — they run down
// the left edge and let a reader cite a section rather than scroll for it.
function SectionMark({ n, title, note }: { n: string; title: string; note?: string }) {
  return (
    <div className="sec-mark">
      <span className="n">§&#8202;{n}</span>
      <span className="t">{title}</span>
      {note ? <span className="note">{note}</span> : null}
    </div>
  );
}

export default function Home() {
  return (
    <div className="landing report-page" id="top">
      <LandingEffects />

      {/* ============ MASTHEAD + HERO — the head of a printed form ============ */}
      <section className="landing-hero">
        <div className="landing-wrap">
          <div className="masthead">
            <div className="mh-head">
              <p className="mh-title">Field Report</p>
              <p className="mh-no">Form SC&#8209;01</p>
            </div>
            <div className="mh-body">
              <dl className="mh-fields">
                {MASTHEAD.map((field) => (
                  <div className="mh-field" key={field.label}>
                    <dt>{field.label}</dt>
                    <dd>{field.value}</dd>
                  </div>
                ))}
              </dl>
              <VerificationStamp className="mh-stamp" />
            </div>
          </div>
        </div>

        <div className="landing-wrap hero-content">
          <div className="hero-copy">
            <h1 className="display hero-title">
              <span className="hl"><span>A spec is a claim.</span></span>
              <span className="hl"><span>We go and check.</span></span>
            </h1>
            <p className="hero-lead">
              Paste an OpenAPI spec, a Postman collection, or one cURL command. Spotcheck turns it
              into typed tools, works out which call produces the id the next one needs, runs the
              read-safe operations against your live service — and writes down what actually came
              back, with the evidence attached.
            </p>
            <p className="hero-lead second">
              Your readers get a working integration page. Their agents get a hosted MCP server.
              Both are built from what the API <em>does</em>, not what the document says it does.
            </p>
            <div className="hero-sub">
              <a className="text-link" href="#method">Read the method <span aria-hidden="true">↓</span></a>
              <a className="text-link steel" href="/app">Open the full app <span aria-hidden="true">→</span></a>
            </div>
          </div>
          <div className="hero-import">
            <ImportForm />
            <p className="hero-import-note">No signup · keys never stored · 24-hour anonymous workspace</p>
          </div>
        </div>
      </section>

      {/* ============ METHOD — the replay ============ */}
      <section className="section demo-section" id="method">
        <div className="landing-wrap">
          <SectionMark n="01" title="Method" note="60 seconds, one paste" />
          <div className="section-head reveal">
            <h2 className="display">Watch a spec become an agent surface.</h2>
            <p className="lead">
              Spotcheck parses the document, normalises every operation into a typed tool, resolves
              the references away, renders the playground, and mints the hosted MCP endpoint. The
              panel below is a replay of that pipeline running against a real spec.
            </p>
          </div>
          <div className="reveal">
            <LandingDemo />
            {/* Say what it is. The replay is scripted, and the live importer
                is thirty pixels up the page — claiming otherwise would be
                the exact species of unearned confidence this page is about. */}
            <p className="fig-cap">
              <span className="n">Fig. 1</span>
              <span>Import replay — scripted. The importer above is live.</span>
            </p>
          </div>
        </div>
      </section>

      {/* ============ PROVENANCE — where every value comes from ============ */}
      <section className="section band prov-section" id="provenance">
        <div className="landing-wrap">
          <SectionMark n="02" title="Provenance" note={`${FIELD_ORIGINS.length} origins`} />
          <div className="section-head reveal">
            <h2 className="display">Every field says where its value is supposed to come from.</h2>
            <p className="lead">
              The single most expensive question when integrating an API is &ldquo;what do I put
              here?&rdquo; — and a spec answers it for almost nothing. Spotcheck classifies every
              writable field into one of {FIELD_ORIGINS.length} origins, and records how it knows.
            </p>
          </div>

          <table className="spec-table reveal">
            <caption className="sr-only">The five field origins Spotcheck classifies into</caption>
            <thead>
              <tr>
                <th scope="col">Origin</th>
                <th scope="col">What it means for a caller</th>
                <th scope="col">Decided by</th>
              </tr>
            </thead>
            <tbody>
              {ORIGINS.map((origin) => (
                <tr key={origin.key}>
                  <th scope="row"><code>{origin.key}</code></th>
                  <td>{origin.means}</td>
                  <td className="by">{origin.by}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="prov-note reveal">
            <p>
              Each annotation also carries <em>how confident we are entitled to be</em>. A value the
              owner confirmed is marked <code>human</code>; one inferred from a quote in their own
              documentation is <code>assumed</code>, and carries that quote; one we worked out from
              structure alone is <code>heuristic</code>. Only a person can set the human mark — a
              database constraint makes anything else unrepresentable, not merely discouraged.
            </p>
          </div>
        </div>
      </section>

      {/* ============ STATEMENT — the question + two surfaces ============ */}
      <section className="section statement">
        <div className="landing-wrap">
          <h2 className="display reveal">
            Every API company is getting the same question: &ldquo;Do you have an MCP server?&rdquo;
          </h2>
          <p className="lead reveal">
            Humans read docs. Agents need tools. Most APIs can answer for only one of them — and the
            agent traffic is already arriving. Spotcheck answers for both, from a single import.
          </p>
          <div className="surfaces">
            <article className="surface reveal">
              <p className="who">For humans</p>
              <h3>A live integration page</h3>
              <p>
                A hosted, shareable page for your API — real docs, working examples, and a playground
                where visitors test calls with their own key. Claimable by you, linkable by everyone.
              </p>
              <ul>
                <li>Try-it playground — keys never stored, never logged</li>
                <li>Generated snippets — cURL, TypeScript, Python</li>
                <li>Always current — regenerated on every spec change</li>
              </ul>
            </article>
            <article className="surface agents reveal">
              <p className="who">For agents</p>
              <h3>A hosted MCP server</h3>
              <p>
                The same import, exposed over the Model Context Protocol. Claude, Cursor, and Copilot
                call it directly — typed tools, auth handled, every call checked against how your API
                really behaves.
              </p>
              <ul>
                <li>Drop-in endpoint — zero infra on your side</li>
                <li>Verified tools, not spec echoes</li>
                <li>Every tool annotated read or write — unsafe ops flagged</li>
              </ul>
            </article>
          </div>
        </div>
      </section>

      {/* ============ WHAT YOU GET — six-layer ledger ============ */}
      <section className="section how-section" id="how">
        <div className="landing-wrap how-grid">
          <div className="how-head reveal">
            <p className="eyebrow">One import</p>
            <h2 className="display">One import. Everything an agent needs.</h2>
            <p className="lead">
              Paste a spec once. Spotcheck fans it out into six surfaces — generated together,
              verified together, and kept in sync with every change you ship.
            </p>
          </div>
          <div className="how-ledger reveal" role="list">
            {LAYERS.map((layer, index) => (
              <article className="layer-row" role="listitem" key={layer.title}>
                <span className="n" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <h3>{layer.title}</h3>
                  <p>{layer.body}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ============ AGENT-READY SCORE ============ */}
      <section className="section score-section" id="score">
        <div className="score-ruler cal-ruler" aria-hidden="true">
          <span>00</span><span style={{ left: '25%' }}>25</span><span style={{ left: '50%' }}>50</span>
          <span style={{ left: '75%' }}>75</span><span style={{ left: '100%' }}>100</span>
        </div>
        <div className="landing-wrap score-grid">
          <div className="score-copy reveal">
            <p className="eyebrow">Agent-Ready Score</p>
            <h2 className="display">Lighthouse gave the web a number. This is yours.</h2>
            <p className="lead">
              Every import gets scored 0–100 on how well an agent can actually drive the API — not by
              reading the spec, but by executing the tools and grading what comes back.
            </p>
            <div className="subscores reveal">
              {SUBSCORES.map((subscore) => (
                <div className={`subscore${subscore.warn ? ' warn' : ''}`} key={subscore.name}>
                  <div className="ss-top">
                    <span className="ss-name">{subscore.name}</span>
                    <span className="ss-val">{subscore.value}</span>
                  </div>
                  <div className="ss-bar"><i style={{ '--w': subscore.value } as React.CSSProperties} /></div>
                {subscore.warn && <p className="ss-flag">! needs work</p>}
                  <p className="ss-why">{subscore.why}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="score-stage reveal">
            <ScoreGauge />
            <div className="g-meta">spotcheck.dev/your-api · <span className="ok-word">verified</span> today</div>
            <div className="g-badge">
              <span className="gb-chip"><span className="gb-dot" aria-hidden="true" />Agent-Ready 87</span>
              <span className="gb-hint"><span aria-hidden="true">←</span> this badge, in your README</span>
            </div>
          </div>
        </div>
      </section>

      {/* ============ PROOF — verified, not transpiled ============ */}
      <section className="section proof">
        <div className="landing-wrap">
          <div className="section-head reveal">
            <p className="eyebrow">Verified, not transpiled</p>
            <h2 className="display">Anyone can turn OpenAPI into MCP. We prove the tools actually work.</h2>
            <p className="lead">
              Transpilers echo the spec and hope. Spotcheck executes the tools, catches where the docs
              lie, patches the tool definitions — and re-verifies so drift never reaches an agent.
            </p>
          </div>

          <div className="proof-stage">
            <div className="terminal reveal">
              <div className="term-bar">
                <span className="term-title">agent ↔ spotcheck.dev/mcp/acme</span>
                <span className="term-live"><i aria-hidden="true" />replay</span>
              </div>
              <div className="term-body">
                <div className="term-line"><span className="who q">agent</span><span className="caret-q">›</span><span className="type">create a $120 transfer for cust_81</span></div>
                <div className="term-line"><span className="who r">spotcheck</span> tools/call → create_transfer · <span className="ret">verified 2h ago</span></div>
                <div className="term-line step"><span className="n">01</span> <span className="m">create_user</span> <span className="ret">→ user_id</span></div>
                <div className="term-line step"><span className="n">02</span> <span className="m">create_account</span> <span className="x">×2</span> <span className="ret">→ account_id</span> <span className="note">· requires user_id</span></div>
                <div className="term-line step"><span className="n">03</span> <span className="m">create_transfer</span> <span className="ret">→ transfer_id</span> <span className="note">· Idempotency-Key attached</span></div>
                <div className="term-line warn">! drift caught · status &ldquo;pending_review&rdquo; not in spec — tool schema patched automatically</div>
                <div className="term-line ok"><span className="who b">agent</span><span className="caret-q">›</span> <span className="okmark">✓</span> <span className="type">200 — shipped on the first pass</span><span className="caret" aria-hidden="true">▋</span></div>
              </div>
            </div>

            <aside className="proof-aside reveal">
              <p className="eyebrow">How a score is earned</p>
              <ul className="pa-list">
                <li><b>Read-safe probes.</b> Live calls against real endpoints — writes are graded statically, never executed.</li>
                <li><b>Evidence-linked.</b> Every point traces back to a recorded fact, not a heuristic guess.</li>
                <li><b>Owner-verified.</b> Claim your domain, run verification — green is earned, never assumed.</li>
              </ul>
            </aside>
          </div>

          <div className="outcomes">
            <div className="outcome reveal">
              <div className="o-fig">Minutes<span>not sprints</span></div>
              <p>From spec to a live, verified agent surface in the time it takes to make coffee. Your customers integrate the same afternoon they find you.</p>
            </div>
            <div className="outcome reveal">
              <div className="o-fig">&ldquo;Yes.&rdquo;</div>
              <p>Your new answer to &ldquo;do you have an MCP server?&rdquo; — with a URL to prove it, before your competitor finishes scoping theirs.</p>
            </div>
            <div className="outcome reveal">
              <div className="o-fig">87<span>your number here</span></div>
              <p>The score that proves it works. Badge it, share it, watch it climb every time you fix what the probes found.</p>
            </div>
          </div>

          <p className="proof-foot reveal">
            Stainless generates SDKs. Mintlify renders docs. Speakeasy transpiles MCP.{' '}
            <em>Spotcheck verifies the surface agents actually touch — and scores it.</em>
          </p>
        </div>
      </section>

      {/* ============ DISTRIBUTION ============ */}
      <section className="section dist-section">
        <div className="landing-wrap">
          <div className="section-head reveal">
            <p className="eyebrow">Distribution</p>
            <h2 className="display">Built to spread.</h2>
            <p className="lead">
              Every public page, badge, and claim link is a door back to your API. Adoption compounds
              while you sleep.
            </p>
          </div>
          <div className="dist-grid">
            <article className="dist-card reveal">
              <h3>Claimable public pages</h3>
              <p>Every public API gets a live page — even before its owner shows up. Found yours? Prove you own the domain and make it official.</p>
              <div className="code-snippet"><span className="cs-dim">spotcheck.dev/</span>stripe <span className="cs-claim">· claim this page</span></div>
            </article>
            <article className="dist-card reveal">
              <h3>The badge</h3>
              <p>Drop it in your README and docs. It renders your live score — and links every reader back to your integration page.</p>
              <div className="code-snippet">&lt;img src=&quot;<span className="cs-dim">https://</span>spotcheck.dev/badge/you&quot; /&gt;</div>
            </article>
            <article className="dist-card reveal">
              <h3>BYOK playground</h3>
              <p>Visitors try your API with their own key. It&rsquo;s used for the one call and discarded — never stored, never logged, zero sales calls.</p>
              <div className="code-snippet">key used per call <span className="cs-dim">· never stored, never logged</span></div>
            </article>
            <article className="dist-card reveal">
              <h3>Hosted MCP for agents</h3>
              <p>Your users paste one URL into Claude, Cursor, or Copilot and their agents are calling your API — metered, rate-limited, every tool annotated read or write.</p>
              <div className="code-snippet"><span className="cs-dim">spotcheck.dev/mcp/</span>you <span className="cs-ok">· ready</span></div>
            </article>
          </div>
        </div>
      </section>

      {/* ============ PRICING BAND ============ */}
      <section className="section pricing-band">
        <div className="landing-wrap band-inner reveal">
          <div>
            <p className="eyebrow">Pricing</p>
            <h2 className="display">Free for public APIs. Forever.</h2>
            <p className="lead">
              Public pages are our distribution and your adoption. Plans cover private APIs, teams,
              and business-critical reliability.
            </p>
          </div>
          <a className="btn" href="/pricing">See plans <span aria-hidden="true">→</span></a>
        </div>
      </section>

      {/* ============ CTA ============ */}
      <section className="section cta" id="start">
        <div className="landing-wrap">
          <h2 className="display reveal">Put your API in front of agents today.</h2>
          <p className="lead cta-lead reveal">
            The importer at the top is live — no signup, no credit card. Leave your email and we&rsquo;ll
            send your claim link plus each verification feature as it ships.
          </p>
          <div className="reveal">
            <WaitlistForm />
          </div>
          <p className="cta-note">Free for public APIs · anonymous workspaces expire in 24 hours unless claimed</p>
        </div>
      </section>
    </div>
  );
}
