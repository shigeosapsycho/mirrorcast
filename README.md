# MirrorCast 📱→🖥️

**Free, open AirPlay 2 screen-mirroring receiver for Windows and macOS.**
Your iPhone sees it automatically in **Control Center → Screen Mirroring** — no USB
cable, no custom iOS app, no typing IP addresses.

MirrorCast advertises itself on your Wi-Fi with Bonjour/mDNS (pure JavaScript, no
Apple SDK), so it appears in the native iOS mirroring list just like an Apple TV.

---

## How it works — and what you need

Apple gates the mirror stream behind **FairPlay** (a proprietary handshake at
`POST /fp-setup` + AES encryption of the H.264 stream). FairPlay is *not* in
Node's `crypto` and can't be done with `net`/`crypto` alone — it exists only in
reverse-engineered **GPL** projects ([UxPlay](https://github.com/FDH2/UxPlay),
[RPiPlay](https://github.com/FD-/RPiPlay)).

So MirrorCast does what every working receiver does: it **drives one of those
engines as a separate process** and displays the decoded video in its own
window. The engine does the FairPlay crypto; MirrorCast owns the UI, the
discovery, and the display.

```
iPhone ──▶ UxPlay/RPiPlay (FairPlay decrypt) ──H.264──▶ 127.0.0.1:9001
                                                            │
                              MirrorCast ingest ──▶ ffmpeg ──▶ canvas
```

Running the GPL engine as an independent process (mere aggregation, no linking)
keeps MirrorCast itself **MIT** — we don't bundle or link its code.

| Stage | Status |
|-------|--------|
| Appears in iOS Control Center → Screen Mirroring | ✅ Works |
| iPhone connects & runs RTSP/HTTP + pairing handshake (built-in) | ✅ Works |
| **Video decode + display path** (H.264 → ffmpeg → canvas) | ✅ **Works — verified** |
| Live iPhone mirror on screen | ✅ Works **with an engine installed** (below) |
| Audio playback plumbing | ✅ Ready (Web Audio) |
| Dark UI, settings, status bar | ✅ Works |

**Prove the display path in 10 seconds, no iPhone and no engine needed:**
```bash
npm start            # terminal 1 — launch MirrorCast
npm run stream-test  # terminal 2 — pipes a test pattern into the app window
```
You should see a moving test pattern fill the phone frame. That confirms
everything downstream of the engine works; installing an engine simply replaces
the test pattern with your real iPhone screen.

---

## Requirements

- **Node.js 18+** (to build/run from source)
- An **iPhone/iPad on the same Wi-Fi network** as your computer
- **iOS 12 or newer**
- Windows 10/11 or macOS 11+

`ffmpeg` is bundled automatically via `ffmpeg-static` — no manual install.

---

## Install

### From a release (recommended for most users)
Download for your platform from the
[Releases page](https://github.com/shigeosapsycho/mirrorcast/releases):

- **Windows** — `MirrorCast-Setup-x.y.z.exe` (NSIS installer, **auto-updates**)
  or `MirrorCast-x.y.z.msi` (enterprise/silent install; no auto-update)
- **macOS** — `MirrorCast-x.y.z.dmg` (unsigned — see Gatekeeper note below)

#### macOS: opening an unsigned build 🍎
These builds are **not code-signed** (no Apple Developer certificate), so macOS
Gatekeeper will say the app "is damaged and can't be opened" or "cannot be
opened because the developer cannot be verified." Clear the quarantine flag once:

```bash
xattr -cr /Applications/MirrorCast.app
```

Then open it normally. (`-cr` clears extended attributes recursively; equivalently
`xattr -d com.apple.quarantine /Applications/MirrorCast.app`.) Alternatively,
right-click the app → **Open** → **Open** to bypass Gatekeeper for that launch.
If you moved the app straight from the `.dmg`, run the command against wherever
you placed it.

### Build from source
```bash
git clone https://github.com/your-org/mirrorcast.git
cd mirrorcast
npm install          # also generates assets/icon.png
npm start            # launch the app
```

Package installers yourself:
```bash
npm run build:win    # -> release/MirrorCast-Setup-*.exe
npm run build:mac    # -> release/MirrorCast-*.dmg
```

---

## 📲 Connect your iPhone

1. Make sure your iPhone and this computer are on the **same Wi-Fi network**.
2. Launch **MirrorCast**. It shows *"Waiting for your iPhone…"*.
3. On your iPhone, swipe to open **Control Center**.
4. Tap **🔲 Screen Mirroring**.
5. Tap **MirrorCast** (or whatever you renamed it to in Settings ⚙️).

The status bar turns 🟢 **green** when your iPhone connects.

---

## Settings ⚙️

Open the gear (top-right) to slide in settings:

- **Receiver name** — what shows on your iPhone's mirroring list (defaults to your
  computer's hostname). Changes apply live.
- **Audio** — play mirrored audio through this computer's default output.
- **Always on top** — keep the MirrorCast window above other apps.
- **Require PIN code** — iPhones must enter a 4-digit code (shown in the
  MirrorCast window) before they can mirror. A fresh code is generated each
  time the receiver starts.

Mute is also one tap away in the status bar.

## Capture & viewing 📸

While a device is mirroring:

- **Screenshot** — camera button in the status bar, or **Ctrl+S** (⌘S on Mac).
  Saved as PNG to `Pictures/MirrorCast`.
- **Screen recording** — record button in the status bar starts/stops; a timer
  shows while recording. Saved as `.mp4` (with the mirrored audio) to
  `Videos/MirrorCast`. Recording stops automatically if the stream ends.
- **Fullscreen** — double-click the mirror or press **F11**; **Esc** exits.
  The status bar slides in when you move the mouse.

---

## 🛠️ Troubleshooting

### MirrorCast doesn't appear on my iPhone
- Confirm **both devices are on the same Wi-Fi** (not one on Ethernet + a
  different subnet, not a "Guest" network that isolates clients).
- Many routers block **mDNS/Bonjour** between wireless clients ("AP isolation" /
  "client isolation"). Turn that off.
- On **Windows**, approve the firewall prompt (see below).
- Restart MirrorCast — it re-announces on launch.

### Windows Firewall
The first launch, Windows Defender Firewall will prompt to allow MirrorCast to
communicate on the network. **Allow it on Private networks.** If you dismissed the
prompt, MirrorCast shows a *"Port blocked"* message; then:

1. Windows Security → **Firewall & network protection** → **Allow an app through
   firewall**.
2. Find **MirrorCast** (or **Electron**/**node**), tick **Private**.
3. Restart the app.

Ports used: **7000** (control/RTSP) and **7100** (video data), plus **UDP 5353**
for mDNS.

### It connects but the screen stays black
You likely have **no engine installed**, so nothing is decrypting the FairPlay
stream. Run `npm run engine:check`, install UxPlay, and confirm it streams H.264
to `127.0.0.1:9001` (see **Wiring an engine**). Sanity-check the display path
itself with `npm run stream-test` — if the test pattern appears, the only
missing piece is the engine.

### No audio
- Toggle **Audio** on in Settings and make sure the status-bar speaker isn't
  muted (amber = muted).
- Audio only plays once a stream is actually decoding.

---

## Install an engine

Check what MirrorCast can see:
```bash
npm run engine:check
```

**macOS** (easiest):
```bash
brew install uxplay        # pulls gstreamer + uxplay
```
UxPlay lands on your PATH; MirrorCast (engine mode `auto`) detects it on next
launch.

**Windows:** UxPlay builds via [MSYS2](https://www.msys2.org/) (it needs the
GStreamer runtime). With MSYS2 installed, one command builds it:
```bash
MSYSTEM=MINGW64 C:/msys64/usr/bin/bash.exe -lc "bash scripts/build-uxplay-windows.sh"
```
This produces `~/uxplay-build/build/uxplay.exe`. **MirrorCast auto-detects it** —
`EngineController.locate()` scans `C:\msys64\home\*\uxplay-build\build` and
injects `C:\msys64\mingw64\bin` into `PATH` for the GStreamer DLLs at launch. No
config needed; just build it and run `npm start`. (Or set `enginePath` to any
`uxplay.exe` you already have.)

**Linux:** `sudo apt install uxplay` or build from source.

## Wiring an engine

MirrorCast reads decoded video from a localhost socket:

> **Contract:** the engine must stream **H.264 (Annex-B)** to
> **`tcp://127.0.0.1:9001`**. Anything that satisfies this shows up in the
> MirrorCast window.

For UxPlay ≥ 1.68 with the GStreamer good/bad plugins, tee H.264 to that port:
```bash
uxplay -n "MirrorCast" -nh \
  -vs "h264parse ! tcpclientsink host=127.0.0.1 port=9001"
```

MirrorCast can also **launch the engine for you**. Edit the config file
(`mirrorcast.config.json` in your userData dir — the path is shown in
`engine:check` output on some platforms; on Windows it's
`%APPDATA%/MirrorCast/`):

```jsonc
{
  "engineMode": "auto",          // "auto" | "external" | "builtin"
  "enginePath": null,            // absolute path to the engine binary, or null to auto-detect
  "engineCommand": [             // argv template; tokens {ENGINE} {NAME} {INGEST_PORT}
    "{ENGINE}", "-n", "{NAME}", "-nh",
    "-vs", "h264parse ! tcpclientsink host=127.0.0.1 port={INGEST_PORT}"
  ]
}
```

- `engineMode: "auto"` → use an engine if found, else fall back to built-in
  discovery (iPhone still sees MirrorCast; video stays blank).
- `engineMode: "builtin"` → discovery + handshake only, never spawn an engine.
- Leave `engineCommand: null` to use the built-in default template.

Self-contained builds: drop a binary in `resources/engine/` before packaging —
see [`resources/engine/README.md`](resources/engine/README.md) (note the GPL
implications of redistributing the engine).

---

## Architecture

```
 iPhone ──mDNS──▶  UxPlay/RPiPlay ──FairPlay decrypt──▶ H.264
                        │                                  │
                        └── advertises _airplay._tcp       ▼
                            + does pairing/crypto      tcp://127.0.0.1:9001
                                                            │  (engine.js ingest)
                                                            ▼
                                              decoder.js (ffmpeg) → JPEG
                                                            │  IPC
                                                            ▼
                                              renderer <canvas> (app.js)

 No engine installed?  →  mdns.js + airplay.js (built-in) still make the iPhone
                          SEE MirrorCast; video needs an engine.
```

- `src/main/engine.js` — H.264 ingest server (`127.0.0.1:9001`) + external-engine
  supervisor (locate, spawn, parse logs, restart).
- `src/main/decoder.js` — bundled ffmpeg; H.264 → JPEG frames over IPC.
- `src/main/mdns.js` — pure-JS Bonjour advertisement (built-in mode).
- `src/main/airplay.js` — pure-JS AirPlay control server + pairing (built-in mode).
- `src/renderer/*` — dark, minimal UI; draws frames to a `<canvas>`.
- `scripts/stream-test.js` — synthetic H.264 → ingest (verify display path).
- `scripts/setup-engine.js` — detect/guide engine install.

---

## Releases & auto-update

- **CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) — every push/PR
  runs the syntax check + headless video-pipeline selftest.
- **Release** ([`.github/workflows/release.yml`](.github/workflows/release.yml)) —
  push a tag and GitHub Actions builds Windows + macOS installers and publishes a
  GitHub Release:
  ```bash
  npm version patch          # bumps package.json + tags
  git push --follow-tags
  ```
- **Auto-update** — the packaged app checks the GitHub Releases feed on launch
  (via `electron-updater`, configured in `electron-builder.yml` → `publish`).
  When a newer version is published, a banner offers **Restart & update**.

> Note: macOS auto-update requires the app to be code-signed; CI builds are
> unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`). Add signing certs as repo
> secrets for production macOS updates. Windows NSIS updates work unsigned.

## License

MIT © 2026 MirrorCast contributors. See [LICENSE](LICENSE).

MirrorCast is an independent interoperability project and is **not** affiliated
with or endorsed by Apple Inc. "AirPlay" is a trademark of Apple Inc.
