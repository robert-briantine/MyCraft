// Contrôle du module de biomes et de végétation : trois zones franches (forêt, plaine,
// désert), des arbres à tronc et couronne, et surtout une forêt **traversable** — le
// joueur ne franchit qu'un cube par colonne et mesure 1,80 cube, donc rien ne doit
// boucher l'air au-dessus du sol sauf le tronc lui-même, qui laisse toujours un passage
// à son côté. Le module est testé sans navigateur, comme celui du village.
// Usage: node tests/biomes.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReporter } from './browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { check, summary } = makeReporter();

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

const { createBiomeGen, BIOMES } = await loadPublicModule('public/js/biomes.js');

const CHUNK_SIZE = 16;
const CHUNK_HEIGHT = 64;
const BLOCK = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, WOOD: 4, LEAVES: 5, SAND: 6,
  COBBLE: 7, SNOW: 14, MOSS: 18,
};

function hashRoll(x, y, z, salt) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)
        ^ Math.imul(z | 0, 1274126177) ^ Math.imul(salt | 0, 2654435761);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// Relief du même gabarit que le jeu : plateaux ondulés entaillés de sillons creusés par
// un bruit plissé, sans Math.random() — deux exécutions comparent identiques.
const VALLEY_DEPTH = 16;
const MIN_GROUND = 6;
function heightAt(x, z) {
  const plateau = 29 + Math.round(3 * Math.sin(x / 131) + 3 * Math.cos(z / 109));
  const t = Math.min(1, Math.abs(
    Math.sin((x + z) / 52) + Math.cos((x - z) / 71) + 0.3 * Math.cos(z / 53),
  ) / 0.75);
  return Math.max(MIN_GROUND, plateau - Math.round(VALLEY_DEPTH * (1 - t * t * (3 - 2 * t))));
}

// Une voirie fictive, grille de 80 comme celle du village : rien ne doit pousser dessus.
const AVENUE = 80;
const surVoirie = (wx, wz) => {
  const restX = ((wx % AVENUE) + AVENUE) % AVENUE;
  const restZ = ((wz % AVENUE) + AVENUE) % AVENUE;
  return Math.min(restX, AVENUE - restX) <= 3 || Math.min(restZ, AVENUE - restZ) <= 3;
};

const makeGen = (opts = {}) => createBiomeGen({
  BLOCK, CHUNK_SIZE, CHUNK_HEIGHT,
  heightAt,
  roll: hashRoll,
  saltBase: 123 * 7919,
  isBlocked: surVoirie,
  ...opts,
});
const gen = makeGen();

const idx = (lx, y, lz) => lx + lz * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE;

/** Remplissage naturel d'un tronçon, tel que le jeu le construit avant la voirie. */
function remplir(g, cx, cz) {
  const data = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_HEIGHT);
  const baseX = cx * CHUNK_SIZE;
  const baseZ = cz * CHUNK_SIZE;
  for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const wx = baseX + lx;
      const wz = baseZ + lz;
      const h = heightAt(wx, wz);
      const sol = g.surfaceFor(wx, wz, h);
      for (let y = 0; y <= h; y++) {
        data[idx(lx, y, lz)] = y < h - 3 ? BLOCK.STONE : (y === h ? sol.top : sol.under);
      }
    }
  }
  g.stampVegetation(data, cx, cz);
  return data;
}

const bloc = (data, lx, y, lz) => (y < 0 || y >= CHUNK_HEIGHT || lx < 0 || lz < 0
  || lx >= CHUNK_SIZE || lz >= CHUNK_SIZE) ? BLOCK.STONE : data[idx(lx, y, lz)];

