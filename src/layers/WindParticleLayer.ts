/**
 * WindParticleLayer — a MapLibre custom layer that renders an animated wind
 * flow field over a scalar heat field, in both globe and mercator projections.
 *
 * ## Why it is built this way
 *
 * MapLibre's custom-layer contract only guarantees `u_projection_matrix`, which
 * is enough for mercator but wrong for globe. In globe mode it additionally
 * supplies `args.defaultProjectionData` and `args.shaderData.vertexShaderPrelude`;
 * that prelude contains MapLibre's own `projectTile`, `projectToSphere`,
 * `interpolateProjection` and horizon-clipping maths.
 *
 * Reusing the prelude rather than hand-rolling a sphere transform is what keeps
 * this layer welded to the basemap through the mercator<->globe animation, and
 * correctly clipped at the horizon. For custom layers MapLibre scales the
 * matrices so `projectTile` expects normalised web-mercator coordinates in
 * [0, 1] — which is exactly what both passes feed it.
 *
 * The prelude is only available inside `render()` and changes with the
 * projection, so programs are compiled lazily and keyed on
 * `shaderData.variantName`.
 *
 * ## Why the heat pass uses a mesh
 *
 * Projecting four corners of a quad onto a sphere yields a flat chord, not an
 * arc. A dense lon/lat mesh keeps the limb round. Particles are projected
 * per-vertex and need no tessellation.
 *
 * ## Why streaks are stateless
 *
 * Each particle derives its position from its id and the clock, then draws one
 * short line along the local wind. No per-frame CPU work, no particle state
 * buffer, and no smearing when the globe rotates.
 */

import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from 'maplibre-gl';
import type { WeatherFieldSet } from '../core/types';
import { buildLut, rampForScalar, RAMPS, type RampId } from '../render/ramps';

export const PARTICLE_COUNT_MIN = 15_000;
export const PARTICLE_COUNT_MAX = 60_000;
export const PARTICLE_COUNT_DEFAULT = 24_000;

export interface ParticleLayerOptions {
  particleCount?: number;
  heatOpacity?: number;
  streakOpacity?: number;
}

/** Mesh density for the heat field; dense enough that the sphere limb is round. */
const HEAT_MESH_COLS = 160;
const HEAT_MESH_ROWS = 80;

interface GPUState {
  gl: WebGL2RenderingContext;
  fieldTexture: WebGLTexture;
  uTexture: WebGLTexture;
  vTexture: WebGLTexture;
  lutTexture: WebGLTexture;
  heatVao: WebGLVertexArrayObject | null;
  heatVertexBuffer: WebGLBuffer | null;
  heatIndexBuffer: WebGLBuffer | null;
  heatIndexCount: number;
  heatMeshCols: number;
  /** Mercator-y of the mesh's north and south edges. */
  mercYBounds: [number, number];
  streakVao: WebGLVertexArrayObject | null;
  streakBuffer: WebGLBuffer | null;
  programKey: string;
  heatProgram: WebGLProgram | null;
  streakProgram: WebGLProgram | null;
  heatUniforms: Map<string, WebGLUniformLocation | null>;
  streakUniforms: Map<string, WebGLUniformLocation | null>;
}

/* ------------------------------------------------------------------ */
/* Shader sources                                                      */
/* ------------------------------------------------------------------ */

function heatVertexSource(prelude: string, define: string): string {
  return `#version 300 es
precision highp float;
${prelude}
${define}
in vec2 a_pos;
out vec2 v_merc;
void main() {
  v_merc = a_pos;
  gl_Position = projectTile(a_pos);
}`;
}

const HEAT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_merc;
out vec4 fragColor;

uniform sampler2D u_field;
uniform sampler2D u_lut;
uniform float u_opacity;
// Mercator-y bounds of the mesh (north/south edges), so the field texture maps
// exactly onto the latitude band the data covers.
uniform vec2 u_mercYBounds;

