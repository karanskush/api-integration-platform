import { describe, expect, it } from 'vitest';
import { basisFor } from '../provenance';

describe('basisFor', () => {
  it('names the sandbox, the key, the date and the caveat', () => {
    const s = basisFor({ environment: 'sandbox', observedAt: '2026-09-14T12:00:00Z' });
    expect(s).toContain('sandbox');
    expect(s).toContain('test key');
    expect(s).toContain('2026-09-14');
    expect(s).toContain('production may differ');
    expect(s).toContain('managed_observed');
  });

  it('names production plainly', () => {
    expect(basisFor({ environment: 'production', observedAt: new Date('2026-09-14T00:00:00Z') })).toBe(
      'live probes against the running production API on 2026-09-14 (managed_observed)',
    );
  });

  it('says when nothing was observed at all', () => {
    expect(basisFor({ environment: 'static' })).toMatch(/spec alone/);
    expect(basisFor({ environment: 'production', executionClass: 'declared' })).toMatch(/declared by the provider/);
  });

  it('tolerates a missing or unparseable date', () => {
    expect(basisFor({ environment: 'production' })).not.toContain('undefined');
    expect(basisFor({ environment: 'production', observedAt: 'not a date' })).not.toContain('NaN');
  });
});
