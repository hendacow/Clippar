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
 * Cleanup is idempotent by construction: rounds are found by an owner-stamped
 * id registry this module writes (NOT by course name — see CREATED_KEY for why
 * that was unsafe), and sweepTutorialRounds() runs at every authed app start,
 * so a crash mid-tutorial leaves at worst one launch's worth of clutter in the
 * user's OWN account before the sweep removes it.
 */
import { getSetting, setSetting, saveLocalRound, deleteLocalRound, getClipsForRound, getLocalRound, saveLocalClip, currentSessionUserId } from '@/lib/storage';
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

/**
 * Entries carry their owner, because `local_settings` is device-wide.
 *
 * One handset, one `clippar.db`, and sign-out does not wipe it — so a bare
 * list of ids accumulates rounds from every account that has used the phone.
 * `getLocalRound` is scoped and fails closed, so under account B a round
 * belonging to A reads as `null`, which the sweep treats as "already gone
 * locally" and proceeds — but `deleteLocalRound` is NOT scoped: it deletes by
 * round_id alone and unlinks every clip file it finds. B finishing the
 * tutorial would therefore delete A's tutorial round and its files.
 *
 * Bounded (tutorial rounds hold bundled demo clips) and the old active-round
 * key had the same shape, but it is worth closing precisely because this
 * registry is now the only record a sweep works from.
 */
interface CreatedTutorialRound {
  id: string;
  /** Who created it. `null` = a legacy bare-string entry: never swept. */
  userId: string | null;
}

async function readCreatedIds(): Promise<CreatedTutorialRound[]> {
  try {
    const raw = await getSetting(CREATED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((v): CreatedTutorialRound[] => {
      // Tolerate the previous `string[]` shape on upgrade. Such an entry has
      // no known owner, so it is kept but never swept — leaving one tutorial
      // round uncollected beats deleting someone else's.
      if (typeof v === 'string') return [{ id: v, userId: null }];
      if (v && typeof v === 'object') {
        const e = v as { id?: unknown; userId?: unknown };
        if (typeof e.id === 'string') {
          return [{ id: e.id, userId: typeof e.userId === 'string' ? e.userId : null }];
        }
      }
      return [];
    });
  } catch {
    return [];
  }
}

async function writeCreatedIds(entries: CreatedTutorialRound[]): Promise<void> {
  try {
    await setSetting(CREATED_KEY, entries.length ? JSON.stringify(entries) : null);
  } catch {}
}

/**
 * Drop one account's entries on wipe, keeping everyone else's.
 *
 * Same reasoning as `training.forgetTrainingSessionsFor`: `CREATED_KEY` is
 * device-wide, this branch gave its entries an owner, and account deletion
 * left the departing user's id and every tutorial round id behind. The sweep
 * only retires ids stamped with the SIGNED-IN account, and a deleted account
 * never signs in again — so without this they were permanent.
 *
 * Legacy bare-string entries have `userId: null` and are kept: unattributable,
 * so not ours to delete under anyone. Same trade as the sweep makes.
 */
export async function forgetCreatedRoundsFor(userId: string): Promise<void> {
  // writeCreatedIds already swallows its own failures; a wipe must not throw.
  await writeCreatedIds((await readCreatedIds()).filter((e) => e.userId !== userId));
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
  // Registered before anything else can fail, so the sweep can always find it,
  // stamped with the account that created it so no other account sweeps it.
  const owner = await currentSessionUserId().catch(() => null);
  await writeCreatedIds([...(await readCreatedIds()), { id: round.id, userId: owner }]);
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
    const me = await currentSessionUserId().catch(() => null);
    const active = await getActiveTutorialRoundId();
    const created = await readCreatedIds();
    // Only this account's rounds are ever candidates. The active-round key is
    // device-wide too and carries no owner, so it is NOT added here: an id
    // that reached it without reaching the registry would be unattributable,
    // and sweeping an unattributable id is the whole hole. createTutorialRound
    // writes the registry BEFORE the active key, so this costs nothing except
    // in the double-failure case, where the cost is one uncollected round.
    if (!me) return 0;
    const candidates = new Set<string>(
      created.filter((e) => e.userId === me).map((e) => e.id)
    );

    const sweptIds = new Set<string>();
    for (const id of candidates) {
      const row = await getLocalRound(id).catch(() => null);
      // A missing local row is expected — the round may already be gone
      // locally while the remote row survives, which is what this sweep is
      // for. A row that exists but is NOT a tutorial round means the id was
      // recycled or the registry is wrong; leave it alone.
      if (row && row.course_name !== TUTORIAL_COURSE_NAME) continue;

      // Both halves must actually succeed before the id is retired. The
      // registry is now the ONLY record of a tutorial round — the orphan scan
      // that used to rediscover one is gone, deliberately — so forgetting an
      // id after a failed delete strands that round forever. deleteRound is a
      // network call and throws when it fails, which at app start (opening the
      // app on the course with no signal) is routine rather than exotic:
      // swallowing that and dropping the id would leave the round on the
      // server with nothing left to retry it. Both are safe to repeat —
      // deleting rows that are already gone is a no-op — so a failure just
      // means the next launch tries again.
      // The local delete runs ONLY against a row the scoped read handed back.
      // `getLocalRound` returns null for two different things — "already gone"
      // and "belongs to another account" — and `deleteLocalRound` is not
      // ownership-scoped: it deletes by round_id alone and unlinks every clip
      // file it finds. Treating null as permission discards the one signal
      // that says "not yours". The registry stamp makes that hard to reach,
      // but `createTutorialRound` resolves the owner in a SEPARATE call after
      // `createRound`, so a session change between the two can stamp one
      // account's round with another's id — and then this would be the only
      // thing left. Null counts as success so the id can still retire once the
      // remote delete lands.
      const localOk = row
        ? await deleteLocalRound(id).then(
            () => true,
            () => false
          )
        : true;
      const remoteOk = await deleteRound(id).then(
        () => true,
        () => false
      );
      if (!localOk || !remoteOk) continue;
      sweptIds.add(id);
      swept += 1;
    }

    // Drop only what was fully cleaned, so the registry does not grow for the
    // life of the install. Anything skipped or partly failed stays, so it is
    // retried rather than silently forgotten — and entries owned by OTHER
    // accounts are preserved untouched, so their rounds are still swept the
    // next time those accounts sign in.
    await writeCreatedIds(created.filter((e) => !sweptIds.has(e.id)));
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
