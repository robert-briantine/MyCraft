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

// ==================== 2 bis. LE GRIS DEVANCE LES GOUTTES ====================
// La demande du joueur : « quand il pleut, le ciel doit changer avant et devenir gris,
// puis il se met à pleuvoir ; quand la pluie s'arrête progressivement le ciel revient ».
// Une seule enveloppe ne sait pas le dire. Ce qui est jugé ici, c'est l'écart entre les
// deux signaux — et le fait qu'aucun des deux ne marche jamais à l'envers de l'autre.
const averseJugee = averses[1];
const sonde = (t) => M.creerMeteo({ sel: 424242 }).reglerTemps(t);
const veilleGris = sonde(averseJugee.debut - 0.002);
const entreeGris = Array.from({ length: 9 }, (_, i) =>
  sonde(averseJugee.debut - M.COUVERTURE_AVANT + (i / 8) * M.COUVERTURE_AVANT).couverture);
const sortieGris = Array.from({ length: 9 }, (_, i) =>
  sonde(averseJugee.fin + (i / 8) * M.ECLAIRCIE_APRES).couverture);
const miEntree = sonde(averseJugee.debut - M.COUVERTURE_AVANT / 2);
const miSortie = sonde(averseJugee.fin + M.ECLAIRCIE_APRES * 0.3);
const apresMarge = sonde(averseJugee.fin + M.ECLAIRCIE_APRES + 0.02);

check('le ciel commence à griser pendant que le sol est encore sec',
  miEntree.couverture > 0.1 && miEntree.intensite === 0,
  `à ${Math.round(M.COUVERTURE_AVANT * 240)} s des premières gouttes : couverture ${miEntree.couverture} · pluie ${miEntree.intensite}`);

check('il est déjà plein de gris à l’instant où les premières gouttes tombent',
  veilleGris.intensite === 0 && veilleGris.couverture >= averseJugee.sommet * 0.95,
  `couverture ${veilleGris.couverture} sans une goutte, contre un pic d’averse à ${averseJugee.sommet}`);

check('et il met du temps à rendre son bleu après la dernière goutte',
  miSortie.intensite === 0 && miSortie.couverture >= averseJugee.sommet * 0.75 && apresMarge.couverture === 0,
  `${Math.round(M.ECLAIRCIE_APRES * 0.3 * 480)} s après la fin : couverture ${miSortie.couverture} sans une goutte · à ${Math.round(M.ECLAIRCIE_APRES * 480)} s : ciel rendu`);

check('le gris monte et redescend comme une rampe, jamais par à-coups', (() => {
  // Les dates d'épisode viennent du balayage, connues au millième de journée près : les
  // deux bords se jugent donc à la marge près, comme le fait déjà le contrôle de rampe.
  const nulle = averseJugee.sommet * 0.03;
  return entreeGris.every((v, i) => i === 0 || v >= entreeGris[i - 1])
    && sortieGris.every((v, i) => i === 0 || v <= sortieGris[i - 1])
    && entreeGris[0] <= nulle && entreeGris[8] >= averseJugee.sommet * 0.95
    && sortieGris[0] >= averseJugee.sommet * 0.95 && sortieGris[8] <= nulle;
})(), `entrée ${entreeGris.map((v) => v.toFixed(2)).join(' → ')} · sortie ${sortieGris.map((v) => v.toFixed(2)).join(' → ')}`);

check('le gris ne prend jamais les gouttes de vitesse, ni ne les laisse derrière lui', (() => {
  const p = M.creerMeteo({ sel: 424242 });
  for (let i = 0; i <= 14000; i++) {
    const e = p.reglerTemps(i / 1000);
    if (e.intensite > e.couverture + 1e-9) return false;      // pleuvoir sous un ciel clair
  }
  return true;
})(), '14 journées balayées au millième : partout intensité ≤ couverture');

// Plateau de l'averse : débit lu pas à pas, pour juger qu'il respire sans que le pic
// disparaisse (les contrôles de rampe ci-dessus lisent la valeur du milieu contre le
// maximum balayé — un plateau qui ne battrait plus à rien les ferait mentir).
const plateau = Array.from({ length: 41 }, (_, i) =>
  sonde(averseJugee.debut + (M.RAMPE + (i / 40) * (1 - 2 * M.RAMPE)) * (averseJugee.fin - averseJugee.debut)).intensite);
check('l’averse respire pendant son plateau au lieu de tenir un débit plat', (() => {
  let creux = 0;
  for (let i = 1; i < plateau.length - 1; i++) {
    if (plateau[i] < plateau[i - 1] - 1e-4 && plateau[i] <= plateau[i + 1] + 1e-4
      && plateau[i] < averseJugee.sommet * 0.97) creux++;
  }
  return creux >= 2 && Math.min(...plateau) < averseJugee.sommet * 0.95
    && plateau[Math.floor(plateau.length / 2)] === averseJugee.sommet;
})(), `débit de ${Math.min(...plateau)} à ${averseJugee.sommet} sur le plateau · ${plateau.filter((v) => v < averseJugee.sommet * 0.95).length}/41 lectures en dessous du pic`);

// ==================== 2 ter. LES JOURNÉES SANS UN NUAGE ====================
// Un régime programmé, à l'image des averses : balayé une fois pour toutes ici, jugé
// ensuite sans rien recompter.
const regimes = (() => {
  const p = M.creerMeteo({ sel: 424242 });
  let franches = 0, total = 0, episodes = 0, courant = false, pic = 0, premier = null;
  for (let i = 0; i <= 14000; i++) {
    const e = p.reglerTemps(i / 1000);
    total++;
    pic = Math.max(pic, e.degage);
    if (e.degage > 0.5) {
      franches++;
      if (premier == null) premier = i / 1000;
      if (!courant) { episodes++; courant = true; }
    } else courant = false;
  }
  return { episodes, part: franches / total, pic, premier };
})();

check('de temps en temps, une journée entière se découvre',
  regimes.episodes >= 3 && regimes.part > 0.05 && regimes.part < 0.4 && regimes.premier > 0.4,
  `${regimes.episodes} régimes dégagés sur 14 journées (${Math.round(regimes.part * 100)} % du temps) · pic ${regimes.pic}`
  + (regimes.premier == null ? ' · aucune éclaircie franche en quatorze journées' : ` · premier à ${regimes.premier.toFixed(2)} journée`));

check('aucune éclaircie franche ne vient avant la première journée', (() => {
  const p = M.creerMeteo({ sel: 424242 });
  for (let i = 0; i <= 400; i++) if (p.reglerTemps(i / 1000).degage !== 0) return false;
  return true;
})(), 'sans cette attache, le plein jour jugé par les autres suites bougerait selon la graine');

check('sous l’averse, le régime dégagé rend les armes', (() => {
  for (const v of averses) {
    const e = sonde((v.debut + v.fin) / 2);
    if (e.degage !== 0 || e.couverture < v.sommet * 0.9) return false;
  }
  return true;
})(), `${averses.length} cœurs d’averse vérifiés : gris plein, aucune éclaircie`);

const midiSec = C.etatDuCiel(0.5);
const midiClair = M.cielDegage(midiSec, 1);
check('sans éclaircie, le ciel n’est même pas recopié',
  M.cielDegage(midiSec, 0) === midiSec && M.cielDegage(midiSec, null) === midiSec
  && M.cielDegage(midiSec, 0).degage === undefined,
  'à régime nul, l’état reçu ressort tel quel');

check('l’éclaircie ferme le bleu, elle ne surexpose pas le ciel',
  chroma(midiClair.ciel) > chroma(midiSec.ciel)
  && luminance(midiClair.ciel) < luminance(midiSec.ciel) - 8
  && luminance(midiClair.brume) < luminance(midiSec.brume) - 4
  && midiClair.directe.intensite > midiSec.directe.intensite
  && midiClair.ambiante.intensite > midiSec.ambiante.intensite
  && midiClair.nuages.opacite === midiSec.nuages.opacite,      // l'épaisseur se juge ailleurs
  `zénith #${midiSec.ciel.toString(16)} (${luminance(midiSec.ciel)}, chroma ${chroma(midiSec.ciel)}) → #${midiClair.ciel.toString(16)} (${luminance(midiClair.ciel)}, chroma ${chroma(midiClair.ciel)}) · directe ${midiSec.directe.intensite} → ${midiClair.directe.intensite}`);

check('la nuit, l’éclaircie ne change aucune teinte', (() => {
  const n = C.etatDuCiel(0);
  const d = M.cielDegage(n, 1);
  return d.ciel === n.ciel && d.horizon === n.horizon && d.brume === n.brume
    && d.directe.intensite === n.directe.intensite;
})(), 'pas de bleu à fermer sans soleil : seuls les nuages se retirent');

const couches = (() => {
  const p = M.creerMeteo({ sel: 424242 });
  let mini = 9, maxi = -9, horsBornes = 0;
  for (let i = 0; i <= 1400; i++) {
    const c = p.reglerTemps(i / 100).couche;
    if (c < M.COUCHE_BORNE.min - 1e-9 || c > M.COUCHE_BORNE.max + 1e-9) horsBornes++;
    mini = Math.min(mini, c); maxi = Math.max(maxi, c);
  }
  return { mini, maxi, horsBornes, ouverture: p.reglerTemps(0).couche };
})();

check('l’épaisseur des nappes vaut 1 à l’ouverture, puis varie selon les jours',
  couches.ouverture === 1 && couches.horsBornes === 0
  && couches.maxi > 1.1 && couches.mini < 0.4,
  `nappe tenue entre ${couches.mini} et ${couches.maxi} sur quatorze journées (bornes ${M.COUCHE_BORNE.min}/${M.COUCHE_BORNE.max}), 1 à l’ouverture`);

