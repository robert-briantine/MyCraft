// Vérifie hors navigateur le cycle du jour (course du soleil, couleurs, intensités) et
// les deux champs d'éclairage qui cuisent dans le maillage : la lumière du ciel — qui
// doit s'éteindre au fond des grottes sans éteindre l'intérieur des maisons — et le halo
// des lanternes, qui doit s'arrêter aux murs.
// Usage: node tests/ciel.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReporter } from './browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { check, summary } = makeReporter();

// Comme pour le village : les modules sont écrits pour le navigateur (ESM) mais sans
// dépendance, on les copie sous .mjs pour que Node les évalue tels quels.
async function charger(relative) {
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  const tmp = path.join(os.tmpdir(), `mycraft-ciel-${path.basename(relative, '.js')}-${process.pid}.mjs`);
  fs.writeFileSync(tmp, source);
  try { return await import(pathToFileURL(tmp).href); } finally { fs.rmSync(tmp, { force: true }); }
}

const ciel = await charger('public/js/ciel.js');
const eclairage = await charger('public/js/eclairage.js');

// ==================== LE CYCLE ====================
const midi = ciel.etatDuCiel(0.5);
const luminance = (c) => 0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255);
check('à midi le monde rend ce qu’il rendait avant le cycle',
  midi.ambiante.intensite === 0.72 && midi.directe.intensite === 0.5
  && midi.directe.couleur === 0xfff4e0 && midi.jour === 1,
  `ambiante ${midi.ambiante.intensite} · directe ${midi.directe.intensite} · #${midi.directe.couleur.toString(16)}`);

// Les lumières sont figées ci-dessus ; la **teinte** du ciel, elle, a été reprise le
// 2026-11-12 : à 0x87ceeb le zénith tenait 193 de luminance pour une bande basse à 214,
// soit un ciel entier en linge pâle. Le bleu franc ci-dessous garde la journée claire
// (les contrôles de pixels de `tests/render-collision.mjs` jugent l'exposition du relief,
// éclairé par les deux lumières, pas par le dôme) tout en rendant l'horizon lisible.
check('le plein jour est un bleu franc où l’horizon se détache', (() => {
  const z = luminance(midi.ciel), h = luminance(midi.horizon);
  const comp = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  return z <= 165 && h - z >= 20 && comp(midi.ciel)[2] > comp(midi.ciel)[0];
})(), `zénith ${luminance(midi.ciel).toFixed(0)} · horizon ${luminance(midi.horizon).toFixed(0)} / 255`);

const minuit = ciel.etatDuCiel(0);
check('à minuit il fait nuit, mais dehors on se repère encore',
  minuit.jour === 0 && minuit.ambiante.intensite > 0.1 && minuit.ambiante.intensite < 0.3,
  `ambiante ${minuit.ambiante.intensite.toFixed(2)} · phase « ${minuit.phase} »`);

check('le soleil monte jusqu’au zénith à midi puis redescend', (() => {
  const h = Array.from({ length: 21 }, (_, i) => ciel.etatDuCiel(i / 20).hauteur);
  return h.indexOf(Math.max(...h)) === 10 && h[5] > h[0] && h[15] < h[10];
})(), `sommet à ${Math.round(ciel.etatDuCiel(0.5).hauteur * 100)} % de hauteur`);

check('il se lève d’un côté du monde et se couche de l’autre',
  ciel.etatDuCiel(0.25).soleil[0] > 0.9 && ciel.etatDuCiel(0.75).soleil[0] < -0.9
  && Math.abs(ciel.etatDuCiel(0.5).soleil[0]) < 0.2,
  `lever x=${ciel.etatDuCiel(0.25).soleil[0].toFixed(2)} · midi x=${ciel.etatDuCiel(0.5).soleil[0].toFixed(2)} · coucher x=${ciel.etatDuCiel(0.75).soleil[0].toFixed(2)}`);

check('la lune occupe toujours la place opposée au soleil', (() => {
  const e = ciel.etatDuCiel(0.18);
  return e.lune.every((v, k) => Math.abs(v + e.soleil[k]) < 1e-12);
})());

check('les lanternes tiennent la nuit et s’éteignent en plein jour',
  ciel.etatDuCiel(0).lampes === 1 && ciel.etatDuCiel(0.5).lampes === 0,
  `nuit ${ciel.etatDuCiel(0).lampes} · jour ${ciel.etatDuCiel(0.5).lampes}`);

