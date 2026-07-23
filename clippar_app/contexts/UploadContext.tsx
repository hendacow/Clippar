/**
 * Pipeline progress broadcaster.
 *
 * This context used to own an ungated cloud-upload flow (`startUpload` /
 * `runUpload`) that screens could trigger directly — the root cause of
 * "tapping rebuild silently uploads clips". That surface is GONE:
 *
 *   - On-device reel composition is triggered ONLY via
 *     /round/editor?roundId={id}&recompose=1 (the editor's export flow).
 *   - Cloud backup flows ONLY through the gated lib/uploadQueue.ts
 *     (enqueueRoundUpload / processUploadQueue).
 *
 * What remains here is a read-only broadcaster: it subscribes to
 * lib/pipelineEvents.ts (fed by the editor's composeReel flow and the
 * backup queue) and folds the events into ComposeState/BackupState for
 * the UI. It also runs the 30s compose watchdog — but only AFTER the native
 * composeReel stage has begun (compose:stage → 'composing'). A stalled native
 * render with no progress for 30s flips to FAILED ("Rendering didn't finish"),
 * so there is never an eternal spinner; the pre-native clip-recovery/music
 * phase (which can legitimately exceed 30s on slow LTE) does NOT arm it.
 */
import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import {
  subscribePipeline,
  emitPipelineEvent,
  type PipelineEvent,
} from '@/lib/pipelineEvents';
import { COMPOSE_WATCHDOG_MS, FAILURE_CAUSE } from '@/lib/roundStatusLogic';

export interface ComposeState {
  /** A local compose job is running right now (any phase). */
  active: boolean;
  /**
   * The native composeReel stage has actually begun (i.e. the pre-native
   * clip-recovery / music-resolution work is done). ONLY once this is true
   * does the 30s stall watchdog arm — a slow-LTE recovery phase must never
   * be mistaken for a stalled render.
   */
  nativeStarted: boolean;
  roundId: string | null;
  courseName: string | null;
  /** Stage label per the copy sheet (e.g. "Stitching your reel…"). */
  stageLabel: string;
  /** Real percent from the native stitcher, or null (indeterminate). */
  percent: number | null;
  /** Last compose attempt failed (error or watchdog). */
  failed: boolean;
  failedRoundId: string | null;
  /** Human cause per the copy sheet — never a raw error code. */
  failedCause: string | null;
  /** Set on compose:complete so screens can refetch the affected round. */
  lastCompletedRoundId: string | null;
}

export interface BackupState {
  status: 'idle' | 'uploading' | 'paused' | 'failed' | 'done';
  roundId: string | null;
  currentClip: number;
  totalClips: number;
}

interface UploadContextType {
  compose: ComposeState;
  backup: BackupState;
  /** Clear a surfaced compose failure (after the user taps "Try again"). */
  dismissComposeError: () => void;
}

const INITIAL_COMPOSE: ComposeState = {
  active: false,
  nativeStarted: false,
  roundId: null,
  courseName: null,
  stageLabel: '',
  percent: null,
  failed: false,
  failedRoundId: null,
  failedCause: null,
  lastCompletedRoundId: null,
};

const INITIAL_BACKUP: BackupState = {
  status: 'idle',
  roundId: null,
  currentClip: 0,
  totalClips: 0,
};

const UploadContext = createContext<UploadContextType>({
  compose: INITIAL_COMPOSE,
  backup: INITIAL_BACKUP,
  dismissComposeError: () => {},
});

export function useUploadContext() {
  return useContext(UploadContext);
}

