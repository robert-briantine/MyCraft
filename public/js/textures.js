// Procedural pixel-art texture atlas.
// Every tile is painted deterministically from a seed so the world looks the
// same across reloads, and each tile is surrounded by a replicated border so
// mipmapped atlas sampling cannot bleed into the neighbouring tile.
import * as THREE from '../vendor/three/three.module.js';

const TILE = 16;
const PAD = 8;
const COLS = 8;
const CELL = TILE + PAD * 2;

// ==================== deterministic noise helpers ====================
function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x, y, seed, octaves = 3) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += vnoise(x * freq, y * freq, seed + i * 131) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const shade = (c, k) => [clamp8(c[0] * k), clamp8(c[1] * k), clamp8(c[2] * k)];

class TileBuf {
  constructor(seed) {
    this.data = new Uint8ClampedArray(TILE * TILE * 4);
    this.seed = seed | 0;
  }
  px(x, y, col, a = 255) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
    const i = (y * TILE + x) * 4;
    this.data[i] = clamp8(col[0]);
    this.data[i + 1] = clamp8(col[1]);
    this.data[i + 2] = clamp8(col[2]);
    this.data[i + 3] = a;
  }
  at(x, y) {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE) return [0, 0, 0, 0];
    const i = (y * TILE + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }
  fill(col, a = 255) {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) this.px(x, y, col, a);
  }
  rnd(x, y, stream = 0) {
    return hash2(x, y, this.seed + stream * 7717);
  }
  // Broad tonal variation driven by low frequency noise + per pixel jitter.
  tint(base, amp, freq, stream = 0) {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = (fbm(x * freq, y * freq, this.seed + stream, 3) - 0.5) * 2;
        const j = (this.rnd(x, y, stream + 5) - 0.5) * 0.4;
        const k = 1 + (n + j) * amp;
        this.px(x, y, shade(base, k));
      }
    }
  }
  speckle(count, col, stream = 0, size = 1) {
    for (let i = 0; i < count; i++) {
      const x = Math.floor(hash2(i, 7, this.seed + stream) * TILE);
      const y = Math.floor(hash2(i, 13, this.seed + stream + 1) * TILE);
      for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) this.px(x + dx, y + dy, col);
    }
  }
  blob(cx, cy, r, col, stream = 0) {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        const wob = (hash2(x, y, this.seed + stream) - 0.5) * 0.9;
        if ((x - cx) ** 2 + (y - cy) ** 2 <= (r + wob) ** 2) this.px(x, y, col);
      }
    }
  }
  crack(x, y, len, dx, dy, col) {
    for (let i = 0; i < len; i++) {
      this.px(x, y, col);
      x += dx + (hash2(x, y, this.seed + 3) < 0.5 ? 0 : 1);
      y += dy;
    }
  }
}

// ==================== tile painters ====================
const DIRT_BASE = rgb(0x79553a);
const STONE_BASE = rgb(0x8a8a8a);

function paintDirt(t) {
  t.tint(DIRT_BASE, 0.16, 0.22, 1);
  t.speckle(14, rgb(0x5f4028), 2, 2);
  t.speckle(12, rgb(0x8d6a49), 3, 1);
  t.speckle(8, rgb(0x4a3120), 4, 1);
}

function paintGrassTop(t) {
  t.tint(rgb(0x5d9c3f), 0.2, 0.25, 1);
  t.speckle(46, rgb(0x74b653), 2, 1);
  t.speckle(34, rgb(0x47762f), 3, 1);
  for (let i = 0; i < 14; i++) {
    const x = Math.floor(hash2(i, 3, t.seed) * TILE);
    const y = Math.floor(hash2(i, 5, t.seed) * TILE);
    t.px(x, y, rgb(0x8fce6a));
    t.px(x, y - 1, rgb(0x6aa84a));
  }
}

function paintGrassSide(t) {
  paintDirt(t);
  for (let x = 0; x < TILE; x++) {
    const depth = 3 + Math.round(fbm(x * 0.4, 0, t.seed, 2) * 3);
    for (let y = 0; y < depth; y++) {
      const n = fbm(x * 0.5, y * 0.5, t.seed + 9, 2);
      t.px(x, y, shade(rgb(0x5d9c3f), 0.86 + n * 0.3));
    }
    // ragged fringe where grass meets dirt
    t.px(x, depth, t.rnd(x, depth, 7) < 0.55 ? rgb(0x4c7f34) : rgb(0x3f6b2b));
    if (t.rnd(x, depth + 1, 8) < 0.35) t.px(x, depth + 1, rgb(0x43732d));
  }
}

