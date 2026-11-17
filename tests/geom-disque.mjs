// Vérifie hors navigateur le format du cache de géométrie : aller-retour bit à bit des
// tampons, zéro recopie à la relecture (c'est tout l'enjeu — les tableaux rendus doivent
// être des vues posables sur un attribut GPU), garde-fous sur un fichier venu du disque
// (truqué, tronqué, écrit pour un autre monde ou un autre atlas), trous d'une cuisson
// partielle, budget disque, et la reprise incrémentale d'un fichier déjà écrit.
// Usage: node tests/geom-disque.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReporter } from './browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { check, summary } = makeReporter();

// Les modules du jeu sont écrits pour le navigateur (ESM) mais sans dépendance : on les
// copie sous .mjs pour que Node les évalue tels quels (le projet est en CommonJS).
async function charger(relative) {
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  const tmp = path.join(os.tmpdir(), `mycraft-geom-${path.basename(relative, '.js')}-${process.pid}.mjs`);
  fs.writeFileSync(tmp, source);
  try { return await import(pathToFileURL(tmp).href); } finally { fs.rmSync(tmp, { force: true }); }
}

const geom = await charger('public/js/geom-disque.js');

const CS = 16;
const H = 128;
const graine = 42;
const fiche = { ile: true, rayonIle: 300, foret: 40, village: true };
const ATLAS = 'atlas-256x128-ab12cd34';
const ATTENDU = { chunkSize: CS, height: H, seed: graine, monde: fiche, mailleVersion: 1, atlasSignature: ATLAS };

/** Un sommet reconnaissable : chaque valeur encode son rôle, une erreur saute aux yeux. */
function maillageSynthetique(cx, cz, mat = 'opaque', nb = 24 + ((cx + 3 * cz) & 7)) {
  const position = new Float32Array(nb * 3);
  const normal = new Float32Array(nb * 3);
  const uv = new Float32Array(nb * 2);
  const color = new Float32Array(nb * 3);
  const aLampe = new Float32Array(nb);
  for (let i = 0; i < nb; i++) {
    position[i * 3] = cx * CS + (i % CS);
    position[i * 3 + 1] = (i * 7) % H;
    position[i * 3 + 2] = cz * CS + ((i * 5) % CS);
    normal[i * 3] = [1, -1, 0][i % 3];
    normal[i * 3 + 1] = [0, 0, 1][(i + 1) % 3];
    normal[i * 3 + 2] = [(i % 2) ? -1 : 1, 0, 0][(i + 2) % 3];
    uv[i * 2] = (i % 16) / 16 + 0.5 / 16;
    uv[i * 2 + 1] = ((i * 3) % 8) / 8;
    color[i * 3] = (i % 251) / 255;
    color[i * 3 + 1] = 1 - (i % 251) / 255;
    color[i * 3 + 2] = 0.25;
    aLampe[i] = ((i * 13) % 16) / 15;
  }
  const index = new Uint16Array(nb * 3);
  for (let i = 0; i < nb * 3; i++) index[i] = (i * 7) % nb;
  return { mat, position, normal, uv, color, aLampe, index };
}

function tronconSynthetique(cx, cz, mats = ['opaque', 'trans', 'glow']) {
  return mats.map((mat) => maillageSynthetique(cx, cz, mat));
}

async function ecrire({ codec = geom.CODEC_DEFLATE, clefs = null, maxOctets = Infinity, existant = null, mats } = {}) {
  const liste = (clefs && clefs.length) ? clefs.slice() : [];
  if (!liste.length) {
    for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) liste.push([cx, cz]);
  }
  const e = new geom.EcrivainGeom({
    chunkSize: CS, height: H, seed: graine, monde: fiche, mailleVersion: 1,
    atlasSignature: ATLAS, codec, maxOctets, existant, attendu: ATTENDU,
  });
  for (const [cx, cz] of liste) {
    if (!existant || !e.aLeTroncon(cx, cz)) {
      try {
        await e.ajouter(cx, cz, tronconSynthetique(cx, cz, mats), geom.hachage(`${cx}:${cz}`));
      } catch (err) {
        // Le jeu s'arrête de cuire quand le budget est atteint : le harnais fait pareil.
        if (/budget/.test(err.message)) break;
        throw err;
      }
    }
  }
  return { fichier: await e.publier(), ecrivain: e, liste };
}

/** Ramène un mailleur — côté écriture (float32) comme côté relecture (entiers quantifiés)
 *  — sur l'échelle du monde réel, pour que la comparaison porte sur les valeurs et non sur
 *  leur représentation. La position se déquantifie, les canaux normalisés se divisent. */
const ECHELLES = { normal: 127, uv: 65535, color: 255, aLampe: 255 };
const TOLERANCES = {
  position: 1 / 256 + 1e-4,        // le pas d'écriture du fichier
  normal: 1 / 127 + 1e-4,
  uv: 1 / 65535 + 1e-4,
  color: 1 / 255 + 1e-4,
  aLampe: 1 / 255 + 1e-4,
};
const NOMS_ATTRIBUTS = ['position', 'normal', 'uv', 'color', 'aLampe'];

function valeursDe(m, nom) {
  if (m.attributs) {
    const a = m.attributs.find((x) => x.nom === nom);
    if (!a) return null;
    if (nom === 'position') return geom.dequantifierPositions(a.tableau, m.origine);
    const echelle = ECHELLES[nom];
    const out = new Float64Array(a.tableau.length);
    for (let i = 0; i < a.tableau.length; i++) out[i] = a.tableau[i] / echelle;
    return out;
  }
  return m[nom] || null;
}

