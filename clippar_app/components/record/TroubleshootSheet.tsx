/**
 * "Troubleshoot & how-to" — every question a golfer might have on the record
 * screen, answered in steps. Content lives in lib/clickerHelp.ts.
 */
import { Modal, View, Text, ScrollView, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { HELP_SECTIONS } from '@/lib/clickerHelp';

export function TroubleshootSheet({ visible, onDismiss }: { visible: boolean; onDismiss: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onDismiss}>
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: 10,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.surfaceBorder,
          }}
        >
          <Text style={{ color: theme.colors.textPrimary, fontSize: 18, fontWeight: '800' }}>Troubleshoot & how-to</Text>
          <Pressable onPress={onDismiss} hitSlop={10} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: theme.colors.surfaceElevated, justifyContent: 'center', alignItems: 'center' }}>
            <X size={20} color={theme.colors.textPrimary} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 18 }}>
          {HELP_SECTIONS.map((s) => (
            <View key={s.key} style={{ backgroundColor: theme.colors.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: theme.colors.surfaceBorder }}>
              <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '700', marginBottom: 8 }}>{s.title}</Text>
              {s.steps.map((line, i) => (
                <View key={i} style={{ flexDirection: 'row', gap: 8, marginBottom: 6 }}>
                  <Text style={{ color: theme.colors.primary, fontSize: 14, lineHeight: 20 }}>•</Text>
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 14, lineHeight: 20, flex: 1 }}>{line}</Text>
                </View>
              ))}
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}
