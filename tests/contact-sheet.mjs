// Builds a self-contained contact sheet from the headless captures.
// Usage: node tests/contact-sheet.mjs [shotsDir] [outFile]
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = process.argv[2] || '.qwen/tmp/mc-shots';
const OUT = process.argv[3] || '.qwen/tmp/mc-shots/planche.html';

const shots = [
  { file: '00-atlas.png', title: 'Atlas procédural — 23 tuiles 16×16 agrandies 4×', note: 'Chaque tuile est peinte par bruit de valeur déterministe (même rendu à chaque chargement) et entourée d’une bordure dupliquée pour éviter tout bavement entre tuiles avec les mipmaps.' },
  { file: '01-vue-generale.png', title: 'Vue générale — terrain herbeux', note: 'Le matériau des chunks utilise désormais la carte de l’atlas (avant : aucune map, uniquement des couleurs par sommet). Les faces du dessus portent la tuile « herbe », les côtés la tuile « herbe-côté » avec frange déchirée sur terre.' },
  { file: '02-textures-proches.png', title: 'Matériaux en gros plan + occlusion ambiante', note: 'Une rangée de 16 matériaux puis un cube creux en roc : les coins internes sont assombris par AO par sommet (4 niveaux), ce qui donne le relief voxel.' },
  { file: '03-hud-hotbar.png', title: 'HUD — barre de sélection', note: 'Les icônes de la hotbar sont découpées dans le même atlas que le monde : l’aperçu correspond exactement au bloc posé.' },
  { file: '04-inventaire.png', title: 'Inventaire — palette des 20 blocs et emplacements réassignables', note: 'Ouvert par E : la souris est rendue à la page (pas de pointer lock) pour pouvoir cliquer. Un clic sur un bloc l’affecte à l’emplacement actif ; les 9 emplacements du bas se re-ciblent au clic et la configuration est mémorisée dans localStorage.' },
  { file: '05-reglages.png', title: 'Écran d’accueil — réglage de la profondeur de champ', note: 'Le curseur règle le rayon de génération des tronçons (2 à 32, soit 25 à 4225 tronçons) et, avec lui, le brouillard et le plan de coupe lointain. La génération est progressive : chaque frame se limite à ~10 ms de construction du monde, avec une file de maillage bornée, donc l’onglet reste réactif même au plafond. L’aperçu se met à jour derrière le panneau, la valeur est mémorisée entre les sessions.' },
];

const b64 = (f) => fs.readFileSync(path.join(SHOTS, f)).toString('base64');

const cards = shots.map((s, i) => `
  <section class="card">
    <h2><span class="num">${String(i + 1).padStart(2, '0')}</span>${s.title}</h2>
    <figure>
      <img src="data:image/png;base64,${b64(s.file)}" alt="${s.title}" loading="lazy">
      <figcaption>${s.note}</figcaption>
    </figure>
  </section>`).join('\n');

const css = `
  :root { --bg:#12141a; --panel:#1b1e26; --ink:#e8ecf1; --dim:#9aa4b2; --ok:#5dd39e; --line:#2a2f3a; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  header { padding:32px 24px 8px; max-width:1080px; margin:0 auto; }
  h1 { margin:0 0 6px; font-size:28px; letter-spacing:-.3px; }
  .sub { color:var(--dim); margin:0; }
  main { max-width:1080px; margin:0 auto; padding:16px 24px 64px; display:grid; gap:28px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .card h2 { margin:0; padding:14px 18px; font-size:16px; font-weight:600; border-bottom:1px solid var(--line); display:flex; gap:10px; align-items:baseline; }
  .num { color:var(--ok); font-variant-numeric:tabular-nums; font-weight:700; }
  figure { margin:0; }
  img { display:block; width:100%; height:auto; background:#000; }
  figcaption { padding:12px 18px 18px; color:var(--dim); font-size:14px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; }
  .stat { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .stat b { display:block; font-size:22px; color:var(--ok); font-variant-numeric:tabular-nums; }
  .stat span { color:var(--dim); font-size:13px; }
  code { background:#0d0f14; border:1px solid var(--line); border-radius:5px; padding:1px 6px; font-size:13px; }
  details { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 18px; }
  summary { cursor:pointer; font-weight:600; }
  ul { margin:10px 0 0; padding-left:20px; color:var(--dim); }
  li { margin:4px 0; }
  li b { color:var(--ink); font-weight:600; }`;

