import * as THREE from '../vendor/three/three.module.js';
import { PointerLockControls } from '../vendor/three/examples/jsm/controls/PointerLockControls.js';
import { createTextureAtlas } from './textures.js';
import { createSaveStore, encodeSave, decodeSave, setNameInSave, slugify, cleanWorldName, AUTOSAVE_INTERVAL_MS } from './saves.js';
import { createVillageGen, VILLAGE } from './village.js';
import { createBiomeGen } from './biomes.js';
import { SimplexNoise } from './noise.js';
import { createTerrain, RELIEF } from './terrain.js';
import {
  MONDE_DEFAULTS, MONDE_FIELDS, clampMonde, memesMondes, mondeSeeds, mondeStorageKey,
  reliefOverrides, biomesOverrides, villageOverrides,
} from './world-config.js';
import { createMondePreview } from './world-preview.js';
import { creerEclairage, LAMPE_PORTEE, PLANCHER_NUIT, PLANCHER_PIECE, COUVERTE_MINCE, SEUIL_MUR, PORTEE_CIEL } from './eclairage.js';
import { creerEau, EAU } from './eau.js';
import {
  etatDuCiel, creerHorloge, heureAffichee, bornerDuree,
  DUREE_JOUR_DEFAUT, DUREE_JOUR_BORNES, HEURE_DEPART,
} from './ciel.js';
import { creerMeteo, cielSousPluie, METEO_MODES } from './meteo.js';

// ===================== CONSTANTS =====================
const CHUNK_SIZE = 16;
// Porté de 64 à 80 le 2026-11-09 pour que les catégories hautes d'immeuble tiennent :
// quatorze étages au pas de `floorPitch`, c'est quarante-quatre cubes de corps plus le
// toit, et le seuil d'une tour de centre-bourg se pose déjà à vingt-cinq cubes.
// Porté de 80 à 128 le 2026-11-11, quand les appartements ont reçu 4 cubes d'air sous
// plafond (baies de 4×4) : l'étage passe de 3 à 5 cubes, quatorze étages en demandent
// soixante-douze, et un seuil de centre-bourg à vingt-six cubes n'a plus de marge à 80.
const CHUNK_HEIGHT = 128;
const GRAVITY = 30;
const JUMP_SPEED = 10;
const MOVE_SPEED = 8;
// Le vol libre n'est plus une touche : il s'est décomposé en deux gestes distincts
// (voir l'en-tête du contrôleur aérien). `FLY_SPEED` et `FLY` ne survivent que pour le
// survol de debug que les suites posent sur `player.flyMode`.
const FLY_SPEED = 20;
const FLY = false;

// ---- contrôleur aérien ------------------------------------------------------
// Trois gestes, trois effets, aucune ambiguïté avec la nage (dans l'eau, Espace reste
// le coup de palme et rien de tout ceci ne s'allume) :
//  - une pression au sol **saute** ;
//  - un **maintien** en l'air allume les réacteurs — on monte tant que la touche tient,
//    on retombe dès qu'on la lâche ;
//  - une **seconde pression** en l'air ouvre le plané : la trajectoire suit le regard,
//    Z (ou W) pousse le gaz, S le réduit — le nez décide de l'altitude, l'allure de la
//    portance. Une nouvelle pression rompt le plané et on redescend.
const JET_SPEED = 9;            // montée des réacteurs (cubes/s), sans jauge
const PLANE_MIN = 4;            // allure minimale du planeur
const PLANE_DEFAUT = 14;        // allure à l'ouverture du plané
const PLANE_MAX = 34;           // allure maximale au gaz
const PLANE_THRUST = 16;        // cubes/s gagnés ou perdus par seconde de touche tenue
const PLANE_LIFT_SPEED = 16;    // au-delà de cette allure, le planeur ne perd plus de hauteur
const PLANE_SINK_MAX = 7;       // perte d'altitude à l'arrêt complet (cubes/s)

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
// Part du tri offerte à la direction du regard : un tronçon droit devant est compté
// comme s'il était un peu plus proche. Sans ce biais, le joueur qui vole au planeur
// creuse son propre trou : mesuré le 2026-11-15 sur trois vols appariés de dix-huit
// secondes à 34 cubes/s et rayon 8, il manquait un tronçon dans l'axe du regard sur
// 58 à 100 % des images ; avec 0,3, sur 12 à 37 %, pour 1,7 image/s perdue. Le réglage
// a été poussé jusqu'à 0,5 — le trou tombe alors sous 8 % des images, mais au prix de
// 5,5 i/s : trois fois plus cher pour un gain marginal. Ce qui ne se reverra jamais
// (derrière le joueur) ne mange donc plus le créneau d'image.
const BIAIS_DEVANT = 0.3;
// Parois de référence pour juger une première publication (voir `majMurs`) : quatre
// tampons partagés par tout le monde plutôt qu'un jeu alloué à chaque tronçon maillé.
const PLAN_VIDE = {
  w: new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT),
  e: new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT),
  n: new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT),
  s: new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT),
};

// ---- fiche du monde (écran de génération) ----
// Le slot se lit dans l'URL : c'est lui qui porte l'identité du monde, donc c'est lui
// qui choisit la fiche de génération. La fiche vit dans `localStorage` sous une clé par
// monde ET dans le fichier de sauvegarde ; ici on ne lit que le magasin local, parce
// que le relief doit être posé avant le premier tronçon, donc avant que la disquette
// ait répondu. La relecture du fichier garde un œil sur l'écart (voir `bootWorld`).
const SAVE_PARAMS = new URLSearchParams(window.location.search);
const SAVE_SLOT = SAVE_PARAMS.get('world') || 'default';

function lireFicheDuMonde(slot) {
  try {
    const brut = localStorage.getItem(mondeStorageKey(slot));
    return clampMonde(brut ? JSON.parse(brut) : null);
  } catch (e) {
    // Une fiche illisible n'est pas un motif de ne pas jouer : le monde d'aujourd'hui.
    return clampMonde(null);
  }
}

const MONDE = lireFicheDuMonde(SAVE_SLOT);

// ---- world persistence ----
// The whole terrain is a pure function of these seeds, so the disk only ever has
// to carry the player's diff. Recording them in the save file is what makes a
// future seed change detectable instead of silently mangling saved worlds.
// Elles dérivent de la graine saisie à l'écran de génération (`mondeSeeds`) ; la
// dérivation est calée pour que la graine par défaut rende exactement les graines
// d'hier — 42, 123, 777, 999 — et qu'un monde ancien se régénère à l'identique.
const WORLD_SEEDS = mondeSeeds(MONDE.graine);
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
  const stored = raw && typeof raw === 'object' ? raw : {};
  return {
    renderDistance: clampRenderDistance(stored.renderDistance),
    // La durée de la journée se règle comme la profondeur de champ ; à son défaut le
    // monde tourne à la cadence du projet, et un réglage absent du disque n'y change rien.
    dureeJour: bornerDuree(stored.dureeJour ?? DUREE_JOUR_DEFAUT),
    // La météo se règle comme la durée du jour : « auto » laisse le monde tirer ses
    // averses, les deux autres positions rendent le joueur maître du ciel.
    meteo: METEO_MODES.includes(stored.meteo) ? stored.meteo : 'auto',
  };
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      renderDistance: settings.renderDistance,
      dureeJour: settings.dureeJour,
      meteo: settings.meteo,
    }));
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
  MOSS: 18, LAVA: 19, OBSIDIAN: 20,
  LAMP_POST: 21, LAMP_GLOW: 22,
  // Quatre appliques murales, une par face d'adossement — le monde ne porte aucune
  // rotation de bloc, l'orientation vit donc dans l'identifiant.
  LAMP_WALL_O: 23, LAMP_WALL_E: 24, LAMP_WALL_N: 25, LAMP_WALL_S: 26,
};

// Block metadata.
//   solid    -> stops the player (glass and leaves do, water and lava do not)
//   opaque   -> hides neighbour faces and casts ambient occlusion
//   pass     -> 'opaque' | 'translucent' | 'cutout' (alpha tested foliage)
//   tiles    -> atlas tile names per face family
//   box      -> sub-cube geometry [x0,y0,z0,x1,y1,z1] in 0..1; the mesher draws that
//               box instead of the full cube, which is what lets a lamp post read as a
//               post. Box blocks are never culled by their neighbours.
//   emissive -> rendered with its own unlit material: it carries its light and stays
//               bright at midnight (a Lambert surface would just go grey with ambient)
//   breakable-> cassable alors que le bloc ne bloque pas la marche : le rayon de visée
//               s'y arrête quand même. Sans ce drapeau, une applique murale — non solide
//               par construction — serait impossible à viser donc à détruire.
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
  // Le lampadaire est un bloc en deux parties, cassables et posables séparément : le
  // pied de fonte (un quart de cube de section) et la lanterne qui le coiffe. La
  // lanterne est émissive — elle porte sa lumière — et c'est `eclairage.js` qui cuit
  // son halo dans les sommets des blocs qu'elle entoure.
  [BLOCK.LAMP_POST]: { name: 'Pied de lampadaire', colors: [0x3a3f47], solid: true, opaque: false, tiles: T('lamp_post'), box: [0.4, 0, 0.4, 0.6, 1, 0.6] },
  [BLOCK.LAMP_GLOW]: { name: 'Lanterne', colors: [0xffb733], solid: true, opaque: false, emissive: true, tiles: T('lamp_glow'), box: [0.28, 0.02, 0.28, 0.72, 0.86, 0.72] },
  // Appliques murales — demandé le 2026-11-11 : « dans les immeubles tu mis les lumières
  // devant les portes, il faudrait ajouter une lumière qui soit mise sur les murs pour
  // éviter de bloquer le passage ». Un candélabre occupe **toute sa case** à la marche —
  // la collision se juge à la cellule, pas à la boîte fine du poteau — donc dans un
  // couloir d'immeuble de deux cubes il condamnait le seuil des portes. L'applique est
  // scellée au mur et n'est **pas solide** : on passe à travers, comme l'eau. Elle reste
  // cassable grâce à `breakable`, qui la rend visible au rayon de visée malgré son
  // absence de solidité (l'eau et la lave, elles, traversent le rayon).
  // Les quatre boîtes s'adossent chacune à une face, dans l'ordre de MURALE_DIRS : ouest,
  // est, nord, sud. Une applique saillit de 0.32 hors du mur et occupe le haut de la case,
  // à hauteur de lampe — jamais le cube entier, qui lui barrerait le passage.
  ...Object.fromEntries([
    [[0, 0.62, 0.28, 0.32, 0.98, 0.72], BLOCK.LAMP_WALL_O],
    [[0.68, 0.62, 0.28, 1, 0.98, 0.72], BLOCK.LAMP_WALL_E],
    [[0.28, 0.62, 0, 0.72, 0.98, 0.32], BLOCK.LAMP_WALL_N],
    [[0.28, 0.62, 0.68, 0.72, 0.98, 1], BLOCK.LAMP_WALL_S],
  ].map(([boite, id], face) => [id, {
    name: 'Applique murale', colors: [0xffcb5e],
    solid: false, opaque: false, breakable: true, emissive: true,
    tiles: T('lamp_wall'), box: boite,
    // Une applique est un seul objet pour le joueur : la face qui la colle au mur se lit
    // sur le voisin au moment de la pose (`appliqueOriente`), donc les trois autres
    // identifiants ne sont que des variantes de la première et n'ont rien à faire au
    // catalogue — quatre icônes identiques ne laisseraient que deviner laquelle choisir.
    variant: face > 0,
  }])),
};

for (const info of Object.values(BLOCK_INFO)) {
  if (!info.pass) info.pass = 'opaque';
}

// Matériaux qui comptent comme de la roche pour l'éclairage : une cellule coiffée de
// l'un d'eux est sous terre, une cellule coiffée de planches ou de brique est une pièce.
const ROCHE_NATURELLE = new Set([
  BLOCK.STONE, BLOCK.DIRT, BLOCK.GRASS, BLOCK.COBBLE, BLOCK.GRIT, BLOCK.SAND,
  BLOCK.SNOW, BLOCK.MOSS, BLOCK.OBSIDIAN, BLOCK.COAL, BLOCK.IRON, BLOCK.GOLD, BLOCK.DIAMOND,
]);

// Les blocs qui portent un halo : la lanterne du candélabre et les quatre appliques
// murales. Une seule liste, sinon le maillage cuit le halo des unes et oublie celui des
// autres — `estLampe`, `lampesAutour` et le ré-emmaillage de `setBlocksBulk` doivent
// connaître les mêmes identifiants.
const LANTERNE_IDS = new Set([
  BLOCK.LAMP_GLOW, BLOCK.LAMP_WALL_O, BLOCK.LAMP_WALL_E, BLOCK.LAMP_WALL_N, BLOCK.LAMP_WALL_S,
]);
const estLanterne = (id) => LANTERNE_IDS.has(id);
// Les quatre appliques, dans l'ordre de leurs faces d'adossement (−x, +x, −z, +z).
const APPLIQUES = [BLOCK.LAMP_WALL_O, BLOCK.LAMP_WALL_E, BLOCK.LAMP_WALL_N, BLOCK.LAMP_WALL_S];
const MURALE_DIRS = [[-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]];

// Hotbar contents are player-editable through the inventory and persisted.
const HOTBAR_SIZE = 9;
const HOTBAR_STORAGE_KEY = 'mincraft_hotbar';
const DEFAULT_HOTBAR = [BLOCK.GRASS, BLOCK.DIRT, BLOCK.STONE, BLOCK.WOOD, BLOCK.PLANKS, BLOCK.BRICK, BLOCK.SAND, BLOCK.GLASS, BLOCK.DIAMOND];

// Every block type, grouped for the palette header rows.
const BLOCK_GROUPS = [
  { label: 'NATUREL', ids: [BLOCK.GRASS, BLOCK.DIRT, BLOCK.STONE, BLOCK.COBBLE, BLOCK.SAND, BLOCK.GRIT, BLOCK.SNOW, BLOCK.MOSS] },
  { label: 'CONSTRUCTION', ids: [BLOCK.WOOD, BLOCK.PLANKS, BLOCK.BRICK, BLOCK.GLASS, BLOCK.OBSIDIAN] },
  // Les quatre faces d'adossement ne forment qu'un seul meuble dans la palette : le monde
  // ne porte aucune rotation de bloc, donc c'est le mur visé qui choisit l'identifiant
  // (voir World.appliqueOriente). Proposer quatre icônes serait demander au joueur de
  // choisir une orientation qu'il ne peut pas voir d'avance.
  { label: 'ÉCLAIRAGE', ids: [BLOCK.LAMP_POST, BLOCK.LAMP_GLOW, BLOCK.LAMP_WALL_O] },
  { label: 'VÉGÉTAUX', ids: [BLOCK.LEAVES] },
  { label: 'MINERAIS', ids: [BLOCK.COAL, BLOCK.IRON, BLOCK.GOLD, BLOCK.DIAMOND] },
  { label: 'LIQUIDES', ids: [BLOCK.WATER, BLOCK.LAVA] },
];
// Le catalogue posable : chaque bloc qui n'est pas une variante déclarée doit tenir sa
// case en palette, sinon il devient introuvable pour le joueur. Les faces d'adossement
// d'une applique en sont l'exemple — une seule icône, la pose lit le mur pour choisir la
// face — tout en restant cassables et reconnues par le halo.
const ALL_BLOCKS = Object.keys(BLOCK_INFO).map(Number).filter((id) => !BLOCK_INFO[id].variant);

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
// Le plafond des boyaux, tiré d'un bruit distinct : sans lui `isCave` creusait la colonne
// du socle jusqu'à trois cubes de la surface, et chaque grotte devenait un puits de jour.
// Mesuré avant ce correctif, le fond d'une galerie à six cubes sous la terre tenait 0,87
// de lumière du ciel — aucune mine ne pouvait donc jamais devenir noire.
const caveToitNoise = new SimplexNoise(WORLD_SEEDS.caves + 31);

// ==================== TERRAIN GENERATION ====================
// Le profil du monde — plateaux, sillons plissés, massifs soulevés jusqu'à la neige —
// vit dans `terrain.js`, sans dépendance : les suites Node jugent ainsi exactement le
// relief que le navigateur dessine, et non une copie qui aurait dérivé.

// Les fabriques servent aussi à l'aperçu de l'écran de génération, qui doit juger la
// fiche en cours de réglage et non celle du disque. Elles ne tirent rien au hasard :
// seules la graine et la fiche entrent dans le monde.
function fabriquerRelief(monde, seuils = null) {
  return createTerrain({
    noise: new SimplexNoise(mondeSeeds(monde.graine).terrain),
    chunkHeight: CHUNK_HEIGHT,
    relief: reliefOverrides(monde, { chunkHeight: CHUNK_HEIGHT, seuils }),
  });
}

function fabriquerClimat(monde) {
  const t = fabriquerRelief(monde);
  return createBiomeGen({
    BLOCK, CHUNK_SIZE, CHUNK_HEIGHT,
    heightAt: (x, z) => t.rawHeight(x, z),
    roll: hashRoll,
    saltBase: (mondeSeeds(monde.graine).trees * 7919) | 0,
    seaLevel: t.RELIEF.seaLevel,
  });
}

const apercuDuMonde = createMondePreview({
  creerRelief: (m) => fabriquerRelief(m),
  creerClimat: fabriquerClimat,
  chunkHeight: CHUNK_HEIGHT,
  // La ligne de flottaison ne descend pas sous le plancher du relief et ne monte pas
  // jusqu'à l'altitude où le village commence à bâtir : au-delà, il n'y aurait plus ni
  // plage praticable ni terrain lotissable.
  merBornes: { min: RELIEF.minGround + 2, max: VILLAGE.minGround },
});

