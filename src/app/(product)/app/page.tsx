import { auth } from '@clerk/nextjs/server';
import ImportForm from '@/components/product/ImportForm';

export const metadata = {
  title: 'Import an API — DocentAPI',
  description: 'Generate a live API integration workspace and hosted MCP server in seconds.',
};

const clerkReady = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export default async function AppHome() {
  // Signed-in imports route through the deep-analysis pipeline automatically
  // (see ImportForm's `deep` prop); anonymous imports stay instant-only.
  const signedIn = clerkReady ? Boolean((await auth()).userId) : false;
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
        <ImportForm deep={signedIn} />
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
            This instant pass reads the spec alone. Step two — deep analysis — crawls the
            provider&apos;s own docs, traces every field, and emails you when it&apos;s verified.
            Signed in, it starts automatically with your import; anonymous imports can start it
            from the workspace they create.
          </p>
        </aside>
      </div>
    </div>
  );
}
