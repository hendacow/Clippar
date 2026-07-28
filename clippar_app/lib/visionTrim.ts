/**
 * swing-vision → shot-detector result adapter (ADDITIVE — nothing here
 * replaces or removes the shot-detector path).
 *
 * WHY THIS EXISTS
 * The auto-trim call sites all consume a `DetectAndTrimResult` and then run a
 * fair amount of state + SQLite persistence off it. Rather than duplicate that
 * persistence for the vision path, this module runs swing-vision and returns
 * the SAME shape, so every downstream branch (React state, markClipTrimmed,
 * updateClipEditorState, detectionLog, the [TRIM] log lines) stays byte-for-byte
 * the code that already ships.
 *
 * CONTRACT
 *   - Returns `null` whenever the caller should fall through to the existing
 *     `detectAndTrim` path: module/model not in this build, native call
 *     rejected, or the passthrough trim did not actually produce a file. A
 *     vision failure must never lose a clip.
 *   - Returns a synthesized `DetectAndTrimResult` otherwise.
 *
 * MAPPING (see modules/swing-vision/highlightTrim.ts for the policy)
 *   plan.trim === true            → found, trimmedUri set, window = plan bounds
 *   putt                          → found, trimmedUri null, shotType 'putt'
 *                                   (existing "putt keeps the full clip" branch)
 *   swing but clip already ≤ 5s   → found, trimmedUri null, shotType 'swing'
 *                                   (existing "mark processed, keep original")
 *   NO_SWING                      → found: false (existing no-swing branch)
 *
 * NOTE: the highlight policy is fixed at 5s with a 2s lead-in, so the user's
 * pre-roll / post-roll trim settings do NOT apply when the vision path wins.
 * They still apply whenever this falls through to shot-detector.
 */
import * as swingVision from 'swing-vision';
import { trimVideo, type DetectAndTrimResult } from 'shot-detector';

/**
 * Value written to `DetectAndTrimResult.chosenStrategy`, which is what
 * lib/detectionLog.ts records as the row's `strategy`. Keeping it distinct
 * from the native strategy names is the whole point: it makes the A/B log
 * directly comparable between the two detectors.
 */
export const VISION_STRATEGY_LABEL = 'swingVision';

/** True when the swing-vision native module AND its model are in this build. */
export function isVisionTrimAvailable(): boolean {
  try {
    return swingVision.isAvailable();
  } catch {
    return false;
  }
}

/**
 * Localize the swing with swing-vision and, when the policy says so,
 * passthrough-trim the clip — returning a `DetectAndTrimResult` the existing
 * call sites already know how to persist.
 *
 * @returns null when the caller must fall back to `detectAndTrim`.
 */
export async function visionDetectAndTrim(
  videoUri: string,
  window?: { preRollMs: number; postRollMs: number }
): Promise<DetectAndTrimResult | null> {
  if (!isVisionTrimAvailable()) return null;

  try {
    const r = await swingVision.localizeSwing(videoUri);
    // LocalizeResult is structurally a HighlightInput — pass it whole so the
    // policy can see wristHeight and word its reason honestly.
    //
    // The WINDOW comes from the caller, not from the policy's own defaults.
    // Those defaults are 5s/2s lead-in; the app's window is 4s (2500 pre +
    // 1500 post) and the user can change it in Profile -> Trim settings. Left
    // to itself the policy would silently overrule that, which is a visible
    // change to every trimmed clip that nobody asked for.
    const plan = swingVision.planHighlightTrim(
      r,
      window
        ? {
            leadInSec: window.preRollMs / 1000,
            totalSec: (window.preRollMs + window.postRollMs) / 1000,
          }
        : {}
    );

    const confidence = typeof r.confidence === 'number' ? r.confidence : 0;
    const impactTimeMs =
      typeof r.tImpact === 'number' ? Math.round(r.tImpact * 1000) : 0;

    if (!plan.trim) {
      // LEAVE THE CLIP UNCHANGED. Each case maps onto a branch that already
      // exists at every call site, so the clip lands in a state the app
      // already understands.
      if (r.decision === 'SWING') {
        console.log(
          `[SwingVision] ${plan.reason} — clip unchanged ` +
            `(strokeType=${r.strokeType ?? 'unknown'}, ${Math.round(r.elapsedMs)}ms)`
        );
        return {
          found: true,
          trimmedUri: null,
          shotType: r.strokeType === 'putt' ? 'putt' : 'swing',
          impactTimeMs,
          trimStartMs: 0,
          trimEndMs: -1,
          confidence,
          chosenStrategy: VISION_STRATEGY_LABEL,
        };
      }
      console.log(
        `[SwingVision] ${plan.reason} (${Math.round(r.elapsedMs)}ms, ` +
          `${r.candidates.length} candidates)`
      );
      return {
        found: false,
        trimmedUri: null,
        shotType: 'swing',
        impactTimeMs: 0,
        trimStartMs: 0,
        trimEndMs: 0,
        confidence: 0,
        chosenStrategy: VISION_STRATEGY_LABEL,
      };
    }

    const trimStartMs = Math.round(plan.startSec * 1000);
    const trimEndMs = Math.round(plan.endSec * 1000);
    // Passthrough trim — no re-encode, so 4K stays 4K. Same call the dev
    // harness and the shot-detector path use.
    const trimmed = await trimVideo(videoUri, trimStartMs, trimEndMs);
    const trimmedUri = trimmed?.trimmedUri ?? null;
    // trimVideo returns the ORIGINAL uri when shot-detector native is missing.
    // That is not a trim — fall through rather than record a bogus window.
    if (!trimmedUri || trimmedUri === videoUri) {
      console.warn(
        '[SwingVision] trim produced no new file — falling back to shot-detector'
      );
      return null;
    }

    console.log(
      `[SwingVision] ${plan.reason} → ${trimStartMs}..${trimEndMs}ms ` +
        `(${Math.round(r.elapsedMs)}ms localize, ` +
        `wristHeight=${r.wristHeight?.toFixed(2) ?? 'n/a'})`
    );

    return {
      found: true,
      trimmedUri,
      shotType: 'swing',
      impactTimeMs,
      trimStartMs,
      trimEndMs,
      confidence,
      chosenStrategy: VISION_STRATEGY_LABEL,
    };
  } catch (err) {
    // Never let a vision failure lose a clip or block the editor.
    console.warn('[SwingVision] localize/trim failed — falling back to shot-detector:', err);
    return null;
  }
}
