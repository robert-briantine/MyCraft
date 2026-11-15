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
/**
 * Ce qui reste dans une cellule scellée **sous une couverture mince** — le plafond
 * d'une pièce que le joueur vient de couvrir d'un cube de pierre. Mesuré avant d'être
 * écrit : à 0,035 comme la mine, poser le dernier cube d'un toit faisait basculer la
 * pièce du plein jour au noir, alors qu'elle donne sur l'air par ses murs. La nuance
 * vient donc de l'épaisseur de ce qui couvre, pas de la seule absence de trajet.
 */
export const PLANCHER_PIECE = 0.24;
/**
 * Couverture la plus épaisse encore tenue pour un plafond de pièce, en roches.
 * Borné par deux suites qui se répondent : `tests/eclairage.mjs` veut qu'un cube de
 * pierre laisse la pièce lisible, `tests/ciel.mjs` veut que **deux** roches fassent déjà
 * une grotte. Au-delà de ce cube, c'est le noir de galerie qui reprend.
 */
export const COUVERTE_MINCE = 1;
/**
 * Compression perceptuelle de la lumière du ciel. Linéaire, une moitié de champ rendait
 * une image déjà lue comme noire : l'œil suit une puissance, pas une droite.
 */
const GAMME_CIEL = 0.75;
/** Écart de luminance sur une paroi partagée qui justifie de re-mailler le voisin. */
export const SEUIL_MUR = 8;
/** Perte de lumière par cube parcouru à l'horizontale. */
const ATTENUATION_H = 26;
/**
 * Portée utile d'une modification d'opacité, en cubes : au-delà, la lumière qu'elle
 * libère ou bloque est déjà éteinte (`PLEIN / ATTENUATION_H`). C'est le rayon auquel
 * un éditeur doit prévenir les tronçons voisins.
 */