// Un monde laissé en l'état ne paie ni l'échantillonnage ni la bissection : c'est le
// cas de tous les mondes déjà enregistrés, antérieurs à cet écran.
const MONDE_SEUILS = memesMondes(MONDE, MONDE_DEFAULTS)
  ? {}
  : apercuDuMonde.seuils(MONDE);

const terrain = fabriquerRelief(MONDE, MONDE_SEUILS);

// La ligne de flottaison vient du relief : c'est lui qui décide où la terre s'arrête,
// le village et les biomes consultent la même valeur.
const SEA_LEVEL = terrain.RELIEF.seaLevel;

function getTerrainHeight(x, z) {
  return terrain.heightAt(x, z);
}

function isCave(x, y, z) {
  if (y < 4 || y > CHUNK_HEIGHT - 4) return false;
  const n = caveNoise.octave(x * 0.04, z * 0.04, 3, 0.5);
  if (n <= 0.35) return false;
  // Le boyau a un toit : sans lui le vide monte jusqu'à la couche de terre et la colonne
  // toute entière sert de conduit à la lumière du ciel, ce qui rendait l'underground
  // méconnaissable — une galerie creusée par le joueur restait en pleine lumière.
  // Le plafond oscille entre douze et trente-quatre cubes et reste toujours sous quatre
  // cubes de roche, jamais visible depuis la surface.
  const toit = Math.min(getTerrainHeight(x, z) - 4,
    12 + Math.round((caveToitNoise.octave(x * 0.02, z * 0.02, 2, 0.5) + 1) * 11));
  return y < toit;
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
  // Très hautes montagnes : le village doit savoir où il monte. Ni immeuble ni ville
  // dans ces zones, seulement quelques hameaux (`VILLAGE.hamlet*`).
  alpsAt: (x, z) => terrain.alpsIntensity(x, z),
  // Densité urbaine et catégories d'immeuble réglées à l'écran de génération.
  reglages: villageOverrides(MONDE),
});

// ---- où naît un monde neuf ----
// Un monde qui sort du néant s'ouvre sous la colonnade d'un temple : le joueur découvre
// d'emblée ce que le village sait faire de mieux, et repart de là avec des repères. Un
// monde repris sur disque garde sa position enregistrée, et son point de re-naissance
// reste le repli au sec historique — changer cela téléporterait le joueur loin de chez
// lui à la première chute.
const APPARITION_TEMPLE_RAYONS = 6;   // ± six mailles de temple autour du repli au sec
let mondeVierge = false;               // aucun fichier sur le disque pour ce slot
let apparitionDuMonde = null;          // { x, y(pieds), z, yaw } | null
let apparitionResolue = false;

/** Le monument d'apparition, cherché une seule fois par session (le plan est coûteux). */
function resoudreApparition() {
  if (apparitionResolue) return apparitionDuMonde;
  apparitionResolue = true;
  try {
    apparitionDuMonde = village.apparitionDansTemple(
      SPAWN_XZ[0], SPAWN_XZ[1], APPARITION_TEMPLE_RAYONS);
  } catch (e) {
    // Un monde sans temple reste jouable : le repli au sec fait l'affaire.
    console.warn('Temple d’apparition introuvable :', e);
    apparitionDuMonde = null;
  }
  return apparitionDuMonde;
}

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
  isBlocked: (wx, wz) => village.blocksVegetation(wx, wz),
  seaLevel: SEA_LEVEL,
  riverAt: (x, z) => terrain.riverAt(x, z),
  // Parts de forêt et de désert réglées à l'écran, converties en seuils de climat par
  // l'étalonnage de l'aperçu.
  reglages: biomesOverrides(MONDE, MONDE_SEUILS),
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
/**
 * Ajoute à un matériau éclairé le canal de lumière des lanternes : un attribut de
 * sommet `aLampe`, additionné en sortie de fragment après l'éclairage de scène.
 *
 * L'accroche se fait sur `<dithering_fragment>`, un include stable du Lambert qui
 * tombe tout à la fin du shader — plutôt que de toucher à la boucle de lumières, dont
 * la forme change d'une version de Three à l'autre. Si l'include venait à disparaître,
 * le remplacement ne ferait simplement rien : les lampes cesseraient d'éclairer, ce que
 * le contrôle de pixels de la suite `ciel` voit immédiatement.
 *
 * Le halo est **multiplié par le grain de l'atlas** (`mcGrainLampe`) : sans ça, une cave
 * éclairée perd sa texture. La raison est dans l'ordre des opérations — l'ambiante et le
 * soleil multiplient `diffuseColor` (donc la carte), alors que le canal, lui, s'ajoute
 * après tout. Sous un halo assez fort, le pixel devient ce terme additif, plat, et le
 * dessin de la pierre n'y est plus pour rien. Mesuré dans une galerie scellée à minuit,
 * mur à deux cubes d'une lanterne : retirer `map` du matériau divisait le grain par dix
 * sous ambiante seule (1,56 → 0,16) mais seulement par deux sous le halo (0,84 → 0,33) —
 * preuve que l'image était déjà celle du halo, pas de la roche.
 */
function brancherCanalLampe(material, uniforme) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLampe = uniforme;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLampe;\nvarying float vLampe;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLampe = aLampe;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLampe;\nuniform vec3 uLampe;')
      // Saisi juste après `<map_fragment>`, donc avant `<color_fragment>` : là, `diffuseColor`
      // ne porte encore que la carte d'atlas, pas la couleur de sommet qui écrase tout sous
      // terre. Un matériau sans carte y lit simplement son blanc, le halo reste franc.
      .replace('#include <map_fragment>', '#include <map_fragment>\nvec3 mcGrainLampe = diffuseColor.rgb;')
      .replace('#include <dithering_fragment>',
        '#include <dithering_fragment>\ngl_FragColor.rgb += uLampe * vLampe * '
        + `mix(vec3(1.0), mcGrainLampe / ${CLARTE_ATLAS}, ${GRAIN_LAMPE});`);
  };
  // Deux matériaux qui ne diffèrent que par ce patch doivent quand même deux programmes.
  material.customProgramCacheKey = () => 'lampe';
}

/**
 * Teinte du halo jeté par les lanternes et les appliques — blanche, comme un lampadaire
 * municipal : l'ambre d'une lampe à huile peint la pierre des murs en jaune, ce que le
 * joueur voit aussitôt à minuit. Le globe reste ambré (c'est l'objet qui brille, pas la
 * lumière qu'il projette).
 *
 * Le gain de 0,74 compense la perte de luminance : le canal est additif donc perçu, et
 * (0,2126·1 + 0,7152·0,69 + 0,0722·0,4) = 0,735 était la luminance de l'ancien ambre.
 * Un blanc franc à (1,1,1) éclaircirait le cadre de 14 % — chiffre mesuré sur image,
 * rendu comparé teinte par teinte autour d'une lanterne isolée à minuit.
 */
const TEINTE_LAMPE = 0.74;

/**
 * Part du détail de l'atlas que le halo transporte, dans `brancherCanalLampe`. À zéro, le
 * halo est plat — c'est le défaut signalé (« les textures ont disparu dans les caves quand
 * il y a de la lumière ») : mesuré dans une galerie scellée à minuit, retirer la carte du
 * matériau ne coûtait qu'un grain de 0,84 → 0,33 sous le halo, contre 1,56 → 0,16 sous une
 * lumière qui multiplie l'albédo. Le pixel n'était plus à la roche, il était au halo.
 *
 * La modulation est **divisée par `CLARTE_ATLAS`**, la luminance moyenne de l'atlas (0,372,
 * comptée en parcourant son canevas). Sans cette division, multiplier par une carte qui
 * moyenne à 0,37 éteindrait les lampes des deux tiers — mesuré 50,7 → 29,1 de luminance
 * dans la même galerie. Normalisée, elle rend le grain (0,84 → 2,00, la référence de jour
 * étant 1,56) pour 9 % de lumière seulement (50,7 → 46,2), et 0 % de pixel écrêté.
 */
const GRAIN_LAMPE = 0.7;
const CLARTE_ATLAS = 0.372;

