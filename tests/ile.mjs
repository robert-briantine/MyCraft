// Vérifie hors navigateur le format du cache d'île : aller-retour des trois codecs,
// garde-fous sur un fichier venu du disque (truqué, tronqué, écrit pour un autre monde),
// trous laissés par une cuisson partielle, et la convention de numérotation qui fait
// retrouver un tronçon dans sa tranche.
// Usage: node tests/ile.mjs
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
  const tmp = path.join(os.tmpdir(), `mycraft-ile-${path.basename(relative, '.js')}-${process.pid}.mjs`);
  fs.writeFileSync(tmp, source);
  try { return await import(pathToFileURL(tmp).href); } finally { fs.rmSync(tmp, { force: true }); }
}

const ile = await charger('public/js/ile.js');

const CS = 8;                 // tronçons de test plus petits : les fichiers restent lisibles
const H = 64;
const VOLUME = CS * CS * H;
const graine = 1234567;
const fiche = { ile: true, rayonIle: 300, foret: 40, village: true };

/** Un tronçon reconnaissable : sol à une hauteur qui varie, minerais ponctuels, eau. */
function tronconSynthetique(cx, cz, height = H, cs = CS) {
  const volume = cs * cs * height;
  const d = new Uint8Array(volume);
  const cells = cs * cs;
  const h0 = ((Math.abs(cx * 7 + cz * 13) % 20) + 4) | 0;
  for (let x = 0; x < cs; x++) {
    for (let z = 0; z < cs; z++) {
      const h = Math.max(1, Math.min(height - 1, h0 + ((x + z) % 3)));
      for (let y = 0; y < h; y++) {
        let v = 1;                                            // pierre
        if (y === h - 1) v = 2;                               // herbbe
        else if (y === h - 3 && ((x * 5 + z * 3 + y) % 17) === 0) v = 21;   // minerai
        d[x + z * cs + y * cells] = v;
      }
      if (((cx + cz) & 1) === 0 && h < 8) {
        for (let y = h; y < 8; y++) d[x + z * cs + y * cells] = 3;           // eau
      }
    }
  }
  return d;
}

const bornesCarre = { cx: -2, cz: -2, nx: 5, nz: 5, rayon: null, chunkSize: CS, contient() { return true; } };
const ATTENDU = { seed: graine, monde: fiche, chunkSize: CS, height: H };

async function cuire({ donnerTroncon, codec, bornes = bornesCarre, slabChunks = 7, cs = CS, h = H, monde = fiche, seed = graine }) {
  return ile.encoderIle({
    chunkSize: cs, height: h, seed, monde, bornes, donnerTroncon, codec, slabChunks,
  });
}

// ==================== ALLER-RETOUR DES CODECS ====================
for (const codec of [ile.CODEC_DEFLATE, ile.CODEC_RLE, ile.CODEC_BRUT]) {
  const attendu = new Map();
  const fichier = await cuire({
    codec,
    donnerTroncon: async (cx, cz) => {
      const d = tronconSynthetique(cx, cz);
      attendu.set(`${cx},${cz}`, d);
      return d;
    },
  });
  const cache = ile.CacheIle.depuis(fichier, ATTENDU);
  let identiques = 0;
  let premierMotif = '';
  if (cache) {
    // Le DEFLATE lit par tranche : on la réchauffe d'abord, comme le fait le jeu.
    for (const [cle] of attendu) {
      const [cx, cz] = cle.split(',').map(Number);
      const no = cache.trancheDe(cx, cz);
      if (no >= 0) await cache.rechauffer(no);
    }
    for (const [cle, d] of attendu) {
      const [cx, cz] = cle.split(',').map(Number);
      const lu = cache.troncon(cx, cz);
      if (lu && lu.length === d.length && d.every((v, i) => v === lu[i])) identiques++;
      else if (!premierMotif) premierMotif = `${cle}${lu ? ` taille ${lu.length}` : ' absent'}`;
    }
  }
  check(`codec ${codec} : tout ce qui est écrit se relit à l'identique`,
    !!cache && identiques === attendu.size,
    `${identiques}/${attendu.size} tronçons${premierMotif ? ` · ${premierMotif}` : ''} · ${(fichier.length / 1024).toFixed(1)} Ko`);
}