function itemSizeDe(m, nom) {
  if (m.attributs) {
    const a = m.attributs.find((x) => x.nom === nom);
    return a ? a.itemSize : null;
  }
  return { position: 3, normal: 3, uv: 2, color: 3, aLampe: 1 }[nom] ?? null;
}

/** Compare deux listes de mailleurs, valeur par valeur, dans la tolérance du format. */
function identiques(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) {
    if (a[k].mat !== b[k].mat) return false;
    for (const nom of NOMS_ATTRIBUTS) {
      const x = valeursDe(a[k], nom);
      const y = valeursDe(b[k], nom);
      if (!x || !y || x.length !== y.length) return false;
      const ix = itemSizeDe(a[k], nom); const iy = itemSizeDe(b[k], nom);
      if (ix != null && iy != null && ix !== iy) return false;
      const tol = TOLERANCES[nom];
      for (let j = 0; j < x.length; j++) {
        const d = x[j] > y[j] ? x[j] - y[j] : y[j] - x[j];
        if (d > tol) return false;
      }
    }
    const ia = a[k].index; const ib = b[k].index;
    if (!ia || !ib || ia.length !== ib.length) return false;
    for (let j = 0; j < ia.length; j++) if (ia[j] !== ib[j]) return false;
  }
  return true;
}

// ==================== ALLER-RETOUR DES CODECS ====================
for (const codec of [geom.CODEC_DEFLATE, geom.CODEC_BRUT]) {
  const { fichier, liste } = await ecrire({ codec });
  const cache = geom.CacheGeom.depuis(fichier, ATTENDU);
  let relus = 0;
  const motif = [];
  for (const [cx, cz] of liste) {
    const maillages = await cache.charger(cx, cz);
    if (identiques(tronconSynthetique(cx, cz), maillages)) relus++;
    else motif.push(`${cx},${cz}`);
  }
  check(`codec ${codec} : tout ce qui est écrit se relit à l'identique`,
    !!cache && relus === liste.length,
    `${relus}/${liste.length} tronçons${motif.length ? ` · faux à ${motif.slice(0, 3)}` : ''} · ${(fichier.length / 1024).toFixed(1)} Ko`);
}

// ==================== LE CŒUR DU SUJET : SANS RECOPIE ====================
{
  const { fichier } = await ecrire({ codec: geom.CODEC_DEFLATE });
  const cache = geom.CacheGeom.depuis(fichier, ATTENDU);
  const maillages = await cache.charger(0, 0);
  const tampons = new Set();
  let toutesVues = true;
  let alignees = true;
  const TYPES_POSABLES = [Uint16Array, Int8Array, Uint8Array, Float32Array];
  for (const m of maillages) {
    for (const a of [...m.attributs, { tableau: m.index }]) {
      const t = a.tableau;
      if (!TYPES_POSABLES.some((T) => t instanceof T)) toutesVues = false;
      if (t.byteOffset % 4 !== 0) alignees = false;
      tampons.add(t.buffer);
    }
  }
  // Un seul tampon pour tout le tronçon : la décompression a alloué une fois, chaque
  // attribut n'est qu'une vue dessus. C'est ce qui supprime la copie CPU du chemin.
  const attenduBrut = geom.serialiserMaillages(tronconSynthetique(0, 0)).byteLength;
  const annonce = cache.parClef.get('0,0').n;
  // Deux lectures du même tronçon rendent les mêmes objets : rien n'est regénéré.
  const relu = await cache.charger(0, 0);
  check('la relecture rend des vues directement posables (un seul tampon, aligné sur 4)',
    toutesVues && alignees && tampons.size === 1 && relu === maillages,
    `${tampons.size} tampon · offsets ${maillages.map((m) => m.attributs[0].tableau.byteOffset).join(',')}`);
  check('et la taille annoncée par la table est bien celle du bloc sérialisé',
    annonce === attenduBrut, `table ${annonce} o · sérialisé ${attenduBrut} o`);
}

// ==================== LE FICHIER VIENT DU DISQUE : IL EST SUSPECT ====================
const sain = (await ecrire({ codec: geom.CODEC_DEFLATE })).fichier;
const verifier = (octets, opts = {}) => geom.lireEnTete(octets, { ...ATTENDU, ...opts });

check('un fichier sans signature est refusé', (() => {
  const abime = Uint8Array.from(sain);
  abime[0] = 0x58;
  return verifier(abime).ok === false;
})(), verifier(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).motif || 'refusé');

check('une version inconnue est refusée', (() => {
  const abime = Uint8Array.from(sain);
  abime[4] = 99;
  const r = verifier(abime);
  return r.ok === false && /version/.test(r.motif);
})(), '');

check('un fichier tronqué en plein corps est refusé', (() => {
  const r = verifier(sain.subarray(0, sain.length - 40));
  return r.ok === false && /hors fichier|tronqu/.test(r.motif);
})(), verifier(sain.subarray(0, sain.length - 40)).motif);

check('la graine du monde doit être celle qui a cuit le fichier',
  verifier(sain, { seed: graine + 1 }).ok === false, verifier(sain, { seed: graine + 1 }).motif);

