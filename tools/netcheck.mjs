// Connectivity probe: which kinds of WebRTC route can a browser on this network obtain?
//   chrome --headless=new --mute-audio --remote-debugging-port=9334 --user-data-dir=<dir> about:blank
//   node tools/netcheck.mjs 9334 https://bihyungbetter.github.io/saltline/
// "host" = same network only, "srflx" = direct across the internet (most home routers),
// "relay" = via a TURN server (needed when either player is behind a strict or mobile network).
const [port, url] = [process.argv[2], process.argv[3]];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) pending.get(m.id)?.(m); };
const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const run = async x => { const r = (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result; return r?.result?.value ?? r?.exceptionDetails?.exception?.description; };
await send('Runtime.enable'); await sleep(6000);
const probe = servers => `(async () => {
  const pc = new RTCPeerConnection({ iceServers: ${JSON.stringify(servers)} }), seen = {}, errors = [];
  pc.onicecandidate = e => { if (e.candidate) seen[e.candidate.type] = (seen[e.candidate.type] || 0) + 1; };
  pc.onicecandidateerror = e => errors.push(e.url + ' ' + e.errorCode + ' ' + e.errorText);
  pc.createDataChannel('x'); await pc.setLocalDescription(await pc.createOffer());
  await new Promise(r => { pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 12000); });
  pc.close(); return JSON.stringify({ seen, errors: [...new Set(errors)].slice(0, 6) });
})()`;
const sets = JSON.parse(process.argv[4] || 'null') || {
  'PeerJS defaults': await run(`(() => { const P = window.Peer || window.peerjs?.Peer; try { const p = new P({}); const c = p.options?.config?.iceServers; p.destroy(); return JSON.stringify(c); } catch (e) { return 'null'; } })()`).then(JSON.parse),
};
for (const [label, servers] of Object.entries(sets)) { console.log(label, JSON.stringify(servers)); console.log('  ->', await run(probe(servers))); }
await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
ws.close();
