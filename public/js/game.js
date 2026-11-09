import * as THREE from '../vendor/three/three.module.js';
import { PointerLockControls } from '../vendor/three/examples/jsm/controls/PointerLockControls.js';
import { createTextureAtlas } from './textures.js';
import { createSaveStore, encodeSave, decodeSave, setNameInSave, slugify, cleanWorldName, AUTOSAVE_INTERVAL_MS } from './saves.js';
import { createVillageGen } from './village.js';
import { createBiomeGen } from './biomes.js';
import { SimplexNoise } from './noise.js';
import { createTerrain } from './terrain.js';

// ===================== CONSTANTS =====================
const CHUNK_SIZE = 16;
const CHUNK_HEIGHT = 64;
const GRAVITY = 30;
const JUMP_SPEED = 10;
const MOVE_SPEED = 8;
const FLY_SPEED = 20;
const FLY = false;

// Player collider: axis aligned box, camera sits at eye level.
const PLAYER_HALF_WIDTH = 0.3;
const PLAYER_HEIGHT = 1.8;
const EYE_HEIGHT = 1.62;
const STEP_HEIGHT = 1.0;      // auto climb for single blocks
const MAX_SUBSTEP = 0.2;      // swept movement granularity, keeps fast falls from tunnelling
const COLLIDE_EPS = 1e-3;
const GROUND_PROBE = 0.06;    // how far below the feet we look for ground
const TERMINAL_VELOCITY = 60;
const KILL_Y = -24;           // below this the player fell out of the world

// ---- nage -------------------------------------------------------------------
// Entrer dans l'eau change de contrôleur, pas seulement de gravité. Trois choses le
// définissent et aucune ne se déduit du code de la marche :
//  - le corps est **rappelé à la ligne de flottaison** et s'y tient, la tête hors de
//    l'eau : sans ce rappel, un nageur coule doucement au fond et n'en revient qu'au
//    prix d'un Espace maintenu ;
//  - l'élan **se dissipe** au lieu de s'interrompre net comme contre un mur ;
//  - Espace et Majuscule ne sautent plus : ils montent et coulent, et sortir de l'eau
//    se hisse jusqu'à deux cubes de berge (`SWIM_STEP`), là où la marche n'en franchit
//    qu'un.
const SWIM_SPEED = 4.4;       // déplacement horizontal dans l'eau (~0,55 × la marche)
const SWIM_UP = 4.6;          // vitesse de remontée sur Espace
const SWIM_DOWN = 3.6;        // vitesse de plongée sur Majuscule
// Flottaison : un ressort amorti tient le corps à la ligne, et plus bas l'eau ne vous
// éjecte plus. L'ancien rappel tout-ou-rien (24 vers le haut sous la ligne, 8 vers le
// bas au-dessus, avec une bande morte de 0,05 cube) orbite autour de l'équilibre sans
// jamais s'y poser : mesuré le 2026-11-08, ±0,016 cube à ~12 Hz au repos — le « petit
// tremblement » vu en surface — et 4,6 cubes/s de remontée dès qu'on lâche Majuscule,
// ce qui empêchait de rester au fond. La vitesse n'est plus intégrée à coups d'accélération :
// elle **rejoint** une vitesse visée, d'où l'absence de rebond.
const FLOT_BAND = 2.5;        // cubes sous la ligne où le corps est encore tenu par le ressort
const FLOT_GAIN = 7;          // raideur du ressort de surface : vitesse visée = écart × gain
const FLOT_RAISE = 3.4;       // plafond de la remontée dans le bandeau
const FLOT_DRIFT = 1.4;       // loin de la ligne, on remonte doucement au lieu de fuser
const VERT_RESPONSE = 10;     // réponse verticale vers la vitesse visée (1/s)
const WATER_DRAG_XZ = 4;      // amortissement horizontal
const FLOAT_SUBMERGED = 1.0;  // cubes du corps sous l'eau au repos (sur PLAYER_HEIGHT)
const SWIM_STEP = 2;          // hauteur de berge qu'un nageur peut escalader
const SWIM_REACH = 0.35;      // le coup de palme qui hisse au-dessus d'un ressaut juste trop haut
// La lave est `liquid` comme l'eau — c'est ce qui la rend translucide et non solide —
// mais elle ne se nage pas : on s'y enfonce à vitesse bornée, sans chute libre.
const LAVE_CHUTE = -2.5;      // plafond de descente dans la lave
// Assiette de flottaison, réglable au clavier (+ et -) : cubes du corps sous l'eau au
// repos. Le minimum laisse la tête largement hors de l'eau, le maximum plonge jusqu'à
// avoir les cheveux dessous sans aller jusqu'au fond.
const ASSIETTE_MIN = 0.6;
const ASSIETTE_MAX = PLAYER_HEIGHT + 0.6;
const ASSIETTE_PAS = 0.2;

// ---- configurable view depth (start-screen settings) ----
const SETTINGS_STORAGE_KEY = 'mincraft_settings';
const MIN_RENDER_DISTANCE = 2;
const MAX_RENDER_DISTANCE = 32;
const DEFAULT_RENDER_DISTANCE = 4;
const CHUNK_STREAM_BUDGET = 16;   // cells generated synchronously when the slider moves
const WORLD_BOOT_BUDGET = 169;    // 13×13 cells built synchronously under the player
const CHUNK_FRAME_MS = 10;        // wall-clock ceiling for world building per frame
const CHUNK_MESH_WATERMARK = 64;  // stop generating when this many chunks await meshing

// ---- world persistence ----
// The whole terrain is a pure function of these seeds, so the disk only ever has
// to carry the player's diff. Recording them in the save file is what makes a
// future seed change detectable instead of silently mangling saved worlds.
const WORLD_SEEDS = { terrain: 42, trees: 123, buildings: 777, caves: 999 };
const WORLD_LOAD_TIMEOUT_MS = 5000;   // never hold the start screen hostage to a dead store
const PLAYER_SAVE_MOVE_SQ = 0.25 * 0.25; // how far the player must travel to warrant a write

// Two hosts share the game: the Express dev server and the Tauri desktop build,
// which has no server and keeps everything in its own application-data folder.
const tauriGlobal = window.__TAURI__;
const tauriCore = tauriGlobal ? tauriGlobal.core : null;

function clampRenderDistance(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return DEFAULT_RENDER_DISTANCE;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_RENDER_DISTANCE;
  return Math.min(MAX_RENDER_DISTANCE, Math.max(MIN_RENDER_DISTANCE, Math.round(n)));
}

function loadSettings() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || 'null'); } catch (e) { raw = null; }
  const stored = raw && typeof raw === 'object' ? raw.renderDistance : undefined;
  return { renderDistance: clampRenderDistance(stored) };
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ renderDistance: settings.renderDistance }));
  } catch (e) {
    /* private mode: the setting simply does not survive */
  }
}

const settings = loadSettings();

// Block type IDs
const BLOCK = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, WOOD: 4,
  LEAVES: 5, SAND: 6, WATER: 7, PLANKS: 8, BRICK: 9,
  COAL: 10, IRON: 11, GOLD: 12, DIAMOND: 13,
  SNOW: 14, GRIT: 15, COBBLE: 16, GLASS: 17,
  MOSS: 18, LAVA: 19, OBSIDIAN: 20
};

// Block metadata.
//   solid   -> stops the player (glass and leaves do, water and lava do not)
//   opaque  -> hides neighbour faces and casts ambient occlusion
//   pass    -> 'opaque' | 'translucent' | 'cutout' (alpha tested foliage)
//   tiles   -> atlas tile names per face family
const T = (side, top = side, bottom = side) => ({ side, top, bottom });

const BLOCK_INFO = {
  [BLOCK.GRASS]:     { name: 'Herbe',      colors: [0x4a8f3c, 0x8b6f47, 0x4a8f3c], solid: true,  opaque: true,  tiles: T('grass_side', 'grass_top', 'dirt') },
  [BLOCK.DIRT]:      { name: 'Terre',      colors: [0x8b6f47], solid: true,  opaque: true,  tiles: T('dirt') },
  [BLOCK.STONE]:     { name: 'Pierre',     colors: [0x888888], solid: true,  opaque: true,  tiles: T('stone') },
  [BLOCK.WOOD]:      { name: 'Bois',       colors: [0x6b4423], solid: true,  opaque: true,  tiles: T('log_side', 'log_top', 'log_top') },
  [BLOCK.LEAVES]:    { name: 'Feuilles',   colors: [0x2d5a27], solid: true,  opaque: false, pass: 'cutout', tiles: T('leaves') },
  [BLOCK.SAND]:      { name: 'Sable',      colors: [0xd4c48a], solid: true,  opaque: true,  tiles: T('sand') },
  [BLOCK.WATER]:     { name: 'Eau',        colors: [0x3a6fbf], solid: false, opaque: false, pass: 'translucent', liquid: true, tiles: T('water') },
  [BLOCK.PLANKS]:    { name: 'Planches',   colors: [0xa08050], solid: true,  opaque: true,  tiles: T('planks') },
  [BLOCK.BRICK]:     { name: 'Briques',    colors: [0x8b3a2f], solid: true,  opaque: true,  tiles: T('brick') },
  [BLOCK.COAL]:      { name: 'Charbon',    colors: [0x333333], solid: true,  opaque: true,  tiles: T('coal_ore') },
  [BLOCK.IRON]:      { name: 'Fer',        colors: [0xb8a080], solid: true,  opaque: true,  tiles: T('iron_ore') },
  [BLOCK.GOLD]:      { name: 'Or',         colors: [0xd4af37], solid: true,  opaque: true,  tiles: T('gold_ore') },
  [BLOCK.DIAMOND]:   { name: 'Diamant',    colors: [0x5ce8e8], solid: true,  opaque: true,  tiles: T('diamond_ore') },
  [BLOCK.SNOW]:      { name: 'Neige',      colors: [0xf0f0f0], solid: true,  opaque: true,  tiles: T('snow_side', 'snow_top', 'dirt') },
  [BLOCK.GRIT]:      { name: 'Gravier',    colors: [0x6b6b6b], solid: true,  opaque: true,  tiles: T('gravel') },
  [BLOCK.COBBLE]:    { name: 'Rocher',     colors: [0x707070], solid: true,  opaque: true,  tiles: T('cobble') },
  [BLOCK.GLASS]:     { name: 'Verre',      colors: [0xaaddff], solid: true,  opaque: false, pass: 'translucent', tiles: T('glass') },
  [BLOCK.MOSS]:      { name: 'Mousse',     colors: [0x3a6b35], solid: true,  opaque: true,  tiles: T('moss') },
  [BLOCK.LAVA]:      { name: 'Lave',       colors: [0xff4500], solid: false, opaque: false, pass: 'translucent', liquid: true, tiles: T('lava') },
  [BLOCK.OBSIDIAN]:  { name: 'Obsidienne', colors: [0x1a1a2e], solid: true,  opaque: true,  tiles: T('obsidian') },
};

for (const info of Object.values(BLOCK_INFO)) {
  if (!info.pass) info.pass = 'opaque';
}

// Hotbar contents are player-editable through the inventory and persisted.
const HOTBAR_SIZE = 9;
const HOTBAR_STORAGE_KEY = 'mincraft_hotbar';
const DEFAULT_HOTBAR = [BLOCK.GRASS, BLOCK.DIRT, BLOCK.STONE, BLOCK.WOOD, BLOCK.PLANKS, BLOCK.BRICK, BLOCK.SAND, BLOCK.GLASS, BLOCK.DIAMOND];

// Every block type, grouped for the palette header rows.
const BLOCK_GROUPS = [
  { label: 'NATUREL', ids: [BLOCK.GRASS, BLOCK.DIRT, BLOCK.STONE, BLOCK.COBBLE, BLOCK.SAND, BLOCK.GRIT, BLOCK.SNOW, BLOCK.MOSS] },
  { label: 'CONSTRUCTION', ids: [BLOCK.WOOD, BLOCK.PLANKS, BLOCK.BRICK, BLOCK.GLASS, BLOCK.OBSIDIAN] },
  { label: 'VÉGÉTAUX', ids: [BLOCK.LEAVES] },
  { label: 'MINERAIS', ids: [BLOCK.COAL, BLOCK.IRON, BLOCK.GOLD, BLOCK.DIAMOND] },
  { label: 'LIQUIDES', ids: [BLOCK.WATER, BLOCK.LAVA] },
];
const ALL_BLOCKS = Object.keys(BLOCK_INFO).map(Number);

function loadHotbar() {
  try {
    const raw = localStorage.getItem(HOTBAR_STORAGE_KEY);
    if (!raw) return DEFAULT_HOTBAR.slice();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== HOTBAR_SIZE) return DEFAULT_HOTBAR.slice();
    return parsed.map((id) => (BLOCK_INFO[id] ? id : BLOCK.DIRT));
  } catch (e) {
    return DEFAULT_HOTBAR.slice();
  }
}

// ==================== NOISE ====================
// Le bruit simplex est dans `noise.js` : c'est la seule copie du projet depuis que
// celle-ci a cessé d'être dupliquée ici et dans un module mort.
const worldNoise = new SimplexNoise(WORLD_SEEDS.terrain);
const caveNoise = new SimplexNoise(WORLD_SEEDS.caves);

// ==================== TERRAIN GENERATION ====================
// Le profil du monde — plateaux, sillons plissés, massifs soulevés jusqu'à la neige —
// vit dans `terrain.js`, sans dépendance : les suites Node jugent ainsi exactement le
// relief que le navigateur dessine, et non une copie qui aurait dérivé.
const terrain = createTerrain({ noise: worldNoise, chunkHeight: CHUNK_HEIGHT });

// La ligne de flottaison vient du relief : c'est lui qui décide où la terre s'arrête,
// le village et les biomes consultent la même valeur.
const SEA_LEVEL = terrain.RELIEF.seaLevel;

function getTerrainHeight(x, z) {
  return terrain.heightAt(x, z);
}

