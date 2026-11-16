import { useTexture } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type { SeatId } from "@kauda/rules";
import { useLayoutEffect, useMemo, useRef } from "react";
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BufferGeometry,
  Color,
  DoubleSide,
  Euler,
  Float32BufferAttribute,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type Texture,
} from "three";
import walnutUrl from "../../../assets/walnut.webp";
import { BOARD, boardTurn, seatAngle, SHELL, type ShellPose } from "../../../lib/board";
import { shellHalf } from "./shellGeometry";
import { baseTextures, readPalette, softSpot, type Palette } from "./textures";

/**
 * THE 3D BOARD (a still scene: no throw, no physics yet). Loaded as its own
 * chunk by BoardStage, so sign-in and the lobby never download three.js.
 *
 * A low round walnut board with a raised rim, on a floor that is the page
 * itself (the canvas is transparent, and only the shadows land on it). One
 * warm key light off to the left like a diyo on the floor, a very low warm
 * ambient, soft shadows. The camera sits on my side, about 45 degrees up.
 * The vignette is a CSS overlay (BoardStage), not a post-processing pass.
 *
 * Nothing moves, so the canvas renders only on demand. The lamp's flicker is
 * not drawn here: it is a CSS opacity animation on a warm overlay above the
 * canvas (BoardStage), which costs the GPU nothing in WebGL.
 *
 * No text is drawn in WebGL: seat names, chips and the result are DOM.
 */

export interface Stage3DProps {
  readonly poses: readonly ShellPose[];
  /** My seat (at the bottom of the screen); null for a chyakhe, who watches from teeya's side. */
  readonly mySeat: SeatId | null;
  /** The seat whose side of the board glows, or null. */
  readonly thrower: SeatId | null;
  /** The first frame with everything loaded is on screen. */
  readonly onReady: () => void;
  /** The GPU dropped the context: the caller falls back to 2D. */
  readonly onLost: () => void;
}

/**
 * Degrees above the horizon: steeper in portrait, where height is to spare
 * and a rounder board gives the shells more pixels; lower on a wide screen,
 * where the board is limited by height. And the vertical field of view.
 */
const ELEVATION = { portrait: (50 * Math.PI) / 180, landscape: (44 * Math.PI) / 180 };
const FOV = 30;
/** The diyo: low, off to my left and a little towards me. Fixed to the view, so every seat sees the same light. */
const LAMP = new Vector3(-1.75, 1.05, 0.55);
const KEY_INTENSITY = 11;

export default function Stage3D({ poses, mySeat, thrower, onReady, onLost }: Stage3DProps) {
  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 2]}
      shadows="percentage"
      gl={{ antialias: true, alpha: true, powerPreference: "default" }}
      camera={{ fov: FOV, near: 0.1, far: 40, position: [0, 3, 3] }}
      onCreated={({ gl }) => {
        gl.toneMapping = ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.2;
        gl.setClearColor(0x000000, 0);
        gl.domElement.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          onLost();
        });
      }}
      aria-hidden="true"
    >
      <Scene poses={poses} mySeat={mySeat} thrower={thrower} onReady={onReady} />
    </Canvas>
  );
}

function Scene({ poses, mySeat, thrower, onReady }: Omit<Stage3DProps, "onLost">) {
  const palette = useMemo(readPalette, []);
  return (
    <>
      <CameraRig />
      <Lights palette={palette} />
      <Floor palette={palette} />
      <group rotation-y={boardTurn(mySeat)}>
        <Board />
        <Shells poses={poses} palette={palette} />
        {thrower !== null && <ThrowerGlow seat={thrower} palette={palette} />}
      </group>
      <Ready onReady={onReady} />
    </>
  );
}

// ---------------------------------------------------------------- camera

/** Points round the board's rim and foot: what must fit on screen. */
const OUTLINE: readonly Vector3[] = (() => {
  const out: Vector3[] = [];
  for (let k = 0; k < 48; k += 1) {
    const a = (k / 48) * Math.PI * 2;
    out.push(new Vector3(Math.cos(a), BOARD.rimTop, Math.sin(a)), new Vector3(Math.cos(a), 0, Math.sin(a)));
  }
  return out;
})();

/**
 * Places the camera on my side, ELEVATION above the horizon, as close as it
 * can come with the whole board still on screen, then shifts the view so the
 * board sits in the middle (perspective makes the near edge bigger than the
 * far one). In portrait the board fills the width, so the shells are as big
 * as a phone allows; its rim can run under the side seat panels.
 */
