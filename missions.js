// Missions: after choosing Set Sail (or Two Captains) the captain picks Free
// Play (the open sea, crossing after crossing) or a mission. A mission has its
// own waters (rivers, fjords, island chains), threats and objectives, and ends
// at Harbour B once every objective is done.
//
// Land is described either as `water` (channels cut through land) or as `land`
// (islands in open sea). Both are lists of capsules [x1, y1, x2, y2, r] in map
// coordinates (3600 x 2100, Harbour A bottom left, Harbour B top right).
// terrainDepth() turns them into one thing that collisions, pirate routes, the
// charts and the 3D scenery all read.

const MISSION_HARBOUR_WATER = 640; // open water round each harbour corner
const MISSION_CORNERS = [[0, 2100], [3600, 0]]; // Harbour A, Harbour B

// A mission is a list of `stages` done in order; the last is the way home. A
// stage may ask for `sites` to be visited, `sink` pirates or `subs` to be sunk,
// or a `flagship` to be destroyed, and may have a time `limit` of its own.
// `gates` bar a channel while the stage number is from `from` up to `until`.
// `unsurveyed` circles [x, y, r] are blank on the bridge's electronic chart
// (render3d.js drawChartScreen), as is the corner round Harbour B.
const MISSIONS = [
  {
    id: "lostRiver",
    name: "The Lost River",
    tagline: "A pilot, a locked boom and a river that falls.",
    description: "Your cargo must reach Harbour B through uncharted jungle, but a log boom bars the way to the sea. Only an old river pilot knows where its winch lies. He warns: \"Where the white mist hangs, the river falls.\"",
    stages: [
      { goal: "Find the river pilot at his jungle camp", sites: [{ x: 1560, y: 1890, label: "River pilot", message: "Pilot aboard: \"The winch is up a creek off the misty river. Turn off before the roar!\"" }] },
      { goal: "Open the log boom at its winch", sites: [{ x: 665, y: 505, label: "Boom winch", model: "winch", message: "The log boom swings open!" }] },
      { goal: "Run the jungle to Harbour B", home: true }
    ],
    rules: ["Do not go over the waterfall"],
    plan: [
      "Search the side creeks for the pilot's camp.",
      "Take him to the winch. If you hear a roar, you have gone too far.",
      "Find the boom he has opened: it leads towards the sea.",
      "Some creeks are blind. Crocodiles guard them."
    ],
    style: "jungle",
    unsurveyed: [[1400, 1860, 430], [700, 600, 420], [3050, 1700, 330]],
    water: [
      [330, 1780, 800, 1500, 155],
      [800, 1500, 1150, 1380, 150],
      [1150, 1380, 1450, 1220, 150],
      // the northern arm: over the falls
      [1450, 1220, 1360, 920, 135],
      [1360, 920, 1560, 640, 135],
      [1560, 640, 1450, 330, 135],
      [1450, 330, 1450, 250, 135],
      // the eastern arm: through the jungle to the sea
      [1450, 1220, 1800, 1510, 140],
      [1800, 1510, 2200, 1620, 135],
      [2200, 1620, 2550, 1390, 135],
      [2550, 1390, 2450, 1030, 135],
      [2450, 1030, 2780, 780, 140],
      [2900, 700, 3350, 330, 430],
      // the creek to the pilot's camp
      [900, 1470, 1150, 1770, 115],
      [1150, 1770, 1480, 1880, 110],
      [1480, 1880, 1570, 1890, 170],
      // the winch creek, off the northern arm
      [1400, 1100, 960, 890, 125],
      [960, 880, 700, 560, 110],
      [700, 560, 660, 505, 170],
      // a blind lagoon
      [2550, 1390, 2950, 1620, 105],
      [2950, 1620, 3150, 1700, 190]
    ],
    gates: [{ line: [2270, 1346, 2480, 1664], r: 20, from: 0, until: 2, kind: "logs", hint: "A log boom bars the river - its winch must open it" }],
    falls: { x: 1450, y: 330, dx: 0, dy: -1, halfWidth: 190, reach: 620 },
    hazards: [
      { kind: "island", x: 1010, y: 1370, r: 20 },
      { kind: "island", x: 2010, y: 1640, r: 22 },
      { kind: "island", x: 2540, y: 1210, r: 20 },
      { kind: "island", x: 1420, y: 800, r: 18 },
      { kind: "island", x: 1230, y: 1845, r: 12 },
      { kind: "island", x: 880, y: 740, r: 12 },
      { kind: "volcano", x: 2880, y: 520, r: 66 }
    ],
    crocs: [[1190, 1300], [1700, 1450], [2260, 1560], [2500, 1080], [1420, 830], [1150, 1760], [940, 860], [3050, 1670]],
    fog: [[2230, 1630, 220]],
    storms: 1,
    weather: [],
    wind: 0.35,
    calm: 0.3,
    threats: { raiderCap: 1, raiderInterval: [20, 30], creatureCap: 1, creatureInterval: [18, 28], underwaterCap: 0, underwaterInterval: [30, 40] },
    raiderLife: 30,
    reward: 300
  },
  {
    id: "whitePassage",
    name: "The White Passage",
    tagline: "A sick village and a fjord freezing shut.",
    description: "Fever has broken out in Frost village. Load the serum at the weather station, carry it north and report to Harbour B, all before time runs out. The vials are fragile, and the ice is moving: the way you came may not be open when you leave.",
    stages: [
      { goal: "Load the serum at the weather station", sites: [{ x: 2760, y: 1800, label: "Weather station", model: "depot", message: "Serum loaded - handle her gently!" }] },
      { goal: "Deliver it to Frost village", sites: [{ x: 480, y: 330, label: "Frost village", model: "depot", message: "Serum delivered. The fjord is freezing shut behind you!" }] },
      { goal: "Report to Harbour B", home: true }
    ],
    minHull: 0.4,
    hullLoss: "the vials were smashed",
    timeLimit: 270,
    plan: [
      "Search the inlets for the station, then the village.",
      "Give every iceberg room: a hard knock breaks the vials.",
      "Pack ice only spares an icebreaker.",
      "If the ice closes your road home, find another."
    ],
    style: "ice",
    polar: true,
    unsurveyed: [[2500, 1840, 420], [520, 400, 380]],
    water: [
      [330, 1780, 950, 1820, 185],
      [950, 1820, 1500, 1650, 180],
      [1500, 1650, 1700, 1250, 190],
      // the long way round
      [1700, 1250, 1350, 750, 185],
      [1350, 750, 1800, 390, 185],
      [1800, 390, 2550, 430, 200],
      [2550, 430, 3220, 340, 185],
      // the short cut
      [1700, 1250, 2400, 1100, 120],
      [2400, 1100, 2900, 650, 120],
      [2900, 650, 3220, 360, 135],
      // the station inlet
      [1500, 1650, 2150, 1860, 140],
      [2150, 1860, 2650, 1820, 130],
      [2650, 1820, 2760, 1800, 200],
      // the village inlet
      [1350, 750, 850, 680, 130],
      [850, 680, 520, 380, 125],
      [520, 380, 480, 330, 200]
    ],
    gates: [{ line: [1426, 383, 1724, 757], r: 30, from: 2, until: 9, kind: "ice", hint: "The long channel has frozen shut - find another way" }],
    hazards: [
      { kind: "iceberg", x: 1520, y: 1000, r: 34 },
      { kind: "iceberg", x: 1480, y: 620, r: 40 },
      { kind: "iceberg", x: 2080, y: 320, r: 36 },
      { kind: "iceberg", x: 2420, y: 520, r: 44 },
      { kind: "iceberg", x: 2900, y: 330, r: 30 },
      { kind: "iceberg", x: 2200, y: 1840, r: 30 },
      { kind: "iceberg", x: 1050, y: 720, r: 26 }
    ],
    // each sheet leaves a clear lane along one side
    ice: [[2150, 1095, 90], [2745, 880, 85], [845, 585, 65]],
    storms: 2,
    weather: ["spout"],
    wind: 0.6,
    calm: 0.55,
    threats: { raiderCap: 0, raiderInterval: [30, 40], creatureCap: 2, creatureInterval: [14, 22], underwaterCap: 1, underwaterInterval: [28, 40] },
    reward: 350
  },
  {
    id: "ringOfFire",
    name: "Ring of Fire",
    tagline: "Four flares, one last errand and the big one.",
    description: "The volcanoes of the Ash Isles have woken. Take four stranded groups of islanders aboard, then save the observatory's records. The scientists fear the great eruption will follow, and lava may cut the sea lanes.",
    stages: [
      {
        goal: "Rescue 4 groups of survivors",
        sites: [
          { x: 1300, y: 1310, label: "Survivors", message: "Survivors safely aboard!" },
          { x: 1800, y: 780, label: "Survivors", message: "Survivors safely aboard!" },
          { x: 2660, y: 1480, label: "Survivors", message: "Survivors safely aboard!" },
          { x: 720, y: 665, label: "Survivors", message: "Survivors safely aboard!" }
        ]
      },
      { goal: "Save the observatory records", sites: [{ x: 2150, y: 1965, label: "Observatory", model: "depot", message: "Records aboard. The mountain is going up - GO!" }] },
      { goal: "Outrun the great eruption: 2:20 to Harbour B", home: true, limit: 140, fury: true }
    ],
    plan: [
      "Gold dots on your map mark the flares. Take them in any order.",
      "Hold your ship slow inside each ring.",
      "Keep clear of the volcanoes: rocks and lava reach far.",
      "When the great eruption starts, find an open way out fast."
    ],
    style: "volcanic",
    unsurveyed: [[720, 665, 300], [2150, 1965, 280]],
    land: [
      [900, 950, 1200, 1050, 210],
      [1750, 1750, 2200, 1700, 160],
      [1950, 550, 2150, 800, 210],
      [2900, 1250, 3050, 1550, 250],
      [500, 450, 850, 300, 230],
      [3350, 1950, 3600, 2100, 260],
      [1500, -100, 1560, 120, 180]
    ],
    gates: [{ line: [2150, 830, 2870, 1230], r: 40, from: 2, until: 9, kind: "lava", hint: "Lava has cut the sea lane - go round" }],
    hazards: [
      { kind: "volcano", x: 1560, y: 1420, r: 66 },
      { kind: "volcano", x: 1420, y: 620, r: 74 },
      { kind: "volcano", x: 2420, y: 1060, r: 78 },
      { kind: "volcano", x: 2500, y: 1880, r: 58 },
      { kind: "volcano", x: 2760, y: 330, r: 56 }
    ],
    storms: 1,
    weather: ["tsunami"],
    wind: 0.8,
    calm: 0.8,
    threats: { raiderCap: 1, raiderInterval: [22, 32], creatureCap: 2, creatureInterval: [13, 20], underwaterCap: 0, underwaterInterval: [30, 40] },
    reward: 400
  },
  {
    id: "pirateStrait",
    name: "The Pirate Strait",
    tagline: "Chains across the strait, and a flagship waiting.",
    description: "Pirates have chained the strait shut. Sink three of their raiders to break open the cove where they hold captured crews, free them, then face the flagship Black Rock Queen. Only her end will lower the chains.",
    stages: [
      { goal: "Sink 3 pirate raiders", sink: 3 },
      { goal: "Free the captured crews in the cove", sites: [{ x: 1830, y: 1925, label: "Captives", message: "Crews freed! \"The Queen is out there - she takes some sinking!\"" }] },
      { goal: "Sink the flagship Black Rock Queen", flagship: { x: 2000, y: 1010, name: "Black Rock Queen" } },
      { goal: "Pass the strait to Harbour B", home: true }
    ],
    plan: [
      "Hunt the raiders in the wide bay; fire first.",
      "A chain guards the cove until the raiders are beaten.",
      "The flagship needs several hits. Repair before you meet her.",
      "Beware the whirlpools while you fight."
    ],
    style: "rock",
    unsurveyed: [[1750, 1830, 380]],
    water: [
      [330, 1780, 900, 1620, 160],
      [900, 1620, 1350, 1250, 155],
      [1350, 1250, 1620, 1100, 190],
      [1620, 1100, 1980, 1040, 370],
      // north pass
      [1850, 900, 2150, 520, 130],
      [2150, 520, 2850, 420, 135],
      [2850, 420, 3220, 350, 155],
      // south pass
      [2150, 1200, 2600, 1450, 135],
      [2600, 1450, 3000, 1100, 135],
      [3000, 1100, 3150, 650, 145],
      [3150, 650, 3260, 380, 155],
      // the pirates' cove
      [1750, 1250, 1520, 1700, 125],
      [1520, 1700, 1700, 1900, 120],
      [1700, 1900, 1830, 1925, 175]
    ],
    gates: [
      { line: [1440, 1460, 1760, 1625], r: 16, from: 0, until: 1, kind: "chain", hint: "A chain bars the cove - sink the raiders first" },
      { line: [2272, 302, 2328, 698], r: 18, from: 0, until: 3, kind: "chain", hint: "The strait is chained while the flagship floats" },
      { line: [2668, 1125, 2932, 1425], r: 18, from: 0, until: 3, kind: "chain", hint: "The strait is chained while the flagship floats" }
    ],
    hazards: [
      { kind: "island", x: 1700, y: 920, r: 34 },
      { kind: "island", x: 1930, y: 1220, r: 28 },
      { kind: "island", x: 2520, y: 420, r: 18 },
      { kind: "island", x: 1560, y: 1760, r: 14 }
    ],
    storms: 1,
    weather: ["whirlpool", "tempest"],
    wind: 0.55,
    calm: 0.5,
    threats: { raiderCap: 1, raiderInterval: [6, 10], creatureCap: 1, creatureInterval: [22, 32], underwaterCap: 0, underwaterInterval: [30, 40] },
    raiderLife: 90,
    reward: 450
  },
  {
    id: "drownedFleet",
    name: "The Drowned Fleet",
    tagline: "A captain's log, heavy gold and a hunter below.",
    description: "A treasure fleet went down in the Mangrove Maze. The captain's log shows the way to the rest. Every hold you raise makes your ship heavier and slower, submarines want the gold, and the swamp is shifting around you.",
    stages: [
      { goal: "Recover the log from the flagship wreck", sites: [{ x: 470, y: 720, label: "Flagship wreck", model: "wreck", message: "The log shows where three more wrecks lie!" }] },
      {
        goal: "Salvage 3 treasure wrecks",
        sites: [
          { x: 2400, y: 1570, label: "Treasure wreck", model: "wreck", weight: 0.07, message: "Gold aboard - she sits lower and slower" },
          { x: 2300, y: 300, label: "Treasure wreck", model: "wreck", weight: 0.07, message: "Gold aboard - she sits lower and slower" },
          { x: 1300, y: 1945, label: "Treasure wreck", model: "wreck", weight: 0.07, message: "Gold aboard - she sits lower and slower" }
        ]
      },
      { goal: "Sink the 2 submarines hunting you", subs: 2 },
      { goal: "Escape with the gold to Harbour B", home: true }
    ],
    plan: [
      "Feel your way through the maze: some channels end blind.",
      "Hold your ship slow inside each ring to raise the cargo.",
      "Face each submarine bow-on and fire when it closes.",
      "Watch for the way out changing, and for crocodiles."
    ],
    style: "swamp",
    unsurveyed: [[470, 720, 330], [2400, 1570, 330], [2300, 300, 330], [1300, 1945, 300]],
    water: [
      [330, 1780, 950, 1700, 140],
      [950, 1700, 950, 1150, 120],
      [950, 1150, 520, 820, 120],
      [520, 820, 480, 730, 200],
      [950, 1150, 1600, 1150, 130],
      [1700, 1150, 1820, 1150, 250],
      [950, 1700, 1650, 1760, 120],
      [1650, 1760, 2200, 1550, 130],
      [2260, 1520, 2380, 1540, 210],
      [1750, 1150, 2300, 1500, 115],
      [1750, 1150, 1650, 550, 120],
      [1650, 550, 2200, 370, 120],
      [2230, 360, 2400, 360, 210],
      [2300, 370, 3150, 330, 140],
      [2300, 1500, 2950, 1150, 125],
      [2950, 1150, 3150, 500, 125],
      [3150, 500, 3270, 330, 150],
      // the southern lagoon
      [1650, 1760, 1380, 1940, 115],
      [1380, 1940, 1300, 1945, 160]
    ],
    gates: [
      { line: [2892, 777, 3208, 873], r: 22, from: 2, until: 9, kind: "logs", hint: "The mangroves have collapsed across the channel - find another way" }
    ],
    hazards: [
      { kind: "island", x: 1760, y: 1050, r: 26 },
      { kind: "island", x: 1300, y: 1750, r: 16 },
      { kind: "island", x: 2750, y: 340, r: 18 }
    ],
    crocs: [[950, 1420], [1300, 1140], [1650, 850], [2640, 1320], [1450, 1890], [2050, 420]],
    fog: [[900, 1200, 260], [1800, 1100, 320], [2350, 380, 260], [2850, 1180, 240], [1400, 1900, 200]],
    storms: 0,
    weather: [],
    wind: 0.3,
    calm: 0.25,
    threats: { raiderCap: 0, raiderInterval: [30, 40], creatureCap: 0, creatureInterval: [30, 40], underwaterCap: 1, underwaterInterval: [18, 28] },
    reward: 500
  }
];