function paintStone(t) {
  t.tint(STONE_BASE, 0.12, 0.2, 1);
  t.speckle(12, rgb(0xa2a2a2), 2, 1);
  t.speckle(10, rgb(0x6f6f6f), 3, 1);
  for (let i = 0; i < 4; i++) {
    const x = Math.floor(hash2(i, 21, t.seed) * (TILE - 6));
    const y = Math.floor(hash2(i, 29, t.seed) * (TILE - 5));
    t.crack(x, y, 4 + (i % 3), 1, i % 2 === 0 ? 0 : 1, rgb(0x5f5f5f));
  }
}

function paintCobble(t) {
  const seeds = [];
  for (let i = 0; i < 7; i++) {
    seeds.push([
      hash2(i, 1, t.seed) * TILE,
      hash2(i, 2, t.seed) * TILE,
      0.72 + hash2(i, 3, t.seed) * 0.55,
    ]);
  }
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      let best = 1e9, second = 1e9, bi = 0;
      for (let i = 0; i < seeds.length; i++) {
        // wrap distances so stones tile seamlessly across chunk borders
        const dx = Math.min(Math.abs(x - seeds[i][0]), TILE - Math.abs(x - seeds[i][0]));
        const dy = Math.min(Math.abs(y - seeds[i][1]), TILE - Math.abs(y - seeds[i][1]));
        const d = dx * dx + dy * dy;
        if (d < best) { second = best; best = d; bi = i; }
        else if (d < second) second = d;
      }
      const tone = STONE_BASE.map((c) => c * seeds[bi][2]);
      if (second - best < 2.2) t.px(x, y, rgb(0x4e4e4e));
      else if (best < 1.2) t.px(x, y, shade(tone, 1.18));
      else t.px(x, y, tone);
    }
  }
}

function paintSand(t) {
  t.tint(rgb(0xdccf9c), 0.09, 0.3, 1);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const ripple = Math.sin(y * 1.7 + fbm(x * 0.3, y * 0.3, t.seed, 2) * 4) * 0.05;
      t.px(x, y, shade(rgb(0xdccf9c), 1 + ripple + (t.rnd(x, y, 4) - 0.5) * 0.08));
    }
  }
  t.speckle(10, rgb(0xf0e6bc), 6, 1);
}

function paintGravel(t) {
  t.fill(rgb(0x4a4a4a));
  for (let i = 0; i < 30; i++) {
    const cx = hash2(i, 31, t.seed) * TILE;
    const cy = hash2(i, 37, t.seed) * TILE;
    const r = 0.8 + hash2(i, 41, t.seed) * 1.3;
    const pal = [0x8e8e8e, 0x6d6d6d, 0xa5a09a, 0x7b6a58, 0x595959];
    const col = rgb(pal[Math.floor(hash2(i, 43, t.seed) * pal.length)]);
    t.blob(cx, cy, r, shade(col, 0.8), i);
    t.blob(cx - 0.3, cy - 0.3, Math.max(0.4, r - 0.7), col, i + 1);
  }
}

function paintLogSide(t) {
  t.tint(rgb(0x6b4a2b), 0.1, 0.35, 1);
  for (let x = 0; x < TILE; x++) {
    const k = 0.82 + hash2(x, 0, t.seed) * 0.36;
    for (let y = 0; y < TILE; y++) {
      const n = fbm(x * 0.9, y * 0.12, t.seed + 4, 2);
      t.px(x, y, shade(rgb(0x6b4a2b), k * (0.85 + n * 0.3)));
    }
  }
  t.blob(4.5, 6, 2.2, rgb(0x4e331b), 8);
  t.blob(4.5, 6, 1.1, rgb(0x7d5730), 9);
  t.blob(11.5, 12, 1.8, rgb(0x4e331b), 10);
  for (let x = 0; x < TILE; x++) {
    t.px(x, 0, rgb(0x543821));
    t.px(x, TILE - 1, rgb(0x543821));
  }
}

