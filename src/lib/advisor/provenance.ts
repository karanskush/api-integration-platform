// One sentence that says where an observation came from.
//
// Every advisor tool that cites something observed used to inline its own
// basis string, and none of them could say WHICH environment the observation
// was made in — a fact from the owner's sandbox read exactly like one from
// production. This is the single place that sentence is written, so every tool
// labels the same way and the label is never forgotten.

export type Provenance = {
  environment: 'production' | 'sandbox' | 'static' | string;
  observedAt?: string | Date | null;
  /** How the observation was made. Managed = DocentAPI's own probes. */
  executionClass?: 'managed_observed' | 'declared';
};

function dateOf(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function basisFor(p: Provenance): string {
  const when = dateOf(p.observedAt);
  const on = when ? ` on ${when}` : '';
  if (p.executionClass === 'declared') return 'declared by the provider — not observed';
  switch (p.environment) {
    case 'sandbox':
      return `live probes against the owner's sandbox with their test key${on} (managed_observed); production may differ`;
    case 'production':
      return `live probes against the running production API${on} (managed_observed)`;
    case 'static':
      return 'derived from the spec alone — no live request was made';
    default:
      return `observed in ${p.environment}${on} (managed_observed)`;
  }
}