check('l’aube est plus chaude que le plein jour', (() => {
  const chaud = (c) => ((c >> 16) & 255) - ((c >> 8) & 255);
  return chaud(ciel.etatDuCiel(0.23).horizon) > chaud(midi.horizon) + 30;
})(), `aube #${ciel.etatDuCiel(0.23).horizon.toString(16)} · midi #${midi.horizon.toString(16)}`);

check('les quatre phases couvrent le cycle sans trou', (() => {
  const vues = new Set();
  for (let i = 0; i < 400; i++) vues.add(ciel.etatDuCiel(i / 400).phase);
  return ['jour', 'nuit', 'aube', 'crépuscule'].every((p) => vues.has(p));
})(), `rencontrées : ${[...new Set(Array.from({ length: 400 }, (_, i) => ciel.etatDuCiel(i / 400).phase))].join(', ')}`);

check('la brume descend de l’horizon vers le corps du ciel et ne vire jamais au blanc', (() => {
  const comp = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  let pireLum = 0, plusProcheDuCiel = 0;
  for (let i = 0; i < 400; i++) {
    const e = ciel.etatDuCiel(i / 400);
    const [r, g, b] = comp(e.brume);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (r > 235 && g > 235 && b > 235) return false;      // jamais un linge blanc
    if (lum > pireLum) pireLum = lum;
    const d = (a, x) => Math.hypot(...comp(a).map((v, k) => v - comp(x)[k]));
    if (d(e.brume, e.ciel) < d(e.horizon, e.ciel)) plusProcheDuCiel++;
  }
  return pireLum < 215 && plusProcheDuCiel === 400;
})(), `brume la plus claire ${(() => {
  let m = 0;
  for (let i = 0; i < 400; i++) {
    const c = ciel.etatDuCiel(i / 400).brume;
    m = Math.max(m, 0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255));
  }
  return m.toFixed(0);
})()} / 255`);

// Demandé le 2026-11-12 : « dans la journée l'horizon est blanc dans la direction de la
// caméra, sur les côtés il n'est pas blanc ». Deux causes mesurées : le renard d'aube
// jugé sur seul |cos| tenait 0,61 de teinte chaude à trente-six degrés de soleil —
// l'heure d'ouverture du monde — et le zénith du plein jour, à 193 de luminance, ne se
// distinguait plus de sa bande basse (214). Les deux contrôles ci-dessous tiennent la
// journée entière, pas seulement midi : c'est elle que le joueur regarde.
check('le matin où le monde s\'ouvre n\'est pas teinté d\'aube', (() => {
  const comp = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  const d = (a, x) => Math.hypot(...comp(a).map((v, k) => v - comp(x)[k]));
  const matin = ciel.etatDuCiel(ciel.HEURE_DEPART), pleinJour = ciel.etatDuCiel(0.5);
  return d(matin.brume, pleinJour.brume) < 12 && d(matin.horizon, pleinJour.horizon) < 12
    && d(matin.ciel, pleinJour.ciel) < 12;
})(), `brume #${ciel.etatDuCiel(ciel.HEURE_DEPART).brume.toString(16)} · midi #${ciel.etatDuCiel(0.5).brume.toString(16)}`);

check('de dix heures à seize heures, la bande d\'horizon reste une voilure bleutée', (() => {
  let pire = 0, pireEcart = 999;
  for (let i = 300; i <= 700; i++) {
    const e = ciel.etatDuCiel(i / 1000);
    const r = (e.horizon >> 16) & 255, b = e.horizon & 255;
    if (!(b > r && b > 150)) return false;                 // jamais un linge, toujours du bleu
    pire = Math.max(pire, luminance(e.horizon));
    pireEcart = Math.min(pireEcart, luminance(e.horizon) - luminance(e.ciel));
  }
  return pire <= 200 && pireEcart >= 20;
})(), `horizon le plus clair ${(() => {
  let m = 0;
  for (let i = 300; i <= 700; i++) m = Math.max(m, luminance(ciel.etatDuCiel(i / 1000).horizon));
  return m.toFixed(0);
})()} / 255 · zénith ${luminance(ciel.etatDuCiel(0.5).ciel).toFixed(0)}`);

const horloge = ciel.creerHorloge({ duree: 480, heure: 0 });
horloge.avancer(120);
check('l’horloge avance à la durée réglée', Math.abs(horloge.heure() - 0.25) < 1e-12,
  `${ciel.heureAffichee(horloge.heure())} après 120 s sur une journée de 480 s`);