// ---------------------------------------------------------------------------
// 1. Trois zones, et des zones : elles se traversent, elles ne grésillent pas.
// ---------------------------------------------------------------------------
const CARRE = 26;                                  // 26×26 tronçons sondés
const compteur = { foret: 0, plaine: 0, desert: 0 };
let runs = [];
for (let cx = -CARRE; cx <= CARRE; cx++) {
  for (let cz = -CARRE; cz <= CARRE; cz++) {
    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;
    for (let lx = 0; lx < CHUNK_SIZE; lx += 2) {
      let courant = null;
      let longueur = 0;
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const b = gen.biomeAt(baseX + lx, baseZ + lz);
        if (b !== courant) {
          if (courant) runs.push(longueur);
          courant = b;
          longueur = 1;
        } else longueur++;
      }
      runs.push(longueur);
    }
  }
}
// Les parts se mesurent sur un carré de trois mille huit cents cubes, soit plusieurs
// mailles de la forêt macro (900 cubes) : juger une zone à l'échelle d'un océan sur
// huit cents cubes, c'est lire un seul tirage et l'appeler statistique — mesuré sur une
// telle fenêtre, 78 % de forêt là où la carte n'en porte qu'un cinquième.
const CARRE_PART = 120;
for (let cx = -CARRE_PART; cx <= CARRE_PART; cx++) {
  for (let cz = -CARRE_PART; cz <= CARRE_PART; cz++) {
    compteur[gen.biomeAt(cx * CHUNK_SIZE + 8, cz * CHUNK_SIZE + 8)]++;
  }
}
const total = compteur.foret + compteur.plaine + compteur.desert;
const part = (b) => compteur[b] / total;
runs.sort((a, b) => a - b);
const mediane = runs[Math.floor(runs.length / 2)];

check('les trois zones existent',
  part('foret') > BIOMES.forestMin && part('desert') > BIOMES.desertMin && part('plaine') > 0.2,
  `forêt ${(part('foret') * 100).toFixed(0)}% plaine ${(part('plaine') * 100).toFixed(0)}% `
  + `désert ${(part('desert') * 100).toFixed(0)}%`);
check('une zone se traverse à pied, elle ne grésille pas d’un cube à l’autre',
  mediane >= 8,
  `longueur médiane d’un tenant le long d’une colonne : ${mediane} cubes`);

// ---------------------------------------------------------------------------
// 1 bis. La forêt macro tient l'échelle d'un bassin marin — « ajoute des zones de la
//        même taille que les océans de forêt » : une nappe que le joueur traverse des
//        minutes durant sans changer de pays, non un damier de bouquets.
// ---------------------------------------------------------------------------
{
  const PAS = 8;
  const PORTee = 1600;
  const n = Math.floor(2 * PORTee / PAS) + 1;
  const cle = (i, j) => i * n + j;
  const masque = new Uint8Array(n * n);
  let sousFutaie = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (gen.grandeForet((i - n / 2) * PAS, (j - n / 2) * PAS)) {
        masque[cle(i, j)] = 1;
        sousFutaie++;
      }
    }
  }
  const vus = new Uint8Array(n * n);
  const file = [];
  let best = null;
  for (let s = 0; s < n * n; s++) {
    if (!masque[s] || vus[s]) continue;
    file.length = 0;
    file.push(s);
    vus[s] = 1;
    let minI = n, maxI = -1, minJ = n, maxJ = -1, taille = 0;
    while (file.length) {
      const c = file.pop();
      const i = Math.floor(c / n);
      const j = c % n;
      taille++;
      if (i < minI) minI = i;
      if (i > maxI) maxI = i;
      if (j < minJ) minJ = j;
      if (j > maxJ) maxJ = j;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const k = cle(ni, nj);
        if (!masque[k] || vus[k]) continue;
        vus[k] = 1;
        file.push(k);
      }
    }
    if (!best || taille > best.taille) {
      best = { taille, largeur: (maxI - minI + 1) * PAS, profondeur: (maxJ - minJ + 1) * PAS };
    }
  }
  check('la grande forêt tient l’échelle d’un bassin marin',
    !!best && best.largeur >= 150 && best.profondeur >= 150 && sousFutaie / (n * n) > 0.05,
    best ? `plus grande nappe ${best.largeur}×${best.profondeur} cubes · `
      + `${(sousFutaie / (n * n) * 100).toFixed(0)} % de la carte sous futaie imposée`
      : 'aucune grande forêt rencontrée');
}

