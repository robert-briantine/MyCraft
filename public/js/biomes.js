//
// Biomes et végétation : le monde n'est plus une plaine uniforme piquetée d'arbres.
// Trois zones se partagent la carte — **forêt**, **plaine** et **désert** — dessinées
// par un climat basse fréquence, donc franches de quelques dizaines de cubes : on met
// le temps de les traverser à pied, elles ne grésillent pas d'un cube à l'autre.
//
// Un arbre est une **souche** (tronc de bois de cinq à sept cubes) coiffée d'une
// **couronne** de feuilles. Deux règles commandent tout le reste, parce que le joueur
// ne franchit qu'un cube par colonne et mesure 1,80 cube :
//  - la couronne ne descend jamais à moins de quatre cubes du sol : on se tient debout
//    et on circule **sous** les arbres, la forêt se traverse sans escalader le feuillage ;
//  - deux souches ne sont jamais jointives : entre deux troncs il reste toujours un
//    passage libre, et une colonne bouchée par un tronc a toujours un voisin libre où
//    déborder. Une forêt infranchissable n'est pas une forêt, c'est un mur.
//
// Comme le village, le module est sans dépendance (ni DOM, ni three) et sans
// Math.random() : tout sort d'un hachage des coordonnées. Le monde ne s'enregistre
// que comme le diff du joueur, donc un tronçon régénéré doit retomber cube pour cube
// sur le précédent — arbres compris. Il reçoit la table de blocs, les dimensions de
// tronçon, la fonction de relief, une tireuse déterministe et un prédicat « cette
// cellule est-elle prise par la voirie ou un bâtiment », ce qui permet de le tester
// sous Node sans navigateur.

export const BIOMES = {
  // Climat : deux bruits basse fréquence, une maille de 150 cubes soit neuf tronçons.
  climateCell: 150,
  climateDetail: 3,      // un octave serré divise la maille : frontières découpées
  dryLimit: -0.10,       // sous ce seuil de fraîcheur, le sable prend le terrain
  // 0,06 jusqu'ici. Remonté à 0,10 quand la forêt macro est venue s'y superposer : sans
  // ce resserrement, la couche nouvelle mangeait la plaine (mesuré sur trois mille
  // cubes : plaine 20 % contre 25 % avant, forêt 51 %). La plaine doit rester le pays
  // que l'on traverse entre deux bois, pas un reliquat.
  wetLimit: 0.10,
  forestMin: 0.10,       // part de forêt visée (contrôlée par la suite, pas imposée)
  desertMin: 0.08,       // …et part de désert

  // Forêts à l'échelle des océans. Demandé le 2026-11-09 : « ajoute des zones de la
  // même taille que les océans de forêt ». Le climat ci-dessus dessine des zones de
  // quelques dizaines de tronçons ; ici la maille est celle d'un bassin marin — 900
  // cubes, l'équivalent de `RELIEF.oceanFreq` — donc une forêt que l'on traverse une
  // demi-heure sans changer de pays. Le seuil est haut : sous lui, rien n'est imposé
  // et le climat garde la main, sinon la carte entière devenait boisée.
  forestMacroCell: 900,
  forestMacroLimit: 0.78,

  // Bouquets : la forêt va par taches, pas en nappe égale — on y trouve des clairières.
  // Le peuplement doit descendre assez bas pour qu'un bouquet retenu se remplisse : à
  // un tronc toutes les 79 cellules, la « forêt » ne se lisait pas comme telle.
  standCell: 46,
  standMin: 0.34,        // densité de peuplement sous laquelle rien ne pousse
  standFill: 0.95,       // part des souches retenues dans un bouquet retenu

  // Souches : maille candidate + tirage de placement, puis éclaircie au meilleur tirage.
  // À cinq cubes de maille, même plein, un bouquet ne donnait qu'un tronc toutes les
  // 37 cellules : trop clair pour lire une futaie. Quatre cubes avec couronne de deux,
  // c'est un couvert d'un peu plus de moitié, et il reste toujours un passage libre
  // entre deux troncs (voir `treeMinGap`).
  treeCell: 4,
  treeMinGap: 2,         // distance de Chebyshev minimale entre deux troncs
  plainChance: 0.14,     // arbre isolé en plaine : le verger éparpillé
  snagChance: 0.10,      // souche morte au désert
  rockChance: 0.12,      // rocher affleurant au désert

  // Arbre : tronc et couronne. `headroom` est le vide ménagé sous le feuillage.
  trunkMin: 5,
  trunkMax: 7,
  crownRadius: 2,
  crownBigRadius: 3,
  crownBigChance: 0.22,  // part des grands sujets à couronne large
  headroom: 4,
  maxSlope: 2,           // un arbre ne prend pas racine dans une pente raide

  // Futaie de forêt. Demandé le 2026-11-09 : « dans les forêts mets des arbres plus
  // grands que dans les villes ». Le sujet de plaine — celui qui borde les rues du
  // village — reste le petit verger d'avant ; sous bois, le tronc monte presque du
  // double et la couronne s'élargit. Le garde-tête ne descend jamais sous `headroom`,
  // seulement il est pris plus haut : on marche debout sous les futaies comme sous les
  // pommiers, c'est l'échelle qui change, pas la règle de franchissement.
  futaieTrunkMin: 9,
  futaieTrunkMax: 13,
  futaieCrownRadius: 3,
  futaieCrownBigRadius: 4,
  futaieCrownBigChance: 0.3,
  futaieHeadroom: 5,

  // Étages d'altitude, partagés avec le village (qui n'y bâtit pas). Entre la limite
  // des arbres et la ligne de neige la roche reste nue : sans cet étage intermédiaire,
  // un versant passerait de l'herbe à la neige d'un coup et ne se lirait pas comme une
  // montagne — c'est aussi la bande qui sépare visuellement les futaies des névés.
  treeLine: 33,
  snowLine: 38,
  sandLine: 20,
};

