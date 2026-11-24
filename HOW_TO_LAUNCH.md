# How to Launch Harbour Run

Harbour Run is a browser game made of plain files (HTML, CSS, JavaScript).
There is no build step and nothing to install for the game itself.

It must be opened through a local web server (`http://localhost:...`), not by
double-clicking `index.html`. The game uses a service worker and local storage,
which browsers block for `file://` pages.

---

## Quick start (Windows)

1. Open File Explorer and go to `C:\Coding\HarbourRun`.
2. Double-click **`start.bat`**.
3. A browser tab opens at **http://localhost:8080/index.html**.
4. To stop the game, go back to the console window and press **Enter**.

If you prefer a terminal:

```powershell
cd C:\Coding\HarbourRun
.\start.ps1
```

If PowerShell refuses to run the script, use `start.bat` instead, or run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

---

## Step by step (manual, no script)

### Step 1: Check you have a local server

Use one of these:

| Option | Check | Install if missing |
|---|---|---|
| Python 3 (recommended) | `python --version` | https://www.python.org/downloads/ (tick "Add python.exe to PATH") |
| Node.js | `node --version` | https://nodejs.org/ |
| VS Code + Live Server extension | Extensions panel | Install "Live Server" by Ritwick Dey |

### Step 2: Open a terminal in the project folder

In File Explorer, open `C:\Coding\HarbourRun`, click the address bar, type
`powershell`, and press Enter.

### Step 3: Start the server

**With Python:**

```powershell
python -m http.server 8080 --bind 127.0.0.1
```

**With Node.js:**

```powershell
node serve.js 8080
```

Leave this window open. The server must keep running while you play.

### Step 4: Open the game in your browser

Go to:

```
http://localhost:8080/index.html
```

Chrome or Edge work best. You should see the "Harbour Run" title and the canvas.

### Step 5: Play

| Key | Action |
|---|---|
| `1` | Single player vs computer |
| `2` | Local 2-player |
| `K` | Settings (gameplay and key bindings) |
| Player 1 | Move `W A S D`, attack `Space` |
| Player 2 | Move arrow keys, attack `Right Shift` |
| Shop | `Enter` to buy, `Backspace` to sell, `Tab` to switch player |
| `C` (while sailing) | Switch camera: overview / chase (chase is single player only) |

### Step 6: Stop the server

Click the server window and press `Ctrl + C`, then type `Y` if asked.

---

## Debug in VS Code (optional)

The project includes a launch configuration:

1. Open `C:\Coding\HarbourRun` in VS Code (or open `workspace.code-workspace`).
2. Start the server first (Step 3 above, or `start.bat`). The debug launch
   expects it on port 8080.
3. Open the **Run and Debug** panel (`Ctrl + Shift + D`).
4. Choose **Launch Chrome against localhost** and press `F5`.

Breakpoints in `game.js` will work in Chrome.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Page is blank or says the site can't be reached | The server is not running. Start it again (Step 3). |
| `Address already in use` / "port 8080 is taken" | Another program uses 8080. Use another port, e.g. `.\start.ps1 -Port 9000`, or `python -m http.server 9000 --bind 127.0.0.1`, then open `http://localhost:9000/index.html`. |
| `python` is not recognised | Install Python (tick "Add to PATH") or use Node.js. In Windows you can also try `py -m http.server 8080`. |
| `start.ps1` says "running scripts is disabled" | Use `start.bat`, or run the `powershell -ExecutionPolicy Bypass` command shown above. |
| Changes to `game.js` don't show up | Hard refresh with `Ctrl + F5`. The service worker caches files. If it still persists, open DevTools (`F12`) > Application > Service Workers > **Unregister**, then reload. |
| Game looks old after an update | Same as above: hard refresh, or clear site data for `localhost:8080`. |
| Keys do nothing | Click the game canvas once so it has keyboard focus. |
| Game shows flat 2D circles instead of 3D | The browser has WebGL turned off or unsupported. Use an up-to-date Chrome or Edge and check that hardware acceleration is on (Settings > System). The game still plays in 2D. |
| Settings or profiles disappear | Saved data lives in browser local storage for `localhost:8080`. Using a different port or browser means a fresh start. |

---

## Files you'll see

| File | Purpose |
|---|---|
| `start.bat` | Double-click launcher for Windows |
| `start.ps1` | Starts the local server and opens the browser |
| `serve.js` | Small Node.js server, used when Python isn't installed |
| `index.html` | Page and on-screen controls help |
| `game.js` | All game logic, plus the HUD, menus and on-screen labels (2D layer) |
| `render3d.js` | The 3D world view (sea, sky, ships, hazards) drawn with Three.js |
| `vendor/three/` | Three.js library and add-ons (MIT licence), kept locally so the game works offline |
| `style.css` | Page layout and styling |
| `service-worker.js` | Offline caching (network first) |
| `manifest.json` | Install-as-app settings |
| `assets/` | Icons |
| `.vscode/launch.json` | Chrome debug configuration |

---

## Android (phone or tablet)

The `android/` folder wraps the same game files in an Android app. On a touch
screen the game fills the screen and shows on-screen controls: a stick (left)
to steer, Fire, and buttons for Camera, Anchor, Repair, Water (put out a
fire), Tow and Horn. Pause is top left. Camera switches between the top view,
chase and bridge views. Pinch with two fingers to zoom the top and chase
views (like the mouse wheel). On the bridge, drag a finger across the sea to
look around (like the right mouse button); tap the sea to look ahead again. The phone's Back button works like
Esc, and on the main menu it closes the app. A Bluetooth keyboard works as on
the desktop, including local 2 player.

**Graphics (phones and PCs):** the first time the game starts on a device it
checks the graphics while the loading screen shows "Checking your graphics...
first start only" (up to about 20 seconds on a phone), then saves the best
quality level that runs smoothly. Later starts use the saved level at once. It
is checked again only if the graphics chip or the screen size changes. The
quality never changes while you play. On a very weak phone, Settings >
Graphics can switch to the 2D view.

**Build the APK** (needs Android Studio's SDK, already set up on this PC):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File android\build-apk.ps1
```

The APK is written to `dist\HarbourRun-<version>-debug.apk`. Its version comes
from `GAME_VERSION` in `game.js`. Rebuild after every game change: the app
carries its own copy of the files.

**Install on a phone:** copy the APK to the phone and open it (allow
"install unknown apps" for your file manager when asked), or with USB
debugging on: `adb install -r dist\HarbourRun-<version>-debug.apk`.

This is a debug-signed test build. Publishing on Google Play needs a release
build signed with your own key. Microsoft Store purchases are not available
in the Android app; the premium packs show as unavailable.
