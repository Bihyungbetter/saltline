// Sled models and engine trails. Every surface is lofted in code: a row of
// superellipse cross-sections is interpolated into a smooth skin. Models face -Z.
import * as THREE from 'three';
import { CARS } from './shared/sim.mjs';
import { newFrame } from './shared/track.mjs';
import { canvas, normalFromHeight, texture } from './textures.js';

const TAU = Math.PI * 2;
const spline = (a, b, c, d, t) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);

// sections: [{z, w, h, x?, y?, e?, belly?}] - half-width, half-height, centre offset,
// superellipse exponent (2 = ellipse, higher = boxier) and a squash factor for the lower half.
function loft(sections, rings = 46, seg = 36) {
  const S = sections.map(s => ({ x: 0, y: 0, e: 2.2, belly: 1, ...s })), n = S.length - 1, pos = [], uv = [], idx = [];
  for (let i = 0; i <= rings; i++) {
    const t = (i / rings) * n, k = Math.min(n - 1, Math.floor(t)), f = t - k;
    const a = S[Math.max(0, k - 1)], b = S[k], c = S[k + 1], d = S[Math.min(n, k + 2)], q = {};
    for (const key of ['z', 'w', 'h', 'x', 'y', 'e', 'belly']) q[key] = spline(a[key], b[key], c[key], d[key], f);
    const w = Math.max(q.w, 0.002), h = Math.max(q.h, 0.002), p = 2 / Math.max(1.3, q.e);
    for (let j = 0; j <= seg; j++) {
      const th = (j / seg) * TAU, cs = Math.cos(th), sn = Math.sin(th);
      pos.push(q.x + w * Math.sign(cs) * Math.abs(cs) ** p, q.y + h * (sn < 0 ? q.belly : 1) * Math.sign(sn) * Math.abs(sn) ** p, q.z);
      uv.push(j / seg, i / rings);
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
    const a = i * (seg + 1) + j, b = a + seg + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  const nrm = g.attributes.normal;                       // weld the normals along the seam
  for (let i = 0; i <= rings; i++) {
    const a = i * (seg + 1), b = a + seg, x = nrm.getX(a) + nrm.getX(b), y = nrm.getY(a) + nrm.getY(b), z = nrm.getZ(a) + nrm.getZ(b), l = Math.hypot(x, y, z) || 1;
    nrm.setXYZ(a, x / l, y / l, z / l); nrm.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

// Livery: u runs around the section (0.25 = spine, 0.75 = keel), v runs nose to tail.
function livery(spec, id) {
  const W = 512, H = 1024, col = canvas(W, H), hgt = canvas(W, H), g = col.getContext('2d'), k = hgt.getContext('2d');
  const graphite = '#16161b', accent = spec.glow;
  g.fillStyle = spec.color; g.fillRect(0, 0, W, H);
  const shade = g.createLinearGradient(0, 0, 0, H); shade.addColorStop(0, 'rgba(255,255,255,.10)'); shade.addColorStop(1, 'rgba(0,0,0,.22)');
  g.fillStyle = shade; g.fillRect(0, 0, W, H);
  const belly = g.createLinearGradient(W * 0.52, 0, W * 0.98, 0);                      // dark underside
  belly.addColorStop(0, 'rgba(22,22,27,0)'); belly.addColorStop(0.16, graphite); belly.addColorStop(0.84, graphite); belly.addColorStop(1, 'rgba(22,22,27,0)');
  g.fillStyle = belly; g.fillRect(W * 0.52, 0, W * 0.46, H);
  const spine = W * 0.25;                                                              // spine stripe
  g.fillStyle = '#f3efe6'; g.fillRect(spine - 30, 0, 60, H);
  g.fillStyle = accent; g.fillRect(spine - 22, 0, 44, H);
  g.fillStyle = graphite; g.fillRect(spine - 22, H * 0.30, 44, H * 0.012); g.fillRect(spine - 22, H * 0.66, 44, H * 0.012);
  for (const side of [0, W * 0.5, W]) {                                                // flank slashes
    g.fillStyle = '#f3efe6';
    for (let s = 0; s < 3; s++) { g.beginPath(); const y = H * (0.44 + s * 0.045); g.moveTo(side - 46, y); g.lineTo(side + 46, y + 26); g.lineTo(side + 46, y + 44); g.lineTo(side - 46, y + 18); g.fill(); }
  }
  g.fillStyle = graphite; g.fillRect(0, 0, W, H * 0.035); g.fillRect(0, H * 0.93, W, H * 0.07); // nose tip and tail cone
  g.save(); g.translate(spine, H * 0.2); g.rotate(Math.PI / 2); g.fillStyle = graphite; g.font = '900 54px "Segoe UI", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('0' + (id + 1), 0, 0); g.restore();

  // Panel lines: drawn dark on the colour map and as grooves in the height map.
  k.fillStyle = '#808080'; k.fillRect(0, 0, W, H);
  const groove = (x0, y0, x1, y1) => {
    for (const [ctx, style, width] of [[g, 'rgba(0,0,0,.42)', 2], [k, '#000', 4]]) { ctx.strokeStyle = style; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
  };
  for (const v of [0.12, 0.27, 0.41, 0.58, 0.74, 0.86]) groove(0, H * v, W, H * v);
  for (const u of [0.07, 0.43, 0.6, 0.9]) groove(W * u, H * 0.12, W * u, H * 0.86);
  for (const [u, v] of [[0.14, 0.33], [0.36, 0.33], [0.14, 0.66], [0.36, 0.66]]) { groove(W * u - 20, H * v, W * u + 20, H * v); groove(W * u - 20, H * v + 34, W * u + 20, H * v + 34); groove(W * u - 20, H * v, W * u - 20, H * v + 34); groove(W * u + 20, H * v, W * u + 20, H * v + 34); }
  k.filter = 'blur(1px)'; k.drawImage(hgt, 0, 0); k.filter = 'none';
  return { map: texture(col), normalMap: normalFromHeight(hgt, 3) };
}

let disc;
function softDisc() { // radial falloff so the glow under a sled has no hard edge
  if (disc) return disc;
  const c = canvas(128, 128), g = c.getContext('2d'), grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.45, 'rgba(255,255,255,.35)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  return disc = new THREE.CanvasTexture(c);
}

// Per-sled proportions: fuselage stretch, nacelle spread and size, wing sweep, fin style.
const SHAPES = [
  { stretch: 1.0, podX: 1.62, pod: 1.0, sweep: 0.45, fins: 'twin' },
  { stretch: 1.3, podX: 1.38, pod: 0.88, sweep: 0.8, fins: 'canard' },
  { stretch: 0.9, podX: 1.85, pod: 1.28, sweep: 0.2, fins: 'scoop' },
  { stretch: 1.05, podX: 1.7, pod: 0.95, sweep: 0.55, fins: 'wing' },
];

function buildModel(id) {
  const spec = CARS[id], shape = SHAPES[id], g = new THREE.Group(), glowColor = new THREE.Color(spec.glow), { stretch: L, podX, pod, sweep } = shape;
  const skin = livery(spec, id);
  const paint = new THREE.MeshPhysicalMaterial({ ...skin, normalScale: new THREE.Vector2(0.9, 0.9), metalness: 0.45, roughness: 0.34, clearcoat: 1, clearcoatRoughness: 0.08 });
  const trim = new THREE.MeshPhysicalMaterial({ color: spec.color, metalness: 0.45, roughness: 0.34, clearcoat: 1, clearcoatRoughness: 0.08 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x8d8f98, metalness: 1, roughness: 0.22 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x101014, metalness: 0.7, roughness: 0.45 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x05070c, metalness: 0.1, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0, envMapIntensity: 1.6 });
  const glow = new THREE.MeshBasicMaterial({ color: glowColor.clone().multiplyScalar(2.6) });
  const add = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };

  // Fuselage: needle nose, cockpit swell, tapered tail, flattened keel.
  add(loft([
    { z: -3.3 * L, w: 0.01, h: 0.01, y: -0.02 }, { z: -2.7 * L, w: 0.17, h: 0.11, y: 0.0, belly: 0.7 }, { z: -1.6 * L, w: 0.42, h: 0.27, y: 0.05, e: 2.5, belly: 0.6 },
    { z: -0.4 * L, w: 0.62, h: 0.44, y: 0.12, e: 2.7, belly: 0.5 }, { z: 0.8 * L, w: 0.64, h: 0.4, y: 0.12, e: 2.7, belly: 0.5 },
    { z: 1.9 * L, w: 0.46, h: 0.28, y: 0.1, e: 2.4, belly: 0.6 }, { z: 2.6 * L, w: 0.2, h: 0.14, y: 0.08 }, { z: 2.85 * L, w: 0.01, h: 0.01, y: 0.08 },
  ]), paint);
  // Canopy and its frame.
  add(loft([{ z: -1.5 * L, w: 0.01, h: 0.01, y: 0.3 }, { z: -1.0 * L, w: 0.27, h: 0.2, y: 0.36 }, { z: -0.2 * L, w: 0.36, h: 0.3, y: 0.42 }, { z: 0.6 * L, w: 0.3, h: 0.22, y: 0.4 }, { z: 1.15 * L, w: 0.01, h: 0.01, y: 0.36 }], 30, 28), glass);
  add(new THREE.TorusGeometry(0.33, 0.022, 8, 28, Math.PI), metal, 0, 0.44, -0.2 * L);

  // Wing: one swept blade through the fuselage out to both nacelles.
  const wing = loft([
    { z: -podX - 0.25, w: 0.42, h: 0.03, x: -sweep - 0.15, y: 0.0 }, { z: -podX * 0.6, w: 0.62, h: 0.05, x: -sweep * 0.6, y: 0.03 }, { z: -0.3, w: 0.95, h: 0.085, x: 0, y: 0.06 },
    { z: 0.3, w: 0.95, h: 0.085, x: 0, y: 0.06 }, { z: podX * 0.6, w: 0.62, h: 0.05, x: -sweep * 0.6, y: 0.03 }, { z: podX + 0.25, w: 0.42, h: 0.03, x: -sweep - 0.15, y: 0.0 },
  ], 40, 24);
  wing.rotateY(Math.PI / 2); add(wing, trim, 0, 0.02, 0.5);

  // Nacelles: intake lip, body, nozzle with a glowing core.
  const fin = (height, chord, rake) => { const f = loft([{ z: 0, w: 0.045, h: chord, y: 0 }, { z: height * 0.6, w: 0.03, h: chord * 0.7, y: -rake * 0.6 }, { z: height, w: 0.012, h: chord * 0.35, y: -rake }], 14, 16); f.rotateX(-Math.PI / 2); return f; };
  const r = 0.36 * pod, podZ = 0.55 + sweep * 0.5;
  for (const side of [-1, 1]) {
    const x = side * podX;
    add(loft([{ z: -1.35, w: r * 0.8, h: r * 0.8 }, { z: -1.0, w: r * 1.02, h: r * 1.02 }, { z: 0.2, w: r * 1.12, h: r * 1.1 }, { z: 1.5, w: r, h: r }, { z: 2.15, w: r * 0.78, h: r * 0.78 }], 30, 28), paint, x, 0, podZ);
    add(new THREE.TorusGeometry(r * 0.8, 0.045, 10, 28), metal, x, 0, podZ - 1.35);
    add(new THREE.CircleGeometry(r * 0.78, 24).rotateY(Math.PI), dark, x, 0, podZ - 1.3);
    add(new THREE.ConeGeometry(r * 0.3, 0.5, 16).rotateX(-Math.PI / 2), metal, x, 0, podZ - 1.3);
    add(new THREE.TorusGeometry(r * 0.78, 0.05, 10, 28), metal, x, 0, podZ + 2.15);
    add(new THREE.TorusGeometry(r * 0.62, 0.03, 8, 24), dark, x, 0, podZ + 2.05);
    add(new THREE.CircleGeometry(r * 0.72, 24), glow, x, 0, podZ + 2.08).castShadow = false;
    if (shape.fins === 'twin') add(fin(0.85, 0.5, 0.45), trim, x, r * 0.9, podZ + 1.3);
    if (shape.fins === 'scoop') add(loft([{ z: -0.9, w: 0.02, h: 0.02, y: 0 }, { z: -0.6, w: 0.2, h: 0.14, y: 0.02 }, { z: 0.5, w: 0.22, h: 0.12, y: 0 }, { z: 1.2, w: 0.02, h: 0.02, y: -0.03 }], 16, 16), dark, x, r * 1.12, podZ);
    if (shape.fins === 'wing') add(fin(1.05, 0.34, 0.3), dark, x, r * 0.9, podZ + 1.55);
  }
  if (shape.fins === 'canard') {
    const c = loft([{ z: -0.95, w: 0.2, h: 0.015, x: -0.3 }, { z: 0, w: 0.34, h: 0.04, x: 0 }, { z: 0.95, w: 0.2, h: 0.015, x: -0.3 }], 20, 16); c.rotateY(Math.PI / 2);
    add(c, trim, 0, 0.03, -2.0 * L); add(fin(0.9, 0.55, 0.5), trim, 0, 0.36, 1.8 * L);
  }
  if (shape.fins === 'wing') {
    const w = loft([{ z: -podX - 0.3, w: 0.2, h: 0.02 }, { z: 0, w: 0.3, h: 0.04 }, { z: podX + 0.3, w: 0.2, h: 0.02 }], 20, 16); w.rotateY(Math.PI / 2);
    add(w, trim, 0, r * 0.9 + 1.05, podZ + 1.85);
  }
  if (shape.fins === 'twin' || shape.fins === 'scoop') add(fin(0.7, 0.6, 0.5), trim, 0, 0.4, 1.7 * L);
  // Tail exhaust.
  add(new THREE.TorusGeometry(0.15, 0.03, 8, 20), metal, 0, 0.08, 2.72 * L);
  add(new THREE.CircleGeometry(0.14, 18), glow, 0, 0.08, 2.74 * L).castShadow = false;

  const pool = add(new THREE.CircleGeometry(3.6, 28).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: softDisc(), color: glowColor.clone().multiplyScalar(0.8), transparent: true, opacity: 0.26, blending: THREE.AdditiveBlending, depthWrite: false }), 0, -0.62, 0.6);
  pool.castShadow = false; pool.renderOrder = 2;
  return { group: g, glow, podX, glowColor, nozzleZ: podZ + 2.2 };
}

const TRAIL = 30;
class Trail {
  constructor(scene, color) {
    this.pos = new Float32Array(TRAIL * 6); this.col = new Float32Array(TRAIL * 6); this.color = color; this.fresh = true;
    const g = new THREE.BufferGeometry(), idx = [];
    for (let k = 0; k < TRAIL - 1; k++) { const p = k * 2; idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2); }
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(this.col, 3)); g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false; scene.add(this.mesh);
  }
  push(a, b, power) {
    const p = this.pos, edge = [a.x, a.y, a.z, b.x, b.y, b.z];
    if (this.fresh) { for (let k = 0; k < TRAIL; k++) p.set(edge, k * 6); this.fresh = false; }
    p.copyWithin(6, 0, (TRAIL - 1) * 6); p.set(edge, 0);
    for (let k = 0; k < TRAIL; k++) {
      const f = Math.pow(1 - k / (TRAIL - 1), 2.2) * power;
      for (let v = 0; v < 2; v++) { const o = (k * 2 + v) * 3; this.col[o] = this.color.r * f; this.col[o + 1] = this.color.g * f; this.col[o + 2] = this.color.b * f; }
    }
    this.mesh.geometry.attributes.position.needsUpdate = true; this.mesh.geometry.attributes.color.needsUpdate = true;
  }
}

