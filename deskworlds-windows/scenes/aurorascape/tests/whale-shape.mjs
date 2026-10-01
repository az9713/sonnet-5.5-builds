import assert from 'node:assert/strict';
import { BODY_LEN, FLIPPER_LEN, FLUKE_HALF, radial, halfWidth, topAt, bottomAt, bodyPoint, buildWhaleGeometry } from '../src/whale-shape.js';

// Anatomy: proportions of a humpback.
{
  assert.ok(Math.abs(FLIPPER_LEN / BODY_LEN - 1 / 3) < 0.01, 'pectoral flippers are about a third of the body');
  assert.ok(FLUKE_HALF * 2 / BODY_LEN > 0.25 && FLUKE_HALF * 2 / BODY_LEN < 0.4, 'a broad fluke');
  let maxW = 0, at = 0;
  for (let t = 0; t <= 1; t += 0.002) {
    const w = halfWidth(t); assert.ok(Number.isFinite(w) && w >= 0);
    assert.ok(topAt(t) >= 0 && bottomAt(t) <= 0);
    if (w > maxW) { maxW = w; at = t; }
  }
  assert.ok(at > 0.25 && at < 0.42, `girth peaks about a third of the way back (t=${at.toFixed(2)})`);
  assert.ok(maxW * 2 / BODY_LEN > 0.2 && maxW * 2 / BODY_LEN < 0.32, `body ${(maxW * 2).toFixed(2)} m wide on ${BODY_LEN} m`);
  assert.ok(halfWidth(1) < 0.3 * maxW, 'the peduncle is slender');
  assert.ok(halfWidth(0) < 1e-9, 'the nose is closed');
  // smooth: no jumps along the body
  let jump = 0; for (let t = 0.002; t <= 1; t += 0.002) jump = Math.max(jump, Math.abs(halfWidth(t) - halfWidth(t - 0.002)), Math.abs(topAt(t) - topAt(t - 0.002)));
  assert.ok(jump < 0.06, `continuous profile (max step ${jump.toFixed(3)})`);
  // the dorsal fin stands up from the back two thirds along
  const p = [0, 0, 0]; bodyPoint(0.665, Math.PI / 2, p); const base = topAt(0.665);
  assert.ok(p[1] > base + 0.3, 'a dorsal fin hump');
}

// The shared mesh: finite, normals unit and outward, indices valid, all four parts present.
{
  const g = buildWhaleGeometry();
  assert.ok(g.vertices < 65000 && g.triangles > 5000, `${g.vertices} vertices, ${g.triangles} triangles`);
  for (const arr of [g.position, g.normal, g.misc]) for (const v of arr) assert.ok(Number.isFinite(v));
  for (const i of g.index) assert.ok(i < g.vertices);
  const parts = new Set(); for (let i = 0; i < g.vertices; i++) parts.add(g.misc[i * 4]);
  assert.deepEqual([...parts].sort(), [0, 1, 2, 3], 'body, fluke and two flippers');
  let outward = 0, body = 0, unit = 0;
  for (let i = 0; i < g.vertices; i++) {
    if (g.misc[i * 4] !== 0) continue;
    body++;
    const nx = g.normal[i * 3], ny = g.normal[i * 3 + 1], nz = g.normal[i * 3 + 2];
    if (Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-3) unit++;
    const t = g.misc[i * 4 + 2];
    if (t < 0.01 || t > 0.99) { outward++; continue; }
    // outward: along the radius from the section centre (0,0)
    const y = g.position[i * 3 + 1], z = g.position[i * 3 + 2];
    if (ny * y + nz * z > 0) outward++;
  }
  assert.equal(unit, body, 'unit normals');
  assert.ok(outward / body > 0.995, `normals point outward (${(outward / body).toFixed(4)})`);
  // fin parameters are in range
  for (let i = 0; i < g.vertices; i++) {
    const part = g.misc[i * 4]; if (part === 0) continue;
    const u = g.position[i * 3], v = g.position[i * 3 + 1], side = g.position[i * 3 + 2];
    assert.ok(part === 1 ? u >= -1 && u <= 1 : u >= 0 && u <= 1);
    assert.ok(v >= 0 && v <= 1 && (side === 1 || side === -1));
  }
}
console.log('ok whale-shape');
