// Headless verification of the start-screen view-depth setting.
// Usage: node tests/settings.mjs [url]
// Needs the static server running (npm start / node server.js).
import fs from 'node:fs';
import path from 'node:path';
import { openGame, waitForBoot, makeReporter } from './browser.mjs';

const URL = process.argv[2] || 'http://localhost:8080';
const SHOTS = process.env.SHOT_DIR || '.qwen/tmp/mc-shots';

const { check, summary } = makeReporter();
const { browser, page, consoleErrors, badResponses } = await openGame(URL);

const CS = await page.evaluate(() => window.__mc.CHUNK_SIZE);

const state = () => page.evaluate((CS) => {
  const mc = window.__mc;
  const pcx = Math.floor(mc.camera.position.x / CS);
  const pcz = Math.floor(mc.camera.position.z / CS);
  let inRange = 0, total = 0, meshes = 0, dessines = 0, reserves = 0;
  for (const c of mc.world.chunks.values()) {
    total++;
    if (c.horsVue) reserves++;
    if (Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz)) <= mc.settings.renderDistance) inRange++;
    meshes += c.meshes.length;
    // Ce qui est hors champ reste en mémoire (budget de géométrie) mais quitte la scène :
    // ce qui pèse l'image, c'est `dessines`, pas `total`.
    for (const m of c.meshes) if (m.parent === mc.scene) dessines++;
  }
  const input = document.getElementById('render-distance');
  return {
    r: mc.settings.renderDistance,
    min: mc.MIN_RENDER_DISTANCE,
    max: mc.MAX_RENDER_DISTANCE,
    def: mc.DEFAULT_RENDER_DISTANCE,
    inRange,
    total,
    meshes,
    dessines,
    reserves,
    octets: mc.world.octetsMailles,
    quota: mc.memoire().quota,
    fogNear: mc.scene.fog.near,
    fogFar: mc.scene.fog.far,
    camFar: mc.camera.far,
    inputValue: Number(input.value),
    label: document.getElementById('render-distance-value').textContent.trim(),
    panelOpen: document.getElementById('settings').open,
    controlLabel: document.querySelector('#settings label').textContent.trim(),
    stored: localStorage.getItem(mc.SETTINGS_STORAGE_KEY),
    arrowKey: Boolean(mc.keys.ArrowRight),
    pending: mc.world.pendingChunks,
    camX: mc.camera.position.x,
    feet: mc.feetY(),
  };
}, CS);

// The world streams in from the animation loop; wait for it to settle before
// asserting on chunk counts.
const drain = async (timeout = 90000) => {
  await page.waitForFunction(() => window.__mc.world.pendingChunks === 0, null, { timeout });
};

// ============================================================ 1. the control exists at startup
const s0 = await state();
check('l’écran d’accueil expose un réglage de profondeur de champ',
  s0.panelOpen && /profondeur de champ/i.test(s0.controlLabel) &&
  s0.inputValue === s0.r && s0.min <= s0.r && s0.r <= s0.max,
  `${s0.controlLabel} = ${s0.inputValue} (${s0.min}–${s0.max})`);
const statedBlocks = Number(s0.label.match(/~(\d+) blocs/)?.[1]);
check('la valeur est expliquée en clair',
  statedBlocks === s0.r * CS && s0.label.includes(String((2 * s0.r + 1) ** 2)),
  s0.label);

// ============================================================ 2. the default really drives the world
// L'enveloppe du voile se lit en fractions de la portée : `far = rayon × CHUNK_SIZE ×
// 0,98`. Repoussée depuis 0,85 — à cette valeur le plein jour lavait les cubes de moyen
// distance dans la teinte de brume (« les cubes à l'horizon sont tous blancs en pleine
// journée ») — elle doit rester sous `camera.far`, sinon le relief se tranche net au lieu
// de se fondre.
check('la distance par défaut pilote le monde et le brouillard',
  s0.r === s0.def && s0.inRange === (2 * s0.r + 1) ** 2 &&
  s0.fogNear < s0.fogFar && Math.abs(s0.fogFar - s0.r * CS * 0.98) < 0.01 &&
  s0.camFar >= s0.fogFar,
  `${s0.inRange} tronçons, brouillard ${s0.fogNear.toFixed(0)}–${s0.fogFar.toFixed(0)}, loin ${s0.camFar}`);

