// Headless verification of the air controls: jump on a tap, jetpack on a hold,
// glide on a second press in the air (Z/S throttle), F no longer flies.
// Usage: node tests/vol.mjs [url]
// Needs the static server running (npm start / node server.js).
import { openGame, makeReporter } from './browser.mjs';

const URL = process.argv[2] || 'http://localhost:8080';

const { check, summary } = makeReporter();
const { browser, page, consoleErrors } = await openGame(URL);

const STONE = 3, AIR = 0, WATER = 7, EYE = 1.62;

// Les nombres du contrôleur se lisent dans le jeu : la suite juge des rapports, pas
// des chiffres recopiés qui dériveraient au premier réglage.
const K = await page.evaluate(() => {
  const mc = window.__mc;
  return {
    grav: mc.GRAVITY, saut: mc.JUMP_SPEED, jet: mc.JET_SPEED, marche: mc.MOVE_SPEED,
    min: mc.PLANE_MIN, defaut: mc.PLANE_DEFAUT, max: mc.PLANE_MAX, thrust: mc.PLANE_THRUST,
    sustentation: mc.PLANE_LIFT_SPEED, sink: mc.PLANE_SINK_MAX,
  };
});

// ---------------------------------------------------------------- terrain d'essai
// Un plancher de pierre, une piste dégagée devant et rien au-dessus : le planeur parcourt
// jusqu'à cinquante cubes, et une colline sur sa trajectoire jugerait une chute là où il
// n'y en a pas.
const PISTE = { x0: 294, x1: 356, z0: 294, z1: 306, sol: 20, toit: 70 };
await page.evaluate((P) => {
  const mc = window.__mc;
  for (let x = P.x0; x <= P.x1; x++) {
    for (let z = P.z0; z <= P.z1; z++) {
      for (let y = P.sol - 2; y <= P.toit; y++) mc.setBlock(x, y, z, y === P.sol ? 3 : 0);
    }
  }
  mc.world.updateChunks(P.x0 + 6, P.z0 + 6);
  return true;
}, PISTE);

const CX = 300.5, CZ = 300.5, SOL = PISTE.sol + 1;

const auSol = () => page.evaluate(({ x, z, feet, EYE }) => {
  const mc = window.__mc;
  mc.player.flyMode = false;
  mc.releaseAll();
  mc.player.coupeLeVol();
  mc.camera.position.set(x, feet + EYE, z);
  mc.player.velocity.set(0, 0, 0);
  for (let i = 0; i < 30; i++) mc.step(1 / 120);
  return { feet: mc.feetY(), onGround: mc.player.onGround };
}, { x: CX, z: CZ, feet: SOL, EYE });

/** En l'air, à `h` cubes au-dessus du plancher, immobile et les mains vides. */
const enLAir = (h, pitch = 0, yaw = -90) => page.evaluate(({ x, z, y, EYE, pitch, yaw }) => {
  const mc = window.__mc;
  mc.player.flyMode = false;
  mc.releaseAll();
  mc.player.coupeLeVol();
  mc.camera.position.set(x, y + EYE, z);
  mc.player.velocity.set(0, 0, 0);
  mc.player.onGround = false;
  mc.look(yaw, pitch);          // yaw −90 ⇒ avant = +X : cap connu pour juger l'avancement
  return true;
}, { x: CX, z: CZ, y: SOL + h, EYE, pitch, yaw });

const touches = (carte) => page.evaluate((c) => {
  const mc = window.__mc;
  mc.releaseAll();
  for (const [code, down] of Object.entries(c)) mc.press(code, down);
  return true;
}, carte);

const vide = () => page.evaluate(() => { window.__mc.releaseAll(); return true; });

// Image par image : les assertions parlent du déroulé du geste, pas seulement de sa fin.
const trace = (frames, dt = 1 / 60) => page.evaluate(({ frames, dt }) => {
  const mc = window.__mc;
  const t = [];
  for (let i = 0; i < frames; i++) {
    mc.step(dt);
    t.push({
      feet: mc.feetY(), vy: mc.player.velocity.y, x: mc.camera.position.x,
      z: mc.camera.position.z,
      planant: mc.player.planant, reacteurs: mc.player.reacteurs,
      allure: mc.player.vitesseVol, onGround: mc.player.onGround, mode: mc.modeDuJoueur(),
    });
  }
  return t;
}, { frames, dt });

