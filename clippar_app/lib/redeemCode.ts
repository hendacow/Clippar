/**
 * Lifetime redemption codes — the client half.
 *
 * Henry hands a printed code to an ambassador. They sign in, paste it once,
 * and the `redeem-code` Edge Function grants Clippar Pro for life. This module
 * owns three things and nothing else: turning whatever the human typed into a
 * canonical code, calling the function with the session JWT, and mapping the
 * wire responses onto a union the UI can switch on.
 *
 * THE USER ID IS NEVER SENT. `supabase.functions.invoke` attaches the signed-in
 * user's access token as the Authorization header, and the function reads the
 * granted user out of that verified JWT. A user id in the body would be a
 * caller-supplied claim about who to make Pro — i.e. a free lifetime
 * entitlement for anyone who can read a request in a proxy.
 *
 * CLIENT-SIDE NORMALISATION IS A CONVENIENCE, NEVER A CONTROL. Everything in
 * this file — the character mapping, the length check, the "is it complete
 * yet" gate on the button — exists so a golfer squinting at a printed card
 * doesn't get punished for typing O instead of 0. The server normalises and
 * validates the code again against the hash, and the server's answer is the
 * only one that grants anything. Do NOT "optimise" the server-side check away
 * on the grounds that the client already did it: the client is an attacker's
 * text editor, and the entire brute-force story rests on the server check plus
 * the server rate limit.
 */

/** Human-facing prefix on every printed code: `CLIP-XXXX-XXXX-XXXX-XXXX`. */
export const CODE_PREFIX = 'CLIP';

/** Characters in a code body, excluding the prefix and the dashes. */
export const CODE_BODY_LENGTH = 16;

/**
 * Crockford base32. I, L, O and U are absent on purpose: I/L/1 and O/0 are the
 * pairs people misread off a printed card, and U is dropped so a random code
 * can't spell something regrettable.
 */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Fallback wait when the server answers 429 without telling us how long. The
 * contract documents 900s; guessing is better than showing a golfer a generic
 * failure that reads as "your code is dead".
 */
const DEFAULT_RETRY_AFTER_SECONDS = 900;

/** Give up on a hung request rather than leaving the button spinning forever. */
const INVOKE_TIMEOUT_MS = 20_000;

/**
 * Every outcome the UI has to render. `redeemed` carries `alreadyOwned` as a
 * FLAG rather than being split into two statuses on purpose: both mean Pro is
 * live, and a consumer that only asks "is the user entitled now" must not be
 * able to miss one of them by forgetting a case.
 */
export type RedeemResult =
  | { status: 'redeemed'; grant: 'lifetime'; alreadyOwned: boolean }
  | { status: 'invalid' }
  | { status: 'malformed' }
  | { status: 'unauthorized' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'server' }
  /** The request never reached the function — nothing was consumed. */
  | { status: 'network' };

// ─── Normalisation + display (pure) ───

/**
 * Whatever the human gave us → the canonical 16-character code body.
 *
 * Uppercase, drop the `CLIP` prefix, map the classic misreads (I→1, L→1,
 * O→0), then discard everything that is not in the alphabet, which is what
 * removes the dashes and spaces.
 *
 * ORDER MATTERS, and not in the obvious way: L→1 and I→1 turn the literal
 * string "CLIP" into "C11P", so a prefix stripped AFTER the mapping never
 * matches and the prefix silently becomes part of the code. The prefix comes
 * off first, matched against its letter spellings only ("CLIP", and the
 * misread-tolerant "CIIP"/"CILP"/"CLLP"), so a genuine body that happens to
 * begin with the digits C11P is never eaten.
 *
 * Truncating at CODE_BODY_LENGTH is what stops a text field accepting a 17th
 * character. It cannot mask a bad code: a truncated code simply fails the
 * server's hash lookup like any other wrong code.
 */
export function normalizeCodeInput(raw: string): string {
  const upper = String(raw ?? '').toUpperCase();
  const withoutPrefix = upper.replace(/^\s*C[LI][IL]P[\s-]*/, '');

  let body = '';
  for (const char of withoutPrefix) {
    const mapped = char === 'I' || char === 'L' ? '1' : char === 'O' ? '0' : char;
    if (CROCKFORD_ALPHABET.includes(mapped)) body += mapped;
  }

  // Belt and braces for input that already carries a MAPPED prefix ("C11P…",
  // e.g. pasted out of somewhere that normalised in the wrong order). Only
  // strip it when the result is longer than a body, so a legitimate code
  // starting C11P — one in a million, but it would be unredeemable forever —
  // survives intact.
  if (body.length > CODE_BODY_LENGTH && body.startsWith('C11P')) {
    body = body.slice(4);
  }

  return body.slice(0, CODE_BODY_LENGTH);
}

