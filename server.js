const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 8080;

// Ensure custom textures directory exists
const CUSTOM_TEXTURES_DIR = path.join(__dirname, 'public', 'custom-textures');
if (!fs.existsSync(CUSTOM_TEXTURES_DIR)) {
  fs.mkdirSync(CUSTOM_TEXTURES_DIR, { recursive: true });
}

// Multer config for texture uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CUSTOM_TEXTURES_DIR),
  filename: (req, file, cb) => {
    const name = `texture_${Date.now()}_${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`;
    cb(null, name);
  },
});
const upload = multer({ storage });

// ---- world saves -------------------------------------------------------------
// The terrain regenerates identically from its seed, so what lands here is only
// the player's diff (edited blocks + position). One JSON file per slot, written
// atomically so a crash mid-write cannot leave a half-written world behind.
const SAVES_DIR = path.join(__dirname, 'saves');
if (!fs.existsSync(SAVES_DIR)) {
  fs.mkdirSync(SAVES_DIR, { recursive: true });
}

// Lettres et chiffres, accents compris : « château-du-lac » est un nom de monde
// légitime. Séparateurs, points et deux-points sont exclus d'office, donc le slot
// ne peut pas sortir du dossier des sauvegardes.
const SLOT_PATTERN = /^[\p{L}\p{N}_-]{1,32}$/u;
const SAVE_VERSION = 1;
const MAX_SAVE_BYTES = 64 * 1024 * 1024;
const MAX_NAME_LENGTH = 48;

// The slot arrives from the query string, so it never reaches `path.join` unchecked:
// anything but a single safe component is refused rather than sanitised.
function savePathFor(rawSlot) {
  const slot = String(rawSlot === undefined ? '' : rawSlot).trim().toLowerCase();
  if (!SLOT_PATTERN.test(slot)) return null;
  return path.join(SAVES_DIR, `${slot}.json`);
}

// The file comes back from disk into the game untouched, so only the envelope is
// checked here — enough to keep junk out of the saves folder.
function looksLikeSave(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (body.version !== SAVE_VERSION) return false;
  if (!Array.isArray(body.edits) || body.edits.length % 4 !== 0) return false;
  if (body.edits.length > 8_000_000) return false;
  if (!body.edits.every((n) => Number.isInteger(n))) return false;
  if (!body.player || typeof body.player !== 'object') return false;
  if (body.name != null && (typeof body.name !== 'string' || body.name.length > MAX_NAME_LENGTH)) return false;
  return ['x', 'y', 'z'].every((k) => Number.isFinite(body.player[k]));
}

function writeSaveAtomically(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // Une sauvegarde est du texte, un cache d'île des octets : même écriture atomique.
    fs.writeFileSync(tmp, text, typeof text === 'string' ? 'utf8' : undefined);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (ignored) { /* nothing to clean */ }
    throw e;
  }
}

// ---- island cache ---------------------------------------------------------
// Le relief se régénère depuis la graine mais coûte neuf minutes et demie pour toute
// l'île (mesuré le 2026-11-16 : 18 ms par tronçon × 31 416 tronçons). Le cache d'île
// est ce temps économisé : un fichier binaire écrit par le jeu, relu tel quel.
//
// Le serveur n'y comprend presque rien — il ne vérifie que la signature et la taille —
// parce que seul le jeu sait interpréter le format (`public/js/ile.js`). Ce qui compte
// ici, c'est qu'un fichier truqué ne puisse ni sortir du dossier des sauvegardes ni en
// écraser un autre.
const ISLAND_EXT = '.ile.bin';
const ISLAND_MAGIC = [0x4d, 0x43, 0x49, 0x31];   // 'MCI1'
const ISLAND_VERSION = 1;
const MAX_ISLAND_BYTES = 256 * 1024 * 1024;

function islandPathFor(rawSlot) {
  const slot = String(rawSlot === undefined ? '' : rawSlot).trim().toLowerCase();
  if (!SLOT_PATTERN.test(slot)) return null;
  return path.join(SAVES_DIR, `${slot}${ISLAND_EXT}`);
}

