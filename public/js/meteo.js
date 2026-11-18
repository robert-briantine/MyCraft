/**
 * La pluie et le ciel qui l'annonce — un modèle pur de la météo, à l'image de `ciel.js`.
 *
 * Rien ici ne touche Three.js ni le DOM : une averse est une fonction du temps écoulé
 * depuis l'ouverture du monde, donc la suite Node juge les épisodes, leurs rampes et
 * leurs intensités exactement comme le navigateur les consommera. C'est aussi ce qui
 * permet de faire défiler trois journées dans un test plutôt que d'attendre vingt-quatre
 * minutes d'horloge réelle.
 *
 * Cinq décisions portent le dispositif, et aucune ne se lit dans le code seul :
 *
 *  - **L'averse est un épisode, pas un tirage par image.** Une date de début et une
 *    durée sont tirées pour chaque épisode, puis on saute à la suivante. Un tirage
 *    indépendant par frame donnerait un ciel qui grésille entre clair et couvert.
 *  - **Le premier épisode vient tôt, les suivants gardent leur rythme.** Le joueur qui
 *    demande la pluie veut la voir dans la session, pas à la troisième journée : la
 *    première averse tombe avant une journée de monde. Ensuite, le rythme convenu
 *    (deux à trois journées entre deux départs) reprend.
 *  - **Le gris devance les gouttes, et leur survit.** `couverture` et `intensite` sont
 *    deux enveloppes distinctes : le ciel grise `COUVERTURE_AVANT` journée avant la
 *    première goutte et met `ECLAIRCIE_APRES` journée à rendre son bleu après la
 *    dernière. Les confondre — un seul signal pour le dôme et le rideau — donnait un
 *    orage qui « tombait » du ciel bleu, ce que l'utilisateur décrivait comme « il
 *    faudrait que le ciel change avant ».
 *  - **Des journées sans un nuage.** `degage` est un régime programmé, à l'image des
 *    averses : la nappe se retire, le bleu se ferme, le soleil reprend de la vigueur.
 *    Le premier de ces régimes est **retardé** au-delà de `PREMIERE_ECLAIRCIE.min` —
 *    les suites jugent l'exposition du plein jour sur les valeurs exactes du monde
 *    d'avant, et une éclaircie dès l'ouverture les déplacerait.
 *  - **Sans averse et sans éclaircie, rien ne bouge.** `cielSousPluie` et `cielDegage`
 *    rendent l'état reçu tel quel à intensité nulle — pas une copie, pas un arrondi. Les
 *    contrôles d'exposition de `tests/render-collision.mjs` jugent le plein jour à 0,72
 *    d'ambiante et 0,5 de directe : ils ne tiennent que si le beau temps ordinaire est
 *    exactement le ciel d'avant.
 */

import { melangeCouleur, HEURE_DEPART } from './ciel.js';

/** Les trois positions du réglage joueur. */
export const METEO_MODES = ['auto', 'jamais', 'toujours'];

/** Journées de monde entre deux départs d'épisode (rythme convenu). */
export const EPISODE_TOUS = { min: 2.0, max: 3.0 };
/** Le premier épisode est avancé : avant une journée de monde, sinon personne ne le voit. */
export const PREMIER_EPISODE = { min: 0.3, max: 0.8 };
/** Durée d'une averse, en fraction de journée. */
export const DUREE_EPISODE = { min: 0.25, max: 0.40 };
/** Part de la durée employée à monter, et à redescendre : une averse ne tombe pas d'un coup. */
export const RAMPE = 0.16;
/** Une averse automatique n'est jamais tout à fait opaque — le ciel doit rester lisible. */
export const PLAFOND_INTENSITE = 0.92;
/** Et jamais anémique : sous ce seuil, on parlerait de bruine, pas d'averse. */
export const PLANCHER_INTENSITE = 0.55;

// ---- la pluie de journée ----------------------------------------------------
// L'utilisateur, le 2026-11-18 : « il doit aussi pleuvoir en journée ». Mesuré sur trente
// journées, les averses tombaient réparties comme le hasard les donne : 528 relevés de
// jour contre 744 de nuit, soit exactement la part du jour dans le cycle (41 %). Rien
// n'était cassé — mais une averse tous les deux jours et demi avec deux chances sur cinq
// de tomber de jour, cela fait des sessions entières sans une goutte à la lumière. Un
// épisode sur deux se cale donc dans la fenêtre claire, tiré à l'intérieur de cette
// fenêtre pour qu'ils ne démarrent pas tous à la même heure.
/** Fenêtre d'heure (0 = minuit, 1 = minuit suivante) où un épisode sur deux se tient. */
export const JOUR_PLUIE = { min: 0.30, max: 0.62 };
/** Un épisode sur `EPISODE_JOUR_TOUS` est calé en journée. */
export const EPISODE_JOUR_TOUS = 2;

