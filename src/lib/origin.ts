// Where this deployment actually lives.
//
// This one-liner had been copy-pasted into ten route files in three slightly
// different shapes — some falling back to the request origin, some to
// localhost, and each re-deciding how to strip a trailing slash. That is fine
// until the marketing copy needs the same answer: a landing page that names a
// hostname is making a claim, and it was naming `docentapi.dev` while the app
// served from somewhere else.
//
// One implementation, three call shapes, and the copy can now be as true as
// the API responses already were.

/**
 * The public origin, without a trailing slash.
 *
 * `PUBLIC_APP_ORIGIN` wins when set, because a request's own origin is wrong
 * behind a proxy and on preview URLs. Otherwise fall back to the request that
 * is being served — and only then to localhost, for the render paths that have
 * no request to consult.
 */
export function appOrigin(req?: Request): string {
  const configured = process.env.PUBLIC_APP_ORIGIN?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (req) {
    try {
      return new URL(req.url).origin;
    } catch {
      /* a malformed request URL should not take a page down */
    }
  }
  return 'http://localhost:3000';
}

/**
 * The bare host, for prose. `https://docentapi.dev/` -> `docentapi.dev`.
 *
 * Copy that shows a URL reads better without the scheme, and the landing page
 * renders it in a dimmed span rather than as part of the sentence.
 */
export function appHost(req?: Request): string {
  return appOrigin(req).replace(/^https?:\/\//, '').replace(/\/+$/, '');
}
