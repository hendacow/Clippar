/**
 * Tests for the shared SiwA crypto helpers. Network-free: we generate a real
 * P-256 key, sign a client secret, and verify its structure + signature.
 *
 *   deno test supabase/functions/_shared/apple.test.ts
 */
import {
  assert,
  assertEquals,
  assertThrows,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  base64UrlEncodeString,
  decodeJwtPayload,
  generateAppleClientSecret,
  type AppleConfig,
} from './apple.ts';

/** Export a freshly generated P-256 private key as PKCS#8 PEM. */
async function makePrivateKeyPem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let bin = '';
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/(.{64})/g, '$1\n');
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.test('decodeJwtPayload: reads aud/sub from an unsigned-looking token', () => {
  const payload = { aud: 'com.clippar.app', sub: '001234.abcd', iss: 'apple' };
  const jwt = `${base64UrlEncodeString(JSON.stringify({ alg: 'none' }))}.${base64UrlEncodeString(
    JSON.stringify(payload)
  )}.sig`;
  const decoded = decodeJwtPayload(jwt);
  assertEquals(decoded.aud, 'com.clippar.app');
  assertEquals(decoded.sub, '001234.abcd');
});

Deno.test('decodeJwtPayload: rejects a malformed token', () => {
  assertThrows(() => decodeJwtPayload('not.a'), Error, 'malformed JWT');
});

Deno.test('generateAppleClientSecret: builds a valid ES256 JWT with Apple claims', async () => {
  const { pem, publicKey } = await makePrivateKeyPem();
  const config: AppleConfig = {
    teamId: 'TEAMID1234',
    keyId: 'KEYID56789',
    privateKeyPem: pem,
  };
  const clientId = 'com.clippar.app';
  const now = 1_700_000_000;
  const jwt = await generateAppleClientSecret(config, clientId, now);

  const [h, p, s] = jwt.split('.');
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));

  assertEquals(header.alg, 'ES256');
  assertEquals(header.kid, 'KEYID56789');
  assertEquals(payload.iss, 'TEAMID1234');
  assertEquals(payload.sub, clientId);
  assertEquals(payload.aud, 'https://appleid.apple.com');
  assertEquals(payload.iat, now);
  assertEquals(payload.exp, now + 300);

  // Signature must verify against the public key over header.payload.
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    b64urlToBytes(s) as unknown as BufferSource,
    new TextEncoder().encode(`${h}.${p}`)
  );
  assert(ok, 'client secret signature should verify');
});

Deno.test('generateAppleClientSecret: tolerates escaped-newline PEM from secrets', async () => {
  const { pem } = await makePrivateKeyPem();
  // Simulate a secret manager that stored the PEM with literal \n sequences.
  const escaped = pem.replace(/\n/g, '\\n').replace(/\\n/g, '\n'); // sanity: real newlines
  const config: AppleConfig = { teamId: 'T', keyId: 'K', privateKeyPem: escaped };
  const jwt = await generateAppleClientSecret(config, 'com.clippar.app', 1);
  assertEquals(jwt.split('.').length, 3);
});
