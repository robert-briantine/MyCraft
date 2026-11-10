// Vérifie l'océan : où la mer s'arrête, ce qu'elle recouvre, et le contrôleur de nage.
// Deux mondes jugés ici — le relief et ses estampages sous Node (le jeu n'est pas
// nécessaire), puis l'eau posée et le joueur qui flotte dans le navigateur.
// Usage: node tests/ocean.mjs [url]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReporter, openGame } from './browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = process.argv[2] || 'http://localhost:8080';
const { check, summary } = makeReporter();

async function loadPublicModule(relative) {
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  const tmp = path.join(os.tmpdir(), `mycraft-ocean-${path.basename(relative, '.js')}-${process.pid}.mjs`);
  fs.writeFileSync(tmp, source);
  try {
    return await import(pathToFileURL(tmp).href);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const { SimplexNoise } = await loadPublicModule('public/js/noise.js');
const { createTerrain, RELIEF } = await loadPublicModule('public/js/terrain.js');
const { createVillageGen } = await loadPublicModule('public/js/village.js');
const { createBiomeGen } = await loadPublicModule('public/js/biomes.js');

const CHUNK_SIZE = 16;
const CHUNK_HEIGHT = 64;
// Table du jeu, pas une table locale : le générateur écrit de l'EAU, du SABLE et du
// GRavier, et une id absente de la palette s'estampait en air sans le dire.
const BLOCK = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, WOOD: 4, LEAVES: 5, SAND: 6, WATER: 7,
  PLANKS: 8, BRICK: 9, COAL: 10, IRON: 11, GOLD: 12, DIAMOND: 13, SNOW: 14,
  GRIT: 15, COBBLE: 16, GLASS: 17, MOSS: 18, LAVA: 19, OBSIDIAN: 20,
};
const REVETEMENTS_DE_VOIRIE = [BLOCK.GRIT, BLOCK.COBBLE];

function hashRoll(x, y, z, salt) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)
        ^ Math.imul(z | 0, 1274126177) ^ Math.imul(salt | 0, 2654435761);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// Le monde du jeu, rejoué à l'identique : même bruit, mêmes graines, même ligne de
// flottaison. Une sonde qui jugerait un autre relief ne prouverait rien.
const terrain = createTerrain({ noise: new SimplexNoise(42), chunkHeight: CHUNK_HEIGHT });
const SEA = RELIEF.seaLevel;
const memo = new Map();
function heightAt(x, z) {
  const k = `${x},${z}`;
  let v = memo.get(k);
  if (v === undefined) {
    v = terrain.heightAt(x, z);
    memo.set(k, v);
  }
  return v;
}
const village = createVillageGen({
  BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt, roll: hashRoll,
  saltBase: (777 * 7919) | 0, seaLevel: SEA,
  waterTopAt: (x, z) => terrain.waterTopAt(x, z),
});
const biomes = createBiomeGen({
  BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt, roll: hashRoll,
  saltBase: (123 * 7919) | 0, seaLevel: SEA,
  riverAt: (x, z) => terrain.riverAt(x, z),
  isBlocked: (wx, wz) => village.isOccupied(wx, wz),
});
const waterTop = (x, z) => terrain.waterTopAt(x, z);

const idx = (lx, y, lz) => lx + lz * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE;
const emptyData = () => new Uint16Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_HEIGHT).fill(BLOCK.AIR);
const q = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)] : 0);

// ============================================================ 1. la mer
{
  const PAS = 4;
  const N = 100;
  let total = 0, noyees = 0;
  const profondeurs = [];
  for (let i = -N; i <= N; i++) for (let j = -N; j <= N; j++) {
    const h = heightAt(i * PAS, j * PAS);
    total++;
    if (h < SEA) { noyees++; profondeurs.push(SEA - h); }
  }
  const part = 100 * noyees / total;
  check('la mer occupe une large part du monde', part >= 22 && part <= 40,
    `${part.toFixed(1)} % des colonnes sous le niveau ${SEA}`);
  check('assez d’eau pour nager', q(profondeurs, .5) >= 4 && q(profondeurs, .9) >= 7,
    `profondeur médiane ${q(profondeurs, .5)} cubes, p90 ${q(profondeurs, .9)}`);
}

/** Plus grande nappe jointoyante échantillonnée sur une grille grossière. */
function plusGrandeMer() {
  const PAS = 4;
  const N = 100;
  const vu = new Set();
  let meilleure = 0;
  for (let i = -N; i <= N; i++) for (let j = -N; j <= N; j++) {
    const x = i * PAS, z = j * PAS;
    if (vu.has(`${x},${z}`) || heightAt(x, z) >= SEA) continue;
    const file = [[x, z]];
    let taille = 0;
    vu.add(`${x},${z}`);
    while (file.length && taille < 60000) {
      const [ax, az] = file.shift();
      taille++;
      for (const [dx, dz] of [[PAS, 0], [-PAS, 0], [0, PAS], [0, -PAS]]) {
        const bx = ax + dx, bz = az + dz;
        if (Math.abs(bx) > N * PAS || Math.abs(bz) > N * PAS) continue;
        if (vu.has(`${bx},${bz}`) || heightAt(bx, bz) >= SEA) continue;
        vu.add(`${bx},${bz}`);
        file.push([bx, bz]);
      }
    }
    if (taille > meilleure) meilleure = taille;
  }
  return meilleure * PAS * PAS;
}
check('une mer se rencontre en explorant, pas une flaque', plusGrandeMer() >= 20000,
  `plus grande nappe jointoyante ${Math.round(plusGrandeMer())} cubes²`);

// ============================================================ 2. en sortir
/**
 * Nager déplace librement entre colonnes noyées ; en sortir demande une berge dont le
 * sommet s'atteigne depuis la ligne de flottaison. Le contrôleur de nage hisse le
 * corps jusqu'à `SWIM_STEP` (2) cubes : c'est la portée réellement accordée au joueur,
 * donc celle que l'on exige du relief.
 */
function peutSortir(x0, z0, portee) {
  const vu = new Set([`${x0},${z0}`]);
  const file = [[x0, z0]];
  for (let garde = 0; garde < 80000 && file.length; garde++) {
    const [x, z] = file.shift();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nh = heightAt(x + dx, z + dz);
      if (nh >= SEA) { if (nh <= SEA + portee) return true; continue; }
      const k = `${x + dx},${z + dz}`;
      if (vu.has(k)) continue;
      vu.add(k);
      file.push([x + dx, z + dz]);
    }
  }
  return false;
}
{
  let testees = 0, bloquees = 0;
  const exemples = [];
  for (let t = 0; t < 220; t++) {
    const x = Math.floor(hashRoll(t, 991, t * 7, 4242) * 2400) - 1200;
    const z = Math.floor(hashRoll(t, 131, t * 13, 9091) * 2400) - 1200;
    if (heightAt(x, z) >= SEA) continue;
    testees++;
    if (!peutSortir(x, z, 2)) {
      bloquees++;
      if (exemples.length < 4) exemples.push(`${x},${z} (sol ${heightAt(x, z)})`);
    }
  }
  check('depuis l’eau, on regagne toujours la terre ferme', testees > 60 && bloquees === 0,
    `${bloquees} colonne(s) noyée(s) sans issue sur ${testees}`);
}

