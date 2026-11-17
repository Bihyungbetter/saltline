// Headless sanity check: track statistics, frame validity, and full races.
import { buildTrack } from '../shared/track.mjs';
import { Race, CARS, TICK } from '../shared/sim.mjs';

const T = buildTrack();
let kmax = 0, ymin = 1e9, ymax = -1e9, worstFrame = 0, worstStep = 0;
for (let i = 0; i < T.n; i++) {
  const j = (i + 1) % T.n;
  kmax = Math.max(kmax, Math.abs(T.curv[i])); ymin = Math.min(ymin, T.py[i]); ymax = Math.max(ymax, T.py[i]);
  // frames must be orthonormal and must not snap between neighbours
  const dot = (ax, ay, az, bx, by, bz) => ax * bx + ay * by + az * bz;
  worstFrame = Math.max(worstFrame, Math.abs(dot(T.fx[i], T.fy[i], T.fz[i], T.ux[i], T.uy[i], T.uz[i])), Math.abs(dot(T.rx[i], T.ry[i], T.rz[i], T.ux[i], T.uy[i], T.uz[i])),
    Math.abs(Math.hypot(T.ux[i], T.uy[i], T.uz[i]) - 1));
  worstStep = Math.max(worstStep, 1 - dot(T.ux[i], T.uy[i], T.uz[i], T.ux[j], T.uy[j], T.uz[j]));
}
const fmt = list => list.map(v => Math.round(v)).join(',');
console.log('length', T.length.toFixed(1), 'samples', T.n, 'tightest bend', (1 / kmax).toFixed(0) + ' m', 'height', ymin.toFixed(0), '-', ymax.toFixed(0));
console.log('loops', T.loops.map(l => fmt([l.start, l.end])).join(' | '), ' jumps', T.jumps.map(j => fmt([j.lip, j.land])).join(' | '), ' pads', fmt(T.pads.map(p => p.s)));
console.log('frame error', worstFrame.toExponential(1), ' largest up-vector turn between samples', (Math.acos(1 - worstStep) * 57.3).toFixed(1) + ' deg');
let failed = false;
const fail = message => { console.error('FAIL: ' + message); failed = true; };
if (T.loops.length !== 2 || T.jumps.length !== 2) fail('expected two loops and two jumps');
if (worstFrame > 1e-6) fail('frames are not orthonormal');
if (Math.acos(1 - worstStep) > 0.2) fail('the road surface twists too sharply somewhere');

function run(label, inputs) {
  const race = new Race(T, 3, [0, 1, 2, 3]); let ticks = 0;
  while (!race.allDone && ticks < 120 * 900) { race.tick(typeof inputs === 'function' ? inputs(race) : inputs); ticks++; }
  console.log(label, (ticks * TICK).toFixed(1) + ' s:', race.order().map(i => `${CARS[i].name} ${race.finish[i]?.toFixed(1)} (${race.cars[i].hits} hits, ${race.cars[i].splashes} splashes, ${race.cars[i].clean} clean landings)`).join(' | '));
  if (!race.allDone) fail(label + ' did not finish');
  return race;
}
const bots = run('all computer drivers', {});
if (bots.cars.some(c => c.splashes > 0)) fail('a computer driver fell into a gap');
// A human who only ever holds the throttle must still be able to finish.
run('throttle-only human in KESTREL', { 0: { steer: 0, gas: 1, brake: 0, boost: false } });
// A human crawling at half throttle should miss the jumps and be rescued, not get stuck.
const slow = run('half-throttle human in KESTREL', race => ({ 0: { steer: 0, gas: race.cars[0].v < 60 ? 1 : 0, brake: 0, boost: false } }));
if (slow.cars[0].splashes === 0) fail('a slow sled should not clear the gaps');

const t0 = performance.now(), r2 = new Race(T, 3, [0, 1, 2, 3]);
for (let i = 0; i < 12000; i++) r2.tick({});
console.log('ms per tick', ((performance.now() - t0) / 12000).toFixed(4), '| snapshot bytes', r2.snapshot().length);
process.exit(failed ? 1 : 0);
