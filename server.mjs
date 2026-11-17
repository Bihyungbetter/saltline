// Saltline server: static files + authoritative race rooms over WebSocket.
//   node server.mjs [port]
// (The published web version needs no server: see client/net.js and tools/build-static.mjs.)
import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { buildTrack } from './shared/track.mjs';
import { Room } from './shared/room.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const track = buildTrack();

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const MOUNTS = [['/three/', path.join(ROOT, 'node_modules', 'three')], ['/shared/', path.join(ROOT, 'shared')], ['/', path.join(ROOT, 'client')]];
const server = http.createServer(async (req, res) => {
  try {
    let url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (url === '/mode.json') { res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' }); res.end('{"mode":"server"}'); return; }
    if (url === '/') url = '/index.html';
    const [prefix, dir] = MOUNTS.find(([p]) => url.startsWith(p));
    const file = path.normalize(path.join(dir, url.slice(prefix.length)));
    if (!file.startsWith(dir)) throw new Error('outside root');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  }
});

// ---------- rooms ----------
const rooms = new Map();
const lanAddresses = () => Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => `http://${a.address}:${PORT}`);

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const name = (q.get('room') || 'main').slice(0, 24).replace(/[^\w-]/g, '') || 'main';
  let room = rooms.get(name);
  if (!room) rooms.set(name, room = new Room(name, track, () => lanAddresses().map(a => a + (name === 'main' ? '/' : '/?room=' + name))));
  const me = room.join(text => { if (ws.readyState === 1) ws.send(text); }, q.get('name') || '');
  if (!me) { ws.close(); return; }
  ws.on('message', data => room.message(me, String(data)));
  ws.on('close', () => { room.leave(me); if (room.empty) rooms.delete(name); });
  ws.on('error', () => {});
});

setInterval(() => { const now = performance.now(); for (const room of rooms.values()) room.step(now); }, 4);

server.listen(PORT, () => {
  console.log(`Saltline running. This computer: http://localhost:${PORT}`);
  for (const a of lanAddresses()) console.log(`Other players on your network: ${a}`);
});