check('une fiche de génération différente refuse le cache',
  verifier(sain, { monde: { ...fiche, rayonIle: 900 } }).ok === false,
  verifier(sain, { monde: { ...fiche, rayonIle: 900 } }).motif);

check('des tronçons d’une autre géométrie refusent le cache',
  verifier(sain, { chunkSize: 8 }).ok === false && verifier(sain, { height: 64 }).ok === false,
  verifier(sain, { height: 64 }).motif);

check('un mailleur qui a changé depuis la cuisson refuse le cache', (() => {
  const r = verifier(sain, { mailleVersion: 2 });
  return r.ok === false && /mailleur/.test(r.motif);
})(), verifier(sain, { mailleVersion: 2 }).motif);

check('un atlas différent refuse le cache (les uv ne désigneraient plus la même tuile)', (() => {
  const r = verifier(sain, { atlasSignature: 'autre-atlas' });
  return r.ok === false && /atlas/.test(r.motif);
})(), verifier(sain, { atlasSignature: 'autre-atlas' }).motif);

check('une table de décalages salie est refusée', (() => {
  // On salit la dernière entrée plutôt que la première : son décalage devient un nombre
  // du même nombre de chiffres (le fichier garde sa taille) mais tombe hors du fichier.
  const texte = new TextDecoder().decode(sain);
  const marque = '"o":';
  const fin = texte.lastIndexOf(marque);
  if (fin < 0) return false;
  let i = fin + marque.length;
  while (i < texte.length && texte[i] >= '0' && texte[i] <= '9') i++;
  const chiffre = i - (fin + marque.length);
  const salie = `${texte.slice(0, fin + marque.length)}${'9'.repeat(chiffre)}${texte.slice(i)}`;
  return verifier(new TextEncoder().encode(salie)).ok === false;
})(), '', 'décalage hors fichier');

check('un fichier vide ou absent se dit sans exception',
  geom.lireEnTete(null).ok === false && geom.lireEnTete(new Uint8Array(0)).ok === false
  && geom.CacheGeom.depuis(new Uint8Array(3), ATTENDU) === null, '');

{
  const abime = Uint8Array.from(sain);
  const r = geom.lireEnTete(abime, ATTENDU);
  const premiereEntree = r.tete.entrees[0];
  for (let i = 0; i < Math.min(24, premiereEntree.l); i++) abime[premiereEntree.o + i] ^= 0xff;
  const cache = geom.CacheGeom.depuis(abime, ATTENDU);
  let rendu = 'données';
  try { rendu = await cache.charger(premiereEntree.c[0], premiereEntree.c[1]); } catch (e) { rendu = `exception ${e.message}`; }
  const second = r.tete.entrees[1];
  const voisin = await cache.charger(second.c[0], second.c[1]);
  check('un bloc truqué se dit absent, jamais rendu en triangles faux',
    rendu === null && !!voisin && identiques(tronconSynthetique(second.c[0], second.c[1]), voisin),
    `truqué=${rendu === null ? 'null' : rendu} · voisin=${voisin ? 'lu' : 'perdu'} · refusés=${cache.stats().refuses}`);
}

// ==================== CUISSON PARTIELLE : LES TROUS ====================
{
  const manquant = new Set(['0,0', '-1,2', '2,-2']);
  const ecrits = [];
  const e = new geom.EcrivainGeom({
    chunkSize: CS, height: H, seed: graine, monde: fiche, mailleVersion: 1,
    atlasSignature: ATLAS, codec: geom.CODEC_BRUT,
  });
  for (let cz = -2; cz <= 2; cz++) {
    for (let cx = -2; cx <= 2; cx++) {
      if (manquant.has(`${cx},${cz}`)) continue;
      await e.ajouter(cx, cz, tronconSynthetique(cx, cz), null);
      ecrits.push([cx, cz]);
    }
  }
  const cache = geom.CacheGeom.depuis(await e.publier(), ATTENDU);
  const trousOk = cache && [...manquant].every((c) => {
    const [cx, cz] = c.split(',').map(Number);
    return cache.aLeTroncon(cx, cz) === false && cache.pret(cx, cz) === null;
  });
  let relus = 0;
  for (const [cx, cz] of ecrits) if (await cache.charger(cx, cz)) relus++;
  check('les tronçons non cuits restent des trous que le jeu régénérera',
    !!cache && trousOk && relus === ecrits.length,
    `${relus}/${ecrits.length} relus · ${cache ? cache.stats().troncons : '?'} annoncés`);
}

// ==================== BUDGET DISQUE ====================
{
  const petit = await ecrire({ maxOctets: 6000 });
  check('le budget disque borne ce qui est accepté', petit.ecrivain.taille > 0 && petit.ecrivain.octetsCompresse <= 6000,
    `${petit.ecrivain.taille} tronçons · ${petit.ecrivain.octetsCompresse} o`);

  let refuse = false;
  const goulue = new geom.EcrivainGeom({
    chunkSize: CS, height: H, seed: graine, monde: fiche, atlasSignature: ATLAS, maxOctets: 4000,
  });
  try {
    // Un seul tronçon dépasse déjà le budget : il doit être refusé, pas écrit à moitié.
    await goulue.ajouter(0, 0, [maillageSynthetique(0, 0, 'opaque', 9000)]);
  } catch (err) { refuse = /budget/.test(err.message); }
  check('un tronçon plus gros que le budget est refusé sans rien laisser derrière lui',
    refuse && goulue.taille === 0, goulue.taille === 0 ? 'aucune entrée' : `${goulue.taille} entrée(s)`);
}

