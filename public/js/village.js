// Générateur de village : routes en grille, maisons basses et immeubles.
//
// Tout sort d'un hachage des coordonnées : aucun Math.random() ici. Le monde
// n'est enregistré que sous forme du diff du joueur, donc un tronçon régénéré
// après rechargement doit tomber cube pour cube sur le précédent, bâtiments
// compris.
//
// Le module est volontairement sans dépendance (ni DOM, ni three) : il reçoit la
// table de blocs, les dimensions de tronçon, la fonction de relief et une tireuse
// aléatoire déterministe, ce qui permet de le tester sous Node sans navigateur.

export const VILLAGE = {
  roadSpacing: 80,   // une avenue tous les 80 blocs sur chaque axe
  roadHalf: 2,       // chaussée de 5 cubes (±2 autour de l'axe)
  kerb: 1,           // caniveils pavés de part et d'autre de la chaussée
  skippedLineChance: 0.12, // certaines lignes sautent pour casser la monotonie
  lotDensity: 0.26,  // fraction des parcelles bâties loin de toute ville
  cityDensity: 1,    // …et au cœur d'une ville : le bâti se concentre
  courtWidth: 2,     // largeur de la cour libre ceinturant chaque bâtiment — demandée
                     // le 2026-11-09 : « je voudrais que chaque bâtiment ait une cour
                     // qui l'entoure pour assurer l'accès à l'intérieur, cette cour doit
                     // faire deux cubes de large ». Bande dégagée entre deux façades,
                     // entre une façade et le tronçon voisin, et entre une façade et le
                     // caniveau : on peut toujours tourner autour d'un bâtiment et
                     // joindre sa porte. Deux cubes, pas un : le collider du joueur fait
                     // 0,6 et chevauche la colonne voisine dès qu'il n'est pas centré.
  courtFlat: 3,      // écart maximal toléré entre le relief naturel d'une colonne de cette
                     // bande et le seuil du bâtiment qu'elle ceinture. Demandé le
                     // 2026-11-09 : « la bande autour de bâtiment doit être du même niveau,
                     // pas d'escalier autour d'un bâtiment sur une longueur de 2 cubes ».
                     // Le seuil se tire sur une moyenne large (`palier`) : sans regard sur la
                     // bande elle-même, le bâti s'asseyait n'importe où sur la pente et le
                     // nivellement ne pouvait pas rattraper l'écart (mesuré sur le monde du
                     // jeu, R = 12, 180 bâtiments, aucune exemption : 125 bâtiments à
                     // ressauts de plus d'un cube dans leur bande, écart au seuil jusqu'à 18).
  towerChance: 0.22, // part des immeubles parmi les parcelles bâties, à la campagne
  cityTowerChance: 0.62, // en ville on monte
  minGround: 20,     // le sable commence au-dessous : pas de village sur la grève
  maxGround: 38,     // la neige commence au-dessus : ni sur les sommets enneigés
  // Très hautes montagnes — les massifs soulevés à l'échelle des océans (`RELIEF.alps*`).
  // Demandé le 2026-11-09 : « des zones de la même taille que les océans de très haute
  // montagne sans immeuble et avec quelques maisons ». Trois règles, dans cet ordre :
  // rien d'urbain (ni centre-bourg, ni immeuble) dès que l'intensité du massif monte ;
  // rien de bâti du tout sur les flancs, sauf aux hameaux tirés à la maille ; et ces
  // hameaux sont les seuls à avoir le droit de s'asseoir au-dessus de la ligne de neige.
  alpsNoTower: 0.10,   // intensité du massif où un centre-bourg est refusé (la ville, pas la maison)
  alpsWild: 0.06,      // en dessous, le pays n'est pas une montagne : village ordinaire
  hamletChance: 0.05,  // part des tronçons de montagne qui reçoivent un hameau
  hamletDensity: 0.55, // part des parcelles bâties d'un hameau retenu
  hamletMinGround: 30, // on ne bâtit pas au pied du massif : le hameau doit le regarder
  hamletMaxGround: 46, // …et pas non plus sur l'arête : au-dessus, c'est la glace
  maxReliefHouse: 7, // maison à demi enterrée dans la pente, comblée jusqu'au terrain
  maxReliefTower: 8, // une tour s'adosse à la pente, son seuil reste calé sur la rue
  floorPitch: 3,     // un étage = 3 blocs (dalle porteuse + deux cubes d'air libre)
  maxHeight: 46,     // plafond absolu : la plus haute catégorie, plus le couronnement
  // Catégories d'immeuble, demandées le 2026-11-09 : « je voudrais plusieurs categorie
  // d'immeuble 3 etage 6 etage et 10 etage et 14 etage , leur frequence diminue avec le
  // nombre d'etage plus il y a d'etage moin l'immeuble est frequent ». Le tirage se fait
  // dans `towerWeights`, et une catégorie que le site ne peut pas gravir (volée trop
  // courte) ni coiffer (sommet du monde) redescend d'un cran plutôt que de s'imposer.
  towerFloors: [3, 6, 10, 14],
  towerWeights: [45, 30, 17, 8],
  // Les catégories hautes sont l'apanage du centre-bourg — arbitrage de l'utilisateur :
  // « Oui, hauteur liée à l'influence ». En dessous de la borne d'influence urbaine
  // normalisée, la catégorie est refusée et le tirage retombe sur la plus basse.
  towerUrbanGate: [0, 0.15, 0.3, 0.4],
  houseMinH: 3, houseMaxH: 6,
  cityCell: 176,     // maille basse fréquence où l'on tire l'emplacement des villes
  cityChance: 0.5,   // part des mailles qui reçoivent un centre-bourg
  cityRadius: 150,   // au-delà, l'influence urbaine retombe à zéro

  // Ponts : une avenue portée en tablier là où le relief plonge. Le terrain n'est
  // jamais modifié — seul le revêtement de la voirie change d'altitude.
  bridgeChance: 0.8,      // part des franchissements candidats qui reçoivent un pont
  bridgeCell: 40,         // maille le long d'une avenue où l'on tente un franchissement
  bridgeMinDip: 8,        // creux sous le tablier sans quoi une simple chaussée suffit
  bridgeClearance: 5,     // cubes libres sous le tablier : on doit pouvoir y marcher
  bridgeMaxClearance: 7,  // au-delà l'arcade baille et ne se lit plus comme un pont
  bridgeMinArcade: 4,     // colonnes où le sol est assez bas pour donner une vraie travée
  bridgeMinSpan: 10,      // portée minimale : en dessous ce n'est qu'un dalot, pas un pont
  bridgeMaxSpan: 30,      // au-delà le tablier n'est plus tenable ni lisible
  bridgePierEvery: 8,     // une pile (deux colonnes) tous les 8 cubes de portée
  bridgeMaxRamp: 8,       // longueur maximale d'un rampement d'accès
  headroom: 4,            // cubes libres au-dessus de toute surface où l'on marche

  // Franchissement d'eau : une avenue coupée par une rivière ou un bras marin étroit
  // est portée en tablier sur piles plutôt que laissée en impasse sur la berge. La
  // haute mer garde son rivage — un viaduc sans rive d'en face n'est pas un pont.
  waterMinSpan: 4,        // en dessous, l'avenue ne traverse qu'un fossé : le pavé suffit
  waterMaxSpan: 90,       // au-delà ce n'est plus un bras mais le large : on s'arrête.
                          // Porté de 30 à 90 le 2026-11-09 — « il y a des routes coupées
                          // par l'eau, prolonge-les avec des ponts » : mesuré sur le monde
                          // du jeu, 57 coupures sur 84 sans ouvrage étaient refusées pour
                          // seule largeur (médiane 38 colonnes). La rive d'en face reste
                          // la condition : sans terre sèche des deux côtés, c'est la mer
                          // et elle garde son rivage
  waterFreeboard: 5,      // cubes entre le plan d'eau et le tablier : le chenal se nage
  waterArchRise: 3,       // descente des naissances sous le soffite : c'est ce qui fait
                          // lire l'arc sous un viaduc, la clé restant à hauteur pleine
  waterMaxRamp: 12,       // longueur d'accès d'un viaduc : plus longue que celle d'un pont
                          // de vallon — un tablier sur l'eau peut porter sa chaussée plus
                          // loin, alors qu'une impasse sur la berge reste une impasse

  // Voirie : la chaussée garde sa ligne droite et se pose un profil à un cube par
  // colonne, mais seulement là où le relief s'écarte vraiment d'elle. Le relief n'est
  // jamais modifié — seul le revêtement change d'altitude, comme sous un pont.
  roadStepWindow: 24,     // colonnes sondées de part et d'autre pour conduire la montée
  roadSmooth: 16,         // colonnes moyennées de part et d'autre avant de viser le relief
                          // (mesuré sur ±224 cubes : 55 % de chaussée plate à 1, 74 % à 16,
                          // pour le même remblai maximal de dix-sept cubes)
  roadFlatBand: 2,        // hauteur d'un palier : la chaussée se cale sur ces niveaux,
                          // d'où de longues suites exactement plates

  // Arcs de triomphe : posés en travers d'une avenue, côté centre-bourg.
  archChance: 0.6,
  archCell: 96,           // maille le long d'une avenue où l'on tente un arc
  archMinCity: 0.4,       // assez loin du centre, l'arc n'a plus rien de monumental
  archKeepout: 18,        // distance à l'avenue croisée : un arc se dresse en pleine rue
  archHalf: 3,            // l'ouvrage occupe chaussée et caniveaux, ±3 cubes
  archPassage: 1,         // libre de part et d'autre de l'axe
  archShoulder: 2,        // cubes pleins sous le cintré, de chaque côté du passage

  // Temples : un monument de pierre, de verre et d'or, isolé et **beaucoup plus rare que
  // le bâti courant**. Il doit se voir de la route : son parvis mesure quatre fois la
  // largeur d'une maison, sa galerie est à colonnes reliées d'arches, le naos est percé
  // de vitres et son faîtage doré dépasse tous les toits. Il se pose sur un plateau
  // naturel, jamais sur la voirie ni sous un bâtiment : il est estampé après eux, et rien
  // ne doit s'écraser l'un l'autre.
  templeCell: 78,
  templeChance: 0.35,
  templeTries: 40,        // sites sondés dans la maille avant de renoncer (voir computeTemple)
  templeHalf: 13,         // emprise du parvis : 27 cubes, soit quatre maisons de front
  templeSteps: 5,         // gradins menant au parvis
  templeStairExtra: 6,    // rangées supplémentaires autorisées quand la pente fuit sous le
                          // monument : l'escalier doit toucher le sol, sinon il reste une
                          // face verticale de dix-huit cubes à son pied
  templeStairWidth: 2,    // demi-largeur du degré : cinq colonnes d'accès
  templeMaxRelief: 8,     // niveau exigé sous le naos et la colonnade
  templeColumnPitch: 3,   // une colonne sur trois autour du naos
  templeHeight: 9,        // hauteur des colonnes et des murs au-dessus du parvis
  templeCellaHalf: 7,     // salle intérieure : 15×15 cubes
  templeRoofPitch: 1,     // le comble monte d'un cube par gradin

  // Statues monumentales : quatre colosses de pierre — homme, éléphant, cheval, aigle —
  // plantés au cœur des villes. Demandé le 2026-11-09 : « je voudrais que tu ajoute de
  // tres grande status dans les villes , des status a forme humaine , d'elephant de cheval
  // et d'aigle ». Arbitrages de l'utilisateur : ~30 cubes de haut, une par ville, pierre
  // patinée sans or. La hauteur se compte du sol naturel à la pointe la plus haute ; le
  // gabarit est mis à l'échelle sous deux bornes (hauteur visée ET encombrement au sol),
  // sinon l'aigle déployé mesurerait cinquante cubes d'une serre à l'autre.
  statueCell: 176,        // même maille que les villes : c'est le centre-bourg qui décide
  statueChance: 0.8,      // part des mailles urbaines qui reçoivent leur colosse
  statueMinCity: 0.45,    // influence urbaine normale minimale : une statue n'est pas un carrefour
  statueTries: 60,        // sites sondés dans la maille avant de renoncer — les grandes
                          // formes (éléphant, aigle) en exigent trois fois plus que l'homme :
                          // leur emprise tient moins souvent entre deux avenues
  statueHeight: 26,       // corps seul, du dessus du socle à la pointe ; + socle ≈ 30 cubes
  statueSpan: 30,         // encombrement maximal au sol, dans un axe comme dans l'autre
  statuePlinth: 4,        // hauteur du piédestal, gravi par son degré
  statueStairWidth: 2,    // demi-largeur du degré : cinq colonnes d'accès
  statueStairExtra: 6,    // rangées supplémentaires autorisées quand la pente fuit sous le
                          // socle — même règle qu'au temple (`templeStairExtra`)
  statuePad: 4,           // réserve de perspective autour de l'emprise : ni rue, ni bâti collé
  statueMaxRelief: 12,    // écart de niveau toléré sous le piédestal : le socle se coule du
                          // sol de chaque colonne jusqu'à sa table, la place peut donc être
                          // en pente. C'est le pourtour et le degré qui restent exigeants.
};

// Nombre de planchers visibles d'une hauteur donnée : c'est ce que l'on compte depuis
// la rue, et ce que vérifient les tests. Le premier est à quatre cubes du seuil (le
// temps que le joueur puisse lever d'un cran), les suivants au pas de `floorPitch`,
// donc une tour à `maxHeight` en compte dix.
export const storeysOf = (height) => Math.max(0,
  Math.floor((height - VILLAGE.floorPitch - 2) / VILLAGE.floorPitch) + 1);

// L'inverse, à ceci près qu'on prend le bas de la fourchette : `n` étages tiennent de
// `n * floorPitch + 2` à `n * floorPitch + 4` cubes, et la plus petite valeur compte
// exactement `n` planchers. C'est la cote que vise une catégorie d'immeuble.
export const hauteurPourEtages = (n) => n * VILLAGE.floorPitch + 2;

// Le plus petit immeuble que le village se donne : sa volée doit au moins tenir cette
// montée, sinon le tirage « immeuble » ne produirait qu'une maison plus chère.
const TOUR_MIN_H = hauteurPourEtages(VILLAGE.towerFloors[0]);

// Les quatre tirages d'une même parcelle doivent être indépendants.
const SALT_LOT = 11;
const SALT_KIND = 12;
const SALT_SIZE = 13;
const SALT_PLACE = 14;
const SALT_MATERIAL = 15;
const SALT_DOOR = 16;
const SALT_DETAIL = 17;
const SALT_STAIR = 18;
const SALT_HEIGHT = 19;
const SALT_LAYOUT = 20;
const SALT_ROAD_X = 21;
const SALT_ROAD_Z = 22;
const SALT_CITY = 23;
const SALT_CITY_X = 24;
const SALT_CITY_Z = 25;
const SALT_BRIDGE = 26;
const SALT_ARCH = 27;
const SALT_BRIDGE_MAT = 28;
const SALT_TEMPLE = 29;
const SALT_TEMPLE_DOOR = 30;
const SALT_HAMEAU = 31;
const SALT_STATUE = 32;
const SALT_STATUE_FORME = 33;
const SALT_STATUE_PIERRE = 34;

// Les quatre faces du parvis, dans l'ordre du tirage de porte : +x, −x, +z, −z.
const TEMPLE_DIRS = [
  { dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 },
];

