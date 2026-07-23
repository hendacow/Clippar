/**
 * The one round-delete confirmation dialog. Replaces the three previously
 * copy-pasted (and diverging) confirms on Home, round detail, and the
 * Backup & status screen.
 */
import { Alert } from 'react-native';

export function confirmDeleteRound(onConfirm: () => void | Promise<void>): void {
  Alert.alert(
    'Delete this round?',
    "The reel and clips on this phone will be removed. This can't be undone.",
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void onConfirm() },
    ],
  );
}
