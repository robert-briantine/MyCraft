// La frontière de ce que la caméra voit — un seul prédicat, le carré du champ rendu **et**
// le disque que la brume laisse lire. Ce que la brume efface déjà ne doit être ni maille
// (2,5–3,2 ms pièce), ni comptabilise au tas, ni trié par le four, ni passé au frustum.
//
// Cinq promesses, jugées ici parce que l'œil ne les juge pas :
//  — **aucun trou** : tout ce qui est franchement sous la brume est peint ;
//  — **rien au-delà** : la couronne des coins du carré n'est plus à la scène ;
//  — **ça se paie moins cher en marchant** : même binaire, bras A/B contre l'ancienne
//    frontière carrée, sur des coins vierges différents pour que la chaleur du cache ne
//    favorise personne ;
//  — **l'averse ne déshabille personne** : la frontière se juge sur la brume sèche, sinon
//    chaque averse culotterait la couronne et chaque éclaircie la repeindrait ;
//  — **générer reste exhaustif** : `pendingChunks` doit continuer de dire « ce qui reste ».
//
// Usage: node tests/frontiere.mjs [url]
// Nécessite le serveur statique (npm start / node server.js).
import { openGame, waitForBoot, makeReporter } from './browser.mjs';

const URL = process.argv[2] || 'http://localhost:8080';
const { check, summary } = makeReporter();

const { browser, page, consoleErrors } = await openGame(URL);
await waitForBoot(page);