check('un temps négatif ne remonte pas le cycle', (() => {
  const h = ciel.creerHorloge({ duree: 480, heure: 0.5 });
  h.avancer(-100);
  return h.heure() === 0.5;
})());

check('la durée du jour reste dans les bornes de l’écran de réglage',
  ciel.bornerDuree(5) === ciel.DUREE_JOUR_BORNES.min
  && ciel.bornerDuree(99999) === ciel.DUREE_JOUR_BORNES.max
  && ciel.bornerDuree('abc') === ciel.DUREE_JOUR_DEFAUT,
  `${ciel.DUREE_JOUR_BORNES.min}…${ciel.DUREE_JOUR_BORNES.max} s · défaut ${ciel.DUREE_JOUR_DEFAUT} s`);

check('le monde s’ouvre en plein jour, jamais à l’aube',
  ciel.etatDuCiel(ciel.HEURE_DEPART).jour === 1,
  `heure ${ciel.HEURE_DEPART} → ${ciel.etatDuCiel(ciel.HEURE_DEPART).phase}`);

// ==================== LES CHAMPS D'ÉCLAIRAGE ====================
const CS = 16, CH = 64;
const AIR = 0, PIERRE = 1, TERRE = 2, HERBE = 3, BOIS = 4, LANTERNE = 5;
const NATUREL = new Set([PIERRE, TERRE, HERBE]);
const SOL = 40;                                  // le bloc du sol tient en y = SOL-1

// Un plateau plat, une galerie borgne ouverte sur une tranchée, une pièce close posée
// sur le sol, et une poche scellée au cœur de la roche.
const data = new Map();
const cle = (x, y, z) => `${x},${y},${z}`;
const poser = (x, y, z, id) => { if (id === AIR) data.delete(cle(x, y, z)); else data.set(cle(x, y, z), id); };

for (let x = 0; x < 32; x++) {
  for (let z = 0; z < 32; z++) {
    const tranchee = x === 14 || x === 15;       // entaille ouverte jusqu’à y = 18
    for (let y = 0; y < (tranchee ? 18 : SOL); y++) {
      const id = y === (tranchee ? 17 : SOL - 1) ? HERBE : y >= (tranchee ? 15 : SOL - 3) ? TERRE : PIERRE;
      poser(x, y, z, id);
    }
    if (!tranchee && z >= 8 && z <= 12 && x <= 13) {
      for (let y = 19; y <= 22; y++) poser(x, y, z, AIR);   // galerie de quatre de haut,
    }                                                        // débouchant dans la tranchée
  }
}
// Pièce close de cinq sur cinq, plafond à deux cubes (le garde qui distingue une pièce
// d'une grotte se joue là), posée sur le sol en x 9…13, z 2…6.
function batirPlafond(id) {
  for (let x = 9; x <= 13; x++) for (let z = 2; z <= 6; z++) {
    for (let y = SOL; y <= SOL + 4; y++) poser(x, y, z, AIR);
    poser(x, SOL + 5, z, id);
    poser(x, SOL + 6, z, id);
    if (x === 9 || x === 13 || z === 2 || z === 6) for (let y = SOL; y <= SOL + 5; y++) poser(x, y, z, BOIS);
  }
}
batirPlafond(BOIS);
// Poche scellée, sans aucune communication avec le jour.
for (let x = 3; x <= 5; x++) for (let z = 3; z <= 5; z++) for (let y = 24; y <= 26; y++) poser(x, y, z, AIR);
// Voûte naturelle d'**un seul** cube de roche au-dessus d'un vide : c'est le cas que la
// double épaisseur exigeait à tort, et qui noyait de lumière une galerie pourtant close.
// Dans l'emprise du tronçon jugé (16×16), loin de la tranchée, de la galerie et des pièces.
for (let x = 6; x <= 8; x++) for (let z = 13; z <= 15; z++) {
  for (let y = 30; y <= 32; y++) poser(x, y, z, AIR);   // la galerie
  poser(x, 33, z, PIERRE);                               // sa voûte, un cube seulement
  for (let y = 34; y <= 36; y++) poser(x, y, z, AIR);   // vide au-dessus, fermé par le plateau
}