void main() {
  // Longitude wraps across the seam. For latitude, the field texture stores the
  // southernmost grid row first (v = 0) and the northernmost last (v = 1),
  // while mercator y grows southward, so the mapping is inverted:
  //   north edge (small mercY) -> v = 1,  south edge (large mercY) -> v = 0
  float yNorth = min(u_mercYBounds.x, u_mercYBounds.y);
  float ySouth = max(u_mercYBounds.x, u_mercYBounds.y);
  float mercY = clamp(v_merc.y, yNorth, ySouth);
  float vFrac = (ySouth - mercY) / max(1e-6, ySouth - yNorth);

  vec2 uv = vec2(fract(v_merc.x), vFrac);
  float t = texture(u_field, uv).a;
  if (t <= 0.002) discard;

  vec3 color = texture(u_lut, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb;
  float alpha = u_opacity * smoothstep(0.002, 0.05, t);

  // Premultiplied alpha: MapLibre blends with (ONE, ONE_MINUS_SRC_ALPHA).
  fragColor = vec4(color * alpha, alpha);
}`;

function streakVertexSource(prelude: string, define: string): string {
  return `#version 300 es
precision highp float;
${prelude}
${define}

in vec2 a_seed;    // per-particle seed in [0,1)
in float a_phase;  // per-particle time offset in [0,1)
in float a_end;    // 0 = tail vertex, 1 = head vertex

uniform sampler2D u_u;
uniform sampler2D u_v;
uniform sampler2D u_field;
uniform float u_time;
uniform vec2 u_mercYBounds;
uniform float u_seedAlpha;   // global animation speed

out float v_scalar;

const int STEPS = 8;
const float PI = 3.141592653589793;

float uvV(float mercY, float y0, float y1) {
  return clamp((y1 - mercY) / max(1e-6, y1 - y0), 0.0, 1.0);
}

// Normalised wind direction/magnitude at a mercator position.
vec2 windAt(vec2 merc, float y0, float y1) {
  vec2 uv = vec2(fract(merc.x), uvV(merc.y, y0, y1));
  return vec2(texture(u_u, uv).r, texture(u_v, uv).r) * 2.0 - 1.0;
}

void main() {
  float y0 = min(u_mercYBounds.x, u_mercYBounds.y);
  float y1 = max(u_mercYBounds.x, u_mercYBounds.y);

  // Seed uniformly inside the data latitude band. Using mercator-y directly
  // would crowd every particle toward the poles, because mercator stretches
  // high latitudes; sampling by latitude and converting keeps density even.
  float lat = -85.0 + 170.0 * a_seed.y;
  float latRad = radians(lat);
  float mercYCandidate =
    (180.0 - (180.0 / PI) * log(tan(PI * 0.25 + latRad * 0.5))) / 360.0;
  vec2 base = vec2(a_seed.x, clamp(mercYCandidate, min(y0, y1), max(y0, y1)));

  // Each particle lives for one cycle of its own phase. At any instant it sits
  // somewhere along the streamline it has traced so far; the tail vertex is
  // that point and the head is displaced further downwind by a fixed distance.
  float lifeT = fract(a_phase + u_time * u_seedAlpha);
  float progress = mix(0.05, 1.0, lifeT);

  vec2 pos = base;
  const float stepLen = 0.0035;

  for (int i = 0; i < STEPS; i++) {
    if (float(i) >= floor(progress * float(STEPS))) break;
    vec2 w = windAt(pos, y0, y1);
    pos += w * stepLen;
    pos.y = clamp(pos.y, y0, y1);
    pos.x = fract(pos.x);
  }

  vec2 w2 = windAt(pos, y0, y1);
  float speed = length(w2);

  // Colour by the selected scalar so streaks agree with the heat layer and the
  // legend. The scalar rides in the field texture's alpha channel.
  v_scalar = texture(u_field, vec2(fract(pos.x), uvV(pos.y, y0, y1))).a;

  // Streak length scales with wind speed: fast air leaves a longer mark.
  // The minimum keeps every particle visible, so density stays even instead of
  // leaving the calm belts empty.
  float elongation = 0.010 + 0.022 * clamp(speed * 2.0, 0.0, 1.0);
  vec2 finalPos = pos + w2 * elongation * a_end;
  finalPos.y = clamp(finalPos.y, y0, y1);

  gl_Position = projectTile(vec2(fract(finalPos.x), finalPos.y));
}`;
}

const STREAK_FRAGMENT = `#version 300 es
precision highp float;
in float v_scalar;
out vec4 fragColor;
uniform sampler2D u_lut;
uniform float u_opacity;
void main() {
  vec3 color = texture(u_lut, vec2(clamp(v_scalar, 0.0, 1.0), 0.5)).rgb;
  // Lift toward white so streaks read as motion on top of the heat field rather
  // than as a duplicate of it.
  vec3 lit = mix(color, vec3(1.0), 0.55);
  float alpha = u_opacity * 0.85;
  fragColor = vec4(lit * alpha, alpha);
}`;

/* ------------------------------------------------------------------ */
/* Layer                                                               */
/* ------------------------------------------------------------------ */

export class WindParticleLayer implements CustomLayerInterface {
  readonly id = 'aether-wind-field';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private fieldSet: WeatherFieldSet | null = null;
  private map: MapLibreMap | null = null;
  private gpu: GPUState | null = null;

  private frameIndex = 0;
  private rampId: RampId = 'wind';
  private particleCount: number;

  private heatVisible = true;
  private streaksVisible = true;
  private heatOpacity: number;
  private streakOpacity: number;

  private startedAt = performance.now() / 1000;
  private rafId = 0;
  private lastRepaint = 0;

  constructor(options: ParticleLayerOptions = {}) {
    this.particleCount = Math.min(
      PARTICLE_COUNT_MAX,
      Math.max(PARTICLE_COUNT_MIN, options.particleCount ?? PARTICLE_COUNT_DEFAULT),
    );
    this.heatOpacity = options.heatOpacity ?? 0.52;
    this.streakOpacity = options.streakOpacity ?? 0.8;
  }

  /* ---------------- public API ---------------- */

  setFieldSet(fieldSet: WeatherFieldSet | null | undefined): void {
    if (!fieldSet) return;
    this.fieldSet = fieldSet;
    this.rampId = rampForScalar(fieldSet.scalarId);
    this.frameIndex = Math.min(this.frameIndex, Math.max(0, fieldSet.times.length - 1));

    if (this.gpu) {
      this.uploadField();
      this.uploadLut();
      this.map?.triggerRepaint();
    }
  }

  setFrameIndex(index: number): void {
    if (!this.fieldSet) return;
    const clamped = Math.max(0, Math.min(this.fieldSet.times.length - 1, index));
    if (clamped === this.frameIndex) return;
    this.frameIndex = clamped;
    if (this.gpu) {
      this.uploadField();
      this.map?.triggerRepaint();
    }
  }

  setHeatVisible(visible: boolean): void {
    this.heatVisible = visible;
    this.map?.triggerRepaint();
  }

  setStreaksVisible(visible: boolean): void {
    this.streaksVisible = visible;
    this.map?.triggerRepaint();
  }

  setHeatOpacity(value: number): void {
    this.heatOpacity = Math.max(0, Math.min(1, value));
    this.map?.triggerRepaint();
  }

  setStreakOpacity(value: number): void {
    this.streakOpacity = Math.max(0, Math.min(1, value));
    this.map?.triggerRepaint();
  }

  setParticleCount(count: number): void {
    const clamped = Math.min(
      PARTICLE_COUNT_MAX,
      Math.max(PARTICLE_COUNT_MIN, Math.round(count)),
    );
    if (clamped === this.particleCount) return;
    this.particleCount = clamped;
    if (this.gpu) {
      this.uploadStreaks(this.gpu);
      this.map?.triggerRepaint();
    }
  }

  get frameCount(): number {
    return this.fieldSet?.times.length ?? 0;
  }

  get hasData(): boolean {
    return this.fieldSet !== null;
  }

  /* ---------------- lifecycle ---------------- */

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;

    if (
      typeof WebGL2RenderingContext === 'undefined' ||
      !(gl instanceof WebGL2RenderingContext)
    ) {
      console.warn('[aether] WebGL2 required for the wind field; layer disabled.');
      return;
    }

    const gl2 = gl;

    const state: GPUState = {
      gl: gl2,
      fieldTexture: this.createTexture(gl2),
      uTexture: this.createTexture(gl2),
      vTexture: this.createTexture(gl2),
      lutTexture: this.createTexture(gl2),
      heatVao: null,
      heatVertexBuffer: null,
      heatIndexBuffer: null,
      heatIndexCount: 0,
      heatMeshCols: 0,
      mercYBounds: [0, 1],
      streakVao: null,
      streakBuffer: null,
      programKey: '',
      heatProgram: null,
      streakProgram: null,
      heatUniforms: new Map(),
      streakUniforms: new Map(),
    };

    this.gpu = state;

    this.buildHeatMesh(state);
    this.uploadStreaks(state);
    this.uploadField();
    this.uploadLut();

    // Drive animation at ~30fps independent of map interaction.
    const tick = () => {
      const now = performance.now();
      if (now - this.lastRepaint > 32) {
        this.lastRepaint = now;
        this.map?.triggerRepaint();
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  onRemove(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }

    const gpu = this.gpu;
    if (gpu) {
      const gl = gpu.gl;
      if (gpu.heatProgram) gl.deleteProgram(gpu.heatProgram);
      if (gpu.streakProgram) gl.deleteProgram(gpu.streakProgram);
      gl.deleteTexture(gpu.fieldTexture);
      gl.deleteTexture(gpu.uTexture);
      gl.deleteTexture(gpu.vTexture);
      gl.deleteTexture(gpu.lutTexture);
      if (gpu.heatVao) gl.deleteVertexArray(gpu.heatVao);
      if (gpu.heatVertexBuffer) gl.deleteBuffer(gpu.heatVertexBuffer);
      if (gpu.heatIndexBuffer) gl.deleteBuffer(gpu.heatIndexBuffer);
      if (gpu.streakVao) gl.deleteVertexArray(gpu.streakVao);
      if (gpu.streakBuffer) gl.deleteBuffer(gpu.streakBuffer);
    }

    this.gpu = null;
    this.map = null;
  }

  /* ---------------- resources ---------------- */

  private createTexture(gl: WebGL2RenderingContext): WebGLTexture {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]),
    );
    return tex;
  }

  /**
   * Lat/lon mesh in normalised web-mercator coordinates, handed straight to
   * `projectTile`.
   *
   * The mesh spans only the latitude range the weather grid actually covers
   * (±85°), not the full mercator square. Extending to the poles would make the
   * field texture stretch across the polar caps, where there is no data, and
   * would smear the top-most row into a visible pucker at the pole.
   */
  private buildHeatMesh(state: GPUState): void {
    const gl = state.gl;
    const cols = HEAT_MESH_COLS;
    const rows = HEAT_MESH_ROWS;

    // Mercator y for the grid's north/south edges, matching the worker lattice.
    const mercY = (lat: number) =>
      (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;

    const yNorth = mercY(85);
    const ySouth = mercY(-85);

    const positions = new Float32Array((cols + 1) * (rows + 1) * 2);
    let p = 0;
    for (let r = 0; r <= rows; r += 1) {
      // r = 0 is north (mercator y grows southward).
      const v = yNorth + (ySouth - yNorth) * (r / rows);
      for (let c = 0; c <= cols; c += 1) {
        positions[p] = c / cols;
        positions[p + 1] = v;
        p += 2;
      }
    }

    const indices = new Uint32Array(cols * rows * 6);
    let i = 0;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const a = r * (cols + 1) + c;
        const b = a + 1;
        const d = a + (cols + 1);
        const e = d + 1;
        indices[i] = a;
        indices[i + 1] = d;
        indices[i + 2] = b;
        indices[i + 3] = b;
        indices[i + 4] = d;
        indices[i + 5] = e;
        i += 6;
      }
    }

    const vao = state.heatVao ?? gl.createVertexArray();
    gl.bindVertexArray(vao);

    const vbo = state.heatVertexBuffer ?? gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const ibo = state.heatIndexBuffer ?? gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);

    state.heatVao = vao;
    state.heatVertexBuffer = vbo;
    state.heatIndexBuffer = ibo;
    state.heatIndexCount = indices.length;
    state.heatMeshCols = cols;
    state.mercYBounds = [yNorth, ySouth];
  }

  /** Two vertices per particle, interleaved as [seedX, seedY, phase, end]. */
  private uploadStreaks(state: GPUState): void {
    const gl = state.gl;
    const count = this.particleCount;

    const data = new Float32Array(count * 2 * 4);
    let o = 0;

    // Low-discrepancy sequence. A pure linear lattice (even a golden-ratio one)
    // leaves visible diagonal banding because consecutive values are correlated;
    // the R2 sequence decorrelates both axes while keeping the coverage even.
    const alphaX = 0.7548776662466927; // 1/phi2
    const alphaY = 0.5698402909980532; // 1/phi2^2

    for (let i = 0; i < count; i += 1) {
      const sx = (0.5 + alphaX * i) % 1;
      const sy = (0.5 + alphaY * i) % 1;
      // Phase is an independent third dimension of the same sequence.
      const phase = ((0.5 + 0.3183098861837907 * i * (1 + (i % 7) * 0.13)) % 1);

      data[o] = sx;
      data[o + 1] = sy;
      data[o + 2] = phase;
      data[o + 3] = 0;
      o += 4;

      data[o] = sx;
      data[o + 1] = sy;
      data[o + 2] = phase;
      data[o + 3] = 1;
      o += 4;
    }

    const vao = state.streakVao ?? gl.createVertexArray();
    gl.bindVertexArray(vao);

    const buffer = state.streakBuffer ?? gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    const stride = 16;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 12);

    gl.bindVertexArray(null);

    state.streakVao = vao;
    state.streakBuffer = buffer;
  }

  private uploadLut(): void {
    const gpu = this.gpu;
    if (!gpu) return;
    const gl = gpu.gl;

    const lut = buildLut(RAMPS[this.rampId].stops, 256);
    gl.bindTexture(gl.TEXTURE_2D, gpu.lutTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
  }

  /**
   * Pack the active frame into three textures: the normalised scalar in all
   * channels of `field` (alpha drives the ramp), and u/v components encoded as
   * `value / windRef * 0.5 + 0.5`.
   */
  private uploadField(): void {
    const gpu = this.gpu;
    const field = this.fieldSet;
    if (!gpu || !field) return;

    const gl = gpu.gl;
    const { cols, rows } = field.grid;
    const frame = Math.min(this.frameIndex, field.wind.length - 1);
    const windFrame = field.wind[frame];
    const scalarFrame = field.scalar[frame];
    if (!windFrame) return;

    const { min, max } = field.scalarRange;
    const span = max - min || 1;
    const reference = Math.max(1e-6, field.windReference);

    const total = cols * rows;
    const fieldPixels = new Uint8Array(total * 4);
    const uPixels = new Uint8Array(total * 4);
    const vPixels = new Uint8Array(total * 4);

    for (let i = 0; i < total; i += 1) {
      const scalar = scalarFrame?.values[i] ?? Number.NaN;
      const normalised = Number.isFinite(scalar) ? (scalar - min) / span : 0;
      const byte = Math.max(0, Math.min(255, Math.round(normalised * 255)));

      fieldPixels[i * 4] = byte;
      fieldPixels[i * 4 + 1] = byte;
      fieldPixels[i * 4 + 2] = byte;
      fieldPixels[i * 4 + 3] = byte;

      const u = windFrame.u[i];
      const v = windFrame.v[i];
      const uNorm = Number.isFinite(u) ? (u / reference) * 0.5 + 0.5 : 0.5;
      const vNorm = Number.isFinite(v) ? (v / reference) * 0.5 + 0.5 : 0.5;

      const uByte = Math.max(0, Math.min(255, Math.round(uNorm * 255)));
      const vByte = Math.max(0, Math.min(255, Math.round(vNorm * 255)));

      uPixels[i * 4] = uByte;
      uPixels[i * 4 + 1] = uByte;
      uPixels[i * 4 + 2] = uByte;
      uPixels[i * 4 + 3] = 255;

      vPixels[i * 4] = vByte;
      vPixels[i * 4 + 1] = vByte;
      vPixels[i * 4 + 2] = vByte;
      vPixels[i * 4 + 3] = 255;
    }

    gl.bindTexture(gl.TEXTURE_2D, gpu.fieldTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, fieldPixels);

    gl.bindTexture(gl.TEXTURE_2D, gpu.uTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, uPixels);

    gl.bindTexture(gl.TEXTURE_2D, gpu.vTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, vPixels);
  }

  /* ---------------- programs ---------------- */

  private ensurePrograms(args: CustomRenderMethodInput): void {
    const gpu = this.gpu;
    if (!gpu) return;

    const shaderData = args.shaderData;
    if (!shaderData) return;

    const key = shaderData.variantName;
    if (gpu.programKey === key && gpu.heatProgram && gpu.streakProgram) return;

    const gl = gpu.gl;
    const prelude = shaderData.vertexShaderPrelude;
    const define = shaderData.define ?? '';

    if (gpu.heatProgram) gl.deleteProgram(gpu.heatProgram);
    if (gpu.streakProgram) gl.deleteProgram(gpu.streakProgram);

    gpu.heatProgram = this.compile(
      gl,
      heatVertexSource(prelude, define),
      HEAT_FRAGMENT,
      ['a_pos'],
      'heat',
    );
    gpu.streakProgram = this.compile(
      gl,
      streakVertexSource(prelude, define),
      STREAK_FRAGMENT,
      ['a_seed', 'a_phase', 'a_end'],
      'streak',
    );

    gpu.heatUniforms.clear();
    gpu.streakUniforms.clear();
    gpu.programKey = key;
  }

  /**
   * Compile and link, pinning attribute locations so the VAOs built in `onAdd`
   * remain valid regardless of what the linker would have chosen.
   */
  private compile(
    gl: WebGL2RenderingContext,
    vertex: string,
    fragment: string,
    attributes: string[],
    label: string,
  ): WebGLProgram | null {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!vs || !fs) return null;

    gl.shaderSource(vs, vertex);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error(`[aether] ${label} vertex shader failed:`, gl.getShaderInfoLog(vs));
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return null;
    }

    gl.shaderSource(fs, fragment);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error(`[aether] ${label} fragment shader failed:`, gl.getShaderInfoLog(fs));
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return null;
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return null;
    }

    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    attributes.forEach((name, index) => {
      gl.bindAttribLocation(program, index, name);
    });
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(`[aether] ${label} link failed:`, gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return null;
    }

    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return program;
  }

  /** Cached uniform lookup; `null` means the uniform was optimised away. */
  private uniform(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    cache: Map<string, WebGLUniformLocation | null>,
    name: string,
  ): WebGLUniformLocation | null {
    if (!cache.has(name)) {
      cache.set(name, gl.getUniformLocation(program, name));
    }
    return cache.get(name) ?? null;
  }

  /**
   * Supply MapLibre's projection uniforms. `mainMatrix` is a Float64Array in v5,
   * so it must be narrowed before `uniformMatrix4fv`.
   */
  private applyProjection(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    cache: Map<string, WebGLUniformLocation | null>,
    args: CustomRenderMethodInput,
  ): void {
    const data = args.defaultProjectionData;

    const setMatrix = (name: string, value: ArrayLike<number> | undefined): void => {
      const loc = this.uniform(gl, program, cache, name);
      if (!loc) return;
      const f32 = value instanceof Float32Array ? value : new Float32Array(value ?? []);
      if (f32.length === 16) gl.uniformMatrix4fv(loc, false, f32);
    };

    const setVec4 = (name: string, value: ArrayLike<number> | undefined): void => {
      const loc = this.uniform(gl, program, cache, name);
      if (!loc || !value) return;
      gl.uniform4f(loc, value[0], value[1], value[2], value[3]);
    };

    const setFloat = (name: string, value: number | undefined): void => {
      const loc = this.uniform(gl, program, cache, name);
      if (!loc || value === undefined) return;
      gl.uniform1f(loc, value);
    };

    if (!data) {
      setMatrix('u_projection_matrix', args.modelViewProjectionMatrix);
      return;
    }

    setMatrix('u_projection_matrix', data.mainMatrix);
    setVec4('u_projection_tile_mercator_coords', data.tileMercatorCoords);
    setVec4('u_projection_clipping_plane', data.clippingPlane);
    setFloat('u_projection_transition', data.projectionTransition);
    setMatrix('u_projection_fallback_matrix', data.fallbackMatrix);
  }

  /* ---------------- render ---------------- */

  render(
    _gl: WebGLRenderingContext | WebGL2RenderingContext,
    args: CustomRenderMethodInput,
  ): void {
    const gpu = this.gpu;
    if (!gpu || !this.fieldSet) return;

    this.ensurePrograms(args);

    const gl = gpu.gl;
    const elapsed = performance.now() / 1000 - this.startedAt;

    // Horizon culling under globe is handled by clip-space z from the prelude,
    // not by the depth buffer, so depth testing can stay off for this overlay.
    gl.disable(gl.DEPTH_TEST);

    if (this.heatVisible && gpu.heatProgram) {
      this.drawHeat(gl, gpu, args);
    }
    if (this.streaksVisible && gpu.streakProgram) {
      this.drawStreaks(gl, gpu, args, elapsed);
    }

    gl.enable(gl.DEPTH_TEST);
  }

  private drawHeat(
    gl: WebGL2RenderingContext,
    gpu: GPUState,
    args: CustomRenderMethodInput,
  ): void {
    const program = gpu.heatProgram;
    if (!program || !gpu.heatVao) return;

    gl.useProgram(program);
    this.applyProjection(gl, program, gpu.heatUniforms, args);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, gpu.fieldTexture);
    gl.uniform1i(this.uniform(gl, program, gpu.heatUniforms, 'u_field'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, gpu.lutTexture);
    gl.uniform1i(this.uniform(gl, program, gpu.heatUniforms, 'u_lut'), 1);

    gl.uniform1f(this.uniform(gl, program, gpu.heatUniforms, 'u_opacity'), this.heatOpacity);
    const bounds = this.uniform(gl, program, gpu.heatUniforms, 'u_mercYBounds');
    if (bounds) {
      const yNorth = Math.min(gpu.mercYBounds[0], gpu.mercYBounds[1]);
      const ySouth = Math.max(gpu.mercYBounds[0], gpu.mercYBounds[1]);
      gl.uniform2f(bounds, yNorth, ySouth);
    }

    gl.bindVertexArray(gpu.heatVao);
    gl.drawElements(gl.TRIANGLES, gpu.heatIndexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  private drawStreaks(
    gl: WebGL2RenderingContext,
    gpu: GPUState,
    args: CustomRenderMethodInput,
    elapsed: number,
  ): void {
    const program = gpu.streakProgram;
    if (!program || !gpu.streakVao) return;

    gl.useProgram(program);
    this.applyProjection(gl, program, gpu.streakUniforms, args);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, gpu.uTexture);
    gl.uniform1i(this.uniform(gl, program, gpu.streakUniforms, 'u_u'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, gpu.vTexture);
    gl.uniform1i(this.uniform(gl, program, gpu.streakUniforms, 'u_v'), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, gpu.lutTexture);
    gl.uniform1i(this.uniform(gl, program, gpu.streakUniforms, 'u_lut'), 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, gpu.fieldTexture);
    gl.uniform1i(this.uniform(gl, program, gpu.streakUniforms, 'u_field'), 3);

    gl.uniform1f(this.uniform(gl, program, gpu.streakUniforms, 'u_time'), elapsed);
    gl.uniform1f(
      this.uniform(gl, program, gpu.streakUniforms, 'u_seedAlpha'),
      0.16,
    );
    const bounds = this.uniform(gl, program, gpu.streakUniforms, 'u_mercYBounds');
    if (bounds) {
      const yNorth = Math.min(gpu.mercYBounds[0], gpu.mercYBounds[1]);
      const ySouth = Math.max(gpu.mercYBounds[0], gpu.mercYBounds[1]);
      gl.uniform2f(bounds, yNorth, ySouth);
    }
    gl.uniform1f(
      this.uniform(gl, program, gpu.streakUniforms, 'u_opacity'),
      this.streakOpacity,
    );

    gl.bindVertexArray(gpu.streakVao);
    gl.drawArrays(gl.LINES, 0, this.particleCount * 2);
    gl.bindVertexArray(null);
  }
}
