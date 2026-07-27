/**
 * Pure, testable decision logic for the on-device vision swing classifier.
 * EXPERIMENTAL — not imported by the app yet. The Swift SwingVisionClassifier
 * produces per-frame class scores; this file turns a clip's frames into one
 * decision. Kept as pure functions so it runs under `node --test` with no
 * native / Core ML dependency, exactly like lib/liveRecordingLogic.ts.
 *
 * The class set matches class_text_embeddings.json (baked from MobileCLIP2-S2):
 *   full_swing | address | putt_chip | no_shot
 */

export type VisionClass = 'full_swing' | 'address' | 'putt_chip' | 'no_shot';

export const VISION_CLASSES: VisionClass[] = [
  'full_swing',
  'address',
  'putt_chip',
  'no_shot',
];

/** Softmax probabilities for ONE frame, keyed by class. */
export type FrameScores = Record<VisionClass, number>;

export type ClipDecision = 'FULL_SWING' | 'PUTT_CHIP' | 'NO_SHOT' | 'UNSURE';

export interface DecisionThresholds {
  /** Min pooled full_swing to call a full swing. */
  fullSwing: number;
  /** Min pooled no_shot (with low full_swing) to discard the clip. */
  noShot: number;
  /** How many of the top frames to average when pooling (robustness vs a
   *  single lucky/unlucky frame — mean-of-top-k, not a raw max). */
  topK: number;
  /** full_swing must beat putt_chip by at least this margin to win, so a
   *  chip's single mini-swing frame doesn't masquerade as a full swing. */
  swingOverPuttMargin: number;
}

export const DEFAULT_THRESHOLDS: DecisionThresholds = {
  fullSwing: 0.45,
  noShot: 0.5,
  topK: 3,
  swingOverPuttMargin: 0.08,
};

/** Cosine similarity of a normalized image embedding to each (normalized)
 *  class text embedding, then softmax — the JS mirror of the Swift path, used
 *  by tests and any desktop re-validation. Temperature matches the eval. */
export function classifyFrame(
  imageEmbedding: number[],
  classEmbeddings: Record<VisionClass, number[]>,
  temperature = 100
): FrameScores {
  const sims = VISION_CLASSES.map((c) =>
    cosine(imageEmbedding, classEmbeddings[c])
  );
  const scaled = sims.map((s) => s * temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const out = {} as FrameScores;
  VISION_CLASSES.forEach((c, i) => {
    out[c] = exps[i] / sum;
  });
  return out;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Pool a clip's per-frame scores into one score per class using mean-of-top-k
 * (robust to a single outlier frame — a chip's one mini-swing frame no longer
 * dominates, and a full swing's ~1s finish still registers across several
 * frames).
 */
export function poolFrames(
  frames: FrameScores[],
  topK: number
): FrameScores {
  const pooled = {} as FrameScores;
  for (const c of VISION_CLASSES) {
    const vals = frames
      .map((f) => f[c])
      .sort((a, b) => b - a)
      .slice(0, Math.max(1, topK));
    pooled[c] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  return pooled;
}

/**
 * Decide the clip class from its per-frame scores. Returns the label AND the
 * pooled evidence, so the (future) fusion layer can weigh it against pose +
 * audio rather than trust it blindly.
 */
export function decideClip(
  frames: FrameScores[],
  thresholds: DecisionThresholds = DEFAULT_THRESHOLDS
): { label: ClipDecision; pooled: FrameScores } {
  if (frames.length === 0) {
    return {
      label: 'UNSURE',
      pooled: { full_swing: 0, address: 0, putt_chip: 0, no_shot: 0 },
    };
  }
  const pooled = poolFrames(frames, thresholds.topK);

  const swingWinsPutt =
    pooled.full_swing >= pooled.putt_chip + thresholds.swingOverPuttMargin;

  let label: ClipDecision;
  if (pooled.full_swing >= thresholds.fullSwing && swingWinsPutt) {
    label = 'FULL_SWING';
  } else if (
    pooled.no_shot >= thresholds.noShot &&
    pooled.full_swing < thresholds.fullSwing
  ) {
    label = 'NO_SHOT';
  } else if (pooled.putt_chip >= pooled.address) {
    label = 'PUTT_CHIP';
  } else {
    // Golfer present, addressing, no decisive swing seen — don't force a call.
    label = 'UNSURE';
  }
  return { label, pooled };
}
