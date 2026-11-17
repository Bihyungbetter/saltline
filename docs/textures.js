// Procedural texture helpers: seeded value noise and height-to-normal conversion.
import * as THREE from 'three';

// 3D value noise. Optional integer periods (px, py) make it tile in x / y.
export function makeNoise(seed) {
  const hash = (x, y, z) => {
    let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683) ^ seed;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const fade = t => t * t * (3 - 2 * t), mix = (a, b, t) => a + (b - a) * t, wrap = (v, p) => (p ? ((v % p) + p) % p : v);
  const noise = (x, y, z = 0, px = 0, py = 0) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
    const x0 = wrap(xi, px), x1 = wrap(xi + 1, px), y0 = wrap(yi, py), y1 = wrap(yi + 1, py);
    const plane = k => mix(mix(hash(x0, y0, k), hash(x1, y0, k), u), mix(hash(x0, y1, k), hash(x1, y1, k), u), v);
    return mix(plane(zi), plane(zi + 1), w);
  };
  noise.fbm = (x, y, z = 0, octaves = 4, px = 0, py = 0) => {
    let sum = 0, amp = 0.5, total = 0;
    for (let o = 0; o < octaves; o++) { sum += amp * noise(x, y, z + o * 7.3, px, py); total += amp; x *= 2; y *= 2; z *= 2; px *= 2; py *= 2; amp *= 0.5; }
    return sum / total;
  };
  return noise;
}

export function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

// Fill a canvas per pixel. fn(x, y) returns a grey value 0-255 or [r, g, b].
export function paintPixels(c, fn) {
  const g = c.getContext('2d'), img = g.createImageData(c.width, c.height), d = img.data;
  for (let y = 0, i = 0; y < c.height; y++) for (let x = 0; x < c.width; x++, i += 4) {
    const v = fn(x, y);
    if (typeof v === 'number') d[i] = d[i + 1] = d[i + 2] = v; else { d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2]; }
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Tangent-space normal map from a greyscale height canvas (wraps at the edges).
export function normalFromHeight(height, strength = 2) {
  const w = height.width, h = height.height, src = height.getContext('2d').getImageData(0, 0, w, h).data;
  const at = (x, y) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  const out = paintPixels(canvas(w, h), (x, y) => {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength, dy = (at(x, y + 1) - at(x, y - 1)) * strength, l = Math.hypot(dx, dy, 1);
    return [(-dx / l * 0.5 + 0.5) * 255, (dy / l * 0.5 + 0.5) * 255, (1 / l * 0.5 + 0.5) * 255];
  });
  return texture(out, false);
}

export function texture(c, colour = true, repeat = false) {
  const t = new THREE.CanvasTexture(c);
  if (colour) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