/**
 * @param {object} deps
 * @param {object} deps.BLOCK            table des blocs du jeu
 * @param {number} deps.CHUNK_SIZE        côté d'un tronçon
 * @param {number} deps.CHUNK_HEIGHT      hauteur du monde
 * @param {(x:number,z:number)=>number} deps.heightAt  relief naturel
 * @param {(x:number,y:number,z:number,salt:number)=>number} deps.roll tireuse [0,1[
 * @param {number} [deps.saltBase]        décalage de toutes les familles de tirages
 * @param {(wx:number,wz:number)=>boolean} [deps.isBlocked] cellule tenue par la voirie
 *                                                        ou un bâtiment
 * @param {(x:number,z:number)=>({surface:number,fond:number,demiLargeur:number,berge:number,d:number}|null)}
 *      [deps.riverAt]                    lit de rivière au droit d'une colonne
 */
export function createBiomeGen({
  BLOCK, CHUNK_SIZE, CHUNK_HEIGHT, heightAt, roll, saltBase = 0, isBlocked = () => false,
  seaLevel = -1, riverAt = null,
}) {
  const S = (n) => (saltBase + n) | 0;
  // Un cours d'eau ne porte ni arbre ni rocher : ses berges sont sableuses et son lit
  // noyé. `surCours` juge le lit **et** ses berges, pour qu'une couronne ne vienne pas
  // tremper dans le chenal.
  const cours = riverAt || (() => null);
  const surCours = (x, z) => cours(x, z) !== null;
  // Le relief est relu des dizaines de fois par tronçon — pente, empreinte de couronne,
  // revêtement. Une colonne coûte quatre évaluations de bruit : sans mémoire, la seule
  // végétation mangeait le budget de construction des tronçons.
  const memoRelief = new Map();
  function relief(x, z) {
    const cle = `${x},${z}`;
    let h = memoRelief.get(cle);
    if (h === undefined) {
      h = heightAt(x, z);
      if (memoRelief.size > 65536) memoRelief.clear();
      memoRelief.set(cle, h);
    }
    return h;
  }
  const SALT_HEAT = S(4101);
  const SALT_WET = S(4202);
  const SALT_STAND = S(4303);
  const SALT_POS = S(4404);
  const SALT_PICK = S(4505);
  const SALT_SHAPE = S(4606);
  const SALT_SNAG = S(4707);
  const SALT_MACRO = S(4808);

  const fade = (t) => t * t * (3 - 2 * t);

  /** Valeur continue [0,1[ interpolée aux nœuds d'une maille : une zone franche. */
  function bruit(x, z, cell, salt) {
    const fx = x / cell;
    const fz = z / cell;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fade(fx - ix);
    const tz = fade(fz - iz);
    const noeud = (i, j) => roll(i, 7, j, salt);
    const haut = noeud(ix, iz) + (noeud(ix + 1, iz) - noeud(ix, iz)) * tx;
    const bas = noeud(ix, iz + 1) + (noeud(ix + 1, iz + 1) - noeud(ix, iz + 1)) * tx;
    return haut + (bas - haut) * tz;
  }

  /** Climat à deux octaves : de grandes zones aux frontières découpées. */
  function climat(x, z, cell, salt) {
    const fin = bruit(x, z, Math.max(2, Math.round(cell / BIOMES.climateDetail)), salt ^ 0x5bf03);
    return bruit(x, z, cell, salt) * 0.72 + fin * 0.28;
  }

  /**
   * La grande forêt : une zone à l'échelle d'un bassin marin (`forestMacroCell`, soit
   * l'équivalent de `RELIEF.oceanFreq`), indépendante du climat. Fonction pure des
   * coordonnées, comme tout le reste du module — une souche jugée depuis le tronçon
   * voisin doit trouver la même lisière des deux côtés.
   */
  function grandeForet(x, z) {
    return bruit(x, z, BIOMES.forestMacroCell, SALT_MACRO) >= BIOMES.forestMacroLimit;
  }

  /**
   * Zone dominante en un point : `desert`, `plaine` ou `foret`. Fonction pure des
   * coordonnées absolues — un arbre planté à la frontière d'une zone régénérée depuis
   * un autre tronçon doit trouver la même zone des deux côtés.
   */
  function biomeAt(x, z) {
    // La grande forêt commande d'abord : sous une futaie de trois cents cubes, un
    // climat sec ne peut pas décider du sable — ce serait une forêt coupée net en son
    // milieu, et non une zone que l'on traverse à pied.
    if (grandeForet(x, z)) return 'foret';
    const frais = climat(x, z, BIOMES.climateCell, SALT_WET)
      - climat(x, z, BIOMES.climateCell, SALT_HEAT);
    if (frais < BIOMES.dryLimit) return 'desert';
    if (frais > BIOMES.wetLimit) return 'foret';
    return 'plaine';
  }

  /** Densité de peuplement d'un bouquet (0 = clairière, 1 = futaie pleine). */
  function peuplement(x, z) {
    return bruit(x, z, BIOMES.standCell, SALT_STAND);
  }

  /**
   * Bloc de surface et son assise. Le sable gagne sur l'herbe au désert et sous la
   * ligne de grève ; la mousse tapisse le sous-bois là où le peuplement est dense ;
   * au-dessus de la limite des arbres la roche affleure, et la neige coiffe le tout
   * quelle que soit la zone.
   */
  function surfaceFor(x, z, h) {
    if (h >= BIOMES.snowLine) {
      // La neige repose sur la roche là où le versant est déjà nu ; sur un pic isolé de
      // la plaine, elle garde un sol vivant sous sa croûte.
      return { top: BLOCK.SNOW, under: h >= BIOMES.treeLine ? BLOCK.STONE : BLOCK.DIRT };
    }
    if (h >= BIOMES.treeLine) return { top: BLOCK.STONE, under: BLOCK.STONE };
    if (biomeAt(x, z) === 'desert') return { top: BLOCK.SAND, under: BLOCK.SAND };
    // Berges de rivière : du sable, quel que soit le climat autour — une berge d'herbe
    // se déliterait à l'œil contre un plan d'eau.
    if (surCours(x, z)) return { top: BLOCK.SAND, under: BLOCK.SAND };
    if (h <= BIOMES.sandLine) return { top: BLOCK.SAND, under: BLOCK.SAND };
    if (biomeAt(x, z) === 'foret' && peuplement(x, z) > 0.62) {
      return { top: BLOCK.MOSS, under: BLOCK.DIRT };
    }
    return { top: BLOCK.GRASS, under: BLOCK.DIRT };
  }

  /** Souche candidate de la maille (i,j) : position tirée dans la maille, tirage retenu. */
  function candidate(i, j) {
    const ox = i * BIOMES.treeCell + Math.floor(roll(i, 1, j, SALT_POS) * BIOMES.treeCell);
    const oz = j * BIOMES.treeCell + Math.floor(roll(i, 2, j, SALT_POS) * BIOMES.treeCell);
    return { ox, oz, choix: roll(i, 3, j, SALT_PICK) };
  }

  /**
   * La souche est-elle retenue ? Éclaircie déterministe : parmi les candidates assez
   * proches pour se toucher, seule la mieux tirée garde sa place. La comparaison est
   * symétrique — chacun juge son voisin avec le même gain — donc deux souches jointives
   * se réciproquent l'une l'autre et le résultat ne dépend pas de l'ordre de parcours.
   */
  function retenue(c, biome) {
    if (biome === 'desert') return false;
    if (biome === 'plaine') {
      if (c.choix > BIOMES.plainChance) return false;
    } else {
      if (peuplement(c.ox, c.oz) < BIOMES.standMin) return false;
      if (c.choix > BIOMES.standFill) return false;
    }
    const ci = Math.floor(c.ox / BIOMES.treeCell);
    const cj = Math.floor(c.oz / BIOMES.treeCell);
    // Une maille d'écart suffit pour se toucher : la position est tirée dans sa maille,
    // donc deux candidates voisines peuvent n'être qu'à un cube l'une de l'autre.
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue;
        const n = candidate(ci + di, cj + dj);
        const ecart = Math.max(Math.abs(n.ox - c.ox), Math.abs(n.oz - c.oz));
        if (ecart < BIOMES.treeMinGap && n.choix > c.choix) return false;
      }
    }
    return true;
  }

  /** Plan d'un arbre si la souche est bonne, sinon null. Déterministe par colonne. */
  function treeAt(wx, wz) {
    const ci = Math.floor(wx / BIOMES.treeCell);
    const cj = Math.floor(wz / BIOMES.treeCell);
    const c = candidate(ci, cj);
    if (c.ox !== wx || c.oz !== wz) return null;
    const biome = biomeAt(wx, wz);
    if (!retenue(c, biome)) return null;

    const h = relief(wx, wz);
    // Ni sur la grève, ni au-dessus de la limite des arbres : un arbre qui pousserait
    // sur la roche nue contredirait l'étage qu'affiche le revêtement en dessous.
    if (h >= BIOMES.treeLine || h <= BIOMES.sandLine) return null;
    // Sous bois, ce n'est plus le même sujet : la futaie vise le double du verger de
    // plaine qui borde les rues du village. Le garde-tête se prend plus haut, jamais
    // plus bas — `headroom` reste le plancher absolu de la circulation sous feuillage.
    const futaie = biome === 'foret';
    const troncMin = futaie ? BIOMES.futaieTrunkMin : BIOMES.trunkMin;
    const troncMax = futaie ? BIOMES.futaieTrunkMax : BIOMES.trunkMax;
    const grandRayon = futaie ? BIOMES.futaieCrownBigRadius : BIOMES.crownBigRadius;
    const petitRayon = futaie ? BIOMES.futaieCrownRadius : BIOMES.crownRadius;
    // Ni dans une pente raide, ni sur la voirie ni sous un bâti. La sonde court sur la
    // **couronne**, pas sur la seule souche : ses neuf points couvrent le plus grand
    // rayon possible, faute de quoi un pan de feuillage resterait suspendu au-dessus
    // d'une avenue ou scellé dans le mur d'une maison.
    const R = grandRayon;
    for (let dx = -R; dx <= R; dx += R) {
      for (let dz = -R; dz <= R; dz += R) {
        if (Math.abs(relief(wx + dx, wz + dz) - h) > BIOMES.maxSlope) return null;
        if (isBlocked(wx + dx, wz + dz)) return null;
        // Ni souche ni couronne sur un cours d'eau : la boucle sonde la souche et les
        // neuf points de la couronne, donc un chenal qui passe sous l'arbre l'écarte.
        if (surCours(wx + dx, wz + dz)) return null;
      }
    }
    const rayon = roll(wx, 11, wz, SALT_SHAPE)
      < (futaie ? BIOMES.futaieCrownBigChance : BIOMES.crownBigChance) ? grandRayon : petitRayon;
    // La couronne se cale sur le **point haut** de son empreinte, pas sur la souche :
    // sur un versant, caler à quatre cubes du pied ferait pendre le feuillage à deux
    // cubes du sol du voisin du côté montant, et une feuille est solide — on buterait
    // dedans. Le tronc s'allonge d'autant, c'est ce qu'on attend d'un arbre en pente.
    //
    // Et l'empreinte se juge colonne par colonne, non par échantillon : c'est exactement
    // la région où le feuillage sera écrit, alors que la sonde rapide ci-dessus ne tombe
    // qu'à neuf points espacés du plus grand rayon — rien dans ce calcul n'empêche un
    // bord de couronne de retomber sur une avenue de sept colonnes entre deux sondes.
    // (Vérifié en rejouant la suite sur une copie amputée de cette boucle : 0 souche sur
    // la voirie, donc l'échantillonné ne faillissait pas ici — mais ne le garantissait
    // pas.) La couronne déborde d'un cube en diagonale, et c'est ce cube-là qui sinon
    // pendrait au-dessus d'une corniche plus haute que lui.
    let sol = h;
    for (let dx = -rayon - 1; dx <= rayon + 1; dx++) {
      for (let dz = -rayon - 1; dz <= rayon + 1; dz++) {
        const v = relief(wx + dx, wz + dz);
        if (Math.abs(v - h) > BIOMES.maxSlope) return null;
        if (isBlocked(wx + dx, wz + dz)) return null;
        if (surCours(wx + dx, wz + dz)) return null;
        if (v > sol) sol = v;
      }
    }
    const hauteur = troncMin + Math.floor(
      roll(wx, 12, wz, SALT_SHAPE) * (troncMax - troncMin + 1),
    );
    const vide = futaie ? BIOMES.futaieHeadroom : BIOMES.headroom;
    const couronne = Math.max(sol + vide, h + hauteur);   // première assise de feuilles
    const tronc = couronne - h;
    if (tronc > troncMax + BIOMES.maxSlope) return null;
    return { x: wx, z: wz, sol: h, faîte: sol, tronc, rayon, couronne, futaie };
  }

  /** Écrit un bloc s'il ne détruit rien : la végétation pousse dans le vide. */
  function planter(data, cellules, lx, y, lz, id, sol) {
    if (lx < 0 || lz < 0 || lx >= CHUNK_SIZE || lz >= CHUNK_SIZE) return;
    if (y <= sol || y >= CHUNK_HEIGHT) return;
    const idx = lx + lz * CHUNK_SIZE + y * cellules;
    if (data[idx] !== BLOCK.AIR) return;
    data[idx] = id;
  }

  /**
   * Troncs et couronnes d'un tronçon. Les souches candidates débordent de la fenêtre
   * d'un rayon de couronne : un arbre né hors du tronçon y fait malgré tout pendre ses
   * feuilles, sinon les couronnes se couperaient net aux frontières de tronçon.
   */
  function stampVegetation(data, cx, cz) {
    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;
    const cellules = CHUNK_SIZE * CHUNK_SIZE;
    // La marge est le plus grand rayon des deux étages de sujet, pas celui de la plaine :
    // une futaie née à six cubes hors du tronçon fait malgré tout pendre sa couronne ici.
    const marge = Math.max(BIOMES.crownBigRadius, BIOMES.futaieCrownBigRadius) + 1;
    const i0 = Math.floor((baseX - marge) / BIOMES.treeCell);
    const i1 = Math.floor((baseX + CHUNK_SIZE + marge) / BIOMES.treeCell);
    const j0 = Math.floor((baseZ - marge) / BIOMES.treeCell);
    const j1 = Math.floor((baseZ + CHUNK_SIZE + marge) / BIOMES.treeCell);

    // Deux passes : tous les troncs d'abord, toutes les couronnes ensuite. Écrans dans
    // l'autre ordre, le feuillage d'un voisin occupait la cellule où le tronc d'à côté
    // devait monter — `planter` n'écrase rien et le tronc restait amputé (mesuré dès la
    // première suite : deux cubes de bois manquants sur vingt-cinq arbres).
    const sujets = [];
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const c = candidate(i, j);
        const a = treeAt(c.ox, c.oz);
        if (a) sujets.push(a);
      }
    }
    for (const a of sujets) {
      for (let y = a.sol + 1; y <= a.sol + a.tronc; y++) {
        planter(data, cellules, a.x - baseX, y, a.z - baseZ, BLOCK.WOOD, a.sol);
      }
    }
    for (const a of sujets) {
      for (let dy = 0; dy <= 2; dy++) {
        const y = a.couronne + dy;
        if (y >= CHUNK_HEIGHT) break;
        // Couronne en dôme : le rayon se referme en montant, et les angles sont rognés
        // au tirage pour que la silhouette ne soit pas un cube parfait.
        const rayon = dy === 2 ? Math.max(1, a.rayon - 1) : a.rayon;
        for (let dx = -rayon; dx <= rayon; dx++) {
          for (let dz = -rayon; dz <= rayon; dz++) {
            const carreau = Math.abs(dx) + Math.abs(dz);
            if (carreau > rayon + 1) continue;
            if (carreau > rayon && roll(a.x + dx, y, a.z + dz, SALT_SHAPE) < 0.5) continue;
            planter(data, cellules, a.x + dx - baseX, y, a.z + dz - baseZ, BLOCK.LEAVES, a.sol);
          }
        }
      }
    }

    // Désert : une souche morte et des rochers affleurants, rien qui ne se mange.
    const pas = 9;
    const r0 = Math.floor((baseX - pas) / pas);
    const r1 = Math.floor((baseX + CHUNK_SIZE) / pas);
    const s0 = Math.floor((baseZ - pas) / pas);
    const s1 = Math.floor((baseZ + CHUNK_SIZE) / pas);
    for (let i = r0; i <= r1; i++) {
      for (let j = s0; j <= s1; j++) {
        const wx = i * pas + Math.floor(roll(i, 5, j, SALT_SNAG) * pas);
        const wz = j * pas + Math.floor(roll(i, 6, j, SALT_SNAG) * pas);
        if (biomeAt(wx, wz) !== 'desert') continue;
        if (isBlocked(wx, wz)) continue;
        const h = relief(wx, wz);
        if (h >= BIOMES.treeLine) continue;   // rien qui se mange sur la roche nue
        if (h < seaLevel) continue;           // ni rocher ni souche morte au fond de l'eau
        if (surCours(wx, wz)) continue;       // ni dans un lit de rivière ni sur sa berge
        const tirage = roll(wx, 13, wz, SALT_SNAG);
        const lx = wx - baseX;
        const lz = wz - baseZ;
        if (tirage < BIOMES.rockChance) {
          planter(data, cellules, lx, h + 1, lz, BLOCK.COBBLE, h);
          if (roll(wx, 14, wz, SALT_SNAG) < 0.3) planter(data, cellules, lx, h + 2, lz, BLOCK.COBBLE, h);
        } else if (tirage < BIOMES.rockChance + BIOMES.snagChance) {
          planter(data, cellules, lx, h + 1, lz, BLOCK.WOOD, h);
          if (roll(wx, 15, wz, SALT_SNAG) < 0.4) planter(data, cellules, lx, h + 2, lz, BLOCK.WOOD, h);
        }
      }
    }
  }

  return { BIOMES, biomeAt, peuplement, surfaceFor, treeAt, stampVegetation, grandeForet };
}
