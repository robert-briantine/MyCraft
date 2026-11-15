// Vérifie les périodes de pluie : le modèle pur des épisodes (rythme, rampes, intensité,
// régimes), ce qu'une averse change au ciel — gris, lumière basse, nuages épais, brume
// serrée — et le rideau de gouttes que le navigateur dessine vraiment, y compris sous un
// toit. Le rythme et l'intensité se jugent hors navigateur (`meteo.js` ne rend rien) ; la
// peinture se juge à l'image, comme le reste du ciel.
// Usage: node tests/pluie.mjs [url]
// Nécessite le serveur statique (npm start / node server.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openGame, waitForBoot, makeReporter } from './browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = process.argv[2] || 'http://localhost:8080';
const SHOTS = process.env.SHOT_DIR || '.qwen/tmp/mc-shots';

const { check, summary } = makeReporter();

// `meteo.js` importe `melangeCouleur` depuis `ciel.js` : on copie les deux dans un dossier
// témoin marqué ESM, sinon le lien relatif casse et la suite jugerait un autre module.
const BAC = path.join(os.tmpdir(), `mc-pluie-${process.pid}`);
fs.rmSync(BAC, { recursive: true, force: true });
fs.mkdirSync(BAC, { recursive: true });
for (const f of ['meteo.js', 'ciel.js']) {
  fs.copyFileSync(path.join(ROOT, 'public/js', f), path.join(BAC, f));
}
fs.writeFileSync(path.join(BAC, 'package.json'), '{"type":"module"}');
const charger = (nom) => import(pathToFileURL(path.join(BAC, nom)).href);

const M = await charger('meteo.js');
const C = await charger('ciel.js');

const luminance = (c) => 0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255);
const chroma = (c) => {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  return Math.max(r, g, b) - Math.min(r, g, b);
};

/** Les averses rencontrées entre l'ouverture et `t1`, en journées de monde. */
function releverAverses(m, t1, pas = 0.01) {
  const vagues = [];
  let courant = null;
  for (let i = 0; i * pas < t1; i++) {
    const t = i * pas;
    const intensite = m.reglerTemps(t).intensite;
    if (intensite > 0) {
      if (!courant) {
        courant = { debut: t - pas / 2, fin: t + pas / 2, sommet: 0, n: 0 };
        vagues.push(courant);
      }
      courant.fin = t + pas / 2;
      courant.n++;
      courant.sommet = Math.max(courant.sommet, intensite);
    } else {
      courant = null;                 // sans cette remise à zéro, une seule vague de douze jours
    }
  }
  return vagues;
}

// ==================== 1. LE RYTHME ====================
check('le réglage joueur offre trois régimes',
  JSON.stringify(M.METEO_MODES) === JSON.stringify(['auto', 'jamais', 'toujours']),
  M.METEO_MODES.join(' · '));

const monde = M.creerMeteo({ sel: 424242 });
check('à l’ouverture du monde, le ciel est dégagé',
  monde.etat().intensite === 0 && monde.etat().mode === 'auto',
  `journée ${monde.etat().journee} · prochaine à ${monde.etat().prochaine}`);

const averses = releverAverses(M.creerMeteo({ sel: 424242 }), 14, 0.002);
check('la première averse vient avant une journée de monde', (() => {
  const d = averses[0].debut;
  return d > 0 && d < 1.0;
})(), `départ à ${averses[0].debut.toFixed(2)} journée`);

check('ensuite les averses reviennent tous les deux à trois jours', (() => {
  for (let i = 1; i < averses.length; i++) {
    const ecart = averses[i].debut - averses[i - 1].debut;
    if (ecart < M.EPISODE_TOUS.min - 0.05 || ecart > M.EPISODE_TOUS.max + 0.05) return false;
  }
  return averses.length >= 5;
})(), `${averses.length} averses en 14 jours · départs ${averses.map((a) => a.debut.toFixed(1)).join(' ')}`);

check('une averse tient un quart à deux cinquièmes de journée', (() => {
  return averses.every((a) => {
    const d = a.fin - a.debut;
    return d >= M.DUREE_EPISODE.min - 0.03 && d <= M.DUREE_EPISODE.max + 0.03;
  });
})(), `durées ${averses.map((a) => (a.fin - a.debut).toFixed(2)).join(' ')}`);

check('entre deux averses il ne pleut pas', (() => {
  const mouille = averses.reduce((s, a) => s + (a.fin - a.debut), 0);
  return mouille / 14 > 0.05 && mouille / 14 < 0.35;
})(), `${Math.round((averses.reduce((s, a) => s + (a.fin - a.debut), 0) / 14) * 100)} % du temps sous la pluie`);

check('l’averse est franche sans être un plafond opaque', (() => {
  return averses.every((a) => a.sommet <= M.PLAFOND_INTENSITE + 1e-9
    && a.sommet >= M.PLANCHER_INTENSITE - 1e-9);
})(), `pics ${averses.map((a) => a.sommet.toFixed(2)).join(' ')} · plancher ${M.PLANCHER_INTENSITE} · plafond ${M.PLAFOND_INTENSITE}`);

