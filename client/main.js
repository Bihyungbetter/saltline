// Saltline client: networking, lobby, HUD, input and the render loop.
import * as THREE from 'three';
import { buildTrack, newFrame } from './shared/track.mjs';
import { CARS } from './shared/sim.mjs';
import { connect } from './net.js';
import { createWorld } from './world.js';
import { Sled } from './cars.js';
import { Sound } from './audio.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const clock = v => { const ms = Math.floor(v * 1000); return Math.floor(ms / 60000) + ':' + String(Math.floor(ms / 1000) % 60).padStart(2, '0') + '.' + String(ms % 1000).padStart(3, '0'); };

function fatal(message) { $('fatal').hidden = false; $('fatal').textContent = message; }

let world, T, sleds, sound = new Sound();
try {
  T = buildTrack(); world = createWorld($('view'), T);
  sleds = CARS.map((_, id) => new Sled(world.scene, id));
} catch (error) { console.error(error); fatal('Saltline needs WebGL 2 with graphics acceleration. ' + error.message); throw error; }

// ---------- state ----------
let state = 'lobby';            // lobby | countdown | race | results
let me = null, myCar = 0, lobby = null, laps = 3, names = {};
let snaps = [], offset = null, goAt = 0, lastCount = '';
let prevAir = 0, prevClean = 0, prevLoop = false;
let orbit = 0, cue = '', cueUntil = 0, lastHud = 0, lastSend = 0, wantBoost = false, prevHot = [0, 0, 0];
const GRID = [0, 1, 2, 3].map(slot => [-7 - Math.floor(slot / 2) * 9 - (slot % 2) * 3, slot % 2 ? 3.6 : -3.6, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

// ---------- network ----------
let stored = ''; try { stored = localStorage.getItem('saltline.name') || ''; } catch {}
$('name').value = stored;
let net = null;                                           // set once connect() resolves (see the end of this file)
const send = msg => net?.send(JSON.stringify(msg));
function onMessage(text) {
  if (text[0] === '[') {                                  // race snapshot
    if (state === 'lobby') return;
    const d = JSON.parse(text), recv = performance.now() / 1000;
    if (snaps.length > 1 && d[0] <= snaps.at(-1).t) return; // stale or duplicate
    const o = d[0] - recv; offset = offset === null ? o : Math.max(o, offset - 0.0003);
    snaps.push({ t: d[0], cars: d[1], finish: d[2], order: d[3] }); if (snaps.length > 40) snaps.shift();
    return;
  }
  const m = JSON.parse(text);
  if (m.t === 'lobby') { lobby = m; me = m.you; myCar = m.players.find(p => p.id === me)?.car ?? myCar; renderLobby(); }
  else if (m.t === 'start') beginRace(m);
  else if (m.t === 'note') { $('note').textContent = m.text; $('resultNote').textContent = m.text; }
  else if (m.t === 'full') fatal('This room already has four pilots. Open the game without a room code to start your own.');
}

// ---------- lobby ----------
const carButtons = CARS.map((car, id) => {
  const b = document.createElement('button'); b.style.setProperty('--hue', car.color);
  const stat = (label, v) => `<span class="stat">${label}<i style="--v:${Math.round(v * 100)}%"></i></span>`;
  b.innerHTML = `<b>${car.name}</b><small>${car.blurb}</small>${stat('SPEED', (car.top - 100) / 30)}${stat('ACCEL', car.accel / 48)}${stat('GRIP', car.grip / 1.25)}<span class="who"></span>`;
  b.onclick = () => { sound.wake(); send({ t: 'pick', car: id }); };
  $('cars').append(b); return b;
});
function renderLobby() {
  if (!lobby) return;
  $('count').textContent = lobby.players.length + (lobby.players.length === 1 ? ' pilot' : ' pilots') + ' · empty seats are computer-driven';
  carButtons.forEach((b, id) => {
    const owner = lobby.players.find(p => p.car === id), mine = owner?.id === me;
    b.classList.toggle('mine', mine); b.disabled = !!owner && !mine; b.setAttribute('aria-pressed', String(mine));
    b.querySelector('.who').textContent = mine ? 'YOU' : owner ? owner.name.toUpperCase() : 'CPU';
  });
  $('share').textContent = lobby.share.length ? 'Invite link: ' + lobby.share.join('  or  ') : '';
  $('copy').hidden = !lobby.share.length;
  if (lobby.phase !== 'lobby' && state === 'lobby') $('note').textContent = 'A race is in progress. You will join the next one.';
  else if (lobby.phase === 'lobby') { $('note').textContent = ''; $('resultNote').textContent = ''; }
}
$('name').onchange = () => { const name = $('name').value.trim(); try { localStorage.setItem('saltline.name', name); } catch {} send({ t: 'name', name }); };
const launch = () => { sound.wake(); send({ t: 'launch', laps: Number($('laps').value) }); };
$('launch').onclick = launch; $('again').onclick = launch;
$('toLobby').onclick = () => show('lobby');
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText(lobby.share[0]); $('copy').textContent = 'Copied'; } catch { $('copy').textContent = 'Copy failed: select the link'; }
  setTimeout(() => { $('copy').textContent = 'Copy invite link'; }, 1600);
};

