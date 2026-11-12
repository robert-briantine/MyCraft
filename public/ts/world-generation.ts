// Description du Monde réglable — la fiche qu'expose l'écran « Génération du monde »
// de la page d'accueil (markup dans public/index.html, champs déclarés dans
// public/js/world-config.js, étalonnage pourcentage→seuil dans public/js/world-preview.js).
//
// Ce fichier est une description, pas une source compilée : rien ne l'importe. Il doit
// donc se lire comme le contrat de l'écran — les mêmes noms, les mêmes unités et les
// mêmes valeurs par défaut que la fiche réellement transmise aux générateurs.
//
// Deux propriétés commandent la fiche, et elles ne sont pas négociables :
//
//  - **Les valeurs par défaut ne corrigent rien.** `MONDE_DEFAUT` reproduit cube pour
//    cube la génération d'avant l'écran : un monde créé sans toucher à aucun curseur
//    doit être identique à celui d'hier, puisque le jeu n'enregistre que le diff du
//    joueur et régénère le reste à partir de la fiche.
//  - **Une part demandée n'est pas un réglage, c'est un seuil sur un bruit.** Forêt,
//    désert et mer sont des pourcentages que l'écran convertit par bissection en
//    `BIOMES.wetLimit`, `BIOMES.dryLimit` et `RELIEF.oceanThreshold`. L'étiquette du
//    curseur porte la valeur visée, la carte et la légende portent la valeur obtenue :
//    elles peuvent différer de quelques points, jamais davantage sans que l'écran le dise.
//    Seule la grève échappe à cette règle : `largeurPlage` ne re-classe aucun bruit, elle
//    déplace une altitude, et se translate donc directement en `BIOMES.sandLine`.

/** Répartition des superficies — des pourcents, sauf la grève, en cubes. */
export interface RepartitionDuSol {
  /** Part des terres sous bois. Le grand boisé à l'échelle des océans reste toujours présent. */
  foret: number
  /** Part des terres sous sable. La plaine prend ce qui reste. */
  desert: number
  /** Part immergée du cœur de l'île — bassins intérieurs, hors talus côtier. */
  mer: number
  /**
   * Épaisseur de sable entre l'eau et l'herbe, en cubes au-dessus de la ligne de
   * flottaison — elle suit donc le niveau de la mer. À zéro, l'herbe va jusqu'à l'eau.
   * Indépendante de `desert` : même désert éteint, la grève reste du sable. Son plafond
   * est la grève d'aujourd'hui, car `VILLAGE.minGround` lotit juste au-dessus.
   */
  largeurPlage: number
}

/** Relief et bâti. */
export interface ReliefEtBati {
  /** Plafond visé des sommets, en cubes. Les massifs courants montent dans la même proportion. */
  hauteurMontagne: number
  /** Catégorie d'immeuble la plus haute autorisée, en étages ; les basses restent les plus fréquentes. */
  immeublesMax: number
  /** Part des mailles urbaines qui reçoivent un centre-bourg, en % . */
  densiteVilles: number
  /** Part des parcelles bâties loin de toute ville, en % . */
  densiteVillages: number
  /**
   * Parts **relatives** des trois types de ville (`VILLAGE.cityTypes`). Ce n'est pas une
   * répartition à sommer à cent : le type se tire au poids sur la maille urbaine, comme
   * le centre-bourg lui-même. Chaque type porte son rayon d'influence, son plafond
   * d'étages et sa fréquence de blocs d'immeubles — monter « grandes » fait donc à la
   * fois des agglomérations plus étendues et plus hautes.
   */
  villesPetites: number
  villesMoyennes: number
  villesGrandes: number
}

/**
 * Le bord du monde. Une île, pas un continent : au-delà du rayon, la terre cesse et
 * l'océan commence, plat jusqu'à l'horizon. La mer gagne par mélange vers un fond
 * constant (`terrain.islandMix`), jamais par soustraction — c'est ce qui fait une
 * plaine sous-marine exactement plane sous une eau exactement plane.
 */
export interface BordDuMonde {
  /** Mode île. Éteint, le monde redevient le pays continu d'avant. */
  ile: boolean
  /** Distance du centre au pied de la côte, en cubes. À 1600, compte huit minutes de marche. */
  rayonIle: number
  /** Longueur du talus où la terre plonge sous la ligne de flottaison : assez long pour rester franchissable à pied. */
  largeurCote: number
  /** Hauteur d'eau au-delà de la côte : assez pour que le fond disparaisse à l'horizon. */
  profondeurLarge: number
}

