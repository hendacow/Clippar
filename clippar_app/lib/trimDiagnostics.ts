// ────────────────────────────────────────────────────────────────────────────
// [trim-diag] — proving, on the device, that Trim Settings reach the trimmer.
//
// WHY THIS EXISTS. "I changed my trim settings, recorded a shot, and still got
// a 5 second clip" is not answerable from the existing logs. `[ShotDetector]
// Swing @ ...ms → trim A..Bms` prints the OUTCOME and nothing about the ASK, so
// a window that was honoured and a window that was ignored look identical on
// the console. Worse, the outcome alone is ambiguous: 1000ms before impact and
// 4000ms after can be a user who chose exactly that, OR a user who chose
// 1000/1000 whose post-roll was silently widened by the native putt floor
// (modules/shot-detector/ios/ShotDetectorModule.swift:370 —
// `result.shotType == .putt ? max(postRollMs, 4000.0) : postRollMs`).
//
// So this module prints the whole chain for every trim, in order:
//   1. the RAW `trim_settings` string as stored (or null),
//   2. the RESOLVED window and its total,
//   3. WHERE that window came from (user override / fullSwing fallback / with
//      the tracer post-roll bonus folded in),
//   4. the numbers actually PASSED to detectAndTrim,
//   5. the numbers that came BACK from native,
//   6. the window those numbers IMPLY (impact - trimStart, trimEnd - impact),
//   7. an explicit MISMATCH line naming both numbers when 4 and 6 disagree.
//
// It lives here, not in the two hooks, because hooks/useCamera.ts and
// hooks/useEditorState.ts have already been burned once by being hand-mirrored
// copies of the same trim logic (see constants/config.ts). One formatter, one
// mismatch rule, both call sites.
//
// EVERYTHING HERE IS NON-FATAL AND SIDE-EFFECT FREE apart from console.log.
// The pure functions never throw; the two `log*` wrappers swallow anything that
// somehow escapes. Diagnostics must never be the reason a golfer loses a clip.
// ────────────────────────────────────────────────────────────────────────────

import {
  resolveSavedTrimWindow,
  resolveEffectiveTrimWindow,
  TRIM_WINDOW_MARKER,
  type TrimWindow,
} from '@/constants/config';

/** Greppable prefix. `grep trim-diag` in the Metro console gives the whole chain. */
export const TRIM_DIAG_PREFIX = '[trim-diag]';

/**
 * The one rule in native that can OVERRIDE a user's post-roll rather than
 * merely bound it by the length of the file: putts get a minimum window.
 *
 * There is NO equivalent floor on the pre-roll, and none at all for swings —
 * which is how a golfer's 1000ms pre-roll came back applied exactly while his
 * 1000ms post-roll came back as 4000ms.
 *
 * Two shapes of this rule exist in the wild, and telling them apart tells you
 * which binary is installed:
 *  - OLD (`max(postRollMs, 4000)`): a floor on the POST-ROLL, so the clip was
 *    preRoll + 4000. This is the defect.
 *  - NEW: a floor on the TOTAL window, so the clip is at most 4000ms and a
 *    caller already asking for >= 4000ms total is untouched.
 *
 * It fires on far more than putts: when pose detection finds no confident
 * swing, native's fallbackClassify labels ANY recording longer than 12s a putt
 * at confidence 0.25, on duration alone.
 */
export const NATIVE_PUTT_FLOOR_MS = 4000;

/** Which pipeline emitted the block. Keeps interleaved batches readable. */
export type TrimDiagPath = 'live-capture' | 'import-retrim' | 'import-batch';

/** What the stored `trim_settings` blob turned out to be. */
export type TrimSettingBlobState =
  /** Nothing stored — the user has never opened Trim Settings. */
  | 'absent'
  /** Stored, but not JSON / not an object. Ignored by the readers. */
  | 'unparseable'
  /** A JSON object with no `window: 'fullSwing'` marker. Ignored by the readers. */
  | 'untagged'
  /** Carries the marker, so the readers honour whatever is usable in it. */
  | 'tagged';

