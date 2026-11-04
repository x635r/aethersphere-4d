/**
 * Marching Squares contour extraction.
 *
 * Shared by the cross-section renderer (isotherms, jet streaks) and the model
 * arena (the 5880 gpm subtropical-ridge contour). Extracted here because the
 * arena needs something the slice renderer did not: contour *completion*, i.e.
 * stitching per-cell segments into continuous polylines so a 5880 m line can be
 * stroked as one path rather than 400 disconnected 4-pixel stubs.
 *
 * Coordinates returned to callers are in fractional grid space: x in [0, cols-1],
 * y in [0, rows-1]. Callers map them to pixels with their own projection.
 */

export interface ContourSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Extract contour segments for `level` from a row-major scalar grid.
 *
 * Cells with any non-finite corner are skipped, so NaN holes (underground
 * pressure levels, missing marine points) punch through cleanly instead of
 * producing spurious edges.
 */
export function contourSegments(
  values: Float32Array | number[],
  cols: number,
  rows: number,
  level: number,
): ContourSegment[] {
  const out: ContourSegment[] = [];
  if (cols < 2 || rows < 2) return out;

  const at = (r: number, c: number): number => values[r * cols + c];

  // Edge interpolation with a shared cache: adjacent cells must produce the
  // exact same vertex or the stitched path develops visible gaps.
  const cache = new Map<number, { x: number; y: number }>();

  const edgeKey = (r: number, c: number, edge: number) => ((r * cols + c) * 4 + edge);

  const lerp = (a: number, b: number): number => {
    const d = a - b;
    if (Math.abs(d) < 1e-9) return 0.5;
    return Math.max(0, Math.min(1, (a - level) / d));
  };

  const edgeVertex = (r: number, c: number, edge: number): { x: number; y: number } | null => {
    const key = edgeKey(r, c, edge);
    const hit = cache.get(key);
    if (hit) return hit;

    const tl = at(r, c);
    const tr = at(r, c + 1);
    const bl = at(r + 1, c);
    const br = at(r + 1, c + 1);

    let v: { x: number; y: number } | null = null;

    // Edge 0 = top (TL->TR), 1 = right (TR->BR), 2 = bottom (BL->BR), 3 = left (TL->BL)
    if (edge === 0 && Number.isFinite(tl) && Number.isFinite(tr)) {
      v = { x: c + lerp(tl, tr), y: r };
    } else if (edge === 1 && Number.isFinite(tr) && Number.isFinite(br)) {
      v = { x: c + 1, y: r + lerp(tr, br) };
    } else if (edge === 2 && Number.isFinite(bl) && Number.isFinite(br)) {
      v = { x: c + lerp(bl, br), y: r + 1 };
    } else if (edge === 3 && Number.isFinite(tl) && Number.isFinite(bl)) {
      v = { x: c, y: r + lerp(tl, bl) };
    }

    if (v) cache.set(key, v);
    return v;
  };

  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const tl = at(r, c);
      const tr = at(r, c + 1);
      const bl = at(r + 1, c);
      const br = at(r + 1, c + 1);

      if (
        !Number.isFinite(tl) ||
        !Number.isFinite(tr) ||
        !Number.isFinite(bl) ||
        !Number.isFinite(br)
      ) {
        continue;
      }

      let idx = 0;
      if (tl >= level) idx |= 8;
      if (tr >= level) idx |= 4;
      if (br >= level) idx |= 2;
      if (bl >= level) idx |= 1;

      if (idx === 0 || idx === 15) continue;

      const push = (ea: number, eb: number) => {
        const a = edgeVertex(r, c, ea);
        const b = edgeVertex(r, c, eb);
        if (a && b) out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      };

      switch (idx) {
        case 1:
        case 14:
          push(2, 3);
          break;
        case 2:
        case 13:
          push(1, 2);
          break;
        case 3:
        case 12:
          push(1, 3);
          break;
        case 4:
        case 11:
          push(0, 1);
          break;
        case 6:
        case 9:
          push(0, 2);
          break;
        case 7:
        case 8:
          push(0, 3);
          break;
        case 5:
        case 10: {
          // Saddle. Resolve with the cell-centre average so the two arcs
          // separate consistently instead of crossing.
          const centre = (tl + tr + bl + br) / 4;
          const inside = centre >= level;
          const pairs: [number, number][] =
            idx === 5
              ? inside
                ? [[0, 1], [2, 3]]
                : [[0, 3], [1, 2]]
              : inside
                ? [[0, 3], [1, 2]]
                : [[0, 1], [2, 3]];
          for (const [ea, eb] of pairs) push(ea, eb);
          break;
        }
        default:
          break;
      }
    }
  }

  return out;
}

