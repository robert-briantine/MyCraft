/**
 * Suite du magasin de géométrie **bureau** (Tauri).
 *
 * Ce qu'elle garde :
 *  1. le codec de trames `MCGF` — les mêmes octets que ceux qu'affirment les tests Rust de
 *     `src-tauri/src/world.rs::brut`, donc un des deux côtés qui dérive fait sonner l'autre ;
 *  2. que le magasin du bureau propose réellement une **voie d'ajout** : avant le 2026-11-17
 *     elle répondait `{ conflict: true }` sans essayer, et chaque publication réécrivait le
 *     fichier entier en base64 sur le fil principal (mesuré 218 ms à 50 Mo, 433 ms à 100 Mo)
 *     — exactement les saccades décrites par le joueur sur son PC Windows ;
 *  3. qu'un désaccord avec le disque se rend en `{ conflict }` et non en exception ;
 *  4. que le filet base64 reste utilisable quand la voie binaire n'est pas là (repli
 *     `postMessage` de Tauri, Android).
 *
 * Le noyau simulé ci-dessous rejoue les règles du magasin Rust à l'aide du **même codec**,
 * pas d'une réécriture du format ; les gardes elles-mêmes sont jugées côté Rust par cargo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReporter } from './browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rapport = makeReporter();
const check = rapport.check;

/**
 * `public/js/*.js` est en ESM mais le dépôt est `"type": "commonjs"` : Node les lirait en
 * CommonJS. On les pose dans un dossier temporaire marqué module, en gardant les noms pour
 * que l'import relatif `./geom-cadre.js` suive.
 */
const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'mycraft-bureau-'));
fs.writeFileSync(path.join(BAC, 'package.json'), JSON.stringify({ type: 'module' }));
for (const nom of ['saves.js', 'geom-cadre.js']) {
  fs.copyFileSync(path.join(ROOT, 'public', 'js', nom), path.join(BAC, nom));
}
const sauvegardes = await import(pathToFileURL(path.join(BAC, 'saves.js')).href);
const cadre = await import(pathToFileURL(path.join(BAC, 'geom-cadre.js')).href);
const { createSaveStore } = sauvegardes;
const { cadrerReponse, lireRequete, OPS, STATUTS } = cadre;

process.on('exit', () => { try { fs.rmSync(BAC, { recursive: true, force: true }); } catch { /* déjà parti */ } });

const GEOM_MAGIC = [0x4d, 0x43, 0x47, 0x31];   // 'MCG1'
const GEOM_VERSION = 2;
const EN_TETE_FIXE = 9;
const TABLE = Buffer.from('"entrees":[');

const versBase64 = (u8) => Buffer.from(u8).toString('base64');
const deBase64 = (texte) => new Uint8Array(Buffer.from(texte, 'base64'));

function ressembleACache(octets) {
  if (octets.length < EN_TETE_FIXE) return false;
  for (let i = 0; i < 4; i++) if (octets[i] !== GEOM_MAGIC[i]) return false;
  if (octets[4] !== GEOM_VERSION) return false;
  const tete = new DataView(octets.buffer, octets.byteOffset, octets.byteLength).getUint32(5, true);
  return tete > 0 && EN_TETE_FIXE + tete <= octets.length;
}

/** En-tête au format du client : fixe | JSON bourré d'espaces | pied `]}` à poste fixe. */
function teteCache(tailleRegion, contenu = '{"entrees":[') {
  const corps = new Uint8Array(tailleRegion);
  corps.set(GEOM_MAGIC, 0);
  corps[4] = GEOM_VERSION;
  new DataView(corps.buffer).setUint32(5, tailleRegion - EN_TETE_FIXE, true);
  corps.set(new TextEncoder().encode(contenu), EN_TETE_FIXE);
  corps.fill(0x20, EN_TETE_FIXE + contenu.length, tailleRegion - 2);
  corps[tailleRegion - 2] = 0x5d;   // ']'
  corps[tailleRegion - 1] = 0x7d;   // '}'
  return corps;
}

/**
 * Noyau Tauri simulé : il ne connaît que des octets et les mêmes règles que
 * `world::brut` (garde de base, région réservée, copie de migration).
 */