const vents = (() => {
  const p = M.creerMeteo({ sel: 424242 });
  let mini = 9, maxi = -9, horsBornes = 0;
  for (let i = 0; i <= 1400; i++) {
    const v = p.reglerTemps(i / 100).vent;
    if (v < M.VENT.min - 1e-9 || v > 1 + 1e-9) horsBornes++;
    mini = Math.min(mini, v); maxi = Math.max(maxi, v);
  }
  // L'averse doit lever le vent **à la même heure** — comparer deux heures différentes
  // jugerait le bruit du jour, pas l'effet de l'orage. Le vent étant borné à 1, un instant
  // où il souffle déjà fort ne peut pas monter : ces instants-là sont comptés à part, et
  // ce qui est exigé est qu'un vent non saturé monte toujours, et qu'aucun ne baisse.
  let jamaisBaissé = true, montes = 0, jugeables = 0, satures = 0, temoin = null;
  for (const v of averses) {
    for (let k = 1; k <= 3; k++) {
      const t = v.debut + (k / 4) * (v.fin - v.debut);
      const sec = M.creerMeteo({ sel: 424242 }).reglerTemps(t).vent;
      const force = M.creerMeteo({ sel: 424242, mode: 'toujours' }).reglerTemps(t).vent;
      if (force < sec - 1e-9) jamaisBaissé = false;
      if (sec >= 0.9) { satures++; continue; }
      jugeables++;
      if (force > sec + 1e-9) { montes++; if (!temoin) temoin = { t, sec, force }; }
    }
  }
  return { mini, maxi, horsBornes, cap: p.etat().ventDirection,
    jamaisBaissé, montes, jugeables, satures, temoin };
})();

check('le vent tourne au gré du monde et se lève sous l’averse',
  vents.horsBornes === 0 && vents.maxi > vents.mini + 0.2
  && Math.abs(Math.hypot(vents.cap[0], vents.cap[1]) - 1) < 1e-3
  && JSON.stringify(vents.cap) !== JSON.stringify(M.creerMeteo({ sel: 424243 }).etat().ventDirection)
  && vents.jamaisBaissé && vents.jugeables >= 6 && vents.montes === vents.jugeables,
  `vent ${vents.mini} … ${vents.maxi} · cap ${vents.cap.join(' / ')} · sur ${vents.jugeables} instants d’averse encore loin du plafond, ${vents.montes} vents levés par l’orage et aucun baissé (${vents.satures} instants déjà saturés)${vents.temoin ? ` · témoin à ${vents.temoin.t.toFixed(2)} journée : ${vents.temoin.sec} → ${vents.temoin.force}` : ''}`);

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
  Math.abs(trempe.directe.intensite - midi.directe.intensite * (1 - 0.78)) < 1e-3
  && Math.abs(trempe.ambiante.intensite - midi.ambiante.intensite * (1 - 0.4)) < 1e-3
  && trempe.ambiante.intensite > 0.3 && trempe.directe.intensite > 0.08,
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
  return ['reglerHeure', 'ciel', 'nuages', 'pluie', 'reglerPluie', 'avancerMeteo', 'reglerMeteo',
    'reglerVent', 'reglerMeteoTemps'].filter((k) => typeof mc[k] === 'function');
});
check('la page expose la météo au test', hooks.length === 9, hooks.join(','));

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
    // Ce que le rideau SEUL peint : deux cadres qui ne diffèrent que par sa visibilité. Juger
    // une goutte à sa luminance absolue ne dirait rien (une pièce éclairée vaut un ciel voilé) ;
    // juger sa contribution si. Les deux rideaux — proche et lointain — sont masqués ensemble.
    pluieApport() {
      const mc = window.__mc;
      const rideaux = [];
      mc.scene.traverse((o) => { if (o.name === 'pluie') rideaux.push(o); });
      const etat = rideaux.map((o) => o.visible);
      rideaux.forEach((o) => { o.visible = true; });
      const avec = window.__aide.capture();
      rideaux.forEach((o) => { o.visible = false; });
      const sans = window.__aide.capture();
      rideaux.forEach((o, i) => { o.visible = etat[i]; });
      const lum = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
      let touches = 0;
      const echantillon = Math.round((avec.w / 2) * (avec.h / 2));
      for (let y = 2; y < avec.h - 2; y += 2) for (let x = 2; x < avec.w - 2; x += 2) {
        const i = (y * avec.w + x) * 4;
        if (Math.abs(lum(avec.px, i) - lum(sans.px, i)) >= 8) touches++;
      }
      return { touches, total: echantillon };
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
  && Math.abs(mouille.etat.directe.intensite - 0.5 * (1 - 0.78 * 0.9)) < 1e-3
  && Math.abs(mouille.etat.ambiante.intensite - 0.72 * (1 - 0.4 * 0.9)) < 1e-3
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
  && mouille.pluie.rendu.peints > 1000
  // Densité épinglée à sa valeur neuve. Le rideau ne tire plus tout le nuage de points :
  // à pleine averse il en peignait 90 %, 4,6 % du cadre en traits de 9×5 px — le joueur lisait
  // de la neige (`probe-neige.mjs`), puis a redit « encore trop épaisse ». Un quart des gouttes,
  // mais longues (jusqu'à 24 px) : allongement 3,2–4,2, largeur médiane 4–6 px, emprise 0,7–1,37 %.
  && mouille.pluie.rendu.densite === 0.18
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
  // nuages ni soleil ne bougent. En masquant le rideau on mesure ce qu'il peint ; en faisant
  // avancer son seul temps, ce que les gouttes remuent ; et A/A′ prouve que le cadre tient.
  // Les DEUX rideaux se masquent et se rajeunissent ensemble : laisser la couche lointaine
  // peinte mesurerait la moitié du mécanisme et le croirait entier.
  const rideaux = [];
  mc.scene.traverse((o) => { if (o.name === 'pluie') rideaux.push(o); });
  const reglerTempsGouttes = (t) => rideaux.forEach((r) => { r.material.uniforms.uTemps.value = t; });
  const montrerRideaux = (vrai) => rideaux.forEach((r) => { r.visible = vrai; });
  reglerTempsGouttes(100);
  montrerRideaux(false);
  const sansRideau = window.__aide.rendu();
  montrerRideaux(true);
  const gouttesA = window.__aide.rendu();
  const gouttesAprime = window.__aide.rendu();
  reglerTempsGouttes(137);
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
// Le contrat n'est plus « pas de pluie sous un toit » — il supprimait l'averse des maisons
// autant que des sous-bois, et le joueur ne voyait plus pleuvoir par aucune fenêtre. Il est
// « le plafond fait son travail » : jugé à l'image, à ras du plafond, contre la même vue à
// ciel ouvert et contre ce que peint l'horizontale (cet abri n'a pas de murs).
const couvert = await page.evaluate(async () => {
  const mc = window.__mc;
  const CS = mc.CHUNK_SIZE;
  const { auSec, frais, pluieApport } = window.__aide;
  auSec();                                            // même départ que les autres contrôles
  mc.reglerHeure(0.5, 1 / 60, frais());
  mc.reglerPluie(0.9, 1 / 60, frais());
  const dehorsAvant = mc.pluie().rendu;
  const cx = Math.floor(mc.camera.position.x), cz = Math.floor(mc.camera.position.z);
  const y = Math.floor(mc.camera.position.y) + 1;     // la dalle colle au-dessus de l'œil
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
    // La dalle doit être DESSINÉE, pas seulement posée : sans drainage complet le test de
    // profondeur n'aurait rien à opposer aux gouttes et le contrôle validerait un trou.
    const w = mc.world;
    let garde = 0;
    do { w.updateChunks(cx, cz, 8000); w.drainerMailles(4000); } while (w.pendingChunks > 0 && garde++ < 80);
  };
  const triangles = () => { mc.renderer.render(mc.scene, mc.camera); return mc.renderer.info.render.triangles; };
  mc.look(0, 89);
  mc.reglerHeure(0.5, 1 / 60, frais());
  const versLeHautNu = pluieApport();                 // la même vue, avant toute dalle
  const trianglesNu = triangles();
  dalle(3);                                          // sept sur sept, trois cubes de pierre
  const trianglesSous = triangles();
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
  mc.look(0, 89);
  mc.reglerHeure(0.5, 1 / 60, frais());
  const versLeHaut = pluieApport();
  mc.look(0, 0);
  mc.reglerHeure(0.5, 1 / 60, frais());
  const aLHorizontale = pluieApport();
  dalle(0);
  mc.reglerPluie(0.9, 1 / 60, frais());
  mc.renderer.render(mc.scene, mc.camera);
  return {
    dehorsAvant, sousToit, essais, colonne, y, versLeHaut, versLeHautNu, aLHorizontale,
    trianglesNu, trianglesSous,
    dehors: mc.pluie().rendu,
    cam: mc.camera.position.toArray().map((v) => +v.toFixed(2)),
  };
});
check('sous une dalle, la pluie ne traverse pas le plafond',
  couvert.sousToit.rideaux === 2 && couvert.dehors.visible === true && couvert.dehors.peints > 1000
  && couvert.trianglesSous > couvert.trianglesNu
  && couvert.versLeHaut.touches <= Math.max(30, couvert.versLeHautNu.touches * 0.05)
  && couvert.aLHorizontale.touches > couvert.aLHorizontale.total * 0.002,
  `dalle en y ${couvert.y} · caméra ${couvert.cam.join('/')} · ${couvert.versLeHaut.touches} px remués vers le haut sous la dalle contre ${couvert.versLeHautNu.touches} à ciel ouvert et ${couvert.aLHorizontale.touches} à l’horizontale sur ${couvert.aLHorizontale.total} échantillonnés · triangles ${couvert.trianglesNu} → ${couvert.trianglesSous} · ${couvert.sousToit.rideaux} rideaux allumés sous le toit · dehors ${couvert.dehors.peints}/${couvert.dehors.points} gouttes`);