function show(next) {
  state = next;
  $('lobby').hidden = next !== 'lobby'; $('hud').hidden = next === 'lobby'; $('results').hidden = next !== 'results';
  $('countdown').hidden = next !== 'countdown' && !(next === 'race' && performance.now() < goAt + 900);
  if (next === 'lobby') { snaps = []; sleds.forEach(s => s.resetTrails()); renderLobby(); }
  $('view').focus({ preventScroll: true });
}

function beginRace(m) {
  myCar = m.car; laps = m.laps; names = m.names;
  const d = JSON.parse(m.frame); snaps = [{ t: d[0], cars: d[1], finish: d[2], order: d[3] }]; offset = null;
  goAt = performance.now() + m.countdown; lastCount = ''; prevHot = [0, 0, 0]; cue = ''; prevAir = 0; prevClean = 0; prevLoop = false;
  sleds.forEach(s => s.resetTrails()); show('countdown');
}

// ---------- input ----------
const keys = new Set();
const KEYMAP = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ArrowUp: 'gas', KeyW: 'gas', ArrowDown: 'brake', KeyS: 'brake', ShiftLeft: 'brake', ShiftRight: 'brake' };
addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  sound.wake();
  if (KEYMAP[e.code]) { keys.add(KEYMAP[e.code]); e.preventDefault(); }
  else if (e.code === 'Space') { if (!e.repeat) wantBoost = true; e.preventDefault(); }
  else if (e.code === 'KeyM') sound.mute();
  else if (e.code === 'Enter' && (state === 'lobby' || state === 'results')) launch();
});
addEventListener('keyup', e => { if (KEYMAP[e.code]) keys.delete(KEYMAP[e.code]); });
addEventListener('blur', () => keys.clear());
addEventListener('pointerdown', () => sound.wake());
let padBoost = false;
function readInput() {
  let steer = Number(keys.has('right')) - Number(keys.has('left')), gas = Number(keys.has('gas')), brake = Number(keys.has('brake'));
  const pad = [...(navigator.getGamepads?.() || [])].find(p => p?.connected);
  if (pad) {
    const x = pad.axes[0] || 0; if (Math.abs(x) > 0.12) steer += Math.sign(x) * Math.pow((Math.abs(x) - 0.12) / 0.88, 1.2);
    gas = Math.max(gas, pad.buttons[7]?.value || 0); brake = Math.max(brake, pad.buttons[6]?.value || 0);
    const pressed = !!pad.buttons[0]?.pressed; if (pressed && !padBoost) wantBoost = true; padBoost = pressed;
  }
  return { steer: clamp(steer, -1, 1), gas, brake };
}