function isCave(x, y, z) {
  if (y < 4 || y > CHUNK_HEIGHT - 4) return false;
  const n = caveNoise.octave(x * 0.04, z * 0.04, 3, 0.5);
  return n > 0.35 && y < getTerrainHeight(x, z);
}

/**
 * Le monde a des océans : poser le joueur au fond d'une baie le ferait nageur avant
 * même d'avoir lu l'écran d'accueil. L'apparition cherche donc un repli au sec en
 * anneaux croissants autour du point historique — et assez large pour ne pas être un
 * îlot d'un cube où l'on retombe à l'eau dès qu'on tourne.
 *
 * Les colonnes sont jugées à leurs coordonnées **entières**, comme la génération des
 * tronçons : `heightAt` évalue le bruit de détail à la position exacte, donc sonder
 * (x + 0,5, z + 0,5) répond une valeur qui peut différer de deux cubes de celle du
 * cube réellement posé — et promettre du sec au-dessus d'une colonne noyée.
 */
function findDrySpawn(originX = 8, originZ = 8) {
  const sec = (x, z) => {
    // Le plan d'eau, pas seulement la ligne de flottaison : une rivière court au-dessus
    // de la mer, et y naître serait nageur avant d'avoir lu l'écran d'accueil.
    if (getTerrainHeight(x, z) < terrain.waterTopAt(x, z) + 1) return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (getTerrainHeight(x + dx, z + dz) < terrain.waterTopAt(x + dx, z + dz) + 1) return false;
    }
    return true;
  };
  if (sec(originX, originZ)) return [originX + 0.5, originZ + 0.5];
  for (let r = 1; r <= 64; r++) {
    for (let d = -r; d <= r; d++) {
      for (const [x, z] of [[originX + d, originZ - r], [originX + d, originZ + r],
        [originX - r, originZ + d], [originX + r, originZ + d]]) {
        if (sec(x, z)) return [x + 0.5, z + 0.5];
      }
    }
  }
  return [originX + 0.5, originZ + 0.5];
}
const SPAWN_XZ = findDrySpawn();

// Every random draw in the generator is a hash of the coordinates, never
// Math.random(): the save file only stores what the player changed, so a chunk
// regenerated on the next launch has to come out cube for cube identical to the
// first one — ores, roads and buildings included. `salt` keeps each family of
// draws (four ore types, lot layout, materials) statistically independent.
function hashRoll(x, y, z, salt) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)
        ^ Math.imul(z | 0, 1274126177) ^ Math.imul(salt | 0, 2654435761);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// Roads, houses and apartment blocks live in their own module so they can be
// reasoned about — and unit tested under Node — apart from the renderer. The
// village seed is folded into the hash salts, which is why it is recorded in the
// save file: changing it must not silently reshape saved worlds.
const village = createVillageGen({
  BLOCK,
  CHUNK_SIZE,
  CHUNK_HEIGHT,
  heightAt: getTerrainHeight,
  roll: hashRoll,
  saltBase: (WORLD_SEEDS.buildings * 7919) | 0,
  seaLevel: SEA_LEVEL,
  // Rivières : la voirie et le bâti se jugent contre le plan d'eau local de chaque
  // colonne, pas contre la seule ligne de flottaison.
  waterTopAt: (x, z) => terrain.waterTopAt(x, z),
});

// Forêts, plaines et déserts vivent dans leur propre module, pour la même raison que
// le village : pensés et testés à part du moteur. Le prédicat `isBlocked` reprend la
// voirie et les emprises bâties — rien ne pousse sur une avenue ni dans un mur, et la
// couronne est sondée à ses coins avant d'être plantée.
const biomes = createBiomeGen({
  BLOCK,
  CHUNK_SIZE,
  CHUNK_HEIGHT,
  heightAt: getTerrainHeight,
  roll: hashRoll,
  saltBase: (WORLD_SEEDS.trees * 7919) | 0,
  isBlocked: (wx, wz) => village.isOccupied(wx, wz),
  seaLevel: SEA_LEVEL,
  riverAt: (x, z) => terrain.riverAt(x, z),
});

// ==================== TEXTURE ATLAS ====================
const atlas = createTextureAtlas();

// Face table. Corner order is CCW seen from outside so FrontSide culling works,
// and uv follows the corner so textures stay upright on every face.
const FACE_KIND_TOP = 0, FACE_KIND_BOTTOM = 1, FACE_KIND_SIDE = 2;
const FACES = [
  { dir: [1, 0, 0],  kind: FACE_KIND_SIDE,   shade: 0.86, axis: 0,
    corners: [[1,1,0],[1,1,1],[1,0,1],[1,0,0]], uvs: [[0,1],[1,1],[1,0],[0,0]] },
  { dir: [-1, 0, 0], kind: FACE_KIND_SIDE,   shade: 0.86, axis: 0,
    corners: [[0,1,1],[0,1,0],[0,0,0],[0,0,1]], uvs: [[0,1],[1,1],[1,0],[0,0]] },
  { dir: [0, 1, 0],  kind: FACE_KIND_TOP,    shade: 1.00, axis: 1,
    corners: [[1,1,1],[1,1,0],[0,1,0],[0,1,1]], uvs: [[1,0],[1,1],[0,1],[0,0]] },
  { dir: [0, -1, 0], kind: FACE_KIND_BOTTOM, shade: 0.62, axis: 1,
    corners: [[1,0,0],[1,0,1],[0,0,1],[0,0,0]], uvs: [[0,0],[0,1],[1,1],[1,0]] },
  { dir: [0, 0, 1],  kind: FACE_KIND_SIDE,   shade: 0.76, axis: 2,
    corners: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]], uvs: [[0,0],[1,0],[1,1],[0,1]] },
  { dir: [0, 0, -1], kind: FACE_KIND_SIDE,   shade: 0.76, axis: 2,
    corners: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]], uvs: [[0,0],[1,0],[1,1],[0,1]] },
];

// Kept above 0.5 so stacked blocks still read as stepped rather than pitch black.
const AO_LEVELS = [0.60, 0.76, 0.88, 1.0];
const TANGENT_AXES = [
  [1, 2], // face along x -> sample in y/z
  [0, 2], // face along y -> sample in x/z
  [0, 1], // face along z -> sample in x/y
];

function tileNameFor(info, kind) {
  if (kind === FACE_KIND_TOP) return info.tiles.top;
  if (kind === FACE_KIND_BOTTOM) return info.tiles.bottom;
  return info.tiles.side;
}

// ==================== WORLD ====================
class World {
  constructor(scene) {
    this.scene = scene;
    this.chunks = new Map();
    this.modifiedBlocks = new Map(); // key: "x,y,z" -> blockId (player modifications)
    this.onEdit = null;              // save layer hooks this: the diff just changed
    this._overrideIndex = null;      // chunkKey -> Map(cellIndex -> id), see _indexOverrides
    this.pendingChunks = 0;          // in-range cells still waiting to be generated
    this.dirtyKeys = new Set();      // chunks awaiting a (re)mesh
    this._offsetRadius = null;       // cached nearest-first offset table, keyed by radius
    this._offsets = [];

    this.matOpaque = new THREE.MeshLambertMaterial({
      map: atlas.texture,
      vertexColors: true,
      transparent: false,
      side: THREE.FrontSide,
    });
    this.matTrans = new THREE.MeshLambertMaterial({
      map: atlas.texture,
      vertexColors: true,
      transparent: true,
      alphaTest: 0.3,
      depthWrite: true,
      side: THREE.DoubleSide,
    });
  }

  getChunkKey(cx, cz) {
    return `${cx},${cz}`;
  }

  getBlock(x, y, z) {
    // Check modified blocks first
    const key = `${x},${y},${z}`;
    if (this.modifiedBlocks.has(key)) {
      return this.modifiedBlocks.get(key);
    }

    // Check chunk data
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const chunk = this.chunks.get(this.getChunkKey(cx, cz));
    if (!chunk) return BLOCK.AIR;

    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 0 || y >= CHUNK_HEIGHT) {
      return BLOCK.AIR;
    }

