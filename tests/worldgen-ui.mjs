// Vérifie dans le navigateur l'écran « Génération du monde » de la page d'accueil :
// les curseurs viennent bien de la fiche, la carte est peinte, bouger un curseur change
// les chiffres affichés, et le bouton « nouveau monde » engage la fiche jusqu'au relief
// réellement généré — c'est ce dernier bout qui prouve que l'écran n'est pas décoratif.
// Usage: node tests/worldgen-ui.mjs [url]
// Nécessite le serveur statique (npm start / node server.js).
import { openGame, waitForBoot, isolatedUrl, makeReporter } from './browser.mjs';

const URL = process.argv[2] || 'http://localhost:8080';
const { check, summary } = makeReporter();
const { browser, page, consoleErrors, badResponses } = await openGame(URL);

const ignorable = (x) => /favicon|Failed to load resource/i.test(String(x));

// ------------------------------------------- l'accueil : une entrée, pas le panneau
// L'écran de réglage a quitté l'écran d'accueil pour occuper toute la fenêtre. Ce qui
// reste ici ne doit donc ni être le panneau lui-même, ni menacer le bouton « jouer ».
const accueil = await page.evaluate(() => {
  const mc = window.__mc;
  const bouton = document.getElementById('start-btn');
  bouton.scrollIntoView({ block: 'center' });
  const r = bouton.getBoundingClientRect();
  const dessus = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const rendu = {
    entree: !!document.getElementById('worldgen-open'),
    ecranCache: document.getElementById('worldgen-screen').hidden,
    panneauDansAccueil: !!document.querySelector('#blocker #worldgen-fields'),
    resume: document.getElementById('worldgen-resume').textContent.replace(/\s+/g, ' ').trim(),
    boutonAtteignable: r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight
      && !!dessus && dessus.id === 'start-btn',
    defauts: mc.MONDE_DEFAULTS,
    reglee: mc.ficheReglee(),
  };
  document.getElementById('blocker').scrollTop = 0;
  return rendu;
});
check('l\'accueil offre l\'écran de génération sans porter le panneau',
  accueil.entree && accueil.ecranCache && !accueil.panneauDansAccueil,
  `entrée=${accueil.entree} caché=${accueil.ecranCache} panneau dans l'accueil=${accueil.panneauDansAccueil}`);
check('le bouton « jouer » reste atteignable sur l\'accueil', accueil.boutonAtteignable);
check('l\'écran s\'ouvre sur la fiche par défaut',
  JSON.stringify(accueil.reglee) === JSON.stringify(accueil.defauts),
  JSON.stringify(accueil.reglee));
check('l\'accueil porte le résumé de la fiche en jeu',
  /Génération du monde en jeu/.test(accueil.resume) && /graine 42/.test(accueil.resume),
  accueil.resume);

// --------------------------------------------------- l'écran plein écran, rendu éteint
// Contre-témoin du contrôle suivant : tant que l'écran est fermé, le monde doit bien
// avancer — sinon « le rendu est suspendu » passerait aussi quand rien n'est suspendu.
// Le pouls se prend une fois le flot de démarrage écoulé : pendant l'égouttage initial,
// une seule image peut dépasser la fenêtre sous le rasteriseur logiciel des tests, et le
// contrôle jugerait l'encombrement au lieu de juger la suspension.
const pouls = await page.evaluate(async () => {
  const mc = window.__mc;
  let garde = 0;
  do { mc.world.updateChunks(mc.camera.position.x, mc.camera.position.z, 64); }
  while (mc.world.pendingChunks > 0 && garde++ < 500);
  const a = mc.framesRendues();
  await new Promise((r) => setTimeout(r, 600));
  return { a, b: mc.framesRendues(), enAttente: mc.world.pendingChunks };
});
check('le monde est rendu tant que l\'écran de réglage est fermé',
  pouls.b > pouls.a, `${pouls.a} → ${pouls.b} images en 600 ms · file ${pouls.enAttente}`);

