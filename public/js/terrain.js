// ===== RELIEF =====
// Le profil du monde, hors moteur de rendu : des plateaux ondulés, des sillons creusés
// par un bruit plissé, et des massifs soulevés à très basse fréquence jusqu'à la ligne
// de neige. Trois termes, trois usages :
//
//  - les **collines** donnent le pays ;
//  - le **sillon** est plissé (`|octave|`) puis entaillé par une sigmoïde : la pente se
//    concentre dans son axe, les épaulements restent plats. C'est ce qui fait des
//    berges franches où un tablier de pont prend appui — sans ce terme, un creux ne
//    descendait que de quatre cubes sous ses berges ;
//  - le **massif** ne soulève rien sous son seuil, puis monte franchement : sans seuil
//    ni sigmoïde, le relief gagnerait deux ou trois cubes partout, ce qui ne se lit pas
//    comme une montagne et rogne la bande où le village a le droit de bâtir ;
//  - le **bassin océanique** est le miroir du massif : il ne creuse rien au-dessus de son
//    seuil, puis s'enfonce par sigmoïde. Sous `seaLevel`, la colonne sera noyée.
//
// Le module ne dépend de rien : on lui passe un bruit (voir `noise.js`) et la hauteur du
// monde, donc les suites Node jugent exactement le relief que le navigateur dessine.