export interface TrimWindowSource {
  /** Exactly what came out of storage, untouched. */
  rawSetting: string | null;
  blobState: TrimSettingBlobState;
  /** What the settings screen shows and edits. */
  saved: TrimWindow;
  /** What the pipeline trims to (saved + tracer bonus). */
  effective: TrimWindow;
  /** effective.postRollMs - saved.postRollMs. 0 whenever the tracer is off. */
  tracerExtraPostRollMs: number;
  /** The stored pre-roll was accepted verbatim (not replaced by the fallback). */
  preRollFromUser: boolean;
  /** The stored post-roll was accepted verbatim (not replaced by the fallback). */
  postRollFromUser: boolean;
  /** One-line human summary, e.g. "user override (Trim Settings)". */
  label: string;
}

/**
 * Explain where the window a trim is about to use actually came from.
 *
 * This deliberately re-parses the raw blob instead of inferring from the
 * resolved numbers, because the two failure modes that matter are invisible in
 * the numbers alone: an override that was REJECTED for want of the marker
 * resolves to the same 2500/1500 as no override at all, and a tagged override
 * with one junk field resolves to a mix of user and fallback values. Naming
 * which is which is the entire point of the line.
 *
 * Never throws. `resolveSavedTrimWindow` / `resolveEffectiveTrimWindow` stay
 * the authority on the VALUES — this only characterises them.
 */
export function describeTrimWindowSource(
  rawSetting: string | null | undefined
): TrimWindowSource {
  const raw = rawSetting ?? null;
  const saved = resolveSavedTrimWindow(raw);
  const effective = resolveEffectiveTrimWindow(raw);
  const tracerExtraPostRollMs = Math.max(0, effective.postRollMs - saved.postRollMs);

  let blobState: TrimSettingBlobState = 'absent';
  let storedPre: unknown;
  let storedPost: unknown;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      // An array parses fine and is `typeof 'object'`, but it is not a settings
      // blob — calling it "untagged" would imply someone saved a window here.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        blobState = 'unparseable';
      } else {
        const o = parsed as { window?: unknown; preRollMs?: unknown; postRollMs?: unknown };
        blobState = o.window === TRIM_WINDOW_MARKER ? 'tagged' : 'untagged';
        storedPre = o.preRollMs;
        storedPost = o.postRollMs;
      }
    } catch {
      blobState = 'unparseable';
    }
  }

  const accepted = (stored: unknown, resolved: number): boolean =>
    blobState === 'tagged' &&
    typeof stored === 'number' &&
    Number.isFinite(stored) &&
    Math.round(stored) === resolved;

  const preRollFromUser = accepted(storedPre, saved.preRollMs);
  const postRollFromUser = accepted(storedPost, saved.postRollMs);

  let label: string;
  switch (blobState) {
    case 'absent':
      label = 'fullSwing fallback (no trim_settings stored yet)';
      break;
    case 'unparseable':
      label = 'fullSwing fallback (stored trim_settings is not readable JSON — IGNORED)';
      break;
    case 'untagged':
      label = `fullSwing fallback (stored override carries no window:"${TRIM_WINDOW_MARKER}" marker — IGNORED)`;
      break;
    default:
      if (preRollFromUser && postRollFromUser) {
        label = 'user override (Trim Settings)';
      } else if (preRollFromUser || postRollFromUser) {
        const fellBack = preRollFromUser ? 'post-roll' : 'pre-roll';
        label = `user override (Trim Settings), ${fellBack} fell back to fullSwing (stored value unusable)`;
      } else {
        label = 'fullSwing fallback (marker present but neither stored value was usable)';
      }
      break;
  }
  if (tracerExtraPostRollMs > 0) {
    label += ` + tracer post-roll bonus ${tracerExtraPostRollMs}ms`;
  }

  return {
    rawSetting: raw,
    blobState,
    saved,
    effective,
    tracerExtraPostRollMs,
    preRollFromUser,
    postRollFromUser,
    label,
  };
}

/** The subset of DetectAndTrimResult the diagnosis needs. */
export interface TrimOutcomeLike {
  found: boolean;
  impactTimeMs?: number | null;
  trimStartMs?: number | null;
  trimEndMs?: number | null;
  shotType?: string | null;
  confidence?: number | null;
  trimmedUri?: string | null;
}

export interface TrimMismatch {
  /** True when the applied window differs from the requested one by > tolerance. */
  mismatched: boolean;
  /** False when native returned no usable numbers to compare against. */
  comparable: boolean;
  /** impactTimeMs - trimStartMs. NaN when not comparable. */
  appliedPreRollMs: number;
  /** trimEndMs - impactTimeMs. NaN when not comparable. */
  appliedPostRollMs: number;
  /** trimEndMs - trimStartMs. NaN when not comparable. */
  appliedDurationMs: number;
  requestedDurationMs: number;
  /** applied - requested, per side. Positive = native kept MORE than asked. */
  preDeltaMs: number;
  postDeltaMs: number;
  /** Why, in plain words. Empty when nothing is wrong. */
  explanations: string[];
}

