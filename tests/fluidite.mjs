// La cadence du rendu — deux leviers que le joueur peut désormais toucher, et qui doivent
// rendre des comptes :
//
//  - **Netteté** (`#netrete`) : le jeu prenait `min(devicePixelRatio, 2)` sans rien demander.
//    Mesuré le 2026-11-17 sous rasteriseur logiciel, passer de ×2 à ×1 rend +37 % d'images
//    par seconde (12,1 → 16,6 i/s) — c'est le réglage qui compte sur un Windows à 150 %.
//    Jugé ici sur le **canevas réellement alloué**, jamais sur l'intention du réglage ;
//  - **Budget du mailleur** : il ne prend plus 10 ms fixes mais la marge laissée par l'image.
//    Jugé sur **l'argument effectivement reçu par `updateChunks`**, recalculé dans cette suite
//    depuis les constantes exposées — une décision juste que personne n'exécute ne vaut rien.
//
// Usage: node tests/fluidite.mjs [url]
// Nécessite le serveur statique (npm start / node server.js).
import { openGame, waitForBoot, makeReporter } from './browser.mjs';

const URL = process.argv[2] || 'http://localhost:8080';
const { check, summary } = makeReporter();

const { browser, page, consoleErrors } = await openGame(URL);
await waitForBoot(page);

// ---------------------------------------------------------------------------
// 1. Netteté : ce que le canevas alloue vraiment
// ---------------------------------------------------------------------------
const defaut = await page.evaluate(() => window.__mc.netrete());
check(
  'sans réglage, la netteté est celle d’avant : min(devicePixelRatio, 2)',
  Math.abs(defaut.ratio - Math.min(defaut.devicePixelRatio, 2)) < 1e-9,
  `ratio ${defaut.ratio} · devicePixelRatio ${defaut.devicePixelRatio}`,
);
check(
  'le canevas suit le ratio annoncé',
  defaut.tampon[0] === Math.floor(defaut.fenetre[0] * defaut.ratio)
    && defaut.tampon[1] === Math.floor(defaut.fenetre[1] * defaut.ratio),
  `canevas ${defaut.tampon.join('×')} · fenêtre ${defaut.fenetre.join('×')} · ratio ${defaut.ratio}`,
);

const balayage = await page.evaluate(async () => {
  const mc = window.__mc;
  const lu = {};
  for (const reglage of mc.NETTETES) {
    mc.reglerNetrete(reglage);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    lu[reglage] = mc.netrete();
  }
  const horsListe = {};
  for (const valeur of ['9', '', 'beaucoup', null]) {
    mc.reglerNetrete(valeur);
    horsListe[JSON.stringify(valeur)] = mc.netrete();
  }
  mc.reglerNetrete('native');
  return { lu, horsListe, liste: mc.NETTETES.slice() };
});

const natif = balayage.lu.native;
const plein = balayage.lu['1'];
check(
  '« 1× » rend exactement la taille de la fenêtre en pixels',
  plein.ratio === Math.min(1, plein.devicePixelRatio)
    && plein.tampon[0] === Math.floor(plein.fenetre[0] * plein.ratio),
  `ratio ${plein.ratio} · canevas ${plein.tampon.join('×')}`,
);
check(
  'de ×1 à ×0,5, chaque côté du canevas est bien divisé par deux',
  balayage.lu['0.5'].tampon[0] * 2 === balayage.lu['1'].tampon[0]
    && balayage.lu['0.5'].tampon[1] * 2 === balayage.lu['1'].tampon[1],
  `1× ${balayage.lu['1'].tampon.join('×')} · 0,5× ${balayage.lu['0.5'].tampon.join('×')}`,
);
check(
  'descendre la netteté rend le canevas au plus petit que le natif, et strictement en dessous',
  balayage.lu['0.75'].tampon[0] <= natif.tampon[0] && balayage.lu['0.5'].tampon[0] < natif.tampon[0],
  `natif ${natif.tampon.join('×')} · 0,75× ${balayage.lu['0.75'].tampon.join('×')} · 0,5× ${balayage.lu['0.5'].tampon.join('×')}`,
);
{
  const retombnees = Object.entries(balayage.horsListe)
    .filter(([cle, v]) => Math.abs(v.ratio - Math.min(v.devicePixelRatio, 2)) >= 1e-9);
  check(
    'une netteté hors liste retombe sur le natif, jamais sur le chiffre reçu',
    Object.keys(balayage.horsListe).length === 4 && retombnees.length === 0,
    retombnees.map(([k, v]) => `${k}→${v.ratio}`).join(' ') || 'quatre valeurs refusées',
  );
}

