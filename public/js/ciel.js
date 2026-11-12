/**
 * Le cycle du jour — un modèle pur du ciel selon l'heure.
 *
 * Rien ici ne touche Three.js ni le DOM : l'état du ciel est une fonction de l'heure
 * (un nombre entre 0 et 1), donc la suite Node juge les couleurs, les intensités et la
 * trajectoire du soleil exactement comme le navigateur les consommera. C'est aussi ce
 * qui permet de figer l'heure d'une scène de test plutôt que d'attendre huit minutes.
 *
 * Deux contraintes se lisent dans les chiffres ci-dessous et nulle part ailleurs :
 *  - à midi, les **lumières de scène** doivent rester celles d'avant le cycle (ambiante
 *    blanche 0,72, directionnelle chaude 0xfff4e0 à 0,5) : les contrôles de pixels de
 *    `tests/render-collision.mjs` jugent l'exposition du relief, qui ne tient qu'à elles.
 *    La teinte du dôme, elle, a été reprise le 2026-11-12 — voir la note sur `PALETTE` ;
 *  - l'heure de départ est le matin haut (0,35), jamais l'aube : le monde s'ouvre sur
 *    une scène éclairée, comme avant.
 */

export const TAU = Math.PI * 2;

/** Une journée complète, en secondes réelles. Réglable de 60 s à une heure. */
export const DUREE_JOUR_DEFAUT = 480;
export const DUREE_JOUR_BORNES = { min: 60, max: 3600 };

/** Heure de départ d'un monde neuf : matin haut, pleine lumière. */
export const HEURE_DEPART = 0.35;

/** Inclinaison du plan de course du soleil : il ne monte pas plein axe, sinon sa
 *  trajectoire se confond avec un axe du monde et le paysage n'a plus de relief. */
const INCLINAISON = 0.35;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Lissage en S borné — le passage aube → jour n'est pas uninterrupteur. */
function douce(m, x, y) {
  const t = clamp01((x - m) / (y - m));
  return t * t * (3 - 2 * t);
}

function melangeCouleur(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (((ar + (br - ar) * t) | 0) << 16)
       | (((ag + (bg - ag) * t) | 0) << 8)
       | ((ab + (bb - ab) * t) | 0);
}

// Les trois palettes du ciel. Chacune porte sa **brume** : le voile qui habille le
// relief lointain n'est pas un prélèvement sur l'horizon — cette bande est la plus
// claire du dôme, et s'en servir lavait tout le paysage (l'utilisateur : « les cubes à
// l'horizon sont tous blancs en pleine journée »). Mesurée à midi, la reprise de
// l'horizon donnait 202 de luminance ; la teinte ci-dessous descend à 169, assez pour
// que les silhouettes se détachent sans que le plein jour perde son ciel.
//
// Le bleu du zénith a été repris le 2026-11-12 pour la même raison, côté dôme cette
// fois : à 0x87ceeb le corps du ciel tenait déjà 193 de luminance et sa bande basse
// 214 — tout le ciel était une nappe blanchâtre, et l'horizon ne se distinguait de
// rien. Un zénith franc (141) sous un horizon voilé (189) rend la bande lisible sans
// la faire virer au linge.
const PALETTE = {
  nuit:  { ciel: 0x070b1c, horizon: 0x141d33, soleil: 0x9fb4e8, brume: 0x0b1226 },
  aube:  { ciel: 0x3f5a86, horizon: 0xff9a4a, soleil: 0xffb066, brume: 0xc07a5a },
  jour:  { ciel: 0x4f97dd, horizon: 0x9dc3e4, soleil: 0xfff4e0, brume: 0x74b4dd },
};

// Intensités à midi : la valeur exacte du monde d'avant le cycle.
const MIDI = { ambiante: 0.72, directe: 0.5, couloirAmbiant: 0xffffff, soleil: 0xfff4e0 };
// Et à minuit : bleu-noir. Dehors on se repère encore, sous terre non — l'obscurité
// des grottes vient du canal `ciel` du maillage, pas d'ici.
const MINUIT = { ambiante: 0.17, directe: 0.06, couloirAmbiant: 0x8fa6d8, soleil: 0xbfd0ff };

/**
 * État complet du ciel à une heure donnée.
 *
 * @param {number} heure 0 (minuit) … 1 (minuit suivant)
 * @returns objet figé décrivant la course du soleil, les couleurs et les lumières
 */