// ==================== REPRISE INCRÉMENTALE ====================
{
  const premier = (await ecrire({ clefs: [[0, 0], [1, 0], [0, 1]] })).fichier;
  const e = new geom.EcrivainGeom({
    chunkSize: CS, height: H, seed: graine, monde: fiche, mailleVersion: 1,
    atlasSignature: ATLAS, existant: premier, attendu: ATTENDU,
  });
  const avant = e.taille;
  await e.ajouter(5, 5, tronconSynthetique(5, 5), geom.hachage('5:5'));
  await e.retirer(1, 0);                                     // le joueur a creusé ici
  const second = await e.publier();
  const cache = geom.CacheGeom.depuis(second, ATTENDU);
  const conserve = await cache.charger(0, 0);
  const ajoute = await cache.charger(5, 5);
  check('un fichier déjà écrit est repris sans remailler ce qui est en boîte',
    avant === 3 && cache && cache.stats().troncons === 3
    && identiques(tronconSynthetique(0, 0), conserve) && identiques(tronconSynthetique(5, 5), ajoute)
    && cache.aLeTroncon(1, 0) === false,
    `${avant} repris · ${cache ? cache.stats().troncons : '?'} au final`);

  // Le remplaçage doit écraser l'ancien bloc, pas s'y ajouter.
  const remplace = new geom.EcrivainGeom({
    chunkSize: CS, height: H, seed: graine, monde: fiche, atlasSignature: ATLAS, existant: second, attendu: ATTENDU,
  });
  await remplace.ajouter(0, 0, [maillageSynthetique(0, 0, 'opaque', 30)], geom.hachage('nouveau'));
  const cache2 = geom.CacheGeom.depuis(await remplace.publier(), ATTENDU);
  const lu = await cache2.charger(0, 0);
  check('recuire un tronçon remplace l’ancien état',
    !!cache2 && lu.length === 1 && lu[0].attributs[0].tableau.length === 90 && cache2.empreinteDu(0, 0) === geom.hachage('nouveau'),
    `${lu ? lu.length : '?'} mailleur(s) · empreinte ${cache2 ? cache2.empreinteDu(0, 0) : '?'}`);
}