export const RELIEF = {
  baseHeight: 26,      // altitude moyenne des plateaux
  baseAmp: 10,         // ampleur du bruit large
  hillsAmp: 15,        // ampleur des collines basse fréquence
  detailAmp: 2,        // grain à haute fréquence, écrêté sur les versants
  valleyWidth: 0.28,   // au-delà, on est sur le plateau : plus de creusement
  valleyDepth: 16,     // cubes retirés au fond du sillon
  valleyFreq: 0.01,    // un sillon tous les ~100 cubes : assez serré pour qu'une avenue
                       // trouve une berge à portée de tablier
  minGround: 6,        // jamais de trou jusqu'au vide sous le monde
  ceilingMargin: 8,    // marge sous le sommet du monde : la tête du joueur garde sa place

  mountainFreq: 0.0016,       // un massif tous les ~600 cubes
  mountainThreshold: 0.16,    // sous cette valeur, le plateau reste un plateau
  mountainLift: 26,           // relèvement maximal au cœur du massif
  mountainCrag: 3,            // arêtes ajoutées sur les hauteurs : un sommet plat n'est pas un sommet
  mountainCragFreq: 0.005,    // arêtes larges : du relief, pas du gravier
  mountainGrainFade: 18,      // le grain disparaît à mesure qu'on monte

  // Mer. `seaLevel` est la seule référence du projet : le village n'y bâtit pas, le
  // sable la borde (la ligne de sable du biome est à 20, soit quatre cubes de plage),
  // l'eau la remplit jusqu'à ce cube inclus. La couverture se lit sur les coordonnées
  // **entières** des colonnes — celles de la génération ; sonder au centre d'une colonne
  // (`x + 0,5`) annonce une autre valeur, le bruit de détail étant évalué en position
  // exacte. Chiffres mesurés ainsi sur le monde du jeu : ~32 % des colonnes immergées,
  // profondeur médiane 6 cubes, p90 11, plus grande nappe jointoyante ~290×290 cubes.
  seaLevel: 16,
  oceanFreq: 0.0011,          // un bassin tous les ~900 cubes : une mer, pas une flaque
  oceanThreshold: -0.10,      // au-dessus, la terre tient haut : rien de noyé
  oceanDepth: 12,             // cubes retirés au cœur du bassin (le plancher reste à minGround)
  oceanFade: 0.30,            // largeur de la sigmoïde : des épaulements plats, une pente franche
  shoreGrainFade: 5,          // le grain se retire à l'approche de la ligne d'eau

  // Rivières. Un cours d'eau est **intégré** depuis une source : on part d'un point tiré
  // dans une cellule d'une grille grossière et on descend la pente du relief, pas à pas,
  // jusqu'à la mer. Deux modèles à peigne angulaire ont été essayés avant celui-là (axes
  // du `-∇champ marin`, puis `-∇relief`) : tous deux donnaient des cours rompus — le
  // premier butait sur toute crête traversant le tracé et s'arrêtait à trente cubes
  // d'altitude, le second se brisait à chaque replat, et aucun des cours de deux cents à
  // cinq cents colonnes ne joignait la mer. Une ligne intégrée est continue par
  // construction. Le déterminisme tient parce que l'intégration ne dépend que de la
  // cellule de départ : le cache qui la mémorise est une mémoïsation, jamais un état du
  // monde — l'ordre des requêtes ne change rien au résultat.
  riverCell: 110,             // pas de la grille des sources (contrôle principal de la densité)
  riverChance: 0.8,           // probabilité qu'une cellule tente une source
  // Une source se prend dans les hauteurs et sur une pente moyenne : tirée trop bas, elle
  // rejoint la mer en huit pas et le tracé est rejeté pour cause de cours trop court ;
  // posée sur une paroi, elle dévale vingt cubes en trente et ne dessine qu'un torrent.
  // Les bornes viennent de la mesure sur ce relief plissé : la pente lissée sur
  // cinquante-deux cubes y a une médiane à 0,30 (dix pour cent sous 0,12) et le ressaut
  // local une médiane à trois cubes — un relief dur, donc des seuils hauts. Avec ceux-ci,
  // trente cellules sur quatre-vingt-un donnent une source.
  riverSourceClear: 10,       // au moins dix cubes au-dessus de la mer
  riverTries: 8,              // points tentés par cellule avant de renoncer
  riverSourceSlope: 1 / 40,
  riverSourceSlopeMax: 1 / 4,
  riverSourceStep: 3,         // ressaut maximal entre deux pas d'intégration à la source
  riverStep: 4,               // cubes par pas d'intégration
  // Portée d'un cours : le plus long mesuré descendait de trente-et-un à dix-sept cubes
  // en épuisant les cent soixante pas précédents, sans atteindre la mer. Le budget doit
  // couvrir un méandre complet sur une pente douce (~1600 cubes).
  riverMaxSteps: 400,         // portée maximale d'un cours
  riverMomentum: 0.6,         // inertie de la direction : sans elle, le grain du sol fait
                              // zigzaguer le tracé et le lit se mitraille
  riverStuck: 6,              // pas consécutifs sans pente avant d'abandonner le tracé
  riverDrift: 150,            // au-delà de ce nombre de pas, il faut avoir perdu...
  riverDriftDrop: 10,         // ...au moins ces cubes de hauteur, sinon le tracé est avorté
  riverMinSteps: 20,          // en dessous, ce n'est pas un cours, c'est une flaque
  riverBucket: 32,            // emprise de l'index spatial des points de tracé
  riverGradStep: 26,          // emprise des différences finies sur la hauteur (lissage)
  riverWidthMin: 4,           // largeur du lit à la source
  riverWidthMax: 8,           // largeur du lit à l'embouchure
  riverDepth: 5,              // cubes entre la surface de l'eau et le fond du lit
  // Berges : le retour au terrain naturel doit rester franchissable **à pied**. Un
  // marcheur ne monte qu'un cube par colonne, et la sigmoïde rend le milieu de berge
  // plus raide que la moyenne : à profondeur 5, il faut huit colonnes pour que la pente
  // crête reste sous le cube. Trois colonnes dressaient un mur — sorti de l'eau sur la
  // berge, le joueur restait `onGround` faux sans pouvoir gravir les cinq cubes d'un coup.
  riverBank: 8,
  riverFade: 10,              // pas refermant le lit à la source (le lit naît peu profond)
};