// ---------------------------------------------------------------------------
// 2. Le revêtement suit la zone et l’altitude.
// ---------------------------------------------------------------------------
let sableAuDesert = 0;
let vusAuDesert = 0;
let mousseEnForet = 0;
let foretsSondees = 0;
let herbeEnPlaine = 0;
let plainesSondees = 0;
for (let k = 0; k < 4000; k++) {
  const x = (k * 37) % 1400 - 700;
  const z = (k * 53) % 1400 - 700;
  const h = heightAt(x, z);
  const b = gen.biomeAt(x, z);
  const sol = gen.surfaceFor(x, z, h);
  // Le sable est le revêtement du désert **sous l'étage rocheux** : un massif planté en
  // zone désertique reste de pierre et de neige, et c'est la section 7 qui le vérifie.
  if (b === 'desert' && h < BIOMES.treeLine) {
    vusAuDesert++;
    if (sol.top === BLOCK.SAND) sableAuDesert++;
  } else if (b === 'foret' && h > BIOMES.sandLine && h < BIOMES.treeLine) {
    foretsSondees++;
    if (sol.top === BLOCK.MOSS) mousseEnForet++;
  } else if (b === 'plaine' && h > BIOMES.sandLine && h < BIOMES.treeLine) {
    plainesSondees++;
    if (sol.top === BLOCK.GRASS) herbeEnPlaine++;
  }
  if (h >= BIOMES.snowLine) continue;
}
check('le désert est de sable', vusAuDesert > 50 && sableAuDesert === vusAuDesert,
  `${sableAuDesert}/${vusAuDesert} cellules désertiques`);
check('le sous-bois se tapisse de mousse', foretsSondees > 50 && mousseEnForet > foretsSondees * 0.1,
  `${mousseEnForet}/${foretsSondees} cellules de forêt moussue`);
check('la plaine reste de l’herbe', plainesSondees > 50 && herbeEnPlaine > plainesSondees * 0.8,
  `${herbeEnPlaine}/${plainesSondees} cellules de plaine herbeuse`);

// ---------------------------------------------------------------------------
// 3. Arbres : tronc et couronne, jamais de feuillage à hauteur d’homme.
// ---------------------------------------------------------------------------
const arbres = [];
for (let cx = -8; cx <= 8; cx++) {
  for (let cz = -8; cz <= 8; cz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wx = cx * CHUNK_SIZE + lx;
        const wz = cz * CHUNK_SIZE + lz;
        const a = gen.treeAt(wx, wz);
        if (a) arbres.push(a);
      }
    }
  }
}
check('la forêt porte des arbres, le désert non', (() => {
  const enForet = arbres.filter((a) => gen.biomeAt(a.x, a.z) === 'foret').length;
  const auDesert = arbres.filter((a) => gen.biomeAt(a.x, a.z) === 'desert').length;
  return enForet > 300 && auDesert === 0;
})(), `${arbres.length} arbres sur 289 tronçons`);

let troncCoupe = 0;
let feuilleTropBasse = 0;
let couronneAbsente = 0;
const cacheRemplissage = new Map();
function rempli(g, cx, cz) {
  const cle = `${cx},${cz}`;
  let d = cacheRemplissage.get(cle);
  if (!d) { d = remplir(g, cx, cz); cacheRemplissage.set(cle, d); }
  return d;
}
for (const a of arbres) {
  const data = rempli(gen, Math.floor(a.x / CHUNK_SIZE), Math.floor(a.z / CHUNK_SIZE));
  const lx = a.x - Math.floor(a.x / CHUNK_SIZE) * CHUNK_SIZE;
  const lz = a.z - Math.floor(a.z / CHUNK_SIZE) * CHUNK_SIZE;
  for (let y = a.sol + 1; y <= a.couronne; y++) {
    if (bloc(data, lx, y, lz) !== BLOCK.WOOD) troncCoupe++;
  }
  let feuilles = 0;
  // Le garde-tête se juge colonne par colonne : c'est le sol d'en dessous qui compte,
  // pas celui du pied de l'arbre — une couronne posée sur un versant survole un sol
  // plus haut d'un côté que de l'autre.
  for (let dx = -a.rayon - 1; dx <= a.rayon + 1; dx++) {
    for (let dz = -a.rayon - 1; dz <= a.rayon + 1; dz++) {
      const wx = a.x + dx;
      const wz = a.z + dz;
      const pied = heightAt(wx, wz);
      for (let y = a.sol + 1; y < CHUNK_HEIGHT; y++) {
        if (bloc(data, lx + dx, y, lz + dz) !== BLOCK.LEAVES) continue;
        feuilles++;
        if (y < pied + BIOMES.headroom) feuilleTropBasse++;
      }
    }
  }
  if (feuilles === 0) couronneAbsente++;
}
check('tout arbre a son tronc de bois du sol à sa couronne', troncCoupe === 0,
  `${troncCoupe} cube(s) de tronc manquant(s) sur ${arbres.length} arbres`);