// Le réglage doit survivre au rechargement (il est écrit dans le magasin des réglages).
await page.evaluate(() => window.__mc.reglerNetrete('0.75'));
await page.reload({ waitUntil: 'load' });
await waitForBoot(page);
const relu = await page.evaluate(() => ({
  ...window.__mc.netrete(),
  selecteur: document.getElementById('netrete')?.value ?? null,
  etiquette: document.getElementById('netrete-value')?.textContent ?? null,
}));
check(
  'la netteté choisie survit au rechargement',
  relu.reglage === '0.75' && Math.abs(relu.ratio - Math.min(0.75, relu.devicePixelRatio)) < 1e-9,
  `relu ${relu.reglage} · ratio ${relu.ratio}`,
);
check(
  'le panneau affiche le réglage retenu et son pourcentage',
  relu.selecteur === '0.75' && /0,75×/.test(relu.etiquette || '') && /%/.test(relu.etiquette || ''),
  `selecteur ${relu.selecteur} · étiquette « ${relu.etiquette} »`,
);

// Changer la netteté ne doit rien toucher d'autre : ni le monde, ni ce qui est dessiné.
// Jugé file vide (`streamAll`) — sinon le flot continue d'ajouter des tronçons pendant les
// deux attentes et la comparaison juge le chargement au lieu de juger le réglage (mesuré :
// 100 → 101 tronçons sans que la netteté y soit pour rien).
const intact = await page.evaluate(async () => {
  const mc = window.__mc;
  mc.streamAll();
  const pose = mc.world.pendingChunks === 0;
  mc.rebuildsDepuis();                      // on repart de zéro pour le compte qui suit
  const avant = { troncons: mc.world.chunks.size, maillages: mc.memoire().meshesDessines };
  mc.reglerNetrete('native');
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const apres = { troncons: mc.world.chunks.size, maillages: mc.memoire().meshesDessines };
  mc.reglerNetrete('0.5');
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const bas = { troncons: mc.world.chunks.size, maillages: mc.memoire().meshesDessines };
  const comptes = mc.rebuildsDepuis();
  mc.reglerNetrete('native');
  return { pose, avant, apres, bas, maillesPendant: comptes.mailles };
});
check(
  'la netteté ne repeint pas le monde',
  intact.pose && intact.avant.troncons === intact.bas.troncons
    && intact.avant.maillages === intact.bas.maillages && intact.maillesPendant === 0,
  JSON.stringify(intact),
);

// ---------------------------------------------------------------------------
// 2. Budget du mailleur : la décision, et surtout son exécution
// ---------------------------------------------------------------------------
// À l'équilibre, la formule doit rendre exactement les 10 ms d'avant. Jugé **dans la même
// tâche** qu'une injection du lissage : sous rasteriseur logiciel les images coûtent ~60 ms
// d'office, donc attendre un « équilibre » réel reviendrait à juger l'impossible.
const equilibre = await page.evaluate(() => {
  const mc = window.__mc;
  const c = mc.budgetMaillage();
  mc.reglerDureeImage(c.cible);            // même tâche : `animate` ne peut pas s'intercaler
  return { ...mc.budgetMaillage(), cible: c.cible, fixe: c.fixe };
});
check(
  'à l’équilibre (image à 60 Hz), le budget rendu est celui d’avant : 10 ms',
  Math.abs(equilibre.ms - equilibre.fixe) < 0.01 && equilibre.fixe === 10
    && Math.abs(equilibre.ema - equilibre.cible) < 0.01,
  JSON.stringify(equilibre),
);

