// Saltline race simulation. Runs on the server at a fixed 120 Hz.
// Cars live in track space: s = metres along the centreline, lane = metres to the right of it,
// lift = metres above the road (non-zero only while airborne over a jump).
import { AIR_GRAVITY } from './track.mjs';

export const TICK = 1 / 120;
export const CARS = [
  { name: 'KESTREL', blurb: 'All-rounder', top: 118, accel: 34, grip: 1.0, color: '#ff5a36', glow: '#ffb14a' },
  { name: 'LONGBOW', blurb: 'Top speed', top: 127, accel: 27, grip: 0.86, color: '#2f7bff', glow: '#5fe3ff' },
  { name: 'PISTON', blurb: 'Launch', top: 112, accel: 45, grip: 0.94, color: '#b9e23a', glow: '#f2ff7a' },
  { name: 'SWITCHBACK', blurb: 'Cornering', top: 115, accel: 31, grip: 1.2, color: '#b06bff', glow: '#ff7ad9' },
];
const CAR_HALF_W = 1.55, CAR_LEN = 4.8, GRIP_LIMIT = 64;
const SLOPE_GRAVITY = 12;   // climbing costs speed, descending returns it (loops, ramps, hills)
const SPLASH_DEPTH = 5;     // fall this far below the flight line over a gap and you are in the water
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const toward = (v, target, d) => (Math.abs(target - v) <= d ? target : v + Math.sign(target - v) * d);

export class Race {
  // gridOrder: car ids from pole to last place.
  constructor(track, laps, gridOrder) {
    this.track = track; this.laps = laps; this.time = 0; this.finish = {};
    this.cars = [];
    gridOrder.forEach((id, slot) => {
      this.cars[id] = {
        id, s: -7 - Math.floor(slot / 2) * 9 - (slot % 2) * 3, lane: slot % 2 ? 3.6 : -3.6, v: 0, lat: 0, steer: 0,
        energy: 0.6, boost: 0, cool: 0, pad: 0, kick: 0, kickPower: 0, charge: 0, drift: 0, draft: 0, hit: 0, hits: 0,
        done: false, prev: 0, dodge: 0,
        air: false, lift: 0, vy: 0, y: 0, landAt: 0, respawn: 0, rescue: 0, clean: 0, splashes: 0,
      };
    });
  }

  rel(from, to) { // signed along-track distance, wrapped to half a lap
    const L = this.track.length; let d = (to - from) % L;
    if (d > L / 2) d -= L; else if (d < -L / 2) d += L;
    return d;
  }