// ============================================================ 3. le rivage
{
  // Le sable borde l'eau : trois cubes de grève entre la ligne de flottaison et
  // l'herbe, c'est ce qui fait une plage plutôt qu'une falaise d'herbe dans la mer.
  let teste = 0, ratés = 0;
  const exemples = [];
  for (let t = 0; t < 400; t++) {
    const x = Math.floor(hashRoll(t, 77, t * 3, 5150) * 2000) - 1000;
    const z = Math.floor(hashRoll(t, 9999, t * 5, 2600) * 2000) - 1000;
    const h = heightAt(x, z);
    if (h > SEA + 2) continue;
    teste++;
    if (biomes.surfaceFor(x, z, h).top !== BLOCK.SAND) {
      ratés++;
      if (exemples.length < 4) exemples.push(`${x},${z} sol ${h} revêtement ${biomes.surfaceFor(x, z, h).top}`);
    }
  }
  check('le sable borde l’eau', teste > 40 && ratés === 0,
    `${ratés} colonne(s) de rivage hors sable${exemples.length ? ` — ${exemples.join(' | ')}` : ''}`);
}

// ============================================================ 4. rien sous les eaux
{
  // Un tronçon entièrement noyé ne doit rien porter au-dessus de l'eau : ni chaussée,
  // ni mur, ni souche, ni tablier. On estampe la chaîne du jeu dans un tampon vide et
  // on regarde ce qui dépasse la ligne de flottaison.
  const CHAINE = ['stampRoads', 'stampBuilding', 'stampStructures'];
  let visites = 0, anormaux = 0;
  const exemples = [];
  const compteur = new Map();
  for (let cx = -9; cx <= 9; cx++) for (let cz = -9; cz <= 9; cz++) {
    let secs = 0;
    for (let lx = 0; lx < CHUNK_SIZE; lx += 4) for (let lz = 0; lz < CHUNK_SIZE; lz += 4) {
      if (heightAt(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz) >= SEA) secs++;
    }
    if (secs > 2) continue;                       // tronçon jouable : hors périmètre
    visites++;
    const data = emptyData();
    for (const etape of CHAINE) village[etape](data, cx, cz);
    // Un franchissement d'eau a le droit de porter des cubes au-dessus de la mer : c'est
    // un pont, pas une construction sur l'eau. Ses piles descendent dans le lit et son
    // tablier domine le chenal — il est jugé par le contrôle qui lui est propre plus bas.
    const pontsIci = new Set();
    for (const s of village.structuresAt(cx, cz)) {
      if (s.kind !== 'bridge' || !s.surEau) continue;
      const axeOff = s.k * village.VILLAGE.roadSpacing;
      for (let i = s.from; i <= s.to; i++) {
        for (let o = -s.half; o <= s.half; o++) {
          pontsIci.add(s.axis === 'x' ? `${i},${axeOff + o}` : `${axeOff + o},${i}`);
        }
      }
    }
    let coupables = 0;
    for (let lx = 0; lx < CHUNK_SIZE; lx++) for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      if (heightAt(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz) >= SEA) continue;
      if (pontsIci.has(`${cx * CHUNK_SIZE + lx},${cz * CHUNK_SIZE + lz}`)) continue;
      for (let y = SEA; y < CHUNK_HEIGHT; y++) {
        const b = data[idx(lx, y, lz)];
        if (b === BLOCK.AIR) continue;
        coupables++;
        compteur.set(b, (compteur.get(b) || 0) + 1);
        if (exemples.length < 4) exemples.push(`${cx},${cz} en (${lx},${lz}) sol ${heightAt(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz)} bloc ${b} à y=${y}`);
      }
    }
    if (coupables) anormaux++;
  }
  check('un tronçon noyé ne porte rien au-dessus de l’eau', visites > 4 && anormaux === 0,
    `${anormaux} tronçon(s) bâti(s) sous la mer sur ${visites}${exemples.length ? ` — ${exemples.join(' | ')}` : ''}`);
}
{
  // Idem pour la végétation, estampée à part : rocher et souche morte du désert se
  // posent au-dessus du sol sans regarder l'eau.
  let visites = 0, plantees = 0;
  const exemples = [];
  for (let cx = -9; cx <= 9; cx++) for (let cz = -9; cz <= 9; cz++) {
    let secs = 0;
    for (let lx = 0; lx < CHUNK_SIZE; lx += 4) for (let lz = 0; lz < CHUNK_SIZE; lz += 4) {
      if (heightAt(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz) >= SEA) secs++;
    }
    if (secs > 2) continue;
    visites++;
    const data = emptyData();
    biomes.stampVegetation(data, cx, cz);
    let anomalie = false;
    for (let lx = 0; lx < CHUNK_SIZE; lx++) for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      if (heightAt(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz) >= SEA) continue;
      for (let y = 0; y < CHUNK_HEIGHT; y++) {
        const b = data[idx(lx, y, lz)];
        if (b === BLOCK.WOOD || b === BLOCK.LEAVES || b === BLOCK.COBBLE) {
          anomalie = true;
          if (exemples.length < 4) exemples.push(`${cx},${cz} en (${lx},${lz}) bloc ${b} à y=${y}`);
        }
      }
    }
    if (anomalie) plantees++;
  }
  check('rien ne pousse sous la mer', visites > 4 && plantees === 0,
    `${plantees} tronçon(s) planté(s) sous la mer sur ${visites}${exemples.length ? ` — ${exemples.join(' | ')}` : ''}`);
}
{
  // Aucune emprise bâtie ne trempe : le gabarit l'exige déjà par la bande d'altitude,
  // mais c'est l'océan qu'on veut vérifier, pas la bande. Périmètre exact du plan —
  // la colonne voisine de la façade peut plonger sans que la maison y touche.
  let plans = 0, genants = 0;
  const exemples = [];
  for (let cx = -8; cx <= 8; cx++) for (let cz = -8; cz <= 8; cz++) {
    for (const p of village.buildingAt(cx, cz)) {
      plans++;
      const baseX = cx * CHUNK_SIZE, baseZ = cz * CHUNK_SIZE;
      for (let x = p.x0; x < p.x0 + p.w; x++) for (let z = p.z0; z < p.z0 + p.d; z++) {
        if (heightAt(baseX + x, baseZ + z) < waterTop(baseX + x, baseZ + z)) {
          genants++;
          if (exemples.length < 3) exemples.push(`${cx},${cz}#${p.x0},${p.z0}`);
        }
      }
    }
  }
  check('aucun bâtiment ne trempe', plans > 40 && genants === 0,
    `${genants} emprise(s) sur l’eau sur ${plans} bâtiment(s)`);
}
{
  // Aucune avenue n'écrit de chaussée sous la mer. La règle du générateur porte sur le
  // niveau **posé par la rue**, pas seulement sur le terrain : une avenue qui descend
  // vers une baie lisse son profil à un cube par colonne et pouvait poser son pavé neuf
  // cubes sous l'eau, le dégagement qu'elle se ménage au-dessus évinçant l'eau — d'où le
  // fossé noyé. On juge donc le tampon écrit, colonne par colonne, jusqu'à la ligne.
  let genants = 0, testees = 0, noyees = 0;
  const exemples = [];
  const tampons = new Map();
  for (let t = 0; t < 4000; t++) {
    const x = Math.floor(hashRoll(t, 4242, t * 11, 900) * 1600) - 800;
    const z = Math.floor(hashRoll(t, 9091, t * 17, 11) * 1600) - 800;
    if (!village.roadKind(x, z)) continue;
    testees++;
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
    const cle = `${cx},${cz}`;
    let data = tampons.get(cle);
    if (!data) {
      data = emptyData();
      village.stampRoads(data, cx, cz);
      tampons.set(cle, data);
    }
    const lx = x - cx * CHUNK_SIZE, lz = z - cz * CHUNK_SIZE;
    const ligne = Math.max(SEA, waterTop(x, z));   // mer, ou plan local d'une rivière
    let revetement = -1;
    for (let y = 0; y <= ligne; y++) {
      if (REVETEMENTS_DE_VOIRIE.includes(data[idx(lx, y, lz)])) { revetement = y; break; }
    }
    if (revetement < 0) continue;
    noyees++;
    genants++;
    if (exemples.length < 3) {
      exemples.push(`${x},${z} sol ${heightAt(x, z)} pavé à y=${revetement} (${ligne - revetement} cube(s) sous l’eau)`);
    }
  }
  check('l’avenue s’arrête au rivage', testees > 20 && genants === 0,
    `${genants} chaussée(s) sous l’eau sur ${testees} cellules de voirie${exemples.length ? ` — ${exemples.join(' | ')}` : ''}`);
}

