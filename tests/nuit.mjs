// Vérification sans écran du cycle jour/nuit : le modèle du ciel tel que la page le
// consomme, le soleil rond qu'on voit se lever et se coucher, l'obscurité des grottes,
// les lanternes de ville et leur halo, le réglage de la durée du jour.
// Usage: node tests/nuit.mjs [url]
// Nécessite le serveur statique (npm start / node server.js).
import { openGame, makeReporter } from './browser.mjs';

const URL = process.argv[2] || 'http://localhost:8080';
const SHOTS = process.env.SHOT_DIR || '.qwen/tmp/mc-shots';

const { check, summary } = makeReporter();
const { browser, page, consoleErrors } = await openGame(URL);

const LAMP_POST = 21, LAMP_GLOW = 22, STONE = 3, AIR = 0, LAMP_WALL_O = 23;
const ignorable = (x) => /favicon|Failed to load resource/i.test(String(x));

// ================================================== 1. le modèle du ciel dans la page
const hooks = await page.evaluate(() => {
  const mc = window.__mc;
  return ['ciel', 'reglerHeure', 'horloge', 'dureeJour', 'reglerDureeJour',
    'lampadairesSur', 'lampesDuTroncon', 'bloc']
    .filter((k) => typeof mc[k] === 'function');
});
check('la page expose le ciel et les lanternes au test', hooks.length === 8, hooks.join(','));

const midi = await page.evaluate(() => window.__mc.reglerHeure(0.5));
check('à midi le ciel est plein jour et les lanternes éteintes',
  midi.phase === 'jour' && midi.jour > 0.95 && midi.lampes === 0 && midi.soleil[1] > 0.99,
  JSON.stringify({ phase: midi.phase, jour: midi.jour, lampes: midi.lampes, y: midi.soleil[1] }));
check('à midi les lumières sont celles du monde d’avant le cycle',
  midi.ambiante.couleur === 0xffffff && Math.abs(midi.ambiante.intensite - 0.72) < 1e-6
    && Math.abs(midi.directe.intensite - 0.5) < 1e-6,
  JSON.stringify(midi.ambiante) + ' ' + JSON.stringify(midi.directe));

const minuit = await page.evaluate(() => window.__mc.reglerHeure(0));
check('à minuit tout est éteint et les lanternes au maximum',
  minuit.phase === 'nuit' && minuit.jour < 0.02 && minuit.lampes === 1 && minuit.soleil[1] < -0.9,
  JSON.stringify({ phase: minuit.phase, jour: minuit.jour, lampes: minuit.lampes, y: minuit.soleil[1] }));
check('la nuit est bleu-noir, pas grise',
  minuit.ciel === 0x070b1c && ((minuit.ciel & 255) > (minuit.ciel >> 16 & 255)),
  minuit.ciel.toString(16));

const course = await page.evaluate(() => {
  const mc = window.__mc;
  const prise = (h) => { const e = mc.reglerHeure(h); return { h, y: e.soleil[1], x: e.soleil[0], z: e.soleil[2], phase: e.phase, lune: e.lune }; };
  const points = [0.25, 0.5, 0.75].map(prise);
  const midi = points[1];
  const ecartLune = midi.lune.reduce((s, v, i) => s + Math.abs(v + midi[['x', 'y', 'z'][i]]), 0);
  // Après midi la course descend : à 19 h le soleil est passé sous la ligne de crête.
  const apresMidi = [0.6, 0.7, 0.8].map(prise);
  return { points, apresMidi, ecartLune };
});
check('le soleil monte puis redescend au fil de la journée',
  Math.abs(course.points[0].y) < 0.05 && course.points[1].y > 0.99 && Math.abs(course.points[2].y) < 0.05
    && course.apresMidi[0].y > 0 && course.apresMidi[1].y < course.apresMidi[0].y
    && course.apresMidi[2].y < -0.2,
  [...course.points, ...course.apresMidi].map((p) => `${p.h}:${p.y.toFixed(2)}`).join(' '));
check('il se lève d’un côté et se couche de l’autre',
  course.points[0].x > 0.5 && course.points[2].x < -0.5,
  `levant ${course.points[0].x.toFixed(2)} · couchant ${course.points[2].x.toFixed(2)}`);
check('l’aube et le crépuscule sont nommés',
  course.points[0].phase === 'aube' && course.points[2].phase === 'crépuscule',
  `${course.points[0].phase} / ${course.points[2].phase}`);
check('la lune occupe la direction opposée au soleil',
  course.ecartLune < 1e-9, `écart ${course.ecartLune}`);

const cadran = await page.evaluate(() => {
  const mc = window.__mc;
  const lire = (h) => { mc.reglerHeure(h); return document.getElementById('clock').textContent.trim(); };
  return { midi: lire(0.5), minuit: lire(0), regle: lire(0.75) };
});
check('le cadran affiche l’heure et la phase',
  cadran.midi === '12h00 · jour' && cadran.minuit === '00h00 · nuit' && cadran.regle === '18h00 · crépuscule',
  JSON.stringify(cadran));

// ================================================== 2. un soleil rond, visible
const disques = await page.evaluate(() => {
  const mc = window.__mc;
  mc.reglerHeure(0.5);
  const s = mc.scene.getObjectByName('soleil');
  const l = mc.scene.getObjectByName('lune');
  const e = mc.ciel();
  const dir = [s.position.x, s.position.y, s.position.z].map((v) => v / s.position.length());
  return {
    soleil: { type: s.geometry.type, visible: s.visible, rayons: s.geometry.parameters?.radius },
    lune: { type: l.geometry.type, visible: l.visible },
    aligne: Math.max(...dir.map((v, i) => Math.abs(v - e.soleil[i]))),
    sousHorizon: (() => { mc.reglerHeure(0.8); const ee = mc.ciel(); return { vis: s.visible, ha: ee.hauteur, luneVis: l.visible }; })(),
  };
});
check('le soleil et la lune sont des disques ronds',
  disques.soleil.type === 'CircleGeometry' && disques.lune.type === 'CircleGeometry',
  `${disques.soleil.type} / ${disques.lune.type}`);
check('le disque suit la trajectoire du modèle',
  disques.aligne < 1e-6, `écart ${disques.aligne}`);
check('le disque disparaît sous l’horizon et la lune prend le relais',
  disques.sousHorizon.vis === false && disques.sousHorizon.ha < -0.12 && disques.sousHorizon.luneVis === true,
  JSON.stringify(disques.sousHorizon));

// Le disque doit réellement peindre une tache. On le juge à part du dôme : masqué puis
// rendu, la seule différence au centre de l'image est lui. Le dôme a son propre renard
// chaud autour de l'astre, qui noierait la comparaison si on les mêlait.
const tache = await page.evaluate(() => {
  const mc = window.__mc;
  mc.reglerHeure(0.28);                       // soleil déjà haut, encore dans les couleurs du matin
  const e = mc.ciel();
  const x = 8, z = 8;
  mc.player.flyMode = true;
  mc.camera.position.set(x, mc.getTerrainHeight(x, z) + 46, z);
  mc.player.velocity.set(0, 0, 0);
  mc.releaseAll();
  for (let i = 0; i < 4; i++) mc.step(1 / 120);
  const pitch = Math.asin(Math.max(-1, Math.min(1, e.soleil[1]))) * 180 / Math.PI;
  const yaw = Math.atan2(-e.soleil[0], -e.soleil[2]) * 180 / Math.PI;
  mc.look(yaw, pitch);
  // Les objets du ciel suivent la caméra dans majCiel, appelée à chaque image : sans un
  // nouveau relevé après le déplacement, le disque resterait accroché à l'ancienne
  // position de la caméra et le contrôle jugerait une scène fantôme.
  mc.reglerHeure(e.heure);
  let dome = null;
  mc.scene.traverse((o) => { if (!dome && o.isMesh && o.geometry?.type === 'SphereGeometry') dome = o; });
  const disque = mc.scene.getObjectByName('soleil');
  mc.camera.updateMatrixWorld(true);
  const ancre = disque.getWorldPosition(new mc.camera.position.constructor()).project(mc.camera);
  const rendu = () => {
    mc.renderer.render(mc.scene, mc.camera);
    const gl = mc.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { px, w, h };
  };
  const moy = (img, fx, fy, demi) => {
    let r = 0, g = 0, b = 0, n = 0;
    const cx = Math.round(fx * (img.w - 1)), cy = Math.round(fy * (img.h - 1));
    for (let y = cy - demi; y <= cy + demi; y++) for (let x2 = cx - demi; x2 <= cx + demi; x2++) {
      if (x2 < 0 || y < 0 || x2 >= img.w || y >= img.h) continue;
      const i = (y * img.w + x2) * 4;
      r += img.px[i]; g += img.px[i + 1]; b += img.px[i + 2]; n++;
    }
    return n ? { r: r / n, g: g / n, b: b / n, lum: (0.2126 * r + 0.7152 * g + 0.0722 * b) / n } : null;
  };
  const tout = rendu();
  // Le disque est visé, donc projeté près du centre ; on mesure pourtant à sa position
  // projetée plutôt qu'au centre géométrique, pour que la mesure suive le modèle.
  const fx = (ancre.x + 1) / 2, fy = (ancre.y + 1) / 2;
  const centre = moy(tout, fx, fy, 10);
  const temoin = moy(tout, fx, Math.min(0.96, fy + 0.34), 10);   // loin au-dessus de l'astre

  // Isolement du disque : plus de dôme, plus de nuages, plus de relief, plus de brume,
  // fond noir. Ce qui reste à sa place est le disque ou rien — le renard du dôme, la
  // nappe et la silhouette des collines noieraient autrement la comparaison (ils peignent
  // ~190 de luminosité).
  const fond = mc.scene.background.getHex();
  const brume = mc.scene.fog;
  const caches = [];
  mc.world.chunks.forEach((c) => (c.meshes || []).forEach((m) => { if (m.visible) { caches.push(m); m.visible = false; } }));
  mc.scene.traverse((o) => { if (o !== disque && (o === dome || o.isPoints || o.name === 'nuages')) { if (o.visible) { caches.push(o); o.visible = false; } } });
  mc.scene.fog = null;
  mc.scene.background.setHex(0x000000);
  disque.visible = false;
  const nu = moy(rendu(), fx, fy, 10);
  disque.visible = true;
  const avecDisque = moy(rendu(), fx, fy, 10);
  const trianglesAvec = mc.renderer.info.render.triangles;
  disque.visible = false;
  mc.renderer.render(mc.scene, mc.camera);
  const trianglesSans = mc.renderer.info.render.triangles;
  disque.visible = true;
  mc.scene.background.setHex(fond);
  mc.scene.fog = brume;
  caches.forEach((o) => { o.visible = true; });
  return { centre, temoin, nu, avecDisque, ancre: [+ancre.x.toFixed(3), +ancre.y.toFixed(3)],
    triangles: { avec: trianglesAvec, sans: trianglesSans }, visibleDuDome: !!dome, hauteur: e.hauteur };
});
check('le soleil visé tombe bien dans le cadre',
  Math.abs(tache.ancre[0]) < 0.25 && Math.abs(tache.ancre[1]) < 0.25, JSON.stringify(tache.ancre));
