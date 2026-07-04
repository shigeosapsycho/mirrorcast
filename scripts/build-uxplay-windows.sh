#!/usr/bin/env bash
#
# build-uxplay-windows.sh — build the UxPlay FairPlay engine on Windows via
# MSYS2, so MirrorCast can drive it. Run from an MSYS2 MINGW64 shell, or:
#
#   MSYSTEM=MINGW64 C:/msys64/usr/bin/bash.exe -lc "bash scripts/build-uxplay-windows.sh"
#
# Result: $HOME/uxplay-build/build/uxplay.exe — MirrorCast auto-detects it
# (EngineController.locate scans C:\msys64\home\*\uxplay-build\build) and injects
# C:\msys64\mingw64\bin into PATH at launch for the GStreamer runtime.
set -eo pipefail

echo "==[1/4] toolchain + GStreamer + deps (retries on slow mirrors) =="
PKGS="git
  mingw-w64-x86_64-gcc mingw-w64-x86_64-cmake mingw-w64-x86_64-ninja
  mingw-w64-x86_64-openssl mingw-w64-x86_64-libplist
  mingw-w64-x86_64-gstreamer mingw-w64-x86_64-gst-plugins-base
  mingw-w64-x86_64-gst-plugins-good mingw-w64-x86_64-gst-plugins-bad
  mingw-w64-x86_64-gst-libav"
n=0
until pacman -S --needed --noconfirm --disable-download-timeout $PKGS; do
  n=$((n+1)); [ "$n" -ge 6 ] && { echo "pacman gave up"; exit 1; }
  echo "pacman retry $n..."; sleep 5
done

SRC="$HOME/uxplay-build"
echo "==[2/4] clone UxPlay -> $SRC =="
rm -rf "$SRC"
git clone --depth 1 https://github.com/FDH2/UxPlay.git "$SRC"
cd "$SRC"

echo "==[3/4] configure =="
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release

echo "==[4/4] build =="
cmake --build build

[ -f build/uxplay.exe ] && echo "OK: $(cygpath -w "$SRC/build/uxplay.exe")" || { echo "FAILED"; exit 1; }
