import { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Modal,
  FlatList,
  StyleSheet,
} from 'react-native';
import { ChevronDown, MapPin, Flag, Check, Film, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '@/constants/theme';
import type {
  CourseOption,
  StatsFilters,
  Timeframe,
} from '@/hooks/useStatsFilter';

// ---- Constants ----

const TIMEFRAMES: { key: Timeframe; label: string }[] = [
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
  { key: '90d', label: '90 Days' },
  { key: '1y', label: '1 Year' },
  { key: 'all', label: 'All Time' },
];

// ---- Pill primitive ----

interface PillProps {
  label: string;
  active?: boolean;
  onPress: () => void;
  icon?: React.ReactNode;
}

function Pill({ label, active, onPress, icon }: PillProps) {
  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      style={[styles.pill, active ? styles.pillActive : styles.pillInactive]}
    >
      {icon}
      <Text
        style={[
          styles.pillLabel,
          { color: active ? '#FFFFFF' : theme.colors.textSecondary },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// ---- Bottom-sheet style picker modal ----

interface PickerModalProps<T> {
  visible: boolean;
  title: string;
  onDismiss: () => void;
  options: { value: T; label: string }[];
  selected: T | null;
  onSelect: (value: T | null) => void;
  allLabel?: string;
}

function PickerModal<T>({
  visible,
  title,
  onDismiss,
  options,
  selected,
  onSelect,
  allLabel = 'Any',
}: PickerModalProps<T>) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onDismiss}
    >
      <Pressable style={styles.modalBackdrop} onPress={onDismiss}>
        <Pressable style={styles.modalSheet}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{title}</Text>
            <Pressable onPress={onDismiss} style={styles.modalClose}>
              <X size={18} color={theme.colors.textSecondary} />
            </Pressable>
          </View>
          <FlatList
            data={[{ value: null as T | null, label: allLabel }, ...options]}
            keyExtractor={(item, idx) =>
              item.value == null ? '__any__' : String(item.value) + idx
            }
            renderItem={({ item }) => {
              const isActive =
                (item.value == null && selected == null) ||
                (item.value != null && item.value === selected);
              return (
                <Pressable
                  onPress={() => {
                    Haptics.selectionAsync();
                    onSelect(item.value);
                    onDismiss();
                  }}
                  style={styles.modalRow}
                >
                  <Text
                    style={[
                      styles.modalRowLabel,
                      {
                        color: isActive
                          ? theme.colors.primary
                          : theme.colors.textPrimary,
                        fontWeight: isActive ? '700' : '500',
                      },
                    ]}
                  >
                    {item.label}
                  </Text>
                  {isActive && <Check size={18} color={theme.colors.primary} />}
                </Pressable>
              );
            }}
            ItemSeparatorComponent={() => <View style={styles.modalDivider} />}
            style={{ maxHeight: 420 }}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ---- Main filter bar ----

interface StatsFilterBarProps {
  filters: StatsFilters;
  courses: CourseOption[];
  onTimeframe: (t: Timeframe) => void;
  onCourse: (id: string | null) => void;
  onHole: (h: number | null) => void;
  onClipsOnly: (b: boolean) => void;
}

export function StatsFilterBar({
  filters,
  courses,
  onTimeframe,
  onCourse,
  onHole,
  onClipsOnly,
}: StatsFilterBarProps) {
  const [courseOpen, setCourseOpen] = useState(false);
  const [holeOpen, setHoleOpen] = useState(false);

  const selectedCourseName =
    courses.find((c) => c.id === filters.courseId)?.name ?? 'Any Course';
  const selectedHoleLabel =
    filters.hole == null ? 'Any Hole' : `Hole ${filters.hole}`;

  return (
    <View style={styles.container}>
      {/* Row 1: Course + Hole + Clips toggle (pill row) */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        style={styles.scrollRow}
      >
        <Pill
          label={selectedCourseName}
          active={filters.courseId != null}
          onPress={() => setCourseOpen(true)}
          icon={
            <MapPin
              size={14}
              color={
                filters.courseId != null ? '#FFFFFF' : theme.colors.textSecondary
              }
            />
          }
        />
        <Pill
          label={selectedHoleLabel}
          active={filters.hole != null}
          onPress={() => setHoleOpen(true)}
          icon={
            <Flag
              size={14}
              color={
                filters.hole != null ? '#FFFFFF' : theme.colors.textSecondary
              }
            />
          }
        />
        <Pill
          label={filters.clipsOnly ? 'With Clips' : 'Any'}
          active={filters.clipsOnly}
          onPress={() => onClipsOnly(!filters.clipsOnly)}
          icon={
            <Film
              size={14}
              color={
                filters.clipsOnly ? '#FFFFFF' : theme.colors.textSecondary
              }
            />
          }
        />
      </ScrollView>

      {/* Row 2: Timeframe chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        style={styles.scrollRow}
      >
        {TIMEFRAMES.map((t) => (
          <Pill
            key={t.key}
            label={t.label}
            active={filters.timeframe === t.key}
            onPress={() => onTimeframe(t.key)}
          />
        ))}
      </ScrollView>

      {/* Course picker */}
      <PickerModal<string>
        visible={courseOpen}
        title="Course"
        onDismiss={() => setCourseOpen(false)}
        options={courses.map((c) => ({ value: c.id, label: c.name }))}
        selected={filters.courseId}
        onSelect={onCourse}
        allLabel="Any Course"
      />

      {/* Hole picker */}
      <PickerModal<number>
        visible={holeOpen}
        title="Hole"
        onDismiss={() => setHoleOpen(false)}
        options={Array.from({ length: 18 }, (_, i) => ({
          value: i + 1,
          label: `Hole ${i + 1}`,
        }))}
        selected={filters.hole}
        onSelect={onHole}
        allLabel="Any Hole"
      />
    </View>
  );
}

// Export for use elsewhere (dropdown icon indicator)
export { ChevronDown };

// ---- Styles ----

const styles = StyleSheet.create({
  container: {
    marginBottom: 8,
  },
  scrollRow: {
    marginBottom: 8,
  },
  scrollContent: {
    paddingHorizontal: 16,
    gap: 8,
    alignItems: 'center',
  },
  pill: {
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    borderRadius: theme.radius.full,
    borderWidth: 1,
  },
  pillActive: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  pillInactive: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.surfaceBorder,
  },
  pillLabel: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
  // Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: theme.colors.surfaceElevated,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: 32,
    borderTopWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  modalTitle: {
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  modalClose: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: theme.colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  modalRowLabel: {
    fontSize: 15,
  },
  modalDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.surfaceBorder,
    marginHorizontal: 20,
  },
});
