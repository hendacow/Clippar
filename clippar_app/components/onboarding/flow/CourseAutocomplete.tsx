/**
 * Lightweight course-name autocomplete for onboarding screen 5.
 *
 * Reuses lib/golfCourseApi's text search (same API + AU-first ranking the
 * round-setup CourseSearch uses) but stays name-only: onboarding just needs
 * the course *name* for personalization — no hole data, no Supabase upsert.
 * Degrades gracefully: with no API key the search returns [] and whatever
 * the user typed is still accepted as their home course.
 */
import { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { MapPin } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { searchGolfCoursesLive, type GolfCourseSearchResult } from '@/lib/golfCourseApi';

export function CourseAutocomplete({
  value,
  onChangeText,
  onSelect,
}: {
  value: string;
  onChangeText: (text: string) => void;
  /** Fired when a suggestion is tapped (with the canonical course name). */
  onSelect: (name: string) => void;
}) {
  const [results, setResults] = useState<GolfCourseSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justSelectedRef = useRef(0);

  const handleChange = useCallback(
    (text: string) => {
      if (Date.now() - justSelectedRef.current < 500) return;
      onChangeText(text);
      setOpen(true);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (text.trim().length < 2) {
        setResults([]);
        return;
      }
      debounceRef.current = setTimeout(async () => {
        setLoading(true);
        try {
          const found = await searchGolfCoursesLive(text.trim());
          setResults(found.slice(0, 6));
        } catch {
          setResults([]);
        } finally {
          setLoading(false);
        }
      }, 300);
    },
    [onChangeText]
  );

  const handleSelect = useCallback(
    (course: GolfCourseSearchResult) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      justSelectedRef.current = Date.now();
      setOpen(false);
      setResults([]);
      onSelect(course.name);
    },
    [onSelect]
  );

  return (
    <View>
      <TextInput
        value={value}
        onChangeText={handleChange}
        placeholder="Search your course…"
        placeholderTextColor={theme.colors.textTertiary}
        autoCorrect={false}
        onFocus={() => setOpen(true)}
        style={{
          backgroundColor: theme.colors.surface,
          borderWidth: 1,
          borderColor: theme.colors.surfaceBorder,
          borderRadius: theme.radius.md,
          padding: 14,
          color: theme.colors.textPrimary,
          fontSize: 16,
        }}
      />
      {open && (loading || results.length > 0) ? (
        <View
          style={{
            backgroundColor: theme.colors.surfaceElevated,
            borderWidth: 1,
            borderColor: theme.colors.surfaceBorder,
            borderRadius: theme.radius.md,
            marginTop: 6,
            maxHeight: 240,
            overflow: 'hidden',
          }}
        >
          {loading ? (
            <View style={{ padding: 14, alignItems: 'center' }}>
              <ActivityIndicator color={theme.colors.primary} size="small" />
            </View>
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              {results.map((c) => (
                <Pressable
                  key={c.id}
                  onPress={() => handleSelect(c)}
                  style={({ pressed }) => ({
                    padding: 12,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    backgroundColor: pressed ? theme.colors.surface : 'transparent',
                    borderBottomWidth: 1,
                    borderBottomColor: theme.colors.surfaceBorder,
                  })}
                >
                  <MapPin size={15} color={theme.colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '600' }}
                      numberOfLines={1}
                    >
                      {c.name}
                    </Text>
                    {c.city || c.state ? (
                      <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 1 }}>
                        {[c.city, c.state].filter(Boolean).join(', ')}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      ) : null}
    </View>
  );
}