const r = await page.evaluate(() => {
  const mc = window.__mc;
  const w = mc.world;
  const W = Object.getPrototypeOf(w);
  const CS = mc.CHUNK_SIZE;
  const RAYON = 12;
  const VITESSE = 12;                       // cubes/s, allure de course
  const DISTANCE = 48;                      // cubes parcourus par bras

  const prediatOriginal = W._montreACamera;
  const vrai = {
    rebuild: W.rebuildChunk, poser: W._poserMaillages, retirer: W._retirerMaillages,
  };
  const compte = { maillages: 0, poses: 0, decrochages: 0 };
  W.rebuildChunk = function (cx, cz) { compte.maillages++; return vrai.rebuild.call(this, cx, cz); };
  W._poserMaillages = function (c) { compte.poses++; return vrai.poser.call(this, c); };
  W._retirerMaillages = function (c) { compte.decrochages++; return vrai.retirer.call(this, c); };
  const remettre = () => { for (const k of ['maillages', 'poses', 'decrochages']) compte[k] = 0; };

  mc.image(true);
  mc.player.flyMode = true;
  mc.setRenderDistance(RAYON);

  const v = new (mc.THREE.Vector3)();
  const maillesScene = () => {
    let n = 0;
    for (const o of mc.scene.children) if (o.isMesh && o.userData && o.userData.seau) n++;
    return n;
  };
  /** Distance du coin d'assiette le plus proche, en cubes — la mesure du jeu, pas du centre. */
  const auCoin = (cx, cz) => {
    const camX = w._camX, camZ = w._camZ;
    const x0 = cx * CS, z0 = cz * CS;
    const px = camX < x0 ? x0 : (camX > x0 + CS ? x0 + CS : camX);
    const pz = camZ < z0 ? z0 : (camZ > z0 + CS ? z0 + CS : camZ);
    return Math.hypot(camX - px, camZ - pz);
  };
  const sInstall = (X, Z) => {
    mc.camera.position.set(X, 40, Z);
    mc.look(90, 0);                                        // cap +x
    let garde = 0;
    do { w.updateChunks(X, Z, 64, Infinity, 1, 0); } while (w.pendingChunks > 0 && garde++ < 4000);
    mc.scene.updateMatrixWorld(true);
    return garde;
  };

  // --- 1 & 2 : pas de trou sous la brume, rien au-delà ---------------------
  const X = 6000, Z = 6000;
  const passes = sInstall(X, Z);
  const brume = mc.porteeBrume();                          // { near, far, x, z } — la référence du jeu
  const pcx = Math.floor(X / CS), pcz = Math.floor(Z / CS);
  let sousLaBrume = 0, sousLaBrumeSansMaille = 0, tropLoinAccroche = 0, reserves = 0;
  for (const c of w.chunks.values()) {
    const d = auCoin(c.cx, c.cz);
    const dansLeCarre = Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz)) <= RAYON + 2;
    if (!dansLeCarre) continue;
    if (d <= brume.far + CS * 0.5) {                       // dedans, à un demi-tronçon près
      // La marge du jeu vaut un tronçon entier (`MARGE_BRUME = 1`) : exiger tout ce qui
      // tient jusqu'à `far + CS/2` laisse donc un demi-tronçon de jeu au produit, mais ne
      // laisse plus la place d'un tronçon. C'est ce qui sépare juger l'assiette au coin le
      // plus PROCHE (la règle) du juger au plus lointain : dans ce second cas une couronne
      // de tronçons encore lisibles reste sans maille, et le seuil large d'avant
      // (`far × 0,95`) ne la voyait pas.
      sousLaBrume++;
      if (c.meshes.length === 0 || c.meshes.some((m) => m.parent !== mc.scene)) sousLaBrumeSansMaille++;
    } else if (d > brume.far + 3 * CS) {                   // franchement dehors : rien à la scène
      // Jugé à l'accrochage, pas au compteur de mailles : un tronçon mis en réserve garde
      // ses tampons (c'est ce qui rend le demi-tour gratuit) tout en étant décroché.
      if (c.meshes.some((m) => m.parent === mc.scene)) tropLoinAccroche++;
      if (c.horsVue) reserves++;
    }
  }
  const pendings = w.pendingChunks;
  const troncons = w.chunks.size;
  const accrochees = maillesScene();

  // --- 3 : ce que coûte une marche, avec et sans la frontière brume ---------
  const courir = (bras, Xb, Zb) => {
    W._montreACamera = bras === 'carre'
      ? (cx, cz) => {
        const c = w._centre;
        if (!c) return true;
        return Math.max(Math.abs(cx - c.pcx), Math.abs(cz - c.pcz)) <= c.radius + 2;
      }
      : prediatOriginal;
    sInstall(Xb, Zb);
    remettre();
    const pas = VITESSE / 60;
    for (let parcouru = 0; parcouru < DISTANCE; parcouru += pas) {
      const x = Xb + parcouru;
      mc.camera.position.set(x, 40, Zb);
      w.updateChunks(x, Zb, 64, Infinity, 1, 0);
      mc.scene.updateMatrixWorld(true);
      mc.renderer.render(mc.scene, mc.camera);
    }
    mc.renderer.render(mc.scene, mc.camera);
    const info = { ...mc.renderer.info.render };
    return { maillages: compte.maillages, accrochees: maillesScene(), appels: info.calls, triangles: info.triangles };
  };
  const brumeBras = courir('brume', 6000, 6000);
  const carreBras = courir('carre', 14000, 6000);
  W._montreACamera = prediatOriginal;

  // --- 4 : l'averse serre la brume rendue, jamais la frontière --------------
  mc.camera.position.set(-22000, 40, 6000);
  sInstall(-22000, 6000);
  const avantAverse = { accrochees: maillesScene(), reserves: [...w.chunks.values()].filter((c) => c.horsVue).length };
  remettre();
  const pluie = mc.reglerPluie(1);
  for (let i = 0; i < 8; i++) mc.step(1 / 60);
  // La brume rendue, lue à la scène : c'est elle que l'averse serre, et c'est précisément
  // ce qui ne doit PAS bouger la frontière (jugée sur la sèche, dans le jeu).
  const brumeRendue = { brume: [+mc.scene.fog.near.toFixed(1), +mc.scene.fog.far.toFixed(1)] };
  const apresAverse = { accrochees: maillesScene(), reserves: [...w.chunks.values()].filter((c) => c.horsVue).length };

  // --- 5 : un demi-tour sur place ne repeint rien ---------------------------
  remettre();
  for (let i = 0; i < 6; i++) { mc.camera.rotation.y += Math.PI / 3; w.updateChunks(-22000, 6000, 64, Infinity, 0, 0); }
  for (let i = 0; i < 6; i++) { mc.camera.rotation.y -= Math.PI / 3; w.updateChunks(-22000, 6000, 64, Infinity, 0, 0); }
  const demiTour = { ...compte };

  W.rebuildChunk = vrai.rebuild; W._poserMaillages = vrai.poser; W._retirerMaillages = vrai.retirer;
  mc.reglerPluie(null);
  mc.setRenderDistance(mc.DEFAULT_RENDER_DISTANCE);
  mc.player.flyMode = false;

  return {
    RAYON, CS, passes, pendings, troncons, accrochees,
    brume, sousLaBrume, sousLaBrumeSansMaille, tropLoinAccroche, reserves,
    attenduSiCarreSeul: (2 * RAYON + 1) ** 2,
    attenduSiCarreSeulMailles: (2 * RAYON + 1) ** 2 * 2,
    brumeBras, carreBras,
    pluie, brumeRendue, avantAverse, apresAverse, demiTour,
  };
});

