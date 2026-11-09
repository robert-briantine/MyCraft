// Headless verification of the two-stage cuboid build/dig interaction.
// Usage: node tests/selection.mjs [url]
// Needs the static server running (npm start / node server.js).
import fs from 'node:fs';
import path from 'node:path';
import { openGame, makeReporter } from './browser.mjs';

const URL = process.argv[2] || 'http://localhost:8080';
const SHOTS = process.env.SHOT_DIR || '.qwen/tmp/mc-shots';

const { check, summary } = makeReporter();
const { browser, page, consoleErrors, badResponses } = await openGame(URL);

const AIR = 0;
const STONE = 3;

// Flat clearing with a single marker cube at eye level, so the aimed cube is always
// the same known cell and the cuboid grows through empty space.
const CX = 500, CZ = 500, FY = 20;
const MARKER = { x: CX + 2, y: FY + 2, z: CZ };
// Creating builds on the aimed face: from the eye at CX+0.5 looking +X the ray meets
// the marker's west face, so the first created cube is the free cell in front of it.
const BUILD = { x: MARKER.x - 1, y: MARKER.y, z: MARKER.z };

async function resetArena() {
  await page.evaluate(({ CX, CZ, FY, MARKER, STONE }) => {
    const mc = window.__mc;
    mc.cancelSelection();
    const cells = [];
    for (let x = CX - 3; x <= CX + 7; x++) {
      for (let z = CZ - 3; z <= CZ + 3; z++) {
        for (let y = FY - 2; y <= FY + 6; y++) cells.push([x, y, z, y === FY ? STONE : 0]);
      }
    }
    cells.push([MARKER.x, MARKER.y, MARKER.z, STONE]);
    mc.world.setBlocksBulk(cells);
    mc.player.flyMode = true;
    mc.camera.position.set(CX + 0.5, FY + 2.62, CZ + 0.5);
    mc.look(-90, 0); // face +X
    mc.player.velocity.set(0, 0, 0);
    mc.releaseAll();
    for (let i = 0; i < 3; i++) mc.step(1 / 120);
  }, { CX, CZ, FY, MARKER, STONE });
}

// Independent scenarios must not inherit a half-made box or a dug-out marker from the
// previous one: drop any pending selection and put the aimed cube back.
const primeMarker = () => page.evaluate(({ MARKER, STONE }) => {
  const mc = window.__mc;
  mc.cancelSelection();
  mc.world.setBlocksBulk([[MARKER.x, MARKER.y, MARKER.z, STONE]]);
}, { MARKER, STONE });

await resetArena();

// ============================================================ 1. first click only marks
const marked = await page.evaluate(({ MARKER, BUILD }) => {
  const mc = window.__mc;
  const before = mc.world.getBlock(MARKER.x, MARKER.y, MARKER.z);
  const armed = mc.clickCreate();
  return { armed, before, st: mc.selectionState(), bd: mc.selectionBounds() };
}, { MARKER, BUILD });
check('le premier clic marque le cube collé à la face visée, sans toucher au monde',
  marked.armed === true && marked.st.active === true && marked.st.mode === 'create'
    && marked.st.anchor.x === BUILD.x && marked.st.anchor.y === BUILD.y && marked.st.anchor.z === BUILD.z
    && marked.before === STONE && marked.bd.cells === 1,
  JSON.stringify(marked.st));

// The banner is painted from the game loop, so wait for a frame rather than reading
// the DOM the instant the click lands.
const hudShown = await page.waitForFunction(
  () => document.getElementById('selection-hint').style.display === 'block',
  null, { timeout: 3000 },
).then(() => page.evaluate(() => {
  const el = document.getElementById('selection-hint');
  return { display: el.style.display, text: el.textContent, deleteClass: el.classList.contains('delete') };
}));
check('le bandeau indique la sélection en cours',
  hudShown.display === 'block' && /Créer/.test(hudShown.text) && /2e clic/.test(hudShown.text)
    && hudShown.deleteClass === false,
  hudShown.text);