class World {
  constructor(scene) {
    this.scene = scene;
    this.chunks = new Map();
    this.modifiedBlocks = new Map(); // key: "x,y,z" -> blockId (player modifications)
    this.onEdit = null;              // save layer hooks this: the diff just changed
    this._overrideIndex = null;      // chunkKey -> Map(cellIndex -> id), see _indexOverrides
    this._lampIndex = null;          // lanternes posées par le joueur, voir lampesAutour
    this.pendingChunks = 0;          // in-range cells still waiting to be generated
    this.dirtyKeys = new Set();      // chunks awaiting a (re)mesh
    this._offsetCle = null;          // cached nearest-first offset table, keyed by radius+heading
    this._offsets = [];
    this._centre = null;             // chunk du joueur, pour trier à partir de lui
    this._dir = { x: 0, z: 0 };      // direction du regard, pour servir l'avant en premier

    // ---- eau courante -------------------------------------------------------
    // Le monde ne stocke que le diff du joueur ; l'eau de passage y a donc sa propre
    // table de distances. Une cellule d'eau absente de cette table est une **source**
    // (mer, rivière, seau posé) : pérenne, cube plein, distance 0. Toute cellule d'eau,
    // source ou de passage, occupe le cube entier.
    this.eauNiveaux = new Map();     // key: "x,y,z" -> distance à la source (1..EAU.PORTEE)
    this._enEau = false;             // garde : l'automate ne doit pas se réveiller lui-même
    this.eau = creerEau({
      height: CHUNK_HEIGHT,
      ID_AIR: BLOCK.AIR,
      ID_EAU: BLOCK.WATER,
      bloc: (x, y, z) => this.getBlock(x, y, z),
      niveau: (x, y, z) => this.eauNiveaux.get(`${x},${y},${z}`) ?? null,
      solide: (x, y, z) => this.isSolid(x, y, z),
      charge: (x, z) => this.chunks.has(this.getChunkKey(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE))),
      ecrire: (cells) => this._ecrireEau(cells),
    });

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
    // Les blocs qui portent leur lumière (la lanterne) ne doivent pas pâlir avec
    // l'ambiante : un Lambert à minuit rendrait un gris. Matériau non éclairé.
    this.matGlow = new THREE.MeshBasicMaterial({
      map: atlas.texture,
      vertexColors: true,
      transparent: false,
      side: THREE.FrontSide,
    });
    // Le halo des lanternes arrive en addition, après l'éclairage de scène : la couleur
    // de sommet sert d'albédo et porte déjà l'obscurité des grottes, donc une lumière
    // multipliée par cet albédo n'éclairerait jamais une galerie noire. Un attribut
    // propre au maillage (`aLampe`) et un uniforme partagé entre les deux matériaux
    // éclairés font le travail — éteindre les lampes de ville ne coûte qu'une valeur.
    this.uniformeLampe = { value: new THREE.Color().setRGB(TEINTE_LAMPE, TEINTE_LAMPE, TEINTE_LAMPE) };
    brancherCanalLampe(this.matOpaque, this.uniformeLampe);
    brancherCanalLampe(this.matTrans, this.uniformeLampe);
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
  //
  // `options.differe` hands the remesh to the streaming queue instead of paying for it on
  // this frame — what the fluid uses, so a flood creeping over nine chunks cannot stutter.
  // `options.fluide` set to false skips the wake-up call (the fluid's own writes must not
  // re-arm themselves).
  setBlocksBulk(cells, options = {}) {
    const differe = !!options.differe;
    const duJoueur = options.fluide !== false;
    const touched = new Set();
    for (const [x, y, z, blockId] of cells) {
      const avant = this.getBlock(x, y, z);
      const etaitLampe = estLanterne(avant);
      // Une applique posée par le joueur s'oriente toute seule : on choisit la face dont
      // le mur est plein derrière elle, faute de quoi elle flotterait adossée au vide.
      const id = APPLIQUES.includes(blockId) ? this.appliqueOriente(x, y, z, blockId) : blockId;
      this.modifiedBlocks.set(`${x},${y},${z}`, id);
      // Une édition du joueur efface la distance enregistrée : l'eau qu'elle pose est une
      // source, pas un filet en sursis, et rien ne doit rester d'un filet là où le joueur
      // vient de couler du béton. L'automate, lui, écrit ses propres distances (garde
      // `_enEau`) et n'est donc pas concerné par cette tonte.
      if (duJoueur) this.eauNiveaux.delete(`${x},${y},${z}`);
      this._touchedChunks(x, y, z, touched);
      const pleinAvant = avant !== BLOCK.AIR && !!BLOCK_INFO[avant]?.opaque;
      const pleinApres = id !== BLOCK.AIR && !!BLOCK_INFO[id]?.opaque;
      if (pleinAvant !== pleinApres) this._touchLumiere(x, z, touched);
      // Poser ou arracher une lanterne change l'éclairage des tronçons d'à côté, pas
      // seulement de celui qui la porte : son halo porte à neuf cubes, et un tronçon
      // voisin maillé avant resterait clair là où le nouveau-né éteint tout — ou
      // s'obscurcirait pour une lanterne que le joueur vient d'arracher.
      if (estLanterne(id) || etaitLampe) {
        const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) this.markChunkDirty(cx + dx, cz + dz);
        }
      }
    }
    this._overrideIndex = null;
    this._lampIndex = null;          // voir lampesAutour : même cycle de vie que l'index

    // Toute édition réveille le fluide autour d'elle : percer le sable d'une plage est
    // exactement la cellule qu'il faut noyer, et boucher une source est ce qui doit tarir
    // la nappe en aval. L'eau générée avec le relief, elle, ne passe jamais par ici —
    // c'est voulu, elle est déjà à l'équilibre.
    if (options.fluide !== false && !this._enEau) {
      for (const [x, y, z] of cells) this.eau.reveiller(x, y, z);
    }

    for (const key of touched) {
      const comma = key.indexOf(',');
      const cx = +key.slice(0, comma);
      const cz = +key.slice(comma + 1);
      if (differe) this.markChunkDirty(cx, cz);
      else this.rebuildChunk(cx, cz);
    }
    if (touched.size > 0 && this.onEdit) this.onEdit();
    return touched.size;
  }

  /**
   * Écriture groupée d'une vague d'eau. Les distances sont posées **avant** les blocs : le
   * mailleur lit la table des niveaux pour choisir l'épaisseur de chaque filet, et mailler
   * un cube plein que la distance vient rattraper une image plus tard se verrait à l'écran.
   */
  _ecrireEau(cells) {
    for (const [x, y, z, id, niv] of cells) {
      const k = `${x},${y},${z}`;
      if (id === BLOCK.WATER && niv != null) this.eauNiveaux.set(k, niv);
      else this.eauNiveaux.delete(k);
    }
    this._enEau = true;
    try {
      this.setBlocksBulk(cells, { differe: true, fluide: false });
    } finally {
      this._enEau = false;
    }
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
    // Le coin partagé par quatre tronçons : la face verticale du voisin diagonal lit
    // les deux voisins orthogonaux pour son occlusion ambiante.
    if (lx === 0 && lz === 0) into.add(this.getChunkKey(cx - 1, cz - 1));
    if (lx === 0 && lz === CHUNK_SIZE - 1) into.add(this.getChunkKey(cx - 1, cz + 1));
    if (lx === CHUNK_SIZE - 1 && lz === 0) into.add(this.getChunkKey(cx + 1, cz - 1));
    if (lx === CHUNK_SIZE - 1 && lz === CHUNK_SIZE - 1) into.add(this.getChunkKey(cx + 1, cz + 1));
  }

  // Un cube cassé ou posé change l'éclairage bien au-delà de sa colonne : le BFS du
  // ciel ne meurt qu'après `PORTEE_CIEL` cubes à plat. Tout tronçon touchant cette
  // portée a donc quelque chose à relire chez nous — on le met en file plutôt qu'on ne
  // le maille ici, pour qu'un pavé de mille cubes ne paie pas mille remaillages.
  _touchLumiere(x, z, horsFile) {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    const files = [];
    if (lx < PORTEE_CIEL) files.push([cx - 1, cz]);
    if (lx >= CHUNK_SIZE - PORTEE_CIEL) files.push([cx + 1, cz]);
    if (lz < PORTEE_CIEL) files.push([cx, cz - 1]);
    if (lz >= CHUNK_SIZE - PORTEE_CIEL) files.push([cx, cz + 1]);
    for (const [fx, fz] of files) {
      const cle = this.getChunkKey(fx, fz);
      if (horsFile?.has(cle)) continue;      // déjà reconstruit synchronement
      this.markChunkDirty(fx, fz);
    }
  }

  /**
   * Luminance déjà calculée des quatre tronçons attenants, lue sur la paroi partagée et
   * rendue dans le repère du tronçon qu'on va mailler. Un tronçon hors du flot répond
   * null : la frontière reste close, comme avant ce correctif.
   */
  mursSemences(cx, cz) {
    const plan = (dx, dz, cote) => this.chunks.get(this.getChunkKey(cx + dx, cz + dz))?.murs?.[cote] ?? null;
    const ouest = plan(-1, 0, 'e'), est = plan(1, 0, 'w');
    const nord = plan(0, -1, 's'), sud = plan(0, 1, 'n');
    if (!ouest && !est && !nord && !sud) return null;
    return { ouest, est, nord, sud };
  }

  /**
   * Garde les quatre parois du champ de lumière d'un tronçon et prévient les voisins
   * dont la paroi vient de bouger : sans cet aller-retour, celui qui a maillé en premier
   * gardait la luminance que son voisin avait avant l'édit, et le jour ne traversait
   * jamais la frontière. La garde `SEUIL_MUR` borne la conversation — une paroi ne se
   * rejuge que si elle a réellement changé.
   */
  majMurs(cx, cz, niveau) {
    const chunk = this.chunks.get(this.getChunkKey(cx, cz));
    if (!chunk) return;
    const cells = CHUNK_SIZE * CHUNK_SIZE;
    const mur = (indexeur) => {
      const p = new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT);
      // `u + y * CHUNK_SIZE` et non `y + u * CHUNK_SIZE` : `y` court jusqu'à
      // CHUNK_HEIGHT pour un pas de CHUNK_SIZE, donc l'autre ordre fait déborder chaque
      // colonne sur la suivante et une paroi ne garde que ses dernières hauteurs.
      for (let u = 0; u < CHUNK_SIZE; u++) {
        for (let y = 0; y < CHUNK_HEIGHT; y++) p[u + y * CHUNK_SIZE] = niveau[indexeur(u, y)];
      }
      return p;
    };
    const avant = chunk.murs;
    // À la première publication, personne n'a encore rien lu de nous : on juge donc
    // contre le néant. Rendre la main sans prévenir laissait le premier maillage —
    // calculé sans les voisins — être lu par eux jusqu'à la fin de la session : mesuré
    // le 2026-11-14, les neuf tronçons d'un quartier n'étaient maillés qu'une fois et
    // une poche scellée gardait 26,6 de bande haute au lieu de 3,6.
    const reference = avant || PLAN_VIDE;
    const murs = {
      w: mur((u, y) => u * CHUNK_SIZE + y * cells),                    // lx = 0
      e: mur((u, y) => (CHUNK_SIZE - 1) + u * CHUNK_SIZE + y * cells), // lx = dernier
      n: mur((u, y) => u + y * cells),                                  // lz = 0
      s: mur((u, y) => u + (CHUNK_SIZE - 1) * CHUNK_SIZE + y * cells), // lz = dernier
    };
    chunk.murs = murs;
    const ecart = (a, b) => {
      let m = 0;
      for (let i = 0; i < a.length; i++) {
        const d = a[i] > b[i] ? a[i] - b[i] : b[i] - a[i];
        if (d > m) m = d;
      }
      return m;
    };
    // Un voisin qui n'a jamais été maillé recalculera de toute façon : pas la peine de
    // le remettre en file, ce qui doublerait le travail du premier passage du flot.
    const dejaMaille = (fx, fz) => {
      const c = this.chunks.get(this.getChunkKey(fx, fz));
      return !!c && c.meshes.length > 0;
    };
    const prevenir = (deltaX, deltaZ, cote) => {
      if (ecart(murs[cote], reference[cote]) <= SEUIL_MUR) return;
      if (!avant && !dejaMaille(cx + deltaX, cz + deltaZ)) return;
      this.markChunkDirty(cx + deltaX, cz + deltaZ);
    };
    prevenir(-1, 0, 'w');
    prevenir(1, 0, 'e');
    prevenir(0, -1, 'n');
    prevenir(0, 1, 's');
  }

  // Replays a save read from disk. It deliberately does not fire onEdit — putting
  // the stored diff back is not a player edit — and queues the remesh instead of
  // rebuilding in place, so a save holding tens of thousands of cubes still costs
  // nothing on the loading frame.
  //
  // `flux` remet les distances de l'eau de passage. Le monde recharge **à l'arrêt** : une
  // inondation interrompue par la fermeture de l'onglet ne reprend pas toute seule, elle
  // attend la prochaine édition du joueur, comme la mer générée attend qu'on la perce.
  applyEdits(edits, flux = null) {
    this.modifiedBlocks = new Map(edits);
    // Une distance ne survit qu'aussi longtemps que la cellule d'eau qui la porte : un
    // fichier bricolé (ou repris après une édition manuelle) ne doit pas laisser traîner
    // de niveau sur un bloc qui n'est plus de l'eau.
    const niveaux = new Map();
    if (flux) {
      const eau = BLOCK.WATER;
      for (const [cle, niv] of flux) {
        if (this.modifiedBlocks.get(cle) === eau) niveaux.set(cle, niv);
      }
    }
    this.eauNiveaux = niveaux;
    this._overrideIndex = null;
    this._lampIndex = null;          // voir lampesAutour : même cycle de vie que l'index
    this.eau.reinitialiser();
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
    this.eauNiveaux = new Map();     // l'eau de passage fait partie du diff du joueur
    this._overrideIndex = null;
    this._lampIndex = null;          // voir lampesAutour : même cycle de vie que l'index
    this.eau.reinitialiser();
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

  /**
   * Le corps flotte-t-il dans cette cellule ? Toute cellule d'eau compte : l'automate ne
   * rend plus que des cubes pleins, il n'existe pas de pellicule qui mouillerait le sol
   * sans porter un joueur.
   */
  estNageable(x, y, z) {
    if (y < 0 || y >= CHUNK_HEIGHT) return false;
    return this.getBlock(x, y, z) === BLOCK.WATER;
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

  /**
   * Ce que le rayon de visée peut atteindre. Un bloc non solide comme l'eau se traverse
   * sans s'arrêter ; une applique murale, elle, doit se laisser viser — sinon rien ne
   * permet jamais de la casser, ni d'en reposer une ailleurs.
   */
  isTargetable(x, y, z) {
    const info = BLOCK_INFO[this.getBlock(x, y, z)];
    return !!(info && (info.solid || info.breakable));
  }

  /**
   * L'identifiant d'applique qu'impose le mur derrière la cellule : la face dont le voisin
   * est plein. Le joueur vise une face, la case visée est toujours l'air collé à cette
   * face, donc le mur trouvé est exactement celui qu'il regardait. À défaut de mur — pose
   * en rase campagne — l'applique garde la face demandée.
   */
  appliqueOriente(x, y, z, demande) {
    for (let i = 0; i < APPLIQUES.length; i++) {
      const [dx, dy, dz] = MURALE_DIRS[i];
      if (this.isSolid(x + dx, y + dy, z + dz)) return APPLIQUES[i];
    }
    return demande;
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
    // Les candélabres viennent après tous les ouvrages : ils s'assoient sur le pavé que
    // la voirie vient de poser et renoncent si un arc ou un tablier occupe déjà leur
    // colonne. Avant elle, ils se feraient raser par le garde-tête d'une avenue.
    village.stampLamps(data, cx, cz);

    // `murs` garde la luminance calculée sur les quatre parois du tronçon : c'est ce que
    // les voisins viennent lire quand ils se maillent (voir `mursSemences`).
    this.chunks.set(key, { data, meshes: [], cx, cz, murs: null });
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

  /**
   * Toutes les lanternes dont la portée touche ce tronçon, en coordonnées monde.
   *
   * Deux origines : celles que le village pose le long des avenues — lui seul sait où
   * la voirie passe — et celles posées par le joueur. Celles du village sont vérifiées
   * bloc par bloc avant d'être retenues : une lanterne arrachée par le joueur reste
   * dans le plan du village, et sans ce contrôle son halo survivrait à sa propre casse.
   */
  lampesAutour(cx, cz) {
    const baseX = cx * CHUNK_SIZE, baseZ = cz * CHUNK_SIZE;
    const R = LAMPE_PORTEE + 1;
    const vues = new Set();
    const lampes = [];
    const retenir = (x, y, z) => {
      const k = `${x},${y},${z}`;
      if (vues.has(k)) return;
      vues.add(k);
      lampes.push([x, y, z]);
    };

    // Les listes du village sont des **candidates** : elles énumèrent tout ce qui pourrait
    // porter une lumière dans la zone, quitte à en compter de retirées depuis. Seule la
    // cellule réellement remplie par un luminaire compte ici. Un candélabre est rendu
    // `{ wx, wz, y }` avec `y` au pied du poteau — la lumière vient de la lanterne posée
    // juste au-dessus ; une applique murale n'a pas de pied, sa cellule est déjà la source.
    const source = (l) => {
      const x = l.wx, y = l.murale ? l.y : l.y + 1, z = l.wz;
      if (estLanterne(this.getBlock(x, y, z))) retenir(x, y, z);
    };

    if (village.lampadairesSur) {
      for (const l of village.lampadairesSur(baseX - R, baseZ - R, baseX + CHUNK_SIZE + R, baseZ + CHUNK_SIZE + R)) {
        source(l);
      }
    }
    // Lanternes d'intérieur — pièces de maison, étages d'immeuble, nef des temples. Sans
    // cette seconde liste, une lanterne estampée dans un bâtiment éclairerait les murs
    // du voisinage mais jamais la pièce qui la porte : `lampadairesSur` ne connaît que
    // la voirie.
    if (village.lampesInterieuresSur) {
      for (const l of village.lampesInterieuresSur(baseX - R, baseZ - R, baseX + CHUNK_SIZE + R, baseZ + CHUNK_SIZE + R)) {
        source(l);
      }
    }
    // Appliques murales des couloirs d'immeuble — mêmes candidates, même garde.
    if (village.appliquesMuralesSur) {
      for (const l of village.appliquesMuralesSur(baseX - R, baseZ - R, baseX + CHUNK_SIZE + R, baseZ + CHUNK_SIZE + R)) {
        source(l);
      }
    }
    if (!this._lampIndex) {
      const index = [];
      for (const [clef, id] of this.modifiedBlocks) {
        if (!estLanterne(id)) continue;
        const a = clef.indexOf(','), b = clef.indexOf(',', a + 1);
        if (b < 0) continue;
        index.push([+clef.slice(0, a), +clef.slice(a + 1, b), +clef.slice(b + 1)]);
      }
      this._lampIndex = index;
    }
    for (const [x, y, z] of this._lampIndex) {
      if (Math.abs(x + 0.5 - (baseX + CHUNK_SIZE / 2)) <= CHUNK_SIZE / 2 + R
        && Math.abs(z + 0.5 - (baseZ + CHUNK_SIZE / 2)) <= CHUNK_SIZE / 2 + R) {
        retenir(x, y, z);
      }
    }
    return lampes;
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
    // Un tronçon pas encore généré n'est pas du vide : vu d'ici, il est plein. Le champ
    // de lumière doit donc lire « opaque » là où il n'a rien à lire — sinon un tronçon
    // maillé avant ses voisins reçoit le plein jour par des murs qui n'existent pas
    // encore. Mesuré le 2026-11-14, la luminance cuite à six cubes sous la surface
    // valait 0,495 contre 0,037 une fois le voisinage généré : le joueur voyait la
    // couleur des blocs se corriger toute seule en s'approchant. La géométrie, elle,
    // garde `opaqueAt` — dessiner une face vers un voisin absent ne gêne personne.
    const opaquePourLeCiel = (wx, wy, wz) => {
      if (opaqueAt(wx, wy, wz)) return true;
      const lx = wx - baseX, lz = wz - baseZ;
      if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) return false;
      return !this.chunks.has(this.getChunkKey(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE)));
    };

    const buckets = {
      opaque: { positions: [], normals: [], uvs: [], colors: [], lumieres: [], indices: [], count: 0 },
      trans:  { positions: [], normals: [], uvs: [], colors: [], lumieres: [], indices: [], count: 0 },
      glow:   { positions: [], normals: [], uvs: [], colors: [], lumieres: [], indices: [], count: 0 },
    };

    // Les deux champs d'éclairage cuits dans les sommets : la lumière du ciel, qui
    // s'éteint au fond des galeries, et le halo des lanternes, qui doit survivre à
    // cette extinction (d'où leur séparation — voir `eclairage.js`). La couverture
    // « bâtiment » vient du village : sans elle, une tour de pierre serait jugée une
    // grotte habitée et ses appartements deviendraient noirs en plein midi.
    // Masque des cellules tenues par un bâtiment, indexé comme les données du tronçon :
    // une table de clés « x,y,z » coûterait des dizaines de milliers de chaînes par
    // remaillage dans un quartier dense, pour répondre à quelques milliers de questions.
    const tenuBati = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_HEIGHT);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const p of village.buildingAt(cx + dx, cz + dz) || []) {
          const bx = (cx + dx) * CHUNK_SIZE + p.x0;
          const bz = (cz + dz) * CHUNK_SIZE + p.z0;
          const yBas = Math.max(0, (p.siteH ?? 0) - 1);
          const yHaut = Math.min(CHUNK_HEIGHT - 1, (p.siteH ?? 0) + (p.height || 6) + 1);
          for (let x = bx; x < bx + p.w; x++) {
            const lx = x - baseX;
            if (lx < 0 || lx >= CHUNK_SIZE) continue;
            for (let z = bz; z < bz + p.d; z++) {
              const lz = z - baseZ;
              if (lz < 0 || lz >= CHUNK_SIZE) continue;
              const base = lx + lz * CHUNK_SIZE;
              for (let y = yBas; y <= yHaut; y++) tenuBati[base + y * CHUNK_SIZE * CHUNK_SIZE] = 1;
            }
          }
        }
      }
    }
    const ecl = creerEclairage({
      CHUNK_SIZE, CHUNK_HEIGHT,
      opaqueAt: opaquePourLeCiel,
      rocheAt: (wx, wy, wz) => ROCHE_NATURELLE.has(blockAt(wx, wy, wz)),
      estLampe: estLanterne,
      estBati: (wx, wy, wz) => {
        const lx = wx - baseX, lz = wz - baseZ;
        if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || wy < 0 || wy >= CHUNK_HEIGHT) return false;
        return tenuBati[lx + lz * CHUNK_SIZE + wy * CHUNK_SIZE * CHUNK_SIZE] === 1;
      },
    });
    // Le champ de lumière vient aussi des tronçons attenants : sans ces graines, une
    // pièce assise de part et d'autre d'une frontière restait noire du côté où le jour
    // entrait pourtant chez le voisin (mesuré 0,35 à gauche, 0,035 à droite).
    const graines = this.mursSemences(cx, cz);
    const cielDuTroncon = ecl.champCiel(baseX, baseZ, graines);
    this.majMurs(cx, cz, cielDuTroncon.niveau);
    const lampes = this.lampesAutour(cx, cz);
    const halo = ecl.champLampes(lampes, baseX, baseZ);
    const haloEn = (wx, wy, wz) => {
      if (wy < 0 || wy >= CHUNK_HEIGHT) return 0;
      const lx = wx - baseX, lz = wz - baseZ;
      if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
        return halo[lx + lz * CHUNK_SIZE + wy * CHUNK_SIZE * CHUNK_SIZE];
      }
      // La face est donnée au tronçon voisin : sa cellule adjacente vit chez lui et n'est
      // pas dans ce champ. Y lire zéro barrait la cave d'une bande noire tous les
      // CHUNK_SIZE cubes — mesuré le 2026-11-15, les deux faces d'un même pilier sous une
      // applique valaient 0,24 et 0. Jugé sur place plutôt que lu chez le voisin : aucun
      // ordre de maillage ne peut donc laisser la bande en place.
      return ecl.puissanceLampe(lampes, wx, wy, wz);
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

    const CUBE = [0, 0, 0, 1, 1, 1];

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
          const estBox = !!info.box;
          const boite = estBox ? info.box : CUBE;
          const bucket = info.emissive ? buckets.glow
            : (info.pass === 'opaque' ? buckets.opaque : buckets.trans);
          const cullSameId = info.pass !== 'cutout';

          for (const face of FACES) {
            const nx = wx + face.dir[0];
            const ny = y + face.dir[1];
            const nz = wz + face.dir[2];
            const neighbor = blockAt(nx, ny, nz);

            let visible;
            if (estBox) visible = true;               // une boîte ne se fait pas manger par sa voisine
            else if (neighbor === BLOCK.AIR) visible = true;
            else if (BLOCK_INFO[neighbor].opaque) visible = false;
            else visible = !cullSameId || neighbor !== finalBlockId;
            if (!visible) continue;

            const rect = atlas.uvRect(tileNameFor(info, face.kind));
            // Translucent blocks keep their own tint rather than being darkened
            // twice (the texture already carries the colour). Sub-cube props skip AO
            // too: a quarter-cube post surrounded by air would only pick up noise.
            const faceLight = info.pass === 'opaque' && !estBox ? aoLevel : null;
            // Le bloc qui porte sa lumière n'a rien à recevoir du ciel ni des lampes.
            const clarte = info.emissive ? 1 : cielDuTroncon(nx, ny, nz);
            const lueur = info.emissive ? 0 : haloEn(nx, ny, nz);

            for (let c = 0; c < 4; c++) {
              const corner = face.corners[c];
              const uv = face.uvs[c];
              bucket.positions.push(
                wx + boite[0] + corner[0] * (boite[3] - boite[0]),
                y + boite[1] + corner[1] * (boite[4] - boite[1]),
                wz + boite[2] + corner[2] * (boite[5] - boite[2])
              );
              bucket.normals.push(face.dir[0], face.dir[1], face.dir[2]);
              bucket.uvs.push(
                rect.u0 + uv[0] * (rect.u1 - rect.u0),
                rect.v0 + uv[1] * (rect.v1 - rect.v0)
              );
              const light = face.shade * clarte * (faceLight ? faceLight(face, wx, y, wz, corner) : 1);
              bucket.colors.push(light, light, light);
              bucket.lumieres.push(face.shade * lueur);
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

    const materiaux = [
      [buckets.opaque, this.matOpaque, 0],
      [buckets.trans, this.matTrans, 1],
      [buckets.glow, this.matGlow, 1],
    ];
    for (const [bucket, materiau, ordre] of materiaux) {
      if (bucket.count === 0) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.normals, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uvs, 2));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(bucket.colors, 3));
      geometry.setAttribute('aLampe', new THREE.Float32BufferAttribute(bucket.lumieres, 1));
      geometry.setIndex(bucket.indices);
      geometry.computeBoundingSphere();

      const mesh = new THREE.Mesh(geometry, materiau);
      mesh.renderOrder = ordre;
      this.scene.add(mesh);
      chunk.meshes.push(mesh);
    }
  }

  /**
   * Ordre de visite des cellules d'un rayon, reconstruit seulement quand le rayon ou
   * la direction du regard change : à 32 chunks cela fait 4356 entrées, bien trop pour
   * un tri par image. La direction est quantifiée en 32 caps pour la même raison — sans
   * quoi la moindre rotation de souris jetterait la table.
   *
   * Le rang n'est pas la distance seule : un tronçon droit devant est compté comme
   * deux fois plus proche (`BIAIS_DEVANT`). Ce que le joueur ne verra plus jamais passe
   * en dernier, ce qui rend le créneau d'image disponible pour ce qu'il regarde.
   */
  offsetsFor(radius, dirX = 0, dirZ = 0) {
    const norm = Math.hypot(dirX, dirZ);
    const ax = norm > 1e-4 ? dirX / norm : 0;
    const az = norm > 1e-4 ? dirZ / norm : 0;
    const cap = norm > 1e-4 ? Math.round((Math.atan2(az, ax) + Math.PI) * 32 / Math.PI) : -1;
    const cle = `${radius}|${cap}`;
    if (this._offsetCle !== cle) {
      const offsets = [];
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const d = Math.sqrt(dx * dx + dz * dz);
          const cos = d > 0 ? (dx * ax + dz * az) / d : 1;
          offsets.push([dx, dz, d * (1 - BIAIS_DEVANT * cos)]);
        }
      }
      offsets.sort((a, b) => a[2] - b[2]);
      this._offsets = offsets;
      this._offsetCle = cle;
    }
    return this._offsets;
  }

  /**
   * Maille la file prête en commençant par ce que le joueur regarde, et rend le temps
   * qu'il y a passé — sans ce relevé, les deux passes du flot cumuleraient leurs
   * tranches et le budget d'image serait dépassé de 45 % (mesuré 14,5 ms pour 10
   * demandés, 56,7 i/s tombées à 43,3).
   *
   * Le contrôle d'horloge se fait **avant** l'appel coûteux : à ~4,5 ms le maillage,
   * contrôler après coup laissait chaque image déborder d'un tronçon entier.
   */
  drainerMailles(dureeAccordee) {
    const entree = performance.now();
    if (this.dirtyKeys.size === 0 || dureeAccordee <= 0) return 0;
    const echeance = entree + dureeAccordee;
    const c = this._centre;
    const files = [];
    for (const key of this.dirtyKeys) {
      if (!this.chunks.has(key)) { this.dirtyKeys.delete(key); continue; }
      const virgule = key.indexOf(',');
      const cx = +key.slice(0, virgule);
      const cz = +key.slice(virgule + 1);
      let rang = 0;
      if (c && (this._dir.x !== 0 || this._dir.z !== 0)) {
        const dx = cx - c.pcx, dz = cz - c.pcz;
        const d = Math.hypot(dx, dz);
        const cos = d > 0 ? (dx * this._dir.x + dz * this._dir.z) / d : 1;
        rang = d * (1 - BIAIS_DEVANT * cos);
      } else if (c) {
        rang = Math.hypot(cx - c.pcx, cz - c.pcz);
      }
      files.push([rang, cx, cz]);
    }
    files.sort((a, b) => a[0] - b[0]);
    for (const [, cx, cz] of files) {
      if (performance.now() > echeance) return performance.now() - entree;
      if (!this.chunks.has(this.getChunkKey(cx, cz))) continue;
      this.rebuildChunk(cx, cz);
    }
    return performance.now() - entree;
  }

  // Génère au plus `maxCells` cellules manquantes et s'arrête après `maxMs` d'horloge
  // murale : une grande profondeur de champ se décharge ainsi sur plusieurs images
  // plutôt que de geler l'onglet. `dirX`/`dirZ` portent le regard du joueur — voir
  // `offsetsFor`, qui donne l'ordre de visite.
  updateChunks(playerX, playerZ, maxCells = Infinity, maxMs = Infinity, dirX = 0, dirZ = 0) {
    const started = performance.now();
    const pcx = Math.floor(playerX / CHUNK_SIZE);
    const pcz = Math.floor(playerZ / CHUNK_SIZE);
    const radius = settings.renderDistance;
    this._centre = { pcx, pcz, radius };
    const norm = Math.hypot(dirX, dirZ);
    this._dir.x = norm > 1e-4 ? dirX / norm : 0;
    this._dir.z = norm > 1e-4 ? dirZ / norm : 0;
    const offsets = this.offsetsFor(radius, dirX, dirZ);

    // Le maillage coûte environ trois fois ce que coûte la génération : il lui revient
    // donc une tranche du budget d'image, et cette tranche est **partagée** entre les
    // deux passes — sinon chacune consomme sa moitié et l'image déborde. Chaque passe
    // doit aussi rester sous la fin du budget global : sans cela, une première passe
    // économe autorisait la seconde à dépasser l'enveloppe (mesuré 11,1 ms pour 10).
    const finBudget = started + maxMs;
    const partMaille = maxMs * 0.6;
    let tempsMaille = 0;
    const tranche = () => Math.min(partMaille - tempsMaille, finBudget - performance.now());

    tempsMaille += this.drainerMailles(tranche());

    let made = 0;
    let pending = 0;
    // Le balayage couvre toujours TOUTES les cellules du rayon, sinon `pendingChunks`
    // voudrait dire « ce que nous avons eu le temps de regarder » et non « ce qui reste
    // à faire » ; seule la génération elle-même est bornée par les seuils et l'horloge.
    for (const [dx, dz] of offsets) {
      const cx = pcx + dx;
      const cz = pcz + dz;
      const key = this.getChunkKey(cx, cz);
      if (this.chunks.has(key)) continue;
      pending++;
      if (made >= maxCells) continue;
      if (this.dirtyKeys.size > CHUNK_MESH_WATERMARK) continue;
      if (performance.now() > finBudget) continue;
      made++; // failures consume budget too, so a bad cell cannot spin forever
      if (this.generateChunkData(cx, cz)) {
        // Le tronçon né et ses quatre voisins : chacun doit redessiner la frontière que
        // cette naissance vient de changer. Différer le maillage « jusqu'aux voisins » a
        // été mesuré le 2026-11-15 : cela doublait les repeintures (618 → 1278 sur un
        // vol de dix-huit secondes) sans jamais en supprimer une seule — deux tronçons
        // adjacents ne peuvent pas se mailler après l'autre.
        this.markChunkDirty(cx, cz);
        this.markChunkDirty(cx - 1, cz);
        this.markChunkDirty(cx + 1, cz);
        this.markChunkDirty(cx, cz - 1);
        this.markChunkDirty(cx, cz + 1);
      }
    }

    tempsMaille += this.drainerMailles(tranche());

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
    // ---- contrôleur aérien (voir les constantes en tête de module) ----
    this.planant = false;       // le second appui d'Espace a ouvert le plané
    this.reacteurs = false;     // Espace tenu en l'air : les réacteurs tiennent la montée
    this.vitesseVol = PLANE_DEFAUT;   // allure du planeur, dosée par Z et S
    this.espaceTenu = false;    // état de la touche à l'image précédente (détection d'appui)
    this.attendRelache = false; // l'appui qui a ouvert/rompu le plané ne doit pas allumer les réacteurs
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
    // Un corps qu'on ressort d'un bloc ne doit pas en repartir en plané. La mémoire de
    // l'appui d'Espace, elle, se garde : `settle` tourne dès que le collider frotte une
    // paroi — un nageur qui remonte une berge y passe une dizaine de fois par seconde, et
    // effacer cette mémoire lui rendait les réacteurs en pleine longueur de nage.
    this.planant = false;
    this.reacteurs = false;
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

  /**
   * Le point où le joueur est posé quand on le remet à l'apparition. Sur un monde neuf,
   * c'est l'intérieur du temple le plus proche ; `getTerrainHeight` n'a rien à dire de
   * cet endroit — le sol y est une dalle estampée, plusieurs cubes au-dessus du relief.
   * Renvoie le niveau des pieds, comme le reste du module.
   */
  _spawnPoint() {
    if (mondeVierge) {
      const t = resoudreApparition();
      if (t) return t;
    }
    const [sx, sz] = this._spawnXZ();
    return { x: sx, y: getTerrainHeight(sx, sz) + 1, z: sz };
  }

  // Drops the player on the surface at the spawn point without touching the world.
  placeAtSpawn() {
    const p = this._spawnPoint();
    this.setEye(p.x, p.y, p.z);
    if (Number.isFinite(p.yaw)) {
      // Le visiteur se réveille face à l'autel, pas dos à lui.
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.set(0, p.yaw, 0, 'YXZ');
    }
    this.velocity.set(0, 0, 0);
    this.onGround = false;
    this.coupeLeVol();
  }

  /** Un déplacement brutal rend réacteurs et plané sans objet : on oublie tout. */
  coupeLeVol() {
    this.planant = false;
    this.reacteurs = false;
    this.attendRelache = false;
    this.vitesseVol = PLANE_DEFAUT;
    // Une touche encore tenue ne doit pas compter comme un appui neuf à la reprise.
    // (Le dictionnaire de touches est branché sur les contrôles après le joueur : d'où
    // la lecture prudente, sinon la page meurt au démarrage.)
    this.espaceTenu = !!this.controls?.keys?.Space;
  }

  _teleportToSpawn() {
    const p = this._spawnPoint();
    // chunks around the spawn may have been unloaded while the player was away
    this.world.updateChunks(p.x, p.z, WORLD_BOOT_BUDGET);
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
   * bain de lave au lieu de le laisser s'y enfoncer lentement. Toute cellule d'eau porte
   * un corps (`estNageable`) : l'automate ne rend que des cubes pleins, on nage donc
   * aussi bien dans une flaque de sept cubes de long que dans l'océan.
   */
  waterState() {
    const p = this.camera.position;
    const feet = this.feetY;
    const bx = Math.floor(p.x);
    const bz = Math.floor(p.z);
    const eau = (y) => this.world.estNageable(bx, y, bz);
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
    // L'aplatissement ne vaut que pour la marche : le planeur, lui, suit le regard à
    // trois dimensions, donc l'inclinaison de la caméra est ce qui monte et descend.
    const regard = direction.clone();
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

    // ---- les trois gestes d'Espace ----------------------------------------
    // Un appui se reconnaît au passage faux→vrai entre deux images : sans cette
    // distinction, maintenir la touche ouvrirait le plané sitôt les réacteurs éteints.
    const tenu = !!this.controls.keys['Space'] && !this.flyMode;
    const appuie = tenu && !this.espaceTenu;
    this.espaceTenu = tenu;
    if (!tenu) this.attendRelache = false;
    if (eau.nage) this.planant = false;   // sous l'eau, Espace reste le coup de palme
    let venaitDeSauter = false;
    if (appuie && !this.flyMode) {
      if (eau.nage) {
        // L'appui appartient au coup de palme. Sans ce garde, le corps qui franchit la
        // ligne d'eau touche tenue s'allumait en réacteurs : la sortie de rivière
        // devenait un décollage et plus personne ne se hissait sur la berge.
        this.attendRelache = true;
      } else if (this.onGround) {
        this.velocity.y = JUMP_SPEED;     // une pression saute
        this.onGround = false;
        venaitDeSauter = true;            // cette image garde l'élan du saut
      } else if (this.planant) {
        this.planant = false;             // en vol, la même pression rompt le plané
        this.attendRelache = true;        // et ne doit pas rallumer les réacteurs
      } else {
        this.planant = true;              // seconde pression en l'air : on ouvre le plané
        this.attendRelache = true;
      }
    }
    // Les réacteurs tiennent la montée tant que la touche est tenue ; ils ne s'allument
    // ni au sol (c'est le saut), ni en plané, ni dans l'eau, ni l'image du saut — sinon
    // l'élan de JUMP_SPEED serait écrasé par celui des réacteurs dès le décollage.
    this.reacteurs = tenu && !this.attendRelache && !this.planant && !venaitDeSauter
      && !this.onGround && !eau.nage && !this.flyMode;

    if (this.planant && !eau.nage && !this.flyMode) {
      // Le planeur : Z (ou W) pousse le gaz, S le réduit, et le **regard tient la
      // trajectoire** — nez vers le haut on prend de l'altitude, nez vers le bas on en
      // perd, tout l'air venant de l'allure dosée au gaz. La portance reste liée à
      // l'avancement : nez à l'horizontale et sous l'allure de sustentation, on coule
      // doucement au lieu de tomber, ce qui interdit le vol stationnaire gratuit.
      if (this.controls.keys['KeyZ'] || this.controls.keys['KeyW']) this.vitesseVol += PLANE_THRUST * deltaTime;
      if (this.controls.keys['KeyS']) this.vitesseVol -= PLANE_THRUST * deltaTime;
      this.vitesseVol = Math.min(PLANE_MAX, Math.max(PLANE_MIN, this.vitesseVol));
      const portance = Math.min(1, this.vitesseVol / PLANE_LIFT_SPEED);
      this.velocity.set(
        regard.x * this.vitesseVol,
        regard.y * this.vitesseVol - PLANE_SINK_MAX * (1 - portance),
        regard.z * this.vitesseVol,
      );
    } else {
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
          if (this.reacteurs) this.velocity.y = JET_SPEED;
        }
      } else {
        if (this.controls.keys['Space']) this.velocity.y = FLY_SPEED;
        else if (this.controls.keys['ShiftLeft']) this.velocity.y = -FLY_SPEED;
        else this.velocity.y = 0;
      }
    }

    this.moveWithCollision(this.velocity.clone().multiplyScalar(deltaTime));

    // Posé, le planeur n'a plus de raison d'être : on marche, et un nouvel Espace saute.
    if (this.onGround) { this.planant = false; this.reacteurs = false; }

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
//
// Le départ du voile était pris à 45 % et sa fin à 85 % de la portée : mesuré à midi,
// toute le relief au-delà de la moitié du champ rendu rendait la seule couleur de brume
// — l'utilisateur voyait « des cubes tous blancs à l'horizon ». Le brouillard ne garde
// que sa vraie tâche, dissoudre la lisière ; le milieu du champ garde ses matières.
// Le référentiel « temps sec » est gardé à part : l'averse resserre la brume autour de
// ces deux valeurs (`majCiel`) et doit les retrouver exactement quand elle se retire,
// sans quoi un réglage de profondeur de champ fait après une pluie hériterait du ciel bas.
const brumeSere = { near: 30, far: 60 };
function applyFogForDistance(radius) {
  brumeSere.near = Math.max(6, radius * CHUNK_SIZE * 0.62);
  brumeSere.far = radius * CHUNK_SIZE * 0.98;
  scene.fog.near = brumeSere.near;
  scene.fog.far = brumeSere.far;
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

// ==================== CIEL, SOLEIL ET LANTERNES ====================
// Le modèle du ciel est pur (`ciel.js`) ; tout ici se contente de le consommer. Rien
// n'est re-maillé pour faire la nuit : l'heure ne pilote que les lumières de scène, la
// brume et les objets du ciel. Les deux canaux cuits dans les sommets (obscurité des
// grottes, halo des lanternes) sont indépendants de l'heure, sauf l'uniforme qui allume
// ou éteint les lanternes.
const horloge = creerHorloge({ duree: settings.dureeJour });
let etatCiel = etatDuCiel(horloge.heure());

// Les objets du ciel suivent la caméra et se paient le luxe d'un test de profondeur
// désactivé avec un ordre de rendu négatif : ils sont peints avant le terrain, qui les
// recouvre — le soleil se couche donc derrière une colline au lieu de la traverser.
const PLANETE_CIEL = new THREE.Group();
PLANETE_CIEL.renderOrder = -10;
scene.add(PLANETE_CIEL);

const domeGeo = new THREE.SphereGeometry(1, 32, 16);
// Les shaders maison écrivent `gl_FragColor` à la main : Three n'y insère jamais
// l'encodage de sortie que reçoivent les matériaux built-in. Les couleurs passées en
// uniforme sont pourtant déjà converties en linéaire par ColorManagement — écrites
// telles quelles dans un framebuffer sRGB, elles rendent deux fois trop sombre
// (mesuré : #808080 → 55,55,55 et #9dc3e4 → 86,139,198 au lieu de 128,128,128 et
// 157,195,228). La brume des tronçons, elle, suit le bon pipeline et garde sa valeur.
// C'est tout l'écart du « tout est blanc à l'horizon » : le relief lointain se peignait
// à luminance ~148 contre ~112 pour le ciel qui le surmonte, la bande d'horizon
// devenant l'élément le plus clair de l'image. Ces deux shaders doivent donc encoder
// comme le reste de la scène.
const GLSL_VERS_SRGB = /* glsl */`
  vec3 versSRGB(vec3 c) {
    vec3 v = clamp(c, 0.0, 1.0);
    return mix(v * 12.92, pow(v, vec3(1.0 / 2.4)) * 1.055 - 0.055, step(vec3(0.0031308), v));
  }`;
const domeUniformes = {
  uZenith: { value: new THREE.Color(0x87ceeb) },
  uHorizon: { value: new THREE.Color(0xcfe6f5) },
  uDirectionSoleil: { value: new THREE.Vector3(0, 1, 0) },
  uHalo: { value: 0 },
};
const dome = new THREE.Mesh(domeGeo, new THREE.ShaderMaterial({
  uniforms: domeUniformes,
  side: THREE.BackSide,
  depthWrite: false,
  depthTest: false,
  fog: false,
  vertexShader: /* glsl */`
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 uZenith;
    uniform vec3 uHorizon;
    uniform vec3 uDirectionSoleil;
    uniform float uHalo;
    varying vec3 vDir;
    ${GLSL_VERS_SRGB}
    void main() {
      float t = clamp(vDir.y * 1.35 + 0.08, 0.0, 1.0);
      vec3 col = mix(uHorizon, uZenith, pow(t, 0.65));
      // Le renard autour de l'astre : un lavis chaud, serré contre lui et d'amplitude
      // bornée. Large (pow(face, 6)) et franc (×0,85), il blanchissait toute la bande
      // d'horizon dès que le soleil la frôlait — une centaine de degrés de ciel partait
      // au blanc, ce que l'utilisateur décrivait comme « à l'horizon tout est blanc ».
      float face = max(dot(normalize(vDir), normalize(uDirectionSoleil)), 0.0);
      col += uHalo * pow(face, 18.0) * vec3(0.55, 0.30, 0.13);
      gl_FragColor = vec4(versSRGB(col), 1.0);
    }`,
}));
dome.renderOrder = -10;
PLANETE_CIEL.add(dome);

const disqueGeo = new THREE.CircleGeometry(1, 40);
// Rayons apparents des astres, en radians — l'échelle est recalculée avec la distance
// pour qu'ils gardent cette taille quelle que soit la profondeur de champ réglée.
const RAYON_SOLEIL_APPARENT = 0.034;
const RAYON_LUNE_APPARENTE = 0.0277;
function faireDisque(couleur, opacite) {
  const m = new THREE.Mesh(disqueGeo, new THREE.MeshBasicMaterial({
    color: couleur, transparent: true, opacity: opacite,
    // Test de profondeur **activé** : un matériau transparent est peint après tout le
    // relief opaque, donc sans test il flotterait au-dessus des toits et de la roche
    // (mesuré : un mur plein à six cubes laissait passer 38 % de pixels lunaires).
    // Les astres sont placés juste sous le plan lointain dans `majCiel`, si bien que
    // n'importe quel bloc est plus près qu'eux et les masque — « à l'infini », ici.
    depthWrite: false, depthTest: true, fog: false, side: THREE.DoubleSide,
  }));
  m.renderOrder = -9;
  PLANETE_CIEL.add(m);
  return m;
}
const disqueSoleil = faireDisque(0xfff2cc, 1);
const disqueLune = faireDisque(0xd8e2ff, 0.92);
disqueSoleil.name = 'soleil';
disqueLune.name = 'lune';

// Étoiles : une calotte fixe, tirée au même hachage que le reste du monde pour qu'un
// rechargement ne redessine pas un ciel différent.
const etoiles = (() => {
  const N = 700;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    // Répartition quasi uniforme sur la sphère haute, par angles tirés au hasard déterministe.
    const azimut = hashRoll(i, 1, 3, 71) * Math.PI * 2;
    const hauteur = Math.acos(1 - hashRoll(i, 2, 5, 73) * 1.05);
    const rayon = 1;
    pos[i * 3] = Math.sin(hauteur) * Math.cos(azimut) * rayon;
    pos[i * 3 + 1] = Math.cos(hauteur) * rayon;
    pos[i * 3 + 2] = Math.sin(hauteur) * Math.sin(azimut) * rayon;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xffffff, size: 2.2, sizeAttenuation: false,
    // Même règle que les disques : sans test de profondeur, les étoiles traversent la
    // roche et les toits, le ciel nocturne se peignant par-dessus le monde.
    transparent: true, opacity: 0, depthWrite: false, depthTest: true, fog: false,
  }));
  pts.renderOrder = -9;
  pts.visible = false;
  PLANETE_CIEL.add(pts);
  return pts;
})();