// ---- le gris qui précède les gouttes ---------------------------------------
// L'utilisateur : « quand il pleut, le ciel doit changer avant et devenir gris, puis il
// se met à pleuvoir ; quand la pluie s'arrête progressivement le ciel revient ». Une
// seule enveloppe ne sait pas le dire — elle griserait le ciel à la seconde même où la
// première goutte tombe. D'où deux marges, plus larges à la sortie qu'à l'entrée : un
// ciel qui met une minute à se découvrir ressemble à une pluie qui finit, un ciel qui
// met une minute à se couvrir annonce l'averse.
/** Journée de monde pendant laquelle le ciel grise avant les premières gouttes. */
export const COUVERTURE_AVANT = 0.10;
/** Journée de monde pendant laquelle il garde son plafond après la dernière. */
export const ECLAIRCIE_APRES = 0.14;
/** Part de chaque marge employée en S ; le reste est tenu au plafond. */
export const RAMPE_COUVERTURE = 0.75;
/** L'averse respire pendant son plateau : deux creux jusqu'à (1 - RESPIRATION) du pic. */
export const RESPIRATION = 0.16;

// ---- les journées sans un nuage ---------------------------------------------
/** Le premier régime dégagé est retardé : l'ouverture du monde reste le ciel d'avant. */
export const PREMIERE_ECLAIRCIE = { min: 0.5, max: 0.9 };
/** Journées de monde entre deux régimes dégagés. */
export const CYCLE_ECLAIRCIE = { min: 1.4, max: 2.6 };
/** Durée d'un régime dégagé, en fraction de journée. */
export const DUREE_ECLAIRCIE = { min: 0.30, max: 0.55 };
/** Une éclaircie n'est pas toujours totale : celle-là au moins bleuit franchement le ciel. */
export const FORCE_ECLAIRCIE = { min: 0.82, max: 1 };
/** Part de la durée employée à installer et à lever le régime. */
export const RAMPE_ECLAIRCIE = 0.28;

// ---- les journées de plomb ---------------------------------------------------
// L'utilisateur, le 2026-11-18 : « il faut faire varier le ciel ... des alternances entre
// ciel totalement bleu et gris et sombre ». Deux régimes seulement — l'averse grise et
// l'éclaircie bleue — laissaient le ciel osciller entre deux états, et le « sombre »
// n'existait que trempé. Un troisième régime, programmé comme les autres, tient donc le
// plafond bas **sans gouttes** : le ciel vire à l'ardoise, la directe s'éteint à moitié,
// la nappe s'épaissit, et l'averse peut venir là-dessus ou pas.
/** Le premier ciel sombre est retardé : l'ouverture du monde reste le ciel d'avant. */
export const PREMIER_SOMBRE = { min: 0.7, max: 1.2 };
/** Journées de monde entre deux ciels sombres. */
export const CYCLE_SOMBRE = { min: 1.6, max: 2.8 };
/** Durée d'un ciel sombre, en fraction de journée. */
export const DUREE_SOMBRE = { min: 0.28, max: 0.50 };
/** Il n'est jamais tout à fait nuit : sous ce seuil on confondrait avec le crépuscule. */
export const FORCE_SOMBRE = { min: 0.70, max: 1 };
/** Part de la durée employée à installer et à lever le plafond. */
export const RAMPE_SOMBRE = 0.30;

// ---- la forme des nuages -----------------------------------------------------
// Deux nappes portant la même tuile, c'était un seul motif répété deux fois (mesuré : les
// deux couches partageaient le même `uuid` de texture). Trois dessins distincts — cumulus
// ventrus, stratus en bandes, cirrus filamenteux — se relaient selon un bruit lent, et les
// deux couches tirent des formes différentes l'une de l'autre pour qu'un même ciel porte
// deux écritures.
export const FORMES_NUAGE = ['cumulus', 'stratus', 'cirrus'];
/** Journée de monde entre deux nœuds du choix de forme. */
export const NOEUD_FORME = 1.1;

