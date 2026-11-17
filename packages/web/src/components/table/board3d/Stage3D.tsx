import { useTexture } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type { SeatId } from "@kauda/rules";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedMesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
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
import { BOARD, boardTurn, RIM_PROFILE, seatAngle, SHELL_SET } from "../../../lib/board";
import { BoardDirector, type DirectorOutput, type Layout, type Phase, type Shown, type SoundCue, type ThrowEvent } from "../../../lib/throw/director";
import type { HandFrame, HandPhase } from "../../../lib/throw/hand";
import { Hand } from "./Hand";
import type { EdgeGlow } from "../Stage";
import { MESH } from "../../../lib/throw/playback";
import { shellHalf } from "./shellGeometry";
import { createSimClient } from "./simClient";
import { baseTextures, readPalette, softSpot, type Palette } from "./textures";

/**
 * THE 3D BOARD. Loaded as its own chunk by BoardStage, so sign-in and the
 * lobby never download three.js.
 *
 * A low round walnut board with a raised rim, on a floor that is the page
 * itself (the canvas is transparent, and only the shadows land on it). One
 * warm key light off to the left like a diyo on the floor, a very low warm
 * ambient, soft shadows. The camera sits on my side, about 45 degrees up.
 * The vignette is a CSS overlay (BoardStage), not a post-processing pass.
 *
 * THE THROW. The shells are driven by the BoardDirector
 * (lib/throw/director.ts): it says where every shell is on every frame,
 * gathering, flying through a throw recorded by the physics worker
 * (simClient.ts, throw.worker.ts), or lying still. The canvas renders every
 * frame only while something moves, and on demand otherwise. The physics
 * starts once the board's first frame is on screen.
 *
 * The lamp's flicker is not drawn here: it is a CSS opacity animation on a
 * warm overlay above the canvas (BoardStage), which costs WebGL nothing.
 *
 * No text is drawn in WebGL: seat names, chips and the result are DOM.
 */

/** What the board is doing, for the page's data attributes and the tests. */
export interface BoardStatus {
  readonly layout: Layout;
  readonly phase: Phase;
  /** The hand's phase, or "none". */
  readonly hand: HandPhase | "none";
  /** The hand holds at the physics' own release point. */
  readonly handAnchored: boolean;
}

export interface Stage3DProps {
  /** The round being played, for simulating its throw ahead and gathering for it. */
  readonly current: { readonly roundId: string; readonly thrower: SeatId; readonly phase: "betting" | "throwing" } | null;
  /** The settled round on show: the shells lie where it left them. Null before the first. */
  readonly shown: Shown | null;
  /** A result held back until the shells rest: play its throw, then call onRevealed. */
  readonly reveal: Shown | null;
  /** I pressed Throw for the current round: gather at once. */
  readonly pressed: boolean;
  readonly reduced: boolean;
  readonly onRevealed: (roundId: string) => void;
  /** What the board is doing, for the page's data attributes. */
  readonly onStatus?: (status: BoardStatus) => void;
  /** Hooks for sound (no audio yet): the scoop, each shake, the release. */
  readonly onSound?: (cue: SoundCue, e: ThrowEvent) => void;
  /** No idle motion (automated test browsers): the held hand keeps still while it waits. */
  readonly quiet?: boolean;
  /** My seat (at the bottom of the screen); null for a chyakhe, who watches from teeya's side. */
  readonly mySeat: SeatId | null;
  /** Which side of the board's edge glows, and how (the thrower's; a hit's pulse; a miss's winner), or null. */
  readonly glow: EdgeGlow | null;
  /** Face-up shells lit by the count so far (all, once counted), for the round on show; null: none lit, none dimmed. */
  readonly lit: number | null;
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

export default function Stage3D({ onLost, ...props }: Stage3DProps) {
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
      <Scene {...props} />
    </Canvas>
  );
}

