// Headless verification of the block palette: opening, assigning, persisting.
// Usage: node tests/inventory.mjs [url]
// Needs the static server running (npm start / node server.js).
import fs from 'node:fs';
import path from 'node:path';
import { openGame, makeReporter } from './browser.mjs';

const URL = process.argv[2] || 'http://localhost:8080';
const SHOTS = process.env.SHOT_DIR || '.qwen/tmp/mc-shots';

const { check, summary } = makeReporter();
const { browser, page, consoleErrors, badResponses } = await openGame(URL);

const STONE = 3, LAVA = 19, DIRT = 2;
const state = () => page.evaluate(() => {
  const mc = window.__mc;
  return {
    blocks: mc.hotbar.blocks.slice(),
    selected: mc.hotbar.selected,
    held: mc.player.selectedBlock,
    open: mc.inventory.isOpen(),
    panelOpen: document.getElementById('inventory').classList.contains('open'),
    blockerShown: getComputedStyle(document.getElementById('blocker')).display !== 'none',
    pointerLocked: document.pointerLockElement != null,
    hudIcons: [...document.querySelectorAll('#hotbar .hotbar-slot canvas')].length,
    stripIcons: [...document.querySelectorAll('#inventory-hotbar .hotbar-slot canvas')].length,
    equippedCells: [...document.querySelectorAll('.inv-cell.equipped')].length,
  };
});

const snapshot = await state();
const initialBlocks = snapshot.blocks.slice();

// ============================================================ 1. palette contents
const palette = await page.evaluate(() => {
  const mc = window.__mc;
  const cells = [...document.querySelectorAll('.inv-cell')];
  const ids = cells.map((c) => Number(c.dataset.block));
  const names = cells.map((c) => c.querySelector('span').textContent.trim());
  const iconSig = (id) => {
    const c = cells.find((el) => Number(el.dataset.block) === id).querySelector('canvas');
    const d = c.getContext('2d').getImageData(0, 0, 16, 16).data;
    let sum = 0, uniq = new Set();
    for (let i = 0; i < d.length; i += 4) { sum += d[i] + d[i + 1] + d[i + 2]; uniq.add(`${d[i]},${d[i + 1]},${d[i + 2]}`); }
    return { sum, uniq: uniq.size };
  };
  // Un bloc hors catalogue n'est pas automatiquement un bloc mort : il a le droit de
  // n'être que la variante orientée d'une icône déjà en palette (`appliqueOriente` choisit
  // la face au mur). Mais cette parenté doit être déclarée et vérifiable, sinon
  // `variant: true` deviendrait une façon commode de faire disparaître un bloc du jeu.
  const orphelines = Object.keys(mc.BLOCK_INFO).map(Number)
    .filter((id) => id >= 1 && !ids.includes(id))
    .filter((id) => {
      const i = mc.BLOCK_INFO[id];
      return i.variant !== true
        || !ids.some((p) => p !== id && mc.BLOCK_INFO[p].name === i.name
          && String(mc.BLOCK_INFO[p].tiles) === String(i.tiles));
    });
  return {
    total: mc.ALL_BLOCKS.length,
    ids,
    names,
    sections: document.querySelectorAll('.inv-section').length,
    expectedSections: mc.BLOCK_GROUPS.length,
    water: iconSig(mc.BLOCK.WATER),
    lava: iconSig(mc.BLOCK.LAVA),
    stone: iconSig(mc.BLOCK.STONE),
    blank: cells.filter((c) => iconSig(Number(c.dataset.block)).sum === 0).length,
    orphelines,
  };
});
check('la palette expose tous les blocs, sans doublon',
  palette.ids.length === palette.total &&
  new Set(palette.ids).size === palette.total &&
  palette.ids.every((id) => id >= 1) &&
  palette.sections === palette.expectedSections,
  `${palette.ids.length}/${palette.total} blocs, ${palette.sections} catégories`);
check('un bloc hors palette n\'est jamais qu\'une variante déclarée d\'une icône présente',
  palette.orphelines.length === 0,
  palette.orphelines.join(', ') || 'aucun bloc orphelin');
check('chaque icône de palette est dessinée depuis l’atlas',
  palette.blank === 0 && palette.water.uniq > 8 && palette.lava.uniq > 8 &&
  Math.abs(palette.water.sum - palette.lava.sum) > 4000,
  `eau=${palette.water.uniq}c lave=${palette.lava.uniq}c pierre=${palette.stone.uniq}c`);
check('les noms des blocs sont affichés en français',
  palette.names.includes('Herbe') && palette.names.includes('Diamant') && palette.names.every(Boolean),
  palette.names.slice(0, 4).join(', ') + '…');

