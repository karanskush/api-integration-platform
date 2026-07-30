import ImportForm from '@/components/product/ImportForm';
import QuizSpecimen from '@/components/landing/QuizSpecimen';
import SceneStage from '@/components/landing/SceneStage';
import SmoothScroll from '@/components/landing/SmoothScroll';
import WaitlistForm from '@/components/landing/WaitlistForm';
import {
  ConstellationPoster,
  DriftPoster,
  LatticePoster,
  LineagePoster,
  ScorePoster,
} from '@/components/landing/posters';
import { ARCHETYPE_RANKS, type Archetype } from '@/lib/clarify';
import { FIELD_ORIGINS } from '@/lib/fieldMap';
import { appHost } from '@/lib/origin';

// Every hostname this page shows is the one it is actually served from.
// Hardcoding `docentapi.dev` meant the page promised URLs that did not
// resolve — the single thing on a page about not overclaiming that overclaimed.
// Resolved once here: PUBLIC_APP_ORIGIN is fixed for a deployment's lifetime.
const HOST = appHost();

// Keyed off the real union rather than restated, so the page cannot claim a
// set of origins the engine no longer has. Adding an origin to FIELD_ORIGINS
// without describing it here fails the build, which is the point.
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
    by: 'Lineage',
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

// Same discipline as ORIGIN_COPY: Record<Archetype, …> means adding a question
// shape without describing it here fails the build.
const ARCHETYPE_COPY: Record<Archetype, { title: string; blurb: string }> = {
  identifier_ownership: {
    title: 'Identifier ownership',
    blurb: 'On a create, does the server assign this id or honour the one I send?',
  },
  producer_disambiguation: {
    title: 'Producer disambiguation',
    blurb: 'Lineage found several plausible sources. Which should a caller actually use?',
  },
  description_contradicts_operation: {
    title: 'Description contradicts operation',
    blurb: 'The field says “delete”, but this is a read. Which one is stale?',
  },
  scope_of_effect: {
    title: 'Scope of effect',
    blurb: 'Does this PUT replace the record, or merge? Do omitted fields get wiped?',
  },
  format_or_shape: {
    title: 'Format or shape',
    blurb: 'A bare string named expiresAt with no declared format. Which format is it?',
  },
  optionality_in_practice: {
    title: 'Optionality in practice',
    blurb: 'Optional in the schema — but what actually happens if it is omitted?',
  },
  undocumented_code_semantics: {
    title: 'Undocumented code semantics',
    blurb: 'A status integer with no enum. What do 1 and 2 mean?',
  },
  origin_unknown: {
    title: 'Origin unknown',
    blurb: 'The fallback — still a closed choice over the five origins, never a blank box.',
  },
};

const ARCHETYPES = (Object.keys(ARCHETYPE_COPY) as Archetype[])
  .sort((a, b) => ARCHETYPE_RANKS[a] - ARCHETYPE_RANKS[b])
  .map((key) => ({ key, ...ARCHETYPE_COPY[key] }));

const ARCHETYPE_COUNT = ARCHETYPES.length;

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
    body: `${HOST}/mcp/you — a drop-in endpoint Claude, Cursor, and Copilot call directly. Typed tools, auth handled, zero infrastructure on your side.`,
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

// A worked example, and labelled as one wherever it appears. `basis` is the
// honest part: only errorQuality and docDrift issue live requests
// (src/lib/probes/). authClarity grades the declared scheme and idempotency
// greps parameter names, so claiming all four are measured live would be
// false. The ScoreInstrument scene encodes the same split in colour.
const SUBSCORES = [
  {
    name: 'Error quality',
    value: 78,
    live: true,
    basis: 'Live — a read-safe call is deliberately malformed',
    why: 'Do failures explain themselves, or dead-end at an unlabelled 400?',
    warn: true,
  },
  {
    name: 'Doc drift',
    value: 84,
    live: true,
    basis: 'Live — real responses compared against the documented shape',
    why: 'Do the top-level keys and types match what the spec promised?',
  },
  {
    name: 'Auth clarity',
    value: 92,
    live: false,
    basis: 'Static — graded from the declared scheme',
    why: 'Can an agent discover and satisfy auth without a human in the loop?',
  },
  {
    name: 'Idempotency',
    value: 95,
    live: false,
    basis: 'Static — whether a retry key is offered at all',
    why: 'Agents retry. Does the API give them a safe way to?',
  },
];

