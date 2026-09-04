import { useState } from 'react';
import { View, Text, FlatList, Pressable, ActivityIndicator, ScrollView, Linking } from 'react-native';
import { Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Bluetooth, BluetoothOff, Wifi, WifiOff } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useBLE } from '@/hooks/useBLE';
import { CONNECT_STEPS, HELP_SECTIONS } from '@/lib/clickerHelp';

export default function BluetoothScreen() {
  const ble = useBLE();
  // The scan is for clickers that talk BLE directly; most cheap shutters
  // pair in iPhone Settings as a keyboard, which the three steps cover.
  // Henry, 4 Sep: "get rid of Scan for devices — three steps to connect".
  const [showScan, setShowScan] = useState(false);

  return (
    <>
      <Stack.Screen options={{ title: 'Connect your clicker' }} />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* The three steps */}
        <View style={{ marginBottom: 20 }}>
          {CONNECT_STEPS.map((step, i) => (
            <View key={step.title} style={{ flexDirection: 'row', gap: 14, marginBottom: 16 }}>
              <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: theme.colors.primary, justifyContent: 'center', alignItems: 'center' }}>
                <Text style={{ color: '#000', fontSize: 16, fontWeight: '800' }}>{i + 1}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.colors.textPrimary, fontSize: 16, fontWeight: '700', marginBottom: 3 }}>{step.title}</Text>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 14, lineHeight: 20 }}>{step.body}</Text>
              </View>
            </View>
          ))}
          <Button title="Open iPhone Settings" onPress={() => { void Linking.openSettings(); }} variant="ghost" />
        </View>

        {/* Connection Status */}
        <Card style={{ marginBottom: 24, alignItems: 'center', paddingVertical: 32 }}>
          <View
            style={{
              width: 64,
              height: 64,
              borderRadius: 32,
              backgroundColor: ble.connectionState === 'connected'
                ? theme.colors.primaryMuted
                : theme.colors.surface,
              justifyContent: 'center',
              alignItems: 'center',
              marginBottom: 16,
            }}
          >
            {ble.connectionState === 'connected' ? (
              <Bluetooth size={28} color={theme.colors.primary} />
            ) : (
              <BluetoothOff size={28} color={theme.colors.textTertiary} />
            )}
          </View>
          <Text style={{ color: theme.colors.textPrimary, fontSize: 18, fontWeight: '700' }}>
            {ble.connectionState === 'connected'
              ? ble.connectedDevice?.name ?? 'Clicker Connected'
              : 'No Clicker Connected'}
          </Text>
          <Badge
            variant={ble.connectionState === 'connected' ? 'connected' : 'disconnected'}
            style={{ marginTop: 8 }}
          />
        </Card>

        {/* Having trouble? — the same answers as the record screen's Troubleshoot */}
        <Text style={{ color: theme.colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Having trouble?</Text>
        {HELP_SECTIONS.filter((h) => h.key === 'not-working' || h.key === 'record' || h.key === 'next-hole' || h.key === 'penalty').map((h) => (
          <View key={h.key} style={{ backgroundColor: theme.colors.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: theme.colors.surfaceBorder, marginBottom: 10 }}>
            <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '700', marginBottom: 6 }}>{h.title}</Text>
            {h.steps.map((line, i) => (
              <Text key={i} style={{ color: theme.colors.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 4 }}>• {line}</Text>
            ))}
          </View>
        ))}

        {/* Advanced: a direct Bluetooth scan for clickers that do not pair as a keyboard */}
        <Pressable onPress={() => setShowScan((v) => !v)} hitSlop={8} style={{ paddingVertical: 12 }}>
          <Text style={{ color: theme.colors.textTertiary, fontSize: 13, textDecorationLine: 'underline' }}>
            {showScan ? 'Hide advanced' : 'Advanced: my clicker does not show up in iPhone Settings'}
          </Text>
        </Pressable>
        {showScan && (ble.connectionState === 'connected' ? (
          <Button
            title="Disconnect"
            onPress={ble.disconnect}
            variant="ghost"
          />
        ) : (
          <Button
            title={ble.connectionState === 'scanning' ? 'Scanning...' : 'Scan for Bluetooth devices'}
            onPress={ble.startScan}
            disabled={ble.connectionState === 'scanning'}
          />
        ))}

        {/* Discovered Devices */}
        {showScan && ble.devices.length > 0 && (
          <View style={{ marginTop: 24 }}>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 13, fontWeight: '500', marginBottom: 8 }}>
              DISCOVERED DEVICES
            </Text>
            <Card style={{ paddingVertical: 0, paddingHorizontal: 0 }}>
              <FlatList
                data={ble.devices}
                keyExtractor={(item) => item.id}
                scrollEnabled={false}
                renderItem={({ item, index }) => (
                  <Pressable
                    onPress={() => ble.connectToDevice(item)}
                    style={{
                      paddingVertical: 14,
                      paddingHorizontal: 16,
                      flexDirection: 'row',
                      alignItems: 'center',
                      borderTopWidth: index === 0 ? 0 : 1,
                      borderTopColor: theme.colors.surfaceBorder,
                    }}
                  >
                    <Bluetooth size={18} color={theme.colors.accentBlue} />
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={{ color: theme.colors.textPrimary, fontSize: 15 }}>
                        {item.name ?? 'Unknown Device'}
                      </Text>
                      <Text style={{ color: theme.colors.textTertiary, fontSize: 12 }}>
                        {item.id.slice(0, 17)}...
                      </Text>
                    </View>
                    {item.rssi != null && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        {item.rssi > -60 ? (
                          <Wifi size={14} color={theme.colors.primary} />
                        ) : (
                          <WifiOff size={14} color={theme.colors.textTertiary} />
                        )}
                        <Text style={{ color: theme.colors.textTertiary, fontSize: 11 }}>
                          {item.rssi} dBm
                        </Text>
                      </View>
                    )}
                  </Pressable>
                )}
              />
            </Card>
          </View>
        )}

        {showScan && ble.connectionState === 'scanning' && ble.devices.length === 0 && (
          <View style={{ marginTop: 32, alignItems: 'center' }}>
            <ActivityIndicator color={theme.colors.primary} />
            <Text style={{ color: theme.colors.textSecondary, marginTop: 8, fontSize: 14 }}>
              Searching for nearby devices...
            </Text>
          </View>
        )}

      </ScrollView>
    </>
  );
}