    return chunk.data[lx + lz * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE] || BLOCK.AIR;
  }

  setBlock(x, y, z, blockId) {
    this.setBlocksBulk([[x, y, z, blockId]]);
  }

  // One remesh per touched chunk instead of one per block: a cuboid fill writes
  // thousands of cells and must not pay for thousands of chunk rebuilds.
  setBlocksBulk(cells) {
    const touched = new Set();
    for (const [x, y, z, blockId] of cells) {
      this.modifiedBlocks.set(`${x},${y},${z}`, blockId);
      this._touchedChunks(x, y, z, touched);
    }
    this._overrideIndex = null;

    for (const key of touched) {
      const comma = key.indexOf(',');
      this.rebuildChunk(+key.slice(0, comma), +key.slice(comma + 1));
    }
    if (touched.size > 0 && this.onEdit) this.onEdit();
    return touched.size;
  }

  // The chunk owning the column, plus any neighbour whose mesher reads across the
  // shared border and would otherwise keep a stale face there.
  _touchedChunks(x, y, z, into) {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;

    into.add(this.getChunkKey(cx, cz));
    if (lx === 0) into.add(this.getChunkKey(cx - 1, cz));
    if (lx === CHUNK_SIZE - 1) into.add(this.getChunkKey(cx + 1, cz));
    if (lz === 0) into.add(this.getChunkKey(cx, cz - 1));
    if (lz === CHUNK_SIZE - 1) into.add(this.getChunkKey(cx, cz + 1));
  }

  // Replays a save read from disk. It deliberately does not fire onEdit — putting
  // the stored diff back is not a player edit — and queues the remesh instead of
  // rebuilding in place, so a save holding tens of thousands of cubes still costs
  // nothing on the loading frame.
  applyEdits(edits) {
    this.modifiedBlocks = new Map(edits);
    this._overrideIndex = null;
    const touched = new Set();
    for (const key of this.modifiedBlocks.keys()) {
      const first = key.indexOf(',');
      const second = key.indexOf(',', first + 1);
      if (second < 0) continue;
      const x = +key.slice(0, first);
      const y = +key.slice(first + 1, second);
      const z = +key.slice(second + 1);
      if (!(y >= 0 && y < CHUNK_HEIGHT)) continue;
      this._touchedChunks(x, y, z, touched);
    }
    for (const key of touched) {
      if (this.chunks.has(key)) this.dirtyKeys.add(key);
    }
    return this.modifiedBlocks.size;
  }

  // "Nouveau monde": drops every player edit and re-queues the visible meshes.
  clearEdits() {
    this.modifiedBlocks = new Map();
    this._overrideIndex = null;
    for (const key of this.chunks.keys()) this.dirtyKeys.add(key);
  }

  // Edits bucketed per chunk, rebuilt once per mutation batch. Walking the whole
  // diff for every chunk rebuild was harmless while it held a handful of blocks;
  // now that a world accumulates its edits across sessions, an unindexed scan
  // would cost O(chunks x edits) on each streaming pass.
  _indexOverrides() {
    if (this._overrideIndex) return this._overrideIndex;
    const index = new Map();
    for (const [key, id] of this.modifiedBlocks) {
      const first = key.indexOf(',');
      const second = key.indexOf(',', first + 1);
      if (second < 0) continue;
      const x = +key.slice(0, first);
      const y = +key.slice(first + 1, second);
      const z = +key.slice(second + 1);
      if (!(y >= 0 && y < CHUNK_HEIGHT)) continue;
      const cx = Math.floor(x / CHUNK_SIZE);
      const cz = Math.floor(z / CHUNK_SIZE);
      const chunkKey = this.getChunkKey(cx, cz);
      let bucket = index.get(chunkKey);
      if (!bucket) {
        bucket = new Map();
        index.set(chunkKey, bucket);
      }
      bucket.set((x - cx * CHUNK_SIZE) + (z - cz * CHUNK_SIZE) * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE, id);
    }
    this._overrideIndex = index;
    return index;
  }

  isSolid(x, y, z) {
    const block = this.getBlock(x, y, z);
    if (block === BLOCK.AIR) return false;
    const info = BLOCK_INFO[block];
    return !!info.solid;
  }

  isOpaque(x, y, z) {
    const block = this.getBlock(x, y, z);
    if (block === BLOCK.AIR) return false;
    const info = BLOCK_INFO[block];
    return !!info.opaque;
  }

  isLiquid(x, y, z) {
    const info = BLOCK_INFO[this.getBlock(x, y, z)];
    return !!(info && info.liquid);
  }

  generateChunkData(cx, cz) {
    const key = this.getChunkKey(cx, cz);
    if (this.chunks.has(key)) return null;

    const data = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_HEIGHT);
    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;
    const cells = CHUNK_SIZE * CHUNK_SIZE;

    // Une seule lecture de bruit par colonne : le relief ressert au remplissage,
    // au revêtement des voiries et à l'assise des bâtiments.
    const heights = new Int16Array(cells);
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        heights[lx + lz * CHUNK_SIZE] = getTerrainHeight(baseX + lx, baseZ + lz);
      }
    }

    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wx = baseX + lx;
        const wz = baseZ + lz;
        const height = heights[lx + lz * CHUNK_SIZE];
        // Le biome décide du revêtement et de son assise : sable sur le désert et la
        // grève, mousse sous les futaies, herbe ailleurs, neige au-dessus de sa ligne.
        const sol = biomes.surfaceFor(wx, wz, height);
        // Plan d'eau de la colonne : la mer partout, ou le plan local d'une rivière là
        // où un cours passe — il est plus haut que la mer en amont, et c'est ce qui fait
        // un cours d'eau plutôt qu'un simple fossé sec.
        const niveauEau = terrain.waterTopAt(wx, wz);

        for (let y = 0; y < CHUNK_HEIGHT; y++) {
          const idx = lx + lz * CHUNK_SIZE + y * cells;

          if (y < height - 3) {
            // Deep: stone
            data[idx] = BLOCK.STONE;
            // Caves
            if (isCave(wx, y, wz)) {
              data[idx] = BLOCK.AIR;
            }
            // Ores (rare)
            else if (y < 16 && hashRoll(wx, y, wz, 1) < 0.002) {
              data[idx] = BLOCK.DIAMOND;
            } else if (y < 24 && hashRoll(wx, y, wz, 2) < 0.005) {
              data[idx] = BLOCK.GOLD;
            } else if (y < 32 && hashRoll(wx, y, wz, 3) < 0.008) {
              data[idx] = BLOCK.IRON;
            } else if (y < 40 && hashRoll(wx, y, wz, 4) < 0.01) {
              data[idx] = BLOCK.COAL;
            }
          } else if (y < height) {
            // Near surface: dirt, or sand through the whole dune of a desert floor
            data[idx] = sol.under;
          } else if (y === height) {
            data[idx] = sol.top;
          } else if (y <= niveauEau) {
            // Eau : de la dernière colonne de sable jusqu'au plan d'eau. La mer suit la
            // ligne de flottaison, la rivière son propre plan. L'eau n'est pas solide et
            // ne coule pas — une nappe est posée colonne par colonne, ce qui laisse les
            // grottes sous le plancher rester sèches.
            data[idx] = BLOCK.WATER;
          }
        }
      }
    }

    // Troncs et couronnes avant la voirie : routes, maisons et ouvrages estampés
    // ensuite reprendront le terrain, et une souche mal placée disparaîtra sous la
    // chaussée plutôt que de pousser dedans.
    biomes.stampVegetation(data, cx, cz);

    village.stampRoads(data, cx, cz);
    village.stampBuilding(data, cx, cz);
    // Ponts et arcs en dernier : ils reprennent le revêtement de la voirie pour le
    // porter en tablier, et leurs plans ont déjà écarté les entrées de bâtiment. En
    // fin de chaîne, l'avenue reste toujours praticable.
    village.stampStructures(data, cx, cz);

    this.chunks.set(key, { data, meshes: [], cx, cz });
    return this.chunks.get(key);
  }

  generateChunk(cx, cz) {
    if (!this.generateChunkData(cx, cz)) return;
    this.rebuildChunk(cx, cz);
  }

  // Per-chunk snapshot of the player edits inside this chunk, indexed numerically
  // so the mesher never has to build a string key per block.
  collectOverrides(cx, cz) {
    const overrides = new Int16Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_HEIGHT).fill(-1);
    if (this.modifiedBlocks.size === 0) return overrides;
    const bucket = this._indexOverrides().get(this.getChunkKey(cx, cz));
    if (!bucket) return overrides;
    for (const [idx, id] of bucket) overrides[idx] = id;
    return overrides;
  }

  rebuildChunk(cx, cz) {
    const key = this.getChunkKey(cx, cz);
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.dirtyKeys.delete(key);

    for (const mesh of chunk.meshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    chunk.meshes = [];

    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;
    const overrides = this.collectOverrides(cx, cz);
    const hasMods = this.modifiedBlocks.size > 0;

    // In-chunk reads go straight to typed arrays; only the border columns pay
    // for a cross chunk lookup.
    const blockAt = (wx, wy, wz) => {
      if (wy < 0 || wy >= CHUNK_HEIGHT) return BLOCK.AIR;
      const lx = wx - baseX;
      const lz = wz - baseZ;
      if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
        const idx = lx + lz * CHUNK_SIZE + wy * CHUNK_SIZE * CHUNK_SIZE;
        if (hasMods && overrides[idx] >= 0) return overrides[idx];
        return chunk.data[idx] || BLOCK.AIR;
      }
      return this.getBlock(wx, wy, wz);
    };
    const opaqueAt = (wx, wy, wz) => {
      const b = blockAt(wx, wy, wz);
      return b !== BLOCK.AIR && !!BLOCK_INFO[b].opaque;
    };

    const buckets = {
      opaque: { positions: [], normals: [], uvs: [], colors: [], indices: [], count: 0 },
      trans:  { positions: [], normals: [], uvs: [], colors: [], indices: [], count: 0 },
    };

    // Classic voxel AO: the two side neighbours and the diagonal one sitting on
    // the air side of the face darken the corner they surround.
    const aoLevel = (face, wx, y, wz, corner) => {
      const [a, b] = TANGENT_AXES[face.axis];
      const nx = wx + face.dir[0], ny = y + face.dir[1], nz = wz + face.dir[2];
      const da = corner[a] === 1 ? 1 : -1;
      const db = corner[b] === 1 ? 1 : -1;
      const oa = [0, 0, 0]; oa[a] = da;
      const ob = [0, 0, 0]; ob[b] = db;
      let occ = 0;
      if (opaqueAt(nx + oa[0], ny + oa[1], nz + oa[2])) occ++;
      if (opaqueAt(nx + ob[0], ny + ob[1], nz + ob[2])) occ++;
      if (opaqueAt(nx + oa[0] + ob[0], ny + oa[1] + ob[1], nz + oa[2] + ob[2])) occ++;
      return AO_LEVELS[3 - occ];
    };

    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let y = 0; y < CHUNK_HEIGHT; y++) {
          const idx = lx + lz * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE;
          const wx = baseX + lx;
          const wz = baseZ + lz;
          let finalBlockId = chunk.data[idx];
          if (hasMods && overrides[idx] >= 0) finalBlockId = overrides[idx];
          if (!finalBlockId) continue;

          const info = BLOCK_INFO[finalBlockId];
          const bucket = info.pass === 'opaque' ? buckets.opaque : buckets.trans;
          const cullSameId = info.pass !== 'cutout';

          for (const face of FACES) {
            const nx = wx + face.dir[0];
            const ny = y + face.dir[1];
            const nz = wz + face.dir[2];
            const neighbor = blockAt(nx, ny, nz);

            let visible;
            if (neighbor === BLOCK.AIR) visible = true;
            else if (BLOCK_INFO[neighbor].opaque) visible = false;
            else visible = !cullSameId || neighbor !== finalBlockId;
            if (!visible) continue;

            const rect = atlas.uvRect(tileNameFor(info, face.kind));
            // Translucent blocks keep their own tint rather than being darkened
            // twice (the texture already carries the colour).
            const faceLight = info.pass === 'opaque' ? aoLevel : null;

            for (let c = 0; c < 4; c++) {
              const corner = face.corners[c];
              const uv = face.uvs[c];
              bucket.positions.push(wx + corner[0], y + corner[1], wz + corner[2]);
              bucket.normals.push(face.dir[0], face.dir[1], face.dir[2]);
              bucket.uvs.push(
                rect.u0 + uv[0] * (rect.u1 - rect.u0),
                rect.v0 + uv[1] * (rect.v1 - rect.v0)
              );
              const light = face.shade * (faceLight ? faceLight(face, wx, y, wz, corner) : 1);
              bucket.colors.push(light, light, light);
            }

            bucket.indices.push(
              bucket.count, bucket.count + 1, bucket.count + 2,
              bucket.count, bucket.count + 2, bucket.count + 3
            );
            bucket.count += 4;
          }
        }
      }
    }

    for (const bucket of [buckets.opaque, buckets.trans]) {
      if (bucket.count === 0) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.normals, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uvs, 2));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(bucket.colors, 3));
      geometry.setIndex(bucket.indices);
      geometry.computeBoundingSphere();

      const mesh = new THREE.Mesh(geometry, bucket === buckets.opaque ? this.matOpaque : this.matTrans);
      mesh.renderOrder = bucket === buckets.opaque ? 0 : 1;
      this.scene.add(mesh);
      chunk.meshes.push(mesh);
    }
  }

  // Nearest-first cell order for a radius, rebuilt only when the radius changes:
  // at 32 chunks that is 4356 entries, far too many to sort every frame.
  offsetsFor(radius) {
    if (this._offsetRadius !== radius) {
      const offsets = [];
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          offsets.push([dx, dz, dx * dx + dz * dz]);
        }
      }
      offsets.sort((a, b) => a[2] - b[2]);
      this._offsets = offsets;
      this._offsetRadius = radius;
    }
    return this._offsets;
  }

  // Generates at most `maxCells` missing cells, and gives up after `maxMs` of wall
  // clock, so a large view depth streams in over frames instead of freezing the tab.
  // A chunk is meshed only once its four neighbours exist: building it earlier would
  // re-mesh it every time a new neighbour shows up, which doubles the total cost.
  updateChunks(playerX, playerZ, maxCells = Infinity, maxMs = Infinity) {
    const started = performance.now();
    const pcx = Math.floor(playerX / CHUNK_SIZE);
    const pcz = Math.floor(playerZ / CHUNK_SIZE);
    const radius = settings.renderDistance;
    const offsets = this.offsetsFor(radius);

    // Meshing costs about twice what generating costs (each new chunk dirties its
    // neighbours too), so the two phases get separate slices of the frame budget and
    // the mesher goes first. The watermark is what keeps the two in step: generation
    // pauses while a backlog exists instead of outrunning the mesher forever.
    const meshDeadline = started + maxMs * 0.5;
    const genDeadline = started + maxMs;

    for (const key of this.dirtyKeys) {
      if (!this.chunks.has(key)) { this.dirtyKeys.delete(key); continue; }
      const [cx, cz] = key.split(',').map(Number);
      this.rebuildChunk(cx, cz);
      if (performance.now() > meshDeadline) break;
    }

    let made = 0;
    let pending = 0;
    // The scan always covers every cell in range so pendingChunks means "work left",
    // not "work left that we happened to look at"; only the generation itself is
    // limited by the watermark and the clock.
    for (const [dx, dz] of offsets) {
      const cx = pcx + dx;
      const cz = pcz + dz;
      const key = this.getChunkKey(cx, cz);
      if (this.chunks.has(key)) continue;
      pending++;
      if (made >= maxCells) continue;
      if (this.dirtyKeys.size > CHUNK_MESH_WATERMARK) continue;
      if ((made & 3) === 3 && performance.now() > genDeadline) continue;
      made++; // failures consume budget too, so a bad cell cannot spin forever
      if (this.generateChunkData(cx, cz)) {
        this.markChunkDirty(cx, cz);
        this.markChunkDirty(cx - 1, cz);
        this.markChunkDirty(cx + 1, cz);
        this.markChunkDirty(cx, cz - 1);
        this.markChunkDirty(cx, cz + 1);
      }
    }

    // Remove far chunks
    for (const [key, chunk] of this.chunks) {
      const dist = Math.max(
        Math.abs(chunk.cx - pcx),
        Math.abs(chunk.cz - pcz)
      );
      if (dist > radius + 2) {
        for (const mesh of chunk.meshes) {
          this.scene.remove(mesh);
          mesh.geometry.dispose();
        }
        chunk.meshes = [];
        this.chunks.delete(key);
        this.dirtyKeys.delete(key);
      }
    }

    this.pendingChunks = pending + this.dirtyKeys.size;
    return { generated: made, pending: this.pendingChunks };
  }

  markChunkDirty(cx, cz) {
    const key = this.getChunkKey(cx, cz);
    if (this.chunks.has(key)) this.dirtyKeys.add(key);
  }

  // Repaints the atlas tiles of a block type (custom texture upload).
  setBlockTexture(blockId, source) {
    const info = BLOCK_INFO[blockId];
    if (!info) return false;
    const names = new Set([info.tiles.side, info.tiles.top, info.tiles.bottom]);
    let ok = false;
    for (const n of names) ok = atlas.overrideTile(n, source) || ok;
    return ok;
  }

  restoreBlockTexture(blockId) {
    const info = BLOCK_INFO[blockId];
    if (!info) return false;
    const names = new Set([info.tiles.side, info.tiles.top, info.tiles.bottom]);
    let ok = false;
    for (const n of names) ok = atlas.restoreTile(n) || ok;
    return ok;
  }
}

// ==================== PLAYER ====================
class Player {
  constructor(camera, world, controls, hotbar) {
    this.camera = camera;
    this.world = world;
    this.controls = controls;
    this.hotbar = hotbar;
    this.velocity = new THREE.Vector3();
    this.onGround = false;
    this.nage = false;        // le corps est dans l'eau : contrôleur de nage
    this.sousLEau = false;    // et la tête dessous : teinte d'immersion
    // Combien du corps reste sous l'eau au repos, réglé au clavier (+ et -). Portée
    // par le joueur plutôt que par une constante : on garde son assiette tant qu'on nage.
    this.assiette = FLOAT_SUBMERGED;
    this.flyMode = FLY;
    this.spawnPoint = new THREE.Vector3(8, 0, 8);
    // Placement only: the saved position now arrives asynchronously from disk and
    // bootWorld() owns the chunk building, so the constructor must not stream.
    this.placeAtSpawn();
  }

  // The hotbar is the single source of truth for what the player holds.
  get selectedBlock() { return this.hotbar.selectedBlock(); }
  get selectedSlot() { return this.hotbar.selected; }

  // ---- geometry helpers -------------------------------------------------
  get feetY() { return this.camera.position.y - EYE_HEIGHT; }
  setEye(x, y, z) { this.camera.position.set(x, y + EYE_HEIGHT, z); }
  setFeet(y) { this.camera.position.y = y + EYE_HEIGHT; }

  // Does the collider overlap a solid voxel when placed with its feet at `feet`?
  collides(x, feet, z) {
    const hw = PLAYER_HALF_WIDTH;
    const minX = Math.floor(x - hw + COLLIDE_EPS);
    const maxX = Math.floor(x + hw - COLLIDE_EPS);
    const minY = Math.floor(feet + COLLIDE_EPS);
    const maxY = Math.floor(feet + PLAYER_HEIGHT - COLLIDE_EPS);
    const minZ = Math.floor(z - hw + COLLIDE_EPS);
    const maxZ = Math.floor(z + hw - COLLIDE_EPS);

    for (let bx = minX; bx <= maxX; bx++) {
      for (let by = minY; by <= maxY; by++) {
        for (let bz = minZ; bz <= maxZ; bz++) {
          if (this.world.isSolid(bx, by, bz)) return true;
        }
      }
    }
    return false;
  }