/**
 * Stitch loose segments into continuous polylines.
 *
 * Greedy endpoint matching with a quantised coordinate key. Two segments join
 * when an endpoint coincides within `tolerance` grid units. Segments that never
 * join stay as short standalone polylines, which is the correct output for a
 * contour that genuinely enters and exits the data domain.
 */
export function stitchContours(
  segments: ContourSegment[],
  tolerance = 1e-6,
): { x: number; y: number }[][] {
  if (segments.length === 0) return [];

  const keyOf = (x: number, y: number) =>
    `${Math.round(x / tolerance)}:${Math.round(y / tolerance)}`;

  // Endpoint -> segment indices touching it.
  const endpointMap = new Map<string, number[]>();

  segments.forEach((seg, i) => {
    for (const [x, y] of [
      [seg.x1, seg.y1],
      [seg.x2, seg.y2],
    ]) {
      const k = keyOf(x, y);
      const list = endpointMap.get(k);
      if (list) list.push(i);
      else endpointMap.set(k, [i]);
    }
  });

  const used = new Uint8Array(segments.length);
  const polylines: { x: number; y: number }[][] = [];

  for (let seed = 0; seed < segments.length; seed += 1) {
    if (used[seed]) continue;
    used[seed] = 1;

    const path: { x: number; y: number }[] = [
      { x: segments[seed].x1, y: segments[seed].y1 },
      { x: segments[seed].x2, y: segments[seed].y2 },
    ];

    // Extend forward from the current tail.
    let guard = 0;
    for (;;) {
      if (guard > segments.length + 4) break;
      guard += 1;

      const tail = path[path.length - 1];
      const candidates = endpointMap.get(keyOf(tail.x, tail.y));
      if (!candidates) break;

      let advanced = false;
      for (const idx of candidates) {
        if (used[idx]) continue;
        const seg = segments[idx];

        const d1 = Math.hypot(seg.x1 - tail.x, seg.y1 - tail.y);
        const d2 = Math.hypot(seg.x2 - tail.x, seg.y2 - tail.y);

        if (d1 <= tolerance * 2) {
          used[idx] = 1;
          path.push({ x: seg.x2, y: seg.y2 });
          advanced = true;
          break;
        }
        if (d2 <= tolerance * 2) {
          used[idx] = 1;
          path.push({ x: seg.x1, y: seg.y1 });
          advanced = true;
          break;
        }
      }

      if (!advanced) break;
    }

    // Extend backward from the head (closes loops that wrap).
    guard = 0;
    for (;;) {
      if (guard > segments.length + 4) break;
      guard += 1;

      const head = path[0];
      const candidates = endpointMap.get(keyOf(head.x, head.y));
      if (!candidates) break;

      let advanced = false;
      for (const idx of candidates) {
        if (used[idx]) continue;
        const seg = segments[idx];

        const d1 = Math.hypot(seg.x1 - head.x, seg.y1 - head.y);
        const d2 = Math.hypot(seg.x2 - head.x, seg.y2 - head.y);

        if (d1 <= tolerance * 2) {
          used[idx] = 1;
          path.unshift({ x: seg.x2, y: seg.y2 });
          advanced = true;
          break;
        }
        if (d2 <= tolerance * 2) {
          used[idx] = 1;
          path.unshift({ x: seg.x1, y: seg.y1 });
          advanced = true;
          break;
        }
      }

      if (!advanced) break;
    }

    polylines.push(path);
  }

  return polylines;
}

/**
 * Convenience: segments -> stitched polylines, dropping specks.
 *
 * `minPoints` filters contours that are only a cell or two long, which on a
 * coarse global grid are almost always numerical noise rather than a real
 * ridge line.
 */
export function contours(
  values: Float32Array | number[],
  cols: number,
  rows: number,
  level: number,
  minPoints = 3,
): { x: number; y: number }[][] {
  const stitched = stitchContours(contourSegments(values, cols, rows, level));
  return stitched.filter((p) => p.length >= minPoints);
}
