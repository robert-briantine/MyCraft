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

const { createVillageGen, VILLAGE, storeysOf } = await loadPublicModule('public/js/village.js');

const CHUNK_SIZE = 16;
const CHUNK_HEIGHT = 64;
const BLOCK = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, COBBLE: 4, PLANKS: 5,
  BRICK: 6, GLASS: 7, GRIT: 8, OBSIDIAN: 9, LOG: 10, LEAVES: 11,
  // Les matériaux du monument doivent exister ici aussi : absents de la table, ils
  // s'estampaient en `undefined`, donc en air, et le temple disparaissait des tampons
  // sans que la génération du plan le dise.
  SAND: 12, SNOW: 13, GOLD: 14, MOSS: 15,
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
// serait une cage sans sortie.
function stairCapacity(w, d) {
  const coreW = w - 2;
  const coreD = d - 2;
  if (coreW < 2 || coreD < 2) return 0;
  return Math.max(coreW, coreD) * Math.floor(Math.min(coreW, coreD) / 2);
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

const horsTronçon = [...plans.values()].find((p) => !(
  p.x0 >= 1 && p.z0 >= 1 && p.x0 + p.w <= CHUNK_SIZE - 1 && p.z0 + p.d <= CHUNK_SIZE - 1
));
check('une empreinte ne franchit jamais une frontière de tronçon', !horsTronçon,
  horsTronçon ? `x0=${horsTronçon.x0} z0=${horsTronçon.z0} w=${horsTronçon.w} d=${horsTronçon.d}` : '');

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

  let dalleOk = true, litOk = true, toitOk = true, toitDegageOk = true, interieurOk = true, faconnOk = true;
  let porte = 0;
  const isPerimeter = (lx, lz) => lx === plan.x0 || lx === plan.x0 + plan.w - 1 || lz === plan.z0 || lz === plan.z0 + plan.d - 1;
  for (let lx = plan.x0; lx < plan.x0 + plan.w; lx++) {
    for (let lz = plan.z0; lz < plan.z0 + plan.d; lz++) {
      if (at(lx, plan.siteH, lz) !== plan.floor) dalleOk = false;
      if (at(lx, plan.siteH - 1, lz) !== BLOCK.DIRT) litOk = false;
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
  check('la dalle repose sur son lit de terre', dalleOk && litOk, `dalle=${dalleOk} lit=${litOk}`);
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
    const data = emptyData();
    gen.stampBuilding(data, cx, cz);
    const at = (lx, y, lz) => data[idx(lx, y, lz)];
    const door = plan.door;
    if (!door) { defaut = `${key} : aucune baie de porte`; break; }
    // Le seuil suit la rue là où elle s'est haussée par ses escaliers : on le cherche
    // plutôt qu'on ne le suppose, puis la baie et la tête du joueur se comptent depuis lui.
    const f = door.front;
    let seuil = plan.siteH;
    while (seuil < plan.siteH + 4 && at(f.lx, seuil + 1, f.lz) !== BLOCK.AIR) seuil++;
    if (at(door.lx, seuil + 1, door.lz) !== BLOCK.AIR || at(door.lx, seuil + 2, door.lz) !== BLOCK.AIR) {
      defaut = `${key} : la baie est bouchée (seuil ${seuil}, plancher ${plan.siteH})`; break;
    }
    // Côté rue, la porte ne doit donner ni sur un remblai ni sur le vide.
    const above = [at(f.lx, seuil + 1, f.lz), at(f.lx, seuil + 2, f.lz)];
    if (above[0] !== BLOCK.AIR || above[1] !== BLOCK.AIR) {
      defaut = `${key} : entrée obstruée dehors (${above.join('/')})`; break;
    }
    if (at(f.lx, seuil, f.lz) === BLOCK.AIR) {
      defaut = `${key} : pas de seuil devant la porte`; break;
    }
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
    for (let k = 0; k < s.treads.length; k++) {
      const tread = s.treads[k];
      const cells = tread.cells;
      // Deux colonnes de large : le collider du joueur (0,6) chevauche la voisine,
      // une volée d'une seule colonne se heurte au plafond d'à côté.
      if (!Array.isArray(cells) || cells.length !== 2 || !adjacent(cells[0], cells[1])) {
        souci = `${key} : marche ${k} plus étroite qu'un joueur (${cells && cells.length} colonne(s))`;
        break;
      }
      if (tread.y !== plan.siteH + k + 1) { souci = `${key} : marche ${k} posée à y=${tread.y}`; break; }
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

    const data = emptyData();
    gen.stampBuilding(data, cx, cz);
    const at = (lx, y, lz) => data[idx(lx, y, lz)];
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
  for (let cx = -R; cx <= R; cx++) {
    for (let cz = -R; cz <= R; cz++) {
      const wx = cx * CHUNK_SIZE + (CHUNK_SIZE >> 1);
      const wz = cz * CHUNK_SIZE + (CHUNK_SIZE >> 1);
      const inf = gen.cityInfluence(wx, wz);
      const list = gen.buildingAt(cx, cz);
      if (inf >= 0.5) { villeChunks++; villePlans += list.length; }
      else if (inf <= 0.12) { campagneChunks++; campagnePlans += list.length; }
      for (const p of list) {
        gabarits.add(`${p.kind}:${p.w}x${p.d}x${p.height}`);
        if (p.kind !== 'tower') continue;
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
  check('les tours de ville sont plus hautes que celles de la campagne',
    tourDeVille >= 14 && tourDeCampagne <= 12 && tourDeVille > tourDeCampagne,
    `ville=${tourDeVille}, campagne=${tourDeCampagne}`);
  check('le cœur de ville monte jusqu’à dix étages, la campagne reste basse',
    etagesDeVille >= 10 && etagesDeCampagne <= 3,
    `étages max ville=${etagesDeVille} (hauteur ${tourDeVille}), campagne=${etagesDeCampagne} (hauteur ${tourDeCampagne}), un étage = ${VILLAGE.floorPitch} blocs`);
  check('les gabarits sont variés', gabarits.size >= 40, `${gabarits.size} empreintes différentes`);
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
    // Raccord avec la rue naturelle aux deux bouts de l'ouvrage : c'est là que le
    // nivellement des approches peut laisser un ressaut que la seule pente interne ne
    // révèle pas.
    const raccord = Math.max(
      Math.abs(a.levels.get(a.lo) - sol(a.axis, a.k, a.lo - 1, 0)),
      Math.abs(a.levels.get(a.hi) - sol(a.axis, a.k, a.hi + 1, 0)),
    );
    if (raccord > 1) { souciArc = `${tag} : raccord d'approche de ${raccord} cubes`; break; }
    const spring = a.g + a.clear;
    for (let i = a.t0; i <= a.t1 && !souciArc; i++) {
      const s = a.levels.get(i);
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
                ressautsNaturels: 0, pave: '', palier: '', tete: '' };
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
  // Le monument ne doit rien emprunter aux façades du village : brique, planches et
  // roche sont les matériaux de la maison ; marbre (neige), sable et or sont ceux du
  // temple. Confondre les deux, c'est n'avoir « aucun temple » sous les yeux.
  const MARBRE = [BLOCK.SNOW, BLOCK.SAND, BLOCK.GOLD, BLOCK.MOSS];
  const MATERIAUX_DU_VILLAGE = [BLOCK.BRICK, BLOCK.PLANKS, BLOCK.COBBLE, BLOCK.WOOD, BLOCK.STONE];

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
  let materiauVillage = 0;
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
    if (!MARBRE.includes(bloc(t.ex, haut + 1, t.ez))) toitAbsent++;
    // Aucun plan du monument ne doit toucher un matériau de maison.
    if ([t.wall, t.fill, t.roof, t.altar].some((b) => MATERIAUX_DU_VILLAGE.includes(b))) materiauVillage++;

    // La colonnade : un anneau de fûts, et le passage d'axe laissé libre devant la porte.
    let futs = 0;
    const R = t.half - 1;
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== R) continue;
        if (MARBRE.includes(bloc(t.ex + dx, t.socle + 2, t.ez + dz))) futs++;
      }
    }
    // Un fût sur `templeColumnPitch` le long des quatre faces, à moitié moins toléré :
    // une colonnade clairsemée ne se lit plus comme un périptère.
    const futsAttendus = 4 * Math.floor((2 * R + 1) / VILLAGE.templeColumnPitch);
    if (futs < futsAttendus / 2) colonnesTropPeu++;
    if (bloc(t.ex + dir.dx * R, t.socle + 2, t.ez + dir.dz * R) !== BLOCK.AIR) axeBouche++;

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
  check('le temple n\'emprunte aucun matériau du village', materiauVillage === 0,
    `${materiauVillage} monument(s) bâti(s) avec la brique, les planches ou la roche des maisons`);

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

process.exit(summary());
