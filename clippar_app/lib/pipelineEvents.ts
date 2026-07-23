/**
 * Pipeline event bus — the wire between the two real pipelines and the UI.
 *
 * Emitters:
 *   - app/round/editor.tsx composeReel flow → compose:* events
 *     (on-device reel composition — "building/stitching a reel")
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
      type: 'compose:progress';
      roundId: string;
      stageLabel: string;
      /** Real percent from the native stitcher, or null (indeterminate).
       *  Never a fake percent. */
      percent: number | null;
    }
  | { type: 'compose:complete'; roundId: string }
  | { type: 'compose:error'; roundId: string; cause: string }
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
