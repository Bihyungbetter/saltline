// Scene, environment, track geometry and post-processing.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeNoise, canvas, paintPixels, normalFromHeight, texture } from './textures.js';

const SUN = new THREE.Vector3(-0.55, 0.13, -0.82).normalize();

function seeded(seed) { // small deterministic PRNG so every player sees the same landscape
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}

function skyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, uniforms: { uSun: { value: SUN } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      varying vec3 vDir; uniform vec3 uSun;
      float hash(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        float a = hash(vec3(i,0.0)), b = hash(vec3(i+vec2(1,0),0.0)), c = hash(vec3(i+vec2(0,1),0.0)), d = hash(vec3(i+vec2(1,1),0.0));
        return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }
      void main(){
        vec3 d = normalize(vDir); float h = abs(d.y);
        vec3 horizon = vec3(0.95, 0.34, 0.12), band = vec3(0.30, 0.09, 0.28), zenith = vec3(0.015, 0.025, 0.09);
        vec3 col = mix(horizon, band, smoothstep(0.0, 0.16, h));
        col = mix(col, zenith, smoothstep(0.10, 0.62, h));
        float s = max(dot(vec3(d.x, h, d.z), uSun), 0.0);
        col += vec3(1.0, 0.5, 0.2) * pow(s, 6.0) * 0.3 + vec3(1.0, 0.75, 0.5) * pow(s, 64.0) * 0.6;
        col += vec3(3.2, 2.0, 1.1) * smoothstep(0.9993, 0.9997, s);
        vec2 q = d.xz / (h + 0.22);
        float cl = smoothstep(0.52, 0.86, noise(q * vec2(1.2, 4.0)) * 0.65 + noise(q * vec2(3.0, 9.0)) * 0.35) * smoothstep(0.42, 0.04, h);
        col = mix(col, vec3(0.95, 0.38, 0.2) + vec3(0.4, 0.14, 0.06) * pow(s, 3.0), cl * 0.5);
        vec3 g = floor(d * 240.0);
        col += vec3(step(0.9972, hash(g)) * smoothstep(0.16, 0.5, h) * (0.5 + hash(g + 3.0)));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

// Road surface set: colour, emissive edge strips, normal and roughness. Tiles along the track.
function roadTextures() {
  const W = 512, H = 1024, n = makeNoise(11);
  const grain = (x, y) => n.fbm(x / 8, y / 8, 0, 4, 0, H / 8), blotch = (x, y) => n.fbm(x / 128, y / 128, 9, 3, 0, H / 128);
  const colour = paintPixels(canvas(W, H), (x, y) => { const v = 20 + grain(x, y) * 26 + blotch(x, y) * 16; return [v, v, v + 3]; });
  const g = colour.getContext('2d');
  g.fillStyle = 'rgba(70,72,84,.55)'; g.fillRect(0, 0, 30, H); g.fillRect(W - 30, 0, 30, H);                     // concrete verges
  for (let y = 0; y < H; y += 64) { g.fillStyle = y % 128 ? 'rgba(0,0,0,.0)' : 'rgba(240,150,40,.5)'; g.fillRect(4, y, 20, 32); g.fillRect(W - 24, y, 20, 32); }
  g.fillStyle = 'rgba(236,230,218,.82)'; g.fillRect(34, 0, 6, H); g.fillRect(W - 40, 0, 6, H);                    // edge lines
  g.fillStyle = 'rgba(236,230,218,.6)'; for (let y = 0; y < H; y += 256) g.fillRect(W / 2 - 4, y, 8, 140);        // centre dashes
  g.fillStyle = 'rgba(236,230,218,.22)'; for (const x of [W * 0.3, W * 0.7]) for (let y = 0; y < H; y += 128) g.fillRect(x - 2, y, 4, 40);
  g.fillStyle = 'rgba(0,0,0,.5)'; for (let y = 0; y < H; y += 256) g.fillRect(0, y, W, 3);                        // panel seams

  const height = paintPixels(canvas(W, H), (x, y) => 120 + grain(x, y) * 90);
  const k = height.getContext('2d'); k.fillStyle = '#000'; for (let y = 0; y < H; y += 256) k.fillRect(0, y, W, 4);
  k.fillStyle = 'rgba(255,255,255,.5)'; k.fillRect(34, 0, 6, H); k.fillRect(W - 40, 0, 6, H);
  const rough = paintPixels(canvas(W, H), (x, y) => { const b = blotch(x + 300, y + 170); return 255 * Math.min(1, 0.34 + Math.max(0, b - 0.4) * 2.2 + grain(x, y) * 0.16); });

  const glow = canvas(64, 64), e = glow.getContext('2d');
  e.fillStyle = '#000'; e.fillRect(0, 0, 64, 64); e.fillStyle = '#ff8a3c'; e.fillRect(0, 0, 1, 64); e.fillRect(63, 0, 1, 64);
  return { map: texture(colour, true, true), normalMap: (t => { t.wrapS = t.wrapT = THREE.RepeatWrapping; return t; })(normalFromHeight(height, 1.6)),
    roughnessMap: texture(rough, false, true), emissiveMap: texture(glow, true, true) };
}

// Barrier panels: brushed plates with seams and a hazard band along the foot.
function barrierTextures() {
  const W = 64, H = 256, n = makeNoise(23);
  const colour = paintPixels(canvas(W, H), (x, y) => { const v = 58 + n.fbm(x / 3, y / 40, 0, 3, 0, 0) * 34; return [v, v, v + 6]; });
  const g = colour.getContext('2d'); g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, 0, W, 3); g.fillRect(0, H / 2, W, 2);
  g.fillStyle = 'rgba(240,150,40,.75)'; for (let y = 0; y < H; y += 64) g.fillRect(0, y + 8, 9, 30);
  g.fillStyle = 'rgba(255,255,255,.16)'; g.fillRect(W - 10, 0, 3, H);
  const height = canvas(W, H), k = height.getContext('2d'); k.fillStyle = '#909090'; k.fillRect(0, 0, W, H); k.fillStyle = '#000'; k.fillRect(0, 0, W, 4); k.fillRect(0, H / 2, W, 3);
  const normalMap = normalFromHeight(height, 3); normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  return { map: texture(colour, true, true), normalMap };
}

function chevronTexture() {
  const c = canvas(128, 128), g = c.getContext('2d');
  g.strokeStyle = '#fff'; g.lineWidth = 16; g.lineJoin = 'miter';
  for (let y = -32; y < 192; y += 64) { g.beginPath(); g.moveTo(10, y + 44); g.lineTo(64, y); g.lineTo(118, y + 44); g.stroke(); }
  const t = texture(c, true, true); return t;
}

function softDisc() {
  const c = canvas(128, 128), g = c.getContext('2d'), grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.4, 'rgba(255,255,255,.3)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c);
}

function signTexture() {
  const c = canvas(1024, 96), g = c.getContext('2d');
  g.fillStyle = '#0c0a12'; g.fillRect(0, 0, 1024, 96);
  for (let x = 0; x < 8; x++) for (let y = 0; y < 4; y++) if ((x + y) % 2) { g.fillStyle = '#f3efe6'; g.fillRect(x * 24, y * 24, 24, 24); g.fillRect(1024 - 192 + x * 24, y * 24, 24, 24); }
  g.fillStyle = '#ffb060'; g.font = '900 64px "Segoe UI", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('S A L T L I N E', 512, 50);
  return texture(c);
}

// A weathered mesa: a tapered column pushed around by noise, with ledges and coloured strata.
function rockGeometry(seed) {
  const n = makeNoise(seed), g = new THREE.CylinderGeometry(0.6, 1, 1, 26, 16, false), p = g.attributes.position, col = new Float32Array(p.count * 3);
  const strata = [[0.16, 0.08, 0.09], [0.36, 0.19, 0.14], [0.5, 0.31, 0.21], [0.27, 0.13, 0.12]];
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i); const r = Math.hypot(x, z), t = y + 0.5;
    if (r > 1e-4) {
      const dx = x / r, dz = z / r;
      const f = 1 + 0.75 * (n.fbm(dx * 1.4 + 3, t * 2.4, dz * 1.4 + 3, 4) - 0.5) + 0.05 * Math.sign(Math.sin(t * 34 + n(dx * 2, dz * 2, 1) * 4)) + 0.25 * (n(dx * 5, t * 9, dz * 5) - 0.5) * 0.4;
      x *= f; z *= f;
    }
    if (t > 0.95) y += 0.1 * (n(x * 2.2, z * 2.2, 5) - 0.5);
    p.setXYZ(i, x, y, z);
    const band = (t * 5.5 + n(x * 1.5, z * 1.5, 9) * 1.2 + n(t * 30, 0, 2) * 0.35) % strata.length, a = strata[Math.floor(band) % 4], b = strata[(Math.floor(band) + 1) % 4], m = Math.min(1, (band % 1) * 4);
    for (let c = 0; c < 3; c++) col[i * 3 + c] = (a[c] + (b[c] - a[c]) * m) * (0.75 + 0.5 * n(x * 6, y * 14, z * 6));
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.computeVertexNormals();
  return g;
}

