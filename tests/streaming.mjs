// Le flot du monde — ce qui se charge en premier quand le joueur avance, et le prix
// payé par image. La suite juge trois choses que l'œil seul ne juge pas :
//
//  - **l'ordre de visite** (`offsetsFor`) : droit devant passe avant derrière, sans
//    rien perdre de ce qui doit finir chargé ;
//  - **la convergence** : posé quelque part, le monde se remplit entièrement — contrat
//    que `settings.mjs` attend de `pendingChunks === 0` et que `eau.mjs` attend d'un
//    drainage sans génération ;
//  - **le budget d'image** : la tranche de maillage est partagée entre les deux passes
//    du flot, sinon chaque image déborde (mesuré 14,5 ms pour 10 demandés le 2026-11-15,
//    56 i/s tombées à 43).
//
// Usage: node tests/streaming.mjs [url]
// Nécessite le serveur statique (npm start / node server.js).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openGame, waitForBoot, makeReporter } from './browser.mjs';

const URL = process.argv[2] || 'http://localhost:8080';
const { check, summary } = makeReporter();

const { browser, page, consoleErrors } = await openGame(URL);
await waitForBoot(page);

// Un monde isolé : on juge un coin vierge, loin de l'apparition, pour que rien n'y ait
// été chargé d'avance. Tout se passe dans un seul `page.evaluate` sans `await` : ainsi
// `animate()` ne peut pas s'intercaler entre la préparation et la mesure.
const r = await page.evaluate(() => {
  const mc = window.__mc;
  const W = Object.getPrototypeOf(mc.world);
  const CS = mc.CHUNK_SIZE;
  const rayon = 8;
  const X = 6000, Z = 6000;                 // coin vierge, très loin de l'apparition
  const pcx = Math.floor(X / CS), pcz = Math.floor(Z / CS);

  mc.image(true);
  mc.camera.position.set(X, 40, Z);
  // La profondeur se règle par le geste du joueur : la brume suit le rayon, et la frontière
  // de ce qui a droit à une maille juge le même disque que l'image. Écrire
  // `settings.renderDistance` à la main laisserait la brume aux valeurs d'avant — le flot
  // se jugerait alors sur un champ que rien ne rend (mesuré le 2026-11-18).
  mc.setRenderDistance(rayon);

  // --- ordre de visite ----------------------------------------------------
  const adossant = W.offsetsFor.call(mc.world, rayon, 1, 0);
  // Jugée tout de suite, avant toute autre orientation : la table tient en un seul
  // emplacement, donc l'appeler avec un autre cap la jetterait et la comparaison
  // n'aurait plus de sens.
  const reutilisee = W.offsetsFor.call(mc.world, rayon, 1, 0);
  const neutre = W.offsetsFor.call(mc.world, rayon, 0, 0);
  const cle = (t) => t.map(([dx, dz]) => `${dx},${dz}`).sort().join('|');
  const rangDe = (t, dx, dz) => t.findIndex(([a, b]) => a === dx && b === dz);

  const avant = [], derriere = [];
  for (let i = 0; i < adossant.length; i++) {
    const [dx, dz] = adossant[i];
    if (dx > 0) avant.push(i); else if (dx < 0) derriere.push(i);
  }
  const moyenne = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);

  const ordre = {
    exhaustif: adossant.length === (2 * rayon + 1) ** 2 && neutre.length === adossant.length,
    meme_jeu: cle(adossant) === cle(neutre),
    devant_avant: rangDe(adossant, rayon, 0) < rangDe(adossant, -rayon, 0),
    centre_en_premer: adossant[0][0] === 0 && adossant[0][1] === 0,
    cache_identique: reutilisee === adossant,
    cache_rajeuni: neutre !== adossant,
    rang_moyen_devant: +moyenne(avant).toFixed(1),
    rang_moyen_derriere: +moyenne(derriere).toFixed(1),
  };

  // --- débit orienté, à l'horloge hors jeu --------------------------------
  // `maxMs = Infinity` : seule l'ordre de visite tranche, la mesure est reproductible.
  const N = 24;
  const faits = mc.world.updateChunks(X, Z, N, Infinity, 1, 0);
  let nesDevant = 0, nesDerriere = 0, nesTotal = 0;
  for (const c of mc.world.chunks.values()) {
    const dx = c.cx - pcx, dz = c.cz - pcz;
    if (Math.max(Math.abs(dx), Math.abs(dz)) > rayon) continue;
    nesTotal++;
    if (dx > 0) nesDevant++; else if (dx < 0) nesDerriere++;
  }

  // --- convergence --------------------------------------------------------
  let garde = 0;
  do { mc.world.updateChunks(X, Z, 64); } while (mc.world.pendingChunks > 0 && garde++ < 500);
  let manquants = 0, sansMaillage = 0, enPlace = 0;
  for (let dx = -rayon; dx <= rayon; dx++) {
    for (let dz = -rayon; dz <= rayon; dz++) {
      if (dx * dx + dz * dz > rayon * rayon) continue;
      const c = mc.world.chunks.get(`${pcx + dx},${pcz + dz}`);
      if (!c) { manquants++; continue; }
      enPlace++;
      if (c.meshes.length === 0) sansMaillage++;
    }
  }
  const apresDrain = (() => {
    // Contrat de `eau.mjs` : drainer la file de remaillage sans rien générer.
    mc.world.updateChunks(X, Z, 0, 8000);
    return mc.world.pendingChunks;
  })();

  // --- budget d'image -----------------------------------------------------
  // On salit volontairement une grande surface, puis on laisse une seule image faire
  // son possible avec 20 ms. Si les deux passes du maillage consommaient chacune leur
  // tranche, on mesurerait le double.
  const maille = (cx, cz) => {
    const c = mc.world.chunks.get(`${cx},${cz}`);
    return !!c && c.meshes.length > 0;
  };
  for (let dx = -rayon; dx <= rayon; dx++) {
    for (let dz = -rayon; dz <= rayon; dz++) mc.world.markChunkDirty(pcx + dx, pcz + dz);
  }
  const t0 = performance.now();
  mc.world.updateChunks(X, Z, 0, 20, 1, 0);
  const coutImage = performance.now() - t0;

  // Coût d'un seul maillage — le plus lent de trois, pour que la borne rendue avec la
  // machine plutôt qu'arbitraire : sous un logiciel de rastérisation, ce coût triple.
  let uneCote = 0;
  for (const [dx, dz] of [[0, 0], [1, 0], [0, 1]]) {
    const t = performance.now();
    mc.world.rebuildChunk(pcx + dx, pcz + dz);
    uneCote = Math.max(uneCote, performance.now() - t);
  }

  mc.setRenderDistance(mc.DEFAULT_RENDER_DISTANCE);
  return {
    ordre, N, nesDevant, nesDerriere, nesTotal,
    gardes: garde, manquants, sansMaillage, enPlace, apresDrain,
    coutImage: +coutImage.toFixed(1), uneCote: +uneCote.toFixed(1),
    mailleAuCentre: maille(pcx, pcz),
    budget: mc.CHUNK_FRAME_MS,
  };
});