// ==================== LE FICHIER VIENT DU DISQUE : IL EST SUSPECT ====================
const sain = await cuire({ codec: ile.CODEC_RLE, donnerTroncon: async (cx, cz) => tronconSynthetique(cx, cz) });

const verifier = (octets, opts) => ile.lireEnTete(octets, { seed: graine, monde: fiche, chunkSize: CS, height: H, ...opts });

check('un fichier sans signature est refusé', (() => {
  const abime = Uint8Array.from(sain);
  abime[0] = 0x58;
  return verifier(abime).ok === false;
})(), verifier(Uint8Array.from([1, 2, 3, 4, 5])).motif || 'refusé');

check('une version inconnue est refusée', (() => {
  const abime = Uint8Array.from(sain);
  abime[4] = 99;
  const r = verifier(abime);
  return r.ok === false && /version/.test(r.motif);
})(), '');

check('un fichier tronqué en plein corps est refusé', (() => {
  const r = verifier(sain.subarray(0, sain.length - 40));
  return r.ok === false && /tranche|hors fichier/.test(r.motif);
})(), verifier(sain.subarray(0, sain.length - 40)).motif);

check('la graine du monde doit être celle qui a cuit le fichier', (() => {
  const r = verifier(sain, { seed: graine + 1 });
  return r.ok === false && /graine/.test(r.motif);
})(), ile.lireEnTete(sain, { seed: graine + 1, monde: fiche, chunkSize: CS, height: H }).motif);

check('une fiche de génération différente refuse le cache', (() => {
  const r = verifier(sain, { monde: { ...fiche, rayonIle: 900 } });
  return r.ok === false && /fiche/.test(r.motif);
})(), ile.lireEnTete(sain, { seed: graine, monde: { ...fiche, rayonIle: 900 }, chunkSize: CS, height: H }).motif);

check('des tronçons d’une autre géométrie refusent le cache', (() => {
  const r = verifier(sain, { chunkSize: 16 });
  return r.ok === false && /tronçons/.test(r.motif);
})(), ile.lireEnTete(sain, { seed: graine, monde: fiche, chunkSize: 16, height: H }).motif);

