// Vérifie la persistance du monde sur le disque : écriture en continu du diff du
// joueur, rechargement à l'identique, mondes multiples et réinitialisation.
// Usage: node tests/persistence.mjs [url]
// Needs the static server running (npm start / node server.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openGame, waitForBoot, makeReporter } from './browser.mjs';

const URL = process.argv[2] || 'http://localhost:8080';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAVES_DIR = path.join(ROOT, 'saves');

const { check, summary } = makeReporter();

// Un slot dédié : la suite n'écrase jamais le monde du joueur.
const stamp = Date.now().toString(36);
const SLOT_A = `e2e-a-${stamp}`;
const SLOT_B = `e2e-b-${stamp}`;
const saveFile = (slot) => path.join(SAVES_DIR, `${slot}.json`);
const readSave = (slot) => {
  try {
    return JSON.parse(fs.readFileSync(saveFile(slot), 'utf8'));
  } catch (e) {
    return null;
  }
};
const urlFor = (slot) => `${URL}/?world=${slot}`;

const consoleErrors = [];
const badResponses = [];
function watch(page) {
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });
}

// Hash of a sparse sample of the terrain: two loads of the same seed must agree
// cube for cube, ores included. Les cubes que la suite édite elle-même sont exclus
// des deux passages : ils font partie du diff du joueur, pas du relief, et l'échantillon
// tombe parfois pile dessus selon l'altitude d'apparition.
const FINGERPRINT = (skip) => {
  const mc = window.__mc;
  mc.streamAll();
  const ignores = new Set((skip || []).map(([x, y, z]) => `${x},${y},${z}`));
  let h = 0;
  let ores = 0;
  const ORES = [mc.BLOCK.COAL, mc.BLOCK.IRON, mc.BLOCK.GOLD, mc.BLOCK.DIAMOND];
  for (let x = -40; x <= 40; x += 3) {
    for (let z = -40; z <= 40; z += 3) {
      for (let y = 0; y < 64; y += 5) {
        if (ignores.has(`${x},${y},${z}`)) continue;
        const b = mc.world.getBlock(x, y, z);
        h = (Math.imul(h, 31) + b) | 0;
        if (ORES.includes(b)) ores++;
      }
    }
  }
  return { hash: h >>> 0, ores, pending: mc.world.pendingChunks };
};

// Where section 2 will write, computed once and reused so both fingerprints skip
// exactly the same columns.
const EDIT_CELLS = () => {
  const mc = window.__mc;
  const bx = Math.floor(mc.camera.position.x);
  const bz = Math.floor(mc.camera.position.z);
  const by = Math.floor(mc.camera.position.y) - 2;
  return [[bx, by, bz], [bx + 1, by, bz], [bx, by, bz + 16], [bx, by - 1, bz]];
};

const { browser, page } = await openGame(urlFor(SLOT_A));
watch(page);

// ---------------------------------------------------- 1. première ouverture
const boot = await page.evaluate(() => ({
  ready: window.__mc.worldReady(),
  slot: window.__mc.SAVE_SLOT,
  name: window.__mc.worldName(),
  startDisabled: document.getElementById('start-btn').disabled,
  status: document.getElementById('world-status').textContent.trim(),
  edits: window.__mc.editCount(),
  interval: window.__mc.AUTOSAVE_INTERVAL_MS,
}));
check('le monde est chargé avant de pouvoir jouer', boot.ready && !boot.startDisabled,
  `ready=${boot.ready} disabled=${boot.startDisabled}`);
check('le slot vient de ?world=', boot.slot === SLOT_A, `slot=${boot.slot}`);
check('un monde sans sauvegarde annonce la nouveauté', /Nouveau monde/.test(boot.status), boot.status);
check('un monde neuf n’a pas encore de nom', boot.name === null, JSON.stringify(boot.name));
check('aucune modification au démarrage', boot.edits === 0, `edits=${boot.edits}`);

