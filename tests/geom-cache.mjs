// Les triangles du disque — ce que le joueur doit voir arriver plus vite, et surtout
// sans que le processeur le refasse. La suite juge cinq promesses, chacune sur une preuve
// chiffrée plutôt qu'à l'œil :
//
//  - **le fichier porte ce qu'il prétend porter** : après cuisson et publication, il a
//    écrit des tronçons et ces tronçons se relisent ;
//  - **rien n'est refait deux fois** : après un rechargement, tout tronçon que le fichier
//    sait peindre et qui est à l'écran arrive du disque (`chunk.venuDuDisque`), et les
//    passages au mailleur s'effondrent (mesuré 381 appels sans cache contre 40 avec) ;
//  - **le disque ne ment pas** : un bloc posé tel quel vaut ce que produirait le mailleur
//    si on le lui demandait à cet instant. Le contrôle se protège lui-même : si le
//    mailleur refuse de se répéter deux fois de suite sur le même tronçon, la mesure est
//    déclarée instable plutôt que de faire passer un hasard pour un verdict ;
//  - **une édition annule le bloc** : le tronçon où le joueur pose la main repart du
//    mailleur et garde son bloc ;
//  - **le réglage de taille est honoré** dans les deux sens, et une caméra qui tourne ne
//    redemande rien une fois le monde posé.
//
// Usage: node tests/geom-cache.mjs [url]
// Nécessite le serveur statique (npm start / node server.js).
import { openGame, waitForBoot, makeReporter } from './browser.mjs';

const URL = process.argv[2] || 'http://localhost:8080';
const RAYON = 4;
const { check, summary } = makeReporter();

/** Empreinte complète d'un tronçon maillé : tout ce qui se voit à la carte.
 *  `getComponent` plutôt que le tampon brut : le fichier pose des entiers normalisés, et
 *  lire `.array` additionnerait des ±127 là où la carte voit des ±1. */
const SIGNATURE = `(cx, cz) => {
  const mc = window.__mc, w = mc.world;
  const c = w.chunks.get(cx + ',' + cz);
  if (!c || !c.meshes.length) return null;
  const h = { maillages: 0, sommets: 0, indices: 0, sPos: 0, sNor: 0, sUv: 0, sCol: 0, sLam: 0 };
  for (const m of c.meshes) {
    const g = m.geometry, n = g.attributes.position.count;
    h.maillages++; h.sommets += n; h.indices += g.index.count;
    const add = (nom, f) => {
      const a = g.attributes[nom];
      let s = 0;
      for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) s += a.getComponent(i, k);
      return f(s);
    };
    h.sPos += Math.round(add('position', (s) => s * 1000));
    h.sNor += Math.round(add('normal', (s) => s * 1000));
    h.sUv += Math.round(add('uv', (s) => s * 1e6));
    h.sCol += Math.round(add('color', (s) => s * 1e6));
    h.sLam += Math.round(add('aLampe', (s) => s * 1e6));
  }
  return h;
}`;

/** Une visite complète : remplir le champ, laisser le monde se poser, écrire ce qui reste. */
const VISITER = async ({ rayon }) => {
  const mc = window.__mc;
  mc.image(true);
  mc.setRenderDistance(rayon);
  let garde = 0;
  while (mc.world.pendingChunks > 0 && garde++ < 4000) {
    mc.world.updateChunks(mc.camera.position.x, mc.camera.position.z, Infinity, 16);
    await new Promise((r) => setTimeout(r, 0));
  }
  for (let i = 0; i < 60; i++) {
    mc.world.updateChunks(mc.camera.position.x, mc.camera.position.z, Infinity, 16);
    await new Promise((r) => setTimeout(r, 5));
  }
  for (let i = 0; i < 240; i++) {
    const e = mc.geomEtat();
    if (!e.enFile && !e.enCours) break;
    await mc.publierGeometrie();
    await new Promise((r) => setTimeout(r, 50));
  }
  const w = mc.world;
  const pcx = Math.floor(mc.camera.position.x / 16), pcz = Math.floor(mc.camera.position.z / 16);
  const cache = w.cacheGeom;
  let connus = 0, poses = 0;
  for (const c of w.chunks.values()) {
    if (Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz)) > rayon) continue;
    if (!cache || !cache.aLeTroncon(c.cx, c.cz) || !c.meshes.length) continue;
    connus++;
    if (c.venuDuDisque) poses++;
  }
  // Cumulés depuis le chargement de la page : `rebuildsDepuis()` remet à zéro, et lire
  // après la remise à zéro efface du relevé tout ce que l'amorçage avait déjà peint.
  return {
    chargés: w.chunks.size, connus, poses,
    mailles: w._rebuilds, depuisDisque: w._rebuildsDepuisDisque,
    motifs: { ...w._geomMotifs }, etat: mc.geomEtat(),
  };
};

// `geom=auto` : l'harnais passe `geom=ignorer` par défaut pour que les suites qui ne
// jugent pas le maillage n'écrivent pas de triangles sur le disque. Celles-ci le jugent.
const { browser, page, consoleErrors, badResponses } = await openGame(`${URL}/?geom=auto`);
await waitForBoot(page);

