import { useState, useCallback, useRef } from 'react';
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
  Sparkles,
  Info,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { CourseSearch } from '@/components/record/CourseSearch';
import { createRound, createShot, updateRound, saveScoreToSupabase } from '@/lib/api';
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

type ImportStep = 'setup' | 'mode' | 'scorecard' | 'bulk-import' | 'auto-processing' | 'import';

export default function ImportRoundScreen() {
  const insets = useSafeAreaInsets();
  const [courseName, setCourseName] = useState('');
  const [selectedCourseId, setSelectedCourseId] = useState<string | undefined>();
  const [courseHoles, setCourseHoles] = useState<HoleData[]>([]);
  const [holesCount, setHolesCount] = useState(18);
  const [holes, setHoles] = useState<HoleImport[]>([]);
  const [step, setStep] = useState<ImportStep>('setup');
  const [importing, setImporting] = useState(false);

  // Quick Import state
  const [importMode, setImportMode] = useState<'quick' | 'manual' | 'auto' | null>(null);
  // Auto-detect classification progress
  const [autoProgress, setAutoProgress] = useState<{ current: number; total: number; phase: string }>({
    current: 0,
    total: 0,
    phase: '',
  });
  const [startingNine, setStartingNine] = useState<'front' | 'back'>('front');
  const [scores, setScores] = useState<Record<number, number>>({});
  const [pars, setPars] = useState<Record<number, number>>({});
  const [selectedScoreCell, setSelectedScoreCell] = useState<number | null>(null);
  const [bulkVideos, setBulkVideos] = useState<{ uri: string; duration?: number; assetId?: string }[]>([]);
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const [sanityWarning, setSanityWarning] = useState<{ oversizedHoles: number[] } | null>(null);

  const handleCourseSelect = (course: { id: string; name: string }, holeData: HoleData[]) => {
    setSelectedCourseId(course.id);
    if (holeData.length > 0) {
      setCourseHoles(holeData);
    }
  };

  // Get ordered hole numbers based on starting nine and hole count
  const getOrderedHoleNumbers = useCallback((): number[] => {
    if (holesCount <= 9) {
      if (startingNine === 'front') {
        return Array.from({ length: holesCount }, (_, i) => i + 1);
      } else {
        return Array.from({ length: holesCount }, (_, i) => i + 10);
      }
    }
    // 18 holes
    if (startingNine === 'front') {
      return Array.from({ length: 18 }, (_, i) => i + 1);
    }
    // Started on back nine: 10-18, then 1-9
    return [
      ...Array.from({ length: 9 }, (_, i) => i + 10),
      ...Array.from({ length: 9 }, (_, i) => i + 1),
    ];
  }, [holesCount, startingNine]);

  const initHoles = useCallback(() => {
    if (!courseName.trim()) {
      Alert.alert('Course Name', 'Please enter or select a course.');
      return;
    }

    const holeList: HoleImport[] = [];
    for (let i = 1; i <= holesCount; i++) {
      const courseHole = courseHoles.find((h) => h.holeNumber === i);
      holeList.push({
        holeNumber: i,
        par: courseHole?.par ?? 4,
        clips: [],
        expanded: true,
      });
    }
    setHoles(holeList);
    setStep('mode');
  }, [courseName, holesCount, courseHoles]);

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

  const handleModeSelect = (mode: 'quick' | 'manual' | 'auto') => {
    setImportMode(mode);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (mode === 'manual') {
      setStep('import');
    } else if (mode === 'auto') {
      // Auto-detect: pick all videos at once, then classify each to find hole boundaries
      handleAutoDetectPick();
    } else {
      initScorecard();
    }
  };

  // Auto-detect: let user pick all clips, classify each, group by putt→swing transitions
  const handleAutoDetectPick = async () => {
    if (!ImagePicker) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsMultipleSelection: true,
      quality: 1,
      orderedSelection: true,
    });

    if (result.canceled || !result.assets?.length) return;

    const videos = result.assets.map((a) => ({
      uri: a.uri,
      duration: a.duration ?? undefined,
      assetId: a.assetId ?? undefined,
    }));

    await runAutoDetect(videos);
  };

  // Classify every clip, then group them into holes.
  // PRIMARY strategy: timestamp gaps from MediaLibrary creationTime (> 3min = new hole).
  // SECONDARY: pose-based putt→swing transitions (used for ambiguous 2-3min gaps, or as
  // a full fallback if no clips have creationTime / permission denied).
  const runAutoDetect = async (
    videos: { uri: string; duration?: number; assetId?: string }[]
  ) => {
    setStep('auto-processing');
    setAutoProgress({ current: 0, total: videos.length, phase: 'Reading metadata...' });

    // Step 0: Try to fetch creationTime for each clip via MediaLibrary.
    // Request permission lazily the first time we hit a clip that has an assetId.
    let permissionChecked = false;
    let permissionGranted = false;

    type WithMeta = {
      uri: string;
      duration?: number;
      assetId?: string;
      creationTime?: number;
      pickerIndex: number;
    };
    const withMeta: WithMeta[] = [];

    for (let i = 0; i < videos.length; i++) {
      const v = videos[i];
      let creationTime: number | undefined;

      if (MediaLibrary && v.assetId) {
        if (!permissionChecked) {
          try {
            const current = await MediaLibrary.getPermissionsAsync();
            permissionGranted = current.granted;
            if (!permissionGranted && current.canAskAgain) {
              const req = await MediaLibrary.requestPermissionsAsync();
              permissionGranted = req.granted;
            }
          } catch (err) {
            console.log('[AutoDetect] MediaLibrary permission check failed:', err);
          }
          permissionChecked = true;
        }

        if (permissionGranted) {
          try {
            const info = await MediaLibrary.getAssetInfoAsync(v.assetId);
            if (info?.creationTime) {
              creationTime = info.creationTime;
            }
          } catch (err) {
            console.log('[AutoDetect] getAssetInfoAsync failed for', v.assetId, err);
          }
        }
      }

      withMeta.push({
        uri: v.uri,
        duration: v.duration,
        assetId: v.assetId,
        creationTime,
        pickerIndex: i,
      });
    }

    const anyHasCreationTime = withMeta.some((m) => m.creationTime !== undefined);
    const anyAssetIds = videos.some((v) => v.assetId);

    // If clips had assetIds but permission was denied, warn the user and bail to mode.
    if (anyAssetIds && permissionChecked && !permissionGranted) {
      Alert.alert(
        'Photos access needed',
        'Auto-detect needs Photos access to group clips by time. Please allow access in Settings, or use Manual import.'
      );
      setStep('mode');
      return;
    }

    // Step 1: classify each clip (pose-based).
    type Classified = WithMeta & {
      shotType: ShotTypeClassification;
      confidence: number;
    };
    const classified: Classified[] = [];

    for (let i = 0; i < withMeta.length; i++) {
      const v = withMeta[i];
      setAutoProgress({
        current: i + 1,
        total: withMeta.length,
        phase: `Analysing shot ${i + 1} of ${withMeta.length}...`,
      });
      try {
        const r = await detectSwing(v.uri);
        classified.push({
          ...v,
          shotType: r.found ? r.shotType : 'swing',
          confidence: r.confidence,
        });
      } catch (err) {
        console.log('[AutoDetect] detectSwing failed, defaulting to swing:', err);
        classified.push({ ...v, shotType: 'swing', confidence: 0 });
      }
    }

    // Step 2: group into holes.
    setAutoProgress({
      current: withMeta.length,
      total: withMeta.length,
      phase: 'Grouping into holes...',
    });

    const ordered = getOrderedHoleNumbers();
    const groupedHoles: HoleImport[] = ordered.map((holeNum) => {
      const courseHole = courseHoles.find((h) => h.holeNumber === holeNum);
      return {
        holeNumber: holeNum,
        par: courseHole?.par ?? 4,
        clips: [],
        expanded: false,
      };
    });

    // Decide grouping strategy.
    // If at least one clip has creationTime AND they aren't all identical → timestamp strategy.
    // Otherwise → fall back to pose-based putt→swing grouping.
    const creationTimes = classified
      .map((c) => c.creationTime)
      .filter((t): t is number => t !== undefined);
    const allSameTimestamp =
      creationTimes.length > 0 &&
      creationTimes.every((t) => t === creationTimes[0]);

    const useTimestampStrategy = anyHasCreationTime && !allSameTimestamp;

    if (useTimestampStrategy) {
      console.log(
        `[AutoDetect] Using timestamp strategy for ${classified.length} clips ` +
          `(${creationTimes.length} have creationTime)`
      );

      // Sort by creationTime ascending; preserve picker order for ties / missing values.
      const sorted = [...classified].sort((a, b) => {
        const at = a.creationTime;
        const bt = b.creationTime;
        if (at === undefined && bt === undefined) return a.pickerIndex - b.pickerIndex;
        if (at === undefined) return a.pickerIndex - b.pickerIndex;
        if (bt === undefined) return a.pickerIndex - b.pickerIndex;
        if (at === bt) return a.pickerIndex - b.pickerIndex;
        return at - bt;
      });

      let holeIdx = 0;
      let prevTime: number | undefined;
      let prevShotType: ShotTypeClassification | null = null;

      for (let i = 0; i < sorted.length; i++) {
        const c = sorted[i];
        const curTime = c.creationTime;
        let gapMs = 0;
        if (prevTime !== undefined && curTime !== undefined) {
          gapMs = curTime - prevTime;
        }

        let newHole = false;
        let reason = '';

        if (i === 0) {
          reason = 'first clip';
        } else if (gapMs > HOLE_GAP_MS) {
          newHole = true;
          reason = `gap=${(gapMs / 60000).toFixed(1)}min > 3min`;
        } else if (gapMs > HOLE_GAP_AMBIGUOUS_MS) {
          // Ambiguous: confirm with pose transition
          if (prevShotType === 'putt' && c.shotType === 'swing') {
            newHole = true;
            reason = `gap=${(gapMs / 60000).toFixed(1)}min + putt→swing`;
          } else {
            reason = `gap=${(gapMs / 60000).toFixed(1)}min ambiguous, no putt→swing`;
          }
        } else if (curTime === undefined || prevTime === undefined) {
          // No timestamp for this transition → use pose fallback
          if (prevShotType === 'putt' && c.shotType === 'swing') {
            newHole = true;
            reason = 'no timestamp + putt→swing';
          } else {
            reason = 'no timestamp';
          }
        } else {
          reason = `gap=${(gapMs / 60000).toFixed(1)}min (same hole)`;
        }

        if (newHole) {
          holeIdx += 1;
          // Dynamic resize: if the picker gave us more holes than the user
          // selected (e.g. holesCount=9 but they filmed 18), append a new
          // HoleImport row instead of clamping onto the last hole. The old
          // `Math.min(holeIdx+1, length-1)` behavior was pinning every
          // overflow clip onto hole 9, producing "27 shots on hole 9."
          if (holeIdx >= groupedHoles.length) {
            const lastHoleNum = groupedHoles[groupedHoles.length - 1]?.holeNumber ?? 0;
            const nextHoleNum = lastHoleNum + 1;
            const courseHole = courseHoles.find((h) => h.holeNumber === nextHoleNum);
            groupedHoles.push({
              holeNumber: nextHoleNum,
              par: courseHole?.par ?? 4,
              clips: [],
              expanded: false,
            });
          }
        }

        console.log(
          `[AutoDetect] Clip ${i + 1}: ${reason}${newHole ? ' → new hole' : ''} ` +
            `(hole ${groupedHoles[holeIdx].holeNumber}, shotType=${c.shotType})`
        );

        groupedHoles[holeIdx].clips.push({ uri: c.uri, durationMs: c.duration, assetId: c.assetId });
        prevTime = curTime ?? prevTime;
        prevShotType = c.shotType;
      }
    } else {
      console.log(
        `[AutoDetect] Falling back to pose-based grouping ` +
          `(anyHasCreationTime=${anyHasCreationTime}, allSameTimestamp=${allSameTimestamp})`
      );

      let holeIdx = 0;
      let prevShotType: ShotTypeClassification | null = null;

      for (let i = 0; i < classified.length; i++) {
        const c = classified[i];
        // putt → swing means the swing belongs to the NEXT hole
        if (
          prevShotType === 'putt' &&
          c.shotType === 'swing'
        ) {
          holeIdx += 1;
          // Dynamic resize (see timestamp-strategy branch for rationale).
          if (holeIdx >= groupedHoles.length) {
            const lastHoleNum = groupedHoles[groupedHoles.length - 1]?.holeNumber ?? 0;
            const nextHoleNum = lastHoleNum + 1;
            const courseHole = courseHoles.find((h) => h.holeNumber === nextHoleNum);
            groupedHoles.push({
              holeNumber: nextHoleNum,
              par: courseHole?.par ?? 4,
              clips: [],
              expanded: false,
            });
          }
          console.log(
            `[AutoDetect] Clip ${i + 1}: putt→swing → new hole ` +
              `(hole ${groupedHoles[holeIdx].holeNumber})`
          );
        } else {
          console.log(
            `[AutoDetect] Clip ${i + 1}: shotType=${c.shotType} ` +
              `(hole ${groupedHoles[holeIdx].holeNumber})`
          );
        }
        groupedHoles[holeIdx].clips.push({ uri: c.uri, durationMs: c.duration, assetId: c.assetId });
        prevShotType = c.shotType;
      }
    }

    // Sanity pass — if any hole ends up with >8 shots it's a statistical outlier
    // (even terrible golfers rarely exceed 8 on a par-5). Flag them for the user
    // to review grouping on the Review Clips screen. We don't auto-split yet —
    // just surface the anomaly so they can drag clips between holes.
    const oversizedHoles = groupedHoles
      .filter((h) => h.clips.length > 8)
      .map((h) => h.holeNumber);
    if (oversizedHoles.length > 0) {
      console.warn(
        `[AutoDetect] Sanity pass: ${oversizedHoles.length} hole(s) with >8 shots: ${oversizedHoles.join(', ')}`
      );
      setSanityWarning({ oversizedHoles });
    } else {
      setSanityWarning(null);
    }

    // Expand holes that have clips
    for (const h of groupedHoles) {
      h.expanded = h.clips.length > 0;
    }

    setHoles(groupedHoles);

    // Pre-fill scores based on grouping
    const initialScores: Record<number, number> = {};
    const initialPars: Record<number, number> = {};
    for (const h of groupedHoles) {
      initialPars[h.holeNumber] = h.par;
      if (h.clips.length > 0) {
        initialScores[h.holeNumber] = h.clips.length;
      }
    }
    setScores(initialScores);
    setPars(initialPars);

    // Fire-and-forget thumbnail generation
    for (const hole of groupedHoles) {
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

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // Route to scorecard so user can review/edit scores before confirming
    setStep('scorecard');
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
    if (!ImagePicker) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsMultipleSelection: true,
      quality: 1,
      orderedSelection: true,
    });

    if (result.canceled || !result.assets?.length) return;

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
    if (!ImagePicker) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsMultipleSelection: true,
      quality: 1,
    });

    if (result.canceled || !result.assets?.length) return;

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

    // If auto mode, recompute scores from new clip counts
    if (importMode === 'auto') {
      setScores((prev) => {
        const next = { ...prev };
        // Find next clip counts post-move
        const sourceCount = (holes.find((h) => h.holeNumber === sourceHole)?.clips.length ?? 1) - 1;
        const targetCount = (holes.find((h) => h.holeNumber === targetHole)?.clips.length ?? 0) + 1;
        if (sourceCount > 0) next[sourceHole] = sourceCount;
        else delete next[sourceHole];
        next[targetHole] = targetCount;
        return next;
      });
    }

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
    const targets = Array.from({ length: holesCount }, (_, i) => i + 1);
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
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const round = await createRound({
        course_name: courseName.trim(),
        course_id: selectedCourseId,
        holes_played: holesCount,
      });

      const roundId = round.id;

      try {
        await saveLocalRound({
          id: roundId,
          course_name: courseName.trim(),
          course_id: selectedCourseId,
        });
      } catch {}

      // Read storage policy once for the whole import. Mirror toggle controls
      // whether we push every imported clip to the user's Photos library
      // (off by default — Photos is ~free storage from the user's POV but
      // duplicates the on-disk footprint). Cloud-backup toggle gates the
      // Supabase upload queue at the bottom of this function.
      const mirrorToPhotos = await getMirrorClipsToPhotos();
      const cloudBackupOn = await getCloudBackupEnabled();

      for (const hole of holes) {
        for (let shotIdx = 0; shotIdx < hole.clips.length; shotIdx++) {
          const clip = hole.clips[shotIdx];
          const shotNumber = shotIdx + 1;

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
          const filename = `imported_${roundId}_h${hole.holeNumber}_s${shotNumber}_${Date.now()}.mp4`;
          let durableUri: string;
          try {
            durableUri = await persistAsset(clip.uri, filename);
          } catch {
            durableUri = await resolveAssetUri(clip.uri);
          }

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

          const clipId = await saveLocalClip({
            round_id: roundId,
            hole_number: hole.holeNumber,
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

          try {
            await createShot({
              round_id: roundId,
              user_id: user.id,
              hole_number: hole.holeNumber,
              shot_number: shotNumber,
              clip_url: '',
            });
          } catch {}
        }
      }

      // Save scores per hole — use scorecard scores for quick & auto imports, clip count for manual
      const usesScorecard = importMode === 'quick' || importMode === 'auto';
      for (const hole of holes) {
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
      }

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
    }
  };

  // Back navigation per step
  const handleBack = () => {
    switch (step) {
      case 'setup':
        router.back();
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
      case 'auto-processing':
        // Classification can't meaningfully go back mid-flight; return to mode
        setStep('mode');
        break;
      case 'import':
        if (importMode === 'quick') {
          // If coming from bulk import, go back to bulk import
          setBulkVideos([]);
          setStep('bulk-import');
        } else if (importMode === 'auto') {
          // Clips already grouped — let user tweak the scorecard
          setStep('scorecard');
        } else {
          setStep('mode');
        }
        break;
    }
  };

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
                marginBottom: 20,
              }}
            >
              Import videos from your camera roll and assign them to holes.
            </Text>

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

            {/* Auto Detect (recommended) */}
            <Pressable
              onPress={() => handleModeSelect('auto')}
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
                    <Sparkles size={24} color={theme.colors.primary} />
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
                        Auto Detect
                      </Text>
                      <View style={{
                        backgroundColor: theme.colors.primary,
                        paddingHorizontal: 8,
                        paddingVertical: 2,
                        borderRadius: 8,
                      }}>
                        <Text style={{ color: '#000', fontSize: 10, fontWeight: '700' }}>NEW</Text>
                      </View>
                    </View>
                    <Text
                      style={{
                        color: theme.colors.textSecondary,
                        fontSize: 13,
                        lineHeight: 18,
                      }}
                    >
                      Just pick all your videos. We'll classify each shot and automatically
                      group them into holes. Review the scorecard after.
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

            {/* Quick Import */}
            <Pressable
              onPress={() => handleModeSelect('quick')}
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
                    <Zap size={24} color={theme.colors.primary} />
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
                      Quick Import
                    </Text>
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

  // ---- STEP 2.5: Auto-Detect Processing ----
  if (step === 'auto-processing') {
    const pct = autoProgress.total > 0
      ? Math.round((autoProgress.current / autoProgress.total) * 100)
      : 0;
    return (
      <GradientBackground>
        <View
          style={{
            flex: 1,
            paddingTop: insets.top,
            justifyContent: 'center',
            alignItems: 'center',
            padding: 32,
          }}
        >
          <View
            style={{
              width: 80,
              height: 80,
              borderRadius: 40,
              backgroundColor: theme.colors.primaryMuted,
              justifyContent: 'center',
              alignItems: 'center',
              marginBottom: 24,
            }}
          >
            <Sparkles size={36} color={theme.colors.primary} />
          </View>
          <Text
            style={{
              color: theme.colors.textPrimary,
              fontSize: 20,
              fontWeight: '700',
              marginBottom: 8,
              textAlign: 'center',
            }}
          >
            Auto-detecting holes
          </Text>
          <Text
            style={{
              color: theme.colors.textSecondary,
              fontSize: 14,
              textAlign: 'center',
              marginBottom: 32,
            }}
          >
            {autoProgress.phase}
          </Text>
          {autoProgress.total > 0 && (
            <>
              <View
                style={{
                  width: '100%',
                  height: 8,
                  backgroundColor: theme.colors.primaryMuted,
                  borderRadius: 4,
                  overflow: 'hidden',
                  marginBottom: 12,
                }}
              >
                <View
                  style={{
                    width: `${pct}%`,
                    height: '100%',
                    backgroundColor: theme.colors.primary,
                  }}
                />
              </View>
              <Text
                style={{
                  color: theme.colors.textTertiary,
                  fontSize: 13,
                  fontVariant: ['tabular-nums'],
                }}
              >
                {autoProgress.current} / {autoProgress.total} ({pct}%)
              </Text>
            </>
          )}
        </View>
      </GradientBackground>
    );
  }

  // ---- STEP 3: Scorecard Entry ----
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
            {/* Auto-detected banner */}
            {importMode === 'auto' && (
              <Card
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  padding: 14,
                  marginBottom: 20,
                  backgroundColor: theme.colors.primary + '15',
                  borderColor: theme.colors.primary + '40',
                  borderWidth: 1,
                }}
              >
                <Sparkles size={20} color={theme.colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text
                    style={{
                      color: theme.colors.textPrimary,
                      fontSize: 14,
                      fontWeight: '700',
                      marginBottom: 2,
                    }}
                  >
                    Scores Auto-Detected
                  </Text>
                  <Text
                    style={{
                      color: theme.colors.textSecondary,
                      fontSize: 12,
                      lineHeight: 16,
                    }}
                  >
                    Shots were grouped into holes automatically. Tap any cell to adjust.
                  </Text>
                </View>
              </Card>
            )}

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
                title={importMode === 'auto' ? 'Next — Review Clips' : 'Next — Import Videos'}
                onPress={() => {
                  if (importMode === 'auto') {
                    // Clips already picked & grouped by auto-detect; skip bulk-import and
                    // go straight to the per-hole review screen.
                    setStep('import');
                  } else {
                    setBulkVideos([]);
                    setStep('bulk-import');
                  }
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
            {importMode === 'quick' || importMode === 'auto' ? 'Review Clips' : 'Add Clips'}
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
          {importMode === 'auto' && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingHorizontal: 4,
                marginBottom: 12,
              }}
            >
              <Info size={14} color={theme.colors.textTertiary} />
              <Text
                style={{
                  color: theme.colors.textTertiary,
                  fontSize: 12,
                  flex: 1,
                }}
              >
                Long-press any clip to move it to a different hole.
              </Text>
            </View>
          )}
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
                      {(importMode === 'quick' || importMode === 'auto') &&
                      scores[hole.holeNumber]
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
                ? 'Importing...'
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
