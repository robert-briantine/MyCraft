// Headless verification of the world light field: it must cross chunk borders when the
// player digs, stay readable under a thin roof, and stay black deep underground.
// Usage: node tests/eclairage.mjs [url]
// Needs the static server running (npm start / node server.js).
import { openGame, waitForBoot, makeReporter } from './browser.mjs';

const URL = process.argv[2] || 'http://localhost:8080';

const { check, summary } = makeReporter();
const { browser, page, consoleErrors } = await openGame(URL);
await waitForBoot(page);

const STONE = 3, AIR = 0;
const K = await page.evaluate(() => {
  const mc = window.__mc;
  return {
    cs: mc.CHUNK_SIZE, nuit: mc.PLANCHER_NUIT, piece: mc.PLANCHER_PIECE,
    mince: mc.COUVERTE_MINCE, portee: mc.PORTEE_CIEL, lampe: mc.LAMPE_PORTEE,
    applique: mc.BLOCK.LAMP_WALL_O,
  };
});
check('la page expose les seuils du champ de lumière',
  K.cs > 0 && K.nuit > 0 && K.piece > K.nuit && K.mince >= 1 && K.portee >= 4 && K.lampe > 0,
  JSON.stringify(K));

// ------------------------------------------------------------------ terrain d'essai
// Une plaine rase et une dalle de pierre : rien au-dessus, aucun bâtiment du village,
// pour que seule la physique de la lumière parle.
const ZONE = { x0: 288, x1: 368, z0: 288, z1: 336, sol: 20 };
await page.evaluate((P) => {
  const mc = window.__mc;
  for (let x = P.x0; x <= P.x1; x++) {
    for (let z = P.z0; z <= P.z1; z++) {
      for (let y = P.sol - 6; y <= 80; y++) mc.setBlock(x, y, z, y === P.sol ? P.pierre : P.air);
    }
  }
  return true;
}, { ...ZONE, pierre: STONE, air: AIR });

const sePoser = (x, y, z) => page.evaluate(({ x, y, z }) => {
  const mc = window.__mc;
  mc.player.flyMode = false;
  mc.releaseAll();
  mc.camera.position.set(x, y + 1.62, z);
  mc.player.velocity.set(0, 0, 0);
  mc.streamAll();
  for (let i = 0; i < 4; i++) mc.step(1 / 60);
  mc.streamAll();
  return true;
}, { x, y, z });

/** Laisse au flot le temps de propager les murs d'un tronçon à l'autre. */
const stabiliser = (tours = 6) => page.evaluate((tours) => {
  const mc = window.__mc;
  for (let i = 0; i < tours; i++) {
    mc.streamAll();
    mc.step(1 / 60);
  }
  return mc.world.pendingChunks;
}, tours);

/**
 * Couleur cuite dans les sommets de la face +Y du bloc (x,y,z) — c'est exactement ce que
 * l'œil reçoit, albédo mis à part. `null` si aucune face n'est dessinée là.
 */
const dessus = (x, y, z) => page.evaluate(({ x, y, z }) => {
  const mc = window.__mc, cs = mc.CHUNK_SIZE;
  const chunk = mc.world.chunks.get(mc.world.getChunkKey(Math.floor(x / cs), Math.floor(z / cs)));
  if (!chunk) return null;
  let s = 0, n = 0;
  for (const m of chunk.meshes) {
    const pos = m.geometry.attributes?.position, nor = m.geometry.attributes?.normal, col = m.geometry.attributes?.color;
    if (!pos || !nor || !col) continue;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(nor.getX(i)) > 1e-6 || Math.abs(nor.getY(i) - 1) > 1e-6 || Math.abs(nor.getZ(i)) > 1e-6) continue;
      if (Math.abs(pos.getY(i) - (y + 1)) > 1e-6) continue;
      if (pos.getX(i) < x - 1e-6 || pos.getX(i) > x + 1 + 1e-6) continue;
      if (pos.getZ(i) < z - 1e-6 || pos.getZ(i) > z + 1 + 1e-6) continue;
      s += col.getX(i); n++;
    }
  }
  return n ? +(s / n).toFixed(4) : null;
}, { x, y, z });

