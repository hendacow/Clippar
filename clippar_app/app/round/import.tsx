import { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Alert,
  Platform,
  Image,
  ActivityIndicator,
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
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import { GradientBackground } from '@/components/ui/GradientBackground';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { CourseSearch } from '@/components/record/CourseSearch';
import { createRound, createShot, updateRound } from '@/lib/api';
import { saveLocalClip } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import type { HoleData } from '@/types/round';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

const ImagePicker = isNative
  ? (require('expo-image-picker') as typeof import('expo-image-picker'))
  : null;

const VideoThumbnails = isNative
  ? (require('expo-video-thumbnails') as typeof import('expo-video-thumbnails'))
  : null;

interface ImportedClip {
  uri: string;
  thumbnailUri?: string;
  durationMs?: number;
}

interface HoleImport {
  holeNumber: number;
  par: number;
  clips: ImportedClip[];
  expanded: boolean;
}

const HOLE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

export default function ImportRoundScreen() {
  const insets = useSafeAreaInsets();
  const [courseName, setCourseName] = useState('');
  const [selectedCourseId, setSelectedCourseId] = useState<string | undefined>();
  const [courseHoles, setCourseHoles] = useState<HoleData[]>([]);
  const [holesCount, setHolesCount] = useState(18);
  const [holes, setHoles] = useState<HoleImport[]>([]);
  const [step, setStep] = useState<'setup' | 'import'>('setup');
  const [importing, setImporting] = useState(false);

  const handleCourseSelect = (course: { id: string; name: string }, holeData: HoleData[]) => {
    setSelectedCourseId(course.id);
    if (holeData.length > 0) {
      setCourseHoles(holeData);
    }
  };

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
        expanded: i === 1,
      });
    }
    setHoles(holeList);
    setStep('import');
  }, [courseName, holesCount, courseHoles]);

  const toggleExpanded = (holeNumber: number) => {
    setHoles((prev) =>
      prev.map((h) =>
        h.holeNumber === holeNumber ? { ...h, expanded: !h.expanded } : h
      )
    );
  };

  const pickClipsForHole = async (holeNumber: number) => {
    if (!ImagePicker) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsMultipleSelection: true,
      quality: 1,
    });

    if (result.canceled || !result.assets?.length) return;

    const newClips: ImportedClip[] = [];
    for (const asset of result.assets) {
      let thumbnailUri: string | undefined;
      if (VideoThumbnails) {
        try {
          const thumb = await VideoThumbnails.getThumbnailAsync(asset.uri, {
            time: 500,
          });
          thumbnailUri = thumb.uri;
        } catch {}
      }
      newClips.push({
        uri: asset.uri,
        thumbnailUri,
        durationMs: asset.duration ? asset.duration : undefined,
      });
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setHoles((prev) =>
      prev.map((h) =>
        h.holeNumber === holeNumber
          ? { ...h, clips: [...h.clips, ...newClips], expanded: true }
          : h
      )
    );
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

  const totalClips = holes.reduce((sum, h) => sum + h.clips.length, 0);

  const handleImport = async () => {
    if (totalClips === 0) {
      Alert.alert('No Clips', 'Add at least one video clip to import.');
      return;
    }

    // Check auth first
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
      // Create round in Supabase
      const round = await createRound({
        course_name: courseName.trim(),
        course_id: selectedCourseId,
        holes_played: holesCount,
      });

      const roundId = round.id;

      // Save each clip locally and to Supabase
      for (const hole of holes) {
        for (let shotIdx = 0; shotIdx < hole.clips.length; shotIdx++) {
          const clip = hole.clips[shotIdx];
          const shotNumber = shotIdx + 1;

          // Save to local SQLite
          await saveLocalClip({
            round_id: roundId,
            hole_number: hole.holeNumber,
            shot_number: shotNumber,
            file_uri: clip.uri,
            duration_seconds: clip.durationMs
              ? clip.durationMs / 1000
              : undefined,
          });

          // Create shot record in Supabase
          try {
            await createShot({
              round_id: roundId,
              user_id: user.id,
              hole_number: hole.holeNumber,
              shot_number: shotNumber,
              clip_url: '', // Will be set after upload
            });
          } catch {}
        }
      }

      // Update round status to ready for editing
      await updateRound(roundId, { status: 'ready' } as any);

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Navigate to editor
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

  // ---- STEP 1: Setup ----
  if (step === 'setup') {
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

            {/* Course Search */}
            <CourseSearch
              value={courseName}
              onChangeText={setCourseName}
              onSelectCourse={handleCourseSelect}
            />

            {/* Holes Count */}
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
              title="Next — Select Videos"
              onPress={initHoles}
              style={{ marginTop: 32 }}
            />
          </ScrollView>
        </View>
      </GradientBackground>
    );
  }

  // ---- STEP 2: Import clips per hole ----
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
          <Pressable
            onPress={() => setStep('setup')}
            hitSlop={12}
          >
            <ArrowLeft size={24} color={theme.colors.textPrimary} />
          </Pressable>
          <Text
            style={{
              color: theme.colors.textPrimary,
              fontWeight: '700',
              fontSize: 18,
            }}
          >
            Add Clips
          </Text>
          <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>
            {totalClips} clip{totalClips !== 1 ? 's' : ''}
          </Text>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
        >
          {holes.map((hole) => (
            <Card
              key={hole.holeNumber}
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
                  {/* Clip thumbnails */}
                  {hole.clips.length > 0 && (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={{ marginBottom: 12 }}
                    >
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        {hole.clips.map((clip, idx) => (
                          <View
                            key={`${hole.holeNumber}-${idx}`}
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
                                style={{ width: 80, height: 80 }}
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
                          </View>
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
