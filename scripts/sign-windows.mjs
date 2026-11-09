// Signe un livrable Windows (exe portable, installateur NSIS, uninstalleur et
// les DLL des plugins NSIS que Tauri signe aussi). Appelé par Tauri via
// `bundle.windows.signCommand`, où `%1` est remplacé par le chemin du fichier.
//
// Trois moteurs, par ordre de préférence :
//   custom        MYCRAFT_SIGN_COMMAND  — commande arbitraire, le chemin est ajouté
//   azure         azcs (Azure Trusted Signing) — meilleure réputation SmartScreen
//   osslsigncode  certificat PKCS#12 classique (OV/EV, ou auto-signé en local)
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_NAME = 'MyCraft';
const ABOUT_URL = process.env.MYCRAFT_ABOUT_URL || 'https://localhost/';
const TIMESTAMP_URL = process.env.MYCRAFT_TIMESTAMP_URL || 'http://timestamp.digicert.com';

const target = process.argv.slice(2).find((a) => a && fs.existsSync(a));
if (!target) {
  console.error('[signature] aucun fichier à signer dans les arguments:', process.argv.slice(2).join(' ') || '(vide — %1 absent de signCommand ?)');
  process.exit(1);
}

function run(cmd, args, { allowFail = false, label } = {}) {
  console.log(`[signature] ${label || cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (res.error) {
    console.error(`[signature] ${cmd} introuvable : ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0 && !allowFail) {
    console.error(`[signature] échec du moteur (${res.status})`);
    process.exit(res.status ?? 1);
  }
  return res.status ?? 0;
}

function which(cmd) {
  const res = spawnSync('which', [cmd], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---------------- moteur : commande personnalisée ----------------
function signCustom(command) {
  const [bin, ...fixed] = command.split(' ').filter(Boolean);
  run(bin, [...fixed, target], { label: 'custom' });
}

// ---------------- moteur : osslsigncode ----------------
function signOpenssl() {
  const pfx = process.env.MYCRAFT_PFX;
  const cert = process.env.MYCRAFT_CERT;
  const key = process.env.MYCRAFT_KEY;
  if (!pfx && !(cert && key)) {
    console.error('[signature] ni MYCRAFT_PFX ni (MYCRAFT_CERT + MYCRAFT_KEY) : impossible de signer.');
    process.exit(1);
  }
  const out = `${target}.signed`;
  const args = ['sign', '-in', target, '-out', out, '-n', APP_NAME, '-t', ABOUT_URL, '-ts', TIMESTAMP_URL, '-sp', APP_NAME, '-pa'];
  if (pfx) args.push('-pkcs12', pfx, '-pass', process.env.MYCRAFT_PFX_PASSWORD ?? '');
  else args.push('-cert', cert, '-key', key);
  run('osslsigncode', args, { label: 'osslsigncode' });
  fs.rmSync(target);
  fs.renameSync(out, target);
}

// ---------------- moteur : Azure Trusted Signing ----------------
// azcs refuse une liste de fichiers non hachée : on écrit la liste, on calcule
// son SHA-256, et on passe les deux. Les drapeaux restent surchargeables car
// l'CLI Azure évolue plus vite que ce script.
function signAzure() {
  const account = process.env.AZURE_TRUSTED_SIGNING_ACCOUNT;
  const endpoint = process.env.AZURE_TRUSTED_SIGNING_ENDPOINT;
  const profile = process.env.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE;
  if (!account || !endpoint || !profile) {
    console.error('[signature] il manque AZURE_TRUSTED_SIGNING_ACCOUNT, _ENDPOINT ou _CERTIFICATE_PROFILE.');
    process.exit(1);
  }
  if (!which('azcs')) {
    console.error("[signature] azcs introuvable. Installez-le :\n" +
      '  curl -sSL https://dot.net/v1/dotnet-install.sh | bash /dev/stdin --channel LTS\n' +
      '  export PATH="$HOME/.dotnet:$PATH"\n' +
      '  dotnet tool install --global Azure.CodeSigning.Cli\n' +
      '  az login');
    process.exit(1);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycraft-sign-'));
  const list = path.join(dir, 'file-list.json');
  fs.writeFileSync(list, JSON.stringify({ version: '1.0.0', resources: [{ path: target }] }, null, 2));
  const base = [
    'code-sign', 'files',
    '--description', APP_NAME,
    '--description-url', ABOUT_URL,
    '--file-list', list,
    '--trusted-file-hash', sha256(list),
    '--code-integrity',
    '--timestamp',
    '--digest-algorithm', 'sha256',
    '--trusted-signing-account', account,
    '--trusted-signing-endpoint', endpoint,
    '--certificate-profile', profile,
  ];
  const extra = (process.env.MYCRAFT_AZCS_ARGS || '').split(' ').filter(Boolean);
  try {
    run('azcs', [...base, ...extra], { label: 'azcs' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function detect() {
  if (process.env.MYCRAFT_SIGN_COMMAND) return 'custom';
  const forced = process.env.MYCRAFT_SIGN_PROVIDER;
  if (forced) return forced;
  if (process.env.MYCRAFT_PFX || (process.env.MYCRAFT_CERT && process.env.MYCRAFT_KEY)) return 'osslsigncode';
  if (process.env.AZURE_TRUSTED_SIGNING_ACCOUNT) return 'azure';
  console.error('[signature] aucun moteur de signature configuré.\n' +
    '  Azure : AZURE_TRUSTED_SIGNING_ACCOUNT / _ENDPOINT / _CERTIFICATE_PROFILE (+ azcs)\n' +
    '  P12   : MYCRAFT_PFX + MYCRAFT_PFX_PASSWORD (+ osslsigncode)\n' +
    '  Autre : MYCRAFT_SIGN_COMMAND="<commande>"');
  process.exit(1);
}

const provider = detect();
console.log(`[signature] ${path.basename(target)} ← ${provider}`);
if (provider === 'custom') signCustom(process.env.MYCRAFT_SIGN_COMMAND);
else if (provider === 'osslsigncode') signOpenssl();
else if (provider === 'azure') signAzure();
else {
  console.error(`[signature] moteur inconnu : ${provider}`);
  process.exit(1);
}
console.log(`[signature] OK  sha256=${sha256(target).slice(0, 16)}…`);
