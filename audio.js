// Harbour Run sound. Recorded CC0 clips in assets/audio/ (see CREDITS.md
// there) are used where we have them; everything else, and anything that
// fails to load, is made on the fly with the Web Audio API (noise, filters
// and oscillators). Loaded before game.js; it only touches the game's
// globals inside functions, once the game is running.
//
// Sounds are placed in the world: they get quieter with distance from what
// the camera follows and are panned left/right (relative to the ship's bow in
// the chase view).

const SOUND_LEVELS = [
  { name: "Off", volume: 0 },
  { name: "Low", volume: 0.35 },
  { name: "Medium", volume: 0.7 },
  { name: "High", volume: 1 }
];

const sfx = {
  out: null,
  white: null,
  brown: null,
  loops: null,
  samples: {},
  intro: null, // the intro music's volume control while it plays
  introDone: false,
  nextGullAt: 4,
  nextWaveAt: 3
};

const SAMPLE_NAMES = [
  "intro", "sea_loop", // first: heard as the game launches
  "gull_1","gull_2", "gull_3", "gull_4", "gull_5", "gull_6", "gull_7",
  "wave_1", "wave_2", "wave_3", "thunder", "rain_loop",
  "cannon_fire", "hit_ship", "hit_rock", "ship_sink", "explosion",
  "missile_launch", "bubbles", "volcano_rumble", "lava_loop", "ship_bump",
  "level_complete", "ui_move", "ui_click", "ui_confirm", "ui_back", "ui_error"
];

// Loads the clips in the background; until one arrives (or if it can't),
// its sound is synthesised instead.
function loadSamples(ac) {
  for (const name of SAMPLE_NAMES) {
    fetch(`assets/audio/${name}.ogg`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
      .then((data) => ac.decodeAudioData(data))
      .then((buffer) => {
        sfx.samples[name] = buffer;
        if (name === "sea_loop") useLoopSample(sfx.loops.sea, buffer);
        if (name === "rain_loop") useLoopSample(sfx.loops.rain, buffer);
        if (name === "lava_loop") useLoopSample(sfx.loops.lava, buffer);
        if (name === "intro") playIntro();
      })
      .catch(() => {});
  }
}

// Plays a clip into `dest`; false when it isn't loaded (caller synthesises).
function sample(dest, name, o = {}) {
  const buffer = sfx.samples[name];
  if (!buffer) return false;
  const ac = game.audioContext;
  const start = o.start || ac.currentTime;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = o.rate || 1;
  const g = ac.createGain();
  g.gain.value = o.gain || 1;
  if (o.cutAt) {
    // Fade long clips out early so repeats don't pile up.
    g.gain.setValueAtTime(o.gain || 1, start + o.cutAt);
    g.gain.linearRampToValueAtTime(0.0001, start + o.cutAt + 1.5);
  }
  src.connect(g);
  g.connect(dest);
  src.start(start);
  if (o.cutAt) src.stop(start + o.cutAt + 1.6);
  return true;
}

function pick(prefix, count) {
  return `${prefix}_${1 + Math.floor(Math.random() * count)}`;
}

function vary(amount = 0.08) {
  return 1 - amount + Math.random() * amount * 2;
}

function soundLevel() {
  return SOUND_LEVELS[game.settings.soundLevel] || SOUND_LEVELS[2];
}

// Called once, when the audio context is created. Builds the master output and
// starts the ambience.
function setupSound(ac) {
  const master = ac.createGain();
  master.gain.value = soundLevel().volume;
  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.ratio.value = 5;
  master.connect(limiter);
  limiter.connect(ac.destination);
  sfx.out = master;
  sfx.white = makeNoise(ac, false);
  sfx.brown = makeNoise(ac, true);
  sfx.loops = {
    sea: loop(ac, sfx.brown, "lowpass", 420, 0.7),
    surf: loop(ac, sfx.white, "bandpass", 900, 0.7),
    wake: loop(ac, sfx.white, "bandpass", 520, 0.9),
    rain: loop(ac, sfx.white, "highpass", 1800, 0.5),
    wind: loop(ac, sfx.brown, "bandpass", 380, 2),
    tsunami: loop(ac, sfx.brown, "lowpass", 280, 0.8),
    sizzle: loop(ac, sfx.white, "highpass", 3200, 0.6),
    lava: loop(ac, sfx.brown, "lowpass", 95, 0.7),
    jet: loop(ac, sfx.white, "bandpass", 900, 0.7), // carrier jets taxiing and flying
    dockHum: loop(ac, sfx.brown, "lowpass", 170, 1.2), // dockyard machinery, trucks, cranes
    dockWater: loop(ac, sfx.white, "bandpass", 650, 0.7), // the dock filling and draining
    dockWeld: loop(ac, sfx.white, "highpass", 2800, 0.8) // welding arc
  };
  sfx.engine = makeEngine(ac);
  loadSamples(ac);
}

// How each kind of ship sounds under way.
//   diesel  loudness of the engine throb (0 = no engine)
//   pitch / rise   engine note at rest, and how much it climbs with speed
//   bright  how much of the harsh top end gets through (roar vs hum)
//   chug / chugRate  the pulsing of big slow pistons
//   whine   a turbine whine instead of pistons (pitch rises with speed)
//   splash  how much water you hear slapping and spraying at speed
const ENGINE_PROFILES = {
  Sailing: { diesel: 0, pitch: 30, rise: 0, bright: 150, chug: 0, chugRate: 1, whine: 0, splash: 1.9 },
  Carrack: { diesel: 0, pitch: 30, rise: 0, bright: 150, chug: 0, chugRate: 1, whine: 0, splash: 1.6 },
  Galley: { diesel: 0, pitch: 30, rise: 0, bright: 150, chug: 0, chugRate: 1, whine: 0, splash: 1.7 },
  Carrier: { diesel: 0.22, pitch: 24, rise: 12, bright: 140, chug: 0, chugRate: 1, whine: 0, splash: 1.5 },
  Cruise: { diesel: 0.45, pitch: 30, rise: 20, bright: 210, chug: 0.08, chugRate: 6, whine: 0, splash: 1 },
  Cargo: { diesel: 1, pitch: 22, rise: 22, bright: 260, chug: 0.6, chugRate: 4.5, whine: 0, splash: 0.9 },
  Catamaran: { diesel: 0.7, pitch: 55, rise: 65, bright: 650, chug: 0.15, chugRate: 18, whine: 0, splash: 1.3 },
  Assault: { diesel: 1.3, pitch: 38, rise: 65, bright: 950, chug: 0.25, chugRate: 12, whine: 0, splash: 1.1 },
  // Gas turbine and drive whine; foil-borne it barely touches the water.
  Hydrofoil: { diesel: 0.55, pitch: 42, rise: 60, bright: 650, chug: 0.08, chugRate: 16, whine: 0.35, whinePitch: 320, whineRise: 420, splash: 1.3 },
  // A big slow diesel for a small hull: a deep, pulsing thump.
  Tug: { diesel: 1.2, pitch: 34, rise: 40, bright: 420, chug: 0.5, chugRate: 7, whine: 0, splash: 1.2 },
  Icebreaker: { diesel: 1.1, pitch: 26, rise: 24, bright: 300, chug: 0.4, chugRate: 5, whine: 0, splash: 1 },
  Tanker: { diesel: 1, pitch: 20, rise: 18, bright: 220, chug: 0.65, chugRate: 3.8, whine: 0, splash: 0.85 },
  // Triple-expansion steam engine: a slow, heavy beat.
  WarTanker: { diesel: 0.8, pitch: 18, rise: 14, bright: 170, chug: 0.8, chugRate: 2.4, whine: 0, splash: 1 },
  // Steam turbine: a smooth hum with a soft whine, hardly any piston beat.
  GasTanker: { diesel: 0.5, pitch: 26, rise: 18, bright: 200, chug: 0.1, chugRate: 5, whine: 0.2, whinePitch: 180, whineRise: 200, splash: 0.9 },
  Futuristic: { diesel: 0.12, pitch: 30, rise: 20, bright: 180, chug: 0, chugRate: 1, whine: 0.55, whinePitch: 220, whineRise: 560, splash: 0.7 }
};

function engineProfile(ship) {
  return ENGINE_PROFILES[ship.category] || ENGINE_PROFILES.Cruise;
}

// Pistons (two detuned low saw waves through a lowpass, pulsed by a slow
// "chug" wobble) plus a turbine whine; ENGINE_PROFILES decides the mix.
function makeEngine(ac) {
  const out = ac.createGain();
  out.gain.value = 0;
  out.connect(sfx.out);

  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 260;
  filter.Q.value = 2;
  const diesel = ac.createGain();
  diesel.gain.value = 0;
  filter.connect(diesel);
  diesel.connect(out);
  const oscs = [0, 7].map((detune) => {
    const osc = ac.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 38;
    osc.detune.value = detune;
    osc.connect(filter);
    osc.start();
    return osc;
  });
  const chug = ac.createOscillator();
  chug.frequency.value = 5;
  const chugDepth = ac.createGain();
  chugDepth.gain.value = 0;
  chug.connect(chugDepth);
  chugDepth.connect(diesel.gain);
  chug.start();

  const whine = ac.createGain();
  whine.gain.value = 0;
  whine.connect(out);
  const whineOscs = [1, 1.5].map((mult) => {
    const osc = ac.createOscillator();
    osc.type = mult === 1 ? "triangle" : "sine";
    osc.frequency.value = 220 * mult;
    osc.mult = mult;
    osc.connect(whine);
    osc.start();
    return osc;
  });
  return { out, oscs, filter, diesel, chug, chugDepth, whine, whineOscs };
}

// A burst of spray against the hull, louder for faster, splashier ships.
function playHullSplash(ship, amount) {
  const bus = soundBus(ship.x, ship.y, amount);
  if (!bus) return;
  const ac = game.audioContext;
  burst(bus, { filter: "bandpass", freq: 700 + Math.random() * 1300, freqTo: 400, q: 0.9, attack: 0.03, dur: 0.2 + Math.random() * 0.35, peak: 0.22 });
  if (Math.random() < 0.35) sample(bus, pick("wave", 3), { rate: 1.3 + Math.random() * 0.4, gain: 0.5, start: ac.currentTime + 0.05 });
}

// Swaps a noise bed for a recorded loop, keeping the same volume control.
function useLoopSample(l, buffer) {
  const ac = game.audioContext;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.connect(l.filter);
  l.filter.type = "lowpass";
  l.filter.frequency.value = 20000;
  l.filter.Q.value = 0.7;
  l.src.stop();
  l.src = src;
  l.recorded = true;
  src.start(0, Math.random() * buffer.duration);
}

function applySoundLevel() {
  if (sfx.out) sfx.out.gain.setTargetAtTime(soundLevel().volume, game.audioContext.currentTime, 0.05);
}

function cycleSoundLevel() {
  game.settings.soundLevel = (game.settings.soundLevel + 1) % SOUND_LEVELS.length;
  saveSettings();
  ensureAudio();
  applySoundLevel();
  if (soundLevel().volume > 0) playGull();
  setUiMessage(`Sound: ${soundLevel().name}`);
}

function makeNoise(ac, brown) {
  const length = ac.sampleRate * 3;
  const buffer = ac.createBuffer(1, length, ac.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i += 1) {
    const white = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    } else {
      data[i] = white;
    }
  }
  return buffer;
}