// The rock cave the waterfall hides in: `length` downstream from the lip, as
// wide and high as `half` and `height`, with a mouth of `mouthHalf` by
// `mouthHeight`. The river drops away `drop` units inside the mouth.
const CAVE = { drop: 40, length: 330, half: 250, height: 125, mouthHalf: 165, mouthHeight: 70 };

// How full the cave's rounded hill is `along` units in from the mouth (1 to 0).
function caveRadius(along) {
  return Math.sqrt(Math.max(0, 1 - (along / CAVE.length) ** 3));
}

// A map point measured from the falls: downstream of the lip, and sideways.
function fallsFrame(f, x, y) {
  return { along: (x - f.x) * f.dx + (y - f.y) * f.dy, across: (y - f.y) * f.dx - (x - f.x) * f.dy };
}

function underCave(m, x, y) {
  if (!m.falls) return false;
  const { along, across } = fallsFrame(m.falls, x, y);
  return along > 0 && along < CAVE.length && Math.abs(across) < CAVE.half * caveRadius(along);
}

// Free Play: one steady set of threats, however many crossings you make.
const FREE_PLAY = { islands: 3, icebergs: 2, volcanoes: 1, storms: 2, raiderCap: 2, raiderInterval: [9, 14], creatureCap: 3, creatureInterval: [8, 13], underwaterCap: 2, underwaterInterval: [12, 19], spoutDormant: [5, 10] };