function Scene({ mySeat, glow, onReady, ...throwProps }: Omit<Stage3DProps, "onLost">) {
  // The hand's frame, written by the shells' director every frame, and its release signal.
  const handFrame = useRef<HandFrame | null>(null);
  const releases = useMemo(() => {
    const listeners = new Set<(e: ThrowEvent) => void>();
    return {
      emit: (e: ThrowEvent) => listeners.forEach((l) => l(e)),
      subscribe: (l: (e: ThrowEvent) => void) => {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
    };
  }, []);
  const handSeat = throwProps.current?.thrower ?? throwProps.reveal?.thrower ?? "teeya";
  const palette = useMemo(readPalette, []);
  return (
    <>
      <CameraRig />
      <Lights palette={palette} />
      <Floor palette={palette} />
      <group rotation-y={boardTurn(mySeat)}>
        <Board />
        <Shells {...throwProps} turn={boardTurn(mySeat)} palette={palette} handFrame={handFrame} onRelease={releases.emit} />
        {/* After the shells, so it reads the frame they have just written. */}
        <Hand seat={handSeat} frame={handFrame} onRelease={releases.subscribe} palette={palette} />
        {glow !== null && <EdgeGlowMesh key={`${glow.seat}:${glow.kind}`} glow={glow} still={throwProps.reduced} palette={palette} />}
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

const RIM_LATHE: Vector2[] = RIM_PROFILE.map(([r, y]) => new Vector2(r, y));

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
  const rim = useMemo(() => new LatheGeometry(RIM_LATHE, 128), []);
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

type ShellsProps = Pick<Stage3DProps, "current" | "shown" | "reveal" | "pressed" | "reduced" | "quiet" | "lit" | "onRevealed" | "onStatus" | "onSound"> & {
  /** How far the board is turned for my seat: the count lights shells near to far from me. */
  readonly turn: number;
  readonly palette: Palette;
  readonly handFrame: { current: HandFrame | null };
  readonly onRelease: (e: ThrowEvent) => void;
};

/**
 * All sixteen shells in two draw calls: the glossy backs and the undersides,
 * instanced with the same matrices, placed every frame from the director's
 * mesh frame. Shell i keeps its own size and tint (SHELL_SET).
 */
function Shells({ palette, handFrame, onRelease, turn, ...props }: ShellsProps) {
  const back = useRef<InstancedMesh>(null);
  const base = useRef<InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  const geometry = useMemo(() => ({ back: shellHalf("back"), base: shellHalf("base") }), []);
  const textures = useMemo(() => baseTextures(palette), [palette]);

  // The latest props, read every frame without re-creating the director.
  const latest = useRef(props);
  latest.current = props;
  const status = useRef("");

  const { director, sims } = useMemo(() => {
    const sims = createSimClient(() => invalidate());
    const director = new BoardDirector(sims, {
      onRevealed: (id) => latest.current.onRevealed(id),
      onRelease: (e) => onRelease(e),
      onSound: (cue, e) => latest.current.onSound?.(cue, e),
      onFallback: (id, why) => console.warn(`Round ${id}: no throw to play (${why}); the shells fade to the seeded scatter.`),
    });
    return { director, sims };
  }, [invalidate, onRelease]);
  useEffect(() => () => sims.dispose(), [sims]);

  const tick = (): DirectorOutput => {
    const p = latest.current;
    return director.update({
      now: performance.now(),
      current: p.current,
      shown: p.shown,
      reveal: p.reveal,
      pressed: p.pressed,
      reduced: p.reduced,
      hidden: document.visibilityState === "hidden",
      quiet: p.quiet === true,
    });
  };

  // A new prop (a round, a result, a press, a shell counted) may change something: draw.
  const { current, shown, reveal, pressed, reduced, lit } = props;
  useEffect(() => invalidate(), [current, shown, reveal, pressed, reduced, lit, invalidate]);
  // A hidden tab draws no frames: settle a throw in progress at once, so its result is not held.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") tick();
      else invalidate();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  });

  // Each shell's own tint; and, while the count plays and after, lit in brass or dimmed.
  const tints = useMemo(() => SHELL_SET.map((look) => palette.color.shell.clone().lerp(palette.color["shell-light"], look.tint)), [palette]);
  const colourKey = useRef("");
  const glows = useRef<InstancedMesh>(null);
  const glowTexture = useMemo(() => softSpot(1.6), []);
  const applyColours = (out: DirectorOutput) => {
    const p = latest.current;
    // Only for the shells lying still where the round on show left them.
    const lighting = p.lit !== null && p.shown !== null && out.phase === "still" && (out.layout === "sim" || out.layout === "scatter");
    const order = lighting ? countOrder(out.frame, p.shown?.faces ?? [], turn) : [];
    const lit = new Set(order.slice(0, lighting ? (p.lit ?? 0) : 0));
    const key = lighting ? `${p.shown?.roundId}:${[...lit].join(",")}:${turn}` : "plain";
    if (key === colourKey.current) return;
    colourKey.current = key;
    const c = new Color();
    for (const mesh of [back.current, base.current]) {
      if (mesh === null) continue;
      tints.forEach((tint, i) => {
        c.copy(tint);
        if (lighting && lit.has(i)) c.lerp(palette.color.brass, 0.35).multiplyScalar(1.35);
        else if (lighting && p.shown?.faces[i] !== true) c.multiplyScalar(0.62);
        mesh.setColorAt(i, c);
      });
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    }
    // A warm brass glow on the board under each lit shell.
    const g = glows.current;
    if (g !== null) {
      let n = 0;
      for (const i of lit) {
        const o = i * MESH;
        position.set(out.frame[o] ?? 0, BOARD.surface + 0.002, out.frame[o + 2] ?? 0);
        g.setMatrixAt(n, m.compose(position, FLAT, scale.setScalar(0.34 * (out.frame[o + 7] ?? 1))));
        n += 1;
      }
      g.count = n;
      g.instanceMatrix.needsUpdate = true;
    }
  };

  const m = useMemo(() => new Matrix4(), []);
  const position = useMemo(() => new Vector3(), []);
  const q = useMemo(() => new Quaternion(), []);
  const scale = useMemo(() => new Vector3(), []);
  useFrame(() => {
    const out = tick();
    const f = out.frame;
    for (const mesh of [back.current, base.current]) {
      if (mesh === null) continue;
      for (let i = 0; i < SHELL_SET.length; i += 1) {
        const o = i * MESH;
        position.set(f[o] ?? 0, f[o + 1] ?? 0, f[o + 2] ?? 0);
        q.set(f[o + 3] ?? 0, f[o + 4] ?? 0, f[o + 5] ?? 0, f[o + 6] ?? 1);
        // Never exactly 0 (a shell hidden in the fist): a zero scale makes the normals NaN, and the
        // lamp's shadow pass pushes every vertex along its normal (normalBias), so NaN vertices
        // could put the whole board in shadow. A ten-thousandth of its size is as good as gone.
        mesh.setMatrixAt(i, m.compose(position, q, scale.setScalar(Math.max(f[o + 7] ?? 1, 1e-4))));
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = out.opacity > 0;
      const material = mesh.material as MeshStandardMaterial;
      const fading = out.opacity < 1;
      if (material.transparent !== fading) {
        material.transparent = fading;
        material.needsUpdate = true;
      }
      material.opacity = out.opacity;
    }
    applyColours(out);
    handFrame.current = out.hand;
    const hand = out.hand?.phase ?? "none";
    const s = `${out.layout}:${out.phase}:${hand}:${out.handAnchored}`;
    if (s !== status.current) {
      status.current = s;
      latest.current.onStatus?.({ layout: out.layout, phase: out.phase, hand, handAnchored: out.handAnchored });
    }
    if (out.moving) invalidate();
  });

  return (
    <>
      <instancedMesh ref={back} args={[geometry.back, undefined, 16]} castShadow receiveShadow frustumCulled={false}>
        <meshPhysicalMaterial roughness={0.3} clearcoat={0.8} clearcoatRoughness={0.22} sheen={0.3} sheenColor={palette.color["shell-light"]} />
      </instancedMesh>
      <instancedMesh ref={base} args={[geometry.base, undefined, 16]} castShadow receiveShadow frustumCulled={false}>
        <meshStandardMaterial map={textures.map} bumpMap={textures.bump} bumpScale={1.6} roughness={0.55} />
      </instancedMesh>
      <instancedMesh ref={glows} args={[GLOW_PLANE, undefined, 16]} count={0} frustumCulled={false} renderOrder={1}>
        <meshBasicMaterial color={palette.color.brass} alphaMap={glowTexture} transparent opacity={0.55} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </instancedMesh>
    </>
  );
}

/** A flat square on the board, for the glow under a lit shell. */
const GLOW_PLANE = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const FLAT = new Quaternion();

/**
 * The order the count lights the face-up shells: near to far from my seat
 * (the board turned by `turn`, my side towards +z), then left to right.
 */
export function countOrder(frame: ArrayLike<number>, faces: readonly boolean[], turn: number): number[] {
  const c = Math.cos(turn);
  const sn = Math.sin(turn);
  const at = (i: number) => {
    const x = frame[i * MESH] ?? 0;
    const z = frame[i * MESH + 2] ?? 0;
    return { near: -x * sn + z * c, across: x * c + z * sn };
  };
  return faces
    .map((up, i) => (up ? i : -1))
    .filter((i) => i >= 0)
    .sort((a, b) => at(b).near - at(a).near || at(a).across - at(b).across || a - b);
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

/** How bright each kind of edge glow is: the thrower's, a hit (after its pulse), a miss's winner (soft). */
const GLOW_STRENGTH = { thrower: 1, hit: 1.25, win: 0.55 } as const;
/** A hit pulses brass this long before it settles. */
const PULSE_MS = 1500;

/**
 * A seat's side of the board's edge, lit: the thrower's while a round is
 * played; on a hit, the thrower's side pulses brass, then stays bright; on
 * a miss, the winning seat's side glows softly. No pulse when `still`
 * (reduced motion).
 */
function EdgeGlowMesh({ glow, still, palette }: { readonly glow: EdgeGlow; readonly still: boolean; readonly palette: Palette }) {
  const geometry = useMemo(() => rimGlowGeometry(palette.color.brass), [palette]);
  const material = useRef<MeshBasicMaterial>(null);
  const invalidate = useThree((s) => s.invalidate);
  const born = useMemo(() => performance.now(), []);
  useFrame(() => {
    const m = material.current;
    if (m === null) return;
    const base = GLOW_STRENGTH[glow.kind];
    const t = performance.now() - born;
    const pulsing = glow.kind === "hit" && !still && t < PULSE_MS;
    // Three beats, fading into the steady glow.
    const pulse = pulsing ? 0.9 * Math.abs(Math.sin((3 * Math.PI * t) / PULSE_MS)) * (1 - t / PULSE_MS) : 0;
    m.color.setScalar(base + pulse);
    if (pulsing) invalidate();
  });
  return (
    <mesh geometry={geometry} rotation-y={seatAngle(glow.seat)}>
      <meshBasicMaterial ref={material} vertexColors blending={AdditiveBlending} transparent depthWrite={false} toneMapped={false} side={DoubleSide} />
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
