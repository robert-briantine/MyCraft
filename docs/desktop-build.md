# Build bureau Windows (Tauri + cargo-xwin)

MyCraft se compile pour Windows **depuis cette machine Linux ARM (DGX Spark)**, sans
Visual Studio et sans poste Windows. `cargo-xwin` télécharge le SDK et les CRT MSVC,
`clang` compile pour l'ABI MSVC (`clang-cl`), `lld-link` assemble, puis le bundler
Tauri emballe en NSIS avec `makensis`.

## 1. Prérequis

Déjà présents sur cette machine : `rustup` + cible `x86_64-pc-windows-msvc`,
`cargo-xwin`, `clang` 18, `lld-link`, `llvm-rc`, `makensis` 3.09, le SDK Windows en
cache (`~/.cache/xwin`, 1,1 Go).

Pour repartir de zéro :

```bash
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin                 # ou le binaire officiel depuis GitHub
sudo apt-get install clang lld llvm nsis # lld fournit lld-link, llvm fournit llvm-rc
npm install                              # installe @tauri-apps/cli
python3 scripts/make-icons.py            # régénère src-tauri/icons si besoin
```

`clang-cl` n'existe pas sous forme de binaire séparé : clang se comporte comme le
pilote MSVC dès qu'on l'appelle sous ce nom. `scripts/build-desktop.sh` crée donc
lui-même le lien `.build-tools/bin/clang-cl → clang` et le place en tête de `PATH`.

Le premier build télécharge les crates manquantes : une connexion réseau est
nécessaire, ensuite tout peut se faire hors ligne (`XWIN_CACHE_DIR` et
`~/.cargo/registry` font office de cache).

## 2. Construire

| Commande | Résultat |
| --- | --- |
| `npm run check:desktop` | Vérifie qu'aucune ressource externe ne traîne dans le paquet |
| `npm run desktop:build` | `MyCraft.exe` portable **+** installateur NSIS |
| `npm run desktop:build:portable` | Uniquement l'exe autonome |
| `npm run desktop:build:installer` | Uniquement `MyCraft_<version>_x64-setup.exe` |
| `npm run desktop:build:sign` | Les deux, signés (voir §4) |
| `npm run desktop:dev` | Fenêtre Tauri branchée sur `http://localhost:8080` |

Les livrables atterrissent dans `release/windows-x64/`, avec leur taille et un
SHA-256 affiché — gardez ces hachages, ils servent à prouver qu'un fichier reçu est
bien celui que vous avez compilé.

`desktop:dev` ne démarre **pas** le serveur Express (`beforeDevCommand` est vide
volontairement) : lancez `npm start` vous-mêmes d'abord. En release, aucune requête
réseau n'est possible : le CSP et le garde-fou `navigation` de `src-tauri/src/main.rs`
ne laissent sortir que vers `tauri://localhost`.

Fichiers générés côté joueur : les textures importées sont copiées dans
`%LOCALAPPDATA%\com.mycraft.game\textures\`.

## 3. Pourquoi Windows râle, et ce qui le fait taire réellement

Un .exe non signé déclenche **« Windows a protégé votre PC »** (SmartScreen). Ce
n'est pas un bug du build : SmartScreen ne juge que la *réputation* de l'éditeur,
qu'il déduit du certificat et de l'historique de téléchargement. Aucun réglage,
aucune option de compilation ne peut remplacer ça. Les options, du moins au plus
efficace :

| Option | Coût | Effet SmartScreen |
| --- | --- | --- |
| Rien (build actuel) | 0 | Avertissement systématique, « Plus d'infos → Exécuter » |
| Auto-signature (`osslsigncode` + certificat maison) | 0 | **Aucun** — réputation nulle, parfois avertissement supplémentaire. Utile seulement pour tester la chaîne de signature |
| Certificat OV | ~20–100 €/mois | Réputation en quelques semaines/mois |
| Certificat EV (HSM ou clé) | ~200–500 €/mois | Bonne réputation immédiate sur la signature, plus d'effet automatique depuis 2023 |
| **Azure Trusted Signing** | ~10 €/mois + vérification d'identité | Réputation SmartScreen obtenue rapidement : c'est la voie recommandée |
| SignPath for OSS | gratuit si projet open source éligible | Similaire à un certificat géré |

Tant que le certificat n'a pas de réputation, prévenez vos joueurs du clic
« Plus d'informations → Exécuter quand même » : c'est le seul chemin, et le
contourner serait mentir sur l'état du fichier.

## 4. Signer

La signature est branchée sur `bundle.windows.signCommand` de Tauri : chaque binaire
passe par `scripts/sign-windows.mjs` **avant** d'être emballé, y compris l'uninstallateur
généré par NSIS. Sans moteur configuré, le script échoue en expliquant quoi mettre en place.

Trois pièges vérifiés à l'exécution, si vous écrivez votre propre `signCommand` :

- Tauri exécute la commande **depuis `src-tauri/`** : un chemin relatif de script ne
  résout pas, il faut un chemin absolu (le script de build l'injecte).
- Le chemin du fichier n'est **pas ajouté en argument** : c'est le marqueur `%1` de la
  commande qui est remplacé. Oublier `%1` donne une liste d'arguments vide.
- Ne signez pas que l'exe : Tauri fait aussi passer les DLL des plugins NSIS
  (`NSISdl.dll`, `StartMenu.dll`, `nsDialogs.dll`, `nsis_tauri_utils.dll`) et le fichier
  temporaire de l'uninstallateur — huit appels pour un build avec installateur.

### Azure Trusted Signing

Une fois le compte créé dans le portail Azure (compte de signature de code, domaine
vérifié par enregistrement TXT, profil de certificat, consentement de politique) :

```bash
curl -sSL https://dot.net/v1/dotnet-install.sh | bash /dev/stdin --channel LTS
export PATH="$HOME/.dotnet:$PATH"
dotnet tool install --global Azure.CodeSigning.Cli
az login

