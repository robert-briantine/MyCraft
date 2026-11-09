// Headless verification of the voxel renderer + player collision.
// Usage: node tests/render-collision.mjs [url]
// Needs the static server running (npm start / node server.js).
import fs from 'node:fs';
import path from 'node:path';
import { openGame, makeReporter } from './browser.mjs';

const URL = process.argv[2] || 'http://localhost:8080';
const SHOTS = process.env.SHOT_DIR || '.qwen/tmp/mc-shots';

const { check, summary } = makeReporter();
const { browser, page, consoleErrors, badResponses, servedUrls } = await openGame(URL);

// ---------------------------------------------------------------- helpers
const STONE = 3, GLASS = 17, WATER = 7, LAVA = 19, LEAVES = 5, AIR = 0;

const setupArena = (cx, cz, r, floorY) => page.evaluate(({ cx, cz, r, floorY, STONE, AIR }) => {
  const mc = window.__mc;
  for (let x = cx - r; x <= cx + r; x++) {
    for (let z = cz - r; z <= cz + r; z++) {
      for (let y = floorY - 2; y <= floorY + 8; y++) {
        mc.setBlock(x, y, z, y === floorY ? STONE : AIR);
      }
    }
  }
  mc.world.updateChunks(cx, cz);
  return true;
}, { cx, cz, r, floorY, STONE, AIR });

const placePlayer = (x, feet, z) => page.evaluate(({ x, feet, z, EYE }) => {
  const mc = window.__mc;
  mc.camera.position.set(x, feet + EYE, z);
  mc.player.velocity.set(0, 0, 0);
  mc.player.flyMode = false;
  mc.releaseAll();
  for (let i = 0; i < 30; i++) mc.step(1 / 120);
  return true;
}, { x, feet, z, EYE: 1.62 });

const run = (frames, dt = 1 / 60) => page.evaluate(({ frames, dt }) => {
  const mc = window.__mc;
  for (let i = 0; i < frames; i++) mc.step(dt);
  return true;
}, { frames, dt });

// Steps one frame at a time and records the trajectory so assertions can talk
// about what happened during the move, not just where it ended.
const runTrace = (frames, dt = 1 / 60) => page.evaluate(({ frames, dt }) => {
  const mc = window.__mc;
  const trace = [];
  for (let i = 0; i < frames; i++) {
    mc.step(dt);
    trace.push({ x: mc.camera.position.x, feet: mc.feetY(), vy: mc.player.velocity.y });
  }
  return trace;
}, { frames, dt });

const state = () => page.evaluate(() => {
  const mc = window.__mc;
  return {
    x: mc.camera.position.x,
    y: mc.camera.position.y,
    z: mc.camera.position.z,
    feet: mc.feetY(),
    vy: mc.player.velocity.y,
    onGround: mc.player.onGround,
  };
});

const setBlocks = (ops) => page.evaluate(({ ops }) => {
  for (const [x, y, z, id] of ops) window.__mc.setBlock(x, y, z, id);
  return true;
}, { ops });

// ================================================================ 1. boot
check('le jeu démarre sans exception', !consoleErrors.some((e) => e.startsWith('pageerror')),
  consoleErrors.filter((e) => e.startsWith('pageerror')).slice(0, 2).join(' | '));

const boot = await page.evaluate(() => {
  const mc = window.__mc;
  const meshes = [];
  mc.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const opaque = meshes.filter((m) => m.material === mc.world.matOpaque);
  const trans = meshes.filter((m) => m.material === mc.world.matTrans);
  const totalTris = meshes.reduce((s, m) => s + m.geometry.index.count / 3, 0);
  return {
    hasMap: !!mc.world.matOpaque.map,
    sameAtlas: opaque.every((m) => m.material.map === mc.atlas.texture),
    atlasSize: [mc.atlas.canvas.width, mc.atlas.canvas.height],
    meshCount: meshes.length,
    opaqueMeshes: opaque.length,
    transMeshes: trans.length,
    totalTris,
    tiles: mc.atlas.tileNames.length,
  };
});

check('chunk material samples the procedural atlas', boot.hasMap && boot.sameAtlas,
  `atlas ${boot.atlasSize.join('x')}px, ${boot.tiles} tuiles`);
check('world geometry is built', boot.totalTris > 5000 && boot.opaqueMeshes > 20,
  `${boot.meshCount} meshes, ${Math.round(boot.totalTris)} triangles`);

// top faces used to get degenerate UVs (v constant) -> smeared texture
const uvHealth = await page.evaluate(() => {
  const mc = window.__mc;
  let topTris = 0, degenerate = 0, sideDegenerate = 0, sideTris = 0;
  mc.scene.traverse((o) => {
    if (!o.isMesh || o.material !== mc.world.matOpaque) return;
    const pos = o.geometry.getAttribute('position');
    const nor = o.geometry.getAttribute('normal');
    const uv = o.geometry.getAttribute('uv');
    const idx = o.geometry.index;
    for (let i = 0; i < idx.count; i += 3) {
      const [a, b, c] = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)];
      const ny = nor.getY(a);
      const us = [uv.getX(a), uv.getX(b), uv.getX(c)];
      const vs = [uv.getY(a), uv.getY(b), uv.getY(c)];
      const spread = (arr) => Math.max(...arr) - Math.min(...arr);
      if (ny > 0.5) {
        topTris++;
        if (spread(us) < 1e-4 || spread(vs) < 1e-4) degenerate++;
      } else if (Math.abs(ny) < 0.5) {
        sideTris++;
        if (spread(us) < 1e-4 || spread(vs) < 1e-4) sideDegenerate++;
      }
    }
  });
  return { topTris, degenerate, sideTris, sideDegenerate };
});
check('top/side face UVs are non-degenerate',
  uvHealth.topTris > 100 && uvHealth.degenerate === 0 && uvHealth.sideDegenerate === 0,
  `${uvHealth.topTris} top tris, ${uvHealth.degenerate} dégénérées`);

// winding must be CCW seen from outside now that opaque faces use FrontSide
const winding = await page.evaluate(() => {
  const mc = window.__mc;
  let wrong = 0, tris = 0;
  mc.scene.traverse((o) => {
    if (!o.isMesh || o.material !== mc.world.matOpaque) return;
    const p = o.geometry.getAttribute('position');
    const n = o.geometry.getAttribute('normal');
    const idx = o.geometry.index;
    const A = new mc.THREE.Vector3(), B = new mc.THREE.Vector3(), C = new mc.THREE.Vector3();
    const ab = new mc.THREE.Vector3(), ac = new mc.THREE.Vector3(), cross = new mc.THREE.Vector3();
    for (let i = 0; i < idx.count; i += 3) {
      const [a, b, c] = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)];
      A.fromBufferAttribute(p, a); B.fromBufferAttribute(p, b); C.fromBufferAttribute(p, c);
      ab.subVectors(B, A); ac.subVectors(C, A); cross.crossVectors(ab, ac);
      const nn = new mc.THREE.Vector3().fromBufferAttribute(n, a);
      tris++;
      if (cross.dot(nn) < 0) wrong++;
    }
  });
  return { wrong, tris };
});
check('opaque faces are front-facing (CCW)', winding.wrong === 0 && winding.tris > 1000,
  `${winding.tris} triangles vérifiés`);

const ao = await page.evaluate(() => {
  const mc = window.__mc;
  const levels = new Set();
  mc.scene.traverse((o) => {
    if (!o.isMesh || o.material !== mc.world.matOpaque) return;
    const col = o.geometry.getAttribute('color');
    for (let i = 0; i < col.count; i++) levels.add(col.getX(i).toFixed(3));
  });
  return [...levels].sort();
});
check('per-vertex ambient occlusion darkens corners', ao.length >= 6,
  `${ao.length} niveaux de lumière distincts`);

// ================================================================ 2. gravity
const A = { cx: 300, cz: 300, r: 6, floorY: 20 };
await setupArena(A.cx, A.cz, A.r, A.floorY);
await placePlayer(300.5, 21, 300.5);
let s = await state();
check('player rests exactly on the floor block', Math.abs(s.feet - 21) < 1e-6 && s.onGround,
  `feet=${s.feet.toFixed(4)} onGround=${s.onGround}`);

await run(180);
s = await state();
check('no jitter / sinking while idle', Math.abs(s.feet - 21) < 1e-6 && s.onGround,
  `feet=${s.feet.toFixed(4)}`);

// jump returns to the same resting height
await page.evaluate(() => window.__mc.press('Space'));
await run(12);
const peak = await state();
await page.evaluate(() => window.__mc.releaseAll());
await run(180);
s = await state();
check('jump goes up and lands back flush', peak.feet > 21.3 && Math.abs(s.feet - 21) < 1e-6,
  `pic=${peak.feet.toFixed(2)} retour=${s.feet.toFixed(4)}`);

// ================================================================ 3. tunnelling
await page.evaluate(() => {
  const mc = window.__mc;
  mc.camera.position.set(300.5, 21 + 40 + 1.62, 300.5);
  mc.player.velocity.set(0, 0, 0);
  mc.releaseAll();
});
await run(90, 0.1); // 3 blocks per frame at terminal velocity
s = await state();
check('no tunnelling through the floor at large dt', Math.abs(s.feet - 21) < 1e-6 && s.onGround,
  `feet=${s.feet.toFixed(4)}`);

// ================================================================ 4. walls
await page.evaluate(() => {
  const mc = window.__mc;
  mc.look(-90, 0); // forward = +X
  mc.camera.position.set(300.5, 21 + 1.62, 300.5);
  mc.player.velocity.set(0, 0, 0);
  mc.releaseAll();
});
await run(20);
const wallX = 303; // block column occupies [303, 304]
const wallOps = [];
for (let z = 295; z <= 306; z++) for (let y = 21; y <= 27; y++) wallOps.push([wallX, y, z, STONE]);
await setBlocks(wallOps);
await page.evaluate(() => window.__mc.press('KeyW'));
await run(240);
s = await state();
check('stops flush against a wall, never inside it',
  s.x <= wallX + 1e-6 && Math.abs(s.x - (wallX - 0.3)) < 0.02,
  `x=${s.x.toFixed(4)} attendu≈${(wallX - 0.3).toFixed(2)}`);
await page.evaluate(() => window.__mc.releaseAll());

// sliding along the wall must keep working: pushed into the wall *and* strafing,
// the player should glide along it instead of sticking at the contact point.
await page.evaluate(() => {
  const mc = window.__mc;
  mc.look(-90, 0);
  mc.press('KeyW');
  mc.press('KeyD');
});
const slideStart = (await state()).z;
await run(40);
s = await state();
check('glisse le long du mur au lieu de rester collé',
  Math.abs(s.x - (wallX - 0.3)) < 0.02 && s.z > slideStart + 3 && s.z <= 306.5,
  `z=${s.z.toFixed(2)} (+${(s.z - slideStart).toFixed(2)}) x=${s.x.toFixed(3)}`);