// A noise bed that always runs; its gain is steered every frame.
function loop(ac, buffer, type, freq, q) {
  const src = ac.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const filter = ac.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const gain = ac.createGain();
  gain.gain.value = 0;
  src.connect(filter);
  filter.connect(gain);
  gain.connect(sfx.out);
  src.start(0, Math.random() * 2);
  return { gain, filter, src, recorded: false };
}

// How loud a sound at world point (x, y) is for the listener, and where it pans.
function placeSound(x, y) {
  const f = cameraFocus();
  const dx = x - f.x;
  const dy = y - f.y;
  const d = Math.hypot(dx, dy);
  const reach = f.inWorld ? 650 : 2200;
  const gain = 1 / (1 + (d / reach) * (d / reach));
  const chase = view3d.active && f.inWorld && mode === "single" && game.settings.cameraView !== "overview" && game.player1;
  const pan = d < 1 ? 0 : chase ? Math.sin(Math.atan2(dy, dx) - game.player1.angle) * 0.8 : clamp(dx / 900, -0.8, 0.8);
  return { gain, pan, d };
}

// A short-lived output for one sound at a world point; null when it's too far
// away to hear (or sound is off). `minGain` keeps big events audible far off.
function soundBus(x, y, level, minGain = 0) {
  if (!ensureAudio() || !sfx.out || soundLevel().volume === 0) return null;
  const ac = game.audioContext;
  const p = x === undefined ? { gain: 1, pan: 0, d: 0 } : placeSound(x, y);
  const g = Math.max(minGain, p.gain) * level;
  if (!(g >= 0.015)) return null; // too quiet, or a position that isn't a number
  const bus = ac.createGain();
  bus.gain.value = g;
  if (ac.createStereoPanner) {
    const panner = ac.createStereoPanner();
    panner.pan.value = p.pan;
    bus.connect(panner);
    panner.connect(sfx.out);
  } else {
    bus.connect(sfx.out);
  }
  bus.distance = p.d;
  return bus;
}

