/**
 * v3 onboarding — the REAL interface as the tutorial, on a scratch round.
 *
 * Approved design (plan §12): short cinematic hook pre-signup → signup →
 * this. Post-auth every data seam vanishes: the scratch round is created
 * through the same createRound/saveLocalRound path as any round, properly
 * scoped to the (brand-new) account, so the ownerless-round adoption leak
 * that blocked the pre-auth version cannot happen. The record screen runs
 * its REAL state on it — hole advancement, penalties, shot counts are the
 * production code paths — with exactly one seam: video where the camera is.
 *
 * Cleanup is idempotent by construction: rounds are found by the sentinel
 * course name, and sweepTutorialRounds() runs at every authed app start, so
 * a crash mid-tutorial leaves at worst one launch's worth of clutter in the
 * user's OWN account before the sweep removes it.
 */
import { getSetting, setSetting, saveLocalRound, deleteLocalRound, getClipsForRound, getOrphanedRounds, getLocalRound, saveLocalClip } from '@/lib/storage';
import { createRound, deleteRound } from '@/lib/api';
import { persistAsset } from '@/lib/media';

export const TUTORIAL_COURSE_NAME = 'Tutorial round';

const PENDING_KEY = 'onboarding.v3.tutorial_pending';
const ACTIVE_KEY = 'tutorial.active_round';

export async function setTutorialPending(pending: boolean): Promise<void> {
  try {
    await setSetting(PENDING_KEY, pending ? '1' : null);
  } catch {}
}

export async function isTutorialPending(): Promise<boolean> {
  try {
    return (await getSetting(PENDING_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function getActiveTutorialRoundId(): Promise<string | null> {
  try {
    return await getSetting(ACTIVE_KEY);
  } catch {
    return null;
  }
}

/** Create the scratch round through the production path. Authed callers only. */
export async function createTutorialRound(): Promise<string> {
  const round = await createRound({ course_name: TUTORIAL_COURSE_NAME, holes_played: 9 });
  if (!round) throw new Error('Failed to create tutorial round');
  await saveLocalRound({ id: round.id, course_name: TUTORIAL_COURSE_NAME, holes_played: 9 });
  await setSetting(ACTIVE_KEY, round.id);
  await setTutorialPending(false);
  return round.id;
}

/**
 * "Record" a tutorial shot: the bundled demo clip becomes a real clip row in
 * the scratch round, via the same persistAsset + saveLocalClip shape live
 * recording produces (already trimmed — these ARE detector-trimmed swings).
 * Everything downstream — round state, the editor, per-hole export — treats
 * it as any other shot, because it is one.
 */
export async function recordTutorialShot(
  roundId: string,
  holeNumber: number,
  shotNumber: number,
  assetLocalUri: string,
  durationSeconds: number
): Promise<{ clipId: number | undefined; fileUri: string }> {
  const filename = `tutorial_${roundId}_h${holeNumber}_s${shotNumber}_${Date.now()}.mp4`;
  let fileUri = assetLocalUri;
  try {
    fileUri = await persistAsset(assetLocalUri, filename, { keepSource: true });
  } catch {
    try {
      fileUri = await persistAsset(assetLocalUri, filename);
    } catch {}
  }
  const clipId = await saveLocalClip({
    round_id: roundId,
    hole_number: holeNumber,
    shot_number: shotNumber,
    file_uri: fileUri,
    original_file_uri: fileUri,
    duration_seconds: durationSeconds,
    needs_trim: 0,
    auto_trimmed: 1,
  });
  return { clipId: clipId as number | undefined, fileUri };
}

/** Mark the tutorial finished; the round is swept rather than kept. */
export async function endTutorial(): Promise<void> {
  try {
    await setSetting(ACTIVE_KEY, null);
  } catch {}
  await sweepTutorialRounds();
}

/**
 * Remove every tutorial round, local and remote, wherever the app finds one.
 * Idempotent and safe to run at every authed launch: matches ONLY the
 * sentinel course name, deletes the local rows and clip files via
 * deleteLocalRound, and best-effort deletes the remote row (RLS scopes it to
 * the owner, so this can only ever touch the user's own tutorial rounds).
 */
export async function sweepTutorialRounds(): Promise<number> {
  let swept = 0;
  try {
    const active = await getActiveTutorialRoundId();
    const candidates = new Set<string>();
    if (active) candidates.add(active);
    // Orphan scan catches in_progress ones; finished tutorials are closed by
    // endTutorial before this runs, and the active key covers a crash window.
    const orphans = await getOrphanedRounds().catch(() => []);
    for (const o of orphans) if (o.course_name === TUTORIAL_COURSE_NAME) candidates.add(o.id);
    for (const id of candidates) {
      const row = await getLocalRound(id).catch(() => null);
      if (row && row.course_name !== TUTORIAL_COURSE_NAME) continue; // never sweep a real round
      await deleteLocalRound(id).catch(() => {});
      await deleteRound(id).catch(() => {});
      swept += 1;
    }
    if (active) await setSetting(ACTIVE_KEY, null).catch(() => {});
  } catch {}
  return swept;
}

/** The clips the record screen still holds get their files cleaned by
 *  deleteLocalRound; expose counts for the coach's own bookkeeping. */
export async function tutorialShotCount(roundId: string): Promise<number> {
  const rows = await getClipsForRound(roundId).catch(() => []);
  return rows.length;
}