const editCells = await page.evaluate(EDIT_CELLS);
const first = await page.evaluate(FINGERPRINT, editCells);
check('le relief contient des minerais', first.ores > 0, `${first.ores} échantillons`);
check('le monde se charge jusqu’au bout', first.pending === 0, `pending=${first.pending}`);

// ---------------------------------------------------- 2. écriture en continu
// Blocks placed where the player stands: one dug out, two built, at chunk borders
// so the neighbour remesh path is exercised too.
const placed = await page.evaluate((coords) => {
  const mc = window.__mc;
  const ids = [mc.BLOCK.OBSIDIAN, mc.BLOCK.GLASS, mc.BLOCK.GOLD, mc.BLOCK.AIR];
  const cells = coords.map(([x, y, z], i) => [x, y, z, ids[i]]);
  for (const [x, y, z, id] of cells) mc.setBlock(x, y, z, id);
  return { cells, count: mc.editCount() };
}, editCells);
check('les cubes posés sont en mémoire', placed.count >= 4, `count=${placed.count}`);

// No explicit save anywhere: the autosave tick has to notice the change on its own.
await page.waitForFunction(() => !window.__mc.savePending(), null, { timeout: 15000 });
const written = readSave(SLOT_A);
check('l’autosave a écrit le fichier sans intervention', written !== null, saveFile(SLOT_A));
if (written) {
  const seen = new Set();
  for (let i = 0; i < written.edits.length; i += 4) {
    seen.add(`${written.edits[i]},${written.edits[i + 1]},${written.edits[i + 2]}:${written.edits[i + 3]}`);
  }
  const okCells = placed.cells.every(([x, y, z, id]) => seen.has(`${x},${y},${z}:${id}`));
  check('le fichier porte les cubes modifiés', written.version === 1 && okCells,
    `version=${written.version} edits=${written.edits.length / 4} manquant=${placed.cells.filter(([x, y, z, id]) => !seen.has(`${x},${y},${z}:${id}`)).length}`);
  check('le compte de cubes est cohérent', written.cells === written.edits.length / 4,
    `cells=${written.cells}`);
  check('la position du joueur est enregistrée',
    Number.isFinite(written.player?.x) && Number.isFinite(written.player?.y) && Number.isFinite(written.player?.z),
    JSON.stringify(written.player));
  check('les graines sont consignées dans la sauvegarde',
    written.seed && written.seed.terrain === 42, JSON.stringify(written.seed));
}

// Le fichier doit aussi suivre un déplacement, sans nouvelle édition de blocs.
const beforeMove = readSave(SLOT_A);
await page.evaluate(() => {
  const mc = window.__mc;
  const nx = Math.round(mc.camera.position.x + 3.5);
  const nz = Math.round(mc.camera.position.z - 2.5);
  // Un joueur qui se déplace marche : il atterrit sur la colonne, pas à l'altitude
  // qu'il avait ailleurs. Le poser au sol naturel évite que `settle` ne le croie
  // engagé dans le relief et ne le rejette à l'apparition, ce qui ferait échouer la
  // reprise de position pour une raison qui n'est pas celle testée ici.
  const sol = mc.getTerrainHeight(nx, nz);
  mc.player.flyMode = false;
  mc.releaseAll();
  mc.camera.position.set(nx + 0.5, sol + 4 + 1.62, nz + 0.5);
  mc.player.velocity.set(0, 0, 0);
  for (let i = 0; i < 120 && !mc.player.onGround; i++) mc.step(1 / 60);
  mc.flushSave();
});
await page.waitForFunction(() => !window.__mc.savePending(), null, { timeout: 15000 });
const afterMove = readSave(SLOT_A);
check('un déplacement déclenche une écriture',
  beforeMove && afterMove && (afterMove.player.x !== beforeMove.player.x || afterMove.player.z !== beforeMove.player.z),
  `${beforeMove?.player?.x},${beforeMove?.player?.z} → ${afterMove?.player?.x},${afterMove?.player?.z}`);