  ai(c) {
    const T = this.track, P = CARS[c.id], w = T.halfWidth - 2.4;
    if (c.air) return { steer: clamp(-c.lane * 0.08, -0.4, 0.4), gas: 1, brake: 0, boost: false };
    let worst = 0;
    for (const t of [0.25, 0.5, 0.8, 1.15, 1.5]) worst = Math.max(worst, Math.abs(T.curvature(c.s + c.v * t)));
    const ahead = T.curvature(c.s + Math.max(28, c.v * 0.7));
    let target = clamp(ahead * 2400, -w * 0.7, w * 0.7);
    let nearest = 160;
    for (const pad of T.pads) {
      const d = this.rel(c.s, pad.s);
      if (d > 4 && d < nearest) { nearest = d; target += (pad.lane - target) * clamp(1 - d / 180, 0, 0.85); }
    }
    let toLip = Infinity;
    for (const j of T.jumps) { const d = this.rel(c.s, j.lip); if (d > 0 && d < toLip) toLip = d; }
    if (toLip < 260) target *= toLip / 260;                           // line up for the ramp
    for (const o of this.cars) {
      if (o.id === c.id || o.done || o.rescue > 0) continue;
      const d = this.rel(c.s, o.s);
      if (d > 0 && d < 30 && Math.abs(o.lane - target) < 3.6 && c.v > o.v - 2) {
        if (!c.dodge) c.dodge = (o.lane > 0 ? -1 : 1);
        target = o.lane + c.dodge * 4.2;
      } else if (Math.abs(d) < 6 && Math.abs(o.lane - c.lane) < 3.4) target = c.lane + Math.sign(c.lane - o.lane || 1) * 2;
    }
    if (c.dodge && !this.cars.some(o => o.id !== c.id && Math.abs(this.rel(c.s, o.s)) < 34)) c.dodge = 0;
    target = clamp(target, -w, w);
    const authority = (9 + 7 * P.grip) * c.v / (c.v + 35) || 1;
    const push = T.curvature(c.s) * c.v * c.v * 0.011 / P.grip;
    const steer = clamp(((target - c.lane) * 1.6 - c.lat * 0.35 + push) / Math.max(4, authority), -1, 1);
    const skill = 0.9 + 0.025 * c.id;
    const safe = Math.sqrt((GRIP_LIMIT * P.grip * 1.12 * skill) / Math.max(worst, 1e-5));
    let brake = c.v > safe + 4 ? clamp((c.v - safe) / 25, 0.2, 1) : 0, gas = c.v > safe ? 0 : 1;
    let boost = c.energy > 0.55 && worst < 0.0018 && c.v > 55;
    if (toLip < 300) { brake = 0; gas = 1; if (toLip < 230 && c.v < 104 && c.energy >= 0.35) boost = true; }  // never arrive slow
    return { steer, gas, brake, boost };
  }