// Garde-fous minimaux : signature, version, et longueur d'en-tête cohérente avec la
// taille réelle du corps. Assez pour écarter un fichier tronqué ou écrit par un tout
// autre programme ; la lecture fine appartient au client.
function looksLikeIsland(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 9) return false;
  if (buf.length > MAX_ISLAND_BYTES) return false;
  for (let i = 0; i < 4; i++) if (buf[i] !== ISLAND_MAGIC[i]) return false;
  if (buf[4] !== ISLAND_VERSION) return false;
  const tete = buf.readUInt32LE(5);
  return tete > 0 && 9 + tete <= buf.length;
}

// ---- cache de géométrie ----------------------------------------------------
// Le même rôle que le cache d'île, côté maillage : le fichier porte les tampons sommets
// déjà dans la forme que réclame la carte graphique, et le jeu les repose sans rien
// recalculer. Ici non plus le serveur ne comprend pas le format (`public/js/geom-disque.js`
// seul le sait) : il borne la taille et vérifie la signature, pour qu'un fichier truqué
// ne puisse ni sortir du dossier des sauvegardes ni écraser un autre monde.
const GEOM_EXT = '.geom.bin';
const GEOM_MAGIC = [0x4d, 0x43, 0x47, 0x31];     // 'MCG1'
const GEOM_VERSION = 2;                          // v2 : canaux quantifiés (voir public/js/geom-disque.js)
const EN_TETE_FIXE_GEOM = 9;                     // magic(4) + version(1) + tailleTete(4), comme le client
const TABLE_GEOM = Buffer.from('"entrees":[');   // ce qui ouvre la table des décalages dans l'en-tête JSON
// Le réglage joueur plafonne à 2 Go ; la marge couvre l'en-tête et ses tables. Le corps
// est lu en mémoire par Express, borné ici comme côté client — les deux plafonds doivent
// se couvrir, sinon le plus grand budget promis au joueur se heurterait à un 400 « cache de
// géométrie invalide ». Mesuré le 2026-11-16 : l'île entière (33 992 tronçons) pèse de 800 Mo
// à 1,1 Go au fichier, donc 1 Go était trop juste pour tenir la promesse « île prétaillée ».
// Un `Buffer` de cette taille vit hors du tas V8 (mémoire externe), ce n'est pas un plafond
// du processus Node.
const MAX_GEOM_BYTES = 2304 * 1024 * 1024;

function geomPathFor(rawSlot) {
  const slot = String(rawSlot === undefined ? '' : rawSlot).trim().toLowerCase();
  if (!SLOT_PATTERN.test(slot)) return null;
  return path.join(SAVES_DIR, `${slot}${GEOM_EXT}`);
}

function looksLikeGeom(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 9) return false;
  if (buf.length > MAX_GEOM_BYTES) return false;
  for (let i = 0; i < 4; i++) if (buf[i] !== GEOM_MAGIC[i]) return false;
  if (buf[4] !== GEOM_VERSION) return false;
  const tete = buf.readUInt32LE(5);
  return tete > 0 && 9 + tete <= buf.length;
}


// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/custom-textures', express.static(CUSTOM_TEXTURES_DIR));

// Upload endpoint
app.post('/upload-texture', upload.array('textures', 6), (req, res) => {
  const files = req.files.map(f => ({
    filename: f.filename,
    url: `/custom-textures/${f.filename}`,
  }));
  res.json({ success: true, files });
});

// List available custom textures
app.get('/textures', (req, res) => {
  const files = fs.readdirSync(CUSTOM_TEXTURES_DIR).map(f => ({
    filename: f,
    url: `/custom-textures/${f}`,
  }));
  res.json(files);
});

// ---- world save endpoints ----------------------------------------------------
// Only the head of each file is read for a listing: the header fields (savedAt,
// cells, player) are serialised before the diff precisely so that showing the
// world picker never has to parse megabytes of block data.
const SAVE_HEAD_BYTES = 4096;

function readSaveHead(file) {
  const size = fs.statSync(file).size;
  const buffer = Buffer.alloc(Math.min(SAVE_HEAD_BYTES, size));
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, read);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function numberFrom(head, key) {
  const match = new RegExp(`"${key}":\\s*(-?\\d+(?:\\.\\d+)?)`).exec(head);
  return match ? Number(match[1]) : null;
}

// Le nom est une chaîne libre : on la relit avec le parseur JSON pour bénéficier
// de la gestion des échappements plutôt que de bricoler un découpage maison.
function stringFrom(head, key) {
  const match = new RegExp(`"${key}":\\s*("(?:[^"\\\\]|\\\\.)*"|null)`).exec(head);
  if (!match || match[1] === 'null') return null;
  try {
    const value = JSON.parse(match[1]);
    return typeof value === 'string' ? value.slice(0, MAX_NAME_LENGTH) : null;
  } catch (e) {
    return null; // en-tête tronqué sous la limite de lecture : sans gravité
  }
}