function creerNoyau({ binaire = true, fichier = null } = {}) {
  const etat = { fichier, appels: [], geometrie: { brute: 0, base64: 0 } };
  const taille = () => (etat.fichier ? etat.fichier.length : null);

  const noyau = {
    async invoke(cmd, args) {
      const brut = args instanceof Uint8Array;
      etat.appels.push({ cmd, brut, octets: brut ? args.length : (typeof args?.payload === 'string' ? args.payload.length : 0) });
      if (cmd === 'geom_brut') {
        if (!binaire) throw new Error('commande geom_brut inconnue');
        if (!brut) throw new Error('corps attendu en octets bruts');
        etat.geometrie.brute++;
        const c = lireRequete(args);
        switch (c.op) {
          case OPS.sonder:
            return cadrerReponse({ op: c.op, statut: STATUTS.ok, a: 1 });
          case OPS.lire:
            return etat.fichier
              ? cadrerReponse({ op: c.op, statut: STATUTS.ok, a: etat.fichier.length, corps: etat.fichier })
              : cadrerReponse({ op: c.op, statut: STATUTS.ok, a: 0 });
          case OPS.ecrire:
            if (!ressembleACache(c.corps)) return cadrerReponse({ op: c.op, statut: STATUTS.erreur });
            etat.fichier = new Uint8Array(c.corps);
            return cadrerReponse({ op: c.op, statut: STATUTS.ok, a: etat.fichier.length });
          case OPS.ajouter: {
            if (c.a < EN_TETE_FIXE) return cadrerReponse({ op: c.op, statut: STATUTS.conflit });
            if (taille() === null || taille() !== c.a) return cadrerReponse({ op: c.op, statut: STATUTS.conflit });
            const suite = new Uint8Array(c.a + c.corps.length);
            suite.set(etat.fichier, 0);
            suite.set(c.corps, c.a);
            etat.fichier = suite;
            return cadrerReponse({ op: c.op, statut: STATUTS.ok, a: suite.length });
          }
          case OPS.poserTete: {
            if (taille() === null) return cadrerReponse({ op: c.op, statut: STATUTS.erreur });
            const vue = new DataView(etat.fichier.buffer, etat.fichier.byteOffset, etat.fichier.byteLength);
            const region = EN_TETE_FIXE + vue.getUint32(5, true);
            if (c.a >= EN_TETE_FIXE && c.a + c.corps.length > region) {
              return cadrerReponse({ op: c.op, statut: STATUTS.conflit });
            }
            if (c.a < EN_TETE_FIXE) return cadrerReponse({ op: c.op, statut: STATUTS.conflit });
            etat.fichier.set(c.corps, c.a);
            return cadrerReponse({ op: c.op, statut: STATUTS.ok, a: c.corps.length });
          }
          case OPS.migrer: {
            const region = c.corps.length;
            if (c.b !== region) return cadrerReponse({ op: c.op, statut: STATUTS.conflit });
            if (region < 32 || !ressembleACache(c.corps)) return cadrerReponse({ op: c.op, statut: STATUTS.conflit });
            if (c.corps[region - 2] !== 0x5d || c.corps[region - 1] !== 0x7d) {
              return cadrerReponse({ op: c.op, statut: STATUTS.conflit });
            }
            if (!Buffer.from(c.corps).includes(TABLE)) return cadrerReponse({ op: c.op, statut: STATUTS.conflit });
            if (taille() !== c.a) return cadrerReponse({ op: c.op, statut: STATUTS.conflit });
            const vue = new DataView(etat.fichier.buffer, etat.fichier.byteOffset, etat.fichier.byteLength);
            const ancienDebut = EN_TETE_FIXE + vue.getUint32(5, true);
            if (ancienDebut <= EN_TETE_FIXE || ancienDebut >= c.a) {
              return cadrerReponse({ op: c.op, statut: STATUTS.conflit });
            }
            const nouveau = new Uint8Array(region + (c.a - ancienDebut));
            nouveau.set(c.corps, 0);
            nouveau.set(etat.fichier.subarray(ancienDebut), region);
            etat.fichier = nouveau;
            return cadrerReponse({ op: c.op, statut: STATUTS.ok, a: nouveau.length });
          }
          default:
            throw new Error(`opération inconnue : ${c.op}`);
        }
      }
      if (cmd === 'load_geometry') {
        etat.geometrie.base64++;
        return etat.fichier ? versBase64(etat.fichier) : null;
      }
      if (cmd === 'save_geometry') {
        etat.geometrie.base64++;
        etat.fichier = deBase64(args.payload);
        return etat.fichier.length;
      }
      if (cmd === 'clear_geometry') { const avait = !!etat.fichier; etat.fichier = null; return avait; }
      if (cmd === 'geometry_meta') return null;
      return null;
    },
  };
  return { noyau, etat };
}

