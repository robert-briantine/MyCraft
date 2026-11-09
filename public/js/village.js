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
  towerChance: 0.22, // part des immeubles parmi les parcelles bâties, à la campagne
  cityTowerChance: 0.62, // en ville on monte
  minGround: 20,     // le sable commence au-dessous : pas de village sur la grève
  maxGround: 38,     // la neige commence au-dessus : ni sur les sommets enneigés
  maxReliefHouse: 7, // maison à demi enterrée dans la pente, comblée jusqu'au terrain
  maxReliefTower: 8, // une tour s'adosse à la pente, son seuil reste calé sur la rue
  floorPitch: 3,     // un étage = 3 blocs (dalle porteuse + deux cubes d'air libre)
  maxHeight: 34,     // plafond absolu : dix planchers, rez-de-chaussée plus haut compris
  houseMinH: 3, houseMaxH: 6,
  towerMinH: 9,      // plus petite tour : 3 étages
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
  waterMaxSpan: 30,       // au-delà ce n'est plus un bras mais le large : on s'arrête
  waterFreeboard: 5,      // cubes entre le plan d'eau et le tablier : le chenal se nage

  // Voirie : la chaussée garde sa ligne droite et se pose un profil à un cube par
  // colonne, en marches continues. Le relief n'est jamais modifié — seul le revêtement
  // change d'altitude, comme sous un pont.
  roadStepWindow: 24,     // colonnes sondées de part et d'autre pour conduire la montée

  // Arcs de triomphe : posés en travers d'une avenue, côté centre-bourg.
  archChance: 0.6,
  archCell: 96,           // maille le long d'une avenue où l'on tente un arc
  archMinCity: 0.4,       // assez loin du centre, l'arc n'a plus rien de monumental
  archKeepout: 18,        // distance à l'avenue croisée : un arc se dresse en pleine rue
  archHalf: 3,            // l'ouvrage occupe chaussée et caniveaux, ±3 cubes
  archPassage: 1,         // libre de part et d'autre de l'axe
  archShoulder: 2,        // cubes pleins sous le cintré, de chaque côté du passage

  // Temples : un monument de marbre et d'or, isolé et **beaucoup plus rare que le bâti
  // courant**. Il doit se voir de la route : son parvis mesure quatre fois la largeur
  // d'une maison, et ses matériaux ne sont ceux d'aucune façade du village (maisons =
  // brique, roche, planches). Il se pose sur un plateau naturel, jamais sur la voirie ni
  // sous un bâtiment : il est estampé après eux, et rien ne doit s'écraser l'un l'autre.
  templeCell: 78,
  templeChance: 0.35,
  templeTries: 40,        // sites sondés dans la maille avant de renoncer (voir computeTemple)
  templeHalf: 13,         // emprise du parvis : 27 cubes, soit quatre maisons de front
  templeSteps: 5,         // gradins menant au parvis
  templeStairWidth: 2,    // demi-largeur du degré : cinq colonnes d'accès
  templeMaxRelief: 8,     // niveau exigé sous le naos et la colonnade
  templeColumnPitch: 3,   // une colonne sur trois autour du naos
  templeHeight: 9,        // hauteur des colonnes et des murs au-dessus du parvis
  templeCellaHalf: 7,     // salle intérieure : 15×15 cubes
  templeRoofPitch: 1,     // le comble monte d'un cube par gradin
};

// Nombre de planchers visibles d'une hauteur donnée : c'est ce que l'on compte depuis
// la rue, et ce que vérifient les tests. Le premier est à quatre cubes du seuil (le
// temps que le joueur puisse lever d'un cran), les suivants au pas de `floorPitch`,
// donc une tour à `maxHeight` en compte dix.
export const storeysOf = (height) => Math.max(0,
  Math.floor((height - VILLAGE.floorPitch - 2) / VILLAGE.floorPitch) + 1);

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

// Les quatre faces du parvis, dans l'ordre du tirage de porte : +x, −x, +z, −z.
const TEMPLE_DIRS = [
  { dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 },
];