await page.evaluate(() => window.__mc.releaseAll());

// ---------------------------------------------------- glass / leaves solid
for (const [label, id, shouldStop] of [['verre', GLASS, true], ['feuilles', LEAVES, true]]) {
  await placePlayer(300.5, 21, 300.5);
  await page.evaluate(() => window.__mc.look(-90, 0));
  await setBlocks([[302, 21, 300, id], [302, 22, 300, id]]);
  await page.evaluate(() => window.__mc.press('KeyW'));
  await run(200);
  s = await state();
  check(`${label} bloque le joueur`, s.x <= 302 + 1e-6, `x=${s.x.toFixed(3)}`);
  await page.evaluate(() => window.__mc.releaseAll());
  await setBlocks([[302, 21, 300, AIR], [302, 22, 300, AIR]]);
}

// ---------------------------------------------------- liquids are not solid
await setupArena(A.cx, A.cz, A.r, A.floorY);
await placePlayer(300.5, 21, 300.5);
await page.evaluate(() => window.__mc.look(-90, 0));
await setBlocks([[302, 21, 300, WATER], [302, 22, 300, WATER]]);
const waterSolid = await page.evaluate(() => window.__mc.world.isSolid(302, 21, 300));
await page.evaluate(() => window.__mc.press('KeyW'));
await run(150);
s = await state();
check('l’eau n’est pas solide et laisse passer le joueur',
  waterSolid === false && s.x > 302.5, `isSolid=${waterSolid} x=${s.x.toFixed(2)}`);
await page.evaluate(() => window.__mc.releaseAll());
await setBlocks([[302, 21, 300, AIR], [302, 22, 300, AIR]]);

// lava: non solid but heavily damped, no free fall through it
await setBlocks([
  [299, 21, 299, LAVA], [300, 21, 299, LAVA], [301, 21, 299, LAVA],
  [299, 21, 300, LAVA], [300, 21, 300, LAVA], [301, 21, 300, LAVA],
  [299, 21, 301, LAVA], [300, 21, 301, LAVA], [301, 21, 301, LAVA],
  [300, 22, 300, LAVA], [300, 23, 300, LAVA], [300, 24, 300, LAVA],
]);
await page.evaluate(() => {
  const mc = window.__mc;
  mc.camera.position.set(300.5, 21 + 8 + 1.62, 300.5);
  mc.player.velocity.set(0, 0, 0);
  mc.releaseAll();
});
const lavaFall = await page.evaluate(() => {
  const mc = window.__mc;
  // lava fills y=21..24, so its surface sits at y=25
  let tEnter = null, tBottom = null, minVyDeep = 0;
  for (let i = 0; i < 900; i++) {
    mc.step(1 / 60);
    const f = mc.feetY();
    if (tEnter === null && f < 24) tEnter = i;
    if (tEnter !== null && f > 21.5) minVyDeep = Math.min(minVyDeep, mc.player.velocity.y);
    if (tEnter !== null && f <= 21.001) { tBottom = i; break; }
  }
  return { tEnter, tBottom, minVyDeep, feet: mc.feetY() };
});
const lavaSeconds = lavaFall.tEnter === null ? 0 : (lavaFall.tBottom - lavaFall.tEnter) / 60;
check('chute amortie dans la lave (pas de vitesse terminale)',
  lavaFall.tEnter !== null && lavaFall.tBottom !== null &&
  lavaFall.minVyDeep > -3.6 && lavaSeconds > 0.6 && Math.abs(lavaFall.feet - 21) < 0.05,
  `vy min=${lavaFall.minVyDeep.toFixed(2)} traversée=${lavaSeconds.toFixed(2)}s feet=${lavaFall.feet.toFixed(2)}`);

// ================================================================ 5. step up
await setupArena(320, 300, 12, 20);
await placePlayer(320.5, 21, 300.5);
await page.evaluate(() => window.__mc.look(-90, 0));
await setBlocks([[322, 21, 300, STONE]]);
await page.evaluate(() => window.__mc.press('KeyW'));
const climb = await runTrace(110);
await page.evaluate(() => window.__mc.releaseAll());
// while overlapping the step block in x, the feet must already be on top of it
const neverInside = climb.every((t) =>
  t.x + 0.3 <= 322 + 1e-6 ||       // not reached yet
  t.x - 0.3 >= 323 - 1e-6 ||       // already past it
  t.feet >= 21.99);                // standing on top of it
check('monte automatiquement sur un bloc d’un cran',
  neverInside &&
  climb.some((t) => Math.abs(t.feet - 22) < 1e-6) &&
  climb.some((t) => t.x > 322.5 && t.feet > 21.5),
  `maxFeet=${Math.max(...climb.map((t) => t.feet)).toFixed(2)} maxX=${Math.max(...climb.map((t) => t.x)).toFixed(2)}`);
await setBlocks([[322, 21, 300, AIR]]);

// a two block high wall must stay impassable
await placePlayer(320.5, 21, 300.5);
await page.evaluate(() => window.__mc.look(-90, 0));
await setBlocks([[322, 21, 300, STONE], [322, 22, 300, STONE]]);
await page.evaluate(() => window.__mc.press('KeyW'));
const blockedRun = await runTrace(150);
await page.evaluate(() => window.__mc.releaseAll());
check('un mur de 2 blocs reste infranchissable',
  blockedRun.every((t) => t.feet < 21.5 && t.x <= 322 + 1e-6),
  `maxFeet=${Math.max(...blockedRun.map((t) => t.feet)).toFixed(2)} maxX=${Math.max(...blockedRun.map((t) => t.x)).toFixed(2)}`);
await setBlocks([[322, 21, 300, AIR], [322, 22, 300, AIR]]);

// ================================================================ 6. placement
await placePlayer(320.5, 21, 300.5);
const selfPlace = await page.evaluate(({ STONE }) => {
  const mc = window.__mc;
  const before = mc.world.getBlock(Math.floor(mc.camera.position.x), Math.floor(mc.feetY()), Math.floor(mc.camera.position.z));
  const blocked = mc.player.intersectsBlock(Math.floor(mc.camera.position.x), Math.floor(mc.feetY()), Math.floor(mc.camera.position.z));
  return { before, blocked };
}, { STONE });
check('un bloc posé sur le joueur est refusé', selfPlace.blocked === true,
  `bloc sous les pieds=${selfPlace.before}`);

// breaking what we look at
const broke = await page.evaluate(({ STONE }) => {
  const mc = window.__mc;
  mc.look(-90, 0); // forward = +X
  mc.setBlock(323, 22, 300, STONE);
  mc.camera.position.set(321.5, 22.62, 300.5);
  mc.player.velocity.set(0, 0, 0);
  mc.releaseAll();
  for (let i = 0; i < 10; i++) mc.step(1 / 120);
  const hit = mc.raycastVoxel(mc.camera.position, new mc.THREE.Vector3(1, 0, 0), 8);
  if (!hit) return { ok: false, why: 'aucun bloc visé' };
  mc.world.setBlock(hit.x, hit.y, hit.z, 0);
  return { ok: mc.world.getBlock(hit.x, hit.y, hit.z) === 0, hit };
}, { STONE });
check('casser un bloc devant soi fonctionne', broke.ok === true, JSON.stringify(broke.hit || broke.why));

// ================================================================ 7. textures differ
const tileStats = await page.evaluate(() => {
  const mc = window.__mc;
  const sig = (name) => {
    const c = mc.atlas.tileCanvas(name);
    const d = c.getContext('2d').getImageData(0, 0, 16, 16).data;
    let sum = [0, 0, 0], alphaHoles = 0;
    const uniq = new Set();
    for (let i = 0; i < d.length; i += 4) {
      sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2];
      if (d[i + 3] === 0) alphaHoles++;
      uniq.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    }
    const n = d.length / 4;
    return { avg: sum.map((v) => Math.round(v / n)), uniq: uniq.size, alphaHoles };
  };
  return {
    grass_top: sig('grass_top'),
    grass_side: sig('grass_side'),
    dirt: sig('dirt'),
    stone: sig('stone'),
    brick: sig('brick'),
    leaves: sig('leaves'),
    glass: sig('glass'),
    water: sig('water'),
    planks: sig('planks'),
  };
});
const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
const detailed = ['grass_top', 'grass_side', 'dirt', 'stone', 'brick', 'planks', 'water', 'leaves'];
check('les tuiles sont distinctes et détaillées',
  dist(tileStats.grass_top.avg, tileStats.dirt.avg) > 60 &&
  dist(tileStats.stone.avg, tileStats.brick.avg) > 60 &&
  detailed.every((k) => tileStats[k].uniq > 12),
  detailed.map((k) => `${k}:${tileStats[k].uniq}c`).join(' '));
check('herbe: face du dessus différente des côtés',
  dist(tileStats.grass_top.avg, tileStats.grass_side.avg) > 25,
  `dessus=${tileStats.grass_top.avg} côté=${tileStats.grass_side.avg}`);
check('feuilles et verre ont des trous alpha',
  tileStats.leaves.alphaHoles > 10 && tileStats.glass.alphaHoles > 100,
  `feuilles=${tileStats.leaves.alphaHoles} verre=${tileStats.glass.alphaHoles}`);

// the uploaded-texture panel paints into the same atlas, then gives it back
const override = await page.evaluate(() => {
  const mc = window.__mc;
  const avg = (cv) => {
    const d = cv.getContext('2d').getImageData(0, 0, 16, 16).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  };
  const before = avg(mc.atlas.tileCanvas('stone'));
  const src = document.createElement('canvas');
  src.width = src.height = 16;
  const sctx = src.getContext('2d');
  sctx.fillStyle = '#ff00ff';
  sctx.fillRect(0, 0, 16, 16);
  const applied = mc.world.setBlockTexture(mc.BLOCK.STONE, src);
  const during = avg(mc.atlas.tileCanvas('stone'));
  const restored = mc.world.restoreBlockTexture(mc.BLOCK.STONE);
  const after = avg(mc.atlas.tileCanvas('stone'));
  return { applied, restored, before, during, after };
});
const closeTo = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 6;
check('texture custom peinte dans l’atlas puis restaurée',
  override.applied && override.restored &&
  override.during[0] > 200 && override.during[1] < 60 && override.during[2] > 200 &&
  closeTo(override.after, override.before),
  `pierre=${override.before} → custom=${override.during} → retour=${override.after}`);