// ============================================================ 2. open / close
await page.evaluate(() => window.__mc.keyDown('KeyE'));
let s = await state();
check('E ouvre l’inventaire', s.open && s.panelOpen, `visible=${s.open}`);
check('ouvrir l’inventaire libère le curseur et ne montre pas l’écran d’accueil',
  !s.pointerLocked && !s.blockerShown,
  `pointerLocked=${s.pointerLocked} blocker=${s.blockerShown}`);

const domCounts = await page.evaluate(() => ({
  hud: document.querySelectorAll('#hotbar .hotbar-slot').length,
  strip: document.querySelectorAll('#inventory-hotbar .hotbar-slot').length,
  size: window.__mc.HOTBAR_SIZE,
}));
check('la barre d’emplacements est dupliquée dans l’inventaire',
  domCounts.hud === domCounts.size && domCounts.strip === domCounts.size,
  `${domCounts.hud} + ${domCounts.strip} pour ${domCounts.size} emplacements`);

// ============================================================ 3. assign through the UI
const targetBefore = s.selected;
await page.click(`.inv-cell[data-block="${LAVA}"]`);
s = await state();
check('un clic sur un bloc l’affecte à l’emplacement actif et le donne en main',
  s.blocks[targetBefore] === LAVA && s.held === LAVA && s.selected === targetBefore,
  `slot ${targetBefore + 1} = ${s.blocks[targetBefore]} tenu=${s.held}`);
check('les cellules déjà en main sont marquées équipées', s.equippedCells >= 1,
  `${s.equippedCells} cellules marquées`);

// retarget another slot, then assign there
await page.click('#inventory-hotbar .hotbar-slot[data-index="4"]');
s = await state();
check('cliquer un emplacement de l’inventaire le rend actif', s.selected === 4, `selected=${s.selected}`);
await page.click('.inv-cell[data-block="13"]'); // diamond
s = await state();
check('affecter après re-ciblage écrit dans le bon emplacement',
  s.blocks[4] === 13 && s.held === 13 && s.blocks[targetBefore] === LAVA,
  `slot5=${s.blocks[4]} slot${targetBefore + 1}=${s.blocks[targetBefore]}`);

// ============================================================ 4. keyboard selection
// Number keys drive the hotbar only while the palette is closed: with the
// palette up they belong to the UI, not to the world.
await page.evaluate(() => window.__mc.inventory.hide());
await page.waitForTimeout(80);
await page.keyboard.press('Digit2');
s = await state();
check('les touches 1-9 suivent la hotbar personnalisée',
  !s.open && s.selected === 1 && s.held === s.blocks[1],
  `slot 2 = ${s.held} (attendu ${s.blocks[1]})`);

const heldBeforeGuard = s.selected;
await page.evaluate(() => window.__mc.inventory.show());
await page.keyboard.press('Digit5');
s = await state();
check('les chiffres sont ignorés pendant que l’inventaire est ouvert',
  s.open && s.selected === heldBeforeGuard,
  `resté sur l’emplacement ${s.selected + 1}`);

const cycled = await page.evaluate(() => {
  const mc = window.__mc;
  const before = mc.hotbar.selected;
  mc.hotbar.cycle(1);
  const after = mc.hotbar.selected;
  mc.hotbar.cycle(-1);
  return { before, after, back: mc.hotbar.selected };
});
check('la molette fait défiler les emplacements',
  cycled.after === (cycled.before + 1) % 9 && cycled.back === cycled.before,
  `${cycled.before} → ${cycled.after} → ${cycled.back}`);

// ============================================================ 5. the choice reaches the world
const built = await page.evaluate(({ STONE }) => {
  const mc = window.__mc;
  const cx = 500, cz = 500, fy = 20;
  for (let x = cx - 3; x <= cx + 3; x++) {
    for (let z = cz - 3; z <= cz + 3; z++) {
      for (let y = fy - 2; y <= fy + 6; y++) mc.setBlock(x, y, z, y === fy ? STONE : 0);
    }
  }
  mc.player.flyMode = true;
  mc.camera.position.set(cx + 0.5, fy + 2.62, cz + 0.5);
  mc.look(-90, 0); // face to +X
  mc.player.velocity.set(0, 0, 0);
  mc.releaseAll();
  for (let i = 0; i < 5; i++) mc.step(1 / 120);
  mc.setBlock(cx + 2, fy + 2, cz, STONE);

  // choose lava through the palette, exactly like a player would
  mc.inventory.pick(mc.BLOCK.LAVA);
  // two-stage build: first click marks the cube glued to the aimed face, second
  // applies the cuboid (depth 0, so the box is exactly that marked cube)
  const armed = mc.clickCreate();
  const placed = mc.clickCreate();
  return {
    armed,
    placed,
    target: mc.world.getBlock(cx + 1, fy + 2, cz),
    aimed: mc.world.getBlock(cx + 2, fy + 2, cz),
    held: mc.player.selectedBlock,
    lavaId: mc.BLOCK.LAVA,
    stoneId: STONE,
  };
}, { STONE });
check('le bloc choisi dans la palette est celui posé dans le monde',
  built.armed === true && built.placed === true && built.target === built.lavaId
    && built.aimed === built.stoneId && built.held === built.lavaId,
  `posé=${built.target} cube visé=${built.aimed} attendu=${built.lavaId}`);