check('elle monte et redescend progressivement, jamais d’un coup', (() => {
  const m = M.creerMeteo({ sel: 424242 });
  const a = averses[1];
  const lu = (u) => m.reglerTemps(a.debut + u * (a.fin - a.debut)).intensite;
  const montante = [0, M.RAMPE * 0.25, M.RAMPE * 0.5, M.RAMPE * 0.75].map(lu);
  const descendante = [1 - M.RAMPE, 1 - M.RAMPE * 0.75, 1 - M.RAMPE * 0.5, 1 - M.RAMPE * 0.25].map(lu);
  const bornes = a.sommet * 0.03;      // les dates lues au balayage sont à un cheveu près
  return montante.every((v, i) => i === 0 || v > montante[i - 1])
    && descendante.every((v, i) => i === 0 || v < descendante[i - 1])
    && lu(M.RAMPE) > a.sommet * 0.98 && lu(0.5) === a.sommet
    && lu(0) <= bornes && lu(1) <= bornes
    && montante[1] < a.sommet * 0.9 && descendante[2] < a.sommet * 0.9;
})(), `montée ${[0, 0.25, 0.5, 0.75].map((f) => {
  const m = M.creerMeteo({ sel: 424242 });
  const a = averses[1];
  return m.reglerTemps(a.debut + f * M.RAMPE * (a.fin - a.debut)).intensite.toFixed(2);
}).join(' → ')} · pic ${averses[1].sommet}`);

check('deux mondes différents n’ont pas la même météo', (() => {
  const a = releverAverses(M.creerMeteo({ sel: 11 }), 14).map((x) => x.debut.toFixed(3));
  const b = releverAverses(M.creerMeteo({ sel: 12 }), 14).map((x) => x.debut.toFixed(3));
  return a.join() !== b.join();
})());

check('le même monde donne toujours la même météo', (() => {
  const a = releverAverses(M.creerMeteo({ sel: 777 }), 10).map((x) => `${x.debut}:${x.sommet}`);
  const b = releverAverses(M.creerMeteo({ sel: 777 }), 10).map((x) => `${x.debut}:${x.sommet}`);
  return a.length > 3 && a.join() === b.join();
})());

// ==================== 2. LES RÉGIMES ET LA PENDULE ====================
check('« ciel clair » tient la pluie à distance', (() => {
  const m = M.creerMeteo({ sel: 424242, mode: 'jamais' });
  for (let i = 0; i <= 1400; i++) if (m.reglerTemps(i / 100).intensite !== 0) return false;
  return true;
})(), '14 journées balayées, aucune goutte');

check('« averse continue » pleut sans discontinuer', (() => {
  const m = M.creerMeteo({ sel: 424242, mode: 'toujours' });
  for (let i = 0; i <= 1400; i++) if (m.reglerTemps(i / 100).intensite !== M.PLAFOND_INTENSITE) return false;
  return true;
})(), `intensité tenue à ${M.PLAFOND_INTENSITE}`);

check('un régime inconnu retombe sur automatique', (() => {
  const m = M.creerMeteo({ sel: 5, mode: 'ouragan' });
  const a = m.reglerMode('diluvienne');
  const b = m.reglerMode('jamais');
  return m.mode() === 'jamais' && a === 'auto' && b === 'jamais';
})());

const avance = (() => {
  const a = M.creerMeteo({ sel: 424242 });
  for (let k = 0; k < 36; k++) a.avancer(20, 480);          // 720 s réelles, journée de 480 s
  const b = M.creerMeteo({ sel: 424242 }).reglerTemps(1.5);
  return { parPas: a.etat(), parTeleport: b };
})();
check('la pendule météo compte en journées de monde',
  Math.abs(avance.parPas.journee - 1.5) < 1e-9 && avance.parPas.intensite === avance.parTeleport.intensite
  && avance.parPas.numero === avance.parTeleport.numero,
  `720 s à 480 s la journée → ${avance.parPas.journee} journée · intensité ${avance.parPas.intensite} comme au téléport`);

check('raccourcir la journée rapproche les averses', (() => {
  const premierReveil = (dureeJour) => {
    const m = M.creerMeteo({ sel: 424242 });
    for (let s = 1; s <= 20000; s++) {
      m.avancer(1, dureeJour);
      if (m.etat().intensite > 0) return s;
    }
    return Infinity;
  };
  const long = premierReveil(480), court = premierReveil(120);
  return Number.isFinite(long) && Number.isFinite(court) && court < long / 3;
})(), `première averse après ${(() => {
  const m = M.creerMeteo({ sel: 424242 });
  let s = 0;
  while (m.etat().intensite === 0 && s < 20000) { m.avancer(1, 480); s++; }
  return s;
})()} s de journée à 480 s`);

