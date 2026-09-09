const canvas = document.getElementById("gameCanvas");
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("Harbour Run init failed: #gameCanvas element not found.");
}
const ctx = canvas.getContext("2d");
if (!ctx) {
  throw new Error("Harbour Run init failed: 2D canvas context is unavailable.");
}

const WIDTH = canvas.width;
const HEIGHT = canvas.height;

const keys = new Set();
let mode = "single";
let gameState = "menu";
let resultText = "";
let lastTime = performance.now();

const HarbourA = { x: 95, y: HEIGHT - 95, r: 48, name: "Harbour A" };
const HarbourB = { x: WIDTH - 95, y: 95, r: 48, name: "Harbour B" };

const hazards = [
  { x: 320, y: 220, r: 52, danger: 90, kind: "island" },
  { x: 520, y: 510, r: 44, danger: 84, kind: "iceberg", vx: 18, vy: -10 },
  { x: 740, y: 260, r: 58, danger: 110, kind: "volcano" },
  { x: 950, y: 470, r: 50, danger: 92, kind: "island" },
  { x: 610, y: 120, r: 36, danger: 76, kind: "iceberg", vx: -14, vy: 12 }
];

const dynamicDangers = [
  { x: 150, y: 350, vx: 85, vy: 20, r: 68, kind: "storm" },
  { x: 1050, y: 580, vx: -70, vy: -30, r: 62, kind: "storm" }
];

const STORAGE_KEY = "harbour-run-profiles-v1";
const SETTINGS_KEY = "harbour-run-settings-v1";
const SELL_REFUND_RATE = 0.6;
const REPAIR_RESERVE_RATIO = 0.55;
const GAMEPLAY_PRESETS = ["calm", "classic", "chaos"];
const DEFAULT_KEYBINDS = {
  p1Forward: "KeyW",
  p1Backward: "KeyS",
  p1Left: "KeyA",
  p1Right: "KeyD",
  p1Attack: "Space",
  p2Forward: "ArrowUp",
  p2Backward: "ArrowDown",
  p2Left: "ArrowLeft",
  p2Right: "ArrowRight",
  p2Attack: "ShiftRight"
};
const KEYBIND_LABELS = {
  p1Forward: "P1 Forward",
  p1Backward: "P1 Backward",
  p1Left: "P1 Left",
  p1Right: "P1 Right",
  p1Attack: "P1 Attack",
  p2Forward: "P2 Forward",
  p2Backward: "P2 Backward",
  p2Left: "P2 Left",
  p2Right: "P2 Right",
  p2Attack: "P2 Attack"
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
    stats: { maxSpeed: 240, accel: 165, hp: 110, turnRate: 2.45, windResistance: 0.08 }
  },
  {
    id: "cargoFreighter",
    name: "Cargo Freighter",
    category: "Cargo",
    color: "#cf8442",
    defaultOwned: true,
    desc: "Heavy hull and high survivability.",
    stats: { maxSpeed: 205, accel: 142, hp: 150, turnRate: 2.05, windResistance: 0.18 }
  },
  {
    id: "sailingBoat",
    name: "Sailing Boat",
    category: "Sailing",
    color: "#f1efcf",
    defaultOwned: true,
    desc: "Agile but more exposed to wind.",
    stats: { maxSpeed: 194, accel: 136, hp: 96, turnRate: 2.95, windResistance: -0.08 }
  },
  {
    id: "catamaran",
    name: "Catamaran",
    category: "Catamaran",
    color: "#35d4be",
    cost: 180,
    desc: "Fast twin-hull coastal runner.",
    stats: { maxSpeed: 258, accel: 178, hp: 102, turnRate: 3.02, windResistance: 0.04 }
  },
  {
    id: "assaultShip",
    name: "Assault Ship",
    category: "Assault",
    color: "#ef6760",
    cost: 320,
    desc: "Combat-oriented hull with better attack range.",
    stats: { maxSpeed: 230, accel: 168, hp: 132, turnRate: 2.42, windResistance: 0.12, attackRangeBonus: 12 }
  },
  {
    id: "aircraftCarrier",
    name: "Aircraft Carrier",
    category: "Carrier",
    color: "#7a869d",
    premiumPack: "specialistFleet",
    desc: "Massive premium carrier with strong hull.",
    stats: { maxSpeed: 182, accel: 124, hp: 175, turnRate: 1.82, windResistance: 0.24 }
  },
  {
    id: "futuristicNova",
    name: "Futuristic Nova",
    category: "Futuristic",
    color: "#b68cff",
    premiumPack: "specialistFleet",
    desc: "Premium high-tech ship with superior handling.",
    stats: { maxSpeed: 282, accel: 208, hp: 122, turnRate: 3.08, windResistance: 0.2 }
  }
];
const SHOP_ITEMS = [
  { id: "sonicWeapon", name: "Sonic Weapon", cost: 140, desc: "Longer attack range and faster reload." },
  { id: "waterCannon", name: "Water Cannon", cost: 120, desc: "Reduces continuous hazard damage." },
  { id: "missileLauncher", name: "Advanced Missile Launcher", cost: 340, desc: "Auto-tracks nearby threats with kill missiles." },
  { id: "reinforcedHull", name: "Reinforced Hull", cost: 170, desc: "Extra hull points at round start." },
  { id: "windKeel", name: "Wind Stabilizer Keel", cost: 130, desc: "Reduces wind drift effects." },
  { id: "turboProp", name: "Turbo Propeller", cost: 160, desc: "Higher top speed and acceleration." },
  { id: "leviathanDecoy", name: "Leviathan Decoy Drones", cost: 420, desc: "Distracts sea creatures for short bursts.", premiumPack: "specialistArsenal" },
  { id: "tempestScrambler", name: "Tempest Scrambler", cost: 390, desc: "Reduces storm danger intensity around your ship.", premiumPack: "specialistArsenal" }
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
    leaderboard: {},
    entitlements: {
      specialistArsenal: false,
      specialistFleet: false
    }
  };
}

function createDefaultSettings() {
  return {
    keybinds: { ...DEFAULT_KEYBINDS },
    gameplayPreset: "classic",
    windScale: 1,
    hazardScale: 1
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
  floatingScores: [],
  profiles: createDefaultProfiles(),
  roundCommitted: false,
  shopIndex: 0,
  shopIndexBySlot: { p1: 0, p2: 0 },
  shopSlot: "p1",
  shipSelectSlot: "p1",
  shipSelections: { p1: "cruiseLiner", p2: "cargoFreighter" },
  underwaterEnemies: [],
  nextUnderwaterSpawnAt: 11,
  targetAlerts: [],
  uiRects: [],
  audioContext: null,
  audioEnabled: false,
  uiMessage: "",
  uiMessageTtl: 0,
  settings: createDefaultSettings(),
  keyRebindAction: null
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
    parsed.entitlements = parsed.entitlements || { specialistArsenal: false, specialistFleet: false };
    parsed.entitlements.specialistArsenal = !!parsed.entitlements.specialistArsenal;
    parsed.entitlements.specialistFleet = !!parsed.entitlements.specialistFleet;
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
    const gameplayPreset = GAMEPLAY_PRESETS.includes(parsed.gameplayPreset) ? parsed.gameplayPreset : defaults.gameplayPreset;
    const windScale = clamp(Number(parsed.windScale) || defaults.windScale, 0.6, 1.6);
    const hazardScale = clamp(Number(parsed.hazardScale) || defaults.hazardScale, 0.6, 1.6);
    return { keybinds, gameplayPreset, windScale, hazardScale };
  } catch {
    return createDefaultSettings();
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(game.settings));
}

function keyName(code) {
  if (!code) return "Unbound";
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
  return SHIP_CATALOG.find((ship) => ship.id === id) || SHIP_CATALOG[0];
}

function isShipOwned(profile, shipDef) {
  if (shipDef.defaultOwned) return true;
  if (shipDef.premiumPack) {
    return !!game.profiles.entitlements[shipDef.premiumPack];
  }
  return !!profile.ownedShips[shipDef.id];
}