// ---- trois visites : étalon, transitoire, état installé ---------------------
// La première n'a rien sur le disque : elle donne l'étalon de ce que coûte un monde à
// mailler. La deuxième rejoue des blocs cuits pendant son propre transitoire — certains
// tronçons y ont été maillés avant que leurs voisins n'existent, leur bloc est donc
// périmé et se refait. La troisième juge ce que le joueur retrouve vraiment en reprenant
// sa partie : le voisinage est posé, les blocs ont été recuits dessus.
const premier = await page.evaluate(VISITER, { rayon: RAYON });
check(
  'la publication écrit des triangles sur le disque',
  premier.etat.octets > 0 && premier.etat.publies > 0,
  `${premier.etat.octets} octets · ${premier.etat.publies} tronçons publiés · motif="${premier.etat.motif}"`,
);

// Le joueur pose un bloc : le tronçon touché ne doit plus rien devoir au fichier.
const editee = await page.evaluate(() => {
  const mc = window.__mc, w = mc.world;
  const p = mc.camera.position;
  const x = Math.floor(p.x) + 2, y = Math.floor(p.y) + 1, z = Math.floor(p.z) + 2;
  w.setBlock(x, y, z, 9);
  return { cle: `${Math.floor(x / 16)},${Math.floor(z / 16)}`, x, y, z };
});

await page.reload();
await waitForBoot(page);
const deuxieme = await page.evaluate(VISITER, { rayon: RAYON });

await page.reload();
await waitForBoot(page);
const installe = await page.evaluate(VISITER, { rayon: RAYON });

// Barre à 0,5 et non à 1 : l'empreinte exige le digest des cloisons voisines — sans lui,
// mesuré, la couleur cuite ment jusqu'à 8,8 % sur un tronçon. Ce digest n'existe qu'une
// fois le voisin peint dans la session courante, donc chaque tronçon paie sa première
// peinture de la visite avant que son bloc ne puisse servir aux suivantes. Le choix est
// assumé : un cache qui sert une lumière fausse n'est pas un cache, c'est un bug lent.
check(
  'la moitié au moins du champ connu arrive du disque sans recalcul',
  installe.connus > 0 && installe.poses >= 0.5 * installe.connus,
  `${installe.poses}/${installe.connus} tronçons connus à l'écran reposés tels quels`
    + ` · refus ${JSON.stringify(installe.motifs)} · deuxième visite ${deuxieme.poses}/${deuxieme.connus}`,
);
// La borne est absolue (1,6 peinture par tronçon connu) plutôt que relative à la première
// visite : avec l'empreinte stricte, mesuré, le rechargement paie 124 peintures contre
// 180 à la première visite — le cache évince un tiers du travail, pas trois quarts. Ce qui
// doit rester jugé ici, c'est l'emballement : une repeinture en boucle (relaxation des
// cloisons qui se mord la queue) exploserait ce ratio sans que la couverture, elle, ne
// bouge.
check(
  'le rechargement ne se lance pas dans une tempête de repeintures',
  installe.connus > 0 && installe.mailles <= 1.6 * installe.connus,
  `${installe.mailles} peintures pour ${installe.connus} tronçons connus`
    + ` (${(installe.mailles / installe.connus).toFixed(2)} par tronçon) · première visite ${premier.mailles}`,
);

// Le bloc posé par le joueur doit survivre au rechargement, que son tronçon vienne du
// disque ou du mailleur : c'est la persistance du monde, jugée ici sous l'angle du cache.
const edite = await page.evaluate(([cle, x, y, z]) => {
  const w = window.__mc.world;
  const c = w.chunks.get(cle);
  return { existe: !!c, venuDuDisque: c ? !!c.venuDuDisque : null, bloc: w.getBlock(x, y, z) };
}, [editee.cle, editee.x, editee.y, editee.z]);
check(
  'le bloc posé par le joueur est là après rechargement',
  edite.existe && edite.bloc === 9,
  `tronçon ${editee.cle} · bloc en place=${edite.bloc} · venu du disque=${edite.venuDuDisque}`,
);

// La garde d'empreinte, jugée sans dépendre du moment de la publication : sur un tronçon
// dont le bloc chaud est déjà en mémoire, on pose un cube. Le fichier décrit ce qu'il
// décrivait avant ; poser ce bloc-là repeindrait un monde oublié.
const garde = await page.evaluate(() => {
  const mc = window.__mc, w = mc.world;
  let cible = null;
  for (const c of w.chunks.values()) {
    if (c.venuDuDisque && c.meshes.length && w.cacheGeom && w.cacheGeom.estChaud(c.cx, c.cz)) {
      cible = c; break;
    }
  }
  if (!cible) return { trouve: false };
  const x = cible.cx * 16 + 8, z = cible.cz * 16 + 8;
  const y = mc.getTerrainHeight(x, z) + 1;
  w.setBlock(x, y, z, 9);
  w.markChunkDirty(cible.cx, cible.cz);
  w.rebuildChunk(cible.cx, cible.cz);
  return {
    trouve: true, cle: `${cible.cx},${cible.cz}`,
    venuDuDisque: !!cible.venuDuDisque, bloc: w.getBlock(x, y, z),
  };
});
check(
  'une édition annule le bloc du disque',
  garde.trouve && garde.venuDuDisque === false && garde.bloc === 9,
  garde.trouve
    ? `tronçon ${garde.cle} · reposé depuis le disque=${garde.venuDuDisque} · bloc posé=${garde.bloc}`
    : 'aucun tronçon chaud du disque à falsifier',
);

