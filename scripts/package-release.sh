#!/bin/bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
APP="$ROOT/output/韭留美.app"
DIST="$ROOT/dist"
TAG="${1:-}"
fail() { printf 'Release packaging: %s\n' "$*" >&2; exit 1; }
if [[ $# -ne 1 || ! "$TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
  fail 'Usage: bash scripts/package-release.sh vMAJOR.MINOR.PATCH[-prerelease]'
fi
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || fail 'Run on native Apple Silicon macOS; Intel/Rosetta builds are not arm64 releases.'
[[ -d "$APP" && ! -L "$ROOT/output" && ! -L "$APP" ]] || fail 'Build output/韭留美.app first; symlinked output is refused.'
[[ ! -L "$DIST" ]] || fail 'dist must not be a symlink.'
mkdir -p "$DIST"
[[ "$(CDPATH= cd -- "$DIST" && pwd -P)" == "$ROOT/dist" ]] || fail 'Unexpected dist path.'
ZIP="$DIST/JiuliuPet-${TAG}-macos-arm64.zip"
[[ ! -e "$ZIP" && ! -L "$ZIP" && ! -e "$DIST/SHA256SUMS" && ! -L "$DIST/SHA256SUMS" ]] || fail 'Release outputs already exist. Move them aside deliberately before packaging again.'
# Validate before copying: never archive the workspace, output/, caches, or user state.
python3 - "$APP" <<'PY'
import pathlib, plistlib, sys
app=pathlib.Path(sys.argv[1])
for item in app.rglob('*'):
    if item.is_symlink(): raise SystemExit(f'Refusing bundle symlink: {item}')
    if item.name in {'.git', '.env', 'node_modules', '.DS_Store', 'live-state.json', '.build'} or item.suffix in {'.pem', '.p12', '.mobileprovision'}:
        raise SystemExit(f'Refusing private/build-only bundle item: {item}')
for rel, expected in [('Contents/Info.plist','JiuliuPet'), ('Contents/PlugIns/JiuliuWidget.appex/Contents/Info.plist','JiuliuWidget')]:
    with (app/rel).open('rb') as f: info=plistlib.load(f)
    if info.get('CFBundleExecutable') != expected: raise SystemExit(f'Unexpected executable in {rel}')
with (app/'Contents/Info.plist').open('rb') as f: host=plistlib.load(f)
if host.get('CFBundleIconFile') != 'app-icon.icns': raise SystemExit('Missing app icon declaration')
for rel in ['Contents/Resources/app-icon.icns','Contents/Resources/web/server.cjs','Contents/Resources/web/pet.html','Contents/Resources/web/assets/kurumi-generated.json','Contents/Resources/web/vendor/chart-dependencies.json']:
    if not (app/rel).is_file(): raise SystemExit(f'Missing runtime resource: {rel}')
actions={'idle','wave','stretch','look','press','dragging','landing','profit','buy','sell','loss','liquidation','sleep','blink','sway'}
for action in actions:
    p=app/'Contents/Resources/web/assets/kurumi-apng'/f'{action}.png'
    if not p.is_file() or not p.stat().st_size: raise SystemExit(f'Missing APNG: {action}')
PY
for executable in "$APP/Contents/MacOS/JiuliuPet" "$APP/Contents/Resources/runtime/node" "$APP/Contents/PlugIns/JiuliuWidget.appex/Contents/MacOS/JiuliuWidget"; do
  [[ -x "$executable" && "$(lipo -archs "$executable")" == arm64 ]] || fail "Not a native arm64 executable: $executable"
  if otool -L "$executable" | awk '/compatibility version/ {print $1}' | awk '!/^\/System\// && !/^\/usr\/lib\// {bad=1} END {exit !bad}'; then
    fail "Non-system dynamic library dependency: $executable"
  fi
done
[[ "$("$APP/Contents/Resources/runtime/node" -p 'process.arch')" == arm64 ]] || fail 'Bundled Node cannot execute as arm64.'
codesign --verify --deep --strict "$APP"
STAGE="$(mktemp -d "$DIST/.package-release.XXXXXXXX")"
cleanup() {
  # Only remove the absolute directory created by mktemp directly under verified dist.
  case "$STAGE" in "$ROOT/dist/".package-release.*)
    if [[ -d "$STAGE" && ! -L "$STAGE" && "$(CDPATH= cd -- "$STAGE/.." && pwd -P)" == "$ROOT/dist" ]]; then rm -rf -- "$STAGE"; fi ;;
  esac
}
trap cleanup EXIT
PAYLOAD="$STAGE/payload"
mkdir -p "$PAYLOAD"
/usr/bin/ditto --noextattr --norsrc "$APP" "$PAYLOAD/韭留美.app"
cp "$ROOT/README.md" "$PAYLOAD/README.md"
# Include only real project notices; do not infer or create an open-source license.
cp "$ROOT/docs/installation.md" "$PAYLOAD/INSTALL.md"
for notice in LICENSE LICENSE.md LICENSE.txt NOTICE NOTICE.md THIRD_PARTY_NOTICES.md THIRD-PARTY-NOTICES.md; do
  if [[ -f "$ROOT/$notice" && ! -L "$ROOT/$notice" ]]; then cp "$ROOT/$notice" "$PAYLOAD/$notice"; fi
done
STAGED_APP="$PAYLOAD/韭留美.app"
NODE_LICENSE="$STAGED_APP/Contents/Resources/runtime/LICENSE"
if [[ ! -s "$NODE_LICENSE" ]]; then
  [[ -n "${KURUMI_NODE_LICENSE_PATH:-}" && -s "$KURUMI_NODE_LICENSE_PATH" && ! -L "$KURUMI_NODE_LICENSE_PATH" ]] || fail 'Node redistribution LICENSE is required in runtime/LICENSE or KURUMI_NODE_LICENSE_PATH.'
  cp "$KURUMI_NODE_LICENSE_PATH" "$NODE_LICENSE"
fi
VERSION="${TAG#v}"
VERSION="${VERSION%%-*}"
for plist in "$STAGED_APP/Contents/Info.plist" "$STAGED_APP/Contents/PlugIns/JiuliuWidget.appex/Contents/Info.plist"; do
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$plist"
  plutil -lint "$plist"
done
# Re-sign only the staged copy after plist/notice changes. No identity lookup or keychain access.
codesign --force --sign - "$STAGED_APP/Contents/Resources/runtime/node"
codesign --force --sign - --preserve-metadata=entitlements "$STAGED_APP/Contents/PlugIns/JiuliuWidget.appex"
codesign --force --sign - "$STAGED_APP"
codesign --verify --deep --strict "$STAGED_APP"
/usr/bin/ditto -c -k --norsrc "$PAYLOAD" "$STAGE/release.zip"
python3 - "$STAGE/release.zip" <<'PY'
import pathlib, sys, zipfile
# ditto can store UTF-8 Chinese paths without setting the ZIP UTF-8 flag.
with zipfile.ZipFile(sys.argv[1], metadata_encoding='utf-8') as archive:
    names=archive.namelist()
    for name in names:
        p=pathlib.PurePosixPath(name)
        if p.is_absolute() or '..' in p.parts or '\\' in name: raise SystemExit(f'Unsafe archive entry: {name}')
        if p.parts[0] not in {'韭留美.app','README.md','INSTALL.md','LICENSE','LICENSE.md','LICENSE.txt','NOTICE','NOTICE.md','THIRD_PARTY_NOTICES.md','THIRD-PARTY-NOTICES.md'}: raise SystemExit(f'Unexpected archive root: {name}')
    for name in ['README.md','韭留美.app/Contents/Resources/app-icon.icns','韭留美.app/Contents/MacOS/JiuliuPet','韭留美.app/Contents/Resources/runtime/node','韭留美.app/Contents/Resources/runtime/LICENSE','韭留美.app/Contents/PlugIns/JiuliuWidget.appex/Contents/MacOS/JiuliuWidget']:
        if name not in names: raise SystemExit(f'Missing archive entry: {name}')
    if archive.testzip() is not None: raise SystemExit('ZIP checksum verification failed')
PY
# Never replace an existing artifact. Keep final outputs out of the temporary stage.
[[ ! -e "$ZIP" && ! -L "$ZIP" ]] || fail 'Archive appeared while packaging.'
cp -n "$STAGE/release.zip" "$ZIP"
(cd "$DIST" && shasum -a 256 "${ZIP##*/}" > "$STAGE/SHA256SUMS")
cp -n "$STAGE/SHA256SUMS" "$DIST/SHA256SUMS"
(cd "$DIST" && shasum -a 256 -c SHA256SUMS)
printf 'Packaged %s\nChecksums: %s/SHA256SUMS\nAd-hoc signed, not notarized. Apple Silicon only.\n' "$ZIP" "$DIST"