// ==================== PUBLICATION PAR AJOUT ====================
// Le chemin courant : le fichier déjà sur le serveur n'est plus réécrit, on ne lui envoie
// que les blocs neufs et l'en-tête qui les annonce. Ces contrôles sont là parce que la
// voie complète coûtait, mesurée le 2026-11-17, 1 496 ms d'envoi pour 15 Mo déjà en boîte
// — publié tous les douze tronçons, c'était le rendu saccadé du joueur.
{
  /** Ce que le serveur fait de ce que renvoie `publierMorcele`. */
  const appliquerAjout = (fichier, m) => {
    if (m.base !== fichier.length) throw new Error(`base ${m.base} ≠ fichier ${fichier.length}`);
    if (m.nouvelleTaille !== m.base + m.append.length) throw new Error('taille annoncée incohérente');
    const out = new Uint8Array(m.nouvelleTaille);
    out.set(fichier, 0);
    out.set(m.append, m.base);
    out.set(m.table.octets, m.table.offset);          // des lignes collées à la fin de la table
    return out;
  };

  const enBoite = (await ecrire({ clefs: [[0, 0], [1, 0], [0, 1], [1, 1]] })).fichier;
  const gabarit = (octets) => new DataView(octets.buffer, octets.byteOffset, octets.length).getUint32(5, true);

  const e = new geom.EcrivainGeom({
    chunkSize: CS, height: H, seed: graine, monde: fiche, mailleVersion: 1,
    atlasSignature: ATLAS, existant: enBoite, attendu: ATTENDU,
  });
  await e.ajouter(7, -3, tronconSynthetique(7, -3), geom.hachage('7:-3'));
  await e.ajouter(-4, 2, tronconSynthetique(-4, 2), geom.hachage('-4:2'));
  const morcele = e.publierMorcele();
  const agrandi = morcele ? appliquerAjout(enBoite, morcele) : null;
  const cache = agrandi && geom.CacheGeom.depuis(agrandi, ATTENDU);
  const relus = [];
  if (cache) for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [1, 1], [7, -3], [-4, 2]]) relus.push(await cache.charger(cx, cz));
  const fideles = [[0, 0], [1, 0], [0, 1], [1, 1], [7, -3], [-4, 2]]
    .every(([cx, cz], i) => identiques(tronconSynthetique(cx, cz), relus[i]));
  const avant = geom.lireEnTete(enBoite, ATTENDU);
  const apres = agrandi && geom.lireEnTete(agrandi, ATTENDU);
  const decalagesPris = !!(avant.ok && apres && apres.ok) && avant.tete.entrees.every((x) => {
    const m = apres.tete.entrees.find((y) => y.c[0] === x.c[0] && y.c[1] === x.c[1]);
    return m && m.o === x.o && m.l === x.l;
  });
  check('publier par ajout ne renvoie que les blocs neufs',
    !!morcele && morcele.base === enBoite.length && morcele.append.length < enBoite.length / 2
    && morcele.paquets.length === 2,
    morcele ? `${morcele.append.length} o ajoutés pour un fichier de ${enBoite.length} o` : 'rien à ajouter');
  check("l'en-tête garde la même longueur, donc les blocs en boîte ne bougent jamais",
    !!morcele && gabarit(agrandi) === gabarit(enBoite) && decalagesPris,
    `gabarit ${gabarit(enBoite)} o · fichier ${enBoite.length} → ${agrandi ? agrandi.length : '?'} o`);
  // C'est LE contrôle qui porte la promesse : publier ne doit plus coûter la taille du
  // fichier. Avant la voie d'ajout, chaque publication renvoyait le fichier entier. Le budget
  // suit le nombre de lignes — une ligne mesure au pire 100 octets (relevé sur le fichier du
  // joueur : moyenne 92 o, maximum 100 o), jamais le gabarit réservé.
  const budgetTable = 200 * (morcele ? morcele.paquets.length : 0);
  check('la table ne voyage pas : une ligne coûte ~100 o, pas le gabarit réservé',
    !!morcele && morcele.table.offset > 9 && morcele.table.octets.length <= budgetTable
    && morcele.table.octets.length < gabarit(enBoite) / 10,
    `offset ${morcele ? morcele.table.offset : '?'} · ${morcele ? morcele.table.octets.length : '?'} o pour `
    + `${morcele ? morcele.paquets.length : 0} lignes · budget ${budgetTable} o · gabarit ${gabarit(enBoite)} o`);
  check('le fichier grossi par ajout se relit entièrement, anciens et nouveaux blocs',
    !!cache && cache.stats().troncons === 6 && fideles,
    `${cache ? cache.stats().troncons : 0}/6 tronçons lus`);

  // Un `fs.writeSync` peut n'écrire qu'une partie du tampon : le serveur boucle donc sur
  // l'écriture. Ce contrôle prouve que si cette boucle manque, le lecteur refuse le fichier au
  // lieu d'avaler des décalages hors fichier — la corruption observée le 2026-11-17 après une
  // publication qui annonçait des blocs au-delà de la fin réelle du fichier.
  if (morcele) {
    const tronc = new Uint8Array(morcele.base + Math.floor(morcele.append.length / 2));
    tronc.set(enBoite, 0);
    tronc.set(morcele.append.subarray(0, tronc.length - morcele.base), morcele.base);
    tronc.set(morcele.table.octets, morcele.table.offset);   // la table, elle, est entière
    const lu = geom.lireEnTete(tronc, ATTENDU);
    check('un ajout à moitié écrit est refusé, pas avalé',
      !lu.ok && /hors fichier/.test(lu.motif || ''), lu.motif || 'accepté à tort');
  } else {
    check('un ajout à moitié écrit est refusé, pas avalé', false, 'aucun morceau à tronquer');
  }

  // Même contenu, deux chemins : ce que donne la voie complète doit se lire à l'identique.
  const complet = new geom.EcrivainGeom({
    chunkSize: CS, height: H, seed: graine, monde: fiche, mailleVersion: 1,
    atlasSignature: ATLAS, existant: enBoite, attendu: ATTENDU,
  });
  await complet.ajouter(7, -3, tronconSynthetique(7, -3), geom.hachage('7:-3'));
  await complet.ajouter(-4, 2, tronconSynthetique(-4, 2), geom.hachage('-4:2'));
  const cacheComplet = geom.CacheGeom.depuis(await complet.publier(), ATTENDU);
  let idem = !!cache && !!cacheComplet;
  for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [1, 1], [7, -3], [-4, 2]]) {
    // Un cache nul doit se lire comme un échec, pas comme une exception qui éteindrait la suite.
    const a = cache ? await cache.charger(cx, cz) : null;
    const b = cacheComplet ? await cacheComplet.charger(cx, cz) : null;
    idem = idem && !!a && !!b && a.length === b.length
      && a.every((m, i) => m.attributs.length === b[i].attributs.length
        && m.attributs.every((at, j) => at.tableau.length === b[i].attributs[j].tableau.length
          && at.tableau.every((v, k) => v === b[i].attributs[j].tableau[k])));
  }
  check('la voie complète et la voie d’ajout décrivent le même monde', idem, '');

  // La mémoire rendue : un bloc publié n'a plus rien à faire en RAM, mais doit rester
  // récupérable depuis le fichier du serveur si une réécriture complète redevient nécessaire.
  e.marquerAjout(morcele, morcele.nouvelleTaille);
  const libere = !e.entrees.get('7,-3').brut && e.aCorpsManquants && e.nouveaux.size === 0;
  let reluApresRecharge = false;
  try {
    e.completerDepuis(agrandi, ATTENDU);
    reluApresRecharge = !!e.entrees.get('7,-3').brut && !e.aCorpsManquants;
    const reecrit = await e.publier();
    reluApresRecharge = reluApresRecharge && !!(await geom.CacheGeom.depuis(reecrit, ATTENDU));
  } catch (err) { reluApresRecharge = `exception ${err.message}`; }
  check('un bloc publié rend sa copie mémoire, et le fichier du serveur la rend à son tour',
    libere && reluApresRecharge === true,
    typeof reluApresRecharge === 'string' ? reluApresRecharge : `${e.taille} entrées après rechargement`);

  // ---- la voie d'ajout juge la réservation sans réécrire l'en-tête --------------------
  // Depuis le 2026-11-17 elle compare des longueurs (`tableOctets`) au lieu de fabriquer
  // l'en-tête bourré pour voir s'il tient — ces trois passes coûtaient 4,35 Mo d'encodage
  // par lot et faisaient l'image à 584 ms que le joueur sentait. Les deux contrôles qui
  // suivent verrouillent les deux côtés du calcul : la ligne posée au bon octet, et le refus
  // net quand ça déborde.
  const semis = new geom.EcrivainGeom({
    chunkSize: CS, height: H, seed: graine, monde: fiche, mailleVersion: 1,
    atlasSignature: ATLAS, codec: geom.CODEC_BRUT, capaciteEntrees: 16,
  });
  const ClefsSemis = [[0, 0], [1, 0], [0, 1]];
  for (const [cx, cz] of ClefsSemis) await semis.ajouter(cx, cz, tronconSynthetique(cx, cz), geom.hachage(`${cx}:${cz}`));
  const fichierSemis = await semis.publier();
  const longueurTableGravee = (o) => {
    const t = new DataView(o.buffer, o.byteOffset, o.length).getUint32(5, true);
    const s = new TextDecoder().decode(o.subarray(9, 9 + t));
    return s.slice(0, s.lastIndexOf(']}')).replace(/ +$/, '').length;
  };
  const reglagesSemis = {
    chunkSize: CS, height: H, seed: graine, monde: fiche, mailleVersion: 1, atlasSignature: ATLAS,
    codec: geom.CODEC_BRUT,                                   // même codec que le fichier semé
  };
  const unSeul = new geom.EcrivainGeom({ ...reglagesSemis, existant: fichierSemis, attendu: ATTENDU, capaciteEntrees: 16 });
  await unSeul.ajouter(5, 5, tronconSynthetique(5, 5), geom.hachage('5:5'));
  const morceauUn = unSeul.publierMorcele();
  const posteOu = 9 + longueurTableGravee(fichierSemis);
  let reluTout = false;
  if (morceauUn) {
    const out = new Uint8Array(morceauUn.nouvelleTaille);
    out.set(fichierSemis, 0);
    out.set(morceauUn.append, morceauUn.base);
    out.set(morceauUn.table.octets, morceauUn.table.offset);
    const c = geom.CacheGeom.depuis(out, ATTENDU);
    reluTout = !!c && c.stats().troncons === ClefsSemis.length + 1 && !!(await c.charger(5, 5));
  }
  check('la ligne neuve se colle à l’octet qui suit la table gravée, sans la réécrire',
    !!morceauUn && morceauUn.table.offset === posteOu && reluTout,
    morceauUn ? `offset ${morceauUn.table.offset} (attendu ${posteOu}) · ${morceauUn.table.octets.length} o` : 'refusée à tort');
  const quiDeborde = new geom.EcrivainGeom({ ...reglagesSemis, existant: fichierSemis, attendu: ATTENDU, capaciteEntrees: 16 });
  for (let i = 0; i < 40; i++) await quiDeborde.ajouter(20 + i, 7, tronconSynthetique(20 + i, 7), geom.hachage(`${20 + i}:7`));
  const morceauTrop = quiDeborde.publierMorcele();
  check('quand la table ne tient plus dans la réservation, la voie d’ajout le dit au lieu de déborder',
    morceauTrop === null && quiDeborde.appendable === false,
    morceauTrop ? `acceptée : ${morceauTrop.table.octets.length} o dans ${quiDeborde.tailleTeteFixe} o réservés`
      : `refusée pour ${quiDeborde.tailleTeteFixe} o réservés`);

  // Et si la table dépasse la place réservée, `publier` l'agrandit sans casser le fichier.
  const exigu = new geom.EcrivainGeom({
    chunkSize: CS, height: H, seed: graine, monde: fiche, mailleVersion: 1,
    atlasSignature: ATLAS, codec: geom.CODEC_BRUT, capaciteEntrees: 16,
  });
  const trop = [];
  for (let i = 0; i < 40; i++) { await exigu.ajouter(i, 3, tronconSynthetique(i, 3), null); trop.push([i, 3]); }
  const fichierExigu = await exigu.publier();
  const cacheExigu = geom.CacheGeom.depuis(fichierExigu, ATTENDU);
  check('une table plus grande que la place réservée agrandit l’en-tête sans rien casser',
    !!cacheExigu && cacheExigu.stats().troncons === 40 && !!(await cacheExigu.charger(37, 3)),
    `${cacheExigu ? cacheExigu.stats().troncons : 0}/40 · en-tête ${new DataView(fichierExigu.buffer).getUint32(5, true)} o`);
}

