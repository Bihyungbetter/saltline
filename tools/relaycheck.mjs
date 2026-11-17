// Measures each public relay: can we connect, how long does a message take to come back,
// and does it keep up with race traffic (60 snapshot-sized messages a second)?
import { openRelay, RELAYS } from '../client/relay.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const topic = 'saltline/check/' + Math.random().toString(36).slice(2, 10), payload = 'x'.repeat(300);

for (const url of RELAYS) {
  try {
    const delays = []; let got = 0;
    const rx = await openRelay(url, { onMessage: (t, text) => { got++; delays.push(performance.now() - Number(text.slice(0, text.indexOf('|')))); } });
    const tx = await openRelay(url, { onMessage: () => {} });
    rx.subscribe(topic); await sleep(800);
    const N = 300;                                   // five seconds at 60 Hz
    for (let i = 0; i < N; i++) { tx.publish(topic, performance.now() + '|' + payload); await sleep(1000 / 60); }
    await sleep(1500);
    delays.sort((a, b) => a - b);
    const pick = q => delays.length ? delays[Math.min(delays.length - 1, Math.floor(delays.length * q))].toFixed(0) : '-';
    console.log(`${url}\n  delivered ${got}/${N}, delay median ${pick(0.5)} ms, 95th percentile ${pick(0.95)} ms, worst ${pick(1)} ms`);
    rx.close(); tx.close();
  } catch (e) { console.log(`${url}\n  FAILED: ${e.message}`); }
}
process.exit(0);