check('l’état annonce la prochaine averse, même entre deux épisodes', (() => {
  const m = M.creerMeteo({ sel: 424242 });
  const sec = m.reglerTemps(0);
  const mouille = m.reglerTemps(averses[0].debut + (averses[0].fin - averses[0].debut) / 2);
  // Le cas qui fuyait : une éclaircie **entre** deux averses. La fiche se taisait
  // justement quand elle avait quelque chose à dire, et resservait la fin passée.
  const entreDeux = m.reglerTemps((averses[0].fin + averses[1].debut) / 2);
  return sec.prochaine != null && sec.fin == null && sec.prochaine > sec.journee
    && Math.abs(sec.prochaine - averses[0].debut) < 0.03
    && mouille.fin != null && mouille.prochaine == null && mouille.numero === 0
    && entreDeux.intensite === 0 && entreDeux.fin == null
    && Math.abs(entreDeux.prochaine - averses[1].debut) < 0.03;
})(), `à l’ouverture : ${annonce(0)} · entre deux : ${annonce((averses[0].fin + averses[1].debut) / 2)} (départ réel ${averses[1].debut.toFixed(2)})`);

function annonce(t) {
  return M.creerMeteo({ sel: 424242 }).reglerTemps(t).prochaine;
}

// ==================== 3. CE QUE L'AVERSE FAIT AU CIEL ====================
const midi = C.etatDuCiel(0.5);
const minuit = C.etatDuCiel(0);

check('sans averse, le ciel n’est même pas recopié',
  M.cielSousPluie(midi, 0) === midi && M.cielSousPluie(midi, 0).pluie === undefined
  && M.cielSousPluie(midi, null) === midi,
  'le plein jour reste mesuré au bit près contre les valeurs d’avant la pluie');

const trempe = M.cielSousPluie(midi, 1);
// Le gris visé porte lui-même un reste de couleur (chroma 25 à 30) : on ne peut donc pas
// exiger une teinte parfaitement neutre. Ce qui est jugé est que chaque canal tombe sous
// la chroma du gris cible majorée d'une marge, et perd au moins la moitié de la sienne —
// un ciel d'averse n'est plus bleu, il est gris.
check('sous l’averse de midi, le ciel perd sa couleur', (() => {
  const paires = [[trempe.ciel, midi.ciel], [trempe.horizon, midi.horizon], [trempe.brume, midi.brume]];
  return paires.every(([a, b]) => chroma(a) <= 45 && chroma(a) < chroma(b) * 0.55);
})(), `chroma zénith ${chroma(trempe.ciel)} contre ${chroma(midi.ciel)} · horizon ${chroma(trempe.horizon)} contre ${chroma(midi.horizon)} · brume ${chroma(trempe.brume)} contre ${chroma(midi.brume)}`);

check('et il descend de lumière',
  luminance(trempe.ciel) < luminance(midi.ciel) - 20
  && luminance(trempe.horizon) < luminance(midi.horizon) - 20
  && luminance(trempe.brume) < luminance(midi.brume) - 20,
  `zénith ${luminance(midi.ciel).toFixed(0)} → ${luminance(trempe.ciel).toFixed(0)} · horizon ${luminance(midi.horizon).toFixed(0)} → ${luminance(trempe.horizon).toFixed(0)} / 255`);

check('le soleil est derrière l’averse, l’ambiante vire au gris-bleu',
  Math.abs(trempe.directe.intensite - midi.directe.intensite * (1 - 0.62)) < 1e-3
  && Math.abs(trempe.ambiante.intensite - midi.ambiante.intensite * (1 - 0.2)) < 1e-3
  && trempe.ambiante.intensite > 0.3 && trempe.directe.intensite > 0.1,
  `directe ${midi.directe.intensite} → ${trempe.directe.intensite} · ambiante ${midi.ambiante.intensite} → ${trempe.ambiante.intensite}`);

check('les nuages épaississent sans boucher le ciel',
  trempe.nuages.opacite > midi.nuages.opacite + 0.3
  && trempe.nuages.opacite <= 0.92
  && M.cielSousPluie(C.etatDuCiel(0.75), 1).nuages.opacite <= 0.92,
  `opacité ${midi.nuages.opacite} → ${trempe.nuages.opacite}`);

check('plus l’averse est forte, plus le ciel est bas', (() => {
  let precedent = Infinity;
  for (let k = 0; k <= 10; k++) {
    const l = luminance(M.cielSousPluie(midi, k / 10).ciel);
    if (l >= precedent) return false;
    precedent = l;
  }
  return true;
})(), `zénith ${[0, 0.25, 0.5, 0.75, 1].map((k) => luminance(M.cielSousPluie(midi, k).ciel).toFixed(0)).join(' → ')}`);

