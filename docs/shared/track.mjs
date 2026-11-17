// Procedural closed circuit, generated identically on the server and in the browser.
//
// 1. A flat-ish base curve (a polar curve, so it can never cross itself).
// 2. Stunt features laid on top of it at the four straightest places:
//    - loops: a teardrop vertical loop that corkscrews one track-width sideways so it clears itself,
//      then eases back onto the base line;
//    - jumps: a ramp, a gap with no road, and a landing slope shaped like the flight path.
// 3. A uniform resample with a frame (forward / right / up) at every sample. Frames inside a loop
//    are carried around it by parallel transport so "up" always points away from the road surface.
const TAU = Math.PI * 2;
const clamp01 = t => Math.max(0, Math.min(1, t));
const smooth = t => { t = clamp01(t); return t * t * (3 - 2 * t); };

export const AIR_GRAVITY = 30;        // m/s^2 while airborne (also shapes the landing slope)
const LOOP = { radius: 40, advance: 56, shift: 28.5, settle: 330 };
const JUMP = { ramp: 95, gap: 90, recover: 190, pitch: 0.17, speed: 95 };

function centre(a) {
  const r = 620 * (1 + 0.22 * Math.sin(2 * a + 0.6) + 0.13 * Math.sin(3 * a + 2.1) + 0.07 * Math.sin(5 * a + 4.0));
  const y = 46 + 24 * Math.sin(2 * a + 1.3) + 13 * Math.sin(3 * a + 0.4);
  return [Math.cos(a) * r, y, Math.sin(a) * r];
}

