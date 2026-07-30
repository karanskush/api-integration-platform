import type { ImportRecord } from '@/lib/ir';

const GUIDE: Record<string, (rec: ImportRecord) => { title: string; how: string }> = {
  none: () => ({
    title: 'No authentication detected',
    how: 'Requests run without credentials. If the API actually requires a key, snippets and the playground still let you supply one.',
  }),
  apiKey: (rec) => ({
    title: 'API key',
    how: rec.authIn
      ? `Send your key in the ${rec.authIn.in === 'header' ? 'request header' : 'query parameter'} \`${rec.authIn.name}\`. In the playground and MCP, paste the key value only — placement is handled for you.`
      : 'Send your API key with each request. Paste the key value in the playground; placement is handled for you.',
  }),
  bearer: () => ({
    title: 'Bearer token',
    how: 'Send `Authorization: Bearer <token>`. Paste the token (without the "Bearer " prefix) in the playground or your MCP client config.',
  }),
  basic: () => ({
    title: 'HTTP Basic',
    how: 'Send `Authorization: Basic <base64(user:password)>`. Paste `user:password` in the playground — encoding is handled for you.',
  }),
  oauth2: () => ({
    title: 'OAuth 2.0',
    how: 'This API uses OAuth 2.0. Obtain an access token via the provider’s flow, then paste it as a bearer token — requests send `Authorization: Bearer <token>`.',
  }),
};

export default function AuthGuide({ record }: { record: ImportRecord }) {
  const { title, how } = (GUIDE[record.auth] ?? GUIDE.none)(record);
  return (
    <section className="panel" style={{ padding: 20 }}>
      <h2 style={{ fontSize: 15, marginBottom: 6 }}>
        Authentication <span className="chip" style={{ marginLeft: 8 }}>{record.auth}</span>
      </h2>
      <p style={{ color: 'var(--fg-dim)', fontSize: 13.5 }}>
        <strong style={{ color: 'var(--fg)' }}>{title}.</strong>{' '}
        {how.split('`').map((part, i) => (i % 2 ? <code key={i} style={{ color: 'var(--accent)' }}>{part}</code> : part))}
      </p>
      <p style={{ color: 'var(--fg-mute)', fontSize: 12.5, marginTop: 8 }}>
        Bring your own key: credentials stay in your browser session and ride each request pass-through.
        DocentAPI never stores them.
      </p>
    </section>
  );
}