check('tout arbre est couronné de feuilles', couronneAbsente === 0,
  `${couronneAbsente} arbre(s) sans feuillage`);
check('rien ne pousse à hauteur d’homme sous les arbres', feuilleTropBasse === 0,
  `${feuilleTropBasse} feuille(s) sous ${BIOMES.headroom} cubes de garde-tête`);

// ---------------------------------------------------------------------------
// 3 bis. Sous bois, l'arbre est plus grand que dans les villes — « dans les forêts met
//        des arbres plus grands que dans les villes ». Le verger qui borde les rues
//        reste le petit sujet d'avant ; la futaie doit le dépasser nettement, sinon la
//        forêt ne se lit pas comme un autre pays que la banlieue.
// ---------------------------------------------------------------------------
{
  const futaie = [];
  const verger = [];
  // Les souches ne tombent qu'en un point tiré de leur maille de quatre cubes : on
  // parcourt donc les mailles elles-mêmes, et l'on sonde leurs seize colonnes — la
  // moitié des appels ne sont que le refus immédiat de `treeAt`. L'échantillon court sur
  // près de trois mille cubes : à deux cents cubes près, on ne comparerait que la zone
  // où le hasard a mis la forêt (mesuré sur une telle fenêtre : deux sujets de plaine).
  const MAILLE = BIOMES.treeCell;
  for (let i = -350; i <= 350; i += 5) {
    for (let j = -350; j <= 350; j += 5) {
      for (let dx = 0; dx < MAILLE; dx++) {
        for (let dz = 0; dz < MAILLE; dz++) {
          const a = gen.treeAt(i * MAILLE + dx, j * MAILLE + dz);
          if (a) (a.futaie ? futaie : verger).push(a.tronc);
        }
      }
    }
  }
  const med = (l) => (l.length ? l.slice().sort((x, y) => x - y)[Math.floor(l.length / 2)] : 0);
  check('la futaie de forêt dépasse le verger des villes',
    futaie.length > 200 && verger.length > 40 && med(futaie) >= med(verger) + 3,
    `tronc médian : forêt ${med(futaie)} cubes (${futaie.length} sujets), `
    + `plaine ${med(verger)} cubes (${verger.length} sujets)`);
}

// ---------------------------------------------------------------------------
// 4. On se promène dans la forêt : l’air est libre partout sauf dans les troncs,
//    et un tronc trouvé en chemin a toujours un voisin où déborder. Une feuille est
//    solide dans ce jeu — compter dessus comme de l'air serait mentir au joueur.
// ---------------------------------------------------------------------------
let colonneBouchee = 0;
let troncSansPassage = 0;
let colonnesSondees = 0;
let troncsSondues = 0;
const exemplesBouches = [];
for (let cx = -10; cx <= 10; cx++) {
  for (let cz = -10; cz <= 10; cz++) {
    const data = rempli(gen, cx, cz);
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wx = cx * CHUNK_SIZE + lx;
        const wz = cz * CHUNK_SIZE + lz;
        if (gen.biomeAt(wx, wz) !== 'foret') continue;
        const h = heightAt(wx, wz);
        if (h <= BIOMES.sandLine || h >= BIOMES.snowLine) continue;
        const arbre = gen.treeAt(wx, wz);
        const libre = (dx, dz) => {
          const pied = heightAt(wx + dx, wz + dz);
          for (let y = pied + 1; y < pied + BIOMES.headroom; y++) {
            if (bloc(data, lx + dx, y, lz + dz) !== BLOCK.AIR) return false;
          }
          return true;
        };
        if (arbre) {
          troncsSondues++;
          const degage = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => libre(dx, dz));
          if (!degage) {
            troncSansPassage++;
            if (exemplesBouches.length < 3) exemplesBouches.push(`tronc (${wx},${wz})`);
          }
        } else {
          colonnesSondees++;
          if (!libre(0, 0)) {
            colonneBouchee++;
            if (exemplesBouches.length < 3) exemplesBouches.push(`colonne (${wx},${wz}) sol ${h}`);
          }
        }
      }
    }
  }
}
check('une colonne de forêt sur deux n’est pas bouchée par le feuillage',
  colonnesSondees > 500 && colonneBouchee === 0,
  `${colonneBouchee} colonne(s) obstruée(s) sur ${colonnesSondees}${exemplesBouches.length ? ' — ' + exemplesBouches.join(', ') : ''}`);
