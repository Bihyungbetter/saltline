// Networking. One message protocol, three ways of carrying it:
//  - "server": the page is served by server.mjs, which runs the race; we talk to it over a WebSocket.
//  - "direct": the published web version. The first player to open a room hosts the race inside
//              their own browser and friends connect straight to them over WebRTC (PeerJS).
//  - "relay":  the fallback when a network refuses direct connections (mobile data, school or
//              office Wi-Fi). Messages go through a public MQTT broker instead: slower, but it
//              works anywhere ordinary secure web traffic does.
// Add ?relay=1 to the address to force the relay (used by the tests).
import { openRelay, RELAYS } from './relay.js';

const PREFIX = 'saltline-v1-', TOPIC = 'saltline/v1/';
const CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const random = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), v => CODE[v % CODE.length]).join('');

function loadScript(src) {
  return new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src)); document.head.append(s); });
}

// Resolves to { room, mode, slow, send(text) }. onMessage(text) receives everything the room sends.
export async function connect({ name, track, onMessage, onClose, onStatus }) {
  const params = new URLSearchParams(location.search);
  let room = (params.get('room') || '').replace(/[^\w-]/g, '').slice(0, 24);
  const forceRelay = params.get('relay') === '1';
  const served = await fetch('mode.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null);

  if (served?.mode === 'server') {
    room = room || 'main';
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`);
    ws.onmessage = e => onMessage(e.data);
    ws.onclose = () => onClose('Connection to the Saltline server was lost. Restart the server and reload this page.');
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('Could not reach the Saltline server.')); });
    return { room, mode: 'server', slow: false, send: text => { if (ws.readyState === 1) ws.send(text); } };
  }

  onStatus('Connecting…');
  await loadScript('vendor/peerjs.min.js').catch(() => {});
  const Peer = window.Peer || window.peerjs?.Peer;
  // Rejects with { type } - PeerJS error types, or 'timeout' / 'no-peerjs'.
  const openPeer = id => new Promise((resolve, reject) => {
    if (!Peer) { reject({ type: 'no-peerjs' }); return; }
    const peer = id ? new Peer(id) : new Peer(), late = setTimeout(() => { peer.destroy(); reject({ type: 'timeout' }); }, 9000);
    peer.on('open', () => { clearTimeout(late); resolve(peer); }); peer.on('error', e => { clearTimeout(late); reject(e); });
  });

  // ---- host: run the race here, accept friends directly and through every relay ----
  async function host() {
    let peer = null;
    try { peer = await openPeer(PREFIX + room); }
    catch (e) { if (e?.type === 'unavailable-id') throw e; }           // any other failure: host through the relays alone
    const { Room } = await import('./shared/room.mjs');
    const link = `${location.origin}${location.pathname}?room=${room}`, base = TOPIC + room;
    const game = new Room(room, track, () => [link]);
    if (peer) {
      peer.on('connection', conn => conn.on('open', () => {
        const p = game.join(text => { if (conn.open) conn.send(text); }, conn.metadata?.name || '');
        if (!p) { setTimeout(() => conn.close(), 800); return; }
        conn.on('data', data => game.message(p, String(data)));
        conn.on('close', () => game.leave(p));
      }));
      peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* the broker is only needed for new joins */ } });
    }
    const relayed = new Map();                                         // guest id -> { p, last }
    for (const url of RELAYS) {
      let relay = null;
      openRelay(url, {
        will: { topic: base + '/x', message: 'closed' },
        onMessage(topic, text) {
          if (!topic.startsWith(base + '/g/')) return;
          const gid = topic.slice(base.length + 3), kind = text[0]; let g = relayed.get(gid);
          if (kind === 'J' && !g) {
            const p = game.join(t => relay.publish(base + '/h/' + gid, t), text.slice(1), true);
            if (p) relayed.set(gid, g = { p, last: performance.now() });
          } else if (g) {
            g.last = performance.now();
            if (kind === 'M') game.message(g.p, text.slice(1));
            else if (kind === 'B') { game.leave(g.p); relayed.delete(gid); }
          }
        },
      }).then(r => { relay = r; r.subscribe(base + '/g/+'); }).catch(() => { /* this relay is unreachable from here */ });
    }
    setInterval(() => { for (const [gid, g] of relayed) if (performance.now() - g.last > 12000) { game.leave(g.p); relayed.delete(gid); } }, 3000);
    // A worker keeps the race clock running at full rate even if this tab is in the background.
    const clock = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 4)'], { type: 'text/javascript' })));
    clock.onmessage = () => game.step(performance.now());
    const me = game.join(text => queueMicrotask(() => onMessage(text)), name);
    onStatus('');
    return { room, mode: 'host', slow: false, send: text => game.message(me, text) };
  }

  // ---- guest, direct: browser to browser ----
  async function guestDirect() {
    const peer = await openPeer();
    return new Promise((resolve, reject) => {
      const conn = peer.connect(PREFIX + room, { reliable: true, serialization: 'raw', metadata: { name } });
      const giveUp = setTimeout(() => { peer.destroy(); reject({ type: 'blocked' }); }, 7000);
      peer.on('error', e => { clearTimeout(giveUp); peer.destroy(); reject(e); });
      conn.on('open', () => {
        clearTimeout(giveUp); onStatus('');
        conn.on('data', data => onMessage(String(data)));
        conn.on('close', () => onClose('The host left, so this room has closed. Reload to start a new one.'));
        resolve({ room, mode: 'direct', slow: false, send: text => { if (conn.open) conn.send(text); } });
      });
    });
  }

  // ---- guest, relayed: knock on every relay and use whichever the host answers on first ----
  function guestRelay() {
    const gid = random(8), base = TOPIC + room, mine = base + '/g/' + gid;
    return new Promise((resolve, reject) => {
      let chosen = null; const opened = [];
      const giveUp = setTimeout(() => { if (!chosen) { opened.forEach(r => r.close()); reject({ type: 'no-host' }); } }, 8000);
      for (const url of RELAYS) {
        let relay = null;
        openRelay(url, {
          will: { topic: mine, message: 'B' },
          onMessage(topic, text) {
            if (topic === base + '/x') { if (chosen === relay) onClose('The host left, so this room has closed. Reload to start a new one.'); return; }
            if (!chosen) {
              chosen = relay; clearTimeout(giveUp); opened.forEach(r => r !== relay && r.close()); onStatus('');
              setInterval(() => relay.publish(mine, 'P'), 3000);
              resolve({ room, mode: 'relay', slow: true, send: t => relay.publish(mine, 'M' + t) });
            }
            if (chosen === relay) onMessage(text);
          },
          onClose() { if (chosen === relay) onClose('The relay connection dropped. Reload the page to rejoin.'); },
        }).then(r => {
          relay = r; opened.push(r);
          if (chosen) { r.close(); return; }
          r.subscribe(base + '/h/' + gid); r.subscribe(base + '/x');
          setTimeout(() => { if (!chosen) r.publish(mine, 'J' + name); }, 350);
        }).catch(() => { /* this relay is unreachable from here */ });
      }
    });
  }

  if (!room) {                                   // no code in the address: open a fresh room and host it
    room = random(5);
    history.replaceState(null, '', `${location.pathname}?room=${room}`);
    return host();
  }
  // A code in the address: join it directly if possible, through a relay if not, and host it if nobody is there.
  let someoneHosting = false;
  if (!forceRelay) {
    try { return await guestDirect(); }
    catch (e) { someoneHosting = e?.type === 'blocked'; if (e?.type === 'peer-unavailable') { try { return await host(); } catch (e2) { if (e2?.type !== 'unavailable-id') throw new Error('Could not open the room (' + (e2?.type || e2?.message || 'unknown error') + ').'); } } }
  }
  onStatus(someoneHosting ? 'This network blocks direct connections. Switching to the relay…' : 'Looking for the room…');
  try { return await guestRelay(); } catch { /* nobody answered on any relay */ }
  try { return await host(); }
  catch (e) {
    throw new Error(e?.type === 'unavailable-id'
      ? 'Found the room, but could not connect to its host either directly or through the relay. Ask the host to reload their page, then open the invite link again.'
      : 'Could not connect (' + (e?.type || e?.message || 'unknown error') + '). Check your internet connection and reload.');
  }
}