// while the palette is up, clicks belong to the UI and must not dig
const guarded = await page.evaluate(() => {
  const mc = window.__mc;
  const before = mc.world.getBlock(502, 22, 500);
  document.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  document.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true }));
  return { before, after: mc.world.getBlock(502, 22, 500), st: mc.selectionState() };
});
check('clics ignorés par le monde pendant que l’inventaire est ouvert',
  guarded.before === guarded.after && guarded.st.active === false,
  `bloc visé ${guarded.before} → ${guarded.after}, sélection=${JSON.stringify(guarded.st)}`);

// ============================================================ 6. closing
await page.evaluate(() => window.__mc.keyDown('Escape'));
await page.waitForTimeout(120); // the lock refusal is reported asynchronously
s = await state();
check('Échap ferme l’inventaire', !s.open && !s.panelOpen, `visible=${s.open}`);
// closing must hand control back: either the pointer is captured again or the
// start screen returns — never neither, which would leave a dead page.
check('à la fermeture la main revient au jeu ou à l’écran d’accueil',
  s.pointerLocked || s.blockerShown,
  `pointerLocked=${s.pointerLocked} blocker=${s.blockerShown}`);

const keysCleared = await page.evaluate(() => Object.values(window.__mc.keys).every((v) => !v));
check('aucune touche ne reste enfoncée à la fermeture', keysCleared);

// ============================================================ 7. persistence
const stored = await page.evaluate(() => ({
  saved: JSON.parse(localStorage.getItem('mincraft_hotbar') || 'null'),
  live: window.__mc.hotbar.blocks.slice(),
}));
check('la hotbar est mémorisée dans localStorage',
  Array.isArray(stored.saved) && stored.saved.length === 9 &&
  JSON.stringify(stored.saved) === JSON.stringify(stored.live) &&
  stored.saved.includes(LAVA) && stored.saved.includes(13),
  JSON.stringify(stored.saved));

await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => !!window.__mc, null, { timeout: 30000 });
const afterReload = await state();
check('la sélection survit au rechargement de la page',
  JSON.stringify(afterReload.blocks) === JSON.stringify(stored.saved) &&
  afterReload.hudIcons === 9 && afterReload.stripIcons === 9,
  JSON.stringify(afterReload.blocks));

// corrupted storage must fall back instead of throwing
await page.evaluate(() => localStorage.setItem('mincraft_hotbar', '{"pas":"du tout"}'));
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => !!window.__mc, null, { timeout: 30000 });
const afterCorrupt = await state();
check('une sauvegarde corrompue retombe sur la hotbar par défaut',
  JSON.stringify(afterCorrupt.blocks) === JSON.stringify(initialBlocks),
  JSON.stringify(afterCorrupt.blocks));

await page.evaluate(() => localStorage.setItem('mincraft_hotbar', JSON.stringify([999, 1, 2, 3, 4, 5, 6, 7, 8])));
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => !!window.__mc, null, { timeout: 30000 });
const afterBogus = await state();
check('un identifiant de bloc inconnu est remplacé, pas crashé',
  afterBogus.blocks[0] === DIRT && afterBogus.blocks.every((b) => b >= 1),
  JSON.stringify(afterBogus.blocks));

// ============================================================ 8. screenshots + hygiene
fs.mkdirSync(SHOTS, { recursive: true });
await page.evaluate(() => {
  const mc = window.__mc;
  localStorage.removeItem('mincraft_hotbar');
  mc.hotbar.reset();
  mc.inventory.show();
});
await page.waitForTimeout(120);
await page.screenshot({ path: path.join(SHOTS, '04-inventaire.png') });
await page.evaluate(() => window.__mc.inventory.hide());

const ignorable = (x) => /favicon|Failed to load resource/i.test(String(x));
const realErrors = consoleErrors.filter((e) => !ignorable(e));
const realBad = badResponses.filter((u) => !ignorable(u));
check('aucune erreur console pendant les manipulations d’inventaire',
  realErrors.length === 0 && realBad.length === 0,
  [...new Set([...realErrors.slice(0, 3), ...realBad.slice(0, 3)])].join(' | '));

await browser.close();
const failed = summary();
console.log(`captures: ${SHOTS}`);
process.exit(failed ? 1 : 0);
