// Juge dans le navigateur le chargement de l'île : la barre de progression, le fichier
// écrit sur le disque, la relecture qui dispense de générer, et les deux promesses qui
// comptent — « rien n'apparaît sous les pieds » et « le diff du joueur passe avant tout ».
//
// Le monde de test prend le plus petit rayon d'île que le jeu accepte (300 cubes, plancher
// de `clampMonde`) pour que la cuisson tienne en secondes ; `?ile=auto` demande le vrai
// chemin, celui du joueur.
//
// Quatre démarrages, parce que ce sont quatre états du disque : rien, un cache arrêté en
// route (le joueur est entré avant la fin), un cache entier, puis une fiche qui a changé.
// Usage: node tests/chargement.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChromium, GL_ARGS, waitForBoot, makeReporter } from './browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAVES_DIR = path.join(ROOT, 'saves');
const { check, summary } = makeReporter();

const slot = `e2e-ile-${process.pid}`;
const fichierMonde = path.join(SAVES_DIR, `${slot}.json`);
const fichierIle = path.join(SAVES_DIR, `${slot}.ile.bin`);
const url = `http://localhost:8080/?world=${slot}&ile=auto`;

// La fiche passe par `clampMonde` avant de servir : le rayon d'île a un plancher à 300
// cubes (et un pas de 50), c'est donc le plus petit monde qui se cuise vite — 1 632
// tronçons, quelques secondes. La péremption se juge en changeant la graine plutôt que
// le rayon : même coût de cuisson, et la clé de fiche est battue tout autant.
const FICHE = {
  ile: true,
  rayonIle: 300,
  graine: 4242,
  foret: 39, desert: 30, mer: 36,
  largeurPlage: 4, hauteurMontagne: 66, immeublesMax: 18,
  densiteVilles: 40, densiteVillages: 40,
  villesPetites: 45, villesMoyennes: 35, villesGrandes: 20,
  largeurCote: 260, profondeurLarge: 14,
};

const chrome = findChromium();
const browser = await chromium.launch({
  ...(chrome ? { executablePath: chrome } : {}),
  args: GL_ARGS,
});
const erreurs = [];

/** Ouvre le jeu avec la fiche donnée en stockage local, et attend que le monde soit prêt. */
async function ouvrir(fiche) {
  const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
  page.on('pageerror', (e) => erreurs.push(e.message));
  await page.addInitScript(({ cle, valeur }) => {
    try { localStorage.setItem(cle, valeur); } catch (e) { /* stockage privé */ }
  }, { cle: `mincraft_monde:${slot}`, valeur: JSON.stringify(fiche) });
  await page.goto(url, { waitUntil: 'load' });
  await waitForBoot(page, 60000);
  return page;
}