check('devant un tronc, on peut toujours passer à côté',
  troncsSondues > 100 && troncSansPassage === 0,
  `${troncSansPassage} tronc(s) sans voisin libre sur ${troncsSondues}`);

// ---------------------------------------------------------------------------
// 5. La voirie reste nette, et le monde se régénère à l’identique.
// ---------------------------------------------------------------------------
let arbreSurVoirie = 0;
let feuilleSurVoirie = 0;
for (let cx = -5; cx <= 5; cx++) {
  for (let cz = -5; cz <= 5; cz++) {
    const data = remplir(gen, cx, cz);
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        if (!surVoirie(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz)) continue;
        for (let y = 0; y < CHUNK_HEIGHT; y++) {
          const b = data[idx(lx, y, lz)];
          if (b === BLOCK.WOOD || b === BLOCK.LEAVES) feuilleSurVoirie++;
        }
      }
    }
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        // Même garde que la boucle précédente : ce que la suite juge, c'est la voirie.
        // Sans elle on comptait chaque arbre du carré exploré et le contrôle ne pouvait
        // passer que par chance — là où le hasard ne plantait rien près de l'origine.
        if (!surVoirie(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz)) continue;
        if (gen.treeAt(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz)) arbreSurVoirie++;
      }
    }
  }
}
check('rien ne pousse sur une avenue', arbreSurVoirie === 0 && feuilleSurVoirie === 0,
  `${arbreSurVoirie} souche(s), ${feuilleSurVoirie} cube(s) de végétation sur la voirie`);

const memeGen = makeGen();
let different = 0;
for (let cx = -3; cx <= 3; cx++) {
  for (let cz = -3; cz <= 3; cz++) {
    const a = remplir(gen, cx, cz);
    const b = remplir(memeGen, cx, cz);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) different++;
  }
}
check('le même monde se régénère cube pour cube', different === 0, `${different} cube(s) déplacé(s)`);

const autreGraine = makeGen({ saltBase: (999 * 7919) | 0 });
let deplaces = 0;
for (let cx = -3; cx <= 3; cx++) {
  for (let cz = -3; cz <= 3; cz++) {
    const a = remplir(gen, cx, cz);
    const b = remplir(autreGraine, cx, cz);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) deplaces++;
  }
}
check('changer la graine déplace la végétation', deplaces > 500, `${deplaces} cube(s) différents`);

// ---------------------------------------------------------------------------
// 6. Aux frontières de tronçon : une couronne née du tronçon voisin déborde ici,
//    cube pour cube, sinon les arbres seraient tranchés le long des coutures.
// ---------------------------------------------------------------------------
let debordements = 0;
let manquants = 0;
const exemplesCouture = [];
for (const a of arbres) {
  const cx = Math.floor(a.x / CHUNK_SIZE);
  const cz = Math.floor(a.z / CHUNK_SIZE);
  for (let dy = 0; dy <= 2; dy++) {
    const y = a.couronne + dy;
    if (y >= CHUNK_HEIGHT) break;
    const rayon = dy === 2 ? Math.max(1, a.rayon - 1) : a.rayon;
    for (let dx = -rayon - 1; dx <= rayon + 1; dx++) {
      for (let dz = -rayon - 1; dz <= rayon + 1; dz++) {
        const wx = a.x + dx;
        const wz = a.z + dz;
        const nx = Math.floor(wx / CHUNK_SIZE);
        const nz = Math.floor(wz / CHUNK_SIZE);
        if (nx === cx && nz === cz) continue;          // reste à la maison
        // On n'exige que le cœur de la couronne : au delà du rayon, le générateur rogne
        // les angles au tirage, et un cube rogné n'est pas un cube manquant.
        if (Math.abs(dx) + Math.abs(dz) > rayon) continue;
        debordements++;
        const data = rempli(gen, nx, nz);
        const b = bloc(data, wx - nx * CHUNK_SIZE, y, wz - nz * CHUNK_SIZE);
        if (b === BLOCK.AIR) {
          manquants++;
          if (exemplesCouture.length < 3) {
            exemplesCouture.push(`(${wx},${wz}) y=${y} attendu depuis (${a.x},${a.z})`);
          }
        }
      }
    }
  }
}
check('une couronne née hors du tronçon déborde dedans', debordements > 100,
  `${debordements} cube(s) de feuillage écrits hors du tronçon de la souche`);