const DISTRIBUTION = [
  {
    title: 'Claimable public pages',
    body: 'Every public API gets a live page — even before its owner shows up. Found yours? Prove you own the domain and make it official.',
    snippet: (
      <>
        <span className="cs-dim">{HOST}/</span>stripe <span className="cs-accent">· claim this page</span>
      </>
    ),
  },
  {
    title: 'The badge',
    body: 'Drop it in your README and docs. It renders your live score — and links every reader back to your integration page.',
    snippet: (
      <>
        &lt;img src=&quot;<span className="cs-dim">https://</span>{HOST}/badge/you&quot; /&gt;
      </>
    ),
  },
  {
    title: 'BYOK playground',
    body: 'Visitors try your API with their own key. It’s used for the one call and discarded — never stored, never logged, zero sales calls.',
    snippet: (
      <>
        key used per call <span className="cs-dim">· never stored, never logged</span>
      </>
    ),
  },
  {
    title: 'Hosted MCP for agents',
    body: 'Your users paste one URL into Claude, Cursor, or Copilot and their agents are calling your API — metered, rate-limited, every tool annotated read or write.',
    snippet: (
      <>
        <span className="cs-dim">{HOST}/mcp/</span>you <span className="cs-ok">· ready</span>
      </>
    ),
  },
];

/** Chapter number + title, running down the left edge of each chapter. */
function ChapterMark({ n, title }: { n: string; title: string }) {
  return (
    <p className="ch-mark">
      <span className="n">{n}</span>
      <span className="t">{title}</span>
    </p>
  );
}

