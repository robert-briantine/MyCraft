// Vérifie l'écran de génération du monde hors navigateur : la fiche par défaut ne
// corrige rien (le monde d'aujourd'hui est régénéré à l'identique), l'île tient sa
// promesse — de l'eau plane à perte de vue au bord — et les curseurs en pourcentage
// rendent bien les parts qu'ils annoncent une fois convertis en seuils de bruit.
// Usage: node tests/worldgen.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReporter } from './browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { check, summary } = makeReporter();

// `world-config.js` importe ses trois voisins : on copie tout `public/js` dans un
// dossier témoin marqué ESM (le projet est en CommonJS), plutôt qu'un module isolé
// dont les liens relatifs casseraient.
const BAC = path.join(os.tmpdir(), `mc-worldgen-${process.pid}`);
fs.rmSync(BAC, { recursive: true, force: true });
fs.mkdirSync(BAC, { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'public/js'))) {
  fs.copyFileSync(path.join(ROOT, 'public/js', f), path.join(BAC, f));
}
fs.writeFileSync(path.join(BAC, 'package.json'), '{"type":"module"}');
const charger = (nom) => import(pathToFileURL(path.join(BAC, nom)).href);

const { SimplexNoise } = await charger('noise.js');
const { createTerrain, RELIEF } = await charger('terrain.js');
const { createBiomeGen, BIOMES } = await charger('biomes.js');
const { createVillageGen, VILLAGE, storeysOf } = await charger('village.js');
const cfg = await charger('world-config.js');
const { createMondePreview } = await charger('world-preview.js');

const CHUNK_SIZE = 16;
const CHUNK_HEIGHT = 128;   // celui du jeu : un plafond plus bas écraserait les sommets
const BLOCK = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, COBBLE: 4, PLANKS: 5, BRICK: 6, GLASS: 7,
  GRIT: 8, OBSIDIAN: 9, LOG: 10, LEAVES: 11, SAND: 12, SNOW: 13, GOLD: 14, MOSS: 15,
  WOOD: 16, WATER: 17, LAVA: 18, DIAMOND: 19,
};

// Même tireuse que le jeu : c'est elle qui décide de tout, jamais Math.random().
function hashRoll(x, y, z, salt) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)
        ^ Math.imul(z | 0, 1274126177) ^ Math.imul(salt | 0, 2654435761);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const MER_BORNES = { min: RELIEF.minGround + 2, max: VILLAGE.minGround };

function fabriqueRelief(monde, seuils = null) {
  return createTerrain({
    noise: new SimplexNoise(cfg.mondeSeeds(monde.graine).terrain),
    chunkHeight: CHUNK_HEIGHT,
    relief: cfg.reliefOverrides(monde, { chunkHeight: CHUNK_HEIGHT, seuils }),
  });
}

function fabriqueClimat(monde) {
  const t = fabriqueRelief(monde);
  return createBiomeGen({
    BLOCK, CHUNK_SIZE, CHUNK_HEIGHT,
    heightAt: (x, z) => t.rawHeight(x, z),
    roll: hashRoll,
    saltBase: (cfg.mondeSeeds(monde.graine).trees * 7919) | 0,
    seaLevel: t.RELIEF.seaLevel,
  });
}

const apercu = createMondePreview({
  creerRelief: (m) => fabriqueRelief(m),
  creerClimat: fabriqueClimat,
  chunkHeight: CHUNK_HEIGHT,
  merBornes: MER_BORNES,
});

/** Le monde réel (pas l'aperçu) tel que le jeu le construirait pour cette fiche. */
function mondeReel(brut) {
  const monde = cfg.clampMonde(brut);
  const seuils = cfg.memesMondes(monde, cfg.MONDE_DEFAULTS) ? {} : apercu.seuils(monde);
  const relief = fabriqueRelief(monde, seuils);
  const biomes = createBiomeGen({
    BLOCK, CHUNK_SIZE, CHUNK_HEIGHT,
    heightAt: (x, z) => relief.rawHeight(x, z),
    roll: hashRoll,
    saltBase: (cfg.mondeSeeds(monde.graine).trees * 7919) | 0,
    seaLevel: relief.RELIEF.seaLevel,
    reglages: cfg.biomesOverrides(monde, seuils),
  });
  const village = createVillageGen({
    BLOCK, CHUNK_SIZE, CHUNK_HEIGHT,
    heightAt: (x, z) => relief.heightAt(x, z),
    roll: hashRoll,
    saltBase: (cfg.mondeSeeds(monde.graine).buildings * 7919) | 0,
    seaLevel: relief.RELIEF.seaLevel,
    waterTopAt: (x, z) => relief.waterTopAt(x, z),
    alpsAt: (x, z) => relief.alpsIntensity(x, z),
    reglages: cfg.villageOverrides(monde),
  });
  return { monde, seuils, relief, biomes, village };
}