function getShopEntries() {
  const gadgetEntries = SHOP_ITEMS.map((item) => ({ kind: "gadget", ...item }));
  const shipEntries = SHIP_CATALOG.filter((ship) => !ship.defaultOwned).map((ship) => ({ kind: "ship", ...ship }));
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
    p1: getProfile("p1").selectedShip || "cruiseLiner",
    p2: getProfile("p2").selectedShip || "cargoFreighter"
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

function confirmShipSelectionAndStart() {
  const slots = mode === "local" ? ["p1", "p2"] : ["p1"];
  for (const slot of slots) {
    const profile = getProfile(slot);
    const shipDef = getShipDefinition(game.shipSelections[slot]);
    if (!isShipOwned(profile, shipDef)) {
      setUiMessage(`${profile.name} has not unlocked ${shipDef.name}`);
      return;
    }
  }

  for (const slot of slots) {
    getProfile(slot).selectedShip = game.shipSelections[slot];
  }
  saveProfiles();
  resetGame();
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
  ship.owned = profile.owned || {};
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

function setUiMessage(text) {
  game.uiMessage = text;
  game.uiMessageTtl = 2.5;
}

function clearUiRects() {
  game.uiRects = [];
}

function registerUiRect(x, y, w, h, onClick) {
  game.uiRects.push({ x, y, w, h, onClick });
}

function hitUiRect(x, y) {
  for (let i = game.uiRects.length - 1; i >= 0; i -= 1) {
    const rect = game.uiRects[i];
    if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
      return rect;
    }
  }
  return null;
}

function ensureAudio() {
  if (game.audioEnabled) {
    return true;
  }
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    return false;
  }
  if (!game.audioContext) {
    game.audioContext = new AudioCtx();
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
  gain.connect(ctxAudio.destination);
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

function togglePremiumPackForTesting() {
  game.profiles.entitlements.specialistArsenal = !game.profiles.entitlements.specialistArsenal;
  game.profiles.entitlements.specialistFleet = game.profiles.entitlements.specialistArsenal;
  saveProfiles();
  setUiMessage(`Premium packs: ${game.profiles.entitlements.specialistArsenal ? "ON" : "OFF"}`);
}

function newShip(type, x, y, heading) {
  return {
    type,
    x,
    y,
    angle: heading,
    speed: 0,
    turnRate: 2.6,
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
  const attemptCost = baseCost + complexitySpike;
  if (profile.points < attemptCost) {
    setUiMessage(`${profile.name} needs ${attemptCost} points for repair effort`);
    return;
  }

  profile.points -= attemptCost;
  saveProfiles();

  let effort = plan.minEffort + Math.random() * (plan.maxEffort - plan.minEffort);
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

  const success = Math.random() < plan.successChance;
  if (success) {
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

  for (const dz of dynamicDangers) {
    const d = dist(point, dz);
    const stormZone = dz.r + 30 + padding;
    if (d < stormZone) {
      score += (stormZone - d) * 4;
    }
  }

  return score;
}

function findSafeAISpawnPoint(fallback) {
  let best = { ...fallback };
  let bestScore = Number.POSITIVE_INFINITY;

  for (let i = 0; i < 30; i += 1) {
    const candidate = {
      x: clamp(HarbourA.x + 130 + Math.random() * 260, 80, WIDTH - 80),
      y: clamp(HarbourA.y - 180 + Math.random() * 210, 80, HEIGHT - 80)
    };
    const score = dangerAtPoint(candidate, 8);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function computeAIThreatField(aiShip, targetShip) {
  let avoidX = 0;
  let avoidY = 0;
  let dangerScore = 0;

  function addRepel(entity, radius, weight) {
    if (!entity) return;
    const dx = aiShip.x - entity.x;
    const dy = aiShip.y - entity.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.001;
    if (d >= radius) return;
    const strength = (radius - d) / radius;
    avoidX += (dx / d) * strength * weight;
    avoidY += (dy / d) * strength * weight;
    dangerScore += strength * (weight / 120);
  }

  for (const hz of hazards) {
    addRepel(hz, hz.r + 36, 380);
    addRepel(hz, hz.danger + 24, 230);
  }
  for (const dz of dynamicDangers) {
    addRepel(dz, dz.r + 34, 300);
  }
  for (const raider of game.pirateRaiders) {
    if (!raider.capsized) addRepel(raider, 165, 190);
  }
  for (const creature of game.seaCreatures) {
    addRepel(creature, 130, 160);
  }
  for (const enemy of game.underwaterEnemies) {
    if (!enemy.capsized) addRepel(enemy, 180, 250);
  }
  for (const missile of game.missiles) {
    if (missile.target === aiShip) {
      addRepel(missile, 180, 420);
    }
  }

  if (targetShip && !targetShip.capsized) {
    const d = dist(aiShip, targetShip);
    if (d < 130) {
      addRepel(targetShip, 130, 110);
    }
  }

  return { avoidX, avoidY, dangerScore };
}

function resetGame() {
  game.profiles = loadProfiles();

  game.player1 = newShip("cruise", HarbourA.x + 18, HarbourA.y - 20, -0.8);
  game.player2 = mode === "local" ? newShip("playerTwo", HarbourA.x - 18, HarbourA.y + 24, -0.8) : null;
  game.ai = mode === "single" ? newShip("pirate", HarbourA.x + 170, HarbourA.y + 145, -0.6) : null;
  if (game.ai) {
    const safeSpawn = findSafeAISpawnPoint({ x: game.ai.x, y: game.ai.y });
    game.ai.x = safeSpawn.x;
    game.ai.y = safeSpawn.y;
  }

  applyShipDefinition(game.player1, getShipDefinition(getProfile("p1").selectedShip));
  if (game.player2) {
    applyShipDefinition(game.player2, getShipDefinition(getProfile("p2").selectedShip));
  }

  applyGadgets(game.player1, getProfile("p1"), "p1");
  if (game.player2) {
    applyGadgets(game.player2, getProfile("p2"), "p2");
  }

  initRepairState(game.player1);
  initRepairState(game.player2);

  if (game.ai) {
    game.ai.aiControlled = true;
    game.ai.maxSpeed = 225;
    game.ai.turnRate = 2.2;
    game.ai.displayColor = "#f0d034";
    game.ai.shipName = "Pirate Hunter";
  }

  game.aiDirector = {
    attackUnlockedAt: 9,
    nextDecisionAt: 1.2,
    mode: "patrol",
    waypoint: { x: WIDTH * 0.55, y: HEIGHT * 0.62 },
    evadeUntil: 0,
    panicUntil: 0
  };

  game.pirateRaiders = [];
  game.seaCreatures = [];
  game.underwaterEnemies = [];
  game.missiles = [];
  game.nextRaiderSpawnAt = 8 + Math.random() * 5;
  game.nextCreatureSpawnAt = 7 + Math.random() * 4;
  game.nextUnderwaterSpawnAt = 11 + Math.random() * 6;
  game.wind = { x: 0, y: 0 };
  game.floatingScores = [];
  game.targetAlerts = [];
  game.roundCommitted = false;
  game.uiMessage = "";
  game.uiMessageTtl = 0;

  game.elapsed = 0;
  resultText = "";
  gameState = "playing";
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

function applyMovement(ship, input, dt) {
  if (!ship || ship.capsized) return;

  const throttleBase = input.forward ? 1 : input.backward ? -0.5 : 0;
  const throttle = throttleBase * (input.throttleScale || 1);
  const steer = (input.left ? -1 : 0) + (input.right ? 1 : 0);

  ship.angle += steer * ship.turnRate * dt;
  ship.speed += throttle * ship.accel * dt;
  ship.speed *= 0.986;
  ship.speed = clamp(ship.speed, -ship.maxSpeed * 0.35, ship.maxSpeed);

  ship.x += Math.cos(ship.angle) * ship.speed * dt;
  ship.y += Math.sin(ship.angle) * ship.speed * dt;

  // Wind applies to all ships as continuous drift.
  ship.x += game.wind.x * (1 - ship.windResistance) * dt;
  ship.y += game.wind.y * (1 - ship.windResistance) * dt;

  ship.x = clamp(ship.x, 10, WIDTH - 10);
  ship.y = clamp(ship.y, 10, HEIGHT - 10);

  ship.reload = Math.max(0, ship.reload - dt);
  ship.attackLock = Math.max(0, ship.attackLock - dt * 0.45);
  ship.hitFlash = Math.max(0, ship.hitFlash - dt);
}

function damageShip(ship, amount, reason, hardCapsize = false) {
  if (!ship || ship.capsized) return;
  const effectiveAmount = hardCapsize ? amount : amount * (1 - ship.damageReduction);
  ship.hp -= effectiveAmount;
  ship.hitFlash = 0.2;

  if (hardCapsize || ship.hp <= 0) {
    ship.hp = 0;
    ship.capsized = true;
    ship.speed = 0;
  }
}

function attack(attacker, target, dt = 0) {
  if (!attacker || !target || attacker.capsized || target.capsized) return;
  if (attacker.reload > 0) return;

  const range = (attacker.aiControlled ? 84 : 90) + (attacker.attackRangeBonus || 0);
  const d = dist(attacker, target);
  const desired = Math.atan2(target.y - attacker.y, target.x - attacker.x);
  const facingError = Math.abs(normalizeAngle(desired - attacker.angle));
  const hasFiringSolution = d <= range && facingError < 0.42;

  if (!hasFiringSolution) {
    attacker.attackLock = 0;
    return;
  }

  if (attacker.aiControlled) {
    attacker.attackLock += dt;
    if (attacker.attackLock < 1.15) {
      return;
    }
    attacker.attackLock = 0;
    attacker.reload = 3.2;
    damageShip(target, 100, "attacked by pirate ship", true);
    return;
  }

  attacker.reload = attacker.owned && attacker.owned.sonicWeapon ? 0.92 : 1.25;
  damageShip(target, 100, "attacked by pirate ship", true);
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
      const severity = severityBase * game.settings.hazardScale;
      damageShip(ship, severity * dt, `danger zone near ${hz.kind}`);
    }
  }

  for (const dz of dynamicDangers) {
    const d = dist(ship, dz);
    if (d <= dz.r) {
      damageShip(ship, 30 * game.settings.hazardScale * dt, "moving storm danger zone");
    }
  }
}

function updateDynamicDangers(dt) {
  for (const dz of dynamicDangers) {
    dz.x += dz.vx * dt;
    dz.y += dz.vy * dt;

    if (dz.x < 60 || dz.x > WIDTH - 60) dz.vx *= -1;
    if (dz.y < 60 || dz.y > HEIGHT - 60) dz.vy *= -1;
  }
}

function updateWind(dt) {
  const t = game.elapsed;
  const gustX = Math.sin(t * 0.45) * 24 + Math.sin(t * 0.12 + 1.6) * 10;
  const gustY = Math.cos(t * 0.36 + 0.8) * 20 + Math.sin(t * 0.18) * 9;

  const windScale = game.settings.windScale;
  game.wind.x += (gustX * windScale - game.wind.x) * Math.min(1, dt * 1.6);
  game.wind.y += (gustY * windScale - game.wind.y) * Math.min(1, dt * 1.6);
}

function updateIcebergs(dt) {
  for (const hz of hazards) {
    if (hz.kind !== "iceberg") continue;

    hz.x += (hz.vx + game.wind.x * 0.55) * dt;
    hz.y += (hz.vy + game.wind.y * 0.55) * dt;

    if (hz.x < 80 || hz.x > WIDTH - 80) hz.vx *= -1;
    if (hz.y < 80 || hz.y > HEIGHT - 80) hz.vy *= -1;

    hz.x = clamp(hz.x, 70, WIDTH - 70);
    hz.y = clamp(hz.y, 70, HEIGHT - 70);
  }
}

function randomEdgeSpawn() {
  const edge = Math.floor(Math.random() * 4);
  if (edge === 0) return { x: 18, y: 80 + Math.random() * (HEIGHT - 160) };
  if (edge === 1) return { x: WIDTH - 18, y: 80 + Math.random() * (HEIGHT - 160) };
  if (edge === 2) return { x: 80 + Math.random() * (WIDTH - 160), y: 18 };
  return { x: 80 + Math.random() * (WIDTH - 160), y: HEIGHT - 18 };
}

function spawnPirateRaider() {
  const p = randomEdgeSpawn();
  game.pirateRaiders.push({
    ...newShip("pirate", p.x, p.y, Math.random() * Math.PI * 2),
    aiControlled: true,
    maxSpeed: 210,
    turnRate: 2.15,
    lifetime: 0,
    despawnAt: 17 + Math.random() * 8,
    motionSeed: Math.random() * Math.PI * 2,
    roamPoint: {
      x: 120 + Math.random() * (WIDTH - 240),
      y: 120 + Math.random() * (HEIGHT - 240)
    }
  });
}

function spawnUnderwaterEnemy() {
  const p = randomEdgeSpawn();
  const isUBoat = Math.random() < 0.5;
  game.underwaterEnemies.push({
    kind: isUBoat ? "uboat" : "submarine",
    x: p.x,
    y: p.y,
    angle: Math.random() * Math.PI * 2,
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
  const ships = allCombatShips();
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

  if (game.elapsed >= game.nextUnderwaterSpawnAt && game.underwaterEnemies.length < 4) {
    spawnUnderwaterEnemy();
    game.nextUnderwaterSpawnAt = game.elapsed + 12 + Math.random() * 10;
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
    enemy.x = clamp(enemy.x, 20, WIDTH - 20);
    enemy.y = clamp(enemy.y, 20, HEIGHT - 20);

    const targetDist = dist(enemy, target);
    const facing = Math.abs(normalizeAngle(desired - enemy.angle));
    const lockReady = targetDist < 250 && facing < 0.36;

    if (lockReady && enemy.reload <= 0) {
      enemy.lockTime += dt;
      if (target.isHuman && enemy.lockTime > 0.18) {
        addTargetAlert(target, enemy, enemy.kind === "uboat" ? "U-BOAT LOCK" : "SUB LOCK");
      }
      if (enemy.lockTime >= 1.2) {
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

function steerShipToward(ship, target, options = {}) {
  const dx = target.x - ship.x;
  const dy = target.y - ship.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const desired = Math.atan2(dy, dx);
  const wanderScale = options.wanderScale || 0;
  const wanderPhase = (game.elapsed * (options.wanderSpeed || 0.8)) + (ship.motionSeed || 0);
  const wanderOffset = Math.sin(wanderPhase) * wanderScale;
  const turnError = normalizeAngle(desired + wanderOffset - ship.angle);
  const hardTurn = Math.abs(turnError) > 1.5;
  const moderateTurn = Math.abs(turnError) > 0.75;
  const nearTarget = distance < (options.slowRadius || 90);

  return {
    forward: !hardTurn,
    backward: hardTurn && distance < 140,
    left: turnError < -(options.turnDeadzone || 0.14),
    right: turnError > (options.turnDeadzone || 0.14),
    throttleScale: nearTarget ? 0.45 : moderateTurn ? 0.72 : 1
  };
}

function updatePirateRaiders(dt) {
  if (mode !== "single" || gameState !== "playing") return;

  if (game.elapsed >= game.nextRaiderSpawnAt && game.pirateRaiders.length < 3) {
    spawnPirateRaider();
    game.nextRaiderSpawnAt = game.elapsed + 8 + Math.random() * 8;
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

    const closeToPlayer = playerDistance < 155;
    const alertToPlayer = playerDistance < 240;
    const target = alertToPlayer ? {
      x: player.x + Math.cos(player.angle) * Math.max(24, player.speed * 0.18),
      y: player.y + Math.sin(player.angle) * Math.max(24, player.speed * 0.18)
    } : raider.roamPoint;

    if (!alertToPlayer && dist(raider, raider.roamPoint) < 40) {
      raider.roamPoint = {
        x: 120 + Math.random() * (WIDTH - 240),
        y: 120 + Math.random() * (HEIGHT - 240)
      };
    }

    const raiderInput = steerShipToward(raider, target, {
      wanderScale: alertToPlayer ? 0.06 : 0.18,
      wanderSpeed: alertToPlayer ? 1.2 : 0.7,
      slowRadius: alertToPlayer ? 72 : 110,
      turnDeadzone: 0.12
    });

    applyMovement(raider, raiderInput, dt);
    processHazards(raider, dt);

    if (closeToPlayer && game.elapsed > 10) {
      attack(raider, player, dt);
    }

    if (raider.capsized) {
      game.pirateRaiders.splice(i, 1);
    }
  }
}

function aiInput(aiShip, targetShip, dt) {
  if (!aiShip || aiShip.capsized) {
    return { forward: false, backward: false, left: false, right: false };
  }

  if (game.elapsed >= game.aiDirector.nextDecisionAt) {
    const playerDistance = targetShip && !targetShip.capsized ? dist(aiShip, targetShip) : 9999;
    const roll = Math.random();

    if (playerDistance < 260 && game.elapsed > game.aiDirector.attackUnlockedAt && roll < 0.58) {
      game.aiDirector.mode = "intercept";
    } else if (roll < 0.35) {
      game.aiDirector.mode = "ambush";
      game.aiDirector.waypoint = {
        x: clamp((HarbourA.x + HarbourB.x) * 0.5 + (Math.random() - 0.5) * 240, 120, WIDTH - 120),
        y: clamp((HarbourA.y + HarbourB.y) * 0.5 + (Math.random() - 0.5) * 220, 120, HEIGHT - 120)
      };
    } else {
      game.aiDirector.mode = "race";
    }

    game.aiDirector.nextDecisionAt = game.elapsed + 2.2 + Math.random() * 2.8;
  }

  let target = HarbourB;
  if (game.aiDirector.mode === "intercept" && targetShip && !targetShip.capsized) {
    target = {
      x: targetShip.x + Math.cos(targetShip.angle) * Math.max(65, targetShip.speed * 0.35),
      y: targetShip.y + Math.sin(targetShip.angle) * Math.max(65, targetShip.speed * 0.35)
    };
  } else if (game.aiDirector.mode === "ambush") {
    target = game.aiDirector.waypoint;
    if (dist(aiShip, game.aiDirector.waypoint) < 55) {
      game.aiDirector.mode = "intercept";
    }
  }

  const threat = computeAIThreatField(aiShip, targetShip);
  const highDanger = threat.dangerScore > 3.2;
  const mediumDanger = threat.dangerScore > 1.8;

  if (highDanger) {
    game.aiDirector.panicUntil = Math.max(game.aiDirector.panicUntil || 0, game.elapsed + 1.1);
    game.aiDirector.evadeUntil = Math.max(game.aiDirector.evadeUntil || 0, game.elapsed + 1.8);
  } else if (mediumDanger) {
    game.aiDirector.evadeUntil = Math.max(game.aiDirector.evadeUntil || 0, game.elapsed + 0.9);
  }

  if (game.elapsed < 5.5 && threat.dangerScore > 1.1) {
    game.aiDirector.evadeUntil = Math.max(game.aiDirector.evadeUntil || 0, game.elapsed + 1.4);
  }

  const inEvade = game.elapsed < (game.aiDirector.evadeUntil || 0);
  const inPanic = game.elapsed < (game.aiDirector.panicUntil || 0);

  if (inEvade) {
    const escapeTarget = {
      x: clamp(aiShip.x + clamp(threat.avoidX, -260, 260), 30, WIDTH - 30),
      y: clamp(aiShip.y + clamp(threat.avoidY, -260, 260), 30, HEIGHT - 30)
    };

    const desired = Math.atan2(escapeTarget.y - aiShip.y, escapeTarget.x - aiShip.x);
    const turnErr = normalizeAngle(desired - aiShip.angle);
    const hardTurn = Math.abs(turnErr) > 1.6;

    return {
      forward: !hardTurn,
      backward: inPanic && hardTurn,
      left: turnErr < -0.09,
      right: turnErr > 0.09,
      throttleScale: inPanic ? 1.15 : 1.0
    };
  }

  target = {
    x: clamp(target.x + threat.avoidX * dt, 30, WIDTH - 30),
    y: clamp(target.y + threat.avoidY * dt, 30, HEIGHT - 30)
  };

  return steerShipToward(aiShip, target, {
    wanderScale: game.aiDirector.mode === "race" ? 0.12 : 0.04,
    wanderSpeed: game.aiDirector.mode === "ambush" ? 1.0 : 0.75,
    slowRadius: game.aiDirector.mode === "race" ? 118 : 82,
    turnDeadzone: 0.1
  });
}

function nearHarbourB(ship) {
  return ship && !ship.capsized && dist(ship, HarbourB) <= HarbourB.r - 8;
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

function updateScore(dt) {
  for (const ship of humanShips()) {
    if (ship.capsized) continue;

    ship.scoreTick += dt;
    if (ship.scoreTick < 1) {
      continue;
    }
    ship.scoreTick -= 1;

    const speed = Math.abs(ship.speed);
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
    angle: Math.random() * Math.PI * 2,
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

  if (game.elapsed >= game.nextCreatureSpawnAt && game.seaCreatures.length < 5) {
    spawnSeaCreature();
    game.nextCreatureSpawnAt = game.elapsed + 9 + Math.random() * 8;
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

    let target = ships[0];
    let best = dist(creature, target) * (target.owned && target.owned.leviathanDecoy ? 1.3 : 1);
    for (let j = 1; j < ships.length; j += 1) {
      const d = dist(creature, ships[j]) * (ships[j].owned && ships[j].owned.leviathanDecoy ? 1.3 : 1);
      if (d < best) {
        best = d;
        target = ships[j];
      }
    }

    const desired = Math.atan2(target.y - creature.y, target.x - creature.x);
    const wobble = Math.sin(game.elapsed * 2.4 + creature.motionSeed) * 0.35;
    const err = normalizeAngle(desired + wobble - creature.angle);
    creature.angle += clamp(err, -1.8 * dt, 1.8 * dt);

    creature.x += Math.cos(creature.angle) * creature.speed * dt + game.wind.x * 0.18 * dt;
    creature.y += Math.sin(creature.angle) * creature.speed * dt + game.wind.y * 0.18 * dt;
    creature.x = clamp(creature.x, 18, WIDTH - 18);
    creature.y = clamp(creature.y, 18, HEIGHT - 18);

    if (best < creature.radius + target.radius + 6 && creature.attackCooldown <= 0) {
      damageShip(target, 34, "sea creature strike");
      creature.attackCooldown = 1.35;
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
        game.missiles.push({ x: ship.x, y: ship.y, vx: 0, vy: 0, target, ttl: 4.4, owner: ship });
        ship.missileCooldown = 8.6;
      } else {
        ship.missileCooldown = 1.6;
      }
    }
  }

  for (let i = game.missiles.length - 1; i >= 0; i -= 1) {
    const m = game.missiles[i];
    m.ttl -= dt;
    if (m.ttl <= 0 || !m.target) {
      game.missiles.splice(i, 1);
      continue;
    }

    if (m.target.capsized) {
      game.missiles.splice(i, 1);
      continue;
    }

    const dx = m.target.x - m.x;
    const dy = m.target.y - m.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const speed = m.kind === "torpedo" ? 250 : 330;
    m.vx += (dx / len) * speed * dt;
    m.vy += (dy / len) * speed * dt;
    m.vx *= 0.94;
    m.vy *= 0.94;
    m.x += m.vx * dt;
    m.y += m.vy * dt;

    if (dist(m, m.target) < 18) {
      if (m.target.isHuman !== undefined || m.target.aiControlled) {
        damageShip(m.target, 100, "tracked missile impact", true);
      } else if (m.target.kind === "uboat" || m.target.kind === "submarine") {
        m.target.hp -= 100;
      } else {
        m.target.lifetime = m.target.despawnAt + 1;
      }
      game.missiles.splice(i, 1);
    }
  }
}

function handleGameLogic(dt) {
  if (gameState !== "playing") return;

  game.elapsed += dt;
  updateWind(dt);

  const p1Input = {
    forward: isActionPressed("p1Forward"),
    backward: isActionPressed("p1Backward"),
    left: isActionPressed("p1Left"),
    right: isActionPressed("p1Right")
  };

  applyMovement(game.player1, p1Input, dt);

  if (mode === "local") {
    const p2Input = {
      forward: isActionPressed("p2Forward"),
      backward: isActionPressed("p2Backward"),
      left: isActionPressed("p2Left"),
      right: isActionPressed("p2Right")
    };
    applyMovement(game.player2, p2Input, dt);
  } else {
    const ai = aiInput(game.ai, game.player1, dt);
    applyMovement(game.ai, ai, dt);
  }

  updateIcebergs(dt);
  updateDynamicDangers(dt);
  updatePirateRaiders(dt);
  updateSeaCreatures(dt);
  updateUnderwaterEnemies(dt);
  updateMissiles(dt);
  updateScore(dt);
  updateFloatingScores(dt);
  updateTargetAlerts(dt);

  game.uiMessageTtl = Math.max(0, game.uiMessageTtl - dt);
  if (game.uiMessageTtl === 0) {
    game.uiMessage = "";
  }

  processHazards(game.player1, dt);
  processHazards(game.player2, dt);
  processHazards(game.ai, dt);

  if (mode === "single" && game.ai && !game.ai.capsized) {
    if (dist(game.ai, game.player1) < 105 && game.elapsed > game.aiDirector.attackUnlockedAt) {
      attack(game.ai, game.player1, dt);
    }
  }

  for (const ship of humanShips()) {
    if (!ship.capsized && nearHarbourB(ship) && game.elapsed > ship.nextDockAwardAt) {
      awardScore(ship, 35, "Harbour-delivery");
      ship.speed = 0;
      ship.nextDockAwardAt = Number.POSITIVE_INFINITY;
      commitRoundScores();
      gameState = "ended";
      resultText = `${ship.playerName || ship.playerSlot?.toUpperCase() || "Player"} reached Harbour B`;
      return;
    }
  }

  if (humanShips().every((ship) => ship.capsized)) {
    commitRoundScores();
    gameState = "ended";
    resultText = "All player ships capsized";
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
  }
}

function drawDynamicDangers() {
  for (const dz of dynamicDangers) {
    ctx.beginPath();
    ctx.arc(dz.x, dz.y, dz.r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(dz.x, dz.y, dz.r * 0.45, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(214, 236, 246, 0.34)";
    ctx.fill();
  }
}

function drawHarbours() {
  ctx.beginPath();
  ctx.arc(HarbourA.x, HarbourA.y, HarbourA.r, 0, Math.PI * 2);
  ctx.fillStyle = "#2f8f62";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(HarbourB.x, HarbourB.y, HarbourB.r, 0, Math.PI * 2);
  ctx.fillStyle = "#3f6fb8";
  ctx.fill();

  ctx.fillStyle = "#f2f8fb";
  ctx.font = "18px Segoe UI";
  ctx.fillText("Harbour A", HarbourA.x - 38, HarbourA.y + 6);
  ctx.fillText("Harbour B", HarbourB.x - 38, HarbourB.y + 6);
}

function drawShip(ship, label) {
  if (!ship) return;

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

  if (ship.hitFlash > 0) {
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 70, 70, 0.9)";
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  ctx.restore();

  const hpPct = clamp(ship.hp / (ship.maxHull || 100), 0, 1);
  ctx.fillStyle = "rgba(17, 33, 47, 0.8)";
  ctx.fillRect(ship.x - 26, ship.y - 30, 52, 7);
  ctx.fillStyle = hpPct > 0.35 ? "#58cc7c" : "#f87254";
  ctx.fillRect(ship.x - 26, ship.y - 30, 52 * hpPct, 7);

  ctx.fillStyle = "#ecf5f9";
  ctx.font = "14px Segoe UI";
  ctx.fillText(label, ship.x - 22, ship.y - 36);
}

function drawPirateRaiders() {
  for (const raider of game.pirateRaiders) {
    drawShip(raider, "Raider");
  }
}

function drawSeaCreatures() {
  for (const creature of game.seaCreatures) {
    ctx.save();
    ctx.translate(creature.x, creature.y);
    ctx.rotate(creature.angle);
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

function drawMissiles() {
  for (const m of game.missiles) {
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
    const pulse = 0.55 + Math.sin(alert.pulse) * 0.45;
    ctx.save();
    ctx.strokeStyle = `rgba(255, 70, 70, ${0.45 + pulse * 0.4})`;
    ctx.lineWidth = 4;
    ctx.shadowColor = "rgba(255, 40, 40, 0.85)";
    ctx.shadowBlur = 18;
    ctx.strokeRect(ship.x - 36, ship.y - 36, 72, 72);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255, 90, 90, 0.95)";
    ctx.font = "bold 16px Segoe UI";
    ctx.fillText(alert.label, ship.x - 44, ship.y - 46);
    ctx.restore();
  }
}

function drawFloatingScores() {
  for (const popup of game.floatingScores) {
    const alpha = 1 - popup.age / popup.ttl;
    const scale = 1 + Math.sin((popup.age / popup.ttl) * Math.PI) * 0.22;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(popup.x, popup.y);
    ctx.scale(scale, scale);
    ctx.font = "bold 20px Segoe UI";
    ctx.fillStyle = popup.color || "#ffd75e";
    ctx.fillText("+", -20, 0);
    ctx.fillStyle = "#f5fbff";
    ctx.fillText(popup.value.replace("+", ""), -4, 0);
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
  if (item.premiumPack && !game.profiles.entitlements[item.premiumPack]) {
    const pack = PREMIUM_PACKS[item.premiumPack];
    setUiMessage(`${item.name} requires ${pack.name}`);
    return;
  }
  if (item.kind === "gadget" && profile.owned[item.id]) {
    setUiMessage(`${item.name} already owned by ${profile.name}`);
    return;
  }
  if (item.kind === "ship" && isShipOwned(profile, item)) {
    setUiMessage(`${item.name} already unlocked for ${profile.name}`);
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

function renameShopProfile() {
  const profile = getProfile(game.shopSlot);
  const value = prompt("Enter player name", profile.name);
  if (!value) return;
  const nextName = value.trim().slice(0, 18);
  if (!nextName) return;
  profile.name = nextName;
  saveProfiles();
  setUiMessage(`Renamed to ${nextName}`);
}

function drawMiniMap() {
  const mmW = 176;
  const mmH = 108;
  const mmX = WIDTH - mmW - 10;
  const mmY = HEIGHT - mmH - 10;

  const sx = mmW / WIDTH;
  const sy = mmH / HEIGHT;

  ctx.fillStyle = "rgba(7, 24, 35, 0.54)";
  ctx.fillRect(mmX, mmY, mmW, mmH);
  ctx.strokeStyle = "rgba(217, 237, 247, 0.75)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(mmX, mmY, mmW, mmH);

  for (const hz of hazards) {
    if (hz.kind !== "island") continue;
    const x = mmX + hz.x * sx;
    const y = mmY + hz.y * sy;
    const r = Math.max(1.5, hz.r * sx);

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#7db86a";
    ctx.fill();
    ctx.strokeStyle = "#223f17";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  const drawDot = (entity, color) => {
    if (!entity || entity.capsized) return;
    ctx.beginPath();
    ctx.arc(mmX + entity.x * sx, mmY + entity.y * sy, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  };

  drawDot(game.player1, game.player1 && game.player1.displayColor ? game.player1.displayColor : "#2f7ef7");
  drawDot(game.player2, game.player2 && game.player2.displayColor ? game.player2.displayColor : "#ffd56a");
  drawDot(game.ai, game.ai && game.ai.displayColor ? game.ai.displayColor : "#f0d034");
  for (const raider of game.pirateRaiders) {
    drawDot(raider, raider.displayColor || "#ffc941");
  }

  ctx.fillStyle = "#eef8fd";
  ctx.font = "12px Segoe UI";
  ctx.fillText("Map", mmX + 8, mmY + 15);
}

function drawHud() {
  ctx.fillStyle = "rgba(5, 17, 25, 0.34)";
  ctx.fillRect(8, 8, mode === "local" ? 470 : 328, 46);
  ctx.fillStyle = "#ecf5f9";
  ctx.font = "14px Segoe UI";
  ctx.fillText(`Mode ${mode === "single" ? "Single" : "Local"}`, 16, 25);
  ctx.fillText(`Time ${game.elapsed.toFixed(1)}s`, 140, 25);
  ctx.fillText(`Wind ${game.wind.x.toFixed(0)},${game.wind.y.toFixed(0)}`, 236, 25);
  ctx.fillText(`P1 HP ${Math.ceil(game.player1 ? game.player1.hp : 0)} | Pts ${getProfile("p1").points}`, 16, 43);
  if (mode === "local" && game.player2) {
    ctx.fillText(`P2 HP ${Math.ceil(game.player2.hp)} | Pts ${getProfile("p2").points}`, 238, 43);
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
    ctx.strokeRect(x, y, 228, 44);
    ctx.fillStyle = "#e7f6ff";
    ctx.font = "13px Segoe UI";
    ctx.fillText(`${slot.toUpperCase()} Dmg ${Math.round(damage)} | Res ${reserveLeft}`, x + 8, y + 16);
    ctx.fillText(activePlan ? `${activePlan.label} ${progress}%` : (ship.repairLast || "Ready"), x + 8, y + 33);

    const canRepair = damage > 0 && reserveLeft > 0 && !ship.capsized;
    const btnX = x + 156;
    const btnY = y + 22;
    const btnW = 64;
    const btnH = 18;
    ctx.fillStyle = canRepair ? "rgba(34, 114, 78, 0.95)" : "rgba(67, 74, 82, 0.7)";
    ctx.fillRect(btnX, btnY, btnW, btnH);
    ctx.strokeStyle = canRepair ? "rgba(204, 255, 226, 0.5)" : "rgba(181, 192, 203, 0.3)";
    ctx.strokeRect(btnX, btnY, btnW, btnH);
    ctx.fillStyle = "#f4fffa";
    ctx.fillText("Fix", btnX + 18, btnY + 13);

    if (canRepair) {
      registerUiRect(btnX, btnY, btnW, btnH, () => attemptRepairForSlot(slot));
    }

    ctx.fillStyle = "#cde6f5";
    ctx.fillText(`${profile.points} pts`, x + 158, y + 16);
  };

  drawRepairWidget(game.player1, "p1", 8, HEIGHT - 58, "rgba(151, 214, 255, 0.5)");
  if (mode === "local" && game.player2) {
    drawRepairWidget(game.player2, "p2", 244, HEIGHT - 58, "rgba(255, 218, 161, 0.5)");
  }

  ctx.fillStyle = "#ffd182";
  ctx.font = "12px Segoe UI";
  ctx.fillText("H: P1 fix  /: P2 fix", WIDTH - 140, HEIGHT - 16);

  if (game.uiMessage) {
    ctx.fillStyle = "#d8f2ff";
    ctx.font = "13px Segoe UI";
    ctx.fillText(game.uiMessage, 14, HEIGHT - 68);
  }
}

function drawMenu() {
  ctx.fillStyle = "rgba(2, 12, 18, 0.76)";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const glow = ctx.createLinearGradient(370, 120, 780, 120);
  glow.addColorStop(0, "#6ce5d9");
  glow.addColorStop(1, "#f9c15f");
  ctx.fillStyle = glow;
  ctx.font = "bold 58px Segoe UI";
  ctx.fillText("Harbour Run", 390, 166);

  ctx.fillStyle = "rgba(6, 24, 36, 0.88)";
  ctx.fillRect(340, 198, 520, 330);
  ctx.strokeStyle = "rgba(181, 235, 255, 0.35)";
  ctx.lineWidth = 2;
  ctx.strokeRect(340, 198, 520, 330);

  ctx.fillStyle = "#deedf6";
  ctx.font = "20px Segoe UI";
  ctx.fillText("Choose mode, tune settings, then launch.", 372, 236);

  ctx.font = "26px Segoe UI";
  const menuButtons = [
    { label: "Single Player", modeTag: "single", x: 372, y: 258, w: 220, h: 46, action: () => { mode = "single"; } },
    { label: "Local 2 Player", modeTag: "local", x: 608, y: 258, w: 220, h: 46, action: () => { mode = "local"; } },
    { label: "Choose Ships", x: 372, y: 318, w: 456, h: 46, action: () => openShipSelect() },
    { label: "Shop", x: 372, y: 378, w: 220, h: 46, action: () => { switchShopSlot("p1"); gameState = "shop"; } },
    { label: "Settings", x: 608, y: 378, w: 220, h: 46, action: () => { gameState = "settings"; } },
    { label: "Leaderboard", x: 372, y: 438, w: 456, h: 46, action: () => { gameState = "leaderboard"; } }
  ];
  for (const button of menuButtons) {
    const selected = button.modeTag && mode === button.modeTag;
    ctx.fillStyle = selected ? "rgba(46, 105, 122, 0.94)" : "rgba(14, 45, 62, 0.88)";
    ctx.fillRect(button.x, button.y, button.w, button.h);
    ctx.strokeStyle = selected ? "rgba(200, 255, 241, 0.72)" : "rgba(235, 247, 255, 0.28)";
    ctx.strokeRect(button.x, button.y, button.w, button.h);
    ctx.fillStyle = "#ecf5f9";
    ctx.fillText(button.label, button.x + 14, button.y + 31);
    if (selected) {
      ctx.fillStyle = "#b8ffe1";
      ctx.font = "bold 15px Segoe UI";
      ctx.fillText("ACTIVE", button.x + button.w - 82, button.y + 29);
      ctx.font = "26px Segoe UI";
    }
    registerUiRect(button.x, button.y, button.w, button.h, button.action);
  }
  ctx.font = "18px Segoe UI";
  ctx.fillStyle = "#ffd182";
  ctx.fillText("Selected Mode:", 372, 522);
  ctx.fillStyle = mode === "single" ? "#90f0d0" : "#ffd998";
  ctx.fillText(mode === "single" ? "Single Player vs CPU" : "Local 2 Player", 512, 522);

  ctx.fillStyle = "#d8e9f2";
  ctx.font = "18px Segoe UI";
  ctx.fillText("N: Rename active player   P: Premium test toggle   K: Settings", 372, 550);

  ctx.fillStyle = "#9ed7ff";
  ctx.font = "20px Segoe UI";
  const p1 = getProfile("p1");
  const p2 = getProfile("p2");
  ctx.fillText(`P1 ${p1.name}: ${p1.points} pts | Spent ${p1.shopSpent} | Earned ${p1.shopEarned}`, 372, 582);
  ctx.fillStyle = "#ffd889";
  ctx.fillText(`P2 ${p2.name}: ${p2.points} pts | Spent ${p2.shopSpent} | Earned ${p2.shopEarned}`, 372, 610);
}

function drawShopScreen() {
  const panelX = 88;
  const panelY = 58;
  const panelW = WIDTH - 176;
  const panelH = HEIGHT - 116;
  const entries = getShopEntries();
  const maxRows = 6;
  const startIndex = Math.max(0, Math.min(game.shopIndex - Math.floor(maxRows / 2), Math.max(0, entries.length - maxRows)));
  const visible = entries.slice(startIndex, startIndex + maxRows);

  ctx.fillStyle = "rgba(5, 16, 26, 0.92)";
  ctx.fillRect(panelX, panelY, panelW, panelH);
  ctx.strokeStyle = "#d7edf9";
  ctx.lineWidth = 2;
  ctx.strokeRect(panelX, panelY, panelW, panelH);

  const profile = getProfile(game.shopSlot);
  const p1 = getProfile("p1");
  const p2 = getProfile("p2");
  ctx.fillStyle = "#f4fbff";
  ctx.font = "34px Segoe UI";
  ctx.fillText("Harbour Shop", panelX + 34, panelY + 52);
  ctx.font = "20px Segoe UI";
  ctx.fillText(`Buyer: ${profile.name} (${game.shopSlot.toUpperCase()})`, panelX + 34, panelY + 86);
  ctx.fillText(`Buyer Points: ${profile.points}`, panelX + 34, panelY + 114);
  ctx.fillStyle = "#8fd8ff";
  ctx.fillText(`P1 ${p1.name}: ${p1.points} (Spent ${p1.shopSpent}, Earned ${p1.shopEarned})`, panelX + 34, panelY + 142);
  ctx.fillStyle = "#ffd6a3";
  ctx.fillText(`P2 ${p2.name}: ${p2.points} (Spent ${p2.shopSpent}, Earned ${p2.shopEarned})`, panelX + 34, panelY + 168);
  ctx.fillStyle = "#f4fbff";
  ctx.fillText(`Base game: FREE`, panelX + 350, panelY + 86);
  ctx.fillText(`Premium Fleet: ${game.profiles.entitlements.specialistFleet ? "Owned" : "Not owned"}`, panelX + 350, panelY + 114);

  ctx.font = "17px Segoe UI";
  for (let i = 0; i < visible.length; i += 1) {
    const item = visible[i];
    const actualIndex = startIndex + i;
    const y = panelY + 216 + i * 48;
    const owned = item.kind === "ship" ? isShipOwned(profile, item) : !!profile.owned[item.id];
    const premiumBlocked = item.premiumPack && !game.profiles.entitlements[item.premiumPack];
    if (actualIndex === game.shopIndex) {
      ctx.fillStyle = "rgba(91, 145, 177, 0.45)";
      ctx.fillRect(panelX + 24, y - 24, panelW - 48, 42);
    }
    drawCatalogIcon(item, panelX + 52, y - 3, 24, item.kind === "ship");
    ctx.fillStyle = owned ? "#89d98b" : premiumBlocked ? "#d0a1a1" : "#f4fbff";
    const priceLabel = item.premiumPack ? "premium" : `${item.cost}`;
    ctx.fillText(`${item.name} (${priceLabel})`, panelX + 78, y);
    ctx.fillStyle = "#c9dfea";
    const suffix = item.premiumPack ? ` [${PREMIUM_PACKS[item.premiumPack].name}]` : "";
    ctx.fillText(`${item.desc}${suffix}`, panelX + 355, y);
    registerUiRect(panelX + 24, y - 24, panelW - 48, 42, () => {
      game.shopIndex = actualIndex;
    });
  }

  const selected = entries[game.shopIndex];
  const selectedOwned = selected ? (selected.kind === "ship" ? isShipOwned(profile, selected) : !!profile.owned[selected.id]) : false;
  ctx.fillStyle = "rgba(12, 39, 55, 0.9)";
  ctx.fillRect(panelX + 24, panelY + panelH - 126, panelW - 48, 58);
  ctx.strokeStyle = "rgba(166, 218, 244, 0.35)";
  ctx.strokeRect(panelX + 24, panelY + panelH - 126, panelW - 48, 58);
  ctx.fillStyle = "#e8f6ff";
  ctx.font = "17px Segoe UI";
  if (selected) {
    ctx.fillText(`Selected: ${selected.name} | ${selectedOwned ? "Owned" : "Not owned"} | Price: ${selected.premiumPack ? "Premium" : selected.cost}`, panelX + 36, panelY + panelH - 93);
  }

  const buyBtn = { x: panelX + panelW - 264, y: panelY + panelH - 118, w: 104, h: 42 };
  const sellBtn = { x: panelX + panelW - 146, y: panelY + panelH - 118, w: 104, h: 42 };
  ctx.fillStyle = "rgba(27, 98, 72, 0.92)";
  ctx.fillRect(buyBtn.x, buyBtn.y, buyBtn.w, buyBtn.h);
  ctx.strokeStyle = "rgba(196, 255, 224, 0.45)";
  ctx.strokeRect(buyBtn.x, buyBtn.y, buyBtn.w, buyBtn.h);
  ctx.fillStyle = "#e7fff4";
  ctx.fillText("Buy", buyBtn.x + 33, buyBtn.y + 27);
  registerUiRect(buyBtn.x, buyBtn.y, buyBtn.w, buyBtn.h, () => buySelectedItem());

  ctx.fillStyle = "rgba(91, 73, 31, 0.92)";
  ctx.fillRect(sellBtn.x, sellBtn.y, sellBtn.w, sellBtn.h);
  ctx.strokeStyle = "rgba(255, 229, 177, 0.45)";
  ctx.strokeRect(sellBtn.x, sellBtn.y, sellBtn.w, sellBtn.h);
  ctx.fillStyle = "#fff3de";
  ctx.fillText("Sell", sellBtn.x + 33, sellBtn.y + 27);
  registerUiRect(sellBtn.x, sellBtn.y, sellBtn.w, sellBtn.h, () => sellSelectedItem());

  ctx.fillStyle = "#ffd182";
  ctx.font = "16px Segoe UI";
  ctx.fillText("Up/Down: Select  Enter: Buy  Backspace: Sell  Tab: Switch Player  N: Rename  Esc: Back", panelX + 34, panelY + panelH - 52);
  ctx.fillText(`Showing ${startIndex + 1}-${startIndex + visible.length} of ${entries.length}`, panelX + 34, panelY + panelH - 26);
}

function drawSettingsScreen() {
  const panelX = 110;
  const panelY = 52;
  const panelW = WIDTH - 220;
  const panelH = HEIGHT - 104;

  ctx.fillStyle = "rgba(7, 19, 31, 0.93)";
  ctx.fillRect(panelX, panelY, panelW, panelH);
  ctx.strokeStyle = "rgba(186, 234, 255, 0.42)";
  ctx.lineWidth = 2;
  ctx.strokeRect(panelX, panelY, panelW, panelH);

  ctx.fillStyle = "#e9f8ff";
  ctx.font = "34px Segoe UI";
  ctx.fillText("Settings", panelX + 28, panelY + 46);

  ctx.font = "20px Segoe UI";
  ctx.fillStyle = "#bde8ff";
  ctx.fillText(`Gameplay Preset: ${game.settings.gameplayPreset.toUpperCase()}`, panelX + 28, panelY + 90);
  ctx.fillText(`Wind Strength: ${Math.round(game.settings.windScale * 100)}%`, panelX + 28, panelY + 120);
  ctx.fillText(`Hazard Strength: ${Math.round(game.settings.hazardScale * 100)}%`, panelX + 28, panelY + 150);

  const presetRect = { x: panelX + 390, y: panelY + 66, w: 210, h: 34 };
  ctx.fillStyle = "rgba(24, 73, 97, 0.9)";
  ctx.fillRect(presetRect.x, presetRect.y, presetRect.w, presetRect.h);
  ctx.strokeStyle = "rgba(187, 230, 252, 0.45)";
  ctx.strokeRect(presetRect.x, presetRect.y, presetRect.w, presetRect.h);
  ctx.fillStyle = "#f3fbff";
  ctx.font = "18px Segoe UI";
  ctx.fillText("Cycle Preset", presetRect.x + 52, presetRect.y + 23);
  registerUiRect(presetRect.x, presetRect.y, presetRect.w, presetRect.h, () => {
    const idx = GAMEPLAY_PRESETS.indexOf(game.settings.gameplayPreset);
    game.settings.gameplayPreset = GAMEPLAY_PRESETS[(idx + 1) % GAMEPLAY_PRESETS.length];
    if (game.settings.gameplayPreset === "calm") {
      game.settings.windScale = 0.75;
      game.settings.hazardScale = 0.75;
    } else if (game.settings.gameplayPreset === "chaos") {
      game.settings.windScale = 1.25;
      game.settings.hazardScale = 1.25;
    } else {
      game.settings.windScale = 1;
      game.settings.hazardScale = 1;
    }
    saveSettings();
  });

  const keyEntries = Object.entries(KEYBIND_LABELS);
  ctx.font = "16px Segoe UI";
  for (let i = 0; i < keyEntries.length; i += 1) {
    const [action, label] = keyEntries[i];
    const col = i < 5 ? 0 : 1;
    const row = i % 5;
    const x = panelX + 28 + col * 410;
    const y = panelY + 206 + row * 66;
    const isWaiting = game.keyRebindAction === action;

    ctx.fillStyle = "rgba(10, 38, 55, 0.9)";
    ctx.fillRect(x, y, 380, 52);
    ctx.strokeStyle = isWaiting ? "#ffd182" : "rgba(163, 216, 240, 0.35)";
    ctx.strokeRect(x, y, 380, 52);

    ctx.fillStyle = "#e6f5fb";
    ctx.fillText(label, x + 14, y + 22);
    ctx.fillStyle = isWaiting ? "#ffd182" : "#8cead9";
    ctx.fillText(isWaiting ? "Press a key..." : keyName(game.settings.keybinds[action]), x + 14, y + 43);

    registerUiRect(x, y, 380, 52, () => {
      game.keyRebindAction = action;
      setUiMessage(`Rebinding ${label}. Press a key.`);
    });
  }

  ctx.fillStyle = "#ffd182";
  ctx.font = "16px Segoe UI";
  ctx.fillText("Click any key binding box, then press a key. Esc: back to menu", panelX + 28, panelY + panelH - 22);
}

function drawShipSelectionScreen() {
  const slot = game.shipSelectSlot;
  const profile = getProfile(slot);
  const shipDef = getShipDefinition(game.shipSelections[slot]);
  const owned = isShipOwned(profile, shipDef);
  const panelX = 88;
  const panelY = 64;
  const panelW = WIDTH - 176;
  const panelH = HEIGHT - 128;

  ctx.fillStyle = "rgba(6, 18, 28, 0.92)";
  ctx.fillRect(panelX, panelY, panelW, panelH);
  ctx.strokeStyle = "#d7edf9";
  ctx.lineWidth = 2;
  ctx.strokeRect(panelX, panelY, panelW, panelH);

  ctx.fillStyle = "#f7fbff";
  ctx.font = "34px Segoe UI";
  ctx.fillText("Select Your Ship", panelX + 36, panelY + 50);
  ctx.font = "20px Segoe UI";
  ctx.fillText(`Active Player: ${profile.name} (${slot.toUpperCase()})`, panelX + 36, panelY + 84);
  ctx.fillText(`Mode: ${mode === "single" ? "Single Player" : "Local 2 Player"}`, panelX + 430, panelY + 84);

  drawCatalogIcon(shipDef, panelX + 140, panelY + 180, 72, true);
  ctx.fillStyle = shipDef.color;
  ctx.font = "28px Segoe UI";
  ctx.fillText(shipDef.name, panelX + 200, panelY + 160);
  ctx.fillStyle = "#dbe9f1";
  ctx.font = "20px Segoe UI";
  ctx.fillText(`Category: ${shipDef.category}`, panelX + 200, panelY + 194);
  ctx.fillText(`Hull: ${shipDef.stats.hp}`, panelX + 200, panelY + 226);
  ctx.fillText(`Speed: ${shipDef.stats.maxSpeed}`, panelX + 200, panelY + 258);
  ctx.fillText(`Turn: ${shipDef.stats.turnRate.toFixed(2)}`, panelX + 200, panelY + 290);
  ctx.fillText(shipDef.desc, panelX + 200, panelY + 322);

  ctx.fillStyle = owned ? "#89d98b" : shipDef.premiumPack ? "#d2a8ff" : "#ffb18c";
  const statusText = owned ? "Unlocked" : shipDef.premiumPack ? `Requires ${PREMIUM_PACKS[shipDef.premiumPack].name}` : `Buy in shop for ${shipDef.cost} points`;
  ctx.fillText(statusText, panelX + 200, panelY + 356);

  ctx.fillStyle = "#eef7fb";
  ctx.font = "17px Segoe UI";
  for (let i = 0; i < SHIP_CATALOG.length; i += 1) {
    const ship = SHIP_CATALOG[i];
    const x = panelX + 36 + i * 128;
    const y = panelY + panelH - 148;
    const unlocked = isShipOwned(profile, ship);
    if (ship.id === shipDef.id) {
      ctx.fillStyle = "rgba(91, 145, 177, 0.45)";
      ctx.fillRect(x - 12, y - 18, 112, 92);
    }
    drawCatalogIcon(ship, x + 22, y + 22, 28, true);
    ctx.fillStyle = unlocked ? ship.color : "#8d99a5";
    ctx.fillText(ship.category, x + 44, y + 18);
    ctx.fillStyle = "#cfdeea";
    ctx.font = "14px Segoe UI";
    ctx.fillText(ship.name, x + 4, y + 46);
    ctx.fillText(unlocked ? "Ready" : ship.premiumPack ? "Premium" : `${ship.cost} pts`, x + 4, y + 66);
    ctx.font = "17px Segoe UI";
    registerUiRect(x - 12, y - 18, 112, 92, () => {
      game.shipSelections[slot] = ship.id;
    });
  }

  ctx.fillStyle = "#ffd182";
  ctx.fillText("Left/Right: Change Ship  Tab: Switch Player  O: Shop  Enter: Launch  Esc: Back", panelX + 36, panelY + panelH - 28);
  ctx.fillStyle = "rgba(24, 73, 57, 0.92)";
  ctx.fillRect(panelX + panelW - 180, panelY + panelH - 58, 146, 36);
  ctx.strokeStyle = "rgba(221, 255, 235, 0.3)";
  ctx.strokeRect(panelX + panelW - 180, panelY + panelH - 58, 146, 36);
  ctx.fillStyle = "#e9fff2";
  ctx.fillText("Launch Round", panelX + panelW - 154, panelY + panelH - 34);
  registerUiRect(panelX + panelW - 180, panelY + panelH - 54, 146, 32, () => confirmShipSelectionAndStart());
}

function drawLeaderboardScreen() {
  ctx.fillStyle = "rgba(6, 18, 28, 0.78)";
  ctx.fillRect(190, 100, WIDTH - 380, HEIGHT - 200);
  ctx.strokeStyle = "#d7edf9";
  ctx.lineWidth = 2;
  ctx.strokeRect(190, 100, WIDTH - 380, HEIGHT - 200);

  ctx.fillStyle = "#f4fbff";
  ctx.font = "36px Segoe UI";
  ctx.fillText("Leaderboard", 450, 152);

  const entries = leaderboardEntries();
  ctx.font = "22px Segoe UI";
  if (entries.length === 0) {
    ctx.fillText("No scores yet.", 490, 240);
  } else {
    for (let i = 0; i < entries.length; i += 1) {
      const row = entries[i];
      ctx.fillText(`${i + 1}. ${row.name}`, 260, 220 + i * 44);
      ctx.fillText(`${row.points}`, 820, 220 + i * 44);
    }
  }

  const clearBoardBtn = { x: 250, y: HEIGHT - 190, w: 240, h: 44 };
  const clearP1Btn = { x: 515, y: HEIGHT - 190, w: 200, h: 44 };
  const clearP2Btn = { x: 740, y: HEIGHT - 190, w: 200, h: 44 };

  ctx.fillStyle = "rgba(110, 56, 56, 0.92)";
  ctx.fillRect(clearBoardBtn.x, clearBoardBtn.y, clearBoardBtn.w, clearBoardBtn.h);
  ctx.strokeStyle = "rgba(255, 194, 194, 0.45)";
  ctx.strokeRect(clearBoardBtn.x, clearBoardBtn.y, clearBoardBtn.w, clearBoardBtn.h);
  ctx.fillStyle = "#ffeaea";
  ctx.font = "18px Segoe UI";
  ctx.fillText("Clear Leaderboard", clearBoardBtn.x + 28, clearBoardBtn.y + 28);
  registerUiRect(clearBoardBtn.x, clearBoardBtn.y, clearBoardBtn.w, clearBoardBtn.h, () => clearLeaderboardScores());

  ctx.fillStyle = "rgba(56, 86, 110, 0.92)";
  ctx.fillRect(clearP1Btn.x, clearP1Btn.y, clearP1Btn.w, clearP1Btn.h);
  ctx.strokeStyle = "rgba(194, 227, 255, 0.45)";
  ctx.strokeRect(clearP1Btn.x, clearP1Btn.y, clearP1Btn.w, clearP1Btn.h);
  ctx.fillStyle = "#eaf7ff";
  ctx.fillText("Clear P1 Points", clearP1Btn.x + 27, clearP1Btn.y + 28);
  registerUiRect(clearP1Btn.x, clearP1Btn.y, clearP1Btn.w, clearP1Btn.h, () => clearPlayerPoints("p1"));

  ctx.fillStyle = "rgba(110, 92, 56, 0.92)";
  ctx.fillRect(clearP2Btn.x, clearP2Btn.y, clearP2Btn.w, clearP2Btn.h);
  ctx.strokeStyle = "rgba(255, 239, 194, 0.45)";
  ctx.strokeRect(clearP2Btn.x, clearP2Btn.y, clearP2Btn.w, clearP2Btn.h);
  ctx.fillStyle = "#fff6e6";
  ctx.fillText("Clear P2 Points", clearP2Btn.x + 27, clearP2Btn.y + 28);
  registerUiRect(clearP2Btn.x, clearP2Btn.y, clearP2Btn.w, clearP2Btn.h, () => clearPlayerPoints("p2"));

  ctx.fillStyle = "#ffd182";
  ctx.font = "18px Segoe UI";
  ctx.fillText("Esc: Back   C: Clear Leaderboard   1: Clear P1   2: Clear P2", 340, HEIGHT - 120);
}

function drawEndScreen() {
  ctx.fillStyle = "rgba(4, 13, 20, 0.68)";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = "#f7fbff";
  ctx.font = "44px Segoe UI";
  ctx.fillText(resultText, 300, 300);
  ctx.font = "30px Segoe UI";
  ctx.fillText("Press R for menu", 488, 360);
}

function render() {
  document.body.classList.toggle("playing-mode", gameState === "playing");

  clearUiRects();
  ctx.clearRect(0, 0, WIDTH, HEIGHT);

  const grad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  grad.addColorStop(0, "#2a6887");
  grad.addColorStop(1, "#16465f");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  drawHarbours();
  drawHazards();
  drawDynamicDangers();
  drawSeaCreatures();
  drawUnderwaterEnemies();
  drawMissiles();

  drawShip(game.player1, game.player1 ? game.player1.playerName : "P1");
  if (mode === "local") drawShip(game.player2, game.player2 ? `${game.player2.playerName}` : "P2");
  if (mode === "single") drawShip(game.ai, "CPU Pirate");
  if (mode === "single") drawPirateRaiders();
  drawFloatingScores();
  drawTargetAlerts();

  if (gameState === "playing") {
    drawHud();
    drawMiniMap();
  }

  if (gameState === "menu") drawMenu();
  if (gameState === "shop") drawShopScreen();
  if (gameState === "settings") drawSettingsScreen();
  if (gameState === "shipSelect") drawShipSelectionScreen();
  if (gameState === "leaderboard") drawLeaderboardScreen();
  if (gameState === "ended") drawEndScreen();
}

function handlePointerInteraction(clientX, clientY) {
  ensureAudio();
  const rect = canvas.getBoundingClientRect();
  const scaleX = WIDTH / rect.width;
  const scaleY = HEIGHT / rect.height;
  const x = (clientX - rect.left) * scaleX;
  const y = (clientY - rect.top) * scaleY;
  const hit = hitUiRect(x, y);
  if (hit) {
    hit.onClick();
  }
}

function tick(now) {
  const dt = Math.min(0.033, (now - lastTime) / 1000);
  lastTime = now;

  handleGameLogic(dt);
  render();

  requestAnimationFrame(tick);
}

window.addEventListener("keydown", (e) => {
  ensureAudio();
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
    "Slash"
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

  keys.add(e.code);

  if (e.code === "Digit1" && gameState === "menu") {
    mode = "single";
  }
  if (e.code === "Digit2" && gameState === "menu") {
    mode = "local";
  }
  if (e.code === "Enter" && (gameState === "menu" || gameState === "ended")) {
    openShipSelect();
  }
  if (e.code === "KeyR") {
    if (gameState === "playing") {
      commitRoundScores();
    }
    gameState = "menu";
  }

  if (e.code === "KeyK" && gameState === "menu") {
    gameState = "settings";
  }

  if (gameState === "menu") {
    if (e.code === "KeyO") {
      switchShopSlot("p1");
      gameState = "shop";
    }
    if (e.code === "KeyL") {
      gameState = "leaderboard";
    }
    if (e.code === "KeyN") {
      renameShopProfile();
    }
    if (e.code === "KeyP") {
      togglePremiumPackForTesting();
    }
  }

  if (gameState === "settings") {
    if (e.code === "Escape") {
      game.keyRebindAction = null;
      gameState = "menu";
    }
  }

  if (gameState === "shipSelect") {
    if (e.code === "Escape") gameState = "menu";
    if (e.code === "ArrowLeft") cycleShipSelection(-1);
    if (e.code === "ArrowRight") cycleShipSelection(1);
    if (e.code === "Tab") {
      e.preventDefault();
      if (mode === "local") {
        game.shipSelectSlot = game.shipSelectSlot === "p1" ? "p2" : "p1";
      }
    }
    if (e.code === "KeyO") {
      switchShopSlot(game.shipSelectSlot);
      gameState = "shop";
    }
    if (e.code === "Enter") confirmShipSelectionAndStart();
  }

  if (gameState === "shop") {
    if (e.code === "Escape") gameState = "menu";
    if (e.code === "ArrowUp") game.shopIndex = (game.shopIndex + getShopEntries().length - 1) % getShopEntries().length;
    if (e.code === "ArrowDown") game.shopIndex = (game.shopIndex + 1) % getShopEntries().length;
    if (e.code === "Tab") {
      e.preventDefault();
      switchShopSlot(game.shopSlot === "p1" ? "p2" : "p1");
    }
    if (e.code === "Enter") buySelectedItem();
    if (e.code === "Backspace") {
      e.preventDefault();
      sellSelectedItem();
    }
    if (e.code === "KeyN") renameShopProfile();
    if (e.code === "KeyP") togglePremiumPackForTesting();
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
    if (e.code === "KeyH" && game.player1) {
      attemptRepairForSlot("p1");
    }
    if (e.code === "Slash" && mode === "local" && game.player2) {
      attemptRepairForSlot("p2");
    }

    if (e.code === game.settings.keybinds.p1Attack && mode === "single" && game.player1) {
      attack(game.player1, game.ai);
    }
    if (e.code === game.settings.keybinds.p1Attack && mode === "local" && game.player1) {
      attack(game.player1, game.player2);
    }
    if (e.code === game.settings.keybinds.p2Attack && mode === "local" && game.player2) {
      attack(game.player2, game.player1);
    }
  }
});

window.addEventListener("keyup", (e) => {
  keys.delete(e.code);
});

canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  handlePointerInteraction(e.clientX, e.clientY);
});

window.addEventListener("wheel", (e) => {
  e.preventDefault();
}, { passive: false });

window.addEventListener("touchmove", (e) => {
  e.preventDefault();
}, { passive: false });

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      // Ignore offline cache registration errors during local development.
    });
  });
}

game.profiles = loadProfiles();
game.settings = loadSettings();
requestAnimationFrame(tick);