function envelope(ac, dest, start, attack, dur, peak) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(peak, start + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  g.connect(dest);
  return g;
}

function tone(dest, o) {
  const ac = game.audioContext;
  const start = o.start || ac.currentTime;
  const osc = ac.createOscillator();
  osc.type = o.type || "sine";
  osc.frequency.setValueAtTime(o.from, start);
  osc.frequency.exponentialRampToValueAtTime(o.to || o.from, start + (o.glide || o.dur));
  osc.connect(envelope(ac, dest, start, o.attack || 0.01, o.dur, o.peak));
  osc.start(start);
  osc.stop(start + o.dur + 0.05);
  return osc;
}

function burst(dest, o) {
  const ac = game.audioContext;
  const start = o.start || ac.currentTime;
  const src = ac.createBufferSource();
  src.buffer = o.brown ? sfx.brown : sfx.white;
  const filter = ac.createBiquadFilter();
  filter.type = o.filter || "lowpass";
  filter.frequency.setValueAtTime(o.freq, start);
  if (o.freqTo) filter.frequency.exponentialRampToValueAtTime(o.freqTo, start + o.dur);
  filter.Q.value = o.q || 0.7;
  src.connect(filter);
  filter.connect(envelope(ac, dest, start, o.attack || 0.005, o.dur, o.peak));
  src.start(start, Math.random() * 2);
  src.stop(start + o.dur + 0.05);
}

// ---------------------------------------------------------------------------
// Intro, menus, bumps
// ---------------------------------------------------------------------------

// Plays once, when the intro has loaded (game.js introReady), sound is allowed
// and the music has loaded, with a ship's horn and gulls over it. A click made
// during loading only unlocks sound; it does not start the music early.
function playIntro() {
  if (sfx.introDone || !introReady || !sfx.samples.intro || game.audioContext?.state !== "running") return;
  if (gameState === "playing" || gameState === "arrival" || soundLevel().volume === 0) return;
  sfx.introDone = true;
  const ac = game.audioContext;
  const g = ac.createGain();
  g.gain.value = 0.55;
  g.connect(sfx.out);
  sfx.intro = g;
  sample(g, "intro");
  window.setTimeout(() => {
    if (sfx.intro) sfx.intro = null;
  }, 22000);
  playShipHorn();
  window.setTimeout(playGull, 1600);
}

// A short brass fanfare when you reach the harbour at the end of a crossing or mission.
// Returns how long it plays (seconds), or 0 when nothing played.
function playArrival() {
  const bus = soundBus(undefined, undefined, 0.6);
  if (!bus || !sample(bus, "level_complete")) return 0;
  return sfx.samples.level_complete.duration;
}

function playUi(name, synth) {
  const bus = soundBus(undefined, undefined, 0.6);
  if (!bus) return;
  if (!sample(bus, name)) tone(bus, synth);
}

// Menu keys: moving the selection ticks, Enter confirms, Esc goes back, any
// other key that did something clicks. Called only when the key changed
// something on screen, so keys with no action stay silent.
function playMenuKey(code) {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(code)) {
    playUi("ui_move", { type: "triangle", from: 900, dur: 0.05, peak: 0.08 });
  } else if (code === "Enter" || code === "Space") {
    playUi("ui_confirm", { type: "triangle", from: 660, to: 990, dur: 0.14, peak: 0.1 });
  } else if (code === "Escape" || code === "Backspace") {
    playUi("ui_back", { type: "triangle", from: 700, to: 420, dur: 0.12, peak: 0.09 });
  } else {
    playUiClick();
  }
}

function playUiClick() {
  playUi("ui_click", { type: "triangle", from: 1200, dur: 0.04, peak: 0.1 });
}

function playUiError() {
  playUi("ui_error", { type: "square", from: 220, to: 160, dur: 0.18, peak: 0.06 });
}

// Hulls knocking together (or a ship grinding into the edge of the sea).
// `strength` 0..1 from how fast they were going.
function playBump(x, y, strength) {
  const bus = soundBus(x, y, 0.35 + strength * 0.65);
  if (!bus) return;
  if (sample(bus, "ship_bump", { rate: vary(0.12) * (1.15 - strength * 0.3), gain: 0.8 })) return;
  tone(bus, { from: 90, to: 45, dur: 0.35, peak: 0.3 });
  burst(bus, { brown: true, freq: 500, dur: 0.4, peak: 0.25 });
}

// ---------------------------------------------------------------------------
// Weapons and hits
// ---------------------------------------------------------------------------

function playCannonShot(x, y) {
  const bus = soundBus(x, y, 1.6, 0.25);
  if (!bus) return;
  if (sample(bus, "cannon_fire", { rate: vary(), gain: 1 })) {
    // Extra low punch so the shot is felt, not just heard.
    tone(bus, { from: 120, to: 40, dur: 0.5, peak: 0.4 });
    return;
  }
  tone(bus, { from: 170, to: 45, dur: 0.45, peak: 0.32 });
  burst(bus, { freq: 1600, freqTo: 300, dur: 0.38, peak: 0.28 });
  burst(bus, { filter: "highpass", freq: 3000, dur: 0.07, peak: 0.1 });
}

function playSonicPulse(x, y) {
  const bus = soundBus(x, y, 1.6, 0.25);
  if (!bus) return;
  tone(bus, { from: 1400, to: 220, dur: 0.35, peak: 0.1 });
  tone(bus, { type: "triangle", from: 700, to: 110, dur: 0.42, peak: 0.08 });
  burst(bus, { filter: "bandpass", freq: 2200, freqTo: 400, q: 2, dur: 0.3, peak: 0.06 });
}

// A high-pressure jet: a hiss with a low rush under it.
function playWaterCannon(x, y) {
  const bus = soundBus(x, y, 1.3, 0.2);
  if (!bus) return;
  burst(bus, { filter: "bandpass", freq: 2400, freqTo: 1400, q: 0.9, attack: 0.03, dur: 0.45, peak: 0.22 });
  burst(bus, { brown: true, freq: 400, dur: 0.45, peak: 0.25, attack: 0.03 });
}

// One sharp crack per round of the burst.
function playMachineGun(x, y, rounds) {
  const bus = soundBus(x, y, 1.4, 0.2);
  if (!bus) return;
  const now = game.audioContext.currentTime;
  for (let r = 0; r < rounds; r += 1) {
    const start = now + r * 0.07;
    burst(bus, { filter: "highpass", freq: 1800, dur: 0.05, peak: 0.22, start });
    tone(bus, { type: "square", from: 160, to: 70, dur: 0.06, peak: 0.12, start });
  }
}