// ============================================================ 4bis. les rivières
{
  // Un cours d'eau se reconnaît à sa forme : une longue traînée jointoyante, pas une
  // chape de points. On dénombre les composantes connexes de lit sur une fenêtre et on
  // juge la plus grande — surface allongée, pas seulement largeur. La densité se rapporte
  // aux **terres** : la moitié de la fenêtre est de la mer, où par définition il n'y a pas
  // de rivière, et un pourcentage sur l'ensemble ne voudrait rien dire.
  //
  // La fenêtre fait sept cents cubes de demi-côté depuis que la carte porte des massifs à
  // l'échelle des océans : à trois cent vingt, un seul massif pouvait remplir tout le
  // champ et la fenêtre ne comptait plus qu'un cours — ce n'était pas le monde qui avait
  // peu de rivières (mesuré : densité 0,35 % à ±700 contre 0,16 % à ±320), c'est la
  // mesure qui tenait dans un seul tirage du relief.
  const N = 700;
  const vus = new Set();
  let lits = 0, cases = 0, terres = 0, plusGrosse = 0, plusEtendu = 0;
  const largeurs = [];
  const cours = [];
  const cle = (x, z) => `${x},${z}`;
  for (let x = -N; x <= N; x++) {
    for (let z = -N; z <= N; z++) {
      cases++;
      if (terrain.rawHeight(x, z) > SEA) terres++;
      const r = terrain.riverAt(x, z);
      if (!r || r.d > r.demiLargeur) continue;
      lits++;
      largeurs.push(Math.round(r.demiLargeur * 2));
      if (vus.has(cle(x, z))) continue;
      const file = [[x, z]];
      vus.add(cle(x, z));
      let taille = 0, minX = x, maxX = x, minZ = z, maxZ = z, mer = false, bord = false;
      while (file.length && taille < 60000) {
        const [ax, az] = file.shift();
        taille++;
        if (ax < minX) minX = ax; if (ax > maxX) maxX = ax;
        if (az < minZ) minZ = az; if (az > maxZ) maxZ = az;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const bx = ax + dx, bz = az + dz;
          if (Math.abs(bx) > N || Math.abs(bz) > N) { bord = true; continue; }
          if (vus.has(cle(bx, bz))) continue;
          const rb = terrain.riverAt(bx, bz);
          if (rb && rb.d <= rb.demiLargeur) { vus.add(cle(bx, bz)); file.push([bx, bz]); }
          // La jonction à la mer se juge sur le **sol naturel** : juger sur le plan d'eau
          // ne fonctionnait jamais, car au droit de l'embouchure chaque colonne voisine est
          // elle-même évidée par un lit et annonce donc un plan local, jamais la mer.
          else if (terrain.rawHeight(bx, bz) <= SEA) mer = true;
        }
      }
      if (taille > plusGrosse) plusGrosse = taille;
      const etendue = Math.max(maxX - minX, maxZ - minZ);
      if (etendue > plusEtendu) plusEtendu = etendue;
      cours.push({ taille, bord, mer, minX, minZ });
    }
  }
  const densite = lits / Math.max(1, terres);
  const largeurMediane = q(largeurs, .5);
  check('des rivières courent sur les terres',
    densite > 0.0012 && densite < 0.06 && plusGrosse >= 300 && plusEtendu >= 50
    && largeurMediane >= 3 && largeurMediane <= 9,
    `${(densite * 100).toFixed(2)} % des terres en lit · plus long cours ${plusGrosse} colonnes sur ${plusEtendu} cubes · largeur médiane ${largeurMediane}`);

  // Jonction à la mer jugée par **connectivité** : un cours d'eau est presque plat, une
  // descente gloutonne au plan d'eau le plus bas s'arrêtait au premier palier et annonçait
  // 0/14 cours joints là où le lit touchait bien la mer. Une composante qui touche le bord
  // de la fenêtre est tronquée — elle continue hors du champ sondé — et n'est pas comptée.
  // Seuls les vrais cours sont jugés : l'amorce d'un tracé sur deux colonnes ne peut pas
  // avoir d'exutoire. Le seuil de cent cinquante colonnes vient de la mesure, où les cours
  // continus en comptaient trois cent trente-neuf et quatre cent trente-sept, les amorces
  // une ou deux.
  const complets = cours.filter((c) => !c.bord && c.taille >= 150);
  const joints = complets.filter((c) => c.mer).length;
  const orphelins = complets.filter((c) => !c.mer);
  check('toute rivière aboutit à la mer',
    complets.length >= 2 && orphelins.length === 0,
    `${joints}/${complets.length} cours joints${orphelins.length ? ` — ${orphelins.length} suspendus, dont ${orphelins[0].taille} colonnes en (${orphelins[0].minX},${orphelins[0].minZ})` : ''}`);
}
{
  // Berges sableuses et lit sans végétation : l'eau contre de l'herbe se délite à l'œil,
  // et une souche dans le chenal ferait un barrage à trois cubes. Le sable est un
  // matériau du rivage : au-dessus de la ligne d'arbres une berge de montagne doit rester
  // rocheuse — exiger du sable à trente-cinq cubes d'altitude serait une faute de goût,
  // pas un correctif. Là-haut, seule compte l'absence de végétation dans l'eau.
  let testees = 0, horsSable = 0, plantees = 0;
  const exemples = [];
  // Même raison d'échelle que la section précédente : le lit occupe un quart de pour cent
  // des terres, et une boîte de trois cent soixante cubes posée sur un massif n'en
  // rencontrait plus assez pour juger quoi que ce soit (mesuré : 21 colonnes).
  for (let t = 0; t < 12000; t++) {
    const x = Math.floor(hashRoll(t, 31, t * 7, 777) * 1040) - 520;
    const z = Math.floor(hashRoll(t, 97, t * 11, 555) * 1040) - 520;
    const r = terrain.riverAt(x, z);
    if (!r) continue;
    testees++;
    const h = heightAt(x, z);
    // Strictement **sous** la ligne d'arbres : `surfaceFor` rend la roche à partir de
    // treeLine, donc juger h == treeLine demandait du sable là où le générateur pose la
    // pierre par définition — deux colonnes à trente-trois cubes, exactement la borne.
    if (r.d > r.demiLargeur && h > SEA && h < biomes.BIOMES.treeLine) {
      const revetement = biomes.surfaceFor(x, z, h).top;
      if (revetement !== BLOCK.SAND) {
        horsSable++;
        if (exemples.length < 3) exemples.push(`berge (${x},${z}) sol ${h} bloc ${revetement}`);
      }
    }
    if (r.d <= r.demiLargeur && biomes.treeAt(x, z)) {
      plantees++;
      if (exemples.length < 3) exemples.push(`arbre dans le lit (${x},${z})`);
    }
  }
  check('les berges sont sableuses et le lit nu',
    testees > 40 && horsSable === 0 && plantees === 0,
    `${horsSable} berge(s) hors sable sous la ligne d’arbres et ${plantees} arbre(s) dans l’eau sur ${testees} colonnes${exemples.length ? ` — ${exemples.join(' | ')}` : ''}`);
}