// ---------- snapshot interpolation ----------
const DELAY = 0.06, FIELDS = 18, blended = [0, 1, 2, 3].map(() => new Array(FIELDS).fill(0));
function sample() {
  const last = snaps.at(-1); if (!last) return null;
  if (snaps.length === 1 || offset === null) return { ...last };
  const target = performance.now() / 1000 + offset - DELAY;
  let i = snaps.length - 2; while (i > 0 && snaps[i].t > target) i--;
  const a = snaps[i], b = snaps[i + 1], f = clamp((target - a.t) / Math.max(1e-4, b.t - a.t), 0, 1.6);
  for (let c = 0; c < 4; c++) {
    const A = a.cars[c], B = b.cars[c], out = blended[c];
    for (let k = 0; k < FIELDS; k++) out[k] = k < 5 || k === 15 ? lerp(A[k], B[k], f) : B[k];
  }
  return { t: lerp(a.t, b.t, Math.min(f, 1.6)), cars: blended, finish: last.finish, order: last.order };
}

// ---------- camera ----------
const F0 = newFrame(), F1 = newFrame(), V = new THREE.Vector3(), R = new THREE.Vector3(), U = new THREE.Vector3(), LOOK = new THREE.Vector3(), UP = new THREE.Vector3();
function chase(st, dt) {
  const [s, lane, v] = st, top = CARS[myCar].top, hot = st[5] > 0 || st[6] > 0 || st[7] > 0;
  T.frame(s - 8.4, F0); T.frame(s + 20, F1);
  V.fromArray(F0.p).addScaledVector(R.fromArray(F0.r), lane * 0.86).addScaledVector(U.fromArray(F0.u), 3.1);
  V.y += st[15] * 0.85; world.camera.position.copy(V);
  LOOK.fromArray(F1.p).addScaledVector(R.fromArray(F1.r), lane * 0.7).addScaledVector(UP.fromArray(F1.u), 1.4);
  world.camera.up.copy(U).addScaledVector(R.fromArray(F0.r), st[4] * 0.05).normalize(); LOOK.y += st[15] * 0.7; world.camera.lookAt(LOOK);
  const fov = 60 + 16 * clamp(v / top, 0, 1.3) + (hot ? 6 : 0);
  world.camera.fov = lerp(world.camera.fov, fov, 1 - Math.exp(-dt * 6)); world.camera.updateProjectionMatrix();
}
function showroom(dt) {
  orbit += dt * 0.22; const target = sleds[myCar].pos;
  world.camera.up.set(0, 1, 0); world.camera.position.set(target.x + Math.sin(orbit) * 7.2, target.y + 2.3, target.z + Math.cos(orbit) * 7.2);
  world.camera.lookAt(target.x, target.y + 0.3, target.z); world.camera.fov = lerp(world.camera.fov, 42, 0.1); world.camera.updateProjectionMatrix();
}