/**
 * Les parts mesurées colonne à colonne sur le cœur de l'île (ou la carte entière hors
 * mode île). L'échantillon couvre plusieurs mailles de chaque bruit — climat 150, grand
 * boisé 900, bassin marin ~900 — sinon la statistique lirait une valeur locale.
 */
function mesurerParts(mondeReelObjet, { pas = 8, borneMax = 1200 } = {}) {
  const { relief, biomes, monde } = mondeReelObjet;
  const R = relief.RELIEF;
  const rayon = Math.max(80, R.islandRadius);
  const talus = Math.min(Math.max(20, R.islandShelf), Math.max(20, rayon - 60));
  const coeur = monde.ile ? Math.max(60, rayon - talus) : Infinity;
  const borne = Math.min(coeur, borneMax);
  let total = 0, noye = 0, foret = 0, desert = 0, plaine = 0;
  for (let x = -borne; x <= borne; x += pas) {
    for (let z = -borne; z <= borne; z += pas) {
      if (Math.hypot(x, z) > coeur) continue;
      total++;
      const h = relief.rawHeight(x, z);
      if (h <= R.seaLevel) { noye++; continue; }
      const zone = biomes.biomeAt(x, z);
      if (zone === 'foret') foret++; else if (zone === 'desert') desert++; else plaine++;
    }
  }
  const terres = total - noye;
  const pct = (v, base) => (base ? 100 * v / base : 0);
  return {
    n: total,
    mer: pct(noye, total),
    foret: pct(foret, terres),
    desert: pct(desert, terres),
    plaine: pct(plaine, terres),
  };
}

// ---------------------------------------------------------------- A. la fiche
const defauts = cfg.clampMonde(null);
check('la fiche vide rend les valeurs par défaut',
  Object.keys(cfg.MONDE_DEFAULTS).every((k) => defauts[k] === cfg.MONDE_DEFAULTS[k]),
  JSON.stringify(defauts));

const poubelle = cfg.clampMonde({
  foret: 'beaucoup', desert: NaN, mer: 1e9, graine: -12, rayonIle: 'x',
  ile: 'oui', immeublesMax: 999, densiteVilles: -5, villesPetites: 'beaucoup',
  villesMoyennes: -5, villesGrandes: 1e9, inconnu: 42,
});
check('une fiche venue du disque est nettoyée, jamais crue',
  poubelle.foret === cfg.MONDE_DEFAULTS.foret
  && poubelle.desert === cfg.MONDE_DEFAULTS.desert
  && poubelle.mer === 60 && poubelle.graine === 1
  && poubelle.rayonIle === cfg.MONDE_DEFAULTS.rayonIle
  && poubelle.ile === true && poubelle.immeublesMax === 18
  && poubelle.densiteVilles === 0
  && poubelle.villesPetites === cfg.MONDE_DEFAULTS.villesPetites
  && poubelle.villesMoyennes === 0 && poubelle.villesGrandes === 100
  && !('inconnu' in poubelle),
  JSON.stringify(poubelle));

check('la graine par défaut redonne les graines d\'hier (42, 123, 777, 999)',
  JSON.stringify(cfg.mondeSeeds(42)) === JSON.stringify({ terrain: 42, trees: 123, buildings: 777, caves: 999 }),
  JSON.stringify(cfg.mondeSeeds(42)));

// À ses valeurs par défaut, la fiche ne doit corriger AUCUNE constante : c'est ce qui
// garantit qu'un monde créé sans toucher à l'écran est cube pour cube le monde d'hier.
const oRelief = cfg.reliefOverrides(cfg.MONDE_DEFAULTS, { chunkHeight: CHUNK_HEIGHT });
const constantesTouchees = Object.keys(oRelief).filter((k) => !k.startsWith('island'));
check('fiche par défaut : aucune constante de relief modifiée (hors île)',
  constantesTouchees.every((k) => oRelief[k] === RELIEF[k]),
  constantesTouchees.filter((k) => oRelief[k] !== RELIEF[k]).join(', '));
check('l\'île est éteinte dans les constantes du module (les suites jugent le monde d\'avant)',
  RELIEF.island === false);