// ---- le vent ----------------------------------------------------------------
/** Journée de monde entre deux nœuds du bruit de vent. */
export const NOEUD_VENT = 0.5;
/** Amplitude du vent [0,1] hors averse ; l'averse le relève d'autorité. */
export const VENT = { min: 0.12, max: 1 };
/** Journée de monde entre deux nœuds de la couverture de fond (jours voilés, jours clairs). */
export const NOEUD_COUCHE = 0.7;
/** Bornes du multiplicateur d'opacité des nappes : jamais un voile plat, jamais un plafond. */
export const COUCHE_BORNE = { min: 0.05, max: 1.3 };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Même empreinte que `hashRoll` du jeu : un tirage déterministe, sans dépendance d'ordre. */
function tirage(n, salt) {
  let h = Math.imul(n | 0, 374761393) ^ Math.imul(salt | 0, 2654435761);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Lissage en S borné — la montée d'une averse n'est pas un interrupteur. */
function douce(x) {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/**
 * Une bosse de largeur `largeur` centrée sur `c` : 1 au centre, 0 au-delà, en S.
 * La respiration de l'averse se construit avec deux de ces bosses, et pas avec un sinus :
 * un sinus ne s'annule jamais exactement là où on le voudrait, et le milieu du plateau
 * restait à un cheveu sous le pic — assez pour qu'un contrôle qui compare la valeur du
 * milieu au maximum balayé ne puisse plus rien affirmer.
 */
function bosse(p, c, largeur) {
  const x = Math.abs(p - c) / largeur;
  return x >= 1 ? 0 : douce(1 - x);
}

/**
 * Bruit lent, continu et déterministe : des nœuds espacés de `noeud` journée, reliés en S.
 * Le nœud zéro est **tenu à 0,5** — c'est ce qui garantit qu'à l'ouverture du monde le
 * multiplicateur de nappes vaut exactement 1, donc que le plein jour mesuré par les suites
 * reste celui d'avant la météo. Sans cette attache, un monde pourrait naître déjà voilé.
 */
function bruitLent(t, noeud, sel, salt) {
  const n = Math.floor(t / noeud);
  const u = douce(t / noeud - n);
  const noeud_valeur = (k) => (k <= 0 ? 0.5 : tirage(k * 3 + 1, (sel ^ salt) | 0));
  return lerp(noeud_valeur(n), noeud_valeur(n + 1), u);
}

/** Descend une couleur vers le noir d'un facteur donné (0 = intacte, 1 = noire). */
function assombrir(couleur, facteur) {
  const r = (couleur >> 16) & 255, g = (couleur >> 8) & 255, b = couleur & 255;
  const f = 1 - clamp01(facteur);
  return (((r * f) | 0) << 16) | (((g * f) | 0) << 8) | ((b * f) | 0);
}

// Les gris visés sous l'averse. Ils ne sont pas pris dans la palette du ciel : un gris
// commun aux trois palettes serait noyé dans la brume de nuit. Chacun descend donc vers
// son propre gris, et `cielSousPluie` module la cible par la hauteur du soleil — la nuit
// sous la pluie s'assombrit, elle ne blanchit pas.
//
// Repris le 2026-11-18 sur mesure : « le ciel n'est pas gris et sombre ». À midi, une
// averse pleine ne laissait tomber la bande de ciel que de 159,5 à 141,9 de luminance et
// 84 % de ses pixels restaient franchement bleus, zénith #597088 — un voile bleu pâle, pas
// un plafond. Les cibles descendent donc d'un cran (le gris de zénith vaut désormais 69 de
// luminance contre 101), les mélanges vont presque jusqu'au bout, et l'assombrissement
// garde un plancher en plein jour : la formule ancienne, `0,62 * (1 - jour)`, s'éteignait
// exactement à midi, l'heure où l'utilisateur regarde.
const GRIS = {
  ciel: 0x3f4753,
  horizon: 0x5d6672,
  brume: 0x4c5560,
  nuage: 0x6f7987,
  ambiante: 0x7f8b9a,
};

// L'ardoise d'un ciel qui s'annonce sans rien répandre. Plus bas que `GRIS` : l'averse a
// au moins la décence d'être plus claire que la menace.
const SOMBRE = {
  ciel: 0x1b202b,
  horizon: 0x2f3745,
  brume: 0x262d38,
  nuage: 0x3a4350,
  ambiante: 0x556070,
};

// Les bleus d'une journée sans un nuage. Un ciel « totalement bleu » n'est pas un ciel
// plus clair — c'est un ciel plus **fermé** sur lui-même : le zénith descend vers un bleu
// profond, la bande d'horizon perd son lait, et la brume de relief cesse de laver le
// lointain. Ces trois cibles sont plus saturées que la palette de `ciel.js`, jamais plus
// lumineuses, pour que l'éclaircie se lise comme un air net et non comme une surexposition.
const DEGAGE = {
  ciel: 0x2472c4,
  horizon: 0x8ab8e2,
  brume: 0x4f97cc,
};

/**
 * Construit l'horloge météo d'un monde.
 *
 * @param {object} cfg
 * @param {number} cfg.sel    graine : deux mondes différents n'ont pas la même météo
 * @param {string} cfg.mode   'auto' | 'jamais' | 'toujours'
 */
export function creerMeteo({ sel = 0, mode = 'auto' } = {}) {
  let modeCourant = METEO_MODES.includes(mode) ? mode : 'auto';
  let jours = 0;                 // journées de monde écoulées depuis l'ouverture
  // Les épisodes sont tirés à la demande et gardés en mémoire : `avancer` peut franchir
  // plusieurs journées d'un coup (une suite fait défiler dix journées en une ligne), et
  // il faut pouvoir retrouver celui qui couvre l'instant demandé.
  const episodes = [];
  const eclaircies = [];
  const sombres = [];
  // Le vent souffle vers un cap fixe par monde : deux couches qui glisseraient chacune
  // de leur côté nagent, elles dérivent ensemble. L'amplitude, elle, varie (bruit lent).
  const cap = tirage(9, (sel ^ 0x51ED) | 0) * Math.PI * 2;
  const ventDirection = [+Math.cos(cap).toFixed(4), +Math.sin(cap).toFixed(4)];

  /**
   * Ramène un départ dans la fenêtre claire. L'heure du monde suit la journée météo — les
   * deux horloges avancent du même temps réel et partent l'une à `HEURE_DEPART`, l'autre à
   * zéro — donc l'heure d'un instant `t` se lit `(HEURE_DEPART + t) % 1`. Le décalage pris
   * est le plus court des deux sens, pour qu'un calage ne repousse pas l'épisode de moitié
   * ; `plancher` empêche de mordre sur l'épisode précédent ni de faire démarrer le premier
   * avant que le joueur ait eu le temps de regarder le ciel.
   */
  function calerEnJournee(t, index, plancher) {
    const h = (((t + HEURE_DEPART) % 1) + 1) % 1;
    const cible = JOUR_PLUIE.min
      + (JOUR_PLUIE.max - JOUR_PLUIE.min) * tirage(index * 5 + 7, (sel ^ 0x1357) | 0) * 0.8;
    let delta = ((cible - h) % 1 + 1) % 1;
    if (delta > 0.5) delta -= 1;
    return Math.max(plancher, t + delta);
  }

  /** Tire l'épisode `index` ; son départ suit le rythme, jamais un tirage par image. */
  function tirerEpisode(index) {
    const pas = index === 0
      ? lerp(PREMIER_EPISODE.min, PREMIER_EPISODE.max, tirage(index * 2 + 1, sel))
      : lerp(EPISODE_TOUS.min, EPISODE_TOUS.max, tirage(index * 2 + 1, sel));
    const brut = index === 0 ? pas : episodes[index - 1].debut + pas;
    const duree = lerp(DUREE_EPISODE.min, DUREE_EPISODE.max, tirage(index * 2 + 2, sel));
    const plafond = lerp(PLANCHER_INTENSITE, PLAFOND_INTENSITE, tirage(index * 2 + 3, sel));
    // Un épisode sur deux voit le jour. Les autres gardent leur heure au hasard : une
    // météo qui ne pleuvrait jamais la nuit non plus serait une horloge, pas un climat.
    const debut = index % EPISODE_JOUR_TOUS === 0
      ? calerEnJournee(brut, index, index === 0 ? 0.12 : episodes[index - 1].fin + 0.08)
      : brut;
    return { index, debut, fin: debut + duree, duree, plafond };
  }

  function episodeCouvrant(t) {
    while (episodes.length === 0 || t >= episodes[episodes.length - 1].fin) {
      episodes.push(tirerEpisode(episodes.length));
    }
    let i = episodes.length - 1;
    while (i > 0 && episodes[i].debut > t) i--;
    return episodes[i];
  }

  /** L'épisode qui suit celui d'index `index`, tiré à la demande s'il n'a pas encore été vu. */
  function apresEpisode(index) {
    while (episodes.length <= index + 1) episodes.push(tirerEpisode(episodes.length));
    return episodes[index + 1];
  }

  /** Tire le régime dégagé `index` — même mécanique que les averses, autre objet. */
  function tirerEclaircie(index) {
    const pas = index === 0
      ? lerp(PREMIERE_ECLAIRCIE.min, PREMIERE_ECLAIRCIE.max, tirage(index * 2 + 1, (sel ^ 0x9E37) | 0))
      : lerp(CYCLE_ECLAIRCIE.min, CYCLE_ECLAIRCIE.max, tirage(index * 2 + 1, (sel ^ 0x9E37) | 0));
    const debut = index === 0 ? pas : eclaircies[index - 1].debut + pas;
    const duree = lerp(DUREE_ECLAIRCIE.min, DUREE_ECLAIRCIE.max, tirage(index * 2 + 2, (sel ^ 0x9E37) | 0));
    const force = lerp(FORCE_ECLAIRCIE.min, FORCE_ECLAIRCIE.max, tirage(index * 2 + 3, (sel ^ 0x9E37) | 0));
    return { index, debut, fin: debut + duree, duree, force };
  }

  /** Intensité [0,1] d'un instant donné : 0 hors épisode, rampe en S aux deux bouts. */
  function intensiteEn(t) {
    const e = episodeCouvrant(t);
    if (t < e.debut || t >= e.fin) return 0;
    const u = (t - e.debut) / e.duree;
    const bord = Math.min(u, 1 - u) / RAMPE;
    let k = e.plafond * douce(bord);
    if (bord >= 1) {
      // Plateau : l'averse respire. Deux creux, à un quart et trois quarts du plateau —
      // jamais un sinus, qui laisserait le milieu même à un cheveu sous le pic. Le maximum
      // reste donc atteint exactement aux bords et au centre, là où les suites vont lire.
      const p = (u - RAMPE) / (1 - 2 * RAMPE);
      const creux = Math.max(bosse(p, 0.25, 0.18), bosse(p, 0.75, 0.18));
      k *= 1 - RESPIRATION * creux * (0.55 + 0.45 * e.plafond);
    }
    return +k.toFixed(4);
  }

  /**
   * Part d'averse que le ciel porte à un instant donné, gouttes ou pas : la montée
   * commence `COUVERTURE_AVANT` avant le premier flocon tenu, le plafond tient pendant
   * toute l'averse, la descente finit `ECLAIRCIE_APRES` après la dernière.
   */
  function contributionAverse(e, t) {
    const a = e.debut - COUVERTURE_AVANT, b = e.fin + ECLAIRCIE_APRES;
    if (t <= a || t >= b) return 0;
    if (t < e.debut) {
      const u = (t - a) / (e.debut - a);
      return e.plafond * douce(u / RAMPE_COUVERTURE);
    }
    if (t < e.fin) return e.plafond;
    const v = (t - e.fin) / (b - e.fin);
    return e.plafond * (1 - douce((v - (1 - RAMPE_COUVERTURE)) / RAMPE_COUVERTURE));
  }

  function couvertureEn(t) {
    const e = episodeCouvrant(t);
    let k = contributionAverse(e, t);
    if (e.index > 0) k = Math.max(k, contributionAverse(episodes[e.index - 1], t));
    return Math.max(k, contributionAverse(apresEpisode(e.index), t));
  }

  /** Le régime dégagé à un instant donné : 0 hors fenêtre, rampe en S aux deux bouts. */
  function degageEn(t) {
    while (eclaircies.length === 0 || t >= eclaircies[eclaircies.length - 1].fin) {
      eclaircies.push(tirerEclaircie(eclaircies.length));
    }
    let e = null;
    for (const c of eclaircies) {
      if (t >= c.debut && t < c.fin) { e = c; break; }
      if (c.debut > t) break;
    }
    if (!e) return 0;
    const u = (t - e.debut) / e.duree;
    const bord = Math.min(u, 1 - u) / RAMPE_ECLAIRCIE;
    return +(e.force * douce(bord)).toFixed(4);
  }

  /** Tire le ciel sombre `index` — même mécanique que l'éclaircie, autre objet. */
  function tirerSombre(index) {
    const selS = (sel ^ 0x4C1D) | 0;
    const pas = index === 0
      ? lerp(PREMIER_SOMBRE.min, PREMIER_SOMBRE.max, tirage(index * 2 + 1, selS))
      : lerp(CYCLE_SOMBRE.min, CYCLE_SOMBRE.max, tirage(index * 2 + 1, selS));
    const debut = index === 0 ? pas : sombres[index - 1].debut + pas;
    const duree = lerp(DUREE_SOMBRE.min, DUREE_SOMBRE.max, tirage(index * 2 + 2, selS));
    const force = lerp(FORCE_SOMBRE.min, FORCE_SOMBRE.max, tirage(index * 2 + 3, selS));
    return { index, debut, fin: debut + duree, duree, force };
  }

  /** Le ciel sombre à un instant donné : 0 hors fenêtre, rampe en S aux deux bouts. */
  function sombreEn(t) {
    while (sombres.length === 0 || t >= sombres[sombres.length - 1].fin) {
      sombres.push(tirerSombre(sombres.length));
    }
    let e = null;
    for (const c of sombres) {
      if (t >= c.debut && t < c.fin) { e = c; break; }
      if (c.debut > t) break;
    }
    if (!e) return 0;
    const u = (t - e.debut) / e.duree;
    const bord = Math.min(u, 1 - u) / RAMPE_SOMBRE;
    return +(e.force * douce(bord)).toFixed(4);
  }

  /** Vent [0,1] : un bruit lent par monde, que l'averse relève d'autorité. */
  function ventEn(t, couverture) {
    const brut = VENT.min + (VENT.max - VENT.min) * bruitLent(t, NOEUD_VENT, sel, 0x7A11);
    return +clamp01(brut + (0.62 - 0.3 * brut) * couverture).toFixed(3);
  }

  /**
   * Multiplicateur d'opacité des nappes. **1 = le ciel d'aujourd'hui, trait pour trait**
   * (nœud zéro tenu à 0,5) ; en dessous, le bleu reprend du terrain ; au-dessus, le ciel
   * se charge. Sous l'averse il est relevé d'office : un plafond de gris ne se marchande
   * pas avec le régime de la semaine.
   */
  function coucheEn(t, couverture, degage, sombre) {
    const fond = 0.55 + 0.9 * bruitLent(t, NOEUD_COUCHE, sel, 0x2B1D);
    const retiree = fond * (1 - 0.95 * degage);
    // Le plancher d'averse ne vaut que pendant qu'il y a une averse : posé en permanence,
    // il empêchait toute journée sans un nuage de découvrir le ciel (mesuré à 0,55 minimum,
    // soit exactement le plafond de l'éclaircie).
    const sousAverse = couverture > 0 ? 0.55 + 0.5 * couverture : 0;
    // Un ciel sombre sans goutte doit se voir aussi : sans ce plancher, le régime n'aurait
    // été lisible que par la teinte, et la nappe restait au voile ordinaire.
    const sousPlomb = sombre > 0 ? 0.5 + 0.62 * sombre : 0;
    return +Math.min(COUCHE_BORNE.max,
      Math.max(COUCHE_BORNE.min, retiree, sousAverse, sousPlomb)).toFixed(3);
  }

  return {
    /**
     * Fait avancer la météo. `delta` est le temps réel écoulé (secondes) et `dureeJour`
     * la longueur d'une journée dans les mêmes unités — les deux viennent de l'horloge
     * du jeu, donc changer la durée du jour change la fréquence des averses avec lui.
     */
    avancer(delta, dureeJour) {
      const d = Math.max(0, Number(delta) || 0);
      const j = Math.max(1, Number(dureeJour) || 1);
      jours += d / j;
      return this.etat();
    },
    /** Téléporte le temps météo (suites) : `journees` journées depuis l'ouverture. */
    reglerTemps(journees) {
      jours = Math.max(0, Number(journees) || 0);
      return this.etat();
    },
    etat() {
      const sec = modeCourant === 'jamais';
      const force = modeCourant === 'toujours';
      const brut = sec ? 0 : force ? PLAFOND_INTENSITE : intensiteEn(jours);
      const couverture = sec ? 0 : force ? PLAFOND_INTENSITE : +couvertureEn(jours).toFixed(4);
      // Une éclaircie et une averse ne se partagent pas le même ciel : le gris chasse le
      // bleu franc, progressivement, pour qu'on ne voie jamais le régime basculer d'un coup.
      const degage = sec || force ? 0
        : +(degageEn(jours) * (1 - clamp01(couverture / 0.25))).toFixed(4);
      // Le plomb non plus ne tient pas contre une journée sans un nuage : l'un des deux
      // doit céder, et ce n'est pas la lumière franche qui s'efface devant un plafond.
      const sombre = sec || force ? 0
        : +(sombreEn(jours) * (1 - clamp01(degage / 0.3))).toFixed(4);
      const e = episodeCouvrant(jours);
      const enCours = jours >= e.debut && jours < e.fin;
      // « prochaine » répond à la question du joueur : quand retombera l'averse ? Elle
      // doit donc rester annoncée **entre deux épisodes** aussi, pas seulement avant le
      // premier — sinon la fiche météo se tait justement quand elle aurait quelque chose
      // à dire. Et `fin` ne répond que pendant l'averse : après coup, ce serait une date
      // du passé présentée comme une échéance.
      const suivante = enCours ? null : (jours < e.debut ? e : apresEpisode(e.index));
      return {
        /** 0 ciel dégagé … 1 averse pleine. Ne pilote que le rideau de gouttes. */
        intensite: brut,
        /** 0 … 1 : ce que le ciel porte de gris, gouttes ou pas. Devance et survit à `intensite`. */
        couverture,
        /** 0 … 1 : le régime « journée sans un nuage ». 0 dès que le ciel se charge. */
        degage,
        /** 0 … 1 : le régime « ciel de plomb », gouttes ou pas. 0 sous une éclaircie. */
        sombre,
        /** Multiplicateur d'opacité des nappes (1 = le ciel ordinaire). */
        couche: coucheEn(jours, couverture, degage, sombre),
        /** Dessin de nuage courant : 'cumulus' | 'stratus' | 'cirrus'. */
        forme: FORMES_NUAGE[Math.min(FORMES_NUAGE.length - 1,
          Math.floor(bruitLent(jours, NOEUD_FORME, sel, 0x0F0E) * FORMES_NUAGE.length))],
        /** 0 … 1 : l'amplitude du vent, qui entraîne nappes et gouttes. */
        vent: ventEn(jours, couverture),
        /** Cap du vent, vecteur unitaire [x, z] — fixe par monde. */
        ventDirection,
        mode: modeCourant,
        /** Journée de monde courante (0 = ouverture). */
        journee: +jours.toFixed(4),
        numero: e.index,
        /** Prochaine averse, en journées depuis l'ouverture ; `null` sous la pluie. */
        prochaine: suivante == null ? null : +suivante.debut.toFixed(3),
        fin: enCours ? +e.fin.toFixed(3) : null,
        /** Ce que donnerait l'automate si le joueur ne forçait rien. */
        naturelle: intensiteEn(jours),
      };
    },
    mode: () => modeCourant,
    reglerMode(m) {
      modeCourant = METEO_MODES.includes(m) ? m : 'auto';
      return modeCourant;
    },
    /** Reprise en main par le joueur depuis le jeu : true force l'averse. */
    forcer(v) { return this.reglerMode(v ? 'toujours' : 'jamais'); },
  };
}

/**
 * Applique une averse à un état de ciel.
 *
 * À intensité nulle, **l'objet reçu est rendu tel quel** : pas de copie, pas d'arrondi,
 * pour que le plein jour reste mesuré au bit près contre les valeurs d'avant la pluie.
 *
 * Au-delà, trois choses bougent, et rien d'autre : les teintes descendent vers leur gris
 * (dôme, horizon, brume, nuages), la lumière directe s'éteint en partie parce que le
 * soleil est derrière l'averse, et l'ambiante perd un peu de nerf en virant au gris-bleu.
 * La nappe de nuages se densifie — c'est ce qui fait un ciel bas et lourd.
 *
 * @param {object} e         état rendu par `etatDuCiel`
 * @param {number} intensite 0…1 — ici, la **couverture** : le gris, pas les gouttes
 */
export function cielSousPluie(e, intensite) {
  const k = clamp01(Number(intensite) || 0);
  if (k === 0) return e;
  // La cible grise suit la hauteur du soleil : à minuit, mélanger vers un gris clair
  // éclairerait le ciel nocturne, ce qui serait exactement l'inverse d'une averse. Le
  // plancher de 0,26 garde l'assombrissement actif en plein jour, là où l'ancienne
  // formule `0,62 * (1 - jour)` s'éteignait exactement à midi.
  const jour = clamp01(e.jour);
  const teinte = (cible) => assombrir(cible, Math.min(0.94, 0.26 + 0.68 * (1 - jour)));
  const versGris = (couleur, cible, force) => melangeCouleur(
    couleur, teinte(cible), k * force,
  );
  return {
    ...e,
    ciel: versGris(e.ciel, GRIS.ciel, 0.94),
    horizon: versGris(e.horizon, GRIS.horizon, 0.9),
    brume: versGris(e.brume, GRIS.brume, 0.95),
    ambiante: {
      couleur: versGris(e.ambiante.couleur, GRIS.ambiante, 0.6),
      intensite: +(e.ambiante.intensite * (1 - 0.4 * k)).toFixed(4),
    },
    directe: {
      couleur: versGris(e.directe.couleur, GRIS.ambiante, 0.55),
      intensite: +(e.directe.intensite * (1 - 0.78 * k)).toFixed(4),
    },
    nuages: {
      couleur: versGris(e.nuages.couleur, GRIS.nuage, 0.8),
      // Voile → plafond : +0,34 au plus fort, sans jamais atteindre l'opacité pleine.
      opacite: +Math.min(0.92, e.nuages.opacite + 0.34 * k).toFixed(3),
    },
    pluie: k,
  };
}

/**
 * Applique un ciel sombre — le plafond bas qui n'amène pas forcément de gouttes.
 *
 * Comme les deux autres habilleurs, à régime nul **l'objet reçu est rendu tel quel**.
 * Les cibles sont d'abord multipliées par la hauteur du soleil : la nuit, elles deviennent
 * noires et le mélange ne peut donc qu'assombrir, jamais rallumer un ciel déjà éteint.
 *
 * @param {object} e       état rendu par `etatDuCiel` (ou par les habilleurs précédents)
 * @param {number} regime  0…1
 */
export function cielSombre(e, regime) {
  const k = clamp01(Number(regime) || 0);
  if (k === 0) return e;
  const jour = clamp01(e.jour);
  const versEncre = (couleur, cible, force) => melangeCouleur(couleur, assombrir(cible, 1 - jour), k * force);
  return {
    ...e,
    ciel: versEncre(e.ciel, SOMBRE.ciel, 0.82),
    horizon: versEncre(e.horizon, SOMBRE.horizon, 0.74),
    brume: versEncre(e.brume, SOMBRE.brume, 0.82),
    ambiante: {
      couleur: versEncre(e.ambiante.couleur, SOMBRE.ambiante, 0.5),
      intensite: +(e.ambiante.intensite * (1 - 0.34 * k)).toFixed(4),
    },
    directe: {
      ...e.directe,
      intensite: +(e.directe.intensite * (1 - 0.55 * k)).toFixed(4),
    },
    nuages: {
      ...e.nuages,
      couleur: versEncre(e.nuages.couleur, SOMBRE.nuage, 0.62),
      opacite: +Math.min(0.95, e.nuages.opacite + 0.3 * k).toFixed(3),
    },
    sombre: k,
  };
}

/**
 * Applique une journée sans un nuage à un état de ciel.
 *
 * Comme `cielSousPluie`, à régime nul **l'objet reçu est rendu tel quel**. Le retrait des
 * nappes ne se joue pas ici — c'est `couche`, dans l'état météo, qui le dit au navigateur —
 * afin que la teinte et l'opacité jugées par les suites restent celles du modèle du ciel.
 *
 * @param {object} e       état rendu par `etatDuCiel` (ou par `cielSousPluie`)
 * @param {number} degage  0…1
 */
export function cielDegage(e, degage) {
  const k = clamp01(Number(degage) || 0);
  if (k === 0) return e;
  const jour = clamp01(e.jour);
  // La nuit, il n'y a pas de bleu à fermer : le régime ne fait que retirer ce qui voile
  // les étoiles, et laisse les teintes tranquilles. Seule la directe reprend du nerf
  // quand le soleil est au-dessus de la ligne de crête.
  const versBleu = (couleur, cible, force) => melangeCouleur(couleur, cible, k * force * jour);
  return {
    ...e,
    ciel: versBleu(e.ciel, DEGAGE.ciel, 0.42),
    horizon: versBleu(e.horizon, DEGAGE.horizon, 0.3),
    brume: versBleu(e.brume, DEGAGE.brume, 0.4),
    directe: {
      ...e.directe,
      intensite: +(e.directe.intensite * (1 + 0.12 * k * jour)).toFixed(4),
    },
    ambiante: {
      ...e.ambiante,
      intensite: +(e.ambiante.intensite * (1 + 0.05 * k * jour)).toFixed(4),
    },
    degage: k,
  };
}

/**
 * Habille un état de ciel avec l'état complet de la météo.
 *
 * Les deux transformations sont appliquées dans cet ordre et **rien n'est ajouté à
 * l'objet quand la météo est neutre** : `pluie` et `couverture` n'apparaissent qu'à partir
 * du moment où le ciel porte quelque chose, ce qui laisse le plein jour ordinaire strictement
 * identique à celui d'avant la météo — seule issue pour les contrôles d'exposition.
 *
 * @param {object} e état rendu par `etatDuCiel`
 * @param {object} m état rendu par `creerMeteo().etat()`
 */
export function habillerCiel(e, m) {
  const couverture = clamp01(Number(m && (m.couverture ?? m.intensite)) || 0);
  const gouttes = clamp01(Number(m && m.intensite) || 0);
  const degage = clamp01(Number(m && m.degage) || 0);
  const sombre = clamp01(Number(m && m.sombre) || 0);
  const habille = cielSombre(cielDegage(cielSousPluie(e, couverture), degage), sombre);
  if (habille === e) return e;
  return { ...habille, pluie: gouttes, couverture, degage, sombre };
}