const nuitTrempee = M.cielSousPluie(minuit, 1);
check('la nuit sous la pluie s’assombrit, elle ne blanchit pas', (() => {
  const maxCanal = Math.max((nuitTrempee.ciel >> 16) & 255, (nuitTrempee.ciel >> 8) & 255, nuitTrempee.ciel & 255);
  return maxCanal < 90
    && luminance(nuitTrempee.ciel) < luminance(trempe.ciel) - 40
    && nuitTrempee.directe.intensite < minuit.directe.intensite
    && nuitTrempee.ambiante.intensite < minuit.ambiante.intensite;
})(), `zénith nocturne #${nuitTrempee.ciel.toString(16)} (${luminance(nuitTrempee.ciel).toFixed(0)}) contre ${luminance(trempe.ciel).toFixed(0)} le jour · directe ${minuit.directe.intensite} → ${nuitTrempee.directe.intensite}`);

check('l’averse ne touche rien d’autre que le ciel', (() => {
  const avant = Object.keys(midi).sort().join();
  const apres = Object.keys(trempe).filter((k) => k !== 'pluie').sort().join();
  return avant === apres
    && JSON.stringify(trempe.soleil) === JSON.stringify(midi.soleil)
    && JSON.stringify(trempe.lune) === JSON.stringify(midi.lune)
    && trempe.heure === midi.heure && trempe.phase === midi.phase
    && trempe.jour === midi.jour && trempe.lampes === midi.lampes
    && trempe.etoiles === midi.etoiles;
})(), `champ ajouté : pluie=${trempe.pluie} · phase « ${trempe.phase} », lanternes ${trempe.lampes} inchangées`);

// ==================== 4. DANS LA PAGE ====================
const { browser, page, consoleErrors, badResponses } = await openGame(URL);
const ignorable = (x) => /favicon|Failed to load resource/i.test(String(x));

const hooks = await page.evaluate(() => {
  const mc = window.__mc;
  return ['reglerHeure', 'ciel', 'nuages', 'pluie', 'reglerPluie', 'avancerMeteo', 'reglerMeteo']
    .filter((k) => typeof mc[k] === 'function');
});
check('la page expose la météo au test', hooks.length === 7, hooks.join(','));

// Les aides partagées des évaluations ci-dessous, installées une fois dans la page.
// `auSec` est le point délicat : le monde s'ouvre dans un temple et le joueur peut être
// sous une couronne d'arbres — jugé de là, le rideau serait éteint par le toit et la suite
// confondrait « temps sec » et « abrité ». Elle balaie donc les colonnes autour du joueur
// (spire à angle d'or, jamais un treillis), exige trente-quatre cubes libres au-dessus de
// la tête ET un sol réellement chargé sous les pieds, s'en remet au relevé de toit du jeu
// pour trancher, puis garde la meilleure vue sur le ciel — jugée à l'image, pas à la
// géométrie : une caméra enterrée rend un cadre sombre où aucune comparaison d'exposition
// ne veut rien dire. Elle rend ensuite la main telle qu'elle l'a prise.
// `frais` rend l'horloge toujours plus neuve qu'à l'appel précédent — le relevé de toit ne
// se paie qu'une fois par quart de seconde réelle, deux appels rapprochés sans ce ressort
// reliraient la réponse d'avant.
const installerAides = () => page.evaluate(() => {
  const mc = window.__mc;
  window.__aide = {
    releve: 0,
    frais() {
      window.__aide.releve += 1;
      return performance.now() / 1000 + window.__aide.releve;
    },
    capture() {
      mc.renderer.render(mc.scene, mc.camera);
      const gl = mc.renderer.getContext();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return { px, w, h };
    },
    clarte() {                    // luminance moyenne du quart haut de l'écran
      const img = window.__aide.capture();
      const lum = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
      let s = 0, n = 0;
      for (let y = Math.floor(img.h * 0.75); y < img.h; y++) for (let x = 0; x < img.w; x++) {
        s += lum(img.px, (y * img.w + x) * 4); n++;
      }
      return n ? +(s / n).toFixed(1) : 0;
    },
    auSec() {
      const main = mc.pluie().force;
      const bx = Math.round(mc.camera.position.x), bz = Math.round(mc.camera.position.z);
      let meilleur = null, essais = 0;
      for (let n = 0; n < 90 && essais < 8; n++) {
        const angle = n * 2.399963;                    // angle d'or : un balayage sans trou
        const rayon = 3 + Math.sqrt(n) * 5;            // jusqu'à quarante cubes, là où ça est chargé
        const x = Math.round(bx + Math.cos(angle) * rayon);
        const z = Math.round(bz + Math.sin(angle) * rayon);
        const sol = mc.getTerrainHeight(x, z);
        if (mc.world.getBlock(x, sol - 1, z) === 0) continue;   // tronçon non chargé : rien à juger
        let libre = true;
        for (let y = sol + 1; y <= sol + 34 && libre; y++) libre = mc.world.getBlock(x, y, z) === 0;
        if (!libre) continue;
        mc.camera.position.set(x + 0.5, sol + 1.62, z + 0.5);
        mc.reglerPluie(0.9, 1 / 60, window.__aide.frais());     // le jeu décide, sous toit ou non
        if (!mc.pluie().rendu.visible) continue;
        essais++;
        const ciel = window.__aide.clarte();
        if (!meilleur || ciel > meilleur.ciel) meilleur = { x: x + 0.5, y: sol + 1.62, z: z + 0.5, ciel };
        if (ciel >= 90) break;                         // vue largement ouverte sur le ciel
      }
      mc.reglerPluie(main, 1 / 60, window.__aide.frais());      // main rendue au monde (ou au test)
      return meilleur;
    },
    rendu() { return window.__aide.capture(); },
  };
});
await installerAides();