function readSaveMeta(file, slot) {
  let head = '';
  let size = 0;
  try {
    size = fs.statSync(file).size;
    head = readSaveHead(file);
  } catch (e) {
    return { slot, savedAt: null, cells: null, player: null, bytes: size, unreadable: true };
  }
  const playerMatch = /"player":\s*\{([^}]*)\}/.exec(head);
  const player = {};
  for (const axis of ['x', 'y', 'z']) {
    const match = new RegExp(`"${axis}":\\s*(-?\\d+(?:\\.\\d+)?)`).exec(playerMatch ? playerMatch[1] : '');
    player[axis] = match ? Number(match[1]) : null;
  }
  return {
    slot,
    name: stringFrom(head, 'name'),
    savedAt: numberFrom(head, 'savedAt'),
    cells: numberFrom(head, 'cells'),
    player,
    bytes: size,
  };
}

// Les deux caches binaires se listent sans être décompressés : seules quelques clés
// d'en-tête, qui sont toutes au début du fichier (le JSON de tête précède le corps).
function readBinMeta(file, magic, version) {
  let etat;
  try {
    etat = fs.statSync(file);
  } catch (e) {
    return null;
  }
  if (etat.size < 9) return { bytes: etat.size, invalide: true };
  const tete = Buffer.alloc(Math.min(2048, etat.size));
  let fd;
  let lus = 0;
  try {
    fd = fs.openSync(file, 'r');
    lus = fs.readSync(fd, tete, 0, tete.length, 0);
  } catch (e) {
    return { bytes: etat.size, invalide: true };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const texte = tete.toString('utf8', 0, lus);
  const signatureOk = magic.every((v, i) => tete[i] === v);
  return {
    bytes: etat.size,
    codec: stringFrom(texte, 'codec'),
    creeAt: numberFrom(texte, 'cree'),
    invalide: !signatureOk || tete[4] !== version,
  };
}

function readIslandMeta(slot) {
  return readBinMeta(path.join(SAVES_DIR, `${slot}${ISLAND_EXT}`), ISLAND_MAGIC, ISLAND_VERSION);
}

function readGeomMeta(slot) {
  return readBinMeta(path.join(SAVES_DIR, `${slot}${GEOM_EXT}`), GEOM_MAGIC, GEOM_VERSION);
}

app.get('/world-saves', (req, res) => {
  const metas = [];
  for (const name of fs.readdirSync(SAVES_DIR)) {
    if (!name.endsWith('.json')) continue; // skips in-flight .tmp siblings too
    const slot = name.slice(0, -'.json'.length);
    if (!SLOT_PATTERN.test(slot)) continue;
    metas.push({ ...readSaveMeta(path.join(SAVES_DIR, name), slot), ile: readIslandMeta(slot), geom: readGeomMeta(slot) });
  }
  metas.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  res.json(metas);
});

// 204 (not 404) for "no save yet": a first run is the normal case, not an error.
app.get('/world-save', (req, res) => {
  const file = savePathFor(req.query.slot);
  if (!file) return res.status(400).json({ error: 'nom de monde invalide' });
  let text;
  try {
    text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  } catch (e) {
    return res.status(500).json({ error: `sauvegarde illisible : ${e.message}` });
  }
  if (text === null) return res.status(204).end();
  res.type('application/json').send(text);
});

app.post('/world-save', express.json({ limit: MAX_SAVE_BYTES }), (req, res) => {
  const file = savePathFor(req.query.slot);
  if (!file) return res.status(400).json({ error: 'nom de monde invalide' });
  if (!looksLikeSave(req.body)) return res.status(400).json({ error: 'sauvegarde invalide' });
  const text = JSON.stringify(req.body);
  try {
    writeSaveAtomically(file, text);
  } catch (e) {
    return res.status(500).json({ error: `écriture impossible : ${e.message}` });
  }
  res.json({ success: true, bytes: Buffer.byteLength(text), edits: req.body.edits.length / 4 });
});

app.delete('/world-save', (req, res) => {
  const file = savePathFor(req.query.slot);
  if (!file) return res.status(400).json({ error: 'nom de monde invalide' });
  let removed = false;
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      removed = true;
    }
  } catch (e) {
    return res.status(500).json({ error: `suppression impossible : ${e.message}` });
  }
  // Effacer un monde efface aussi son île cuite : sans le diff du joueur, ce fichier
  // n'est plus rien d'autre que du relief régénérable, et le laisser traîner ferait
  // redémarrer un « nouveau monde » sur un cache orphelin.
  let ileRetiree = false;
  const ile = islandPathFor(req.query.slot);
  if (ile) {
    try {
      if (fs.existsSync(ile)) { fs.unlinkSync(ile); ileRetiree = true; }
    } catch (e) {
      return res.status(500).json({ error: `suppression de l'île impossible : ${e.message}` });
    }
  }
  // Idem pour les triangles cuits : sans le diff du joueur ils ne décrivent plus le monde.
  let geomRetiree = false;
  const geom = geomPathFor(req.query.slot);
  if (geom) {
    try {
      if (fs.existsSync(geom)) { fs.unlinkSync(geom); geomRetiree = true; }
    } catch (e) {
      return res.status(500).json({ error: `suppression de la géométrie impossible : ${e.message}` });
    }
  }
  res.json({ success: true, removed, ileRemoved: ileRetiree, geomRemoved: geomRetiree });
});