const haut = (t) => Math.max(...t.map((p) => p.feet));
const bas = (t) => Math.min(...t.map((p) => p.feet));

// ============================================================ 1. F ne fait plus voler
{
  const avant = await page.evaluate(() => window.__mc.player.flyMode);
  await page.evaluate(() => { window.__mc.keyDown('KeyF'); window.__mc.keyUp('KeyF'); });
  const apres = await page.evaluate(() => ({
    fly: window.__mc.player.flyMode,
    aide: document.getElementById('blocker').textContent,
  }));
  check('F ne bascule plus le vol', avant === false && apres.fly === false,
    `avant=${avant} après=${apres.fly}`);
  check("l'aide annonce les nouveaux gestes et plus « Shift — Descendre »",
    /réacteurs/i.test(apres.aide) && /plané/i.test(apres.aide)
      && !/Shift\s*—\s*Descendre/i.test(apres.aide),
    apres.aide.replace(/\s+/g, ' ').slice(0, 150));
}

// ============================================================ 2. un appui au sol saute
const picSaut = (K.saut * K.saut) / (2 * K.grav);
{
  await auSol();
  await touches({ Space: true });
  const impulsion = await trace(1);        // l'appui : le saut part
  await vide();                            // relâché tout de suite : pas de réacteurs
  const balistique = await trace(120);
  const pic = Math.max(haut(impulsion), haut(balistique)) - SOL;
  check('un appui sur Espace saute, ni plus ni moins qu\'un saut',
    Math.abs(pic - picSaut) < 0.35,
    `pic=${pic.toFixed(2)} attendu≈${picSaut.toFixed(2)}`);
  const pose = await auSol();
  check('le saut retombé remet le joueur à plat sur son plancher',
    Math.abs(pose.feet - SOL) < 1e-6 && pose.onGround,
    `pieds=${pose.feet.toFixed(4)} auSol=${pose.onGround}`);
  check('retombé du saut, le joueur ne redécolle pas tout seul',
    bas(balistique) >= SOL - 1e-6 && haut(balistique) < SOL + picSaut + 0.4,
    `bas=${(bas(balistique) - SOL).toFixed(3)} haut=${(haut(balistique) - SOL).toFixed(2)}`);
  check('au sol, les réacteurs ne s\'allument pas (c\'est le saut qui répond)',
    impulsion.every((p) => !p.reacteurs) && balistique.every((p) => !p.reacteurs),
    `${balistique.filter((p) => p.reacteurs).length} image(s) en réacteurs`);
}

// ============================================================ 3. maintenir = réacteurs
{
  await auSol();
  await touches({ Space: true });
  const montee = await trace(30);          // 0,5 s de réacteurs
  const enMontee = montee.filter((p) => p.reacteurs);
  const sommet = haut(montee) - SOL;
  check('Espace tenu en l\'air allume les réacteurs',
    enMontee.length > 20 && montee.some((p) => p.mode === 'Réacteurs'),
    `${enMontee.length}/30 images en réacteurs`);
  check('les réacteurs montent bien plus haut que le saut',
    sommet > picSaut + K.jet * 0.3 && sommet < K.jet * 1.2,
    `sommet=${sommet.toFixed(2)} (saut ${picSaut.toFixed(2)}, réacteurs ${K.jet} c/s)`);
  check('la montée des réacteurs est à vitesse tenue',
    enMontee.length > 5 && enMontee.slice(2).every((p) => Math.abs(p.vy - K.jet) < 0.6),
    enMontee.slice(2, 6).map((p) => p.vy.toFixed(2)).join(' '));
  await vide();
  const redescente = await trace(150);
  const s = await auSol();
  check('relâcher Espace fait redescendre jusqu\'au sol',
    bas(redescente) <= SOL + 1e-6 && Math.abs(s.feet - SOL) < 1e-6 && s.onGround,
    `pieds=${s.feet.toFixed(4)} auSol=${s.onGround}`);
}

