export default function Home() {
  return (
    <div className="landing">
      <section className="landing-hero">
        <div className="hero-grid" aria-hidden="true" />
        <div className="hero-signal" aria-hidden="true">
          <span className="signal-line signal-line-one" />
          <span className="signal-line signal-line-two" />
          <span className="signal-node signal-node-one" />
          <span className="signal-node signal-node-two" />
          <span className="signal-node signal-node-three" />
        </div>
        <div className="landing-wrap hero-content">
          <p className="eyebrow">Behavior-verified API integration</p>
          <h1 className="hero-brand">Spotcheck</h1>
          <p className="hero-offer">Your API, agent-ready in 60 seconds.</p>
          <p className="hero-lead">
            Turn an OpenAPI spec, Postman collection, or cURL command into a live integration page,
            a bring-your-own-key playground, and a hosted MCP server.
          </p>
          <div className="hero-actions">
            <a className="btn primary" href="/app">
              Open the app <span aria-hidden="true">→</span>
            </a>
            <a className="btn" href="#demo">
              Watch the output
            </a>
          </div>
          <div className="hero-proof" aria-label="Import guarantees">
            <span>No signup</span>
            <span>Credentials never stored</span>
            <span>24-hour private workspace</span>
          </div>
        </div>
      </section>

      <section className="landing-intro" id="demo">
        <div className="landing-wrap intro-row">
          <p className="eyebrow">One import. Two consumers.</p>
          <p className="intro-copy">
            Humans get an executable integration workspace. Agents get the same API as callable,
            safety-filtered tools.
          </p>
          <a href="#how" className="text-link">
            See the output <span aria-hidden="true">↓</span>
          </a>
        </div>
      </section>
    </div>
  );
}