// deterministic across reloads?
const firstPass = await page.evaluate(() => {
  const mc = window.__mc;
  const c = mc.atlas.tileCanvas('cobble');
  return Array.from(c.getContext('2d').getImageData(0, 0, 16, 16).data.slice(0, 64));
});

// ================================================================ 8. screenshots
fs.mkdirSync(SHOTS, { recursive: true });

// The atlas itself, blown up 4x with nearest neighbour so every pixel reads.
await page.evaluate(() => {
  const mc = window.__mc;
  const c = document.createElement('canvas');
  c.width = mc.atlas.canvas.width * 4;
  c.height = mc.atlas.canvas.height * 4;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#1b1b1b';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(mc.atlas.canvas, 0, 0, c.width, c.height);
  c.id = 'atlas-preview';
  c.style.cssText = 'position:fixed;left:0;top:0;z-index:9999';
  document.body.appendChild(c);
});
await page.screenshot({ path: path.join(SHOTS, '00-atlas.png') });
await page.evaluate(() => document.getElementById('atlas-preview').remove());

// Vista shot: pick the tallest column nearby so the camera looks over the
// landscape instead of into a hillside, and freeze gravity for the shot.
const vista = await page.evaluate(() => {
  const mc = window.__mc;
  // L'image juge la végétation sous l'horizon : posée au-dessus d'une étendue de sable,
  // elle ne rend plus un pixel vert et fait échouer une image pourtant juste. Le monde
  // porte maintenant du sable, de l'herbe, des bois et — depuis les massifs — de la
  // roche nue et de la neige, donc le point de vue se cherche sur une large carte, noté
  // par la part de terrain vivant devant la caméra (fonctions pures, sans dépendre du
  // maillage), plutôt que dans une boîte fixe autour de l'origine.
  const B = mc.biomeParams;
  const noteVerte = (x, z) => {
    let verts = 0;
    let n = 0;
    for (let ax = x - 12; ax <= x + 12; ax += 4) {
      for (let az = z - 6; az <= z + 20; az += 4) {
        n++;
        // Sable, roche nue et névé rendent tous un gris ou un jaune qui ne compte pas
        // comme du végétal : la note ne doit retenir que l'herbe et les bois.
        if (mc.biomeAt(ax, az) === 'desert') continue;
        if (mc.getTerrainHeight(ax, az) >= B.treeLine) continue;
        verts++;
      }
    }
    return n ? verts / n : 0;
  };
  let best = null;
  for (let x = -240; x <= 240; x += 16) {
    for (let z = -240; z <= 240; z += 16) {
      const h = mc.getTerrainHeight(x, z);
      // rester dans l'étage herbeux : sous `sandLine` c'est la grève, au-dessus de
      // `treeLine` la roche nue, et plus haut encore la neige
      if (h < B.sandLine + 4 || h > B.treeLine - 2) continue;
      const verte = noteVerte(x, z);
      if (verte < 0.8) continue;
      const score = verte * 100 + h;
      if (!best || score > best.score) best = { x, z, h, score, verte };
    }
  }
  if (!best) {                                 // repli : la colonne la plus haute du secteur
    best = { x: 8, z: 8, h: 29, verte: 0 };
    for (let x = -60; x <= 60; x += 4) {
      for (let z = -60; z <= 60; z += 4) {
        const h = mc.getTerrainHeight(x, z);
        if (h >= B.sandLine + 4 && h <= B.treeLine - 2 && h > best.h) best = { x, z, h, verte: 0 };
      }
    }
  }
  mc.player.flyMode = true;
  mc.releaseAll();
  mc.camera.position.set(best.x + 0.5, best.h + 5.62, best.z + 14);
  mc.look(18, -14);
  mc.player.velocity.set(0, 0, 0);
  mc.world.updateChunks(best.x, best.z + 14);
  // Sous le rasteriseur logiciel des tests, le maillage traîne derrière la génération :
  // capturer sans vider la file laisse le fond du canvas occuper le bas de l'image, et
  // la mesure d'exposition ne juge plus le monde mais un écran non dessiné.
  for (let i = 0; i < 600 && mc.world.pendingChunks > 0; i++) { mc.streamAll(); mc.step(1 / 120); }
  for (let i = 0; i < 5; i++) mc.step(1 / 120);
  return best;
});
await page.screenshot({ path: path.join(SHOTS, '01-vue-generale.png') });

// ------------------------------------------------- what the GPU actually drew
const frame = await page.evaluate(() => {
  const mc = window.__mc;
  mc.renderer.render(mc.scene, mc.camera);
  const gl = mc.renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); // row 0 = bottom of the screen
  const uniq = new Set();
  const uniqTerrain = new Set(); // sky is a single flat colour, so judge detail below the horizon
  let lumSum = 0, saturated = 0, crushed = 0, greenish = 0, earthy = 0, bluish = 0, samples = 0;
  // Le bas de l'image est le sol (l'origine readPixels est en bas à gauche). Les
  // rues et les murs taillés du village sont gris : « terrain » ne veut plus dire
  // « brun », donc on compte là tout ce qui n'est ni ciel ni noir.
  let belowSamples = 0, groundBelow = 0;
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      const i = (y * w + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const bucket = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3);
      uniq.add(bucket);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (y < h / 2) {
        uniqTerrain.add(bucket);
        belowSamples++;
        const skyish = b > 190 && b > r; // brume bleutée du lointain
        if (!skyish && lum > 25 && lum < 235) groundBelow++;
      }
      lumSum += lum;
      if (lum < 12 || lum > 243) saturated++;
      if (lum < 20) crushed++;
      if (g > r * 1.15 && g > b * 1.15) greenish++;
      else if (r > g && g > b && r > 70) earthy++;
      else if (b > r * 1.25) bluish++;
      samples++;
    }
  }
  const pixelAt = (cx, cyFromTop) => {
    const i = ((h - 1 - cyFromTop) * w + cx) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  };
  return {
    size: [w, h],
    uniq: uniq.size,
    uniqTerrain: uniqTerrain.size,
    lum: lumSum / samples,
    saturatedFrac: saturated / samples,
    crushedFrac: crushed / samples,
    greenishFrac: greenish / samples,
    earthyFrac: earthy / samples,
    bluishFrac: bluish / samples,
    groundFrac: belowSamples ? groundBelow / belowSamples : 0,
    skyPixel: pixelAt(w >> 1, 8),
    groundPixel: pixelAt(w >> 1, h - 12),
  };
});
check('l’image rendue est riche et correctement exposée',
  frame.uniqTerrain > 150 && frame.lum > 45 && frame.lum < 215 &&
  frame.saturatedFrac < 0.25 && frame.crushedFrac < 0.1,
  `${frame.uniq} couleurs (${frame.uniqTerrain} sous l’horizon), luminance ${frame.lum.toFixed(0)}, ` +
  `noirs écrasés ${(frame.crushedFrac * 100).toFixed(1)}%`);
check('ciel en haut, végétation et sol en bas',
  frame.skyPixel[2] > frame.skyPixel[0] && frame.skyPixel[2] > 150 &&
  frame.greenishFrac > 0.05 && frame.groundFrac > 0.6,
  `ciel=[${frame.skyPixel}] sol=[${frame.groundPixel}] vert=${(frame.greenishFrac * 100).toFixed(1)}% `
  + `bas rempli=${(frame.groundFrac * 100).toFixed(0)}% (dont brun=${(frame.earthyFrac * 100).toFixed(1)}%)`);

await page.evaluate(() => {
  const mc = window.__mc;
  // stand next to a wall of mixed materials to inspect the textures up close
  const cx = 340, cz = 340, fy = 20;
  for (let x = cx - 4; x <= cx + 4; x++) {
    for (let z = cz - 4; z <= cz + 4; z++) {
      for (let y = fy - 2; y <= fy + 6; y++) mc.setBlock(x, y, z, y === fy ? 3 : 0);
    }
  }
  const ids = [1, 2, 3, 4, 8, 9, 6, 14, 16, 18, 10, 11, 12, 13, 15, 20];
  let k = 0;
  for (let x = cx - 3; x <= cx + 3; x++) {
    for (let y = fy + 1; y <= fy + 2; y++) mc.setBlock(x, y, cz - 4, ids[k++ % ids.length]);
  }
  // a hollow cube of cobble/stone so AO corners are visible
  for (let x = cx; x <= cx + 2; x++)
    for (let z = cz; z <= cz + 2; z++)
      for (let y = fy + 1; y <= fy + 3; y++)
        if (!(x > cx && x < cx + 2 && z > cz && z < cz + 2 && y < fy + 3)) mc.setBlock(x, y, z, 16);
  mc.world.updateChunks(cx, cz);
  mc.camera.position.set(cx + 1.5, fy + 2.2 + 1.62, cz + 8);
  mc.look(0, -8);
  mc.player.velocity.set(0, 0, 0);
  mc.releaseAll();
  for (let i = 0; i < 20; i++) mc.step(1 / 120);
});
await page.screenshot({ path: path.join(SHOTS, '02-textures-proches.png') });

await page.evaluate(() => {
  const mc = window.__mc;
  mc.camera.position.set(300.5, 21 + 1.62, 300.5);
  mc.look(0, 0);
  for (let i = 0; i < 10; i++) mc.step(1 / 120);
});
await page.screenshot({ path: path.join(SHOTS, '03-hud-hotbar.png') });

// determinism after reload
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => !!window.__mc, null, { timeout: 30000 });
const secondPass = await page.evaluate(() => {
  const mc = window.__mc;
  const c = mc.atlas.tileCanvas('cobble');
  return Array.from(c.getContext('2d').getImageData(0, 0, 16, 16).data.slice(0, 64));
});
check('textures déterministes après rechargement',
  JSON.stringify(firstPass) === JSON.stringify(secondPass));

// Every asset the page needs must actually be served. Chrome fetches
// /favicon.ico on its own (404 here) and that request never reaches the
// response listener, so the generic "Failed to load resource" line is audited
// through the URL list instead of the console text.
const EXPECTED_ASSETS = [
  'http://localhost:8080/',
  '/js/game.js',
  '/js/textures.js',
  '/js/saves.js',
  '/vendor/three/three.module.js',
  '/vendor/three/examples/jsm/controls/PointerLockControls.js',
  '/textures',
];
const missingAssets = EXPECTED_ASSETS.filter(
  (needle) => !servedUrls.some((entry) => entry.startsWith('200 ') && entry.includes(needle))
);
check('toutes les ressources attendues sont servies en 200', missingAssets.length === 0,
  missingAssets.join(', '));