check(
  "l'ordre de visite couvre tout le champ rendu",
  r.ordre.exhaustif,
  `${r.ordre.exhaustif ? '' : 'table incomplète'}`,
);
check(
  "orienter le tri n'oublie ni ne duplique aucun tronçon",
  r.ordre.meme_jeu,
);
check(
  'droit devant se charge avant droit derrière',
  r.ordre.devant_avant,
  `rang moyen devant ${r.ordre.rang_moyen_devant} · derrière ${r.ordre.rang_moyen_derriere}`,
);
check('le tronçon sous le joueur passe en premier', r.ordre.centre_en_premer);
check(
  "la table est gardée en mémoire tant que le regard ne tourne pas d'un cran",
  r.ordre.cache_identique && r.ordre.cache_rajeuni,
  `identique ${r.ordre.cache_identique} · rajeunie au nouveau cap ${r.ordre.cache_rajeuni}`,
);

check(
  'à budget d’horloge hors jeu, les premiers tronçons naissent devant le joueur',
  r.nesDevant >= r.nesDerriere * 2 && r.nesTotal > 0,
  `${r.nesDevant} devant · ${r.nesDerriere} derrière sur ${r.nesTotal} (${r.N} demandés)`,
);

check(
  'posé quelque part, le joueur est entièrement entouré de monde',
  r.manquants === 0 && r.enPlace > 0,
  `${r.enPlace} tronçons en place · ${r.manquants} manquant(s) · drainé en ${r.gardes} passes`,
);
check(
  'chacun de ces tronçons est bien maillé, pas seulement généré',
  r.sansMaillage === 0 && r.mailleAuCentre,
  `${r.sansMaillage} sans maillage`,
);
check('la file se vide : pendingChunks retombe à zéro', r.apresDrain === 0, `${r.apresDrain} restant`);

check(
  'la tranche de maillage est bien partagée entre les deux passes du flot',
  r.coutImage <= 20 * 0.6 + r.uneCote + 4,
  `seule image avec 20 ms d'enveloppe : ${r.coutImage} ms mesurés · 60 % réservés au maillage, un maillage vaut ${r.uneCote} ms`,
);

// Même filtre que les autres suites : le 404 du fichier de sauvegarde d'un monde neuf
// et le favicon absent ne sont pas des fautes du jeu.
const ignorable = (x) => /favicon|Failed to load resource/i.test(String(x));
check(
  'aucune erreur console pendant le flot',
  consoleErrors.filter((e) => !ignorable(e)).length === 0,
  consoleErrors.filter((e) => !ignorable(e)).slice(0, 3).join(' | '),
);

await browser.close();
process.exit(summary());
