// Vérifie le générateur de village hors navigateur : routes en grille, maisons et
// immeubles qui ne mordent jamais sur la chaussée, et un rendu strictement
// déterministe (le monde n'est sauvegardé que sous forme de son diff, donc un
// tronçon régénéré doit tomber cube pour cube sur le précédent).
// Usage: node tests/village.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReporter } from './browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { check, summary } = makeReporter();

// Le module est écrit pour le navigateur (ESM) mais sans aucune dépendance : on le
// copie sous .mjs pour que Node l'évalue tel quel, sans toucher au projet.
async function loadPublicModule(relative) {
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  const tmp = path.join(os.tmpdir(), `mycraft-${path.basename(relative, '.js')}-${process.pid}.mjs`);
  fs.writeFileSync(tmp, source);
  try {
    return await import(pathToFileURL(tmp).href);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const { createVillageGen, VILLAGE, storeysOf, hauteurPourEtages } = await loadPublicModule('public/js/village.js');

const CHUNK_SIZE = 16;
// Même plafond que le jeu : une catégorie d'immeuble jugée sous un plafond plus bas
// retomberait de elle-même, et le test ne verrait plus la skyline demandée.
const CHUNK_HEIGHT = 128;
const BLOCK = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, COBBLE: 4, PLANKS: 5,
  BRICK: 6, GLASS: 7, GRIT: 8, OBSIDIAN: 9, LOG: 10, LEAVES: 11,
  // Les matériaux du monument doivent exister ici aussi : absents de la table, ils
  // s'estampaient en `undefined`, donc en air, et le temple disparaissait des tampons
  // sans que la génération du plan le dise.
  SAND: 12, SNOW: 13, GOLD: 14, MOSS: 15,
  // Lanternes du lampadaire en deux parties : sans elles dans cette table, le candélabre
  // retombe sur `COBBLE`/`GOLD` et rien ne distingue plus une rue éclairée d'une rue nue.
  LAMP_POST: 21, LAMP_GLOW: 22,
  // Les quatre appliques murales d'immeuble : absentes de la table, la pose des couloirs
  // s'éteint d'elle-même (voir `desAppliques`) et la suite passerait verte sans rien juger.
  LAMP_WALL_O: 23, LAMP_WALL_E: 24, LAMP_WALL_N: 25, LAMP_WALL_S: 26,
};

// Même hachage que le jeu : c'est lui qui décide de tout dans le village.
function hashRoll(x, y, z, salt) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)
        ^ Math.imul(z | 0, 1274126177) ^ Math.imul(salt | 0, 2654435761);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// Relief vallonné mais restant dans la bande où le village a le droit de pousser,
// sans Math.random() : deux exécutions doivent comparer identiques.
const heightAt = (x, z) => 26 + Math.round(1.8 * Math.sin(x / 23) + 1.8 * Math.cos(z / 29));

const makeGen = (saltBase = 0, hauteur = heightAt) => createVillageGen({
  BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt: hauteur, roll: hashRoll, saltBase,
});

const idx = (lx, y, lz) => lx + lz * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE;
const emptyData = () => new Uint16Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_HEIGHT);

/**
 * Tampon de neuf tronçons autour de (cx,cz), lu en coordonnées relatives à l'origine du
 * tronçon demandé (-16…31). Un bloc d'immeubles déborde de son tronçon : ses marches, sa
 * porte et sa sortie de toit tombent parfois chez le voisin, et les lire dans le seul
 * tampon propriétaire les donnait pour de l'air — un escalier sain était tenu en défaut.
 */
function stampArea(g, cx, cz) {
  const T = CHUNK_SIZE * 3;
  const data = new Uint16Array(T * T * CHUNK_HEIGHT);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const sub = emptyData();
      g.stampRoads(sub, cx + dx, cz + dz);
      g.stampBuilding(sub, cx + dx, cz + dz);
      for (let y = 0; y < CHUNK_HEIGHT; y++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            const v = sub[idx(lx, y, lz)];
            if (!v) continue;
            data[(dx + 1) * CHUNK_SIZE + lx + ((dz + 1) * CHUNK_SIZE + lz) * T + y * T * T] = v;
          }
        }
      }
    }
  }
  return (lx, y, lz) => {
    if (lx < -CHUNK_SIZE || lx >= 2 * CHUNK_SIZE || lz < -CHUNK_SIZE || lz >= 2 * CHUNK_SIZE
      || y < 0 || y >= CHUNK_HEIGHT) return undefined;
    return data[(lx + CHUNK_SIZE) + (lz + CHUNK_SIZE) * T + y * T * T];
  };
}

/**
 * Tous les plans de bâtiment d'un carré de tronçons, indexés par "cx,cz#parcelle" :
 * un même tronçon peut en porter jusqu'à quatre (deux maisons jumelles, un quadruplé
 * de cottages, ou une tour seule qui occupe tout le lot).
 */
function scanPlans(gen, radius) {
  const plans = new Map();
  for (let cx = -radius; cx <= radius; cx++) {
    for (let cz = -radius; cz <= radius; cz++) {
      gen.buildingAt(cx, cz).forEach((plan, i) => plans.set(`${cx},${cz}#${i}`, plan));
    }
  }
  return plans;
}

/** Le tronçon dont vient une clé de plan. */
const chunkOf = (key) => key.split('#')[0].split(',').map(Number);

// Même borne que le générateur : une tour plus haute que ce que sa volée peut gravir
// serait une cage sans sortie. La cage est verticale depuis le 2026-11-11 — les volées
// repassent l'une sur l'autre dans une empreinte fixe de quatre colonnes sur `volée +
// palier` — donc la surface au sol ne limite plus la hauteur, seuls la longueur d'une
// volée et la garde-tête entre deux volées empilées comptent. Copie stricte de
// `stairCapacity` dans village.js.
function stairCapacity(w, d) {
  const coreW = w - 2;
  const coreD = d - 2;
  if (coreW < 2 || coreD < 2) return 0;
  const volée = Math.min(VILLAGE.stairFlightMax, Math.max(coreW, coreD) - VILLAGE.stairPalier);
  if (volée < 4 || Math.min(coreW, coreD) < 4) return 0;
  return VILLAGE.maxHeight;
}

const gen = makeGen(0);
const RADIUS = 7;
const plans = scanPlans(gen, RADIUS);

// ------------------------------------------------------------- voirie
const laneOffset = (v) => Math.abs(v - Math.round(v / VILLAGE.roadSpacing) * VILLAGE.roadSpacing);

// Une ligne (constante en z ou en x) peut être supprimée par le générateur : on le
// constate en sondant son axe même, loin de toute ligne perpendiculaire.
const spacing = VILLAGE.roadSpacing;
const axisOf = (v) => Math.round(v / spacing) * spacing;
const lineAlive = (axis, axisName) => gen.roadKind(
  axisName === 'x' ? axis : spacing / 2,
  axisName === 'x' ? spacing / 2 : axis,
) === 'bed';

/** Ce que la voirie devrait être en ce point, d'après la seule géométrie annoncée. */
function expectedRoad(wx, wz) {
  const offNs = laneOffset(wz);
  const offEw = laneOffset(wx);
  const nsOn = lineAlive(axisOf(wz), 'z');
  const ewOn = lineAlive(axisOf(wx), 'x');
  if ((offNs <= VILLAGE.roadHalf && nsOn) || (offEw <= VILLAGE.roadHalf && ewOn)) return 'bed';
  const kerbNs = offNs === VILLAGE.roadHalf + VILLAGE.kerb && nsOn;
  const kerbEw = offEw === VILLAGE.roadHalf + VILLAGE.kerb && ewOn;
  return kerbNs || kerbEw ? 'kerb' : null;
}

let mislabelled = null;
let beds = 0;
let kerbs = 0;
for (let wx = -120; wx <= 120; wx++) {
  for (let wz = -120; wz <= 120; wz++) {
    const kind = gen.roadKind(wx, wz);
    const want = expectedRoad(wx, wz);
    if (kind !== want) mislabelled = `(${wx},${wz}) → ${kind}, attendu ${want}`;
    if (kind === 'bed') beds++;
    if (kind === 'kerb') kerbs++;
  }
}
check('la chaussée ne couvre que les axes et leurs caniveils', mislabelled === null, mislabelled || `${beds} lits vus`);
check('chaque caniveau jouxte sa chaussée', beds > 1000 && kerbs > 300 && kerbs < beds,
  `lits=${beds} caniveils=${kerbs}`);

const lignesVivantes = (() => {
  let alive = 0;
  let total = 0;
  for (let k = -30; k <= 30; k++) {
    total += 2;
    if (lineAlive(k * spacing, 'z')) alive++;
    if (lineAlive(k * spacing, 'x')) alive++;
  }
  return { alive, total };
})();
check('le réseau garde l’essentiel de ses lignes sans toutes les garder',
  lignesVivantes.alive >= lignesVivantes.total * 0.7 && lignesVivantes.alive < lignesVivantes.total,
  `${lignesVivantes.alive}/${lignesVivantes.total} lignes conservées`);

// Croisement : deux avenues conservées doivent se couper en pleine chaussée.
const carrefour = (() => {
  for (let kx = -6; kx <= 6; kx++) {
    if (!lineAlive(kx * spacing, 'x')) continue;
    for (let kz = -6; kz <= 6; kz++) {
      if (lineAlive(kz * spacing, 'z')) return { x: kx * spacing, z: kz * spacing };
    }
  }
  return null;
})();
check('deux avenues conservées se croisent en chaussée',
  !!carrefour && gen.roadKind(carrefour.x, carrefour.z) === 'bed',
  carrefour ? `(${carrefour.x},${carrefour.z}) → ${gen.roadKind(carrefour.x, carrefour.z)}` : 'aucune paire trouvée');

// ---------------------------------------------- revêtement posé dans le tronçon
{
  // Tronçon choisi pour contenir au moins une colonne de chaussée.
  let target = null;
  for (let cx = -RADIUS; cx <= RADIUS && !target; cx++) {
    for (let cz = -RADIUS; cz <= RADIUS && !target; cz++) {
      for (let lx = 0; lx < CHUNK_SIZE && !target; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE && !target; lz++) {
          if (gen.roadKind(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz) === 'bed') target = { cx, cz, lx, lz };
        }
      }
    }
  }
  check('des tronçons contiennent de la chaussée', !!target, target ? `chunk ${target.cx},${target.cz}` : 'aucun');
  if (target) {
    const data = emptyData();
    const wx = target.cx * CHUNK_SIZE + target.lx;
    const wz = target.cz * CHUNK_SIZE + target.lz;
    // La chaussée n'est plus posée à l'altitude naturelle : elle suit le profil de rue,
    // qui ne diffère du relief que là où le terrain imposerait un ressaut.
    const surface = gen.surfaceAt(wx, wz);
    data[idx(target.lx, surface, target.lz)] = BLOCK.GRASS;
    data[idx(target.lx, surface + 1, target.lz)] = BLOCK.LEAVES; // souche à émonder
    data[idx(target.lx, surface + 2, target.lz)] = BLOCK.LOG;
    const touched = gen.stampRoads(data, target.cx, target.cz);
    check('la route est pavée sur son lit de pierre',
      data[idx(target.lx, surface, target.lz)] === BLOCK.GRIT
      && data[idx(target.lx, surface - 1, target.lz)] === BLOCK.COBBLE,
      `surface=${data[idx(target.lx, surface, target.lz)]} lit=${data[idx(target.lx, surface - 1, target.lz)]}`);
    check('rien ne pousse sur la chaussée',
      data[idx(target.lx, surface + 1, target.lz)] === BLOCK.AIR
      && data[idx(target.lx, surface + 2, target.lz)] === BLOCK.AIR,
      `dessus=${data[idx(target.lx, surface + 1, target.lz)]}/${data[idx(target.lx, surface + 2, target.lz)]}`);
    check('le revêtement est posé sur toute la voirie du tronçon', touched > 0, `${touched} colonnes`);
  }
}

// --------------------------------------------------------------- bâtiments
const houses = [...plans.values()].filter((p) => p.kind === 'house');
const towers = [...plans.values()].filter((p) => p.kind === 'tower');
check('le générateur bâtit des maisons', houses.length > 3, `${houses.length} maisons`);
check('le générateur bâtit des immeubles', towers.length > 1, `${towers.length} immeubles`);

// Un immeuble de trois pièces par étage ne tient pas dans un tronçon de seize colonnes :
// l'utilisateur a choisi « 4 libres, immeuble élargi » (2026-11-11), donc le bloc d'immeubles
// déborde chez ses voisins. L'invariant n'est plus la frontière de tronçon mais la maille :
// un plan reste dans sa maille et les quatre qui l'entourent, il ne saute jamais
// une rue, et il ne recouvre aucun autre plan — contrôlés ci-dessous un à un.
const horsMaille = [...plans.values()].find((p) => !(
  p.x0 >= (p.bloc ? 0 : 1) && p.z0 >= (p.bloc ? 0 : 1)
  && p.x0 + p.w <= (p.bloc ? 2 * CHUNK_SIZE : CHUNK_SIZE - 1)
  && p.z0 + p.d <= (p.bloc ? 2 * CHUNK_SIZE : CHUNK_SIZE - 1)
));
check('une empreinte reste dans sa maille et ne déborde que d’un tronçon', !horsMaille,
  horsMaille ? `x0=${horsMaille.x0} z0=${horsMaille.z0} w=${horsMaille.w} d=${horsMaille.d}`
    : `${[...plans.values()].filter((p) => p.bloc).length} bloc(s) d’immeubles débordants`);

// Deux emprises qui se recouvrent cube pour cube : c'est le piège propre au débordement —
// deux blocs contigus conçus l'un sans l'autre. La règle d'arbitrage doit l'exclure.
{
  const rects = [...plans.entries()].map(([key, p]) => {
    const [cx, cz] = chunkOf(key);
    return {
      key, x0: cx * CHUNK_SIZE + p.x0, z0: cz * CHUNK_SIZE + p.z0,
      x1: cx * CHUNK_SIZE + p.x0 + p.w - 1, z1: cz * CHUNK_SIZE + p.z0 + p.d - 1,
    };
  });
  const chevauchees = [];
  for (let i = 0; i < rects.length && chevauchees.length < 3; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1) {
        chevauchees.push(`${a.key} × ${b.key}`);
        break;
      }
    }
  }
  check('deux bâtiments ne se recouvrent jamais', !chevauchees.length, chevauchees.join(' | '));
}

const surRoute = [...plans.entries()].find(([key, p]) => {
  const [cx, cz] = chunkOf(key);
  for (let lx = p.x0; lx < p.x0 + p.w; lx++) {
    for (let lz = p.z0; lz < p.z0 + p.d; lz++) {
      if (gen.roadKind(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz)) return true;
    }
  }
  return false;
});
check('aucun bâtiment n’est posé sur une route ou un caniveau', !surRoute, surRoute ? surRoute[0] : '');

