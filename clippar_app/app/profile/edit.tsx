import { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { router, Stack } from 'expo-router';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { Camera, X, Check } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { getProfile, updateProfile } from '@/lib/api';
import { supabase } from '@/lib/supabase';

interface ProfileData {
  display_name: string;
  email: string;
  handicap: string;
  home_course: string;
  avatar_url: string | null;
}

export default function EditProfileScreen() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [profile, setProfile] = useState<ProfileData>({
    display_name: '',
    email: '',
    handicap: '',
    home_course: '',
    avatar_url: null,
  });
  const [original, setOriginal] = useState<ProfileData | null>(null);

  useEffect(() => {
    loadProfile();
  }, []);

  async function loadProfile() {
    try {
      const data = await getProfile();
      const p: ProfileData = {
        display_name: data?.display_name || user?.user_metadata?.full_name || '',
        email: user?.email || data?.email || '',
        handicap: data?.handicap != null ? String(data.handicap) : '',
        home_course: data?.home_course || '',
        avatar_url: data?.avatar_url || null,
      };
      setProfile(p);
      setOriginal(p);
    } catch (err) {
      console.log('[EditProfile] load error:', err);
    } finally {
      setLoading(false);
    }
  }

  const hasChanges =
    original != null &&
    (profile.display_name !== original.display_name ||
      profile.handicap !== original.handicap ||
      profile.home_course !== original.home_course ||
      profile.avatar_url !== original.avatar_url);

  async function handlePickPhoto() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.7,
      });

      if (result.canceled || !result.assets?.[0]) return;

      setUploadingPhoto(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      const asset = result.assets[0];
      const ext = asset.uri.split('.').pop() || 'jpg';
      const fileName = `${user?.id}/avatar.${ext}`;

      // Read file and upload to Supabase storage
      const response = await fetch(asset.uri);
      const blob = await response.blob();

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(fileName, blob, {
          upsert: true,
          contentType: asset.mimeType || 'image/jpeg',
        });

      if (uploadError) {
        // If bucket doesn't exist, just save the local URI as a placeholder
        console.log('[EditProfile] upload error (bucket may not exist):', uploadError.message);
        setProfile((p) => ({ ...p, avatar_url: asset.uri }));
      } else {
        const { data: urlData } = supabase.storage
          .from('avatars')
          .getPublicUrl(fileName);

        setProfile((p) => ({ ...p, avatar_url: urlData.publicUrl }));
      }
    } catch (err) {
      console.log('[EditProfile] photo pick error:', err);
      Alert.alert('Error', 'Failed to update photo. Please try again.');
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function handleSave() {
    if (!hasChanges) return;

    setSaving(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const updates: Record<string, unknown> = {
        display_name: profile.display_name.trim() || null,
        home_course: profile.home_course.trim() || null,
        avatar_url: profile.avatar_url,
      };

      // Parse handicap as a number
      const handicapNum = parseFloat(profile.handicap);
      if (!isNaN(handicapNum) && handicapNum >= -10 && handicapNum <= 54) {
        updates.handicap = handicapNum;
      } else if (profile.handicap.trim() === '') {
        updates.handicap = null;
      } else {
        Alert.alert('Invalid Handicap', 'Handicap must be between -10 and 54.');
        setSaving(false);
        return;
      }

      await updateProfile(updates);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (err) {
      console.log('[EditProfile] save error:', err);
      Alert.alert('Error', 'Failed to save profile. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, justifyContent: 'center', alignItems: 'center' }}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator color={theme.colors.primary} size="large" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen
        options={{
          title: 'Edit Profile',
          headerLeft: () => (
            <Pressable onPress={() => router.back()} hitSlop={12}>
              <X size={22} color={theme.colors.textSecondary} />
            </Pressable>
          ),
          headerRight: () => (
            <Pressable
              onPress={handleSave}
              disabled={!hasChanges || saving}
              hitSlop={12}
              style={{ opacity: hasChanges && !saving ? 1 : 0.4 }}
            >
              {saving ? (
                <ActivityIndicator color={theme.colors.primary} size="small" />
              ) : (
                <Check size={22} color={theme.colors.primary} />
              )}
            </Pressable>
          ),
        }}
      />

      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Avatar */}
        <View style={{ alignItems: 'center', marginTop: 8, marginBottom: 8 }}>
          <Pressable onPress={handlePickPhoto} disabled={uploadingPhoto}>
            <View
              style={{
                width: 96,
                height: 96,
                borderRadius: 48,
                backgroundColor: theme.colors.surface,
                borderWidth: 2,
                borderColor: theme.colors.surfaceBorder,
                justifyContent: 'center',
                alignItems: 'center',
                overflow: 'hidden',
              }}
            >
              {uploadingPhoto ? (
                <ActivityIndicator color={theme.colors.primary} />
              ) : profile.avatar_url ? (
                <Image
                  source={{ uri: profile.avatar_url }}
                  style={{ width: 96, height: 96 }}
                  contentFit="cover"
                />
              ) : (
                <Text style={{ fontSize: 36, fontWeight: '800', color: theme.colors.primary }}>
                  {(profile.display_name || 'G')[0].toUpperCase()}
                </Text>
              )}
            </View>
            <View
              style={{
                position: 'absolute',
                bottom: 0,
                right: 0,
                width: 30,
                height: 30,
                borderRadius: 15,
                backgroundColor: theme.colors.primary,
                justifyContent: 'center',
                alignItems: 'center',
                borderWidth: 2,
                borderColor: theme.colors.background,
              }}
            >
              <Camera size={14} color="#fff" />
            </View>
          </Pressable>
        </View>

        {/* Display Name */}
        <FieldGroup label="Display Name">
          <TextInput
            value={profile.display_name}
            onChangeText={(t) => setProfile((p) => ({ ...p, display_name: t }))}
            placeholder="Your name"
            placeholderTextColor={theme.colors.textTertiary}
            style={inputStyle}
            autoCapitalize="words"
            autoCorrect={false}
          />
        </FieldGroup>

        {/* Email (read-only) */}
        <FieldGroup label="Email">
          <View style={[inputContainerStyle, { opacity: 0.6 }]}>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 16 }}>
              {profile.email}
            </Text>
          </View>
          <Text style={{ color: theme.colors.textTertiary, fontSize: 12, marginTop: 4 }}>
            Email is managed through your login and cannot be changed here.
          </Text>
        </FieldGroup>

        {/* Handicap */}
        <FieldGroup label="Handicap">
          <TextInput
            value={profile.handicap}
            onChangeText={(t) => setProfile((p) => ({ ...p, handicap: t }))}
            placeholder="e.g. 18"
            placeholderTextColor={theme.colors.textTertiary}
            style={inputStyle}
            keyboardType="decimal-pad"
            returnKeyType="done"
          />
          <Text style={{ color: theme.colors.textTertiary, fontSize: 12, marginTop: 4 }}>
            Your golf handicap index (-10 to 54)
          </Text>
        </FieldGroup>

        {/* Home Course */}
        <FieldGroup label="Home Course">
          <TextInput
            value={profile.home_course}
            onChangeText={(t) => setProfile((p) => ({ ...p, home_course: t }))}
            placeholder="e.g. Royal Melbourne"
            placeholderTextColor={theme.colors.textTertiary}
            style={inputStyle}
            autoCapitalize="words"
          />
        </FieldGroup>

        {/* Save Button (for scrolled view) */}
        {hasChanges && (
          <Pressable
            onPress={handleSave}
            disabled={saving}
            style={{
              backgroundColor: theme.colors.primary,
              paddingVertical: 16,
              borderRadius: theme.radius.full,
              alignItems: 'center',
              marginTop: 8,
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                Save Changes
              </Text>
            )}
          </Pressable>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View>
      <Text
        style={{
          color: theme.colors.textSecondary,
          fontSize: 13,
          fontWeight: '600',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          marginBottom: 8,
        }}
      >
        {label}
      </Text>
      {children}
    </View>
  );
}

const inputContainerStyle = {
  backgroundColor: theme.colors.surfaceElevated,
  borderRadius: theme.radius.md,
  borderWidth: 1,
  borderColor: theme.colors.surfaceBorder,
  paddingHorizontal: 14,
  paddingVertical: 14,
};

const inputStyle = {
  ...inputContainerStyle,
  color: theme.colors.textPrimary,
  fontSize: 16,
};