// ---- le vent du monde, la profondeur, les baies vitrées ----
// Trois choses que le joueur demande et qu'aucun contrôle ne tenait : la traînée doit suivre
// le vent du MONDE (elle se couchait et changeait de sens selon l'orientation de la caméra,
// avec une image de retard), la pluie doit s'enfoncer jusqu'à la brume (le volume mourait à
// quarante-cinq cubes), et l'averse doit se voir depuis l'intérieur d'une maison.
const averse = await page.evaluate(() => {
  const mc = window.__mc;
  const { auSec, frais, pluieApport } = window.__aide;
  const mainPluie = mc.pluie().force;                 // ce que la suite avait déjà figé, s'il y en avait
  auSec();
  const rideaux = () => {
    const out = [];
    mc.scene.traverse((o) => { if (o.name === 'pluie') out.push(o); });
    return out;
  };
  // Les positions réelles des gouttes cette image, en rejouant le vertex shader : c'est la
  // seule façon de juger la portée du volume sans deviner ce que le GPU aurait dû peindre.
  const nuage = (enclos) => {
    const seaux = [0, 0, 0, 0, 0, 0, 0, 0];
    let vivants = 0, plusLoin = 0, dansLaPiece = 0;
    for (const o of rideaux()) {
      const u = o.material.uniforms, B = u.uBoite.value, t = u.uTemps.value;
      const vx = u.uVent.value.x, vz = u.uVent.value.y, houle = u.uHoule.value;
      const pos = o.geometry.attributes.position.array;
      const vit = o.geometry.attributes.aVitesse.array;
      const graine = o.geometry.attributes.aGraine.array;
      const ch = u.uChambre.value, clip = u.uDedans.value;
      for (let i = 0; i < vit.length; i++) {
        if (graine[i] > u.uDensite.value) continue;
        const g = 0.6 + 0.8 * graine[i];
        const h = Math.sin(t * 0.9 + graine[i] * 6.2831853) * houle;
        const lx = ((pos[i * 3] + t * vx * g + h + B.x * 0.5) % B.x + B.x) % B.x - B.x * 0.5;
        const ly = ((pos[i * 3 + 1] - t * vit[i] + B.y * 0.5) % B.y + B.y) % B.y - B.y * 0.5;
        const lz = ((pos[i * 3 + 2] + t * vz * g + h * 0.7 + B.z * 0.5) % B.z + B.z) % B.z - B.z * 0.5;
        vivants++;
        const d = Math.hypot(lx, ly, lz);
        if (d > plusLoin) plusLoin = d;
        seaux[Math.min(7, Math.floor(d / 15))]++;
        const wx = o.position.x + lx, wy = o.position.y + ly, wz = o.position.z + lz;
        if (clip > 0.5 && wy < ch.y && (wx - ch.x) ** 2 + (wz - ch.z) ** 2 < ch.w ** 2) continue;
        if (enclos && wx >= enclos.x0 && wx <= enclos.x1 && wz >= enclos.z0 && wz <= enclos.z1
            && wy >= enclos.y0 && wy <= enclos.y1) dansLaPiece++;
      }
    }
    return { vivants, seaux, plusLoin: +plusLoin.toFixed(1), dansLaPiece };
  };

  mc.reglerPluie(0.9, 1 / 60, frais());
  mc.reglerVent(1, 1 / 60, frais());
  const yaws = {};
  for (const y of [0, 90, 180, 270]) {
    mc.look(y, 0);
    mc.reglerHeure(0.5, 1 / 60, frais());
    const p = mc.pluie().rendu;
    // Référence indépendante de l'inclinaison : la vitesse réellement appliquée aux gouttes,
    // projetée sur l'axe droite d'une caméra relevée à zéro degré. L'axe se déduit du seul
    // yaw — jamais de `matrixWorld`, que `majCiel` est justement accusée de lire en retard.
    const r = y * Math.PI / 180;
    const attendu = Math.max(-0.8, Math.min(0.8, (p.vent[0] * Math.cos(r) - p.vent[1] * Math.sin(r)) / 22));
    yaws[y] = { pente: p.pente, attendu: +attendu.toFixed(3) };
  }
  mc.reglerVent(0, 1 / 60, frais());
  mc.look(0, 0);
  mc.reglerHeure(0.5, 1 / 60, frais());
  const calme = (() => {
    const p = mc.pluie().rendu;
    const cap = mc.pluie().ventDirection || [1, 0];
    const norm = Math.hypot(p.vent[0], p.vent[1]) || 1;
    return { pente: p.pente, vent: p.vent, sinusAuCap: +((p.vent[0] * cap[1] - p.vent[1] * cap[0]) / norm).toFixed(3) };
  })();
  const renduPortee = mc.pluie().rendu;
  const portee = Object.assign(
    { portee: renduPortee.portee, brume: renduPortee.brume[1], boites: renduPortee.boites },
    nuage(null));

  // Une pièce de maison avec sa baie vitrée : le joueur doit y voir pleuvoir dehors.
  // Cinq baies sont jugées et la MÉDIANE statue. Mesuré le 2026-11-18 après l'éclaircissement
  // du rideau, une baie unique faisait osciller le compteur de 194 à 272 pixels selon le monde
  // tiré (`e2e-<pid>-<aléatoire>`) : le contrôle devenait une pièce de monnaie, rouge au témoin
  // d'une batterie sans que rien n'ait changé au produit. Et d'une baie à l'autre du MÊME monde,
  // le compteur court de 3 à 543 px — ce qui varie, c'est ce qu'il y a DERRIÈRE la vitre (ciel
  // libre, mur d'en face à deux cubes, relief), pas la pluie. La médiane juge la pluie.
  const pieces = (mc.piecesDeMaisonSur?.(0, 0, 512, 512) || []).filter((r) => r.w >= 3 && r.d >= 3);
  const baies = [];
  const vues = new Set();
  for (const r of pieces) {
    if (baies.length >= 5) break;
    const c = r.cellules[Math.floor(r.cellules.length / 2)];
    const cle = `${c.wx},${c.wz}`;
    if (vues.has(cle)) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let k = 1; k <= 12; k++) {
        const id = mc.bloc(c.wx + dx * k, r.y + 1, c.wz + dz * k);
        if (id === 17 /* VERRE */) { baies.push({ x: c.wx, z: c.wz, y: r.y, dirX: dx, dirZ: dz, a: k, r }); vues.add(cle); break; }
        if (id !== 0) break;
      }
      if (vues.has(cle)) break;
    }
  }
  let piece = null;
  if (baies.length) {
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const vitres = [], murs = [];
    let rendu = null, clips = 0, gouttes = 0, resume = [];
    const enclosDe = (r, y) => {
      const cs = r.cellules;
      return {
        x0: Math.min(...cs.map((c) => c.wx)), x1: Math.max(...cs.map((c) => c.wx)) + 1,
        z0: Math.min(...cs.map((c) => c.wz)), z1: Math.max(...cs.map((c) => c.wz)) + 1,
        y0: y, y1: y + 3,
      };
    };
    for (const b of baies) {
      mc.camera.position.set(b.x + 0.5, b.y + 1.62, b.z + 0.5);
      mc.streamAll();                                  // flot à la NOUVELLE place de la caméra
      mc.reglerHeure(0.5, 1 / 60, frais());            // relance le relevé de pièce
      rendu = mc.pluie().rendu;
      if (rendu.piece.close && rendu.piece.clip === 1) clips++;
      const regarder = (dx, dz) => {
        mc.look(Math.round(Math.atan2(-dx, -dz) * 180 / Math.PI), 0);
        mc.reglerHeure(0.5, 1 / 60, frais());
        return pluieApport();
      };
      vitres.push(regarder(b.dirX, b.dirZ).touches);
      murs.push(regarder(-b.dirX, -b.dirZ).touches);
      gouttes += nuage(enclosDe(b.r, b.y)).dansLaPiece;
      resume.push(`${b.x},${b.y},${b.z}→${b.dirX},${b.dirZ}@${b.a}:${vitres[vitres.length - 1]}/${murs[murs.length - 1]}`);
    }
    piece = {
      rendu,
      baies: vitres.length,
      tousClips: clips === vitres.length,
      versVitre: { touches: med(vitres), total: 163840 },
      faceMur: { touches: med(murs), total: 163840 },
      gouttesDansLaPiece: gouttes,                     // lu par le contrôle : somme des pièces jugées
      baie: resume.join(' '),
    };
  }
  // La main rendue au monde : une averse laissée forcée tremperait toutes les mesures de ciel
  // prises plus bas dans la suite.
  mc.reglerPluie(mainPluie, 1 / 60, frais());
  mc.reglerVent(null, 1 / 60, frais());
  return { yaws, calme, portee, piece, pieces: pieces.length };
});

const giration = Math.max(...Object.values(averse.yaws).map((y) => Math.abs(y.pente - y.attendu)));
check('la traînée suit le vent du monde, pas l’orientation de la caméra',
  giration <= 0.02 && Math.abs(averse.calme.pente) <= 0.06 && Math.abs(averse.calme.sinusAuCap) <= 0.02,
  `écart max à la projection réelle ${giration.toFixed(3)} sur quatre orientations (${Object.entries(averse.yaws).map(([k, v]) => `${k}°:${v.pente}/${v.attendu}`).join(' ')}) · vent calme : pente ${averse.calme.pente}, vent ${averse.calme.vent.join('/')} à ${averse.calme.sinusAuCap} du cap`);

