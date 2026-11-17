// End-to-end smoke test: two browser tabs join one room and race each other.
//   1. node server.mjs 8090
//   2. two Chromes, one per player, so neither tab is throttled in the background:
//      chrome --headless=new --mute-audio --remote-debugging-port=9334 --user-data-dir=<a> about:blank   (and 9335 with <b>)
//      Always pass --mute-audio: the game synthesises engine noise and beeps, and headless Chrome still plays them out loud.
//   3. node tools/smoke.mjs 9334,9335 http://127.0.0.1:8090 out-dir
import { writeFileSync, mkdirSync } from 'node:fs';
const [ports, base, out] = [process.argv[2].split(','), process.argv[3], process.argv[4] || '.'];
mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tab(url, port) {
  let target;
  for (let i = 0; i < 40 && !target; i++) { try { target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json(); } catch { await sleep(500); } }
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(), logs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id) pending.get(m.id)?.(m);
    else if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 500));
    else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(m.params.type + ' ' + m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 400));
    else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) logs.push('HTTP ' + m.params.response.status + ' ' + m.params.response.url);
  };
  const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable'); await send('Page.reload');
  return {
    logs,
    close: () => fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {}),
    eval: async x => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value,
    key: (type, code, vk) => send('Input.dispatchKeyEvent', { type, code, key: code, windowsVirtualKeyCode: vk }),
    shot: async name => writeFileSync(`${out}/${name}`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')),
  };
}

const probe = `JSON.stringify({state: saltline.state, car: saltline.car, players: saltline.players?.length, v: saltline.view?.cars.map(c => [Math.round(c[0]), Math.round(c[1] * 10) / 10, Math.round(c[2])]), order: saltline.view?.order, t: saltline.view?.t})`;
const fail = message => { console.error('FAIL: ' + message); process.exitCode = 1; };

const room = 'smoke-' + Date.now(); // a fresh room per run, so earlier runs cannot interfere
async function ready(t, name) { // wait until the page has built its scene and joined the lobby
  const started = Date.now();
  while (Date.now() - started < 40000) { if (await t.eval(`!!(window.saltline && saltline.players)`) === true) { console.log(`tab ${name} ready after ${((Date.now() - started) / 1000).toFixed(1)} s`); return; } await sleep(250); }
  fail(`tab ${name} never joined the lobby`);
}
const extra = process.argv[5] || '';   // e.g. "&relay=1" to force the relay transport on the static build
const a = await tab(`${base}/?room=${room}${extra}`, ports[0]); await ready(a, 'A');
const b = await tab(`${base}/?room=${room}${extra}`, ports[1] || ports[0]); await ready(b, 'B'); await sleep(1500);
console.log('connection A:', await a.eval(`document.getElementById('room').textContent`), '| B:', await b.eval(`document.getElementById('room').textContent`));
const la = JSON.parse(await a.eval(probe)), lb = JSON.parse(await b.eval(probe));
console.log('lobby A', JSON.stringify(la)); console.log('lobby B', JSON.stringify(lb));
if (la.players !== 2 || lb.players !== 2) fail('both tabs should see two pilots');
if (la.car === lb.car) fail('pilots must hold different sleds');
await a.shot('lobby.png');
// Overhead view of the circuit and the water mirror, by overriding the camera for a moment.
await a.eval(`(() => { const w = saltline.world, T = saltline.track, real = w.render; saltline.restore = () => { w.render = real; };
  w.render = (dt, blur) => { const c = w.camera; c.up.set(0, 1, 0); c.position.set(T.px[0] + 260, 150, T.pz[0] + 330); c.lookAt(T.px[120], 20, T.pz[120]); c.fov = 55; c.updateProjectionMatrix(); real(dt, 0); }; })()`);
await sleep(700); await a.shot('overview.png'); await a.eval('saltline.restore()');
// The stunts: a loop seen from outside, and a jump gap seen from beside the ramp.
const stunts = await a.eval(`(() => { const T = saltline.track, at = s => Math.round(s / T.step) % T.n, P = i => [T.px[i], T.py[i], T.pz[i]], R = i => [T.rx[i], T.ry[i], T.rz[i]];
  const l = T.loops[0], j = T.jumps[0], li = at(l.start), lm = at((l.start + l.end) / 2), ji = at(j.lip - 40), jm = at((j.lip + j.land) / 2);
  return JSON.stringify([['loop.png', P(li).map((v, k) => v + R(li)[k] * 95 + (k === 1 ? 30 : 0) - [T.fx[li], 0, T.fz[li]][k] * 60), P(lm)], ['jump.png', P(ji).map((v, k) => v + R(ji)[k] * 42 + (k === 1 ? 16 : 0)), P(jm)]]); })()`);