function playLaserShot(x, y) {
  const bus = soundBus(x, y, 1.3, 0.2);
  if (!bus) return;
  tone(bus, { type: "sawtooth", from: 2400, to: 300, dur: 0.22, peak: 0.08 });
  tone(bus, { type: "sine", from: 1200, to: 180, dur: 0.28, peak: 0.1 });
}

// What a shot sounds like when it lands: water splashes, rounds clang,
// a laser sizzles, anything heavier explodes. `onRock` = it hit land instead.
function playShotHit(kind, x, y, onRock = false) {
  if (kind !== "water" && kind !== "bullet" && kind !== "laser") {
    playExplosion(x, y, onRock ? 0.5 : 0.8);
    return;
  }
  const bus = soundBus(x, y, 1, 0.1);
  if (!bus) return;
  if (kind === "water") {
    burst(bus, { filter: "bandpass", freq: 1100, q: 0.7, attack: 0.02, dur: 0.3, peak: 0.12 });
  } else if (kind === "bullet") {
    tone(bus, { type: "triangle", from: onRock ? 900 : 2200, to: onRock ? 500 : 1600, dur: 0.07, peak: 0.07 });
  } else {
    burst(bus, { filter: "highpass", freq: 3500, dur: 0.18, peak: 0.1 });
  }
}

function playMissileLaunch(x, y) {
  const bus = soundBus(x, y, 1.5, 0.25);
  if (!bus) return;
  if (sample(bus, "missile_launch", { rate: vary(0.1), gain: 1 })) return;
  tone(bus, { from: 90, to: 50, dur: 0.25, peak: 0.2 });
  burst(bus, { filter: "bandpass", freq: 300, freqTo: 2600, q: 1.2, attack: 0.08, dur: 0.95, peak: 0.18 });
}

// A carrier jet running its engine up to full power on the catapult.
function playJetSpool(x, y) {
  const bus = soundBus(x, y, 1.3, 0.2);
  if (!bus) return;
  tone(bus, { type: "sawtooth", from: 300, to: 1400, dur: 2.4, peak: 0.05 });
  burst(bus, { brown: true, freq: 300, freqTo: 900, attack: 2, dur: 2.4, peak: 0.25 });
}

// The catapult shot: a blast of engine noise and a deep thump as the jet is
// thrown off the bow.
function playJetLaunch(x, y) {
  const bus = soundBus(x, y, 1.8, 0.3);
  if (!bus) return;
  tone(bus, { from: 90, to: 35, dur: 0.6, peak: 0.4 });
  burst(bus, { freq: 2200, freqTo: 600, attack: 0.02, dur: 1.8, peak: 0.35 });
  burst(bus, { brown: true, freq: 400, attack: 0.02, dur: 2.2, peak: 0.4 });
}

function playTorpedoLaunch(x, y) {
  const bus = soundBus(x, y, 1.5, 0.25);
  if (!bus) return;
  const now = game.audioContext.currentTime;
  tone(bus, { from: 110, to: 40, dur: 0.35, peak: 0.26 });
  if (sample(bus, "bubbles", { rate: vary(0.15), gain: 0.5, start: now + 0.05 })) return;
  burst(bus, { freq: 500, dur: 0.6, peak: 0.08, attack: 0.05 });
  for (let i = 0; i < 9; i += 1) {
    const f = 300 + Math.random() * 450;
    tone(bus, { from: f, to: f * 1.7, dur: 0.05, peak: 0.05, start: now + 0.08 + i * 0.045 + Math.random() * 0.02 });
  }
}

// size 1 = a ship blown apart; around 0.5 = a shot bursting on rock.
function playExplosion(x, y, size = 1) {
  const bus = soundBus(x, y, size * 1.5, 0.2);
  if (!bus) return;
  const now = game.audioContext.currentTime;
  const clip = size >= 0.7 ? "hit_ship" : "hit_rock";
  if (sample(bus, clip, { rate: vary(), gain: 1 })) {
    sample(bus, "explosion", { rate: 0.8 * vary(), gain: 0.7 * size });
    return;
  }
  tone(bus, { from: 110, to: 28, dur: 0.9 * size + 0.3, peak: 0.36 });
  burst(bus, { brown: true, freq: 900, freqTo: 180, dur: 1.2 * size + 0.3, peak: 0.45 });
  burst(bus, { filter: "highpass", freq: 2500, dur: 0.1, peak: 0.12 });
  // Spray falling back onto the water.
  burst(bus, { filter: "bandpass", freq: 1500, q: 0.8, attack: 0.08, dur: 0.7, peak: 0.07, start: now + 0.15 });
}

function playCapsize(x, y) {
  const bus = soundBus(x, y, 1);
  if (!bus) return;
  const ac = game.audioContext;
  const now = ac.currentTime;
  // Timbers creaking as the hull rolls over.
  const creak = ac.createBiquadFilter();
  creak.type = "bandpass";
  creak.frequency.value = 650;
  creak.Q.value = 6;
  creak.connect(bus);
  tone(creak, { type: "sawtooth", from: 140, to: 70, dur: 1.1, peak: 0.4, attack: 0.1 });
  tone(creak, { type: "sawtooth", from: 95, to: 60, dur: 0.8, peak: 0.3, attack: 0.1, start: now + 0.35 });
  if (sample(bus, "ship_sink", { gain: 0.6, start: now + 0.3 })) return;
  // The splash, then water rushing in.
  burst(bus, { freq: 1400, freqTo: 250, attack: 0.04, dur: 1.6, peak: 0.32, start: now + 0.55 });
  for (let i = 0; i < 12; i += 1) {
    const f = 200 + Math.random() * 380;
    tone(bus, { from: f, to: f * 1.8, dur: 0.06, peak: 0.04, start: now + 0.9 + i * 0.09 + Math.random() * 0.05 });
  }
}