export function buildTrack() {
  // ---- base curve, densely sampled ----
  const M = 24000, bx = new Float64Array(M + 1), by = new Float64Array(M + 1), bz = new Float64Array(M + 1), sB = new Float64Array(M + 1);
  for (let j = 0; j <= M; j++) { const p = centre((j / M) * TAU); bx[j] = p[0]; by[j] = p[1]; bz[j] = p[2]; }
  for (let j = 1; j <= M; j++) sB[j] = sB[j - 1] + Math.hypot(bx[j] - bx[j - 1], by[j] - by[j - 1], bz[j] - bz[j - 1]);
  const LB = sB[M], hx = new Float64Array(M + 1), hz = new Float64Array(M + 1), bend = new Float64Array(M + 1);
  for (let j = 0; j <= M; j++) {
    const a = (j - 1 + M) % M, b = (j + 1) % M, x = bx[b] - bx[a], z = bz[b] - bz[a], l = Math.hypot(x, z);
    hx[j] = x / l; hz[j] = z / l;
  }
  for (let j = 0; j <= M; j++) {
    const a = (j - 1 + M) % M, b = (j + 1) % M;
    bend[j] = Math.abs(hx[a] * hz[b] - hz[a] * hx[b]) / (2 * LB / M);
  }

  // ---- pick the four straightest sites, well apart and clear of the start line ----
  const per = LB / M, win = Math.round(150 / per), prefix = new Float64Array(M + 2);
  for (let j = 0; j <= M; j++) prefix[j + 1] = prefix[j] + bend[j];
  const score = s => { const j = Math.round(s / per); return (prefix[Math.min(M, j + win) + 1] - prefix[Math.max(0, j - win)]) / (2 * win); };
  // Dynamic programme over candidate positions: best[k][c] = lowest total bend using k+1 sites ending at candidate c.
  const cand = [], GAP = 680;
  for (let s = 420; s < LB - 460; s += 20) cand.push(s);
  const cost = cand.map(score), best = [cost.slice()], from = [cand.map(() => -1)];
  for (let k = 1; k < 4; k++) {
    best.push(cand.map(() => Infinity)); from.push(cand.map(() => -1));
    for (let c = 0; c < cand.length; c++) for (let p = 0; p < c && cand[c] - cand[p] >= GAP; p++) {
      if (best[k - 1][p] + cost[c] < best[k][c]) { best[k][c] = best[k - 1][p] + cost[c]; from[k][c] = p; }
    }
  }
  const sites = [];
  for (let k = 3, c = best[3].indexOf(Math.min(...best[3])); k >= 0 && c >= 0; c = from[k][c], k--) sites.unshift(cand[c]);
  const loopSites = sites.filter((_, k) => k % 2 === 0).map(s => s - LOOP.advance / 2), jumpSites = sites.filter((_, k) => k % 2 === 1).map(s => s - JUMP.gap / 2);

  // ---- features as offsets from the base curve, in base arc length ----
  const lipHeight = Math.tan(JUMP.pitch) * JUMP.ramp / 2, m0 = Math.tan(JUMP.pitch);
  const endHeight = lipHeight + m0 * JUMP.gap - AIR_GRAVITY * JUMP.gap ** 2 / (2 * JUMP.speed ** 2), endSlope = m0 - AIR_GRAVITY * JUMP.gap / JUMP.speed ** 2;
  function offsets(s) {
    let side = 0, up = 0, along = 0;
    for (const a of loopSites) {
      const t = (s - a) / LOOP.advance;
      side += LOOP.shift * (smooth(t) - smooth((s - a - LOOP.advance) / LOOP.settle));
      if (t > 0 && t < 1) {
        const phi = TAU * t - 0.5 * Math.sin(TAU * t);      // slower at the bottom, tighter over the top
        along += LOOP.radius * Math.sin(phi); up += LOOP.radius * (1 - Math.cos(phi));
      }
    }
    for (const a of jumpSites) {
      const x = s - a;
      if (x > -JUMP.ramp && x <= 0) up += m0 / (2 * JUMP.ramp) * (x + JUMP.ramp) ** 2;
      else if (x > 0 && x <= JUMP.gap) up += lipHeight + m0 * x - AIR_GRAVITY * x * x / (2 * JUMP.speed ** 2);
      else if (x > JUMP.gap && x < JUMP.gap + JUMP.recover) {
        const u = (x - JUMP.gap) / JUMP.recover;
        up += endHeight * (2 * u ** 3 - 3 * u * u + 1) + endSlope * JUMP.recover * (u ** 3 - 2 * u * u + u);
      }
    }
    return [side, up, along];
  }
  const loopAt = s => loopSites.findIndex(a => s > a && s < a + LOOP.advance);
  const gapAt = s => jumpSites.some(a => s > a && s < a + JUMP.gap);
  const calm = s => loopSites.some(a => s > a - 40 && s < a + LOOP.advance + 40) || jumpSites.some(a => s > a - JUMP.ramp - 20 && s < a + JUMP.gap + 80);

  const dx = new Float64Array(M + 1), dy = new Float64Array(M + 1), dz = new Float64Array(M + 1), cum = new Float64Array(M + 1);
  for (let j = 0; j <= M; j++) {
    const [side, up, along] = offsets(sB[j]);            // right = forward x worldUp = (-hz, 0, hx)
    dx[j] = bx[j] - hz[j] * side + hx[j] * along; dy[j] = by[j] + up; dz[j] = bz[j] + hx[j] * side + hz[j] * along;
  }
  for (let j = 1; j <= M; j++) cum[j] = cum[j - 1] + Math.hypot(dx[j] - dx[j - 1], dy[j] - dy[j - 1], dz[j] - dz[j - 1]);

  // ---- uniform resample ----
  const length = cum[M], n = Math.round(length / 3), step = length / n;
  const px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n), baseS = new Float64Array(n);
  for (let i = 0, j = 0; i < n; i++) {
    const d = i * step;
    while (cum[j + 1] < d) j++;
    const f = (d - cum[j]) / (cum[j + 1] - cum[j]);
    px[i] = dx[j] + (dx[j + 1] - dx[j]) * f; py[i] = dy[j] + (dy[j + 1] - dy[j]) * f; pz[i] = dz[j] + (dz[j + 1] - dz[j]) * f;
    baseS[i] = sB[j] + (sB[j + 1] - sB[j]) * f;
  }
  const loop = new Int8Array(n), gap = new Uint8Array(n);
  for (let i = 0; i < n; i++) { loop[i] = loopAt(baseS[i]); gap[i] = gapAt(baseS[i]) ? 1 : 0; }

  // ---- frames ----
  const fx = new Float64Array(n), fy = new Float64Array(n), fz = new Float64Array(n);
  const rx = new Float64Array(n), ry = new Float64Array(n), rz = new Float64Array(n);
  const ux = new Float64Array(n), uy = new Float64Array(n), uz = new Float64Array(n);
  const w = i => ((i % n) + n) % n;
  for (let i = 0; i < n; i++) {
    const a = w(i - 1), b = w(i + 1);
    let x = px[b] - px[a], y = py[b] - py[a], z = pz[b] - pz[a];
    const l = Math.hypot(x, y, z); fx[i] = x / l; fy[i] = y / l; fz[i] = z / l;
    if (loop[i] < 0) {                                    // level frame: right = forward x worldUp, up = right x forward
      const ql = Math.hypot(fz[i], fx[i]); rx[i] = -fz[i] / ql; ry[i] = 0; rz[i] = fx[i] / ql;
      ux[i] = ry[i] * fz[i] - rz[i] * fy[i]; uy[i] = rz[i] * fx[i] - rx[i] * fz[i]; uz[i] = rx[i] * fy[i] - ry[i] * fx[i];
    }
  }
  const setRight = i => { rx[i] = fy[i] * uz[i] - fz[i] * uy[i]; ry[i] = fz[i] * ux[i] - fx[i] * uz[i]; rz[i] = fx[i] * uy[i] - fy[i] * ux[i]; };
  const loops = [];
  for (let i = 1; i < n; i++) {
    if (loop[i] < 0 || loop[i - 1] >= 0) continue;
    let end = i; while (end + 1 < n && loop[end + 1] >= 0) end++;
    for (let k = i; k <= end; k++) {                      // carry "up" around the loop
      const d = ux[k - 1] * fx[k] + uy[k - 1] * fy[k] + uz[k - 1] * fz[k];
      let x = ux[k - 1] - fx[k] * d, y = uy[k - 1] - fy[k] * d, z = uz[k - 1] - fz[k] * d; const l = Math.hypot(x, y, z);
      ux[k] = x / l; uy[k] = y / l; uz[k] = z / l;
    }
    // The corkscrew leaves a small roll error at the exit; spread its correction over the loop.
    const e = end, o = end + 1;
    const cx = uy[o] * uz[e] - uz[o] * uy[e], cy = uz[o] * ux[e] - ux[o] * uz[e], cz = ux[o] * uy[e] - uy[o] * ux[e];
    const twist = Math.atan2(cx * fx[o] + cy * fy[o] + cz * fz[o], ux[o] * ux[e] + uy[o] * uy[e] + uz[o] * uz[e]);
    for (let k = i; k <= end; k++) {
      const beta = -twist * (k - i + 1) / (end - i + 1), c = Math.cos(beta), s = Math.sin(beta);
      const tx = fy[k] * uz[k] - fz[k] * uy[k], ty = fz[k] * ux[k] - fx[k] * uz[k], tz = fx[k] * uy[k] - fy[k] * ux[k];
      ux[k] = ux[k] * c + tx * s; uy[k] = uy[k] * c + ty * s; uz[k] = uz[k] * c + tz * s;
      setRight(k);
    }
    loops.push({ start: i * step, end: (end + 1) * step });
    i = end;
  }

  // ---- signed lateral curvature (positive = right-hand bend) and banking ----
  const raw = new Float64Array(n), curv = new Float64Array(n), flat = new Float64Array(n), ease = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = w(i - 1), b = w(i + 1);
    raw[i] = ((fx[b] - fx[a]) * rx[i] + (fy[b] - fy[a]) * ry[i] + (fz[b] - fz[a]) * rz[i]) / (2 * step);
    flat[i] = calm(baseS[i]) ? 1 : 0;
  }
  for (let i = 0; i < n; i++) {
    let sum = 0, hold = 0;
    for (let k = -6; k <= 6; k++) sum += raw[w(i + k)];
    for (let k = -12; k <= 12; k++) hold += flat[w(i + k)];
    curv[i] = sum / 13; ease[i] = 1 - hold / 25;          // no banking in or around a stunt
  }
  for (let i = 0; i < n; i++) {
    const roll = Math.max(-0.42, Math.min(0.42, curv[i] * 62)) * ease[i], c = Math.cos(roll), s = Math.sin(roll);
    const ax = ux[i], ay = uy[i], az = uz[i], qx = rx[i], qy = ry[i], qz = rz[i];
    ux[i] = ax * c + qx * s; uy[i] = ay * c + qy * s; uz[i] = az * c + qz * s;
    rx[i] = qx * c - ax * s; ry[i] = qy * c - ay * s; rz[i] = qz * c - az * s;
  }

  // ---- jumps in final track distance; the road stops at `lip` and resumes at `land` ----
  const jumps = [];
  for (let i = 1; i < n; i++) {
    if (!gap[i] || gap[i - 1]) continue;
    let end = i; while (end + 1 < n && gap[end + 1]) end++;
    jumps.push({ lip: (i - 1) * step, land: (end + 1) * step });
    i = end;
  }

  // ---- boost pads: one on the run-up to every stunt, the rest on quiet stretches ----
  const pads = [], busy = s => loops.some(l => s > l.start - 60 && s < l.end + 60) || jumps.some(j => s > j.lip - 60 && s < j.land + 120) || s < 150 || s > length - 300;
  for (const j of jumps) pads.push({ s: j.lip - 150, lane: 0 });
  for (const l of loops) pads.push({ s: l.start - 110, lane: 0 });
  const lanes = [-4.5, 4.5, 0];
  for (let k = 0; k < 6; k++) {
    let i = Math.floor(((k + 0.35) / 6) * n), guard = 0;
    while ((Math.abs(curv[i % n]) > 0.0016 || busy((i % n) * step) || pads.some(p => Math.abs(p.s - (i % n) * step) < 160)) && guard++ < 260) i++;
    if (guard < 260) pads.push({ s: (i % n) * step, lane: lanes[k % 3] });
  }

  const mod = s => ((s % length) + length) % length;
  const lerp = (A, s) => { const t = mod(s) / step, i = Math.floor(t) % n, j = (i + 1) % n; return A[i] + (A[j] - A[i]) * (t - Math.floor(t)); };
  return {
    length, step, n, halfWidth: 11, px, py, pz, fx, fy, fz, rx, ry, rz, ux, uy, uz, curv, loop, gap, loops, jumps, pads,
    curvature: s => lerp(curv, s),
    height: s => lerp(py, s),
    slope: s => lerp(fy, s),
    inLoop: s => { const v = mod(s); return loops.some(l => v > l.start && v < l.end); },
    // Interpolated frame; writes plain arrays into out.p / out.f / out.r / out.u.
    frame(s, out) {
      const t = mod(s) / step, i = Math.floor(t) % n, j = (i + 1) % n, f = t - Math.floor(t);
      const L = A => A[i] + (A[j] - A[i]) * f;
      out.p[0] = L(px); out.p[1] = L(py); out.p[2] = L(pz);
      out.f[0] = L(fx); out.f[1] = L(fy); out.f[2] = L(fz);
      out.r[0] = L(rx); out.r[1] = L(ry); out.r[2] = L(rz);
      out.u[0] = L(ux); out.u[1] = L(uy); out.u[2] = L(uz);
      return out;
    },
  };
}

export const newFrame = () => ({ p: [0, 0, 0], f: [0, 0, 0], r: [0, 0, 0], u: [0, 0, 0] });