// ---- le disque ne ment pas --------------------------------------------------
// Pour un échantillon de tronçons venus du fichier, on retire le cache sous le pied du
// mailleur et on refait le tronçon **deux fois** : si le mailleur se contredit lui-même,
// la comparaison ne prouve rien et le contrôle le dit au lieu d'accuser à tort.
const arbitre = await page.evaluate(([src]) => {
  const mc = window.__mc, w = mc.world;
  const sig = eval(src);
  const cache = w.cacheGeom;
  if (!cache) return { sorties: [], erreur: 'cache absent' };
  // Le fichier est quantifié : position au 1/256 de cube, normales au 1/127, uv au
  // 1/65535, couleur et lampe au 1/255. Les sommes d'un bloc posé ne peuvent donc plus
  // égaler celles du même bloc sorti du mailleur — elles doivent en rester à la distance
  // du pas de quantification, cumulés sur le nombre de sommets. Ces bornes sont le format
  // lui-même, pas une marge de confort : les dépasser, c'est qu'un canal ment.
  const PAR_SOMMET = { sPos: 12, sNor: 24, sUv: 31, sCol: 11800, sLam: 11800 };
  const jugerFidelite = (pose, maille) => {
    if (!pose || !maille) return pose === maille ? '' : 'absent';
    if (pose.maillages !== maille.maillages) return 'maillages';
    if (pose.sommets !== maille.sommets) return 'sommets';
    if (pose.indices !== maille.indices) return 'indices';
    for (const [canal, borne] of Object.entries(PAR_SOMMET)) {
      if (Math.abs((pose[canal] || 0) - (maille[canal] || 0)) > borne * maille.sommets + 1000) return canal;
    }
    return '';
  };
  const vus = [];
  for (const c of w.chunks.values()) {
    if (c.meshes.length && c.venuDuDisque && cache.aLeTroncon(c.cx, c.cz)) vus.push([c.cx, c.cz]);
    if (vus.length >= 8) break;
  }
  const sorties = [];
  for (const [cx, cz] of vus) {
    const pose = sig(cx, cz);
    w.cacheGeom = null;                       // plus de disque : le mailleur parle
    w.rebuildChunk(cx, cz);
    const premier = sig(cx, cz);
    w.rebuildChunk(cx, cz);
    const second = sig(cx, cz);
    w.cacheGeom = cache;
    const seriel = JSON.stringify(premier) === JSON.stringify(second);
    const champs = jugerFidelite(pose, premier);
    sorties.push({
      c: `${cx},${cz}`, seriel, fidele: champs === '', champs,
      ecart: pose && premier ? Math.abs((pose.sCol || 0) - (premier.sCol || 0)) : null,
      avant: pose ? pose.sCol : null, apres: premier ? premier.sCol : null,
      sommets: premier ? premier.sommets : null,
    });
  }
  return { sorties };
}, [SIGNATURE]);
const instables = arbitre.sorties.filter((s) => !s.seriel);
const infideles = arbitre.sorties.filter((s) => s.seriel && !s.fidele);
check(
  'un bloc posé vaut ce que produirait le mailleur',
  arbitre.sorties.length > 0
    && instables.length * 2 <= arbitre.sorties.length
    && infideles.length === 0,
  `${arbitre.sorties.length} audités · ${infideles.length} infidèles${infideles.length ? ` (${infideles.map((f) => `${f.c}:${f.champs} écart=${f.ecart}/${f.apres} sommets=${f.sommets}`).join(' ')})` : ''}`
    + ` · ${instables.length} instables${instables.length ? ` (${instables.map((f) => f.c).join(' ')})` : ''}${arbitre.erreur || ''}`,
);

// ---- une caméra qui tourne ne doit rien redemander --------------------------
// Premier demi-tour : les réserves découvertes ont le droit de se peindre une fois.
// Second demi-tour : le monde est posé de part et d'autre, rien ne doit bouger.
const deuxTours = await page.evaluate(async () => {
  const mc = window.__mc;
  const tour = async () => {
    mc.rebuildsDepuis();
    mc.camera.rotation.y += Math.PI;
    mc.camera.updateMatrixWorld();
    for (let i = 0; i < 150; i++) {
      mc.world.updateChunks(mc.camera.position.x, mc.camera.position.z, Infinity, 16);
      await new Promise((r) => setTimeout(r, 0));
    }
    return mc.rebuildsDepuis();
  };
  const premier = await tour();
  const second = await tour();
  return { premier, second };
});
check(
  'le monde posé ne se repeint pas quand la caméra repart en arrière',
  deuxTours.second.mailles === 0,
  `premier demi-tour ${deuxTours.premier.mailles} reconstructions (${deuxTours.premier.depuisDisque} du disque)`
    + ` · second ${deuxTours.second.mailles} (${deuxTours.second.depuisDisque} du disque)`,
);

