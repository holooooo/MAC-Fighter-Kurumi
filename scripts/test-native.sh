#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
BUILD="$ROOT/output/native-regression"
mkdir -p "$BUILD"
xcrun swiftc -O \
  "$ROOT/native/Sources/JiuliuPet/PetInteraction.swift" \
  "$ROOT/native/Widget/WidgetTiming.swift" \
  "$ROOT/native/Tests/JiuliuPetTests/PetInteractionTests.swift" \
  "$ROOT/native/Tests/JiuliuPetTests/WidgetTimingTests.swift" \
  "$ROOT/native/Tests/main.swift" -o "$BUILD/regression"
"$BUILD/regression"
