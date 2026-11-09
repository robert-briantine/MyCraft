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
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (ignored) { /* nothing to clean */ }
    throw e;
  }
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

app.get('/world-saves', (req, res) => {
  const metas = [];
  for (const name of fs.readdirSync(SAVES_DIR)) {
    if (!name.endsWith('.json')) continue; // skips in-flight .tmp siblings too
    const slot = name.slice(0, -'.json'.length);
    if (!SLOT_PATTERN.test(slot)) continue;
    metas.push(readSaveMeta(path.join(SAVES_DIR, name), slot));
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
  res.json({ success: true, removed });
});

app.listen(PORT, () => {
  console.log(`MyCraft running at http://localhost:${PORT}`);
});