// ---------------------------------------------------------------------------
// 1. Le codec, jugé sur les mêmes octets que les tests Rust.
// ---------------------------------------------------------------------------
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const depuisHex = (h) => new Uint8Array(h.match(/../g).map((p) => parseInt(p, 16)));

check(
  'la trame d’ajout est la même octet pour octet qu’en Rust',
  hex(cadre.cadrerRequete({ op: OPS.ajouter, slot: 'ab', a: 6029640, b: 0, corps: new Uint8Array([0xde, 0xad]) }))
    === '4d4347460103020048015c0000000000000000000000000000000000000000006162dead',
);
check(
  'la trame de migration porte les deux champs devant le corps',
  hex(cadre.cadrerRequete({ op: OPS.migrer, slot: 'default', a: 25847, b: 524620, corps: new Uint8Array([1, 2, 3, 4]) }))
    === '4d43474601050700f7640000000000004c01080000000000000000000000000064656661756c7401020304',
);
check(
  'la réponse annonce opération, statut et taille',
  hex(cadrerReponse({ op: OPS.ajouter, statut: STATUTS.ok, a: 676095460 }))
    === '4d43474601030000e4654c28000000000000000000000000',
);
{
  const relue = lireRequete(depuisHex('4d43474601050700f7640000000000004c01080000000000000000000000000064656661756c7401020304'));
  check('aller-retour de trame sans perte', relue.op === OPS.migrer && relue.slot === 'default'
    && relue.a === 25847 && relue.b === 524620 && hex(relue.corps) === '01020304', `relu ${JSON.stringify(relue.op)}`);
  let refuse = 0;
  for (const mauvaise of [new Uint8Array(4), depuisHex('00'.repeat(32)), depuisHex('ffffffff'.padEnd(64, '0'))]) {
    try { lireRequete(mauvaise); } catch { refuse++; }
  }
  check('les trames grossières sont refusées', refuse === 3, `${refuse}/3 refusées`);
  try {
    cadre.cadrerRequete({ op: OPS.lire, slot: 'a'.repeat(33) });
    check('un nom hors limites ne peut pas être encadré', false);
  } catch { check('un nom hors limites ne peut pas être encadré', true); }
}

// ---------------------------------------------------------------------------
// 2. La voie d'ajout existe et ne paie que les blocs neufs.
// ---------------------------------------------------------------------------
{
  const semis = teteCache(4096);
  const { noyau, etat } = creerNoyau({ fichier: semis });
  const magasin = createSaveStore({ slot: 'test', tauriCore: noyau });

  const premier = await magasin.appendGeometry(new Uint8Array([1, 2, 3, 4]), semis.length);
  check('l’ajout part par la voie binaire', etat.geometrie.brute > 0 && etat.geometrie.base64 === 0,
    `brut ${etat.geometrie.brute} · base64 ${etat.geometrie.base64}`);
  check('l’ajout accepte la bonne base et rend la nouvelle taille',
    premier.success === true && premier.bytes === semis.length + 4, JSON.stringify(premier));

  const appelAjout = etat.appels.filter((a) => a.cmd === 'geom_brut').pop() || { octets: -1 };
  check('seuls les blocs neufs voyagent, pas le fichier entier',
    appelAjout.octets === 32 + 'test'.length + 4,
    `${appelAjout.octets} o envoyés pour un fichier de ${semis.length + 4} o`);

  const faux = await magasin.appendGeometry(new Uint8Array([9]), semis.length + 4 + 1);
  check('un désaccord de taille se rend en conflit, pas en exception',
    faux.conflict === true, JSON.stringify(faux));
  check('le refus n’a rien écrit sur le disque', etat.fichier.length === semis.length + 4);

  const tete = await magasin.putGeometryHead(new Uint8Array([0x7b, 0x7d]), 'test', 64);
  check('la table se repose dans la réservation', tete.success === true && etat.fichier[64] === 0x7b);
  const horsReservation = await magasin.putGeometryHead(new Uint8Array(4096), 'test', 64);
  check('hors de la réservation, la table est refusée', horsReservation.conflict === true, JSON.stringify(horsReservation));
}

