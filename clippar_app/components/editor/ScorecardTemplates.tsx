/**
 * The reel's scorecard designs — the picker's swatches and the preview card
 * variants. Native (ShotDetectorModule.swift) burns the same designs in; the
 * palettes here are the SOURCE the Swift hand-port follows (5 Sep).
 */
import { View, Text } from 'react-native';
import type { ScorecardTemplate } from '@/modules/shot-detector';

export interface TemplateMeta {
  key: Exclude<ScorecardTemplate, 'training'>;
  name: string;
  blurb: string;
}

export const SCORECARD_TEMPLATES: TemplateMeta[] = [
  { key: 'classic', name: 'Classic', blurb: 'The Clippar card' },
  { key: 'minimal', name: 'Minimal', blurb: 'Just the words' },
  { key: 'euro', name: 'Tour', blurb: 'Clean, white, circles & squares' },
  { key: 'pga', name: 'Broadcast', blurb: 'Navy and gold' },
  { key: 'masters', name: 'Augusta', blurb: 'Green header, your name' },
];

/** Palettes shared by the preview card variants (and hand-ported to Swift). */
export const TEMPLATE_PALETTE = {
  euro: { card: 'rgba(255,255,255,0.94)', text: '#0B2A4A', dim: 'rgba(11,42,74,0.55)', accent: '#0B2A4A', line: 'rgba(11,42,74,0.15)' },
  pga: { card: 'rgba(11,31,58,0.94)', text: '#FFFFFF', dim: 'rgba(255,255,255,0.6)', accent: '#E0B84C', under: '#E8573F', over: '#4C8DE0', line: 'rgba(255,255,255,0.12)' },
  masters: { header: '#0F5C2E', cream: '#F6EFD9', card: 'rgba(255,255,255,0.96)', text: '#123B22', dim: 'rgba(18,59,34,0.55)', under: '#C8102E', over: '#0F5C2E', accent: '#F2C94C', line: 'rgba(18,59,34,0.12)' },
} as const;

/** Small swatch for the picker row. */
export function TemplateSwatch({ template, selected }: { template: TemplateMeta['key']; selected: boolean }) {
  const border = selected ? '#4CAF50' : 'rgba(255,255,255,0.14)';
  const box = { width: 108, height: 62, borderRadius: 10, borderWidth: 2, borderColor: border, overflow: 'hidden' as const };
  if (template === 'minimal') {
    return (
      <View style={[box, { backgroundColor: '#1a1a1f', justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ color: '#fff', fontSize: 11, fontFamily: 'Georgia-Bold', letterSpacing: 1 }}>HOLE 7 · PAR 4</Text>
        <Text style={{ color: '#4CAF50', fontSize: 12, fontFamily: 'Georgia-Bold', marginTop: 2 }}>Birdie</Text>
      </View>
    );
  }
  if (template === 'euro') {
    const p = TEMPLATE_PALETTE.euro;
    return (
      <View style={[box, { backgroundColor: '#e9edf2', padding: 6 }]}>
        <Text style={{ color: p.text, fontSize: 8, fontWeight: '800' }}>H. COWARD</Text>
        <View style={{ flexDirection: 'row', gap: 4, marginTop: 6 }}>
          {['4', '3', '5', '4'].map((n, i) => (
            <View key={i} style={{ width: 16, height: 16, borderRadius: i === 1 ? 8 : 3, borderWidth: i === 1 || i === 2 ? 1.5 : 0, borderColor: p.accent, justifyContent: 'center', alignItems: 'center' }}>
              <Text style={{ color: p.text, fontSize: 8, fontWeight: '800' }}>{n}</Text>
            </View>
          ))}
        </View>
      </View>
    );
  }
  if (template === 'pga') {
    const p = TEMPLATE_PALETTE.pga;
    return (
      <View style={[box, { backgroundColor: '#0B1F3A', padding: 6 }]}>
        <Text style={{ color: p.accent, fontSize: 8, fontWeight: '800' }}>COWARD</Text>
        <View style={{ flexDirection: 'row', gap: 4, marginTop: 6 }}>
          {['4', '3', '5', '4'].map((n, i) => (
            <View key={i} style={{ width: 16, height: 16, borderRadius: i === 1 ? 8 : 3, borderWidth: i === 1 || i === 2 ? 1.5 : 0, borderColor: i === 1 ? p.under : p.over, justifyContent: 'center', alignItems: 'center' }}>
              <Text style={{ color: '#fff', fontSize: 8, fontWeight: '800' }}>{n}</Text>
            </View>
          ))}
        </View>
      </View>
    );
  }
  if (template === 'masters') {
    const p = TEMPLATE_PALETTE.masters;
    return (
      <View style={[box, { backgroundColor: '#f4f1e8' }]}>
        <View style={{ backgroundColor: p.header, paddingHorizontal: 6, paddingVertical: 4 }}>
          <Text style={{ color: p.cream, fontSize: 8, fontFamily: 'Georgia-Bold' }}>Henry Coward</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 6, padding: 6 }}>
          {[['4', p.text], ['3', p.under], ['5', p.over], ['4', p.text]].map(([n, c], i) => (
            <Text key={i} style={{ color: c as string, fontSize: 10, fontFamily: 'Georgia-Bold' }}>{n}</Text>
          ))}
        </View>
      </View>
    );
  }
  return (
    <View style={[box, { backgroundColor: 'rgba(0,0,0,0.8)', padding: 6 }]}>
      <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 8, fontWeight: '600' }}>Royal Queensland</Text>
      <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
        {[['4', '#fff'], ['3', '#4CAF50'], ['5', '#FF9800'], ['4', '#fff']].map(([n, c], i) => (
          <Text key={i} style={{ color: c, fontSize: 10, fontWeight: '800' }}>{n}</Text>
        ))}
      </View>
    </View>
  );
}