  // Used to refuse placing a block inside the player.
  intersectsBlock(bx, by, bz) {
    const p = this.camera.position;
    const feet = this.feetY;
    const hw = PLAYER_HALF_WIDTH;
    return (
      p.x + hw > bx + COLLIDE_EPS && p.x - hw < bx + 1 - COLLIDE_EPS &&
      p.z + hw > bz + COLLIDE_EPS && p.z - hw < bz + 1 - COLLIDE_EPS &&
      feet + PLAYER_HEIGHT > by + COLLIDE_EPS && feet < by + 1 - COLLIDE_EPS
    );
  }

  // Push the collider out of terrain it spawned inside of.
  settle() {
    const p = this.camera.position;
    let feet = this.feetY;
    if (!this.collides(p.x, feet, p.z)) {
      this.velocity.y = 0;
      return true;
    }
    for (let i = 0; i < 64; i++) {
      feet += 0.1;
      if (!this.collides(p.x, feet, p.z)) {
        this.setFeet(feet);
        this.velocity.set(0, 0, 0);
        this.onGround = true;
        return true;
      }
    }
    this._teleportToSpawn();
    return false;
  }

  _spawnXZ() {
    return [SPAWN_XZ[0], SPAWN_XZ[1]];
  }

  // Drops the player on the surface at the spawn point without touching the world.
  placeAtSpawn() {
    const [sx, sz] = this._spawnXZ();
    this.setEye(sx, getTerrainHeight(sx, sz) + 1, sz);
    this.velocity.set(0, 0, 0);
    this.onGround = false;
  }

  _teleportToSpawn() {
    const [sx, sz] = this._spawnXZ();
    // chunks around the spawn may have been unloaded while the player was away
    this.world.updateChunks(sx, sz, WORLD_BOOT_BUDGET);
    this.placeAtSpawn();
  }

  respawn() {
    this._teleportToSpawn();
    this.settle();
  }

  // What lands in the save file: eye position plus the look direction, so a
  // resumed session opens facing the same way it was left.
  saveState() {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    const p = this.camera.position;
    return { x: p.x, y: p.y, z: p.z, yaw: e.y, pitch: e.x };
  }

  // The ground has to exist before the player is dropped on it: landing in an
  // ungenerated chunk would fall straight through to KILL_Y, hence the synchronous
  // build under the feet followed by settle() for edits saved inside the terrain.
  restoreFromSave(state) {
    if (!state) return false;
    this.setEye(state.x, state.y, state.z);
    this.camera.rotation.order = 'YXZ';
    this.camera.quaternion.setFromEuler(new THREE.Euler(state.pitch, state.yaw, 0, 'YXZ'));
    this.velocity.set(0, 0, 0);
    this.onGround = false;
    this.world.updateChunks(state.x, state.z, WORLD_BOOT_BUDGET);
    this.settle();
    return true;
  }

  // ---- nage ---------------------------------------------------------------
  /**
   * Où en est le corps par rapport à l'**eau** : c'est ce qui choisit le contrôleur.
   * `surface` est la première colonne non liquide au-dessus du joueur, autrement dit
   * le plan d'eau vers lequel la flottaison le ramène. Seule l'eau compte : la lave
   * aussi est `liquid`, mais y flotter tiendrait le joueur suspendu au-dessus d'un
   * bain de lave au lieu de le laisser s'y enfoncer lentement.
   */
  waterState() {
    const p = this.camera.position;
    const feet = this.feetY;
    const bx = Math.floor(p.x);
    const bz = Math.floor(p.z);
    const eau = (y) => this.world.getBlock(bx, y, bz) === BLOCK.WATER;
    const pieds = eau(Math.floor(feet + 0.2));
    const poitrine = eau(Math.floor(feet + 0.9));
    const tete = eau(Math.floor(feet + PLAYER_HEIGHT - 0.2));
    if (!pieds && !poitrine && !tete) return { nage: false, tete: false, surface: 0 };
    let y = Math.floor(pieds ? feet + 0.2 : (poitrine ? feet + 0.9 : feet + PLAYER_HEIGHT - 0.2));
    while (y < CHUNK_HEIGHT && eau(y)) y++;
    return { nage: true, tete, surface: y };
  }

  /** Le corps trempe-t-il dans la lave ? (plafond de chute, pas de flottaison) */
  dansLaLave() {
    const p = this.camera.position;
    const bx = Math.floor(p.x);
    const bz = Math.floor(p.z);
    const lave = (y) => this.world.getBlock(bx, y, bz) === BLOCK.LAVA;
    const feet = this.feetY;
    return lave(Math.floor(feet + 0.2)) || lave(Math.floor(feet + 0.9))
      || lave(Math.floor(feet + PLAYER_HEIGHT - 0.2));
  }

  /** Règle l'assiette de flottaison (+ et - au clavier) et renvoie la valeur retenue. */
  regleAssiette(pas) {
    this.assiette = Math.min(ASSIETTE_MAX, Math.max(ASSIETTE_MIN, this.assiette + pas));
    return this.assiette;
  }

  /** Le corps repose-t-il sur le lit ? Au fond, on ne vous éjecte pas vers la surface. */
  toucheLeFond() {
    const p = this.camera.position;
    return this.collides(p.x, this.feetY - 0.35, p.z);
  }

  /**
   * Le contrôleur de l'eau. La vitesse verticale **rejoint** une vitesse visée au lieu
   * d'être intégrée à coups d'accélération : le rappel tout-ou-rien d'avance ne
   * s'asseyait jamais sur l'équilibre et faisait trembler le joueur à la surface. Trois
   * régimes, et c'est leur découpage qui répond aux deux plaintes — « je coule au lieu
   * de flotter » et « je ne peux pas rester au fond » :
   *
   *  - à la ligne (dans `FLOT_BAND`) : un ressort amorti tient le corps à `surface −
   *    assiette`, sans rebond ni oscillation ;
   *  - plus bas, en pleine eau : dérive lente vers la surface — on n'y est pas aspiré,
   *    on peut donc y travailler ;
   *  - posé sur le lit : rien ne soulève, on reste au fond sans tenir Majuscule.
   */
  applyWater(deltaTime, eau) {
    const cible = eau.surface - this.assiette;
    const ecart = cible - this.feetY;
    let vise;
    if (this.controls.keys['Space']) vise = SWIM_UP;
    else if (this.controls.keys['ShiftLeft']) vise = -SWIM_DOWN;
    else if (ecart > FLOT_BAND) vise = this.toucheLeFond() ? 0 : FLOT_DRIFT;
    else vise = Math.max(-FLOT_RAISE, Math.min(FLOT_RAISE, ecart * FLOT_GAIN));
    const alpha = 1 - Math.exp(-VERT_RESPONSE * deltaTime);
    this.velocity.y += (vise - this.velocity.y) * alpha;
    this.velocity.x *= Math.exp(-WATER_DRAG_XZ * deltaTime);
    this.velocity.z *= Math.exp(-WATER_DRAG_XZ * deltaTime);
    this.velocity.y = Math.min(SWIM_UP, Math.max(-SWIM_DOWN, this.velocity.y));
  }

  update(deltaTime) {
    const pos = this.camera.position;

    // Movement input relative to where the camera looks (flattened on XZ).
    const direction = new THREE.Vector3();
    this.controls.getDirection(direction);
    direction.y = 0;
    if (direction.lengthSq() > 0) direction.normalize();

    const right = new THREE.Vector3();
    right.crossVectors(direction, new THREE.Vector3(0, 1, 0)).normalize();

    const moveInput = new THREE.Vector3();
    if (this.controls.keys['KeyW'] || this.controls.keys['KeyZ']) moveInput.add(direction);
    if (this.controls.keys['KeyS']) moveInput.sub(direction);
    if (this.controls.keys['KeyD'] || this.controls.keys['KeyQ']) moveInput.add(right);
    if (this.controls.keys['KeyA']) moveInput.sub(right);
    if (moveInput.lengthSq() > 0) moveInput.normalize();

    const eau = this.flyMode ? { nage: false, tete: false, surface: 0 } : this.waterState();
    this.nage = eau.nage;
    this.sousLEau = eau.tete;

    const speed = this.flyMode ? FLY_SPEED : (eau.nage ? SWIM_SPEED : MOVE_SPEED);
    this.velocity.x = moveInput.x * speed;
    this.velocity.z = moveInput.z * speed;

    if (!this.flyMode) {
      if (eau.nage) {
        this.applyWater(deltaTime, eau);
      } else {
        this.velocity.y -= GRAVITY * deltaTime;
        this.velocity.y = Math.max(this.velocity.y, -TERMINAL_VELOCITY);
        // Dans la lave on s'enfonce, on ne tombe pas : le plafond supprime la vitesse
        // terminale dès que le corps touche le bain.
        if (this.dansLaLave()) this.velocity.y = Math.max(this.velocity.y, LAVE_CHUTE);
        if (this.controls.keys['Space'] && this.onGround) {
          this.velocity.y = JUMP_SPEED;
          this.onGround = false;
        }
      }
    } else {
      if (this.controls.keys['Space']) this.velocity.y = FLY_SPEED;
      else if (this.controls.keys['ShiftLeft']) this.velocity.y = -FLY_SPEED;
      else this.velocity.y = 0;
    }

    this.moveWithCollision(this.velocity.clone().multiplyScalar(deltaTime));

    if (this.feetY < KILL_Y) this.respawn();
    // Position persistence is driven by the autosave tick in animate(), which
    // writes the whole world diff and the player state together.
  }

  // Moves one axis at a time in small substeps, snapping flush against the
  // blocking face instead of stopping mid-air (which used to leave the player
  // floating a fraction of a block away from walls).
  moveWithCollision(delta) {
    const pos = this.camera.position;

    // A block placed inside the player, or a stale saved position, must not
    // make every subsequent move report a collision.
    if (this.collides(pos.x, this.feetY, pos.z)) this.settle();

    this.moveY(delta.y);
    this.moveHorizontal(0, delta.x);
    this.moveHorizontal(2, delta.z);

    if (!this.flyMode) {
      const feet = this.feetY;
      this.onGround = this.velocity.y <= 0 && this.collides(pos.x, feet - GROUND_PROBE, pos.z);
    } else {
      this.onGround = false;
    }
  }

  moveY(delta) {
    if (delta === 0) return;
    const pos = this.camera.position;
    const steps = Math.max(1, Math.ceil(Math.abs(delta) / MAX_SUBSTEP));
    const inc = delta / steps;

    for (let i = 0; i < steps; i++) {
      const feet = this.feetY;
      const candidate = feet + inc;
      if (!this.collides(pos.x, candidate, pos.z)) {
        this.setFeet(candidate);
        continue;
      }
      if (inc < 0) {
        // landed: rest exactly on top of the blocking block
        this.setFeet(Math.floor(candidate) + 1);
        this.onGround = true;
      } else {
        // head bumped the underside of a block
        this.setFeet(Math.floor(candidate + PLAYER_HEIGHT) - PLAYER_HEIGHT);
      }
      this.velocity.y = 0;
      return;
    }
  }

  moveHorizontal(axis, delta) {
    if (delta === 0) return;
    const pos = this.camera.position;
    const key = axis === 0 ? 'x' : 'z';
    const steps = Math.max(1, Math.ceil(Math.abs(delta) / MAX_SUBSTEP));
    const inc = delta / steps;

    for (let i = 0; i < steps; i++) {
      const feet = this.feetY;
      const candidate = pos[key] + inc;
      const candX = axis === 0 ? candidate : pos.x;
      const candZ = axis === 2 ? candidate : pos.z;

      if (!this.collides(candX, feet, candZ)) {
        pos[key] = candidate;
        continue;
      }

      // Auto step up onto a single block while walking on the ground. A swimmer gets
      // two plus a stroke's reach: coming out of the sea onto the beach must never be
      // a wall. The resting levels are whole numbers (block top + 1), so the ladder is
      // anchored on the first one at or above the feet — anchoring it on `floor(feet)`
      // loses a rung whenever the feet rest a hair under the block top they stand on
      // (30.999999999999996 for a top at 31), which turned every stair tread into a
      // wall and left the swimmer — never exactly on the float line — stuck in the sea.
      if (!this.flyMode && (this.onGround || this.nage)) {
        const portee = this.nage ? SWIM_STEP + SWIM_REACH : STEP_HEIGHT;
        const assise = Math.ceil(feet - COLLIDE_EPS);
        let gravi = false;
        for (let raised = assise; raised - feet <= portee + COLLIDE_EPS; raised++) {
          if (raised <= feet + COLLIDE_EPS) continue;
          if (!this.collides(pos.x, raised, pos.z) && !this.collides(candX, raised, candZ)) {
            this.setFeet(raised);
            pos[key] = candidate;
            gravi = true;
            break;
          }
        }
        if (gravi) continue;
      }

      if (inc > 0) {
        pos[key] = Math.floor(candidate + PLAYER_HALF_WIDTH) - PLAYER_HALF_WIDTH - COLLIDE_EPS;
      } else {
        pos[key] = Math.floor(candidate - PLAYER_HALF_WIDTH) + 1 + PLAYER_HALF_WIDTH + COLLIDE_EPS;
      }
      this.velocity[key] = 0;
      return;
    }
  }

  getLookTarget() {
    const pos = this.camera.position;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const dist = 6;
    return pos.clone().add(dir.multiplyScalar(dist));
  }
}

// ==================== BLOCK ICONS / HOTBAR / INVENTORY ====================
// Icons come straight out of the world atlas so the HUD always matches what
// actually gets placed.
function drawBlockIcon(canvas, blockId) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(atlas.tileCanvas(BLOCK_INFO[blockId].tiles.side), 0, 0);
}

class Hotbar {
  constructor() {
    this.container = document.getElementById('hotbar');
    this.stripContainer = document.getElementById('inventory-hotbar');
    this.blocks = loadHotbar();
    this.selected = 0;
    this.slots = [];
    this.stripSlots = [];
    this.build();
  }

