"use client";

/**
 * THE SEAL — Confide's signature element. Design.md §5.
 *
 * A wax seal whose geometry is DERIVED FROM THE ACTUAL HANDLE it represents.
 * Two different payouts produce two visibly different seals, because the blob
 * silhouette, the sigil, and the fracture lines are all read out of the
 * bytes32. That is the point: this is not an illustration of encryption, it is
 * a rendering of the specific ciphertext on chain.
 *
 * This SVG layer is the BASE, not a fallback. Rules.md §5 requires every P0
 * flow to work without WebGL, so this must be complete on its own — the 3D
 * layer only ever replaces it as progressive enhancement.
 *
 * States:
 *   sealed     wax amber, struck and unbroken — nobody can read it
 *   working    scanline passes over the face — the TEE is computing
 *   disclosed  fractured along its own hex grid, verdigris — readable by you
 *
 * The fracture is ONE-WAY. It never re-seals, because Nox ACL grants cannot be
 * revoked. The visual is not allowed to promise something the protocol can't.
 */
import { useId } from "react";

export type SealState = "sealed" | "working" | "disclosed";

/** Deterministic byte reader over the handle — same handle, same seal, always. */
function byteAt(handle: string, index: number): number {
  const hex = handle.startsWith("0x") ? handle.slice(2) : handle;
  if (hex.length < 2) return 0;
  const i = (index * 2) % hex.length;
  return parseInt(hex.slice(i, i + 2).padEnd(2, "0"), 16) || 0;
}

/**
 * Irregular wax silhouette. Jitter is deliberately large — wax squeezed under a
 * stamp spreads unevenly, and a near-perfect circle reads as a coin instead.
 */
function blobPath(handle: string, radius: number, jitter: number): string {
  const POINTS = 22;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < POINTS; i++) {
    const angle = (i / POINTS) * Math.PI * 2;
    const wobble = (byteAt(handle, i) / 255 - 0.5) * jitter;
    const r = radius + wobble;
    pts.push([100 + Math.cos(angle) * r, 100 + Math.sin(angle) * r]);
  }
  // Quadratic through midpoints keeps the edge molten rather than polygonal.
  let d = `M ${((pts[0]![0] + pts[POINTS - 1]![0]) / 2).toFixed(2)} ${(
    (pts[0]![1] + pts[POINTS - 1]![1]) /
    2
  ).toFixed(2)}`;
  for (let i = 0; i < POINTS; i++) {
    const cur = pts[i]!;
    const next = pts[(i + 1) % POINTS]!;
    d += ` Q ${cur[0].toFixed(2)} ${cur[1].toFixed(2)} ${((cur[0] + next[0]) / 2).toFixed(
      2,
    )} ${((cur[1] + next[1]) / 2).toFixed(2)}`;
  }
  return `${d} Z`;
}

/**
 * The sigil: chords struck between nodes placed by the handle's own bytes.
 *
 * Chords rather than a filled polygon — a filled shape reads as a generic
 * badge, whereas a chord figure reads as a mark that was *struck*, and it
 * varies far more visibly between two handles.
 */
function sigilChords(handle: string): { nodes: Array<readonly [number, number]>; chords: string[] } {
  const NODES = 9;
  const nodes = Array.from({ length: NODES }, (_, i) => {
    const angle = (i / NODES) * Math.PI * 2 + (byteAt(handle, i + 5) / 255) * 0.5;
    const r = 17 + (byteAt(handle, i + 12) / 255) * 16;
    return [100 + Math.cos(angle) * r, 100 + Math.sin(angle) * r] as const;
  });

  // Each node connects to the node `step` places on, where step comes from the
  // handle — so the density of the figure is itself part of the ciphertext.
  const step = 2 + (byteAt(handle, 3) % 3);
  const chords = nodes.map((from, i) => {
    const to = nodes[(i + step) % NODES]!;
    return `M ${from[0].toFixed(1)} ${from[1].toFixed(1)} L ${to[0].toFixed(1)} ${to[1].toFixed(1)}`;
  });
  return { nodes, chords };
}

/** Cracks radiate from the centre out past the rim, following the handle. */
function fractureLines(handle: string, radius: number): string[] {
  const CRACKS = 6;
  return Array.from({ length: CRACKS }, (_, i) => {
    const angle = (i / CRACKS) * Math.PI * 2 + (byteAt(handle, i + 20) / 255) * 0.9;
    const midR = radius * 0.45;
    const midAngle = angle + (byteAt(handle, i + 26) / 255 - 0.5) * 0.6;
    return (
      `M 100 100 ` +
      `L ${(100 + Math.cos(midAngle) * midR).toFixed(1)} ${(100 + Math.sin(midAngle) * midR).toFixed(1)} ` +
      `L ${(100 + Math.cos(angle) * radius * 1.04).toFixed(1)} ${(100 + Math.sin(angle) * radius * 1.04).toFixed(1)}`
    );
  });
}