const body = `
<header>
  <h1>Rendu procédural, collisions &amp; choix des blocs</h1>
  <p class="sub">Captures headless (Chromium + SwiftShader) produites par <code>npm run test:e2e</code> — 74 contrôles automatiques au vert (35 rendu/collision/démarrage, 23 inventaire, 16 réglages).</p>
</header>
<main>
  <div class="grid">
    <div class="stat"><b>23</b><span>tuiles 16×16 générées dans un atlas unique</span></div>
    <div class="stat"><b>2</b><span>mesh par chunk : un opaque + un translucide</span></div>
    <div class="stat"><b>4</b><span>niveaux d’occlusion ambiante par sommet</span></div>
    <div class="stat"><b>0.6 × 1.8</b><span>collideur AABB, yeux à 1.62 (était une sphère de 1.6)</span></div>
    <div class="stat"><b>20 / 9</b><span>blocs dans la palette · emplacements réassignables et mémorisés</span></div>
    <div class="stat"><b>2 → 32</b><span>rayon de tronçons réglable au démarrage (25 à 4225 tronçons), génération progressive</span></div>
  </div>
  ${cards}
  <details open>
    <summary>Choix des blocs — ce qui a été ajouté</summary>
    <ul>
      <li><b>Palette complète</b> — les 20 blocs du jeu, groupés en 5 catégories (naturel, construction, végétaux, minerais, liquides), avec icône peinte depuis l’atlas et nom en français.</li>
      <li><b>Hotbar configurable</b> — un clic sur un bloc l’affecte à l’emplacement actif ; les 9 emplacements dupliqués en bas du panneau se re-ciblent au clic ; molette et touches 1-9 suivent la configuration.</li>
      <li><b>Persistance</b> — la hotbar est écrite dans <code>localStorage</code> (<code>mincraft_hotbar</code>) et rechargée à l’ouverture ; une sauvegarde corrompue ou un identifiant inconnu retombent sur la configuration par défaut sans crash.</li>
      <li><b>Souris rendue à la page</b> — l’ouverture libère le pointer lock, la fermeture le reprend ; si la reprise échoue, l’écran d’accueil revient, donc la page n’est jamais sans entrées.</li>
      <li><b>Isolation du monde</b> — pendant que l’inventaire est ouvert, les clics et les chiffres appartiennent à l’interface : rien n’est cassé ni posé dans le monde.</li>
    </ul>
  </details>
  <details open>
    <summary>Bugs corrigés au passage</summary>
    <ul>
      <li><b>Bouton « Cliquer pour jouer » sans effet</b> — <code>PointerLockControls</code> était branché sur <code>document.body</code> alors que le verrouillage est demandé sur le canvas : three.js comparait <code>pointerLockElement</code> à <code>body</code>, échouait, et dispatchait <code>unlock</code> à chaque prise de souris. L'écran d'accueil revenait instantanément et la souris ne pilotait pas la caméra.</li>
      <li><b>Fenêtre sans entrées</b> — après fermeture de l'inventaire, le voile de démarrage ne revenait qu'au bout d'un délai de 300 ms ; il revient dès que le navigateur refuse le verrouillage.</li>
      <li><b>Palette masquée par l'écran d'accueil</b> — ouverte avant le premier clic de jeu, elle restait sous le voile (<code>z-index</code> 100 contre 70) et aucun clic n'était possible.</li>
      <li><b>Textures jamais appliquées</b> — le matériau des chunks était créé sans <code>map</code> : tout le code de génération de textures était du code mort.</li>
      <li><b>UV des faces horizontales dégénérées</b> — les faces haut/bas partageaient un <code>v</code> constant, donc échantillonnaient une seule ligne de pixels.</li>
      <li><b>Orientation des triangles</b> — faces haut/bas/+Z/-Z inversées, ce qui imposait <code>DoubleSide</code> et doublait le coût fragment.</li>
      <li><b>Verre et feuilles non solides</b> — la solidité était déduite de la transparence ; on traversait les vitres et la canopée.</li>
      <li><b>Traversée du sol</b> — aucun sous-passage : avec <code>dt</code> à 0.1 s et gravité 30, le joueur franchissait plusieurs blocs par frame.</li>
      <li><b>Arrêt en l’air contre un mur</b> — le mouvement était annulé sans être aligné à la face, laissant le joueur flotter à ~0.2 bloc du mur.</li>
      <li><b><code>onGround</code> instable</b> — fixé uniquement lors d’un impact descendant ; le saut pouvait ne pas partir. Remplacé par une sonde de sol sous les pieds.</li>
      <li><b>Déblocage limité</b> — <code>snapToGround</code> ne remontait que d’un bloc ; sinon le joueur restait coincé dans le terrain.</li>
      <li><b>Cousure entre chunks</b> — les chunks étaient maillés avant que leurs voisins n’existent : faces manquantes et AO fausse aux frontières.</li>
      <li><b>Chute hors du monde</b> — aucune limite ; maintenant respawn au point de départ sous <code>y = -24</code>.</li>
    </ul>
  </details>
</main>`;

const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Rendu procédural — MyCraft</title>
<style>${css}</style>
</head>
<body>${body}
</body>
</html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);

// Body-only twin for hosts that supply their own document shell (artifact publish).
const bodyOut = OUT.replace(/\.html$/, '-body.html');
fs.writeFileSync(bodyOut, `<style>${css}</style>${body}`);

console.log(`planche écrite: ${OUT} (${(html.length / 1024).toFixed(0)} Ko)`);
console.log(`version fragment: ${bodyOut}`);