/** La fiche complète, telle que l'écran l'assemble et que la sauvegarde la relit. */
export interface Monde extends RepartitionDuSol, ReliefEtBati, BordDuMonde {
  /** Tire le relief, les minerais, la végétation et le village. Deux mondes de même graine sont identiques. */
  graine: number
}

/**
 * Valeurs par défaut : la génération telle qu'elle était avant l'écran. Les trois
 * pourcentages ne sont pas ronds — ils sont mesurés sur le monde par défaut (graine 42,
 * île de 1600 cubes, échantillon du cœur), sans quoi le panneau s'ouvrirait en
 * contredisant sa propre carte.
 */
export const MONDE_DEFAUT: Monde = {
  foret: 39,
  desert: 30,
  mer: 36,
  largeurPlage: 4,
  hauteurMontagne: 66,
  immeublesMax: 18,
  densiteVilles: 50,
  densiteVillages: 26,
  villesPetites: 45,
  villesMoyennes: 35,
  villesGrandes: 20,
  ile: true,
  rayonIle: 1600,
  largeurCote: 260,
  profondeurLarge: 14,
  graine: 42,
}

/** Bornes des curseurs, pour les contrôles de l'écran. */
export const PORTEES = {
  foret: { min: 5, max: 70 },
  desert: { min: 0, max: 60 },
  mer: { min: 2, max: 60 },
  largeurPlage: { min: 0, max: 4 },
  hauteurMontagne: { min: 40, max: 72 },
  immeublesMax: { min: 3, max: 18 },
  densiteVilles: { min: 0, max: 100 },
  densiteVillages: { min: 0, max: 60 },
  villesPetites: { min: 0, max: 100 },
  villesMoyennes: { min: 0, max: 100 },
  villesGrandes: { min: 0, max: 100 },
  rayonIle: { min: 300, max: 3000 },
  largeurCote: { min: 60, max: 600 },
  profondeurLarge: { min: 6, max: 30 },
  graine: { min: 1, max: 999999 },
}

/**
 * Surfaces en cubes², décomposées comme le monde les rend.
 *
 * Le cœur est le disque où l'on peut marcher — jusqu'au départ du talus, car l'anneau
 * du talus est déjà de l'eau qui descend. À l'intérieur, la part `mer` de la fiche noie
 * les bassins ; le reste se partage entre bois, sable et plaine. Tout ce qui dépasse le
 * cœur est du large : de l'eau profonde à perte de vue.
 */
export interface Superficies {
  coeur: number
  merInterieure: number
  terres: number
  foret: number
  desert: number
  plaine: number
  large: number
  total: number
}

export function superficieMonde(monde: Monde, cote = 4096): Superficies {
  const total = cote * cote
  if (!monde.ile) {
    const terres = total * (1 - monde.mer / 100)
    const foret = terres * (monde.foret / 100)
    const desert = terres * (monde.desert / 100)
    return {
      coeur: total, merInterieure: total - terres, terres,
      foret, desert, plaine: Math.max(0, terres - foret - desert),
      large: 0, total,
    }
  }
  const talus = Math.min(Math.max(20, monde.largeurCote), Math.max(20, monde.rayonIle - 60))
  const depart = Math.max(60, monde.rayonIle - talus)
  const coeur = Math.PI * depart * depart
  const merInterieure = coeur * (monde.mer / 100)
  const terres = coeur - merInterieure
  const foret = terres * (monde.foret / 100)
  const desert = terres * (monde.desert / 100)
  return {
    coeur, merInterieure, terres,
    foret, desert, plaine: Math.max(0, terres - foret - desert),
    large: Math.max(0, total - coeur), total,
  }
}

/**
 * Champs décrits mais non câblés : la faune n'a pas encore de générateur, et les
 * surfaces de ville ou de village ne se règlent pas — elles découlent des mailles
 * urbaines (`densiteVilles`) et des parcelles (`densiteVillages`). Gardées ici pour ne
 * pas perdre l'intention du croquis d'origine.
 */
export interface MondeEnAttente {
  superficieVille?: number
  superficieVillage?: number
  nombreVille?: number
  nombreVillage?: number
  nombreStatusHomme?: number
  nombreStatusElephant?: number
  nombreStatusCheval?: number
  nombreStatusAigle?: number
  /** Doublon de `ReliefEtBati.hauteurMontagne` du croquis d'origine. */
  hauteurMontagneMaxi?: number
  /** Plafond de génération (`chunkHeight - marge`), porté par le moteur, pas par la fiche. */
  hauteurMaxi?: number
}