check('la pluie s’enfonce jusqu’à la brume rendue sans clairsemer le proche',
  // Le budget de gouttes a changé, pas la claim : ce contrôle juge l'**étendue** (jusqu'à la
  // brume rendue) et l'**absence de trou** dans le proche, pas la densité — la densité se juge
  // au contrôle ci-dessus. Plancher recalé sur le nouveau tirage : 10 400 points × 0,18 =
  // 1 872 gouttes peintes à pleine averse, mesurées 1 930 vivantes ; 1 500 laisse 20 % de jeu
  // sans autoriser un rideau à moitié éteint. Les ratios d'anneaux et la portée à la brume,
  // eux, n'ont pas bougé d'un poil depuis le rideau dense.
  averse.portee.vivants > 1500 && averse.portee.plusLoin >= 60
  && (averse.portee.seaux[3] + averse.portee.seaux[4]) > averse.portee.vivants * 0.10
  && (averse.portee.seaux[0] + averse.portee.seaux[1]) > averse.portee.vivants * 0.30
  && averse.portee.portee >= averse.portee.brume * 0.85,
  `${averse.portee.vivants} gouttes · anneaux de 15 cubes ${averse.portee.seaux.slice(0, 6).join('/')} · la plus loin à ${averse.portee.plusLoin} cubes · fondu à ${averse.portee.portee} pour une brume à ${averse.portee.brume} · boîtes ${JSON.stringify(averse.portee.boites)}`);

check('une pièce close ne se mouille pas',
  // Toutes les pièces jugées doivent être au sec : le clip doit tenir dans chacune, pas seulement
  // dans celle qui a eu de la chance à la génération.
  !!averse.piece && averse.piece.tousClips && averse.piece.gouttesDansLaPiece === 0
  && averse.piece.faceMur.touches <= 30,
  averse.piece ? `${averse.piece.baies} pièce(s) · ${averse.piece.gouttesDansLaPiece} goutte(s) laissée(s) dans leurs volumes · ${averse.piece.faceMur.touches} px remués face aux murs (médiane) · clip=${averse.piece.rendu.piece.close}/${averse.piece.rendu.piece.clip} rayon ${averse.piece.rendu.piece.rayon} plafond ${averse.piece.rendu.piece.plafond} · baies ${averse.piece.baie}` : `aucune pièce vitrée trouvée parmi ${averse.pieces}`);

check('et l’averse se voit par la baie vitrée',
  // Médiane de cinq baies, plancher 150 : sous le seuil du premier essai (194–272 px selon le
  // monde), le contrôle tirait à pile ou face. 150 reste dix fois au-dessus de ce que rend un
  // rideau vetoisé derrière la vitre (le mur d'en face donne 0 px) et le rapport × 4 porte la
  // claim « on voit pleuvoir DEHORS depuis dedans », pas la densité du rideau. C'est la marge la
  // plus étroite des contrôles de pluie : 20 % sous la mesure la plus basse observée à un
  // cinquième de densité (188 px sur quatre mondes jugés).
  !!averse.piece && averse.piece.versVitre.touches > 150
  && averse.piece.versVitre.touches > averse.piece.faceMur.touches * 4,
  `${averse.piece ? averse.piece.versVitre.touches : 0} px peints en médiane face aux baies (${averse.piece ? averse.piece.baies : 0} jugées) contre ${averse.piece ? averse.piece.faceMur.touches : 0} face aux murs (${averse.piece ? averse.piece.versVitre.total : 0} pixels échantillonnés)`);

// ---- l'orientation des traînées, lue sur ce que le GPU a peint ----
// Ce que la page COMMANDE aux gouttes (uniformes relus après `majCiel`) et ce que le vertex
// shader PROMET (rejoué cube par cube ci-dessus) laissent un trou : une dérive gravée dans le
// GLSL ne passe par aucun des deux. C'était exactement le fantôme vers l'est — la pluie partait
// de travers vent nul, la suite restait verte. Le tenseur de structure de l'image « pluie seule »
// (différence rendu avec / sans rideaux, centre du cadre) rend la pente apparente des traînées
// sans rien demander au produit : les seuils sont pris sur les mesures, loin d'elles.
const tracee = await page.evaluate(() => {
  const mc = window.__mc;
  const { frais } = window.__aide;
  const mainPluie = mc.pluie().force;
  mc.player.flyMode = true;
  mc.releaseAll();
  // Le point haut du voisinage, le regard levé à trente-cinq degrés : la seule pose qui donne
  // assez de gouttes nues dans la fenêtre d'analyse — au ras du sol, les silhouettes mangent
  // la moitié des pixels mouillés et la mesure n'est plus représentative.
  const x0 = Math.round(mc.camera.position.x), z0 = Math.round(mc.camera.position.z);
  let colline = { x: x0, z: z0, hh: -1 };
  for (let x = x0 - 48; x <= x0 + 48; x += 4) for (let z = z0 - 48; z <= z0 + 48; z += 4) {
    const hh = mc.getTerrainHeight(x, z);
    if (hh > colline.hh) colline = { x, z, hh };
  }
  mc.camera.position.set(colline.x + 0.5, colline.hh + 5.62, colline.z + 0.5);
  mc.player.velocity.set(0, 0, 0);
  mc.streamAll();
  mc.reglerPluie(0.9, 1 / 60, frais());
  const rideaux = () => {
    const out = [];
    mc.scene.traverse((o) => { if (o.name === 'pluie') out.push(o); });
    return out;
  };
  const gl = mc.renderer.getContext();
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  const tirer = () => {
    mc.renderer.render(mc.scene, mc.camera);
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const lum = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
  function pentePeinte() {
    const rs = rideaux();
    const etat = rs.map((o) => o.visible);
    rs.forEach((o) => { o.visible = true; });
    const avec = tirer();
    rs.forEach((o) => { o.visible = false; });
    const sans = tirer();
    rs.forEach((o, i) => { o.visible = etat[i]; });
    const xa = Math.floor(W * 0.3), xb = Math.ceil(W * 0.7);
    const ya = Math.floor(H * 0.3), yb = Math.ceil(H * 0.7);
    const D = new Float32Array(W * H);
    let mouilles = 0;
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
      const i = (y * W + x) * 4;
      const d = lum(avec, i) - lum(sans, i);
      D[y * W + x] = d;
      if (Math.abs(d) >= 8) mouilles++;
    }
    let Jxx = 0, Jxy = 0, n = 0;
    for (let y = ya + 2; y < yb - 2; y++) for (let x = xa + 2; x < xb - 2; x++) {
      const c = y * W + x;
      if (Math.abs(D[c]) < 8) continue;                       // les pixels mouillés seulement
      const gx = (D[c + 1] - D[c - 1]) * 0.5;
      const gy = (D[c + W] - D[c - W]) * 0.5;                 // ligne croissante = vers le haut
      Jxx += gx * gx; Jxy += gx * gy; n++;
    }
    // Une traînée de pente k a sa normale en (1, −k) : Jxy/Jxx rend k, dans le même sens que la
    // projection attendue une fois tenu compte de l'origine en bas de `readPixels`.
    return { mouilles, pixels: n, pente: n ? +(Jxy / Math.max(1e-6, Jxx)).toFixed(3) : null };
  }
  const cas = {};
  const mesurer = (tag, vent, yaw) => {
    mc.reglerVent(vent, 1 / 60, frais());
    mc.look(yaw, 35);
    mc.reglerHeure(0.5, 1 / 60, frais());
    const p = mc.pluie().rendu;
    const r = yaw * Math.PI / 180;
    const attendu = Math.max(-0.8, Math.min(0.8, (p.vent[0] * Math.cos(r) - p.vent[1] * Math.sin(r)) / 22));
    cas[tag] = { attendu: +attendu.toFixed(3), ...pentePeinte() };
  };
  mesurer('calmeAuNord', 0, 0);
  mesurer('calmeAuSud', 0, 180);
  mesurer('ventALEst', 1, 90);
  mesurer('ventALOuest', 1, 270);
  mc.reglerPluie(mainPluie, 1 / 60, frais());
  mc.reglerVent(null, 1 / 60, frais());
  return cas;
});

const lues = Object.values(tracee);
check('les traînées peintes suivent le vent, pas une dérive gravée dans le shader',
  lues.every((c) => c.mouilles >= 300 && c.pente !== null)
  // Vent quasi nul : les gouttes tombent à plomb dans l'image — aucune glissade latérale ne
  // doit s'y lire, fût-elle invisible aux uniformes. Vent établi : la pente peinte doit avoir
  // le signe de la projection du vent du monde et une amplitude franche.
  && Math.abs(tracee.calmeAuNord.pente) <= 0.07 && Math.abs(tracee.calmeAuSud.pente) <= 0.07
  && [tracee.ventALEst, tracee.ventALOuest].every((c) => Math.abs(c.attendu) >= 0.15
      && Math.sign(c.pente) === Math.sign(c.attendu) && Math.abs(c.pente) >= 0.08),
  lues.map((c, i) => `${Object.keys(tracee)[i]} ${c.pente} peinte contre ${c.attendu} attendue (${c.mouilles} px mouillés)`).join(' · '));

