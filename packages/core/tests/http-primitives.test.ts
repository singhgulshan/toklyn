import { describe, expect, it } from 'vitest';
import {
  createRefreshCookie,
  extractBearerToken,
  isTrustedOrigin,
  readCookie,
  toAllowedOrigins,
  toToklynHttpError,
} from '#src/http/index.js';
import { ToklynError } from '#src/index.js';
import type { ToklynErrorCode } from '#src/index.js';

function configCode(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error instanceof ToklynError ? error.code : 'not_toklyn_error';
  }
  return undefined;
}

describe('extractBearerToken', () => {
  it('returns the token from a well-formed header', () => {
    expect(extractBearerToken('Bearer abc.def-ghi_jkl~/+==')).toBe(
      'abc.def-ghi_jkl~/+==',
    );
    expect(extractBearerToken('bearer abc')).toBe('abc');
    expect(extractBearerToken('BEARER   abc')).toBe('abc');
  });

  it.each([
    undefined,
    null,
    '',
    'Bearer',
    'Bearer ',
    'Bearer  ',
    'Basic abc',
    'Bearerabc',
    'Bearer abc ',
    ' Bearer abc',
    'Bearer abc def',
    'Bearer abc,Bearer def',
    'Bearer a=b',
    'Bearer abc\n',
    'Bearer\tabc',
  ])('rejects %j', (header) => {
    expect(extractBearerToken(header)).toBeNull();
  });

  it('rejects oversized headers', () => {
    expect(extractBearerToken(`Bearer ${'a'.repeat(8200)}`)).toBeNull();
  });
});

describe('readCookie', () => {
  it('finds the named cookie among others', () => {
    expect(readCookie('a=1; rt=xyz; b=2', 'rt')).toBe('xyz');
    expect(readCookie('rt=xyz', 'rt')).toBe('xyz');
    expect(readCookie('rt="xyz"', 'rt')).toBe('xyz');
  });

  it('matches names exactly', () => {
    expect(readCookie('xrt=1; rtx=2', 'rt')).toBeNull();
    expect(readCookie('__Host-rt=1', 'rt')).toBeNull();
  });

  it('returns null when missing or empty', () => {
    expect(readCookie(undefined, 'rt')).toBeNull();
    expect(readCookie('', 'rt')).toBeNull();
    expect(readCookie('rt=', 'rt')).toBeNull();
    expect(readCookie('rt', 'rt')).toBeNull();
  });

  it('rejects conflicting duplicates but accepts identical ones', () => {
    expect(readCookie('rt=a; rt=b', 'rt')).toBeNull();
    expect(readCookie('rt=a; rt=a', 'rt')).toBe('a');
  });
});