check('viser le soleil peint un disque franc',
  tache.avecDisque.lum > 60 && tache.nu.lum < 8
    && tache.avecDisque.r > tache.avecDisque.b
    && tache.triangles.avec - tache.triangles.sans >= 20,
  `disque ${tache.avecDisque.lum.toFixed(1)} (${tache.avecDisque.r.toFixed(0)},${tache.avecDisque.g.toFixed(0)},${tache.avecDisque.b.toFixed(0)}) · fond noir ${tache.nu.lum.toFixed(1)} · triangles ${tache.triangles.avec}→${tache.triangles.sans}`);
check('le soleil irradie : sa zone domine largement la bande haute',
  tache.centre.lum > tache.temoin.lum + 15,
  `centre ${tache.centre.lum.toFixed(1)} · bande haute ${tache.temoin.lum.toFixed(1)}`);
check('le disque est plus chaud que le ciel qui l’entoure',
  (tache.centre.r - tache.centre.b) - (tache.temoin.r - tache.temoin.b) > 40,
  `soleil ${tache.centre.r.toFixed(0)},${tache.centre.g.toFixed(0)},${tache.centre.b.toFixed(0)} · ciel ${tache.temoin.r.toFixed(0)},${tache.temoin.g.toFixed(0)},${tache.temoin.b.toFixed(0)}`);

// ------------------------------------------------- 2 bis. les astres restent derrière la roche
// Collés à la caméra, les astres doivent se comporter comme l'infini : n'importe quel
// bloc rendu est plus près qu'eux et les masque. Un matériau `transparent` étant peint
// après tout le relief opaque, un `depthTest` désactivé les faisait passer à travers la
// roche — mesuré avant correction : 38 % de pixels lunaires maintenus derrière un mur
// plein de neuf cubes posé à six cubes de l'objectif.
const occultation = await page.evaluate(({ STONE }) => {
  const mc = window.__mc;
  mc.reglerHeure(0);                              // minuit : lune haute et étoiles franches
  mc.player.flyMode = true;
  const x = 8, z = 8;
  mc.camera.position.set(x, mc.getTerrainHeight(x, z) + 40, z);
  mc.player.velocity.set(0, 0, 0);
  mc.releaseAll();
  for (let i = 0; i < 4; i++) mc.step(1 / 120);
  const e = mc.ciel();
  const borné = (v) => Math.max(-1, Math.min(1, v));
  mc.look(Math.atan2(-e.lune[0], -e.lune[2]) * 180 / Math.PI, Math.asin(borné(e.lune[1])) * 180 / Math.PI);
  mc.reglerHeure(e.heure);                         // recale les astres sur la caméra neuve

  const lune = mc.scene.getObjectByName('lune');
  let etoiles = null;
  mc.scene.traverse((o) => { if (o.isPoints) etoiles = o; });
  const rendu = () => {
    mc.renderer.render(mc.scene, mc.camera);
    const gl = mc.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { px, w, h };
  };
  const clairs = (img, fx, fy, demi) => {
    let n = 0, vus = 0;
    const cx = Math.round(fx * (img.w - 1)), cy = Math.round(fy * (img.h - 1));
    for (let y = cy - demi; y <= cy + demi; y++) for (let xx = cx - demi; xx <= cx + demi; xx++) {
      if (xx < 0 || y < 0 || xx >= img.w || y >= img.h) continue;
      const i = (y * img.w + xx) * 4;
      n++;
      if (img.px[i] > 120 && img.px[i + 1] > 120 && img.px[i + 2] > 120) vus++;
    }
    return +(100 * vus / Math.max(1, n)).toFixed(1);
  };
  mc.camera.updateMatrixWorld(true);
  const ancre = lune.getWorldPosition(new mc.camera.position.constructor()).project(mc.camera);
  const fx = (ancre.x + 1) / 2, fy = (ancre.y + 1) / 2;
  const ciel = clairs(rendu(), fx, fy, 16);

  const dir = new mc.camera.position.constructor(0, 0, -1).applyQuaternion(mc.camera.quaternion).normalize();
  const cible = mc.camera.position.clone().add(dir.multiplyScalar(6));
  const bx = Math.floor(cible.x), by = Math.floor(cible.y), bz = Math.floor(cible.z);
  for (let dy = -4; dy <= 4; dy++) for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
    mc.setBlock(bx + dx, by + dy, bz + dz, STONE);
  }
  mc.streamAll();
  const mur = clairs(rendu(), fx, fy, 16);
  lune.visible = false;
  if (etoiles) etoiles.visible = false;
  const sansAstres = clairs(rendu(), fx, fy, 16);
  lune.visible = true;
  if (etoiles) etoiles.visible = true;
  return {
    ciel, mur, sansAstres,
    distance: +lune.position.length().toFixed(1), loin: +(mc.camera.far * 0.995).toFixed(1),
    testLune: lune.material.depthTest, testEtoiles: etoiles ? etoiles.material.depthTest : null,
  };
}, { STONE });
check('les astres sont testés contre la profondeur du monde',
  occultation.testLune === true && occultation.testEtoiles === true,
  `lune=${occultation.testLune} étoiles=${occultation.testEtoiles}`);
check('les astres sont logés au fond du volume de vue, pas à portée de main',
  Math.abs(occultation.distance - occultation.loin) < 1,
  `lune à ${occultation.distance} · plan lointain visé ${occultation.loin}`);
check('la lune et les étoiles peignent le ciel dégagé',
  occultation.ciel > 10 && occultation.sansAstres === 0,
  `${occultation.ciel} % de pixels clairs, ${occultation.sansAstres} % une fois les astres masqués`);
check('un mur proche cache la lune et les étoiles',
  occultation.mur === 0, `${occultation.mur} % de pixels clairs derrière neuf cubes de pierre`);

// ================================================== 2 ter. l'horizon ne vire pas au blanc
// La brume hérite de la famille de couleurs du ciel, pas de sa bande la plus claire :
// quand elle prenait l'horizon tel quel (#cfe6f5), tout le relief lointain fondait dans
// un linge blanc et le renard du dôme, large et franc, blanchissait une centaine de
// degrés de ciel dès que le soleil frôlait la ligne de fuite.
const horizon = await page.evaluate(() => {
  const mc = window.__mc;
  const rendu = () => {
    mc.renderer.render(mc.scene, mc.camera);
    const gl = mc.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { px, w, h };
  };
  mc.player.flyMode = true;
  mc.releaseAll();
  let colline = { x: 8, z: 8, h: -1 };
  for (let x = 0; x < 96; x += 4) for (let z = 0; z < 96; z += 4) {
    const hh = mc.getTerrainHeight(x, z);
    if (hh > colline.h) colline = { x, z, h: hh };
  }
  const sonder = (heure) => {
    mc.camera.position.set(colline.x + 0.5, colline.h + 1.62, colline.z + 0.5);
    mc.player.velocity.set(0, 0, 0);
    for (let i = 0; i < 4; i++) mc.step(1 / 120);
    mc.look(0, 0);
    mc.reglerHeure(heure);
    const img = rendu();
    const mi = Math.floor(img.h / 2);
    let n = 0, rs = 0, gs = 0, bs = 0, blancs = 0, satures = 0;
    for (let y = mi - 20; y < mi + 20; y++) for (let x = 0; x < img.w; x += 2) {
      const i = (y * img.w + x) * 4;
      const r = img.px[i], g = img.px[i + 1], b = img.px[i + 2];
      rs += r; gs += g; bs += b; n++;
      if (r > 190 && g > 190 && b > 190) blancs++;
      if (Math.min(r, g, b) > 235) satures++;
    }
    const f = mc.scene.fog.color;
    return { heure, phase: mc.ciel().phase, brume: '#' + f.getHexString(),
      lumBrume: Math.round(0.2126 * f.r * 255 + 0.7152 * f.g * 255 + 0.0722 * f.b * 255),
      blancs: +(100 * blancs / n).toFixed(1), satures: +(100 * satures / n).toFixed(1),
      teinte: [Math.round(rs / n), Math.round(gs / n), Math.round(bs / n)] };
  };
  const heures = [0, 0.27, 0.5, 0.73].map(sonder);
  return { colline, heures, pres: mc.scene.fog.near, loin: mc.scene.fog.far };
});
check('la brume reste dans la famille du ciel à toute heure',
  horizon.heures.every((h) => h.lumBrume < 200),
  horizon.heures.map((h) => `${h.phase} #${h.brume} ${h.lumBrume}`).join(' · '));
check('aucune bande d’horizon ne part au blanc',
  horizon.heures.every((h) => h.blancs < 2 && h.satures < 1),
  horizon.heures.map((h) => `${h.phase} ${h.blancs}% blancs ${h.satures}% saturés`).join(' · '));
check('le plein jour garde une bande d’horizon bleutée, pas laiteuse',
  (() => {
    const midi = horizon.heures.find((h) => h.phase === 'jour');
    return !!midi && midi.teinte[2] > midi.teinte[0] + 20;
  })(), JSON.stringify(horizon.heures.find((h) => h.phase === 'jour')));

