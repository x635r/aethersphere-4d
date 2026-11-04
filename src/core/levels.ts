/**
 * Canonical pressure levels supported by the Open-Meteo forecast API.
 * Every one of these accepts the suffixes documented in PRESSURE_VARIABLES.
 *
 * Verified against https://api.open-meteo.com/v1/forecast — the field names are
 * case-sensitive and must be spelled exactly as `${variable}_${level}hPa`.
 */
export const PRESSURE_LEVELS = [
  1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150,
  100, 70, 50, 30,
] as const;

export type PressureLevel = (typeof PRESSURE_LEVELS)[number];

/** Levels exposed in the Altitude Elevator, keyed to a standard-atmosphere height. */
export const ELEVATOR_LEVELS = [
  { level: 'surface' as const, label: 'Surface', altitude: 0, note: '地面层' },
  { level: 925, label: '925 hPa', altitude: 800, note: '低层' },
  { level: 850, label: '850 hPa', altitude: 1500, note: '低对流层' },
  { level: 700, label: '700 hPa', altitude: 3000, note: '中低层' },
  { level: 500, label: '500 hPa', altitude: 5500, note: '中层' },
  { level: 300, label: '300 hPa', altitude: 9100, note: '急流层' },
  { level: 200, label: '200 hPa', altitude: 11800, note: '对流层顶' },
  { level: 100, label: '100 hPa', altitude: 16200, note: '平流层' },
  { level: 30, label: '30 hPa', altitude: 24000, note: '平流层顶' },
] as const;

export type ElevatorLevel = (typeof ELEVATOR_LEVELS)[number]['level'];

export const SURFACE = 'surface' as const;

/**
 * Approximate standard-atmosphere altitude (metres, ICAO) for each selectable
 * level. Used for labels and for the vertical placement hint in the HUD.
 */
export const LEVEL_ALTITUDE_M: Record<number, number> = {
  1000: 110,
  975: 320,
  950: 540,
  925: 770,
  900: 990,
  850: 1460,
  800: 1950,
  700: 3010,
  600: 4360,
  500: 5570,
  400: 7180,
  300: 9160,
  250: 10360,
  200: 11780,
  150: 13580,
  100: 16200,
  70: 18400,
  50: 20500,
  30: 23800,
};

export const LEVEL_NAMES: Record<number, string> = {
  1000: '近地面',
  975: '低层',
  950: '低层',
  925: '低层',
  900: '低层',
  850: '低对流层',
  800: '低对流层',
  700: '中低层',
  600: '中层',
  500: '中层',
  400: '中高层',
  300: '急流层',
  250: '急流层',
  200: '对流层顶',
  150: '上对流层',
  100: '平流层',
  70: '平流层',
  50: '平流层',
  30: '平流层顶',
};

/** The six vertical "circles" of the layer matrix dock. */
export const MATRIX_GROUPS = [
  {
    id: 'L1',
    title: '海洋与涌浪',
    subtitle: 'Ocean & Swell',
  },
  {
    id: 'L2',
    title: '雷达与大气化学',
    subtitle: 'Radar & Chemistry',
  },
  {
    id: 'L3',
    title: '对流层动力',
    subtitle: 'Tropospheric Dynamics',
  },
  {
    id: 'L4',
    title: '航空危险气象',
    subtitle: 'Aviation Hazards',
  },
  {
    id: 'L5',
    title: '平流层与极涡',
    subtitle: 'Stratosphere & Polar Vortex',
  },
  {
    id: 'L6',
    title: '空间天气与极光',
    subtitle: 'Space Weather & Aurora',
  },
] as const;

export type MatrixGroupId = (typeof MATRIX_GROUPS)[number]['id'];

export const MATRIX_GROUP_IDS = MATRIX_GROUPS.map((g) => g.id);

/**
 * Scalar fields the engine can render as a heat layer. Wind is separate: it
 * drives the particle layer and always ships alongside a scalar.
 */
export const SCALAR_FIELDS = [
  { id: 'wind_speed', label: '风速', unit: 'm/s', palette: 'wind' },
  { id: 'temperature', label: '温度', unit: '°C', palette: 'temperature' },
  {
    id: 'geopotential_height',
    label: '位势高度',
    unit: 'gpm',
    palette: 'geopotential',
  },
  {
    id: 'relative_humidity',
    label: '相对湿度',
    unit: '%',
    palette: 'humidity',
  },
  { id: 'cloud_cover', label: '云量', unit: '%', palette: 'cloud' },
  {
    id: 'vertical_velocity',
    label: '垂直速度',
    unit: 'Pa/s',
    palette: 'omega',
  },
] as const;

export type ScalarFieldId = (typeof SCALAR_FIELDS)[number]['id'];

export const SCALAR_FIELD_IDS = SCALAR_FIELDS.map((f) => f.id);

export function scalarFieldMeta(id: ScalarFieldId) {
  return SCALAR_FIELDS.find((f) => f.id === id) ?? SCALAR_FIELDS[0];
}
