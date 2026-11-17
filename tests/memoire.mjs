// Juge la rétention de géométrie : ce qui sort du champ doit être gardé sans être
// redessiné, ce qui revient ne doit rien recalculer, et la note totale doit rester sous
// le quota que le navigateur permet. Les chiffres de référence viennent de la sonde du
// 2026-11-16 : 330 Ko de tampons par tronçon, et 2 129 mailleurs repayés pour rien sur
// un demi-tour à r=12 avant ce budget.
// Usage: node tests/memoire.mjs
import { chromium } from 'playwright-core';
import { findChromium, GL_ARGS, isolatedUrl, waitForBoot, makeReporter } from './browser.mjs';

const { check, summary } = makeReporter();

const chrome = findChromium();
const browser = await chromium.launch({
  ...(chrome ? { executablePath: chrome } : {}),
  args: GL_ARGS,
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
const erreurs = [];
page.on('pageerror', (e) => erreurs.push(e.message));

/** Remplit la profondeur courante jusqu'à épuisement de la file. */
const REMPLIR = `(maxCellules) => {
  const mc = window.__mc, w = mc.world, p = mc.camera.position;
  w.updateChunks(p.x, p.z, Infinity, 120000);
  let garde = 0;
  while (w.pendingChunks > 0 && garde++ < 4000) w.updateChunks(p.x, p.z, maxCellules, 120000);
}`;

async function ouvrir() {
  await page.goto(isolatedUrl('http://localhost:8080'), { waitUntil: 'load' });
  await waitForBoot(page, 60000);
  await page.evaluate(() => {
    // Un compteur unique pour toute la suite : il dira ce qui a été recalculé pour rien.
    const w = window.__mc.world;
    const vraie = w.rebuildChunk.bind(w);
    window.__rebatis = 0;
    w.rebuildChunk = (cx, cz) => { window.__rebatis++; return vraie(cx, cz); };
  });
}

const reglages = async (r) => page.evaluate(({ r, code }) => {
  window.__mc.settings.renderDistance = r;
  new Function('maxCellules', `return (${code})(maxCellules)`)(256);
  return window.__mc.memoire();
}, { r, code: REMPLIR });

try {
  await ouvrir();

  // ==================== LA NOTE EST RÉELLE, LE QUOTA EST CADRÉ ====================
  const r4 = await reglages(4);
  const compteDirect = await page.evaluate(() => {
    let n = 0;
    for (const c of window.__mc.world.chunks.values()) {
      for (const m of c.meshes) {
        for (const nom in m.geometry.attributes) n += m.geometry.attributes[nom].array.byteLength;
        if (m.geometry.index) n += m.geometry.index.array.byteLength;
      }
    }
    return n;
  });
  check('la note de tampons suit les géométries réellement allouées',
    r4.octetsMailles > 0 && Math.abs(r4.octetsMailles - compteDirect) <= 4096,
    `${(r4.octetsMailles / 1048576).toFixed(1)} Mo annoncés · ${(compteDirect / 1048576).toFixed(1)} Mo comptés à la main`);
  check('le quota reste entre son plancher et son plafond',
    r4.quota >= 96 * 1024 * 1024 && r4.quota <= 1536 * 1024 * 1024,
    `${(r4.quota / 1048576).toFixed(0)} Mo · exposé par le navigateur=${r4.exposeParLeNavigateur}`);
  check('un tronçon coûte ce que la sonde a mesuré (~330 Ko)',
    r4.octetsMailles / r4.troncons > 150 * 1024 && r4.octetsMailles / r4.troncons < 700 * 1024,
    `${(r4.octetsMailles / r4.troncons / 1024).toFixed(0)} Ko/tronçon sur ${r4.troncons} tronçons`);

  // ==================== DEMI-TOUR : RIEN DOIT ÊTRE RECALCULÉ ====================
  const large = await reglages(8);
  const apresGrandLarge = await page.evaluate(() => window.__rebatis);
  const petit = await reglages(2);
  check('réduire la profondeur décroche les mailleurs de la scène sans les jeter',
    petit.meshesDessines < large.meshesDessines && petit.reserves > 0 && petit.troncons >= large.troncons * 0.9,
    `${petit.meshesDessines} dessinés contre ${large.meshesDessines} · ${petit.reserves} réservés sur ${petit.troncons} en mémoire`);
  check('et la note gardée tient sous le quota',
    petit.octetsMailles <= petit.quota + 400 * 1024,
    `${(petit.octetsMailles / 1048576).toFixed(1)} Mo gardés pour un quota de ${(petit.quota / 1048576).toFixed(0)} Mo`);

  const rebatisPendantRetrait = (await page.evaluate(() => window.__rebatis)) - apresGrandLarge;
  check('pendant le retrait, aucun mailleur ne se relance pour ce que personne ne voit',
    rebatisPendantRetrait === 0, `${rebatisPendantRetrait} reconstruction(s) pendant la réduction`);

  const avantRemontee = await page.evaluate(() => window.__rebatis);
  const revenu = await reglages(8);
  const payeAuRetour = (await page.evaluate(() => window.__rebatis)) - avantRemontee;
  // La comparaison se juge sur ce qui est dessiné, pas sur la taille de la table : les
  // tronçons de marge (au-delà du rayon) ne sont redemandés par personne quand la
  // profondeur remonte, et GARDE_HORS_VUE les a libérés pendant le retrait — 18 d'entre
  // eux sur 321 mesuré ici. Ce qui compte : zéro recalcul et un rendu identique.
  check('au retour à la même profondeur, rien n\'a été remaillé',
    payeAuRetour === 0 && revenu.meshesDessines === large.meshesDessines
      && revenu.troncons >= large.troncons * 0.85,
    `${payeAuRetour} reconstruction(s) (la sonde en mesurait 2 129 avant le budget) · `
    + `${revenu.troncons} tronçons contre ${large.troncons} · ${revenu.meshesDessines} mailleurs dessinés contre ${large.meshesDessines}`);

  // ==================== SOUS PRESSION, L'ÉVICTION JOUE ====================
  await page.evaluate(() => window.__mc.reglerQuotaGeometrie(2 * 1024 * 1024));
  const presse = await reglages(8);
  check('sous un quota minuscule, tout ce qui est hors vue est libéré',
    presse.reserves === 0 && presse.octetsMailles < large.octetsMailles,
    `${presse.reserves} réservé(s) · ${(presse.octetsMailles / 1048576).toFixed(1)} Mo contre ${(large.octetsMailles / 1048576).toFixed(1)} Mo`);
  check('mais ce que le joueur regarde reste dessiné',
    presse.meshesDessines > 0 && presse.troncons >= 60,
    `${presse.meshesDessines} mailleurs dessinés · ${presse.troncons} tronçons en mémoire`);
  await page.evaluate(() => window.__mc.reglerQuotaGeometrie(null));

  // ==================== CE QUI A ÉTÉ SALI HORS CHAMP SE REPEINT AU RETOUR ====================
  const temoin = await page.evaluate(({ code }) => {
    const mc = window.__mc, w = mc.world;
    const p = mc.camera.position;
    const pcx = Math.floor(p.x / mc.CHUNK_SIZE), pcz = Math.floor(p.z / mc.CHUNK_SIZE);
    // Un tronçon qui sera hors vue à r=2 mais dedans à r=8.
    const cx = pcx + 6, cz = pcz + 1;
    const cle = `${cx},${cz}`;
    if (!w.chunks.has(cle)) w.generateChunkData(cx, cz);
    const chunk = w.chunks.get(cle);
    // Une case d'air prise dans la moitié basse, là où le relief est sûr.
    let x = cx * mc.CHUNK_SIZE + 3, z = cz * mc.CHUNK_SIZE + 5, y = 4;
    for (let essai = 0; essai < 60 && w.getBlock(x, y, z) !== mc.BLOCK.AIR; essai++) y++;
    // On réduit : le tronçon passe en réserve.
    mc.settings.renderDistance = 2;
    new Function('maxCellules', `return (${code})(maxCellules)`)(256);
    const reserve = !!w.chunks.get(cle)?.horsVue;
    // On salit pendant l'absence.
    w.setBlock(x, y, z, mc.BLOCK.GOLD);
    const avantRebond = w.modifiedBlocks.has(`${x},${y},${z}`);
    return { cle, x, y, z, reserve, avantRebond, attendu: mc.BLOCK.GOLD };
  }, { code: REMPLIR });
  const apresRebond = await reglages(8);
  const verifTemoin = await page.evaluate((t) => {
    const mc = window.__mc, w = mc.world;
    const chunk = w.chunks.get(t.cle);
    return {
      lu: w.getBlock(t.x, t.y, t.z),
      attendu: t.attendu,
      dessine: !!chunk && chunk.meshes.some((m) => m.parent === mc.scene),
      repeint: !chunk.aRefaire,
    };
  }, temoin);
  check('une modification posée sur un tronçon réservé revient avec lui',
    temoin.reserve === true && temoin.avantRebond === true
      && verifTemoin.lu === verifTemoin.attendu && verifTemoin.dessine === true,
    JSON.stringify({ ...temoin, ...verifTemoin }));
  check('et sa peinture reprise à la remise en vue n\'est pas restée en attente',
    verifTemoin.repeint === true && apresRebond.reserves >= 0,
    `aRefaire encore posé=${!verifTemoin.repeint}`);

  check('aucune erreur de page pendant la sonde de rétention', erreurs.length === 0, erreurs.slice(0, 2).join(' | '));
} finally {
  await browser.close().catch(() => {});
}

process.exit(summary());
