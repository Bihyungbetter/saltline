// Minimal MQTT 3.1.1 client over WebSocket (QoS 0 only): the fallback transport for players
// whose networks refuse direct browser-to-browser connections. Runs in browsers and in Node.
const enc = new TextEncoder(), dec = new TextDecoder();
const str = s => { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; };
function packet(type, body) {
  const head = [type]; let n = body.length;
  do { let d = n % 128; n = Math.floor(n / 128); head.push(n ? d | 128 : d); } while (n);
  const out = new Uint8Array(head.length + body.length); out.set(head); out.set(body, head.length); return out;
}

// will: { topic, message } published by the broker if this client vanishes without saying goodbye.
export function openRelay(url, { will = null, onMessage, onClose = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, ['mqtt']); ws.binaryType = 'arraybuffer';
    let buffer = new Uint8Array(0), open = false, ping = null, nextId = 1;
    const fail = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('relay timeout')); }, 8000);
    const api = {
      publish(topic, text) { if (ws.readyState === 1) ws.send(packet(0x30, [...str(topic), ...enc.encode(text)])); },
      subscribe(filter) { if (ws.readyState === 1) ws.send(packet(0x82, [nextId >> 8, nextId++ & 255, ...str(filter), 0])); },
      close() { clearInterval(ping); try { ws.send(packet(0xe0, [])); ws.close(); } catch { /* ignore */ } },
      get open() { return ws.readyState === 1 && open; },
    };
    ws.onopen = () => {
      const id = 'sl' + Math.random().toString(36).slice(2, 12);
      ws.send(packet(0x10, [...str('MQTT'), 4, will ? 0x06 : 0x02, 0, 30, ...str(id), ...(will ? [...str(will.topic), ...str(will.message)] : [])]));
    };
    ws.onmessage = e => {
      const chunk = new Uint8Array(e.data), joined = new Uint8Array(buffer.length + chunk.length); joined.set(buffer); joined.set(chunk, buffer.length); buffer = joined;
      for (;;) {                                        // a frame may hold several packets, or part of one
        if (buffer.length < 2) return;
        let len = 0, mult = 1, i = 1, more = true;
        while (more) { if (i >= buffer.length) return; len += (buffer[i] & 127) * mult; mult *= 128; more = (buffer[i++] & 128) !== 0; }
        if (buffer.length < i + len) return;
        const type = buffer[0] >> 4, body = buffer.subarray(i, i + len); buffer = buffer.slice(i + len);
        if (type === 2) {                                // CONNACK
          clearTimeout(fail);
          if (body[1] !== 0) { reject(new Error('relay refused the connection')); ws.close(); return; }
          open = true; ping = setInterval(() => { if (ws.readyState === 1) ws.send(packet(0xc0, [])); }, 20000); resolve(api);
        } else if (type === 3) {                         // PUBLISH (QoS 0)
          const tl = (body[0] << 8) | body[1];
          onMessage(dec.decode(body.subarray(2, 2 + tl)), dec.decode(body.subarray(2 + tl)));
        }
      }
    };
    ws.onerror = () => { clearTimeout(fail); if (!open) reject(new Error('relay unreachable')); };
    ws.onclose = () => { clearInterval(ping); if (open) { open = false; onClose(); } };
  });
}

// Public brokers measured with tools/relaycheck.mjs to keep up with race traffic (~120 ms per hop).
export const RELAYS = ['wss://test.mosquitto.org:8081/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
