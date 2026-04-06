import { useState, useCallback, useRef, useEffect } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { MapPin, Plus } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { searchCourses, searchCoursesNearby, getCourseHoles } from '@/lib/api';
import type { HoleData } from '@/types/round';

interface CourseSearchProps {
  value: string;
  onChangeText: (text: string) => void;
  onSelectCourse: (course: { id: string; name: string; par_total: number | null }, holes: HoleData[]) => void;
  /** If provided, shows nearby courses before the user types */
  userLocation?: { latitude: number; longitude: number } | null;
  /** Called when user taps "Can't find your course?" */
  onRequestAddCourse?: () => void;
}

export function CourseSearch({
  value,
  onChangeText,
  onSelectCourse,
  userLocation,
  onRequestAddCourse,
}: CourseSearchProps) {
  const [results, setResults] = useState<any[]>([]);
  const [nearbyCourses, setNearbyCourses] = useState<any[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard: after a course is selected, ignore the next onChangeText from the
  // TextInput re-rendering with the new value (React Native fires the callback
  // when the controlled `value` prop changes on iOS).
  const justSelectedRef = useRef(false);

  // Fetch nearby courses on mount if location available
  useEffect(() => {
    if (userLocation) {
      searchCoursesNearby(userLocation.latitude, userLocation.longitude, 30, 8)
        .then((courses) => setNearbyCourses(courses ?? []))
        .catch(() => {});
    }
  }, [userLocation?.latitude, userLocation?.longitude]);

  const handleChange = useCallback((text: string) => {
    // After selecting a course, the controlled TextInput re-renders with the
    // full course name which can re-fire onChangeText on iOS.  Ignore that
    // synthetic event so we don't overwrite the selection or re-open the dropdown.
    if (justSelectedRef.current) {
      justSelectedRef.current = false;
      return;
    }

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
    // Cancel any pending search so it doesn't overwrite after selection
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    justSelectedRef.current = true;
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
      // No holes data available -- will fall back to default par
    }

    onSelectCourse(course, holes);
  }, [onChangeText, onSelectCourse]);

  // Determine which list to show
  const displayResults = results.length > 0 ? results : (value.trim().length < 2 ? nearbyCourses : []);
  const isShowingNearby = results.length === 0 && value.trim().length < 2 && nearbyCourses.length > 0;

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
        onFocus={() => setShowResults(true)}
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

      {showResults && (displayResults.length > 0 || loading || (value.trim().length >= 2 && results.length === 0)) && (
        <View
          style={{
            backgroundColor: theme.colors.surfaceElevated,
            borderWidth: 1,
            borderColor: theme.colors.surfaceBorder,
            borderRadius: theme.radius.md,
            marginTop: 4,
            maxHeight: 260,
            overflow: 'hidden',
          }}
        >
          {loading ? (
            <View style={{ padding: 16, alignItems: 'center' }}>
              <ActivityIndicator color={theme.colors.primary} size="small" />
            </View>
          ) : displayResults.length === 0 && value.trim().length >= 2 ? (
            <View style={{ padding: 16, alignItems: 'center' }}>
              <Text style={{ color: theme.colors.textTertiary, fontSize: 13 }}>
                No courses found
              </Text>
              {onRequestAddCourse && (
                <Pressable
                  onPress={onRequestAddCourse}
                  style={({ pressed }) => ({
                    marginTop: 10,
                    paddingVertical: 8,
                    paddingHorizontal: 16,
                    backgroundColor: pressed ? theme.colors.surface : theme.colors.surfaceElevated,
                    borderRadius: theme.radius.sm,
                    borderWidth: 1,
                    borderColor: theme.colors.primary,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                  })}
                >
                  <Plus size={14} color={theme.colors.primary} />
                  <Text style={{ color: theme.colors.primary, fontSize: 13, fontWeight: '600' }}>
                    Add missing course
                  </Text>
                </Pressable>
              )}
            </View>
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              {isShowingNearby && (
                <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 }}>
                  <Text style={{ color: theme.colors.textTertiary, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    Nearby courses
                  </Text>
                </View>
              )}
              {displayResults.map((item) => (
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
              {!isShowingNearby && value.trim().length >= 2 && onRequestAddCourse && (
                <Pressable
                  onPress={onRequestAddCourse}
                  style={({ pressed }) => ({
                    padding: 12,
                    backgroundColor: pressed ? theme.colors.surface : 'transparent',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                  })}
                >
                  <Plus size={16} color={theme.colors.primary} />
                  <Text style={{ color: theme.colors.primary, fontSize: 14, fontWeight: '500' }}>
                    Can't find your course? Add it
                  </Text>
                </Pressable>
              )}
            </ScrollView>
          )}
        </View>
      )}
    </View>
  );
}