// The desktop build ships these files inside the binary and has no network at
// runtime, so nothing may be fetched from a third-party host.
const external = [...new Set(servedUrls.map((e) => e.split(' ')[1]))]
  .filter((u) => /^https?:\/\//.test(u) && !u.startsWith('http://localhost:8080/'));
check('aucune ressource externe (le build bureau doit marcher hors ligne)',
  external.length === 0, external.slice(0, 3).join(', '));

// ============================================================ 8b. village praticable
// Le générateur est testé seul sous Node sur son propre tableau de voxels ; ici les
// mêmes bâtiments sont relus à travers le monde réellement chargé, ce qui attrape une
// erreur d'ordre ou de frontière de tronçon (routes estampillées après le bâtiment,
// végétation laissée sur la volée, écriture hors du tronçon).
//
// Page neuve, pas celle des sections précédentes : celles-ci ont creusé et bâti un peu
// partout autour du joueur et leurs blocs enregistrés écrasent la génération là où
// passe un escalier. On jugerait alors le montage de la suite, pas le village.
{
  const run = await openGame(URL);
  const vp = run.page;
  const probe = await vp.evaluate((MAX) => {
    const mc = window.__mc;
    const EYE = 1.62;
    const solid = (x, y, z) => mc.world.getBlock(x, y, z) !== mc.BLOCK.AIR;
    const cam0 = mc.camera.position;

    // Les plans seuls suffisent à choisir les candidats : ils ne dépendent pas du
    // chargement, contrairement aux voxels.
    const found = [];
    let batis = 0;
    const originX = Math.floor(cam0.x / 16);
    const originZ = Math.floor(cam0.z / 16);
    for (let cx = originX - 14; cx <= originX + 14; cx++) {
      for (let cz = originZ - 14; cz <= originZ + 14; cz++) {
        for (const plan of mc.villageAt(cx * 16, cz * 16)) {
          batis++;
          if (plan.kind !== 'tower' || !plan.stair) continue;
          found.push({ plan, cx, cz, distance: Math.hypot(cx * 16 - cam0.x, cz * 16 - cam0.z) });
        }
      }
    }
    found.sort((a, b) => a.distance - b.distance);

    const placer = (x, y, z) => {
      mc.releaseAll();
      mc.camera.position.set(x + 0.5, y + EYE, z + 0.5);
      mc.camera.rotation.set(0, 0, 0, 'YXZ');
      mc.player.velocity.set(0, 0, 0);
      mc.player.flyMode = false;
      for (let i = 0; i < 30; i++) mc.step(1 / 120);
    };
    // Marcher, pas téléporter : seul un joueur qui enfonce W révèle une volée trop
    // étroite, une voûte qui accroche le plafond ou une trappe murée.
    const avancerVers = (tx, tz, piedsAttendus, budget) => {
      for (let f = 0; f < budget; f++) {
        const cam = mc.camera.position;
        const dx = tx - cam.x;
        const dz = tz - cam.z;
        if (Math.hypot(dx, dz) < 0.34 && Math.abs(mc.feetY() - piedsAttendus) < 0.25) {
          mc.releaseAll();
          return { ok: true, frames: f, feet: mc.feetY(), x: cam.x, z: cam.z };
        }
        mc.camera.rotation.set(0, Math.atan2(-dx, -dz), 0, 'YXZ');
        mc.controls.keys.KeyW = true;
        mc.step(1 / 60);
      }
      mc.releaseAll();
      return { ok: false, frames: budget, feet: mc.feetY(), x: mc.camera.position.x, z: mc.camera.position.z };
    };

    const grimpes = [];
    for (const item of found) {
      if (grimpes.length >= MAX) break;
      const plan = item.plan;
      const bx = item.cx * 16;
      const bz = item.cz * 16;
      const roofY = plan.siteH + plan.height + 1;
      const door = plan.door;

      // Le streaming est budgété par image : on repompe jusqu'à voir la dalle, sinon
      // chaque lecture rendrait de l'air et tout semblerait cassé.
      placer(bx + door.front.lx, plan.siteH + 1, bz + door.front.lz);
      let attente = 0;
      while (attente < 6000 && !solid(bx + plan.x0 + 1, plan.siteH, bz + plan.z0 + 1)) {
        mc.streamAll();
        mc.step(1 / 60);
        attente++;
      }
      if (!solid(bx + plan.x0 + 1, plan.siteH, bz + plan.z0 + 1)) continue;

      // Une marche = deux colonnes : viser le centre de la paire, c'est là qu'un
      // joueur réel se dirige, pas au milieu de l'une des deux dalles.
      const vollee = plan.stair.treads.map((t) => {
        const cells = t.cells.map((c) => ({ x: bx + c.lx, z: bz + c.lz }));
        return {
          y: t.y,
          cx: (cells[0].x + cells[1].x) / 2 + 0.5,
          cz: (cells[0].z + cells[1].z) / 2 + 0.5,
          large: cells.length === 2,
          pleines: cells.every((c) => solid(c.x, t.y, c.z)),
          // Le corps fait 1,8 et l'auto-franchissement lève la tête d'un cran.
          garde: cells.every((c) => !solid(c.x, t.y + 1, c.z) && !solid(c.x, t.y + 2, c.z) && !solid(c.x, t.y + 3, c.z)),
        };
      });
      const lastTread = plan.stair.treads[plan.stair.treads.length - 1];
      const entree = plan.stair.exit.map((c) => ({ x: bx + c.lx, z: bz + c.lz }));
      const sortie = {
        cx: (entree[0].x + entree[1].x) / 2 + 0.5,
        cz: (entree[0].z + entree[1].z) / 2 + 0.5,
        pieds: roofY + 1,
        appui: entree.every((c) => solid(c.x, roofY, c.z)),
        tete: entree.every((c) => !solid(c.x, roofY + 1, c.z) && !solid(c.x, roofY + 2, c.z)),
      };

      const geo = {
        chunk: [item.cx, item.cz],
        lot: plan.lot,
        siteH: plan.siteH,
        hauteur: plan.height,
        marches: vollee.length,
        absentes: vollee.filter((m) => !m.pleines).length,
        sousVoute: vollee.filter((m) => !m.garde).length,
        etroites: vollee.filter((m) => !m.large).length,
        // La dalle doit être pleine sur toute l'emprise, sauf au droit des marches qui
        // passent à moins de trois cubes sous le plancher de toit : leur garde-tête
        // évide la dalle, c'est ce qui débouche sur la terrasse. Un seul échantillon au
        // centre laissait passer un trou réel dès que le puits tombait sur cette colonne.
        toitPlein: (() => {
          const puits = new Set();
          for (const t of plan.stair.treads) {
            if (roofY < t.y + 1 || roofY > t.y + 3) continue;
            for (const c of t.cells) puits.add(`${c.lx},${c.lz}`);
          }
          let trous = 0;
          for (let lx = plan.x0; lx < plan.x0 + plan.w; lx++) {
            for (let lz = plan.z0; lz < plan.z0 + plan.d; lz++) {
              const libre = !solid(bx + lx, roofY, bz + lz);
              if (libre !== puits.has(`${lx},${lz}`)) trous++;
            }
          }
          return trous === 0 && puits.size >= 2;
        })(),
        trappeOuverte: lastTread.cells.every((c) => !solid(bx + c.lx, roofY, bz + c.lz)
          && !solid(bx + c.lx, roofY + 1, bz + c.lz)),
        appuiToit: sortie.appui && sortie.tete,
        baie: !solid(bx + door.lx, plan.siteH + 1, bz + door.lz)
          && !solid(bx + door.lx, plan.siteH + 2, bz + door.lz),
        seuil: solid(bx + door.front.lx, plan.siteH, bz + door.front.lz)
          && !solid(bx + door.front.lx, plan.siteH + 1, bz + door.front.lz)
          && !solid(bx + door.front.lx, plan.siteH + 2, bz + door.front.lz),
      };

      placer(bx + door.front.lx, plan.siteH + 1, bz + door.front.lz);
      const dehors = { feet: mc.feetY(), auSol: !!mc.player.onGround };
      const pas = {
        dehors,
        entree: avancerVers(bx + door.in.lx + 0.5, bz + door.in.lz + 0.5, plan.siteH + 1, 240),
      };
      if (pas.entree.ok) {
        for (let i = 0; i < vollee.length; i++) {
          const c = vollee[i];
          const r = avancerVers(c.cx, c.cz, c.y + 1, 240);
          if (!r.ok) { pas.vollee = { index: i, cible: [c.cx, c.cz, c.y + 1], ...r }; break; }
        }
      } else {
        pas.vollee = { index: -1, cible: [], ...pas.entree };
      }
      if (!pas.vollee) pas.toit = avancerVers(sortie.cx, sortie.cz, sortie.pieds, 240);
      grimpes.push(Object.assign(geo, pas));
    }

    return {
      trouve: grimpes.length > 0,
      tours: found.length,
      batis,
      charges: mc.world.chunks.size,
      cam: [Math.round(cam0.x), Math.round(cam0.z)],
      grimpes,
    };
  }, 3);

  check('le monde chargé contient au moins un immeuble', probe.trouve === true,
    probe.trouve
      ? `${probe.grimpes.length} tour(s) gravie(s) sur ${probe.tours} vue(s), dont `
        + `${probe.grimpes[0].chunk.join(',')}#${probe.grimpes[0].lot} à ${probe.grimpes[0].hauteur} niveaux`
      : `${probe.tours} tour(s) vue(s) sur ${probe.batis} bâtiment(s) dans ${probe.charges} tronçons autour de ${probe.cam}`);
  if (probe.trouve) {
    const g = probe.grimpes;
    const combien = `${g.length} immeuble(s)`;
    const sum = (f) => g.reduce((n, b) => n + f(b), 0);
    const fails = (test, detail) => g.filter(test).map(detail).join(' | ');
    check('la dalle et le toit du bâtiment sont bien générés', g.every((b) => b.toitPlein),
      fails((b) => !b.toitPlein, (b) => `tronçon ${b.chunk}#${b.lot}`) || combien);
    check('chaque marche est posée, large d’un joueur et coiffée d’air',
      g.every((b) => b.marches > 0 && !b.absentes && !b.sousVoute && !b.etroites),
      `absente(s)=${sum((b) => b.absentes)}, sous une voûte=${sum((b) => b.sousVoute)}, `
      + `trop étroite(s)=${sum((b) => b.etroites)} sur ${sum((b) => b.marches)} marches`);
    check('la trappe du dernier étage ouvre sur le toit',
      g.every((b) => b.trappeOuverte && b.appuiToit),
      fails((b) => !b.trappeOuverte || !b.appuiToit, (b) => `tronçon ${b.chunk}#${b.lot} ouverte=${b.trappeOuverte} appui=${b.appuiToit}`) || combien);
    check('la baie de porte est bien percée dans le monde', g.every((b) => b.baie),
      fails((b) => !b.baie, (b) => `tronçon ${b.chunk}#${b.lot}`) || combien);
    check('le seuil devant la porte est praticable', g.every((b) => b.seuil),
      fails((b) => !b.seuil, (b) => `tronçon ${b.chunk}#${b.lot}`) || combien);
    check('on tient debout devant la porte, dans la rue',
      g.every((b) => b.dehors.auSol && Math.abs(b.dehors.feet - (b.siteH + 1)) < 0.25),
      fails((b) => !b.dehors.auSol || Math.abs(b.dehors.feet - (b.siteH + 1)) >= 0.25,
        (b) => `tronçon ${b.chunk}#${b.lot} pieds=${b.dehors.feet.toFixed(2)} attendu=${b.siteH + 1}`) || combien);
    check('le joueur entre par la porte en marchant', g.every((b) => b.entree.ok),
      fails((b) => !b.entree.ok, (b) => `tronçon ${b.chunk}#${b.lot} arrêté à ${b.entree.x.toFixed(2)},${b.entree.z.toFixed(2)} pieds=${b.entree.feet.toFixed(2)}`) || combien);
    check('le joueur monte tout l’escalier en marchant', g.every((b) => !b.vollee),
      fails((b) => b.vollee, (b) => `tronçon ${b.chunk}#${b.lot} bloqué à la marche ${b.vollee.index} `
        + `(cible ${b.vollee.cible.join(',')}) resté à ${b.vollee.x.toFixed(2)},${b.vollee.z.toFixed(2)} pieds=${b.vollee.feet.toFixed(2)}`)
        || `${sum((b) => b.marches)} marches gravies sur ${combien}`);
    check('la trappe du dernier étage mène sur le toit en marchant',
      g.every((b) => !!b.toit && b.toit.ok),
      fails((b) => !b.toit || !b.toit.ok, (b) => `tronçon ${b.chunk}#${b.lot} resté à `
        + (b.toit ? `${b.toit.x.toFixed(2)},${b.toit.z.toFixed(2)} pieds=${b.toit.feet.toFixed(2)}` : 'escalier non gravi')) || combien);
  }
  await vp.close();
}

// ============================================================ 8c. ouvrages d'art
// Ponts et arcs ne valent que si on les traverse : un tablier posé deux cubes trop
// haut est un mur, un arc dont le passage est trop étroit coupe l'avenue en deux.
// Comme pour les immeubles, c'est le joueur qui marche qui tranche, pas la lecture des
// plans — les plans sont déjà vérifiés par tests/village.mjs.
{
  const run = await openGame(URL);
  const vp = run.page;
  const probe = await vp.evaluate((MAX) => {
    const mc = window.__mc;
    const EYE = 1.62;
    const SP = mc.villageParams.roadSpacing;
    const solid = (x, y, z) => mc.world.getBlock(x, y, z) !== mc.BLOCK.AIR;
    const cam0 = mc.camera.position;

    const found = new Map();
    const originX = Math.floor(cam0.x / 16);
    const originZ = Math.floor(cam0.z / 16);
    for (let cx = originX - 14; cx <= originX + 14; cx++) {
      for (let cz = originZ - 14; cz <= originZ + 14; cz++) {
        for (const s of mc.structuresAt(cx * 16, cz * 16)) {
          found.set(`${s.kind}:${s.axis}:${s.k}:${s.seg}`, s);
        }
      }
    }
    const centreOf = (s) => (s.axis === 'x'
      ? { wx: s.centre, wz: s.k * SP }
      : { wx: s.k * SP, wz: s.centre });
    const cellWorld = (axis, k, along, off) => (axis === 'x'
      ? { wx: along, wz: k * SP + off }
      : { wx: k * SP + off, wz: along });

    const placer = (x, y, z) => {
      mc.releaseAll();
      mc.camera.position.set(x + 0.5, y + EYE, z + 0.5);
      mc.camera.rotation.set(0, 0, 0, 'YXZ');
      mc.player.velocity.set(0, 0, 0);
      mc.player.flyMode = false;
      for (let i = 0; i < 30; i++) mc.step(1 / 120);
    };
    const avancerVers = (tx, tz, piedsAttendus, budget) => {
      for (let f = 0; f < budget; f++) {
        const cam = mc.camera.position;
        const dx = tx - cam.x;
        const dz = tz - cam.z;
        if (Math.hypot(dx, dz) < 0.34 && Math.abs(mc.feetY() - piedsAttendus) < 0.25) {
          mc.releaseAll();
          return { ok: true, frames: f, feet: mc.feetY(), x: cam.x, z: cam.z };
        }
        mc.camera.rotation.set(0, Math.atan2(-dx, -dz), 0, 'YXZ');
        mc.controls.keys.KeyW = true;
        mc.step(1 / 60);
      }
      mc.releaseAll();
      return { ok: false, frames: budget, feet: mc.feetY(), x: mc.camera.position.x, z: mc.camera.position.z };
    };
    // Le streaming est budgété par image et `streamAll` ne rappelle `updateChunks` que
    // si la file est déjà non vide : il faut donc poser le joueur puis simuler, comme
    // pour les immeubles, jusqu'à ce que l'ouvrage sorte réellement du sol chargé.
    const marche = (label, axis, k, from, to, levelOf, budget, pret) => {
      const depart = cellWorld(axis, k, from, 0);
      placer(depart.wx, levelOf(from) + 1, depart.wz);
      let attente = 0;
      while (attente++ < 3000 && !pret()) {
        mc.streamAll();
        mc.step(1 / 60);
      }
      if (!pret()) return { ok: false, reason: 'ouvrage absent du monde chargé', nonCharge: true, label };
      let cur = from;
      while (cur < to) {
        const next = Math.min(to, cur + 3);
        const c = cellWorld(axis, k, next, 0);
        const r = avancerVers(c.wx + 0.5, c.wz + 0.5, levelOf(next) + 1, budget);
        if (!r.ok) {
          return { ok: false, colonne: next, attendu: levelOf(next) + 1, ...r, label };
        }
        cur = next;
      }
      return { ok: true, colonnes: to - from, label };
    };

    // Sous un tablier, le sol que foulent les pieds n'est pas celui que prédit
    // getTerrainHeight : la rue y a posé son propre remblai d'approche et l'arc a pu
    // niveler le vallon. Exiger l'altitude naturelle ferait échouer une marche
    // pourtant réussie. Ce qui compte est qu'on progresse colonne par colonne sans
    // être arrêté, les pieds au sol — le garde-fou propre à chaque passage est passé
    // en callback (`garde`) parce que c'est lui qui dit si on est bien *sous* l'ouvrage.
    const avancerLibre = (tx, tz, budget) => {
      const x0 = mc.camera.position.x, z0 = mc.camera.position.z;
      let sansBouger = 0;
      for (let f = 0; f < budget; f++) {
        const cam = mc.camera.position;
        const dx = tx - cam.x;
        const dz = tz - cam.z;
        if (Math.hypot(dx, dz) < 0.4 && mc.player.onGround) {
          mc.releaseAll();
          return { ok: true, feet: mc.feetY(), x: cam.x, z: cam.z };
        }
        mc.camera.rotation.set(0, Math.atan2(-dx, -dz), 0, 'YXZ');
        mc.controls.keys.KeyW = true;
        mc.step(1 / 60);
        sansBouger = Math.hypot(mc.camera.position.x - x0, mc.camera.position.z - z0) < 0.05 ? sansBouger + 1 : 0;
        if (sansBouger > 30) break;
      }
      mc.releaseAll();
      const cam = mc.camera.position;
      return {
        ok: false,
        parcouru: Math.hypot(cam.x - x0, cam.z - z0),
        feet: mc.feetY(), x: cam.x, z: cam.z, auSol: !!mc.player.onGround,
      };
    };
    const marcheLibre = (label, axis, k, from, to, levelOf, budget, pret, garde) => {
      const depart = cellWorld(axis, k, from, 0);
      placer(depart.wx, levelOf(from) + 1, depart.wz);
      let attente = 0;
      while (attente++ < 3000 && !pret()) {
        mc.streamAll();
        mc.step(1 / 60);
      }
      if (!pret()) return { ok: false, reason: 'ouvrage absent du monde chargé', nonCharge: true, label };
      let cur = from;
      while (cur < to) {
        const next = Math.min(to, cur + 3);
        const c = cellWorld(axis, k, next, 0);
        const r = avancerLibre(c.wx + 0.5, c.wz + 0.5, budget);
        if (!r.ok) return { ok: false, colonne: next, ...r, label };
        if (garde) {
          const souci = garde(r, next);
          if (souci) return { ok: false, colonne: next, raison: souci, ...r, label };
        }
        cur = next;
      }
      return { ok: true, colonnes: to - from, label };
    };

    const ponts = [...found.values()].filter((s) => s.kind === 'bridge')
      .sort((a, b) => Math.hypot(centreOf(a).wx - cam0.x, centreOf(a).wz - cam0.z)
        - Math.hypot(centreOf(b).wx - cam0.x, centreOf(b).wz - cam0.z));
    const arcs = [...found.values()].filter((s) => s.kind === 'arch')
      .sort((a, b) => Math.hypot(centreOf(a).wx - cam0.x, centreOf(a).wz - cam0.z)
        - Math.hypot(centreOf(b).wx - cam0.x, centreOf(b).wz - cam0.z));

    // Un ouvrage assez éloigné de l'apparition n'est pas encore maillé quand la sonde
    // tourne : « absent du monde chargé » est un effet du streaming budgété, pas un
    // défaut produit. On saute et on essaie l'ouvrage suivant, avec un plafond d'essais
    // pour que la sonde reste bornée ; il faut au moins une traversée réelle par
    // catégorie pour que le contrôle veuille dire quelque chose.
    const ESSAIS = 6;
    const nonCharges = { ponts: 0, arcs: 0, dessous: 0 };

    const franchissements = [];
    const franchir = (b) => {
      // Approches : la rue y a posé son propre profil (escaliers de rue), pas le relief
      // brut. Exiger l'altitude naturelle ferait échouer une traversée pourtant réussie ;
      // ce qui compte est d'avancer pied au sol, et d'être bien sur le tablier entre les
      // piles — d'où le contrôle rendu par `garde`.
      const niveau = (i) => {
        if (b.ramp.has(i)) return b.ramp.get(i);
        if (i >= b.ds && i <= b.de) return b.deckY;
        const c = cellWorld(b.axis, b.k, i, 0);
        const rue = mc.roadSurface(c.wx, c.wz, true);
        return rue === null ? mc.getTerrainHeight(c.wx, c.wz) : rue;
      };
      const milieu = cellWorld(b.axis, b.k, Math.round((b.ds + b.de) / 2), 0);
      return marcheLibre('pont', b.axis, b.k, b.from - 1, b.to + 1, niveau, 420,
        () => solid(milieu.wx, b.deckY, milieu.wz),
        (p, col) => {
          if (col < b.ds || col > b.de) return null;
          if (Math.abs(p.feet - (b.deckY + 1)) > 0.35) {
            return `pieds à ${p.feet.toFixed(2)} hors du tablier (${b.deckY}) à la colonne ${col}`;
          }
          return null;
        });
    };
    for (const b of ponts) {
      if (franchissements.length >= MAX || franchissements.length + nonCharges.ponts >= ESSAIS) break;
      const r = franchir(b);
      if (r.nonCharge) { nonCharges.ponts++; continue; }
      franchissements.push({ ...r, span: b.span, tablier: b.deckY, axis: b.axis, k: b.k,
        surEau: !!b.surEau });
    }
    // Les viaducs sur l'eau sont triés avec les ponts de creux et souvent plus loin :
    // sans passe qui leur soit dédiée, un village bordé de ponts de vallon ferait passer
    // le contrôle général sans jamais poser un pied sur un tablier au-dessus de la mer.
    const ouvragesEau = ponts.filter((b) => b.surEau).length;
    let essaisEau = 0;
    for (const b of ponts) {
      if (!b.surEau || essaisEau >= 3) continue;
      if (franchissements.some((f) => f.surEau && f.ok)) break;
      essaisEau++;
      const r = franchir(b);
      if (r.nonCharge) continue;
      franchissements.push({ ...r, span: b.span, tablier: b.deckY, axis: b.axis, k: b.k,
        surEau: true });
    }

    const passages = [];
    for (const a of arcs) {
      if (passages.length >= MAX || passages.length + nonCharges.arcs >= ESSAIS) break;
      const niveau = (i) => (a.levels.has(i)
        ? a.levels.get(i)
        : (() => { const c = cellWorld(a.axis, a.k, i, 0); return mc.getTerrainHeight(c.wx, c.wz); })());
      const c = cellWorld(a.axis, a.k, a.centre, 0);
      const r = marche('arc', a.axis, a.k, a.lo - 1, a.hi + 1, niveau, 420,
        () => solid(c.wx, a.g + a.clear + 1, c.wz));
      if (r.nonCharge) { nonCharges.arcs++; continue; }
      passages.push({ ...r, arche: a.g, axis: a.axis, k: a.k });
    }

    // Le dénivelé du paysage ne sert à rien si le pont n'est qu'un remblai : on doit
    // pouvoir marcher sous le tablier, dans le creux qu'il enjambe. Le plancher n'y est
    // pas le relief — les piles descendent jusqu'à terre et le soffite reste horizontal à
    // `clearance` cubes du tablier — donc on le mesure cube par cube dans le monde chargé
    // et on cherche une travée où il est plat à un cube près, hors des piles.
    const dessous = [];
    let sansFenetre = 0;
    for (const b of ponts) {
      if (dessous.length >= MAX || dessous.length + sansFenetre + nonCharges.dessous >= ESSAIS) break;
      // Sous un franchissement d'eau on nage, on ne marche pas : le « fond praticable »
      // y est de l'eau salée et le chenal doit rester libre. C'est la suite océan qui
      // juge cette travée-là (colonne d'axe évidée jusqu'au plan d'eau).
      if (b.surEau) continue;
      const milieu = Math.round((b.ds + b.de) / 2);
      // Le plancher se lit dans le monde maillé : on s'y pose d'abord, sinon la sonde
      // tournerait sur des tronçons non chargés et les renverrait tous « vides ».
      const cM = cellWorld(b.axis, b.k, milieu, 0);
      placer(cM.wx + 0.5, b.deckY - b.clearance, cM.wz + 0.5);
      const solDe = (i) => {
        const c = cellWorld(b.axis, b.k, i, 0);
        for (let y = b.deckY - 1; y >= 0; y--) if (solid(c.wx, y, c.wz)) return y;
        return null;                      // rien de plein sous la main : tronçon non maillé
      };
      let attente = 0;
      while (attente++ < 3000 && solDe(milieu) === null) { mc.streamAll(); mc.step(1 / 60); }
      if (solDe(milieu) === null) { nonCharges.dessous++; continue; }
      let depart = null;
      // Une baie complète de travée fait quatre colonnes libres entre les tympan : c'est
      // la longueur que le générateur se fixe, donc celle qu'on exige du joueur.
      for (let i = b.ds + 1; i + 3 <= b.de - 1; i++) {
        let tenable = true;
        let precedent = null;
        for (let j = i; j <= i + 3 && tenable; j++) {
          const s = solDe(j);
          if (s === null || b.deckY - s < b.clearance + 1) tenable = false;   // pile ou naissance d'arc trop basse
          else if (precedent !== null && Math.abs(s - precedent) > 1) tenable = false;
          else precedent = s;
        }
        if (tenable) { depart = i; break; }
      }
      if (depart === null) { sansFenetre++; continue; }
      const c0 = cellWorld(b.axis, b.k, depart, 0);
      const r = marcheLibre('dessous', b.axis, b.k, depart, depart + 3, solDe, 420,
        () => solid(c0.wx, b.deckY, c0.wz) && !solid(c0.wx, solDe(depart) + 1, c0.wz),
        (p, col) => {
          if (p.feet >= b.deckY) return `pieds à ${p.feet.toFixed(2)}, au-dessus du tablier (${b.deckY})`;
          if (!solid(Math.floor(p.x), b.deckY, Math.floor(p.z))) return `tablier absent au-dessus de la colonne ${col}`;
          return null;
        });
      if (r.nonCharge) { nonCharges.dessous++; continue; }
      dessous.push({ ...r, tablier: b.deckY, portee: b.span, axis: b.axis, k: b.k });
    }

    // Une avenue droite qui suit le relief bute contre ses flancs : le joueur ne franchit
    // qu'un cube par colonne. La chaussée doit donc avoir posé son propre escalier — et on
    // va le vérifier là où le relief imposait un ressaut, sinon le contrôle ne dirait rien.
    // Le ressaut n'est cherché que là où le pavé existe : l'avenue s'arrête au rivage, et
    // juger la faillade naturelle d'une baie reviendrait à tenir la mer pour un défaut de
    // voirie. Les colonnes noyées sont reconnues à la règle même du générateur.
    const avenues = [];
    let sansRessaut = 0;
    const PAS = mc.villageParams.roadSpacing;
    const PORTÉE = 48;
    const MARÉE = mc.SEA_LEVEL;
    // Exactement la règle de `stampRoads` : ni le terrain ni le niveau posé par la rue
    // ne descendent au niveau de l'eau.
    const pave = (c) => mc.getTerrainHeight(c.wx, c.wz) >= MARÉE + 1
      && (mc.roadSurface(c.wx, c.wz, true) ?? -1) >= MARÉE + 1;
    for (const axe of ['x', 'z']) {
      const k0 = Math.round((axe === 'x' ? cam0.z : cam0.x) / PAS);
      for (let k = k0 - 2; k <= k0 + 2 && avenues.length < MAX; k++) {
        // Sondé à mi-bloc : seule sa propre ligne peut alors répondre voirie.
        const jauge = axe === 'x' ? [40, k * PAS] : [k * PAS, 40];
        if (mc.roadSurface(jauge[0], jauge[1], false) === null) continue;
        const i0 = Math.round(axe === 'x' ? cam0.x : cam0.z);
        let pire = null;
        for (let i = i0 - PORTÉE; i < i0 + PORTÉE; i++) {
          const c1 = cellWorld(axe, k, i, 0);
          const c2 = cellWorld(axe, k, i + 1, 0);
          if (!pave(c1) || !pave(c2)) continue;
          const d = Math.abs(mc.getTerrainHeight(c2.wx, c2.wz) - mc.getTerrainHeight(c1.wx, c1.wz));
          if (d >= 2 && (!pire || d > pire.d)) pire = { i, d };
        }
        if (!pire) { sansRessaut++; continue; }
        // Volée limitée au pavé : au-delà du dernier cube chaussé commence la plage.
        let depart = Math.max(i0 - PORTÉE, pire.i - 3);
        let arrive = Math.min(i0 + PORTÉE, pire.i + 4);
        while (depart < pire.i && !pave(cellWorld(axe, k, depart, 0))) depart++;
        while (arrive > pire.i + 1 && !pave(cellWorld(axe, k, arrive, 0))) arrive--;
        if (arrive - depart < 3) { sansRessaut++; continue; }
        const niveau = (i) => {
          const c = cellWorld(axe, k, i, 0);
          const n = mc.roadSurface(c.wx, c.wz, true);
          return n === null ? mc.getTerrainHeight(c.wx, c.wz) : n;
        };
        const c0 = cellWorld(axe, k, depart, 0);
        const r = marcheLibre('avenue', axe, k, depart, arrive, niveau, 420,
          () => solid(c0.wx, niveau(depart), c0.wz),
          (p, col) => (Math.abs(p.feet - (niveau(col) + 1)) < 0.4 ? null
            : `pieds à ${p.feet.toFixed(2)}, chaussée posée à ${niveau(col)}`));
        if (r.nonCharge) continue;
        avenues.push({ ...r, axe, k, ressaut: pire, de: depart, a: arrive });
      }
    }

    // Forêt : le feuillage est **solide** dans ce jeu. Un arbre dont la couronne descend
    // trop bas n'est pas laid, il est un mur — aussi le contrôle ne regarde pas les
    // plans, il marche dedans, couloir par couloir, entre les troncs.
    const BI = mc.biomeParams;
    const forets = [];
    let sansForet = 0;
    const candidatsForet = [];
    for (let dx = -200; dx <= 200 && candidatsForet.length < 14; dx += 8) {
      for (let dz = -200; dz <= 200 && candidatsForet.length < 14; dz += 8) {
        const x = Math.round(cam0.x) + dx;
        const z = Math.round(cam0.z) + dz;
        if (mc.biomeAt(x, z) !== 'foret') continue;
        if (mc.treeAt(x, z)) continue;                    // on n'écotonne pas depuis un tronc
        const h = mc.getTerrainHeight(x, z);
        if (h <= BI.sandLine || h >= BI.snowLine) continue;
        let souches = 0;
        for (let ax = x - 6; ax <= x + 6; ax++) {
          for (let az = z - 6; az <= z + 6; az++) if (mc.treeAt(ax, az)) souches++;
        }
        if (souches < 4) continue;
        candidatsForet.push({ x, z, h, souches });
      }
    }
    if (!candidatsForet.length) sansForet = 1;

    const compteTroncs = (x, z, dirX, dirZ, distance) => {
      let n = 0;
      for (let d = 0; d <= distance; d++) {
        for (let lat = -2; lat <= 2; lat++) {
          const wx = dirX ? x + d : x + lat;
          const wz = dirZ ? z + d : z + lat;
          if (mc.treeAt(wx, wz)) n++;
        }
      }
      return n;
    };

    // Le couloir doit rester **dans les bois** : une allée qui débouche sur le mur
    // d'une maison ne dit rien de la forêt, et le buter contre une paroi bâtie ferait
    // échouer un contrôle pourtant juste. On exige donc que la bande sondée reste en
    // zone forestière et hors emprise de voirie ou de bâti.
    const couloirBoise = (x, z, dirX, dirZ, distance) => {
      for (let d = 0; d <= distance; d++) {
        for (let lat = -1; lat <= 1; lat++) {
          const wx = dirX ? x + d : x + lat;
          const wz = dirZ ? z + d : z + lat;
          if (mc.biomeAt(wx, wz) !== 'foret') return false;
          if (mc.cellOccupied(wx, wz)) return false;
        }
      }
      return true;
    };

    // Un promeneur ne suit pas une corde raide : il contourne les troncs. Le contrôle
    // imite ce geste — on avance, et bute-t-on droit devant, on décale d'une colonne
    // avant de reprendre — et juge la **distance parcourue**, non la netteté d'une
    // ligne droite. Exiger la ligne droite reviendrait à demander une futaie sans
    // arbres ; ce qui doit rester vrai, c'est qu'on traverse et qu'on ressort.
    const sePromener = (dirX, dirZ, distance) => {
      const x0 = mc.camera.position.x;
      const z0 = mc.camera.position.z;
      const latX = dirX ? 0 : 1;
      const latZ = dirX ? 1 : 0;
      const avance = () => (mc.camera.position.x - x0) * dirX + (mc.camera.position.z - z0) * dirZ;
      const vers = (leLong, lateral) => avancerLibre(
        x0 + dirX * leLong + latX * lateral, z0 + dirZ * leLong + latZ * lateral, 200);
      let lateral = 0;
      let esquives = 0;
      let essais = 0;
      const obstacles = [];
      while (avance() < distance - 0.5 && essais++ < 30) {
        const cible = Math.min(distance, Math.floor(avance()) + 2);
        if (vers(cible, lateral).ok) continue;
        const r = { x: mc.camera.position.x, z: mc.camera.position.z, feet: mc.feetY() };
        // Ce qui arrête le joueur décide du verdict : un tronc se contourne, un mur de
        // feuillage bas est une faute du générateur — on garde la nature du cube.
        const bx = Math.floor(r.x + dirX * 0.9);
        const bz = Math.floor(r.z + dirZ * 0.9);
        const py = Math.round(r.feet);
        const bloquants = [0, 1, 2]
          .map((d) => mc.world.getBlock(bx, py + d, bz))
          .filter((b) => b !== mc.BLOCK.AIR);
        let tourne = false;
        for (const signe of [1, -1]) {
          if (vers(cible, lateral + signe).ok) { lateral += signe; esquives++; tourne = true; break; }
        }
        obstacles.push({ a: Math.round(avance()), blocs: bloquants.join('/'), tourne });
        if (!tourne) break;
      }
      return {
        avance: Math.round(avance() * 100) / 100,
        esquives,
        auSol: !!mc.player.onGround,
        pieds: Math.round(mc.feetY() * 100) / 100,
        sousFeuillage: mc.world.getBlock(
          Math.floor(mc.camera.position.x), Math.round(mc.feetY()), Math.floor(mc.camera.position.z),
        ) === mc.BLOCK.LEAVES,
        obstacles,
        ok: avance() >= distance - 0.5 && !!mc.player.onGround,
      };
    };

    const DISTANCE = 12;
    for (const c of candidatsForet) {
      if (forets.length >= 2) break;
      // Les quatre cardinaux, mais seuls comptent ceux qui restent sous bois : c'est
      // celui qui offre le plus de troncs à contourner sans jamais sortir des bois ni
      // taper dans une emprise bâtie qu'emprunterait un promeneur.
      let meilleur = null;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = compteTroncs(c.x, c.z, dx, dz, DISTANCE);
        if (n === 0) continue;                             // hors d'une futaie : rien à prouver
        if (!couloirBoise(c.x, c.z, dx, dz, DISTANCE)) continue;
        if (!meilleur || n < meilleur.troncs) meilleur = { dx, dz, troncs: n };
      }
      if (!meilleur) continue;
      placer(c.x + 0.5, c.h + 1, c.z + 0.5);
      let attente = 0;
      while (attente++ < 3000 && !solid(c.x, c.h, c.z)) { mc.streamAll(); mc.step(1 / 60); }
      if (!solid(c.x, c.h, c.z)) continue;                 // tronçon non maillé : on passe
      forets.push({ ...c, direction: `${meilleur.dx},${meilleur.dz}`, ...sePromener(meilleur.dx, meilleur.dz, DISTANCE), distance: DISTANCE });
    }

    // Temple : le monument est annoncé visitable — degré à un cube par colonne, porte
    // d'un cube sur trois, salle où l'on tient debout. Le contrôle n'y croit que sur
    // preuve : on pose le joueur au pied du degré et on l'amène jusqu'au naos.
    const TP = mc.villageParams;
    const TDIRS = [{ dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 }];
    const temples = [];
    // Le monument est rare par construction (quelques centaines de cubes d'écart moyen
    // mesurés) : la recherche prend une lieue autour du joueur, quitte à marcher jusqu'à
    // lui.
    const tous = mc.templesSur(Math.round(cam0.x) - 1000, Math.round(cam0.z) - 1000,
      Math.round(cam0.x) + 1000, Math.round(cam0.z) + 1000);
    tous.sort((a, b) => (Math.abs(a.ex - cam0.x) + Math.abs(a.ez - cam0.z))
      - (Math.abs(b.ex - cam0.x) + Math.abs(b.ez - cam0.z)));
    for (const t of tous.slice(0, 3)) {
      const dir = TDIRS[t.door];
      const C = TP.templeCellaHalf;
      // Le parvis doit être réellement maillé avant d'essayer quoi que ce soit.
      placer(t.ex + 0.5, t.socle + 1, t.ez + 0.5);
      let attente = 0;
      while (attente++ < 4000 && !solid(t.ex, t.socle, t.ez)) { mc.streamAll(); mc.step(1 / 60); }
      if (!solid(t.ex, t.socle, t.ez)) continue;
      // Garde-tête de la salle, mesuré dans le monde chargé.
      let vide = 0;
      for (let y = t.socle + 1; y <= t.socle + 6; y++) {
        if (mc.world.getBlock(t.ex + dir.dx * (C - 2), y, t.ez + dir.dz * (C - 2)) === mc.BLOCK.AIR) vide++;
        else break;
      }
      // Départ : deux colonnes au-delà du degré, sur le terrain naturel.
      const departX = t.ex + dir.dx * (t.half + TP.templeSteps + 2);
      const departZ = t.ez + dir.dz * (t.half + TP.templeSteps + 2);
      placer(departX + 0.5, mc.getTerrainHeight(departX, departZ) + 1, departZ + 0.5);
      let attente2 = 0;
      while (attente2++ < 3000 && !solid(departX, mc.getTerrainHeight(departX, departZ), departZ)) {
        mc.streamAll();
        mc.step(1 / 60);
      }
      // Deux temps : monter sur le parvis, puis traverser la porte jusqu'à la salle.
      // Le monument a quatre fois la largeur d'une maison : le budget de pas suit.
      const surParvis = avancerLibre(t.ex + dir.dx * (t.half - 2) + 0.5, t.ez + dir.dz * (t.half - 2) + 0.5, 900);
      const dansNaos = surParvis.ok
        ? avancerLibre(t.ex + dir.dx * (C - 2) + 0.5, t.ez + dir.dz * (C - 2) + 0.5, 900)
        : { ok: false, feet: surParvis.feet, x: surParvis.x, z: surParvis.z };
      temples.push({
        ex: t.ex, ez: t.ez, socle: t.socle, vide,
        parvis: surParvis.ok, naos: dansNaos.ok,
        pieds: Math.round(dansNaos.feet * 100) / 100,
        attendu: t.socle + 1,
        detail: dansNaos.ok ? '' : `resté à ${dansNaos.x?.toFixed(2)},${dansNaos.z?.toFixed(2)} pieds ${dansNaos.feet?.toFixed(2)}`,
        ok: surParvis.ok && dansNaos.ok && Math.abs(dansNaos.feet - (t.socle + 1)) < 0.4 && vide >= 4,
      });
      if (temples.length >= 2) break;
    }

    // Et les arbres sont-ils seulement là, dans le monde maillé ? Tronc de bois cubique
    // sous la couronne, feuillage au-dessus du garde-tête.
    let arbresVus = 0;
    let arbresMalGarnis = 0;
    const exemplesArbre = [];
    for (const c of candidatsForet.slice(0, 3)) {
      // Le visiteur du temple a été posé à l'autre bout de la carte et le promeneur a
      // quitté les bois : sans retour sur la souche, le tronçon n'est plus maillé et le
      // comptage ne verrait plus un seul tronc.
      placer(c.x + 0.5, c.h + 1, c.z + 0.5);
      let attenteBois = 0;
      while (attenteBois++ < 3000 && !solid(c.x, c.h, c.z)) { mc.streamAll(); mc.step(1 / 60); }
      for (let ax = c.x - 8; ax <= c.x + 8 && arbresVus < 12; ax++) {
        for (let az = c.z - 8; az <= c.z + 8 && arbresVus < 12; az++) {
          const a = mc.treeAt(ax, az);
          if (!a) continue;
          if (!solid(ax, a.sol, az)) continue;             // tronçon non maillé
          arbresVus++;
          let bois = 0;
          for (let y = a.sol + 1; y <= a.couronne; y++) {
            if (mc.world.getBlock(ax, y, az) === mc.BLOCK.WOOD) bois++;
          }
          let feuilles = 0;
          for (let dx = -a.rayon; dx <= a.rayon; dx++) {
            for (let dz = -a.rayon; dz <= a.rayon; dz++) {
              for (let y = a.couronne; y < a.couronne + 3; y++) {
                if (mc.world.getBlock(ax + dx, y, az + dz) === mc.BLOCK.LEAVES) feuilles++;
              }
            }
          }
          if (bois < a.couronne - a.sol || feuilles < 5) {
            arbresMalGarnis++;
            if (exemplesArbre.length < 3) {
              exemplesArbre.push(`(${ax},${az}) bois=${bois}/${a.couronne - a.sol} feuilles=${feuilles}`);
            }
          }
        }
      }
    }

    return {
      ponts: ponts.length,
      ouvragesEau,
      arcs: arcs.length,
      franchissements,
      passages,
      dessous,
      sansFenetre,
      avenues,
      sansRessaut,
      forets,
      sansForet,
      temples,
      arbresVus,
      arbresMalGarnis,
      exemplesArbre,
      nonCharges,
      cam: [Math.round(cam0.x), Math.round(cam0.z)],
    };
  }, 2);

  check('des ouvrages d’art existent autour du point d’apparition',
    probe.ponts > 0 || probe.arcs > 0,
    `${probe.ponts} pont(s), ${probe.arcs} arc(s) autour de ${probe.cam}`);
  // La catégorie ne doit pas disparaître silencieusement quand tous ses ouvrages ont
  // été sautés : sans une traversée réelle le contrôle n'affirme plus rien.
  if (probe.ponts > 0) {
    const f = probe.franchissements;
    check('le joueur traverse le pont en marchant', f.length > 0 && f.every((b) => b.ok),
      f.length === 0
        ? `aucun des ${probe.ponts} pont(s) alentours testable (${probe.nonCharges.ponts} non chargé(s))`
        : f.filter((b) => !b.ok).map((b) => `pont axe ${b.axis}${b.k} portée=${b.span} `
          + (b.reason || b.raison || `bloqué à la colonne ${b.colonne} resté à ${b.x.toFixed(2)},${b.z.toFixed(2)} `
            + `pieds=${b.feet.toFixed(2)} attendu=${b.attendu}`)).join(' | ')
          || `${f.length} pont(s) franchi(s)`);
  }
  if (probe.ouvragesEau > 0) {
    const f = probe.franchissements.filter((b) => b.surEau);
    check('on traverse un viaduc au-dessus de l’eau en marchant',
      f.length > 0 && f.every((b) => b.ok),
      f.length === 0
        ? `aucun des ${probe.ouvragesEau} viaduc(s) sur l’eau alentours n’a pu être éprouvé`
        : f.filter((b) => !b.ok).map((b) => `viaduc axe ${b.axis}${b.k} portée=${b.span} tablier=${b.tablier} `
          + (b.reason || b.raison || `bloqué à la colonne ${b.colonne} resté à ${b.x.toFixed(2)},${b.z.toFixed(2)} `
            + `pieds=${b.feet.toFixed(2)} attendu=${b.attendu}`)).join(' | ')
          || `${f.length} viaduc(s) franchi(s) à pied, chaussée au sec au-dessus de l’eau`);
  }
  if (probe.arcs > 0) {
    const a = probe.passages;
    check('le joueur passe sous l’arc de triomphe en marchant', a.length > 0 && a.every((b) => b.ok),
      a.length === 0
        ? `aucun des ${probe.arcs} arc(s) alentours testable (${probe.nonCharges.arcs} non chargé(s))`
        : a.filter((b) => !b.ok).map((b) => `arc axe ${b.axis}${b.k} `
          + (b.reason || b.raison || `bloqué à la colonne ${b.colonne} resté à ${b.x.toFixed(2)},${b.z.toFixed(2)} `
            + `pieds=${b.feet.toFixed(2)} attendu=${b.attendu}`)).join(' | ')
          || `${a.length} arc(s) traversé(s)`);
  }
  if (probe.ponts > 0) {
    const d = probe.dessous;
    check('le joueur passe sous le pont en marchant', d.length > 0 && d.every((b) => b.ok),
      d.length === 0
        ? `aucun tablier ne laisse de fond praticable sur ${probe.ponts} pont(s) `
          + `(${probe.sansFenetre} sans fenêtre, ${probe.nonCharges.dessous} non chargé(s))`
        : d.filter((b) => !b.ok).map((b) => `pont axe ${b.axis}${b.k} portée=${b.portee} tablier=${b.tablier} `
          + (b.reason || b.raison || `bloqué à la colonne ${b.colonne} resté à ${b.x.toFixed(2)},${b.z.toFixed(2)} `
            + `pieds=${b.feet.toFixed(2)} après ${b.parcouru?.toFixed(2)} cube(s)${b.auSol === false ? ', en l’air' : ''}`)).join(' | ')
          || `${d.length} pont(s) franchi(s) au-dessous du tablier`);
  }
  {
    const a = probe.avenues;
    check('le joueur suit une avenue en escalier sans être arrêté',
      a.length > 0 && a.every((b) => b.ok),
      a.length === 0
        ? `aucune avenue ne présente de ressaut naturel d’au moins deux cubes autour de ${probe.cam} `
          + `(${probe.sansRessaut} avenue(s) sondées, toutes à pente douce)`
        : a.filter((b) => !b.ok).map((b) => `avenue ${b.axe}${b.k}, ressaut de ${b.ressaut.d} cubes à la colonne `
          + `${b.ressaut.i} : `
          + (b.reason || b.raison
            || `bloqué à la colonne ${b.colonne} resté à ${b.x.toFixed(2)},${b.z.toFixed(2)} `
              + `pieds=${b.feet?.toFixed(2)} après ${b.parcouru?.toFixed(2)} cube(s)${b.auSol === false ? ', en l’air' : ''}`)).join(' | ')
          || `${a.length} avenue(s) parcourue(s) à pied, marches comprises`);
  }
  {
    const f = probe.forets;
    check('le joueur se promène sous les arbres sans être arrêté',
      f.length > 0 && f.every((b) => b.ok),
      f.length === 0
        ? (probe.sansForet
          ? `aucune futaie (au moins quatre souches en 13×13) autour de ${probe.cam}`
          : `aucun couloir forestier à franchir autour de ${probe.cam}`)
        : f.filter((b) => !b.ok).map((b) => `forêt (${b.x},${b.z}) direction ${b.direction} : `
          + `${b.avance.toFixed(2)} cube(s) parcourus sur ${b.distance} en ${b.esquives} pas de côté, `
          + `resté à ${b.pieds.toFixed(0)} pieds${b.auSol ? '' : ', en l’air'}`
          + (b.sousFeuillage ? ', dans le feuillage' : '')
          + (b.obstacles.length ? ' — buté à ' + b.obstacles.map((o) => `${o.a}${o.tourne ? '' : '(bouché)'}:${o.blocs || 'sol'}`).join(', ') : '')).join(' | ')
          || `${f.length} couloir(s) forestier(s) parcourus entre les troncs`
            + ` (${f.map((b) => `${b.avance}/${b.distance} cubes, ${b.esquives} esquive(s)`).join(' ; ')})`);
  }
  check('les arbres du monde ont tronc de bois et couronne de feuilles',
    probe.arbresVus >= 6 && probe.arbresMalGarnis === 0,
    `${probe.arbresVus - probe.arbresMalGarnis}/${probe.arbresVus} arbre(s) complet(s)`
    + (probe.exemplesArbre.length ? ' — ' + probe.exemplesArbre.join(', ') : ''));
  {
    const t = probe.temples;
    check('on entre dans un temple en marchant',
      t.length > 0 && t.every((b) => b.ok),
      t.length === 0
        ? `aucun temple maillé à portée de ${probe.cam}`
        : t.filter((b) => !b.ok).map((b) => `temple (${b.ex},${b.ez}) socle ${b.socle} : `
          + `parvis=${b.parvis} naos=${b.naos} pieds=${b.pieds} attendu ${b.attendu} `
          + `garde-tête=${b.vide}${b.detail ? ' ' + b.detail : ''}`).join(' | ')
          || `${t.length} temple(s) traversés du degré au naos `
            + `(${t.map((b) => `${b.vide} cubes de garde-tête`).join(', ')})`);
  }
  await vp.close();
}