// ------------------------------------------------- 2 ter bis. les nuages ne sont pas des cubes
// L'utilisateur demandait « des nuages, mais pas en cube ». La suite juge donc la forme
// (des plans, jamais une boîte), la matière (ils repeignent le ciel avec du relief, pas
// un lavis uniforme), l'heure (ils s'éteignent la nuit), l'ancrage (le ciel ne doit pas
// glisser avec le joueur comme un plafond peint) et l'occultation (la roche qui scelle
// une poche d'air les cache). Ils restent visibles dans le contrôle de la bande
// d'horizon ci-dessus : c'est lui qui garantit qu'un voile ne relave pas le plein jour.
const nuages = await page.evaluate(() => {
  const mc = window.__mc;
  mc.player.flyMode = true;
  mc.releaseAll();
  const nappes = [];
  mc.scene.traverse((o) => { if (o.name === 'nuages') nappes.push(o); });
  const gl = mc.renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const tirer = () => {
    mc.renderer.render(mc.scene, mc.camera);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const lum = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
  const moyBande = (p, y0, y1) => {
    let s = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < w; x += 2) { s += lum(p, (y * w + x) * 4); n++; }
    return +(s / n).toFixed(1);
  };

  let colline = { x: 8, z: 8, hh: -1 };
  for (let x = 0; x < 96; x += 4) for (let z = 0; z < 96; z += 4) {
    const hh = mc.getTerrainHeight(x, z);
    if (hh > colline.hh) colline = { x, z, hh };
  }
  mc.camera.position.set(colline.x + 0.5, colline.hh + 1.62, colline.z + 0.5);
  mc.player.velocity.set(0, 0, 0);
  for (let i = 0; i < 4; i++) mc.step(1 / 120);
  const haut = [Math.floor(h * 0.72), h];

  // Le ciel au zénith, avec et sans la nappe : la différence prouve qu'elle peint, et sa
  // dispersion qu'elle dessine des amas plutôt qu'un voile plat.
  mc.reglerHeure(0.5);
  mc.look(0, 85);
  const etatJour = mc.nuages();
  const avec = tirer();
  const cielJour = moyBande(avec, ...haut);
  for (const n of nappes) n.visible = false;      // rien d'autre n'est rappelé : majCiel les rallume
  const sans = tirer();
  const cielNu = moyBande(sans, ...haut);
  let gagnes = 0, somme = 0, max = 0, n = 0;
  const ecarts = [];
  for (let y = haut[0]; y < haut[1]; y += 2) for (let x = 0; x < w; x += 2) {
    const d = lum(avec, (y * w + x) * 4) - lum(sans, (y * w + x) * 4);
    somme += d; n++;
    if (d > 6) gagnes++;
    if (d > max) max = d;
    if ((x + y) % 64 === 0) ecarts.push(d);
  }
  const moyenne = somme / n;
  const ecartType = Math.sqrt(ecarts.reduce((a, v) => a + (v - moyenne) ** 2, 0) / ecarts.length);
  for (const nap of nappes) nap.visible = true;

  mc.reglerHeure(0);
  mc.look(0, 85);
  const etatNuit = mc.nuages();
  const cielNuit = moyBande(tirer(), ...haut);

  // Ancrage : parcourir le monde ne doit pas faire glisser la tuile sous le joueur.
  mc.reglerHeure(0.5);
  const avant = mc.nuages()[0];
  const tuile = avant.tuile;
  const u0 = avant.offsetU - avant.camX / tuile, v0 = avant.offsetV + avant.camZ / tuile;
  mc.camera.position.x += 64;
  mc.camera.position.z -= 40;
  mc.reglerHeure(0.5);
  const apres = mc.nuages()[0];
  const derive = {
    u: +(apres.offsetU - apres.camX / tuile - u0).toFixed(5),
    v: +(apres.offsetV + apres.camZ / tuile - v0).toFixed(5),
  };

  // Et la preuve par l'image, la seule qui vaille pour un ShaderMaterial : `repeat` et
  // `offset` d'une texture ne sont jamais consultés par un shader maison — un ancrage
  // écrit sur ces propriétés passerait le contrôle ci-dessus en laissant le ciel glisser
  // avec le joueur. On décale donc à la main l'uniforme que le vertex shader consomme :
  // une tuile entière doit rendre le ciel identique (le repli est exact), une moitié doit
  // le changer. La caméra ne bouge pas ici — sinon c'est le relief, pas la nappe, qui
  // répondrait à la question.
  const uni = nappes[0].material.uniforms.uDecalage;
  const uAvant = uni.value.x;
  const tirA = tirer();
  uni.value.x = uAvant + 1;
  const tirB = tirer();
  uni.value.x = uAvant + 0.5;
  const tirC = tirer();
  uni.value.x = uAvant;
  const mad = (p, q) => {
    let s = 0, n = 0;
    for (let y = haut[0]; y < haut[1]; y += 2) for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      if (p[i] > p[i + 2] + 5) continue;                  // le relief suit la caméra, pas le ciel
      s += Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]);
      n += 3;
    }
    return { ecart: +(s / Math.max(1, n)).toFixed(2), pixels: Math.round(n / 3) };
  };
  const calage = { pleine: mad(tirA, tirB), demi: mad(tirA, tirC) };

  // Une poche d'air scellée de dix cubes de roche : levée vers le ciel, elle doit rester
  // noire — la nappe est transparente, seule la profondeur du monde peut la cacher.
  mc.streamAll();
  let creux = null;
  for (let x = Math.max(2, colline.x - 40); x < colline.x + 40 && !creux; x += 2) {
    for (let z = Math.max(2, colline.z - 40); z < colline.z + 40 && !creux; z += 2) {
      const hh = mc.getTerrainHeight(x, z);
      for (let y = 6; y < hh - 2; y++) {
        if (mc.bloc(x, y, z) !== 0) continue;
        let ferme = true;
        for (let k = 1; k <= 10; k++) if (mc.bloc(x, y + k, z) === 0) ferme = false;
        if (ferme) { creux = { x, z, y }; break; }
      }
    }
  }
  let cielSousRoche = null;
  if (creux) {
    mc.camera.position.set(creux.x + 0.5, creux.y + 0.5, creux.z + 0.5);
    mc.look(0, 89);
    mc.reglerHeure(0.5);
    cielSousRoche = moyBande(tirer(), ...haut);
  }
  return {
    formes: nappes.map((o) => ({ geometrie: o.geometry.type, horizontal: Math.abs(o.rotation.x + Math.PI / 2) < 1e-6,
      testProfondeur: o.material.depthTest, ecritProfondeur: o.material.depthWrite })),
    etatJour, etatNuit, cielJour, cielNu, cielNuit,
    apport: { couverts: +(100 * gagnes / n).toFixed(1), moyenne: +moyenne.toFixed(1), max: +max.toFixed(1),
      ecartType: +ecartType.toFixed(1) },
    derive, calage, creux, cielSousRoche,
  };
});
check('les nuages sont des nappes continues, jamais des cubes',
  nuages.formes.length >= 2 && nuages.formes.every((f) => f.horizontal
    && f.geometrie !== 'BoxGeometry' && f.testProfondeur && !f.ecritProfondeur),
  nuages.formes.map((f) => `${f.geometrie}${f.horizontal ? ' horizontal' : ''}`).join(' · '));
check('en pleine journée ils repeignent le ciel au-dessus de la tête',
  nuages.apport.couverts > 20 && nuages.apport.max > 12 && nuages.cielJour > nuages.cielNu + 3,
  `${nuages.apport.couverts}% du ciel gagnent plus de 6 de luminance · moyenne +${nuages.apport.moyenne} · pointe +${nuages.apport.max} · ${nuages.cielNu} → ${nuages.cielJour}`);
check('et ils dessinent des amas, pas un lavis uniforme',
  nuages.apport.ecartType > 4,
  `écart type des apports ${nuages.apport.ecartType} sur ${nuages.apport.couverts}% de pixels touchés`);
check('la nuit venue, la nappe s’éteint',
  nuages.etatNuit.every((n, i) => n.opacite < nuages.etatJour[i].opacite * 0.6)
    && nuages.cielNuit < 12,
  `opacité ${nuages.etatJour[0].opacite} → ${nuages.etatNuit[0].opacite} · bande haute ${nuages.cielNuit}`);
check('le ciel des nuages tient au monde quand le joueur marche',
  Math.abs(nuages.derive.u) < 0.02 && Math.abs(nuages.derive.v) < 0.02,
  `après 64 cubes vers l’est et 40 vers le nord, dérive ${(nuages.derive.u)},${(nuages.derive.v)} de tuile`);
check('une tuile de décalage rend le ciel identique, une moitié le change',
  nuages.calage.pleine.pixels > 1000 && nuages.calage.pleine.ecart <= 1
    && nuages.calage.demi.ecart > 2,
  `${nuages.calage.pleine.pixels} pixels de ciel · tuile entière ${nuages.calage.pleine.ecart} · demi-tuile ${nuages.calage.demi.ecart}`);
check('la roche qui scelle une poche d’air cache les nuages',
  !!nuages.creux && nuages.cielSousRoche !== null && nuages.cielSousRoche < 12,
  nuages.creux ? `poche en ${nuages.creux.x},${nuages.creux.y},${nuages.creux.z} · bande haute ${nuages.cielSousRoche}` : 'aucune poche trouvée');

// ================================================== 3. réglage de la durée du jour
const curseur = await page.evaluate(() => {
  const el = document.getElementById('day-length');
  const out = document.getElementById('day-length-value');
  return el ? { min: el.min, max: el.max, step: el.step, value: el.value, sortie: out.textContent } : null;
});
check('le réglage de la durée du jour est borné et libellé',
  curseur && curseur.min === '60' && curseur.max === '3600' && curseur.value === '480'
    && /8 minutes/.test(curseur.sortie),
  JSON.stringify(curseur));