const controle = await page.evaluate(() => {
  const select = document.getElementById('meteo-mode');
  const sortie = document.getElementById('meteo-mode-value');
  const rangee = select?.closest('.setting-row');
  return {
    options: [...(select?.options ?? [])].map((o) => o.value),
    labels: [...(select?.options ?? [])].map((o) => o.textContent.trim()),
    libelle: rangee?.querySelector('label')?.textContent.trim(),
    for: rangee?.querySelector('label')?.htmlFor,
    sortie: sortie?.textContent.trim(),
    panneauOuvert: document.getElementById('settings').open,
  };
});
check('le panneau Réglages offre une ligne Météo à trois choix',
  controle.panneauOuvert && controle.libelle === 'Météo' && controle.for === 'meteo-mode'
  && JSON.stringify(controle.options) === JSON.stringify(['auto', 'jamais', 'toujours'])
  && controle.labels.length === 3 && /Automatique/.test(controle.labels.join(' ')),
  `${controle.libelle} · ${controle.options.join('/')} · sortie « ${controle.sortie} »`);

// ---- le beau temps ne doit rien payer ----
// Le monde s'ouvre dans un temple : jugé depuis l'entrée du joueur, le rideau serait
// éteint par le toit et la suite confondrait « temps sec » et « abrité ». On sort donc
// d'abord à ciel ouvert, et `frais()` force le relevé de toit — il ne se paie qu'une fois
// par quart de seconde réelle, sinon la mesure resterait celle prise sous la voûte.
const sec = await page.evaluate(() => {
  const mc = window.__mc;
  const { auSec, frais } = window.__aide;
  mc.reglerMeteo('jamais');
  auSec();
  const e = mc.reglerHeure(0.5, 1 / 60, frais());
  mc.renderer.render(mc.scene, mc.camera);
  return { etat: e, pluie: mc.pluie(), nuages: mc.nuages().map((n) => n.opacite) };
});
check('temps sec : les lumières restent exactement celles d’avant la pluie',
  sec.etat.ambiante.intensite === 0.72 && sec.etat.directe.intensite === 0.5
  && sec.etat.directe.couleur === 0xfff4e0 && sec.etat.pluie === undefined
  && sec.pluie.intensite === 0 && sec.pluie.rendu.visible === false
  && sec.pluie.rendu.peints === 0,
  `ambiante ${sec.etat.ambiante.intensite} · directe ${sec.etat.directe.intensite} · ${sec.pluie.rendu.peints} gouttes peintes`);

check('temps sec : la brume est celle de la profondeur de champ, rien de plus',
  Math.abs(sec.pluie.rendu.brume[0] - sec.pluie.rendu.brumeSere[0]) < 1e-6
  && Math.abs(sec.pluie.rendu.brume[1] - sec.pluie.rendu.brumeSere[1]) < 1e-6,
  `near ${sec.pluie.rendu.brume[0]} · far ${sec.pluie.rendu.brume[1]} (référence ${sec.pluie.rendu.brumeSere.join('/')})`);

// ---- l'averse ----
const mouille = await page.evaluate(() => {
  const mc = window.__mc;
  const { auSec, frais } = window.__aide;
  auSec();
  const sec = mc.nuages().map((n) => n.opacite);
  const force = mc.reglerPluie(0.9, 1 / 60, frais());
  mc.renderer.render(mc.scene, mc.camera);
  return { force, sec, etat: mc.ciel(), pluie: mc.pluie(), nuages: mc.nuages().map((n) => n.opacite) };
});
check('l’averse grise le ciel et éteint le soleil dans la page',
  mouille.force === 0.9 && mouille.etat.pluie === 0.9
  && Math.abs(mouille.etat.directe.intensite - 0.5 * (1 - 0.62 * 0.9)) < 1e-3
  && Math.abs(mouille.etat.ambiante.intensite - 0.72 * (1 - 0.2 * 0.9)) < 1e-3
  && mouille.etat.ciel !== sec.etat.ciel,
  `directe ${mouille.etat.directe.intensite} · ambiante ${mouille.etat.ambiante.intensite} · zénith #${(mouille.etat.ciel >>> 0).toString(16)}`);

