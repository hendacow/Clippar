/**
 * Trainee mode — range practice sessions.
 *
 * A practice session IS a round. That single decision is what keeps this
 * feature small: clips save through the same useCamera pipeline (detection,
 * auto-trim, the Photos mirror, upload queue), the editor reviews them, the
 * per-hole stitch/share machinery exports them, and the Recently-deleted bin
 * protects them — none of that code knows training mode exists.
 *
 * The mapping that makes it work: **each club is a "hole"**. A 7-iron shot is
 * saved with hole_number = CLUBS['7i'].holeNumber, so grouping-by-hole IS
 * grouping-by-club, "export hole 10" IS "export every 9-iron", and the
 * editor's select mode IS the club filter. No schema change — hole_number is
 * an unconstrained INTEGER and nothing in SQLite cares that "hole 3" means
 * 5-wood. The cost is that training rounds must be labelled at the UI layer
 * (the `training=1` route param) so screens say "7 iron", never "Hole 8".
 *
 * Which rounds are training sessions lives in local_settings under
 * TRAINING_REGISTRY_KEY — the same no-migration store the clip bin uses, and
 * for the same reason: nothing schema-shaped runs on a device already holding
 * real rounds.
 */
import { getSetting, setSetting, saveLocalRound, getClipsForRound, updateLocalRound, getLocalRound } from '@/lib/storage';
import { createRound } from '@/lib/api';

/**
 * Does the signed-in account own this round?
 *
 * `getClipsForRound` is a bare `WHERE round_id = ?` with no ownership
 * predicate, and the registry below is a device-wide `local_settings` row that
 * accumulates sessions from every account that has used the handset. Together
 * those two facts leaked real footage: B signs in on A's phone, opens Practice,
 * sees A's sessions with true shot counts, taps Watch, and
 * `app/training/play.tsx` plays A's swing videos — it reads clips straight out
 * of `listTrainingClips` with nothing checking who owns them. The editor route
 * off the same screen was already safe because `useEditorState.loadFromLocal`
 * gates on `getLocalRound` first; the player simply did not.
 *
 * So the gate lives HERE, at the data layer, rather than in one screen —
 * `getLocalRound` is scoped through `ownedRoundsClause` and fails closed, so a
 * round belonging to anybody else reads as null. That also handles registry
 * entries written before this check existed: ownership is decided by the
 * database, not by what the settings blob happens to say.
 */
async function ownsRound(roundId: string): Promise<boolean> {
  try {
    return (await getLocalRound(roundId)) != null;
  } catch {
    return false;
  }
}

/**
 * The same gate, for screens that write through a path this module does not own.
 *
 * `app/training/record.tsx` takes `roundId` from the URL and hands it to
 * `useCamera`, whose save path is a bare `saveLocalClip({ round_id })` with no
 * ownership predicate — and `app.config.js` sets a URL scheme, so that route is
 * externally reachable. Gating `importShotsToSession` and leaving capture open
 * would protect one of the two ways shots enter a session, which is the same
 * half-covered mistake the reads had.
 */
export async function ownsTrainingRound(roundId: string): Promise<boolean> {
  return ownsRound(roundId);
}

export interface TrainingClub {
  key: string;
  label: string;
  /** Short chip label for the capture screen. */
  short: string;
  holeNumber: number;
}

