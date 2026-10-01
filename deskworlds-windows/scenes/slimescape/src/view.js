// The fixed top-down macro camera, as pure math: where the visible rectangle of the plate is, and how a
// cursor maps onto it. The camera never rotates; it breathes a little and drifts very slowly.
import { WORLD_W } from './agents-ref.js';

export const WORLD_H = 1;

export function createView() {
  const v = { aspect: WORLD_W, time: 0, zoom: 1.06, cx: WORLD_W / 2, cy: 0.5, halfW: WORLD_W / 2, halfH: 0.5 };
  v.setAspect = aspect => { if (aspect > 0 && Number.isFinite(aspect)) { v.aspect = aspect; v.update(v.time); } };
  v.update = time => {
    v.time = time;
    v.zoom = 1.07 + 0.022 * Math.sin(time * 0.041 + 0.7) + 0.008 * Math.sin(time * 0.113);
    v.cx = WORLD_W / 2 + 0.018 * Math.sin(time * 0.023 + 1.3) + 0.007 * Math.sin(time * 0.071);
    v.cy = 0.5 + 0.012 * Math.sin(time * 0.019) + 0.005 * Math.sin(time * 0.057 + 2);
    // Cover-fit the 16:9 plate: the plate fills the frame edge to edge on any display shape.
    if (v.aspect >= WORLD_W / WORLD_H) { v.halfW = WORLD_W / 2 / v.zoom; v.halfH = v.halfW / v.aspect; }
    else { v.halfH = WORLD_H / 2 / v.zoom; v.halfW = v.halfH * v.aspect; }
  };
  // nx, ny: 0..1 across the canvas, ny from the top.
  v.project = (nx, ny, out = { x: 0, y: 0 }) => {
    out.x = v.cx + (nx * 2 - 1) * v.halfW; out.y = v.cy + (1 - ny * 2) * v.halfH;
    return out;
  };
  // Where moving things may go: the visible rectangle, shrunk by margin.
  v.bounds = (margin = 0.08, out = {}) => {
    out.minX = v.cx - v.halfW + margin; out.maxX = v.cx + v.halfW - margin;
    out.minY = v.cy - v.halfH + margin; out.maxY = v.cy + v.halfH - margin;
    return out;
  };
  v.update(0);
  return v;
}