// Les deux nappes ont un facteur d'opacité propre (1 et 0,62) : la haute gagne donc
// moins que la basse. Ce qui compte est que les deux montent, et que la principale
// épaississe franchement — voile → plafond.
check('les nuages épaississent et la brume se resserre',
  mouille.nuages.every((o, i) => o > mouille.sec[i] + 0.15)
  && mouille.nuages[0] > mouille.sec[0] + 0.3
  && mouille.pluie.rendu.brume[0] < mouille.pluie.rendu.brumeSere[0]
  && mouille.pluie.rendu.brume[1] < mouille.pluie.rendu.brumeSere[1],
  `opacité nappe basse ${mouille.sec[0]} → ${mouille.nuages[0]} · brume ${mouille.pluie.rendu.brumeSere.join('/')} → ${mouille.pluie.rendu.brume.join('/')}`);

check('le rideau de gouttes est peint',
  mouille.pluie.rendu.visible && mouille.pluie.rendu.peints === mouille.pluie.rendu.points
  && mouille.pluie.rendu.peints > 1000 && mouille.pluie.rendu.densite === 0.9
  && mouille.pluie.rendu.opacite > 0.5,
  `${mouille.pluie.rendu.peints}/${mouille.pluie.rendu.points} gouttes · densité ${mouille.pluie.rendu.densite} · opacité ${mouille.pluie.rendu.opacite} · couleur ${mouille.pluie.rendu.couleur}`);

// Une averse de nuit doit être sombre : la teinte du rideau suit la hauteur du soleil.
const nuit = await page.evaluate(() => {
  const mc = window.__mc;
  const { auSec, frais } = window.__aide;
  auSec();
  mc.reglerHeure(0, 1 / 60, frais());
  mc.reglerPluie(0.9, 1 / 60, frais());
  return { couleur: mc.pluie().rendu.couleur, pluie: mc.ciel().pluie, visible: mc.pluie().rendu.visible };
});
check('de nuit le rideau prend une teinte basse, pas blanche',
  nuit.pluie === 0.9 && nuit.visible === true
  && parseInt(nuit.couleur.slice(1, 3), 16) < 160,
  `${nuit.couleur} à minuit contre ${mouille.pluie.rendu.couleur} à midi`);