const oVillage = cfg.villageOverrides(cfg.MONDE_DEFAULTS);
check('fiche par défaut : densités et catégories d\'immeuble intactes',
  oVillage.cityChance === VILLAGE.cityChance && oVillage.lotDensity === VILLAGE.lotDensity
  && JSON.stringify(oVillage.towerFloors) === JSON.stringify(VILLAGE.towerFloors)
  && JSON.stringify(oVillage.towerWeights) === JSON.stringify(VILLAGE.towerWeights)
  && JSON.stringify(oVillage.towerUrbanGate) === JSON.stringify(VILLAGE.towerUrbanGate)
  && oVillage.maxHeight === VILLAGE.maxHeight,
  JSON.stringify(oVillage));

check('fiche par défaut : aucun correctif de biome',
  Object.keys(cfg.biomesOverrides(cfg.MONDE_DEFAULTS, {})).length === 0);

const reliefs = [fabriqueRelief(cfg.MONDE_DEFAULTS, {}), createTerrain({
  noise: new SimplexNoise(42), chunkHeight: CHUNK_HEIGHT,
})];
let identiques = true;
for (let x = -700; x <= 700; x += 11) {
  for (let z = -700; z <= 700; z += 11) {
    if (reliefs[0].rawHeight(x, z) !== reliefs[1].rawHeight(x, z)
      || reliefs[0].heightAt(x, z) !== reliefs[1].heightAt(x, z)) identiques = false;
  }
}
check('le monde par défaut est identique au monde sans configuration', identiques);

// ---------------------------------------------------------------- B. l'île
const petite = mondeReel({ ile: true, rayonIle: 800, largeurCote: 200, profondeurLarge: 14 });
const R = petite.relief.RELIEF;
let tousNoyes = true, fondsDistincts = new Set(), penteMax = 0;
for (let a = 0; a < 16; a++) {
  const angle = (a / 16) * Math.PI * 2;
  const dx = Math.cos(angle), dz = Math.sin(angle);
  let precedent = petite.relief.rawHeight(0, 0);
  for (let r = 0; r <= 1400; r++) {
    const x = Math.round(dx * r), z = Math.round(dz * r);
    const h = petite.relief.rawHeight(x, z);
    penteMax = Math.max(penteMax, Math.abs(h - precedent));
    precedent = h;
    if (r >= 820) {
      if (h > R.seaLevel - 6) tousNoyes = false;
      fondsDistincts.add(h);
    }
  }
}
check('au-delà du rayon, toute colonne est sous l\'eau', tousNoyes);
check('le large est un fond unique : l\'horizon ne montre que de l\'eau',
  fondsDistincts.size === 1 && [...fondsDistincts][0] <= R.seaLevel - 6,
  `fonds ${[...fondsDistincts].join(',')}, flottaison ${R.seaLevel}`);
// Le talus doit rester gravissable. Ce n'est pas en le comparant à zéro qu'on le juge :
// les parois des sillons dépassent déjà un cube par colonne dans la campagne ordinaire.
// La question est celle du supplément apporté par l'île — la même couronne jugée sans le
// mode île répond de la rugosité préexistante — et de la pente moyenne du déversement,
// qui décide si l'on peut remonter de la mer sur la plage.
const rugositeSansIle = (() => {
  const t = fabriqueRelief(cfg.clampMonde({ ile: false }), {});
  let max = 0;
  for (let a = 0; a < 16; a++) {
    const angle = (a / 16) * Math.PI * 2;
    const dx = Math.cos(angle), dz = Math.sin(angle);
    let precedent = t.rawHeight(0, 0);
    for (let r = 600; r <= 1400; r++) {
      const h = t.rawHeight(Math.round(dx * r), Math.round(dz * r));
      max = Math.max(max, Math.abs(h - precedent));
      precedent = h;
    }
  }
  return max;
})();
check('le talus n\'est pas plus rude que le même territoire sans l\'île',
  penteMax <= rugositeSansIle + 1, `ressaut ${penteMax} contre ${rugositeSansIle} hors île`);

let penteMoyenneMax = 0;
for (let a = 0; a < 32; a++) {
  const angle = (a / 32) * Math.PI * 2;
  const dx = Math.cos(angle), dz = Math.sin(angle);
  // Du dernier repli haut au fond du large : la longueur du talus fait la pente.
  const depart = 800 - 200;
  const hAut = petite.relief.rawHeight(Math.round(dx * (depart - 40)), Math.round(dz * (depart - 40)));
  const hBas = petite.relief.rawHeight(Math.round(dx * 900), Math.round(dz * 900));
  penteMoyenneMax = Math.max(penteMoyenneMax, Math.abs(hAut - hBas) / (900 - (depart - 40)));
}
check('la pente moyenne du déversement reste douce (< 0,6 cube par colonne)',
  penteMoyenneMax < 0.6, `pente maximale ${penteMoyenneMax.toFixed(2)}`);