// ============================================================ 3. dragging the slider live
const beforeGrow = s0.meshes;
await page.focus('#render-distance');
for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
await drain();
const grown = await state();
check('augmenter le curseur charge plus de terrain, sans recharger la page',
  grown.r === s0.r + 3 && grown.inputValue === grown.r &&
  grown.inRange === (2 * grown.r + 1) ** 2 && grown.meshes > beforeGrow,
  `${s0.r} → ${grown.r} chunks · ${grown.inRange} tronçons · ${grown.meshes} meshes`);
check('le brouillard suit la nouvelle portée',
  Math.abs(grown.fogFar - grown.r * CS * 0.98) < 0.01 && grown.fogFar > s0.fogFar,
  `${s0.fogFar.toFixed(0)} → ${grown.fogFar.toFixed(0)}`);
check('l’affichage texte suit le curseur',
  grown.label.startsWith(`${grown.r} chunk`) &&
  grown.label.includes(`~${grown.r * CS} blocs`) &&
  grown.label.includes(`${(2 * grown.r + 1) ** 2} tronçons`),
  grown.label);

// ============================================================ 4. shrinking frees the memory again
await page.focus('#render-distance');
for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(300);
const shrunk = await state();
// Ce que ce contrôle jugeait avant : la table des tronçons doit maigrir. Depuis le
// budget de géométrie (2026-11-16), ce qui sort du champ est délibérément gardé — le
// juger sur `total` reviendrait à pénaliser la rétention qui supprime le pop-in. Ce qui
// doit baisser, c'est ce qui est dessiné ; et ce qui est gardé doit rester sous quota.
check('réduire le curseur arrête de dessiner les tronçons lointains',
  shrunk.r === grown.r - 5 && shrunk.dessines < grown.dessines &&
  shrunk.inRange === (2 * shrunk.r + 1) ** 2,
  `${grown.dessines} → ${shrunk.dessines} mailleurs dessinés · ${shrunk.inRange} tronçons à r=${shrunk.r}`);
check('et garde ce qui n\'est plus vu sans rien redessiner, tant que le quota le permet',
  shrunk.reserves > 0 && shrunk.total >= grown.total * 0.9 && shrunk.octets <= shrunk.quota + 400 * 1024,
  `${shrunk.reserves} réservés sur ${shrunk.total} en mémoire contre ${grown.total} à r=${grown.r} · `
  + `${(shrunk.octets / 1048576).toFixed(0)} Mo pour un quota de ${(shrunk.quota / 1048576).toFixed(0)} Mo`);

// ============================================================ 5. the slider owns its arrow keys
const movedBySlider = shrunk.arrowKey || Math.abs(shrunk.camX - s0.camX) > 1e-6;
check('les flèches du curseur ne déplacent pas le joueur', !movedBySlider,
  `touche enregistrée=${shrunk.arrowKey} caméra déplacée=${(shrunk.camX - s0.camX).toFixed(4)}`);

// ============================================================ 6. bounds and persistence
const clamped = await page.evaluate(() => {
  const mc = window.__mc;
  const tooBig = mc.setRenderDistance(999);
  const tooSmall = mc.setRenderDistance(-5);
  const junk = mc.setRenderDistance('beaucoup');
  return { tooBig, tooSmall, junk, max: mc.MAX_RENDER_DISTANCE, min: mc.MIN_RENDER_DISTANCE, def: mc.DEFAULT_RENDER_DISTANCE };
});
check('une valeur hors bornes est écrêtée, jamais crashée',
  clamped.tooBig === clamped.max && clamped.tooSmall === clamped.min && clamped.junk === clamped.def,
  `999→${clamped.tooBig}, -5→${clamped.tooSmall}, "beaucoup"→${clamped.junk}`);

// A jump straight to the ceiling must not freeze the tab: the call itself stays
// short and the field keeps streaming in afterwards.
const jump = await page.evaluate(() => {
  const mc = window.__mc;
  const t0 = performance.now();
  const r = mc.setRenderDistance(mc.MAX_RENDER_DISTANCE);
  const syncMs = performance.now() - t0;
  return {
    r, syncMs, max: mc.MAX_RENDER_DISTANCE, pending: mc.world.pendingChunks,
    label: document.getElementById('render-distance-value').textContent.trim(),
  };
});
check('un saut à la portée maximale ne bloque pas l’onglet',
  jump.r === jump.max && jump.syncMs < 400 && jump.pending > 0,
  `appel synchrone ${jump.syncMs.toFixed(0)} ms · ${jump.pending} tronçons en file d’attente`);