export AZURE_TRUSTED_SIGNING_ACCOUNT=<nom-du-compte-de-signature>
export AZURE_TRUSTED_SIGNING_ENDPOINT=<url-du-compte>
export AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE=<nom-du-profil>
export MYCRAFT_ABOUT_URL=https://votre-domaine/          # affiché dans la fenêtre de propriétés
npm run desktop:build:sign
```

Le script construit lui-même la liste de fichiers exigée par `azcs` et son empreinte
`--trusted-file-hash`, puis affiche la commande exacte exécutée. Les drapeaux d'`azcs`
évoluent plus vite que ce dépôt : s'ils changent, surchargez sans toucher au code avec
`MYCRAFT_AZCS_ARGS="…"`. **Ce chemin n'a pas pu être exécuté ici** (pas de compte
Azure) : validez-le une fois sur un petit build avant de publier.

### Certificat PKCS#12 classique (OV/EV, ou test auto-signé)

```bash
sudo apt-get install osslsigncode
export MYCRAFT_PFX=./mon-certificat.p12
export MYCRAFT_PFX_PASSWORD='…'
export MYCRAFT_ABOUT_URL=https://votre-domaine/
export MYCRAFT_TIMESTAMP_URL=http://timestamp.digicert.com   # horodatage RFC 3161
npm run desktop:build:sign
```

L'horodatage n'est pas décoratif : sans lui, le certificat expiré rend toutes les
versions déjà distribuées suspectes du jour au lendemain.

### Autre outil

`MYCRAFT_SIGN_COMMAND="ma-commande"` : le chemin du fichier est ajouté en dernier argument.

## 5. Hygiène anti-faux-positif Defender

Ce qui, en plus de la signature, réduit réellement les blocages :

- **Pas de packer.** LTO + `strip = true` sont activés dans `src-tauri/Cargo.toml`, aucun
  UPX : les exes compressés par UPX sont signalés par défaut.
- **Un seul binaire, pas de dropper.** L'installateur NSIS installe en `currentUser`
  (dans `%LOCALAPPDATA%`), donc sans escalade de privilèges ni UAC.
- **Identité stable.** Même `productName`, même `identifier` (`com.mycraft.game`),
  même nom de fichier ; incrémentez `version` dans `package.json` à chaque publication
  au lieu de renvoyer un homonyme différent.
- **Hébergement stable et en HTTPS.** La réputation SmartScreen est aussi attachée à
  l'URL de téléchargement : changer constamment d'URL remet le compteur à zéro.
- **Rien de louche à l'exécution.** Le jeu n'utilise que WebView2 officiel, le dialogue
  natif Windows et le disque de l'utilisateur ; les capacités Tauri sont réduites à
  `core:default` + `dialog:allow-open` (`src-tauri/capabilities/default.json`).
- **En cas de faux positif**, soumettez le fichier via le [formulaire de soumission
  Microsoft](https://www.microsoft.com/wdsi/filesubmission) et joignez le SHA-256 affiché
  par le build : c'est le canal qui débloque la réputation, pas un rebuild.

## 6. Dépannage

| Symptôme | Cause probable |
| --- | --- |
| `clang-cl: command not found` | Le lien `.build-tools/bin/clang-cl` n'est pas sur le `PATH` du shell lancé à la main — passez par `scripts/build-desktop.sh` |
| `xwin: failed to download SDK` | Pas de réseau, ou `XWIN_CACHE_DIR` pointé vers un dossier vide ; le cache par défaut est `~/.cache/xwin` |
| `link.exe not found` | Le `--runner cargo-xwin` a été oublié : toujours passer par le script, jamais `cargo build --target …` directement |
| `makensis` absent | `sudo apt-get install nsis`, ou build `--portable` seul |
| Fenêtre noire au premier lancement sur un autre PC | WebView2 absent : l'installateur le télécharge (`downloadBootstrapper`) ; l'exe portable suppose qu'il est déjà là |
| SmartScreen bloque malgré la signature | Réputation pas encore établie, ou fichier téléchargé depuis une URL différente de celle déclarée dans `MYCRAFT_ABOUT_URL` |
