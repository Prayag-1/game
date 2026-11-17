import { useFrame } from "@react-three/fiber";
import type { SeatId } from "@kauda/rules";
import { useEffect, useMemo } from "react";
import {
  BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Object3D,
} from "three";
import { HAND, type HandFrame, type HandPose } from "../../../lib/throw/hand";
import type { ThrowEvent } from "../../../lib/throw/director";
import type { Palette } from "./textures";

/**
 * THE HAND (the stylised one, built in code). Swappable: a realistic rigged
 * hand replaces this one file and keeps its props.
 *
 * Props, the whole interface:
 *   seat       whose hand: it reaches in from that seat's side of the board
 *              and withdraws to it.
 *   frame      where it is in the sequence: a ref the board writes every
 *              frame, before the hand draws (HandFrame, lib/throw/hand.ts:
 *              phase and progress, the wrist's position and rotation, the
 *              palm's anchor, where the forearm runs, the pose as joint
 *              angles, and its opacity). Null: no hand.
 *   onRelease  subscribes to the release, the instant the shells leave the
 *              hand (the physics' first frame). This hand needs nothing more
 *              than the frame; a rigged one can start its fling clip here.
 *
 * The timing lives in the sequence (lib/throw/handSequence.ts and the
 * director), never in the model: a rigged hand maps `phase` and `progress`
 * to its own clips, holds `wrist`/`rotation`, and keeps its palm on
 * `anchor`.
 *
 * This one: an ellipsoid palm, four fingers of three capsules each, a thumb
 * of two, a wrist, and a plain sleeve that runs back towards `shoulder`,
 * fading out into the dark beyond the board. Lit by the board's lamp.
 */
export interface HandProps {
  readonly seat: SeatId;
  readonly frame: { readonly current: HandFrame | null };
  readonly onRelease: (listener: (e: ThrowEvent) => void) => () => void;
  readonly palette: Palette;
}

/** Segments round each capsule, and down each cap: smooth at phone size, cheap. */
const RADIAL = 8;
const CAP = 3;

/** A capsule along +z from the origin (centre to centre `length`), for one finger bone. */
function bone(radius: number, length: number, taper = 0.92): BufferGeometry {
  const g = new CapsuleGeometry(radius, length, CAP, RADIAL);
  // Narrower towards the tip, like a finger.
  const pos = g.getAttribute("position");
  for (let i = 0; i < pos.count; i += 1) {
    const y = pos.getY(i);
    const k = 1 - (1 - taper) * ((y + length / 2) / length);
    pos.setX(i, pos.getX(i) * k);
    pos.setZ(i, pos.getZ(i) * k);
  }
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, length / 2);
  g.computeVertexNormals();
  return g;
}

/** The sleeve: an open tube along +z, its vertex alpha fading from 1 to 0 over HAND.sleeve.fade. */
function sleeveGeometry(): BufferGeometry {
  const { radius, cuff, length, fade } = HAND.sleeve;
  const g = new CylinderGeometry(radius * 1.15, radius, length, 14, 10, true);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, cuff + length / 2);
  const pos = g.getAttribute("position");
  const colours: number[] = [];
  for (let i = 0; i < pos.count; i += 1) {
    const along = pos.getZ(i) - cuff;
    const alpha = Math.max(0, Math.min(1, 1 - (along - fade[0]) / (fade[1] - fade[0])));
    colours.push(1, 1, 1, alpha);
  }
  g.setAttribute("color", new Float32BufferAttribute(colours, 4));
  return g;
}

interface Rig {
  readonly root: Group;
  readonly hand: Group;
  readonly arm: Group;
  /** [finger][knuckle, middle, end]. */
  readonly fingers: Group[][];
  readonly thumb: Group[];
  readonly skin: MeshStandardMaterial;
  readonly sleeve: MeshStandardMaterial;
  readonly meshes: Mesh[];
}