const opaqueAt = (x, y, z) => {
  if (y < 0 || y >= CH) return false;
  const b = data.get(cle(x, y, z));
  return b !== undefined && b !== AIR;
};
const rocheAt = (x, y, z) => NATUREL.has(data.get(cle(x, y, z)));
const ecl = eclairage.creerEclairage({
  CHUNK_SIZE: CS, CHUNK_HEIGHT: CH, opaqueAt, rocheAt, estLampe: (id) => id === LANTERNE,
});
const lumiere = ecl.champCiel(0, 0);

check('à l’air libre la lumière du ciel est pleine', lumiere(8, SOL + 1, 8) === 1);
check('au fond d’une poche scellée il ne reste que le plancher de nuit',
  lumiere(4, 25, 4) === eclairage.PLANCHER_NUIT,
  `ciel=${lumiere(4, 25, 4).toFixed(3)}`);
check('le fond d’une galerie borgne reste noir', lumiere(1, 20, 10) < 0.25,
  `ciel=${lumiere(1, 20, 10).toFixed(2)}`);
check('la lumière descend dans la tranchée', lumiere(14, 18, 10) > 0.9,
  `ciel=${lumiere(14, 18, 10).toFixed(2)}`);
check('une galerie ouverte s’éclaire à mesure qu’on approche de son entrée', (() => {
  const loins = lumiere(2, 20, 10), milieu = lumiere(7, 20, 10), pres = lumiere(12, 20, 10);
  return pres > milieu && milieu > loins && pres - loins > 0.3;
})(), `x2 ${lumiere(2, 20, 10).toFixed(2)} · x7 ${lumiere(7, 20, 10).toFixed(2)} · x12 ${lumiere(12, 20, 10).toFixed(2)}`);

check('une pièce sous un plafond de bois reste éclairée',
  lumiere(11, SOL + 2, 4) === 1, `ciel=${lumiere(11, SOL + 2, 4).toFixed(2)}`);
check('une voûte naturelle d’un seul cube de roche ne laisse pas passer le jour',
  lumiere(7, 32, 14) === eclairage.PLANCHER_NUIT && lumiere(7, 30, 14) === eclairage.PLANCHER_NUIT,
  `sous la voûte ciel=${lumiere(7, 32, 14).toFixed(3)} · fond ${lumiere(7, 30, 14).toFixed(3)}`);

batirPlafond(PIERRE);                              // même pièce, dalle de pierre cette fois
const eclPierre = eclairage.creerEclairage({
  CHUNK_SIZE: CS, CHUNK_HEIGHT: CH, opaqueAt, rocheAt, estLampe: (id) => id === LANTERNE,
});
check('la même pièce sous deux cubes de roche devient une grotte',
  eclPierre.champCiel(0, 0)(11, SOL + 2, 4) < 0.2,
  `ciel=${eclPierre.champCiel(0, 0)(11, SOL + 2, 4).toFixed(2)}`);
const eclBati = eclairage.creerEclairage({
  CHUNK_SIZE: CS, CHUNK_HEIGHT: CH, opaqueAt, rocheAt, estLampe: (id) => id === LANTERNE,
  estBati: (x, y, z) => x >= 9 && x <= 13 && z >= 2 && z <= 6 && y >= SOL && y <= SOL + 5,
});
check('mais une pièce tenue pour un logement du village reprend la lumière',
  eclBati.champCiel(0, 0)(11, SOL + 2, 4) === 1,
  `ciel=${eclBati.champCiel(0, 0)(11, SOL + 2, 4).toFixed(2)}`);
batirPlafond(BOIS);

// ---- halo des lanternes ----
const index = (x, y, z) => x + z * CS + y * CS * CS;
const LAMPE = [2, SOL + 1, 10];
poser(LAMPE[0], LAMPE[1], LAMPE[2], LANTERNE);
const halo = ecl.champLampes([LAMPE], 0, 0);
check('une lanterne éclaire son pied', halo[index(2, SOL + 1, 10)] > 0.7,
  `puissance ${halo[index(2, SOL + 1, 10)].toFixed(2)}`);
check('son halo tombe avec la distance', (() => {
  const a = halo[index(3, SOL + 1, 10)], b = halo[index(5, SOL + 1, 10)];
  return a > b && b > 0;
})(), `+1 cube ${halo[index(3, SOL + 1, 10)].toFixed(2)} · +3 cubes ${halo[index(5, SOL + 1, 10)].toFixed(2)}`);
check('rien n’est éclairé au-delà de sa portée',
  halo[index(2 + eclairage.LAMPE_PORTEE + 2, SOL + 1, 10)] === 0,
  `portée ${eclairage.LAMPE_PORTEE} cubes`);