// ------------------------------------------------------------ la cour du bâti
{
  // Demandé le 2026-11-09 : « je voudrais que chaque bâtiment ait une cour qui l'entoure
  // pour assurer l'accès à l'intérieur, cette cour doit faire deux cubes de large ». La
  // cour se juge en coordonnées monde et sur tout le voisinage : l'emprise qui bouche une
  // cour peut fort bien appartenir au tronçon d'à côté, qu'un contrôle par tronçon ne voit
  // jamais.
  const pad = VILLAGE.courtWidth;
  const empreintes = [...plans.entries()].map(([key, p]) => {
    const [cx, cz] = chunkOf(key);
    return {
      key,
      x0: cx * CHUNK_SIZE + p.x0, z0: cz * CHUNK_SIZE + p.z0,
      x1: cx * CHUNK_SIZE + p.x0 + p.w - 1, z1: cz * CHUNK_SIZE + p.z0 + p.d - 1,
    };
  });

  // Une feuille est solide dans ce jeu : un tronc planté dans la cour murait le passage.
  // On rejoue donc la végétation avec le prédicat que le jeu lui injecte.
  const { createBiomeGen } = await loadPublicModule('public/js/biomes.js');
  const foret = createBiomeGen({
    BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt, roll: hashRoll, saltBase: 5 * 7919,
    isBlocked: (wx, wz) => gen.blocksVegetation(wx, wz),
  });

  const surRue = [];
  const collées = [];
  const souches = [];
  let coursJugees = 0;
  for (const e of empreintes) {
    coursJugees++;
    for (let wx = e.x0 - pad; wx <= e.x1 + pad; wx++) {
      for (let wz = e.z0 - pad; wz <= e.z1 + pad; wz++) {
        const dansLaCour = wx < e.x0 || wx > e.x1 || wz < e.z0 || wz > e.z1;
        if (!dansLaCour) continue;
        if (gen.roadKind(wx, wz) && surRue.length < 3) surRue.push(`(${wx},${wz}) cour ${e.key}`);
        const autre = empreintes.find((o) => o.key !== e.key
          && wx >= o.x0 && wx <= o.x1 && wz >= o.z0 && wz <= o.z1);
        if (autre && collées.length < 3) collées.push(`(${wx},${wz}) ${e.key} contre ${autre.key}`);
        if (foret.treeAt(wx, wz) && souches.length < 3) souches.push(`(${wx},${wz}) cour ${e.key}`);
      }
    }
  }
  // Les temples aussi ont droit à leur cour. Ils ne sont pas dans `plans` — ils sont
  // posés par une autre chaîne, après routes et maisons — et leurs règles propres (parvis,
  // degré) prédataient la cour de deux cubes : mesuré sur le monde du jeu, un cottage se
  // logeait à une colonne du parvis. On juge donc la **pierre posée** (`templeStone`, hors
  // tampon de végétation) cellule par cellule, non la boîte englobante de l'ouvrage, qui
  // inclut le couloir du degré et ferait croire à une invasion là où il n'y a que de l'air.
  const bornes = empreintes.reduce((a, e) => ({
    x0: Math.min(a.x0, e.x0), z0: Math.min(a.z0, e.z0),
    x1: Math.max(a.x1, e.x1), z1: Math.max(a.z1, e.z1),
  }), { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity });
  const pierres = [];
  for (const t of gen.templesSur(bornes.x0, bornes.z0, bornes.x1, bornes.z1)) {
    const r = t.half + VILLAGE.templeSteps + 6;
    const cellules = [];
    for (let wx = t.ex - r; wx <= t.ex + r; wx++) {
      for (let wz = t.ez - r; wz <= t.ez + r; wz++) if (gen.templeStone(wx, wz)) cellules.push([wx, wz]);
    }
    if (cellules.length) pierres.push({ cle: `temple@${t.ex},${t.ez}`, cellules });
  }
  const coursTempleBouchees = [];
  const coursTempleSurRue = [];
  for (const t of pierres) {
    for (const [wx, wz] of t.cellules) {
      if (coursTempleBouchees.length >= 3 && coursTempleSurRue.length >= 3) break;
      for (let dx = -pad; dx <= pad; dx++) {
        for (let dz = -pad; dz <= pad; dz++) {
          const qx = wx + dx, qz = wz + dz;
          if (gen.templeStone(qx, qz)) continue;            // la pierre du monument elle-même
          const envahie = empreintes.find((e) => qx >= e.x0 && qx <= e.x1 && qz >= e.z0 && qz <= e.z1);
          if (envahie && coursTempleBouchees.length < 3) {
            coursTempleBouchees.push(`(${qx},${qz}) cour de ${t.cle} sous ${envahie.key}`);
          }
          const rue = gen.roadKind(qx, qz);
          if (rue && coursTempleSurRue.length < 3) coursTempleSurRue.push(`(${qx},${qz}) cour de ${t.cle} sur ${rue}`);
        }
      }
    }
  }
  const coursSurPierre = [];
  for (const e of empreintes) {
    if (coursSurPierre.length >= 3) break;
    for (let wx = e.x0 - pad; wx <= e.x1 + pad; wx++) {
      for (let wz = e.z0 - pad; wz <= e.z1 + pad; wz++) {
        if (wx >= e.x0 && wx <= e.x1 && wz >= e.z0 && wz <= e.z1) continue;
        if (gen.templeStone(wx, wz)) coursSurPierre.push(`(${wx},${wz}) cour ${e.key} sur la pierre d'un temple`);
      }
    }
  }
  // Le prédicat doit aussi se vérifier lui-même : sinon une porte ouverte dans
  // `blocksVegetation` laisserait pousser la forêt dans les cours sans que le contrôle
  // ci-dessus ne bronche (le nombre de souches candidates dépend du relief testé).
  const coursNonGardées = [];
  for (const e of empreintes) {
    for (let wx = e.x0 - pad; wx <= e.x1 + pad && coursNonGardées.length < 3; wx++) {
      for (let wz = e.z0 - pad; wz <= e.z1 + pad; wz++) {
        if (wx >= e.x0 && wx <= e.x1 && wz >= e.z0 && wz <= e.z1) continue;
        if (!gen.blocksVegetation(wx, wz)) {
          coursNonGardées.push(`(${wx},${wz}) cour ${e.key}`);
          break;
        }
      }
    }
  }
  // Une cour est un passage, pas un couloir fermé sur le ciel : quatre cubes d'air au
  // dessus de ce sur quoi on marche, comme sous un pont ou le long d'une avenue.
  const sousPoutre = [];
  for (const [key, p] of plans.entries()) {
    if (sousPoutre.length >= 3) break;
    const [cx, cz] = chunkOf(key);
    const data = emptyData();
    if (!gen.stampRoads(data, cx, cz) && !gen.stampBuilding(data, cx, cz)) continue;
    gen.stampStructures(data, cx, cz);
    const sonde = (lx, lz) => {
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) return;
      for (let y = Math.min(CHUNK_HEIGHT - VILLAGE.headroom - 1, p.siteH + p.height + 4);
        y >= Math.max(0, p.siteH - 4); y--) {
        if (data[idx(lx, y, lz)] === BLOCK.AIR) continue;
        for (let k = 1; k <= VILLAGE.headroom; k++) {
          if (y + k >= CHUNK_HEIGHT) break;
          if (data[idx(lx, y + k, lz)] !== BLOCK.AIR) {
            sousPoutre.push(`chunk ${cx},${cz} (${lx},${lz}) bouché à y=${y + k}`);
            return;
          }
        }
        return;
      }
    };
    for (let lx = p.x0 - pad; lx < p.x0 + p.w + pad; lx++) {
      for (let lz = p.z0 - pad; lz < p.z0 + p.d + pad; lz++) {
        if (lx >= p.x0 && lx < p.x0 + p.w && lz >= p.z0 && lz < p.z0 + p.d) continue;
        sonde(lx, lz);
      }
    }
  }

  const detail = (liste, mot) => `${liste.length} ${mot}`
    + (liste.length ? ` — ${liste.join(' | ')}` : '');
  check('chaque bâtiment est ceint d’une cour libre de deux cubes',
    coursJugees > 40 && !surRue.length && !collées.length,
    `${coursJugees} cours jugées · ${detail(surRue, 'colonnes sur voirie')}`
    + ` · ${detail(collées, 'emprises collées')}`);
  check('la cour est gardée par le prédicat de végétation', !coursNonGardées.length,
    detail(coursNonGardées, 'cour non gardée'));
  check('aucun arbre ne pousse dans une cour', !souches.length, detail(souches, 'souche'));
  check('la cour laisse le garde-tête libre', !sousPoutre.length, detail(sousPoutre, 'passage bouché'));
  check('la cour d’un temple reste libre de bâti et de voirie',
    pierres.length >= 2 && !coursTempleBouchees.length && !coursTempleSurRue.length,
    `${pierres.length} temple(s) jugés · ${detail(coursTempleBouchees, 'empiètements')}`
    + ` · ${detail(coursTempleSurRue, 'colonnes sur voirie')}`);
  check('aucune emprise ne touche la pierre d’un temple', !coursSurPierre.length,
    detail(coursSurPierre, 'cour sur pierre'));

  // Le trait de limite. L'arbitrage « seulement dégagée » laisse la cour en terre : pour
  // qu'elle se lise d'en haut, une assise de pierre à plat en dessine le pourtour. On
  // rejoue l'estampage sur un terrain rempli comme le fait le jeu — la bordure ne prend
  // que sur un sol nu sous de l'air libre. Une colonne qui porte autre chose (chaussée,
  // tablier, seuil pavé, pierre du monument) n'est pas un oubli.
  const NU = [BLOCK.GRASS, BLOCK.DIRT, BLOCK.SAND, BLOCK.GRIT, BLOCK.MOSS, BLOCK.SNOW];
  const tamponsCour = new Map();
  function mondeCour(cx, cz) {
    const cle = `${cx},${cz}`;
    let d = tamponsCour.get(cle);
    if (!d) {
      d = emptyData();
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          const h = Math.min(CHUNK_HEIGHT - 1, heightAt(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz));
          for (let y = 0; y <= h; y++) d[idx(lx, y, lz)] = y === h ? BLOCK.GRASS : BLOCK.STONE;
        }
      }
      gen.stampRoads(d, cx, cz);
      gen.stampBuilding(d, cx, cz);
      gen.stampStructures(d, cx, cz);
      tamponsCour.set(cle, d);
    }
    return d;
  }
  const blocCour = (wx, y, wz) => {
    if (y < 0 || y >= CHUNK_HEIGHT) return BLOCK.AIR;
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    return mondeCour(cx, cz)[idx(wx - cx * CHUNK_SIZE, y, wz - cz * CHUNK_SIZE)];
  };
  /** Le sol réellement posé dans une colonne de cour : le sommet d'une MASSE CONTINUE, en
   *  descendant depuis le haut de ce que le nivellement peut atteindre (il hausse jusqu'au
   *  déblai qu'un socle supporterait, ne creuse que d'un cube). Le premier bloc plein ne
   *  suffit pas : au droit d'une porte, le linteau cloué trois cubes au-dessus du seuil
   *  n'est pas un sol — il ferait voir un ressaut là où la bande est de niveau. */
  function solDeCour(wx, wz) {
    const h = heightAt(wx, wz);
    const plein = (y) => {
      const b = blocCour(wx, y, wz);
      return b !== BLOCK.AIR && b !== BLOCK.WATER;
    };
    for (let y = Math.min(CHUNK_HEIGHT - 2, h + VILLAGE.maxReliefHouse + 4); y >= Math.max(2, h - 3); y--) {
      if (plein(y) && plein(y - 1) && plein(y - 2)) return y;
    }
    return null;
  }
  // Ce qui n'est pas une cour à niveler : voirie, emprise, pierre du monument. Ces colonnes
  // font borne, le reste vient s'y adosser.
  const estNue = (wx, wz) => !gen.isOccupied(wx, wz) && !gen.templeStone(wx, wz);
  // La marche d'appui devant une porte est une surface déclarée, comme la chaussée ou la berge :
  // elle tient le niveau du seuil pour que la baie ne donne pas dans le vide, quand bien même la
  // cour soudée avec ses voisines descendrait plus bas. Relevée aussi hors de la fenêtre échantillonnée :
  // la marche d'un bâtiment voisin non collecté n'est pas un ressaut de cette cour.
  const paliersDePorte = new Set();
  for (const [clePlan, p] of scanPlans(gen, RADIUS + 2)) {
    if (!p.door) continue;
    const [pcx, pcz] = chunkOf(clePlan);
    for (const c of [p.door.front, p.door.out]) {
      if (!c) continue;
      paliersDePorte.add(`${pcx * CHUNK_SIZE + c.lx},${pcz * CHUNK_SIZE + c.lz}`);
    }
  }

  let traitsJuges = 0;
  let traitsMarques = 0;
  const traitsOublies = [];
  // Et le niveau : deux colonnes voisines d'une même cour ne doivent pas se regarder de plus
  // d'un cube — « la bande autour de bâtiment doit être du même niveau, pas d'escalier
  // autour d'un bâtiment sur une longueur de 2 cubes ».
  const ressauts = [];
  let coursJugeesNiveau = 0;
  for (const e of empreintes) {
    const plan = plans.get(e.key);
    const rives = new Map();
    for (let wx = e.x0 - pad; wx <= e.x1 + pad; wx++) {
      for (let wz = e.z0 - pad; wz <= e.z1 + pad; wz++) {
        if (wx >= e.x0 && wx <= e.x1 && wz >= e.z0 && wz <= e.z1) continue;
        const t = solDeCour(wx, wz);
        if (t === null) continue;                                  // flaque : rien à niveler
        const surLeTrait = wx === e.x0 - pad || wx === e.x1 + pad || wz === e.z0 - pad || wz === e.z1 + pad;
        if (surLeTrait && estNue(wx, wz)) {
          traitsJuges++;
          const dessus = blocCour(wx, t, wz);
          if (dessus === BLOCK.STONE) traitsMarques++;
          else if (NU.includes(dessus) && traitsOublies.length < 3) {
            traitsOublies.push(`(${wx},${wz}) cour ${e.key} restée en ${dessus}`);
          }
        }
        if (!estNue(wx, wz)) continue;
        if (paliersDePorte.has(`${wx},${wz}`)) continue;
        rives.set(`${wx},${wz}`, t);
      }
    }
    coursJugeesNiveau++;
    for (const [cle, t] of rives) {
      const virgule = cle.indexOf(',');
      const x = +cle.slice(0, virgule);
      const z = +cle.slice(virgule + 1);
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        const autre = rives.get(`${x + dx},${z + dz}`);
        if (autre === undefined || Math.abs(autre - t) <= 1) continue;
        if (ressauts.length < 3) {
          ressauts.push(`${e.key} : (${x},${z})=${t} → (${x + dx},${z + dz})=${autre}, seuil ${plan.siteH}`);
        }
      }
    }
  }
  check('la limite de la cour est marquée d’une assise de pierre',
    traitsJuges > 100 && !traitsOublies.length,
    `${traitsMarques}/${traitsJuges} colonnes marquées · ${detail(traitsOublies, 'limites restées en terre')}`);
  check('la cour est de niveau, sans escalier sur ses deux cubes',
    coursJugeesNiveau > 40 && !ressauts.length,
    `${coursJugeesNiveau} cours jugées · ${detail(ressauts, 'ressaut(s) dans la bande')}`);

  // « Il y a un problème il y a des maison qui qui se retrouve sous terre » (2026-11-11).
  // Le plancher se cale sur la médiane du relief de la bande : sans la taille de pente ni
  // la garde du remblai, la colline d'amont et la cour du voisin dominent le seuil. Jugé
  // colonne par colonne **le long de la façade** — c'est là que le corps disparaît — hors
  // emprises, voirie et pierre de monument, et hors marches d'appui, qui suivent la rue.
  const enterrees = [];
  let facadesJugees = 0;
  for (const e of empreintes) {
    const plan = plans.get(e.key);
    for (let wx = e.x0 - pad; wx <= e.x1 + pad; wx++) {
      for (let wz = e.z0 - pad; wz <= e.z1 + pad; wz++) {
        if (wx >= e.x0 && wx <= e.x1 && wz >= e.z0 && wz <= e.z1) continue;
        if (!estNue(wx, wz)) continue;
        if (paliersDePorte.has(`${wx},${wz}`)) continue;
        const t = solDeCour(wx, wz);
        if (t === null) continue;
        facadesJugees++;
        if (t > plan.siteH + 1 && enterrees.length < 3) {
          enterrees.push(`${e.key} : (${wx},${wz})=${t} contre un plancher à ${plan.siteH}`);
        }
      }
    }
  }
  check('aucune maison n\'est enterrée par le sol qui la borde',
    facadesJugees > 500 && !enterrees.length,
    `${facadesJugees} colonnes de façade jugées · ${detail(enterrees, 'façade(s) sous le sol')}`);
}

const gabaritMaison = [...plans.values()].find((p) => p.kind === 'house'
  && !(p.w >= 4 && p.d >= 4 && p.height >= VILLAGE.houseMinH && p.height <= VILLAGE.houseMaxH));
const gabaritImmeuble = [...plans.values()].find((p) => p.kind === 'tower'
  && !(p.w >= 6 && p.d >= 6 && p.height >= VILLAGE.houseMinH && p.height <= VILLAGE.maxHeight
    && stairCapacity(p.w, p.d) >= p.height));
check('les gabarits respectent maison et immeuble', !gabaritMaison && !gabaritImmeuble,
  gabaritMaison ? `maison ${gabaritMaison.w}×${gabaritMaison.d}×${gabaritMaison.height}`
    : gabaritImmeuble ? `immeuble ${gabaritImmeuble.w}×${gabaritImmeuble.d}×${gabaritImmeuble.height}` : '');

const horsBande = [...plans.entries()].find(([key, p]) => {
  const [cx, cz] = chunkOf(key);
  for (let lx = p.x0; lx < p.x0 + p.w; lx++) {
    for (let lz = p.z0; lz < p.z0 + p.d; lz++) {
      const h = heightAt(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz);
      if (h < VILLAGE.minGround - 1 || h > VILLAGE.maxGround + 1) return true;
    }
  }
  return false;
});
check('le bâti reste entre plage et sommets', !horsBande, horsBande ? `parcelle ${horsBande[0]}` : '');