// The tsunami reaches a ship: a deafening low roar, heavy thuds through the hull, groaning
// metal and cracking plates, and the crash of water. `broadside` (caught side-on) is harsher
// and longer than riding it bow-on.
function playTsunamiImpact(x, y, broadside) {
  const bus = soundBus(x, y, broadside ? 2.2 : 1.7, 0.7);
  if (!bus) return;
  const ac = game.audioContext;
  const now = ac.currentTime;
  const k = broadside ? 1.4 : 1;
  // The roar: sub-bass tones and rumbling noise that swell over the hit and die slowly.
  tone(bus, { from: 46, to: 24, dur: 5.5 * k, peak: 0.7, attack: 0.5 });
  tone(bus, { from: 70, to: 32, dur: 4 * k, peak: 0.45, attack: 0.35, type: "triangle" });
  burst(bus, { brown: true, freq: 220, freqTo: 60, dur: 6 * k, peak: 0.9, attack: 0.6 });
  burst(bus, { brown: true, freq: 700, freqTo: 120, dur: 3.5 * k, peak: 0.55, attack: 0.25 });
  // Heavy thuds: the wall of water hammering the hull.
  const thuds = broadside ? 7 : 4;
  for (let i = 0; i < thuds; i += 1) {
    const at = now + 0.2 + i * (0.35 + Math.random() * 0.3);
    tone(bus, { from: 85, to: 28, dur: 0.55, peak: 0.8 - i * 0.05, attack: 0.012, start: at });
    burst(bus, { brown: true, freq: 380, freqTo: 70, dur: 0.4, peak: 0.5, attack: 0.008, start: at });
  }
  // Groaning metal: slow sawtooth through a resonant filter, with a wobble.
  const groan = ac.createBiquadFilter();
  groan.type = "bandpass";
  groan.frequency.value = 320;
  groan.Q.value = 9;
  groan.connect(bus);
  const wob = ac.createOscillator();
  const wobAmt = ac.createGain();
  wob.frequency.value = 5.5;
  wobAmt.gain.value = 40;
  wob.connect(wobAmt);
  wobAmt.connect(groan.frequency);
  wob.start(now);
  wob.stop(now + 5 * k);
  tone(groan, { type: "sawtooth", from: 118, to: 52, dur: 3.2 * k, peak: 0.5, attack: 0.5, start: now + 0.3 });
  tone(groan, { type: "sawtooth", from: 83, to: 44, dur: 2.6 * k, peak: 0.4, attack: 0.4, start: now + 1.1 });
  // Cracking hull: sharp, irregular snaps of plating and timber.
  const cracks = broadside ? 16 : 7;
  for (let i = 0; i < cracks; i += 1) {
    const at = now + 0.4 + Math.random() * 3.6 * k;
    burst(bus, { filter: "bandpass", freq: 900 + Math.random() * 2400, q: 2.5, dur: 0.03 + Math.random() * 0.07, peak: 0.35 + Math.random() * 0.3, attack: 0.002, start: at });
    tone(bus, { type: "square", from: 180 + Math.random() * 200, to: 60, dur: 0.09, peak: 0.12, attack: 0.002, start: at });
  }
  // Crashing water: a surge of white noise breaking over the deck, then draining away.
  burst(bus, { freq: 2600, freqTo: 350, attack: 0.15, dur: 3.4 * k, peak: 0.6, start: now + 0.1 });
  burst(bus, { filter: "bandpass", freq: 1200, freqTo: 300, q: 0.6, attack: 0.5, dur: 4.5 * k, peak: 0.35, start: now + 0.8 });
}

function playShipHorn() {
  const bus = soundBus(undefined, undefined, 1);
  if (!bus) return;
  const ac = game.audioContext;
  const lp = ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 900;
  lp.connect(bus);
  tone(lp, { type: "sawtooth", from: 110, dur: 1.3, peak: 0.12, attack: 0.08 });
  tone(lp, { type: "sawtooth", from: 165, dur: 1.3, peak: 0.08, attack: 0.08 });
}

// ---------------------------------------------------------------------------
// Weather and nature
// ---------------------------------------------------------------------------

// Thunder arrives after the flash, later the further away the strike is.
function playThunder(x, y) {
  const bus = soundBus(x, y, 1, 0.08);
  if (!bus) return;
  const now = game.audioContext.currentTime;
  const start = now + Math.min(2.5, bus.distance / 900);
  if (bus.distance < 450) {
    burst(bus, { filter: "highpass", freq: 2200, dur: 0.28, peak: 0.28, start });
  }
  // Further strikes sound deeper and duller.
  const rate = clamp(1.1 - bus.distance / 3000, 0.72, 1.1) * vary(0.05);
  if (sample(bus, "thunder", { start, rate, gain: 0.9, cutAt: 5 })) return;
  burst(bus, { brown: true, freq: 260, freqTo: 90, attack: 0.12, dur: 3.6, peak: 0.55, start });
  for (let i = 0; i < 3; i += 1) {
    burst(bus, { brown: true, freq: 200, attack: 0.15, dur: 1.3, peak: 0.32, start: start + 0.3 + Math.random() * 1.6 });
  }
}

// A volcano rumbles, blows, then crackles while the lava pours out.
function playEruption(x, y) {
  // Heard across the whole sea, not just nearby.
  const bus = soundBus(x, y, 1.3, 0.45);
  if (!bus) return;
  const now = game.audioContext.currentTime;
  const blast = now + ERUPTION_BUILD;
  if (!sample(bus, "volcano_rumble", { gain: 1, cutAt: 9 })) {
    burst(bus, { brown: true, freq: 120, attack: 1.2, dur: 6.5, peak: 0.6 });
  }
  tone(bus, { from: 70, to: 22, dur: 2.4, peak: 0.5, start: blast });
  // The blast: recorded booms slowed right down, or a noise burst.
  const recorded = sample(bus, "explosion", { start: blast, rate: 0.4, gain: 1 });
  sample(bus, "explosion", { start: blast + 0.12, rate: 0.3, gain: 0.8 });
  sample(bus, "hit_rock", { start: blast + 0.05, rate: 0.55, gain: 0.7 });
  // A second, smaller blast as the vent clears.
  sample(bus, "explosion", { start: blast + 2.3, rate: 0.5, gain: 0.55 });
  if (!recorded) burst(bus, { brown: true, freq: 800, freqTo: 140, dur: 2.8, peak: 0.6, start: blast });
  burst(bus, { filter: "highpass", freq: 1800, dur: 0.25, peak: 0.18, start: blast });
  burst(bus, { filter: "bandpass", freq: 2800, q: 0.6, attack: 1, dur: 5, peak: 0.05, start: blast + 0.3 });
  for (let i = 0; i < 80; i += 1) {
    burst(bus, { filter: "highpass", freq: 1500 + Math.random() * 2500, dur: 0.03, peak: 0.04 + Math.random() * 0.09, start: blast + 0.1 + Math.random() * 8 });
  }
}

