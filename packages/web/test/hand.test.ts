import { describe, expect, it } from "vitest";
import { Color, Group, Vector3 } from "three";
import { applyPose, buildHand, handTriangles } from "../src/components/table/board3d/Hand";
import { blendPose, PALM_ANCHOR, POSES, type HandPose } from "../src/lib/throw/hand";
import { handRotation, rotate, wristFor } from "../src/lib/throw/handSequence";

/** The stylised hand built in code: its budget, its poses, and the frame it is placed by. */

describe("the hand model", () => {
  const rig = buildHand(new Color("#8d5b3c"), new Color("#2a201b"));

  it("stays under 3,000 triangles, sleeve included", () => {
    const n = handTriangles(rig);
    console.log(`the hand: ${n} triangles`);
    expect(n).toBeLessThan(3000);
  });

  it("has a palm, four fingers of three joints, a thumb of two, a wrist and a sleeve", () => {
    expect(rig.fingers).toHaveLength(4);
    for (const f of rig.fingers) expect(f).toHaveLength(4); // the knuckle (spread) and three joints
    expect(rig.thumb).toHaveLength(3); // its root and two joints
    expect(rig.sleeve.vertexColors).toBe(true); // the sleeve fades out along its length
  });

  it("closes into a fist: every fingertip ends up near the palm", () => {
    const tip = (pose: HandPose) => {
      applyPose(rig, pose);
      rig.root.updateMatrixWorld(true);
      const end = rig.fingers[1]?.[3] as Group;
      return end.localToWorld(new Vector3(0, 0, 0.065));
    };
    const open = tip(POSES.open);
    const fist = tip(POSES.fist);
    // Open: out past the knuckles. Fist: curled back under the palm.
    expect(open.z).toBeGreaterThan(0.45);
    expect(fist.z).toBeLessThan(0.35);
    expect(fist.y).toBeLessThan(0);
  });

  it("moves between poses joint by joint", () => {
    const half = blendPose(POSES.open, POSES.fist, 0.5);
    expect(half.fingers[0].mcp).toBeCloseTo((POSES.open.fingers[0].mcp + POSES.fist.fingers[0].mcp) / 2, 9);
    const end = blendPose(POSES.cupped, POSES.flung, 1);
    end.fingers.forEach((f, i) => expect(f.mcp).toBeCloseTo(POSES.flung.fingers[i]?.mcp ?? 0, 12));
  });

  it("places the wrist so the palm's anchor lands where the sequence puts it", () => {
    const q = handRotation([0.3, 0.5, -0.8], [0, 1, 0]);
    const anchor = [0.1, 0.46, 0.95] as const;
    const wrist = wristFor(anchor, q);
    const back = rotate(q, PALM_ANCHOR);
    for (let k = 0; k < 3; k += 1) expect((wrist[k] ?? 0) + (back[k] ?? 0)).toBeCloseTo(anchor[k] ?? 0, 12);
  });
});