check('le halo monte et descend avec la lampe',
  halo[index(2, SOL + 4, 10)] > 0,
  `+3 cubes ${halo[index(2, SOL + 4, 10)].toFixed(2)}`);

for (let y = SOL - 6; y <= SOL + 6; y++) for (let z = 8; z <= 12; z++) poser(4, y, z, PIERRE);
const haloCoupe = ecl.champLampes([LAMPE], 0, 0);
check('un mur arrête la lumière des lanternes',
  haloCoupe[index(5, SOL + 1, 10)] === 0 && haloCoupe[index(3, SOL + 1, 10)] > 0,
  `du côté de la lampe ${haloCoupe[index(3, SOL + 1, 10)].toFixed(2)} · de l’autre ${haloCoupe[index(5, SOL + 1, 10)]}`);
for (let y = SOL - 6; y <= SOL + 6; y++) for (let z = 8; z <= 12; z++) poser(4, y, z, AIR);

// Le cas qui fuyait : une cloison **loin** de la lampe. À cinq échantillons sur une
// portée de neuf cubes, les sondes tombaient en x 3, 4 et 5 puis sautaient à 7 — le mur
// d'un cube posé en x = 5 n'était jamais touché et la lumière le traversait (mesuré :
// cible à sept cubes éclairée à 0,06, et de même en diagonale +7/+2 et +4/+6). L'utilisateur
// voyait exactement cela : « la lumière dans les maisons passe à travers les murs ».
for (let y = SOL - 6; y <= SOL + 6; y++) for (let z = 8; z <= 12; z++) poser(5, y, z, PIERRE);
const haloLoing = ecl.champLampes([LAMPE], 0, 0);
check('une cloison d’un cube, loin de la lampe, ne laisse rien passer',
  haloLoing[index(9, SOL + 1, 10)] === 0 && haloLoing[index(4, SOL + 1, 10)] > 0,
  `du côté de la lampe ${haloLoing[index(4, SOL + 1, 10)].toFixed(2)} · de l’autre ${haloLoing[index(9, SOL + 1, 10)]}`);
check('en diagonale non plus la lumière ne traverse pas la cloison',
  haloLoing[index(9, SOL + 1, 12)] === 0 && haloLoing[index(6, SOL + 1, 10)] === 0,
  `+7,+2 → ${haloLoing[index(9, SOL + 1, 12)]} · +4,+0 → ${haloLoing[index(6, SOL + 1, 10)]}`);
// Une fenêtre dans cette cloison : c'est par là que la lumière doit sortir, et seulement
// par là — ce que l'utilisateur demandait (« on devrait uniquement la voir depuis les
// fenêtres »).
poser(5, SOL + 1, 10, AIR);
const haloFenetre = ecl.champLampes([LAMPE], 0, 0);
check('la lumière ne sort de la pièce que par la fenêtre',
  haloFenetre[index(9, SOL + 1, 10)] > 0.03 && haloFenetre[index(9, SOL + 1, 12)] === 0,
  `sous la fenêtre ${haloFenetre[index(9, SOL + 1, 10)].toFixed(3)} · à côté ${haloFenetre[index(9, SOL + 1, 12)]}`);
for (let y = SOL - 6; y <= SOL + 6; y++) for (let z = 8; z <= 12; z++) poser(5, y, z, AIR);

check('les lanternes sont retrouvées dans les données d’un tronçon', (() => {
  const tampon = new Uint8Array(CS * CS * CH);
  for (const [k, v] of data) {
    const [x, y, z] = k.split(',').map(Number);
    if (x < CS && z < CS) tampon[x + z * CS + y * CS * CS] = v;
  }
  const trouvees = ecl.lampesDeData(tampon, 0, 0);
  return trouvees.length === 1 && trouvees[0][0] === 2 && trouvees[0][1] === SOL + 1 && trouvees[0][2] === 10;
})());

check('deux lanternes se partagent la place sans se surexposer', (() => {
  const deux = ecl.champLampes([LAMPE, [3, SOL + 1, 10]], 0, 0);
  return deux[index(2, SOL + 1, 10)] <= 1.2 && deux[index(2, SOL + 1, 10)] > 0.7;
})());

check('le champ d’éclairage est reproductible à l’identique',
  Array.from(ecl.champLampes([[10, SOL + 1, 10]], 0, 0)).join()
  === Array.from(ecl.champLampes([[10, SOL + 1, 10]], 0, 0)).join());

process.exit(summary());
