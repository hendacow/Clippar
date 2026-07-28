/**
 * Pipeline event bus — the wire between the two real pipelines and the UI.
 *
 * Emitters:
 *   - app/round/editor.tsx composeReel flow → compose:* events
 *     (on-device reel composition — "building/stitching a reel")
 *   - hooks/useEditorState.ts processAllUntrimmed → trim:* events
 *     (the auto-trim batch that runs after a round import)
 *   - lib/uploadQueue.ts → backup:* events
 *     (cloud clip backup — never a reel state; never yields PROCESSING)
 *
 * Subscriber: contexts/UploadContext.tsx (the broadcaster) folds these
 * into ComposeState/BackupState for the UI; screens may also subscribe
 * directly (e.g. round detail refetches on compose:complete).
 *
 * Pure module — no react-native imports.
 */

export type PipelineEvent =
  | { type: 'compose:start'; roundId: string; courseName: string | null }
  | {
      /**
       * Phase transition inside a compose job.
       *
       *   - `preparing`  — pre-native work (clip recovery / music resolution).
       *     On slow LTE this can run for a while; it emits liveness labels but
       *     must NOT arm the 30s stall watchdog (there is no native progress to
       *     measure yet).
       *   - `composing`  — the native composeReel stage has truly begun. This is
       *     the ONLY signal that arms the watchdog.
       */
      type: 'compose:stage';
      roundId: string;
      stage: 'preparing' | 'composing';
      stageLabel: string;
    }
  | {
      type: 'compose:progress';
      roundId: string;
      stageLabel: string;
      /** Real percent from the native stitcher, or null (indeterminate).
       *  Never a fake percent. */
      percent: number | null;
    }
  | { type: 'compose:complete'; roundId: string }
  | { type: 'compose:error'; roundId: string; cause: string }
  /**
   * Auto-trim batch (import pipeline). The batch is a plain "N of M clips
   * done" counter — there is no per-clip percent to report, and inventing one
   * would be the fake-percent mistake compose:progress exists to avoid.
   *
   * `trim:complete` is TERMINAL and is emitted from a `finally`, so it fires
   * on success, on a thrown batch, and on cancellation alike — a subscriber
   * can treat it as "the indicator must go away now" without a watchdog.
   */
  | { type: 'trim:start'; roundId: string; courseName: string | null; total: number }
  | { type: 'trim:progress'; roundId: string; completed: number; total: number }
  | { type: 'trim:complete'; roundId: string }
  | { type: 'backup:progress'; roundId: string; currentClip: number; totalClips: number }
  | { type: 'backup:paused' }
  | { type: 'backup:complete'; roundId: string }
  | { type: 'backup:error'; roundId: string; message: string }
  | { type: 'backup:idle' };

type PipelineListener = (event: PipelineEvent) => void;

const listeners = new Set<PipelineListener>();

export function subscribePipeline(listener: PipelineListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitPipelineEvent(event: PipelineEvent): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(event);
    } catch {
      // A broken subscriber must never break the pipeline.
    }
  }
}