describe('createRefreshCookie', () => {
  const NOW = 1_700_000_000_000;

  it('uses secure defaults and the __Host- prefix', () => {
    const cookie = createRefreshCookie();

    expect(cookie.name).toBe('__Host-toklyn_refresh');
    expect(cookie.serialize('tok', NOW + 60_000, NOW)).toBe(
      '__Host-toklyn_refresh=tok; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Strict',
    );
    expect(cookie.serializeClear()).toBe(
      '__Host-toklyn_refresh=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict',
    );
  });

  it('falls back to __Secure- when scoped by path or domain', () => {
    expect(createRefreshCookie({ path: '/auth' }).name).toBe(
      '__Secure-toklyn_refresh',
    );
    const cookie = createRefreshCookie({
      name: 'rt',
      domain: 'example.com',
      sameSite: 'Lax',
    });
    expect(cookie.name).toBe('__Secure-rt');
    expect(cookie.serialize('tok', NOW + 1000, NOW)).toBe(
      '__Secure-rt=tok; Max-Age=1; Path=/; Domain=example.com; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('drops the prefix and Secure only when secure is false', () => {
    const cookie = createRefreshCookie({ secure: false });
    expect(cookie.name).toBe('toklyn_refresh');
    expect(cookie.serializeClear()).toBe(
      'toklyn_refresh=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict',
    );
  });

  it('rounds Max-Age down and never goes negative', () => {
    const cookie = createRefreshCookie();
    expect(cookie.serialize('t', NOW + 1999, NOW)).toContain('Max-Age=1;');
    expect(cookie.serialize('t', NOW - 5000, NOW)).toContain('Max-Age=0;');
  });

  it('refuses values that would break the header', () => {
    const cookie = createRefreshCookie();
    for (const token of ['', 'a;b', 'a b', 'a,b', 'a"b', 'a\\b', 'a\r\nb']) {
      expect(configCode(() => cookie.serialize(token, NOW, NOW))).toBe(
        'invalid_input',
      );
    }
  });

  it.each([
    { name: '' },
    { name: 'a b' },
    { name: 'a;b' },
    { name: '__Host-rt' },
    { name: '__secure-rt' },
    { path: '' },
    { path: 'auth' },
    { path: '/a;b' },
    { path: '/a b' },
    { domain: '' },
    { domain: '.example.com' },
    { domain: 'example.com; Path=/' },
    { domain: 'exa mple.com' },
    { sameSite: 'None' as 'Lax' },
    { secure: 'yes' as unknown as boolean },
  ])('rejects invalid options %j', (options) => {
    expect(configCode(() => createRefreshCookie(options))).toBe(
      'invalid_config',
    );
  });
});

describe('origin checks', () => {
  const allowed = toAllowedOrigins(['https://app.example.com']);

  it('trusts same-origin fetch metadata', () => {
    expect(isTrustedOrigin({ secFetchSite: 'same-origin' }, allowed)).toBe(
      true,
    );
  });

  it('trusts allow-listed origins', () => {
    expect(
      isTrustedOrigin(
        { origin: 'https://app.example.com', secFetchSite: 'same-site' },
        allowed,
      ),
    ).toBe(true);
  });

  it.each([
    {},
    { origin: null, secFetchSite: null },
    { origin: 'https://evil.example' },
    { origin: 'null' },
    { origin: 'https://app.example.com.evil.example' },
    { origin: 'https://evil.example', secFetchSite: 'cross-site' },
    { secFetchSite: 'same-site' },
    { secFetchSite: 'none' },
  ])('rejects %j', (headers) => {
    expect(isTrustedOrigin(headers, allowed)).toBe(false);
  });

  it.each([
    'app.example.com',
    'https://app.example.com/',
    'https://app.example.com/path',
    'ftp://app.example.com',
    'null',
    '*',
    '',
  ])('refuses %j as an allowed origin', (origin) => {
    expect(configCode(() => toAllowedOrigins([origin]))).toBe('invalid_config');
  });

  it('accepts ports and plain http', () => {
    expect(
      toAllowedOrigins(['http://localhost:3000']).has('http://localhost:3000'),
    ).toBe(true);
  });
});

describe('toToklynHttpError', () => {
  const unauthorized: ToklynErrorCode[] = [
    'invalid_access_token',
    'access_token_expired',
    'access_token_revoked',
    'invalid_refresh_token',
    'refresh_token_expired',
    'refresh_token_reused',
    'session_not_found',
    'session_expired',
    'session_revoked',
  ];

  it.each(unauthorized)('maps %s to an identical 401', (code) => {
    expect(toToklynHttpError(new ToklynError(code, 'detail'))).toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    });
  });

  it('maps storage errors to 503', () => {
    expect(toToklynHttpError(new ToklynError('storage_error', 'x'))).toEqual({
      status: 503,
      body: { error: 'service_unavailable' },
    });
  });

  it.each([
    new ToklynError('invalid_config', 'x'),
    new ToklynError('invalid_input', 'x'),
    new Error('x'),
    'x',
  ])('leaves %j to the caller', (error) => {
    expect(toToklynHttpError(error)).toBeNull();
  });
});