// ============================================================ 4. second appui = plané
{
  await enLAir(30);
  await touches({ Space: true });
  await trace(1);
  await vide();
  const ouvert = await page.evaluate(() => ({
    planant: window.__mc.player.planant, allure: window.__mc.player.vitesseVol,
    mode: window.__mc.modeDuJoueur(),
  }));
  check('un nouvel Espace en l\'air ouvre le plané',
    ouvert.planant === true && ouvert.mode.startsWith('Plané')
      && Math.abs(ouvert.allure - K.defaut) < 1e-6,
    `planant=${ouvert.planant} allure=${ouvert.allure} mode=${ouvert.mode}`);

  const glisse = await trace(30);          // 0,5 s à l'allure par défaut
  const perte = glisse[0].feet - glisse[glisse.length - 1].feet;
  const avance = glisse[glisse.length - 1].x - glisse[0].x;
  check('en plané on ne tombe plus : on tient son altitude',
    perte < 1.0,
    `${perte.toFixed(2)} cube perdu en 0,5 s (chute libre : ${(0.5 * K.grav * 0.25).toFixed(2)})`);
  check('le plané avance dans la direction du regard',
    avance > K.defaut * 0.35 && avance < K.defaut * 0.75,
    `${avance.toFixed(2)} cubes en 0,5 s pour ${K.defaut} c/s`);
  check("à l'allure par défaut la portance manque un peu, doucement",
    Math.abs(glisse[10].vy + K.sink * (1 - K.defaut / K.sustentation)) < 0.4,
    `vy=${glisse[10].vy.toFixed(2)} attendu≈${(-K.sink * (1 - K.defaut / K.sustentation)).toFixed(2)}`);
}

// ============================================================ 5. Z accélère, S freine
{
  await enLAir(30);
  await touches({ Space: true });
  await trace(1);
  await vide();
  await touches({ Space: true, KeyZ: true });
  const accelere = await trace(40);
  const plein = accelere[accelere.length - 1].allure;
  check('Z fait monter l\'allure du planeur',
    plein > K.defaut + 3 && plein <= K.max + 1e-6,
    `${K.defaut} → ${plein.toFixed(1)} (plafond ${K.max})`);
  const aPlat = await trace(60);          // assez longtemps pour saturer le gaz
  check("au-delà de l'allure de sustentation, plus aucune perte d'altitude",
    Math.abs(aPlat[15].vy) < 0.05 && aPlat.every((p) => p.vy <= 0.01),
    `vy=${aPlat[15].vy.toFixed(3)} pour ${aPlat[15].allure.toFixed(1)} c/s`);
  check('le gaz se borne au plafond',
    aPlat.every((p) => p.allure <= K.max + 1e-6) && Math.max(...aPlat.map((p) => p.allure)) > K.max - 0.5,
    `max mesuré=${Math.max(...aPlat.map((p) => p.allure)).toFixed(1)} (plafond ${K.max})`);

  await touches({ Space: true, KeyS: true });
  const freine = await trace(60);
  const avantS = freine[0].allure;
  const mini = freine[freine.length - 1].allure;
  check('S réduit l\'allure, sans jamais l\'annuler',
    mini < avantS - 5 && mini >= K.min - 1e-6 && freine.every((p, i) => i === 0 || p.allure <= freine[i - 1].allure + 1e-9),
    `${avantS.toFixed(1)} → ${mini.toFixed(1)} c/s (plancher ${K.min})`);
  const descend = await trace(60);        // on continue à freiner jusqu'à l'allure plancher
  const lent = descend[descend.length - 1];
  const perdu = descend[0].feet - descend[descend.length - 1].feet;
  check('trop lent, le planeur perd de la hauteur — mais doucement',
    lent.allure < K.sustentation * 0.6 && lent.vy < -1 && perdu < 6,
    `${lent.allure.toFixed(1)} c/s · vy=${lent.vy.toFixed(2)} · ${perdu.toFixed(2)} cube(s) en 1 s`);
  await vide();
}