const profils = (...pts) => Promise.all(pts.map(([x, y, z]) => dessus(x, y, z)))
  .then((v) => v.map((n) => (n === null ? '—' : n.toFixed(2))).join(' '));

/**
 * Halo cuit (`aLampe`) de la face `n` du bloc (x,y,z), jugé triangle par triangle pour ne
 * rien emprunter aux faces voisines. `null` si aucune face n'est dessinée là.
 */
const haloFace = (x, y, z, n) => page.evaluate(({ x, y, z, n }) => {
  const mc = window.__mc, cs = mc.CHUNK_SIZE;
  const chunk = mc.world.chunks.get(mc.world.getChunkKey(Math.floor(x / cs), Math.floor(z / cs)));
  if (!chunk) return null;
  const planX = n[0] !== 0 ? (n[0] > 0 ? x + 1 : x) : null;
  const planY = n[1] !== 0 ? (n[1] > 0 ? y + 1 : y) : null;
  const planZ = n[2] !== 0 ? (n[2] > 0 ? z + 1 : z) : null;
  const dans = (v, a, b) => v >= a - 1e-4 && v <= b + 1e-4;
  let s = 0, cnt = 0;
  for (const m of chunk.meshes) {
    const g = m.geometry;
    const pos = g.attributes?.position, nor = g.attributes?.normal, lam = g.attributes?.aLampe;
    const idx = g.index;
    if (!pos || !nor || !lam || !idx) continue;
    for (let t = 0; t + 2 < idx.count; t += 3) {
      const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
      const sommets = [a, b, c];
      if (sommets.some((i) => Math.abs(nor.getX(i) - n[0]) > 1e-6
        || Math.abs(nor.getY(i) - n[1]) > 1e-6 || Math.abs(nor.getZ(i) - n[2]) > 1e-6)) continue;
      if (sommets.some((i) => {
        const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
        if (planX !== null && Math.abs(px - planX) > 1e-4) return true;
        if (planY !== null && Math.abs(py - planY) > 1e-4) return true;
        if (planZ !== null && Math.abs(pz - planZ) > 1e-4) return true;
        return !(dans(px, x, x + 1) && dans(py, y, y + 1) && dans(pz, z, z + 1));
      })) continue;
      s += lam.getX(a) + lam.getX(b) + lam.getX(c); cnt += 3;
    }
  }
  return cnt ? +(s / cnt).toFixed(4) : null;
}, { x, y, z, n });

// Le coin d'un tronçon sert de frontière : la pièce sera scellée de part et d'autre.
const CX = 320, CZ = 304, SOLIVE = ZONE.sol, SOL = ZONE.sol + 1;
const BX = Math.ceil(CX / K.cs) * K.cs;
const DX = 6, DZ = 3, HAUT = 3;         // pièce de 13 × 7, plafond à un cube d'épaisseur
const GALERIE = BX + 20;                // galerie borgne, loin de la pièce

/** Pièce scellée centrée sur la frontière, `ouvertures` = cubes de mur ôtés. */
const piece = (ouvertures = []) => page.evaluate(({ bx, cz, sol, dx, dz, haut, ouvertures, pierre, air }) => {
  const mc = window.__mc;
  for (let x = bx - dx; x <= bx + dx; x++) {
    for (let z = cz - dz; z <= cz + dz; z++) {
      const bord = (x === bx - dx || x === bx + dx || z === cz - dz || z === cz + dz);
      for (let y = sol; y <= sol + haut; y++) {
        const toit = (y === sol + haut);
        mc.setBlock(x, y, z, (bord || toit) ? pierre : air);
      }
    }
  }
  for (const [x, y, z] of ouvertures) mc.setBlock(x, y, z, air);
  return true;
}, { bx: BX, cz: CZ, sol: SOL, dx: DX, dz: DZ, haut: HAUT, ouvertures, pierre: STONE, air: AIR });

