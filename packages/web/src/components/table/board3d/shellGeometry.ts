import { BufferGeometry, Float32BufferAttribute } from "three";
import { SHELL } from "../../../lib/board";

/**
 * A cowrie, modelled in code: an elongated dome about 3:2, smooth and
 * rounded on top, flatter underneath. Built as two halves that meet at the
 * shell's edge, so each can have its own material: the glossy back, and the
 * underside, whose slit and teeth are drawn by a texture and a bump map
 * (geometry fine enough for teeth would cost thousands of triangles a shell
 * and still alias at phone size).
 *
 * Local frame: length along x, width along z, the edge at y = 0, the dome
 * towards +y. UVs on the underside are planar over (x, z), so the slit
 * texture lies flat along the shell's length.
 */

/** Segments along the length, and around each half. */
const ALONG = 28;
const AROUND = 12;

export function shellHalf(half: "back" | "base"): BufferGeometry {
  const a = SHELL.length / 2;
  const b = SHELL.width / 2;
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= ALONG; i += 1) {
    const t = -1 + (2 * i) / ALONG;
    // The outline: an ellipse, very slightly fuller towards one end.
    const s = Math.sqrt(Math.max(0, 1 - t * t)) * (1 + 0.04 * t);
    for (let j = 0; j <= AROUND; j += 1) {
      // The back goes over the top from +z to -z; the base under, from -z to +z.
      const phi = half === "back" ? (Math.PI * j) / AROUND : Math.PI + (Math.PI * j) / AROUND;
      const c = Math.cos(phi);
      const sn = Math.abs(Math.sin(phi));
      const x = a * t;
      const z = b * s * c;
      const y = half === "back" ? SHELL.dome * s ** 0.8 * sn ** 0.7 : -SHELL.base * s ** 0.6 * sn ** 0.45;
      positions.push(x, y, z);
      uvs.push((t + 1) / 2, (z / b + 1) / 2);
    }
  }
  const row = AROUND + 1;
  for (let i = 0; i < ALONG; i += 1) {
    for (let j = 0; j < AROUND; j += 1) {
      const p = i * row + j;
      // Wound so (along) x (around) points outwards on both halves.
      index.push(p, p + row, p + 1, p + 1, p + row, p + row + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Triangles in one shell, both halves (the two ends are poles, so some are slivers). */
export const SHELL_TRIANGLES = 2 * ALONG * AROUND * 2;