// ---- island cache endpoints -------------------------------------------------
// 204 pour « pas encore de cache » : c'est le cas normal d'un monde neuf, pas une erreur.
app.get('/world-island', (req, res) => {
  const file = islandPathFor(req.query.slot);
  if (!file) return res.status(400).json({ error: 'nom de monde invalide' });
  let etat;
  try {
    etat = fs.statSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(204).end();
    return res.status(500).json({ error: `lecture impossible : ${e.message}` });
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(etat.size));
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
});

const lireCorpsIle = express.raw({
  type: ['application/octet-stream', 'application/octet-binary', 'application/unknown'],
  limit: MAX_ISLAND_BYTES,
});

app.put('/world-island', lireCorpsIle, (req, res) => {
  const file = islandPathFor(req.query.slot);
  if (!file) return res.status(400).json({ error: 'nom de monde invalide' });
  if (!looksLikeIsland(req.body)) return res.status(400).json({ error: 'cache d’île invalide' });
  try {
    writeSaveAtomically(file, req.body);
  } catch (e) {
    return res.status(500).json({ error: `écriture impossible : ${e.message}` });
  }
  res.json({ success: true, bytes: req.body.length });
});

app.delete('/world-island', (req, res) => {
  const file = islandPathFor(req.query.slot);
  if (!file) return res.status(400).json({ error: 'nom de monde invalide' });
  let removed = false;
  try {
    if (fs.existsSync(file)) { fs.unlinkSync(file); removed = true; }
  } catch (e) {
    return res.status(500).json({ error: `suppression impossible : ${e.message}` });
  }
  res.json({ success: true, removed });
});

// ---- cache de géométrie endpoints -------------------------------------------
// `MC_TRACE=1` journalise les requêtes du cache : utile pour savoir si une requête qui pend
// entre au moins dans le gestionnaire (une sonde muette ne disculpe personne).
if (process.env.MC_TRACE) {
  app.use((req, res, next) => {
    if (String(req.url).includes('world-geometry')) {
      const t0 = Date.now();
      // Le statut et la taille du fichier à la fin de la requête : seul un regard sur les
      // deux permet de dire QUI a changé la taille du cache entre deux ajouts (mesuré le
      // 2026-11-17, un 409 de `/append` dans `tests/persistence.mjs` sans requête visible
      // entre les deux).
      res.on('finish', () => {
        let taille = 'absent';
        try {
          const f = geomPathFor(req.query && req.query.slot);
          if (f) taille = String(fs.statSync(f).size);
        } catch (e) { /* pas de fichier */ }
        console.log(`[trace] ${new Date().toISOString().slice(11, 19)} ${req.method} ${req.url}`
          + ` ct=${req.headers['content-type'] || '-'} cl=${req.headers['content-length'] || '-'}`
          + ` → ${res.statusCode} en ${Date.now() - t0} ms · fichier ${taille} o`);
      });
    }
    next();
  });
}

const lireCorpsGeom = express.raw({
  type: ['application/octet-stream', 'application/octet-binary', 'application/unknown'],
  limit: MAX_GEOM_BYTES,
});

