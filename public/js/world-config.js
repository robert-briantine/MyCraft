// Le « Monde » réglable : la fiche des paramètres que l'écran de génération expose,
// et la traduction de chacun en correctifs pour les trois générateurs (relief,
// biomes, village).
//
// Deux règles commandent ce module :
//
//  - **À ses valeurs par défaut il ne corrige rien.** Chaque borne basse ou haute des
//    curseurs est un nombre mesuré sur la génération telle qu'elle est aujourd'hui
//    (see `tests/worldgen.mjs`), et la table de correspondance est construite pour
//    que `reliefOverrides(MONDE_DEFAULTS)` rende exactement les constantes courantes
//    de `RELIEF`, `BIOMES` et `VILLAGE`. Un monde créé sans toucher à rien doit donc
//    tomber cube pour cube sur le monde d'hier.
//  - **Rien d'aléatoire ici.** Le monde ne s'enregistre que comme le diff du joueur,
//    donc la même fiche doit redonner le même monde ; tout tirage reste dans les
//    modules de génération, amorcé par la graine.
//
// Le module est sans dépendance autre que les constantes des générateurs : ni DOM, ni
// three, donc les suites Node jugent les mêmes chiffres que l'écran du navigateur.

import { RELIEF } from './terrain.js';
import { BIOMES } from './biomes.js';
import { VILLAGE } from './village.js';

/** Hauteur maximale atteinte aujourd'hui par les très hauts massifs (`RELIEF.alpsTop`). */
const MONTAGNE_REF = RELIEF.alpsTop;

/**
 * Épaisseur de la grève aujourd'hui : le sable va de la ligne de flottaison à
 * `BIOMES.sandLine`. Elle se règle en cubes au-dessus de l'eau plutôt qu'en altitude
 * absolue, parce que la mer est réglable — et que la plage doit suivre son niveau.
 */
const PLAGE_REF = BIOMES.sandLine - RELIEF.seaLevel;

/**
 * Parts mesurées sur le monde d'aujourd'hui avec la fiche par défaut : graine 42, île
 * de 1600 cubes, échantillon du cœur au pas de 4 (352 517 colonnes). Ces chiffres sont
 * ceux que l'écran affiche en face de la valeur visée — s'ils en différaient, le
 * panneau s'ouvrirait en se contredisant. La graine change la distribution du climat,
 * donc ces mesures ne décrivent que le monde par défaut ; elles n'en sont pas des
 * constantes pour autant, chaque curseur reste libre de ses propres bornes.
 */
export const MONDE_DEFAULTS = {
  foret: 39,             // part des terres sous bois (mesuré 39,2 %)
  desert: 30,            // …sous sable (mesuré 30,3 %)
  mer: 36,               // part immergée du cœur de l'île (mesuré 36,0 %)
  largeurPlage: PLAGE_REF, // épaisseur de grève au-dessus de l'eau — `BIOMES.sandLine` - `RELIEF.seaLevel`
  hauteurMontagne: 66,   // plafond visé des sommets — `RELIEF.alpsTop`
  immeublesMax: 18,      // plus haute catégorie d'immeuble — `VILLAGE.towerFloors[5]`
  densiteVilles: Math.round(VILLAGE.cityChance * 100),
  densiteVillages: Math.round(VILLAGE.lotDensity * 100),
  // Parts **relatives** des trois types de ville (voir `VILLAGE.cityTypes`) : c'est un
  // tirage pondéré sur la maille urbaine, pas une répartition forcée à cent.
  villesPetites: 45,
  villesMoyennes: 35,
  villesGrandes: 20,
  ile: true,             // demandé le 2026-11-10 : le monde est une île
  rayonIle: 1600,        // ≈ 8 min de marche depuis l'apparition
  largeurCote: 260,      // distance où la terre plonge sous la ligne de flottaison
  profondeurLarge: 14,   // cubes d'eau au-dessus du fond du large
  graine: 42,            // `WORLD_SEEDS.terrain` d'aujourd'hui
};

/**
 * Fiche des curseurs. `group` ordonne les panneaux de l'écran ; `unit` et `hint` ne
 * servent qu'à l'affichage. `dependsOn` désactive une ligne tant que sa condition ne
 * tient pas (le rayon n'a pas de sens hors mode île).
 */