// A 14-club bag plus the putter. Order is bag order, longest to shortest —
// it is also the order sections appear in review, so drivers lead.
// holeNumber is POSITIONAL and therefore append-only: renumbering an
// existing club orphans every shot already recorded under its old number.
export const CLUBS: readonly TrainingClub[] = [
  { key: 'driver', label: 'Driver', short: 'Dr', holeNumber: 1 },
  { key: '3w', label: '3 Wood', short: '3W', holeNumber: 2 },
  { key: '5w', label: '5 Wood', short: '5W', holeNumber: 3 },
  { key: 'hybrid', label: 'Hybrid', short: 'Hy', holeNumber: 4 },
  { key: '4i', label: '4 Iron', short: '4i', holeNumber: 5 },
  { key: '5i', label: '5 Iron', short: '5i', holeNumber: 6 },
  { key: '6i', label: '6 Iron', short: '6i', holeNumber: 7 },
  { key: '7i', label: '7 Iron', short: '7i', holeNumber: 8 },
  { key: '8i', label: '8 Iron', short: '8i', holeNumber: 9 },
  { key: '9i', label: '9 Iron', short: '9i', holeNumber: 10 },
  { key: 'pw', label: 'Pitching Wedge', short: 'PW', holeNumber: 11 },
  { key: 'gw', label: 'Gap Wedge', short: 'GW', holeNumber: 12 },
  { key: 'sw', label: 'Sand Wedge', short: 'SW', holeNumber: 13 },
  { key: 'lw', label: 'Lob Wedge', short: 'LW', holeNumber: 14 },
  { key: 'putter', label: 'Putter', short: 'Pt', holeNumber: 15 },
] as const;

export function clubForHole(holeNumber: number): TrainingClub | null {
  return CLUBS.find((c) => c.holeNumber === holeNumber) ?? null;
}

