const LABEL_BG = '#555555';

// SVG is served standalone (image/svg+xml), never through React's escaping —
// text nodes here are built by raw string interpolation, so escape the
// handful of markup-significant characters ourselves.
function escapeSvgText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// No pixel-perfect font metrics — a flat per-character estimate is close
// enough for a badge nobody zooms in on.
function textWidth(text: string): number {
  return text.length * 6 + 10;
}

export function badgeSvg({ label, message, color }: { label: string; message: string; color: string }): string {
  const labelWidth = textWidth(label);
  const messageWidth = textWidth(message);
  const width = labelWidth + messageWidth;
  const height = 20;
  const safeLabel = escapeSvgText(label);
  const safeMessage = escapeSvgText(message);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" role="img" aria-label="${safeLabel}: ${safeMessage}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <mask id="m">
    <rect width="${width}" height="${height}" rx="3" fill="#fff"/>
  </mask>
  <g mask="url(#m)">
    <rect width="${labelWidth}" height="${height}" fill="${LABEL_BG}"/>
    <rect x="${labelWidth}" width="${messageWidth}" height="${height}" fill="${color}"/>
    <rect width="${width}" height="${height}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14">${safeLabel}</text>
    <text x="${labelWidth + messageWidth / 2}" y="14">${safeMessage}</text>
  </g>
</svg>`;
}