// ---- le cadre est figé : même caméra, deux images ----
const image = await page.evaluate(() => {
  const mc = window.__mc;
  const { auSec, frais } = window.__aide;
  // Midi d'abord, avant de chercher le cadre : `auSec` juge la clarté de l'image qu'il
  // choisit, et jugée à minuit elle désignerait n'importe quel coin sombre.
  mc.reglerHeure(0.5, 1 / 60, frais());
  const cadre = auSec();
  mc.camera.rotation.set(-0.28, mc.camera.rotation.y, 0);
  const lum = (px, i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  const stats = (img) => {
    let s = 0, n = 0;
    for (let i = 0; i < img.px.length; i += 4) { s += lum(img.px, i); n++; }
    return { moyenne: +(s / n).toFixed(2), pixels: n };
  };
  const diff = (a, b, seuil) => {
    let n = 0;
    for (let i = 0; i < a.px.length; i += 4) if (Math.abs(lum(a.px, i) - lum(b.px, i)) > seuil) n++;
    return n;
  };
  mc.reglerHeure(0.5, 1 / 60, frais());
  mc.reglerPluie(0, 1 / 60, frais());               // sec, figé par la suite
  const secs = stats(window.__aide.rendu());
  mc.reglerPluie(0.9, 1 / 60, frais());
  const trempe = stats(window.__aide.rendu());
  // Isolement du rideau : rien n'est remanié entre ces images — pas de `majCiel`, donc ni
  // nuages ni soleil ne bougent. En masquant le rideau on mesure ce qu'il peint ; en
  // faisant avancer son seul temps, ce que les gouttes remuent ; et A/A′ prouve que le
  // cadre tient.
  const rideau = mc.scene.getObjectByName('pluie');
  const u = rideau.material.uniforms;
  u.uTemps.value = 100;
  rideau.visible = false;
  const sansRideau = window.__aide.rendu();
  rideau.visible = true;
  const gouttesA = window.__aide.rendu();
  const gouttesAprime = window.__aide.rendu();
  u.uTemps.value = 137;
  const gouttesB = window.__aide.rendu();
  return {
    secs, trempe,
    gouttes: diff(gouttesA, gouttesB, 12),
    peint: diff(sansRideau, gouttesA, 12),
    fige: diff(gouttesA, gouttesAprime, 0),
    total: trempe.pixels,
    cadre,
    etat: { heure: mc.ciel().heure, pluie: mc.ciel().pluie, ...mc.pluie().rendu },
  };
});
check('à cadre égal, l’averse assombrit l’image',
  image.cadre && image.cadre.ciel > 60 && image.trempe.moyenne < image.secs.moyenne - 4,
  `luminance moyenne ${image.secs.moyenne} → ${image.trempe.moyenne} / 255 depuis (${image.cadre?.x}, ${image.cadre?.y}, ${image.cadre?.z}), ciel à ${image.cadre?.ciel}`);

// Le rideau ne doit pas être un ornement que l'info du renderer annonce sans qu'il paraisse.
// Deux mesures, toutes deux prises à cadre figé : ce que le rideau peint par rapport au
// monde sans pluie, et ce que remuent les seules gouttes quand leur temps avance. Mesuré
// à la taille de sprite courante : 0,47 % et 0,73 % de l'image — les seuils sont la moitié
// de ces valeurs, pour que la suite bronche si la pluie cesse de paraître sans exiger un
// déluge. (Une averse pleine est déjà un voile sur la moitié haute : 0,94 % mesuré.)
check('et le rideau peint des traînées qui bougent',
  image.fige === 0 && image.gouttes > image.total * 0.003 && image.peint > image.total * 0.002,
  `${Math.round((image.gouttes / image.total) * 1000) / 10} % de l’image remués par les seules gouttes, ${Math.round((image.peint / image.total) * 1000) / 10} % peintes par le rideau · cadre figé à ${image.fige} pixel près · ${JSON.stringify(image.etat)}`);

// ---- sous un toit, on reste au sec ----
const couvert = await page.evaluate(async () => {
  const mc = window.__mc;
  const CS = mc.CHUNK_SIZE;
  const { auSec, frais } = window.__aide;
  auSec();                                            // même départ que les autres contrôles
  mc.reglerHeure(0.5, 1 / 60, frais());
  mc.reglerPluie(0.9, 1 / 60, frais());
  const dehorsAvant = mc.pluie().rendu;
  const cx = Math.floor(mc.camera.position.x), cz = Math.floor(mc.camera.position.z);
  const y = Math.floor(mc.camera.position.y) + 4;
  const dalle = (id) => {
    const edits = [];
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      for (let dy = 0; dy < 3; dy++) edits.push([cx + dx, y + dy, cz + dz, id]);
    }
    mc.world.setBlocksBulk(edits);
    for (let bx = Math.floor((cx - 3) / CS); bx <= Math.floor((cx + 3) / CS); bx++) {
      for (let bz = Math.floor((cz - 3) / CS); bz <= Math.floor((cz + 3) / CS); bz++) {
        mc.world.markChunkDirty(bx, bz);
      }
    }
    mc.world.updateChunks(cx, cz, 8000);
  };
  dalle(3);                                          // sept sur sept, trois cubes de pierre
  const colonne = [];
  for (let dy = 0; dy < 8; dy++) {
    colonne.push(`${y + dy}:${mc.world.getBlock(cx, y + dy, cz)}${mc.world.isSolid(cx, y + dy, cz) ? 'S' : '-'}`);
  }
  const essais = [];
  for (let k = 0; k < 3; k++) {
    mc.reglerPluie(0.9, 1 / 60, frais());             // horloge neuve : le relevé de toit est repris
    mc.renderer.render(mc.scene, mc.camera);
    essais.push({ ...mc.pluie().rendu, brume: mc.scene.fog.near });
  }
  const sousToit = essais[essais.length - 1];
  dalle(0);
  mc.reglerPluie(0.9, 1 / 60, frais());
  mc.renderer.render(mc.scene, mc.camera);
  return {
    dehorsAvant, sousToit, essais, colonne, y,
    dehors: mc.pluie().rendu,
    cam: mc.camera.position.toArray().map((v) => +v.toFixed(2)),
  };
});
check('sous un toit, la pluie s’arrête au plafond',
  couvert.sousToit.visible === false && couvert.sousToit.peints === 0
  && couvert.dehors.visible === true && couvert.dehors.peints > 1000,
  `dalle en y ${couvert.y} · colonne ${couvert.colonne.join(' ')} · caméra ${couvert.cam.join('/')} · avant ${couvert.dehorsAvant.peints} gouttes, sous le toit ${couvert.essais.map((e) => e.peints).join('/')} après ${couvert.essais.map((e) => e.brume.toFixed(1)).join('/')}, dehors ${couvert.dehors.peints}`);