// ============================================================ 2. wheel stretches, second click fills
const built = await page.evaluate(({ BUILD }) => {
  const mc = window.__mc;
  mc.inventory.pick(mc.BLOCK.BRICK);
  for (let i = 0; i < 4; i++) mc.wheelSelection(1);
  const stretched = mc.selectionBounds();
  const applied = mc.clickCreate();
  const row = [];
  for (let d = 0; d <= 5; d++) row.push(mc.world.getBlock(BUILD.x + d, BUILD.y, BUILD.z));
  return { stretched, applied, row, brick: mc.BLOCK.BRICK, st: mc.selectionState() };
}, { BUILD });
check('la molette éloigne l’extrémité le long de la vue',
  built.stretched.cells === 5 && built.stretched.min.x === BUILD.x && built.stretched.max.x === BUILD.x + 4
    && built.stretched.min.z === CZ && built.stretched.max.z === CZ,
  JSON.stringify(built.stretched));
check('le second clic crée le parallélépipède, cube marqué compris',
  built.applied === true && built.row.slice(0, 5).every((b) => b === built.brick) && built.row[5] === AIR,
  `rangée ${built.row.join(',')} attendu ${built.brick}×5`);
check('la sélection se referme après application',
  built.st.active === false && built.st.anchor === null,
  JSON.stringify(built.st));

const hudHidden = await page.waitForFunction(
  () => document.getElementById('selection-hint').style.display === 'none',
  null, { timeout: 3000 },
).then(() => true).catch(() => false);
check('le bandeau disparaît une fois la sélection appliquée', hudHidden === true, String(hudHidden));

// ============================================================ 3. the far corner rides the crosshair
await resetArena();          // section 2 left a brick row in front of the marker
const swung = await page.evaluate(({ BUILD, CX }) => {
  const mc = window.__mc;
  mc.look(-90, 0);           // face +X
  mc.clickCreate();          // mark
  for (let i = 0; i < 4; i++) mc.wheelSelection(1);
  const before = mc.selectionBounds();
  mc.look(90, 0);            // turn around: the crosshair now points behind the player
  const after = mc.selectionBounds();
  const st = mc.selectionState();
  // The far corner is the cell under the crosshair, recomputed here from the eye.
  const dir = mc.camera.getWorldDirection(new mc.THREE.Vector3());
  const p = mc.camera.position;
  const croix = {
    x: Math.floor(p.x + dir.x * st.depth),
    y: Math.floor(p.y + dir.y * st.depth),
    z: Math.floor(p.z + dir.z * st.depth),
  };
  mc.cancelSelection();
  return { before, after, st, croix, build: BUILD, eye: CX };
}, { BUILD, CX });
check('tourner conserve le cube marqué',
  swung.st.anchor.x === swung.build.x && swung.st.anchor.y === swung.build.y && swung.st.anchor.z === swung.build.z,
  JSON.stringify(swung.st));
check('le 2ᵉ cube reste sous la croix : tourner redimensionne le pavé',
  swung.before.min.x === swung.build.x && swung.before.max.x === swung.build.x + 4
    && swung.after.min.x === swung.croix.x && swung.after.max.x === swung.build.x
    && swung.after.cells > swung.before.cells,
  `${swung.before.cells} → ${swung.after.cells} cubes, croix x=${swung.croix.x}`);

const pitched = await page.evaluate(() => {
  const mc = window.__mc;
  mc.look(-90, 0);
  mc.clickCreate();
  for (let i = 0; i < 6; i++) mc.wheelSelection(1);
  const flat = mc.selectionBounds();
  mc.look(-90, 45);          // raise the eyes: the crosshair corner must follow
  const up = mc.selectionBounds();
  mc.cancelSelection();
  return { flat, up };
});
check('lever les yeux déplace le coin visé vers le haut',
  pitched.up.max.y > pitched.flat.max.y && pitched.up.min.y === pitched.flat.min.y
    && pitched.up.max.x < pitched.flat.max.x,
  `y ${pitched.flat.max.y} → ${pitched.up.max.y}, x ${pitched.flat.max.x} → ${pitched.up.max.x}`);

// ============================================================ 4. right button digs the cuboid out
const dug = await page.evaluate(({ MARKER, AIR }) => {
  const mc = window.__mc;
  mc.look(-90, 0);
  const armed = mc.clickDelete();
  const mode = mc.selectionState().mode;
  for (let i = 0; i < 4; i++) mc.wheelSelection(1);
  const applied = mc.clickDelete();
  const row = [];
  for (let d = 0; d <= 5; d++) row.push(mc.world.getBlock(MARKER.x + d, MARKER.y, MARKER.z));
  return { armed, mode, applied, row, st: mc.selectionState(), AIR };
}, { MARKER, AIR });
check('clic droit marque en mode suppression',
  dug.armed === true && dug.mode === 'delete',
  dug.mode);
