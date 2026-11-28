// Shown in the Settings menu. Bump it with each release so players (and
// bug reports) can tell which build is running.
const GAME_VERSION = "2.134.2";

const canvas = document.getElementById("gameCanvas");
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("Harbour Run init failed: #gameCanvas element not found.");
}
const ctx = canvas.getContext("2d");
if (!ctx) {
  throw new Error("Harbour Run init failed: 2D canvas context is unavailable.");
}

// The Android app (android/) adds this to the WebView's user agent.
const IS_ANDROID_APP = navigator.userAgent.includes("HarbourRunAndroid");
// Phones and tablets get full-screen play and on-screen controls.
const TOUCH_UI = IS_ANDROID_APP || matchMedia("(pointer: coarse)").matches;
document.body.classList.toggle("touch-ui", TOUCH_UI);

const WIDTH = canvas.width;
const HEIGHT = canvas.height;

// The sea is bigger than the screen: cameras follow the ships around it.
// WIDTH/HEIGHT stay the screen (HUD and menu layout); WORLD_W/WORLD_H are the sea.
// The sea: 3 screens wide and 3 high, so there is plenty of open water to
// manoeuvre in.
const WORLD_SCALE = 3;
const WORLD_W = WIDTH * WORLD_SCALE;
const WORLD_H = HEIGHT * WORLD_SCALE;

// The 3D world view. render3d.js fills this in and sets active once WebGL is
// running; until then (or if 3D can't start) the classic 2D drawing is used.
// Either way this canvas still draws the HUD, menus and on-screen labels.
const view3d = { shipTop: () => 40, active: false, split: false, available: false, render: null, project: null, setGraphicsMode: null, gpu: "", advancedCapable: false, quality: "" };
const CAMERA_VIEWS = ["overview", "chase", "bridge"];
const CAMERA_VIEW_NAMES = { overview: "Overview", chase: "Chase", bridge: "Bridge" };
const GRAPHICS_MODES = ["auto", "advanced", "2d"];

// Where a world point lands on this canvas. In 3D, `lift` raises the point
// above the sea first (e.g. so a name sits over the mast, not the hull), and
// `slot` picks that player's half of a split screen.
function worldToScreen(x, y, lift = 0, slot) {
  if (view3d.active) return view3d.project(x, y, lift, slot);
  return { x: (x - view2d.x) * view2d.scale + WIDTH / 2, y: (y - view2d.y) * view2d.scale + HEIGHT / 2, visible: true };
}

// Boxes already taken on this frame's 2D layer: labels move clear of them.
let labelBoxes = [];

// Where a w x h label wanted centred on `cx` with its top at `top` goes: wholly
// on screen (in split screen: inside the half it belongs to) and clear of the
// HUD panels and of the labels placed before it. The 3D view is wider than this
// layer on wide screens, so an unclamped label would be sliced off at its edge.
function placeLabel(cx, top, w, h) {
  const split = view3d.active && view3d.split;
  const minX = split && cx >= WIDTH / 2 ? WIDTH / 2 + 6 : 6;
  const maxX = (split && cx < WIDTH / 2 ? WIDTH / 2 : WIDTH) - 6 - w;
  const x = clamp(cx - w / 2, minX, Math.max(minX, maxX));
  let at = x;
  let y = clamp(top, 6, HEIGHT - h - 6);
  for (let i = 0; i < 8; i += 1) {
    const hit = labelBoxes.find((b) => at < b.x + b.w && at + w > b.x && y < b.y + b.h && y + h > b.y);
    if (!hit) break;
    // out of its way, towards the middle of the screen: beside something
    // tall (a column of touch buttons), above or below anything else
    if (hit.h > hit.w) at = hit.x + hit.w / 2 < WIDTH / 2 ? hit.x + hit.w + 3 : hit.x - w - 3;
    else y = hit.y + hit.h / 2 < HEIGHT / 2 ? hit.y + hit.h + 3 : hit.y - h - 3;
  }
  const box = { x: at, y: clamp(y, 6, HEIGHT - h - 6), w, h };
  labelBoxes.push(box);
  return box;
}

// The HUD panels that labels keep out of while sailing.
function reserveHudBoxes() {
  labelBoxes = [];
  if (gameState !== "playing" && gameState !== "arrival") return;
  labelBoxes.push({ x: 8, y: 8, w: mode === "local" ? 496 : 370, h: 56 });
  // Labels keep clear of the small map; an enlarged one simply lies over the view.
  if (mapStep === 0) labelBoxes.push({ x: WIDTH - 232, y: HEIGHT - 140, w: 232, h: 140 });
  labelBoxes.push({ x: WIDTH - 146, y: HEIGHT - 207, w: 146, h: 65 }); // the map's buttons
  if (view3d.active && view3d.split) labelBoxes.push({ x: WIDTH / 2 - 180, y: 8, w: 360, h: 30 });
  if (game.mission) labelBoxes.push(missionPanelRect());
  if (TOUCH_UI) reserveTouchControls();
}

// The on-screen stick and buttons lie over this layer: labels avoid them too.
const TOUCH_COVERS = document.querySelectorAll(".tc-stick, .tc-side, .tc-fire, .tc-play .tc-corner");
function reserveTouchControls() {
  const rect = canvas.getBoundingClientRect();
  const k = Math.min(rect.width / WIDTH, rect.height / HEIGHT);
  const left = rect.left + (rect.width - WIDTH * k) / 2;
  const top = rect.top + (rect.height - HEIGHT * k) / 2;
  for (const control of TOUCH_COVERS) {
    const r = control.getBoundingClientRect();
    if (r.width) labelBoxes.push({ x: (r.left - left) / k, y: (r.top - top) / k, w: r.width / k, h: r.height / k });
  }
}

// What the cameras look at: your ship in single player; the middle of both
// ships in 2-player, with `spanX/spanY` telling how far apart they are so the
// camera can pull back to keep both in view. Menus look at the whole sea.
function cameraFocus() {
  const inWorld = gameState === "playing" || gameState === "arrival" || gameState === "ended";
  const p1 = game.player1;
  if (!inWorld || !p1) return { x: WORLD_W / 2, y: WORLD_H / 2, spanX: 0, spanY: 0, inWorld: false };
  const p2 = mode === "local" ? game.player2 : null;
  if (p2 && p1.capsized && !p2.capsized) return { x: p2.x, y: p2.y, spanX: 0, spanY: 0, inWorld: true };
  if (!p2 || (p2.capsized && !p1.capsized)) return { x: p1.x, y: p1.y, spanX: 0, spanY: 0, inWorld: true };
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, spanX: Math.abs(p1.x - p2.x), spanY: Math.abs(p1.y - p2.y), inWorld: true };
}

// Classic 2D view (no WebGL): scrolls with the focus, zooms out for 2-player.
const view2d = { x: WIDTH / 2, y: HEIGHT / 2, scale: 1 };

function updateView2d() {
  const moored = game.harbourShip;
  const f = moored ? { x: moored.x, y: moored.y, spanX: 0, spanY: 0, inWorld: true } : cameraFocus();
  let scale = Math.min(1, WIDTH / (f.spanX + 500), HEIGHT / (f.spanY + 360));
  if (!f.inWorld) scale = Math.min(WIDTH / WORLD_W, HEIGHT / WORLD_H);
  const halfW = WIDTH / (2 * scale);
  const halfH = HEIGHT / (2 * scale);
  const tx = halfW * 2 >= WORLD_W ? WORLD_W / 2 : clamp(f.x, halfW, WORLD_W - halfW);
  const ty = halfH * 2 >= WORLD_H ? WORLD_H / 2 : clamp(f.y, halfH, WORLD_H - halfH);
  view2d.x += (tx - view2d.x) * 0.15;
  view2d.y += (ty - view2d.y) * 0.15;
  view2d.scale += (scale - view2d.scale) * 0.15;
}

function applyWorldTransform2d() {
  const k = view2d.scale;
  ctx.setTransform(k, 0, 0, k, WIDTH / 2 - view2d.x * k, HEIGHT / 2 - view2d.y * k);
}

const keys = new Set();
let mode = "single";
let gameState = "menu";
let resultText = "";
let lastTime = performance.now();

// Each harbour fills a corner of the map with land: quays along both map
// edges, and a rock breakwater (mole) on each side enclosing the basin, its
// entrance facing the open sea. x, y is the middle of the basin and r the
// berthing area there (dock inside it); `clear` keeps hazards off the land.
// corner/sa/sb place the harbour's own frame (a, b): the corner is (0, 0), a
// runs along the top/bottom map edge and b along the side edge, both away
// from the corner, so both harbours share one layout.
// The basin is BASIN square (quay faces at 22): room for two large ships, one
// berthed along each quay, and to turn them. r is the circle that stands for
// the basin in the 2D view and for keeping hazards clear.
const BASIN = 340;
const MOLE_END = 190; // the breakwaters run out to here: the entrance is the gap between their tips
const HarbourA = { x: 180, y: WORLD_H - 180, r: 130, clear: 400, name: "Harbour A", corner: { x: 0, y: WORLD_H }, sa: 1, sb: -1 };
const HarbourB = { x: WORLD_W - 180, y: 180, r: 130, clear: 400, name: "Harbour B", corner: { x: WORLD_W, y: 0 }, sa: -1, sb: 1 };

// The land, as capsules (a line from (a1, b1) to (a2, b2) widened by r) in
// the harbour's own frame: the same shape the hull bump test uses, so a hull
// meets the quay exactly where it is drawn. kind: coast (land, its quay face
// at 22 from the map edge), mole (breakwater), moored (boats tied up at the
// berths, solid too).
// Past the quays the land is ragged, not a round end: a ring of headlands of
// different sizes and reach (and a few outlying rocks) round the end of the
// first quay's land. The second quay's are the same, mirrored. Fixed pseudo
// random numbers, so both harbours and every run look the same.
const COAST_R = 100; // the land behind each quay is a strip this wide...
const COAST_END = BASIN + 22; // ...straight to here along the quay
const COAST_TAIL = (() => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const lumps = [];
  const lump = (deg, reach, size) => {
    const ph = (deg * Math.PI) / 180;
    const a = -COAST_R + 22 + Math.cos(ph) * reach;
    const b = COAST_END + Math.sin(ph) * reach;
    const r = Math.min(size, b - (BASIN + 12)); // never into the basin
    if (r >= 6) lumps.push([a, b, a + 3, b + 2, r]);
  };
  for (let deg = 8; deg <= 135; deg += 8) lump(deg, COAST_R - 8 + rnd() * 46, 14 + rnd() * 24);
  for (let deg = 12; deg <= 125; deg += 15) lump(deg, COAST_R + 34 + rnd() * 44, 8 + rnd() * 12);
  // The far side of the land (beyond the map edge, still seen from the sea)
  // is just as ragged, with bays between the headlands.
  for (let b = -150; b <= COAST_END; b += 22 + rnd() * 18) {
    const a = 22 - 2 * COAST_R - 14 + rnd() * 34;
    const r = 20 + rnd() * 28;
    lumps.push([a, b, a + 2, b + 3, r]);
  }
  return lumps;
})();
const HARBOUR_LAYOUT = [
  { kind: "coast", a1: 22 - COAST_R, b1: 22 - COAST_R, a2: 22 - COAST_R, b2: COAST_END, r: COAST_R },
  { kind: "coast", a1: 22 - COAST_R, b1: 22 - COAST_R, a2: COAST_END, b2: 22 - COAST_R, r: COAST_R },
  ...COAST_TAIL.flatMap(([a1, b1, a2, b2, r]) => [
    { kind: "coast", a1, b1, a2, b2, r },
    { kind: "coast", a1: b1, b1: a1, a2: b2, b2: a2, r }
  ]),
  { kind: "mole", a1: BASIN, b1: 22, a2: BASIN, b2: MOLE_END, r: 7 },
  { kind: "mole", a1: 22, b1: BASIN, a2: MOLE_END, b2: BASIN, r: 7 },
  // Real size (1 unit is about 3 m): two 15 m motor yachts and a 40 m coaster,
  // tied up at the far ends of the quays, clear of the two large berths.
  { kind: "moored", a1: 24.5, b1: 305.3, a2: 24.5, b2: 308.7, r: 0.75 },
  { kind: "moored", a1: 24.5, b1: 323.3, a2: 24.5, b2: 326.7, r: 0.75 },
  { kind: "moored", a1: 313.75, b1: 24.9, a2: 324.25, b2: 24.9, r: 1.3 }
];

function harbourPoint(h, a, b) {
  return { x: h.corner.x + h.sa * a, y: h.corner.y + h.sb * b };
}

// Every land piece of both harbours in map coordinates: { ax, ay, bx, by, r, kind }.
const HARBOUR_LAND = [HarbourA, HarbourB].flatMap((h) =>
  HARBOUR_LAYOUT.map((p) => {
    const s = harbourPoint(h, p.a1, p.b1);
    const e = harbourPoint(h, p.a2, p.b2);
    return { ax: s.x, ay: s.y, bx: e.x, by: e.y, r: p.r, kind: p.kind, harbour: h };
  })
);

// Harbour B is never given away: no name label, map or chart mark, course or
// bearing until a captain is near enough to see it.
const HARBOUR_SIGHT = 800; // units (about 2.4 km)

function harbourBInSight(ship) {
  return !!ship && !ship.capsized && dist(ship, HarbourB) < HARBOUR_SIGHT;
}

function harbourBSighted() {
  return humanShips().some(harbourBInSight);
}

// How far a point is from the nearest harbour land (negative = on land).
function landClearance(x, y) {
  let best = Infinity;
  for (const p of HARBOUR_LAND) {
    const dx = p.bx - p.ax;
    const dy = p.by - p.ay;
    const k = clamp(((x - p.ax) * dx + (y - p.ay) * dy) / (dx * dx + dy * dy), 0, 1);
    best = Math.min(best, Math.hypot(x - (p.ax + dx * k), y - (p.ay + dy * k)) - p.r);
  }
  return best;
}

// Both start empty and are filled by buildHazards(): at random for Free Play,
// or from the mission's own map (missions.js).
const hazards = [];
const dynamicDangers = [];

// Threats (raiders, sea creatures, submarines, the water spout, the tsunami)
// arrive one at a time: each new one waits until THREAT_GAP seconds after the
// last, and every voyage opens with a calm spell.
const THREAT_GAP = 5;
const BIG_EVENT_GAP = 9;
const OPENING_CALM_TIME = 8;
const TSUNAMI_GAP = [39, 61]; // s of calm before a tsunami
const WHIRLPOOL_GAP = [31, 54]; // s of calm before a whirlpool

function threatSlotOpen() {
  return game.elapsed >= (game.nextThreatAllowedAt || 0);
}

function claimThreatSlot(gap = THREAT_GAP) {
  game.nextThreatAllowedAt = game.elapsed + gap;
}

function randomInterval(range) {
  return range[0] + Math.random() * (range[1] - range[0]);
}

// A single water spout that drifts in from off-screen, crosses the play
// area, and drifts back out the far side rather than popping in/out in
// place. Only one is ever active at a time, and it appears at random
// intervals rather than on a fixed cycle.
const waterSpout = {
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  r: 46,
  state: "dormant", // "dormant" | "forming" | "warning" | "active"
  timer: 4 + Math.random() * 6,
  kind: "fair", // "fair" (light wind, thin) | "strong" (under a thunderstorm)
  parent: null, // the storm cell a strong one hangs from
  cell: null, // the drifting cumulus of a fair-weather one
  off: { x: 0, y: 0 },
  life: 0,
  lifeMax: 40,
  formTotal: 8
};

const WATER_SPOUT_WARN_TIME = 1.5;
// A water spout hangs from a cloud: first a dark cloud builds over open sea
// (harmless, drifting slowly), then the funnel reaches down out of it.
const WATER_SPOUT_FORM_TIME = 6;
const WATER_SPOUT_FORM_DRIFT = 0.3; // share of its speed the cloud drifts at while forming
const WATER_SPOUT_CLEAR = 420; // a spout cloud forms at least this far from the players

// A tempest: a spell of bad weather over the whole sea. In this order: the cloud thickens until it covers
// everything, heavy rain sets in, the wind rises, then thunder and lightning rage; after a while it eases and
// slowly moves out, and fine weather returns for a long spell. `intensity` (0..1) drives the thick sky cover
// (render3d.js), the rain, the wind, the sea and the lightning; strong waterspouts only come with a tempest
// or a storm cell. Individual storm cells (dynamicDangers) still blow across as before.
const TEMPEST_BUILD = 35; // s for the sky to close in
const TEMPEST_HOLD = [50, 95]; // s at full strength
const TEMPEST_CLEAR = 80; // s to ease off and move out
const TEMPEST_GAP = [110, 260]; // s of fine weather before the next
const tempest = { state: "clear", intensity: 0, t: 0, hold: 70, timer: 80 + Math.random() * 80, nextBoltAt: 0, boltAt: -99, boltX: 0, boltY: 0 };

function resetTempest() {
  tempest.state = "clear";
  tempest.intensity = 0;
  tempest.timer = 70 + Math.random() * 90;
}

function updateTempestWeather(dt) {
  if (!weatherAllowed("tempest")) return;
  if (tempest.state === "clear") {
    tempest.intensity = 0;
    tempest.timer -= dt;
    if (tempest.timer <= 0) {
      if (tsunami.state !== "dormant" || game.elapsed < 30) {
        tempest.timer = 3;
      } else {
        tempest.state = "building";
        tempest.t = 0;
        tempest.hold = randomInterval(TEMPEST_HOLD);
        setUiMessage("A tempest is building: the sky is closing in");
      }
    }
    return;
  }
  tempest.t += dt;
  if (tempest.state === "building") {
    tempest.intensity = smooth01(tempest.t / TEMPEST_BUILD);
    if (tempest.t >= TEMPEST_BUILD) {
      tempest.state = "raging";
      tempest.t = 0;
    }
  } else if (tempest.state === "raging") {
    tempest.intensity = 1;
    if (tempest.t >= tempest.hold) {
      tempest.state = "clearing";
      tempest.t = 0;
    }
  } else {
    tempest.intensity = 1 - smooth01(tempest.t / TEMPEST_CLEAR);
    if (tempest.t >= TEMPEST_CLEAR) {
      tempest.state = "clear";
      tempest.intensity = 0;
      tempest.timer = randomInterval(TEMPEST_GAP);
    }
  }
}

// Real waterspouts hang from the base of a big, towering cloud. Two kinds are made here:
//  - fair-weather: from a growing cumulus in light wind and no rain; a thin, weaker spout that lasts a while;
//  - strong (tornadic): under a thunderstorm cell (wind, rain, lightning); wider, darker and far more dangerous.
// Neither forms without its cloud: a fair-weather spout builds its own cumulus overhead (seen growing first);
// a strong one rides the storm cell it hangs from, and ends when the storm passes or after its life.
const WATER_SPOUT_LIFE = { fair: 38, strong: 50 };
const WATER_SPOUT_SIZE = { fair: 24, strong: 54 }; // radius of the danger zone
const WATER_SPOUT_DAMAGE = { fair: 22, strong: 75 }; // hull per second inside it
const WATER_SPOUT_FORM = { fair: 10, strong: 5 }; // s for the cloud to build before the funnel drops
const FAIR_SPOUT_MAX_WIND = 14; // knots: fair-weather spouts need a light wind

function windKnots() {
  return Math.hypot(game.wind.x, game.wind.y) * WIND_KNOTS_PER_UNIT;
}

function stormsInPlay() {
  return dynamicDangers.filter((dz) => dz.kind === "storm" && dz.arriveIn <= 0 && dz.x > 60 && dz.x < WORLD_W - 60 && dz.y > 60 && dz.y < WORLD_H - 60 && dz.rain > 0.3);
}

function launchWaterSpout(kind, storm) {
  const sp = waterSpout;
  sp.kind = kind;
  sp.r = WATER_SPOUT_SIZE[kind];
  sp.life = 0;
  sp.lifeMax = WATER_SPOUT_LIFE[kind] * (0.8 + Math.random() * 0.4);
  sp.formTotal = WATER_SPOUT_FORM[kind];
  if (kind === "strong" && storm) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.sqrt(Math.random()) * storm.r * 0.55;
    sp.parent = storm;
    sp.cell = null;
    sp.off = { x: Math.cos(a) * d, y: Math.sin(a) * d };
    sp.x = storm.x + sp.off.x;
    sp.y = storm.y + sp.off.y;
    sp.vx = storm.vx || 0;
    sp.vy = storm.vy || 0;
    return;
  }
  // a fair-weather spout (its own cumulus), or a strong one in a tempest (under the thick sky): over open sea,
  // clear of the ships, drifting with the wind
  let best = null;
  let bestGap = -1;
  for (let i = 0; i < 20; i++) {
    const x = 150 + Math.random() * (WORLD_W - 300);
    const y = 150 + Math.random() * (WORLD_H - 300);
    let gap = Infinity;
    for (const ship of humanShips()) gap = Math.min(gap, Math.hypot(ship.x - x, ship.y - y));
    if (gap > bestGap) {
      best = { x, y };
      bestGap = gap;
    }
    if (gap >= WATER_SPOUT_CLEAR) break;
  }
  const w = Math.hypot(game.wind.x, game.wind.y) || 1;
  sp.parent = null;
  sp.off = { x: 0, y: 0 };
  const drift = kind === "strong" ? 30 : 14;
  sp.cell = { x: best.x, y: best.y, vx: (game.wind.x / w) * drift, vy: (game.wind.y / w) * drift };
  sp.x = best.x;
  sp.y = best.y;
  sp.vx = sp.cell.vx;
  sp.vy = sp.cell.vy;
}

function endWaterSpout() {
  waterSpout.state = "dormant";
  waterSpout.parent = null;
  waterSpout.cell = null;
  waterSpout.timer = randomInterval(voyageThreats().spoutDormant);
}

function updateWaterSpout(dt) {
  if (!weatherAllowed("spout")) return;
  if (waterSpout.state === "dormant") {
    waterSpout.timer -= dt;
    if (waterSpout.timer <= 0) {
      const storms = stormsInPlay();
      const kinds = [];
      if (storms.length || tempest.intensity > 0.65) kinds.push("strong");
      if (windKnots() < FAIR_SPOUT_MAX_WIND && storms.length === 0) kinds.push("fair");
      if (!threatSlotOpen() || tsunami.state !== "dormant" || kinds.length === 0) {
        waterSpout.timer = 1; // no cloud to hang from: no waterspout
        return;
      }
      claimThreatSlot(BIG_EVENT_GAP);
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      launchWaterSpout(kind, kind === "strong" && storms.length ? storms[Math.floor(Math.random() * storms.length)] : null);
      waterSpout.state = "forming";
      waterSpout.timer = waterSpout.formTotal;
    }
    return;
  }

  // It rides with its cloud; if that has gone the funnel dissipates.
  waterSpout.life += dt;
  const storm = waterSpout.parent;
  if (waterSpout.kind === "strong" && storm) {
    if (!storm || storm.arriveIn > 0 || storm.x < -storm.r || storm.x > WORLD_W + storm.r || storm.y < -storm.r || storm.y > WORLD_H + storm.r) {
      endWaterSpout();
      return;
    }
    waterSpout.x = storm.x + waterSpout.off.x;
    waterSpout.y = storm.y + waterSpout.off.y;
    waterSpout.vx = storm.vx || 0;
    waterSpout.vy = storm.vy || 0;
  } else {
    const c = waterSpout.cell;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    waterSpout.x = c.x;
    waterSpout.y = c.y;
    // a tempest breaking up (strong spout), or a strong wind (fair-weather spout), ends it
    const gone = waterSpout.kind === "strong" ? tempest.intensity < 0.4 : windKnots() > FAIR_SPOUT_MAX_WIND * 1.6;
    if (gone || c.x < -60 || c.x > WORLD_W + 60 || c.y < -60 || c.y > WORLD_H + 60) {
      endWaterSpout();
      return;
    }
  }
  if (waterSpout.life > waterSpout.lifeMax) {
    endWaterSpout();
    return;
  }

  if (waterSpout.state === "forming") {
    waterSpout.timer -= dt;
    if (waterSpout.timer <= 0) {
      waterSpout.state = "warning";
      waterSpout.timer = WATER_SPOUT_WARN_TIME;
    }
    return;
  }

  if (waterSpout.state === "warning") {
    waterSpout.timer -= dt;
    if (waterSpout.timer <= 0) waterSpout.state = "active";
  }
}

// A tsunami: a straight wave front that sweeps the whole screen from one edge
// to the opposite one, from time to time. Positions along its travel
// direction are measured as s = x*dirX + y*dirY; the front sits at `front`.
// A ship the front passes over rides it if its bow or stern points into the
// wave, and capsizes if it is caught side-on.
const tsunami = {
  dirX: 1,
  dirY: 0,
  front: 0,
  endAt: 0,
  speed: 0,
  state: "dormant", // "dormant" | "warning" | "active"
  timer: 45,
  passed: new WeakSet()
};

// How rough the open sea is: 0 = flat calm, 1 = full storm. The 3D sea's
// waves (and the ships riding them) scale with it. It follows the weather
// (updateSeaState): the wind raises the sea, a storm cell raises big seas.
// swell: how high the waves run right now (x the usual height for this
// roughness). It wanders at random, so sets of small, big and bigger seas come
// and go, and it climbs well above that while a storm passes.
const sea = { roughness: 0.12, swell: 1, sets: 1, setsTarget: 1, setTimer: 0 };
const WIND_BASE = [12, 30]; // the round's wind strength is picked in this range (units)
const WIND_VEER = 0.14; // the most the wind swings off its direction (radians, ~8 degrees)
const SEA_SWELL_FLOOR = 0.04; // some long swell is always running, even in a calm
const SEA_STORM_KNOTS = 32; // wind that raises a full storm sea: a gale (the sea gets big quickly as the wind rises)
const SEA_CALM_TIME = 40; // seconds for a big sea to die down once the wind has dropped (it builds faster than it calms)
const WIND_SWELL_MAX = 0.9; // a gale raises the swell height by up to this much more
const STORM_SEA = 1; // roughness in a storm cell
const STORM_SEA_REACH = 380; // how far past a storm's edge its seas still run
const SEA_BUILD_TIME = 6; // seconds for the sea to catch up with the weather
const SEA_SETS = [0.45, 1.7]; // random swell range, smallest to biggest
const SEA_SET_TIME = [6, 22]; // seconds before the swell turns towards a new size
const STORM_SWELL_BOOST = 0.9; // a passing storm raises the swell by up to 90% more
// Waves shoving ships about in a heavy sea. The main swell runs this way
// (the 3D sea's biggest wave), at this wavelength.
const SEA_WAVE_DIR = 0.3;
const SEA_WAVE_LEN = 260;
const SEA_PUSH_YAW = 0.55; // rad/s the sea can swing the heading at its worst
const SEA_PUSH_DRIFT = 46; // units/s the sea can shove the hull along
const SEA_PUSH_DRAG = 0.35; // share of speed a head sea takes per second

const TSUNAMI_WARN_TIME = 3;
const TSUNAMI_SAFE_ANGLE = (35 * Math.PI) / 180;
const TSUNAMI_BAND = 170;

// The tsunami rolls over land (a wall of water is drawn over it, render3d.js) and strikes whatever is in its path.
// But the sea draws back a little ahead of the wave only where the wave comes in over open water: sea with an
// island, volcano or harbour coast upstream of it (towards where the wave comes from) is in the land's lee and
// shows no such draw-back before the wave arrives. The land is a list of circles (the 3D sea uses the same).
const LEE_MAX = 40; // kept small: the sea shader holds these as uniforms (phones have few)
const LEE_STEP = 100;
let leeCache = { key: "", circles: [] };
function tsunamiLandCircles() {
  const key = hazards.length + ":" + (hazards.length ? hazards[0].x : 0);
  if (leeCache.key === key) return leeCache.circles;
  const list = [];
  // each harbour's land: the coast strip behind each quay, as a row of circles
  for (const h of [HarbourA, HarbourB]) {
    for (const [a1, b1, a2, b2] of [[22 - COAST_R, 22 - COAST_R, 22 - COAST_R, COAST_END], [22 - COAST_R, 22 - COAST_R, COAST_END, 22 - COAST_R]]) {
      const n = Math.ceil(Math.hypot(a2 - a1, b2 - b1) / LEE_STEP);
      for (let i = 0; i <= n; i += 1) {
        const p = harbourPoint(h, a1 + ((a2 - a1) * i) / n, b1 + ((b2 - b1) * i) / n);
        list.push({ x: p.x, y: p.y, r: COAST_R });
      }
    }
  }
  for (const hz of hazards) if (hz.kind !== "iceberg") list.push({ x: hz.x, y: hz.y, r: hz.r });
  leeCache = { key, circles: list.slice(0, LEE_MAX) };
  return leeCache.circles;
}

// 1 = open sea (the draw-back shows), 0 = in the lee of land (no draw-back).
function tsunamiLee(x, y) {
  if (tsunami.state === "dormant") return 1;
  const sstep = (a, b, v) => {
    const t = clamp((v - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  let lee = 1;
  for (const c of tsunamiLandCircles()) {
    const vx = c.x - x;
    const vy = c.y - y;
    const t = -(vx * tsunami.dirX + vy * tsunami.dirY); // how far upstream the land is
    if (t <= 0) continue;
    const across = Math.abs(vx * tsunami.dirY - vy * tsunami.dirX);
    const shade = (1 - sstep(c.r * 0.75, c.r * 1.15, across)) * (1 - sstep(700, 1600, t));
    lee *= 1 - shade;
  }
  return lee;
}

// A new voyage or crossing starts with the sea as the wind makes it: no swell,
// rough water or tsunami wave left over from the one before (the 3D sea
// keeps its own fading copy, cleared by view3d.resetSea).
function resetSea() {
  sea.roughness = clamp(windSea(), 0, 1) * (game.mission ? game.mission.calm : 1);
  sea.swell = game.mission ? game.mission.calm : 1;
  sea.sets = 1;
  sea.setsTarget = 1;
  sea.setTimer = 0;
  if (view3d.resetSea) view3d.resetSea();
}

function resetTsunami() {
  tsunami.state = "dormant";
  tsunami.timer = randomInterval(TSUNAMI_GAP);
}

function launchTsunami() {
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const [dirX, dirY] = dirs[Math.floor(Math.random() * dirs.length)];
  const corners = [0, WORLD_W * dirX, WORLD_H * dirY, WORLD_W * dirX + WORLD_H * dirY];
  tsunami.dirX = dirX;
  tsunami.dirY = dirY;
  tsunami.front = Math.min(...corners) - 30;
  tsunami.endAt = Math.max(...corners) + TSUNAMI_BAND + 30;
  tsunami.speed = 170 + Math.random() * 40;
  tsunami.passed = new WeakSet();
  playAlertTone(180, 0.35, 0.05, "sawtooth");
  window.setTimeout(() => playAlertTone(140, 0.45, 0.05, "sawtooth"), 380);
}

// True when the ship's bow or stern lines up with the wave's travel direction.
function shipFacesTsunami(ship) {
  const along = Math.abs(Math.cos(ship.angle) * tsunami.dirX + Math.sin(ship.angle) * tsunami.dirY);
  return along >= Math.cos(TSUNAMI_SAFE_ANGLE);
}

function updateTsunami(dt) {
  if (!weatherAllowed("tsunami")) return;
  if (tsunami.state === "dormant") {
    tsunami.timer -= dt;
    if (tsunami.timer <= 0) {
      if (!threatSlotOpen() || waterSpout.state !== "dormant") {
        tsunami.timer = 1;
        return;
      }
      claimThreatSlot(BIG_EVENT_GAP);
      launchTsunami();
      tsunami.state = "warning";
      tsunami.timer = TSUNAMI_WARN_TIME;
    }
    return;
  }

  if (tsunami.state === "warning") {
    tsunami.timer -= dt;
    if (tsunami.timer <= 0) tsunami.state = "active";
    return;
  }

  tsunami.front += tsunami.speed * dt;

  for (const ship of allCombatShips()) {
    if (tsunami.passed.has(ship)) continue;
    const s = ship.x * tsunami.dirX + ship.y * tsunami.dirY;
    if (s > tsunami.front) continue;
    tsunami.passed.add(ship);
    playTsunamiImpact(ship.x, ship.y, !shipFacesTsunami(ship));

    if (shipFacesTsunami(ship)) {
      // Rode over the crest: a jolt and a shove, but still afloat.
      damageShip(ship, 6 * game.settings.hazardScale, "rode over tsunami");
      ship.x = clamp(ship.x + tsunami.dirX * 30, 10, WORLD_W - 10);
      ship.y = clamp(ship.y + tsunami.dirY * 30, 10, WORLD_H - 10);
      if (ship.isHuman) setUiMessage(`${ship.playerName || "Ship"} rode over the tsunami!`);
    } else {
      damageShip(ship, 100, "capsized broadside by tsunami", true);
      if (ship.isHuman) setUiMessage(`${ship.playerName || "Ship"} was caught broadside by the tsunami!`);
    }
  }

  if (tsunami.front > tsunami.endAt) resetTsunami();
}

// AI captains turn bow or stern (whichever is closer) into an approaching wave.
function braceForTsunami(ship, input) {
  if (tsunami.state === "dormant" || !ship || ship.capsized || tsunami.passed.has(ship)) return input;
  const gap = ship.x * tsunami.dirX + ship.y * tsunami.dirY - tsunami.front;
  if (gap < 0 || gap > 300) return input;
  const waveAngle = Math.atan2(tsunami.dirY, tsunami.dirX);
  const toStern = normalizeAngle(waveAngle - ship.angle);
  const toBow = normalizeAngle(waveAngle + Math.PI - ship.angle);
  const diff = Math.abs(toBow) < Math.abs(toStern) ? toBow : toStern;
  if (Math.abs(diff) < 0.12) return { ...input, left: false, right: false };
  return { ...input, left: diff < 0, right: diff > 0 };
}

// A whirlpool: opens without warning in open water, stays put and only grows
// wider. At first it gently turns ships round and drags them along; as it
// strengthens it spins faster and pulls harder towards the centre, and a ship
// left in its throat is sucked under and capsizes. After WHIRLPOOL_LIFE
// seconds it calms down gradually over the last WHIRLPOOL_FADE seconds.
// A ship can always steer and sail out (no current beats a ship's own
// engine and rudder), but the later it leaves it, the harder it gets.
const whirlpool = {
  x: 0,
  y: 0,
  r: 0,
  age: 0,
  strength: 0, // 0..1: how hard it spins and pulls right now
  spin: 1, // +1 clockwise on screen, -1 anticlockwise
  state: "dormant", // "dormant" | "active"
  timer: 40,
  warned: new WeakSet()
};

const WHIRLPOOL_LIFE = 34;
const WHIRLPOOL_FADE = 10;
const WHIRLPOOL_START_R = 45;
const WHIRLPOOL_MAX_R = 210;
const WHIRLPOOL_SPIN_SPEED = 150; // sideways current at full strength
const WHIRLPOOL_PULL_SPEED = 105; // current towards the centre at full strength
const WHIRLPOOL_TURN = 1.3; // how fast it swings a ship's bow round (rad/s)
const WHIRLPOOL_SINK_TIME = 1.4; // seconds in the throat before going under

function resetWhirlpool() {
  whirlpool.state = "dormant";
  whirlpool.strength = 0;
  whirlpool.timer = randomInterval(WHIRLPOOL_GAP);
}

// Open water, clear of land and harbours, not right under a ship.
function launchWhirlpool() {
  const ships = allCombatShips();
  for (let attempt = 0; attempt < 80; attempt++) {
    const x = 250 + Math.random() * (WORLD_W - 500);
    const y = 250 + Math.random() * (WORLD_H - 500);
    const p = { x, y };
    const clearOfLand = [...hazards, HarbourA, HarbourB].every((h) => dist(p, h) > (h.clear || h.danger || h.r) + WHIRLPOOL_MAX_R + 20);
    const clearOfShips = ships.every((s) => dist(p, s) > WHIRLPOOL_START_R + 120);
    if (clearOfLand && clearOfShips && terrainDepth(x, y) > WHIRLPOOL_MAX_R * 0.8) {
      whirlpool.x = x;
      whirlpool.y = y;
      whirlpool.r = WHIRLPOOL_START_R;
      whirlpool.age = 0;
      whirlpool.strength = 0;
      whirlpool.spin = Math.random() < 0.5 ? 1 : -1;
      whirlpool.warned = new WeakSet();
      whirlpool.state = "active";
      setUiMessage("A whirlpool is opening - see the swirl on the map");
      return true;
    }
  }
  return false;
}

// Builds up over 20 s, eases off over the last WHIRLPOOL_FADE seconds.
function whirlpoolStrengthAt(age) {
  const t = clamp(age / 20, 0, 1);
  const build = t * t * (3 - 2 * t);
  const f = clamp((WHIRLPOOL_LIFE - age) / WHIRLPOOL_FADE, 0, 1);
  return build * f * f * (3 - 2 * f);
}

function updateWhirlpool(dt) {
  if (!weatherAllowed("whirlpool")) return;
  const wp = whirlpool;
  if (wp.state === "dormant") {
    wp.timer -= dt;
    if (wp.timer <= 0) {
      if (!threatSlotOpen() || tsunami.state !== "dormant" || !launchWhirlpool()) {
        wp.timer = 2;
        return;
      }
      claimThreatSlot(BIG_EVENT_GAP);
    }
    return;
  }

  wp.age += dt;
  wp.strength = whirlpoolStrengthAt(wp.age);
  // Only ever widens: fast at first, slower as it gets big.
  wp.r = WHIRLPOOL_START_R + (WHIRLPOOL_MAX_R - WHIRLPOOL_START_R) * Math.sqrt(clamp(wp.age / WHIRLPOOL_LIFE, 0, 1));
  if (wp.age >= WHIRLPOOL_LIFE) {
    resetWhirlpool();
    return;
  }

  const s = wp.strength;
  const throat = Math.max(16, wp.r * 0.12);
  for (const ship of allCombatShips()) {
    const dx = ship.x - wp.x;
    const dy = ship.y - wp.y;
    const d = Math.hypot(dx, dy) || 0.001;
    if (d >= wp.r) {
      ship.whirlSink = 0;
      continue;
    }
    const k = 1 - d / wp.r; // 0 at the rim, 1 at the centre
    const nx = dx / d;
    const ny = dy / d;
    // Sideways along the circle (with the spin) and in towards the middle.
    const around = WHIRLPOOL_SPIN_SPEED * s * (0.3 + 0.7 * k);
    const inward = WHIRLPOOL_PULL_SPEED * Math.pow(s, 1.5) * (0.2 + 0.8 * k);
    ship.x += (-ny * wp.spin * around - nx * inward) * dt;
    ship.y += (nx * wp.spin * around - ny * inward) * dt;
    // The current swings the bow round with it.
    ship.angle += wp.spin * WHIRLPOOL_TURN * s * (0.3 + 0.7 * k) * dt;

    if (ship.isHuman && !wp.warned.has(ship)) {
      wp.warned.add(ship);
      setUiMessage(`${ship.playerName || "Ship"} is caught in a whirlpool! Steer away from the centre.`);
    }

    if (d < throat && s > 0.5) {
      ship.whirlSink = (ship.whirlSink || 0) + dt / WHIRLPOOL_SINK_TIME;
      if (ship.whirlSink >= 1) {
        damageShip(ship, 100, "sucked under by a whirlpool", true);
        if (ship.isHuman) setUiMessage(`${ship.playerName || "Ship"} was sucked under by the whirlpool!`);
      }
    } else {
      ship.whirlSink = Math.max(0, (ship.whirlSink || 0) - dt);
    }
  }
}

function drawWhirlpool() {
  const wp = whirlpool;
  if (wp.state === "dormant" || wp.strength < 0.01) return;
  const s = wp.strength;
  ctx.save();
  ctx.translate(wp.x, wp.y);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, wp.r);
  g.addColorStop(0, `rgba(4, 22, 34, ${0.85 * s})`);
  g.addColorStop(0.35, `rgba(12, 60, 84, ${0.45 * s})`);
  g.addColorStop(1, "rgba(20, 90, 120, 0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, wp.r, 0, Math.PI * 2);
  ctx.fill();
  // Spiral foam arms turning with the current.
  const turn = game.elapsed * (0.6 + 2.4 * s) * wp.spin;
  ctx.strokeStyle = `rgba(235, 248, 255, ${(0.25 + 0.5 * s) * Math.min(1, 3 * s)})`;
  ctx.lineWidth = 2.5;
  for (let arm = 0; arm < 3; arm++) {
    ctx.beginPath();
    for (let i = 0; i <= 30; i++) {
      const q = i / 30;
      const a = turn + (arm * Math.PI * 2) / 3 - wp.spin * q * 4.5;
      const rr = wp.r * (0.08 + 0.9 * q);
      if (i === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.stroke();
  }
  ctx.restore();
}

const STORAGE_KEY = "harbour-run-profiles-v1";
const SETTINGS_KEY = "harbour-run-settings-v1";
const SELL_REFUND_RATE = 0.6;
const REPAIR_RESERVE_RATIO = 0.55;
const GAMEPLAY_PRESETS = ["calm", "classic", "chaos"];
// Every gameplay key can be changed in Settings > key bindings. The list is in grid order (7 rows, 4 columns).
const DEFAULT_KEYBINDS = {
  p1Forward: "KeyW",
  p1Backward: "KeyS",
  p1Left: "KeyA",
  p1Right: "KeyD",
  p1Attack: "Space",
  p1Anchor: "KeyR",
  p1Repair: "KeyH",
  p1Fire: "KeyF",
  p1Tow: "KeyT",
  p1Deterrent: "KeyG",
  p1SlideLeft: "KeyQ",
  p1SlideRight: "KeyE",
  p1Bridge: "KeyB",
  cameraView: "KeyC",
  p2Forward: "ArrowUp",
  p2Backward: "ArrowDown",
  p2Left: "ArrowLeft",
  p2Right: "ArrowRight",
  p2Attack: "ShiftRight",
  p2Anchor: "Comma",
  p2Repair: "Slash",
  p2Fire: "Period",
  p2Tow: "Quote",
  p2Deterrent: "Semicolon",
  p2SlideLeft: "BracketLeft",
  p2SlideRight: "BracketRight",
  p2Bridge: "Backslash",
  nightMode: "KeyN"
};
const KEYBIND_LABELS = {
  p1Forward: "P1 Forward",
  p1Backward: "P1 Backward",
  p1Left: "P1 Left",
  p1Right: "P1 Right",
  p1Attack: "P1 Attack",
  p1Anchor: "P1 Anchor",
  p1Repair: "P1 Repair",
  p1Fire: "P1 Fire fighting",
  p1Tow: "P1 Tow",
  p1Deterrent: "P1 Deterrent",
  p1SlideLeft: "P1 Slide left",
  p1SlideRight: "P1 Slide right",
  p1Bridge: "P1 Bridge camera",
  cameraView: "Camera view",
  p2Forward: "P2 Forward",
  p2Backward: "P2 Backward",
  p2Left: "P2 Left",
  p2Right: "P2 Right",
  p2Attack: "P2 Attack",
  p2Anchor: "P2 Anchor",
  p2Repair: "P2 Repair",
  p2Fire: "P2 Fire fighting",
  p2Tow: "P2 Tow",
  p2Deterrent: "P2 Deterrent",
  p2SlideLeft: "P2 Slide left",
  p2SlideRight: "P2 Slide right",
  p2Bridge: "P2 Bridge camera",
  nightMode: "Day / night"
};
const PREMIUM_PACKS = {
  specialistArsenal: {
    name: "Specialist Arsenal Pack",
    note: "Planned as paid Microsoft Store add-on"
  },
  specialistFleet: {
    name: "Specialist Fleet Pack",
    note: "Premium ship collection"
  }
};
const SHIP_CATALOG = [
  {
    id: "cruiseLiner",
    name: "Cruise Liner",
    category: "Cruise",
    color: "#2f7ef7",
    defaultOwned: true,
    desc: "Balanced flagship with strong visibility.",
    stats: { maxSpeed: 240, accel: 165, hp: 110, turnRate: 1.13, windResistance: 0.08 }
  },
  {
    id: "cargoFreighter",
    name: "Cargo Freighter",
    category: "Cargo",
    color: "#cf8442",
    defaultOwned: true,
    desc: "Heavy hull and high survivability.",
    stats: { maxSpeed: 205, accel: 142, hp: 150, turnRate: 1.0, windResistance: 0.18 }
  },
  {
    id: "sailingBoat",
    name: "Sailing Boat",
    category: "Sailing",
    color: "#f1efcf",
    defaultOwned: true,
    desc: "Agile but more exposed to wind.",
    stats: { maxSpeed: 194, accel: 136, hp: 96, turnRate: 2.0, windResistance: -0.08 }
  },
  {
    id: "hospitallerCarrack",
    name: "Hospitaller Carrack",
    category: "Carrack",
    color: "#a8744a",
    cost: 300,
    desc: "16th-century warship of the Knights Hospitaller: stout oak hull and cannon.",
    stats: { maxSpeed: 188, accel: 122, hp: 170, turnRate: 1.1, windResistance: -0.04 }
  },
  {
    id: "catamaran",
    name: "Catamaran",
    category: "Catamaran",
    color: "#35d4be",
    cost: 180,
    desc: "Fast twin-hull coastal runner.",
    stats: { maxSpeed: 258, accel: 178, hp: 102, turnRate: 1.86, windResistance: 0.04 }
  },
  {
    id: "assaultShip",
    name: "Assault Ship",
    category: "Assault",
    color: "#ef6760",
    cost: 320,
    desc: "Combat-oriented hull with better attack range.",
    stats: { maxSpeed: 230, accel: 168, hp: 132, turnRate: 1.33, windResistance: 0.12, attackRangeBonus: 12 }
  },
  {
    id: "aircraftCarrier",
    name: "Aircraft Carrier",
    category: "Carrier",
    color: "#7a869d",
    premiumPack: "specialistFleet",
    desc: "Massive premium carrier with strong hull.",
    stats: { maxSpeed: 182, accel: 124, hp: 175, turnRate: 0.86, windResistance: 0.24 }
  },
  {
    id: "futuristicNova",
    name: "Futuristic Nova",
    category: "Futuristic",
    color: "#b68cff",
    premiumPack: "specialistFleet",
    desc: "Premium high-tech ship with superior handling.",
    stats: { maxSpeed: 282, accel: 208, hp: 122, turnRate: 2.13, windResistance: 0.2 }
  },
  {
    id: "hydrofoil",
    name: "Hydrofoil",
    category: "Hydrofoil",
    color: "#ff9f1c",
    premiumPack: "specialistFleet",
    desc: "Flies on underwater wings: fastest, but shallows hurt it twice as much.",
    stats: { maxSpeed: 305, accel: 200, hp: 98, turnRate: 1.46, windResistance: 0.28 }
  },
  {
    id: "icebreaker",
    name: "Icebreaker",
    category: "Icebreaker",
    color: "#d8342c",
    cost: 280,
    desc: "Breaks through ice sheets without damage, but crawls while it does.",
    stats: { maxSpeed: 200, accel: 140, hp: 165, turnRate: 1.0, windResistance: 0.2 }
  },
  {
    id: "oilTanker",
    name: "Oil Tanker",
    category: "Tanker",
    color: "#3a3f47",
    cost: 260,
    desc: "Double hull: survives hits that sink other ships. Plugs into the oil pump at anchor.",
    stats: { maxSpeed: 185, accel: 118, hp: 210, turnRate: 0.82, windResistance: 0.22 }
  },
  {
    id: "gasTanker",
    name: "Gas Tanker",
    category: "GasTanker",
    color: "#2f6d8c",
    cost: 280,
    desc: "Tough gas carrier: survives hits that sink other ships. Plugs into the gas pump at anchor.",
    stats: { maxSpeed: 195, accel: 124, hp: 195, turnRate: 0.86, windResistance: 0.3 }
  },
  {
    id: "wartimeTanker",
    name: "Wartime Tanker",
    category: "WarTanker",
    color: "#68727d",
    cost: 340,
    desc: "1943 armed tanker: deck guns fire ahead and astern. Takes heavy hits. Oil pump at anchor.",
    stats: { maxSpeed: 172, accel: 108, hp: 220, turnRate: 0.8, windResistance: 0.22 }
  },
  {
    id: "tugBoat",
    name: "Tug Boat",
    category: "Tug",
    color: "#ee4a16",
    premiumPack: "specialistFleet",
    desc: "Small and very strong: takes other ships in tow on a rope (P1: T, P2: ').",
    stats: { maxSpeed: 190, accel: 230, hp: 120, turnRate: 1.9, windResistance: 0.1 }
  }
];

// The Order's galley, oared, which tows the Hospitaller carrack in and out of
// port. It is not bought or picked: in 2-player it is player 2's ship when
// player 1 takes the carrack, otherwise the computer rows one out when called.
const ORDER_GALLEY = {
  id: "hospitallerGalley",
  name: "Hospitaller Galley",
  category: "Galley",
  color: "#b3202a",
  defaultOwned: true,
  desc: "Oared galley of the Order: turns on the spot and takes great ships in tow.",
  stats: { maxSpeed: 200, accel: 150, hp: 125, turnRate: 1.5, windResistance: 0.45 }
};
const TOWING_SHIPS = ["Tug", "Galley"]; // T / ' passes their tow rope

// Hydrofoil: once fast enough the hull lifts clear of the water on its
// foils ("foil-borne"): less drag and less wind drift, but the foils hit the
// shallows around land hard (HYDROFOIL_SHALLOWS_DAMAGE x the usual damage).
const HYDROFOIL_LIFT_FROM = 0.45; // share of top speed where the hull starts to rise
const HYDROFOIL_SHALLOWS_DAMAGE = 2.2;

function updateFoilLift(ship) {
  if (ship.category !== "Hydrofoil") return;
  ship.foilLift = clamp((Math.abs(ship.speed) / ship.maxSpeed - HYDROFOIL_LIFT_FROM) / 0.3, 0, 1);
}

// Ice sheets (pack ice): fields of sea ice floes. Every other ship grinds
// through them slowly and takes damage. The icebreaker takes none but crawls
// while it breaks fresh ice, and leaves an open channel of loose ice behind
// it that any ship can follow at a better speed. Channels stay open for the
// rest of the crossing.
const ICE_BREAK_R = 24; // half-width of the channel the icebreaker opens
const ICE_BREAK_STEP = 7; // a channel point every this many units
const ICE_SPEED = { solid: 0.35, icebreaker: 0.22, channel: 0.75 }; // share of top speed
const ICE_DAMAGE = 10; // hull per second grinding through unbroken ice
const ICE_TEX = 512; // ice sheet picture (pixels), shared by the 2D and 3D views

function iceEdge(sheet, a) {
  const [l0, l1, l2] = sheet.lobes;
  return sheet.r * (0.84 + 0.08 * Math.sin(a * 3 + l0) + 0.05 * Math.sin(a * 5 + l1) + 0.03 * Math.sin(a * 11 + l2));
}

function iceSheetAt(x, y) {
  for (const s of game.iceSheets) {
    const dx = x - s.x;
    const dy = y - s.y;
    const d = Math.hypot(dx, dy);
    if (d < s.r && d < iceEdge(s, Math.atan2(dy, dx)) && !iceFreeAt(s, x, y)) return s;
  }
  return null;
}

// "solid", "channel" (broken by an icebreaker) or null (open sea).
function iceAt(x, y) {
  const s = iceSheetAt(x, y);
  if (!s) return null;
  const r2 = ICE_BREAK_R * ICE_BREAK_R;
  for (const p of s.broken) if ((x - p.x) ** 2 + (y - p.y) ** 2 < r2) return "channel";
  return "solid";
}

// Polar run: when a player sails the icebreaker in Free Play, the whole run is set in
// the far south. Both harbours are locked in by fast ice outside their
// breakwaters, there is more pack ice at sea and the land is under snow.
function isPolarRun() {
  const slots = mode === "local" ? ["p1", "p2"] : ["p1"];
  return slots.some((slot) => getShipDefinition(getProfile(slot).selectedShip).category === "Icebreaker");
}

// Fast ice around a harbour stops at its breakwaters: the basin inside and
// the land itself stay free of ice.
function iceFreeAt(sheet, x, y) {
  const h = sheet.harbour;
  if (!h) return false;
  const a = (x - h.corner.x) * h.sa;
  const b = (y - h.corner.y) * h.sb;
  if (a < BASIN - 3 && b < BASIN - 3 && a + b < BASIN * 1.65) return true;
  return (a < 24 || b < 24) && landClearance(x, y) < 0; // the land lies behind the quay faces
}

function makeIceSheet(x, y, r, harbour = null) {
  const sheet = { x, y, r, harbour, lobes: [Math.random() * 6, Math.random() * 6, Math.random() * 6], broken: [], version: 0 };
  sheet.floes = iceFloes(sheet);
  sheet.canvas = iceSheetCanvas(sheet);
  return sheet;
}

// The sheet is a mosaic of floes (one per cell of a jittered grid, the
// nearest seed owns a point). Each floe has its own thickness: young grey
// ice, white first-year ice, thick old floes. Where two floes meet there is
// either a pressure ridge (a raised rubble wall) or a lead (a crack of thin
// new ice).
const ICE_FLOE = 30; // typical floe size
const icePoint = { h: 0, ridge: 0, lead: 0, rim: Infinity }; // what iceSurface found (reused); rim = distance in from the edge

function iceFloes(sheet) {
  const n = Math.ceil((2 * sheet.r) / ICE_FLOE) + 2;
  const seeds = new Float32Array(n * n * 3);
  for (let i = 0; i < n * n; i++) {
    seeds[i * 3] = ((i % n) - 1 + 0.15 + Math.random() * 0.7) * ICE_FLOE - sheet.r;
    seeds[i * 3 + 1] = (Math.floor(i / n) - 1 + 0.15 + Math.random() * 0.7) * ICE_FLOE - sheet.r;
    seeds[i * 3 + 2] = (Math.random() - 0.5) * 0.9; // this floe's thickness against the ice around it
  }
  return { n, seeds, salt: Math.random() * 100 };
}

// Ice at (lx, ly) from the sheet's centre, ignoring channels: fills icePoint
// and returns the thickness (0 = open water).
function iceSurface(sheet, lx, ly) {
  icePoint.ridge = 0;
  icePoint.lead = 0;
  const d = Math.hypot(lx, ly);
  // The edge is never closer in than 0.68 r (iceEdge).
  icePoint.rim = d > sheet.r * 0.66 ? iceEdge(sheet, Math.atan2(ly, lx)) - d : Infinity;
  if (d >= sheet.r || icePoint.rim <= 0 || iceFreeAt(sheet, sheet.x + lx, sheet.y + ly)) return (icePoint.h = 0);
  const { n, seeds, salt } = sheet.floes;
  const cx = Math.floor((lx + sheet.r) / ICE_FLOE) + 1;
  const cy = Math.floor((ly + sheet.r) / ICE_FLOE) + 1;
  let d1 = Infinity;
  let d2 = Infinity;
  let i1 = 0;
  let i2 = 0;
  for (let y = Math.max(0, cy - 1); y <= Math.min(n - 1, cy + 1); y++) {
    for (let x = Math.max(0, cx - 1); x <= Math.min(n - 1, cx + 1); x++) {
      const i = y * n + x;
      const q = (seeds[i * 3] - lx) ** 2 + (seeds[i * 3 + 1] - ly) ** 2;
      if (q < d1) {
        d2 = d1;
        i2 = i1;
        d1 = q;
        i1 = i;
      } else if (q < d2) {
        d2 = q;
        i2 = i;
      }
    }
  }
  // Distance to the boundary with the next floe.
  const gap = Math.hypot(seeds[i1 * 3] - seeds[i2 * 3], seeds[i1 * 3 + 1] - seeds[i2 * 3 + 1]);
  const e = (d2 - d1) / (2 * gap);
  const pair = Math.abs(Math.sin(Math.min(i1, i2) * 12.9898 + Math.max(i1, i2) * 78.233 + salt) * 43758.5453) % 1;
  // Thickness drifts slowly across the sheet (thin young ice in places, old
  // thick ice in others) and each floe sits a little above or below that.
  let h = 1.7 + 0.75 * Math.sin(lx * 0.019 + salt) * Math.sin(ly * 0.023 + salt * 1.7) + 0.35 * Math.sin((lx - ly) * 0.047 + salt * 2.3);
  h = Math.max(0.35, h + seeds[i1 * 3 + 2]);
  if (pair < 0.3) {
    // Pressure ridge: up to a few times the floe's thickness, lumpy along its length.
    const lump = 0.65 + 0.35 * Math.sin(lx * 0.37 + ly * 0.29 + pair * 40);
    icePoint.ridge = Math.exp(-((e / 3.2) ** 2));
    h += (2.2 + pair * 12) * lump * icePoint.ridge;
  } else if (pair > 0.86) {
    // Lead: a crack refrozen with thin dark ice.
    icePoint.lead = 1 - clamp((e - 1.2) / 1.2, 0, 1);
    h += (0.12 - h) * icePoint.lead;
  } else if (pair > 0.6 && e < 0.6) {
    h *= 0.6; // a hairline crack between floes (the rest are frozen together)
  }
  return (icePoint.h = h);
}

// The sheet seen from above, on a square 2r wide centred on it, coloured by
// thickness: thin new ice is dark grey, thicker ice whiter, ridges bright
// with blue in their rubble, the floe edge a blue-green rim.
const ICE_SHADES = [
  [0.1, 84, 114, 130],
  [0.6, 160, 186, 198],
  [1.2, 214, 229, 237],
  [2.0, 236, 244, 248],
  [3.0, 249, 251, 253]
];

function iceSheetCanvas(sheet) {
  const c = document.createElement("canvas");
  c.width = c.height = ICE_TEX;
  const g = c.getContext("2d");
  const img = g.createImageData(ICE_TEX, ICE_TEX);
  const px = img.data;
  const unit = (2 * sheet.r) / ICE_TEX;
  for (let j = 0; j < ICE_TEX; j++) {
    const ly = (j + 0.5) * unit - sheet.r;
    for (let i = 0; i < ICE_TEX; i++) {
      const lx = (i + 0.5) * unit - sheet.r;
      const h = iceSurface(sheet, lx, ly);
      if (h <= 0) continue;
      const floe = Math.min(h, 3.5);
      let k = 1;
      while (k < ICE_SHADES.length - 1 && ICE_SHADES[k][0] < floe) k++;
      const [h0, r0, g0, b0] = ICE_SHADES[k - 1];
      const [h1, r1, g1, b1] = ICE_SHADES[k];
      const t = clamp((floe - h0) / (h1 - h0), 0, 1);
      let r = r0 + (r1 - r0) * t;
      let gr = g0 + (g1 - g0) * t;
      let b = b0 + (b1 - b0) * t;
      // Ridge rubble: white crest, blue ice in the broken blocks at its foot.
      const rd = icePoint.ridge;
      if (rd > 0.05) {
        const foot = rd * (1 - rd) * 4;
        r += (255 - r) * rd * 0.8 - 70 * foot * 0.5;
        gr += (255 - gr) * rd * 0.8 - 30 * foot * 0.5;
        b += (255 - b) * rd * 0.8;
      }
      // Floe edge: the ice's blue-green side shows from above.
      const rim = icePoint.rim;
      if (rim < 4) {
        const w = 1 - rim / 4;
        r += (120 - r) * w * 0.7;
        gr += (186 - gr) * w * 0.7;
        b += (206 - b) * w * 0.7;
      }
      const grain = (((i * 73856093) ^ (j * 19349663)) & 7) - 3.5; // wind-packed snow
      const o = (j * ICE_TEX + i) * 4;
      px[o] = r + grain;
      px[o + 1] = gr + grain;
      px[o + 2] = b + grain;
      px[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// The icebreaker's hull at (x, y): open water there, with loose floes left
// along the channel's sides.
function breakIce(x, y) {
  const s = iceSheetAt(x, y);
  if (!s) return;
  if (s.broken.some((p) => (x - p.x) ** 2 + (y - p.y) ** 2 < ICE_BREAK_STEP ** 2)) return;
  s.broken.push({ x, y });
  s.version += 1;
  const g = s.canvas.getContext("2d");
  const k = ICE_TEX / (2 * s.r);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.translate(ICE_TEX / 2 + (x - s.x) * k, ICE_TEX / 2 + (y - s.y) * k);
  g.scale(k, k);
  g.globalCompositeOperation = "destination-out";
  const hole = g.createRadialGradient(0, 0, ICE_BREAK_R * 0.8, 0, 0, ICE_BREAK_R * 1.05);
  hole.addColorStop(0, "rgba(0, 0, 0, 1)");
  hole.addColorStop(1, "rgba(0, 0, 0, 0)");
  g.fillStyle = hole;
  g.beginPath();
  g.arc(0, 0, ICE_BREAK_R * 1.05, 0, Math.PI * 2);
  g.fill();
  g.globalCompositeOperation = "source-over";
  for (let i = 0; i < 4; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = ICE_BREAK_R * (0.6 + Math.random() * 0.35);
    const size = 2 + Math.random() * 3;
    g.fillStyle = "rgba(236, 246, 252, 0.95)";
    g.beginPath();
    for (let j = 0; j < 5; j++) {
      const b = (j / 5) * Math.PI * 2 + Math.random() * 0.6;
      g.lineTo(Math.cos(a) * d + Math.cos(b) * size, Math.sin(a) * d + Math.sin(b) * size);
    }
    g.fill();
  }
  g.restore();
}

// While under way: the ice slows the ship (ship.ice = what it is in), and the
// icebreaker breaks a channel with its hull.
function updateShipIce(ship, dt) {
  ship.ice = null;
  if (!game.iceSheets.length) return;
  let cap;
  if (ship.category === "Icebreaker") {
    // The ice just ahead of the bow decides: fresh ice to break means a
    // crawl; following an open channel (or backing out of one) doesn't.
    const dir = ship.speed < 0 ? -1 : 1;
    const fx = Math.cos(ship.angle) * dir;
    const fy = Math.sin(ship.angle) * dir;
    const bow = shipHalfLength(ship);
    const ahead = iceAt(ship.x + fx * (bow + ICE_BREAK_R + 4), ship.y + fy * (bow + ICE_BREAK_R + 4));
    ship.ice = ahead === "solid" ? "solid" : iceAt(ship.x, ship.y);
    if (ship.ice === "solid") cap = ICE_SPEED.icebreaker;
    else if (ship.ice === "channel") cap = ICE_SPEED.channel;
    breakIce(ship.x, ship.y);
    breakIce(ship.x + fx * bow, ship.y + fy * bow);
    breakIce(ship.x + fx * bow * 0.5, ship.y + fy * bow * 0.5);
  } else {
    ship.ice = iceAt(ship.x, ship.y);
    if (ship.ice) cap = ICE_SPEED[ship.ice];
  }
  if (cap === undefined) return;
  cap = Math.min(1, cap * (1 + 0.8 * crewSkill(ship, "ice")));
  // The ice soaks up the engine's push and bleeds off any extra way, so
  // entering it slows the ship over a second or so and it can't go faster.
  const max = ship.maxSpeed * cap;
  const excess = Math.abs(ship.speed) - max;
  if (excess > 0) ship.speed -= Math.sign(ship.speed) * Math.min(excess, (excess * 3 + ship.accel) * dt);
}

// Tankers (oil and gas) have double hulls: a hit that sinks any other ship
// outright (a pirate's broadside, a cannonball) tears TANKER_HIT_SHARE of the
// hull instead, and rocks, fire and lava (which take a share of the hull)
// do less to them.
const TANKERS = { Tanker: "oil", GasTanker: "gas", WarTanker: "oil" };
const TANKER_HIT_SHARE = 0.55;
const TANKER_SHARE_DAMAGE = 0.65;

function sinkingHit(target, reason) {
  if (TANKERS[target.category]) damageShip(target, target.maxHull * TANKER_HIT_SHARE, reason);
  else damageShip(target, 100, reason, true);
}

// At anchor in a harbour a tanker is plugged into a pump on the quay: the
// oil tanker into the oil pump, the gas tanker into the gas pump. Both
// harbours have both, given in the harbour's own frame; the hose leaves the
// quay at its edge (PUMP_QUAY_A) and floats out to the ship.
const PUMPS = { oil: { a: 11, b: 76, name: "oil pump" }, gas: { a: 11, b: 104, name: "gas pump" } };
const PUMP_QUAY_A = 21;

function pumpHose(ship) {
  const kind = ship && TANKERS[ship.category];
  if (!kind || ship.capsized || !ship.anchored) return null;
  const h = berthedHarbour(ship);
  if (!h) return null;
  const p = PUMPS[kind];
  return { kind, name: p.name, harbour: h, quay: harbourPoint(h, PUMP_QUAY_A, p.b) };
}

// Tug: T (player 1) / ' (player 2) passes a tow rope to the nearest ship
// within reach, or casts it off. The rope pulls only when taut. The tug is
// strong for its size (TUG_PULL is its weight on the rope against the tow's
// bump mass), so it hauls even a carrier, slowly; the tow swings round to
// follow. The rope is lost if either ship sinks or anchors.
// (read from the key bindings, so they follow what the player set in Settings)
const TOW_KEYS = { get p1() { return game.settings.keybinds.p1Tow; }, get p2() { return game.settings.keybinds.p2Tow; } };
const TOW_KEY_NAMES = { get p1() { return keyName(game.settings.keybinds.p1Tow); }, get p2() { return keyName(game.settings.keybinds.p2Tow); } };
const TOW_REACH = 70; // gap between the hulls to pass a rope
const TOW_SLACK = 30; // rope between the tug's stern and the tow's bow
const TUG_PULL = 4;

function shipHalfLength(ship) {
  const shape = bumpShape(ship);
  return shape.h + shape.r;
}

function shipLabel(ship) {
  return ship.playerName || ship.shipName || "ship";
}

// Two tug popups (2-player, local). At the start of a voyage, a tug captain with
// a large ship berthed alongside is asked whether to pull it out of the
// harbour. After a tow, once the tug is back, moored at a berth, its captain
// is asked whether to change ship to carry on; yes opens the ship choice, no
// leaves the tug berthed until its captain weighs anchor and casts off again.
function openTugOffer(kind, slot) {
  game.tugOffer = { kind, slot, choice: 0 };
  keys.clear();
  playUiClick();
}

function offerTugPull() {
  if (mode !== "local") return;
  for (const [slot, tug, big] of [["p1", game.player1, game.player2], ["p2", game.player2, game.player1]]) {
    const wants = tug?.category === "Galley" ? big?.category === "Carrack" : tug?.category === "Tug" && THRUSTER_SHIPS.includes(big?.category);
    if (!tug || !big || tug.capsized || big.capsized || !wants) continue;
    if (tug.berth && big.berth && tug.berth.h === big.berth.h) {
      openTugOffer("pull", slot);
      return;
    }
  }
}

function offerShipChange() {
  if (mode !== "local" || game.tugOffer || game.midGameChange) return;
  for (const tug of humanShips()) {
    if (!TOWING_SHIPS.includes(tug.category) || !tug.didTow || tug.tow || tug.capsized || !tug.anchored || !tug.berth || tug.ropes < 1) continue;
    tug.didTow = false;
    openTugOffer("change", tug.playerSlot);
    return;
  }
}

// The tug's captain said yes: both ships cast off at once and the tug takes the
// large ship in tow from just ahead of its bow.
function startPull(tug) {
  const big = tug === game.player1 ? game.player2 : game.player1;
  for (const s of [tug, big]) {
    s.anchored = false;
    s.ropes = 0;
    s.berth = null;
    s.warping = false;
    s.castOff = true;
  }
  const gap = shipHalfLength(big) + shipHalfLength(tug) + TOW_SLACK;
  tug.x = big.x + Math.cos(big.angle) * gap;
  tug.y = big.y + Math.sin(big.angle) * gap;
  tug.angle = big.angle;
  tug.tow = big;
  tug.didTow = true;
  tug.towLength = gap;
  setUiMessage(`${shipLabel(tug)} has ${shipLabel(big)} in tow - ${TOW_KEY_NAMES[tug.playerSlot]} to cast off`);
}

function closeTugOffer(yes) {
  const offer = game.tugOffer;
  game.tugOffer = null;
  playUi("ui_confirm", { type: "triangle", from: 660, to: 990, dur: 0.14, peak: 0.1 });
  if (!yes) return;
  if (offer.kind === "pull") {
    startPull(offer.slot === "p2" ? game.player2 : game.player1);
  } else {
    game.midGameChange = offer.slot;
    game.shipSelections = { p1: usableShipId("p1"), p2: usableShipId("p2") };
    game.shipSelectSlot = offer.slot;
    gameState = "shipSelect";
  }
}

function handleTugOfferKey(code) {
  const box = game.tugOffer;
  if (code === "KeyN" || code === "Escape") closeTugOffer(false);
  else if (code === "KeyY") closeTugOffer(true);
  else if (code === "Enter" || code === "Space") closeTugOffer(box.choice === 0);
  else if (["ArrowLeft", "ArrowRight", "Tab", "KeyA", "KeyD"].includes(code)) {
    box.choice = 1 - box.choice;
    playUi("ui_move", { type: "triangle", from: 900, dur: 0.05, peak: 0.08 });
  }
}

function drawTugOffer() {
  const box = game.tugOffer;
  if (!box) return;
  if (gameState !== "playing") {
    game.tugOffer = null;
    return;
  }
  const tug = box.slot === "p2" ? game.player2 : game.player1;
  const big = tug === game.player1 ? game.player2 : game.player1;
  const pull = box.kind === "pull";
  clearUiRects(); // only the popup's buttons can be clicked while it's open
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "rgba(2, 10, 18, 0.6)";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const w = 700;
  const h = 270;
  const x = (WIDTH - w) / 2;
  const y = (HEIGHT - h) / 2;
  ctx.fillStyle = "rgba(9, 26, 40, 0.97)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(186, 234, 255, 0.55)";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.textAlign = "center";
  ctx.fillStyle = "#e9f8ff";
  ctx.font = "bold 32px Segoe UI";
  ctx.fillText(pull ? "Pull the large ship out?" : "Change ship?", WIDTH / 2, y + 48);
  ctx.font = "20px Segoe UI";
  ctx.fillStyle = "#a9cbe0";
  const who = tug.playerName || "Captain";
  ctx.fillText(
    pull ? `${who}: the ${big.shipName} is berthed in the harbour.` : `${who}: the tow is done and the ${tug.category === "Tug" ? "tug" : "galley"} is back at its berth.`,
    WIDTH / 2, y + 84);
  ctx.fillText(pull ? "Take it in tow and pull it out to sea?" : "Pick another ship to continue the adventure?", WIDTH / 2, y + 108);
  const labels = pull ? ["Yes, take it in tow", "No, stay berthed"] : ["Yes, choose a ship", "No, stay berthed"];
  labels.forEach((label, i) => {
    const bw = 300;
    const bh = 82;
    const bx = WIDTH / 2 - bw - 14 + i * (bw + 28);
    const by = y + 136;
    const selected = box.choice === i;
    ctx.fillStyle = i === 0 ? "rgba(24, 92, 70, 0.92)" : "rgba(110, 40, 34, 0.92)";
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = selected ? "#ffd182" : "rgba(194, 227, 255, 0.4)";
    ctx.lineWidth = selected ? 3 : 1.5;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = "#f3fbff";
    ctx.font = "bold 24px Segoe UI";
    ctx.fillText(label, bx + bw / 2, by + 50);
    registerUiRect(bx, by, bw, bh, () => closeTugOffer(i === 0));
  });
  ctx.font = "14px Segoe UI";
  ctx.fillStyle = "#8fb4c8";
  if (!TOUCH_UI) ctx.fillText("Y / N or arrow keys and Enter", WIDTH / 2, y + h - 14);
  ctx.restore();
}

// Choosing another ship in the middle of a voyage: the new ship takes the old
// one's berth, at anchor with the lines fast, and keeps the points earned.
function confirmShipChange() {
  const slot = game.midGameChange;
  const profile = getProfile(slot);
  const shipDef = getShipDefinition(game.shipSelections[slot]);
  if (!isShipOwned(profile, shipDef)) {
    setUiMessage(`${profile.name} has not unlocked ${shipDef.name}`);
    return;
  }
  if (crewRequired(slot, shipDef.id)) return;
  const old = slot === "p2" ? game.player2 : game.player1;
  const fresh = newShip(old.type, old.x, old.y, old.angle);
  applyShipDefinition(fresh, shipDef);
  applyGadgets(fresh, profile, slot);
  initRepairState(fresh);
  fresh.runScore = old.runScore;
  fresh.anchored = true;
  mooredAtBerth(fresh, old.berth.h, old.berth.slot);
  if (slot === "p2") game.player2 = fresh;
  else game.player1 = fresh;
  profile.selectedShip = shipDef.id;
  saveProfiles();
  game.midGameChange = null;
  gameState = "playing";
  keys.clear();
  setUiMessage(`${profile.name} now sails the ${shipDef.name}`, slot);
}

function cancelShipSelect() {
  if (game.midGameChange) {
    game.midGameChange = null;
    gameState = "playing";
    keys.clear();
  } else if (game.voyage) {
    openMissions();
  } else {
    openVoyageChoice();
  }
}

function toggleTow(slot) {
  const tug = slot === "p2" ? game.player2 : game.player1;
  if (!tug || tug.capsized) return;
  if (tug.category === "Carrack") {
    callGalley(tug);
    return;
  }
  if (!TOWING_SHIPS.includes(tug.category)) return;
  if (tug.tow) {
    setUiMessage(`${shipLabel(tug)} cast off the tow`);
    tug.tow = null;
    return;
  }
  if (tug.anchored) {
    setUiMessage(`${shipLabel(tug)}: weigh anchor before taking a ship in tow`);
    return;
  }
  let best = null;
  let bestGap = TOW_REACH;
  for (const s of seaShips()) {
    if (!s || s === tug || s.capsized || s.anchored) continue;
    const gap = dist(tug, s) - shipHalfLength(tug) - shipHalfLength(s);
    if (gap < bestGap) {
      best = s;
      bestGap = gap;
    }
  }
  if (!best) {
    setUiMessage(`${shipLabel(tug)}: no ship close enough to take in tow`);
    return;
  }
  tug.tow = best;
  tug.didTow = true;
  tug.towLength = Math.max(dist(tug, best), shipHalfLength(tug) + TOW_SLACK + shipHalfLength(best));
  setUiMessage(`${shipLabel(tug)} has ${shipLabel(best)} in tow - ${TOW_KEY_NAMES[slot]} to cast off`);
}

function updateTows(dt) {
  for (const tug of humanShips()) {
    const tow = tug.tow;
    if (!tow) continue;
    if (tug.capsized || tow.capsized || tug.anchored || tow.anchored || !seaShips().includes(tow)) {
      tug.tow = null;
      setUiMessage(`${shipLabel(tug)} lost the tow`);
      continue;
    }
    // A rope passed from further off is hauled in to its working length.
    tug.towLength = Math.max(shipHalfLength(tug) + TOW_SLACK + shipHalfLength(tow), tug.towLength - 15 * dt);
    const dx = tow.x - tug.x;
    const dy = tow.y - tug.y;
    const d = Math.hypot(dx, dy) || 1;
    const stretch = d - tug.towLength;
    tug.towTaut = stretch > 0;
    if (!tug.towTaut) continue;
    // Each end gives way by its share of the weight on the rope.
    const pull = TUG_PULL * (1 + crewSkill(tug, "tow"));
    const towShare = pull / (pull + bumpBody(tow).mass);
    const ux = dx / d;
    const uy = dy / d;
    tow.x -= ux * stretch * towShare;
    tow.y -= uy * stretch * towShare;
    tug.x += ux * stretch * (1 - towShare);
    tug.y += uy * stretch * (1 - towShare);
    tow.angle += normalizeAngle(Math.atan2(-uy, -ux) - tow.angle) * Math.min(1, dt * 1.2);
  }
}

// ---- The carrack in port ----------------------------------------------------
// A great carrack could not work her way in or out of port under sail: oared
// boats pulled her. In harbour waters her sails give her nothing; a galley has
// to take her in tow, outward from Harbour A and inward at Harbour B. Player
// 2's galley does it when there is one at hand; otherwise the captain calls
// (the Tow key) and the computer's galley rows out.
const PORT_WATERS = 400; // this close to a harbour's corner (both ways) she is in port
const PORT_BERTHED = 300; // towed in this far, she is warped to her berth
const GALLEY_SPEED = { meet: 32, tow: 26, home: 28 }; // units/s at a steady stroke
const GALLEY_CHECK = 5; // units/s lost each second easing down to a stop
const GALLEY_ROPE_TIME = 3; // s to pass the tow rope before the oars take the strain
const GALLEY_TOW_TURN = 0.35; // rad/s, the fastest the rope swings the carrack's head round
const GALLEY_TURN = Math.PI / 12; // the course is plotted in 15 degree turns...
const GALLEY_RUN = 17; // ...each over this far: a turning circle a little wider than her own length
const GALLEY_PIVOT = 24; // turning on her oars on the spot takes as long as rowing this far (per 15 degrees)
const GALLEY_CLEAR = 10; // the least water between her hull (the oars reach out) and anything
const GALLEY_ROOM = 30; // and the extra she keeps when there is space for it
const GALLEY_SHIP_GAP = 7; // she stops rather than close nearer than this on a ship in her way
const GALLEY_SEARCH = 20000; // positions tried before giving up on a course
const GALLEY_ENTRANCE = 265; // both ways: the middle of the gap between the breakwaters
const GALLEY_AT_HAND = 600; // a player's galley this near does the towing itself
const GALLEY_TOWING_SPEED = 62; // a player's galley with a great ship on the rope

function inHarbourTerms(h, p) {
  return { a: (p.x - h.corner.x) * h.sa, b: (p.y - h.corner.y) * h.sb };
}

function carrackPort(ship) {
  if (!ship || ship.category !== "Carrack") return null;
  // Harbour A holds her only until she has first got clear (a gust must not put her back in its power).
  return [HarbourA, HarbourB].find((h) => {
    const { a, b } = inHarbourTerms(h, ship);
    return !(h === HarbourA && ship.leftA) && a < PORT_WATERS && b < PORT_WATERS;
  }) || null;
}

function underTow(ship) {
  return humanShips().some((s) => s.tow === ship) || (!!game.galley && game.galley.boat.tow === ship);
}

function playerGalleyAtHand(ship) {
  return humanShips().find((s) => s !== ship && s.category === "Galley" && !s.capsized && dist(s, ship) < GALLEY_AT_HAND) || null;
}

function callGalley(ship) {
  const slot = ship.playerSlot;
  const h = carrackPort(ship);
  let no = "";
  if (!h) no = "the galley only comes out in harbour waters";
  else if (ship.anchored || ship.ropes > 0) no = "weigh anchor and let the lines go first";
  else if (underTow(ship)) no = "she is already in tow";
  else if (playerGalleyAtHand(ship)) no = `${shipLabel(playerGalleyAtHand(ship))}'s galley is at hand: let them pass the rope`;
  else if (game.galley && game.galley.phase !== "rest") no = "the galley is busy, wait for it";
  if (no) {
    setUiMessage(`${shipLabel(ship)}: ${no}`, slot);
    return;
  }
  const inbound = h === HarbourB;
  const own = inHarbourTerms(h, ship);
  // Places for a carrack on the a side of the basin, mirrored for the other.
  const nearA = own.a <= own.b;
  const at = (a, b) => (nearA ? harbourPoint(h, a, b) : harbourPoint(h, b, a));
  const out = Math.atan2(h.sb, h.sa); // heading out through the entrance
  const middle = (d, angle) => ({ ...harbourPoint(h, d, d), angle });
  // Where the galley rows with her in tow.
  const legs = [];
  if (!inbound) {
    if ((own.a + own.b) / 2 < GALLEY_ENTRANCE - 75) legs.push(middle(GALLEY_ENTRANCE, out)); // unless the galley would lie past it
    legs.push(middle(600, out));
  } else {
    if (Math.max(own.a, own.b) > BASIN) { // still outside the breakwaters
      if (Math.min(own.a, own.b) < 250) legs.push(middle(460, out + Math.PI)); // off to one side: round by the entrance
      legs.push(middle(GALLEY_ENTRANCE, out + Math.PI));
    }
    legs.push(at(150, 180));
  }
  // The galley's station is along the other quay. Waiting there, she gets under
  // way from it; otherwise she comes in from the sea to take a carrack out, or
  // puts out from the station to bring one in.
  const station = { ...at(250, 42), angle: nearA ? Math.atan2(0, h.sa) : Math.atan2(h.sb, 0) };
  const waiting = game.galley && game.galley.h === h ? game.galley.boat : null;
  const start = waiting || (inbound ? station : middle(520, out + Math.PI));
  const boat = waiting || newShip("cruise", start.x, start.y, start.angle);
  if (!waiting) applyShipDefinition(boat, ORDER_GALLEY);
  const way = waiting || inbound ? 0 : GALLEY_SPEED.meet * 0.7;
  const g = { boat, target: ship, phase: "meet", h, inbound, legs, station, way, blocked: 0 };
  if (!seekCarrack(g)) {
    setUiMessage(`${shipLabel(ship)}: the galley can't find a clear way to you`, slot);
    return;
  }
  game.galley = g;
  setUiMessage(`${shipLabel(ship)} calls the Order's galley - it is on its way`, slot);
  playShipHorn();
}

// A capsule with its middle and overall reach worked out, to pass over far ones quickly.
function galleyKeepOff(p) {
  return { ax: p.ax, ay: p.ay, bx: p.bx, by: p.by, r: p.r, mx: (p.ax + p.bx) / 2, my: (p.ay + p.by) / 2, reach: Math.hypot(p.bx - p.ax, p.by - p.ay) / 2 + p.r };
}

// Everything the galley must keep off in a harbour's waters.
function galleyObstacles(h) {
  return [
    ...HARBOUR_LAND.filter((p) => p.harbour === h),
    ...hazards.map((z) => ({ ax: z.x, ay: z.y, bx: z.x + 0.1, by: z.y, r: z.r })),
    ...seaShips().map(hullSegment)
  ].map(galleyKeepOff);
}

// The water round a galley lying at `pose`: the gap from her hull to the nearest of them.
function galleyRoom(obstacles, pose) {
  const hull = hullSegment({ x: pose.x, y: pose.y, angle: pose.angle, category: "Galley", maxHull: 0 });
  const halfLength = BUMP_SHAPE.Galley.h + hull.r;
  let room = GALLEY_CLEAR + GALLEY_ROOM; // further off makes no difference
  for (const p of obstacles) {
    const far = room + p.reach + halfLength;
    if ((pose.x - p.mx) ** 2 + (pose.y - p.my) ** 2 >= far * far) continue;
    const c = closestOnSegments(hull, p);
    room = Math.min(room, Math.hypot(c.px - c.qx, c.py - c.qy) - hull.r - p.r);
  }
  return room;
}

// A course she can really row from `from` to `goal` (any heading if it has no
// angle): straight runs and wide turns, turning on her oars only if `pivot`,
// and clear of everything (an A* search over where she is and how she heads).
// Returns the poses after `from`, or null if there is no way.
function planGalley(h, from, goal, pivot) {
  const obstacles = galleyObstacles(h);
  const moves = [[0, GALLEY_RUN], [-1, GALLEY_RUN], [1, GALLEY_RUN]];
  if (pivot) moves.push([-1, 0], [1, 0]);
  const queue = []; // positions to try, in buckets by estimated course length
  const reached = new Map();
  let head = 0;
  const add = (node) => {
    const turns = ((Math.round(node.angle / GALLEY_TURN) % 24) + 24) % 24;
    const key = `${Math.round(node.x / 14)},${Math.round(node.y / 14)},${turns}`;
    if (reached.get(key) <= node.cost) return;
    reached.set(key, node.cost);
    const swing = goal.angle === undefined ? 0 : (Math.abs(normalizeAngle(goal.angle - node.angle)) * GALLEY_RUN) / GALLEY_TURN; // rowing it takes to come round
    const rank = Math.floor((node.cost + 2 * Math.max(dist(node, goal), swing)) / 8); // leans towards the goal: quicker to find
    (queue[rank] || (queue[rank] = [])).push(node);
    head = Math.min(head, rank);
  };
  add({ x: from.x, y: from.y, angle: from.angle, turn: 0, cost: 0, room: galleyRoom(obstacles, from), prev: null });
  for (let tried = 0; tried < GALLEY_SEARCH && head < queue.length; ) {
    const node = queue[head] && queue[head].pop();
    if (!node) {
      head++;
      continue;
    }
    tried++;
    const facing = goal.angle === undefined || Math.abs(normalizeAngle(goal.angle - node.angle)) <= GALLEY_TURN * 2.01;
    if (facing && dist(node, goal) < 16) {
      const path = [{ x: goal.x, y: goal.y, angle: goal.angle === undefined ? node.angle : goal.angle }];
      for (let p = node; p.prev; p = p.prev) path.unshift(p);
      return path;
    }
    for (const [turn, run] of moves) {
      const mid = node.angle + (turn * GALLEY_TURN) / 2;
      const next = { x: node.x + Math.cos(mid) * run, y: node.y + Math.sin(mid) * run, angle: node.angle + turn * GALLEY_TURN, turn, prev: node };
      next.room = galleyRoom(obstacles, next);
      if (next.room < GALLEY_CLEAR && next.room <= node.room) continue; // only ever away from a tight spot
      const length = run ? run * (turn ? 1.12 : 1) : 2 * GALLEY_PIVOT;
      const wriggle = turn === node.turn ? 0 : 4; // one sweeping turn, not a weaving course
      next.cost = node.cost + wriggle + length * (1 + (2 * (GALLEY_CLEAR + GALLEY_ROOM - Math.max(next.room, GALLEY_CLEAR))) / GALLEY_ROOM);
      add(next);
    }
  }
  return null;
}

// Plots the galley's course through `goals` in turn. False if there is no clear way.
function plotGalley(g, goals, pivot) {
  const course = [{ x: g.boat.x, y: g.boat.y, angle: g.boat.angle }];
  for (const goal of goals) {
    const from = course[course.length - 1];
    const leg = planGalley(g.h, from, goal, pivot) || (!pivot && planGalley(g.h, from, goal, true));
    if (!leg) return false;
    course.push(...leg);
  }
  Object.assign(g, { course, goals, leg: 0, along: 0 });
  return true;
}

// The course to lie just ahead of the carrack, stern to her, ready to pass the
// rope: towards her first mark, or as near that line as there is water for.
function seekCarrack(g) {
  const { target, boat } = g;
  g.sought = { x: target.x, y: target.y };
  const gap = shipHalfLength(target) + shipHalfLength(boat) + TOW_SLACK;
  const want = Math.atan2(g.legs[0].y - target.y, g.legs[0].x - target.x);
  const obstacles = galleyObstacles(g.h);
  for (let k = 0, tries = 0; k <= 24 && tries < 3; k++) {
    const angle = want + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * GALLEY_TURN;
    const pose = { x: target.x + Math.cos(angle) * gap, y: target.y + Math.sin(angle) * gap, angle };
    if (galleyRoom(obstacles, pose) < GALLEY_CLEAR + 4) continue;
    if (plotGalley(g, [pose], true)) return true;
    tries++;
  }
  return false;
}

function sendGalleyHome(g) {
  g.phase = "home";
  g.boat.tow = null;
  if (!plotGalley(g, [g.station], true)) game.galley = null;
}

// One step along the plotted course: she gathers way slowly and eases down for
// the end. True when she is there.
function rowGalley(g, dt) {
  const { boat, course } = g;
  // A step takes its distance to row, or longer if the turn in it is sharp (slowest turning on her oars).
  const length = (i) => {
    const run = dist(course[i], course[i + 1]);
    const turns = Math.abs(normalizeAngle(course[i + 1].angle - course[i].angle)) / GALLEY_TURN;
    return Math.max(0.01, run, turns * (run < 1 ? GALLEY_PIVOT : 0.8 * GALLEY_RUN));
  };
  let left = -g.along;
  for (let i = g.leg; i < course.length - 1; i++) left += length(i);
  const gather = g.phase === "tow" ? 3 : 6; // units/s each second: heavier with a great ship astern
  g.way = Math.min(GALLEY_SPEED[g.phase], g.way + gather * dt, Math.sqrt(2 * GALLEY_CHECK * Math.max(0, left)) + 3);
  let leg = g.leg;
  let along = g.along + g.way * dt;
  while (leg < course.length - 1 && along >= length(leg)) {
    along -= length(leg);
    leg++;
  }
  const there = leg >= course.length - 1;
  const a = course[leg];
  const b = there ? a : course[leg + 1];
  const k = there ? 0 : along / length(leg);
  const pose = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, angle: a.angle + normalizeAngle(b.angle - a.angle) * k };
  // Never into a ship that has got in the way: stop, and if it stays there, go round.
  const ships = seaShips().map(hullSegment).map(galleyKeepOff);
  const room = galleyRoom(ships, pose);
  if (room < GALLEY_SHIP_GAP && room < galleyRoom(ships, boat)) {
    g.way = 0;
    boat.speed = 0;
    g.blocked += dt;
    if (g.blocked > 3) {
      g.blocked = 0;
      plotGalley(g, g.goals.slice(-1), true);
    }
    return false;
  }
  g.blocked = 0;
  g.leg = leg;
  g.along = along;
  Object.assign(boat, pose);
  boat.speed = there ? 0 : g.way;
  return there;
}

// The carrack getting clear of Harbour A, and a player's galley bringing her in at B.
function updateCarracks() {
  for (const ship of humanShips()) {
    if (ship.category !== "Carrack" || ship.capsized) continue;
    const tug = humanShips().find((s) => s.tow === ship);
    if (!ship.leftA && !carrackPort(ship)) {
      ship.leftA = true;
      if (tug) setUiMessage(`${shipLabel(ship)} is clear of the harbour - ${TOW_KEY_NAMES[tug.playerSlot]} to cast off`, tug.playerSlot);
    }
    const { a, b } = inHarbourTerms(HarbourB, ship);
    if (tug && !ship.anchored && a < PORT_BERTHED && b < PORT_BERTHED) {
      tug.tow = null;
      dropAnchor(ship); // warped the last stretch to her berth
    }
  }
}

function updateGalley(dt) {
  updateCarracks();
  const g = game.galley;
  if (!g || g.phase === "rest") return;
  const { boat, target } = g;
  // A player's galley got there first, or she sank or anchored: this one goes home.
  if (g.phase !== "home" && (target.capsized || target.anchored || humanShips().some((s) => s.tow === target))) {
    sendGalleyHome(g);
    return;
  }
  if (g.phase === "meet") {
    if (dist(target, g.sought) > 20) seekCarrack(g); // she has drifted: row for where she is now
    if (rowGalley(g, dt)) {
      g.phase = "rope";
      g.wait = GALLEY_ROPE_TIME;
    }
  } else if (g.phase === "rope") {
    g.wait -= dt;
    if (g.wait > 0) return;
    g.phase = "tow";
    g.way = 0;
    boat.tow = target;
    boat.towLength = dist(boat, target);
    if (plotGalley(g, g.legs, false)) setUiMessage(`The galley has ${shipLabel(target)} in tow`, target.playerSlot);
    else sendGalleyHome(g);
  } else if (g.phase === "tow") {
    const there = rowGalley(g, dt);
    const d = dist(boat, target) || 1;
    const stretch = d - boat.towLength;
    boat.towTaut = stretch > 0;
    if (stretch > 0) {
      const ux = (boat.x - target.x) / d;
      const uy = (boat.y - target.y) / d;
      target.x += ux * stretch;
      target.y += uy * stretch;
      const swing = normalizeAngle(Math.atan2(uy, ux) - target.angle);
      target.angle += clamp(swing, -GALLEY_TOW_TURN * dt, GALLEY_TOW_TURN * dt);
    }
    const { a, b } = inHarbourTerms(g.h, target);
    const done = g.inbound ? a < PORT_BERTHED && b < PORT_BERTHED : !carrackPort(target);
    if (done) {
      if (g.inbound) dropAnchor(target); // warped the last stretch to her berth
      else {
        target.leftA = true; // free from this moment: a gust must not put her back in port before she is next checked
        setUiMessage(`${shipLabel(target)} is clear of the harbour - the galley casts off. Fair winds!`, target.playerSlot);
      }
    }
    if (done || there) sendGalleyHome(g);
  } else if (rowGalley(g, dt)) {
    g.phase = "rest"; // lies at her station until she is called again
  }
}

// What a carrack captain in port should do next, in that player's half.
function drawTowPrompts() {
  if (gameState !== "playing") return;
  const split = view3d.active && view3d.split;
  for (const ship of humanShips()) {
    const h = carrackPort(ship);
    if (!h || ship.capsized || ship.anchored || ship.ropes > 0) continue;
    const p2 = ship.playerSlot === "p2";
    const cx = split ? (p2 ? (WIDTH * 3) / 4 : WIDTH / 4) : WIDTH / 2;
    const cy = HEIGHT - 150 - (!split && p2 ? 70 : 0);
    const w = split ? WIDTH / 2 - 60 : 620;
    const way = h === HarbourB ? "in" : "out";
    const friend = playerGalleyAtHand(ship);
    const towed = underTow(ship);
    const coming = !!game.galley && game.galley.target === ship && ["meet", "rope"].includes(game.galley.phase);
    const title = towed ? `UNDER TOW - THE GALLEY IS PULLING YOU ${way.toUpperCase()}`
      : coming ? "THE GALLEY IS ROWING OUT TO YOU"
      : `IN PORT THE CARRACK CANNOT SAIL - SHE MUST BE TOWED ${way.toUpperCase()}`;
    const how = towed ? "Her sails fill again once she is clear of the harbour"
      : coming ? "Stand by to take the tow rope"
      : friend ? `${shipLabel(friend)}: row close and press ${TOW_KEY_NAMES[friend.playerSlot]} to pass the rope`
      : TOUCH_UI ? "Tap Tow to call the Order's galley" : `Press ${TOW_KEY_NAMES[ship.playerSlot]} to call the Order's galley`;
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(74, 20, 22, 0.86)";
    ctx.fillRect(cx - w / 2, cy - 32, w, 64);
    ctx.strokeStyle = "rgba(255, 214, 170, 0.85)";
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - w / 2, cy - 32, w, 64);
    ctx.fillStyle = "#fff0e0";
    ctx.font = "bold 18px Segoe UI";
    ctx.fillText(title, cx, cy - 6);
    ctx.font = "15px Segoe UI";
    ctx.fillStyle = "#ffd9a8";
    ctx.fillText(how, cx, cy + 20);
    ctx.restore();
  }
}

// ---- The carrack under sail -------------------------------------------------
// Clear of the harbour she goes only as the wind will drive her. Her square
// sails give nothing closer than about six points to the wind (they are taken
// aback), most with the wind on the quarter, and little in light airs. The
// forward key sets the sails; the captain is warned when the wind won't serve.
const CARRACK_NO_WIND = 5; // wind (units) that no longer fills her sails
const CARRACK_LIGHT_WIND = 13; // below this (about 8 knots) there isn't wind enough
const CARRACK_FULL_WIND = 18; // and from here (about 11 knots) she has all she needs
const CARRACK_CLOSEST = 65; // degrees off the wind: nearer than this she is aback
const CARRACK_GHOSTING = 0.1; // the least drive: she still creeps, so no calm traps her

function carrackWind(ship) {
  const speed = Math.hypot(game.wind.x, game.wind.y);
  const rel = normalizeAngle(Math.atan2(-game.wind.y, -game.wind.x) - ship.angle); // where it comes from, + to starboard
  const off = Math.abs((rel * 180) / Math.PI);
  const strength = clamp((speed - CARRACK_NO_WIND) / (CARRACK_FULL_WIND - CARRACK_NO_WIND), 0, 1);
  const point = off < CARRACK_CLOSEST ? 0
    : off < 90 ? 0.35 + (0.4 * (off - CARRACK_CLOSEST)) / (90 - CARRACK_CLOSEST)
    : off < 135 ? 0.75 + (0.25 * (off - 90)) / 45
    : 1 - (0.1 * (off - 135)) / 45;
  return {
    power: Math.max(CARRACK_GHOSTING, strength * point),
    light: speed < CARRACK_LIGHT_WIND,
    aback: off < CARRACK_CLOSEST,
    bearAway: rel > 0 ? "port" : "starboard",
    knots: speed * WIND_KNOTS_PER_UNIT
  };
}

// The warning across that player's half while the wind won't serve her.
function drawWindAlerts() {
  if (gameState !== "playing") return;
  const split = view3d.active && view3d.split;
  for (const ship of humanShips()) {
    if (ship.category !== "Carrack" || ship.capsized || ship.anchored || ship.ropes > 0 || carrackPort(ship) || underTow(ship)) continue;
    const wind = carrackWind(ship);
    if (!wind.light && !wind.aback) continue;
    const p2 = ship.playerSlot === "p2";
    const cx = split ? (p2 ? (WIDTH * 3) / 4 : WIDTH / 4) : WIDTH / 2;
    const cy = HEIGHT - 150 - (!split && p2 ? 70 : 0);
    const w = split ? WIDTH / 2 - 60 : 620;
    const turn = ship.playerSlot + (wind.bearAway === "port" ? "Left" : "Right");
    const key = TOUCH_UI ? "" : ` (${keyName(game.settings.keybinds[turn])})`;
    const title = wind.light ? `NOT ENOUGH WIND - ${wind.knots.toFixed(0)} KNOTS` : "TOO CLOSE TO THE WIND - HER SAILS ARE ABACK";
    const how = wind.aback ? `Bear away to ${wind.bearAway}${key} until the sails fill`
      : "She will make little way: keep the wind astern until it freshens";
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(92, 62, 8, 0.86)";
    ctx.fillRect(cx - w / 2, cy - 32, w, 64);
    ctx.strokeStyle = `rgba(255, 214, 120, ${0.65 + 0.35 * Math.sin(performance.now() / 230)})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - w / 2, cy - 32, w, 64);
    ctx.fillStyle = "#fff4d8";
    ctx.font = "bold 18px Segoe UI";
    ctx.fillText(title, cx, cy - 6);
    ctx.font = "15px Segoe UI";
    ctx.fillStyle = "#ffe2a8";
    ctx.fillText(how, cx, cy + 20);
    ctx.restore();
  }
}

// Ships on the sea this round (players, the pirate hunter, raiders).
function seaShips() {
  return [game.player1, game.player2, game.ai, ...game.pirateRaiders].filter(Boolean);
}
const SHOP_ITEMS = [
  { id: "sonicWeapon", name: "Sonic Weapon", cost: 140, desc: "Fires a fast sonic pulse: longer range and faster reload than the cannon." },
  { id: "waterCannon", name: "Water Cannon", cost: 120, desc: "Reduces continuous hazard damage." },
  { id: "missileLauncher", name: "Advanced Missile Launcher", cost: 340, desc: "Auto-tracks nearby threats with kill missiles." },
  { id: "reinforcedHull", name: "Reinforced Hull", cost: 170, desc: "Extra hull points when you set sail." },
  { id: "windKeel", name: "Wind Stabilizer Keel", cost: 130, desc: "Reduces wind drift effects." },
  { id: "turboProp", name: "Turbo Propeller", cost: 160, desc: "Higher top speed and acceleration." },
  { id: "fireFighting", name: "Fire Fighting Equipment", cost: 180, desc: "Put out a ship fire from volcano rocks at once (P1: F, P2: .)." },
  { id: "acousticDeterrent", name: "Acoustic Deterrent", cost: 150, desc: "Blasts a painful high-pitched tone at nearby pirates (P1: G, P2: ;). Each pirate decides: break off or press ahead." },
  { id: "chartPlotter", name: "Chart Plotter", cost: 190, desc: "Crew equipment: your Navigating Officer keeps your track, and marks the way in once Harbour B is sighted." },
  { id: "radar", name: "Surface Radar", cost: 210, desc: "Crew equipment: your Lookout sees further and marks sea monsters and submarines on the map." },
  { id: "weatherStation", name: "Weather Station", cost: 160, desc: "Crew equipment: your Navigating Officer forecasts storms, whirlpools and the tsunami heading." },
  { id: "leviathanDecoy", name: "Leviathan Decoy Drones", cost: 420, desc: "Distracts sea creatures for short bursts.", premiumPack: "specialistArsenal" },
  { id: "tempestScrambler", name: "Tempest Scrambler", cost: 390, desc: "Steadies your ship in storm seas: the waves push it about half as much.", premiumPack: "specialistArsenal" }
];

function createDefaultProfiles() {
  const defaultOwnedShips = {};
  for (const ship of SHIP_CATALOG) {
    if (ship.defaultOwned) {
      defaultOwnedShips[ship.id] = true;
    }
  }

  return {
    slots: {
      p1: { name: "Captain Azure", points: 0, owned: {}, ownedShips: { ...defaultOwnedShips }, selectedShip: "cruiseLiner", shopSpent: 0, shopEarned: 0 },
      p2: { name: "Captain Gold", points: 0, owned: {}, ownedShips: { ...defaultOwnedShips }, selectedShip: "cargoFreighter", shopSpent: 0, shopEarned: 0 }
    },
    leaderboard: {}
  };
}

function createDefaultSettings() {
  return {
    keybinds: { ...DEFAULT_KEYBINDS },
    gameplayPreset: "classic",
    windScale: 1,
    hazardScale: 1,
    cameraView: "overview",
    graphicsMode: "auto",
    soundLevel: 2,
    nightMode: false
  };
}

const game = {
  player1: null,
  player2: null,
  ai: null,
  elapsed: 0,
  aiDirector: null,
  pirateRaiders: [],
  seaCreatures: [],
  missiles: [],
  nextRaiderSpawnAt: 8,
  nextCreatureSpawnAt: 7,
  wind: { x: 0, y: 0 },
  windDir: Math.random() * Math.PI * 2,
  windBase: 20,
  floatingScores: [],
  profiles: createDefaultProfiles(),
  roundCommitted: false,
  gamePoints: { p1: 0, p2: 0 },
  harbourShip: null, // player 1's last used ship, moored in the harbour behind the menus
  shopIndex: 0,
  dock: null, // the dockyard (gameState "shop"): { start, hideUi }
  shopIndexBySlot: { p1: 0, p2: 0 },
  shopSlot: "p1",
  menuIndex: 0,
  endedIndex: 1,
  shipSelectSlot: "p1",
  shipSelections: { p1: "cruiseLiner", p2: "cargoFreighter" },
  underwaterEnemies: [],
  nextUnderwaterSpawnAt: 11,
  volcanoRocks: [], // rocks thrown by an eruption, in flight
  lavaPools: [], // lava spreading on the sea around an erupting volcano
  iceSheets: [], // pack ice (makeIceSheet)
  polar: false, // a polar run: someone sails the icebreaker (isPolarRun)
  targetAlerts: [],
  jetBursts: [], // warning bursts and crashes: splashes on the sea
  jetTracers: [], // gunfire between jets and pirates
  uiRects: [],
  audioContext: null,
  audioEnabled: false,
  uiMessage: "",
  uiMessageSlot: "",
  uiMessageTtl: 0,
  settings: createDefaultSettings(),
  keyRebindAction: null,
  // Premium packs this player may use right now: filled from Store purchases
  // (and, in development builds only, the test unlock). Never saved.
  entitlements: { specialistArsenal: false, specialistFleet: false },
  premiumPackId: null,
  // Esc while sailing: the game pauses behind a "leave this voyage?" popup.
  tugOffer: null, // null, or { kind: "pull" | "change", slot, choice: 0 = yes, 1 = no }: a yes / no popup for a tug captain
  tugOfferPending: false, // look for a pull offer once play starts
  galley: null, // the computer's galley while it tows a carrack: { boat, target, phase, path, home, inbound }
  midGameChange: null, // slot choosing another ship in the middle of a voyage
  exitConfirm: null, // null, or { choice: 0 = return to menu, 1 = keep sailing }
  premiumReturnTo: "menu"
};

function loadProfiles() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultProfiles();
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.slots || !parsed.slots.p1 || !parsed.slots.p2) {
      return createDefaultProfiles();
    }
    parsed.leaderboard = parsed.leaderboard || {};
    parsed.slots.p1.owned = parsed.slots.p1.owned || {};
    parsed.slots.p2.owned = parsed.slots.p2.owned || {};
    parsed.slots.p1.ownedShips = parsed.slots.p1.ownedShips || {};
    parsed.slots.p2.ownedShips = parsed.slots.p2.ownedShips || {};
    parsed.slots.p1.points = parsed.slots.p1.points || 0;
    parsed.slots.p2.points = parsed.slots.p2.points || 0;
    parsed.slots.p1.shopSpent = parsed.slots.p1.shopSpent || 0;
    parsed.slots.p1.shopEarned = parsed.slots.p1.shopEarned || 0;
    parsed.slots.p2.shopSpent = parsed.slots.p2.shopSpent || 0;
    parsed.slots.p2.shopEarned = parsed.slots.p2.shopEarned || 0;
    parsed.slots.p1.selectedShip = parsed.slots.p1.selectedShip || "cruiseLiner";
    parsed.slots.p2.selectedShip = parsed.slots.p2.selectedShip || "cargoFreighter";
    for (const ship of SHIP_CATALOG) {
      if (ship.defaultOwned) {
        parsed.slots.p1.ownedShips[ship.id] = true;
        parsed.slots.p2.ownedShips[ship.id] = true;
      }
    }
    // Premium ownership is never trusted from local storage (it could be
    // edited); it is rebuilt from the Microsoft Store on every start.
    delete parsed.entitlements;
    return parsed;
  } catch {
    return createDefaultProfiles();
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return createDefaultSettings();
    const parsed = JSON.parse(raw);
    const defaults = createDefaultSettings();
    const keybinds = { ...defaults.keybinds, ...(parsed.keybinds || {}) };
    // A key added since these settings were saved takes its default only if nothing else already uses it.
    for (const action of Object.keys(defaults.keybinds)) {
      const saved = parsed.keybinds || {};
      if (saved[action] !== undefined) continue;
      const taken = Object.entries(saved).some(([other, code]) => other !== action && code === defaults.keybinds[action]);
      if (taken) keybinds[action] = "";
    }
    const gameplayPreset = GAMEPLAY_PRESETS.includes(parsed.gameplayPreset) ? parsed.gameplayPreset : defaults.gameplayPreset;
    const windScale = clamp(Number(parsed.windScale) || defaults.windScale, 0.6, 1.6);
    const hazardScale = clamp(Number(parsed.hazardScale) || defaults.hazardScale, 0.6, 1.6);
    const cameraView = CAMERA_VIEWS.includes(parsed.cameraView) ? parsed.cameraView : defaults.cameraView;
    const graphicsMode = GRAPHICS_MODES.includes(parsed.graphicsMode) ? parsed.graphicsMode : defaults.graphicsMode;
    const soundLevel = [0, 1, 2, 3].includes(parsed.soundLevel) ? parsed.soundLevel : defaults.soundLevel;
    const nightMode = parsed.nightMode === true;
    return { keybinds, gameplayPreset, windScale, hazardScale, cameraView, graphicsMode, soundLevel, nightMode };
  } catch {
    return createDefaultSettings();
  }
}

function graphicsModeLabel() {
  if (!view3d.available) return "Classic 2D (3D not available in this browser)";
  if (game.settings.graphicsMode === "2d") return "Classic 2D map";
  if (game.settings.graphicsMode === "advanced") return `3D Advanced (now ${view3d.quality || "Extreme"}, dedicated graphics card)`;
  return `3D Automatic (now ${view3d.quality || "High"})`;
}

function cycleGraphicsMode() {
  if (!view3d.available) {
    setUiMessage("3D isn't available in this browser, so the classic 2D map is used.");
    return;
  }
  let next = GRAPHICS_MODES[(GRAPHICS_MODES.indexOf(game.settings.graphicsMode) + 1) % GRAPHICS_MODES.length];
  if (next === "advanced" && !view3d.advancedCapable) {
    setUiMessage(`Advanced needs a dedicated graphics card; this browser is using ${view3d.gpu}. Skipped.`);
    next = "2d";
  }
  game.settings.graphicsMode = next;
  saveSettings();
  view3d.setGraphicsMode(next);
}

function toggleCameraView() {
  if (!view3d.active) {
    setUiMessage("Camera views need the 3D view, which isn't available in this browser.");
    return;
  }
  // C cycles: overview (from above) -> chase (behind the ship) -> bridge (on board).
  game.settings.cameraView = CAMERA_VIEWS[(CAMERA_VIEWS.indexOf(game.settings.cameraView) + 1) % CAMERA_VIEWS.length];
  saveSettings();
  resetBridgeLook();
  viewOrbit.yaw = 0;
  viewOrbit.pitch = 0;
  const note = game.settings.cameraView !== "overview" && mode === "local" ? " (split screen: P1 left, P2 right)" : "";
  const lookHow = TOUCH_UI ? "drag a finger across the sea" : "hold right mouse button and drag";
  const tip = game.settings.cameraView === "bridge" ? ` - ${lookHow} to look around` : TOUCH_UI ? " - pinch to zoom" : "";
  setUiMessage(`Camera: ${CAMERA_VIEW_NAMES[game.settings.cameraView]}${note}${tip}`);
}

// Night: moonlit sea, glowing lava, ships show navigation lights and the
// pirate a candle lamp in its stern cabin. Looks only; gameplay is the same.
function toggleNightMode() {
  game.settings.nightMode = !game.settings.nightMode;
  saveSettings();
  setUiMessage(`Time of day: ${game.settings.nightMode ? "Night" : "Day"}`);
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(game.settings));
}

const KEY_SYMBOLS = { Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`", ShiftRight: "R-Shift", ShiftLeft: "L-Shift", ControlRight: "R-Ctrl", ControlLeft: "L-Ctrl" };
function keyName(code) {
  if (!code) return "Unbound";
  if (KEY_SYMBOLS[code]) return KEY_SYMBOLS[code];
  if (code === "Space") return "Space";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

function isActionPressed(action) {
  const code = game.settings.keybinds[action];
  return !!code && keys.has(code);
}

function saveProfiles() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(game.profiles));
}

function getProfile(slot) {
  return game.profiles.slots[slot];
}

function getShipDefinition(id) {
  if (id === ORDER_GALLEY.id) return ORDER_GALLEY;
  return SHIP_CATALOG.find((ship) => ship.id === id) || SHIP_CATALOG[0];
}

// 2-player with player 1 in the carrack: player 2 rows the galley.
function secondRowsGalley(firstShipId) {
  return mode === "local" && getShipDefinition(firstShipId).category === "Carrack";
}

function isShipOwned(profile, shipDef) {
  if (shipDef.defaultOwned) return true;
  if (shipDef.premiumPack) {
    return !!game.entitlements[shipDef.premiumPack];
  }
  return !!profile.ownedShips[shipDef.id];
}

// The ship a player may actually use: their pick if it is owned, else the free starter.
// A premium ship is only ever owned through its pack, so a stale pick (pack not bought,
// store not confirmed, dev unlock switched off) never reaches the dock or a round.
function usableShipId(slot) {
  const profile = getProfile(slot);
  const def = getShipDefinition(profile.selectedShip);
  if (isShipOwned(profile, def)) return def.id;
  return slot === "p2" ? "cargoFreighter" : "cruiseLiner";
}

function getShopEntries() {
  const gadgetEntries = SHOP_ITEMS.map((item) => ({ kind: "gadget", ...item }));
  const shipEntries = SHIP_CATALOG.map((ship) => ({ kind: "ship", ...ship }));
  return [...gadgetEntries, ...shipEntries];
}

function applyShipDefinition(ship, shipDef) {
  ship.shipId = shipDef.id;
  ship.shipName = shipDef.name;
  ship.category = shipDef.category;
  ship.displayColor = shipDef.color;
  ship.maxSpeed = shipDef.stats.maxSpeed;
  ship.accel = shipDef.stats.accel;
  ship.hp = shipDef.stats.hp;
  ship.maxHull = shipDef.stats.hp;
  ship.turnRate = shipDef.stats.turnRate;
  ship.windResistance = shipDef.stats.windResistance || 0;
  ship.attackRangeBonus = shipDef.stats.attackRangeBonus || 0;
}

function openShipSelect() {
  game.profiles = loadProfiles();
  game.shipSelections = {
    p1: usableShipId("p1"),
    p2: usableShipId("p2")
  };
  game.shipSelectSlot = "p1";
  gameState = "shipSelect";
}

function cycleShipSelection(delta) {
  const slot = game.shipSelectSlot;
  const current = game.shipSelections[slot];
  const currentIndex = SHIP_CATALOG.findIndex((ship) => ship.id === current);
  const nextIndex = (currentIndex + delta + SHIP_CATALOG.length) % SHIP_CATALOG.length;
  game.shipSelections[slot] = SHIP_CATALOG[nextIndex].id;
}

// 2-player: confirming player 1's ship moves on to player 2's pick; the round
// starts once player 2 confirms.
function confirmShipSelectionAndStart() {
  if (game.midGameChange) {
    confirmShipChange();
    return;
  }
  const galley = secondRowsGalley(game.shipSelections.p1); // no ship to pick for player 2
  const p2Next = mode === "local" && game.shipSelectSlot === "p1" && !galley;
  const slots = mode === "local" && !p2Next && !galley ? ["p1", "p2"] : ["p1"];
  for (const slot of slots) {
    const profile = getProfile(slot);
    const shipDef = getShipDefinition(game.shipSelections[slot]);
    if (!isShipOwned(profile, shipDef)) {
      if (shipDef.premiumPack && !game.entitlements[shipDef.premiumPack]) {
        openPremiumScreen(shipDef.premiumPack);
        return;
      }
      setUiMessage(`${profile.name} has not unlocked ${shipDef.name}`);
      return;
    }
  }
  // Every post must be filled before the ship leaves harbour.
  for (const slot of slots) {
    if (crewRequired(slot, game.shipSelections[slot])) return;
  }
  if (p2Next) {
    game.shipSelectSlot = "p2";
    return;
  }

  for (const slot of slots) {
    getProfile(slot).selectedShip = game.shipSelections[slot];
  }
  saveProfiles();
  resetGame();
}

// The screens that have the harbour behind them: the main menu and what opens
// from it (not the ship choice in the middle of a voyage).
const HARBOUR_SCREENS = ["menu", "voyage", "missions", "settings", "leaderboard", "shipSelect", "premium", "crew"];

function inHarbour() {
  return HARBOUR_SCREENS.includes(gameState) && !game.midGameChange;
}

// Clears the finished voyage away, so the harbour is calm and empty.
function leaveRound() {
  game.mission = null;
  game.missionState = null;
  game.player1 = game.player2 = game.ai = null;
  game.galley = null;
  hazards.length = 0;
  dynamicDangers.length = 0;
  game.pirateRaiders = [];
  game.seaCreatures = [];
  game.underwaterEnemies = [];
  game.missiles = [];
  game.volcanoRocks = [];
  game.lavaPools = [];
  game.iceSheets = [];
  game.jetBursts = [];
  game.jetTracers = [];
  game.floatingScores = [];
  game.cannonCinematic = null;
  fogBanks = [];
  waterSpout.state = "dormant";
  resetTempest();
  resetTsunami();
  resetWhirlpool();
  game.wind = { x: 14, y: -8 }; // a light breeze for the flags
  resetSea();
  stopLookout();
}

// Each frame: on the harbour screens, player 1's last used ship lies moored at
// Harbour A. (It is kept while in the dockyard, which has its own scene.)
function updateHarbourScene() {
  if (!inHarbour()) {
    if (gameState !== "shop") game.harbourShip = null;
    return;
  }
  if (game.player1) leaveRound();
  const shipDef = getShipDefinition(usableShipId("p1"));
  game.polar = shipDef.category === "Icebreaker"; // snow on the harbour
  if (game.harbourShip && game.harbourShip.shipId === shipDef.id) return;
  const ship = newShip("cruise", HarbourA.x, HarbourA.y, 0);
  applyShipDefinition(ship, shipDef);
  ship.anchored = true;
  mooredAtBerth(ship, HarbourA, 0);
  game.harbourShip = ship;
}

// The Hospitaller carrack takes both harbours back to the 16th century.
function oldEra() {
  const ships = game.harbourShip ? [game.harbourShip] : humanShips();
  return ships.some((s) => s.category === "Carrack");
}

// The 3D harbours are changing age behind their "please wait" screen
// (render3d.js sets view3d.eraChange): the game holds still meanwhile.
function eraLoading() {
  return view3d.active && !!view3d.eraChange && gameState !== "shop";
}

function humanShips() {
  const ships = [game.player1];
  if (mode === "local") ships.push(game.player2);
  return ships.filter((s) => !!s);
}

function allCombatShips() {
  return [game.player1, game.player2, game.ai, ...game.pirateRaiders].filter((s) => !!s && !s.capsized);
}

function applyGadgets(ship, profile, slot) {
  ship.isHuman = true;
  ship.playerSlot = slot;
  ship.playerName = profile.name;
  ship.owned = {};
  for (const [id, has] of Object.entries(profile.owned || {})) {
    const item = SHOP_ITEMS.find((it) => it.id === id);
    if (has && (!item || !item.premiumPack || game.entitlements[item.premiumPack])) ship.owned[id] = true;
  }
  ship.runScore = 0;
  ship.scoreTick = 0;
  ship.nextDockAwardAt = 0;
  ship.windResistance += ship.owned.windKeel ? 0.45 : 0;
  ship.damageReduction += ship.owned.waterCannon ? 0.24 : 0;
  ship.attackRangeBonus += ship.owned.sonicWeapon ? 22 : 0;
  ship.autoMissile = !!ship.owned.missileLauncher;
  ship.missileCooldown = 3.8;
  if (ship.owned.reinforcedHull) {
    ship.maxHull += 30;
    ship.hp += 30;
  }
  if (ship.owned.turboProp) {
    ship.maxSpeed += 28;
    ship.accel += 22;
  }
}

// slot "p2" puts the message in player 2's half when the screen is split.
function setUiMessage(text, slot) {
  game.uiMessage = text;
  game.uiMessageSlot = slot || "";
  game.uiMessageTtl = 2.5;
}

function clearUiRects() {
  game.uiRects = [];
}

function registerUiRect(x, y, w, h, onClick) {
  game.uiRects.push({ x, y, w, h, onClick });
}

// On touch screens a tap just beside a button counts too: the nearest one
// within TOUCH_SLACK.
const TOUCH_SLACK = 14;
function hitUiRect(x, y) {
  let near = null;
  let nearest = TOUCH_UI ? TOUCH_SLACK : 0;
  for (let i = game.uiRects.length - 1; i >= 0; i -= 1) {
    const rect = game.uiRects[i];
    const gap = Math.hypot(Math.max(rect.x - x, 0, x - rect.x - rect.w), Math.max(rect.y - y, 0, y - rect.y - rect.h));
    if (gap === 0) return rect;
    if (gap < nearest) {
      near = rect;
      nearest = gap;
    }
  }
  return near;
}

// Creates the sound system on first use; every later call wakes it up again if
// it was suspended. Nothing happens until the intro has loaded, so clicks or
// keys on the intro don't bring the ambience in early. updateLoadingScreen
// calls it at that point; where the browser holds sound back, the next click
// or key press wakes it.
function ensureAudio() {
  if (!introReady) return false;
  if (!game.audioContext) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;
    game.audioContext = new AudioCtx();
    setupSound(game.audioContext);
    // The intro starts the moment sound is allowed.
    game.audioContext.addEventListener("statechange", playIntro);
  }
  if (game.audioContext.state === "suspended") {
    game.audioContext.resume().catch(() => {});
  }
  game.audioEnabled = true;
  return true;
}

function playAlertTone(freq = 740, duration = 0.12, gainValue = 0.045, type = "square") {
  if (!ensureAudio()) return;
  const ctxAudio = game.audioContext;
  const osc = ctxAudio.createOscillator();
  const gain = ctxAudio.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.value = 0.0001;
  osc.connect(gain);
  gain.connect(sfx.out);
  const now = ctxAudio.currentTime;
  gain.gain.exponentialRampToValueAtTime(gainValue, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.start(now);
  osc.stop(now + duration + 0.03);
}

function playLockWarning() {
  playAlertTone(820, 0.09, 0.03, "square");
  window.setTimeout(() => playAlertTone(620, 0.1, 0.025, "triangle"), 90);
}

function playPurchaseTone() {
  playAlertTone(520, 0.09, 0.03, "triangle");
  window.setTimeout(() => playAlertTone(760, 0.12, 0.028, "sine"), 100);
}

function addTargetAlert(ship, source, label = "TARGET LOCK") {
  if (!ship || ship.capsized || !ship.isHuman) return;
  const existing = game.targetAlerts.find((alert) => alert.ship === ship && alert.label === label);
  if (existing) {
    existing.ttl = Math.max(existing.ttl, 0.9);
    return;
  }
  game.targetAlerts.push({ ship, source, label, ttl: 0.9, pulse: Math.random() * Math.PI * 2 });
  playLockWarning();
}

function updateTargetAlerts(dt) {
  for (let i = game.targetAlerts.length - 1; i >= 0; i -= 1) {
    const alert = game.targetAlerts[i];
    alert.ttl -= dt;
    alert.pulse += dt * 8;
    if (alert.ttl <= 0 || !alert.ship || alert.ship.capsized) {
      game.targetAlerts.splice(i, 1);
    }
  }
}

// Lookout: when a danger comes within range of a captain's ship, an alarm
// sounds and a voice calls it out, e.g. "Captain, sea monster on your left!".
// Each danger is called once when it comes near, and again only after it has
// gone out of range (1.3x, so one hovering at the edge isn't called repeatedly).
const LOOKOUT_RANGE = 450;

function nearbyDangers(ship) {
  const list = [];
  const add = (obj, name, x, y, reach = 0) => {
    const gap = Math.hypot(x - ship.x, y - ship.y) - reach;
    list.push({ obj, name, x, y, gap });
  };
  // Anchored at a berth the harbour keeps enemies off, so only nature
  // (spout, whirlpool, tsunami) is called out there.
  const atAnchor = ship.anchored && !!berthedHarbour(ship);
  if (!atAnchor) {
    for (const pirate of [game.ai, ...game.pirateRaiders]) {
      if (pirate && !pirate.capsized) add(pirate, "pirate ship", pirate.x, pirate.y);
    }
    for (const c of game.seaCreatures) add(c, "sea monster", c.x, c.y);
    for (const e of game.underwaterEnemies) {
      if (!e.capsized) add(e, e.kind === "uboat" ? "U-boat" : "submarine", e.x, e.y);
    }
    for (const m of game.missiles) {
      if (m.kind === "torpedo" && m.target === ship) add(m, "torpedo", m.x, m.y);
    }
  }
  if (waterSpout.state !== "dormant") add(waterSpout, "water spout", waterSpout.x, waterSpout.y, waterSpout.r);
  if (whirlpool.state === "active") add(whirlpool, "whirlpool", whirlpool.x, whirlpool.y, whirlpool.r);
  if (tsunami.state !== "dormant" && !tsunami.passed.has(ship)) {
    // The wave comes from the side it travels away from.
    add(tsunami, "tsunami", ship.x - tsunami.dirX * 100, ship.y - tsunami.dirY * 100, 100);
  }
  return list;
}

function directionFrom(ship, x, y) {
  const a = normalizeAngle(Math.atan2(y - ship.y, x - ship.x) - ship.angle);
  if (Math.abs(a) <= Math.PI / 4) return "in front";
  if (Math.abs(a) >= (3 * Math.PI) / 4) return "at your back";
  return a > 0 ? "on your right" : "on your left";
}

// The game's sounds dip to VOICE_DUCK of their level while the lookout speaks.
const VOICE_DUCK = 0.4;
const lookoutCalls = new Set(); // spoken or waiting to be spoken

// Play has stopped (level finished, game over, back to the menu): a call
// being spoken finishes its sentence, but nothing new starts. A call still
// waiting in the queue is dropped as it comes up; the danger markers go.
function stopLookout() {
  crewFlush(); // the crew's experience is saved whenever play stops
  for (const line of lookoutCalls) line.dropped = true;
  game.targetAlerts = [];
}

function duckForVoice(on) {
  if (!sfx.out) return;
  const level = soundLevel().volume * (on ? VOICE_DUCK : 1);
  sfx.out.gain.setTargetAtTime(level, game.audioContext.currentTime, on ? 0.08 : 0.4);
}

function voiceOn() {
  return !!window.speechSynthesis && soundLevel().volume > 0;
}

// Speaks a call from the lookout or the crew, unless there is no voice or one
// call is already waiting (calls stay current that way).
function speakCall(text) {
  if (!voiceOn() || window.speechSynthesis.pending) return;
  const line = new SpeechSynthesisUtterance(text);
  // Speech can't go above full volume, so it gets full volume from Medium
  // up, and the game's own sounds dip while the voice speaks.
  line.volume = Math.min(1, soundLevel().volume * 1.5);
  line.rate = 1.1;
  lookoutCalls.add(line);
  line.onstart = () => {
    // A call dropped while it waited: the one before it has ended, so
    // cancelling now silences only this one.
    if (line.dropped) window.speechSynthesis.cancel();
    else duckForVoice(true);
  };
  line.onend = line.onerror = () => {
    lookoutCalls.delete(line);
    duckForVoice(false);
  };
  window.speechSynthesis.speak(line);
}

function updateLookout() {
  const voice = voiceOn();
  const ships = humanShips().filter((s) => !s.capsized);
  for (const ship of ships) {
    // A signed-on lookout also reports on screen, so works with sound off.
    const crewed = !!crewOn(ship, "lookout");
    if (!voice && !crewed) continue;
    const range = crewLookoutRange(ship);
    if (!ship.dangersCalled) ship.dangersCalled = new Set();
    for (const d of nearbyDangers(ship)) {
      if (d.gap > range * 1.3) ship.dangersCalled.delete(d.obj);
      if (d.gap > range || ship.dangersCalled.has(d.obj)) continue;
      // Keep at most one call waiting, so warnings stay current.
      if (voice && window.speechSynthesis.pending) break;
      ship.dangersCalled.add(d.obj);
      const who = ships.length > 1 ? `Captain ${ship.playerName || ""}` : "Captain";
      const call = crewed ? crewLookoutText(ship, d) : `${d.name} ${directionFrom(ship, d.x, d.y)}!`;
      if (crewed) {
        crewCard(ship, "lookout", call);
        crewGain(ship, "lookout", 8);
      }
      playAlertTone(980, 0.14, 0.04, "square");
      window.setTimeout(() => playAlertTone(980, 0.14, 0.04, "square"), 180);
      speakCall(`${who}, ${call}`);
    }
    // A danger that is gone (sunk, despawned, dormant) can be called again later.
    const present = new Set(nearbyDangers(ship).map((d) => d.obj));
    for (const obj of ship.dangersCalled) if (!present.has(obj)) ship.dangersCalled.delete(obj);
  }
}

// ---------------------------------------------------------------------------
// Premium purchases (Microsoft Store add-ons)
// ---------------------------------------------------------------------------
// The game is sold as a Microsoft Store app; premium packs are durable Store
// add-ons bought through the Digital Goods API + Payment Request API.
// STORE_SKUS must match the add-on Product IDs created in Partner Center.
const STORE_BILLING = "https://store.microsoft.com/billing";
const STORE_SKUS = {
  specialistArsenal: "specialist_arsenal_pack",
  specialistFleet: "specialist_fleet_pack"
};

// DEVELOPMENT ONLY: lets a developer unlock premium packs without paying, to
// test them. It only works on localhost. BEFORE RELEASE set this to false and
// delete the dev unlock code (see project notes); release builds must have no
// way to unlock premium content except a real Store purchase.
const DEV_PREMIUM_TEST = true;
const DEV_UNLOCK_KEY = "harbour-run-dev-premium-unlocks";

function devPremiumTestAllowed() {
  return DEV_PREMIUM_TEST && (location.hostname === "localhost" || location.hostname === "127.0.0.1");
}

const store = {
  status: "checking", // "checking" | "ready" | "unavailable"
  service: null,
  prices: {},
  purchased: {},
  devUnlocked: {},
  busy: false
};

function syncEntitlements() {
  const dev = devPremiumTestAllowed();
  for (const pack of Object.keys(PREMIUM_PACKS)) {
    game.entitlements[pack] = !!store.purchased[pack] || (dev && !!store.devUnlocked[pack]);
  }
}

async function refreshStorePurchases() {
  const purchases = await store.service.listPurchases();
  const owned = new Set(purchases.map((p) => p.itemId));
  for (const [pack, sku] of Object.entries(STORE_SKUS)) {
    store.purchased[pack] = owned.has(sku);
  }
  syncEntitlements();
}

async function initStore() {
  if (devPremiumTestAllowed()) {
    try {
      store.devUnlocked = JSON.parse(localStorage.getItem(DEV_UNLOCK_KEY) || "{}") || {};
    } catch {
      store.devUnlocked = {};
    }
  }
  syncEntitlements();

  if (!("getDigitalGoodsService" in window)) {
    store.status = "unavailable";
    return;
  }
  try {
    store.service = await window.getDigitalGoodsService(STORE_BILLING);
    const details = await store.service.getDetails(Object.values(STORE_SKUS));
    for (const d of details) {
      const pack = Object.keys(STORE_SKUS).find((k) => STORE_SKUS[k] === d.itemId);
      if (pack && d.price) {
        store.prices[pack] = new Intl.NumberFormat(undefined, { style: "currency", currency: d.price.currency }).format(Number(d.price.value));
      }
    }
    await refreshStorePurchases();
    store.status = "ready";
  } catch (err) {
    console.warn("[Store] Microsoft Store purchases unavailable:", err);
    store.status = "unavailable";
  }
}

async function purchasePremiumPack(pack) {
  if (store.status !== "ready" || store.busy || game.entitlements[pack]) return;
  store.busy = true;
  setUiMessage("Opening Microsoft Store checkout...");
  try {
    // The Store shows the real price and handles payment; the total here is
    // required by the Payment Request API but not used by Store billing.
    const request = new PaymentRequest(
      [{ supportedMethods: STORE_BILLING, data: { sku: STORE_SKUS[pack] } }],
      { total: { label: "Total", amount: { currency: "USD", value: "0" } } }
    );
    const response = await request.show();
    await response.complete("success");
    await refreshStorePurchases();
    setUiMessage(game.entitlements[pack] ? `${PREMIUM_PACKS[pack].name} unlocked. Thank you!` : "Purchase was not completed.");
  } catch (err) {
    console.warn("[Store] Purchase did not complete:", err);
    setUiMessage("Purchase cancelled or failed. You have not been charged.");
  } finally {
    store.busy = false;
  }
}

function openPremiumScreen(pack) {
  game.premiumPackId = pack;
  game.premiumReturnTo = gameState;
  gameState = "premium";
}

function closePremiumScreen() {
  gameState = game.premiumReturnTo || "menu";
}

// Development only (localhost + DEV_PREMIUM_TEST): unlock/lock a pack without paying.
function devTogglePremiumPack(pack) {
  if (!devPremiumTestAllowed()) return;
  store.devUnlocked[pack] = !store.devUnlocked[pack];
  localStorage.setItem(DEV_UNLOCK_KEY, JSON.stringify(store.devUnlocked));
  syncEntitlements();
  setUiMessage(`[DEV TEST] ${PREMIUM_PACKS[pack].name}: ${store.devUnlocked[pack] ? "unlocked" : "locked"}`);
}

function togglePremiumPackForTesting() {
  if (!devPremiumTestAllowed()) return;
  const on = !(store.devUnlocked.specialistArsenal && store.devUnlocked.specialistFleet);
  for (const pack of Object.keys(PREMIUM_PACKS)) store.devUnlocked[pack] = on;
  localStorage.setItem(DEV_UNLOCK_KEY, JSON.stringify(store.devUnlocked));
  syncEntitlements();
  setUiMessage(`[DEV TEST] Premium packs: ${on ? "ON" : "OFF"}`);
}

function newShip(type, x, y, heading) {
  return {
    type,
    x,
    y,
    angle: heading,
    speed: 0,
    turnRate: 1.46,
    helm: { rudder: 0, yaw: 0 },
    accel: 165,
    maxSpeed: type === "cruise" ? 240 : 255,
    hp: 100,
    capsized: false,
    reload: 0,
    attackLock: 0,
    aiControlled: false,
    isHuman: false,
    playerName: "",
    playerSlot: "",
    runScore: 0,
    scoreTick: 0,
    owned: {},
    windResistance: 0,
    damageReduction: 0,
    attackRangeBonus: 0,
    autoMissile: false,
    missileCooldown: 0,
    nextDockAwardAt: 0,
    maxHull: 100,
    displayColor: "",
    shipName: "",
    category: "",
    hitFlash: 0,
    radius: 16,
    repairReserve: 0,
    repairRecovered: 0,
    repairProgress: 0,
    repairPlan: null,
    repairLast: ""
  };
}

function randomRepairPlan() {
  const roll = Math.random();
  if (roll < 0.32) {
    return {
      label: "Easy",
      target: 46,
      minCost: 6,
      maxCost: 13,
      minEffort: 18,
      maxEffort: 30,
      successChance: 0.88,
      minHeal: 10,
      maxHeal: 22
    };
  }
  if (roll < 0.7) {
    return {
      label: "Standard",
      target: 74,
      minCost: 10,
      maxCost: 18,
      minEffort: 14,
      maxEffort: 24,
      successChance: 0.73,
      minHeal: 12,
      maxHeal: 24
    };
  }
  if (roll < 0.92) {
    return {
      label: "Complex",
      target: 108,
      minCost: 14,
      maxCost: 25,
      minEffort: 10,
      maxEffort: 20,
      successChance: 0.56,
      minHeal: 16,
      maxHeal: 30
    };
  }
  return {
    label: "Critical",
    target: 138,
    minCost: 18,
    maxCost: 34,
    minEffort: 8,
    maxEffort: 16,
    successChance: 0.42,
    minHeal: 20,
    maxHeal: 36
  };
}

function initRepairState(ship) {
  if (!ship) return;
  ship.repairReserve = Math.round(ship.maxHull * REPAIR_RESERVE_RATIO);
  ship.repairRecovered = 0;
  ship.repairProgress = 0;
  ship.repairPlan = null;
  ship.repairLast = "";
}

function attemptRepairForSlot(slot) {
  const ship = slot === "p1" ? game.player1 : game.player2;
  const profile = getProfile(slot);
  if (!ship || !profile || !ship.isHuman) return;
  if (ship.capsized) {
    setUiMessage(`${profile.name} cannot repair a capsized ship`);
    return;
  }

  const damage = Math.max(0, ship.maxHull - ship.hp);
  const reserveLeft = Math.max(0, ship.repairReserve - ship.repairRecovered);
  if (damage <= 0) {
    setUiMessage(`${profile.name} has no hull damage`);
    return;
  }
  if (reserveLeft <= 0) {
    setUiMessage(`${profile.name} repair reserve exhausted for this round`);
    return;
  }

  if (!ship.repairPlan) {
    ship.repairPlan = randomRepairPlan();
    ship.repairProgress = 0;
  }

  const plan = ship.repairPlan;
  const baseCost = plan.minCost + Math.floor(Math.random() * (plan.maxCost - plan.minCost + 1));
  const complexitySpike = Math.random() < 0.2 ? Math.ceil(baseCost * 0.5) : 0;
  const engineer = crewSkill(ship, "engineer");
  const attemptCost = Math.max(1, Math.round((baseCost + complexitySpike) * (1 - 0.3 * engineer)));
  if (profile.points < attemptCost) {
    setUiMessage(`${profile.name} needs ${attemptCost} points for repair effort`);
    return;
  }

  profile.points -= attemptCost;
  saveProfiles();
  crewGain(ship, "engineer", 10);

  let effort = (plan.minEffort + Math.random() * (plan.maxEffort - plan.minEffort)) * (1 + 0.5 * engineer);
  let complication = "";
  if (Math.random() < 0.16) {
    effort *= 0.45;
    complication = " Complication!";
  }

  ship.repairProgress = clamp(ship.repairProgress + effort, 0, plan.target);
  if (ship.repairProgress < plan.target) {
    const pct = Math.round((ship.repairProgress / plan.target) * 100);
    ship.repairLast = `${plan.label} repair ${pct}%`;
    setUiMessage(`${profile.name} working on ${plan.label.toLowerCase()} repair (${pct}%)${complication}`);
    return;
  }

  const success = Math.random() < plan.successChance + 0.15 * engineer;
  if (success) {
    crewGain(ship, "engineer", 25);
    let healed = Math.round(plan.minHeal + Math.random() * (plan.maxHeal - plan.minHeal));
    healed = Math.min(healed, damage, reserveLeft);
    ship.hp = Math.min(ship.maxHull, ship.hp + healed);
    ship.repairRecovered += healed;
    ship.repairLast = `Repair success +${healed} hull`;
    setUiMessage(`${profile.name} repaired ${healed} hull for ${attemptCost} points`);
  } else {
    const partial = Math.random() < 0.32 ? Math.min(3, damage, reserveLeft) : 0;
    if (partial > 0) {
      ship.hp = Math.min(ship.maxHull, ship.hp + partial);
      ship.repairRecovered += partial;
      ship.repairLast = `Partial fix +${partial} hull`;
      setUiMessage(`${profile.name} partial repair (+${partial}) for ${attemptCost} points`);
    } else {
      ship.repairLast = "Repair failed";
      setUiMessage(`${profile.name} repair attempt failed (${attemptCost} points spent)`);
    }
  }

  ship.repairPlan = null;
  ship.repairProgress = 0;
}

function dangerAtPoint(point, padding = 0) {
  let score = 0;

  for (const hz of hazards) {
    const d = dist(point, hz);
    const collisionZone = hz.r + 24 + padding;
    const dangerZone = hz.danger + 16 + padding;
    if (d < collisionZone) {
      score += 1000;
    } else if (d < dangerZone) {
      score += (dangerZone - d) * 3;
    }
  }

  if (iceSheetAt(point.x, point.y)) score += 400;

  for (const dz of dynamicDangers) {
    const d = dist(point, dz);
    const stormZone = dz.r + 30 + padding;
    if (d < stormZone) {
      score += (stormZone - d) * 4;
    }
  }

  if (waterSpout.state !== "dormant") {
    const d = dist(point, waterSpout);
    const spoutZone = waterSpout.r + 30 + padding;
    if (d < spoutZone) {
      score += (spoutZone - d) * 4;
    }
  }

  if (whirlpool.state !== "dormant") {
    const d = dist(point, whirlpool);
    const poolZone = WHIRLPOOL_MAX_R + 30 + padding;
    if (d < poolZone) score += (poolZone - d) * 4;
  }

  return score;
}

function findSafeAISpawnPoint(fallback) {
  let best = { ...fallback };
  let bestScore = Number.POSITIVE_INFINITY;

  for (let i = 0; i < 30; i += 1) {
    const candidate = {
      x: clamp(HarbourA.x + 130 + Math.random() * 260, 80, WORLD_W - 80),
      y: clamp(HarbourA.y - 180 + Math.random() * 210, 80, WORLD_H - 80)
    };
    const score = dangerAtPoint(candidate, 8);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function resetGame() {
  game.profiles = loadProfiles();

  game.mission = missionById(game.voyage);
  game.crossings = 0;
  game.arrival = null;
  buildHazards();

  game.player1 = newShip("cruise", HarbourA.x, HarbourA.y, -0.8);
  game.player2 = mode === "local" ? newShip("playerTwo", HarbourA.x, HarbourA.y, -0.8) : null;
  // A mission's pirates all come as raiders, out of its own waters.
  game.ai = mode === "single" && !game.mission ? newShip("pirate", HarbourA.x + 480, HarbourA.y - 140, -0.6) : null;
  if (game.ai) {
    const safeSpawn = findSafeAISpawnPoint({ x: game.ai.x, y: game.ai.y });
    game.ai.x = safeSpawn.x;
    game.ai.y = safeSpawn.y;
  }

  applyShipDefinition(game.player1, getShipDefinition(usableShipId("p1")));
  if (game.player2) {
    const own = usableShipId("p1");
    applyShipDefinition(game.player2, secondRowsGalley(own) ? ORDER_GALLEY : getShipDefinition(usableShipId("p2")));
  }

  applyGadgets(game.player1, getProfile("p1"), "p1");
  if (game.player2) {
    applyGadgets(game.player2, getProfile("p2"), "p2");
  }

  initRepairState(game.player1);
  initRepairState(game.player2);

  // Each voyage starts with the ships at anchor, lines fast, along the quays.
  game.player1.anchored = true;
  mooredAtBerth(game.player1, HarbourA, 0);
  if (game.player2) {
    game.player2.anchored = true;
    mooredAtBerth(game.player2, HarbourA, 1);
  }

  if (game.ai) {
    game.ai.aiControlled = true;
    game.ai.maxSpeed = 225;
    game.ai.turnRate = 1.53;
    game.ai.displayColor = "#f0d034";
    game.ai.shipName = "Pirate Hunter";
  }

  game.cannonCinematic = null;
  game.nextCinematicAt = 0;

  resetAiDirector(9);

  const threats = voyageThreats();

  game.pirateRaiders = [];
  game.seaCreatures = [];
  game.underwaterEnemies = [];
  game.missiles = [];
  game.nextRaiderSpawnAt = randomInterval(threats.raiderInterval);
  game.nextCreatureSpawnAt = randomInterval(threats.creatureInterval);
  game.nextUnderwaterSpawnAt = randomInterval(threats.underwaterInterval);
  // The wind blows from a random quarter at a random strength for the whole
  // round (it only gusts and veers a little); see updateWind.
  game.windDir = Math.random() * Math.PI * 2;
  game.windBase = (WIND_BASE[0] + Math.random() * (WIND_BASE[1] - WIND_BASE[0])) * (game.mission ? game.mission.wind : 1);
  game.windLog = [];
  game.windLogAt = -9;
  game.windMax = 0;
  game.wind = {
    x: Math.cos(game.windDir) * game.windBase * game.settings.windScale,
    y: Math.sin(game.windDir) * game.windBase * game.settings.windScale
  };
  startFogForRound();
  resetSea();
  game.jetBursts = [];
  game.jetTracers = [];
  game.floatingScores = [];
  game.targetAlerts = [];
  game.roundCommitted = false;
  game.gamePoints = { p1: 0, p2: 0 };
  game.uiMessage = "";
  game.uiMessageTtl = 0;

  waterSpout.state = "dormant";
  waterSpout.timer = randomInterval(threats.spoutDormant);
  resetTempest();
  resetTsunami();
  resetWhirlpool();

  game.elapsed = 0;
  startMissionState();
  game.tugOfferPending = true;
  game.galley = null;
  game.nextThreatAllowedAt = OPENING_CALM_TIME;
  resultText = "";
  gameState = "playing";
}

// Rebuilds hazards/dynamicDangers from scratch: Free Play places each new
// obstacle clear of the harbours and everything already placed; a mission has
// its own fixed obstacles and pack ice.
// Open water kept between hazards (beyond their danger rings) so there is
// always a clear channel to sail through.
const HAZARD_CHANNEL = 170;

function buildHazards() {
  const mission = game.mission;
  const config = mission ? { islands: 0, icebergs: 0, volcanoes: 0, storms: mission.storms } : FREE_PLAY;
  hazards.length = 0;
  dynamicDangers.length = 0;
  game.volcanoRocks = [];
  game.lavaPools = [];
  const placed = [HarbourA, HarbourB];
  game.polar = mission ? !!mission.polar : isPolarRun();
  game.iceSheets = [];
  if (game.polar && !mission) {
    for (const h of [HarbourA, HarbourB]) {
      const c = harbourPoint(h, 250, 250);
      const sheet = makeIceSheet(c.x, c.y, 360, h);
      game.iceSheets.push(sheet);
      placed.push({ x: c.x, y: c.y, clear: 310 });
    }
  }

  function randomSpot(minDist) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const x = 100 + Math.random() * (WORLD_W - 200);
      const y = 100 + Math.random() * (WORLD_H - 200);
      if (placed.every((o) => Math.hypot(x - o.x, y - o.y) >= minDist + (o.clear || 0))) {
        return { x, y };
      }
    }
    return { x: 100 + Math.random() * (WORLD_W - 200), y: 100 + Math.random() * (WORLD_H - 200) };
  }

  for (let i = 0; i < config.volcanoes; i += 1) {
    const r = 75 + Math.random() * 21;
    const danger = r + 56 + Math.random() * 12;
    const spot = randomSpot(danger + HAZARD_CHANNEL);
    const hz = { x: spot.x, y: spot.y, r, danger, kind: "volcano" };
    hazards.push(hz);
    placed.push(hz);
  }

  for (let i = 0; i < config.islands; i += 1) {
    const r = 57 + Math.random() * 30;
    const danger = r + 36 + Math.random() * 14;
    const spot = randomSpot(danger + HAZARD_CHANNEL);
    const hz = { x: spot.x, y: spot.y, r, danger, kind: "island" };
    hazards.push(hz);
    placed.push(hz);
  }

  for (let i = 0; i < config.icebergs; i += 1) {
    const r = 39 + Math.random() * 27;
    const danger = r + 30 + Math.random() * 12;
    const spot = randomSpot(danger + HAZARD_CHANNEL);
    const speed = 14 + Math.random() * 14;
    const dir = Math.random() * Math.PI * 2;
    const hz = {
      x: spot.x,
      y: spot.y,
      r,
      danger,
      kind: "iceberg",
      vx: Math.cos(dir) * speed,
      vy: Math.sin(dir) * speed
    };
    hazards.push(hz);
    placed.push(hz);
  }

  for (const fixed of mission ? mission.hazards : []) {
    const hz = { ...fixed, danger: fixed.r + { volcano: 58, island: 20, iceberg: 32 }[fixed.kind] };
    if (hz.kind === "iceberg") {
      const dir = Math.random() * Math.PI * 2;
      hz.vx = Math.cos(dir) * 12;
      hz.vy = Math.sin(dir) * 12;
    }
    hazards.push(hz);
  }
  for (const [x, y, r] of (mission && mission.ice) || []) game.iceSheets.push(makeIceSheet(x, y, r));

  // Pack ice: about one sheet for every two icebergs, in open water (more,
  // and bigger, on a polar run).
  const sheets = mission ? 0 : Math.ceil(config.icebergs / 2) + (game.polar ? 2 : 0);
  for (let i = 0; i < sheets; i += 1) {
    const r = (game.polar ? 180 : 150) + Math.random() * 90;
    const spot = randomSpot(r + HAZARD_CHANNEL);
    const sheet = makeIceSheet(spot.x, spot.y, r);
    game.iceSheets.push(sheet);
    placed.push({ x: sheet.x, y: sheet.y, clear: r });
  }

  // Storms wait off the map, upwind, and blow in one by one at a random time
  // STORM_ARRIVAL into the crossing, so it starts clear (no storm haze or
  // storm seas over the harbour) and each storm is seen coming.
  for (let i = 0; i < config.storms; i += 1) {
    const r = 58 + Math.random() * 30;
    const dz = {
      x: STORM_PARKED,
      y: STORM_PARKED,
      r,
      arriveIn: randomInterval(STORM_ARRIVAL),
      kind: "storm",
      vx: 0,
      vy: 0,
      pace: STORM_PACE[0] + Math.random() * (STORM_PACE[1] - STORM_PACE[0]),
      rain: 0.5 + Math.random() * 0.5,
      rainTarget: 1,
      rainTimer: 0
    };
    dynamicDangers.push(dz);
  }
}

// Banks each human ship's in-progress score into their profile without
// ending the round, so points earned on one crossing aren't lost or
// double-counted when the round eventually does end.
function bankRunScore() {
  let changed = false;
  for (const ship of humanShips()) {
    if (!ship || !ship.playerSlot) continue;
    const points = Math.max(0, Math.round(ship.runScore || 0));
    ship.runScore = 0;
    if (points <= 0) continue;

    const profile = getProfile(ship.playerSlot);
    profile.points += points;
    game.gamePoints[ship.playerSlot] += points;
    const key = profile.name;
    game.profiles.leaderboard[key] = (game.profiles.leaderboard[key] || 0) + points;
    changed = true;
  }
  if (changed) saveProfiles();
}

// Sends a ship back to Harbour A for the next crossing. A capsized ship is
// revived here too - otherwise its wreck would just sit frozen on screen
// for the rest of the game instead of rejoining the next lap.
function respawnShip(ship, x, y, heading) {
  if (!ship) return;
  ship.x = x;
  ship.y = y;
  ship.angle = heading;
  ship.helm = { rudder: 0, yaw: 0 };
  ship.speed = 0;
  ship.hp = ship.maxHull;
  ship.capsized = false;
  ship.outAt = undefined;
  ship.anchored = !!ship.isHuman;
  if (ship.isHuman) mooredAtBerth(ship, HarbourA, ship === game.player2 ? 1 : 0);
  else ship.ropes = 0;
  ship.castOff = false;
  ship.leftA = false; // the carrack needs towing out again
  ship.nextDockAwardAt = 0;
  ship.tow = null;
  ship.fire = null; // a fire from the last crossing is out
  ship.jet = null; // the carrier's jet is back on deck
  ship.course = null; // the navigator plots the new sea afresh
  ship.track = null; // and a new track is started
  ship.kx = 0; // and no shove from a last bump or wave carries over
  ship.ky = 0;
}

// Free Play: reaching Harbour B doesn't end the game - it banks the score
// earned so far, then reshuffles hazards/dangers and sends every surviving
// ship back to Harbour A for a fresh crossing.
function startNextCrossing() {
  game.crossings += 1;
  bankRunScore();
  game.galley = null;

  const threats = voyageThreats();
  buildHazards();

  game.pirateRaiders = [];
  game.seaCreatures = [];
  game.underwaterEnemies = [];
  game.missiles = [];
  game.nextRaiderSpawnAt = game.elapsed + randomInterval(threats.raiderInterval);
  game.nextCreatureSpawnAt = game.elapsed + randomInterval(threats.creatureInterval);
  game.nextUnderwaterSpawnAt = game.elapsed + randomInterval(threats.underwaterInterval);

  waterSpout.state = "dormant";
  waterSpout.timer = randomInterval(threats.spoutDormant);
  resetTempest();
  resetTsunami();
  // Everything starts afresh with the new crossing: whirlpool, fog and the sea.
  game.jetBursts = [];
  game.jetTracers = [];
  resetWhirlpool();
  startFogForRound();
  resetSea();
  game.nextThreatAllowedAt = game.elapsed + OPENING_CALM_TIME;

  // A player whose ship sank stays out for the rest of the game: the other
  // carries on alone until they finish or sink too (that ends the game).
  if (!game.player1.capsized) respawnShip(game.player1, HarbourA.x + 16, HarbourA.y + 15, -0.8);
  if (game.player2 && !game.player2.capsized) respawnShip(game.player2, HarbourA.x - 16, HarbourA.y - 15, -0.8);
  respawnShip(game.ai, HarbourA.x + 360, HarbourA.y - 100, -0.6);
  if (game.ai && !game.ai.capsized) {
    const safeSpawn = findSafeAISpawnPoint({ x: game.ai.x, y: game.ai.y });
    game.ai.x = safeSpawn.x;
    game.ai.y = safeSpawn.y;
  }
  // Fresh plan for the new crossing: the last one's ambush point (often right
  // by Harbour B, where the player just docked) must not carry over.
  resetAiDirector(game.elapsed + 4);

  // Freeze play behind an animated "Harbour reached" card until the player
  // acknowledges it - handleGameLogic no-ops outside "playing", so the
  // freshly-laid-out world just sits still until they press a key.
  game.arrival = { elapsed: 0 };
  gameState = "arrival";
  stopLookout();
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function normalizeAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// Steering like a real ship. The helm moves the rudder over at a limited
// rate; the rudder turns the ship only with water flowing past it, so the
// turn grows with speed (with the engine ahead, the propeller's wash still
// gives a little steering when barely moving); the hull's weight makes a turn
// build up and die away gradually; and a hard turn bleeds off speed.
// A ship's turnRate (stats) is its turn rate (rad/s) with full rudder at top
// speed. Per hull: rudder = seconds from amidships to hard over; lag = seconds
// for a turn to build up (bigger, heavier hulls are slower); wash = steering
// from propeller wash at a standstill, engine ahead (share of full).
// At a standstill a rudder has almost nothing to bite on: only the propeller
// wash (engine ahead) steers, and only slightly, so a ship barely swings its
// bow until it gathers way. Only the tug (azimuth thrusters) and the vectored-
// thrust craft turn noticeably from rest. The small craft still out-turn sea
// creatures (1.8 rad/s) and underwater enemies (1.45 rad/s) once under way.
const HELM = {
  Sailing: { rudder: 0.24, lag: 0.24, wash: 0.08 },
  Catamaran: { rudder: 0.3, lag: 0.3, wash: 0.08 },
  Futuristic: { rudder: 0.15, lag: 0.18, wash: 0.3 }, // vectored thrust
  Hydrofoil: { rudder: 0.3, lag: 0.36, wash: 0.07 },
  Pirate: { rudder: 0.48, lag: 0.48, wash: 0.07 },
  Carrack: { rudder: 0.55, lag: 0.68, wash: 0.25 }, // backed headsails help her round, even with no way on
  Galley: { rudder: 0.3, lag: 0.4, wash: 0.6 }, // oars: turns almost on the spot
  Assault: { rudder: 0.42, lag: 0.54, wash: 0.06 },
  Cruise: { rudder: 0.6, lag: 0.78, wash: 0.08 }, // pod drives and bow thrusters
  Cargo: { rudder: 0.78, lag: 0.96, wash: 0.05 },
  Carrier: { rudder: 0.9, lag: 1.2, wash: 0.04 },
  Tug: { rudder: 0.22, lag: 0.3, wash: 0.4 }, // azimuth thrusters: turns on the spot
  Icebreaker: { rudder: 0.6, lag: 0.8, wash: 0.06 },
  Tanker: { rudder: 0.9, lag: 1.25, wash: 0.04 },
  GasTanker: { rudder: 0.85, lag: 1.2, wash: 0.04 },
  WarTanker: { rudder: 0.82, lag: 1.15, wash: 0.05 }
};
// Large ships have a bow and a stern thruster, used in pairs so they never push
// the ship from one end only: the steering keys turn the ship on the spot (bow
// one way, stern the other), and Q / E (player 1) or [ / ] (player 2) slide it
// bodily to port / starboard (both push the same way, the heading stays put).
// Both fade out as speed builds.
const THRUSTER_SHIPS = ["Cruise", "Cargo", "Carrier", "Tanker", "GasTanker", "WarTanker", "Icebreaker", "Assault"];
const THRUSTER_KEYS = {
  get p1() { return [game.settings.keybinds.p1SlideLeft, game.settings.keybinds.p1SlideRight]; },
  get p2() { return [game.settings.keybinds.p2SlideLeft, game.settings.keybinds.p2SlideRight]; }
};
const THRUSTER_YAW = 0.12; // rad/s (about 7 degrees a second: slow, heavy hulls)
const THRUSTER_SWAY = 14; // units/s
const THRUSTER_MAX_SPEED = 70; // no help above this speed
function thrusterInput(slot) {
  const [port, starboard] = THRUSTER_KEYS[slot];
  return (keys.has(starboard) ? 1 : 0) - (keys.has(port) ? 1 : 0);
}
const ASTERN_STEERING = 0.5; // a rudder steers poorly going astern
const TURN_SPEED_LOSS = 0.35; // share of speed lost per second in a full-rate turn

function helmOf(ship) {
  return HELM[ship.type === "pirate" ? "Pirate" : ship.category] || HELM.Pirate;
}

// One step of the helm. `h` holds the rudder (-1 port .. 1 starboard) and the
// turn rate (yaw, rad/s); returns the turn rate. Used by applyMovement and by
// the pirates' route planner, so their plans turn the way their ships do.
function helmStep(h, ship, steer, throttle, speed, dt) {
  const helm = helmOf(ship);
  const quick = 1 - 0.3 * crewSkill(ship, "helm"); // a good helmsman answers sooner
  h.rudder += clamp(steer - h.rudder, -dt / (helm.rudder * quick), dt / (helm.rudder * quick));
  const flow = speed < 0
    ? (speed / ship.maxSpeed) * ASTERN_STEERING
    : Math.max(speed / ship.maxSpeed, helm.wash * Math.max(0, throttle));
  h.yaw += (h.rudder * ship.turnRate * flow - h.yaw) * (1 - Math.exp(-dt / (helm.lag * quick)));
  return h.yaw;
}

// Share of speed kept after a step of turning at `yaw`.
function turnSpeedKeep(ship, yaw, dt) {
  return 1 - TURN_SPEED_LOSS * Math.min(1, Math.abs(yaw) / ship.turnRate) * dt;
}

// Berthed in a harbour a player's ship lies at anchor: the wind doesn't
// drift it and the engine and rudder are idle. It anchors by itself when it
// comes to rest (engine stopped) in a harbour's berthing area, and starts
// each voyage at anchor. R (player 1) / Comma (player 2) weighs anchor to
// sail, or drops it again while berthed.
const ANCHOR_KEYS = { get p1() { return game.settings.keybinds.p1Anchor; }, get p2() { return game.settings.keybinds.p2Anchor; } };
const ANCHOR_KEY_NAMES = { get p1() { return keyName(game.settings.keybinds.p1Anchor); }, get p2() { return keyName(game.settings.keybinds.p2Anchor); } };
const ANCHOR_REST_SPEED = 12; // slower than this counts as at rest (units/s)

// In a harbour's berthing area: inside the basin between its quays.
function berthedHarbour(ship) {
  return [HarbourA, HarbourB].find((h) => {
    const a = (ship.x - h.corner.x) * h.sa;
    const b = (ship.y - h.corner.y) * h.sb;
    return a > 22 && b > 22 && a < BASIN && b < BASIN;
  }) || null;
}

// A ship at anchor lies alongside a quay: berth 0 along the first quay (the
// one with the pumps), berth 1 along the second. Moored, it
// is held by five lines (long head line, bow, stern and two springs) to the quay bollards.
// Weighing anchor casts the lines off one by one; when the last is clear the
// captain is told the ship is ready to sail.
const BERTH_CENTRE = 112; // along the quay
const BERTH_GAP = 1.5; // fender gap between hull and quay face
const WARP_SPEED = 28; // units/s the ship is eased into its berth
const ROPES_MAKE_TIME = 4; // s to make all the lines fast
const ROPES_CAST_TIME = 5; // s to cast them all off
const MOORING_LINES = 5;
const READY_SIGNAL_TIME = 6; // s the "ready to sail" signal stays up

// The captain must bring the ship to its berth (alongside the quay, bow either way, close to the
// marked place) before the anchor can go down; the ship is then eased the last few units alongside.
const BERTH_REACH = 45; // units out from the berth's exact spot, away from the quay
const BERTH_HALF_LEN = 62; // along the quay: half the marked berth (BERTH_LEN in render3d.js)
const BERTH_ANGLE = 0.7; // rad off the berth's heading

function atBerth(ship) {
  const h = berthedHarbour(ship);
  if (!h) return false;
  const slot = pickBerth(h, ship);
  const pose = berthPose(h, slot, ship);
  const alongX = slot === 1; // which map axis this berth's quay runs along
  const along = Math.abs(alongX ? ship.x - pose.x : ship.y - pose.y);
  const out = Math.abs(alongX ? ship.y - pose.y : ship.x - pose.x);
  return along < BERTH_HALF_LEN && out < BERTH_REACH && Math.abs(normalizeAngle(pose.angle - ship.angle)) < BERTH_ANGLE;
}

function berthPose(h, slot, ship) {
  const lateral = 22 + bumpShape(ship).r + BERTH_GAP;
  const pt = slot === 0 ? harbourPoint(h, lateral, BERTH_CENTRE) : harbourPoint(h, BERTH_CENTRE, lateral);
  const dir = slot === 0 ? { x: 0, y: h.sb } : { x: h.sa, y: 0 };
  const seaward = Math.atan2(dir.y, dir.x);
  // The ship lies whichever way round it came in: it is never swung end for end.
  const angle = Math.cos(ship.angle - seaward) < 0 ? normalizeAngle(seaward + Math.PI) : seaward;
  return { x: pt.x, y: pt.y, angle };
}

// The berth a ship coming to rest takes: the nearer free one (tankers prefer
// the pump quay).
function pickBerth(h, ship) {
  const taken = humanShips().filter((o) => o !== ship && !o.capsized && o.berth && o.berth.h === h).map((o) => o.berth.slot);
  if (mode === "single") return 0; // one berth in a one-player game
  const free = [0, 1].filter((k) => !taken.includes(k));
  if (free.length === 0) return 0;
  if (TANKERS[ship.category] && free.includes(0)) return 0;
  return free.reduce((best, k) => (dist(ship, berthPose(h, k, ship)) < dist(ship, berthPose(h, best, ship)) ? k : best));
}

// Put a ship straight into its berth, at anchor with the lines fast, bow to the sea (a new crossing).
function mooredAtBerth(ship, h, slot) {
  ship.angle = slot === 0 ? Math.atan2(h.sb, 0) : Math.atan2(0, h.sa);
  const pose = berthPose(h, slot, ship);
  ship.x = pose.x;
  ship.y = pose.y;
  ship.angle = pose.angle;
  ship.berth = { h, slot };
  ship.warping = false;
  ship.ropes = 1;
}

function dropAnchor(ship) {
  ship.anchored = true;
  ship.berth = { h: berthedHarbour(ship), slot: pickBerth(berthedHarbour(ship), ship) };
  ship.warping = true; // eased alongside by updateMooring
  ship.ropes = 0;
  ship.readyAt = undefined;
  ship.speed = 0;
  ship.kx = 0;
  ship.ky = 0;
  ship.helm = { rudder: 0, yaw: 0 };
  const hose = pumpHose(ship);
  const plugged = hose ? `, plugged into the ${hose.name}` : "";
  setUiMessage(`${ship.playerName || "Ship"} at anchor in ${berthedHarbour(ship).name}${plugged} - press ${ANCHOR_KEY_NAMES[ship.playerSlot]} to weigh anchor`, ship.playerSlot);
}

// Each frame, before the ship moves: anchor on coming to rest at a berth.
// After weighing anchor it won't re-anchor until it has left the berth.
function updateAnchor(ship) {
  if (!ship || ship.capsized || !ship.isHuman) return;
  const berth = berthedHarbour(ship);
  if (!berth) {
    ship.castOff = false;
    ship.berthHinted = false;
    return;
  }
  // Entering the destination's berth: tell the captain how to finish (the
  // banner from drawBerthPrompts stays up until they anchor).
  if (berth === HarbourB && !ship.anchored && !ship.berthHinted && ship.category !== "Carrack") {
    ship.berthHinted = true;
    setUiMessage(`${ship.playerName || "Ship"} reached Harbour B - bring the ship alongside the quay at its berth, then anchor`);
    playShipHorn();
  }
  if (!ship.anchored && !ship.castOff && !ship.throttle && Math.abs(ship.speed) < ANCHOR_REST_SPEED && atBerth(ship)) dropAnchor(ship);
}

// Each frame: ease an anchored ship alongside its berth, make the lines fast;
// after weighing anchor cast them off gradually, then signal ready to sail.
function updateMooring(ship, dt) {
  if (!ship || ship.capsized || !ship.isHuman) return;
  const name = ship.playerName || "Ship";
  if (ship.anchored && ship.berth && ship.warping) {
    const pose = berthPose(ship.berth.h, ship.berth.slot, ship);
    const gap = dist(ship, pose);
    const step = Math.min(gap, WARP_SPEED * dt);
    if (gap > 0) {
      ship.x += ((pose.x - ship.x) / gap) * step;
      ship.y += ((pose.y - ship.y) / gap) * step;
    }
    const turn = normalizeAngle(pose.angle - ship.angle);
    ship.angle += clamp(turn, -1.2 * dt, 1.2 * dt);
    if (gap < 0.5 && Math.abs(turn) < 0.03) {
      ship.warping = false;
      ship.angle = pose.angle;
    }
  } else if (ship.anchored && ship.berth && ship.ropes < 1) {
    const before = ship.ropes;
    ship.ropes = Math.min(1, ship.ropes + (dt / ROPES_MAKE_TIME) * (1 + crewSkill(ship, "bosun")));
    if (before < 1 && ship.ropes >= 1) {
      setUiMessage(`${name} made fast alongside - lines secure`, ship.playerSlot);
      crewGain(ship, "bosun", 15);
    }
  } else if (!ship.anchored && ship.ropes > 0) {
    ship.ropes = Math.max(0, ship.ropes - (dt / ROPES_CAST_TIME) * (1 + crewSkill(ship, "bosun")));
    if (ship.ropes === 0) {
      ship.berth = null;
      const towed = !!carrackPort(ship); // not ready to sail: she needs the galley (drawTowPrompts)
      ship.readyAt = towed ? undefined : game.elapsed;
      setUiMessage(towed ? `${name}: all lines clear - now the galley must tow her out` : `${name}: all lines clear - ready to sail!`, ship.playerSlot);
      playShipHorn();
    }
  }
}

function toggleAnchor(slot) {
  const ship = slot === "p2" ? game.player2 : game.player1;
  if (!ship || ship.capsized) return;
  if (ship.anchored) {
    ship.anchored = false;
    ship.castOff = true;
    ship.warping = false;
    if (ship.ropes > 0) setUiMessage(`${ship.playerName || "Ship"} weighed anchor - casting off the lines`, ship.playerSlot);
    else {
      ship.berth = null;
      setUiMessage(`${ship.playerName || "Ship"} weighed anchor`, ship.playerSlot);
    }
  } else if (berthedHarbour(ship) && !atBerth(ship)) {
    setUiMessage(`${ship.playerName || "Ship"}: bring the ship alongside the quay at its berth before anchoring`, ship.playerSlot);
  } else if (berthedHarbour(ship) && Math.abs(ship.speed) < ANCHOR_REST_SPEED * 2) {
    dropAnchor(ship);
  } else {
    setUiMessage(`${ship.playerName || "Ship"}: anchor only when at rest in a harbour berth`, ship.playerSlot);
  }
}

function applyMovement(ship, input, dt) {
  if (!ship || ship.capsized) return;
  // what each side thruster is pushing: 1 full to starboard, -1 full to port
  ship.thrusters = { bow: 0, stern: 0 };

  if (ship.anchored || ship.ropes > 0) {
    // Held by the anchor, or by the lines still being cast off: no drift,
    // engine and rudder idle; a hard bump still shoves the hull a little.
    ship.throttle = 0;
    ship.speed = 0;
    applyKnockback(ship, dt);
    if ((input.forward || input.backward) && game.elapsed - (ship.anchorHintAt || -9) > 3) {
      ship.anchorHintAt = game.elapsed;
      setUiMessage(
        ship.anchored
          ? `${ship.playerName || "Ship"} is at anchor - press ${ANCHOR_KEY_NAMES[ship.playerSlot]} to weigh anchor`
          : `${ship.playerName || "Ship"} is still tied up - wait for the lines to clear`,
        ship.playerSlot
      );
    }
    ship.reload = Math.max(0, ship.reload - dt);
    ship.attackLock = Math.max(0, ship.attackLock - dt * 0.45);
    ship.hitFlash = Math.max(0, ship.hitFlash - dt);
    return;
  }

  const throttleBase = input.forward ? 1 : input.backward ? -0.5 : 0;
  let throttle = throttleBase * (input.throttleScale || 1);
  const steer = (input.left ? -1 : 0) + (input.right ? 1 : 0);

  const inPort = !!carrackPort(ship); // only a tow moves a carrack in harbour waters
  if (inPort) {
    throttle = 0;
    ship.speed *= keepPer60(0.95, dt);
  }
  ship.throttle = throttle; // read by the engine sound
  if (!ship.helm) ship.helm = { rudder: 0, yaw: 0 };
  const yaw = helmStep(ship.helm, ship, steer, throttle, ship.speed, dt);
  ship.angle += yaw * dt;
  if (THRUSTER_SHIPS.includes(ship.category) && Math.abs(ship.speed) < THRUSTER_MAX_SPEED) {
    const k = (1 - Math.abs(ship.speed) / THRUSTER_MAX_SPEED) * dt;
    ship.angle += THRUSTER_YAW * steer * k; // opposed pair: turns, no sideways push
    const slide = (input.thrust || 0) * THRUSTER_SWAY * k; // same-way pair: slides, no turn
    ship.x -= Math.sin(ship.angle) * slide;
    ship.y += Math.cos(ship.angle) * slide;
    const power = 1 - Math.abs(ship.speed) / THRUSTER_MAX_SPEED;
    ship.thrusters.bow = clamp((input.thrust || 0) + steer, -1, 1) * power;
    ship.thrusters.stern = clamp((input.thrust || 0) - steer, -1, 1) * power;
  }
  ship.speed *= turnSpeedKeep(ship, yaw, dt);
  const following = Math.max(0, Math.cos(ship.angle - Math.atan2(game.wind.y, game.wind.x))); // 1 = wind dead astern
  const drive = 1 + 0.1 * crewSkill(ship, "engineer") + 0.1 * crewSkill(ship, "sails") * following;
  // The carrack has no engine: what the sails make of the wind is all her drive.
  const sails = ship.category === "Carrack" ? carrackWind(ship).power : 1;
  ship.speed += throttle * sails * ship.accel * drive * dt;
  // Water drag; a foil-borne hydrofoil skims above most of it.
  ship.speed *= keepPer60(0.986 + 0.007 * (ship.foilLift || 0), dt);
  ship.speed = clamp(ship.speed, -ship.maxSpeed * 0.35, ship.maxSpeed);
  // Rowing with a great ship on the rope is slow work.
  if (ship.category === "Galley" && ship.tow) ship.speed = Math.min(ship.speed, GALLEY_TOWING_SPEED);
  updateShipIce(ship, dt);

  ship.x += Math.cos(ship.angle) * ship.speed * dt;
  ship.y += Math.sin(ship.angle) * ship.speed * dt;

  applyKnockback(ship, dt);
  applySeaPush(ship, dt);

  // Wind applies to all ships as continuous drift (less when foil-borne).
  const inBasin = !!berthedHarbour(ship);
  const handled = (1 - 0.25 * crewSkill(ship, "helm")) * (1 - 0.5 * crewSkill(ship, "sails"));
  const drift = inPort ? 0 : (1 - ship.windResistance) * (1 - 0.4 * (ship.foilLift || 0)) * (inBasin ? HARBOUR_WIND_SHELTER : 1) * handled;
  ship.x += game.wind.x * drift * dt;
  ship.y += game.wind.y * drift * dt;
  if (inBasin) applyHarbourSwell(ship, dt);
  updateFoilLift(ship);

  const freeX = ship.x;
  const freeY = ship.y;
  if (!stillEntering(ship, 10)) {
    ship.x = clamp(ship.x, 10, WORLD_W - 10);
    ship.y = clamp(ship.y, 10, WORLD_H - 10);
  }
  if ((ship.x !== freeX || ship.y !== freeY) && ship.isHuman) bumpSound(ship, ship, Math.abs(ship.speed) / ship.maxSpeed);

  ship.reload = Math.max(0, ship.reload - dt);
  ship.attackLock = Math.max(0, ship.attackLock - dt * 0.45);
  ship.hitFlash = Math.max(0, ship.hitFlash - dt);
}

// `exact` = take exactly `amount` (a share of full health), ignoring armour.
// In harbour waters only nature hurts a ship (storms, tsunamis, spouts, volcano rocks, fire, ice); weapons,
// sea monsters and hull scrapes are ignored there.
const MAN_MADE_DAMAGE = /^(hit by (?!a volcano rock)|attacked by|sea creature|hull scrape)/;
// Tankers (oil and gas) don't blow up from one shot: it takes intensive firing (TANKER_FIRING_HITS weapon hits
// close together; each hit's "heat" fades at TANKER_HEAT_FADE a second), which sets the cargo off.
// A breached hull (broken or capsized, whatever the cause) always sparks and explodes. A volcano rock only
// sets it alight; the fire then burns until it is put out (fire fighting equipment) or the hull is gone.
const TANKER_WEAPON_HIT = /^(hit by (?!a volcano rock)|attacked by)/;
const TANKER_FIRING_HITS = 4;
const TANKER_HEAT_FADE = 0.3;

function tankerBlast(ship, destroyed) {
  playExplosion(ship.x, ship.y, destroyed ? 1.3 : 1);
  setShipOnFire(ship);
  ship.fire.intensity = FIRE_MAX_INTENSITY;
  if (destroyed) ship.burnsWhileSinking = true;
  if (ship.isHuman) {
    setUiMessage(destroyed ? `${ship.playerName || "Ship"}'s hull is breached - the tanker exploded and is burning!` : `${ship.playerName || "Ship"}'s tanker was shot up - the cargo exploded and is burning!`, ship.playerSlot);
  }
}

// Counts a weapon hit on a tanker; true when the firing has been intense enough to set it off.
function tankerHeat(ship) {
  const now = game.elapsed;
  ship.hitHeat = Math.max(0, (ship.hitHeat || 0) - (now - (ship.hitHeatAt || now)) * TANKER_HEAT_FADE) + 1;
  ship.hitHeatAt = now;
  return ship.hitHeat >= TANKER_FIRING_HITS + Math.round(2 * crewSkill(ship, "pump"));
}

function damageShip(ship, amount, reason, hardCapsize = false, exact = false) {
  if (!ship || ship.capsized) return;
  if (safeInHarbour(ship) && MAN_MADE_DAMAGE.test(reason)) return;
  let effectiveAmount = hardCapsize || exact ? amount : amount * (1 - ship.damageReduction);
  if (exact && TANKERS[ship.category]) effectiveAmount *= TANKER_SHARE_DAMAGE;
  if (TANKER_WEAPON_HIT.test(reason)) effectiveAmount *= 1 - 0.25 * crewSkill(ship, "pump");
  ship.hp -= effectiveAmount;
  ship.hitFlash = 0.2;
  const tanker = !!TANKERS[ship.category];
  const broken = hardCapsize || ship.hp <= 0;
  if (tanker && broken) tankerBlast(ship, true);
  else if (tanker && effectiveAmount > 0 && TANKER_WEAPON_HIT.test(reason) && tankerHeat(ship)) {
    ship.hitHeat = 0;
    tankerBlast(ship, false);
  }

  if (broken) {
    ship.hp = 0;
    ship.capsized = true;
    ship.sankAt = game.elapsed;
    ship.speed = 0;
    if (!tanker) ship.fire = null; // a breached tanker keeps burning as it goes down
    if (ship.isHuman && mode === "local") {
      ship.outAt = game.elapsed;
      setUiMessage(`${playerLabel(ship)} is out of the game`);
    }
    // The pirate's broadside has its own cinematic boom.
    if (!game.cannonCinematic) playCapsize(ship.x, ship.y);
  }
}

function attack(attacker, target, dt = 0) {
  if (!attacker || !target || attacker.capsized || target.capsized) return;
  if (safeInHarbour(target)) return;
  if (safeInHarbour(attacker)) {
    // Harbour waters are a peaceful zone: no weapons are fired from here.
    setUiMessage(`${attacker.playerName || "Ship"}: no firing in harbour waters`, attacker.playerSlot);
    return;
  }
  if (attacker.reload > 0) return;
  if (attacker.deterredUntil > game.elapsed) return; // driven off by an acoustic deterrent

  const range = (attacker.aiControlled ? 84 : 90) + (attacker.attackRangeBonus || 0) + crewGunRange(attacker);
  const d = dist(attacker, target);
  const desired = Math.atan2(target.y - attacker.y, target.x - attacker.x);
  const facingError = Math.abs(normalizeAngle(desired - attacker.angle));
  // The pirate gets a wider firing arc than the player's guns: it has to
  // steer around the target and the player's bow is hard to keep bearing on.
  const arc = attacker.aiControlled ? 0.7 : 0.42;
  const hasFiringSolution = d <= range && gunsBear(attacker, facingError, arc);

  if (!hasFiringSolution) {
    // A pirate that briefly loses its aim (a swell, a course correction)
    // keeps most of its lock rather than starting over from nothing.
    attacker.attackLock = attacker.aiControlled ? Math.max(0, attacker.attackLock - dt * 0.5) : 0;
    return;
  }

  if (attacker.aiControlled) {
    // applyMovement also bleeds the lock off every frame (0.45/s), so 0.5
    // here means about 0.9 s of steady aim. At 0.85 it took ~1.55 s, which
    // a pirate chasing a ship under way almost never managed, so it never fired.
    attacker.attackLock += dt;
    if (attacker.attackLock < 0.5) {
      return;
    }
    attacker.attackLock = 0;
    attacker.reload = 3.2;
    attacker.attackedPlayerAt = game.elapsed;
    startCannonCinematic(attacker, target);
    sinkingHit(target, "attacked by pirate ship");
    return;
  }

  const weapon = shipWeapon(attacker);
  if (weapon === "sonic") {
    attacker.reload = 0.92;
    fireSonicPulse(attacker, target);
  } else if (weapon === "laser") {
    attacker.reload = 1.1;
    fireLaser(attacker, target);
  } else if (weapon === "machineGun") {
    attacker.reload = 1.4;
    playMachineGun(attacker.x, attacker.y, SHOT_ROUNDS.bullet);
    launchShots(attacker, target, "bullet");
  } else if (weapon === "waterCannon") {
    attacker.reload = 1.4;
    playWaterCannon(attacker.x, attacker.y);
    launchShots(attacker, target, "water");
  } else {
    attacker.reload = 1.25;
    playCannonShot(attacker.x, attacker.y);
    launchShots(attacker, target, "ball");
  }
  attacker.reload *= 1 - 0.25 * crewSkill(attacker, "gunner");
  crewGain(attacker, "gunner", 6);
}

// The wartime tanker's deck guns (world units from midships, bow and stern):
// she can fire ahead or astern, from whichever gun faces the target.
const DECK_GUNS = { bow: 28, stern: -29 };

// Whether a target `off` radians from the bow is inside the ship's firing arc.
function gunsBear(ship, off, arc) {
  return off < arc || (ship.category === "WarTanker" && Math.PI - off < arc);
}

// Each class of ship defends itself with its own weapon. Civilian ships
// (cruise, cargo, catamaran, hydrofoil) carry fire-fighting water cannons,
// warships carry machine guns, the sailing boat and the carrack fire cannon and
// the Futuristic Nova fires a laser. A bought Sonic Weapon replaces any of them.
const WEAPON_BY_CATEGORY = {
  Cruise: "waterCannon",
  Cargo: "waterCannon",
  Catamaran: "waterCannon",
  Hydrofoil: "waterCannon",
  Icebreaker: "waterCannon",
  Tanker: "waterCannon",
  GasTanker: "waterCannon",
  Tug: "waterCannon", // a fire-fighting tug
  Assault: "machineGun",
  Carrier: "machineGun",
  Futuristic: "laser",
  Sailing: "cannon",
  WarTanker: "cannon", // the bow and stern deck guns
  Carrack: "cannon",
  Galley: "cannon" // the bow guns
};
const WEAPON_NAMES = { sonic: "SONIC", laser: "LASER", machineGun: "MG", waterCannon: "WATER", cannon: "CANNON" };

function shipWeapon(ship) {
  if (ship.owned && ship.owned.sonicWeapon) return "sonic";
  return WEAPON_BY_CATEGORY[ship.category] || "cannon";
}

// Shots fly to the target and only do damage when they actually reach it
// (an island in the way stops them). `share` = part of a full kill per hit:
// a jet or burst of 6 needs 4 hits to sink a pirate, a cannonball just one.
const SHOT_SPEED = { ball: 520, water: 430, bullet: 950 };
const SHOT_SHARE = { ball: 1, water: 0.25, bullet: 0.25 };
const SHOT_ROUNDS = { ball: 1, water: 6, bullet: 6 };
const SHOT_GAP = { ball: 0, water: 0.05, bullet: 0.07 };
const SHOT_COLOR = { ball: "#2a2522", water: "#d9f3ff", bullet: "#ffd36b" };

function launchShots(attacker, target, kind) {
  let along = 0; // how far fore or aft of midships the round leaves from
  if (attacker.category === "WarTanker") {
    const ahead = (target.x - attacker.x) * Math.cos(attacker.angle) + (target.y - attacker.y) * Math.sin(attacker.angle) >= 0;
    along = ahead ? DECK_GUNS.bow : DECK_GUNS.stern;
  }
  for (let r = 0; r < SHOT_ROUNDS[kind]; r += 1) {
    game.missiles.push({
      x: attacker.x + Math.cos(attacker.angle) * along,
      y: attacker.y + Math.sin(attacker.angle) * along,
      vx: Math.cos(attacker.angle),
      vy: Math.sin(attacker.angle),
      target,
      ttl: 0.9,
      delay: r * SHOT_GAP[kind],
      owner: attacker,
      kind,
      color: SHOT_COLOR[kind]
    });
  }
}

// Light is instant: the hit is decided on the spot, but only if the beam
// has a clear line to the target. A beam that strikes rock stops there.
function fireLaser(attacker, target) {
  playLaserShot(attacker.x, attacker.y);
  const dx = target.x - attacker.x;
  const dy = target.y - attacker.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  let reach = len;
  for (const hz of hazards) {
    const along = (hz.x - attacker.x) * ux + (hz.y - attacker.y) * uy;
    if (along <= 0 || along >= reach) continue;
    const off = Math.abs((hz.x - attacker.x) * uy - (hz.y - attacker.y) * ux);
    if (off < hz.r) reach = along - Math.sqrt(hz.r * hz.r - off * off);
  }
  // Stored as a fading beam centred on its midpoint, pointing along (vx, vy).
  game.missiles.push({
    x: attacker.x + ux * reach * 0.5,
    y: attacker.y + uy * reach * 0.5,
    vx: ux,
    vy: uy,
    len: Math.max(0, reach),
    target: null,
    ttl: 0.22,
    life: 0.22,
    owner: attacker,
    kind: "laser",
    color: "#ff3df2"
  });
  if (reach >= len) resolveCannonHit(attacker, target, 1, "laser");
  else playShotHit("laser", attacker.x + ux * reach, attacker.y + uy * reach);
}

const ENEMY_DESTROYED_SCORE = 35;

// Sea creatures have no hp/capsized state (they only despawn on a lifetime
// timer), so a cannon hit forces an early despawn instead of damaging them
// the way ships and submarines are damaged. Whichever branch actually
// finishes the target off awards the attacking human ship a kill bonus.
// `share` < 1 is one round of a burst or one slug of a water jet.
function resolveCannonHit(attacker, target, share = 1, kind = "ball") {
  const attackerScores = attacker && attacker.isHuman && !target.isHuman;
  playShotHit(kind, target.x, target.y);

  if (target.isHuman !== undefined || target.aiControlled) {
    const wasAlive = !target.capsized;
    if (target.flagship) damageShip(target, (target.maxHull * share) / FLAGSHIP_HITS, `hit by ${kind}`, false, true);
    else if (share >= 1) sinkingHit(target, `hit by ${kind}`);
    else damageShip(target, target.maxHull * share, `hit by ${kind}`, false, true);
    if (wasAlive && target.capsized && attackerScores) {
      awardScore(attacker, ENEMY_DESTROYED_SCORE, "enemy destroyed");
      if (game.pirateRaiders.includes(target)) missionPirateSunk();
    }
  } else if (target.kind === "uboat" || target.kind === "submarine") {
    const wasAlive = target.hp > 0;
    target.hp -= 100 * share;
    if (wasAlive && target.hp <= 0 && attackerScores) {
      awardScore(attacker, ENEMY_DESTROYED_SCORE, "enemy destroyed");
      missionSubSunk();
    }
  } else {
    // Sea creatures have no hull: they give up once a full kill's worth has landed.
    target.shotDamage = (target.shotDamage || 0) + share;
    if (target.shotDamage < 0.999) return;
    const wasAlive = target.lifetime <= target.despawnAt;
    target.lifetime = target.despawnAt + 1;
    if (wasAlive && attackerScores) {
      awardScore(attacker, ENEMY_DESTROYED_SCORE, "enemy destroyed");
    }
  }
}

function pickAttackTarget(ship, fallbackOpponent) {
  let best = fallbackOpponent && !fallbackOpponent.capsized ? fallbackOpponent : null;
  let bestDist = best ? dist(ship, best) : Infinity;

  for (const creature of game.seaCreatures) {
    const d = dist(ship, creature);
    if (d < bestDist) {
      best = creature;
      bestDist = d;
    }
  }

  for (const raider of game.pirateRaiders) {
    if (raider.capsized) continue;
    const d = dist(ship, raider);
    if (d < bestDist) {
      best = raider;
      bestDist = d;
    }
  }

  // Guns bear on a submarine when a mission sends you after it.
  if (game.missionState && missionStage().subs) {
    for (const sub of game.underwaterEnemies) {
      const d = dist(ship, sub);
      if (sub.hp > 0 && d < bestDist) {
        best = sub;
        bestDist = d;
      }
    }
  }

  return best;
}

function fireSonicPulse(attacker, target) {
  const dx = target.x - attacker.x;
  const dy = target.y - attacker.y;
  const len = Math.hypot(dx, dy) || 1;
  playSonicPulse(attacker.x, attacker.y);
  game.missiles.push({
    x: attacker.x,
    y: attacker.y,
    vx: (dx / len) * 40,
    vy: (dy / len) * 40,
    target,
    ttl: 0.6,
    owner: attacker,
    kind: "sonic",
    color: "#63e0ff"
  });
}

function processHazards(ship, dt) {
  if (!ship || ship.capsized) return;

  for (const hz of hazards) {
    const d = dist(ship, hz);
    if (d <= hz.r + ship.radius) {
      damageShip(ship, 100, `collision with ${hz.kind}`, true);
      return;
    }
    if (d <= hz.danger) {
      const severityBase = hz.kind === "volcano" ? 34 : hz.kind === "iceberg" ? 24 : 18;
      // A hydrofoil's foils strike the shallows around land: much harder on the structure.
      const foils = ship.category === "Hydrofoil" ? HYDROFOIL_SHALLOWS_DAMAGE : 1;
      const severity = severityBase * game.settings.hazardScale * foils;
      damageShip(ship, severity * dt, `danger zone near ${hz.kind}`);
    }
  }

  if (ship.ice === "solid" && ship.category !== "Icebreaker") {
    damageShip(ship, ICE_DAMAGE * game.settings.hazardScale * dt, "grinding through pack ice");
  }

  // Storm clouds and rain do no harm themselves: the danger is the heavy
  // sea they raise (applySeaPush).

  if (waterSpout.state === "active" && dist(ship, waterSpout) <= waterSpout.r) {
    damageShip(ship, WATER_SPOUT_DAMAGE[waterSpout.kind] * game.settings.hazardScale * dt, "water spout");
  }
  // a strong spout also draws ships nearby in towards it
  if (waterSpout.state === "active" && waterSpout.kind === "strong" && !safeInHarbour(ship)) {
    const d = dist(ship, waterSpout);
    if (d > 1 && d < waterSpout.r * 2.6) {
      const pull = (1 - d / (waterSpout.r * 2.6)) * 38 * dt;
      ship.x += ((waterSpout.x - ship.x) / d) * pull;
      ship.y += ((waterSpout.y - ship.y) / d) * pull;
    }
  }
}

// Storms ride the wind: each at its own steady pace (set when it forms), in
// the wind's direction. One that blows off the sea comes back in on the
// upwind side, somewhere new. Its rain comes and goes in heavier and lighter
// spells.
const STORM_PACE = [40, 90]; // units/s
const STORM_RAIN_SPELL = [5, 16]; // seconds before the rain turns heavier or lighter
const STORM_ARRIVAL = [20, 90]; // seconds into a crossing before each storm blows in
const STORM_RETURN = [25, 100]; // s of fair weather after a storm has gone before the next blows in
const STORM_PARKED = -100000; // where a storm waits before it blows in (far off the map)

// Puts a storm `margin` units off the upwind edge: a random point on the sea,
// walked back against the wind until it's that far off the map.
function putStormUpwind(dz, ux, uy, margin) {
  const px = Math.random() * WORLD_W;
  const py = Math.random() * WORLD_H;
  const tx = ux > 0 ? (px + margin) / ux : ux < 0 ? (WORLD_W + margin - px) / -ux : Infinity;
  const ty = uy > 0 ? (py + margin) / uy : uy < 0 ? (WORLD_H + margin - py) / -uy : Infinity;
  const back = Math.min(tx, ty) - 1;
  dz.x = px - ux * back;
  dz.y = py - uy * back;
}

function updateDynamicDangers(dt) {
  const w = Math.hypot(game.wind.x, game.wind.y) || 1;
  const ux = game.wind.x / w;
  const uy = game.wind.y / w;
  for (const dz of dynamicDangers) {
    if (dz.arriveIn > 0) {
      // Still waiting, parked far off the map (beyond its haze and seas).
      dz.arriveIn -= dt;
      if (dz.arriveIn <= 0) putStormUpwind(dz, ux, uy, dz.r + 200);
      continue;
    }
    dz.vx = ux * dz.pace;
    dz.vy = uy * dz.pace;
    dz.x += dz.vx * dt;
    dz.y += dz.vy * dt;

    const m = dz.r + 200;
    if (dz.x < -m || dz.x > WORLD_W + m || dz.y < -m || dz.y > WORLD_H + m) {
      // blown off the sea: fine weather for a spell, then it comes back in upwind
      dz.arriveIn = randomInterval(STORM_RETURN);
      dz.x = STORM_PARKED;
      dz.y = STORM_PARKED;
    }

    dz.rainTimer -= dt;
    if (dz.rainTimer <= 0) {
      dz.rainTarget = 0.25 + Math.random() * 0.75;
      dz.rainTimer = randomInterval(STORM_RAIN_SPELL);
    }
    dz.rain += (dz.rainTarget - dz.rain) * Math.min(1, dt / 3);
  }
}

// Wave height grows with the square of the wind speed (a fully developed sea:
// significant height ~ 0.025 x wind^2), so a gust barely moves it but a gale
// builds a heavy sea. Near a storm cell the sea runs high. The sea builds and
// eases off over a few seconds instead of jumping with every gust. The 3D
// sea is one shared sea, so it follows the roughest water any player is in.
function windSea() {
  const windKn = Math.hypot(game.wind.x, game.wind.y) * WIND_KNOTS_PER_UNIT;
  return SEA_SWELL_FLOOR + (windKn / SEA_STORM_KNOTS) ** 2;
}

// 0..1: how close the nearest storm is (1 under it, 0 past its seas' reach).
function stormNearness(x, y) {
  let near = tempest.intensity; // a tempest covers the whole sea
  for (const dz of dynamicDangers) {
    if (dz.kind !== "storm") continue;
    const edge = clamp((Math.hypot(x - dz.x, y - dz.y) - dz.r) / STORM_SEA_REACH, 0, 1);
    near = Math.max(near, 1 - edge * edge * (3 - 2 * edge));
  }
  return near;
}

// Swell height factor from the wind: little below about 8 knots, up to nearly double in a gale.
function windSwell() {
  const kn = windKnots();
  return 1 + WIND_SWELL_MAX * clamp((kn - 8) / 24, 0, 1) ** 1.2;
}

function updateSeaState(dt) {
  let near = 0;
  for (const ship of humanShips()) near = Math.max(near, stormNearness(ship.x, ship.y));
  const shelter = game.mission ? game.mission.calm : 1; // rivers and fjords stay calmer
  const target = clamp(Math.max(windSea(), STORM_SEA * near), 0, 1) * shelter;
  // The sea builds quickly with the wind and dies down slowly after it.
  const rate = (goal, now) => Math.min(1, dt / (goal > now ? SEA_BUILD_TIME : SEA_CALM_TIME));
  sea.roughness += (target - sea.roughness) * rate(target, sea.roughness);

  // Swell sets: now and then the sea turns towards a new random size, some
  // times smaller, some times bigger, easing there over several seconds.
  sea.setTimer -= dt;
  if (sea.setTimer <= 0) {
    sea.setsTarget = SEA_SETS[0] + (SEA_SETS[1] - SEA_SETS[0]) * Math.random() ** 1.3;
    sea.setTimer = randomInterval(SEA_SET_TIME);
  }
  sea.sets += (sea.setsTarget - sea.sets) * Math.min(1, dt / 5);
  const swellTarget = sea.sets * (1 + STORM_SWELL_BOOST * near) * windSwell() * shelter;
  sea.swell += (swellTarget - sea.swell) * rate(swellTarget, sea.swell);
}

// A heavy sea shoves a ship about: the waves swing its head off course (worst
// with the sea on the bow or quarter), carry it along as each crest passes,
// and slow it when it drives into them. The helmsman has to keep steering it
// back. Felt only in rough water: near a storm or in a strong wind.
// Inside a harbour the breakwaters take the wind and the sea down to a gentle
// swell: a ship that is not tied up or at anchor rocks slowly to and fro with
// it (the waves under it are calmed the same way in render3d.js) instead of
// being blown against the quay.
const HARBOUR_WIND_SHELTER = 0.1; // share of the wind that reaches the basin
const HARBOUR_SWELL_SPEED = 3.5; // units/s: the slow surge of the harbour swell
const HARBOUR_SWELL_YAW = 0.02; // rad/s
function applyHarbourSwell(ship, dt) {
  const wave = Math.sin(game.elapsed * 0.8 + ship.x * 0.01);
  ship.x += Math.cos(SEA_WAVE_DIR) * HARBOUR_SWELL_SPEED * wave * dt;
  ship.y += Math.sin(SEA_WAVE_DIR) * HARBOUR_SWELL_SPEED * wave * dt;
  ship.angle += HARBOUR_SWELL_YAW * Math.cos(game.elapsed * 0.6 + ship.y * 0.01) * dt;
}

function applySeaPush(ship, dt) {
  if (safeInHarbour(ship)) return;
  // the same (smoothed) sea the 3D view draws, so the push builds and fades with the waves
  const rough = sea.roughness;
  const swell = sea.swell;
  let force = clamp((rough - 0.3) / 0.7, 0, 1) * swell * (1 - ship.windResistance);
  if (ship.owned && ship.owned.tempestScrambler) force *= 0.5;
  force *= 1 - 0.4 * crewSkill(ship, "helm");
  if (force <= 0) return;

  const dirX = Math.cos(SEA_WAVE_DIR);
  const dirY = Math.sin(SEA_WAVE_DIR);
  const k = (Math.PI * 2) / SEA_WAVE_LEN;
  const phase = k * (dirX * ship.x + dirY * ship.y) - Math.sqrt(9.8 * k) * game.elapsed;
  const crest = Math.sin(phase); // +1 on a crest, -1 in a trough
  const rel = normalizeAngle(SEA_WAVE_DIR - ship.angle); // where the sea comes at the hull from

  ship.angle += SEA_PUSH_YAW * force * Math.sin(2 * rel) * crest * dt;
  const shove = SEA_PUSH_DRIFT * force * Math.max(0, crest);
  ship.x += dirX * shove * dt;
  ship.y += dirY * shove * dt;
  // Bow into the sea: each wave slows the ship.
  ship.speed *= 1 - SEA_PUSH_DRAG * force * Math.max(0, -Math.cos(rel)) * dt;

  if (ship.isHuman && force > 0.6 && game.elapsed - (ship.heavySeaHintAt || -99) > 25) {
    ship.heavySeaHintAt = game.elapsed;
    setUiMessage(`${ship.playerName || "Ship"}: heavy seas - keep steering, the waves are pushing you off course`);
  }
}

// Steady wind: the round's direction veers only a few degrees, slowly, and
// the strength gusts around its base.
function updateWind(dt) {
  const t = game.elapsed;
  const dir = game.windDir + WIND_VEER * Math.sin(t * 0.05) * Math.sin(t * 0.017 + 1.3);
  // a tempest brings a gale (after the rain has set in)
  const gale = 1 + 0.8 * clamp((tempest.intensity - 0.15) / 0.85, 0, 1);
  const speed = game.windBase * (1 + 0.22 * Math.sin(t * 0.31) + 0.1 * Math.sin(t * 1.13 + 0.7)) * game.settings.windScale * gale;
  game.wind.x += (Math.cos(dir) * speed - game.wind.x) * Math.min(1, dt * 1.6);
  game.wind.y += (Math.sin(dir) * speed - game.wind.y) * Math.min(1, dt * 1.6);
  // the wind speed is logged every second (knots), for the bridge's wind instrument and its trend graph
  if (!game.windLog) game.windLog = [];
  if (t - (game.windLogAt || -9) >= 1) {
    game.windLogAt = t;
    const kn = windKnots();
    game.windLog.push(kn);
    if (game.windLog.length > 90) game.windLog.shift();
    game.windMax = Math.max(game.windMax || 0, kn);
  }
}

function hazardPresenceRadius(e) {
  if (e.clear !== undefined) return e.clear; // a harbour: keep drifting ice off its land
  return e.danger !== undefined ? e.danger : e.r;
}

function hazardMass(e) {
  // Anything without its own drift velocity (islands, the volcano, harbours)
  // is treated as an immovable obstacle.
  return e.vx === undefined ? Infinity : e.r * e.r;
}

// Generic elastic-ish separation used for every hazard pair except
// iceberg<->volcano, which uses the dedicated sticking behavior instead.
function resolveEntityCollision(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distSq = dx * dx + dy * dy;
  const minDist = hazardPresenceRadius(a) + hazardPresenceRadius(b);
  if (distSq >= minDist * minDist) return;

  const d = Math.sqrt(distSq) || 0.001;
  const nx = dx / d;
  const ny = dy / d;

  const massA = hazardMass(a);
  const massB = hazardMass(b);
  const invA = Number.isFinite(massA) ? 1 / massA : 0;
  const invB = Number.isFinite(massB) ? 1 / massB : 0;
  const invTotal = invA + invB;
  if (invTotal === 0) return; // both immovable

  const overlap = minDist - d;
  a.x -= nx * overlap * (invA / invTotal);
  a.y -= ny * overlap * (invA / invTotal);
  b.x += nx * overlap * (invB / invTotal);
  b.y += ny * overlap * (invB / invTotal);

  const avx = a.vx || 0, avy = a.vy || 0;
  const bvx = b.vx || 0, bvy = b.vy || 0;
  const relVel = (bvx - avx) * nx + (bvy - avy) * ny;
  if (relVel > 0) return; // already separating

  const restitution = 0.6;
  const impulse = (-(1 + restitution) * relVel) / invTotal;
  a.vx = avx - impulse * nx * invA;
  a.vy = avy - impulse * ny * invA;
  b.vx = bvx + impulse * nx * invB;
  b.vy = bvy + impulse * ny * invB;

  if (a.stuck) a.stuck = false;
  if (b.stuck) b.stuck = false;
}

// Storms are weather, not solid obstacles: they drift freely over icebergs,
// islands, and volcanoes with no collision response. Everything else that
// occupies fixed or physical space on the map (icebergs, islands, volcano,
// harbours) keeps clear of each other here.
function updateHazardCollisions() {
  const obstacles = [...hazards, HarbourA, HarbourB];
  for (let i = 0; i < obstacles.length; i++) {
    for (let j = i + 1; j < obstacles.length; j++) {
      const a = obstacles[i];
      const b = obstacles[j];
      const isIcebergVolcanoPair =
        (a.kind === "iceberg" && b.kind === "volcano") || (a.kind === "volcano" && b.kind === "iceberg");
      if (isIcebergVolcanoPair) continue; // handled by stickIcebergToVolcano
      resolveEntityCollision(a, b);
    }
  }
}

// Harbour land is solid: a hull can't pass through a quay, breakwater or a
// moored boat. Bumping it does no damage (fenders); the ship is pushed back
// off it. The push back matches the speed it hit with, less what the fenders
// and the hull soak up (QUAY_RESTITUTION: the share given back). Its own way
// into the quay is stopped, while sliding along the quay carries on.
const QUAY_RESTITUTION = 0.35; // rubber fenders absorb about two thirds of a bump
const QUAY_GENTLE = 22; // a touch slower than this is a soft contact (units/s)
const QUAY_MIN_PUSH = 18; // even a touch eases the hull off the quay (units/s)

function updateLandCollisions() {
  // The computer's galley keeps her own course, so to others she is as solid as a quay.
  const pieces = game.galley ? [...HARBOUR_LAND, hullSegment(game.galley.boat)] : HARBOUR_LAND;
  for (const ship of allCombatShips()) {
    if (ship.warping) continue; // being eased alongside its berth
    for (const piece of pieces) {
      const hit = bounceOffLand(ship, piece);
      if (hit >= 0) bumpSound(ship, ship, hit);
    }
    if (game.mission) bounceOffBank(ship);
  }
}

// Returns how hard the hull hit (0..1) for the sound, or -1 when clear.
function bounceOffLand(ship, piece) {
  const reach = piece.r + BUMP_SHAPE.Carrier.h + BUMP_SHAPE.Carrier.r;
  if (Math.min(Math.abs(ship.x - piece.ax), Math.abs(ship.x - piece.bx)) > reach + Math.abs(piece.bx - piece.ax)) return -1;
  if (Math.min(Math.abs(ship.y - piece.ay), Math.abs(ship.y - piece.by)) > reach + Math.abs(piece.by - piece.ay)) return -1;
  const hull = hullSegment(ship);
  const cp = closestOnSegments(hull, piece);
  let dx = cp.px - cp.qx;
  let dy = cp.py - cp.qy;
  let d = Math.hypot(dx, dy);
  const minDist = hull.r + piece.r;
  if (d >= minDist) return -1;
  if (d < 0.001) {
    // Centre line across the land's: push out towards the ship's middle.
    dx = ship.x - cp.qx;
    dy = ship.y - cp.qy;
    d = 0;
  }
  const len = Math.hypot(dx, dy) || 1;
  const nx = dx / len; // away from the land
  const ny = dy / len;
  ship.x += nx * (minDist - d);
  ship.y += ny * (minDist - d);
  return reboundOff(ship, nx, ny);
}

// A hull pushed off land along (nx, ny): stops its way into it and bounces it.
// Returns how hard it hit (0..1).
function reboundOff(ship, nx, ny) {
  const v = bodyVelocity(ship);
  const closing = Math.max(0, -(v.x * nx + v.y * ny)); // speed into the land
  // Own way into the land stops; the part along the quay is kept.
  const along = Math.cos(ship.angle) * nx + Math.sin(ship.angle) * ny;
  if (ship.speed * along < 0) ship.speed *= 1 - Math.abs(along);
  const stillIn = Math.max(0, -ship.speed * along);
  // Knockback towards the land is cancelled, then the rebound is added.
  const kn = (ship.kx || 0) * nx + (ship.ky || 0) * ny;
  if (kn < 0) {
    ship.kx -= nx * kn;
    ship.ky -= ny * kn;
  }
  // Resting against the fenders (drifting in at a crawl) is a soft touch: no
  // shove back and no thud, so a ship moving with the swell just lies there.
  const gentle = closing < QUAY_GENTLE && stillIn === 0;
  const rebound = stillIn + (gentle ? closing * 0.2 : Math.max(QUAY_MIN_PUSH, closing * QUAY_RESTITUTION));
  ship.kx = (ship.kx || 0) + nx * rebound;
  ship.ky = (ship.ky || 0) + ny * rebound;
  return gentle ? 0.05 : clamp(closing / 300, 0.15, 1);
}

// Ships have no hazard-style danger radius, so they can sail right up next
// to each other; only their hulls (radius) should block passage.
function updateShipCollisions(dt) {
  const ships = allCombatShips();
  for (let i = 0; i < ships.length; i++) {
    for (let j = i + 1; j < ships.length; j++) {
      const a = ships[i];
      const b = ships[j];
      const hit = bounceApart(a, b);
      if (hit < 0) continue;
      bumpSound(a, b, hit);
      // In harbour only nature does damage: bumping another ship there is harmless.
      if (!safeInHarbour(a)) damageShip(a, 26 * dt, `hull scrape with ${b.shipName || b.playerName || "ship"}`);
      if (!safeInHarbour(b)) damageShip(b, 26 * dt, `hull scrape with ${a.shipName || a.playerName || "ship"}`);
    }
  }
}

// Bumping: ships, sea monsters and submarines bounce off each other instead
// of sliding through. Each body has a weight and a springiness; the lighter
// one is thrown back harder (a sailing boat flies off a carrier, the carrier
// barely moves), and monsters shove back hardest of all. The push is a
// "knockback" velocity (kx, ky) that fades over about a second.
const BUMP_BODY = {
  Sailing: { mass: 0.8, spring: 0.5 },
  Carrack: { mass: 2, spring: 0.35 },
  Galley: { mass: 1.4, spring: 0.45 },
  Catamaran: { mass: 1, spring: 0.5 },
  Futuristic: { mass: 1.2, spring: 0.5 },
  Hydrofoil: { mass: 0.9, spring: 0.5 },
  Assault: { mass: 1.8, spring: 0.45 },
  Cruise: { mass: 2, spring: 0.4 },
  Cargo: { mass: 2.6, spring: 0.35 },
  Carrier: { mass: 3.2, spring: 0.3 },
  Tug: { mass: 1.6, spring: 0.6 }, // rubber fenders all round
  Icebreaker: { mass: 2.4, spring: 0.35 },
  Tanker: { mass: 3, spring: 0.3 },
  GasTanker: { mass: 2.9, spring: 0.3 },
  WarTanker: { mass: 2.7, spring: 0.32 },
  ship: { mass: 1.6, spring: 0.45 }, // pirates and anything else
  creature: { mass: 3.5, spring: 0.95 },
  croc: { mass: 0.4, spring: 0.1 },
  submarine: { mass: 2.4, spring: 0.6 },
  uboat: { mass: 2.8, spring: 0.6 }
};
const BUMP_MIN_PUSH = 70; // even a gentle touch pushes this hard (units/s)

// Hull shapes for bumping, matched to the 3D models: a capsule (a line along
// the heading, `h` either side of the centre shifted by `off`, rounded by
// radius `r`). A single small circle let long hulls sink into each other.
// Sized from the drawn ships (SHIP_SIZE in render3d.js): h = half the length
// minus r, r = half the beam.
const BUMP_SHAPE = {
  Cruise: { h: 42.75, r: 6.25, off: 0 }, // 98 x 12.5 (300 m liner)
  Cargo: { h: 28, r: 10, off: 0 },
  Sailing: { h: 8.5, r: 4.5, off: 0 },
  Carrack: { h: 15, r: 7, off: 0 },
  Galley: { h: 21, r: 5, off: 0 },
  Catamaran: { h: 7, r: 8, off: 0 },
  Assault: { h: 23, r: 11, off: 0 },
  Carrier: { h: 47.4, r: 7.1, off: 0 }, // 109 long, hull 14 wide (333 m supercarrier)
  Futuristic: { h: 20, r: 9, off: 0 },
  Hydrofoil: { h: 13.5, r: 6.5, off: 0 },
  Tug: { h: 9.2, r: 7.8, off: 0 },
  Icebreaker: { h: 20.5, r: 10.5, off: 0 },
  Tanker: { h: 29.9, r: 12.1, off: 0 },
  GasTanker: { h: 30.6, r: 12.4, off: 0 },
  WarTanker: { h: 26.5, r: 5.5, off: 0 }, // 64 x 11 (135 m wartime tanker)
  ship: { h: 17, r: 8, off: 0 }, // 50 x 16 pirate galleons
  creature: { h: 23, r: 9.5, off: -5 },
  submarine: { h: 13, r: 5.5, off: 0 },
  uboat: { h: 13, r: 5.5, off: 0 }
};

function bumpShape(e) {
  if (e.kind === "uboat" || e.kind === "submarine") return BUMP_SHAPE[e.kind];
  if (e.maxHull === undefined) return BUMP_SHAPE.creature;
  return BUMP_SHAPE[e.category] || BUMP_SHAPE.ship;
}

function hullSegment(e) {
  const s = bumpShape(e);
  const c = Math.cos(e.angle);
  const n = Math.sin(e.angle);
  const cx = e.x + c * s.off;
  const cy = e.y + n * s.off;
  return { ax: cx - c * s.h, ay: cy - n * s.h, bx: cx + c * s.h, by: cy + n * s.h, r: s.r };
}

// Closest points between two line segments (the two hull centre lines).
function closestOnSegments(p, q) {
  const d1x = p.bx - p.ax, d1y = p.by - p.ay;
  const d2x = q.bx - q.ax, d2y = q.by - q.ay;
  const rx = p.ax - q.ax, ry = p.ay - q.ay;
  const a = d1x * d1x + d1y * d1y;
  const e = d2x * d2x + d2y * d2y;
  const f = d2x * rx + d2y * ry;
  const c = d1x * rx + d1y * ry;
  const b = d1x * d2x + d1y * d2y;
  const denom = a * e - b * b;
  let s = denom > 1e-6 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
  let t = (b * s + f) / e;
  if (t < 0) {
    t = 0;
    s = clamp(-c / a, 0, 1);
  } else if (t > 1) {
    t = 1;
    s = clamp((b - c) / a, 0, 1);
  }
  return { px: p.ax + d1x * s, py: p.ay + d1y * s, qx: q.ax + d2x * t, qy: q.ay + d2y * t };
}

function bumpBody(e) {
  if (e.variant === "croc") return BUMP_BODY.croc; // far lighter than a sea monster
  if (e.kind === "uboat" || e.kind === "submarine") return BUMP_BODY[e.kind];
  if (e.maxHull === undefined) return BUMP_BODY.creature;
  return BUMP_BODY[e.category] || BUMP_BODY.ship;
}

function bodyVelocity(e) {
  return {
    x: Math.cos(e.angle) * (e.speed || 0) + (e.kx || 0),
    y: Math.sin(e.angle) * (e.speed || 0) + (e.ky || 0)
  };
}

// Knockback moves a body and dies away (called from each body's update).
function applyKnockback(e, dt) {
  if (!e.kx && !e.ky) return;
  e.x += e.kx * dt;
  e.y += e.ky * dt;
  const fade = Math.exp(-dt * 2.6);
  e.kx *= fade;
  e.ky *= fade;
  if (Math.abs(e.kx) + Math.abs(e.ky) < 2) e.kx = e.ky = 0;
}

// Pushes two overlapping bodies apart and bounces them. Returns how hard
// they hit (0..1) for sounds, or -1 when they aren't touching.
function bounceApart(a, b) {
  // Quick reject before the exact hull test.
  const reach = 2 * (BUMP_SHAPE.creature.h + BUMP_SHAPE.creature.r + 10);
  if (Math.abs(b.x - a.x) > reach || Math.abs(b.y - a.y) > reach) return -1;
  const sa = hullSegment(a);
  const sb = hullSegment(b);
  const cp = closestOnSegments(sa, sb);
  let dx = cp.qx - cp.px;
  let dy = cp.qy - cp.py;
  let d = Math.hypot(dx, dy);
  const minDist = sa.r + sb.r;
  if (d >= minDist) return -1;
  if (d < 0.001) {
    // Centre lines cross: push apart along the line between the centres.
    dx = b.x - a.x || 0.001;
    dy = b.y - a.y;
    d = 0;
  }
  const len = Math.hypot(dx, dy);
  const nx = dx / len;
  const ny = dy / len;
  const A = bumpBody(a);
  const B = bumpBody(b);
  const invA = 1 / A.mass;
  const invB = 1 / B.mass;
  // Out of the overlap, the lighter body moving more.
  const overlap = minDist - d;
  a.x -= nx * overlap * (invA / (invA + invB));
  a.y -= ny * overlap * (invA / (invA + invB));
  b.x += nx * overlap * (invB / (invA + invB));
  b.y += ny * overlap * (invB / (invA + invB));
  // How fast they were closing along the line between them.
  const va = bodyVelocity(a);
  const vb = bodyVelocity(b);
  const closing = (va.x - vb.x) * nx + (va.y - vb.y) * ny;
  const spring = Math.max(A.spring, B.spring);
  const push = Math.max(BUMP_MIN_PUSH, closing) * (1 + spring);
  const impulse = push / (invA + invB);
  a.kx = (a.kx || 0) - nx * impulse * invA;
  a.ky = (a.ky || 0) - ny * impulse * invA;
  b.kx = (b.kx || 0) + nx * impulse * invB;
  b.ky = (b.ky || 0) + ny * impulse * invB;
  // A ship driving into the contact loses most of its way.
  for (const [e, sign] of [[a, 1], [b, -1]]) {
    if (e.maxHull === undefined || e.speed === undefined || e.kind) continue;
    const into = (Math.cos(e.angle) * nx + Math.sin(e.angle) * ny) * sign;
    if (into > 0.2 && e.speed > 0) e.speed *= 1 - 0.7 * into;
  }
  return clamp(closing / 300, 0.15, 1);
}

// One knock per contact, not one per frame while the hulls grind.
function bumpSound(a, b, strength) {
  const now = game.elapsed;
  if (now - (a.lastBumpAt || -9) < 0.9 || now - (b.lastBumpAt || -9) < 0.9) return;
  if (a === b && strength < 0.15) return;
  a.lastBumpAt = now;
  b.lastBumpAt = now;
  playBump((a.x + b.x) / 2, (a.y + b.y) / 2, strength);
}

function stickIcebergToVolcano(hz) {
  for (const other of hazards) {
    if (other.kind !== "volcano") continue;
    const dx = hz.x - other.x;
    const dy = hz.y - other.y;
    const d = Math.hypot(dx, dy);
    const minDist = hz.danger + other.danger;
    if (d <= minDist) {
      const nx = d === 0 ? 1 : dx / d;
      const ny = d === 0 ? 0 : dy / d;
      hz.x = other.x + nx * minDist;
      hz.y = other.y + ny * minDist;
      hz.vx = 0;
      hz.vy = 0;
      hz.stuck = true;
      hz.stuckVolcano = other;
      return;
    }
  }
}

function updateIcebergs(dt) {
  const icebergs = hazards.filter((hz) => hz.kind === "iceberg");

  for (const hz of icebergs) {
    if (hz.stuck) {
      const volcano = hz.stuckVolcano;
      const dx = hz.x - volcano.x;
      const dy = hz.y - volcano.y;
      const d = Math.hypot(dx, dy) || 1;
      const nx = dx / d;
      const ny = dy / d;

      // Only the wind component blowing away from the volcano can free it.
      const windAway = game.wind.x * nx + game.wind.y * ny;
      if (windAway > 0) {
        hz.x += nx * windAway * 0.55 * dt;
        hz.y += ny * windAway * 0.55 * dt;
        const minDist = hz.danger + volcano.danger;
        if (Math.hypot(hz.x - volcano.x, hz.y - volcano.y) > minDist + 2) {
          hz.stuck = false;
          hz.stuckVolcano = null;
          hz.vx = game.wind.x;
          hz.vy = game.wind.y;
        }
      }
      continue;
    }

    hz.x += (hz.vx + game.wind.x * 0.55) * dt;
    hz.y += (hz.vy + game.wind.y * 0.55) * dt;

    if (hz.x < 80 || hz.x > WORLD_W - 80) hz.vx *= -1;
    if (hz.y < 80 || hz.y > WORLD_H - 80) hz.vy *= -1;

    hz.x = clamp(hz.x, 70, WORLD_W - 70);
    hz.y = clamp(hz.y, 70, WORLD_H - 70);

    stickIcebergToVolcano(hz);
    // Off a mission's banks.
    const out = game.mission && keepAfloat(hz, hz.r + 6);
    if (out && hz.vx * out.x + hz.vy * out.y < 0) {
      const into = hz.vx * out.x + hz.vy * out.y;
      hz.vx -= 2 * into * out.x;
      hz.vy -= 2 * into * out.y;
    }
  }
}

// Enemies (pirate raiders, sea monsters, submarines) appear beyond the map
// edge, outside the buoy line, facing in, and come in gradually. Only where
// the water inside the edge is open: never off the harbours' coast, so they
// can't turn up on land. `entering` lifts the map-edge clamp until they are in.
const ENTRY_OUTSIDE = 90; // how far beyond the edge they appear
const ENTRY_CLEAR = 160; // the water this far around the entry must be clear of land

function randomEdgeSpawn() {
  if (game.mission) return missionWaterSpawn();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const edge = Math.floor(Math.random() * 4);
    const along = Math.random();
    const [ix, iy] = [[1, 0], [-1, 0], [0, 1], [0, -1]][edge]; // inward
    const ex = edge === 0 ? 0 : edge === 1 ? WORLD_W : 80 + along * (WORLD_W - 160);
    const ey = edge === 2 ? 0 : edge === 3 ? WORLD_H : 80 + along * (WORLD_H - 160);
    const clear = Math.min(landClearance(ex, ey), landClearance(ex + ix * ENTRY_CLEAR, ey + iy * ENTRY_CLEAR));
    if (clear < ENTRY_CLEAR) continue;
    return { x: ex - ix * ENTRY_OUTSIDE, y: ey - iy * ENTRY_OUTSIDE, angle: Math.atan2(iy, ix), entering: true };
  }
  return { x: WORLD_W / 2, y: -ENTRY_OUTSIDE, angle: Math.PI / 2, entering: true }; // the middle of the top edge is always open
}

// Once an entering enemy is inside the map, the map edge holds it as usual.
function stillEntering(e, margin) {
  return e.entering && !(e.x > margin && e.x < WORLD_W - margin && e.y > margin && e.y < WORLD_H - margin) ? true : (e.entering = false);
}

// Raiders appear at the map edge, but never inside or beside a hazard: take
// the calmest of several candidate edge points, heading roughly inward.
function safeRaiderSpawn() {
  let best = null;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const p = randomEdgeSpawn();
    let risk = 0;
    for (const hz of hazards) {
      const gap = dist(p, hz) - hz.danger;
      if (gap < 70) risk += 70 - gap;
    }
    for (const dz of dynamicDangers) {
      const gap = dist(p, dz) - dz.r;
      if (gap < 50) risk += 50 - gap;
    }
    if (!best || risk < best.risk) best = { ...p, risk };
    if (risk === 0) break;
  }
  return best;
}

function spawnPirateRaider() {
  const p = safeRaiderSpawn();
  game.pirateRaiders.push({
    ...newShip("pirate", p.x, p.y, p.angle + (Math.random() - 0.5) * 0.6),
    entering: true,
    aiControlled: true,
    maxSpeed: 210,
    turnRate: 1.46,
    lifetime: 0,
    despawnAt: (game.mission?.raiderLife || 17) + Math.random() * 8,
    motionSeed: Math.random() * Math.PI * 2
  });
}

function spawnUnderwaterEnemy() {
  const p = randomEdgeSpawn();
  const isUBoat = Math.random() < 0.5;
  game.underwaterEnemies.push({
    kind: isUBoat ? "uboat" : "submarine",
    x: p.x,
    y: p.y,
    angle: p.angle,
    entering: true,
    speed: isUBoat ? 84 : 98,
    radius: 18,
    maxHull: isUBoat ? 118 : 104,
    hp: isUBoat ? 118 : 104,
    capsized: false,
    motionSeed: Math.random() * Math.PI * 2,
    lifetime: 0,
    despawnAt: 30 + Math.random() * 18,
    reload: 0,
    lockTime: 0,
    target: null,
    color: isUBoat ? "#be6d5f" : "#6b8fb7"
  });
}

function chooseNearestShip(source) {
  const ships = allCombatShips().filter((ship) => !safeInHarbour(ship));
  if (ships.length === 0) return null;
  let bestShip = ships[0];
  let bestDist = dist(source, bestShip);
  for (let i = 1; i < ships.length; i += 1) {
    const current = ships[i];
    const currentDist = dist(source, current);
    if (currentDist < bestDist) {
      bestShip = current;
      bestDist = currentDist;
    }
  }
  return bestShip;
}

function updateUnderwaterEnemies(dt) {
  if (gameState !== "playing") return;

  const threats = voyageThreats();
  if (game.elapsed >= game.nextUnderwaterSpawnAt && game.underwaterEnemies.length < threats.underwaterCap && threatSlotOpen()) {
    claimThreatSlot();
    spawnUnderwaterEnemy();
    game.nextUnderwaterSpawnAt = game.elapsed + randomInterval(threats.underwaterInterval);
  }

  for (let i = game.underwaterEnemies.length - 1; i >= 0; i -= 1) {
    const enemy = game.underwaterEnemies[i];
    enemy.lifetime += dt;
    enemy.reload = Math.max(0, enemy.reload - dt);

    if (enemy.lifetime > enemy.despawnAt || enemy.hp <= 0) {
      game.underwaterEnemies.splice(i, 1);
      continue;
    }

    const target = chooseNearestShip(enemy);
    enemy.target = target;
    if (!target) {
      continue;
    }

    const desired = Math.atan2(target.y - enemy.y, target.x - enemy.x);
    const wander = Math.sin(game.elapsed * 1.7 + enemy.motionSeed) * 0.18;
    const turnErr = normalizeAngle(desired + wander - enemy.angle);
    enemy.angle += clamp(turnErr, -1.45 * dt, 1.45 * dt);
    enemy.x += Math.cos(enemy.angle) * enemy.speed * dt;
    enemy.y += Math.sin(enemy.angle) * enemy.speed * dt;
    applyKnockback(enemy, dt);
    if (!stillEntering(enemy, 20)) {
      enemy.x = clamp(enemy.x, 20, WORLD_W - 20);
      enemy.y = clamp(enemy.y, 20, WORLD_H - 20);
    }
    blockEntityFromHazards(enemy);
    // Ships bounce off a submarine's hull instead of sailing through it.
    for (const ship of allCombatShips()) {
      const hit = bounceApart(ship, enemy);
      if (hit >= 0) bumpSound(ship, enemy, hit);
    }

    const targetDist = dist(enemy, target);
    const facing = Math.abs(normalizeAngle(desired - enemy.angle));
    const lockReady = targetDist < 250 && facing < 0.36;

    if (lockReady && enemy.reload <= 0) {
      enemy.lockTime += dt;
      if (target.isHuman && enemy.lockTime > 0.18) {
        addTargetAlert(target, enemy, enemy.kind === "uboat" ? "U-BOAT LOCK" : "SUB LOCK");
      }
      if (enemy.lockTime >= 1.2) {
        playTorpedoLaunch(enemy.x, enemy.y);
        game.missiles.push({
          x: enemy.x,
          y: enemy.y,
          vx: Math.cos(enemy.angle) * 60,
          vy: Math.sin(enemy.angle) * 60,
          target,
          ttl: 5.4,
          owner: enemy,
          kind: "torpedo",
          color: "#ff6d63"
        });
        enemy.lockTime = 0;
        enemy.reload = enemy.kind === "uboat" ? 6.8 : 5.2;
      }
    } else {
      enemy.lockTime = 0;
    }
  }
}

// Pirates sail against a lone captain in Free Play, and in any mission.
function piratesAbout() {
  return mode === "single" || !!game.mission;
}

function updatePirateRaiders(dt) {
  if (!piratesAbout() || gameState !== "playing") return;

  const threats = voyageThreats();
  // Only one pirate ship on the water at a time: a raider waits until the
  // CPU pirate has sunk and no other raider is still afloat.
  const livePirates = (game.ai && !game.ai.capsized ? 1 : 0) + game.pirateRaiders.filter((r) => !r.capsized).length;
  if (game.elapsed >= game.nextRaiderSpawnAt && game.pirateRaiders.length < threats.raiderCap && livePirates === 0 && threatSlotOpen()) {
    claimThreatSlot();
    spawnPirateRaider();
    game.nextRaiderSpawnAt = game.elapsed + randomInterval(threats.raiderInterval);
  }

  for (let i = game.pirateRaiders.length - 1; i >= 0; i -= 1) {
    const raider = game.pirateRaiders[i];
    raider.lifetime += dt;

    if (raider.lifetime > raider.despawnAt) {
      game.pirateRaiders.splice(i, 1);
      continue;
    }

    const humanTargets = humanShips().filter((s) => !s.capsized);
    if (humanTargets.length === 0) {
      game.pirateRaiders.splice(i, 1);
      continue;
    }

    let player = humanTargets[0];
    let playerDistance = dist(raider, player);
    for (let h = 1; h < humanTargets.length; h += 1) {
      const d = dist(raider, humanTargets[h]);
      if (d < playerDistance) {
        player = humanTargets[h];
        playerDistance = d;
      }
    }

    // Raiders hunt from the moment they appear, but harbour waters are
    // protected: a ship sheltering there is left alone and the raider
    // loiters at a distance instead of pressing in.
    const deterred = raider.deterredUntil > game.elapsed;
    const protectedPrey = inHarbourSanctuary(player) || deterred;
    const closeToPlayer = playerDistance < 155 && !protectedPrey;
    let target;
    if (deterred) {
      target = deterredGoal(raider);
    } else if (protectedPrey) {
      const awayX = raider.x - player.x;
      const awayY = raider.y - player.y;
      const awayLen = Math.hypot(awayX, awayY) || 1;
      target = {
        x: clamp(player.x + (awayX / awayLen) * 300, 60, WORLD_W - 60),
        y: clamp(player.y + (awayY / awayLen) * 300, 60, WORLD_H - 60)
      };
    } else {
      target = { x: player.x, y: player.y };
    }

    // Chase where the prey is heading, not where it was.
    const steerTo = pirateSteerPoint(raider, target);
    const atGoal = steerTo === target;
    const leadPrey = atGoal && !protectedPrey;
    const raiderInput = navigatePirate(raider, steerTo, player, {
      arrive: protectedPrey && atGoal,
      aim: leadPrey,
      goalVx: leadPrey ? Math.cos(player.angle) * player.speed : 0,
      goalVy: leadPrey ? Math.sin(player.angle) * player.speed : 0
    });

    applyMovement(raider, braceForTsunami(raider, raiderInput), dt);
    processHazards(raider, dt);

    if (closeToPlayer && game.elapsed > 10) {
      attack(raider, player, dt);
    }
    if (!protectedPrey) plunderShip(raider, player, dt);

    if (raider.capsized) {
      game.pirateRaiders.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Pirate seamanship. Pirates look ahead along a fan of candidate headings and
// pick the one that best balances "toward the goal" against "clear water",
// the way a captain reads the sea ahead instead of reacting at the last
// moment. Every danger a ship can take damage from is scored, using each
// one's predicted position at the time the pirate would get there.
// ---------------------------------------------------------------------------
// How much a hull wants to stay out of each kind of trouble. Volcanoes are
// the worst (most damage per second), so they get the widest berth.
const NAV_HAZARD_WEIGHT = { volcano: 2.6, iceberg: 2.0, island: 1.8 };

// Caution grows as the pirate's hull gets damaged: wider safety margin and
// more respect for the prey's cannons.
function pirateCaution(ship) {
  const hull = clamp(ship.hp / (ship.maxHull || 100), 0, 1);
  return 1 + (1 - hull) * 1.2;
}

// Danger of the pirate being at (px, py) in `t` seconds.
// Returns { cost, blocked } where blocked means a hull-wrecking collision.
function pirateDangerAt(ship, px, py, t, prey, opts = {}) {
  const caution = pirateCaution(ship);
  const margin = 16 * caution;
  let cost = 0;
  // Harbour land: closing in on it is blocked, sailing away from it is allowed.
  const land = landClearance(px, py);
  if (land < ship.radius + 4 && land < landClearance(ship.x, ship.y) - 1) return { cost: 30, blocked: true };
  if (land < ship.radius + 14) cost += 6;
  // Mission banks and the waterfall, judged the same way.
  const bank = terrainDepth(px, py);
  if (bank < ship.radius + 4 && bank < terrainDepth(ship.x, ship.y) - 1) return { cost: 30, blocked: true };
  if (bank < ship.radius + 26) cost += 2.5;
  if (fallsAt(px, py)?.along > -260) return { cost: 30, blocked: true };

  function zone(cx, cy, radius, weight) {
    const d = Math.hypot(px - cx, py - cy);
    const edge = radius + margin;
    if (d >= edge) return;
    cost += Math.min(3, (edge - d) / margin) * weight;
  }

  if (iceAt(px, py) === "solid") cost += 4;

  for (const hz of hazards) {
    const hx = hz.x + (hz.vx || 0) * t;
    const hy = hz.y + (hz.vy || 0) * t;
    const d = Math.hypot(px - hx, py - hy);
    // A wide no-go ring: a ship can't stop dead, and wind keeps pushing it.
    // Inside the ring only moving closer counts as blocked; a course that
    // opens the distance is costly but allowed, so a pirate that has drifted
    // close can still sail its way out instead of seeing no escape at all.
    if (d <= hz.r + ship.radius + 14) {
      const nowD = Math.hypot(ship.x - hz.x, ship.y - hz.y);
      if (d < nowD - 1 || d <= hz.r + ship.radius + 4) {
        return { cost: cost + 30, blocked: true };
      }
      cost += 6;
    }
    const weight = (NAV_HAZARD_WEIGHT[hz.kind] || 1.8) * caution;
    // Inside the damage zone itself every second costs hull, so it is far
    // worse than merely skirting the edge.
    if (d <= hz.danger + ship.radius * 0.5) cost += 3 * weight;
    zone(hx, hy, hz.danger, weight);
  }

  for (const dz of dynamicDangers) {
    zone(dz.x + (dz.vx || 0) * t, dz.y + (dz.vy || 0) * t, dz.r, 1.6 * caution);
  }

  if (waterSpout.state !== "dormant") {
    const weight = waterSpout.state === "active" ? 2.2 : 1.2;
    zone(waterSpout.x + waterSpout.vx * t, waterSpout.y + waterSpout.vy * t, waterSpout.r + 10, weight * caution);
  }

  if (whirlpool.state !== "dormant") {
    zone(whirlpool.x, whirlpool.y, whirlpool.r + 20, (0.8 + 1.8 * whirlpool.strength) * caution);
  }

  zone(HarbourA.x, HarbourA.y, HarbourA.r + 30, 0.8);
  zone(HarbourB.x, HarbourB.y, HarbourB.r + 30, 0.8);

  for (const creature of game.seaCreatures) {
    zone(creature.x, creature.y, 60, 1.3 * caution);
  }

  for (const enemy of game.underwaterEnemies) {
    if (!enemy.capsized) zone(enemy.x, enemy.y, 70, 0.6 * caution);
  }

  for (const missile of game.missiles) {
    if (missile.target === ship) {
      zone(missile.x + missile.vx * t, missile.y + missile.vy * t, 40, 2.6);
    }
  }

  // Don't scrape hulls with fellow pirates.
  for (const other of [game.ai, ...game.pirateRaiders]) {
    if (!other || other === ship || other.capsized) continue;
    zone(other.x, other.y, other.radius + ship.radius, 0.8);
  }

  if (prey && !prey.capsized) {
    // The prey keeps sailing while the pirate's plan plays out, so judge
    // the gap against where it will be at time t.
    const preyX = prey.x + Math.cos(prey.angle) * prey.speed * t;
    const preyY = prey.y + Math.sin(prey.angle) * prey.speed * t;

    // No ramming the prey: a hull scrape hurts both ships, so keep clear.
    zone(preyX, preyY, prey.radius + ship.radius + 14, 2.0);

    // Stay out of the prey's line of fire when its cannons are loaded.
    if (prey.reload <= 0.4) {
      const dx = px - preyX;
      const dy = py - preyY;
      const d = Math.hypot(dx, dy);
      const offBow = Math.abs(normalizeAngle(Math.atan2(dy, dx) - prey.angle));
      if (d < 130 && offBow < 0.5) {
        cost += 0.9 * caution * (1 - d / 130 + 0.3);
      }
    }
  }

  // Map edges: not damaging, but a ship pinned on the edge is a sitting duck.
  // The cost ramps up over a wide band so the helm turns away early instead
  // of only noticing the wall when it is already scraping along it.
  if (!opts.ignoreEdges) {
    const edgeMargin = 70;
    const edgeGap = Math.min(px, WORLD_W - px, py, WORLD_H - py);
    if (edgeGap < edgeMargin) {
      cost += ((edgeMargin - edgeGap) / edgeMargin) * 2.4;
    }
  }

  return { cost, blocked: false };
}

// Wind drift the ship picks up over `t` seconds (applyMovement adds it on top
// of the ship's own motion, so a slow or stopped ship is blown along).
function pirateWindDrift(ship, t) {
  const k = (1 - (ship.windResistance || 0)) * t;
  return { x: game.wind.x * k, y: game.wind.y * k };
}

// Pirates plan like a helmsman who knows his ship: every frame they play
// forward ~2 seconds of the real ship physics (turn rate, acceleration, drag,
// wind) under a set of steering/throttle plans, throw out the plans that
// run into something or leave the ship unable to stop in time, and sail the
// first step of the best one. Because the plans use the ship's real motion,
// the turning circle and stopping distance are accounted for automatically.
const MPC_STEP = 1 / 20;
const MPC_STEPS = 40;
const MPC_SWITCH_AT = 14;
const MPC_DRAG_PER_STEP = Math.pow(0.986, 3); // applyMovement damps 0.986 once per ~1/60 s
const MPC_STEER = [-1, 0, 1];
const MPC_THROTTLE = [1, 0.5, 0, -0.5];

function simulatePirateRoute(ship, s1, s2, throttle, goal, prey, options) {
  let x = ship.x;
  let y = ship.y;
  let angle = ship.angle;
  let speed = ship.speed;
  const h = { rudder: ship.helm ? ship.helm.rudder : 0, yaw: ship.helm ? ship.helm.yaw : 0 };
  const accel = ship.accel || 165;
  const windK = (1 - (ship.windResistance || 0)) * MPC_STEP;
  const windX = game.wind.x * windK;
  const windY = game.wind.y * windK;
  let cost = 0;

  for (let k = 1; k <= MPC_STEPS; k += 1) {
    const yaw = helmStep(h, ship, k <= MPC_SWITCH_AT ? s1 : s2, throttle, speed, MPC_STEP);
    angle += yaw * MPC_STEP;
    speed *= turnSpeedKeep(ship, yaw, MPC_STEP);
    speed += throttle * accel * MPC_STEP;
    speed *= MPC_DRAG_PER_STEP;
    speed = clamp(speed, -ship.maxSpeed * 0.35, ship.maxSpeed);
    const rawX = x + Math.cos(angle) * speed * MPC_STEP + windX;
    const rawY = y + Math.sin(angle) * speed * MPC_STEP + windY;
    x = clamp(rawX, 10, WORLD_W - 10);
    y = clamp(rawY, 10, WORLD_H - 10);
    // Driving into the map edge goes nowhere: without this a plan that just
    // presses against the wall looks as cheap as sailing somewhere useful.
    if (x !== rawX || y !== rawY) cost += 0.6;

    if (k % 2 === 0) {
      const t = k * MPC_STEP;
      const danger = pirateDangerAt(ship, x, y, t, prey);
      if (danger.blocked) {
        // A crash is far worse the sooner it happens.
        return cost + 70 + (1 - t / 2.2) * 90;
      }
      cost += danger.cost * 0.1;
    }
  }

  // Can the ship still stop before the next thing, from where this plan ends?
  const stop = speed > 0 ? (speed * speed) / 220 : 0;
  const end = pirateDangerAt(
    ship,
    x + Math.cos(angle) * stop,
    y + Math.sin(angle) * stop,
    MPC_STEPS * MPC_STEP + 0.5,
    prey
  );
  cost += end.blocked ? 90 : end.cost * 1.5;

  // A moving goal (a prey under way) is judged where it will be when the plan
  // ends, not where it is now; otherwise the pirate always aims at a spot the
  // prey has long left and trails behind it.
  const horizon = MPC_STEPS * MPC_STEP;
  const goalVx = options.goalVx || 0;
  const goalVy = options.goalVy || 0;
  const goalX = goal.x + goalVx * horizon;
  const goalY = goal.y + goalVy * horizon;
  const goalDist = Math.hypot(x - goalX, y - goalY);
  cost += goalDist * 0.05;
  // Arriving means matching the goal's speed, which is a full stop only when
  // the goal is standing still.
  if (options.arrive && goalDist < 140) cost += Math.abs(speed - Math.hypot(goalVx, goalVy)) * 0.04;
  if (options.aim && prey && !prey.capsized) {
    const preyX = prey.x + goalVx * horizon;
    const preyY = prey.y + goalVy * horizon;
    if (Math.hypot(x - preyX, y - preyY) < 170) {
      const aimErr = Math.abs(normalizeAngle(Math.atan2(preyY - y, preyX - x) - angle));
      cost += aimErr * 1.2;
    }
  }
  if (throttle < 0) cost += 1.5;

  return cost;
}

// Picks the best plan toward `goal` and turns its first step into helm input.
function navigatePirate(ship, goal, prey, options = {}) {
  const maxThrottle = options.maxThrottle || 1;
  let best = null;

  for (const s1 of MPC_STEER) {
    for (const s2 of MPC_STEER) {
      for (const throttle of MPC_THROTTLE) {
        if (throttle > maxThrottle + 0.01) continue;
        const key = `${s1}${s2}${throttle}`;
        let cost = simulatePirateRoute(ship, s1, s2, throttle, goal, prey, options);
        // Sticking with last frame's plan keeps the helm from twitching.
        if (key === ship.navKey) cost -= 0.8;
        if (!best || cost < best.cost) best = { cost, s1, throttle, key };
      }
    }
  }

  ship.navKey = best.key;
  return {
    forward: best.throttle > 0,
    backward: best.throttle < 0,
    left: best.s1 < 0,
    right: best.s1 > 0,
    throttleScale: best.throttle > 0 ? best.throttle : 1
  };
}

// Is it safe to back water? Compares the water astern (where reversing
// would take the ship) with the water ahead: backing is fine unless it runs
// into something or into worse trouble than carrying on would.
function pirateSternIsClear(ship, prey) {
  const fx = Math.cos(ship.angle);
  const fy = Math.sin(ship.angle);
  let astern = 0;
  let ahead = 0;
  for (const d of [20, 40, 60]) {
    const t = d / 60;
    const drift = pirateWindDrift(ship, t);
    const back = pirateDangerAt(ship, ship.x - fx * d + drift.x, ship.y - fy * d + drift.y, t, prey);
    if (back.blocked) return false;
    astern += back.cost;
    const front = pirateDangerAt(ship, ship.x + fx * d + drift.x, ship.y + fy * d + drift.y, t, prey);
    ahead += front.blocked ? 30 : front.cost;
  }
  return astern <= ahead + 0.5;
}

// Rough distance a ship coasts while backing water from its current speed.
function pirateStoppingDistance(ship) {
  const v = Math.max(0, ship.speed);
  return (v * v) / (2 * 110);
}

// Checks where the ship will actually end up if it stops now: its own
// momentum carries it forward and the wind pushes it, so the spot it is on
// right now can be safe while the spot it drifts into is not.
// Only real hazards count here. The prey itself and the map edge are left
// out: holding station beside the prey is the whole point (the hold logic
// backs off if too close), and counting the prey's "keep clear" ring and gun
// arc made every firing spot look unsafe, so the pirate never held and fired.
function pirateSpotIsSafe(ship) {
  const coast = pirateStoppingDistance(ship);
  const drift = pirateWindDrift(ship, 1);
  for (const k of [0.5, 1]) {
    const px = ship.x + Math.cos(ship.angle) * coast * k + drift.x * k;
    const py = ship.y + Math.sin(ship.angle) * coast * k + drift.y * k;
    const sample = pirateDangerAt(ship, px, py, k, null, { ignoreEdges: true });
    if (sample.blocked || sample.cost >= 0.4) return false;
  }
  return true;
}

// Pirates plot a course around islands, volcanoes and icebergs instead of
// steering straight at their goal. The helm (navigatePirate) only looks ~2 s
// ahead, so with an island between pirate and prey every short plan looked
// worse than staying put and the pirate stalled behind it. A coarse grid
// route is replanned twice a second, and the helm steers for the farthest
// point on that route that is in plain sight.
const ROUTE_CELL = 40;
const ROUTE_COLS = Math.ceil(WORLD_W / ROUTE_CELL);
const ROUTE_ROWS = Math.ceil(WORLD_H / ROUTE_CELL);
const ROUTE_REPLAN_EVERY = 0.5;

function routeClearance(ship, hz) {
  return hz.r + ship.radius + 18;
}

// True when the straight run from a to b keeps clear of every hazard. A
// hazard the ship (or the goal) is already inside is ignored: the helm's own
// look-ahead handles sailing out of it, and counting it would block every line.
function routeLineIsClear(ship, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  for (const hz of hazards) {
    const clearance = routeClearance(ship, hz);
    if (Math.hypot(ax - hz.x, ay - hz.y) < clearance || Math.hypot(bx - hz.x, by - hz.y) < clearance) continue;
    const t = clamp(((hz.x - ax) * dx + (hz.y - ay) * dy) / len2, 0, 1);
    if (Math.hypot(ax + dx * t - hz.x, ay + dy * t - hz.y) < clearance) return false;
  }
  if (game.mission) {
    const steps = Math.ceil(Math.sqrt(len2) / 40);
    for (let i = 1; i < steps; i += 1) {
      if (terrainDepth(ax + (dx * i) / steps, ay + (dy * i) / steps) < ship.radius + 10) return false;
    }
  }
  return true;
}

// A* over a 40 px grid. Cells too close to a hazard are blocked; cells in a
// hazard's damage zone cost extra, so the route skirts them where it can.
function planPirateRoute(ship, goal, avoid = []) {
  const cellIndex = (x, y) =>
    clamp(Math.floor(y / ROUTE_CELL), 0, ROUTE_ROWS - 1) * ROUTE_COLS + clamp(Math.floor(x / ROUTE_CELL), 0, ROUTE_COLS - 1);
  const center = (i) => ({ x: ((i % ROUTE_COLS) + 0.5) * ROUTE_CELL, y: (Math.floor(i / ROUTE_COLS) + 0.5) * ROUTE_CELL });
  const total = ROUTE_COLS * ROUTE_ROWS;
  const start = cellIndex(ship.x, ship.y);
  const end = cellIndex(goal.x, goal.y);

  const blocked = new Uint8Array(total);
  const penalty = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    const c = center(i);
    for (const hz of hazards) {
      const d = Math.hypot(c.x - hz.x, c.y - hz.y);
      if (d < routeClearance(ship, hz)) blocked[i] = 1;
      else if (d < hz.danger + ship.radius) penalty[i] += ROUTE_CELL * 2;
    }
    for (const o of avoid) if (Math.hypot(c.x - o.x, c.y - o.y) < o.r) penalty[i] += ROUTE_CELL * 6;
    if (game.mission) {
      const bank = terrainDepth(c.x, c.y);
      if (bank < ship.radius + 12 || fallsAt(c.x, c.y)?.along > -260) blocked[i] = 1;
      else if (bank < ship.radius + 45) penalty[i] += ROUTE_CELL;
    }
  }
  blocked[start] = 0;
  blocked[end] = 0;

  const cost = new Float32Array(total).fill(Infinity);
  const from = new Int32Array(total).fill(-1);
  const closed = new Uint8Array(total);
  const open = [start];
  cost[start] = 0;
  const goalC = center(end);
  const guess = (i) => {
    const c = center(i);
    return Math.hypot(c.x - goalC.x, c.y - goalC.y);
  };
  // cost so far + straight distance left, kept per cell so the search doesn't work it out again and again
  const score = new Float32Array(total);
  score[start] = guess(start);

  while (open.length) {
    let bestAt = 0;
    for (let k = 1; k < open.length; k += 1) {
      if (score[open[k]] < score[open[bestAt]]) bestAt = k;
    }
    const cur = open.splice(bestAt, 1)[0];
    if (cur === end) break;
    if (closed[cur]) continue;
    closed[cur] = 1;

    const cc = cur % ROUTE_COLS;
    const cr = Math.floor(cur / ROUTE_COLS);
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (!dr && !dc) continue;
        const nc = cc + dc;
        const nr = cr + dr;
        if (nc < 0 || nr < 0 || nc >= ROUTE_COLS || nr >= ROUTE_ROWS) continue;
        const next = nr * ROUTE_COLS + nc;
        if (blocked[next] || closed[next]) continue;
        const step = (dr && dc ? Math.SQRT2 : 1) * ROUTE_CELL + penalty[next];
        if (cost[cur] + step < cost[next]) {
          cost[next] = cost[cur] + step;
          from[next] = cur;
          score[next] = cost[next] + guess(next);
          open.push(next);
        }
      }
    }
  }

  if (from[end] === -1 && end !== start) return null;
  const path = [];
  for (let i = end; i !== -1; i = from[i]) path.unshift(center(i));
  path[path.length - 1] = { x: goal.x, y: goal.y };
  return path;
}

// The point the helm should actually steer for on the way to `goal`: the
// goal itself when the way is open, otherwise the farthest visible point on
// the planned route around whatever is in between.
function pirateSteerPoint(ship, goal) {
  if (routeLineIsClear(ship, ship.x, ship.y, goal.x, goal.y)) {
    ship.route = null;
    return goal;
  }
  const route = ship.route;
  if (!route || game.elapsed >= route.replanAt || Math.hypot(route.goalX - goal.x, route.goalY - goal.y) > 60) {
    ship.route = {
      path: planPirateRoute(ship, goal),
      goalX: goal.x,
      goalY: goal.y,
      replanAt: game.elapsed + ROUTE_REPLAN_EVERY
    };
  }
  const path = ship.route.path;
  if (!path || path.length < 2) return goal;
  for (let i = path.length - 1; i > 1; i -= 1) {
    if (routeLineIsClear(ship, ship.x, ship.y, path[i].x, path[i].y)) return path[i];
  }
  return path[1];
}

// Pirates are raiders, not racers: they patrol the sea lanes, spot ships
// within detection range and hunt them down, and give up the chase if the
// prey gets far away. Harbour waters are protected, so they never pursue (or
// fire on) a ship that is sheltering near a harbour.
const PIRATE_DETECT_RANGE = 440;
const PIRATE_LOSE_RANGE = 640;
const HARBOUR_SANCTUARY_RANGE = 290;

// The pirate hunter would rather rob a ship than sink it. In hailing range it
// orders the prey to heave to. A ship that slows to a crawl has surrendered:
// the pirate comes alongside and plunders it, then lets it go once there is
// nothing left worth taking. A ship that keeps sailing past the grace period,
// or runs after surrendering, gets fired on.
const PIRATE_HAIL_RANGE = 240;
const PIRATE_HAIL_GRACE = 3.5;
const SURRENDER_SPEED = 35;
const PIRATE_RELEASE_TIME = 12;
const PIRATE_CALLOUT_TIME = 3;

function pirateCallout(aiShip, text) {
  const name = aiShip.shipName || "Pirate";
  game.aiDirector.callout = { text, until: game.elapsed + PIRATE_CALLOUT_TIME };
  setUiMessage(`${name}: ${text}`);
}

function resetPirateHail(director) {
  director.hailedAt = null;
  director.surrendered = false;
  director.hostile = false;
  director.anchored = false;
}

function updatePirateHail(aiShip, prey, gap) {
  const director = game.aiDirector;
  if (director.hailedAt === null) {
    if (gap > PIRATE_HAIL_RANGE) return;
    director.hailedAt = game.elapsed;
    pirateCallout(aiShip, "Heave to and hand over your cargo, or we open fire!");
  }

  // Give the hail a moment on screen before a ship that was already idling
  // counts as having surrendered, so the player actually sees the demand.
  const complying = Math.abs(prey.speed) < SURRENDER_SPEED && game.elapsed - director.hailedAt > 1.2;
  if (complying) {
    if (!director.surrendered) {
      director.surrendered = true;
      director.hostile = false;
      pirateCallout(aiShip, "Wise choice. Stand by to be boarded!");
    }
    if (gap < PLUNDER_RANGE && (prey.runScore || 0) < 1) {
      director.releasedUntil = game.elapsed + PIRATE_RELEASE_TIME;
      pirateCallout(aiShip, "Nothing left worth taking. Be off with ye!");
      resetPirateHail(director);
    }
    return;
  }

  if (director.surrendered) {
    director.surrendered = false;
    director.anchored = false;
    director.hostile = true;
    pirateCallout(aiShip, "Running, are ye? Open fire!");
  } else if (!director.hostile && game.elapsed - director.hailedAt > PIRATE_HAIL_GRACE) {
    director.hostile = true;
    pirateCallout(aiShip, "Ye were warned! Open fire!");
  }
}

function inHarbourSanctuary(ship) {
  return !!ship && (dist(ship, HarbourA) < HARBOUR_SANCTUARY_RANGE || dist(ship, HarbourB) < HARBOUR_SANCTUARY_RANGE);
}

// A player's ship in harbour waters (berthed or inside the breakwaters) is
// off limits to everything man- or monster-made: pirates, sea monsters,
// submarines and their torpedoes, the other captain's guns in 2-player, and
// hull scrapes with other ships. Only nature can still do damage there:
// storms, tsunamis, water spouts, volcano rocks and fire.
function safeInHarbour(ship) {
  return !!ship && ship.isHuman && inHarbourSanctuary(ship);
}

// Enemies (pirates, sea monsters, submarines) keep well outside the harbour
// waters: one that drifts or chases up to the keep-out ring is pushed back
// out along the radius, so nothing hostile gets close to a berthed ship.
const HARBOUR_KEEPOUT = HARBOUR_SANCTUARY_RANGE + 100;

function keepEnemiesOutOfHarbours() {
  const enemies = [game.ai, ...game.pirateRaiders, ...game.seaCreatures, ...game.underwaterEnemies];
  for (const e of enemies) {
    if (!e || e.capsized || e.entering) continue;
    for (const h of [HarbourA, HarbourB]) {
      const d = dist(e, h);
      if (d >= HARBOUR_KEEPOUT) continue;
      const k = HARBOUR_KEEPOUT / (d || 1);
      e.x = h.x + (e.x - h.x) * k;
      e.y = h.y + (e.y - h.y) * k;
    }
  }
}

const BOARD_STANDOFF = 56;
const BOARD_ANCHOR_RANGE = 70;

// How far (centre to centre) the pirate keeps off its prey: `least`, or more
// when the two hulls bow to stern need it, but always within cannon range (84).
function pirateStandoff(pirate, prey, least) {
  return Math.min(82, Math.max(least, shipHalfLength(pirate) + shipHalfLength(prey) + 4));
}

// Once the prey has surrendered, the pirate sails up beside it on its own
// side, drops anchor and holds station while it plunders. It doesn't stop
// for a ship that is still under way, and it doesn't aim or fire here: if the
// prey sails off again, updatePirateHail turns it hostile.
function boardingInput(aiShip, prey, gap, dt) {
  const director = game.aiDirector;
  const awayX = aiShip.x - prey.x;
  const awayY = aiShip.y - prey.y;
  const len = Math.hypot(awayX, awayY) || 1;
  const off = pirateStandoff(aiShip, prey, BOARD_STANDOFF);
  const goal = {
    x: prey.x + (awayX / len) * off,
    y: prey.y + (awayY / len) * off
  };

  if (!director.anchored && gap < pirateStandoff(aiShip, prey, BOARD_ANCHOR_RANGE)) {
    director.anchored = true;
    pirateCallout(aiShip, "Anchors down! Stand by to be boarded!");
  } else if (director.anchored && gap > PLUNDER_RANGE) {
    director.anchored = false;
  }

  if (director.anchored) {
    // Anchored: kill the way on the ship and cancel the wind drift that
    // applyMovement adds after this, so it stays put beside the prey.
    aiShip.speed *= Math.pow(0.05, dt);
    aiShip.x -= game.wind.x * (1 - (aiShip.windResistance || 0)) * dt;
    aiShip.y -= game.wind.y * (1 - (aiShip.windResistance || 0)) * dt;
    return { forward: false, backward: false, left: false, right: false };
  }

  return navigatePirate(aiShip, goal, prey, { arrive: true, maxThrottle: 0.6 });
}

function aiInput(aiShip, targetShip, dt) {
  if (!aiShip || aiShip.capsized) {
    return { forward: false, backward: false, left: false, right: false };
  }

  // Driven off by an acoustic deterrent: sail clear, no hailing, no hunting.
  if (aiShip.deterredUntil > game.elapsed) {
    return navigatePirate(aiShip, pirateSteerPoint(aiShip, deterredGoal(aiShip)), targetShip, {});
  }

  const director = game.aiDirector;
  const preyAlive = targetShip && !targetShip.capsized;
  const preyGap = preyAlive ? dist(aiShip, targetShip) : Infinity;
  // A ship the pirate has just robbed bare is let go for a while.
  const released = game.elapsed < (director.releasedUntil || 0);
  const canHunt = preyAlive && !released && !inHarbourSanctuary(targetShip);
  const hull = aiShip.hp / (aiShip.maxHull || 100);

  if (canHunt && preyGap < (director.mode === "hunt" ? PIRATE_LOSE_RANGE : PIRATE_DETECT_RANGE)) {
    director.mode = "hunt";
  } else if (director.mode === "hunt") {
    director.mode = "patrol";
    director.waypoint = null;
  }

  if (director.mode === "hunt") {
    updatePirateHail(aiShip, targetShip, preyGap);
  } else {
    resetPirateHail(director);
  }

  if (director.mode === "hunt" && director.surrendered && preyAlive) {
    return boardingInput(aiShip, targetShip, preyGap, dt);
  }

  let goal;
  let holdAndAim = false;
  let arrive = false;
  let aim = false;
  let maxThrottle = 1;
  let goalVx = 0;
  let goalVy = 0;

  if (director.mode === "hunt") {
    // Chase where the prey is heading: the helm judges each plan against
    // the prey's position when that plan ends (goalVx/goalVy).
    const playerVx = Math.cos(targetShip.angle) * targetShip.speed;
    const playerVy = Math.sin(targetShip.angle) * targetShip.speed;
    goal = { x: targetShip.x, y: targetShip.y };
    goalVx = playerVx;
    goalVy = playerVy;

    // Close to cannon range (84) but don't ram. Within striking distance the
    // pirate heads for a firing spot beside the player and matches its speed
    // instead of overshooting. A prey that has (nearly) stopped is held
    // beside and aimed at; one still under way is chased bow-on. The only
    // time contact is allowed is when the player charges the pirate.
    const awayX = aiShip.x - targetShip.x;
    const awayY = aiShip.y - targetShip.y;
    const gap = Math.hypot(awayX, awayY) || 1;
    const playerClosingSpeed = (playerVx * awayX + playerVy * awayY) / gap;
    const playerClosingOnPurpose = targetShip.speed > 35 && playerClosingSpeed > targetShip.speed * 0.5;

    if (gap < 180 && !playerClosingOnPurpose) {
      // The guns fire over the bow, so a prey under way is attacked from
      // astern: sit in its wake at cannon range with the bow on its stern.
      // A stopped prey is simply approached from the pirate's own side.
      const underWay = Math.abs(targetShip.speed) >= SURRENDER_SPEED;
      const fromX = underWay ? -Math.cos(targetShip.angle) : awayX / gap;
      const fromY = underWay ? -Math.sin(targetShip.angle) : awayY / gap;
      const off = pirateStandoff(aiShip, targetShip, 66);
      goal = {
        x: targetShip.x + fromX * off,
        y: targetShip.y + fromY * off
      };
      arrive = true;
      aim = true;
    }
    if (gap < 92 && !playerClosingOnPurpose && Math.abs(targetShip.speed) < SURRENDER_SPEED) {
      holdAndAim = true;
    }

    // A badly damaged pirate breaks off and keeps its distance rather than
    // fighting to the last plank.
    if (hull < 0.3 && preyGap < 260) {
      goal = {
        x: clamp(aiShip.x + (awayX / gap) * 220, 40, WORLD_W - 40),
        y: clamp(aiShip.y + (awayY / gap) * 220, 40, WORLD_H - 40)
      };
      holdAndAim = false;
      arrive = false;
      aim = false;
      goalVx = 0;
      goalVy = 0;
    }
  } else {
    // Patrol: cruise between waypoints in open water on the sea lanes.
    if (!director.waypoint || dist(aiShip, director.waypoint) < 70 || game.elapsed > director.repickAt) {
      director.waypoint = pickPatrolPoint(aiShip, targetShip);
      director.repickAt = game.elapsed + 6 + Math.random() * 5;
    }
    goal = director.waypoint;
    maxThrottle = 0.5;
  }

  // Only stop to aim where the water is safe; otherwise keep sailing.
  if (holdAndAim && preyAlive && pirateSpotIsSafe(aiShip)) {
    // Hold station and swing the bow onto the prey so the cannons line up:
    // back water to kill leftover way, creep in if just out of range, and
    // back off (bow on the prey, so reversing opens the gap) if too close.
    const aimErr = normalizeAngle(Math.atan2(targetShip.y - aiShip.y, targetShip.x - aiShip.x) - aiShip.angle);
    const creepIn = preyGap > pirateStandoff(aiShip, targetShip, 78) &&preyGap < 140 && Math.abs(aimErr) < 0.3 && aiShip.speed < 30;
    const backOff = preyGap < 52 && Math.abs(aimErr) < 1.2;
    const canReverse = pirateSternIsClear(aiShip, targetShip);
    return {
      forward: creepIn && !backOff,
      backward: (aiShip.speed > 25 || backOff) && aiShip.speed > -40 && canReverse,
      left: aimErr < -0.08,
      right: aimErr > 0.08,
      throttleScale: creepIn ? 0.35 : 0.6
    };
  }

  // Steer around anything in the way. Arriving and aiming only apply at the
  // real goal, not at a turning point on the way there.
  const steerTo = pirateSteerPoint(aiShip, goal);
  const atGoal = steerTo === goal;
  return navigatePirate(aiShip, steerTo, targetShip, {
    arrive: arrive && atGoal,
    aim: aim && atGoal,
    maxThrottle,
    goalVx: atGoal ? goalVx : 0,
    goalVy: atGoal ? goalVy : 0
  });
}

function resetAiDirector(attackUnlockedAt) {
  game.aiDirector = {
    attackUnlockedAt,
    mode: "patrol",
    waypoint: null,
    repickAt: 0,
    hailedAt: null,
    surrendered: false,
    hostile: false,
    releasedUntil: 0,
    callout: null
  };
}

// A patrol waypoint in open water on the sea lanes between the harbours,
// well clear of both harbours (the pirate has no business loitering there).
function pickPatrolPoint(aiShip, prey) {
  const laneDx = HarbourB.x - HarbourA.x;
  const laneDy = HarbourB.y - HarbourA.y;
  const laneLen2 = laneDx * laneDx + laneDy * laneDy;
  let best = null;

  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = {
      x: 120 + Math.random() * (WORLD_W - 240),
      y: 120 + Math.random() * (WORLD_H - 240)
    };
    if (dist(candidate, HarbourA) < 280 || dist(candidate, HarbourB) < 280) continue;
    if (dist(candidate, aiShip) < 160) continue;

    const danger = pirateDangerAt(aiShip, candidate.x, candidate.y, 3, null);
    // Prefer points close to the A-B lane, where the prey has to sail.
    const along = clamp(((candidate.x - HarbourA.x) * laneDx + (candidate.y - HarbourA.y) * laneDy) / laneLen2, 0, 1);
    const lateral = Math.hypot(candidate.x - (HarbourA.x + laneDx * along), candidate.y - (HarbourA.y + laneDy * along));
    const score = (danger.blocked ? 100 : danger.cost * 4) + lateral / 150;
    if (!best || score < best.score) best = { x: candidate.x, y: candidate.y, score };
  }

  return best ? { x: best.x, y: best.y } : { x: WORLD_W / 2, y: WORLD_H / 2 };
}

// Arrived: berthed (at anchor) in Harbour B's berthing ring. Coming to rest
// in the ring anchors the ship by itself (or R / comma), and that completes
// the crossing or mission; sailing through the ring without stopping doesn't.
function nearHarbourB(ship) {
  // Only once the ship is berthed and all the lines are fast.
  return ship && !ship.capsized && ship.anchored && ship.ropes >= 1 && berthedHarbour(ship) === HarbourB;
}

function shipIsInDanger(ship) {
  if (!ship || ship.capsized) return false;

  for (const hz of hazards) {
    if (dist(ship, hz) <= hz.danger + 10) {
      return true;
    }
  }

  for (const dz of dynamicDangers) {
    if (dist(ship, dz) <= dz.r + 6) {
      return true;
    }
  }

  if (game.ai && !game.ai.capsized && dist(ship, game.ai) < 120) {
    return true;
  }

  for (const raider of game.pirateRaiders) {
    if (!raider.capsized && dist(ship, raider) < 120) {
      return true;
    }
  }

  for (const creature of game.seaCreatures) {
    if (dist(ship, creature) < 95) {
      return true;
    }
  }

  return false;
}

function awardScore(ship, points, reason = "sailing") {
  if (!ship || ship.capsized || points <= 0 || !ship.isHuman) return;

  ship.runScore += points;
  game.floatingScores.push({
    x: ship.x,
    y: ship.y - 36,
    value: `+${points}`,
    age: 0,
    ttl: 1.15,
    reason,
    color: ship.type === "cruise" ? "#8dd3ff" : "#ffe486"
  });
}

// Pirates steal: while a pirate sails alongside a player ship it loots
// points from that ship's run score, once per second.
const PLUNDER_RANGE = 110;
const PLUNDER_PER_SECOND = 6;

function plunderShip(pirate, target, dt) {
  if (!pirate || !target || pirate.capsized || target.capsized || !target.isHuman) return;
  if (pirate.deterredUntil > game.elapsed) return;

  if (dist(pirate, target) > PLUNDER_RANGE) {
    pirate.plunderTick = 0;
    return;
  }

  pirate.plunderTick = (pirate.plunderTick || 0) + dt;
  if (pirate.plunderTick < 1) return;
  pirate.plunderTick -= 1;

  const stolen = Math.min(PLUNDER_PER_SECOND, Math.floor(target.runScore || 0));
  if (stolen <= 0) return;

  target.runScore -= stolen;
  game.floatingScores.push({
    x: target.x,
    y: target.y - 36,
    value: `-${stolen}`,
    age: 0,
    ttl: 1.15,
    reason: "plundered",
    color: "#ff6b5e"
  });
}

function updateScore(dt) {
  for (const ship of humanShips()) {
    if (ship.capsized) continue;

    ship.scoreTick += dt;
    if (ship.scoreTick < 1) {
      continue;
    }
    ship.scoreTick -= 1;

    // Only forward motion counts toward score; reversing should neither add
    // nor subtract points, so a negative speed simply fails the threshold.
    const speed = ship.speed;
    const inDanger = shipIsInDanger(ship);
    if (speed < 25 || inDanger) {
      continue;
    }

    let points = 5;
    if (speed > 90) points += 3;
    if (speed > 150) points += 2;
    if (dist(ship, HarbourB) < 260) points += 4;

    awardScore(ship, points, "safe-sailing");
  }
}

function updateFloatingScores(dt) {
  for (let i = game.floatingScores.length - 1; i >= 0; i -= 1) {
    const popup = game.floatingScores[i];
    popup.age += dt;
    popup.y -= 28 * dt;
    popup.x += Math.sin((popup.age / popup.ttl) * Math.PI) * 10 * dt;

    if (popup.age >= popup.ttl) {
      game.floatingScores.splice(i, 1);
    }
  }
}

function commitRoundScores() {
  if (game.roundCommitted) return;

  for (const ship of humanShips()) {
    if (!ship || !ship.playerSlot) continue;
    const points = Math.max(0, Math.round(ship.runScore || 0));
    if (points <= 0) continue;

    const profile = getProfile(ship.playerSlot);
    profile.points += points;
    game.gamePoints[ship.playerSlot] += points;
    const key = profile.name;
    game.profiles.leaderboard[key] = (game.profiles.leaderboard[key] || 0) + points;
  }

  saveProfiles();
  game.roundCommitted = true;
}

function spawnSeaCreature() {
  const p = randomEdgeSpawn();
  game.seaCreatures.push({
    x: p.x,
    y: p.y,
    angle: p.angle,
    entering: true,
    speed: 90 + Math.random() * 30,
    radius: 14,
    attackCooldown: 0,
    motionSeed: Math.random() * Math.PI * 2,
    lifetime: 0,
    despawnAt: 22 + Math.random() * 14
  });
}

function updateSeaCreatures(dt) {
  if (gameState !== "playing") return;

  const threats = voyageThreats();
  const monsters = game.seaCreatures.filter((c) => !c.variant).length;
  if (game.elapsed >= game.nextCreatureSpawnAt && monsters < threats.creatureCap && threatSlotOpen()) {
    claimThreatSlot();
    spawnSeaCreature();
    game.nextCreatureSpawnAt = game.elapsed + randomInterval(threats.creatureInterval);
  }

  for (let i = game.seaCreatures.length - 1; i >= 0; i -= 1) {
    const creature = game.seaCreatures[i];
    creature.lifetime += dt;
    creature.attackCooldown = Math.max(0, creature.attackCooldown - dt);

    if (creature.lifetime > creature.despawnAt) {
      game.seaCreatures.splice(i, 1);
      continue;
    }

    const ships = allCombatShips();
    if (ships.length === 0) {
      game.seaCreatures.splice(i, 1);
      continue;
    }
    // Monsters hunt only ships out at sea; with every ship sheltering in a
    // harbour they turn away and roam until they lose interest.
    const prey = ships.filter((ship) => !safeInHarbour(ship));

    let target = prey[0] || { x: WORLD_W - creature.x, y: WORLD_H - creature.y };
    let best = dist(creature, target) * (target.owned && target.owned.leviathanDecoy ? 1.3 : 1);
    for (let j = 1; j < prey.length; j += 1) {
      const d = dist(creature, prey[j]) * (prey[j].owned && prey[j].owned.leviathanDecoy ? 1.3 : 1);
      if (d < best) {
        best = d;
        target = prey[j];
      }
    }

    if (creature.variant === "croc") target = crocGoal(creature, prey);

    const desired = Math.atan2(target.y - creature.y, target.x - creature.x);
    const wobble = Math.sin(game.elapsed * 2.4 + creature.motionSeed) * 0.35;
    const err = normalizeAngle(desired + wobble - creature.angle);
    creature.angle += clamp(err, -1.8 * dt, 1.8 * dt);

    creature.x += Math.cos(creature.angle) * creature.speed * dt + game.wind.x * 0.18 * dt;
    creature.y += Math.sin(creature.angle) * creature.speed * dt + game.wind.y * 0.18 * dt;
    applyKnockback(creature, dt);
    if (!stillEntering(creature, 18)) {
      creature.x = clamp(creature.x, 18, WORLD_W - 18);
      creature.y = clamp(creature.y, 18, WORLD_H - 18);
    }
    blockEntityFromHazards(creature);
    // It bounces off any hull it touches, and bites the one it touches.
    for (const ship of ships) {
      const hit = bounceApart(ship, creature);
      if (hit < 0) continue;
      bumpSound(ship, creature, hit);
      if (creature.attackCooldown <= 0 && !safeInHarbour(ship)) {
        const croc = creature.variant === "croc";
        damageShip(ship, croc ? 12 : 34, croc ? "sea creature strike (crocodile)" : "sea creature strike");
        creature.attackCooldown = croc ? 2.5 : 1.35;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Carrier jets. Sailing the aircraft carrier at sea, one jet at a time flies
// out on its own whenever a pirate ship comes within JET.patrolRange: it
// taxis from its parking spot to the bow catapult, runs its engine up and is
// launched, flies out to the pirate and fires warning bursts into the water
// beside it. If the pirate presses on towards the carrier, or attacks the
// carrier or the jet, the jet attacks it directly with a missile. Pirates
// fire back: three hits bring a jet down, and a new one is readied after a
// while. With the threat gone (or fuel low) the jet comes back and lands on
// the angled deck. The deck part (taxi, run-up, catapult, landing) is drawn
// by render3d.js from jet.state and jet.t; game.js flies it in the air.
// ---------------------------------------------------------------------------
const CARRIER_DECK_SCALE = 109 / 50; // render3d SHIP_SIZE.Carrier: deck model units -> world units
const JET = {
  patrolRange: 900, // a pirate this close to your carrier (out at sea) brings a jet out
  speed: 95, // units/s in the air (about 1000 km/h)
  turnRate: 1.2, // rad/s
  climbRate: 18, // units/s up or down
  cruiseAlt: 55,
  deckAlt: 4.2 * CARRIER_DECK_SCALE, // the flight deck above the sea
  taxiTime: 6,
  spoolTime: 2.4,
  catapultTime: 1.6,
  landTime: 2.8,
  taxiBackTime: 6,
  warnRadius: 170, // circles the pirate at this distance while warning
  burstEvery: 3.2, // seconds between warning bursts
  redLine: 420, // a pirate this close to the carrier is pressing in: attack
  missileRange: 330,
  rearm: 7, // seconds between missiles
  hp: 3, // pirate hits a jet takes before it goes down
  fuel: 90, // seconds in the air before it must come back
  cooldown: 10, // on deck after landing before it can go again
  replaceTime: 45, // a new jet after one is shot down
  pirateFireRange: 230,
  pirateFireEvery: [2.2, 3.6],
  pirateHitChance: 0.3
};
const JET_FLYING = new Set(["climb", "intercept", "warn", "attack", "breakaway", "return", "final"]);

// The jet on the deck, in deck units (x forward, z to port; render3d.js's
// carrier model): its parking spot, the taxi route to the starboard
// catapult, the catapult, and the angled landing area (9 degrees to port).
const JET_DECK = {
  park: [6, -4.2],
  parkYaw: -1.05,
  taxi: [[6, -4.2], [8.5, -3.3], [11.5, -1.9], [14, -1.3]],
  catapult: [14, 24.6],
  catapultZ: -1.3,
  landStart: [-25, 0.6],
  landAngle: (9 * Math.PI) / 180,
  landStop: 13 // how far along the landing area the wire pulls it up
};

// Position and heading (yaw, as on the 3D model: nose towards x cos, -z sin)
// a fraction `p` along a path of deck points.
function deckPath(points, p) {
  const lens = points.slice(1).map((q, i) => Math.hypot(q[0] - points[i][0], q[1] - points[i][1]));
  let d = clamp(p, 0, 1) * lens.reduce((x, y) => x + y, 0);
  let i = 0;
  while (i < lens.length - 1 && d > lens[i]) d -= lens[i++];
  const [ax, az] = points[i];
  const [bx, bz] = points[i + 1];
  const k = lens[i] ? d / lens[i] : 0;
  return { x: ax + (bx - ax) * k, z: az + (bz - az) * k, yaw: -Math.atan2(bz - az, bx - ax) };
}

function landingPoint(s) {
  return [JET_DECK.landStart[0] + Math.cos(JET_DECK.landAngle) * s, JET_DECK.landStart[1] + Math.sin(JET_DECK.landAngle) * s];
}

// Where the jet is on the deck for its state and time: { x, z, yaw, wingsOut, flame }.
// Shared by the 3D carrier (render3d.js) and the 2D map.
function jetDeckPose(jet) {
  const t = jet.t;
  const ease = (p) => p * p * (3 - 2 * p);
  if (jet.state === "taxi") {
    const p = Math.min(1, t / JET.taxiTime);
    const pose = deckPath(JET_DECK.taxi, ease(p));
    if (p < 0.15) pose.yaw = JET_DECK.parkYaw * (1 - p / 0.15) + pose.yaw * (p / 0.15);
    return { ...pose, wingsOut: p > 0.6, flame: 0 };
  }
  if (jet.state === "spool") return { x: JET_DECK.catapult[0], z: JET_DECK.catapultZ, yaw: 0, wingsOut: true, flame: Math.min(1, t / JET.spoolTime) };
  if (jet.state === "catapult") {
    const p = Math.min(1, t / JET.catapultTime);
    const [from, to] = JET_DECK.catapult;
    return { x: from + (to - from) * p * p, z: JET_DECK.catapultZ, yaw: 0, wingsOut: true, flame: 1 };
  }
  if (jet.state === "land") {
    const p = Math.min(1, t / JET.landTime);
    const [x, z] = landingPoint(1 + (JET_DECK.landStop - 1) * (1 - (1 - p) ** 3));
    return { x, z, yaw: -JET_DECK.landAngle, wingsOut: true, flame: 0 };
  }
  // Taxiing back from the landing area to its parking spot.
  const p = Math.min(1, t / JET.taxiBackTime);
  const pose = deckPath([landingPoint(JET_DECK.landStop), [6, 1.2], [3, -2.6], JET_DECK.park], ease(p));
  if (p > 0.85) pose.yaw += (JET_DECK.parkYaw - pose.yaw) * ((p - 0.85) / 0.15);
  return { ...pose, wingsOut: p < 0.3, flame: 0 };
}

function newJet() {
  return { state: "parked", t: 0, readyAt: 0, hp: JET.hp, x: 0, y: 0, alt: 0, angle: 0, speed: 0, turn: 0, target: null, hostile: false, warnings: 0, nextBurstAt: 0, missileAt: -99, fuel: 0, orbit: 0, extendUntil: 0 };
}

function jetPirates() {
  const list = [];
  if (mode === "single" && game.ai && !game.ai.capsized) list.push(game.ai);
  for (const raider of game.pirateRaiders) if (!raider.capsized && !raider.entering) list.push(raider);
  return list;
}

function nearestPirate(from, range) {
  let best = null;
  let bestD = range;
  for (const p of jetPirates()) {
    const d = dist(from, p);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

// Points along the carrier's centre line, `k` deck units forward (negative: aft).
function carrierPoint(ship, k) {
  return { x: ship.x + Math.cos(ship.angle) * k * CARRIER_DECK_SCALE, y: ship.y + Math.sin(ship.angle) * k * CARRIER_DECK_SCALE };
}

// Steers a flying jet towards (gx, gy) at height `alt`; returns how far it
// still is. It turns tighter when slow (a fixed turn radius, as a real jet).
function flyJet(jet, gx, gy, alt, speed, dt) {
  const err = normalizeAngle(Math.atan2(gy - jet.y, gx - jet.x) - jet.angle);
  const rate = (JET.turnRate * JET.speed) / Math.max(40, jet.speed);
  const turn = clamp(err, -rate * dt, rate * dt);
  jet.angle += turn;
  jet.turn = turn / Math.max(dt, 1e-3); // banks into the turn in the 3D view
  jet.speed += (speed - jet.speed) * Math.min(1, dt * 1.5);
  jet.x += Math.cos(jet.angle) * jet.speed * dt;
  jet.y += Math.sin(jet.angle) * jet.speed * dt;
  jet.alt += clamp(alt - jet.alt, -JET.climbRate * dt, JET.climbRate * dt);
  return Math.hypot(gx - jet.x, gy - jet.y);
}

function updateCarrierJets(dt) {
  game.jetBursts = game.jetBursts.filter((b) => (b.age += dt) < (b.big ? 2.2 : 1.4));
  game.jetTracers = game.jetTracers.filter((tr) => (tr.age += dt) < 0.25);
  for (const ship of humanShips()) {
    if (ship.category !== "Carrier") continue;
    if (!ship.jet) ship.jet = newJet();
    updateJet(ship, ship.jet, dt);
  }
}

function updateJet(ship, jet, dt) {
  const now = game.elapsed;
  jet.t += dt;
  const go = (state) => {
    jet.state = state;
    jet.t = 0;
    jet.leg = 0; // the landing pattern starts with the downwind leg
  };
  const say = (text) => setUiMessage(text, ship.playerSlot);
  switch (jet.state) {
    case "parked": {
      if (now < jet.readyAt || ship.capsized || ship.anchored || safeInHarbour(ship)) return;
      const pirate = nearestPirate(ship, JET.patrolRange * (1 + 0.25 * crewSkill(ship, "airboss")));
      if (!pirate) return;
      Object.assign(jet, { target: pirate, hostile: false, warnings: 0, hp: JET.hp });
      go("taxi");
      say("Pirate ahead: a jet is taxiing to the catapult");
      return;
    }
    case "taxi":
      if (jet.t >= JET.taxiTime) {
        go("spool");
        playJetSpool(ship.x, ship.y);
      }
      return;
    case "spool":
      if (jet.t >= JET.spoolTime) {
        go("catapult");
        playJetLaunch(ship.x, ship.y);
        crewGain(ship, "airboss", 30);
      }
      return;
    case "catapult":
      if (jet.t >= JET.catapultTime) {
        const bow = carrierPoint(ship, 24.6);
        Object.assign(jet, { x: bow.x, y: bow.y, alt: JET.deckAlt, angle: ship.angle, speed: JET.speed * 0.7, fuel: JET.fuel });
        go("climb");
        say("Jet launched: warning the pirate off");
      }
      return;
    case "land":
      if (jet.t >= JET.landTime) go("taxiBack");
      return;
    case "taxiBack":
      if (jet.t >= JET.taxiBackTime) {
        go("parked");
        jet.readyAt = now + JET.cooldown * (1 - 0.5 * crewSkill(ship, "airboss"));
      }
      return;
    case "down":
      // Spinning down into the sea.
      jet.alt -= (25 + jet.t * 30) * dt;
      jet.angle += dt * 2.2;
      jet.x += Math.cos(jet.angle) * jet.speed * 0.5 * dt;
      jet.y += Math.sin(jet.angle) * jet.speed * 0.5 * dt;
      if (jet.alt <= 0) {
        playExplosion(jet.x, jet.y, 0.7);
        game.jetBursts.push({ x: jet.x, y: jet.y, age: 0, big: true });
        go("lost");
        jet.readyAt = now + JET.replaceTime * (1 - 0.5 * crewSkill(ship, "airboss"));
      }
      return;
    case "lost":
      if (now >= jet.readyAt) {
        go("parked");
        say("A new jet is ready on the carrier");
      }
      return;
  }

  // In the air.
  jet.fuel -= dt;
  piratesFireAtJet(ship, jet, dt);
  if (jet.state === "down") return;
  const target = jet.target && !jet.target.capsized && jetPirates().includes(jet.target) ? jet.target : null;
  if (target && (dist(target, ship) < JET.redLine || target.attackedPlayerAt > now - 6)) jet.hostile = true;
  const homeward = jet.state === "return" || jet.state === "final";
  if (!homeward && (!target || jet.fuel <= 0 || ship.capsized || dist(target, ship) > JET.patrolRange * 1.4 * (1 + 0.25 * crewSkill(ship, "airboss")))) {
    go("return");
    if (target && jet.fuel <= 0) say("Jet low on fuel: coming back to the carrier");
  }

  // Too close to line up (on a pirate, or on the deck): fly straight out for a
  // moment, then come round again for a straight run in, as pilots do.
  const extend = (seconds) => (jet.extendUntil = now + seconds);
  if (jet.extendUntil > now && jet.state === "attack") {
    flyJet(jet, jet.x + Math.cos(jet.angle) * 300, jet.y + Math.sin(jet.angle) * 300, 40, JET.speed, dt);
    return;
  }

  switch (jet.state) {
    case "climb":
      flyJet(jet, target.x, target.y, JET.cruiseAlt, JET.speed, dt);
      if (jet.t > 2.5) go("intercept");
      return;
    case "intercept": {
      const d = flyJet(jet, target.x, target.y, JET.cruiseAlt, JET.speed, dt);
      if (jet.hostile && jet.warnings > 0) go("attack");
      else if (d < JET.warnRadius * 1.3) {
        jet.orbit = Math.atan2(jet.y - target.y, jet.x - target.x);
        jet.nextBurstAt = now + 0.5;
        go("warn");
      }
      return;
    }
    case "warn": {
      // Circle the pirate, firing bursts into the water just ahead of its bow.
      jet.orbit += (dt * JET.speed) / JET.warnRadius;
      flyJet(jet, target.x + Math.cos(jet.orbit) * JET.warnRadius, target.y + Math.sin(jet.orbit) * JET.warnRadius, JET.cruiseAlt * 0.7, JET.speed, dt);
      if (now >= jet.nextBurstAt) {
        jet.nextBurstAt = now + JET.burstEvery;
        jet.warnings += 1;
        const ahead = 45 + Math.random() * 25;
        const side = (Math.random() - 0.5) * 30;
        const bx = target.x + Math.cos(target.angle) * ahead - Math.sin(target.angle) * side;
        const by = target.y + Math.sin(target.angle) * ahead + Math.cos(target.angle) * side;
        for (let k = 0; k < 6; k++) {
          const sx = bx + (Math.random() - 0.5) * 22;
          const sy = by + (Math.random() - 0.5) * 22;
          game.jetBursts.push({ x: sx, y: sy, age: -k * 0.06, big: false });
          if (k % 2 === 0) game.jetTracers.push({ x1: jet.x, y1: jet.y, a1: jet.alt, x2: sx, y2: sy, a2: 0, age: -k * 0.06, color: 0xffd36b });
        }
        playMachineGun(jet.x, jet.y, 8);
        if (jet.warnings === 1) say("Jet firing warning shots at the pirate");
      }
      if (jet.hostile) {
        go("attack");
        say("The pirate pressed on: the jet is attacking");
      }
      return;
    }
    case "attack": {
      const d = flyJet(jet, target.x, target.y, 30, JET.speed * 1.05, dt);
      const aim = Math.abs(normalizeAngle(Math.atan2(target.y - jet.y, target.x - jet.x) - jet.angle));
      // After a long try without a clean run, any rough aim will do: the missile homes in.
      const enough = jet.t > 12 ? 1.2 : 0.5;
      if (d < 130 && aim > enough) extend(3); // overhead and not lined up
      else if (d < JET.missileRange && aim < enough && now - jet.missileAt > JET.rearm) {
        game.missiles.push({ x: jet.x, y: jet.y, vx: Math.cos(jet.angle), vy: Math.sin(jet.angle), target, ttl: 4.4, owner: ship });
        playMissileLaunch(jet.x, jet.y);
        jet.missileAt = now;
        go("breakaway");
      }
      return;
    }
    case "breakaway":
      // Pull away past the pirate, then come round for another look.
      flyJet(jet, jet.x + Math.cos(jet.angle) * 300, jet.y + Math.sin(jet.angle) * 300, JET.cruiseAlt, JET.speed, dt);
      if (jet.t > 3.5) go(jet.hostile ? "attack" : "warn");
      return;
    case "return": {
      // The landing pattern: the downwind leg to a point well astern and off
      // to the side the jet is on, then onto the deck's centre line and
      // along it (steering for a point on the line just ahead, which brings
      // the jet's heading round to the deck's), so it arrives lined up.
      const fx = Math.cos(ship.angle);
      const fy = Math.sin(ship.angle);
      const along = (jet.x - ship.x) * fx + (jet.y - ship.y) * fy; // + ahead of the carrier's centre
      const across = (jet.x - ship.x) * -fy + (jet.y - ship.y) * fx;
      const stern = -25 * CARRIER_DECK_SCALE;
      if (!jet.leg) {
        const side = Math.sign(across) || 1;
        const gx = ship.x + fx * (stern - 330) - fy * 160 * side;
        const gy = ship.y + fy * (stern - 330) + fx * 160 * side;
        if (flyJet(jet, gx, gy, 30, JET.speed * 0.85, dt) < 80) jet.leg = 1;
      } else {
        const ahead = Math.min(along + 160, stern);
        flyJet(jet, ship.x + fx * ahead, ship.y + fy * ahead, 30, JET.speed * 0.85, dt);
        const lined = Math.abs(normalizeAngle(jet.angle - ship.angle)) < 0.35 && Math.abs(across) < 20;
        if (lined && along < stern - 60) go("final");
        else if (along > stern - 40) jet.leg = 0; // reached the stern still not lined up: round again
      }
      return;
    }
    case "final": {
      // Down the glide path to the stern, slowing to landing speed.
      const stern = carrierPoint(ship, -25);
      const d = flyJet(jet, stern.x, stern.y, JET.deckAlt, 60, dt);
      const aim = Math.abs(normalizeAngle(Math.atan2(stern.y - jet.y, stern.x - jet.x) - jet.angle));
      // Off the line (or the carrier turned away): go round again from astern.
      if (jet.t > 12 || (d < 90 && aim > 0.7)) go("return");
      else if (d < 35) {
        go("land");
        if (target === null) say("Jet back on board");
      }
    }
  }
}

// Pirates shoot back at a jet within reach; three hits bring it down. A
// pirate that fires at the jet has attacked: the jet answers with a missile.
function piratesFireAtJet(ship, jet, dt) {
  for (const p of jetPirates()) {
    if (dist(p, jet) > JET.pirateFireRange || p.deterredUntil > game.elapsed) continue;
    p.jetFireIn = (p.jetFireIn ?? randomInterval(JET.pirateFireEvery)) - dt;
    if (p.jetFireIn > 0) continue;
    p.jetFireIn = randomInterval(JET.pirateFireEvery);
    p.attackedPlayerAt = game.elapsed;
    jet.target = jet.target && !jet.target.capsized ? jet.target : p;
    jet.hostile = true;
    game.jetTracers.push({ x1: p.x, y1: p.y, a1: 4, x2: jet.x, y2: jet.y, a2: jet.alt, age: 0, color: 0xff7a2a });
    playCannonShot(p.x, p.y);
    if (Math.random() < JET.pirateHitChance) {
      jet.hp -= 1;
      if (jet.hp <= 0) {
        playExplosion(jet.x, jet.y, 0.5);
        jet.state = "down";
        jet.t = 0;
        setUiMessage("Your jet was shot down! A new one in 45 s", ship.playerSlot);
        return;
      }
      setUiMessage("Your jet is hit!", ship.playerSlot);
    }
  }
}

function findMissileTarget(owner) {
  const candidates = [];
  if (game.ai && !game.ai.capsized) candidates.push(game.ai);
  for (const raider of game.pirateRaiders) {
    if (!raider.capsized) candidates.push(raider);
  }
  for (const creature of game.seaCreatures) {
    candidates.push(creature);
  }
  for (const enemy of game.underwaterEnemies) {
    if (!enemy.capsized) candidates.push(enemy);
  }

  let best = null;
  let bestDist = 430;
  for (const c of candidates) {
    const d = dist(owner, c);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

function updateMissiles(dt) {
  for (const ship of humanShips()) {
    if (ship.capsized || !ship.autoMissile) continue;
    ship.missileCooldown -= dt;
    if (ship.missileCooldown <= 0) {
      const target = findMissileTarget(ship);
      if (target) {
        playMissileLaunch(ship.x, ship.y);
        game.missiles.push({ x: ship.x, y: ship.y, vx: 0, vy: 0, target, ttl: 4.4, owner: ship });
        ship.missileCooldown = 8.6;
      } else {
        ship.missileCooldown = 1.6;
      }
    }
  }

  for (let i = game.missiles.length - 1; i >= 0; i -= 1) {
    const m = game.missiles[i];
    // Later rounds of a burst wait on deck, riding with the ship.
    if (m.delay > 0) {
      m.delay -= dt;
      m.x = m.owner.x;
      m.y = m.owner.y;
      if (m.owner.capsized) game.missiles.splice(i, 1);
      continue;
    }
    m.ttl -= dt;
    if (m.kind === "laser") {
      if (m.ttl <= 0) game.missiles.splice(i, 1);
      continue;
    }
    if (m.ttl <= 0 || !m.target) {
      game.missiles.splice(i, 1);
      continue;
    }

    if (m.target.capsized) {
      game.missiles.splice(i, 1);
      continue;
    }
    // A torpedo chasing a ship that reached harbour waters runs out against
    // the breakwater: it fizzles harmlessly.
    if (safeInHarbour(m.target)) {
      playExplosion(m.x, m.y, 0.3);
      game.missiles.splice(i, 1);
      continue;
    }

    const dx = m.target.x - m.x;
    const dy = m.target.y - m.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const shotSpeed = SHOT_SPEED[m.kind];
    if (shotSpeed) {
      // Gun rounds and water jets fly flat out straight at the target.
      // A hit is only scored when the round reaches it this frame.
      if (len <= shotSpeed * dt + 18) {
        resolveCannonHit(m.owner, m.target, SHOT_SHARE[m.kind], m.kind);
        game.missiles.splice(i, 1);
        continue;
      }
      m.vx = (dx / len) * shotSpeed;
      m.vy = (dy / len) * shotSpeed;
    } else {
      const speed = m.kind === "torpedo" ? 250 : m.kind === "sonic" ? 620 : 330;
      m.vx += (dx / len) * speed * dt;
      m.vy += (dy / len) * speed * dt;
      m.vx *= keepPer60(0.94, dt);
      m.vy *= keepPer60(0.94, dt);
    }
    m.x += m.vx * dt;
    m.y += m.vy * dt;

    if (missileBlockedByTerrain(m)) {
      if (shotSpeed) playShotHit(m.kind, m.x, m.y, true);
      else playExplosion(m.x, m.y, 0.5);
      game.missiles.splice(i, 1);
      continue;
    }

    if (dist(m, m.target) < 18) {
      resolveCannonHit(m.owner, m.target, 1, m.kind || "missile");
      game.missiles.splice(i, 1);
    }
  }
}

// Islands, the volcano, and icebergs are solid: a torpedo/sonic shot that
// flies into one detonates on impact instead of passing through.
function missileBlockedByTerrain(m) {
  if (terrainDepth(m.x, m.y) < -12) return true;
  for (const hz of hazards) {
    if (dist(m, hz) <= hz.r) return true;
  }
  return false;
}

// Sea creatures and underwater enemies steer straight at their target with
// no hazard awareness, so without this they'd swim right across islands,
// the volcano, and icebergs. Ships already stop dead via processHazards'
// instant-capsize on contact, but these entities have no such damage model,
// so instead they're just shoved back out to the hazard's solid edge.
function blockEntityFromHazards(entity) {
  if (game.mission) keepAfloat(entity, entity.radius || 14);
  for (const hz of hazards) {
    const dx = entity.x - hz.x;
    const dy = entity.y - hz.y;
    const d = Math.hypot(dx, dy) || 0.001;
    const minDist = hz.r + (entity.radius || 14);
    if (d < minDist) {
      entity.x = hz.x + (dx / d) * minDist;
      entity.y = hz.y + (dy / d) * minDist;
    }
  }
  // The harbours' land and breakwaters are solid too (they slide along them).
  const reach = entity.radius || 14;
  for (const p of HARBOUR_LAND) {
    const sx = p.bx - p.ax;
    const sy = p.by - p.ay;
    const k = clamp(((entity.x - p.ax) * sx + (entity.y - p.ay) * sy) / (sx * sx + sy * sy || 1), 0, 1);
    const cx = p.ax + sx * k;
    const cy = p.ay + sy * k;
    const d = Math.hypot(entity.x - cx, entity.y - cy) || 0.001;
    if (d < p.r + reach) {
      entity.x = cx + ((entity.x - cx) / d) * (p.r + reach);
      entity.y = cy + ((entity.y - cy) / d) * (p.r + reach);
    }
  }
}

// Lightning strikes and volcano eruptions are world events (not just
// pictures), so both the 3D and the classic 2D view show them and the sound
// matches. They run on their own clock so the menu backdrop stays alive too;
// sounds only play while sailing.
let natureClock = 0;

// A tileable picture of lava: dark cooled crust broken into plates by
// glowing cracks (a wrapped Voronoi pattern), with mottled hot spots.
// Built once; the 3D view uses it as a texture, the 2D map as a pattern.
let lavaCanvasCache = null;
function lavaCanvas() {
  if (lavaCanvasCache) return lavaCanvasCache;
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const img = g.createImageData(size, size);
  const seeds = [];
  for (let i = 0; i < 26; i += 1) seeds.push([Math.random() * size, Math.random() * size, Math.random()]);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let d1 = 1e9;
      let d2 = 1e9;
      let heat = 0;
      for (const [sx, sy, h] of seeds) {
        let dx = Math.abs(x - sx);
        let dy = Math.abs(y - sy);
        if (dx > size / 2) dx = size - dx; // wrap so the picture tiles
        if (dy > size / 2) dy = size - dy;
        const d = dx * dx + dy * dy;
        if (d < d1) {
          d2 = d1;
          d1 = d;
          heat = h;
        } else if (d < d2) {
          d2 = d;
        }
      }
      const edge = Math.sqrt(d2) - Math.sqrt(d1); // 0 on a crack
      const crack = Math.max(0, 1 - edge / 7);
      const glow = Math.pow(crack, 1.6);
      const mottle = 0.5 + 0.5 * Math.sin(x * 0.21 + Math.sin(y * 0.13) * 3) * Math.sin(y * 0.17 + heat * 6);
      const crust = 18 + mottle * 22 + heat * 14;
      const i = (y * size + x) * 4;
      img.data[i] = Math.min(255, crust + glow * 255);
      img.data[i + 1] = Math.min(255, crust * 0.4 + glow * (55 + crack * 115));
      img.data[i + 2] = Math.min(255, crust * 0.3 + glow * glow * 60);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  lavaCanvasCache = c;
  return c;
}
const ERUPTION_BUILD = 1.2; // seconds of rumbling before the blast
const ERUPTION_TIME = 10;
const LAVA_REST = 0.2; // how far lava reaches down the slopes between eruptions

// Eruption hazards. A rock that lands on a ship takes a quarter of its full
// health and sets it on fire; lava floating on the sea takes 5% from
// anything that sails or swims through it (once per LAVA_HIT_COOLDOWN).
const ROCK_FLIGHT = 1.8; // seconds from the crater to the sea
const ROCK_HIT_RADIUS = 26;
const ROCK_DAMAGE = 0.25;
const LAVA_DAMAGE = 0.05;
const LAVA_HIT_COOLDOWN = 1.5;
const LAVA_POOL_TIME = 10; // seconds a patch lasts (spreads, cools, sinks)
const LAVA_POOL_HOT = 0.6; // share of that time it still burns
// A fire spreads until it is put out: it starts at 2% of full health a
// second and grows (intensity 1 -> 4), so an unattended ship burns down and
// capsizes in roughly 20 seconds. Pirates put theirs out after a few seconds.
const FIRE_DAMAGE_PER_SEC = 0.02; // share of full health, at intensity 1
const FIRE_SPREAD_PER_SEC = 0.12; // intensity added each second
const FIRE_MAX_INTENSITY = 4;
const AI_PUTS_OUT_FIRE = 3;
// Under a storm's rain a fire on board burns at 40% and dies back instead
// of spreading.
const RAIN_FIRE_DAMAGE = 0.4;
const RAIN_FIRE_DAMPING_PER_SEC = 0.15; // intensity lost each second

function shipInRain(ship) {
  return dynamicDangers.some((dz) => dist(ship, dz) <= dz.r);
}

// The five directions lava runs down a volcano (shared with the 3D view).
function volcanoLavaAngles(hz) {
  if (!hz.lavaAngles) hz.lavaAngles = [0, 1, 2, 3, 4].map((i) => i * 1.257 + Math.random() * 0.5);
  return hz.lavaAngles;
}

function lavaPoolRadius(pool) {
  return pool.size * (1 + pool.life * 3.5) * 0.72 * (0.5 + pool.stretch * 0.5);
}

function updateEruptionDebris(hz, dt, audible) {
  const e = hz.eruption || 0;
  // Rocks fly out while the volcano blows (about 10 per eruption).
  if (e > 0.3 && Math.random() < dt * 2.6 * e) {
    const a = Math.random() * Math.PI * 2;
    const d = hz.r + 60 + Math.random() * 380;
    game.volcanoRocks.push({
      volcano: hz,
      tx: clamp(hz.x + Math.cos(a) * d, 20, WORLD_W - 20),
      ty: clamp(hz.y + Math.sin(a) * d, 20, WORLD_H - 20),
      t: 0,
      spin: Math.random() * 6
    });
  }
  // Lava leaves the shore at the foot of the streams.
  const intoSea = hz.lavaInSea || 0;
  if (intoSea > 0 && natureClock >= (hz.nextPoolAt || 0)) {
    hz.nextPoolAt = natureClock + 0.12 + (1 - intoSea) * 0.5;
    const angles = volcanoLavaAngles(hz);
    const a = angles[Math.floor(Math.random() * angles.length)] + (Math.random() - 0.5) * 0.25;
    const speed = 16 + Math.random() * 18;
    game.lavaPools.push({
      x: hz.x + Math.cos(a) * hz.r * 1.12,
      y: hz.y + Math.sin(a) * hz.r * 1.12,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      size: hz.r * (0.05 + Math.random() * 0.05),
      stretch: 0.6 + Math.random() * 0.8,
      turn: Math.random() * Math.PI,
      life: 0
    });
  }
}

function updateRocksAndPools(dt, audible) {
  for (let i = game.volcanoRocks.length - 1; i >= 0; i -= 1) {
    const rock = game.volcanoRocks[i];
    rock.t += dt / ROCK_FLIGHT;
    if (rock.t < 1) continue;
    game.volcanoRocks.splice(i, 1);
    if (audible) rockLands(rock);
  }
  for (let i = game.lavaPools.length - 1; i >= 0; i -= 1) {
    const pool = game.lavaPools[i];
    pool.life += dt / LAVA_POOL_TIME;
    if (pool.life >= 1) {
      game.lavaPools.splice(i, 1);
      continue;
    }
    pool.x += pool.vx * dt * (1 - pool.life);
    pool.y += pool.vy * dt * (1 - pool.life);
  }
}

function rockLands(rock) {
  let hitSomething = false;
  for (const ship of allCombatShips()) {
    if (Math.hypot(ship.x - rock.tx, ship.y - rock.ty) > ROCK_HIT_RADIUS + (ship.radius || 16)) continue;
    hitSomething = true;
    damageShip(ship, ship.maxHull * ROCK_DAMAGE, "hit by a volcano rock", false, true);
    if (ship.capsized) continue;
    setShipOnFire(ship);
    if (ship.isHuman) {
      setUiMessage(ship.owned && ship.owned.fireFighting
        ? `${ship.playerName} is on fire! Press ${keyName(game.settings.keybinds[ship.playerSlot + "Fire"])} to put it out`
        : `${ship.playerName} is on fire! (Fire Fighting Equipment from the Dockyard puts it out)`);
    }
  }
  playRockImpact(rock.tx, rock.ty, hitSomething);
}

function setShipOnFire(ship) {
  if (ship.fire) {
    ship.fire.intensity = Math.min(FIRE_MAX_INTENSITY, ship.fire.intensity + 1); // a second hit feeds it
    return;
  }
  ship.fire = { intensity: 1, outAt: ship.isHuman ? Infinity : natureClock + AI_PUTS_OUT_FIRE };
}

function putOutFire(ship) {
  if (!ship.fire) return;
  ship.fire = null;
  ship.fireOutAt = natureClock; // the 3D view puffs steam
  crewGain(ship, "bosun", 25);
  crewGain(ship, "pump", 25);
  playFireOut(ship.x, ship.y);
}

// The "put out the fire" button (F / . or a click on the HUD button).
function extinguishFireForSlot(slot) {
  const ship = slot === "p2" ? game.player2 : game.player1;
  if (!ship || !ship.fire || ship.capsized) return;
  if (!ship.owned || !ship.owned.fireFighting) {
    setUiMessage("No Fire Fighting Equipment on board. Buy it in the Dockyard.");
    playUiError();
    return;
  }
  putOutFire(ship);
  setUiMessage(`${ship.playerName}: fire is out!`);
}

// Acoustic deterrent (a long-range hailing device): blasts a painful
// high-pitched tone at pirates nearby. The game doesn't play the tone, it
// shows it on screen. Every pirate in range makes its own call: break off for
// a while, or grit its teeth and press ahead.
const DETERRENT_RANGE = 300;
const DETERRENT_COOLDOWN = 20; // s before it can sound again
const DETERRENT_BREAK_OFF = 9; // s a deterred pirate keeps clear and holds fire

function soundDeterrentForSlot(slot) {
  const ship = slot === "p2" ? game.player2 : game.player1;
  if (!ship || ship.capsized) return;
  if (!ship.owned || !ship.owned.acousticDeterrent) {
    setUiMessage("No Acoustic Deterrent on board. Buy it in the Dockyard.");
    playUiError();
    return;
  }
  const wait = (ship.deterrentReadyAt || 0) - game.elapsed;
  if (wait > 0) {
    setUiMessage(`Acoustic Deterrent recharging: ${Math.ceil(wait)}s`);
    playUiError();
    return;
  }
  ship.deterrentReadyAt = game.elapsed + DETERRENT_COOLDOWN;

  let fled = 0;
  let pressed = 0;
  for (const pirate of [game.ai, ...game.pirateRaiders]) {
    if (!pirate || pirate.capsized || !pirate.aiControlled || dist(pirate, ship) > DETERRENT_RANGE) continue;
    if (pirateIsDeterred(pirate, ship)) {
      fled += 1;
      pirate.deterredUntil = game.elapsed + DETERRENT_BREAK_OFF;
      pirate.deterredFrom = ship;
      if (pirate === game.ai) {
        resetPirateHail(game.aiDirector); // a boarding in progress is abandoned too
        pirateCallout(pirate, "Argh, me ears! Hard about, lads!");
      }
    } else {
      pressed += 1;
      if (pirate === game.ai) {
        game.aiDirector.hostile = true;
        pirateCallout(pirate, "Ye'll need more than noise to stop us! Open fire!");
      }
    }
  }

  const outcome = fled + pressed === 0 ? "no pirates in range"
    : pressed === 0 ? (fled > 1 ? "pirates break off!" : "pirate breaks off!")
    : fled === 0 ? (pressed > 1 ? "pirates press ahead!" : "pirate presses ahead!")
    : `${fled} break off, ${pressed} press ahead!`;
  setUiMessage(`((( HIGH-PITCH DETERRENT ))) ${ship.playerName}: ${outcome}`);
}

// The pirate's call. A loud blast (close range) on a battered pirate chasing
// a still-healthy ship drives it off; a fresh pirate closing on a crippled
// prize presses on. Each blast it has already sat through makes it less
// impressed by the next one.
function pirateIsDeterred(pirate, prey) {
  const closeness = 1 - dist(pirate, prey) / DETERRENT_RANGE;
  const pirateHull = pirate.hp / (pirate.maxHull || 100);
  const preyHull = prey.hp / (prey.maxHull || 100);
  const used = pirate.deterrentsHeard || 0;
  pirate.deterrentsHeard = used + 1;
  const chance = clamp(0.2 + 0.35 * closeness + 0.3 * (1 - pirateHull) + 0.25 * preyHull - 0.15 * used, 0.1, 0.9);
  return Math.random() < chance;
}

// Where a deterred pirate heads: well away from the ship that blasted it.
function deterredGoal(pirate) {
  const from = pirate.deterredFrom;
  const dx = pirate.x - from.x;
  const dy = pirate.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    x: clamp(pirate.x + (dx / len) * 260, 40, WORLD_W - 40),
    y: clamp(pirate.y + (dy / len) * 260, 40, WORLD_H - 40)
  };
}

// Fires burn every frame; lava patches burn whatever goes through them.
function updateEruptionDamage(dt) {
  for (const ship of allCombatShips()) {
    if (!ship.fire) continue;
    const fire = ship.fire;
    fire.inRain = shipInRain(ship);
    if (fire.inRain) fire.intensity = Math.max(1, fire.intensity - RAIN_FIRE_DAMPING_PER_SEC * dt);
    else {
      const party = Math.max(crewSkill(ship, "bosun"), crewSkill(ship, "pump"));
      fire.intensity = Math.min(FIRE_MAX_INTENSITY, fire.intensity + FIRE_SPREAD_PER_SEC * (1 - 0.5 * party) * dt);
    }
    // Scorching stays on the hull after the fire is out (shown in 3D and 2D).
    ship.burn = Math.min(1, (ship.burn || 0) + dt * 0.05 * fire.intensity);
    // Steady burning shouldn't trigger the red "just hit" flash every frame.
    const flash = ship.hitFlash;
    const rainFactor = fire.inRain ? RAIN_FIRE_DAMAGE : 1;
    damageShip(ship, ship.maxHull * FIRE_DAMAGE_PER_SEC * fire.intensity * rainFactor * dt, "fire on board", false, true);
    ship.hitFlash = flash;
    if (ship.capsized) {
      if (ship.isHuman) setUiMessage(`${ship.playerName}'s ship burned down and capsized`);
      continue;
    }
    if (natureClock >= fire.outAt) putOutFire(ship);
  }
  if (!game.lavaPools.length) return;
  const victims = [...allCombatShips(), ...game.underwaterEnemies, ...game.seaCreatures];
  for (const pool of game.lavaPools) {
    if (pool.life > LAVA_POOL_HOT) continue;
    const r = lavaPoolRadius(pool);
    for (const v of victims) {
      if (natureClock - (v.lavaHitAt || -99) < LAVA_HIT_COOLDOWN) continue;
      if (Math.hypot(v.x - pool.x, v.y - pool.y) > r + (v.radius || 14) * 0.5) continue;
      v.lavaHitAt = natureClock;
      if (v.maxHull && v.capsized !== undefined && (v.isHuman !== undefined || v.aiControlled)) {
        damageShip(v, v.maxHull * LAVA_DAMAGE, "burned by lava", false, true);
      } else if (v.maxHull) {
        v.hp -= v.maxHull * LAVA_DAMAGE; // submarines
      } else {
        v.despawnAt -= v.despawnAt * LAVA_DAMAGE; // sea creatures: 5% less time
      }
      v.hitFlash = 0.2;
      playLavaBurn(v.x, v.y);
    }
  }
}

// Fog banks: thick sea fog that rolls in at random spots, is carried along
// by the wind and rolls out again. Never more than FOG_MAX_BANKS at once and
// each only a few hundred units across, so most of the sea stays clear. A
// round starts clear: the first bank comes at a random time FOG_FIRST after
// the start. Looks only (and sound): it hides things, it doesn't hurt.
const FOG_MAX_BANKS = 2;
const FOG_FADE = 12; // seconds to roll in, and again to roll out
const FOG_FIRST = [60, 180]; // seconds into a round before the first bank, at random
const FOG_WIND_SHARE = 0.9; // a bank drifts with this share of the wind
let fogBanks = [];
let nextFogAt = Infinity; // set when a round starts (resetGame)

function startFogForRound() {
  // A mission's own mist stays where it is; otherwise banks come and go.
  fogBanks = (game.mission?.fog || []).map(([x, y, r]) => ({ x, y, r, vx: 0, vy: 0, age: FOG_FADE, hold: 1e9, density: 1, seed: Math.random() * 100, fixed: true }));
  nextFogAt = game.mission ? Infinity : natureClock + FOG_FIRST[0] + Math.random() * (FOG_FIRST[1] - FOG_FIRST[0]);
}

function smooth01(x) {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

function updateFogBanks(dt) {
  if (gameState === "playing" && fogBanks.length < FOG_MAX_BANKS && natureClock >= nextFogAt) {
    const r = 260 + Math.random() * 170;
    const dir = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 4; // its own drift, on top of the wind
    fogBanks.push({
      x: r * 0.6 + Math.random() * (WORLD_W - r * 1.2),
      y: r * 0.6 + Math.random() * (WORLD_H - r * 1.2),
      r,
      vx: Math.cos(dir) * speed,
      vy: Math.sin(dir) * speed,
      age: 0,
      hold: 35 + Math.random() * 45,
      density: 0,
      seed: Math.random() * 100
    });
    nextFogAt = natureClock + 40 + Math.random() * 70;
  }
  for (let i = fogBanks.length - 1; i >= 0; i -= 1) {
    const bank = fogBanks[i];
    bank.age += dt;
    const drift = bank.fixed ? 0 : dt;
    bank.x += (bank.vx + game.wind.x * FOG_WIND_SHARE) * drift;
    bank.y += (bank.vy + game.wind.y * FOG_WIND_SHARE) * drift;
    const out = bank.age - FOG_FADE - bank.hold;
    bank.density = bank.age < FOG_FADE ? smooth01(bank.age / FOG_FADE) : out < 0 ? 1 : 1 - smooth01(out / FOG_FADE);
    const gone = bank.x < -bank.r || bank.y < -bank.r || bank.x > WORLD_W + bank.r || bank.y > WORLD_H + bank.r;
    if (out > FOG_FADE || gone) fogBanks.splice(i, 1);
  }
}

// 0..1: how thick the fog is at a point (soft towards a bank's edge).
function fogAt(x, y) {
  let fog = 0;
  for (const bank of fogBanks) {
    const d = Math.hypot(x - bank.x, y - bank.y);
    fog = Math.max(fog, bank.density * (1 - smooth01((d - bank.r * 0.5) / (bank.r * 0.5))));
  }
  return fog;
}

function updateNature(dt) {
  natureClock += dt;
  updateFogBanks(dt);
  const audible = gameState === "playing";
  updateRocksAndPools(dt, audible);
  for (const dz of dynamicDangers) {
    if (dz.arriveIn > 0) continue; // not blown in yet: no lightning or thunder
    if (dz.nextBoltAt === undefined) {
      dz.nextBoltAt = natureClock + 1 + Math.random() * 4;
      dz.boltAt = -99;
    }
    if (natureClock >= dz.nextBoltAt) {
      dz.nextBoltAt = natureClock + 2.5 + Math.random() * 5;
      dz.boltAt = natureClock;
      dz.boltX = (Math.random() - 0.5) * dz.r;
      dz.boltY = (Math.random() - 0.5) * dz.r;
      if (audible) playThunder(dz.x + dz.boltX, dz.y + dz.boltY);
    }
  }
  // Thunder and lightning rage once the tempest is well under way, anywhere near the players' view.
  if (tempest.intensity > 0.5 && natureClock >= tempest.nextBoltAt) {
    tempest.nextBoltAt = natureClock + (1.4 + Math.random() * 3.6) * (1.7 - tempest.intensity * 0.7);
    const f = cameraFocus();
    const cx = f.inWorld ? f.x : WORLD_W / 2;
    const cy = f.inWorld ? f.y : WORLD_H / 2;
    tempest.boltAt = natureClock;
    tempest.boltX = cx + (Math.random() - 0.5) * 1100;
    tempest.boltY = cy + (Math.random() - 0.5) * 1100;
    if (audible) playThunder(tempest.boltX, tempest.boltY);
  }
  for (const hz of hazards) {
    if (hz.kind !== "volcano") continue;
    if (hz.nextEruptAt === undefined) {
      hz.nextEruptAt = natureClock + 8 + Math.random() * 14;
      hz.eruptAt = -99;
      hz.lavaFlow = LAVA_REST;
    }
    if (natureClock >= hz.nextEruptAt) {
      hz.eruptAt = natureClock;
      // a mission's great eruption keeps them blowing
      hz.nextEruptAt = natureClock + (hz.fury ? 7 + Math.random() * 7 : 24 + Math.random() * 22);
      if (audible) playEruption(hz.x, hz.y);
    }
    // 0..1: rises while it rumbles, peaks at the blast, then dies down.
    const since = natureClock - hz.eruptAt;
    if (since < ERUPTION_BUILD) hz.eruption = 0.25 * (since / ERUPTION_BUILD);
    else hz.eruption = Math.max(0, 1 - (since - ERUPTION_BUILD) / (ERUPTION_TIME - ERUPTION_BUILD));
    // Lava oozes down the slopes during the eruption and slowly cools back.
    if (hz.eruption > 0.3) hz.lavaFlow = Math.min(1, hz.lavaFlow + dt * 0.16);
    else hz.lavaFlow = Math.max(LAVA_REST, hz.lavaFlow - dt * 0.015);
    // 0..1: how much lava is pouring off the shore into the sea.
    hz.lavaInSea = clamp((hz.lavaFlow - 0.75) * 4, 0, 1);
    updateEruptionDebris(hz, dt, audible);
  }
}

function handleGameLogic(dt) {
  if (gameState !== "playing") return;
  if (game.tugOfferPending) {
    game.tugOfferPending = false;
    offerTugPull();
  }
  offerShipChange();

  game.elapsed += dt;
  updateTempestWeather(dt);
  updateWind(dt);
  updateSeaState(dt);

  const p1Input = {
    forward: isActionPressed("p1Forward"),
    backward: isActionPressed("p1Backward"),
    left: isActionPressed("p1Left"),
    right: isActionPressed("p1Right"),
    thrust: thrusterInput("p1")
  };

  updateAnchor(game.player1);
  updateMooring(game.player1, dt);
  applyMovement(game.player1, p1Input, dt);

  if (mode === "local") {
    const p2Input = {
      forward: isActionPressed("p2Forward"),
      backward: isActionPressed("p2Backward"),
      left: isActionPressed("p2Left"),
      right: isActionPressed("p2Right"),
      thrust: thrusterInput("p2")
    };
    updateAnchor(game.player2);
    updateMooring(game.player2, dt);
    applyMovement(game.player2, p2Input, dt);
  } else if (game.ai) {
    const ai = braceForTsunami(game.ai, aiInput(game.ai, game.player1, dt));
    applyMovement(game.ai, ai, dt);
  }

  updateIcebergs(dt);
  updateDynamicDangers(dt);
  updateWaterSpout(dt);
  updateTsunami(dt);
  updateWhirlpool(dt);
  updateHazardCollisions();
  updateShipCollisions(dt);
  updateLandCollisions();
  updatePirateRaiders(dt);
  updateTows(dt);
  updateGalley(dt);
  updateSeaCreatures(dt);
  updateUnderwaterEnemies(dt);
  keepEnemiesOutOfHarbours();
  updateMissiles(dt);
  updateCarrierJets(dt);
  updateMission(dt);
  if (gameState !== "playing") return; // the mission ran out of time
  updateEruptionDamage(dt);
  updateScore(dt);
  updateFloatingScores(dt);
  updateTargetAlerts(dt);
  updateLookout();
  crewUpdate(dt);

  processHazards(game.player1, dt);
  processHazards(game.player2, dt);
  processHazards(game.ai, dt);

  if (mode === "single" && game.ai && !game.ai.capsized) {
    if (!inHarbourSanctuary(game.player1)) {
      // The pirate only opens fire on a ship that refused to heave to; one
      // that surrendered is boarded and plundered instead.
      if (game.aiDirector.hostile && dist(game.ai, game.player1) < 105 && game.elapsed > game.aiDirector.attackUnlockedAt) {
        attack(game.ai, game.player1, dt);
      }
      // Theft only happens once the pirate is anchored alongside a ship that
      // has surrendered, never while it is still sailing past.
      if (game.aiDirector.anchored) plunderShip(game.ai, game.player1, dt);
    }
  }

  for (const ship of humanShips()) {
    if (!ship.capsized && nearHarbourB(ship) && game.elapsed > ship.nextDockAwardAt && (!game.mission || missionReady())) {
      awardScore(ship, 50 + crewDelivery(ship), "Harbour-delivery");
      playShipHorn();
      const arrivalSound = playArrival(); // seconds, 0 if sound is off
      if (game.mission) {
        endMission(true, `Mission complete: ${game.mission.name}`);
        return;
      }
      startNextCrossing();
      // Keys are ignored until the arrival music (and horn) has finished.
      // Measured on the real clock: the music keeps playing while the game is
      // in the background, but the game's own clock stops there.
      if (game.arrival) {
        game.arrival.readyAt = performance.now() + (arrivalSound > 0 ? Math.max(1.3, arrivalSound) : 0) * 1000;
      }
      return;
    }
  }

  if (humanShips().every((ship) => ship.capsized)) {
    // In 3D, first watch her go down under the sea.
    if (view3d.active && humanShips().some((ship) => game.elapsed - ship.sankAt < SINK_SCENE_TIME)) return;
    commitRoundScores();
    gameState = "ended";
    stopLookout();
    const overFalls = humanShips().some((ship) => ship.overFalls !== undefined);
    resultText = game.mission
      ? `Mission failed: ${game.mission.name} - ${overFalls ? "swept over the waterfall" : capsizedMessage().toLowerCase()}`
      : capsizedMessage();
  }
}

function drawHazards() {
  for (const hz of hazards) {
    ctx.beginPath();
    ctx.arc(hz.x, hz.y, hz.danger, 0, Math.PI * 2);
    ctx.fillStyle = hz.kind === "volcano" ? "rgba(237, 82, 55, 0.18)" : hz.kind === "iceberg" ? "rgba(193, 237, 255, 0.2)" : "rgba(181, 141, 77, 0.15)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(hz.x, hz.y, hz.r, 0, Math.PI * 2);
    if (hz.kind === "island") ctx.fillStyle = "#5e8d46";
    if (hz.kind === "iceberg") ctx.fillStyle = "#d5f4ff";
    if (hz.kind === "volcano") ctx.fillStyle = "#92381f";
    ctx.fill();

    // Crisp border improves map readability of hazard silhouettes.
    ctx.strokeStyle = hz.kind === "island" ? "#2f4f22" : hz.kind === "iceberg" ? "#7fb3c8" : "#4f1b11";
    ctx.lineWidth = 2;
    ctx.stroke();
    if (hz.kind === "volcano") drawLava2d(hz);
  }
  drawEruptionDebris2d();
}

// Lava streams creep out from the crater as an eruption goes on; while it
// erupts, glowing bombs fly out. Lava reaching the sea spreads and fades.
let lavaPatternCache = null;
function lavaPattern2d() {
  if (!lavaPatternCache) lavaPatternCache = ctx.createPattern(lavaCanvas(), "repeat");
  return lavaPatternCache;
}

// Big prompt for each player whose ship is burning: press the key (with Fire
// Fighting Equipment) or a warning that the ship will burn down. In split
// screen each prompt sits in its player's half; otherwise they stack.
// Inside Harbour B's berthing ring and not yet anchored: a banner telling the
// captain to drop anchor, which completes the voyage. It pulses until they
// do. In split screen it sits in that player's half.
function drawBerthPrompts() {
  if (gameState !== "playing") return;
  const split = view3d.active && view3d.split;
  for (const ship of humanShips()) {
    if (!ship || ship.capsized || (ship.anchored && ship.ropes >= 1) || berthedHarbour(ship) !== HarbourB) continue;
    if (!ship.anchored && carrackPort(ship)) continue; // she is towed in (drawTowPrompts)
    const p2 = ship.playerSlot === "p2";
    const cx = split ? (p2 ? (WIDTH * 3) / 4 : WIDTH / 4) : WIDTH / 2;
    const cy = HEIGHT - 150 - (!split && p2 ? 70 : 0);
    const w = split ? WIDTH / 2 - 60 : 600;
    const slowEnough = Math.abs(ship.speed) < ANCHOR_REST_SPEED * 2;
    const pulse = 0.7 + 0.3 * Math.sin(performance.now() / 220);
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = `rgba(16, 52, 86, ${0.82 + 0.1 * pulse})`;
    ctx.fillRect(cx - w / 2, cy - 32, w, 64);
    ctx.strokeStyle = `rgba(140, 220, 255, ${pulse})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - w / 2, cy - 32, w, 64);
    ctx.fillStyle = "#e9f7ff";
    ctx.font = "bold 20px Segoe UI";
    const who = mode === "local" ? `${ship.playerName}: ` : "";
    const key = ANCHOR_KEY_NAMES[ship.playerSlot];
    const berthed = atBerth(ship);
    const unfinished = game.mission && !missionReady();
    ctx.fillText(unfinished ? `${who}HARBOUR B - FINISH YOUR OBJECTIVES FIRST` : ship.anchored ? `${who}MAKING FAST - YOU ARRIVE WHEN THE LINES ARE SECURE` : berthed ? `${who}HARBOUR B - DROP ANCHOR TO FINISH` : `${who}HARBOUR B - BRING THE SHIP ALONGSIDE ITS BERTH`, cx, cy - 6);
    ctx.font = "15px Segoe UI";
    ctx.fillStyle = ship.anchored || (berthed && slowEnough) ? "#9dffb4" : "#ffd9a8";
    ctx.fillText(
      ship.anchored ? "Hold on: the mooring lines are being made fast" :
      !berthed ? "Steer into the marked berth, alongside the quay, then slow down" :
      slowEnough ? `Press ${key} to anchor now (or come to rest)` : `Ease off the engine and slow down, then press ${key}`,
      cx, cy + 20);
    ctx.restore();
  }
}

// Once the last mooring line is clear: a green banner tells the captain the
// ship is ready to sail. It shows for READY_SIGNAL_TIME seconds.
function drawReadyToSail() {
  if (gameState !== "playing") return;
  const split = view3d.active && view3d.split;
  for (const ship of humanShips()) {
    if (!ship || ship.capsized || ship.anchored || ship.readyAt === undefined || game.elapsed - ship.readyAt > READY_SIGNAL_TIME) continue;
    const p2 = ship.playerSlot === "p2";
    const cx = split ? (p2 ? (WIDTH * 3) / 4 : WIDTH / 4) : WIDTH / 2;
    const cy = HEIGHT - 150 - (!split && p2 ? 70 : 0);
    const w = split ? WIDTH / 2 - 60 : 420;
    const pulse = 0.7 + 0.3 * Math.sin(performance.now() / 180);
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = `rgba(14, 70, 44, ${0.82 + 0.1 * pulse})`;
    ctx.fillRect(cx - w / 2, cy - 26, w, 52);
    ctx.strokeStyle = `rgba(157, 255, 180, ${pulse})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - w / 2, cy - 26, w, 52);
    ctx.fillStyle = "#e9ffee";
    ctx.font = "bold 20px Segoe UI";
    ctx.fillText(`${mode === "local" ? `${ship.playerName}: ` : ""}ALL LINES CLEAR - READY TO SAIL`, cx, cy + 7);
    ctx.restore();
  }
}

// "Player 1 (Captain Azure)".
function playerLabel(ship) {
  const who = `Player ${ship.playerSlot === "p2" ? 2 : 1}`;
  return ship.playerName ? `${who} (${ship.playerName})` : who;
}

// 2-player: when a ship capsizes its captain is out. A big notice for a few
// seconds, then a small tag that stays while the other player sails on. In
// split screen both sit in the out player's half.
const OUT_NOTICE_TIME = 4;

function drawPlayersOut() {
  if (mode !== "local" || gameState !== "playing") return;
  const split = view3d.active && view3d.split;
  for (const ship of humanShips()) {
    if (!ship || !ship.capsized || ship.outAt === undefined) continue;
    const cx = split ? (ship.playerSlot === "p2" ? (WIDTH * 3) / 4 : WIDTH / 4) : WIDTH / 2;
    const age = game.elapsed - ship.outAt;
    ctx.save();
    ctx.textAlign = "center";
    if (age < OUT_NOTICE_TIME) {
      ctx.globalAlpha = clamp(Math.min(age * 3, (OUT_NOTICE_TIME - age) * 2), 0, 1);
      const w = split ? WIDTH / 2 - 60 : 560;
      const cy = split ? HEIGHT - 190 : HEIGHT / 2 - 90; // in split screen, below the wreck
      ctx.fillStyle = "rgba(10, 20, 32, 0.86)";
      ctx.fillRect(cx - w / 2, cy - 40, w, 80);
      ctx.strokeStyle = "rgba(255, 120, 100, 0.9)";
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - w / 2, cy - 40, w, 80);
      ctx.fillStyle = "#ffd9d0";
      ctx.font = "bold 24px Segoe UI";
      ctx.fillText("SHIP CAPSIZED", cx, cy - 8);
      ctx.font = "17px Segoe UI";
      ctx.fillStyle = "#f2f6f9";
      ctx.fillText(`${playerLabel(ship)} is out of the game`, cx, cy + 22);
    } else {
      ctx.fillStyle = "rgba(10, 20, 32, 0.75)";
      ctx.fillRect(cx - 150, 128, 300, 26);
      ctx.fillStyle = "#ffcabe";
      ctx.font = "bold 13px Segoe UI";
      ctx.fillText(`${playerLabel(ship).toUpperCase()} - OUT`, cx, 146);
    }
    ctx.restore();
  }
}

function drawFirePrompts() {
  const burning = humanShips().filter((ship) => ship.fire && !ship.capsized);
  if (!burning.length) return;
  const split = view3d.active && view3d.split;
  const pulse = 0.65 + 0.35 * Math.sin(performance.now() / 160);
  ctx.save();
  ctx.textAlign = "center";
  burning.forEach((ship, i) => {
    const p2 = ship.playerSlot === "p2";
    const cx = split ? (p2 ? (WIDTH * 3) / 4 : WIDTH / 4) : WIDTH / 2;
    // under whatever else is at the top: the bridge's instruments or the mission panel
    const bridge = view3d.active && game.settings.cameraView === "bridge";
    const panel = game.mission && !bridge && !split ? missionPanelRect() : null;
    const cy = (bridge ? 150 : panel ? panel.y + panel.h + 34 : 100) + (split ? 0 : i * 62);
    const kit = ship.owned && ship.owned.fireFighting;
    const w = split ? WIDTH / 2 - 40 : 560;
    ctx.fillStyle = `rgba(120, 18, 8, ${0.82 * pulse + 0.1})`;
    ctx.fillRect(cx - w / 2, cy - 26, w, 52);
    ctx.strokeStyle = "rgba(255, 196, 120, 0.9)";
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - w / 2, cy - 26, w, 52);
    ctx.fillStyle = "#fff3df";
    ctx.font = "bold 19px Segoe UI";
    const name = mode === "local" ? `${ship.playerName}: ` : "";
    const damped = ship.fire.inRain;
    ctx.fillText(kit ? `${name}FIRE ON BOARD!` : damped ? `${name}RAIN IS DAMPING THE FIRE` : `${name}FIRE SPREADING!`, cx, cy - 4);
    ctx.font = "15px Segoe UI";
    ctx.fillStyle = "#ffd9a8";
    ctx.fillText(
      kit
        ? `Press ${keyName(game.settings.keybinds[p2 ? "p2Fire" : "p1Fire"])} to put out the fire`
        : damped
          ? "It burns slower here, but it is still burning"
          : "No Fire Fighting Equipment: the ship will burn down",
      cx,
      cy + 17
    );
  });
  ctx.restore();
}

// Rocks in flight (with a red ring where each will land) and lava patches
// on the sea, for the classic 2D map.
// Classic 2D map: each fog bank is a soft white patch drawn over the ships.
function drawFog2d() {
  if (!fogBanks.length) return;
  ctx.save();
  applyWorldTransform2d();
  for (const bank of fogBanks) {
    for (let i = 0; i < 6; i += 1) {
      const a = bank.seed + i * 1.05 + natureClock * 0.02;
      const off = i === 0 ? 0 : bank.r * 0.35;
      const cx = bank.x + Math.cos(a) * off;
      const cy = bank.y + Math.sin(a) * off;
      const rr = bank.r * (i === 0 ? 0.85 : 0.6);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
      g.addColorStop(0, `rgba(226, 232, 236, ${0.55 * bank.density})`);
      g.addColorStop(0.6, `rgba(226, 232, 236, ${0.3 * bank.density})`);
      g.addColorStop(1, "rgba(226, 232, 236, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawEruptionDebris2d() {
  ctx.save();
  for (const pool of game.lavaPools) {
    const r = lavaPoolRadius(pool);
    ctx.globalAlpha = Math.min(1, (1 - pool.life) * 1.8) * 0.9;
    ctx.fillStyle = lavaPattern2d();
    ctx.beginPath();
    ctx.ellipse(pool.x, pool.y, r, r * pool.stretch, pool.turn, 0, Math.PI * 2);
    ctx.fill();
    if (pool.life < LAVA_POOL_HOT) {
      ctx.fillStyle = `rgba(255, 110, 30, ${0.35 * (1 - pool.life / LAVA_POOL_HOT)})`;
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  for (const rock of game.volcanoRocks) {
    const hz = rock.volcano;
    ctx.strokeStyle = `rgba(255, 70, 40, ${0.45 + 0.4 * rock.t})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(rock.tx, rock.ty, ROCK_HIT_RADIUS * (1.6 - rock.t * 0.6), 0, Math.PI * 2);
    ctx.stroke();
    const x = hz.x + (rock.tx - hz.x) * rock.t;
    const y = hz.y + (rock.ty - hz.y) * rock.t - Math.sin(Math.PI * rock.t) * 90;
    ctx.fillStyle = "#3a1d12";
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 140, 50, 0.8)";
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawLava2d(hz) {
  const flow = hz.lavaFlow || LAVA_REST;
  const e = hz.eruption || 0;
  ctx.save();
  ctx.strokeStyle = lavaPattern2d();
  ctx.lineCap = "round";
  ctx.lineWidth = 6;
  for (let i = 0; i < 5; i += 1) {
    const a = i * 1.257 + hz.r;
    const len = hz.r * (0.25 + flow * (0.55 + 0.15 * Math.sin(i * 2.1)));
    ctx.beginPath();
    ctx.moveTo(hz.x, hz.y);
    ctx.quadraticCurveTo(hz.x + Math.cos(a + 0.3) * len * 0.5, hz.y + Math.sin(a + 0.3) * len * 0.5, hz.x + Math.cos(a) * len, hz.y + Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.fillStyle = lavaPattern2d();
  ctx.beginPath();
  ctx.arc(hz.x, hz.y, hz.r * (0.22 + e * 0.12), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(255, 170, 60, ${0.15 + e * 0.35})`;
  ctx.fill();
  if (e > 0.25) {
    const since = natureClock - hz.eruptAt;
    for (let i = 0; i < 14; i += 1) {
      const life = (since * 0.9 + i / 14) % 1;
      const a = i * 2.4;
      const d = hz.r * (0.2 + life * 1.1);
      ctx.fillStyle = `rgba(255, ${120 + i * 8}, 40, ${(1 - life) * e})`;
      ctx.beginPath();
      ctx.arc(hz.x + Math.cos(a) * d, hz.y + Math.sin(a) * d, 3 + (1 - life) * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// Classic 2D night: darken the sea, then let lava glow through it. Ships are
// drawn on top afterwards with their navigation lights.
function drawNight2d() {
  ctx.save();
  ctx.fillStyle = "rgba(4, 10, 28, 0.62)";
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  ctx.globalCompositeOperation = "lighter";
  const t = performance.now() / 1000;
  const glow = (x, y, r, a) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255, 120, 40, ${a})`);
    g.addColorStop(1, "rgba(255, 60, 10, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  for (const hz of hazards) {
    if (hz.kind !== "volcano") continue;
    const e = hz.eruption || 0;
    glow(hz.x, hz.y, hz.r * (1.3 + e), 0.35 + e * 0.4 + Math.sin(t * 3.1) * 0.04);
  }
  for (const pool of game.lavaPools) {
    glow(pool.x, pool.y, pool.size * (1 + pool.life * 3.5) * 1.6, 0.4 * Math.pow(1 - pool.life, 2));
  }
  ctx.restore();
}

// Navigation lights in the classic 2D view: red to port, green to
// starboard, white at the stern; the pirate's candle flickers amber. The
// carrack has no navigation lights, only her candle.
function drawNavLights2d(ship) {
  const dot = (x, y, color, r) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  const carrack = ship.category === "Carrack";
  if (!carrack) {
    dot(4, -8, "#ff3b30", 2.4);
    dot(4, 8, "#38ff6a", 2.4);
    dot(-12, 0, "#ffffff", 2);
  }
  if (ship.type === "pirate" || carrack) {
    const t = performance.now() / 1000;
    const flick = 0.65 + 0.2 * Math.sin(t * 13) + 0.15 * Math.sin(t * 31 + 1.3);
    dot(-6, 0, `rgba(255, 180, 70, ${0.35 * flick})`, 7);
    dot(-6, 0, `rgba(255, 214, 130, ${flick})`, 2.2);
  }
}

// Puff offsets (as a fraction of radius) that read as a cloud silhouette
// rather than a hazard circle, so storms are never mistaken for solid hazards.
const STORM_PUFFS = [
  { dx: -0.62, dy: 0.12, s: 0.5 },
  { dx: -0.2, dy: -0.22, s: 0.68 },
  { dx: 0.28, dy: -0.05, s: 0.62 },
  { dx: 0.68, dy: 0.16, s: 0.46 },
  { dx: 0.05, dy: 0.28, s: 0.56 }
];

function drawStormCloud(dz) {
  const r = dz.r;
  if (natureClock - dz.boltAt < 0.16) {
    ctx.save();
    ctx.strokeStyle = "rgba(250, 252, 255, 0.95)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    let x = dz.x + dz.boltX;
    let y = dz.y + dz.boltY - r * 0.4;
    ctx.moveTo(x, y);
    for (let i = 0; i < 5; i += 1) {
      x += (Math.sin(dz.boltAt * 37 + i * 5.1)) * 12;
      y += r * 0.16;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  ctx.fillStyle = "rgba(70, 82, 96, 0.4)";
  ctx.beginPath();
  ctx.ellipse(dz.x, dz.y + r * 0.32, r * 0.92, r * 0.36, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "rgba(196, 208, 218, 0.5)";
  ctx.strokeStyle = "rgba(228, 238, 245, 0.55)";
  ctx.lineWidth = 2;
  for (const p of STORM_PUFFS) {
    ctx.beginPath();
    ctx.arc(dz.x + p.dx * r, dz.y + p.dy * r, r * p.s, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(178, 210, 255, 0.45)";
  ctx.lineWidth = 2;
  const streaks = 5;
  for (let i = 0; i < streaks; i++) {
    const sx = dz.x - r * 0.7 + (r * 1.4 * i) / (streaks - 1);
    const sy = dz.y + r * 0.5;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx - 7, sy + r * 0.4);
    ctx.stroke();
  }
}

function drawDynamicDangers() {
  for (const dz of dynamicDangers) {
    drawStormCloud(dz);
  }
}

// Top-down water spout: while dormant it's off-screen and drawn as nothing.
// It fades in with a tightening warning ring as it travels in from the edge,
// then becomes a spinning column of water with spray while it crosses and
// exits the play area.
function drawWaterSpout(sp) {
  const state = sp.state;
  if (state === "dormant") return;

  const r = sp.r;

  if (state === "forming") {
    // The cloud gathering overhead.
    const grow = 1 - sp.timer / WATER_SPOUT_FORM_TIME;
    ctx.fillStyle = `rgba(90, 100, 112, ${0.15 + 0.3 * grow})`;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, r * (0.6 + 0.9 * grow), 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  if (state === "warning") {
    const progress = 1 - sp.timer / WATER_SPOUT_WARN_TIME;
    const pulse = 0.5 + 0.5 * Math.sin(game.elapsed * 14);
    ctx.strokeStyle = `rgba(255, 205, 90, ${0.35 + 0.35 * pulse})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, r * (0.35 + 0.5 * progress), 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = "rgba(196, 228, 255, 0.25)";
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, r * 0.3, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // active
  ctx.fillStyle = "rgba(120, 190, 225, 0.28)";
  ctx.beginPath();
  ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
  ctx.fill();

  const spin = game.elapsed * 6;
  const rings = 4;
  for (let i = 0; i < rings; i++) {
    const ringR = r * (0.25 + (i / rings) * 0.75);
    const alpha = 0.55 - i * 0.1;
    ctx.strokeStyle = `rgba(224, 245, 255, ${Math.max(0.15, alpha)})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, ringR, spin + i * 0.8, spin + i * 0.8 + Math.PI * 1.4);
    ctx.stroke();
  }

  const droplets = 8;
  for (let i = 0; i < droplets; i++) {
    const angle = spin * 1.5 + (i / droplets) * Math.PI * 2;
    const dr = r * (0.9 + 0.2 * Math.sin(game.elapsed * 10 + i));
    const dx = sp.x + Math.cos(angle) * dr;
    const dy = sp.y + Math.sin(angle) * dr;
    ctx.fillStyle = "rgba(235, 250, 255, 0.7)";
    ctx.beginPath();
    ctx.arc(dx, dy, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Draws in a frame rotated so the wave travels along +x: local (s, t) maps to
// world s*dir + t*perp, so s is the same coordinate updateTsunami uses.
function drawTsunami() {
  if (tsunami.state === "dormant") return;
  const span = Math.hypot(WORLD_W, WORLD_H);
  ctx.save();
  ctx.rotate(Math.atan2(tsunami.dirY, tsunami.dirX));

  if (tsunami.state === "warning") {
    // Pulsing strip on the edge the wave will come from.
    const pulse = 0.5 + 0.5 * Math.sin(game.elapsed * 12);
    ctx.fillStyle = `rgba(255, 90, 60, ${0.25 + 0.35 * pulse})`;
    ctx.fillRect(tsunami.front + 30, -span, 22, span * 2);
    ctx.restore();
    return;
  }

  const f = tsunami.front;
  const body = ctx.createLinearGradient(f - TSUNAMI_BAND, 0, f, 0);
  body.addColorStop(0, "rgba(20, 90, 120, 0)");
  body.addColorStop(0.6, "rgba(18, 110, 140, 0.55)");
  body.addColorStop(0.9, "rgba(90, 185, 205, 0.75)");
  body.addColorStop(1, "rgba(200, 240, 250, 0.85)");
  ctx.fillStyle = body;
  ctx.fillRect(f - TSUNAMI_BAND, -span, TSUNAMI_BAND, span * 2);

  // Curling white lip along the front.
  ctx.fillStyle = "rgba(245, 252, 255, 0.92)";
  ctx.beginPath();
  ctx.moveTo(f - 26, -span);
  for (let t = -span; t <= span; t += 12) {
    ctx.lineTo(f + 6 * Math.sin(t * 0.045 + game.elapsed * 7), t);
  }
  ctx.lineTo(f - 26, span);
  ctx.closePath();
  ctx.fill();

  // Spray flung ahead of the crest.
  ctx.fillStyle = "rgba(235, 250, 255, 0.75)";
  for (let t = -span; t <= span; t += 22) {
    const jitter = Math.sin(t * 1.7 + game.elapsed * 11);
    ctx.beginPath();
    ctx.arc(f + 8 + 10 * (jitter + 1), t + 6 * jitter, 2 + (jitter + 1), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawTsunamiWarning() {
  if (tsunami.state !== "warning" || gameState !== "playing") return;
  const pulse = 0.5 + 0.5 * Math.sin(game.elapsed * 10);
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "bold 30px sans-serif";
  ctx.fillStyle = `rgba(255, ${120 + 80 * pulse}, 70, 1)`;
  ctx.fillText("TSUNAMI INCOMING!", WIDTH / 2, 120);
  ctx.font = "16px sans-serif";
  ctx.fillStyle = "#f4fbff";
  ctx.fillText("Point your bow or stern at the wave or you will capsize", WIDTH / 2, 146);
  ctx.restore();
}

function drawWaterSpouts() {
  drawWaterSpout(waterSpout);
}

function drawHarbours() {
  ctx.font = "bold 20px Segoe UI";
  for (const h of [HarbourA, HarbourB]) {
    if (h === HarbourB && !harbourBSighted()) continue;
    const p = worldToScreen(h.x, h.y, 70);
    if (!p.visible) continue;
    const w = ctx.measureText(h.name).width + 18;
    const lh = 30;
    const { x, y } = placeLabel(p.x, p.y - lh / 2, w, lh);
    const moved = Math.hypot(x + w / 2 - p.x, y + lh / 2 - p.y) > 20;
    if (moved && p.x >= 0 && p.x <= WIDTH && p.y >= 0 && p.y <= HEIGHT) {
      // A thin line back to the harbour so it's clear what the label names.
      ctx.strokeStyle = "rgba(242, 248, 251, 0.45)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(clamp(p.x, x, x + w), clamp(p.y, y, y + lh));
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(4, 18, 28, 0.6)";
    ctx.fillRect(x, y, w, lh);
    ctx.fillStyle = "#f2f8fb";
    ctx.fillText(h.name, x + 9, y + 22);
  }
}

// A capsule land piece as a canvas path (scale for the mini-map).
function landPath(p, s = 1, ox = 0, oy = 0) {
  const a = Math.atan2(p.by - p.ay, p.bx - p.ax);
  ctx.beginPath();
  ctx.arc(ox + p.ax * s, oy + p.ay * s, p.r * s, a + Math.PI / 2, a + (Math.PI * 3) / 2);
  ctx.arc(ox + p.bx * s, oy + p.by * s, p.r * s, a - Math.PI / 2, a + Math.PI / 2);
  ctx.closePath();
}

const LAND_COLORS_2D = { coast: "#6f9a4e", mole: "#8a8780", moored: "#c9c2b0" };
const SNOW_2D = "#e9f0f4";
const LIMESTONE_2D = "#c2a874"; // the coast in the carrack's age

function coastColor2d(modern) {
  return oldEra() ? LIMESTONE_2D : game.polar ? SNOW_2D : modern;
}

function drawHarbourDiscs() {
  for (const p of HARBOUR_LAND) {
    landPath(p);
    ctx.fillStyle = p.kind === "coast" ? coastColor2d(LAND_COLORS_2D.coast) : LAND_COLORS_2D[p.kind];
    ctx.fill();
  }
  for (const [h, color] of [[HarbourA, "rgba(47, 143, 98, 0.45)"], [HarbourB, "rgba(63, 111, 184, 0.45)"]]) {
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

function drawShip(ship, label) {
  if (!ship) return;
  if (!view3d.active) {
    ctx.save();
    applyWorldTransform2d();
    drawShipBody(ship);
    ctx.restore();
  }

  // No name label over a captain's wreck: the 3D view may be under water with it.
  if (view3d.active && ship.capsized && ship.isHuman) return;

  // Seen from just behind (chase view) a label at mast height floats near the
  // horizon, far above the ship; attach it lower so it sits over the funnel.
  const followed = view3d.active && game.settings.cameraView !== "overview" &&
    (ship === game.player1 || (mode === "local" && ship === game.player2));
  // Standing on your own bridge, your ship's name would float in your face.
  if (followed && game.settings.cameraView === "bridge") return;
  const top = view3d.active ? view3d.shipTop(ship) : 0;
  const p = worldToScreen(ship.x, ship.y, followed ? top * 0.65 : top + 6);
  // (a name just past the edge is pulled in; one far off stays off)
  if (!p.visible || p.x < -250 || p.x > WIDTH + 250) return;
  const hpPct = clamp(ship.hp / (ship.maxHull || 100), 0, 1);
  ctx.save();
  ctx.font = "bold 17px Segoe UI";
  ctx.textAlign = "center";
  const box = placeLabel(p.x, p.y - 54, Math.max(66, ctx.measureText(label).width + 8), 32);
  const cx = box.x + box.w / 2;
  ctx.fillStyle = "#ecf5f9";
  outlinedText(label, cx, box.y + 17);
  ctx.fillStyle = "rgba(17, 33, 47, 0.8)";
  ctx.fillRect(cx - 32, box.y + 23, 64, 8);
  ctx.fillStyle = hpPct > 0.35 ? "#58cc7c" : "#f87254";
  ctx.fillRect(cx - 32, box.y + 23, 64 * hpPct, 8);
  ctx.restore();
}

function drawShipFire2d(ship) {
  if (ship.burn) {
    // Scorch marks: the hull darkens as it burns.
    ctx.fillStyle = `rgba(20, 12, 8, ${0.55 * ship.burn})`;
    ctx.beginPath();
    ctx.ellipse(ship.x, ship.y, 16, 10, ship.angle, 0, Math.PI * 2);
    ctx.fill();
  }
  if (!ship.fire) return;
  const t = performance.now() / 1000;
  const n = 3 + Math.round(ship.fire.intensity * 2);
  for (let i = 0; i < n; i += 1) {
    const life = (t * 1.4 + i / n) % 1;
    ctx.fillStyle = `rgba(30, 26, 24, ${0.5 * (1 - life)})`; // smoke
    ctx.beginPath();
    ctx.arc(ship.x + game.wind.x * life * 0.6, ship.y - life * 30 + game.wind.y * life * 0.6, 5 + life * 12, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < n; i += 1) {
    const flick = 0.6 + 0.4 * Math.sin(t * 13 + i * 2.1);
    ctx.fillStyle = `rgba(255, ${110 + (i % 4) * 35}, 30, ${0.8 * flick})`;
    ctx.beginPath();
    ctx.arc(ship.x + Math.sin(i * 1.9) * 9, ship.y + Math.cos(i * 2.3) * 6 - flick * 4, 3 + flick * 3 + ship.fire.intensity, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawShipBody(ship) {
  drawShipFire2d(ship);
  ctx.save();
  ctx.translate(ship.x, ship.y);
  ctx.rotate(ship.angle);

  if (ship.capsized) {
    ctx.rotate(Math.PI * 0.55);
  }

  const color = ship.displayColor || (ship.type === "cruise" ? "#2f7ef7" : "#f0d034");

  ctx.beginPath();
  ctx.moveTo(18, 0);
  ctx.lineTo(-13, -10);
  ctx.lineTo(-7, 0);
  ctx.lineTo(-13, 10);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(-4, 0, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = "#0f2434";
  ctx.fill();
  if (game.settings.nightMode && !ship.capsized) drawNavLights2d(ship);

  if (ship.hitFlash > 0) {
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 70, 70, 0.9)";
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  ctx.restore();
}

// Speech bubble over the pirate hunter for its hails ("Heave to!" etc.), so
// the player sees the demand where the action is, not only in the HUD.
// The gangplank: drawn between the hulls while the pirate is anchored and
// boarding, so it's clear the theft is happening.
// 2D view: the pumps on both quays, a tanker's hose to its pump, tow ropes.
function drawHosesAndRopes2d() {
  for (const h of [HarbourA, HarbourB]) {
    for (const [kind, p] of Object.entries(PUMPS)) {
      const at = harbourPoint(h, p.a, p.b);
      ctx.fillStyle = kind === "oil" ? "#2b2b2b" : "#e8eef2";
      ctx.fillRect(at.x - 6, at.y - 6, 12, 12);
      ctx.strokeStyle = kind === "oil" ? "#f0b030" : "#3f86b8";
      ctx.lineWidth = 2;
      ctx.strokeRect(at.x - 6, at.y - 6, 12, 12);
    }
  }
  for (const ship of game.galley ? [...humanShips(), game.galley.boat] : humanShips()) {
    const hose = pumpHose(ship);
    if (hose) {
      ctx.strokeStyle = hose.kind === "oil" ? "#1d1d1d" : "#f2f2f2";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(hose.quay.x, hose.quay.y);
      ctx.lineTo(ship.x, ship.y);
      ctx.stroke();
    }
    if (ship.tow) {
      ctx.strokeStyle = ship.towTaut ? "#f2e2b0" : "rgba(242, 226, 176, 0.6)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ship.x, ship.y);
      ctx.lineTo(ship.tow.x, ship.tow.y);
      ctx.stroke();
    }
  }
}

function drawBoardingPlank() {
  const ship = game.ai;
  const prey = game.player1;
  if (!game.aiDirector || !game.aiDirector.anchored || !ship || ship.capsized || !prey || prey.capsized) return;

  ctx.save();
  ctx.strokeStyle = "#8b5a2b";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(ship.x, ship.y);
  ctx.lineTo(prey.x, prey.y);
  ctx.stroke();
  ctx.restore();
}

function drawPirateCallout() {
  const ship = game.ai;
  const callout = game.aiDirector && game.aiDirector.callout;
  if (!ship || ship.capsized || !callout || game.elapsed > callout.until) return;

  const p = worldToScreen(ship.x, ship.y, view3d.active ? view3d.shipTop(ship) + 6 : 0);
  if (!p.visible) return;
  const above = view3d.active ? 0 : ship.radius;
  ctx.save();
  ctx.font = "bold 13px Segoe UI";
  const w = ctx.measureText(callout.text).width + 18;
  const h = 24;
  const x = clamp(p.x - w / 2, 6, WIDTH - w - 6);
  const y = clamp(p.y - above - h - 18, 6, HEIGHT - h - 6);
  const fade = clamp((callout.until - game.elapsed) / 0.4, 0, 1);
  ctx.globalAlpha = fade;
  ctx.fillStyle = game.aiDirector.hostile ? "rgba(122, 22, 18, 0.92)" : "rgba(20, 18, 10, 0.88)";
  ctx.strokeStyle = "#f0d034";
  ctx.lineWidth = 1.5;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.beginPath();
  const tipX = clamp(p.x, x + 8, x + w - 8);
  ctx.moveTo(tipX - 6, y + h);
  ctx.lineTo(tipX + 6, y + h);
  ctx.lineTo(tipX, y + h + 8);
  ctx.closePath();
  ctx.fillStyle = "#f0d034";
  ctx.fill();
  ctx.fillStyle = "#fff4c2";
  ctx.fillText(callout.text, x + 9, y + 16);
  ctx.restore();
}

function drawPirateRaiders() {
  for (const raider of game.pirateRaiders) {
    drawShip(raider, raider.shipName || "Raider");
  }
}

function drawSeaCreatures() {
  for (const creature of game.seaCreatures) {
    ctx.save();
    ctx.translate(creature.x, creature.y);
    ctx.rotate(creature.angle);
    if (creature.variant === "croc") {
      ctx.fillStyle = "#8aa83a";
      ctx.beginPath();
      ctx.ellipse(-4, 0, 22, 7, 0, 0, Math.PI * 2);
      ctx.ellipse(22, 0, 11, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffd23e";
      ctx.fillRect(14, -5, 3, 3);
      ctx.fillRect(14, 2, 3, 3);
      ctx.restore();
      continue;
    }
    ctx.beginPath();
    ctx.ellipse(0, 0, creature.radius + 4, creature.radius, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#9d5fc5";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(4, -2, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#f8e7ff";
    ctx.fill();
    ctx.restore();
  }
}

function drawUnderwaterEnemies() {
  for (const enemy of game.underwaterEnemies) {
    ctx.save();
    ctx.translate(enemy.x, enemy.y);
    ctx.rotate(enemy.angle);
    ctx.globalAlpha = 0.86;
    ctx.beginPath();
    ctx.ellipse(0, 0, enemy.radius + 6, enemy.radius * 0.62, 0, 0, Math.PI * 2);
    ctx.fillStyle = enemy.color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, enemy.radius + 12, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
}

// Classic 2D map: the carriers' patrol jets at true size (a fighter is about
// 5.5 units long, tiny next to the carrier) but never under JET_MIN_PX on
// screen, with a shadow on the sea that slides off as it climbs, its
// afterburner on the catapult, and the warning bursts, gunfire and crashes.
const JET_MIN_PX = 7;

function drawCarrierJets2d() {
  const k = CARRIER_DECK_SCALE;
  for (const b of game.jetBursts) {
    if (b.age < 0) continue;
    const life = b.big ? 2.2 : 1.4;
    const f = b.age / life;
    ctx.strokeStyle = `rgba(240, 248, 252, ${0.85 * (1 - f)})`;
    ctx.lineWidth = (b.big ? 2.5 : 1.2) / view2d.scale;
    ctx.beginPath();
    ctx.arc(b.x, b.y, (b.big ? 8 + 26 * f : 2 + 6 * f), 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const tr of game.jetTracers) {
    if (tr.age < 0) continue;
    ctx.strokeStyle = `#${tr.color.toString(16).padStart(6, "0")}`;
    ctx.globalAlpha = 1 - tr.age / 0.25;
    ctx.lineWidth = 1.4 / view2d.scale;
    ctx.beginPath();
    ctx.moveTo(tr.x1, tr.y1);
    ctx.lineTo(tr.x2, tr.y2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  for (const ship of humanShips()) {
    const jet = ship.jet;
    if (!jet || jet.state === "parked" || jet.state === "lost") continue;
    let x = jet.x;
    let y = jet.y;
    let angle = jet.angle;
    let alt = jet.alt;
    let wingsOut = true;
    let flame = JET_FLYING.has(jet.state) ? 0.4 : 0;
    if (!JET_FLYING.has(jet.state) && jet.state !== "down") {
      // On the deck: the carrier's own position and heading carry it.
      const pose = jetDeckPose(jet);
      const c = Math.cos(ship.angle);
      const s = Math.sin(ship.angle);
      x = ship.x + (pose.x * c - pose.z * s) * k;
      y = ship.y + (pose.x * s + pose.z * c) * k;
      angle = ship.angle - pose.yaw;
      alt = JET.deckAlt;
      wingsOut = pose.wingsOut;
      flame = pose.flame;
    }
    if (jet.state === "down") angle += game.elapsed * 6;
    const size = Math.max(2.5 * k, JET_MIN_PX / view2d.scale) / 2.5; // the jet drawn in deck units
    const shadow = alt * 0.35;
    drawJetShape2d(x + shadow, y + shadow * 0.6, angle, size, wingsOut, "rgba(5, 20, 30, 0.35)", null, 0);
    drawJetShape2d(x, y, angle, size, wingsOut, "#b9c3cc", "#2b3138", flame);
  }
}

// A top-down fighter, nose along `angle`, `size` world units per deck unit.
function drawJetShape2d(x, y, angle, size, wingsOut, fill, stroke, flame) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(size, size);
  const span = wingsOut ? 1 : 0.72;
  if (flame > 0) {
    ctx.fillStyle = `rgba(255, 160, 60, ${0.5 + 0.5 * flame})`;
    ctx.beginPath();
    ctx.moveTo(-1.1, -0.1);
    ctx.lineTo(-1.1 - 0.5 - flame * 0.6, 0);
    ctx.lineTo(-1.1, 0.1);
    ctx.fill();
  }
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(1.35, 0); // nose
  ctx.lineTo(0.35, 0.12);
  ctx.lineTo(-0.3, span);
  ctx.lineTo(-0.55, span);
  ctx.lineTo(-0.55, 0.14);
  ctx.lineTo(-0.85, 0.16);
  ctx.lineTo(-1.15, 0.55);
  ctx.lineTo(-1.15, 0.12);
  ctx.lineTo(-1.15, -0.12);
  ctx.lineTo(-1.15, -0.55);
  ctx.lineTo(-0.85, -0.16);
  ctx.lineTo(-0.55, -0.14);
  ctx.lineTo(-0.55, -span);
  ctx.lineTo(-0.3, -span);
  ctx.lineTo(0.35, -0.12);
  ctx.closePath();
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 0.08;
    ctx.stroke();
  }
  ctx.restore();
}

function drawMissiles() {
  for (const m of game.missiles) {
    if (m.delay > 0) continue; // still on deck
    if (m.kind === "laser") {
      const hx = (m.vx * m.len) / 2;
      const hy = (m.vy * m.len) / 2;
      ctx.save();
      ctx.globalAlpha = Math.max(0, m.ttl / m.life);
      ctx.lineCap = "round";
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(m.x - hx, m.y - hy);
      ctx.lineTo(m.x + hx, m.y + hy);
      ctx.stroke();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      continue;
    }
    if (m.kind === "water" || m.kind === "ball" || m.kind === "bullet") {
      const angle = Math.atan2(m.vy, m.vx || 0.001);
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.rotate(angle);
      ctx.fillStyle = m.color;
      ctx.beginPath();
      if (m.kind === "water") {
        ctx.globalAlpha = 0.8;
        ctx.ellipse(0, 0, 9, 4.5, 0, 0, Math.PI * 2);
      } else if (m.kind === "bullet") {
        ctx.ellipse(0, 0, 6, 1.4, 0, 0, Math.PI * 2);
      } else {
        ctx.arc(0, 0, 4, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.restore();
      continue;
    }
    if (m.kind === "sonic") {
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.strokeStyle = m.color || "#63e0ff";
      ctx.lineWidth = 2.5;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.arc(0, 0, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      continue;
    }

    const angle = Math.atan2(m.vy, m.vx || 0.001);
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.rotate(angle);
    ctx.fillStyle = m.color || "#ff7147";
    ctx.fillRect(-7, -2.5, 14, 5);
    ctx.fillStyle = "#ffd4a3";
    ctx.fillRect(-12, -1.6, 5, 3.2);
    ctx.restore();
  }
}

function drawTargetAlerts() {
  for (const alert of game.targetAlerts) {
    const ship = alert.ship;
    const p = worldToScreen(ship.x, ship.y, 10);
    if (!p.visible) continue;
    const pulse = 0.55 + Math.sin(alert.pulse) * 0.45;
    ctx.save();
    ctx.strokeStyle = `rgba(255, 70, 70, ${0.45 + pulse * 0.4})`;
    ctx.lineWidth = 4;
    ctx.shadowColor = "rgba(255, 40, 40, 0.85)";
    ctx.shadowBlur = 18;
    ctx.strokeRect(p.x - 36, p.y - 36, 72, 72);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255, 90, 90, 0.95)";
    ctx.font = "bold 19px Segoe UI";
    ctx.fillText(alert.label, clamp(p.x - 44, 8, WIDTH - ctx.measureText(alert.label).width - 8), clamp(p.y - 46, 24, HEIGHT - 8));
    ctx.restore();
  }
}

function drawFloatingScores() {
  for (const popup of game.floatingScores) {
    const alpha = 1 - popup.age / popup.ttl;
    const scale = 1 + Math.sin((popup.age / popup.ttl) * Math.PI) * 0.22;
    const p = worldToScreen(popup.x, popup.y, 30);
    if (!p.visible) continue;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(p.x, p.y);
    ctx.scale(scale, scale);
    ctx.font = "bold 20px Segoe UI";
    ctx.fillStyle = popup.color || "#ffd75e";
    const sign = popup.value.startsWith("-") ? "-" : "+";
    ctx.fillText(sign, -20, 0);
    ctx.fillStyle = "#f5fbff";
    ctx.fillText(popup.value.replace(/^[+-]/, ""), -4, 0);
    ctx.restore();
  }
}

function leaderboardEntries() {
  const entries = [];
  for (const [name, points] of Object.entries(game.profiles.leaderboard)) {
    entries.push({ name, points });
  }
  return entries.sort((a, b) => b.points - a.points).slice(0, 8);
}

function clearLeaderboardScores() {
  game.profiles.leaderboard = {};
  saveProfiles();
  setUiMessage("Leaderboard cleared");
}

function clearPlayerPoints(slot) {
  const profile = getProfile(slot);
  if (!profile) return;
  profile.points = 0;
  saveProfiles();
  setUiMessage(`${profile.name} points reset`);
}

function buySelectedItem() {
  const entries = getShopEntries();
  const item = entries[game.shopIndex];
  const profile = getProfile(game.shopSlot);
  if (!item) return;
  if (item.premiumPack && !game.entitlements[item.premiumPack]) {
    // Premium items are bought with the pack, never earned with points, and never go to the dock unowned.
    setUiMessage(`${item.name} is not owned. Purchase the ${PREMIUM_PACKS[item.premiumPack].name} to use it.`);
    openPremiumScreen(item.premiumPack);
    return;
  }
  if (item.kind === "gadget" && profile.owned[item.id]) {
    setUiMessage(`${item.name} already owned by ${profile.name}`);
    return;
  }
  if (item.kind === "ship" && isShipOwned(profile, item)) {
    profile.selectedShip = item.id;
    saveProfiles();
    setUiMessage(`${item.name} is now in the dockyard`);
    return;
  }
  if (!item.premiumPack && profile.points < item.cost) {
    setUiMessage(`Not enough points for ${item.name}`);
    return;
  }

  if (item.kind === "gadget") {
    profile.points -= item.cost;
    profile.owned[item.id] = true;
    profile.shopSpent += item.cost;
  } else if (item.premiumPack) {
    profile.ownedShips[item.id] = true;
  } else {
    profile.points -= item.cost;
    profile.ownedShips[item.id] = true;
    profile.shopSpent += item.cost;
  }
  if (item.kind === "ship") profile.selectedShip = item.id;
  saveProfiles();
  setUiMessage(`${profile.name} bought ${item.name}`);
}

function sellSelectedItem() {
  const entries = getShopEntries();
  const item = entries[game.shopIndex];
  const profile = getProfile(game.shopSlot);
  if (!item) return;
  if (item.premiumPack) {
    setUiMessage(`${item.name} cannot be sold`);
    return;
  }

  if (item.kind === "gadget") {
    if (!profile.owned[item.id]) {
      setUiMessage(`${item.name} is not owned by ${profile.name}`);
      return;
    }
    profile.owned[item.id] = false;
  } else {
    if (item.defaultOwned || !profile.ownedShips[item.id]) {
      setUiMessage(`${item.name} cannot be sold`);
      return;
    }
    profile.ownedShips[item.id] = false;
    if (profile.selectedShip === item.id) {
      profile.selectedShip = game.shopSlot === "p2" ? "cargoFreighter" : "cruiseLiner";
    }
  }

  const refund = Math.max(1, Math.floor((item.cost || 0) * SELL_REFUND_RATE));
  profile.points += refund;
  profile.shopEarned += refund;
  saveProfiles();
  setUiMessage(`${profile.name} sold ${item.name} for ${refund} points`);
}

function switchShopSlot(nextSlot) {
  game.shopIndexBySlot[game.shopSlot] = game.shopIndex;
  game.shopSlot = nextSlot;
  game.shopIndex = game.shopIndexBySlot[game.shopSlot] || 0;
}

function drawCatalogIcon(entry, x, y, size, isShip = false) {
  ctx.save();
  ctx.translate(x, y);
  if (isShip) {
    ctx.beginPath();
    ctx.moveTo(size * 0.42, 0);
    ctx.lineTo(-size * 0.3, -size * 0.2);
    ctx.lineTo(-size * 0.12, 0);
    ctx.lineTo(-size * 0.3, size * 0.2);
    ctx.closePath();
    ctx.fillStyle = entry.color;
    ctx.fill();
  } else {
    ctx.fillStyle = entry.premiumPack ? "#b68cff" : "#ffd182";
    ctx.fillRect(-size * 0.32, -size * 0.32, size * 0.64, size * 0.64);
    ctx.fillStyle = "#183042";
    ctx.font = "bold 12px Segoe UI";
    ctx.fillText(entry.name.slice(0, 1), -4, 4);
  }
  ctx.restore();
}

const renamePopup = document.getElementById("renamePopup");
const renameInput = document.getElementById("renameInput");
let renameSlot = "p1";

function renameShopProfile() {
  renameSlot = game.shopSlot;
  const profile = getProfile(renameSlot);
  document.getElementById("renameLabel").textContent = `New name for ${profile.name} (${renameSlot.toUpperCase()})`;
  renameInput.value = profile.name;
  keys.clear();
  playUiClick();
  renamePopup.hidden = false;
  renameInput.focus();
  renameInput.select();
}

function closeRenamePopup(save) {
  renamePopup.hidden = true;
  renameInput.blur();
  const nextName = renameInput.value.trim().slice(0, 18);
  if (!save || !nextName) {
    playUi("ui_back", { type: "triangle", from: 700, to: 420, dur: 0.12, peak: 0.09 });
    return;
  }
  getProfile(renameSlot).name = nextName;
  saveProfiles();
  setUiMessage(`Renamed to ${nextName}`);
  playUi("ui_confirm", { type: "triangle", from: 660, to: 990, dur: 0.14, peak: 0.1 });
}

document.getElementById("renameForm").addEventListener("submit", (e) => {
  e.preventDefault();
  closeRenamePopup(true);
});
document.getElementById("renameCancel").addEventListener("click", () => closeRenamePopup(false));

// 2-player chase view: a line between the two halves and whose half is whose.
function drawSplitDivider() {
  if (!view3d.active || !view3d.split) return;
  const mid = WIDTH * (view3d.splitAt ?? 0.5);
  if (Math.abs(mid - WIDTH / 2) > 4) {
    // Collapsing to one view: just the moving edge, no name tags.
    ctx.fillStyle = "rgba(4, 14, 22, 0.9)";
    ctx.fillRect(mid - 2, 0, 4, HEIGHT);
    return;
  }
  ctx.save();
  ctx.fillStyle = "rgba(4, 14, 22, 0.9)";
  ctx.fillRect(WIDTH / 2 - 2, 0, 4, HEIGHT);
  ctx.font = "bold 16px Segoe UI";
  // Name tags either side of the divider, clear of the HUD in the corner.
  const tags = [
    { text: game.player1.playerName || "P1", side: -1, color: game.player1.displayColor || "#7fc4ff" },
    { text: game.player2.playerName || "P2", side: 1, color: game.player2.displayColor || "#ffd27f" }
  ];
  for (const t of tags) {
    const w = ctx.measureText(t.text).width + 20;
    const x = t.side < 0 ? WIDTH / 2 - 10 - w : WIDTH / 2 + 10;
    ctx.fillStyle = "rgba(4, 18, 28, 0.7)";
    ctx.fillRect(x, 8, w, 26);
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, x + 10, 27);
  }
  ctx.restore();
}

// The corner map grows and shrinks with its - and + buttons (or keys). The
// largest step covers nearly half the screen.
const MAP_SMALL_W = 220;
const MAP_MEDIUM_W = 520;
const MAP_SCREEN_SHARE = 0.47;
const MAP_LARGEST_STEP = 2;
const MAP_BUTTONS = { x: WIDTH - 144, y: HEIGHT - 205, w: 64, h: 61, gap: 6 };
let mapStep = 0;

function resizeMiniMap(by) {
  mapStep = clamp(mapStep + by, 0, MAP_LARGEST_STEP);
}

function miniMapRect() {
  const aspect = WORLD_W / WORLD_H;
  if (mapStep === 0) {
    const h = Math.round(MAP_SMALL_W / aspect);
    return { x: WIDTH - MAP_SMALL_W - 10, y: HEIGHT - h - 10, w: MAP_SMALL_W, h };
  }
  const screen = canvas.getBoundingClientRect();
  const k = Math.min(screen.width / WIDTH, screen.height / HEIGHT);
  // Enlarged, it stops short of the touch buttons down the right-hand side.
  const side = document.querySelector(".tc-side").getBoundingClientRect();
  const right = side.width ? Math.min(WIDTH - 10, (side.left - screen.left - (screen.width - WIDTH * k) / 2) / k - 8) : WIDTH - 10;
  const target = mapStep === 1 ? MAP_MEDIUM_W : Math.sqrt(MAP_SCREEN_SHARE * screen.width * screen.height * aspect) / k;
  // It sits above the damage panels and below the status bar.
  const bottom = HEIGHT - 88;
  const w = Math.round(Math.min(target, (bottom - 66) * aspect, right - 10));
  const h = Math.round(w / aspect);
  return { x: right - w, y: bottom - h, w, h };
}

function drawMapButtons() {
  const { x, y, w, h, gap } = MAP_BUTTONS;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 42px Segoe UI";
  ctx.lineWidth = 1.5;
  [["−", -1], ["+", 1]].forEach(([label, by], i) => {
    const bx = x + i * (w + gap);
    const usable = by < 0 ? mapStep > 0 : mapStep < MAP_LARGEST_STEP;
    ctx.fillStyle = usable ? "rgba(10, 48, 70, 0.85)" : "rgba(40, 50, 58, 0.6)";
    ctx.fillRect(bx, y, w, h);
    ctx.strokeStyle = "rgba(217, 237, 247, 0.75)";
    ctx.strokeRect(bx, y, w, h);
    ctx.fillStyle = usable ? "#eef8fd" : "rgba(238, 248, 253, 0.35)";
    ctx.fillText(label, bx + w / 2, y + h / 2);
    registerUiRect(bx, y, w, h, () => resizeMiniMap(by));
  });
  ctx.restore();
}

// The dangers on the move, as they are right now: storm cells, a water spout,
// lava on the water and the tsunami's front. (Sea monsters and submarines are
// under water: they need Surface Radar, see drawCrewChart.)
function drawMapDangers(mmX, mmY, mmW, mmH) {
  const sx = mmW / WORLD_W;
  const sy = mmH / WORLD_H;
  ctx.save();
  ctx.beginPath();
  ctx.rect(mmX, mmY, mmW, mmH);
  ctx.clip();
  const circle = (o, r) => {
    ctx.beginPath();
    ctx.arc(mmX + o.x * sx, mmY + o.y * sy, r, 0, Math.PI * 2);
  };
  ctx.lineWidth = 1.5;
  ctx.fillStyle = "rgba(160, 170, 205, 0.45)";
  ctx.strokeStyle = "#cfd6f2";
  for (const dz of dynamicDangers) {
    if (dz.arriveIn > 0) continue; // still over the horizon
    circle(dz, Math.max(4, dz.r * sx));
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = "#ff8a1e";
  for (const pool of game.lavaPools) {
    circle(pool, Math.max(1.5, pool.size * sx));
    ctx.fill();
  }
  if (waterSpout.state !== "dormant") {
    ctx.strokeStyle = ctx.fillStyle = "#ffffff";
    circle(waterSpout, Math.max(5, waterSpout.r * sx));
    ctx.stroke();
    circle(waterSpout, 2);
    ctx.fill();
  }
  if (tsunami.state !== "dormant") {
    // the front lies across the way the wave travels (held at the edge until it comes on)
    const along = tsunami.dirX !== 0;
    const at = clamp(tsunami.front * (along ? tsunami.dirX : tsunami.dirY), 0, along ? WORLD_W : WORLD_H);
    ctx.strokeStyle = "#ff5a4d";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(mmX + (along ? at * sx : 0), mmY + (along ? 0 : at * sy));
    ctx.lineTo(mmX + (along ? at * sx : mmW), mmY + (along ? mmH : at * sy));
    ctx.stroke();
  }
  ctx.restore();
}

function drawMiniMap() {
  const { x: mmX, y: mmY, w: mmW, h: mmH } = miniMapRect();

  const sx = mmW / WORLD_W;
  const sy = mmH / WORLD_H;

  // Enlarged it is more solid, so the chart reads clearly over the view.
  ctx.fillStyle = mapStep ? "rgba(7, 24, 35, 0.8)" : "rgba(7, 24, 35, 0.54)";
  ctx.fillRect(mmX, mmY, mmW, mmH);
  ctx.strokeStyle = "rgba(217, 237, 247, 0.75)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(mmX, mmY, mmW, mmH);

  ctx.save();
  ctx.beginPath();
  ctx.rect(mmX, mmY, mmW, mmH);
  ctx.clip();
  if (game.missionState) ctx.drawImage(game.missionState.seenChart, mmX, mmY, mmW, mmH);
  const harbours = harbourBSighted() ? [HarbourA, HarbourB] : [HarbourA];
  for (const p of HARBOUR_LAND) {
    if (p.kind === "moored" || !harbours.includes(p.harbour)) continue;
    ctx.save();
    ctx.translate(mmX, mmY);
    ctx.scale(sx, sy);
    landPath(p);
    ctx.restore();
    ctx.fillStyle = p.kind === "coast" ? coastColor2d("#5f8a43") : "#8a8780";
    ctx.fill();
  }
  ctx.restore();
  for (const h of harbours) {
    ctx.beginPath();
    ctx.arc(mmX + h.x * sx, mmY + h.y * sy, Math.max(3, h.r * sx), 0, Math.PI * 2);
    ctx.fillStyle = h === HarbourA ? "#2f8f62" : "#3f6fb8";
    ctx.fill();
  }

  for (const s of game.iceSheets) {
    if (game.mission && !s.seen) continue;
    ctx.drawImage(s.canvas, mmX + (s.x - s.r) * sx, mmY + (s.y - s.r) * sy, s.r * 2 * sx, s.r * 2 * sy);
  }

  const MINIMAP_HAZARD_COLORS = { island: "#7db86a", volcano: "#d2573a", iceberg: "#d5f4ff" };
  for (const hz of hazards) {
    if (game.mission && !hz.seen) continue; // not sighted yet
    const x = mmX + hz.x * sx;
    const y = mmY + hz.y * sy;
    const r = Math.max(1.5, hz.r * sx);

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = MINIMAP_HAZARD_COLORS[hz.kind];
    ctx.fill();
    ctx.strokeStyle = "#223f17";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // An open whirlpool: its reach as a ring with a spiral inside.
  if (whirlpool.state !== "dormant") {
    const cx = mmX + whirlpool.x * sx;
    const cy = mmY + whirlpool.y * sy;
    const rr = Math.max(4, whirlpool.r * sx);
    ctx.save();
    ctx.globalAlpha *= clamp((WHIRLPOOL_LIFE - whirlpool.age) / WHIRLPOOL_FADE, 0, 1); // dies away with the pool
    ctx.strokeStyle = "#7fd8ff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    const turn = game.elapsed * 3 * whirlpool.spin;
    for (let k = 0; k <= 24; k++) {
      const a = turn + k * 0.5;
      const d = rr * (1 - k / 24);
      if (k === 0) ctx.moveTo(cx + Math.cos(a) * d, cy + Math.sin(a) * d);
      else ctx.lineTo(cx + Math.cos(a) * d, cy + Math.sin(a) * d);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawMapDangers(mmX, mmY, mmW, mmH);

  const drawDot = (entity, color) => {
    if (!entity || entity.capsized) return;
    ctx.beginPath();
    ctx.arc(mmX + entity.x * sx, mmY + entity.y * sy, (2.2 * mmW) / MAP_SMALL_W, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  };

  drawMissionMapMarks(mmX, mmY, sx, sy);
  drawCrewChart(mmX, mmY, sx, sy);
  drawDot(game.player1, game.player1 && game.player1.displayColor ? game.player1.displayColor : "#2f7ef7");
  drawDot(game.player2, game.player2 && game.player2.displayColor ? game.player2.displayColor : "#ffd56a");
  drawDot(game.ai, game.ai && game.ai.displayColor ? game.ai.displayColor : "#f0d034");
  for (const raider of game.pirateRaiders) {
    drawDot(raider, raider.displayColor || "#ffc941");
  }

  ctx.fillStyle = "#eef8fd";
  ctx.font = "12px Segoe UI";
  ctx.fillText("Map", mmX + 8, mmY + 15);
  drawMapButtons();
}

function drawHud() {
  ctx.fillStyle = "rgba(5, 17, 25, 0.45)";
  ctx.fillRect(8, 8, mode === "local" ? 496 : 370, 56);
  ctx.fillStyle = "#ecf5f9";
  ctx.font = "bold 17px Segoe UI";
  ctx.fillText(`${mode === "single" ? "Single" : "Local"}  ${game.mission ? "Mission" : "Free Play"}`, 16, 29);
  ctx.fillText(`Time ${game.elapsed.toFixed(0)}s`, 178, 29);
  ctx.fillText(`Wind ${game.wind.x.toFixed(0)},${game.wind.y.toFixed(0)}`, 278, 29);
  ctx.fillText(`P1 HP ${Math.ceil(game.player1 ? game.player1.hp : 0)} | Pts ${getProfile("p1").points}`, 16, 54);
  if (mode === "local" && game.player2) {
    ctx.fillText(`P2 HP ${Math.ceil(game.player2.hp)} | Pts ${getProfile("p2").points}`, 260, 54);
  }

  const drawRepairWidget = (ship, slot, x, y, tint) => {
    if (!ship) return;
    const profile = getProfile(slot);
    const damage = Math.max(0, ship.maxHull - ship.hp);
    const reserveLeft = Math.max(0, ship.repairReserve - ship.repairRecovered);
    const activePlan = ship.repairPlan;
    const progress = activePlan ? Math.round((ship.repairProgress / activePlan.target) * 100) : 0;

    ctx.fillStyle = "rgba(10, 38, 55, 0.66)";
    ctx.fillRect(x, y, 228, 44);
    ctx.strokeStyle = tint;
    ctx.strokeRect(x, y, 270, 72);
    ctx.fillStyle = "#e7f6ff";
    ctx.font = "bold 15px Segoe UI";
    ctx.fillText(`${slot.toUpperCase()} Dmg ${Math.round(damage)} | Res ${reserveLeft}`, x + 8, y + 21, 164);
    ctx.fillText(`${profile.points} pts`, x + 8, y + 43, 164);
    ctx.font = "15px Segoe UI";
    ctx.fillText(activePlan ? `${activePlan.label} ${progress}%` : ship.anchored ? `At anchor (${ANCHOR_KEY_NAMES[slot]} to sail)` : ship.ropes > 0 ? "Casting off lines..." : ship.readyAt !== undefined && game.elapsed - ship.readyAt < READY_SIGNAL_TIME ? "READY TO SAIL" : (ship.repairLast || "Ready"), x + 8, y + 64, 164);

    const canRepair = damage > 0 && reserveLeft > 0 && !ship.capsized;
    const btnX = x + 178;
    const btnY = y + 8;
    const btnW = 84;
    const btnH = 56;
    ctx.fillStyle = canRepair ? "rgba(34, 114, 78, 0.95)" : "rgba(67, 74, 82, 0.7)";
    ctx.fillRect(btnX, btnY, btnW, btnH);
    ctx.strokeStyle = canRepair ? "rgba(204, 255, 226, 0.5)" : "rgba(181, 192, 203, 0.3)";
    ctx.strokeRect(btnX, btnY, btnW, btnH);
    ctx.fillStyle = "#f4fffa";
    ctx.font = "bold 24px Segoe UI";
    ctx.fillText("Fix", btnX + 25, btnY + 37);

    if (canRepair) {
      registerUiRect(btnX, btnY, btnW, btnH, () => attemptRepairForSlot(slot));
    }

    // On fire: a red bar above the panel, with the put-out button if the
    // ship carries Fire Fighting Equipment.
    if (ship.fire && !ship.capsized) {
      const fy = y - 44;
      const flicker = 0.75 + 0.25 * Math.sin(performance.now() / 90);
      ctx.fillStyle = `rgba(150, 30, 12, ${0.85 * flicker})`;
      ctx.fillRect(x, fy, 270, 40);
      ctx.strokeStyle = "rgba(255, 190, 120, 0.8)";
      ctx.strokeRect(x, fy, 270, 40);
      ctx.fillStyle = "#fff1dc";
      ctx.font = "bold 16px Segoe UI";
      ctx.fillText("ON FIRE!", x + 8, fy + 26);
      if (ship.owned && ship.owned.fireFighting) {
        const key = keyName(game.settings.keybinds[slot + "Fire"]);
        const bx = x + 96;
        ctx.fillStyle = "rgba(30, 110, 170, 0.95)";
        ctx.fillRect(bx, fy + 3, 170, 34);
        ctx.strokeStyle = "rgba(200, 235, 255, 0.7)";
        ctx.strokeRect(bx, fy + 3, 170, 34);
        ctx.fillStyle = "#f4fbff";
        ctx.fillText(`Put out fire (${key})`, bx + 10, fy + 26, 154);
        registerUiRect(bx, fy + 3, 170, 34, () => extinguishFireForSlot(slot));
      } else {
        ctx.font = "14px Segoe UI";
        ctx.fillText("No fire kit (Dockyard)", x + 100, fy + 25, 164);
      }
    }
  };

  drawRepairWidget(game.player1, "p1", 8, HEIGHT - 80, "rgba(151, 214, 255, 0.5)");
  if (mode === "local" && game.player2) {
    // In split screen player 2's panel sits in player 2's (right) half.
    drawRepairWidget(game.player2, "p2", view3d.active && view3d.split ? WIDTH / 2 + 8 : 286, HEIGHT - 80, "rgba(255, 218, 161, 0.5)");
  }

  ctx.fillStyle = "#ffd182";
  ctx.font = "12px Segoe UI";
  if (!TOUCH_UI) {
    const k = (a) => keyName(game.settings.keybinds[a]);
    ctx.fillText(
      mode === "local"
        ? `${k("p1Repair")} ${k("p2Repair")}: fix   ${k("p1Anchor")} ${k("p2Anchor")}: anchor   ${k("p1SlideLeft")} ${k("p1SlideRight")} ${k("p2SlideLeft")} ${k("p2SlideRight")}: slide`
        : `${k("p1Repair")}: fix   ${k("p1Anchor")}: anchor   ${k("p1SlideLeft")} ${k("p1SlideRight")}: slide`,
      WIDTH - 150,
      HEIGHT - 16
    );
  }

  if (game.uiMessage) {
    ctx.fillStyle = "#e4f6ff";
    ctx.font = "bold 17px Segoe UI";
    const p2Half = game.uiMessageSlot === "p2" && view3d.active && view3d.split;
    const burning = humanShips().some((ship) => ship.fire && !ship.capsized);
    outlinedText(game.uiMessage, p2Half ? WIDTH / 2 + 14 : 14, HEIGHT - (burning ? 132 : 90));
  }
}

// Bridge view: an instrument strip with speed in knots and the compass
// heading, plus the gauges that kind of vessel would carry. Knots are scaled
// to each type's real-world top speed, so a sailing boat flat out shows about
// 8 kn and a hydrofoil about 42 kn.
const BRIDGE_TOP_KNOTS = { Cruise: 22, Cargo: 18, Sailing: 8, Catamaran: 14, Assault: 28, Carrier: 32, Futuristic: 48, Hydrofoil: 42, Tug: 13, Icebreaker: 17, Tanker: 15, GasTanker: 19.5, WarTanker: 11, Carrack: 9, Galley: 7 };
const WIND_SAILED = ["Sailing", "Catamaran", "Carrack"]; // their bridges show the wind and point of sail
const WIND_KNOTS_PER_UNIT = 0.6; // game wind (up to about 34 units) -> about 20 kn
const COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
// The 32 points of a traditional compass card, clockwise from north (the carrack steers by these).
const COMPASS_RHUMBS = ["N", "N BY E", "NNE", "NE BY N", "NE", "NE BY E", "ENE", "E BY N", "E", "E BY S", "ESE", "SE BY E", "SE", "SE BY S", "SSE", "S BY E",
  "S", "S BY W", "SSW", "SW BY S", "SW", "SW BY W", "WSW", "W BY S", "W", "W BY N", "WNW", "NW BY W", "NW", "NW BY N", "NNW", "N BY W"];

// Angle 0 points east on the map and angles turn clockwise; north is up.
function compassBearing(angle) {
  return (((angle * 180) / Math.PI + 90) % 360 + 360) % 360;
}

const BRIDGE_HULL_WARN = 0.35; // the bridge hull gauge turns red below this share of full health

function bridgeGauges(ship) {
  const kind = ship.category || "Cruise";
  const knots = (ship.speed / ship.maxSpeed) * (BRIDGE_TOP_KNOTS[kind] || 20);
  const bearing = compassBearing(ship.angle);
  const rudderNow = ship.helm ? ship.helm.rudder : 0;
  const rudderDeg = Math.round(Math.abs(rudderNow) * 35);
  const throttle = ship.throttle || 0;
  const gauges = [
    { label: "SPEED", unit: "kn", value: knots.toFixed(1) },
    { label: "HEADING", unit: "", value: `${String(Math.round(bearing) % 360).padStart(3, "0")}\u00b0 ${COMPASS_POINTS[Math.round(bearing / 45) % 8]}` }
  ];
  const rudder = { label: "RUDDER", unit: "", value: rudderDeg === 0 ? "MIDSHIPS" : `${rudderNow < 0 ? "PORT" : "STBD"} ${rudderDeg}` };
  const telegraph = { label: "TELEGRAPH", unit: "", value: throttle > 0 ? (throttle < 0.7 ? "HALF AHEAD" : "FULL AHEAD") : throttle < 0 ? "ASTERN" : "STOP" };

  // Wind relative to the bow: the side it comes from and how far round.
  const windFrom = Math.atan2(-game.wind.y, -game.wind.x);
  const rel = (normalizeAngle(windFrom - ship.angle) * 180) / Math.PI;
  const windKn = Math.hypot(game.wind.x, game.wind.y) * WIND_KNOTS_PER_UNIT;
  const side = Math.abs(rel) < 3 || Math.abs(rel) > 177 ? "" : rel < 0 ? " P" : " S";

  if (WIND_SAILED.includes(kind)) {
    const off = Math.abs(rel);
    const pointOfSail = off < 40 ? "IN IRONS" : off < 65 ? "CLOSE-HAULED" : off < 110 ? "BEAM REACH" : off < 155 ? "BROAD REACH" : "RUNNING";
    gauges.push({ label: "WIND", unit: "kn", value: `${Math.round(off)}\u00b0${side} ${windKn.toFixed(0)}` });
    gauges.push({ label: "POINT OF SAIL", unit: "", value: kind === "Carrack" && off < CARRACK_CLOSEST ? "ABACK" : pointOfSail });
    if (kind === "Carrack") {
      const sails = carrackWind(ship);
      gauges.push({ label: "SAILS", unit: "%", value: String(Math.round(sails.power * 100)), bar: sails.power, warn: sails.light || sails.aback });
      // a 16th-century ship: the course by compass point (no degrees), and the whipstaff for a helm
      gauges[1] = { label: "COMPASS", unit: "", value: COMPASS_RHUMBS[Math.round(bearing / 11.25) % 32] };
      gauges.push({ label: "WHIPSTAFF", unit: "", value: rudderDeg === 0 ? "AMIDSHIPS" : rudderNow < 0 ? "TO PORT" : "TO STBD" });
    }
  } else if (kind === "Hydrofoil") {
    const lift = ship.foilLift || 0;
    gauges.push({ label: "FOILS", unit: "", value: lift >= 1 ? "FOILBORNE" : lift > 0 ? `RISING ${Math.round(lift * 100)}%` : "HULLBORNE" });
    gauges.push({ label: "THROTTLE", unit: "", value: `${Math.round(Math.max(0, throttle) * 100)}%`, bar: Math.max(0, throttle) });
  } else if (kind === "Icebreaker") {
    gauges.push(telegraph);
    gauges.push({ label: "ICE", unit: "", value: ship.ice === "solid" ? "BREAKING" : ship.ice === "channel" ? "IN CHANNEL" : "OPEN WATER" });
  } else if (TANKERS[kind]) {
    gauges.push(telegraph);
    const hose = pumpHose(ship);
    gauges.push({ label: TANKERS[kind] === "oil" ? "OIL PUMP" : "GAS PUMP", unit: "", value: hose ? "CONNECTED" : "AT SEA" });
    if (kind === "WarTanker") gauges.push({ label: "DECK GUNS", unit: "", value: ship.reload > 0 ? `LOADING ${ship.reload.toFixed(1)}s` : "READY" });
  } else if (TOWING_SHIPS.includes(kind)) {
    if (kind === "Galley") gauges[1] = { label: "COMPASS", unit: "", value: COMPASS_RHUMBS[Math.round(bearing / 11.25) % 32] };
    gauges.push(kind === "Tug" ? telegraph : { label: "OARS", unit: "", value: throttle > 0 ? "PULL AHEAD" : throttle < 0 ? "BACK WATER" : "AT REST" });
    gauges.push({ label: "TOW", unit: "", value: ship.tow ? (ship.towTaut ? "TAUT" : "SLACK") : `NONE (${TOW_KEY_NAMES[ship.playerSlot]})` });
  } else if (kind === "Futuristic") {
    gauges.push({ label: "THRUST", unit: "", value: `${Math.round(throttle * 100)}%`, bar: Math.abs(throttle) });
    gauges.push({ label: "VECTOR", unit: "", value: rudderDeg === 0 ? "LOCKED" : rudderNow < 0 ? `<< ${rudderDeg}` : `${rudderDeg} >>` });
  } else if (kind === "Assault") {
    gauges.push(rudder);
    gauges.push({ label: WEAPON_NAMES[shipWeapon(ship)], unit: "", value: ship.reload > 0 ? `LOADING ${ship.reload.toFixed(1)}s` : "READY" });
  } else if (kind === "Carrier") {
    // Wind over the deck: the headwind the flight deck feels (ship speed + wind from ahead).
    const overDeck = Math.max(0, knots + windKn * Math.cos((rel * Math.PI) / 180));
    gauges.push(telegraph);
    gauges.push({ label: "WIND OVER DECK", unit: "kn", value: overDeck.toFixed(0) });
  } else {
    gauges.push(telegraph);
    gauges.push(rudder);
  }
  // Wind speed and where it comes from, with a trend of the last minute and a half, on every bridge (ships under
  // sail carry it in their own wind gauge).
  const trend = game.windLog || [];
  const windGauge = WIND_SAILED.includes(kind) ?gauges.find((g) => g.label === "WIND") : null;
  if (windGauge) windGauge.trend = trend;
  else gauges.push({ label: "WIND", unit: "kn", value: `${windKn.toFixed(0)} ${COMPASS_POINTS[Math.round(compassBearing(windFrom) / 45) % 8]}`, trend, warn: windKn > 28 });
  // Hull health, last on every bridge; red once it falls below the threshold.
  const hullShare = clamp(ship.hp / ship.maxHull, 0, 1);
  gauges.push({ label: "HULL", unit: "HP", value: String(Math.ceil(ship.hp)), bar: hullShare, warn: hullShare < BRIDGE_HULL_WARN });
  return gauges;
}

// The ship the full-screen view follows: player 1, or player 2 once player 1
// is out in a 2-player game.
function soloViewShip() {
  const p2 = mode === "local" ? game.player2 : null;
  return p2 && game.player1 && game.player1.capsized && !p2.capsized ? p2 : game.player1;
}

function drawBridgeInstruments() {
  if (!view3d.active || game.settings.cameraView !== "bridge") return;
  const split = view3d.split;
  const ships = split ? [game.player1, game.player2] : [soloViewShip()];
  const futuristic = (ship) => ship.category === "Futuristic";
  const h = 54;
  ships.forEach((ship, i) => {
    if (!ship || ship.capsized) return;
    const gauges = bridgeGauges(ship);
    // A long strip (the carrack's) narrows its cells to stay within that player's half
    // (in one view: right of the status box in the top left corner).
    const cellW = Math.min(118, Math.floor((split ? WIDTH / 2 - 8 : WIDTH - 400) / gauges.length));
    const w = cellW * gauges.length;
    const x = split ? (i === 0 ? WIDTH / 4 : (WIDTH * 3) / 4) - w / 2 : Math.max((WIDTH - w) / 2, 386);
    const cx = x + w / 2;
    const y = split ? 70 : 8; // in split screen, under the top-left status bar
    const accent = futuristic(ship) ? "#7ff3ff" : "#ecf5f9";
    ctx.fillStyle = futuristic(ship) ? "rgba(18, 8, 40, 0.8)" : "rgba(14, 18, 24, 0.8)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = futuristic(ship) ? "rgba(127, 243, 255, 0.6)" : "rgba(220, 235, 245, 0.25)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    // the navigation-screen button: glide to the window view and back into the bridge
    const slot = ship === game.player2 ? "p2" : "p1";
    const bw = 240;
    const bx = cx - bw / 2;
    const by = y + h + 6;
    ctx.fillStyle = "rgba(14, 18, 24, 0.8)";
    ctx.fillRect(bx, by, bw, 46);
    ctx.strokeStyle = "rgba(220, 235, 245, 0.35)";
    ctx.strokeRect(bx, by, bw, 46);
    ctx.fillStyle = "#ecf5f9";
    ctx.font = "bold 17px Segoe UI";
    ctx.textAlign = "center";
    const bk = keyName(game.settings.keybinds[slot + "Bridge"]);
    ctx.fillText(bridgeFocus[slot] ? `Inside bridge (${bk})` : `Bridge camera (${bk})`, cx, by + 29);
    ctx.textAlign = "left";
    registerUiRect(bx, by, bw, 46, () => toggleBridgeFocus(slot));
    gauges.forEach((g, k) => {
      const gx = x + k * cellW;
      if (k > 0) {
        ctx.fillStyle = "rgba(220, 235, 245, 0.15)";
        ctx.fillRect(gx, y + 8, 1, h - 16);
      }
      ctx.fillStyle = "rgba(220, 235, 245, 0.7)";
      ctx.font = "bold 10px Segoe UI";
      ctx.fillText(g.label, gx + 10, y + 16);
      if (g.unit) {
        ctx.textAlign = "right";
        ctx.fillText(g.unit, gx + cellW - 10, y + 16);
        ctx.textAlign = "left";
      }
      ctx.fillStyle = g.warn ? "#ff5a4d" : accent;
      ctx.font = g.value.length > 9 ? "bold 13px Consolas, monospace" : "bold 18px Consolas, monospace";
      ctx.fillText(g.value, gx + 10, y + 39);
      if (g.trend && g.trend.length > 1) {
        // the logged wind speed over the last minute and a half
        const top = Math.max(20, ...g.trend);
        ctx.strokeStyle = g.warn ? "#ff5a4d" : "rgba(160, 220, 255, 0.85)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        g.trend.forEach((v, n) => {
          const px = gx + 10 + ((cellW - 20) * n) / Math.max(1, 89);
          const py = y + h - 5 - (v / top) * 12;
          if (n === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      }
      if (g.bar !== undefined) {
        ctx.fillStyle = "rgba(220, 235, 245, 0.2)";
        ctx.fillRect(gx + 10, y + h - 9, cellW - 20, 3);
        ctx.fillStyle = g.warn ? "#ff5a4d" : accent;
        ctx.fillRect(gx + 10, y + h - 9, (cellW - 20) * g.bar, 3);
      }
    });
  });
}

// Closes the Android app (HarbourRunNative is added by MainActivity); the web version has no such button.
function exitApp() {
  if (window.HarbourRunNative) window.HarbourRunNative.exit();
}

// The main menu's buttons: "Set Sail" in the middle (always first, so Enter
// sets sail), then the plates along the top.
const MENU_BAR = { y: 62, w: 186, h: 116, gap: 10 };
const MENU_SAIL = { w: 460, h: 104, y: 462 };

function getMenuButtons() {
  const bar = [
    { label: "Two Captains", icon: "captains", action: () => { mode = "local"; openVoyageChoice(); } },
    { label: "Dockyard", icon: "crane", action: () => openShop("p1") },
    { label: "Ship Crew", icon: "cap", action: () => openCrewScreen("p1") },
    { label: "Leaderboard", icon: "trophy", action: () => { gameState = "leaderboard"; } },
    { label: "Settings", icon: "wheel", action: () => { gameState = "settings"; } },
    ...(IS_ANDROID_APP ? [{ label: "Exit", icon: "exit", action: exitApp }] : [])
  ];
  const left = (WIDTH - bar.length * (MENU_BAR.w + MENU_BAR.gap) + MENU_BAR.gap) / 2;
  return [
    {
      label: "Set Sail", sub: "Free play or mission", icon: "ship", primary: true,
      x: (WIDTH - MENU_SAIL.w) / 2, y: MENU_SAIL.y, w: MENU_SAIL.w, h: MENU_SAIL.h,
      action: () => { mode = "single"; openVoyageChoice(); }
    },
    ...bar.map((b, i) => ({ ...b, x: left + i * (MENU_BAR.w + MENU_BAR.gap), y: MENU_BAR.y, w: MENU_BAR.w, h: MENU_BAR.h }))
  ];
}

function moveMenuSelection(step) {
  game.menuIndex = clamp(game.menuIndex + step, 0, getMenuButtons().length - 1);
}

// The main menu over the harbour: the name and the top bar, and along the
// bottom the ship in harbour and both captains.
function drawMenu() {
  ctx.save();
  ctx.textAlign = "center";
  const glow = ctx.createLinearGradient(490, 0, 710, 0);
  glow.addColorStop(0, "#6ce5d9");
  glow.addColorStop(1, "#f9c15f");
  ctx.font = "bold 40px Segoe UI";
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0, 12, 22, 0.75)";
  ctx.strokeText("Harbour Run", WIDTH / 2, 46);
  ctx.fillStyle = glow;
  ctx.fillText("Harbour Run", WIDTH / 2, 46);

  getMenuButtons().forEach((button, i) => {
    drawNavalButton({
      ...button,
      focused: i === game.menuIndex,
      onClick: () => {
        game.menuIndex = i;
        button.action();
      }
    });
  });
  ctx.textAlign = "center";

  ctx.fillStyle = "#f4fbff";
  ctx.font = "bold 22px Segoe UI";
  if (game.harbourShip) outlinedText(`${game.harbourShip.shipName} in ${HarbourA.name}`, WIDTH / 2, HEIGHT - 104);
  ctx.font = "18px Segoe UI";
  const p1 = getProfile("p1");
  const p2 = getProfile("p2");
  ctx.textAlign = "left";
  ctx.fillStyle = "#9ed7ff";
  outlinedText(`P1 ${p1.name}: ${p1.points} pts | Spent ${p1.shopSpent} | Earned ${p1.shopEarned}`, 24, HEIGHT - 64);
  ctx.textAlign = "right";
  ctx.fillStyle = "#ffd889";
  outlinedText(`P2 ${p2.name}: ${p2.points} pts | Spent ${p2.shopSpent} | Earned ${p2.shopEarned}`, WIDTH - 24, HEIGHT - 64);

  ctx.textAlign = "center";
  ctx.font = "17px Segoe UI";
  if (onMenuShip()) {
    ctx.fillStyle = "#bfe6f5";
    outlinedText(TOUCH_UI ? "Drag to turn the view, pinch to zoom" : "Drag to turn the view, mouse wheel to zoom", WIDTH / 2, HEIGHT - 84);
  }
  if (!TOUCH_UI) {
    ctx.fillStyle = "#d8e9f2";
    outlinedText(
      `Arrows: Choose   Enter: Select   1: Set Sail   2: Two Captains   O: Dockyard   M: Ship Crew   K: Settings   N: Rename player${devPremiumTestAllowed() ? "   P: [DEV] Premium test" : ""}`,
      WIDTH / 2,
      HEIGHT - 36
    );
  }
  if (game.audioContext?.state !== "running" && soundLevel().volume > 0) {
    ctx.fillStyle = `rgba(191, 233, 255, ${0.55 + 0.35 * Math.sin(performance.now() / 400)})`;
    outlinedText("Press any key or click to start the music", WIDTH / 2, HEIGHT - 10);
  }
  ctx.restore();
}

// The shop is a dockyard (3D scene in render3d.js): the player's ship sails
// into a dry dock, the gate shuts and the dock is pumped dry. Then the
// upgrades and ships appear as icons; choosing another ship floods the dock
// and swaps the ship. This file draws the icons and text over the scene.
const DOCK_CLIP_TIME = 9; // seconds of sailing-in clip before the icons appear (= arrive + gate + drain in render3d.js)

function openShop(slot) {
  switchShopSlot(slot);
  // waited / drawn / ready: render3d.js builds the dock behind a "please wait"
  // splash and says when it is on screen.
  game.dock = { start: performance.now() / 1000, hideUi: false, waited: 0, drawn: 0, ready: false };
  gameState = "shop";
}

// On the way to the dockyard: the 3D dock isn't on screen yet.
function dockLoading() {
  return view3d.active && gameState === "shop" && !game.dock.ready;
}

function dockClock() {
  return performance.now() / 1000 - game.dock.start;
}

function dockClipPlaying() {
  return dockClock() < DOCK_CLIP_TIME;
}

function skipDockClip() {
  game.dock.start = performance.now() / 1000 - DOCK_CLIP_TIME;
}

// Up / Down jump between the upgrade row and the ship row.
function moveShopSelection(key) {
  const entries = getShopEntries();
  const gadgets = entries.filter((e) => e.kind === "gadget").length;
  const i = game.shopIndex;
  if (key === "ArrowLeft") game.shopIndex = (i + entries.length - 1) % entries.length;
  else if (key === "ArrowRight") game.shopIndex = (i + 1) % entries.length;
  else if (key === "ArrowDown" && i < gadgets) game.shopIndex = Math.min(gadgets + i, entries.length - 1);
  else if (key === "ArrowUp" && i >= gadgets) game.shopIndex = Math.min(i - gadgets, gadgets - 1);
}

function fitText(text, maxW) {
  let s = text;
  while (s.length > 1 && ctx.measureText(s).width > maxW) s = s.slice(0, -1);
  return s === text ? s : `${s.trimEnd()}.`;
}

function drawDockTile(item, x, y, w, h, index, profile, alpha) {
  const owned = item.kind === "ship" ? isShipOwned(profile, item) : !!profile.owned[item.id];
  const inDock = item.kind === "ship" && profile.selectedShip === item.id;
  const selected = index === game.shopIndex;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = selected ? "rgba(91, 145, 177, 0.7)" : "rgba(14, 40, 58, 0.88)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = selected ? "#ffd182" : inDock ? "#89d98b" : "rgba(166, 218, 244, 0.3)";
  ctx.lineWidth = selected ? 3 : 1.5;
  ctx.strokeRect(x, y, w, h);
  drawCatalogIcon(item, x + w / 2, y + 23, 34, item.kind === "ship");
  ctx.textAlign = "center";
  ctx.font = "13px Segoe UI";
  ctx.fillStyle = "#f4fbff";
  // the name on two lines, so it can be read whole
  const words = item.name.split(" ");
  const lines = [words[0], words.slice(1).join(" ")];
  lines.forEach((line, i) => ctx.fillText(line, x + w / 2, y + 52 + i * 14, w - 4));
  ctx.font = "bold 14px Segoe UI";
  const blocked = item.premiumPack && !game.entitlements[item.premiumPack];
  ctx.fillStyle = owned ? "#89d98b" : blocked ? "#d0a1a1" : "#ffd182";
  ctx.fillText(inDock ? "In dock" : owned ? (item.kind === "ship" ? "Owned" : "Fitted") : item.premiumPack ? "premium" : `${item.cost}`, x + w / 2, y + h - 7);
  ctx.restore();
  registerUiRect(x, y, w, h, () => { game.shopIndex = index; });
}

// A button plate: rounded, with a sheen, a rim and an inner line like inlaid
// brass. A focused plate gets a bright gold rim and a glow.
function drawPlate(x, y, w, h, fill, edge, focused = false) {
  const radius = Math.min(12, h / 4);
  ctx.save();
  ctx.shadowColor = focused ? "rgba(255, 200, 90, 0.85)" : "rgba(0, 8, 16, 0.6)";
  ctx.shadowBlur = focused ? 18 : 8;
  ctx.shadowOffsetY = focused ? 0 : 3;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowColor = "transparent";
  const sheen = ctx.createLinearGradient(0, y, 0, y + h);
  sheen.addColorStop(0, "rgba(255, 255, 255, 0.2)");
  sheen.addColorStop(0.45, "rgba(255, 255, 255, 0.04)");
  sheen.addColorStop(1, "rgba(0, 0, 0, 0.3)");
  ctx.fillStyle = sheen;
  ctx.fill();
  ctx.strokeStyle = focused ? "#ffd682" : edge;
  ctx.lineWidth = focused ? 3 : 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(x + 4, y + 4, w - 8, h - 8, radius - 3);
  ctx.strokeStyle = "rgba(255, 224, 160, 0.28)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

// The buttons' nautical pictures, drawn in a 100 x 100 box centred on (0, 0).
const BUTTON_ICONS = {
  // a ship under sail
  ship(c) {
    c.fillRect(-3, -44, 5, 66);
    iconShape(c, [[7, -40], [38, 10], [7, 10]]);
    iconShape(c, [[-8, -30], [-34, 10], [-8, 10]]);
    iconShape(c, [[2, -46], [22, -40], [2, -34]]);
    iconShape(c, [[-44, 17], [44, 17], [28, 34], [-30, 34]]);
    iconWave(c, 43);
  },
  // two captains
  captains(c) {
    for (const [x, y, s] of [[20, -8, 0.82], [-16, 8, 1]]) {
      c.save();
      c.translate(x, y);
      c.scale(s, s);
      c.beginPath();
      c.arc(0, -6, 14, 0, Math.PI * 2);
      c.fill();
      c.beginPath();
      c.ellipse(0, 38, 28, 24, 0, Math.PI, Math.PI * 2);
      c.fill();
      iconShape(c, [[-20, -24], [-16, -38], [16, -38], [20, -24]]);
      c.fillRect(-17, -22, 34, 5);
      c.restore();
    }
  },
  // the dockyard's gantry crane, lifting a crate
  crane(c) {
    c.fillRect(-42, -38, 84, 10);
    iconShape(c, [[-34, -30], [-24, -30], [-30, 40], [-42, 40]]);
    iconShape(c, [[24, -30], [34, -30], [42, 40], [30, 40]]);
    c.fillRect(-2, -28, 4, 30);
    c.fillRect(-15, 2, 30, 24);
    c.fillRect(-46, 40, 92, 6);
  },
  // a captain's peaked cap
  cap(c) {
    c.beginPath();
    c.moveTo(-44, -12);
    c.quadraticCurveTo(0, -52, 44, -12);
    c.lineTo(30, 8);
    c.lineTo(-30, 8);
    c.closePath();
    c.fill();
    c.fillRect(-30, 12, 60, 12);
    c.beginPath();
    c.moveTo(-34, 28);
    c.quadraticCurveTo(0, 54, 34, 28);
    c.closePath();
    c.fill();
    c.save();
    c.fillStyle = "#14354a";
    c.beginPath();
    c.arc(0, -10, 8, 0, Math.PI * 2);
    c.fill();
    c.restore();
  },
  trophy(c) {
    c.beginPath();
    c.moveTo(-26, -40);
    c.lineTo(26, -40);
    c.quadraticCurveTo(24, 6, 0, 10);
    c.quadraticCurveTo(-24, 6, -26, -40);
    c.fill();
    for (const side of [-1, 1]) {
      c.beginPath();
      c.arc(side * 27, -24, 13, 0, Math.PI * 2);
      c.stroke();
    }
    c.fillRect(-5, 8, 10, 20);
    iconShape(c, [[-16, 26], [16, 26], [22, 42], [-22, 42]]);
  },
  // a ship's steering wheel
  wheel(c) {
    c.beginPath();
    c.arc(0, 0, 28, 0, Math.PI * 2);
    c.stroke();
    for (let i = 0; i < 8; i += 1) {
      const a = (i * Math.PI) / 4;
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(Math.cos(a) * 42, Math.sin(a) * 42);
      c.stroke();
      c.beginPath();
      c.arc(Math.cos(a) * 43, Math.sin(a) * 43, 6, 0, Math.PI * 2);
      c.fill();
    }
    c.beginPath();
    c.arc(0, 0, 10, 0, Math.PI * 2);
    c.fill();
  },
  // a lifebuoy: back to the harbour
  buoy(c) {
    c.save();
    c.lineWidth = 18;
    c.beginPath();
    c.arc(0, 0, 30, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = "#c4473a";
    for (let i = 0; i < 4; i += 1) {
      c.beginPath();
      c.arc(0, 0, 30, (i * Math.PI) / 2 + 0.5, (i * Math.PI) / 2 + 1.07);
      c.stroke();
    }
    c.restore();
  },
  exit(c) {
    c.strokeRect(-34, -40, 40, 80);
    c.fillRect(-10, -5, 34, 10);
    iconShape(c, [[20, -20], [44, 0], [20, 20]]);
  },
  back(c) {
    iconShape(c, [[-44, 0], [-8, -32], [-8, 32]]);
    c.fillRect(-12, -11, 54, 22);
  }
};

function iconShape(c, points) {
  c.beginPath();
  points.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.closePath();
  c.fill();
}

function iconWave(c, y) {
  c.beginPath();
  c.moveTo(-46, y);
  for (let x = -46; x < 46; x += 23) c.quadraticCurveTo(x + 11.5, y + 9, x + 23, y);
  c.stroke();
}

function drawButtonIcon(name, cx, cy, size, color) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(size / 100, size / 100);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  BUTTON_ICONS[name](ctx);
  ctx.restore();
}

// A big menu button: the picture over the name, or (primary) the brass "go"
// button with its picture in a medallion beside the name.
function drawNavalButton({ x, y, w, h, label, sub, icon, primary, focused, onClick }) {
  ctx.save();
  ctx.textAlign = "center";
  if (primary) {
    const brass = ctx.createLinearGradient(0, y, 0, y + h);
    brass.addColorStop(0, "#ffe09a");
    brass.addColorStop(0.55, "#e6a93f");
    brass.addColorStop(1, "#a86a22");
    drawPlate(x, y, w, h, brass, "#6e4413", focused);
    const r = h / 2 - 10;
    const cx = x + r + 16;
    ctx.beginPath();
    ctx.arc(cx, y + h / 2, r, 0, Math.PI * 2);
    ctx.fillStyle = "#0d3047";
    ctx.fill();
    ctx.strokeStyle = "#fff0c4";
    ctx.lineWidth = 2;
    ctx.stroke();
    drawButtonIcon(icon, cx, y + h / 2, r * 1.5, "#ffe7ae");
    const middle = (cx + r + x + w) / 2;
    const room = x + w - cx - r - 24;
    const size = Math.round(Math.min(40, h * 0.38));
    ctx.fillStyle = "#102534";
    ctx.font = `bold ${size}px Segoe UI`;
    ctx.fillText(label.toUpperCase(), middle, y + (sub ? h / 2 + 4 : h / 2 + size * 0.36), room);
    if (sub) {
      ctx.font = "bold 19px Segoe UI";
      ctx.fillText(sub, middle, y + h / 2 + 32, room);
    }
  } else {
    drawPlate(x, y, w, h, focused ? "rgba(38, 98, 120, 0.95)" : "rgba(9, 35, 52, 0.86)", "rgba(214, 170, 92, 0.75)", focused);
    drawButtonIcon(icon, x + w / 2, y + h / 2 - 16, 56, focused ? "#ffe7ae" : "#e8c274");
    ctx.fillStyle = "#f2f8fb";
    ctx.font = "bold 22px Segoe UI";
    ctx.fillText(label, x + w / 2, y + h - 16, w - 10);
  }
  ctx.restore();
  registerUiRect(x, y, w, h, onClick);
}

// A button on the other screens: its text sized to its height; `icon` is optional.
function drawDockButton(label, x, y, w, h, fill, edge, text, onClick, icon) {
  drawPlate(x, y, w, h, fill, edge);
  ctx.save();
  ctx.textAlign = "left";
  const font = clamp(Math.round(h * 0.38), 17, 28);
  ctx.font = `bold ${font}px Segoe UI`;
  const size = icon ? Math.min(40, Math.round(h * 0.55)) : 0;
  const gap = icon ? 10 : 0;
  const textW = Math.min(ctx.measureText(label).width, w - size - gap - 18);
  const left = x + (w - size - gap - textW) / 2;
  if (icon) drawButtonIcon(icon, left + size / 2, y + h / 2, size, text);
  ctx.fillStyle = text;
  ctx.fillText(label, left + size + gap, y + h / 2 + font * 0.35, textW);
  ctx.restore();
  registerUiRect(x, y, w, h, onClick);
}

// Text straight over the 3D scene: a dark outline keeps it readable on a bright sky.
function outlinedText(text, x, y) {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(0, 12, 22, 0.75)";
  ctx.strokeText(text, x, y);
  ctx.restore();
  ctx.fillText(text, x, y);
}

function drawShopScreen() {
  const entries = getShopEntries();
  const profile = getProfile(game.shopSlot);
  const t = dockClock();
  const ready = t >= DOCK_CLIP_TIME;
  const iconAlpha = Math.min(1, Math.max(0, (t - DOCK_CLIP_TIME + 0.6) / 0.6));
  const shipName = getShipDefinition(profile.selectedShip).name;

  // header over the scene
  // While the ship sails in, the scene is left as it is (no dark band): the
  // text just gets a shadow to stay readable.
  const clip = t < DOCK_CLIP_TIME;
  if (clip) {
    ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
    ctx.shadowBlur = 7;
  } else {
    const top = ctx.createLinearGradient(0, 0, 0, 84);
    top.addColorStop(0, "rgba(3, 10, 16, 0.5)");
    top.addColorStop(1, "rgba(3, 10, 16, 0)");
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, WIDTH, 84);
  }
  ctx.textAlign = "left";
  ctx.fillStyle = "#f4fbff";
  ctx.font = "bold 32px Segoe UI";
  const titleX = TOUCH_UI ? 150 : 30; // clear of the touch Back button
  outlinedText(game.dock.arsenal ? "The Order's Arsenal" : "Harbour Dockyard", titleX, 42);
  ctx.font = "17px Segoe UI";
  ctx.fillStyle = "#cfe6f2";
  const careened = getShipDefinition(profile.selectedShip).category === "Carrack"; // not dry-docked (render3d.js)
  outlinedText(
    t < DOCK_CLIP_TIME ? `${shipName} is sailing to the ${careened ? "arsenal" : "dockyard"}...` : `${shipName} ${careened ? "careened at the arsenal quay" : "in the dry dock"}`,
    titleX + 2, 70);
  ctx.textAlign = "right";
  ctx.font = "18px Segoe UI";
  ctx.fillStyle = game.shopSlot === "p1" ? "#bfe8ff" : "#ffe3c0";
  outlinedText(`${profile.name} (${game.shopSlot.toUpperCase()})  -  ${profile.points} points`, WIDTH - 30, 40);
  ctx.textAlign = "left";
  ctx.shadowBlur = 0;

  if (!ready) {
    ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
    ctx.shadowBlur = 7;
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffd182";
    ctx.font = "16px Segoe UI";
    outlinedText("Press any key or tap to skip the clip   Esc: Back", WIDTH / 2, HEIGHT - 24);
    ctx.textAlign = "left";
    ctx.shadowBlur = 0;
    registerUiRect(0, 0, WIDTH, HEIGHT, () => skipDockClip());
    return;
  }

  const panelButton = (label, hide) => drawDockButton(label, WIDTH - 250, 56, 234, 60, "rgba(14, 40, 58, 0.9)", "rgba(166, 218, 244, 0.5)", "#e8f6ff", () => { game.dock.hideUi = hide; });
  if (game.dock.hideUi) {
    panelButton(`Show panel${TOUCH_UI ? "" : " (V)"}`, false);
    return;
  }
  panelButton(`Hide panel${TOUCH_UI ? "" : " (V)"}`, true);

  // icon panel along the bottom
  const y0 = 350;
  const panel = ctx.createLinearGradient(0, y0, 0, HEIGHT);
  panel.addColorStop(0, "rgba(4, 12, 20, 0.62)");
  panel.addColorStop(0.2, "rgba(4, 12, 20, 0.86)");
  panel.addColorStop(1, "rgba(4, 12, 20, 0.92)");
  ctx.fillStyle = panel;
  ctx.fillRect(0, y0, WIDTH, HEIGHT - y0);
  ctx.strokeStyle = "rgba(215, 237, 249, 0.5)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, y0);
  ctx.lineTo(WIDTH, y0);
  ctx.stroke();
  const gadgetCount = entries.filter((e) => e.kind === "gadget").length;
  const shipCount = entries.length - gadgetCount;
  const gadgetW = Math.min(96, Math.floor((WIDTH - 24) / gadgetCount) - 4);
  const gadgetX = Math.round((WIDTH - gadgetCount * (gadgetW + 4) + 4) / 2);
  const shipW = Math.min(96, Math.floor((WIDTH - 24) / shipCount) - 4); // the whole fleet in one row
  const shipX = Math.round((WIDTH - shipCount * (shipW + 4) + 4) / 2);
  ctx.save();
  ctx.globalAlpha = iconAlpha;
  ctx.fillStyle = "#9ed7ff";
  ctx.font = "bold 17px Segoe UI";
  ctx.fillText("Upgrades", gadgetX, y0 + 22);
  ctx.fillText("Ships", shipX, y0 + 138);
  ctx.restore();
  entries.forEach((item, i) => {
    const shipRow = item.kind === "ship";
    const col = shipRow ? i - gadgetCount : i;
    const w = shipRow ? shipW : gadgetW;
    drawDockTile(item, (shipRow ? shipX : gadgetX) + col * (w + 4), y0 + (shipRow ? 146 : 30), w, 90, i, profile, iconAlpha);
  });

  const selected = entries[game.shopIndex];
  const selectedOwned = selected.kind === "ship" ? isShipOwned(profile, selected) : !!profile.owned[selected.id];
  const barY = y0 + 244;
  ctx.fillStyle = "rgba(12, 39, 55, 0.92)";
  ctx.fillRect(12, barY, WIDTH - 24, 82);
  ctx.strokeStyle = "rgba(166, 218, 244, 0.35)";
  ctx.lineWidth = 1;
  ctx.strokeRect(12, barY, WIDTH - 24, 82);
  ctx.fillStyle = "#e8f6ff";
  ctx.font = "bold 20px Segoe UI";
  ctx.fillText(`${selected.name}  |  ${selectedOwned ? "Owned" : "Not owned"}  |  Price: ${selected.premiumPack ? "Premium" : selected.cost}`, 28, barY + 30, 770);
  ctx.fillStyle = "#c9dfea";
  ctx.font = "17px Segoe UI";
  ctx.fillText(game.uiMessage || fitText(selected.desc || "", 760), 28, barY + 60, 770);
  drawDockButton(selected.kind === "ship" && selectedOwned ? "Equip" : selected.premiumPack ? "Buy pack" : "Buy", 820, barY + 6, 174, 70, "rgba(27, 98, 72, 0.92)", "rgba(196, 255, 224, 0.45)", "#e7fff4", () => buySelectedItem());
  drawDockButton("Sell", 1004, barY + 6, 174, 70, "rgba(91, 73, 31, 0.92)", "rgba(255, 229, 177, 0.45)", "#fff3de", () => sellSelectedItem());

  if (!TOUCH_UI) {
    ctx.fillStyle = "#ffd182";
    ctx.font = "15px Segoe UI";
    ctx.fillText("Arrows: Select  Enter: Buy / Equip  Backspace: Sell  Tab: Switch Player  V: Hide panel  N: Rename  Esc: Back", 28, HEIGHT - 7);
  }
}

function drawPremiumScreen() {
  const pack = game.premiumPackId;
  const info = PREMIUM_PACKS[pack];
  const owned = game.entitlements[pack];
  const panelX = 160;
  const panelY = 70;
  const panelW = WIDTH - 320;
  const panelH = HEIGHT - 140;

  ctx.fillStyle = "rgba(2, 12, 18, 0.7)";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = "rgba(14, 10, 30, 0.95)";
  ctx.fillRect(panelX, panelY, panelW, panelH);
  ctx.strokeStyle = "#b68cff";
  ctx.lineWidth = 2;
  ctx.strokeRect(panelX, panelY, panelW, panelH);

  ctx.fillStyle = "#d9c2ff";
  ctx.font = "16px Segoe UI";
  ctx.fillText("PREMIUM PACK", panelX + 30, panelY + 36);
  ctx.fillStyle = "#f4ecff";
  ctx.font = "bold 32px Segoe UI";
  ctx.fillText(info.name, panelX + 30, panelY + 76);

  ctx.font = "18px Segoe UI";
  ctx.fillStyle = "#cdbdf0";
  ctx.fillText("Includes:", panelX + 30, panelY + 116);
  const contents = [
    ...SHIP_CATALOG.filter((sh) => sh.premiumPack === pack).map((sh) => `Ship: ${sh.name} - ${sh.desc || ""}`),
    ...SHOP_ITEMS.filter((it) => it.premiumPack === pack).map((it) => `Gadget: ${it.name} - ${it.desc}`)
  ];
  ctx.font = "16px Segoe UI";
  ctx.fillStyle = "#efe8ff";
  contents.forEach((line, i) => ctx.fillText(`- ${line}`, panelX + 44, panelY + 146 + i * 26, panelW - 64));
  if (contents.some((line) => line.startsWith("Gadget"))) {
    ctx.fillStyle = "#a99bc8";
    ctx.fillText("Gadgets in the pack are then bought with points in the Dockyard.", panelX + 44, panelY + 152 + contents.length * 26);
  }

  let status;
  if (owned && store.purchased[pack]) status = "Owned - thank you for your support!";
  else if (owned) status = "Unlocked for testing (development build only).";
  else if (store.busy) status = "Waiting for the Microsoft Store...";
  else if (store.status === "checking") status = "Connecting to the Microsoft Store...";
  else if (store.status === "ready") status = `Price: ${store.prices[pack] || "shown at checkout"}`;
  else status = "Purchases are available in the Microsoft Store version of Harbour Run.";
  ctx.font = "18px Segoe UI";
  ctx.fillStyle = owned ? "#89d98b" : "#ffd182";
  ctx.fillText(status, panelX + 30, panelY + panelH - 160);
  if (!owned) {
    ctx.font = "15px Segoe UI";
    ctx.fillStyle = "#c9b9ee";
    ctx.fillText("Not owned yet: purchase this pack to equip its ships. Premium items can't be earned with points.", panelX + 30, panelY + panelH - 134);
    ctx.font = "18px Segoe UI";
  }

  const canBuy = !owned && store.status === "ready" && !store.busy;
  const buttons = [
    { label: owned ? "Owned" : "Buy (Enter)", enabled: canBuy, action: () => purchasePremiumPack(pack), color: "rgba(104, 62, 170, 0.95)" },
    { label: "Back (Esc)", enabled: true, action: closePremiumScreen, color: "rgba(24, 73, 97, 0.9)" }
  ];
  if (devPremiumTestAllowed()) {
    buttons.push({
      label: store.devUnlocked[pack] ? "[DEV] Re-lock (T)" : "[DEV] Test unlock (T)",
      enabled: true,
      action: () => devTogglePremiumPack(pack),
      color: "rgba(120, 70, 20, 0.9)"
    });
  }
  buttons.forEach((b, i) => {
    drawDockButton(b.label, panelX + 30 + i * 280, panelY + panelH - 118, 262, 78,
      b.enabled ? b.color : "rgba(67, 74, 82, 0.7)", "rgba(235, 225, 255, 0.4)", "#f8f4ff", b.enabled ? b.action : () => {});
  });

  if (game.uiMessage) {
    ctx.fillStyle = "#d8f2ff";
    ctx.font = "15px Segoe UI";
    ctx.fillText(game.uiMessage, panelX + 30, panelY + panelH - 22);
  }
}

// The next gameplay preset, with the wind and hazard strengths that go with it.
function cyclePreset() {
  const idx = GAMEPLAY_PRESETS.indexOf(game.settings.gameplayPreset);
  game.settings.gameplayPreset = GAMEPLAY_PRESETS[(idx + 1) % GAMEPLAY_PRESETS.length];
  const scale = { calm: 0.75, chaos: 1.25 }[game.settings.gameplayPreset] || 1;
  game.settings.windScale = scale;
  game.settings.hazardScale = scale;
  saveSettings();
}

function drawSettingsScreen() {
  const panelX = 30;
  const panelY = 14;
  const panelW = WIDTH - 60;
  const panelH = HEIGHT - 28;

  ctx.fillStyle = "rgba(7, 19, 31, 0.93)";
  ctx.fillRect(panelX, panelY, panelW, panelH);
  ctx.strokeStyle = "rgba(186, 234, 255, 0.42)";
  ctx.lineWidth = 2;
  ctx.strokeRect(panelX, panelY, panelW, panelH);

  ctx.fillStyle = "#e9f8ff";
  ctx.font = "bold 36px Segoe UI";
  ctx.fillText("Settings", panelX + (TOUCH_UI ? 150 : 28), panelY + 46);
  ctx.font = "18px Segoe UI";
  ctx.fillStyle = "#8fb4c8";
  ctx.textAlign = "right";
  ctx.fillText(`Version ${GAME_VERSION}`, panelX + panelW - 24, panelY + 42);
  ctx.textAlign = "left";

  // Touch screens have no keys to rebind: the settings get the whole screen.
  const rowH = TOUCH_UI ? 120 : 60;
  const step = rowH + (TOUCH_UI ? 24 : 10);
  const key = (text) => (TOUCH_UI ? "" : ` (${text})`);
  const camera = view3d.active ? `${CAMERA_VIEW_NAMES[game.settings.cameraView]}${key(keyName(game.settings.keybinds.cameraView))}` : "3D graphics only";
  const buttons = [
    [`Preset: ${game.settings.gameplayPreset.toUpperCase()}  (wind and hazards ${Math.round(game.settings.windScale * 100)}%)`, cyclePreset],
    [`Camera: ${camera}`, toggleCameraView],
    [`Graphics: ${graphicsModeLabel()}${key("G")}`, cycleGraphicsMode],
    [`Time: ${game.settings.nightMode ? "Night" : "Day"}${key(keyName(game.settings.keybinds.nightMode))}`, toggleNightMode],
    [`Sound: ${soundLevel().name}${key("V")}`, cycleSoundLevel],
    [`Back${key("Esc")}`, () => { game.keyRebindAction = null; gameState = "menu"; }]
  ];
  buttons.forEach(([label, action], i) => {
    const x = panelX + 24 + (i % 2) * (panelW / 2 - 12);
    const y = panelY + (TOUCH_UI ? 90 : 62) + Math.floor(i / 2) * step;
    drawDockButton(label, x, y, panelW / 2 - 36, rowH, "rgba(24, 73, 97, 0.95)", "rgba(187, 230, 252, 0.5)", "#f3fbff", action);
  });

  ctx.font = "15px Segoe UI";
  ctx.fillStyle = "#8fb4c8";
  const cardY = panelY + (TOUCH_UI ? 90 + 3 * step + 8 : 62 + 3 * step + 12);
  if (view3d.available) {
    const note = view3d.advancedCapable ? " (Advanced available)" : TOUCH_UI ? "" : ". Advanced needs a dedicated card (Windows Settings > Display > Graphics > High performance)";
    ctx.fillText(`Graphics card in use: ${view3d.gpu}${note}`, panelX + 24, cardY, panelW - 48);
  }

  if (!TOUCH_UI) {
    const keyEntries = Object.entries(KEYBIND_LABELS);
    const colW = Math.floor((panelW - 40) / 4);
    for (let i = 0; i < keyEntries.length; i += 1) {
      const [action, label] = keyEntries[i];
      const col = Math.floor(i / 7);
      const row = i % 7;
      const x = panelX + 24 + col * colW;
      const y = cardY + 12 + row * 49;
      const isWaiting = game.keyRebindAction === action;

      ctx.fillStyle = "rgba(10, 38, 55, 0.9)";
      ctx.fillRect(x, y, colW - 8, 45);
      ctx.strokeStyle = isWaiting ? "#ffd182" : "rgba(163, 216, 240, 0.35)";
      ctx.lineWidth = isWaiting ? 3 : 1.5;
      ctx.strokeRect(x, y, colW - 8, 45);

      ctx.fillStyle = "#e6f5fb";
      ctx.font = "16px Segoe UI";
      ctx.fillText(label, x + 10, y + 18);
      ctx.fillStyle = isWaiting ? "#ffd182" : "#8cead9";
      ctx.font = "bold 18px Segoe UI";
      ctx.fillText(isWaiting ? "Press a key..." : keyName(game.settings.keybinds[action]), x + 10, y + 39);

      registerUiRect(x, y, colW - 8, 45, () => {
        game.keyRebindAction = action;
        setUiMessage(`Rebinding ${label}. Press a key.`);
      });
    }
  }

  ctx.fillStyle = "#ffd182";
  ctx.font = "17px Segoe UI";
  ctx.fillText(game.uiMessage || (TOUCH_UI ? "Tap a setting to change it" : "Click a key box, then press a key"), panelX + 24, panelY + panelH - 12);
}

// "GasTanker" -> "Gas Tanker".
function categoryLabel(category) {
  return category.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function drawShipSelectionScreen() {
  const slot = game.shipSelectSlot;
  const profile = getProfile(slot);
  const shipDef = getShipDefinition(game.shipSelections[slot]);
  const owned = isShipOwned(profile, shipDef);
  const panelX = 40;
  const panelY = 14;
  const panelW = WIDTH - 80;
  const panelH = HEIGHT - 120; // leaves room under the panel for the Set Sail button
  const headX = panelX + (TOUCH_UI ? 140 : 32); // clear of the touch Back button

  ctx.fillStyle = "rgba(6, 18, 28, 0.92)";
  ctx.fillRect(panelX, panelY, panelW, panelH);
  ctx.strokeStyle = "#d7edf9";
  ctx.lineWidth = 2;
  ctx.strokeRect(panelX, panelY, panelW, panelH);

  ctx.fillStyle = "#f7fbff";
  ctx.font = "bold 36px Segoe UI";
  ctx.fillText("Select Your Ship", headX, panelY + 48);
  ctx.font = "22px Segoe UI";
  ctx.fillText(`${profile.name} (${slot.toUpperCase()})   |   ${mode === "single" ? "Single Player" : "Local 2 Player"}   |   ${missionById(game.voyage)?.name || "Free Play"}`, headX, panelY + 84);

  drawCatalogIcon(shipDef, panelX + 150, panelY + 200, 96, true);
  ctx.fillStyle = shipDef.color;
  ctx.font = "bold 34px Segoe UI";
  ctx.fillText(shipDef.name, panelX + 260, panelY + 140);
  ctx.fillStyle = "#dbe9f1";
  ctx.font = "23px Segoe UI";
  ctx.fillText(`${categoryLabel(shipDef.category)}`, panelX + 260, panelY + 174);
  ctx.fillText(`Hull ${shipDef.stats.hp}     Speed ${shipDef.stats.maxSpeed}     Turn ${shipDef.stats.turnRate.toFixed(2)}`, panelX + 260, panelY + 208);
  ctx.fillText(shipDef.desc, panelX + 260, panelY + 242, panelW - 290);

  ctx.fillStyle = owned ? "#89d98b" : shipDef.premiumPack ? "#d2a8ff" : "#ffb18c";
  const statusText = owned ? "Unlocked" : shipDef.premiumPack ? `Requires ${PREMIUM_PACKS[shipDef.premiumPack].name}` : `Buy in the Dockyard for ${shipDef.cost} points`;
  ctx.fillText(statusText, panelX + 260, panelY + 276);

  // Two rows of tiles, so the whole fleet fits.
  const perRow = Math.ceil(SHIP_CATALOG.length / 2);
  const spacing = (panelW - 24) / perRow;
  for (let i = 0; i < SHIP_CATALOG.length; i += 1) {
    const ship = SHIP_CATALOG[i];
    const x = panelX + 12 + (i % perRow) * spacing;
    const y = panelY + panelH - 232 + Math.floor(i / perRow) * 98;
    const w = spacing - 8;
    const unlocked = isShipOwned(profile, ship);
    ctx.fillStyle = ship.id === shipDef.id ? "rgba(91, 145, 177, 0.55)" : "rgba(14, 40, 58, 0.85)";
    ctx.fillRect(x, y, w, 92);
    ctx.strokeStyle = ship.id === shipDef.id ? "#ffd182" : "rgba(166, 218, 244, 0.35)";
    ctx.lineWidth = ship.id === shipDef.id ? 3 : 1.5;
    ctx.strokeRect(x, y, w, 92);
    drawCatalogIcon(ship, x + 20, y + 22, 30, true);
    ctx.fillStyle = unlocked ? ship.color : "#8d99a5";
    ctx.font = "bold 20px Segoe UI";
    ctx.fillText(categoryLabel(ship.category), x + 40, y + 29, w - 46);
    ctx.fillStyle = "#cfdeea";
    ctx.font = "17px Segoe UI";
    ctx.fillText(ship.name, x + 8, y + 56, w - 14);
    ctx.fillStyle = unlocked ? "#89d98b" : "#ffd182";
    ctx.fillText(unlocked ? "Ready" : ship.premiumPack ? "Premium" : `${ship.cost} pts`, x + 8, y + 80, w - 14);
    registerUiRect(x, y, w, 92, () => {
      game.shipSelections[slot] = ship.id;
    });
  }

  if (!game.midGameChange && owned) {
    const posts = crewPosts(shipDef.category);
    const filled = posts.filter((p) => crewAssigned(profile, shipDef.id, p)).length;
    drawDockButton(`Ship Crew ${filled}/${posts.length}${TOUCH_UI ? "" : " (M)"}`, panelX + panelW - 316, panelY + 18, 296, 64, "rgba(24, 73, 97, 0.9)", "rgba(166, 218, 244, 0.5)", "#e8f6ff", () => openCrewScreen(slot, shipDef.id, "shipSelect"), "cap");
  }

  const galley = !game.midGameChange && slot === "p1" && secondRowsGalley(shipDef.id);
  const p2Next = mode === "local" && slot === "p1" && !galley;
  ctx.fillStyle = "#ffd182";
  ctx.font = "17px Segoe UI";
  if (galley) ctx.fillText("Player 2 will row the Order's galley and tow you out", panelX + 640, panelY + 276, panelW - 660);
  if (!TOUCH_UI) {
    ctx.fillText(
      game.midGameChange
        ? "Left/Right: Change Ship  Enter: Change Ship  Esc: Keep your current ship"
        : `Left/Right: Change Ship  Tab: Switch Player  O: Dockyard  Enter: ${p2Next ? "Next Captain" : "Set Sail"}  Esc: Back`,
      headX, panelY + panelH - 12);
  }
  drawNavalButton({
    x: (WIDTH - 440) / 2, y: panelY + panelH + 10, w: 440, h: 86, primary: true, focused: true,
    label: game.midGameChange ? "Take Command" : p2Next ? "Next Captain" : "Set Sail",
    icon: game.midGameChange ? "wheel" : p2Next ? "captains" : "ship",
    onClick: () => confirmShipSelectionAndStart()
  });
}

function drawLeaderboardScreen() {
  ctx.fillStyle = "rgba(6, 18, 28, 0.86)";
  ctx.fillRect(150, 20, WIDTH - 300, HEIGHT - 40);
  ctx.strokeStyle = "#d7edf9";
  ctx.lineWidth = 2;
  ctx.strokeRect(150, 20, WIDTH - 300, HEIGHT - 40);

  ctx.save();
  ctx.textAlign = "center";
  ctx.fillStyle = "#f4fbff";
  ctx.font = "bold 40px Segoe UI";
  ctx.fillText("Leaderboard", WIDTH / 2, 74);

  const entries = leaderboardEntries();
  ctx.font = "27px Segoe UI";
  if (entries.length === 0) {
    ctx.fillText("No scores yet.", WIDTH / 2, 220);
  } else {
    entries.forEach((row, i) => {
      ctx.textAlign = "left";
      ctx.fillText(`${i + 1}. ${row.name}`, 270, 122 + i * 43);
      ctx.textAlign = "right";
      ctx.fillText(`${row.points}`, WIDTH - 270, 122 + i * 43);
    });
  }
  ctx.restore();

  const key = (text) => (TOUCH_UI ? "" : ` (${text})`);
  drawDockButton(`Clear Board${key("C")}`, 175, 476, 270, 78, "rgba(110, 56, 56, 0.92)", "rgba(255, 194, 194, 0.45)", "#ffeaea", () => clearLeaderboardScores());
  drawDockButton(`Clear P1 Points${key("1")}`, 465, 476, 270, 78, "rgba(56, 86, 110, 0.92)", "rgba(194, 227, 255, 0.45)", "#eaf7ff", () => clearPlayerPoints("p1"));
  drawDockButton(`Clear P2 Points${key("2")}`, 755, 476, 270, 78, "rgba(110, 92, 56, 0.92)", "rgba(255, 239, 194, 0.45)", "#fff6e6", () => clearPlayerPoints("p2"));
  drawDockButton(`Back${key("Esc")}`, WIDTH / 2 - 180, 576, 360, 78, "rgba(24, 73, 97, 0.95)", "rgba(166, 218, 244, 0.5)", "#e8f6ff", () => { gameState = "menu"; }, "back");
}

function getEndButtons() {
  const buttons = [
    { label: "Harbour", icon: "buoy", idleColor: "rgba(56, 86, 110, 0.92)", idleStroke: "rgba(194, 227, 255, 0.45)", textColor: "#eaf7ff", action: () => { gameState = "menu"; } },
    { label: "Sail Again", icon: "ship", idleColor: "rgba(27, 98, 72, 0.92)", idleStroke: "rgba(196, 255, 224, 0.45)", textColor: "#e7fff4", action: () => openShipSelect() }
  ];
  if (game.mission) buttons.push({ label: "Missions", icon: "trophy", idleColor: "rgba(110, 82, 40, 0.92)", idleStroke: "rgba(255, 226, 180, 0.45)", textColor: "#fff2dc", action: openMissions });
  const w = 280;
  const left = (WIDTH - buttons.length * (w + 24) + 24) / 2;
  return buttons.map((b, i) => ({ ...b, x: left + i * (w + 24), y: 380, w, h: 92 }));
}

// Long result strings drawn at 300,300 with no wrapping used to run past
// the canvas edge and get cut off ("...you" then nothing) - wrap and
// center them instead so the full message is always visible.
function drawWrappedCenteredText(text, centerX, y, maxWidth, lineHeight) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);

  lines.forEach((l, i) => {
    ctx.fillText(l, centerX - ctx.measureText(l).width / 2, y + i * lineHeight);
  });
}

function formatGameTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// 2-player game over: each captain's ship, points earned in this game and
// when they sank; the higher score wins.
function drawGameSummary() {
  const ships = [game.player1, game.player2].filter(Boolean);
  const points = (ship) => game.gamePoints[ship.playerSlot] || 0;
  const best = Math.max(...ships.map(points));
  const winners = ships.filter((ship) => points(ship) === best);
  const panelX = 230;
  const panelW = WIDTH - 460;
  ctx.fillStyle = "rgba(10, 30, 44, 0.9)";
  ctx.fillRect(panelX, 130, panelW, 210);
  ctx.strokeStyle = "rgba(163, 216, 240, 0.45)";
  ctx.strokeRect(panelX, 130, panelW, 210);
  ctx.fillStyle = "#ffd182";
  ctx.font = "bold 22px Segoe UI";
  ctx.textAlign = "center";
  ctx.fillText("Game summary", WIDTH / 2, 162);
  const cols = [panelX + 24, panelX + 250, panelX + 430, panelX + 560];
  ctx.textAlign = "left";
  ctx.font = "bold 14px Segoe UI";
  ctx.fillStyle = "#9fc6da";
  ["Captain", "Ship", "Points", "Sank"].forEach((h, i) => ctx.fillText(h, cols[i], 196));
  ships.forEach((ship, i) => {
    const y = 236 + i * 44;
    const won = winners.length === 1 && winners[0] === ship;
    ctx.fillStyle = won ? "rgba(255, 209, 130, 0.14)" : "rgba(255, 255, 255, 0.04)";
    ctx.fillRect(panelX + 12, y - 26, panelW - 24, 38);
    ctx.font = "bold 18px Segoe UI";
    ctx.fillStyle = ship.displayColor || "#e6f5fb";
    ctx.fillText(`${ship.playerName || ship.playerSlot.toUpperCase()}${won ? "  - winner" : ""}`, cols[0], y);
    ctx.font = "17px Segoe UI";
    ctx.fillStyle = "#e6f5fb";
    ctx.fillText(ship.shipName || ship.category || "", cols[1], y);
    ctx.font = "bold 20px Segoe UI";
    ctx.fillText(String(points(ship)), cols[2], y);
    ctx.font = "16px Segoe UI";
    ctx.fillText(ship.outAt !== undefined ? formatGameTime(ship.outAt) : "-", cols[3], y);
  });
  ctx.font = "15px Segoe UI";
  ctx.fillStyle = "#cfe3ee";
  ctx.textAlign = "center";
  const tie = winners.length > 1 ? "A draw - " : "";
  const done = game.crossings;
  const progress = game.mission
    ? (game.missionWon ? "mission complete" : "mission failed")
    : done === 0 ? "sank before reaching Harbour B" : `${done} crossing${done === 1 ? "" : "s"} completed`;
  ctx.fillText(`${tie}${progress} - game time ${formatGameTime(game.elapsed)}`, WIDTH / 2, 328);
  ctx.textAlign = "left";
}

function drawEndScreen() {
  ctx.fillStyle = "rgba(4, 13, 20, 0.68)";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = "#f7fbff";
  ctx.font = "36px Segoe UI";
  const summary = mode === "local" && game.player2;
  drawWrappedCenteredText(resultText, WIDTH / 2, summary ? 100 : 260, WIDTH - 200, 42);
  if (summary) drawGameSummary();
  ctx.fillStyle = "#f7fbff";
  ctx.font = "24px Segoe UI";
  if (!TOUCH_UI) {
    ctx.textAlign = "center";
    ctx.fillText("Arrow Keys: Navigate   Enter: Select", WIDTH / 2, summary ? 512 : 350);
    ctx.textAlign = "left";
  }

  ctx.font = "22px Segoe UI";
  const endButtons = getEndButtons();
  for (let i = 0; i < endButtons.length; i++) {
    const button = endButtons[i];
    drawDockButton(button.label, button.x, button.y, button.w, button.h, button.idleColor,
      i === game.endedIndex ? "#ffd682" : button.idleStroke, button.textColor, () => {
        game.endedIndex = i;
        button.action();
      }, button.icon);
  }
}

// ---------------------------------------------------------------------------
// Cannon cinematic: when a pirate fires, the view cuts to a full-screen
// close-up of the pirate's cannon firing at the ship it hits, then back. The
// 3D view films it in the world itself (render3d.js updateCannonShot); the
// painted scene below is for the 2D view. The world is frozen while it plays
// (see tick()), so the player never loses anything they could have reacted to.
// ---------------------------------------------------------------------------
const CANNON_CINEMATIC_DURATION = 1.7;
const CANNON_CINEMATIC_FIRE_AT = 0.28;
const CANNON_CINEMATIC_IMPACT_AT = 1.0;
const CANNON_CINEMATIC_COOLDOWN = 5;

function startCannonCinematic(attacker, target) {
  if (gameState !== "playing" || game.cannonCinematic) return;
  if (game.elapsed < (game.nextCinematicAt || 0)) return;
  game.nextCinematicAt = game.elapsed + CANNON_CINEMATIC_COOLDOWN;

  const smoke = [];
  for (let i = 0; i < 16; i += 1) {
    smoke.push({
      angle: -0.7 + Math.random() * 1.4,
      speed: 60 + Math.random() * 160,
      size: 30 + Math.random() * 45,
      delay: Math.random() * 0.18,
      shade: 150 + Math.floor(Math.random() * 70)
    });
  }

  game.cannonCinematic = {
    elapsed: 0,
    fired: false,
    smoke,
    attacker,
    target,
    targetBurning: !!target.fire, // before the shot lands
    pirateName: attacker.shipName || "Pirate Raider",
    targetName: target.playerName || "your ship",
    targetColor: target.displayColor || (target.type === "cruise" ? "#3d8fe0" : "#e0a23d")
  };
}

function updateCannonCinematic(dt) {
  const cin = game.cannonCinematic;
  if (!cin) return;
  cin.elapsed += dt;
  if (!cin.fired && cin.elapsed >= CANNON_CINEMATIC_FIRE_AT) {
    cin.fired = true;
    playCannonBoom();
  }
  if (cin.elapsed >= CANNON_CINEMATIC_DURATION) {
    game.cannonCinematic = null;
  }
}

function playCannonBoom() {
  if (!ensureAudio()) return;
  const ac = game.audioContext;
  const now = ac.currentTime;

  // Low thump: a sine sweeping down.
  const osc = ac.createOscillator();
  const oscGain = ac.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(140, now);
  osc.frequency.exponentialRampToValueAtTime(38, now + 0.45);
  oscGain.gain.setValueAtTime(0.0001, now);
  oscGain.gain.exponentialRampToValueAtTime(0.35, now + 0.01);
  oscGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
  osc.connect(oscGain);
  oscGain.connect(sfx.out);
  osc.start(now);
  osc.stop(now + 0.65);

  // Blast crack: short burst of decaying noise.
  const length = Math.floor(ac.sampleRate * 0.5);
  const buffer = ac.createBuffer(1, length, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3);
  }
  const noise = ac.createBufferSource();
  noise.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 900;
  const noiseGain = ac.createGain();
  noiseGain.gain.value = 0.22;
  noise.connect(filter);
  filter.connect(noiseGain);
  noiseGain.connect(sfx.out);
  noise.start(now);
}

function drawCannonCinematic() {
  const cin = game.cannonCinematic;
  if (!cin) return;

  const t = cin.elapsed;
  const sinceFire = t - CANNON_CINEMATIC_FIRE_AT;
  const fired = sinceFire >= 0;

  // Snap in fast, fade back out to the plan view at the end.
  const fadeIn = clamp(t / 0.08, 0, 1);
  const fadeOut = clamp((CANNON_CINEMATIC_DURATION - t) / 0.3, 0, 1);
  const alpha = Math.min(fadeIn, fadeOut);

  // In 3D the scene is already on screen behind this layer: only the words.
  if (!view3d.active) drawCinematicScene2d(cin, t, sinceFire, alpha);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
  ctx.shadowBlur = 10;
  ctx.font = "bold 30px Segoe UI";
  ctx.fillStyle = "#ffd75e";
  ctx.fillText(fired ? "FIRE!" : `${cin.pirateName} takes aim...`, WIDTH / 2, 40);
  ctx.font = "16px Segoe UI";
  ctx.fillStyle = "#d8e8f2";
  ctx.fillText(`Pirate cannon aimed at ${cin.targetName}`, WIDTH / 2, HEIGHT - 24);
  ctx.restore();
}

function drawCinematicScene2d(cin, t, sinceFire, alpha) {
  const fired = sinceFire >= 0;

  ctx.save();
  ctx.globalAlpha = alpha;

  // Camera: slow push-in, plus a shake right after the shot.
  const push = 1.06 - 0.06 * clamp(t / CANNON_CINEMATIC_DURATION, 0, 1);
  const shake = fired ? Math.max(0, 1 - sinceFire / 0.45) * 14 : 0;
  ctx.translate(WIDTH / 2 + (Math.random() - 0.5) * shake, HEIGHT / 2 + (Math.random() - 0.5) * shake);
  ctx.scale(push, push);
  ctx.translate(-WIDTH / 2, -HEIGHT / 2);

  const horizonY = 400;
  drawCinematicSkyAndSea(horizonY, t);

  // Target ship on the horizon.
  const targetX = 930;
  const targetY = horizonY + 8;
  const impactAge = t - CANNON_CINEMATIC_IMPACT_AT;
  const targetRock = impactAge > 0 ? Math.sin(impactAge * 18) * Math.max(0, 1 - impactAge / 0.6) * 0.08 : 0;
  drawCinematicTargetShip(targetX, targetY, cin.targetColor, targetRock);

  // Pirate deck in the foreground, planks converging on a vanishing point.
  drawCinematicDeck(horizonY);

  // Cannon recoils back along its axis when fired.
  const recoil = fired ? Math.sin(clamp(sinceFire / 0.35, 0, 1) * Math.PI) * 38 : 0;
  const muzzle = drawCinematicCannon(recoil, t);

  // Fuse spark before the shot.
  if (!fired) {
    const fx = 300 + (Math.random() - 0.5) * 6;
    const fy = 548 + (Math.random() - 0.5) * 6;
    const spark = ctx.createRadialGradient(fx, fy, 0, fx, fy, 22);
    spark.addColorStop(0, "rgba(255, 250, 200, 1)");
    spark.addColorStop(0.4, "rgba(255, 170, 40, 0.8)");
    spark.addColorStop(1, "rgba(255, 90, 0, 0)");
    ctx.fillStyle = spark;
    ctx.beginPath();
    ctx.arc(fx, fy, 22, 0, Math.PI * 2);
    ctx.fill();
  }

  if (fired) {
    // Cannonball flies in an arc toward the target, shrinking with distance.
    const flight = clamp(sinceFire / (CANNON_CINEMATIC_IMPACT_AT - CANNON_CINEMATIC_FIRE_AT), 0, 1);
    if (flight < 1) {
      const bx = muzzle.x + (targetX - muzzle.x) * flight;
      const by = muzzle.y + (targetY - 10 - muzzle.y) * flight - Math.sin(flight * Math.PI) * 70;
      const br = 15 - 11 * flight;
      ctx.fillStyle = "#1b1b1f";
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
      ctx.beginPath();
      ctx.arc(bx - br * 0.35, by - br * 0.35, br * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }

    drawCinematicSmoke(cin.smoke, muzzle, sinceFire);
    drawCinematicMuzzleFlash(muzzle, sinceFire);
  }

  if (impactAge > 0) {
    drawCinematicImpact(targetX, targetY - 12, impactAge);
  }

  ctx.restore();

  // Overlay elements are drawn without camera shake.
  ctx.save();
  ctx.globalAlpha = alpha;

  // Cinematic letterbox bars.
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, WIDTH, 58);
  ctx.fillRect(0, HEIGHT - 58, WIDTH, 58);

  // White flash at the moment of firing.
  if (fired && sinceFire < 0.14) {
    ctx.globalAlpha = alpha * (1 - sinceFire / 0.14) * 0.85;
    ctx.fillStyle = "#fff8e0";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }
  ctx.restore();
}

function drawCinematicSkyAndSea(horizonY, t) {
  const sky = ctx.createLinearGradient(0, 0, 0, horizonY);
  sky.addColorStop(0, "#1c2440");
  sky.addColorStop(0.55, "#a2553d");
  sky.addColorStop(1, "#f1a85a");
  ctx.fillStyle = sky;
  ctx.fillRect(-60, -60, WIDTH + 120, horizonY + 60);

  // Low sun glow.
  const sun = ctx.createRadialGradient(760, horizonY - 20, 10, 760, horizonY - 20, 260);
  sun.addColorStop(0, "rgba(255, 228, 160, 0.9)");
  sun.addColorStop(1, "rgba(255, 180, 90, 0)");
  ctx.fillStyle = sun;
  ctx.fillRect(-60, -60, WIDTH + 120, horizonY + 60);

  const sea = ctx.createLinearGradient(0, horizonY, 0, HEIGHT);
  sea.addColorStop(0, "#3c5d74");
  sea.addColorStop(1, "#0b2333");
  ctx.fillStyle = sea;
  ctx.fillRect(-60, horizonY, WIDTH + 120, HEIGHT - horizonY + 60);

  // Wave lines get further apart and thicker toward the camera (perspective).
  ctx.strokeStyle = "rgba(200, 230, 255, 0.18)";
  for (let i = 1; i < 14; i += 1) {
    const depth = i / 14;
    const y = horizonY + Math.pow(depth, 2) * (HEIGHT - horizonY + 40);
    ctx.lineWidth = 0.6 + depth * 2.4;
    ctx.beginPath();
    for (let x = -60; x <= WIDTH + 60; x += 30) {
      const wy = y + Math.sin(x * 0.02 / (0.3 + depth) + t * 2.4 + i) * (1 + depth * 5);
      if (x === -60) ctx.moveTo(x, wy);
      else ctx.lineTo(x, wy);
    }
    ctx.stroke();
  }
}

function drawCinematicTargetShip(x, y, color, rock) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rock);

  // Hull.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-64, -14);
  ctx.lineTo(64, -14);
  ctx.lineTo(48, 6);
  ctx.lineTo(-50, 6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
  ctx.fillRect(-56, -2, 108, 8);

  // Masts and sails.
  ctx.strokeStyle = "#3a2a1c";
  ctx.lineWidth = 3;
  for (const mx of [-22, 20]) {
    ctx.beginPath();
    ctx.moveTo(mx, -14);
    ctx.lineTo(mx, -78);
    ctx.stroke();
    ctx.fillStyle = "#f3eee0";
    ctx.beginPath();
    ctx.moveTo(mx - 20, -70);
    ctx.quadraticCurveTo(mx + 4, -56, mx - 18, -24);
    ctx.lineTo(mx + 20, -24);
    ctx.quadraticCurveTo(mx + 26, -50, mx + 18, -70);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Reflection on the water.
  ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
  ctx.fillRect(x - 50, y + 8, 100, 4);
}

function drawCinematicDeck(horizonY) {
  const vpX = WIDTH * 0.62;
  const deckTop = 560;

  // Wooden deck slab.
  const deck = ctx.createLinearGradient(0, deckTop, 0, HEIGHT + 60);
  deck.addColorStop(0, "#5a3a22");
  deck.addColorStop(1, "#2a190d");
  ctx.fillStyle = deck;
  ctx.beginPath();
  ctx.moveTo(-60, deckTop + 40);
  ctx.lineTo(WIDTH + 60, deckTop - 10);
  ctx.lineTo(WIDTH + 60, HEIGHT + 60);
  ctx.lineTo(-60, HEIGHT + 60);
  ctx.closePath();
  ctx.fill();

  // Planks converge toward a vanishing point on the horizon.
  ctx.strokeStyle = "rgba(20, 10, 4, 0.55)";
  ctx.lineWidth = 2;
  for (let i = -8; i <= 18; i += 1) {
    const bottomX = i * 90;
    const topY = deckTop + 40 - ((bottomX + 60) / (WIDTH + 120)) * 50;
    const k = (topY - horizonY) / (HEIGHT + 60 - horizonY);
    const topX = vpX + (bottomX - vpX) * k;
    ctx.beginPath();
    ctx.moveTo(topX, topY);
    ctx.lineTo(bottomX, HEIGHT + 60);
    ctx.stroke();
  }

  // Bulwark rail along the deck edge.
  ctx.fillStyle = "#3b2414";
  ctx.beginPath();
  ctx.moveTo(-60, deckTop + 18);
  ctx.lineTo(WIDTH + 60, deckTop - 30);
  ctx.lineTo(WIDTH + 60, deckTop - 6);
  ctx.lineTo(-60, deckTop + 44);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(255, 210, 150, 0.25)";
  ctx.beginPath();
  ctx.moveTo(-60, deckTop + 18);
  ctx.lineTo(WIDTH + 60, deckTop - 30);
  ctx.lineTo(WIDTH + 60, deckTop - 26);
  ctx.lineTo(-60, deckTop + 22);
  ctx.closePath();
  ctx.fill();
}

// Draws the cannon as a shaded tapered cylinder on a wheeled carriage.
// Returns the muzzle position so the flash, smoke and ball can start there.
function drawCinematicCannon(recoil, t) {
  const angle = Math.atan2(440 - 560, 640 - 330);
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const breech = { x: 330 - ux * recoil, y: 560 - uy * recoil };
  const muzzle = { x: 640 - ux * recoil, y: 440 - uy * recoil };
  const nx = -uy;
  const ny = ux;
  const rB = 58;
  const rM = 40;

  // Carriage (wooden block) and wheels.
  ctx.fillStyle = "#4a2c16";
  ctx.beginPath();
  ctx.moveTo(breech.x - 70, breech.y + 40);
  ctx.lineTo(breech.x + 210, breech.y - 40);
  ctx.lineTo(breech.x + 230, breech.y + 20);
  ctx.lineTo(breech.x - 40, breech.y + 110);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
  ctx.lineWidth = 3;
  ctx.stroke();

  for (const w of [{ x: breech.x - 20, y: breech.y + 112, r: 46 }, { x: breech.x + 210, y: breech.y + 34, r: 36 }]) {
    ctx.fillStyle = "#2c1a0c";
    ctx.beginPath();
    ctx.ellipse(w.x, w.y, w.r * 0.42, w.r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#7a5230";
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.fillStyle = "#7a5230";
    ctx.beginPath();
    ctx.ellipse(w.x, w.y, w.r * 0.12, w.r * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Barrel body with cylindrical shading (dark edges, bright highlight).
  const mid = { x: (breech.x + muzzle.x) / 2, y: (breech.y + muzzle.y) / 2 };
  const shade = ctx.createLinearGradient(mid.x + nx * rB, mid.y + ny * rB, mid.x - nx * rB, mid.y - ny * rB);
  shade.addColorStop(0, "#0d0f12");
  shade.addColorStop(0.32, "#3c4248");
  shade.addColorStop(0.5, "#8c949c");
  shade.addColorStop(0.68, "#3c4248");
  shade.addColorStop(1, "#0d0f12");
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.moveTo(breech.x + nx * rB, breech.y + ny * rB);
  ctx.lineTo(muzzle.x + nx * rM, muzzle.y + ny * rM);
  ctx.lineTo(muzzle.x - nx * rM, muzzle.y - ny * rM);
  ctx.lineTo(breech.x - nx * rB, breech.y - ny * rB);
  ctx.closePath();
  ctx.fill();

  // Reinforcing bands.
  for (const k of [0.12, 0.5, 0.86]) {
    const cx = breech.x + (muzzle.x - breech.x) * k;
    const cy = breech.y + (muzzle.y - breech.y) * k;
    const r = rB + (rM - rB) * k + 4;
    ctx.strokeStyle = "rgba(170, 178, 186, 0.75)";
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 0.32, r, angle, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
  }

  // Breech knob (cascabel).
  ctx.fillStyle = "#24282d";
  ctx.beginPath();
  ctx.ellipse(breech.x, breech.y, rB * 0.36, rB, angle, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#3c4248";
  ctx.beginPath();
  ctx.arc(breech.x - ux * 22, breech.y - uy * 22, 16, 0, Math.PI * 2);
  ctx.fill();

  // Muzzle lip and bore.
  ctx.fillStyle = "#5a6168";
  ctx.beginPath();
  ctx.ellipse(muzzle.x, muzzle.y, rM * 0.4, rM + 6, angle, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#050505";
  ctx.beginPath();
  ctx.ellipse(muzzle.x + ux * 2, muzzle.y + uy * 2, rM * 0.26, rM * 0.7, angle, 0, Math.PI * 2);
  ctx.fill();

  return { x: muzzle.x + ux * 10, y: muzzle.y + uy * 10, angle };
}

function drawCinematicMuzzleFlash(muzzle, sinceFire) {
  const life = 0.22;
  if (sinceFire > life) return;
  const k = 1 - sinceFire / life;
  const size = 150 * (0.6 + 0.4 * k);

  ctx.save();
  ctx.translate(muzzle.x, muzzle.y);
  ctx.rotate(muzzle.angle);
  ctx.globalAlpha *= k;

  const glow = ctx.createRadialGradient(size * 0.3, 0, 0, size * 0.3, 0, size);
  glow.addColorStop(0, "rgba(255, 255, 230, 1)");
  glow.addColorStop(0.3, "rgba(255, 200, 80, 0.95)");
  glow.addColorStop(0.7, "rgba(255, 100, 20, 0.5)");
  glow.addColorStop(1, "rgba(255, 60, 0, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.ellipse(size * 0.35, 0, size, size * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();

  // Star-burst spikes.
  ctx.fillStyle = "rgba(255, 240, 180, 0.9)";
  for (let i = 0; i < 9; i += 1) {
    const a = -0.9 + (i / 8) * 1.8;
    const len = size * (0.8 + ((i * 37) % 10) / 14);
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
    ctx.lineTo(0, 6);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawCinematicSmoke(puffs, muzzle, sinceFire) {
  for (const p of puffs) {
    const age = sinceFire - p.delay;
    if (age <= 0) continue;
    const a = muzzle.angle + p.angle;
    const travel = p.speed * (1 - Math.exp(-age * 2.4));
    const x = muzzle.x + Math.cos(a) * travel;
    const y = muzzle.y + Math.sin(a) * travel - age * 30;
    const r = p.size * (0.4 + age * 1.3);
    const alpha = clamp(0.75 - age * 0.45, 0, 0.75);
    if (alpha <= 0) continue;

    const puff = ctx.createRadialGradient(x - r * 0.25, y - r * 0.25, r * 0.1, x, y, r);
    puff.addColorStop(0, `rgba(${p.shade + 30}, ${p.shade + 28}, ${p.shade + 24}, ${alpha})`);
    puff.addColorStop(1, `rgba(${p.shade - 40}, ${p.shade - 40}, ${p.shade - 40}, 0)`);
    ctx.fillStyle = puff;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCinematicImpact(x, y, age) {
  // Fireball on the hull.
  if (age < 0.4) {
    const k = age / 0.4;
    const r = 20 + k * 60;
    const fire = ctx.createRadialGradient(x, y, 0, x, y, r);
    fire.addColorStop(0, `rgba(255, 245, 200, ${1 - k})`);
    fire.addColorStop(0.5, `rgba(255, 140, 30, ${0.85 * (1 - k)})`);
    fire.addColorStop(1, "rgba(120, 30, 0, 0)");
    ctx.fillStyle = fire;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Water splash column rising and falling back.
  const rise = Math.sin(clamp(age / 0.7, 0, 1) * Math.PI);
  if (rise > 0) {
    ctx.fillStyle = `rgba(225, 240, 255, ${0.75 * rise})`;
    for (let i = -3; i <= 3; i += 1) {
      const h = (70 - Math.abs(i) * 14) * rise;
      ctx.beginPath();
      ctx.ellipse(x + i * 12, y + 16 - h / 2, 7, h / 2, i * 0.12, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Dark smoke drifting up from the hit.
  const smokeAlpha = clamp(0.6 - age, 0, 0.6);
  if (smokeAlpha > 0) {
    ctx.fillStyle = `rgba(40, 36, 34, ${smokeAlpha})`;
    for (let i = 0; i < 4; i += 1) {
      ctx.beginPath();
      ctx.arc(x - 10 + i * 8, y - 20 - age * 60 - i * 10, 14 + age * 30, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// In danger of capsizing: the hull nearly gone, a tsunami coming at her side,
// or the throat of a whirlpool close by.
const DANGER_HULL = 0.25; // share of full health
const DANGER_WHIRL_STRENGTH = 0.35;
const DANGER_WHIRL_REACH = 0.4; // share of the whirlpool's radius

function inCapsizeDanger(ship) {
  if (!ship || ship.capsized) return false;
  if (ship.hp <= ship.maxHull * DANGER_HULL) return true;
  if (tsunami.state !== "dormant" && !tsunami.passed.has(ship) && !shipFacesTsunami(ship)) return true;
  return whirlpool.state === "active" && whirlpool.strength > DANGER_WHIRL_STRENGTH && dist(ship, whirlpool) < whirlpool.r * DANGER_WHIRL_REACH;
}

// The ship's alarm: in the bridge view, while your ship is burning (lava, fire
// bombs...) or in danger of capsizing, the alarm rings (audio.js) and the
// screen border flashes red (style.css body.bridge-alarm). Quiet while paused.
function bridgeAlarmOn() {
  if (gameState !== "playing" || game.exitConfirm || game.cannonCinematic) return false;
  if (!view3d.active || game.settings.cameraView !== "bridge") return false;
  return humanShips().some((ship) => !ship.capsized && (ship.fire || inCapsizeDanger(ship)));
}

// Every captain's ship is down: the 3D view is under the sea with the wreck
// (render3d.js), for SINK_SCENE_TIME and then behind the end screen.
const SINK_SCENE_TIME = 7; // seconds

function underwaterView() {
  // (a ship that went over a waterfall is watched from above, falling)
  return view3d.active && !game.cannonCinematic && (gameState === "playing" || gameState === "ended") && humanShips().every((ship) => ship.capsized) && !humanShips().some((ship) => ship.overFalls !== undefined);
}

function capsizedMessage() {
  return humanShips().length > 1 ? "Both ships capsized" : "Ship capsized";
}

function drawCapsizedCaption() {
  const age = game.elapsed - Math.max(...humanShips().map((ship) => ship.sankAt));
  ctx.save();
  ctx.globalAlpha = clamp(age - 1.5, 0, 1);
  ctx.textAlign = "center";
  ctx.font = "bold 54px Segoe UI";
  ctx.shadowColor = "rgba(0, 0, 0, 0.8)";
  ctx.shadowBlur = 14;
  ctx.fillStyle = "#ffe3dc";
  ctx.fillText(capsizedMessage().toUpperCase(), WIDTH / 2, HEIGHT - 110);
  ctx.restore();
}

function render() {
  document.body.classList.toggle("playing-mode", gameState === "playing" || gameState === "arrival");
  document.body.classList.toggle("bridge-alarm", bridgeAlarmOn());
  document.body.classList.toggle("cannon-shot", !!game.cannonCinematic);
  document.body.classList.toggle("at-main-menu", gameState === "menu");
  document.body.classList.toggle("in-dockyard", gameState === "shop");
  document.body.classList.toggle("docking", dockLoading());
  document.body.classList.toggle("era-changing", eraLoading());
  if (eraLoading()) document.getElementById("eraStatus").textContent = view3d.eraChange;

  clearUiRects();
  reserveHudBoxes();
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  // The 3D cannon shot has the whole screen: no labels, instruments or map.
  if (view3d.active && game.cannonCinematic) return;

  // With the 3D view on, this canvas is a transparent layer over it and only
  // carries labels, HUD and menus; the world itself is drawn by render3d.js.
  if (!view3d.active) {
    const grad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    grad.addColorStop(0, "#2a6887");
    grad.addColorStop(1, "#16465f");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }

  // The shop is the 3D dockyard: just its icons and text on top.
  if (gameState === "shop") {
    drawShopScreen();
    return;
  }

  if (!view3d.active) {
    updateView2d();
    ctx.save();
    applyWorldTransform2d();
    drawMissionTerrain2d();
    drawHarbourDiscs();
    for (const s of game.iceSheets) ctx.drawImage(s.canvas, s.x - s.r, s.y - s.r, s.r * 2, s.r * 2);
    drawHazards();
    drawHosesAndRopes2d();
    drawDynamicDangers();
    drawWaterSpouts();
    drawWhirlpool();
    drawTsunami();
    drawSeaCreatures();
    drawUnderwaterEnemies();
    drawMissiles();
    if (mode === "single") drawBoardingPlank();
    if (game.settings.nightMode) drawNight2d();
    ctx.restore();
  }
  // Under the sea there are no surface labels, warnings or instruments, and
  // the harbour behind the menus is just the scene.
  const underwater = underwaterView();
  if (game.harbourShip) {
    if (!view3d.active) {
      ctx.save();
      applyWorldTransform2d();
      drawShipBody(game.harbourShip);
      ctx.restore();
    }
  } else if (!underwater) {
    drawHarbours();
    drawShip(game.player1, game.player1 ? game.player1.playerName : "P1");
    if (mode === "local") drawShip(game.player2, game.player2 ? `${game.player2.playerName}` : "P2");
    if (mode === "single") drawShip(game.ai, "CPU Pirate");
    if (game.galley) drawShip(game.galley.boat, "Order's galley");
    if (piratesAbout()) drawPirateRaiders();
    if (!view3d.active) {
      ctx.save();
      applyWorldTransform2d();
      drawCarrierJets2d();
      ctx.restore();
    }
    if (mode === "single") drawPirateCallout();
    if (!view3d.active) drawFog2d();
    drawFloatingScores();
    drawTargetAlerts();
    drawTsunamiWarning();
  }

  if (underwater && gameState === "playing") {
    drawCapsizedCaption();
  } else if (gameState === "playing" || gameState === "arrival") {
    drawCrewCourse();
    drawMissionSites();
    drawHud();
    drawMissionPanel();
    drawBridgeInstruments();
    drawSplitDivider();
    drawMiniMap();
    drawFirePrompts();
    drawPlayersOut();
    drawBerthPrompts();
    drawTowPrompts();
    drawWindAlerts();
    drawReadyToSail();
    drawCrewHud();
  }

  if (gameState === "menu") drawMenu();
  if (gameState === "voyage") drawVoyageScreen();
  if (gameState === "missions") drawMissionsScreen();
  if (gameState === "settings") drawSettingsScreen();
  if (gameState === "shipSelect") drawShipSelectionScreen();
  if (gameState === "leaderboard") drawLeaderboardScreen();
  if (gameState === "premium") drawPremiumScreen();
  if (gameState === "crew") drawCrewScreen();
  if (gameState === "ended") drawEndScreen();
  if (gameState === "arrival") drawArrival();
}

// Free Play's "Harbour reached" card: it scales/fades in over ~0.5s, then the
// whole card gently bobs and the prompt pulses until the player presses a
// key to resume - the frozen game world stays visible underneath.
function drawArrival() {
  const t = game.arrival ? game.arrival.elapsed : 0;

  ctx.fillStyle = "rgba(4, 13, 20, 0.72)";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const introProgress = clamp(t / 0.5, 0, 1);
  const eased = 1 - Math.pow(1 - introProgress, 3);
  const bob = introProgress >= 1 ? Math.sin(t * 2.1) * 4 : 0;

  ctx.save();
  ctx.textAlign = "center";

  ctx.translate(WIDTH / 2, HEIGHT / 2 - 50 + (1 - eased) * 30 + bob);
  ctx.scale(0.7 + eased * 0.3, 0.7 + eased * 0.3);
  ctx.globalAlpha = eased;
  ctx.fillStyle = "#ffe27a";
  ctx.font = "bold 66px Segoe UI";
  ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
  ctx.shadowBlur = 12;
  ctx.fillText("HARBOUR REACHED", 0, 0);
  ctx.restore();

  ctx.save();
  ctx.textAlign = "center";
  ctx.globalAlpha = eased;
  ctx.fillStyle = "#eaf7ff";
  ctx.font = "20px Segoe UI";
  ctx.fillText("New waters ahead \u2014 fresh hazards, storms, and sea creatures", WIDTH / 2, HEIGHT / 2 + 20);

  // The prompt appears once the arrival music has finished.
  if (arrivalReady()) {
    const promptBlink = 0.45 + 0.55 * Math.sin(t * 5.2);
    ctx.globalAlpha = eased * promptBlink;
    ctx.fillStyle = "#bfe9ff";
    ctx.font = "18px Segoe UI";
    ctx.fillText(TOUCH_UI ? "Tap to continue" : "Press any key to continue", WIDTH / 2, HEIGHT / 2 + 58);
  }
  ctx.restore();
}

// True once the arrival music has finished (real time, so time spent in
// another window counts).
function arrivalReady() {
  return !game.arrival || performance.now() >= (game.arrival.readyAt || 0);
}

function openExitConfirm() {
  game.exitConfirm = { choice: 1 }; // safe default: keep sailing
  keys.clear(); // don't keep sailing on keys held when Esc was pressed
  playUiClick();
}

function closeExitConfirm(leave) {
  game.exitConfirm = null;
  if (leave) {
    playUi("ui_back", { type: "triangle", from: 700, to: 420, dur: 0.12, peak: 0.09 });
    commitRoundScores(); // points earned so far are kept
    gameState = "menu";
    stopLookout();
  } else {
    playUi("ui_confirm", { type: "triangle", from: 660, to: 990, dur: 0.14, peak: 0.1 });
  }
}

function handleExitConfirmKey(code) {
  const box = game.exitConfirm;
  if (code === "Escape" || code === "KeyN") closeExitConfirm(false);
  else if (code === "KeyY") closeExitConfirm(true);
  else if (code === "Enter" || code === "Space") closeExitConfirm(box.choice === 0);
  else if (["ArrowLeft", "ArrowRight", "Tab", "KeyA", "KeyD"].includes(code)) {
    box.choice = 1 - box.choice;
    playUi("ui_move", { type: "triangle", from: 900, dur: 0.05, peak: 0.08 });
  }
}

function drawExitConfirm() {
  const box = game.exitConfirm;
  if (!box) return;
  if (gameState !== "playing") {
    game.exitConfirm = null;
    return;
  }
  clearUiRects(); // only the popup's buttons can be clicked while it's open
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "rgba(2, 10, 18, 0.6)";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const w = 660;
  const h = 260;
  const x = (WIDTH - w) / 2;
  const y = (HEIGHT - h) / 2;
  ctx.fillStyle = "rgba(9, 26, 40, 0.97)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(186, 234, 255, 0.55)";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.textAlign = "center";
  ctx.fillStyle = "#e9f8ff";
  ctx.font = "bold 34px Segoe UI";
  ctx.fillText("Leave this voyage?", WIDTH / 2, y + 52);
  ctx.font = "20px Segoe UI";
  ctx.fillStyle = "#a9cbe0";
  ctx.fillText("The game is paused. Points earned so far are kept.", WIDTH / 2, y + 90);
  const buttons = [
    { label: "Return to Menu", leave: true },
    { label: "Keep Sailing", leave: false }
  ];
  buttons.forEach((b, i) => {
    const bw = 290;
    const bh = 90;
    const bx = WIDTH / 2 - bw - 14 + i * (bw + 28);
    const by = y + 116;
    const selected = box.choice === i;
    ctx.fillStyle = i === 0 ? "rgba(110, 40, 34, 0.92)" : "rgba(24, 92, 70, 0.92)";
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = selected ? "#ffd182" : "rgba(194, 227, 255, 0.4)";
    ctx.lineWidth = selected ? 3 : 1.5;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = "#f3fbff";
    ctx.font = "bold 26px Segoe UI";
    ctx.fillText(b.label, bx + bw / 2, by + 55);
    registerUiRect(bx, by, bw, bh, () => closeExitConfirm(b.leave));
  });
  ctx.font = "14px Segoe UI";
  ctx.fillStyle = "#8fb4c8";
  if (!TOUCH_UI) ctx.fillText("Arrow keys to choose, Enter to confirm, Esc to keep sailing", WIDTH / 2, y + h - 16);
  ctx.restore();
}

function handlePointerInteraction(clientX, clientY) {
  ensureAudio();
  const rect = canvas.getBoundingClientRect();
  // The canvas uses object-fit: contain, so the drawing is letterboxed inside
  // the element box; map clicks through the fitted area, not the whole box.
  const scale = Math.min(rect.width / WIDTH, rect.height / HEIGHT);
  const offsetX = (rect.width - WIDTH * scale) / 2;
  const offsetY = (rect.height - HEIGHT * scale) / 2;
  const x = (clientX - rect.left - offsetX) / scale;
  const y = (clientY - rect.top - offsetY) / scale;
  const hit = hitUiRect(x, y);
  if (hit) {
    playUiClick();
    hit.onClick();
  }
  return !!hit;
}

// Frame times averaged over the last few frames. When frames arrive
// unevenly (a slow graphics chip on a very wide screen: 6 ms, then 76 ms),
// moving the world by each raw frame time makes the motion stutter.
let smoothDt = 1 / 60;
const FRAME_DT_BAND = [0.6, 1.4]; // a frame's time may differ this much from the average
let frameDebt = 0; // seconds owed to (or ahead of) the clock from evened-out frames
const SIM_STEP_MAX = 0.05; // seconds: the longest single simulation step (each costs ~7 ms on a budget phone)
// Slowdowns tuned per frame at 60 fps, applied per second of game time so
// every frame rate gets the same: keepPer60(0.986, dt) = 0.986 per 1/60 s.
function keepPer60(factor, dt) {
  return Math.pow(factor, dt * 60);
}

// The intro (index.html #loading) stays up until the 3D view has started and
// frames come smoothly (the first 3D frames can take several seconds on a
// phone) and its text has been shown; a key or tap skips the rest of it once
// the game is ready. It counts as ready after LOADING_MAX_MS whatever happens,
// but it never goes before the licence agreement is accepted.
const LOADING_SMOOTH_FRAMES = 20;
const LOADING_SLOW_FRAME = 0.25; // seconds
const LOADING_MAX_MS = 60000; // room for the first-start graphics check on a slow device
const INTRO_MS = 7500; // the last intro line has then been up for a couple of seconds
let loadingSmoothFrames = 0;
let introReady = false;
let introSkipped = false;

function setLoadingStatus(text) {
  document.getElementById("loadingStatus").textContent = text;
}

// The licence agreement (index.html #eula) is on the intro until accepted.
// Once accepted it is never shown again, also after game updates.
const EULA_KEY = "harbour-run-eula";
let eulaAccepted = localStorage.getItem(EULA_KEY) !== null;
document.body.classList.toggle("eula-pending", !eulaAccepted);
// Focus the text, not a button, so a stray key press can't accept it.
if (!eulaAccepted) document.getElementById("eulaText").focus();

function readyStatus() {
  if (!eulaAccepted) return "Ready - accept the agreement to play";
  return TOUCH_UI ? "Ready - tap to continue" : "Ready - press any key to continue";
}

// This click also reaches the intro's own handler (skipIntro), so a game that
// is already loaded starts at once.
document.getElementById("eulaAccept").addEventListener("click", () => {
  localStorage.setItem(EULA_KEY, "accepted");
  eulaAccepted = true;
  document.body.classList.remove("eula-pending");
  if (introReady) setLoadingStatus(readyStatus());
});

// The Android app closes; a browser page can't close itself, so it stays here.
document.getElementById("eulaDecline").addEventListener("click", () => {
  document.getElementById("eulaNote").textContent = "You can't play without accepting. If you do not agree, close the game.";
  exitApp();
});

function updateLoadingScreen(now, rawDt) {
  if (document.body.classList.contains("loaded")) return;
  loadingSmoothFrames = view3d.startupDone && rawDt < LOADING_SLOW_FRAME ? loadingSmoothFrames + 1 : 0;
  if (!introReady && (loadingSmoothFrames >= LOADING_SMOOTH_FRAMES || now > LOADING_MAX_MS)) {
    introReady = true;
    setLoadingStatus(readyStatus());
    ensureAudio();
    playIntro(); // the music starts once the intro has loaded, not during loading
  }
  if (introReady && eulaAccepted && (introSkipped || now >= INTRO_MS)) document.body.classList.add("loaded");
}

function skipIntro() {
  ensureAudio(); // the first key or tap also starts the intro music
  if (introReady) introSkipped = true;
}

document.getElementById("loading").addEventListener("click", skipIntro);

function tick(now) {
  const rawDt = Math.min(0.1, Math.max(0, (now - lastTime) / 1000));
  lastTime = now;
  updateLoadingScreen(now, rawDt);
  smoothDt += (rawDt - smoothDt) * 0.15;
  // Each frame moves the world by its real duration, so motion stays on the
  // clock when frames alternate (a phone at 66 ms, 66 ms, 83 ms: moving by
  // the average made the ship hesitate on every long frame). Only erratic
  // timings (6 ms then 76 ms on a slow graphics chip) are evened out, and
  // the difference is carried to the next frames, so game time still equals
  // real time.
  const owed = rawDt + frameDebt;
  const frameDt = clamp(owed, smoothDt * FRAME_DT_BAND[0], smoothDt * FRAME_DT_BAND[1]);
  frameDebt = clamp(owed - frameDt, -0.1, 0.1);
  // The game runs in real time on every device: a slow frame (a phone at
  // 17 fps) is simulated in several steps no longer than SIM_STEP_MAX, so
  // ships, pirates and timers move as they do on a 60 fps desktop.
  // The number of steps follows the steady average, not this frame, so the
  // work per frame stays even (a long frame doesn't make the next one long).
  const steps = Math.ceil(smoothDt / SIM_STEP_MAX);
  const dt = frameDt / steps;

  if (gameState === "arrival" && game.arrival) {
    game.arrival.elapsed += frameDt;
  }

  // Counts down on every screen (shop messages too), not just while sailing.
  game.uiMessageTtl = Math.max(0, game.uiMessageTtl - frameDt);
  if (game.uiMessageTtl === 0) {
    game.uiMessage = "";
  }

  // The world stays frozen while the cannon cinematic plays or the exit
  // popup is open.
  if (game.cannonCinematic) {
    updateCannonCinematic(frameDt);
  } else if (((game.exitConfirm || game.tugOffer) && gameState === "playing") || eraLoading()) {
    // paused
  } else {
    for (let i = 0; i < steps; i += 1) {
      updateNature(dt);
      handleGameLogic(dt);
    }
  }
  updateSound(frameDt);
  updateHarbourScene();
  // 3D first, so labels on the 2D layer use this frame's camera.
  if (view3d.active) view3d.render(frameDt);
  render();
  drawCannonCinematic();
  drawExitConfirm();
  drawTugOffer();

  requestAnimationFrame(tick);
}

// On menu screens player 1's movement keys (W A S D unless rebound) work
// like the arrow keys, so they move the selection as well as tick.
const MENU_ARROW_FOR_ACTION = { p1Forward: "ArrowUp", p1Backward: "ArrowDown", p1Left: "ArrowLeft", p1Right: "ArrowRight" };

function menuArrowFor(code) {
  for (const [action, arrow] of Object.entries(MENU_ARROW_FOR_ACTION)) {
    if (game.settings.keybinds[action] === code) return arrow;
  }
  return null;
}

// Everything on a menu screen a key press can change; if none of it changes,
// the key did nothing and makes no sound.
function menuSnapshot() {
  return JSON.stringify([
    gameState, mode, game.menuIndex, game.shopIndex, game.shopSlot, game.endedIndex,
    game.shipSelectSlot, game.shipSelections, game.keyRebindAction, game.settings,
    game.uiMessage, game.uiMessageTtl, game.profiles, store.busy, game.crewView, game.voyageIndex, game.missionIndex
  ]);
}

window.addEventListener("keydown", (e) => {
  if (!document.body.classList.contains("loaded")) {
    skipIntro(); // still on the intro: the key does nothing else
    return;
  }
  const inMenu = gameState !== "playing" && gameState !== "arrival" && !game.keyRebindAction;
  const arrow = inMenu ? menuArrowFor(e.code) : null;
  const code = arrow || e.code;
  const before = inMenu ? menuSnapshot() : null;
  handleKeyDown(arrow ? { code, repeat: e.repeat, preventDefault: () => e.preventDefault() } : e);
  if (before !== null && (!e.repeat || code.startsWith("Arrow")) && menuSnapshot() !== before) playMenuKey(code);
});

function handleKeyDown(e) {
  ensureAudio();
  // While the rename popup is open, keys only type into it.
  if (!renamePopup.hidden) {
    if (e.code === "Escape") closeRenamePopup(false);
    return;
  }
  const blockScrollKeys = new Set([
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Space",
    "Enter",
    "Tab",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    "KeyH",
    "Slash",
    "KeyR",
    "Comma"
  ]);
  for (const code of Object.values(game.settings.keybinds)) {
    blockScrollKeys.add(code);
  }
  if (blockScrollKeys.has(e.code)) {
    e.preventDefault();
  }

  if (game.keyRebindAction) {
    e.preventDefault();
    for (const [action, code] of Object.entries(game.settings.keybinds)) {
      if (action !== game.keyRebindAction && code === e.code) {
        game.settings.keybinds[action] = "";
      }
    }
    game.settings.keybinds[game.keyRebindAction] = e.code;
    saveSettings();
    setUiMessage(`${KEYBIND_LABELS[game.keyRebindAction]} set to ${keyName(e.code)}`);
    game.keyRebindAction = null;
    return;
  }


  if (game.exitConfirm) {
    handleExitConfirmKey(e.code);
    return;
  }
  if (game.tugOffer) {
    handleTugOfferKey(e.code);
    return;
  }
  if (e.code === "Escape" && gameState === "playing" && !game.cannonCinematic) {
    openExitConfirm();
    return;
  }
  if (gameState === "arrival" && !arrivalReady()) {
    return; // still playing the arrival music
  }
  keys.add(e.code);

  if (gameState === "arrival") {
    gameState = "playing";
    game.arrival = null;
    return;
  }

  if (gameState === "voyage" || gameState === "missions") {
    handleVoyageKey(e.code);
    return;
  }

  if (gameState === "crew") {
    if (e.code === "Backspace") e.preventDefault();
    handleCrewKey(e.code);
    return;
  }

  if (e.code === "Digit1" && gameState === "menu") {
    mode = "single";
    openVoyageChoice();
    return;
  }
  if (e.code === "Digit2" && gameState === "menu") {
    mode = "local";
    openVoyageChoice();
    return;
  }
  if (e.code === "Enter" && gameState === "menu") {
    getMenuButtons()[game.menuIndex].action();
    return;
  }
  if (gameState === "ended") {
    const last = getEndButtons().length - 1;
    if (e.code === "ArrowLeft") game.endedIndex = clamp(game.endedIndex - 1, 0, last);
    if (e.code === "ArrowRight") game.endedIndex = clamp(game.endedIndex + 1, 0, last);
    if (e.code === "Escape") gameState = "menu";
    if (e.code === "Enter") {
      getEndButtons()[game.endedIndex].action();
      return;
    }
  }

  if (e.code === "KeyK" && gameState === "menu") {
    gameState = "settings";
  }

  if (gameState === "menu") {
    if (e.code === "ArrowLeft") moveMenuSelection(-1);
    if (e.code === "ArrowRight") moveMenuSelection(1);
    if (e.code === "ArrowUp" && game.menuIndex === 0) moveMenuSelection(1);
    if (e.code === "ArrowDown") game.menuIndex = 0;
    if (e.code === "KeyO") {
      openShop("p1");
    }
    if (e.code === "KeyM") {
      openCrewScreen("p1");
    }
    if (e.code === "KeyL") {
      gameState = "leaderboard";
    }
    if (e.code === "KeyN") {
      e.preventDefault(); // or the "n" is typed into the popup
      renameShopProfile();
    }
    if (e.code === "KeyP") {
      togglePremiumPackForTesting();
    }
  }

  if (gameState === "settings" && !game.keyRebindAction && e.code === "KeyG") {
    cycleGraphicsMode();
  }
  if (gameState === "settings" && !game.keyRebindAction && e.code === "KeyV") {
    cycleSoundLevel();
  }
  if (gameState === "settings" && !game.keyRebindAction && e.code === game.settings.keybinds.nightMode) {
    toggleNightMode();
  }

  if (gameState === "settings") {
    if (e.code === "Escape") {
      game.keyRebindAction = null;
      gameState = "menu";
    }
  }

  if (gameState === "premium") {
    if (e.code === "Escape") closePremiumScreen();
    if (e.code === "Enter") purchasePremiumPack(game.premiumPackId);
    if (e.code === "KeyT") devTogglePremiumPack(game.premiumPackId);
    return;
  }

  if (gameState === "shipSelect") {
    if (e.code === "Escape") cancelShipSelect();
    if (e.code === "ArrowLeft") cycleShipSelection(-1);
    if (e.code === "ArrowRight") cycleShipSelection(1);
    if (e.code === "Tab") {
      e.preventDefault();
      if (mode === "local" && !game.midGameChange) {
        game.shipSelectSlot = game.shipSelectSlot === "p1" ? "p2" : "p1";
      }
    }
    if (e.code === "KeyO" && !game.midGameChange) {
      openShop(game.shipSelectSlot);
    }
    if (e.code === "KeyM" && !game.midGameChange) {
      const picked = getShipDefinition(game.shipSelections[game.shipSelectSlot]);
      if (isShipOwned(getProfile(game.shipSelectSlot), picked)) openCrewScreen(game.shipSelectSlot, picked.id, "shipSelect");
      else setUiMessage(`${picked.name} is not yours yet, so it has no crew`);
    }
    if (e.code === "Enter") confirmShipSelectionAndStart();
  }

  if (gameState === "shop") {
    if (e.code === "Escape") gameState = "menu";
    else if (dockLoading()) return;
    else if (dockClipPlaying()) skipDockClip();
    else {
      if (e.code.startsWith("Arrow")) {
        e.preventDefault();
        moveShopSelection(e.code);
      }
      if (e.code === "Tab") {
        e.preventDefault();
        switchShopSlot(game.shopSlot === "p1" ? "p2" : "p1");
      }
      if (e.code === "Enter") buySelectedItem();
      if (e.code === "Backspace") {
        e.preventDefault();
        sellSelectedItem();
      }
      if (e.code === "KeyN") {
        e.preventDefault();
        renameShopProfile();
      }
      if (e.code === "KeyV") game.dock.hideUi = !game.dock.hideUi;
      if (e.code === "KeyP") togglePremiumPackForTesting();
    }
  }

  if (gameState === "leaderboard") {
    if (e.code === "Escape") {
      gameState = "menu";
    }
    if (e.code === "KeyC") {
      clearLeaderboardScores();
    }
    if (e.code === "Digit1") {
      clearPlayerPoints("p1");
    }
    if (e.code === "Digit2") {
      clearPlayerPoints("p2");
    }
  }

  if (gameState === "playing") {
    const kb = game.settings.keybinds;
    const is = (action) => !!kb[action] && e.code === kb[action];
    if (is("cameraView")) toggleCameraView();
    if (is("nightMode")) toggleNightMode();
    // + and - size the corner map, unless a captain has bound that key
    if (!Object.values(kb).includes(e.code)) {
      if (e.code === "Equal" || e.code === "NumpadAdd") resizeMiniMap(1);
      if (e.code === "Minus" || e.code === "NumpadSubtract") resizeMiniMap(-1);
    }
    // not on key repeat, or holding the key flips the bridge camera back and forth
    if (is("p1Bridge") && !e.repeat && game.settings.cameraView === "bridge") toggleBridgeFocus("p1");
    if (is("p2Bridge") && !e.repeat && mode === "local" && game.settings.cameraView === "bridge") toggleBridgeFocus("p2");
    if (is("p1Repair") && game.player1) attemptRepairForSlot("p1");
    if (is("p2Repair") && mode === "local" && game.player2) attemptRepairForSlot("p2");
    if (is("p1Anchor")) toggleAnchor("p1");
    if (is("p2Anchor") && mode === "local") toggleAnchor("p2");
    if (is("p1Tow")) toggleTow("p1");
    if (is("p2Tow") && mode === "local") toggleTow("p2");
    if (is("p1Fire")) extinguishFireForSlot("p1");
    if (is("p2Fire") && mode === "local") extinguishFireForSlot("p2");
    if (is("p1Deterrent")) soundDeterrentForSlot("p1");
    if (is("p2Deterrent") && mode === "local") soundDeterrentForSlot("p2");

    if (e.code === game.settings.keybinds.p1Attack && mode === "single" && game.player1) {
      attack(game.player1, pickAttackTarget(game.player1, game.ai));
    }
    if (e.code === game.settings.keybinds.p1Attack && mode === "local" && game.player1) {
      attack(game.player1, pickAttackTarget(game.player1, game.player2));
    }
    if (e.code === game.settings.keybinds.p2Attack && mode === "local" && game.player2) {
      attack(game.player2, pickAttackTarget(game.player2, game.player1));
    }
  }
}

window.addEventListener("keyup", (e) => {
  keys.delete(e.code);
});

// Bridge view: hold the right mouse button and drag to look around from the
// bridge, like turning your head. Only the view turns; the ship's heading and
// steering are untouched. A right click without dragging looks back over the
// bow. In split screen the drag turns the view of the half it starts in.
const BRIDGE_LOOK_PER_PIXEL = 0.005; // radians
const BRIDGE_LOOK_YAW_MAX = 2.8; // about 160 degrees either side
const BRIDGE_LOOK_PITCH = [-1, 0.6]; // down, up (radians)
const bridgeLook = { p1: { yaw: 0, pitch: 0 }, p2: { yaw: 0, pitch: 0 } };
// Navigation-screen button: false = inside the bridge (console, screens, chairs), true = the
// view glides to the plain window view (render3d.js bridgeBlend). Per player (split screen).
const bridgeFocus = { p1: false, p2: false };
function toggleBridgeFocus(slot) {
  bridgeFocus[slot] = !bridgeFocus[slot];
}

let lookDrag = null;
let orbitDrag = null; // { x, y }: dragging the overview / chase camera round

function resetBridgeLook() {
  for (const look of Object.values(bridgeLook)) {
    look.yaw = 0;
    look.pitch = 0;
  }
}

function bridgeSlotAt(clientX) {
  const rect = canvas.getBoundingClientRect();
  return view3d.split ? (clientX - rect.left > rect.width / 2 ? "p2" : "p1") : soloViewShip() === game.player2 ? "p2" : "p1";
}

function turnBridgeLook(slot, dx, dy) {
  const look = bridgeLook[slot];
  look.yaw = clamp(look.yaw + dx * BRIDGE_LOOK_PER_PIXEL, -BRIDGE_LOOK_YAW_MAX, BRIDGE_LOOK_YAW_MAX);
  look.pitch = clamp(look.pitch - dy * BRIDGE_LOOK_PER_PIXEL, BRIDGE_LOOK_PITCH[0], BRIDGE_LOOK_PITCH[1]);
}

// Touch (phones, tablets) while sailing: one finger dragged across the sea
// looks around on the bridge, like the right mouse button; two fingers pinch
// to zoom, like the mouse wheel. A touch that hardly moves is a tap: it
// presses the HUD's buttons, and on the bridge a tap on open sea looks ahead
// again. The on-screen stick and buttons are separate, so they keep working.
const TOUCH_TAP_MOVE = 10; // CSS pixels a finger may wander and still tap
const touchPoints = new Map(); // pointerId -> { x, y }
let touchGesture = null; // { moved, pinchDist }

function touchPinchDistance() {
  const [a, b] = touchPoints.values();
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function moveTouch(point, e) {
  const dx = e.clientX - point.x;
  const dy = e.clientY - point.y;
  point.x = e.clientX;
  point.y = e.clientY;
  touchGesture.moved += Math.abs(dx) + Math.abs(dy);
  if (touchPoints.size >= 2) {
    const dist = touchPinchDistance();
    const [a, b] = touchPoints.values();
    if (touchGesture.pinchDist > 0 && dist > 0) zoomView(touchGesture.pinchDist / dist, (a.x + b.x) / 2, (a.y + b.y) / 2); // spread = closer
    touchGesture.pinchDist = dist;
  } else if (view3d.active && game.settings.cameraView === "bridge" && gameState === "playing") {
    turnBridgeLook(bridgeSlotAt(e.clientX), dx, dy);
  } else {
    orbitView(dx, dy);
  }
}

function endTouch(e, tap) {
  if (!touchPoints.delete(e.pointerId)) return false;
  touchGesture.pinchDist = touchPoints.size >= 2 ? touchPinchDistance() : 0;
  if (tap && touchPoints.size === 0 && touchGesture.moved < TOUCH_TAP_MOVE) {
    if (!handlePointerInteraction(e.clientX, e.clientY) && view3d.active && game.settings.cameraView === "bridge" && gameState === "playing") {
      const look = bridgeLook[bridgeSlotAt(e.clientX)];
      look.yaw = 0;
      look.pitch = 0;
    }
  }
  return true;
}

canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  const sailingOrbit = gameState === "playing" && view3d.active && game.settings.cameraView !== "bridge";
  if (e.pointerType !== "touch" && (sailingOrbit || (e.button === 2 && onMenuShip()))) {
    // Overview, chase and main menu: the mouse (either button) drags the camera round.
    orbitDrag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    if (e.button === 2) return;
  }
  if (e.button === 2) {
    if (!view3d.active || game.settings.cameraView !== "bridge" || gameState !== "playing") return;
    lookDrag = { slot: bridgeSlotAt(e.clientX), x: e.clientX, y: e.clientY, moved: 0 };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (gameState === "arrival") {
    pressVirtualKey("Enter"); // a tap works like "press any key"
    releaseVirtualKey("Enter");
    return;
  }
  if (e.pointerType === "touch" && (gameState === "playing" || onMenuShip())) {
    canvas.setPointerCapture(e.pointerId);
    if (touchPoints.size === 0) touchGesture = { moved: 0, pinchDist: 0 };
    touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchPoints.size >= 2) {
      touchGesture.moved = Infinity; // a pinch is never a tap
      touchGesture.pinchDist = touchPinchDistance();
    }
    return;
  }
  if (!handlePointerInteraction(e.clientX, e.clientY) && onMenuShip()) {
    orbitDrag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  }
});

canvas.addEventListener("pointermove", (e) => {
  const point = touchPoints.get(e.pointerId);
  if (point) {
    moveTouch(point, e);
    return;
  }
  if (orbitDrag) {
    orbitView(e.clientX - orbitDrag.x, e.clientY - orbitDrag.y);
    orbitDrag.x = e.clientX;
    orbitDrag.y = e.clientY;
    return;
  }
  if (!lookDrag) return;
  const dx = e.clientX - lookDrag.x;
  const dy = e.clientY - lookDrag.y;
  lookDrag.x = e.clientX;
  lookDrag.y = e.clientY;
  lookDrag.moved += Math.abs(dx) + Math.abs(dy);
  turnBridgeLook(lookDrag.slot, dx, dy);
});

canvas.addEventListener("pointerup", (e) => {
  if (endTouch(e, true)) return;
  orbitDrag = null;
  if (!lookDrag || e.button !== 2) return;
  if (lookDrag.moved < 4) {
    bridgeLook[lookDrag.slot].yaw = 0;
    bridgeLook[lookDrag.slot].pitch = 0;
  }
  lookDrag = null;
});

canvas.addEventListener("pointercancel", (e) => endTouch(e, false));
// Every finger is captured on its way down, so this always arrives at its end,
// even if its pointerup went missing; a finger is never left stuck "down".
canvas.addEventListener("lostpointercapture", (e) => {
  orbitDrag = null;
  endTouch(e, false);
});

// No browser menu on right click: the right button looks around on the bridge.
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// On-screen controls (touch screens). Each button acts like pressing its key,
// so the game behaves exactly as with a keyboard. The stick moves player 1
// with whatever keys player 1's movement is bound to.
function pressVirtualKey(code) {
  handleKeyDown({ code, repeat: false, preventDefault() {} });
}

function releaseVirtualKey(code) {
  keys.delete(code);
}

for (const button of document.querySelectorAll("#touchControls button")) {
  let held = null;
  const release = () => {
    if (held) releaseVirtualKey(held);
    held = null;
    button.classList.remove("pressed");
  };
  button.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    button.setPointerCapture(e.pointerId);
    held = button.dataset.code || game.settings.keybinds[button.dataset.action];
    button.classList.add("pressed");
    pressVirtualKey(held);
  });
  button.addEventListener("pointerup", release);
  button.addEventListener("lostpointercapture", release);
}

const TOUCH_STICK_DEADZONE = 0.35; // fraction of the stick's radius
const TOUCH_STICK_KEYS = { p1Forward: [0, -1], p1Backward: [0, 1], p1Left: [-1, 0], p1Right: [1, 0] };
const touchStick = document.getElementById("tcStick");
const touchKnob = document.getElementById("tcKnob");

function setTouchStick(clientX, clientY) {
  const rect = touchStick.getBoundingClientRect();
  const radius = rect.width / 2;
  let dx = (clientX - rect.left - radius) / radius;
  let dy = (clientY - rect.top - radius) / radius;
  const length = Math.hypot(dx, dy);
  if (length > 1) {
    dx /= length;
    dy /= length;
  }
  touchKnob.style.transform = `translate(${dx * radius * 0.6}px, ${dy * radius * 0.6}px)`;
  for (const [action, [ax, ay]] of Object.entries(TOUCH_STICK_KEYS)) {
    const code = game.settings.keybinds[action];
    if (!code) continue;
    if (dx * ax + dy * ay > TOUCH_STICK_DEADZONE) keys.add(code);
    else keys.delete(code);
  }
}

function releaseTouchStick() {
  touchKnob.style.transform = "";
  for (const action of Object.keys(TOUCH_STICK_KEYS)) keys.delete(game.settings.keybinds[action]);
}

touchStick.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  ensureAudio();
  touchStick.setPointerCapture(e.pointerId);
  setTouchStick(e.clientX, e.clientY);
});
touchStick.addEventListener("pointermove", (e) => {
  if (touchStick.hasPointerCapture(e.pointerId)) setTouchStick(e.clientX, e.clientY);
});
touchStick.addEventListener("pointerup", releaseTouchStick);
touchStick.addEventListener("lostpointercapture", releaseTouchStick);

// A phone browser allows sound only once a finger is lifted (not when it
// touches down, where the other handlers call ensureAudio), so start it then.
window.addEventListener("pointerup", ensureAudio, true);

// Called by the Android app (android/src/main/java/.../MainActivity.java).
window.harbourAndroid = {
  // Phone Back button: works like Esc. Returns false on the main menu, where
  // the app closes instead.
  back() {
    if (gameState === "menu" && !game.exitConfirm && renamePopup.hidden) return false;
    pressVirtualKey("Escape");
    releaseVirtualKey("Escape");
    return true;
  },
  // App sent to the background: pause the voyage and silence the sound.
  pause() {
    if (gameState === "playing" && !game.exitConfirm && !game.cannonCinematic) openExitConfirm();
    if (game.audioContext) game.audioContext.suspend();
  },
  resume() {
    if (game.audioContext) game.audioContext.resume();
  }
};

// Overview and chase views: the mouse wheel zooms in on your ship and back
// out (1 = the standard view). The bridge view stays where the captain stands.
const VIEW_ZOOM_LIMITS = { overview: [0.012, 1.6], chase: [0.05, 2.5] };
const viewZoom = { overview: 1, chase: 1 };
// Where the last wheel turn or pinch pointed: zoomed in close, the camera
// closes on that spot of the ship (render3d.js closeUp).
const zoomAim = { x: 0, y: 0 };

// Overview and chase views: dragging turns the camera round the ship (left
// and right) and up and down, any direction in between. Changing the camera
// view with C puts it back. render3d.js reads these (applyViewOrbit).
const viewOrbit = { yaw: 0, pitch: 0 };
const VIEW_ORBIT_PER_PIXEL = 0.006;

// Main menu: dragging turns the view round the moored ship and the wheel (or a
// pinch) zooms on it. render3d.js reads these (harbourWant).
const menuView = { yaw: 0, pitch: 0, zoom: 1, touched: false };
const MENU_ZOOM_LIMITS = [0.05, 2.2];
const MENU_PITCH_LIMITS = [-0.2, 1.2]; // radians from the standard view: sea level to high above

function onMenuShip() {
  return view3d.active && gameState === "menu" && !!game.harbourShip;
}

function orbitView(dx, dy) {
  if (onMenuShip()) {
    menuView.touched = true;
    menuView.yaw += dx * VIEW_ORBIT_PER_PIXEL;
    menuView.pitch = clamp(menuView.pitch + dy * VIEW_ORBIT_PER_PIXEL, ...MENU_PITCH_LIMITS);
    return;
  }
  if (!view3d.active || game.settings.cameraView === "bridge" || gameState !== "playing") return;
  viewOrbit.yaw += dx * VIEW_ORBIT_PER_PIXEL;
  viewOrbit.pitch = clamp(viewOrbit.pitch + dy * VIEW_ORBIT_PER_PIXEL, -1.5, 1.5);
}

// factor above 1 moves out, below 1 moves in; (x, y) is where on screen.
function zoomView(factor, x, y) {
  zoomAim.x = x;
  zoomAim.y = y;
  if (onMenuShip()) {
    menuView.touched = true;
    menuView.zoom = clamp(menuView.zoom * factor, ...MENU_ZOOM_LIMITS);
    return;
  }
  const view = game.settings.cameraView;
  if (!view3d.active || !VIEW_ZOOM_LIMITS[view]) return;
  const [near, far] = VIEW_ZOOM_LIMITS[view];
  viewZoom[view] = clamp(viewZoom[view] * factor, near, far);
}

window.addEventListener("wheel", (e) => {
  if (e.target.closest?.(".eula-text")) return; // the agreement scrolls
  e.preventDefault();
  if (gameState !== "playing" && gameState !== "arrival" && gameState !== "menu") return;
  zoomView(Math.exp(e.deltaY * 0.0012), e.clientX, e.clientY);
}, { passive: false });

window.addEventListener("touchmove", (e) => {
  if (e.target.closest?.(".eula-text")) return; // the agreement scrolls
  e.preventDefault();
}, { passive: false });

// The Android app carries its files inside the APK, so it needs no offline cache.
if ("serviceWorker" in navigator && !IS_ANDROID_APP) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      // Ignore offline cache registration errors during local development.
    });
  });
}

game.profiles = loadProfiles();
game.settings = loadSettings();
initStore();
// Closing the page mid-voyage keeps the crew's experience.
window.addEventListener("pagehide", crewFlush);
requestAnimationFrame(tick);
