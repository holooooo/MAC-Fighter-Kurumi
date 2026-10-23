#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
APP="$ROOT/output/韭留美.app"
BUILD="$ROOT/output/widget-build"
EXTENSION="$APP/Contents/PlugIns/JiuliuWidget.appex"
SDK="$(xcrun --sdk macosx --show-sdk-path)"
ARCH="$(uname -m)"
case "$ARCH" in arm64|x86_64) ;; *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; esac
if [[ ! -d "$APP/Contents/MacOS" || ! -f "$APP/Contents/Info.plist" ]]; then
  echo "Build the existing host output/韭留美.app first." >&2
  exit 1
fi
if [[ -L "$APP" || -L "$APP/Contents" || -L "$APP/Contents/PlugIns" || -L "$EXTENSION" ]]; then
  echo "Refusing symlinked output bundle." >&2
  exit 1
fi
mkdir -p "$BUILD" "$EXTENSION/Contents/MacOS"
printf 'Compile WidgetKit: arch=%s sdk=%s deployment=14.0\n' "$ARCH" "$SDK"
xcrun swiftc -parse-as-library -application-extension -O \
  -sdk "$SDK" -target "$ARCH-apple-macosx14.0" \
  -module-cache-path "$BUILD/module-cache" \
  -framework SwiftUI -framework WidgetKit \
  "$ROOT/native/Widget/WidgetTiming.swift" "$ROOT/native/Widget/JiuliuWidget.swift" -o "$BUILD/JiuliuWidget"
cp "$BUILD/JiuliuWidget" "$EXTENSION/Contents/MacOS/JiuliuWidget"
cp "$ROOT/native/Widget/Info.plist" "$EXTENSION/Contents/Info.plist"
plutil -lint "$EXTENSION/Contents/Info.plist" "$ROOT/native/Widget/Widget.entitlements"
# Local ad-hoc only: never query identities or trigger a private-key prompt.
codesign --force --sign - --entitlements "$ROOT/native/Widget/Widget.entitlements" "$EXTENSION"
codesign --force --sign - --preserve-metadata=entitlements "$APP"
codesign --verify --strict --verbose=2 "$EXTENSION"
codesign --verify --deep --strict --verbose=2 "$APP"
printf 'Built and verified: %s\nSystem registration and gallery discovery are separate validation steps.\n' "$EXTENSION"