  build() {
    this.container.innerHTML = '';
    this.stripContainer.innerHTML = '';
    this.slots = [];
    this.stripSlots = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      this.slots.push(this.makeSlot(i, false));
      this.stripSlots.push(this.makeSlot(i, true));
    }
    this.select(this.selected);
  }

  makeSlot(index, inInventory) {
    const slot = document.createElement('div');
    slot.className = 'hotbar-slot';
    slot.dataset.index = index;

    const num = document.createElement('span');
    num.className = 'slot-num';
    num.textContent = index + 1;
    slot.appendChild(num);

    const preview = document.createElement('canvas');
    preview.width = 16;
    preview.height = 16;
    slot.appendChild(preview);
    drawBlockIcon(preview, this.blocks[index]);

    if (inInventory) {
      slot.title = `Cibler l'emplacement ${index + 1}`;
      slot.addEventListener('click', () => this.select(index));
      this.stripContainer.appendChild(slot);
    } else {
      this.container.appendChild(slot);
    }
    return slot;
  }

  select(index) {
    const i = ((index % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    this.selected = i;
    for (const list of [this.slots, this.stripSlots]) {
      list.forEach((slot, k) => slot.classList.toggle('active', k === i));
    }
    return this.blocks[i];
  }

  cycle(dir) { return this.select(this.selected + (dir >= 0 ? 1 : -1)); }

  selectedBlock() { return this.blocks[this.selected]; }

  assign(index, blockId) {
    if (!BLOCK_INFO[blockId]) return false;
    const i = Math.max(0, Math.min(HOTBAR_SIZE - 1, index | 0));
    this.blocks[i] = blockId;
    drawBlockIcon(this.slots[i].querySelector('canvas'), blockId);
    drawBlockIcon(this.stripSlots[i].querySelector('canvas'), blockId);
    localStorage.setItem(HOTBAR_STORAGE_KEY, JSON.stringify(this.blocks));
    return true;
  }

  // Called after an atlas tile is repainted (custom texture upload).
  render() {
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      drawBlockIcon(this.slots[i]?.querySelector('canvas'), this.blocks[i]);
      drawBlockIcon(this.stripSlots[i]?.querySelector('canvas'), this.blocks[i]);
    }
  }

  reset() {
    this.blocks = DEFAULT_HOTBAR.slice();
    this.build();
    this.select(0);
  }
}

class Inventory {
  constructor(hotbar, controls, blocker, keys, lockPointer) {
    this.hotbar = hotbar;
    this.controls = controls;
    this.blocker = blocker;
    this.keys = keys;
    this.lockPointer = lockPointer;
    this.root = document.getElementById('inventory');
    this.grid = document.getElementById('inventory-grid');
    this.cells = new Map();
    this.visible = false;
    this.build();
    document.getElementById('inv-close').addEventListener('click', () => this.hide());
  }

  build() {
    this.grid.innerHTML = '';
    this.cells.clear();
    for (const group of BLOCK_GROUPS) {
      const head = document.createElement('div');
      head.className = 'inv-section';
      head.textContent = group.label;
      this.grid.appendChild(head);

      for (const id of group.ids) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'inv-cell';
        cell.dataset.block = String(id);
        cell.title = `${BLOCK_INFO[id].name} — affecter à l'emplacement actif`;

        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        drawBlockIcon(canvas, id);
        cell.appendChild(canvas);

        const label = document.createElement('span');
        label.textContent = BLOCK_INFO[id].name;
        cell.appendChild(label);

        cell.addEventListener('click', () => this.pick(id));
        this.grid.appendChild(cell);
        this.cells.set(id, cell);
      }
    }
    this.markEquipped();
  }

  // Left click puts the block into the active slot and holds it right away.
  pick(blockId) {
    if (!this.hotbar.assign(this.hotbar.selected, blockId)) return false;
    this.hotbar.select(this.hotbar.selected);
    this.markEquipped();
    return true;
  }

  markEquipped() {
    const equipped = new Set(this.hotbar.blocks);
    for (const [id, cell] of this.cells) cell.classList.toggle('equipped', equipped.has(id));
  }

  // Re-draw every palette icon from the atlas (custom texture upload changed a tile).
  repaintIcons() {
    for (const [id, cell] of this.cells) {
      const canvas = cell.querySelector('canvas');
      if (canvas) drawBlockIcon(canvas, id);
    }
  }

  isOpen() { return this.visible; }

  toggle() { if (this.visible) this.hide(); else this.show(); }

  show() {
    this.visible = true;
    this.root.classList.add('open');
    // The start/pause screen would otherwise cover the palette; hide() puts it
    // back through relock() if the pointer lock cannot be re-acquired.
    this.blocker.style.display = 'none';
    this.markEquipped();
    // the palette needs the cursor, so give the pointer lock back to the page
    if (this.controls.isLocked) this.controls.unlock();
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.root.classList.remove('open');
    // never resume play with a key still held down from the menu
    for (const k of Object.keys(this.keys)) this.keys[k] = false;
    this.relock();
  }

  relock() {
    const restore = () => {
      if (!this.controls.isLocked && !this.visible) this.blocker.style.display = 'flex';
    };
    const pending = this.lockPointer();
    // Refused for lack of user activation: hand the screen back right away instead
    // of leaving the page with neither the game nor the start screen under foot.
    if (pending && typeof pending.catch === 'function') pending.catch(restore);
    setTimeout(restore, 300); // engines where requestPointerLock returns nothing
  }
}

// ==================== MAIN GAME ====================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 30, 60);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);

// Fog and the far plane have to follow the configured view depth: too little fog
// and chunks pop in un-blurred at the edge, too much and a short distance just
// greys out. Both are derived from the same number so they never disagree.
function applyFogForDistance(radius) {
  scene.fog.near = Math.max(6, radius * CHUNK_SIZE * 0.45);
  scene.fog.far = radius * CHUNK_SIZE * 0.85;
  camera.far = Math.max(200, radius * CHUNK_SIZE * 2);
  camera.updateProjectionMatrix();
}
applyFogForDistance(settings.renderDistance);

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.72);
scene.add(ambientLight);

const sunLight = new THREE.DirectionalLight(0xfff4e0, 0.5);
sunLight.position.set(50, 100, 50);
scene.add(sunLight);

const world = new World(scene);
world.updateChunks(SPAWN_XZ[0], SPAWN_XZ[1], WORLD_BOOT_BUDGET);

// Applies a new view depth right away: the start screen is translucent, so the
// player sees the change behind the panel while dragging the slider. The rest of
// the field streams in from animate() — a jump to 32 chunks must not lock the tab.
function setRenderDistance(value) {
  const next = clampRenderDistance(value);
  settings.renderDistance = next;
  applyFogForDistance(next);
  syncDistanceControl(next); // keep the slider and its readout honest for any caller
  world.updateChunks(camera.position.x, camera.position.z, CHUNK_STREAM_BUDGET);
  saveSettings();
  return next;
}

const controls = new PointerLockControls(camera, renderer.domElement);
const hotbar = new Hotbar();
const player = new Player(camera, world, controls, hotbar);

// Block highlight wireframe
// Slightly larger than the cube so it reads as a marker instead of the block's own
// silhouette, and drawn without a depth test: depth-tested, this wireframe loses to
// the very block it wraps and nothing gets painted at all.
const highlightGeo = new THREE.BoxGeometry(1.04, 1.04, 1.04);
const highlightMat = new THREE.LineBasicMaterial({
  color: 0x000000, linewidth: 2, depthTest: false, depthWrite: false,
});
const highlight = new THREE.LineSegments(new THREE.EdgesGeometry(highlightGeo), highlightMat);
highlight.visible = false;
highlight.renderOrder = 13;
scene.add(highlight);

// Crosshair face marker: until a click arms a selection, the square sits *on* the face
// being aimed at, which says both which cube and which side of it is targeted. Inset
// into the face so it reads against the texture instead of merging with the block edge.
const faceMarker = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.PlaneGeometry(0.9, 0.9)),
  new THREE.LineBasicMaterial({ color: 0x000000, depthTest: false, depthWrite: false }),
);
faceMarker.visible = false;
faceMarker.renderOrder = 13;
scene.add(faceMarker);
const PLANE_FACES_Z = new THREE.Vector3(0, 0, 1);   // PlaneGeometry's own normal
const aimNormal = new THREE.Vector3();

function showFaceMarker(hit) {
  aimNormal.set(hit.nx, hit.ny, hit.nz);
  if (aimNormal.lengthSq() === 0) {
    // The eye sits inside a solid cube: no face was ever crossed to get there.
    faceMarker.visible = false;
    return;
  }
  faceMarker.position.set(
    hit.x + 0.5 + hit.nx * 0.52,
    hit.y + 0.5 + hit.ny * 0.52,
    hit.z + 0.5 + hit.nz * 0.52,
  );
  faceMarker.quaternion.setFromUnitVectors(PLANE_FACES_Z, aimNormal);
  faceMarker.visible = true;
}

// ==================== TWO-STAGE CUBOID SELECTION ====================
// First click marks the anchor cube; the wheel stretches the far corner along the
// view, looking around swings it. The second click of the same button fills (left)
// or empties (right) the cuboid spanned by the two corners — both included.
const MAX_SELECTION_DEPTH = 64;      // blocks the wheel can push the far corner out
const MAX_SELECTION_CELLS = 32768;   // refuses a box big enough to stall the mesher

const selection = {
  active: false,
  mode: 'create',   // 'create' | 'delete'
  anchor: null,     // { x, y, z } of the marked cube
  hit: null,        // raw raycast behind the anchor, so switching buttons can re-mark
  depth: 0,         // blocks in front of the eye where the crosshair corner sits
  stretched: false, // the wheel has moved the far corner since the box was armed
  status: '',       // last HUD warning (oversized box, nothing aimed at)
};

const selectionFill = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, depthWrite: false }),
);
const selectionOutline = new THREE.LineSegments(
  new THREE.EdgesGeometry(selectionFill.geometry),
  // Same reason as the highlight: depth-tested lines never paint over solid terrain.
  new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false }),
);
const selectionPreview = new THREE.Group();
selectionPreview.add(selectionFill, selectionOutline);
selectionPreview.visible = false;
// renderOrder lives on the drawables, not the group.
selectionFill.renderOrder = 11;
selectionOutline.renderOrder = 12;
scene.add(selectionPreview);

const selectionHint = document.getElementById('selection-hint');
let lastHintText = null;

function viewDirection() {
  return camera.getWorldDirection(new THREE.Vector3(0, 0, -1));
}

// The far corner sits under the crosshair: it is the cell `depth` blocks in front of
// the eye along the view, not a fixed arm off the anchor. Looking around therefore
// resizes the cuboid instead of swinging it, and empty space stays selectable.
function selectionCorner() {
  const dir = viewDirection();
  const p = camera.position;
  return {
    x: Math.floor(p.x + dir.x * selection.depth),
    y: Math.floor(p.y + dir.y * selection.depth),
    z: Math.floor(p.z + dir.z * selection.depth),
  };
}

function selectionBounds() {
  const a = selection.anchor;
  const b = selectionCorner();
  const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) };
  const max = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) };
  return {
    min,
    max,
    cells: (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1),
  };
}

// The far corner has to start inside the marked cube, so the box opens as exactly that
// one cube. The view ray's chord through the cell is taken exactly (slab test): seeding
// from the entry distance instead rounds onto the wrong side of a boundary, which opened
// the box one cube too wide on a grazing aim — and put the corner past the marked cube
// whenever that cube sits *before* the hit along the ray (creating on the aimed face).
function seedSelectionDepth(cell, entryT) {
  const dir = viewDirection();
  const p = camera.position;
  let lo = 0.05, hi = Infinity;
  const axes = [[p.x, dir.x, cell.x], [p.y, dir.y, cell.y], [p.z, dir.z, cell.z]];
  for (const [origin, d, c] of axes) {
    if (d === 0) continue;                    // running along this axis: the slab never cuts the chord
    const tIn = (c - origin) / d;
    const tOut = (c + 1 - origin) / d;
    lo = Math.max(lo, Math.min(tIn, tOut));
    hi = Math.min(hi, Math.max(tIn, tOut));
  }
  if (!Number.isFinite(hi) || hi <= lo) return entryT + 0.5;   // tangential graze
  return lo + (hi - lo) * 0.5;
}

// Which cube a click marks for a given mode, from the cube the ray hit: creating grows
// out of the aimed face, digging takes the solid cube the face belongs to.
function cellForHit(hit, mode) {
  if (mode !== 'create') return { x: hit.x, y: hit.y, z: hit.z };
  const ahead = { x: hit.x + hit.nx, y: hit.y + hit.ny, z: hit.z + hit.nz };
  if (ahead.y >= 0 && ahead.y < CHUNK_HEIGHT && !world.isSolid(ahead.x, ahead.y, ahead.z)) return ahead;
  return { x: hit.x, y: hit.y, z: hit.z };
}

function beginSelection(mode) {
  const hit = raycastVoxel(camera.position, viewDirection(), 8);
  if (!hit) {
    selection.status = 'Aucun cube visé';
    return false;
  }
  selection.active = true;
  selection.mode = mode;
  selection.hit = hit;
  selection.anchor = cellForHit(hit, mode);
  selection.depth = seedSelectionDepth(selection.anchor, hit.t);
  selection.stretched = false;
  selection.status = '';
  return true;
}

function cancelSelection() {
  selection.active = false;
  selection.anchor = null;
  selection.hit = null;
  selection.depth = 0;
  selection.stretched = false;
  selection.status = '';
}

// notches > 0 drags the crosshair corner farther from the eye, < 0 pulls it back.
function adjustSelectionDepth(notches) {
  if (!selection.active) return false;
  const next = Math.min(MAX_SELECTION_DEPTH, Math.max(0, selection.depth + notches));
  if (next !== selection.depth) {
    selection.depth = next;
    selection.stretched = true;
  }
  return true;
}