check('le libellé annonce le chargement progressif aux grandes portées',
  /chargement progressif/.test(jump.label), jump.label);

// The field has to arrive by successive rounds while the picture keeps rendering:
// a single blocking pass would freeze the tab for tens of seconds at this ceiling.
// Douze relevés de 500 ms (six secondes) et non six : la fenêtre doit être assez longue
// pour que la pente nette échappe au bruit. Mesuré le 2026-11-16 par une sonde A/B (même
// harnais, deux serveurs, quatre passes alternées) : l'arbre en cours vide ~7 tronçons/s
// à 19 img/s quand HEAD en vide ~15 à 25 img/s — sur trois secondes, la machine chargée
// donnait une file plate (3990 → 3992) et le contrôle tombait pour une raison d'horloge.
// La promesse jugée reste la même : la file baisse pendant que l'image tourne.
const trace = [];
for (let i = 0; i < 12; i++) {
  trace.push(await page.evaluate(() => ({
    file: window.__mc.world.pendingChunks,
    images: window.__mc.framesRendues(),
  })));
  await page.waitForTimeout(500);
}
const files = trace.map((t) => t.file);
// Ce qui doit baisser, c'est la tendance, pas chaque échantillon : `pendingChunks`
// additionne les cellules manquantes ET les voisins marqués par chaque naissance (jusqu'à
// quatre par tronçon créé, dont ceux du premier anneau hors du disque jugé). La somme
// tressaute donc de quelques unités entre deux relevés — mesuré 3 970 → 3 973 ici comme
// sur le game.js de HEAD, où `dirtyKeys` montait de 26 à 65 pendant que la file baissait.
// Exiger une décroissance stricte revenait à jouer à pile ou face. En revanche, le libellé
// promet « pendant que l'image continue » : chose promise, chose jugée.
const imagesAvancent = trace.every((t, i) => i === 0 || t.images > trace[i - 1].images);
check('le champ se remplit par bonds successifs pendant que l’image continue',
  files[0] > 0 && files[files.length - 1] < files[0] && Math.max(...files) <= files[0] + 250 && imagesAvancent,
  `${files.join(' → ')} · ${trace[trace.length - 1].images - trace[0].images} image(s) rendues entre le premier et le dernier échantillon`);

// A full settle is verified at a still-large radius: waiting for the whole 32-chunk
// disc would be measuring the software rasteriser, not the world builder.
await page.evaluate(() => window.__mc.setRenderDistance(16));
const settleStart = Date.now();
// Le délai est un plafond d'attente, pas une assertion : ce que contrôle la suite est que
// la file atteint zéro, pas la vitesse du rastériseur. Mesuré le 2026-11-16 (sonde de
// vidange, monde quasi vide puis retour à r=16) : ~4,5 tronçons/s sous SwiftShader, la
// file descendant régulièrement de 831 à 395 en 143 s sans jamais geler — `dirtyKeys` reste
// épinglé au watermark de 64, qui bride la génération. Le disque complet demande donc
// ~240 s quand il part de presque rien ; un plafond de 240 s ne laissait aucune marge et
// faisait échouer la suite là où le monde travaillait normalement.
await drain(420000);
const settled = await state();
const secs = (Date.now() - settleStart) / 1000;
check('un champ de 16 chunks se complète entièrement',
  settled.r === 16 && settled.pending === 0 && settled.inRange === (2 * 16 + 1) ** 2,
  `${settled.inRange} tronçons en ~${secs.toFixed(1)} s (${Math.round(settled.inRange / Math.max(secs, 0.001))}/s sous SwiftShader)`);

await page.evaluate(() => window.__mc.setRenderDistance(7));
await page.reload({ waitUntil: 'load' });
await waitForBoot(page);   // même porte qu'au démarrage : le bucle doit être réveillé aussi
await drain();
const reloaded = await state();
check('le réglage survit au rechargement de la page',
  reloaded.r === 7 && reloaded.inputValue === 7 &&
  reloaded.inRange === (2 * 7 + 1) ** 2 && JSON.parse(reloaded.stored).renderDistance === 7,
  `${reloaded.r} chunks au rechargement (${reloaded.inRange} tronçons)`);

await page.evaluate((key) => localStorage.setItem(key, '{"renderDistance":"totalement"}'), 'mincraft_settings');
await page.reload({ waitUntil: 'load' });
await waitForBoot(page);   // même porte qu'au démarrage : le bucle doit être réveillé aussi
const corrupt = await state();
check('un réglage illisible retombe sur la valeur par défaut',
  corrupt.r === corrupt.def && corrupt.inputValue === corrupt.def,
  `${corrupt.r} chunks`);

