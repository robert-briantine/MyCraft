// Épreuve de bout en bout de la migration d'en-tête, contre le vrai serveur.
//
// Pourquoi ce fichier existe : un cache gravé avant la réservation d'en-tête ne peut pas
// grossir par ajout — il faudrait déplacer tous ses blocs. Le renvoyer depuis le navigateur
// est matériellement impossible (mesuré le 2026-11-17 sur les 618 Mo du joueur :
// `ERR_BLOB_OUT_OF_MEMORY`, et l'onglet écrasé avec la vue `Uint8Array` nue). C'est donc le
// serveur qui copie ses propres octets, le jeu ne lui envoyant que sa table. Ces contrôles
// vérifient que cette route copie juste, refuse ce qu'elle ne doit pas toucher, et rend un
// fichier que le jeu relit intégralement.
//
// Le serveur de développement doit tourner sur http://localhost:8080 (comme les autres
// suites). Usage: node tests/geom-migration.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReporter } from './browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = process.env.MC_URL || 'http://localhost:8080';
const SLOT = `mig-${process.pid}`;
const VIERGE = `mig-vierge-${process.pid}`;
const { check, summary } = makeReporter();

async function charger(relative) {
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  const tmp = path.join(os.tmpdir(), `mycraft-geom-mig-${process.pid}.mjs`);
  fs.writeFileSync(tmp, source);
  try { return await import(pathToFileURL(tmp).href); } finally { fs.rmSync(tmp, { force: true }); }
}
const geom = await charger('public/js/geom-disque.js');

const CS = 16, H = 128, graine = 42;
const fiche = { ile: true, rayonIle: 300, foret: 40, village: true };
const ATLAS = 'atlas-256x128-ab12cd34';
const ATTENDU = { chunkSize: CS, height: H, seed: graine, monde: fiche, mailleVersion: 1, atlasSignature: ATLAS };
const N = 60;

/** Un mailleur reconnaissable : 30 sommets dont chaque valeur encode sa place. */
function maillage(cx, cz) {
  const nb = 30;
  const position = new Float32Array(nb * 3), normal = new Float32Array(nb * 3), uv = new Float32Array(nb * 2);
  const color = new Float32Array(nb * 3), aLampe = new Float32Array(nb), index = new Uint16Array(nb * 3);
  for (let i = 0; i < nb; i++) {
    position[i * 3] = cx * CS + (i % CS); position[i * 3 + 1] = (i * 7) % H; position[i * 3 + 2] = cz * CS + ((i * 5) % CS);
    normal[i * 3] = 1; normal[i * 3 + 1] = -1; normal[i * 3 + 2] = 0;
    uv[i * 2] = (i % 16) / 16; uv[i * 2 + 1] = ((i * 3) % 8) / 8;
    color[i * 3] = (i % 251) / 255; color[i * 3 + 1] = 0.5; color[i * 3 + 2] = 0.25;
    aLampe[i] = ((i * 13) % 16) / 15;
  }
  for (let i = 0; i < nb * 3; i++) index[i] = (i * 7) % nb;
  return [{ mat: 'opaque', position, normal, uv, color, aLampe, index }];
}

const binaire = (corps) => ({
  method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: corps,
  signal: AbortSignal.timeout(10000),
});
const envoyer = (url, o = {}) => fetch(url, { ...o, signal: o.signal || AbortSignal.timeout(10000) });
const lireFichier = async (slot) => {
  const r = await envoyer(`${URL}/world-geometry?slot=${slot}`);
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
};
const gabaritDe = (octets) => new DataView(octets.buffer, octets.byteOffset, octets.length).getUint32(5, true);

const clefs = [];
for (let i = 0; i < N; i++) clefs.push([(i % 9) - 4, Math.floor(i / 9) - 2]);