// ============================================================ 4ter. les ponts sur l'eau
{
  // Une avenue coupée par l'eau ne doit pas finir en impasse : elle est portée par un
  // tablier sur piles, **l'eau restant libre dessous** — combler la travée ferait une
  // digue qui couperait le cours. Demandé le 2026-11-08 : « il faudrait faire des ponts
  // au-dessus de l'eau, des viaducs, au lieu de couper la route », arbitré en rivières
  // et bras marins étroits (la haute mer garde son rivage) avec piles dans le lit.
  const V = village.VILLAGE;
  const R = 22;
  const half = V.roadHalf + V.kerb;
  const colonne = (axis, k, i, o) => axis === 'x'
    ? { wx: i, wz: k * V.roadSpacing + o }
    : { wx: k * V.roadSpacing + o, wz: i };
  const mouille = (axis, k, i) => {
    for (let o = -half; o <= half; o++) {
      const c = colonne(axis, k, i, o);
      if (heightAt(c.wx, c.wz) < Math.max(SEA, waterTop(c.wx, c.wz))) return true;
    }
    return false;
  };

  // Monde reconstitué comme le jeu le remplit : sol, eau jusqu'au plan local, puis les
  // trois estampages. C'est le tampon écrit qui prouve que le chenal n'est pas bouché.
  const tampons = new Map();
  const monde = (cx, cz) => {
    const cle = `${cx},${cz}`;
    let d = tampons.get(cle);
    if (d) return d;
    d = emptyData();
    for (let lx = 0; lx < CHUNK_SIZE; lx++) for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const x = cx * CHUNK_SIZE + lx, z = cz * CHUNK_SIZE + lz;
      const h = heightAt(x, z), top = Math.max(SEA, waterTop(x, z));
      for (let y = 0; y <= Math.min(h, CHUNK_HEIGHT - 1); y++) d[idx(lx, y, lz)] = y === h ? BLOCK.SAND : BLOCK.STONE;
      for (let y = h + 1; y <= Math.min(top, CHUNK_HEIGHT - 1); y++) d[idx(lx, y, lz)] = BLOCK.WATER;
    }
    village.stampRoads(d, cx, cz);
    village.stampBuilding(d, cx, cz);
    village.stampStructures(d, cx, cz);
    tampons.set(cle, d);
    return d;
  };

  let franchissables = 0, franchis = 0, canaux = 0;
  let sansTablier = 0, chenauxBouches = 0, gardesCourtes = 0, approchesNoyees = 0;
  let archesJugees = 0, archesCintrees = 0;
  // Une liste par contrôle : trois « sans pont » noieraient autrement le détail d'un
  // chenal comblé ou d'un tablier absent.
  const exemplesSansPont = [], exemplesGarde = [], exemplesApproche = [];
  const exemplesTablier = [], exemplesChenal = [], exemplesArche = [];

  /**
   * Les coupures sont énumérées depuis le **terrain**, non depuis les centres de maille
   * du générateur : juger l'eau aux seuls points d'échantillonnage de `computeWaterBridge`
   * reviendrait à ignorer d'office tout ce que le générateur ne propose pas lui-même —
   * et c'est précisément le défaut qui laissait des avenues en impasse (mesuré le
   * 2026-11-09 : sept traversées franchissables sur vingt-trois jamais proposées).
   */
  const coupures = [];
  for (const axis of ['x', 'z']) {
    const kLo = -Math.ceil(R * CHUNK_SIZE / V.roadSpacing), kHi = -kLo;
    const LIM = R * CHUNK_SIZE;
    const own = (V.bridgeCell >> 1) - 1;
    for (let k = kLo; k <= kHi; k++) {
      let i = -LIM;
      while (i <= LIM) {
        if (!mouille(axis, k, i)) { i++; continue; }
        let j = i;
        while (j + 1 <= LIM && mouille(axis, k, j + 1)) j++;
        // Traversée franche : une rive sèche des deux côtés. Un cours qui longe
        // l'avenue, ou que la fenêtre du contrôle coupe en pleine eau, n'est pas une
        // traversée — il n'a pas de rive d'en face à rejoindre.
        const franche = !mouille(axis, k, i - 1) && !mouille(axis, k, j + 1);
        const largeur = j - i + 1;
        if (franche && largeur >= V.waterMinSpan && largeur <= V.waterMaxSpan) {
          const seg = Math.round(((i + j) / 2 - (V.bridgeCell >> 1)) / V.bridgeCell);
          const centre = seg * V.bridgeCell + (V.bridgeCell >> 1);
          // La maille à qui appartient la coupure, telle que le générateur l'arbitre.
          if (Math.abs((i + j) / 2 - centre) <= own) coupures.push({ axis, k, seg, ds: i, de: j });
        }
        i = j + 1;
      }
    }
  }

  for (const { axis, k, seg, ds, de } of coupures) {
    franchissables++;
    const b = village.bridgeAt(axis, k, seg);
    if (!b || !b.surEau || b.from > ds || b.to < de) {
      if (exemplesSansPont.length < 3) exemplesSansPont.push(`${axis}${k}@${seg} · ${de - ds + 1} colonnes d’eau sans pont`);
      continue;
    }
    franchis++;
    let eau = SEA;
    for (let i = b.ds; i <= b.de; i++) {
      for (let o = -b.half; o <= b.half; o++) {
        const c = colonne(axis, k, i, o);
        eau = Math.max(eau, Math.max(SEA, waterTop(c.wx, c.wz)));
      }
    }
    if (b.deckY - eau < V.waterFreeboard) {
      gardesCourtes++;
      if (exemplesGarde.length < 3) exemplesGarde.push(`tablier ${b.deckY} à ${b.deckY - eau} cube(s) de l’eau (${axis}${k}@${seg})`);
    }
    for (const [i, niveau] of b.ramp) {
      const c = colonne(axis, k, i, 0);
      const plan = Math.max(SEA, waterTop(c.wx, c.wz));
      if (heightAt(c.wx, c.wz) < plan || niveau < plan + 1
        || b.deckY - niveau > V.waterMaxRamp) {
        approchesNoyees++;
        if (exemplesApproche.length < 3) exemplesApproche.push(`approche ${i} à ${niveau} pour un plan d’eau à ${plan}`);
        break;
      }
    }
    // Sous la **clé** de l'arc — la colonne où l'ouverture est la plus haute — entre le
    // lit et le soffite, il ne doit y avoir que de l'eau et du vide : un bloc posé là est
    // une digue. Juger la première travée venue jugerait les naissances, qui sont de la
    // maçonnerie par destination (mesuré le 2026-11-09 : le contrôle accusait de « chenal
    // comblé » un pont qui venait précisément de recevoir ses arcs). La colonne jugée est
    // sur l'axe **et** mouillée — au droit d'un banc sec il n'y a pas de chenal à ouvrir,
    // et le sol naturel qui y règne n'est pas une digue.
    let mi = null, cle = null, naissances = 0;
    for (let i = b.ds; i <= b.de; i++) {
      const c0 = colonne(axis, k, i, 0);
      if (heightAt(c0.wx, c0.wz) >= Math.max(SEA, waterTop(c0.wx, c0.wz))) continue;
      const u = village.bridgeUnderside(b, i);
      if (u.pier) continue;
      if (cle === null || u.open > cle) { cle = u.open; mi = i; }
      if (u.open < b.clearance) naissances++;
    }
    if (mi === null) continue;
    canaux++;
    archesJugees++;
    // Une travée se lit cintrée quand sa clé garde l'ouverture pleine et qu'au moins deux
    // colonnes voisines descendent sous le soffite : les naissances de l'arc.
    if (cle >= b.clearance && naissances >= 2) archesCintrees++;
    else if (exemplesArche.length < 3) {
      exemplesArche.push(`${axis}${k}@${seg} : ouverture max ${cle} pour ${b.clearance} de garde, `
        + `${naissances} naissance(s) sous le soffite`);
    }
    const c = colonne(axis, k, mi, 0);
    const cx = Math.floor(c.wx / CHUNK_SIZE), cz = Math.floor(c.wz / CHUNK_SIZE);
    const data = monde(cx, cz);
    const lx = c.wx - cx * CHUNK_SIZE, lz = c.wz - cz * CHUNK_SIZE;
    const bloc = (y) => data[idx(lx, y, lz)];
    if (!REVETEMENTS_DE_VOIRIE.includes(bloc(b.deckY))) {
      sansTablier++;
      if (exemplesTablier.length < 3) exemplesTablier.push(`pas de chaussée au tablier ${b.deckY} (${c.wx},${c.wz}) mais bloc ${bloc(b.deckY)}`);
    }
    // Ce qui fait une digue, ce n'est pas la maçonnerie de l'arc — elle ne descend
    // jamais à ou sous le plan d'eau, c'est sa règle — mais tout cube plein posé **dans
    // la colonne d'eau**. Chaque colonne mouillée de la travée est donc jugée jusqu'au
    // plan d'eau inclus, et non jusqu'au soffite de la colonne jugée : mesuré le
    // 2026-11-09, juger sous une simple naissance d'arc faisait passer l'épaule du pont
    // pour un comblement. Seules les piles ont le droit de tremper.
    let noye = null;
    for (let i = b.ds; i <= b.de && !noye; i++) {
      if (village.bridgeUnderside(b, i).pier) continue;
      const cc = colonne(axis, k, i, 0);
      if (heightAt(cc.wx, cc.wz) >= Math.max(SEA, waterTop(cc.wx, cc.wz))) continue;
      const dcx = Math.floor(cc.wx / CHUNK_SIZE), dcz = Math.floor(cc.wz / CHUNK_SIZE);
      const dd = monde(dcx, dcz);
      const dlx = cc.wx - dcx * CHUNK_SIZE, dlz = cc.wz - dcz * CHUNK_SIZE;
      const bl = (y) => dd[idx(dlx, y, dlz)];
      for (let y = Math.max(heightAt(cc.wx, cc.wz) + 1, 0); y <= b.floorH; y++) {
        if (bl(y) !== BLOCK.WATER && bl(y) !== BLOCK.AIR) {
          noye = ` (${cc.wx},${cc.wz}) à y=${y} : bloc ${bl(y)}`;
          break;
        }
      }
    }
    if (noye) {
      chenauxBouches++;
      if (exemplesChenal.length < 3) exemplesChenal.push(`chenal comblé${noye}`);
    }
  }
  check('une avenue coupée par l’eau est portée par un pont',
    franchissables >= 8 && franchis >= Math.round(franchissables * 0.6),
    `${franchis}/${franchissables} coupures franchies sur ${R * 2 + 1}² tronçons`
    + `${exemplesSansPont.length ? ` — ${exemplesSansPont.join(' | ')}` : ''}`);
  check('le tablier garde sa hauteur au-dessus de l’eau', gardesCourtes === 0,
    `${gardesCourtes} tablier(s) à moins de ${V.waterFreeboard} cubes du plan d’eau`
    + `${exemplesGarde.length ? ` — ${exemplesGarde.join(' | ')}` : ''}`);
  check('le chenal reste libre sous le tablier',
    canaux >= 4 && sansTablier === 0 && chenauxBouches === 0 && approchesNoyees === 0,
    `${canaux} travée(s) jugée(s) : ${sansTablier} tablier(s) absent(s), ${chenauxBouches} chenal(aux) `
    + `comblé(s), ${approchesNoyees} approche(s) dans l’eau`
    + `${exemplesTablier.length + exemplesChenal.length + exemplesApproche.length ? ' — '
      + [...exemplesTablier, ...exemplesChenal, ...exemplesApproche].join(' | ') : ''}`);
  check('les ponts sur l’eau portent des arches',
    archesJugees >= 4 && archesCintrees >= Math.round(archesJugees * 0.8),
    `${archesCintrees}/${archesJugees} travée(s) cintrée(s) — clé à ouverture pleine et naissances `
    + `descendant sous le soffite`
    + `${exemplesArche.length ? ' — ' + exemplesArche.join(' | ') : ''}`);
}