export function etatDuCiel(heure) {
  const h = ((heure % 1) + 1) % 1;
  // Le soleil culmine à midi : à h = 0,25 il est à l'horizon levant, à 0,75 couchant.
  const angle = (h - 0.25) * TAU;
  const sinHauteur = Math.sin(angle);
  const cosHauteur = Math.cos(angle);

  // Facteur de jour : 0 la nuit pleine, 1 dès que le soleil a franchi la ligne de
  // crête de l'aube. La bande morte sous l'horizon garde un peu de clarté pour que
  // le crépuscule ne soit pas un noir d'encre immédiat.
  const jour = douce(-0.14, sinHauteur, 0.22);
  const nuit = 1 - jour;

  // Le renard pourpre ne vit qu'autour du franchissement de la ligne de crête. Jugé sur
  // le seul |cos|, il tenait 0,61 de teinte chaude à trente-six degrés de soleil —
  // l'heure même où le monde s'ouvre : brume gris-rosé et horizon crème lavaient la
  // matinée entière, ce que l'utilisateur décrivait comme « l'horizon est blanc dans la
  // journée ». Le second facteur borné sur la hauteur du soleil éteint le renard dès
  // les dix premiers degrés passés, des deux côtés de la course.
  const aube = douce(0.55, Math.abs(cosHauteur), 1)
    * (1 - douce(0.05, sinHauteur, 0.25))
    * douce(-0.3, sinHauteur, 0.05);

  const versLevant = cosHauteur > 0;
  const ciel = melangeCouleur(PALETTE.nuit.ciel, PALETTE.jour.ciel, jour);
  const horizonJour = melangeCouleur(PALETTE.nuit.horizon, PALETTE.jour.horizon, jour);
  const horizon = melangeCouleur(horizonJour, PALETTE.aube.horizon, aube * 0.85);
  const teinteSoleil = melangeCouleur(
    melangeCouleur(PALETTE.nuit.soleil, MIDI.soleil, jour), PALETTE.aube.soleil, aube * 0.7,
  );

  return {
    heure: h,
    /** Hauteur du soleil au-dessus de l'horizon, en sinus (-1 sous les pieds). */
    hauteur: sinHauteur,
    /** 0 nuit pleine … 1 plein jour. Pilote tout l'éclairage de scène. */
    jour,
    nuit,
    /** Lueur résiduelle qui allume les lampes : 1 la nuit, 0 en plein jour. */
    lampes: clamp01(1 - douce(0.18, jour, 0.62)),
    phase: jour > 0.85 ? 'jour' : jour < 0.08 ? 'nuit' : versLevant ? 'aube' : 'crépuscule',
    /** Direction de la lumière principale (du joueur vers le soleil). */
    soleil: [
      cosHauteur * Math.cos(INCLINAISON),
      sinHauteur,
      cosHauteur * Math.sin(INCLINAISON),
    ],
    /** Direction opposée : là où voir la lune quand le soleil est dessous. */
    lune: [-cosHauteur * Math.cos(INCLINAISON), -sinHauteur, -cosHauteur * Math.sin(INCLINAISON)],
    ciel,
    horizon,
    // La brume suit sa propre teinte, mélange des trois palettes comme le reste du
    // ciel — jamais l'horizon tel quel, dont la clarté noyait le relief lointain.
    brume: melangeCouleur(
      melangeCouleur(PALETTE.nuit.brume, PALETTE.jour.brume, jour),
      PALETTE.aube.brume, aube * 0.85,
    ),
    ambiante: { couleur: melangeCouleur(MINUIT.couloirAmbiant, MIDI.couloirAmbiant, jour),
                intensite: lerp(MINUIT.ambiante, MIDI.ambiante, jour) },
    directe: { couleur: teinteSoleil, intensite: lerp(MINUIT.directe, MIDI.directe, jour) },
    /** Visibilité des étoiles. */
    etoiles: douce(0.55, nuit, 0.95),
    /**
     * La nappe de nuages. Le modèle ne rend pas la forme — elle est dessinée une fois
     * pour toutes dans le navigateur — mais il décide de sa **teinte** et de son
     * **opacité**, donc la suite Node juge un ciel couvert comme le reste : blanche le
     * jour, à peine visible la nuit, ourlée de l'orange de l'aube. L'opacité ne monte
     * jamais assez haut pour blanchir le ciel : la nappe doit rester un voile, pas un
     * plafond.
     */
    nuages: {
      couleur: melangeCouleur(
        melangeCouleur(0x2a3452, 0xf4f8ff, jour), PALETTE.aube.horizon, aube * 0.45),
      opacite: +(0.24 + 0.3 * jour).toFixed(3),
    },
  };
}

/**
 * L'horloge du monde : elle avance à un rythme réglable et ne dépend que du temps
 * écoulé depuis sa remise à zéro. Volontairement **jamais** sauvegardée avec le monde :
 * le fichier ne porte que le diff du joueur, et une heure figée sur le disque ferait
 * revivre au joueur la même nuit à chaque ouverture.
 */
export function creerHorloge({ duree = DUREE_JOUR_DEFAUT, heure = HEURE_DEPART } = {}) {
  let dureeCourante = bornerDuree(duree);
  let t = heure;
  return {
    /** Avance l'horloge de `delta` secondes et rend l'heure courante. */
    avancer(delta) {
      t = (t + Math.max(0, delta) / dureeCourante) % 1;
      return t;
    },
    heure: () => t,
    regler(v) { t = ((Number(v) % 1) + 1) % 1; return t; },
    duree: () => dureeCourante,
    reglerDuree(v) { dureeCourante = bornerDuree(v); return dureeCourante; },
  };
}

export function bornerDuree(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DUREE_JOUR_DEFAUT;
  return Math.min(DUREE_JOUR_BORNES.max, Math.max(DUREE_JOUR_BORNES.min, n));
}

/** Heure locale lisible par le joueur (0…23 h 59) depuis l'heure normalisée. */
export function heureAffichee(heure) {
  const h = ((heure % 1) + 1) % 1;
  const minutes = Math.floor(h * 1440);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}h${String(minutes % 60).padStart(2, '0')}`;
}