export function UploadProvider({ children }: { children: ReactNode }) {
  const [compose, setCompose] = useState<ComposeState>(INITIAL_COMPOSE);
  const [backup, setBackup] = useState<BackupState>(INITIAL_BACKUP);

  // Watchdog bookkeeping — refreshed on every compose event.
  const lastComposeSignalRef = useRef<number>(0);
  const activeComposeRoundRef = useRef<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribePipeline((event: PipelineEvent) => {
      switch (event.type) {
        case 'compose:start':
          lastComposeSignalRef.current = Date.now();
          activeComposeRoundRef.current = event.roundId;
          setCompose({
            ...INITIAL_COMPOSE,
            active: true,
            // Native compose has NOT started yet — clip recovery/music
            // resolution run first. Watchdog stays disarmed until the
            // `composing` stage arrives.
            nativeStarted: false,
            roundId: event.roundId,
            courseName: event.courseName,
            stageLabel: 'Getting your clips…',
          });
          break;
        case 'compose:stage':
          // Refresh the stall reference on every phase transition so the
          // watchdog (once armed) always measures from the true native start.
          lastComposeSignalRef.current = Date.now();
          activeComposeRoundRef.current = event.roundId;
          setCompose((prev) => ({
            ...prev,
            active: true,
            roundId: event.roundId,
            stageLabel: event.stageLabel,
            // Only the `composing` stage arms the watchdog.
            nativeStarted: event.stage === 'composing' ? true : prev.nativeStarted,
          }));
          break;
        case 'compose:progress':
          // Any real native progress resets the stall timer (F2b).
          lastComposeSignalRef.current = Date.now();
          setCompose((prev) => ({
            ...prev,
            active: true,
            // Native progress implies the native stage is running.
            nativeStarted: true,
            roundId: event.roundId,
            stageLabel: event.stageLabel,
            percent: event.percent,
          }));
          break;
        case 'compose:complete':
          activeComposeRoundRef.current = null;
          setCompose((prev) => ({
            ...prev,
            active: false,
            nativeStarted: false,
            roundId: null,
            stageLabel: '',
            percent: null,
            failed: false,
            failedRoundId: null,
            failedCause: null,
            lastCompletedRoundId: event.roundId,
          }));
          break;
        case 'compose:error':
          activeComposeRoundRef.current = null;
          setCompose((prev) => ({
            ...prev,
            active: false,
            nativeStarted: false,
            roundId: null,
            stageLabel: '',
            percent: null,
            failed: true,
            failedRoundId: event.roundId,
            failedCause: event.cause,
          }));
          break;
        case 'backup:progress':
          setBackup({
            status: 'uploading',
            roundId: event.roundId,
            currentClip: event.currentClip,
            totalClips: event.totalClips,
          });
          break;
        case 'backup:paused':
          setBackup((prev) => ({ ...prev, status: 'paused' }));
          break;
        case 'backup:complete':
          setBackup((prev) => ({ ...prev, status: 'done', roundId: event.roundId }));
          break;
        case 'backup:error':
          // Backup failure is never styled as a reel problem — the queue
          // auto-retries silently on the next trigger/connectivity restore.
          setBackup((prev) => ({ ...prev, status: 'failed' }));
          break;
        case 'backup:idle':
          setBackup(INITIAL_BACKUP);
          break;
      }
    });
    return unsubscribe;
  }, []);

  // 30s compose watchdog — a genuine-stall backstop, armed ONLY once the
  // native composeReel stage has begun (compose.nativeStarted). Arming it at
  // compose:start would misfire during a slow-LTE clip-recovery/music phase
  // that legitimately exceeds 30s, flip the job to FAILED while it is still
  // running, and let a Retry launch a second concurrent compose. It resets on
  // every compose:progress (lastComposeSignalRef), so it only fires after a
  // real, running native stage produces no progress for 30s.
  useEffect(() => {
    if (!compose.nativeStarted) return;
    const interval = setInterval(() => {
      const roundId = activeComposeRoundRef.current;
      if (!roundId) return;
      if (Date.now() - lastComposeSignalRef.current > COMPOSE_WATCHDOG_MS) {
        emitPipelineEvent({
          type: 'compose:error',
          roundId,
          cause: FAILURE_CAUSE.didNotFinish,
        });
      }
    }, 5_000);
    return () => clearInterval(interval);
  }, [compose.nativeStarted]);

  const dismissComposeError = useCallback(() => {
    setCompose((prev) => ({
      ...prev,
      failed: false,
      failedRoundId: null,
      failedCause: null,
    }));
  }, []);

  return (
    <UploadContext.Provider value={{ compose, backup, dismissComposeError }}>
      {children}
    </UploadContext.Provider>
  );
}