// Contre-témoin : sans le mode île, la même couronne porte des terres. Sinon les deux
// contrôles ci-dessus ne célèbreraient qu'une propriété déjà vraie sans l'option.
const sansIle = mondeReel({ ile: false });
let secsAuLarge = 0;
for (let a = 0; a < 16; a++) {
  const angle = (a / 16) * Math.PI * 2;
  for (let r = 820; r <= 1400; r += 4) {
    if (sansIle.relief.rawHeight(Math.round(Math.cos(angle) * r), Math.round(Math.sin(angle) * r)) > R.seaLevel) secsAuLarge++;
  }
}
check('contre-témoin : hors mode île, ces mêmes colonnes portent des terres',
  secsAuLarge > 100, `${secsAuLarge} colonnes sèches`);

// Le point d'apparition doit rester au sec quelle que soit la fiche : anneaux croissants
// autour de l'origine, comme le fait le jeu.
function trouverApparition(relief) {
  const sec = (x, z) => {
    if (relief.heightAt(x, z) < relief.waterTopAt(x, z) + 1) return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (relief.heightAt(x + dx, z + dz) < relief.waterTopAt(x + dx, z + dz) + 1) return false;
    }
    return true;
  };
  for (let r = 0; r <= 64; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (const [x, z] of [[8 + dx, 8 - r], [8 + dx, 8 + r], [8 - r, 8 + dx], [8 + r, 8 + dx]]) {
        if (sec(x, z)) return [x, z];
      }
    }
  }
  return null;
}
let apparitionsOk = true;
for (const brut of [
  {}, { ile: false }, { ile: true, rayonIle: 300, largeurCote: 60 },
  { mer: 60 }, { mer: 2 }, { hauteurMontagne: 40 },
]) {
  if (!trouverApparition(mondeReel(brut).relief)) apparitionsOk = false;
}
check('l\'apparition trouve toujours un repli au sec, même île minuscule ou mer haute', apparitionsOk);

// Un village doit continuer de pousser sur l'île.
function compterBatiments(gen, rayonChunks) {
  let batiments = 0, tours = 0, etagesMax = 0;
  for (let cx = -rayonChunks; cx <= rayonChunks; cx++) {
    for (let cz = -rayonChunks; cz <= rayonChunks; cz++) {
      for (const plan of gen.buildingAt(cx, cz)) {
        if (plan.kind !== 'house' && plan.kind !== 'tower') continue;
        batiments++;
        const etages = storeysOf(plan.height);
        if (plan.kind === 'tower') tours++;
        etagesMax = Math.max(etagesMax, etages);
      }
    }
  }
  return { batiments, tours, etagesMax };
}
const batIsle = compterBatiments(mondeReel({}).village, 30);
check('l\'île reste habitée : le village y bâtit', batIsle.batiments > 40,
  `${batIsle.batiments} bâtiments dans ±480 cubes`);

// ---------------------------------------------------------------- C. les parts
const casParts = [
  ['forêt basse', { foret: 20 }, 'foret'],
  ['forêt haute', { foret: 60 }, 'foret'],
  ['désert bas', { desert: 8 }, 'desert'],
  ['désert haut', { desert: 50 }, 'desert'],
  ['mer basse', { mer: 12 }, 'mer'],
  ['mer haute', { mer: 55 }, 'mer'],
];
let partsFideles = true;
const detail = [];
for (const [nom, brut, cle] of casParts) {
  const objet = mondeReel(brut);
  const mesure = mesurerParts(objet);
  const vise = brut[cle];
  const obtenu = mesure[cle];
  const ecart = Math.abs(obtenu - vise);
  // La mer se juge sur toute la carte, les zones sur les terres : tolérance 5 points.
  if (ecart > 5) { partsFideles = false; detail.push(`${nom}: visé ${vise}, rendu ${obtenu.toFixed(1)}`); }
}
check('un curseur de pourcentage rend la part annoncée (±5 pts, monde réel mesuré)',
  partsFideles, detail.join(' · '));

const echelleForet = [10, 25, 40, 60].map((f) => mesurerParts(mondeReel({ foret: f })).foret);
check('le curseur de forêt est monotone',
  echelleForet.every((v, i) => i === 0 || v > echelleForet[i - 1]),
  echelleForet.map((v) => v.toFixed(1)).join(' < '));
const echelleDesert = [2, 15, 35, 55].map((d) => mesurerParts(mondeReel({ desert: d })).desert);
check('le curseur de désert est monotone',
  echelleDesert.every((v, i) => i === 0 || v > echelleDesert[i - 1]),
  echelleDesert.map((v) => v.toFixed(1)).join(' < '));