check('les couronnes ne se coupent pas aux frontières de tronçon', manquants === 0,
  `${manquants} cube(s) absent(s) du côté voisin${exemplesCouture.length ? ' — ' + exemplesCouture.join(', ') : ''}`);

// ---------------------------------------------------------------------------
// 7. La montagne : étages de roche et de neige, et un sommet qui se gravit à pied.
//    Jugé sur le VRAI relief du jeu — `terrain.js` et le bruit partagé — et non sur le
//    relief synthétique des sections ci-dessus : ce sont les chiffres du monde que le
//    joueur parcourt qu'il faut tenir.
// ---------------------------------------------------------------------------
const { SimplexNoise } = await loadPublicModule('public/js/noise.js');
const { createTerrain } = await loadPublicModule('public/js/terrain.js');
// La hauteur du MONDE du jeu (`game.js`, CHUNK_HEIGHT = 80), non celle des tampons de
// tronçon ci-dessus. Le plafond du relief se déduit de cette valeur : à 64, toute la
// section ne voyait que des sommets à cinquante-six cubes et jugerait infranchissable un
// pays alpin dont le joueur ne voit jamais les crêtes à soixante-six.
const HAUTEUR_MONDE = 80;
const monde = createTerrain({ noise: new SimplexNoise(42), chunkHeight: HAUTEUR_MONDE });
const memoMonde = new Map();
const rel = (x, z) => {
  const cle = `${x},${z}`;
  let v = memoMonde.get(cle);
  if (v === undefined) { v = monde.heightAt(x, z); memoMonde.set(cle, v); }
  return v;
};
const mondeGen = makeGen({ heightAt: rel });
const NEIGE = BIOMES.snowLine;
const LIMITE = BIOMES.treeLine;

let haut = 0;
let sonde = 0;
let sommet = 0;
let neigeManquante = 0;
let rocheVue = 0;
let rocheManquante = 0;
let arbreHaut = 0;
for (let x = -1200; x <= 1200; x += 7) {
  for (let z = -1200; z <= 1200; z += 7) {
    const h = rel(x, z);
    sonde++;
    if (h > sommet) sommet = h;
    if (h >= NEIGE) {
      haut++;
      if (mondeGen.surfaceFor(x, z, h).top !== BLOCK.SNOW) neigeManquante++;
    } else if (h >= LIMITE) {
      rocheVue++;
      if (mondeGen.surfaceFor(x, z, h).top !== BLOCK.STONE) rocheManquante++;
    }
    if (h >= LIMITE && mondeGen.treeAt(x, z)) arbreHaut++;
  }
}
check('le monde porte des montagnes',
  haut / sonde > 0.04 && sommet >= 46,
  `${(haut / sonde * 100).toFixed(1)} % de la carte au-dessus de ${NEIGE} cubes, sommet à ${sommet}`);
check('la neige coiffe tout ce qui dépasse sa ligne',
  haut > 200 && neigeManquante === 0, `${neigeManquante} colonne(s) sans neige sur ${haut}`);
check('la roche nue s\'étale entre les arbres et la neige',
  rocheVue > 200 && rocheManquante === 0,
  `${rocheManquante} colonne(s) manquantes sur ${rocheVue} d'étage rocheux`);
check('aucun arbre ne pousse au-dessus de la limite des arbres',
  arbreHaut === 0, `${arbreHaut} arbre(s) sur la roche nue`);

