// Origin of the Spotcheck app (importer / pages / MCP). Set VITE_APP_ORIGIN
// at build time in production; local dev falls back to the Next dev server.
export const APP_ORIGIN = import.meta.env.VITE_APP_ORIGIN ?? 'http://localhost:3000';
