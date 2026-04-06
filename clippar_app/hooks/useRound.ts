import { useState, useCallback } from 'react';
import * as Haptics from 'expo-haptics';
import type { RoundState, HoleScore, ClipMetadata, PenaltyType, HoleData } from '@/types/round';
import { PENALTY_STROKES } from '@/types/round';
import { createRound, updateRound, upsertScore } from '@/lib/api';
import {
  saveLocalRound,
  updateLocalRound,
  saveLocalScore,
  getLocalRound,
  getLocalScores,
  getClipsForRound,
  deleteLocalRound,
} from '@/lib/storage';

const DEFAULT_PAR = 4;

function createInitialState(
  roundId: string,
  courseName: string,
  courseId?: string,
  courseHoles?: HoleData[]
): RoundState {
  return {
    roundId,
    courseId,
    courseName,
    currentHole: 1,
    currentShot: 1,
    isRecording: false,
    scores: [],
    clips: [],
    totalScore: 0,
    totalPar: 0,
    courseHoles,
    status: 'in_progress',
  };
}

function getParForHole(courseHoles: HoleData[] | undefined, holeNumber: number): number {
  if (!courseHoles) return DEFAULT_PAR;
  const hole = courseHoles.find((h) => h.holeNumber === holeNumber);
  return hole?.par ?? DEFAULT_PAR;
}

export function useRound() {
  const [state, setState] = useState<RoundState | null>(null);

  const startRound = useCallback(async (
    courseName: string,
    courseId?: string,
    courseHoles?: HoleData[]
  ) => {
    try {
      const round = await createRound({
        course_name: courseName,
        course_id: courseId,
        holes_played: 18,
      });

      if (!round) throw new Error('Failed to create round');

      await saveLocalRound({
        id: round.id,
        course_name: courseName,
        course_id: courseId,
      });

      setState(createInitialState(round.id, courseName, courseId, courseHoles));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      // Fallback: create with local-only ID if offline
      const localId = `local_${Date.now()}`;
      await saveLocalRound({
        id: localId,
        course_name: courseName,
        course_id: courseId,
      });
      setState(createInitialState(localId, courseName, courseId, courseHoles));
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

        const newScores = [...prev.scores, score];
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
        }).catch(() => {});

        updateLocalRound(prev.roundId, {
          current_hole: nextHole,
          current_shot: 1,
        });

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);

        if (nextHole > 18) {
          return {
            ...prev,
            scores: newScores,
            totalScore: newTotalScore,
            totalPar: newTotalPar,
            currentHole: 18,
            currentShot: prev.currentShot,
            status: 'finished' as const,
          };
        }

        return {
          ...prev,
          scores: newScores,
          totalScore: newTotalScore,
          totalPar: newTotalPar,
          currentHole: nextHole,
          currentShot: 1,
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

      const newScores = [...prev.scores, score];
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
      }).catch(() => {});

      updateLocalRound(prev.roundId, {
        current_hole: nextHole,
        current_shot: 1,
      });

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      if (nextHole > 18) {
        return {
          ...prev,
          scores: newScores,
          totalScore: newTotalScore,
          totalPar: newTotalPar,
          currentHole: 18,
          currentShot: prev.currentShot,
          status: 'finished' as const,
        };
      }

      return {
        ...prev,
        scores: newScores,
        totalScore: newTotalScore,
        totalPar: newTotalPar,
        currentHole: nextHole,
        currentShot: 1,
      };
    });
  }, []);

  const endRound = useCallback(async () => {
    if (!state) return;

    const totalScore = state.scores.reduce((sum, s) => sum + s.strokes, 0);
    const totalPar = state.scores.reduce((sum, s) => sum + s.par, 0);
    const totalPutts = state.scores.reduce((sum, s) => sum + s.putts, 0);

    try {
      await updateRound(state.roundId, {
        total_score: totalScore,
        total_par: totalPar,
        score_to_par: totalScore - totalPar,
        total_putts: totalPutts,
        holes_played: state.scores.length,
        status: 'uploading',
      });

      await updateLocalRound(state.roundId, {
        status: 'finished',
        finished_at: new Date().toISOString(),
      });

      setState((prev) => (prev ? { ...prev, status: 'finished' } : prev));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      await updateLocalRound(state.roundId, {
        status: 'finished',
        finished_at: new Date().toISOString(),
      });
      setState((prev) => (prev ? { ...prev, status: 'finished' } : prev));
    }
  }, [state]);

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

  const resetRound = useCallback(() => {
    setState(null);
  }, []);

  return {
    state,
    startRound,
    recordClip,
    setRecording,
    addPenalty,
    endHole,
    endRound,
    recoverRound,
    discardRound,
    resetRound,
  };
}