export default function Home() {
  return (
    <div className="landing" id="top">
      <SmoothScroll />

      {/* ═══════════ 01 · HERO ═══════════ */}
      <section className="hero">
        <div className="hero-scene">
          <SceneStage scene="lattice" poster={<LatticePoster />} />
        </div>

        <div className="wrap-l hero-inner">
          <p className="kicker">Behavior-verified API integration</p>
          <h1 className="display hero-title">
            A spec is a claim.
            <span className="hl">We go and check.</span>
          </h1>
          <p className="hero-lead">
            Paste an OpenAPI spec, a Postman collection, or one cURL command. DocentAPI turns it
            into typed tools, works out which call produces the id the next one needs, runs the
            read-safe operations against your live service — and writes down what actually came
            back, with the evidence attached.
          </p>

          <div className="hero-import">
            <ImportForm />
            <p className="hero-note">No signup · keys never stored · 24-hour anonymous workspace</p>
          </div>

          <dl className="hero-facts">
            <div>
              <dt>Subject</dt>
              <dd>Any HTTP API — OpenAPI, Postman, or one cURL command</dd>
            </div>
            <div>
              <dt>Method</dt>
              <dd>Read-safe operations executed against the running service</dd>
            </div>
            <div>
              <dt>Issued</dt>
              <dd>On import, and re-issued whenever the spec changes</dd>
            </div>
          </dl>
        </div>

        <a className="scroll-cue" href="#surfaces" aria-label="Scroll to the next chapter">
          <span>scroll</span>
          <i aria-hidden="true" />
        </a>
      </section>

      {/* ═══════════ 02 · TWO READERS ═══════════ */}
      <section className="chapter" id="surfaces">
        <div className="chapter-scene">
          <div className="scene-pin">
            <SceneStage scene="constellation" poster={<ConstellationPoster />} />
          </div>
        </div>
        <div className="chapter-copy">
          <ChapterMark n="02" title="Surfaces" />
          <h2 className="display">
            Every API company is getting the same question: “Do you have an MCP server?”
          </h2>
          <p className="lead">
            Humans read docs. Agents need tools. Most APIs can answer for only one of them — and the
            agent traffic is already arriving. DocentAPI answers for both, from a single import.
          </p>

          <div className="surfaces">
            <article className="surface">
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
            <article className="surface agents">
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

      {/* ═══════════ 03 · LINEAGE ═══════════ */}
      <section className="chapter" id="lineage">
        <div className="chapter-scene">
          <div className="scene-pin">
            <SceneStage scene="lineage" poster={<LineagePoster />} />
          </div>
        </div>
        <div className="chapter-copy">
          <ChapterMark n="03" title="Lineage" />
          <h2 className="display">Which call produces the id the next call needs.</h2>
          <p className="lead">
            An agent that invents an identifier fails, retries, and fails again. DocentAPI reads
            every operation’s output against every other operation’s input and works out what feeds
            what — weighing eleven signals, from a shared schema title down to a type mismatch that
            argues against the link.
          </p>

          <div className="claims">
            <article className="claim">
              <p className="claim-fig tnum">≥ 0.95</p>
              <h3>Precision, gate-enforced</h3>
              <p>
                Measured against four hand-labelled corpora built to the structural shapes that
                break this — RPC paths with no resource hierarchy, pagination params, five
                resources all exposing a bare <code>id</code>. The build fails below the gate.
              </p>
            </article>
            <article className="claim">
              <p className="claim-fig">Silence</p>
              <h3>The answer when we don’t know</h3>
              <p>
                Recall is measured and printed, never asserted. Asserting on it would pressure the
                engine toward guessing, which is the one failure this is built to avoid. A
                low-confidence edge is withheld, not shown with a hedge.
              </p>
            </article>
            <article className="claim">
              <p className="claim-fig">Every edge</p>
              <h3>Carries its reasoning</h3>
              <p>
                No link is asserted without the signals that produced it. A pet’s id and a
                category’s id are both bare integers named <code>id</code>; resolving which is
                which is most of the work, and the reasoning is published with the answer.
              </p>
            </article>
          </div>
        </div>
      </section>

      {/* ═══════════ 04 · THE TRUTH LAYER ═══════════ */}
      <section className="chapter solo band" id="truth">
        <div className="chapter-copy wide">
          <ChapterMark n="04" title="The truth layer" />
          <h2 className="display">Every field says where its value is supposed to come from.</h2>
          <p className="lead">
            The single most expensive question when integrating an API is “what do I put here?” —
            and a spec answers it for almost nothing. DocentAPI classifies every writable field into
            one of {FIELD_ORIGINS.length} origins, and records how it knows.
          </p>

          <table className="spec-table">
            <caption className="sr-only">The five field origins DocentAPI classifies into</caption>
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

          <div className="pull">
            <p>
              Each annotation also carries <em>how confident we are entitled to be</em>. A value the
              owner confirmed is marked <code>human</code>; one inferred from a quote in their own
              documentation is <code>assumed</code>, and carries that quote; one we worked out from
              structure alone is <code>heuristic</code>. Only a person can set the human mark — a
              database constraint makes anything else unrepresentable, not merely discouraged.
            </p>
          </div>

          {/* ---- movement two: the questions only an owner can answer ---- */}
          <div className="movement">
            <h3 className="display sub">Some things a document genuinely cannot say.</h3>
            <p className="lead">
              Whether the server honours the id you send. Whether a PUT replaces the record or
              merges into it. What <code>userStatus: 2</code> means. Nobody can derive these — so
              we ask you, once, and we never ask with a blank box.
            </p>

            <div className="clar-grid">
              <div>
                <p className="clar-lead">
                  Every question is one of {ARCHETYPE_COUNT} shapes, and each shape’s answers are
                  enumerated from the field itself — its type, its enum, its position in the path,
                  what lineage already found. The options are not generated. They are what the
                  structure allows.
                </p>
                <ol className="arch-list">
                  {ARCHETYPES.map((a) => (
                    <li key={a.key}>
                      <span className="a-n tnum">{String(ARCHETYPE_RANKS[a.key]).padStart(2, '0')}</span>
                      <span className="a-body">
                        <b>{a.title}</b>
                        <span>{a.blurb}</span>
                      </span>
                    </li>
                  ))}
                </ol>
                <p className="foot">
                  Ordered easiest first, because someone who answers three quickly keeps going. One
                  answer applies to every operation the field appears on, and skipping is a real
                  answer — it publishes an honest <code>unresolved</code> rather than a guess.
                </p>
              </div>
              <div className="clar-stage">
                <QuizSpecimen />
              </div>
            </div>
          </div>

        </div>
      </section>

      {/* ═══════════ 05 · VERIFIED, NOT TRANSPILED ═══════════ */}
      <section className="chapter" id="verify">
        <div className="chapter-scene">
          <div className="scene-pin">
            <SceneStage scene="drift" poster={<DriftPoster />} />
          </div>
        </div>
        <div className="chapter-copy">
          <ChapterMark n="05" title="Verification" />
          <h2 className="display">Anyone can turn OpenAPI into MCP. We prove the tools work.</h2>
          <p className="lead">
            Transpilers echo the spec and hope. DocentAPI executes the tools, catches where the docs
            lie, patches the tool definitions — and re-verifies so drift never reaches an agent.
          </p>

          <div className="terminal">
            <div className="term-bar">
              <span className="term-title">agent ↔ {HOST}/mcp/acme</span>
              <span className="term-live"><i aria-hidden="true" />replay</span>
            </div>
            <div className="term-body">
              <div className="term-line"><span className="who q">agent</span><span className="caret-q">›</span><span className="type">create a $120 transfer for cust_81</span></div>
              <div className="term-line"><span className="who r">docentapi</span> tools/call → create_transfer · <span className="ret">verified 2h ago</span></div>
              <div className="term-line step"><span className="n">01</span> <span className="m">create_user</span> <span className="ret">→ user_id</span></div>
              <div className="term-line step"><span className="n">02</span> <span className="m">create_account</span> <span className="x">×2</span> <span className="ret">→ account_id</span> <span className="note">· requires user_id</span></div>
              <div className="term-line step"><span className="n">03</span> <span className="m">create_transfer</span> <span className="ret">→ transfer_id</span> <span className="note">· Idempotency-Key attached</span></div>
              <div className="term-line warn">! drift caught · status “pending_review” not in spec — tool schema patched automatically</div>
              <div className="term-line ok"><span className="who b">agent</span><span className="caret-q">›</span> <span className="okmark">✓</span> <span className="type">200 — shipped on the first pass</span><span className="caret" aria-hidden="true">▋</span></div>
            </div>
          </div>
          <p className="disclaimer">Session replay — scripted from a real drift finding.</p>

          <ul className="pa-list">
            <li><b>Read-safe probes.</b> Live calls against real endpoints — writes are graded statically, never executed.</li>
            <li><b>Evidence-linked.</b> Every point traces back to a recorded fact, not a heuristic guess.</li>
            <li><b>Owner-verified.</b> Claim your domain, run verification — the mark is earned, never assumed.</li>
          </ul>

          <p className="versus">
            Stainless generates SDKs. Mintlify renders docs. Speakeasy transpiles MCP.{' '}
            <em>DocentAPI verifies the surface agents actually touch — and scores it.</em>
          </p>
        </div>
      </section>

      {/* ═══════════ 06 · THE SCORE ═══════════ */}
      <section className="chapter" id="score">
        <div className="chapter-scene">
          <div className="scene-pin">
            <SceneStage scene="score" poster={<ScorePoster />} />
            <p className="disclaimer centred">Worked example — not a measurement of any API.</p>
          </div>
        </div>
        <div className="chapter-copy">
          <ChapterMark n="06" title="Score" />
          <h2 className="display">Lighthouse gave the web a number. This is yours.</h2>
          <p className="lead">
            A 0–100 grade of how well an agent can drive your API. Two of the four sub-scores are
            earned by making real calls against the running service; two are graded from the
            document. We label which is which, on the page and in the MCP tool that explains it.
          </p>

          <div className="subscores">
            {SUBSCORES.map((subscore) => (
              <div className={`subscore${subscore.warn ? ' warn' : ''}`} key={subscore.name}>
                <div className="ss-top">
                  <span className="ss-name">{subscore.name}</span>
                  <span className="ss-val tnum">{subscore.value}</span>
                </div>
                <div className="ss-bar"><i style={{ '--w': subscore.value } as React.CSSProperties} /></div>
                <p className={`ss-basis${subscore.live ? ' live' : ''}`}>{subscore.basis}</p>
                <p className="ss-why">{subscore.why}</p>
              </div>
            ))}
          </div>

          <p className="bands">
            <span>Bands</span> 90+ excellent · 75+ good · 55+ mixed · 35+ weak · below that, the
            spec alone is not enough to integrate reliably.
          </p>

          <div className="badge-row">
            <span className="gb-chip"><span className="gb-dot" aria-hidden="true" />Agent-Ready 87</span>
            <span className="gb-hint">this badge, in your README</span>
          </div>
        </div>
      </section>

      {/* ═══════════ 07 · SHIP IT ═══════════ */}
      <section className="chapter solo" id="how">
        <div className="chapter-copy wide">
          <ChapterMark n="07" title="Deliverables" />
          <h2 className="display">One import. Everything an agent needs.</h2>
          <p className="lead">
            Paste a spec once. DocentAPI fans it out into {LAYERS.length} surfaces — generated
            together, verified together, and kept in sync with every change you ship.
          </p>

          <div className="ledger" role="list">
            {LAYERS.map((layer, index) => (
              <article className="layer-row" role="listitem" key={layer.title}>
                <span className="n tnum" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <h3>{layer.title}</h3>
                  <p>{layer.body}</p>
                </div>
              </article>
            ))}
          </div>

          <div className="movement">
            <h3 className="display sub">Built to spread.</h3>
            <p className="lead">
              Every public page, badge, and claim link is a door back to your API. Adoption
              compounds while you sleep.
            </p>
            <div className="dist-grid">
              {DISTRIBUTION.map((card) => (
                <article className="dist-card" key={card.title}>
                  <h4>{card.title}</h4>
                  <p>{card.body}</p>
                  <div className="code-snippet">{card.snippet}</div>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════ PRICING + CTA ═══════════ */}
      <section className="pricing-band">
        <div className="wrap-l band-inner">
          <div>
            <p className="kicker">Pricing</p>
            <h2 className="display">Free for public APIs. Forever.</h2>
            <p className="lead">
              Public pages are our distribution and your adoption. Plans cover private APIs, teams,
              and business-critical reliability.
            </p>
          </div>
          <a className="btn" href="/pricing">See plans <span aria-hidden="true">→</span></a>
        </div>
      </section>

      <section className="cta" id="waitlist">
        <div className="wrap-l">
          <h2 className="display">Put your API in front of agents today.</h2>
          <p className="lead cta-lead">
            The importer at the top is live — no signup, no credit card. Leave your email and we’ll
            send your claim link plus each verification feature as it ships.
          </p>
          <WaitlistForm />
          <p className="cta-note">
            Free for public APIs · anonymous workspaces expire in 24 hours unless claimed
          </p>
        </div>
      </section>
    </div>
  );
}