// ================================================== 1. la lumière franchit la frontière
{
  await sePoser(CX, SOL, CZ);
  await piece([]);
  await stabiliser();
  const gauche = await dessus(BX - 4, SOLIVE, CZ);
  const droite = await dessus(BX + 4, SOLIVE, CZ);
  check('pièce scellée : les deux tronçons la lisent pareil dès le premier maillage',
    gauche !== null && droite !== null && Math.abs(gauche - droite) < 0.05
      && gauche >= K.piece * 0.9,
    `gauche=${gauche} droite=${droite} · profil ${await profils(
      [BX - 4, SOLIVE, CZ], [BX - 1, SOLIVE, CZ], [BX, SOLIVE, CZ], [BX + 4, SOLIVE, CZ])}`);

  // Un seul cube du mur le plus loin à gauche : le jour doit entrer chez le voisin.
  await piece([[BX - DX, SOL + 1, CZ]]);
  await stabiliser(10);
  const g = await dessus(BX - 1, SOLIVE, CZ);
  const d = await dessus(BX + 1, SOLIVE, CZ);          // première cellule du tronçon voisin
  const dLoin = await dessus(BX + DX - 1, SOLIVE, CZ);
  check('un cube de mur ôté fait entrer le jour dans le tronçon voisin',
    g !== null && d !== null && d > K.piece + 0.08 && g > d,
    `bord gauche ${g} · première cellule voisine ${d} · fond droit ${dLoin} (pièce scellée ${K.piece})`);

  // Ce que l'utilisateur voyait n'était pas l'atténuation — légitime à dix cubes d'un
  // trou d'un cube, où 26 par cube éteint tout — mais le **ressaut** tombé sur la
  // frontière : deux cellules contiguës lues 0,58 et 0,035. Le juge est donc le
  // gradient, qui ne peut accuser que la couture entre les deux tronçons.
  const rangee = await Promise.all([BX - 4, BX - 1, BX, BX + 1, BX + 2].map((x) => dessus(x, SOLIVE, CZ)));
  const sauts = rangee.slice(1).map((v, i) => (v === null || rangee[i] === null ? 9 : Math.abs(v - rangee[i])));
  const aLaFrontiere = sauts[1];                        // BX − 1 (tronçon pair) → BX (tronçon impair)
  const ailleurs = Math.max(sauts[0], sauts[2], sauts[3]);
  check('aucun ressaut à la frontière : la paroi ne sépare plus deux mondes',
    aLaFrontiere <= ailleurs + 0.05,
    `saut à la frontière ${aLaFrontiere.toFixed(3)} · ailleurs ≤ ${ailleurs.toFixed(3)} · profil ${rangee.join(' ')}`);
}

// ================================================== 2. reconstruire éteint pareil
{
  await piece([]);                       // le cube est remis en place
  await stabiliser(10);
  const rebouchee = await dessus(BX + 4, SOLIVE, CZ);
  check('reboucher le mur rend la pièce voisine à son obscurité d\'origine',
    rebouchee !== null && rebouchee <= K.piece + 0.02,
    `droite=${rebouchee} (plancher pièce ${K.piece})`);
}

// ================================================== 3. couverture mince = pièce lisible
{
  await sePoser(CX, SOL, CZ);
  await piece([]);                       // plafond d'un seul cube de pierre
  await stabiliser();
  const sousToit = await dessus(CX, SOLIVE, CZ);
  check('sous un plafond d\'un cube, la pièce reste lisible sans lanterne',
    sousToit !== null && sousToit >= K.piece * 0.9 && sousToit > K.nuit * 4,
    `sol=${sousToit} · plancher pièce ${K.piece} · plancher nuit ${K.nuit}`);

  // Épais : quatre roches au-dessus de la même cellule, c'est une mine, pas une pièce.
  await page.evaluate(({ cx, cz, sol, pierre }) => {
    const mc = window.__mc;
    for (let y = sol + 4; y <= sol + 6; y++) {
      for (let x = cx - 3; x <= cx + 3; x++) {
        for (let z = cz - 3; z <= cz + 3; z++) mc.setBlock(x, y, z, pierre);
      }
    }
    return true;
  }, { cx: CX, cz: CZ, sol: SOL, pierre: STONE });
  await stabiliser();
  const enterree = await dessus(CX, SOLIVE, CZ);
  check(`au-delà de ${K.mince} roches de couverture, la même cellule retourne au noir`,
    enterree !== null && enterree <= K.nuit + 0.02,
    `sol=${enterree} (attendu ≤ ${(K.nuit + 0.02).toFixed(3)})`);
}