// A volcano rock coming down: a crash and burst of flame on a ship, or a
// heavy plunge and splash in the sea.
function playRockImpact(x, y, hitShip) {
  const bus = soundBus(x, y, hitShip ? 1.4 : 0.9, hitShip ? 0.2 : 0);
  if (!bus) return;
  const now = game.audioContext.currentTime;
  if (hitShip) {
    sample(bus, "hit_ship", { rate: 0.8 * vary(), gain: 1 });
    burst(bus, { filter: "bandpass", freq: 900, q: 0.7, attack: 0.05, dur: 1.2, peak: 0.25, start: now + 0.1 }); // whoomph of flame
  } else {
    tone(bus, { from: 90, to: 40, dur: 0.4, peak: 0.25 });
    if (!sample(bus, pick("wave", 3), { rate: 1.5 * vary(), gain: 0.8 })) burst(bus, { freq: 1600, freqTo: 300, dur: 0.6, peak: 0.3 });
    burst(bus, { filter: "highpass", freq: 3000, attack: 0.02, dur: 0.8, peak: 0.06, start: now + 0.05 }); // hot rock hissing
  }
}

// A distant foghorn somewhere out in the murk.
function playFogHorn() {
  const f = cameraFocus();
  const a = Math.random() * Math.PI * 2;
  const bus = soundBus(f.x + Math.cos(a) * 600, f.y + Math.sin(a) * 600, 1.6, 0.25);
  if (!bus) return;
  const ac = game.audioContext;
  const lp = ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 420;
  lp.connect(bus);
  tone(lp, { type: "sawtooth", from: 72, dur: 2.6, peak: 0.16, attack: 0.25 });
  tone(lp, { type: "sawtooth", from: 108, dur: 2.6, peak: 0.1, attack: 0.25 });
}

// Water hitting a fire: a long hiss.
function playFireOut(x, y) {
  const bus = soundBus(x, y, 1, 0.15);
  if (!bus) return;
  burst(bus, { filter: "highpass", freq: 2500, attack: 0.05, dur: 1.4, peak: 0.25 });
  burst(bus, { filter: "bandpass", freq: 800, attack: 0.05, dur: 0.9, peak: 0.12 });
}

// Something sailing or swimming into hot lava.
function playLavaBurn(x, y) {
  const bus = soundBus(x, y, 0.8);
  if (!bus) return;
  burst(bus, { filter: "highpass", freq: 3500, attack: 0.02, dur: 0.7, peak: 0.18 });
  tone(bus, { type: "sawtooth", from: 180, to: 90, dur: 0.3, peak: 0.05 });
}

function playGull() {
  if (!ensureAudio() || !sfx.out) return;
  const ac = game.audioContext;
  const f = cameraFocus();
  const a = Math.random() * Math.PI * 2;
  const r = 150 + Math.random() * 450;
  const bus = soundBus(f.x + Math.cos(a) * r, f.y + Math.sin(a) * r, 0.5 + Math.random() * 0.5);
  if (!bus) return;
  if (sample(bus, pick("gull", 7), { rate: vary(0.1), gain: 0.35 })) return;
  const filter = ac.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 2300;
  filter.Q.value = 2.5;
  filter.connect(bus);
  const calls = 2 + Math.floor(Math.random() * 3);
  const pitch = 0.85 + Math.random() * 0.3;
  let t = ac.currentTime;
  for (let i = 0; i < calls; i += 1) {
    const dur = 0.22 + Math.random() * 0.12;
    const osc = ac.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(1500 * pitch, t);
    osc.frequency.exponentialRampToValueAtTime(2500 * pitch, t + dur * 0.25);
    osc.frequency.exponentialRampToValueAtTime(1250 * pitch, t + dur);
    const wobble = ac.createOscillator();
    wobble.frequency.value = 28;
    const depth = ac.createGain();
    depth.gain.value = 70;
    wobble.connect(depth);
    depth.connect(osc.frequency);
    osc.connect(envelope(ac, filter, t, 0.03, dur, 0.07));
    osc.start(t);
    wobble.start(t);
    osc.stop(t + dur + 0.05);
    wobble.stop(t + dur + 0.05);
    t += dur + 0.08 + Math.random() * 0.15;
  }
}

// ---------------------------------------------------------------------------
// Ambience, steered every frame
// ---------------------------------------------------------------------------

function setLoop(l, value, freq) {
  const now = game.audioContext.currentTime;
  l.gain.gain.setTargetAtTime(value, now, 0.25);
  if (freq) l.filter.frequency.setTargetAtTime(freq, now, 0.25);
}

// 0..1: how close the listener is to the edge of a round area.
function nearness(f, x, y, r, falloff) {
  const d = Math.hypot(f.x - x, f.y - y) - r;
  return clamp(1 - d / falloff, 0, 1);
}

// The ship's alarm: an electric bell (two tones, struck about 17 times
// a second), made once and left running silent; updateSound opens it in
// bursts while game.js bridgeAlarmOn() says so.
function fireAlarmVoice(ac) {
  const out = ac.createGain();
  out.gain.value = 0;
  out.connect(sfx.out);
  const ring = ac.createGain();
  ring.gain.value = 0.5;
  ring.connect(out);
  const striker = ac.createOscillator();
  striker.type = "square";
  striker.frequency.value = 17;
  const depth = ac.createGain();
  depth.gain.value = 0.5;
  striker.connect(depth);
  depth.connect(ring.gain);
  striker.start();
  for (const freq of [1150, 1530]) {
    const tone = ac.createOscillator();
    tone.type = "triangle";
    tone.frequency.value = freq;
    tone.connect(ring);
    tone.start();
  }
  return out;
}

const FIRE_ALARM_CYCLE = 1.2; // seconds: rings for FIRE_ALARM_RING of each
const FIRE_ALARM_RING = 0.8;
const FIRE_ALARM_VOLUME = 0.07;

// ---------------------------------------------------------------------------
// The dockyard (shop): calm music, welding, machinery, the dock filling and
// draining, a horn as the ship arrives, and gulls over the sea (the sea and
// its waves are the game's usual ambience). render3d.js sets game.dock.welding
// (or, for the carrack, caulking and knocks), pumping, gateMoving and horns.
// ---------------------------------------------------------------------------

// Slow pad chords, used only if the music clip isn't there.
const DOCK_PAD = [[220, 261.6, 329.6], [174.6, 220, 261.6], [196, 246.9, 293.7], [164.8, 207.7, 246.9]];