// ============================================================ 5. déterminisme
{
  const data1 = emptyData();
  const data2 = emptyData();
  for (const etape of ['stampRoads', 'stampBuilding', 'stampStructures']) {
    village[etape](data1, 3, -5);
    village[etape](data2, 3, -5);
  }
  let identique = data1.length === data2.length;
  for (let i = 0; identique && i < data1.length; i++) if (data1[i] !== data2[i]) identique = false;
  check('le littoral se régénère à l’identique', identique);
  check('changer la graine déplace le rivage', (() => {
    const autre = createVillageGen({
      BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt, roll: hashRoll,
      saltBase: ((777 * 7919) | 0) ^ 0x5eed, seaLevel: SEA,
    });
    const signature = (g) => {
      const vus = [];
      for (let cx = -4; cx <= 4; cx++) for (let cz = -4; cz <= 4; cz++) {
        vus.push(g.buildingAt(cx, cz).map((p) => `${cx},${cz}:${p.x0},${p.z0},${p.w}x${p.d}`).join(';'));
      }
      return vus.join('|');
    };
    return signature(autre) !== signature(village);
  })());
}

// ============================================================ 6. dans le navigateur
const { browser, page, consoleErrors } = await openGame(URL);

const etat = () => page.evaluate(() => {
  const mc = window.__mc;
  return {
    feet: mc.feetY(), vy: mc.player.velocity.y, onGround: mc.player.onGround,
    nage: mc.player.nage, sousLEau: mc.player.sousLEau,
    x: mc.camera.position.x, z: mc.camera.position.z,
  };
});

const teleporte = (x, pieds, z) => page.evaluate(({ x, pieds, z }) => {
  const mc = window.__mc;
  mc.camera.position.set(x, pieds + 1.62, z);
  mc.player.velocity.set(0, 0, 0);
  mc.player.flyMode = false;
  mc.releaseAll();
  mc.streamAll();
  for (let i = 0; i < 20; i++) mc.step(1 / 120);
  return { feet: mc.feetY(), nage: mc.player.nage };
}, { x, pieds, z });