function paintLogTop(t) {
  const cx = 7.5, cy = 7.5;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (d > 6.6) {
        t.px(x, y, shade(rgb(0x5c3f24), 0.9 + fbm(x * 0.8, y * 0.2, t.seed, 2) * 0.3));
      } else {
        const ring = Math.sin(d * 3.1) * 0.09;
        t.px(x, y, shade(rgb(0xb08a55), 1 + ring + (t.rnd(x, y, 3) - 0.5) * 0.07));
      }
    }
  }
  t.blob(cx, cy, 1.1, rgb(0x8a6a3d), 12);
}

function paintPlanks(t) {
  for (let board = 0; board < 4; board++) {
    const tone = 0.9 + hash2(board, 51, t.seed) * 0.22;
    for (let y = board * 4; y < board * 4 + 4; y++) {
      for (let x = 0; x < TILE; x++) {
        const grain = Math.sin(x * 1.3 + board * 2.1) * 0.045;
        t.px(x, y, shade(rgb(0xa08050), tone + grain + (t.rnd(x, y, board) - 0.5) * 0.07));
      }
    }
    for (let x = 0; x < TILE; x++) t.px(x, board * 4 + 3, rgb(0x4d3a22));
    const seam = Math.floor(hash2(board, 53, t.seed) * TILE);
    for (let y = board * 4; y < board * 4 + 3; y++) t.px(seam, y, rgb(0x5b4529));
    t.px(2 + board * 4, board * 4 + 1, rgb(0x6f6f6f));
  }
}

function paintBrick(t) {
  t.fill(rgb(0xb9b3a6));
  for (let row = 0; row < 4; row++) {
    const offset = row % 2 === 0 ? 0 : 4;
    for (let bx = -8; bx < TILE; bx += 8) {
      const x0 = bx + offset;
      const tone = 0.88 + hash2(row, x0 + 61, t.seed) * 0.26;
      for (let y = row * 4; y < row * 4 + 3; y++) {
        for (let x = x0; x < x0 + 7; x++) {
          if (x < 0 || x >= TILE) continue;
          t.px(x, y, shade(rgb(0x9c4030), tone + (t.rnd(x, y, row) - 0.5) * 0.12));
        }
      }
    }
  }
}

function orePainter(oreHex, hiHex) {
  return (t) => {
    paintStone(t);
    const ore = rgb(oreHex), hi = rgb(hiHex);
    for (let i = 0; i < 4; i++) {
      const cx = 2 + hash2(i, 71, t.seed) * (TILE - 4);
      const cy = 2 + hash2(i, 73, t.seed) * (TILE - 4);
      const r = 1.4 + hash2(i, 79, t.seed) * 1.1;
      t.blob(cx, cy, r, shade(ore, 0.72), i * 3);
      t.blob(cx - 0.25, cy - 0.25, r * 0.7, ore, i * 3 + 1);
      t.blob(cx - 0.5, cy - 0.6, r * 0.35, hi, i * 3 + 2);
    }
  };
}

function paintSnowTop(t) {
  t.tint(rgb(0xf2f6fa), 0.05, 0.28, 1);
  t.speckle(16, rgb(0xd9e6f2), 2, 1);
  t.speckle(10, rgb(0xffffff), 3, 1);
}

function paintSnowSide(t) {
  paintDirt(t);
  for (let x = 0; x < TILE; x++) {
    const depth = 4 + Math.round(fbm(x * 0.45, 3, t.seed, 2) * 2);
    for (let y = 0; y < depth; y++) {
      t.px(x, y, shade(rgb(0xf2f6fa), 0.94 + fbm(x * 0.5, y * 0.5, t.seed + 2, 2) * 0.1));
    }
    t.px(x, depth, rgb(0xc9d8e6));
  }
}

function paintMoss(t) {
  t.tint(rgb(0x3f6b32), 0.22, 0.3, 1);
  t.speckle(26, rgb(0x5d8f45), 2, 1);
  t.speckle(18, rgb(0x2b4a22), 3, 1);
  for (let i = 0; i < 10; i++) {
    const x = Math.floor(hash2(i, 91, t.seed) * TILE);
    const y = Math.floor(hash2(i, 93, t.seed) * TILE);
    t.px(x, y, rgb(0x74a95a));
    t.px(x, y - 1, rgb(0x65964d));
  }
}

