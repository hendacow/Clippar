import { useState, useCallback, useRef } from 'react';
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
  resetRoundData,
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

  const recordClip = useCallback((clip: ClipMetadata) => {
    setState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        clips: [...prev.clips, clip],
        currentShot: prev.currentShot + 1,
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
      // Strokes = number of clips recorded for this hole (each clip = one shot)
      // plus any penalty strokes (already reflected in currentShot increments)
      const strokes = Math.max(1, prev.currentShot - 1);

      const score: HoleScore = {
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
      const newScores = upsertHoleScore(prev.scores, score);
      const newTotalScore = newScores.reduce((sum, s) => sum + s.strokes, 0);
      const newTotalPar = newScores.reduce((sum, s) => sum + s.par, 0);
      const nextHole = prev.currentHole + 1;

      // Persist
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
    setState((prev) => {
      if (!prev || prev.status !== 'in_progress') return prev;

      const target = previousHoleTarget(prev.currentHole, prev.startHole);
      if (target === null) return prev; // already on the first hole played

      // Reset shot-type tracking so a stale classification can't leak across
      // the manual navigation.
      lastShotTypeRef.current = null;

      const resumeShot = resumeShotNumber(prev.scores, prev.clips, target);

      updateLocalRound(prev.roundId, {
        current_hole: target,
        current_shot: resumeShot,
      });

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      return {
        ...prev,
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

      setState({
        roundId,
        courseId: localRound.course_id ?? undefined,
        courseName: localRound.course_name,
        currentHole: localRound.current_hole,
        currentShot: localRound.current_shot,
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
        holesPlayed: localRound.holes_played === 9 ? 9 : 18,
        startHole: localRound.start_hole === 10 ? 10 : 1,
        status: 'in_progress',
      });
    } catch (error) {
      console.error('[useRound] Failed to recover round:', error);
    }
  }, []);

  const discardRound = useCallback(async (roundId: string) => {
    try {
      await deleteLocalRound(roundId);
      setState(null);
    } catch (error) {
      console.error('[useRound] Failed to discard round:', error);
    }
  }, []);

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
    setState(null);
  }, []);

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
      for (const uri of fileUris) {
        deleteFile(uri).catch(() => {});
      }
      await updateLocalRound(current.roundId, {
        current_hole: current.startHole,
        current_shot: 1,
      });
    } catch (err) {
      console.log('[useRound] resetToStart failed:', err);
    }
  }, []);

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

    // Persist: delete the SQLite row (if it has a local id) and best-effort
    // remove the underlying video file(s).
    try {
      if (typeof lastClip.id === 'number') {
        const { fileUris } = await deleteLocalClip(lastClip.id);
        for (const uri of fileUris) {
          deleteFile(uri).catch(() => {});
        }
      }
    } catch (err) {
      console.log('[useRound] deleteLastClip persist failed:', err);
    }

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    return true;
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
  };
}
