// Small synthesised soundscape: engine drone, boost hiss, countdown beeps. No sample files.
export class Sound {
  constructor() { this.ctx = null; this.muted = false; }
  wake() {
    if (this.ctx) { this.ctx.resume(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
    const c = this.ctx = new Ctx();
    this.master = c.createGain(); this.master.gain.value = 0.5; this.master.connect(c.destination);
    this.filter = c.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.frequency.value = 400;
    this.engine = c.createGain(); this.engine.gain.value = 0; this.filter.connect(this.engine).connect(this.master);
    this.osc = [0, 7].map(detune => { const o = c.createOscillator(); o.type = 'sawtooth'; o.detune.value = detune * 5; o.connect(this.filter); o.start(); return o; });
    const buffer = c.createBuffer(1, c.sampleRate, c.sampleRate), data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = c.createBufferSource(); noise.buffer = buffer; noise.loop = true;
    const band = c.createBiquadFilter(); band.type = 'bandpass'; band.frequency.value = 1800; band.Q.value = 0.6;
    this.hiss = c.createGain(); this.hiss.gain.value = 0; noise.connect(band).connect(this.hiss).connect(this.master); noise.start();
  }
  mute() { this.muted = !this.muted; if (this.master) this.master.gain.value = this.muted ? 0 : 0.5; }
  drive(speed, hot, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, f = 48 + speed * 1.25;
    this.osc[0].frequency.setTargetAtTime(f, t, 0.05); this.osc[1].frequency.setTargetAtTime(f * 1.5, t, 0.05);
    this.filter.frequency.setTargetAtTime(300 + speed * 14, t, 0.08);
    this.engine.gain.setTargetAtTime(active ? 0.10 + Math.min(0.1, speed / 900) : 0, t, 0.12);
    this.hiss.gain.setTargetAtTime(active ? hot * 0.22 + Math.min(0.06, speed / 2400) : 0, t, 0.1);
  }
  beep(freq, length = 0.16) {
    if (!this.ctx) return;
    const c = this.ctx, o = c.createOscillator(), g = c.createGain(), t = c.currentTime;
    o.type = 'square'; o.frequency.value = freq; g.gain.setValueAtTime(0.16, t); g.gain.exponentialRampToValueAtTime(0.001, t + length);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + length);
  }
}