// Gravissable : le joueur ne franchit qu'un cube par colonne. On propage depuis le pied
// du massif, colonne par colonne, et l'on exige d'atteindre la neige — une montagne
// qu'on ne peut pas monter est un décor, pas une zone où se promener.
function grimpe(px, pz, rayon) {
  const depart = [];
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2;
    const x = Math.round(px + Math.cos(ang) * rayon);
    const z = Math.round(pz + Math.sin(ang) * rayon);
    if (rel(x, z) < NEIGE) depart.push([x, z]);
  }
  if (!depart.length) return { ok: false, raison: 'aucun pied sous la neige' };
  const vus = new Set(depart.map(([x, z]) => `${x},${z}`));
  let file = depart;
  let tours = 0;
  while (file.length && tours++ < 20000) {
    const suivant = [];
    for (const [x, z] of file) {
      const h = rel(x, z);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const nz = z + dz;
        if (Math.abs(nx - px) > rayon || Math.abs(nz - pz) > rayon) continue;
        const cle = `${nx},${nz}`;
        if (vus.has(cle)) continue;
        const nh = rel(nx, nz);
        if (nh - h > 1) continue;                  // un seul cube de dénivelé par pas
        vus.add(cle);
        if (nh >= NEIGE) return { ok: true, colonnes: vus.size };
        suivant.push([nx, nz]);
      }
    }
    file = suivant;
  }
  return { ok: false, raison: `enlisé après ${vus.size} colonnes` };
}
const pics = [];
for (let x = -1200; x <= 1200; x += 48) {
  for (let z = -1200; z <= 1200; z += 48) {
    const h = rel(x, z);
    if (h >= 46) pics.push({ x, z, h });
  }
}
pics.sort((a, b) => b.h - a.h);
const grimpees = pics.slice(0, 3).map((p) => ({ ...p, ...grimpe(p.x, p.z, 240) }));
check('un sommet enneigé se gravit à pied depuis son pied',
  pics.length >= 3 && grimpees.length === 3 && grimpees.every((g) => g.ok),
  pics.length
    ? grimpees.map((g) => `(${g.x},${g.z}) à ${g.h} : `
      + `${g.ok ? `${g.colonnes} colonnes explorées` : g.raison}`).join(' | ')
    : 'aucun pic de montagne rencontré');

// ---------------------------------------------------------------------------
// 7 bis. Les très hautes montagnes. Le carré ci-dessus (±1200 cubes) peut fort bien ne
//   contenir aucun massif alpin — l'échelle est celle des océans, donc le hasard de la
//   graine décide. Et le pays alpin est exactement là où le relief s'affranchit du
//   plafond ordinaire : le juger sur les seuls massifs habituels laisserait sans contrôle
//   le relèvement de quarante-six cubes et l'écrête `min(h, alpsTop)`.
//
//   La porte est `alpsIntensity >= 0,06`, la même que lit le village pour se taire :
//   c'est le pays que le joueur doit lire comme sauvage, pas une statistique interne.
// ---------------------------------------------------------------------------
const SAUVAGE = 0.06;
const hauteursAlpes = [];
let sondees = 0;
let picAlpin = null;
for (let x = -2048; x <= 2048; x += 8) {
  for (let z = -2048; z <= 2048; z += 8) {
    sondees++;
    if (monde.alpsIntensity(x, z) < SAUVAGE) continue;
    const y = rel(x, z);
    hauteursAlpes.push(y);
    if (!picAlpin || y > picAlpin.h) picAlpin = { x, z, h: y };
  }
}
hauteursAlpes.sort((a, b) => a - b);
const p99Alpes = hauteursAlpes.length ? hauteursAlpes[Math.floor(0.99 * hauteursAlpes.length)] : 0;
check('le pays alpin porte de très hautes montagnes',
  hauteursAlpes.length > 4000 && hauteursAlpes.length / sondees >= 0.05
    && p99Alpes >= 55 && picAlpin && picAlpin.h >= 64,
  `${(hauteursAlpes.length / sondees * 100).toFixed(1)} % de la carte sous la porte sauvage`
    + ` · p99 ${p99Alpes} cubes · pic ${picAlpin ? `${picAlpin.h} à (${picAlpin.x},${picAlpin.z})` : 'aucun'}`);

