/**
 * DayNightLayer — a MapLibre custom layer that darkens the night hemisphere
 * with a soft twilight band.
 *
 * The mask is computed analytically in the fragment shader from the subsolar
 * point, so it deforms correctly on the globe (it is a great circle, not a
 * latitude band) and costs one dot product per pixel. No texture upload per
 * frame and no polygon seams.
 */

import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from 'maplibre-gl';
import { DEG2RAD } from '../core/geo';
import { subsolarPoint } from '../core/solar';

const MESH_COLS = 128;
const MESH_ROWS = 64;

function vertexSource(prelude: string, define: string): string {
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

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_merc;
out vec4 fragColor;

uniform vec3 u_sunDir;   // unit vector toward the sun, in the globe's frame
uniform float u_intensity;
uniform float u_twilight;

const float PI = 3.141592653589793;

void main() {
  // Invert normalised web-mercator to a unit-sphere normal.
  float lng = (v_merc.x * 2.0 - 1.0) * PI;
  float lat = 2.0 * atan(exp(PI * (1.0 - 2.0 * v_merc.y))) - PI * 0.5;
  float cosLat = cos(lat);
  vec3 normal = vec3(cosLat * sin(lng), sin(lat), cosLat * cos(lng));

  // +1 = subsolar (full day), -1 = antipode (deep night).
  float sunDot = dot(normal, u_sunDir);

  // Smooth the terminator over a band of solar elevation. u_twilight is the
  // half-width in sin(elevation) units, so ~0.09 is roughly civil twilight.
  float night = smoothstep(u_twilight, -u_twilight, sunDot);
  if (night <= 0.004) discard;

  // Deep-space blue-black rather than pure black, so the night side still reads
  // as part of the globe instead of a hole punched in it.
  vec3 nightTint = vec3(0.012, 0.020, 0.052);
  float alpha = night * u_intensity;

  // Premultiplied alpha for MapLibre's (ONE, ONE_MINUS_SRC_ALPHA) blending.
  fragColor = vec4(nightTint * alpha, alpha);
}`;

export class DayNightLayer implements CustomLayerInterface {
  readonly id = 'aether-day-night';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;

  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private ibo: WebGLBuffer | null = null;
  private indexCount = 0;

  private programKey = '';
  private uniformCache = new Map<string, WebGLUniformLocation | null>();

  private visible = true;
  /** UTC epoch ms currently shown on the timeline. */
  private utcMs = Date.now();
  private intensity = 0.82;
  /** Half-width of the twilight band in sin(elevation) units. */
  private twilight = 0.10;

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.map?.triggerRepaint();
  }

  setTime(utcMs: number): void {
    this.utcMs = utcMs;
    this.map?.triggerRepaint();
  }

  setIntensity(value: number): void {
    this.intensity = Math.max(0, Math.min(1, value));
    this.map?.triggerRepaint();
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;

    if (
      typeof WebGL2RenderingContext === 'undefined' ||
      !(gl instanceof WebGL2RenderingContext)
    ) {
      return;
    }

    this.gl = gl;
    this.buildMesh(gl);
  }

  private buildMesh(gl: WebGL2RenderingContext): void {
    const cols = MESH_COLS;
    const rows = MESH_ROWS;

    const positions = new Float32Array((cols + 1) * (rows + 1) * 2);
    let p = 0;
    for (let r = 0; r <= rows; r += 1) {
      for (let c = 0; c <= cols; c += 1) {
        positions[p] = c / cols;
        positions[p + 1] = r / rows;
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

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
    this.indexCount = indices.length;
  }

  private ensureProgram(args: CustomRenderMethodInput): void {
    const gl = this.gl;
    if (!gl) return;

    const shaderData = args.shaderData;
    if (!shaderData) return;

    if (this.programKey === shaderData.variantName && this.program) return;

    if (this.program) gl.deleteProgram(this.program);

    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!vs || !fs) return;

    gl.shaderSource(vs, vertexSource(shaderData.vertexShaderPrelude, shaderData.define ?? ''));
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error('[aether] day/night vertex:', gl.getShaderInfoLog(vs));
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return;
    }

    gl.shaderSource(fs, FRAGMENT);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error('[aether] day/night fragment:', gl.getShaderInfoLog(fs));
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return;
    }

    const program = gl.createProgram();
    if (!program) return;

    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'a_pos');
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('[aether] day/night link:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return;
    }

    gl.deleteShader(vs);
    gl.deleteShader(fs);

    this.program = program;
    this.programKey = shaderData.variantName;
    this.uniformCache.clear();
  }

  private uniform(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    name: string,
  ): WebGLUniformLocation | null {
    if (!this.uniformCache.has(name)) {
      this.uniformCache.set(name, gl.getUniformLocation(program, name));
    }
    return this.uniformCache.get(name) ?? null;
  }

  render(
    _gl: WebGLRenderingContext | WebGL2RenderingContext,
    args: CustomRenderMethodInput,
  ): void {
    if (!this.visible) return;

    const gl = this.gl;
    if (!gl || !this.vao) return;

    this.ensureProgram(args);
    const program = this.program;
    if (!program) return;

    gl.useProgram(program);

    // ---- projection uniforms (same contract as the wind layer) ----
    const data = args.defaultProjectionData;
    const setMatrix = (name: string, value: ArrayLike<number> | undefined) => {
      const loc = this.uniform(gl, program, name);
      if (!loc || !value) return;
      const f32 = value instanceof Float32Array ? value : new Float32Array(value);
      if (f32.length === 16) gl.uniformMatrix4fv(loc, false, f32);
    };
    const setVec4 = (name: string, value: ArrayLike<number> | undefined) => {
      const loc = this.uniform(gl, program, name);
      if (!loc || !value) return;
      gl.uniform4f(loc, value[0], value[1], value[2], value[3]);
    };
    const setFloat = (name: string, value: number | undefined) => {
      const loc = this.uniform(gl, program, name);
      if (!loc || value === undefined) return;
      gl.uniform1f(loc, value);
    };

    if (data) {
      setMatrix('u_projection_matrix', data.mainMatrix);
      setVec4('u_projection_tile_mercator_coords', data.tileMercatorCoords);
      setVec4('u_projection_clipping_plane', data.clippingPlane);
      setFloat('u_projection_transition', data.projectionTransition);
      setMatrix('u_projection_fallback_matrix', data.fallbackMatrix);
    } else {
      setMatrix('u_projection_matrix', args.modelViewProjectionMatrix);
    }

    // ---- sun direction in the same frame the shader's normal uses ----
    // normal = (cosLat*sin(lng), sin(lat), cosLat*cos(lng)) with lng, lat in
    // radians; the subsolar point has that normal, so this is a direct mapping.
    const sub = subsolarPoint(this.utcMs);
    const decRad = sub.declination * DEG2RAD;
    const lngRad = sub.longitude * DEG2RAD;
    const cosDec = Math.cos(decRad);

    const sunDir = [
      cosDec * Math.sin(lngRad),
      Math.sin(decRad),
      cosDec * Math.cos(lngRad),
    ];

    const sunLoc = this.uniform(gl, program, 'u_sunDir');
    if (sunLoc) gl.uniform3f(sunLoc, sunDir[0], sunDir[1], sunDir[2]);

    const intensityLoc = this.uniform(gl, program, 'u_intensity');
    if (intensityLoc) gl.uniform1f(intensityLoc, this.intensity);

    const twilightLoc = this.uniform(gl, program, 'u_twilight');
    if (twilightLoc) gl.uniform1f(twilightLoc, this.twilight);

    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);

    this.map?.triggerRepaint();
  }

  onRemove(): void {
    const gl = this.gl;
    if (!gl) return;
    if (this.program) gl.deleteProgram(this.program);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.ibo) gl.deleteBuffer(this.ibo);

    this.program = null;
    this.vao = null;
    this.vbo = null;
    this.ibo = null;
    this.gl = null;
    this.map = null;
  }
}