export const PORTEE_CIEL = Math.ceil(255 / ATTENUATION_H);
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
  const R = LAMPE_PORTEE;
  const R2 = R * R;

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
   *
   * @param {number} baseX @param {number} baseZ coin du tronçon
   * @param {object} [voisins] luminance déjà calculée des quatre tronçons attenants,
   *        chacune indexée comme `plan[u + y * CHUNK_SIZE]` dans le repère **du
   *        tronçon courant** (`u` = lz pour ouest/est, lx pour nord/sud) et lue sur la
   *        cellule collée à la paroi partagée. Sans elles, le champ reste clos sur son
   *        tronçon et la lumière ne franchit jamais la frontière.
   * @returns {(wx:number,wy:number,wz:number)=>number & {niveau:Uint8Array}} la lecture
   *        colorimétrique d'une cellule, assortie du champ **propagé** en `niveau` —
   *        celui-ci ignore les exemptions de couverture et se garde tel quel pour
   *        servir de graine aux voisins au remaillage suivant.
   */
  function champCiel(baseX, baseZ, voisins) {
    const niveau = new Uint8Array(volume);          // 0 = obscur, PLEIN = à ciel ouvert
    const couvert = new Uint8Array(volume);         // roches au-dessus de la cellule, saturé à 15
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

    // La lumière entre aussi **par les murs**. Sans ces graines frontalières, chaque
    // tronçon calculait son champ clos sur lui-même : mesuré le 2026-11-14, une pièce
    // scellée à cheval sur la frontière x = 320 voyait son cube de mur ôté éclairer la
    // moitié gauche (0,35 à 0,62) et laisser la droite à 0,035 — remaillage forcé
    // compris, puisque le BFS n'avait jamais le droit de franchir le bord. Les plans
    // reçus viennent du voisin déjà maillé, atténués d'un cube pour la traversée.
    if (voisins) {
      // La greffe ne se pose que dans du vide : une cellule pleine de roche à la
      // frontière n'a rien à recevoir, sous peine de conduire la lumière à travers le
      // mur jusqu'à la galerie scellée qui est derrière.
      const greffer = (wx, wy, wz, i, brut) => {
        if (brut <= ATTENUATION_H) return;
        if (opaqueAt(wx, wy, wz)) return;
        pousser(i, brut - ATTENUATION_H);
      };
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const i0 = lz * CHUNK_SIZE, i1 = (CHUNK_SIZE - 1) + lz * CHUNK_SIZE;
        const wxO = baseX - 1, wxE = baseX + CHUNK_SIZE, wz = baseZ + lz;
        for (let y = 0; y < CHUNK_HEIGHT; y++) {
          const p = lz + y * CHUNK_SIZE;
          const i = y * cells;
          if (voisins.ouest && !opaqueAt(wxO, y, wz)) greffer(baseX, y, wz, i0 + i, voisins.ouest[p]);
          if (voisins.est && !opaqueAt(wxE, y, wz)) greffer(baseX + CHUNK_SIZE - 1, y, wz, i1 + i, voisins.est[p]);
        }
      }
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const i0 = lx, i1 = lx + (CHUNK_SIZE - 1) * CHUNK_SIZE;
        const wx = baseX + lx, wzN = baseZ - 1, wzS = baseZ + CHUNK_SIZE;
        for (let y = 0; y < CHUNK_HEIGHT; y++) {
          const p = lx + y * CHUNK_SIZE;
          const i = y * cells;
          if (voisins.nord && !opaqueAt(wx, y, wzN)) greffer(wx, y, baseZ, i0 + i, voisins.nord[p]);
          if (voisins.sud && !opaqueAt(wx, y, wzS)) greffer(wx, y, baseZ + CHUNK_SIZE - 1, i1 + i, voisins.sud[p]);
        }
      }
    }

    while (tete < queue) {
      const i = file[tete++];
      const v = niveau[i];
      if (v <= Math.max(ATTENUATION_H, ATTENUATION_V)) continue;   // la suite ne donnerait rien de visible
      const y = (i / cells) | 0;
      const r = i - y * cells;
      const lx = r % CHUNK_SIZE;
      const lz = (r - lx) / CHUNK_SIZE;
      const wx = baseX + lx, wz = baseZ + lz;
      // Une cellule pleine ne conduit pas la lumière. Sans ce contrôle, seul le point de
      // chute était jugé : la roche collée à un passage ensoleillé recevait le jour puis
      // le redistribuait de l'autre côté, et une galerie scellée de dix roches tenait
      // 26,6 de bande haute au lieu de 3,6 (référence sans tronçons : jamais atteinte).
      if (opaqueAt(wx, y, wz)) continue;

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

    // Les abris bâtis reprennent la pleine lumière : voir l'en-tête de la fonction.
    // Le plafond au-dessus de la cellule se suit en descendant la colonne — le refaire
    // chercher à chaque cellule coûtait une remontée par cellule, soit un coût quadratique
    // par colonne qui portait un remaillage à ~8 ms sous le rasteriseur des tests. La
    // descente compte aussi les roches au-dessus de chaque cellule (`couvert`), d'où
    // qu'elle coure même sans prédicat de couverture.
    const jugerCouverture = !!(estBati || rocheAt);
    // Les exemptions ne doivent **pas** franchir la frontière : elles jugent la
    // couverture propre d'une cellule (sable, planches, intérieur de village), pas ce
    // que la lumière a réellement traversé. Exportées telles quelles aux voisins, une
    // plage de sable suffisait à diffuser la pleine lumière du ciel dans les galeries
    // attenantes — mesuré le 2026-11-14, une poche scellée de dix roches rendait 26,6
    // de bande haute au lieu de 3,6. Le champ donné aux tronçons voisins reste donc le
    // seul résultat du BFS (`niveau`), les exemptions ne vivent que dans `rendu`.
    const rendu = niveau.slice();
    {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const top = topColonne[lx + lz * CHUNK_SIZE];
          const wx = baseX + lx, wz = baseZ + lz;
          let dessus = top;                        // premier bloc opaque strictement au-dessus
          // Descente depuis le toit du tronçon : au-dessus, tout est vide et `couvert`
          // vaut déjà 0, ce qui est la bonne réponse. Compter les roches au passage ne
          // coûte qu'un incrément et rend la nuance pièce / mine possible.
          let roches = 0;
          for (let y = Math.min(toit, CHUNK_HEIGHT - 1); y >= 0; y--) {
            const i = lx + lz * CHUNK_SIZE + y * cells;
            const bloque = opaqueAt(wx, y, wz);
            couvert[i] = roches < 15 ? roches : 15;
            if (jugerCouverture && !bloque && rendu[i] < PLEIN) {
              if (estBati && estBati(wx, y, wz)) {
                rendu[i] = PLEIN;
              } else if (rocheAt) {
                // Une couverture qui n'est pas de la roche naturelle — planches, brique,
                // verre — est un plafond bâti : la pièce reste claire. Exiger **deux**
                // cubes de roche au-dessus du premier bloc opaque laissait la lumière
                // entrer par toute voûte percée d'un vide : mesuré, une galerie scellée
                // tenait la pleine lumière du ciel.
                const rocheAuDessus = dessus >= 0 && rocheAt(wx, dessus, wz);
                if (!rocheAuDessus) rendu[i] = PLEIN;
              }
            }
            if (bloque) { dessus = y; roches++; }   // pour les cellules plus bas, le plafond est ici
          }
        }
      }
    }

    // Table de réponse plutôt qu'un `Math.pow` par sommet : 256 entrées une fois par
    // remaillage, et la lecture d'une face revient à un index.
    const table = new Float32Array(PLEIN + 1);
    for (let b = 0; b <= PLEIN; b++) table[b] = Math.pow(b / PLEIN, GAMME_CIEL);

    /**
     * Luminance propagée de la cellule collée JUSTE hors du tronçon, lue sur la paroi
     * que le voisin déjà maillé a gardée. `null` quand ce voisin n'a encore rien
     * calculé — auquel cas la face du bord n'a rien à recevoir et reste au noir.
     */
    const brutVoisin = (lx, lz, y) => {
      if (!voisins) return null;
      const horizontal = lx < 0 || lx >= CHUNK_SIZE;
      const p = horizontal ? (lx < 0 ? voisins.ouest : voisins.est) : (lz < 0 ? voisins.nord : voisins.sud);
      if (!p) return null;
      const brut = horizontal ? lz : lx;
      const u = brut < 0 ? 0 : brut >= CHUNK_SIZE ? CHUNK_SIZE - 1 : brut;
      return p[u + y * CHUNK_SIZE];
    };

    const ciel = function (wx, wy, wz) {
      if (wy < 0) return 0;
      if (wy >= CHUNK_HEIGHT) return 1;
      const lx = wx - baseX, lz = wz - baseZ;
      const dedans = lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE;
      // Une face donnée au voisin se juge sur la cellule du voisin, pas sur la nôtre :
      // rendre 1 ici peignait le plein jour sur toute la couture, y compris à six cubes
      // sous la surface (mesuré 0,495 de luminance cuite le long des murs d'un tronçon
      // isolé contre 0,037 à l'intérieur). La couverture prise en compte est celle de la
      // cellule la plus proche de nous : même toit de chaque côté de la paroi.
      const rx = lx < 0 ? 0 : lx >= CHUNK_SIZE ? CHUNK_SIZE - 1 : lx;
      const rz = lz < 0 ? 0 : lz >= CHUNK_SIZE ? CHUNK_SIZE - 1 : lz;
      const i = rx + rz * CHUNK_SIZE + wy * cells;
      const brut = dedans ? rendu[i] : brutVoisin(lx, lz, wy);
      if (brut === null || brut === undefined) return PLANCHER_NUIT;
      if (brut >= PLEIN) return 1;
      // Une cellule sous une couverture mince est une pièce, pas une mine : elle garde
      // assez d'albédo pour se lire sans lanterne. Au-delà, c'est le noir de galerie.
      const residu = couvert[i] <= COUVERTE_MINCE ? PLANCHER_PIECE : PLANCHER_NUIT;
      if (brut === 0) return residu;
      return residu + table[brut] * (1 - residu);
    };
    // La lecture se présente comme une fonction — c'est ce que l'appelant appelle, sommet
    // après sommet — et le champ brut qu'elle a servi voyant avec elle en propriété :
    // `majMurs` en remplit les parois que les tronçons voisins viendront gratter.
    ciel.niveau = niveau;
    return ciel;
  }

  /**
   * Ce que la lampe donnerait à cette cellule si rien ne la masquait : 0 hors de portée.
   * Le test de visibilité est séparé parce que l'appelant bulk l'évite quand la cellule
   * tient déjà plus clair — le rayon est la partie chère du calcul.
   */
  function brutLampe(lx, ly, lz, wx, wy, wz) {
    const dx = wx + 0.5 - lx, dy = wy + 0.5 - ly, dz = wz + 0.5 - lz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > R2) return 0;
    const chute = 1 - Math.sqrt(d2) / R;
    return LAMPE_INTENSITE * chute * chute;
  }

  /**
   * Puissance reçue par une cellule hors du tronçon qui maille. La face d'un bloc donné
   * au voisin se juge sur la cellule du voisin : sans cette lecture, elle restait au noir
   * et chaque couture de tronçon barrait la cave d'une bande noire — mesuré le 2026-11-15,
   * les deux faces d'un même pilier sous une applique valaient 0,24 et 0. Elle est jugée
   * à la volée sur le monde réel plutôt que lue dans un champ gardé par le voisin, pour
   * qu'aucun ordre de maillage ne puisse laisser la bande en place.
   *
   * @param {Array<[number,number,number]>} lampes lanternes allumées (coordonnées monde)
   */
  function puissanceLampe(lampes, wx, wy, wz) {
    if (!lampes || lampes.length === 0) return 0;
    let meilleur = 0;
    for (const [lx, ly, lz] of lampes) {
      const v = brutLampe(lx, ly, lz, wx, wy, wz);
      if (v <= meilleur) continue;
      if (!visuelle(lx, ly, lz, wx, wy, wz)) continue;
      meilleur = v;
    }
    return meilleur;
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

    for (const [lx, ly, lz] of lampes) {
      const x0 = Math.max(0, Math.floor(lx - R) - baseX);
      const x1 = Math.min(CHUNK_SIZE - 1, Math.ceil(lx + R) - baseX);
      const z0 = Math.max(0, Math.floor(lz - R) - baseZ);
      const z1 = Math.min(CHUNK_SIZE - 1, Math.ceil(lz + R) - baseZ);
      const y0 = Math.max(0, Math.floor(ly - R));
      const y1 = Math.min(CHUNK_HEIGHT - 1, Math.ceil(ly + R));
      if (x1 < x0 || z1 < z0 || y1 < y0) continue;

      for (let y = y0; y <= y1; y++) {
        for (let rz = z0; rz <= z1; rz++) {
          for (let rx = x0; rx <= x1; rx++) {
            const wx = baseX + rx, wz = baseZ + rz;
            const v = brutLampe(lx, ly, lz, wx, y, wz);
            const i = rx + rz * CHUNK_SIZE + y * cells;
            if (v <= champ[i]) continue;
            if (!visuelle(lx, ly, lz, wx, y, wz)) continue;
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

  return { champCiel, champLampes, lampesDeData, puissanceLampe };
}