export const MONDE_FIELDS = [
  { key: 'foret', group: 'Répartition des superficies', label: 'Forêt', type: 'range',
    min: 5, max: 70, step: 1, unit: '% des terres',
    hint: 'Part des terres sous bois. Le grand boisé à l\'échelle des océans reste toujours présent.' },
  { key: 'desert', group: 'Répartition des superficies', label: 'Désert', type: 'range',
    min: 0, max: 60, step: 1, unit: '% des terres',
    hint: 'Part des terres sous sable. La plaine prend ce qui reste.' },
  { key: 'mer', group: 'Répartition des superficies', label: 'Mer intérieure', type: 'range',
    min: 2, max: 60, step: 1, unit: '% du cœur de l\'île',
    hint: 'Bassins ouverts à l\'intérieur des terres, hors talus côtier. Au large, l\'océan est toujours là.' },
  { key: 'largeurPlage', group: 'Répartition des superficies', label: 'Largeur de la plage', type: 'range',
    // Le plafond est la grève d'aujourd'hui : `VILLAGE.minGround` bâtit juste au-dessus
    // du sable, et une maison qui poserait son lit sur la grève ferait barrage à la mer.
    min: 0, max: Math.max(1, VILLAGE.minGround - RELIEF.seaLevel), step: 1,
    unit: 'cubes de sable',
    hint: 'Épaisseur de sable entre l\'eau et l\'herbe, tout autour des terres — elle suit le niveau de la mer. À zéro, l\'herbe va jusqu\'à l\'eau. Elle ne dépend pas du curseur Désert : même désert éteint, la grève reste du sable.' },
  { key: 'hauteurMontagne', group: 'Relief et bâti', label: 'Hauteur des montagnes', type: 'range',
    min: 40, max: 72, step: 1, unit: 'cubes',
    hint: 'Plafond des sommets. Les massifs courants montent dans la même proportion.' },
  { key: 'immeublesMax', group: 'Relief et bâti', label: 'Immeubles', type: 'range',
    min: 3, max: 18, step: 1, unit: 'étages max',
    hint: 'Catégorie la plus haute autorisée partout ; les catégories basses restent les plus fréquentes. Le plafond du type de ville ne monte jamais au-dessus.' },
  { key: 'densiteVilles', group: 'Relief et bâti', label: 'Villes', type: 'range',
    min: 0, max: 100, step: 1, unit: '% des mailles',
    hint: 'Part des mailles urbaines qui reçoivent un centre-bourg.' },
  { key: 'densiteVillages', group: 'Relief et bâti', label: 'Villages', type: 'range',
    min: 0, max: 60, step: 1, unit: '% des parcelles',
    hint: 'Part des parcelles bâties loin de toute ville.' },
  // Trois curseurs de proportions : des poids relatifs, pas trois pourcentages à sommer
  // à cent. Chacun décrit ce que la ville de ce type occupe et jusqu'où elle monte, donc
  // les monter tous se juge à la carte, pas à la somme des chiffres.
  { key: 'villesPetites', group: 'Types de ville', label: 'Petites villes', type: 'range',
    min: 0, max: 100, step: 5, unit: 'parts',
    hint: 'Bourg serré : quartier sur 96 cubes de rayon, six étages au plus, blocs d\'immeubles rares.' },
  { key: 'villesMoyennes', group: 'Types de ville', label: 'Villes moyennes', type: 'range',
    min: 0, max: 100, step: 5, unit: 'parts',
    hint: 'La ville d\'avant ce réglage : quartier sur 160 cubes de rayon, douze étages, blocs d\'immeubles à la fréquence ordinaire.' },
  { key: 'villesGrandes', group: 'Types de ville', label: 'Grandes villes', type: 'range',
    min: 0, max: 100, step: 5, unit: 'parts',
    hint: 'Métropole : quartier sur 250 cubes de rayon, dix-huit étages, un tronçon de centre-bourg sur cinq bâti en bloc débordant.' },
  { key: 'ile', group: 'Île', label: 'Monde en île', type: 'checkbox',
    hint: 'La terre s\'arrête et l\'océan commence : au bord, de l\'eau à perte de vue.' },
  { key: 'rayonIle', group: 'Île', label: 'Rayon de l\'île', type: 'range',
    min: 300, max: 3000, step: 50, unit: 'cubes', dependsOn: (m) => m.ile,
    hint: 'Distance du centre au pied de la côte. À 1600 cubes, compte huit minutes de marche.' },
  { key: 'largeurCote', group: 'Île', label: 'Largeur de la côte', type: 'range',
    min: 60, max: 600, step: 20, unit: 'cubes', dependsOn: (m) => m.ile,
    hint: 'Longueur du talus où la terre plonge sous la ligne de flottaison : assez long pour rester franchissable à pied.' },
  { key: 'profondeurLarge', group: 'Île', label: 'Profondeur du large', type: 'range',
    min: 6, max: 30, step: 1, unit: 'cubes d\'eau', dependsOn: (m) => m.ile,
    hint: 'Hauteur d\'eau au-delà de la côte : assez pour que le fond disparaisse à l\'horizon.' },
  { key: 'graine', group: 'Monde', label: 'Graine', type: 'number',
    min: 1, max: 999999, step: 1,
    hint: 'Tire le relief, les minerais, la végétation et le village. Deux mondes de même graine sont identiques.' },
];