app.get('/world-geometry', (req, res) => {
  const file = geomPathFor(req.query.slot);
  if (!file) return res.status(400).json({ error: 'nom de monde invalide' });
  let etat;
  try {
    etat = fs.statSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(204).end();
    return res.status(500).json({ error: `lecture impossible : ${e.message}` });
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(etat.size));
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
});

app.put('/world-geometry', lireCorpsGeom, (req, res) => {
  const file = geomPathFor(req.query.slot);
  if (!file) return res.status(400).json({ error: 'nom de monde invalide' });
  if (!looksLikeGeom(req.body)) return res.status(400).json({ error: 'cache de géométrie invalide' });
  try {
    writeSaveAtomically(file, req.body);
  } catch (e) {
    return res.status(500).json({ error: `écriture impossible : ${e.message}` });
  }
  res.json({ success: true, bytes: req.body.length });
});

// ---- publication par ajout -------------------------------------------------
// Réécrire tout le fichier à chaque lot de tronçons coûtait, mesuré le 2026-11-17,
// 1 496 ms d'envoi pour 15 Mo déjà en boîte — et le jeu publie tous les douze tronçons.
// Le client n'envoie donc plus que ce qui est neuf : des blocs collés à la fin du fichier,
// et des lignes de table collées à la fin de la table. L'en-tête ayant une longueur fixe
// (réservée par l'écrivain) et son pied `]}` attendant à poste fixe, rien ne bouge jamais
// ailleurs — et un ajout interrompu ne laisse que des octets orphelins que le lecteur
// ignore, la table ne les citant pas.

/**
 * `fs.writeSync` peut n'écrire qu'une partie du tampon : il faut boucler. Sans ça, une
 * table d'en-tête écrite à moitié annonce des blocs qui ne sont pas dans le fichier —
 * mesuré le 2026-11-17 : « bloc hors fichier », et tout le cache jeté au rechargement.
 */
function ecrireFdEnVers(fd, buf, position) {
  let fait = 0;
  while (fait < buf.length) {
    const ecrit = fs.writeSync(fd, buf, fait, buf.length - fait, position + fait);
    if (ecrit <= 0) throw new Error(`écriture interrompue à ${fait}/${buf.length} octets`);
    fait += ecrit;
  }
}

function ecrireEnVers(file, buf, position) {
  const fd = fs.openSync(file, 'r+');
  try {
    ecrireFdEnVers(fd, buf, position);
  } finally {
    fs.closeSync(fd);
  }
}

app.post('/world-geometry/append', lireCorpsGeom, (req, res) => {
  const file = geomPathFor(req.query.slot);
  if (!file) return res.status(400).json({ error: 'nom de monde invalide' });
  // Sans en-tête de type reconnu, `express.raw` ne parse pas et laisse `body` indéfini :
  // mieux vaut un 415 explicite qu'une exception en 500.
  if (!Buffer.isBuffer(req.body)) return res.status(415).json({ error: 'corps binaire absent' });
  const base = Number(req.query.base);
  if (!Number.isInteger(base) || base < 9) return res.status(400).json({ error: 'taille de base invalide' });
  let etat;
  try {
    etat = fs.statSync(file);
  } catch (e) {
    return res.status(409).json({ error: 'aucun fichier à prolonger' });
  }
  // La base doit coller à ce qui est réellement sur le disque : c'est la seule garde contre
  // deux onglets qui écriraient le même monde en se croyant chacun seul.
  if (etat.size !== base) return res.status(409).json({ error: 'taille divergente', size: etat.size });
  if (base + req.body.length > MAX_GEOM_BYTES) return res.status(413).json({ error: 'cache trop volumineux' });
  try {
    ecrireEnVers(file, req.body, base);
  } catch (e) {
    return res.status(500).json({ error: `écriture impossible : ${e.message}` });
  }
  res.json({ success: true, bytes: base + req.body.length });
});

