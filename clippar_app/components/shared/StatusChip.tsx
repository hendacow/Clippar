/**
 * Status chip — the one visual encoding of the canonical round status
 * (lib/roundStatus.ts). READY renders nothing: the thumbnail + play glyph
 * is the ready signal.
 */
import { View, Text } from 'react-native';
import { theme } from '@/constants/theme';
import {
  getStatusChipMeta,
  type RoundStatus,
  type StatusColorToken,
} from '@/lib/roundStatusLogic';

const TOKEN_COLORS: Record<StatusColorToken, string> = {
  processing: theme.colors.processing,
  accentGold: theme.colors.accentGold,
  textSecondary: theme.colors.textSecondary,
  accentRed: theme.colors.accentRed,
  textTertiary: theme.colors.textTertiary,
};

export function StatusChip({
  status,
  clipsCount,
  composePercent,
}: {
  status: RoundStatus;
  clipsCount: number;
  /** Real compose percent (only shown when the pipeline emits one). */
  composePercent?: number | null;
}) {
  const meta = getStatusChipMeta(status, clipsCount, composePercent);
  if (!meta) return null;
  const color = TOKEN_COLORS[meta.colorToken];
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        backgroundColor: `${color}18`,
        paddingHorizontal: theme.spacing.sm,
        paddingVertical: 3,
        borderRadius: theme.radius.full,
      }}
    >
      <Text style={{ ...theme.typography.caption, color }} numberOfLines={1}>
        {meta.label}
      </Text>
    </View>
  );
}