const FIELD_BY_KEY = new Map(MONDE_FIELDS.map((f) => [f.key, f]));

function finiteIn(field, value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(field.max, Math.max(field.min, Math.round(n / field.step) * field.step));
}

/**
 * Nettoie une fiche venue du disque ou du champ de saisie. Tout ce qui vient de
 * l'extérieur est suspect : un texte, un NaN ou une valeur hors bornes retombent sur
 * le défaut de la ligne plutôt que de passer au générateur.
 */
export function clampMonde(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const field of MONDE_FIELDS) {
    const defaut = MONDE_DEFAULTS[field.key];
    const value = src[field.key];
    if (field.type === 'checkbox') {
      out[field.key] = typeof value === 'boolean' ? value
        : (value === undefined ? defaut : Boolean(value));
    } else {
      out[field.key] = finiteIn(field, value, defaut);
    }
  }
  return out;
}

/** Deux fiches identiques (comparaison après nettoyage). */
export function memesMondes(a, b) {
  const x = clampMonde(a);
  const y = clampMonde(b);
  return MONDE_FIELDS.every((f) => Object.is(x[f.key], y[f.key]));
}

/**
 * Les quatre graines du monde dérivées d'une seule. La dérivation est calée pour que
 * la graine par défaut rende exactement `WORLD_SEEDS` d'hier (42, 123, 777, 999) :
 * changer de graine est une intention du joueur, jamais un effet de bord d'une mise
 * à jour du code.
 */
export function mondeSeeds(graine) {
  const g = clampMonde({ graine }).graine;
  return { terrain: g, trees: g + 81, buildings: g + 735, caves: g + 957 };
}

/** Correctifs de `RELIEF` pour la fiche donnée (objet vide si rien à corriger). */
export function reliefOverrides(monde, { chunkHeight = 80, seuils = null } = {}) {
  const m = clampMonde(monde);
  const o = {};
  const plafond = chunkHeight - RELIEF.ceilingMargin;
  const v = Math.min(plafond, m.hauteurMontagne);
  if (v !== MONTAGNE_REF) {
    // Un facteur unique sur les deux termes d'altitude : lever seulement les Alpes
    // laisserait les massifs courants au même niveau, et la chaîne cesserait de
    // dominer le pays qui l'entoure.
    const k = v / MONTAGNE_REF;
    o.alpsTop = v;
    o.alpsLift = Math.max(6, Math.round(RELIEF.alpsLift * k));
    o.alpsCrag = Math.max(1, Math.round(RELIEF.alpsCrag * k));
    o.mountainLift = Math.max(6, Math.round(RELIEF.mountainLift * k));
    o.mountainCrag = Math.max(1, Math.round(RELIEF.mountainCrag * k));
  }
  // Mer et ligne de flottaison viennent de l'étalonnage : ce sont des seuils sur un
  // bruit, pas des surfaces réglables directement (voir `world-preview.js`).
  if (seuils && Number.isFinite(seuils.oceanThreshold)) o.oceanThreshold = seuils.oceanThreshold;
  if (seuils && Number.isFinite(seuils.seaLevel)) {
    o.seaLevel = Math.max(RELIEF.minGround + 2, Math.round(seuils.seaLevel));
  }
  o.island = m.ile;
  o.islandRadius = m.rayonIle;
  o.islandShelf = Math.max(20, m.largeurCote);
  o.islandDepth = m.profondeurLarge;
  return o;
}