app.put('/world-geometry/tete', lireCorpsGeom, (req, res) => {
  const file = geomPathFor(req.query.slot);
  if (!file) return res.status(400).json({ error: 'nom de monde invalide' });
  if (!Buffer.isBuffer(req.body)) return res.status(415).json({ error: 'corps binaire absent' });
  const offset = Number(req.query.offset);
  if (!Number.isInteger(offset) || offset < 0) return res.status(400).json({ error: 'décalage invalide' });
  try {
    const etat = fs.statSync(file);
    if (etat.size < 9) return res.status(409).json({ error: 'fichier trop court' });
    const entete = Buffer.alloc(9);
    const lecture = fs.openSync(file, 'r');
    try { fs.readSync(lecture, entete, 0, 9, 0); } finally { fs.closeSync(lecture); }
    const region = 9 + entete.readUInt32LE(5);
    if (etat.size < region) return res.status(409).json({ error: 'fichier trop court pour cet en-tête' });
    if (offset === 0) {
      // Création : l'en-tête complet doit être cohérent avec lui-même et avec le fichier.
      if (!looksLikeGeom(req.body)) return res.status(400).json({ error: 'en-tête invalide' });
      if (req.body.readUInt32LE(5) !== entete.readUInt32LE(5)) {
        return res.status(409).json({ error: 'gabarit d’en-tête différent' });
      }
      if (req.body.length !== region) return res.status(400).json({ error: `en-tête de ${region} octets attendu` });
    } else {
      // Ajout de lignes : le client ne peut toucher QUE la région d'en-tête réservée. La
      // signature et le pied `]}` deviennent donc intouchables par cette voie.
      if (offset < 9) return res.status(400).json({ error: 'la signature de tête est protégée' });
      if (offset + req.body.length > region) return res.status(400).json({ error: 'hors de la région d’en-tête' });
    }
    ecrireEnVers(file, req.body, offset);
  } catch (e) {
    return res.status(500).json({ error: `écriture impossible : ${e.message}` });
  }
  res.json({ success: true, bytes: req.body.length });
});

// ---- migration d'en-tête ---------------------------------------------------
// Un cache gravé avant la réservation d'en-tête ne peut pas grossir par ajout : il
// faudrait déplacer tous ses blocs, donc réécrire ses 618 Mo. Or les renvoyer depuis le
// navigateur est matériellement impossible — mesuré le 2026-11-17 sur le cache du joueur :
// `ERR_BLOB_OUT_OF_MEMORY` à 592 Mo, et l'onglet écrasé quand on tente la vue `Uint8Array`
// nue. Ces octets sont déjà sur ce disque : le serveur les copie lui-même, le jeu ne lui
// envoie que sa table des décalages. Le serveur, fidèle à sa règle, ne parse pas le format
// — il borne, vérifie la signature, et copie.
const TETE_MAX_BYTES = 64 * 1024 * 1024;         // la table de toute l'île fait ~4 Mo ; au-delà, c'est une erreur