// ---------------------------------------------------------------------------
// 3. Migration : le jeu n'envoie que sa table, le magasin copie son corps.
// ---------------------------------------------------------------------------
{
  const ancienneRegion = 64;
  const corps = new Uint8Array(300);
  for (let i = 0; i < corps.length; i++) corps[i] = (i * 7) & 0xff;
  const ancien = new Uint8Array(ancienneRegion + corps.length);
  ancien.set(teteCache(ancienneRegion), 0);
  ancien.set(corps, ancienneRegion);

  const { noyau, etat } = creerNoyau({ fichier: ancien });
  const magasin = createSaveStore({ slot: 'test', tauriCore: noyau });
  const table = teteCache(128, '{"entrees":[{"0,0":{"o":0}}');
  const migre = await magasin.migrateGeometry(table, { attendu: ancien.length, debut: 128 });
  check('la migration est acceptée et rend la taille du fichier',
    migre.success === true && migre.bytes === 128 + corps.length, JSON.stringify(migre));
  check('le corps a été copié par le magasin, intact',
    hex(etat.fichier.subarray(128)) === hex(corps));
  const envoi = etat.appels.filter((a) => a.cmd === 'geom_brut').pop() || { octets: -1 };
  check('le jeu n’a envoyé que la table, jamais le corps',
    envoi.octets === 32 + 'test'.length + table.length, `${envoi.octets} o envoyés`);

  const refusee = await magasin.migrateGeometry(table, { attendu: ancien.length + 1, debut: 128 });
  check('une taille annoncée fausse est un conflit', refusee.conflict === true, JSON.stringify(refusee));
}

// ---------------------------------------------------------------------------
// 4. Lecture, et filet base64 quand le brut n'est pas là.
// ---------------------------------------------------------------------------
{
  const cache = teteCache(4096);
  const { noyau } = creerNoyau({ fichier: cache });
  const magasin = createSaveStore({ slot: 'test', tauriCore: noyau });
  const relu = await magasin.loadGeometry();
  check('la lecture binaire rend les octets du fichier',
    relu instanceof Uint8Array && hex(relu) === hex(cache), relu && `${relu.length} o`);

  const absent = createSaveStore({ slot: 'vide', tauriCore: creerNoyau({}).noyau });
  check('absence de cache lu = null, pas une erreur', (await absent.loadGeometry()) === null);
}
{
  const cache = teteCache(4096);
  const { noyau, etat } = creerNoyau({ binaire: false, fichier: null });
  const magasin = createSaveStore({ slot: 'test', tauriCore: noyau });
  const grave = await magasin.saveGeometry(cache);
  check('sans voie binaire, la réécriture repasse par base64',
    etat.geometrie.base64 === 1 && etat.geometrie.brute === 0 && grave === cache.length,
    `base64 ${etat.geometrie.base64} · brut ${etat.geometrie.brute}`);
  const relu = await magasin.loadGeometry();
  check('le filet base64 relit fidèlement', relu instanceof Uint8Array && hex(relu) === hex(cache));
  const ajout = await magasin.appendGeometry(new Uint8Array([1, 2]), cache.length);
  check('sans binaire, l’ajout reste un refus poli (comportement d’avant)',
    ajout.conflict === true, JSON.stringify(ajout));
  check('le sondage n’est tenté qu’une fois', etat.appels.filter((a) => a.cmd === 'geom_brut').length === 1,
    `${etat.appels.filter((a) => a.cmd === 'geom_brut').length} tentatives`);
}

// ---------------------------------------------------------------------------
// 5. Garde de non-régression du bug d'origine.
// ---------------------------------------------------------------------------
{
  const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'saves.js'), 'utf8');
  check('append/putHead/migrate ne sont plus des refus inconditionnels',
    !/async appendGeometry\(\)\s*\{\s*return \{ conflict: true/.test(source)
      && !/async putGeometryHead\(\)\s*\{\s*return \{ conflict: true/.test(source)
      && !/async migrateGeometry\(\)\s*\{\s*return \{ conflict: true/.test(source),
    'un des trois refuse encore sans regarder le disque');
  const worldRs = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'world.rs'), 'utf8');
  check('le magasin bureau attend bien la version de format du client',
    /const GEOM_VERSION: u8 = 2;/.test(worldRs), 'GEOM_VERSION figé sur autre chose que 2');
  check('le plafond du magasin bureau couvre le budget du joueur',
    Number(worldRs.match(/const MAX_GEOM_BYTES: u64 = (\d+) \* 1024/)[1]) >= 2048,
    worldRs.match(/const MAX_GEOM_BYTES: u64 = [^;]+;/)[0]);
}

process.exit(rapport.summary() ? 1 : 0);