/**
 * Ce que le bucle d'images **passe réellement** à `updateChunks`, face à la décision attendue.
 * L'attendu est recalculé ICI depuis les constantes exposées (`fixe + (cible − ema)` borné par
 * min/max) : comparer l'exécution à la fonction du jeu elle-même ne prouverait rien.
 * `forceEMA` tire le lissage vers un régime donné ; chaque observation garde son `ema` réel,
 * car `animate` le ramène de 20 % vers sa propre mesure à chaque tour.
 */
async function ecouterBudget({ forceEMA, frames = 70, netrete }) {
  return page.evaluate(async ({ force, n, nett }) => {
    const mc = window.__mc;
    const w = mc.world;
    if (nett) mc.reglerNetrete(nett);
    // La branche « souris capturée » est celle du jeu : elle appelle le flot à chaque image.
    // La branche hors souris ne l'appelle que si des tronçons restent à naître, et juger sur
    // elle reviendrait à mesurer une fenêtre vide (mesuré : 0 observation après un `streamAll`).
    mc.controls.isLocked = true;
    // Du travail en attente, pour que la tranche serve à quelque chose de visible.
    let sales = 0;
    for (const chunk of w.chunks.values()) {
      if (sales >= 24) break;
      if (chunk.meshes.length) { w.markChunkDirty(chunk.cx, chunk.cz); sales++; }
    }
    const original = w.updateChunks.bind(w);
    const obs = [];
    // Le 4ᵉ argument est l'enveloppe du **relief**, le 7ᵉ celle de la **maille**. C'est la
    // séparation qui empêche une image lente d'affamer la génération : jugé ici sur les deux,
    // car les fusionner redonne un vert trompeur à tout le reste de la suite.
    w.updateChunks = (x, z, maxCells, maxMs, dx, dz, maillageMs) => {
      if (typeof maillageMs === 'number' && Number.isFinite(maillageMs)) {
        const b = mc.budgetMaillage();
        obs.push({
          passe: maillageMs, enveloppeRelief: maxMs, ema: b.ema,
          attendu: Math.max(b.min, Math.min(b.max, b.fixe + (b.cible - b.ema))),
        });
      }
      return original(x, z, maxCells, maxMs, dx, dz, maillageMs);
    };
    let tours = 0;
    await new Promise((res) => {
      const boucle = () => {
        mc.reglerDureeImage(force);
        if (++tours >= n) { res(); return; }
        requestAnimationFrame(boucle);
      };
      requestAnimationFrame(boucle);
    });
    w.updateChunks = original;
    mc.controls.isLocked = false;
    if (nett) mc.reglerNetrete('native');
    const mediane = (a) => {
      const t = [...a].sort((p, q) => p - q);
      return t.length ? t[Math.floor(t.length / 2)] : null;
    };
    const c = mc.budgetMaillage();
    const lents = obs.filter((o) => o.ema > c.cible + 20);
    const rapides = obs.filter((o) => o.ema < c.cible - 2);
    // L'EMA exposé par le jeu est arrondi au dixième, alors que la tranche est calculée sur
    // la valeur brute : la tolérance descend donc à 0,06 ms, pas à zéro. Les écarts qui
    // comptent (tranche figée à 10, signe inversé, bornes sautées) sont d'un tout autre ordre.
    const ecartMax = obs.length ? +Math.max(...obs.map((o) => Math.abs(o.passe - o.attendu))).toFixed(3) : null;
    return {
      ventes: obs.length > 0 && ecartMax <= 0.06,
      ecartMax,
      observations: obs.length,
      etendueEma: obs.length
        ? +(Math.max(...obs.map((o) => o.ema)) - Math.min(...obs.map((o) => o.ema))).toFixed(1) : 0,
      lents: lents.length, medianLente: mediane(lents.map((o) => o.passe)),
      rapides: rapides.length, medianRapide: mediane(rapides.map((o) => o.passe)),
      // L'enveloppe du relief doit ignorer la santé de l'image : sinon une machine lente
      // voit le monde cesser de se poser (défaut trouvé par `tests/settings.mjs` le
      // 2026-11-17, quand les deux passes partageaient la même horloge).
      enveloppes: [...new Set(obs.map((o) => o.enveloppeRelief))],
      budget: c, sales,
    };
  }, { force: forceEMA, n: frames, nett: netrete || null });
}

