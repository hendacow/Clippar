import { useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Alert,
  Platform,
  Image,
  ActionSheetIOS,
  Keyboard,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  Plus,
  X,
  Film,
  ChevronDown,
  ChevronUp,
  Zap,
  List,
  AlertTriangle,
  ImagePlus,
  Info,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { CourseSearch } from '@/components/record/CourseSearch';
import {
  createRound,
  createShot,
  updateRound,
  saveScoreToSupabase,
  listCoursePresets,
  touchCoursePreset,
} from '@/lib/api';
import type { CoursePreset } from '@/types/preset';
import { buildHoleDataFromPars, presetHasScorecard } from '@/lib/scorecardLogic';
import { PresetPickerScreen } from '@/components/record/PresetPickerScreen';
import { PresetConfirmSheet } from '@/components/record/PresetConfirmSheet';
import {
  saveLocalClip,
  saveLocalRound,
  saveLocalScore,
  setClipPhotosAssetId,
  getMirrorClipsToPhotos,
  getCloudBackupEnabled,
} from '@/lib/storage';
import { resolveAssetUri, persistAsset } from '@/lib/media';
import { enqueueRoundUpload } from '@/lib/uploadQueue';
import { supabase } from '@/lib/supabase';
import type { HoleData } from '@/types/round';
import { detectSwing } from 'shot-detector';
import type { ShotTypeClassification } from 'shot-detector';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

const ImagePicker = isNative
  ? (require('expo-image-picker') as typeof import('expo-image-picker'))
  : null;

const VideoThumbnails = Platform.OS !== 'web'
  ? (require('expo-video-thumbnails') as typeof import('expo-video-thumbnails'))
  : null;

const MediaLibrary = isNative
  ? (require('expo-media-library') as typeof import('expo-media-library'))
  : null;

// Safe wrapper around expo-image-picker's launchImageLibraryAsync. When the
// user picks a video that lives in iCloud Photos (not yet downloaded to the
// device), iOS tries to stream the bytes down on the fly. If that fails for
// any reason — flaky network, iCloud throttling, asset not yet replicated,
// app suspended mid-download — the picker rejects with a PHPhotosErrorDomain
// 3164 ("The operation couldn't be completed.") error. Sentry caught this
// uncaught in production (CLIPPAR-9). We swallow it here, return null so the
// caller treats it as "user cancelled", and surface a friendly Alert that
// tells the user how to recover (download the videos in the Photos app
// first, then come back and import).
async function pickVideosSafely(
  options: Parameters<NonNullable<typeof ImagePicker>['launchImageLibraryAsync']>[0]
): Promise<Awaited<ReturnType<NonNullable<typeof ImagePicker>['launchImageLibraryAsync']>> | null> {
  if (!ImagePicker) return null;
  try {
    return await ImagePicker.launchImageLibraryAsync(options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const looksLikeICloudFailure =
      /PHPhotosError/i.test(msg) ||
      /3164/.test(msg) ||
      /operation couldn.t be completed/i.test(msg);
    console.warn('[import] picker failed:', msg);
    if (looksLikeICloudFailure) {
      Alert.alert(
        'Video stored in iCloud',
        "iOS couldn't download one of the videos you picked. Open the Photos app, tap the video so it downloads to your phone, then come back and try the import again.",
      );
    } else {
      Alert.alert(
        "Couldn't open videos",
        'Something went wrong picking videos. Try again, or restart the app if it keeps happening.',
      );
    }
    return null;
  }
}

// Gap (ms) between consecutive clip creationTimes that signals a new hole.
const HOLE_GAP_MS = 3 * 60 * 1000; // > 3 minutes = new hole
const HOLE_GAP_AMBIGUOUS_MS = 2 * 60 * 1000; // 2-3min is ambiguous, confirm with pose

interface ImportedClip {
  uri: string;         // the picker URI (this IS the original video)
  durationMs?: number; // from expo-image-picker asset.duration
  thumbnailUri?: string;
  // PhotoKit localIdentifier (iOS) / MediaStore uri (Android). Stored on the
  // clip so we can re-import the source video from Photos after a reinstall.
  assetId?: string;
}

interface HoleImport {
  holeNumber: number;
  par: number;
  clips: ImportedClip[];
  expanded: boolean;
}

// Wave 3 Phase D-redo: 'preset-picker' is the new initial step shown
// when the user has at least one saved preset. The picker lets them
// one-tap a saved round (which routes through a confirm sheet) or pick
// "Set up new round" to fall through to the existing 'setup' step.
type ImportStep = 'preset-picker' | 'setup' | 'mode' | 'scorecard' | 'bulk-import' | 'import';

export default function ImportRoundScreen() {
  const insets = useSafeAreaInsets();
  const [courseName, setCourseName] = useState('');
  const [selectedCourseId, setSelectedCourseId] = useState<string | undefined>();
  const [courseHoles, setCourseHoles] = useState<HoleData[]>([]);
  const [holesCount, setHolesCount] = useState(18);
  const [holes, setHoles] = useState<HoleImport[]>([]);
  // Default to 'setup' for users with no presets; users WITH presets get
  // promoted to 'preset-picker' by the lazy-load effect below as soon as
  // their preset list comes back from Supabase.
  const [step, setStep] = useState<ImportStep>('setup');
  const [importing, setImporting] = useState(false);
  // Per-clip import progress for the final import phase (button label uses this
  // so the user sees "Importing N of M clips" instead of an unbounded spinner).
  const [importProgress, setImportProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });

  // Import flow mode. Auto-detect was removed in Phase D — it was unreliable
  // for casual golfers (false-positive putt→swing transitions broke hole
  // grouping). Quick Import + Manual Import cover everything users actually
  // need.
  const [importMode, setImportMode] = useState<'quick' | 'manual' | null>(null);
  const [startingNine, setStartingNine] = useState<'front' | 'back'>('front');
  const [scores, setScores] = useState<Record<number, number>>({});
  const [pars, setPars] = useState<Record<number, number>>({});
  const [selectedScoreCell, setSelectedScoreCell] = useState<number | null>(null);
  const [bulkVideos, setBulkVideos] = useState<{ uri: string; duration?: number; assetId?: string }[]>([]);
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const [sanityWarning, setSanityWarning] = useState<{ oversizedHoles: number[] } | null>(null);

  // Wave 3 Phase D-redo: presets list + sheet-confirm state.
  //   - `presets` holds the user's saved rounds, loaded on mount.
  //   - `presetsLoading` lets the picker show a skeleton until the first
  //     response arrives.
  //   - `confirmingPreset` is non-null while the bottom-sheet confirm
  //     dialog is open over the picker.
  const [presets, setPresets] = useState<CoursePreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [confirmingPreset, setConfirmingPreset] = useState<CoursePreset | null>(null);

  useEffect(() => {
    let cancelled = false;
    listCoursePresets()
      .then((rows) => {
        if (cancelled) return;
        setPresets(rows);
        // Auto-promote into the preset-picker step IFF we're still on
        // the default 'setup' step (user hasn't navigated yet) and we
        // actually have presets to show. This avoids ping-ponging the
        // user back to a picker they already dismissed by tapping "Set
        // up new round".
        if (rows.length > 0) {
          setStep((prev) => (prev === 'setup' ? 'preset-picker' : prev));
        }
      })
      .catch((err) => {
        console.log('[import] listCoursePresets failed:', err?.message);
      })
      .finally(() => {
        if (!cancelled) setPresetsLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Pre-fill the setup state from a preset (called after the user
  // confirms in the bottom sheet, possibly with an overridden start
  // hole). Then advance to the setup step so the user can review/edit
  // the course before continuing to scorecard / mode select.
  const applyPreset = (
    preset: CoursePreset,
    overrides?: { startHole?: 1 | 10 }
  ) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const effectiveStartHole = overrides?.startHole ?? preset.start_hole;
    setCourseName(preset.course_name);
    setSelectedCourseId(preset.course_id ?? undefined);
    setHolesCount(preset.holes_played);
    setStartingNine(effectiveStartHole === 10 ? 'back' : 'front');
    // Custom-scorecard presets carry a per-hole par override. Seed courseHoles
    // from it so initScorecard / initHoles pick up the user's pars (which then
    // flow into the persisted scores.par and total_par) instead of the API's.
    // Legacy presets (no hole_pars) leave courseHoles untouched → API/seeded
    // par as before.
    if (presetHasScorecard(preset)) {
      setCourseHoles(
        buildHoleDataFromPars(preset.hole_pars as number[], effectiveStartHole),
      );
    }
    // Bump last_used_at so this preset sorts to the top next time.
    // Best-effort — failure shouldn't tank the import.
    void touchCoursePreset(preset.id);
    setStep('setup');
  };

  const handleCourseSelect = (course: { id: string; name: string }, holeData: HoleData[]) => {
    setSelectedCourseId(course.id);
    if (holeData.length > 0) {
      setCourseHoles(holeData);
    }
  };

  // The real hole numbers this round plays, in play order, starting from the
  // chosen nine. A round plays `holesCount` consecutive holes from the start
  // hole (1 for the front nine, 10 for the back), wrapping 18→1 so a full 18
  // teed off the back reads 10..18 then 1..9. Count-correct for every option
  // the setup offers (3/6/9/12/15/18) — a partial round no longer silently
  // expands to 18 holes, and a back-nine round yields 10..18 not 1..9.
  const getOrderedHoleNumbers = useCallback((): number[] => {
    const startHole = startingNine === 'back' ? 10 : 1;
    return Array.from(
      { length: holesCount },
      (_, i) => ((startHole - 1 + i) % 18) + 1,
    );
  }, [holesCount, startingNine]);

  const initHoles = useCallback(() => {
    if (!courseName.trim()) {
      Alert.alert('Course Name', 'Please enter or select a course.');
      return;
    }

    // Number the holes from the actual played hole numbers (start-hole aware),
    // NOT a flat 1..holesCount. A back-nine scorecard preset seeds courseHoles
    // at holes 10..18; keying off getOrderedHoleNumbers() lets courseHoles.find
    // match those, so the user's saved per-hole pars survive to submit (manual
    // mode reads hole.par directly) instead of falling back to par 4. Mirrors
    // the numbering initScorecard already uses.
    const holeList: HoleImport[] = getOrderedHoleNumbers().map((holeNum) => {
      const courseHole = courseHoles.find((h) => h.holeNumber === holeNum);
      return {
        holeNumber: holeNum,
        par: courseHole?.par ?? 4,
        clips: [],
        expanded: true,
      };
    });
    setHoles(holeList);
    setStep('mode');
  }, [courseName, courseHoles, getOrderedHoleNumbers]);

  const initScorecard = useCallback(() => {
    const ordered = getOrderedHoleNumbers();
    const initialPars: Record<number, number> = {};
    for (const holeNum of ordered) {
      const courseHole = courseHoles.find((h) => h.holeNumber === holeNum);
      initialPars[holeNum] = courseHole?.par ?? 4;
    }
    setPars(initialPars);
    setScores({});
    setSelectedScoreCell(null);
    setStep('scorecard');
  }, [courseHoles, getOrderedHoleNumbers]);

  const handleModeSelect = (mode: 'quick' | 'manual') => {
    setImportMode(mode);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (mode === 'manual') {
      setStep('import');
    } else {
      initScorecard();
    }
  };

  // Scorecard helpers
  const cyclePar = (holeNum: number) => {
    Haptics.selectionAsync();
    setPars((prev) => {
      const current = prev[holeNum] ?? 4;
      const next = current === 3 ? 4 : current === 4 ? 5 : 3;
      return { ...prev, [holeNum]: next };
    });
  };

  const setScoreForHole = (holeNum: number, score: number) => {
    Haptics.selectionAsync();
    setScores((prev) => {
      if (prev[holeNum] === score) {
        // Tap same score again to clear
        const next = { ...prev };
        delete next[holeNum];
        return next;
      }
      return { ...prev, [holeNum]: score };
    });
    // Auto-advance to next cell
    const ordered = getOrderedHoleNumbers();
    const currentIdx = ordered.indexOf(holeNum);
    if (currentIdx < ordered.length - 1) {
      setSelectedScoreCell(ordered[currentIdx + 1]);
    } else {
      setSelectedScoreCell(null);
    }
  };

  const getScoreColor = (holeNum: number): string => {
    const score = scores[holeNum];
    const par = pars[holeNum] ?? 4;
    if (score === undefined || score === 0) return theme.colors.textTertiary;
    const diff = score - par;
    if (diff <= -2) return theme.colors.eagle;
    if (diff === -1) return theme.colors.birdie;
    if (diff === 0) return theme.colors.par;
    if (diff === 1) return theme.colors.bogey;
    return theme.colors.doubleBogey;
  };

  const totalStrokes = Object.values(scores).reduce((sum, s) => sum + (s || 0), 0);

  // Bulk import: pick all videos at once
  const pickBulkVideos = async () => {
    const result = await pickVideosSafely({
      mediaTypes: ['videos'],
      allowsMultipleSelection: true,
      quality: 1,
      orderedSelection: true,
    });

    if (!result || result.canceled || !result.assets?.length) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setBulkVideos(
      result.assets.map((a) => ({
        uri: a.uri,
        duration: a.duration ?? undefined,
        assetId: a.assetId ?? undefined,
      }))
    );
  };

  // Auto-distribute videos across holes based on scores — metadata only, no processing
  const handleBulkImport = async () => {
    setBulkProcessing(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const ordered = getOrderedHoleNumbers();
    let videoIdx = 0;

    const updatedHoles: HoleImport[] = ordered.map((holeNum) => {
      const holeScore = scores[holeNum] || 0;
      const holePar = pars[holeNum] ?? 4;
      const clips: ImportedClip[] = [];

      for (let s = 0; s < holeScore && videoIdx < bulkVideos.length; s++) {
        const video = bulkVideos[videoIdx];
        clips.push({ uri: video.uri, durationMs: video.duration, assetId: video.assetId });
        videoIdx++;
      }

      return { holeNumber: holeNum, par: holePar, clips, expanded: clips.length > 0 };
    });

    setHoles(updatedHoles);

    // Fire-and-forget thumbnail generation for all bulk-imported clips
    for (const hole of updatedHoles) {
      for (const clip of hole.clips) {
        VideoThumbnails?.getThumbnailAsync(clip.uri, { time: 500, quality: 0.3 })
          .then((thumb) => {
            setHoles((prev) =>
              prev.map((h) =>
                h.holeNumber === hole.holeNumber
                  ? {
                      ...h,
                      clips: h.clips.map((c) =>
                        c.uri === clip.uri ? { ...c, thumbnailUri: thumb.uri } : c
                      ),
                    }
                  : h
              )
            );
          })
          .catch(() => {});
      }
    }

    setBulkVideos([]); // Free bulk videos array
    setBulkProcessing(false);
    setStep('import');
  };

  const toggleExpanded = (holeNumber: number) => {
    setHoles((prev) =>
      prev.map((h) =>
        h.holeNumber === holeNumber ? { ...h, expanded: !h.expanded } : h
      )
    );
  };

  // Pick clips for a single hole — just add URIs, no processing
  const pickClipsForHole = async (holeNumber: number) => {
    const result = await pickVideosSafely({
      mediaTypes: ['videos'],
      allowsMultipleSelection: true,
      quality: 1,
    });

    if (!result || result.canceled || !result.assets?.length) return;

    const newClips: ImportedClip[] = result.assets.map((asset) => ({
      uri: asset.uri,
      durationMs: asset.duration ? asset.duration : undefined,
      assetId: asset.assetId ?? undefined,
    }));

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setHoles((prev) =>
      prev.map((h) =>
        h.holeNumber === holeNumber
          ? { ...h, clips: [...h.clips, ...newClips], expanded: true }
          : h
      )
    );

    // Fire-and-forget thumbnail generation
    for (const clip of newClips) {
      VideoThumbnails?.getThumbnailAsync(clip.uri, { time: 500, quality: 0.3 })
        .then((thumb) => {
          setHoles((prev) =>
            prev.map((h) =>
              h.holeNumber === holeNumber
                ? {
                    ...h,
                    clips: h.clips.map((c) =>
                      c.uri === clip.uri ? { ...c, thumbnailUri: thumb.uri } : c
                    ),
                  }
                : h
            )
          );
        })
        .catch(() => {});
    }
  };

  const removeClip = (holeNumber: number, clipIndex: number) => {
    setHoles((prev) =>
      prev.map((h) =>
        h.holeNumber === holeNumber
          ? { ...h, clips: h.clips.filter((_, i) => i !== clipIndex) }
          : h
      )
    );
  };

  // Refs for review-screen scroll + per-hole layout positions (used after a move)
  const reviewScrollRef = useRef<ScrollView | null>(null);
  const holeOffsetsRef = useRef<Record<number, number>>({});

  const moveClipToHole = (
    sourceHole: number,
    clipIndex: number,
    targetHole: number,
  ) => {
    if (sourceHole === targetHole) return;

    setHoles((prev) => {
      const source = prev.find((h) => h.holeNumber === sourceHole);
      if (!source || !source.clips[clipIndex]) return prev;
      const moving = source.clips[clipIndex];

      return prev.map((h) => {
        if (h.holeNumber === sourceHole) {
          return {
            ...h,
            clips: h.clips.filter((_, i) => i !== clipIndex),
          };
        }
        if (h.holeNumber === targetHole) {
          return {
            ...h,
            clips: [...h.clips, moving],
            expanded: true,
          };
        }
        return h;
      });
    });

    Haptics.selectionAsync();

    // Scroll to target hole shortly after layout settles
    setTimeout(() => {
      const y = holeOffsetsRef.current[targetHole];
      if (typeof y === 'number' && reviewScrollRef.current) {
        reviewScrollRef.current.scrollTo({ y: Math.max(0, y - 12), animated: true });
      }
    }, 120);
  };

  const promptMoveClip = (sourceHole: number, clipIndex: number) => {
    // Real played hole numbers (start-hole aware) so moving a clip on a
    // back-nine round targets holes 10..18, matching the holes state — not a
    // phantom 1..9 that would drop the clip into a non-existent hole.
    const targets = getOrderedHoleNumbers();
    const labels = targets.map((n) =>
      n === sourceHole ? `Hole ${n} (current)` : `Hole ${n}`,
    );

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: 'Move this clip to which hole?',
          options: [...labels, 'Cancel'],
          cancelButtonIndex: labels.length,
        },
        (buttonIndex) => {
          if (buttonIndex === labels.length) return;
          const target = targets[buttonIndex];
          if (target == null) return;
          moveClipToHole(sourceHole, clipIndex, target);
        },
      );
      return;
    }

    // Fallback: simple prompt-style alert (Android/web)
    Alert.alert(
      'Move clip',
      `Currently on Hole ${sourceHole}. Pick a target hole:`,
      [
        ...targets.slice(0, Math.min(targets.length, 8)).map((n) => ({
          text: n === sourceHole ? `Hole ${n} (current)` : `Hole ${n}`,
          onPress: () => moveClipToHole(sourceHole, clipIndex, n),
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ],
    );
  };

  const totalClips = holes.reduce((sum, h) => sum + h.clips.length, 0);

  const handleImport = async () => {
    if (totalClips === 0) {
      Alert.alert('No Clips', 'Add at least one video clip to import.');
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      Alert.alert(
        'Sign In Required',
        'You need to sign in to import a round.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Sign In', onPress: () => router.push('/(auth)/login') },
        ]
      );
      return;
    }

    setImporting(true);
    setImportProgress({ done: 0, total: totalClips });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const importStartHole: 1 | 10 = startingNine === 'back' ? 10 : 1;
      const round = await createRound({
        course_name: courseName.trim(),
        course_id: selectedCourseId,
        holes_played: holesCount,
        start_hole: importStartHole,
      });

      const roundId = round.id;

      try {
        await saveLocalRound({
          id: roundId,
          course_name: courseName.trim(),
          course_id: selectedCourseId,
          holes_played: holesCount === 9 ? 9 : 18,
          start_hole: importStartHole,
        });
      } catch {}

      // Read storage policy once for the whole import. Mirror toggle controls
      // whether we push every imported clip to the user's Photos library
      // (off by default — Photos is ~free storage from the user's POV but
      // duplicates the on-disk footprint). Cloud-backup toggle gates the
      // Supabase upload queue at the bottom of this function.
      const mirrorToPhotos = await getMirrorClipsToPhotos();
      const cloudBackupOn = await getCloudBackupEnabled();

      // Per-clip work is independent across holes/shots — parallelize with
      // Promise.all so the slowest clip (not the sum) sets the wall time.
      // Production Supabase RTT + iOS sandbox checks add ~600-800ms per clip
      // serially; in parallel a 12-clip import drops from ~10s to ~2-3s.
      const persistT0 = Date.now();
      const clipTasks: Promise<void>[] = [];
      for (const hole of holes) {
        for (let shotIdx = 0; shotIdx < hole.clips.length; shotIdx++) {
          const clip = hole.clips[shotIdx];
          const shotNumber = shotIdx + 1;
          const holeNumber = hole.holeNumber;

          clipTasks.push((async () => {
            // `resolveAssetUri` alone returns the MediaLibrary localUri which
            // on iOS lives under `Library/Caches/ImagePicker/…` — the system
            // cache, which iOS is free to purge at any time. Under memory
            // pressure or after an OS cleanup the file disappears and the
            // upload queue/editor report "File not found" for that URI.
            //
            // `persistAsset` copies into `documentDirectory/clips/` which is
            // durable (only cleared on app uninstall) so downstream code has
            // a stable path. We still fall back to `resolveAssetUri` if the
            // persist step fails.
            const filename = `imported_${roundId}_h${holeNumber}_s${shotNumber}_${Date.now()}.mp4`;
            const tPersist = Date.now();
            let durableUri: string;
            try {
              durableUri = await persistAsset(clip.uri, filename);
            } catch {
              durableUri = await resolveAssetUri(clip.uri);
            }
            const persistMs = Date.now() - tPersist;

            // Photos mirroring: clip.assetId is set iff the user picked the
            // video from Photos (so it's already there — free recovery hint).
            // If the toggle is on AND we don't already have an assetId (e.g.
            // an in-app recording, or some Android paths), save a fresh copy
            // to the library and capture the new asset id.
            let photosAssetId: string | undefined = clip.assetId;
            if (mirrorToPhotos && !photosAssetId && MediaLibrary && isNative) {
              try {
                const perm = await MediaLibrary.requestPermissionsAsync();
                if (perm.status === 'granted') {
                  const asset = await MediaLibrary.createAssetAsync(durableUri);
                  photosAssetId = asset.id;
                }
              } catch (err) {
                console.warn('[Import] Mirror to Photos failed:', err);
              }
            }

            const tSave = Date.now();
            const clipId = await saveLocalClip({
              round_id: roundId,
              hole_number: holeNumber,
              shot_number: shotNumber,
              file_uri: durableUri,          // resolved file:// path
              original_file_uri: durableUri, // same — original video
              duration_seconds: clip.durationMs ? clip.durationMs / 1000 : undefined,
              auto_trimmed: 0,             // NOT trimmed yet — editor will process lazily
              needs_trim: 1,               // Flag for editor to auto-trim on load
              trim_confidence: undefined,
              impact_time_ms: undefined,
              trim_start_ms: 0,
              trim_end_ms: -1,
              photos_asset_id: photosAssetId ?? null,
            });
            // (saveLocalClip persists photos_asset_id directly; the helper
            //  call below is a no-op when the column is already set, but kept
            //  for symmetry with the record/in-app save flow which mirrors
            //  AFTER the clip row is inserted.)
            if (photosAssetId) {
              void setClipPhotosAssetId(clipId, photosAssetId);
            }

            const saveMs = Date.now() - tSave;

            const tShot = Date.now();
            try {
              await createShot({
                round_id: roundId,
                user_id: user.id,
                hole_number: holeNumber,
                shot_number: shotNumber,
                clip_url: '',
              });
            } catch {}
            console.log(
              `[Import] h${holeNumber}s${shotNumber} persist=${persistMs}ms save=${saveMs}ms shot=${Date.now() - tShot}ms`
            );

            setImportProgress((prev) => ({ ...prev, done: prev.done + 1 }));
          })());
        }
      }
      await Promise.all(clipTasks);
      console.log(
        `[Import] persisted+saved ${clipTasks.length} clips in ${Date.now() - persistT0}ms (move-not-copy)`
      );

      // Save scores per hole — use scorecard scores for quick imports, clip count for manual
      const usesScorecard = importMode === 'quick';
      // Score-save per hole is also independent — parallelize.
      await Promise.all(holes.map(async (hole) => {
        const holeStrokes =
          usesScorecard && scores[hole.holeNumber]
            ? scores[hole.holeNumber]
            : hole.clips.length;
        const holePar =
          usesScorecard && pars[hole.holeNumber]
            ? pars[hole.holeNumber]
            : hole.par;

        if (holeStrokes > 0 || hole.clips.length > 0) {
          try {
            await saveLocalScore({
              round_id: roundId,
              hole_number: hole.holeNumber,
              strokes: holeStrokes,
              putts: 0,
              penalty_strokes: 0,
              is_pickup: false,
              par: holePar,
            });
          } catch {}

          try {
            await saveScoreToSupabase({
              round_id: roundId,
              hole_number: hole.holeNumber,
              strokes: holeStrokes,
              par: holePar,
            });
          } catch {}
        }
      }));

      const holesWithData = holes.filter(
        (h) =>
          h.clips.length > 0 ||
          (usesScorecard && scores[h.holeNumber] && scores[h.holeNumber] > 0)
      );
      const computedTotalStrokes = usesScorecard
        ? Object.values(scores).reduce((sum, s) => sum + (s || 0), 0)
        : holes.reduce((sum, h) => sum + h.clips.length, 0);
      const computedTotalPar = holesWithData.reduce(
        (sum, h) => sum + (usesScorecard ? (pars[h.holeNumber] ?? h.par) : h.par),
        0
      );
      const scoreToPar = computedTotalStrokes - computedTotalPar;

      try {
        await updateRound(roundId, {
          total_score: computedTotalStrokes,
          total_par: computedTotalPar,
          score_to_par: scoreToPar,
          clips_count: totalClips,
          holes_played: holesWithData.length,
          status: 'ready',
        } as any);
      } catch {}

      // Cloud backup is opt-in (Pro tier). When the toggle is off we keep
      // everything local — no Supabase Storage cost, no upload retries.
      // Recovery on reinstall instead leans on photos_asset_id (above).
      if (cloudBackupOn) {
        void enqueueRoundUpload(roundId, courseName.trim(), 'local-only');
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace(`/round/editor?roundId=${roundId}`);
    } catch (err) {
      Alert.alert(
        'Import Failed',
        err instanceof Error ? err.message : 'Something went wrong.'
      );
    } finally {
      setImporting(false);
      setImportProgress({ done: 0, total: 0 });
    }
  };

  // Back navigation per step
  const handleBack = () => {
    switch (step) {
      case 'preset-picker':
        router.back();
        break;
      case 'setup':
        // If presets exist, back returns to the picker so the user can
        // re-choose. Otherwise drop all the way out (no picker exists).
        if (presets.length > 0) {
          setStep('preset-picker');
        } else {
          router.back();
        }
        break;
      case 'mode':
        setStep('setup');
        break;
      case 'scorecard':
        setStep('mode');
        break;
      case 'bulk-import':
        setStep('scorecard');
        break;
      case 'import':
        if (importMode === 'quick') {
          // If coming from bulk import, go back to bulk import
          setBulkVideos([]);
          setStep('bulk-import');
        } else {
          setStep('mode');
        }
        break;
    }
  };

  // ---- STEP 0: Preset Picker (Wave 3 Phase D-redo) ----
  // Shown when the user lands on Import AND has at least one saved
  // preset. Tap a preset → confirm sheet → applyPreset() pre-fills the
  // setup screen and routes to step 'setup' for review. Tap "Set up
  // new round" → step 'setup' (empty form).
  if (step === 'preset-picker') {
    return (
      <>
        <PresetPickerScreen
          presets={presets}
          loading={presetsLoading}
          title="Import a round"
          subtitle="Tap a saved round to reuse its setup, or import from scratch."
          onSelectPreset={(preset) => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setConfirmingPreset(preset);
          }}
          onSetUpNew={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setStep('setup');
          }}
          onBack={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            router.back();
          }}
        />
        <PresetConfirmSheet
          preset={confirmingPreset}
          ctaLabel="Continue"
          onCancel={() => setConfirmingPreset(null)}
          onConfirm={({ startHole: chosenStartHole }) => {
            const target = confirmingPreset;
            setConfirmingPreset(null);
            if (target) {
              applyPreset(target, { startHole: chosenStartHole });
            }
          }}
        />
      </>
    );
  }

  // ---- STEP 1: Setup ----
  if (step === 'setup') {
    return (
      <GradientBackground>
        <View style={{ flex: 1, paddingTop: insets.top }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 12,
              gap: 12,
            }}
          >
            <Pressable onPress={() => router.back()} hitSlop={12}>
              <ArrowLeft size={24} color={theme.colors.textPrimary} />
            </Pressable>
            <Text
              style={{
                color: theme.colors.textPrimary,
                fontWeight: '700',
                fontSize: 18,
                flex: 1,
              }}
            >
              Import Round
            </Text>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            onScrollBeginDrag={() => Keyboard.dismiss()}
          >
            <Text
              style={{
                color: theme.colors.textSecondary,
                fontSize: 14,
                marginBottom: 12,
              }}
            >
              Import videos from your camera roll and assign them to holes.
            </Text>

            <View
              style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 8,
                padding: 12,
                marginBottom: 20,
                backgroundColor: theme.colors.surfaceElevated,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: theme.colors.surfaceBorder,
              }}
            >
              <Info size={16} color={theme.colors.textSecondary} style={{ marginTop: 1 }} />
              <Text
                style={{
                  color: theme.colors.textSecondary,
                  fontSize: 12,
                  flex: 1,
                  lineHeight: 18,
                }}
              >
                Videos stored in iCloud need to be downloaded to your phone
                first. Open the Photos app and tap each clip so it caches
                locally before importing.
              </Text>
            </View>

            <CourseSearch
              value={courseName}
              onChangeText={setCourseName}
              onSelectCourse={handleCourseSelect}
            />

            <Text
              style={{
                color: theme.colors.textPrimary,
                fontWeight: '600',
                fontSize: 15,
                marginTop: 24,
                marginBottom: 12,
              }}
            >
              How many holes?
            </Text>
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              {[3, 6, 9, 12, 15, 18].map((n) => (
                <Pressable
                  key={n}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setHolesCount(n);
                  }}
                  style={{
                    paddingHorizontal: 20,
                    paddingVertical: 10,
                    borderRadius: theme.radius.md,
                    backgroundColor:
                      holesCount === n
                        ? theme.colors.primary
                        : theme.colors.surface,
                    borderWidth: 1,
                    borderColor:
                      holesCount === n
                        ? theme.colors.primary
                        : theme.colors.surfaceBorder,
                  }}
                >
                  <Text
                    style={{
                      color:
                        holesCount === n ? '#fff' : theme.colors.textPrimary,
                      fontWeight: '700',
                      fontSize: 15,
                    }}
                  >
                    {n}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Button
              title="Next"
              onPress={initHoles}
              style={{ marginTop: 32 }}
            />
          </ScrollView>
        </View>
      </GradientBackground>
    );
  }

  // ---- STEP 2: Mode Selection ----
  if (step === 'mode') {
    return (
      <GradientBackground>
        <View style={{ flex: 1, paddingTop: insets.top }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 12,
              gap: 12,
            }}
          >
            <Pressable onPress={handleBack} hitSlop={12}>
              <ArrowLeft size={24} color={theme.colors.textPrimary} />
            </Pressable>
            <Text
              style={{
                color: theme.colors.textPrimary,
                fontWeight: '700',
                fontSize: 18,
                flex: 1,
              }}
            >
              Import Method
            </Text>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
          >
            <Text
              style={{
                color: theme.colors.textSecondary,
                fontSize: 14,
                marginBottom: 24,
              }}
            >
              How would you like to import your round?
            </Text>

            {/* Quick Import — recommended */}
            <Pressable
              onPress={() => handleModeSelect('quick')}
              style={({ pressed }) => ({
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <Card style={{ marginBottom: 16, padding: 20, borderWidth: 1, borderColor: theme.colors.primary }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                  <View
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: 24,
                      backgroundColor: theme.colors.primaryMuted,
                      justifyContent: 'center',
                      alignItems: 'center',
                    }}
                  >
                    <Zap size={24} color={theme.colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <Text
                        style={{
                          color: theme.colors.textPrimary,
                          fontWeight: '700',
                          fontSize: 17,
                        }}
                      >
                        Quick Import
                      </Text>
                      <View style={{
                        backgroundColor: theme.colors.primary,
                        paddingHorizontal: 8,
                        paddingVertical: 2,
                        borderRadius: 8,
                      }}>
                        <Text style={{ color: '#000', fontSize: 10, fontWeight: '700' }}>RECOMMENDED</Text>
                      </View>
                    </View>
                    <Text
                      style={{
                        color: theme.colors.textSecondary,
                        fontSize: 13,
                        lineHeight: 18,
                      }}
                    >
                      Enter your scorecard, then select all videos at once. We'll
                      auto-assign them to each hole.
                    </Text>
                  </View>
                  <ChevronDown
                    size={20}
                    color={theme.colors.textTertiary}
                    style={{ transform: [{ rotate: '-90deg' }] }}
                  />
                </View>
              </Card>
            </Pressable>

            {/* Manual Import */}
            <Pressable
              onPress={() => handleModeSelect('manual')}
              style={({ pressed }) => ({
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <Card style={{ marginBottom: 16, padding: 20 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                  <View
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: 24,
                      backgroundColor: theme.colors.primaryMuted,
                      justifyContent: 'center',
                      alignItems: 'center',
                    }}
                  >
                    <List size={24} color={theme.colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{
                        color: theme.colors.textPrimary,
                        fontWeight: '700',
                        fontSize: 17,
                        marginBottom: 4,
                      }}
                    >
                      Manual Import
                    </Text>
                    <Text
                      style={{
                        color: theme.colors.textSecondary,
                        fontSize: 13,
                        lineHeight: 18,
                      }}
                    >
                      Add videos to each hole individually. Best when you want full
                      control over clip assignment.
                    </Text>
                  </View>
                  <ChevronDown
                    size={20}
                    color={theme.colors.textTertiary}
                    style={{ transform: [{ rotate: '-90deg' }] }}
                  />
                </View>
              </Card>
            </Pressable>
          </ScrollView>
        </View>
      </GradientBackground>
    );
  }

  if (step === 'scorecard') {
    const ordered = getOrderedHoleNumbers();
    const showBothNines = holesCount > 9;

    // Split into front/back sections based on ordering
    const firstNine = ordered.slice(0, 9);
    const secondNine = showBothNines ? ordered.slice(9, 18) : [];

    const sumScores = (holeNums: number[]) =>
      holeNums.reduce((sum, h) => sum + (scores[h] || 0), 0);
    const sumPars = (holeNums: number[]) =>
      holeNums.reduce((sum, h) => sum + (pars[h] ?? 4), 0);

    const outTotal = sumScores(firstNine);
    const outPar = sumPars(firstNine);
    const inTotal = showBothNines ? sumScores(secondNine) : 0;
    const inPar = showBothNines ? sumPars(secondNine) : 0;
    const grandTotal = outTotal + inTotal;
    const grandPar = outPar + inPar;

    const renderScorecardSection = (holeNums: number[], label: string) => {
      const sectionTotal = sumScores(holeNums);
      const sectionPar = sumPars(holeNums);

      return (
        <View style={{ marginBottom: 16 }}>
          {/* Scorecard grid */}
          <View
            style={{
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: theme.colors.surfaceBorder,
              overflow: 'hidden',
            }}
          >
            {/* Hole number row */}
            <View
              style={{
                flexDirection: 'row',
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.surfaceBorder,
              }}
            >
              <View
                style={{
                  width: 40,
                  paddingVertical: 8,
                  justifyContent: 'center',
                  alignItems: 'center',
                  borderRightWidth: 1,
                  borderRightColor: theme.colors.surfaceBorder,
                  backgroundColor: theme.colors.surfaceElevated,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.textTertiary,
                    fontSize: 10,
                    fontWeight: '700',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  Hole
                </Text>
              </View>
              {holeNums.map((holeNum) => (
                <View
                  key={`hole-${holeNum}`}
                  style={{
                    flex: 1,
                    paddingVertical: 8,
                    justifyContent: 'center',
                    alignItems: 'center',
                    borderRightWidth: 1,
                    borderRightColor: theme.colors.surfaceBorder,
                  }}
                >
                  <Text
                    style={{
                      color: theme.colors.textSecondary,
                      fontSize: 11,
                      fontWeight: '600',
                    }}
                  >
                    {holeNum}
                  </Text>
                </View>
              ))}
              {/* Total column */}
              <View
                style={{
                  width: 44,
                  paddingVertical: 8,
                  justifyContent: 'center',
                  alignItems: 'center',
                  backgroundColor: theme.colors.surfaceElevated,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.textTertiary,
                    fontSize: 10,
                    fontWeight: '700',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  {label}
                </Text>
              </View>
            </View>

            {/* Par row */}
            <View
              style={{
                flexDirection: 'row',
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.surfaceBorder,
              }}
            >
              <View
                style={{
                  width: 40,
                  paddingVertical: 8,
                  justifyContent: 'center',
                  alignItems: 'center',
                  borderRightWidth: 1,
                  borderRightColor: theme.colors.surfaceBorder,
                  backgroundColor: theme.colors.surfaceElevated,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.textTertiary,
                    fontSize: 10,
                    fontWeight: '700',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  Par
                </Text>
              </View>
              {holeNums.map((holeNum) => (
                <Pressable
                  key={`par-${holeNum}`}
                  onPress={() => cyclePar(holeNum)}
                  style={{
                    flex: 1,
                    paddingVertical: 8,
                    justifyContent: 'center',
                    alignItems: 'center',
                    borderRightWidth: 1,
                    borderRightColor: theme.colors.surfaceBorder,
                  }}
                >
                  <Text
                    style={{
                      color: theme.colors.textTertiary,
                      fontSize: 13,
                      fontWeight: '500',
                    }}
                  >
                    {pars[holeNum] ?? 4}
                  </Text>
                </Pressable>
              ))}
              <View
                style={{
                  width: 44,
                  paddingVertical: 8,
                  justifyContent: 'center',
                  alignItems: 'center',
                  backgroundColor: theme.colors.surfaceElevated,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.textTertiary,
                    fontSize: 13,
                    fontWeight: '600',
                  }}
                >
                  {sectionPar}
                </Text>
              </View>
            </View>

            {/* Score row */}
            <View style={{ flexDirection: 'row' }}>
              <View
                style={{
                  width: 40,
                  paddingVertical: 10,
                  justifyContent: 'center',
                  alignItems: 'center',
                  borderRightWidth: 1,
                  borderRightColor: theme.colors.surfaceBorder,
                  backgroundColor: theme.colors.surfaceElevated,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.textTertiary,
                    fontSize: 10,
                    fontWeight: '700',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  Score
                </Text>
              </View>
              {holeNums.map((holeNum) => {
                const isSelected = selectedScoreCell === holeNum;
                const hasScore = scores[holeNum] !== undefined && scores[holeNum] > 0;

                return (
                  <Pressable
                    key={`score-${holeNum}`}
                    onPress={() => {
                      Haptics.selectionAsync();
                      setSelectedScoreCell(isSelected ? null : holeNum);
                    }}
                    style={{
                      flex: 1,
                      paddingVertical: 10,
                      justifyContent: 'center',
                      alignItems: 'center',
                      borderRightWidth: 1,
                      borderRightColor: theme.colors.surfaceBorder,
                      backgroundColor: isSelected
                        ? 'rgba(76, 175, 80, 0.12)'
                        : 'transparent',
                      borderBottomWidth: isSelected ? 2 : 0,
                      borderBottomColor: theme.colors.primary,
                    }}
                  >
                    <Text
                      style={{
                        color: hasScore
                          ? getScoreColor(holeNum)
                          : theme.colors.textTertiary,
                        fontSize: 16,
                        fontWeight: '700',
                      }}
                    >
                      {hasScore ? scores[holeNum] : '-'}
                    </Text>
                  </Pressable>
                );
              })}
              {/* Section total */}
              <View
                style={{
                  width: 44,
                  paddingVertical: 10,
                  justifyContent: 'center',
                  alignItems: 'center',
                  backgroundColor: theme.colors.surfaceElevated,
                }}
              >
                <Text
                  style={{
                    color: sectionTotal > 0 ? theme.colors.textPrimary : theme.colors.textTertiary,
                    fontSize: 15,
                    fontWeight: '800',
                  }}
                >
                  {sectionTotal > 0 ? sectionTotal : '-'}
                </Text>
              </View>
            </View>
          </View>
        </View>
      );
    };

    return (
      <GradientBackground>
        <View style={{ flex: 1, paddingTop: insets.top }}>
          {/* Header */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 12,
              gap: 12,
            }}
          >
            <Pressable onPress={handleBack} hitSlop={12}>
              <ArrowLeft size={24} color={theme.colors.textPrimary} />
            </Pressable>
            <Text
              style={{
                color: theme.colors.textPrimary,
                fontWeight: '700',
                fontSize: 18,
                flex: 1,
              }}
            >
              Scorecard
            </Text>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>
              {courseName}
            </Text>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{
              padding: 16,
              paddingBottom: selectedScoreCell !== null ? 180 : 120,
            }}
          >
            {/* Starting Nine Toggle */}
            <View style={{ marginBottom: 20 }}>
              <Text
                style={{
                  color: theme.colors.textSecondary,
                  fontSize: 12,
                  fontWeight: '600',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  marginBottom: 8,
                }}
              >
                Starting Nine
              </Text>
              <View
                style={{
                  flexDirection: 'row',
                  backgroundColor: theme.colors.surface,
                  borderRadius: theme.radius.md,
                  borderWidth: 1,
                  borderColor: theme.colors.surfaceBorder,
                  overflow: 'hidden',
                }}
              >
                <Pressable
                  onPress={() => {
                    Haptics.selectionAsync();
                    setStartingNine('front');
                    // Re-init pars when switching
                    const newOrdered =
                      holesCount <= 9
                        ? Array.from({ length: holesCount }, (_, i) => i + 1)
                        : Array.from({ length: 18 }, (_, i) => i + 1);
                    const newPars: Record<number, number> = {};
                    for (const h of newOrdered) {
                      const courseHole = courseHoles.find((ch) => ch.holeNumber === h);
                      newPars[h] = pars[h] ?? courseHole?.par ?? 4;
                    }
                    setPars(newPars);
                  }}
                  style={{
                    flex: 1,
                    paddingVertical: 10,
                    alignItems: 'center',
                    backgroundColor:
                      startingNine === 'front'
                        ? theme.colors.primary
                        : 'transparent',
                    borderRadius: startingNine === 'front' ? theme.radius.sm : 0,
                  }}
                >
                  <Text
                    style={{
                      color:
                        startingNine === 'front'
                          ? '#fff'
                          : theme.colors.textSecondary,
                      fontWeight: '600',
                      fontSize: 14,
                    }}
                  >
                    Front 9
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    Haptics.selectionAsync();
                    setStartingNine('back');
                    const newOrdered =
                      holesCount <= 9
                        ? Array.from({ length: holesCount }, (_, i) => i + 10)
                        : [
                            ...Array.from({ length: 9 }, (_, i) => i + 10),
                            ...Array.from({ length: 9 }, (_, i) => i + 1),
                          ];
                    const newPars: Record<number, number> = {};
                    for (const h of newOrdered) {
                      const courseHole = courseHoles.find((ch) => ch.holeNumber === h);
                      newPars[h] = pars[h] ?? courseHole?.par ?? 4;
                    }
                    setPars(newPars);
                  }}
                  style={{
                    flex: 1,
                    paddingVertical: 10,
                    alignItems: 'center',
                    backgroundColor:
                      startingNine === 'back'
                        ? theme.colors.primary
                        : 'transparent',
                    borderRadius: startingNine === 'back' ? theme.radius.sm : 0,
                  }}
                >
                  <Text
                    style={{
                      color:
                        startingNine === 'back'
                          ? '#fff'
                          : theme.colors.textSecondary,
                      fontWeight: '600',
                      fontSize: 14,
                    }}
                  >
                    Back 9
                  </Text>
                </Pressable>
              </View>
            </View>

            {/* Scorecard sections */}
            {renderScorecardSection(
              firstNine,
              startingNine === 'front' || !showBothNines ? 'OUT' : 'IN'
            )}
            {showBothNines &&
              renderScorecardSection(
                secondNine,
                startingNine === 'front' ? 'IN' : 'OUT'
              )}

            {/* Grand total for 18 holes */}
            {showBothNines && (
              <Card
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-around',
                  alignItems: 'center',
                  paddingVertical: 14,
                  paddingHorizontal: 16,
                  marginBottom: 16,
                }}
              >
                <View style={{ alignItems: 'center' }}>
                  <Text
                    style={{
                      color: theme.colors.textTertiary,
                      fontSize: 10,
                      fontWeight: '700',
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                      marginBottom: 2,
                    }}
                  >
                    {startingNine === 'front' ? 'OUT' : 'IN'}
                  </Text>
                  <Text
                    style={{
                      color: outTotal > 0 ? theme.colors.textPrimary : theme.colors.textTertiary,
                      fontSize: 18,
                      fontWeight: '800',
                    }}
                  >
                    {outTotal > 0 ? outTotal : '-'}
                  </Text>
                  <Text
                    style={{
                      color: theme.colors.textTertiary,
                      fontSize: 11,
                    }}
                  >
                    par {outPar}
                  </Text>
                </View>
                <View
                  style={{
                    width: 1,
                    height: 32,
                    backgroundColor: theme.colors.surfaceBorder,
                  }}
                />
                <View style={{ alignItems: 'center' }}>
                  <Text
                    style={{
                      color: theme.colors.textTertiary,
                      fontSize: 10,
                      fontWeight: '700',
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                      marginBottom: 2,
                    }}
                  >
                    {startingNine === 'front' ? 'IN' : 'OUT'}
                  </Text>
                  <Text
                    style={{
                      color: inTotal > 0 ? theme.colors.textPrimary : theme.colors.textTertiary,
                      fontSize: 18,
                      fontWeight: '800',
                    }}
                  >
                    {inTotal > 0 ? inTotal : '-'}
                  </Text>
                  <Text
                    style={{
                      color: theme.colors.textTertiary,
                      fontSize: 11,
                    }}
                  >
                    par {inPar}
                  </Text>
                </View>
                <View
                  style={{
                    width: 1,
                    height: 32,
                    backgroundColor: theme.colors.surfaceBorder,
                  }}
                />
                <View style={{ alignItems: 'center' }}>
                  <Text
                    style={{
                      color: theme.colors.textTertiary,
                      fontSize: 10,
                      fontWeight: '700',
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                      marginBottom: 2,
                    }}
                  >
                    Total
                  </Text>
                  <Text
                    style={{
                      color: grandTotal > 0 ? theme.colors.primary : theme.colors.textTertiary,
                      fontSize: 22,
                      fontWeight: '900',
                    }}
                  >
                    {grandTotal > 0 ? grandTotal : '-'}
                  </Text>
                  <Text
                    style={{
                      color: theme.colors.textTertiary,
                      fontSize: 11,
                    }}
                  >
                    par {grandPar}
                  </Text>
                </View>
              </Card>
            )}

            {/* Single nine total */}
            {!showBothNines && (
              <Card
                style={{
                  flexDirection: 'row',
                  justifyContent: 'center',
                  alignItems: 'center',
                  paddingVertical: 14,
                  paddingHorizontal: 16,
                  marginBottom: 16,
                  gap: 16,
                }}
              >
                <View style={{ alignItems: 'center' }}>
                  <Text
                    style={{
                      color: theme.colors.textTertiary,
                      fontSize: 10,
                      fontWeight: '700',
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                      marginBottom: 2,
                    }}
                  >
                    Total
                  </Text>
                  <Text
                    style={{
                      color: outTotal > 0 ? theme.colors.primary : theme.colors.textTertiary,
                      fontSize: 22,
                      fontWeight: '900',
                    }}
                  >
                    {outTotal > 0 ? outTotal : '-'}
                  </Text>
                  <Text
                    style={{
                      color: theme.colors.textTertiary,
                      fontSize: 11,
                    }}
                  >
                    par {outPar}
                  </Text>
                </View>
              </Card>
            )}

            {/* Tap instruction */}
            <Text
              style={{
                color: theme.colors.textTertiary,
                fontSize: 12,
                textAlign: 'center',
                marginBottom: 8,
              }}
            >
              Tap a score cell, then use the number pad below. Tap par to cycle 3/4/5.
            </Text>
          </ScrollView>

          {/* Number pad + Next button */}
          <View
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              backgroundColor: theme.colors.background,
              borderTopWidth: 1,
              borderTopColor: theme.colors.surfaceBorder,
              paddingBottom: insets.bottom + 8,
            }}
          >
            {/* Number pad — always visible for fast entry */}
            {selectedScoreCell !== null && (
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'center',
                  gap: 4,
                  paddingHorizontal: 12,
                  paddingTop: 10,
                  paddingBottom: 6,
                }}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => {
                  const isCurrentScore = scores[selectedScoreCell] === n;
                  return (
                    <Pressable
                      key={n}
                      onPress={() => setScoreForHole(selectedScoreCell, n)}
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 18,
                        justifyContent: 'center',
                        alignItems: 'center',
                        backgroundColor: isCurrentScore
                          ? theme.colors.primary
                          : theme.colors.surfaceElevated,
                        borderWidth: 1,
                        borderColor: isCurrentScore
                          ? theme.colors.primary
                          : theme.colors.surfaceBorder,
                      }}
                    >
                      <Text
                        style={{
                          color: isCurrentScore ? '#fff' : theme.colors.textPrimary,
                          fontSize: 16,
                          fontWeight: '700',
                        }}
                      >
                        {n}
                      </Text>
                    </Pressable>
                  );
                })}
                {/* Clear button */}
                <Pressable
                  onPress={() => {
                    Haptics.selectionAsync();
                    if (selectedScoreCell !== null) {
                      setScores((prev) => {
                        const next = { ...prev };
                        delete next[selectedScoreCell];
                        return next;
                      });
                    }
                  }}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    justifyContent: 'center',
                    alignItems: 'center',
                    backgroundColor: theme.colors.surfaceElevated,
                    borderWidth: 1,
                    borderColor: theme.colors.surfaceBorder,
                  }}
                >
                  <X size={16} color={theme.colors.textTertiary} />
                </Pressable>
              </View>
            )}

            <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
              <Button
                title="Next — Import Videos"
                onPress={() => {
                  setBulkVideos([]);
                  setStep('bulk-import');
                }}
              />
            </View>
          </View>
        </View>
      </GradientBackground>
    );
  }

  // ---- STEP 4: Bulk Import ----
  if (step === 'bulk-import') {
    const hasMismatch = bulkVideos.length > 0 && bulkVideos.length !== totalStrokes;

    return (
      <GradientBackground>
        <View style={{ flex: 1, paddingTop: insets.top }}>
          {/* Header */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 12,
              gap: 12,
            }}
          >
            <Pressable onPress={handleBack} hitSlop={12}>
              <ArrowLeft size={24} color={theme.colors.textPrimary} />
            </Pressable>
            <Text
              style={{
                color: theme.colors.textPrimary,
                fontWeight: '700',
                fontSize: 18,
                flex: 1,
              }}
            >
              Select Videos
            </Text>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
          >
            {/* Summary */}
            <Card style={{ marginBottom: 20, padding: 20 }}>
              <View style={{ alignItems: 'center' }}>
                <Text
                  style={{
                    color: theme.colors.textPrimary,
                    fontSize: 36,
                    fontWeight: '900',
                    marginBottom: 4,
                  }}
                >
                  {totalStrokes}
                </Text>
                <Text
                  style={{
                    color: theme.colors.textSecondary,
                    fontSize: 14,
                  }}
                >
                  total strokes — import {totalStrokes} videos in order
                </Text>
              </View>
            </Card>

            {/* Select Videos Button */}
            <Pressable
              onPress={pickBulkVideos}
              style={({ pressed }) => ({
                backgroundColor: theme.colors.surfaceElevated,
                borderRadius: theme.radius.lg,
                borderWidth: 2,
                borderColor: theme.colors.surfaceBorder,
                borderStyle: 'dashed',
                paddingVertical: 40,
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 20,
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <ImagePlus size={40} color={theme.colors.primary} />
              <Text
                style={{
                  color: theme.colors.primary,
                  fontWeight: '700',
                  fontSize: 17,
                  marginTop: 12,
                }}
              >
                {bulkVideos.length > 0 ? 'Re-select Videos' : 'Select All Videos'}
              </Text>
              <Text
                style={{
                  color: theme.colors.textTertiary,
                  fontSize: 13,
                  marginTop: 4,
                }}
              >
                Choose videos in the order they were filmed
              </Text>
            </Pressable>

            {/* Video count comparison */}
            {bulkVideos.length > 0 && (
              <Card style={{ marginBottom: 16, padding: 16 }}>
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: hasMismatch ? 12 : 0,
                  }}
                >
                  <View style={{ alignItems: 'center', flex: 1 }}>
                    <Text
                      style={{
                        color: theme.colors.textPrimary,
                        fontSize: 24,
                        fontWeight: '800',
                      }}
                    >
                      {bulkVideos.length}
                    </Text>
                    <Text
                      style={{
                        color: theme.colors.textSecondary,
                        fontSize: 12,
                      }}
                    >
                      selected
                    </Text>
                  </View>
                  <Text
                    style={{
                      color: theme.colors.textTertiary,
                      fontSize: 16,
                      fontWeight: '600',
                    }}
                  >
                    /
                  </Text>
                  <View style={{ alignItems: 'center', flex: 1 }}>
                    <Text
                      style={{
                        color: theme.colors.textPrimary,
                        fontSize: 24,
                        fontWeight: '800',
                      }}
                    >
                      {totalStrokes}
                    </Text>
                    <Text
                      style={{
                        color: theme.colors.textSecondary,
                        fontSize: 12,
                      }}
                    >
                      expected
                    </Text>
                  </View>
                </View>

                {hasMismatch && (
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'flex-start',
                      gap: 8,
                      backgroundColor: 'rgba(255, 152, 0, 0.1)',
                      borderRadius: theme.radius.sm,
                      padding: 12,
                      borderWidth: 1,
                      borderColor: 'rgba(255, 152, 0, 0.25)',
                    }}
                  >
                    <AlertTriangle size={16} color={theme.colors.processing} style={{ marginTop: 1 }} />
                    <Text
                      style={{
                        color: theme.colors.processing,
                        fontSize: 12,
                        lineHeight: 17,
                        flex: 1,
                      }}
                    >
                      Video count doesn't match total strokes. Scorecard overlay
                      may be inaccurate for some holes.
                    </Text>
                  </View>
                )}
              </Card>
            )}
          </ScrollView>

          {/* Bottom bar */}
          <View
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              paddingHorizontal: 16,
              paddingTop: 12,
              paddingBottom: insets.bottom + 12,
              backgroundColor: theme.colors.background,
              borderTopWidth: 1,
              borderTopColor: theme.colors.surfaceBorder,
            }}
          >
            <Button
              title={bulkProcessing ? 'Processing...' : 'Import'}
              onPress={handleBulkImport}
              disabled={bulkVideos.length === 0 || bulkProcessing}
              loading={bulkProcessing}
            />
          </View>
        </View>
      </GradientBackground>
    );
  }

  // ---- STEP 5: Import clips per hole (manual or review after quick) ----
  return (
    <GradientBackground>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingVertical: 12,
          }}
        >
          <Pressable onPress={handleBack} hitSlop={12}>
            <ArrowLeft size={24} color={theme.colors.textPrimary} />
          </Pressable>
          <Text
            style={{
              color: theme.colors.textPrimary,
              fontWeight: '700',
              fontSize: 18,
            }}
          >
            {importMode === 'quick' ? 'Review Clips' : 'Add Clips'}
          </Text>
          <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>
            {totalClips} clip{totalClips !== 1 ? 's' : ''}
          </Text>
        </View>

        <ScrollView
          ref={reviewScrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
        >
          {sanityWarning && sanityWarning.oversizedHoles.length > 0 && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 8,
                padding: 10,
                marginBottom: 12,
                borderRadius: 10,
                backgroundColor: 'rgba(255, 176, 0, 0.12)',
                borderWidth: 1,
                borderColor: 'rgba(255, 176, 0, 0.35)',
              }}
            >
              <Info size={14} color="#FFB000" style={{ marginTop: 2 }} />
              <Text
                style={{
                  color: theme.colors.textPrimary,
                  fontSize: 12,
                  flex: 1,
                  lineHeight: 17,
                }}
              >
                We detected {sanityWarning.oversizedHoles.length} hole
                {sanityWarning.oversizedHoles.length === 1 ? '' : 's'} with more
                than 8 clips (hole{sanityWarning.oversizedHoles.length === 1 ? '' : 's'}{' '}
                {sanityWarning.oversizedHoles.join(', ')}). Double-check grouping —
                you can long-press a clip to move it to a different hole.
              </Text>
            </View>
          )}
          {holes.map((hole) => (
            <View
              key={hole.holeNumber}
              onLayout={(e) => {
                holeOffsetsRef.current[hole.holeNumber] = e.nativeEvent.layout.y;
              }}
            >
            <Card
              style={{ marginBottom: 12, padding: 0, overflow: 'hidden' }}
            >
              {/* Hole header */}
              <Pressable
                onPress={() => toggleExpanded(hole.holeNumber)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: 14,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 16,
                      backgroundColor: hole.clips.length > 0
                        ? theme.colors.primary
                        : theme.colors.surface,
                      borderWidth: hole.clips.length > 0 ? 0 : 1,
                      borderColor: theme.colors.surfaceBorder,
                      justifyContent: 'center',
                      alignItems: 'center',
                    }}
                  >
                    <Text
                      style={{
                        color: hole.clips.length > 0
                          ? '#fff'
                          : theme.colors.textSecondary,
                        fontWeight: '700',
                        fontSize: 14,
                      }}
                    >
                      {hole.holeNumber}
                    </Text>
                  </View>
                  <View>
                    <Text
                      style={{
                        color: theme.colors.textPrimary,
                        fontWeight: '600',
                        fontSize: 15,
                      }}
                    >
                      Hole {hole.holeNumber}
                    </Text>
                    <Text
                      style={{
                        color: theme.colors.textTertiary,
                        fontSize: 12,
                      }}
                    >
                      Par {hole.par} · {hole.clips.length} clip
                      {hole.clips.length !== 1 ? 's' : ''}
                      {importMode === 'quick' && scores[hole.holeNumber]
                        ? ` · Score: ${scores[hole.holeNumber]}`
                        : ''}
                    </Text>
                  </View>
                </View>
                {hole.expanded ? (
                  <ChevronUp size={20} color={theme.colors.textTertiary} />
                ) : (
                  <ChevronDown size={20} color={theme.colors.textTertiary} />
                )}
              </Pressable>

              {/* Expanded clip list */}
              {hole.expanded && (
                <View
                  style={{
                    borderTopWidth: 1,
                    borderTopColor: theme.colors.surfaceBorder,
                    padding: 12,
                  }}
                >
                  {/* Clip placeholders */}
                  {hole.clips.length > 0 && (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={{ marginBottom: 12 }}
                    >
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        {hole.clips.map((clip, idx) => (
                          <Pressable
                            key={`${hole.holeNumber}-${idx}`}
                            onLongPress={() => promptMoveClip(hole.holeNumber, idx)}
                            delayLongPress={350}
                            style={{
                              width: 80,
                              height: 80,
                              borderRadius: theme.radius.md,
                              overflow: 'hidden',
                              backgroundColor: theme.colors.surface,
                            }}
                          >
                            {clip.thumbnailUri ? (
                              <Image
                                source={{ uri: clip.thumbnailUri }}
                                style={{ width: '100%', height: '100%', borderRadius: 8 }}
                                resizeMode="cover"
                              />
                            ) : (
                              <View
                                style={{
                                  flex: 1,
                                  justifyContent: 'center',
                                  alignItems: 'center',
                                }}
                              >
                                <Film
                                  size={20}
                                  color={theme.colors.textTertiary}
                                />
                                <Text
                                  style={{
                                    color: theme.colors.textTertiary,
                                    fontSize: 10,
                                    marginTop: 2,
                                  }}
                                >
                                  Shot {idx + 1}
                                </Text>
                              </View>
                            )}
                            {/* Hole number badge */}
                            <View
                              pointerEvents="none"
                              style={{
                                position: 'absolute',
                                bottom: 2,
                                left: 2,
                                backgroundColor: 'rgba(0,0,0,0.65)',
                                borderRadius: 6,
                                paddingHorizontal: 5,
                                paddingVertical: 1,
                              }}
                            >
                              <Text
                                style={{
                                  color: '#fff',
                                  fontSize: 10,
                                  fontWeight: '700',
                                }}
                              >
                                hole {hole.holeNumber}
                              </Text>
                            </View>
                            {/* Remove button */}
                            <Pressable
                              onPress={() => removeClip(hole.holeNumber, idx)}
                              style={{
                                position: 'absolute',
                                top: 2,
                                right: 2,
                                backgroundColor: 'rgba(0,0,0,0.6)',
                                borderRadius: 10,
                                width: 20,
                                height: 20,
                                justifyContent: 'center',
                                alignItems: 'center',
                              }}
                              hitSlop={8}
                            >
                              <X size={12} color="#fff" />
                            </Pressable>
                          </Pressable>
                        ))}
                      </View>
                    </ScrollView>
                  )}

                  {/* Add clips button */}
                  <Pressable
                    onPress={() => pickClipsForHole(hole.holeNumber)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                      paddingVertical: 10,
                      borderRadius: theme.radius.md,
                      borderWidth: 1,
                      borderColor: theme.colors.surfaceBorder,
                      borderStyle: 'dashed',
                    }}
                  >
                    <Plus size={16} color={theme.colors.primary} />
                    <Text
                      style={{
                        color: theme.colors.primary,
                        fontWeight: '600',
                        fontSize: 14,
                      }}
                    >
                      Add Videos
                    </Text>
                  </Pressable>
                </View>
              )}
            </Card>
            </View>
          ))}
        </ScrollView>

        {/* Bottom bar */}
        <View
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: insets.bottom + 12,
            backgroundColor: theme.colors.background,
            borderTopWidth: 1,
            borderTopColor: theme.colors.surfaceBorder,
          }}
        >
          <Button
            title={
              importing
                ? importProgress.total > 0
                  ? `Importing ${importProgress.done} of ${importProgress.total} clip${importProgress.total !== 1 ? 's' : ''}…`
                  : 'Importing…'
                : `Import ${totalClips} Clip${totalClips !== 1 ? 's' : ''}`
            }
            onPress={handleImport}
            disabled={totalClips === 0 || importing}
          />
        </View>
      </View>
    </GradientBackground>
  );
}
