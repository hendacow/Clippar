// redeem-code/codeFormat.ts
//
// The ONE implementation of what a redemption code is: how it is spelled, how a
// human's typing is normalised back to canonical form, and how it becomes the
// digest stored in `redemption_codes.code_hash`.
//
// It is shared, not duplicated, and that is the entire reason this file exists
// separately from index.ts. The generator (scripts/generate-redemption-codes.ts,
// Node) and the verifier (index.ts, Deno) must agree BYTE FOR BYTE on
// normalisation and hashing, because they never compare notes at runtime — the
// only thing that crosses between them is a hex digest in a database column. A
// second copy that drifted by one character class would not fail loudly; it
// would silently make every printed card invalid, and the codes are already
// printed by then.
//
// Deliberately free of Deno AND Node APIs: only string operations and WebCrypto,
// which both runtimes expose as globals. That is what lets one file be imported
// by an edge function and by an `npx tsx` script.

/**
 * Crockford base32. The omissions are the point: no I, L, O or U.
 *
 * I/L/1 and O/0 are the pairs people misread off a printed card and mistype
 * from a photo, and U is dropped so a random 16-character string cannot spell
 * something Henry would rather not hand an ambassador.
 *
 * 32 symbols = exactly 5 bits each, which is also why code generation can be a
 * clean bit-slice with no modulo bias (see bytesToCode).
 */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 16 symbols x 5 bits = 80 bits of entropy per code. */
export const CODE_LENGTH = 16;

/** Bytes of randomness a code consumes: 80 bits. */
export const CODE_ENTROPY_BYTES = 10;

/** The human-facing prefix, so a code on a card is obviously a Clippar code. */
export const CODE_PREFIX = 'CLIP';

/**
 * The prefix AFTER the confusion mapping below has run over it.
 *
 * Non-obvious and worth stating plainly: `CLIP` contains both an L and an I, so
 * by the time normalisation is looking for a prefix to strip, `CLIP` has become
 * `C11P`. Searching for the literal `CLIP` at that point would never match.
 */
const MAPPED_PREFIX = 'C11P';

/**
 * The classic misreadings, mapped towards the digit the alphabet actually uses.
 * Safe to apply to the whole string: I, L and O are not in the alphabet, so a
 * correctly typed code contains none of them and this can only ever repair a
 * mistype, never corrupt a good character.
 */
const CONFUSIONS: Record<string, string> = { I: '1', L: '1', O: '0' };

/**
 * Canonical form of whatever the user pasted: uppercase, confusions mapped,
 * everything outside the alphabet dropped, prefix removed.
 *
 * Order matters and follows the contract: uppercase, map confusions, strip, then
 * remove the prefix — which means the prefix is matched in its MAPPED spelling
 * (see MAPPED_PREFIX). The length guard is what makes that unambiguous: a real
 * code is CODE_LENGTH symbols, so a string is only treated as prefixed when it
 * is exactly CODE_LENGTH + 4 and starts with the mapped prefix. A legitimate
 * code that happens to begin with C11P (about one in a million) is therefore
 * still read correctly, because it is 16 characters and not 20.
 *
 * Never throws. Garbage in gives a string that isWellFormedCode() rejects,
 * which is how the caller turns it into a `malformed` response.
 */
export function normalizeCode(raw: string): string {
  const upper = (raw ?? '').toUpperCase();

  let out = '';
  for (const ch of upper) {
    const mapped = CONFUSIONS[ch] ?? ch;
    // Strip whatever is left outside the alphabet: dashes, spaces, the
    // zero-width junk that rides along with a copy-paste from Notes, emoji.
    if (CODE_ALPHABET.includes(mapped)) out += mapped;
  }

  if (out.length === CODE_LENGTH + MAPPED_PREFIX.length && out.startsWith(MAPPED_PREFIX)) {
    out = out.slice(MAPPED_PREFIX.length);
  }

  return out;
}

/**
 * Is this canonical form actually a code shape?
 *
 * The gate that lets the edge function reject junk without a database round
 * trip — and, just as importantly, without junk landing in the rate-limit
 * buckets, where it would let someone spend a legitimate user's budget by
 * pasting nonsense.
 */
export function isWellFormedCode(normalized: string): boolean {
  if (normalized.length !== CODE_LENGTH) return false;
  for (const ch of normalized) {
    if (!CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

/** `4T7Q9XKM2WRBJ5NH` -> `CLIP-4T7Q-9XKM-2WRB-J5NH`, the form that gets printed. */
export function formatCodeForDisplay(normalized: string): string {
  const groups: string[] = [];
  for (let i = 0; i < normalized.length; i += 4) {
    groups.push(normalized.slice(i, i + 4));
  }
  return [CODE_PREFIX, ...groups].join('-');
}

/**
 * Turn CODE_ENTROPY_BYTES of randomness into a code.
 *
 * Straight bit-slicing, NOT `byte % 32`. The alphabet is exactly 32 symbols so
 * five bits map onto it one-to-one and every code is uniform over the full 2^80
 * space. (Modulo on a 256-value byte against a non-power-of-two alphabet is the
 * classic way to quietly lose entropy; it costs nothing to be exact here, and
 * the whole security argument for this feature is the size of that exponent.)
 */
export function bytesToCode(bytes: Uint8Array): string {
  if (bytes.length < CODE_ENTROPY_BYTES) {
    throw new Error(`bytesToCode needs ${CODE_ENTROPY_BYTES} bytes of randomness`);
  }
  let bitBuffer = 0;
  let bitCount = 0;
  let out = '';
  for (let i = 0; i < CODE_ENTROPY_BYTES; i++) {
    bitBuffer = (bitBuffer << 8) | bytes[i];
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      out += CODE_ALPHABET[(bitBuffer >> bitCount) & 0b11111];
    }
  }
  return out;
}

/**
 * HMAC-SHA256(pepper, normalizedCode) as lowercase hex — the value stored in
 * `redemption_codes.code_hash`.
 *
 * The pepper is a Supabase secret (REDEMPTION_CODE_PEPPER) that never reaches
 * Postgres, so a database leak yields opaque digests rather than a list of
 * codes: without the key, a 16-symbol string from a 32-symbol alphabet would
 * otherwise be trivially recoverable from a bare digest. Migration
 * 018_redemption_codes.sql's header carries the full argument, including why
 * this is an HMAC and not a slow KDF.
 *
 * Refuses an empty pepper rather than defaulting to one. A silent fallback to
 * HMAC-with-an-empty-key would still verify, still redeem, and still look
 * perfectly healthy in every test — while quietly reducing the stored digests
 * to the plain SHA-256 the design exists to avoid. Failing here surfaces a
 * missing secret at the first request instead of at the first breach.
 */
export async function hashCode(normalizedCode: string, pepper: string): Promise<string> {
  if (!pepper) throw new Error('REDEMPTION_CODE_PEPPER is not set');

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(normalizedCode));

  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
