// One race room: lobby, sled picks, launch, the 120 Hz race loop and snapshot broadcast.
// Transport-agnostic: every player is given a send(text) function, so the same class runs
// inside the Node server (WebSockets) and inside the host player's browser (peer-to-peer).
import { Race, TICK } from './sim.mjs';

const COUNTDOWN_MS = 3600, SEND_EVERY = 2; // 120 Hz simulation, 60 Hz snapshots
let nextId = 1;

export class Room {
  // share: () => array of links other players can open to join this room
  constructor(name, track, share = () => []) {
    this.name = name; this.track = track; this.share = share;
    this.players = []; this.phase = 'lobby'; this.race = null; this.drivers = {}; this.acc = 0; this.sent = 0; this.last = 0;
  }

  get empty() { return this.players.length === 0; }
  send(p, msg) { try { p.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch { /* a closing connection */ } }
  all(msg) { const text = typeof msg === 'string' ? msg : JSON.stringify(msg); for (const p of this.players) this.send(p, text); }

  lobby() {
    const share = this.share();
    for (const p of this.players) {
      this.send(p, {
        t: 'lobby', you: p.id, room: this.name, phase: this.phase, share,
        players: this.players.map(q => ({ id: q.id, name: q.name, car: q.car, racing: this.driverOf(q) !== undefined })),
      });
    }
  }

  driverOf(p) { return Object.keys(this.drivers).find(car => this.drivers[car] === p); }
  freeCar() { for (let c = 0; c < 4; c++) if (!this.players.some(p => p.car === c)) return c; return -1; }

  // Returns the new player, or null if the room is full. slow = a relayed connection that gets half-rate snapshots.
  join(send, name, slow = false) {
    const car = this.freeCar();
    if (car < 0) { try { send(JSON.stringify({ t: 'full' })); } catch { /* ignore */ } return null; }
    const p = { send, slow, id: nextId++, name: String(name || '').slice(0, 16), car, input: { steer: 0, gas: 0, brake: 0, boost: false } };
    if (!p.name) p.name = 'Pilot ' + p.id;
    this.players.push(p); this.lobby();
    return p;
  }

  leave(p) {
    this.players = this.players.filter(q => q !== p);
    const car = this.driverOf(p);
    if (car !== undefined) delete this.drivers[car]; // the computer takes over mid-race
    if (this.players.length) this.lobby();
  }

  message(p, text) {
    let m; try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'in') {
      const num = (v, a, b) => (Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : 0);
      p.input.steer = num(m.s, -1, 1); p.input.gas = num(m.g, 0, 1); p.input.brake = num(m.b, 0, 1);
      if (m.x) p.input.boost = true;
    } else if (m.t === 'pick') {
      if (Number.isInteger(m.car) && m.car >= 0 && m.car <= 3 && this.players.every(q => q === p || q.car !== m.car)) p.car = m.car;
      this.lobby();
    } else if (m.t === 'name') { p.name = String(m.name || '').slice(0, 16) || p.name; this.lobby(); }
    else if (m.t === 'launch') this.launch(p, m.laps);
  }

  launch(p, laps) {
    const humansRacing = Object.keys(this.drivers).some(car => !this.race.cars[car].done);
    if (this.phase === 'countdown' || (this.phase === 'racing' && humansRacing)) { this.send(p, { t: 'note', text: 'A race is in progress. You will join the next one.' }); return; }
    laps = [1, 3, 5].includes(laps) ? laps : 3;
    this.drivers = {};
    for (const q of this.players) { this.drivers[q.car] = q; q.input = { steer: 0, gas: 0, brake: 0, boost: false }; }
    // Computer drivers take the front of the grid, humans the back.
    const humans = Object.keys(this.drivers).map(Number), bots = [0, 1, 2, 3].filter(c => !humans.includes(c));
    const race = this.race = new Race(this.track, laps, [...bots, ...humans]);
    this.phase = 'countdown'; this.acc = 0; this.sent = 0;
    const names = {}; for (const car of humans) names[car] = this.drivers[car].name;
    for (const q of this.players) this.send(q, { t: 'start', car: q.car, laps, countdown: COUNTDOWN_MS, names, frame: race.snapshot() });
    this.lobby();
    setTimeout(() => { if (this.race === race && this.phase === 'countdown') { this.phase = 'racing'; this.last = 0; } }, COUNTDOWN_MS);
  }

  // Call often (every few milliseconds) with a monotonic clock in milliseconds.
  step(now) {
    if (this.phase !== 'racing') return;
    if (!this.last) { this.last = now; return; }
    this.acc += Math.min(0.25, (now - this.last) / 1000) / TICK; this.last = now;
    let n = Math.floor(this.acc); if (!n) return; this.acc -= n;
    const inputs = {};
    for (const car in this.drivers) inputs[car] = this.drivers[car].input;
    while (n--) {
      this.race.tick(inputs);
      for (const car in this.drivers) this.drivers[car].input.boost = false; // boost is a one-tick edge
      if (++this.sent % SEND_EVERY === 0) {
        const snap = this.race.snapshot();
        for (const p of this.players) if (!p.slow || this.sent % (SEND_EVERY * 2) === 0) this.send(p, snap);
      }
    }
    if (this.race.allDone) { this.all(this.race.snapshot()); this.phase = 'lobby'; this.drivers = {}; this.lobby(); }
  }
}