const tropAccidentee = [...plans.entries()].find(([key, p]) => {
  const [cx, cz] = chunkOf(key);
  let min = Infinity, max = -Infinity;
  for (let lx = p.x0; lx < p.x0 + p.w; lx++) {
    for (let lz = p.z0; lz < p.z0 + p.d; lz++) {
      const h = heightAt(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz);
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  return max - min > (p.kind === 'tower' ? VILLAGE.maxReliefTower : VILLAGE.maxReliefHouse);
});
check('seuls les terrains assez plats sont bâtis', !tropAccidentee, tropAccidentee ? `parcelle ${tropAccidentee[0]}` : '');

// ------------------------------------------------- estampage d'un bâtiment
{
  const entry = [...plans.entries()].find(([, p]) => p.kind === 'house')
    || [...plans.entries()][0];
  const [key, plan] = entry;
  const [cx, cz] = chunkOf(key);
  const data = emptyData();
  const stamped = gen.stampBuilding(data, cx, cz);
  const roofY = plan.siteH + plan.height + 1;
  const at = (lx, y, lz) => data[idx(lx, y, lz)];

  let dalleOk = true, socleOk = true, toitOk = true, toitDegageOk = true, interieurOk = true, faconnOk = true;
  let areteVu = false;
  let porte = 0;
  const isPerimeter = (lx, lz) => lx === plan.x0 || lx === plan.x0 + plan.w - 1 || lz === plan.z0 || lz === plan.z0 + plan.d - 1;
  for (let lx = plan.x0; lx < plan.x0 + plan.w; lx++) {
    for (let lz = plan.z0; lz < plan.z0 + plan.d; lz++) {
      // Le bâtiment s'assoit sur une terrasse plate en pierre grise, bordée d'une arête
      // de rocher : c'est ce qui fait un îlot plutôt qu'une cabane accrochée à la pente.
      const arete = isPerimeter(lx, lz);
      if (at(lx, plan.siteH, lz) !== (arete ? BLOCK.COBBLE : plan.floor)) dalleOk = false;
      if (arete && at(lx, plan.siteH, lz) === BLOCK.COBBLE) areteVu = true;
      if (at(lx, plan.siteH - 1, lz) !== BLOCK.STONE) socleOk = false;
      if (at(lx, roofY, lz) !== plan.roof) toitOk = false;
      if (at(lx, roofY + 3, lz) !== BLOCK.AIR) toitDegageOk = false;
      if (!isPerimeter(lx, lz) && at(lx, plan.siteH + 1, lz) !== BLOCK.AIR) interieurOk = false;
      // Au premier étage, la seule ouverture du mur d'enceinte est la porte.
      if (isPerimeter(lx, lz) && at(lx, plan.siteH + 1, lz) !== plan.wall) porte++;
      // Le dernier étage est toujours plein (les fenêtres s'arrêtent en dessous).
      if (isPerimeter(lx, lz) && at(lx, plan.siteH + plan.height, lz) !== plan.wall) faconnOk = false;
    }
  }
  check('le bâtiment est estampé', stamped === true, `retour=${stamped}`);
  check('la dalle repose sur son socle de pierre', dalleOk && socleOk && areteVu,
    `dalle=${dalleOk} remplissage=${socleOk} arete=${areteVu}`);
  check('le toit est une dalle pleine dégagée', toitOk && toitDegageOk, `toit=${toitOk} degage=${toitDegageOk}`);
  check('l’intérieur est évidé au rez-de-chaussée', interieurOk, `interieur=${interieurOk}`);
  check('les murs porteurs ferment le bâtiment', faconnOk, `face haute=${faconnOk}`);
  check('une seule baie de porte perce la façade', porte === 1, `${porte} ouverture(s) au premier étage`);

  const fenetres = (() => {
    let n = 0;
    for (let lx = plan.x0; lx < plan.x0 + plan.w; lx++) {
      for (let lz = plan.z0; lz < plan.z0 + plan.d; lz++) {
        if (!isPerimeter(lx, lz)) continue;
        for (let y = plan.siteH + 2; y <= plan.siteH + plan.height - 1; y++) {
          if (at(lx, y, lz) === BLOCK.GLASS) n++;
        }
      }
    }
    return n;
  })();
  check('les façades sont percées de fenêtres', fenetres > 0, `${fenetres} vitres`);
}

// Les planchers ne doivent pas faire barrière à la volée.
{
  const entry = [...plans.entries()].find(([, p]) => p.kind === 'tower' && p.stair);
  if (entry) {
    const [key, plan] = entry;
    const [cx, cz] = chunkOf(key);
    const data = emptyData();
    gen.stampBuilding(data, cx, cz);
    let planchers = 0;
    let bouches = 0;
    let dalles = 0;
    for (let y = plan.siteH + VILLAGE.floorPitch + 1; y <= plan.siteH + plan.height - 1; y += VILLAGE.floorPitch) {
      planchers++;
      for (const c of plan.stair.cells) {
        // Une marche qui tombe au niveau du plancher fait l'appui : seul le dallage
        // de sol est interdit sur le tracé.
        if (data[idx(c.lx, y, c.lz)] === BLOCK.STONE) bouches++;
      }
      for (let lx = plan.x0 + 1; lx <= plan.x0 + plan.w - 2; lx++) {
        for (let lz = plan.z0 + 1; lz <= plan.z0 + plan.d - 2; lz++) {
          if (data[idx(lx, y, lz)] === BLOCK.STONE) dalles++;
        }
      }
    }
    check('les immeubles ont des planchers', planchers > 0 && dalles > 0,
      `${planchers} niveau(x), ${dalles} dalles`);
    check('aucun plancher ne barre l’escalier', planchers > 0 && bouches === 0, `obstructions=${bouches}`);
  } else {
    check('les immeubles ont des planchers', false, 'aucun immeuble échantillonné');
    check('aucun plancher ne barre l’escalier', false, 'aucun immeuble échantillonné');
  }
}

// ------------------------------------------------------------ emprise au sol
{
  const cle = [...plans.keys()][0];
  const [cx, cz] = chunkOf(cle);
  const plan = plans.get(cle);
  const inside = gen.isOccupied(cx * CHUNK_SIZE + plan.x0 + 1, cz * CHUNK_SIZE + plan.z0 + 1);
  let champLibre = null;
  for (let wx = -300; wx <= 300 && !champLibre; wx += 3) {
    for (let wz = -300; wz <= 300 && !champLibre; wz += 3) {
      if (!gen.isOccupied(wx, wz)) champLibre = { wx, wz };
    }
  }
  check('l’emprise d’un bâtiment bloque la végétation', inside === true, `emprise=${inside}`);
  check('une colonne libre reste plantable', !!champLibre, champLibre ? `(${champLibre.wx},${champLibre.wz})` : 'tout est occupé');
  let surVoie = false;
  for (let wx = -200; wx <= 200 && !surVoie; wx++) {
    for (let wz = -200; wz <= 200 && !surVoie; wz++) {
      if (gen.roadKind(wx, wz) === 'bed') surVoie = gen.isOccupied(wx, wz);
    }
  }
  check('la chaussée bloque elle aussi la végétation', surVoie === true, `occupee=${surVoie}`);
}

// ------------------------------------------- entrées franchissables des deux côtés
{
  let defaut = null;
  for (const [key, plan] of plans) {
    const [cx, cz] = chunkOf(key);
    const at = stampArea(gen, cx, cz);
    const door = plan.door;
    if (!door) { defaut = `${key} : aucune baie de porte`; break; }
    // La baie se juge au plancher intérieur : c'est là que marche le passant et le linteau
    // est taillé depuis lui. Deux maisons qui se font face occupent parfois les deux mêmes
    // cellules d'approche avec des seuils différents — juger la baie au niveau relevé de la
    // rue reviendrait à reprocher au mur son propre linteau.
    if (at(door.lx, plan.siteH + 1, door.lz) !== BLOCK.AIR || at(door.lx, plan.siteH + 2, door.lz) !== BLOCK.AIR) {
      defaut = `${key} : la baie est bouchée (plancher ${plan.siteH})`; break;
    }
    // Côté rue, la porte ne doit donner ni sur un remblai ni sur le vide — et sur les
    // deux colonnes de la cour, pas seulement la première : depuis que la cour fait deux
    // cubes, c'est la seconde qui prend le passant au sortir du seuil pour le mener au
    // pavé. Le seuil suit la rue là où elle s'est haussée par ses escaliers : on le
    // cherche plutôt qu'on ne le suppose, mais une seule marche d'appui est admise.
    for (const palier of [door.front, door.out]) {
      if (palier.lx < 0 || palier.lx >= CHUNK_SIZE || palier.lz < 0 || palier.lz >= CHUNK_SIZE) continue;
      let seuil = plan.siteH;
      while (seuil < plan.siteH + 4 && at(palier.lx, seuil + 1, palier.lz) !== BLOCK.AIR) seuil++;
      if (seuil > plan.siteH + 1) {
        defaut = `${key} : sortie obstruee dehors à (${palier.lx},${palier.lz}) (+${seuil - plan.siteH})`; break;
      }
      const above = [at(palier.lx, seuil + 1, palier.lz), at(palier.lx, seuil + 2, palier.lz)];
      if (above[0] !== BLOCK.AIR || above[1] !== BLOCK.AIR) {
        defaut = `${key} : entrée obstruee dehors à (${palier.lx},${palier.lz}) (${above.join('/')})`; break;
      }
      // L'appui peut manquer d'un cube : la bande entière se juge à cette tolérance, et
      // descendre d'un cube en sortant reste franchissable. Plus bas, la porte donnerait
      // dans une cuvette.
      if (at(palier.lx, seuil, palier.lz) === BLOCK.AIR && at(palier.lx, seuil - 1, palier.lz) === BLOCK.AIR) {
        defaut = `${key} : pas de seuil devant la porte à (${palier.lx},${palier.lz})`; break;
      }
    }
    if (defaut) break;
  }
  check('tout bâtiment a une entrée franchissable depuis la rue', !defaut,
    defaut || `${plans.size} bâtiments vérifiés`);
}

// -------------------------------------- escalier intérieur menant jusqu'au toit
{
  const towers = [...plans.entries()].filter(([, p]) => p.kind === 'tower');
  let souci = null;
  let marchees = 0;
  for (const [key, plan] of towers) {
    const [cx, cz] = chunkOf(key);
    const s = plan.stair;
    if (!s || !Array.isArray(s.treads) || s.treads.length < plan.height) {
      souci = `${key} : pas d’escalier (${s && s.treads ? s.treads.length : 0} marches pour ${plan.height} niveaux)`;
      break;
    }
    const roofY = plan.siteH + plan.height + 1;
    const adjacent = (a, b) => Math.abs(a.lx - b.lx) + Math.abs(a.lz - b.lz) === 1;
    // Les niveaux se gravissent dans l'ordre, un cran à la fois. Un escalier à palier
    // répète le même niveau sur les colonnes du palier — c'est ce que demande l'utilisateur
    // (« des escalier avec un palier ») — mais il ne saute jamais un cran et n'en descend
    // jamais un.
    let attendu = plan.siteH + 1;
    for (let k = 0; k < s.treads.length; k++) {
      const tread = s.treads[k];
      const cells = tread.cells;
      // Deux colonnes de large : le collider du joueur (0,6) chevauche la voisine,
      // une volée d'une seule colonne se heurte au plafond d'à côté.
      if (!Array.isArray(cells) || cells.length !== 2 || !adjacent(cells[0], cells[1])) {
        souci = `${key} : marche ${k} plus étroite qu'un joueur (${cells && cells.length} colonne(s))`;
        break;
      }
      if (tread.y === attendu) attendu++;
      else if (!(tread.palier && tread.y === attendu - 1)) {
        souci = `${key} : marche ${k} posée à y=${tread.y}, attendu ${attendu}${tread.palier ? ' (palier)' : ''}`;
        break;
      }
      for (const c of cells) {
        if (c.lx <= plan.x0 || c.lx >= plan.x0 + plan.w - 1 || c.lz <= plan.z0 || c.lz >= plan.z0 + plan.d - 1) {
          souci = `${key} : marche ${k} dans un mur (${c.lx},${c.lz})`; break;
        }
        if (c.lx === plan.door.in.lx && c.lz === plan.door.in.lz) {
          souci = `${key} : la volée démarre dans le sas de la porte`; break;
        }
      }
      if (souci) break;
      if (k > 0) {
        const prev = s.treads[k - 1].cells;
        // Le palier doit se rejoindre en un pas : sinon le joueur fait le tour du bâtiment.
        if (!cells.some((c) => prev.some((p) => adjacent(p, c)))) {
          souci = `${key} : marche ${k} disjointe de la précédente`; break;
        }
      }
      marchees++;
    }
    if (souci) break;
    const last = s.treads[s.treads.length - 1];
    if (last.y !== roofY - 1) { souci = `${key} : dernière marche à y=${last.y}, attendu ${roofY - 1}`; break; }

    const at = stampArea(gen, cx, cz);
    for (const tread of s.treads) {
      for (const c of tread.cells) {
        if (at(c.lx, tread.y, c.lz) === BLOCK.AIR) { souci = `${key} : marche non posée en (${c.lx},${c.lz})`; break; }
        // Trois cubes libres au-dessus du plateau : le corps fait 1,8 et l'auto-franchissement
        // d'une marche lève la tête d'un cran de plus. Moins que ça, la marche devient un mur.
        for (let y = tread.y + 1; y <= tread.y + 3; y++) {
          if (at(c.lx, y, c.lz) !== BLOCK.AIR) {
            souci = `${key} : tête bloquée à y=${y} au-dessus de (${c.lx},${c.lz})`;
            break;
          }
        }
        if (souci) break;
      }
      if (souci) break;
    }
    if (souci) break;
    // Baie d'accès à la terrasse : la dalle est percée au droit des dernières marches…
    for (const c of last.cells) {
      if (at(c.lx, roofY, c.lz) !== BLOCK.AIR || at(c.lx, roofY + 1, c.lz) !== BLOCK.AIR) {
        souci = `${key} : aucune ouverture au dernier étage pour monter sur le toit`; break;
      }
    }
    if (souci) break;
    // …et les deux colonnes devant offrent un appui plein coiffé de deux cubes d'air.
    if (!Array.isArray(s.exit) || s.exit.length !== 2) { souci = `${key} : pas de marche d'appel sur le toit`; break; }
    for (const c of s.exit) {
      if (at(c.lx, roofY, c.lz) === BLOCK.AIR) { souci = `${key} : rien où poser le pied en sortant (${c.lx},${c.lz})`; break; }
      if (at(c.lx, roofY + 1, c.lz) !== BLOCK.AIR || at(c.lx, roofY + 2, c.lz) !== BLOCK.AIR) {
        souci = `${key} : sortie de toit sous une voûte (${c.lx},${c.lz})`; break;
      }
    }
  }
  check('les immeubles ont un escalier qui monte jusqu’au toit', towers.length > 0 && !souci,
    souci || `${towers.length} immeubles, ${marchees} marches contrôlées`);

  // « des escalier avec un palier » (2026-11-11). Une volée s'arrête à `stairFlightMax`
  // marches et se repose sur un plateau plat : sans palier, une tour de dix étages ne
  // souffle qu'une rampe continue de cinquante-quatre cubes, et le contrôle ci-dessus ne
  // verrait rien — il juge l'ordre des niveaux, pas leur repos.
  let sansPalier = [];
  let paliersVus = 0;
  let longuesVolées = 0;
  for (const [key, plan] of towers) {
    const s = plan.stair;
    if (!s) continue;
    const n = s.treads.filter((t) => t.palier).length;
    paliersVus += n;
    if (plan.height <= VILLAGE.stairFlightMax) continue;
    longuesVolées++;
    if (n < VILLAGE.stairPalier && sansPalier.length < 3) sansPalier.push(`${key} (${plan.height} cubes)`);
  }
  check('la volée d\'un immeuble compte un palier avant de repartir',
    towers.length > 0 && paliersVus > 0 && !sansPalier.length,
    sansPalier.length ? `${detail(sansPalier, 'volée(s) sans palier')}`
      : `${paliersVus} colonnes de palier · ${longuesVolées} immeuble(s) plus hauts qu'une volée`);
}

// -------------------------------- distribution des immeubles en appartements
// « 3 piece par etage chaque piece doit faire 4 cube sur 4 », avec portes et baies de
// quatre sur quatre, puis « il y a pas de couloir qui mene vers des pieces avec des
// portes » (2026-11-11). Le plan se juge dans le voxel, étage par étage : un plan
// théorique qui ne serait pas estampé, ou ravalé par la volée, passerait ici.
{
  const aptTowers = [...plans.entries()].filter(([, p]) => p.kind === 'tower' && p.appartements);
  const soucis = [];
  let etagesVus = 0;
  let colonnesJugees = 0;
  const pas = VILLAGE.floorPitch;
  const dansRect = (r, c) => c.lx >= r.x0 && c.lx <= r.x0 + r.w - 1
    && c.lz >= r.z0 && c.lz <= r.z0 + r.d - 1;
  const voisinDe = (r, c) => [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .some(([dx, dz]) => dansRect(r, { lx: c.lx + dx, lz: c.lz + dz }));
  for (const [key, plan] of aptTowers) {
    const [cx, cz] = chunkOf(key);
    const at = stampArea(gen, cx, cz);
    const apt = plan.appartements;
    if (apt.pieces.length < 2) { soucis.push(`${key} : ${apt.pieces.length} pièce(s), deux attendues`); break; }
    // Le passant entre par la porte sur rue et doit rejoindre le couloir sans jamais
    // traverser une pièce privée ni un mur : les colonnes du sas sont jugées libres.
    if (!apt.entree.some((c) => c.lx === plan.door.in.lx && c.lz === plan.door.in.lz)) {
      soucis.push(`${key} : derrière la porte (${plan.door.in.lx},${plan.door.in.lz}) n'est pas le sas d'entrée`);
      break;
    }
    for (const pce of apt.pieces) {
      const xs = new Set(pce.sol.map((c) => c.lx));
      const zs = new Set(pce.sol.map((c) => c.lz));
      if (pce.sol.length !== 16 || xs.size !== 4 || zs.size !== 4) signalerPiece(pce, key, soucis);
      // Une porte qui ne donne pas sur le couloir n'est pas une porte d'appartement.
      if (!voisinDe(apt.couloir, pce.porte)) {
        soucis.push(`${key} : la porte (${pce.porte.lx},${pce.porte.lz}) ne jouxte pas le couloir`);
      }
    }
    for (let k = 0; ; k++) {
      const sol = k === 0 ? plan.siteH : plan.siteH + 1 + k * pas;
      const suivante = plan.siteH + 1 + (k + 1) * pas;
      // Mêmes règles qu'à l'estampage : on ne juge que les étages que le générateur
      // s'interdit d'habiter au-dessous du garde-tête.
      if (sol > plan.siteH + plan.height - 1 - VILLAGE.headroom) break;
      const bas = sol + 1;
      const haut = Math.min(suivante - 1, plan.siteH + plan.height - 1);
      // Le garde-tête se juge entre la dalle d'étage et la sous-face de la suivante. Le
      // rez-de-chaussée prend un cube de plus : sa « dalle » est le terrain, qui ne mange
      // pas d'épaisseur — c'est ce qui lui donne un air de pied-droit, pas un défaut.
      const libre = haut - bas + 1;
      if (libre < VILLAGE.headroom || libre > VILLAGE.headroom + 1) {
        soucis.push(`${key} : étage ${k} haut de ${libre} cubes, attendu ${VILLAGE.headroom}`);
        break;
      }
      etagesVus++;
      for (const pce of apt.pieces) {
        for (const c of pce.sol) {
          for (let y = bas; y <= haut; y++) {
            colonnesJugees++;
            if (at(c.lx, y, c.lz) !== BLOCK.AIR) {
              soucis.push(`${key} : étage ${k}, pièce occupée en (${c.lx},${c.lz})@${y} = ${at(c.lx, y, c.lz)}`);
            }
          }
        }
        for (let y = bas; y <= bas + 2; y++) {
          colonnesJugees++;
          if (at(pce.porte.lx, y, pce.porte.lz) !== BLOCK.AIR) {
            soucis.push(`${key} : étage ${k}, porte bouchée en (${pce.porte.lx},${pce.porte.lz})@${y}`);
          }
        }
        const basBaie = Math.max(bas, haut - 3);
        for (const c of pce.baie) {
          for (let y = basBaie; y <= haut; y++) {
            colonnesJugees++;
            if (at(c.lx, y, c.lz) !== BLOCK.GLASS) {
              soucis.push(`${key} : étage ${k}, baie non vitrée en (${c.lx},${c.lz})@${y} = ${at(c.lx, y, c.lz)}`);
            }
          }
        }
      }
      for (const c of apt.cloisons.concat(apt.murCouloir, apt.murDos)) {
        for (let y = bas; y <= haut; y++) {
          colonnesJugees++;
          if (at(c.lx, y, c.lz) === BLOCK.AIR) {
            soucis.push(`${key} : étage ${k}, cloison absente en (${c.lx},${c.lz})@${y}`);
          }
        }
      }
      // Le couloir et son sas se parcourent debout, du seuil jusqu'aux portes. C'est le
      // contrôle qui aurait attrapé la nef vide : sans mur de dos, le couloir n'existe pas.
      const couloirCells = [];
      for (let lx = apt.couloir.x0; lx <= apt.couloir.x0 + apt.couloir.w - 1; lx++) {
        for (let lz = apt.couloir.z0; lz <= apt.couloir.z0 + apt.couloir.d - 1; lz++) {
          couloirCells.push({ lx, lz });
        }
      }
      const longueurCouloir = Math.max(apt.couloir.w, apt.couloir.d);
      if (longueurCouloir < 4) {
        soucis.push(`${key} : couloir de ${apt.couloir.w}×${apt.couloir.d}, quatre colonnes au moins attendues`);
      }
      // Un couloir se reconnaît à ses deux murs : celui des portes et son dos. L'un
      // manque-t-il que les pièces ouvrent sur le hall, ce exactement le défaut signalé.
      if (apt.murCouloir.length < (longueurCouloir >> 1) || apt.murDos.length < (longueurCouloir >> 1)) {
        soucis.push(`${key} : couloir de ${longueurCouloir} colonnes muralé sur ${apt.murCouloir.length} et ${apt.murDos.length}`);
      }
      for (const c of couloirCells.concat(apt.entree)) {
        for (let y = bas; y <= haut; y++) {
          colonnesJugees++;
          if (at(c.lx, y, c.lz) !== BLOCK.AIR) {
            soucis.push(`${key} : étage ${k}, passage bouché en (${c.lx},${c.lz})@${y} = ${at(c.lx, y, c.lz)}`);
          }
        }
      }
      if (soucis.length > 3) break;
    }
    if (soucis.length > 3) break;
  }
  function signalerPiece(pce, key, bucket) {
    bucket.push(`${key} : pièce de ${pce.sol.length} colonnes (${new Set(pce.sol.map((c) => c.lx)).size}×${new Set(pce.sol.map((c) => c.lz)).size}), attendu 4×4`);
  }
  // Exigence durcie le 2026-11-11 après le signalement « j'ai des immeubles sans pieces
  // avec porte l'interieur » : une tour sans pièces n'est pas un immeuble, c'est une
  // coquille de brique avec un escalier dedans. Mesuré avant correction, sur R = 26 :
  // 28 immeubles sur 71 posés sur une emprise trop étroite pour loger couloir et pièces,
  // dont dix de 8×7 montant jusqu'à quatorze étages sans une seule porte. La parcelle qui
  // ne peut pas loger de pièces devient désormais une maison.
  const toursVides = [...plans.entries()]
    .filter(([, p]) => p.kind === 'tower' && !(p.appartements && p.appartements.pieces.length >= 2))
    .map(([k, p]) => `${k} ${p.w}x${p.d} · ${storeysOf(p.height)} étage(s)`);
  check('tout immeuble posé est distribué en pièces sur couloir',
    towers.length > 0 && toursVides.length === 0 && aptTowers.length === towers.length,
    toursVides.slice(0, 3).join(' | ')
      || `${aptTowers.length}/${towers.length} immeuble(s) avec plan d'appartement`);
  check('chaque pièce fait quatre cubes libres de côté', !soucis.length,
    soucis.length ? soucis.slice(0, 3).join(' | ')
      : `${aptTowers.length} immeuble(s), ${etagesVus} étage(s), ${colonnesJugees} cubes jugés`);
  check('chaque pièce a sa porte ouverte sur trois cubes', !soucis.some((s) => /porte/.test(s)),
    soucis.filter((s) => /porte/.test(s)).slice(0, 2).join(' | '));
  check('chaque pièce a sa baie vitrée de quatre sur quatre', !soucis.some((s) => /baie/.test(s)),
    soucis.filter((s) => /baie/.test(s)).slice(0, 2).join(' | '));
  check('les cloisons séparent les pièces du couloir', !soucis.some((s) => /cloison/.test(s)),
    soucis.filter((s) => /cloison/.test(s)).slice(0, 2).join(' | '));
  check('un couloir muralé mène aux portes des pièces',
    !soucis.some((s) => /couloir|passage/.test(s)),
    soucis.filter((s) => /couloir|passage/.test(s)).slice(0, 2).join(' | '));
  check('l’entrée sur rue débouche sur le couloir', !soucis.some((s) => /sas/.test(s)),
    soucis.filter((s) => /sas/.test(s)).slice(0, 2).join(' | '));
}

// ----------------------------------------------- la ville concentre bâti et hauteurs
{
  const R = 22;
  let villeChunks = 0, campagneChunks = 0;
  let villePlans = 0, campagnePlans = 0;
  let tourDeVille = 0, tourDeCampagne = 0;
  let etagesDeVille = 0, etagesDeCampagne = 0;
  const etages = (p) => storeysOf(p.height);
  const gabarits = new Set();
  // Les trois types de ville — demandé le 2026-11-11 : « ajouter 3 type de ville small
  // medium et large ». Chaque type est jugé chez lui : il ne doit jamais dépasser le
  // plafond qu'il porte, et les trois paliers doivent être distincts, sinon régler leurs
  // proportions à l'écran de génération ne changerait rien de visible.
  const parType = VILLAGE.cityTypes.map(() => ({ immeubles: 0, etagesMax: 0, troncons: 0 }));
  for (let cx = -R; cx <= R; cx++) {
    for (let cz = -R; cz <= R; cz++) {
      const wx = cx * CHUNK_SIZE + (CHUNK_SIZE >> 1);
      const wz = cz * CHUNK_SIZE + (CHUNK_SIZE >> 1);
      const inf = gen.cityInfluence(wx, wz);
      const type = inf >= 0.5 ? gen.cityTypeAt(wx, wz) : -1;
      const list = gen.buildingAt(cx, cz);
      if (inf >= 0.5) { villeChunks++; villePlans += list.length; }
      else if (inf <= 0.12) { campagneChunks++; campagnePlans += list.length; }
      if (type >= 0) parType[type].troncons++;
      for (const p of list) {
        gabarits.add(`${p.kind}:${p.w}x${p.d}x${p.height}`);
        if (p.kind !== 'tower') continue;
        if (type >= 0) {
          const t = parType[type];
          t.immeubles++;
          t.etagesMax = Math.max(t.etagesMax, etages(p));
        }
        if (inf >= 0.5) {
          tourDeVille = Math.max(tourDeVille, p.height);
          etagesDeVille = Math.max(etagesDeVille, etages(p));
        } else if (inf <= 0.12) {
          tourDeCampagne = Math.max(tourDeCampagne, p.height);
          etagesDeCampagne = Math.max(etagesDeCampagne, etages(p));
        }
      }
    }
  }
  const densiteVille = villePlans / Math.max(1, villeChunks);
  const densiteCampagne = campagnePlans / Math.max(1, campagneChunks);
  check('la ville concentre le bâti', villeChunks > 20 && campagneChunks > 20
    && densiteVille > densiteCampagne * 1.8,
  `ville=${densiteVille.toFixed(2)} bâtiment/tronçon, campagne=${densiteCampagne.toFixed(2)}`);
  // La campagne ne dépasse pas la plus basse des catégories demandées (3 étages), jeu
  // de un à deux cubes compris : c'est le sens de « leur fréquence diminue avec le
  // nombre d'etage » et de « hauteur liée à l'influence », pas un chiffre magique.
  const plafondCampagne = hauteurPourEtages(VILLAGE.towerFloors[0]) + 2;
  check('les tours de ville sont plus hautes que celles de la campagne',
    tourDeVille >= 14 && tourDeCampagne <= plafondCampagne && tourDeVille > tourDeCampagne,
    `ville=${tourDeVille}, campagne=${tourDeCampagne} (plafond de la plus basse catégorie ${plafondCampagne})`);
  check('le cœur de ville monte jusqu’à dix étages, la campagne reste basse',
    etagesDeVille >= 10 && etagesDeCampagne <= 3,
    `étages max ville=${etagesDeVille} (hauteur ${tourDeVille}), campagne=${etagesDeCampagne} (hauteur ${tourDeCampagne}), un étage = ${VILLAGE.floorPitch} blocs`);
  check('les gabarits sont variés', gabarits.size >= 40, `${gabarits.size} empreintes différentes`);
  check('les trois types de ville existent dans le monde',
    parType.every((t) => t.troncons > 0 && t.immeubles > 0),
    parType.map((t, i) => `${VILLAGE.cityTypes[i].nom} ${t.immeubles} immeubles`
      + ` sur ${t.troncons} tronçons`).join(' · '));
  check('petite, moyenne et grande ville montent par paliers',
    parType.every((t, i) => t.etagesMax <= VILLAGE.cityTypes[i].etagesMax)
    && parType[0].etagesMax < parType[1].etagesMax
    && parType[1].etagesMax < parType[2].etagesMax,
    parType.map((t, i) => `${VILLAGE.cityTypes[i].nom} ${t.etagesMax}/${VILLAGE.cityTypes[i].etagesMax}`)
      .join(' < '));
}

// ------------------------------------------------------ l'emprise des trois types
{
  // Le rayon d'influence est ce qui fait la taille d'une agglomération : on le juge sur
  // pied, en arpentant des avenues — la plus longue suite de tronçons tenus à mi-distance
  // du même centre est proportionnelle au rayon du type qui la commande.
  const rangeeMax = VILLAGE.cityTypes.map(() => 0);
  for (let cz = -24; cz <= 24; cz += 3) {
    let run = 0;
    let runType = -1;
    for (let cx = -24; cx <= 24; cx++) {
      const wx = cx * CHUNK_SIZE + (CHUNK_SIZE >> 1);
      const wz = cz * CHUNK_SIZE + (CHUNK_SIZE >> 1);
      const inf = gen.cityInfluence(wx, wz);
      const type = inf >= 0.5 ? gen.cityTypeAt(wx, wz) : -1;
      if (type < 0) { runType = -1; run = 0; continue; }
      run = type === runType ? run + 1 : 1;
      runType = type;
      rangeeMax[type] = Math.max(rangeeMax[type], run);
    }
  }
  check('la grande ville occupe plus de terrain que la moyenne, qui en occupe plus que la petite',
    rangeeMax[0] >= 2 && rangeeMax[0] < rangeeMax[1] && rangeeMax[1] < rangeeMax[2],
    `plus longue suite urbaine : ${rangeeMax.join(' < ')} tronçons`);
}

// ------------------------------------------------------------ déterminisme
{
  const twin = makeGen(0);
  const other = makeGen(12345);
  const a = JSON.stringify([...scanPlans(gen, RADIUS).entries()]);
  const b = JSON.stringify([...scanPlans(twin, RADIUS).entries()]);
  check('deux générations indépendantes rendent le même village', a === b,
    a === b ? '' : `longueurs ${a.length}/${b.length}`);
  check('demander deux fois le même plan le renvoie identique',
    JSON.stringify(gen.buildingAt(2, -3)) === JSON.stringify(gen.buildingAt(2, -3)));
  const changed = JSON.stringify([...scanPlans(other, RADIUS).entries()]) !== a;
  check('changer la graine du village redessine le réseau', changed);
  const routesAutres = (() => {
    let diffs = 0;
    for (let wx = -200; wx <= 200; wx += 5) {
      for (let wz = -200; wz <= 200; wz += 5) {
        if (other.roadKind(wx, wz) !== gen.roadKind(wx, wz)) diffs++;
      }
    }
    return diffs;
  })();
  check('la graine déplace aussi les routes', routesAutres > 100, `${routesAutres} colonnes différentes`);
}

// ---------------------------------- ouvrages d'art : ponts et arcs de triomphe
{
  // Le relief lisse utilisé jusqu'ici ne présente aucun vallon à franchir : les
  // ouvrages se contrôlent sur une carte à gorges, dessinée comme le paysage du jeu —
  // un plateau douément ondulé entaillé de sillons dont la pente se concentre au fond
  // (sigmoïde). Il faut que le creux dépasse `bridgeMinDip` et que la portée atteigne
  // `bridgeMinSpan` : une carte plus douce ne donne plus aucun pont depuis que le
  // tablier doit aussi laisser la place de passer dessous.
  const GORGE_DEPTH = 19;
  const heightAtValleys = (x, z) => {
    const plateau = 30 + Math.round(2.5 * Math.sin(x / 131) + 2.5 * Math.cos(z / 109));
    const t = Math.min(1, Math.abs(
      Math.sin((x + z) / 52) + Math.cos((x - z) / 71) + 0.3 * Math.cos(z / 53),
    ) / 0.75);
    return plateau - Math.round(GORGE_DEPTH * (1 - t * t * (3 - 2 * t)));
  };
  const gorges = createVillageGen({
    BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt: heightAtValleys, roll: hashRoll, saltBase: 0,
  });

  const R = 12;
  // Clé et empreinte digitale d'un ouvrage : les trois familles n'ont pas les mêmes
  // coordonnées (le temple se pose sur une maille, le pont sur une avenue), et une clé
  // qui les confondrait écraserait tous les temples dans un seul `undefined`.
  const cleOuvrage = (s) => (s.kind === 'temple' ? `t:${s.i},${s.j}` : `${s.kind}:${s.axis}:${s.k}:${s.seg}`);
  const empreinte = (s) => (s.kind === 'bridge'
    ? ['b', s.axis, s.k, s.seg, s.ds, s.de, s.deckY, [...s.ramp]]
    : s.kind === 'arch'
      ? ['a', s.axis, s.k, s.seg, s.t0, s.t1, s.g, [...s.levels]]
      : ['t', s.i, s.j, s.ex, s.ez, s.socle, s.door]);
  const found = new Map();
  for (let cx = -R; cx <= R; cx++) {
    for (let cz = -R; cz <= R; cz++) {
      for (const s of gorges.structuresAt(cx, cz)) found.set(cleOuvrage(s), s);
    }
  }
  const ponts = [...found.values()].filter((s) => s.kind === 'bridge');
  const arcs = [...found.values()].filter((s) => s.kind === 'arch');

  // Voxels reconstitués comme dans le jeu : le remplissage naturel est omis, ni la
  // voirie ni les ouvrages n'écrivent hors de leur emprise.
  const tampons = new Map();
  const bufferOf = (cx, cz) => {
    const key = `${cx},${cz}`;
    if (!tampons.has(key)) {
      const data = emptyData();
      gorges.stampRoads(data, cx, cz);
      gorges.stampBuilding(data, cx, cz);
      gorges.stampStructures(data, cx, cz);
      tampons.set(key, data);
    }
    return tampons.get(key);
  };
  const lu = (wx, wy, wz) => {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    return bufferOf(cx, cz)[(wx - cx * CHUNK_SIZE) + (wz - cz * CHUNK_SIZE) * CHUNK_SIZE
      + wy * CHUNK_SIZE * CHUNK_SIZE];
  };
  const plein = (wx, wy, wz) => lu(wx, wy, wz) !== BLOCK.AIR;
  const cellWorld = (axis, k, along, off) => (axis === 'x'
    ? { wx: along, wz: k * VILLAGE.roadSpacing + off }
    : { wx: k * VILLAGE.roadSpacing + off, wz: along });
  const sol = (axis, k, along, off) => {
    const c = cellWorld(axis, k, along, off);
    return heightAtValleys(c.wx, c.wz);
  };

  // Les colonnes que réclament les entrées de bâtiment : aucun ouvrage ne doit les prendre.
  const portes = new Set();
  for (let cx = -R; cx <= R; cx++) {
    for (let cz = -R; cz <= R; cz++) {
      for (const p of gorges.buildingAt(cx, cz)) {
        const bx = cx * CHUNK_SIZE;
        const bz = cz * CHUNK_SIZE;
        for (const c of [p.door, p.door.front, p.door.out]) portes.add(`${bx + c.lx},${bz + c.lz}`);
      }
    }
  }
  const porteEcrasee = (axis, k, from, to, half) => {
    for (let i = from; i <= to; i++) {
      for (let o = -half; o <= half; o++) {
        const c = cellWorld(axis, k, i, o);
        if (portes.has(`${c.wx},${c.wz}`)) return `(${c.wx},${c.wz})`;
      }
    }
    return null;
  };

  // ---- ponts
  let souciPont = ponts.length ? null : 'aucun pont généré sur cette carte';
  let piles = 0;
  let arcades = 0;
  let etallees = 0;
  let tabliers = 0;
  for (const b of ponts) {
    if (souciPont) break;
    const tag = `pont ${b.axis}${b.k}#${b.seg}${b.surEau ? ' (eau)' : ''}`;
    // Un franchissement d'eau se juge à d'autres bornes qu'un pont de creux : sa portée
    // est celle de l'eau, non du vallon, et sa « garde » se compte depuis le plan d'eau
    // (`waterFreeboard`, pour que le chenal se nage) au lieu du creux naturel.
    const minPortee = b.surEau ? VILLAGE.waterMinSpan : VILLAGE.bridgeMinSpan;
    const maxPortee = b.surEau
      ? VILLAGE.waterMaxSpan + 2 * VILLAGE.bridgeMaxRamp : VILLAGE.bridgeMaxSpan;
    if (b.span < minPortee || b.span > maxPortee) {
      souciPont = `${tag} : portée ${b.span} hors bornes [${minPortee}, ${maxPortee}]`;
      break;
    }
    const gardeVoulue = b.surEau ? VILLAGE.waterFreeboard : VILLAGE.bridgeMinDip;
    if (b.deckY - b.floorH < gardeVoulue) {
      souciPont = `${tag} : tablier à seulement ${b.deckY - b.floorH} au-dessus du fond`;
      break;
    }
    // Un tablier doit rejoindre le terrain des deux côtés, sinon il pend dans le vide.
    // Sur l'eau, cette rencontre se fait par les approches descendantes — c'est le
    // contrôle de ressaut colonne par colonne qui en répond, pas une berge sous la pile.
    if (!b.surEau
      && (sol(b.axis, b.k, b.ds - 1, 0) < b.deckY || sol(b.axis, b.k, b.de + 1, 0) < b.deckY)) {
      souciPont = `${tag} : aucune berge sous une extrémité`;
      break;
    }
    const niveaux = new Map();
    for (let i = b.ds; i <= b.de; i++) niveaux.set(i, b.deckY);
    for (const [i, s] of b.ramp) niveaux.set(i, s);
    // Hors tablier et hors rampe, rien n'est posé : c'est la rue qui reprend la main.
    // Sur un franchissement d'eau, cette rue est celle que la voirie se pose — profil
    // conduit à un cube par colonne — et non le terrain brut : juger le ressaut contre
    // le sable ne dirait rien de ce que marche le joueur.
    const rueLibre = (i, o) => {
      const c = cellWorld(b.axis, b.k, i, o);
      if (!b.surEau) return o === 0 ? sol(b.axis, b.k, i, 0) : heightAtValleys(c.wx, c.wz);
      const niveau = gorges.roadSurface(c.wx, c.wz, false);
      return niveau === null ? heightAtValleys(c.wx, c.wz) : niveau;
    };
    const niveauDe = (i) => (niveaux.has(i) ? niveaux.get(i) : rueLibre(i, 0));
    let prec = null;
    for (let i = b.from; i <= b.to && !souciPont; i++) {
      const s = niveauDe(i);
      // Le joueur ne franchit qu'un cube à la fois : la rampe doit être gravie debout.
      if (prec !== null && Math.abs(s - prec) > 1) {
        souciPont = `${tag} : ressaut de ${Math.abs(s - prec)} cubes à la colonne ${i}`;
        break;
      }
      prec = s;
      for (let o = -b.half; o <= b.half && !souciPont; o++) {
        const c = cellWorld(b.axis, b.k, i, o);
        if (!gorges.roadKind(c.wx, c.wz)) { souciPont = `${tag} : déborde de la voirie en (${c.wx},${c.wz})`; break; }
        // Dans l'emprise, l'ouvrage impose son niveau ; hors d'elle, chaque cellule rend
        // sa chaussée au niveau naturel qui est le sien, pas celui de l'axe.
        const sCell = niveaux.has(i) ? s : rueLibre(i, o);
        if (!plein(c.wx, sCell, c.wz)) { souciPont = `${tag} : chaussée absente en (${c.wx},${c.wz},${sCell})`; break; }
        // Garde-fou admis sur les caniveaux : la tête du joueur se contrôle sur la
        // chaussée. Une avenue qui croise la nôtre peut imposer un appui un cube plus
        // haut — le joueur franchit ce cube, la garde-tête se compte depuis lui.
        if (Math.abs(o) <= VILLAGE.roadHalf) {
          let marche = sCell;
          while (marche < sCell + 1 && plein(c.wx, marche + 1, c.wz)) marche++;
          for (let y = marche + 1; y <= marche + VILLAGE.headroom; y++) {
            if (plein(c.wx, y, c.wz)) { souciPont = `${tag} : tête bloquée en (${c.wx},${c.wz},${y})`; break; }
          }
        }
      }
    }
    if (souciPont) break;
    // Comme pour l'arc, la rampe doit rejoindre la rue sans ressaut.
    const raccordPont = Math.max(
      Math.abs(niveauDe(b.from) - rueLibre(b.from - 1, 0)),
      Math.abs(niveauDe(b.to) - rueLibre(b.to + 1, 0)),
    );
    if (raccordPont > 1) { souciPont = `${tag} : raccord de rampe de ${raccordPont} cubes`; break; }
    const ecrasee = porteEcrasee(b.axis, b.k, b.from, b.to, b.half);
    if (ecrasee) { souciPont = `${tag} : entrée de bâtiment murée en ${ecrasee}`; break; }

    // Piles pleines jusqu'au sol, et au moins une travée évidée en arc entre elles.
    const every = VILLAGE.bridgePierEvery;
    let vuPile = false;
    let vuArcade = false;
    for (let i = b.ds; i <= b.de && !souciPont; i++) {
      const bay = ((i - b.ds) % every + every) % every;
      const g = sol(b.axis, b.k, i, 0);
      const c = cellWorld(b.axis, b.k, i, 0);
      if (bay < 2) {
        let pleine = true;
        for (let y = g + 1; y < b.deckY; y++) if (!plein(c.wx, y, c.wz)) { pleine = false; break; }
        if (!pleine) { souciPont = `${tag} : pile ajourée à la colonne ${i}`; break; }
        vuPile = true;
      } else {
        for (let y = g + 1; y < b.deckY; y++) {
          if (!plein(c.wx, y, c.wz)) { vuArcade = true; break; }
        }
      }
    }
    if (souciPont) break;
    if (!vuPile) { souciPont = `${tag} : aucune pile`; break; }
    if (!vuArcade) { souciPont = `${tag} : tablier plein, aucune travée d'arc`; break; }

    // Un pont qui ne laisse pas marcher dessous n'est qu'un remblai : le creux du
    // paysage doit se lire en hauteur libre, mesurée ici depuis le sol naturel jusqu'au
    // premier cube plein du tablier, sur assez de colonnes pour qu'on y passe à pied.
    if (b.clearance < VILLAGE.bridgeClearance) {
      souciPont = `${tag} : ${b.clearance} cubes libres sous le tablier sur ${VILLAGE.bridgeClearance} voulus`;
    }
    let degagees = 0;
    let libreMax = 0;
    for (let i = b.ds; i <= b.de && !souciPont; i++) {
      const c = cellWorld(b.axis, b.k, i, 0);
      const g = sol(b.axis, b.k, i, 0);
      let y = b.deckY - 1;
      while (y > g && !plein(c.wx, y, c.wz)) y--;
      const libre = b.deckY - 1 - y;
      libreMax = Math.max(libreMax, libre);
      if (libre >= b.clearance) degagees++;
    }
    if (!souciPont && degagees < VILLAGE.bridgeMinArcade) {
      souciPont = `${tag} : ${degagees} colonne(s) libre(s) sous le tablier sur ${VILLAGE.bridgeMinArcade} voulues`;
    }
    if (souciPont) break;
    piles += vuPile ? 1 : 0;
    arcades += vuArcade ? 1 : 0;
    etallees += libreMax >= VILLAGE.bridgeClearance ? 1 : 0;
    tabliers++;
  }
  check('les avenues sont portées en pont au-dessus des creux',
    ponts.length >= 3 && !souciPont,
    `${ponts.length} pont(s) retenu(s) — `
    + (souciPont || `${tabliers} tablier(s) de niveau constant, ${piles} avec piles descendues `
      + `au sol, ${arcades} avec travées évidées, ${etallees} laissant au moins ${VILLAGE.bridgeClearance} `
      + `cubes libres au-dessus du sol`));

  // ---- arcs de triomphe
  let souciArc = arcs.length ? null : 'aucun arc généré sur cette carte';
  let passages = 0;
  // Le pavé que le joueur emprunte à cette colonne de l'axe : c'est la seule référence
  // qui vaille pour un monument qui enjambe la rue. Jugé contre le relief brut, le
  // raccord échouait dès que l'avenue roule en remblai (mesuré arc z0#−1 : dix cubes).
  const pave = (axis, k, along) => {
    const c = cellWorld(axis, k, along, 0);
    return gorges.roadSurface(c.wx, c.wz, true);
  };
  for (const a of arcs) {
    if (souciArc) break;
    const tag = `arc ${a.axis}${a.k}#${a.seg}`;
    let prec = null;
    for (let i = a.lo; i <= a.hi && !souciArc; i++) {
      const s = a.levels.get(i);
      if (s === undefined) { souciArc = `${tag} : approche sans niveau à la colonne ${i}`; break; }
      if (prec !== null && Math.abs(s - prec) > 1) {
        souciArc = `${tag} : ressaut de ${Math.abs(s - prec)} cubes à l'approche ${i}`;
        break;
      }
      prec = s;
    }
    // Raccord avec la chaussée aux deux bouts de l'ouvrage : le monument se pose sur la
    // rue, il ne la commande plus. Une approche qui prendrait ses distances avec le pavé
    // offrirait un ressaut au sortant du passage.
    const raccord = Math.max(
      Math.abs(a.levels.get(a.lo) - pave(a.axis, a.k, a.lo - 1)),
      Math.abs(a.levels.get(a.hi) - pave(a.axis, a.k, a.hi + 1)),
    );
    if (raccord > 1) { souciArc = `${tag} : raccord d'approche de ${raccord} cubes`; break; }
    const spring = a.g + a.clear;
    for (let i = a.t0; i <= a.t1 && !souciArc; i++) {
      const s = a.levels.get(i);
      // De plain-pied avec l'avenue : le socle ne doit ni dépasser du pavé ni y creuser
      // une cuvette — c'est ce qui faisait monter l'avenue de deux cubes sous l'arc.
      const rue = pave(a.axis, a.k, i);
      if (rue !== s) { souciArc = `${tag} : socle à ${s} sous une chaussée à ${rue}, colonne ${i}`; break; }
      for (let o = -a.half; o <= a.half && !souciArc; o++) {
        const c = cellWorld(a.axis, a.k, i, o);
        if (!gorges.roadKind(c.wx, c.wz)) { souciArc = `${tag} : déborde de la voirie en (${c.wx},${c.wz})`; break; }
        if (!plein(c.wx, s, c.wz)) { souciArc = `${tag} : chaussée absente en (${c.wx},${c.wz},${s})`; break; }
        if (!plein(c.wx, spring + 1, c.wz) || !plein(c.wx, spring + 2, c.wz)) {
          souciArc = `${tag} : entablement incomplet en (${c.wx},${c.wz})`;
          break;
        }
        const ao = Math.abs(o);
        if (ao <= VILLAGE.archPassage) {
          for (let y = s + 1; y <= spring; y++) {
            if (plein(c.wx, y, c.wz)) { souciArc = `${tag} : passage muré en (${c.wx},${c.wz},${y})`; break; }
          }
        } else if (ao === VILLAGE.archPassage + 1) {
          for (let y = s + 1; y <= s + VILLAGE.archShoulder; y++) {
            if (!plein(c.wx, y, c.wz)) { souciArc = `${tag} : épaule d'arc manquante en (${c.wx},${c.wz},${y})`; break; }
          }
          for (let y = s + VILLAGE.archShoulder + 1; y <= spring; y++) {
            if (plein(c.wx, y, c.wz)) { souciArc = `${tag} : cintré bouché en (${c.wx},${c.wz},${y})`; break; }
          }
        } else {
          for (let y = s + 1; y <= spring; y++) {
            if (!plein(c.wx, y, c.wz)) { souciArc = `${tag} : pilier ajouré en (${c.wx},${c.wz},${y})`; break; }
          }
        }
      }
    }
    if (souciArc) break;
    const ecrasee = porteEcrasee(a.axis, a.k, a.lo, a.hi, a.half);
    if (ecrasee) { souciArc = `${tag} : entrée de bâtiment murée en ${ecrasee}`; break; }
    passages++;
  }
  check('des arcs de triomphe enjambent les avenues de ville',
    arcs.length >= 1 && !souciArc,
    souciArc || `${passages} arc(s) au passage libre de ${VILLAGE.headroom} cubes, `
      + `posés à partir d'une influence de ${VILLAGE.archMinCity}`);

  // ---------------------------------------------- escaliers de rue
  // Une avenue droite qui suit le relief bute contre ses flancs : le joueur ne franchit
  // qu'un cube par colonne. La chaussée se pose donc son propre profil, à un cube de
  // dénivelé par colonne. La carte à gorges ne suffit pas à le montrer — ses pentes raides
  // tombent toutes sous un pont ou une rampe. On lui adjoint une carte de gradins
  // réguliers, trop peu enfoncés pour déclencher un ouvrage : seul le revêtement absorbe
  // le ressaut, et l'escalier de rue se retrouve seul sur l'établi.
  // Pente moyenne de trois cubes par cinq colonnes dans les deux sens : le relief impose
  // des ressauts de trois, mais une chaussée à un cube par colonne reste praticable.
  const heightAtGradins = (x, z) => 22 + 3 * Math.floor(((((x + z) % 40) + 40) % 40) / 5);
  const gradinsGen = createVillageGen({
    BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt: heightAtGradins, roll: hashRoll, saltBase: 0,
  });

  const avenuesDe = (gen, troncons) => {
    const out = [];
    const kMax = Math.ceil((troncons * CHUNK_SIZE) / VILLAGE.roadSpacing);
    for (let k = -kMax; k <= kMax; k++) {
      // Sondé à mi-bloc, loin de toute avenue perpendiculaire : seule sa propre ligne peut
      // alors répondre voirie — une croisée voisine ne doit pas faire exister une rue.
      if (gen.roadSurface(40, k * VILLAGE.roadSpacing, false) !== null) out.push(`x,${k}`);
      if (gen.roadSurface(k * VILLAGE.roadSpacing, 40, false) !== null) out.push(`z,${k}`);
    }
    return out;
  };

  // Un cube n'est imputable à la voirie que s'il n'appartient pas à un ouvrage : piles de
  // pont et travées d'arc s'estampent après la route et peuvent légitimement passer au-des-
  // sus d'une avenue qui croise leur axe.
  const analyseEscalier = (gen, hauteur, troncons) => {
    const pleins = new Map();
    const cleDe = (cx, cz) => `${cx},${cz}`;
    const vide = () => new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_HEIGHT);
    /**
     * Trois passes du même tronçon, dans l'ordre du jeu. Comparer « routes seules » à
     * « avec bâtiments » puis « avec ouvrages » attribue chaque cube à qui l'a posé :
     * un ouvrage qui évide une travée y écrit de l'air, et un simple tampon d'ouvrages
     * ne le verrait pas.
     */
    const passes = (cx, cz) => {
      const cle = cleDe(cx, cz);
      let p = pleins.get(cle);
      if (!p) {
        const routes = vide();
        gen.stampRoads(routes, cx, cz);
        const baties = Uint8Array.from(routes);
        gen.stampBuilding(baties, cx, cz);
        const ouvrages = Uint8Array.from(baties);
        gen.stampStructures(ouvrages, cx, cz);
        p = { routes, baties, ouvrages };
        pleins.set(cle, p);
      }
      return p;
    };
    const index = (wx, wy, wz, cx, cz) => (wx - cx * CHUNK_SIZE) + (wz - cz * CHUNK_SIZE) * CHUNK_SIZE
      + wy * CHUNK_SIZE * CHUNK_SIZE;
    const position = (wx, wy, wz) => {
      const cx = Math.floor(wx / CHUNK_SIZE); const cz = Math.floor(wz / CHUNK_SIZE);
      return { p: passes(cx, cz), i: index(wx, wy, wz, cx, cz) };
    };
    const luDans = (wx, wy, wz) => {
      if (wy < 0) return BLOCK.STONE;
      if (wy >= CHUNK_HEIGHT) return BLOCK.AIR;
      const { p, i } = position(wx, wy, wz);
      return p.ouvrages[i];
    };
    // Ce qu'un ouvrage a touché après les bâtiments — pavé comblé comme air évidé.
    const sousOuvrage = (wx, wy, wz) => {
      if (wy < 0 || wy >= CHUNK_HEIGHT) return false;
      const { p, i } = position(wx, wy, wz);
      return p.baties[i] !== p.ouvrages[i];
    };

    const r = { avenues: 0, ressauts: 0, premierRessaut: null, gradins: 0, ecartMax: 0,
                ressautsNaturels: 0, pave: '', palier: '', tete: '', plat: 0, marche: 0,
                allerRetours: 0, premierAllerRetour: null };
    // Une avenue existe si son propre axe est tracé : sondé à mi-bloc, loin de toute
    // avenue perpendiculaire, `roadSurface` ne répond hors-voirie que si la ligne manque.
    const ligneExiste = (axis, kk) => (axis === 'x'
      ? gen.roadSurface(40, kk * VILLAGE.roadSpacing, false) !== null
      : gen.roadSurface(kk * VILLAGE.roadSpacing, 40, false) !== null);
    for (const cle of avenuesDe(gen, troncons)) {
      const axis = cle[0];
      const k = Number(cle.slice(2));
      const zAxe = k * VILLAGE.roadSpacing;
      r.avenues++;
      let precedent = null;
      let pavePrec = null;
      const serie = [];
      let naturelPrec = hauteur(...(axis === 'x' ? [-troncons * CHUNK_SIZE, zAxe] : [zAxe, -troncons * CHUNK_SIZE]));
      for (let i = -troncons * CHUNK_SIZE; i <= troncons * CHUNK_SIZE; i++) {
        const wx = axis === 'x' ? i : zAxe;
        const wz = axis === 'x' ? zAxe : i;
        const naturel = hauteur(wx, wz);
        if (Math.abs(naturel - naturelPrec) >= 2) r.ressautsNaturels++;
        naturelPrec = naturel;
        // Le profil de la ligne d'abord, puis la chaussée telle qu'elle est posée — une
        // croisée relève des deux avenues et c'est ce niveau-là que le joueur foule.
        const L = gen.streetLevel(axis, k, i);
        const pave = gen.roadSurface(wx, wz, true);
        if (Number.isFinite(L)) serie.push({ i, L });
        if (precedent !== null) {
          const d = Math.abs(L - precedent);
          if (d === 0) r.plat++; else if (d === 1) r.marche++;
        }
        if (precedent !== null && Math.abs(L - precedent) > 1) {
          r.ressauts++;
          if (!r.premierRessaut) r.premierRessaut = `profil de l'avenue ${axis}${k} colonne ${i} : ${precedent} → ${L}`;
        }
        if (pavePrec !== null && Math.abs(pave - pavePrec) > 1) {
          r.ressauts++;
          if (!r.premierRessaut) r.premierRessaut = `chaussée de l'avenue ${axis}${k} colonne ${i} : ${pavePrec} → ${pave}`;
        }
        precedent = L;
        pavePrec = pave;
        const ecart = Math.abs(pave - naturel);
        if (ecart > r.ecartMax) r.ecartMax = ecart;
        if (ecart >= 2) r.gradins++;
        // Le pavé est à l'altitude du profil et ne flotte pas au-dessus du vide.
        if (luDans(wx, pave, wz) === BLOCK.AIR && !sousOuvrage(wx, pave, wz)) {
          if (!r.pave) r.pave = `pavé absent en (${wx},${wz}) niveau ${pave}, relief ${naturel}`;
        } else if (pave > naturel && luDans(wx, pave - 1, wz) === BLOCK.AIR && !sousOuvrage(wx, pave - 1, wz)) {
          if (!r.pave) r.pave = `marche flottante en (${wx},${wz}) niveau ${pave}, relief ${naturel}`;
        }
        for (let y = pave + 1; y <= pave + VILLAGE.headroom - 1; y++) {
          if (luDans(wx, y, wz) !== BLOCK.AIR && !sousOuvrage(wx, y, wz)) {
            if (!r.tete) r.tete = `garde-tête pris en (${wx},${wz}) au cube ${y} (bloc ${luDans(wx, y, wz)}), niveau ${pave}, relief ${naturel}`;
            break;
          }
        }
        // Plate en travers : toute la chaussée marche au même niveau. Hors des croisées,
        // où deux rues raccordées légitimement se rejoignent en biais.
        const kAutre = Math.round(i / VILLAGE.roadSpacing);
        const presDuneCroisee = Math.abs(i - kAutre * VILLAGE.roadSpacing) <= VILLAGE.roadHalf + VILLAGE.kerb + VILLAGE.roadStepWindow
          && ligneExiste(axis === 'x' ? 'z' : 'x', kAutre);
        if (presDuneCroisee) continue;
        for (let o = -VILLAGE.roadHalf; o <= VILLAGE.roadHalf; o++) {
          const ox = axis === 'x' ? wx : wx + o;
          const oz = axis === 'x' ? wz + o : wz;
          if (luDans(ox, pave, oz) === BLOCK.AIR && !sousOuvrage(ox, pave, oz)) {
            if (!r.palier) r.palier = `chaussée non plate en (${ox},${oz}) au niveau ${pave}, relief ${naturel}`;
            break;
          }
        }
      }
      // Aller-retour : un niveau quitté puis retrouvé après s'en être écarté d'au moins
      // deux cubes, le tout sur quelques colonnes. C'est l'escalier qui descend et
      // remonte — le joueur n'y gagne rien, la rue non plus. Compté une seule fois par
      // mouvement, sinon une longue ondulation passerait pour dix défauts.
      const SERRÉ = 8;
      for (let a = 0; a < serie.length;) {
        let trouve = null;
        let ecart = 0;
        for (let b = a + 2; b <= Math.min(serie.length - 1, a + SERRÉ); b++) {
          if (serie[b].L !== serie[a].L) continue;
          let creneau = 0;
          for (let m = a; m <= b; m++) creneau = Math.max(creneau, Math.abs(serie[m].L - serie[a].L));
          if (creneau >= 2) { trouve = b; ecart = creneau; break; }
        }
        if (trouve === null) { a++; continue; }
        r.allerRetours++;
        if (!r.premierAllerRetour) {
          const profil = serie.slice(Math.max(0, a - 2), trouve + 3).map((s) => s.L).join(' ');
          r.premierAllerRetour = `avenue ${axis}${k}, colonne ${serie[a].i} : ${profil} — ${ecart} cubes perdus et repris en ${trouve - a} colonnes`;
        }
        a = trouve;
      }
    }
    return r;
  };
  const TRONCONS_ESCALIER = 8;
  const surGorges = analyseEscalier(gorges, heightAtValleys, TRONCONS_ESCALIER);
  const surGradins = analyseEscalier(gradinsGen, heightAtGradins, TRONCONS_ESCALIER);
  const dit = (champ) => [surGorges, surGradins].map((m) => m[champ]).filter(Boolean).join(' ; ');

  check('la rue droite se pose à un cube de dénivelé par colonne',
    surGorges.premierRessaut === null && surGradins.premierRessaut === null,
    dit('premierRessaut') || `${surGorges.avenues + surGradins.avenues} avenue(s) parcourues pas à pas`);
  check('l’escalier de rue travaille où le relief imposerait un ressaut',
    surGradins.ressautsNaturels > 200 && surGradins.gradins > 200,
    `relief naturel à ressaut sur ${surGradins.ressautsNaturels} colonnes, chaussée posée en gradin sur `
      + `${surGradins.gradins}, écart maximal ${surGradins.ecartMax} cubes (carte à gorges : ${surGorges.gradins} gradins, max ${surGorges.ecartMax})`);
  check('le pavé suit le profil, sans marche flottante',
    !surGorges.pave && !surGradins.pave,
    dit('pave') || `${surGorges.gradins + surGradins.gradins} marches contrôlées`);
  check('la chaussée est plate en travers de sa largeur',
    !surGorges.palier && !surGradins.palier,
    dit('palier') || `${2 * VILLAGE.roadHalf + 1} colonnes sondées sous chaque profil`);
  check('chaque marche laisse le garde-tête libre',
    !surGorges.tete && !surGradins.tete,
    dit('tete') || `${VILLAGE.headroom - 1} cubes dégagés au-dessus du pavé`);

  // Une avenue praticable n'est pas une avenue commode : le joueur ne grimpe pas pour
  // plaisir. Le relief est conduit à un cube par colonne, mais la chaussée doit rester
  // plate le plus longtemps possible entre deux reprises.
  const partPlat = (m) => (m.plat + m.marche ? m.plat / (m.plat + m.marche) : 0);
  // Seuil calé sur la mesure : avant le lissage et les paliers, la carte de gradins ne
  // tenait que 56 % de colonnes à plat (45 % des pas étaient une marche) ; elle tient à
  // 80 % aujourd'hui, la carte à gorges oscillant entre 82 et 85 dans les deux états.
  check('la chaussée roule à plat plutôt qu\'en escalier continu',
    partPlat(surGorges) >= 0.8 && partPlat(surGradins) >= 0.72,
    `paliers : ${Math.round(100 * partPlat(surGorges))}% des colonnes (carte à gorges) et `
      + `${Math.round(100 * partPlat(surGradins))}% (carte de gradins) sur `
      + `${surGorges.avenues + surGradins.avenues} avenues parcourues`);

  // Rouler à plat ne suffit pas : le joueur ne reproche pas à la rue de monter, il lui
  // reproche de monter pour rien. Une volée qui descend et reprend trois pas plus loin
  // est un escalier de deux cubes deux fois payé — mesuré avant le travail, 40 de ces
  // allers-retours sur dix avenues de ±128 cubes, dont quatre en moins de cinq colonnes.
  check('une avenue ne redescend pas pour remonter quelques colonnes plus loin',
    surGorges.allerRetours === 0 && surGradins.allerRetours === 0,
    surGorges.premierAllerRetour || surGradins.premierAllerRetour
      || `${surGorges.allerRetours + surGradins.allerRetours} aller-retour sur `
        + `${surGorges.avenues + surGradins.avenues} avenues parcourues`);

  // Contre-témoin : rendue au lissage d'avant — une seule colonne moyennée de part et
  // d'autre du relief — la même grille de lecture doit voir l'avenue onduler, sinon le
  // contrôle ci-dessus ne mesure rien. Le défaut revient par paquets, jamais partout :
  // la carte de gradins en compte quatorze, celle à gorges aucun.
  const gradinsBrut = createVillageGen({
    BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt: heightAtGradins, roll: hashRoll, saltBase: 0,
    reglages: { roadSmooth: 1 },
  });
  const surGradinsBrut = analyseEscalier(gradinsBrut, heightAtGradins, TRONCONS_ESCALIER);
  check('sans le lissage du relief, la même avenue se met à onduler',
    surGradinsBrut.allerRetours > 0,
    surGradinsBrut.premierAllerRetour
      || `aucun aller-retour reproduit avec roadSmooth 1 — le contrôle est aveugle`);

  // Déterminisme propre aux ouvrages : ils sont régénérés depuis les seules coordonnées.
  const summarise = (list) => JSON.stringify(list.map(empreinte).sort());
  const jumeau = createVillageGen({
    BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt: heightAtValleys, roll: hashRoll, saltBase: 0,
  });
  const autres = new Map();
  for (let cx = -R; cx <= R; cx++) {
    for (let cz = -R; cz <= R; cz++) {
      for (const s of jumeau.structuresAt(cx, cz)) autres.set(cleOuvrage(s), s);
    }
  }
  check('ponts, arcs et temples sont strictement déterministes',
    summarise([...found.values()]) === summarise([...autres.values()]));
  const graineAutre = createVillageGen({
    BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt: heightAtValleys, roll: hashRoll, saltBase: 4242,
  });
  const deplaces = new Map();
  for (let cx = -R; cx <= R; cx++) {
    for (let cz = -R; cz <= R; cz++) {
      for (const s of graineAutre.structuresAt(cx, cz)) deplaces.set(cleOuvrage(s), s);
    }
  }
  check('changer la graine déplace aussi les ponts et les arcs',
    summarise([...found.values()]) !== summarise([...deplaces.values()]));
}

// ------------------------------------------------------------------- temples
{
  // Le monument est un ouvrage à part : rare, isolé, posé sur un plateau, et surtout
  // **traversable** — une porte franchissable et un intérieur où l'on tient debout.
  const DIRS = [{ dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 }];
  const PORTEE = 5;                       // mailles sondées de part et d'autre
  const temples = [];
  for (let i = -PORTEE; i <= PORTEE; i++) {
    for (let j = -PORTEE; j <= PORTEE; j++) {
      const t = gen.templeAt(i, j);
      if (t) temples.push(t);
    }
  }
  const MAILLES = (2 * PORTEE + 1) ** 2;
  check('il se dresse des temples', temples.length >= 3,
    `${temples.length} temple(s) sur ${MAILLES} mailles de ${VILLAGE.templeCell} cubes`);

  // Rareté mesurée sur la même surface : le village pose un bâti tous les quelques
  // tronçons, le monument doit rester un accident du paysage.
  const cotes = Math.ceil((PORTEE * VILLAGE.templeCell) / CHUNK_SIZE);
  let batis = 0;
  let echantillonnes = 0;
  for (let cx = -cotes; cx <= cotes; cx += 3) {
    for (let cz = -cotes; cz <= cotes; cz += 3) {
      batis += gen.buildingAt(cx, cz).length;
      echantillonnes++;
    }
  }
  const parTronçon = temples.length / (MAILLES * (VILLAGE.templeCell / CHUNK_SIZE) ** 2);
  const bâtiParTronçon = batis / Math.max(1, echantillonnes);
  check('un temple est bien plus rare qu\'une maison ou qu\'un immeuble',
    temples.length > 0 && parTronçon * 20 < bâtiParTronçon,
    `1 temple pour ${(1 / Math.max(parTronçon, 1e-9)).toFixed(0)} tronçons, `
    + `${bâtiParTronçon.toFixed(2)} bâtiment(s) par tronçon`);

  // Le monument doit se lire comme un monument : quatre fois la largeur d'une maison,
  // et rester assez proche du joueur pour qu'il en croise un en explorant son monde.
  const petitsCotes = [];
  for (let cx = -6; cx <= 6; cx++) {
    for (let cz = -6; cz <= 6; cz++) {
      for (const p of gen.buildingAt(cx, cz)) petitsCotes.push(Math.min(p.w, p.d));
    }
  }
  petitsCotes.sort((a, b) => a - b);
  const coteMaison = petitsCotes[Math.floor(petitsCotes.length / 2)] || 0;
  const rapport = coteMaison ? (2 * VILLAGE.templeHalf + 1) / coteMaison : 0;
  check('le parvis mesure quatre fois la largeur d\'une maison', rapport >= 3.5,
    `parvis de ${2 * VILLAGE.templeHalf + 1} cubes pour une maison de ${coteMaison}`
    + ` (${rapport.toFixed(1)}×)`);

  const ecartTemple = Math.sqrt(MAILLES * VILLAGE.templeCell ** 2 / Math.max(1, temples.length));
  check('un temple se rencontre en explorant le monde', temples.length >= 3 && ecartTemple <= 600,
    `écart moyen ${ecartTemple.toFixed(0)} cubes entre deux monuments`);

  // Estampage : un seul tampon par tronçon, rempli comme le fait le jeu.
  const tampons = new Map();
  function monde(cx, cz) {
    const cle = `${cx},${cz}`;
    let d = tampons.get(cle);
    if (!d) {
      d = emptyData();
      gen.stampRoads(d, cx, cz);
      gen.stampBuilding(d, cx, cz);
      gen.stampStructures(d, cx, cz);
      tampons.set(cle, d);
    }
    return d;
  }
  const bloc = (wx, y, wz) => {
    if (y < 0 || y >= CHUNK_HEIGHT) return BLOCK.AIR;
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    return monde(cx, cz)[idx(wx - cx * CHUNK_SIZE, y, wz - cz * CHUNK_SIZE)];
  };
  // Le monument se lit en pierre, verre et or. Il partage la pierre grise avec les
  // soubassements du village — ce qui le distingue n'est donc plus une palette étrangère
  // mais ce qu'aucune maison ne porte : des vitres, des arches entre ses colonnes et un
  // faîtage doré. Confondre les deux, c'est n'avoir « aucun temple » sous les yeux.
  const PIERRE_DU_MONUMENT = [BLOCK.STONE, BLOCK.COBBLE, BLOCK.GLASS, BLOCK.GOLD, BLOCK.MOSS];

  /**
   * Du chemin jusqu'au parvis, le joueur ne franchit qu'un cube à la fois : on remonte
   * l'axe de la porte rangée par rangée en comparant les niveaux où l'on se tient — le
   * gradin estampé ou le terrain naturel, le plus haut des deux. Un degré qui s'arrête
   * un gradin trop haut est invisible au contrôle de régularité et bloque pourtant le
   * visiteur dès son premier pas. Renvoie la raison de la coupure, ou null.
   */
  function approcheCoupee(t, blocFn, naturel = heightAt) {
    const dir = DIRS[t.door];
    let tenu = null;
    for (let s = VILLAGE.templeSteps + 4; s >= 0; s--) {
      const wx = t.ex + dir.dx * (t.half + s);
      const wz = t.ez + dir.dz * (t.half + s);
      let estampe = -1;
      for (let y = t.socle; y >= 0; y--) {
        if (blocFn(wx, y, wz) !== BLOCK.AIR) { estampe = y; break; }
      }
      const niveau = Math.max(naturel(wx, wz), estampe + 1);
      if (tenu !== null && niveau - tenu > 1) return `rang ${s} : ${tenu} → ${niveau} à (${wx},${wz})`;
      tenu = niveau;
    }
    return tenu === t.socle + 1 ? null : `parvis non atteint (tenu ${tenu}, attendu ${t.socle + 1})`;
  }

  let sansPorte = 0, interieurBouche = 0, toitAbsent = 0, colonnesTropPeu = 0, axeBouche = 0;
  let voiriePrise = 0, bâtiSurParvis = 0, degreRaide = 0, empriseLibre = 0, degreCoupe = 0;
  let sansVitres = 0, sansArches = 0, sansFaitage = 0, galerieBouchee = 0;
  const exemples = [];
  for (const t of temples.slice(0, 8)) {
    const dir = DIRS[t.door];
    const haut = t.socle + VILLAGE.templeHeight;
    const C = VILLAGE.templeCellaHalf;

    // La porte, dans l'axe du degré : un cube de large, trois de haut, un linteau au-dessus.
    const px = t.ex + dir.dx * C;
    const pz = t.ez + dir.dz * C;
    for (let y = t.socle + 1; y <= t.socle + 3; y++) {
      if (bloc(px, y, pz) !== BLOCK.AIR) sansPorte++;
    }
    if (bloc(px, t.socle + 4, pz) === BLOCK.AIR) sansPorte++;

    // L'intérieur doit être une salle, pas un bloc de pierre.
    for (let dx = -(C - 1); dx <= C - 1; dx++) {
      for (let dz = -(C - 1); dz <= C - 1; dz++) {
        for (let y = t.socle + 1; y <= haut; y++) {
          const autel = dx === 0 && dz === 0 && y <= t.socle + 2;
          if (!autel && bloc(t.ex + dx, y, t.ez + dz) !== BLOCK.AIR) interieurBouche++;
        }
      }
    }
    if (!PIERRE_DU_MONUMENT.includes(bloc(t.ex, haut + 1, t.ez))) toitAbsent++;

    // Vitres : le naos est percé, une colonne sur deux au-dessus du socle. Une salle
    // close de pierre ne se lit pas comme un sanctuaire.
    let vitres = 0;
    for (let dx = -C; dx <= C; dx++) {
      for (let dz = -C; dz <= C; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== C) continue;
        for (let y = t.socle + 4; y <= haut - 1; y++) {
          if (bloc(t.ex + dx, y, t.ez + dz) === BLOCK.GLASS) vitres++;
        }
      }
    }
    if (vitres < 8) sansVitres++;

    // La colonnade : un anneau de fûts espacés, leurs arches entre eux, et le passage
    // d'axe laissé libre devant la porte. Une galerie dont chaque cellule porte de la
    // pierre à hauteur d'appui n'est plus une colonnade mais un mur — c'est le défaut
    // qu'a fait apparaître le calage du pas sur la coordonnée absolue.
    let futs = 0;
    let arches = 0;
    let vide = 0;
    const R = t.half - 1;
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== R) continue;
        const pied = bloc(t.ex + dx, t.socle + 2, t.ez + dz);
        if (PIERRE_DU_MONUMENT.includes(pied)) futs++;
        else if (pied === BLOCK.AIR) vide++;
        if (PIERRE_DU_MONUMENT.includes(bloc(t.ex + dx, haut - 1, t.ez + dz))) arches++;
      }
    }
    if (arches === 0) sansArches++;
    const cellulesAnneau = 8 * R;
    if (vide < cellulesAnneau / 4) galerieBouchee++;
    // Un fût sur `templeColumnPitch` le long des quatre faces, à moitié moins toléré :
    // une colonnade clairsemée ne se lit plus comme un périptère.
    const futsAttendus = 4 * Math.floor((2 * R + 1) / VILLAGE.templeColumnPitch);
    if (futs < futsAttendus / 2) colonnesTropPeu++;
    if (bloc(t.ex + dir.dx * R, t.socle + 2, t.ez + dir.dz * R) !== BLOCK.AIR) axeBouche++;
    // Le repère que l'on cherche au-dessus des toits : la clé du comble est d'or.
    if (bloc(t.ex, haut + 1 + VILLAGE.templeRoofPitch * (C + 1), t.ez) !== BLOCK.GOLD) sansFaitage++;

    // Le degré ne reprend jamais plus d'un cube par colonne : c'est la règle du joueur.
    let precedent = t.socle;
    for (let s = 1; s <= VILLAGE.templeSteps + 4; s++) {
      const hors = t.half + s;
      const wx = t.ex + dir.dx * hors;
      const wz = t.ez + dir.dz * hors;
      let sommet = -1;
      for (let y = t.socle + 1; y >= 0; y--) {
        if (bloc(wx, y, wz) !== BLOCK.AIR) { sommet = y; break; }
      }
      if (sommet < 0) break;                        // plus de dé : c'est du chemin
      // Une terrasse à niveau égal est licite — c'est même le rattrapage du terrain
      // naturel. Ce qui ne l'est pas, c'est un gradin qui plonge de plus d'un cube :
      // lu à l'endroit, c'est une marche de deux que le joueur ne franchit pas.
      if (precedent - sommet > 1) {
        degreRaide++;
        if (exemples.length < 3) exemples.push(`(${wx},${wz}) marche ${sommet} après ${precedent}`);
        break;
      }
      precedent = sommet;
    }

    const coupe = approcheCoupee(t, bloc);
    if (coupe) {
      degreCoupe++;
      if (exemples.length < 3) exemples.push(coupe);
    }

    // Le monument ne mord ni sur la voirie ni sur un bâtiment, et son emprise interdit
    // effectivement la végétation. Côté voirie, on tient libre ce que le temple écrit
    // vraiment — le parvis et le couloir du degré ; au-delà, l'emprise n'est qu'un
    // tampon qui écarte les bâtiments, et la rue y passe sans être recouverte.
    const latX = -dir.dz;
    const latZ = dir.dx;
    for (let wx = t.ex - t.half; wx <= t.ex + t.half; wx++) {
      for (let wz = t.ez - t.half; wz <= t.ez + t.half; wz++) {
        if (gen.roadKind(wx, wz)) voiriePrise++;
      }
    }
    for (let s = 1; s <= VILLAGE.templeSteps + 4; s++) {
      for (let k = -VILLAGE.templeStairWidth; k <= VILLAGE.templeStairWidth; k++) {
        if (gen.roadKind(t.ex + dir.dx * (t.half + s) + latX * k,
          t.ez + dir.dz * (t.half + s) + latZ * k)) voiriePrise++;
      }
    }
    for (let cx = Math.floor(t.bx0 / CHUNK_SIZE); cx <= Math.floor(t.bx1 / CHUNK_SIZE); cx++) {
      for (let cz = Math.floor(t.bz0 / CHUNK_SIZE); cz <= Math.floor(t.bz1 / CHUNK_SIZE); cz++) {
        for (const p of gen.buildingAt(cx, cz)) {
          const x0 = cx * CHUNK_SIZE + p.x0;
          const z0 = cz * CHUNK_SIZE + p.z0;
          // Même règle que pour la voirie : seule la pierre posée compte — le parvis et
          // le couloir du degré. Le tampon autour est un dégagement pour la végétation,
          // et l'interdire aux maisons vidait le cœur de la ville.
          const genante = (wx, wz) => {
            const dx = wx - t.ex;
            const dz = wz - t.ez;
            if (Math.abs(dx) <= t.half && Math.abs(dz) <= t.half) return true;
            const axial = dx * dir.dx + dz * dir.dz;
            const tangent = dx * latX + dz * latZ;
            return axial > t.half && axial <= t.half + VILLAGE.templeSteps + 4
              && Math.abs(tangent) <= VILLAGE.templeStairWidth;
          };
          let mordre = false;
          for (let wx = x0; wx < x0 + p.w && !mordre; wx++) {
            for (let wz = z0; wz < z0 + p.d; wz++) {
              if (genante(wx, wz)) { mordre = true; break; }
            }
          }
          if (mordre) bâtiSurParvis++;
        }
      }
    }
    if (!gen.isOccupied(t.ex, t.ez)) empriseLibre++;
  }
  // Le contrôle précédent ne voit goutte sur le relief plat des suites : un degré posé
  // de travers n'y apparaît jamais. On rejoue donc la montée sur un monde bosselé, où le
  // terrain remonte par endroits plus vite qu'un cube par colonne et oblige le monument
  // à rattraper le sol par une terrasse.
  const bosselé = (x, z) => 26 + Math.round(5 * Math.sin(x / 41) + 4 * Math.cos(z / 29));
  const genDur = makeGen(0, bosselé);
  const tamponsDurs = new Map();
  const blocDur = (wx, y, wz) => {
    if (y < 0 || y >= CHUNK_HEIGHT) return BLOCK.AIR;
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    const cle = `${cx},${cz}`;
    let d = tamponsDurs.get(cle);
    if (!d) {
      d = emptyData();
      genDur.stampRoads(d, cx, cz);
      genDur.stampBuilding(d, cx, cz);
      genDur.stampStructures(d, cx, cz);
      tamponsDurs.set(cle, d);
    }
    return d[idx(wx - cx * CHUNK_SIZE, y, wz - cz * CHUNK_SIZE)];
  };
  let durs = 0, dursBloques = 0;
  const exemplesDurs = [];
  for (let i = -PORTEE; i <= PORTEE; i++) {
    for (let j = -PORTEE; j <= PORTEE; j++) {
      const t = genDur.templeAt(i, j);
      if (!t) continue;
      durs++;
      const c = approcheCoupee(t, blocDur, bosselé);
      if (c) {
        dursBloques++;
        if (exemplesDurs.length < 3) exemplesDurs.push(`(${t.ex},${t.ez}) ${c}`);
      }
    }
  }
  const vus = Math.min(8, temples.length);
  check('tout temple a sa porte ouverte sur trois cubes', sansPorte === 0, `${sansPorte} anomalie(s) sur ${vus} temple(s)`);
  check('on peut tenir debout dans le naos', interieurBouche === 0, `${interieurBouche} cube(s) barrant la salle`);
  check('le naos est couvert', toitAbsent === 0, `${toitAbsent} comble(s) manquant(s)`);
  check('la colonnade entoure le monument', colonnesTropPeu === 0, `${colonnesTropPeu} colonnade(s) trop clairsemée(s)`);
  check('le passage d\'axe reste libre devant la porte', axeBouche === 0, `${axeBouche} colonne(s) dans l\'axe du degré`);
  check('le degré ne prend qu\'un cube par colonne', degreRaide === 0,
    `${degreRaide} ressaut(s)${exemples.length ? ' — ' + exemples.join(', ') : ''}`);
  check('du chemin au parvis, le degré se gravit rangée par rangée', degreCoupe === 0,
    `${degreCoupe} temple(s) sans approche franchissable`);
  check('sur un relief accidenté aussi, le degré se gravit', durs > 0 && dursBloques === 0,
    `${durs} temple(s) sur monde bosselé, ${dursBloques} approche(s) bloquée(s)`
    + (exemplesDurs.length ? ' — ' + exemplesDurs.join(' | ') : ''));
  check('aucun temple ne touche une avenue', voiriePrise === 0, `${voiriePrise} cellule(s) de voirie sous un temple`);
  check('aucun bâtiment ne mord sur un parvis', bâtiSurParvis === 0, `${bâtiSurParvis} chevauchement(s)`);
  check('l\'emprise d\'un temple interdit la végétation', empriseLibre === 0, `${empriseLibre} emprise(s) plantable(s)`);
  check('le naos est percé de vitres', sansVitres === 0,
    `${sansVitres} monument(s) sans aucune ouverture vitrée`);
  check('des arches relient les colonnes de la galerie', sansArches === 0,
    `${sansArches} monument(s) sans clé d\'arche entre deux fûts`);
  check('la galerie reste une galerie, pas un mur', galerieBouchee === 0,
    `${galerieBouchee} monument(s) dont la colonnade se ferme en mur continu`);
  check('le faîtage doré coiffe le monument', sansFaitage === 0,
    `${sansFaitage} monument(s) sans repère doré au sommet`);

  const clefs = (g) => {
    const l = [];
    for (let i = -PORTEE; i <= PORTEE; i++) {
      for (let j = -PORTEE; j <= PORTEE; j++) {
        const t = g.templeAt(i, j);
        if (t) l.push([t.ex, t.ez, t.socle, t.door]);
      }
    }
    return JSON.stringify(l);
  };
  const jumeau = makeGen(0);
  check('le temple se régénère à l\'identique', clefs(jumeau) === clefs(gen));
  check('changer la graine déplace les temples', clefs(makeGen(4242)) !== clefs(gen));
}

