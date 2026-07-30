const SITE_WAITLIST_URL = process.env.SITE_WAITLIST_URL || '/#waitlist';

export default function TtlNotice({ expiresAt }: { expiresAt: number }) {
  const hoursLeft = Math.max(0, Math.round((expiresAt - Date.now()) / 3_600_000));
  return (
    <div
      className="panel"
      style={{
        padding: '10px 16px',
        display: 'flex',
        gap: 12,
        alignItems: 'baseline',
        borderColor: 'rgba(224, 168, 62, 0.25)',
        fontSize: 13,
      }}
    >
      <span className="mono" style={{ color: 'var(--warn)', letterSpacing: '0.06em', textTransform: 'uppercase', fontSize: 11 }}>ephemeral</span>
      <span style={{ color: 'var(--fg-dim)' }}>
        This page and its MCP server self-destruct in about {hoursLeft}h.
      </span>
      <a href={SITE_WAITLIST_URL} style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
        Want it permanent? →
      </a>
    </div>
  );
}