// ---------- HUD ----------
function setCue(text, seconds) { cue = text; cueUntil = performance.now() + seconds * 1000; }
function hud(view, now) {
  const st = view.cars[myCar];
  if (st[5] > 0 && !prevHot[0]) setCue('BOOST', 0.9); if (st[6] > 0 && !prevHot[1]) setCue('BOOST PAD', 0.9); if (st[7] > 0 && !prevHot[2]) setCue('DRIFT KICK', 0.9);
  prevHot = [st[5] > 0, st[6] > 0, st[7] > 0];
  if (st[16] !== prevAir) {
    if (st[16] === 1) setCue('AIRBORNE', 1.2); else if (st[16] === 2) { setCue('SPLASHDOWN', 1.6); sound.beep(180, 0.5); }
    else if (prevAir === 1) setCue(st[17] > prevClean ? 'CLEAN LANDING  +ENERGY' : 'TOUCHDOWN', 1.2);
    prevAir = st[16];
  }
  prevClean = st[17];
  const looping = T.inLoop(st[0]); if (looping && !prevLoop) setCue('LOOP', 1.0); prevLoop = looping;
  if (now - lastHud < 80) return; lastHud = now;
  $('place').innerHTML = (view.order.indexOf(myCar) + 1) + '<em>/4</em>';
  $('lap').textContent = 'LAP ' + clamp(Math.floor(st[0] / T.length) + 1, 1, laps) + ' / ' + laps;
  $('clock').textContent = clock(view.finish[myCar] ?? view.t);
  $('speed').textContent = Math.round(st[2] * 3.6);
  $('energy').style.width = st[8] * 100 + '%'; $('charge').style.width = st[10] * 100 + '%';
  $('cue').textContent = now < cueUntil ? cue : st[14] > 0.45 ? 'SLIPSTREAM' : '';
}
function results(view) {
  const place = view.order.indexOf(myCar);
  $('resultTitle').textContent = ['VICTORY', 'SECOND PLACE', 'THIRD PLACE', 'FOURTH PLACE'][place];
  $('resultList').innerHTML = view.order.map((car, i) => {
    const who = car === myCar ? 'you' : names[car] ?? 'CPU', time = view.finish[car];
    return `<li class="${car === myCar ? 'me' : ''}"><b>${i + 1}</b><div>${CARS[car].name}<span></span></div><div>${time === undefined ? 'on course' : clock(time)}</div></li>`
      .replace('<span></span>', '<span>' + who.replace(/[<>&]/g, '') + '</span>');
  }).join('');
}

// ---------- main loop ----------
let previous = performance.now(), time = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - previous) / 1000); previous = now; time += dt;
  let blur = 0, speed = 0, hot = 0;

  if (state === 'lobby') {
    sleds.forEach((sled, id) => sled.place(T, GRID[id], time)); showroom(dt);
  } else {
    const view = sample();
    if (view) {
      sleds.forEach((sled, id) => sled.place(T, view.cars[id], time));
      const st = view.cars[myCar]; chase(st, dt); hud(view, now);
      speed = st[2]; hot = st[5] > 0 || st[6] > 0 || st[7] > 0 ? 1 : 0;
      blur = clamp((speed - 55) / 80, 0, 1) * (0.55 + 0.45 * hot);
      if (state !== 'results' && view.finish[myCar] !== undefined) { show('results'); sound.beep(880, 0.5); }
      if (state === 'results') results(view);
    }
    if (state === 'countdown' || now < goAt + 900) {
      const left = (goAt - now) / 1000, label = left > 0 ? String(Math.min(3, Math.ceil(left))) : 'GO';
      if (label !== lastCount) { lastCount = label; $('countdown').textContent = label; sound.beep(label === 'GO' ? 990 : 495, label === 'GO' ? 0.45 : 0.16); }
      $('countdown').hidden = state === 'results';
      if (left <= 0 && state === 'countdown') show('race');
    } else $('countdown').hidden = true;
    if (state === 'race' && now - lastSend > 15) {
      const input = readInput(); lastSend = now;
      send({ t: 'in', s: input.steer, g: input.gas, b: input.brake, x: wantBoost ? 1 : 0 }); wantBoost = false;
    }
  }
  sound.drive(speed, hot, state === 'race' || state === 'countdown');
  world.render(dt, blur, sleds[myCar].pos);
}
show('lobby');
requestAnimationFrame(loop);
connect({ name: stored, track: T, onMessage, onClose: reason => { if ($('fatal').hidden) fatal(reason); }, onStatus: text => { $('note').textContent = text; } })
  .then(n => { net = n; $('room').textContent = n.room.toUpperCase(); })
  .catch(error => { console.error(error); fatal(error.message || String(error)); });

// Read-only hook used by the automated smoke test.
window.saltline = { world, track: T, sleds, get state() { return state; }, get car() { return myCar; }, get view() { return sample(); }, get players() { return lobby?.players; } };