await page.click('#worldgen-open');

const pleinEcran = await page.evaluate(async () => {
  const mc = window.__mc;
  const ecran = document.getElementById('worldgen-screen');
  const r = ecran.getBoundingClientRect();
  const carte = mc.carteDuMonde();
  const ctx = carte.getContext('2d');
  const donnees = ctx.getImageData(0, 0, carte.width, carte.height).data;
  const nuances = new Set();
  for (let i = 0; i < donnees.length; i += 4 * 53) nuances.add(`${donnees[i]},${donnees[i + 1]},${donnees[i + 2]}`);
  const centre = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  const avant = mc.framesRendues();
  await new Promise((resolve) => setTimeout(resolve, 700));
  const apres = mc.framesRendues();
  return {
    ouvert: !ecran.hidden && mc.reglageOuvert(),
    couvreLaFenetre: Math.abs(r.left) < 1 && Math.abs(r.top) < 1
      && Math.abs(r.width - window.innerWidth) <= 2
      && Math.abs(r.height - window.innerHeight) <= 2,
    auDessusDeTout: !!centre && !!centre.closest('#worldgen-screen'),
    rangees: document.querySelectorAll('#worldgen-fields .worldgen-row').length,
    champs: mc.MONDE_FIELDS.length,
    nuances: nuances.size,
    coteCarte: Math.round(carte.getBoundingClientRect().width),
    fenetre: window.innerWidth,
    stats: [...document.querySelectorAll('#worldgen-readout .worldgen-stat')]
      .map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
    imagesPendantOuverture: apres - avant,
  };
});
check('l\'écran de génération occupe toute la fenêtre',
  pleinEcran.ouvert && pleinEcran.couvreLaFenetre && pleinEcran.auDessusDeTout,
  JSON.stringify({ couvre: pleinEcran.couvreLaFenetre, dessus: pleinEcran.auDessusDeTout }));
check('le rendu 3D est suspendu pendant le réglage',
  pleinEcran.imagesPendantOuverture === 0,
  `${pleinEcran.imagesPendantOuverture} image(s) rendue(s) en 700 ms écran ouvert`);
check('la carte prend la place disponible et reste carrée',
  pleinEcran.coteCarte > pleinEcran.fenetre * 0.4,
  `côté ${pleinEcran.coteCarte} px pour une fenêtre de ${pleinEcran.fenetre} px`);
check('un curseur par ligne de la fiche', pleinEcran.rangees === pleinEcran.champs,
  `${pleinEcran.rangees} rangées pour ${pleinEcran.champs} champs`);
check('la carte est peinte et polychrome', pleinEcran.nuances >= 5, `${pleinEcran.nuances} nuances`);
check('les chiffres affichés portent la valeur visée et la valeur mesurée',
  pleinEcran.stats.some((s) => /Forêt/.test(s) && /visé/.test(s))
  && pleinEcran.stats.some((s) => /Mer/.test(s)), pleinEcran.stats.slice(0, 3).join(' | '));
// Le sable de la grève n'est pas gouverné par le curseur « Désert » : l'écran doit le
// dire, sinon un désert à zéro affiche un monde sans sable que le joueur ne voit pas.
check('l\'écran affiche aussi la part de sable au sol (grève comprise)',
  pleinEcran.stats.some((s) => /Sable au sol/.test(s) && /grève/.test(s)),
  pleinEcran.stats.filter((s) => /Sable/.test(s)).join(' | '));

// Le clavier appartient à l'écran : une touche de déplacement ne doit pas passer au jeu.
const clavier = await page.evaluate(async () => {
  const mc = window.__mc;
  document.getElementById('worldgen-close').focus();
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', bubbles: true }));
  const pendant = !!mc.keys.KeyZ;
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyZ', bubbles: true }));
  return { pendant, ferme: mc.reglageOuvert() };
});
check('une touche de déplacement n\'atteint pas le joueur pendant le réglage',
  !clavier.pendant && clavier.ferme, JSON.stringify(clavier));

