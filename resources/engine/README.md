# Bundled engine (optional)

MirrorCast drives an external **FairPlay-capable AirPlay receiver engine**
(UxPlay / RPiPlay) as a separate process to decode the mirror stream. It does
**not** bundle one by default - MirrorCast is MIT, those engines are GPLv3, and
keeping the engine a separately-installed process avoids relicensing.

If you want a self-contained build, drop an engine binary here:

```
resources/engine/uxplay          (macOS/Linux)
resources/engine/uxplay.exe       (Windows)
```

`electron-builder` copies this folder to the app's `resources/engine/` and
`EngineController.locate()` finds it automatically. Because the engine runs as
an independent process (mere aggregation, no linking), your MIT app source is
unaffected - but **redistributing a GPLv3 binary makes that combined download
subject to GPLv3**, so ship the engine's source/offer accordingly.

The engine must stream decrypted **H.264 (Annex-B)** to `tcp://127.0.0.1:9001`
for video to appear in the MirrorCast window. See the top-level README section
**"Wiring an engine"** for the exact UxPlay `-vs` sink recipe.