const echelleMer = [4, 20, 40, 58].map((m) => mesurerParts(mondeReel({ mer: m })).mer);
check('le curseur de mer est monotone',
  echelleMer.every((v, i) => i === 0 || v > echelleMer[i - 1]),
  echelleMer.map((v) => v.toFixed(1)).join(' < '));

// Contre-témoin : monter la forêt ne doit pas déplacer le sable, dont la règle est
// indépendante. S'il bougeait, les trois curseurs ne seraient pas orthogonaux et la
// « répartition » demandée ne serait pas celle obtenue.
const sableSeul = mesurerParts(mondeReel({ foret: 60 })).desert;
const sableDefaut = mesurerParts(mondeReel({})).desert;
check('contre-témoin : la forêt ne pilote pas le désert',
  Math.abs(sableSeul - sableDefaut) < 3, `${sableDefaut.toFixed(1)} % → ${sableSeul.toFixed(1)} %`);

// Le sable au sol a DEUX causes et le curseur « Désert » n'en gouverne qu'une : la zone
// aride du climat. Sous la ligne de grève (`BIOMES.sandLine`), le sol reste du sable quel
// que soit le climat — c'est la plage. Un écran qui n'afficherait que « Désert 0 % »
// contredirait donc ce que le joueur voit par terre ; il doit rendre les deux chiffres.
function compterSable(objet, rayon = 900) {
  let sec = 0, desert = 0, sable = 0;
  const mer = objet.relief.RELIEF.seaLevel;
  for (let x = -rayon; x <= rayon; x += 7) {
    for (let z = -rayon; z <= rayon; z += 7) {
      if (Math.hypot(x, z) > rayon) continue;
      const h = objet.relief.heightAt(x, z);
      if (h <= mer) continue;
      sec++;
      if (objet.biomes.biomeAt(x, z) === 'desert') desert++;
      if (objet.biomes.surfaceFor(x, z, h).top === BLOCK.SAND) sable++;
    }
  }
  const p = (v) => 100 * v / Math.max(1, sec);
  return { sec, desert: p(desert), sable: p(sable) };
}
const objetAllume = mondeReel({});
const objetEteint = mondeReel({ desert: 0 });
const sableAllume = compterSable(objetAllume);
const sableEteint = compterSable(objetEteint);
check('le curseur de désert éteint la zone aride du générateur',
  sableEteint.desert < 1 && sableAllume.desert > 15,
  `zone désert ${sableAllume.desert.toFixed(1)} % → ${sableEteint.desert.toFixed(1)} %`);
check('le sable de la grève survit au désert à zéro (autre règle, autre cause)',
  sableEteint.sable > 8 && sableEteint.sable < sableAllume.sable,
  `sable au sol ${sableAllume.sable.toFixed(1)} % → ${sableEteint.sable.toFixed(1)} %`);
const annonceEteinte = apercu.lire(cfg.clampMonde({ desert: 0 }));
const ligneSable = annonceEteinte.lignes.find((l) => /Sable/.test(l.label));
check('l\'écran annonce le sable restant au lieu de laisser croire à un monde sans sable',
  !!ligneSable && Math.abs(annonceEteinte.parts.sable - sableEteint.sable) <= 6,
  `${ligneSable ? `${ligneSable.label} ${ligneSable.valeur}` : 'ligne absente'}`
  + ` · générateur ${sableEteint.sable.toFixed(1)} %`);

// Le troisième levier du sable, celui qui manque au joueur voyant une plage sous un
// désert éteint : l'épaisseur de grève au-dessus de l'eau. Elle se règle en cubes, suit
// le niveau de la mer, et ne re-classe aucun bruit — donc elle laisse la zone désert
// intacte (contre-témoin) pendant que le sable disparaît colonne par colonne.
const objetsPlage = [[4, objetEteint], [3, null], [2, null], [1, null], [0, null]]
  .map(([p, objet]) => [p, objet || mondeReel({ desert: 0, largeurPlage: p })]);
const echellePlage = objetsPlage.map(([p, objet]) => [p, compterSable(objet).sable]);
check('le curseur de plage fait disparaître la grève, cube par cube',
  echellePlage[0][1] > 15 && echellePlage[4][1] < 1
  && echellePlage.every(([, v], i) => i === 0 || v <= echellePlage[i - 1][1] - 1),
  echellePlage.map(([p, v]) => `${p}:${v.toFixed(1)} %`).join(' > '));
