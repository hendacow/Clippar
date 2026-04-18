import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  Modal,
  StyleSheet,
} from 'react-native';
import { X } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { PreviewPlayer } from '@/components/editor/PreviewPlayer';
import {
  getHighlightCompilationClips,
  type HighlightCompilationCategory,
  type HighlightCompilationTimeframe,
} from '@/lib/api';
import {
  stitchClips,
  addStitchProgressListener,
  type StitchProgressEvent,
} from 'shot-detector';

const CATEGORY_LABELS: Record<HighlightCompilationCategory, string> = {
  eagle: 'Eagles',
  birdie: 'Birdies',
  par: 'Pars',
  bogey: 'Bogeys',
  double: 'Doubles',
  triple: 'Triples+',
};

type Phase =
  | { kind: 'loading' }
  | { kind: 'stitching'; current: number; total: number; percent: number }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'playing'; uri: string; clipCount: number; durationMs: number };

interface CompilationPlayerProps {
  visible: boolean;
  category: HighlightCompilationCategory | null;
  courseId?: string | null;
  hole?: number | null;
  timeframe?: HighlightCompilationTimeframe;
  courseName?: string | null;
  onClose: () => void;
}

/**
 * Full-screen stitched-compilation viewer.
 * Fetches all clips matching (category, course, hole, timeframe), stitches
 * them on-device via AVMutableComposition, and plays the result.
 */
export function CompilationPlayer({
  visible,
  category,
  courseId,
  hole,
  timeframe,
  courseName,
  onClose,
}: CompilationPlayerProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!visible || !category) return;
    cancelledRef.current = false;
    setPhase({ kind: 'loading' });

    // Subscribe to stitch progress before the work starts so we never miss an event.
    const sub = addStitchProgressListener((event: StitchProgressEvent) => {
      if (cancelledRef.current) return;
      setPhase({
        kind: 'stitching',
        current: event.current,
        total: event.total,
        percent: event.percent,
      });
    });

    (async () => {
      try {
        const { signedUrls } = await getHighlightCompilationClips(category, {
          courseId,
          hole,
          timeframe,
        });
        if (cancelledRef.current) return;

        if (signedUrls.length === 0) {
          setPhase({ kind: 'empty' });
          return;
        }

        setPhase({
          kind: 'stitching',
          current: 0,
          total: signedUrls.length,
          percent: 0,
        });

        const result = await stitchClips(signedUrls);
        if (cancelledRef.current) return;

        setPhase({
          kind: 'playing',
          uri: result.stitchedUri,
          clipCount: result.clipCount,
          durationMs: result.durationMs,
        });
      } catch (err) {
        if (cancelledRef.current) return;
        setPhase({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Could not build compilation',
        });
      }
    })();

    return () => {
      cancelledRef.current = true;
      sub.remove();
    };
  }, [visible, category, courseId, hole, timeframe]);

  const title = category
    ? buildTitle(category, { courseName, hole, timeframe })
    : '';

  return (
    <Modal
      visible={visible}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            style={styles.closeButton}
            accessibilityLabel="Close compilation"
          >
            <X size={22} color={theme.colors.textPrimary} />
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <View style={{ width: 38 }} />
        </View>

        {phase.kind === 'loading' && (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.status}>Finding clips…</Text>
          </View>
        )}

        {phase.kind === 'stitching' && (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.status}>
              Stitching {phase.total} clip{phase.total === 1 ? '' : 's'}…
            </Text>
            <Text style={styles.subStatus}>
              {phase.percent > 0 ? `${Math.round(phase.percent)}%` : 'Preparing…'}
            </Text>
          </View>
        )}

        {phase.kind === 'empty' && (
          <View style={styles.center}>
            <Text style={styles.status}>
              No {CATEGORY_LABELS[category ?? 'par'].toLowerCase()} yet for the
              selected filters.
            </Text>
            <Text style={styles.subStatus}>Keep playing — you’ll get there.</Text>
          </View>
        )}

        {phase.kind === 'error' && (
          <View style={styles.center}>
            <Text style={styles.status}>Couldn’t build the reel.</Text>
            <Text style={styles.subStatus}>{phase.message}</Text>
          </View>
        )}

        {phase.kind === 'playing' && (
          <PreviewPlayer
            clips={[
              {
                uri: phase.uri,
                holeNumber: 0,
                shotNumber: 0,
                durationMs: phase.durationMs,
              },
            ]}
            onDismiss={onClose}
            style={styles.player}
          />
        )}
      </View>
    </Modal>
  );
}

function buildTitle(
  category: HighlightCompilationCategory,
  opts: {
    courseName?: string | null;
    hole?: number | null;
    timeframe?: HighlightCompilationTimeframe;
  },
): string {
  const parts: string[] = [CATEGORY_LABELS[category]];
  if (opts.courseName) parts.push(`· ${opts.courseName}`);
  if (opts.hole != null) parts.push(`· Hole ${opts.hole}`);
  if (opts.timeframe && opts.timeframe !== 'all') {
    parts.push(`· ${timeframeLabel(opts.timeframe)}`);
  }
  return parts.join(' ');
}

function timeframeLabel(t: HighlightCompilationTimeframe): string {
  switch (t) {
    case '7d': return 'last 7 days';
    case '30d': return 'last 30 days';
    case '90d': return 'last 90 days';
    case '1y': return 'last year';
    case 'all': return '';
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 48,
    paddingBottom: 12,
    paddingHorizontal: 14,
    backgroundColor: '#000',
  },
  closeButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
    textAlign: 'center',
    marginHorizontal: 8,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 10,
  },
  status: {
    color: theme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  subStatus: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
  },
  player: {
    flex: 1,
  },
});
