import ImportForm from '@/components/ImportForm';

export const metadata = {
  title: 'Import an API — DocentAPI',
  description: 'Generate a live API integration workspace and hosted MCP server in seconds.',
};

export default function AppHome() {
  return (
    <div className="app-home product-page wrap">
      <header className="app-home-head">
        <p className="eyebrow">Instant generator</p>
        <h1 className="display">Turn an API definition into a working integration.</h1>
        <p className="lead">
          Import an OpenAPI spec, Postman collection, or cURL command. DocentAPI creates an
          executable workspace for humans and a hosted MCP endpoint for agents.
        </p>
      </header>

      <div className="app-workbench">
        <ImportForm />
        <aside className="app-output" aria-label="Generated output">
          <p className="eyebrow">Every import includes</p>
          <ol>
            <li>
              <span>01</span>
              <div><strong>Integration page</strong><p>Normalized actions, parameters, auth, and examples.</p></div>
            </li>
            <li>
              <span>02</span>
              <div><strong>Live playground</strong><p>Run non-destructive calls with your own key.</p></div>
            </li>
            <li>
              <span>03</span>
              <div><strong>Hosted MCP</strong><p>Give agents the same API as safety-filtered tools.</p></div>
            </li>
          </ol>
          <p className="app-privacy">Anonymous workspaces expire after 24 hours. Credentials are never stored.</p>
          <p className="app-privacy">
            Want it verified in depth instead — every field traced, the provider&apos;s own docs
            folded in, a human loop for anything ambiguous?{' '}
            <a href="/analyze">Try deep analysis →</a>
          </p>
        </aside>
      </div>
    </div>
  );
}