function commitSelection() {
  if (!selection.active) return false;
  const creating = selection.mode === 'create';
  const blockId = player.selectedBlock;
  const { min, max, cells } = selectionBounds();

  if (cells > MAX_SELECTION_CELLS) {
    selection.status = `Trop grand : ${cells} cubes (max ${MAX_SELECTION_CELLS})`;
    return false;
  }

  const edits = [];
  for (let x = min.x; x <= max.x; x++) {
    for (let y = min.y; y <= max.y; y++) {
      if (y < 0 || y >= CHUNK_HEIGHT) continue;
      for (let z = min.z; z <= max.z; z++) {
        // Never entomb the player, same rule as single-block placement.
        if (creating && player.intersectsBlock(x, y, z)) continue;
        edits.push([x, y, z, creating ? blockId : BLOCK.AIR]);
      }
    }
  }

  world.setBlocksBulk(edits);
  cancelSelection();
  return true;
}

// Second click of the same button applies the box; the other button re-arms the
// marked cube for the opposite operation instead of losing the anchor.
function clickSelection(mode) {
  if (!selection.active) return beginSelection(mode);
  if (selection.mode === mode) return commitSelection();
  selection.mode = mode;
  // Each mode marks its own cube — creating on the aimed face, digging the solid cube
  // itself. Carrying the previous mode's anchor over would act one cube off the block
  // under the crosshair. A box nobody stretched yet reopens on its own marked cube;
  // once the wheel moved the corner, that stretch is kept as the player left it.
  if (selection.hit) {
    selection.anchor = cellForHit(selection.hit, mode);
    if (!selection.stretched) selection.depth = seedSelectionDepth(selection.anchor, selection.hit.t);
  }
  return true;
}

function updateSelectionHud() {
  let text = null;
  if (selection.active) {
    const { min, max, cells } = selectionBounds();
    const verb = selection.mode === 'create' ? 'Créer' : 'Supprimer';
    text = `${verb} ${min.x},${min.y},${min.z} → ${max.x},${max.y},${max.z}`
      + ` · ${cells} cubes · croix = 2ᵉ cube · molette ±1 (max ${MAX_SELECTION_DEPTH})`
      + ` · 2e clic applique · clic milieu annule`
      + (selection.status ? ` · ${selection.status}` : '');
  } else if (selection.status) {
    // A refused click (nothing aimed at) still has to say why.
    text = selection.status;
  }
  if (text === lastHintText) return;
  lastHintText = text;
  if (text === null) {
    selectionHint.style.display = 'none';
    selectionHint.textContent = '';
    return;
  }
  selectionHint.textContent = text;
  selectionHint.classList.toggle('delete', selection.active && selection.mode === 'delete');
  selectionHint.style.display = 'block';
}

// Paints the pending cuboid and keeps the marked cube outlined.
function updateSelectionVisuals() {
  if (!selection.active) {
    selectionPreview.visible = false;
    return false;
  }
  const { min, max } = selectionBounds();
  const w = max.x - min.x + 1;
  const h = max.y - min.y + 1;
  const d = max.z - min.z + 1;
  selectionPreview.position.set(min.x + w / 2, min.y + h / 2, min.z + d / 2);
  // Nipped in a hair so the white frame sits inside the black square that marks the
  // anchor cube; at identical size the two coincide and only one of them survives.
  selectionPreview.scale.set(w - 0.03, h - 0.03, d - 0.03);
  selectionFill.material.color.setHex(selection.mode === 'create' ? 0x66dd66 : 0xdd5555);
  selectionPreview.visible = true;

  highlight.position.set(selection.anchor.x + 0.5, selection.anchor.y + 0.5, selection.anchor.z + 0.5);
  highlight.visible = true;
  faceMarker.visible = false;
  return true;
}

// Esc or alt-tab hands the pointer back: a half-made box must not stay armed for the
// next click, so losing the lock drops the pending selection.
controls.addEventListener('unlock', () => {
  if (selection.active) cancelSelection();
});

// ==================== INPUT HANDLING ====================
const keys = {};
// PointerLockControls reads the very same object, so no polling timer is needed.
controls.keys = keys;

const blocker = document.getElementById('blocker');

// requestPointerLock rejects when there is no recent user activation; that must
// not surface as an uncaught promise error. Callers get the promise back so they
// can fall back to the start screen as soon as it is refused.
function lockPointer() {
  try {
    const result = renderer.domElement.requestPointerLock();
    if (result && typeof result.catch === 'function') result.catch(() => {});
    return result && typeof result.then === 'function' ? result : null;
  } catch (e) {
    /* pointer lock unavailable right now */
    return null;
  }
}

const inventory = new Inventory(hotbar, controls, blocker, keys, lockPointer);

window.addEventListener('keydown', (e) => {
  // A focused slider owns its arrow keys; do not turn them into player movement.
  const target = e.target;
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;

  keys[e.code] = true;

  if (e.code === 'KeyE') {
    inventory.toggle();
    return;
  }
  if (e.code === 'Escape') {
    if (selection.active) {
      cancelSelection();
      return;
    }
    if (inventory.isOpen()) {
      e.preventDefault();
      inventory.hide();
    }
    return;
  }
  // While the palette is up the cursor belongs to the UI, not the world.
  if (inventory.isOpen()) return;

  // Number keys for hotbar
  if (e.code >= 'Digit1' && e.code <= 'Digit9') {
    hotbar.select(parseInt(e.code.replace('Digit', ''), 10) - 1);
  }
  // F key for fly mode
  if (e.code === 'KeyF') {
    player.flyMode = !player.flyMode;
    player.velocity.y = 0;
    updateInfo();
  }
  // T for texture panel
  if (e.code === 'KeyT') {
    toggleTexturePanel();
  }
  // R for reset position
  if (e.code === 'KeyR') {
    player.respawn();
    updateInfo();
  }
  // +/- : assiette de flottaison. Sur AZERTY comme sur QWERTY, la touche du haut de
  // rangée produit `Equal` pour « + » (avec Majuscule) et `Minus` pour « - ».
  if (e.code === 'Equal' || e.code === 'NumpadAdd') {
    player.regleAssiette(ASSIETTE_PAS);
    updateWaterHud(true);
    return;
  }
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
    player.regleAssiette(-ASSIETTE_PAS);
    updateWaterHud(true);
    return;
  }
});
window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
});

// Wheel: stretches the pending cuboid, otherwise changes the held block.
document.addEventListener('wheel', (e) => {
  if (!controls.isLocked) return;
  if (adjustSelectionDepth(e.deltaY < 0 ? 1 : -1)) return;
  hotbar.cycle(e.deltaY > 0 ? 1 : -1);
});

// Voxel DDA raycast: march through the voxel grid from a point along a direction.
// Returns { x, y, z, nx, ny, nz, t } of the first solid block hit, or null; t is how
// far along the (normalised) ray that block was entered.
function raycastVoxel(origin, dir, maxDist) {
  const ox = origin.x, oy = origin.y, oz = origin.z;
  const dx = dir.x, dy = dir.y, dz = dir.z;

  let bx = Math.floor(ox), by = Math.floor(oy), bz = Math.floor(oz);

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;

  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

  const fracX = ox - Math.floor(ox);
  const fracY = oy - Math.floor(oy);
  const fracZ = oz - Math.floor(oz);

  let tMaxX = tDeltaX === Infinity ? Infinity : (dx > 0 ? (1 - fracX) : fracX) * tDeltaX;
  let tMaxY = tDeltaY === Infinity ? Infinity : (dy > 0 ? (1 - fracY) : fracY) * tDeltaY;
  let tMaxZ = tDeltaZ === Infinity ? Infinity : (dz > 0 ? (1 - fracZ) : fracZ) * tDeltaZ;

  let nx = 0, ny = 0, nz = 0;
  let t = 0;

  while (t <= maxDist) {
    if (world.isSolid(bx, by, bz)) {
      return { x: bx, y: by, z: bz, nx, ny, nz, t };
    }

    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      bx += stepX; t = tMaxX; tMaxX += tDeltaX;
      nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      by += stepY; t = tMaxY; tMaxY += tDeltaY;
      nx = 0; ny = -stepY; nz = 0;
    } else {
      bz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ;
      nx = 0; ny = 0; nz = -stepZ;
    }
  }
  return null;
}

// Block interaction: left button builds a cuboid, right button digs one out. The
// first click of a button marks the anchor cube, its second click applies the box.
document.addEventListener('mousedown', (e) => {
  if (!controls.isLocked) return;
  if (e.button === 1) {
    e.preventDefault();
    cancelSelection();
    return;
  }
  const mode = e.button === 0 ? 'create' : e.button === 2 ? 'delete' : null;
  if (mode) clickSelection(mode);
});

document.addEventListener('contextmenu', (e) => e.preventDefault());

// ==================== UI ====================
const info = document.getElementById('info');
function updateInfo() {
  const pos = camera.position;
  const blockName = BLOCK_INFO[player.selectedBlock]?.name || 'Unknown';
  info.textContent = `
    XYZ: ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}
    Bloc: ${blockName}
    Mode: ${player.flyMode ? 'Vol (F)' : 'Marche'}
    FPS: ${fps}
  `;
}

// ==================== TEXTURE PANEL ====================
const texturePanel = document.getElementById('texture-panel');
const toggleBtn = document.getElementById('toggle-ui');
const closePanel = document.getElementById('close-panel');
const textureUpload = document.getElementById('texture-upload');
const texturePick = document.getElementById('texture-pick');
const textureHint = document.getElementById('texture-hint');
const textureList = document.getElementById('texture-list');

function toggleTexturePanel() {
  texturePanel.style.display = texturePanel.style.display === 'block' ? 'none' : 'block';
}

toggleBtn.addEventListener('click', toggleTexturePanel);
closePanel.addEventListener('click', toggleTexturePanel);

function rebuildVisibleChunks() {
  const pcx = Math.floor(camera.position.x / CHUNK_SIZE);
  const pcz = Math.floor(camera.position.z / CHUNK_SIZE);
  // Repainting is only for the custom-texture panel; at 32 chunks a full repaint
  // would block for tens of seconds to change a tile nobody can see that far out.
  const radius = Math.min(settings.renderDistance, 12);
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      world.rebuildChunk(pcx + dx, pcz + dz);
    }
  }
}

// ==================== CUSTOM TEXTURES ====================
// Two hosts share this UI: the Express dev server (GET /textures, POST
// /upload-texture) and the Tauri desktop build, which has no server at all and
// keeps uploaded images in its own application-data folder through Rust commands.
// The `tauriGlobal`/`tauriCore` handles come from the constants block above.
// Absent from a plain browser, and from a desktop build whose plugin failed to
// register; either way the file input below stays the fallback.
const tauriDialog = tauriGlobal && tauriGlobal.dialog ? tauriGlobal.dialog : null;

async function imageSourceFromBytes(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  if (typeof bitmap.close === 'function') bitmap.close();
  return canvas;
}

const textureStore = tauriCore
  ? {
      mode: 'desktop',
      async list() {
        const names = await tauriCore.invoke('list_textures');
        return names.map((name) => ({
          name,
          source: () => tauriCore.invoke('read_texture', { name }).then((bytes) => imageSourceFromBytes(new Uint8Array(bytes))),
        }));
      },
      async save() {
        // WebView2 hands back a File with no usable path, so the desktop build
        // asks the OS for the files and lets Rust copy them into the store.
        if (!tauriDialog) throw new Error('dialogue natif indisponible');
        const picked = await tauriDialog.open({
          multiple: true,
          title: 'Choisir des textures',
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
        });
        if (!picked) return 0;
        return tauriCore.invoke('import_textures', { paths: Array.isArray(picked) ? picked : [picked] });
      },
    }
  : {
      mode: 'web',
      async list() {
        const res = await fetch('/textures');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const files = await res.json();
        return files.map((f) => ({
          name: f.filename,
          source: () => fetch(f.url).then((r) => r.blob()).then(imageSourceFromBytes),
        }));
      },
      async save(files) {
        const form = new FormData();
        for (const file of files) form.append('textures', file);
        const res = await fetch('/upload-texture', { method: 'POST', body: form });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return files.length;
      },
    };

// Paints the chosen tile over the atlas tiles of the held block; clicking the same
// entry again brings the procedural tile back.
function bindTextureItem(item, entry) {
  item.addEventListener('click', async () => {
    const blockId = player.selectedBlock;
    if (item.classList.contains('selected')) {
      if (world.restoreBlockTexture(blockId)) {
        item.classList.remove('selected');
        rebuildVisibleChunks();
        hotbar.render();
        inventory.repaintIcons();
      }
      return;
    }
    try {
      const source = await entry.source();
      if (world.setBlockTexture(blockId, source)) {
        document.querySelectorAll('.texture-item.selected').forEach((el) => el.classList.remove('selected'));
        item.classList.add('selected');
        rebuildVisibleChunks();
        hotbar.render();
        inventory.repaintIcons();
      }
    } catch (e) {
      console.warn('image illisible:', entry.name, e);
    }
  });
}

async function loadTextures() {
  let entries;
  try {
    entries = await textureStore.list();
  } catch (e) {
    console.warn('Could not load textures:', e);
    return;
  }
  textureList.innerHTML = '';
  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = 'texture-item';
    const img = document.createElement('img');
    img.alt = '';
    entry.source().then((canvas) => { img.src = canvas.toDataURL('image/png'); }).catch(() => {});
    const label = document.createElement('span');
    label.textContent = entry.name;
    item.appendChild(img);
    item.appendChild(label);
    bindTextureItem(item, entry);
    textureList.appendChild(item);
  }
}

textureUpload.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;
  try {
    await textureStore.save(files);
    await loadTextures();
  } catch (err) {
    console.error('Upload failed:', err);
  } finally {
    textureUpload.value = '';
  }
});

