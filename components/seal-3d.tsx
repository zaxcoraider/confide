"use client";

/**
 * The WebGL seal — Design.md §5, the signature element.
 *
 * PROGRESSIVE ENHANCEMENT ONLY (Rules.md §5). Nothing here is on the path of
 * any P0 flow: if WebGL fails to initialise, the SVG seal stays and every
 * decrypt/stage/execute/grant still works. This module is dynamically imported
 * and never appears in the initial bundle.
 *
 * The silhouette and sigil come from lib/seal-geometry.ts — the SAME functions
 * the SVG seal uses — so the 3D object is the same seal, not a different one.
 */
import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { blobPolygon, sigilNodes, sigilPairs } from "@/lib/seal-geometry";

const WAX = "#D4863C";
const WAX_DEEP = "#6E3F17";

function WaxDisc({ handle, reduced }: { handle: string; reduced: boolean }) {
  const group = useRef<THREE.Group>(null);

  // Extrude the molten outline into a real disc with a bevelled edge. This is
  // what makes it read as wax rather than as a flat badge with a shadow.
  //
  // Built from a pre-sampled polygon rather than from THREE curves — see
  // blobPolygon's note on why the curve-built version silently produced an
  // empty geometry.
  const bodyGeometry = useMemo(() => {
    const shape = new THREE.Shape(
      blobPolygon(handle, 1, 0.22).map(([x, y]) => new THREE.Vector2(x, y)),
    );
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: 0.16,
      bevelEnabled: true,
      bevelThickness: 0.07,
      bevelSize: 0.07,
      bevelSegments: 6,
    });
    geometry.computeBoundingBox();
    // Guard the failure mode explicitly: centering an empty geometry translates
    // by NaN and the mesh vanishes without an error anywhere.
    if (geometry.boundingBox && !Number.isNaN(geometry.boundingBox.min.x)) {
      geometry.center();
    }
    geometry.computeVertexNormals();
    return geometry;
  }, [handle]);

  // The sigil, floating just proud of the face so it catches the key light.
  const sigilGeometry = useMemo(() => {
    const nodes = sigilNodes(handle, 1 / 38);
    const positions: number[] = [];
    for (const [a, b] of sigilPairs(handle)) {
      positions.push(nodes[a]![0], nodes[a]![1], 0.13, nodes[b]![0], nodes[b]![1], 0.13);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
  }, [handle]);

  useFrame((state) => {
    if (!group.current || reduced) return;
    const t = state.clock.elapsedTime;
    // A slow, wax-heavy turn with a shallow tilt — not a spin. The seal should
    // feel like an object being examined, not a loading indicator.
    group.current.rotation.y = Math.sin(t * 0.28) * 0.55;
    group.current.rotation.x = -0.32 + Math.sin(t * 0.21) * 0.09;
    group.current.position.y = Math.sin(t * 0.5) * 0.03;
  });

  return (
    <group ref={group} rotation={[-0.32, 0, 0]}>
      <mesh geometry={bodyGeometry}>
        <meshPhysicalMaterial
          color={WAX}
          roughness={0.42}
          metalness={0.05}
          clearcoat={0.6}
          clearcoatRoughness={0.5}
          sheen={0.8}
          sheenColor="#FFD9A0"
          emissive={WAX_DEEP}
          emissiveIntensity={0.14}
        />
      </mesh>
      <lineSegments geometry={sigilGeometry}>
        <lineBasicMaterial color="#FFE0B2" transparent opacity={0.75} />
      </lineSegments>
    </group>
  );
}

/**
 * Does this browser actually give us a working WebGL2 context right now?
 *
 * Not a theoretical check. A machine can advertise WebGL and still hand back a
 * context that renders nothing — a blacklisted or crashed GPU process does
 * exactly that, and it happened on the development machine mid-build. The hero
 * must never be a silent empty rectangle, least of all while being recorded.
 */
export function canRenderWebGL(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return false;
    // A context that reports itself already lost is worse than none at all.
    return !(gl as WebGLRenderingContext).isContextLost();
  } catch {
    return false;
  }
}

export default function Seal3D({
  handle,
  className = "",
  onFailure,
}: {
  handle: string;
  className?: string;
  /** Called if the context dies after mount, so the caller can fall back. */
  onFailure?: () => void;
}) {
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // pointer-events lives on a WRAPPER, not on <Canvas>. Passing `style` to
  // Canvas competes with the sizing styles R3F sets on its own container, and
  // the failure mode is a zero-height canvas that renders nothing and reports
  // no error.
  return (
    <div className={`pointer-events-none h-full w-full ${className}`}>
      <Canvas
        camera={{ position: [0, 0, 3.4], fov: 42 }}
        dpr={[1, 2]}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener("webglcontextlost", () => onFailure?.());
        }}
      >
        {/* Low raking key, as wax would take it, plus a cool rim to separate it
            from the ink field. */}
        <ambientLight intensity={0.35} />
        <directionalLight position={[-3, 3.5, 4]} intensity={2.6} color="#FFE9C8" />
        <directionalLight position={[4, -1.5, -2]} intensity={0.9} color="#5E7FA8" />
        <WaxDisc handle={handle} reduced={!!reduced} />
      </Canvas>
    </div>
  );
}