const avancer = (frames, dt = 1 / 60) => page.evaluate(({ frames, dt }) => {
  const mc = window.__mc;
  for (let i = 0; i < frames; i++) mc.step(dt);
  return true;
}, { frames, dt });

/**
 * Sortir de l'eau — en marchant, ou en montant sur Espace. Ce que l'on juge, c'est que le
 * joueur se retrouve **au sec**, pas qu'il ait touché la colonne désignée par la recherche à
 * la spirale : la berge la plus haute peut être à trente cubes (cinq secondes de nage n'y
 * suffisent pas) ou derrière un ressaut que le pas d'un cube ne franchit pas, et un joueur
 * qui ressort vingt cubes plus loin est sorti de l'eau. Plusieurs caps sont donc courus
 * depuis le même point d'eau et le meilleur garde la main — la règle déjà employée pour la
 * vitesse de nage. Le départ est remis à chaque cap : sans cela, une sortie réussie au
 * premier cap masquerait sept noyades.
 */
async function sortieEau({ x, z, y, caps, frames = 600, saut = false }) {
  let meilleur = null;
  let reussis = 0;
  for (const cap of caps) {
    await page.evaluate(({ x, z, y, cap }) => {
      const mc = window.__mc;
      mc.camera.position.set(x + 0.5, y, z + 0.5);
      mc.player.velocity.set(0, 0, 0);
      mc.player.flyMode = false;
      mc.streamAll();
      mc.look(cap, 0);
      mc.releaseAll();
    }, { x, z, y, cap });
    await page.evaluate((a) => {
      window.__mc.press('KeyW');
      if (a.saut) window.__mc.press('Space');
    }, { saut });
    await avancer(frames);
    await page.evaluate(() => window.__mc.releaseAll());
    await avancer(30);                   // repose les touches : Espace tenu ferait échantillonner
    const s = await etat();               // le joueur en l'air alors qu'il est sur la berge
    const dist = Math.hypot(s.x - (x + 0.5), s.z - (z + 0.5));
    // Au sec, et pas n'importe où : à moins de soixante cubes du point d'eau, on est encore
    // dans le pays que la nappe borde. Sans cette borne, un joueur charrié hors du monde
    // passerait pour un nageur sorti de l'eau.
    const sec = s.onGround && !s.nage && !s.sousLEau && dist >= 2 && dist <= 60;
    if (sec) reussis++;
    if (!meilleur || (sec && !meilleur.sec)) meilleur = { ...s, sec, cap, dist };
  }
  return { meilleur, reussis, tries: caps.length };
}

const SEA_B = await page.evaluate(() => window.__mc.SEA_LEVEL);
check('le navigateur connaît la même ligne de flottaison que le relief', SEA_B === SEA,
  `jeu ${SEA_B}, suites ${SEA}`);

// Un bassin assez profond à portée : on cherche une colonne noyée de 4 cubes ou plus.
// Les colonnes sont jugées à leurs coordonnées entières — c'est celles que la génération
// des tronçons utilise ; sonder au centre de la colonne répond une valeur qui peut
// différer de deux cubes du cube réellement posé.
const site = await page.evaluate((SEA) => {
  const mc = window.__mc;
  const px = Math.round(mc.camera.position.x), pz = Math.round(mc.camera.position.z);
  let profond = null, bord = null;
  for (let r = 4; r <= 700 && (!profond || !bord); r += 3) {
    for (let a = 0; a < 24; a++) {
      const x = Math.round(px + Math.cos(a / 24 * Math.PI * 2) * r);
      const z = Math.round(pz + Math.sin(a / 24 * Math.PI * 2) * r);
      const h = mc.getTerrainHeight(x, z);
      if (!profond && h <= SEA - 4) profond = { x, z, sol: h };
      if (!bord && h === SEA - 1) {
        // Haut-fond adossé à une berge d'un seul cube : c'est la sortie que l'on veut
        // éprouver — deux cubes de ressaut relèveraient du saut, pas de la nage.
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (mc.getTerrainHeight(x + dx, z + dz) === SEA + 1) {
            bord = { x, z, sol: h, sx: x + dx, sz: z + dz };
            break;
          }
        }
      }
      if (profond && bord) break;
    }
  }
  return { profond, bord };
}, SEA);

check('une mer est accessible autour du point d’apparition', !!(site && site.profond && site.bord),
  site ? `pleine eau ${site.profond && `${site.profond.x},${site.profond.z}`} · haut-fond ${site.bord && `${site.bord.x},${site.bord.z}`}` : 'aucune colonne noyée trouvée');

