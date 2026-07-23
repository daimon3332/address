import { describe, expect, it } from 'vitest';
import { clientContextFromRequest } from '../server/api/services/client-context';

describe('self-hosted client request context', () => {
  it('uses the direct socket address and normalizes IPv4-mapped IPv6', () => {
    const context = clientContextFromRequest(
      new Request('https://example.test/api/v1/client-context'),
      { socketIp: '::ffff:162.141.137.231' }
    );

    expect(context).toMatchObject({
      publicIp: '162.141.137.231', source: 'request-socket', localDevelopment: false
    });
  });

  it('ignores spoofed forwarding headers unless proxy trust is enabled', () => {
    const request = new Request('https://example.test/api/v1/client-context', {
      headers: {
        Forwarded: 'for=162.141.137.231;proto=https',
        'X-Forwarded-For': '162.141.137.231',
        'X-Real-IP': '162.141.137.231'
      }
    });

    expect(clientContextFromRequest(request, { socketIp: '8.8.8.8' }).publicIp).toBe('8.8.8.8');
    expect(clientContextFromRequest(request, { socketIp: '8.8.8.8', trustProxy: true })).toMatchObject({
      publicIp: '162.141.137.231', source: 'trusted-proxy'
    });
  });

  it('accepts standard proxy formats and excludes private or invalid addresses', () => {
    const ipv6 = new Request('https://example.test', {
      headers: { Forwarded: 'for="[2606:4700:4700::1111]:443"' }
    });
    const privateIp = new Request('http://localhost', {
      headers: { 'X-Forwarded-For': '10.0.0.7' }
    });

    expect(clientContextFromRequest(ipv6, { trustProxy: true }).publicIp).toBe('2606:4700:4700::1111');
    expect(clientContextFromRequest(privateIp, { trustProxy: true })).toMatchObject({
      source: 'trusted-proxy', localDevelopment: true
    });
    expect(clientContextFromRequest(privateIp, { trustProxy: true })).not.toHaveProperty('publicIp');
  });
});