// Nuages : une nappe continue, pas des cubes. Deux plans horizontaux tendus au-dessus
// du monde et tendus d'un dessin de bouffissures douces, peint une fois pour toutes
// dans un canevas. Un plan texturé plutôt qu'une couche de voxels, pour trois raisons :
// la forme d'un nuage n'a aucune raison d'être cubique, deux triangles par couche coûtent
// moins qu'un tronçon entier, et le ciel n'a rien à partager avec le monde — un nuage
// que le joueur pourrait creuser n'a pas de sens.
const NUAGE_TEXELLE = 256;   // résolution du dessin, en pixels

/**
 * Dessine une tuile de ciel déterministe : des amas de halos superposés, étirés à
 * l'horizontale comme des cumulus. Chaque halo est peint sur les neuf positions
 * possibles de la tuile, sans quoi la couture d'une répétition se verrait en grille.
 */
function dessinerTuileDeNuages(sel) {
  const c = document.createElement('canvas');
  c.width = NUAGE_TEXELLE; c.height = NUAGE_TEXELLE;
  const g = c.getContext('2d');
  g.clearRect(0, 0, NUAGE_TEXELLE, NUAGE_TEXELLE);
  for (let i = 0; i < 17; i++) {
    const ax = hashRoll(i, sel, 1, 4111) * NUAGE_TEXELLE;
    const az = hashRoll(i, sel, 2, 4127) * NUAGE_TEXELLE;
    const coeur = 0.32 + hashRoll(i, sel, 4, 4151) * 0.24;
    const lobes = 4 + Math.floor(hashRoll(i, sel, 3, 4133) * 5);
    for (let k = 0; k < lobes; k++) {
      const ang = hashRoll(i, k, sel + 7, 4177) * Math.PI * 2;
      const ecart = hashRoll(i, k, sel + 11, 4201) * 0.34;
      const r = (0.05 + hashRoll(i, k, sel + 13, 4211) * 0.1) * NUAGE_TEXELLE;
      const x = ax + Math.cos(ang) * ecart * NUAGE_TEXELLE;
      const y = az + Math.sin(ang) * ecart * NUAGE_TEXELLE * 0.6;
      for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
        const px = x + ox * NUAGE_TEXELLE;
        const py = y + oz * NUAGE_TEXELLE;
        if (px < -r || px > NUAGE_TEXELLE + r || py < -r || py > NUAGE_TEXELLE + r) continue;
        const grad = g.createRadialGradient(px, py, 0, px, py, r);
        grad.addColorStop(0, `rgba(255,255,255,${coeur.toFixed(3)})`);
        grad.addColorStop(0.55, `rgba(255,255,255,${(coeur * 0.45).toFixed(3)})`);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.arc(px, py, r, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
const NUAGES_TEXTE = dessinerTuileDeNuages(1);

// Le fondu se juge sur l'élévation du rayon visuel, jamais sur la brume de scène : la
// nappe flotte quatre-vingts cubes au-dessus de la tête, donc tout ce qui frôle
// l'horizon est déjà au-delà du plan lointain. S'en remettre à `fog` reviendrait à
// peindre un voile blanc sur toute la bande d'horizon — exactement le lavage que
// l'utilisateur reprochait au plein jour. L'autre moitié du fondu se cale sur le plan
// lointain de la caméra (`uPortee`) : sans elle, le plan est simplement tronqué par le
// volume de vue et la nappe présente une arête circulaire.
const SHADER_NUAGE = /* glsl */`
  uniform sampler2D uCarte;
  uniform vec3 uCouleur;
  uniform float uOpacite;
  uniform vec3 uCam;
  uniform float uPortee;
  varying vec2 vUv;
  varying vec3 vMonde;
  ${GLSL_VERS_SRGB}
  void main() {
    vec3 dir = vMonde - uCam;
    float l = max(length(dir), 1e-4);
    // Valeur absolue : vu d'en dessous comme d'en dessus, le nuage reste un voile.
    float elevation = abs(dir.y) / l;
    float voile = smoothstep(0.055, 0.34, elevation)
                * (1.0 - smoothstep(uPortee * 0.72, uPortee, l));
    float corps = texture2D(uCarte, vUv).a;
    float a = corps * uOpacite * voile;
    if (a < 0.004) discard;
    // Le cœur dense prend tout son éclat, la bordure reste laiteuse : c'est ce dégradé
    // qui fait un volume plutôt qu'une tache plate collée au ciel.
    gl_FragColor = vec4(versSRGB(uCouleur * (0.82 + 0.18 * corps)), a);
  }`;

function faireNape(nom, altitude, tuile, facteur, vitesse) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    uniforms: {
      uCarte: { value: NUAGES_TEXTE },
      uCouleur: { value: new THREE.Color(0xffffff) },
      uOpacite: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uPortee: { value: 400 },
      // Le tuilage se fait ici et non sur la texture : un ShaderMaterial ne consulte
      // jamais `texture.repeat` ni `texture.offset`, qui ne vivent que dans la matrice
      // `map_transform` des matériaux built-in. Poser l'ancrage sur ces derniers laissait
      // le ciel glisser avec le joueur tout en annonçant une dérive nulle au contrôle.
      uTuile: { value: new THREE.Vector2(1, 1) },
      uDecalage: { value: new THREE.Vector2(0, 0) },
    },
    vertexShader: /* glsl */`
      uniform vec2 uTuile;
      uniform vec2 uDecalage;
      varying vec2 vUv;
      varying vec3 vMonde;
      void main() {
        vUv = uv * uTuile + uDecalage;
        vec4 monde = modelMatrix * vec4(position, 1.0);
        vMonde = monde.xyz;
        gl_Position = projectionMatrix * viewMatrix * monde;
      }`,
    fragmentShader: SHADER_NUAGE,
    transparent: true,
    depthWrite: false,
    // Test de profondeur activé, comme les astres : depuis une grotte ou sous un toit,
    // la roche est plus près qu'elle et doit la masquer.
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
  }));
  // Rotation qui pose le plan à l'horizontale : l'axe local +y part vers −z monde, d'où
  // le signe inversé sur l'axe v dans `majCiel`.
  m.rotation.x = -Math.PI / 2;
  // Un rang sous les astres (-9) : le centre de la nappe est confondu avec la caméra,
  // donc à tri égal Three la peindrait en dernier, par-dessus le soleil.
  m.renderOrder = -10;
  m.name = 'nuages';
  m.userData = { nom, altitude, tuile, facteur, vitesse };
  PLANETE_CIEL.add(m);
  return m;
}
const nappes = [
  // Les deux couches se posent **au-dessus du sol sous le joueur**, pas à une altitude
  // absolue : à cent trente cubes de hauteur fixes, le plan lointain de la caméra (deux
  // cents cubes à la portée par défaut) n'en laissait voir qu'une calotte de vingt
  // degrés autour du zénith. En épousant le relief, la nappe basse reste à quatre-vingt
  // quatre cubes au-dessus de la tête et couvre le ciel jusqu'à vingt-cinq degrés.
  faireNape('basse', 84, 96, 1, 0.0032),
  faireNape('haute', 130, 152, 0.62, 0.0019),
];

