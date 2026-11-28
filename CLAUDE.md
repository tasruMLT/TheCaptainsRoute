# Harbour Run: desktop and Android stay in step

The Android app (`android/`) is a WebView wrapper that runs the same game files as the desktop
version (`index.html`, `game.js`, `render3d.js`, `audio.js`, `style.css`, `assets/`, `vendor/`).

- **Every desktop change must reach the Android app**, unless the change is specific to one
  platform. After any game change:
  1. make the change in the shared files (never in a copy under `android/`);
  2. if it adds a control or menu action that needs a keyboard or mouse, give it a touch path too
     (touch UI turns on for `pointer: coarse` or `IS_ANDROID_APP`);
  3. rebuild the APK: `powershell -NoProfile -ExecutionPolicy Bypass -File android\build-apk.ps1`
     (output `dist\HarbourRun-<version>-debug.apk`) and say so in the reply.
- New top-level `.html/.css/.js/.json` files and anything under `assets/` or `vendor/` are copied
  into the APK automatically (`copyWebFiles` in `android/build.gradle`). A new desktop-only file
  must be added to that task's `exclude` list; a new folder must be added to its `include` list.
- **Platform-specific changes stay on their platform:** Android-only behaviour is gated by
  `IS_ANDROID_APP` (or lives in `android/`); desktop-only behaviour (e.g. the service worker,
  `serve.js`) stays out of the app.
- Bump `GAME_VERSION` in `game.js` with every change; the app's version follows it.
- Player 2 has no touch controls on purpose (Android 2-player is planned as two networked phones).

# Ropes (standing rule)

Every rope in the 3D view, existing or new (mooring and tow lines, rigging, coils, tackles,
lanyards), is textured laid rope that lies naturally. Never draw one as a plain cylinder, box,
tube or line. All the helpers are in `render3d.js`:

- Shape: `ropeGeometry` (twisted three-strand outline) with a rope material: `hempMat`,
  `tarredMat` (standing rigging), `runningMat`, or `M.cord` inside a bridge.
- Lie: `ropeCurve(a, b, { sag, kink, floor })` between two fixings, `ropeCoil` for spare rope.
  It is rarely dead straight, rests on water or stone instead of passing through it, and both
  ends are made fast to something solid, never left in mid-air or run through a hull.
- Ropes are heavy and stiff, on every vessel: a made-fast line runs straight with a shallow
  belly (no sideways wiggle, kink or swing) and moves because the ship moves. Only slight
  stirring elsewhere: `sway` (and `spans`) in the `ropeGeometry` list for ropes built into a
  model; a faint `swing` on the tow rope.
- A rope is one unbroken piece: one curve from its inboard end to its far fixing, never two
  tubes that must meet. `ropeCurve` never moves its two ends. Check close-ups at the holes.
- A line goes aboard through a hole or opening, never against bare plating: `hawseHole` on
  code-built hulls; a new modelled ship needs a mooring deck in its Blender script with the
  accommodation above it, and its leads listed in `render3d.js` (see `mooring_leads` in
  `tools/cruise_model.py` and `CRUISE_LEADS`).
- A mooring line stays outside the hull (its lead's place on the hull sees to that; check every
  ship, both ways round) and on top of the quay (`floor`). A line let go is hauled aboard in
  tangling loops (`haulCurves`, held outside the hull by `keep`), never just removed. Moored
  ships have five lines, the first a long head line (`MOORING_LINES`).
- A ship's rigging goes in with `addRigging`, which keeps it out of ray tests, the camera's
  solids and the hiding of parts around the helm.
- A rope modelled in Blender (`tools/*.py`) needs the same twist.
- Steel wire, chain, hoses and electric cables are not ropes.
