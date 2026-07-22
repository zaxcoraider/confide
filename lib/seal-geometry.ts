/**
 * Seal geometry, derived from a bytes32 handle.
 *
 * Shared by the SVG seal (components/seal.tsx) and the WebGL seal
 * (components/seal-3d.tsx) so that both renderers produce THE SAME shape for a
 * given handle. If they diverged, the 3D layer would stop being progressive
 * enhancement and start being a different object.
 *
 * Everything here is a pure function of the handle. Same handle, same seal,
 * forever — which is what lets the seal act as a visual fingerprint of a
 * specific ciphertext rather than as decoration.
 */

/** Deterministic byte reader over the handle. */
export function byteAt(handle: string, index: number): number {
  const hex = handle.startsWith("0x") ? handle.slice(2) : handle;
  if (hex.length < 2) return 0;
  const i = (index * 2) % hex.length;
  return parseInt(hex.slice(i, i + 2).padEnd(2, "0"), 16) || 0;
}

export const BLOB_POINTS = 22;

/**
 * The molten silhouette as raw points around a centre.
 *
 * Jitter is deliberately large — wax squeezed under a stamp spreads unevenly,
 * and a near-perfect circle reads as a coin instead of a seal.
 */
export function blobPoints(
  handle: string,
  radius: number,
  jitter: number,
  cx = 0,
  cy = 0,
): Array<[number, number]> {
  return Array.from({ length: BLOB_POINTS }, (_, i) => {
    const angle = (i / BLOB_POINTS) * Math.PI * 2;
    const r = radius + (byteAt(handle, i) / 255 - 0.5) * jitter;
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r] as [number, number];
  });
}

/**
 * The same molten outline, densified into a plain closed polygon.
 *
 * The SVG draws the silhouette as midpoint-quadratics. THREE.Shape can be built
 * from curves too, but `ExtrudeGeometry` triangulation of a curve-built shape is
 * fragile — when it yields zero vertices, `geometry.center()` then translates by
 * NaN and the whole mesh silently disappears with no error. Sampling the very
 * same curve into points up front is equivalent and cannot fail that way.
 *
 * Evaluates the identical midpoint-quadratic the SVG path uses, so the 3D
 * silhouette matches the 2D one exactly.
 */
export function blobPolygon(
  handle: string,
  radius: number,
  jitter: number,
  samplesPerSegment = 6,
): Array<[number, number]> {
  const pts = blobPoints(handle, radius, jitter);
  const n = pts.length;
  const mid = (a: [number, number], b: [number, number]) =>
    [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as [number, number];

  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const cur = pts[i]!;
    const next = pts[(i + 1) % n]!;
    const from = mid(pts[(i - 1 + n) % n]!, cur); // segment start
    const to = mid(cur, next); // segment end
    for (let s = 0; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const u = 1 - t;
      // Quadratic Bézier with `cur` as the control point.
      out.push([
        u * u * from[0] + 2 * u * t * cur[0] + t * t * to[0],
        u * u * from[1] + 2 * u * t * cur[1] + t * t * to[1],
      ]);
    }
  }
  return out;
}

export const SIGIL_NODES = 9;

/**
 * Chords struck between nodes placed by the handle's own bytes.
 *
 * Chords rather than a filled polygon: a filled shape reads as a generic badge,
 * whereas a chord figure reads as a mark that was struck, and it varies far
 * more visibly between two handles. The chord `step` is itself read from the
 * handle, so even the density of the figure is part of the ciphertext.
 */
export function sigilNodes(handle: string, scale = 1): Array<[number, number]> {
  return Array.from({ length: SIGIL_NODES }, (_, i) => {
    const angle = (i / SIGIL_NODES) * Math.PI * 2 + (byteAt(handle, i + 5) / 255) * 0.5;
    const r = (17 + (byteAt(handle, i + 12) / 255) * 16) * scale;
    return [Math.cos(angle) * r, Math.sin(angle) * r] as [number, number];
  });
}

export function sigilStep(handle: string): number {
  return 2 + (byteAt(handle, 3) % 3);
}

/** Index pairs to connect, given the handle's own step. */
export function sigilPairs(handle: string): Array<[number, number]> {
  const step = sigilStep(handle);
  return Array.from(
    { length: SIGIL_NODES },
    (_, i) => [i, (i + step) % SIGIL_NODES] as [number, number],
  );
}