export class Sled {
  constructor(scene, id) {
    Object.assign(this, buildModel(id)); this.id = id; scene.add(this.group);
    this.trails = [new Trail(scene, this.glowColor), new Trail(scene, this.glowColor)];
    this.frame = newFrame(); this.pos = new THREE.Vector3();
    this.base = this.glowColor.clone().multiplyScalar(2.6);
  }
  resetTrails() { for (const t of this.trails) t.fresh = true; }

  // st = [s, lane, v, lat, steer, boost, pad, kick, energy, drift, ..., lift (15), air state (16), clean landings (17)]
  place(T, st, time) {
    const F = T.frame(st[0], this.frame), lane = st[1], v = st[2], lat = st[3], steer = st[4];
    R.fromArray(F.r); U.fromArray(F.u); W.fromArray(F.f).negate();
    const hover = 0.82 + 0.06 * Math.sin(time * 3.1 + this.id * 1.7);
    this.pos.fromArray(F.p).addScaledVector(R, lane).addScaledVector(U, hover);
    this.pos.y += st[15] || 0;                                    // height above the road while flying
    const sunk = st[16] === 2; this.group.visible = !sunk;
    for (const t of this.trails) t.mesh.visible = !sunk;
    if (sunk) { this.resetTrails(); return; }
    this.group.position.copy(this.pos);
    this.group.quaternion.setFromRotationMatrix(M.makeBasis(R, U, W));
    const yaw = -Math.atan2(lat, Math.max(v, 25)) - steer * 0.07 - st[9] * 0.22;
    this.group.quaternion.multiply(Q.setFromAxisAngle(AY, yaw)).multiply(Q.setFromAxisAngle(AZ, -steer * 0.3 - st[9] * 0.12));

    const hot = Math.max(st[5] > 0 ? 1 : 0, Math.min(1, st[6] / 0.4), st[7] > 0 ? 0.8 : 0), throttle = Math.min(1, v / 60);
    this.glow.color.copy(this.base).multiplyScalar(0.35 + 0.65 * throttle + 0.9 * hot);
    for (let k = 0; k < 2; k++) {
      A.set((k ? 1 : -1) * this.podX, 0, this.nozzleZ).applyQuaternion(this.group.quaternion).add(this.pos);
      B.copy(A).addScaledVector(U, 0.22); A.addScaledVector(U, -0.22);
      this.trails[k].push(A, B, (0.25 + 0.75 * throttle) * (1 + 1.2 * hot));
    }
  }
}

const R = new THREE.Vector3(), U = new THREE.Vector3(), W = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3();
const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