// ---------------------------------------------------- 3. reprise après rechargement
await page.reload({ waitUntil: 'load' });
await waitForBoot(page);
const resumed = await page.evaluate((cells) => {
  const mc = window.__mc;
  mc.streamAll();
  return {
    got: cells.map(([x, y, z, id]) => mc.world.getBlock(x, y, z) === id),
    edits: mc.editCount(),
    status: document.getElementById('world-status').textContent.trim(),
    state: mc.playerState(),
  };
}, placed.cells);
check('les cubes modifiés retrouvent leur valeur après rechargement',
  resumed.got.every(Boolean), JSON.stringify(resumed.got));
check('le diff est rejoué intégralement', resumed.edits >= 4, `edits=${resumed.edits}`);
check('l’écran d’accueil dit avoir retrouvé le monde', /retrouvé/.test(resumed.status), resumed.status);
check('le joueur reprend sa place',
  Math.abs(resumed.state.x - afterMove.player.x) < 1.5
  && Math.abs(resumed.state.z - afterMove.player.z) < 1.5,
  `${afterMove.player.x},${afterMove.player.z} → ${resumed.state.x.toFixed(2)},${resumed.state.z.toFixed(2)}`);

const second = await page.evaluate(FINGERPRINT, editCells);
check('le relief régénéré est identique (minerais compris)',
  second.hash === first.hash, `${first.hash} vs ${second.hash}`);

// ---------------------------------------------------- 4. second monde indépendant
const pageB = await browser.newPage({ viewport: { width: 1024, height: 640 } });
watch(pageB);
await pageB.goto(urlFor(SLOT_B), { waitUntil: 'load' });
await waitForBoot(pageB);
const other = await pageB.evaluate(() => {
  const mc = window.__mc;
  const bx = Math.floor(mc.camera.position.x);
  const by = Math.floor(mc.camera.position.y) - 2;
  const bz = Math.floor(mc.camera.position.z);
  mc.setBlock(bx, by, bz, mc.BLOCK.LAVA);
  mc.flushSave();
  return { x: bx, y: by, z: bz };
});
await pageB.waitForFunction(() => !window.__mc.savePending(), null, { timeout: 15000 });
check('le second monde a son propre fichier', readSave(SLOT_B) !== null, saveFile(SLOT_B));
check('les deux mondes coexistent dans la liste',
  (readSave(SLOT_A) !== null) && (readSave(SLOT_B) !== null));

const crossA = await page.evaluate((o) => window.__mc.world.getBlock(o.x, o.y, o.z) !== window.__mc.BLOCK.LAVA, other);
check('un monde n’contamine pas l’autre', crossA);

// La liste de l'écran d'accueil reflète le disque.
const listed = await page.evaluate(() => window.__mc.listWorlds());
check('la liste des mondes cite les deux slots',
  listed.some((w) => w.slot === SLOT_A) && listed.some((w) => w.slot === SLOT_B),
  listed.map((w) => w.slot).join(', '));
const metaA = listed.find((w) => w.slot === SLOT_A);
check('la liste expose les métadonnées du monde',
  metaA && metaA.cells > 0 && Number.isFinite(metaA.savedAt) && metaA.player,
  JSON.stringify(metaA));

// Supprimer le monde non actif laisse l'actif intact.
await page.evaluate((slot) => window.__mc.deleteWorld(slot), SLOT_B);
await page.waitForFunction(
  (slot) => ![...document.querySelectorAll('.world-pick')].some((b) => b.dataset.slot === slot),
  SLOT_B,
  { timeout: 5000 },
).catch(() => {});
check('la suppression efface le fichier', !fs.existsSync(saveFile(SLOT_B)));
check('le monde actif survit à la suppression de l’autre', readSave(SLOT_A) !== null);

