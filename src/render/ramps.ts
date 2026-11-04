/**
 * Colour ramps and legend metadata.
 *
 * Ramps are stored as stop lists so the same definition can drive both the
 * shader (via a 1D LUT texture) and the HUD colourbar, keeping the legend and
 * the rendered field in exact agreement.
 */

import type { ScalarFieldId } from '../core/levels';

export interface ColorStop {
  /** Normalised position along the ramp, 0..1. */
  t: number;
  /** sRGB hex colour. */
  color: string;
}

export type RampId =
  | 'wind'
  | 'temperature'
  | 'geopotential'
  | 'humidity'
  | 'cloud'
  | 'omega';

export const RAMPS: Record<RampId, { stops: ColorStop[]; label: string; unit: string }> = {
  /** Meteorological wind scale: cyan-blue -> green -> yellow -> red -> magenta-white. */
  wind: {
    label: '风速',
    unit: 'm/s',
    stops: [
      { t: 0, color: '#0b1f3a' },
      { t: 0.12, color: '#0e5c8a' },
      { t: 0.28, color: '#22d3ee' },
      { t: 0.44, color: '#34d399' },
      { t: 0.58, color: '#fde047' },
      { t: 0.72, color: '#fb923c' },
      { t: 0.86, color: '#ef4444' },
      { t: 1, color: '#f5d0fe' },
    ],
  },
  /** Temperature: deep violet cold -> ice blue -> green -> amber -> dark red hot. */
  temperature: {
    label: '温度',
    unit: '°C',
    stops: [
      { t: 0, color: '#4c1d95' },
      { t: 0.18, color: '#3b82f6' },
      { t: 0.36, color: '#22d3ee' },
      { t: 0.52, color: '#34d399' },
      { t: 0.68, color: '#facc15' },
      { t: 0.84, color: '#f97316' },
      { t: 1, color: '#991b1b' },
    ],
  },
  geopotential: {
    label: '位势高度',
    unit: 'gpm',
    stops: [
      { t: 0, color: '#0c1a2b' },
      { t: 0.22, color: '#1d4ed8' },
      { t: 0.42, color: '#0ea5e9' },
      { t: 0.6, color: '#22d3ee' },
      { t: 0.76, color: '#a7f3d0' },
      { t: 0.9, color: '#fef3c7' },
      { t: 1, color: '#fcd34d' },
    ],
  },
  humidity: {
    label: '相对湿度',
    unit: '%',
    stops: [
      { t: 0, color: '#1c1917' },
      { t: 0.3, color: '#0e7490' },
      { t: 0.55, color: '#0891b2' },
      { t: 0.75, color: '#38bdf8' },
      { t: 0.9, color: '#bae6fd' },
      { t: 1, color: '#f0f9ff' },
    ],
  },
  cloud: {
    label: '云量',
    unit: '%',
    stops: [
      { t: 0, color: '#04121f' },
      { t: 0.35, color: '#1e3a5f' },
      { t: 0.6, color: '#475569' },
      { t: 0.8, color: '#94a3b8' },
      { t: 1, color: '#f1f5f9' },
    ],
  },
  omega: {
    label: '垂直速度',
    unit: 'Pa/s',
    stops: [
      { t: 0, color: '#1e1b4b' },
      { t: 0.3, color: '#2563eb' },
      { t: 0.49, color: '#0f172a' },
      { t: 0.5, color: '#0f172a' },
      { t: 0.62, color: '#d97706' },
      { t: 0.8, color: '#ea580c' },
      { t: 1, color: '#7c2d12' },
    ],
  },
};

export function rampForScalar(scalarId: ScalarFieldId): RampId {
  switch (scalarId) {
    case 'temperature':
      return 'temperature';
    case 'wind_speed':
      return 'wind';
    case 'geopotential_height':
      return 'geopotential';
    case 'relative_humidity':
      return 'humidity';
    case 'cloud_cover':
      return 'cloud';
    case 'vertical_velocity':
      return 'omega';
    default:
      return 'wind';
  }
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const value = Number.parseInt(clean, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${((1 << 24) | (clamp(r) << 16) | (clamp(g) << 8) | clamp(b)).toString(16).slice(1)}`;
}

/** Sample a ramp at t in [0,1], returning sRGB 0-255 triplets. */
export function sampleRamp(stops: ColorStop[], t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));

  let lo = stops[0];
  let hi = stops[stops.length - 1];

  for (let i = 0; i < stops.length - 1; i += 1) {
    if (clamped >= stops[i].t && clamped <= stops[i + 1].t) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }

  const span = hi.t - lo.t || 1;
  const local = (clamped - lo.t) / span;
  const a = hexToRgb(lo.color);
  const b = hexToRgb(hi.color);

  return [
    a[0] + (b[0] - a[0]) * local,
    a[1] + (b[1] - a[1]) * local,
    a[2] + (b[2] - a[2]) * local,
  ];
}

/**
 * Build a 256x1 RGBA LUT for the GPU. Alpha is left at 255; opacity is applied
 * in the shader so the same LUT serves the heat layer and the particle layer.
 */
export function buildLut(stops: ColorStop[], size = 256): Uint8Array {
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i += 1) {
    const [r, g, b] = sampleRamp(stops, i / (size - 1));
    data[i * 4] = Math.round(r);
    data[i * 4 + 1] = Math.round(g);
    data[i * 4 + 2] = Math.round(b);
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** CSS gradient string for the HUD colourbar. */
export function cssGradient(stops: ColorStop[]): string {
  const parts = stops.map(
    (s) => `${s.color} ${(s.t * 100).toFixed(2)}%`,
  );
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

/** Human-readable tick values for a colourbar spanning [min, max]. */
export function rampTicks(
  min: number,
  max: number,
  count = 5,
  decimals = 0,
): { t: number; label: string }[] {
  const ticks: { t: number; label: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    const value = min + (max - min) * t;
    ticks.push({ t, label: value.toFixed(decimals) });
  }
  return ticks;
}
