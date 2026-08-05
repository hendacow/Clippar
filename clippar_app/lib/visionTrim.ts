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
 *     `detectAndTrim` path: the config flag is off, module/model not in this
 *     build, native call rejected, NO swing found, or the passthrough trim did
 *     not actually produce a file. A vision failure must never lose a clip.
 *   - Returns a synthesized `DetectAndTrimResult` otherwise.
 *
 * This module can therefore only ADD detections, never remove one — every path
 * where it does not confidently locate a swing ends in the old detector
 * running exactly as it does today.
 *
 * MAPPING (see modules/swing-vision/highlightTrim.ts for the policy)
 *   plan.trim === true              → found, trimmedUri set, window = plan bounds
 *   putt SEEN BY POSE               → found, trimmedUri null, shotType 'putt',
 *                                     confidence above the shotPolicy bar
 *                                     (existing "putt keeps the full clip" branch)
 *   putt GUESSED without pose       → trimmed as a swing — see STROKE TYPE below
 *   swing but clip already ≤ window → found, trimmedUri null, shotType 'swing'
 *                                     (existing "mark processed, keep original")
 *   NO_SWING                        → null, shot-detector decides
 */
import * as swingVision from 'swing-vision';
import { trimVideo, type DetectAndTrimResult } from 'shot-detector';
import { config } from '@/constants/config';
import { resolveVisionStroke } from '@/lib/shotPolicy';

/**
 * Value written to `DetectAndTrimResult.chosenStrategy`, which is what
 * lib/detectionLog.ts records as the row's `strategy`. Keeping it distinct
 * from the native strategy names is the whole point: it makes the A/B log
 * directly comparable between the two detectors.
 */
export const VISION_STRATEGY_LABEL = 'swingVision';

/** True when the swing-vision native module AND its model are in this build. */
export function isVisionTrimAvailable(): boolean {
  // The config flag is checked FIRST and before anything touches native, so
  // `swingVision: false` is byte-for-byte the old path — the same route already
  // taken when the module is missing from the build (Expo Go, web).
  if (!config.detection.swingVision) return false;
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

    // STROKE TYPE AND CONFIDENCE both come from the shared policy — see
    // resolveVisionStroke in lib/shotPolicy.ts for why a putt only counts when
    // pose saw it, and why the native prototype score cannot be passed through
    // as a confidence.
    const { strokeType, confidence } = resolveVisionStroke(r);

    // LocalizeResult is structurally a HighlightInput — pass it whole so the
    // policy can see wristHeight and word its reason honestly, but with the
    // stroke type resolved above rather than the raw native one.
    //
    // The WINDOW comes from the caller, not from the policy's own defaults.
    // Those defaults are 5s/2s lead-in; the app's window is 4s (2500 pre +
    // 1500 post) and the user can change it in Profile -> Trim settings. Left
    // to itself the policy would silently overrule that, which is a visible
    // change to every trimmed clip that nobody asked for.
    const plan = swingVision.planHighlightTrim(
      { ...r, strokeType },
      window
        ? {
            leadInSec: window.preRollMs / 1000,
            totalSec: (window.preRollMs + window.postRollMs) / 1000,
          }
        : {}
    );

    const impactTimeMs =
      typeof r.tImpact === 'number' ? Math.round(r.tImpact * 1000) : 0;

    if (!plan.trim) {
      // LEAVE THE CLIP UNCHANGED. Each case maps onto a branch that already
      // exists at every call site, so the clip lands in a state the app
      // already understands.
      if (r.decision === 'SWING') {
        console.log(
          `[SwingVision] ${plan.reason} — clip unchanged ` +
            `(strokeType=${strokeType}, wristHeight=${r.wristHeight?.toFixed(2) ?? 'n/a'}, ` +
            `${Math.round(r.elapsedMs)}ms)`
        );
        return {
          found: true,
          trimmedUri: null,
          shotType: strokeType,
          impactTimeMs,
          trimStartMs: 0,
          trimEndMs: -1,
          confidence,
          chosenStrategy: VISION_STRATEGY_LABEL,
        };
      }
      // NOTHING FOUND — HAND THE CLIP TO SHOT-DETECTOR, don't answer for it.
      //
      // Returning `found: false` here would end the clip's processing on this
      // detector's abstention: it marks the clip processed and keeps it at full
      // length, so shot-detector never gets a look. That turns "swing-vision
      // couldn't see it" into "the app couldn't see it", and a clip the old
      // path would have trimmed comes back whole.
      //
      // Falling through costs one extra detector run on the clips vision
      // rejects, and in exchange this feature can only ever add detections,
      // never remove one. That asymmetry is the whole reason it is safe to
      // default on.
      console.log(
        `[SwingVision] ${plan.reason} (${Math.round(r.elapsedMs)}ms, ` +
          `${r.candidates.length} candidates) — falling back to shot-detector`
      );
      return null;
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