// Échap referme ; et le monde doit se remettre à tourner derrière l'accueil rendu.
const apresEchap = await page.evaluate(async () => {
  const mc = window.__mc;
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
  const ferme = document.getElementById('worldgen-screen').hidden && !mc.reglageOuvert();
  const a = mc.framesRendues();
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { ferme, images: mc.framesRendues() - a };
});
check('Échap referme l\'écran et le rendu reprend',
  apresEchap.ferme && apresEchap.images > 0, JSON.stringify(apresEchap));
await page.click('#worldgen-open');
const rouvert = await page.evaluate(() => ({
  ouvert: window.__mc.reglageOuvert(),
  resume: document.getElementById('worldgen-resume').textContent.replace(/\s+/g, ' ').trim(),
}));
check('l\'écran se rouvre après fermeture', rouvert.ouvert, rouvert.resume);

// ------------------------------------------------------- bouger un curseur se voit
const apresForet = await page.evaluate(async () => {
  const mc = window.__mc;
  const avant = document.querySelector('#worldgen-readout .worldgen-stat:nth-child(2)').textContent.replace(/\s+/g, ' ').trim();
  const entree = document.getElementById('worldgen-foret');
  entree.value = '15';
  entree.dispatchEvent(new Event('input', { bubbles: true }));
  const libelle = document.querySelector(`label[for="worldgen-foret"]`).parentElement.querySelector('output').textContent;
  // La carte se repeint après le délai du curseur : on attend que la ligne change.
  await new Promise((resolve) => {
    const t0 = Date.now();
    (function attendre() {
      const apres = document.querySelector('#worldgen-readout .worldgen-stat:nth-child(2)').textContent.replace(/\s+/g, ' ').trim();
      if (apres !== avant || Date.now() - t0 > 6000) resolve();
      else setTimeout(attendre, 80);
    })();
  });
  const apres = document.querySelector('#worldgen-readout .worldgen-stat:nth-child(2)').textContent.replace(/\s+/g, ' ').trim();
  return { avant, apres, libelle, vise: mc.ficheReglee().foret };
});
check('descendre le curseur de forêt change le chiffre mesuré',
  /15 %/.test(apresForet.libelle) && apresForet.vise === 15
  && apresForet.avant !== apresForet.apres,
  `${apresForet.avant} → ${apresForet.apres}`);

// La grève a son propre levier, et c'est celui que le joueur réclamait : éteindre le
// désert laisse la plage debout, donc sans prise sur elle l'écran ne ferait que constater.
const apresPlage = await page.evaluate(async () => {
  const mc = window.__mc;
  const ligneSable = () => [...document.querySelectorAll('#worldgen-readout .worldgen-stat')]
    .find((n) => /Sable au sol/.test(n.textContent)).textContent.replace(/\s+/g, ' ').trim();
  const avant = ligneSable();
  const entree = document.getElementById('worldgen-largeurPlage');
  const portee = { min: Number(entree.min), max: Number(entree.max) };
  entree.value = String(portee.min);
  entree.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => {
    const t0 = Date.now();
    (function attendre() {
      if (ligneSable() !== avant || Date.now() - t0 > 6000) resolve();
      else setTimeout(attendre, 80);
    })();
  });
  return {
    avant, apres: ligneSable(), portee,
    reglee: mc.ficheReglee().largeurPlage,
    defaut: mc.MONDE_DEFAULTS.largeurPlage,
  };
});
check('le curseur de plage fait reculer la grève jusqu\'à la mer',
  apresPlage.portee.min === 0 && apresPlage.defaut === apresPlage.portee.max
  && apresPlage.reglee === 0 && apresPlage.avant !== apresPlage.apres
  && /dont grève 0\.0 %/.test(apresPlage.apres),
  `${apresPlage.avant} → ${apresPlage.apres} (portée ${apresPlage.portee.min}…${apresPlage.portee.max})`);