const lent = await ecouterBudget({ forceEMA: 400 });
const rapide = await ecouterBudget({ forceEMA: 1, netrete: '0.5' });
check(
  'sur chaque image, la tranche reçue par le flot est bien celle que la décision annonce',
  lent.observations + rapide.observations >= 20 && lent.ventes && rapide.ventes,
  `${lent.observations} + ${rapide.observations} images jugées · plus grand écart ${lent.ecartMax}/${rapide.ecartMax} ms`,
);
check(
  'les deux régimes ont vraiment été observés (de part et d’autre de la cible)',
  lent.lents >= 5 && rapide.rapides >= 5,
  `lentes ${lent.lents} · rapides ${rapide.rapides} · étendue d’EMA ${lent.etendueEma} + ${rapide.etendueEma} ms`,
);
check(
  'quand l’image déborde déjà, le mailleur ne prend plus que le plancher',
  lent.lents >= 5 && lent.medianLente === lent.budget.min,
  `médiane ${lent.medianLente} ms · plancher ${lent.budget.min} · cible ${lent.budget.cible}`,
);
check(
  'quand l’image a de la place, le mailleur prend plus que les 10 ms d’avant',
  rapide.rapides >= 5 && rapide.medianRapide > rapide.budget.fixe,
  `médiane ${rapide.medianRapide} ms · ancienne tranche fixe ${rapide.budget.fixe} · plafond ${rapide.budget.max}`,
);
check(
  'le budget reste entre son plancher et son plafond, quelle que soit l’image',
  [lent, rapide].every((e) => (e.medianLente === null || e.medianLente >= e.budget.min - 1e-9)
    && (e.medianRapide === null || e.medianRapide <= e.budget.max + 1e-9)),
  `bornes ${lent.budget.min}–${lent.budget.max} · lentes ${lent.medianLente} · rapides ${rapide.medianRapide}`,
);
check(
  'seule la maille suit la santé de l’image : l’enveloppe du relief reste la tranche fixe',
  [lent, rapide].every((e) => e.observations > 0 && e.enveloppes.length === 1
    && Math.abs(e.enveloppes[0] - e.budget.fixe) < 1e-9),
  `relief ${lent.enveloppes.join('/')} ms (images lentes) · ${rapide.enveloppes.join('/')} ms (rapides) `
  + `· fixe ${lent.budget.fixe} ms`,
);