// ================================================== 4. la galerie profonde meurt
{
  // Galerie borgne : murs de trois cubes de chaque côté, fond fermé, toit de cinq
  // roches, bouche ouverte à l'ouest seulement. C'est le boyau que le joueur creuse, et
  // le lieu où la courbe se juge : à six cubes du jour il doit rester net, à dix-neuf
  // il doit être mort.
  await page.evaluate(({ x0, cz, sol, pierre, air }) => {
    const mc = window.__mc;
    for (let x = x0 - 2; x <= x0 + 18; x++) {
      for (let z = cz - 3; z <= cz + 3; z++) {
        for (let y = sol; y <= sol + 8; y++) mc.setBlock(x, y, z, pierre);
      }
    }
    for (let x = x0 - 2; x <= x0 + 17; x++) {          // le fond (x0+18) reste plein
      for (let z = cz - 2; z <= cz + 2; z++) {
        for (let y = sol; y <= sol + 3; y++) mc.setBlock(x, y, z, air);
      }
    }
    return true;
  }, { x0: GALERIE, cz: CZ, sol: SOL, pierre: STONE, air: AIR });
  await sePoser(GALERIE, SOL, CZ);
  await stabiliser(8);
  const gueule = await dessus(GALERIE, SOLIVE, CZ);
  const milieu = await dessus(GALERIE + 3, SOLIVE, CZ);
  const fond = await dessus(GALERIE + 16, SOLIVE, CZ);
  check('à six cubes du jour sous cinq roches, le sol reste net',
    milieu !== null && milieu > 0.46,
    `gueule=${gueule} milieu=${milieu} fond=${fond} (linéaire : 0,41 à ce point)`);
  check('et le fond meurt comme une carrière',
    fond !== null && fond <= K.nuit + 0.02,
    `fond=${fond} (plancher nuit ${K.nuit})`);
  // La bouche se juge deux cubes **dans** le goulot — la taille commence à x0 − 2 et le
  // jour entre à x0 − 3 : chaque cube franchi coûte 26/255 du champ, ce qui place la
  // sonde autour de 0,77 et non au plein jour de l'entrée.
  check('la bouche, elle, tient le jour',
    gueule !== null && gueule > 0.7, `gueule=${gueule}`);
}

// ================================================== 5. le remaillage reste dans son budget
{
  const chrono = await page.evaluate(({ cx, cz }) => {
    const mc = window.__mc, cs = mc.CHUNK_SIZE;
    const t = [];
    for (let d = 0; d < 3; d++) {
      const debut = performance.now();
      mc.world.rebuildChunk(Math.floor(cx / cs), Math.floor(cz / cs) + d);
      t.push(+(performance.now() - debut).toFixed(1));
    }
    return t;
  }, { cx: GALERIE, cz: CZ });
  check('remailer un tronçon avec ses quatre graines frontalières reste budgété',
    chrono.every((ms) => ms < 60), `${chrono.join(' ')} ms`);
}

