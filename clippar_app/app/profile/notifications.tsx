import { useState, useEffect } from 'react';
import { View, Text, Switch } from 'react-native';
import { Stack } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Bell, Package, Megaphone } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { Card } from '@/components/ui/Card';

const NOTIFICATION_KEYS = {
  reelReady: 'notif_reel_ready',
  shipping: 'notif_shipping',
  news: 'notif_news',
};

function NotificationRow({
  icon,
  title,
  subtitle,
  value,
  onValueChange,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  value: boolean;
  onValueChange: (val: boolean) => void;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 16,
        gap: 14,
      }}
    >
      {icon}
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '500' }}>
          {title}
        </Text>
        <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>{subtitle}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
        thumbColor="#FFFFFF"
      />
    </View>
  );
}

export default function NotificationsScreen() {
  const [reelReady, setReelReady] = useState(true);
  const [shipping, setShipping] = useState(true);
  const [news, setNews] = useState(false);

  useEffect(() => {
    AsyncStorage.multiGet(Object.values(NOTIFICATION_KEYS)).then((results) => {
      for (const [key, value] of results) {
        if (key === NOTIFICATION_KEYS.reelReady) setReelReady(value !== 'false');
        if (key === NOTIFICATION_KEYS.shipping) setShipping(value !== 'false');
        if (key === NOTIFICATION_KEYS.news) setNews(value === 'true');
      }
    });
  }, []);

  const toggle = (key: string, value: boolean, setter: (v: boolean) => void) => {
    setter(value);
    AsyncStorage.setItem(key, String(value));
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Notifications' }} />
      <View style={{ flex: 1, padding: 16 }}>
        <Text style={{ color: theme.colors.textSecondary, fontSize: 13, fontWeight: '500', marginBottom: 8 }}>
          PUSH NOTIFICATIONS
        </Text>
        <Card style={{ paddingVertical: 4, paddingHorizontal: 0 }}>
          <NotificationRow
            icon={<Bell size={20} color={theme.colors.primary} />}
            title="Reel Ready"
            subtitle="When your highlight reel is processed"
            value={reelReady}
            onValueChange={(v) => toggle(NOTIFICATION_KEYS.reelReady, v, setReelReady)}
          />
          <View style={{ height: 1, backgroundColor: theme.colors.surfaceBorder, marginHorizontal: 16 }} />
          <NotificationRow
            icon={<Package size={20} color={theme.colors.processing} />}
            title="Shipping Updates"
            subtitle="Order status and tracking"
            value={shipping}
            onValueChange={(v) => toggle(NOTIFICATION_KEYS.shipping, v, setShipping)}
          />
          <View style={{ height: 1, backgroundColor: theme.colors.surfaceBorder, marginHorizontal: 16 }} />
          <NotificationRow
            icon={<Megaphone size={20} color={theme.colors.textTertiary} />}
            title="News & Tips"
            subtitle="Golf tips and app updates"
            value={news}
            onValueChange={(v) => toggle(NOTIFICATION_KEYS.news, v, setNews)}
          />
        </Card>
      </View>
    </>
  );
}