// ============================================== 5b. la caméra tient la trajectoire
{
  // Le nez décide de l'altitude, l'allure de la portance. Juger trois inclinaisons d'un
  // même vol — et leur différence contre le vol à plat — c'est juger que c'est bien le
  // regard qui vole, et non la pesanteur qui aurait changé de signe.
  const rad = (d) => d * Math.PI / 180;
  const vole = async (pitch, yaw = -90, frames = 30) => {
    await enLAir(30, pitch, yaw);
    await touches({ Space: true });
    await trace(1);
    await vide();                                   // lâché : le plané reste ouvert
    return trace(frames);
  };

  const aLhorizontale = await vole(0);
  const nezEnHaut = await vole(35);
  const gagne = haut(nezEnHaut) - nezEnHaut[0].feet;
  check('regarder en haut fait prendre de l\'altitude',
    nezEnHaut.every((p) => p.vy > K.sink * 0.2) && gagne > 2
      && nezEnHaut.every((p) => p.planant && !p.reacteurs),
    `+${gagne.toFixed(2)} cubes en 0,5 s · vy=${nezEnHaut[10].vy.toFixed(2)}`);
  check('le HUD annonce la montée', nezEnHaut.every((p) => /en montée/.test(p.mode)),
    nezEnHaut[5].mode);

  const nezEnBas = await vole(-35);
  const perdu = nezEnBas[0].feet - bas(nezEnBas);
  check('regarder en bas fait perdre de l\'altitude',
    nezEnBas.every((p) => p.vy < -K.sink * 0.2) && perdu > 2
      && nezEnBas.every((p) => p.planant && !p.reacteurs),
    `−${perdu.toFixed(2)} cubes en 0,5 s · vy=${nezEnBas[10].vy.toFixed(2)}`);
  check('le HUD annonce la descente', nezEnBas.every((p) => /en descente/.test(p.mode)),
    nezEnBas[5].mode);

  // Ce que le regard ajoute (ou retire) au vol à plat vaut exactement l'ordonnée du
  // vecteur visé : ni marge laissée à une gravité de secours, ni dérive d'intégration.
  const attendu = K.defaut * Math.sin(rad(35));
  check("l'inclinaison ajoute au vol à plat ±allure·sin(noz), rien de plus",
    Math.abs((nezEnHaut[10].vy - aLhorizontale[10].vy) - attendu) < 0.3
      && Math.abs((nezEnBas[10].vy - aLhorizontale[10].vy) + attendu) < 0.3,
    `mesuré ${(nezEnHaut[10].vy - aLhorizontale[10].vy).toFixed(2)} / `
      + `${(nezEnBas[10].vy - aLhorizontale[10].vy).toFixed(2)} pour ±${attendu.toFixed(2)}`);

  const aLaVerticale = await vole(80);
  const monteDroit = haut(aLaVerticale) - aLaVerticale[0].feet;
  const glisseLaterale = Math.abs(aLaVerticale[aLaVerticale.length - 1].x - aLaVerticale[0].x);
  check('le nez au zénith, on monte presque sans avancer',
    monteDroit > K.defaut * 0.25 && glisseLaterale < K.defaut * Math.cos(rad(80)) * 0.9,
    `+${monteDroit.toFixed(2)} vertical pour ${glisseLaterale.toFixed(2)} horizontal`);

  const capAuNord = await vole(20, 0);              // yaw 0 ⇒ avant = −Z
  const deriveX = Math.abs(capAuNord[capAuNord.length - 1].x - capAuNord[0].x);
  const avanceZ = capAuNord[0].z - capAuNord[capAuNord.length - 1].z;
  check("l'azimut du vol reste celui de la caméra",
    avanceZ > K.defaut * 0.17 && deriveX < 0.4,
    `${avanceZ.toFixed(2)} cube sur −Z, ${deriveX.toFixed(3)} de dérive en X`);
}

// ============================================================ 6. un Espace rompt le plané
{
  await enLAir(30);
  await touches({ Space: true });
  await trace(1);
  await vide();
  await trace(20);                                   // installé en plané
  await touches({ Space: true });                    // même pression : on redescend
  const premiere = await trace(1);                   // l'appui ne produit qu'à l'image suivante
  const apresBris = await page.evaluate(() => ({
    planant: window.__mc.player.planant, reacteurs: window.__mc.player.reacteurs,
  }));
  check('un Espace en vol rompt le plané',
    premiere[0].planant === false && apresBris.planant === false,
    `planant=${apresBris.planant}`);
  const chute = await trace(30);                     // la touche reste tenue
  check('la pression qui rompt le plané ne rallume pas les réacteurs',
    apresBris.reacteurs === false && chute.every((p) => !p.reacteurs),
    `réacteurs=${chute.filter((p) => p.reacteurs).length}/30 images`);
  check('rompu, le plané laisse place à la chute',
    chute[chute.length - 1].feet < chute[0].feet - 1 && chute.every((p) => p.vy < 0.01),
    `perdu=${(chute[0].feet - chute[chute.length - 1].feet).toFixed(2)} cubes`);
  await vide();
  await trace(1);                                        // une image voit la touche relâchée,
  await touches({ Space: true });                        // sinon le nouvel appui n'est pas un appui
  const rouvert = await trace(2);
  await vide();
  check('un troisième Espace rouvre le plané (le geste est réversible)',
    rouvert.length === 2 && rouvert.every((p) => p.planant),
    rouvert.map((p) => `planant=${p.planant}`).join(' '));
}