// ------------------------------------------------- très hautes montagnes
// « Des zones de la même taille que les océans de très haute montagne sans immeuble et
// avec quelques maisons ». Jugé sur le VRAI relief du jeu — même bruit, même graine —
// puisque ces zones sont un effet du relief : une sonde sur le relief synthétique des
// sections ci-dessus ne rencontrerait jamais ni le massif, ni ses hameaux.
{
  const { SimplexNoise } = await loadPublicModule('public/js/noise.js');
  const { createTerrain } = await loadPublicModule('public/js/terrain.js');
  const monde = createTerrain({ noise: new SimplexNoise(42), chunkHeight: CHUNK_HEIGHT });
  const memoH = new Map();
  const rel = (x, z) => {
    const k = `${x},${z}`;
    let v = memoH.get(k);
    if (v === undefined) { v = monde.heightAt(x, z); memoH.set(k, v); }
    return v;
  };
  const genM = createVillageGen({
    BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt: rel, roll: hashRoll, saltBase: 0,
    seaLevel: monde.RELIEF.seaLevel,
    waterTopAt: (x, z) => monde.waterTopAt(x, z),
    alpsAt: (x, z) => monde.alpsIntensity(x, z),
  });
  // Le même village, mais aveugle au massif : seul ce contre-témoin dit si l'interdit
  // d'immeuble mord quelque part, au lieu de célébrer une absence qui ne coûtait rien.
  const genSans = createVillageGen({
    BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt: rel, roll: hashRoll, saltBase: 0,
    seaLevel: monde.RELIEF.seaLevel,
    waterTopAt: (x, z) => monde.waterTopAt(x, z),
  });

  let massifsSondes = 0;
  let batiments = 0;
  let immeubles = 0;
  let immeublesAveugles = 0;
  let hameaux = 0;
  let monuments = 0;
  let horsBande = null;
  const exemples = [];
  // Un tronçon sur deux de part et d'autre de l'origine : assez de pays pour rencontrer
  // des massifs — ils en couvrent un cinquième — et compter autre chose que trois
  // maisons, sans que la suite y passe la nuit. Le jugement se prend au centre du
  // tronçon, comme dans le générateur.
  for (let cx = -110; cx <= 110; cx += 2) {
    for (let cz = -110; cz <= 110; cz += 2) {
      const baseX = cx * CHUNK_SIZE;
      const baseZ = cz * CHUNK_SIZE;
      if (genM.alpage(baseX + (CHUNK_SIZE >> 1), baseZ + (CHUNK_SIZE >> 1)) < VILLAGE.alpsWild) continue;
      massifsSondes++;
      const plans = genM.buildingAt(cx, cz);
      if (plans.length) hameaux++;
      immeublesAveugles += genSans.buildingAt(cx, cz).filter((p) => p.kind === 'tower').length;
      for (const p of plans) {
        batiments++;
        if (p.kind === 'tower') immeubles++;
        if (exemples.length < 3) exemples.push(`(${baseX},${baseZ}) ${p.kind} ${p.w}×${p.d}×${p.height}`);
        for (let lx = p.x0; lx < p.x0 + p.w; lx++) {
          for (let lz = p.z0; lz < p.z0 + p.d; lz++) {
            const h = rel(baseX + lx, baseZ + lz);
            if (!horsBande && (h < VILLAGE.hamletMinGround - 1 || h > VILLAGE.hamletMaxGround + 1)) {
              horsBande = `(${baseX + lx},${baseZ + lz}) sol ${h}, ${p.kind} de (${baseX},${baseZ})`;
            }
          }
        }
      }
      for (const t of genM.templesSur(baseX, baseZ, baseX + CHUNK_SIZE - 1, baseZ + CHUNK_SIZE - 1)) {
        if (genM.alpage(t.ex, t.ez) >= VILLAGE.alpsWild) monuments++;
      }
    }
  }
  check('les très hautes montagnes existent', massifsSondes > 300,
    `${massifsSondes} tronçons sondés sous un très haut massif`);
  check('aucun immeuble ne s\'élève dans un très haut massif',
    massifsSondes > 300 && immeubles === 0 && immeublesAveugles > 0,
    `${immeubles} immeuble(s) sur ${batiments} bâtiment(s) de montagne ; `
    + `${immeublesAveugles} que le même sol produirait sans la règle du massif`);
  check('quelques maisons restent au pied de la montagne',
    batiments >= 12 && hameaux >= 6,
    `${batiments} maison(s) sur ${massifsSondes} tronçons de massif, ${hameaux} tronçon(s) bâti(s) · `
    + exemples.join(', '));
  check('le hameau reste entre le pied du massif et l\'arête', !horsBande, horsBande || '');
  check('aucun monument ne se dresse sur la glace', monuments === 0, `${monuments} monument(s)`);
}