// ---- la pluie tombe en traits, pas en flocons ----
// Le 2026-11-18, le joueur a tranché : « il faudrait que la pluie soit moins épaisse, c'est très
// bien mais on dirait plus de la neige ». Deux chiffres disent l'un ou l'autre, et aucun ne se lit
// dans un uniforme : l'**allongement** d'une goutte peinte (rapport hauteur/largeur de sa composante
// connexe — la neige est à ~1, la pluie à 3 et plus) et l'**emprise** du rideau (la fraction de
// cadre qu'il barbouille). Mesurés sur l'averse d'avant reprise : allongement médian 1,67, largeur
// médiane 5 px jusqu'à 22 px de large, 4,6 % du cadre — un ciel de flocons. Après : 4,0 / 3 px /
// 1,37 % (`probe-neige.mjs`). Les seuils sont pris entre les deux états, jamais dessus.
const flocons = await page.evaluate(() => {
  const mc = window.__mc;
  const { auSec, frais, capture } = window.__aide;
  const main = mc.pluie().force;
  auSec();                                        // vue ouverte sur le ciel, sinon le toit mange tout
  mc.reglerHeure(0.5, 1 / 60, frais());           // midi : le rideau est à sa teinte la plus franche
  mc.reglerPluie(0.9, 1 / 60, frais());
  mc.look(0, 45);                                 // regard levé : des gouttes nues, pas des silhouettes
  const rideaux = [];
  mc.scene.traverse((o) => { if (o.name === 'pluie') rideaux.push(o); });
  const etat = rideaux.map((o) => o.visible);
  rideaux.forEach((o) => { o.visible = true; });
  const avec = capture();
  rideaux.forEach((o) => { o.visible = false; });
  const sans = capture();
  rideaux.forEach((o, i) => { o.visible = etat[i]; });
  mc.reglerPluie(main, 1 / 60, frais());          // main rendue au monde
  const lum = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
  const { w, h } = avec;
  const masque = new Uint8Array(w * h);
  let touches = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = (y * w + x) * 4;
    if (Math.abs(lum(avec.px, i) - lum(sans.px, i)) >= 8) { masque[y * w + x] = 1; touches++; }
  }
  const marque = new Uint8Array(w * h);
  const pile = new Int32Array(w * h);
  const asps = [], largeurs = [];
  let traits = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const d = y * w + x;
    if (!masque[d] || marque[d]) continue;
    let haut = y, bas = y, gauche = x, droite = x, aire = 0, bout = 0;
    pile[bout++] = d; marque[d] = 1;
    while (bout) {
      const c = pile[--bout];
      const cy = (c / w) | 0, cx = c - cy * w;
      aire++;
      if (cy > 1 && masque[c - w] && !marque[c - w]) { marque[c - w] = 1; pile[bout++] = c - w; }
      if (cy < h - 2 && masque[c + w] && !marque[c + w]) { marque[c + w] = 1; pile[bout++] = c + w; }
      if (cx > 1 && masque[c - 1] && !marque[c - 1]) { marque[c - 1] = 1; pile[bout++] = c - 1; }
      if (cx < w - 2 && masque[c + 1] && !marque[c + 1]) { marque[c + 1] = 1; pile[bout++] = c + 1; }
      if (cy < haut) haut = cy; if (cy > bas) bas = cy;
      if (cx < gauche) gauche = cx; if (cx > droite) droite = cx;
    }
    if (aire < 6) continue;                       // le point isolé n'est pas une traînée jugeable
    traits++;
    asps.push((bas - haut + 1) / Math.max(1, droite - gauche + 1));
    largeurs.push(droite - gauche + 1);
  }
  asps.sort((a, b) => a - b);
  largeurs.sort((a, b) => a - b);
  return {
    traits,
    emprise: +(100 * touches / (w * h)).toFixed(2),
    pxParTrait: traits ? +(touches / traits).toFixed(1) : 0,
    allongement: asps.length ? +asps[(asps.length / 2) | 0].toFixed(2) : 0,
    largeur: largeurs.length ? largeurs[(largeurs.length / 2) | 0] : 0,
    largeurMax: largeurs.length ? largeurs[largeurs.length - 1] : 0,
    densite: mc.pluie().rendu.densite,
  };
});

check('l’averse tombe en traits allongés, pas en flocons',
  // Seuils pris **entre** les deux états mesurés, pas dessus. Le flocon (`saboter pluie-neige`)
  // rend 1,5 d'allongement pour 10 px de large et jusqu'à 24 px ; la pluie relancée rend 3,2 à
  // 4,2 d'allongement pour 4–6 px de large et 10–11 px au maximum. La borne absolue de largeur
  // n'est là que pour les pâtés gros plan — ce qui fait la pluie, c'est le rapport.
  // L'ÉPAISSEUR se juge par trait et non sur le cadre entier : mesuré le 2026-11-18, l'emprise
  // court de 0,7 % à 2,6 % selon ce que la vue contient (plaine ouverte contre versant chargé de
  // gouttes — 77 traits d'un monde à 329 d'un autre), donc un plafond absolu rougissait tout seul.
  // La surface peinte par trait est d'échelle libre : 52 à 60 px en pluie, 127 en flocon.
  flocons.traits >= 30
  && flocons.allongement >= 2.5
  && flocons.largeur <= 8 && flocons.largeurMax <= 16
  && flocons.emprise >= 0.3
  && flocons.pxParTrait >= 20 && flocons.pxParTrait <= 95,
  `${flocons.traits} traits · allongement médian ${flocons.allongement} (neige ≈ 1, pluie ≥ 3) · `
  + `largeur médiane ${flocons.largeur} px, maximale ${flocons.largeurMax} px · `
  + `${flocons.pxParTrait} px peints par trait (flocon ≈ 127) · emprise ${flocons.emprise} % `
  + `(densité ${flocons.densite})`);

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

// ---- le gris qui précède les gouttes, à l'image ----
// Le coeur de la demande : « le ciel change avant et devient gris, puis il se met à
// pleuvoir ». Deux mesures au même cadre, à la même heure : un instant où le modèle porte
// du gris sans une goutte, et un instant sec. Si le rideau est peint sur la première image,
// ou si le ciel n'a pas baissé, le contrôle tombe.
const grisDevance = await page.evaluate(() => {
  const mc = window.__mc;
  const { auSec, frais, clarte } = window.__aide;
  mc.reglerMeteo('auto');
  let gris = null, sec = null;
  for (let j = 0; j <= 14; j += 0.01) {
    const e = mc.reglerMeteoTemps(j, 1 / 60, frais());
    if (e.intensite === 0 && e.couverture > (gris ? gris.couverture : 0.5)) gris = { t: j, couverture: e.couverture };
    if (!sec && e.couverture === 0 && e.degage === 0) sec = { t: j };
  }
  if (!gris || !sec) return { erreur: 'instant introuvable', gris, sec };
  const cadre = auSec();                       // une fois pour toutes : vue ouverte sur le ciel
  const lire = (t) => {
    mc.reglerMeteoTemps(t, 1 / 60, frais());
    mc.reglerHeure(0.5, 1 / 60, frais());
    mc.camera.rotation.set(-0.5, mc.camera.rotation.y, 0);
    const p = mc.pluie();
    return {
      t, clarte: clarte(), brume: p.rendu.brume, brumeSere: p.rendu.brumeSere,
      gouttes: p.rendu.peints, visible: p.rendu.visible, intensite: p.intensite,
      couverture: p.couverture, nuages: mc.nuages().map((n) => n.opacite),
    };
  };
  const s = lire(sec.t);
  const g = lire(gris.t);
  return { cadre, sec: s, gris: g };
});
check('le ciel grise à l’image avant qu’une seule goutte ne tombe',
  !grisDevance.erreur && grisDevance.gris.couverture > 0.5 && grisDevance.gris.intensite === 0
  && grisDevance.gris.gouttes === 0 && grisDevance.gris.visible === false
  && grisDevance.gris.clarte < grisDevance.sec.clarte - 8
  && grisDevance.gris.brume[0] < grisDevance.sec.brume[0] - 1
  && grisDevance.gris.nuages[0] > grisDevance.sec.nuages[0],
  grisDevance.erreur
    ? grisDevance.erreur
    : `cadre (${grisDevance.cadre?.x}, ${grisDevance.cadre?.y}, ${grisDevance.cadre?.z}) · sec à ${grisDevance.sec?.t} journée : clarté ${grisDevance.sec?.clarte}, brume ${grisDevance.sec?.brume.join('/')}, nappe ${grisDevance.sec?.nuages[0]} · gris à ${grisDevance.gris?.t} journée (couverture ${grisDevance.gris?.couverture}, ${grisDevance.gris?.gouttes} goutte) : clarté ${grisDevance.gris?.clarte}, brume ${grisDevance.gris?.brume.join('/')}, nappe ${grisDevance.gris?.nuages[0]}`);

// ---- les nuages avancent ----
// Un plan de nuages immobile est un plafond peint. La dérive se juge sur deux instants
// **figés** — `maintenant` est une valeur d'entrée, jamais l'horloge murale — et surtout
// en A/B : à vent faible et à vent fort, le déplacement doit suivre. Sans ce second terme,
// une constante de dérive héritée du monde d'avant passerait encore.
const derivee = await page.evaluate(() => {
  const mc = window.__mc;
  const { frais } = window.__aide;
  mc.reglerMeteo('jamais');                    // rien que le ciel ordinaire sous les yeux
  const mesure = (vent, t0) => {
    mc.reglerVent(vent, 1 / 60, t0);
    mc.reglerHeure(0.5, 1 / 60, t0);
    const a = mc.nuages()[0];
    mc.reglerHeure(0.5, 1 / 60, t0 + 120);     // deux minutes de ciel, horloge tenue
    const b = mc.nuages()[0];
    return {
      vent, derive: a.derive, opacite: a.opacite,
      du: +(b.offsetU - b.camX / a.tuile - (a.offsetU - a.camX / a.tuile)).toFixed(5),
      dv: +(b.offsetV + b.camZ / a.tuile - (a.offsetV + a.camZ / a.tuile)).toFixed(5),
    };
  };
  const calme = mesure(0.05, 1000);
  const fort = mesure(0.95, 1000);
  mc.reglerVent(null);
  const chemin = (d) => +Math.hypot(d.du, d.dv).toFixed(4);
  return { calme, fort, cheminCalme: chemin(calme), cheminFort: chemin(fort) };
});
check('les nuages avancent quand le temps passe, et plus vite quand le vent forcit',
  derivee.cheminCalme > 0.01 && derivee.cheminFort > 0.05
  && derivee.cheminFort > derivee.cheminCalme * 3
  && derivee.fort.derive > derivee.calme.derive * 3
  && derivee.fort.opacite > 0.02,
  `cent vingt secondes de ciel : ${derivee.cheminCalme} tuile à vent ${derivee.calme.vent} (dérive ${derivee.calme.derive}) contre ${derivee.cheminFort} à vent ${derivee.fort.vent} (dérive ${derivee.fort.derive}) · déplacement u=${derivee.fort.du} v=${derivee.fort.dv}`);