const garde = await page.evaluate(() => {
  const mc = window.__mc;
  const lu = () => JSON.parse(localStorage.getItem('mincraft_settings') || '{}').dureeJour;
  const bas = mc.reglerDureeJour(10);
  const haut = mc.reglerDureeJour(99999);
  const regle = mc.reglerDureeJour(120);
  const rendu = mc.dureeJour();      // lu avant la remise à la cadence du projet
  const disque = lu();
  mc.reglerDureeJour(480);
  return { bas, haut, regle, disque, rendu };
});
check('la durée se règle, se borne et se grave avec les autres réglages',
  garde.bas === 60 && garde.haut === 3600 && garde.regle === 120 && garde.disque === 120 && garde.rendu === 120,
  JSON.stringify(garde));

const avance = await page.evaluate(async () => {
  const mc = window.__mc;
  mc.reglerDureeJour(60);
  mc.horloge().regler(0);
  const t0 = mc.horloge().heure();
  await new Promise((r) => setTimeout(r, 1000));
  const t1 = mc.horloge().heure();
  mc.reglerDureeJour(480);
  return { t0, t1, delta: t1 - t0 };
});
check('à 60 secondes la journée tourne vraiment',
  avance.delta > 0.005 && avance.delta < 0.08, JSON.stringify(avance));

const viaCurseur = await page.evaluate(() => {
  const el = document.getElementById('day-length');
  el.value = '300';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const mc = window.__mc;
  const pris = mc.dureeJour();
  el.value = '480';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return { pris, rendu: mc.dureeJour(), sortie: document.getElementById('day-length-value').textContent };
});
check('le curseur du panneau règle la journée',
  viaCurseur.pris === 300 && viaCurseur.rendu === 480 && /8 minutes/.test(viaCurseur.sortie),
  JSON.stringify(viaCurseur));

// ================================================== 4. les lanternes de la ville
const ville = await page.evaluate(({ LAMP_POST, LAMP_GLOW }) => {
  const mc = window.__mc;
  let meilleur = null;
  for (let cx = -6; cx <= 24; cx++) {
    for (let cz = -6; cz <= 24; cz++) {
      const l = mc.lampadairesSur(cx * 16, cz * 16, cx * 16 + 15, cz * 16 + 15);
      if (l.length && (!meilleur || l.length > meilleur.n)) meilleur = { cx, cz, n: l.length, ex: l[0] };
    }
  }
  if (!meilleur) return null;
  mc.setRenderDistance(2);
  const x = meilleur.cx * 16 + 8.5, z = meilleur.cz * 16 + 8.5;
  mc.player.flyMode = true;
  mc.camera.position.set(x, mc.getTerrainHeight(x, z) + 6, z);
  mc.player.velocity.set(0, 0, 0);
  mc.releaseAll();
  for (let i = 0; i < 12; i++) mc.step(1 / 120);
  mc.streamAll();
  const charge = mc.world.chunks.has(mc.world.getChunkKey(meilleur.cx, meilleur.cz));
  const colonnes = mc.lampadairesSur(meilleur.cx * 16, meilleur.cz * 16, meilleur.cx * 16 + 15, meilleur.cz * 16 + 15)
    .map((l) => ({ pied: mc.bloc(l.wx, l.y, l.wz), lanterne: mc.bloc(l.wx, l.y + 1, l.wz) }));
  return {
    ...meilleur, charge, colonnes,
    retenues: mc.lampesDuTroncon(meilleur.cx, meilleur.cz).length,
    infoPied: mc.BLOCK_INFO[LAMP_POST], infoLanterne: mc.BLOCK_INFO[LAMP_GLOW],
  };
}, { LAMP_POST, LAMP_GLOW });

check('des candélabres jalonnent les avenues', !!ville && ville.n >= 3, ville ? `${ville.n} sur un tronçon` : 'aucun');
check('le tronçon est bien chargé avant de juger le monde', !!ville && ville.charge === true, ville ? String(ville.charge) : '—');
check('le candélabre est estampé : pied et lanterne posés',
  !!ville && ville.colonnes.some((c) => c.pied === LAMP_POST && c.lanterne === LAMP_GLOW),
  ville ? JSON.stringify(ville.colonnes.slice(0, 4)) : '—');
check('les lanternes en place alimentent le halo du tronçon',
  !!ville && ville.retenues >= 1, ville ? String(ville.retenues) : '—');
const pied = ville && ville.infoPied.box;
check('le pied est un poteau fin, ni cubique ni opaque',
  !!pied && pied[3] - pied[0] <= 0.35 && pied[5] - pied[2] <= 0.35
    && pied[1] === 0 && pied[4] === 1
    && ville.infoPied.opaque === false && ville.infoPied.solid === true,
  JSON.stringify(pied));
check('la lanterne est un volume émissif posé au-dessus du pied',
  !!ville && !!ville.infoLanterne.box && ville.infoLanterne.emissive === true
    && ville.infoLanterne.opaque === false && ville.infoLanterne.solid === true
    && ville.infoLanterne.box[1] > 0,
  JSON.stringify(ville && ville.infoLanterne.box));

const palette = await page.evaluate(({ LAMP_POST, LAMP_GLOW }) => {
  const mc = window.__mc;
  const cellules = [...document.querySelectorAll('.inv-cell')];
  const trouve = (id) => cellules.find((c) => Number(c.dataset.block) === id);
  const signature = (id) => {
    const el = trouve(id);
    if (!el) return null;
    const d = el.querySelector('canvas').getContext('2d').getImageData(0, 0, 16, 16).data;
    let somme = 0; const uniq = new Set();
    for (let i = 0; i < d.length; i += 4) { somme += d[i] + d[i + 1] + d[i + 2]; uniq.add(`${d[i]},${d[i + 1]},${d[i + 2]}`); }
    return { somme, nuances: uniq.size };
  };
  const groupes = mc.BLOCK_GROUPS.map((g) => ({ label: g.label, ids: g.ids.slice() }));
  mc.inventory.pick(LAMP_POST);
  const tenuPied = mc.player.selectedBlock;
  mc.inventory.pick(LAMP_GLOW);
  const tenuLanterne = mc.player.selectedBlock;
  return {
    pied: signature(LAMP_POST), lanterne: signature(LAMP_GLOW),
    noms: [trouve(LAMP_POST), trouve(LAMP_GLOW)].map((c) => c && c.querySelector('span').textContent.trim()),
    groupes: groupes.filter((g) => g.ids.includes(LAMP_POST) || g.ids.includes(LAMP_GLOW)),
    total: mc.ALL_BLOCKS.length, dansLaListe: mc.ALL_BLOCKS.includes(LAMP_POST) && mc.ALL_BLOCKS.includes(LAMP_GLOW),
    tenuPied, tenuLanterne,
  };
}, { LAMP_POST, LAMP_GLOW });

check('les deux pièces du lampadaire sont dans l’inventaire de construction',
  palette.dansLaListe && !!palette.pied && !!palette.lanterne
    && palette.pied.somme > 0 && palette.lanterne.somme > 0
    && palette.pied.nuances > 3 && palette.lanterne.nuances > 3,
  JSON.stringify({ pied: palette.pied, lanterne: palette.lanterne }));
check('elles portent un nom lisible et un groupe dédié',
  /Pied de lampadaire/.test(palette.noms[0] || '') && /Lanterne/.test(palette.noms[1] || '')
    && palette.groupes.some((g) => g.label === 'ÉCLAIRAGE'),
  JSON.stringify(palette.noms) + ' ' + JSON.stringify(palette.groupes));
check('les choisir dans la palette les met en main',
  palette.tenuPied === LAMP_POST && palette.tenuLanterne === LAMP_GLOW,
  `${palette.tenuPied} puis ${palette.tenuLanterne}`);

// ------------------------------------------------- 4 bis. l'applique murale se pose au mur
// Le joueur ne choisit pas une orientation qu'il ne peut pas voir : le monde ne porte
// aucune rotation de bloc, donc c'est le mur visé qui dicte l'identifiant. Une arène
// scellée loin du village — un mur de pierre, une case d'air devant lui — jugera les deux
// faces, la visée, le passage et l'enrôlement de la lampe posée à la main.
const MUR = { X: 1102, Z: 1102, fy: 30, STONE, AIR, LAMP_WALL_O };
const applique = await page.evaluate(({ X, Z, fy, STONE, AIR, LAMP_WALL_O }) => {
  const mc = window.__mc;
  const B = mc.BLOCK;
  mc.setRenderDistance(2);
  const cellules = [];
  for (let x = X - 3; x <= X + 3; x++) for (let z = Z - 3; z <= Z + 3; z++) {
    for (let y = fy - 3; y <= fy + 4; y++) cellules.push([x, y, z, y < fy ? STONE : AIR]);
  }
  for (let y = fy; y <= fy + 2; y++) for (let z = Z - 1; z <= Z + 1; z++) cellules.push([X + 1, y, z, STONE]);
  for (const c of cellules) mc.setBlock(c[0], c[1], c[2], c[3]);
  // On déménage la caméra sur l'arène avant d'y lire quoi que ce soit : un cube hors du
  // monde streamé rend 0, et une pose ratée passerait pour une pose réussie.
  mc.player.flyMode = true;
  mc.releaseAll();
  mc.camera.position.set(X - 2.5, fy + 1.62, Z + 0.5);
  mc.player.velocity.set(0, 0, 0);
  for (let i = 0; i < 6; i++) mc.step(1 / 120);
  mc.streamAll();

  mc.inventory.pick(LAMP_WALL_O);
  const tenu = mc.player.selectedBlock;
  // Face est : le mur est du côté +x.
  mc.setBlock(X, fy, Z, LAMP_WALL_O);
  const versEst = mc.bloc(X, fy, Z);
  // Visable depuis le côté libre — sinon on ne pourrait jamais la casser — et le rayon
  // s'arrête bien sur sa case, pas à travers elle sur le mur. Le trait de visée se place
  // à hauteur du globe : à hauteur d'œil, il ne rencontrerait que le mur du fond.
  const info = mc.BLOCK_INFO[LAMP_WALL_O];
  const cible = mc.raycastVoxel({ x: X - 2.5, y: fy + (info.box[1] + info.box[4]) / 2, z: Z + 0.5 },
    { x: 1, y: 0, z: 0 }, 8);
  const bloqueLePassage = mc.world.isSolid(X, fy, Z);
  const dansLeHalo = mc.lampesDuTroncon(Math.floor(X / 16), Math.floor(Z / 16))
    .some((l) => l[0] === X && l[1] === fy && l[2] === Z);
  const rocheVisible = mc.world.isTargetable(X, fy - 2, Z);   // le plein, lui, se vise

  // Face ouest : le mur déménage de l'autre côté, la même icône doit suivre.
  mc.setBlock(X, fy, Z, AIR);
  mc.setBlock(X + 1, fy, Z, AIR);
  mc.setBlock(X - 1, fy, Z, STONE);
  mc.streamAll();
  mc.setBlock(X, fy, Z, LAMP_WALL_O);
  const versOuest = mc.bloc(X, fy, Z);

  // Les quatre faces, jugées chacune sur son propre axe d'adossement : c'est lui seul qui
  // mord sur le couloir. La largeur le long du mur, elle, ne gêne personne.
  const faces = [B.LAMP_WALL_O, B.LAMP_WALL_E, B.LAMP_WALL_N, B.LAMP_WALL_S].map((id) => {
    const i = mc.BLOCK_INFO[id];
    return { id, nom: i.name, emissive: i.emissive, solide: i.solid, opaque: i.opaque,
      breakable: i.breakable, boite: i.box, variant: i.variant === true,
      enCatalogue: mc.ALL_BLOCKS.includes(id) };
  });

  return {
    tenu, versEst, versOuest, faces,
    attends: [B.LAMP_WALL_E, B.LAMP_WALL_O],
    dansPalette: mc.ALL_BLOCKS.includes(LAMP_WALL_O),
    groupe: mc.BLOCK_GROUPS.find((g) => g.ids.includes(LAMP_WALL_O))?.label ?? null,
    nom: mc.BLOCK_INFO[LAMP_WALL_O].name,
    vise: cible ? [cible.x, cible.y, cible.z] : null,
    bloqueLePassage, dansLeHalo, rocheVisible,
  };
}, MUR);