/** What review screens print for a training "hole". Falls back honestly. */
export function trainingHoleLabel(holeNumber: number): string {
  return clubForHole(holeNumber)?.label ?? `Club ${holeNumber}`;
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

const TRAINING_REGISTRY_KEY = 'training.sessions.v1';

export interface TrainingSessionRef {
  roundId: string;
  /** ISO timestamp of session start — the date the history screen filters by. */
  startedAt: string;
}

async function readRegistry(): Promise<TrainingSessionRef[]> {
  try {
    const raw = await getSetting(TRAINING_REGISTRY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as TrainingSessionRef[]) : [];
  } catch {
    return [];
  }
}

/** Newest first, and only the signed-in account's own sessions. */
export async function listTrainingSessions(): Promise<TrainingSessionRef[]> {
  const all = await readRegistry();
  const owned: TrainingSessionRef[] = [];
  for (const s of all) {
    if (await ownsRound(s.roundId)) owned.push(s);
  }
  return owned.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/**
 * Start a practice session: a real round (Supabase + local, so the clip
 * upload queue and recovery treat it like any other) registered as training.
 * The course name is what the editor shows as its title.
 */
export async function startTrainingSession(): Promise<string> {
  const round = await createRound({ course_name: 'Practice range' });
  if (!round) throw new Error('Failed to create practice session');
  await saveLocalRound({ id: round.id, course_name: 'Practice range' });
  // Immediately 'finished' ON PURPOSE. status='in_progress' is what feeds the
  // record tab's orphaned-round card, whose Resume would recover this as a
  // LIVE round (holes, scorecard) and whose Discard would delete the practice
  // clips — both wrong for a range session. Nothing in the clip pipeline
  // gates on round status, and the Practice hub resumes sessions from its own
  // registry, so 'finished' costs nothing and closes that footgun.
  await updateLocalRound(round.id, { status: 'finished', finished_at: new Date().toISOString() });
  const entries = await readRegistry();
  entries.push({ roundId: round.id, startedAt: new Date().toISOString() });
  await setSetting(TRAINING_REGISTRY_KEY, JSON.stringify(entries));
  return round.id;
}

// ---------------------------------------------------------------------------
// Per-session shot data (the history screen's summaries + the player's list)
// ---------------------------------------------------------------------------

export interface TrainingClip {
  id: number;
  holeNumber: number;
  shotNumber: number;
  fileUri: string;
  timestamp: string;
  durationSeconds: number | null;
}

/** All of a session's shots, oldest first (the order they were hit). */
export async function listTrainingClips(roundId: string, clubHole?: number): Promise<TrainingClip[]> {
  // Ownership gate — see ownsRound. This is what the ASMR player relies on.
  if (!(await ownsRound(roundId))) return [];
  const rows = await getClipsForRound(roundId);
  return rows
    .filter((r) => (clubHole == null ? true : r.hole_number === clubHole))
    .map((r) => ({
      id: r.id,
      holeNumber: r.hole_number,
      shotNumber: r.shot_number,
      fileUri: r.file_uri,
      timestamp: r.timestamp,
      durationSeconds: r.duration_seconds,
    }))
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
}

/** { holeNumber → shots hit } for one session — the history row's summary. */
export async function trainingShotCounts(roundId: string): Promise<Map<number, number>> {
  // Ownership gate — see ownsRound. Counts alone told B how many shots A hit
  // with each club, before B had played a single one of them.
  if (!(await ownsRound(roundId))) return new Map();
  const rows = await getClipsForRound(roundId);
  const counts = new Map<number, number>();
  for (const r of rows) counts.set(r.hole_number, (counts.get(r.hole_number) ?? 0) + 1);
  return counts;
}

// ---------------------------------------------------------------------------
// ASMR playback — per-shot play length
// ---------------------------------------------------------------------------
//
// Henry's correction, 30 Aug: "it's how long each vid is". The rhythm of the
// ASMR cut comes from every shot playing for the SAME chosen length — not
// from a silence between clips. The first build got this wrong (a gap
// between full-length clips); the knob below is the play length per shot.
// When a clip is longer than the chosen length, the player shows a window
// centred on the clip's middle — auto-trim already centres the swing, so the
// middle of the trimmed clip IS the strike.

const PLAY_LENGTH_KEY = 'training.play_length_ms';

export const PLAY_LENGTH_OPTIONS_MS = [500, 1000, 2000, 3000] as const;
const DEFAULT_PLAY_LENGTH_MS = 1000;

export async function getPlayLengthMs(): Promise<number> {
  try {
    const raw = await getSetting(PLAY_LENGTH_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    return (PLAY_LENGTH_OPTIONS_MS as readonly number[]).includes(n) ? n : DEFAULT_PLAY_LENGTH_MS;
  } catch {
    return DEFAULT_PLAY_LENGTH_MS;
  }
}

export async function setPlayLengthMs(ms: number): Promise<void> {
  try {
    await setSetting(PLAY_LENGTH_KEY, String(ms));
  } catch {}
}

export function playLengthLabel(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms / 1000}s`;
}

// ---------------------------------------------------------------------------
// Importing existing videos into a session
// ---------------------------------------------------------------------------

/**
 * Save already-picked videos into a session under one club. Files are copied
 * into documentDirectory/clips/ first (persistAsset) — picker URIs are
 * temporary and evaporate under storage pressure, which is the same lesson
 * app/round/import.tsx already carries.
 *
 * Clips are saved needs_trim=1 / auto_trimmed=0, exactly the shape live
 * recording uses before detection: the editor's processAllUntrimmed pass
 * auto-trims them through the SAME detectAndTrim path the moment review is
 * opened, so imported range shots get swing-centred just like filmed ones.
 */
export async function importShotsToSession(
  roundId: string,
  clubHole: number,
  assets: { uri: string; durationMs?: number | null }[]
): Promise<number> {
  // Never write clips into a round this account does not own — the same gate
  // the reads use, so a stale nav param cannot file shots into someone else's
  // session.
  if (!(await ownsRound(roundId))) return 0;
  const { persistAsset } = require('@/lib/media') as typeof import('@/lib/media');
  const existing = await getClipsForRound(roundId);
  let shot = existing.filter((c) => c.hole_number === clubHole).length;
  let saved = 0;
  for (const asset of assets) {
    shot += 1;
    const filename = `imported_${roundId}_h${clubHole}_s${shot}_${Date.now()}.mp4`;
    let uri = asset.uri;
    try {
      uri = await persistAsset(asset.uri, filename);
    } catch {
      // Fall back to the picker URI rather than dropping the shot — worst
      // case the editor's file-missing handling reports it honestly later.
    }
    const { saveLocalClip } = require('@/lib/storage') as typeof import('@/lib/storage');
    await saveLocalClip({
      round_id: roundId,
      hole_number: clubHole,
      shot_number: shot,
      file_uri: uri,
      original_file_uri: uri,
      duration_seconds: asset.durationMs ? asset.durationMs / 1000 : undefined,
      needs_trim: 1,
      auto_trimmed: 0,
    });
    saved += 1;
  }
  return saved;
}