  // inputs[id] is {steer, gas, brake, boost} for a human, or undefined for a computer driver.
  tick(inputs) {
    const dt = TICK, T = this.track, L = T.length, total = L * this.laps;
    this.time += dt;
    for (const c of this.cars) {
      c.prev = c.s;
      c.draft = 0;
      if (c.rescue > 0 || c.air) continue;
      for (const o of this.cars) {
        if (o.id === c.id || o.rescue > 0 || o.air) continue;
        const d = this.rel(c.s, o.s), off = Math.abs(o.lane - c.lane);
        if (d > 3 && d < 55 && off < 2.6) c.draft = Math.max(c.draft, (1 - d / 55) * (1 - off / 2.6));
      }
    }
    for (const c of this.cars) {
      const P = CARS[c.id];
      if (c.done) { c.v = toward(c.v, 45, 30 * dt); c.s += c.v * dt; c.lat *= 0.95; c.steer *= 0.9; c.lift = Math.max(0, c.lift - 20 * dt); c.air = false; continue; }
      if (c.rescue > 0) {                                  // fished out of the water, set back before the ramp
        c.rescue -= dt;
        if (c.rescue <= 0) { c.s = c.prev = c.respawn; c.v = 50; c.lane = 0; c.lat = 0; c.steer = 0; c.lift = 0; c.air = false; c.energy = Math.max(c.energy, 0.35); }
        continue;
      }
      const inp = inputs[c.id] || this.ai(c);
      const k = T.curvature(c.s);
      c.steer = toward(c.steer, clamp(inp.steer, -1, 1), dt * 7);
      c.boost = Math.max(0, c.boost - dt); c.cool = Math.max(0, c.cool - dt);
      c.pad = Math.max(0, c.pad - dt); c.kick = Math.max(0, c.kick - dt); c.hit = Math.max(0, c.hit - dt);

      // Drift: hold brake while steering to slide, charge, and release for a kick.
      const sliding = !c.air && inp.brake > 0.3 && Math.abs(c.steer) > 0.25 && c.v > 45;
      if (sliding) {
        if (!c.drift) c.drift = Math.sign(c.steer);
        if (Math.sign(k) === c.drift && Math.abs(k) > 0.001) c.charge = Math.min(1, c.charge + dt * (0.3 + Math.abs(k) * c.v * 0.3));
      } else {
        if (c.drift && c.charge > 0.25) { c.kick = 0.5 + 0.9 * c.charge; c.kickPower = c.charge; }
        c.drift = 0; c.charge = 0;
      }

      // Boost.
      if (inp.boost && c.cool <= 0 && c.energy >= 0.35) { c.energy -= 0.35; c.boost = 1.5; c.cool = 2.4; }
      c.energy = Math.min(1, c.energy + dt * (0.03 + 0.1 * c.draft));

      // Lateral motion: steering authority against the outward push of the bend. Little control in the air.
      const authority = (9 + 7 * P.grip) * c.v / (c.v + 35) * (c.drift ? 1.35 : 1) * (c.air ? 0.35 : 1);
      const push = k * c.v * c.v * 0.011 / P.grip;
      c.lat += (c.steer * authority - push - c.lat) * (1 - Math.exp(-dt * (c.air ? 3 : 7)));
      c.lane += c.lat * dt;

      // Speed (engines only bite on the road).
      if (!c.air) {
        let bonus = 0.06 * c.draft;
        if (c.boost > 0) bonus = Math.max(bonus, 0.22);
        if (c.pad > 0) bonus = Math.max(bonus, 0.27 * Math.min(1, c.pad / 0.4));
        if (c.kick > 0) bonus = Math.max(bonus, (0.08 + 0.1 * c.kickPower) * Math.min(1, c.kick / 0.3));
        let cap = P.top * (1 + bonus);
        const over = Math.max(0, (Math.abs(k) * c.v * c.v) / (GRIP_LIMIT * P.grip * (c.drift ? 1.3 : 1)) - 1);
        cap /= 1 + 0.5 * over;
        const braking = inp.brake * (c.drift ? 0.25 : 1);
        cap *= 1 - 0.7 * braking;
        const powered = c.boost > 0 || c.pad > 0 || c.kick > 0;
        const gas = powered ? 1 : clamp(inp.gas, 0, 1);
        const goal = gas > 0.05 ? cap : 0;
        if (c.v < goal) c.v = Math.min(goal, c.v + P.accel * gas * (0.3 + 0.9 * (1 - c.v / goal)) * (powered ? 1.9 : 1) * dt);
        else c.v = Math.max(goal, c.v - (9 + 62 * braking + 0.5 * (c.v - goal)) * dt);
        c.v = Math.max(0, c.v - SLOPE_GRAVITY * T.slope(c.s) * dt);
      }

      // Walls.
      const limit = T.halfWidth - CAR_HALF_W - 0.3;
      if (Math.abs(c.lane) > limit) {
        const side = Math.sign(c.lane), impact = Math.max(0, c.lat * side);
        c.lane = side * limit; c.lat = -side * impact * 0.25;
        if (!c.air && impact > 2.5 && c.hit <= 0) { c.v *= 1 - Math.min(0.22, 0.03 + impact * 0.008); c.hit = 0.4; c.hits++; c.charge = 0; c.kick = 0; }
      }

      c.s += c.v * dt / clamp(1 - c.lane * k, 0.85, 1.15);

      // Jumps: leave the road at the lip, fly a ballistic arc, land past the gap or splash down.
      const lapStart = Math.floor(c.prev / L) * L;
      if (!c.air) for (const j of T.jumps) {
        const lip = lapStart + j.lip;
        if (c.prev < lip && c.s >= lip) { c.air = true; c.y = T.height(j.lip); c.vy = c.v * T.slope(j.lip - 2); c.landAt = lapStart + j.land; c.respawn = lip - 170; c.lift = 0; }
      }
      if (c.air) {
        c.vy -= AIR_GRAVITY * dt; c.y += c.vy * dt; c.lift = c.y - T.height(c.s);
        if (c.s < c.landAt) {
          if (c.lift < -SPLASH_DEPTH) { c.air = false; c.rescue = 1.4; c.splashes++; c.v = 0; c.lat = 0; c.boost = 0; c.pad = 0; c.kick = 0; c.charge = 0; c.drift = 0; continue; }
        } else if (c.lift <= 0) {
          const scraped = c.lift < -1.5, sink = c.v * T.slope(c.s) - c.vy;
          c.air = false; c.lift = 0;
          if (scraped) { c.v *= 0.72; c.hit = 0.4; c.hits++; }                 // clipped the landing edge
          else {
            if (sink > 16) c.v *= 0.95;
            if (Math.abs(c.lane) < 4.5) { c.clean++; c.energy = Math.min(1, c.energy + 0.18); }  // centred landing refills energy
          }
        }
      }

      // Pads.
      if (!c.air) for (const pad of T.pads) {
        const d = ((pad.s - c.prev) % L + L) % L;
        if (d > 0 && d <= c.s - c.prev && Math.abs(c.lane - pad.lane) < 3.4) { c.pad = 1.6; c.energy = Math.min(1, c.energy + 0.12); c.v += 5; }
      }
    }

    // Car-to-car contact.
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
      const a = this.cars[i], b = this.cars[j], ds = this.rel(a.s, b.s), dl = a.lane - b.lane;
      if (a.rescue > 0 || b.rescue > 0 || Math.abs(a.lift - b.lift) > 1.5) continue;
      if (Math.abs(ds) >= CAR_LEN || Math.abs(dl) >= CAR_HALF_W * 2) continue;
      const dir = dl >= 0 ? 1 : -1, overlap = CAR_HALF_W * 2 - Math.abs(dl);
      if (Math.abs(ds) > CAR_LEN * 0.7 && Math.abs(dl) < CAR_HALF_W * 1.2) {
        const rear = ds > 0 ? a : b, front = ds > 0 ? b : a, give = clamp((rear.v - front.v) * 0.5, 0, 9);
        rear.v -= give; front.v += give * 0.6; rear.s -= Math.min(CAR_LEN - Math.abs(ds), Math.max(0, rear.s - rear.prev));
      } else {
        a.lane += dir * overlap / 2; b.lane -= dir * overlap / 2;
        const shove = Math.max(0, (b.lat - a.lat) * dir) * 0.6;
        a.lat += dir * shove; b.lat -= dir * shove;
      }
      if (a.hit <= 0 && b.hit <= 0 && Math.min(a.v, b.v) > 25) { a.hit = b.hit = 0.4; a.hits++; b.hits++; }
    }