// ==================== PLUIE ====================
// Le modèle de l'averse est pur (`meteo.js`), comme celui du ciel : il ne rend rien, il
// décide d'une intensité. Tout ici la consomme — lumières, brume, nuages, et le rideau
// de gouttes ci-dessous.
const METEO_SEL = (WORLD_SEEDS.trees * 6151) | 0;   // deux mondes différents, deux météos
const meteo = creerMeteo({ sel: METEO_SEL, mode: settings.meteo });
// Une suite fige l'averse pour la juger sans attendre vingt minutes d'horloge ; `null`
// rend la main au monde.
let pluieForcee = null;
const intensitePluie = () => (pluieForcee == null ? meteo.etat().intensite : pluieForcee);

// ---- le rideau de gouttes ---------------------------------------------------
// Des points, pas des voxels : une goutte n'a rien à partager avec le monde, et quelques
// milliers de sprites coûtent moins cher qu'un tronçon. Tout le mouvement vit dans le vertex
// shader — la chute s'enroule sur `uTemps`, le vent dérive chaque goutte selon sa graine
// — donc aucun tableau n'est renvoyé au GPU image après image. La densité se règle par
// seuil sur cette même graine : épaissir l'averse ne reconstruit rien.
const PLUIE_POINTS = 4500;
const PLUIE_BOITE = new THREE.Vector3(52, 34, 52);   // le volume de gouttes autour de la tête
const COULEUR_PLUIE_NUIT = new THREE.Color(0x6f7f92);
const COULEUR_PLUIE_JOUR = new THREE.Color(0xdfeaf7);

const SHADER_PLUIE = /* glsl */`
  uniform vec3 uBoite;
  uniform float uTemps;
  uniform float uDerive;
  uniform float uTaille;
  uniform float uPortee;
  uniform float uDensite;
  attribute float aVitesse;
  attribute float aGraine;
  varying float vVoile;
  void main() {
    vec3 p = position;
    p.y = mod(p.y - uTemps * aVitesse + uBoite.y * 0.5, uBoite.y) - uBoite.y * 0.5;
    p.x = mod(p.x + uTemps * uDerive * (0.6 + 0.8 * aGraine) + uBoite.x * 0.5, uBoite.x) - uBoite.x * 0.5;
    vec4 oeil = viewMatrix * modelMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * oeil;
    float d = max(-oeil.z, 1.0);
    // Taille bornée : un point collé à la caméra couvrirait l'écran au lieu de tremper.
    gl_PointSize = clamp(uTaille * (34.0 / d), 1.0, 22.0);
    vVoile = (1.0 - smoothstep(uPortee * 0.55, uPortee, d)) * step(aGraine, uDensite);
  }`;

const SHADER_PLUIE_FRAGMENT = /* glsl */`
  uniform vec3 uCouleur;
  uniform float uOpacite;
  uniform float uPente;
  varying float vVoile;
  ${GLSL_VERS_SRGB}
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    q.x -= q.y * uPente;                       // la traînée est inclinée, pas verticale
    // Les deux lisseurs définissent la goutte : une baguette haute et étroite. Étroits,
    // ils ne laissaient peindre que six centièmes de pour cent de l'image à midi — une
    // averse qu'on ne voit pas. Mesurés après reprise : quelques pour cents, ce que l'œil
    // lit comme de la pluie.
    float trait = (1.0 - smoothstep(0.06, 0.30, abs(q.x)))
                * (1.0 - smoothstep(0.04, 0.52, abs(q.y)));
    float a = trait * uOpacite * vVoile;
    if (a < 0.01) discard;
    gl_FragColor = vec4(versSRGB(uCouleur), a);
  }`;

function faireRideauDePluie() {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(PLUIE_POINTS * 3);
  const vitesses = new Float32Array(PLUIE_POINTS);
  const graines = new Float32Array(PLUIE_POINTS);
  for (let i = 0; i < PLUIE_POINTS; i++) {
    pos[i * 3] = (hashRoll(i, 1, 7, 9101) - 0.5) * PLUIE_BOITE.x;
    pos[i * 3 + 1] = (hashRoll(i, 2, 7, 9103) - 0.5) * PLUIE_BOITE.y;
    pos[i * 3 + 2] = (hashRoll(i, 3, 7, 9107) - 0.5) * PLUIE_BOITE.z;
    vitesses[i] = 16 + hashRoll(i, 4, 7, 9109) * 12;   // cubes par seconde
    graines[i] = hashRoll(i, 5, 7, 9127);               // densité et dérive individuelles
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aVitesse', new THREE.BufferAttribute(vitesses, 1));
  geo.setAttribute('aGraine', new THREE.BufferAttribute(graines, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), PLUIE_BOITE.length() * 0.6);
  const m = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms: {
      uBoite: { value: PLUIE_BOITE.clone() },
      uTemps: { value: 0 },
      uDerive: { value: 3.4 },
      uTaille: { value: 6.5 },
      uPortee: { value: 90 },
      uCouleur: { value: new THREE.Color(0xdfeaf7) },
      uOpacite: { value: 0 },
      uPente: { value: 0.34 },
      uDensite: { value: 0 },
    },
    vertexShader: SHADER_PLUIE,
    fragmentShader: SHADER_PLUIE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    // Test de profondeur actif : la roche devant la caméra doit cacher les gouttes, sinon
    // une grotte se remplissait de pluie. Le reste du travail se fait dans `majCiel`, qui
    // éteint le rideau sous un toit.
    depthTest: true,
    fog: false,
  }));
  m.name = 'pluie';
  // Le volume suit la caméra : le culler sur une boîte locale reviendrait à faire
  // disparaître la pluie dès qu'elle regarde ailleurs.
  m.frustumCulled = false;
  m.renderOrder = 6;          // après le relief et les blocs translucides
  m.visible = false;
  scene.add(m);
  return m;
}
const rideauPluie = faireRideauDePluie();

// Sous terre, les lanternes tiennent allumées en plein jour : c'est la roche au-dessus
// de la tête qui décide, pas l'heure. Le relevé se paie une fois par quart de seconde,
// pas par image — c'est une descente de colonne, pas un calcul gratuit.
const HAUT = new THREE.Vector3(0, 1, 0);
let lanterneVivet = etatCiel.lampes;
let dernierReleveToit = -10;
let toitVu = false;
function sousTerre(maintenant) {
  if (maintenant - dernierReleveToit > 0.25) {
    dernierReleveToit = maintenant;
    const hit = raycastVoxel(camera.position, HAUT, 48, true);
    toitVu = !!hit && hit.t < 48;
  }
  return toitVu;
}