// The desktop host swaps the file input for the OS picker; the hint doubles as
// the only feedback channel a modal dialog leaves behind.
async function importFromDisk() {
  texturePick.disabled = true;
  const steady = texturePick.dataset.hint || textureHint.textContent;
  try {
    const count = await textureStore.save();
    textureHint.textContent = count ? `${count} image(s) importée(s)` : 'aucune image choisie';
    await loadTextures();
  } catch (err) {
    console.error('Import failed:', err);
    textureHint.textContent = `import impossible : ${err.message}`;
  } finally {
    texturePick.disabled = false;
    setTimeout(() => { textureHint.textContent = steady; }, 2500);
  }
}

if (textureStore.mode === 'desktop') {
  textureUpload.style.display = 'none';
  texturePick.hidden = false;
  texturePick.dataset.hint = 'Les images sont copiées dans le dossier de l’application';
  textureHint.textContent = texturePick.dataset.hint;
  texturePick.addEventListener('click', importFromDisk);
}

loadTextures();

// ==================== START BUTTON ====================
const startBtn = document.getElementById('start-btn');

// ---- view-depth control on the start screen ----
const distanceInput = document.getElementById('render-distance');
const distanceValue = document.getElementById('render-distance-value');

function describeRenderDistance(radius) {
  const blocks = radius * CHUNK_SIZE;
  const chunks = (radius * 2 + 1) ** 2;
  const base = `${radius} chunk${radius > 1 ? 's' : ''} · ~${blocks} blocs · ${chunks} tronçons`;
  return chunks > 400 ? `${base} · chargement progressif` : base;
}

function syncDistanceControl(radius) {
  distanceInput.value = String(radius);
  distanceValue.textContent = describeRenderDistance(radius);
}

distanceInput.min = String(MIN_RENDER_DISTANCE);
distanceInput.max = String(MAX_RENDER_DISTANCE);
syncDistanceControl(settings.renderDistance);
distanceInput.addEventListener('input', () => setRenderDistance(distanceInput.value));

startBtn.addEventListener('click', () => {
  if (!worldReady) return;   // stays disabled until the save has been read back
  inventory.hide();
  blocker.style.display = 'none';
  // Solid ground under the feet before the pointer is taken; the rest keeps streaming.
  world.updateChunks(camera.position.x, camera.position.z, WORLD_BOOT_BUDGET);
  // Without the lock there is no mouse look, so keep the start screen up rather
  // than dropping the player into a game they cannot steer.
  const pending = lockPointer();
  if (pending && typeof pending.catch === 'function') {
    pending.catch(() => { blocker.style.display = 'flex'; });
  }
});

// Opening the inventory releases the pointer on purpose: only the start screen
// may cover the game in that case.
controls.addEventListener('unlock', () => {
  if (inventory.isOpen()) return;
  blocker.style.display = 'flex';
});

controls.addEventListener('lock', () => {
  blocker.style.display = 'none';
  // Coming back to the game is a natural moment to settle the disk: whatever the
  // player just did is worth keeping before they walk somewhere new.
  flushWorldSave({ force: true });
});

// ==================== WORLD SAVES ====================
// The terrain regenerates from WORLD_SEEDS, so the disk carries only the player's
// diff and their position. Writes are throttled to AUTOSAVE_INTERVAL_MS and only
// happen when something actually changed, which keeps them off the frame budget.
const SAVE_PARAMS = new URLSearchParams(window.location.search);
const SAVE_SLOT = SAVE_PARAMS.get('world') || 'default';
const saveStore = createSaveStore({ slot: SAVE_SLOT, tauriCore });

// Deux identifiants par monde : le slot, qui est un nom de fichier sûr et sert à
// l'adressage, et le nom d'affichage que le joueur choisit librement. Un monde tout
// juste créé n'a pas encore de fichier sur le disque : son nom transite donc par
// l'URL jusqu'au premier enregistrement.
let worldName = cleanWorldName(SAVE_PARAMS.get('name'));

/** Ce qu'on montre au joueur : le nom qu'il a choisi, sinon le nom de fichier. */
function worldLabel(meta) {
  const raw = meta ? meta.name : worldName;
  return cleanWorldName(raw) || (meta ? meta.slot : saveStore.slot);
}

const worldStatusEl = document.getElementById('world-status');
const worldListEl = document.getElementById('world-list');
const worldNewBtn = document.getElementById('world-new');
const worldResetBtn = document.getElementById('world-reset');
const worldNameInput = document.getElementById('world-name');
const worldRenameBtn = document.getElementById('world-rename');
const saveStatusEl = document.getElementById('save-status');

let worldReady = false;
let saveDirty = false;      // an edit happened since the last write
let writingSave = false;    // one request in flight, avoids piling up writes
let lastWriteAt = -Infinity;
let writtenEdits = -1;      // diff size as of the last successful write
const writtenPos = new THREE.Vector3(NaN, NaN, NaN);
let lastSaveHudText = null;

// Any block written by the player has to reach the disk eventually.
world.onEdit = () => { saveDirty = true; };

function markWorldWritten() {
  saveDirty = false;
  writtenEdits = world.modifiedBlocks.size;
  writtenPos.copy(camera.position);
}

// Cheap enough to run every frame: no allocation, no serialisation.
function needsWorldSave() {
  if (saveDirty) return true;
  if (world.modifiedBlocks.size !== writtenEdits) return true;
  if (!Number.isFinite(writtenPos.x)) return true;
  const dx = camera.position.x - writtenPos.x;
  const dy = camera.position.y - writtenPos.y;
  const dz = camera.position.z - writtenPos.z;
  return dx * dx + dy * dy + dz * dz > PLAYER_SAVE_MOVE_SQ;
}

async function flushWorldSave({ force = false, beacon = false } = {}) {
  if (!worldReady) return false;
  // `force` lifts the throttle (unload, world switch), it never invents work: an
  // unchanged world is left alone on the disk.
  if (!needsWorldSave()) return false;
  const now = performance.now();
  if (!force && now - lastWriteAt < AUTOSAVE_INTERVAL_MS) return false;
  const text = encodeSave({ seed: WORLD_SEEDS, name: worldName, player: player.saveState(), edits: world.modifiedBlocks });

  // On the way out the response is worthless, so prefer the one transport the
  // browser promises to deliver after the page is gone.
  if (beacon && saveStore.mode === 'web' && saveStore.saveSoon(text)) {
    lastWriteAt = now;
    markWorldWritten();
    return true;
  }
  if (writingSave) return false;

  writingSave = true;
  lastWriteAt = now;
  try {
    await saveStore.save(text);
    markWorldWritten();
    return true;
  } catch (e) {
    console.warn('Sauvegarde impossible :', e);
    saveDirty = true; // retried on the next tick instead of being lost
    return false;
  } finally {
    writingSave = false;
  }
}