// ---------------------------------------------------- 5. réinitialisation
await page.evaluate(() => window.__mc.resetWorld());
await page.waitForFunction(() => !window.__mc.savePending(), null, { timeout: 15000 });
const cleared = await page.evaluate((cells) => {
  const mc = window.__mc;
  mc.streamAll();
  // Le cube creusé (AIR) n'est pas testable ici : un tronçon déchargé rend déjà AIR.
  const built = cells.filter(([, , , id]) => id !== 0);
  return { edits: mc.editCount(), stillThere: built.filter(([x, y, z, id]) => mc.world.getBlock(x, y, z) === id).length };
}, placed.cells);
check('réinitialiser vide le diff en mémoire', cleared.edits === 0, `edits=${cleared.edits}`);
check('réinitialiser rend les cubes posés', cleared.stillThere === 0, `restants=${cleared.stillThere}`);
const afterReset = readSave(SLOT_A);
check('réinitialiser écrit un monde vierge', afterReset && afterReset.cells === 0,
  afterReset ? `cells=${afterReset.cells}` : 'fichier absent');

// ---------------------------------------------------- 6. sauvegarde corrompue
// Le disque est une entrée comme une autre : un fichier illisible doit conduire à un
// monde neuf jouable, jamais à un écran d'accueil bloqué.
fs.writeFileSync(saveFile(SLOT_A), "{ ce n'est pas du json", 'utf8');
await page.reload({ waitUntil: 'load' });
await waitForBoot(page);
const corrupt = await page.evaluate(() => ({
  ready: window.__mc.worldReady(),
  disabled: document.getElementById('start-btn').disabled,
  edits: window.__mc.editCount(),
  status: document.getElementById('world-status').textContent.trim(),
}));
check('une sauvegarde corrompue ne bloque pas le démarrage',
  corrupt.ready && !corrupt.disabled, `ready=${corrupt.ready} disabled=${corrupt.disabled}`);
check('le joueur repart d’un monde neuf après fichier illisible',
  corrupt.edits === 0 && /Nouveau monde/.test(corrupt.status), corrupt.status);

// ---------------------------------------------------- 7. nommer un monde
// Le slot est le nom de fichier, le nom d'affichage ce que voit le joueur. Le
// renommage doit déplacer le document, pas le dupliquer, et refuser d'écraser un
// monde qui occupe déjà le nom visé.
const NAMED = `Château du lac ${stamp}`;          // tel que saisi au clavier
const NAMED_SLUG = `chateau-du-lac-${stamp}`;     // le fichier attendu
const CLASH = `e2e-rival-${stamp}`;               // monde écrit à la main pour faire obstacle

await page.evaluate(() => window.__mc.flushSave());
await page.waitForFunction(() => !window.__mc.savePending(), null, { timeout: 15000 });

const emptyTry = await page.evaluate(async () => {
  const field = document.getElementById('world-name');
  field.value = '   ';
  const ok = await window.__mc.renameWorld(field.value);
  return { ok, status: document.getElementById('world-status').textContent.trim() };
});
check('un champ vide ne débaptise pas le monde',
  emptyTry.ok === false && /pas encore de nom/.test(emptyTry.status), emptyTry.status);

fs.writeFileSync(saveFile(CLASH), JSON.stringify({
  version: 1, seed: { terrain: 42 }, name: 'Rival', savedAt: Date.now(),
  cells: 0, player: { x: 0, y: 0, z: 0 }, edits: [],
}), 'utf8');
const clashTry = await page.evaluate(async (name) => {
  const ok = await window.__mc.renameWorld(name);
  return { ok, status: document.getElementById('world-status').textContent.trim() };
}, CLASH);
check('renommer sur un monde qui occupe déjà le nom est refusé',
  clashTry.ok === false && /occupe déjà/.test(clashTry.status), clashTry.status);
check('le refus laisse les deux fichiers intacts',
  readSave(CLASH) !== null && readSave(SLOT_A) !== null);