function updateDockSound(t) {
  const L = sfx.loops;
  const d = gameState === "shop" ? game.dock : null;
  const ac = game.audioContext;
  // Music: the game's theme, looped softly under the dockyard noises.
  if (d && !sfx.dockMusic && sfx.samples.intro) {
    const g = ac.createGain();
    g.gain.value = 0.0001;
    g.connect(sfx.out);
    const src = ac.createBufferSource();
    src.buffer = sfx.samples.intro;
    src.loop = true;
    src.connect(g);
    src.start(0, Math.random() * sfx.samples.intro.duration);
    sfx.dockMusic = { g, src, offAt: 0 };
  }
  if (sfx.dockMusic) {
    sfx.dockMusic.g.gain.setTargetAtTime(d ? 0.3 : 0.0001, t, d ? 1.5 : 0.4);
    if (!d && !sfx.dockMusic.offAt) sfx.dockMusic.offAt = t;
    if (d) sfx.dockMusic.offAt = 0;
    if (!d && t - sfx.dockMusic.offAt > 3) {
      sfx.dockMusic.src.stop();
      sfx.dockMusic = null;
    }
  } else if (d && !sfx.samples.intro && t >= (sfx.nextPadAt || 0)) {
    const bus = soundBus(undefined, undefined, 0.5);
    const chord = DOCK_PAD[(sfx.padStep = ((sfx.padStep || 0) + 1) % DOCK_PAD.length)];
    if (bus) for (const f of chord) tone(bus, { type: "triangle", from: f, dur: 7, peak: 0.05, attack: 2 });
    sfx.nextPadAt = t + 6;
  }
  if (d && sfx.intro) {
    sfx.intro.gain.setTargetAtTime(0.0001, t, 0.6);
    sfx.intro = null;
  }

  const weld = !!(d && d.welding);
  // No engines or clanging steel in the carrack's arsenal: water, gulls and a bell.
  setLoop(L.dockHum, d && !d.arsenal ? 0.12 + (d.pumping ? 0.08 : 0) : 0, d && d.pumping ? 230 : 170);
  setLoop(L.dockWater, d && d.pumping ? 0.26 : 0, 520 + Math.sin(t * 0.8) * 120);
  setLoop(L.dockWeld, weld ? 0.02 + Math.random() * 0.05 : 0);
  if (weld && t >= (sfx.nextCrackleAt || 0)) {
    sfx.nextCrackleAt = t + 0.04 + Math.random() * 0.18;
    const bus = soundBus(undefined, undefined, 0.7);
    if (bus) {
      burst(bus, { filter: "highpass", freq: 3000 + Math.random() * 3000, dur: 0.03 + Math.random() * 0.06, peak: 0.12 + Math.random() * 0.1 });
      if (Math.random() < 0.4) tone(bus, { type: "sawtooth", from: 100, dur: 0.12, peak: 0.03 });
    }
  }
  // The carrack's repairs: a wooden knock each time a caulking mallet lands, and the fire under the pitch pot.
  const knocks = d ? d.knocks || 0 : 0;
  if (d && d.caulking && knocks !== (sfx.dockKnocks || 0)) {
    const bus = soundBus(undefined, undefined, 0.8);
    if (bus) {
      tone(bus, { type: "triangle", from: 230 + Math.random() * 60, to: 130, dur: 0.1, peak: 0.16 });
      burst(bus, { freq: 1100 + Math.random() * 500, dur: 0.04, peak: 0.14 });
    }
  }
  sfx.dockKnocks = knocks;
  if (d && d.caulking && t >= (sfx.nextPitchAt || 0)) {
    sfx.nextPitchAt = t + 0.12 + Math.random() * 0.4;
    const bus = soundBus(undefined, undefined, 0.4);
    if (bus) burst(bus, { filter: "highpass", freq: 1800 + Math.random() * 2200, dur: 0.02 + Math.random() * 0.03, peak: 0.05 + Math.random() * 0.05 });
  }
  // A metal clang now and then from somewhere in the yard.
  if (d && d.arsenal && t >= (sfx.nextBellAt || 0)) {
    sfx.nextBellAt = t + 9 + Math.random() * 8;
    const bus = soundBus(undefined, undefined, 0.4);
    if (bus) {
      for (const [from, peak, dur] of [[392, 0.07, 3.2], [784, 0.03, 2], [1046, 0.018, 1.2]]) tone(bus, { type: "sine", from, dur, peak });
    }
  }
  if (d && !d.arsenal && t >= (sfx.nextClangAt || 0)) {
    sfx.nextClangAt = t + 2.5 + Math.random() * 4;
    const bus = soundBus(undefined, undefined, 0.45);
    if (bus) {
      const f = 700 + Math.random() * 900;
      tone(bus, { type: "triangle", from: f, dur: 0.4, peak: 0.06 });
      tone(bus, { type: "sine", from: f * 2.4, dur: 0.2, peak: 0.025 });
    }
  }
  // The gate sliding, a horn as a ship arrives.
  const moving = !!(d && d.gateMoving);
  if (moving && !sfx.dockGateWas) {
    const bus = soundBus(undefined, undefined, 0.8);
    if (bus) {
      tone(bus, { from: 62, to: 38, dur: 2.2, peak: 0.22 });
      burst(bus, { brown: true, freq: 220, dur: 2, attack: 0.3, peak: 0.25 });
    }
  }
  sfx.dockGateWas = moving;
  const horns = d ? d.horns || 0 : 0;
  if (d && horns !== (sfx.dockHorns || 0)) playShipHorn();
  sfx.dockHorns = horns;
}