// ------------------------------------------------- statues monumentales
// « Je voudrais que tu ajoute de tres grande status dans les villes , des status a forme
// humaine , d'elephant de cheval et d'aigle ». Jugé sur le vrai relief du jeu : ce sont les
// villes du monde que le joueur parcourt qui doivent recevoir les colosses. Et jugé **sur
// les cubes estampés**, non sur le plan : un gabarit juste dont l'estampage rate la rotation
// ou franchit une couture de tronçon ne se voit que dans le tampon.
{
  const { SimplexNoise } = await loadPublicModule('public/js/noise.js');
  const { createTerrain } = await loadPublicModule('public/js/terrain.js');
  const monde = createTerrain({ noise: new SimplexNoise(42), chunkHeight: CHUNK_HEIGHT });
  const memoH = new Map();
  const rel = (x, z) => {
    const k = `${x},${z}`;
    let v = memoH.get(k);
    if (v === undefined) { v = monde.heightAt(x, z); memoH.set(k, v); }
    return v;
  };
  const genS = createVillageGen({
    BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt: rel, roll: hashRoll, saltBase: 0,
    seaLevel: monde.RELIEF.seaLevel,
    waterTopAt: (x, z) => monde.waterTopAt(x, z),
    alpsAt: (x, z) => monde.alpsIntensity(x, z),
  });
  // Contre-témoin de l'interdit du massif : sans la porte alpine, des colosses monteraient
  // sur la glace. Une absence que rien ne produit ne prouve rien.
  const genNu = createVillageGen({
    BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt: rel, roll: hashRoll, saltBase: 0,
    seaLevel: monde.RELIEF.seaLevel,
    waterTopAt: (x, z) => monde.waterTopAt(x, z),
  });

  // Les trois pierres du colosse plus la mousse de sa face à l'ombre. Le gravier est entré
  // dans la table quand les géants ont cessé d'être tous du même gris : hors de cet
  // ensemble, un colosse sombre ne serait plus vu que par morceaux par les juges ci-dessous.
  const PIERRES = new Set([BLOCK.STONE, BLOCK.COBBLE, BLOCK.GRIT, BLOCK.MOSS]);
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];   // miroir de TEMPLE_DIRS du générateur

  // --- inventaire des mailles de statue sur un pays large --------------------
  const statues = [];
  let cellulesUrbaines = 0;
  let surGlace = 0;
  let surGlaceAveugle = 0;
  for (let i = -22; i <= 22; i++) {
    for (let j = -22; j <= 22; j++) {
      const cell = VILLAGE.statueCell;
      if (genS.cityInfluence(i * cell + (cell >> 1), j * cell + (cell >> 1)) >= VILLAGE.statueMinCity) {
        cellulesUrbaines++;
      }
      const s = genS.statueAt(i, j);
      if (!s) continue;
      statues.push(s);
      if (genS.alpage(s.ex, s.ez) >= VILLAGE.alpsWild) surGlace++;
      const n = genNu.statueAt(i, j);
      if (n && genS.alpage(n.ex, n.ez) >= VILLAGE.alpsWild) surGlaceAveugle++;
    }
  }
  const parForme = {};
  for (const s of statues) parForme[s.forme] = (parForme[s.forme] || 0) + 1;
  check('les quatre colosses existent',
    ['humain', 'elephant', 'cheval', 'aigle'].every((f) => (parForme[f] || 0) >= 3),
    Object.entries(parForme).map(([k, v]) => `${k} ${v}`).join(' · ') + ` · total ${statues.length}`);
  check('une statue par ville, pas une par quartier',
    statues.length >= 40 && cellulesUrbaines > statues.length,
    `${statues.length} colosses sur ${cellulesUrbaines} mailles urbaines`);

  // Deux colosses ne se touchent pas : l'emprise reste confinée dans sa maille.
  let touches = null;
  for (let a = 0; a < statues.length && !touches; a++) {
    for (let b = a + 1; b < statues.length && !touches; b++) {
      const p = statues[a];
      const q = statues[b];
      if (Math.abs(p.ex - q.ex) > p.hx + q.hx + 2 || Math.abs(p.ez - q.ez) > p.hzAvant + q.hzAvant + 2) continue;
      touches = `(${p.ex},${p.ez}) ${p.forme} et (${q.ex},${q.ez}) ${q.forme}`;
    }
  }
  check('deux colosses ne se touchent jamais', !touches, touches || '');
  check('aucun colosse ne se dresse sur la glace',
    surGlace === 0 && surGlaceAveugle > 0,
    `${surGlace} sur la glace ; ${surGlaceAveugle} que la même graine y poserait sans la porte du massif`);

  // --- ce que l'estampage écrit vraiment -------------------------------------
  const tampons = new Map();
  function blocMonde(wx, wz, y) {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    const cle = `${cx},${cz}`;
    let d = tampons.get(cle);
    if (!d) {
      d = emptyData();
      genS.stampRoads(d, cx, cz);
      genS.stampBuilding(d, cx, cz);
      genS.stampStructures(d, cx, cz);
      tampons.set(cle, d);
    }
    return d[idx(wx - cx * CHUNK_SIZE, y, wz - cz * CHUNK_SIZE)];
  }

  // --- la pierre du colosse --------------------------------------------------
  // « Je voudrais que les status n'aient pas toutes la même couleur, utilise de la pierre
  // plus ou moins sombre ». Jugée sur les **cubes estampés**, comme le reste : un ton qui
  // resterait confiné au plan — matériau absent de la table, teinte perdue à la rotation —
  // laisserait quarante géants du même gris tout en affichant trois pierres dans les plans.
  const PIERRES_COLOSSE = [BLOCK.STONE, BLOCK.COBBLE, BLOCK.GRIT];
  function pierreEstampee(s) {
    const dir = DIRS[s.door];
    const latX = -dir[1];
    const latZ = dir[0];
    const comptes = new Map();
    for (let lz = -s.hzArriere; lz <= s.hzAvant; lz++) {
      for (let lx = -s.hx; lx <= s.hx; lx++) {
        const wx = s.ex + dir[0] * lz + latX * lx;
        const wz = s.ez + dir[1] * lz + latZ * lx;
        // Au-dessus de l'assise et du piédestal : juger plus bas comparerait le corps à la
        // table de pierre claire, identique pour tous les colosses par construction.
        for (let y = s.socle + 3; y < s.socle + 14; y++) {
          const b = blocMonde(wx, wz, y);
          if (b !== BLOCK.AIR) comptes.set(b, (comptes.get(b) || 0) + 1);
        }
      }
    }
    let dominant = BLOCK.AIR, n = 0;
    for (const [b, c] of comptes) if (c > n) { dominant = b; n = c; }
    return dominant;
  }
  const parTon = {};
  for (const s of statues) parTon[s.ton] = (parTon[s.ton] || 0) + 1;
  const unParTon = [];
  for (let t = 0; t < PIERRES_COLOSSE.length; t++) {
    const s = statues.find((x) => x.ton === t);
    if (s) unParTon.push({ ton: t, vu: pierreEstampee(s) });
  }
  check('les colosses se taillent dans trois pierres, de la plus claire à la plus sombre',
    PIERRES_COLOSSE.every((p, t) => (parTon[t] || 0) >= 3)
    && unParTon.length === PIERRES_COLOSSE.length
    && unParTon.every((u) => u.vu === PIERRES_COLOSSE[u.ton])
    && new Set(unParTon.map((u) => u.vu)).size === PIERRES_COLOSSE.length,
    `${Object.entries(parTon).map(([t, v]) => `ton ${t}: ${v}`).join(' · ')}`
    + ` · estampé ${unParTon.map((u) => `${u.ton}→bloc ${u.vu}`).join(' ')}`
    + ` (attendu ${PIERRES_COLOSSE.join('/')})`);

  // La sauvegarde ne porte que le diff du joueur : si la teinte dépendait de l'ordre de
  // parcours des tronçons, le colosse changerait de pierre au prochain rechargement.
  const genT = createVillageGen({
    BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt: rel, roll: hashRoll, saltBase: 0,
    seaLevel: monde.RELIEF.seaLevel,
    waterTopAt: (x, z) => monde.waterTopAt(x, z),
    alpsAt: (x, z) => monde.alpsIntensity(x, z),
  });
  const tonsQuiBougent = statues.filter((s) => {
    const autre = genT.statueAt(s.i, s.j);
    return !autre || autre.ton !== s.ton;
  });
  check('la pierre d\'un colosse est la même au tronçon régénéré',
    tonsQuiBougent.length === 0,
    `${tonsQuiBougent.length} colosse(s) sur ${statues.length} changeraient de pierre`);

  /**
   * Le nuage de pierre du colosse, en coordonnées locales (x latéral, y au-dessus du sol
   * naturel, z avant). Tout est pris **au-dessus du sol** : le piédestal se coule du terrain
   * jusqu'à sa table, donc juger depuis le socle ferait entrer le remplissage dans le corps
   * — et compter un seul pied à une statue à quatre pattes.
   */
  function relevé(s) {
    const dir = DIRS[s.door];
    const demiZ = Math.max(s.hzAvant, s.hzArriere);
    const pts = [];
    for (let lx = -s.hx - 1; lx <= s.hx + 1; lx++) {
      for (let lz = -demiZ - 1; lz <= demiZ + 1; lz++) {
        const wx = s.ex + dir[0] * lz + (-dir[1]) * lx;
        const wz = s.ez + dir[1] * lz + dir[0] * lx;
        // Toute la colonne, du sol au sommet : s'arrêter au premier bloc ne verrait que le
        // remplissage du socle et ferait mesurer un colosse haut d'un cube.
        for (let y = s.sol; y < CHUNK_HEIGHT; y++) {
          if (PIERRES.has(blocMonde(wx, wz, y))) pts.push([lx, y - s.sol, lz]);
        }
      }
    }
    return pts;
  }

  /** Combien de pieds distincts portent la statue : composantes connexes de la bande basse. */
  function pieds(pts, hauteur) {
    const base = pts.filter(([, y]) => y <= hauteur && y >= 0);
    const jeu = new Set(base.map((p) => p.join(',')));
    const vus = new Set();
    let n = 0;
    for (const p of base) {
      const cle = p.join(',');
      if (vus.has(cle)) continue;
      n++;
      const file = [p];
      vus.add(cle);
      while (file.length) {
        const [x, y, z] = file.pop();
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          for (let dy = -1; dy <= 1; dy++) {
            const q = [x + dx, y + dy, z + dz];
            const k = q.join(',');
            if (vus.has(k) || !jeu.has(k)) continue;
            vus.add(k);
            file.push(q);
          }
        }
      }
    }
    return n;
  }

  // Échantillon jugé : trois sujets par forme, pris loin de l'origine pour que le comptage
  // ne repose pas sur un seul coin de carte.
  const echantillon = [];
  for (const f of ['humain', 'elephant', 'cheval', 'aigle']) {
    let pris = 0;
    for (const s of statues) {
      if (pris >= 3) break;
      if (s.forme !== f) continue;
      if (Math.abs(s.ex) + Math.abs(s.ez) < 400) continue;
      echantillon.push(s);
      pris++;
    }
  }

  const hauteurs = [];
  const largeurs = [];
  const souciSilhouette = [];
  const souciRoute = [];
  const souciBati = [];
  const souciHerbe = [];
  const souciDegre = [];
  for (const s of echantillon) {
    const pts = relevé(s);
    if (!pts.length) { souciSilhouette.push(`${s.forme} : rien d'estampé`); continue; }
    // Le monument se juge **du sol naturel au sommet** : c'est ce que voit le joueur qui
    // lève les yeux depuis la rue. Le corps seul (hors piédestal) sert aux silhouettes.
    const haut = Math.max(...pts.map((p) => p[1])) + 1;
    const corps = pts.filter((p) => p[1] > s.plinthH)
      .map(([x, y, z]) => [x, y - s.plinthH - 1, z]);
    const hautCorps = corps.length ? Math.max(...corps.map((p) => p[1])) + 1 : 0;
    const coteX = Math.max(...corps.map((p) => Math.abs(p[0])));
    const coteZ = Math.max(...corps.map((p) => Math.abs(p[2])));
    hauteurs.push(haut);
    largeurs.push(Math.max(coteX, coteZ));

    const versLeHaut = (p) => p[1] >= 0.75 * hautCorps;
    const lointainX = (p) => Math.abs(p[0]) >= 0.7 * coteX;
    const avantLointain = (p) => p[2] >= 0.7 * s.hzAvant;
    const arriereLointain = (p) => p[2] <= -0.7 * s.hzArriere;
    const bas = (p) => p[1] <= 0.3 * hautCorps;
    const a = (cond) => corps.some(cond);
    if (s.forme === 'humain') {
      if (pieds(corps, 3) !== 2) souciSilhouette.push(`humain : ${pieds(corps, 3)} pied(s) porté(s), attendu 2`);
      if (!a((p) => versLeHaut(p) && Math.abs(p[0]) <= 0.3 * coteX)) souciSilhouette.push('humain : pas de tête au sommet');
      if (!a((p) => versLeHaut(p) && lointainX(p))) souciSilhouette.push('humain : pas de bras levé au-dessus de l épaule');
    } else if (s.forme === 'elephant') {
      if (pieds(corps, 4) < 3) souciSilhouette.push(`éléphant : ${pieds(corps, 4)} appui(s), attendu au moins 3`);
      if (!a((p) => avantLointain(p) && bas(p))) souciSilhouette.push('éléphant : rien de pendu devant les pattes de devant');
      if (!a((p) => arriereLointain(p) && p[1] > 0.3 * hautCorps && p[1] < 0.7 * hautCorps)) souciSilhouette.push('éléphant : pas de queue');
    } else if (s.forme === 'cheval') {
      if (pieds(corps, 4) < 3) souciSilhouette.push(`cheval : ${pieds(corps, 4)} appui(s), attendu au moins 3`);
      if (!a((p) => p[1] >= 0.7 * hautCorps && p[2] >= 0.45 * s.hzAvant)) souciSilhouette.push('cheval : ni encolure ni tête en avant');
      if (!a(arriereLointain)) souciSilhouette.push('cheval : rien derrière la croupe');
    } else {
      // Les deux ailes, pas une seule : la pointe doit se lire à gauche comme à droite,
      // au-dessus des épaules. L'envergure ne se juge pas contre la profondeur totale —
      // le perchoir et la queue l'enflent sans rien dire du déploiement.
      const aile = (sgn) => corps.some((p) => sgn * p[0] >= 0.7 * coteX && p[1] >= 0.45 * hautCorps);
      if (!aile(1)) souciSilhouette.push('aigle : aile droite absente à mi-hauteur');
      if (!aile(-1)) souciSilhouette.push('aigle : aile gauche absente à mi-hauteur');
      if (!a((p) => avantLointain(p) && p[1] >= 0.5 * hautCorps)) souciSilhouette.push('aigle : pas de bec en avant');
    }

    // La pierre ne doit rien écraser : ni le pavé, ni une maison, ni un tronc.
    const demiZ = Math.max(s.hzAvant, s.hzArriere);
    const dir = DIRS[s.door];
    for (let ax = -demiZ - VILLAGE.statuePad; ax <= demiZ + VILLAGE.statuePad; ax++) {
      for (let lt = -s.hx - VILLAGE.statuePad; lt <= s.hx + VILLAGE.statuePad; lt++) {
        const wx = s.ex + dir[0] * ax + (-dir[1]) * lt;
        const wz = s.ez + dir[1] * ax + dir[0] * lt;
        const dansPierre = Math.abs(ax) <= (ax >= 0 ? s.hzAvant : s.hzArriere) && Math.abs(lt) <= s.hx;
        const dansDegre = ax > (ax >= 0 ? s.hzAvant : s.hzArriere)
          && ax <= (ax >= 0 ? s.hzAvant : s.hzArriere) + s.plinthH + 2
          && Math.abs(lt) <= VILLAGE.statueStairWidth;
        if ((dansPierre || dansDegre) && genS.roadKind(wx, wz)) {
          souciRoute.push(`(${wx},${wz}) sous ${s.forme} de (${s.ex},${s.ez})`);
        }
        const porte = ax >= 0 ? s.hzAvant : s.hzArriere;   // devant et derrière ne portent pas pareil
        if (genS.blocksVegetation(wx, wz) === false
          && Math.abs(ax) <= porte + 1 && Math.abs(lt) <= s.hx + 1) {
          souciHerbe.push(`(${wx},${wz}) hors réserve de ${s.forme} de (${s.ex},${s.ez})`);
        }
      }
    }
    // Aucune emprise de maison dans la pierre ni dans la réserve. Le plan est ramené dans
    // le repère du colosse : juger une boîte non tournée sous une forme de dix-huit cubes
    // de long sur sept de large accuserait une maison qui passe, ou en absoudrait une qui
    // s'adosse à la trompe.
    const cx0 = Math.floor((s.ex - demiZ - VILLAGE.statuePad) / CHUNK_SIZE);
    const cx1 = Math.floor((s.ex + demiZ + VILLAGE.statuePad) / CHUNK_SIZE);
    const cz0 = Math.floor((s.ez - demiZ - VILLAGE.statuePad) / CHUNK_SIZE);
    const cz1 = Math.floor((s.ez + demiZ + VILLAGE.statuePad) / CHUNK_SIZE);
    const horsReserve = (cx, cz, p) => {
      let a0 = Infinity;
      let a1 = -Infinity;
      let t0 = Infinity;
      let t1 = -Infinity;
      for (const [qx, qz] of [[p.x0, p.z0], [p.x0 + p.w - 1, p.z0],
        [p.x0, p.z0 + p.d - 1], [p.x0 + p.w - 1, p.z0 + p.d - 1]]) {
        const dx = cx * CHUNK_SIZE + qx - s.ex;
        const dz = cz * CHUNK_SIZE + qz - s.ez;
        const axial = dx * dir[0] + dz * dir[1];
        const tangent = dx * -dir[1] + dz * dir[0];
        if (axial < a0) a0 = axial;
        if (axial > a1) a1 = axial;
        if (tangent < t0) t0 = tangent;
        if (tangent > t1) t1 = tangent;
      }
      const pad = VILLAGE.courtWidth;
      return a1 < -s.hzArriere - pad || a0 > s.hzAvant + pad
        || t1 < -s.hx - pad || t0 > s.hx + pad;
    };
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        for (const p of genS.buildingAt(cx, cz)) {
          if (horsReserve(cx, cz, p)) continue;
          souciBati.push(`maison ${p.kind} (${cx * CHUNK_SIZE + p.x0},${cz * CHUNK_SIZE + p.z0})`
            + ` ${p.w}×${p.d} contre ${s.forme} de (${s.ex},${s.ez})`);
        }
      }
    }

    // Le degré, parcouru du dehors vers le socle : un cube de dénivelé entre deux rangées.
    // On mesure la **surface foulée** (le empilement continu depuis le sol), pas le premier
    // bloc de pierre en partant du haut : une aile ou un bras en surplomb n'est pas une marche.
    const rangees = [];
    for (let hors = s.plinthH + 2; hors >= 1; hors--) {
      const ax = s.hzAvant + hors;              // le degré est toujours devant
      let hautRangee = -Infinity;
      for (let k = -VILLAGE.statueStairWidth; k <= VILLAGE.statueStairWidth; k++) {
        const wx = s.ex + dir[0] * ax + (-dir[1]) * k;
        const wz = s.ez + dir[1] * ax + dir[0] * k;
        // On part du **sol naturel** de la colonne, pas d'une altitude supposée : sur une
        // place en pente, démarrer trop haut faisait mesurer l'air comme une marche.
        let y = rel(wx, wz);
        while (y + 1 < CHUNK_HEIGHT && PIERRES.has(blocMonde(wx, wz, y + 1))) y++;
        if (y > hautRangee) hautRangee = y;
      }
      if (hautRangee > -Infinity) rangees.push(hautRangee);
    }
    rangees.push(s.socle);                       // la table du piédestal ferme la montée
    for (let i = 1; i < rangees.length; i++) {
      if (rangees[i] - rangees[i - 1] > 1) {
        souciDegre.push(`${s.forme} de (${s.ex},${s.ez}) : +${rangees[i] - rangees[i - 1]} cubes à la rangée ${i}`);
        break;
      }
    }
  }

  const mediane = (l) => l.slice().sort((x, y) => x - y)[Math.floor(l.length / 2)] || 0;
  check('le colosse est très grand',
    echantillon.length === 12 && mediane(hauteurs) >= 22 && Math.max(...largeurs) >= 12,
    `${echantillon.length} sujets jugés · hauteur médiane ${mediane(hauteurs)} cubes`
    + ` · plus grande emprise ${Math.max(...largeurs)} cubes`);
  check('la silhouette dit ce que représente le colosse', !souciSilhouette.length,
    souciSilhouette.slice(0, 4).join(' | '));
  check('le piédestal n écrase aucune avenue', !souciRoute.length, souciRoute.slice(0, 3).join(' | '));
  check('aucune maison ne s adosse à un colosse', !souciBati.length, souciBati.slice(0, 3).join(' | '));
  check('rien ne pousse dans la réserve du monument', !souciHerbe.length,
    souciHerbe.slice(0, 3).join(' | '));
  check('on monte au pied du colosse sans escalader', !souciDegre.length,
    souciDegre.slice(0, 3).join(' | '));

  // Déterminisme : le monde n'est sauvé qu'en diff, donc un colosse régénéré doit tomber
  // cube pour cube — et changer de place quand on change la graine.
  const clefs = (g) => {
    const out = [];
    for (let i = -8; i <= 8; i++) {
      for (let j = -8; j <= 8; j++) {
        const s = g.statueAt(i, j);
        if (s) out.push(`${s.forme}@${s.ex},${s.ez},${s.door},${s.socle}`);
      }
    }
    return out.join('|');
  };
  const genBis = createVillageGen({
    BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt: rel, roll: hashRoll, saltBase: 0,
    seaLevel: monde.RELIEF.seaLevel,
    waterTopAt: (x, z) => monde.waterTopAt(x, z),
    alpsAt: (x, z) => monde.alpsIntensity(x, z),
  });
  const genAutre = createVillageGen({
    BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt: rel, roll: hashRoll, saltBase: 4242,
    seaLevel: monde.RELIEF.seaLevel,
    waterTopAt: (x, z) => monde.waterTopAt(x, z),
    alpsAt: (x, z) => monde.alpsIntensity(x, z),
  });
  check('le colosse se régénère à l\'identique', clefs(genBis) === clefs(genS));
  check('changer la graine déplace les colosses', clefs(genAutre) !== clefs(genS));
}