    // Finish line.
    for (const c of this.cars) {
      if (c.done || c.s < total) continue;
      const f = clamp((total - c.prev) / Math.max(1e-4, c.s - c.prev), 0, 1);
      c.done = true; this.finish[c.id] = this.time - (1 - f) * dt;
    }
  }

  order() {
    return [0, 1, 2, 3].sort((a, b) => {
      const fa = this.finish[a], fb = this.finish[b];
      if (fa !== undefined || fb !== undefined) return (fa ?? Infinity) - (fb ?? Infinity);
      return this.cars[b].s - this.cars[a].s;
    });
  }

  get allDone() { return this.cars.every(c => c.done); }

  // Wire frame: [time, cars, finish, order]; each car is
  // [s, lane, v, lat, steer, boost, pad, kick, energy, drift, charge, hit, hits, done, draft, lift, air (0 road / 1 flying / 2 in the water), cleanLandings]
  snapshot() {
    const r = v => Math.round(v * 1000) / 1000;
    return JSON.stringify([r(this.time), this.cars.map(c => [r(c.s), r(c.lane), r(c.v), r(c.lat), r(c.steer), r(c.boost), r(c.pad), r(c.kick),
      r(c.energy), c.drift, r(c.charge), r(c.hit), c.hits, c.done ? 1 : 0, r(c.draft), r(c.lift), c.rescue > 0 ? 2 : c.air ? 1 : 0, c.clean]), this.finish, this.order()]);
  }
}
