import { describe, expect, it } from 'vitest';
import { assertPublicUrl, isPublicIp, SsrfError } from '../ssrf';

describe('isPublicIp — IPv4', () => {
  const blocked = [
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1', // CGNAT
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ];
  const allowed = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1', '11.0.0.1', '198.20.0.1'];

  it.each(blocked)('blocks %s', (ip) => expect(isPublicIp(ip)).toBe(false));
  it.each(allowed)('allows %s', (ip) => expect(isPublicIp(ip)).toBe(true));
});

describe('isPublicIp — IPv6', () => {
  const blocked = [
    '::1',
    '::',
    'fc00::1', // ULA
    'fd12:3456::1',
    'fe80::1', // link-local
    'ff02::1', // multicast
    '::ffff:127.0.0.1', // v4-mapped loopback
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '2001:db8::1', // documentation
    '64:ff9b::a00:1', // NAT64 embedding 10.0.0.1
  ];
  const allowed = ['2606:4700:4700::1111', '2620:fe::fe', '::ffff:8.8.8.8'];

  it.each(blocked)('blocks %s', (ip) => expect(isPublicIp(ip)).toBe(false));
  it.each(allowed)('allows %s', (ip) => expect(isPublicIp(ip)).toBe(true));
});

describe('assertPublicUrl', () => {
  it('rejects non-http protocols', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(SsrfError);
    await expect(assertPublicUrl('ftp://example.com/x')).rejects.toThrow(SsrfError);
  });

  it('rejects credentials in URLs', async () => {
    await expect(assertPublicUrl('https://user:pass@example.com/')).rejects.toThrow(SsrfError);
  });

  it('rejects internal hostnames', async () => {
    await expect(assertPublicUrl('http://localhost:3000/x')).rejects.toThrow(SsrfError);
    await expect(assertPublicUrl('http://foo.local/x')).rejects.toThrow(SsrfError);
    await expect(assertPublicUrl('http://metadata.google.internal/x')).rejects.toThrow(SsrfError);
  });

  it('rejects literal private IPs', async () => {
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(SsrfError);
    await expect(assertPublicUrl('http://10.0.0.1/')).rejects.toThrow(SsrfError);
    await expect(assertPublicUrl('http://[::1]/')).rejects.toThrow(SsrfError);
  });

  it('accepts a public literal IP', async () => {
    const { addresses } = await assertPublicUrl('http://1.1.1.1/');
    expect(addresses).toEqual(['1.1.1.1']);
  });
});