/**
 * Regroup for humans as `CLIP-XXXX-XXXX-XXXX-XXXX`, one group at a time while
 * they type. Takes RAW input and normalises internally so it is idempotent —
 * `format(format(x)) === format(x)` — which is what makes it safe to use as
 * the value of a controlled TextInput.
 *
 * Empty input formats to empty, not to a bare "CLIP": a field the user cannot
 * backspace out of is a field that fights them.
 */
export function formatCodeForDisplay(raw: string): string {
  const body = normalizeCodeInput(raw);
  if (body.length === 0) return '';
  return [CODE_PREFIX, ...(body.match(/.{1,4}/g) ?? [])].join('-');
}

/** Enough characters to be worth sending. Advisory — see the header comment. */
export function isCompleteCode(raw: string): boolean {
  return normalizeCodeInput(raw).length === CODE_BODY_LENGTH;
}

/**
 * "45 seconds" / "15 minutes" / "2 hours", for telling someone when to retry.
 * Always rounds UP: sending a golfer back 30 seconds early just earns them a
 * second 429 and the belief that the code is dead.
 */
export function formatRetryWait(seconds: number): string {
  const total = Number.isFinite(seconds)
    ? Math.max(1, Math.ceil(seconds))
    : DEFAULT_RETRY_AFTER_SECONDS;
  if (total < 60) return `${total} second${total === 1 ? '' : 's'}`;
  const minutes = Math.ceil(total / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

// ─── Wire mapping (pure) ───

function asWireBody(body: unknown): Record<string, unknown> | null {
  if (typeof body === 'string') {
    try {
      return asWireBody(JSON.parse(body));
    } catch {
      return null;
    }
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return null;
}

function pickRetryAfter(
  wire: Record<string, unknown> | null,
  header?: string | null
): number {
  const fromBody = wire?.retryAfterSeconds;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody > 0) {
    return Math.ceil(fromBody);
  }
  // Retry-After may also arrive as the standard HTTP header.
  const fromHeader = Number(header);
  if (Number.isFinite(fromHeader) && fromHeader > 0) return Math.ceil(fromHeader);
  return DEFAULT_RETRY_AFTER_SECONDS;
}

/**
 * The whole wire contract in one pure function, so every branch is testable
 * without a network: HTTP status + parsed body + Retry-After header → result.
 *
 * Success is recognised by SHAPE, never by status code: only an explicit
 * `ok:true` with `grant:'lifetime'` reports a grant. A 200 we cannot read is a
 * broken contract, and telling a user they are Pro on the strength of a
 * response we did not understand is the one mistake that shows up as a golfer
 * who thinks he paid and isn't unlocked.
 */
export function interpretRedeemResponse(input: {
  status: number;
  body: unknown;
  retryAfterHeader?: string | null;
}): RedeemResult {
  const wire = asWireBody(input.body);

  if (wire?.ok === true && wire.grant === 'lifetime') {
    return { status: 'redeemed', grant: 'lifetime', alreadyOwned: wire.alreadyOwned === true };
  }

  // These strings are load-bearing — they are the contract, not the status code.
  switch (typeof wire?.error === 'string' ? wire.error : null) {
    case 'malformed':
      return { status: 'malformed' };
    case 'invalid':
      return { status: 'invalid' };
    case 'unauthorized':
      return { status: 'unauthorized' };
    case 'server':
      return { status: 'server' };
    case 'rate_limited':
      return {
        status: 'rate_limited',
        retryAfterSeconds: pickRetryAfter(wire, input.retryAfterHeader),
      };
  }

  // No usable body: a gateway HTML page, an empty 502, a proxy that ate the
  // response. Fall back to the status so the user still gets the right advice.
  if (input.status === 429) {
    return {
      status: 'rate_limited',
      retryAfterSeconds: pickRetryAfter(wire, input.retryAfterHeader),
    };
  }
  if (input.status === 401 || input.status === 403) return { status: 'unauthorized' };
  // ONLY 400 reads as a bad code. A 404 means the function isn't deployed, and
  // telling an ambassador their code is invalid is how a good code gets binned.
  if (input.status === 400) return { status: 'invalid' };
  return { status: 'server' };
}

/** What the screen actually renders. Kept beside the union so the copy for a
 *  new outcome cannot be forgotten, and so it is assertable in a unit test. */
export interface RedeemMessage {
  tone: 'success' | 'error';
  headline: string;
  detail: string;
}

export function describeRedeemResult(result: RedeemResult): RedeemMessage {
  switch (result.status) {
    case 'redeemed':
      return result.alreadyOwned
        ? {
            tone: 'success',
            headline: 'Already on your account',
            detail:
              'You have redeemed this code before. Clippar Pro is still yours for life — there is nothing else to do.',
          }
        : {
            tone: 'success',
            headline: 'Clippar Pro, for life',
            detail:
              'Every Pro feature is unlocked on this account. It never expires, and there is nothing to cancel.',
          };
    case 'invalid':
      return {
        tone: 'error',
        headline: 'That code did not work',
        detail:
          'Check the characters and try again. Each code works exactly once, so a code that has already been used will not work a second time.',
      };
    case 'malformed':
      return {
        tone: 'error',
        headline: 'That code looks incomplete',
        detail: `A Clippar code has ${CODE_BODY_LENGTH} characters, printed as ${CODE_PREFIX}-XXXX-XXXX-XXXX-XXXX.`,
      };
    case 'unauthorized':
      return {
        tone: 'error',
        headline: 'Sign in first',
        detail:
          'A code attaches to your Clippar account, so you need to be signed in before you can redeem one.',
      };
    // The wait is stated plainly and the code is explicitly still good: someone
    // who fat-fingered a printed card three times needs to know they have not
    // just burned it.
    case 'rate_limited':
      return {
        tone: 'error',
        headline: 'Too many attempts',
        detail: `Try again in ${formatRetryWait(result.retryAfterSeconds)}. Your code has not been used up — it will still work.`,
      };
    case 'network':
      return {
        tone: 'error',
        headline: 'You are offline',
        detail:
          'Redeeming needs an internet connection. Reconnect and try again — your code has not been used.',
      };
    case 'server':
      return {
        tone: 'error',
        headline: 'Something went wrong',
        detail:
          'We could not redeem the code just now. Your code has not been used — please try again in a minute.',
      };
  }
}

// ─── The call ───

/** Single read of the response body, tolerant of a non-JSON content type. */
async function readBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

/**
 * Redeem a code for the signed-in user.
 *
 * TOTAL by design: every path resolves to a RedeemResult and this never
 * rejects, so a caller can render the outcome without a catch and can never
 * leave a submit button stuck mid-flight on an unexpected throw.
 */
export async function redeemCode(code: string): Promise<RedeemResult> {
  const body = normalizeCodeInput(code);
  if (body.length !== CODE_BODY_LENGTH) return { status: 'malformed' };

  try {
    // Imported lazily so this module's pure half stays importable from the
    // node test runner, which cannot transform react-native (lib/supabase.ts
    // pulls it in). lib/sharing.ts defers lib/r2 the same way.
    const { supabase } = await import('@/lib/supabase');

    // getSession() is a LOCAL read. No session means no JWT, so the function
    // would answer 401 anyway — answering here saves a pointless round trip
    // and, more importantly, avoids spending one of the user's rate-limited
    // attempts on a request that could never have succeeded.
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) return { status: 'unauthorized' };

    // Send the canonical printed form. The server normalises again; sending
    // the display shape just means the generator, the card in the golfer's
    // hand and the request body are all the same string.
    const { data, error, response } = await supabase.functions.invoke('redeem-code', {
      method: 'POST',
      body: { code: formatCodeForDisplay(body) },
      timeout: INVOKE_TIMEOUT_MS,
    });

    // No Response at all = FunctionsFetchError: DNS, airplane mode, timeout.
    // The function never ran, so nothing was consumed.
    if (!response) return { status: 'network' };

    return interpretRedeemResponse({
      status: response.status,
      // On failure the Response is handed back UNREAD (supabase-js throws
      // FunctionsHttpError before parsing), so the contract body is still in
      // there; on success invoke already parsed it into `data`.
      body: error ? await readBody(response) : data,
      retryAfterHeader: response.headers?.get?.('Retry-After') ?? null,
    });
  } catch {
    // Nothing above should throw, but a rejected promise here would strand the
    // screen's in-flight guard. Fail closed and let the user retry.
    return { status: 'server' };
  }
}
