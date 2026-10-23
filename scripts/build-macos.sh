#!/bin/bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
NATIVE="$ROOT/native"
APP="$ROOT/output/韭留美.app"
NODE_SOURCE="${KURUMI_NODE_PATH:-$(command -v node)}"
if [[ "$NODE_SOURCE" != /* || ! -x "$NODE_SOURCE" ]]; then
  echo 'Node 必须是可执行文件的绝对路径；设置 KURUMI_NODE_PATH。' >&2
  exit 1
fi
# A portable Node must link only system libraries; do not silently ship broken Homebrew links.
if otool -L "$NODE_SOURCE" | awk '/compatibility version/ {print $1}' | awk '!/^\/System\// && !/^\/usr\/lib\// {bad=1} END {exit !bad}'; then
  echo '此 Node 依赖非系统动态库，请指定官方独立 Node 发行版。' >&2
  exit 1
fi
swift build --package-path "$NATIVE" -c release
BIN_DIR="$(swift build --package-path "$NATIVE" -c release --show-bin-path)"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web/assets" "$APP/Contents/Resources/web/vendor" "$APP/Contents/Resources/runtime"
cp "$BIN_DIR/JiuliuPet" "$APP/Contents/MacOS/JiuliuPet"
HOST_ARCH="$(uname -m)"
NODE_ARCHS="$(lipo -archs "$NODE_SOURCE")"
if [[ "$NODE_ARCHS" == *" "* ]]; then
  lipo "$NODE_SOURCE" -thin "$HOST_ARCH" -output "$APP/Contents/Resources/runtime/node"
else
  if [[ "$NODE_ARCHS" != "$HOST_ARCH" ]]; then
    echo "Node 架构 $NODE_ARCHS 与宿主 $HOST_ARCH 不一致。" >&2
    exit 1
  fi
  cp "$NODE_SOURCE" "$APP/Contents/Resources/runtime/node"
fi
chmod 755 "$APP/Contents/MacOS/JiuliuPet" "$APP/Contents/Resources/runtime/node"
NODE_LICENSE_SOURCE="${KURUMI_NODE_LICENSE_PATH:-$(dirname "$(dirname "$NODE_SOURCE")")/LICENSE}"
if [[ -s "$NODE_LICENSE_SOURCE" && ! -L "$NODE_LICENSE_SOURCE" ]]; then
  cp "$NODE_LICENSE_SOURCE" "$APP/Contents/Resources/runtime/LICENSE"
else
  echo '提示：缺少此Node发行版LICENSE；开发构建可运行，但发布打包将拒绝。' >&2
fi
for item in server.cjs pet-engine.js performance-history.cjs candle-history.cjs system-telemetry.cjs agent-telemetry.cjs pet.html pet.css pet-ui.js pet-charts.js pet-bootstrap.js pet-animation.js pet-diary.js pet-speech.js pet-diary.css; do
  cp "$ROOT/$item" "$APP/Contents/Resources/web/$item"
done
# Keep the source directories untouched; refresh only this explicitly resolved bundle's assets.
python3 - "$ROOT" "$APP" <<'PY'
import json, pathlib, shutil, sys
root=pathlib.Path(sys.argv[1]).resolve()
app=pathlib.Path(sys.argv[2]).resolve()
assert app == root/'output'/'韭留美.app', 'Unexpected bundle path'
for name in ('assets','vendor'):
    source=root/name
    target=app/'Contents'/'Resources'/'web'/name
    assert target.resolve() == app/'Contents'/'Resources'/'web'/name
    if target.exists(): shutil.rmtree(target)
    target.mkdir()
manifest=json.loads((root/'vendor'/'chart-dependencies.json').read_text())
vendor_files=[entry['file'] for entry in manifest['files']]
assert len(vendor_files) == 8 and len(set(vendor_files)) == 8
assert all(pathlib.PurePosixPath(name).parent == pathlib.PurePosixPath('vendor') and (root/name).is_file() for name in vendor_files), 'Unexpected chart dependency path'
for name in ('assets/kurumi-generated-idle.png', 'assets/kurumi-generated.json', 'assets/memes.json', 'assets/meme-generated-profit.png', 'assets/meme-generated-buy.png', 'assets/meme-generated-loss.png', 'vendor/chart-dependencies.json', *vendor_files):
    shutil.copy2(root/name, app/'Contents'/'Resources'/'web'/name)
# Full-alpha APNGs drive runtime playback; GIFs remain downloadable exports.
animation_names={'idle','wave','stretch','look','press','dragging','landing','profit','buy','sell','loss','liquidation','sleep','blink','sway'}
source_apngs=root/'assets'/'kurumi-apng'
assert source_apngs.is_dir() and not source_apngs.is_symlink(), 'Unexpected generated APNG directory'
apngs=sorted(source_apngs.iterdir())
assert 1 <= len(apngs) <= 64, 'Expected bounded generated APNG collection'
assert all(item.is_file() and not item.is_symlink() and item.suffix == '.png' and item.stem in animation_names for item in apngs), 'Unexpected generated APNG path'
assert {item.stem for item in apngs} == animation_names, 'Missing generated APNG action'
shutil.copytree(source_apngs, app/'Contents'/'Resources'/'web'/'assets'/'kurumi-apng')
source_gifs=root/'assets'/'kurumi-gifs'
gifs=sorted(source_gifs.iterdir())
assert 1 <= len(gifs) <= 64, 'Expected bounded generated GIF collection'
assert not source_gifs.is_symlink() and all(item.is_file() and not item.is_symlink() and item.suffix.lower() == '.gif' for item in gifs), 'Unexpected generated GIF path'
shutil.copytree(source_gifs, app/'Contents'/'Resources'/'web'/'assets'/'kurumi-gifs')
PY
/usr/libexec/PlistBuddy -c 'Clear dict' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string JiuliuPet' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string local.jiuliu.pet' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleName string 韭留美' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleDisplayName string 韭留美' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundlePackageType string APPL' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleShortVersionString string 0.1.0' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleVersion string 1' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :LSMinimumSystemVersion string 13.0' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :NSHighResolutionCapable bool true' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :NSAppTransportSecurity dict' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :NSAppTransportSecurity:NSAllowsArbitraryLoadsInWebContent bool true' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes array' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0 dict' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLName string local.jiuliu.pet.panel' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string jiuliupet' "$APP/Contents/Info.plist"
codesign --force --sign - "$APP/Contents/Resources/runtime/node"
codesign --force --sign - "$APP/Contents/MacOS/JiuliuPet"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"
printf '已构建：%s\n本地 ad-hoc 签名，未公证；运行时架构取决于当前 Swift 工具链。\n' "$APP"