// ---- la journée sans un nuage ----
// « De temps en temps on a un ciel totalement bleue et le soleil brille ». Trois choses
// sont jugées à cadre figé : la nappe ne peint presque plus rien (comparaison voile retiré,
// la seule qui réponde de « découvert »), le bleu gagne du terrain, et la directe remonte.
const jourClair = await page.evaluate(() => {
  const mc = window.__mc;
  const { frais } = window.__aide;
  mc.reglerMeteo('auto');
  let tClair = 0, pic = 0, tOrd = null;
  for (let j = 0; j <= 14; j += 0.01) {
    const e = mc.reglerMeteoTemps(j, 1 / 60, frais());
    if (e.degage > pic) { pic = e.degage; tClair = j; }
    if (tOrd == null && e.couverture === 0 && e.degage === 0) tOrd = j;
  }
  const nappes = [];
  mc.scene.traverse((o) => { if (o.name === 'nuages') nappes.push(o); });
  // Le cadre se prend au point haut du voisinage, vol en marche, le regard levé à soixante
  // degrés : c'est la seule pose qui mette toute la nappe dans le champ. Au ras du sol sous
  // une couronne d'arbres, ou à trente degrés d'élévation, le rayon visuel ne rencontre le
  // plan qu'au-delà de son fondu lointain et la comparaison voile retiré ne répond plus de
  // rien. `mc.look` plutôt que la rotation brute : l'orientation est tenue par le joueur.
  mc.player.flyMode = true;
  mc.releaseAll();
  const x0 = Math.round(mc.camera.position.x), z0 = Math.round(mc.camera.position.z);
  let colline = { x: x0, z: z0, hh: -1 };
  for (let x = x0 - 48; x <= x0 + 48; x += 4) for (let z = z0 - 48; z <= z0 + 48; z += 4) {
    const hh = mc.getTerrainHeight(x, z);
    if (hh > colline.hh) colline = { x, z, hh };
  }
  mc.camera.position.set(colline.x + 0.5, colline.hh + 1.62, colline.z + 0.5);
  mc.player.velocity.set(0, 0, 0);
  for (let i = 0; i < 4; i++) mc.step(1 / 120);      // le ciel se recentre sur la caméra
  const cadre = [colline.x, colline.hh, colline.z];
  const lum = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
  const BANDE = (img) => [Math.floor(img.h * 0.5), Math.floor(img.h * 0.9)];
  const statsDe = (img) => {
    let s = 0, bleus = 0, n = 0, r = 0, v = 0, b = 0;
    const [y0, y1] = BANDE(img);
    // `readPixels` rend l'image la ligne zéro en bas : la bande 0,5 → 0,9 est bien le haut du cadre.
    for (let y = y0; y < y1; y++) for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      s += lum(img.px, i); r += img.px[i]; v += img.px[i + 1]; b += img.px[i + 2];
      if (img.px[i + 2] > img.px[i] + 25) bleus++;          // le bleu l'emporte largement
      n++;
    }
    return {
      clarte: +(s / Math.max(1, n)).toFixed(2), bleus: +(100 * bleus / Math.max(1, n)).toFixed(1),
      // La teinte moyenne de la bande, pas celle du modèle : si le cadre vise autre chose que
      // le ciel, c'est ici que ça se voit avant d'incriminer la météo.
      teinte: `${(r / Math.max(1, n)) | 0},${(v / Math.max(1, n)) | 0},${(b / Math.max(1, n)) | 0}`,
      // Le bleu qu'il y a réellement dans l'image, mesuré comme un écart et non au comptage :
      // un seuil par pixel ne dit rien du voile laiteux qui, sans franchir la barre, retire
      // déjà sa profondeur au ciel.
      bleuNet: +((b - r) / Math.max(1, n)).toFixed(1),
    };
  };
  // Le modèle lu séparément : `mc.ciel()` et `mc.nuages()` sont purs, ils ne repeignent rien.
  const modele = () => {
    const e = mc.ciel();
    return {
      ciel: '#' + (e.ciel >>> 0).toString(16).padStart(6, '0'),
      directe: e.directe.intensite, degage: e.degage || 0,
      nuages: mc.nuages().map((nn) => nn.opacite),
    };
  };
  // Ce que les nappes mettent dans la bande : leur écart moyen, et surtout l'**emprise** —
  // la fraction de pixels qu'elles marquent vraiment. L'écart seul se laisse tromper par la
  // taille des flocons ; l'emprise dit si le ciel est couvert ou découvert.
  const comparer = (avec, sans) => {
    let s = 0, marques = 0, n = 0, plusFort = 0, ca = 0, cs = 0;
    const [y0, y1] = BANDE(avec);
    for (let y = y0; y < y1; y++) for (let x = 0; x < avec.w; x++) {
      const i = (y * avec.w + x) * 4;
      const la = lum(avec.px, i), ls = lum(sans.px, i);
      const d = Math.abs(la - ls);
      s += d; if (d >= 8) marques++; if (d > plusFort) plusFort = d;
      ca += la; cs += ls; n++;
    }
    return {
      ecart: +(s / Math.max(1, n)).toFixed(2), emprise: +(100 * marques / Math.max(1, n)).toFixed(1),
      plusFort, clarteAvec: +(ca / Math.max(1, n)).toFixed(2), clarteSans: +(cs / Math.max(1, n)).toFixed(2),
    };
  };
  const avecNappe = (t) => {
    // Le rideau se retire de l'IMAGE, pas du modèle : `reglerPluie(0)` imposerait aussi
    // l'épaisseur des nappes à son plancher (0,55) et le « ciel découvert » cesserait de
    // l'être — mesuré, l'apport du voile y passait de 4,3 à 24,4. Masquer les deux rideaux
    // laisse la météo dire ce qu'elle veut ; leur temps ne bouge pas entre les deux cadres,
    // donc ce qui reste de gouttes se retranche exactement.
    const rideaux = [];
    mc.scene.traverse((o) => { if (o.name === 'pluie') rideaux.push(o); });
    const etatAvant = rideaux.map((o) => o.visible);
    // Trois instants de la MÊME journée, espacés de vingt secondes de ciel, retenus par
    // médiane. À un instant unique le chiffre dépend du floquet qui passe au-dessus du
    // cadre : mesuré, le même régime dégagé rendait 0,74 d'apport moyen ici et 4,32 là
    // selon l'avance de l'horloge — de quoi faire tomber un contrôle qui dit vrai.
    const echantillons = [];
    let horloge = frais();
    for (let k = 0; k < 3; k++) {
      horloge += 20;                                        // jamais remise en arrière
      mc.reglerMeteoTemps(t, 1 / 60, horloge);
      mc.reglerHeure(0.5, 1 / 60, horloge);
      rideaux.forEach((o) => { o.visible = false; });        // `majCiel` vient de les rallumer
      mc.look(0, 70);
      const avec = window.__aide.capture();
      for (const nn of nappes) nn.visible = false;           // majCiel n'est pas rappelée ici
      const sans = window.__aide.capture();
      for (const nn of nappes) nn.visible = true;
      echantillons.push({ ...comparer(avec, sans), stats: statsDe(avec), statsSans: statsDe(sans) });
    }
    rideaux.forEach((o, k) => { o.visible = etatAvant[k]; });   // main rendue au monde
    const med = (f) => { const v = echantillons.map(f).sort((a, b) => a - b); return v[1]; };
    return {
      ecart: +med((s) => s.ecart).toFixed(2),
      emprise: +med((s) => s.emprise).toFixed(1),
      plusFort: Math.max(...echantillons.map((s) => s.plusFort)),
      clarteAvec: med((s) => s.clarteAvec), clarteSans: med((s) => s.clarteSans),
      avec: { ...modele(), ...echantillons[1].stats },
      // Le dôme seul, voile retiré : la teinte d'une nappe dépend de sa forme (cumulus
      // clairsemé, stratus étiré et bandé, cirrus filandreux), donc tout ce qui compare deux
      // instants **avec** les nappes laisse la marge à la merci du nuage tiré par la graine
      // du monde. Mesuré le 2026-11-18 : 112,3 de bleu net pour un stratus en place, 137,3
      // pour un cumulus, même produit, même instant — de quoi faire rougir un contrôle vrai.
      sans: echantillons[1].statsSans,
      bleuNetSans: med((s) => s.statsSans.bleuNet),
    };
  };
  const ordinaire = avecNappe(tOrd);
  const clair = avecNappe(tClair);
  return { tClair, pic, tOrd, cadre, ordinaire, clair };
});
check('une journée sans un nuage découvre vraiment le ciel',
  jourClair.pic > 0.7 && jourClair.clair.avec.degage > 0.7
  // Un jour ordinaire, la nappe tient la moitié haute du cadre ; le jour dégagé, elle ne
  // doit plus ni l'éclaircir (écart moyen) ni la couvrir (emprise). Les deux chiffres sont
  // pris en médiane sur trois instants, et les seuils laissés loin des mesures — 10,9 et
  // 37 % d'un côté, 0,7 et 0 % de l'autre — pour qu'aucun floquet solitaire ne décide seul.
  && jourClair.ordinaire.emprise > 15 && jourClair.ordinaire.ecart > 2
  && jourClair.clair.emprise <= 5 && jourClair.clair.ecart <= jourClair.ordinaire.ecart * 0.35
  && jourClair.clair.avec.nuages[0] < jourClair.ordinaire.avec.nuages[0] * 0.4,
  `à ${jourClair.tOrd} journée le voile tient ${jourClair.ordinaire.emprise} % de la bande et y ajoute ${jourClair.ordinaire.ecart} de luminance (${jourClair.ordinaire.clarteAvec} contre ${jourClair.ordinaire.clarteSans} retiré, jusqu'à ${jourClair.ordinaire.plusFort} par pixel) ; à ${jourClair.tClair}, régime ${jourClair.clair.avec.degage} : ${jourClair.clair.emprise} % et ${jourClair.clair.ecart} (${jourClair.clair.clarteAvec} contre ${jourClair.clair.clarteSans}, jusqu'à ${jourClair.clair.plusFort}) · nappe ${jourClair.ordinaire.avec.nuages[0]} → ${jourClair.clair.avec.nuages[0]}`);

