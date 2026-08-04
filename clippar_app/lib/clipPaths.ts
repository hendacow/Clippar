/**
 * Which stored clip URIs iOS is allowed to delete out from under us — and what
 * to do about each kind.
 *
 * WHY THIS IS ITS OWN MODULE. The answer to "is this path safe to keep in
 * local_clips?" was written out by hand in three places that had to agree and
 * didn't:
 *
 *   1. the SQL in lib/storage.ts (getClipsWithLegacyUris) — which ROWS the
 *      startup migration even looks at;
 *   2. the `isEvictable` / `needsCopy` closures in lib/uriMigration.ts — what
 *      it then does with them;
 *   3. the `inAppCache` check in lib/media.ts (persistAsset) — whether the
 *      rescue is a cheap rename or a full byte copy.
 *
 * All three listed `ph://`, `assets-library://`, `/tmp/` and
 * `Library/Caches/ImagePicker/` — the four ways an IMPORTED clip could sit on
 * borrowed storage. Neither of the two ways the app's OWN footage does was on
 * any of the lists:
 *
 *   - expo-camera writes every recording to `Library/Caches/…/Camera/<uuid>.mov`
 *     (`FileSystemUtilities.generatePathInCache(appContext, in: "Camera", …)`
 *     in CameraVideoRecording.swift), and hooks/useCamera.ts stored that path
 *     verbatim as both file_uri and original_file_uri;
 *   - modules/shot-detector writes its trim to `Library/Caches/trim_<uuid>`,
 *     and markClipTrimmed promoted that path into file_uri — so even a clip
 *     whose original was durable was PLAYED from, exported from and uploaded
 *     from a file iOS could delete.
 *
 * So the system cache held the only copy of footage that can never be re-shot,
 * the migration's SELECT could not see those rows, and a golfer whose phone ran
 * low on space opened the editor to empty holes.
 *
 * The bug was not a missing branch — it was one rule spelled out four times.
 * It lives here now, as data, and the SQL is GENERATED from the same list the
 * predicates read, so the query and the code cannot drift apart again.
 *
 * Deliberately pure and import-free (no react-native, no expo) so the node
 * test runner can execute it — see tests/clipPaths.test.ts.
 *
 * iOS shapes only. There is no android/ project in this repo; expo-camera on
 * Android caches to `<pkg>/cache/Camera/`, so whoever adds that build adds the
 * fragment here rather than at a call site.
 */

/**
 * URI schemes that are not files at all — PhotoKit references. These are
 * rescued by RESOLVING them (MediaLibrary localUri), never by copying: the
 * resolved file lives in the Photos sandbox, which iOS does not purge under
 * memory pressure and which we do not own.
 */
const PHOTO_REF_PREFIXES = ['ph://', 'assets-library://'] as const;

/**
 * Path fragments that put a real file in storage iOS may reclaim at any time.
 *
 *   /tmp/            — NSTemporaryDirectory; wiped on reinstall and whenever
 *                      iOS feels like it.
 *   /Library/Caches/ — everything the app and its dependencies stage there:
 *                      expo-image-picker's copy of a picked video
 *                      (ImagePicker/), expo-camera's recording (…/Camera/),
 *                      and modules/shot-detector's `trim_<uuid>` output, which
 *                      markClipTrimmed promotes into file_uri.
 *
 * WHY THE WHOLE CACHE DIRECTORY, rather than naming the three subpaths. The
 * question this answers is only ever asked about a URI STORED IN local_clips,
 * and for those there is exactly one durable home — documentDirectory/clips/.
 * Anything else in the sandbox is on loan. Enumerating the known writers is
 * how the camera directory came to be missed in the first place: each new
 * capture or export path is a new fragment somebody has to remember to add
 * here, and the failure is silent and destroys footage.
 *
 * This does NOT fight lib/cacheReclaim.ts, which ages `trim_`/`stitch_`/
 * `tracer_`/`clippar_reel_` files out of the cache. That sweep skips anything
 * a local_clips row still points at, and a row pointing at it is the only
 * reason this module would ever look at a file — the two never contend for the
 * same file. The composed reel is likewise safe: it lives in local_rounds
 * .reel_url, which this rule is never applied to, and the `recovered-clips/`
 * downloads app/round/editor.tsx makes during a compose are held in a local
 * array and never written to a row at all.
 */
const PURGEABLE_FRAGMENTS = ['/tmp/', '/Library/Caches/'] as const;

/**
 * A real on-disk file inside our own sandbox that iOS may purge.
 *
 * Two things follow from a true here, and both matter:
 *   - the file must be physically MOVED somewhere durable; resolving the URI
 *     achieves nothing because it is already a valid path to a doomed file;
 *   - the move can be a rename. Source and destination share the app
 *     container's volume, and we want the original gone anyway — which is why
 *     persistAsset asks this question rather than copying ~150MB per clip.
 */
export function isPurgeableAppPath(uri: string | null | undefined): boolean {
  if (!uri) return false;
  return PURGEABLE_FRAGMENTS.some((fragment) => uri.includes(fragment));
}

/**
 * Anything stored in local_clips that is NOT a durable path — the full set the
 * startup migration must examine. Photo references need resolving; everything
 * else (see isPurgeableAppPath) needs moving.
 */
export function isEvictableUri(uri: string | null | undefined): boolean {
  if (!uri) return false;
  if (PHOTO_REF_PREFIXES.some((prefix) => uri.startsWith(prefix))) return true;
  return isPurgeableAppPath(uri);
}

/**
 * The same rule as isEvictableUri, as a SQL fragment for one column, so
 * getClipsWithLegacyUris selects exactly the rows the migration can act on.
 *
 * Generated rather than hand-written because the hand-written version is what
 * broke: the predicates above could learn about the camera cache and the query
 * would still refuse to return those rows, leaving the new branch unreachable
 * and the footage unrescued.
 */
export function evictableUriSql(column: string): string {
  // Every caller passes a literal from our own source, but this string is
  // concatenated into SQL — so refuse anything that isn't a plain identifier
  // rather than trust that that stays true.
  if (!/^[a-z_][a-z0-9_]*$/i.test(column)) {
    throw new Error(`evictableUriSql: unsafe column name ${JSON.stringify(column)}`);
  }
  const clauses = [
    ...PHOTO_REF_PREFIXES.map((prefix) => `${column} LIKE '${prefix}%'`),
    ...PURGEABLE_FRAGMENTS.map((fragment) => `${column} LIKE '%${fragment}%'`),
  ];
  return clauses.join('\n        OR ');
}

/**
 * The container extension of a video URI, for naming its durable copy.
 *
 * Recordings are `.mov` (AVCaptureMovieFileOutput) while imports are `.mp4`,
 * and the rescue paths used to hardcode `.mp4` for both. Renaming a QuickTime
 * file to `.mp4` mostly works and then doesn't: AVURLAsset takes the extension
 * as a type hint, so the mislabelled clip is exactly the kind of thing that
 * plays in the editor and fails in an export. Cheaper to keep the real one.
 */
export function videoExtension(uri: string, fallback = 'mp4'): string {
  const name = (uri.split('?')[0].split('/').pop() ?? '').trim();
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return fallback;
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : fallback;
}