// ==================== MIGRATION D'EN-TÊTE ====================
// Un cache gravé avant la réservation d'en-tête ne peut pas grossir par ajout : il faudrait
// déplacer tous ses blocs. Le renvoyer depuis le navigateur est impossible (mesuré le
// 2026-11-17 sur les 618 Mo du joueur : `ERR_BLOB_OUT_OF_MEMORY`, et l'onglet écrasé avec la
// vue nue), donc le serveur copie ce qu'il a déjà et ne reçoit que la table. Ces contrôles
// rejouent ce que fait `POST /world-geometry/migrer`.
{
  const gabaritDe = (octets) => new DataView(octets.buffer, octets.byteOffset, octets.length).getUint32(5, true);
  const ClefsIle = [[0, 0], [1, 0], [0, 1], [1, 1], [-3, 5]];

  /** Ce que le serveur fait du morceau de migration : copier le corps, poser l'en-tête. */
  const migrerChezServeur = (fichier, m) => {
    const ancienDebut = 9 + gabaritDe(fichier);
    if (m.debut !== m.region.length) throw new Error('décalage de corps incohérent');
    if (m.attendu !== fichier.length) throw new Error('taille attendue mensongère');
    const out = new Uint8Array(m.debut + (fichier.length - ancienDebut));
    out.set(fichier.subarray(ancienDebut), m.debut);
    out.set(m.region, 0);
    return out;
  };

  const petit = new geom.EcrivainGeom({
    chunkSize: CS, height: H, seed: graine, monde: fiche, mailleVersion: 1,
    atlasSignature: ATLAS, capaciteEntrees: 4,
  });
  for (const [cx, cz] of ClefsIle) await petit.ajouter(cx, cz, tronconSynthetique(cx, cz), geom.hachage(`${cx}:${cz}`));
  const fichierAncien = await petit.publier();

  const e = new geom.EcrivainGeom({
    chunkSize: CS, height: H, seed: graine, monde: fiche, mailleVersion: 1,
    atlasSignature: ATLAS, existant: fichierAncien, attendu: ATTENDU, capaciteEntrees: 512,
  });
  const morceau = e.preparerMigration();
  const migrate = morceau ? migrerChezServeur(fichierAncien, morceau) : null;
  const cacheMigre = migrate && geom.CacheGeom.depuis(migrate, ATTENDU);
  const relus = [];
  if (cacheMigre) for (const [cx, cz] of ClefsIle) relus.push(await cacheMigre.charger(cx, cz));
  const fideles = ClefsIle.every(([cx, cz], i) => relus[i] && identiques(tronconSynthetique(cx, cz), relus[i]));
  const decalagesJustes = !!(morceau && cacheMigre) && cacheMigre.stats().troncons === ClefsIle.length
    && morceau.deplaces.every(([clef, nouvelO]) => {
      const [cx, cz] = clef.split(',').map(Number);
      const annonce = geom.lireEnTete(migrate, ATTENDU).tete.entrees.find((x) => x.c[0] === cx && x.c[1] === cz);
      return annonce && annonce.o === nouvelO;
    });

  check("un cache d'un autre gabarit n'est pas appendable, mais se dit migratable",
    !e.appendable && Number.isInteger(e.debutOriginal) && !!morceau,
    `gabarit en boîte ${gabaritDe(fichierAncien)} o · réservé ${e.tailleTeteFixe} o`);
  // Le contrôle qui porte tout : ce qui voyage, c'est l'en-tête seul — le morceau ne
  // porte aucun champ de corps. Les 618 Mo du joueur restent sur le disque du serveur.
  const corpsEconomie = fichierAncien.length - (9 + gabaritDe(fichierAncien));
  const sansCorps = !!morceau && !('append' in morceau) && !('paquets' in morceau);
  check('la migration n’envoie que son en-tête : pas un octet de corps ne voyage',
    !!morceau && morceau.region.length === 9 + e.tailleTeteFixe
    && morceau.attendu === fichierAncien.length && morceau.debut === morceau.region.length
    && sansCorps,
    `${morceau ? morceau.region.length : '?'} o d’en-tête envoyés pour ${corpsEconomie} o de corps laissés sur place`);
  check('le fichier migré se relit bloc pour bloc, table plus grande comprise',
    !!cacheMigre && cacheMigre.stats().troncons === ClefsIle.length && fideles,
    `${cacheMigre ? cacheMigre.stats().troncons : 0}/${ClefsIle.length} tronçons relus`);
  check('après migration, chaque bloc est annoncé là où le serveur l’a posé', decalagesJustes, '');

  e.marquerMigration(morceau, migrate.length);
  await e.ajouter(9, -9, tronconSynthetique(9, -9), geom.hachage('9:-9'));
  const apres = e.publierMorcele();
  check('la voie d’ajout reprend juste après la migration',
    e.appendable && !!apres && apres.base === migrate.length && apres.paquets.length === 1,
    apres ? `base ${apres.base} · ${apres.append.length} o ajoutés` : 'rien à ajouter');

  // Et un tronçon que le joueur repeint ? Son ancien bloc reste chez le serveur, orphelin :
  // le ruban a un trou. Ce n'est PAS un motif de refus — la copie du corps garde les
  // distances, donc chaque ligne annoncée tombe juste si elle est dans la région copiée.
  // Exiger « sans trou » a condamné le cache du joueur à une réécriture qu'aucun navigateur
  // ne sait faire (mesuré le 2026-11-17 : 25 blocs posés suffisaient à tout bloquer).
  const repeint = new geom.EcrivainGeom({
    chunkSize: CS, height: H, seed: graine, monde: fiche, mailleVersion: 1,
    atlasSignature: ATLAS, existant: fichierAncien, attendu: ATTENDU, capaciteEntrees: 512,
  });
  await repeint.ajouter(1, 0, tronconSynthetique(1, 0, ['opaque']), geom.hachage('1:0-repeint'));
  const mRepaint = repeint.preparerMigration();
  const migrateRepaint = mRepaint ? migrerChezServeur(fichierAncien, mRepaint) : null;
  const cacheRepaint = migrateRepaint && geom.CacheGeom.depuis(migrateRepaint, ATTENDU);
  let relusRepaint = 0;
  if (cacheRepaint) for (const [cx, cz] of ClefsIle) {
    if (cx === 1 && cz === 0) continue;                        // celui-là attend son ajout
    const m = await cacheRepaint.charger(cx, cz);
    if (m && m.length && m[0].attributs.length) relusRepaint++;
  }
  check('un tronçon repeint ne bloque pas la migration : ses anciens octets restent sur place',
    !!mRepaint && !!cacheRepaint && relusRepaint === ClefsIle.length - 1
    && repeint.nouveaux.has('1,0'),
    mRepaint
      ? `${relusRepaint}/${ClefsIle.length - 1} relus · ${mRepaint.annonces} lignes annoncées pour ${repeint.entrees.size} entrées`
      : `refus : ${repeint.motifMigration}`);

  // Et le tronçon repeint doit arriver derrière, par la voie d'ajout, avec ses nouveaux
  // octets — sinon la migration aurait fait perdre l'édition du joueur.
  if (mRepaint && migrateRepaint) {
    repeint.marquerMigration(mRepaint, migrateRepaint.length);
    const morceauNeuf = repeint.publierMorcele();
    let final = null;
    let fideleRepeint = false;
    if (morceauNeuf) {
      final = new Uint8Array(migrateRepaint.length + morceauNeuf.append.length);
      final.set(migrateRepaint, 0);
      final.set(morceauNeuf.append, morceauNeuf.base);
      final.set(morceauNeuf.table.octets, morceauNeuf.table.offset);
      const c = geom.CacheGeom.depuis(final, ATTENDU);
      const relu = c && await c.charger(1, 0);
      fideleRepeint = !!relu && identiques(tronconSynthetique(1, 0, ['opaque']), relu);
    }
    check('le tronçon repeint part juste après la migration et rend sa nouvelle géométrie',
      !!morceauNeuf && fideleRepeint && !!final && final.length === morceauNeuf.nouvelleTaille,
      morceauNeuf ? `${morceauNeuf.append.length} o ajoutés · table ${morceauNeuf.table.octets.length} o` : 'rien à ajouter');
  } else {
    check('le tronçon repeint part juste après la migration et rend sa nouvelle géométrie',
      false, 'migration refusée');
  }

  // Le refus qui compte vraiment : une ligne qui annonce des octets hors de la région copiée.
  // La copie du serveur ne peut pas les atteindre — les annoncer serait montrer un bloc faux.
  const horsLimites = new geom.EcrivainGeom({
    chunkSize: CS, height: H, seed: graine, monde: fiche, mailleVersion: 1,
    atlasSignature: ATLAS, existant: fichierAncien, attendu: ATTENDU, capaciteEntrees: 512,
  });
  horsLimites.entrees.get('1,1').o = horsLimites.base + 8192;
  const refuse = horsLimites.preparerMigration();
  check('un bloc annoncé hors du corps copié est refusé à la migration plutôt que faussement promis',
    !horsLimites.appendable && refuse === null && /hors du corps copié/.test(horsLimites.motifMigration),
    horsLimites.motifMigration || 'aucun motif donné');
}