for (const [name, eye, look] of JSON.parse(stunts)) {
  await a.eval(`(() => { const w = saltline.world, real = w.render; document.getElementById('lobby').style.visibility = 'hidden';
    saltline.restore = () => { w.render = real; document.getElementById('lobby').style.visibility = ''; };
    w.render = (dt, blur, focus) => { const c = w.camera; c.up.set(0, 1, 0); c.position.set(${eye.join(',')}); c.lookAt(${look.join(',')}); c.fov = 58; c.updateProjectionMatrix(); real(dt, 0, focus); }; })()`);
  await sleep(600); await a.shot(name); await a.eval('saltline.restore()');
}
// Close-ups of the sleds on the grid, with the lobby panel hidden.
for (const [name, dx, dy, dz, car] of [['sleds-front.png', -5.5, 2.0, -9.5, 0], ['sleds-rear.png', 6.5, 2.6, 8.5, 1], ['sleds-side.png', -9, 1.4, 1, 2]]) {
  await a.eval(`(() => { const w = saltline.world, real = w.render, p = saltline.sleds[${car}].pos; document.getElementById('lobby').style.visibility = 'hidden';
    saltline.restore = () => { w.render = real; document.getElementById('lobby').style.visibility = ''; };
    w.render = (dt, blur, focus) => { const c = w.camera; c.up.set(0, 1, 0); c.position.set(p.x + ${dx}, p.y + ${dy}, p.z + ${dz}); c.lookAt(p.x, p.y + 0.2, p.z); c.fov = 40; c.updateProjectionMatrix(); real(dt, 0, focus); }; })()`);
  await sleep(600); await a.shot(name); await a.eval('saltline.restore()');
}

await a.eval(`document.getElementById('launch').click()`); await sleep(4200);
await a.key('keyDown', 'ArrowUp', 38); await b.key('keyDown', 'ArrowUp', 38);
await sleep(5000); await b.key('keyDown', 'ArrowRight', 39); await sleep(700); await b.key('keyUp', 'ArrowRight', 39);
await a.key('keyDown', 'Space', 32); await a.key('keyUp', 'Space', 32);
await sleep(7000);
const ra = JSON.parse(await a.eval(probe)), rb = JSON.parse(await b.eval(probe));
console.log('race A', JSON.stringify(ra)); console.log('race B', JSON.stringify(rb));
if (ra.state !== 'race' || rb.state !== 'race') fail('both tabs should be racing');
if (!(ra.v?.[la.car][2] > 60 && ra.v?.[lb.car][2] > 60)) fail('both human sleds should be at speed');
if (!ra.v || !rb.v || Math.abs(ra.v[lb.car][0] - rb.v[lb.car][0]) > 40) fail('tabs disagree about sled positions');
await a.shot('race-a.png'); await b.shot('race-b.png');
// Keep driving until tab A has been photographed inside a loop and in mid-air over a jump.
let sawLoop = false, sawAir = false;
for (const until = Date.now() + 40000; Date.now() < until && !(sawLoop && sawAir);) {
  const [inLoop, air] = JSON.parse(await a.eval(`JSON.stringify((c => [saltline.track.inLoop(c[0]) && saltline.track.inLoop(c[0] - 70), c[16]])(saltline.view.cars[saltline.car]))`));
  if (inLoop && !sawLoop) { await a.shot('in-loop.png'); sawLoop = true; }
  if (air === 1 && !sawAir) { await sleep(250); await a.shot('airborne.png'); sawAir = true; }
  await sleep(50);
}
if (!sawLoop) fail('tab A never drove through a loop'); if (!sawAir) fail('tab A never left the ground at a jump');
// Render cost is timed directly: headless Chrome throttles requestAnimationFrame unpredictably, so a frame count is not reliable.
const cost = await a.eval(`(() => { const w = saltline.world, t = performance.now(); for (let i = 0; i < 30; i++) w.render(0.016, 0.5, saltline.sleds[0].pos); w.renderer.getContext().finish(); return (performance.now() - t) / 30; })()`);
console.log('render cost in tab A:', cost.toFixed(1), 'ms per frame');
if (cost > 12) fail('a frame should render in under 12 ms on this machine');
for (const [name, t] of [['A', a], ['B', b]]) if (t.logs.length) { console.log('log ' + name + ':\n  ' + t.logs.slice(0, 12).join('\n  ')); if (t.logs.some(l => /EXCEPTION|HTTP/.test(l))) fail('page errors in tab ' + name); }
await a.close(); await b.close();
console.log(process.exitCode ? 'SMOKE TEST FAILED' : 'SMOKE TEST PASSED');
process.exit();