function describeAge(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'à l’instant';
  const s = Math.round(ms / 1000);
  if (s < 60) return `il y a ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

function updateSaveHud() {
  if (!saveStatusEl) return;
  let text;
  if (!worldReady) text = '💾 chargement…';
  else if (writingSave) text = '💾 écriture…';
  else if (needsWorldSave()) text = '💾 en attente';
  else text = Number.isFinite(writtenPos.x) ? `💾 sauvegardé ${describeAge(Date.now() - savedAtLocal)}` : '💾 —';
  if (text === lastSaveHudText) return;
  lastSaveHudText = text;
  saveStatusEl.textContent = text;
}

let savedAtLocal = Date.now();

function setWorldStatus(text) {
  if (worldStatusEl) worldStatusEl.textContent = text;
}

async function readStoredWorld() {
  let timer = null;
  try {
    const text = await Promise.race([
      saveStore.load(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`délai de ${WORLD_LOAD_TIMEOUT_MS} ms dépassé`)), WORLD_LOAD_TIMEOUT_MS);
      }),
    ]);
    // AIR (0) is a legitimate stored value: a dug-out block has to come back as a
    // hole, so the block-id check cannot treat 0 as "unknown".
    return decodeSave(text, {
      isValidBlock: (id) => id === BLOCK.AIR || !!BLOCK_INFO[id],
      height: CHUNK_HEIGHT,
    });
  } catch (e) {
    // A broken or unreadable save must never lock the player out of the game.
    console.warn('Sauvegarde ignorée, monde neuf :', e);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function bootWorld() {
  startBtn.disabled = true;
  setWorldStatus('Chargement du monde…');
  let saved = null;
  try {
    saved = await readStoredWorld();
    if (saved) {
      // Un nom passé par l'URL (création ou renommage à l'instant) prime : c'est
      // l'intention la plus récente, le fichier peut encore porter l'ancienne.
      if (!worldName) worldName = cleanWorldName(saved.name);
      world.applyEdits(saved.edits);
      player.restoreFromSave(saved.player);
      savedAtLocal = saved.savedAt || Date.now();
    } else {
      player.placeAtSpawn();
      world.updateChunks(camera.position.x, camera.position.z, WORLD_BOOT_BUDGET);
      savedAtLocal = Date.now();
    }
  } catch (e) {
    // Replaying a save must never be able to lock the player out of the game: fall
    // back to a fresh world under the feet and keep playing.
    console.warn('Reprise impossible, monde neuf :', e);
    saved = null;
    player.placeAtSpawn();
  } finally {
    worldReady = true;
    startBtn.disabled = false;
  }
  if (worldNameInput && !worldNameInput.value) worldNameInput.value = worldName || '';
  setWorldStatus(saved
    ? `Monde « ${worldLabel()} » retrouvé · ${saved.edits.size} bloc${saved.edits.size > 1 ? 's' : ''} modifié${saved.edits.size > 1 ? 's' : ''} · ${describeAge(Date.now() - savedAtLocal)}`
    : `Nouveau monde « ${worldLabel()} » · rien sur le disque pour l’instant`);
  refreshWorldList();
}

// ---- world picker on the start screen ----
function describeWorldMeta(meta) {
  const cells = meta.cells ?? meta.edits ?? 0;
  const where = meta.player
    ? ` · en ${Math.round(meta.player.x)}, ${Math.round(meta.player.y)}, ${Math.round(meta.player.z)}`
    : '';
  return `${cells} bloc${cells > 1 ? 's' : ''} modifié${cells > 1 ? 's' : ''}${where} · ${meta.savedAt ? describeAge(Date.now() - meta.savedAt) : 'inconnu'}`;
}

let armedSlot = null;   // a delete only fires on the second click of its own button

function renderWorldList(worlds) {
  if (!worldListEl) return;
  worldListEl.innerHTML = '';
  if (worlds.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'world-empty';
    empty.textContent = 'Aucun monde enregistré pour l’instant';
    worldListEl.appendChild(empty);
    return;
  }
  for (const meta of worlds) {
    const li = document.createElement('li');
    li.className = 'world-item';
    if (meta.slot === saveStore.slot) li.classList.add('active');

    const pick = document.createElement('button');
    pick.className = 'world-pick';
    pick.dataset.slot = meta.slot;
    // Le nom choisi par le joueur, avec le nom de fichier en repli et en infobulle.
    pick.textContent = worldLabel(meta);
    pick.title = `Jouer dans ce monde · fichier ${meta.slot}`;

    const info = document.createElement('span');
    info.className = 'world-meta';
    info.textContent = describeWorldMeta(meta);

    const del = document.createElement('button');
    del.className = 'world-del';
    del.dataset.slot = meta.slot;
    del.textContent = armedSlot === meta.slot ? 'confirmer ?' : '✕';
    del.title = armedSlot === meta.slot
      ? 'Recliquer pour effacer définitivement ce monde'
      : 'Effacer ce monde';

    li.append(pick, info, del);
    worldListEl.appendChild(li);
  }
}

let cachedWorlds = [];   // last listing, reused to repaint without refetching

async function refreshWorldList() {
  let worlds = [];
  try {
    worlds = await saveStore.list();
  } catch (e) {
    console.warn('Liste des mondes indisponible :', e);
  }
  worlds.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  cachedWorlds = worlds;
  renderWorldList(worlds);
}

/**
 * Nom de fichier du prochain monde. Le nom saisi guide le nom de fichier ; s'il est
 * déjà pris, un numéro le distingue plutôt que d'écraser un monde existant.
 */
function nextSlotName(rawName) {
  const taken = new Set(cachedWorlds.map((w) => w.slot));
  const base = slugify(rawName);
  if (base && !taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = (base ? `${base}-${i}` : `monde-${i}`).slice(0, 32);
    if (!taken.has(candidate)) return candidate;
  }
}

// Switching worlds happens from the start screen only: saving where we are, then
// reloading with the other slot is far safer than swapping a live world under the
// meshes, the player and the atlas.
async function openWorld(slot) {
  if (slot === saveStore.slot) return;
  await flushWorldSave({ force: true });
  const url = new URL(window.location.href);
  url.searchParams.set('world', slot);
  window.location.assign(url.toString());
}

async function deleteWorld(slot) {
  armedSlot = null;
  if (slot === saveStore.slot) {
    // Wiping the world being played is a reset, not just a file deletion: the
    // in-memory diff has to go too or the next autosave writes it straight back.
    await resetActiveWorld();
    return;
  }
  try {
    await saveStore.clear(slot);
  } catch (e) {
    console.warn('Suppression impossible :', e);
    return;
  }
  refreshWorldList();
}

// "Réinitialiser": clears the diff in memory and on disk, then puts the player back
// at the spawn point. The next autosave records the virgin world again.
async function resetActiveWorld() {
  try {
    await saveStore.clear();
  } catch (e) {
    console.warn('Effacement impossible :', e);
  }
  world.clearEdits();
  player.respawn();
  saveDirty = false;
  writtenEdits = 0;
  writtenPos.set(NaN, NaN, NaN);
  savedAtLocal = Date.now();
  armedSlot = null;
  setWorldStatus(`Monde « ${worldLabel()} » réinitialisé`);
  refreshWorldList();
}

/**
 * Donne un nouveau nom d'affichage au monde en jeu. Si le nom saisi se traduit par un
 * autre nom de fichier, le document est écrit sous le nouveau puis l'ancien est
 * supprimé : le joueur ne voit jamais deux fichiers pour un seul monde.
 */
async function renameWorld(rawName) {
  const name = cleanWorldName(rawName);
  if (!name) {
    setWorldStatus('Ce monde n’a pas encore de nom : écris-en un dans le champ.');
    return false;
  }
  const target = slugify(name);
  if (!target) {
    setWorldStatus(`« ${name} » ne donne aucun caractère exploitable comme nom de fichier.`);
    return false;
  }
  // Le listing sert à refuser d'écraser un monde existant : il doit être frais, sinon
  // un monde créé pendant la partie échapperait au contrôle.
  await refreshWorldList();
  if (target !== saveStore.slot && cachedWorlds.some((w) => w.slot === target)) {
    setWorldStatus(`Impossible : un monde occupe déjà le fichier « ${target} ».`);
    return false;
  }

  worldName = name;
  if (worldNameInput) worldNameInput.value = name;
  try {
    // Le nom doit rejoindre le disque même si le diff n'a pas bougé depuis la
    // dernière écriture : sans ce drapeau, needsWorldSave() laisserait le fichier
    // porter l'ancien nom.
    saveDirty = true;
    await flushWorldSave({ force: true });
    if (target !== saveStore.slot) {
      // setNameInSave garantit le nom même si l'écriture ci-dessus a été ignorée
      // (une sauvegarde en cours, par exemple).
      const text = setNameInSave(await saveStore.load(), name);
      if (!text) {
        setWorldStatus('Renommage impossible : le contenu du monde est illisible.');
        return false;
      }
      await saveStore.save(text, target);
      await saveStore.clear();
      setWorldStatus(`Monde renommé « ${name} »`);
      const url = new URL(window.location.href);
      url.searchParams.set('world', target);
      url.searchParams.set('name', name);
      window.location.assign(url.toString());
      return true;
    }
  } catch (e) {
    console.warn('Renommage impossible :', e);
    setWorldStatus(`Renommage impossible : ${e.message}`);
    return false;
  }
  setWorldStatus(`Monde renommé « ${name} »`);
  refreshWorldList();
  return true;
}

if (worldListEl) {
  worldListEl.addEventListener('click', (e) => {
    const target = e.target.closest('button');
    if (!target) return;
    const slot = target.dataset.slot;
    if (!slot) return;
    if (target.classList.contains('world-pick')) {
      openWorld(slot);
    } else if (armedSlot === slot) {
      deleteWorld(slot);
    } else {
      armedSlot = slot;
      renderWorldList(cachedWorlds);
      const doomed = cachedWorlds.find((w) => w.slot === slot);
      setWorldStatus(`Cliquer encore pour effacer « ${worldLabel(doomed || { slot })} »`);
      setTimeout(() => {
        if (armedSlot === slot) {
          armedSlot = null;
          renderWorldList(cachedWorlds);
        }
      }, 4000);
    }
  });
}

if (worldNewBtn) {
  worldNewBtn.addEventListener('click', async () => {
    await flushWorldSave({ force: true });
    // Le nom saisi devient à la fois le nom affiché et, s'il s'y prête, le nom de
    // fichier. Il voyage dans l'URL parce que le monde n'a pas encore de disque.
    const typed = cleanWorldName(worldNameInput ? worldNameInput.value : '');
    const fresh = nextSlotName(typed);
    const url = new URL(window.location.href);
    url.searchParams.set('world', fresh);
    if (typed) url.searchParams.set('name', typed);
    else url.searchParams.delete('name');
    window.location.assign(url.toString());
  });
}

if (worldRenameBtn) {
  worldRenameBtn.addEventListener('click', () => renameWorld(worldNameInput ? worldNameInput.value : ''));
}

if (worldNameInput) {
  worldNameInput.placeholder = worldName || 'Nom du monde';
  worldNameInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    renameWorld(worldNameInput.value);
  });
}

if (worldResetBtn) {
  let armedResetAt = 0;
  const original = worldResetBtn.textContent;
  worldResetBtn.addEventListener('click', () => {
    const now = Date.now();
    if (now - armedResetAt > 4000) {
      armedResetAt = now;
      worldResetBtn.textContent = 'Confirmer : tout effacer';
      worldResetBtn.classList.add('confirm');
      setTimeout(() => {
        if (Date.now() - armedResetAt >= 4000) {
          worldResetBtn.textContent = original;
          worldResetBtn.classList.remove('confirm');
        }
      }, 4100);
      return;
    }
    armedResetAt = 0;
    worldResetBtn.textContent = original;
    worldResetBtn.classList.remove('confirm');
    resetActiveWorld();
  });
}

// Leaving the tab, closing the window, or losing focus are the moments where an
// unsaved diff would actually be lost.
window.addEventListener('pagehide', () => flushWorldSave({ force: true, beacon: true }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushWorldSave({ force: true, beacon: true });
});

bootWorld();

// ==================== RESIZE ====================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ==================== GAME LOOP ====================
let lastTime = performance.now();
let fps = 0;
let frameCount = 0;
let fpsTimer = 0;

const underwaterEl = document.getElementById('underwater');
const swimHintEl = document.getElementById('swim-hint');
// La phrase d'accueil du bandeau vient du HTML : elle y reste la source unique.
const SWIM_HINT_BASE = swimHintEl ? swimHintEl.textContent.trim() : '';

// Teinte d'immersion, bandeau de nage et assiette suivent l'état du joueur. Le DOM
// n'est touché qu'au changement, comme pour les autres bandeaux du HUD ; `force` sert
// au réglage clavier, qui doit se lire immédiatement.
let waterHudState = null;
let assietteVue = null;
function updateWaterHud(force) {
  const etat = player.nage ? (player.sousLEau ? 'sous' : 'surface') : 'hors';
  const assiette = Math.round(player.assiette * 10) / 10;
  if (!force && etat === waterHudState && assiette === assietteVue) return;
  waterHudState = etat;
  assietteVue = assiette;
  if (underwaterEl) underwaterEl.classList.toggle('on', etat === 'sous');
  if (swimHintEl) {
    swimHintEl.classList.toggle('on', etat !== 'hors');
    swimHintEl.textContent = etat === 'hors' ? SWIM_HINT_BASE
      : `${SWIM_HINT_BASE} · assiette ${assiette.toFixed(1)} — + pour s'enfoncer, − pour remonter`;
  }
}

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const deltaTime = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  // FPS counter
  frameCount++;
  fpsTimer += deltaTime;
  if (fpsTimer >= 1) {
    fps = frameCount;
    frameCount = 0;
    fpsTimer = 0;
    updateInfo();
  }

  // Nothing simulates before the saved world is back on screen: physics over
  // ungenerated terrain would drop the player through the void, and streaming the
  // spawn area just to teleport away would burn the frame budget for nothing.
  if (!worldReady) {
    renderer.render(scene, camera);
    return;
  }

  flushWorldSave();   // throttled and change-gated inside
  updateSaveHud();

  if (controls.isLocked) {
    player.update(deltaTime);
    world.updateChunks(camera.position.x, camera.position.z, Infinity, CHUNK_FRAME_MS);

    // The pending cuboid owns the cursor while it lasts; otherwise square off the face
    // under the crosshair — which cube and which of its sides a click would start from.
    if (!updateSelectionVisuals()) {
      const dir = new THREE.Vector3(0, 0, -1);
      camera.getWorldDirection(dir);
      const hit = raycastVoxel(camera.position, dir, 8);
      highlight.visible = false;
      if (hit) showFaceMarker(hit);
      else faceMarker.visible = false;
    }
  } else {
    highlight.visible = false;
    faceMarker.visible = false;
    updateSelectionVisuals();
    // Keep filling the world in behind the start screen: a large view depth has to
    // stream in over frames, and the preview is what makes the slider worth having.
    if (world.pendingChunks > 0) {
      world.updateChunks(camera.position.x, camera.position.z, Infinity, CHUNK_FRAME_MS);
    }
  }

  updateSelectionHud();
  updateWaterHud();
  renderer.render(scene, camera);
}

animate();

// Headless test hook: drives physics/input without needing pointer lock.
window.__mc = {
  THREE,
  scene,
  camera,
  renderer,
  world,
  player,
  hotbar,
  inventory,
  controls,
  atlas,
  BLOCK,
  BLOCK_INFO,
  BLOCK_GROUPS,
  ALL_BLOCKS,
  HOTBAR_SIZE,
  settings,
  setRenderDistance,
  MIN_RENDER_DISTANCE,
  MAX_RENDER_DISTANCE,
  DEFAULT_RENDER_DISTANCE,
  CHUNK_STREAM_BUDGET,
  CHUNK_FRAME_MS,
  WORLD_BOOT_BUDGET,
  SETTINGS_STORAGE_KEY,
  keys,
  raycastVoxel,
  highlight,
  faceMarker,
  getTerrainHeight,
  SEA_LEVEL,
  findDrySpawn,
  waterTopAt: (x, z) => terrain.waterTopAt(x, z),
  riverAt: (x, z) => terrain.riverAt(x, z),
  CHUNK_SIZE,
  press(code, down = true) { keys[code] = down; },
  releaseAll() { for (const k of Object.keys(keys)) keys[k] = false; },
  // Drives the real window listeners (E, Escape, digits) instead of poking state.
  keyDown(code) { window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })); },
  keyUp(code) { window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })); },
  look(yawDeg, pitchDeg) {
    camera.rotation.order = 'YXZ';
    camera.rotation.set(THREE.MathUtils.degToRad(pitchDeg ?? 0), THREE.MathUtils.degToRad(yawDeg ?? 0), 0, 'YXZ');
  },
  step(dt = 1 / 60) {
    player.update(dt);
    world.updateChunks(camera.position.x, camera.position.z);
  },
  // Drains the streaming queue synchronously; lets a test assert on a settled world.
  streamAll() {
    let guard = 0;
    while (world.pendingChunks > 0 && guard++ < 500) {
      world.updateChunks(camera.position.x, camera.position.z, 64);
    }
    return world.pendingChunks;
  },
  feetY() { return player.feetY; },
  respawn: () => player.respawn(),
  settle: () => player.settle(),
  // Drives the two-stage cuboid flow exactly the way the mouse buttons do.
  clickCreate: () => clickSelection('create'),
  clickDelete: () => clickSelection('delete'),
  selectionPreview,
  wheelSelection: (notches = 1) => adjustSelectionDepth(notches),
  cancelSelection: () => cancelSelection(),
  selectionBounds: () => (selection.active ? selectionBounds() : null),
  selectionState: () => ({
    active: selection.active,
    mode: selection.mode,
    depth: selection.depth,
    status: selection.status,
    anchor: selection.anchor ? { ...selection.anchor } : null,
  }),
  MAX_SELECTION_DEPTH,
  MAX_SELECTION_CELLS,
  setBlock: (x, y, z, id) => world.setBlock(x, y, z, id),
  // ---- persistence hooks ----
  saveStore,
  SAVE_SLOT,
  WORLD_SEEDS,
  AUTOSAVE_INTERVAL_MS,
  worldReady: () => worldReady,
  flushSave: () => flushWorldSave({ force: true }),
  savePending: () => saveDirty || writingSave || needsWorldSave(),
  editCount: () => world.modifiedBlocks.size,
  resetWorld: () => resetActiveWorld(),
  deleteWorld: (slot) => deleteWorld(slot),
  listWorlds: () => saveStore.list(),
  openWorld: (slot) => openWorld(slot),
  worldName: () => worldName,
  renameWorld: (name) => renameWorld(name),
  // Les plans des bâtiments d'un tronçon (maisons, tours, escaliers) tels que la
  // génération les a calculés — sert aux suites qui vérifient la praticité dans le
  // monde chargé. Un tronçon peut en porter jusqu'à quatre.
  villageAt: (wx, wz) => village.buildingAt(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE)),
  // Ponts et arcs d'un tronçon (tabliers, piles, arcs de triomphe) tels que la
  // génération les a calculés — même principe que `villageAt` pour les bâtiments.
  structuresAt: (wx, wz) => village.structuresAt(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE)),
  // Échelles de la voirie et des ouvrages (espacement des avenues, garde-tête…) pour
  // que les suites recalculent les coordonnées sans les dupliquer.
  villageParams: village.VILLAGE,
  roadKind: (wx, wz) => village.roadKind(wx, wz),
  // Profil de la chaussée : le relief ramené à un cube par colonne, tel que l'escalier
  // de rue est estampé. `roadSurface` donne le niveau posé sur une cellule (max des
  // avenues qui la couvrent, null hors voirie) ; `surfaceAt` répond « sur quoi marche le
  // joueur » en tout point du monde.
  streetLevel: (axis, k, along) => village.streetLevel(axis, k, along),
  roadSurface: (wx, wz, avecOuvrages = true) => village.roadSurface(wx, wz, avecOuvrages),
  surfaceAt: (wx, wz) => village.surfaceAt(wx, wz),
  cityInfluence: (wx, wz) => village.cityInfluence(wx, wz),
  // Zone climatique d'une cellule (`foret`, `plaine`, `desert`), plan de l'arbre qui y
  // prend racine (null sinon) et échelles du module : les suites vérifient la
  // praticabilité de la forêt sans en dupliquer les constantes.
  biomeAt: (wx, wz) => biomes.biomeAt(wx, wz),
  treeAt: (wx, wz) => biomes.treeAt(wx, wz),
  biomeParams: biomes.BIOMES,
  // Cellule tenue par la voirie ou l'emprise d'un bâtiment — ce sur quoi rien ne pousse.
  cellOccupied: (wx, wz) => village.isOccupied(wx, wz),
  // Plan du temple de la maille (i,j) et temples recoupant une fenêtre : les suites
  // vérifient le monument dans le monde chargé sans en dupliquer les constantes.
  templeAt: (i, j) => village.templeAt(i, j),
  templesSur: (x0, z0, x1, z1) => village.templesSur(x0, z0, x1, z1),
  playerState: () => player.saveState(),
};