// ============================================================ 9. starting the game
// Regression guard: PointerLockControls was once bound to document.body while the
// lock is requested on the canvas. three.js then compared pointerLockElement to
// body, failed, and dispatched "unlock" on every successful lock — the start screen
// snapped straight back ("rien ne se passe") and mouse look never engaged.
{
  const run = await openGame(URL);
  const p = run.page;
  const shown = () => p.evaluate(() => ({
    blocker: getComputedStyle(document.getElementById('blocker')).display !== 'none',
    lockedByBrowser: document.pointerLockElement != null,
    lockedByControls: window.__mc.controls.isLocked,
    yaw: window.__mc.camera.rotation.y,
    pitch: window.__mc.camera.rotation.x,
  }));

  await p.click('#start-btn');
  await p.waitForTimeout(400);
  const started = await shown();
  check('le bouton « Cliquer pour jouer » lance la partie',
    !started.blocker && started.lockedByBrowser && started.lockedByControls,
    `voile=${started.blocker} pointeur=${started.lockedByBrowser} isLocked=${started.lockedByControls}`);

  await p.mouse.move(512, 320);
  await p.mouse.move(700, 260, { steps: 6 });
  await p.waitForTimeout(120);
  const looked = await shown();
  check('la souris capturée fait tourner la caméra',
    Math.abs(looked.yaw - started.yaw) > 1e-3 && Math.abs(looked.pitch - started.pitch) > 1e-3,
    `Δyaw=${(looked.yaw - started.yaw).toFixed(3)} Δpitch=${(looked.pitch - started.pitch).toFixed(3)}`);

  // what the browser does on Escape: drop the lock, the pause screen must return
  await p.evaluate(() => document.exitPointerLock());
  await p.waitForTimeout(300);
  const paused = await shown();
  check('quand le pointer lock tombe, l’écran d’accueil revient',
    paused.blocker && !paused.lockedByControls,
    `voile=${paused.blocker} isLocked=${paused.lockedByControls}`);

  await p.click('#start-btn');
  await p.waitForTimeout(400);
  const resumed = await shown();
  check('un second clic reprend la partie', !resumed.blocker && resumed.lockedByControls,
    `voile=${resumed.blocker} isLocked=${resumed.lockedByControls}`);

  const startErrors = run.consoleErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  check('aucune erreur console pendant le démarrage', startErrors.length === 0,
    startErrors.slice(0, 2).join(' | '));
  await run.browser.close();
}

const ignorable = (s) => /favicon|Failed to load resource/i.test(s);
const realErrors = consoleErrors.filter((e) => !ignorable(e));
const realBad = badResponses.filter((u) => !ignorable(u));
check('aucune erreur console sur toute la session',
  realErrors.length === 0 && realBad.length === 0,
  [...new Set([...realErrors.slice(0, 3), ...realBad.slice(0, 3)])].join(' | '));
if (badResponses.length) console.log(`\x1b[2m  réponses HTTP en erreur: ${[...new Set(badResponses)].join(', ')}\x1b[0m`);

await browser.close();

const failed = summary();
console.log(`captures: ${SHOTS}`);
process.exit(failed ? 1 : 0);
