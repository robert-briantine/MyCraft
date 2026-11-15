// Vérifie l'eau qui coule : la portée bornée, le tarissement, et ce que le joueur voit.
// Deux mondes jugés ici — l'automate seul sur une grille synthétique sous Node (le jeu
// n'est pas nécessaire), puis la propagation réellement écrite dans le monde du navigateur.
// Usage: node tests/eau.mjs [url]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReporter, openGame, waitForBoot } from './browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = process.argv[2] || 'http://localhost:8080';
const { check, summary } = makeReporter();

async function loadPublicModule(relative) {
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  const tmp = path.join(os.tmpdir(), `mycraft-eau-${path.basename(relative, '.js')}-${process.pid}.mjs`);
  fs.writeFileSync(tmp, source);
  try {
    return await import(pathToFileURL(tmp).href);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const { creerEau, EAU } = await loadPublicModule('public/js/eau.js');

// ============================ I. L'AUTOMATE SOUS NODE ============================
// Table du jeu pour les identifiants ; dans la grille synthétique, tout ce qui n'est ni
// air ni eau est du roc, donc « solide » se réduit à cette question.
const AIR = 0;
const STONE = 3;
const WATER = 7;
const HAUTEUR = 64;

function creerGrille({ charge = null } = {}) {
  const blocs = new Map();
  const niveaux = new Map();
  const K = (x, y, z) => `${x},${y},${z}`;
  const lu = (x, y, z) => blocs.get(K(x, y, z)) ?? AIR;

  const sim = creerEau({
    height: HAUTEUR,
    ID_AIR: AIR,
    ID_EAU: WATER,
    bloc: lu,
    niveau: (x, y, z) => (niveaux.has(K(x, y, z)) ? niveaux.get(K(x, y, z)) : null),
    solide: (x, y, z) => {
      const id = lu(x, y, z);
      return id !== AIR && id !== WATER;
    },
    charge: charge || (() => true),
    ecrire: (cells) => {
      for (const [x, y, z, id, niv] of cells) {
        const k = K(x, y, z);
        if (id === AIR) {
          blocs.delete(k);
          niveaux.delete(k);
        } else {
          blocs.set(k, id);
          if (niv == null) niveaux.delete(k);
          else niveaux.set(k, niv);
        }
      }
    },
  });

  return {
    sim,
    poser: (x, y, z, id) => {
      const k = K(x, y, z);
      if (id === AIR) blocs.delete(k);
      else blocs.set(k, id);
      niveaux.delete(k);                 // comme une édition du joueur : la distance repart
      sim.reveiller(x, y, z);
    },
    /** Eau pérenne : posée sans distance, donc jamais tarie par l'automate. */
    verser: (x, y, z) => blocs.set(K(x, y, z), WATER),
    bloc: lu,
    niveau: (x, y, z) => (niveaux.has(K(x, y, z)) ? niveaux.get(K(x, y, z)) : null),
    cellules: () => [...niveaux.entries()].map(([k, n]) => {
      const [x, y, z] = k.split(',').map(Number);
      return [x, y, z, n];
    }),
    reveiller: (x, y, z) => sim.reveiller(x, y, z),
    vagues: (n) => {
      let dernier = { evaluees: 0, modifiees: 0, enAttente: 0 };
      for (let i = 0; i < n; i++) dernier = sim.vague();
      return dernier;
    },
    /** Fait couler jusqu'à l'épuisement de la file, sous un plafond de sécurité. */
    tasser(max = 400) {
      let i = 0;
      while (sim.enAttente() > 0 && i < max) { sim.vague(); i++; }
      return { tours: i, reste: sim.enAttente() };
    },
  };
}

/** Le long d'un plancher de roc, une source à x = 0 : combien de cubes sont mouillés ? */
function nappeSurPlancher({ longueur = 40, hauteurSource = 1 }) {
  const g = creerGrille();
  for (let x = -2; x <= longueur; x++) g.poser(x, 0, 0, STONE);       // le fond
  for (let x = -2; x <= longueur; x++) g.poser(x, 2, 0, STONE);       // un plafond au-dessus de la source seulement
  g.verser(0, hauteurSource, 0);                                       // la source, à x = 0
  g.reveiller(0, hauteurSource, 0);
  return g;
}

const P = EAU.PORTEE;

// 1. La portée est la demande du joueur : l'eau ne peut pas couler à l'infini.
{
  const g = nappeSurPlancher({ longueur: 60 });
  g.tasser();
  const mouilles = [];
  for (let x = 1; x <= 60; x++) if (g.bloc(x, 1, 0) === WATER) mouilles.push(x);
  check(`la nappe s'arrête à la portée (${P} cubes)`, mouilles.length === P,
    `${mouilles.length} cubes mouillés, dernier à x=${mouilles[mouilles.length - 1] ?? '—'}`);
  check('rien au-delà de la portée', g.bloc(P + 1, 1, 0) === AIR && g.bloc(P + 2, 1, 0) === AIR);
  const distances = [];
  for (let x = 1; x <= P; x++) distances.push(g.niveau(x, 1, 0));
  check('la distance croît cube à cube depuis la source',
    distances.every((n, i) => n === i + 1), distances.join(','));
  check('la source ne porte aucune distance', g.niveau(0, 1, 0) === null);
}

// 2. Couper la source tarit tout ce qui en dépend — et rien d'autre.
{
  const g = nappeSurPlancher({ longueur: 30 });
  g.tasser();
  const avant = g.cellules().length;
  g.poser(0, 1, 0, AIR);                       // on arrache la source
  g.tasser();
  check("l'eau de passage disparaît quand la source part", g.cellules().length === 0,
    `${avant} cellules mouillées avant, ${g.cellules().length} après`);
  check('le plancher de roc a survécu à la vidange',
    g.bloc(0, 0, 0) === STONE && g.bloc(4, 0, 0) === STONE);
}

// 3. Deux nappes sans rapport : arracher l'une de ses sources ne vide que la sienne.
//    (Vider une cellule au milieu d'une nappe ne la couperait pas — elle se remplit depuis
//    l'amont, tant que la source porte encore au-delà du trou.)
{
  const g = creerGrille();
  for (let x = -2; x <= 40; x++) { g.poser(x, 0, 0, STONE); g.poser(x, 2, 0, STONE); }
  g.verser(0, 1, 0);                       // nappe de gauche
  g.verser(30, 1, 0);                      // nappe de droite, à trente cubes : les portées ne se touchent pas
  g.reveiller(0, 1, 0);
  g.reveiller(30, 1, 0);
  g.tasser();
  check('les deux nappes sont bien distinctes',
    g.bloc(5, 1, 0) === WATER && g.bloc(25, 1, 0) === WATER && g.bloc(15, 1, 0) === AIR);
  g.poser(30, 1, 0, AIR);                  // on arrache la source de droite
  g.tasser();
  check("la nappe privée de source se vide entièrement",
    g.bloc(25, 1, 0) === AIR && g.bloc(28, 1, 0) === AIR && g.bloc(34, 1, 0) === AIR,
    `x=25:${g.bloc(25, 1, 0)} x=28:${g.bloc(28, 1, 0)} x=34:${g.bloc(34, 1, 0)}`);
  check('la voisine hors de portée ignore la vidange',
    g.bloc(1, 1, 0) === WATER && g.bloc(5, 1, 0) === WATER);
}

// 4. Pas de passerelle suspendue : sans fond, l'eau ne s'étale pas à plat.
{
  const g = creerGrille();
  g.poser(0, 0, 0, STONE);                      // un pilier isolé…
  g.verser(0, 1, 0);                            // …coiffé d'une source
  g.reveiller(0, 1, 0);
  g.tasser();
  let etale = 0;
  for (let x = 1; x <= 20; x++) if (g.bloc(x, 1, 0) === WATER) etale++;
  check('rien ne s étale au-dessus du vide', etale === 0, `${etale} cellules en suspension`);
  check("la colonne tombe jusqu'au fond", g.bloc(0, 0, 0) === STONE && g.bloc(0, 1, 0) === WATER);
}

// 5. Une cascade remplit toute sa colonne, puis s'étale au pied.
{
  const g = creerGrille();
  for (let y = 0; y <= 10; y++) g.poser(-1, y, 0, STONE);   // une paroi
  for (let x = -1; x <= 30; x++) g.poser(x, 0, 0, STONE);   // le sol
  g.verser(0, 10, 0);                                        // la source en hauteur, contre la paroi
  g.reveiller(0, 10, 0);
  g.tasser();
  let pleine = 0;
  for (let y = 1; y <= 10; y++) if (g.bloc(0, y, 0) === WATER) pleine++;
  check('la colonne de chute est pleine des source au sol', pleine === 10, `${pleine}/10 cubes`);
  const auSol = [];
  for (let x = 1; x <= 20; x++) if (g.bloc(x, 1, 0) === WATER) auSol.push(x);
  check("l'eau s'étale au pied de la chute", auSol.length >= P, `${auSol.length} cubes au sol`);
  check("l'étalage du pied reste borné", g.bloc(P + 1, 1, 0) === AIR);
}

// 6. L'eau ne pousse pas vers le haut au-dessus d'une source : pas de fontaine.
{
  const g = creerGrille();
  for (let x = -4; x <= 4; x++) {
    for (let y = 0; y <= 3; y++) g.poser(x, y, 0, STONE);   // un radier
    g.verser(x, 4, 0);                                      // une nappe de sources
    g.verser(x, 3, 0);
  }
  for (const x of [-4, 4]) for (let y = 4; y <= 6; y++) g.poser(x, y, 0, STONE);  // deux joues
  for (const x of [-3, 3]) g.reveiller(x, 5, 0);            // on réveille l'air au-dessus
  g.tasser();
  let auDessus = 0;
  for (let x = -3; x <= 3; x++) if (g.bloc(x, 5, 0) === WATER || g.bloc(x, 6, 0) === WATER) auDessus++;
  check('une nappe de sources ne grimpe pas au-dessus d’elle-même', auDessus === 0,
    `${auDessus} cellules au-dessus du plan d'eau`);
}

// 7. Une galerie aveugle se remplit jusqu'à la ligne d'eau de sa source : l'eau entre par
//    le puits, s'étale à l'étage du bas, puis gagne l'étage du haut en s'appuyant dessus.
{
  const g = creerGrille();
  for (let x = -1; x <= 30; x++) g.poser(x, 0, 0, STONE);            // le fond du monde
  for (let x = 3; x <= 9; x++) if (x !== 6) g.poser(x, 3, 0, STONE); // la tablette, percée d'un puits à x=6
  for (const x of [3, 9]) for (let y = 1; y <= 2; y++) g.poser(x, y, 0, STONE);   // ses joues
  g.verser(6, 5, 0);                                        // source au-dessus du puits
  g.reveiller(6, 5, 0);
  g.tasser();
  check('la galerie aveugle se remplit sur deux étages',
    g.bloc(5, 1, 0) === WATER && g.bloc(5, 2, 0) === WATER && g.bloc(7, 2, 0) === WATER,
    `bas=${g.bloc(5, 1, 0)} haut=${g.bloc(5, 2, 0)}`);
  check('la tablette reste pleine sous la nappe', g.bloc(4, 3, 0) === STONE && g.bloc(5, 3, 0) === STONE);
  check("le puits d'alimentation reste plein", g.bloc(6, 4, 0) === WATER && g.bloc(6, 3, 0) === WATER);
  let auDessus = 0;
  for (let x = -1; x <= 30; x++) if (g.bloc(x, 6, 0) === WATER) auDessus++;
  check("rien ne dépasse la ligne d'eau de la source", auDessus === 0, `${auDessus} cubes à y=6`);
}

// 8. Convergence : la file se vide et l'état se fige, même sur un cas tordu.
{
  const g = creerGrille();
  for (let x = -2; x <= 40; x++) g.poser(x, 0, 0, STONE);
  g.verser(0, 1, 0);
  g.reveiller(0, 1, 0);
  const r1 = g.tasser(400);
  const trace1 = JSON.stringify(g.cellules());
  g.reveiller(20, 1, 0);                                    // une réveil parasite loin de tout
  const r2 = g.tasser(400);
  check("la file s'épuise d'elle-même", r1.reste === 0 && r2.reste === 0,
    `${r1.tours} tours puis ${r2.tours}, reste ${r1.reste}/${r2.reste}`);
  check("deux passages donnent le même état", trace1 === JSON.stringify(g.cellules()));
}

// 9. Le coût d'une vague est borné, même sur une tranchée immense.
{
  const g = creerGrille();
  for (let x = -1; x <= 300; x++) g.poser(x, 0, 0, STONE);
  g.verser(0, 1, 0);
  g.reveiller(0, 1, 0);
  let maxEvaluees = 0;
  let maxModifiees = 0;
  for (let i = 0; i < 60; i++) {
    const r = g.sim.vague();
    maxEvaluees = Math.max(maxEvaluees, r.evaluees);
    maxModifiees = Math.max(maxModifiees, r.modifiees);
  }
  check('une vague ne juge jamais plus que le budget', maxEvaluees <= EAU.BUDGET,
    `max ${maxEvaluees} cellules (budget ${EAU.BUDGET})`);
  check('une vague n écrit jamais plus que ce qu elle juge', maxModifiees <= maxEvaluees);
  let total = 0;
  for (let x = 1; x <= 300; x++) if (g.bloc(x, 1, 0) === WATER) total++;
  check('une tranchée de 300 cubes ne se remplit que sur la portée', total === P, `${total} cubes`);
}

// 10. Une colonne hors du monde chargé ne se noie pas : l'écriture attend la génération.
{
  const g = creerGrille({ charge: (x) => x <= 2 });
  for (let x = -2; x <= 20; x++) g.poser(x, 0, 0, STONE);
  g.verser(0, 1, 0);
  g.reveiller(0, 1, 0);
  g.tasser();
  let auDela = 0;
  for (let x = 3; x <= 20; x++) if (g.bloc(x, 1, 0) === WATER) auDela++;
  check("rien n'est écrit dans un tronçon non généré", auDela === 0, `${auDela} cellules`);
  check("en revanche le côté chargé prend l'eau", g.bloc(1, 1, 0) === WATER && g.bloc(2, 1, 0) === WATER);
}

// 11. Le roc prime : l'automate n'écrit jamais dans un bloc plein.
{
  const g = creerGrille();
  for (let x = -1; x <= 20; x++) g.poser(x, 0, 0, STONE);
  g.poser(3, 1, 0, STONE);                                  // un pilon au milieu du futur canal
  g.verser(0, 1, 0);
  g.reveiller(0, 1, 0);
  g.tasser();
  check('un bloc plein reste plein', g.bloc(3, 1, 0) === STONE);
  check("l'eau s'arrête devant l'obstacle", g.bloc(2, 1, 0) === WATER && g.bloc(4, 1, 0) === AIR);
}

// 12. Toute cellule d'eau est un cube entier : l'automate ne connaît plus aucune épaisseur
//     qui dépende de la distance — donc ni plaque sous les pieds du joueur, ni bord qu'on
//     ne peut pas traverser à la nage.
{
  const g = creerGrille();
  for (let x = -2; x <= 24; x++) g.poser(x, 0, 0, STONE);          // le plancher, sans plafond
  g.verser(0, 1, 0);
  g.reveiller(0, 1, 0);
  g.tasser();
  check("l'automate n'expose plus de réglage d'épaisseur rendue",
    !('HAUTEUR_MIN' in EAU) && !('SEUIL_NAGE' in EAU) && !('COUT_REMONTEE' in EAU),
    Object.keys(EAU).join(', '));
  let empilees = 0;
  for (let x = -2; x <= 24; x++) if (g.bloc(x, 2, 0) === WATER) empilees++;
  check("une nappe étalée sur un sol plat n'empile aucun cube", empilees === 0,
    `${empilees} cubes à y=2`);
  let mouilles = 0;
  for (let x = 1; x <= P; x++) if (g.bloc(x, 1, 0) === WATER) mouilles++;
  check('le bord de la portée est un cube d’eau comme les autres',
    mouilles === P && g.bloc(P + 1, 1, 0) === AIR, `${mouilles}/${P} cubes`);
}

// ===================== II. LE MONDE DU NAVIGUEUR =====================
const { browser, page, consoleErrors, badResponses } = await openGame(URL);

// Réserve une aire dégagée au-dessus du relief : la cuve d'essai n'a rien à voir avec
// le village ou la mer, elle doit être jugée seule.
const aire = await page.evaluate(() => {
  const mc = window.__mc;
  const cx = Math.floor(mc.camera.position.x) + 3;
  const cz = Math.floor(mc.camera.position.z) + 3;
  const sol = mc.getTerrainHeight(cx, cz);
  const y0 = Math.min(sol + 22, 104);
  return { cx, cz, y0, sol, bx: Math.floor(mc.camera.position.x), bz: Math.floor(mc.camera.position.z), portee: mc.eauParams.PORTEE };
});

/**
 * Construit la cuve : plancher de roc, mur de fond, source à une extrémité — et surtout
 * **pas de plafond**, pour que « rien ne monte au-dessus de la nappe » soit une preuve et
 * non une faveur du décor. La hauteur de chaque cube est ensuite mesurée sur la géométrie
 * réellement poussée au GPU : c'est là, pas dans les tables du monde, qu'une plaque se voit.
 */
async function construireCuve({ longueur = 24 }) {
  return page.evaluate(({ x0, z0, y, longueur }) => {
    const mc = window.__mc;
    const { STONE, WATER } = { STONE: 3, WATER: 7 };
    const CS = 16;
    const edits = [];
    for (let x = x0 - 2; x <= x0 + longueur; x++) edits.push([x, y - 1, z0, STONE]);  // le plancher
    edits.push([x0 - 1, y, z0, STONE]);                                                // le mur de fond
    mc.world.setBlocksBulk(edits);
    mc.setBlock(x0, y, z0, WATER);                                                     // la source
    mc.eauReveiller(x0, y, z0);
    const r = mc.eauVagues(60);

    // Remaille les tronçons touchés avant de lire la géométrie : les écritures de l'automate
    // sont différées, et une caisse périmée rendrait la mesure muette.
    for (let cx = Math.floor((x0 - 2) / CS); cx <= Math.floor((x0 + longueur) / CS); cx++) {
      mc.world.markChunkDirty(cx, Math.floor(z0 / CS));
    }
    mc.world.updateChunks(x0 + 3, z0, 0, 8000);

    /**
     * Hauteur dessinée du cube d'eau de (x, y, z). On ne garde que les sommets des faces
     * orientées vers le haut posés sur le plan arrière-droit de la cellule visée : les cubes
     * voisins ont tous leurs sommets de l'autre côté de ce plan, ils ne peuvent donc pas
     * gonfler la mesure. Un cube plein répond 1, une plaque de huitième répondrait 0,125.
     */
    const hauteurDessinee = (x, zz) => {
      const EPS = 1e-4;
      let sommet = null;
      for (const chunk of mc.world.chunks.values()) {
        for (const mesh of chunk.meshes) {
          if (mesh.material !== mc.world.matTrans) continue;         // le seul panier où va l'eau
          const pos = mesh.geometry.attributes.position.array;
          const nor = mesh.geometry.attributes.normal.array;
          for (let i = 0; i < pos.length; i += 3) {
            if (Math.abs(nor[i + 1] - 1) > EPS) continue;            // face vers le haut
            if (Math.abs(pos[i] - (x + 1)) > EPS) continue;          // coin arrière droit
            if (pos[i + 2] < zz - EPS || pos[i + 2] > zz + 1 + EPS) continue;
            if (pos[i + 1] < y - 0.5 || pos[i + 1] > y + 1.5) continue;
            if (sommet === null || pos[i + 1] > sommet) sommet = pos[i + 1];
          }
        }
      }
      return sommet === null ? null : +(sommet - y).toFixed(3);
    };

    const nappe = [];
    for (let x = x0 + 1; x <= x0 + longueur; x++) {
      if (mc.world.getBlock(x, y, z0) === WATER) {
        nappe.push([x - x0, mc.eauNiveau(x, y, z0), hauteurDessinee(x, z0)]);
      }
    }
    let auDessus = 0;
    for (let x = x0 - 1; x <= x0 + longueur; x++) if (mc.world.getBlock(x, y + 1, z0) === WATER) auDessus++;
    return { ...r, nappe, auDessus, portee: mc.eauParams.PORTEE };
  }, { x0: aire.cx, z0: aire.cz, y: aire.y0 + 1, longueur });
}

{
  const r = await construireCuve({ longueur: 24 });
  check('dans le monde, la nappe tient dans la portée', r.nappe.length === r.portee,
    `${r.nappe.length} cubes, portée ${r.portee}`);
  const dernier = r.nappe[r.nappe.length - 1];
  check("le bord de la nappe est à la portée exacte", dernier && dernier[0] === r.portee,
    dernier ? `dernier cube à +${dernier[0]}, distance ${dernier[1]}` : 'nappe vide');
  check('les distances enregistrées montent de 1 à la portée',
    r.nappe.every(([ , n], i) => n === i + 1), r.nappe.map(([, n]) => n).join(','));
  const dessinees = r.nappe.map(([, , h]) => h);
  check('chaque cube de la nappe est dessiné plein, du cœur au bord',
    dessinees.length > 0 && dessinees.every((h) => h !== null && h >= 0.99),
    `hauteurs dessinées ${dessinees.join(' ')}`);
  check('le bord de la portée se traverse à la nage',
    await page.evaluate(([x, z, y]) => window.__mc.eauNageable(x, y, z),
      [aire.cx + r.portee, aire.cz, aire.y0 + 1]));
  check('la source, elle, est nageable',
    await page.evaluate(([x, z, y]) => window.__mc.eauNageable(x, y, z), [aire.cx, aire.cz, aire.y0 + 1]));
  check("rien ne s'empile au-dessus du plan d'eau", r.auDessus === 0, `${r.auDessus} cubes à y+1`);

  // Le joueur dans l'eau de passage, pas dans l'océan : posé sur le dernier cube mouillé,
  // il doit être en nage. Une plaque de quelques centimètres le laisserait marcheur.
  const nageur = await page.evaluate(({ x, z, y }) => {
    const mc = window.__mc;
    mc.camera.position.set(x + 0.5, y + 1.62, z + 0.5);
    mc.player.velocity.set(0, 0, 0);
    mc.player.flyMode = false;
    mc.releaseAll();
    mc.streamAll();
    for (let i = 0; i < 20; i++) mc.step(1 / 120);
    return { nage: mc.player.nage, pieds: mc.feetY(), bloc: mc.world.getBlock(x, y, z) };
  }, { x: aire.cx + r.portee, z: aire.cz, y: aire.y0 + 1 });
  check('on nage jusqu’au bord de la nappe', nageur.nage === true && nageur.bloc === 7,
    `nage=${nageur.nage} · pieds ${nageur.pieds.toFixed(2)} · bloc ${nageur.bloc}`);
}

// Vider la cuve : tout ce qui était de passage doit partir, la source resterait.
{
  const apres = await page.evaluate(([x0, z0, y]) => {
    const mc = window.__mc;
    mc.setBlock(x0, y, z0, 0);                              // on arrache la source
    mc.eauReveiller(x0, y, z0);
    mc.eauVagues(60);
    const reste = mc.eauCellules().filter(([x, , zz]) => Math.abs(x - x0) <= 30 && Math.abs(zz - z0) <= 2);
    return { reste: reste.length, murs: mc.world.getBlock(x0 - 2, y - 1, z0) };
  }, [aire.cx, aire.cz, aire.y0 + 1]);
  check('la cuve vidée ne garde aucune eau de passage', apres.reste === 0, `${apres.reste} cellules`);
  check('le plancher de roc a tenu', apres.murs === 3);
}

// La mer : on perce la plage et l'eau ne doit pas envahir le continent. Le site est jugé
// dans un **couloir aveugle** — parois des deux côtés, plancher plein, bouchon au fond, et
// rien de mouillé dedans avant la brèche. Mesuré sur une langue de sable bordée d'eau de
// chaque côté, chaque cube de tranchée touchait une source par sa paroi : tous restaient à
// la distance 1 et le contrôle célébrait une inondation qui ne disait rien de la portée.
{
  const breche = await page.evaluate(([ox, oz]) => {
    const mc = window.__mc;
    const { WATER, AIR } = { WATER: 7, AIR: 0 };
    const SEA = mc.SEA_LEVEL;
    const P = mc.eauParams.PORTEE;
    const LONG = 16;                                   // longueur creusée dans les terres
    const plein = (x, y, z) => {
      const b = mc.world.getBlock(x, y, z);
      return b !== WATER && b !== AIR;
    };
    const couloir = (x, z) => {
      if (mc.world.getBlock(x, SEA, z) !== WATER) return false;          // la mer touche l'entrée
      if (!plein(x + 1, SEA, z) || !plein(x + 2, SEA, z)) return false;  // de la terre derrière
      for (let i = 1; i <= LONG + 1; i++) {
        if (mc.world.getBlock(x + i, SEA, z) === WATER) return false;    // le couloir est sec
        if (!plein(x + i, SEA - 1, z)) return false;                     // il a un plancher
        if (!plein(x + i, SEA, z - 1) || !plein(x + i, SEA, z + 1)) return false;   // ses parois
      }
      return true;
    };
    // Un tronçon non généré répond « air » pour tout : on charge la fenêtre avant d'y
    // chercher quoi que ce soit, et on l'élargit seulement si le premier anneau est stérile.
    let trouve = null;
    for (const rayon of [56, 120]) {
      mc.chargerRegion(ox - rayon, oz - rayon, ox + rayon, oz + rayon);
      for (let dx = -rayon + 6; dx <= rayon - LONG - 4 && !trouve; dx += 2) {
        for (let dz = -rayon + 4; dz <= rayon - 4 && !trouve; dz += 2) {
          if (couloir(ox + dx, oz + dz)) trouve = { x: ox + dx, z: oz + dz };
        }
      }
      if (trouve) break;
    }
    if (!trouve) return { trouve: null };
    const { x, z } = trouve;
    const creusees = [];
    for (let i = 1; i <= LONG; i++) {
      if (mc.world.getBlock(x + i, SEA, z) === AIR) continue;
      mc.setBlock(x + i, SEA, z, AIR);                      // une tranchée à fleur d'eau
      creusees.push(i);
    }
    mc.eauReveiller(x + 1, SEA, z);
    const r = mc.eauVagues(60);
    const ouest = [];
    for (let i = 1; i <= LONG; i++) {
      if (mc.world.getBlock(x + i, SEA, z) === WATER) ouest.push([i, mc.eauNiveau(x + i, SEA, z)]);
    }
    let lointain = 0;
    for (let i = P + 1; i <= LONG; i++) if (mc.world.getBlock(x + i, SEA, z) === WATER) lointain++;
    // Et la mer n'a pas enflé au-dessus de sa ligne : sur un sol plat, l'eau qui s'étale
    // reste à son niveau — elle ne peut ni empiler ni gravir.
    let auDessus = 0;
    const niveaux = [];
    for (let dy = 1; dy <= 3; dy++) {
      let n = 0;
      for (let i = -2; i <= LONG; i++) if (mc.world.getBlock(x + i, SEA + dy, z) === WATER) n++;
      niveaux.push(`y+${dy}:${n}`);
      auDessus += n;
    }
    return { trouve, creusees, ouest, lointain, auDessus, niveaux, portee: P, ...r };
  }, [aire.bx, aire.bz]);

  if (!breche.trouve) {
    check('rivage trouvé pour juger la brèche', false, 'aucun couloir aveugle bordé de mer autour de l\'apparition');
  } else {
    check('la brèche est creusée dans le sable', breche.creusees.length > 0,
      `(${breche.trouve.x}, ${breche.trouve.z}) · ${breche.creusees.length} cubes évidés`);
    check("l'eau entre dans la tranchée", breche.ouest.length > 0, `${breche.ouest.length} cubes`);
    check("la mer s'arrête à la portée dans les terres", breche.lointain === 0 && breche.ouest.length === breche.portee,
      `${breche.ouest.length} cubes mouillés, ${breche.lointain} au-delà de ${breche.portee}`);
    check("la ligne de flottaison ne monte pas", breche.auDessus === 0,
      `${breche.auDessus} cubes au-dessus (${breche.niveaux.join(' ')})`);
    check('les distances de la tranchée partent de 1 à la mer',
      breche.ouest.every(([i, n]) => n === i), breche.ouest.map(([i, n]) => `${i}:${n}`).join(' '));
  }
}

// Persistance : les distances voyagent avec la sauvegarde. La seconde cuve se pose assez
// haut au-dessus du relief pour que sa nappe n'ait rien à voir avec une mer voisine.
let cuveB = null;
{
  cuveB = await page.evaluate(([x0, z0]) => {
    const mc = window.__mc;
    let sol = 0;
    for (let x = x0 - 2; x <= x0 + 20; x++) sol = Math.max(sol, mc.getTerrainHeight(x, z0));
    const y = Math.min(sol + 22, 104) + 1;
    mc.chargerRegion(x0 - 2, z0 - 2, x0 + 20, z0 + 2);
    const edits = [];
    for (let x = x0 - 2; x <= x0 + 20; x++) {
      edits.push([x, y - 1, z0, 3]);
      edits.push([x, y + 1, z0, 3]);
    }
    edits.push([x0 - 1, y, z0, 3]);
    mc.world.setBlocksBulk(edits);
    mc.setBlock(x0, y, z0, 7);
    mc.eauReveiller(x0, y, z0);
    mc.eauVagues(60);
    return { x0, z0, y };
  }, [aire.cx + 60, aire.cz]);

  const avant = await page.evaluate(async ([x0, z0]) => {
    const mc = window.__mc;
    await mc.flushSave();
    return mc.eauCellules()
      .filter(([x, , zz]) => Math.abs(x - x0) <= 24 && Math.abs(zz - z0) <= 2)
      .map(([x, yy, zz, n]) => `${x},${yy},${zz},${n}`);
  }, [cuveB.x0, cuveB.z0]);

  await page.reload({ waitUntil: 'load' });
  await waitForBoot(page);
  const apres = await page.evaluate(([x0, z0]) => window.__mc.eauCellules()
    .filter(([x, , zz]) => Math.abs(x - x0) <= 24 && Math.abs(zz - z0) <= 2)
    .map(([x, yy, zz, n]) => `${x},${yy},${zz},${n}`), [cuveB.x0, cuveB.z0]);

  check("les distances de l'eau survivent au rechargement",
    avant.length > 0 && avant.slice().sort().join('|') === apres.slice().sort().join('|'),
    `${avant.length} cellules avant, ${apres.length} après`);
  check("le monde recharge à l'arrêt (aucune vague en attente)",
    await page.evaluate(() => window.__mc.eauEnAttente() === 0));
}

// Image : la nappe doit être dessinée, pas seulement écrite dans les tables. Jugée à son
// apport — le même cadrage, avec et sans eau — plutôt qu'à une teinte absolue que le ciel
// et l'heure du jour fausseraient.
{
  // Une seule fonction, sérialisée deux fois : le cadrage ne peut donc pas bouger entre
  // les deux mesures, qui est exactement ce que compare le contrôle.
  const compter = ([x0, z0, y]) => {
    const mc = window.__mc;
    const CS = 16;
    for (let cx = Math.floor((x0 - 2) / CS); cx <= Math.floor((x0 + 20) / CS); cx++) {
      for (let cz = Math.floor((z0 - 2) / CS); cz <= Math.floor((z0 + 2) / CS); cz++) mc.world.markChunkDirty(cx, cz);
    }
    mc.camera.position.set(x0 + 3.5, y + 6, z0 + 0.5);
    mc.camera.rotation.set(-Math.PI / 2.3, 0, 0);
    mc.world.updateChunks(x0 + 3, z0, 0, 8000);   // draine la file de remaillage, sans rien générer
    mc.renderer.render(mc.scene, mc.camera);
    const gl = mc.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let bleus = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i + 2] > px[i] + 24 && px[i + 2] > 60) bleus++;
    return { bleus, total: w * h };
  };

  const avec = await page.evaluate(compter, [cuveB.x0, cuveB.z0, cuveB.y]);
  await page.evaluate(([x0, z0, y]) => {
    const mc = window.__mc;
    mc.setBlock(x0, y, z0, 0);            // on coupe l'alimentation de la cuve B
    mc.eauReveiller(x0, y, z0);
    mc.eauVagues(60);
  }, [cuveB.x0, cuveB.z0, cuveB.y]);
  const vide = await page.evaluate(compter, [cuveB.x0, cuveB.z0, cuveB.y]);

  const gain = (avec.bleus - vide.bleus) / avec.total;
  check('la nappe rendue se voit à l\'écran', gain > 0.01,
    `${(100 * avec.bleus / avec.total).toFixed(1)} % de pixels bleutés avec l'eau, `
    + `${(100 * vide.bleus / vide.total).toFixed(1)} % sans (${(100 * gain).toFixed(1)} points de gain)`);
}

// Le /favicon.ico que le navigateur réclame seul tombe en 404 sur ce serveur : request
// jamais émise par le jeu, donc ignorée — même filtre que les autres suites.
const ignorable = (x) => /favicon|Failed to load resource/i.test(String(x));
const reelles = consoleErrors.filter((e) => !ignorable(e));
if (reelles.length) console.log('\x1b[33merreurs console :\x1b[0m', reelles.slice(0, 6));
if (badResponses.length) console.log('\x1b[33mréponses en erreur :\x1b[0m', badResponses.slice(0, 6));
check('aucune erreur console', reelles.length === 0, reelles.slice(0, 3).join(' | '));
check('aucune réponse HTTP en erreur', badResponses.length === 0, badResponses.slice(0, 3).join(' | '));

await browser.close();
process.exitCode = summary();
