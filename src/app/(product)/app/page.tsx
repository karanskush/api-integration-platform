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
          Step two of two. Paste an OpenAPI spec, Postman collection, or cURL command — and a dev
          key if you want the checks to run against your live service. DocentAPI creates an
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
          <p className="app-privacy">
            Credentials are never stored. A dev key is used for the read-safe calls in this run and
            discarded with the request — writes are never executed.
          </p>
          <p className="app-privacy">
            Signed in, deep analysis starts automatically with your import: it crawls the
            provider&apos;s own docs, traces every field, and emails you when it&apos;s verified.
            Anonymous imports get the instant spec-only pass and a workspace that expires after 24
            hours unless claimed.
          </p>
        </aside>
      </div>
    </div>
  );
}