function paintGlass(t) {
  t.fill([0, 0, 0], 0);
  const frame = rgb(0xd6ecff);
  for (let i = 0; i < TILE; i++) {
    t.px(i, 0, frame, 210); t.px(i, TILE - 1, frame, 210);
    t.px(0, i, frame, 210); t.px(TILE - 1, i, frame, 210);
  }
  for (let i = 3; i < 12; i++) t.px(i, 14 - i, [255, 255, 255], 130);
  for (let i = 4; i < 10; i++) t.px(i + 1, 15 - i, [255, 255, 255], 70);
  for (let i = 1; i < 4; i++) {
    t.px(i, 1, [255, 255, 255], 160);
    t.px(1, i, [255, 255, 255], 160);
  }
}

function paintLeaves(t) {
  t.tint(rgb(0x3f7a2e), 0.26, 0.32, 1);
  for (let i = 0; i < 22; i++) {
    const cx = hash2(i, 101, t.seed) * TILE;
    const cy = hash2(i, 103, t.seed) * TILE;
    t.blob(cx, cy, 1.3 + hash2(i, 107, t.seed), rgb(0x2c5620), i);
  }
  t.speckle(30, rgb(0x5c9c3f), 6, 1);
  t.speckle(12, rgb(0x79bd57), 7, 1);
  // clumped holes so the canopy reads as see-through foliage
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      if (fbm(x * 0.55, y * 0.55, t.seed + 55, 2) > 0.66) t.px(x, y, [0, 0, 0], 0);
    }
  }
}

function paintWater(t) {
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const band = Math.sin(y * 1.5 + fbm(x * 0.35, y * 0.5, t.seed, 3) * 5);
      const c = mix(rgb(0x2f66ad), rgb(0x5f9ad8), 0.35 + band * 0.3);
      t.px(x, y, c, 190);
    }
  }
  t.speckle(9, rgb(0xbcdcf5), 8, 1);
}

function paintLava(t) {
  t.tint(rgb(0xd8480f), 0.28, 0.26, 1);
  for (let i = 0; i < 9; i++) {
    const cx = hash2(i, 111, t.seed) * TILE;
    const cy = hash2(i, 113, t.seed) * TILE;
    t.blob(cx, cy, 1.6 + hash2(i, 117, t.seed) * 1.4, rgb(0x7a2408), i);
  }
  for (let i = 0; i < 12; i++) {
    const cx = hash2(i, 121, t.seed) * TILE;
    const cy = hash2(i, 127, t.seed) * TILE;
    t.blob(cx, cy, 0.9, rgb(0xffc23a), i + 40);
  }
  t.speckle(10, rgb(0xffe98a), 9, 1);
}

function paintObsidian(t) {
  t.tint(rgb(0x1a1730), 0.3, 0.24, 1);
  for (let i = 0; i < 5; i++) {
    const x = Math.floor(hash2(i, 131, t.seed) * TILE);
    const y = Math.floor(hash2(i, 137, t.seed) * TILE);
    t.crack(x, y, 5 + (i % 3), 1, i % 2 === 0 ? 1 : 0, rgb(0x5b3f8f));
  }
  t.speckle(9, rgb(0x8a6fd0), 6, 1);
}

const PAINTERS = {
  dirt: paintDirt,
  grass_top: paintGrassTop,
  grass_side: paintGrassSide,
  stone: paintStone,
  cobble: paintCobble,
  sand: paintSand,
  gravel: paintGravel,
  log_side: paintLogSide,
  log_top: paintLogTop,
  planks: paintPlanks,
  brick: paintBrick,
  coal_ore: orePainter(0x2b2b2b, 0x585858),
  iron_ore: orePainter(0xc8a074, 0xe6cba6),
  gold_ore: orePainter(0xe0b52e, 0xf8e386),
  diamond_ore: orePainter(0x4fdede, 0xa8ffff),
  snow_top: paintSnowTop,
  snow_side: paintSnowSide,
  moss: paintMoss,
  glass: paintGlass,
  leaves: paintLeaves,
  water: paintWater,
  lava: paintLava,
  obsidian: paintObsidian,
};

