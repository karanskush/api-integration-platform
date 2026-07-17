import { describe, expect, it } from 'vitest';
import { badgeSvg } from '../badge';

describe('badgeSvg', () => {
  it('renders the neutral unverified variant', () => {
    const svg = badgeSvg({ label: 'spotcheck', message: 'unverified', color: '#8a8f98' });
    expect(svg).toContain('#8a8f98');
    expect(svg).toContain('unverified');
    expect(svg).toContain('spotcheck');
    expect(svg.startsWith('<svg')).toBe(true);
  });

  it('renders the verified variant in the earned green', () => {
    const svg = badgeSvg({ label: 'agent-ready', message: '87/100', color: '#43d9a3' });
    expect(svg).toContain('#43d9a3');
    expect(svg).toContain('87/100');
    expect(svg).toContain('agent-ready');
  });

  it('escapes markup-significant characters in label/message', () => {
    const svg = badgeSvg({ label: '<a>&"', message: '<b>', color: '#43d9a3' });
    expect(svg).not.toContain('<a>');
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&lt;a&gt;&amp;&quot;');
  });
});