// Ce que cette fenêtre doit empêcher : que l'adaptativité de la maille se paie sur le relief.
// Mesuré le 2026-11-17 sous rasteriseur logiciel, en imposant le travail (des couronnes jetées)
// et une image tenue pour chère (EMA plaquée à 400 ms), de r=4 à r=8 (~220 tronçons à faire
// naître) : **31,8 s** avec deux enveloppes (deux prises identiques), **47 s** quand la
// génération est renvoyée à l'horloge absolue partagée avec la maille — soit ×1,5. Le seuil de
// 38 s laisse ~19 % d'air au corrigé et ~15 % sous le meilleur cas saboté.
//
// Deux moutures ont été retirées pour cause de décor : `setRenderDistance(32)` derrière un
// `streamAll` trouvait « file encore 0 » (la rétention garde ce qui sort du champ), et un
// rapport de débits entre deux régimes restait vert enveloppes fusionnées — 3,5 naissances/s
// d'un côté comme de l'autre. Un contrôle qui ne tombe pas sous sabotage ne juge rien.
const pose = await page.evaluate(async () => {
  const mc = window.__mc;
  const w = mc.world;
  mc.setRenderDistance(4);
  mc.streamAll();                                   // même point de départ : monde posé
  const pcx = Math.floor(mc.camera.position.x / mc.CHUNK_SIZE);
  const pcz = Math.floor(mc.camera.position.z / mc.CHUNK_SIZE);
  let jetes = 0;
  for (const [cle, c] of [...w.chunks]) {
    if (Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz)) <= 4) continue;
    if (w._toucheParLeJoueur(cle)) continue;        // jamais les tronçons édités par le joueur
    w._jeterMaillages(c);
    w.chunks.delete(cle);
    w.dirtyKeys.delete(cle);
    jetes++;
  }
  mc.controls.isLocked = true;                      // la branche du jeu, appelée à chaque image
  const t0 = performance.now();
  mc.setRenderDistance(8);
  const attendu = w.pendingChunks;
  while (w.pendingChunks > 0 && performance.now() - t0 < 120000) {
    mc.reglerDureeImage(400);                       // machine lente : maille plaquée au plancher
    await new Promise((r) => requestAnimationFrame(r));
  }
  const secondes = +((performance.now() - t0) / 1000).toFixed(1);
  mc.controls.isLocked = false;
  mc.setRenderDistance(4);
  return { secondes, attendu, reste: w.pendingChunks, jetes };
});
check(
  'le monde se pose en un temps borné quand l’image est tenue pour chère',
  pose.attendu >= 180 && pose.reste === 0 && pose.secondes <= 38,
  `${pose.attendu} tronçons à faire naître (${pose.jetes} jetés) posés en ${pose.secondes}s`
  + ` · ${(pose.attendu / Math.max(pose.secondes, 0.001)).toFixed(1)}/s · reste ${pose.reste}`
  + ' · référence : 31,8 s corrigé / 47 s enveloppe unique',
);

// Un budget qui se couperait totalement laisserait le monde inexistant : même sur une image
// tenue pour très chère, le flot doit continuer d'avancer.
const avancement = await page.evaluate(async () => {
  const mc = window.__mc;
  let sales = 0;
  for (const chunk of mc.world.chunks.values()) {
    if (sales >= 40) break;
    if (chunk.meshes.length) { mc.world.markChunkDirty(chunk.cx, chunk.cz); sales++; }
  }
  const avant = mc.world.pendingChunks;
  const t0 = performance.now();
  while (performance.now() - t0 < 2500) {
    mc.reglerDureeImage(400);              // image prétendue très chère, pendant toute la fenêtre
    await new Promise((r) => setTimeout(r, 40));
  }
  return { avant, apres: mc.world.pendingChunks, sales, budget: mc.budgetMaillage() };
});
check(
  'image tenue pour chère : le monde continue malgré tout de se charger',
  avancement.budget.ms > 0 && avancement.apres <= avancement.avant && avancement.sales > 0,
  `file ${avancement.avant} → ${avancement.apres} · budget ${avancement.budget.ms} ms · ${avancement.sales} tronçons salis`,
);

const ignorable = (x) => /favicon|Failed to load resource/i.test(String(x));
check(
  'aucune erreur console pendant la cadence',
  consoleErrors.filter((e) => !ignorable(e)).length === 0,
  consoleErrors.filter((e) => !ignorable(e)).slice(0, 3).join(' | '),
);

await browser.close();
process.exit(summary());