// L'altitude d'ancrage des nappes s'appuie sur une **moyenne régionale** du relief,
// lissée dans le temps — jamais sur la colonne sous les pieds. Jugée cube par cube, la
// nappe suivait le gradin du terrain : mesuré sur une ligne droite de vingt-quatre
// cubes, la hauteur de la couche basse passait de 100 à 114 puis retombait à 100, et
// un même nuage se déplaçait de trente-sept pixels à l'écran, pour un joueur qui avance
// à plat (« les nuages ne sont pas stables, ils bougent quand je marche »). Une sonde
// prise tous les trente-deux cubes sur cent quatre-vingt-douze cubes de large ne bouge
// quasiment plus d'un pas à l'autre ; l'amortissement efface ce qui reste.
const NAPPE_PAS_SONDE = 32;
const NAPPE_RAYON_SONDE = 96;
const NAPPE_INTERVALE_SONDE = 0.5;   // secondes entre deux relevés du relief
const NAPPE_TAU = 0.8;               // rapidité de rattrapage de l'ancrage
let solNappe = null;
let cibleSolNappe = 0;
let derniereSondeNappe = -10;

function sonderRelief(x, z) {
  let somme = 0, n = 0;
  for (let dx = -NAPPE_RAYON_SONDE; dx <= NAPPE_RAYON_SONDE; dx += NAPPE_PAS_SONDE) {
    for (let dz = -NAPPE_RAYON_SONDE; dz <= NAPPE_RAYON_SONDE; dz += NAPPE_PAS_SONDE) {
      somme += getTerrainHeight(Math.floor(x + dx), Math.floor(z + dz));
      n++;
    }
  }
  return n ? somme / n : getTerrainHeight(Math.floor(x), Math.floor(z));
}

function majAncrageNappe(delta, maintenant, x, z) {
  if (solNappe === null || maintenant - derniereSondeNappe > NAPPE_INTERVALE_SONDE) {
    derniereSondeNappe = maintenant;
    cibleSolNappe = sonderRelief(x, z);
    // Un saut brutal n'est pas une pente : après une téléportation ou un respawn, la
    // nappe prend la nouvelle valeur sans glisser sur une demi-seconde.
    if (solNappe === null || Math.abs(cibleSolNappe - solNappe) > 32) solNappe = cibleSolNappe;
  }
  solNappe += (cibleSolNappe - solNappe) * Math.min(1, delta * NAPPE_TAU);
  return solNappe;
}

const heureEl = document.getElementById('clock');

/** Applique l'état du ciel aux lumières, à la brume et aux objets du ciel. */
function majCiel(delta, maintenant) {
  const e = etatCiel;

  ambientLight.color.setHex(e.ambiante.couleur);
  ambientLight.intensity = e.ambiante.intensite;
  sunLight.color.setHex(e.directe.couleur);
  sunLight.intensity = e.directe.intensite;
  sunLight.position.set(e.soleil[0] * 120, Math.abs(e.soleil[1]) * 120 + 8, e.soleil[2] * 120);

  scene.background.setHex(e.ciel);
  scene.fog.color.setHex(e.brume);

  // Le dôme prend le dessus sur le fond uni dès qu'il est devant la caméra.
  const distance = Math.max(120, Math.min(camera.far * 0.55, 900));
  PLANETE_CIEL.position.copy(camera.position);
  dome.scale.setScalar(distance);
  domeUniformes.uZenith.value.setHex(e.ciel);
  domeUniformes.uHorizon.value.setHex(e.horizon);
  domeUniformes.uDirectionSoleil.value.set(e.soleil[0], e.soleil[1], e.soleil[2]);
  domeUniformes.uHalo.value = Math.max(0, 1 - Math.abs(e.hauteur) * 2.4) * 0.7;

  // Les astres se logent juste sous le plan lointain, et non à une distance « commode » :
  // avec leur test de profondeur activé, tout bloc rendu est plus près qu'eux et les
  // masque, alors qu'ils ne recouvrent jamais un cube. C'est ce que veut dire « affichés
  // à l'infini » pour des objets collés à la caméra. Leur rayon apparent reste constant
  // parce que l'échelle suit la distance ; les étoiles restent derrière les disques.
  const astres = camera.far * 0.995;
  disqueSoleil.position.set(e.soleil[0], e.soleil[1], e.soleil[2]).multiplyScalar(astres);
  disqueSoleil.lookAt(camera.position);
  disqueSoleil.scale.setScalar(astres * RAYON_SOLEIL_APPARENT);
  disqueSoleil.visible = e.hauteur > -0.12;

  disqueLune.position.set(e.lune[0], e.lune[1], e.lune[2]).multiplyScalar(astres);
  disqueLune.lookAt(camera.position);
  disqueLune.scale.setScalar(astres * RAYON_LUNE_APPARENTE);
  disqueLune.visible = e.hauteur < 0.12;

  etoiles.material.opacity = e.etoiles;
  etoiles.visible = e.etoiles > 0.02;
  etoiles.scale.setScalar(camera.far * 0.998);

  // Les nappes suivent la caméra en x/z mais restent **ancrées au monde** : le plan se
  // recentre sur le joueur à chaque image et ses UV compensent exactement ce parcours,
  // sinon le ciel glisserait avec lui comme un plafond peint. L'axe v garde un signe
  // inversé parce que la rotation envoie l'axe local +y vers −z monde.
  const cote = Math.max(360, camera.far * 2.4);
  const sol = majAncrageNappe(delta, maintenant, camera.position.x, camera.position.z);
  for (const nappe of nappes) {
    const u = nappe.userData;
    const mat = nappe.material;
    nappe.position.y = u.altitude + sol - camera.position.y;   // le groupe suit déjà la caméra
    nappe.scale.set(cote, cote, 1);
    const rpt = cote / u.tuile;
    mat.uniforms.uTuile.value.set(rpt, rpt);
    mat.uniforms.uDecalage.value.set(
      camera.position.x / u.tuile + maintenant * u.vitesse,
      -camera.position.z / u.tuile + maintenant * u.vitesse * 0.6,
    );
    mat.uniforms.uCouleur.value.setHex(e.nuages.couleur);
    mat.uniforms.uOpacite.value = e.nuages.opacite * u.facteur;
    mat.uniforms.uCam.value.copy(camera.position);
    // Le fondu lointain meurt sur le plan lointain lui-même, pas sur le bord du plan
    // géométrique : c'est le seul repère qui garantisse que rien n'est tronqué en vol.
    mat.uniforms.uPortee.value = camera.far * 0.99;
    nappe.visible = mat.uniforms.uOpacite.value > 0.02;
  }

  // ---- l'averse ----
  // Trois choses seulement : la brume se resserre (c'est le ciel bas), les gouttes
  // tombent, et elles s'arrêtent sous un toit. Les lumières et les teintes viennent
  // déjà grevées du modèle (`cielSousPluie`), rien n'est recompté ici.
  const averse = e.pluie || 0;
  const serre = 1 - 0.42 * averse;
  scene.fog.near = Math.max(3, brumeSere.near * serre);
  scene.fog.far = brumeSere.far * serre;
  rideauPluie.position.copy(camera.position);
  rideauPluie.visible = averse > 0.02 && !sousTerre(maintenant);
  if (rideauPluie.visible) {
    const u = rideauPluie.material.uniforms;
    u.uTemps.value = maintenant;
    u.uDensite.value = averse;
    u.uOpacite.value = 0.40 + 0.28 * averse;
    u.uPortee.value = Math.min(90, camera.far * 0.5);
    u.uCouleur.value.copy(COULEUR_PLUIE_NUIT).lerp(COULEUR_PLUIE_JOUR, e.jour);
  }

  // Lanternes : franches la nuit et sous terre, éteintes en plein jour. La montée est
  // amortie pour que le crépuscule allume la ville progressivement plutôt que d'un coup.
  const cible = Math.max(e.lampes, sousTerre(maintenant) ? 1 : 0);
  lanterneVivet += (cible - lanterneVivet) * Math.min(1, delta * 2.2);
  if (Math.abs(lanterneVivet - cible) < 0.004) lanterneVivet = cible;
  const w = world;
  if (w) w.uniformeLampe.value.setScalar(TEINTE_LAMPE * lanterneVivet);

  if (heureEl) {
    const texte = `${heureAffichee(e.heure)} · ${e.phase}`;
    if (heureEl.textContent !== texte) heureEl.textContent = texte;
  }
}

// Remet le ciel à jour sur-le-champ. Le bucle d'images le fait déjà image après image,
// mais une suite (comme le joueur qui change de réglage derrière le panneau) veut lire
// la valeur dans la foulée : `delta` petit garde l'allumage des lanternes amorti, seul
// canal qui le soit.
function rafraichirCiel(delta = 1 / 60, maintenant = performance.now() / 1000) {
  etatCiel = cielSousPluie(etatDuCiel(horloge.heure()), intensitePluie());
  majCiel(delta, maintenant);
  return etatCiel;
}

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
// silhouette. It is drawn *with* a depth test on purpose: without one the square stayed
// painted through hills and the player dug at cubes they could not see. Depth-tested
// lines lose against the very block they wrap and paint nothing at all, so the vertices
// are pulled a few centimetres toward the eye (see biaisVersLOeil).
const BIAIS_MARKERS = 0.06;   // cubes vers l'œil, en espace caméra
/**
 * Rend un filaire lisible sans le trahir : test de profondeur actif, plus un léger
 * rappel des sommets vers la caméra. Ce qui n'est que confondu avec la surface du cube
 * visé se détache ; ce qui a vraiment un relief devant soi reste caché, pixel par pixel.
 * Le décalage se compte en espace caméra — un biais en coordonnées clip serait une
 * distance différente à chaque profondeur et traverserait la colline qu'il doit cacher.
 */
function biaisVersLOeil(materiau) {
  materiau.depthTest = true;
  materiau.depthWrite = false;
  materiau.onBeforeCompile = (shader) => {
    // L'inclusion d'origine reste en place (instancing, batching) ; on ne fait que
    // rejeter la projection avec la position caméra rappelée vers l'œil.
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      #include <project_vertex>
      mvPosition.z += ${BIAIS_MARKERS.toFixed(3)};
      gl_Position = projectionMatrix * mvPosition;
    `);
    if (!shader.vertexShader.includes('mvPosition.z +=')) {
      // Une mise à jour de three qui changerait l'inclusion rendrait les marqueurs
      // invisibles en silence — le défaut d'avant, exactement. Mieux vaut le dire.
      console.warn('biais des marqueurs non appliqué : <project_vertex> introuvable dans le vertex shader');
    }
  };
  // Deux matériaux partagent le même programme : sans clé propre, three les confondrait
  // avec le filaire ordinaire et l'un des deux resterait aveugle à la profondeur.
  materiau.customProgramCacheKey = () => 'mycraft-biais-markers';
  return materiau;
}

const highlightGeo = new THREE.BoxGeometry(1.04, 1.04, 1.04);
const highlightMat = biaisVersLOeil(new THREE.LineBasicMaterial({
  color: 0x000000, linewidth: 2,
}));
const highlight = new THREE.LineSegments(new THREE.EdgesGeometry(highlightGeo), highlightMat);
highlight.visible = false;
highlight.renderOrder = 13;
scene.add(highlight);

// Crosshair face marker: until a click arms a selection, the square sits *on* the face
// being aimed at, which says both which cube and which side of it is targeted. Inset
// into the face so it reads against the texture instead of merging with the block edge.
const faceMarker = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.PlaneGeometry(0.9, 0.9)),
  biaisVersLOeil(new THREE.LineBasicMaterial({ color: 0x000000 })),
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
  // Same bias as the highlight: the frame must not be painted through the hills it
  // crosses, or the player reads a cuboid that half of them hides.
  biaisVersLOeil(new THREE.LineBasicMaterial({ color: 0xffffff })),
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
  // L'écran de réglage du monde est un écran de saisie : le clavier lui appartient, à
  // l'exception d'Échap qui le referme. Sans ce garde, un Z tapé dans le champ de la
  // graine ferait marcher le joueur derrière le panneau.
  if (reglageOuvert) {
    if (e.code === 'Escape') {
      e.preventDefault();
      fermerReglageDuMonde();
    }
    return;
  }

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
// Returns { x, y, z, nx, ny, nz, t } of the first block the crosshair can reach, or null;
// t is how far along the (normalised) ray that block was entered. Par défaut le rayon
// s'arrête sur tout ce qui se laisse viser — le plein comme le mobilier mural non solide —
// et `neViserQueLePlein` le rend aveugle à ce dernier (le sondeur de plafond, par exemple,
// ne doit pas croire qu'une applique au-dessus de la tête est un toit).
function raycastVoxel(origin, dir, maxDist, neViserQueLePlein = false) {
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
  let premier = true;

  while (t <= maxDist) {
    // La toute première cellule est celle d'où part le rayon : on n'y vise rien. Sans cette
    // réserve, un joueur qui traverse une applique — elle n'est pas solide, on marche
    // dedans — casserait l'applique dès qu'il regarderait devant lui.
    const cible = (!premier && !neViserQueLePlein)
      ? world.isTargetable(bx, by, bz) : world.isSolid(bx, by, bz);
    if (cible) {
      return { x: bx, y: by, z: bz, nx, ny, nz, t };
    }
    premier = false;

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
let lastInfoText = null;

/** Ce qui occupe le joueur cette image : ses jambes, ses réacteurs, ses ailes. */
function modeJoueur() {
  if (player.flyMode) return 'Survol (debug)';
  if (player.planant) {
    // Le planeur obéit au regard : dire l'allure sans dire si elle monte laisserait
    // le pilote juger son altitude à l'œil nu. Bandes larges — un texte qui changerait
    // chaque image annulerait la garde de `updateInfo`.
    const vy = player.velocity.y;
    const cap = vy > 0.5 ? 'en montée' : vy < -0.5 ? 'en descente' : 'à plat';
    return `Plané ${Math.round(player.vitesseVol)} c/s · ${cap}`;
  }
  if (player.reacteurs) return 'Réacteurs';
  return 'Marche';
}

function updateInfo() {
  const pos = camera.position;
  const blockName = BLOCK_INFO[player.selectedBlock]?.name || 'Unknown';
  // Le mode change à chaque geste sur Espace : affiché seulement à la seconde, il
  // resterait une image derrière la réalité. D'où la garde sur le texte complet.
  const texte = `
    XYZ: ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}
    Bloc: ${blockName}
    Mode: ${modeJoueur()}
    FPS: ${fps}
  `;
  if (texte === lastInfoText) return;
  lastInfoText = texte;
  info.textContent = texte;
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

// ---- durée de la journée ----
const jourInput = document.getElementById('day-length');
const jourValue = document.getElementById('day-length-value');

function decrireDureeJour(secondes) {
  const s = bornerDuree(secondes);
  if (s < 120) return `${s} secondes`;
  const m = s / 60;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} minute${m > 1 ? 's' : ''}`;
}

function syncDayControl() {
  if (!jourInput) return;
  jourInput.min = String(DUREE_JOUR_BORNES.min);
  jourInput.max = String(DUREE_JOUR_BORNES.max);
  jourInput.step = '30';
  jourInput.value = String(settings.dureeJour);
  jourValue.textContent = decrireDureeJour(settings.dureeJour);
}

function setDayLength(value) {
  const next = bornerDuree(value);
  settings.dureeJour = next;
  horloge.reglerDuree(next);   // le monde en cours accélère ou ralentit sans changer d'heure
  syncDayControl();
  saveSettings();
  return next;
}

syncDayControl();
if (jourInput) jourInput.addEventListener('input', () => setDayLength(jourInput.value));

// ---- météo ----
// Le réglage ne fait que choisir le régime ; c'est `meteo.js` qui décide de l'averse.
// « Averse continue » sert aussi bien au joueur qui veut la pluie qu'aux suites, qui ne
// peuvent pas attendre qu'un épisode se présente.
const meteoSelect = document.getElementById('meteo-mode');
const meteoValue = document.getElementById('meteo-mode-value');
const METEO_LIBELLES = { auto: 'automatique', jamais: 'ciel clair', toujours: 'averse' };

function syncMeteoControl() {
  if (!meteoSelect) return;
  meteoSelect.value = settings.meteo;
  if (meteoValue) meteoValue.textContent = METEO_LIBELLES[settings.meteo];
}

function setMeteoMode(value) {
  const next = METEO_MODES.includes(value) ? value : 'auto';
  settings.meteo = next;
  meteo.reglerMode(next);
  pluieForcee = null;   // une reprise en main de test ne survit pas à un changement de réglage
  rafraichirCiel();     // l'aperçu derrière le panneau doit changer tout de suite
  syncMeteoControl();
  saveSettings();
  return next;
}

syncMeteoControl();
if (meteoSelect) meteoSelect.addEventListener('input', () => setMeteoMode(meteoSelect.value));

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
  // Échap ouvre cet écran : le bouton d'enregistrement s'y présente dans l'état réel du
  // disque, et sa note explique une bonne fois ce que l'autosauvegarde fait déjà seule.
  majBoutonEnregistrer();
  if (saveNote && !saveNote.textContent) {
    saveNote.textContent = `Le monde s’économise seul toutes les ${Math.round(AUTOSAVE_INTERVAL_MS / 1000)} s ; ce bouton écrit tout de suite.`;
  }
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
// `SAVE_SLOT` et `SAVE_PARAMS` viennent du haut du module : la fiche de génération du
// monde doit être connue avant le premier tronçon.
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
let finECriture = Promise.resolve();   // sa promesse : qui demande une écriture l'attend
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