/** Guette l'état du cache jusqu'à ce que `juge` le retienne, ou que le délai expire. */
function guetter(page, juge, delaiMs = 60000) {
  return page.evaluate(async ({ code, delai }) => {
    const decide = new Function('e', `return (${code})(e)`);
    const t0 = performance.now();
    let vu = window.__mc.ileEtat();
    while (performance.now() - t0 < delai) {
      vu = window.__mc.ileEtat();
      if (decide(vu)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return vu;
  }, { code: juge.toString(), delai: delaiMs });
}

const poidsDuDisque = () => (fs.existsSync(fichierIle) ? fs.statSync(fichierIle).size : 0);

try {
  for (const f of [fichierMonde, fichierIle]) { try { fs.unlinkSync(f); } catch (e) { /* rien avant */ } }

  // ==================== 1. RIEN SUR LE DISQUE : LA BARRE SE DÉROULE ====================
  const page1 = await ouvrir(FICHE);
  const vus = await page1.evaluate(async () => {
    const phases = new Set();
    const barre = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 25000) {
      const e = window.__mc.ileEtat();
      phases.add(e.phase);
      if (e.phase === 'cuisson') {
        const b = window.__mc.ileBarre();
        if (b) barre.push(b.texte);
        if (e.faits > 20 && barre.length >= 3) break;         // la barre a bien bougé
      }
      if (e.phase === 'pret') break;
      await new Promise((r) => setTimeout(r, 120));
    }
    return { phases: [...phases], barre, startBloque: document.getElementById('start-btn').disabled };
  });
  check('sans cache sur le disque, la fabrication démarre et sa barre avance',
    vus.phases.includes('cuisson') && vus.barre.length >= 3,
    `${vus.phases.join(' → ')} · ${vus.barre.length} repesintes`);
  check('et la barre nomme ce qui se passe, en cubes pas en pourcentages vagues',
    vus.barre.some((t) => /tronçons/.test(t) && /\d+\s*\/\s*\d+/.test(t)),
    vus.barre[0] || 'aucun texte');
  check('pendant la cuisson, le jeu reste verrouillé sur l’écran d’accueil',
    vus.startBloque === true, 'le joueur ne peut entrer avant la fin, sauf « Entrer quand même »');

  await page1.click('#ile-passer');
  const apresPassage = await page1.evaluate(() => ({
    bloque: document.getElementById('start-btn').disabled,
    phase: window.__mc.ileEtat().phase,
  }));
  check('« Entrer quand même » débloque le jeu pendant la cuisson',
    apresPassage.bloque === false, `phase=${apresPassage.phase}`);

  const partiel = await guetter(page1, (e) => !e.cuisson && (e.phase === 'pret' || e.phase === 'incomplete'), 90000);
  const poids1 = poidsDuDisque();
  check('le cache est écrit sur le disque, même si le joueur est entré avant la fin',
    poids1 > 4096 && !!partiel.stats && partiel.stats.troncons > 200 && partiel.attendus > partiel.stats.troncons,
    `${(poids1 / 1024).toFixed(0)} Ko · ${partiel.stats ? partiel.stats.troncons : 0} / ${partiel.attendus} tronçons · codec ${partiel.stats ? partiel.stats.codec : '?'}`);
  await page1.close();

  // ==================== 2. CACHE ARRÊTÉ EN ROUTE : COMPLÉTÉ SANS RETENIR ====================
  const page2 = await ouvrir(FICHE);
  const reprise = await guetter(page2, (e) => e.cache === true && e.complet === false && e.cuisson !== null, 20000);
  check('un cache incomplet est dit tel, et sa complétion démarre',
    reprise.cache === true && reprise.complet === false && reprise.cuisson !== null,
    `phase=${reprise.phase} · ${reprise.stats ? reprise.stats.troncons : 0} / ${reprise.attendus} tronçons`);
  const entreLibre = await page2.evaluate(() => document.getElementById('start-btn').disabled);
  check('et le joueur peut entrer pendant qu’il reste des tronçons à cuire',
    entreLibre === false, 'le bouton d’entrée n’est pas verrouillé par une cuisine de fond');

  const fini = await guetter(page2, (e) => !e.cuisson && e.complet === true, 240000);
  const poids2 = poidsDuDisque();
  check('la complétion finit par couvrir toute l’île et alourdit le fichier',
    fini.complet === true && !fini.cuisson && poids2 > poids1,
    `${fini.stats ? fini.stats.troncons : 0} / ${fini.attendus} tronçons · ${(poids2 / 1024).toFixed(0)} Ko`);
  await page2.close();

  // ==================== 3. CACHE ENTIER : PLUS RIEN N'EST GÉNÉRÉ ====================
  const page3 = await ouvrir(FICHE);
  const relu = await guetter(page3, (e) => e.phase === 'pret' || e.phase === 'cuisson', 30000);
  const bloque3 = await page3.evaluate(() => document.getElementById('start-btn').disabled);
  check('au lancement suivant, l’île entière vient du disque sans régénération',
    relu.phase === 'pret' && relu.cache === true && !relu.cuisson && relu.complet === true && bloque3 === false,
    `${relu.stats ? relu.stats.troncons : 0} tronçons · ${relu.stats ? decrirePoids(relu.stats.octets) : '?'} · bloqué=${bloque3}`);

  // Compteur posé maintenant : c'est lui qui jugera « plus rien n'apparaît sous les pieds ».
  await page3.evaluate(() => {
    const w = window.__mc.world;
    const vraie = w.fabriquerDonnees.bind(w);
    window.__generees = 0;
    w.fabriquerDonnees = (cx, cz) => { window.__generees++; return vraie(cx, cz); };
  });
  const exploration = await page3.evaluate(async () => {
    const mc = window.__mc;
    const w = mc.world;
    const p = mc.camera.position;
    w.updateChunks(p.x, p.z, Infinity, 4000);
    let garde = 0;
    while (w.pendingChunks > 0 && garde++ < 400) w.updateChunks(p.x, p.z, 64, 4000);
    const rayon = mc.settings.renderDistance;
    const pcx = Math.floor(p.x / mc.CHUNK_SIZE), pcz = Math.floor(p.z / mc.CHUNK_SIZE);
    let attendus = 0, absents = 0;
    for (let dz = -rayon; dz <= rayon; dz++)
      for (let dx = -rayon; dx <= rayon; dx++) {
        if (Math.hypot(dx, dz) > rayon) continue;
        attendus++;
        if (!w.chunks.has(`${pcx + dx},${pcz + dz}`)) absents++;
      }
    return { generees: window.__generees, attendus, absents, rayon };
  });
  check('aucun tronçon de la profondeur de champ n’a eu à être généré',
    exploration.generees === 0 && exploration.absents === 0,
    `${exploration.generees} génération(s) pour ${exploration.attendus} tronçons attendus, ${exploration.absents} absent(s) à r=${exploration.rayon}`);

  // Le cache doit rendre exactement ce que la génération aurait rendu.
  const comparaison = await page3.evaluate(async () => {
    const mc = window.__mc;
    const w = mc.world;
    const cache = w.cacheIle;
    if (!cache) return { erreur: 'pas de cache' };
    const p = mc.camera.position;
    const cx0 = Math.floor(p.x / mc.CHUNK_SIZE);
    const cz0 = Math.floor(p.z / mc.CHUNK_SIZE);
    const echantillon = [[0, 0], [3, -2], [-4, 1], [2, 5], [-6, -3], [7, 4]];
    let identiques = 0;
    const detail = [];
    for (const [dx, dz] of echantillon) {
      const cx = cx0 + dx, cz = cz0 + dz;
      const no = cache.trancheDe(cx, cz);
      if (no >= 0) await cache.rechauffer(no);
      const lu = cache.troncon(cx, cz);
      const cru = w.fabriquerDonnees(cx, cz);
      if (lu && lu.length === cru.length) {
        let ecart = 0;
        for (let i = 0; i < cru.length; i++) if (cru[i] !== lu[i]) ecart++;
        if (ecart === 0) identiques++;
        else detail.push(`${cx},${cz}:${ecart}`);
      } else detail.push(`${cx},${cz}:taille`);
    }
    return { identiques, total: echantillon.length, detail };
  });
  check('ce que rend le cache est identique cube par cube à ce que rend le bruit',
    comparaison.identiques === comparaison.total,
    `${comparaison.identiques}/${comparaison.total}${comparaison.detail && comparaison.detail.length ? ` · écarts ${comparaison.detail.slice(0, 3).join(' ')}` : ''}`);

  // Le diff du joueur doit passer au-dessus d'un tronçon venu du cache, y compris après
  // que ce tronçon a été chassé de la mémoire puis relu.
  const modif = await page3.evaluate(() => {
    const mc = window.__mc;
    const w = mc.world;
    const p = mc.camera.position;
    const x = Math.floor(p.x), z = Math.floor(p.z);
    let y = 2;
    for (let essai = 0; essai < 200 && w.isSolid(x, y, z); essai++) y++;
    w.setBlock(x, y, z, mc.BLOCK.STONE);
    const pose = w.getBlock(x, y, z);
    const cx = Math.floor(x / mc.CHUNK_SIZE), cz = Math.floor(z / mc.CHUNK_SIZE);
    const cle = `${cx},${cz}`;
    const chunk = w.chunks.get(cle);
    if (chunk) { for (const m of chunk.meshes) { m.geometry.dispose(); } }
    w.chunks.delete(cle);
    w.dirtyKeys.delete(cle);
    w.generateChunkData(cx, cz);
    return { pose, attendu: mc.BLOCK.STONE, apresRelecture: w.getBlock(x, y, z), diff: w.modifiedBlocks.has(`${x},${y},${z}`) };
  });
  check('une modification du joueur tient sur un tronçon venu du cache',
    modif.pose === modif.attendu, JSON.stringify(modif));
  check('et survit à la chasse du tronçon, parce que le diff se lit à la source',
    modif.apresRelecture === modif.attendu && modif.diff === true,
    `posé=${modif.pose} · relu=${modif.apresRelecture}`);
  await page3.close();

  // ==================== 4. LA FICHE A CHANGÉ : LE CACHE EST PÉRIMÉ ====================
  // Sans le fichier de sauvegarde : sa fiche reprendrait la main sur celle du stockage —
  // c'est voulu, mais ce n'est pas ce que ce contrôle veut juger.
  try { fs.unlinkSync(fichierMonde); } catch (e) { /* déjà parti */ }
  const page4 = await ouvrir({ ...FICHE, graine: FICHE.graine + 1 });
  const perime = await guetter(page4, (e) => e.phase === 'cuisson' || (e.phase === 'pret' && e.cache === true), 20000);
  check('changer la fiche de génération refuse le cache et relance une cuisson',
    perime.phase === 'cuisson' && /fiche|graine/.test(perime.motif || ''),
    `phase=${perime.phase} · motif=${perime.motif || '(aucun)'}`);
  await page4.close();

  check('aucune erreur de page pendant les quatre démarrages', erreurs.length === 0, erreurs.slice(0, 2).join(' | '));
} finally {
  await browser.close().catch(() => {});
  for (const f of [fichierMonde, fichierIle]) { try { fs.unlinkSync(f); } catch (e) { /* déjà parti */ } }
}

function decrirePoids(n) {
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.round(n / 1024)} Ko`;
}

process.exit(summary());