function updateSound(dt) {
  if (!sfx.loops || game.audioContext.state !== "running") return;
  const L = sfx.loops;
  const t = game.audioContext.currentTime;
  if (!sfx.fireAlarm) sfx.fireAlarm = fireAlarmVoice(game.audioContext);
  const ringing = bridgeAlarmOn() && t % FIRE_ALARM_CYCLE < FIRE_ALARM_RING;
  sfx.fireAlarm.gain.setTargetAtTime(ringing ? FIRE_ALARM_VOLUME : 0, t, 0.015);
  const f = cameraFocus();
  const sailing = f.inWorld && gameState === "playing" && !game.cannonCinematic && !game.exitConfirm;

  // Waves: slow overlapping swells.
  const swell = 0.5 + 0.3 * Math.sin(t * 0.45) + 0.2 * Math.sin(t * 0.83 + 1.7);
  setLoop(L.sea, L.sea.recorded ? 0.22 + swell * 0.1 : 0.1 + swell * 0.09);
  setLoop(L.surf, 0.015 + swell * 0.03);

  // Each ship type sounds different (see ENGINE_PROFILES): the loudest
  // engine among your ships drives the engine sound; every ship splashes.
  let wake = 0;
  let wakeSpeed = 0;
  let sails = 0;
  let loudest = null;
  let loudestLevel = 0;
  if (sailing) {
    for (const ship of humanShips()) {
      if (ship.capsized) continue;
      const prof = engineProfile(ship);
      const frac = Math.min(1, Math.abs(ship.speed) / ship.maxSpeed);
      const push = Math.abs(ship.throttle || 0);
      // Foil-borne, the hull is out of the water: far less splashing.
      const splash = prof.splash * (1 - 0.75 * (ship.foilLift || 0));
      wake = Math.max(wake, splash * Math.pow(frac, 1.2));
      wakeSpeed = Math.max(wakeSpeed, frac);
      if (prof.diesel === 0 && prof.whine === 0) sails = Math.max(sails, push * 0.6 + frac * 0.4);
      const level = (prof.diesel + prof.whine) * (0.3 + frac * 0.35 + push * 0.35);
      if (level > loudestLevel) {
        loudestLevel = level;
        loudest = { prof, frac, push };
      }
      // Spray slapping the hull: more often and louder the faster you go.
      if (frac > 0.15 && t >= (ship.nextSplashAt || 0)) {
        ship.nextSplashAt = t + (0.25 + Math.random() * 0.5) / Math.max(0.3, splash * frac);
        playHullSplash(ship, 0.3 * splash * frac);
      }
    }
  }
  setLoop(L.wake, 0.2 * wake, 380 + wakeSpeed * 700);

  // Carrier jets: the engine taxiing and running up on deck, the roar of a
  // catapult shot, then a jet passing in the air (louder the closer it is).
  let jetLevel = 0;
  let jetFreq = 700;
  if (sailing) {
    for (const ship of humanShips()) {
      const j = ship.jet;
      if (!j) continue;
      if (j.state === "taxi" || j.state === "taxiBack" || j.state === "land") {
        jetLevel = Math.max(jetLevel, 0.05);
      } else if (j.state === "spool") {
        const up = Math.min(1, j.t / 2);
        jetLevel = Math.max(jetLevel, 0.06 + 0.14 * up);
        jetFreq = 900 + 900 * up;
      } else if (j.state === "catapult") {
        jetLevel = Math.max(jetLevel, 0.22);
        jetFreq = 1600;
      } else if (JET_FLYING.has(j.state) || j.state === "down") {
        jetLevel = Math.max(jetLevel, 0.15 * nearness(f, j.x, j.y, 0, 900));
        jetFreq = 1100;
      }
    }
  }
  setLoop(L.jet, jetLevel, jetFreq);

  const e = sfx.engine;
  if (loudest) {
    const { prof, frac, push } = loudest;
    const rev = frac + push * 0.25;
    e.out.gain.setTargetAtTime(0.16 * (0.3 + frac * 0.35 + push * 0.35), t, 0.2);
    e.diesel.gain.setTargetAtTime(prof.diesel, t, 0.3);
    e.chugDepth.gain.setTargetAtTime(prof.diesel * prof.chug, t, 0.3);
    e.chug.frequency.setTargetAtTime(prof.chugRate * (0.8 + rev * 0.6), t, 0.3);
    for (const osc of e.oscs) osc.frequency.setTargetAtTime(prof.pitch + rev * prof.rise, t, 0.35);
    e.filter.frequency.setTargetAtTime(prof.bright * (0.8 + rev * 0.9), t, 0.3);
    e.whine.gain.setTargetAtTime(prof.whine * 0.5, t, 0.3);
    for (const osc of e.whineOscs) osc.frequency.setTargetAtTime(((prof.whinePitch || 220) + rev * (prof.whineRise || 0)) * osc.mult, t, 0.5);
  } else {
    e.out.gain.setTargetAtTime(0, t, 0.2);
  }

  updateDockSound(t);

  // The intro music gives way once a voyage starts.
  if (sfx.intro && gameState === "playing") {
    sfx.intro.gain.setTargetAtTime(0.0001, t, 0.6);
    sfx.intro = null;
  }

  // Rain and wind near storms, the water spout's howl, the tsunami's roar.
  let storm = 0;
  let wind = 0;
  let wave = 0;
  let lava = 0;
  let sizzle = 0;
  if (sailing) {
    for (const dz of dynamicDangers) storm = Math.max(storm, nearness(f, dz.x, dz.y, dz.r, 380));
    if (waterSpout.state === "active") wind = nearness(f, waterSpout.x, waterSpout.y, waterSpout.r, 520);
    if (tsunami.state === "active") {
      const s = f.x * tsunami.dirX + f.y * tsunami.dirY;
      wave = clamp(1 - Math.abs(s - tsunami.front) / 900, 0, 1);
    } else if (tsunami.state === "warning") {
      wave = 0.15;
    }
    for (const hz of hazards) {
      if (hz.kind !== "volcano") continue;
      lava = Math.max(lava, nearness(f, hz.x, hz.y, hz.r, 300) * (0.35 + (hz.eruption || 0)));
      sizzle = Math.max(sizzle, nearness(f, hz.x, hz.y, hz.r, 500) * (hz.lavaInSea || 0));
    }
  }
  setLoop(L.rain, storm * (L.rain.recorded ? 0.45 : 0.14));
  setLoop(L.wind, Math.max(storm * 0.08, wind * 0.3, sails * 0.09), 300 + wind * 300 + Math.sin(t * 1.3) * 60);
  setLoop(L.tsunami, wave * 0.5);
  setLoop(L.sizzle, sizzle * (0.05 + Math.random() * 0.03));
  setLoop(L.lava, lava * (L.lava.recorded ? 0.5 : 0.35));

  // Burning ships crackle.
  if (sailing) {
    for (const ship of allCombatShips()) {
      if (ship.fire && Math.random() < 0.016 * 14) {
        const bus = soundBus(ship.x, ship.y, 0.7);
        if (bus) burst(bus, { filter: "highpass", freq: 1200 + Math.random() * 2500, dur: 0.04 + Math.random() * 0.05, peak: 0.08 + Math.random() * 0.1 });
      }
    }
  }

  // Now and then a wave breaks somewhere near the ship.
  if (t >= sfx.nextWaveAt) {
    sfx.nextWaveAt = t + 3 + Math.random() * 6;
    const a = Math.random() * Math.PI * 2;
    const bus = soundBus(f.x + Math.cos(a) * 250, f.y + Math.sin(a) * 250, 0.25 + swell * 0.2);
    if (bus) sample(bus, pick("wave", 3), { rate: vary(0.12) });
  }

  // Gulls call now and then (not out in a storm or deep in fog); in fog a
  // foghorn sounds somewhere out of sight instead.
  const fog = sailing ? fogAt(f.x, f.y) : 0;
  if (t >= sfx.nextGullAt) {
    const dockyard = gameState === "shop";
    if (storm < 0.5 && fog < 0.5 && !(dockyard && game.settings.nightMode)) playGull();
    sfx.nextGullAt = t + (dockyard ? 2 + Math.random() * 4 : 4 + Math.random() * 9);
  }
  if (fog > 0.5 && t >= (sfx.nextFogHornAt || 0)) {
    if (sfx.nextFogHornAt) playFogHorn();
    sfx.nextFogHornAt = t + 14 + Math.random() * 14;
  } else if (fog <= 0.5) {
    sfx.nextFogHornAt = 0;
  }
}