/** Builds the hand, all its parts under one root. */
export function buildHand(skinColour: Color, sleeveColour: Color): Rig {
  const skin = new MeshStandardMaterial({ color: skinColour, roughness: 0.62, metalness: 0 });
  const sleeve = new MeshStandardMaterial({ color: sleeveColour, roughness: 0.92, metalness: 0, vertexColors: true, transparent: true, depthWrite: false });
  const meshes: Mesh[] = [];
  const mesh = (g: BufferGeometry, m: MeshStandardMaterial, parent: Object3D, shadow = true) => {
    const x = new Mesh(g, m);
    x.castShadow = shadow;
    x.receiveShadow = true;
    parent.add(x);
    meshes.push(x);
    return x;
  };

  const root = new Group();
  const hand = new Group();
  const arm = new Group();
  root.add(hand, arm);

  // The palm: a flattened rounded body from the wrist to the knuckles.
  const { width, length, thickness } = HAND.palm;
  const palm = mesh(new SphereGeometry(1, 14, 9), skin, hand);
  palm.scale.set(width / 2, thickness / 2, length / 2 + 0.02);
  palm.position.set(0, 0, length / 2);
  // The wrist, joining palm and forearm.
  mesh(new SphereGeometry(HAND.wrist.radius, 12, 8), skin, hand);

  const fingers = HAND.fingers.map((f, i) => {
    const joints: Group[] = [];
    let parent: Object3D = hand;
    const knuckle = new Group();
    knuckle.position.set(HAND.knuckles[i] ?? 0, 0.008, length - 0.025);
    parent.add(knuckle);
    parent = knuckle;
    f.lengths.forEach((len, k) => {
      const joint = new Group();
      if (k > 0) joint.position.set(0, 0, f.lengths[k - 1] ?? 0);
      parent.add(joint);
      mesh(bone(f.radius * (1 - 0.1 * k), len), skin, joint);
      joints.push(joint);
      parent = joint;
    });
    // The knuckle group carries the spread; joints[0] the MCP bend.
    return [knuckle, ...joints];
  });

  const thumb: Group[] = [];
  const thumbRoot = new Group();
  thumbRoot.position.set(...HAND.thumb.base);
  hand.add(thumbRoot);
  let parent: Object3D = thumbRoot;
  HAND.thumb.lengths.forEach((len, k) => {
    const joint = new Group();
    if (k > 0) joint.position.set(0, 0, HAND.thumb.lengths[k - 1] ?? 0);
    parent.add(joint);
    mesh(bone(HAND.thumb.radius * (1 - 0.12 * k), len, 0.9), skin, joint);
    thumb.push(joint);
    parent = joint;
  });
  thumb.unshift(thumbRoot);

  // The forearm: a little skin, then the sleeve, running back from the wrist.
  mesh(bone(HAND.wrist.radius, HAND.sleeve.cuff, 1.08), skin, arm);
  mesh(sleeveGeometry(), sleeve, arm, false);

  return { root, hand, arm, fingers: fingers as Group[][], thumb, skin, sleeve, meshes };
}

/** Sets every joint from a pose. */
export function applyPose(rig: Rig, pose: HandPose): void {
  pose.fingers.forEach((f, i) => {
    const [knuckle, a, b, c] = rig.fingers[i] as [Group, Group, Group, Group];
    knuckle.rotation.set(0, f.spread, 0);
    a.rotation.set(f.mcp, 0, 0);
    b.rotation.set(f.pip, 0, 0);
    c.rotation.set(f.dip, 0, 0);
  });
  const [root, a, b] = rig.thumb as [Group, Group, Group];
  // The thumb swings out from along the index finger towards its own side, tilted down towards the palm.
  root.rotation.set(0.35, 0.25 + 0.75 * pose.thumb.swing, -0.7, "YXZ");
  a.rotation.set(pose.thumb.mcp, 0, 0);
  b.rotation.set(pose.thumb.ip, 0, 0);
}

/** Triangles in the whole hand, sleeve included. */
export function handTriangles(rig: Rig): number {
  return rig.meshes.reduce((sum, m) => {
    const g = m.geometry;
    return sum + (g.index !== null ? g.index.count : g.getAttribute("position").count) / 3;
  }, 0);
}

const Z = new Vector3(0, 0, 1);

export function Hand({ frame, onRelease, palette }: HandProps) {
  const rig = useMemo(() => buildHand(palette.color.skin, palette.color.sleeve), [palette]);
  useEffect(
    () => () => {
      for (const m of rig.meshes) m.geometry.dispose();
      rig.skin.dispose();
      rig.sleeve.dispose();
    },
    [rig],
  );
  // This hand reads everything from the frame; the release needs nothing extra.
  useEffect(() => onRelease(() => {}), [onRelease]);

  const toShoulder = useMemo(() => new Vector3(), []);
  const q = useMemo(() => new Quaternion(), []);
  useFrame(() => {
    const f = frame.current;
    rig.root.visible = f !== null && f.opacity > 0;
    if (f === null) return;
    rig.hand.position.set(...f.wrist);
    rig.hand.quaternion.set(...f.rotation);
    applyPose(rig, f.pose);
    // The forearm runs from the wrist towards the shoulder, whatever the hand is doing.
    rig.arm.position.set(...f.wrist);
    toShoulder.set(f.shoulder[0] - f.wrist[0], f.shoulder[1] - f.wrist[1], f.shoulder[2] - f.wrist[2]).normalize();
    rig.arm.quaternion.copy(q.setFromUnitVectors(Z, toShoulder));
    const fading = f.opacity < 1;
    if (rig.skin.transparent !== fading) {
      rig.skin.transparent = fading;
      rig.skin.needsUpdate = true;
    }
    rig.skin.opacity = f.opacity;
    rig.sleeve.opacity = f.opacity;
  });

  return <primitive object={rig.root} />;
}
