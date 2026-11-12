// L'aperçu de génération : la carte vue de dessus qui accompagne les curseurs de
// l'écran « Génération du monde », et l'étalonnage qui convertit une part demandée en
// pourcentage (« 44 % de forêt ») en un seuil sur le champ de bruit réel.
//
// Pourquoi étalonner plutôt que de brancher le curseur sur une constante : les zones ne
// sont pas des surfaces que l'on règle, ce sont des **seuils sur un bruit**. Passer
// `wetLimit` de 0,10 à 0,05 ne fait pas gagner dix points de forêt, cela en fait gagner
// trois ou vingt selon la distribution du climat ce jour-là — et avec la graine, cette
// distribution change. Un curseur collé à la constante afficherait donc un chiffre que
// le monde ne respecte pas. On échantillonne au contraire le champ une fois par graine,
// puis on cherche par bissection le seuil qui rend la part demandée : l'étiquette du
// curseur et la carte dessinée sortent du même calcul.
//
// Deux précautions viennent des suites de rendu :
//  - l'échantillon doit couvrir **plusieurs mailles** de chaque bruit (climat 150,
//    grand boisé 900, bassin marin ~900), sinon la statistique lit une valeur locale ;
//  - l'aperçu juge `reliefBrut` sans les rivières : les tracer coûte cent fois plus
//    cher que le reste et ne change rien aux parts ci-dessus.
//
// Le module ne dépend que de la fiche du monde : le jeu lui passe des fabriques de
// relief et de climat, ce qui permet aux suites Node de juger exactement les chiffres
// vus à l'écran.

import { MONDE_DEFAULTS } from './world-config.js';
import { VILLAGE } from './village.js';

const fade = (t) => t * t * (3 - 2 * t);

const PALETTE = {
  eauProfonde: [16, 48, 92],
  eau: [38, 100, 168],
  eauClaire: [82, 150, 205],
  sable: [216, 200, 138],
  plaine: [110, 168, 79],
  foret: [45, 104, 51],
  desert: [214, 182, 118],
  roche: [138, 143, 150],
  neige: [238, 242, 246],
};

/** Bisection sur une fonction monotone, croissante ou décroissante. */
function resoudre(f, lo, hi, cible, iterations = 22) {
  const a = f(lo);
  const b = f(hi);
  // Cible hors portée : le grand boisé impose un plancher de forêt, le socle du relief
  // un plancher d'eau. On rend la borne qui s'en rapproche, et l'écran affiche alors la
  // part obtenue à côté de la part visée — un curseur qui ne peut pas descendre plus
  // bas le dit, au lieu de mentir.
  if ((a - cible) * (b - cible) > 0) return Math.abs(a - cible) <= Math.abs(b - cible) ? lo : hi;
  const croissante = a < b;
  let x = lo;
  let y = hi;
  for (let k = 0; k < iterations; k++) {
    const m = (x + y) / 2;
    const v = f(m);
    if ((croissante && v < cible) || (!croissante && v > cible)) x = m; else y = m;
  }
  return (x + y) / 2;
}

/**
 * @param {object} deps
 * @param {(monde:object)=>object} deps.creerRelief  objet `createTerrain` pour la fiche donnée
 * @param {(monde:object)=>object} deps.creerClimat  objet `createBiomeGen` pour la fiche donnée
 * @param {number} [deps.chunkHeight] hauteur du monde, pour le plafond du relief
 * @param {{min:number,max:number}} [deps.merBornes] ligne de flottaison extrêmes que
 *        l'étalonnage de la mer peut explorer (le jeu les cale sur le plancher du relief
 *        et sur l'altitude où le village commence à bâtir)
 * @param {number} [deps.cote] demi-largeur de la carte en cubes quand le monde n'est pas une île
 * @param {number} [deps.resolution] côté du canevas d'échantillons, en pixels
 */