function missionById(id) {
  return MISSIONS.find((m) => m.id === id) || null;
}

// The threats of the voyage in progress.
function voyageThreats() {
  return game.mission ? { spoutDormant: [8, 16], ...game.mission.threats } : FREE_PLAY;
}

// Big weather events: all of them in Free Play, only those a mission lists.
function weatherAllowed(kind) {
  return !game.mission || game.mission.weather.includes(kind);
}

const MISSIONS_KEY = "harbour-run-missions";

function completedMissions() {
  try {
    return JSON.parse(localStorage.getItem(MISSIONS_KEY)) || {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

function segmentDistance(x, y, [ax, ay, bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const k = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - (ax + dx * k), y - (ay + dy * k));
}

// How far a point is from the nearest bank: positive afloat, negative on land.
// The small waves in it make the banks ragged.
function terrainDepthRaw(m, x, y) {
  let depth;
  if (m.water) {
    depth = -Infinity;
    for (const c of m.water) depth = Math.max(depth, c[4] - segmentDistance(x, y, c));
  } else {
    depth = Infinity;
    for (const c of m.land) depth = Math.min(depth, segmentDistance(x, y, c) - c[4]);
  }
  for (const [cx, cy] of MISSION_CORNERS) depth = Math.max(depth, MISSION_HARBOUR_WATER - Math.hypot(x - cx, y - cy));
  return depth + 8 * Math.sin(x * 0.021 + y * 0.013) + 5 * Math.sin(y * 0.037 - x * 0.029) + 3 * Math.sin(x * 0.083 + y * 0.061);
}

const TERRAIN_CELL = 8;
const terrainGrids = {};

// The depth over the whole map, worked out once per mission.
function terrainGrid(m) {
  if (!terrainGrids[m.id]) {
    const cols = Math.ceil(WORLD_W / TERRAIN_CELL) + 1;
    const rows = Math.ceil(WORLD_H / TERRAIN_CELL) + 1;
    const depth = new Float32Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) depth[j * cols + i] = terrainDepthRaw(m, i * TERRAIN_CELL, j * TERRAIN_CELL);
    }
    terrainGrids[m.id] = { cols, rows, depth };
  }
  return terrainGrids[m.id];
}

// Free Play has no mission land: everywhere is deep water.
function terrainDepth(x, y) {
  if (!game.mission) return Infinity;
  const g = terrainGrid(game.mission);
  const fx = Math.max(0, Math.min(g.cols - 1.001, x / TERRAIN_CELL));
  const fy = Math.max(0, Math.min(g.rows - 1.001, y / TERRAIN_CELL));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const tx = fx - i;
  const ty = fy - j;
  const at = j * g.cols + i;
  const top = g.depth[at] + (g.depth[at + 1] - g.depth[at]) * tx;
  const bottom = g.depth[at + g.cols] + (g.depth[at + g.cols + 1] - g.depth[at + g.cols]) * tx;
  let depth = top + (bottom - top) * ty;
  for (const gate of game.missionState?.gates || []) {
    if (gate.closed) depth = Math.min(depth, segmentDistance(x, y, gate.line) - gate.r);
  }
  return depth;
}

// Unit vector from a point towards deeper water.
function terrainOut(x, y) {
  const dx = terrainDepth(x + 8, y) - terrainDepth(x - 8, y);
  const dy = terrainDepth(x, y + 8) - terrainDepth(x, y - 8);
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

// Where a point is relative to the waterfall: `along` past the lip (positive =
// over it), or null away from the falls' stretch of river.
function fallsAt(x, y) {
  const f = game.mission && game.mission.falls;
  if (!f) return null;
  const along = (x - f.x) * f.dx + (y - f.y) * f.dy;
  const across = Math.abs((x - f.x) * f.dy - (y - f.y) * f.dx);
  return across < f.halfWidth && along > -f.reach ? { along, f } : null;
}

// ---------------------------------------------------------------------------
// The voyage in progress
// ---------------------------------------------------------------------------

const SITE_RADIUS = 90;
const SITE_TIME = 4; // seconds held slow inside a site
const SITE_SPEED = 30;
const SITE_SCORE = 40;
const FLAGSHIP_HITS = 4; // full hits (cannonballs) that sink a flagship
const FALLS_CURRENT = 190; // units/s at the lip: faster than most ships can back away from
const GROUNDING_SPEED = 70; // hitting a bank faster than this damages the hull

function startMissionState() {
  const m = game.mission;
  game.missionWon = false;
  game.missionState = m && {
    stage: 0,
    stageStart: 0,
    sites: [],
    sunk: 0,
    subs: 0,
    flagship: null,
    gates: (m.gates || []).map((gate) => ({ ...gate, closed: false })),
    fallsWarned: 0
  };
  if (!m) return;
  const seen = document.createElement("canvas");
  seen.width = WORLD_W * CHART_SCALE;
  seen.height = WORLD_H * CHART_SCALE;
  game.missionState.seenChart = seen;
  enterStage(0);
  updateGates();
  revealChart();
  for (const [x, y] of m.crocs || []) {
    game.seaCreatures.push({
      variant: "croc", home: { x, y }, x, y, angle: Math.random() * Math.PI * 2, speed: 35, radius: 14,
      attackCooldown: 0, motionSeed: Math.random() * Math.PI * 2, lifetime: 0, despawnAt: 1e9
    });
  }
}

function missionStage() {
  return game.mission.stages[game.missionState.stage];
}

function enterStage(index) {
  const state = game.missionState;
  state.stage = index;
  const stage = missionStage();
  state.stageStart = game.elapsed;
  state.sites = (stage.sites || []).map((site) => ({ ...site, progress: 0, done: false }));
  state.sunk = 0;
  state.subs = 0;
  state.flagship = stage.flagship ? spawnFlagship(stage.flagship) : null;
  if (stage.subs) game.nextUnderwaterSpawnAt = game.elapsed + 4;
  if (stage.fury) {
    for (const hz of hazards) {
      if (hz.kind !== "volcano") continue;
      hz.fury = true;
      hz.nextEruptAt = natureClock + 1 + Math.random() * 4;
    }
  }
  if (index === 0) return;
  playShipHorn();
  // after the message about what was just done
  const run = state;
  window.setTimeout(() => {
    if (game.missionState === run && run.stage === index) setUiMessage(`Next: ${stage.goal}`);
  }, 2600);
}

// A pirate flagship: armoured, and it hunts until one of you is sunk.
function spawnFlagship({ x, y, name }) {
  const ship = {
    ...newShip("pirate", x, y, Math.PI),
    flagship: true,
    aiControlled: true,
    shipName: name,
    displayColor: "#ff5a3a",
    maxHull: 300,
    hp: 300,
    maxSpeed: 185,
    turnRate: 1.35,
    lifetime: 0,
    despawnAt: 1e9,
    motionSeed: Math.random() * Math.PI * 2
  };
  game.pirateRaiders.push(ship);
  return ship;
}

// How far the current stage has got, as { have, need } (need 0: nothing to count).
function stageCount() {
  const state = game.missionState;
  const stage = missionStage();
  if (stage.sites) return { have: state.sites.filter((s) => s.done).length, need: state.sites.length };
  if (stage.sink) return { have: Math.min(state.sunk, stage.sink), need: stage.sink };
  if (stage.subs) return { have: Math.min(state.subs, stage.subs), need: stage.subs };
  if (stage.flagship) return { have: state.flagship.capsized ? 1 : 0, need: 1 };
  return { have: 0, need: 0 };
}

// Everything done but the way home: berthing at Harbour B now wins.
function missionReady() {
  return !!missionStage().home;
}

// Seconds left on whichever clock runs out first, or null without one.
function missionTimeLeft() {
  const m = game.mission;
  const stage = missionStage();
  const clocks = [];
  if (m.timeLimit) clocks.push(m.timeLimit - game.elapsed);
  if (stage.limit) clocks.push(stage.limit - (game.elapsed - game.missionState.stageStart));
  return clocks.length ? Math.max(0, Math.min(...clocks)) : null;
}

// A gate never closes on top of a ship.
function updateGates() {
  const state = game.missionState;
  for (const gate of state.gates) {
    const wanted = state.stage >= gate.from && state.stage < gate.until;
    if (!wanted) gate.closed = false;
    else if (!gate.closed && humanShips().every((s) => segmentDistance(s.x, s.y, gate.line) > gate.r + 90)) gate.closed = true;
  }
}

function endMission(won, text) {
  game.missionWon = won;
  if (won) {
    for (const ship of humanShips()) awardScore(ship, game.mission.reward, "mission");
    try {
      localStorage.setItem(MISSIONS_KEY, JSON.stringify({ ...completedMissions(), [game.mission.id]: true }));
    } catch {
      // storage full or blocked: the mission just isn't ticked off
    }
  }
  commitRoundScores();
  gameState = "ended";
  game.endedIndex = 1;
  stopLookout();
  resultText = text;
}

// Mission waters are uncharted: the corner map fills in round each ship as she
// sails, and rocks and ice show once they have been sighted.
const SIGHT = 380;
function revealChart() {
  const chart = missionChart(game.mission);
  const g = game.missionState.seenChart.getContext("2d");
  for (const ship of humanShips()) {
    if (ship.capsized || (ship.seenAt && dist(ship, ship.seenAt) < 40)) continue;
    ship.seenAt = { x: ship.x, y: ship.y };
    g.save();
    g.beginPath();
    g.arc(ship.x * CHART_SCALE, ship.y * CHART_SCALE, SIGHT * CHART_SCALE, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = "#23607e";
    g.fillRect(0, 0, chart.width, chart.height);
    g.drawImage(chart, 0, 0);
    g.restore();
    for (const thing of [...hazards, ...game.iceSheets]) {
      if (dist(ship, thing) < SIGHT + thing.r) thing.seen = true;
    }
    for (const gate of game.missionState.gates) {
      if (segmentDistance(ship.x, ship.y, gate.line) < SIGHT) gate.seen = true;
    }
  }
}

function updateMission(dt) {
  const m = game.mission;
  if (!m) return;
  const state = game.missionState;
  updateGates();
  revealChart();

  if (m.falls) {
    for (const ship of allCombatShips()) {
      const at = fallsAt(ship.x, ship.y);
      if (!at) continue;
      if (at.along > 0) {
        ship.overFalls = game.elapsed;
        damageShip(ship, 100, "swept over the waterfall", true);
        continue;
      }
      const k = 1 + at.along / at.f.reach; // 0 where the current starts, 1 at the lip
      // The water pours through the middle of the lip, drawing a ship off the banks with it.
      const tx = at.f.x + at.f.dx * 90 - ship.x;
      const ty = at.f.y + at.f.dy * 90 - ship.y;
      const len = Math.hypot(tx, ty) || 1;
      ship.x += (tx / len) * FALLS_CURRENT * k * k * dt;
      ship.y += (ty / len) * FALLS_CURRENT * k * k * dt;
      const stage = k > 0.65 ? 2 : k > 0.1 ? 1 : 0;
      if (ship.isHuman && stage > state.fallsWarned) {
        state.fallsWarned = stage;
        setUiMessage(stage === 2 ? "THE FALLS! The current has you - full astern!" : "You hear a roar ahead, and the current is quickening...", ship.playerSlot);
        playAlertTone(stage === 2 ? 220 : 160, 0.5, 0.06, "sawtooth");
      }
    }
  }

  for (const site of state.sites) {
    if (site.done) continue;
    const ship = humanShips().find((s) => !s.capsized && dist(s, site) < SITE_RADIUS && Math.abs(s.speed) < SITE_SPEED);
    site.progress = clamp(site.progress + (ship ? dt : -dt) / SITE_TIME, 0, 1);
    if (site.progress < 1) continue;
    site.done = true;
    awardScore(ship, SITE_SCORE, "objective");
    if (site.weight) ship.maxSpeed *= 1 - site.weight; // heavy cargo
    playShipHorn();
    setUiMessage(site.message, ship.playerSlot);
  }

  const count = stageCount();
  if (count.need && count.have >= count.need) enterStage(state.stage + 1);

  const afloat = humanShips().filter((s) => !s.capsized);
  if (m.minHull && afloat.length && afloat.every((s) => s.hp < s.maxHull * m.minHull)) {
    endMission(false, `Mission failed: ${m.name} - ${m.hullLoss}`);
  } else if (missionTimeLeft() === 0) {
    endMission(false, `Mission failed: ${m.name} - out of time`);
  }
}

// A pirate sunk by a captain's weapons.
function missionPirateSunk() {
  if (!game.missionState) return;
  game.missionState.sunk += 1;
  const need = missionStage().sink;
  if (need && game.missionState.sunk <= need) setUiMessage(`Pirate sunk! ${game.missionState.sunk} of ${need}`);
}

function missionSubSunk() {
  if (!game.missionState || !missionStage().subs) return;
  game.missionState.subs += 1;
  setUiMessage("The submarine is going down!");
}

// Lurks near its home and rushes any ship that comes close.
const CROC_SIGHT = 280;
const CROC_LEASH = 380;
function crocGoal(croc, prey) {
  let best = null;
  for (const ship of prey) {
    if (dist(croc, ship) < CROC_SIGHT && dist(croc.home, ship) < CROC_LEASH && (!best || dist(croc, ship) < dist(croc, best))) best = ship;
  }
  croc.speed = best ? 105 : 35;
  if (best) return best;
  const a = game.elapsed * 0.4 + croc.motionSeed;
  return { x: croc.home.x + Math.cos(a) * 45, y: croc.home.y + Math.sin(a) * 45 };
}

// Enemies in mission waters surface or sail in from out of sight, not from
// beyond the map edge (which is usually land there).
function missionWaterSpawn() {
  const ships = humanShips().filter((s) => !s.capsized);
  const spots = [];
  for (let i = 0; i < 80; i++) {
    const p = { x: 100 + Math.random() * (WORLD_W - 200), y: 100 + Math.random() * (WORLD_H - 200) };
    if (terrainDepth(p.x, p.y) < 70 || inHarbourSanctuary(p) || fallsAt(p.x, p.y)) continue;
    const gap = Math.min(...ships.map((s) => dist(p, s)));
    p.score = gap < 600 ? gap - 2000 : -gap; // out of sight, but not the far side of the map
    spots.push(p);
  }
  spots.sort((a, b) => b.score - a.score);
  const to = ships[0];
  const open = to && spots.slice(0, 12).find((p) => planPirateRoute({ x: p.x, y: p.y, radius: 16 }, to));
  const p = open || spots[0] || { x: WORLD_W / 2, y: WORLD_H / 2 };
  return { x: p.x, y: p.y, angle: to ? Math.atan2(to.y - p.y, to.x - p.x) : 0, entering: false };
}

// Banks are solid. A ship pushed off one rebounds like off a quay, and a hard
// hit damages the hull.
function bounceOffBank(ship) {
  const hull = hullSegment(ship);
  let worst = null;
  for (const k of [0, 0.5, 1]) {
    const x = hull.ax + (hull.bx - hull.ax) * k;
    const y = hull.ay + (hull.by - hull.ay) * k;
    const depth = terrainDepth(x, y);
    if (depth < hull.r && (!worst || depth < worst.depth)) worst = { x, y, depth };
  }
  if (!worst) return;
  const n = terrainOut(worst.x, worst.y);
  const push = Math.min(14, hull.r - worst.depth);
  ship.x += n.x * push;
  ship.y += n.y * push;
  // Only her own way into the bank damages her, not a shove from something else.
  const closing = Math.max(0, -ship.speed * (Math.cos(ship.angle) * n.x + Math.sin(ship.angle) * n.y));
  bumpSound(ship, ship, reboundOff(ship, n.x, n.y));
  const gate = ship.isHuman && game.missionState.gates.find((g) => g.closed && segmentDistance(worst.x, worst.y, g.line) < g.r + hull.r + 6);
  if (gate && game.elapsed - (ship.gateHintAt || -9) > 4) {
    ship.gateHintAt = game.elapsed;
    setUiMessage(gate.hint, ship.playerSlot);
  }
  if (ship.isHuman && closing > GROUNDING_SPEED && game.elapsed - (ship.groundedAt || -9) > 1.5) {
    ship.groundedAt = game.elapsed;
    damageShip(ship, (closing - GROUNDING_SPEED) * 0.12, "ran aground");
    setUiMessage(`${ship.playerName || "Ship"} struck the bank!`, ship.playerSlot);
  }
}

// Monsters, submarines and icebergs stay in the water.
function keepAfloat(entity, margin) {
  const depth = terrainDepth(entity.x, entity.y);
  if (depth >= margin) return false;
  const n = terrainOut(entity.x, entity.y);
  entity.x += n.x * Math.min(14, margin - depth);
  entity.y += n.y * Math.min(14, margin - depth);
  return n;
}

// ---------------------------------------------------------------------------
// Charts: one picture of the land for the 2D view and the corner map
// ---------------------------------------------------------------------------

const CHART_SCALE = 0.25;
const CHART_STYLES = {
  jungle: { bank: [176, 150, 98], land: [38, 96, 44], high: [20, 64, 30] },
  ice: { bank: [196, 224, 236], land: [233, 240, 244], high: [190, 206, 220] },
  volcanic: { bank: [92, 74, 66], land: [58, 48, 46], high: [112, 62, 44] },
  rock: { bank: [190, 164, 120], land: [140, 118, 90], high: [96, 84, 70] },
  swamp: { bank: [120, 112, 72], land: [62, 86, 48], high: [40, 62, 40] }
};
const chartCache = {};

// Water is left clear so each screen can paint its own sea under it.
function missionChart(m) {
  if (chartCache[m.id]) return chartCache[m.id];
  const canvasEl = document.createElement("canvas");
  canvasEl.width = WORLD_W * CHART_SCALE;
  canvasEl.height = WORLD_H * CHART_SCALE;
  const g = canvasEl.getContext("2d");
  const img = g.createImageData(canvasEl.width, canvasEl.height);
  const style = CHART_STYLES[m.style];
  for (let j = 0; j < canvasEl.height; j++) {
    for (let i = 0; i < canvasEl.width; i++) {
      const x = i / CHART_SCALE;
      const y = j / CHART_SCALE;
      const depth = terrainDepthRaw(m, x, y);
      const cave = underCave(m, x, y);
      if (depth >= 0 && !cave) continue;
      const grain = Math.sin(x * 0.11 + y * 0.07) * Math.sin(y * 0.13 - x * 0.05);
      const c = cave ? (grain > 0.1 ? style.high : [104, 96, 82]) : depth > -22 ? style.bank : grain > 0.15 || depth < -170 ? style.high : style.land;
      const shade = 1 + grain * 0.08;
      img.data.set([c[0] * shade, c[1] * shade, c[2] * shade, 255], (j * canvasEl.width + i) * 4);
    }
  }
  g.putImageData(img, 0, 0);
  return (chartCache[m.id] = canvasEl);
}

const GATE_COLORS = { logs: "#8a5a2e", chain: "#c9ccd0", lava: "#ff6a1e", ice: "#e6f6ff" };

function drawMissionTerrain2d() {
  if (!game.mission) return;
  ctx.drawImage(missionChart(game.mission), 0, 0, WORLD_W, WORLD_H);
  ctx.save();
  ctx.lineCap = "round";
  for (const gate of game.missionState.gates) {
    if (!gate.closed) continue;
    const [ax, ay, bx, by] = gate.line;
    ctx.strokeStyle = GATE_COLORS[gate.kind];
    ctx.lineWidth = gate.r * 2;
    ctx.setLineDash(gate.kind === "chain" ? [4, 40] : []);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }
  ctx.restore();
  const f = game.mission.falls;
  if (!f) return;
  // the cave mouth the river runs into, with rocks round it and foam at the lip
  const t = performance.now() / 1000;
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.rotate(Math.atan2(f.dy, f.dx));
  ctx.fillStyle = "#05090b";
  ctx.beginPath();
  ctx.ellipse(0, 0, 70, 150, 0, -Math.PI / 2, Math.PI / 2);
  ctx.fill();
  ctx.fillStyle = "#6f675a";
  for (let i = 0; i <= 14; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / 14;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * 74, Math.sin(a) * 158, 13 + (i % 3) * 6, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 9; i++) {
    const life = (t * 0.25 + i / 9) % 1;
    ctx.fillStyle = `rgba(235, 245, 248, ${0.28 * Math.sin(Math.PI * life)})`;
    ctx.beginPath();
    ctx.arc(-10 - life * 80, ((i * 67) % 240) - 120, 16 + life * 28, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(240, 250, 255, 0.7)";
  ctx.lineWidth = 3;
  for (let i = 0; i < 22; i++) {
    const x = -42 + ((t * 40 + i * 17) % 44);
    const y = -125 + ((i * 53) % 250);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 10, y);
    ctx.stroke();
  }
  ctx.restore();
}

// The flares and wrecks: a ring in the world with its name and progress.
function drawMissionSites() {
  if (!game.missionState) return;
  for (const site of game.missionState.sites) {
    if (site.done) continue;
    const p = worldToScreen(site.x, site.y, 24);
    if (!p.visible) continue;
    // what to do is added once a ship is close
    const close = humanShips().some((s) => !s.capsized && dist(s, site) < 420);
    ctx.save();
    ctx.textAlign = "center";
    ctx.font = "bold 19px Segoe UI";
    const w = Math.max(ctx.measureText(site.label).width, close ? 180 : 100) + 20;
    const h = close ? 58 : 38;
    const box = placeLabel(p.x, p.y - h, w, h);
    const cx = box.x + box.w / 2;
    ctx.fillStyle = "rgba(4, 18, 28, 0.66)";
    ctx.fillRect(box.x, box.y, w, h);
    ctx.fillStyle = "#ffe08a";
    ctx.fillText(site.label, cx, box.y + 21);
    if (close) {
      ctx.font = "16px Segoe UI";
      ctx.fillStyle = "#f4fbff";
      ctx.fillText("Slow down in the ring", cx, box.y + 41);
    }
    ctx.fillStyle = "rgba(220, 235, 245, 0.2)";
    ctx.fillRect(cx - 45, box.y + h - 11, 90, 7);
    ctx.fillStyle = "#8cead9";
    ctx.fillRect(cx - 45, box.y + h - 11, 90 * site.progress, 7);
    ctx.restore();
    if (!view3d.active) {
      ctx.save();
      applyWorldTransform2d();
      ctx.strokeStyle = "#ffe08a";
      ctx.lineWidth = 4;
      ctx.setLineDash([14, 10]);
      ctx.beginPath();
      ctx.arc(site.x, site.y, SITE_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function missionPanelLines() {
  const { stages, minHull } = game.mission;
  const index = game.missionState.stage;
  const count = stageCount();
  const lines = stages.slice(0, index).map((stage) => ({ text: `[x]  ${stage.goal}`, color: "#9dffb4" }));
  const progress = count.need > 1 ? ` (${count.have} of ${count.need})` : "";
  lines.push({ text: `>  ${stages[index].goal}${progress}`, color: "#ffffff" });
  const flagship = game.missionState.flagship;
  if (flagship && !flagship.capsized) lines.push({ text: `Flagship hull ${Math.ceil((flagship.hp / flagship.maxHull) * 100)}%`, color: "#ffb09a" });
  const more = stages.length - index - 1;
  if (more) lines.push({ text: `then ${more} more step${more > 1 ? "s" : ""}`, color: "#8fb4c8" });
  if (minHull) lines.push({ text: `Keep your hull above ${Math.round(minHull * 100)}%`, color: "#ffd9a8" });
  const left = missionTimeLeft();
  if (left !== null) lines.push({ text: `Time left ${formatGameTime(left)}`, color: left < 30 ? "#ff8a7a" : "#bfe9ff" });
  return lines;
}

// Top middle; in split screen the captains' names are there, so it sits low
// in player 1's half, between the two repair panels. On the bridge the
// instruments have the top middle, so it moves to the right below them.
function missionPanelRect() {
  const h = 34 + missionPanelLines().length * 21;
  const split = view3d.active && view3d.split;
  if (split) return { x: 286, y: HEIGHT - h - 8, w: 308, h };
  if (view3d.active && game.settings.cameraView === "bridge") return { x: WIDTH - 308, y: 124, w: 300, h };
  return { x: mode === "local" ? 512 : 490, y: 8, w: 380, h };
}

function drawMissionPanel() {
  if (!game.mission) return;
  const { x, y, w, h } = missionPanelRect();
  ctx.save();
  ctx.fillStyle = "rgba(5, 17, 25, 0.6)";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#ffd182";
  ctx.font = "bold 18px Segoe UI";
  ctx.fillText(game.mission.name, x + 10, y + 22);
  ctx.font = "16px Segoe UI";
  missionPanelLines().forEach((line, i) => {
    ctx.fillStyle = line.color;
    ctx.fillText(line.text, x + 10, y + 46 + i * 21, w - 20);
  });
  ctx.restore();
}

function drawMissionMapMarks(mmX, mmY, sx, sy) {
  if (!game.missionState) return;
  for (const gate of game.missionState.gates) {
    if (!gate.closed || !gate.seen) continue;
    ctx.strokeStyle = GATE_COLORS[gate.kind];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(mmX + gate.line[0] * sx, mmY + gate.line[1] * sy);
    ctx.lineTo(mmX + gate.line[2] * sx, mmY + gate.line[3] * sy);
    ctx.stroke();
  }
  const flagship = game.missionState.flagship;
  if (flagship && !flagship.capsized) {
    ctx.strokeStyle = "#ff5a3a";
    ctx.lineWidth = 2;
    ctx.strokeRect(mmX + flagship.x * sx - 4, mmY + flagship.y * sy - 4, 8, 8);
  }
  for (const site of game.missionState.sites) {
    ctx.beginPath();
    ctx.arc(mmX + site.x * sx, mmY + site.y * sy, 4, 0, Math.PI * 2);
    ctx.fillStyle = site.done ? "rgba(157, 255, 180, 0.6)" : "#ffe08a";
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// Screens: Free Play or Mission, then the mission list with its briefing
// ---------------------------------------------------------------------------

function openVoyageChoice() {
  game.voyage = null;
  game.voyageIndex = 0;
  gameState = "voyage";
}

function openMissions() {
  game.missionIndex = Math.max(0, MISSIONS.findIndex((m) => m.id === game.voyage));
  gameState = "missions";
}

function chooseFreePlay() {
  game.voyage = null;
  openShipSelect();
}

function chooseMission() {
  game.voyage = MISSIONS[game.missionIndex].id;
  openShipSelect();
}

function handleVoyageKey(code) {
  if (gameState === "voyage") {
    if (code === "Escape") gameState = "menu";
    if (code === "ArrowLeft") game.voyageIndex = 0;
    if (code === "ArrowRight") game.voyageIndex = 1;
    if (code === "Enter") (game.voyageIndex === 0 ? chooseFreePlay : openMissions)();
    return;
  }
  if (code === "Escape") gameState = "voyage";
  if (code === "ArrowUp") game.missionIndex = (game.missionIndex + MISSIONS.length - 1) % MISSIONS.length;
  if (code === "ArrowDown") game.missionIndex = (game.missionIndex + 1) % MISSIONS.length;
  if (code === "Enter") chooseMission();
}

function missionPanelBox(x, y, w, h, focused) {
  ctx.fillStyle = focused ? "rgba(38, 98, 120, 0.95)" : "rgba(7, 24, 35, 0.9)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = focused ? "#ffd182" : "rgba(186, 234, 255, 0.4)";
  ctx.lineWidth = focused ? 3 : 1.5;
  ctx.strokeRect(x, y, w, h);
}

// Wrapped text from the top left; returns the y below it.
function missionText(text, x, y, width, lineHeight) {
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      ctx.fillText(line, x, y);
      y += lineHeight;
      line = word;
    } else {
      line = next;
    }
  }
  ctx.fillText(line, x, y);
  return y + lineHeight;
}

function drawVoyageScreen() {
  ctx.save();
  ctx.textAlign = "center";
  ctx.fillStyle = "#f4fbff";
  ctx.font = "bold 36px Segoe UI";
  outlinedText("Choose your voyage", WIDTH / 2, 130);
  ctx.font = "18px Segoe UI";
  ctx.fillStyle = "#bde8ff";
  outlinedText(mode === "local" ? "Two captains" : "Solo voyage", WIDTH / 2, 162);
  const done = MISSIONS.filter((m) => completedMissions()[m.id]).length;
  const cards = [
    { title: "FREE PLAY", text: "The open sea. Sail from harbour to harbour for as long as you stay afloat, and earn points for the dockyard.", foot: "No objectives", go: chooseFreePlay },
    { title: "MISSIONS", text: "Rivers, ice fjords, burning islands and pirate straits. Each mission has its own waters, objectives and reward.", foot: `${done} of ${MISSIONS.length} completed`, go: openMissions }
  ];
  cards.forEach((card, i) => {
    const x = WIDTH / 2 - 480 + i * 500;
    missionPanelBox(x, 196, 460, 300, game.voyageIndex === i);
    ctx.fillStyle = "#ffd182";
    ctx.font = "bold 38px Segoe UI";
    ctx.fillText(card.title, x + 230, 258);
    ctx.fillStyle = "#ecf5f9";
    ctx.font = "22px Segoe UI";
    missionText(card.text, x + 230, 306, 410, 32);
    ctx.fillStyle = "#8cead9";
    ctx.fillText(card.foot, x + 230, 468);
    registerUiRect(x, 196, 460, 300, () => {
      game.voyageIndex = i;
      card.go();
    });
  });
  ctx.restore();
  drawDockButton(TOUCH_UI ? "Back" : "Back (Esc)", WIDTH / 2 - 180, 530, 360, 84, "rgba(24, 73, 97, 0.9)", "rgba(166, 218, 244, 0.5)", "#e8f6ff", () => { gameState = "menu"; });
}

// A picture for each mission, taken from the game's own 3D waters (they show
// what a mission is about, never its layout).
const missionArt = {};
function drawMissionArt(m, x, y, w, h) {
  let image = missionArt[m.id];
  if (!image) {
    image = missionArt[m.id] = new Image();
    image.src = `assets/missions/${m.id}.jpg`;
  }
  ctx.fillStyle = "#12435c";
  ctx.fillRect(x, y, w, h);
  if (!image.complete || !image.naturalWidth) return;
  // fill the frame, cropping the long side evenly
  const k = Math.max(w / image.naturalWidth, h / image.naturalHeight);
  const sw = w / k;
  const sh = h / k;
  ctx.drawImage(image, (image.naturalWidth - sw) / 2, (image.naturalHeight - sh) / 2, sw, sh, x, y, w, h);
}

function drawMissionsScreen() {
  const done = completedMissions();
  const m = MISSIONS[game.missionIndex];
  ctx.save();
  ctx.textAlign = "left";
  missionPanelBox(12, 12, 392, HEIGHT - 24, false);
  ctx.fillStyle = "#f4fbff";
  ctx.font = "bold 34px Segoe UI";
  ctx.fillText("Missions", TOUCH_UI ? 150 : 30, 58); // clear of the touch Back button
  MISSIONS.forEach((mission, i) => {
    const y = 78 + i * 121;
    const chosen = game.missionIndex === i;
    missionPanelBox(22, y, 372, 112, chosen);
    drawMissionArt(mission, 30, y + 8, 120, 96);
    ctx.fillStyle = "#ffd182";
    ctx.font = "bold 21px Segoe UI";
    ctx.fillText(mission.name, 162, y + 42, 222);
    ctx.fillStyle = "#cfe3ee";
    ctx.font = "17px Segoe UI";
    ctx.fillText(`${i + 1} of ${MISSIONS.length}   -   ${mission.reward} pts`, 162, y + 70, 222);
    if (done[mission.id]) {
      ctx.fillStyle = "#9dffb4";
      ctx.font = "bold 17px Segoe UI";
      ctx.fillText("Completed", 162, y + 96);
    }
    registerUiRect(22, y, 372, 112, () => { game.missionIndex = i; });
  });

  const left = 416;
  const wide = WIDTH - left - 12;
  missionPanelBox(left, 12, wide, HEIGHT - 24, false);
  drawMissionArt(m, left + 8, 20, wide - 16, 210);
  const shade = ctx.createLinearGradient(0, 130, 0, 230);
  shade.addColorStop(0, "rgba(4, 18, 28, 0)");
  shade.addColorStop(1, "rgba(4, 18, 28, 0.88)");
  ctx.fillStyle = shade;
  ctx.fillRect(left + 8, 130, wide - 16, 100);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 36px Segoe UI";
  outlinedText(m.name, left + 24, 192);
  ctx.font = "19px Segoe UI";
  ctx.fillStyle = "#ffe0a0";
  outlinedText(m.tagline, left + 24, 219);

  ctx.fillStyle = "#cfe3ee";
  ctx.font = "18px Segoe UI";
  const top = missionText(m.description, left + 20, 260, wide - 40, 25) + 20;
  const column = (title, x, w, items) => {
    ctx.fillStyle = "#ffd182";
    ctx.font = "bold 21px Segoe UI";
    ctx.fillText(title, x, top);
    ctx.fillStyle = "#ecf5f9";
    ctx.font = "17px Segoe UI";
    let y = top + 28;
    for (const [mark, text] of items) {
      ctx.fillText(mark, x, y);
      y = missionText(text, x + 24, y, w - 24, 22) + 3;
    }
  };
  const goals = m.stages.map((stage, i) => [`${i + 1}.`, stage.goal]);
  const rules = [...(m.rules || [])];
  if (m.minHull) rules.push(`Keep your hull above ${Math.round(m.minHull * 100)}%`);
  if (m.timeLimit) rules.push(`Finish within ${formatGameTime(m.timeLimit)}`);
  column("In this order", left + 20, 366, [...goals, ...rules.map((r) => ["!", r])]);
  column("The plan", left + 408, wide - 424, m.plan.map((step) => ["-", step]));
  ctx.restore();

  drawDockButton(TOUCH_UI ? "Back" : "Back (Esc)", 436, HEIGHT - 102, 280, 78, "rgba(24, 73, 97, 0.95)", "rgba(166, 218, 244, 0.5)", "#e8f6ff", () => { gameState = "voyage"; }, "back");
  drawDockButton(TOUCH_UI ? "Choose Ship" : "Choose Ship (Enter)", WIDTH - 412, HEIGHT - 102, 380, 78, "rgba(27, 98, 72, 0.95)", "#ffd682", "#e7fff4", chooseMission, "ship");
}