// ============================================================ 7. le plané s'éteint au sol
{
  await enLAir(6);
  await touches({ Space: true });
  await trace(1);
  await vide();
  await touches({ Space: true, KeyS: true });        // allure minimale : on coule vite
  const pose = await trace(120);
  const s = await page.evaluate(() => ({
    planant: window.__mc.player.planant, onGround: window.__mc.player.onGround,
    feet: window.__mc.feetY(), mode: window.__mc.modeDuJoueur(),
  }));
  check("posé, le planeur s'arrête et le joueur retrouve ses jambes",
    pose.some((p) => p.onGround) && s.planant === false && s.onGround
      && Math.abs(s.feet - SOL) < 1e-6 && s.mode === 'Marche',
    `pieds=${s.feet.toFixed(4)} planant=${s.planant} mode=${s.mode}`);
  await vide();
}

// ============================================================ 8. sous l'eau, Espace reste la nage
{
  const BASSIN = { cx: 340, cz: 300 };
  await page.evaluate(({ cx, cz }) => {
    const mc = window.__mc;
    for (let x = cx - 3; x <= cx + 3; x++) {
      for (let z = cz - 3; z <= cz + 3; z++) {
        for (let y = 18; y <= 24; y++) mc.setBlock(x, y, z, y <= 23 ? 7 : 0);
        mc.setBlock(x, 17, z, 3);
      }
    }
    mc.world.updateChunks(cx, cz);
    return true;
  }, BASSIN);

  const nage = await page.evaluate(({ x, z, EYE }) => {
    const mc = window.__mc;
    mc.player.flyMode = false;
    mc.releaseAll();
    mc.player.coupeLeVol();
    mc.camera.position.set(x, 21.5 + EYE, z);
    mc.player.velocity.set(0, 0, 0);
    mc.player.onGround = false;
    for (let i = 0; i < 20; i++) mc.step(1 / 120);   // on s'installe à la flottaison
    const avant = mc.feetY();
    mc.press('Space');
    const t = [];
    for (let i = 0; i < 30; i++) {
      mc.step(1 / 60);
      t.push({
        feet: mc.feetY(), nage: mc.player.nage,
        planant: mc.player.planant, reacteurs: mc.player.reacteurs,
      });
    }
    mc.releaseAll();
    return { monte: mc.feetY() - avant, t };
  }, { x: BASSIN.cx + 0.5, z: BASSIN.cz + 0.5, EYE });
  const dansLEau = nage.t.filter((p) => p.nage);
  check("dans l'eau, Espace reste le coup de palme et n'ouvre aucun vol",
    nage.monte > 0.5 && dansLEau.length > 20
      && dansLEau.every((p) => !p.planant && !p.reacteurs),
    `monté de ${nage.monte.toFixed(2)} · ${dansLEau.length}/30 images immergées · `
      + `planant=${dansLEau.filter((p) => p.planant).length} réacteurs=${dansLEau.filter((p) => p.reacteurs).length}`);
  check("franchir la ligne d'eau touche tenue ne décolle pas",
    nage.t.every((p) => !p.reacteurs && !p.planant),
    `${nage.t.filter((p) => !p.nage).length} image(s) hors de l'eau · `
      + `réacteurs=${nage.t.filter((p) => p.reacteurs).length} planant=${nage.t.filter((p) => p.planant).length}`);

  // Le bassin creusé pour l'essai ne doit pas laisser de trou dans la piste.
  await page.evaluate(({ cx, cz }) => {
    const mc = window.__mc;
    for (let x = cx - 3; x <= cx + 3; x++) {
      for (let z = cz - 3; z <= cz + 3; z++) {
        for (let y = 17; y <= 24; y++) mc.setBlock(x, y, z, y === 20 ? 3 : 0);
      }
    }
    mc.world.updateChunks(cx, cz);
    return true;
  }, BASSIN);
}

// ============================================================ hygiene
const reelles = consoleErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
check('aucune erreur console pendant les vols', reelles.length === 0,
  reelles.slice(0, 3).join(' | '));

await browser.close();
process.exit(summary() ? 1 : 0);
