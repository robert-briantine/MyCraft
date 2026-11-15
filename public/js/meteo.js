/**
 * La pluie — un modèle pur de la météo, à l'image de `ciel.js`.
 *
 * Rien ici ne touche Three.js ni le DOM : une averse est une fonction du temps écoulé
 * depuis l'ouverture du monde, donc la suite Node juge les épisodes, leurs rampes et
 * leurs intensités exactement comme le navigateur les consommera. C'est aussi ce qui
 * permet de faire défiler trois journées dans un test plutôt que d'attendre vingt-quatre
 * minutes d'horloge réelle.
 *
 * Trois décisions portent le dispositif, et aucune ne se lit dans le code seul :
 *
 *  - **L'averse est un épisode, pas un tirage par image.** Une date de début et une
 *    durée sont tirées pour chaque épisode, puis on saute à la suivante. Un tirage
 *    indépendant par frame donnerait un ciel qui grésille entre clair et couvert.
 *  - **Le premier épisode vient tôt, les suivants gardent leur rythme.** Le joueur qui
 *    demande la pluie veut la voir dans la session, pas à la troisième journée : la
 *    première averse tombe avant une journée de monde. Ensuite, le rythme convenu
 *    (deux à trois journées entre deux départs) reprend.
 *  - **Sans averse, rien ne bouge.** `cielSousPluie` rend l'état reçu tel quel quand
 *    l'intensité est nulle — pas une copie, pas un arrondi. Les contrôles d'exposition
 *    de `tests/render-collision.mjs` jugent le plein jour à 0,72 d'ambiante et 0,5 de
 *    directe : ils ne tiennent que si le beau temps est exactement le ciel d'avant.
 */

import { melangeCouleur } from './ciel.js';

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
const GRIS = {
  ciel: 0x5c6672,
  horizon: 0x7b8794,
  brume: 0x6d7883,
  nuage: 0x8d97a3,
  ambiante: 0x9aa6b4,
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

  /** Tire l'épisode `index` ; son départ suit le rythme, jamais un tirage par image. */
  function tirerEpisode(index) {
    const pas = index === 0
      ? lerp(PREMIER_EPISODE.min, PREMIER_EPISODE.max, tirage(index * 2 + 1, sel))
      : lerp(EPISODE_TOUS.min, EPISODE_TOUS.max, tirage(index * 2 + 1, sel));
    const debut = index === 0 ? pas : episodes[index - 1].debut + pas;
    const duree = lerp(DUREE_EPISODE.min, DUREE_EPISODE.max, tirage(index * 2 + 2, sel));
    const plafond = lerp(PLANCHER_INTENSITE, PLAFOND_INTENSITE, tirage(index * 2 + 3, sel));
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

  /** Intensité [0,1] d'un instant donné : 0 hors épisode, rampe en S aux deux bouts. */
  function intensiteEn(t) {
    const e = episodeCouvrant(t);
    if (t < e.debut || t >= e.fin) return 0;
    const u = (t - e.debut) / e.duree;
    const bord = Math.min(u, 1 - u) / RAMPE;
    return +(e.plafond * douce(bord)).toFixed(4);
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
      const brut = modeCourant === 'jamais' ? 0
        : modeCourant === 'toujours' ? PLAFOND_INTENSITE
          : intensiteEn(jours);
      const e = episodeCouvrant(jours);
      const enCours = jours >= e.debut && jours < e.fin;
      // « prochaine » répond à la question du joueur : quand retombera l'averse ? Elle
      // doit donc rester annoncée **entre deux épisodes** aussi, pas seulement avant le
      // premier — sinon la fiche météo se tait justement quand elle aurait quelque chose
      // à dire. Et `fin` ne répond que pendant l'averse : après coup, ce serait une date
      // du passé présentée comme une échéance.
      const suivante = enCours ? null : (jours < e.debut ? e : apresEpisode(e.index));
      return {
        /** 0 ciel dégagé … 1 averse pleine. Pilote le gris, la brume et le rideau. */
        intensite: brut,
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
 * @param {number} intensite 0…1
 */
export function cielSousPluie(e, intensite) {
  const k = clamp01(Number(intensite) || 0);
  if (k === 0) return e;
  // La cible grise suit la hauteur du soleil : à minuit, mélanger vers un gris clair
  // éclairerait le ciel nocturne, ce qui serait exactement l'inverse d'une averse.
  const jour = clamp01(e.jour);
  const versGris = (couleur, cible, force) => melangeCouleur(
    couleur, assombrir(cible, 0.62 * (1 - jour)), k * force,
  );
  return {
    ...e,
    ciel: versGris(e.ciel, GRIS.ciel, 0.86),
    horizon: versGris(e.horizon, GRIS.horizon, 0.8),
    brume: versGris(e.brume, GRIS.brume, 0.9),
    ambiante: {
      couleur: versGris(e.ambiante.couleur, GRIS.ambiante, 0.55),
      intensite: +(e.ambiante.intensite * (1 - 0.2 * k)).toFixed(4),
    },
    directe: {
      couleur: versGris(e.directe.couleur, GRIS.ambiante, 0.5),
      intensite: +(e.directe.intensite * (1 - 0.62 * k)).toFixed(4),
    },
    nuages: {
      couleur: versGris(e.nuages.couleur, GRIS.nuage, 0.8),
      // Voile → plafond : +0,34 au plus fort, sans jamais atteindre l'opacité pleine.
      opacite: +Math.min(0.92, e.nuages.opacite + 0.34 * k).toFixed(3),
    },
    pluie: k,
  };
}