if (site && site.profond) {
  const { x, z, sol } = site.profond;
  const eau = await page.evaluate(({ x, z, sol, SEA }) => {
    const mc = window.__mc;
    mc.camera.position.set(x + 0.5, SEA + 2, z + 0.5);
    mc.streamAll();
    const auDessus = [];
    for (let y = sol + 1; y <= SEA + 2; y++) auDessus.push(mc.world.getBlock(x, y, z));
    return {
      auDessus, sol: mc.world.getBlock(x, sol, z), SEA,
      fond: mc.world.getBlock(x, sol, z),
    };
  }, { x, z, sol, SEA });
  const WATER = 7, AIR = 0, SAND = 6;
  const colonneOk = eau.auDessus.slice(0, SEA - sol).every((b) => b === WATER)
    && eau.auDessus.slice(SEA - sol + 1).every((b) => b === AIR);
  check('l’eau remplit la colonne jusqu’à la ligne de flottaison', colonneOk,
    `du sol ${sol} à ${SEA} : ${eau.auDessus.join(',')} (attendu ${WATER} jusqu'à ${SEA}, puis ${AIR})`);
  check('le plancher de la mer est du sable', eau.fond === SAND, `bloc ${eau.fond} sous l’eau`);

  // Flottaison : lâché juste au-dessus de la ligne, le corps doit s'y asseoir et n'y
  // plus bouger, la tête hors de l'eau. Le rappel tout-ou-rien d'avance orbitait autour
  // de l'équilibre sans jamais s'y poser — le « petit tremblement » perçu en surface,
  // mesuré ±0,016 cube à ~12 Hz. Le seuil d'amplitude est donc serré à dessein : un
  // vert obtenu en le laissant large ne prouverait rien contre le rebond.
  await teleporte(x + 0.5, SEA + 0.5, z + 0.5);
  await avancer(180, 1 / 60);
  const flotte = await etat();
  check('on flotte à la surface, la tête hors de l’eau',
    flotte.nage && Math.abs(flotte.feet - SEA) <= 0.35 && !flotte.sousLEau,
    `pieds ${flotte.feet.toFixed(2)}, attendu ≈ ${SEA} · nage=${flotte.nage} tête sous l'eau=${flotte.sousLEau}`);

  const tenue = await page.evaluate(() => {
    const mc = window.__mc;
    const ys = [], vys = [];
    for (let i = 0; i < 180; i++) { mc.step(1 / 60); ys.push(mc.feetY()); vys.push(Math.abs(mc.player.velocity.y)); }
    return { ptp: Math.max(...ys) - Math.min(...ys), vyMax: Math.max(...vys) };
  });
  // Ce qui se juge, c'est ce que le joueur voit : une amplitude de corps et une vitesse
  // verticale. L'ancien rappel tout-ou-rien laissait ±0,016 cube à ~12 Hz avec des
  // vitesses de ±0,4 cube/s ; compter des inversions de signe aurait laissé passer un
  // bruit d'arrondi ou manqué un vrai rebond lent.
  check('la surface est tenue sans trembler', tenue.ptp <= 0.01 && tenue.vyMax <= 0.05,
    `amplitude ${tenue.ptp.toFixed(4)} cube, pointe verticale ${tenue.vyMax.toFixed(3)} cube/s sur 3 s`);

  // Couler sur Majuscule, remonter sur Espace. Espace tenu finit par faire sortir de
  // l'eau : on le tient jusqu'à entrer dans le bandeau de flottaison, puis on juge le
  // retour à la ligne une fois la poussée relâchée.
  await page.evaluate(() => window.__mc.press('ShiftLeft'));
  await avancer(90, 1 / 60);
  await page.evaluate(() => window.__mc.releaseAll());
  const enfonce = await etat();
  await page.evaluate(() => window.__mc.press('Space'));
  for (let i = 0; i < 12; i++) {
    await avancer(15, 1 / 60);
    if ((await etat()).feet > SEA - 1.5) break;
  }
  await page.evaluate(() => window.__mc.releaseAll());
  await avancer(90, 1 / 60);
  const remonte = await etat();
  check('Majuscule fait couler et Espace remonter',
    enfonce.feet < flotte.feet - 1.2 && Math.abs(remonte.feet - SEA) <= 0.8,
    `ligne ${SEA} · au repos ${flotte.feet.toFixed(2)} · plongé ${enfonce.feet.toFixed(2)} · remonté ${remonte.feet.toFixed(2)}`);

  // Le fond se touche et s'habite. L'ancien éjecteur — 4,6 cubes/s de remontée dès
  // qu'on lâchait Majuscule — rendait le lit impraticable : on vérifie ici qu'une
  // plongée y mène, et qu'on y reste sans rien tenir.
  await teleporte(x + 0.5, SEA + 0.5, z + 0.5);
  const fond = await page.evaluate(() => {
    const mc = window.__mc;
    mc.press('ShiftLeft');
    let t = 0;
    while (t < 900 && !mc.player.onGround) { mc.step(1 / 60); t++; }
    mc.releaseAll();
    const bx = Math.floor(mc.camera.position.x), bz = Math.floor(mc.camera.position.z);
    let lit = null;
    for (let y = Math.floor(mc.feetY()); y >= 0; y--) {
      const b = mc.world.getBlock(bx, y, bz);
      if (b !== 0 && b !== 7) { lit = y; break; }
    }
    return { pieds: mc.feetY(), lit, images: t, auSol: mc.player.onGround, nage: mc.player.nage };
  });
  check('on touche le fond en plongeant',
    fond.lit !== null && fond.auSol && fond.nage && Math.abs(fond.pieds - (fond.lit + 1)) <= 0.15,
    `pieds ${fond.pieds.toFixed(2)} sur le lit ${fond.lit} · ${fond.images} images pour l’atteindre`);
  await avancer(120, 1 / 60);
  const pose = await etat();
  check('on reste au fond sans rien tenir',
    fond.lit !== null && pose.nage && Math.abs(pose.feet - (fond.lit + 1)) <= 0.3,
    `pieds ${pose.feet.toFixed(2)} sur le lit ${fond.lit} après 2 s sans touche`);

  // L'assiette se règle au clavier : + enfonce le corps au repos, − le remonte, et la
  // valeur tient tant qu'on nage. On juge le niveau d'équilibre atteint, pas la vitesse
  // avec laquelle le corps y parvient. Le corps est lâché **à la ligne** et non sur le
  // lit : posé sur le sable il y reste (c'est ce que veut « rester au fond ») et ne
  // répondrait plus aux touches.
  await teleporte(x + 0.5, SEA + 0.5, z + 0.5);
  await avancer(180, 1 / 60);
  const repos = await etat();
  const luAssiette = () => page.evaluate(() => window.__mc.player.assiette);
  const assietteDefaut = await luAssiette();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Equal');
  await avancer(180, 1 / 60);
  const bas = await etat();
  const assietteBasse = await luAssiette();
  const bandeau = await page.evaluate(() => {
    const el = document.getElementById('swim-hint');
    return { on: el.classList.contains('on'), texte: el.textContent };
  });
  for (let i = 0; i < 12; i++) await page.keyboard.press('Minus');
  await avancer(180, 1 / 60);
  const haut = await etat();
  const assietteHaute = await luAssiette();
  await page.keyboard.press('Minus');
  const assiettePlancher = await luAssiette();   // borné : insister ne descend pas plus
  check('+ et − règlent l’assiette de flottaison',
    assietteBasse > assietteDefaut + 0.5 && bas.feet < repos.feet - 0.5
    && assietteHaute < assietteDefaut - 0.3 && haut.feet > bas.feet + 0.5
    && !haut.sousLEau && assiettePlancher === assietteHaute
    && bandeau.on && bandeau.texte.includes('assiette'),
    `assiette ${assietteDefaut.toFixed(1)} → ${assietteBasse.toFixed(1)} → ${assietteHaute.toFixed(1)} (bornée) · `
    + `pieds au repos ${repos.feet.toFixed(2)} → ${bas.feet.toFixed(2)} → ${haut.feet.toFixed(2)}`);
  await page.evaluate(() => { window.__mc.player.assiette = 1; });   // remis au défaut pour la suite

  // La nage freine. On compare la vitesse horizontale de régime plutôt qu'une
  // distance : une souche sur la trajectoire fausserait la seconde, pas la première.
  // Quatre caps sont courus à chaque fois et le meilleur garde la main — un piéton
  // bloqué face à un mur ne prouverait rien contre un nageur lancé en pleine eau.
  // Seules les images où le joueur est réellement dans le milieu jugé comptent : un
  // nageur qui bute sur un haut-fond et sort de l'eau passerait instantanément à la
  // vitesse de marche, et ce pic-là n'est pas une vitesse de nage.
  const vitesse = ({ x, z, pieds, dansLau }) => page.evaluate(({ x, z, pieds, dansLau }) => {
    const mc = window.__mc;
    let meilleur = 0;
    for (const cap of [0, 90, 180, 270]) {
      mc.camera.position.set(x + 0.5, pieds, z + 0.5);
      mc.player.velocity.set(0, 0, 0);
      mc.player.flyMode = false;
      mc.streamAll();
      mc.look(cap, 0);
      mc.releaseAll();
      mc.press('KeyW');
      let pic = 0;
      for (let i = 0; i < 24; i++) {
        mc.step(1 / 60);
        if (mc.player.nage !== dansLau) continue;
        pic = Math.max(pic, Math.hypot(mc.player.velocity.x, mc.player.velocity.z));
      }
      mc.releaseAll();
      meilleur = Math.max(meilleur, pic);
    }
    return { pic: meilleur };
  }, { x, z, pieds, dansLau });

  const nageRapide = await vitesse({ x, z, pieds: SEA, dansLau: true });
  const sec = await page.evaluate(() => {
    const mc = window.__mc;
    const SEA = mc.SEA_LEVEL;
    const bx = Math.round(mc.camera.position.x), bz = Math.round(mc.camera.position.z);
    for (let r = 1; r < 600; r += 2) {
      for (let a = 0; a < 24; a++) {
        const cx = bx + Math.round(Math.cos(a / 24 * 6.2832) * r);
        const cz = bz + Math.round(Math.sin(a / 24 * 6.2832) * r);
        const h = mc.getTerrainHeight(cx, cz);
        if (h >= SEA + 2 && h <= SEA + 4) return { x: cx, z: cz, pieds: h + 1.01 };
      }
    }
    return null;
  });
  const aPied = sec ? await vitesse({ ...sec, dansLau: false }) : { pic: 0 };
  check('nager est plus lent que marcher', nageRapide.pic > 0.5 && aPied.pic > nageRapide.pic * 1.3,
    `vitesse de régime ${nageRapide.pic.toFixed(1)} cube/s nagé contre ${aPied.pic.toFixed(1)} marché`);
}