function CameraRig() {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    if (width === 0 || height === 0) return;
    const portrait = width < height * 1.1;
    // In portrait the rim may run a little past the sides, under the seat panels, for bigger shells.
    const fitX = portrait ? 1.12 : 0.9;
    const elevation = portrait ? ELEVATION.portrait : ELEVATION.landscape;
    const fitY = portrait ? 0.96 : 0.92;
    // The far rim may tuck this far (px) under the seat panel across from me.
    const tuck = portrait ? 64 : 40;
    const top = fitY - (2 * tuck) / height;
    camera.fov = FOV;
    camera.aspect = width / height;
    camera.clearViewOffset();
    const p = new Vector3();
    const extent = (d: number) => {
      camera.position.set(0, d * Math.sin(elevation), d * Math.cos(elevation));
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      camera.updateProjectionMatrix();
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const v of OUTLINE) {
        p.copy(v).project(camera);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      return { minX, maxX, minY, maxY };
    };
    let lo = 1;
    let hi = 40;
    for (let k = 0; k < 40; k += 1) {
      const mid = (lo + hi) / 2;
      const e = extent(mid);
      if ((e.maxX - e.minX) / 2 <= fitX && e.maxY - e.minY <= top + fitY) hi = mid;
      else lo = mid;
    }
    const e = extent(hi);
    // Centre the board between the bottom margin and the tuck.
    const shift = (e.maxY + e.minY) / 2 - (top - fitY) / 2;
    camera.setViewOffset(width, height, 0, (-shift * height) / 2, width, height);
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, width, height, invalidate]);
  return null;
}

// ---------------------------------------------------------------- lights

function Lights({ palette }: { readonly palette: Palette }) {
  const target = useMemo(() => {
    const o = new Object3D();
    o.position.set(0.15, 0, -0.1);
    return o;
  }, []);
  // A flame is warm but not orange: the diyo's glow, taken halfway to ivory, so the shells stay ivory under it.
  const flame = useMemo(() => palette.color.glow.clone().lerp(palette.color.ink, 0.5), [palette]);

  return (
    <>
      <ambientLight color={flame} intensity={0.32} />
      <primitive object={target} />
      <spotLight
        color={flame}
        position={LAMP}
        target={target}
        intensity={KEY_INTENSITY}
        angle={0.95}
        penumbra={0.85}
        decay={1.6}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.006}
        shadow-camera-near={0.5}
        shadow-camera-far={6}
      />
    </>
  );
}

// ----------------------------------------------------------------- board

/** The rim and the board's edge, as one turned profile: (radius, height) from the playing surface outwards and down. */
const RIM_PROFILE: readonly Vector2[] = (
  [
  [BOARD.rimInner - 0.004, BOARD.surface],
  [BOARD.rimInner + 0.01, BOARD.surface + 0.012],
  [BOARD.rimInner + 0.022, BOARD.rimTop - 0.012],
  [BOARD.rimInner + 0.04, BOARD.rimTop - 0.001],
  [BOARD.rimInner + 0.065, BOARD.rimTop],
  [BOARD.radius - 0.02, BOARD.rimTop - 0.004],
  [BOARD.radius - 0.004, BOARD.rimTop - 0.022],
  [BOARD.radius, BOARD.rimTop - 0.045],
  [BOARD.radius - 0.004, 0.008],
  [BOARD.radius - 0.016, 0],
  ] as const
).map(([r, y]) => new Vector2(r, y));

function useWood(): { top: Texture; rim: Texture } {
  const walnut = useTexture(walnutUrl);
  const maxAniso = useThree((s) => s.gl.capabilities.getMaxAnisotropy());
  return useMemo(() => {
    const prepare = (t: Texture, u: number, v: number) => {
      t.colorSpace = SRGBColorSpace;
      t.wrapS = RepeatWrapping;
      t.wrapT = RepeatWrapping;
      t.repeat.set(u, v);
      t.anisotropy = Math.min(8, maxAniso);
      t.needsUpdate = true;
      return t;
    };
    // The surface's grain runs straight across; the rim's runs round it, as if bent.
    return { top: prepare(walnut.clone(), 1.25, 1.25), rim: prepare(walnut.clone(), 9, 0.18) };
  }, [walnut, maxAniso]);
}

function Board() {
  const wood = useWood();
  const rim = useMemo(() => new LatheGeometry(RIM_PROFILE as Vector2[], 128), []);
  return (
    <>
      <mesh position-y={BOARD.surface} rotation-x={-Math.PI / 2} receiveShadow>
        <circleGeometry args={[BOARD.rimInner + 0.006, 96]} />
        <meshStandardMaterial map={wood.top} roughness={0.72} metalness={0} />
      </mesh>
      <mesh geometry={rim} castShadow receiveShadow>
        <meshStandardMaterial map={wood.rim} roughness={0.5} metalness={0} side={DoubleSide} />
      </mesh>
    </>
  );
}

/** The floor is the page: this only catches the board's shadow, and grounds it with a soft dark contact patch. */
function Floor({ palette }: { readonly palette: Palette }) {
  const spot = useMemo(() => softSpot(2.3), []);
  return (
    <>
      <mesh rotation-x={-Math.PI / 2} position-y={0} receiveShadow>
        <planeGeometry args={[14, 14]} />
        <shadowMaterial color={palette.color.bg} opacity={0.6} transparent />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.001}>
        <planeGeometry args={[2.5, 2.5]} />
        <meshBasicMaterial color={palette.color.bg} alphaMap={spot} transparent opacity={0.75} depthWrite={false} toneMapped={false} />
      </mesh>
    </>
  );
}