// ------------------------------------------------------- lumière d'intérieur
{
  // Demandé le 2026-11-11 : « il faudrait mettre de la lumiere dans les maisons et dans
  // les temples ». Le village pose donc des lanternes à l'intérieur du bâti, comme ses
  // candélabres de voirie — mêmes blocs cassables et reposables, même halo cuit dans les
  // sommets — et leur place ne dépend que des coordonnées, la sauvegarde n'étant qu'un
  // diff du joueur.
  const tampons = new Map();
  function charge(cx, cz) {
    const cle = `${cx},${cz}`;
    let d = tampons.get(cle);
    if (!d) {
      d = emptyData();
      // Le sol d'abord : dans le jeu, `stampLamps` reçoit un tronçon déjà terrassé, et
      // c'est la terre qui porte le pied de candélabre sous une grande partie de
      // l'emprise. Jugée sur un vide, la moitié des pièces n'aurait « pas de dalle » et
      // la lumière d'intérieur passerait pour absente alors qu'elle est posée.
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const haut = heightAt(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz);
          for (let y = 0; y <= haut; y++) {
            d[idx(lx, y, lz)] = y === haut ? BLOCK.GRASS : y > haut - 4 ? BLOCK.DIRT : BLOCK.STONE;
          }
        }
      }
      gen.stampRoads(d, cx, cz);
      gen.stampBuilding(d, cx, cz);
      gen.stampStructures(d, cx, cz);
      gen.stampLamps(d, cx, cz);          // après les structures, comme dans le jeu
      tampons.set(cle, d);
    }
    return d;
  }
  const blocIci = (wx, y, wz) => {
    if (y < 0 || y >= CHUNK_HEIGHT) return BLOCK.AIR;
    const cx = Math.floor(wx / CHUNK_SIZE), cz = Math.floor(wz / CHUNK_SIZE);
    return charge(cx, cz)[idx(wx - cx * CHUNK_SIZE, y, wz - cz * CHUNK_SIZE)];
  };

  let maisonsJugees = 0, maisonsEclairees = 0, toursJugees = 0, toursEclairees = 0;
  let lanternes = 0, scellees = 0, sansDalle = 0, tetesCoupees = 0, genantes = 0, enterrees = 0;
  let poteauxEnImmeuble = 0, piecesJugees = 0, piecesEclairees = 0, hallsJuges = 0, hallsEclaires = 0;
  const APP = [BLOCK.LAMP_WALL_O, BLOCK.LAMP_WALL_E, BLOCK.LAMP_WALL_N, BLOCK.LAMP_WALL_S];
  const estApplique = (id) => APP.includes(id);
  for (let cx = -6; cx <= 6; cx++) {
    for (let cz = -6; cz <= 6; cz++) {
      for (const p of gen.buildingAt(cx, cz)) {
        const tour = p.kind === 'tower';
        if (tour) toursJugees++; else maisonsJugees++;
        // `p.x0`/`p.z0` sont relatifs au tronçon propriétaire du plan.
        const px = cx * CHUNK_SIZE + p.x0, pz = cz * CHUNK_SIZE + p.z0;
        let trouvee = false;
        for (let x = px; x < px + p.w; x++) {
          for (let z = pz; z < pz + p.d; z++) {
            for (let y = p.siteH; y <= p.siteH + p.height + 1; y++) {
              if (blocIci(x, y, z) !== BLOCK.LAMP_GLOW) continue;
              trouvee = true; lanternes++;
              if (tour) poteauxEnImmeuble++;
              // Le pied sous la lanterne, la dalle sous le pied, le vide au-dessus : une
              // lanterne murée ou suspendue ne serait plus jamais posable à la main.
              if (blocIci(x, y - 1, z) !== BLOCK.LAMP_POST) scellees++;
              if (!blocIci(x, y - 2, z)) sansDalle++;
              if (blocIci(x, y + 1, z)) tetesCoupees++;
              // Deux hauteurs, deux règles : au niveau du pied, le tour compte comme la
              // largeur de passage et doit être libre ; à hauteur de lanterne, un mur de
              // côté est normal (lampe d'angle) mais il faut que la lumière sorte et qu'une
              // face reste à casser — deux des quatre faces comptent.
              let facesLibres = 0;
              for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                if (blocIci(x + dx, y - 1, z + dz)) genantes++;   // bloquerait le passage
                if (!blocIci(x + dx, y, z + dz)) facesLibres++;
              }
              if (facesLibres < 2) enterrees++;
            }
          }
        }
        // L'immeuble, lui, ne se meuble que d'appliques (demandé le 2026-11-12) : le
        // poteau occupe toute sa case à la marche, donc où qu'on le plantât dans une
        // pièce de quatre cases libres il condamnait l'entrée d'une porte. Il est jugé
        // clair à ses globes muraux, et son emprise doit ignorer tout candélabre — pied
        // comme lanterne, à toute hauteur du bâti.
        let appliquesIci = 0;
        for (let x = px; x < px + p.w; x++) {
          for (let z = pz; z < pz + p.d; z++) {
            for (let y = p.siteH; y <= p.siteH + p.height + 1; y++) {
              if (estApplique(blocIci(x, y, z))) appliquesIci++;
            }
          }
        }
        if (tour) {
          if (appliquesIci > 0) toursEclairees++;
        } else if (trouvee) maisonsEclairees++;
        const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
        const apt = p.appartements;
        if (apt) {
          const eclaireeDans = (cellules) => {
            for (let y = p.siteH; y <= p.siteH + p.height + 1; y++) {
              for (const c of cellules) if (estApplique(blocIci(ox + c.lx, y, oz + c.lz))) return true;
            }
            return false;
          };
          for (const s of apt.pieces) {
            piecesJugees++;
            if (eclaireeDans(s.sol)) piecesEclairees++;
          }
          const h = apt.hall;
          const salle = [];
          for (let lx = h.x0; lx < h.x0 + h.w; lx++) {
            for (let lz = h.z0; lz < h.z0 + h.d; lz++) salle.push({ lx, lz });
          }
          hallsJuges++;
          if (eclaireeDans(salle)) hallsEclaires++;
        }
      }
    }
  }
  check('les maisons s\'éclairent elles-mêmes',
    maisonsJugees >= 10 && maisonsEclairees / maisonsJugees > 0.8,
    `${maisonsEclairees}/${maisonsJugees} maisons portant une lanterne`);
  check('les immeubles s\'éclairrent au mur, jamais au poteau',
    toursJugees >= 3 && toursEclairees === toursJugees && poteauxEnImmeuble === 0,
    `${toursEclairees}/${toursJugees} immeubles clairs · ${poteauxEnImmeuble} candélabre(s) dans une emprise d'immeuble`);
  check('chaque pièce et chaque hall d\'immeuble tient sa lumière au mur',
    piecesJugees > 0 && piecesEclairees === piecesJugees && hallsJuges > 0 && hallsEclaires === hallsJuges,
    `${piecesEclairees}/${piecesJugees} pièces · ${hallsEclaires}/${hallsJuges} halls avec une applique`);
  check('aucune lanterne n\'est scellée dans un mur ni privée de dalle',
    scellees === 0 && sansDalle === 0 && tetesCoupees === 0,
    `${scellees} sans pied · ${sansDalle} sans dalle · ${tetesCoupees} sous un plafond`);
  check('une lanterne d\'intérieur ne barre jamais le passage',
    genantes === 0, `${genantes} cases voisines occupées sur ${lanternes} lanternes`);
  check('chaque lanterne d\'intérieur garde des faces pour éclairer et se faire casser',
    enterrees === 0, `${enterrees} lanternes avec moins de deux faces libres`);

  // Le temple : la nef doit être claire, sinon le monument reste un coffre noir la nuit.
  let nefEclairee = 0, templesJuges = 0;
  for (let i = -4; i <= 4; i++) {
    for (let j = -4; j <= 4; j++) {
      const t = gen.templeAt(i, j);
      if (!t) continue;
      templesJuges++;
      const demi = VILLAGE.templeCellaHalf + 1;
      let vue = false;
      for (let x = t.ex - demi; x <= t.ex + demi && !vue; x++) {
        for (let z = t.ez - demi; z <= t.ez + demi && !vue; z++) {
          for (let y = t.socle - 1; y <= t.socle + 3; y++) {
            if (blocIci(x, y, z) === BLOCK.LAMP_GLOW) { vue = true; break; }
          }
        }
      }
      if (vue) nefEclairee++;
    }
  }
  check('la nef du temple s\'éclaire la nuit',
    templesJuges >= 2 && nefEclairee === templesJuges,
    `${nefEclairee}/${templesJuges} monuments avec une lanterne dans la nef`);

  // Les candélabres de voirie n'ont pas à pâtir de ce nouveau passage : la règle du vide
  // autour du pied ne s'applique qu'à l'intérieur, sans quoi une avenue entière perdrait
  // ses lampadaires, sa colonne longeant un mur de façade.
  const rues = gen.lampadairesSur(-96, -96, 95, 95);
  const ruesEclairees = rues.filter((l) => blocIci(l.wx, l.y + 1, l.wz) === BLOCK.LAMP_GLOW).length;
  check('les avenues restent éclairées',
    rues.length > 0 && ruesEclairees > 0,
    `${ruesEclairees} lanternes posées sur ${rues.length} emplacements d'avenue`);

  // ------------------------------------------------ appliques des couloirs d'immeuble
  // Demandé le 2026-11-11 : « dans les immeubles tu mis les lumières devant les portes,
  // il faudrait ajouter une lumière qui soit mise sur les murs pour éviter de bloquer le
  // passage », puis repris le 2026-11-12 : « il y a toujours un lampadaire qui empêche
  // d'entrer dans une pièce de l'immeuble, mets uniquement des appliques aux murs ». Le
  // couloir d'un immeuble fait deux cubes de large et un candélabre occupe toute sa case
  // à la marche — la collision se juge à la cellule, jamais à la silhouette fine du poteau
  // — donc où qu'on le plaçât il condamnait le seuil de quelqu'un. Tout l'immeuble se
  // couvre donc d'appliques scellées au mur, et le candélabre n'y revient plus.
  // Colonnes bordant une porte de pièce : s'y tenir, c'est ouvrir. Ni un candélabre ni sa
  // lanterne n'y ont leur place.
  const seuils = new Set();
  let immeubles = 0;
  for (let cx = -6; cx <= 6; cx++) {
    for (let cz = -6; cz <= 6; cz++) {
      for (const p of gen.buildingAt(cx, cz)) {
        const apt = p.appartements;
        if (!apt) continue;
        immeubles++;
        const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
        for (const s of apt.pieces) {
          const px = ox + s.porte.lx, pz = oz + s.porte.lz;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) seuils.add(`${px + dx},${pz + dz}`);
        }
      }
    }
  }
  let couloirs = 0, couloirsSombre = 0, appliques = 0, sansMur = 0, enterree = 0, surVitre = 0;
  let poteauxEnCouloir = 0, lanterneAuSeuil = 0, faceAPorte = 0;
  // Une applique se scelle contre un mur plein — jamais dans l'ébrasement d'une porte, qui
  // est creusé sur trois cubes, ni sur une baie vitrée, qui n'est pas un support — et elle
  // garde son cube libre devant elle comme au-dessus d'elle, sinon elle disparaît sous la
  // dalle et personne ne peut plus la casser ni la reposer. Jugé de la même façon dans le
  // couloir et dans les pièces : la règle ne change pas d'un espace à l'autre.
  const jugerApplique = (wx, wz, y) => {
    if (!estApplique(blocIci(wx, y, wz))) return false;
    appliques++;
    if (seuils.has(`${wx},${wz}`)) faceAPorte++;
    const adosses = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dz]) => blocIci(wx + dx, y, wz + dz))
      .filter((b) => b);
    if (!adosses.length) sansMur++;
    if (adosses.every((b) => b === BLOCK.GLASS)) surVitre++;
    if (blocIci(wx, y - 1, wz) || blocIci(wx, y + 1, wz)) enterree++;
    return true;
  };
  for (let cx = -6; cx <= 6; cx++) {
    for (let cz = -6; cz <= 6; cz++) {
      const zone = cx * CHUNK_SIZE, zoneZ = cz * CHUNK_SIZE;
      const bornes = [zone, zoneZ, zone + CHUNK_SIZE - 1, zoneZ + CHUNK_SIZE - 1];
      for (const co of gen.couloirsSur(...bornes)) {
        couloirs++;
        let trouvee = false;
        for (const c of co.cellules) {
          const pied = blocIci(c.wx, co.y, c.wz);
          if (pied === BLOCK.LAMP_POST) poteauxEnCouloir++;
          if (pied === BLOCK.LAMP_POST || pied === BLOCK.LAMP_GLOW) {
            if (seuils.has(`${c.wx},${c.wz}`)) lanterneAuSeuil++;
          }
          if (jugerApplique(c.wx, c.wz, co.y + 1)) trouvee = true;
        }
        if (!trouvee) couloirsSombre++;
      }
      // Pièces et halls : mêmes exigences, jugés sur leurs propres cellules.
      for (const co of gen.piecesDImmeubleSur(...bornes)) {
        for (const c of co.cellules) jugerApplique(c.wx, c.wz, co.y + 1);
      }
    }
  }
  check('les couloirs d\'immeuble s\'éclairrent au mur',
    immeubles >= 3 && couloirs > 0 && couloirsSombre === 0,
    `${couloirs} couloirs jugés sur ${immeubles} immeubles, ${appliques} appliques, ${couloirsSombre} sans lumière`);
  check('une applique se scelle contre un mur plein et garde son cube libre',
    appliques > 0 && sansMur === 0 && enterree === 0 && surVitre === 0,
    `${sansMur} sans mur porteur · ${surVitre} sur vitre · ${enterree} ensevelies sur ${appliques} appliques`);
  check('plus aucun candélabre ne barre un couloir ni le seuil d\'une porte',
    poteauxEnCouloir === 0 && lanterneAuSeuil === 0,
    `${poteauxEnCouloir} poteaux en couloir · ${lanterneAuSeuil} lanternes au seuil`);
  check('les appliques ne s\'alignent pas dans les ouvertures des portes',
    faceAPorte === 0, `${faceAPorte} appliques face à une porte sur ${appliques}`);

  // Déterminisme : deux estampages séparés du même tronçon rendent les mêmes cubes.
  // Jugé sur un tronçon qui porte un couloir — c'est là que le tirage d'ordre des
  // appliques pourrait dériver d'une exécution à l'autre.
  let tronconCouloir = null;
  outer: for (let cx = -6; cx <= 6 && !tronconCouloir; cx++) {
    for (let cz = -6; cz <= 6; cz++) {
      if (gen.couloirsSur(cx * CHUNK_SIZE, cz * CHUNK_SIZE,
        cx * CHUNK_SIZE + CHUNK_SIZE - 1, cz * CHUNK_SIZE + CHUNK_SIZE - 1).length) {
        tronconCouloir = [cx, cz];
        break outer;
      }
    }
  }
  check('les couloirs d\'immeuble sont bien présents dans le carré jugé', !!tronconCouloir,
    tronconCouloir ? `premier couloir au tronçon ${tronconCouloir.join(',')}` : 'aucun couloir trouvé');
  const un = emptyData(); const deux = emptyData();
  for (const d of [un, deux]) {
    gen.stampRoads(d, 3, -2);
    gen.stampBuilding(d, 3, -2);
    gen.stampStructures(d, 3, -2);
    gen.stampLamps(d, 3, -2);
  }
  let differents = 0;
  for (let i = 0; i < un.length; i++) if (un[i] !== deux[i]) differents++;
  check('la lumière d\'intérieur se régénère cube pour cube', differents === 0,
    `${differents} cubes différents sur deux estampages`);

  if (tronconCouloir) {
    const [tx, tz] = tronconCouloir;
    const tamponApplique = () => {
      const d = emptyData();
      // Le sol, comme dans le jeu : la pose juge la dalle sous le passage.
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const haut = heightAt(tx * CHUNK_SIZE + lx, tz * CHUNK_SIZE + lz);
          for (let y = 0; y <= haut; y++) {
            d[idx(lx, y, lz)] = y === haut ? BLOCK.GRASS : y > haut - 4 ? BLOCK.DIRT : BLOCK.STONE;
          }
        }
      }
      gen.stampRoads(d, tx, tz);
      gen.stampBuilding(d, tx, tz);
      gen.stampStructures(d, tx, tz);
      gen.stampLamps(d, tx, tz);
      return d;
    };
    const a = tamponApplique(); const b = tamponApplique();
    let ecart = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) ecart++;
    let vues = 0;
    for (const v of a) if (estApplique(v)) vues++;
    check('la rangée d\'appliques se régénère cube pour cube', ecart === 0 && vues > 0,
      `${ecart} cubes différents · ${vues} appliques sur le tronçon ${tx},${tz}`);
  }
}

process.exit(summary());
