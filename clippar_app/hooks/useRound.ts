import { useState, useCallback, useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { RoundState, HoleScore, ClipMetadata, PenaltyType, HoleData } from '@/types/round';
import { PENALTY_STROKES } from '@/types/round';
import type { ShotTypeClassification } from 'shot-detector';
import { createRound, updateRound, upsertScore } from '@/lib/api';
import { deleteFile } from 'shot-detector';
import {
  lastHoleOf,
  findLastClipIndexOnHole,
  previousHoleTarget,
  resumeShotNumber,
  upsertHoleScore,
  clampRecoveredPointer,
  insertClipInOrder,
  nextShotCounterAfterClip,
  departingHoleStrokes,
} from '@/lib/liveRecordingLogic';
import {
  saveLocalRound,
  updateLocalRound,
  saveLocalScore,
  getLocalRound,
  getLocalScores,
  getClipsForRound,
  deleteLocalRound,
  deleteLocalClip,
  restoreLocalClip,
  commitClipDeletion,
  resetRoundData,
  type LocalClipRow,
} from '@/lib/storage';

const DEFAULT_PAR = 4;

function createInitialState(
  roundId: string,
  courseName: string,
  courseId: string | undefined,
  courseHoles: HoleData[] | undefined,
  holesPlayed: 9 | 18,
  startHole: 1 | 10,
): RoundState {
  return {
    roundId,
    courseId,
    courseName,
    currentHole: startHole,
    currentShot: 1,
    isRecording: false,
    scores: [],
    clips: [],
    totalScore: 0,
    totalPar: 0,
    courseHoles,
    holesPlayed,
    startHole,
    status: 'in_progress',
  };
}

// lastHoleOf (where the round naturally ends) moved to
// lib/liveRecordingLogic so the node test runner can exercise it. Used by
// endHole and addPenalty pickup branches to decide when to mark the round
// 'finished'.

function getParForHole(courseHoles: HoleData[] | undefined, holeNumber: number): number {
  if (!courseHoles) return DEFAULT_PAR;
  const hole = courseHoles.find((h) => h.holeNumber === holeNumber);
  return hole?.par ?? DEFAULT_PAR;
}

export function useRound() {
  const [state, setState] = useState<RoundState | null>(null);
  // Track the last classified shot type for auto hole detection
  const lastShotTypeRef = useRef<ShotTypeClassification | null>(null);
  // Debounce for endHole — a physical double-tap on Next Hole (common on a
  // sunlit touchscreen with a glove) would otherwise run the updater twice,
  // scoring a phantom 1-stroke hole and skipping a real one.
  const lastEndHoleAtRef = useRef(0);
  // Same guard for Previous Hole, which sits right next to Next Hole in the
  // bottom bar — without it a gloved double-tap steps back two holes.
  const lastPreviousHoleAtRef = useRef(0);

  // Undo stack for "Delete last shot". Each entry holds the full SQLite row
  // plus the in-memory ClipMetadata, so a restore puts the shot back in both
  // places. The underlying video files are deliberately NOT unlinked while a
  // clip sits on this stack — they're what makes the restore real. Files are
  // released when an entry is evicted (cap) or the round ends.
  const deletedStackRef = useRef<
    { row: LocalClipRow | null; clip: ClipMetadata; fileUris: string[] }[]
  >([]);
  // Mirrored into state so the settings sheet re-renders when undo becomes
  // available (a ref alone wouldn't trigger a render).
  const [undoableDeleteCount, setUndoableDeleteCount] = useState(0);
  const UNDO_STACK_LIMIT = 10;

  // Drop the undo stack and unlink the files it was holding onto. Called when
  // the round ends / is discarded / is reset, at which point an undo is no
  // longer meaningful and the footage is just dead weight on disk.
  const purgeDeletedClips = useCallback(() => {
    for (const entry of deletedStackRef.current) {
      // The undo window is closing for good — NOW apply the predecessor tracer
      // invalidation that the undoable delete deferred, then free the files.
      if (entry.row) commitClipDeletion(entry.row);
      for (const uri of entry.fileUris) {
        deleteFile(uri).catch(() => {});
      }
    }
    deletedStackRef.current = [];
    setUndoableDeleteCount(0);
  }, []);

  const startRound = useCallback(async (
    courseName: string,
    courseId?: string,
    courseHoles?: HoleData[],
    // Wave 3: round setup options. Defaults preserve pre-Wave-3 behavior
    // (full 18 starting at hole 1) so any caller that hasn't been updated
    // yet keeps working.
    holesPlayed: 9 | 18 = 18,
    startHole: 1 | 10 = 1,
  ) => {
    lastShotTypeRef.current = null;
    try {
      const round = await createRound({
        course_name: courseName,
        course_id: courseId,
        holes_played: holesPlayed,
        start_hole: startHole,
      });

      if (!round) throw new Error('Failed to create round');

      await saveLocalRound({
        id: round.id,
        course_name: courseName,
        course_id: courseId,
        holes_played: holesPlayed,
        start_hole: startHole,
        // Persist the scorecard so a resumed round keeps its real pars
        // (including a custom course scorecard) instead of falling back to
        // par 4 for every hole.
        course_holes: courseHoles ? JSON.stringify(courseHoles) : null,
      });

      setState(createInitialState(
        round.id, courseName, courseId, courseHoles,
        holesPlayed, startHole,
      ));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return true;
    } catch (err) {
      // NO local-ID fallback. The previous behavior created rounds with
      // `local_${Date.now()}` IDs that were never recognized by Supabase,
      // so every downstream upsertScore / createShot failed with
      // `scores_round_id_fkey` / `shots_round_id_fkey` violations and the
      // clips never landed in Storage. Result: library showed "no video"
      // for every round. We'd rather surface the error and let the user
      // retry than silently create an unsyncable round.
      console.error('[useRound] startRound failed:', err);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);

      // Specific cause: createRound throws 'Not authenticated' when
      // supabase.auth.getUser() returns no user. Surface that distinctly
      // so the user knows they need to sign in — the generic "check your
      // connection" message was misleading (it's an auth issue, not a
      // network issue).
      const msg = err instanceof Error ? err.message : String(err);
      if (/not authenticated/i.test(msg)) {
        Alert.alert(
          'Please sign in',
          'Your session has expired or you are not signed in. Sign out and back in to continue.',
          [{ text: 'OK' }]
        );
      } else {
        Alert.alert(
          'Could not start round',
          'Failed to create round on the server. Check your connection and try again.',
          [{ text: 'OK' }]
        );
      }
      return false;
    }
  }, []);

  // A clip finished saving. Two subtleties:
  //
  //  1. HOLE-AWARE COUNTER. A clip's hole is latched when recording STARTS,
  //     but the save pipeline (trim + detect + write) resolves seconds later,
  //     by which time the user may have moved holes. Blindly doing
  //     `currentShot + 1` then bumped the counter of the hole they moved TO
  //     on behalf of a shot that belongs to the hole they left — which is how
  //     shot numbers drifted out of sync with the footage. Only advance the
  //     counter when the clip belongs to the hole we're standing on.
  //  2. PERSIST THE POINTER. current_hole / current_shot used to be written
  //     only on a hole CHANGE, so a crash/kill mid-hole resumed with a stale
  //     shot number and the new clips collided with the existing ones.
  const recordClip = useCallback((clip: ClipMetadata) => {
    setState((prev) => {
      if (!prev) return prev;
      const isCurrentHole = clip.holeNumber === prev.currentHole;
      const nextShot = nextShotCounterAfterClip(
        prev.currentShot,
        clip.holeNumber,
        prev.currentHole
      );
      if (!isCurrentHole) {
        console.log(
          `[useRound] recordClip for hole ${clip.holeNumber} landed while on hole ${prev.currentHole} — shot counter left alone`
        );
      }
      return {
        ...prev,
        clips: [...prev.clips, clip],
        currentShot: nextShot,
      };
    });
  }, []);


  // Shot classification tracking. The putt→swing heuristic used to AUTO-advance
  // the hole here, but it misfired every 2–3 shots on a real hole (a chip read
  // as 'putt', a normal shot as 'swing') and silently committed phantom hole
  // scores. Hole advancement is now MANUAL only — Next Hole (endHole) and
  // Previous Hole. We still track the last shot type (harmless, and keeps the
  // ref that deleteLastClip / endHole reset in sync) but it no longer moves
  // holes or writes scores. Per-hole scoring now happens exclusively in the
  // manual endHole / addPenalty(pickup) / endRoundEarly branches.
  const onShotClassified = useCallback((shotType: ShotTypeClassification) => {
    lastShotTypeRef.current = shotType;
  }, []);

  const setRecording = useCallback((isRecording: boolean) => {
    setState((prev) => (prev ? { ...prev, isRecording } : prev));
  }, []);

  const addPenalty = useCallback(async (type: PenaltyType) => {
    setState((prev) => {
      if (!prev) return prev;

      const penaltyStrokes = PENALTY_STROKES[type];

      if (type === 'pickup') {
        const par = getParForHole(prev.courseHoles, prev.currentHole);
        const pickupScore = par + 2;
        const score: HoleScore = {
          holeNumber: prev.currentHole,
          par,
          strokes: pickupScore,
          putts: 0,
          penaltyStrokes: 0,
          isPickup: true,
          scoreToPar: pickupScore - par,
        };

        // Replace-or-append (not blind append): the user may have stepped
        // back to this hole with Previous Hole, so a score for it can already
        // exist. upsertHoleScore keeps the list de-duplicated and sorted.
        const newScores = upsertHoleScore(prev.scores, score);
        const newTotalScore = newScores.reduce((sum, s) => sum + s.strokes, 0);
        const newTotalPar = newScores.reduce((sum, s) => sum + s.par, 0);
        const nextHole = prev.currentHole + 1;

        saveLocalScore({
          round_id: prev.roundId,
          hole_number: prev.currentHole,
          strokes: pickupScore,
          putts: 0,
          penalty_strokes: 0,
          is_pickup: true,
          par,
        });

        upsertScore({
          round_id: prev.roundId,
          hole_number: prev.currentHole,
          strokes: pickupScore,
          putts: 0,
          penalty_strokes: 0,
          is_pickup: true,
          par,
        }).catch(() => {});

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);

        const lastHole = lastHoleOf(prev.holesPlayed, prev.startHole);
        if (nextHole > lastHole) {
          // Round complete — persist 'finished' NOW, not just in memory.
          // Previously only the hole pointer was written (hole 19), so an
          // app kill on the Round Complete screen resurrected the round as
          // an orphan on a hole past the end of the course.
          updateLocalRound(prev.roundId, {
            status: 'finished',
            finished_at: new Date().toISOString(),
          });
          return {
            ...prev,
            scores: newScores,
            totalScore: newTotalScore,
            totalPar: newTotalPar,
            currentHole: lastHole,
            currentShot: prev.currentShot,
            status: 'finished' as const,
          };
        }

        // Resume the shot counter for the hole we're advancing INTO. Normally
        // a fresh hole (→ 1), but after a Previous Hole round-trip the next
        // hole may already have footage / a prior score.
        const nextShot = resumeShotNumber(newScores, prev.clips, nextHole);
        updateLocalRound(prev.roundId, {
          current_hole: nextHole,
          current_shot: nextShot,
        });

        return {
          ...prev,
          scores: newScores,
          totalScore: newTotalScore,
          totalPar: newTotalPar,
          currentHole: nextHole,
          currentShot: nextShot,
        };
      }

      // Non-pickup penalties: add strokes, stay on same hole
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      return {
        ...prev,
        currentShot: prev.currentShot + penaltyStrokes,
      };
    });
  }, []);

  const endHole = useCallback(async () => {
    // Double-tap guard: two endHole calls within the window are one gesture.
    const now = Date.now();
    if (now - lastEndHoleAtRef.current < 1500) {
      console.log('[useRound] endHole ignored — double-tap guard');
      return;
    }
    lastEndHoleAtRef.current = now;

    // Reset shot type tracking when manually advancing hole
    lastShotTypeRef.current = null;
    setState((prev) => {
      if (!prev) return prev;

      const par = getParForHole(prev.courseHoles, prev.currentHole);
      const holeClips = prev.clips.filter((c) => c.holeNumber === prev.currentHole);

      // A hole the golfer walked past is NOT a hole they played.
      //
      // This used to be `Math.max(1, prev.currentShot - 1)`. On an untouched
      // hole currentShot is 1, so the floor produced a score of ONE — not a
      // harmless empty row, a hole-in-one. Tap Next Hole through 11 and 12 on
      // the way to 13 and the exported reel's scorecard claims two aces on
      // par 4s, and the round total is wrong by however many holes were skipped.
      // That is the "skipped holes are rendering" report: the scorecard was
      // right to show them, because the app really had written scores for them.
      //
      // previousHole already had this exactly right and its comment says so in
      // as many words — "otherwise we'd write a phantom 1-stroke score for a
      // hole merely passed through". The two functions are siblings and only
      // one of them guarded. Now both use the same helper, which returns null
      // when the hole saw no activity.
      const strokes = departingHoleStrokes(prev.currentShot);

      // Only the SCORE is skipped. The hole pointer still advances below, so
      // Next Hole behaves identically — the golfer moves on, we just do not
      // invent a number for a hole they never hit a shot on.
      const scoredNow: HoleScore | null =
        strokes === null
          ? null
          : {
              holeNumber: prev.currentHole,
              par,
              strokes,
              putts: 0,
              penaltyStrokes: Math.max(0, strokes - holeClips.length),
              isPickup: false,
              scoreToPar: strokes - par,
            };

      // Replace-or-append: Previous Hole can reopen an already-scored hole, so
      // re-ending it must overwrite that hole's entry rather than duplicate it
      // (a duplicate would double-count totalScore / totalPar).
      const newScores = scoredNow ? upsertHoleScore(prev.scores, scoredNow) : prev.scores;
      const newTotalScore = newScores.reduce((sum, s) => sum + s.strokes, 0);
      const newTotalPar = newScores.reduce((sum, s) => sum + s.par, 0);
      const nextHole = prev.currentHole + 1;

      // Persist — only when there is something real to persist. Writing a row
      // here is what made the skipped hole survive a reinstall and reappear on
      // the scorecard, so the guard has to cover the writes, not just state.
      if (strokes !== null) {
        saveLocalScore({
          round_id: prev.roundId,
          hole_number: prev.currentHole,
          strokes,
          putts: 0,
          penalty_strokes: Math.max(0, strokes - holeClips.length),
          is_pickup: false,
          par,
        });

        upsertScore({
          round_id: prev.roundId,
          hole_number: prev.currentHole,
          strokes,
          putts: 0,
          penalty_strokes: Math.max(0, strokes - holeClips.length),
          is_pickup: false,
          par,
        }).catch(() => {});
      }

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      const lastHole = lastHoleOf(prev.holesPlayed, prev.startHole);
      if (nextHole > lastHole) {
        // Round complete — persist 'finished' NOW, not just in memory.
        // Previously only the hole pointer was written (hole 19), so an
        // app kill on the Round Complete screen resurrected the round as
        // an orphan on a hole past the end of the course.
        updateLocalRound(prev.roundId, {
          status: 'finished',
          finished_at: new Date().toISOString(),
        });
        return {
          ...prev,
          scores: newScores,
          totalScore: newTotalScore,
          totalPar: newTotalPar,
          currentHole: lastHole,
          currentShot: prev.currentShot,
          status: 'finished' as const,
        };
      }

      // Resume the shot counter for the hole we're advancing INTO. A fresh
      // hole → 1; a hole revisited after Previous Hole keeps its existing
      // footage/score in sync so new shots append instead of overwriting.
      const nextShot = resumeShotNumber(newScores, prev.clips, nextHole);
      updateLocalRound(prev.roundId, {
        current_hole: nextHole,
        current_shot: nextShot,
      });

      return {
        ...prev,
        scores: newScores,
        totalScore: newTotalScore,
        totalPar: newTotalPar,
        currentHole: nextHole,
        currentShot: nextShot,
      };
    });
  }, []);

  // Manual "Previous Hole" navigation. Steps currentHole back by one, clamped
  // at startHole (a back-nine round can't drop below hole 10). Lets the user
  // fix or add a missed shot on the prior hole after the false auto-advance
  // removal made all hole movement manual.
  //
  // Non-destructive: the prior hole's committed score STAYS in state and in
  // storage. We only reposition the hole/shot pointers — currentShot resumes at
  // that hole's committed strokes+1 (so penalty strokes survive and a new clip
  // appends correctly). Re-ending the hole with Next Hole overwrites the score
  // in place (upsertHoleScore), so going back then forward never duplicates or
  // loses a hole.
  const previousHole = useCallback(() => {
    // Double-tap guard, same as endHole: Previous Hole sits right next to
    // Next Hole in the bottom bar, and a gloved double-tap would otherwise
    // step back two holes in one gesture.
    const now = Date.now();
    if (now - lastPreviousHoleAtRef.current < 1500) {
      console.log('[useRound] previousHole ignored — double-tap guard');
      return;
    }
    lastPreviousHoleAtRef.current = now;

    const current = stateRef.current;
    if (!current || current.status !== 'in_progress') return;

    const target = previousHoleTarget(current.currentHole, current.startHole);
    if (target === null) return; // already on the first hole played

    // COMMIT THE DEPARTING HOLE'S STROKES before stepping away. Penalty
    // strokes live ONLY in currentShot (addPenalty just increments it), so
    // leaving a hole without committing threw them away: coming back via Next
    // Hole, resumeShotNumber fell through to clipCount + 1 and the penalties
    // were gone. Only commit when the hole actually saw activity
    // (currentShot > 1) — otherwise we'd write a phantom 1-stroke score for a
    // hole the user merely passed through.
    const departing = current.currentHole;
    const departingStrokes = departingHoleStrokes(current.currentShot);
    let scoresAfterCommit = current.scores;

    if (departingStrokes !== null) {
      const par = getParForHole(current.courseHoles, departing);
      const holeClips = current.clips.filter((c) => c.holeNumber === departing);
      const penaltyStrokes = Math.max(0, departingStrokes - holeClips.length);
      scoresAfterCommit = upsertHoleScore(current.scores, {
        holeNumber: departing,
        par,
        strokes: departingStrokes,
        putts: 0,
        penaltyStrokes,
        isPickup: false,
        scoreToPar: departingStrokes - par,
      });

      saveLocalScore({
        round_id: current.roundId,
        hole_number: departing,
        strokes: departingStrokes,
        putts: 0,
        penalty_strokes: penaltyStrokes,
        is_pickup: false,
        par,
      });
      upsertScore({
        round_id: current.roundId,
        hole_number: departing,
        strokes: departingStrokes,
        putts: 0,
        penalty_strokes: penaltyStrokes,
        is_pickup: false,
        par,
      }).catch(() => {});
    }

    // Reset shot-type tracking so a stale classification can't leak across
    // the manual navigation.
    lastShotTypeRef.current = null;

    const resumeShot = resumeShotNumber(scoresAfterCommit, current.clips, target);

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    setState((prev) => {
      if (!prev || prev.status !== 'in_progress') return prev;
      const newTotalScore = scoresAfterCommit.reduce((sum, s) => sum + s.strokes, 0);
      const newTotalPar = scoresAfterCommit.reduce((sum, s) => sum + s.par, 0);
      return {
        ...prev,
        scores: scoresAfterCommit,
        totalScore: newTotalScore,
        totalPar: newTotalPar,
        currentHole: target,
        currentShot: resumeShot,
      };
    });
  }, []);

  // Ref mirrors state so endRound always reads the latest value without
  // capturing a stale closure (a tap fired from an older render would
  // otherwise submit stale totals).
  const stateRef = useRef<RoundState | null>(null);
  stateRef.current = state;

  // Single source of truth for persisting the live hole/shot pointer. Every
  // mutation (record, next hole, previous hole, delete, undo) flows through
  // state, so mirroring it here covers them all — and does so as a committed
  // side effect rather than inside a setState updater, which React is free to
  // re-run. Before this, the pointer was written only on a hole change, so a
  // resume after an app kill restored a stale shot number.
  useEffect(() => {
    if (!state || state.status !== 'in_progress') return;
    updateLocalRound(state.roundId, {
      current_hole: state.currentHole,
      current_shot: state.currentShot,
    });
  }, [state?.roundId, state?.currentHole, state?.currentShot, state?.status]);

  const endRound = useCallback(async () => {
    const current = stateRef.current;
    if (!current) return;

    const totalScore = current.scores.reduce((sum, s) => sum + s.strokes, 0);
    const totalPar = current.scores.reduce((sum, s) => sum + s.par, 0);
    const totalPutts = current.scores.reduce((sum, s) => sum + s.putts, 0);

    try {
      await updateRound(current.roundId, {
        total_score: totalScore,
        total_par: totalPar,
        score_to_par: totalScore - totalPar,
        total_putts: totalPutts,
        holes_played: current.scores.length,
        status: 'uploading',
      });

      await updateLocalRound(current.roundId, {
        status: 'finished',
        finished_at: new Date().toISOString(),
      });

      setState((prev) => (prev ? { ...prev, status: 'finished' } : prev));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      await updateLocalRound(current.roundId, {
        status: 'finished',
        finished_at: new Date().toISOString(),
      });
      setState((prev) => (prev ? { ...prev, status: 'finished' } : prev));
    }
  }, []);

  const recoverRound = useCallback(async (roundId: string) => {
    try {
      const localRound = await getLocalRound(roundId);
      if (!localRound) return;

      const localScores = await getLocalScores(roundId);
      const localClips = await getClipsForRound(roundId);

      const scores: HoleScore[] = localScores.map((s) => ({
        holeNumber: s.hole_number,
        par: s.par,
        strokes: s.strokes,
        putts: s.putts,
        penaltyStrokes: s.penalty_strokes,
        isPickup: s.is_pickup === 1,
        scoreToPar: s.strokes - s.par,
      }));

      const clips: ClipMetadata[] = localClips.map((c) => ({
        id: c.id,
        roundId: c.round_id,
        holeNumber: c.hole_number,
        shotNumber: c.shot_number,
        fileUri: c.file_uri,
        timestamp: c.timestamp,
        uploaded: c.uploaded === 1,
      }));

      const totalScore = scores.reduce((sum, s) => sum + s.strokes, 0);
      const totalPar = scores.reduce((sum, s) => sum + s.par, 0);

      const holesPlayed: 9 | 18 = localRound.holes_played === 9 ? 9 : 18;
      const startHole: 1 | 10 = localRound.start_hole === 10 ? 10 : 1;

      // Restore the round's own scorecard. Legacy rows (written before the
      // column existed) read back NULL and keep the old par-4 behaviour.
      let courseHoles: HoleData[] | undefined;
      const rawHoles = (localRound as { course_holes?: string | null }).course_holes;
      if (rawHoles) {
        try {
          const parsed = JSON.parse(rawHoles);
          if (Array.isArray(parsed) && parsed.length > 0) courseHoles = parsed as HoleData[];
        } catch {
          // Corrupt JSON — fall back to no scorecard rather than failing the
          // whole recovery.
        }
      }

      // Clamp the restored pointer into the round's real hole range, and fall
      // back to the hole's own footage/score when the persisted shot counter
      // belongs to a different hole. (See clampRecoveredPointer.)
      const pointer = clampRecoveredPointer(
        localRound.current_hole,
        localRound.current_shot,
        holesPlayed,
        startHole
      );
      const recoveredHole = pointer.hole;
      const recoveredShot =
        pointer.shot ?? resumeShotNumber(scores, clips, recoveredHole);

      setState({
        roundId,
        courseId: localRound.course_id ?? undefined,
        courseName: localRound.course_name,
        currentHole: recoveredHole,
        currentShot: recoveredShot,
        isRecording: false,
        scores,
        clips,
        totalScore,
        totalPar,
        // Round setup is now persisted on the local round row, so a recovered
        // round restores its real shape instead of assuming a full 18 from
        // hole 1. Legacy rows written before this column existed read back as
        // NULL and fall back to the pre-Wave-3 default (18 / hole 1), which is
        // exactly what those rounds were. Normalized to the valid unions so
        // lastHoleOf (round-end detection) stays correct.
        holesPlayed,
        startHole,
        courseHoles,
        status: 'in_progress',
      });
    } catch (error) {
      console.error('[useRound] Failed to recover round:', error);
    }
  }, []);

  const discardRound = useCallback(async (roundId: string) => {
    try {
      purgeDeletedClips();
      await deleteLocalRound(roundId);
      setState(null);
    } catch (error) {
      console.error('[useRound] Failed to discard round:', error);
    }
  }, [purgeDeletedClips]);

  const endRoundEarly = useCallback(async () => {
    setState((prev) => {
      if (!prev) return prev;

      // Finalize the current hole if any shots were taken
      const par = getParForHole(prev.courseHoles, prev.currentHole);
      const holeClips = prev.clips.filter((c) => c.holeNumber === prev.currentHole);
      const strokes = Math.max(1, prev.currentShot - 1);
      const hasCurrentHoleShots = prev.currentShot > 1 || holeClips.length > 0;

      let newScores = [...prev.scores];

      if (hasCurrentHoleShots) {
        const score: HoleScore = {
          holeNumber: prev.currentHole,
          par,
          strokes,
          putts: 0,
          penaltyStrokes: Math.max(0, strokes - holeClips.length),
          isPickup: false,
          scoreToPar: strokes - par,
        };
        // Replace-or-append so ending early on a hole that was reopened via
        // Previous Hole doesn't double-count it.
        newScores = upsertHoleScore(newScores, score);

        saveLocalScore({
          round_id: prev.roundId,
          hole_number: prev.currentHole,
          strokes,
          putts: 0,
          penalty_strokes: Math.max(0, strokes - holeClips.length),
          is_pickup: false,
          par,
        });

        upsertScore({
          round_id: prev.roundId,
          hole_number: prev.currentHole,
          strokes,
          putts: 0,
          penalty_strokes: Math.max(0, strokes - holeClips.length),
          is_pickup: false,
          par,
        }).catch(() => {});
      }

      const newTotalScore = newScores.reduce((sum, s) => sum + s.strokes, 0);
      const newTotalPar = newScores.reduce((sum, s) => sum + s.par, 0);

      updateLocalRound(prev.roundId, {
        status: 'finished',
        finished_at: new Date().toISOString(),
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      return {
        ...prev,
        scores: newScores,
        totalScore: newTotalScore,
        totalPar: newTotalPar,
        currentHole: prev.currentHole,
        currentShot: prev.currentShot,
        status: 'finished' as const,
      };
    });
  }, []);

  const resetRound = useCallback(() => {
    purgeDeletedClips();
    setState(null);
  }, [purgeDeletedClips]);

  // Reset the round to its just-started state, keeping the same roundId and
  // setup (course / holes / start hole). Used by the recording-screen
  // clicker tutorial: the user practices on the real round (sees real
  // recording / hole changes / penalties), then this wipes everything back
  // to a clean slate so the actual round begins fresh. Clears in-memory
  // state + the round's SQLite clips/scores + resets the round row's
  // hole/shot pointers. (In practice mode the camera discards clips before
  // they're persisted, so usually there's nothing to delete — but we clear
  // defensively.)
  const resetToStart = useCallback(async () => {
    const current = stateRef.current;
    if (!current) return;

    lastShotTypeRef.current = null;
    // Everything is being wiped anyway — release the undo stack's footage.
    purgeDeletedClips();
    setState(
      createInitialState(
        current.roundId,
        current.courseName,
        current.courseId,
        current.courseHoles,
        current.holesPlayed,
        current.startHole,
      )
    );

    try {
      const { fileUris } = await resetRoundData(current.roundId);

      // The rows go, the FILES STAY. Deliberately.
      //
      // This path discards a practice pass, and the camera discards practice
      // clips before they are ever persisted — so `fileUris` should be empty
      // every time. If it is not, something we did not predict recorded real
      // footage during practice (a clicker press that slipped past the armed
      // check, a state race), and that is exactly the moment to stop deleting.
      //
      // It used to unlink every uri here, with no undo entry and no
      // confirmation. A round is recorded once, on a course, and cannot be
      // re-recorded; an orphaned file costs disk, a wrong `deleteFile` costs the
      // shot. The round row is still cleared, so the user gets the clean slate
      // they asked for — the footage just remains on disk, reachable from
      // Profile → Storage, instead of being destroyed on a guess.
      if (fileUris.length > 0) {
        console.warn(
          `[useRound] resetToStart: ${fileUris.length} practice clip file(s) had been ` +
            'persisted — rows cleared, files intentionally left on disk. Practice ' +
            'clips are not supposed to reach disk, so this is worth investigating.',
        );
      }

      await updateLocalRound(current.roundId, {
        current_hole: current.startHole,
        current_shot: 1,
      });
    } catch (err) {
      console.log('[useRound] resetToStart failed:', err);
    }
  }, [purgeDeletedClips]);

  // Delete the most recently recorded clip (the recording screen's
  // "Delete last shot" action). Removes it from in-memory state, decrements
  // the shot counter so the next recording reuses that shot number, and
  // deletes the SQLite row. We delete only clips on the CURRENT hole so a
  // stray double-tap can't reach back into a completed hole's footage.
  // Returns true if a clip was removed.
  const deleteLastClip = useCallback(async (): Promise<boolean> => {
    const current = stateRef.current;
    if (!current) return false;

    // Find the last clip on the current hole (clips are appended in order).
    const lastIdx = findLastClipIndexOnHole(current.clips, current.currentHole);
    if (lastIdx < 0) return false;
    const lastClip = current.clips[lastIdx];

    // The deleted shot's classification must not seed the putt→swing
    // hole-advance detector: a deleted putt followed by a recorded chip
    // ('swing') would otherwise auto-advance the hole and commit a phantom
    // score. The clip's own pending detection continuation is skipped via
    // the clipExists guard in useCamera once the row is gone.
    lastShotTypeRef.current = null;

    // Optimistically update state: drop the last current-hole clip and
    // step the shot counter back one (never below 1).
    setState((prev) => {
      if (!prev) return prev;
      const idx = prev.clips.lastIndexOf(lastClip);
      const nextClips =
        idx >= 0 ? [...prev.clips.slice(0, idx), ...prev.clips.slice(idx + 1)] : prev.clips;
      return {
        ...prev,
        clips: nextClips,
        currentShot: Math.max(1, prev.currentShot - 1),
      };
    });

    // Persist: delete the SQLite row (if it has a local id) and push the whole
    // record onto the undo stack. We deliberately DON'T unlink the video files
    // here any more — they're what an undo restores. They're released when the
    // entry is evicted from the stack or the round ends (purgeDeletedClips).
    try {
      if (typeof lastClip.id === 'number') {
        // stalePredecessor=false: defer the neighbour's tracer invalidation
        // until this delete is committed (evicted/round end), so an undo
        // leaves the predecessor untouched.
        const { fileUris, row } = await deleteLocalClip(lastClip.id, false);
        deletedStackRef.current = [
          ...deletedStackRef.current,
          { row, clip: lastClip, fileUris },
        ];
        // Cap the stack; evicting an entry is the point at which its footage
        // is genuinely gone, so that's when we commit the deletion and free
        // the disk.
        while (deletedStackRef.current.length > UNDO_STACK_LIMIT) {
          const [evicted, ...rest] = deletedStackRef.current;
          deletedStackRef.current = rest;
          if (evicted.row) commitClipDeletion(evicted.row);
          for (const uri of evicted.fileUris) {
            deleteFile(uri).catch(() => {});
          }
        }
        setUndoableDeleteCount(deletedStackRef.current.length);
      }
    } catch (err) {
      console.log('[useRound] deleteLastClip persist failed:', err);
    }

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    return true;
  }, []);

  /**
   * Undo the most recent "Delete last shot" — re-inserts the SQLite row under
   * its original id and puts the clip back into round state, restoring the
   * shot counter if the clip belongs to the hole we're standing on.
   * Returns the restored clip's hole number, or null if there was nothing to
   * undo (or the round has moved on).
   */
  const undoDeleteClip = useCallback(async (): Promise<number | null> => {
    const stack = deletedStackRef.current;
    if (stack.length === 0) return null;

    const entry = stack[stack.length - 1];
    deletedStackRef.current = stack.slice(0, -1);
    setUndoableDeleteCount(deletedStackRef.current.length);

    try {
      if (entry.row) await restoreLocalClip(entry.row);
    } catch (err) {
      console.log('[useRound] undoDeleteClip restore failed:', err);
    }

    setState((prev) => {
      if (!prev) return prev;
      // Guard against a double-restore (row already back in state).
      if (prev.clips.some((c) => c.id === entry.clip.id)) return prev;
      // Re-insert in shot order so the editor's per-hole ordering is right,
      // rather than appending the restored clip after later shots.
      const nextClips = insertClipInOrder(prev.clips, entry.clip);
      // The counter only moves if the restored shot is on the hole we're on —
      // restoring a hole-3 shot while standing on hole 5 must not renumber
      // hole 5's next shot.
      const onCurrentHole = entry.clip.holeNumber === prev.currentHole;
      return {
        ...prev,
        clips: nextClips,
        currentShot: onCurrentHole ? prev.currentShot + 1 : prev.currentShot,
      };
    });

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    return entry.clip.holeNumber;
  }, []);

  return {
    state,
    startRound,
    recordClip,
    onShotClassified,
    setRecording,
    addPenalty,
    endHole,
    previousHole,
    endRound,
    endRoundEarly,
    recoverRound,
    discardRound,
    resetRound,
    resetToStart,
    deleteLastClip,
    undoDeleteClip,
    /** How many deleted shots can still be restored this round. */
    undoableDeleteCount,
    /** The hole the most recently deleted shot came from (null if none). */
    lastDeletedHole:
      deletedStackRef.current.length > 0
        ? deletedStackRef.current[deletedStackRef.current.length - 1].clip.holeNumber
        : null,
  };
}