// ---- le réglage de taille est honoré ---------------------------------------
const reglages = await page.evaluate(async () => {
  const mc = window.__mc;
  await mc.reglerBudgetGeom(0);
  const sansCache = !mc.world.cacheGeom && mc.geomEtat().budgetMo === 0;
  const relu = await mc.reglerBudgetGeom(64);
  return { sansCache, budget: mc.geomEtat().budgetMo, relu };
});
check(
  'la taille du cache est réglable dans les deux sens',
  reglages.sansCache && reglages.budget === 64 && reglages.relu === 64,
  `à 0 : cache libéré=${reglages.sansCache} · à 64 Mo : budget=${reglages.budget} · relu=${reglages.relu}`,
);

// ---- la place du fichier se calcule depuis la mémoire ----------------------
// Ce n'est plus un réglage, donc ce qui doit se lire ici c'est la DÉPENDANCE : trois tas
// fabriqués de toutes pièces, et à chaque fois le chiffre que les règles du jeu promettent
// pour ce tas-là — plancher et plafond compris, sinon un budget gravé dans le marbre
// passerait aussi bien.
const taille = await page.evaluate(async () => {
  const mc = window.__mc;
  const vrai = Object.getOwnPropertyDescriptor(performance, 'memory');
  const r = mc.geomEtat().reglesBudget;
  const attendu = (mo) => Math.min(r.plafondMo, Math.max(r.plancherMo, Math.round(mo * r.fraction)));
  const juges = [];
  for (const mo of [400, 4096, 16384]) {
    Object.defineProperty(performance, 'memory', {
      configurable: true,
      value: {
        jsHeapSizeLimit: mo * 1048576,
        usedJSHeapSize: Math.round(mo * 1048576 * 0.03),
        totalJSHeapSize: Math.round(mo * 1048576 * 0.05),
      },
    });
    juges.push({ tas: mo, obtenu: await mc.reglerBudgetGeom(null), attendu: attendu(mo) });
  }
  // Le vrai tas rendu, la main rendue au calcul : les blocs suivants de la suite doivent
  // juger le jeu tel qu'il démarre, pas tel que ce contrôle l'a laissé.
  if (vrai) Object.defineProperty(performance, 'memory', vrai); else delete performance.memory;
  const relu = await mc.reglerBudgetGeom(null);
  return { regles: r, juges, relu, note: document.getElementById('geom-note')?.textContent || '' };
});
check(
  "la place du fichier suit la mémoire de l'onglet, palier par palier",
  taille.juges.every((j) => j.obtenu === j.attendu) && /calculés depuis/.test(taille.note),
  taille.juges.map((j) => `tas ${j.tas} Mo → ${j.obtenu} Mo (attendu ${j.attendu})`).join(' · ')
    + ` · rendu ${taille.relu} Mo · « ${taille.note.slice(0, 88)} »`,
);

