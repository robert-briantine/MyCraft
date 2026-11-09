#!/usr/bin/env bash
# Fabrique les livrables Windows de MyCraft depuis cette machine Linux ARM.
#
#   scripts/build-desktop.sh                 # exe portable + installateur NSIS
#   scripts/build-desktop.sh --portable      # seulement MyCraft.exe
#   scripts/build-desktop.sh --installer     # seulement l'installateur NSIS
#   scripts/build-desktop.sh --sign          # en passant par scripts/sign-windows.mjs
#   scripts/build-desktop.sh --debug         # profil debug (plus rapide, non livré)
#
# La croix est assurée par cargo-xwin : clang compile pour l'ABI MSVC et
# lld-link assemble, sans Visual Studio ni machine Windows.
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_TRIPLE=x86_64-pc-windows-msvc
TAURI="$PROJECT_DIR/node_modules/@tauri-apps/cli/tauri.js"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PROJECT_DIR/src-tauri/target}"
export XWIN_CACHE_DIR="${XWIN_CACHE_DIR:-$HOME/.cache/xwin}"

portable=1
installer=1
signing=0
profile=release

while [[ $# -gt 0 ]]; do
  case "$1" in
    --portable) installer=0 ;;
    --installer) portable=0 ;;
    --sign) signing=1 ;;
    --debug) profile=debug ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
  shift
done

[[ $portable -eq 1 || $installer -eq 1 ]] || { echo 'Rien à construire (--portable ou --installer).' >&2; exit 2; }

# ---- outils requis -------------------------------------------------------
missing=()
for tool in cargo cargo-xwin clang lld-link llvm-rc; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
if [[ $installer -eq 1 ]] && ! command -v makensis >/dev/null; then
  missing+=("makensis (paquet nsis)")
fi
[[ -f "$TAURI" ]] || missing+=("@tauri-apps/cli — npm install")
if [[ ${#missing[@]} -gt 0 ]]; then
  printf 'Outil manquant : %s\n' "${missing[@]}" >&2
  echo 'Voir docs/desktop-build.md pour l’installation.' >&2
  exit 1
fi

# clang choisit son pilote MSVC d'après argv[0] : un simple lien suffit.
shim_dir="$PROJECT_DIR/.build-tools/bin"
mkdir -p "$shim_dir"
ln -sf "$(command -v clang)" "$shim_dir/clang-cl"
export PATH="$shim_dir:$PATH"

echo "── MyCraft · cible $TARGET_TRIPLE ($profile) ─────────────────────────"
echo "   cache SDK Windows : $XWIN_CACHE_DIR"
echo "   répertoire cible  : $CARGO_TARGET_DIR"

out_dir="$PROJECT_DIR/release/windows-x64"
[[ $profile == debug ]] && out_dir="$PROJECT_DIR/release/windows-x64-debug"
mkdir -p "$out_dir"

common=(build --ci --target "$TARGET_TRIPLE" --runner cargo-xwin
        --config "$PROJECT_DIR/src-tauri/tauri.windows.conf.json")
[[ $profile == debug ]] && common+=(--debug)
if [[ $signing -eq 1 ]]; then
  # Tauri lance signCommand depuis src-tauri (chemin absolu obligatoire) et
  # remplace %1 par le fichier à signer ; il signe aussi les DLL des plugins NSIS.
  common+=(--config "{\"bundle\":{\"windows\":{\"signCommand\":\"node $PROJECT_DIR/scripts/sign-windows.mjs %1\"}}}")
else
  common+=(--no-sign)
fi

run_tauri() {
  node "$TAURI" "${common[@]}" "$@"
  echo
}

# cargo produit `mycraft.exe` (nom du crate) ; mainBinaryName ne renomme que le
# binaire embarqué dans l'installateur. On normalise donc le nom ici.
copy_exe() {
  local src
  for src in "$CARGO_TARGET_DIR/$TARGET_TRIPLE/$profile/MyCraft.exe" \
             "$CARGO_TARGET_DIR/$TARGET_TRIPLE/$profile/mycraft.exe"; do
    if [[ -f "$src" ]]; then
      cp "$src" "$out_dir/MyCraft.exe"
      return 0
    fi
  done
  echo "Exécutable introuvable dans $CARGO_TARGET_DIR/$TARGET_TRIPLE/$profile" >&2
  return 1
}

if [[ $portable -eq 1 ]]; then
  echo "── exécutable portable ──────────────────────────────────────────────"
  run_tauri --no-bundle
  copy_exe
fi

if [[ $installer -eq 1 ]]; then
  echo "── installateur NSIS ────────────────────────────────────────────────"
  run_tauri --bundles nsis
  shopt -s nullglob
  local_setup=("$CARGO_TARGET_DIR/$TARGET_TRIPLE/$profile"/bundle/nsis/*[sS]etup*.exe)
  shopt -u nullglob
  [[ ${#local_setup[@]} -gt 0 ]] || { echo 'Installateur NSIS introuvable.' >&2; exit 1; }
  cp "${local_setup[@]}" "$out_dir/"
fi

echo
echo "── livrables ────────────────────────────────────────────────────────"
shopt -s nullglob
artifacts=("$out_dir"/MyCraft.exe "$out_dir"/MyCraft_*-setup.exe)
[[ ${#artifacts[@]} -eq 0 ]] && { echo 'Aucun livrable produit.' >&2; exit 1; }
for f in "${artifacts[@]}"; do
  # LC_ALL=C : sans ça, bash printf refuse « 8.3 » dans une locale à virgule.
  printf '%-46s %7s Mo  %s\n' "$(basename "$f")" \
    "$(LC_ALL=C awk -v s="$(stat -c%s "$f")" 'BEGIN{printf "%.1f", s/1048576}')" \
    "$(sha256sum "$f" | cut -c1-16)…"
done
[[ $signing -eq 0 ]] && echo $'\nBuild NON signé : Windows affichera un avertissement SmartScreen.\nAjoutez --sign après avoir configuré un certificat (voir docs/desktop-build.md).'
echo "Dossier : $out_dir"
