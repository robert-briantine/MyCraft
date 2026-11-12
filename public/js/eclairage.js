/**
 * L'éclairage du monde — ce qui vient du ciel, ce qui vient des lampes.
 *
 * Les deux champs sont rendus ici, sans dépendance, pour la même raison que le relief
 * et le village vivent hors de `game.js` : les suites Node jugent exactement ce que le
 * navigateur maillera. Ils sont en plus **purs** — seules les coordonnées et les
 * fonctions de lecture du bloc entrent dans le résultat, jamais un tirage au sort.
 *
 * Pourquoi deux canaux séparés plutôt qu'une seule couleur par sommet : le matériau du
 * terrain est un Lambert dont la couleur de sommet multiplie l'albédo. Si l'obscurité
 * d'une grotte était cuite dans cette seule couleur, une lanterne posée dedans n'aurait
 * plus rien à éclairer — l'albédo noir absorbe aussi sa lumière. Le canal `ciel` éteint
 * donc l'ambiante et le soleil (ils ne traversent pas la roche), le canal `lampe` est
 * rendu en addition derrière l'éclairage, insensible à l'albédo.
 */

/** Échelle de lumière du ciel : 255 à pic sur le ciel, 0 au fond d'une galerie. */
const PLEIN = 255;
/** Ce qui reste au fond d'une galerie : noir, mais pas illisible sous une lampe. */
export const PLANCHER_NUIT = 0.035;
/** Perte de lumière par cube parcouru à l'horizontale. */
const ATTENUATION_H = 26;
/**
 * Perte par cube descendu. La lumière ne tombe **pas** sans perte : mesuré le
 * 2026-11-12, une taille creusée en escalier par le joueur se reéclaircissait à mesure
 * qu'il descendait (97 de luminance à l'entrée, encore 74 huit marches plus bas) — le
 * puits d'accès servait de lanterne à toute la descente. Ce prix ne touche pas un puits
 * droit : ses cellules s'ensemencent déjà pleines, leur colonne entière ouvrant sur le
 * ciel (mesuré 1,00 à neuf cubes). Il frappe la descente en gradins, où chaque marche
 * doit en plus payer le cube qui la sépare de la précédente — à douze par cube descendu
 * et vingt-six par cube de côté, la volée s'éteint avant sa huitième marche.
 */
const ATTENUATION_V = 12;
/** Portée d'une lanterne, en cubes. */
export const LAMPE_PORTEE = 9;
/** Pleine puissance au pied de la lampe. */
const LAMPE_INTENSITE = 1.15;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Fabrique les deux champs pour un tronçon donné.
 *
 * @param {object} reglages
 * @param {number} reglages.CHUNK_SIZE
 * @param {number} reglages.CHUNK_HEIGHT
 * @param {(wx:number,wy:number,wz:number)=>boolean} reglages.opaqueAt bloque la lumière
 * @param {(wx:number,wy:number,wz:number)=>boolean} reglages.rocheAt matériau naturel
 * @param {(id:number)=>boolean} reglages.estLampe source allumée
 * @param {(wx:number,wy:number,wz:number)=>boolean} [reglages.estBati] local d'un
 *        bâtiment du village : ses pièces restent claires, que le plafond soit de bois
 *        ou de pierre — sans cela une tour serait une grotte habitée.
 */