// True between « Régénérer ce monde » et le rechargement : la page tient encore en
// mémoire l'ancienne fiche, et une autosauvegarde qui partirait à ce moment-là la
// réécrirait sur le disque — où elle reprendrait raison au démarrage suivant.
let regenerEnCours = false;

async function flushWorldSave({ force = false, beacon = false } = {}) {
  if (regenerEnCours) return false;
  if (!worldReady) return false;
  // Une écriture est déjà partie (l'économise périodique, un clic précédent) : on l'attend
  // au lieu de repartir les mains vides. Faire semblant d'enregistrer ferait croire au
  // demandeur que le disque n'est pas à jour alors qu'il vient de le devenir.
  if (writingSave) await finECriture;
  // `force` lifts the throttle (unload, world switch), it never invents work: an
  // unchanged world is left alone on the disk.
  if (!needsWorldSave()) return false;
  const now = performance.now();
  if (!force && now - lastWriteAt < AUTOSAVE_INTERVAL_MS) return false;
  const text = encodeSave({
    seed: WORLD_SEEDS, name: worldName, player: player.saveState(),
    edits: world.modifiedBlocks, monde: MONDE, flux: world.eauNiveaux,
  });

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
  finECriture = (async () => {
    try {
      await saveStore.save(text);
      markWorldWritten();
      return true;
    } catch (e) {
      console.warn('Sauvegarde impossible :', e);
      saveDirty = true; // le prochain réveil de l'économise reprendra le diff
      return false;
    } finally {
      writingSave = false;
    }
  })();
  return finECriture;
}

// L'économise automatique ne se paie plus par image : l'écran d'accueil peut dormir le
// bucle pendant des minutes, et une écriture du disque n'a rien à attendre de la
// prochaine image. Le garde-fis est le même (throttlée, et muette tant que rien n'a
// changé), seul son réveil change de nature.
setInterval(() => { if (worldReady) flushWorldSave(); }, AUTOSAVE_INTERVAL_MS);

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

// ---- bouton « Enregistrer » de l'écran d'arrêt ----
// Échap rend la souris et rouvre cet écran : c'est le moment où le joueur veut être sûr
// que ce qu'il vient de bâtir est sur le disque. L'autosauvegarde reprend déjà le
// travail en arrière-plan ; ce bouton, lui, doit dire ce qu'il a fait — une écriture
// muette ressemble à une écriture qui n'a pas eu lieu.
const saveBtn = document.getElementById('save-btn');
const saveNote = document.getElementById('save-note');
let saveBtnBusy = false;

function majBoutonEnregistrer() {
  if (!saveBtn) return;
  // Le bouton reste cliquable pendant une écriture automatique : la demande du joueur
  // attend celle qui est en vol au lieu d'être refusée. Lui seul se met en congé.
  saveBtn.disabled = !worldReady || saveBtnBusy;
  saveBtn.textContent = !worldReady ? '💾 monde en chargement…'
    : (writingSave || saveBtnBusy) ? '💾 écriture…'
    : '💾 Enregistrer le monde';
}

/** Écrit tout de suite et rend le verdict dans la note sous le bouton. */
async function enregistrerMaintenant() {
  // Une écriture en vol n'est pas un motif de refus : `flushWorldSave` l'attend et reprend
  // le diff. Refuser laissait le joueur avec un bouton qui n'avait rien écrit.
  if (!worldReady || saveBtnBusy) return false;
  const regenerait = regenerEnCours;
  saveBtnBusy = true;
  majBoutonEnregistrer();
  let ecrit = false;
  try {
    ecrit = await flushWorldSave({ force: true });
  } finally {
    saveBtnBusy = false;
    majBoutonEnregistrer();
    updateSaveHud();
  }
  if (saveNote) {
    // Verdict lu sur l'état final du disque, pas sur le seul voyage de ce clic : si
    // l'économise périodique vient d'écrire ces mêmes cubes, le joueur a eu ce qu'il veut.
    saveNote.textContent = ecrit
      ? `Monde « ${worldLabel()} » écrit · ${world.modifiedBlocks.size} cube${world.modifiedBlocks.size > 1 ? 's' : ''} modifié${world.modifiedBlocks.size > 1 ? 's' : ''}`
      : regenerait ? 'Régénération du monde en cours : rien à écrire pour l’instant'
      : !needsWorldSave() ? 'Rien de nouveau depuis la dernière écriture : le disque est à jour'
      : 'Échec de l’écriture — voir la console';
  }
  return ecrit;
}

if (saveBtn) saveBtn.addEventListener('click', () => { enregistrerMaintenant(); });

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
      // Le fichier porte peut-être une fiche de génération différente de celle du
      // magasin local — mémoire locale effacée, monde copié d'une autre machine. C'est
      // le fichier qui a raison : sans lui, les blocs posés par le joueur retomberaient
      // sur un relief qu'il n'a jamais vu. On range la fiche et on repart une fois ; le
      // garde de session ferme la porte à une boucle de rechargements.
      if (saved.monde && !memesMondes(saved.monde, MONDE)) {
        const cleGarde = `mincraft_fiche_vue:${saveStore.slot}`;
        try {
          localStorage.setItem(mondeStorageKey(saveStore.slot), JSON.stringify(clampMonde(saved.monde)));
          if (!sessionStorage.getItem(cleGarde)) {
            sessionStorage.setItem(cleGarde, '1');
            window.location.reload();
            return;
          }
        } catch (e) {
          console.warn('Fiche du monde non mémorisée :', e);
        }
      }
      // Un nom passé par l'URL (création ou renommage à l'instant) prime : c'est
      // l'intention la plus récente, le fichier peut encore porter l'ancienne.
      if (!worldName) worldName = cleanWorldName(saved.name);
      world.applyEdits(saved.edits, saved.flux);
      player.restoreFromSave(saved.player);
      savedAtLocal = saved.savedAt || Date.now();
    } else {
      mondeVierge = true;
      // Le sol du monument est estampé, pas généré avec le relief : les tronçons qui le
      // portent doivent exister avant qu'on y pose le joueur, sinon il traverse la dalle
      // libre d'air et tombe jusqu'au fond du monde.
      const reveil = resoudreApparition();
      if (reveil) world.updateChunks(reveil.x, reveil.z, WORLD_BOOT_BUDGET);
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
    majBoutonEnregistrer();
  }
  if (worldNameInput && !worldNameInput.value) worldNameInput.value = worldName || '';
  // Dire où le joueur se réveille : sans cette ligne, un monde neuf qui s'ouvre sous une
  // colonnade ressemble à un téléportation hasardeuse plutôt qu'à un choix du monde.
  const reveil = !saved && mondeVierge && apparitionDuMonde
    ? ` · réveil dans le temple de (${apparitionDuMonde.ex}, ${apparitionDuMonde.ez})`
    : (!saved && mondeVierge ? ' · aucun temple à portée, apparition en pleine nature' : '');
  setWorldStatus(saved
    ? `Monde « ${worldLabel()} » retrouvé · ${saved.edits.size} bloc${saved.edits.size > 1 ? 's' : ''} modifié${saved.edits.size > 1 ? 's' : ''} · ${describeAge(Date.now() - savedAtLocal)}`
    : `Nouveau monde « ${worldLabel()} » · rien sur le disque pour l’instant${reveil}`);
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
  // Le monde redevient vierge : le joueur y est remis comme à sa première venue, sous la
  // colonnade du temple — sinon « Réinitialiser » le rendrait au plein champ alors que la
  // même page, chargée sans fichier, l'y aurait mené.
  mondeVierge = true;
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

// L'écran de réglage du monde est plein écran et opaque : pendant qu'il est ouvert,
// rien du monde n'est visible derrière lui. On suspend donc tout ce qui se paie par
// image — physique, streaming de tronçons, rendu WebGL — sans arrêter l'horloge :
// `lastTime` continue d'avancer, donc aucune avance de `deltaTime` n'attend le joueur
// à la fermeture (le monde reprendrait sinon un bond d'une demi-seconde).
let reglageOuvert = false;
let framesRendues = 0;
// Les suites jugent le monde sans jamais cliquer « jouer » : elles n'ont pas de souris
// capturée, donc pas d'écran fermé, et devraient voir une page figée. Ce drapeau leur
// rend les images que la pause refuse, sans simuler pour autant la partie réelle.
let imageForcee = false;
let veilleAppliquee = null;

/** Vrai tant que l'écran d'accueil — ou la pause qu'Échap rouvre — couvre la page. */
const ecranPose = () => blocker.style.display !== 'none';

/**
 * L'horloge du fluide. Une vague toutes les `EAU.PAS_MS` millisecondes, jamais plus : le
 * budget de cellules jugées par vague est borné côté automate, et le remaillage des
 * tronçons touchés part dans la file de streaming (`differe`) au lieu d'être payé ici.
 * Deux vagues à la suite sur la même image ne gagneraient rien — la seconde ne juge que
 * des cellules découvertes par la première — et coûtent deux remaillages.
 */
let horlogeEau = 0;
function majEau(deltaTime) {
  if (world.eau.enAttente() === 0) { horlogeEau = 0; return; }
  horlogeEau += deltaTime * 1000;
  if (horlogeEau < EAU.PAS_MS) return;
  horlogeEau = 0;
  world.eau.vague();
}

// Le regard du joueur, lu une fois par image. Il décide de l'ordre dans lequel le monde
// se décharge (`offsetsFor`) et sert aussi au viseur : un seul vecteur partagé plutôt
// qu'une allocation par image.
const directionRegard = new THREE.Vector3(0, 0, -1);

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const deltaTime = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  if (reglageOuvert) return;
  // L'écran d'accueil est opaque : rien du monde n'est visible derrière lui, donc rien
  // ne se dessine, ne se maille, ni n'avance pendant qu'il est posé. Le canevas est masqué
  // en plus — une pleine fenêtre à composer coûte même quand personne ne dessine dedans.
  const enVeille = !imageForcee && ecranPose();
  if (enVeille !== veilleAppliquee) {
    veilleAppliquee = enVeille;
    renderer.domElement.classList.toggle('hors-jeu', enVeille);
  }
  if (enVeille) return;
  framesRendues++;

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

  updateSaveHud();   // l'écriture périodique, elle, tourne sur son propre réveil

  // L'heure du monde avance avec les images : la journée se tarit à l'horloge réelle,
  // et le cycle s'arrête avec le reste quand l'écran de réglage est ouvert. La météo
  // compte ses journées sur la même pendule, donc accélérer la journée rapproche aussi
  // les averses — c'est le seul rythme que le joueur règle.
  horloge.avancer(deltaTime);
  meteo.avancer(deltaTime, horloge.duree());
  etatCiel = cielSousPluie(etatDuCiel(horloge.heure()), intensitePluie());
  majCiel(deltaTime, now / 1000);

  if (controls.isLocked) {
    player.update(deltaTime);
    updateInfo();   // le mode (marche / réacteurs / plané) suit le geste, pas la seconde
    // Ce que le joueur regarde se décharge en premier : au planeur à 34 cubes/s, il
    // traverse son propre champ rendu en moins de quatre secondes.
    directionRegard.set(0, 0, -1).applyQuaternion(camera.quaternion);
    world.updateChunks(camera.position.x, camera.position.z, Infinity, CHUNK_FRAME_MS,
      directionRegard.x, directionRegard.z);
    majEau(deltaTime);

    // The pending cuboid owns the cursor while it lasts; otherwise square off the face
    // under the crosshair — which cube and which of its sides a click would start from.
    if (!updateSelectionVisuals()) {
      const hit = raycastVoxel(camera.position, directionRegard, 8);
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
    // Même ordre prioritaire qu'en jeu : l'aperçu se remplit dans le sens où regarde la
    // caméra, sinon la vue du réglage se construit à l'opposé de ce qu'elle montre.
    if (world.pendingChunks > 0) {
      directionRegard.set(0, 0, -1).applyQuaternion(camera.quaternion);
      world.updateChunks(camera.position.x, camera.position.z, Infinity, CHUNK_FRAME_MS,
        directionRegard.x, directionRegard.z);
    }
  }

  updateSelectionHud();
  updateWaterHud();
  renderer.render(scene, camera);
}

animate();

// ==================== ÉCRAN DE GÉNÉRATION DU MONDE ====================
// Écran plein écran ouvert depuis l'accueil : la carte à gauche, les curseurs à droite.
// Les curseurs viennent de la fiche (`MONDE_FIELDS`), la carte et les chiffres viennent
// de l'aperçu — même source, donc l'étiquette d'un curseur ne peut pas promettre ce que
// la carte ne montre pas. Rien n'est appliqué à la volée : bouger un curseur redessine
// l'aperçu, mais il faut un clic pour engager un monde, parce qu'une fiche différente
// veut dire un autre relief sous des blocs déjà posés.
const wgEcran = document.getElementById('worldgen-screen');
const wgOuvrir = document.getElementById('worldgen-open');
const wgFermer = document.getElementById('worldgen-close');
const wgResume = document.getElementById('worldgen-resume');
const wgNom = document.getElementById('worldgen-name');
const wgCadre = wgEcran ? wgEcran.querySelector('.wg-cadre') : null;
const wgCarte = document.getElementById('worldgen-map');
const wgChamps = document.getElementById('worldgen-fields');
const wgLecture = document.getElementById('worldgen-readout');
const wgStatut = document.getElementById('worldgen-status');
const wgDefaut = document.getElementById('worldgen-reset');
const wgAppliquer = document.getElementById('worldgen-apply');
const wgNouveau = document.getElementById('worldgen-new');

const ficheEnReglage = Object.assign({}, MONDE);
const champsParCle = new Map();
let armeARegenerer = false;

function memoriserFiche(slot, fiche) {
  try {
    localStorage.setItem(mondeStorageKey(slot), JSON.stringify(clampMonde(fiche)));
    return true;
  } catch (e) {
    console.warn('Fiche du monde non mémorisée :', e);
    return false;
  }
}

function texteValeur(field, valeur) {
  if (field.type === 'checkbox') return valeur ? 'oui' : 'non';
  return `${valeur}${field.unit ? ` ${field.unit}` : ''}`;
}

function syncUnChamp(cle) {
  const vue = champsParCle.get(cle);
  if (!vue) return;
  const { field, entree, valeurVue } = vue;
  if (field.type === 'checkbox') entree.checked = !!ficheEnReglage[cle];
  else entree.value = String(ficheEnReglage[cle]);
  valeurVue.textContent = texteValeur(field, ficheEnReglage[cle]);
}

/** Un curseur sans objet (le rayon hors mode île) se grise plutôt que de disparaître. */
function syncTousLesChamps() {
  for (const [cle, vue] of champsParCle) {
    syncUnChamp(cle);
    const horsService = vue.field.dependsOn && !vue.field.dependsOn(ficheEnReglage);
    vue.entree.disabled = horsService;
    vue.ligne.classList.toggle('hors-service', horsService);
  }
}

function construireChampsDuMonde() {
  if (!wgChamps) return;
  let groupeCourant = null;
  for (const field of MONDE_FIELDS) {
    if (field.group !== groupeCourant) {
      groupeCourant = field.group;
      const titre = document.createElement('div');
      titre.className = 'worldgen-group';
      titre.textContent = groupeCourant.toUpperCase();
      wgChamps.appendChild(titre);
    }
    const ligne = document.createElement('div');
    ligne.className = 'setting-row worldgen-row';
    const label = document.createElement('label');
    label.textContent = field.label;
    label.htmlFor = `worldgen-${field.key}`;
    const entree = document.createElement('input');
    entree.id = `worldgen-${field.key}`;
    entree.dataset.cle = field.key;
    if (field.type === 'checkbox') {
      entree.type = 'checkbox';
    } else {
      entree.type = field.type === 'number' ? 'number' : 'range';
      entree.min = String(field.min);
      entree.max = String(field.max);
      entree.step = String(field.step);
    }
    const valeurVue = document.createElement('output');
    valeurVue.htmlFor = entree.id;
    ligne.append(label, entree, valeurVue);
    if (field.hint) {
      const note = document.createElement('span');
      note.className = 'worldgen-hint';
      note.textContent = field.hint;
      ligne.appendChild(note);
    }
    wgChamps.appendChild(ligne);
    champsParCle.set(field.key, { field, entree, valeurVue, ligne });
    entree.addEventListener('input', () => {
      ficheEnReglage[field.key] = field.type === 'checkbox' ? entree.checked : Number(entree.value);
      syncTousLesChamps();
      repeindreAPartirDeReglage();
    });
  }
  syncTousLesChamps();
}

let minuteurDeCarte = null;
function repeindreAPartirDeReglage(delai = 140) {
  if (!wgCarte) return;
  if (minuteurDeCarte) clearTimeout(minuteurDeCarte);
  // L'échantillonnage coûte une passe de bruit sur toute la carte : on ne le paie
  // qu'une fois le geste du curseur terminé, sinon la page d'accueil ramerait.
  minuteurDeCarte = setTimeout(() => { minuteurDeCarte = null; repeindreCarte(); }, delai);
}

