import { useState, useCallback, useRef } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { MapPin } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { searchCourses, getCourseHoles } from '@/lib/api';
import type { HoleData } from '@/types/round';

interface CourseSearchProps {
  value: string;
  onChangeText: (text: string) => void;
  onSelectCourse: (course: { id: string; name: string; par_total: number | null }, holes: HoleData[]) => void;
}

export function CourseSearch({ value, onChangeText, onSelectCourse }: CourseSearchProps) {
  const [results, setResults] = useState<any[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = useCallback((text: string) => {
    onChangeText(text);
    setShowResults(true);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (text.trim().length < 2) {
      setResults([]);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const courses = await searchCourses(text.trim());
        setResults(courses ?? []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
  }, [onChangeText]);

  const handleSelect = useCallback(async (course: any) => {
    onChangeText(course.name);
    setShowResults(false);
    setResults([]);

    let holes: HoleData[] = [];
    try {
      const holesData = await getCourseHoles(course.id);
      holes = (holesData ?? []).map((h: any) => ({
        holeNumber: h.hole_number,
        par: h.par,
        strokeIndex: h.stroke_index,
        lengthMeters: h.length_meters,
      }));
    } catch {
      // No holes data available — will fall back to default par
    }

    onSelectCourse(course, holes);
  }, [onChangeText, onSelectCourse]);

  return (
    <View>
      <Text style={{ color: theme.colors.textSecondary, fontSize: 13, fontWeight: '500', marginBottom: 6 }}>
        Course Name
      </Text>
      <TextInput
        value={value}
        onChangeText={handleChange}
        placeholder="Search for a course..."
        placeholderTextColor={theme.colors.textTertiary}
        onFocus={() => value.length >= 2 && setShowResults(true)}
        onBlur={() => setTimeout(() => setShowResults(false), 200)}
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

      {showResults && value.trim().length >= 2 && (
        <View
          style={{
            backgroundColor: theme.colors.surfaceElevated,
            borderWidth: 1,
            borderColor: theme.colors.surfaceBorder,
            borderRadius: theme.radius.md,
            marginTop: 4,
            maxHeight: 200,
            overflow: 'hidden',
          }}
        >
          {loading ? (
            <View style={{ padding: 16, alignItems: 'center' }}>
              <ActivityIndicator color={theme.colors.primary} size="small" />
            </View>
          ) : results.length === 0 ? (
            <View style={{ padding: 16, alignItems: 'center' }}>
              <Text style={{ color: theme.colors.textTertiary, fontSize: 13 }}>
                No courses found
              </Text>
            </View>
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              {results.map((item) => (
                <Pressable
                  key={item.id}
                  onPress={() => handleSelect(item)}
                  style={({ pressed }) => ({
                    padding: 12,
                    backgroundColor: pressed ? theme.colors.surface : 'transparent',
                    borderBottomWidth: 1,
                    borderBottomColor: theme.colors.surfaceBorder,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                  })}
                >
                  <MapPin size={16} color={theme.colors.textTertiary} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '500' }}>
                      {item.name}
                    </Text>
                    {(item.location_name || item.state) && (
                      <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                        {[item.location_name, item.state].filter(Boolean).join(', ')}
                        {item.par_total ? ` · Par ${item.par_total}` : ''}
                      </Text>
                    )}
                  </View>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      )}
    </View>
  );
}