const desertPlagePleine = mesurerParts(objetAllume).desert;
const desertPlageNulle = mesurerParts(mondeReel({ largeurPlage: 0 })).desert;
check('contre-témoin : la plage ne pilote pas la zone désert',
  Math.abs(desertPlagePleine - desertPlageNulle) < 1,
  `${desertPlagePleine.toFixed(1)} % → ${desertPlageNulle.toFixed(1)} %`);
// Le plafond du curseur n'est pas un caprice : `VILLAGE.minGround` lotit juste au-dessus
// du sable, et une maison posant son lit sur la grève ferait barrage à la mer.
const lignesDeSable = [0, 1, 2, 3, 4].map((p) => {
  const m = cfg.clampMonde({ largeurPlage: p });
  const s = apercu.seuils(m);
  const o = cfg.biomesOverrides(m, s);
  return Number.isFinite(o.sandLine) ? o.sandLine : BIOMES.sandLine;
});
check('la grève ne monte jamais sous le pied des maisons, et s\'éteint jusqu\'à la mer',
  lignesDeSable.every((l) => l <= VILLAGE.minGround)
  && lignesDeSable[0] === RELIEF.seaLevel && lignesDeSable[4] === BIOMES.sandLine,
  `lignes ${lignesDeSable.join(', ')} · village dès ${VILLAGE.minGround}, mer à ${RELIEF.seaLevel}`);
const annoncePlageNulle = apercu.lire(cfg.clampMonde({ desert: 0, largeurPlage: 0 }));
const lignePlageNulle = annoncePlageNulle.lignes.find((l) => /Sable/.test(l.label));
const sablePlageNulle = compterSable(objetsPlage[4][1]);
check('l\'écran porte l\'épaisseur visée et promet une île sans sable à zéro',
  !!lignePlageNulle && /0 cube/.test(lignePlageNulle.vise)
  && annoncePlageNulle.parts.sableGreve < 0.5
  && Math.abs(annoncePlageNulle.parts.sable - sablePlageNulle.sable) <= 6,
  `${lignePlageNulle ? `${lignePlageNulle.valeur} · visé ${lignePlageNulle.vise}` : 'ligne absente'}`
  + ` · générateur ${sablePlageNulle.sable.toFixed(1)} %`);

// L'écran affiche « visé X · obtenu Y » : à la fiche par défaut, les deux doivent se
// rejoindre, sinon le panneau s'ouvre en se contredisant.
const mesureDefaut = mesurerParts(mondeReel({}));
check('à l\'ouverture, les chiffres affichés correspondent au monde rendu (±2 pts)',
  Math.abs(mesureDefaut.foret - cfg.MONDE_DEFAULTS.foret) <= 2
  && Math.abs(mesureDefaut.desert - cfg.MONDE_DEFAULTS.desert) <= 2
  && Math.abs(mesureDefaut.mer - cfg.MONDE_DEFAULTS.mer) <= 2,
  `forêt ${mesureDefaut.foret.toFixed(1)} vs ${cfg.MONDE_DEFAULTS.foret}, désert ${mesureDefaut.desert.toFixed(1)} vs ${cfg.MONDE_DEFAULTS.desert}, mer ${mesureDefaut.mer.toFixed(1)} vs ${cfg.MONDE_DEFAULTS.mer}`);

const sommeZones = mesureDefaut.foret + mesureDefaut.desert + mesureDefaut.plaine;
check('forêt + désert + plaine font les terres (≈ 100 %)',
  Math.abs(sommeZones - 100) < 0.6, `${sommeZones.toFixed(2)} %`);

// ---------------------------------------------------------------- D. le bâti
const toursParDefaut = compterBatiments(mondeReel({}).village, 34);
const toursSix = compterBatiments(mondeReel({ immeublesMax: 6 }).village, 34);
check('le plafond d\'étages est respecté', toursSix.etagesMax <= 6,
  `plus haut ${toursSix.etagesMax} étages`);
check('contre-témoin : sans bridage, la ville monte plus haut',
  toursParDefaut.etagesMax >= 10 && toursParDefaut.etagesMax > toursSix.etagesMax,
  `${toursParDefaut.etagesMax} étages par défaut`);

function empriseUrbaine(gen, rayon) {
  let urbaines = 0;
  for (let x = -rayon; x <= rayon; x += 24) {
    for (let z = -rayon; z <= rayon; z += 24) {
      if (gen.cityInfluence(x, z) > 0.3) urbaines++;
    }
  }
  return urbaines;
}
const urbainVide = empriseUrbaine(mondeReel({ densiteVilles: 0 }).village, 700);
const urbainPlein = empriseUrbaine(mondeReel({ densiteVilles: 100 }).village, 700);
check('le curseur de villes pilote l\'emprise urbaine',
  urbainVide === 0 && urbainPlein > 20, `${urbainVide} → ${urbainPlein} sondes en ville`);