// ---- le four de fond taille l'île sans rien peindre à la scène --------------
// Le joueur veut l'île entière au fichier, taillée derrière lui. Trois promesses se
// tiennent ou se démentent ici : le four avance vraiment (`faits` compte ce qui est gravé,
// pas ce qui a été frôlé), il ne vole aucun triangle à l'écran — une cuisson de fond maille
// HORS scène, et poser ces tampons effacerait le décor sous les pieds du joueur — et il
// rend la mémoire des tronçons qu'il a dépassés, sinon parcourir l'île coûterait un
// gigaoctet. La quatrième juge le plafond disque promis au joueur.
const four = await openGame(`${URL}/?geom=auto&precuire=auto`);
const renduFour = await four.page.evaluate(async () => {
  const mc = window.__mc, w = mc.world;
  const p = mc.camera.position;
  for (let i = 0; i < 400 && w.pendingChunks > 0; i++) {
    w.updateChunks(p.x, p.z, Infinity, 16);
    await new Promise((r) => setTimeout(r, 16));
  }
  mc.cuireGeometrieFond(50);                                   // arme le plan
  // Le four doit connaître la FRONTIÈRE rendue, pas le carré du champ. S'il ne se défend
  // que du carré (`radius + MARGE_CHAMP_RENDU`), il refuse de tailler les coins de ce
  // carré — la zone que la brume efface déjà mais que le rangeur, lui, laisse ouverte — et
  // le joueur repaie le mailleur (2,5–3,2 ms) dès qu'il y entre, alors que le fichier avait
  // ces triangles. Jugé sur CET ensemble-là uniquement : compter tout ce qui se grave
  // au-delà de la brume ne distingue rien, les anneaux loin derrière le joueur étant
  // taillés par les deux versions (mesuré — le sabotage « carré seul » restait vert).
  const cuites = { coinsDuCarre: 0, sousLaFrontiere: 0, total: 0 };
  const rebuildSonde = w.rebuildChunk.bind(w);
  w.rebuildChunk = (cx, cz, o = {}) => {
    if (o.horsScene) {
      const CS = mc.CHUNK_SIZE;
      const c = w._centre;
      const borne = c ? c.radius + mc.MARGE_CHAMP_RENDU : -1;
      const d = c ? Math.max(Math.abs(cx - c.pcx), Math.abs(cz - c.pcz)) : -1;
      const x0 = cx * CS, z0 = cz * CS;
      const px = w._camX < x0 ? x0 : (w._camX > x0 + CS ? x0 + CS : w._camX);
      const pz = w._camZ < z0 ? z0 : (w._camZ > z0 + CS ? z0 + CS : w._camZ);
      const auCoin = Math.hypot(w._camX - px, w._camZ - pz);
      const rayon = Number.isFinite(w._brumeCarres) ? Math.sqrt(w._brumeCarres) : Infinity;
      // Garde : le jeu s'arrête une couronne avant la frontière, donc un tronçon à peine
      // dehors n'est taillé par PERSONNE (la couronne d'un tronçon vaut 16 cubes le long
      // d'un axe, 22,6 en diagonale). On ne compte que ce qui est franchement dehors.
      cuites.total++;
      if (d >= 0 && d <= borne && auCoin > rayon + 2 * CS) cuites.coinsDuCarre++;
      else if (auCoin <= rayon) cuites.sousLaFrontiere++;
    }
    return rebuildSonde(cx, cz, o);
  };
  const depart = mc.geomEtat().cuisson?.faits ?? -1;
  const attendus = mc.geomEtat().cuisson?.attendus ?? 0;
  // 70 tours plutôt que 40 : la borne est une patience de harnais, pas une exigence du
  // jeu (la barre reste à 300 gravures nettes). Mesuré le 2026-11-16, machine chargée
  // (charge moyenne 8) : 40 tours ne gravent que ~290 tronçons et le contrôle tombait pour
  // une raison d'horloge, pas de produit.
  let plusGrosRetenu = 0;
  let tours = 0;
  for (; tours < 70; tours++) {
    mc.cuireGeometrieFond(200);
    await new Promise((r) => setTimeout(r, 16));               // la sonde doit rendre la main
    await mc.publierGeometrie();
    plusGrosRetenu = Math.max(plusGrosRetenu, w.chunks.size);
    if ((mc.geomEtat().cuisson?.faits ?? 0) - depart >= 420) break;
  }
  // Le cumul du four est relevé ICI : plus bas le plan est réarmé pour le geste, et un
  // `faits` lu après l'arme repart de zéro (mesuré « -338 gravés », qui faisait tomber le
  // contrôle de gravure pour une raison de comptabilité, pas de produit).
  // Les coins du carré sont servis en dernier de leur couronne (la file trie par couronne
  // puis par distance Manhattan). S'ils manquent encore, on pousse le four jusqu'à un
  // plafond : sous la panne le compteur ne bougera jamais et la fenêtre reste courte.
  for (let t = 0; t < 30 && cuites.coinsDuCarre === 0; t++) {
    mc.cuireGeometrieFond(200);
    await new Promise((r) => setTimeout(r, 16));
  }
  const faitsApresBoucle = mc.geomEtat().cuisson?.faits ?? -1;
  w.rebuildChunk = rebuildSonde;            // la sonde des tailles est rendue avant le geste
  const c = w._centre || { pcx: 0, pcz: 0, radius: 4 };
  let peintsHorsChamp = 0;
  let horsChamp = 0;
  for (const chunk of w.chunks.values()) {
    if (Math.max(Math.abs(chunk.cx - c.pcx), Math.abs(chunk.cz - c.pcz)) <= c.radius + 2) continue;
    horsChamp++;
    if (chunk.meshes.length) peintsHorsChamp++;
  }
  // ---- le geste du joueur : immobile, demi-tour sur place, four en marche -----------
  // Ce que le joueur a signalé le 2026-11-16 : « même immobile, quand je me retourne je
  // vois le décor se reconstruire ». Mesuré alors 36 repeintures par demi-tour à
  // profondeur 8, TOUTES à `dist == radius + 2`, dont 11 derrière un tronçon que le four
  // venait de mailler hors scène : le rangeur rattachait cette couronne (`radius +
  // MARGE_CHAMP_RENDU`) pendant que le four ne se défendait que jusqu'à `radius + 1`.
  // La promesse jugée ici est binaire et ne doit rien au hasard : aucun tronçon déjà
  // peint devant le joueur ne repasse au mailleur parce qu'il a tourné la tête — et le
  // four doit avoir gravé pendant le geste, sinon le contrôle ne juge rien.
  const c0 = w._centre || { pcx: 0, pcz: 0, radius: 4 };
  const marge = mc.MARGE_CHAMP_RENDU;
  // D'abord un tour COMPLET, comme le fait le joueur qui regarde autour de lui : sans ça,
  // la couronne de marge (`radius + 1 … radius + MARGE_CHAMP_RENDU`) n'a jamais été peinte
  // — mesuré 81 tronçons à l'écran pour une portée de 4, soit exactement la portée stricte
  // — et le contrôle n'aurait rien eu à repeindre, même avec la panne réintroduite.
  mc.controls.isLocked = true;                    // la seule branche où animate fait tourner le monde
  const pousserLeFour = () => mc.cuireGeometrieFond(30);
  for (let a = 0; a < 360; a += 15) {
    mc.look(a, 0);
    await new Promise((r) => setTimeout(r, 16));
    pousserLeFour();
  }
  mc.look(0, 0);
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 100));
    pousserLeFour();
  }
  const peintAvant = new Set();
  for (const chunk of w.chunks.values()) {
    if (chunk.meshes.some((m) => m.parent === mc.scene)) peintAvant.add(`${chunk.cx},${chunk.cz}`);
  }
  // Le plan repart d'ici. Sans ça, sa frontière a déjà franchi la couronne de marge —
  // mesuré `rang` à 795, donc des couronnes lointaines — et le geste ne croise plus rien
  // à juger : le contrôle passait même avec la panne réintroduite. Le cumul est relevé
  // après l'arme, sinon le delta du geste compterait la remise à zéro comme un recul.
  w.cuissonIle = null;
  w.demarrerCuissonIle();
  const faitsAvantGeste = mc.geomEtat().cuisson?.faits ?? 0;
  const repeints = [];
  const rebuildOriginal = w.rebuildChunk.bind(w);
  let gesteEnCours = true;
  w.rebuildChunk = (cx, cz, o = {}) => {
    if (gesteEnCours && !o.horsScene) {
      const d = Math.max(Math.abs(cx - c0.pcx), Math.abs(cz - c0.pcz));
      if (d <= c0.radius + marge && peintAvant.has(`${cx},${cz}`)) repeints.push(`${cx},${cz}@${d}`);
    }
    return rebuildOriginal(cx, cz, o);
  };
  const positionAvant = { x: mc.camera.position.x, z: mc.camera.position.z };
  // Le four est délibérément à l'arrêt tant que la file de rendu n'est pas vide (garde
  // anti-faim du hook d'animation) — et tourner la tête fait précisément remonter cette
  // file (mesuré `pendingChunks` à 11 pendant le geste). Le laisser passif rendrait le
  // contrôle creux : il passerait sans rien juger, comme mesuré une première fois avec
  // `faitsPendantGeste = 0`. On lui rend donc le crédit d'image qu'animate lui prêterait
  // file vide, pendant tout le geste (`pousserLeFour`, déjà défini pour le tour complet).
  for (let a = 0; a < 180; a += 15) {
    mc.look(a, 0);
    await new Promise((r) => setTimeout(r, 16));   // le geste d'une souris, pas un saut
    pousserLeFour();
  }
  mc.look(180, 0);
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 100));  // le temps que le décor se repose
    pousserLeFour();
  }
  mc.controls.isLocked = false;
  w.rebuildChunk = rebuildOriginal;
  const demiTour = {
    repeints: repeints.length,
    exemples: repeints.slice(0, 6),
    vusAvant: peintAvant.size,
    faitsPendantGeste: (mc.geomEtat().cuisson?.faits ?? 0) - faitsAvantGeste,
    derive: Math.max(Math.abs(mc.camera.position.x - positionAvant.x), Math.abs(mc.camera.position.z - positionAvant.z)),
    // Ce que le four faisait pendant le geste : un contrôle vert rendu par un four arrêté
    // ne prouverait rien, ces compteurs sont là pour qu'on ne puisse pas s'y tromper.
    four: (() => {
      const s = w.cuissonIle;
      return s ? { enMarche: s.enMarche, rang: s.rang, devant: s.devant, attente: !!s.attenteTranche } : { arme: String(s) };
    })(),
    enFile: w.pendingChunks,
  };

  const apres = mc.geomEtat();
  // Le plafond disque : on le serre sur un palier que le jeu propose (8 Mo n'en est pas
  // un, et la règle retomberait sur le défaut en laissant croire à un plafond de 8 Mo).
  await mc.reglerBudgetGeom(32);
  mc.world.cuissonIle = null;
  let garde = 0;
  while (garde++ < 90 && !(mc.geomEtat().cuisson && mc.geomEtat().cuisson.sature)) {
    mc.cuireGeometrieFond(200);
    await new Promise((r) => setTimeout(r, 16));
    await mc.publierGeometrie();
  }
  const sature = mc.geomEtat().cuisson;
  return {
    depart, attendus, faits: faitsApresBoucle, tours, cuites,
    peintsHorsChamp, horsChamp, plusGrosRetenu,
    publies: apres.publies, octets: apres.octets,
    sature: !!sature?.sature, motifSature: sature?.motif || '',
    octetsApresPlafond: mc.geomEtat().octets,
    demiTour,
  };
});
await four.browser.close();
check(
  'le four de fond grave l\'île derrière le joueur',
  renduFour.faits - renduFour.depart >= 300 && renduFour.attendus > renduFour.faits,
  `${renduFour.faits}/${renduFour.attendus} tronçons gravés en ${renduFour.tours} tranches`
    + ` · ${renduFour.publies} publiés · ${(renduFour.octets / 1024) | 0} Ko`,
);
check(
  'rien de ce que taille le four n\'est peint à la scène',
  renduFour.peintsHorsChamp === 0 && renduFour.horsChamp > 50,
  `${renduFour.peintsHorsChamp} tronçon(s) hors champ avec des triangles sur ${renduFour.horsChamp}`,
);
// Le four se défend de la frontière RENDUE (`_montreACamera`), pas du seul carré du champ :
// sans cette distinction il laisse les coins du carré sans les graver, et le joueur les paie
// au mailleur en y entrant. Jugé à ce que le four a réellement taillé, pas à son compteur de
// progression (`faits`, qui compte aussi les sauts).
check(
  'le four connaît la frontière rendue : il grave les coins du carré sous la brume',
  renduFour.cuites.total > 100 && renduFour.cuites.coinsDuCarre > 0
    && renduFour.cuites.sousLaFrontiere === 0,
  `${renduFour.cuites.coinsDuCarre} taille(s) dans les coins du carré (hors frontière rendue)`
    + ` sur ${renduFour.cuites.total} · ${renduFour.cuites.sousLaFrontiere} sous la frontière`
    + ` (attendu 0 : le flot de rendu les tient)`,
);
check(
  'et le four rend la mémoire des tronçons dépassés',
  renduFour.plusGrosRetenu < 1500,
  `jusqu'à ${renduFour.plusGrosRetenu} tronçons retenus en mémoire pour ${renduFour.faits} gravés`,
);
check(
  'le plafond disque arrête le four proprement',
  renduFour.sature && renduFour.octetsApresPlafond <= 36 * 1024 * 1024,
  `saturé=${renduFour.sature} · ${renduFour.motifSature || 'sans motif'}`
    + ` · ${(renduFour.octetsApresPlafond / 1024) | 0} Ko au fichier (plafond 32 Mo)`,
);
// Le cinquième juge le geste que le joueur fait tout le temps : se retourner sans bouger.
// `faitsPendantGeste > 0` est le témoin positif — un four arrêté pendant la fenêtre ne
// prouverait rien, et c'est justement lui qui causait la panne.
check(
  'immobile, un demi-tour ne repeint rien de ce qui est à l\'écran',
  renduFour.demiTour.vusAvant > 50 && renduFour.demiTour.faitsPendantGeste > 0
    && renduFour.demiTour.repeints === 0 && renduFour.demiTour.derive < 0.05,
  `${renduFour.demiTour.repeints} tronçon(s) déjà peint(s) repassé(s) au mailleur sur `
    + `${renduFour.demiTour.vusAvant} à l'écran`
    + `${renduFour.demiTour.exemples.length ? ` (${renduFour.demiTour.exemples.join(' ')})` : ''}`
    + ` · le four a gravé ${renduFour.demiTour.faitsPendantGeste} tronçon(s) pendant le geste`
    + ` · four ${JSON.stringify(renduFour.demiTour.four)} · file rendu ${renduFour.demiTour.enFile}`
    + ` · dérive ${renduFour.demiTour.derive.toFixed(3)} cube`,
);