export function createVillageGen({ BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt, roll: rawRoll, saltBase = 0, seaLevel = -1, waterTopAt = null }) {
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
      if (!noye(Math.round(x), Math.round(z))) return { x, z };
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
    const dense = influence >= 0.55;
    const town = influence >= 0.2;
    // Part des parcelles simples ou jumelles : les quarts de tronçon ne donnent que des
    // cabanes de six colonnes, et le village se lisait en rangées de boîtes. On pousse
    // l'emprise moyenne vers le haut sans supprimer les petites — c'est le contraste
    // des gabarits qui fait une ville.
    const anchorShare = dense ? 0.3 : town ? 0.16 : 0.05;
    const singleShare = anchorShare + (dense ? 0.2 : town ? 0.16 : 0.06);
    const pairShare = singleShare + (dense ? 0.25 : 0.3);
    // Le tronçon est bâti au plus près de ses limites : le retrait d'une colonne sur les
    // bords suffit à ce que deux tronçons voisins ne se murient pas leurs portes.
    const lo = 1;
    const hi = CHUNK_SIZE - 2;
    // La ruelle est réduite à une colonne et passe au sud du milieu : les deux corps
    // gagnent un cube de façade chacun sans que deux tronçons voisins se touchent.
    const seamA = 8;                          // fin de la première moitié
    const seamB = 9;                          // la colonne d'après : ruelle entre les deux
    // Corps d'une « ancre » : six colonnes suffisent à loger la volée en chicane d'une
    // tour, et ce retrait laisse aux deux cottages qui lui font face cinq colonnes — en
    // dessous de cinq, ils ne passent plus le gabarit minimal et le cœur de ville se
    // vidait d'un tiers de son bâti.
    const aEnd = lo + 5;                      // fin de la grande emprise
    const bStart = 10;                        // en face, après le dégagement

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
      plots = [
        { x0: lo, z0: lo, x1: seamA - 1, z1: seamA - 1 },
        { x0: seamB, z0: lo, x1: hi, z1: seamA - 1 },
        { x0: lo, z0: seamB, x1: seamA - 1, z1: hi },
        { x0: seamB, z0: seamB, x1: hi, z1: hi },
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

  /** Ni sur la chaussée, ni sur le caniveau : le bâtiment donne sur la rue, il ne l'occupe pas. */
  function lotIsClearOfRoad(baseX, baseZ, x0, z0, w, d) {
    for (let lx = x0; lx < x0 + w; lx++) {
      for (let lz = z0; lz < z0 + d; lz++) {
        if (roadKind(baseX + lx, baseZ + lz)) return false;
      }
    }
    return true;
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
    const influence = cityInfluence(baseX + (CHUNK_SIZE >> 1), baseZ + (CHUNK_SIZE >> 1));
    // Courbe creusée : l'approche d'une ville doit se voir de loin, d'où le puissance
    // 0,6 qui fait monter la densité dès les faubourgs plutôt qu'au centre seul.
    const density = VILLAGE.lotDensity
      + Math.pow(influence, 0.6) * (VILLAGE.cityDensity - VILLAGE.lotDensity);
    const plans = [];
    plotsFor(baseX, baseZ, influence).forEach((plot, i) => {
      if (roll(baseX + i * 7, 7, baseZ + i * 13, SALT_LOT) >= density) return;
      const plan = computePlan(baseX, baseZ, plot, i, influence);
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
  function computePlan(baseX, baseZ, plot, i, influence) {
    // Quatre essais, chacun rétrécissant l'empreinte de deux colonnes : avec des maisons
    // de sept cubes, un plateau refusé à cette taille s'accommode souvent d'une emprise
    // de cinq, et une parcelle vide au cœur de la ville se voit.
    for (let attempt = 0; attempt < 4; attempt++) {
      const plan = tryPlan(baseX, baseZ, plot, i, influence, attempt);
      if (plan) return plan;
    }
    return null;
  }

  function tryPlan(baseX, baseZ, plot, i, influence, attempt) {
    const availW = plot.x1 - plot.x0 + 1 - 2 * attempt;
    const availD = plot.z1 - plot.z0 + 1 - 2 * attempt;
    if (availW < 4 || availD < 3) return null;

    // Une tour doit loger sa volée en chicane ; faute de place, on bâtit une maison.
    // Le tirage dépend de la tentative : une parcelle qui refuse la tour peut encore
    // porter une maison, plutôt que de rester vide trois tentatives de suite.
    const towerChance = VILLAGE.towerChance
      + Math.pow(influence, 0.6) * (VILLAGE.cityTowerChance - VILLAGE.towerChance);
    const tower = Math.min(availW, availD) >= 6
      && stairCapacity(availW, availD) >= VILLAGE.towerMinH
      && roll(baseX + i * 5 + attempt * 977, 11, baseZ + i * 3 + attempt * 613, SALT_KIND) < towerChance;

    // On cale l'empreinte sur la parcelle, à un cube près : c'est ce qui donne un tissu
    // serré plutôt que des pavillons perdus au milieu de leur lot.
    const minSide = tower ? 6 : 5;
    if (availW < minSide || availD < minSide) return null;
    const w = between(Math.max(minSide, availW - 1), availW, baseX + i, 1, baseZ, SALT_SIZE);
    const d = between(Math.max(minSide, availD - 1), availD, baseX + i, 2, baseZ, SALT_SIZE);
    const x0 = plot.x0 + attempt + Math.floor(roll(baseX + i * 17, 3, baseZ + i * 29, SALT_PLACE) * (availW - w + 1));
    const z0 = plot.z0 + attempt + Math.floor(roll(baseX + i * 17, 4, baseZ + i * 29, SALT_PLACE) * (availD - d + 1));
    if (!fitsInsideLot(x0, z0, w, d)) return null;
    if (!lotIsClearOfRoad(baseX, baseZ, x0, z0, w, d)) return null;
    // Un temple tient son parvis : c'est le bâtiment qui se déplace, pas le monument.
    // Le contrôle ne se fait que dans ce sens — un plan de bâtiment qui dépendrait du
    // temple, lequel dépendrait des bâtiments, ne convergerait jamais. On ne gêne que la
    // pierre posée, pas le tampon de végétation qui l'entoure.
    if (templeGenantSur(baseX + x0 - 1, baseZ + z0 - 1, baseX + x0 + w, baseZ + z0 + d)) return null;

    // Relief : on exige un plateau presque plat, sinon la maison flotterait d'un
    // côté ou serait enterrée de l'autre.
    let minH = Infinity;
    let maxH = -Infinity;
    for (let lx = x0; lx < x0 + w; lx += 1) {
      for (let lz = z0; lz < z0 + d; lz += 1) {
        const h = ground(baseX + lx, baseZ + lz);
        // Ni mer ni cours d'eau sous une emprise : la bande d'altitude écartait la mer
        // (le sable tient trois cubes au-dessus de la ligne) mais une rivière court bien
        // au-dessus de `minGround`, et une maison posée sur son lit ferait barrage.
        if (noye(baseX + lx, baseZ + lz)) return null;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    const maxRelief = tower ? VILLAGE.maxReliefTower : VILLAGE.maxReliefHouse;
    if (!(maxH - minH <= maxRelief)) return null;
    if (!(minH >= VILLAGE.minGround && maxH <= VILLAGE.maxGround)) return null;

    // Le seuil est calé sur la rue côté porte pour qu'on entre de plain-pied. Sur une
    // avenue en escalier, la chaussée n'est plus à l'altitude du terrain : c'est bien
    // elle qu'il faut rejoindre, sinon la porte donne deux cubes au-dessus du pavé.
    const doorSide = Math.floor(roll(baseX, 6, baseZ, SALT_DOOR) * 4) % 4;
    let siteH = minH;
    const roadside = [];
    for (let k = 0; k < (doorSide % 2 === 0 ? w : d); k++) {
      for (let outset = 0; outset <= 2; outset++) {
        const lx = doorSide === 2 ? x0 - outset : doorSide === 0 ? x0 + w - 1 + outset : x0 + k;
        const lz = doorSide === 3 ? z0 - outset : doorSide === 1 ? z0 + d - 1 + outset : z0 + k;
        roadside.push(surfaceAt(baseX + lx, baseZ + lz));
      }
    }
    if (roadside.length) siteH = Math.max(siteH, Math.round(roadside.reduce((a, b) => a + b, 0) / roadside.length));

    // Hauteur : bornée par ce que peut gravir l'escalier et par le sommet du monde —
    // une tour dont on ne peut pas ouvrir la trappe est un piège. Elle suit aussi
    // l'influence urbaine, sinon la campagne se couvre de gratte-ciel isolés. L'échelle
    // part à zéro sous l'orée de la ville (influence 0,2) : les premières parcelles
    // urbaines restent à trois étages et seules les grandes hauteurs sont réservées au
    // centre-bourg, où l'on vise les dix étages de `maxHeight`.
    const ceiling = CHUNK_HEIGHT - 3 - siteH;
    const buildable = Math.min(VILLAGE.maxHeight, stairCapacity(w, d));
    const urban = Math.max(0, (influence - 0.2) / 0.8);
    const top = tower
      ? Math.max(VILLAGE.towerMinH, Math.round(VILLAGE.towerMinH + Math.sqrt(urban) * (buildable - VILLAGE.towerMinH)))
      : VILLAGE.houseMaxH;
    // Le tirage est lui aussi poussé vers le haut par l'influence : borné à `top`, un
    // tirage uniforme donnait presque toujours le bas de la fourchette et la ville ne
    // décollait jamais. Au centre-bourg la tour part de ses trois quarts de hauteur.
    const floorH = Math.min(top, Math.round(
      VILLAGE.towerMinH + (top - VILLAGE.towerMinH) * (0.5 + 0.5 * urban),
    ));
    let height = tower
      ? between(floorH, top, baseX + i, 5, baseZ, SALT_HEIGHT)
      : between(VILLAGE.houseMinH, VILLAGE.houseMaxH, baseX + i, 5, baseZ, SALT_HEIGHT);
    height = Math.min(height, ceiling);
    if (height < VILLAGE.houseMinH) return null;

    const wallBlock = tower
      ? pick([BLOCK.BRICK, BLOCK.COBBLE, BLOCK.STONE], baseX, 8, baseZ, SALT_MATERIAL)
      : pick([BLOCK.BRICK, BLOCK.PLANKS, BLOCK.COBBLE], baseX, 8, baseZ, SALT_MATERIAL);

    // La baie est au centre de la façade choisie. `front` et `out` sont les deux
    // colonnes qui donnent sur la rue : c'est là qu'il faudra dégager le passage.
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

    // Un immeuble sans escalier serait une coquille vide : on renonce à la parcelle
    // plutôt que de poser une tour dont on ne peut pas sortir sur le toit. La volée
    // démarre à l'opposé de la porte pour ne pas boucher l'entrée dès le seuil franchi.
    const opts = {
      reverseRun: doorSide === 0 ? true : doorSide === 2 ? false : roll(baseX + i, 13, baseZ + i, SALT_STAIR) < 0.5,
      fromFarCross: doorSide === 1 ? true : doorSide === 3 ? false : roll(baseX + i, 14, baseZ + i, SALT_STAIR) < 0.5,
    };
    let stair = tower ? stairPlan(x0, z0, w, d, height, siteH + 1, opts) : null;
    if (tower && stair && blocksDoorway(stair, door)) {
      stair = stairPlan(x0, z0, w, d, height, siteH + 1, {
        reverseRun: !opts.reverseRun, fromFarCross: !opts.fromFarCross,
      });
    }
    if (tower && (!stair || blocksDoorway(stair, door))) return null;

    return {
      kind: tower ? 'tower' : 'house',
      lot: i,
      city: Math.round(influence * 1000) / 1000,
      x0, z0, w, d,
      siteH,
      height,
      wall: wallBlock,
      floor: tower ? BLOCK.STONE : BLOCK.PLANKS,
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
      gable: !tower && roll(baseX, 12, baseZ, SALT_DETAIL) > 0.35,
    };
  }

  /** Écrit tous les bâtiments du tronçon. Renvoie false si le tronçon est vierge. */
  function stampBuilding(data, cx, cz) {
    const plans = buildingAt(cx, cz);
    if (!plans.length) return false;
    for (const plan of plans) stampOne(data, cx, cz, plan);
    return true;
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

    // 1) Nivellement : dalle posée sur un lit de terre, et on creuse ce qui dépasse
    //    du côté de la colline, sinon le bâtiment serait à moitié enterré. Le lit
    //    descend jusqu'au terrain naturel : sur une pente, la dalle ne doit jamais
    //    laisser de vide sous le plancher.
    for (let lx = x0; lx < x0 + w; lx++) {
      for (let lz = z0; lz < z0 + d; lz++) {
        const surface = ground(baseX + lx, baseZ + lz);
        set(lx, siteH, lz, plan.floor);
        for (let y = Math.min(surface, siteH - 1); y <= siteH - 1; y++) set(lx, y, lz, BLOCK.DIRT);
        for (let y = siteH + 1; y <= Math.max(surface, roofY + 1); y++) set(lx, y, lz, BLOCK.AIR);
      }
    }

    // 2) Murs d'enceinte, avec fenêtres en quinconce.
    const isPerimeter = (lx, lz) => lx === x0 || lx === x0 + w - 1 || lz === z0 || lz === z0 + d - 1;
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
    const autreAxis = axis === 'x' ? 'z' : 'x';
    const selAutre = axis === 'x' ? SALT_ROAD_X : SALT_ROAD_Z;
    const debord = portee + W;
    const cible = (j) => {
      const t = profileAt(axis, k, j);
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
    if (!mouille(centre)) return null;

    const borne = own + VILLAGE.waterMaxSpan + 2 * VILLAGE.bridgeMaxRamp;
    let ds = centre, de = centre;
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
    const edge = own + 6;
    let eau = seaLevel;
    for (let i = ds; i <= de; i++) {
      for (let o = -half; o <= half; o++) {
        const c = cellOf(axis, k, i, o);
        const e = planDEau(c.wx, c.wz);
        if (e > eau) eau = e;
      }
    }
    const deckY = Math.max(eau + VILLAGE.waterFreeboard,
      niveauCroisees(axis, k, ds - edge - half, de + edge + half));
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
      const croisee = niveauCroisees(axis, k, i - portee, i + portee);
      if (croisee > v) v = croisee;
      return v;
    };
    const approche = (from, step) => {
      let niveau = deckY;
      for (let n = 0; n < VILLAGE.bridgeMaxRamp; n++) {
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
    // Une approche qui ne rattrape pas la rue en `bridgeMaxRamp` colonnes n'enterre pas
    // le pont : le tablier s'allonge d'une colonne du côté qui refuse, tant que l'ouvrage
    // reste raisonnable. Un viaduc porte sa chaussée plus loin plutôt que de laisser la
    // rue coupée — c'est précisément ce que le joueur réclame.
    let bord = 0;
    for (;;) {
      ramp.clear();
      const aGauche = approche(left, -1);
      const aDroite = approche(right, 1);
      if (aGauche && aDroite) break;
      if (bord >= VILLAGE.bridgeMaxRamp) return null;
      if (aGauche) right++; else left--;
      if (mouille(left) || mouille(right)) return null;   // on n'étend pas dans l'eau
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

  /** Voirie sous le parvis, ou sous le couloir d'approche du degré. */
  function templeTouchesRoute(ex, ez, half, door) {
    for (let wx = ex - half; wx <= ex + half; wx++) {
      for (let wz = ez - half; wz <= ez + half; wz++) {
        if (roadKind(wx, wz)) return true;
      }
    }
    // Le degré ne déborde que dans le couloir de la porte : exiger une bande libre de
    // vingt-sept cubes de côté éliminait un site sur deux pour rien.
    const dir = TEMPLE_DIRS[door];
    const latX = -dir.dz;
    const latZ = dir.dx;
    for (let s = 1; s <= VILLAGE.templeSteps + 4; s++) {
      for (let k = -VILLAGE.templeStairWidth; k <= VILLAGE.templeStairWidth; k++) {
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
    for (let s = 1; s <= VILLAGE.templeSteps + 4; s++) {
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
    }
    return rangees;
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
    return axial > t.half && axial <= t.half + VILLAGE.templeSteps + 4
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
    const marge = half + VILLAGE.templeSteps + 4;
    if (roll(i, 1, j, SALT_TEMPLE) >= VILLAGE.templeChance) return null;
    const jeu = cell - 2 * marge;
    if (jeu < 4) return null;
    const baseX = i * cell + (cell >> 1);
    const baseZ = j * cell + (cell >> 1);
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
        // Rien ici de ce qui bâtit le village (brique, roche, planches) : le marbre et
        // l'or doivent se reconnaître de loin, sinon le monument se confond avec une
        // ferme et le joueur croit qu'il n'y a pas de temple dans son monde.
        wall: BLOCK.SNOW, fill: BLOCK.SAND, roof: BLOCK.SAND, altar: BLOCK.GOLD,
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
        const bPad = Math.ceil(VILLAGE.bridgeMaxSpan / 2) + VILLAGE.bridgeMaxRamp + 2;
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
      // Sur l'eau, la travée est entièrement libre de la surface du plan d'eau au
      // tablier : pas de tympan. Combler jusqu'à la naissance de la courbe noierait le
      // chenal en amont et ferait du pont une digue.
      return { pier: false, open: b.clearance, intrados: b.deckY - b.clearance };
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
          // Sur l'eau, seules les piles descendent dans le lit. Entre elles on n'écrit
          // rien — ni comblement, ni évidement : l'eau et le vide au-dessus doivent
          // rester tels que le remplissage les a posés, sinon l'ouvrage fait digue.
          if (pier) for (let y = surface + 1; y < b.deckY; y++) put(c.wx, c.wz, y, b.mat);
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

    // 3. Colonnade et son linteau.
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== R) continue;
        const axial = dx * dir.dx + dz * dir.dz;
        const tangent = dx * latX + dz * latZ;
        // L'axe du degré reste libre : sans cette exception, une colonne se dresserait
        // dans l'alignement exact de la porte et boucherait l'approche.
        if (axial === R && Math.abs(tangent) <= 1) continue;
        const coin = Math.abs(dx) === Math.abs(dz);
        const pair = Math.abs(dx) % VILLAGE.templeColumnPitch === 0
          || Math.abs(dz) % VILLAGE.templeColumnPitch === 0;
        if (!coin && !pair) continue;
        for (let y = t.socle + 1; y <= haut; y++) pierre(t.ex + dx, t.ez + dz, y, t.wall);
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
        for (let y = t.socle + 1; y <= haut; y++) {
          if (baie && y <= t.socle + 3) { put(t.ex + dx, t.ez + dz, y, BLOCK.AIR); continue; }
          if (bord) pierre(t.ex + dx, t.ez + dz, y, t.wall);
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
    return ecrits + 2;
  }

  /** True si la colonne est prise par une route ou par l'emprise d'un bâtiment. */
  function isOccupied(wx, wz) {
    if (roadKind(wx, wz)) return true;
    if (templesSur(wx, wz, wx, wz).length) return true;
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    const lx = wx - cx * CHUNK_SIZE;
    const lz = wz - cz * CHUNK_SIZE;
    return buildingAt(cx, cz).some((plan) =>
      lx >= plan.x0 && lx < plan.x0 + plan.w && lz >= plan.z0 && lz < plan.z0 + plan.d);
  }

  return {
    roadKind, buildingAt, stampBuilding, stampRoads, stampStructures, structuresAt,
    bridgeAt, archAt, templeAt, templesSur, bridgeUnderside, isOccupied, cityInfluence, VILLAGE,
    roadSurface, streetLevel, surfaceAt,
  };
}
