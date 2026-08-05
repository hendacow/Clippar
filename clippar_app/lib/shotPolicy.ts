/**
 * What the app does with a detected shot — the one place that decides.
 *
 * WHY THIS EXISTS. On 2026-08-05 putts were changed to keep the whole
 * recording (a window centred on impact cuts off the ball travelling to the
 * hole). That is the right rule. Applying it to `shotType === 'putt'` alone
 * was not, and it left roughly half of a real 36-clip round uncut.
 *
 * The reason is that `shotType` is two different qualities of answer wearing
 * one name:
 *
 *   - The POSE state machine actually watches the swing and reports from
 *     confidence 0.6 upward. That is a classification.
 *   - `fallbackClassify` runs when pose finds nothing and guesses from clip
 *     duration and audio transients. Every branch of it returns 0.20–0.35 —
 *     including `durationLong`, which calls ANY recording over 12 seconds a
 *     putt on length alone (ShotDetectorModule.swift ~:1461). That is not a
 *     classification, it is a shrug.
 *
 * A shrug must not decide whether a golfer's shot gets trimmed. So keeping
 * the full recording requires a putt the detector genuinely saw; everything
 * else is trimmed to the user's window, which is what the app did before and
 * what it does well.
 */

/**
 * Lowest confidence that means "the detector actually classified this",
 * rather than "the detector gave up and guessed from the clip's length".
 *
 * 0.5 sits in the empty gap between the two: the fallback's ceiling is 0.35,
 * the pose state machine's floor is 0.6. Nothing in the codebase emits a
 * value in between, so this threshold cannot split a real classification.
 */
export const REAL_CLASSIFICATION_MIN_CONFIDENCE = 0.5;

export interface ShotOutcomeLike {
  found: boolean;
  shotType?: string | null;
  confidence?: number | null;
}

/**
 * True when the detector genuinely classified the shot, false when the
 * result came from the duration/audio fallback.
 */
export function isConfidentClassification(outcome: ShotOutcomeLike): boolean {
  const c = outcome.confidence;
  return typeof c === 'number' && Number.isFinite(c) && c >= REAL_CLASSIFICATION_MIN_CONFIDENCE;
}

/**
 * True when the clip should be left at its full recorded length instead of
 * trimmed to the user's window.
 *
 * Only a CONFIDENTLY detected putt qualifies. A low-confidence "putt" is the
 * fallback guessing from duration, and trimming it to the requested window is
 * both what the user asked for and what the app did before putts were given
 * their own path.
 */
export function shouldKeepFullRecording(outcome: ShotOutcomeLike): boolean {
  if (!outcome.found) return false;
  if (outcome.shotType !== 'putt') return false;
  return isConfidentClassification(outcome);
}

/*
 * ---------------------------------------------------------------------------
 * SWING-VISION → the scale above
 * ---------------------------------------------------------------------------
 * swing-vision reports a `confidence` that is the image-prototype score,
 * ~0.0–0.1 by nature: every candidate frame is a golf course, so the three
 * prototypes sit at cosine ~0.95 to each other and the discrimination lives in
 * small consistent differences. Meaningful inside the localizer, meaningless
 * against the threshold above — passed through raw it would put EVERY vision
 * result below the bar, including the pose classifications that are the most
 * reliable signal the app has.
 *
 * So the translation happens here, next to the threshold it has to agree with,
 * rather than by loosening that threshold.
 */

/**
 * Stroke type was decided by BODY POSE — peak wrist height in torso lengths,
 * measured 52/56 on 56 labelled clips (22/25 on putts specifically). That is a
 * real classification in the sense this module means, so it sits above the bar
 * alongside the pose state machine's own 0.6+ range.
 */
export const VISION_POSE_CONFIDENCE = 0.75;

/**
 * Vision could not lock on to a body, so stroke type fell back to motion
 * amplitude. The Swift is explicit that this fallback threshold is NOT
 * MEASURED — on all 56 labelled clips pose locked on, so the path never
 * executed and there is no evidence for its value. Below the bar, which is
 * what marks it a guess.
 */
export const VISION_MOTION_FALLBACK_CONFIDENCE = 0.3;

export interface VisionStrokeInput {
  strokeType?: 'swing' | 'putt';
  /** Present exactly when Vision locked on to a body and pose decided. */
  wristHeight?: number | null;
}

export interface VisionStroke {
  /** What the trim policy should act on. */
  strokeType: 'swing' | 'putt';
  /** On the same scale `isConfidentClassification` reads. */
  confidence: number;
  poseDecided: boolean;
}

/**
 * Translate a swing-vision result into the stroke type and confidence the rest
 * of the app reasons about.
 *
 * A PUTT ONLY COUNTS WHEN POSE SAW IT. The rule above — a guess must never be
 * what keeps a clip untrimmed — is what this enforces for the vision path:
 * with no pose reading, `putt` is a residue label that non-golf footage lands
 * in too, so it is trimmed to the user's window like any other shot.
 *
 * This deliberately overrides swing-vision's own preference, which leans the
 * other way (leave it alone when unsure, because trimming a putt by mistake
 * destroys footage while leaving one whole merely fails to help). That
 * argument is sound in isolation and predates the 36-clip round that showed
 * what the opposite failure costs. The localizer's INSTANT is used either way;
 * only the keep-or-trim decision changes.
 */
export function resolveVisionStroke(r: VisionStrokeInput): VisionStroke {
  const poseDecided = typeof r.wristHeight === 'number' && Number.isFinite(r.wristHeight);
  return {
    strokeType: r.strokeType === 'putt' && poseDecided ? 'putt' : 'swing',
    confidence: poseDecided ? VISION_POSE_CONFIDENCE : VISION_MOTION_FALLBACK_CONFIDENCE,
    poseDecided,
  };
}