check('l\'applique est une icône de la palette d\'éclairage',
  applique.dansPalette && applique.groupe === 'ÉCLAIRAGE' && applique.tenu === LAMP_WALL_O,
  `${applique.nom} · groupe ${applique.groupe} · tenu ${applique.tenu}`);
// O et E s'adossent en x (faces 0 et 1), N et S en z (faces 2 et 3). Une seule des quatre
// tient une case en palette : la pose lit le mur, le joueur n'a jamais à choisir une face.
check('une seule icône pour quatre faces adossées, collées au mur et hors de portée du passage',
  applique.faces.length === 4 && applique.faces.every((f, i) => {
    const b = f.boite;
    const saillie = i < 2 ? b[3] - b[0] : b[5] - b[2];
    const colleAuMur = [b[0] === 0, b[3] === 1, b[2] === 0, b[5] === 1][i];
    return f.emissive === true && f.solide === false && f.opaque === false && f.breakable === true
      && colleAuMur && saillie <= 0.35 && b[1] >= 0.5 && b[4] <= 1
      && f.enCatalogue === (i === 0) && f.variant === (i > 0);
  }),
  applique.faces.map((f) => `${f.id}:${JSON.stringify(f.boite)}${f.enCatalogue ? '*' : ''}`).join(' '));
check('la même applique s\'adosse au mur qu\'elle trouve, de l\'un comme de l\'autre côté',
  applique.versEst === applique.attends[0] && applique.versOuest === applique.attends[1],
  `mur à l'est → ${applique.versEst} (attendu ${applique.attends[0]}), mur à l'ouest → ${applique.versOuest} (attendu ${applique.attends[1]})`);
check('l\'applique se laisse viser mais ne barre pas la marche',
  !!applique.vise && applique.vise[0] === MUR.X && applique.vise[1] === MUR.fy
    && applique.vise[2] === MUR.Z && applique.bloqueLePassage === false,
  `visé ${JSON.stringify(applique.vise)} · attendu [${MUR.X},${MUR.fy},${MUR.Z}] · solide=${applique.bloqueLePassage}`);
check('la lampe posée par le joueur compte parmi les sources du tronçon',
  applique.dansLeHalo === true && applique.rocheVisible === true,
  `halo ${applique.dansLeHalo} · le plein voisin reste visible au rayon (${applique.rocheVisible})`);

// ================================================== 5. grotte noire, lanterne qui éclaire
// Une cellule scellée de pierre naturelle : murs de deux cubes, plafond de quatre.
// Ni bâtiment ni voirie au-dessus, donc rien qui dispense de l'obscurité.
const CAVE = { X: 902, Z: 902, fy: 30, STONE, AIR, LAMP_POST, LAMP_GLOW };
const grotte = await page.evaluate(({ X, Z, fy, STONE, AIR, LAMP_POST, LAMP_GLOW }) => {
  const mc = window.__mc;
  mc.setRenderDistance(2);
  const cellules = [];
  for (let x = X - 3; x <= X + 3; x++) for (let z = Z - 3; z <= Z + 3; z++) for (let y = fy - 4; y <= fy + 6; y++) {
    cellules.push([x, y, z, STONE]);
  }
  for (let x = X - 1; x <= X + 1; x++) for (let z = Z - 1; z <= Z + 1; z++) for (let y = fy; y <= fy + 2; y++) {
    cellules.push([x, y, z, AIR]);
  }
  for (const c of cellules) mc.setBlock(c[0], c[1], c[2], c[3]);
  mc.player.flyMode = true;
  mc.camera.position.set(X + 0.5, fy + 1.62, Z + 0.5);
  mc.player.velocity.set(0, 0, 0);
  mc.releaseAll();
  const diag = [];
  try {
    for (let i = 0; i < 6; i++) mc.step(1 / 120);
  } catch (e) {
    const px = mc.camera.position;
    for (let x = Math.floor(px.x) - 2; x <= Math.ceil(px.x) + 2; x++)
      for (let y = Math.floor(px.y) - 2; y <= Math.ceil(px.y) + 2; y++)
        for (let z = Math.floor(px.z) - 2; z <= Math.ceil(px.z) + 2; z++) {
          const b = mc.bloc(x, y, z);
          if (b !== 0 && !mc.BLOCK_INFO[b]) diag.push(`${x},${y},${z}=${String(b)}:${typeof b}`);
        }
    diag.push(`err:${e.message}`);
  }
  mc.look(45, 0);            // le regard est tourné à l'opposé du coin où naîtra la lanterne
  mc.streamAll();
  mc.reglerHeure(0);         // nuit pleine : dehors comme dedans, plus de lumière du ciel

  const lectureCanal = () => {
    const chunk = mc.world.chunks.get(mc.world.getChunkKey(Math.floor(X / 16), Math.floor(Z / 16)));
    let max = 0, nonNuls = 0, sommets = 0;
    for (const m of chunk?.meshes ?? []) {
      const a = m.geometry.attributes?.aLampe?.array;
      if (!a) continue;
      sommets += a.length;
      for (let i = 0; i < a.length; i++) { if (a[i] > 0) nonNuls++; if (a[i] > max) max = a[i]; }
    }
    return { max: +max.toFixed(3), nonNuls, sommets };
  };
  const rendu = () => {
    mc.renderer.render(mc.scene, mc.camera);
    const gl = mc.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let somme = 0, n = 0, sombres = 0, clairs = 0;
    for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
      const i = (y * w + x) * 4;
      const lum = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      somme += lum; n++; if (lum < 20) sombres++;
      // Un seul pixel franc dans une cellule scellée signifie que le ciel la traverse.
      if (px[i] > 120 && px[i + 1] > 120 && px[i + 2] > 120) clairs++;
    }
    return { luminosite: +(somme / n).toFixed(1), noirs: +(100 * sombres / n).toFixed(1),
      clairs: +(100 * clairs / n).toFixed(1) };
  };

  const nu = rendu(), canalNu = lectureCanal();
  mc.setBlock(X + 1, fy, Z + 1, LAMP_POST);
  mc.setBlock(X + 1, fy + 1, Z + 1, LAMP_GLOW);
  mc.streamAll();
  const lime = rendu(), canalLime = lectureCanal();
  const blocsPoses = [mc.bloc(X + 1, fy, Z + 1), mc.bloc(X + 1, fy + 1, Z + 1)];
  mc.setBlock(X + 1, fy + 1, Z + 1, AIR);   // le joueur arrache la lanterne
  mc.streamAll();
  const retire = rendu(), canalRetire = lectureCanal();
  return {
    nu, canalNu, lime, canalLime, retire, canalRetire, blocsPoses, diag,
    restantApresRetrait: mc.bloc(X + 1, fy + 1, Z + 1),
    piedRestant: mc.bloc(X + 1, fy, Z + 1),
    edits: mc.editCount(),
  };
}, CAVE);

check('la cellule scellée ne recèle aucun bloc inconnu du jeu',
  grotte.diag.length === 0, grotte.diag.slice(0, 3).join(' | '));
check('sous terre, à la nuit, la galerie est noire',
  grotte.nu.luminosite < 12 && grotte.nu.noirs > 92,
  JSON.stringify(grotte.nu));
check('aucun pixel du ciel ne traverse la roche qui scelle la galerie',
  grotte.nu.clairs === 0, `${grotte.nu.clairs} % de pixels clairs`);
check('et ses sommets ne portent aucun halo',
  grotte.canalNu.sommets > 200 && grotte.canalNu.max < 0.05, JSON.stringify(grotte.canalNu));
check('poser le pied puis la lanterne donne bien deux blocs',
  grotte.blocsPoses[0] === LAMP_POST && grotte.blocsPoses[1] === LAMP_GLOW,
  JSON.stringify(grotte.blocsPoses));
check('la lanterne allume les murs autour d’elle',
  grotte.lime.luminosite > grotte.nu.luminosite * 3 && grotte.lime.luminosite > 30
    && grotte.lime.noirs < 60,
  JSON.stringify(grotte.nu) + ' → ' + JSON.stringify(grotte.lime));
check('le halo est cuit dans les sommets du maillage',
  grotte.canalLime.max > 0.3 && grotte.canalLime.nonNuls > 20,
  JSON.stringify(grotte.canalLime));
check('arracher la lanterne rend la galerie à l’obscurité',
  grotte.restantApresRetrait === AIR && grotte.retire.luminosite < grotte.lime.luminosite * 0.5
    && grotte.canalRetire.max < 0.05,
  JSON.stringify(grotte.retire) + ' ' + JSON.stringify(grotte.canalRetire));