// Les trois types de ville — demandé le 2026-11-11 : « ajouter 3 type de ville small
// medium et large » avec leurs proportions réglables. Un type porte deux choses jugées
// ici : ce que sa ville occupe (rayon d'influence) et jusqu'où elle monte (plafond
// d'étages). Un curseur qui ne changerait ni l'un ni l'autre ne réglerait rien.
{
  const queDesGrandes = { villesPetites: 0, villesMoyennes: 0, villesGrandes: 100 };
  const queDesPetites = { villesPetites: 100, villesMoyennes: 0, villesGrandes: 0 };
  const grandes = mondeReel(queDesGrandes);
  const petites = mondeReel(queDesPetites);
  const hauts = compterBatiments(grandes.village, 34);
  const bas = compterBatiments(petites.village, 34);
  check('les proportions de types pilotent la hauteur des villes',
    hauts.etagesMax > bas.etagesMax && bas.etagesMax <= VILLAGE.cityTypes[0].etagesMax,
    `petites seules ${bas.etagesMax} étages, grandes seules ${hauts.etagesMax}`);
  const empriseGrandes = empriseUrbaine(grandes.village, 700);
  const emprisePetites = empriseUrbaine(petites.village, 700);
  check('les proportions de types pilotent l\'emprise des villes',
    empriseGrandes > emprisePetites * 1.5,
    `${emprisePetites} → ${empriseGrandes} sondes en ville`);
  const toutEteint = cfg.villageOverrides({ villesPetites: 0, villesMoyennes: 0, villesGrandes: 0 });
  check('trois curseurs à zéro ne suppriment pas le tirage des types',
    JSON.stringify(toutEteint.cityTypeWeights) === JSON.stringify(VILLAGE.cityTypeWeights),
    JSON.stringify(toutEteint.cityTypeWeights));
  const bridé = cfg.villageOverrides({
    immeublesMax: 6, villesPetites: 0, villesMoyennes: 0, villesGrandes: 100,
  });
  check('le plafond général d\'immeubles bride le plafond d\'un type',
    bridé.cityTypes.every((t) => t.etagesMax <= 6),
    JSON.stringify(bridé.cityTypes.map((t) => t.etagesMax)));
  // Le monde par défaut doit réellement mélanger les trois sorts : un poids par défaut
  // tombé à zéro laisserait une seule silhouette et le contrôle précédent passerait quand
  // même, puisque il ne compare que deux mondes extrêmes.
  const gen = mondeReel({}).village;
  const vus = new Set();
  for (let x = -900; x <= 900; x += 24) {
    for (let z = -900; z <= 900; z += 24) {
      const t = gen.cityTypeAt(x, z);
      if (t >= 0) vus.add(t);
    }
  }
  check('le monde par défaut mélange les trois types de ville',
    vus.size === VILLAGE.cityTypes.length, `types rencontrés ${[...vus].join(', ')}`);
}

const hameauxVide = compterBatiments(mondeReel({ densiteVillages: 0, densiteVilles: 0 }).village, 30);
const hameauxPlein = compterBatiments(mondeReel({ densiteVillages: 60, densiteVilles: 0 }).village, 30);
check('le curseur de villages pilote la densité du bâti',
  hameauxPlein.batiments > hameauxVide.batiments * 2,
  `${hameauxVide.batiments} → ${hameauxPlein.batiments} bâtiments`);

// ---------------------------------------------------------------- E. la graine
const graineA = mondeReel({ graine: 42 });
const graineB = mondeReel({ graine: 7 });
let different = 0;
for (let x = -300; x <= 300; x += 13) {
  for (let z = -300; z <= 300; z += 13) {
    if (graineA.relief.rawHeight(x, z) !== graineB.relief.rawHeight(x, z)) different++;
  }
}
check('changer la graine change le monde', different > 1000, `${different} colonnes différentes`);
const graineBis = mondeReel({ graine: 7 });
let fidele = true;
for (let x = -300; x <= 300; x += 7) {
  for (let z = -300; z <= 300; z += 7) {
    if (graineB.relief.rawHeight(x, z) !== graineBis.relief.rawHeight(x, z)
      || graineB.biomes.biomeAt(x, z) !== graineBis.biomes.biomeAt(x, z)) fidele = false;
  }
}
check('même graine, même monde (déterminisme de la fiche)', fidele);