// ---------------------------------------------------------------- shells

const FLIP = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);

/**
 * All sixteen shells in two draw calls: the glossy backs and the undersides,
 * instanced with the same matrices. A face-up shell is turned over about its
 * length, so it rests on its dome with the slit showing.
 */
function Shells({ poses, palette }: { readonly poses: readonly ShellPose[]; readonly palette: Palette }) {
  const back = useRef<InstancedMesh>(null);
  const base = useRef<InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  const geometry = useMemo(() => ({ back: shellHalf("back"), base: shellHalf("base") }), []);
  const textures = useMemo(() => baseTextures(palette), [palette]);

  useLayoutEffect(() => {
    const meshes = [back.current, base.current];
    const m = new Matrix4();
    const q = new Quaternion();
    const e = new Euler();
    const position = new Vector3();
    const scale = new Vector3();
    const tint = new Color();
    poses.forEach((p, i) => {
      const rest = (p.up ? SHELL.dome : SHELL.base) * p.scale;
      position.set(p.x, BOARD.surface + rest + p.lift, p.z);
      q.setFromEuler(e.set(p.roll, p.yaw, p.pitch, "YXZ"));
      if (p.up) q.multiply(FLIP);
      m.compose(position, q, scale.setScalar(p.scale));
      tint.copy(palette.color.shell).lerp(palette.color["shell-light"], p.tint);
      for (const mesh of meshes) {
        mesh?.setMatrixAt(i, m);
        mesh?.setColorAt(i, tint);
      }
    });
    for (const mesh of meshes) {
      if (mesh === null) continue;
      mesh.count = poses.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    invalidate();
  }, [poses, palette, invalidate]);

  return (
    <>
      <instancedMesh ref={back} args={[geometry.back, undefined, 16]} castShadow receiveShadow>
        <meshPhysicalMaterial roughness={0.3} clearcoat={0.8} clearcoatRoughness={0.22} sheen={0.3} sheenColor={palette.color["shell-light"]} />
      </instancedMesh>
      <instancedMesh ref={base} args={[geometry.base, undefined, 16]} castShadow receiveShadow>
        <meshStandardMaterial map={textures.map} bumpMap={textures.bump} bumpScale={1.6} roughness={0.55} />
      </instancedMesh>
    </>
  );
}

// ---------------------------------------------------------- thrower glow

/**
 * The thrower's side of the board: a soft brass glow lying on the rim and
 * the edge of the surface, brightest at the middle of their side and fading
 * round the rim either way. Additive, so black adds nothing: the falloff is
 * in the vertex colours.
 */
function rimGlowGeometry(brass: Color): BufferGeometry {
  const ARC = 1.5;
  const ALONG = 40;
  const ACROSS = 6;
  const inner = BOARD.rimInner - 0.12;
  const outer = BOARD.radius + 0.01;
  const positions: number[] = [];
  const colours: number[] = [];
  const index: number[] = [];
  const c = new Color();
  for (let i = 0; i <= ALONG; i += 1) {
    const u = i / ALONG;
    const a = (u - 0.5) * ARC;
    const along = Math.sin(Math.PI * u) ** 2;
    for (let j = 0; j <= ACROSS; j += 1) {
      const v = j / ACROSS;
      const r = inner + (outer - inner) * v;
      // Brightest on the rim, fading inwards over the wood and outwards off the edge.
      const across = Math.exp(-(((r - (BOARD.rimInner + 0.05)) / 0.07) ** 2));
      const y = (r < BOARD.rimInner ? BOARD.surface : BOARD.rimTop) + 0.003;
      positions.push(r * Math.sin(a), y, r * Math.cos(a));
      c.copy(brass).multiplyScalar(0.85 * along * across);
      colours.push(c.r, c.g, c.b);
    }
  }
  const row = ACROSS + 1;
  for (let i = 0; i < ALONG; i += 1) {
    for (let j = 0; j < ACROSS; j += 1) {
      const p = i * row + j;
      index.push(p, p + 1, p + row, p + 1, p + row + 1, p + row);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(positions, 3));
  g.setAttribute("color", new Float32BufferAttribute(colours, 3));
  g.setIndex(index);
  return g;
}

function ThrowerGlow({ seat, palette }: { readonly seat: SeatId; readonly palette: Palette }) {
  const geometry = useMemo(() => rimGlowGeometry(palette.color.brass), [palette]);
  return (
    <mesh geometry={geometry} rotation-y={seatAngle(seat)}>
      <meshBasicMaterial vertexColors blending={AdditiveBlending} transparent depthWrite={false} toneMapped={false} side={DoubleSide} />
    </mesh>
  );
}

// ------------------------------------------------------------------ ready

/** Tells the page once the first full frame is on screen (tests wait for it). */
function Ready({ onReady }: { readonly onReady: () => void }) {
  const done = useRef(false);
  useFrame(() => {
    if (done.current) return;
    done.current = true;
    requestAnimationFrame(() => onReady());
  });
  return null;
}