/**
 * @param {object} deps
 * @param {{noise2D:(x:number,y:number)=>number, octave:(x:number,y:number,oct?:number,persist?:number)=>number}} deps.noise
 * @param {number} [deps.chunkHeight] hauteur du monde, pour le plafond du relief
 */
export function createTerrain({ noise, chunkHeight = 64 }) {
  const plafond = chunkHeight - RELIEF.ceilingMargin;

  /** Relèvement dû au massif, en cubes (0 sur la majeure partie de la carte). */
  function massifLift(x, z) {
    const m = noise.octave(x * RELIEF.mountainFreq, z * RELIEF.mountainFreq, 3, 0.5);
    if (m <= RELIEF.mountainThreshold) return 0;
    const t = Math.min(1, (m - RELIEF.mountainThreshold) / (1 - RELIEF.mountainThreshold));
    const socle = RELIEF.mountainLift * t * t * (3 - 2 * t);
    if (t < 0.45) return Math.round(socle);
    // Les arêtes n'interviennent que sur les hauteurs : ajouter du roc dans la plaine
    // n'y servirait à rien et casserait la douceur des approches.
    const crag = Math.abs(noise.noise2D(x * RELIEF.mountainCragFreq, z * RELIEF.mountainCragFreq));
    return Math.round(socle + RELIEF.mountainCrag * crag * t);
  }

  /**
   * Champ large dont les minima sont les bassins marins. `oceanBasin` y puise son
   * creusement, les rivières y puisent leur direction : c'est le même champ, donc un
   * cours d'eau descend exactement vers la mer qui l'entoure.
   */
  function oceanField(x, z) {
    return noise.octave((x + 5200) * RELIEF.oceanFreq, (z - 3100) * RELIEF.oceanFreq, 3, 0.5);
  }

  /**
   * Creusement dû au bassin océanique, en cubes (0 sur les terres hautes). Miroir du
   * massif, donc mêmes formes : rien sous le seuil, une sigmoïde ensuite — c'est ce qui
   * fait de larges plateaux côtiers plats plutôt qu'une pente continue où chaque colonne
   * perdrait un cube. Le champ est pris sur des coordonnées décalées : sans ce décalage,
   * océans et massifs partageraient le même bruit et la mer ne s'ouvrirait que dans les
   * vallées, là où le relief est déjà bas.
   */
  function oceanBasin(x, z) {
    const c = oceanField(x, z);
    if (c >= RELIEF.oceanThreshold) return 0;
    const t = Math.min(1, (RELIEF.oceanThreshold - c) / (RELIEF.oceanThreshold + RELIEF.oceanFade));
    return RELIEF.oceanDepth * t * t * (3 - 2 * t);
  }

  function rawHeight(x, z) {
    const base = noise.octave(x * 0.01, z * 0.01, 5, 0.5);
    const hills = noise.octave(x * 0.003, z * 0.003, 3, 0.4) * RELIEF.hillsAmp;
    const ridge = Math.abs(noise.octave(x * RELIEF.valleyFreq, z * RELIEF.valleyFreq, 2, 0.5));
    const t = Math.min(1, ridge / RELIEF.valleyWidth);
    const valley = 1 - t * t * (3 - 2 * t);
    const lift = massifLift(x, z);
    const sink = oceanBasin(x, z);
    // Le grain se retire à mesure qu'on monte : laissé entier, il suffisait à créer un
    // ressaut de deux cubes tous les dix pas sur un versant, et le marcheur — qui ne
    // franchit qu'un cube par colonne — butait sur une pente pourtant douce. Même raison
    // au bord de l'eau : ±2 cubes de grain sur la ligne de rivage suffisaient à dresser
    // un ressaut de deux cubes entre la dernière colonne noyée et la plage, et on
    // restait pris dans la mer sans pouvoir en sortir.
    const presDuRivage = Math.abs(RELIEF.baseHeight + base * RELIEF.baseAmp + hills
      - RELIEF.valleyDepth * valley + lift - sink - RELIEF.seaLevel);
    const rive = Math.min(1, Math.max(0.2, presDuRivage / RELIEF.shoreGrainFade));
    const grain = (lift > 0 ? Math.max(0.25, 1 - lift / RELIEF.mountainGrainFade) : 1) * rive;
    const detail = noise.noise2D(x * 0.05, z * 0.05) * RELIEF.detailAmp * grain;
    const h = RELIEF.baseHeight + base * RELIEF.baseAmp + hills
      - RELIEF.valleyDepth * valley + detail + lift - sink;
    return Math.max(RELIEF.minGround, Math.min(plafond, Math.floor(h)));
  }

  // ---- rivières ------------------------------------------------------------
  /**
   * Direction aval du relief, lissée : `atan2` de `-∇hauteur`, différences finies prises
   * sur `riverGradStep` cubes — l'emprise large fait office de lissage, la hauteur brute
   * étant entière et donc pleine de grain. Renvoie aussi la pente suivie : sans pente, il
   * n'y a pas d'écoulement, donc pas de rivière.
   */
  function aval(x, z) {
    const e = RELIEF.riverGradStep;
    const gx = rawHeight(x + e, z) - rawHeight(x - e, z);
    const gz = rawHeight(x, z + e) - rawHeight(x, z - e);
    const n = Math.hypot(gx, gz);
    if (!(n > 0)) return null;
    return { dx: -gx / n, dz: -gz / n, pente: n / (2 * e) };
  }

  /** Tirage déterministe dans [-1,1] : le bruit de Simplex sert de fonction de hachage. */
  function tire(i, j, k) {
    return noise.noise2D(i * 12.9898 + 78.233 * (k + 1), j * 78.233 + 12.9898 * (k + 2));
  }

  const traceCache = new Map();   // cellule de source → tracé (mémoïsation pure)
  const seauCache = new Map();    // tuile d'index → tracés qui la traversent

  /**
   * Le tracé né dans la cellule (i,j), ou `null`. On part d'un point tiré dans la cellule
   * et on descend la pente, pas à pas, en gardant l'inertie de la direction : sans elle,
   * le grain du sol — la hauteur est entière — fait zigzaguer le pas suivant et le lit
   * se mitraille. La surface ne peut que descendre (`Math.min`), ce qui remplace le
   * regard en aval du modèle précédent : l'eau ne remonte jamais son propre cours.
   */
  function trace(i, j) {
    const cle = `${i},${j}`;
    if (traceCache.has(cle)) return traceCache.get(cle);
    let r = null;
    if (0.5 + 0.5 * tire(i, j, 0) <= RELIEF.riverChance) {
      // Plusieurs points tentés par cellule : le relief plissé ne présente qu'en de rares
      // endroits une hauteur franche et une pente moyenne à la fois, et un seul tirage
      // laissait la presque totalité des cellules sans rivière.
      let x = null, z = null, h0 = 0, a0 = null;
      for (let c = 0; c < RELIEF.riverTries; c++) {
        const px = (i + 0.2 + 0.6 * (0.5 + 0.5 * tire(i, j, 1 + 2 * c))) * RELIEF.riverCell;
        const pz = (j + 0.2 + 0.6 * (0.5 + 0.5 * tire(i, j, 2 + 2 * c))) * RELIEF.riverCell;
        const h = rawHeight(px, pz);
        const a = aval(px, pz);
        // Le gradient lissé ne voit pas les parois étroites : de part et d'autre d'un
        // sillon plissé les deux sondes se répondent et annoncent une pente nulle alors
        // qu'il y a une falaise entre elles. D'où le contrôle de ressaut local, à un pas
        // d'intégration — sans lui la source atterrissait sur une paroi et le tracé
        // s'achevait trois pas plus bas, vingt cubes plus bas.
        const saut = Math.max(
          Math.abs(rawHeight(px + RELIEF.riverStep, pz) - h),
          Math.abs(rawHeight(px - RELIEF.riverStep, pz) - h),
          Math.abs(rawHeight(px, pz + RELIEF.riverStep) - h),
          Math.abs(rawHeight(px, pz - RELIEF.riverStep) - h));
        if (h >= RELIEF.seaLevel + RELIEF.riverSourceClear && a
          && a.pente >= RELIEF.riverSourceSlope && a.pente <= RELIEF.riverSourceSlopeMax
          && saut <= RELIEF.riverSourceStep) {
          x = px; z = pz; h0 = h; a0 = a;
          break;
        }
      }
      if (x !== null) {
        const pts = [];
        const elargis = 0.5 + 0.5 * tire(i, j, 3);
        let dx = a0.dx, dz = a0.dz, surface = h0, sansPente = 0, avorte = false;
        for (let k = 0; k < RELIEF.riverMaxSteps; k++) {
          surface = Math.min(surface, rawHeight(x, z));
          pts.push({ x, z, surface, k });
          if (surface <= RELIEF.seaLevel) break;             // déversé : le cours est fini
          // Un tracé qui parcourt cent cinquante pas en ne perdant que dix cubes n'est pas
          // une rivière mais une divagation de plateau : il finirait suspendu en rase
          // campagne. On l'avorte plutôt que de le tronquer — un cours coupé est un lac.
          if (k > RELIEF.riverDrift && h0 - surface < RELIEF.riverDriftDrop) { avorte = true; break; }
          const a = aval(x, z);
          if (a && a.pente > 0) {
            dx = dx * RELIEF.riverMomentum + a.dx * (1 - RELIEF.riverMomentum);
            dz = dz * RELIEF.riverMomentum + a.dz * (1 - RELIEF.riverMomentum);
            sansPente = 0;
          } else if (++sansPente >= RELIEF.riverStuck) break;
          const n = Math.hypot(dx, dz);
          if (!(n > 0)) break;
          x += dx / n * RELIEF.riverStep;
          z += dz / n * RELIEF.riverStep;
        }
        if (!avorte && pts.length >= RELIEF.riverMinSteps) {
          const seaux = new Map();
          const bout = pts.length - 1;
          for (const p of pts) {
            const t = bout > 0 ? p.k / bout : 1;
            // Le lit s'élargit vers l'aval et se referme à la source : une rivière ne
            // jaillit pas à sa pleine largeur.
            const fondu = Math.min(1, p.k / RELIEF.riverFade);
            const largeur = RELIEF.riverWidthMin
              + (RELIEF.riverWidthMax - RELIEF.riverWidthMin) * (0.4 * t + 0.6 * elargis);
            p.demi = largeur / 2 * fondu;
            p.portee = p.demi + RELIEF.riverBank * fondu;
            p.fond = Math.max(RELIEF.minGround, p.surface - RELIEF.riverDepth * fondu);
            const b = `${Math.floor(p.x / RELIEF.riverBucket)},${Math.floor(p.z / RELIEF.riverBucket)}`;
            let idx = seaux.get(b);
            if (!idx) seaux.set(b, idx = []);
            idx.push(p);
          }
          r = { pts, seaux };
        }
      }
    }
    traceCache.set(cle, r);
    return r;
  }

  /** Tracés susceptibles de toucher la colonne : ceux dont un point tombe à portée. */
  function tracesAutourDe(x, z) {
    const b = RELIEF.riverBucket;
    const bx = Math.floor(x / b), bz = Math.floor(z / b);
    const cle = `${bx},${bz}`;
    const connu = seauCache.get(cle);
    if (connu) return connu;
    const cles = [];
    for (let u = -1; u <= 1; u++) for (let v = -1; v <= 1; v++) cles.push(`${bx + u},${bz + v}`);
    const rayon = RELIEF.riverMaxSteps * RELIEF.riverStep + b;
    const i0 = Math.floor((x - rayon) / RELIEF.riverCell), i1 = Math.floor((x + rayon) / RELIEF.riverCell);
    const j0 = Math.floor((z - rayon) / RELIEF.riverCell), j1 = Math.floor((z + rayon) / RELIEF.riverCell);
    const liste = [];
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const t = trace(i, j);
        if (t && cles.some((c) => t.seaux.has(c))) liste.push(t);
      }
    }
    seauCache.set(cle, liste);
    return liste;
  }

  /**
   * Le lit au droit d'une colonne, ou `null` hors d'un cours d'eau.
   * `{ surface, fond, demiLargeur, berge, d }` — mêmes champs qu'avant, les appelants
   * (remplissage d'eau, berges du biome, gardes du village) n'ont rien à changer.
   *
   * La distance se mesure aux **segments** reliant deux pas d'intégration, non aux seuls
   * sommets : les points sont espacés de quatre cubes alors que le lit en fait quatre à
   * huit, et juger sur les sommets laissait des trous — le cours sortait en pointillés de
   * quelques colonnes, surtout près de la source où le lit est étroit.
   */
  function riverAt(x, z) {
    const b = RELIEF.riverBucket;
    const bx = Math.floor(x / b), bz = Math.floor(z / b);
    let meilleur = null;
    for (const t of tracesAutourDe(x, z)) {
      for (let u = -1; u <= 1; u++) {
        for (let v = -1; v <= 1; v++) {
          const idx = t.seaux.get(`${bx + u},${bz + v}`);
          if (!idx) continue;
          for (const p of idx) {
            const q = t.pts[p.k + 1];
            let d, pt = p;
            if (q) {
              // Distance au segment [p, q] : projection bornée aux extrémités.
              const vx = q.x - p.x, vz = q.z - p.z;
              const long = vx * vx + vz * vz;
              const tparam = long > 0 ? Math.max(0, Math.min(1, ((x - p.x) * vx + (z - p.z) * vz) / long)) : 0;
              d = Math.hypot(x - (p.x + vx * tparam), z - (p.z + vz * tparam));
              // Le plan d'eau suit la pente entre les deux sommets, sans jamais remonter.
              if (tparam > 0.5 && q.surface < p.surface) pt = q;
            } else {
              d = Math.hypot(x - p.x, z - p.z);
            }
            if (d >= p.portee) continue;
            if (!meilleur || d / p.portee < meilleur.d / meilleur.berge) {
              meilleur = { surface: pt.surface, fond: pt.fond, demiLargeur: p.demi, berge: p.portee, d };
            }
          }
        }
      }
    }
    return meilleur;
  }

  /**
   * Sol réellement posé : le relief, évidé par les lits de rivière. La section suit une
   * sigmoïde depuis le fond jusqu'au terrain naturel sur les berges — jamais le sol
   * n'est rechargé au-dessus de son niveau : combler ferait une digue, et l'eau
   * resterait suspendue à côté.
   */
  function groundAt(x, z) {
    const h = rawHeight(x, z);
    const riv = riverAt(x, z);
    if (!riv) return h;
    const horsLit = riv.berge - riv.demiLargeur;
    const t = Math.min(1, Math.max(0, (riv.d - riv.demiLargeur) / Math.max(1e-6, horsLit)));
    const sol = riv.fond + (h - riv.fond) * (t * t * (3 - 2 * t));
    return Math.max(RELIEF.minGround, Math.min(h, Math.floor(sol)));
  }

  /** Plan d'eau de la colonne : la mer, ou le plan local du cours d'eau si elle en porte un. */
  function waterTopAt(x, z) {
    const riv = riverAt(x, z);
    return riv ? Math.max(RELIEF.seaLevel, riv.surface) : RELIEF.seaLevel;
  }

  return { heightAt: groundAt, rawHeight, riverAt, waterTopAt, massifLift, oceanBasin, RELIEF };
}