// ---- le réglage, son effet et sa mémoire ----
const reglages = await page.evaluate(() => {
  const mc = window.__mc;
  const sortie = () => document.getElementById('meteo-mode-value').textContent.trim();
  const select = () => document.getElementById('meteo-mode').value;
  const valeur = () => JSON.parse(localStorage.getItem('mincraft_settings') || '{}').meteo;
  const { auSec, frais } = window.__aide;
  auSec();
  const avant = { mode: mc.reglerMeteo('auto'), sortie: sortie(), select: select(), disque: valeur() };
  // Le régime inconnu se teste d'abord : il retombe sur « auto » et ce choix s'écrit sur
  // le disque. Le laisser en dernier ferait croire au rechargement, juste après, que le
  // joueur n'a rien demandé.
  const invalide = mc.reglerMeteo('déluge');
  const sec = mc.reglerMeteo('jamais');
  const secEtat = { pluie: mc.pluie().intensite, sortie: sortie(), select: select(), disque: valeur() };
  const pluie = mc.reglerMeteo('toujours');
  mc.reglerHeure(0.5, 1 / 60, frais());
  const pluet = { pluie: mc.pluie().intensite, visible: mc.pluie().rendu.visible, sortie: sortie(), disque: valeur() };
  return { avant, sec, secEtat, pluie, pluet, invalide };
});
check('imposer le ciel clair coupe toute averse',
  reglages.sec === 'jamais' && reglages.secEtat.pluie === 0
  && reglages.secEtat.select === 'jamais' && reglages.secEtat.disque === 'jamais',
  `sortie « ${reglages.secEtat.sortie} » · gravé ${reglages.secEtat.disque}`);

check('imposer l’averse continue la rend visible à toute heure',
  reglages.pluie === 'toujours' && reglages.pluet.pluie === M.PLAFOND_INTENSITE
  && reglages.pluet.visible === true && reglages.pluet.disque === 'toujours',
  `intensité ${reglages.pluet.pluie} · sortie « ${reglages.pluet.sortie} »`);

check('un régime inconnu demandé par la page retombe sur automatique',
  reglages.invalide === 'auto' && reglages.avant.mode === 'auto'
  && reglages.avant.sortie === 'automatique',
  `« ${reglages.avant.sortie} »`);

await page.reload({ waitUntil: 'load' });
await waitForBoot(page);
await installerAides();
const grave = await page.evaluate(() => {
  const mc = window.__mc;
  const { auSec, frais } = window.__aide;
  auSec();
  mc.reglerHeure(0.5, 1 / 60, frais());   // forcée : la page vient de renaître, rien n'a encore été peint
  return {
    pluie: mc.pluie(),
    select: document.getElementById('meteo-mode').value,
    sortie: document.getElementById('meteo-mode-value').textContent.trim(),
    disque: JSON.parse(localStorage.getItem('mincraft_settings') || '{}').meteo,
  };
});
check('le régime survit au rechargement de la page',
  grave.select === 'toujours' && grave.disque === 'toujours'
  && grave.pluie.mode === 'toujours' && grave.pluie.intensite === M.PLAFOND_INTENSITE
  && grave.pluie.rendu.visible === true && grave.sortie === 'averse',
  `${grave.disque} au rechargement · ${grave.pluie.intensite} d’intensité · sortie « ${grave.sortie} »`);

// Et l'automate du jeu, laissé seul : en faisant défiler la pendule on doit traverser
// des averses et des éclaircies sans rien forcer — c'est la demande du joueur, « des
// périodes de pluie ». Le pas de dixième de journée est plus fin que la partie plate d'une
// averse (au moins treize centièmes) : le pic est donc toujours rencontré, jamais manqué.
const cycles = await page.evaluate(() => {
  const mc = window.__mc;
  mc.reglerMeteo('auto');
  let seches = 0, trempees = 0, pic = 0, episodes = 0, dejaMouille = false;
  for (let j = 0; j < 150; j++) {
    const e = mc.avancerMeteo(0.1, 1 / 60);
    if (e.intensite > 0) {
      trempees++;
      pic = Math.max(pic, e.intensite);
      if (!dejaMouille) { episodes++; dejaMouille = true; }
    } else { seches++; dejaMouille = false; }
  }
  return { seches, trempees, pic, episodes, etat: mc.pluie() };
});
check('laissé seul, le monde traverse des averses et des éclaircies',
  cycles.episodes >= 4 && cycles.trempees >= 8 && cycles.seches >= 100
  && cycles.pic >= M.PLANCHER_INTENSITE && cycles.etat.mode === 'auto',
  `${cycles.episodes} averses et ${cycles.trempees / 10} journées mouillées sur 15 · pic ${cycles.pic}`);

const realErrors = consoleErrors.filter((e) => !ignorable(e));
const realBad = badResponses.filter((u) => !ignorable(u));
check('aucune erreur console pendant l’averse',
  realErrors.length === 0 && realBad.length === 0,
  [...new Set([...realErrors.slice(0, 3), ...realBad.slice(0, 3)])].join(' | '));

fs.mkdirSync(SHOTS, { recursive: true });
await page.evaluate(() => {
  const mc = window.__mc;
  const { auSec, frais } = window.__aide;
  auSec();
  mc.camera.rotation.x = -0.2;
  mc.reglerHeure(0.5, 1 / 60, frais());
  mc.reglerMeteo('toujours');
});
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(SHOTS, 'pluie-averse.png') }).catch(() => {});
await page.evaluate(() => window.__mc.reglerMeteo('jamais'));
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(SHOTS, 'pluie-clair.png') }).catch(() => {});

await browser.close();
fs.rmSync(BAC, { recursive: true, force: true });
process.exit(summary());