check('des tranches rendues discontinues sont refusées', (() => {
  // On salit l'en-tête JSON plutôt que le corps : la table des décalages devient fausse.
  const texte = new TextDecoder().decode(sain);
  const decale = texte.replace(/"tranches":\[\{"o":0,"l":(\d+)/, (m, n) => `"tranches":[{"o":1,"l":${n}`);
  const enc = new TextEncoder().encode(decale);
  const candidat = new Uint8Array(Math.min(sain.length, enc.length));
  candidat.set(enc.subarray(0, candidat.length));
  const r = verifier(candidat);
  return r.ok === false;
})(), '');

check('un fichier vide ou absent se dit sans exception',
  ile.lireEnTete(null).ok === false && ile.lireEnTete(new Uint8Array(0)).ok === false
  && ile.CacheIle.depuis(new Uint8Array(3)) === null, '');

// ==================== CUISSON PARTIELLE : LES TROUS ====================
{
  const manquant = new Set(['0,0', '-1,2', '2,-2']);
  const ecrits = [];
  const fichier = await cuire({
    codec: ile.CODEC_RLE,
    slabChunks: 4,                                  // petites tranches : les trous les traversent
    donnerTroncon: async (cx, cz) => {
      const cle = `${cx},${cz}`;
      if (manquant.has(cle)) return null;
      ecrits.push(cle);
      return tronconSynthetique(cx, cz);
    },
  });
  const cache = ile.CacheIle.depuis(fichier, ATTENDU);
  const trousOk = cache && [...manquant].every((cle) => {
    const [cx, cz] = cle.split(',').map(Number);
    return cache.aLeTroncon(cx, cz) === false && cache.troncon(cx, cz) === null;
  });
  let relus = 0;
  for (const cle of ecrits) {
    const [cx, cz] = cle.split(',').map(Number);
    const lu = cache.troncon(cx, cz);
    const d = tronconSynthetique(cx, cz);
    if (lu && d.every((v, i) => v === lu[i])) relus++;
  }
  check('les tronçons non cuits restent des trous que le jeu régénérera',
    !!cache && trousOk && relus === ecrits.length,
    `${relus}/${ecrits.length} relus · ${cache ? cache.stats().troncons : '?'} annoncés`);
  check('et les trous ne décalent pas la numérotation des tranches',
    !!cache && cache.stats().troncons === ecrits.length,
    `${cache ? cache.stats().troncons : '?'} annoncés pour ${ecrits.length} écrits`);
}

// ==================== RLE : LES CAS QUI FONT MAL ====================
{
  const cs = 4, h = 300;                             // au-delà de 255 : compteur sur plusieurs octets
  const volume = cs * cs * h;
  const cas = {
    'tout identique': new Uint8Array(volume),
    'un coup sur deux': new Uint8Array(volume).map((_, i) => i % 2),
    'la valeur 255 existe': (() => { const d = new Uint8Array(volume).fill(7); d[9] = 255; d[10] = 255; return d; })(),
    'colonnes toutes différentes': (() => {
      const d = new Uint8Array(volume);
      for (let c = 0; c < cs * cs; c++) d.fill(c + 1, c * h, (c + 1) * h);
      return d;
    })(),
  };
  let ok = true;
  const detail = [];
  for (const [nom, d] of Object.entries(cas)) {
    const flux = ile.encoderColonnes(d, cs, h);
    const sortie = new Uint8Array(volume);
    ile.decoderColonnes(flux, sortie, cs, h);
    const identique = d.every((v, i) => v === sortie[i]);
    if (!identique) { ok = false; detail.push(nom); }
  }
  check('le codec RLE tient les colonnes longues, alternées et la valeur 255',
    ok, detail.join(', ') || `${Object.keys(cas).length} cas`);
}

// ==================== EMPREINTE ET FENÊTRE ====================
{
  const a = ile.cleFiche({ seed: 7, monde: { ile: true, rayonIle: 900, foret: 30 }, chunkSize: 16, height: 128 });
  const b = ile.cleFiche({ seed: 7, monde: { foret: 30, rayonIle: 900, ile: true }, chunkSize: 16, height: 128 });
  const c = ile.cleFiche({ seed: 7, monde: { ile: true, rayonIle: 901, foret: 30 }, chunkSize: 16, height: 128 });
  const d = ile.cleFiche({ seed: 8, monde: { ile: true, rayonIle: 900, foret: 30 }, chunkSize: 16, height: 128 });
  check('l’empreinte ignore l’ordre des réglages mais suit la graine et le rayon',
    a === b && a !== c && a !== d, `${a.slice(0, 24)}…`);
}
{
  const b = ile.bornesIle({ ile: true, rayonIle: 1600 }, 16);
  const coins = [[b.cx, b.cz], [b.cx + b.nx - 1, b.cz], [b.cx, b.cz + b.nz - 1]];
  // Le centre de (60,60) est à 1 369 cubes : dans le disque. Celui de (100,100) est à
  // 2 274 cubes : hors du disque malgré la fenêtre carrée qui l'encadre.
  const dedans = b.contient(0, 0) && b.contient(60, 60);
  const dehors = !b.contient(100, 100);
  check('la fenêtre entoure l’île mais ne cuit pas les coins de mer',
    b.nx === b.nz && b.nx > 100 && !coins.some(([cx, cz]) => b.contient(cx, cz)) && dedans && dehors,
    `${b.nx}×${b.nz} tronçons · ${coins.filter(([cx, cz]) => b.contient(cx, cz)).length} coin(s) retenu(s) · (100,100) retenu=${!dehors}`);
  const continent = ile.bornesIle({ ile: false, rayonIle: 1600, coteContinent: 640 }, 16);
  check('un continent se borne sur son carré constructible',
    continent.contient(0, 0) && continent.rayon == null
    && !continent.contient(continent.cx + continent.nx, continent.cz),
    `${continent.nx}×${continent.nz}`);
}

// ==================== TRANCHE FROIDE ====================
{
  const fichier = await cuire({ codec: ile.CODEC_DEFLATE, slabChunks: 8, donnerTroncon: async (cx, cz) => tronconSynthetique(cx, cz) });
  const cache = ile.CacheIle.depuis(fichier, ATTENDU);
  const froid = cache.troncon(0, 0);
  const chauffe = await cache.rechauffer(cache.trancheDe(0, 0));
  const chaud = cache.troncon(0, 0);
  const d = tronconSynthetique(0, 0);
  check('une tranche DEFLATE non réchauffée rend null plutôt qu’un terrain faux',
    froid === null && chauffe === true && !!chaud && d.every((v, i) => v === chaud[i]),
    `froid=${froid === null ? 'null' : 'données'} · froides=${cache.stats().froides}`);

  const { preparerTranches } = ile;
  const neuf = ile.CacheIle.depuis(fichier, ATTENDU);
  const faites = await preparerTranches(neuf, [[0, 0], [1, 0], [0, 1]], { max: 2 });
  check('le réchauffement anticipé prépare les tranches demandées',
    faites >= 1 && neuf.troncon(0, 0) !== null, `${faites} tranche(s) préparée(s)`);
}

// ==================== ÉCRIVAIN INCRÉMENTAL ====================
{
  // Une cuisson étalée doit pouvoir publier un cache partiel, puis le compléter sans
  // repasser par la génération de ce qui est déjà cuit.
  const e = new ile.EcrivainIle({
    chunkSize: CS, height: H, seed: graine, monde: fiche, bornes: bornesCarre,
    codec: ile.CODEC_RLE, slabChunks: 5,
  });
  const ordre = [];
  for (let j = 0; j < bornesCarre.nz; j++)
    for (let i = 0; i < bornesCarre.nx; i++) ordre.push([bornesCarre.cx + i, bornesCarre.cz + j]);

  let publie = 0;
  for (const [cx, cz] of ordre.slice(0, 12)) { await e.ajouter(cx, cz, tronconSynthetique(cx, cz)); }
  const premier = await e.publier();
  const demi = ile.CacheIle.depuis(premier, ATTENDU);
  publie = demi ? demi.stats().troncons : -1;

  for (const [cx, cz] of ordre.slice(12)) { await e.ajouter(cx, cz, tronconSynthetique(cx, cz)); }
  const second = await e.publier();
  const complet = ile.CacheIle.depuis(second, ATTENDU);
  let relus = 0;
  if (complet) {
    for (const [cx, cz] of ordre) {
      const lu = complet.troncon(cx, cz);
      const d = tronconSynthetique(cx, cz);
      if (lu && d.every((v, i) => v === lu[i])) relus++;
    }
  }
  check('l’écrivain publie un cache partiel puis le complète sans rien perdre',
    publie === 12 && !!complet && relus === ordre.length,
    `${publie} au premier publication · ${relus}/${ordre.length} relus après complément`);

  const horsOrdre = new ile.EcrivainIle({
    chunkSize: CS, height: H, seed: graine, monde: fiche, bornes: bornesCarre, codec: ile.CODEC_RLE,
  });
  await horsOrdre.ajouter(-2, -1, tronconSynthetique(-2, -1));
  let refuse = false;
  try { await horsOrdre.ajouter(-2, -2, tronconSynthetique(-2, -2)); } catch (err) { refuse = /hors ordre/.test(err.message); }
  check('un tronçon demandé hors ordre de parcours est refusé', refuse, 'la numérotation des tranches serait faussée');

  let volumeRefuse = false;
  try { await new ile.EcrivainIle({ chunkSize: CS, height: H, seed: graine, monde: fiche, bornes: bornesCarre })
    .ajouter(-2, -2, new Uint8Array(7)); } catch (err) { volumeRefuse = /attendu/.test(err.message); }
  check('un tronçon du mauvais volume est refusé à l’écriture', volumeRefuse, '');
}

process.exit(summary());