// ==================== LRU ET EMPREINTES ====================
{
  const { fichier, liste } = await ecrire({});
  const cache = geom.CacheGeom.depuis(fichier, ATTENDU);
  cache.limitesMain = 3;
  for (const [cx, cz] of liste) await cache.charger(cx, cz);
  check('les blocs décompressés ne s’accumulent pas sans limite',
    cache.enMain.size <= 3 && cache.stats().decompresse === liste.length,
    `${cache.enMain.size} en main pour ${cache.stats().decompresse} décompressions`);
  check('l’empreinte écrite revient telle quelle (le jeu décide si elle est encore vraie)',
    cache.empreinteDu(-2, -2) === geom.hachage('-2:-2') && cache.empreinteDu(9, 9) === null, '');
  check('l’empreinte suit le contenu et ignore l’ordre des réglages de fiche',
    geom.cleFiche({ a: 1, b: 2 }) === geom.cleFiche({ b: 2, a: 1 })
    && geom.cleFiche({ a: 1 }) !== geom.cleFiche({ a: 2 }), '');
}

// ==================== REFUS À L'ÉCRITURE ====================
{
  const cas = [
    ['seau inconnu', [{ ...maillageSynthetique(0, 0), mat: 'bois' }]],
    ['attribut incomplet', [{ mat: 'opaque', position: maillageSynthetique(0, 0).position, normal: new Float32Array(3), uv: new Float32Array(2), color: new Float32Array(3), aLampe: new Float32Array(1), index: new Uint16Array(3) }]],
    ['trop peu de sommets', [{ ...maillageSynthetique(0, 0), position: new Float32Array(3), index: new Uint16Array(3) }]],
    ['tableau vide', []],
    ['mauvais type de tampon', [{ mat: 'opaque', ...maillageSynthetique(0, 0), position: new Float64Array(24 * 3) }]],
  ];
  let ok = true;
  const detail = [];
  for (const [nom, maillages] of cas) {
    let leve = false;
    try { geom.serialiserMaillages(maillages); } catch (err) { leve = true; }
    if (!leve) { ok = false; detail.push(nom); }
  }
  check('un mailleur incomplet ou mal typé est refusé à l’écriture', ok, detail.join(', ') || `${cas.length} cas`);
}

process.exit(summary());