check('le pied reste debout quand on ne casse que la lanterne',
  grotte.piedRestant === LAMP_POST, String(grotte.piedRestant));
check('une fois la lanterne arrachée, le ciel ne revient pas par les murs',
  grotte.retire.clairs === 0, `${grotte.retire.clairs} % de pixels clairs`);

// ================================================== 5 bis. la mine s'éteint loin du jour
// Une galerie creusée par le joueur doit mourir à quelques cubes de son puits d'accès.
// Avant que les boyaux n'aient un plafond, `isCave` creusait la colonne du socle jusqu'à
// trois cubes de la surface : chaque grotte était un puits de jour et le fond d'une
// galerie à six cubes sous la terre tenait 0,87 de lumière du ciel.
const MINE = { X: 300, Z: 300, AIR };
const mine = await page.evaluate(({ X, Z, AIR }) => {
  const mc = window.__mc;
  mc.setRenderDistance(2);
  mc.player.flyMode = true;
  mc.camera.position.set(X + 0.5, mc.getTerrainHeight(X, Z) + 30, Z + 0.5);
  mc.player.velocity.set(0, 0, 0);
  mc.releaseAll();
  mc.streamAll();
  const sol = mc.getTerrainHeight(X, Z);
  const fond = sol - 9;
  for (let x = X; x <= X + 1; x++) for (let z = Z; z <= Z + 1; z++) {
    for (let y = fond; y <= sol; y++) mc.setBlock(x, y, z, AIR);
    // La bouche doit ouvrir sur le ciel : sans ce dégagement, une ramée ou un auvent du
    // monde (mesuré : un bloc opaque flottait six cubes au-dessus du seuil) coiffe le
    // puits et la jugeance ne porte plus sur la physique de la lumière mais sur le hasard
    // du biome.
    for (let y = sol + 1; y <= sol + 8; y++) mc.setBlock(x, y, z, AIR);
  }
  for (let d = 2; d <= 24; d++) for (let z = Z; z <= Z + 1; z++)
    for (let y = fond; y <= fond + 1; y++) mc.setBlock(X + d, y, z, AIR);
  mc.streamAll();
  const rendu = () => {
    mc.renderer.render(mc.scene, mc.camera);
    const gl = mc.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = 0, n = 0, sombres = 0;
    for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
      const i = (y * w + x) * 4;
      const L = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      s += L; n++; if (L < 20) sombres++;
    }
    return { lum: +(s / n).toFixed(1), noirs: +(100 * sombres / n).toFixed(1) };
  };
  const juger = (d, yaw, pitch) => {
    mc.camera.position.set(X + d + 0.5, fond + 0.62, Z + 0.5);
    mc.player.velocity.set(0, 0, 0);
    mc.releaseAll();
    for (let i = 0; i < 4; i++) mc.step(1 / 120);
    mc.look(yaw, pitch || 0);         // 270 : le regard fuit le puits vers la galerie
    mc.reglerHeure(0.5);              // plein jour dehors : seule la bouche reste claire
    return rendu();
  };
  return { sol, fond, gueule: juger(0, 270, 60), gueuleAuLarge: juger(0, 270, 0),
    lointain: juger(16, 270, 0), bout: juger(24, 270, 0), blocAuFond: mc.bloc(X + 16, fond, Z) };
}, MINE);
check('la bouche du puits d’accès reste en pleine lumière',
  mine.gueule.lum > 15 && mine.gueule.noirs < 70,
  JSON.stringify({ versLeJour: mine.gueule, versLaGalerie: mine.gueuleAuLarge }));
check('à seize cubes du jour la galerie est noire',
  mine.lointain.noirs > 90 && mine.lointain.lum < 12, JSON.stringify(mine.lointain));
check('et le fond de la taille aussi',
  mine.bout.noirs > 90 && mine.blocAuFond === AIR, JSON.stringify(mine.bout));

// Le geste même que le joueur dénonce (2026-11-12 : « dans les grottes il n'y a pas
// d'obscurité, il faut l'ajouter sous terre ou quand on crée des cavités sous terre ») :
// il creuse un escalier et descend. La lumière du ciel coulait alors dans le puits sans
// rien payer — mesuré, une telle descente tenait 121 de luminance à son entrée et
// encore 74 huit cubes plus bas : plus il s'enfonçait, plus il portait de jour avec lui.
// Depuis, chaque cube descendu coûte `ATTENUATION_V` dans le champ de lumière.
const ESCALIER = { X: 336, Z: 300, AIR };
const taille = await page.evaluate(({ X, Z, AIR }) => {
  const mc = window.__mc;
  mc.setRenderDistance(2);
  mc.player.flyMode = true;
  mc.releaseAll();
  const sol = mc.getTerrainHeight(X, Z);
  mc.camera.position.set(X + 0.5, sol + 6, Z + 0.5);
  mc.player.velocity.set(0, 0, 0);
  mc.streamAll();
  // Volée de dix marches : à chaque pas, un cube vers l'avant et un cube vers le bas,
  // deux de garde-tête — exactement ce que fait la main du joueur qui mine en descendant.
  for (let k = 0; k <= 10; k++) for (let dz = 0; dz <= 1; dz++) {
    mc.setBlock(X + k, sol - k, Z + dz, AIR);
    mc.setBlock(X + k, sol - k + 1, Z + dz, AIR);
  }
  // Dégagement de l'entrée : la volée doit plonger depuis le ciel ouvert, pas depuis une
  // poche que le hasard du relief aurait coiffée.
  for (let x = X; x <= X + 1; x++) for (let z = Z; z <= Z + 1; z++)
    for (let y = sol + 1; y <= sol + 8; y++) mc.setBlock(x, y, z, AIR);
  mc.streamAll();
  const rendu = () => {
    mc.renderer.render(mc.scene, mc.camera);
    const gl = mc.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = 0, n = 0, sombres = 0;
    for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
      const i = (y * w + x) * 4;
      const L = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      s += L; n++; if (L < 20) sombres++;
    }
    return { lum: +(s / n).toFixed(1), noirs: +(100 * sombres / n).toFixed(1) };
  };
  const juger = (k) => {
    mc.camera.position.set(X + k + 0.5, sol - k + 0.62, Z + 0.5);
    mc.player.velocity.set(0, 0, 0);
    mc.releaseAll();
    for (let i = 0; i < 4; i++) mc.step(1 / 120);
    mc.look(270, 0);                 // le regard suit la descente, à l'opposé du jour
    mc.reglerHeure(0.5);
    return rendu();
  };
  return { sol, entree: juger(0), mi: juger(5), fond: juger(9),
    blocAuFond: mc.bloc(X + 9, sol - 9, Z) };
}, ESCALIER);
check('l’escalier est creusé dans un sol assez épais pour descendre',
  taille.sol >= 16 && taille.blocAuFond === AIR, JSON.stringify(taille));
check('son entrée reste en pleine lumière',
  taille.entree.lum > 15 && taille.entree.noirs < 70, JSON.stringify(taille.entree));
check('à cinq marches du jour, le jour reste derrière lui',
  taille.entree.lum > 2 * taille.mi.lum && taille.mi.lum > 3 * taille.fond.lum,
  `${taille.entree.lum} → ${taille.mi.lum} → ${taille.fond.lum}`);
check('neuf marches plus bas, le joueur creuse dans le noir',
  taille.fond.noirs > 90 && taille.fond.lum < 12, JSON.stringify(taille.fond));