try {
  // --- un fichier d'ancien gabarit : réservation minimale, table ajustée au ras des blocs
  const ancien = new geom.EcrivainGeom({
    chunkSize: CS, height: H, seed: graine, monde: fiche, mailleVersion: 1,
    atlasSignature: ATLAS, capaciteEntrees: 4,
  });
  for (const [cx, cz] of clefs) await ancien.ajouter(cx, cz, maillage(cx, cz), geom.hachage(`${cx}:${cz}`));
  const fichierAncien = await ancien.publier();
  let rep = await envoyer(`${URL}/world-geometry?slot=${SLOT}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from(fichierAncien),
    signal: AbortSignal.timeout(10000),
  });
  check('un cache d’ancien gabarit se pose chez le serveur', rep.ok && fichierAncien.length > 0,
    `${fichierAncien.length} o · en-tête ${gabaritDe(fichierAncien)} o`);

  // --- l'écrivain d'aujourd'hui ne peut pas ajouter à ce fichier-là
  const e = new geom.EcrivainGeom({
    chunkSize: CS, height: H, seed: graine, monde: fiche, mailleVersion: 1,
    atlasSignature: ATLAS, existant: fichierAncien, attendu: ATTENDU, capaciteEntrees: 4096,
  });
  const m = e.preparerMigration();
  check("l'écrivain refuse d'ajouter à un en-tête qui n'a pas le gabarit réservé",
    !e.appendable && !!m && Number.isInteger(m.debutOriginal ?? e.debutOriginal),
    `réservé ${e.tailleTeteFixe} o pour un en-tête de ${gabaritDe(fichierAncien)} o`);

  // --- les gardes doivent mordre AVANT de toucher au disque
  const g = {};
  const garde = async (nom, url, corps) => {
    const r = await envoyer(url, binaire(corps));
    g[nom] = `${r.status}`;
    return r.status;
  };
  const avant = await lireFichier(SLOT);
  await garde('sansCorps', `${URL}/world-geometry/migrer?slot=${SLOT}&attendu=${m.attendu}&debut=${m.debut}`, null);
  await garde('tailleMensongere', `${URL}/world-geometry/migrer?slot=${SLOT}&attendu=${m.attendu + 7}&debut=${m.debut}`, m.region);
  await garde('decalageFaux', `${URL}/world-geometry/migrer?slot=${SLOT}&attendu=${m.attendu}&debut=${m.debut + 4}`, m.region);
  await garde('tableFausse', `${URL}/world-geometry/migrer?slot=${SLOT}&attendu=${m.attendu}&debut=64`, Buffer.alloc(64, 0x41));
  await garde('fichierAbsent', `${URL}/world-geometry/migrer?slot=${VIERGE}&attendu=${m.attendu}&debut=${m.debut}`, m.region);
  const apresGardes = await lireFichier(SLOT);
  check('les gardes refusent sans jamais toucher au fichier',
    g.sansCorps === '400' && g.tailleMensongere === '409' && g.decalageFaux === '400'
    && g.tableFausse === '400' && g.fichierAbsent === '409'
    && !!avant && !!apresGardes && avant.length === apresGardes.length,
    JSON.stringify(g));

  // --- la migration elle-même : une requête, et ce qui voyage n'est que l'en-tête
  const t0 = Date.now();
  rep = await envoyer(`${URL}/world-geometry/migrer?slot=${SLOT}&attendu=${m.attendu}&debut=${m.debut}`, binaire(m.region));
  const json = await rep.json().catch(() => ({}));
  const msMigration = Date.now() - t0;
  const corpsEconomie = fichierAncien.length - (9 + gabaritDe(fichierAncien));
  check('la migration tient en une requête qui ne transporte que len-tête',
    rep.ok && json.success && m.region.length === 9 + e.tailleTeteFixe
    && !('append' in m) && !('paquets' in m),
    `${m.region.length} o envoyés · ${corpsEconomie} o de corps laissés sur place · ${msMigration} ms`);

  // --- le fichier migré doit être relu intégralement, blocs compris
  const relu = await lireFichier(SLOT);
  const lu = relu && geom.lireEnTete(relu, ATTENDU);
  const cache = lu && lu.ok ? geom.CacheGeom.depuis(relu, ATTENDU) : null;
  let lus = 0;
  let fideles = 0;
  if (cache) for (const [cx, cz] of clefs) {
    const maillages = await cache.charger(cx, cz);
    if (maillages && maillages.length && maillages[0].attributs.length) {
      lus++;
      if (maillages[0].attributs[0].tableau.length === maillage(cx, cz)[0].position.length) fideles++;
    }
  }
  check('le fichier migré se relit depuis le serveur, tronçons et canaux intacts',
    !!cache && lus === N && fideles === N && relu.length === json.bytes,
    `${lus}/${N} lus · ${fideles}/${N} fidèles · fichier ${relu ? relu.length : '?'} o · annoncé ${json.bytes} o`);
  check("len-tête migré porte bien la réservation qui permet dajouter",
    !!relu && gabaritDe(relu) === e.tailleTeteFixe, `gabarit ${relu ? gabaritDe(relu) : '?'} o`);

  // --- et la voie d'ajout doit reprendre immédiatement, sans rien réécrire
  e.marquerMigration(m, json.bytes);
  await e.ajouter(77, -33, maillage(77, -33), geom.hachage('77:-33'));
  const morcele = e.publierMorcele();
  let appendOk = false;
  let apr = null;
  if (morcele) {
    const a = await envoyer(`${URL}/world-geometry/append?slot=${SLOT}&base=${morcele.base}`, binaire(Buffer.from(morcele.append)));
    const ja = await a.json().catch(() => ({}));
    const t = await envoyer(`${URL}/world-geometry/tete?slot=${SLOT}&offset=${morcele.table.offset}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(morcele.table.octets), signal: AbortSignal.timeout(10000),
    });
    if (a.ok && t.ok) e.marquerAjout(morcele, ja.bytes);
    apr = await lireFichier(SLOT);
    const c2 = apr && geom.CacheGeom.depuis(apr, ATTENDU);
    appendOk = a.ok && t.ok && !!c2 && c2.stats().troncons === N + 1 && !!morcele
      && morcele.base === json.bytes && morcele.table.octets.length < 4096;
    check('juste après la migration, la voie d’ajout reprend au pied du fichier',
      appendOk,
      morcele ? `base ${morcele.base} · ${morcele.append.length} o de blocs · ${morcele.table.octets.length} o de table` : 'rien à ajouter');
  } else {
    check('juste après la migration, la voie d’ajout reprend au pied du fichier', false, 'publierMorcele muet');
  }
} finally {
  for (const slot of [SLOT, VIERGE]) {
    try { await envoyer(`${URL}/world-geometry?slot=${slot}`, { method: 'DELETE', signal: AbortSignal.timeout(10000) }); } catch (ignored) { /* monde jeté */ }
  }
}

process.exit(summary() ? 1 : 0);
