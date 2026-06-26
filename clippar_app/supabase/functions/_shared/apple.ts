/**
 * Sign-in-with-Apple server helpers, shared by the `apple-link` (code →
 * refresh-token exchange at sign-in) and `delete-account` (token revocation)
 * Edge Functions.
 *
 * Apple authenticates the SERVER with a short-lived "client secret": an ES256
 * JWT signed with the team's `.p8` private key. We generate it with Web Crypto
 * (no external dep), so the same key configured in the Supabase dashboard for
 * SiwA login is reused here — just supplied to the functions as secrets.
 *
 * Required Edge Function secrets:
 *   APPLE_TEAM_ID            — 10-char Apple team id (e.g. LBJUXXPJ6H)
 *   APPLE_KEY_ID             — 10-char key id of the .p8
 *   APPLE_PRIVATE_KEY        — full .p8 PEM (-----BEGIN PRIVATE KEY----- …)
 *   APPLE_ALLOWED_CLIENT_IDS — optional CSV allowlist of bundle ids the client
 *                              may link; defaults to the three Clippar bundles.
 */

const APPLE_AUDIENCE = 'https://appleid.apple.com';
const DEFAULT_ALLOWED_CLIENT_IDS = [
  'com.clippar.app',
  'com.clippar.app.dev',
  'com.clippar.app.staging',
];

export interface AppleConfig {
  teamId: string;
  keyId: string;
  privateKeyPem: string;
}

export interface AppleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Read Apple signing config from env; null when not configured (feature off). */
export function getAppleConfig(): AppleConfig | null {
  const teamId = Deno.env.get('APPLE_TEAM_ID');
  const keyId = Deno.env.get('APPLE_KEY_ID');
  // Secret managers often store the PEM with escaped newlines — normalise.
  const privateKeyPem = Deno.env.get('APPLE_PRIVATE_KEY')?.replace(/\\n/g, '\n');
  if (!teamId || !keyId || !privateKeyPem) return null;
  return { teamId, keyId, privateKeyPem };
}

/** Bundle ids the client is allowed to link/revoke (guards client_secret `sub`). */
export function allowedClientIds(): string[] {
  const csv = Deno.env.get('APPLE_ALLOWED_CLIENT_IDS');
  if (!csv) return DEFAULT_ALLOWED_CLIENT_IDS;
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── base64url ──────────────────────────────────────────────────────────────

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlEncodeString(str: string): string {
  return base64UrlEncode(new TextEncoder().encode(str));
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Decode (WITHOUT verifying) the payload of a JWT. Used to read the `aud`
 * (client_id) and `sub` claims out of Apple's identity token at link time. The
 * caller is already authenticated via their Supabase JWT, and a wrong `aud`
 * simply makes Apple reject the exchange — so signature verification here would
 * add cost without changing the security outcome.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  const json = new TextDecoder().decode(base64UrlToBytes(parts[1]));
  return JSON.parse(json);
}

// ── client secret (ES256 JWT) ───────────────────────────────────────────────

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    pemToDer(pem) as unknown as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

/**
 * Generate the Apple client-secret JWT. `clientId` is the bundle id (becomes
 * `sub`); the token is short-lived (5 min) and regenerated per request.
 */
export async function generateAppleClientSecret(
  config: AppleConfig,
  clientId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<string> {
  const header = { alg: 'ES256', kid: config.keyId, typ: 'JWT' };
  const payload = {
    iss: config.teamId,
    iat: nowSeconds,
    exp: nowSeconds + 300,
    aud: APPLE_AUDIENCE,
    sub: clientId,
  };
  const signingInput = `${base64UrlEncodeString(
    JSON.stringify(header)
  )}.${base64UrlEncodeString(JSON.stringify(payload))}`;

  const key = await importPrivateKey(config.privateKeyPem);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput)
  );
  // Web Crypto ECDSA returns raw r||s (IEEE P1363) — already JOSE format.
  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;
}

// ── Apple token endpoints ───────────────────────────────────────────────────

/** Exchange a one-time authorization code for tokens (incl. refresh_token). */
export async function exchangeAuthorizationCode(args: {
  code: string;
  clientId: string;
  clientSecret: string;
}): Promise<AppleTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  });
  const res = await fetch(`${APPLE_AUDIENCE}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return (await res.json()) as AppleTokenResponse;
}

/**
 * Revoke a token (default a refresh token) at Apple's /auth/revoke. Throws on a
 * non-2xx response so the caller can log it; revocation is best-effort and must
 * not block account deletion.
 */
export async function revokeAppleToken(args: {
  token: string;
  clientId: string;
  clientSecret: string;
  tokenTypeHint?: 'refresh_token' | 'access_token';
}): Promise<void> {
  const body = new URLSearchParams({
    token: args.token,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    token_type_hint: args.tokenTypeHint ?? 'refresh_token',
  });
  const res = await fetch(`${APPLE_AUDIENCE}/auth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`apple revoke failed: ${res.status} ${text}`.trim());
  }
}