let grimpeAlpine = { ok: false, raison: 'aucun massif alpin rencontré' };
if (picAlpin) {
  // Un plateau dont la neige dépasse le rayon laisse les seize points de départ au-dessus
  // de la ligne : on élargit jusqu'à trouver un pied.
  for (const rayon of [240, 360, 500]) {
    const r = grimpe(picAlpin.x, picAlpin.z, rayon);
    if (r.ok || r.raison !== 'aucun pied sous la neige') {
      grimpeAlpine = { ...r, rayon };
      break;
    }
  }
}
check('le plus haut pic alpin se gravit à pied depuis son pied',
  !!picAlpin && grimpeAlpine.ok,
  picAlpin
    ? `(${picAlpin.x},${picAlpin.z}) à ${picAlpin.h} cubes : `
      + `${grimpeAlpine.ok ? `gravit en ${grimpeAlpine.rayon} cubes de rayon` : grimpeAlpine.raison}`
    : 'aucun massif alpin sur ±2048 cubes');

// Ce que les Alpes doivent répondre, ce n'est pas « le monde n'a aucun mur » — il en a,
// et beaucoup, avant elles : sur trois fenêtres de ±300 cubes, **11 %** des colonnes
// sèches adjacentes diffèrent de deux cubes ou plus (jusqu'à dix), le creusement des
// sillons en cause ; le saut du joueur s'arrête à 1,67 cube (`JUMP_SPEED 10`, `GRAVITY
// 30`). Ce chiffre-là est une affaire distincte, mesurée et signalée, pas la faute du
// nouveau relief. Ce qui lui revient, c'est de ne rien ajouter aux murs déjà là : même
// emprise géométrique, mesure avec et sans le relèvement alpin.
const trempe = (t, x, z) => t.heightAt(x, z) > t.waterTopAt(x, z);
function murs(t, cx, cz, rayon) {
  let paires = 0, mauvais = 0, pire = 0;
  for (let x = cx - rayon; x <= cx + rayon; x++) {
    for (let z = cz - rayon; z <= cz + rayon; z++) {
      if (monde.alpsIntensity(x, z) < SAUVAGE) continue;
      if (!trempe(t, x, z)) continue;
      const h = t.heightAt(x, z);
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        if (!trempe(t, x + dx, z + dz)) continue;
        paires++;
        const d = Math.abs(t.heightAt(x + dx, z + dz) - h);
        if (d >= 2) mauvais++;
        if (d > pire) pire = d;
      }
    }
  }
  return { paires, mauvais, pire, taux: paires ? mauvais / paires : 0 };
}
let mursAvec = null;
let mursSans = null;
if (picAlpin) {
  const table = monde.RELIEF;
  mursAvec = murs(monde, picAlpin.x, picAlpin.z, 260);
  const lift = table.alpsLift;
  const crag = table.alpsCrag;
  table.alpsLift = 0;
  table.alpsCrag = 0;
  // Terrain neuf : les tracés de rivière sont mémoïsés par instance et le sol change sous
  // leurs pieds — rejouer sur la même instance comparerait deux mondes différents.
  const nu = createTerrain({ noise: new SimplexNoise(42), chunkHeight: HAUTEUR_MONDE });
  mursSans = murs(nu, picAlpin.x, picAlpin.z, 260);
  table.alpsLift = lift;
  table.alpsCrag = crag;
}
check('les Alpes n\'ajoutent pas de murs que le pays ordinaire ne connaissait déjà',
  !!mursAvec && mursAvec.paires > 20000 && mursSans.paires > 20000
    && mursAvec.taux <= mursSans.taux * 1.25 + 0.005
    && mursAvec.pire <= Math.max(mursSans.pire, 2) + 2,
  mursAvec
    ? `avec ${mursAvec.mauvais}/${mursAvec.paires} (${(mursAvec.taux * 100).toFixed(2)} %, pire `
      + `${mursAvec.pire}) · sans ${mursSans.mauvais}/${mursSans.paires} (${(mursSans.taux * 100).toFixed(2)} %, `
      + `pire ${mursSans.pire})`
    : 'aucun massif alpin jaugé');

process.exit(summary() > 0 ? 1 : 0);