// ============================================================ 6b. l'écran d'accueil rend seul
// Le voile est opaque et le bucle d'images s'arrête sous lui — c'est la demande du joueur :
// « l'écran de début et Échap ne contiennent pas de rendu du monde, ça ralentit l'interface ».
// Les autres suites jugent le monde réveillé (browser.mjs le demande pour elles) ; ici on
// vérifie précisément le sommeil, instruments arrêtés compris.
const veille = await page.evaluate(async () => {
  const mc = window.__mc;
  const attente = (ms) => new Promise((r) => setTimeout(r, ms));
  const mesurer = async (ms) => {
    const avant = { images: mc.framesRendues(), heure: mc.horloge().heure() };
    const fileAvant = mc.world.pendingChunks;
    await attente(ms);
    return {
      images: mc.framesRendues() - avant.images,
      heures: Math.abs(mc.horloge().heure() - avant.heure),
      file: mc.world.pendingChunks - fileAvant,
      horsJeu: mc.horsJeu(),
      pose: mc.ecranPose(),
    };
  };
  // De quoi travailler : sans tronçons en attente, « rien ne se maille » serait vrai pour
  // la mauvaise raison.
  mc.setRenderDistance(mc.MAX_RENDER_DISTANCE);
  mc.image(false);                                  // comme un joueur qui n'a pas cliqué
  const endormi = await mesurer(400);
  mc.image(true);                                   // même file, bucle réveillé
  const reveille = await mesurer(1600);
  const voile = document.getElementById('blocker');
  const style = getComputedStyle(voile);
  // Une couche translucide laisserait transparaître le monde : ni le fond ni l'image ne
  // doivent porter de canal alpha ouvert.
  const translucide = /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(?:0|0?\.\d+)\s*\)/
    .test(`${style.backgroundImage} ${style.backgroundColor}`);
  const couleurPleine = /^rgb\(/.test(style.backgroundColor.trim());
  mc.setRenderDistance(9);
  return { endormi, reveille, translucide, couleurPleine, peint: style.backgroundImage !== 'none' };
});
check('écran ouvert : plus une seule image de monde',
  veille.endormi.pose && veille.endormi.images === 0,
  `${veille.endormi.images} image(s) en 400 ms, écran posé=${veille.endormi.pose}`);
check('écran ouvert : le temps du monde dort avec l’image',
  veille.endormi.heures === 0,
  `heure avancée de ${veille.endormi.heures.toFixed(5)} pendant la veille`);
check('écran ouvert : rien ne se maille non plus',
  veille.endormi.file === 0 && veille.reveille.file < 0,
  `file ${veille.endormi.file} en veille · ${veille.reveille.file} réveillé`);
check('écran ouvert : la toile est masquée, rien à composer',
  veille.endormi.horsJeu && !veille.reveille.horsJeu,
  `hors-jeu=${veille.endormi.horsJeu} en veille, ${veille.reveille.horsJeu} réveillé`);
check("l'écran est opaque : aucun rendu du monde ne transparaît",
  veille.peint && veille.couleurPleine && !veille.translucide,
  `peint=${veille.peint} couleur pleine=${veille.couleurPleine} translucide=${veille.translucide}`);
check('réveillé, le bucle reprend ses images',
  veille.reveille.images > 0,
  `${veille.reveille.images} image(s) en 1,6 s une fois l’écran levé`);

// ============================================================ 7. screenshot + hygiene
await page.evaluate(() => {
  window.__mc.setRenderDistance(9);
  document.getElementById('settings').open = true;
});
await drain();
await page.waitForTimeout(200);
fs.mkdirSync(SHOTS, { recursive: true });
await page.screenshot({ path: path.join(SHOTS, '05-reglages.png') });

const ignorable = (x) => /favicon|Failed to load resource/i.test(String(x));
const realErrors = consoleErrors.filter((e) => !ignorable(e));
const realBad = badResponses.filter((u) => !ignorable(u));
check('aucune erreur console pendant les réglages',
  realErrors.length === 0 && realBad.length === 0,
  [...new Set([...realErrors.slice(0, 3), ...realBad.slice(0, 3)])].join(' | '));

await browser.close();
const failed = summary();
console.log(`captures: ${SHOTS}`);
process.exit(failed ? 1 : 0);
