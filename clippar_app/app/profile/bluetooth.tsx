import { View, Text, FlatList, Pressable, ActivityIndicator } from 'react-native';
import { Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Bluetooth, BluetoothOff, Wifi, WifiOff } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useBLE } from '@/hooks/useBLE';

export default function BluetoothScreen() {
  const ble = useBLE();

  return (
    <>
      <Stack.Screen options={{ title: 'Bluetooth Clicker' }} />
      <View style={{ flex: 1, padding: 16 }}>
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

        {/* Actions */}
        {ble.connectionState === 'connected' ? (
          <Button
            title="Disconnect"
            onPress={ble.disconnect}
            variant="ghost"
          />
        ) : (
          <Button
            title={ble.connectionState === 'scanning' ? 'Scanning...' : 'Scan for Devices'}
            onPress={ble.startScan}
            disabled={ble.connectionState === 'scanning'}
          />
        )}

        {/* Discovered Devices */}
        {ble.devices.length > 0 && (
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

        {ble.connectionState === 'scanning' && ble.devices.length === 0 && (
          <View style={{ marginTop: 32, alignItems: 'center' }}>
            <ActivityIndicator color={theme.colors.primary} />
            <Text style={{ color: theme.colors.textSecondary, marginTop: 8, fontSize: 14 }}>
              Searching for nearby devices...
            </Text>
          </View>
        )}

        {/* Info note */}
        <View style={{ marginTop: 'auto', paddingVertical: 16 }}>
          <Text style={{ color: theme.colors.textTertiary, fontSize: 12, textAlign: 'center' }}>
            BLE clicker requires a development build.{'\n'}
            Not available in Expo Go.
          </Text>
        </View>
      </View>
    </>
  );
}
