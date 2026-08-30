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
import { getSetting, setSetting, saveLocalRound, deleteLocalRound, getClipsForRound, getLocalRound, saveLocalClip } from '@/lib/storage';
import { createRound, deleteRound } from '@/lib/api';
import { persistAsset } from '@/lib/media';

export const TUTORIAL_COURSE_NAME = 'Tutorial round';

const PENDING_KEY = 'onboarding.v3.tutorial_pending';
const ACTIVE_KEY = 'tutorial.active_round';

/**
 * Ids of rounds THIS APP created as tutorial rounds.
 *
 * The sweep used to select its victims by course name alone, and
 * `course_name` is free text — the round-setup screen binds a TextInput
 * straight to it (app/(tabs)/record.tsx). So a golfer who typed
 * "Tutorial round" as their course had that round deleted on the next app
 * start: local rows AND every clip file unlinked by deleteLocalRound, plus
 * the remote row by deleteRound. No bin entry, no undo. Unlikely to be typed,
 * total when it happens, and it needed nothing but the user's own words.
 *
 * A sentinel that the user can write is not a sentinel. The id registry is
 * the real one: only rounds created by createTutorialRound are ever
 * candidates, and the course-name check below is kept as a second gate rather
 * than the only one.
 */
const CREATED_KEY = 'tutorial.created_round_ids';

async function readCreatedIds(): Promise<string[]> {
  try {
    const raw = await getSetting(CREATED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

async function writeCreatedIds(ids: string[]): Promise<void> {
  try {
    await setSetting(CREATED_KEY, ids.length ? JSON.stringify(ids) : null);
  } catch {}
}

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
  // Registered before anything else can fail, so the sweep can always find it.
  await writeCreatedIds([...(await readCreatedIds()), round.id]);
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
 * Idempotent and safe to run at every authed launch.
 *
 * Candidates come from the id registry ONLY — rounds this app created through
 * createTutorialRound. It does not scan for rounds that merely look like
 * tutorials, because "looks like a tutorial" was a user-typed string (see
 * CREATED_KEY). The course-name check is kept underneath as a second gate.
 *
 * deleteLocalRound removes the local rows and unlinks every clip file;
 * deleteRound removes the remote row (RLS scopes it to the owner). Both are
 * irreversible, which is the whole reason the candidate set is now closed
 * rather than pattern-matched.
 */
export async function sweepTutorialRounds(): Promise<number> {
  let swept = 0;
  try {
    const active = await getActiveTutorialRoundId();
    const created = await readCreatedIds();
    const candidates = new Set<string>(created);
    // The active key is written immediately after the registry, so this only
    // matters if the registry write was the one that failed.
    if (active) candidates.add(active);

    const sweptIds = new Set<string>();
    for (const id of candidates) {
      const row = await getLocalRound(id).catch(() => null);
      // A missing local row is expected — the round may already be gone
      // locally while the remote row survives, which is what this sweep is
      // for. A row that exists but is NOT a tutorial round means the id was
      // recycled or the registry is wrong; leave it alone.
      if (row && row.course_name !== TUTORIAL_COURSE_NAME) continue;
      await deleteLocalRound(id).catch(() => {});
      await deleteRound(id).catch(() => {});
      sweptIds.add(id);
      swept += 1;
    }

    // Drop what we swept so the registry does not grow for the life of the
    // install. Anything skipped above stays, so it is not silently forgotten.
    await writeCreatedIds(created.filter((id) => !sweptIds.has(id)));
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
