// Networking. Two transports, one message protocol:
//  - "server": the page is served by server.mjs, which runs the race; we talk to it over a WebSocket.
//  - "peers":  the page is static (the published web version). The first player to open a room
//              hosts the race inside their own browser, and friends connect straight to them
//              over WebRTC. A public PeerJS broker is used only to introduce the browsers.
const PREFIX = 'saltline-v1-';
const CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function loadScript(src) {
  return new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src)); document.head.append(s); });
}

// Resolves to { room, mode, send(text) }. onMessage(text) receives everything the room sends.
export async function connect({ name, track, onMessage, onClose, onStatus }) {
  const params = new URLSearchParams(location.search);
  let room = (params.get('room') || '').replace(/[^\w-]/g, '').slice(0, 24);
  const served = await fetch('mode.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null);

  if (served?.mode === 'server') {
    room = room || 'main';
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`);
    ws.onmessage = e => onMessage(e.data);
    ws.onclose = () => onClose('Connection to the Saltline server was lost. Restart the server and reload this page.');
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('Could not reach the Saltline server.')); });
    return { room, mode: 'server', send: text => { if (ws.readyState === 1) ws.send(text); } };
  }

  onStatus('Connecting…');
  await loadScript('vendor/peerjs.min.js');
  const Peer = window.Peer || window.peerjs?.Peer;
  const openPeer = id => new Promise((resolve, reject) => {
    const peer = id ? new Peer(id) : new Peer();
    peer.on('open', () => resolve(peer)); peer.on('error', e => reject(e));
  });

  async function host() {
    const peer = await openPeer(PREFIX + room);
    const { Room } = await import('./shared/room.mjs');
    const link = `${location.origin}${location.pathname}?room=${room}`;
    const game = new Room(room, track, () => [link]);
    peer.on('connection', conn => conn.on('open', () => {
      const p = game.join(text => { if (conn.open) conn.send(text); }, conn.metadata?.name || '');
      if (!p) { setTimeout(() => conn.close(), 800); return; }
      conn.on('data', data => game.message(p, String(data)));
      conn.on('close', () => game.leave(p));
    }));
    peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* the broker is only needed for new joins */ } });
    // A worker keeps the race clock running at full rate even if this tab is in the background.
    const clock = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 4)'], { type: 'text/javascript' })));
    clock.onmessage = () => game.step(performance.now());
    const me = game.join(text => queueMicrotask(() => onMessage(text)), name);
    onStatus('');
    return { room, mode: 'host', send: text => game.message(me, text) };
  }

  async function guest() {
    const peer = await openPeer();
    return new Promise((resolve, reject) => {
      const conn = peer.connect(PREFIX + room, { reliable: true, serialization: 'raw', metadata: { name } });
      const giveUp = setTimeout(() => { peer.destroy(); reject({ type: 'timeout' }); }, 12000);
      peer.on('error', e => { clearTimeout(giveUp); peer.destroy(); reject(e); });
      conn.on('open', () => {
        clearTimeout(giveUp); onStatus('');
        conn.on('data', data => onMessage(String(data)));
        conn.on('close', () => onClose('The host left, so this room has closed. Reload to start a new one.'));
        resolve({ room, mode: 'guest', send: text => { if (conn.open) conn.send(text); } });
      });
    });
  }

  if (!room) {                                   // no code in the address: open a fresh room and host it
    room = Array.from(crypto.getRandomValues(new Uint8Array(5)), v => CODE[v % CODE.length]).join('');
    history.replaceState(null, '', `${location.pathname}?room=${room}`);
    return host();
  }
  try { return await guest(); }                  // a code in the address: join it if someone is hosting…
  catch (e) {
    if (e?.type !== 'peer-unavailable' && e?.type !== 'timeout') throw new Error('Could not connect: ' + (e?.type || e?.message || e));
    try { return await host(); }                 // …otherwise become its host
    catch (e2) { if (e2?.type === 'unavailable-id') return guest(); throw new Error('Could not open the room: ' + (e2?.type || e2?.message || e2)); }
  }
}