// Un cube témoin : il doit suivre le document jusqu'au nouveau fichier.
const marker = await page.evaluate(() => {
  const mc = window.__mc;
  const bx = Math.floor(mc.camera.position.x);
  const bz = Math.floor(mc.camera.position.z);
  const by = Math.floor(mc.camera.position.y) - 2;
  mc.setBlock(bx, by, bz, mc.BLOCK.OBSIDIAN);
  mc.flushSave();
  return { x: bx, y: by, z: bz };
});
await page.waitForFunction(() => !window.__mc.savePending(), null, { timeout: 15000 });

const renamed = await page.evaluate(async (name) => {
  const field = document.getElementById('world-name');
  field.value = name;
  const ok = await window.__mc.renameWorld(name);
  return { ok, status: document.getElementById('world-status').textContent.trim() };
}, NAMED);
check('renommer le monde est accepté', renamed.ok === true, renamed.status);

// Le changement de fichier provoque un rechargement : on attend l'autre document.
await page.waitForFunction((slot) => !!window.__mc && window.__mc.SAVE_SLOT === slot,
  NAMED_SLUG, { timeout: 30000 }).catch(() => {});
await waitForBoot(page);

const moved = await page.evaluate((m) => {
  const mc = window.__mc;
  mc.streamAll();
  return {
    slot: mc.SAVE_SLOT,
    search: window.location.search,
    name: mc.worldName(),
    block: mc.world.getBlock(m.x, m.y, m.z),
    obsidian: mc.BLOCK.OBSIDIAN,
    rows: [...document.querySelectorAll('.world-pick')].map((b) => `${b.dataset.slot}=${b.textContent}`),
  };
}, marker);
check('le joueur repart sur le nouveau fichier',
  moved.slot === NAMED_SLUG && moved.search.includes(`world=${NAMED_SLUG}`),
  `slot=${moved.slot} ${moved.search}`);
check('le nom saisi survit au rechargement', moved.name === NAMED, JSON.stringify(moved.name));
check('les cubes modifiés suivent le renommage', moved.block === moved.obsidian, `bloc=${moved.block}`);
check('l’ancien fichier est effacé par le renommage',
  !fs.existsSync(saveFile(SLOT_A)) && fs.existsSync(saveFile(NAMED_SLUG)),
  `${SLOT_A} → ${NAMED_SLUG}`);
const namedDoc = readSave(NAMED_SLUG);
check('le fichier porte le nom choisi', namedDoc && namedDoc.name === NAMED, JSON.stringify(namedDoc?.name));
check('la liste affiche le nom plutôt que le fichier',
  moved.rows.some((row) => row === `${NAMED_SLUG}=${NAMED}`), moved.rows.join(' | '));

// Même nom de fichier, nom d'affichage différent : pas de second document.
const retyped = await page.evaluate(async (name) => {
  const field = document.getElementById('world-name');
  field.value = name;
  const ok = await window.__mc.renameWorld(name);
  return { ok, slot: window.__mc.SAVE_SLOT };
}, `${NAMED} !`);
await page.waitForFunction(() => !window.__mc.savePending(), null, { timeout: 15000 });
const retypedDoc = readSave(NAMED_SLUG);
check('réécrire le même nom ne duplique pas le monde',
  retyped.ok === true && retyped.slot === NAMED_SLUG && fs.existsSync(saveFile(NAMED_SLUG)),
  `ok=${retyped.ok} slot=${retyped.slot}`);
check('le nom affiché suit la nouvelle saisie',
  retypedDoc && retypedDoc.name === `${NAMED} !`, JSON.stringify(retypedDoc?.name));

// ---------------------------------------------------- 8. propreté générale
check('aucune erreur console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
check('aucune réponse HTTP en erreur', badResponses.length === 0, badResponses.slice(0, 3).join(' | '));

for (const slot of [SLOT_A, SLOT_B, NAMED_SLUG, CLASH]) {
  try { fs.unlinkSync(saveFile(slot)); } catch (e) { /* déjà parti */ }
}
await browser.close();

process.exit(summary() === 0 ? 0 : 1);
