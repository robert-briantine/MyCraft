// Garde-fou exécuté avant tout emballage Tauri (`beforeBuildCommand`).
// Le build bureau n'a ni Express ni réseau : tout ce qui pointe hors du
// paquet doit être repéré ici plutôt que dans la fenêtre noire d'un exe.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const TAURI = path.join(ROOT, 'src-tauri');
const failures = [];

function ok(label, detail = '') {
  console.log(`\x1b[32mOK    \x1b[0m  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}
function bad(label, detail = '') {
  failures.push(label);
  console.log(`\x1b[31mÉCHEC \x1b[0m  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    bad(`${path.relative(ROOT, file)} illisible`, e.message);
    return null;
  }
}

// ---- 1. le front ne doit rien demander au réseau ----
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const htmlRemote = [...html.matchAll(/https?:\/\/[^"'()\s<>]+/g)].map((m) => m[0]);
if (htmlRemote.length) bad('index.html référence des ressources externes', htmlRemote.join(', '));
else ok('index.html ne charge rien depuis Internet');

const ownScripts = fs.readdirSync(path.join(PUBLIC, 'js')).filter((f) => f.endsWith('.js'));
for (const name of ownScripts) {
  const src = fs.readFileSync(path.join(PUBLIC, 'js', name), 'utf8');
  const remote = [...src.matchAll(/https?:\/\/[^"'()\s`]+/g)].map((m) => m[0]);
  if (remote.length) bad(`js/${name} référence une URL externe`, remote.slice(0, 3).join(', '));
  if (/from\s+['"]three['"]/.test(src)) bad(`js/${name} importe « three » en nu`, 'utiliser le chemin relatif du vendor');
}
if (!failures.length) ok(`aucune ressource externe dans les ${ownScripts.length} scripts du jeu`);

// ---- 2. chaque référence locale existe bien ----
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((r) => !r.startsWith('data:') && !r.startsWith('#') && /^[/]/.test(r));
const missing = refs.filter((r) => !fs.existsSync(path.join(PUBLIC, r.replace(/^\//, ''))));
if (missing.length) bad('références locales introuvables', missing.join(', '));
else ok(`${refs.length} références locales résolues`, refs.join(' · '));

const vendor = path.join(PUBLIC, 'vendor', 'three', 'three.module.js');
const vendorSize = fs.existsSync(vendor) ? fs.statSync(vendor).size : 0;
if (vendorSize < 500_000) bad('three.js vendored absent ou tronqué', `${vendorSize} octets`);
else ok('three.js est embarqué dans le paquet', `${(vendorSize / 1024 / 1024).toFixed(2)} Mo`);

// ---- 3. la configuration Tauri ----
const conf = readJson(path.join(TAURI, 'tauri.conf.json'));
if (conf) {
  if (!conf.productName) bad('productName manquant');
  else ok('nom du produit', conf.productName);
  if (!/^[a-z0-9]+(\.[a-z0-9]+)+$/.test(conf.identifier || '')) bad('identifiant inverse invalide', conf.identifier);
  else ok('identifiant', conf.identifier);

  const dist = path.resolve(TAURI, conf.build?.frontendDist || '');
  if (!fs.existsSync(dist)) bad('frontendDist introuvable', conf.build?.frontendDist);
  else ok('frontendDist', path.relative(ROOT, dist));

  // Le jeu détecte son hôte via window.__TAURI__ : sans cette clé il croirait
  // tourner dans un navigateur et irait interroger un serveur Express absent.
  if (conf.app?.withGlobalTauri !== true) bad('withGlobalTauri désactivé', 'le pont IPC du jeu ne démarrera pas');
  else ok('window.__TAURI__ exposé au jeu');

  const csp = conf.app?.security?.csp || '';
  for (const directive of ["script-src 'self'", "object-src 'none'", "frame-src 'none'", "base-uri 'none'"]) {
    if (!csp.includes(directive)) bad('CSP trop permissive', directive);
  }
  if (/unsafe-eval/.test(csp)) bad('CSP autorise unsafe-eval');
  if (!failures.some((f) => f.startsWith('CSP'))) ok('CSP verrouillée', `${csp.split(';').length} directives`);

  const icons = (conf.bundle?.icon || []).filter((i) => !fs.existsSync(path.join(TAURI, i)));
  if (icons.length) bad('icônes manquantes', icons.join(', '));
  else ok(`${conf.bundle?.icon?.length || 0} icônes présentes`);
}

const overlay = readJson(path.join(TAURI, 'tauri.windows.conf.json'));
if (overlay) {
  const w = overlay.bundle?.windows || {};
  if (!w.webviewInstallMode?.type) bad('webviewInstallMode non déclaré');
  else ok('installation WebView2', w.webviewInstallMode.type);
  if (!(overlay.bundle?.targets || []).includes('nsis')) bad('cible NSIS absente de tauri.windows.conf.json');
  else ok('cible NSIS déclarée');
}

const caps = readJson(path.join(TAURI, 'capabilities', 'default.json'));
if (caps) {
  const perms = caps.permissions || [];
  if (!perms.length) bad('capabilities sans permissions');
  else ok('permissions accordées', perms.join(', '));
  if (perms.some((p) => p === 'fs:all' || p.startsWith('shell:'))) bad('permission trop large', perms.filter((p) => p === 'fs:all' || p.startsWith('shell:')).join(', '));
}

// ---- 4. les commandes appelées par le JS existent côté Rust ----
// Tous les modules de src/ sont scannés : une commande peut vivre dans textures.rs
// comme dans world.rs, et le garde-fou doit suivre l'ajout d'un nouveau module.
const rustDir = path.join(TAURI, 'src');
const rust = fs.readdirSync(rustDir)
  .filter((f) => f.endsWith('.rs'))
  .map((f) => fs.readFileSync(path.join(rustDir, f), 'utf8'))
  .join('\n');
if (!fs.existsSync(path.join(rustDir, 'world.rs'))) bad('src/world.rs manquant', 'le magasin des mondes sauvegardés');
// Les invoke() peuvent vivre dans n'importe quel module du jeu (les commandes des
// mondes sont dans saves.js), donc tous les scripts sont scannés.
const jsSources = ownScripts
  .map((name) => fs.readFileSync(path.join(PUBLIC, 'js', name), 'utf8'))
  .join('\n');
const invoked = new Set([...jsSources.matchAll(/invoke\(\s*'([a-z_]+)'/g)].map((m) => m[1]));
for (const cmd of invoked) {
  if (!new RegExp(`fn ${cmd}\\(`).test(rust)) bad(`commande invoke('${cmd}') non implémentée en Rust`);
}
if (invoked.size && !failures.some((f) => f.startsWith('commande'))) ok(`${invoked.size} commandes IPC implémentées`, [...invoked].join(', '));

console.log(`\n${failures.length ? `\x1b[31m${failures.length} problème(s) bloquants\x1b[0m` : '\x1b[32mpaquet prêt\x1b[0m'}`);
process.exit(failures.length ? 1 : 0);