// ==================== atlas ====================
export function createTextureAtlas() {
  const names = Object.keys(PAINTERS);
  const index = new Map(names.map((n, i) => [n, i]));
  const rows = Math.max(1, Math.ceil(names.length / COLS));
  const width = COLS * CELL;
  const height = rows * CELL;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const scratch = document.createElement('canvas');
  scratch.width = TILE;
  scratch.height = TILE;
  const sctx = scratch.getContext('2d');

  function cellOrigin(i) {
    return [(i % COLS) * CELL + PAD, Math.floor(i / COLS) * CELL + PAD];
  }

  // Replicate the tile border into the padding so mip levels cannot pull in
  // colours from the adjacent tile.
  function bleed(dx, dy) {
    const s = (sx, sy, sw, sh, dxp, dyp, dw, dh) => ctx.drawImage(scratch, sx, sy, sw, sh, dxp, dyp, dw, dh);
    s(0, 0, 1, TILE, dx - PAD, dy, PAD, TILE);
    s(TILE - 1, 0, 1, TILE, dx + TILE, dy, PAD, TILE);
    s(0, 0, TILE, 1, dx, dy - PAD, TILE, PAD);
    s(0, TILE - 1, TILE, 1, dx, dy + TILE, TILE, PAD);
    s(0, 0, 1, 1, dx - PAD, dy - PAD, PAD, PAD);
    s(TILE - 1, 0, 1, 1, dx + TILE, dy - PAD, PAD, PAD);
    s(0, TILE - 1, 1, 1, dx - PAD, dy + TILE, PAD, PAD);
    s(TILE - 1, TILE - 1, 1, 1, dx + TILE, dy + TILE, PAD, PAD);
  }

  function blit(i, imageData) {
    const [dx, dy] = cellOrigin(i);
    ctx.clearRect(dx - PAD, dy - PAD, CELL, CELL);
    sctx.putImageData(imageData, 0, 0);
    ctx.drawImage(scratch, dx, dy);
    bleed(dx, dy);
  }

  function paintTile(name) {
    const buf = new TileBuf(hash2(index.get(name) + 1, 17, 0x9e3779b1) * 0xffffffff);
    PAINTERS[name](buf);
    return new ImageData(buf.data, TILE, TILE);
  }

  for (const name of names) blit(index.get(name), paintTile(name));

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapNearestFilter;
  texture.generateMipmaps = true;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  // Half-texel inset keeps nearest sampling inside the tile body.
  const inset = 0.5 / TILE;
  function uvRect(name) {
    const i = typeof name === 'number' ? name : index.get(name);
    if (i === undefined) throw new Error(`unknown tile: ${name}`);
    const [x0, y0] = cellOrigin(i);
    const u0 = (x0 + inset) / width;
    const u1 = (x0 + TILE - inset) / width;
    // canvas y grows downwards, uv v grows upwards (texture.flipY is true)
    const v1 = 1 - (y0 + inset) / height;
    const v0 = 1 - (y0 + TILE - inset) / height;
    return { u0, u1, v0, v1 };
  }

  return {
    texture,
    canvas,
    tileNames: names,
    has: (name) => index.has(name),
    uvRect,
    // Standalone 16x16 canvas for HUD icons (hotbar previews).
    tileCanvas(name) {
      const c = document.createElement('canvas');
      c.width = TILE;
      c.height = TILE;
      const i = index.get(name);
      if (i === undefined) return c;
      const [sx, sy] = cellOrigin(i);
      c.getContext('2d').drawImage(canvas, sx, sy, TILE, TILE, 0, 0, TILE, TILE);
      return c;
    },
    // Replaces a tile with a user supplied image (custom texture upload).
    overrideTile(name, source) {
      const i = index.get(name);
      if (i === undefined) return false;
      const [dx, dy] = cellOrigin(i);
      ctx.clearRect(dx - PAD, dy - PAD, CELL, CELL);
      sctx.clearRect(0, 0, TILE, TILE);
      sctx.drawImage(source, 0, 0, TILE, TILE);
      ctx.drawImage(scratch, dx, dy);
      bleed(dx, dy);
      texture.needsUpdate = true;
      return true;
    },
    restoreTile(name) {
      const i = index.get(name);
      if (i === undefined || !PAINTERS[name]) return false;
      blit(i, paintTile(name));
      texture.needsUpdate = true;
      return true;
    },
  };
}