/**
 * Compare the window that was asked for against the window native applied.
 *
 * Three causes are told apart, because they have three different answers:
 *
 *  - THE PUTT FLOOR. Native raises the post-roll to 4000ms for anything
 *    classified `putt` (Swift:370). The user's setting is overridden, not
 *    bounded. This is the one that makes a 1.0s + 1.0s window come out as a
 *    5 second clip, and it fires on misclassified swings too.
 *  - RAN OUT OF FILE. `trimStart` is floored at 0 and `trimEnd` capped at the
 *    asset duration (Swift:373-374), so a swing near either end of the
 *    recording legitimately yields a shorter window. Not a bug — but it must
 *    not be confused with one.
 *  - ANYTHING ELSE. If neither explains it, native is not using the window it
 *    was handed, and that IS the bug the golfer is reporting.
 *
 * `sourceDurationMs` is optional — without it the end-of-file case cannot be
 * confirmed and is reported as unexplained rather than silently excused.
 */
export function diagnoseTrimMismatch(
  requested: TrimWindow,
  outcome: TrimOutcomeLike,
  opts?: { sourceDurationMs?: number | null; toleranceMs?: number }
): TrimMismatch {
  const tolerance = opts?.toleranceMs ?? 1;
  const requestedDurationMs = requested.preRollMs + requested.postRollMs;

  const impact = outcome.impactTimeMs;
  const start = outcome.trimStartMs;
  const end = outcome.trimEndMs;
  const usable =
    outcome.found === true &&
    typeof impact === 'number' && Number.isFinite(impact) &&
    typeof start === 'number' && Number.isFinite(start) &&
    typeof end === 'number' && Number.isFinite(end) &&
    end > start;

  if (!usable) {
    return {
      mismatched: false,
      comparable: false,
      appliedPreRollMs: NaN,
      appliedPostRollMs: NaN,
      appliedDurationMs: NaN,
      requestedDurationMs,
      preDeltaMs: NaN,
      postDeltaMs: NaN,
      explanations: outcome.found
        ? ['native returned no usable trim window to compare against']
        : ['no swing detected — nothing was trimmed, so there is no window to compare'],
    };
  }

  const impactMs = impact as number;
  const startMs = start as number;
  const endMs = end as number;

  const appliedPreRollMs = impactMs - startMs;
  const appliedPostRollMs = endMs - impactMs;
  const appliedDurationMs = endMs - startMs;
  const preDeltaMs = appliedPreRollMs - requested.preRollMs;
  const postDeltaMs = appliedPostRollMs - requested.postRollMs;

  const preOff = Math.abs(preDeltaMs) > tolerance;
  const postOff = Math.abs(postDeltaMs) > tolerance;
  const explanations: string[] = [];

  const isPutt = (outcome.shotType ?? '').toLowerCase() === 'putt';
  const conf =
    typeof outcome.confidence === 'number'
      ? ` at confidence ${outcome.confidence.toFixed(2)}`
      : '';
  const near = (a: number, b: number) => Math.abs(a - b) <= tolerance;

  // The OLD, buggy shape: post-roll itself raised to the floor, so the clip is
  // preRoll + 4000. Seeing this line means the installed binary predates the
  // fix and needs `npx expo run:ios --device`.
  const hitLegacyPostRollFloor =
    postDeltaMs > tolerance &&
    isPutt &&
    requested.postRollMs < NATIVE_PUTT_FLOOR_MS &&
    near(appliedPostRollMs, NATIVE_PUTT_FLOOR_MS);

  // The FIXED shape: the total is raised to the floor and no further.
  const hitTotalFloor =
    !hitLegacyPostRollFloor &&
    postDeltaMs > tolerance &&
    isPutt &&
    requestedDurationMs < NATIVE_PUTT_FLOOR_MS &&
    near(appliedDurationMs, NATIVE_PUTT_FLOOR_MS);

  const hitPuttFloor = hitLegacyPostRollFloor || hitTotalFloor;

  if (hitLegacyPostRollFloor) {
    explanations.push(
      `native raised the POST-ROLL alone to ${NATIVE_PUTT_FLOOR_MS}ms because this clip came ` +
        `back shotType='putt'${conf} — so the clip is your pre-roll + ${NATIVE_PUTT_FLOOR_MS}ms, ` +
        `not a ${NATIVE_PUTT_FLOOR_MS}ms clip. THIS BINARY PREDATES THE FIX: rebuild with ` +
        '`npx expo run:ios --device` (ShotDetectorModule.swift, detectAndTrimVideo)'
    );
  } else if (hitTotalFloor) {
    explanations.push(
      `native floors PUTTS to a ${NATIVE_PUTT_FLOOR_MS}ms TOTAL window and this clip came back ` +
        `shotType='putt'${conf} — expected, but note the classifier calls any recording ` +
        'longer than 12s a putt when pose detection finds no confident swing. Set ' +
        'config.detection.options.puttPostRollMs to change or disable the floor'
    );
  }

  const clippedAtStart = preDeltaMs < -tolerance && startMs <= tolerance;
  if (clippedAtStart) {
    explanations.push(
      `the recording only had ${round(appliedPreRollMs)}ms of footage before impact — ` +
        'pre-roll was cut short by the start of the file, not by a setting'
    );
  }

  const duration = opts?.sourceDurationMs;
  const clippedAtEnd =
    postDeltaMs < -tolerance &&
    typeof duration === 'number' &&
    Number.isFinite(duration) &&
    duration > 0 &&
    endMs >= duration - 50;
  if (clippedAtEnd) {
    explanations.push(
      `the recording only had ${round(appliedPostRollMs)}ms of footage after impact — ` +
        'post-roll was cut short by the end of the file, not by a setting'
    );
  }

  const preExplained = !preOff || clippedAtStart;
  const postExplained = !postOff || hitPuttFloor || clippedAtEnd;
  if (!preExplained || !postExplained) {
    explanations.push(
      'UNEXPLAINED — native did not use the window it was given, and neither the ' +
        'putt floor nor the length of the recording accounts for it'
    );
  }

  return {
    mismatched: preOff || postOff,
    comparable: true,
    appliedPreRollMs,
    appliedPostRollMs,
    appliedDurationMs,
    requestedDurationMs,
    preDeltaMs,
    postDeltaMs,
    explanations,
  };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/** Round for display: whole ms, no float noise from native's Doubles. */
function round(ms: number): number {
  return Number.isFinite(ms) ? Math.round(ms) : NaN;
}

/** "5.0s" for a millisecond count. */
function secs(ms: number): string {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : '?';
}

/** Stable label for one clip so interleaved batch lines can be paired up. */
function tag(path: TrimDiagPath, clipId?: string | number | null, where?: string): string {
  const id = clipId === null || clipId === undefined || clipId === '' ? '?' : String(clipId);
  return `${path} clip=${id}${where ? ` (${where})` : ''}`;
}

export interface TrimDiagRequestEntry {
  path: TrimDiagPath;
  clipId?: string | number | null;
  /** Free-form locator, e.g. "hole 3, shot 2". */
  where?: string;
  source: TrimWindowSource;
  /** What is actually being handed to detectAndTrim. Logged separately from
   *  `source.effective` on purpose: if a call site ever resolves a window and
   *  then passes something else, these two lines will disagree on screen. */
  requested: TrimWindow;
}

/** Steps 1-4: what was stored, what it resolved to, where from, what is passed. */
export function formatTrimRequestLines(entry: TrimDiagRequestEntry): string[] {
  const { source, requested } = entry;
  const p = TRIM_DIAG_PREFIX;
  const total = requested.preRollMs + requested.postRollMs;
  const lines = [
    `${p} ── ${tag(entry.path, entry.clipId, entry.where)} ──`,
    `${p} 1. raw trim_settings   = ${source.rawSetting === null ? 'null (never saved)' : source.rawSetting}`,
    `${p} 2. resolved window     = pre ${source.effective.preRollMs}ms + post ${source.effective.postRollMs}ms = ` +
      `${source.effective.preRollMs + source.effective.postRollMs}ms (${secs(source.effective.preRollMs + source.effective.postRollMs)})`,
    `${p} 3. window source       = ${source.label}`,
    `${p} 4. passed to native    = detectAndTrim(preRollMs=${requested.preRollMs}, postRollMs=${requested.postRollMs}) → ${total}ms asked for`,
  ];
  if (
    requested.preRollMs !== source.effective.preRollMs ||
    requested.postRollMs !== source.effective.postRollMs
  ) {
    lines.push(
      `${p}    ⚠️ line 2 and line 4 DISAGREE — the resolved window is not the one being passed`
    );
  }
  return lines;
}

export interface TrimDiagResultEntry {
  path: TrimDiagPath;
  clipId?: string | number | null;
  where?: string;
  /** The same numbers that were logged on line 4, restated so the mismatch
   *  line is readable on its own even when batch logs interleave. */
  requested: TrimWindow;
  outcome: TrimOutcomeLike;
  /** Length of the SOURCE file, when known — lets an end-of-file clip be told
   *  apart from a setting that was ignored. */
  sourceDurationMs?: number | null;
}

/** Steps 5-7: what native returned, the window that implies, and the verdict. */
export function formatTrimResultLines(entry: TrimDiagResultEntry): string[] {
  const p = TRIM_DIAG_PREFIX;
  const { outcome, requested } = entry;
  const verdict = diagnoseTrimMismatch(requested, outcome, {
    sourceDurationMs: entry.sourceDurationMs,
  });

  const lines = [
    `${p} 5. native returned     = found=${outcome.found} shotType=${outcome.shotType ?? 'n/a'} ` +
      `conf=${typeof outcome.confidence === 'number' ? outcome.confidence.toFixed(2) : 'n/a'} ` +
      `impact=${round(outcome.impactTimeMs ?? NaN)}ms ` +
      `trim=${round(outcome.trimStartMs ?? NaN)}..${round(outcome.trimEndMs ?? NaN)}ms ` +
      `trimmedFile=${outcome.trimmedUri ? 'yes' : 'NO'}`,
  ];

  if (!verdict.comparable) {
    lines.push(`${p} 6. applied window      = n/a`);
    lines.push(`${p} 7. verdict             = ${verdict.explanations[0] ?? 'nothing to compare'}`);
    return lines;
  }

  lines.push(
    `${p} 6. applied window      = pre ${round(verdict.appliedPreRollMs)}ms + post ${round(verdict.appliedPostRollMs)}ms = ` +
      `${round(verdict.appliedDurationMs)}ms clip (${secs(verdict.appliedDurationMs)})`
  );

  if (!verdict.mismatched) {
    lines.push(
      `${p} 7. verdict             = OK — applied window matches the ${verdict.requestedDurationMs}ms requested exactly`
    );
    return lines;
  }

  const parts: string[] = [];
  if (Math.abs(verdict.preDeltaMs) > 1) {
    parts.push(
      `pre-roll asked ${requested.preRollMs}ms, got ${round(verdict.appliedPreRollMs)}ms ` +
        `(${signed(verdict.preDeltaMs)}ms)`
    );
  }
  if (Math.abs(verdict.postDeltaMs) > 1) {
    parts.push(
      `post-roll asked ${requested.postRollMs}ms, got ${round(verdict.appliedPostRollMs)}ms ` +
        `(${signed(verdict.postDeltaMs)}ms)`
    );
  }
  lines.push(
    `${p} 7. ⚠️ MISMATCH         = ${parts.join('; ')} → clip is ${round(verdict.appliedDurationMs)}ms ` +
      `not ${verdict.requestedDurationMs}ms`
  );
  for (const why of verdict.explanations) {
    lines.push(`${p}    cause: ${why}`);
  }
  return lines;
}

/** "+3000" / "-500". */
function signed(ms: number): string {
  const r = round(ms);
  return r > 0 ? `+${r}` : String(r);
}

// ─── Console wrappers (the only impure things in this file) ──────────────────

function emit(lines: string[]): void {
  for (const line of lines) console.log(line);
}

/**
 * Print steps 1-4 BEFORE calling detectAndTrim, so a native call that hangs,
 * rejects or crashes still leaves the ask on the console.
 */
export function logTrimRequest(entry: TrimDiagRequestEntry): void {
  try {
    emit(formatTrimRequestLines(entry));
  } catch {
    // A diagnostic must never be the reason a trim does not happen.
  }
}

/** Print steps 5-7 after detectAndTrim resolves. */
export function logTrimResult(entry: TrimDiagResultEntry): void {
  try {
    emit(formatTrimResultLines(entry));
  } catch {
    // As above — swallowed on purpose.
  }
}