// ================================================== 6. le halo des lanternes franchit la couture
{
  // Le champ de halo se cuit tronçon par tronçon, mais la lumière d'une face se juge sur la
  // cellule qu'elle regarde — souvent celle du voisin. L'y lire au noir rayait la cave d'une
  // bande sombre tous les CHUNK_SIZE cubes : mesuré le 2026-11-15, sous une applique la face
  // tournée vers le tronçon voisin valait 0 pendant que sa voisine valait 0,36.
  //
  // Pour comparer sans tricher, deux cubes jumeaux encadrent une cellule libre de la couture
  // et l'applique pend au-dessus d'elle : la face est du cube ouest la juge alors QUE le
  // maillage du tronçon voisin, la face ouest du cube est la juge chez lui. Deux visages d'une
  // même cellule, donc un seul chiffre attendu — contrairement aux deux faces d'un même cube,
  // qui regardent deux cellules différentes et n'ont rien à égaliser.
  const ZL = CZ + 16;                        // à l'écart de la pièce et de la galerie
  const HTL = 3;
  const JUGE = BX;                           // la cellule jugée, première du tronçon impair
  const OUEST = JUGE - 1, EST = JUGE + 1;    // les deux cubes qui la regardent
  await page.evaluate(({ ouest, est, sol, ht, zl, pierre, air }) => {
    const mc = window.__mc;
    const c = [];
    for (let x = ouest - 7; x <= est + 7; x++)
      for (let z = zl - 5; z <= zl + 5; z++)
        for (let y = sol - 2; y <= sol + ht + 6; y++) c.push([x, y, z, pierre]);
    for (let x = ouest - 5; x <= est + 5; x++)
      for (let z = zl - 4; z <= zl + 4; z++)
        for (let y = sol; y <= sol + ht; y++) c.push([x, y, z, air]);
    mc.world.setBlocksBulk(c, { differe: true, fluide: false });   // mille cubes, un maillage
    mc.setBlock(ouest, sol, zl, pierre);     // le cube du tronçon d'ouest
    mc.setBlock(est, sol, zl, pierre);       // son miroir, dans le tronçon d'est
  }, { ouest: OUEST, est: EST, sol: SOL, ht: HTL, zl: ZL, pierre: STONE, air: AIR });
  await sePoser(JUGE + 3, SOL, ZL);
  await stabiliser();

  const sansLampe = await haloFace(OUEST, SOL, ZL, [1, 0, 0]);
  check('sous roche épaisse et sans lampe, le canal du halo est vide',
    sansLampe !== null && sansLampe <= 0.001, `halo=${sansLampe}`);

  await page.evaluate(({ juge, sol, zl, applique }) => {
    window.__mc.setBlock(juge, sol + 3, zl, applique);   // l'applique au plafond, dans la poche
  }, { juge: JUGE, sol: SOL, zl: ZL, applique: K.applique });
  await stabiliser(10);

  const versVoisin = await haloFace(OUEST, SOL, ZL, [1, 0, 0]);   // juge la cellule du voisin
  const memeTroncon = await haloFace(EST, SOL, ZL, [-1, 0, 0]);   // juge sa propre cellule
  check('la face qui regarde le tronçon voisin n\'est pas rayée de noir',
    versVoisin !== null && versVoisin > 0.2,
    `face chez le voisin=${versVoisin} · face du même tronçon=${memeTroncon}`);
  check('les deux faces qui jugent la même cellule de la couture tiennent le même halo',
    versVoisin !== null && memeTroncon !== null && Math.abs(versVoisin - memeTroncon) < 0.01,
    `voisin=${versVoisin} · soi=${memeTroncon}`);

  await page.evaluate(({ juge, sol, zl }) => {
    window.__mc.setBlock(juge, sol + 3, zl, window.__mc.BLOCK.AIR);   // on casse l'applique
  }, { juge: JUGE, sol: SOL, zl: ZL });
  await stabiliser(10);
  const eteint = [await haloFace(OUEST, SOL, ZL, [1, 0, 0]), await haloFace(EST, SOL, ZL, [-1, 0, 0])];
  check('casser l\'applique éteint le halo des deux côtés de la couture',
    eteint.every((v) => v !== null && v <= 0.001), `après casse ${eteint.join(' / ')}`);
}

// ================================================== hygiene
const reelles = consoleErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
check('aucune erreur console pendant les essais de lumière', reelles.length === 0,
  reelles.slice(0, 3).join(' | '));

await browser.close();
process.exit(summary() ? 1 : 0);
