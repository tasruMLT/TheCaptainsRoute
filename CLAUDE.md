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