function repeindreCarte() {
  if (!wgCarte) return null;
  const fiche = clampMonde(ficheEnReglage);
  const lu = apercuDuMonde.lire(fiche);
  apercuDuMonde.peindre(wgCarte, fiche);
  if (wgLecture) {
    wgLecture.innerHTML = '';
    for (const ligne of lu.lignes) {
      const item = document.createElement('div');
      item.className = 'worldgen-stat';
      const nom = document.createElement('span');
      nom.textContent = ligne.label;
      const obtenu = document.createElement('b');
      obtenu.textContent = ligne.valeur;
      item.append(nom, obtenu);
      if (ligne.vise) {
        const vise = document.createElement('i');
        vise.textContent = `visé ${ligne.vise}`;
        item.appendChild(vise);
      }
      wgLecture.appendChild(item);
    }
  }
  return lu;
}

function decrireFiche(f) {
  return `${f.ile ? `île de ${f.rayonIle} cubes` : 'continent'} · forêt ${f.foret} %`
    + ` · désert ${f.desert} % · mer ${f.mer} % · grève ${f.largeurPlage} cubes`
    + ` · villes ${f.villesPetites}/${f.villesMoyennes}/${f.villesGrandes}`
    + ` · graine ${f.graine}`;
}

/**
 * La carte est un échantillon de 216 × 216 colonnes qu'on agrandit en cubes nets : ce
 * qui coûte, c'est le nombre de colonnes jugées (une passe de bruit par pixel), pas sa
 * taille à l'écran. On se contente donc de donner au canevas le plus grand carré tenant
 * dans son cadre.
 */
function dimensionnerCarte() {
  if (!wgCarte || !wgCadre) return;
  const cote = Math.max(180, Math.floor(Math.min(wgCadre.clientWidth, wgCadre.clientHeight)));
  wgCarte.style.width = `${cote}px`;
  wgCarte.style.height = `${cote}px`;
}

/** L'accueil garde la trace de la fiche : celle du monde en jeu, et les réglages en attente. */
function majResumeDuMonde() {
  if (!wgResume) return;
  const enJeu = `Génération du monde en jeu : ${decrireFiche(MONDE)}`;
  wgResume.textContent = memesMondes(ficheEnReglage, MONDE)
    ? enJeu
    : `${enJeu} — réglages non appliqués : ${decrireFiche(ficheEnReglage)}`;
}

function ouvrirReglageDuMonde() {
  if (!wgEcran || !wgEcran.hidden) return;
  // Avant tout le reste : coupe le rendu dès l'image suivante.
  reglageOuvert = true;
  wgEcran.hidden = false;
  // Une touche restée enfoncée avant l'ouverture ferait marcher le joueur à la fermeture.
  for (const k in keys) keys[k] = false;
  syncTousLesChamps();
  dimensionnerCarte();
  repeindreCarte();
  if (wgStatut) wgStatut.textContent = `Réglages actuels : ${decrireFiche(ficheEnReglage)}`;
  majResumeDuMonde();
  if (wgFermer) wgFermer.focus();
}

function fermerReglageDuMonde() {
  if (!wgEcran || wgEcran.hidden) return;
  wgEcran.hidden = true;
  reglageOuvert = false;
  majResumeDuMonde();
}

if (wgEcran) {
  construireChampsDuMonde();
  majResumeDuMonde();
  if (wgOuvrir) wgOuvrir.addEventListener('click', ouvrirReglageDuMonde);
  if (wgFermer) wgFermer.addEventListener('click', fermerReglageDuMonde);
  window.addEventListener('resize', () => { if (reglageOuvert) dimensionnerCarte(); });

  if (wgDefaut) {
    wgDefaut.addEventListener('click', () => {
      Object.assign(ficheEnReglage, MONDE_DEFAULTS);
      syncTousLesChamps();
      repeindreAPartirDeReglage(0);
      if (wgStatut) wgStatut.textContent = 'Valeurs par défaut rétablies — celles du monde d\'aujourd\'hui.';
    });
  }

  // Régénérer efface les blocs posés par le joueur : c'est irréversible, donc le
  // second clic doit porter l'intention, comme pour la suppression d'un monde.
  if (wgAppliquer) {
    wgAppliquer.addEventListener('click', async () => {
      if (!armeARegenerer) {
        armeARegenerer = true;
        wgAppliquer.classList.add('confirm');
        wgAppliquer.textContent = 'Confirmer ? le monde sera refait';
        if (wgStatut) wgStatut.textContent = 'Ce bouton défait la sauvegarde de ce monde : recliquez pour régénérer.';
        setTimeout(() => {
          if (!armeARegenerer) return;
          armeARegenerer = false;
          wgAppliquer.classList.remove('confirm');
          wgAppliquer.textContent = 'Régénérer ce monde';
        }, 6000);
        return;
      }
      armeARegenerer = false;
      wgAppliquer.classList.remove('confirm');
      wgAppliquer.textContent = 'Régénérer ce monde';
      memoriserFiche(saveStore.slot, ficheEnReglage);
      regenerEnCours = true;
      await resetActiveWorld();
      // Le fichier porte encore l'ancienne fiche — et c'est LUI qui a raison au démarrage
      // suivant (garde de cohérence avec les blocs posés). Sans cette écriture, le
      // rechargement qui suit annulerait le réglage et le monde reviendrait tel qu'avant.
      try {
        await saveStore.save(encodeSave({
          seed: mondeSeeds(ficheEnReglage.graine), name: worldName,
          player: player.saveState(), edits: new Map(), monde: ficheEnReglage,
          flux: new Map(),
        }));
      } catch (e) {
        console.warn('Fiche non écrite dans la sauvegarde :', e);
      }
      window.location.reload();
    });
  }

  if (wgNouveau) {
    wgNouveau.addEventListener('click', async () => {
      // Le nom se saisit ici : celui de l'accueil est derrière cet écran, donc hors de
      // portée — on ne lui demande rien tant qu'on règle le monde. Vide, c'est la date.
      const saisi = cleanWorldName((wgNom && wgNom.value) || (worldNameInput ? worldNameInput.value : ''));
      const nom = saisi || `Monde du ${new Date().toLocaleDateString('fr-FR')}`;
      await refreshWorldList();
      const slot = nextSlotName(nom);
      memoriserFiche(slot, ficheEnReglage);
      await flushWorldSave({ force: true });
      const url = new URL(window.location.href);
      url.searchParams.set('world', slot);
      url.searchParams.set('name', nom);
      window.location.assign(url.toString());
    });
  }
}

// Headless test hook: drives physics/input without needing pointer lock.
window.__mc = {
  THREE,
  scene,
  camera,
  renderer,
  world,
  player,
  // Le contrôleur aérien se juge sur ses nombres à lui : une suite qui recopie ces
  // chiffres dérive dès qu'on les règle.
  GRAVITY, JUMP_SPEED, MOVE_SPEED, JET_SPEED,
  PLANE_MIN, PLANE_DEFAUT, PLANE_MAX, PLANE_THRUST, PLANE_LIFT_SPEED, PLANE_SINK_MAX,
  // Les nombres du champ de lumière : une suite qui recopie ces seuils dérive au
  // premier réglage, et ils décident de ce qu'on appelle encore « noir ».
  PLANCHER_NUIT, PLANCHER_PIECE, COUVERTE_MINCE, LAMPE_PORTEE, PORTEE_CIEL,
  // La ligne du HUD qui dit ce que fait le joueur, lisible sans attendre l'horloge FPS.
  modeDuJoueur: () => modeJoueur(),
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
  // The first pass must happen unconditionally: right after a teleport `pendingChunks`
  // still carries the old position's count (often zero), and a `while` on it would
  // return without generating anything at the new spot — a silently empty world.
  streamAll() {
    let guard = 0;
    do {
      world.updateChunks(camera.position.x, camera.position.z, 64);
    } while (world.pendingChunks > 0 && guard++ < 500);
    return world.pendingChunks;
  },
  // Génère les données des tronçons d'une fenêtre sans déplacer le centre du flot. Une
  // suite qui juge des colonnes fixes loin du joueur en a besoin : `streamAll` ne charge
  // que autour de la caméra — et le monde s'ouvre aujourd'hui dans un temple, parfois à
  // deux cents cubes de l'apparition historique.
  chargerRegion(x0, z0, x1, z1) {
    let faits = 0;
    for (let cx = Math.floor(x0 / CHUNK_SIZE); cx <= Math.floor(x1 / CHUNK_SIZE); cx++) {
      for (let cz = Math.floor(z0 / CHUNK_SIZE); cz <= Math.floor(z1 / CHUNK_SIZE); cz++) {
        if (world.generateChunkData(cx, cz)) faits++;
      }
    }
    return faits;
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
  // ---- eau qui coule ----
  // Les suites jugent la propagation sans dépendre du temps réel : `eauVagues` fait avancer
  // l'automate d'un coup, et `eauNiveau` répond la distance enregistrée (null = source).
  eauParams: EAU,
  eauNiveau: (x, y, z) => world.eauNiveaux.get(`${x},${y},${z}`) ?? null,
  eauNageable: (x, y, z) => world.estNageable(x, y, z),
  eauEnAttente: () => world.eau.enAttente(),
  eauReveiller: (x, y, z) => world.eau.reveiller(x, y, z),
  eauVagues: (n = 1) => {
    let evaluees = 0;
    let modifiees = 0;
    for (let i = 0; i < n; i++) {
      const r = world.eau.vague();
      evaluees += r.evaluees;
      modifiees += r.modifiees;
      if (r.enAttente === 0) break;
    }
    return { evaluees, modifiees, enAttente: world.eau.enAttente() };
  },
  /** Toutes les cellules d'eau de passage du monde : `[x, y, z, distance]`. */
  eauCellules: () => {
    const out = [];
    for (const [cle, niv] of world.eauNiveaux) {
      const [x, y, z] = cle.split(',').map(Number);
      out.push([x, y, z, niv]);
    }
    return out;
  },
  // ---- persistence hooks ----
  saveStore,
  SAVE_SLOT,
  WORLD_SEEDS,
  // Où un monde neuf fait apparaître son joueur (null : repli au sec). Les suites jugent
  // le réveil dans le temple sans recalculer la recherche des mailles.
  pointApparition: () => resoudreApparition(),
  mondeVierge: () => mondeVierge,
  // ---- fiche de génération du monde ----
  // La fiche en jeu, ses défauts, la table des curseurs et les seuils que l'étalonnage
  // en a tirés : les suites vérifient l'écran sans dupliquer ces chiffres.
  monde: MONDE,
  MONDE_DEFAULTS,
  MONDE_FIELDS,
  MONDE_SEUILS,
  mondeSeeds,
  clampMonde,
  memesMondes,
  mondeStorageKey,
  apercuDuMonde,
  memoriserFiche,
  ficheReglee: () => Object.assign({}, ficheEnReglage),
  // Règle la fiche de l'écran et repeint la carte — sans recharger, pour qu'un test
  // puisse lire l'aperçu avant d'engager le monde.
  reglerFiche(partiel) {
    Object.assign(ficheEnReglage, clampMonde(Object.assign({}, ficheEnReglage, partiel || {})));
    syncTousLesChamps();
    majResumeDuMonde();
    return repeindreCarte();
  },
  carteDuMonde: () => wgCarte,
  // L'écran lui-même : les suites l'ouvrent sans clic et jugent que le rendu 3D est
  // bien à l'arrêt pendant qu'il occupe la fenêtre (`framesRendues` ne doit plus avancer).
  ouvrirReglage: () => ouvrirReglageDuMonde(),
  fermerReglage: () => fermerReglageDuMonde(),
  reglageOuvert: () => reglageOuvert,
  framesRendues: () => framesRendues,
  // L'écran d'accueil (et la pause d'Échap) endort le bucle : rien ne se dessine ni
  // n'avance tant qu'il est posé. Une suite qui juge le monde sans jamais cliquer
  // « jouer » réveille le bucle avec `image(true)` et le rendort pour vérifier la veille.
  image: (vrai = true) => { imageForcee = !!vrai; return imageForcee; },
  ecranPose: () => ecranPose(),
  horsJeu: () => renderer.domElement.classList.contains('hors-jeu'),
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
  // …et tenue en outre par la cour de deux cubes qui ceinture chaque bâtiment : la
  // bande où aucun arbre ne doit pousser, pour qu'on puisse en faire le tour.
  cellGenante: (wx, wz) => village.blocksVegetation(wx, wz),
  // Plan du temple de la maille (i,j) et temples recoupant une fenêtre : les suites
  // vérifient le monument dans le monde chargé sans en dupliquer les constantes.
  templeAt: (i, j) => village.templeAt(i, j),
  templesSur: (x0, z0, x1, z1) => village.templesSur(x0, z0, x1, z1),
  // --- cycle du jour et lanternes ---
  // L'état du ciel tel qu'il est rendu. `reglerHeure` le fige : une suite qui veut
  // juger la nuit ne peut pas attendre huit minutes, et un contrôle qui dépend de
  // l'heure réelle serait vert un matin et rouge un soir.
  ciel: () => ({ ...etatCiel, lanterneVivet }),
  // La couche de nuages telle qu'elle est rendue. Une suite juge qu'ils ne sont pas des
  // cubes (géométrie), qu'ils tiennent au monde quand le joueur marche (le décalage d'UV
  // compense exactement sa course) et qu'ils s'éteignent avec le jour.
  nuages: () => nappes.map((n) => ({
    nom: n.userData.nom,
    altitude: n.userData.altitude,
    tuile: n.userData.tuile,
    vitesse: n.userData.vitesse,
    visible: n.visible,
    geometrie: n.geometry.type,
    opacite: +n.material.uniforms.uOpacite.value.toFixed(4),
    couleur: '#' + n.material.uniforms.uCouleur.value.getHexString(),
    repeat: +n.material.uniforms.uTuile.value.x.toFixed(4),
    offsetU: n.material.uniforms.uDecalage.value.x,
    offsetV: n.material.uniforms.uDecalage.value.y,
    // L'ancrage régional tel qu'il est appliqué (identique pour les deux couches) : une
    // suite juge qu'il ne tressaute pas quand le joueur marche sur un gradin.
    solAncre: +(solNappe ?? 0).toFixed(3),
    camX: camera.position.x,
    camZ: camera.position.z,
  })),
  // `delta` et `maintenant` se figent pour qu'une suite puisse dérouler la marche du
  // joueur image par image plutôt que de voir l'amortissement sauter comme à la
  // télécommande (sans quoi le contrôle jugerait un ciel instantané, pas celui du jeu).
  reglerHeure: (h, delta = 10, maintenant = performance.now() / 1000) => {
    horloge.regler(h);
    return rafraichirCiel(delta, maintenant);   // forcée : la valeur doit se lire tout de suite
  },
  // --- pluie ---
  // L'état de la météo et ce que le rideau rend réellement. Une suite ne peut pas
  // attendre vingt minutes d'horloge pour juger une averse : `reglerPluie` la fige et
  // force `majCiel`, exactement comme `reglerHeure` le fait pour l'heure.
  pluie: () => {
    const e = meteo.etat();
    return {
      ...e,
      // `intensite` est celle que la scène rend — avec une reprise en main de test, ce
      // n'est pas celle de l'automate ; elle reste lisible sous `automate`.
      intensite: intensitePluie(),
      automate: e.intensite,
      force: pluieForcee,
      rendu: {
        visible: rideauPluie.visible,
        points: rideauPluie.geometry.attributes.position.count,
        peints: renderer.info.render.points || 0,
        densite: +rideauPluie.material.uniforms.uDensite.value.toFixed(3),
        opacite: +rideauPluie.material.uniforms.uOpacite.value.toFixed(3),
        couleur: '#' + rideauPluie.material.uniforms.uCouleur.value.getHexString(),
        brume: [+scene.fog.near.toFixed(1), +scene.fog.far.toFixed(1)],
        // Même arrondi que `brume` : la suite compare les deux et jugerait une différence
        // de lecture là où il n'y a qu'une différence de virgule flottante.
        brumeSere: [+brumeSere.near.toFixed(1), +brumeSere.far.toFixed(1)],
      },
    };
  },
  reglerPluie: (v, delta = 10, maintenant = performance.now() / 1000) => {
    pluieForcee = v == null ? null : Math.min(1, Math.max(0, Number(v) || 0));
    return rafraichirCiel(delta, maintenant).pluie || 0;
  },
  /** Fait défiler la pendule météo de `journees` journées (suites). */
  avancerMeteo: (journees, delta = 1 / 60, maintenant = performance.now() / 1000) => {
    meteo.reglerTemps(meteo.etat().journee + (Number(journees) || 0));
    rafraichirCiel(delta, maintenant);
    return meteo.etat();
  },
  reglerMeteo: (m) => setMeteoMode(m),
  horloge: () => horloge,
  dureeJour: () => settings.dureeJour,
  reglerDureeJour: (v) => setDayLength(v),
  // Candélabres du village dans une région, et lanternes réellement retenues pour le
  // halo d'un tronçon — la seconde réponse exclut donc celles que le joueur a arrachées.
  lampadairesSur: (x0, z0, x1, z1) => village.lampadairesSur(x0, z0, x1, z1),
  lampesInterieuresSur: (x0, z0, x1, z1) => village.lampesInterieuresSur(x0, z0, x1, z1),
  appliquesMuralesSur: (x0, z0, x1, z1) => village.appliquesMuralesSur(x0, z0, x1, z1),
  couloirsSur: (x0, z0, x1, z1) => village.couloirsSur(x0, z0, x1, z1),
  lampesDuTroncon: (cx, cz) => world.lampesAutour(cx, cz),
  bloc: (x, y, z) => world.getBlock(x, y, z),
  playerState: () => player.saveState(),
};