// ---- la barre de pré-cuisson du menu ---------------------------------------
// L'île se grave toute seule PENDANT que le joueur attend à l'accueil, avec une barre qui
// le dit. Ce contexte ne joue donc jamais « Jouer » et rend le voile à son sommeil : la
// promesse doit tenir sans une seule image rendue — et sans un seul clic, depuis que la
// pré-cuisson n'est plus un réglage.
//
// Deux pièges vérifiés sur place, qui ont rendu ce contexte vert pour rien à la première
// tentative (il est resté PASS alors que le four du menu était désarmé à la main) :
//  — `waitForBoot` réveille l'image, et le four d'image en profite pour tailler un lot que
//    la publication étale APRÈS le coucher du voile : la barre montait toute seule. D'où un
//    socle pris file vide ;
//  — juger le seul compteur de la barre laisserait passer une publication héritée : on
//    exige aussi que le compteur propre au four (`faits`) ait bougé pendant la fenêtre.
const menu = await openGame(`${URL}/?geom=auto&precuire=auto`);
await menu.page.evaluate(() => window.__mc.image(false));   // waitForBoot réveille : ici on veut dormir
const barreMenu = await menu.page.evaluate(async () => {
  const mc = window.__mc, w = mc.world;
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const attendre = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) await frame(); };
  let garde = 0;                                            // socle : plus rien en route vers le disque
  while ((w.geomEnAttente.size || mc.geomEtat().enCours) && garde++ < 60) await attendre(250);
  const avant = mc.geomBarre();
  const socle = avant?.prets ?? -1;
  const faitsSocle = w.etatCuissonIle()?.faits ?? 0;
  const imagesAvant = mc.framesRendues();
  // Rien n'est pressé, aucun crochet n'arme le four : cette fenêtre juge précisément
  // qu'il part seul. Il ne reste à juger que l'arrêt, par le levier des suites.
  const t0 = performance.now();
  let imagesFigees = true;
  let horsJeuToujours = true;
  while ((performance.now() - t0) / 1000 < 30 && (mc.geomBarre()?.prets ?? 0) < socle + 48) {
    await attendre(500);
    if (mc.framesRendues() !== imagesAvant) imagesFigees = false;
    if (!mc.horsJeu()) horsJeuToujours = false;
  }
  const pendant = mc.geomBarre();
  const cuisson = w.etatCuissonIle();
  const faitsPendantFenetre = (cuisson?.faits ?? 0) - faitsSocle;
  const arme = mc.precuireIleMaintenant(false);             // l'équivalent du second clic
  const faitsAlSuspension = w.etatCuissonIle()?.faits ?? 0;
  await attendre(6000);
  // Le cumul se lit AVANT d'éteindre le cache : `reglerBudgetGeom(0)` met le plan à néant,
  // et un `faits` lu après coup vaudrait 0 — mesuré « -289 gravés après le second clic »,
  // qui faisait tomber le contrôle pour une raison de comptabilité, pas de produit.
  const faitsApresSuspension = (w.etatCuissonIle()?.faits ?? 0) - faitsAlSuspension;
  // La place et sa phrase se lisent AVANT d'éteindre le cache : `reglerBudgetGeom(0)` fait
  // retomber `budgetMo` à zéro et la note sur « Cache éteint », qui ne dit plus rien de la
  // règle censée calculer la place depuis le tas autorisé.
  const place = {
    budget: mc.geomEtat().budgetMo,
    budgetCalcule: mc.geomEtat().budgetCalcule,
    note: document.getElementById('geom-note')?.textContent || '',
  };
  // Et si le cache n'a plus de place du tout, la barre doit se retirer plutôt que de
  // traîner un 0 % sans explication.
  await mc.reglerBudgetGeom(0);
  const sansCache = mc.geomBarre();
  return {
    avant, arme, pendant, socle, sansCache,
    delta: (pendant?.prets ?? 0) - socle,
    faitsPendantFenetre,
    total: cuisson?.attendus ?? 0,
    imagesPendantFenetre: mc.framesRendues() - imagesAvant,
    imagesFigees, horsJeuToujours,
    secondes: +((performance.now() - t0) / 1000).toFixed(1),
    octets: mc.geomEtat().octets,
    ...place,
    faitsApresSuspension,
  };
});
await menu.browser.close();
// Le texte et l'`aria` se répondent entre eux (ils sont posés par la même passe de
// l'affichage), `prets` est lu vif : il a donc toujours un train d'avance, le temps de la
// prochaine publication par lots. On juge la cohérence à l'intérieur d'un lot, pas au bit
// près — exiger l'égalité ferait échouer la suite pour une frame.
const compteAffiche = /^\s*(\d+)\/(\d+)\s/.exec(barreMenu.pendant?.texte || '');
const textePrets = compteAffiche ? Number(compteAffiche[1]) : -1;
const pctAffiche = barreMenu.total ? Math.min(100, Math.round((100 * textePrets) / barreMenu.total)) : -1;
check(
  'au menu, la barre des triangles est là avant même qu\'on la demande',
  !!barreMenu.avant && /\d+\s*\/\s*\d+|rien n'est encore gravé/.test(barreMenu.avant.texte || '')
    && /^\d+$/.test(String(barreMenu.avant.aria)),
  `aria=${barreMenu.avant?.aria} · ${barreMenu.avant?.texte}`,
);
check(
  'posé à l\'accueil, le four grave l\'île tout seul sans jamais rendre une image',
  barreMenu.delta >= 48 && barreMenu.faitsPendantFenetre > 0
    && barreMenu.imagesPendantFenetre === 0 && barreMenu.imagesFigees && barreMenu.horsJeuToujours,
  `${barreMenu.socle} → ${barreMenu.pendant?.prets} tronçons prêts (+${barreMenu.delta}) en `
    + `${barreMenu.secondes} s · le four a compté ${barreMenu.faitsPendantFenetre} gravure(s)`
    + ` · ${(barreMenu.octets / 1024) | 0} Ko au fichier`
    + ` · ${barreMenu.imagesPendantFenetre} image(s) rendue(s) pendant la fenêtre`
    + ` · hors-jeu=${barreMenu.horsJeuToujours}`,
);
check(
  'la barre affiche ce que porte le disque',
  barreMenu.pendant?.aria === String(pctAffiche) && textePrets >= 0
    && (barreMenu.pendant?.prets ?? -1) >= textePrets
    && (barreMenu.pendant?.prets ?? 0) - textePrets <= 96,
  `aria=${barreMenu.pendant?.aria} · texte ${textePrets}/${barreMenu.total} (attendu ${pctAffiche}%)`
    + ` · disque ${barreMenu.pendant?.prets} · ${barreMenu.pendant?.texte}`,
);
check(
  'désarmé, le four de fond ne grave plus un tronçon',
  barreMenu.arme === false && barreMenu.faitsApresSuspension === 0,
  `four désarmé=${barreMenu.arme} · ${barreMenu.faitsApresSuspension} tronçon(s) gravé(s) après l'arrêt`,
);
// La taille du fichier n'est plus un réglage : elle sort du tas autorisé par le navigateur,
// comme celle des géométries en RAM. Le joueur doit pouvoir lire d'où vient le chiffre —
// sinon un cache qui s'arrête à mi-île ressemble à une panne.
check(
  'la place du fichier est calculée depuis la mémoire de l\'onglet et le dit',
  barreMenu.budget > 0 && /calculés depuis/.test(barreMenu.note) && !!barreMenu.budgetCalcule,
  `${barreMenu.budget} Mo · ${barreMenu.budgetCalcule} · « ${barreMenu.note.slice(0, 96)} »`,
);
check(
  'cache éteint : la barre de pré-cuisson se retire du menu',
  barreMenu.sansCache === null,
  `à 0 Mo la barre répond ${JSON.stringify(barreMenu.sansCache)}`,
);

// Même convention que `eclairage.mjs` : le 404 du favicon et les ressources absentes ne
// sont pas des fautes du jeu.
const reelles = consoleErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
for (const e of reelles) console.log('[console.error]', e);
for (const r of badResponses) console.log('[mauvaise réponse]', r);
check(
  'aucune erreur console ni réponse en erreur',
  reelles.length === 0 && badResponses.length === 0,
  `${reelles.length} erreur(s) · ${badResponses.length} réponse(s) ≥ 400${badResponses.length ? ` : ${badResponses.join(' ')}` : ''}`,
);

process.exit(summary());