// ================================================== 5 ter. le village s'éclaire lui-même
// Demandé le 2026-11-11 : « il faudrait mettre de la lumiere dans les maisons et dans les
// temples ». Une pièce doit tenir sa clarté du seul générateur — la sauvegarde n'étant
// qu'un diff du joueur, une lanterne posée à la main ne repousserait jamais au monde
// suivant — et rendre l'ombre quand on l'arrache. La chambre jugée est tenue à l'écart de
// tout candélabre d'avenue comme de toute autre lanterne : sinon c'est la voisine qui
// éclairerait la fenêtre et le contrôle ne prouverait plus rien.
const INTE = { AIR, LAMP_POST, LAMP_GLOW };
const interieur = await page.evaluate(({ AIR, LAMP_POST, LAMP_GLOW }) => {
  const mc = window.__mc;
  const editsAvant = mc.editCount();
  let meilleur = null;
  for (let cx = -8; cx <= 24; cx++) {
    for (let cz = -8; cz <= 24; cz++) {
      const n = mc.lampesInterieuresSur(cx * 16, cz * 16, cx * 16 + 15, cz * 16 + 15).length;
      if (!meilleur || n > meilleur.n) meilleur = { cx, cz, n };
    }
  }
  if (!meilleur || !meilleur.n) return { erreur: 'aucune aire intérieure au village' };
  mc.setRenderDistance(3);
  mc.player.flyMode = true;
  mc.releaseAll();
  const ax = meilleur.cx * 16 + 8, az = meilleur.cz * 16 + 8;
  mc.camera.position.set(ax + 0.5, mc.getTerrainHeight(ax, az) + 6, az + 0.5);
  mc.player.velocity.set(0, 0, 0);
  for (let i = 0; i < 12; i++) mc.step(1 / 120);
  mc.streamAll();

  const rues = [];
  const posees = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const a = (meilleur.cx + dx) * 16, b = (meilleur.cz + dz) * 16;
      for (const r of mc.lampadairesSur(a, b, a + 15, b + 15)) rues.push(r);
      for (const l of mc.lampesInterieuresSur(a, b, a + 15, b + 15)) {
        if (mc.bloc(l.wx, l.y, l.wz) === LAMP_POST && mc.bloc(l.wx, l.y + 1, l.wz) === LAMP_GLOW) posees.push(l);
      }
    }
  }
  // La pièce jugée se choisit « la mieux isolée » plutôt qu'au-dessus d'un seuil : les
  // lanternes d'intérieur se posent à trois cubes l'une de l'autre et les maisons se
  // touchent, donc une chambre parfaitement seule n'existe presque jamais (mesuré : zéro
  // candidate à douze cubes de toute voisine). Le voisinage le plus éloigné reste le
  // meilleur témoin disponible pour juger ce que doit à SA lanterne — d'où le contrôle en
  // chute de lumière, pas en obscurité absolue. Les candélabres d'avenue, eux, sont tenus
  // à douze cubes : la rue n'a pas à éclairer la fenêtre jugée.
  const cheb = (a, b) => Math.max(Math.abs(a.wx - b.wx), Math.abs(a.wz - b.wz));
  const loinDesRues = (l) => rues.every((r) => cheb(l, r) >= 12);
  let choisie = null, score = -1;
  for (const l of posees) {
    if (!loinDesRues(l)) continue;
    let plusProche = Infinity;
    for (const o of posees) if (o !== l) plusProche = Math.min(plusProche, cheb(l, o));
    if (plusProche > score) { score = plusProche; choisie = l; }
  }
  if (!choisie) return { erreur: 'aucune lanterne à l\'écart des avenues', posees: posees.length, rues: rues.length };

  const { wx, wz, y } = choisie;
  mc.camera.position.set(wx + 0.5, y + 1.62, wz + 0.5);
  mc.player.velocity.set(0, 0, 0);
  mc.releaseAll();
  for (let i = 0; i < 6; i++) mc.step(1 / 120);
  mc.streamAll();
  mc.look(0, -8);
  mc.reglerHeure(0);                    // minuit : la pièce ne doit son jour qu'à sa lampe

  const cle = mc.world.getChunkKey(Math.floor(wx / 16), Math.floor(wz / 16));
  const lectureCanal = () => {
    const chunk = mc.world.chunks.get(cle);
    let max = 0, nonNuls = 0, sommets = 0;
    for (const m of chunk?.meshes ?? []) {
      const a = m.geometry.attributes?.aLampe?.array;
      if (!a) continue;
      sommets += a.length;
      for (let i = 0; i < a.length; i++) { if (a[i] > 0) nonNuls++; if (a[i] > max) max = a[i]; }
    }
    return { max: +max.toFixed(3), nonNuls, sommets };
  };
  const rendu = () => {
    mc.renderer.render(mc.scene, mc.camera);
    const gl = mc.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = 0, n = 0, sombres = 0;
    for (let yy = 0; yy < h; yy += 3) for (let xx = 0; xx < w; xx += 3) {
      const i = (yy * w + xx) * 4;
      const L = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      s += L; n++; if (L < 20) sombres++;
    }
    return { lum: +(s / n).toFixed(1), noirs: +(100 * sombres / n).toFixed(1) };
  };
  const avant = rendu(), canalAvant = lectureCanal();
  mc.setBlock(wx, y + 1, wz, AIR);      // le joueur arrache la lanterne, le pied reste
  mc.streamAll();
  const apres = rendu(), canalApres = lectureCanal();
  return {
    troncon: `${meilleur.cx},${meilleur.cz}`, choisie, posees: posees.length, rues: rues.length,
    isolement: score === Infinity ? 'seule' : score,
    editsAvant, editsApres: mc.editCount(), avant, canalAvant, apres, canalApres,
    lanterneApres: mc.bloc(wx, y + 1, wz), piedReste: mc.bloc(wx, y, wz),
  };
}, INTE);

const pieceClaire = !!interieur.choisie;
check('le village porte des lanternes d\'intérieur réellement debout',
  pieceClaire && interieur.posees >= 3,
  interieur.erreur || `${interieur.posees} lanternes posées autour du tronçon ${interieur.troncon}`);
check('la lumière d\'intérieur vient du générateur, pas d\'une édition du joueur',
  pieceClaire && interieur.editsApres === interieur.editsAvant + 1,
  pieceClaire ? `${interieur.editsAvant} éditions avant, ${interieur.editsApres} après l\'arrachage` : '—');
check('à minuit, une pièce du village est claire sans rien poser',
  pieceClaire && interieur.avant.lum > 25 && interieur.avant.noirs < 70,
  pieceClaire ? JSON.stringify(interieur.avant) : interieur.erreur || '—');
check('son halo est cuit dans les sommets du maillage',
  pieceClaire && interieur.canalAvant.max > 0.3 && interieur.canalAvant.nonNuls > 20,
  pieceClaire ? JSON.stringify(interieur.canalAvant) : '—');
check('arracher la lanterne éteint sa pièce',
  pieceClaire && interieur.lanterneApres === AIR && interieur.apres.lum < interieur.avant.lum * 0.5
    && (interieur.apres.noirs > 75 || interieur.apres.lum < 15),
  pieceClaire ? `${JSON.stringify(interieur.avant)} → ${JSON.stringify(interieur.apres)} · voisine à ${interieur.isolement}` : '—');
check('le pied survit à la casse de la lanterne d\'intérieur',
  pieceClaire && interieur.piedReste === LAMP_POST, String(interieur.piedReste));

// ------------------------------------------------- 5 quater. et ses murs restent noirs dehors
// Le contrôle Node de `tests/ciel.mjs` juge le champ de lumière ; celui-ci juge l'image.
// L'utilisateur voyait la lueur des maisons suinter à travers les cloisons : « on devrait
// uniquement la voir depuis les fenêtres ». La chambre est la même qu'en 5 ter — donc déjà
// prouvée éclairée par SA lanterne — mais observée depuis la rue, face à sa façade. Le
// rayon visuel doit d'abord heurter un mur, et retirer la lanterne ne doit rien changer à
// l'image : ce qui ne se voit pas ne peut pas varier.
const exterieur = await page.evaluate(({ AIR, LAMP_GLOW, choisie }) => {
  const mc = window.__mc;
  if (!choisie) return { erreur: 'aucune chambre jugée en 5 ter' };
  const { wx, wz, y } = choisie;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let vue = null;
  for (const [dx, dz] of dirs) {
    let mur = 0;
    for (let k = 1; k <= 8; k++) {
      if (mc.bloc(wx + dx * k, y + 1, wz + dz * k) !== AIR) { mur = k; break; }
    }
    if (!mur) continue;
    let degage = true;
    for (let k = mur + 1; k <= mur + 3; k++) if (mc.bloc(wx + dx * k, y + 1, wz + dz * k) !== AIR) degage = false;
    if (degage) { vue = { dx, dz, mur }; break; }
  }
  if (!vue) return { erreur: 'aucune façade dégagée autour de la chambre' };

  const ex = wx + vue.dx * (vue.mur + 2) + 0.5;
  const ez = wz + vue.dz * (vue.mur + 2) + 0.5;
  mc.player.flyMode = true;
  mc.releaseAll();
  mc.camera.position.set(ex, y + 1.62, ez);
  mc.player.velocity.set(0, 0, 0);
  const cibleX = wx + 0.5 - ex, cibleZ = wz + 0.5 - ez, cibleY = (y + 1) - (y + 1.62);
  const pas = Math.hypot(cibleX, cibleY, cibleZ) || 1;
  const dir = { x: cibleX / pas, y: cibleY / pas, z: cibleZ / pas };
  mc.look(Math.atan2(-dir.x, -dir.z) * 180 / Math.PI, Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180 / Math.PI);
  mc.reglerHeure(0);
  for (let i = 0; i < 4; i++) mc.step(1 / 120);
  mc.streamAll();
  mc.reglerHeure(0);

  // Le trait de visée doit mourir dans un mur avant d'atteindre la lanterne : sans cette
  // preuve, une fenêtre ouverte rendrait le contrôle inoffensif plutôt que faux négatif.
  const tire = mc.raycastVoxel(mc.camera.position, new (mc.camera.position.constructor)(dir.x, dir.y, dir.z), pas + 2);
  const masque = !!tire && tire.t < pas - 0.4;

  const gl = mc.renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const mesure = () => {
    mc.renderer.render(mc.scene, mc.camera);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = 0, n = 0, sombres = 0;
    const cx = Math.round(w / 2), cy = Math.round(h / 2);
    for (let yy = cy - 26; yy <= cy + 26; yy += 2) for (let xx = cx - 26; xx <= cx + 26; xx += 2) {
      const i = (yy * w + xx) * 4;
      const L = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      s += L; n++; if (L < 20) sombres++;
    }
    return { lum: +(s / n).toFixed(1), noirs: +(100 * sombres / n).toFixed(1) };
  };
  const eteinte = mesure();                       // 5 ter a arraché la lanterne
  mc.setBlock(wx, y + 1, wz, LAMP_GLOW);          // on la remet en place
  mc.streamAll();
  mc.reglerHeure(0);
  const allumee = mesure();
  mc.setBlock(wx, y + 1, wz, AIR);                // et on laisse la scène comme trouvée
  mc.streamAll();
  return { vue, masque, t: tire ? +tire.t.toFixed(2) : null, pas: +pas.toFixed(2), eteinte, allumee };
}, { AIR, LAMP_GLOW, choisie: interieur.choisie });

check('depuis la rue, la lanterne de la chambre est cachée par un mur',
  exterieur.masque === true,
  exterieur.erreur || `mur à ${exterieur.vue?.mur} cubes · visée coupée à ${exterieur.t} sur ${exterieur.pas}`);
check('la lumière d\'une pièce ne traverse pas ses murs extérieurs',
  exterieur.eteinte && exterieur.allumee
    && Math.abs(exterieur.allumee.lum - exterieur.eteinte.lum) <= 6
    && exterieur.allumee.lum < 45 && exterieur.allumee.noirs > 55,
  exterieur.erreur || `façade ${JSON.stringify(exterieur.eteinte)} lanterne éteinte · ${JSON.stringify(exterieur.allumee)} allumée`);

