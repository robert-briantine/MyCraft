/**
 * L'eau qui coule — l'automate de propagation, hors de `game.js` pour la même raison que
 * l'éclairage et le relief : les suites Node jugent exactement ce que le jeu simulera.
 *
 * Le module est **pur** au sens où il ne connaît ni Three.js ni le stockage du monde :
 * on lui prête quatre fonctions (`bloc`, `niveau`, `solide`, `charge`) et une fonction
 * d'écriture (`ecrire`). Il ne décide que d'une chose : quelle cellule devient de l'eau,
 * laquelle redevient de l'air, et dans quel ordre.
 *
 * Quatre propriétés tiennent la simulation, et c'est la deuxième qui est la demande :
 *
 *  - **Événementielle.** Rien ne s'évalue tant qu'une édition du joueur n'a pas réveillé
 *    une cellule. La mer générée avec le relief est déjà à l'équilibre : la réveiller au
 *    chargement l'aurait fait couler dans chaque creux laissé sous un pont ou un quai.
 *  - **Bornée par la distance.** Chaque cellule porte sa distance à la source qui
 *    l'alimente ; au-delà de `PORTEE` cubes il n'y a rien. Une nappe ne peut donc jamais
 *    envahir le monde, et une galerie percée vers la mer se remplit sur sept cubes, pas
 *    jusqu'à l'autre bout de la carte.
 *  - **Cube entier, et jamais vers le haut.** Une cellule d'eau occupe le cube plein,
 *    qu'elle soit contre la brèche ou au bord de la portée : une nappe qui s'étale sur un
 *    sol plat reste une eau d'un cube de haut, pas une plaque de quelques centimètres sous
 *    les pieds du joueur — et toute cellule d'eau est donc assez profonde pour y nager.
 *    L'eau ne monte pas : elle tombe, ou coule de côté. Le plan d'une flaque ne peut ainsi
 *    dépasser la ligne d'eau de la source qui l'alimente, ce qui interdit à la mer — dont
 *    toutes les sources sont au niveau de la mer — d'enfler au-dessus de sa ligne.
 *  - **Convergente.** Une cellule se juge au plus `MAX_EVALS` fois entre deux éditions :
 *    deux colonnes qui se soutiennent mutuellement montent d'un cran à chaque tour
 *    jusqu'à dépasser la portée et se vident, au lieu de osciller indéfiniment. Sans ce
 *    garde-fou, l'automate n'a pas de point fixe garanti quand l'eau se retire.
 *
 * Le niveau 0 est réservé à la **source** : une cellule d'eau sans niveau enregistré est
 * pérenne (la mer, une rivière, le seau posé par le joueur), elle ne se tarit jamais et
 * sert de point de départ aux distances. Les niveaux 1 à `PORTEE` sont l'eau de passage,
 * qui disparaît dès qu'on la coupe de sa source.
 */

/** Distance maximale, en cubes, entre un filet d'eau et la source qui l'alimente. */
const PORTEE = 7;
/** Période d'une vague, en millisecondes. Une vague = un anneau de propagation. */
const PAS_MS = 140;
/** Cellules jugées par vague : le plafond de ce que coûte une inondation par image. */
const BUDGET = 512;
/** Combien de fois une cellule peut être retournée entre deux éditions du joueur. */
const MAX_EVALS = 24;
/**
 * Vagues consécutives sans une seule écriture avant d'abandonner la file. C'est la vraie
 * preuve qu'il n'y a plus rien à faire : une file qui tourne à vide depuis trente tours ne
 * découvrira plus rien, et la laisser tourner coûterait du processeur pour des images
 * identiques. Le garde ne coupe donc jamais une propagation en cours — il n'en coupe que
 * l'écho.
 */
const MAX_VAGUES_SANS_ECRIRE = 32;
/** File d'attente au-delà de laquelle on abandonne la vague plutôt que de geler l'onglet. */
const MAX_FILE = 20000;

export const EAU = { PORTEE, PAS_MS, BUDGET, MAX_EVALS, MAX_VAGUES_SANS_ECRIRE, MAX_FILE };

const HORIZONTALES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
// Les six voisines plus la cellule elle-même : une cellule qui change peut avoir à se
// corriger elle-même au tour suivant (son appui vient de partir, sa voisine vient de
// monter), et le seul moyen de le découvrir est de la rejuger.
const A_REVEILLER = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * Construit un automate.
 *
 * @param {object} cfg
 * @param {number} cfg.height     hauteur totale du monde, en cubes
 * @param {(x:number,y:number,z:number)=>number} cfg.bloc       identifiant de bloc
 * @param {(x:number,y:number,z:number)=>number|null} cfg.niveau niveau d'eau de passage, null pour une source
 * @param {(x:number,y:number,z:number)=>boolean} cfg.solide     ce qui tient l'eau par en dessous
 * @param {(x:number,z:number)=>boolean} cfg.charge              la colonne existe-t-elle (tronçon généré)
 * @param {(cells:Array<[number,number,number,number,number|null]>)=>void} cfg.ecrire écriture groupée d'une vague
 */