// A strip that follows the whole circuit between two (lateral, vertical) offsets from the centreline.
function ribbon(T, a, b, { vRepeat = 1, color = null } = {}) {
  const count = T.n, pos = new Float32Array((count + 1) * 6), uv = new Float32Array((count + 1) * 4);
  const col = color ? new Float32Array((count + 1) * 6) : null, idx = [], c = new THREE.Color();
  for (let k = 0; k <= count; k++) {
    const i = k % T.n;
    [a, b].forEach((o, side) => {
      const v = (k * 2 + side) * 3;
      pos[v] = T.px[i] + T.rx[i] * o[0] + T.ux[i] * o[1];
      pos[v + 1] = T.py[i] + T.ry[i] * o[0] + T.uy[i] * o[1];
      pos[v + 2] = T.pz[i] + T.rz[i] * o[0] + T.uz[i] * o[1];
      uv[(k * 2 + side) * 2] = side; uv[(k * 2 + side) * 2 + 1] = (k / count) * vRepeat;
      if (col) { color(k / count, c); col[v] = c.r; col[v + 1] = c.g; col[v + 2] = c.b; }
    });
    if (k < count && !T.gap[i] && !T.gap[(i + 1) % T.n]) { const p = k * 2; idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

export function createWorld(view, T) {
  const renderer = new THREE.WebGLRenderer({ canvas: view, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(0x3d2038, 0.00015);
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.3, 12000);

  // Sky, image-based lighting from the same sky, and a low sun that casts shadows near the player.
  const sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 48, 24), skyMaterial()); sky.frustumCulled = false; scene.add(sky);
  const pmrem = new THREE.PMREMGenerator(renderer), skyScene = new THREE.Scene();
  skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), skyMaterial()));
  scene.environment = pmrem.fromScene(skyScene, 0.02).texture; scene.environmentIntensity = 0.7; pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0x8d7fc0, 0x2a1820, 0.7));
  const sun = new THREE.DirectionalLight(0xffa868, 2.2); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -55, right: 55, top: 55, bottom: -55, near: 20, far: 560 }); sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.06;
  scene.add(sun, sun.target);

  // Flooded salt flat: one planar mirror.
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const water = new Reflector(new THREE.CircleGeometry(11000, 72), { clipBias: 0.003, textureWidth: size.x, textureHeight: size.y, multisample: 4, color: 0x8f8a9c });
  water.rotation.x = -Math.PI / 2; scene.add(water);

  // Road deck.
  const road = roadTextures(), repeats = Math.round(T.length / 32), hw = T.halfWidth;
  const deck = new THREE.Mesh(ribbon(T, [-hw, 0], [hw, 0], { vRepeat: repeats }),
    new THREE.MeshStandardMaterial({ ...road, emissive: 0xffffff, emissiveIntensity: 1.2, roughness: 1, metalness: 0.1, normalScale: new THREE.Vector2(0.45, 0.45), side: THREE.DoubleSide }));
  deck.receiveShadow = true; scene.add(deck);
  const hull = new THREE.MeshStandardMaterial({ color: 0x1b1822, roughness: 0.5, metalness: 0.65, side: THREE.DoubleSide });
  for (const [a, b] of [[[-hw, -1.3], [hw, -1.3]], [[-hw - 0.5, 1.15], [-hw - 0.5, -1.3]], [[hw + 0.5, 1.15], [hw + 0.5, -1.3]]]) scene.add(new THREE.Mesh(ribbon(T, a, b), hull));
  const barrier = new THREE.MeshStandardMaterial({ ...barrierTextures(), roughness: 0.7, metalness: 0.3, side: THREE.DoubleSide });
  for (const [a, b] of [[[-hw, 0], [-hw - 0.5, 1.15]], [[hw, 0], [hw + 0.5, 1.15]]]) { const m = new THREE.Mesh(ribbon(T, a, b, { vRepeat: Math.round(T.length / 6) }), barrier); m.receiveShadow = true; scene.add(m); }
  // Light rails: colour drifts around the lap.
  const railColor = (t, c) => c.setHSL((0.04 + t * 0.9) % 1, 1, 0.5).multiplyScalar(1.5);
  const neon = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  for (const [a, b] of [[[-hw - 0.38, 0.78], [-hw - 0.5, 1.1]], [[hw + 0.38, 0.78], [hw + 0.5, 1.1]], [[-hw - 0.52, -1.0], [-hw - 0.52, -1.25]], [[hw + 0.52, -1.0], [hw + 0.52, -1.25]]])
    scene.add(new THREE.Mesh(ribbon(T, a, b, { color: railColor }), neon));

  // Helpers for placing things on the track.
  const M = new THREE.Matrix4(), X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), P = new THREE.Vector3(), C = new THREE.Color();
  const load = i => { X.set(T.rx[i], T.ry[i], T.rz[i]); Y.set(T.ux[i], T.uy[i], T.uz[i]); Z.set(-T.fx[i], -T.fy[i], -T.fz[i]); P.set(T.px[i], T.py[i], T.pz[i]); };
  const basis = i => { load(i); return M.makeBasis(X, Y, Z); };

  // Gates.
  const at = s => Math.round(s / T.step) % T.n, stunt = i => T.loop[i % T.n] >= 0 || T.gap[i % T.n] === 1, gateList = [];
  for (let k = 0; k < 26; k++) { const i = Math.floor(((k + 0.5) / 26) * T.n); if (!stunt(i)) gateList.push([i, k / 26]); }
  for (const l of T.loops) for (let i = at(l.start); i < at(l.end); i += 6) gateList.push([i, i / T.n]);
  for (const j of T.jumps) gateList.push([at(j.lip), -1], [at(j.land), -1]);
  const gates = new THREE.InstancedMesh(new THREE.TorusGeometry(hw + 2.4, 0.2, 8, 40, Math.PI), new THREE.MeshBasicMaterial(), gateList.length);
  gateList.forEach(([i, hue], k) => { gates.setMatrixAt(k, basis(i).setPosition(P)); gates.setColorAt(k, hue < 0 ? C.setRGB(2.2, 2.2, 2.2) : railColor(hue, C)); });
  scene.add(gates);

  // Start gantry.
  const gantry = new THREE.Group(), steel = new THREE.MeshStandardMaterial({ color: 0x2a2732, metalness: 0.8, roughness: 0.4 });
  for (const side of [-1, 1]) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.9, 12.4, 0.9), steel); m.position.set(side * (hw + 1.7), 5, 0); m.castShadow = true; gantry.add(m); }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 4.6, 2.5, 1.0), steel); beam.position.y = 10.4; beam.castShadow = true; gantry.add(beam);
  for (const face of [1, -1]) { const s = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2 + 3.4, 2.0), new THREE.MeshBasicMaterial({ map: signTexture(), color: new THREE.Color(1.5, 1.5, 1.5) })); s.position.set(0, 10.4, face * 0.52); if (face < 0) s.rotation.y = Math.PI; gantry.add(s); }
  gantry.applyMatrix4(basis(0).setPosition(P)); scene.add(gantry);

  // Lamp posts with a pool of light on the deck, and support pylons below.
  const every = 22, posts = Math.floor(T.n / every);
  const pole = mergeGeometries([new THREE.CylinderGeometry(0.1, 0.15, 7.2, 8).translate(0, 3.6, 0), new THREE.BoxGeometry(2.6, 0.12, 0.16).translate(-1.25, 7.15, 0)]);
  const poles = new THREE.InstancedMesh(pole, steel, posts), heads = new THREE.InstancedMesh(new THREE.BoxGeometry(1.0, 0.07, 0.34).translate(-2.1, 7.06, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.7, 1.0) }), posts);
  const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(13, 13).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: softDisc(), color: new THREE.Color(0.5, 0.32, 0.16), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), posts);
  for (let k = 0; k < posts; k++) {
    const i = k * every + 7, side = k % 2 ? 1 : -1; load(i % T.n);
    if (stunt(i)) { M.makeScale(0, 0, 0); poles.setMatrixAt(k, M); heads.setMatrixAt(k, M); pools.setMatrixAt(k, M); continue; }
    if (side < 0) { X.negate(); Z.negate(); }                      // mirror the arm inward on the left
    M.makeBasis(X, Y, Z).setPosition(P.clone().addScaledVector(X, hw + 0.95));
    poles.setMatrixAt(k, M); heads.setMatrixAt(k, M);
    pools.setMatrixAt(k, M.clone().setPosition(P.clone().addScaledVector(X, hw - 2.4).addScaledVector(Y, 0.06)));
  }
  scene.add(poles, heads, pools);
  const pylonEvery = 16, pylons = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.1, 2.0, 1, 10), hull, Math.floor(T.n / pylonEvery));
  for (let k = 0; k < pylons.count; k++) { const i = k * pylonEvery, h = T.py[i] - 1.3; pylons.setMatrixAt(k, stunt(i) ? M.makeScale(0, 0, 0) : M.makeScale(1, h, 1).setPosition(T.px[i], h / 2, T.pz[i])); }
  scene.add(pylons);

  // Boost pads.
  const chevrons = chevronTexture();
  const padMat = new THREE.MeshBasicMaterial({ map: chevrons, color: new THREE.Color(0.3, 1.4, 1.8), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  for (const pad of T.pads) {
    const i = Math.round(pad.s / T.step) % T.n, m = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 10), padMat); load(i);
    m.applyMatrix4(M.makeBasis(X, Z.clone().negate(), Y)); m.position.copy(P).addScaledVector(X, pad.lane).addScaledVector(Y, 0.07); scene.add(m);
  }

  const rampMat = padMat.clone(); rampMat.color = new THREE.Color(2.2, 0.9, 0.15);
  for (const j of T.jumps) {
    for (const s of [j.lip, j.land]) { const cap = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2 + 1, 1.3), hull); cap.applyMatrix4(basis(at(s))); cap.position.copy(P).addScaledVector(Y, -0.65); scene.add(cap); }
    for (let k = 1; k <= 4; k++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(16, 9), rampMat); load(at(j.lip - k * 19));
      m.applyMatrix4(M.makeBasis(X, Z.clone().negate(), Y)); m.position.copy(P).addScaledVector(Y, 0.07); scene.add(m);
    }
  }

  // Mesas rising out of the water, kept clear of the circuit. Four sculpted variants, instanced.
  const rand = seeded(42), spots = [[], [], [], []];
  for (let placed = 0; placed < 150;) {
    const ang = rand() * Math.PI * 2, rad = 150 + rand() * rand() * 5200, x = Math.cos(ang) * rad, z = Math.sin(ang) * rad, w = 70 + rand() * 260;
    let clear = true;
    for (let i = 0; i < T.n; i += 12) if (Math.hypot(T.px[i] - x, T.pz[i] - z) < w * 1.3 + 150) { clear = false; break; }
    if (clear) { spots[placed % 4].push([x, z, w, 60 + rand() * 240 + rad * 0.03, rand() * 6.28, 0.7 + rand() * 0.6]); placed++; }
  }
  const rock = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true, envMapIntensity: 0.6 });
  const E = new THREE.Euler(), Q = new THREE.Quaternion(), S = new THREE.Vector3();
  spots.forEach((list, variant) => {
    const mesh = new THREE.InstancedMesh(rockGeometry(100 + variant * 17), rock, list.length);
    list.forEach(([x, z, w, h, r, sq], k) => mesh.setMatrixAt(k, M.compose(P.set(x, h / 2 - 4, z), Q.setFromEuler(E.set(0, r, 0)), S.set(w, h, w * sq))));
    scene.add(mesh);
  });

  // Post-processing on a multisampled target: bloom, then speed blur / vignette / grain, then tone mapping.
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.22, 0.4, 1.0));
  const lens = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uBlur: { value: 0 }, uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float uBlur, uTime; varying vec2 vUv;
      void main(){
        vec2 c = vUv - 0.5; float r = length(c), amount = uBlur * smoothstep(0.2, 0.8, r) * 0.055; vec3 col = vec3(0.0);
        for (int i = 0; i < 10; i++) col += texture2D(tDiffuse, vUv - c * amount * float(i) / 9.0).rgb;
        col *= 0.1 * (1.0 - 0.45 * smoothstep(0.32, 0.95, r));
        float g = fract(sin(dot(vUv * vec2(1917.0, 1081.0) + uTime * 61.0, vec2(12.9898, 78.233))) * 43758.5453);
        gl_FragColor = vec4(col * (1.0 + (g - 0.5) * 0.05), 1.0);
      }`,
  });
  composer.addPass(lens); composer.addPass(new OutputPass());

  function resize() {
    const w = view.clientWidth || window.innerWidth, h = view.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false); composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h);
    renderer.getDrawingBufferSize(size); water.getRenderTarget().setSize(size.x, size.y); // the mirror must track the real canvas size
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize); resize();

  let time = 0;
  return {
    scene, camera, renderer, composer, deck,
    // focus: world position the shadow map should follow (the player's sled).
    render(dt, blur, focus) {
      time += dt; sky.position.copy(camera.position); chevrons.offset.y = -time * 1.6;
      if (focus) { sun.target.position.copy(focus); sun.position.copy(focus).addScaledVector(SUN, 280); }
      lens.uniforms.uBlur.value = blur; lens.uniforms.uTime.value = time % 100;
      composer.render(dt);
    },
  };
}