const horsIle = await page.evaluate(() => {
  const caseIle = document.getElementById('worldgen-ile');
  caseIle.checked = false;
  caseIle.dispatchEvent(new Event('input', { bubbles: true }));
  const rayon = document.getElementById('worldgen-rayonIle');
  const grise = rayon.disabled && rayon.closest('.worldgen-row').classList.contains('hors-service');
  caseIle.checked = true;
  caseIle.dispatchEvent(new Event('input', { bubbles: true }));
  return { grise, reactive: !rayon.disabled };
});
check('hors mode île, les réglages du bord se grisent et se réactivent',
  horsIle.grise && horsIle.reactive, JSON.stringify(horsIle));

// Les proportions des trois types de ville — demandé le 2026-11-11 : « pouvoir choisir la
// proportion de type de ville dans l'ecran de parametrage des mondes ». Trois curseurs ne
// suffisent pas à le prouver : il faut qu'un geste sur l'un d'eux change ce que la légende
// promet, sinon le curseur serait décoratif.
{
  const apresTypes = await page.evaluate(async () => {
    const mc = window.__mc;
    const lire = (motif) => {
      const n = [...document.querySelectorAll('#worldgen-readout .worldgen-stat')]
        .find((e) => e.textContent.includes(motif));
      return n ? n.textContent.replace(/\s+/g, ' ').trim() : null;
    };
    const CLES = ['villesPetites', 'villesMoyennes', 'villesGrandes'];
    const entrees = CLES.map((k) => {
      const e = document.getElementById(`worldgen-${k}`);
      return e ? { cle: k, min: Number(e.min), max: Number(e.max), valeur: Number(e.value) } : null;
    });
    const avant = { parts: lire('Petites / moyennes'), agglo: lire('Plus grande agglomération') };
    for (const k of CLES) {
      const e = document.getElementById(`worldgen-${k}`);
      e.value = k === 'villesPetites' ? String(e.max) : '0';
      e.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await new Promise((resolve) => {
      const t0 = Date.now();
      (function attendre() {
        if (lire('Plus grande agglomération') !== avant.agglo || Date.now() - t0 > 8000) resolve();
        else setTimeout(attendre, 80);
      })();
    });
    const apres = { parts: lire('Petites / moyennes'), agglo: lire('Plus grande agglomération') };
    const reglee = mc.ficheReglee();
    document.getElementById('worldgen-reset').click();
    await new Promise((r) => setTimeout(r, 500));
    const restauree = mc.ficheReglee();
    return {
      avant, apres, entrees,
      reglee: { villesPetites: reglee.villesPetites, villesMoyennes: reglee.villesMoyennes,
        villesGrandes: reglee.villesGrandes },
      restauree: { villesPetites: restauree.villesPetites, villesMoyennes: restauree.villesMoyennes,
        villesGrandes: restauree.villesGrandes },
      defauts: mc.MONDE_DEFAULTS,
    };
  });
  const defautTypes = {
    villesPetites: apresTypes.defauts.villesPetites,
    villesMoyennes: apresTypes.defauts.villesMoyennes,
    villesGrandes: apresTypes.defauts.villesGrandes,
  };
  check('l\'écran expose les trois curseurs de proportions de villes',
    apresTypes.entrees.every(Boolean)
    && apresTypes.entrees.every((e) => e.min === 0 && e.max === 100)
    && apresTypes.entrees.every((e) => e.valeur === apresTypes.defauts[e.cle]),
    JSON.stringify(apresTypes.entrees));
  check('les curseurs agissent sur la fiche et « Valeurs par défaut » les rétablit',
    JSON.stringify(apresTypes.reglee) !== JSON.stringify(defautTypes)
    && JSON.stringify(apresTypes.reglee) === JSON.stringify({ villesPetites: 100, villesMoyennes: 0, villesGrandes: 0 })
    && JSON.stringify(apresTypes.restauree) === JSON.stringify(defautTypes),
    `${JSON.stringify(apresTypes.reglee)} → ${JSON.stringify(apresTypes.restauree)}`);
  check('éteindre les grandes villes abaisse ce que l\'écran annonce',
    apresTypes.avant.agglo !== apresTypes.apres.agglo
    && /rayon 96 cubes/.test(apresTypes.apres.agglo)
    && /6 étages/.test(apresTypes.apres.agglo),
    `${apresTypes.avant.agglo} → ${apresTypes.apres.agglo}`);
  check('la légende répartit les villes entre les trois types',
    /\d+ \/ \d+ \/ \d+/.test(apresTypes.apres.parts)
    && apresTypes.avant.parts !== apresTypes.apres.parts,
    `${apresTypes.avant.parts} → ${apresTypes.apres.parts}`);
}

const apresDefaut = await page.evaluate(async () => {
  document.getElementById('worldgen-reset').click();
  await new Promise((r) => setTimeout(r, 400));
  const mc = window.__mc;
  return {
    reglee: mc.ficheReglee(),
    defauts: mc.MONDE_DEFAULTS,
    libelle: document.querySelector('label[for="worldgen-foret"]').parentElement.querySelector('output').textContent,
  };
});
check('« Valeurs par défaut » ramène la fiche du monde d\'aujourd\'hui',
  JSON.stringify(apresDefaut.reglee) === JSON.stringify(apresDefaut.defauts)
  && new RegExp(String(apresDefaut.defauts.foret)).test(apresDefaut.libelle),
  `${apresDefaut.libelle}`);

// ----------------------------------------------- la fiche engagée devient le relief
const NOM = `Île testée ${process.pid}`;
const cible = { ile: true, rayonIle: 700, largeurCote: 160, profondeurLarge: 16, graine: 99,
  foret: 55, desert: 10, mer: 25, villesPetites: 10, villesMoyennes: 20, villesGrandes: 70 };
const slotAvant = await page.evaluate(() => window.__mc.SAVE_SLOT);
// Le nom se saisit dans l'écran de réglage : celui de l'accueil est derrière lui.
await page.fill('#worldgen-name', NOM);
await page.evaluate((fiche) => window.__mc.reglerFiche(fiche), cible);
const navigation = page.waitForURL((u) => u.searchParams.get('world') !== slotAvant, { timeout: 30000 });
await page.click('#worldgen-new');
let urlApresCreation = null;
try {
  await navigation;
  urlApresCreation = page.url();
} catch (e) {
  urlApresCreation = null;
}

check('« Nouveau monde avec ces réglages » navigue vers un monde neuf',
  !!urlApresCreation && /world=/.test(urlApresCreation), String(urlApresCreation));
await waitForBoot(page, 30000);

const nouveau = await page.evaluate(() => {
  const mc = window.__mc;
  let dernierSec = 0;
  for (let r = 0; r <= 1400; r += 25) {
    if (mc.getTerrainHeight(r, 0) > mc.waterTopAt(r, 0)) dernierSec = r;
  }
  const larges = [900, 1100, 1500].map((r) => mc.getTerrainHeight(r, 0));
  return {
    monde: mc.monde,
    slot: mc.SAVE_SLOT,
    nom: mc.worldName(),
    dernierSec,
    larges,
    mer: mc.SEA_LEVEL,
    pieds: mc.feetY(),
  };
});
check('le monde créé porte la fiche réglée à l\'écran',
  nouveau.monde.rayonIle === cible.rayonIle && nouveau.monde.graine === cible.graine
  && nouveau.monde.foret === cible.foret && nouveau.monde.largeurCote === cible.largeurCote
  && nouveau.monde.villesGrandes === cible.villesGrandes
  && nouveau.monde.villesPetites === cible.villesPetites,
  JSON.stringify(nouveau.monde));
check('le nom saisi a suivi le nouveau monde', nouveau.nom === NOM, String(nouveau.nom));
check('le relief de ce monde s\'arrête bien à son rayon',
  nouveau.dernierSec > 300 && nouveau.dernierSec <= nouveau.monde.rayonIle,
  `dernière colonne sèche à ${nouveau.dernierSec} pour un rayon de ${nouveau.monde.rayonIle}`);
check('au large de ce monde, une eau unique et profonde à perte de vue',
  new Set(nouveau.larges).size === 1 && nouveau.larges[0] <= nouveau.mer - 10,
  JSON.stringify(nouveau.larges));
check('l\'apparition y est au sec', nouveau.pieds > nouveau.mer, `pieds ${nouveau.pieds}`);

// La fiche doit survivre au disque : le fichier ne porte que le diff du joueur, donc
// sans elle le monde se régénérerait sur les constantes par défaut.
const apresRechargement = await page.evaluate(async () => {
  const mc = window.__mc;
  mc.setBlock(Math.round(mc.camera.position.x), Math.round(mc.camera.position.y) + 2, Math.round(mc.camera.position.z), mc.BLOCK.GOLD);
  await mc.flushSave();
  const res = await fetch(`/world-save?slot=${encodeURIComponent(mc.SAVE_SLOT)}`, { cache: 'no-store' });
  const brut = await res.json().catch(() => null);
  return { dansLeFichier: brut && brut.monde ? brut.monde.rayonIle : null };
});
check('la fiche est écrite dans le fichier de sauvegarde',
  apresRechargement.dansLeFichier === cible.rayonIle,
  `fichier: ${apresRechargement.dansLeFichier}`);

await page.reload({ waitUntil: 'load' });
await waitForBoot(page, 30000);
const aprRes = await page.evaluate(() => ({
  monde: window.__mc.monde,
  blocPose: window.__mc.world.modifiedBlocks.size,
}));
check('après rechargement, le monde garde sa fiche et les blocs du joueur',
  aprRes.monde.rayonIle === cible.rayonIle && aprRes.blocPose >= 1,
  JSON.stringify(aprRes));

// ------------------------------------------- le bouton « Régénérer ce monde »
// C'est le geste du joueur qui vient de bouger un curseur. Il doit engager la fiche
// jusqu'au relief réellement généré — pas seulement la mémoire locale : sans ce bout,
// un monde réglé mais jamais appliqué continuerait d'afficher l'ancien.
const avantRegen = await page.evaluate(() => {
  const mc = window.__mc;
  mc.ouvrirReglage();
  mc.reglerFiche({ desert: 0 });
  return { reglee: mc.ficheReglee().desert };
});
await page.click('#worldgen-apply');   // premier clic : avertit
await page.click('#worldgen-apply');   // second : engage la régénération
try {
  await page.waitForTimeout(1500);     // la page se recharge sous le clic
} catch (e) { /* navigation en cours */ }
await waitForBoot(page, 40000);
const apresRegen = await page.evaluate(() => {
  const mc = window.__mc;
  let sec = 0, desert = 0;
  for (let x = -500; x <= 500; x += 11) {
    for (let z = -500; z <= 500; z += 11) {
      if (Math.hypot(x, z) > 500) continue;
      if (mc.getTerrainHeight(x, z) <= mc.waterTopAt(x, z)) continue;
      sec++;
      if (mc.biomeAt(x, z) === 'desert') desert++;
    }
  }
  return { desert: mc.monde.desert, part: 100 * desert / Math.max(1, sec), sec };
});
check('« Régénérer ce monde » engage la fiche jusqu\'au relief (désert à zéro)',
  avantRegen.reglee === 0 && apresRegen.desert === 0 && apresRegen.part < 1,
  `fiche ${apresRegen.desert} · zone désert rendue ${apresRegen.part.toFixed(1)} %`
  + ` sur ${apresRegen.sec} colonnes`);

check('aucune erreur console', consoleErrors.filter((e) => !ignorable(e)).length === 0,
  consoleErrors.filter((e) => !ignorable(e)).slice(0, 3).join(' | '));
check('aucune réponse 4xx/5xx', badResponses.length === 0, badResponses.slice(0, 3).join(' | '));

await browser.close();
process.exit(summary() > 0 ? 1 : 0);