check(
  'ce qui est sous la brume est peint jusqu\'à un demi-tronçon de la lisière',
  r.sousLaBrume > 0 && r.sousLaBrumeSansMaille === 0,
  `${r.sousLaBrume} tronçons sous ${Math.round(r.brume.far + r.CS * 0.5)} cubes`
    + ` (brume sèche ${Math.round(r.brume.far)}) · ${r.sousLaBrumeSansMaille} sans maille`,
);
check(
  'la couronne que la brume efface n\'est plus accrochée à la scène',
  r.tropLoinAccroche === 0 && r.reserves > 0
    && r.accrochees <= r.attenduSiCarreSeulMailles * 0.9,
  `${r.tropLoinAccroche} tronçon(s) encore accroché(s) au-delà de la brume · ${r.reserves} en réserve`
    + ` · ${r.accrochees} mailles à la scène pour ${r.attenduSiCarreSeulMailles} si le carré`
    + ` seul décidait (${r.attenduSiCarreSeul} tronçons × 2 seaux)`,
);
check(
  'générer reste exhaustif : la table porte tout le champ et la file est vide',
  r.pendings === 0 && r.troncons >= r.attenduSiCarreSeul,
  `${r.troncons} tronçons en table · ${r.pendings} en attente · drainé en ${r.passes} passes`,
);
check(
  'en marchant, la frontière brume fait payer moins de maillages que le carré seul',
  r.brumeBras.maillages > 0 && r.brumeBras.maillages <= r.carreBras.maillages * 0.9,
  `${r.brumeBras.maillages} maillages contre ${r.carreBras.maillages} à l\'ancienne`
    + ` · ${r.brumeBras.accrochees} mailles contre ${r.carreBras.accrochees}`
    + ` · ${r.brumeBras.appels} appels contre ${r.carreBras.appels}`
    + ` · ${r.brumeBras.triangles} triangles contre ${r.carreBras.triangles}`,
);
check(
  'à l\'arrêt, une averse ne déshabille ni ne repeint la couronne',
  r.apresAverse.accrochees === r.avantAverse.accrochees && r.apresAverse.reserves === r.avantAverse.reserves
    && r.demiTour.decrochages === 0,
  `pluie forcée à ${r.pluie} · brume rendue ${(r.brumeRendue.brume || []).join('→')} vs sèche `
    + `${r.brume.near}→${r.brume.far} · ${r.avantAverse.accrochees} → ${r.apresAverse.accrochees} mailles`
    + ` · ${r.avantAverse.reserves} → ${r.apresAverse.reserves} en réserve`,
);
check(
  'demi-tour sur place : aucune maille refaite, aucun tronçon déshabillé',
  r.demiTour.maillages === 0 && r.demiTour.decrochages === 0,
  `${r.demiTour.maillages} reconstruction(s) · ${r.demiTour.poses} repose(s) · ${r.demiTour.decrochages} décrochage(s)`,
);

const ignorable = (x) => /favicon|Failed to load resource/i.test(String(x));
check(
  'aucune erreur console pendant le jugement de la frontière',
  consoleErrors.filter((e) => !ignorable(e)).length === 0,
  consoleErrors.filter((e) => !ignorable(e)).slice(0, 3).join(' | '),
);

await browser.close();
process.exit(summary());