export function creerEclairage({ CHUNK_SIZE, CHUNK_HEIGHT, opaqueAt, rocheAt, estLampe, estBati }) {
  const cells = CHUNK_SIZE * CHUNK_SIZE;
  const volume = cells * CHUNK_HEIGHT;

  /**
   * Lumière du ciel par cellule, 0 (grotte profonde) à 1 (à pic sur le ciel).
   *
   * La lumière **s'écoule** : toute cellule ouverte sur le ciel est pleine, puis elle
   * se propage de proche en proche en perdant `ATTENUATION_H` par cube parcouru à
   * plat et `ATTENUATION_V` par cube descendu — c'est ce qui fait une galerie borgne
   * noire et une taille creusée en descendant qui meurt avant son fond. Un simple
   * relevé de profondeur ne le donnait pas : mesuré, une galerie ouverte sur un ravin
   * restait noire jusqu'à son entrée, faute de propagation sur plusieurs cubes.
   *
   * Deux exemptions, toutes deux mesurées avant d'être écrites :
   *  - une cellule coiffée d'un plafond **bâti** (bois, brique, verre : tout ce qui
   *    n'est pas roche naturelle) reste claire — sinon chaque maison devient une caverne ;
   *  - une cellule tenue pour l'intérieur d'un bâtiment du village reste claire de même :
   *    les tours sont en pierre, et leur première couverture est donc de la roche.
   */
  function champCiel(baseX, baseZ) {
    const niveau = new Uint8Array(volume);          // 0 = obscur, PLEIN = à ciel ouvert
    // File du BFS : chaque cellule n'y entre qu'en s'améliorant, donc quelques entrées
    // par cellule en pratique. La capacité est bornée et un débordement se borne à
    // laisser un coin un peu plus sombre — jamais à écrire hors du tampon.
    const file = new Int32Array(Math.min(volume * 4, 1 << 20));
    let tete = 0, queue = 0;

    // Plafond utile : au-dessus du plus haut bloc opaque du tronçon, tout est plein.
    let toit = 0;
    const topColonne = new Int16Array(cells).fill(-2);
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        let h = -1;
        for (let y = CHUNK_HEIGHT - 1; y >= 0; y--) {
          if (opaqueAt(baseX + lx, y, baseZ + lz)) { h = y; break; }
        }
        topColonne[lx + lz * CHUNK_SIZE] = h;
        if (h > toit) toit = h;
      }
    }

    // Ensemencement : la colonne descend depuis le sommet tant que le vide tient,
    // pleine de lumière. Sous le premier bloc opaque, tout part de zéro et attend le BFS.
    // Seules les cellules sous le toit du tronçon entrent dans la file : au-dessus, les
    // voisines sont pleines d'office et n'ont rien à recevoir de personne.
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const top = topColonne[lx + lz * CHUNK_SIZE];
        for (let y = CHUNK_HEIGHT - 1; y > top; y--) {
          const i = lx + lz * CHUNK_SIZE + y * cells;
          niveau[i] = PLEIN;
          if (y <= toit && queue < file.length) file[queue++] = i;
        }
      }
    }

    const pousser = (i, v) => {
      if (v <= niveau[i]) return;
      niveau[i] = v;
      if (queue < file.length) file[queue++] = i;
    };

    while (tete < queue) {
      const i = file[tete++];
      const v = niveau[i];
      if (v <= Math.max(ATTENUATION_H, ATTENUATION_V)) continue;   // la suite ne donnerait rien de visible
      const y = (i / cells) | 0;
      const r = i - y * cells;
      const lx = r % CHUNK_SIZE;
      const lz = (r - lx) / CHUNK_SIZE;
      const wx = baseX + lx, wz = baseZ + lz;

      // Vers le bas : la lumière suit le vide mais paie chaque cube descendu. Sans ce
      // prix, toute galerie creusée en descendant restait éclairée par sa bouche, quand
      // bien même le joueur avait vingt cubes de roche sur la tête.
      if (y > 0 && !opaqueAt(wx, y - 1, wz)) pousser(i - cells, v - ATTENUATION_V);
      if (y + 1 < CHUNK_HEIGHT && !opaqueAt(wx, y + 1, wz)) pousser(i + cells, v - ATTENUATION_H);
      // Autour : un cube de côté coûte ATTENUATION_H.
      if (lx > 0 && !opaqueAt(wx - 1, y, wz)) pousser(i - 1, v - ATTENUATION_H);
      if (lx + 1 < CHUNK_SIZE && !opaqueAt(wx + 1, y, wz)) pousser(i + 1, v - ATTENUATION_H);
      if (lz > 0 && !opaqueAt(wx, y, wz - 1)) pousser(i - CHUNK_SIZE, v - ATTENUATION_H);
      if (lz + 1 < CHUNK_SIZE && !opaqueAt(wx, y, wz + 1)) pousser(i + CHUNK_SIZE, v - ATTENUATION_H);
    }

    // Les abris bâtits reprennent la pleine lumière : voir l'en-tête de la fonction.
    // Le plafond au-dessus de la cellule se suit en descendant la colonne — le refaire
    // chercher à chaque cellule coûtait une remontée par cellule, soit un coût quadratique
    // par colonne qui portait un remaillage à ~8 ms sous le rasteriseur des tests.
    if (estBati || rocheAt) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const top = topColonne[lx + lz * CHUNK_SIZE];
          const wx = baseX + lx, wz = baseZ + lz;
          let dessus = top;                        // premier bloc opaque strictement au-dessus
          for (let y = top - 1; y >= 0; y--) {
            const i = lx + lz * CHUNK_SIZE + y * cells;
            const bloque = opaqueAt(wx, y, wz);
            if (!bloque && niveau[i] < PLEIN) {
              if (estBati && estBati(wx, y, wz)) {
                niveau[i] = PLEIN;
              } else if (rocheAt) {
                // Une couverture qui n'est pas de la roche naturelle — planches, brique,
                // verre — est un plafond bâti : la pièce reste claire. Exiger **deux**
                // cubes de roche au-dessus du premier bloc opaque laissait la lumière
                // entrer par toute voûte percée d'un vide : mesuré, une galerie scellée
                // tenait la pleine lumière du ciel.
                const couvert = dessus >= 0 && rocheAt(wx, dessus, wz);
                if (!couvert) niveau[i] = PLEIN;
              }
            }
            if (bloque) dessus = y;                 // pour les cellules plus bas, le plafond est ici
          }
        }
      }
    }

    return function ciel(wx, wy, wz) {
      if (wy < 0) return 0;
      if (wy >= CHUNK_HEIGHT) return 1;
      const lx = wx - baseX, lz = wz - baseZ;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) return 1;
      const brut = niveau[lx + lz * CHUNK_SIZE + wy * cells];
      if (brut >= PLEIN) return 1;
      if (brut === 0) return PLANCHER_NUIT;
      return PLANCHER_NUIT + (brut / PLEIN) * (1 - PLANCHER_NUIT);
    };
  }

  /**
   * Champ de lumière artificielle d'un tronçon : pour chaque cellule, la puissance de la
   * lanterne la plus proche, atténuée par le carré de la distance et coupée par les murs.
   *
   * Les lampes viennent de l'appelant — celles du village, données par le générateur (qui
   * seul sait où la voirie passe), et celles posées par le joueur, lues dans le diff. Une
   * lampe du tronçon voisin dont la portée déborde est passée avec sa coordonnée réelle.
   *
   * @param {Array<[number,number,number]>} lampes lanternes allumées (coordonnées monde)
   * @param {number} baseX  @param {number} baseZ  coin du tronçon
   * @returns {Float32Array} puissance par cellule, même index que les données du tronçon
   */
  function champLampes(lampes, baseX, baseZ) {
    const champ = new Float32Array(volume);
    if (!lampes || lampes.length === 0) return champ;
    const R = LAMPE_PORTEE;
    const R2 = R * R;

    for (const [lx, ly, lz] of lampes) {
      const x0 = Math.max(0, Math.floor(lx - R) - baseX);
      const x1 = Math.min(CHUNK_SIZE - 1, Math.ceil(lx + R) - baseX);
      const z0 = Math.max(0, Math.floor(lz - R) - baseZ);
      const z1 = Math.min(CHUNK_SIZE - 1, Math.ceil(lz + R) - baseZ);
      const y0 = Math.max(0, Math.floor(ly - R));
      const y1 = Math.min(CHUNK_HEIGHT - 1, Math.ceil(ly + R));
      if (x1 < x0 || z1 < z0 || y1 < y0) continue;

      for (let y = y0; y <= y1; y++) {
        const dy = y + 0.5 - ly;
        for (let rz = z0; rz <= z1; rz++) {
          const dz = baseZ + rz + 0.5 - lz;
          for (let rx = x0; rx <= x1; rx++) {
            const dx = baseX + rx + 0.5 - lx;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > R2) continue;
            const chute = 1 - Math.sqrt(d2) / R;
            const v = LAMPE_INTENSITE * chute * chute;
            const i = rx + rz * CHUNK_SIZE + y * cells;
            if (v <= champ[i]) continue;
            if (!visuelle(lx, ly, lz, baseX + rx, y, baseZ + rz)) continue;
            champ[i] = v;
          }
        }
      }
    }
    return champ;
  }

  /**
   * La lumière tient-elle le trajet ? Le segment est parcouru **cube par cube**
   * (Amanatides & Woo) et suffit à éteindre une cave fermée tout en laissant passer la
   * porte : sans ce contrôle, une lanterne posée dans une pièce éclairerait la rue.
   *
   * L'échantillonnage à pas fixe avait été retenu d'abord, à cinq points ; il fuyait.
   * Sur une portée de neuf cubes, cinq échantillons espacent les sondes de 2,25 cubes :
   * un mur d'un cube tombé entre deux sondes n'était jamais touché et la lumière le
   * traversait (l'utilisateur : « la lumière dans les maisons passe à travers les murs,
   * on devrait uniquement la voir depuis les fenêtres »). Le parcours intégral ne peut
   * pas manquer une paroi, quelle que soit sa position sur le trajet.
   *
   * Les cellules de départ et d'arrivée ne comptent pas : la lanterne est elle-même un
   * bloc opaque, et juger son échantillon l'éteindrait sur place — mesuré, le pied de
   * chaque lampe restait noir tant que cet échantillon était pris au sérieux.
   */
  function visuelle(fromX, fromY, fromZ, toX, toY, toZ) {
    // Le rayon part du centre de la cellule source et va à celui de la cible : c'est le
    // trajet que suivrait un rayon lumineux, et le seul qui ne fasse pas dépendre le
    // résultat de l'arrondi des coordonnées.
    const ox = fromX + 0.5, oy = fromY + 0.5, oz = fromZ + 0.5;
    let dx = toX - fromX, dy = toY - fromY, dz = toZ - fromZ;
    if (dx === 0 && dy === 0 && dz === 0) return true;
    let x = fromX, y = fromY, z = fromZ;
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    dx = Math.abs(dx); dy = Math.abs(dy); dz = Math.abs(dz);
    // Distance le long de l'axe jusqu'au premier plan franchi, puis pas après pas. Le
    // premier plan est la face aval de la cellule courante, du côté où l'on avance.
    let tx = dx > 0 ? (sx > 0 ? x + 1 - ox : ox - x) / dx : Infinity;
    let ty = dy > 0 ? (sy > 0 ? y + 1 - oy : oy - y) / dy : Infinity;
    let tz = dz > 0 ? (sz > 0 ? z + 1 - oz : oz - z) / dz : Infinity;
    const ux = dx > 0 ? 1 / dx : Infinity;
    const uy = dy > 0 ? 1 / dy : Infinity;
    const uz = dz > 0 ? 1 / dz : Infinity;
    for (let garde = 0; garde < 64; garde++) {
      if (tx <= ty && tx <= tz) { x += sx; tx += ux; }
      else if (ty <= tz) { y += sy; ty += uy; }
      else { z += sz; tz += uz; }
      if (x === toX && y === toY && z === toZ) return true;   // la cible ne se juge pas
      if (opaqueAt(x, y, z)) return false;
    }
    return false;                                             // hors budget : prudence
  }

  /** Lanternes allumées d'un tronçon, relues dans ses données brutes. */
  function lampesDeData(data, baseX, baseZ) {
    const trouves = [];
    for (let i = 0; i < data.length; i++) {
      const id = data[i];
      if (!id || !estLampe(id)) continue;
      const y = (i / cells) | 0;
      const r = i - y * cells;
      const lx = r % CHUNK_SIZE;
      const lz = (r - lx) / CHUNK_SIZE;
      trouves.push([baseX + lx, y, baseZ + lz]);
    }
    return trouves;
  }

  return { champCiel, champLampes, lampesDeData };
}