check('et le soleil y brille davantage, dans un ciel plus bleu',
  jourClair.clair.avec.directe > jourClair.ordinaire.avec.directe + 0.02
  && jourClair.clair.avec.ciel !== jourClair.ordinaire.avec.ciel
  // Le bleu se juge sur le dôme, voile retiré des deux côtés, et en absolu plutôt qu'en
  // marge : la teinte d'une nappe dépend de sa forme, donc l'ancienne marge de 8 entre deux
  // instants rendait l'issue au nuage tiré par la graine du monde (mesuré 112,3 contre 137,3
  // de bleu net pour le seul produit, selon stratus ou cumulus en place). Un régime dégagé
  // doit rendre la bande franchement bleue d'elle-même, et jamais moins bleue que le ciel
  // ordinaire.
  && jourClair.clair.sans.bleuNet > 120 && jourClair.clair.sans.bleus > 90
  && jourClair.clair.bleuNetSans >= jourClair.ordinaire.bleuNetSans,
  `directe ${jourClair.ordinaire.avec.directe} → ${jourClair.clair.avec.directe} · zénith ${jourClair.ordinaire.avec.ciel} → ${jourClair.clair.avec.ciel} · bleu du dôme voiles retirés ${jourClair.ordinaire.bleuNetSans} → ${jourClair.clair.bleuNetSans} (${jourClair.ordinaire.sans.teinte} → ${jourClair.clair.sans.teinte}) · bleu net du ciel dégagé ${jourClair.clair.sans.bleuNet}, pixels franchement bleus ${jourClair.clair.sans.bleus} % · avec voiles ${jourClair.ordinaire.avec.bleuNet} → ${jourClair.clair.avec.bleuNet}`);

// ==================== 5. LE CIEL QUI CHANGE ====================
// Quatre griefs du 2026-11-18, jugés chacun par ce qui peut seul l'affirmer : l'heure des
// averses se lit dans le modèle, le gris et le sombre se lisent à l'image, les formes de
// nuages se lisent sur les couches posées au ciel, et la pluie qui ne doit pas entrer dans
// une maison se lit aux gouttes réellement placées sous un toit.

/** Heure du monde (0 = minuit) à une journée météo : les deux horloges courent ensemble. */
const heureDe = (t) => (((t + C.HEURE_DEPART) % 1) + 1) % 1;
const enJour = (h) => h >= 0.28 && h <= 0.72;

const rythmeJour = [424242, 7, 1337].map((sel) => {
  const vagues = releverAverses(M.creerMeteo({ sel }), 30, 0.002);
  const heures = vagues.map((v) => heureDe((v.debut + v.fin) / 2));
  let pairesDeNuit = 0;
  for (let i = 1; i < heures.length; i++) if (!enJour(heures[i - 1]) && !enJour(heures[i])) pairesDeNuit++;
  return { sel, n: vagues.length, jour: heures.filter(enJour).length, pairesDeNuit,
           heures: heures.map((h) => +h.toFixed(2)) };
});
check('il pleut aussi en journée : jamais deux averses de suite sans une de jour',
  rythmeJour.every((r) => r.n >= 6 && r.pairesDeNuit === 0 && r.jour >= Math.ceil(r.n / 2)),
  rythmeJour.map((r) => `graine ${r.sel} : ${r.jour}/${r.n} de jour, ${r.pairesDeNuit} paire(s) de nuit (${r.heures.join(' ')})`).join(' · '));

const etatsDuCiel = (() => {
  const m = M.creerMeteo({ sel: 424242 });
  const vu = { bleu: 0, gris: 0, plomb: 0, ordinaire: 0, formes: new Set(), plombSec: null, melange: 0 };
  for (let i = 0; i * 0.005 < 30; i++) {
    const e = m.reglerTemps(i * 0.005);
    vu.formes.add(e.forme);
    if ((e.degage || 0) > 0.6) vu.bleu++;
    if ((e.sombre || 0) > 0.5) vu.plomb++;
    if ((e.couverture || 0) > 0.45) vu.gris++;
    if (!(e.degage > 0.6) && !(e.sombre > 0.5) && !(e.couverture > 0.45)) vu.ordinaire++;
    // Le plomb doit exister sans averse, sinon ce n'est qu'une pluie mal éclairée.
    if (vu.plombSec == null && (e.sombre || 0) > 0.6 && (e.couverture || 0) < 0.05) vu.plombSec = i * 0.005;
    if ((e.sombre || 0) > 0.3 && (e.degage || 0) > 0.3) vu.melange++;
  }
  return { ...vu, formes: [...vu.formes] };
})();
check('le ciel prend quatre états : bleu franc, gris, plomb, ordinaire',
  etatsDuCiel.bleu > 100 && etatsDuCiel.gris > 100 && etatsDuCiel.plomb > 100 && etatsDuCiel.ordinaire > 100
  && etatsDuCiel.melange === 0,
  `sur trente journées : bleu ${etatsDuCiel.bleu} · gris ${etatsDuCiel.gris} · plomb ${etatsDuCiel.plomb} · ordinaire ${etatsDuCiel.ordinaire} · bleu et plomb simultanés ${etatsDuCiel.melange}`);

check('un ciel de plomb vient sans une seule goutte',
  etatsDuCiel.plombSec != null && etatsDuCiel.plombSec < 20,
  `plafond bas à sec tenu à ${etatsDuCiel.plombSec} journée`);

check('les nuages changent de forme au fil du temps',
  JSON.stringify(etatsDuCiel.formes.slice().sort()) === JSON.stringify(['cirrus', 'cumulus', 'stratus']),
  `formes vues sur trente journées : ${etatsDuCiel.formes.sort().join(', ')}`);

check('le ciel ordinaire reste rendu tel quel, plomb compris', (() => {
  const brut = C.etatDuCiel(0.5);
  return M.habillerCiel(brut, { couverture: 0, intensite: 0, degage: 0, sombre: 0 }) === brut;
})(), 'à régime nul, l’objet du ciel est rendu sans copie ni arrondi');

// Le gris, mesuré à l'image : même cadre, même heure, averse imposée contre temps sec.
const grisMesure = await page.evaluate(() => {
  const mc = window.__mc;
  const { frais, capture } = window.__aide;
  mc.player.flyMode = true;
  mc.releaseAll();
  mc.image(true);
  const x0 = Math.round(mc.camera.position.x), z0 = Math.round(mc.camera.position.z);
  let colline = { x: x0, z: z0, hh: -1 };
  for (let x = x0 - 48; x <= x0 + 48; x += 4) for (let z = z0 - 48; z <= z0 + 48; z += 4) {
    const hh = mc.getTerrainHeight(x, z);
    if (hh > colline.hh) colline = { x, z, hh };
  }
  mc.camera.position.set(colline.x + 0.5, colline.hh + 6, colline.z + 0.5);
  mc.player.setEye(colline.x, colline.hh + 4.4, colline.z);
  mc.player.velocity.set(0, 0, 0);
  mc.streamAll();
  const lum = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
  const juger = () => {
    const img = capture();
    let s = 0, bleus = 0, n = 0, r = 0, v = 0, b = 0;
    for (let y = Math.floor(img.h * 0.45); y < Math.floor(img.h * 0.92); y++) {
      for (let x = 0; x < img.w; x++) {
        const i = (y * img.w + x) * 4;
        s += lum(img.px, i); r += img.px[i]; v += img.px[i + 1]; b += img.px[i + 2];
        if (img.px[i + 2] > img.px[i] + 25) bleus++;
        n++;
      }
    }
    const e = mc.ciel();
    return {
      clarte: +(s / n).toFixed(1), bleus: +(100 * bleus / n).toFixed(1),
      bleuNet: +((b - r) / n).toFixed(1),
      teinte: `${(r / n) | 0},${(v / n) | 0},${(b / n) | 0}`,
      zenith: '#' + (e.ciel >>> 0).toString(16).padStart(6, '0'),
      directe: e.directe.intensite, ambiante: e.ambiante.intensite,
      nappe: mc.nuages()[0].opacite, couche: mc.nuages()[0].couche,
    };
  };
  const lire = (mode, t) => {
    mc.reglerMeteo(mode);
    mc.reglerMeteoTemps(t, 1 / 60, frais());
    mc.reglerHeure(0.5, 1 / 60, frais());     // midi pile : l'heure où l'on regarde le ciel
    mc.look(0, 55);
    return juger();
  };
  const sec = lire('jamais', 3);
  const mouille = lire('toujours', 3);
  mc.reglerMeteo('auto');
  return { sec, mouille, cadre: [colline.x, colline.hh, colline.z] };
});
check('à midi sous l’averse, le ciel est gris et sombre, pas bleu lavé',
  // Mesuré avant la reprise : 141,9 de clarté pour 159,5 au sec, 84 % de pixels franchement
  // bleus, zénith #597088 — un voile pâle, pas un plafond. Les seuils visent le ciel demandé
  // et restent loin des mesures (85,3 de clarté, 63,7 % de bleus aujourd'hui).
  grisMesure.mouille.clarte < grisMesure.sec.clarte * 0.65
  && grisMesure.mouille.bleus < 75
  && grisMesure.mouille.bleuNet < grisMesure.sec.bleuNet * 0.5
  && grisMesure.mouille.directe < 0.2 && grisMesure.mouille.nappe > 0.7
  && grisMesure.sec.clarte > 120 && grisMesure.sec.bleus > 95,
  `midi sec ${grisMesure.sec.clarte} de clarté, ${grisMesure.sec.bleus} % de bleus, zénith ${grisMesure.sec.zenith} (${grisMesure.sec.teinte}) → averse ${grisMesure.mouille.clarte}, ${grisMesure.mouille.bleus} %, ${grisMesure.mouille.zenith} (${grisMesure.mouille.teinte}), directe ${grisMesure.mouille.directe}, nappe ${grisMesure.mouille.nappe} · cadre ${grisMesure.cadre}`);