export function createMondePreview({
  creerRelief, creerClimat, chunkHeight = 80, cote = 1600, resolution = 216,
  merBornes = { min: 8, max: 20 },
}) {
  const plafond = chunkHeight - 8;
  let cle = null;          // ce dont dépend l'échantillon brut
  let e = null;            // { h0, champ, frais, macro, dist, n }
  let relief = null;       // instance ayant servi l'échantillon (pour RELIEF)
  let climat = null;       // idem pour BIOMES
  let demi = cote;
  let pas = 1;
  let cacheSeuils = null;  // fiche -> { oceanThreshold, wetLimit, dryLimit }

  /**
   * Une passe d'échantillonnage. Elle ne dépend que de la graine et de la hauteur des
   * montagnes : les autres curseurs ne font que re-classer des colonnes déjà levées,
   * donc déplacer un curseur redessine sans rappeler le bruit.
   */
  function lever(monde) {
    const nouvelleCle = `${monde.graine}|${monde.hauteurMontagne}`;
    if (e && nouvelleCle === cle) return e;
    demi = monde.ile ? Math.max(400, monde.rayonIle + monde.largeurCote + 120) : cote;
    pas = (demi * 2) / (resolution - 1);
    relief = creerRelief(monde);
    climat = creerClimat(monde);
    const n = resolution * resolution;
    const h0 = new Float32Array(n);
    const champ = new Float32Array(n);
    const frais = new Float32Array(n);
    const macro = new Float32Array(n);
    const dist = new Float32Array(n);
    let k = 0;
    for (let j = 0; j < resolution; j++) {
      const z = -demi + j * pas;
      for (let i = 0; i < resolution; i++) {
        const x = -demi + i * pas;
        h0[k] = relief.reliefBrut(x, z);
        champ[k] = relief.oceanField(x, z);
        frais[k] = climat.climateValue(x, z);
        macro[k] = climat.macroValue(x, z);
        dist[k] = Math.hypot(x - relief.RELIEF.islandX, z - relief.RELIEF.islandZ);
        k++;
      }
    }
    cle = nouvelleCle;
    cacheSeuils = null;
    e = { h0, champ, frais, macro, dist, n };
    return e;
  }

  /** Creusement du bassin marin pour un seuil donné (miroir de `terrain.oceanBasin`). */
  function creusement(c, seuil, R) {
    if (c >= seuil) return 0;
    const t = Math.min(1, (seuil - c) / (seuil + R.oceanFade));
    return R.oceanDepth * fade(t);
  }

  /** Géométrie du talus : rayon, longueur, départ du mélange. */
  function talus(R) {
    const rayon = Math.max(80, R.islandRadius);
    const pente = Math.min(Math.max(20, R.islandShelf), Math.max(20, rayon - 60));
    return { rayon, pente, depart: rayon - pente };
  }

  /** Part du talus livrée au fond du large (miroir de `terrain.islandMix`). */
  function melange(d, g) {
    if (d <= g.depart) return 0;
    return fade(Math.min(1, (d - g.depart) / g.pente));
  }

  /**
   * La mer sous un paramètre unique `u`. Le socle du relief noie déjà lui-même un bon
   * quart des colonnes : jouer seulement sur le seuil des bassins ne peut donc pas
   * assécher le monde en dessous de cette part, ni l'inonder au-delà de ce que les
   * bassins supportent. `u` couvre les deux régimes d'un seul tenant et de façon
   * monotone — d'abord on creuse les bassins (u de 0 à 1), puis on monte la ligne de
   * flottaison (u de 1 à 2) ; en descendant (u de 0 à −1) on l'abaisse. À u = 0 on est
   * exactement sur les constantes du projet, donc sur le monde d'aujourd'hui.
   */
  function regimeMer(u, R) {
    if (u <= 0) {
      const t = Math.min(1, -u);
      return {
        oceanThreshold: R.oceanThreshold,
        seaLevel: Math.round(R.seaLevel - (R.seaLevel - merBornes.min) * t),
      };
    }
    if (u <= 1) {
      return {
        oceanThreshold: R.oceanThreshold + (0.8 - R.oceanThreshold) * u,
        seaLevel: R.seaLevel,
      };
    }
    const t = Math.min(1, u - 1);
    return {
      oceanThreshold: 0.8,
      seaLevel: Math.round(R.seaLevel + (merBornes.max - R.seaLevel) * t),
    };
  }

  /** Hauteur de l'échantillon sous un régime marin donné — mêmes formules que le relief. */
  function hauteur(k, reg, R, g) {
    let h = e.h0[k] - creusement(e.champ[k], reg.oceanThreshold, R);
    let plancher = R.minGround;
    if (R.island) {
      const m = melange(e.dist[k], g);
      if (m > 0) {
        const fond = reg.seaLevel - Math.max(1, R.islandDepth);
        h = h * (1 - m) + fond * m;
        // Sous l'eau, le plancher du monde ne borne plus : un fond bas fait la
        // profondeur de l'océan (voir `terrain.hauteurNue`).
        plancher = Math.min(R.minGround, fond);
      }
    }
    return Math.max(plancher, Math.min(plafond, Math.floor(h)));
  }

  /**
   * Colonnes jugées par les parts : le cœur de l'île quand le monde en est une, la
   * carte entière sinon. Exclure le talus donne au curseur de mer sa signification —
   * dans le disque entier, l'anneau noyé imposerait déjà près d'un tiers d'eau et le
   * curseur n'aurait plus de prise.
   */
  function masqueCoeur(R, g) {
    const masque = new Uint8Array(e.n);
    const coeur = R.island ? Math.max(60, g.depart) : Infinity;
    for (let k = 0; k < e.n; k++) masque[k] = e.dist[k] <= coeur ? 1 : 0;
    return masque;
  }

  const CLE_SEUILS = (m) => [m.graine, m.foret, m.desert, m.mer, m.largeurPlage,
    m.hauteurMontagne, m.ile ? 1 : 0, m.rayonIle, m.largeurCote, m.profondeurLarge].join('|');

  /**
   * Les trois seuils qui rendent les parts demandées. La mer d'abord : le masque des
   * terres sèches en dépend, et les zones se jugent ensuite sur ce masque. Mémoïsé par
   * fiche — faire glisser un curseur rejuge la même carte, pixel par pixel.
   */
  function seuils(monde) {
    lever(monde);
    const cleFiche = CLE_SEUILS(monde);
    if (cacheSeuils && cacheSeuils.cle === cleFiche) return cacheSeuils.valeur;
    const R = relief.RELIEF;
    const B = climat.BIOMES;
    const g = talus(R);
    const dedans = masqueCoeur(R, g);

    const partVisee = Math.min(0.95, Math.max(0, monde.mer / 100));
    // AUCUNE correction à la valeur par défaut : sans cette ancre, la bissection
    // rendrait un seuil à quelques millièmes du réglage historique et un monde créé
    // sans toucher à rien ne serait plus cube pour cube le monde d'hier — alors que
    // les sauvegardes ne stockent que le diff du joueur.
    let reg;
    if (monde.mer === MONDE_DEFAULTS.mer) {
      reg = { oceanThreshold: R.oceanThreshold, seaLevel: R.seaLevel };
    } else {
      const uMer = resoudre((u) => {
        const r = regimeMer(u, R);
        let noye = 0, total = 0;
        for (let k = 0; k < e.n; k++) {
          if (!dedans[k]) continue;
          total++;
          if (hauteur(k, r, R, g) <= r.seaLevel) noye++;
        }
        return total ? noye / total : 0;
      }, -1, 2, partVisee);
      reg = regimeMer(uMer, R);
    }

    // Le masque des terres sèches ne dépend plus que du régime marin trouvé : une seule
    // évaluation des hauteurs, relue par les deux recherches de climat.
    const sec = new Uint8Array(e.n);
    let terres = 0;
    for (let k = 0; k < e.n; k++) {
      if (!dedans[k]) continue;
      if (hauteur(k, reg, R, g) > reg.seaLevel) { sec[k] = 1; terres++; }
    }
    const sousBois = (w) => {
      let bon = 0;
      for (let k = 0; k < e.n; k++) {
        if (sec[k] && (e.macro[k] >= B.forestMacroLimit || e.frais[k] > w)) bon++;
      }
      return terres ? bon / terres : 0;
    };
    const sable = (d) => {
      let bon = 0;
      for (let k = 0; k < e.n; k++) {
        if (sec[k] && e.macro[k] < B.forestMacroLimit && e.frais[k] < d) bon++;
      }
      return terres ? bon / terres : 0;
    };
    const wetLimit = monde.foret === MONDE_DEFAULTS.foret ? B.wetLimit
      : resoudre(sousBois, -1, 1, Math.min(0.98, monde.foret / 100));
    // Le sable ne peut pas revendiquer ce que le bois a déjà pris, et un seuil de désert
    // au-dessus de celui de la forêt dirait deux choses contraires sur la même colonne.
    const plafondDesert = Math.max(0.001, Math.min(0.95, 1 - monde.foret / 100));
    const dryLimit = monde.desert === MONDE_DEFAULTS.desert ? B.dryLimit
      : resoudre(sable, -1, Math.max(-0.999, wetLimit), Math.min(plafondDesert, monde.desert / 100));
    // La grève, troisième cause du sable : une épaisseur comptée depuis la flottaison
    // effective, donc bornée par la ligne du projet (`B.sandLine`) — au-delà, le village
    // bâtirait sur la plage, `VILLAGE.minGround` lotissant juste au-dessus.
    const ligneDeSable = Math.max(reg.seaLevel,
      Math.min(B.sandLine, reg.seaLevel + monde.largeurPlage));
    cacheSeuils = {
      cle: cleFiche,
      valeur: {
        oceanThreshold: reg.oceanThreshold, seaLevel: reg.seaLevel,
        wetLimit, dryLimit, sandLine: ligneDeSable,
      },
    };
    return cacheSeuils.valeur;
  }

  /**
   * Les parts réellement rendues par la fiche, mesurées sur l'échantillon. C'est la
   * source des chiffres affichés à l'écran : ils peuvent s'écarter de la valeur visée
   * (le grand boisé impose un plancher de forêt, le talus un plafond de terres sèches)
   * et l'écran montre les deux.
   */
  function parts(monde) {
    lever(monde);
    const R = relief.RELIEF;
    const B = climat.BIOMES;
    const s = seuils(monde);
    const g = talus(R);
    const dedans = masqueCoeur(R, g);
    let total = 0, noye = 0, foret = 0, desert = 0, plaine = 0, haut = 0, sommet = 0;
    // Le sable au sol se juge à part, parce qu'il a DEUX causes et que le curseur
    // « Désert » n'en gouverne qu'une : la zone aride du climat, et la bande sous la
    // ligne de grève (`seuils().sandLine`, réglée par « Largeur de la plage »), qui reste
    // du sable quel que soit le climat. Descendre le premier à zéro supprime la première
    // et laisse la seconde — un écran qui n'afficherait que « Désert 0 % » contredirait
    // ce que le joueur voit par terre.
    let sable = 0, sableGreve = 0;
    for (let k = 0; k < e.n; k++) {
      if (!dedans[k]) continue;
      total++;
      const h = hauteur(k, s, R, g);
      if (h <= s.seaLevel) { noye++; continue; }
      const secAuDessus = h < B.treeLine;   // roche et neige ne sont jamais du sable
      const aride = secAuDessus && e.macro[k] < B.forestMacroLimit && e.frais[k] < s.dryLimit;
      if (e.macro[k] >= B.forestMacroLimit || e.frais[k] > s.wetLimit) foret++;
      else if (e.frais[k] < s.dryLimit) desert++;
      else plaine++;
      if (aride) { sable++; }
      else if (secAuDessus && h <= s.sandLine) { sable++; sableGreve++; }
      if (h >= B.treeLine) haut++;
      if (h >= B.snowLine) sommet++;
    }
    const terres = total - noye;
    const pct = (v, base) => (base ? 100 * v / base : 0);
    return {
      echantillons: total,
      mer: pct(noye, total),
      foret: pct(foret, terres),
      desert: pct(desert, terres),
      plaine: pct(plaine, terres),
      sable: pct(sable, terres),
      sableGreve: pct(sableGreve, terres),
      montagne: pct(haut, terres),
      neige: pct(sommet, terres),
      terres: pct(terres, total),
    };
  }

  /**
   * Compte estimé des centres-bourgs : une maille urbaine sur deux environ, parmi
   * celles dont le centre tombe sur une terre sèche. Ordre de grandeur montré au
   * joueur, pas un inventaire — l'inventaire exigerait de générer le village.
   *
   * La répartition entre les trois types se fait au prorata des curseurs : le jeu tire
   * le type sur la même maille que le centre-bourg, mais avec le sel du village, que
   * l'aperçu ne connaît pas. Répartir au poids rendu donne exactement ce que la carte
   * montre en moyenne, sans payer une génération de village pour trois chiffres.
   */
  function estimer(monde) {
    lever(monde);
    const R = relief.RELIEF;
    const s = seuils(monde);
    const g = talus(R);
    const cityCell = 176;
    const cityChance = monde.densiteVilles / 100;
    let villes = 0;
    const borne = monde.ile ? monde.rayonIle : cote;
    const range = Math.ceil(borne / cityCell);
    for (let i = -range; i <= range; i++) {
      for (let j = -range; j <= range; j++) {
        const x = (i + 0.5) * cityCell;
        const z = (j + 0.5) * cityCell;
        if (Math.hypot(x, z) > borne) continue;
        const k = Math.round((x + demi) / pas) + Math.round((z + demi) / pas) * resolution;
        if (k < 0 || k >= e.n) continue;
        if (hauteur(k, s, R, g) > s.seaLevel + 4) villes += cityChance;
      }
    }
    const parts = [monde.villesPetites, monde.villesMoyennes, monde.villesGrandes];
    const totalParts = parts.reduce((a, b) => a + b, 0) || 1;
    const parType = parts.map((p) => Math.round(villes * p / totalParts));
    // La plus grande agglomération réellement attendue : le type le plus ambitieux dont
    // le joueur a laissé une part non nulle. Éteindre « grandes » doit faire baisser ce
    // chiffre, sinon le curseur n'a aucun effet visible à l'écran.
    let plusGrande = null;
    for (let k = 0; k < parts.length; k++) {
      if (parts[k] > 0) plusGrande = VILLAGE.cityTypes[k];
    }
    if (!plusGrande) plusGrande = VILLAGE.cityTypes[VILLAGE.cityTypes.length - 1];
    return {
      villes: Math.round(villes),
      parType,
      rayonMax: plusGrande.rayon,
      etagesMaxVille: Math.min(plusGrande.etagesMax, monde.immeublesMax),
      immeubleMax: monde.immeublesMax,
      rayon: monde.ile ? monde.rayonIle : null,
      tourDePlage: monde.ile ? Math.round(2 * Math.PI * monde.rayonIle) : null,
      minutesPourLeBord: monde.ile ? Math.round(monde.rayonIle / 200) : null,
    };
  }

  /** Dessine la carte sur un canevas. Renvoie les parts, pour la légende. */
  function peindre(canvas, monde) {
    lever(monde);
    const R = relief.RELIEF;
    const B = climat.BIOMES;
    const s = seuils(monde);
    const g = talus(R);
    canvas.width = resolution;
    canvas.height = resolution;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(resolution, resolution);
    const px = img.data;
    // La plage se peint à la ligne d'étalonnage, celle que le générateur posera par
    // terre : même épaisseur de sable au-dessus de l'eau, donc la bande monte avec une
    // mer qui monte et disparaît si le joueur l'a descendue à zéro.
    const ligneDeSable = s.sandLine;
    for (let k = 0; k < e.n; k++) {
      const h = hauteur(k, s, R, g);
      let c;
      if (h <= s.seaLevel) {
        const profondeur = s.seaLevel - h;
        c = profondeur >= 6 ? PALETTE.eauProfonde : (profondeur >= 2 ? PALETTE.eau : PALETTE.eauClaire);
      } else if (h >= B.snowLine) c = PALETTE.neige;
      else if (h >= B.treeLine) c = PALETTE.roche;
      else if (e.macro[k] >= B.forestMacroLimit || e.frais[k] > s.wetLimit) c = PALETTE.foret;
      else if (e.frais[k] < s.dryLimit) c = PALETTE.desert;
      else if (h <= ligneDeSable) c = PALETTE.sable;
      else c = PALETTE.plaine;
      const o = k * 4;
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    if (monde.ile) {
      // Le cercle du bord : ce que le joueur met huit minutes à rejoindre à pied.
      const cx = (R.islandX + demi) / pas;
      const cz = (R.islandZ + demi) / pas;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cz, monde.rayonIle / pas, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.fillRect(cx - 1, cz - 1, 3, 3);
    }
    return parts(monde);
  }

  /** Les lignes de chiffres de l'écran, dans l'ordre d'affichage. */
  function lire(monde) {
    const p = parts(monde);
    const est = estimer(monde);
    const un = (v) => `${v.toFixed(1)} %`;
    const lignes = [
      { label: 'Mer', vise: `${monde.mer} %`, valeur: un(p.mer) },
      { label: 'Forêt', vise: `${monde.foret} %`, valeur: un(p.foret) },
      { label: 'Désert', vise: `${monde.desert} %`, valeur: un(p.desert) },
      {
        // Le sable que le curseur « Désert » ne peut pas enlever : la bande sous la ligne
        // de grève, que règle seul « Largeur de la plage ». L'écran montre les deux, sinon
        // « Désert 0 % » contredit ce que le joueur voit par terre dès qu'il approche de
        // la mer.
        label: 'Sable au sol',
        vise: `${monde.largeurPlage} cube${monde.largeurPlage === 1 ? '' : 's'} de grève`,
        valeur: `${un(p.sable)} · dont grève ${un(p.sableGreve)}`,
      },
      { label: 'Plaine', vise: `${Math.max(0, 100 - monde.foret - monde.desert)} %`, valeur: un(p.plaine) },
      { label: 'Terres hautes', vise: '', valeur: un(p.montagne) },
      { label: 'Neige', vise: '', valeur: un(p.neige) },
      { label: 'Villes estimées', vise: '', valeur: String(est.villes) },
      {
        // Les trois curseurs de proportions se jugent ici : ce sont les nombres de villes
        // de chaque sorte que la fiche promet, pas la somme des curseurs entre eux.
        label: 'Petites / moyennes / grandes',
        vise: `${monde.villesPetites} · ${monde.villesMoyennes} · ${monde.villesGrandes} parts`,
        valeur: `${est.parType[0]} / ${est.parType[1]} / ${est.parType[2]}`,
      },
      {
        // Le plafond effectif de la ville haute : le plancher entre le plafond du plus
        // ambitieux des types encore allumés et le plafond général d'immeubles.
        label: 'Plus grande agglomération', vise: '',
        valeur: `rayon ${est.rayonMax} cubes · ${est.etagesMaxVille} étages au plus`,
      },
      { label: 'Immeuble le plus haut', vise: '', valeur: `${est.immeubleMax} étages` },
    ];
    if (monde.ile) {
      lignes.push({
        label: 'Marche jusqu\'au large', vise: '',
        valeur: `~${est.minutesPourLeBord} min · tour ${est.tourDePlage} cubes`,
      });
    }
    return { lignes, parts: p, seuils: seuils(monde), estimation: est };
  }

  return {
    lever, seuils, parts, estimer, peindre, lire,
    get resolution() { return resolution; },
    get demi() { return demi; },
  };
}