export function Seal({
  handle,
  state,
  size = 180,
}: {
  handle: string;
  state: SealState;
  size?: number;
}) {
  // Per-INSTANCE ids. Deriving them from the handle collides whenever the same
  // handle is rendered twice (or in two states), and the first <defs> silently
  // wins — which is exactly how the disclosed seal ended up rendering amber.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");

  const disclosed = state === "disclosed";
  const working = state === "working";

  const radius = 72;
  const rim = handle.replace(/^0x/, "").slice(0, 32).toUpperCase();
  const sigil = sigilChords(handle);

  // Wax reads warm; a disclosed seal cools to verdigris. Design.md §1 — these
  // two colours are the entire semantic payload of this component.
  const face = disclosed ? "#3FA66A" : "#D4863C";
  const mid = disclosed ? "#2C7A4C" : "#A9662A";
  const deep = disclosed ? "#0E3B22" : "#6E3F17";
  const lit = disclosed ? "#BFEBD1" : "#FFE0B2";

  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      role="img"
      aria-label={
        disclosed
          ? "Seal broken. This value has been disclosed to you."
          : working
            ? "Seal being opened. Waiting for the trusted execution environment."
            : "Sealed. This value is encrypted and cannot be read."
      }
    >
      <defs>
        {/* Shallow, off-centre light. A strong radial here makes it a sphere;
            wax is a squat disc, so the falloff stays gentle. */}
        <radialGradient id={`body-${uid}`} cx="36%" cy="28%" r="92%">
          <stop offset="0%" stopColor={face} />
          <stop offset="62%" stopColor={mid} />
          <stop offset="100%" stopColor={deep} />
        </radialGradient>

        {/* The stamped depression is fractionally darker than the raised rim. */}
        <radialGradient id={`well-${uid}`} cx="42%" cy="34%" r="80%">
          <stop offset="0%" stopColor={mid} stopOpacity="0.55" />
          <stop offset="100%" stopColor={deep} stopOpacity="0.75" />
        </radialGradient>

        {/* Emboss is applied ONLY to the struck marks, not the whole body —
            that is what makes them read as pressed into the wax. */}
        <filter id={`struck-${uid}`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0.6" dy="0.9" stdDeviation="0.5" floodColor={deep} floodOpacity="0.95" />
          <feDropShadow dx="-0.5" dy="-0.7" stdDeviation="0.4" floodColor={lit} floodOpacity="0.4" />
        </filter>

        <clipPath id={`face-${uid}`}>
          <path d={blobPath(handle, radius, 16)} />
        </clipPath>

        <path id={`rim-${uid}`} d="M 100,45 a 55,55 0 1,1 -0.1,0" fill="none" />
      </defs>

      {/* Cast shadow — the seal sits ON the ledger, it is not drawn into it. */}
      <ellipse cx="100" cy="178" rx="56" ry="6" fill="#000" opacity="0.55" />

      <g
        style={{
          transformOrigin: "100px 100px",
          transition: "transform 700ms cubic-bezier(0.2, 0.8, 0.2, 1)",
          transform: disclosed ? "scale(0.98)" : "scale(1)",
        }}
      >
        {/* Molten wax body */}
        <path
          d={blobPath(handle, radius, 16)}
          fill={`url(#body-${uid})`}
          stroke={deep}
          strokeWidth="1.2"
        />

        {/* Raised rim ridge + stamped well. The well follows the blob's own
            outline rather than being a true circle — a perfect circle inside a
            molten edge reads as a bottle cap. */}
        <path d={blobPath(handle, radius - 13, 11)} fill={`url(#well-${uid})`} />
        <path
          d={blobPath(handle, radius - 13, 11)}
          fill="none"
          stroke={lit}
          strokeWidth="1.1"
          opacity="0.28"
        />

        <g filter={`url(#struck-${uid})`}>
          {/* Rim text — the real first 32 hex characters, struck into the wax */}
          <text
            fontFamily="var(--font-data)"
            fontSize="8.6"
            fontWeight="500"
            letterSpacing="2.4"
            fill={lit}
            opacity="0.62"
          >
            <textPath href={`#rim-${uid}`} startOffset="0%">
              {rim}
            </textPath>
          </text>

          {/* The sigil, read out of the same bytes */}
          {sigil.chords.map((d, i) => (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={lit}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeOpacity="0.5"
            />
          ))}
          {sigil.nodes.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="2" fill={lit} opacity="0.65" />
          ))}
        </g>

        {/* Fracture — appears only on disclosure, and never goes away */}
        <g
          clipPath={`url(#face-${uid})`}
          style={{
            opacity: disclosed ? 1 : 0,
            transition: "opacity 600ms ease-out 120ms",
          }}
        >
          {fractureLines(handle, radius).map((d, i) => (
            <g key={i}>
              <path d={d} fill="none" stroke="#04070B" strokeWidth="2.4" strokeLinecap="round" opacity="0.85" />
              <path
                d={d}
                fill="none"
                stroke={lit}
                strokeWidth="0.7"
                strokeLinecap="round"
                opacity="0.3"
                transform="translate(0.9, 0.9)"
              />
            </g>
          ))}
        </g>

        {/* TEE scanline — conveys "working", never a fake percentage */}
        {working && (
          <g clipPath={`url(#face-${uid})`}>
            <rect
              x="10"
              y="86"
              width="180"
              height="22"
              fill={lit}
              opacity="0.26"
              style={{ animation: "seal-scan 1.7s ease-in-out infinite" }}
            />
          </g>
        )}
      </g>
    </svg>
  );
}