export function createVillageGen({ BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt, roll: rawRoll, saltBase = 0, seaLevel = -1, waterTopAt = null, alpsAt = null }) {
  const cache = new Map(); // clé de tronçon -> plan de bâtiment (ou null)
  // Décalage commun à tous les sels : changer la graine du village redessine tout
  // le réseau, sans quoi l'option ne servirait à rien.
  const base = saltBase | 0;
  const roll = (x, y, z, salt) => rawRoll(x, y, z, (salt + base) | 0);

  /**
   * La mer n'est pas un sol : ni avenue, ni pont, ni arc, ni centre-bourg dessus. Les
   * bâtiments et les temples y échappaient déjà — leur emprise exige le terrain entre
   * `minGround` et `maxGround`, et la ligne de sable tient trois cubes au-dessus de
   * l'eau. `-1` par défaut laisse le module sans mer, comme avant l'océan.
   *
   * Une rivière est traitée de même : son plan d'eau est local et plus haut que la mer,
   * donc seule la colonne jugée contre son propre plan d'eau décide. Paver par-dessus
   * ferait une digue qui retiendrait le cours en amont.
   */
  const planDEau = (x, z) => Math.max(seaLevel, waterTopAt ? waterTopAt(x, z) : seaLevel);
  const noye = (x, z) => ground(x, z) < planDEau(x, z);

  const pick = (list, x, y, z, salt) => list[Math.floor(roll(x, y, z, salt) * list.length) % list.length];
  const between = (min, max, x, y, z, salt) =>
    min + Math.floor(roll(x, y, z, salt) * (max - min + 1));

  /**
   * Relief mis en cache : les ouvrages d'art sondent des profils entiers le long des
   * avenues et l'estampage relit les mêmes colonnes ; sous le bruit simplex de jeu,
   * ces relectures coûtent plus cher que la génération elle-même. La clé encode les
   * deux axes dans un entier (|coordonnée| < 2^21) pour rester une Map à clés nombres.
   */
  const groundCache = new Map();
  const KEY_BASE = 4194304; // 2^22
  function ground(x, z) {
    const key = x * KEY_BASE + z;
    const hit = groundCache.get(key);
    if (hit !== undefined) return hit;
    const h = heightAt(x, z);
    if (groundCache.size > 65536) groundCache.clear();
    groundCache.set(key, h);
    return h;
  }

  /**
   * Intensité du très haut massif sous une colonne, de 0 (pays ordinaire) à 1 (cœur de
   * la chaîne). Renvoyée par le relief — le village n'a pas à savoir refaire un bruit.
   * Mémoïsée comme le sol : chaque tronçon la sonde en son centre, et les ouvrages d'art
   * recourent au même prédicat le long des avenues.
   */
  const alpsCache = new Map();
  const intensiteAlpes = alpsAt || (() => 0);
  function alpage(wx, wz) {
    const key = wx * KEY_BASE + wz;
    const hit = alpsCache.get(key);
    if (hit !== undefined) return hit;
    const v = intensiteAlpes(wx, wz);
    if (alpsCache.size > 65536) alpsCache.clear();
    alpsCache.set(key, v);
    return v;
  }

  /**
   * Le plateau où pose le bâti : le relief moyenné sur une emprise large, arrondi à
   * l'entier. Fonction **pure de la position** — c'est tout son intérêt. Les plans se
   * calculent tronçon par tronçon et l'un ne peut lire celui du voisin sans faire
   * boucler la génération ; en revanche deux parcelles voisines qui puisent dans les
   * mêmes colonnes tombent d'accord sans se consulter. Chacune tirait son seuil de son
   * propre coin bas (`minH`) : mesuré sur 237 bâtiments du monde, 179 cours portaient
   * des ressauts de plus d'un cube, 233 s'écartaient du seuil de plus d'un cube (jusqu'à
   * 18), et 1309 colonnes de cour étaient revendiquées par deux seuils distants de plus
   * d'un cube — donc impossibles à niveler après coup.
   */
  const PALIER_RAYON = VILLAGE.courtWidth + 4;
  const palierCache = new Map();
  function palier(x, z) {
    const key = x * KEY_BASE + z;
    const hit = palierCache.get(key);
    if (hit !== undefined) return hit;
    let somme = 0;
    let n = 0;
    for (let dx = -PALIER_RAYON; dx <= PALIER_RAYON; dx++) {
      for (let dz = -PALIER_RAYON; dz <= PALIER_RAYON; dz++) {
        somme += ground(x + dx, z + dz);
        n++;
      }
    }
    const v = Math.round(somme / n);
    if (palierCache.size > 65536) palierCache.clear();
    palierCache.set(key, v);
    return v;
  }

  /** Au-delà, « niveler » une cour veut dire remblayer une digue ou creuser une carrière : le
   *  gabarit est refusé avant d'être posé plutôt que d'offrir un mur de soutènement au joueur.
   *  Largement ouvert sur les 3 cubes promis — sur un relief à sillons, refuser au-delà de quatre
   *  cubes vidait le village (mesuré : 0 bâtiment sur 289 tronçons, contre 133 plus bas). */
  const PORTEE_BANDE = 8;

  /** Le niveau d'une colonne que nous ne posons pas : la chaussée a son profil, un lit d'eau le
   *  sien, la pierre du monument aussi. `null` = colonne libre, celle qu'on pose au niveau de la
   *  cour. La garde de site et le nivellement lisent cette même fonction. */
  function surfaceImposee(wx, wz) {
    if (roadKind(wx, wz)) return surfaceAt(wx, wz);
    if (noye(wx, wz)) return planDEau(wx, wz);
    if (templeStone(wx, wz)) return ground(wx, wz);
    return null;
  }

  /**
   * Niveau que réclame la bande de deux cubes de ce gabarit, ou `null` si elle ne peut l'avoir.
   *
   * Le niveau est la **médiane du relief naturel** des colonnes libres de la bande : la cour
   * coûte alors le moins de déblai possible, et elle est plate par construction puisque chaque
   * colonne libre est écrite à cette valeur. Ce n'est pas une correction après coup sur un relief
   * que personne n'aurait consulté — `tryPlan` refuse le gabarit avant de bâtir si la promesse
   * est intenable ici. Trois bornes la rendent tenable :
   *  - aucune colonne libre ne doit être remblayée ni déchaussée de plus de `PORTEE_BANDE`
   *    (au-delà, on bâtirait un mur de soutènement, pas une cour) ;
   *  - les surfaces qui ont leur régime propre — chaussée, lit d'eau, pierre du monument —
   *  restent où elles sont mais ne doivent pas faire mur ;
   *  - le niveau ne dépend que de la position et du gabarit : jamais de l'état d'un tronçon
   *    voisin ni de l'ordre dans lequel les tronçons ont été générés.
   */
  function niveauDeCour(wx0, wz0, cw, cd) {
    const pad = VILLAGE.courtWidth;
    const x1 = wx0 + cw - 1;
    const z1 = wz0 + cd - 1;
    const rampe = pad + 2;
    const bruts = [];
    const imposees = [];
    for (let wx = wx0 - pad; wx <= x1 + pad; wx++) {
      for (let wz = wz0 - pad; wz <= z1 + pad; wz++) {
        if (wx >= wx0 && wx <= x1 && wz >= wz0 && wz <= z1) continue;
        const imposee = surfaceImposee(wx, wz);
        if (imposee !== null) imposees.push(imposee);
        else bruts.push(ground(wx, wz));
      }
    }
    if (!bruts.length) return null;
    bruts.sort((p, q) => p - q);
    const v = bruts[bruts.length >> 1];
    if (v - bruts[0] > PORTEE_BANDE || bruts[bruts.length - 1] - v > PORTEE_BANDE) return null;
    for (const h of imposees) if (Math.abs(h - v) > rampe) return null;
    return v;
  }

  /** Position relative à l'axe de route le plus proche, sur un axe donné. */
  function laneOf(value, spacing) {
    const k = Math.round(value / spacing);
    return { k, offset: value - k * spacing };
  }

  /** Une ligne de circulation peut être supprimée pour éviter un damier parfait. */
  function lineExists(k, salt) {
    return roll(k, 0, 0, salt) >= VILLAGE.skippedLineChance;
  }

  /**
   * 'bed' = chaussée, 'kerb' = caniveau, null = terrain naturel.
   * Les routes sont définies par coordonnées absolues : elles se raccordent donc
   * d'elles-mêmes aux frontières de tronçon, contrairement à un tracé par tronçon.
   */
  function roadKind(wx, wz) {
    const ns = laneOf(wz, VILLAGE.roadSpacing);
    const ew = laneOf(wx, VILLAGE.roadSpacing);
    const onNs = lineExists(ns.k, SALT_ROAD_Z) && Math.abs(ns.offset) <= VILLAGE.roadHalf;
    const onEw = lineExists(ew.k, SALT_ROAD_X) && Math.abs(ew.offset) <= VILLAGE.roadHalf;
    if (onNs || onEw) return 'bed';
    const kerbNs = lineExists(ns.k, SALT_ROAD_Z)
      && Math.abs(ns.offset) === VILLAGE.roadHalf + VILLAGE.kerb;
    const kerbEw = lineExists(ew.k, SALT_ROAD_X)
      && Math.abs(ew.offset) === VILLAGE.roadHalf + VILLAGE.kerb;
    if (kerbNs || kerbEw) return 'kerb';
    return null;
  }

  /** Centre de la ville attachée à une maille, ou null si cette maille est vierge. */
  function cityCenter(i, j) {
    if (roll(i, 0, j, SALT_CITY) >= VILLAGE.cityChance) return null;
    let fx = roll(i, 1, j, SALT_CITY_X);
    let fz = roll(i, 2, j, SALT_CITY_Z);
    // Un centre-bourg posé sur la mer perdrait tout son quartier : le gradient
    // d'influence ne bâtirait rien autour de lui. On déplace le tirage de quelques
    // dizaines de cubes tant que l'eau recouvre la place, et on renonce si la maille
    // entière est sous la mer.
    for (let essai = 0; essai < 4; essai++) {
      const x = (i + 0.15 + 0.7 * fx) * VILLAGE.cityCell;
      const z = (j + 0.15 + 0.7 * fz) * VILLAGE.cityCell;
      // Ni sur la mer, ni dans un très haut massif : une ville y lèverait des immeubles
      // que le joueur est censé ne jamais y voir (« sans immeuble »), et son gradient
      // d'influence y densifierait le bâti jusque sur les arêtes.
      if (!noye(Math.round(x), Math.round(z)) && alpage(Math.round(x), Math.round(z)) < VILLAGE.alpsNoTower) {
        return { x, z };
      }
      const jx = roll(i + 7 * (essai + 1), 3, j - 3 * essai, SALT_CITY_X);
      const jz = roll(i - 5 * essai, 4, j + 11 * (essai + 1), SALT_CITY_Z);
      fx = 0.15 + 0.7 * jx;
      fz = 0.15 + 0.7 * jz;
    }
    return null;
  }

  /**
   * 0 à la campagne, 1 au centre d'une ville. C'est ce gradient qui concentre le bâti
   * et fait la différence entre un hameau éparpillé et une agglomération : densité des
   * parcelles et hauteur des tours en dépendent, donc les tronçons voisins se
   * recouvrent d'immeubles autour du même point.
   */
  function cityInfluence(wx, wz) {
    const cs = VILLAGE.cityCell;
    const i = Math.floor(wx / cs);
    const j = Math.floor(wz / cs);
    let best = 0;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const c = cityCenter(i + di, j + dj);
        if (!c) continue;
        const inf = 1 - Math.hypot(wx - c.x, wz - c.z) / VILLAGE.cityRadius;
        if (inf > best) best = inf;
      }
    }
    return best > 0 ? Math.min(1, best) : 0;
  }

  /**
   * Découpage du tronçon en parcelles. Une ruelle de deux cubes sépare les voisines :
   * sans elle, deux façades collées se mureraient mutuellement leurs portes.
   */
  function plotsFor(baseX, baseZ, influence) {
    const r = roll(baseX, 40, baseZ, SALT_LAYOUT);
    const dense = influence >= 0.5;
    const town = influence >= 0.2;
    // Part des parcelles simples ou jumelles : les quarts de tronçon ne donnent que des
    // cabanes de six colonnes, et le village se lisait en rangées de boîtes. On pousse
    // l'emprise moyenne vers le haut sans supprimer les petites — c'est le contraste
    // des gabarits qui fait une ville.
    const anchorShare = dense ? 0.3 : town ? 0.16 : 0.05;
    // Le grand îlot — tout le tronçon bâti d'un seul corps — est la seule parcelle où
    // tient la volée en chicane d'un immeuble de dix ou quatorze étages : douze colonnes
    // de cœur courent, quatre s'empilent, la montée fait quarante-huit cubes. Sa part
    // suit donc la densité, sinon les catégories hautes de `towerFloors` ne se posent
    // jamais et la ville s'arrête à six étages. Elle reste mesurée : un tronçon sur deux
    // en grand îlot faisait passer la ville sous le seuil de concentration que vérifie
    // la suite (mesuré à 40 % de grands îlots : 0,96 bâtiment/tronçon contre 1,08 exigés).
    const singleShare = anchorShare + (dense ? 0.25 : town ? 0.16 : 0.06);
    // En cœur dense, la part qui reste va au quadruplé plutôt qu'à la jumelle : quatre
    // corps tiennent la concentration de bâti qu'exige la suite là où le grand îlot en
    // livre un seul. Sans ce report, la ville tombait à 1,07 bâtiment/tronçon pour 1,08
    // exigés (mesuré, graine du jeu, R = 22).
    const pairShare = singleShare + (dense ? 0.1 : 0.3);
    // Le tronçon est bâti au plus près de ses limites : le retrait d'une colonne sur les
    // bords suffit à ce que deux tronçons voisins ne se murient pas leurs portes — avec
    // celui du tronçon d'en face, la cour fait `courtWidth` cubes de part et d'autre de
    // la frontière.
    const lo = 1;
    const hi = CHUNK_SIZE - 2;
    // La ruelle occupe deux colonnes (7 et 8) entre les deux moitiés : c'est la cour qui
    // ceinture chaque corps, côté parcelle voisine comme côté tronçon voisin.
    const seamA = 7;                          // première colonne libre de la ruelle
    const seamB = 9;                          // sa seconde ; la moitié d'après repart ici
    // Partage du quadruplé : 7 puis cour de deux cubes puis 5 (voir le commentaire du cas).
    const qEnd = 7;                           // fin du premier bandeau
    const qStart = 10;                        // début du second, après la cour
    // Corps d'une « ancre » : six colonnes suffisent à loger la volée en chicane d'une
    // tour, et ce retrait laisse en face exactement la largeur de ruelle — les cottages
    // y gardent six colonnes, soit le gabarit minimal d'une maison avec sa cour.
    const aEnd = lo + 5;                      // fin de la grande emprise
    const bStart = seamB;                     // en face, après la cour

    let plots;
    if (r < anchorShare) {
      // Une « ancre » : une grande emprise qui peut porter une tour, et deux cottages
      // le long de la ruelle. Sans elle, il faudrait choisir entre ville haute et
      // ville dense — l'utilisateur veut les deux.
      plots = [
        { x0: lo, z0: lo, x1: aEnd, z1: hi },
        { x0: bStart, z0: lo, x1: hi, z1: seamA - 1 },
        { x0: bStart, z0: seamB, x1: hi, z1: hi },
      ];
    } else if (r < singleShare) {
      plots = [{ x0: lo, z0: lo, x1: hi, z1: hi }];
    } else if (r < pairShare) {
      plots = roll(baseX, 41, baseZ, SALT_LAYOUT) < 0.5
        ? [
          { x0: lo, z0: lo, x1: seamA - 1, z1: hi },
          { x0: seamB, z0: lo, x1: hi, z1: hi },
        ]
        : [
          { x0: lo, z0: lo, x1: hi, z1: seamA - 1 },
          { x0: lo, z0: seamB, x1: hi, z1: hi },
        ];
    } else {
      // Le quadruplé ne se partage pas en 6 et 6 des deux côtés : la cour de deux cubes
      // ne laisse que douze colonnes bâtissables par axe, et six partout fait des quarts
      // de 6×6 où aucune volée en chicane ne tient — plus une tour dans le quadruplé
      // (mesuré : 28 immeubles tombés à 18 sur la fenêtre de test). En coupant un axe en
      // 7 et 5 et l'autre en 6 et 6, deux quarts sur quatre font 7×6, soit la volée
      // requise, et les deux autres reçoivent les cottages : la tour se lit au milieu des
      // maisons basses, qui est l'aspect voulu d'un îlot dense.
      plots = [
        { x0: lo, z0: lo, x1: qEnd, z1: seamA - 1 },
        { x0: qStart, z0: lo, x1: hi, z1: seamA - 1 },
        { x0: lo, z0: seamB, x1: qEnd, z1: hi },
        { x0: qStart, z0: seamB, x1: hi, z1: hi },
      ];
    }

    // Miroir : sans ça, toutes les parcelles se répondent d'un tronçon à l'autre et
    // le damier devient lisible à vol d'oiseau.
    const flip = (v) => CHUNK_SIZE - 1 - v;
    if (roll(baseX, 42, baseZ, SALT_LAYOUT) < 0.5) {
      plots = plots.map((p) => ({ x0: flip(p.x1), z0: p.z0, x1: flip(p.x0), z1: p.z1 }));
    }
    if (roll(baseX, 43, baseZ, SALT_LAYOUT) < 0.5) {
      plots = plots.map((p) => ({ x0: p.x0, z0: flip(p.z1), x1: p.x1, z1: flip(p.z0) }));
    }
    return plots;
  }

  /** Nombre de marches que peut contenir l'empreinte : longueur de volée × volées empilées. */
  function stairCapacity(w, d) {
    const coreW = w - 2;
    const coreD = d - 2;
    if (coreW < 2 || coreD < 2) return 0;
    return Math.max(coreW, coreD) * Math.floor(Math.min(coreW, coreD) / 2);
  }

  /**
   * Le bâti reste à l'intérieur de son tronçon, à une colonne de la frontière : sans ce
   * retrait, deux façades de tronçons voisins se collent et l'une mure la porte de
   * l'autre — le seuil devient infranchissable, ce que vérifie la suite.
   */
  function fitsInsideLot(x0, z0, w, d) {
    return x0 >= 1 && z0 >= 1 && x0 + w <= CHUNK_SIZE - 1 && z0 + d <= CHUNK_SIZE - 1;
  }

  /**
   * Volée d'immeuble en chicanes : deux colonnes de large par marche, un cube de
   * dénivelé par pas, chaque volée longue comme le noyau et la suivante repart en
   * sens inverse sur les deux colonnes voisines.
   *
   * Deux colonnes, pas une : le collider du joueur fait 0,6 de large et chevauche la
   * colonne adjacente dès qu'il n'est pas parfaitement centré. Sur une volée d'une
   * seule colonne, le plancher ou le garde-d'appui de cette voisine suffit donc à
   * transformer la marche en mur — c'est exactement ce qui empêchait d'atteindre le
   * dernier étage. Renvoie null si la place manque pour atteindre le toit.
   */
  function stairPlan(x0, z0, w, d, steps, firstY, opts) {
    const coreMinX = x0 + 1, coreMaxX = x0 + w - 2;
    const coreMinZ = z0 + 1, coreMaxZ = z0 + d - 2;
    const coreW = coreMaxX - coreMinX + 1;
    const coreD = coreMaxZ - coreMinZ + 1;
    if (coreW < 2 || coreD < 2) return null;

    // On court le long de l'axe disponible le plus long et on empile les volées sur
    // l'autre : c'est ce qui donne le plus de marches avant de manquer de longueur.
    const runIsZ = coreD >= coreW;
    const runMin = runIsZ ? coreMinZ : coreMinX;
    const runMax = runIsZ ? coreMaxZ : coreMaxX;
    const crossMin = runIsZ ? coreMinX : coreMinZ;
    const crossMax = runIsZ ? coreMaxX : coreMaxZ;
    const runLen = runMax - runMin + 1;
    const flights = Math.ceil(steps / runLen);
    if (flights < 1 || flights * 2 > crossMax - crossMin + 1) return null;

    const at = (run, cross) => (runIsZ ? { lx: cross, lz: run } : { lx: run, lz: cross });
    const laneOf = (f) => (opts.fromFarCross ? crossMax - 2 * f : crossMin + 2 * f);
    const goesForward = (f) => (f % 2 === 0) !== opts.reverseRun;

    const treads = [];
    for (let f = 0; f < flights; f++) {
      const a = laneOf(f);
      const b = a + (opts.fromFarCross ? -1 : 1);
      if (a < crossMin || a > crossMax || b < crossMin || b > crossMax) return null;
      const forward = goesForward(f);
      const count = Math.min(runLen, steps - treads.length);
      for (let s = 0; s < count; s++) {
        const run = forward ? runMin + s : runMax - s;
        treads.push({ y: firstY + treads.length, cells: [at(run, a), at(run, b)] });
      }
    }
    if (treads.length !== steps) return null;

    // Les deux colonnes devant la dernière marche : on y laisse le toit plein et on ne
    // perce que la rambarde, pour que le joueur ait où poser le pied en sortant.
    const lastFlight = flights - 1;
    const a = laneOf(lastFlight);
    const b = a + (opts.fromFarCross ? -1 : 1);
    const last = treads[treads.length - 1].cells[0];
    const lastRun = runIsZ ? last.lz : last.lx;
    const exitRun = goesForward(lastFlight) ? lastRun + 1 : lastRun - 1;
    if (exitRun < 0 || exitRun > CHUNK_SIZE - 1) return null;

    return {
      treads,
      cells: treads.flatMap((t) => t.cells.map((c) => ({ lx: c.lx, lz: c.lz, y: t.y }))),
      exit: [at(exitRun, a), at(exitRun, b)],
    };
  }

  /** Une volée qui démarre dans le sas de la porte murerait l'entrée : on la refuse. */
  function blocksDoorway(stair, door) {
    return stair.cells.some((c) => c.lx === door.in.lx && c.lz === door.in.lz);
  }

  /**
   * Ni sur la chaussée, ni sur le caniveau, ni dans leur cour : le bâtiment donne sur la
   * rue depuis sa cour de `courtWidth` cubes, il ne l'occupe pas et ne s'y accole pas.
   */
  function lotIsClearOfRoad(baseX, baseZ, x0, z0, w, d) {
    const pad = VILLAGE.courtWidth;
    for (let lx = x0 - pad; lx < x0 + w + pad; lx++) {
      for (let lz = z0 - pad; lz < z0 + d + pad; lz++) {
        if (roadKind(baseX + lx, baseZ + lz)) return false;
      }
    }
    return true;
  }

  /**
   * Le terrain supporte-t-il cette emprise ? Renvoie `{ minH, maxH }`, ou null si on la
   * refuse. Ni mer ni cours d'eau dessous — la bande d'altitude écartait la mer (le sable
   * tient trois cubes au-dessus de la ligne) mais une rivière court bien au-dessus de
   * `minGround`, et une maison posée sur son lit ferait barrage. Et un plateau presque
   * plat, sinon la maison flotterait d'un côté ou serait enterrée de l'autre.
   */
  function reliefPorteur(baseX, baseZ, x0, z0, w, d, maxRelief, bande) {
    let minH = Infinity;
    let maxH = -Infinity;
    for (let lx = x0; lx < x0 + w; lx++) {
      for (let lz = z0; lz < z0 + d; lz++) {
        if (noye(baseX + lx, baseZ + lz)) return null;
        const h = ground(baseX + lx, baseZ + lz);
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    if (!(maxH - minH <= maxRelief)) return null;
    // La bande d'altitude est celle du village, sauf au hameau de montagne : lui seul
    // monte au-dessus de la ligne de neige (`hamletMaxGround`), et il ne descend pas au
    // pied du massif — une cabane à vingt cubes sous l'arête ne regarderait pas la
    // montagne, elle la boucherait.
    const lo = bande ? bande.lo : VILLAGE.minGround;
    const hi = bande ? bande.hi : VILLAGE.maxGround;
    if (!(minH >= lo && maxH <= hi)) return null;
    return { minH, maxH };
  }

  /**
   * Plans des bâtiments de ce tronçon — tableau, éventuellement vide. Mis en cache :
   * la génération du relief a besoin de savoir où se trouvent les emprises avant de
   * poser les arbres, et l'estampage les redemande juste après.
   */
  function buildingAt(cx, cz) {
    const key = `${cx},${cz}`;
    if (cache.has(key)) return cache.get(key);
    const plans = computePlans(cx, cz);
    if (cache.size > 4096) cache.clear(); // borne mémoire côté navigation prolongée
    cache.set(key, plans);
    return plans;
  }

  function computePlans(cx, cz) {
    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;
    const centreX = baseX + (CHUNK_SIZE >> 1);
    const centreZ = baseZ + (CHUNK_SIZE >> 1);
    const mont = alpage(centreX, centreZ);
    // Le très haut massif reste sauvage. « Avec quelques maisons » : le tirage garde une
    // faible part des tronçons, qui deviennent un hameau — deux ou trois corps sur un
    // replat — et rien d'autre n'y pousse. Laisser courir la densité ordinaire sur des
    // flancs à quarante cubes de dénivelé ferait un village accroché à une paroi.
    const montagne = mont >= VILLAGE.alpsWild;
    if (montagne && roll(cx, 3, cz, SALT_HAMEAU) >= VILLAGE.hamletChance) return [];
    const influence = cityInfluence(centreX, centreZ);
    // Courbe creusée : l'approche d'une ville doit se voir de loin, d'où le puissance
    // 0,6 qui fait monter la densité dès les faubourgs plutôt qu'au centre seul.
    const density = montagne ? VILLAGE.hamletDensity
      : VILLAGE.lotDensity + Math.pow(influence, 0.6) * (VILLAGE.cityDensity - VILLAGE.lotDensity);
    // Seul le hameau a le droit de s'asseoir au-dessus de la ligne de neige du village.
    const bande = montagne
      ? { lo: VILLAGE.hamletMinGround, hi: VILLAGE.hamletMaxGround } : null;
    // Pas d'immeuble dès que le pays est une montagne — même sous la borne de la ville,
    // sinon un hameau tiré entre les deux seuils pourrait élever une tour sur un flanc.
    const sansTour = montagne;
    const plans = [];
    plotsFor(baseX, baseZ, influence).forEach((plot, i) => {
      if (roll(baseX + i * 7, 7, baseZ + i * 13, SALT_LOT) >= density) return;
      const plan = computePlan(baseX, baseZ, plot, i, influence, { bande, sansTour });
      if (plan) plans.push(plan);
    });
    return plans;
  }

  /**
   * Plan d'un bâtiment sur une parcelle. Le grand gabarit ne passe pas toujours : un
   * terrain trop accidenté ou une chaussée qui mord sur le lot ferait tomber toute la
   * parcelle, et une ville trouée n'est plus une ville. On retente donc en rétrécissant
   * l'empreinte — un terrain plat à 6×6 reste plat à 4×4.
   */
  function computePlan(baseX, baseZ, plot, i, influence, opts = {}) {
    // Quatre essais, chacun rétrécissant l'empreinte de deux colonnes : avec des maisons
    // de sept cubes, un plateau refusé à cette taille s'accommode souvent d'une emprise
    // de cinq, et une parcelle vide au cœur de la ville se voit.
    for (let attempt = 0; attempt < 4; attempt++) {
      const plan = tryPlan(baseX, baseZ, plot, i, influence, attempt, opts);
      if (plan) return plan;
    }
    return null;
  }

  function tryPlan(baseX, baseZ, plot, i, influence, attempt, opts = {}) {
    const availW = plot.x1 - plot.x0 + 1 - 2 * attempt;
    const availD = plot.z1 - plot.z0 + 1 - 2 * attempt;
    if (availW < 4 || availD < 3) return null;

    // Une tour doit loger sa volée en chicane ; faute de place, on bâtit une maison.
    // Le tirage dépend de la tentative : une parcelle qui refuse la tour peut encore
    // porter une maison, plutôt que de rester vide trois tentatives de suite.
    const towerChance = VILLAGE.towerChance
      + Math.pow(influence, 0.6) * (VILLAGE.cityTowerChance - VILLAGE.towerChance);
    const tower = !opts.sansTour
      && Math.min(availW, availD) >= 6
      && stairCapacity(availW, availD) >= TOUR_MIN_H
      && roll(baseX + i * 5 + attempt * 977, 11, baseZ + i * 3 + attempt * 613, SALT_KIND) < towerChance;

    const minSide = tower ? 6 : 5;
    if (availW < minSide || availD < minSide) return null;
    const maxRelief = tower ? VILLAGE.maxReliefTower : VILLAGE.maxReliefHouse;

    // Gabarit de l'emprise, puis position dans la parcelle. Le tirage cale le bâti sur
    // sa parcelle, à un cube près — c'est ce qui donne un tissu serré plutôt que des
    // pavillons perdus au milieu de leur lot — mais une emprise collée aux bornes du lot
    // n'a plus une colonne de marge pour fuir l'emprise de la rue : depuis que la cour de
    // `courtWidth` cubes s'ajoute à l'empreinte, une grande parcelle recoupée par une
    // avenue se refusait tout entière (mesuré sur la fenêtre de test : les tronçons de
    // centre-bourg portant un seul corps sont tombés de 52 à 38). On reprend donc les
    // gabarits du tirage d'abord, puis du plus grand au plus serré, tant qu'aucun ne
    // trouve de place. Et une empreinte trop étroite pour sa volée est écartée d'office,
    // sinon l'immeuble retombait en maison par accident du tirage.
    const tireW = between(Math.max(minSide, availW - 1), availW, baseX + i, 1, baseZ, SALT_SIZE);
    const tireD = between(Math.max(minSide, availD - 1), availD, baseX + i, 2, baseZ, SALT_SIZE);
    const serre = (n) => Math.max(minSide, n - 1);
    const gabarits = [];
    const propose = (cw, cd) => {
      if (cw < minSide || cd < minSide) return;
      if (tower && stairCapacity(cw, cd) < TOUR_MIN_H) return;
      if (!gabarits.some(([a, b]) => a === cw && b === cd)) gabarits.push([cw, cd]);
    };
    propose(tireW, tireD);
    propose(availW, availD);
    propose(availW, serre(availD));
    propose(serre(availW), availD);
    propose(serre(availW), serre(availD));
    if (!gabarits.length) propose(availW, availD); // faute de volée possible, `monte` fera une maison
    // Un immeuble joue sa catégorie sur la surface de sa volée : proposer d'abord la
    // plus grande emprise, c'est laisser une chance aux dix et quatorze étages là où le
    // tirage de taille avait visé juste à côté. Les maisons gardent l'ordre du tirage,
    // qui cale le bâti serré sur sa parcelle.
    if (tower) gabarits.sort((a, b) => b[0] * b[1] - a[0] * a[1]);

    // La baie se choisit avant même l'emprise : le seuil doit se caler sur la chaussée du
    // côté porte, donc le niveau dépend de la façade retenue. Le tirer ici plutôt qu'après
    // coup permet de juger la bande au **niveau final** — juger le palier seul laissait
    // passer des sites où le calage rue relevait le seuil de plusieurs cubes hors de
    // portée de la bande.
    const doorSide = Math.floor(roll(baseX, 6, baseZ, SALT_DOOR) * 4) % 4;
    function seuilDe(px, pz, cw, cd) {
      const v = palier(baseX + px + ((cw - 1) >> 1), baseZ + pz + ((cd - 1) >> 1));
      const bord = [];
      for (let k = 0; k < (doorSide % 2 === 0 ? cw : cd); k++) {
        for (let outset = 0; outset <= 2; outset++) {
          const lx = doorSide === 2 ? px - outset : doorSide === 0 ? px + cw - 1 + outset : px + k;
          const lz = doorSide === 3 ? pz - outset : doorSide === 1 ? pz + cd - 1 + outset : pz + k;
          bord.push(surfaceAt(baseX + lx, baseZ + lz));
        }
      }
      // Sur une avenue en escalier, la chaussée n'est plus à l'altitude du terrain : c'est
      // bien elle qu'il faut rejoindre, sinon la porte donne deux cubes au-dessus du pavé.
      return bord.length
        ? Math.max(v, Math.round(bord.reduce((a, b) => a + b, 0) / bord.length))
        : v;
    }

    // Les deux colonnes où le passant pose le pied en sortant, pour un gabarit posé en
    // (px, pz). Même calcul que la baie plus bas — ici on ignore si la sortie donne sur
    // une surface que la bande ne rattrape pas.
    function approcheDe(px, pz, cw, cd) {
      const dirX = doorSide === 1 ? -1 : doorSide === 3 ? 1 : 0;
      const dirZ = doorSide === 0 ? -1 : doorSide === 2 ? 1 : 0;
      const baie = doorSide === 0 ? { lx: px + ((cw - 1) >> 1), lz: pz }
        : doorSide === 2 ? { lx: px + ((cw - 1) >> 1), lz: pz + cd - 1 }
        : doorSide === 1 ? { lx: px, lz: pz + ((cd - 1) >> 1) }
        : { lx: px + cw - 1, lz: pz + ((cd - 1) >> 1) };
      return [
        { lx: baie.lx + dirX, lz: baie.lz + dirZ },
        { lx: baie.lx + 2 * dirX, lz: baie.lz + 2 * dirZ },
      ];
    }

    let x0 = 0;
    let z0 = 0;
    let w = 0;
    let d = 0;
    let plateau = 0;
    let courNiveau = 0;
    let pose = false;
    for (const [cw, cd] of gabarits) {
      // Position de l'emprise dans sa parcelle. On part du tirage — c'est lui qui casse
      // l'alignement des façades d'un tronçon à l'autre — puis on balaie le reste de la
      // parcelle en tournant. L'ordre est fixe et ne dépend d'aucun état, donc le plan
      // rendu est le même quel que soit l'ordre des requêtes.
      const nX = availW - cw + 1;
      const nZ = availD - cd + 1;
      const tX = Math.floor(roll(baseX + i * 17, 3, baseZ + i * 29, SALT_PLACE) * nX);
      const tZ = Math.floor(roll(baseX + i * 17, 4, baseZ + i * 29, SALT_PLACE) * nZ);
      for (let a = 0; a < nX && !pose; a++) {
        for (let b = 0; b < nZ && !pose; b++) {
          const px = plot.x0 + attempt + (tX + a) % nX;
          const pz = plot.z0 + attempt + (tZ + b) % nZ;
          if (!fitsInsideLot(px, pz, cw, cd)) continue;
          if (!lotIsClearOfRoad(baseX, baseZ, px, pz, cw, cd)) continue;
          // Un temple tient son parvis **et sa cour** : c'est le bâtiment qui se déplace,
          // pas le monument. Le contrôle ne se fait que dans ce sens — un plan de bâtiment
          // qui dépendrait du temple, lequel dépendrait des bâtiments, ne convergerait
          // jamais. On ne gêne que la pierre posée, pas le tampon de végétation qui
          // l'entoure.
          if (templeGenantSur(baseX + px - VILLAGE.courtWidth, baseZ + pz - VILLAGE.courtWidth,
            baseX + px + cw - 1 + VILLAGE.courtWidth, baseZ + pz + cd - 1 + VILLAGE.courtWidth)) continue;
          // Même règle pour les colosses : c'est la maison qui se déplace, pas la statue.
          // Le contrôle ne se fait que dans ce sens — le plan d'une maison dépendant de la
          // statue, qui dépendrait des maisons, ne convergerait pas.
          if (statueGenantSur(baseX + px - VILLAGE.courtWidth, baseZ + pz - VILLAGE.courtWidth,
            baseX + px + cw - 1 + VILLAGE.courtWidth, baseZ + pz + cd - 1 + VILLAGE.courtWidth)) continue;
          const relief = reliefPorteur(baseX, baseZ, px, pz, cw, cd, maxRelief, opts.bande);
          if (!relief) continue;
          // Le niveau retenu n'est pas le coin bas de l'emprise mais le plateau du quartier
          // (moyenne locale, fonction pure de la position), calé côté porte sur la chaussée :
          // deux façades voisines partagent ainsi le même palier, seule façon que la cour de
          // deux cubes qui les sépare soit de niveau. Le gabarit reste refusé si ce palier
          // enterre ou fait flotter le corps.
          const niveau = seuilDe(px, pz, cw, cd);
          if (Math.abs(niveau - relief.minH) > maxRelief || Math.abs(niveau - relief.maxH) > maxRelief) continue;
          // Et la bande avant tout : « pas d'escalier autour d'un bâtiment ». Un site où le
          // relief des deux colonnes libres s'écarte trop du plateau ne se rattrape pas après
          // coup — on cherche une autre place, un autre gabarit, plutôt que de poser là une
          // promenade en gradins.
          const cour = niveauDeCour(baseX + px, baseZ + pz, cw, cd);
          // La cour se pose au niveau que le relief environnant réclame ; le seuil n'en doit
          // rester qu'à un cube, sinon c'est la porte qui ouvrirait sur un ressaut.
          if (cour === null || Math.abs(cour - niveau) > 1) continue;
          // Et la sortie ne doit pas donner dans une mare : la bande se nivelle, l'eau non,
          // elle garde son régime (mesuré : une maison dont les deux colonnes d'approche
          // étaient noyées sur cinq cubes de chute).
          const entree = approcheDe(px, pz, cw, cd);
          if (noye(baseX + entree[0].lx, baseZ + entree[0].lz)
            || noye(baseX + entree[1].lx, baseZ + entree[1].lz)) continue;
          x0 = px;
          z0 = pz;
          w = cw;
          d = cd;
          // Le bâtiment suit sa cour : poser le plancher à `niveau` alors que la bande est à
          // `cour`, c'est enterrer la porte d'un cube (mesuré : baie bouchée, le passant butait
          // sur la traverse du linteau). L'écart accepté ci-dessus reste d'un cube, donc le
          // soubassement n'a qu'un cube à reprendre.
          plateau = cour;
          courNiveau = cour;
          pose = true;
        }
      }
      if (pose) break;
    }
    if (!pose) return null;

    // Le seuil est celui jugé à la sélection : palier du quartier, calé côté porte sur la
    // chaussée (`seuilDe`). Il ne se recale plus après coup — un seuil qui bouge après que
    // la bande a été jugée remettrait des gradins sous les pieds du passant.
    const siteH = plateau;

    // Hauteur : une maison tire dans sa fourchette basse ; un immeuble **choisit une
    // catégorie** — 3, 6, 10 ou 14 étages — tirée dans `towerWeights`, donc de plus en
    // plus rare à mesure qu'elle monte. Deux bornes la ramènent sur terre : l'influence
    // urbaine (les catégories hautes sont l'apanage du centre-bourg) et ce que le site
    // peut réellement héberger — la volée en chicane d'un escalier, et le sommet du monde.
    // Redescendre d'une catégorie plutôt que renoncer : une parcelle trop étroite pour
    // quatorze étages porte six étages, et le cœur d'îlot garde son échelle.
    const monte = (estTour) => {
      const ceiling = CHUNK_HEIGHT - 3 - siteH;
      const urban = Math.max(0, (influence - 0.2) / 0.8);
      let height;
      if (estTour) {
        const gravissable = Math.min(VILLAGE.maxHeight, stairCapacity(w, d), ceiling);
        // Ce n'est pas le tirage qui choisit les catégories possibles, c'est le site.
        // Tirer à l'aveugle dans les quatre puis raboter une à une écrasait tout sous la
        // plus basse : une parcelle de six sur quatorze ne « visait » pas quatorze étages,
        // elle n'en avait simplement pas les moyens, et le grand îlot du centre-bourg
        // restait dessiné par le seul hasard (mesuré sur R = 26 : 4 immeubles visés à dix
        // ou quatorze étages, 0 posé). On tire donc dans la table des catégories que le
        // lieu peut gravir et que l'influence autorise : la fréquence continue de
        // décroître avec la hauteur, mais les catégories hautes ont une adresse.
        const eligibles = [];
        let finalistes = [];
        let total = 0;
        for (let k = 0; k < VILLAGE.towerFloors.length; k++) {
          if (urban >= VILLAGE.towerUrbanGate[k]
            && hauteurPourEtages(VILLAGE.towerFloors[k]) <= gravissable) {
            eligibles.push(k);
            total += VILLAGE.towerWeights[k];
          }
        }
        if (!eligibles.length) return null;   // même trois étages n'y tiennent pas : maison
        // Un immeuble monte autant que son site le permet, à un cran près : le dé ne
        // départage que les deux catégories les plus hautes que la parcelle autorise.
        // Tirer sur toute la table écrasait le résultat sous le bas de l'échelle — les
        // sites capables de porter la ville haute sont rares (quinze sur tout un
        // quartier), et à 25 % de chances ils ne la portaient jamais (mesuré sur R = 26 :
        // zéro immeuble au-dessus de six étages). Prendre trois crans, c'est pareil : la
        // catégorie du sommet n'était plus jamais tirée (R = 40 : 71/14/4/0). La fréquence
        // continue de décroître avec la hauteur — peu de sites ouvrent la catégorie, et le
        // poids y est le plus faible.
        finalistes = eligibles.slice(-2);
        total = finalistes.reduce((a, k) => a + VILLAGE.towerWeights[k], 0);
        let r = roll(baseX + i, 5, baseZ, SALT_HEIGHT) * total;
        let categorie = finalistes[finalistes.length - 1];
        for (const k of finalistes) {
          r -= VILLAGE.towerWeights[k];
          if (r < 0) { categorie = k; break; }
        }
        height = hauteurPourEtages(VILLAGE.towerFloors[categorie]);
        // Un ou deux cubes de jeu selon la parcelle — la fourchette où `storeysOf` compte
        // le même nombre de planchers. Sans ça, toutes les tours d'une catégorie sortent
        // rigoureusement jumelles et la skyline fait un peigne.
        if (height + 2 <= gravissable) height += roll(baseX + i, 6, baseZ, SALT_HEIGHT) < 0.5 ? 1 : 2;
      } else {
        height = between(VILLAGE.houseMinH, VILLAGE.houseMaxH, baseX + i, 5, baseZ, SALT_HEIGHT);
      }
      height = Math.min(height, ceiling);
      if (height < VILLAGE.houseMinH) return null;

      const wallBlock = estTour
        ? pick([BLOCK.BRICK, BLOCK.COBBLE, BLOCK.STONE], baseX, 8, baseZ, SALT_MATERIAL)
        : pick([BLOCK.BRICK, BLOCK.PLANKS, BLOCK.COBBLE], baseX, 8, baseZ, SALT_MATERIAL);

      // La baie est au centre de la façade choisie. `front` et `out` sont les deux
      // colonnes qui donnent sur la cour : c'est là qu'il faudra dégager le passage.
      const dirX = doorSide === 1 ? -1 : doorSide === 3 ? 1 : 0;
      const dirZ = doorSide === 0 ? -1 : doorSide === 2 ? 1 : 0;
      const mid = (n) => (n - 1) >> 1;
      const baie = doorSide === 0 ? { lx: x0 + mid(w), lz: z0 }
        : doorSide === 2 ? { lx: x0 + mid(w), lz: z0 + d - 1 }
        : doorSide === 1 ? { lx: x0, lz: z0 + mid(d) }
        : { lx: x0 + w - 1, lz: z0 + mid(d) };
      const door = {
        lx: baie.lx, lz: baie.lz, side: doorSide,
        front: { lx: baie.lx + dirX, lz: baie.lz + dirZ },
        out: { lx: baie.lx + 2 * dirX, lz: baie.lz + 2 * dirZ },
        // La colonne intérieure juste derrière la baie : là où on se tient en entrant.
        in: { lx: baie.lx - dirX, lz: baie.lz - dirZ },
      };

      // Un immeuble sans escalier serait une coquille vide : on renonce à la tour plutôt
      // que de poser un bâtiment dont on ne peut pas sortir sur le toit. La volée
      // démarre à l'opposé de la porte pour ne pas boucher l'entrée dès le seuil franchi.
      const opts = {
        reverseRun: doorSide === 0 ? true : doorSide === 2 ? false : roll(baseX + i, 13, baseZ + i, SALT_STAIR) < 0.5,
        fromFarCross: doorSide === 1 ? true : doorSide === 3 ? false : roll(baseX + i, 14, baseZ + i, SALT_STAIR) < 0.5,
      };
      let stair = estTour ? stairPlan(x0, z0, w, d, height, siteH + 1, opts) : null;
      if (estTour && stair && blocksDoorway(stair, door)) {
        stair = stairPlan(x0, z0, w, d, height, siteH + 1, {
          reverseRun: !opts.reverseRun, fromFarCross: !opts.fromFarCross,
        });
      }
      if (estTour && (!stair || blocksDoorway(stair, door))) return null;

      return {
        kind: estTour ? 'tower' : 'house',
        lot: i,
        city: Math.round(influence * 1000) / 1000,
        x0, z0, w, d,
        siteH,
        courNiveau,
        height,
        wall: wallBlock,
        floor: estTour ? BLOCK.STONE : BLOCK.PLANKS,
        // Pas d'obsidienne : sa teinte est si proche du noir qu'une toiture entière
        // devient un trou dans l'image — elle écrase l'histogramme et ne rend plus
        // ni la forme du toit ni la lumière du jour.
        roof: pick([BLOCK.COBBLE, BLOCK.BRICK, BLOCK.GRIT], baseX, 9, baseZ, SALT_MATERIAL),
        window: BLOCK.GLASS,
        doorSide,
        door,
        stair,
        stairBlock: BLOCK.PLANKS,
        chimney: roll(baseX, 10, baseZ, SALT_DETAIL) > 0.55,
        gable: !estTour && roll(baseX, 12, baseZ, SALT_DETAIL) > 0.35,
      };
    };
    // Une parcelle dont la tour refuse la volée porte au moins une maison : la laisser
    // vide parce que l'immeuble n'y tenait pas faisait un trou au cœur de l'îlot, et le
    // rétrécissement des tentatives suivantes descend souvent sous le gabarit minimal.
    return monte(tower) || (tower ? monte(false) : null);
  }

  /** Écrit tous les bâtiments du tronçon. Renvoie false si le tronçon est vierge. */
  function stampBuilding(data, cx, cz) {
    const plans = buildingAt(cx, cz);
    for (const plan of plans) stampOne(data, cx, cz, plan);
    // La cour se travaille après le bâti, et pour les parcelles voisines aussi : elle
    // déborde souvent la frontière de tronçon, sans quoi le trait s'y interromprait.
    nivellerCours(data, cx, cz);
    lignesDeCour(data, cx, cz);
    return plans.length > 0;
  }

  // Les sols nus du village : herbe des plaines, mousse des sous-bois, sable de grève,
  // gravier, neige des hameaux hauts. Une cour nivelée garde le matériau qu'elle avait ;
  // le trait de limite ne prend que sur l'un d'eux.
  const SOL_NU = [BLOCK.GRASS, BLOCK.DIRT, BLOCK.SAND, BLOCK.GRIT, BLOCK.MOSS, BLOCK.SNOW];
  // Ce que quelqu'un a déjà posé pour y marcher : un seuil pavé, un caniveau, une rampe.
  const PAVE = [BLOCK.COBBLE, BLOCK.GRIT];
  // Les quatre voisines d'une colonne de cour : c'est contre elles que se juge le ressaut.
  const VOISINS_BANDE = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  /** Le premier bloc plein en descendant depuis `depuis` — le sol sur lequel on marche. */
  function sommetColonne(blockAt, lx, lz, depuis) {
    for (let y = Math.min(CHUNK_HEIGHT - 2, depuis); y >= 0; y--) {
      const b = blockAt(lx, lz, y);
      if (b !== BLOCK.AIR && b !== BLOCK.WATER) return y;
    }
    return null;
  }

  /**
   * Niveau que pose ce bâtiment, ajusté avec ceux dont la bande touche la sienne. Deux cours qui
   * se rejoignent sur une même colonne ne peuvent pas y descendre chacune de leur côté : la
   * colonne garderait le niveau de celui qui écrit en premier et ferait ressaut chez l'autre.
   *
   * La recherche du groupe est **ancrée sur le bâtiment**, jamais sur le tronçon qui écrit : deux
   * tronçons qui regardent la même cour explorent le même voisinage et trouvent donc le même
   * niveau — c'est ce que violait la soudure calculée depuis la fenêtre du tronçon (mesuré : deux
   * maisons voisines posaient 23 et 21 sur des colonnes contiguës). Deux bâtiments ne se soudent
   * que si leurs bandes se touchent à un cube près et si leurs niveaux ne sont pas incompatibles
   * (`GROUPE_SEUIL`) : au-delà, mieux vaut deux terrasses séparées par une marche qu'un remblai
   * long comme un pâté de maisons.
   */
  const GROUPE_RAYON = 2;
  const GROUPE_SEUIL = 3;
  const GROUPE_MAX = 400;
  const groupeCache = new Map();
  function rectangleDe(bx, bz, p) {
    return {
      rx0: bx + p.x0, rz0: bz + p.z0,
      rx1: bx + p.x0 + p.w - 1, rz1: bz + p.z0 + p.d - 1,
      v: p.courNiveau ?? p.siteH,
    };
  }
  function niveauGroupe(bat) {
    const cle = `${bat.rx0},${bat.rz0},${bat.rx1},${bat.rz1}`;
    const hit = groupeCache.get(cle);
    if (hit !== undefined) return hit;
    const ex = VILLAGE.courtWidth * 2 + 1;
    const vus = new Set([cle]);
    const membres = [bat.v];
    const file = [bat];
    while (file.length && membres.length < GROUPE_MAX) {
      const a = file.pop();
      const cx = Math.floor(a.rx0 / CHUNK_SIZE);
      const cz = Math.floor(a.rz0 / CHUNK_SIZE);
      for (let dx = -GROUPE_RAYON; dx <= GROUPE_RAYON; dx++) {
        for (let dz = -GROUPE_RAYON; dz <= GROUPE_RAYON; dz++) {
          const bx = (cx + dx) * CHUNK_SIZE;
          const bz = (cz + dz) * CHUNK_SIZE;
          for (const p of buildingAt(cx + dx, cz + dz)) {
            const b = rectangleDe(bx, bz, p);
            const bc = `${b.rx0},${b.rz0},${b.rx1},${b.rz1}`;
            if (vus.has(bc)) continue;
            // Deux emprises sont solidaires quand leurs bandes viennent à se toucher. Si de plus
            // elles **se recouvrent**, elles écriront la même colonne : le niveau commun n'est
            // alors plus une préférence mais la seule issue sans ressaut — on soude quoi qu'il en
            // coûte. Des bandes simplement voisines ne se soudent que si leurs niveaux restent
            // compatibles : entre deux terrasses trop éloignées, une marche vaut mieux qu'un
            // remblai long comme un pâté de maisons.
            const sepX = Math.max(0, a.rx0 - b.rx1, b.rx0 - a.rx1);
            const sepZ = Math.max(0, a.rz0 - b.rz1, b.rz0 - a.rz1);
            if (sepX - ex > 0 || sepZ - ex > 0) continue;
            // Des bandes qui **se recouvrent** écriront la même colonne : elles doivent se
            // souder quoi qu'il en coûte, sinon la colonne partagée garde le niveau du premier
            // venu et fait ressaut chez l'autre. Des bandes simplement voisines ne se soudent
            // que si leurs niveaux restent compatibles.
            const recouvrement = sepX <= VILLAGE.courtWidth * 2 && sepZ <= VILLAGE.courtWidth * 2;
            if (!recouvrement && Math.abs(b.v - a.v) > GROUPE_SEUIL) continue;
            vus.add(bc);
            membres.push(b.v);
            file.push(b);
          }
        }
      }
    }
    // La médiane des niveaux proposés : mesuré sur 154 bâtiments, prendre le plus bas laissait
    // des cours huit cubes sous le seuil de leurs voisines (et un mur devant la porte) ; la
    // médiane ramène l'écart le plus pire à cinq cubes pour le même nombre de ressauts.
    membres.sort((x, y) => x - y);
    const v = membres[membres.length >> 1];
    if (groupeCache.size > 8192) groupeCache.clear();
    groupeCache.set(cle, v);
    return v;
  }

  /**
   * Met la bande de deux cubes au niveau du seuil du bâtiment. Demandé le 2026-11-09 :
   * « la bande autour de bâtiment doit être du même niveau, pas d'escalier autour d'un
   * bâtiment sur une longueur de 2 cubes ». Le niveau est celui que `tryPlan` a retenu avant
   * de bâtir (`plan.courNiveau`, médiane du relief de la bande) et que `niveauGroupe` a mis
   * d'accord avec les bâtiments dont la bande touche celle-ci : la planéité devient une
   * propriété de la conception, plus une correction appliquée après coup à un relief que
   * personne n'avait consulté. Sont laissées telles quelles, et pour cause, la
   * voirie (qui pose son propre profil) et les colonnes où l'eau tient au-dessus du sol —
   * boucher un cours d'eau serait un pire défaut qu'un ressaut. La pierre du monument n'est
   * pas épargnée : le temple est estampé après le bâti et `dalle` reconstruit ses colonnes
   * depuis le terrain naturel.
   */
  function nivellerCours(data, cx, cz) {
    const pad = VILLAGE.courtWidth;
    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;
    const idx = (lx, lz, y) => lx + lz * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE;
    const blockAt = (lx, lz, y) => (y < 0 || y >= CHUNK_HEIGHT ? BLOCK.AIR : data[idx(lx, lz, y)]);
    const setAt = (lx, lz, y, id) => {
      if (y >= 0 && y < CHUNK_HEIGHT) data[idx(lx, lz, y)] = id;
    };
    const blockAtMonde = (wx, wz, y) => {
      const lx = wx - baseX;
      const lz = wz - baseZ;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) return BLOCK.AIR;
      return blockAt(lx, lz, y);
    };
    const sommetDe = (wx, wz, depuis = CHUNK_HEIGHT - 2) =>
      sommetColonne((_, __, y) => blockAtMonde(wx, wz, y), 0, 0, depuis);
    // Une bande ne déborde que du tronçon voisin : `courtWidth` colonnes depuis une emprise
    // qui touche la frontière — pas besoin de voir plus loin maintenant que le niveau ne
    // dépend plus du lot de colonnes examinées.
    const MARGE = 1;
    const corps = [];
    const emprises = new Set();
    // Les deux colonnes devant chaque porte tiennent le niveau du seuil, pas celui du groupe :
    // une cour soudée avec ses voisines peut descendre de plusieurs cubes, et le passant sortirait
    // de sa porte dans le vide. C'est la marche d'appui devant toute maison de relief — une
    // surface déclarée, au même titre que la chaussée ou la berge.
    const paliers = new Map();
    for (let dx = -MARGE; dx <= MARGE; dx++) {
      for (let dz = -MARGE; dz <= MARGE; dz++) {
        const bx = (cx + dx) * CHUNK_SIZE;
        const bz = (cz + dz) * CHUNK_SIZE;
        for (const p of buildingAt(cx + dx, cz + dz)) {
          const bat = rectangleDe(bx, bz, p);
          corps.push({ ...bat, v: niveauGroupe(bat) });
          if (p.door) {
            for (const c of [p.door.front, p.door.out]) {
              if (!c) continue;
              const cle = `${bx + c.lx},${bz + c.lz}`;
              // Deux portes peuvent partager la même marche : on garde le niveau le plus haut,
              // celui qui porte le passant le plus exigeant. Le plus bas n'a qu'une marche à
              // descendre, l'inverse laisserait sa baie ouverte sur le vide.
              const deja = paliers.get(cle);
              if (deja === undefined || p.siteH > deja) paliers.set(cle, p.siteH);
            }
          }
          for (let wx = bx + p.x0; wx <= bx + p.x0 + p.w - 1; wx++) {
            for (let wz = bz + p.z0; wz <= bz + p.z0 + p.d - 1; wz++) emprises.add(`${wx},${wz}`);
          }
        }
      }
    }
    const cible = [];
    const faites = new Set();
    // Les marches d'appui passent avant tout : une porte ne se juge pas au niveau que le
    // voisin d'à côté a choisi pour sa cour. Sans cette priorité, la colonne devant la baie
    // était revendiquée d'abord par la bande voisine et le passant sortait dans le vide
    // (mesuré sur le monde du test : AIR à 26 sous un seuil à 26).
    for (const [cle, v] of paliers) {
      if (faites.has(cle)) continue;
      const virgule = cle.indexOf(',');
      const wx = +cle.slice(0, virgule);
      const wz = +cle.slice(virgule + 1);
      if (emprises.has(cle)) continue;
      if (surfaceImposee(wx, wz) !== null) continue;
      faites.add(cle);
      cible.push({ wx, wz, v });
    }
    for (const c of corps) {
      const v = c.v;
      for (let wx = c.rx0 - pad; wx <= c.rx1 + pad; wx++) {
        for (let wz = c.rz0 - pad; wz <= c.rz1 + pad; wz++) {
          if (wx >= c.rx0 && wx <= c.rx1 && wz >= c.rz0 && wz <= c.rz1) continue;
          const cle = `${wx},${wz}`;
          if (faites.has(cle)) continue;
          faites.add(cle);
          // Une colonne prise par une emprise voisine n'est pas du domaine public, et une
          // colonne imposée (rue, eau, monument) garde son régime : `surfaceImposee` est la
          // lecture qu'avait déjà faite `bandePlanes` en acceptant ce gabarit.
          if (emprises.has(cle)) continue;
          if (surfaceImposee(wx, wz) !== null) continue;
          cible.push({ wx, wz, v });
        }
      }
    }
    for (const e of cible) {
      const { wx, wz, v } = e;
      const lx = wx - baseX;
      const lz = wz - baseZ;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) continue;
      const h = ground(wx, wz);
      const plein = (y) => {
        const b = blockAt(lx, lz, y);
        return b !== BLOCK.AIR && b !== BLOCK.WATER;
      };
      // Le point de départ, c'est ce que la colonne **porte aujourd'hui**, pas son relief
      // naturel : le bâti vient de passer par là et a déjà posé son pavage, son seuil ou son
      // linteau. Juger sur `ground` seul faisait sauter le nettoyage et laissait, par exemple,
      // un pavé à 30 sous une cour montée à 32 — un ressaut de deux cubes avec un vide dessous.
      const auDessus = sommetDe(wx, wz);
      // Le revêtement qui se déplace avec la colonne se cherche près du sol : une dalle posée
      // à `v` est un pavage, pas le faîtage d'en face.
      const dessus0 = sommetDe(wx, wz, Math.max(h, v) + 2);
      // Un revêtement déjà posé (seuil pavé, caniveau) se déplace avec la cour ; le sol nu
      // garde son matériau.
      const dessus = dessus0 !== null && PAVE.includes(blockAtMonde(wx, wz, dessus0))
        ? blockAtMonde(wx, wz, dessus0)
        : (SOL_NU.includes(blockAt(lx, lz, auDessus ?? h)) ? blockAt(lx, lz, auDessus ?? h) : BLOCK.GRASS);
      if (auDessus === v && dessus0 === v && (v <= 1 || (plein(v - 1) && plein(v - 2)))) continue;
      // Combler jusqu'au niveau de la cour en repartant du sommet de la **masse continue** sous
      // `v` — pas du premier bloc venu : le bâti laisse parfois une dalle isolée, et s'appuyer
      // dessus laissait un vide sous la cour (mesuré : SAND à 20, AIR à 21, COBBLE à 22, GRASS
      // à 23 — la cour avait un niveau sous les pieds et un trou dedans).
      let masse = -1;
      for (let y = Math.min(v - 1, CHUNK_HEIGHT - 2); y >= 1; y--) {
        if (plein(y) && plein(y - 1)) { masse = y; break; }
      }
      for (let y = masse + 1; y < v; y++) setAt(lx, lz, y, BLOCK.DIRT);
      // Et dans les deux sens : une cour qu'on remblaie doit aussi voir le ciel libre. Oublier
      // ce nettoyage côté remontée laissait en place un linteau de porte à `v + 1` — la bande
      // était de niveau sous les pieds et butait au-dessus.
      if (auDessus !== null && auDessus > v) {
        for (let y = v + 1; y <= auDessus; y++) setAt(lx, lz, y, BLOCK.AIR);
      }
      setAt(lx, lz, v, dessus);
    }
  }

  /**
   * Peint le pourtour extérieur des cours données (rectangles d'emprise en coordonnées
   * monde) sur les colonnes du tronçon. Un tronçon ne peint que sa part : les rectangles
   * viennent aussi des tronçons voisins, dont la cour déborde la frontière. L'arbitrage
   * « seulement dégagée » laisse la cour en terre naturelle, donc indiscernable du lot
   * voisin : une assise de pierre taillée pose la limite **à plat**, jamais un obstacle —
   * elle ne dépasse jamais le sol et ne prend que sur un terrain nu sous de l'air libre.
   */
  function traitDeCour(data, cx, cz, rects) {
    const pad = VILLAGE.courtWidth;
    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;
    const idx = (lx, lz, y) => lx + lz * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE;
    const blockAt = (lx, lz, y) => (y < 0 || y >= CHUNK_HEIGHT ? BLOCK.AIR : data[idx(lx, lz, y)]);
    // Un temple proche est rare : on ne paie la recherche de la pierre que ce jour-là.
    const pres = templesSur(baseX - CHUNK_SIZE, baseZ - CHUNK_SIZE,
      baseX + 2 * CHUNK_SIZE, baseZ + 2 * CHUNK_SIZE).length > 0;
    const pose = (wx, wz) => {
      const lx = wx - baseX;
      const lz = wz - baseZ;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) return;
      if (roadKind(wx, wz)) return;
      if (pres && templeStone(wx, wz)) return;
      const y = sommetColonne(blockAt, lx, lz, ground(wx, wz) + VILLAGE.courtWidth + 6);
      if (y === null) return;
      if (!SOL_NU.includes(blockAt(lx, lz, y))) return;
      if (blockAt(lx, lz, y + 1) !== BLOCK.AIR) return;
      data[idx(lx, lz, y)] = BLOCK.STONE;
    };
    for (const [rx0, rz0, rx1, rz1] of rects) {
      for (let wx = rx0 - pad; wx <= rx1 + pad; wx++) {
        pose(wx, rz0 - pad);
        pose(wx, rz1 + pad);
      }
      for (let wz = rz0 - pad + 1; wz <= rz1 + pad - 1; wz++) {
        pose(rx0 - pad, wz);
        pose(rx1 + pad, wz);
      }
    }
  }

  /** Le trait de toutes les cours qui touchent le tronçon, y compris celles du voisin. */
  function lignesDeCour(data, cx, cz) {
    const rects = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bx = (cx + dx) * CHUNK_SIZE;
        const bz = (cz + dz) * CHUNK_SIZE;
        for (const p of buildingAt(cx + dx, cz + dz)) {
          rects.push([bx + p.x0, bz + p.z0, bx + p.x0 + p.w - 1, bz + p.z0 + p.d - 1]);
        }
      }
    }
    if (rects.length) traitDeCour(data, cx, cz, rects);
  }

  function stampOne(data, cx, cz, plan) {
    const { x0, z0, w, d, siteH, height } = plan;
    const set = (lx, y, lz, id) => {
      if (y < 0 || y >= CHUNK_HEIGHT) return;
      data[lx + lz * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE] = id;
    };
    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;
    const roofY = siteH + height + 1;
    const stair = plan.stair;
    const stairCells = stair ? stair.cells : null;
    const onStair = stairCells ? new Set(stairCells.map((c) => `${c.lx},${c.lz}`)) : null;
    const inside = (lx, lz) => lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE;

    // 1) Terrasse rectangulaire plate. Le bâtiment s'assoit sur un socle de pierre —
    //    remplissage en pierre grise, arête en rocher — comblé du côté de la vallée et
    //    retranché du côté de la colline. Le terrain alentour n'est pas modifié : c'est
    //    l'emprise qui prend son niveau. Sans ce socle, la maison se posait à même une
    //    pente qu'elle ne corrigeait que sous son plancher (mesuré sur ±224 cubes : pas
    //    une des 202 emprises n'était plate naturellement, médiane trois cubes d'écart),
    //    et le village ne se lisait pas en îlots mais en cabanes accrochées au relief.
    const isPerimeter = (lx, lz) => lx === x0 || lx === x0 + w - 1 || lz === z0 || lz === z0 + d - 1;
    for (let lx = x0; lx < x0 + w; lx++) {
      for (let lz = z0; lz < z0 + d; lz++) {
        const surface = ground(baseX + lx, baseZ + lz);
        set(lx, siteH, lz, isPerimeter(lx, lz) ? BLOCK.COBBLE : plan.floor);
        for (let y = Math.min(surface, siteH - 1); y <= siteH - 1; y++) set(lx, y, lz, BLOCK.STONE);
        for (let y = siteH + 1; y <= Math.max(surface, roofY + 1); y++) set(lx, y, lz, BLOCK.AIR);
      }
    }

    // 2) Murs d'enceinte, avec fenêtres en quinconce.
    for (let lx = x0; lx < x0 + w; lx++) {
      for (let lz = z0; lz < z0 + d; lz++) {
        if (!isPerimeter(lx, lz)) continue;
        for (let y = siteH + 1; y <= siteH + height; y++) {
          const storey = y - siteH;
          // La rangée qui repose sur une dalle reste pleine : depuis la rue elle se lit
          // comme le plancher, et les étages d'une tour de dix niveaux sont comptables
          // de l'extérieur au lieu d'un damier continu.
          const underSlab = (storey - 1) % VILLAGE.floorPitch === 0;
          const glazed = storey >= 2
            && storey <= height - 1
            && !underSlab
            && ((lx + lz + storey) % 2 === 0);
          set(lx, y, lz, glazed ? plan.window : plan.wall);
        }
      }
    }

    // 3) Porte : une baie de deux cubes sur la façade choisie, avec linteau. Devant la
    //    baie, le seuil se cale sur la chaussée là où la rue y passe réellement — sinon
    //    son évidement effaçait le pavé que l'avenue venait d'étendre. Hors voirie, il
    //    reste au plancher et c'est la pente qui se taille une tranchée (3b).
    const { door } = plan;
    let seuil = siteH;
    for (const step of [door.front, door.out]) {
      if (!inside(step.lx, step.lz)) continue;
      const rue = roadSurface(baseX + step.lx, baseZ + step.lz, true);
      if (rue !== null && rue > seuil) seuil = rue;
    }
    set(door.lx, seuil + 1, door.lz, BLOCK.AIR);
    set(door.lx, seuil + 2, door.lz, BLOCK.AIR);
    set(door.lx, seuil + 3, door.lz, plan.wall);

    // 3b) Dégagement de l'entrée : tranchée au droit de la baie, seuil posé sur son socle
    //     pour qu'il ne flotte pas au-dessus du vide.
    for (const step of [door.front, door.out]) {
      if (!inside(step.lx, step.lz)) continue;
      const sol = sousRue(baseX + step.lx, baseZ + step.lz, null);
      const marche = Math.max(siteH, Math.min(sol, seuil));
      for (let y = siteH + 1; y <= Math.max(sol + VILLAGE.headroom - 1, siteH + 3); y++) set(step.lx, y, step.lz, BLOCK.AIR);
      for (let y = Math.max(0, Math.min(siteH, marche)); y <= marche; y++) set(step.lx, y, step.lz, BLOCK.COBBLE);
    }
    if (inside(door.front.lx, door.front.lz)) set(door.front.lx, seuil + 3, door.front.lz, BLOCK.PLANKS);

    // 4) Planchers intermédiaires des immeubles, évidés sur le puits de l'escalier,
    //    puis les marches : chaque plateau repose sur son dé de garde-corps.
    //    Le premier plancher reste à quatre cubes au-dessus du seuil : l'auto-
    //    franchissement hausse le corps de `feet+1` à `feet+2,8`, donc une dalle posée
    //    à trois cubes seulement bloque le joueur debout qui veut lever d'un cran pour
    //    attraper la première marche. Les étages courants gardent le pas de trois.
    if (stairCells) {
      const firstSlab = siteH + VILLAGE.floorPitch + 1;
      for (let y = firstSlab; y <= siteH + height - 1; y += VILLAGE.floorPitch) {
        for (let lx = x0 + 1; lx <= x0 + w - 2; lx++) {
          for (let lz = z0 + 1; lz <= z0 + d - 2; lz++) {
            set(lx, y, lz, onStair.has(`${lx},${lz}`) ? BLOCK.AIR : BLOCK.STONE);
          }
        }
      }
      stair.treads.forEach((tread, k) => {
        // Les deux premières marches prennent appui sur la dalle ; ensuite elles
        // s'accrochent à la marche précédente, comme une vraie limon.
        for (const c of tread.cells) {
          for (let y = (k < 2 ? siteH + 1 : tread.y - 1); y <= tread.y; y++) set(c.lx, y, c.lz, plan.stairBlock);
        }
      });
    }

    // 5) Toit : dalle pleine, garde-d'appui sur les immeubles, pignon et cheminée
    //    sur les maisons.
    for (let lx = x0; lx < x0 + w; lx++) {
      for (let lz = z0; lz < z0 + d; lz++) set(lx, roofY, lz, plan.roof);
    }
    if (plan.kind === 'tower') {
      for (let lx = x0; lx < x0 + w; lx++) {
        set(lx, roofY + 1, z0, BLOCK.COBBLE);
        set(lx, roofY + 1, z0 + d - 1, BLOCK.COBBLE);
      }
      for (let lz = z0; lz < z0 + d; lz++) {
        set(x0, roofY + 1, lz, BLOCK.COBBLE);
        set(x0 + w - 1, roofY + 1, lz, BLOCK.COBBLE);
      }
    } else if (plan.gable) {
      const ridgeStart = x0 + Math.floor(w / 3);
      const ridgeEnd = x0 + w - 1 - Math.floor(w / 3);
      for (let lx = ridgeStart; lx <= ridgeEnd; lx++) {
        for (let lz = z0; lz < z0 + d; lz++) set(lx, roofY + 1, lz, plan.roof);
      }
    }
    if (plan.chimney && !(onStair && onStair.has(`${x0 + w - 2},${z0 + 1}`))) {
      const chX = x0 + w - 2;
      const chZ = z0 + 1;
      set(chX, roofY + 1, chZ, BLOCK.COBBLE);
      set(chX, roofY + 2, chZ, BLOCK.COBBLE);
    }

    // 6) Dégagement de la volée. Le corps du joueur fait 1,8 cube de haut et, comme il
    //    est large de 0,6, il chevauche la colonne voisine dès qu'il n'est pas pile
    //    centré : gravir une marche lève en plus la tête d'un cran (le moteur auto-franchit
    //    STEP_HEIGHT). Trois cubes libres au-dessus de chaque plateau sont donc le
    //    minimum — en dessous, un plancher ou la dalle du toit sur la colonne d'à côté
    //    transforme la marche en mur et le dernier étage devient inaccessible.
    if (stair) {
      for (const tread of stair.treads) {
        for (const c of tread.cells) {
          for (let y = tread.y + 1; y <= tread.y + 3; y++) set(c.lx, y, c.lz, BLOCK.AIR);
        }
      }
      // Baie d'accès à la terrasse : devant les deux dernières marches, la dalle reste
      // pleine — c'est la marche d'appel — et seuls la rambarde et le vide sanitaire
      // au-dessus sont évidés. Le garde-d'appui survit partout ailleurs.
      for (const c of stair.exit) {
        set(c.lx, roofY, c.lz, plan.roof);
        for (let y = roofY + 1; y <= roofY + 2; y++) set(c.lx, y, c.lz, BLOCK.AIR);
      }
    }
    return true;
  }

  /**
   * Revêtement des voiries : chaussée en gravier sur son lit de pierre, caniveils
   * pavés. À appeler après le remplissage naturel, avant l'estampage des bâtiments.
   */
  function stampRoads(data, cx, cz) {
    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;
    let touched = 0;
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wx = baseX + lx;
        const wz = baseZ + lz;
        const kind = roadKind(wx, wz);
        if (!kind) continue;
        // Une croisée relève de deux avenues : chacune y porte sa chaussée, atténuée
        // au-delà de sa largeur (voir `roadSurface`), et le creux est comblé dessous.
        const niveau = roadSurface(wx, wz, true);
        if (niveau === null || niveau < 0 || niveau >= CHUNK_HEIGHT) continue;
        const naturel = heightAt(wx, wz);
        // L'avenue s'arrête au rivage — celui de la mer comme celui d'une rivière :
        // poser du pavé sur le plancher puis évider l'eau au-dessus pour son garde-tête
        // creuserait un fossé sec en pleine baie, et paver une rivière la couperait en
        // digue. Le dernier tronçon utile reste la berge.
        // La règle porte sur le terrain **et** sur le niveau posé par la rue : la
        // chaussée est dure, elle déplace l'eau, donc un pavé à la ligne même fait quai.
        // `profilRue` conduit le relief à un cube de dénivelé par colonne et pouvait
        // poser son profil neuf cubes sous la mer sur une colonne pourtant au sec
        // (mesuré : 988 colonnes). Rien de la voirie — revêtement ni lit — ne descend
        // au plan d'eau ; au-delà la rue cesse et reprend de l'autre côté.
        const eau = planDEau(wx, wz);
        if (naturel < eau + 1 || niveau < eau + 1) continue;
        const idx = (y) => lx + lz * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE;
        data[idx(niveau)] = kind === 'bed' ? BLOCK.GRIT : BLOCK.COBBLE;
        // Le lit descend jusqu'au terrain naturel : une marche ne doit jamais flotter,
        // sinon le joueur voit un escalier au-dessus d'un trou. Il s'arrête au plan
        // d'eau — combler jusqu'au sol noyé reviendrait à faire un quai.
        const plancher = Math.max(eau + 1, Math.min(naturel, niveau - 1));
        for (let y = niveau - 1; y >= plancher && y >= 0; y--) data[idx(y)] = BLOCK.COBBLE;
        // Garde-tête au-dessus de la marche, et rien qui pousse dessus : on émonde
        // aussi ce que le relief laisse dépasser entre deux marches.
        const plafond = Math.min(CHUNK_HEIGHT - 1, Math.max(naturel, niveau + VILLAGE.headroom - 1));
        for (let y = niveau + 1; y <= plafond; y++) data[idx(y)] = BLOCK.AIR;
        touched++;
      }
    }
    return touched;
  }

  // ==================== OUVRAGES D'ART ====================
  // Ponts et arcs sont définis par des coordonnées absolues — une ligne d'avenue plus
  // une maille le long de cette avenue — et jamais par tronçon : un tablier qui court
  // sur trois tronçons doit se raccorder de lui-même aux frontières, comme la voirie.
  // Tout est déduit du hachage des coordonnées, donc un monde rechargé retrouve ses
  // ponts cube pour cube.

  const ARCH_T = 3;      // épaisseur d'un arc le long de l'avenue
  const ARCH_SLOPE_MAX = 14; // colonnes de part et d'autre où le nivellement peut encore courir

  /** Cellule monde d'une avenue : `along` le long de l'axe, `off` en travers. */
  function cellOf(axis, k, along, off) {
    const line = k * VILLAGE.roadSpacing;
    return axis === 'x' ? { wx: along, wz: line + off } : { wx: line + off, wz: along };
  }

  /** Relief au droit de l'axe de circulation. */
  function profileAt(axis, k, along) {
    const c = cellOf(axis, k, along, 0);
    return ground(c.wx, c.wz);
  }

  /** Arcs dont l'emprise couvre une plage de colonnes de cette avenue. */
  function archesOn(axis, k, from, to) {
    const out = [];
    const cell = VILLAGE.archCell;
    const pad = ARCH_SLOPE_MAX + 4;
    const half = cell >> 1;
    for (let seg = Math.floor((from - pad - half) / cell); seg <= Math.floor((to + pad - half) / cell); seg++) {
      const a = archAt(axis, k, seg);
      if (a && a.hi >= from && a.lo <= to) out.push(a);
    }
    return out;
  }

  /**
   * Surface de roulement imposée par un ouvrage : tablier et rampes d'un pont, niveau
   * nivelé d'un arc. Renvoie null là où la rue est libre de suivre le relief.
   */
  function structSurface(axis, k, along) {
    for (const b of bridgesOn(axis, k, along, along)) {
      if (along < b.from || along > b.to) continue;
      return b.ramp.has(along) ? b.ramp.get(along) : b.deckY;
    }
    for (const a of archesOn(axis, k, along, along)) {
      if (a.levels.has(along)) return a.levels.get(along);
    }
    return null;
  }

  const levelCache = new Map();

  /**
   * Altitude de la chaussée le long d'une avenue : le relief, ramené à **un cube de
   * dénivelé par colonne**. Le joueur ne franchit qu'un cube à la fois ; posée telle
   * quelle sur la pente naturelle, une avenue droite butait contre des ressauts de
   * deux à six cubes (mesuré le 2026-11-07 : 68 à 112 colonnes sur 720, et le marcheur
   * s'arrêtait net devant un ressaut de six). La rue se pose donc en marches continues.
   *
   * Trois lectures, pour que rien ne se réponde dans le vide :
   *  - `n` — le relief seul. C'est ce que lisent les plans de bâtiments : un pont se
   *    refuse si son emprise murerait une porte, donc sa décision dépend des bâtiments,
   *    et se lire elle-même ici bouclerait.
   *  - `p` — le relief **et les ouvrages propres à cette avenue** (tablier, rampes,
   *    nivellement d'arc), sans rien demander aux voisines.
   *  - `r` — comme `p`, plus le raccord aux avenues perpendiculaires, dont le niveau
   *    propre entre comme cible douce. `r` ne lit jamais le `r` d'une autre avenue :
   *    deux rues qui se répondent avec leurs ouvrages partent en boucle et le résultat
   *    dépend de qui calcule en premier (mesuré sur les gradins : un creux de cinq cubes
   *    à la croisée x-2 / z-1 selon l'ordre des sondes).
   *
   * Fonction pure des coordonnées absolues, comme tout le reste : deux marches sont
   * conduites depuis les bords de la fenêtre et moyennees, pour que la montée ne
   * s'incline pas selon le sens où l'on parcourt l'avenue.
   */
  function profilRue(axis, k, along, mode) {
    const key = `${mode}${axis}${k},${along}`;
    const hit = levelCache.get(key);
    if (hit !== undefined) return hit;
    const W = VILLAGE.roadStepWindow;
    const portee = VILLAGE.roadHalf + VILLAGE.kerb;
    // Surface imposée à cette colonne par un ouvrage qui couvre NOTRE avenue : contrainte
    // dure — la rue ne discute pas le pont qu'elle porte. Ce qu'impose l'avenue
    // perpendiculaire n'entre pas ici mais dans `cible`, où cela reste une cible : forcer
    // une rue à descendre d'un coup ne se fait pas.
    const sonde = (j) => (mode === 'n' ? null : structSurface(axis, k, j));
    // Le pas d'un cube commande : la rue rejoint sa cible aussi vite qu'elle peut,
    // jamais plus. Une montée longue creuse donc un remblai plutôt qu'un ressaut.
    // Ce que viserait la rue sans elle-même : le relief moyenné puis calé sur des
    // paliers. Le grain du bruit simplex saute parfois deux cubes d'une colonne à
    // l'autre et chaque saut devenait une marche (mesuré le 2026-11-09 : 44 % des
    // colonnes en dénivelé sur ±144 cubes, alors que le joueur y marche à plat la
    // plupart du temps). La moyenne efface le grain, le calage en paliers rend de
    // longues suites exactement plates.
    // Ni hystérésis ni état : `marche` reste seule à décider du dénivelé, à un cube par
    // colonne. Une règle à mémoire ferait dépendre la colonne de l'origine de sa
    // fenêtre glissante, et deux colonnes voisines pouvaient décrocher de deux cubes.
    const palier = (j) => {
      const M = VILLAGE.roadSmooth;
      let somme = 0;
      let n = 0;
      for (let o = -M; o <= M; o++) { somme += profileAt(axis, k, j + o); n++; }
      const pas = VILLAGE.roadFlatBand;
      return Math.round(somme / n / pas) * pas;
    };
    const autreAxis = axis === 'x' ? 'z' : 'x';
    const selAutre = axis === 'x' ? SALT_ROAD_X : SALT_ROAD_Z;
    const debord = portee + W;
    const cible = (j) => {
      const t = palier(j);
      if (mode !== 'r') return t;
      const kk = Math.round(j / VILLAGE.roadSpacing);
      const ecart = Math.abs(j - kk * VILLAGE.roadSpacing);
      if (ecart > debord || !lineExists(kk, selAutre)) return t;
      const taper = Math.max(0, ecart - portee);
      // L'ouvrage porté par l'avenue d'en face commande sa croisée : un tablier qui
      // traverse la nôtre y impose son niveau, dans les deux sens. Le laisser comme
      // simple plafond laissait la rue d'en face présenter un pavé trois cubes au-dessus
      // de la dernière colonne de tablier — un mur pour le marcheur qui sort du pont.
      const charge = structSurface(autreAxis, kk, k * VILLAGE.roadSpacing);
      if (charge !== null && ecart <= portee) return charge;
      const face = profilRue(autreAxis, kk, k * VILLAGE.roadSpacing, 'p') - taper;
      return face > t ? face : t;
    };
    const marche = (from, to, step) => {
      const premier = sonde(from);
      let v = premier === null ? cible(from) : premier;
      for (let j = from + step; step > 0 ? j <= to : j >= to; j += step) {
        const s = sonde(j);
        const t = s === null ? cible(j) : s;
        v = s === null ? Math.min(Math.max(t, v - 1), v + 1) : t;
      }
      return v;
    };
    const ici = sonde(along);
    let lvl;
    if (ici !== null) {
      lvl = ici;
    } else {
      lvl = Math.round((marche(along - W, along, 1) + marche(along + W, along, -1)) / 2);
      // Les deux marches s'arrêtent à la colonne visée : un tablier posé juste derrière
      // n'y entre pas, et la rue se retrouvait à trois cubes d'un coup du pied de rampe.
      // Les ouvrages imposent donc leurs cônes de Lipschitz sur toute la fenêtre.
      let bas = -Infinity;
      let haut = Infinity;
      for (let j = along - W; j <= along + W; j++) {
        const s = sonde(j);
        if (s === null) continue;
        const d = Math.abs(along - j);
        if (s - d > bas) bas = s - d;
        if (s + d < haut) haut = s + d;
      }
      // Deux ouvrages incompatibles (deux niveaux que dix colonnes ne réconcilient pas) :
      // aucune borne ne tient, on laisse la moyenne conduire et l'autre contrôle tranchera.
      if (bas <= haut) lvl = Math.min(Math.max(lvl, bas), haut);
    }
    if (levelCache.size > 65536) levelCache.clear();
    levelCache.set(key, lvl);
    return lvl;
  }

  /** Niveau foulé le long d'un axe : relief, ouvrages propres et raccord de croisée. */
  const streetLevel = (axis, k, along) => profilRue(axis, k, along, 'r');

  /**
   * Niveau que la voirie impose en une cellule du monde : le maximum des avenues qui la
   * couvrent réellement (chaussée et caniveau), ou null hors voirie — sinon le terrain
   * voisin cesserait d'être du terrain pour les plans de bâtiments comme pour les joueurs.
   *
   * Le raccord entre deux rues qui se croisent se lit ici par amortissement : au delà de
   * sa chaussée, une avenue n'amène plus son niveau plein mais décroissant d'un cube par
   * colonne, sans coupe franche. Chaque contribution est ainsi à un cube par colonne le
   * long de l'axe, et le maximum de fonctions à pas borné garde le pas borné — posée en
   * escalier arrêté net à l'entrée du bandeau voisin, la voisine apparaissait d'un coup
   * deux cubes plus haut à la croisée z-2 / x0. Ce qu'une rue épinglée par un tablier ne
   * peut pas atteindre se refuse à la construction du pont (`approcheCoupee`), pas à la
   * marche du joueur.
   */
  function roadSurface(wx, wz, avecOuvrages) {
    if (!roadKind(wx, wz)) return null;
    const ns = laneOf(wz, VILLAGE.roadSpacing);
    const ew = laneOf(wx, VILLAGE.roadSpacing);
    const portee = VILLAGE.roadHalf + VILLAGE.kerb;
    const mode = avecOuvrages ? 'r' : 'n';
    let niveau = null;
    const porter = (axis, k, along, offset, sel) => {
      if (!lineExists(k, sel)) return;
      const t = profilRue(axis, k, along, mode) - Math.max(0, Math.abs(offset) - portee);
      if (niveau === null || t > niveau) niveau = t;
    };
    porter('x', ns.k, wx, ns.offset, SALT_ROAD_Z);
    porter('z', ew.k, wz, ew.offset, SALT_ROAD_X);
    return niveau;
  }

  /** Ce sur quoi marche le joueur en ce point du monde : chaussée nivelée ou terrain. */
  function surfaceAt(wx, wz) {
    const niveau = roadSurface(wx, wz, false);
    return niveau === null ? ground(wx, wz) : niveau;
  }

  /**
   * Sol réel d'une cellule de voirie pour un ouvrage qui l'emprunte ou l'enjambe : le
   * relief, mais jamais sous la chaussée que la rue s'est posée. Un tablier qui évidé
   * sa travée en partant du relief naturel creuserait le lit de pierre d'une avenue
   * voisine haussée par ses escaliers, et le pavé se retrouverait suspendu.
   *
   * `axe` est celui de l'ouvrage : sa propre avenue est exclue, sinon le tablier se
   * comparerait au niveau que lui-même impose et n'ouvrirait jamais sa travée. À `null`,
   * les deux avenues comptent — c'est le cas d'un seuil de porte posé sur la rue.
   * Seule la chaussée réellement posée protège quelque chose : une avenue voisine dont
   * l'influence ne fait que décroître au large n'y a rien écrit, et ne doit donc pas
   * interdire de creuser — sans quoi un pont lointain boucherait sa propre travée.
   */
  function sousRue(wx, wz, axe) {
    const naturel = ground(wx, wz);
    const ns = laneOf(wz, VILLAGE.roadSpacing);
    const ew = laneOf(wx, VILLAGE.roadSpacing);
    const portee = VILLAGE.roadHalf + VILLAGE.kerb;
    let niveau = null;
    const porter = (axis, k, along, offset, sel) => {
      if (axe && axis === axe) return;
      if (!lineExists(k, sel)) return;
      if (Math.abs(offset) > portee) return;
      const t = profilRue(axis, k, along, 'r');
      if (niveau === null || t > niveau) niveau = t;
    };
    porter('x', ns.k, wx, ns.offset, SALT_ROAD_Z);
    porter('z', ew.k, wz, ew.offset, SALT_ROAD_X);
    return niveau === null ? naturel : Math.max(naturel, niveau);
  }

  /** Colonnes que réclament les entrées des bâtiments d'un rectangle de monde. */
  function doorwayCellsIn(x0, x1, z0, z1) {
    const set = new Set();
    const cx0 = Math.floor(Math.min(x0, x1) / CHUNK_SIZE);
    const cx1 = Math.floor(Math.max(x0, x1) / CHUNK_SIZE);
    const cz0 = Math.floor(Math.min(z0, z1) / CHUNK_SIZE);
    const cz1 = Math.floor(Math.max(z0, z1) / CHUNK_SIZE);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        for (const plan of buildingAt(cx, cz)) {
          const bx = cx * CHUNK_SIZE;
          const bz = cz * CHUNK_SIZE;
          // La baie (portée par `door` lui-même) et les deux colonnes de dégagement :
          // un ouvrage posé là-dessus murerait l'entrée, et une porte sans issue est
          // plus grave qu'un pont absent.
          for (const c of [plan.door, plan.door.front, plan.door.out]) {
            set.add(`${bx + c.lx},${bz + c.lz}`);
          }
        }
      }
    }
    return set;
  }

  /** Vrai si l'emprise au sol d'un ouvrage écrase une entrée de bâtiment. */
  function doorwayConflict(axis, k, from, to, half) {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const a = cellOf(axis, k, lo, -half);
    const b = cellOf(axis, k, hi, half);
    const doors = doorwayCellsIn(
      Math.min(a.wx, b.wx), Math.max(a.wx, b.wx), Math.min(a.wz, b.wz), Math.max(a.wz, b.wz),
    );
    if (!doors.size) return false;
    for (let i = lo; i <= hi; i++) {
      for (let o = -half; o <= half; o++) {
        const c = cellOf(axis, k, i, o);
        if (doors.has(`${c.wx},${c.wz}`)) return true;
      }
    }
    return false;
  }

  /**
   * Rampe d'accès : depuis la première colonne hors du tablier, on rattrape le terrain
   * colonne par colonne, un cube de dénivelé par pas. La boucle démarre à `from` même :
   * commencer une colonne plus loin laissait parfois un appui naturel deux cubes au-
   * dessus du tablier, et le joueur ne franchit qu'un cube à la fois. Au-delà de
   * `bridgeMaxRamp` colonnes, ou si le relief redescend en pleine rampe, on renonce au
   * pont plutôt que de laisser un mur en travers de la rue.
   */
  function buildRamp(axis, k, from, step, deckY, ramp) {
    let level = deckY;
    for (let n = 0; n < VILLAGE.bridgeMaxRamp; n++) {
      const i = from + step * n;
      const h = profileAt(axis, k, i);
      if (h < level) return false;          // le terrain repart vers le bas : rampe sans fin
      if (h === level) return true;         // il rejoint le tablier, la rue reprend la main
      level = Math.min(level + 1, h);
      ramp.set(i, level);
      if (level >= h) return true;
    }
    return false;
  }

  /**
   * Niveau le plus haut que présentent, à leur croisée avec cette avenue, les avenues
   * perpendiculaires dont la coupe tombe dans la plage donnée. `-Infinity` si aucune.
   * La variante `p` — ouvrages propres de l'avenue d'en face, sans raccord réciproque :
   * c'est bien ce qu'elle posera cube à cube sur sa chaussée.
   */
  function niveauCroisees(axis, k, from, to) {
    const autreAxis = axis === 'x' ? 'z' : 'x';
    const selAutre = axis === 'x' ? SALT_ROAD_X : SALT_ROAD_Z;
    const k0 = Math.floor(from / VILLAGE.roadSpacing);
    const k1 = Math.ceil(to / VILLAGE.roadSpacing);
    let haut = -Infinity;
    for (let kc = k0; kc <= k1; kc++) {
      if (!lineExists(kc, selAutre)) continue;
      const croisade = kc * VILLAGE.roadSpacing;
      if (croisade < from || croisade > to) continue;
      // `n` et non `p` : la variante avec ouvrages lirait les ponts de l'avenue d'en
      // face, dont la décision nous redemande les nôtres — deux ouvrages qui se
      // consultent avant d'exister ne convergent pas.
      const t = profilRue(autreAxis, kc, k * VILLAGE.roadSpacing, 'n');
      if (t > haut) haut = t;
    }
    return haut;
  }

  /**
   * Niveau que prendrait, sans consulter personne, le tablier d'eau de l'avenue
   * `(axe, kc)` là où elle croise la nôtre : son plan d'eau plus la garde, ou le niveau
   * que réclament ses propres croisées. Le calcul est celui de `franchirEau` amputé de
   * cette consultation — terrain et profil lissé uniquement, jamais un ouvrage déjà
   * décidé, sous peine de deux tabliers qui se consultent avant d'exister et ne
   * convergent pas. Chaque côté évaluant ainsi le voisin, les deux aboutissent au même
   * nombre et se rejoignent d'eux-mêmes.
   */
  function tablierVoisin(axe, kc, i) {
    const cell = VILLAGE.bridgeCell;
    const own = (cell >> 1) - 1;
    const bord = VILLAGE.roadHalf + VILLAGE.kerb;
    const centre = Math.round((i - (cell >> 1)) / cell) * cell + (cell >> 1);
    let eau = -Infinity;
    for (let j = centre - own; j <= centre + own; j++) {
      for (let o = -bord; o <= bord; o++) {
        const c = cellOf(axe, kc, j, o);
        if (!noye(c.wx, c.wz)) continue;
        const e = planDEau(c.wx, c.wz);
        if (e > eau) eau = e;
      }
    }
    if (eau === -Infinity) return -Infinity;
    return Math.max(eau + VILLAGE.waterFreeboard,
      niveauCroisees(axe, kc, centre - own - bord - 6, centre + own + bord + 6));
  }

  /**
   * Ce que réclament à notre chaussée les avenues perpendiculaires de la plage donnée :
   * leur relief lissé (`niveauCroisees`) **et** le tablier qu'elles posent d'elles-mêmes
   * par-dessus l'eau. Sans cette seconde jambe, deux viaducs enjambant le même lac se
   * rangeaient l'un sur l'autre à trois cubes d'intervalle, et celui estampé en dernier
   * y creusait son garde-tête : le platelage du premier disparaissait (mesuré le
   * 2026-11-09 à (-157,320), croisée des avenues x4 et z-2, chaussée absente à y=24 et
   * pavé d'en face planté à 21 au milieu du chenal). Deux tabliers qui se croisent se
   * rejoignent donc au même niveau, comme deux rues qui se croisent.
   */
  function niveauCroiseesAvecEau(axis, k, from, to) {
    let haut = niveauCroisees(axis, k, from, to);
    const autreAxis = axis === 'x' ? 'z' : 'x';
    const selAutre = axis === 'x' ? SALT_ROAD_X : SALT_ROAD_Z;
    const k0 = Math.floor(from / VILLAGE.roadSpacing);
    const k1 = Math.ceil(to / VILLAGE.roadSpacing);
    for (let kc = k0; kc <= k1; kc++) {
      if (!lineExists(kc, selAutre)) continue;
      const croisade = kc * VILLAGE.roadSpacing;
      if (croisade < from || croisade > to) continue;
      const t = tablierVoisin(autreAxis, kc, k * VILLAGE.roadSpacing);
      if (t > haut) haut = t;
    }
    return haut;
  }

  /**
   * Franchissement d'eau : là où une rivière — ou un bras de mer étroit — coupe une
   * avenue, la chaussée passe en tablier sur piles et **l'eau reste libre dessous**.
   * Demandé le 2026-11-08 : « il faudrait faire des ponts au-dessus de l'eau, des
   * viaducs, au lieu de couper la route ». Deux bornes tiennent la décision :
   *
   *  - il faut une rive des deux côtés et une largeur d'eau bornée (`waterMaxSpan`) :
   *    au-delà c'est le large, et un viaduc sans rive d'en face n'est pas un pont —
   *    là la haute mer garde son rivage, comme avant ;
   *  - le tablier ne descend jamais à moins de `waterFreeboard` cubes du plan d'eau,
   *    pour que le chenal se nage sous l'ouvrage comme se marche la travée d'un pont
   *    de vallon. Et **rien n'est comblé entre les piles** : boucher la travée jusqu'à
   *    la naissance de l'arc ferait une digue qui couperait le cours en amont.
   */
  function computeWaterBridge(axis, k, seg) {
    if (!lineExists(k, axis === 'x' ? SALT_ROAD_Z : SALT_ROAD_X)) return null;
    // Pas de tirage ici, contrairement au pont de creux : une avenue qui s'arrête net
    // devant l'eau est un défaut, pas une variété. Le seuil de franchise vient des
    // gardes ci-dessous (mesuré le 2026-11-08 : 49 franchissements retenus sur 66
    // coupures franchissables autour de l'apparition, les refus tombant sous les gardes
    // d'approche et de croisée).
    const cell = VILLAGE.bridgeCell;
    const centre = seg * cell + (cell >> 1);
    const own = (cell >> 1) - 1;
    const half = VILLAGE.roadHalf + VILLAGE.kerb;
    // L'ouvrage couvre chaussée et caniveaux : c'est la plus basse des colonnes de la
    // traversée qui décide si cette colonne-là trempe.
    const mouille = (i) => {
      for (let o = -half; o <= half; o++) {
        const c = cellOf(axis, k, i, o);
        if (noye(c.wx, c.wz)) return true;
      }
      return false;
    };

    // Toutes les coupures que porte cette maille, de la plus proche de son centre à la
    // plus éloignée. Une maille peut en tenir deux — une rivière à îlot, un bras et sa
    // mare ; ne traiter que la plus proche du centre laissait la seconde sans pont, et
    // le contrôle la comptait « sans tablier » alors que l'ouvrage se dressait trois
    // colonnes plus loin. Exiger en outre que l'eau recouvre le centre de la maille en
    // faisait disparaître la moitié : un cours de quelques cubes ne tombe presque jamais
    // pile sous ce seul point d'échantillonnage (mesuré le 2026-11-09 : 7 traversées
    // franchissables sur 23 n'étaient jamais proposées à la construction).
    const coupures = [];
    for (let i = centre - own; i <= centre + own;) {
      if (!mouille(i)) { i++; continue; }
      let j = i;
      while (j + 1 <= centre + own && mouille(j + 1)) j++;
      coupures.push([i, j]);
      i = j + 1;
    }
    coupures.sort((a, b) => Math.abs((a[0] + a[1]) / 2 - centre)
      - Math.abs((b[0] + b[1]) / 2 - centre));
    for (const [deb, fin] of coupures) {
      const b = franchirEau({ axis, k, seg, centre, own, half, mouille }, deb, fin);
      if (b) return b;
    }
    return null;
  }

  /**
   * Tablier portant l'avenue au-dessus des colonnes mouillées [deb, fin], prolongé de
   * ses rampes. La coupure appartient à la maille qui tient son milieu, comme au fond du
   * vallon : deux candidats voisins ne posent pas deux tabliers l'un sur l'autre.
   */
  function franchirEau({ axis, k, seg, centre, own, half, mouille }, deb, fin) {
    const borne = own + VILLAGE.waterMaxSpan + 2 * VILLAGE.waterMaxRamp;
    let ds = deb, de = fin;
    while (ds > centre - borne && mouille(ds - 1)) ds--;
    while (de < centre + borne && mouille(de + 1)) de++;
    // La coupure appartient à la maille qui tient son milieu — même règle qu'au fond du
    // vallon, sinon deux candidats voisins posent deux tabliers l'un sur l'autre.
    if (Math.abs((ds + de) / 2 - centre) > own) return null;
    // Ce qui se mesure à `waterMaxSpan`, c'est **l'eau** : un bras large de vingt cubes
    // franchi par un viaduc de quarante reste un franchissement, tandis qu'une avenue qui
    // file dans l'océan n'a pas de rive d'en face.
    const largeurEau = de - ds + 1;
    if (largeurEau < VILLAGE.waterMinSpan || largeurEau > VILLAGE.waterMaxSpan) return null;

    // Le tablier ne court pas après le relief : c'est l'approche qui descend jusqu'à la
    // rue, comme sous tout viaduc. Un tablier haussé à `waterFreeboard` au-dessus du plan
    // d'eau survole souvent une plaine plate — l'étendre jusqu'à recouper le terrain en
    // faisait une chaussée sur pilotis de soixante colonnes, refusée faute de place.
    let left = ds - 1, right = de + 1;
    if (mouille(left) || mouille(right)) return null;

    // Le plan d'eau le plus haut sous l'emprise fixe la garde du tablier : une rivière
    // descend, mais un pont calé sur l'aval laisserait l'amont toucher le platelage.
    // La croisée rattrapée couvre aussi les approches : `approcheCoupee` juge les avenues
    // perpendiculaires jusqu'au pied des rampes, et un tablier haussé seulement sous son
    // travée se faisait refuser parce qu'une rue coupant trois colonnes plus loin
    // présentait un pavé que la rampe n'atteignait pas.
    // La place autour du tablier se mesure à la coupure réelle, pas à la demi-maille :
    // un estuaire de cinquante colonnes réclame autant de jeu pour ses rampes qu'un bras
    // de dix en trouve sans chercher. L'ouvrage reste borné à `centre ± edge`, il ne
    // déborde pas chez le voisin.
    const demi = Math.max(own, Math.ceil((fin - deb + 1) / 2));
    const edge = demi + 6 + VILLAGE.waterMaxRamp;
    let eau = seaLevel;
    for (let i = ds; i <= de; i++) {
      for (let o = -half; o <= half; o++) {
        const c = cellOf(axis, k, i, o);
        const e = planDEau(c.wx, c.wz);
        if (e > eau) eau = e;
      }
    }
    const deckY = Math.max(eau + VILLAGE.waterFreeboard,
      niveauCroiseesAvecEau(axis, k, ds - edge - half, de + edge + half));
    if (deckY < 2 || deckY > CHUNK_HEIGHT - 8) return null;

    // Approches : depuis la première colonne hors du tablier, on ramène la chaussée à la
    // rue à un cube de dénivelé par colonne — le pas que franchit le joueur. La cible est
    // le **profil de la rue** (`profilRue` en mode `n`, conduit à un cube par colonne),
    // non le terrain brut : le grain du bruit saute parfois deux cubes d'une colonne à
    // l'autre, et c'est bien le pavé que marche le joueur. Nulle colonne d'approche ne
    // trempe ni ne descend au plan d'eau : là non plus l'ouvrage ne doit rien combler.
    const ramp = new Map();
    const portee = VILLAGE.roadHalf + VILLAGE.kerb;
    // Ce que présentera réellement la colonne où la rampe rend la main : le relief (la rue
    // ne pave jamais sous le sol), le profil lissé de notre avenue, **et** le niveau que lui
    // impose une croisée proche. Le seul `profilRue 'n'` se faisait tirer vers le bassin
    // voisin — mesuré le 2026-11-08 sur l'avenue z-1 : la rampe plongeait à 19 alors que la
    // rue perpendiculaire y posait son pavé à 23, un mur de quatre cubes pour le marcheur
    // qui sort du tablier.
    const attend = (i) => {
      const c = cellOf(axis, k, i, 0);
      let v = ground(c.wx, c.wz);
      const n = profilRue(axis, k, i, 'n');
      if (n > v) v = n;
      const croisee = niveauCroiseesAvecEau(axis, k, i - portee, i + portee);
      if (croisee > v) v = croisee;
      return v;
    };
    const approche = (from, step) => {
      let niveau = deckY;
      for (let n = 0; n < VILLAGE.waterMaxRamp; n++) {
        const i = from + step * n;
        const c = cellOf(axis, k, i, 0);
        if (noye(c.wx, c.wz)) return false;            // ramper dans l'eau : digue déguisée
        const h = attend(i);
        // Rencontre franche : la colonne est au niveau visé **et** la suivante n'en
        // diffère pas de plus d'un cube — sinon la rue reprendrait la main sur un ressaut
        // que le joueur ne franchit pas. Un cube d'écart à l'abandon reste franchissable.
        if (Math.abs(h - niveau) <= 1 && Math.abs(attend(i + step) - h) <= 1) return true;
        niveau = h > niveau ? Math.min(niveau + 1, h) : Math.max(h, niveau - 1);
        if (niveau < planDEau(c.wx, c.wz) + 1) return false;
        ramp.set(i, niveau);
      }
      return false;                                     // rattrapage trop long : pas de pont
    };
    // Une approche qui ne rattrape pas la rue en `waterMaxRamp` colonnes n'enterre pas
    // le pont : le tablier s'allonge d'une colonne du côté qui refuse, tant que l'ouvrage
    // reste raisonnable. Un viaduc porte sa chaussée plus loin plutôt que de laisser la
    // rue coupée — c'est précisément ce que le joueur réclame. Il en va de même d'une
    // croisée que la rampe ne peut pas rattraper : le tablier l'enjambe au lieu de
    // s'arrêter trois colonnes avant elle, ce qui présenterait un mur de pavé au
    // marcheur qui sort du platelage.
    let bord = 0;
    for (;;) {
      ramp.clear();
      const aGauche = approche(left, -1);
      const aDroite = approche(right, 1);
      const etendue = [Math.min(ds, left + 1), Math.max(de, right - 1)];
      if (aGauche && aDroite && !approcheCoupee(axis, k, etendue[0], etendue[1], deckY)) break;
      if (bord >= VILLAGE.waterMaxRamp) return null;
      if (aGauche && aDroite) { if (bord % 2 === 0) right++; else left--; }
      else if (aGauche) right++;
      else left--;
      if (mouille(left) || mouille(right)) return null;   // on n'étend pas dans l'eau
      // Ni hors de la maille : le voisin tient l'autre moitié, deux tabliers se
      // poseraient l'un sur l'autre.
      if (left < centre - edge || right > centre + edge) return null;
      ds = Math.min(ds, left + 1);
      de = Math.max(de, right - 1);
      bord++;
    }

    const rampKeys = [...ramp.keys()];
    const from = Math.min(ds, ...rampKeys);
    const to = Math.max(de, ...rampKeys);
    if (doorwayConflict(axis, k, from, to, half)) return null;
    if (approcheCoupee(axis, k, from, to, deckY)) return null;

    return {
      kind: 'bridge', axis, k, seg, centre, surEau: true,
      ds, de, deckY, floorH: eau, span: de - ds + 1, half,
      clearance: Math.max(VILLAGE.bridgeClearance, deckY - eau),
      from, to, ramp,
      mat: pick([BLOCK.STONE, BLOCK.COBBLE], centre, 2, k, SALT_BRIDGE_MAT),
    };
  }

  /** Un franchissement d'abord sur l'eau (rivière, bras marin), puis sur un creux. */
  function computeBridge(axis, k, seg) {
    return computeWaterBridge(axis, k, seg) || computeDipBridge(axis, k, seg);
  }

  function computeDipBridge(axis, k, seg) {
    if (!lineExists(k, axis === 'x' ? SALT_ROAD_Z : SALT_ROAD_X)) return null;
    if (roll(k, seg, axis === 'x' ? 3 : 5, SALT_BRIDGE) >= VILLAGE.bridgeChance) return null;
    const cell = VILLAGE.bridgeCell;
    const centre = seg * cell + (cell >> 1);

    // Trois sondes suffisent à écarter les candidats plats, qui sont l'immense
    // majorité : sonder tout un profil coûte cher sous le bruit simplex du jeu.
    const hC = profileAt(axis, k, centre);
    if (hC > profileAt(axis, k, centre - 6) - 2 && hC > profileAt(axis, k, centre + 6) - 2) return null;

    let floorI = centre;
    let floorH = hC;
    const own = (cell >> 1) - 1;   // moitié de maille : le vallon appartient à ce candidat
    for (let i = centre - own; i <= centre + own; i += 2) {
      const h = profileAt(axis, k, i);
      if (h < floorH) { floorH = h; floorI = i; }
    }
    // Le fond doit tomber dans la maille de ce candidat : sinon c'est le voisin qui
    // l'a aussi sous la main et deux tabliers se poseraient l'un sur l'autre.
    if (Math.abs(floorI - centre) > own) return null;
    // Un franchissement de baie n'est pas un pont : les piles porteraient dans l'eau,
    // et l'avenue qui y mènerait s'est déjà arrêtée au rivage.
    if (floorH < seaLevel) return null;

    // Berges : de part et d'autre du fond, là où le relief remonte assez pour porter
    // une pile. Sans berge trouvée sur un côté, le vallon file hors du champ de sondage.
    const reach = VILLAGE.bridgeMaxSpan + VILLAGE.bridgeMaxRamp;
    let left = floorI;
    while (left > floorI - reach && profileAt(axis, k, left) < floorH + VILLAGE.bridgeMinDip) left--;
    let right = floorI;
    while (right < floorI + reach && profileAt(axis, k, right) < floorH + VILLAGE.bridgeMinDip) right++;
    const hL = profileAt(axis, k, left);
    const hR = profileAt(axis, k, right);
    if (hL < floorH + VILLAGE.bridgeMinDip || hR < floorH + VILLAGE.bridgeMinDip) return null;

    // Le tablier se cale sur la berge haute : c'est ce qui rend les rampes courtes. Il ne
    // descend pas non plus sous les avenues qu'il traverse — une dernière colonne de
    // tablier trois cubes sous la rue d'en face lui présentait un mur de pavé (mesuré le
    // 2026-11-07 sur z-2 : tablier à 19, croisée x0 à 22). Haussé à leur niveau, il rend
    // au passage plus de place libre sous l'arche.
    const edge = own + 6;
    const portee = VILLAGE.roadHalf + VILLAGE.kerb;
    const deckY = Math.max(hL, hR,
      niveauCroisees(axis, k, floorI - edge - portee, floorI + edge + portee));
    if (deckY - floorH < VILLAGE.bridgeMinDip) return null;
    if (deckY < 2 || deckY > CHUNK_HEIGHT - 8) return null;

    // Portée : toutes les colonnes sous le tablier, sans jamais déborder de la maille
    // de plus de six cubes — au-delà on empiéterait sur l'ouvrage du voisin.
    let ds = floorI;
    let de = floorI;
    while (ds > centre - edge && profileAt(axis, k, ds - 1) < deckY) ds--;
    while (de < centre + edge && profileAt(axis, k, de + 1) < deckY) de++;
    const span = de - ds + 1;
    if (span < VILLAGE.bridgeMinSpan || span > VILLAGE.bridgeMaxSpan) return null;
    if (profileAt(axis, k, ds - 1) < deckY || profileAt(axis, k, de + 1) < deckY) return null;

    const ramp = new Map();
    // Hauteur libre ménagée sous le tablier : proportionnelle au creux, bornée d'un côté
    // par la place qu'il faut au joueur pour passer debout dessous, de l'autre par la
    // lisibilité de l'arcade. Un pont sous lequel on ne peut pas marcher n'est qu'un
    // remblai, et le relief ne sert à rien s'il ne porte pas une travée.
    const clearance = Math.max(VILLAGE.bridgeClearance,
      Math.min(VILLAGE.bridgeMaxClearance, Math.round((deckY - floorH) * 0.6)));
    let arcade = 0;
    for (let i = ds; i <= de; i++) {
      if (isSoffitColumn(ds, i) && profileAt(axis, k, i) < deckY - clearance) arcade++;
    }
    if (arcade < VILLAGE.bridgeMinArcade) return null;

    if (!buildRamp(axis, k, ds - 1, -1, deckY, ramp)) return null;
    if (!buildRamp(axis, k, de + 1, 1, deckY, ramp)) return null;

    const half = VILLAGE.roadHalf + VILLAGE.kerb;
    const rampKeys = [...ramp.keys()];
    const from = Math.min(ds, ...rampKeys);
    const to = Math.max(de, ...rampKeys);
    if (doorwayConflict(axis, k, from, to, half)) return null;
    if (approcheCoupee(axis, k, from, to, deckY)) return null;

    return {
      kind: 'bridge', axis, k, seg, centre,
      ds, de, deckY, floorH, span, half, clearance,
      from, to, ramp,
      mat: pick([BLOCK.STONE, BLOCK.COBBLE, BLOCK.BRICK], centre, 2, k, SALT_BRIDGE_MAT),
    };
  }

  /** Ponts de cette avenue dont l'emprise couvre une plage de colonnes. */
  function bridgesOn(axis, k, from, to) {
    const out = [];
    const cell = VILLAGE.bridgeCell;
    const pad = Math.ceil(VILLAGE.bridgeMaxSpan / 2) + VILLAGE.bridgeMaxRamp + 2;
    const half = cell >> 1;
    for (let seg = Math.floor((from - pad - half) / cell); seg <= Math.floor((to + pad - half) / cell); seg++) {
      const b = bridgeAt(axis, k, seg);
      if (b && b.to >= from && b.from <= to) out.push(b);
    }
    return out;
  }

  function computeArch(axis, k, seg) {
    if (!lineExists(k, axis === 'x' ? SALT_ROAD_Z : SALT_ROAD_X)) return null;
    const cell = VILLAGE.archCell;
    const centre = seg * cell + (cell >> 1);
    const here = cellOf(axis, k, centre, 0);
    if (cityInfluence(here.wx, here.wz) < VILLAGE.archMinCity) return null;
    if (roll(k, seg, axis === 'x' ? 8 : 4, SALT_ARCH) >= VILLAGE.archChance) return null;
    // Un arc se dresse en pleine rue, pas à un carrefour.
    const perp = axis === 'x' ? here.wx : here.wz;
    const near = Math.round(perp / VILLAGE.roadSpacing) * VILLAGE.roadSpacing;
    if (Math.abs(perp - near) < VILLAGE.archKeepout) return null;

    const t0 = centre - (ARCH_T >> 1);
    const t1 = t0 + ARCH_T - 1;
    const half = VILLAGE.archHalf;
    // Un arc planté dans les hauts-fonds n'a plus rien d'un monument : il se dresse
    // là où la rue se prend encore à pied.
    for (let o = -half; o <= half; o++) {
      const c = cellOf(axis, k, centre, o);
      if (noye(c.wx, c.wz)) return null;
    }
    // Fenêtre de nivellement large, réduite ensuite à ce qui doit vraiment être remblayé.
    const wLo = t0 - ARCH_SLOPE_MAX;
    const wHi = t1 + ARCH_SLOPE_MAX;
    // Assis sur un tablier, l'arc serait à moitié enterré : le pont a la priorité.
    if (bridgesOn(axis, k, wLo, wHi).length) return null;

    // Niveau de la rue, colonne par colonne, puis lissage : deux colonnes voisines ne
    // doivent pas se regarder avec plus d'un cube de dénivelé, sinon l'entrée du
    // passage devient un mur — le joueur ne franchit qu'un cube à la fois.
    const raw = new Map();
    const line = new Map();
    for (let i = wLo; i <= wHi; i++) {
      let h = -Infinity;
      for (let o = -half; o <= half; o++) {
        const c = cellOf(axis, k, i, o);
        h = Math.max(h, ground(c.wx, c.wz));
      }
      raw.set(i, h);
      const axe = cellOf(axis, k, i, 0);
      line.set(i, ground(axe.wx, axe.wz));
    }
    const lvl = new Map(raw);
    for (let pass = 0; pass < (wHi - wLo) + 2; pass++) {
      let moved = false;
      for (let i = wLo; i <= wHi; i++) {
        const want = Math.max(lvl.get(i), lvl.get(i - 1) - 1, lvl.get(i + 1) - 1);
        if (want > lvl.get(i)) { lvl.set(i, want); moved = true; }
      }
      if (!moved) break;
    }
    // L'emprise s'arrête dès que le remblai recoupe l'axe naturel de la rue, augmentée
    // d'une colonne tampon : sans cette rencontre franche, l'approche finit en ressaut
    // et l'avenue est coupée — mesuré le 2026-11-07, le joueur restait arrêté deux
    // cubes sous le niveau attendu devant l'arc. C'est bien l'axe que l'on compare, pas
    // le maximum transversal : un caniveau plus haut ne doit pas faire avancer l'ouvrage.
    let lo = t0;
    let hi = t1;
    while (lo > wLo && lvl.get(lo - 1) > line.get(lo - 1)) lo--;
    while (hi < wHi && lvl.get(hi + 1) > line.get(hi + 1)) hi++;
    lo = Math.max(wLo, lo - 1);
    hi = Math.min(wHi, hi + 1);
    // Le trim ne s'arrête que là où le remblai recoupe la rue naturelle. S'il bute au
    // bord de la fenêtre sans l'atteindre, l'approche finirait en ressaut : mieux vaut
    // aucun monument qu'une avenue coupée en deux par un mur de deux cubes.
    if (lvl.get(lo) > line.get(lo) || lvl.get(hi) > line.get(hi)) return null;

    let gMon = -Infinity;
    let lowest = Infinity;
    for (let i = t0; i <= t1; i++) gMon = Math.max(gMon, lvl.get(i));
    for (let i = lo; i <= hi; i++) lowest = Math.min(lowest, lvl.get(i));
    // Au-delà de six cubes de remblai, on élargirait la rue en digue : mieux vaut
    // aucun monument qu'une avenue coupée.
    if (gMon - lowest > 6 || gMon + VILLAGE.headroom + 5 >= CHUNK_HEIGHT) return null;
    if (doorwayConflict(axis, k, lo, hi, half)) return null;

    return {
      kind: 'arch', axis, k, seg, centre, t0, t1, lo, hi, half,
      levels: lvl, g: gMon, clear: VILLAGE.headroom,
      pier: pick([BLOCK.COBBLE, BLOCK.STONE, BLOCK.BRICK], centre, 7, k, SALT_ARCH),
      crown: BLOCK.STONE,
    };
  }

  /** Voirie sous le parvis, sous sa cour de `courtWidth`, ou sous le couloir d'approche du degré. */
  function templeTouchesRoute(ex, ez, half, door) {
    const pad = VILLAGE.courtWidth;
    for (let wx = ex - half - pad; wx <= ex + half + pad; wx++) {
      for (let wz = ez - half - pad; wz <= ez + half + pad; wz++) {
        if (roadKind(wx, wz)) return true;
      }
    }
    // Le degré ne déborde que dans le couloir de la porte : exiger une bande libre de
    // vingt-sept cubes de côté éliminait un site sur deux pour rien. La cour, elle, se
    // compte des quatre côtés du parvis — c'est ce qui empêche le monument de coller au
    // pavé comme une maison sans recul.
    const dir = TEMPLE_DIRS[door];
    const latX = -dir.dz;
    const latZ = dir.dx;
    for (let s = 1 - pad; s <= VILLAGE.templeSteps + 4 + VILLAGE.templeStairExtra + pad; s++) {
      for (let k = -VILLAGE.templeStairWidth - pad; k <= VILLAGE.templeStairWidth + pad; k++) {
        if (roadKind(ex + dir.dx * (half + s) + latX * k, ez + dir.dz * (half + s) + latZ * k)) return true;
      }
    }
    return false;
  }

  /**
   * Profil du degré, rangée par rangée du parvis vers l'extérieur : le niveau où se
   * tient le joueur. Le socle descend d'un cube par rangée ; là où le terrain naturel
   * remonte, c'est lui qui reprend l'escalier, à un cube près — la même règle que les
   * volées de la voirie. Renvoie null quand le terrain monte de plus d'un cube entre
   * deux colonnes : le monument serait adossé à un talus que personne ne franchit.
   * Chaque rangée porte le drapeau `poser` — inutile d'empierter là où le sol est déjà
   * au niveau, mais indispensable dès qu'une seule colonne de couloir manque à l'appel,
   * car le visiteur marche au centre et n'a que faire d'un voisin plus haut.
   */
  function profilDegre(ex, ez, half, door, socle) {
    const dir = TEMPLE_DIRS[door];
    const latX = -dir.dz;
    const latZ = dir.dx;
    const rangees = [];
    let niveau = socle + 1;                     // debout sur le parvis
    const nominal = VILLAGE.templeSteps + 4;
    const plafond = nominal + VILLAGE.templeStairExtra;
    for (let s = 1; s <= plafond; s++) {
      const hors = half + s;
      let haut = -Infinity;
      let bas = Infinity;
      for (let k = -VILLAGE.templeStairWidth; k <= VILLAGE.templeStairWidth; k++) {
        const g = ground(ex + dir.dx * hors + latX * k, ez + dir.dz * hors + latZ * k);
        if (g > haut) haut = g;
        if (g < bas) bas = g;
      }
      if (haut > niveau + 1) return null;       // talus : plus d'un cube par colonne
      niveau = Math.max(haut, niveau - 1);
      rangees.push({ hors, sommet: niveau - 1, poser: niveau > bas });
      // L'escalier a rejoint le pays : on s'arrête là. Au-delà du nombre nominal de rangées,
      // c'est que la pente fuit sous le monument et qu'une face verticale resterait à son
      // pied — un degré en tour de dix-huit cubes que personne ne gravit (mesure monde du
      // jeu, temple (-46,419) : dernière marche coiffée à trente-trois cubes alors que la
      // rue courait à quatorze). Plutôt que de renoncer au site, on rallonge la volée ;
      // si le pays dévale plus vite qu'un cube par rangée, il ne sera jamais rattrapé et
      // le monument ira se poser ailleurs.
      if (s >= nominal) {
        const sortie = half + s + 1;
        // Toute la largeur du couloir doit être atteignable, pas seulement sa colonne la
        // plus haute : le joueur descend au centre et buterait sur la marche si l'un de
        // ses côtés seulement rejoignait le sol.
        let basDehors = Infinity;
        for (let k = -VILLAGE.templeStairWidth; k <= VILLAGE.templeStairWidth; k++) {
          const g = ground(ex + dir.dx * sortie + latX * k, ez + dir.dz * sortie + latZ * k);
          if (g < basDehors) basDehors = g;
        }
        if (niveau - 1 <= basDehors + 1) return rangees;
      }
    }
    return null;
  }

  /**
   * Ce que le monument écrit vraiment : le parvis et le couloir du degré. L'emprise
   * élargie qui l'entoure n'est qu'un tampon pour la végétation ; y interdire aussi les
   * bâtiments vidait le cœur de ville, le temple occupant à lui seul une bonne part
   * d'une maille.
   */
  function templeGenant(wx, wz, t) {
    const dx = wx - t.ex;
    const dz = wz - t.ez;
    if (Math.abs(dx) <= t.half && Math.abs(dz) <= t.half) return true;
    const dir = TEMPLE_DIRS[t.door];
    const axial = dx * dir.dx + dz * dir.dz;
    const tangent = dx * -dir.dz + dz * dir.dx;
    return axial > t.half && axial <= t.half + (t.degre ? t.degre.length : VILLAGE.templeSteps + 4)
      && Math.abs(tangent) <= VILLAGE.templeStairWidth;
  }

  /** Une emprise de bâtiment gêne-t-elle la pierre posée d'un temple ? */
  function templeGenantSur(x0, z0, x1, z1) {
    for (const t of templesSur(x0, z0, x1, z1)) {
      if (x1 < t.bx0 || x0 > t.bx1 || z1 < t.bz0 || z0 > t.bz1) continue;
      for (let wx = x0; wx <= x1; wx++) {
        for (let wz = z0; wz <= z1; wz++) if (templeGenant(wx, wz, t)) return true;
      }
    }
    return false;
  }

  /**
   * Plan d'un temple, ou null si aucun site tenable ne tient dans la maille. Le monument
   * se pose sur un plateau naturel — jamais sur la voirie, jamais en pente : il est
   * estampé après routes et maisons, et un socle posé de travers présenterait au joueur
   * un mur qu'il ne franchit pas. L'emprise reste confinée dans sa maille, ce qui
   * garantit que deux temples ne se touchent jamais.
   */
  function computeTemple(i, j) {
    const cell = VILLAGE.templeCell;
    const half = VILLAGE.templeHalf;
    // Le degré et son approche débordent du parvis : le tirage de place doit les tenir
    // dans la maille, sinon l'emprise déborderait chez le voisin.
    const marge = half + VILLAGE.templeSteps + 4 + VILLAGE.templeStairExtra;
    if (roll(i, 1, j, SALT_TEMPLE) >= VILLAGE.templeChance) return null;
    const jeu = cell - 2 * marge;
    if (jeu < 4) return null;
    const baseX = i * cell + (cell >> 1);
    const baseZ = j * cell + (cell >> 1);
    // Pas de monument dans un très haut massif : la colonnade dorée sur un névé serait
    // un anachronisme, et le joueur n'y attend que des pierres nues.
    if (alpage(baseX, baseZ) >= VILLAGE.alpsWild) return null;
    // Un seul tirage ne suffisait pas : le relief réel est rarement plat à l'échelle du
    // monument (médiane mesurée : treize cubes d'écart sur la seule emprise), donc le
    // temple ne naissait que dans les plaines synthétiques des tests. On cherche un
    // plateau dans la maille, dans un ordre fixé par les tirages — jamais d'aléa, la
    // génération doit rester reproductible tronçon par tronçon.
    for (let e = 0; e < VILLAGE.templeTries; e++) {
      const ex = baseX + Math.floor((roll(i, 2, j, SALT_TEMPLE + e * 7) - 0.5) * jeu);
      const ez = baseZ + Math.floor((roll(i, 3, j, SALT_TEMPLE + e * 7) - 0.5) * jeu);
      const door = Math.floor(roll(i, 4, j, SALT_TEMPLE_DOOR + e * 7) * 4) % 4;
      if (templeTouchesRoute(ex, ez, half, door)) continue;

      let minH = Infinity;
      let maxH = -Infinity;
      let minNoyau = Infinity;
      const noyau = VILLAGE.templeCellaHalf + 2;   // naos et première colonnade
      for (let wx = ex - half; wx <= ex + half; wx++) {
        for (let wz = ez - half; wz <= ez + half; wz++) {
          const h = ground(wx, wz);
          if (h < minH) minH = h;
          if (h > maxH) maxH = h;
          if (Math.max(Math.abs(wx - ex), Math.abs(wz - ez)) <= noyau && h < minNoyau) minNoyau = h;
        }
      }
      // Deux exigences, pas une : le naos et la colonnade doivent reposer sur un sol de
      // niveau, mais le parvis peut descendre plus bas — ses murs de soutènement sont le
      // soubassement même du monument. Exiger les vingt-sept colonnes de plat ne faisait
      // plus apparaître un temple que tous les douze cents cubes.
      if (maxH - minNoyau > VILLAGE.templeMaxRelief) continue;
      if (maxH - minH > VILLAGE.templeMaxRelief + 4) continue;
      // Ni sur la grève, ni sur les sommets enneigés : les mêmes bornes que le village.
      if (minH < VILLAGE.minGround || maxH > VILLAGE.maxGround) continue;
      const socle = maxH + VILLAGE.templeSteps;
      // Le faîtage réel du comble en gradins, pas une estimation : un monument dont le
      // toit traverse le plafond du monde est amputé sans que personne s'en aperçoive.
      const faîte = socle + VILLAGE.templeHeight + 1
        + VILLAGE.templeRoofPitch * (VILLAGE.templeCellaHalf + 1);
      if (faîte + 1 >= CHUNK_HEIGHT) continue;
      const degre = profilDegre(ex, ez, half, door, socle);
      if (!degre) continue;                     // approche en talus : le visiteur n'entrerait pas

      return {
        kind: 'temple', i, j, ex, ez, half, marge, socle, sol: maxH, door, degre,
        // Pierre grise, verre et or : le monument doit se reconnaître de loin, alors
        // que ses murs empruntent la même pierre que les soubassements du village. Ce
        // qui le distingue n'est plus une couleur étrangère mais sa vitrerie, ses arches
        // et son faîtage doré — aucun bâtiment courant ne porte ni or ni telle emprise.
        wall: BLOCK.STONE, fill: BLOCK.STONE, roof: BLOCK.COBBLE, altar: BLOCK.GOLD,
        window: BLOCK.GLASS,
        bx0: ex - marge, bx1: ex + marge, bz0: ez - marge, bz1: ez + marge,
      };
    }
    return null;
  }

  const structCache = new Map();
  function cachedStruct(key, compute) {
    if (structCache.has(key)) return structCache.get(key);
    const v = compute();
    if (structCache.size > 8192) structCache.clear();
    structCache.set(key, v);
    return v;
  }
  const bridgeAt = (axis, k, seg) => cachedStruct(`b:${axis},${k},${seg}`, () => computeBridge(axis, k, seg));
  const archAt = (axis, k, seg) => cachedStruct(`a:${axis},${k},${seg}`, () => computeArch(axis, k, seg));
  const templeAt = (i, j) => cachedStruct(`t:${i},${j}`, () => computeTemple(i, j));

  /**
   * Temples dont l'emprise recoupe la fenêtre donnée. L'emprise comprend le parvis, le
   * degré et son approche ; elle reste confinée dans sa maille (le tirage de place la
   * laisse à `marge` des bords), donc parcourir les mailles de la fenêtre suffit.
   */
  function templesSur(x0, z0, x1, z1) {
    const cell = VILLAGE.templeCell;
    const out = [];
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) {
      for (let j = Math.floor(z0 / cell); j <= Math.floor(z1 / cell); j++) {
        const t = templeAt(i, j);
        if (t && t.bx1 >= x0 && t.bx0 <= x1 && t.bz1 >= z0 && t.bz0 <= z1) out.push(t);
      }
    }
    return out;
  }

  /** Ouvrages touchant un tronçon — sert à l'estampage comme aux tests. */
  function structuresAt(cx, cz) {
    const key = `${cx},${cz}`;
    if (structCache.has(key)) return structCache.get(key);
    const out = [];
    const alongBase = (axis) => (axis === 'x' ? cx * CHUNK_SIZE : cz * CHUNK_SIZE);
    const fixedBase = (axis) => (axis === 'x' ? cz * CHUNK_SIZE : cx * CHUNK_SIZE);
    const half = VILLAGE.roadHalf + VILLAGE.kerb;
    for (const axis of ['x', 'z']) {
      const along = alongBase(axis);
      const fixed = fixedBase(axis);
      const kLo = Math.ceil((fixed - half) / VILLAGE.roadSpacing);
      const kHi = Math.floor((fixed + CHUNK_SIZE - 1 + half) / VILLAGE.roadSpacing);
      for (let k = kLo; k <= kHi; k++) {
        const bCell = VILLAGE.bridgeCell;
        // La marge couvre le plus long des deux ouvrages : un viaduc sur l'eau porte sa
        // chaussée bien plus loin qu'un pont de creux (`waterMaxSpan` 90 contre
        // `bridgeMaxSpan` 30, et deux rampes de `waterMaxRamp`). Calée sur le seul pont
        // de creux, elle laissait hors fenêtre les extrémités d'un long tablier — le
        // tronçon voisin ne le visitait jamais et la chaussée s'interrompait en pleine
        // travée (mesuré le 2026-11-09 sur x−1@−4, tablier absent à (−191,−80)).
        const bPad = Math.ceil(Math.max(VILLAGE.bridgeMaxSpan, VILLAGE.waterMaxSpan) / 2)
          + Math.max(VILLAGE.bridgeMaxRamp, VILLAGE.waterMaxRamp) + 2;
        for (let seg = Math.floor((along - bPad - (bCell >> 1)) / bCell);
          seg <= Math.floor((along + CHUNK_SIZE - 1 + bPad - (bCell >> 1)) / bCell); seg++) {
          const b = bridgeAt(axis, k, seg);
          if (b && b.to >= along && b.from <= along + CHUNK_SIZE - 1) out.push(b);
        }
        const aCell = VILLAGE.archCell;
        const aPad = ARCH_T + ARCH_SLOPE_MAX;
        for (let seg = Math.floor((along - aPad - (aCell >> 1)) / aCell);
          seg <= Math.floor((along + CHUNK_SIZE - 1 + aPad - (aCell >> 1)) / aCell); seg++) {
          const a = archAt(axis, k, seg);
          if (a && a.t1 >= along && a.t0 <= along + CHUNK_SIZE - 1) out.push(a);
        }
      }
    }
    // Temples : l'emprise ne sort jamais de sa maille, la fenêtre du tronçon suffit.
    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;
    for (const t of templesSur(baseX, baseZ, baseX + CHUNK_SIZE - 1, baseZ + CHUNK_SIZE - 1)) out.push(t);
    // Statues : même promesse — la marge de leur maille tient le socle et son degré à
    // l'intérieur — mais l'ouvrage fait trente cubes de haut sur vingt d'envergure, donc
    // il recouvre plusieurs tronçons. Chacun visite la fenêtre et n'écrit que ses colonnes.
    for (const s of statuesSur(baseX, baseZ, baseX + CHUNK_SIZE - 1, baseZ + CHUNK_SIZE - 1)) out.push(s);
    if (structCache.size > 8192) structCache.clear();
    structCache.set(key, out);
    return out;
  }

  /**
   * Un tablier ne doit pas se terminer contre une avenue plus haute qu'il n'atteint :
   * la rue d'en face, conduite à un cube par colonne, présenterait au pied du pont un mur
   * de pavé que le marcheur ne franchit pas — mesuré le 2026-11-07, un tablier posé à 15
   * butait sept colonnes plus loin contre une croisée à 22. On renonce à l'ouvrage plutôt
   * que d'offrir une impasse : la voirie droite garde son escalier, le pont passe ailleurs.
   */
  function approcheCoupee(axis, k, from, to, deckY) {
    const W = VILLAGE.roadStepWindow;
    const portee = VILLAGE.roadHalf + VILLAGE.kerb;
    const autreAxis = axis === 'x' ? 'z' : 'x';
    const selAutre = axis === 'x' ? SALT_ROAD_X : SALT_ROAD_Z;
    const k0 = Math.floor((from - W - portee) / VILLAGE.roadSpacing);
    const k1 = Math.ceil((to + W + portee) / VILLAGE.roadSpacing);
    for (let kc = k0; kc <= k1; kc++) {
      if (!lineExists(kc, selAutre)) continue;
      const croisade = kc * VILLAGE.roadSpacing;   // colonne de notre axe où l'autre avenue nous coupe
      if (croisade >= from && croisade <= to) continue;  // prise sous le tablier : l'ouvrage a la main
      // Colonnes dont la rue dispose réellement pour rejoindre le niveau d'en face :
      // celles qui restent entre le bord de l'ouvrage et le premier cube où l'avenue
      // perpendiculaire fait déjà peser son propre niveau (chaussée + caniveau). Les
      // compter larges laissait passer un tablier s'arrêtant à trois colonnes d'une
      // croisée quatre cubes plus haut — le pavé y sautait de 19 à 22.
      const libre = croisade > to
        ? Math.max(0, (croisade - portee) - (to + 1))
        : Math.max(0, (from - 1) - (croisade + portee));
      // `n` : un ouvrage qui consulterait les ouvrages déjà posés de l'avenue d'en face
      // se ferait redemander les siens avant d'exister — la décision ne convergerait pas.
      const enFace = profilRue(autreAxis, kc, k * VILLAGE.roadSpacing, 'n');
      if (Math.abs(enFace - deckY) > libre) return true;
    }
    return false;
  }

  function stampStructures(data, cx, cz) {
    const list = structuresAt(cx, cz);
    if (!list.length) return 0;
    let placed = 0;
    for (const s of list) {
      if (s.kind === 'bridge') placed += stampBridge(data, cx, cz, s);
      else if (s.kind === 'temple') placed += stampTemple(data, cx, cz, s);
      else if (s.kind === 'statue') placed += stampStatue(data, cx, cz, s);
      else placed += stampArch(data, cx, cz, s);
    }
    return placed;
  }

  /** Écriture dans le tampon du tronçon, en ignorant ce qui tombe hors de celui-ci. */
  function chunkWriter(data, cx, cz) {
    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;
    const cells = CHUNK_SIZE * CHUNK_SIZE;
    return (wx, wz, y, id) => {
      const lx = wx - baseX;
      const lz = wz - baseZ;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) return;
      if (y < 0 || y >= CHUNK_HEIGHT) return;
      data[lx + lz * CHUNK_SIZE + y * cells] = id;
    };
  }

  /** Numéro de baie d'une colonne de tablier, compté depuis le début de la portée. */
  const bayOf = (ds, i) => {
    const every = VILLAGE.bridgePierEvery;
    return ((i - ds) % every + every) % every;
  };

  /** Colonne de travée pleine hauteur : ni pile (deux colonnes), ni tympan en bord de pile. */
  const isSoffitColumn = (ds, i) => {
    const bay = bayOf(ds, i);
    return bay >= 3 && bay <= VILLAGE.bridgePierEvery - 2;
  };

  /**
   * Une avenue perpendiculaire passe-t-elle sous cet ouvrage à la colonne donnée ? Là où
   * deux chaussées se croisent, la travée reste entièrement libre : l'épaule d'un arc
   * posée dans l'ouverture d'en face bornerait le passage de l'une ou de l'autre, et
   * comblerait le chenal que l'on juge sous la clé (mesuré le 2026-11-09 à (-315,80),
   * deux viaducs franchissant le même bras par-dessus la même travée).
   */
  function croiseeSousTablier(b, i) {
    const kc = Math.round(i / VILLAGE.roadSpacing);
    if (Math.abs(kc * VILLAGE.roadSpacing - i) > b.half) return false;
    return lineExists(kc, b.axis === 'x' ? SALT_ROAD_X : SALT_ROAD_Z);
  }

  /**
   * Dessous d'une colonne de tablier : `open` est la hauteur libre sous le tablier et
   * `intrados` le premier cube libre en partant du bas de l'ouverture (tout ce qui est
   * en dessous est comblé). Les piles sont pleines ; contre elles un tympan remonte à
   * trois quarts hauteur, ailleurs le soffite reste horizontal à `clearance` cubes du
   * tablier — la courbe d'un arc, sans jamais manger la place de passer dessous.
   */
  function bridgeUnderside(b, i) {
    const bay = bayOf(b.ds, i);
    if (bay < 2) return { pier: true, open: 0, intrados: b.deckY };
    if (b.surEau) {
      // À une croisée, la travée reste pleine : c'est le passage d'en face avant l'arc.
      if (croiseeSousTablier(b, i)) {
        return { pier: false, open: b.clearance, intrados: b.deckY - b.clearance };
      }
      // L'arc, pas le plafond. La travée s'évase depuis la naissance contre la pile
      // jusqu'à la clé battue au milieu de la portée : sous la clé l'ouverture reste
      // pleine — c'est par là que passe l'eau et que se juge le chenal — et ce sont les
      // naissances qui font lire un pont plutôt qu'un platelage sur pilotis. Demandé le
      // 2026-11-09 : « il faut des ponts avec des arches ».
      const nez = Math.min(bay - 2, VILLAGE.bridgePierEvery - 1 - bay);
      const portee = Math.max(1, (VILLAGE.bridgePierEvery - 4) >> 1);
      const rise = VILLAGE.waterArchRise
        - Math.round(VILLAGE.waterArchRise * Math.min(1, nez / portee));
      const open = Math.max(1, b.clearance - rise);
      return { pier: false, open, intrados: b.deckY - open };
    }
    const haunch = bay === 2 || bay === VILLAGE.bridgePierEvery - 1;
    // Le tympan ne descend qu'**un** cube sous le soffite : à trois quarts de la
    // hauteur libre, la différence faisait deux cubes d'un coup pour qui marche sous
    // l'arche, et le joueur butait contre la naissance de la courbe.
    const open = haunch ? Math.max(1, b.clearance - 1) : b.clearance;
    return { pier: false, open, intrados: b.deckY - open };
  }

  /** Chaussée surélevée : revêtement, remblai sous le tablier, piles et arcs. */
  function stampBridge(data, cx, cz, b) {
    const put = chunkWriter(data, cx, cz);
    const cols = [];
    for (let i = b.ds; i <= b.de; i++) cols.push({ i, s: b.deckY, deck: true });
    for (const [i, s] of b.ramp) cols.push({ i, s, deck: false });
    for (const col of cols) {
      for (let o = -b.half; o <= b.half; o++) {
        const c = cellOf(b.axis, b.k, col.i, o);
        const kind = roadKind(c.wx, c.wz);
        if (!kind) continue;   // l'ouvrage ne déborde jamais de la voirie
        const surface = sousRue(c.wx, c.wz, b.axis);
        put(c.wx, c.wz, col.s, kind === 'bed' ? BLOCK.GRIT : BLOCK.COBBLE);
        // Ni souche ni feuillage sur le tablier, et la tête du joueur a sa place.
        for (let y = col.s + 1; y <= Math.min(CHUNK_HEIGHT - 1, col.s + VILLAGE.headroom); y++) {
          put(c.wx, c.wz, y, BLOCK.AIR);
        }
        if (col.s <= surface) continue;
        if (!col.deck) {
          for (let y = surface + 1; y < col.s; y++) put(c.wx, c.wz, y, b.mat);
          continue;
        }
        // Piles descendues jusqu'au sol, travée évidée entre elles : c'est la lecture
        // « pont », pas un mur de soutènement.
        const { pier, intrados } = bridgeUnderside(b, col.i);
        if (b.surEau) {
          // Les piles descendent jusqu'au lit ; entre elles, l'arc. **Rien n'est posé à
          // ou sous le plan d'eau** : boucher la travée ferait une digue qui coupe le
          // cours en amont. Les naissances ne descendent donc que de `waterArchRise`
          // cubes sous le soffite, et jamais au-dessous de la flottaison. Le cube de
          // soffite prend la pierre contraire au remplissage : l'anneau de voussoirs est
          // ce qui dessine la courbe pour qui regarde le pont par dessous.
          if (pier) {
            for (let y = surface + 1; y < b.deckY; y++) put(c.wx, c.wz, y, b.mat);
          } else {
            const seuil = Math.max(surface + 1, b.floorH + 1);
            const anneau = b.mat === BLOCK.STONE ? BLOCK.COBBLE : BLOCK.STONE;
            for (let y = seuil; y < intrados; y++) put(c.wx, c.wz, y, b.mat);
            if (intrados - 1 >= seuil) put(c.wx, c.wz, intrados - 1, anneau);
          }
        } else {
          for (let y = surface + 1; y < b.deckY; y++) {
            put(c.wx, c.wz, y, (pier || y < intrados) ? b.mat : BLOCK.AIR);
          }
        }
        if (Math.abs(o) === b.half && b.deckY - surface >= 2) put(c.wx, c.wz, b.deckY + 1, BLOCK.COBBLE);
      }
    }
    return cols.length;
  }

  /** Arc de triomphe : socle commun, passage libre, épaules cintrées, couronnement. */
  function stampArch(data, cx, cz, a) {
    const put = chunkWriter(data, cx, cz);
    for (let i = a.lo; i <= a.hi; i++) {
      const s = a.levels.get(i);
      const inside = i >= a.t0 && i <= a.t1;
      for (let o = -a.half; o <= a.half; o++) {
        const c = cellOf(a.axis, a.k, i, o);
        const kind = roadKind(c.wx, c.wz);
        if (!kind) continue;
        const surface = sousRue(c.wx, c.wz, a.axis);
        const ao = Math.abs(o);
        // Socle comblé jusqu'au niveau de la rue : l'ouvrage ne flotte pas au-dessus
        // d'un décroché, et le passage reste de plain-pied avec ses approches.
        for (let y = Math.min(surface, s); y <= s; y++) put(c.wx, c.wz, y, a.pier);
        put(c.wx, c.wz, s, kind === 'bed' ? BLOCK.GRIT : BLOCK.COBBLE);
        if (!inside) {
          // Approches : uniquement la chaussée remise à niveau.
          for (let y = s + 1; y <= Math.min(CHUNK_HEIGHT - 1, s + VILLAGE.headroom); y++) put(c.wx, c.wz, y, BLOCK.AIR);
          continue;
        }
        const spring = a.g + a.clear;
        if (ao <= VILLAGE.archPassage) {
          for (let y = s + 1; y <= spring; y++) put(c.wx, c.wz, y, BLOCK.AIR);
        } else if (ao === VILLAGE.archPassage + 1) {
          // Épaule : pleine jusqu'au cintré, évidée au-dessus — c'est ce qui donne sa
          // courbe à l'ouverture vue de la rue.
          for (let y = s + 1; y <= s + VILLAGE.archShoulder; y++) put(c.wx, c.wz, y, a.pier);
          for (let y = s + VILLAGE.archShoulder + 1; y <= spring; y++) put(c.wx, c.wz, y, BLOCK.AIR);
        } else {
          for (let y = s + 1; y <= spring; y++) put(c.wx, c.wz, y, a.pier);
        }
        for (let y = spring + 1; y <= spring + 2; y++) put(c.wx, c.wz, y, a.crown);
        if (ao <= 2) put(c.wx, c.wz, spring + 3, a.pier);
        if (o === 0) put(c.wx, c.wz, spring + 4, a.pier);
      }
    }
    return ARCH_T;
  }

  /**
   * Parvis, degré, colonnade, naos et comble. Tout part du terrain naturel : le socle
   * est comblé sous les dalles, le degré ne prend qu'un cube par colonne jusqu'à
   * raccordement franc avec le chemin — le joueur ne franchit qu'un cube à la fois —
   * et la porte s'ouvre du côté du degré, de plain-pied avec le parvis.
   */
  function stampTemple(data, cx, cz, t) {
    const put = chunkWriter(data, cx, cz);
    const dir = TEMPLE_DIRS[t.door];
    const latX = -dir.dz;
    const latZ = dir.dx;
    let ecrits = 0;
    // La pierre se patine du côté opposé au degré : une façade toute neuve se lirait
    // comme un chantier, pas comme un monument. Sur le marbre, la mousse doit rester
    // rare, sinon le monument entier verdit et perd sa lecture de loin.
    const pierre = (wx, wz, y, id) => {
      const ombre = (wx - t.ex) * dir.dx + (wz - t.ez) * dir.dz <= -2;
      put(wx, wz, y, ombre && roll(wx, y, wz, SALT_TEMPLE) < 0.1 ? BLOCK.MOSS : id);
      ecrits++;
    };
    const dalle = (wx, wz, sommet) => {
      const g = ground(wx, wz);
      for (let y = g; y < sommet; y++) put(wx, wz, y, t.fill);
      pierre(wx, wz, sommet, t.wall);
      // Ni souche ni branche sur les dalles, et la tête du joueur garde sa place.
      for (let y = sommet + 1; y <= Math.min(CHUNK_HEIGHT - 1, sommet + VILLAGE.headroom); y++) {
        put(wx, wz, y, BLOCK.AIR);
      }
    };

    // 1. Parvis.
    for (let wx = t.ex - t.half; wx <= t.ex + t.half; wx++) {
      for (let wz = t.ez - t.half; wz <= t.ez + t.half; wz++) dalle(wx, wz, t.socle);
    }

    // 2. Degré : le profil a été calculé à la sélection du site — un cube de reprise par
    //    colonne, jamais plus, quitte à rattraper le terrain naturel par une terrasse.
    for (const r of t.degre) {
      if (!r.poser) continue;                    // le sol est déjà au niveau
      for (let k = -VILLAGE.templeStairWidth; k <= VILLAGE.templeStairWidth; k++) {
        dalle(t.ex + dir.dx * r.hors + latX * k, t.ez + dir.dz * r.hors + latZ * k, r.sommet);
      }
    }

    const haut = t.socle + VILLAGE.templeHeight;
    const R = t.half - 1;
    const pas = VILLAGE.templeColumnPitch;

    // 3. Galerie à colonnes, reliées d'arches, sous une architrave continue.
    //    Le pas se compte **le long de la face**, non sur la coordonnée absolue : calé
    //    sur celle-ci, un rayon multiple du pas faisait coïncider toutes les positions
    //    d'une même face et la galerie s'estampait en mur continu — plus un seul fût
    //    lisible, donc plus de périptère du tout.
    //    Entre deux fûts, l'arche se lit en deux assises : l'archivolte pleine à `haut`
    //    et la clé qui plonge d'un cube au milieu de la travée. Rien ne descend plus
    //    bas : le visiteur doit circuler debout sous la galerie (VILLAGE.headroom).
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== R) continue;
        const axial = dx * dir.dx + dz * dir.dz;
        const tangent = dx * latX + dz * latZ;
        // L'axe du degré reste libre : sans cette exception, une colonne se dresserait
        // dans l'alignement exact de la porte et boucherait l'approche.
        if (axial === R && Math.abs(tangent) <= 1) continue;
        const rang = R + Math.abs(tangent);       // symétrique de part et d'autre de l'axe
        if (Math.abs(dx) === Math.abs(dz) || rang % pas === 0) {
          for (let y = t.socle + 1; y <= haut; y++) pierre(t.ex + dx, t.ez + dz, y, t.wall);
        } else {
          pierre(t.ex + dx, t.ez + dz, haut, t.wall);
          if (rang % pas === pas - 1) pierre(t.ex + dx, t.ez + dz, haut - 1, t.wall);
        }
        put(t.ex + dx, t.ez + dz, haut + 1, t.wall);
        ecrits++;
      }
    }

    // 4. Naos : salle close de sept cubes de côté, porte d'un cube sur trois dans l'axe
    //    du degré, plafond à hauteur debout complète.
    const C = VILLAGE.templeCellaHalf;
    for (let dx = -C; dx <= C; dx++) {
      for (let dz = -C; dz <= C; dz++) {
        const bord = Math.max(Math.abs(dx), Math.abs(dz)) === C;
        const axial = dx * dir.dx + dz * dir.dz;
        const tangent = dx * latX + dz * latZ;
        const baie = bord && axial === C && tangent === 0;
        // Arc de la porte : la baie s'élargit d'une colonne de chaque côté sur deux
        // cubes, la clé du linteau restant pleine au-dessus du passage central.
        const piedDroit = bord && axial === C && Math.abs(tangent) === 1;
        // Vitres : une colonne sur deux du mur, au-dessus des trois cubes de socle et
        // sous la corniche. Une salle close de pierre ne se lisait pas comme un
        // sanctuaire, et le jour n'y entrait par aucune ouverture.
        const vitree = bord && !baie && !piedDroit && Math.abs(tangent) % 2 === 1;
        for (let y = t.socle + 1; y <= haut; y++) {
          if (baie && y <= t.socle + 3) { put(t.ex + dx, t.ez + dz, y, BLOCK.AIR); continue; }
          if (piedDroit && y <= t.socle + 2) { put(t.ex + dx, t.ez + dz, y, BLOCK.AIR); continue; }
          if (bord) pierre(t.ex + dx, t.ez + dz, y,
            vitree && y >= t.socle + 4 && y <= haut - 1 ? t.window : t.wall);
          else put(t.ex + dx, t.ez + dz, y, BLOCK.AIR);
        }
      }
    }

    // 5. Comble : dalle portant sur les murs du naos, puis gradins jusqu'à l'arête,
    //    dorée — c'est le repère que l'on cherche au-dessus des toits du village.
    for (let dx = -(C + 1); dx <= C + 1; dx++) {
      for (let dz = -(C + 1); dz <= C + 1; dz++) { put(t.ex + dx, t.ez + dz, haut + 1, t.roof); ecrits++; }
    }
    let yToit = haut + 1 + VILLAGE.templeRoofPitch;
    for (let r = C; r >= 0; r--) {
      const faîtage = r === 0 ? BLOCK.GOLD : t.roof;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) { put(t.ex + dx, t.ez + dz, yToit, faîtage); ecrits++; }
      }
      yToit += VILLAGE.templeRoofPitch;
    }

    // 6. Autel : le seul rehaut sombre du monument, pour qu'on sache où l'on va.
    put(t.ex, t.ez, t.socle + 1, t.fill);
    put(t.ex, t.ez, t.socle + 2, t.altar);

    // Le trait de la cour du monument : la même assise à plat que devant les maisons,
    // autour du parvis et du couloir du degré. Là où le trait rencontrerait une marche ou
    // une dalle du temple, `templeStone` le refuse et le terrain garde sa pierre.
    const limites = [[t.ex - t.half, t.ez - t.half, t.ex + t.half, t.ez + t.half]];
    if (t.degre && t.degre.length) {
      let lx0 = Infinity, lz0 = Infinity, lx1 = -Infinity, lz1 = -Infinity;
      for (const r of t.degre) {
        for (let k = -VILLAGE.templeStairWidth; k <= VILLAGE.templeStairWidth; k++) {
          const wx = t.ex + dir.dx * r.hors + latX * k;
          const wz = t.ez + dir.dz * r.hors + latZ * k;
          lx0 = Math.min(lx0, wx); lz0 = Math.min(lz0, wz);
          lx1 = Math.max(lx1, wx); lz1 = Math.max(lz1, wz);
        }
      }
      limites.push([lx0, lz0, lx1, lz1]);
    }
    traitDeCour(data, cx, cz, limites);
    return ecrits + 2;
  }

  /** True si la colonne est prise par une route ou par l'emprise d'un bâtiment. */
  function isOccupied(wx, wz) {
    if (roadKind(wx, wz)) return true;
    if (templesSur(wx, wz, wx, wz).length) return true;
    if (statueStone(wx, wz)) return true;
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    const lx = wx - cx * CHUNK_SIZE;
    const lz = wz - cz * CHUNK_SIZE;
    return buildingAt(cx, cz).some((plan) =>
      lx >= plan.x0 && lx < plan.x0 + plan.w && lz >= plan.z0 && lz < plan.z0 + plan.d);
  }

  /**
   * True si rien ne doit pousser sur cette colonne : la voirie, le monument, l'emprise
   * d'un bâtiment — ou la cour de `courtWidth` cubes qui le ceinture. Une feuille est
   * solide dans ce jeu ; un arbre planté dans la cour murait le passage dont le joueur
   * a besoin pour tourner autour du bâtiment et joindre sa porte.
   */
  function blocksVegetation(wx, wz) {
    if (isOccupied(wx, wz)) return true;
    const pad = VILLAGE.courtWidth;
    // Le colosse garde autour de lui une réserve de perspective plus large qu'une cour de
    // maison : un tronc planté à deux cubes d'un piédestal de trente cubes le mange, et la
    // feuille est solide — le tour du monument cesserait d'être praticable.
    const sp = VILLAGE.statuePad;
    for (const s of statuesSur(wx - sp, wz - sp, wx + sp, wz + sp)) {
      const dir = TEMPLE_DIRS[s.door];
      const axial = (wx - s.ex) * dir.dx + (wz - s.ez) * dir.dz;
      const tangent = (wx - s.ex) * -dir.dz + (wz - s.ez) * dir.dx;
      const avant = axial >= 0 ? s.hzAvant : s.hzArriere;
      if (Math.abs(axial) <= avant + sp && Math.abs(tangent) <= s.hx + sp) return true;
      // Le couloir du degré se tient nu lui aussi : des marches ourlées de buissons ne se
      // franchissent pas, la feuille étant solide dans ce jeu.
      if (axial > avant && axial <= avant + (s.degre ? s.degre.length : s.plinthH + 2) + sp
        && Math.abs(tangent) <= VILLAGE.statueStairWidth + sp) return true;
    }
    const c0 = Math.floor((wx - pad) / CHUNK_SIZE);
    const c1 = Math.floor((wx + pad) / CHUNK_SIZE);
    const r0 = Math.floor((wz - pad) / CHUNK_SIZE);
    const r1 = Math.floor((wz + pad) / CHUNK_SIZE);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = r0; cz <= r1; cz++) {
        const bx = cx * CHUNK_SIZE;
        const bz = cz * CHUNK_SIZE;
        if (buildingAt(cx, cz).some((p) => wx >= p.x0 + bx - pad && wx < p.x0 + bx + p.w + pad
          && wz >= p.z0 + bz - pad && wz < p.z0 + bz + p.d + pad)) return true;
      }
    }
    return false;
  }

  /**
   * True si la colonne est prise par la pierre posée d'un temple — parvis, murs ou couloir
   * du degré, à l'exclusion du tampon de végétation qui l'entoure. C'est l'équivalent, pour
   * le monument, de l'emprise d'une maison : ce que la cour d'un voisin ne doit pas toucher.
   */
  function templeStone(wx, wz) {
    return templesSur(wx, wz, wx, wz).some((t) => templeGenant(wx, wz, t));
  }

  // ---- statues monumentales -------------------------------------------------
  /**
   * Quatre colosses de pierre plantés dans les villes : un homme, un éléphant, un
   * cheval, un aigle. Demandé le 2026-11-09 — « je voudrais que tu ajoute de tres grande
   * status dans les villes , des status a forme humaine , d'elephant de cheval et d'aigle »,
   * arbitré en « ~30 cubes, une par ville, pierre patinée ».
   *
   * Une statue n'est pas un bâtiment : elle ne porte ni plancher, ni toit, ni porte, et
   * personne n'y entre. Elle n'est donc pas un plan de parcelle mais un **ouvrage**, comme
   * le temple — estampé après voirie et maisons, sur un plateau naturel qu'elle ne modifie
   * pas. Ce qu'elle emprunte au temple : l'emprise confinée dans sa maille (deux colosses
   * ne se touchent jamais), le degré à un cube par colonne, le refus du massif sauvage. Ce
   * qui l'en distingue : elle se tient debout sur un socle, et sa silhouette doit se lire
   * sans la connaître — c'est la forme, pas la couleur, qui dit « éléphant ».
   */

  /** Corps de statue : un solide algébrique dans l'espace local (x latéral, y haut, z avant). */
  function plein(p, x, y, z) {
    const dx = x - p.cx;
    const dz = z - p.cz;
    const dy = y - p.cy;
    if (p.t === 'b') return Math.abs(dx) <= p.hx && Math.abs(dy) <= p.hy && Math.abs(dz) <= p.hz;
    if (p.t === 'v') return dx * dx + dz * dz <= p.r * p.r && y >= p.y0 && y <= p.y1;
    return (dx * dx) / (p.rx * p.rx) + (dy * dy) / (p.ry * p.ry) + (dz * dz) / (p.rz * p.rz) <= 1;
  }

  const ELL = (cx, cy, cz, rx, ry, rz) => ({ t: 'e', cx, cy, cz, rx, ry, rz });
  const BOI = (cx, cy, cz, hx, hy, hz) => ({ t: 'b', cx, cy, cz, hx, hy, hz });
  const POT = (cx, cz, y0, y1, r) => ({ t: 'v', cx, cz, y0, y1, r, cy: (y0 + y1) / 2 });

  /** Sphères le long d'un segment : ce qui fait une trompe, une encolure, une aile. */
  function membres(ax, ay, az, bx, by, bz, ra, rb) {
    const out = [];
    const d = Math.hypot(bx - ax, by - ay, bz - az);
    const n = Math.max(1, Math.round(d / 0.45));
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const r = ra + (rb - ra) * u;
      out.push(ELL(ax + (bx - ax) * u, ay + (by - ay) * u, az + (bz - az) * u, r, r, r));
    }
    return out;
  }

  /** Suite de segments joints par des sphères : une ligne brisée charnue. */
  function trait(points, rayons) {
    const out = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      out.push(...membres(a[0], a[1], a[2], b[0], b[1], b[2], rayons[i], rayons[i + 1]));
    }
    return out;
  }

  /**
   * Les quatre formes, en unités de statue (y part des pieds, z regarde devant). Elles ne
   * sont pas dessinées au jugé sur la grille : chaque forme est un **gabarit proportionné**
   * que l'on met ensuite à l'échelle. Un même tracé à l'échelle près doit se reconnaître à
   * la fois en petit et en très grand, sinon on ne sculpte pas un animal, on sculpte un tas.
   *
   * Chaque gabarit répond aux trois questions qui distinguent les quatre : sur combien de
   * pieds tient-il, d'où pend sa trompe ou sa queue, et où est son point le plus haut.
   */
  const FORMES = {
    humain() {
      const P = [
        // Jambes écartées : à ±0,95 avec un rayon de 0,78, les deux cylindres se touchaient
        // sur la colonne médiane après mise à l'échelle et le colosse portait une robe.
        POT(-1.2, 0, 0, 4.1, 0.7), POT(1.2, 0, 0, 4.1, 0.7),         // jambes
        BOI(0, 4.5, 0, 1.95, 0.6, 0.95),                             // hanches
        ELL(0, 6.0, 0, 1.65, 1.75, 1.05),                            // buste
        BOI(0, 7.35, 0, 2.0, 0.45, 0.95),                            // épaules
        POT(-2.15, 0, 4.7, 7.2, 0.55),                                // bras le long du corps
        ELL(-2.15, 4.5, 0, 0.6, 0.6, 0.6),
        POT(0, 0, 7.6, 8.2, 0.6),                                     // cou
        ELL(0, 8.85, 0, 0.95, 1.05, 1.0),                             // tête
      ];
      // Le bras droit levé : sans ce geste, la silhouette était celle d'un bonhomme de
      // neige — deux bâtons de part et d'autre d'un ovale. Le salut se lit de trois cents
      // cubes, il fait aussi comprendre à quel côté regarder.
      P.push(...trait([[2.05, 7.1, 0], [2.4, 8.4, -0.05], [2.6, 9.3, -0.1]], [0.55, 0.5, 0.45]));
      P.push(ELL(2.65, 9.55, -0.1, 0.6, 0.6, 0.6));                  // poing fermé
      return P;
    },
    elephant() {
      const P = [
        POT(-1.5, -2.4, 0, 4.0, 1.05), POT(1.5, -2.4, 0, 4.0, 1.05),
        POT(-1.5, 2.4, 0, 4.0, 1.05), POT(1.5, 2.4, 0, 4.0, 1.05),
        ELL(0, 5.7, -0.7, 2.55, 2.35, 3.5),                           // tonneau
        ELL(0, 5.5, 3.5, 1.85, 1.85, 1.75),                            // crâne
        ELL(-2.15, 5.9, 3.3, 0.45, 1.7, 1.45), ELL(2.15, 5.9, 3.3, 0.45, 1.7, 1.45), // oreilles
      ];
      // La trompe descend **devant les pattes de devant et sous la tête** : c'est le seul
      // signe qui ne se confonde avec rien d'autre. Une trompe qui resterait collée à la
      // face avant du crâne faisait un rhinocéros.
      P.push(...trait([[0, 4.7, 4.6], [0, 3.4, 5.6], [0, 2.0, 6.0], [0, 1.3, 6.6]],
        [0.85, 0.7, 0.55, 0.4]));
      P.push(...trait([[0.75, 3.6, 4.9], [0.95, 2.8, 5.7]], [0.32, 0.18]));   // défenses
      P.push(...trait([[-0.75, 3.6, 4.9], [-0.95, 2.8, 5.7]], [0.32, 0.18]));
      P.push(...trait([[0, 6.6, -4.0], [0, 4.6, -4.7]], [0.35, 0.2]));        // queue
      return P;
    },
    cheval() {
      const P = [
        POT(-1.05, -2.6, 0, 4.3, 0.62), POT(1.05, -2.6, 0, 4.3, 0.62),
        POT(-1.05, 2.6, 0, 4.3, 0.62), POT(1.05, 2.6, 0, 4.3, 0.62),
        ELL(0, 5.4, 0, 1.45, 1.7, 3.0),                                // flancs
        ELL(0, 5.5, 2.0, 1.5, 1.75, 1.5),                              // poitrail
        ELL(0, 5.7, -2.2, 1.55, 1.8, 1.5),                             // croupe
      ];
      // L'encolure monte en diagonale vers l'avant : posée horizontale, l'animal avait
      // deux têtes, une à chaque bout du tonneau. La crinière court derrière l'arête,
      // sinon le galop ne se lit plus dans le profil.
      P.push(...trait([[0, 6.1, 2.5], [0, 7.4, 3.4], [0, 8.5, 4.1]], [1.15, 1.0, 0.85]));
      P.push(...trait([[0, 6.7, 2.1], [0, 8.0, 3.1], [0, 9.2, 3.9]], [0.5, 0.45, 0.4]));
      P.push(ELL(0, 9.0, 4.8, 0.62, 0.78, 1.4));                       // tête
      P.push(BOI(0, 8.75, 5.95, 0.5, 0.5, 0.65));                       // museau
      P.push(ELL(-0.32, 9.75, 4.4, 0.22, 0.42, 0.22), ELL(0.32, 9.75, 4.4, 0.22, 0.42, 0.22));
      P.push(...trait([[0, 6.5, -3.3], [0, 5.0, -4.2], [0, 3.5, -4.6]], [0.5, 0.4, 0.25]));
      return P;
    },
    aigle() {
      const P = [
        ELL(0, 0.7, 0, 1.9, 0.9, 1.9), ELL(0, 1.6, 0.2, 1.2, 0.8, 1.2), // rocher-perchoir
        POT(-0.75, 0.9, 1.3, 2.3, 0.35), POT(0.75, 0.9, 1.3, 2.3, 0.35), // talons
        ELL(0, 3.6, 0, 1.45, 1.9, 2.45),                                 // poitrine
        ELL(0, 3.2, 1.3, 1.15, 1.35, 1.1),
        BOI(0, 2.85, -3.4, 1.15, 0.3, 1.15), ELL(0, 2.7, -4.3, 0.95, 0.28, 0.7), // queue
        ...trait([[0, 4.6, 0.9], [0, 5.6, 1.5]], [0.85, 0.7]),            // cou
        ELL(0, 6.25, 1.75, 0.8, 0.85, 0.9),                               // tête
        BOI(0, 6.05, 2.8, 0.3, 0.3, 0.55),                                 // bec
      ];
      // Les ailes montent en éventail et retombent à la pointe : cinq segments de même
      // épaisseur donnaient une échelle, et une aile horizontale faisait un poisson. La
      // retombée du dernier segment est ce qui ferme la silhouette en vol.
      for (const s of [-1, 1]) {
        const pts = [];
        const rs = [];
        for (let i = 0; i <= 5; i++) {
          pts.push([s * (1.5 + i * 0.95), 4.4 + 0.85 * i - (i === 5 ? 1.5 : 0), 0.1 - 0.15 * i]);
          rs.push(0.62 - 0.05 * i);
        }
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const chord = 1.5 - 0.18 * i;
          const n = 3;
          for (let k = 0; k <= n; k++) {
            const u = k / n;
            P.push(ELL(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u,
              a[2] + (b[2] - a[2]) * u, rs[i], 0.3, chord));
          }
        }
      }
      return P;
    },
  };
  const ORDRE_FORMES = ['humain', 'elephant', 'cheval', 'aigle'];

  /** Emprise d'un gabarit : ce que la mise à l'échelle devra tenir dans la maille. */
  function carter(solides) {
    let xa = Infinity, xb = -Infinity, ya = Infinity, yb = -Infinity, za = Infinity, zb = -Infinity;
    for (const p of solides) {
      const ex = p.t === 'b' ? p.hx : p.t === 'v' ? p.r : p.rx;
      const ey = p.t === 'b' ? p.hy : p.t === 'v' ? (p.y1 - p.y0) / 2 : p.ry;
      const ez = p.t === 'b' ? p.hz : p.t === 'v' ? p.r : p.rz;
      const yc = p.t === 'v' ? (p.y0 + p.y1) / 2 : p.cy;
      xa = Math.min(xa, p.cx - ex); xb = Math.max(xb, p.cx + ex);
      ya = Math.min(ya, yc - ey); yb = Math.max(yb, yc + ey);
      za = Math.min(za, p.cz - ez); zb = Math.max(zb, p.cz + ez);
    }
    return { xa, xb, ya, yb, za, zb, haut: yb, envergure: xb - xa, longueur: zb - za };
  }

  const CARTE_FORMES = new Map();
  function carteDe(forme) {
    if (!CARTE_FORMES.has(forme)) {
      const solides = FORMES[forme]();
      CARTE_FORMES.set(forme, { solides, carte: carter(solides) });
    }
    return CARTE_FORMES.get(forme);
  }

  /**
   * Mise à l'échelle. Deux bornes, pas une : la hauteur visée **et** l'encombrement au
   * sol. Sans la seconde, l'aigle — dont l'envergure fait presque deux fois sa hauteur —
   * aurait mesuré cinquante cubes d'une serre à l'autre pour atteindre les trente cubes
   * demandés, et son socle aurait mangé la place du quartier.
   */
  function echelleDe(carte) {
    return Math.min(VILLAGE.statueHeight / carte.haut,
      VILLAGE.statueSpan / carte.envergure, VILLAGE.statueSpan / carte.longueur);
  }

  /**
   * Voxélisation du gabarit, une seule fois par statue : la grille locale est petite
   * (quelques milliers de cellules) et l'estampage relit le même plan pour chacun des
   * tronçons que l'ouvrage recouvre.
   */
  function masqueDe(s) {
    if (s.masque) return s.masque;
    const { solides } = carteDe(s.forme);
    const nx = 2 * s.hx + 1;
    const ny = s.corpsHaut + 1;
    // La grille couvre l'avant ET l'arrière : la trompe et le museau pendront d'un côté,
    // la queue de l'autre. Une grille carrée calée sur la plus grande portée eût noyé la
    // moitié du masque dans le vide.
    const nz = s.hzAvant + s.hzArriere + 1;
    const m = new Uint8Array(nx * ny * nz);
    for (let ix = 0; ix < nx; ix++) {
      const x = (ix - s.hx + 0.5) / s.ech;
      for (let iz = 0; iz < nz; iz++) {
        const z = (iz - s.hzArriere + 0.5) / s.ech;
        for (let iy = 0; iy < ny; iy++) {
          const y = (iy + 0.5) / s.ech;
          for (const p of solides) {
            if (plein(p, x, y, z)) { m[ix + iz * nx + iy * nx * nz] = 1; break; }
          }
        }
      }
    }
    s.masque = { m, nx, ny, nz };
    return s.masque;
  }

  /**
   * L'emprise d'une statue ramenée dans le repère **du monde**. Le gabarit est dessiné en
   * local (x latéral, z avant) puis tourné de la face tirée : juger le site — ou couler le
   * socle — dans le rectangle non tourné, c'est poser la table de travers sous un éléphant
   * de dix-huit cubes de long sur sept de large, et laisser l'avenue passer sous sa trompe.
   * La rotation n'ayant que quatre états, les quatre coins suffisent à borner le rectangle.
   */
  function empreinteDe(ex, ez, door, demi, axialNeg, axialPos, pad) {
    const dir = TEMPLE_DIRS[door];
    const latX = -dir.dz;
    const latZ = dir.dx;
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const lz of [axialNeg - pad, axialPos + pad]) {
      for (const lx of [-demi - pad, demi + pad]) {
        const wx = ex + dir.dx * lz + latX * lx;
        const wz = ez + dir.dz * lz + latZ * lx;
        if (wx < x0) x0 = wx;
        if (wx > x1) x1 = wx;
        if (wz < z0) z0 = wz;
        if (wz > z1) z1 = wz;
      }
    }
    return { x0, z0, x1, z1 };
  }

  /** Colonne du degré : un cube de reprise par rangée, comme au temple. */
  function degreDe(s) {
    const dir = TEMPLE_DIRS[s.door];
    const rangees = [];
    let niveau = s.socle + 1;                   // debout sur l'arête du socle
    const nominal = s.plinthH + 2;
    const plafond = nominal + VILLAGE.statueStairExtra;
    for (let hors = 1; hors <= plafond; hors++) {
      const axial = s.hzAvant + hors;
      let haut = -Infinity;
      let bas = Infinity;
      for (let k = -VILLAGE.statueStairWidth; k <= VILLAGE.statueStairWidth; k++) {
        const g = ground(s.ex + dir.dx * axial + -dir.dz * k, s.ez + dir.dz * axial + dir.dx * k);
        if (g > haut) haut = g;
        if (g < bas) bas = g;
      }
      if (haut > niveau + 1) return null;       // talus : le visiteur n'entrerait pas
      niveau = Math.max(haut, niveau - 1);
      rangees.push({ axial, sommet: niveau - 1, poser: niveau > bas });
      // Même règle qu'au temple (`profilDegre`) : la volée s'allonge tant que le pays lui
      // échappe, et le colosse renonce à la place si la pente dévale plus vite qu'un cube
      // par rangée — sinon il resterait au haut d'une tour sans abord.
      if (hors >= nominal) {
        const sortie = s.hzAvant + hors + 1;
        // Toute la largeur du couloir, pas seulement sa colonne la plus haute : le visiteur
        // descend au centre.
        let basDehors = Infinity;
        for (let k = -VILLAGE.statueStairWidth; k <= VILLAGE.statueStairWidth; k++) {
          const g = ground(s.ex + dir.dx * sortie + -dir.dz * k, s.ez + dir.dz * sortie + dir.dx * k);
          if (g < basDehors) basDehors = g;
        }
        if (niveau - 1 <= basDehors + 1) return rangees;
      }
    }
    return null;
  }

  /**
   * Plan d'une statue, ou null. Le colosse se pose **dans une ville** — l'influence
   * urbaine décide, pas la proximité d'une route — sur un plateau naturel, jamais sur la
   * voirie, jamais sous un bâtiment, jamais dans un très haut massif. Comme le temple, il
   * ne consulte pas les plans de maisons : c'est elles qui se déplacent (voir `tryPlan`).
   */
  function computeStatue(i, j) {
    const cell = VILLAGE.statueCell;
    if (roll(i, 1, j, SALT_STATUE) >= VILLAGE.statueChance) return null;
    const baseX = i * cell + (cell >> 1);
    const baseZ = j * cell + (cell >> 1);
    if (cityInfluence(baseX, baseZ) < VILLAGE.statueMinCity) return null;
    if (alpage(baseX, baseZ) >= VILLAGE.alpsWild) return null;

    const forme = ORDRE_FORMES[Math.floor(roll(i, 2, j, SALT_STATUE_FORME) * ORDRE_FORMES.length)
      % ORDRE_FORMES.length];
    const { carte } = carteDe(forme);
    const ech = echelleDe(carte);
    const hx = Math.ceil(carte.xb * ech);
    const hzArriere = Math.ceil(-carte.za * ech);
    const hzAvant = Math.ceil(carte.zb * ech);
    const corpsHaut = Math.ceil(carte.haut * ech);
    const plinthH = VILLAGE.statuePlinth;
    const socleCorps = plinthH;                 // premier cube du corps au-dessus du socle

    // Marge : l'emprise, son tampon, et le degré qui descend devant. Tout doit rester
    // dans la maille, sinon deux colosses pourraient se toucher.
    const marge = Math.max(hx, hzArriere, hzAvant) + VILLAGE.statuePad + plinthH + 3
      + VILLAGE.statueStairExtra;
    const jeu = cell - 2 * marge;
    if (jeu < 6) return null;

    for (let e = 0; e < VILLAGE.statueTries; e++) {
      const ex = baseX + Math.floor((roll(i, 3, j, SALT_STATUE + e * 11) - 0.5) * jeu);
      const ez = baseZ + Math.floor((roll(i, 4, j, SALT_STATUE + e * 11) - 0.5) * jeu);
      const door = Math.floor(roll(i, 5, j, SALT_STATUE_FORME + e * 11) * 4) % 4;
      const s = {
        kind: 'statue', i, j, forme, ex, ez, door, ech, hx, hzAvant, hzArriere,
        corpsHaut, plinthH, socleCorps,
      };
      // Le très haut massif se refuse **au pied du colosse**, pas au centre de la maille :
      // jugé à la maille seule, seize statues venaient mourir sur la glace à soixante
      // cubes de là, là où le tirage de place les avait menées.
      if (alpage(ex, ez) >= VILLAGE.alpsWild) continue;
      // Voirie sous l'ouvrage ou à moins de deux cubes de lui : le piédestal de trente
      // cubes posé sur une avenue la boucherait, et le pavé ne se déplace pas pour un
      // monument. La réserve jugée ici est **celle de la rue**, plus étroite que le tampon
      // de perspective : exiger quatre cubes libres de part et d'autre d'une envergure de
      // trente, c'est demander un carré de trente-huit colonnes entre deux avenues espacées
      // de quatre-vingts — les grandes formes étaient éliminées avant même de regarder le
      // relief. Le bâti, lui, reste tenu à `statuePad`.
      let toucheRoute = false;
      const routePad = 2;
      const pad = VILLAGE.statuePad;
      const corps_ = () => empreinteDe(ex, ez, door, hx, -hzArriere, hzAvant, 0);
      const voirie = (b) => {
        for (let wx = b.x0; wx <= b.x1 && !toucheRoute; wx++) {
          for (let wz = b.z0; wz <= b.z1 && !toucheRoute; wz++) if (roadKind(wx, wz)) toucheRoute = true;
        }
      };
      voirie(empreinteDe(ex, ez, door, hx, -hzArriere, hzAvant, routePad));
      // Le couloir du degré descend devant le socle sur `plinthH + 2` rangées — davantage
      // encore quand la pente fuit sous le monument : il écrit des marches là où il passe,
      // donc une avenue qu'il traverse disparaîtrait sous l'escalier aussi sûrement que
      // sous le piédestal. La réserve est prise au pire cas, volée rallongée comprise.
      voirie(empreinteDe(ex, ez, door, VILLAGE.statueStairWidth,
        hzAvant + 1, hzAvant + plinthH + 2 + VILLAGE.statueStairExtra, routePad));
      if (toucheRoute) continue;
      const garde = empreinteDe(ex, ez, door, hx, -hzArriere, hzAvant, pad);
      if (templesSur(garde.x0, garde.z0, garde.x1, garde.z1).length) continue;

      // Plateau sous le socle, et pays plus bas que lui **juste autour** : un colosse
      // adossé à une berge plus haute que son piédestal disparaîtrait dans le talus, trompe
      // dans la terre et aile dans les buissons. L'anneau jugé ne dépasse l'emprise que d'un
      // cube — c'est là que tombent les débords (trompe, museau, pointe d'aile). Le juger
      // sur tout le tampon de perspective éliminait les deux grandes formes sur cent sites
      // explorés : mesure monde du jeu, 32 humains posés contre 1 éléphant et 0 aigle.
      let minH = Infinity;
      let maxH = -Infinity;
      let noye_ = false;
      const cad = corps_();
      for (let wx = cad.x0; wx <= cad.x1 && !noye_; wx++) {
        for (let wz = cad.z0; wz <= cad.z1 && !noye_; wz++) {
          const h = ground(wx, wz);
          if (h < minH) minH = h;
          if (h > maxH) maxH = h;
          if (noye(wx, wz)) noye_ = true;
        }
      }
      if (noye_) continue;
      // L'écart de niveau sous le piédestal se laisse grand : le socle se coule du sol de
      // chaque colonne jusqu'à sa table, donc une place en pente se rattrape par l'épaisseur
      // du massif, comme le fait déjà la cour d'une maison. Ce que l'on tient, c'est le
      // pourtour (ci-dessous) et le degré (plus bas) — pas l'empreinte entière au niveau.
      if (maxH - minH > VILLAGE.statueMaxRelief) continue;
      if (minH < VILLAGE.minGround || maxH > VILLAGE.maxGround) continue;
      const rive = 1;
      let riverre = false;
      const anneau = empreinteDe(ex, ez, door, hx, -hzArriere, hzAvant, rive);
      for (let wx = anneau.x0; wx <= anneau.x1 && !riverre; wx++) {
        for (let wz = anneau.z0; wz <= anneau.z1 && !riverre; wz++) {
          if (ground(wx, wz) > maxH + 2) riverre = true;
        }
      }
      if (riverre) continue;

      s.sol = maxH;
      s.socle = maxH + plinthH;                 // arête du piédestal
      s.cadre = cad;                            // l'emprise telle qu'elle sera coulée
      if (s.socle + corpsHaut + 1 >= CHUNK_HEIGHT) continue;
      s.degre = degreDe(s);
      if (!s.degre) continue;
      s.bx0 = ex - marge; s.bx1 = ex + marge; s.bz0 = ez - marge; s.bz1 = ez + marge;
      return s;
    }
    return null;
  }

  const statueAt = (i, j) => cachedStruct(`s:${i},${j}`, () => computeStatue(i, j));

  /** Statues dont l'emprise recoupe la fenêtre donnée (l'emprise reste dans sa maille). */
  function statuesSur(x0, z0, x1, z1) {
    const cell = VILLAGE.statueCell;
    const out = [];
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) {
      for (let j = Math.floor(z0 / cell); j <= Math.floor(z1 / cell); j++) {
        const s = statueAt(i, j);
        if (s && s.bx1 >= x0 && s.bx0 <= x1 && s.bz1 >= z0 && s.bz0 <= z1) out.push(s);
      }
    }
    return out;
  }

  /**
   * Ce que la statue écrit vraiment : le socle, le corps et le couloir du degré. Le tampon
   * qui entoure n'est qu'une réserve de perspective — y interdire le bâti viderait la ville.
   */
  function statueGenant(wx, wz, s) {
    const dx = wx - s.ex;
    const dz = wz - s.ez;
    const dir = TEMPLE_DIRS[s.door];
    const axial = dx * dir.dx + dz * dir.dz;
    const tangent = dx * -dir.dz + dz * dir.dx;
    // Le socle suit l'orientation : ses deux demies-portées ne sont pas les mêmes selon
    // qu'on regarde le devant (trompe, poitrail, envergure) ou le derrière (queue).
    const avant = axial >= 0 ? s.hzAvant : s.hzArriere;
    if (Math.abs(axial) <= avant && Math.abs(tangent) <= s.hx) return true;
    return axial > avant && axial <= avant + (s.degre ? s.degre.length : s.plinthH + 2)
      && Math.abs(tangent) <= VILLAGE.statueStairWidth;
  }

  function statueStone(wx, wz) {
    return statuesSur(wx, wz, wx, wz).some((s) => statueGenant(wx, wz, s));
  }

  /** Une emprise de bâtiment gêne-t-elle la pierre posée d'une statue ? */
  function statueGenantSur(x0, z0, x1, z1) {
    for (const s of statuesSur(x0 - VILLAGE.statueStairWidth - 4, z0 - VILLAGE.statueStairWidth - 4,
      x1 + VILLAGE.statueStairWidth + 4, z1 + VILLAGE.statueStairWidth + 4)) {
      if (x1 < s.bx0 || x0 > s.bx1 || z1 < s.bz0 || z0 > s.bz1) continue;
      for (let wx = x0; wx <= x1; wx++) {
        for (let wz = z0; wz <= z1; wz++) if (statueGenant(wx, wz, s)) return true;
      }
    }
    return false;
  }

  function stampStatue(data, cx, cz, s) {
    const put = chunkWriter(data, cx, cz);
    const dir = TEMPLE_DIRS[s.door];
    const latX = -dir.dz;
    const latZ = dir.dx;
    let ecrits = 0;
    const ombre = (wx, wz) => (wx - s.ex) * dir.dx + (wz - s.ez) * dir.dz <= -2;
    // La pierre se patine du côté opposé au degré, comme au temple : une face toute neuve
    // se lirait comme un chantier. Le granite reste majoritaire, sinon le colosse verdit.
    const pierre = (wx, wz, y, id) => {
      put(wx, wz, y, ombre(wx, wz) && roll(wx, y, wz, SALT_STATUE_PIERRE) < 0.1 ? BLOCK.MOSS : id);
      ecrits++;
    };
    const dalle = (wx, wz, sommet, id) => {
      const g = ground(wx, wz);
      for (let y = g; y < sommet; y++) put(wx, wz, y, BLOCK.COBBLE);
      put(wx, wz, sommet, id);
      ecrits++;
    };

    // 1. Piédestal : un parallélépipède de roc, coiffé d'une table de pierre claire.
    //    La table suit l'emprise **tournée** — la même que celle qu'a jugée `computeStatue`.
    const cad = s.cadre;
    for (let wx = cad.x0; wx <= cad.x1; wx++) {
      for (let wz = cad.z0; wz <= cad.z1; wz++) dalle(wx, wz, s.socle, BLOCK.STONE);
    }

    // 2. Degré : une rangée par cube de hauteur, jamais plus d'un cube de reprise entre
    //    deux colonnes — le visiteur monte au pied du colosse, il n'escalade pas.
    for (const r of s.degre) {
      if (!r.poser) continue;
      for (let k = -VILLAGE.statueStairWidth; k <= VILLAGE.statueStairWidth; k++) {
        dalle(s.ex + dir.dx * r.axial + latX * k, s.ez + dir.dz * r.axial + latZ * k,
          r.sommet, BLOCK.STONE);
      }
    }

    // 3. Corps. Le masque est stocké en coordonnées locales ; la rotation suit la face
    //    tirée, et le calage se fait **sur le dessus du socle**, jamais sur le sol naturel.
    const { m, nx, ny, nz } = masqueDe(s);
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        const lz = iz - s.hzArriere;            // axial local : + devant, − derrière
        for (let ix = 0; ix < nx; ix++) {
          if (!m[ix + iz * nx + iy * nx * nz]) continue;
          const lx = ix - s.hx;                 // latéral local
          const wx = s.ex + dir.dx * lz + latX * lx;
          const wz = s.ez + dir.dz * lz + latZ * lx;
          pierre(wx, wz, s.socle + 1 + iy, iy < 2 ? BLOCK.COBBLE : BLOCK.STONE);
        }
      }
    }

    // 4. Le trait de cour, le long du socle et du degré : la même assise à plat que devant
    //    les maisons, pour que le monument ait une bordure et non une frange d'herbe.
    const limites = [[cad.x0, cad.z0, cad.x1, cad.z1]];
    if (s.degre.length) {
      let lx0 = Infinity, lz0 = Infinity, lx1 = -Infinity, lz1 = -Infinity;
      for (const r of s.degre) {
        for (let k = -VILLAGE.statueStairWidth; k <= VILLAGE.statueStairWidth; k++) {
          const wx = s.ex + dir.dx * r.axial + latX * k;
          const wz = s.ez + dir.dz * r.axial + latZ * k;
          lx0 = Math.min(lx0, wx); lz0 = Math.min(lz0, wz);
          lx1 = Math.max(lx1, wx); lz1 = Math.max(lz1, wz);
        }
      }
      limites.push([lx0, lz0, lx1, lz1]);
    }
    traitDeCour(data, cx, cz, limites);
    return ecrits;
  }

  return {
    roadKind, buildingAt, stampBuilding, stampRoads, stampStructures, structuresAt,
    bridgeAt, archAt, templeAt, templesSur, bridgeUnderside, isOccupied, blocksVegetation,
    templeStone, statueStone, statueAt, statuesSur, statueGenantSur, cityInfluence, VILLAGE, alpage,
    roadSurface, streetLevel, surfaceAt,
  };
}
