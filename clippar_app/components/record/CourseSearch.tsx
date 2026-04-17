import { useState, useCallback, useRef, useEffect } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { MapPin, Plus, Globe } from 'lucide-react-native';
import { theme } from '@/constants/theme';
import { searchCourses, searchCoursesNearby, getCourseHoles, upsertCourseFromLiveApi } from '@/lib/api';
import { searchGolfCoursesLive, getGolfCourseDetailLive } from '@/lib/golfCourseApi';
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
  // Guard: after a course is selected, ignore onChangeText events for 500ms.
  // React Native on iOS can fire the callback multiple times when the controlled
  // `value` prop changes, and a simple boolean flag gets reset too early.
  // A timestamp approach ignores ALL synthetic change events in the window.
  const justSelectedRef = useRef<number>(0);

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
    // full course name which can re-fire onChangeText on iOS (sometimes more
    // than once).  Ignore ALL synthetic events within 500ms of a selection so
    // we don't overwrite the selection or re-open the dropdown.
    if (Date.now() - justSelectedRef.current < 500) {
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
        // Search BOTH live API and local Supabase in parallel
        const [liveResults, localResults] = await Promise.all([
          searchGolfCoursesLive(text.trim()),
          searchCourses(text.trim()),
        ]);

        // Merge: start with live results, then add unique local results
        const merged: any[] = liveResults.map((lr) => ({
          ...lr,
          // Normalize live result fields to match the shape expected by the UI
          location_name: lr.city,
          par_total: null,
          _source: 'live' as const,
          _liveId: lr.id, // preserve the API id for detail fetch
        }));

        const liveNames = new Set(liveResults.map((r) => r.name.toLowerCase()));
        for (const local of localResults) {
          if (!liveNames.has(local.name.toLowerCase())) {
            merged.push({ ...local, _source: 'local' as const });
          }
        }

        setResults(merged);
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
    justSelectedRef.current = Date.now();
    onChangeText(course.name);
    setShowResults(false);
    setResults([]);

    setLoading(true);
    try {
      let holes: HoleData[] = [];
      let supabaseCourseId = course.id;
      let parTotal = course.par_total || null;

      if (course._source === 'live' && course._liveId) {
        // Fetch full detail from live API for hole-by-hole data
        const detail = await getGolfCourseDetailLive(course._liveId);

        if (detail && detail.tees.length > 0) {
          // Pick the best tee set (prefer blue/white/men/regular, or first)
          const tee =
            detail.tees.find((t) => /blue|white|men|regular/i.test(t.name)) ||
            detail.tees[0];
          holes = tee.holes.map((h) => ({
            holeNumber: h.number,
            par: h.par,
            strokeIndex: h.handicap,
            lengthMeters: h.metres,
          }));
        }

        parTotal = holes.reduce((sum, h) => sum + h.par, 0) || parTotal;

        // Upsert into Supabase cache (fire-and-forget for speed, but await
        // just long enough to get the Supabase UUID back for the round FK)
        try {
          const cached = await upsertCourseFromLiveApi(
            {
              id: course._liveId,
              name: course.name,
              city: course.city,
              state: course.state,
              country: course.country || 'AU',
              holes: course.holes,
              latitude: course.latitude,
              longitude: course.longitude,
            },
            holes.length > 0
              ? holes.map((h) => ({
                  number: h.holeNumber,
                  par: h.par,
                  handicap: h.strokeIndex,
                  metres: h.lengthMeters,
                }))
              : undefined,
          );
          if (cached?.id) {
            supabaseCourseId = cached.id;
          }
        } catch {
          // Cache write failed -- not critical, we still have the data
        }
      } else {
        // Local course -- fetch holes from Supabase
        try {
          const holesData = await getCourseHoles(course.id);
          holes = (holesData ?? []).map((h: any) => ({
            holeNumber: h.hole_number,
            par: h.par,
            strokeIndex: h.stroke_index,
            lengthMeters: h.length_meters,
          }));
          parTotal = holes.reduce((sum, h) => sum + h.par, 0) || parTotal;
        } catch {
          // No holes data available -- will fall back to default par
        }
      }

      onSelectCourse(
        { id: supabaseCourseId, name: course.name, par_total: parTotal },
        holes,
      );
    } catch (err) {
      console.warn('[CourseSearch] Select error:', err);
      // Fallback: just pass the course with no hole data
      onSelectCourse(
        { id: course.id, name: course.name, par_total: course.par_total || null },
        [],
      );
    } finally {
      setLoading(false);
    }

    justSelectedRef.current = Date.now();
  }, [onChangeText, onSelectCourse]);

  // Auto-select top result when user blurs without explicitly selecting
  const handleBlur = useCallback(() => {
    setTimeout(() => {
      // If the guard just fired (user tapped a result), skip
      if (Date.now() - justSelectedRef.current < 500) return;

      // If there are search results and the user typed something, auto-select the first match
      if (results.length > 0 && value.trim().length >= 2) {
        const exactMatch = results.find(
          (r: any) => r.name.toLowerCase() === value.trim().toLowerCase()
        );
        const topResult = exactMatch ?? results[0];
        handleSelect(topResult);
        return;
      }

      setShowResults(false);
    }, 250);
  }, [results, value, handleSelect]);

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
        onBlur={handleBlur}
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
              {displayResults.map((item, index) => (
                <Pressable
                  key={`${item._source ?? 'local'}-${item.id ?? index}`}
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
                  {item._source === 'live' ? (
                    <Globe size={16} color={theme.colors.primary} />
                  ) : (
                    <MapPin size={16} color={theme.colors.textTertiary} />
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: '500' }}>
                      {item.name}
                    </Text>
                    {(item.location_name || item.city || item.state) && (
                      <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                        {[item.location_name || item.city, item.state].filter(Boolean).join(', ')}
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