app.post('/world-geometry/migrer', lireCorpsGeom, (req, res) => {
  const file = geomPathFor(req.query.slot);
  if (!file) return res.status(400).json({ error: 'nom de monde invalide' });
  const attendu = Number(req.query.attendu);
  const debut = Number(req.query.debut);
  if (!Buffer.isBuffer(req.body)) return res.status(415).json({ error: 'corps binaire absent' });
  const region = req.body.length;
  if (!Number.isInteger(attendu) || attendu < EN_TETE_FIXE_GEOM + 16) {
    return res.status(400).json({ error: 'taille de fichier attendue invalide' });
  }
  // Le corps reçu EST l'en-tête complet (signature, version, gabarit, table, bourrage, pied) :
  // il doit donc faire exactement la longueur que lui-même annonce.
  if (!Number.isInteger(debut) || debut !== region) {
    return res.status(400).json({ error: 'en-tête reçu incohérent avec le décalage annoncé' });
  }
  if (region < 32 || region > TETE_MAX_BYTES) return res.status(400).json({ error: 'table de décalages invraisemblable' });
  if (!looksLikeGeom(req.body)) return res.status(400).json({ error: 'en-tête de cache invalide' });
  const tracer = process.env.MC_TRACE ? (...x) => console.log(`[migrer] ${new Date().toISOString().slice(11, 19)} ${x.join(' ')}`) : () => {};
  tracer(`gardes OK · région ${region} o · attendu ${attendu}`);
  // La région est `JSON + bourrage + ]}` à poste fixe : le pied se vérifie donc sur les
  // deux derniers octets. Surtout pas de regex ici — mesuré le 2026-11-17, un
  // `.replace(/ +$/, '')` sur 524 Ko d'espaces de bourrage fait tourner le processus à 70 %
  // de CPU sans jamais répondre, et le serveur entier devient muet.
  if (req.body[region - 2] !== 0x5d || req.body[region - 1] !== 0x7d) {
    return res.status(400).json({ error: 'table de décalages sans pied' });
  }
  if (req.body.indexOf(TABLE_GEOM) < 0) return res.status(400).json({ error: 'table de décalages mal formée' });
  tracer('table lisible');
  let ancienDebut = 0;
  try {
    const etat = fs.statSync(file);
    if (etat.size !== attendu) return res.status(409).json({ error: 'taille divergente', size: etat.size });
    const tete = Buffer.alloc(EN_TETE_FIXE_GEOM);
    const lecture = fs.openSync(file, 'r');
    try { fs.readSync(lecture, tete, 0, tete.length, 0); } finally { fs.closeSync(lecture); }
    for (let i = 0; i < 4; i++) if (tete[i] !== GEOM_MAGIC[i]) return res.status(400).json({ error: 'signature de cache absente' });
    if (tete[4] !== GEOM_VERSION) return res.status(400).json({ error: 'version de cache inconnue' });
    ancienDebut = EN_TETE_FIXE_GEOM + tete.readUInt32LE(5);
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(409).json({ error: 'aucun cache à migrer' });
    return res.status(500).json({ error: `lecture impossible : ${e.message}` });
  }
  if (ancienDebut <= EN_TETE_FIXE_GEOM || ancienDebut >= attendu) {
    return res.status(400).json({ error: 'corps de cache vide' });
  }
  const nouveau = debut + (attendu - ancienDebut);
  if (nouveau > MAX_GEOM_BYTES) return res.status(413).json({ error: 'cache trop volumineux' });
  tracer(`copie · ancienDebut ${ancienDebut} → debut ${debut} · ${attendu - ancienDebut} o · fichier ${nouveau} o`);

  const tmp = `${file}.${process.pid}.migr.tmp`;
  const MORCEAU = 8 * 1024 * 1024;
  const aCopier = attendu - ancienDebut;
  try {
    const source = fs.openSync(file, 'r');
    const cible = fs.openSync(tmp, 'w');
    try {
      fs.ftruncateSync(cible, nouveau);
      const tampon = Buffer.alloc(MORCEAU);
      let fait = 0;
      while (fait < aCopier) {
        const vouloir = Math.min(MORCEAU, aCopier - fait);
        const lus = fs.readSync(source, tampon, 0, vouloir, ancienDebut + fait);
        if (lus <= 0) throw new Error(`copie interrompue à ${fait}/${aCopier} octets`);
        ecrireFdEnVers(cible, tampon.subarray(0, lus), debut + fait);
        fait += lus;
      }
      ecrireFdEnVers(cible, req.body, 0);
    } finally {
      fs.closeSync(source);
      fs.closeSync(cible);
    }
    // On ne remplace le fichier que si le candidat se présente bien : la tête doit être
    // exactement celle que le client a envoyée, et la taille celle annoncée. (`looksLikeGeom`
    // est inutilisable ici : il exige que tout l'en-tête tienne dans le tampon lu.)
    const verif = Buffer.alloc(EN_TETE_FIXE_GEOM);
    const lecture = fs.openSync(tmp, 'r');
    try { fs.readSync(lecture, verif, 0, verif.length, 0); } finally { fs.closeSync(lecture); }
    if (!verif.equals(req.body.subarray(0, EN_TETE_FIXE_GEOM)) || fs.statSync(tmp).size !== nouveau) {
      throw new Error('cache migré mal formé, abandonné avant remplacement');
    }
    fs.renameSync(tmp, file);
    tracer(`remplacé · ${nouveau} o`);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (ignored) { /* rien à nettoyer */ }
    return res.status(500).json({ error: `migration impossible : ${e.message}` });
  }
  res.json({ success: true, bytes: nouveau, annonces: region });
});

app.delete('/world-geometry', (req, res) => {
  const file = geomPathFor(req.query.slot);
  if (!file) return res.status(400).json({ error: 'nom de monde invalide' });
  let removed = false;
  try {
    if (fs.existsSync(file)) { fs.unlinkSync(file); removed = true; }
  } catch (e) {
    return res.status(500).json({ error: `suppression impossible : ${e.message}` });
  }
  res.json({ success: true, removed });
});

app.listen(PORT, () => {
  console.log(`MyCraft running at http://localhost:${PORT}`);
});
