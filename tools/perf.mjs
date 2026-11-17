// Frame-rate probe: measures the lobby scene with individual render features switched off.
//   node tools/perf.mjs 9334 http://127.0.0.1:8090
const [port, base] = [process.argv[2], process.argv[3]];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base + '/?room=perf-' + Date.now())}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) pending.get(m.id)?.(m); };
const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const run = async x => { const r = (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result; return r?.result?.value ?? r?.exceptionDetails?.exception?.description; };
await send('Runtime.enable'); await sleep(7000);
const fps = () => run(`new Promise(r => { let n = 0; const t = performance.now(); const f = () => { n++; performance.now() - t < 2500 ? requestAnimationFrame(f) : r(Math.round(n / 2.5)); }; requestAnimationFrame(f); })`);
const info = await run(`(() => { const r = saltline.world.renderer, gl = r.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); r.info.autoReset = true;
  return JSON.stringify({ gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown', calls: r.info.render.calls, triangles: r.info.render.triangles, size: [r.domElement.width, r.domElement.height] }); })()`);
console.log(info);
console.log('baseline             ', await fps());
const cpu = await run(`(() => { const w = saltline.world, t = performance.now(); for (let i = 0; i < 20; i++) w.render(0.016, 0, saltline.sleds[0].pos); w.renderer.getContext().finish(); return ((performance.now() - t) / 20).toFixed(1); })()`);
console.log('ms per render() call ', cpu);
// Each step is cumulative.
const steps = [
  ['msaa off            ', `(() => { const c = saltline.world.composer; for (const t of [c.renderTarget1, c.renderTarget2]) { t.samples = 0; t.dispose(); } })()`],
  ['+ passes 2-3 off    ', `saltline.world.composer.passes.slice(1, 3).forEach(p => p.enabled = false)`],
  ['+ instances hidden  ', `saltline.world.scene.traverse(o => { if (o.isInstancedMesh) o.visible = false; })`],
  ['+ deck hidden       ', `saltline.world.deck.visible = false`],
  ['+ mirror hidden     ', `saltline.world.scene.traverse(o => { if (o.isReflector) o.visible = false; })`],
  ['+ sleds hidden      ', `saltline.sleds.forEach(s => { s.group.visible = false; s.trails.forEach(t => t.mesh.visible = false); })`],
  ['+ shadows off       ', `saltline.world.renderer.shadowMap.enabled = false`],
];
for (const [label, code] of steps) { const r = await run(code); if (typeof r === 'string') console.log('  (error: ' + r.slice(0, 160) + ')'); console.log(label, await fps()); }
await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
ws.close();