check('le second clic droit supprime tout le pavé, cube marqué inclus',
  dug.applied === true && dug.row.every((b) => b === AIR),
  `rangée ${dug.row.join(',')}`);

// ============================================================ 5. the other button re-arms, never fires
await primeMarker();
const rearm = await page.evaluate(async ({ MARKER, BUILD, STONE }) => {
  const mc = window.__mc;
  const frames = (n) => new Promise((r) => {
    const tick = () => (--n <= 0 ? r() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
  // A second solid cube at the far end of the box: digging must clear both ends.
  mc.world.setBlocksBulk([[MARKER.x + 1, MARKER.y, MARKER.z, STONE]]);
  mc.look(-90, 0);
  mc.clickCreate();
  for (let i = 0; i < 2; i++) mc.wheelSelection(1);
  const switched = mc.clickDelete();               // must not dig yet
  await frames(2);
  const banner = document.getElementById('selection-hint');
  const mid = {
    st: mc.selectionState(),
    bd: mc.selectionBounds(),
    kept: mc.world.getBlock(MARKER.x, MARKER.y, MARKER.z),
    bannerText: banner.textContent,
    deleteClass: banner.classList.contains('delete'),
  };
  const applied = mc.clickDelete();                // now it digs
  return {
    switched, mid, applied,
    after: mc.world.getBlock(MARKER.x, MARKER.y, MARKER.z),
    far: mc.world.getBlock(MARKER.x + 1, MARKER.y, MARKER.z),
    build: BUILD, marker: MARKER, stone: STONE,
  };
}, { MARKER, BUILD, STONE });
check('changer de bouton re-ancre sur le cube solide visé sans déclencher l’action',
  rearm.switched === true && rearm.mid.st.mode === 'delete'
    && rearm.mid.st.anchor.x === rearm.marker.x
    && rearm.mid.bd.min.x === rearm.marker.x && rearm.mid.bd.max.x === rearm.marker.x + 1
    && rearm.mid.kept === rearm.stone,
  JSON.stringify(rearm.mid.bd));
check('le bandeau passe en rouge « Supprimer » sans changer les coordonnées',
  rearm.mid.deleteClass === true && /Supprimer/.test(rearm.mid.bannerText),
  rearm.mid.bannerText);
check('le deuxième clic du nouveau bouton applique enfin le pavé',
  rearm.applied === true && rearm.after === AIR && rearm.far === AIR,
  `ancre=${rearm.after} loin=${rearm.far}`);

// ============================================================ 6. abort paths
// The mouse listener ignores clicks unless the pointer is locked, so the buttons are
// driven through real DOM events with the lock faked on.
await primeMarker();
const aborted = await page.evaluate(({ MARKER, STONE }) => {
  const mc = window.__mc;
  mc.look(-90, 0);
  mc.controls.isLocked = true;
  try {
    document.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    document.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    const armed = { st: mc.selectionState(), bd: mc.selectionBounds() };
    document.dispatchEvent(new MouseEvent('mousedown', { button: 1, bubbles: true }));
    return {
      armed,
      afterMiddle: mc.selectionState(),
      kept: mc.world.getBlock(MARKER.x, MARKER.y, MARKER.z),
      beyond: mc.world.getBlock(MARKER.x + 1, MARKER.y, MARKER.z),
      stone: STONE,
    };
  } finally {
    mc.controls.isLocked = false;
  }
}, { MARKER, STONE });
check('un clic gauche réel marque le cube collé à la face et la molette suit la croix',
  aborted.armed.st.active === true && aborted.armed.bd.min.x === BUILD.x
    && aborted.armed.bd.max.x === MARKER.x && aborted.kept === aborted.stone,
  JSON.stringify(aborted.armed.bd));
check('le clic milieu annule la sélection sans toucher au monde',
  aborted.afterMiddle.active === false && aborted.kept === aborted.stone && aborted.beyond === AIR,
  JSON.stringify(aborted.afterMiddle));

// After an abort the next click must re-mark, never commit the abandoned box.
await primeMarker();
const restarted = await page.evaluate(({ MARKER, STONE }) => {
  const mc = window.__mc;
  mc.look(-90, 0);
  mc.clickCreate();
  mc.wheelSelection(3);
  mc.cancelSelection();
  const again = mc.clickCreate();
  return {
    again,
    st: mc.selectionState(),
    bd: mc.selectionBounds(),
    kept: mc.world.getBlock(MARKER.x, MARKER.y, MARKER.z),
    far: mc.world.getBlock(MARKER.x + 3, MARKER.y, MARKER.z),
    stone: STONE,
  };
}, { MARKER, STONE });
check('après annulation un nouveau clic marque à nouveau le seul cube visé',
  restarted.again === true && restarted.st.active === true && restarted.bd.cells === 1
    && restarted.kept === restarted.stone && restarted.far === AIR,
  JSON.stringify(restarted.bd));

await primeMarker();
const escaped = await page.evaluate(({ MARKER, STONE }) => {
  const mc = window.__mc;
  mc.look(-90, 0);
  mc.clickCreate();
  mc.wheelSelection(2);
  mc.keyDown('Escape');
  return {
    st: mc.selectionState(),
    kept: mc.world.getBlock(MARKER.x, MARKER.y, MARKER.z),
    far: mc.world.getBlock(MARKER.x + 2, MARKER.y, MARKER.z),
    stone: STONE,
  };
}, { MARKER, STONE });
check('Échap abandonne la sélection en cours',
  escaped.st.active === false && escaped.kept === escaped.stone && escaped.far === AIR,
  JSON.stringify(escaped.st));

// ============================================================ 7. losing pointer lock drops it too
await primeMarker();
const unlocked = await page.evaluate(({ MARKER, STONE }) => {
  const mc = window.__mc;
  mc.look(-90, 0);
  mc.clickCreate();
  mc.wheelSelection(2);
  const frames = (n) => new Promise((r) => {
    const tick = () => (--n <= 0 ? r() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
  return frames(3).then(async () => {
    const previewShown = mc.selectionPreview.visible;
    // What the browser does on Esc / alt-tab.
    mc.controls.dispatchEvent({ type: 'unlock' });
    await frames(3);
    return {
      previewShown,
      st: mc.selectionState(),
      previewHidden: !mc.selectionPreview.visible,
      kept: mc.world.getBlock(MARKER.x, MARKER.y, MARKER.z),
      stone: STONE,
    };
  });
}, { MARKER, STONE });
check('une sélection en cours ne survit pas à la perte du pointeur',
  unlocked.previewShown === true && unlocked.st.active === false && unlocked.previewHidden === true
    && unlocked.kept === unlocked.stone,
  JSON.stringify(unlocked.st));

// ============================================================ 8. oversized boxes are refused
await primeMarker();
const huge = await page.evaluate(({ MARKER, STONE }) => {
  const mc = window.__mc;
  mc.look(-45, -35);                                // diagonal: all three axes grow
  mc.clickCreate();
  for (let i = 0; i < mc.MAX_SELECTION_DEPTH; i++) mc.wheelSelection(1);
  const bd = mc.selectionBounds();
  const refused = mc.clickCreate() === false;
  const st = mc.selectionState();
  const kept = mc.world.getBlock(MARKER.x, MARKER.y, MARKER.z);
  mc.cancelSelection();
  return { bd, refused, status: st.status, kept, stone: STONE, max: mc.MAX_SELECTION_CELLS };
}, { MARKER, STONE });
check('une sélection démesurée dépasse bien le plafond (pré-condition)',
  huge.bd.cells > huge.max,
  `${huge.bd.cells} cubes pour un plafond de ${huge.max}`);
check('au-delà du plafond rien n’est écrit et le bandeau prévient',
  huge.refused === true && huge.kept === huge.stone && /Trop grand/.test(huge.status),
  huge.status);

// ============================================================ 9. the player is never buried
await primeMarker();
const buried = await page.evaluate(({ CX, CZ, FY }) => {
  const mc = window.__mc;
  mc.camera.position.set(CX + 0.5, FY + 2.62, CZ + 0.5);
  mc.look(-90, 0);
  mc.inventory.pick(mc.BLOCK.BRICK);
  mc.clickCreate();                                 // marks the free cube on the aimed face
  mc.look(90, 0);                                   // turn back over the player
  for (let i = 0; i < 6; i++) mc.wheelSelection(1);
  const applied = mc.clickCreate();
  // The box now reaches from behind the player up to the marked cube; the player owns
  // the cell at CX, which must stay empty while its neighbours get filled.
  const row = [];
  for (let x = CX - 2; x <= CX + 1; x++) row.push(mc.world.getBlock(x, FY + 2, CZ));
  return {
    applied, row,
    body: mc.player.intersectsBlock(CX, FY + 2, CZ),
    brick: mc.BLOCK.BRICK,
  };
}, { CX, CZ, FY });
check('les cubes qui chevauchent le joueur sont sautés, les autres posés',
  buried.applied === true && buried.body === true
    && buried.row[2] !== buried.brick
    && buried.row[0] === buried.brick && buried.row[1] === buried.brick
    && buried.row[3] === buried.brick,
  JSON.stringify(buried.row));

// ============================================================ 10. one remesh per touched chunk
const batched = await page.evaluate(({ STONE }) => {
  const mc = window.__mc;
  const original = mc.world.rebuildChunk.bind(mc.world);
  const calls = [];
  mc.world.rebuildChunk = (cx, cz) => { calls.push(`${cx},${cz}`); return original(cx, cz); };
  const cells = [];
  // 14×3 wall fully inside one chunk: no border column, so exactly one chunk to remesh.
  for (let x = 513; x <= 526; x++) for (let y = 30; y <= 32; y++) cells.push([x, y, 529, STONE]);
  mc.world.setBlocksBulk(cells);
  mc.world.rebuildChunk = original;
  return {
    calls,
    written: mc.world.getBlock(520, 31, 529),
    stone: STONE,
  };
}, { STONE });
check('un remplissage en lot ne reconstruit chaque chunk qu’une fois',
  batched.calls.length === 1 && batched.written === batched.stone,
  `reconstructions=${batched.calls.join('|')}`);

// ============================================================ 11. wheel keeps driving the hotbar
const wheelRouting = await page.evaluate(() => {
  const mc = window.__mc;
  mc.cancelSelection();
  mc.controls.isLocked = true;
  const before = mc.hotbar.selected;
  document.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
  const cycled = mc.hotbar.selected;
  mc.hotbar.select(before);

  mc.look(-90, 0);
  mc.clickCreate();
  const depthBefore = mc.selectionState().depth;
  document.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
  const during = { depth: mc.selectionState().depth, slot: mc.hotbar.selected };
  mc.cancelSelection();
  mc.controls.isLocked = false;
  return { before, cycled, depthBefore, during };
});
check('hors sélection la molette change toujours de bloc',
  wheelRouting.cycled === (wheelRouting.before + 1) % 9,
  `${wheelRouting.before} → ${wheelRouting.cycled}`);
check('pendant une sélection la molette étire la sélection, pas la barre chaude',
  wheelRouting.during.depth === wheelRouting.depthBefore + 1 && wheelRouting.during.slot === wheelRouting.before,
  JSON.stringify(wheelRouting.during));

// ============================================================ 12. aiming at nothing is refused
await primeMarker();
const missed = await page.evaluate(({ MARKER, STONE }) => {
  const mc = window.__mc;
  mc.cancelSelection();
  mc.look(-90, 60);                                 // straight up: nothing to mark
  const armed = mc.clickCreate();
  return {
    armed,
    st: mc.selectionState(),
    kept: mc.world.getBlock(MARKER.x, MARKER.y, MARKER.z),
    stone: STONE,
  };
}, { MARKER, STONE });
check('viser le vide ne marque aucun cube',
  missed.armed === false && missed.st.active === false && missed.kept === missed.stone,
  JSON.stringify(missed.st));
const hudMiss = await page.waitForFunction(() => {
  const el = document.getElementById('selection-hint');
  return el.style.display === 'block' && /Aucun cube visé/.test(el.textContent);
}, null, { timeout: 3000 }).then(() => true).catch(() => false);
check('le bandeau explique qu’aucun cube n’est visé', hudMiss === true, String(hudMiss));

// ============================================================ 13. building grows out of the face
await resetArena();
const onTop = await page.evaluate(({ CX, CZ, FY }) => {
  const mc = window.__mc;
  mc.cancelSelection();
  mc.player.flyMode = true;
  mc.camera.position.set(CX + 0.5, FY + 3.62, CZ + 0.5);
  mc.player.velocity.set(0, 0, 0);
  mc.look(-90, -70);                                // steeply down at the cleared floor
  for (let i = 0; i < 3; i++) mc.step(1 / 120);
  const dir = mc.camera.getWorldDirection(new mc.THREE.Vector3());
  const hit = mc.raycastVoxel(mc.camera.position, dir, 8);
  mc.inventory.pick(mc.BLOCK.BRICK);
  const armed = mc.clickCreate();
  const st = mc.selectionState();
  const bd = mc.selectionBounds();
  const applied = mc.clickCreate();                 // second click fills that single cube
  return {
    hit: hit && { x: hit.x, y: hit.y, z: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz },
    armed, st, bd, applied,
    placed: hit ? mc.world.getBlock(hit.x, hit.y + 1, hit.z) : -1,
    ground: hit ? mc.world.getBlock(hit.x, hit.y, hit.z) : -1,
    brick: mc.BLOCK.BRICK, stone: mc.BLOCK.STONE,
  };
}, { CX, CZ, FY });
check('viser le sol ancre la création sur le cube libre au-dessus de la face touchée',
  onTop.armed === true && onTop.hit && onTop.hit.ny === 1
    && onTop.st.anchor.x === onTop.hit.x && onTop.st.anchor.y === onTop.hit.y + 1
    && onTop.st.anchor.z === onTop.hit.z && onTop.bd.cells === 1,
  JSON.stringify({ vise: onTop.hit, ancre: onTop.st.anchor, cells: onTop.bd.cells }));
check('le bloc posé sort de la face visée, le sol visé reste en place',
  onTop.applied === true && onTop.placed === onTop.brick && onTop.ground === onTop.stone,
  `posé=${onTop.placed} sol=${onTop.ground}`);

// The box must open as exactly the aimed cube on every aim, not only on a head-on one:
// a depth seeded from the entry distance opened two cubes on a grazing sight line.
const sweep = await page.evaluate(({ CX, CZ, FY }) => {
  const mc = window.__mc;
  mc.player.flyMode = true;
  mc.camera.position.set(CX - 2.5, FY + 2.62, CZ + 0.5);
  mc.player.velocity.set(0, 0, 0);
  const visees = [];
  for (const pitch of [0, -4, -8, -12, -18, -26, -40, -55, -70, -85]) {
    for (const yaw of [-90, -60, -30, 0, 30, 60, 120, 150, 180]) {
      mc.cancelSelection();
      mc.look(yaw, pitch);
      for (let i = 0; i < 2; i++) mc.step(1 / 120);
      const dir = mc.camera.getWorldDirection(new mc.THREE.Vector3());
      const hit = mc.raycastVoxel(mc.camera.position, dir, 8);
      if (!hit) continue;
      mc.clickDelete();
      const st = mc.selectionState();
      const bd = mc.selectionBounds();
      visees.push({ yaw, pitch, vise: [hit.x, hit.y, hit.z], ancre: st.anchor, cells: bd.cells });
      mc.cancelSelection();
    }
  }
  return visees;
}, { CX, CZ, FY });
const decalees = sweep.filter((v) => v.cells !== 1 || !v.ancre
  || v.ancre.x !== v.vise[0] || v.ancre.y !== v.vise[1] || v.ancre.z !== v.vise[2]);
check('en suppression le pavé s’ouvre sur le seul cube visé, quelle que soit la visée',
  sweep.length > 20 && decalees.length === 0,
  `${sweep.length} visées testées, ${decalees.length} décalées ${JSON.stringify(decalees.slice(0, 2))}`);

// Switching buttons must re-mark for the mode being switched to: keeping the creation
// anchor (the cube in front of the face) would dig one cube off the aimed block.
const swapped = await page.evaluate(({ MARKER, STONE }) => {
  const mc = window.__mc;
  mc.cancelSelection();
  mc.look(-90, 0);
  mc.clickCreate();                       // creation anchors in front of the aimed face
  const enCreation = mc.selectionState().anchor;
  mc.clickDelete();                       // digging must snap back onto the solid cube
  const enSuppression = { st: mc.selectionState(), bd: mc.selectionBounds() };
  mc.cancelSelection();
  return { enCreation, enSuppression, marker: MARKER, stone: STONE };
}, { MARKER, STONE });
check('basculer d’un bouton à l’autre re-ancre sur le cube du mode visé',
  swapped.enCreation.x === swapped.marker.x - 1
    && swapped.enSuppression.st.anchor.x === swapped.marker.x
    && swapped.enSuppression.st.anchor.y === swapped.marker.y
    && swapped.enSuppression.st.anchor.z === swapped.marker.z
    && swapped.enSuppression.bd.cells === 1,
  JSON.stringify({ creation: swapped.enCreation, suppression: swapped.enSuppression.st.anchor,
    pave: swapped.enSuppression.bd }));

// ============================================================ 14. the markers really paint
// A wireframe that loses the depth test against the block it wraps is invisible while
// every property still reads "visible": measure the rendered pixels instead.
await resetArena();
const painted = await page.evaluate(async ({ MARKER, FY }) => {
  const mc = window.__mc;
  mc.cancelSelection();
  mc.controls.isLocked = true;
  // The camera *is* the player: park it like resetArena does (flying, zero velocity,
  // eye height one cube above the floor) or the physics puts it back where it wants.
  mc.player.flyMode = true;
  mc.camera.position.set(MARKER.x - 4.5, FY + 2.62, MARKER.z + 0.5);
  mc.player.velocity.set(0, 0, 0);
  mc.look(-90, 0);
  mc.releaseAll();
  for (let i = 0; i < 3; i++) mc.step(1 / 120);
  const vise = mc.raycastVoxel(mc.camera.position, new mc.THREE.Vector3(1, 0, 0), 8);
  mc.clickDelete();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const gl = mc.renderer.getContext();
  // Compte les pixels quasi-noirs / quasi-blancs le long de segments donnés comme
  // paires d'indices dans une liste de points en coordonnées monde.
  function leLongDesSegments(coins, aretes) {
    mc.renderer.render(mc.scene, mc.camera);
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const buf = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const v = new mc.THREE.Vector3();
    const proj = [];
    for (const c of coins) {
      v.set(c[0], c[1], c[2]).project(mc.camera);
      if (v.z > 1) return { n: 0, noirs: 0, blancs: 0 };
      proj.push([(v.x * 0.5 + 0.5) * W, (1 - (v.y * 0.5 + 0.5)) * H]);
    }
    let n = 0, noirs = 0, blancs = 0;
    for (const [a, b] of aretes) {
      for (let k = 0; k <= 24; k++) {
        const t = k / 24;
        const x = Math.round(proj[a][0] + (proj[b][0] - proj[a][0]) * t);
        const y = Math.round(proj[a][1] + (proj[b][1] - proj[a][1]) * t);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        n++;
        const i = ((H - 1 - y) * W + x) * 4;
        const r = buf[i], g = buf[i + 1], bl = buf[i + 2];
        // Near-pure black / near-pure white: terrain shading never reaches either, so
        // only the marker lines can trip these counts.
        if (Math.max(r, g, bl) < 25) noirs++;
        if (Math.min(r, g, bl) > 170) blancs++;
      }
    }
    return { n, noirs, blancs };
  }

  const ARETES_CUBE = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]];
  const coinsCube = (cote) => {
    const out = [];
    for (const a of [-0.5, 0.5]) for (const b of [-0.5, 0.5]) for (const c of [-0.5, 0.5]) {
      out.push([MARKER.x + 0.5 + a * cote, MARKER.y + 0.5 + b * cote, MARKER.z + 0.5 + c * cote]);
    }
    return out;
  };
  // The face square sits on the marker's west face — the one the eye is looking at.
  const FACE_X = MARKER.x - 0.02, FYE = MARKER.y + 0.5, FZE = MARKER.z + 0.5, S = 0.45;
  const COINS_FACE = [
    [FACE_X, FYE - S, FZE - S], [FACE_X, FYE + S, FZE - S],
    [FACE_X, FYE + S, FZE + S], [FACE_X, FYE - S, FZE + S],
  ];
  const ARETES_FACE = [[0,1],[1,2],[2,3],[3,0]];

  const etat = {
    camera: [mc.camera.position.x, mc.camera.position.y, mc.camera.position.z].map((n) => +n.toFixed(2)),
    vise: vise ? [vise.x, vise.y, vise.z] : null,
    carreVisible: mc.highlight.visible,
    apercuVisible: mc.selectionPreview.visible,
  };
  const ancre = mc.selectionState().anchor;
  const avec = { noir: leLongDesSegments(coinsCube(1.04), ARETES_CUBE), blanc: leLongDesSegments(coinsCube(0.97), ARETES_CUBE) };
  mc.highlight.visible = false;
  const sansCarre = { noir: leLongDesSegments(coinsCube(1.04), ARETES_CUBE) };
  mc.selectionPreview.visible = false;
  const sansApercu = { blanc: leLongDesSegments(coinsCube(0.97), ARETES_CUBE) };
  mc.highlight.visible = true;
  mc.selectionPreview.visible = true;

  // Back to the idle cursor: the square laid on the aimed face is what shows before
  // any click, so measure it with the selection dropped and a couple of real frames.
  mc.cancelSelection();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const carreAvec = leLongDesSegments(COINS_FACE, ARETES_FACE);
  mc.faceMarker.visible = false;
  const carreSans = leLongDesSegments(COINS_FACE, ARETES_FACE);
  mc.faceMarker.visible = true;
  mc.controls.isLocked = false;
  return { ancre, avec, sansCarre, sansApercu, carreAvec, carreSans, etat };
}, { MARKER, FY });

const detail = `${painted.avec.noir.noirs}/${painted.avec.noir.n} noirs, masque ${painted.sansCarre.noir.noirs}/${painted.sansCarre.noir.n}`
  + ` · ${painted.avec.blanc.blancs}/${painted.avec.blanc.n} blancs, masque ${painted.sansApercu.blanc.blancs}/${painted.sansApercu.blanc.n}`
  + ` · carré de face ${painted.carreAvec.noirs}/${painted.carreAvec.n}, masque ${painted.carreSans.noirs}/${painted.carreSans.n}`
  + ` · ${JSON.stringify(painted.etat)}`;
check('le cube marqué en destruction est bien entouré du carré noir',
  painted.ancre && painted.ancre.x === MARKER.x && painted.ancre.y === MARKER.y && painted.ancre.z === MARKER.z
    && painted.avec.noir.n > 200
    && painted.avec.noir.noirs >= painted.avec.noir.n * 0.25
    && painted.sansCarre.noir.noirs <= painted.sansCarre.noir.n * 0.05,
  detail);

check('le cadre de l’aperçu de sélection est peint',
  painted.avec.blanc.n > 200
    && painted.avec.blanc.blancs >= painted.avec.blanc.n * 0.35
    && painted.sansApercu.blanc.blancs <= painted.sansApercu.blanc.n * 0.1,
  detail);

check('avant tout clic, un carré est peint sur la face visée',
  painted.carreAvec.n >= 80
    && painted.carreAvec.noirs >= painted.carreAvec.n * 0.3
    && painted.carreSans.noirs <= painted.carreSans.n * 0.05,
  detail);

// ============================================================ 15. screenshots + hygiene
fs.mkdirSync(SHOTS, { recursive: true });
await page.evaluate(({ MARKER }) => {
  const mc = window.__mc;
  mc.cancelSelection();
  // Eye level of the marked row so the mark is guaranteed to land on a solid cube.
  mc.camera.position.set(MARKER.x - 6.5, MARKER.y + 0.5, MARKER.z + 0.5);
  mc.look(-90, 0);
  mc.inventory.pick(mc.BLOCK.BRICK);
  mc.clickCreate();
  for (let i = 0; i < 5; i++) mc.wheelSelection(1);
}, { MARKER });
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(SHOTS, '05-selection-creation.png') });
await page.evaluate(() => {
  const mc = window.__mc;
  mc.clickDelete();                 // same box, re-armed for digging
});
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(SHOTS, '06-selection-suppression.png') });
await page.evaluate(() => window.__mc.cancelSelection());

const ignorable = (x) => /favicon|Failed to load resource/i.test(String(x));
const realErrors = consoleErrors.filter((e) => !ignorable(e));
const realBad = badResponses.filter((u) => !ignorable(u));
check('aucune erreur console pendant les manipulations de sélection',
  realErrors.length === 0 && realBad.length === 0,
  [...new Set([...realErrors.slice(0, 3), ...realBad.slice(0, 3)])].join(' | '));

await browser.close();
const failed = summary();
console.log(`captures: ${SHOTS}`);
process.exit(failed ? 1 : 0);