// ---------------------------------------------------------------- F. l'aperçu
const lu = apercu.lire(cfg.clampMonde({ foret: 55, desert: 12, mer: 45 }));
check('l\'aperçu annonce des seuils exploitables',
  Number.isFinite(lu.seuils.oceanThreshold) && Number.isFinite(lu.seuils.seaLevel)
  && Number.isFinite(lu.seuils.wetLimit) && Number.isFinite(lu.seuils.dryLimit)
  && lu.seuils.dryLimit <= lu.seuils.wetLimit,
  JSON.stringify(lu.seuils));
check('l\'aperçu rend les parts visées (±2 pts sur son propre échantillon)',
  Math.abs(lu.parts.foret - 55) <= 2 && Math.abs(lu.parts.desert - 12) <= 2
  && Math.abs(lu.parts.mer - 45) <= 2,
  JSON.stringify(lu.parts));

const seuilsDefaut = apercu.seuils(cfg.clampMonde(null));
check('à la fiche par défaut, l\'étalonnage ne touche aucun seuil',
  seuilsDefaut.oceanThreshold === RELIEF.oceanThreshold
  && seuilsDefaut.seaLevel === RELIEF.seaLevel
  && seuilsDefaut.wetLimit === BIOMES.wetLimit
  && seuilsDefaut.dryLimit === BIOMES.dryLimit,
  JSON.stringify(seuilsDefaut));

// Le canevas n'existe pas sous Node : un faux contexte suffit à juger que la carte est
// bien peinte, pixel par pixel, et qu'elle n'est pas d'une seule couleur.
const tuilesPosees = [];
const fauxCanevas = {
  width: 0, height: 0,
  getContext: () => ({
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (img) => tuilesPosees.push(img),
    beginPath() {}, arc() {}, stroke() {}, fillRect() {},
    set strokeStyle(_) {}, set fillStyle(_) {}, set lineWidth(_) {},
  }),
};
const carte = apercu.peindre(fauxCanevas, cfg.clampMonde({}));
const img = tuilesPosees[tuilesPosees.length - 1];
const nuances = new Set();
for (let i = 0; i < img.data.length; i += 4) nuances.add(`${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`);
check('la carte de l\'écran est peinte et polychrome',
  !!img && img.width === apercu.resolution && nuances.size >= 5,
  `${nuances.size} nuances`);
check('la carte rend aussi les parts affichées à l\'écran',
  Number.isFinite(carte.foret) && Number.isFinite(carte.mer), JSON.stringify(carte));

// ------------------------------------------------- G. la description du monde
// `public/ts/world-generation.ts` décrit la fiche mais n'est compilé par personne : sans
// contrôle il dériverait en silence de ce que l'écran expose vraiment — alors qu'il est
// précisément le document où l'on lit ce que font les curseurs. On jugera les deux.
const texteTs = fs.readFileSync(path.join(ROOT, 'public/ts/world-generation.ts'), 'utf8');
const blocDefaut = texteTs.match(/const MONDE_DEFAUT[^=]*=\s*\{([\s\S]*?)\n\}/);
const defautTs = {};
for (const [, cle, val] of (blocDefaut ? blocDefaut[1] : '').matchAll(
  /^\s*(\w+)\s*:\s*(-?[\d.]+|true|false)\s*,?\s*$/gm)) {
  defautTs[cle] = val === 'true' ? true : val === 'false' ? false : Number(val);
}
const attendus = cfg.MONDE_DEFAULTS;
check('la description du Monde porte les mêmes valeurs par défaut que la fiche',
  !!blocDefaut
  && Object.keys(attendus).every((k) => Object.is(defautTs[k], attendus[k]))
  && Object.keys(defautTs).length === Object.keys(attendus).length,
  `ts: ${JSON.stringify(defautTs)}`);

const blocPortees = texteTs.match(/const PORTEES[^=]*=\s*\{([\s\S]*?)\n\}/);
const porteesTs = {};
for (const [, cle, min, max] of (blocPortees ? blocPortees[1] : '').matchAll(
  /(\w+)\s*:\s*\{\s*min:\s*(-?[\d.]+)\s*,\s*max:\s*(-?[\d.]+)/g)) {
  porteesTs[cle] = { min: Number(min), max: Number(max) };
}
const horsPortee = cfg.MONDE_FIELDS.filter((f) => f.type !== 'checkbox')
  .filter((f) => !porteesTs[f.key]
    || porteesTs[f.key].min !== f.min || porteesTs[f.key].max !== f.max)
  .map((f) => `${f.key}: décrit ${JSON.stringify(porteesTs[f.key])}, curseur ${f.min}…${f.max}`);
check('les bornes décrites sont bien celles des curseurs',
  !!blocPortees && horsPortee.length === 0, horsPortee.join(' | '));

fs.rmSync(BAC, { recursive: true, force: true });
process.exit(summary() > 0 ? 1 : 0);
