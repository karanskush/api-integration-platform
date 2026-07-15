import { redirect } from 'next/navigation';
import ImportForm from '@/components/ImportForm';

export default function Home() {
  // Single public front door: the landing site owns "/".
  const site = (process.env.NEXT_PUBLIC_SITE_ORIGIN ?? '').replace(/\/$/, '');
  if (site) redirect(site);

  // Local-dev fallback: a styled import hero.
  return (
    <div className="home">
      <div className="home-head">
        <span className="eyebrow">instant generator</span>
        <h1 className="display">Your API, agent-ready in 60 seconds.</h1>
        <p className="lead">
          Paste an OpenAPI spec, Postman collection, or cURL command. Get a live integration page,
          a bring-your-own-key playground, and a hosted MCP server — no signup. Everything expires
          in 24 hours.
        </p>
      </div>
      <ImportForm />
    </div>
  );
}