/**
 * Correctifs de `BIOMES`. Les seuils de climat viennent de l'étalonnage
 * (`world-preview.js`) : une part demandée en pourcentage n'a de sens que convertie
 * en seuil sur le champ réel du bruit, sinon le curseur ment.
 */
export function biomesOverrides(monde, seuils = {}) {
  const m = clampMonde(monde);
  const o = {};
  if (Number.isFinite(seuils.wetLimit)) o.wetLimit = seuils.wetLimit;
  else if (m.foret !== MONDE_DEFAULTS.foret) o.wetLimit = BIOMES.wetLimit;
  if (Number.isFinite(seuils.dryLimit)) o.dryLimit = seuils.dryLimit;
  else if (m.desert !== MONDE_DEFAULTS.desert) o.dryLimit = BIOMES.dryLimit;
  // La grève se compte au-dessus de la ligne de flottaison **effective** : si la mer
  // monte, le sable monte avec elle au lieu de disparaître sous les vagues — c'est déjà
  // ainsi que l'aperçu la peint. Elle ne dépasse jamais la ligne du projet, car
  // `VILLAGE.minGround` lotit juste au-dessus et une maison ne doit pas bâtir sur du sable.
  if (Number.isFinite(seuils.sandLine)) {
    const ligne = Math.max(RELIEF.minGround + 1, Math.min(BIOMES.sandLine, Math.round(seuils.sandLine)));
    if (ligne !== BIOMES.sandLine) o.sandLine = ligne;
  } else if (m.largeurPlage !== MONDE_DEFAULTS.largeurPlage) {
    o.sandLine = Math.max(RELIEF.minGround + 1,
      Math.min(BIOMES.sandLine, RELIEF.seaLevel + m.largeurPlage));
  }
  return o;
}

/**
 * Correctifs de `VILLAGE`. Les catégories d'immeuble sont tronquées ensemble —
 * `towerFloors`, `towerWeights` et `towerUrbanGate` se répondent index par index, et
 * un tableau plus court que les autres ferait lire `undefined` au tirage. Les trois types
 * de ville reçoivent leurs poids tels que l'écran les règle (relatifs, jamais normalisés
 * ici : le générateur les somme lui-même) et leur plafond d'étages bridé par le plafond
 * général, sinon une métropole continuerait à dix-huit étages alors que le joueur a tout
 * ramené à six.
 */
export function villageOverrides(monde) {
  const m = clampMonde(monde);
  const keep = [];
  for (let i = 0; i < VILLAGE.towerFloors.length; i++) {
    if (VILLAGE.towerFloors[i] <= m.immeublesMax) keep.push(i);
  }
  if (keep.length === 0) keep.push(0);
  const floors = keep.map((i) => VILLAGE.towerFloors[i]);
  const last = floors[floors.length - 1];
  const parts = [m.villesPetites, m.villesMoyennes, m.villesGrandes];
  return {
    cityChance: m.densiteVilles / 100,
    lotDensity: m.densiteVillages / 100,
    towerFloors: floors,
    towerWeights: keep.map((i) => VILLAGE.towerWeights[i]),
    towerUrbanGate: keep.map((i) => VILLAGE.towerUrbanGate[i]),
    // Le couronnement (acrotère, faîtage) dépasse le dernier plancher de deux cubes,
    // comme le `maxHeight` d'aujourd'hui pour la catégorie à quatorze étages.
    maxHeight: last * VILLAGE.floorPitch + 4,
    cityTypes: VILLAGE.cityTypes.map((t) => ({
      ...t, etagesMax: Math.min(t.etagesMax, m.immeublesMax),
    })),
    // Trois curseurs à zéro ne décrivent aucune ville : on retombe sur les poids du
    // projet plutôt que de laisser un tirage sans prise.
    cityTypeWeights: parts.some((p) => p > 0) ? parts : VILLAGE.cityTypeWeights.slice(),
  };
}

/** Le nom de la clé de stockage où loge la fiche d'un monde. */
export function mondeStorageKey(slot) {
  return `mincraft_monde:${String(slot || 'default')}`;
}

export const MONDE_STORAGE_PREFIX = 'mincraft_monde:';