// ------------------------------------------------- 5 quater bis. le couloir d'immeuble s'éclaire au mur
// Demandé le 2026-11-11 : « dans les immeubles tu mis les lumières devant les portes, il
// faudrait ajouter une lumière qui soit mise sur les murs pour éviter de bloquer le
// passage ». Le couloir tient donc sa clarté d'appliques scellées au mur. Ce contrôle juge
// trois choses que rien d'autre ne prouve : l'applique est bien posée par le générateur,
// elle alimente le halo du maillage — sans quoi elle serait un décor éteint — et c'est
// elle qui éclaire le pan de mur visé, pas une lanterne voisine derrière la cloison.
// Il se juge après la façade : il éteint tous les candélabres autour du couloir mesuré, ce
// qui aveuglerait le contrôle précédent s'il passait avant lui.
const MURALE = { AIR, LAMP_POST, LAMP_GLOW, APP: [23, 24, 25, 26] };
const couloir = await page.evaluate(({ AIR, LAMP_POST, LAMP_GLOW, APP }) => {
  const mc = window.__mc;
  // Les quatre identifiants dans l'ordre des faces d'adossement : ouest, est, nord, sud.
  const DIRS = [[-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]];
  const editsAvant = mc.editCount();
  let meilleur = null;
  for (let cx = -8; cx <= 24; cx++) {
    for (let cz = -8; cz <= 24; cz++) {
      const n = mc.appliquesMuralesSur(cx * 16, cz * 16, cx * 16 + 15, cz * 16 + 15).length;
      if (!meilleur || n > meilleur.n) meilleur = { cx, cz, n };
    }
  }
  if (!meilleur || !meilleur.n) return { erreur: 'aucun couloir d\'immeuble au village' };
  mc.setRenderDistance(3);
  mc.player.flyMode = true;
  mc.releaseAll();
  const ax = meilleur.cx * 16 + 8, az = meilleur.cz * 16 + 8;
  mc.camera.position.set(ax + 0.5, mc.getTerrainHeight(ax, az) + 6, az + 0.5);
  mc.player.velocity.set(0, 0, 0);
  for (let i = 0; i < 12; i++) mc.step(1 / 120);
  mc.streamAll();

  const posees = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const a = (meilleur.cx + dx) * 16, b = (meilleur.cz + dz) * 16;
      for (const l of mc.appliquesMuralesSur(a, b, a + 15, b + 15)) {
        const id = mc.bloc(l.wx, l.y, l.wz);
        if (APP.includes(id)) posees.push({ wx: l.wx, wz: l.wz, y: l.y, id });
      }
    }
  }
  if (!posees.length) return { erreur: 'aucune applique debout', candidats: meilleur.n };
  const choisie = posees[0];
  const face = DIRS[APP.indexOf(choisie.id)];
  const info = mc.BLOCK_INFO[choisie.id];

  // D'abord la chaîne de découverte : le maillage ne cuit un halo que pour les sources que
  // `lampesAutour` lui déclare. Une applique absente de cette liste serait un globe peint
  // dans le noir — le bloc existerait, la lumière jamais.
  const tcx = Math.floor(choisie.wx / 16), tcz = Math.floor(choisie.wz / 16);
  const cle = mc.world.getChunkKey(tcx, tcz);
  const cleApplique = `${choisie.wx},${choisie.y},${choisie.wz}`;
  const sources = () => mc.lampesDuTroncon(tcx, tcz).map((l) => l.join(','));
  const declaree = sources().includes(cleApplique);

  // Ensuite seulement vient la mesure d'image. Un couloir d'immeuble longe des pièces qui
  // ont chacune leur candélabre, et leur verre jaune inonde le cadre : la première mouture
  // de ce contrôle mesurait 85,4 → 85,4 lum en arrachant l'applique, parce que ce sont les
  // candélabres voisins qui peignaient l'image. On les éteint donc tous autour du couloir
  // jugé — ils ne sont pas ce qu'on teste ici, et `tests/village.mjs` juge déjà leur pose —
  // et il ne reste que l'applique pour éclairer le mur visé.
  let eteintes = 0;
  for (let x = choisie.wx - 12; x <= choisie.wx + 12; x++) {
    for (let z = choisie.wz - 12; z <= choisie.wz + 12; z++) {
      for (let y = choisie.y - 6; y <= choisie.y + 6; y++) {
        const b = mc.bloc(x, y, z);
        if (b === LAMP_POST || b === LAMP_GLOW) { mc.setBlock(x, y, z, AIR); eteintes++; }
      }
    }
  }

  // Le mur porteur est du côté `face`, la seconde colonne du couloir — il en fait deux —
  // du côté opposé. C'est là qu'on se plante, à un cube du globe : le cadre prend l'applique
  // de plein fouet et la plaque de mur qu'elle allume. À défaut de place libre en vis-à-vis,
  // la mesure se fait depuis la case de l'applique elle, qui n'est pas solide.
  const devant = { x: choisie.wx - face[0], z: choisie.wz - face[2] };
  const libre = mc.bloc(devant.x, choisie.y - 1, devant.z) === AIR
    && mc.bloc(devant.x, choisie.y, devant.z) === AIR;
  const depuis = libre ? devant : { x: choisie.wx, z: choisie.wz };
  mc.camera.position.set(depuis.x + 0.5, choisie.y - 1 + 1.62, depuis.z + 0.5);
  mc.player.velocity.set(0, 0, 0);
  mc.releaseAll();
  for (let i = 0; i < 6; i++) mc.step(1 / 120);
  mc.streamAll();
  // Camera.rotation en Euler 'YXZ' regarde selon (−sin yaw, ·, −cos yaw) : voilà le cap qui
  // pointe vers le mur porteur, avec un léger relèvement vers le globe perché en hauteur.
  mc.look(Math.atan2(-face[0], -face[2]) * 180 / Math.PI, 12);
  mc.reglerHeure(0);

  const lectureCanal = () => {
    const chunk = mc.world.chunks.get(cle);
    let max = 0, nonNuls = 0;
    for (const m of chunk?.meshes ?? []) {
      const a = m.geometry.attributes?.aLampe?.array;
      if (!a) continue;
      for (let i = 0; i < a.length; i++) { if (a[i] > 0) nonNuls++; if (a[i] > max) max = a[i]; }
    }
    return { max: +max.toFixed(3), nonNuls };
  };
  const rendu = () => {
    mc.renderer.render(mc.scene, mc.camera);
    const gl = mc.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = 0, n = 0, jaunes = 0, centre = 0, centreJaunes = 0;
    for (let yy = 0; yy < h; yy += 3) for (let xx = 0; xx < w; xx += 3) {
      const i = (yy * w + xx) * 4;
      s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      n++;
      // Le globe de l'applique est peint d'un jaune franc que plus rien ne porte dans le
      // cadre depuis que les candélabres voisins sont éteints : le compter au centre, c'est
      // juger que la mesure regarde bien L'APPLIQUE et non un pan de mur endormi.
      const jaune = px[i] > 200 && px[i + 1] > 150 && px[i + 2] < 140;
      if (jaune) jaunes++;
      if (xx > w / 3 && xx < 2 * w / 3 && yy > h / 3 && yy < 2 * h / 3) {
        centre++;
        if (jaune) centreJaunes++;
      }
    }
    return { lum: +(s / n).toFixed(1), jaunes, centre, centreJaunes };
  };
  const avant = rendu(), canalAvant = lectureCanal(), sourcesAvant = sources().length;
  const cible = mc.raycastVoxel(mc.camera.position, { x: face[0], y: 0, z: face[2] }, 4);
  mc.setBlock(choisie.wx, choisie.y, choisie.wz, AIR);
  mc.streamAll();
  const apres = rendu(), canalApres = lectureCanal(), sourcesApres = sources().length;
  return {
    troncon: `${meilleur.cx},${meilleur.cz}`, choisie, posees: posees.length, eteintes,
    declaree, depuis, visaitVisAVis: libre,
    solide: !!(info && info.solid), emissive: !!(info && info.emissive),
    piedBloc: mc.bloc(depuis.x, choisie.y - 1, depuis.z),
    mur: cible ? `${cible.x},${cible.y},${cible.z}@${cible.t.toFixed(2)}` : 'rien',
    avant, canalAvant, sourcesAvant, apres, canalApres, sourcesApres,
    appliqueApres: mc.bloc(choisie.wx, choisie.y, choisie.wz),
  };
}, MURALE);

const couloirEclaire = !!couloir.choisie;
check('les couloirs d\'immeuble portent des appliques debout',
  couloirEclaire && couloir.posees >= 2,
  couloir.erreur || `${couloir.posees} appliques autour du tronçon ${couloir.troncon}`);
check('l\'applique est un meuble mural : ni solide, ni opaque, mais émissif',
  couloirEclaire && couloir.solide === false && couloir.emissive === true,
  couloirEclaire ? `solide=${couloir.solide} · émissif=${couloir.emissive}` : '—');
check('l\'applique compte parmi les sources de lumière du tronçon',
  couloirEclaire && couloir.declaree && couloir.sourcesApres === couloir.sourcesAvant - 1,
  couloirEclaire ? `${couloir.sourcesAvant} sources déclarées, l'applique arrachée → ${couloir.sourcesApres}` : '—');
check('à minuit, le globe de l\'applique domine le couloir',
  couloirEclaire && couloir.avant.lum > 60 && couloir.avant.centreJaunes > couloir.avant.centre * 0.08,
  couloirEclaire ? `${JSON.stringify(couloir.avant)} · ${couloir.eteintes} candélabres éteints autour` : couloir.erreur || '—');
check('casser l\'applique rend le couloir à l\'obscurité',
  couloirEclaire && couloir.appliqueApres === AIR
    && couloir.apres.jaunes < couloir.avant.jaunes * 0.25
    && couloir.apres.lum < couloir.avant.lum * 0.5
    && couloir.canalApres.nonNuls < couloir.canalAvant.nonNuls,
  couloirEclaire ? `${JSON.stringify(couloir.avant)} → ${JSON.stringify(couloir.apres)} · `
    + `halo ${JSON.stringify(couloir.canalAvant)} → ${JSON.stringify(couloir.canalApres)} · mur ${couloir.mur}` : '—');

// ================================================== 6.-console
check('aucune erreur console hors ressources ignorées',
  consoleErrors.filter((e) => !ignorable(e)).length === 0,
  consoleErrors.filter((e) => !ignorable(e)).slice(0, 3).join(' | '));

await page.screenshot({ path: `${SHOTS}/nuit-nuit.png` }).catch(() => {});
console.log(`\nnuit ${JSON.stringify(grotte.nu)} · éclairée ${JSON.stringify(grotte.lime)} · retirée ${JSON.stringify(grotte.retire)}`);
process.exit(summary());