export function creerEau(cfg) {
  const {
    height, bloc, niveau, solide, charge, ecrire,
    portee = EAU.PORTEE, budget = EAU.BUDGET, maxEvals = EAU.MAX_EVALS,
    maxVaguesSansEcrire = EAU.MAX_VAGUES_SANS_ECRIRE,
    maxFile = EAU.MAX_FILE, ID_AIR = 0, ID_EAU = 7,
  } = cfg;

  let aFaire = [];                 // cellules jugées à la prochaine vague
  const vues = new Set();          // clés déjà en file, pour ne pas payer deux fois la même question
  const compteurs = new Map();     // clé -> nombre de revirements depuis son dernier réveil
  const ecrites = new Map();       // clé -> [x,y,z,id,niveau] : les écritures de la vague en cours
  let sansEcriture = 0;            // vagues consécutives sans une seule écriture (voir le watch-dog)
  let sature = false;              // la file a-t-elle déjà crié cette session ? (un seul avertissement)

  const cle = (x, y, z) => `${x},${y},${z}`;

  // Pendant une vague, les lectures voient d'abord les écritures déjà décidées : sans cet
  // overlay, une colonne d'eau descendrait case par case au lieu de couler d'un trait,
  // parce que chaque évaluation ignorerait la voisine qu'elle vient de créer.
  const ecrite = (x, y, z) => ecrites.get(cle(x, y, z));
  const lire = (x, y, z) => {
    const e = ecrite(x, y, z);
    return e ? e[3] : bloc(x, y, z);
  };
  const lireNiveau = (x, y, z) => {
    const e = ecrite(x, y, z);
    return e ? e[4] : niveau(x, y, z);
  };

  const dansMonde = (y) => y >= 0 && y < height;
  const estEau = (x, y, z) => dansMonde(y) && charge(x, z) && lire(x, y, z) === ID_EAU;
  /** Distance à la source : une cellule sans niveau enregistré EST la source. */
  const distance = (x, y, z) => {
    const n = lireNiveau(x, y, z);
    return n == null ? 0 : n;
  };
  const appuie = (x, y, z) => {
    if (y < 0) return true;                     // le fond du monde tient tout
    if (!dansMonde(y)) return false;
    const b = lire(x, y, z);
    return b === ID_EAU || solide(x, y, z);
  };

  function programmer(x, y, z) {
    if (!dansMonde(y)) return;
    const k = cle(x, y, z);
    if (vues.has(k)) return;
    if (aFaire.length >= maxFile) {
      // On lâche la vague plutôt que de faire tourner l'onglet dans le vide : le joueur
      // a la main sur ce qui déborde, une nouvelle édition remettra la file en route.
      if (!sature) {
        sature = true;
        console.warn(`eau : file saturée à ${maxFile} cellules, propagation interrompue`);
      }
      return;
    }
    vues.add(k);
    aFaire.push([x, y, z]);
  }

  function reveillerVoisins(x, y, z) {
    for (const [dx, dy, dz] of A_REVEILLER) programmer(x + dx, y + dy, z + dz);
  }

  /**
   * Réveille une cellule et ses voisines : c'est le seul point d'entrée du monde. Appelé
   * après chaque édition du joueur, il met aussi la cellule éditée elle-même dans la file,
   * parce qu'un cube retiré devant la mer est précisément la cellule à noyer.
   */
  function reveiller(x, y, z) {
    compteurs.delete(cle(x, y, z));   // une édition du joueur rouvre le droit de se tromper
    sansEcriture = 0;                 // et rouvre l'épisode : le watch-dog repart de zéro
    sature = false;                   // idem pour l'avertissement de file pleine
    reveillerVoisins(x, y, z);
  }

  function inscrire(x, y, z, id, niv) {
    ecrites.set(cle(x, y, z), [x, y, z, id, niv]);
  }

  /**
   * Prend la décision et réveille le voisinage — à condition que la cellule n'ait pas déjà
   * trop tourné. Le compteur ne juge que les **changements obtenus**, jamais les réveils :
   * une cellule peut être questionnée des dizaines de fois par le remous pendant que le
   * front approche, et la condamner pour cela gelait la nappe à quatre cubes de la brèche
   * (mesuré avant cette règle). Une cellule qui bascule vraiment plus de `maxEvals` fois
   * entre deux éditions du joueur est en revanche un battement sans point fixe : on la laisse
   * telle quelle, le joueur reprendra la main à sa prochaine édition.
   */
  function decider(x, y, z, id, niv) {
    const k = cle(x, y, z);
    const n = (compteurs.get(k) || 0) + 1;
    if (n > maxEvals) return false;
    compteurs.set(k, n);
    inscrire(x, y, z, id, niv);
    reveillerVoisins(x, y, z);
    return true;
  }

  /**
   * Juge une cellule : doit-elle de l'eau, et à quelle distance de la source ?
   *
   * Trois façons d'être mouillée, dans l'ordre de préférence (la plus proche de la source
   * gagne, parce que c'est elle qui restera debout quand les autres se tariront) :
   *
   *  1. **tomber** — l'eau juste au-dessus coule ici sans entamer sa portée, ce qui laisse
   *     une cascade remplir sa colonne d'un seul tenant au lieu d'un cube par seconde ;
   *  2. **couler de côté** — une voisine donne sa distance + 1, mais seulement si le
   *     fond est là : un filet ne s'accroche pas au vide, sinon la mer construirait des
   *     passerelles suspendues au-dessus des grottes.
   *
   * Rien d'autre : l'eau ne monte jamais dans la cellule au-dessus d'elle. Sans cette
   * clause, une nappe appuyée sur un sol plat empilait des cubes par-dessus sa propre ligne
   * d'eau — mesuré avant correction, un geyser de sept cubes au droit de la brèche, et la
   * mer qui noyait le sable au-dessus du niveau de la mer dès qu'on y perçait un trou. Le
   * plan d'une flaque reste donc à la hauteur de ses sources, et une galerie couverte ne se
   * remplit que sur un étage.
   */
  function revaluer(x, y, z) {
    if (!charge(x, z)) return 0;
    const b = lire(x, y, z);
    if (b !== ID_AIR && b !== ID_EAU) return 0;   // jamais sur du plein : le joueur prime

    // `undefined` = sec, `null` = source pérenne, un nombre = eau de passage.
    const etat = b === ID_EAU ? lireNiveau(x, y, z) : undefined;
    if (etat === null) return 0;                  // une source ne se déplace pas

    // Les deux familles sont toujours comparées, jamais court-circuitées. La chute ne coûte
    // rien : si elle répondait la première, l'étalement latéral ne serait plus jamais jugé
    // et une nappe n'atteindrait plus que trois cubes du rivage (mesuré avant correction :
    // la hauteur d'une tranchée s'envolait d'un niveau par vague et oscillait). Le minimum
    // des candidats est ce qui reste debout quand les autres chemins se tarissent.
    let vise = Infinity;
    if (estEau(x, y + 1, z)) vise = Math.min(vise, distance(x, y + 1, z));
    for (const [dx, dz] of HORIZONTALES) {
      if (!estEau(x + dx, y, z + dz)) continue;
      const d = distance(x + dx, y, z + dz) + 1;
      if (d < vise && d <= portee && appuie(x, y - 1, z)) vise = d;
    }

    if (!(vise <= portee)) {
      // Plus aucune voisine ne peut l'alimenter. Une source reste ; l'eau de passage part.
      if (etat === undefined) return 0;
      return decider(x, y, z, ID_AIR, null) ? 1 : 0;
    }
    if (etat === vise) return 0;
    return decider(x, y, z, ID_EAU, vise) ? 1 : 0;
  }

  /**
   * Fait avancer le fluide d'un anneau. Les cellules découvertes pendant la vague ne sont
   * jugées qu'à la vague suivante : c'est ce découpage qui rend l'étalement progressif à
   * l'œil, et qui borne le travail d'une image à `budget` cellules plus un seul remaillage
   * groupé des tronçons touchés.
   */
  function vague() {
    const tour = aFaire;
    aFaire = [];
    vues.clear();
    ecrites.clear();

    let evaluees = 0;
    let modifiees = 0;
    let i = 0;
    for (; i < tour.length && evaluees < budget; i++) {
      const [x, y, z] = tour[i];
      evaluees++;
      modifiees += revaluer(x, y, z);
    }
    // Ce que le budget n'a pas pu juger repart tel quel à la vague suivante.
    for (; i < tour.length; i++) {
      const [x, y, z] = tour[i];
      const k = cle(x, y, z);
      if (vues.has(k)) continue;
      vues.add(k);
      aFaire.push([x, y, z]);
    }

    if (ecrites.size > 0) ecrire([...ecrites.values()]);
    // Le watch-dog d'écho : trente tours à ne rien écrire veulent dire que la file ne
    // contient plus que des questions sans réponse. La vider coûte zéro image à venir ;
    // la laisser tourner coûterait du processeur jusqu'à la prochaine édition du joueur.
    if (modifiees === 0) {
      sansEcriture++;
      if (sansEcriture >= maxVaguesSansEcrire && aFaire.length > 0) {
        console.warn(`eau : ${aFaire.length} cellules abandonnées après ${sansEcriture} vagues sans écriture`);
        aFaire = [];
        vues.clear();
      }
    } else {
      sansEcriture = 0;
    }
    const rendu = { evaluees, modifiees, enAttente: aFaire.length };
    ecrites.clear();
    return rendu;
  }

  return {
    reveiller,
    vague,
    enAttente: () => aFaire.length,
    /** Tout oublier : changement de monde. Les niveaux, eux, vivent dans le monde. */
    reinitialiser() {
      aFaire = [];
      vues.clear();
      compteurs.clear();
      ecrites.clear();
      sansEcriture = 0;
      sature = false;
    },
    params: { portee, budget, maxEvals },
  };
}