// Deux nappes portant la même texture, c'est un nuage peint deux fois.
const formesCouches = await page.evaluate(() => {
  const mc = window.__mc;
  const { frais } = window.__aide;
  const vues = {};
  for (const f of ['cumulus', 'stratus', 'cirrus']) {
    // La forme vient d'un bruit lent du modèle : on la cherche à une journée où le modèle
    // la donne, puis on relit les couches réellement habillées.
    let trouve = null;
    for (let j = 0; j <= 30 && !trouve; j += 0.05) {
      const e = mc.reglerMeteoTemps(j, 1 / 60, frais());
      if (e.forme === f) trouve = j;
    }
    if (trouve == null) { vues[f] = null; continue; }
    mc.reglerMeteoTemps(trouve, 1 / 60, frais());
    mc.reglerHeure(0.5, 1 / 60, frais());
    const n = mc.nuages();
    vues[f] = { basse: n[0].forme, haute: n[1].forme, carteBasse: n[0].carte, carteHaute: n[1].carte };
  }
  return vues;
});
check('les deux couches du ciel ne portent pas le même nuage',
  Object.values(formesCouches).every((v) => v)
  && Object.values(formesCouches).every((v) => v.carteBasse !== v.carteHaute)
  && new Set(Object.values(formesCouches).map((v) => v.carteBasse)).size === 3,
  Object.entries(formesCouches).map(([f, v]) => `${f}→${v ? `${v.basse}/${v.haute}` : 'absent'}`).join(' · '));

// La maison vue de la rue. Les intérieurs sont reconstitués indépendamment du jeu — plans
// du village pour l'emprise, blocs du monde pour le plancher, le toit et les murs — et les
// gouttes sont replacées en rejouant le vertex shader. Ce que le jeu retire est lu à ses
// propres uniformes : si les enveloppes disparaissaient, plus rien ne retirerait ces gouttes
// et le contrôle tomberait.
const maisons = await page.evaluate(() => {
  const mc = window.__mc;
  const { frais } = window.__aide;
  mc.player.flyMode = true;
  mc.releaseAll();
  mc.image(true);
  mc.reglerMeteo('toujours');
  mc.reglerPluie(0.9, 1 / 60, frais());
  mc.reglerVent(0.25, 1 / 60, frais());
  mc.streamAll();
  const rx = Math.round(mc.camera.position.x), rz = Math.round(mc.camera.position.z);
  const bid = (x, y, z) => mc.bloc(Math.floor(x), Math.floor(y), Math.floor(z));
  const rideaux = [];
  mc.scene.traverse((o) => { if (o.name === 'pluie') rideaux.push(o); });
  // Le monde des suites est tiré au hasard à chaque lancement et le joueur naît dans un
  // temple : la maison la plus proche peut être à trois cents cubes, hors du tronçon
  // chargé. On se déplace donc vers les plus grandes pièces trouvées, tronçon par tronçon,
  // plutôt que de filtrer sur la position d'ouverture — jugé sans ça, zéro pièce n'était
  // chargée et le contrôle passait sur le vide.
  const loin = (mc.piecesDeMaisonSur?.(rx - 220, rz - 220, rx + 220, rz + 220) || [])
    .filter((p) => p.cellules && p.cellules.length >= 6)
    .sort((a, b) => b.cellules.length - a.cellules.length);
  let brutes = 0, laissees = 0, jugees = 0, essayees = 0;
  const temoins = [];
  for (const p of loin) {
    if (jugees >= 3 || essayees >= 12) break;
    essayees++;
    const xs = p.cellules.map((c) => c.wx), zs = p.cellules.map((c) => c.wz);
    const x0 = Math.min(...xs), x1 = Math.max(...xs) + 1;
    const z0 = Math.min(...zs), z1 = Math.max(...zs) + 1;
    const cx = Math.floor((x0 + x1) / 2), cz = Math.floor((z0 + z1) / 2);
    // On atterrit d'abord dans la pièce pour peupler le tronçon, puis on ressort.
    mc.camera.position.set(cx + 0.5, p.y + 1.62, cz + 0.5);
    mc.player.setEye(cx, p.y, cz);
    mc.player.velocity.set(0, 0, 0);
    mc.streamAll();
    if (!mc.blocOpaque(bid(cx, p.y - 1, cz))) continue;               // pas de plancher : pas une pièce
    let t = 0;
    for (let k = 1; k <= 12; k++) if (bid(cx, p.y + k, cz) !== 0) { t = k; break; }
    if (t < 3) continue;                                              // pas de toit au-dessus de la tête
    let murs = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let k = 1; k <= 10; k++) if (mc.blocOpaque(bid(cx + dx * k, p.y + 1, cz + dz * k))) { murs++; break; }
    }
    if (murs < 3) continue;                                           // une cour ouverte n'est pas un toit
    // Dehors, à quinze cubes, et surtout hors de toute pièce reconnue : le clip de pièce
    // ferait passer le contrôle pour rien s'il était actif pendant la mesure.
    let pose = null;
    for (const d of [15, 20, 25]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ex = cx + dx * d, ez = cz + dz * d;
      if (bid(ex, p.y + 1, ez) !== 0 || bid(ex, p.y + 2, ez) !== 0) continue;
      mc.camera.position.set(ex, p.y + 1.62, ez);
      mc.player.setEye(ex, p.y, ez);
      mc.player.velocity.set(0, 0, 0);
      mc.look(Math.round(Math.atan2(-(cx - ex), -(cz - ez)) * 180 / Math.PI), 0);
      mc.streamAll();
      mc.reglerHeure(0.5, 1 / 60, frais());
      mc.reglerHeure(0.5, 1 / 60, frais());
      if (mc.pluie().rendu.piece.clip !== 0) continue;
      pose = { ex, ez, d };
      break;
    }
    if (!pose) continue;
    let dansLaMaison = 0, nonRetirees = 0;
    for (const o of rideaux) {
      const u = o.material.uniforms, B = u.uBoite.value, tt = u.uTemps.value;
      const vx = u.uVent.value.x, vz = u.uVent.value.y, houle = u.uHoule.value;
      const pos = o.geometry.attributes.position.array;
      const vit = o.geometry.attributes.aVitesse.array;
      const graine = o.geometry.attributes.aGraine.array;
      const ch = u.uChambre.value, clip = u.uDedans.value;
      const bA = u.uIntA.value, bB = u.uIntB.value, bN = u.uIntN.value;
      for (let i = 0; i < vit.length; i++) {
        // PAS de filtre sur `uDensite` ici, contrairement au relevé de portée : le veto est
        // **positionnel**, le shader retire une goutte par sa place, qu'elle soit tirée ou non
        // par le seuil de densité. Juger tous les points reste fidèle au produit et rend au
        // contrôle sa puissance statistique — à un quart de densité, 2 gouttes seulement
        // tombaient dans les volumes jugés, contre 27 avec le rideau dense d'avant.
        const g = 0.6 + 0.8 * graine[i];
        const houle2 = Math.sin(tt * 0.9 + graine[i] * 6.2831853) * houle;
        const lx = ((pos[i * 3] + tt * vx * g + houle2 + B.x * 0.5) % B.x + B.x) % B.x - B.x * 0.5;
        const ly = ((pos[i * 3 + 1] - tt * vit[i] + B.y * 0.5) % B.y + B.y) % B.y - B.y * 0.5;
        const lz = ((pos[i * 3 + 2] + tt * vz * g + houle2 * 0.7 + B.z * 0.5) % B.z + B.z) % B.z - B.z * 0.5;
        const wx = o.position.x + lx, wy = o.position.y + ly, wz = o.position.z + lz;
        if (wx < x0 || wx > x1 || wz < z0 || wz > z1 || wy < p.y || wy > p.y + t) continue;
        dansLaMaison++;
        let retiree = clip > 0.5 && wy < ch.y && (wx - ch.x) ** 2 + (wz - ch.z) ** 2 < ch.w ** 2;
        for (let k = 0; !retiree && k < bN; k++) {
          const a = bA[k], c = bB[k];
          if (wx >= a.x && wx <= c.x && wy >= a.y && wy <= c.y && wz >= a.z && wz <= c.z) retiree = true;
        }
        if (!retiree) nonRetirees++;
      }
    }
    brutes += dansLaMaison; laissees += nonRetirees; jugees++;
    temoins.push(`${cx},${cz} ${x1 - x0}×${z1 - z0} h${t}${nonRetirees ? ` ⚠${nonRetirees}` : ''}`);
  }
  mc.reglerPluie(null, 1 / 60, frais());
  mc.reglerVent(null, 1 / 60, frais());
  mc.reglerMeteo('auto');
  return { jugees, brutes, laissees, temoins };
});
check('vue de la rue, une maison ne se remplit pas de pluie',
  // Sans les enveloppes d'intérieur, ces mêmes gouttes restaient peintes à travers les
  // baies : six sur six dans une maison de 12×4, onze sur onze dans un corps de 3×11,
  // mesuré depuis le trottoir. `brutes > 0` prouve que le contrôle porte sur des gouttes
  // qui existent vraiment dans ces volumes.
  maisons.jugees >= 2 && maisons.brutes > 0 && maisons.laissees === 0,
  `${maisons.jugees} maison(s) jugée(s) [${maisons.temoins.join(' ')}] · ${maisons.brutes} goutte(s) dans leur volume, ${maisons.laissees} non retirée(s)`);

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