if (site && site.bord) {
  // Sortir de l'eau en marchant : l'invariant que rien ne remplace — un joueur qui
  // entre dans la mer doit pouvoir en ressortir sans sauter ni voler.
  const { x, z, sx, sz } = site.bord;
  // Le cap regardé fixe la direction de marche : caméra orientée -Z à yaw 0, on vise
  // la berge avec θ = atan2(−Δx, −Δz). Autour de ce cap, quatre autres sont courus :
  // juger un seul relèverait du tirage de la loterie, non d'une invariant du monde.
  const cap = Math.atan2(-(sx - x), -(sz - z)) * 180 / Math.PI;
  const sortie = await sortieEau({
    x, z, y: SEA, caps: [cap, cap + 40, cap - 40, cap + 90, cap - 90], frames: 600,
  });
  const approche = Math.hypot(sortie.meilleur.x - (sx + 0.5), sortie.meilleur.z - (sz + 0.5));
  check('on sort de l’eau en marchant',
    sortie.meilleur.sec && sortie.meilleur.feet >= SEA + 0.9,
    `${sortie.reussis}/${sortie.tries} cap(s) mènent au sec · meilleur pieds ${sortie.meilleur.feet.toFixed(2)}`
    + ` au sol=${sortie.meilleur.onGround} nage=${sortie.meilleur.nage}`
    + ` · à ${(approche).toFixed(1)} cube de la berge visée`);

  // Teinte d'immersion : la tête sous l'eau change l'image. On l'éprouve en pleine
  // eau — poser le joueur sous la ligne au-dessus d'un haut-fond d'un cube ne le
  // noierait pas, cela l'enterrerait dans le sable.
  const mouille = site.profond || site.bord;
  await page.evaluate(({ x, z, SEA }) => {
    const mc = window.__mc;
    mc.camera.position.set(x + 0.5, SEA - 1.4, z + 0.5);
    mc.player.velocity.set(0, 0, 0);
    for (let i = 0; i < 10; i++) mc.step(1 / 120);
  }, { x: mouille.x, z: mouille.z, SEA });
  await page.waitForTimeout(400);
  const teinte = await page.evaluate(() => ({
    voile: document.getElementById('underwater').classList.contains('on'),
    tete: window.__mc.player.sousLEau,
  }));
  check('la tête sous l’eau, l’image se voile', teinte.voile === true && teinte.tete === true,
    `tête sous l’eau=${teinte.tete} · classe « on » = ${teinte.voile}`);
}

{
  // Nager dans une rivière — et surtout en sortir. Le lit est cherché loin de la mer :
  // son plan d'eau est local et plus haut que la ligne de flottaison, c'est ce qui le
  // distingue d'une anse marine.
  const riv = await page.evaluate((SEA) => {
    const mc = window.__mc;
    const px = Math.round(mc.camera.position.x), pz = Math.round(mc.camera.position.z);
    // Le réseau est lâche (un cours tous les cent cinquante cubes environ) : la spirale
    // doit balayer large, et la berge se cherche à deux colonnes — avec des berges de huit
    // cubes de portée, le voisin immédiat est le plus souvent encore sous l'eau.
    for (let r = 20; r <= 1400; r += 3) {
      for (let a = 0; a < 48; a++) {
        const x = Math.round(px + Math.cos(a / 48 * Math.PI * 2) * r);
        const z = Math.round(pz + Math.sin(a / 48 * Math.PI * 2) * r);
        const lit = mc.riverAt(x, z);
        if (!lit || lit.d > lit.demiLargeur) continue;
        const top = mc.waterTopAt(x, z);
        if (top <= SEA) continue;                             // une anse marine, pas un cours
        for (let dx = -2; dx <= 2; dx++) {
          for (let dz = -2; dz <= 2; dz++) {
            if (mc.getTerrainHeight(x + dx, z + dz) >= top) {
              return { x, z, sx: x + dx, sz: z + dz, sol: mc.getTerrainHeight(x, z), top };
            }
          }
        }
      }
    }
    return null;
  }, SEA);
  check('une rivière se rencontre hors de la mer', !!riv,
    riv ? `lit (${riv.x},${riv.z}) · plan d’eau ${riv.top} · sol ${riv.sol}` : 'aucun lit trouvé autour du point d’apparition');

  if (riv) {
    const cap = Math.atan2(-(riv.sx - riv.x), -(riv.sz - riv.z)) * 180 / Math.PI;
    await page.evaluate(({ x, z, top }) => {
      const mc = window.__mc;
      mc.camera.position.set(x + 0.5, top - 0.6, z + 0.5);
      mc.player.velocity.set(0, 0, 0);
      mc.player.flyMode = false;
      mc.streamAll();
    }, riv);
    await avancer(90, 1 / 60);
    const nageRiv = await etat();
    check('on nage dans une rivière', nageRiv.nage === true && nageRiv.feet > riv.sol,
      `nage=${nageRiv.nage} · pieds ${nageRiv.feet.toFixed(2)} au-dessus du lit ${riv.sol}`);

    const sec = await sortieEau({
      x: riv.x, z: riv.z, y: riv.top - 0.6,
      caps: [cap, cap + 40, cap - 40, cap + 90, cap - 90], frames: 600,
    });
    check('on sort d’une rivière en marchant', sec.meilleur.sec,
      `${sec.reussis}/${sec.tries} cap(s) mènent au sec · meilleur pieds ${sec.meilleur.feet.toFixed(2)}`
      + ` pour un plan d’eau à ${riv.top} · au sol=${sec.meilleur.onGround} nage=${sec.meilleur.nage}`);

    // L'autre sortie annoncée par le HUD : Espace fait monter le corps. Un joueur pris
    // sur une berge raide doit pouvoir s'en extraire sans marcher.
    const grimpe = await sortieEau({
      x: riv.x, z: riv.z, y: riv.top - 0.6,
      caps: [cap, cap + 40, cap - 40, cap + 90, cap - 90], frames: 420, saut: true,
    });
    check('on sort d’une rivière en montant sur Espace', grimpe.meilleur.sec,
      `${grimpe.reussis}/${grimpe.tries} cap(s) mènent au sec · meilleur pieds ${grimpe.meilleur.feet.toFixed(2)}`
      + ` pour un plan d’eau à ${riv.top} · au sol=${grimpe.meilleur.onGround} nage=${grimpe.meilleur.nage}`);
  }
}

check('aucune erreur console pendant la visite de la mer',
  !consoleErrors.some((e) => e.startsWith('pageerror')),
  consoleErrors.filter((e) => e.startsWith('pageerror')).slice(0, 2).join(' | '));

await browser.close();
process.exit(summary() ? 1 : 0);
