// 3D view for Harbour Run (stage 1 of the move to full 3D).
//
// game.js still runs all gameplay and still owns the menus, HUD and text,
// which it draws on the 2D canvas laid over this one. This file only draws the
// world (sea, sky, ships, hazards) from the same game state, every frame.
// If WebGL or this module fails to load, view3d stays inactive and game.js
// falls back to its classic 2D drawing, so the game always works.
import * as THREE from "three";
import { Water } from "three/addons/objects/Water.js";
import { Sky } from "three/addons/objects/Sky.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const canvas3d = document.getElementById("view3d");
const overlay = document.getElementById("gameCanvas");

// Game space is canvas pixels (x right, y down). In 3D the sea is the X/Z
// plane with the map centred on the origin: game (x, y) -> (x - W/2, h, y - H/2).
// A game heading `a` faces (cos a, sin a), which for models built facing +X
// is rotation.y = -a.
const HALF_W = WORLD_W / 2;
const HALF_H = WORLD_H / 2;

function toWorld(x, y, h = 0, out = new THREE.Vector3()) {
  return out.set(x - HALF_W, h, y - HALF_H);
}

let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas: canvas3d, antialias: true, powerPreference: "high-performance" });
} catch (err) {
  console.warn("[3D] WebGL unavailable, keeping the 2D view:", err);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function mat(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05, ...extra });
}

function mesh(geo, material, castShadow = true) {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = castShadow;
  m.receiveShadow = true;
  return m;
}

function hash3(x, y, z, seed) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 4.137) * 43758.5453;
  return s - Math.floor(s);
}

// Pushes every vertex in or out along its direction from the origin, so
// smooth primitives read as rock, ice or hills. Positions are rounded before
// hashing so duplicated seam vertices move together and the mesh stays closed.
function roughen(geo, amount, seed) {
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = hash3(Math.round(v.x * 10), Math.round(v.y * 10), Math.round(v.z * 10), seed) - 0.5;
    const len = v.length() || 1;
    v.multiplyScalar(1 + (k * amount) / len);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

// Flat markers lying on the water sit a little above the waves' usual
// height, so the moving sea doesn't swallow them.
function onSea(m, y) {
  m.position.y = y;
  m.onBeforeRender = () => {
    m.position.y = y + seaState.lift;
    m.updateMatrixWorld();
  };
  return m;
}

function flatDisc(radius, color, opacity, y) {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 56).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
  );
  return onSea(m, y);
}

function flatRing(inner, outer, color, opacity, y) {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, 72).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
  );
  return onSea(m, y);
}

function softDotTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Light glow like a real lamp seen through air: a tiny hot core, a falling
// power-law halo that never shows an edge, a faint broad haze, and (for
// point lamps) soft cross streaks of scattered light. Written as alpha so it
// works with additive sprites. Not a flat radial disc.
function lightGlowTexture(streaks) {
  const N = 128;
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d");
  const img = g.createImageData(N, N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) / N * 2 - 1;
      const y = (j + 0.5) / N * 2 - 1;
      const r = Math.hypot(x, y);
      // inverse-square-like: a tiny hot centre and a tail that keeps thinning, with no flat plateau
      let v = 1 / (1 + (r / 0.035) ** 2) + 0.07 / (1 + (r / 0.22) ** 2) + 0.012 / (1 + (r / 0.6) ** 2);
      if (streaks) {
        const ax = Math.abs(x), ay = Math.abs(y);
        v += 0.09 * Math.exp(-ay * 60) * Math.exp(-ax * 5) + 0.05 * Math.exp(-ax * 70) * Math.exp(-ay * 5);
      }
      const edge = Math.max(0, 1 - Math.max(r, Math.abs(x), Math.abs(y))); // fades to nothing before the border
      v *= Math.min(1, edge * 4) ** 2;
      const k = (j * N + i) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
      img.data[k + 3] = Math.round(255 * Math.min(1, v));
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Lava texture from game.js; the same picture is the colour (dark crust) and
// the glow (only the cracks light up), so cooling = turning the glow down.
const lavaTex = new THREE.CanvasTexture(lavaCanvas());
lavaTex.colorSpace = THREE.SRGBColorSpace;
lavaTex.wrapS = lavaTex.wrapT = THREE.RepeatWrapping;
// Streams scroll their own copy so the lava visibly runs downhill.
const lavaFlowTex = lavaTex.clone();
lavaFlowTex.repeat.set(1, 3);
lavaFlowTex.wrapS = lavaFlowTex.wrapT = THREE.RepeatWrapping;

function lavaMaterial(map, extra = {}) {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map,
    emissive: 0xff7a3a, // tints the glowing cracks molten orange-red
    emissiveMap: map,
    emissiveIntensity: 2,
    roughness: 0.85,
    ...extra
  });
}

// Ragged, soft-edged blob used as the outline of lava spreading on water.
function blobAlphaTexture() {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const img = g.createImageData(size, size);
  const lobes = [Math.random() * 6, Math.random() * 6, Math.random() * 6];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - size / 2) / (size / 2);
      const dy = (y - size / 2) / (size / 2);
      const a = Math.atan2(dy, dx);
      const edge = 0.72 + 0.12 * Math.sin(a * 3 + lobes[0]) + 0.08 * Math.sin(a * 5 + lobes[1]) + 0.05 * Math.sin(a * 11 + lobes[2]);
      const v = Math.max(0, Math.min(1, (edge - Math.hypot(dx, dy)) / 0.12));
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}
const blobTex = blobAlphaTexture();

function swirlTexture() {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 256;
  const g = c.getContext("2d");
  g.clearRect(0, 0, 128, 256);
  for (let i = -8; i < 16; i++) {
    g.strokeStyle = `rgba(255,255,255,${0.25 + 0.5 * ((i * 37) % 7) / 7})`;
    g.lineWidth = 4 + ((i * 13) % 5) * 2;
    g.beginPath();
    g.moveTo(i * 20, 0);
    g.lineTo(i * 20 + 128, 256);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 1);
  return tex;
}

// Frees GPU memory for an entity that left the game. Materials/geometries
// flagged userData.shared are reused by many entities and kept.
function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) if (!m.userData.shared) m.dispose();
  });
}

function shared(thing) {
  thing.userData.shared = true;
  return thing;
}

// Keeps one 3D object per game entity: creates it the first time the entity
// shows up in `list`, updates it every frame, removes it once the entity is gone.
function syncEntities(map, list, create, update, dt, onRemove = null) {
  const seen = new Set();
  for (const e of list) {
    let o = map.get(e);
    if (!o) {
      o = create(e);
      map.set(e, o);
      scene.add(o.root);
    }
    update(e, o, dt);
    seen.add(e);
  }
  for (const [e, o] of map) {
    if (seen.has(e)) continue;
    if (onRemove) onRemove(o);
    scene.remove(o.root);
    disposeTree(o.root);
    map.delete(e);
  }
}

// ---------------------------------------------------------------------------
// The moving sea. One wave function shapes the water mesh (in the shader)
// and tells ships, buoys and creatures how high the water is under them (in
// JS), so everything rides the same waves. It sums a few long swells whose
// height follows sea.roughness (game.js: calm -> storm) and adds the tsunami
// as one huge swell travelling through the same water. Near land the waves
// die down, so islands and harbours stay dry. The tsunami is the exception:
// it is not damped near land and rolls on over it (a wall of water is drawn over
// the land, tsunamiWall), but the sea in the lee of land (an island, a volcano,
// a harbour coast upstream of it) shows no draw-back ahead of it (tsunamiLee). The waves only move the water
// up and down (x/z stay put), so the game's flat positions still hold.
// ---------------------------------------------------------------------------

// Direction (radians), wavelength, and height in a flat calm and in a storm.
// Mostly from one quarter, as when one wind raises the sea, with a little
// spread so the crests don't line up into a regular pattern.
const SEA_SWELLS = [
  { a: 0.3, len: 260, calm: 0.45, storm: 4.6 },
  { a: 0.05, len: 175, calm: 0.32, storm: 2.8 },
  { a: 0.6, len: 125, calm: 0.25, storm: 1.8 },
  { a: -0.25, len: 85, calm: 0.18, storm: 1.1 },
  { a: 0.95, len: 55, calm: 0.1, storm: 0.55 }
];
const SEA_GRAVITY = 9.8; // longer waves travel faster, as at sea
// Waves come in groups, as at sea: every so often a run of bigger waves rolls
// through, then quieter ones. The group is 8 waves long and travels at half
// the waves' speed (deep-water group speed); its crest is this much higher.
const SEA_GROUP = 0.35;
// Waves fade out between these distances from the centre: just past the
// map's corners, so the whole playing area has the full sea.
const SEA_FADE = [Math.hypot(HALF_W, HALF_H) + 500, Math.hypot(HALF_W, HALF_H) + 1200];
const TSU_HEIGHT = 42;
const TSU_PEAK = 25; // the crest sits this far behind the game's front line
const TSU_BACK = 90; // long gentle back slope
const TSU_FACE = 26; // short steep face
const TSU_LATERAL = [2200, 3000];
const MAX_SHORES = 32;
const WHIRL_DEPTH = 55; // how deep the whirlpool's bowl dips at full strength
// The whirlpool's look: the throat (a funnel of its own, a hole in the sea
// under it) takes WHIRL_RIM of the radius; when it opens, the displaced water
// runs outward as a ring wave (the surge); a raised lip of piled-up water
// rings the edge, and small ripple rings spread beyond it.
const WHIRL_RIM = 0.2;
const SURGE_START = 45; // the surge starts at the whirlpool's opening radius
const SURGE_SPEED = 70;
const SURGE_HEIGHT = 3.5;
const SURGE_DECAY = 2.5; // seconds for the surge to lose most of its height
const SURGE_WIDTH = 22;
const WHIRL_LIP = 1.6;
const WHIRL_RINGS = 0.6;

const seaState = {
  time: 0,
  rough: 0,
  swell: 1, // game.js sea.swell: random sets, raised by a passing storm
  tsuDir: new THREE.Vector2(1, 0),
  tsuFront: 0,
  tsuAmp: 0,
  shores: Array.from({ length: MAX_SHORES }, () => new THREE.Vector4()),
  shoreCount: 0,
  lee: Array.from({ length: 40 }, () => new THREE.Vector4()), // land that shelters the sea behind it from the tsunami
  leeCount: 0,
  whirl: new THREE.Vector4(), // centre x, z, radius, strength (0 = none)
  whirlAngle: 0, // how far the whirlpool's surface has turned so far
  whirlAge: -1, // seconds since the whirlpool opened (-1: none)
  lift: 0 // how far flat markers sit above the mean sea so waves don't swallow them
};

function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

const glslNum = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

const SEA_GLSL = /* glsl */ `
uniform float seaTime;
uniform float seaRough;
uniform float seaSwell;
uniform vec2 tsuDir;
uniform float tsuFront;
uniform float tsuAmp;
uniform vec4 shores[${MAX_SHORES}];
uniform int shoreCount;
uniform vec4 leeCircles[40];
uniform int leeCount;
uniform vec4 whirl;
uniform float whirlAge;

// How much of the tsunami reaches p: land upstream of p (towards where the wave comes from) shelters it.
float tsunamiLee(vec2 p) {
  float lee = 1.0;
  for (int i = 0; i < 40; i++) {
    if (i >= leeCount) break;
    vec2 v = leeCircles[i].xy - p;
    float t = -dot(v, tsuDir);
    if (t <= 0.0) continue;
    float across = abs(v.x * tsuDir.y - v.y * tsuDir.x);
    float r = leeCircles[i].z;
    lee *= 1.0 - (1.0 - smoothstep(r * 0.75, r * 1.15, across)) * (1.0 - smoothstep(700.0, 1600.0, t));
  }
  return lee;
}

void swell(vec2 p, vec2 dir, float len, float amp, float sharp, inout float h, inout vec2 g) {
  float k = 6.2831853 / len;
  float ph = k * dot(dir, p) - sqrt(${glslNum(SEA_GRAVITY)} * k) * seaTime;
  amp *= seaSwell * (1.0 + ${glslNum(SEA_GROUP)} * sin(0.125 * ph + 0.0625 * sqrt(${glslNum(SEA_GRAVITY)} * k) * seaTime + len));
  float u = max(0.5 + 0.5 * sin(ph), 1e-4);
  float up = pow(u, sharp);
  h += amp * (2.0 * up - 1.0);
  g += dir * (amp * sharp * pow(u, sharp - 1.0) * cos(ph) * k);
}

// Height of the water at p, its slope, how much foam it carries, and how
// much of the tsunami's crest is here (0..1).
void seaAt(vec2 p, out float h, out vec2 g, out float foam, out float crest) {
  float shore = 1.0;
  for (int i = 0; i < ${MAX_SHORES}; i++) {
    if (i >= shoreCount) break;
    shore *= smoothstep(shores[i].z, shores[i].w, distance(p, shores[i].xy));
  }
  float far = 1.0 - smoothstep(${glslNum(SEA_FADE[0])}, ${glslNum(SEA_FADE[1])}, length(p));
  float sharp = 1.0 + 1.2 * seaRough;
  float ha = 0.0;
  vec2 ga = vec2(0.0);
${SEA_SWELLS.map(
  (s) =>
    `  swell(p, vec2(${glslNum(Math.cos(s.a))}, ${glslNum(Math.sin(s.a))}), ${glslNum(s.len)}, mix(${glslNum(s.calm)}, ${glslNum(s.storm)}, seaRough), sharp, ha, ga);`
).join("\n")}
  // A whirlpool smooths the waves inside it and pulls the water down into a
  // funnel: a wide bowl plus a narrow throat in the middle.
  vec2 wd = p - whirl.xy;
  float wl = max(length(wd), 0.001);
  float wq = wl / max(whirl.z, 1.0);
  float wIn = whirl.w * (1.0 - min(wq, 1.0));
  float fa = far * shore * (1.0 - 0.6 * wIn * wIn / max(whirl.w, 0.001));
  h = ha * fa;
  g = ga * fa;
  if (wq < 1.0 && whirl.w > 0.0) {
    float bowl = (1.0 - wq) * (1.0 - wq);
    float tq = wq / 0.14;
    float throat = exp(-tq * tq);
    float depth = ${glslNum(WHIRL_DEPTH)} * whirl.w;
    h -= depth * (0.6 * bowl + 0.4 * throat);
    float df = -1.2 * (1.0 - wq) + 0.4 * throat * (-2.0 * wq / 0.0196);
    g -= wd / wl * (depth * df / whirl.z);
  }
  if (whirlAge >= 0.0) {
    float sx = (wl - (${glslNum(SURGE_START)} + ${glslNum(SURGE_SPEED)} * whirlAge)) / ${glslNum(SURGE_WIDTH)};
    float surge = ${glslNum(SURGE_HEIGHT)} * exp(-whirlAge / ${glslNum(SURGE_DECAY)}) * exp(-sx * sx);
    float lx = (wq - 1.0) / 0.12;
    float lip = ${glslNum(WHIRL_LIP)} * whirl.w * exp(-lx * lx);
    float rf = ${glslNum(WHIRL_RINGS)} * whirl.w * smoothstep(0.9, 1.05, wq) * (1.0 - smoothstep(1.3, 1.9, wq));
    float rp = wl * 0.25 - whirlAge * 2.5;
    h += surge + lip + rf * sin(rp);
    g += wd / wl * (surge * (-2.0 * sx / ${glslNum(SURGE_WIDTH)}) + lip * (-2.0 * lx / 0.12) / max(whirl.z, 1.0) + rf * cos(rp) * 0.25);
    // A hole under the throat funnel, so its walls can be seen.
    h -= 400.0 * smoothstep(${glslNum(WHIRL_RIM * 1.05)}, ${glslNum(WHIRL_RIM * 0.7)}, wq) * step(0.05, whirl.w);
  }

  float d = dot(p, tsuDir) - tsuFront;
  float lat = 1.0 - smoothstep(${glslNum(TSU_LATERAL[0])}, ${glslNum(TSU_LATERAL[1])}, abs(dot(p, vec2(-tsuDir.y, tsuDir.x))));
  float x = d + ${glslNum(TSU_PEAK)};
  float w = x < 0.0 ? ${glslNum(TSU_BACK)} : ${glslNum(TSU_FACE)};
  float e = exp(-(x * x) / (w * w));
  float de = -2.0 * x / (w * w) * e;
  float y = (d - 70.0) / 60.0;
  float tr = exp(-y * y); // the sea draws back a little just before the wave
  float dtr = -2.0 * y / 60.0 * tr;
  // The crest passes over land and strikes the sea beyond at full height; only the draw-back ahead of it is
  // left out in the lee of land (the wave started behind it).
  float lee = tsuAmp > 0.0 ? tsunamiLee(p) : 1.0;
  float amp = tsuAmp * lat;
  h += amp * (e - 0.12 * tr * lee);
  g += tsuDir * (amp * (de - 0.12 * dtr * lee));

  float strength = tsuAmp / ${glslNum(TSU_HEIGHT)} * lat;
  crest = e * strength;
  float breaking = smoothstep(0.5, 0.95, e) * smoothstep(-75.0, -12.0, d) * strength;
  // Whitecaps only where several swells pile up into a high crest.
  float ampSum = 0.0;
${SEA_SWELLS.map((s) => `  ampSum += mix(${glslNum(s.calm)}, ${glslNum(s.storm)}, seaRough);`).join("\n")}
  ampSum *= seaSwell;
  float caps = smoothstep(0.42, 0.8, ha / ampSum) * smoothstep(0.3, 0.9, seaRough) * fa;
  // Surf: a band where the waves die down towards land.
  float band = smoothstep(0.1, 0.45, shore) * (1.0 - smoothstep(0.55, 0.9, shore));
  float surf = band * (e * strength + 0.3 + 0.35 * seaRough);
  foam = clamp(breaking + caps + surf, 0.0, 1.0);
}
`;

// Same sum as the shader, for things floating on the water. Returns the
// height and fills out.gx / out.gz with the slope.
const seaOut = { gx: 0, gz: 0 };
function seaHeight(x, z, out = seaOut) {
  const s = seaState;
  let shore = 1;
  for (let i = 0; i < s.shoreCount; i++) {
    const v = s.shores[i];
    shore *= smoothstep(v.z, v.w, Math.hypot(x - v.x, z - v.y));
  }
  const far = 1 - smoothstep(SEA_FADE[0], SEA_FADE[1], Math.hypot(x, z));
  const sharp = 1 + 1.2 * s.rough;
  let h = 0;
  let gx = 0;
  let gz = 0;
  for (const w of SEA_SWELLS) {
    const dx = Math.cos(w.a);
    const dz = Math.sin(w.a);
    const k = (Math.PI * 2) / w.len;
    const om = Math.sqrt(SEA_GRAVITY * k);
    const ph = k * (dx * x + dz * z) - om * s.time;
    // Same group envelope as the shader (0.125 ph + 0.0625 om t: half speed).
    const amp = (w.calm + (w.storm - w.calm) * s.rough) * s.swell * (1 + SEA_GROUP * Math.sin(0.125 * ph + 0.0625 * om * s.time + w.len));
    const u = Math.max(0.5 + 0.5 * Math.sin(ph), 1e-4);
    h += amp * (2 * Math.pow(u, sharp) - 1);
    const sl = amp * sharp * Math.pow(u, sharp - 1) * Math.cos(ph) * k;
    gx += dx * sl;
    gz += dz * sl;
  }
  const wv = s.whirl;
  const wdx = x - wv.x;
  const wdz = z - wv.y;
  const wl = Math.max(Math.hypot(wdx, wdz), 0.001);
  const wq = wl / Math.max(wv.z, 1);
  const wIn = wv.w * (1 - Math.min(wq, 1));
  const fa = far * shore * (1 - (0.6 * wIn * wIn) / Math.max(wv.w, 0.001));
  h *= fa;
  gx *= fa;
  gz *= fa;
  if (wq < 1 && wv.w > 0) {
    const bowl = (1 - wq) * (1 - wq);
    const tq = wq / 0.14;
    const throat = Math.exp(-tq * tq);
    const depth = WHIRL_DEPTH * wv.w;
    h -= depth * (0.6 * bowl + 0.4 * throat);
    const df = -1.2 * (1 - wq) + 0.4 * throat * ((-2 * wq) / 0.0196);
    gx -= (wdx / wl) * ((depth * df) / wv.z);
    gz -= (wdz / wl) * ((depth * df) / wv.z);
  }
  if (s.whirlAge >= 0) {
    const age = s.whirlAge;
    const sx = (wl - (SURGE_START + SURGE_SPEED * age)) / SURGE_WIDTH;
    const surge = SURGE_HEIGHT * Math.exp(-age / SURGE_DECAY) * Math.exp(-sx * sx);
    const lx = (wq - 1) / 0.12;
    const lip = WHIRL_LIP * wv.w * Math.exp(-lx * lx);
    const rf = WHIRL_RINGS * wv.w * smoothstep(0.9, 1.05, wq) * (1 - smoothstep(1.3, 1.9, wq));
    const rp = wl * 0.25 - age * 2.5;
    h += surge + lip + rf * Math.sin(rp);
    const slope = surge * ((-2 * sx) / SURGE_WIDTH) + (lip * ((-2 * lx) / 0.12)) / Math.max(wv.z, 1) + rf * Math.cos(rp) * 0.25;
    gx += (wdx / wl) * slope;
    gz += (wdz / wl) * slope;
  }
  if (s.tsuAmp > 0) {
    const tx = s.tsuDir.x;
    const tz = s.tsuDir.y;
    const d = x * tx + z * tz - s.tsuFront;
    const lat = 1 - smoothstep(TSU_LATERAL[0], TSU_LATERAL[1], Math.abs(-x * tz + z * tx));
    const xx = d + TSU_PEAK;
    const w = xx < 0 ? TSU_BACK : TSU_FACE;
    const e = Math.exp(-(xx * xx) / (w * w));
    const de = ((-2 * xx) / (w * w)) * e;
    const y = (d - 70) / 60;
    const tr = Math.exp(-y * y);
    const dtr = ((-2 * y) / 60) * tr;
    const amp = s.tsuAmp * lat;
    const lee = tsunamiLee(x + HALF_W, z + HALF_H); // game.js: no draw-back in the lee of land
    h += amp * (e - 0.12 * tr * lee);
    gx += tx * amp * (de - 0.12 * dtr * lee);
    gz += tz * amp * (de - 0.12 * dtr * lee);
  }
  out.gx = gx;
  out.gz = gz;
  return h;
}

// Fine squares (10 units) over the map and a margin around it, growing
// wider further out where the waves have faded away.
function seaAxis(inner) {
  const pts = [];
  for (let v = 0; v <= inner; v += 10) pts.push(v);
  let v = pts[pts.length - 1];
  let step = 10;
  while (v < SEA_FADE[1] + 100) {
    step *= 1.06;
    v += step;
    pts.push(Math.round(v));
  }
  pts.push(8000, 20000);
  return [...pts.slice(1).reverse().map((p) => -p), ...pts];
}

function seaGeometry() {
  const xs = seaAxis(HALF_W + 700);
  const zs = seaAxis(HALF_H + 700);
  // A plane in X/Y (the Water mirror expects that; it is laid flat by a
  // -90 degree turn about X, which sends local y to world -z).
  const geo = new THREE.PlaneGeometry(1, 1, xs.length - 1, zs.length - 1);
  const pos = geo.attributes.position;
  for (let iz = 0; iz < zs.length; iz++) {
    for (let ix = 0; ix < xs.length; ix++) {
      pos.setXY(iz * xs.length + ix, xs[ix], -zs[iz]);
    }
  }
  geo.computeBoundingSphere();
  return geo;
}

// Swaps the Water material's flat vertex shader for the moving one and lets
// the wave slope tilt the surface (light, reflections) and add foam.
function makeWavesMoving(material) {
  const u = material.uniforms;
  u.seaTime = { value: 0 };
  u.seaRough = { value: 0 };
  u.seaSwell = { value: 1 };
  u.tsuDir = { value: seaState.tsuDir };
  u.tsuFront = { value: 0 };
  u.tsuAmp = { value: 0 };
  u.shores = { value: seaState.shores };
  u.shoreCount = { value: 0 };
  u.leeCircles = { value: seaState.lee };
  u.leeCount = { value: 0 };
  u.whirl = { value: seaState.whirl };
  u.whirlSpin = { value: 1 };
  u.whirlAngle = { value: 0 };
  u.whirlAge = { value: -1 };
  u.foamColor = { value: new THREE.Color(1.25, 1.35, 1.4) };
  material.vertexShader = /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 mirrorCoord;
    varying vec4 worldPosition;
    varying vec4 vSea; // slope x, slope z, foam, tsunami crest

    #include <common>
    #include <fog_pars_vertex>
    #include <shadowmap_pars_vertex>
    #include <logdepthbuf_pars_vertex>
    ${SEA_GLSL}

    void main() {
      worldPosition = modelMatrix * vec4( position, 1.0 );
      float h; vec2 g; float foam; float crest;
      seaAt( worldPosition.xz, h, g, foam, crest );
      worldPosition.y += h;
      vSea = vec4( g, foam, crest );
      mirrorCoord = textureMatrix * worldPosition;
      vec4 mvPosition = viewMatrix * worldPosition;
      gl_Position = projectionMatrix * mvPosition;

      #include <beginnormal_vertex>
      #include <defaultnormal_vertex>
      #include <logdepthbuf_vertex>
      #include <fog_vertex>
      #include <shadowmap_vertex>
    }`;
  let fs = material.fragmentShader;
  const swap = (from, to) => {
    if (!fs.includes(from)) throw new Error("Water shader changed: " + from);
    fs = fs.replace(from, to);
  };
  swap(
    "varying vec4 worldPosition;",
    "varying vec4 worldPosition;\nvarying vec4 vSea;\nuniform float seaRough;\nuniform vec3 foamColor;\n" +
      "uniform vec4 whirl;\nuniform float whirlSpin;\nuniform float whirlAngle;\nuniform float whirlAge;"
  );
  // Inside a whirlpool the ripples turn with the water, faster near the
  // middle, so they wind into a spiral.
  swap(
    "vec4 noise = getNoise( worldPosition.xz * size );",
    "vec2 wdf = worldPosition.xz - whirl.xy;\n" +
      "float wqf = length( wdf ) / max( whirl.z, 1.0 );\n" +
      "float wa = -whirlSpin * whirlAngle * pow( 1.0 - min( wqf, 1.0 ), 2.0 );\n" +
      "vec2 np = whirl.xy + mat2( cos( wa ), sin( wa ), -sin( wa ), cos( wa ) ) * wdf;\n" +
      "vec4 noise = getNoise( ( whirl.w > 0.0 ? np : worldPosition.xz ) * size );"
  );
  swap(
    "vec3 surfaceNormal = normalize( noise.xzy * vec3( 1.5, 1.0, 1.5 ) );",
    "float ripple = 1.5 + 1.5 * seaRough;\n" +
      "vec3 surfaceNormal = normalize( noise.xzy * vec3( ripple, 1.0, ripple ) + vec3( -vSea.x, 0.0, -vSea.y ) );"
  );
  // The tall thin water near the tsunami's crest lets light through.
  swap("* waterColor;", "* mix( waterColor, waterColor * vec3( 1.6, 2.6, 2.4 ) + vec3( 0.0, 0.03, 0.035 ), vSea.w * 0.8 );");
  swap(
    "vec3 outgoingLight = albedo;",
    "float foamMask = smoothstep( 0.0, 1.0, vSea.z * 1.5 - 0.35 + noise.x * 0.9 );\n" +
      "vec3 foamLit = foamColor * ( 0.45 + 0.55 * max( dot( sunDirection, surfaceNormal ), 0.0 ) );\n" +
      // Whirlpool: wide foam streaks winding in (log spirals, broken up by the
      // ripples), churned turquoise water, a foam ring at the lip, the
      // opening surge's foam ring, and darker water close to the throat.
      "float wIn = whirl.w * ( 1.0 - smoothstep( 0.85, 1.15, wqf ) );\n" +
      "float th = atan( wdf.y, wdf.x ) - whirlSpin * whirlAngle;\n" +
      "float lr = log( max( wqf, 0.05 ) );\n" +
      "float arms = sin( 4.0 * th + whirlSpin * 9.0 * lr );\n" +
      "float fine = sin( 11.0 * th + whirlSpin * 24.0 * lr + noise.y * 3.0 );\n" +
      "float streaks = max( smoothstep( 0.35, 0.95, arms ), 0.75 * smoothstep( 0.55, 1.0, fine ) );\n" +
      "float band = smoothstep( 0.17, 0.23, wqf ) * ( 1.0 - smoothstep( 0.8, 1.1, wqf ) );\n" +
      "foamMask = max( foamMask, streaks * wIn * band * ( 0.55 + 0.6 * noise.x ) );\n" +
      // Water tumbling over the throat's edge: a ragged, turning foam lip.
      "float edge = exp( -pow( ( wqf - 0.215 + 0.025 * sin( 5.0 * th + noise.y * 4.0 ) ) / 0.035, 2.0 ) );\n" +
      "foamMask = max( foamMask, edge * whirl.w * smoothstep( 0.15, 0.7, noise.x + 0.35 * sin( 7.0 * th + whirlSpin * 16.0 * lr ) + 0.3 ) );\n" +
      "float rimFoam = exp( -pow( ( wqf - 0.98 ) / 0.07, 2.0 ) ) * whirl.w * smoothstep( 0.2, 0.8, noise.x + 0.3 );\n" +
      "float surgeFoam = whirlAge >= 0.0 ? exp( -pow( ( length( wdf ) - ( " + glslNum(SURGE_START) + " + " + glslNum(SURGE_SPEED) + " * whirlAge ) ) / 16.0, 2.0 ) ) * exp( -whirlAge / " + glslNum(SURGE_DECAY) + " ) : 0.0;\n" +
      "foamMask = max( foamMask, max( rimFoam, surgeFoam * ( 0.5 + 0.6 * noise.x ) ) );\n" +
      "float churn = whirl.w * smoothstep( 0.12, 0.3, wqf ) * ( 1.0 - smoothstep( 0.6, 1.0, wqf ) );\n" +
      "vec3 churned = mix( albedo, albedo * vec3( 1.25, 2.1, 2.0 ) + vec3( 0.0, 0.05, 0.06 ), churn * 0.7 );\n" +
      "vec3 outgoingLight = mix( churned, foamLit, foamMask );\n" +
      "outgoingLight *= 1.0 - 0.55 * whirl.w * exp( -pow( wqf / 0.26, 2.0 ) );"
  );
  material.fragmentShader = fs;
}

// Called once a frame: copies the game's sea roughness, the tsunami and the
// land (hazards, harbours, lighthouse islets) into the wave function.
function updateSea(dt) {
  const s = seaState;
  s.time = clock.t;
  s.rough = clamp(sea.roughness, 0, 1); // game.js already builds the sea up gradually
  s.swell = sea.swell;

  const ts = tsunami;
  let target = 0;
  if (ts.state === "warning") target = 1 - ts.timer / TSUNAMI_WARN_TIME;
  else if (ts.state === "active") target = smoothstep(0, 220, ts.endAt - ts.front);
  if (ts.state === "dormant") {
    s.tsuAmp = Math.max(0, s.tsuAmp - dt * TSU_HEIGHT * 0.5);
  } else {
    s.tsuAmp = target * TSU_HEIGHT;
    s.tsuDir.set(ts.dirX, ts.dirY);
    s.tsuFront = ts.front - (HALF_W * ts.dirX + HALF_H * ts.dirY);
  }

  let n = 0;
  const add = (x, y, inner, outer) => {
    if (n < MAX_SHORES) s.shores[n++].set(x - HALF_W, y - HALF_H, inner, outer);
  };
  for (const hz of hazards) add(hz.x, hz.y, hz.r, (hz.danger || hz.r) + 70);
  // The harbour land shelters its basin: calm water inside the breakwaters.
  for (const h of [HarbourA, HarbourB]) add(h.corner.x, h.corner.y, BASIN + 20, BASIN + 160);
  // Pack ice damps the swell under it and around its edge.
  for (const sheet of game.iceSheets) add(sheet.x, sheet.y, sheet.r, sheet.r + 90);
  s.shoreCount = n;
  // the land that shelters the sea behind it from the tsunami (only while one is on)
  if (ts.state !== "dormant") {
    const land = tsunamiLandCircles();
    land.forEach((c, i) => s.lee[i].set(c.x - HALF_W, c.y - HALF_H, c.r, 0));
    s.leeCount = land.length;
  } else {
    s.leeCount = 0;
  }

  const wp = whirlpool;
  if (wp.state === "dormant") {
    s.whirl.w = 0;
  } else {
    s.whirl.set(wp.x - HALF_W, wp.y - HALF_H, wp.r, wp.strength);
    s.whirlAngle += dt * (0.6 + 2.4 * wp.strength);
  }

  let calmSum = 0;
  for (const w of SEA_SWELLS) calmSum += w.calm + (w.storm - w.calm) * s.rough;
  s.lift = calmSum * 0.7 * s.swell * (1 + SEA_GROUP);

  const u = water.material.uniforms;
  u.seaTime.value = s.time;
  u.seaRough.value = s.rough;
  u.seaSwell.value = s.swell;
  u.tsuFront.value = s.tsuFront;
  u.tsuAmp.value = s.tsuAmp;
  u.shoreCount.value = n;
  u.leeCount.value = s.leeCount;
  u.whirlSpin.value = wp.spin;
  u.whirlAngle.value = s.whirlAngle;
  s.whirlAge = wp.state === "dormant" ? -1 : wp.age;
  u.whirlAge.value = s.whirlAge;
  updateWhirlVisuals(dt);
}

// ---------------------------------------------------------------------------
// Scene, sky, sea, light
// ---------------------------------------------------------------------------

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 16 / 9, 5, 24000);
// Player 2's camera, used only for the 2-player split-screen chase view.
const camera2 = new THREE.PerspectiveCamera(42, 16 / 9, 5, 24000);
let composer = null;
let water = null;
let sun = null;
let bloomPass = null;
const BLOOM_THRESHOLD = 3; // brightness a pixel needs before it glows (was 1.05)
let skyDome = null;
let hemiLight = null;
const clock = { t: 0 };

const SUN_ELEVATION = 24;
const SUN_AZIMUTH = 135;
const sunDir = new THREE.Vector3().setFromSphericalCoords(
  1,
  THREE.MathUtils.degToRad(90 - SUN_ELEVATION),
  THREE.MathUtils.degToRad(SUN_AZIMUTH)
);

const dotTex = softDotTexture();
const glowSoft = lightGlowTexture(false);
const glowStar = lightGlowTexture(true);

function buildEnvironment() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.5;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // The water mirror renders the scene a second time each frame; the shadow
  // map only needs drawing once, so it is refreshed by hand in renderFrame.
  renderer.shadowMap.autoUpdate = false;

  scene.fog = new THREE.Fog(0x9cc3dc, 3200, 15000);

  const sky = new Sky();
  skyDome = sky;
  sky.scale.setScalar(16000);
  const su = sky.material.uniforms;
  su.turbidity.value = 2;
  su.rayleigh.value = 3;
  su.mieCoefficient.value = 0.003;
  su.mieDirectionalG.value = 0.86;
  su.sunPosition.value.copy(sunDir);

  // Image-based lighting from the same sky, so metal, ice and wet hulls pick
  // up believable reflections without extra lights.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(sky);
  scene.environment = pmrem.fromScene(envScene).texture;
  scene.environmentIntensity = 0.7;
  scene.add(sky);

  const normals = new THREE.TextureLoader().load("vendor/three/textures/waternormals.jpg", (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
  });
  const reflection = detectGpu().dedicated ? 1024 : 512;
  water = new Water(seaGeometry(), {
    textureWidth: reflection,
    textureHeight: reflection,
    waterNormals: normals,
    sunDirection: sunDir.clone(),
    sunColor: 0xfff1d6,
    waterColor: 0x0a4560,
    distortionScale: 2.4,
    fog: true
  });
  water.rotation.x = -Math.PI / 2;
  // Seen from above, mirrored clouds, smoke and spout tops show up as stray
  // dark blobs with no visible source, so they're left out of the reflection.
  const renderMirror = water.onBeforeRender;
  water.onBeforeRender = function (...args) {
    setReflectionHidden(true);
    renderMirror.apply(this, args);
    setReflectionHidden(false);
  };
  water.material.uniforms.size.value = 0.9;
  water.receiveShadow = false;
  water.frustumCulled = false;
  makeWavesMoving(water.material);
  scene.add(water);

  sun = new THREE.DirectionalLight(0xfff0d6, 2.6);
  sun.position.copy(sunDir).multiplyScalar(1600);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.near = 200;
  sc.far = 4000;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun);
  scene.add(sun.target);

  hemiLight = new THREE.HemisphereLight(0xd4ecff, 0x16384a, 0.55);
  scene.add(hemiLight);

  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  // Glow only around real lights (lamps, lava, lightning, navigation lights).
  // A lower threshold let the bright daytime sky and sunlit sea glow too,
  // which laid a milky haze over the whole view (seen as fog from the start).
  bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.42, 0.55, BLOOM_THRESHOLD);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
}

// One flash light shared by every storm's lightning. The number of lights
// stays fixed for the whole game, so shaders never recompile mid-play.
const lightningLight = new THREE.PointLight(0xdfe9ff, 0, 900, 1);
lightningLight.position.y = 120;
scene.add(lightningLight);

// ---------------------------------------------------------------------------
// Ships
// ---------------------------------------------------------------------------

function hullGeometry(len, beam, height) {
  const h = len / 2;
  const b = beam / 2;
  const s = new THREE.Shape();
  s.moveTo(h, 0);
  s.quadraticCurveTo(h * 0.6, b, h * 0.08, b);
  s.lineTo(-h * 0.86, b);
  s.quadraticCurveTo(-h, b, -h, b * 0.55);
  s.lineTo(-h, -b * 0.55);
  s.quadraticCurveTo(-h, -b, -h * 0.86, -b);
  s.lineTo(h * 0.08, -b);
  s.quadraticCurveTo(h * 0.6, -b, h, 0);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: height,
    bevelEnabled: true,
    bevelThickness: 1.2,
    bevelSize: 1,
    bevelSegments: 3,
    curveSegments: 12
  });
  g.rotateX(-Math.PI / 2); // extrusion now points up
  g.translate(0, -height * 0.5, 0); // about half the hull sits below the waterline
  return g;
}

function box(w, h, d, material, x, y, z) {
  const m = mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  return m;
}

function cylinder(rTop, rBottom, h, material, x, y, z, segments = 12) {
  const m = mesh(new THREE.CylinderGeometry(rTop, rBottom, h, segments), material);
  m.position.set(x, y, z);
  return m;
}

// Square sail billowed forward, spanning the beam.
function squareSail(w, h, depth, material) {
  const g = new THREE.PlaneGeometry(w, h, 10, 8);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) / (w / 2);
    const y = p.getY(i) / (h / 2);
    p.setZ(i, depth * (1 - x * x) * (0.55 + 0.45 * (1 - y * y)));
  }
  g.rotateY(Math.PI / 2);
  g.computeVertexNormals();
  return mesh(g, material);
}

// Fore-and-aft triangular sail in the ship's centre plane.
function triSail(points, material) {
  const s = new THREE.Shape();
  s.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) s.lineTo(x, y);
  return mesh(new THREE.ShapeGeometry(s), material);
}

const WHITE = 0xf4f4f0;
// Weathered shipping-line colours (rust red, navy, grey, off-white, green,
// orange, light blue, maroon), as on a real container stack.
const CONTAINER_COLORS = [0x8e2b22, 0x1f4e79, 0x6f7a80, 0xd9d4c7, 0x2f6b3b, 0xb5651d, 0x3d7fb5, 0x6b2d5c];
// Container ship deck cargo, in model units. A 40 ft box is about 5 times as
// long as it is wide and a little taller than wide; a 20 ft box is half the
// length. Bays run fore and aft, rows across the deck, tiers upward. The
// stacks are highest aft and step down towards the narrow bow, so the bridge
// can still see over them to the sea ahead.
const BOX_40 = { len: 9.6, w: 2.0, h: 2.1 };
const BOX_GAP = 0.15;
const CARGO_DECK_Y = 5.4;
const CARGO_BAYS = [
  { x: -10.8, tiers: [4, 4, 4, 4, 4] },
  { x: -0.6, tiers: [4, 3, 4, 4, 3] },
  { x: 9.6, tiers: [2, 3, 3, 2] } // the hull narrows towards the bow: 4 rows
];

// All the boxes as one instanced mesh (one draw call), each with its own colour.
function containerStacks() {
  const slots = [];
  CARGO_BAYS.forEach((bay, b) => {
    const rows = bay.tiers.length;
    bay.tiers.forEach((tiers, r) => {
      const z = (r - (rows - 1) / 2) * (BOX_40.w + BOX_GAP);
      for (let t = 0; t < tiers; t++) {
        const y = CARGO_DECK_Y + BOX_40.h / 2 + t * (BOX_40.h + BOX_GAP);
        const seed = (b * 37 + r * 11 + t * 5) % 13;
        // Now and then two 20 ft boxes share a 40 ft slot.
        if (seed % 5 === 0) {
          const half = (BOX_40.len - BOX_GAP) / 2;
          slots.push({ x: bay.x - (half + BOX_GAP) / 2, y, z, len: half, color: (seed + t) % CONTAINER_COLORS.length });
          slots.push({ x: bay.x + (half + BOX_GAP) / 2, y, z, len: half, color: (seed + r + 3) % CONTAINER_COLORS.length });
        } else {
          slots.push({ x: bay.x, y, z, len: BOX_40.len, color: (seed * 3 + r) % CONTAINER_COLORS.length });
        }
      }
    });
  });
  const boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(0xffffff, { roughness: 0.75, metalness: 0.2 }), slots.length);
  boxes.castShadow = true;
  boxes.receiveShadow = true;
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  slots.forEach((sl, i) => {
    m.makeScale(sl.len, BOX_40.h, BOX_40.w).setPosition(sl.x, sl.y, sl.z);
    boxes.setMatrixAt(i, m);
    boxes.setColorAt(i, c.set(CONTAINER_COLORS[sl.color]));
  });
  return boxes;
}

// ---- Aircraft carrier ----------------------------------------------------
// Flight deck outline (x forward, z to port), model units.
const CARRIER_DECK = [
  [-25, -4.2], [-25, 2.6], [-18, 5.6], [2, 6.4], [5, 4], [19, 3.4], [25, 1.9],
  [25, -1.9], [19, -4.2], [9, -5.4], [-13, -5.4], [-20, -4.8]
];
const CARRIER_DECK_BASE = 3.4; // about 21 m above the sea at real size (x 2.18)
const CARRIER_DECK_TOP = 4.2;
const CARRIER_ISLAND_Z = -4.4; // on the starboard edge
const DECK_LEN = 50;
const DECK_SPAN = 12.8;
// The landing area: from near the stern centre, angled 9 degrees to port.
const LANDING_START = [-25, 0.6];
const LANDING_ANGLE = (9 * Math.PI) / 180;
const LANDING_LEN = 29;
const LANDING_HALF_W = 1.9;

// The deck's paint: landing area lines, arresting wires, catapult tracks,
// taxi lines, lift outlines, the hull number and tyre and oil marks.
function carrierDeckTexture() {
  const W = 2048;
  const H = 512;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const c = cv.getContext("2d");
  c.fillStyle = "#3d4146";
  c.fillRect(0, 0, W, H);
  // Draw in deck units: x forward to the right, z (port) downward.
  c.setTransform(W / DECK_LEN, 0, 0, H / DECK_SPAN, W / 2, H / 2);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 160; i++) {
    c.fillStyle = `rgba(20, 22, 25, ${0.08 + rnd() * 0.12})`;
    c.beginPath();
    c.ellipse(-25 + rnd() * 50, -6 + rnd() * 12, 0.3 + rnd() * 1.2, 0.15 + rnd() * 0.4, rnd() * 3, 0, Math.PI * 2);
    c.fill();
  }
  const line = (x1, z1, x2, z2, color, w, dash = []) => {
    c.strokeStyle = color;
    c.lineWidth = w;
    c.setLineDash(dash);
    c.beginPath();
    c.moveTo(x1, z1);
    c.lineTo(x2, z2);
    c.stroke();
  };
  // Landing area, in its own angled frame.
  c.save();
  c.translate(LANDING_START[0], LANDING_START[1]);
  c.rotate(LANDING_ANGLE);
  c.fillStyle = "rgba(15, 16, 18, 0.35)"; // darkened by tyre rubber
  c.fillRect(2, -0.7, 14, 1.4);
  line(0, -LANDING_HALF_W, LANDING_LEN, -LANDING_HALF_W, "#eeeeee", 0.09);
  line(0, LANDING_HALF_W, LANDING_LEN, LANDING_HALF_W, "#eeeeee", 0.09);
  line(0.5, 0, LANDING_LEN, 0, "#eeeeee", 0.07, [1.2, 0.8]);
  line(0, -LANDING_HALF_W - 0.35, LANDING_LEN, -LANDING_HALF_W - 0.35, "#e3c14a", 0.06); // foul line
  for (const d of [5.5, 6.5, 7.5, 8.5]) line(d, -LANDING_HALF_W + 0.1, d, LANDING_HALF_W - 0.1, "#a4a9ae", 0.06, []);
  c.restore();
  // Bow catapults, yellow taxi lines leading to them.
  for (const z of [-1.3, 1.3]) {
    line(14, z, 24.6, z, "#1d1f22", 0.12, []);
    line(14, z + 0.25, 24.6, z + 0.25, "#cfcfcf", 0.03, []);
  }
  c.strokeStyle = "#e3c14a";
  c.lineWidth = 0.06;
  c.setLineDash([]);
  for (const z of [-1.3, 1.3]) {
    c.beginPath();
    c.moveTo(-12, -2.2);
    c.quadraticCurveTo(8, -2.2, 13.6, z);
    c.stroke();
  }
  // Deck-edge lifts (three to starboard, one to port).
  c.strokeStyle = "#7d838a";
  c.lineWidth = 0.08;
  for (const [x, z, w, h] of [[0, -5.4, 4.4, 2.2], [5.2, -5.4, 4.4, 2.2], [-15.5, -5.4, 4.4, 2.2], [-19, 3.6, 4.4, 2.1]]) c.strokeRect(x, z, w, h);
  // Hull number near the bow, read from astern: the text's "right" runs to
  // starboard (canvas up) and its "up" runs forward (canvas right).
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  const nx = ((21.5 / DECK_LEN) + 0.5) * W;
  const ny = H / 2;
  c.translate(nx, ny);
  c.transform(0, -1, -1, 0, 0, 0);
  c.fillStyle = "#e9e9e9";
  c.font = "bold 150px Arial";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText("99", 0, 0);
  c.restore();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  // The deck's cap UVs are its outline coordinates (x, -z): map them onto the canvas.
  tex.repeat.set(1 / DECK_LEN, 1 / DECK_SPAN);
  tex.offset.set(0.5, 0.5);
  return tex;
}

let carrierDeckTex = null;
function carrierFlightDeck() {
  const shape = new THREE.Shape();
  CARRIER_DECK.forEach(([x, z], i) => (i ? shape.lineTo(x, -z) : shape.moveTo(x, -z)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: CARRIER_DECK_TOP - CARRIER_DECK_BASE, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2); // outline (x, -z) lies flat, extrusion points up
  geo.translate(0, CARRIER_DECK_BASE, 0);
  // The texture is shared; the material is per ship (hits and fire tint it).
  if (!carrierDeckTex) carrierDeckTex = carrierDeckTexture();
  return mesh(geo, mat(0xffffff, { map: carrierDeckTex, roughness: 0.85 }));
}

// A twin-tailed jet fighter, about 2.5 units (17 m) long: each part as one
// instanced mesh for the whole air wing, so ten jets cost a few draw calls.
function jetPartGeometries() {
  const flat = (pts, depth) => {
    const sh = new THREE.Shape();
    pts.forEach(([x, z], i) => (i ? sh.lineTo(x, -z) : sh.moveTo(x, -z)));
    return new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false }).rotateX(-Math.PI / 2);
  };
  const wing = (span) => flat([[0.35, 0.12], [-0.3, span], [-0.55, span], [-0.55, 0.12], [-0.55, -0.12], [-0.55, -span], [-0.3, -span], [0.35, -0.12]], 0.035);
  const fin = () => {
    const sh = new THREE.Shape();
    sh.moveTo(-0.6, 0);
    sh.lineTo(-1.05, 0);
    sh.lineTo(-1.12, 0.5);
    sh.lineTo(-0.92, 0.5);
    return new THREE.ExtrudeGeometry(sh, { depth: 0.03, bevelEnabled: false });
  };
  const at = (geo, x, y, z, rx = 0) => geo.rotateX(rx).translate(x, y, z);
  return {
    body: [
      at(new THREE.CylinderGeometry(0.13, 0.1, 1.9, 8).rotateZ(-Math.PI / 2), -0.15, 0.24, 0),
      at(new THREE.ConeGeometry(0.13, 0.55, 8).rotateZ(-Math.PI / 2), 1.07, 0.24, 0),
      at(flat([[-0.78, 0.1], [-1.0, 0.55], [-1.15, 0.55], [-1.12, 0.1], [-1.12, -0.1], [-1.15, -0.55], [-1.0, -0.55], [-0.78, -0.1]], 0.03), 0, 0.24, 0),
      at(fin(), 0, 0.28, 0.17, 0.35),
      at(fin(), 0, 0.28, -0.2, -0.35)
    ],
    canopy: at(new THREE.SphereGeometry(1, 10, 6).scale(0.32, 0.1, 0.1), 0.55, 0.35, 0),
    wingOut: wing(1.0).translate(0, 0.22, 0), // spread, ready to launch
    wingFolded: wing(0.72).translate(0, 0.22, 0) // tips folded up when parked
  };
}

// Where the jets sit: two on the bow catapults, wings spread; the rest
// parked along the starboard edge, noses angled in, wings folded.
// The starboard catapult (z -1.3) is kept clear for the jet that flies out
// on patrol: the first parked jet (SORTIE_SLOT) taxis to it.
const CARRIER_JETS = [
  { x: 16, z: 1.3, yaw: 0, out: true },
  ...[6, 8, 10, 12, 14].map((x) => ({ x, z: -4.2, yaw: -1.05, out: false })),
  ...[-11, -13, -15].map((x) => ({ x, z: -4.2, yaw: -1.05, out: false }))
];

function carrierAirWing(glass) {
  const parts = jetPartGeometries();
  const jetMat = mat(0x8f99a4, { roughness: 0.5, metalness: 0.4 });
  const m = new THREE.Matrix4();
  const place = (geo, material, jets) => {
    const im = new THREE.InstancedMesh(geo, material, jets.length);
    im.castShadow = true;
    im.receiveShadow = true;
    im.userData.slots = jets.map((j) => CARRIER_JETS.indexOf(j)); // which jet each instance is
    jets.forEach((j, i) => im.setMatrixAt(i, m.makeRotationY(j.yaw).setPosition(j.x, CARRIER_DECK_TOP, j.z)));
    return im;
  };
  return [
    ...parts.body.map((geo) => place(geo, jetMat, CARRIER_JETS)),
    place(parts.canopy, glass, CARRIER_JETS),
    place(parts.wingOut, jetMat, CARRIER_JETS.filter((j) => j.out)),
    place(parts.wingFolded, jetMat, CARRIER_JETS.filter((j) => !j.out))
  ];
}

// ---- The carrier's patrol jet ------------------------------------------------
// game.js decides what the jet does (ship.jet.state, .t); on deck it is drawn
// here as a child of the carrier model, in deck units: taxiing from its
// parking spot to the starboard catapult, running up with the afterburner
// lit, thrown down the catapult, and after a sortie landing on the angled
// deck and taxiing back. In the air it flies at game.js's x, y and height,
// banking into its turns. The parked jet it is (SORTIE_SLOT) is hidden while
// it is away.
const SORTIE_SLOT = 1;
const flyingSorties = new Map(); // jets in the air -> their carrier's 3D object
const sortieTmp = { e: new THREE.Euler(0, 0, 0, "YZX") };

function buildSortieJet() {
  const parts = jetPartGeometries();
  const jetMat = mat(0x8f99a4, { roughness: 0.5, metalness: 0.4 });
  const group = new THREE.Group();
  for (const geo of parts.body) group.add(mesh(geo, jetMat));
  group.add(mesh(parts.canopy, mat(0x1a2b3c, { roughness: 0.15, metalness: 0.7 })));
  const out = mesh(parts.wingOut, jetMat);
  const folded = mesh(parts.wingFolded, jetMat);
  const flame = mesh(
    new THREE.ConeGeometry(0.11, 0.9, 10).rotateZ(Math.PI / 2).translate(-1.55, 0.24, 0),
    new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    false
  );
  group.add(out, folded, flame);
  return { group, out, folded, flame, onDeck: null };
}

function setParkedJetVisible(o, visible) {
  if (o.parkedJetShown === visible) return;
  o.parkedJetShown = visible;
  const j = CARRIER_JETS[SORTIE_SLOT];
  const m = visible ? new THREE.Matrix4().makeRotationY(j.yaw).setPosition(j.x, CARRIER_DECK_TOP, j.z) : new THREE.Matrix4().makeScale(0, 0, 0);
  for (const im of o.airWing) {
    const i = im.userData.slots.indexOf(SORTIE_SLOT);
    if (i < 0) continue;
    im.setMatrixAt(i, m);
    im.instanceMatrix.needsUpdate = true;
  }
}

function updateSortieJet(ship, o) {
  const jet = ship.jet;
  const away = jet && jet.state !== "parked";
  setParkedJetVisible(o, !away);
  if (!o.sortie) {
    if (!away) return;
    o.sortie = buildSortieJet();
  }
  const s = o.sortie;
  const g = s.group;
  if (!away || jet.state === "lost") {
    g.visible = false;
    return;
  }
  g.visible = true;
  const flying = JET_FLYING.has(jet.state) || jet.state === "down";
  if (s.onDeck !== !flying) {
    // Moves between the deck (child of the carrier model, deck units) and the sky.
    if (flying) {
      scene.add(g);
      g.scale.setScalar(shipScale("Carrier"));
      flyingSorties.set(g, o);
    } else {
      o.model.add(g);
      g.scale.setScalar(1);
      flyingSorties.delete(g);
    }
    s.onDeck = !flying;
  }
  let wingsOut = true;
  let flame = 0;
  if (flying) {
    toWorld(jet.x, jet.y, jet.alt + (jet.state === "down" ? 0 : Math.sin(clock.t * 1.7) * 0.4), g.position);
    const climb = jet.state === "climb" ? 0.25 : jet.state === "final" ? -0.08 : 0;
    const roll = jet.state === "down" ? clock.t * 6 : clamp(-jet.turn * 0.55, -1.1, 1.1);
    g.rotation.copy(sortieTmp.e.set(roll, -jet.angle, climb, "YZX"));
    flame = jet.state === "down" ? 0.9 : jet.state === "climb" ? 0.9 : 0.35;
  } else {
    const pose = jetDeckPose(jet); // game.js: shared with the 2D map
    wingsOut = pose.wingsOut;
    flame = pose.flame;
    g.position.set(pose.x, CARRIER_DECK_TOP, pose.z);
    g.rotation.set(0, pose.yaw, 0);
  }
  s.out.visible = wingsOut;
  s.folded.visible = !wingsOut;
  s.flame.material.opacity = flame * (0.75 + 0.25 * Math.random());
  s.flame.scale.set(0.6 + flame * 0.6, 1, 1);
}

// Warning bursts and crashes (splashes on the sea) and the gunfire between
// jets and pirates (tracer lines), from game.js jetBursts and jetTracers.
const BURST_POOL = 48;
const TRACER_POOL = 24;
const jetFx = (() => {
  const splashes = [];
  for (let i = 0; i < BURST_POOL; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0xf2f7fa, transparent: true, depthWrite: false, opacity: 0 }));
    sp.visible = false;
    scene.add(sp);
    splashes.push(sp);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRACER_POOL * 6), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(TRACER_POOL * 6), 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
  lines.frustumCulled = false;
  scene.add(lines);
  return { splashes, lines, color: new THREE.Color(), v: new THREE.Vector3() };
})();

function updateJetEffects() {
  const { splashes, lines, color, v } = jetFx;
  splashes.forEach((sp, i) => {
    const b = game.jetBursts[i];
    sp.visible = !!b && b.age >= 0;
    if (!sp.visible) return;
    const life = b.big ? 2.2 : 1.4;
    const k = b.age / life;
    toWorld(b.x, b.y, 0, sp.position);
    sp.position.y = seaHeight(sp.position.x, sp.position.z) + (b.big ? 10 : 4) * Math.sqrt(k);
    sp.scale.set(b.big ? 22 + 20 * k : 5 + 5 * k, b.big ? 30 * (1 - k * 0.5) : 12 * (1 - k * 0.6), 1);
    sp.material.opacity = 0.9 * (1 - k);
  });
  const pos = lines.geometry.attributes.position;
  const col = lines.geometry.attributes.color;
  let n = 0;
  for (const tr of game.jetTracers) {
    if (n >= TRACER_POOL || tr.age < 0) continue;
    const fade = 1 - tr.age / 0.25;
    toWorld(tr.x1, tr.y1, tr.a1, v);
    pos.setXYZ(n * 2, v.x, v.y, v.z);
    toWorld(tr.x2, tr.y2, tr.a2, v);
    pos.setXYZ(n * 2 + 1, v.x, v.y, v.z);
    color.setHex(tr.color).multiplyScalar(fade);
    col.setXYZ(n * 2, color.r, color.g, color.b);
    col.setXYZ(n * 2 + 1, color.r, color.g, color.b);
    n++;
  }
  lines.geometry.setDrawRange(0, n * 2);
  pos.needsUpdate = true;
  col.needsUpdate = true;
}

// ---- Cruise liner ------------------------------------------------------------
// A modern 300 m liner at real size (1 unit is about 3 m): built in world
// units, 98 long and 12.5 wide. Hull in the ship's colour; a white
// superstructure nine decks high whose long sides are rows of cabin
// balconies (lit at night), lifeboats along both sides, the bridge with its
// wings forward, and on top the lido deck: two pools, sun loungers and a
// water slide, with the raked funnel aft.
const CRUISE = { len: 98, beam: 12.5 };
let cruiseTex = null;

function cruiseTextures() {
  // One balcony per tile: glass door, white divider, railing.
  const make = (lit) => {
    const cv = document.createElement("canvas");
    cv.width = 64;
    cv.height = 32;
    const cx = cv.getContext("2d");
    cx.fillStyle = lit ? "#000000" : "#f2f1ec";
    cx.fillRect(0, 0, 64, 32);
    cx.fillStyle = lit ? "#ffd58a" : "#203447";
    cx.fillRect(6, 5, 52, 20); // glass
    if (!lit) {
      cx.fillStyle = "#e6e4dc";
      cx.fillRect(0, 0, 4, 32); // divider between balconies
      cx.fillStyle = "#d4d2ca";
      cx.fillRect(4, 22, 56, 3); // railing
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };
  return { cabins: make(false), glow: make(true) };
}

function cruiseLiner(g, hull, white, glass, steel) {
  const { len, beam } = CRUISE;
  if (!cruiseTex) cruiseTex = cruiseTextures();
  g.add(mesh(hullGeometry(len, beam, 7), hull));
  // Main superstructure: lower decks, then the cabin block.
  const aft = -len / 2 + 3;
  const front = len / 2 - 20;
  g.add(box(front - aft, 2, beam - 0.6, white, (front + aft) / 2, 5.6, 0)); // promenade decks
  const cabinLen = front - aft - 3;
  const cabinX = (front + aft) / 2 - 1.5;
  const decks = 7;
  const cabinTop = 6.6 + decks;
  g.add(box(cabinLen, decks, beam - 1, white, cabinX, 6.6 + decks / 2, 0));
  // Balcony rows on both long sides (one tile per balcony, 1.4 units wide).
  const tex = cruiseTex.cabins.clone();
  // Night lights: only some of the cabins are lit, in slightly different warm and cool tones, one
  // 16x8 tile per balcony (the glass sits where the balcony texture has it).
  const cols = Math.round(cabinLen / 1.4);
  tex.repeat.set(cols, decks);
  tex.needsUpdate = true;
  const glowCv = document.createElement("canvas");
  glowCv.width = cols * 16;
  glowCv.height = decks * 8;
  const gg = glowCv.getContext("2d");
  gg.fillStyle = "#000";
  gg.fillRect(0, 0, glowCv.width, glowCv.height);
  const warm = ["#ffd58a", "#ffe7b0", "#ffc46b", "#ffdca0", "#bcd7ff"];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < decks; r++) {
      if (Math.random() > 0.32) continue;
      gg.fillStyle = warm[Math.floor(Math.random() * warm.length)];
      gg.globalAlpha = 0.6 + Math.random() * 0.4;
      gg.fillRect(c * 16 + 1.5, r * 8 + 1.25, 13, 5);
    }
  }
  gg.globalAlpha = 1;
  const glowTex = new THREE.CanvasTexture(glowCv);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  const cabinMat = mat(0xffffff, { roughness: 0.6, map: tex, emissive: 0xffffff, emissiveMap: glowTex, emissiveIntensity: 0 });
  harbourNightLights.push([cabinMat, 1.2]); // lit cabins at night
  for (const side of [-1, 1]) {
    const panel = mesh(new THREE.PlaneGeometry(cabinLen, decks), cabinMat, false);
    panel.position.set(cabinX, 6.6 + decks / 2, side * (beam / 2 - 0.48));
    if (side < 0) panel.rotation.y = Math.PI;
    g.add(panel);
  }
  // Promenade windows along the lower decks.
  g.add(box(front - aft + 0.1, 0.5, beam - 0.5, glass, (front + aft) / 2, 5.9, 0));
  // Lifeboats hanging along both sides of the promenade.
  const boatMat = mat(0xf07a1a, { roughness: 0.5 });
  for (let x = aft + 8; x < front - 6; x += 6.5) {
    for (const side of [-1, 1]) {
      const boat = mesh(new THREE.CapsuleGeometry(0.55, 2.6, 4, 8), boatMat);
      boat.rotation.z = Math.PI / 2;
      boat.position.set(x, 6.2, side * (beam / 2 + 0.1));
      g.add(boat);
    }
  }
  // Bridge: a wheelhouse standing on the forward end of the cabin block (it is part of the
  // superstructure, not a separate box), with a raked window band, side windows, a roof
  // overhang and open bridge wings braced back to the cabin sides.
  const bw = beam - 3.5; // wheelhouse width
  const bx = front - 3.1; // wheelhouse centre; its front is flush with the cabin's front face
  const bl = 6;
  const bh = 3.2;
  g.add(box(bl, bh, bw, white, bx, cabinTop + bh / 2, 0));
  const frontGlass = box(0.15, 1.3, bw - 0.5, glass, bx + bl / 2 + 0.03, cabinTop + 2.1, 0);
  frontGlass.rotation.z = 0.22; // rakes back at the top
  g.add(frontGlass);
  for (const side of [-1, 1]) {
    g.add(box(bl - 1, 1.1, 0.12, glass, bx, cabinTop + 2.1, side * (bw / 2 + 0.03)));
    // the wing: floor, glass screen, rail, and two braces down to the cabin side
    const wz = side * (bw / 2 + 1.1);
    g.add(box(2.6, 0.3, 2.4, white, bx + 0.6, cabinTop + 1, wz));
    g.add(box(0.1, 0.9, 2.4, glass, bx + 1.85, cabinTop + 1.55, wz));
    g.add(box(2.6, 0.06, 0.06, steel, bx + 0.6, cabinTop + 1.95, side * (bw / 2 + 2.3)));
    for (const dx of [-0.5, 1.5]) {
      const brace = box(0.15, 1.4, 0.15, white, bx + dx, cabinTop + 0.5, side * (bw / 2 + 1.7));
      brace.rotation.x = side * 0.76;
      g.add(brace);
    }
  }
  g.add(box(bl + 1.2, 0.3, bw + 0.8, white, bx + 0.4, cabinTop + bh + 0.15, 0)); // roof overhang
  g.add(cylinder(0.12, 0.15, 3.4, steel, bx - 1, cabinTop + bh + 1.9, 0, 6)); // radar mast
  g.add(box(0.3, 0.2, 2.6, steel, bx - 1, cabinTop + bh + 3.6, 0));
  // Forecastle: windlass and bollards on the foredeck.
  g.add(box(1.8, 0.8, 2.2, steel, front + 11, 5.1, 0));
  for (const z of [-1.3, 1.3]) g.add(cylinder(0.25, 0.3, 0.8, steel, front + 8, 5.1, z, 8));
  // Lido deck on top: teak-coloured deck, two pools with a white rim,
  // sun loungers in rows, and a yellow spiral water slide.
  const deckX = (front + aft) / 2 - 4;
  const deckLen = cabinLen - 10;
  g.add(box(deckLen, 0.3, beam - 1.4, mat(0xc9b48f, { roughness: 0.8 }), deckX, cabinTop + 0.15, 0));
  const rim = mat(0xf5f5f0, { roughness: 0.5 });
  const water = mat(0x37b4e0, { roughness: 0.08, metalness: 0.1, emissive: 0x0b4f6b, emissiveIntensity: 0.6 });
  for (const px of [deckX + 6, deckX - 9]) {
    g.add(box(8.6, 0.35, 5.2, rim, px, cabinTop + 0.4, 0));
    g.add(box(8, 0.1, 4.6, water, px, cabinTop + 0.6, 0));
  }
  const loungers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.65, 0.18, 0.3), mat(0xffffff, { roughness: 0.6 }), 48);
  const m = new THREE.Matrix4();
  let n = 0;
  for (const px of [deckX + 6, deckX - 9]) {
    for (const side of [-1, 1]) {
      for (let k = 0; k < 12; k++) {
        m.makeTranslation(px - 4 + k * 0.72, cabinTop + 0.45, side * 3.6);
        loungers.setMatrixAt(n++, m);
      }
    }
  }
  loungers.castShadow = true;
  g.add(loungers);
  const turns = 2.2;
  const points = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    const a = t * turns * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(a) * 1.6, 4.2 - t * 3.8, Math.sin(a) * 1.6));
  }
  const slide = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 80, 0.28, 8), mat(0xf2c12e, { roughness: 0.4 }));
  slide.position.set(deckX + 15, cabinTop + 0.3, -beam / 2 + 2.6);
  g.add(slide);
  // Sports deck and the raked funnel aft, in the line's colour with a black top.
  g.add(box(14, 1, beam - 2, white, aft + 10, cabinTop + 0.5, 0));
  const funnel = box(5, 6, 3.6, hull, aft + 9, cabinTop + 4, 0);
  funnel.rotation.z = 0.18;
  g.add(funnel);
  const funnelTop = box(5.2, 0.8, 3.8, mat(0x111111), aft + 8.4, cabinTop + 7.2, 0);
  funnelTop.rotation.z = 0.18;
  g.add(funnelTop);
}

function buildShipModel(ship) {
  const category = ship.type === "pirate" ? "Pirate" : ship.category || "Cruise";
  const color = new THREE.Color(ship.displayColor || (ship.type === "cruise" ? "#2f7ef7" : "#f0d034"));
  const g = new THREE.Group();
  const hull = mat(color, { roughness: 0.42, metalness: 0.15 });
  const white = mat(WHITE, { roughness: 0.5 });
  const wood = mat(0x8a6542, { roughness: 0.85 });
  const darkWood = mat(0x3e2616, { roughness: 0.8 });
  const steel = mat(0x5f6b76, { roughness: 0.45, metalness: 0.6 });
  const glass = mat(0x1a2b3c, { roughness: 0.15, metalness: 0.7 });
  const sailCloth = mat(0xf3ecd8, { roughness: 0.9, side: THREE.DoubleSide });
  let candle = null;
  let wheel = null;
  let airWing = null;

  if (category === "Cruise") {
    cruiseLiner(g, hull, white, glass, steel);
  } else if (category === "Cargo") {
    // A slim hull (about 4 times as long as wide), hatch covers, the boxes,
    // lashing bridges between the bays, a breakwater at the bow to shield
    // the front stack from green seas, and a tall accommodation tower aft
    // with the bridge on top, its wings spanning the full beam.
    const grey = mat(0x4b545c, { roughness: 0.7, metalness: 0.3 });
    g.add(mesh(hullGeometry(50, 12, 8), hull));
    g.add(box(36, 0.6, 11.4, grey, -0.6, 5.1, 0));
    g.add(containerStacks());
    for (const x of [-5.7, 4.5]) g.add(box(0.35, 2.4, 11, steel, x, 6.6, 0));
    g.add(box(0.5, 2.6, 9, white, 15.4, 6.6, 0));
    g.add(box(5, 15, 11.6, white, -18.5, 12.9, 0)); // accommodation, 7 decks
    g.add(box(5.2, 1.3, 11.8, glass, -18.5, 15, 0));
    g.add(box(5.2, 1.3, 11.8, glass, -18.5, 11, 0));
    g.add(box(4, 1.8, 14.6, white, -17.5, 19.6, 0)); // bridge deck and wings
    g.add(box(4.1, 1.1, 14.7, glass, -17.4, 19.8, 0));
    g.add(box(3, 0.4, 3, steel, -18, 20.7, 0));
    g.add(cylinder(0.2, 0.25, 4, steel, -18.5, 22.6, 0, 6)); // radar mast
    g.add(box(2.6, 9, 3.4, hull, -22.6, 10, 0)); // funnel in the line's colour
    g.add(box(2.7, 1.2, 3.5, mat(0x111111), -22.6, 14.8, 0));
  } else if (category === "Sailing") {
    g.add(mesh(hullGeometry(34, 10, 7), hull));
    g.add(box(24, 0.8, 7.5, wood, -1, 4.1, 0));
    g.add(cylinder(0.45, 0.6, 38, steel, 3, 22, 0, 8));
    g.add(triSail([[2.4, 6], [2.4, 40], [-13, 6.5]], sailCloth));
    g.add(triSail([[3.6, 9], [3.6, 38], [16, 5]], sailCloth));
    // The helm: a big spoked wooden wheel on a post at the stern.
    g.add(box(0.8, 3.6, 0.8, darkWood, -11.6, 6.3, 0));
    wheel = new THREE.Group();
    wheel.add(mesh(new THREE.TorusGeometry(1.8, 0.18, 8, 28), wood));
    wheel.add(mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.6, 10).rotateX(Math.PI / 2), darkWood));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const spoke = mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.7, 5), wood);
      spoke.position.set(Math.cos(a) * 1.35, Math.sin(a) * 1.35, 0);
      spoke.rotation.z = a - Math.PI / 2;
      wheel.add(spoke);
    }
    wheel.rotation.y = Math.PI / 2; // faces fore and aft
    wheel.position.set(-11.2, 8.1, 0);
    g.add(wheel);
  } else if (category === "Catamaran") {
    for (const z of [-6.5, 6.5]) {
      const pontoon = mesh(hullGeometry(36, 5, 6), hull);
      pontoon.position.z = z;
      g.add(pontoon);
    }
    g.add(box(24, 1.6, 17, white, -2, 4.4, 0));
    g.add(box(10, 4, 10, white, -5, 7.2, 0));
    g.add(box(10.3, 1.3, 10.3, glass, -5, 8, 0));
    g.add(cylinder(0.45, 0.6, 36, steel, 3, 23, 0, 8));
    g.add(triSail([[2.4, 6], [2.4, 40], [-12, 7]], sailCloth));
  } else if (category === "Assault") {
    g.add(mesh(hullGeometry(42, 12, 8), hull));
    const grey = mat(0x6d7782, { roughness: 0.5, metalness: 0.4 });
    const tower = box(14, 7, 8, grey, -4, 8, 0);
    g.add(tower);
    g.add(box(8, 4, 6.5, grey, -5, 13.5, 0));
    g.add(cylinder(0.4, 0.4, 10, steel, -5, 20, 0, 6));
    for (const x of [12, -16]) {
      g.add(cylinder(2.6, 3, 2.2, grey, x, 5.6, 0, 14));
      const barrel = cylinder(0.5, 0.5, 9, steel, x + (x > 0 ? 4.5 : -4.5), 6, 0, 6);
      barrel.rotation.z = Math.PI / 2;
      g.add(barrel);
    }
  } else if (category === "Carrier") {
    // To scale with a real supercarrier (1 unit ~ 6.7 m): a narrow hull
    // under a much wider flight deck, the angled landing deck flaring out to
    // port, the island on the starboard edge, jets about 2.5 units long.
    // Built in model units; drawn at real size (333 m) by SHIP_SIZE.Carrier.
    // Navy grey above the waterline, the line's colour below it (the stripe
    // you see at the waterline tells your carrier from another).
    const grey = mat(0x8b95a1, { roughness: 0.6, metalness: 0.3 });
    const hullGrey = mat(0x5f6872, { roughness: 0.55, metalness: 0.25 });
    g.add(mesh(hullGeometry(46, 6.5, 3.6), hull));
    const upper = mesh(hullGeometry(46.15, 6.6, 1.4), hullGrey);
    upper.position.y = 1.9;
    g.add(upper);
    g.add(box(42, 1, 8, grey, -1, 2.9, 0)); // hangar sides under the overhang
    // Hangar and deck-lift openings along both sides.
    const dark = mat(0x1b1e22, { roughness: 0.9 });
    for (const [x, z] of [[2.2, -4.03], [7.4, -4.03], [-13.3, -4.03], [-16.8, 4.03], [-4, 4.03]]) g.add(box(3.6, 0.7, 0.06, dark, x, 2.85, z));
    g.add(carrierFlightDeck());
    // The island: hangar-level base, two decks, the navigation bridge with
    // its window band, flight control (Pri-Fly) above it, then the mast.
    const iz = CARRIER_ISLAND_Z;
    g.add(box(5.2, 1.6, 1.7, grey, -6.5, CARRIER_DECK_TOP + 0.8, iz));
    g.add(box(4.6, 1.2, 1.6, grey, -6.6, CARRIER_DECK_TOP + 2.2, iz));
    g.add(box(4, 0.7, 1.9, grey, -6.3, CARRIER_DECK_TOP + 3.15, iz));
    g.add(box(4.05, 0.3, 1.95, glass, -6.3, CARRIER_DECK_TOP + 3.2, iz));
    g.add(box(3, 0.6, 1.8, grey, -6.8, CARRIER_DECK_TOP + 3.8, iz));
    g.add(box(3.1, 0.25, 1.9, glass, -6.6, CARRIER_DECK_TOP + 3.85, iz));
    for (const dz of [-0.86, 0.86]) g.add(box(0.9, 0.7, 0.05, glass, -4.7, CARRIER_DECK_TOP + 2.2, iz + dz)); // flat radar panels
    g.add(cylinder(0.08, 0.12, 2.4, steel, -6.8, CARRIER_DECK_TOP + 5.3, iz, 6));
    g.add(box(0.15, 0.08, 1.6, steel, -6.8, CARRIER_DECK_TOP + 5.8, iz));
    g.add(box(0.1, 0.45, 1, steel, -6.8, CARRIER_DECK_TOP + 6.4, iz)); // radar antenna
    g.add(mesh(new THREE.SphereGeometry(0.28, 12, 8), white).translateX(-8.6).translateY(CARRIER_DECK_TOP + 4.4).translateZ(iz));
    // Close-in guns on the deck-edge sponsons.
    for (const [x, z] of [[-23.5, -4.4], [-22, 3.2], [21.5, 3.4], [19, -4.4]]) {
      g.add(cylinder(0.3, 0.35, 0.4, grey, x, CARRIER_DECK_TOP + 0.2, z, 10));
      g.add(mesh(new THREE.SphereGeometry(0.28, 10, 8), white).translateX(x).translateY(CARRIER_DECK_TOP + 0.6).translateZ(z));
    }
    // Jet blast deflectors raised behind the two bow catapults.
    for (const z of [-1.3, 1.3]) {
      const jbd = box(0.08, 0.6, 1.3, steel, 14.5, CARRIER_DECK_TOP + 0.25, z);
      jbd.rotation.z = 0.9;
      g.add(jbd);
    }
    airWing = carrierAirWing(glass);
    for (const part of airWing) g.add(part);
  } else if (category === "Hydrofoil") {
    // Slim planing hull with a low cabin, on two pairs of struts with
    // underwater wings (foils). At speed the whole ship rises on them.
    g.add(mesh(hullGeometry(36, 10, 6), hull));
    g.add(box(15, 4, 7.5, white, -1, 6.2, 0));
    g.add(box(15.4, 1.6, 7.9, glass, -1, 7, 0));
    g.add(box(8, 2.6, 6, white, -6, 9.4, 0));
    g.add(box(10, 1.2, 8.6, hull, -12, 4.6, 0));
    g.add(cylinder(0.35, 0.35, 5, steel, -4, 13, 0));
    for (const x of [11, -12]) {
      for (const z of [-4.2, 4.2]) g.add(box(1.2, 9, 0.9, steel, x, -3.5, z));
      g.add(box(3.4, 0.6, 13, steel, x, -8, 0)); // the wing itself
    }
  } else if (category === "Tug") {
    // Harbour tug: short and beamy, a thick black rubber fender all round
    // and a push pad on the bow, the wheelhouse well forward with windows
    // all round, twin exhausts, and the towing winch and hook on the open
    // after deck.
    const rubber = mat(0x1b1b1b, { roughness: 0.95 });
    g.add(mesh(hullGeometry(28, 11, 7), hull));
    const fender = mesh(hullGeometry(29.5, 12.4, 1.4), rubber);
    fender.position.y = 2.2;
    g.add(fender);
    g.add(box(1.4, 3.2, 6, rubber, 14.2, 3.4, 0));
    g.add(box(9, 3.4, 8, white, 3, 6.4, 0));
    g.add(box(6, 3, 8.6, white, 4, 9.6, 0));
    g.add(box(6.1, 1.3, 8.7, glass, 4, 10, 0));
    g.add(box(6.6, 0.4, 9.2, hull, 4, 11.3, 0));
    g.add(cylinder(0.2, 0.25, 5, steel, 4.5, 14, 0, 6));
    for (const z of [-2.4, 2.4]) {
      g.add(cylinder(0.55, 0.6, 5, hull, -1.2, 9, z, 10));
      g.add(cylinder(0.56, 0.56, 0.8, mat(0x111111), -1.2, 11.7, z, 10));
    }
    const drum = cylinder(1.3, 1.3, 4.6, steel, -5, 6, 0, 14);
    drum.rotation.x = Math.PI / 2;
    g.add(drum);
    g.add(box(0.8, 2.4, 0.8, steel, -10.5, 5.9, 0));
  } else if (category === "Icebreaker") {
    // Polar icebreaker: a broad hull with a dark ice belt at the waterline,
    // a tall white superstructure set well forward with the bridge and its
    // wings on top, a big funnel, and a helideck aft.
    g.add(mesh(hullGeometry(38, 11, 9), hull));
    const belt = mesh(hullGeometry(38.6, 11.6, 1.2), mat(0x4a1210, { roughness: 0.6, metalness: 0.2 }));
    belt.position.y = 0.4;
    g.add(belt);
    g.add(box(13, 6, 9.5, white, 3, 8.7, 0));
    g.add(box(10, 3, 8.5, white, 4, 13.2, 0));
    g.add(box(6, 2.4, 13, white, 6, 15.9, 0));
    g.add(box(6.1, 1.1, 13.1, glass, 6, 16.1, 0));
    g.add(cylinder(0.3, 0.35, 6, steel, 5, 20, 0, 6));
    g.add(box(4.5, 6, 5.5, hull, -5, 10.5, 0));
    g.add(box(4.6, 1.2, 5.6, mat(0x111111), -5, 13.6, 0));
    g.add(box(10, 0.4, 10.5, mat(0x3a4a3a, { roughness: 0.8 }), -12.5, 6.4, 0));
    const pad = mesh(new THREE.RingGeometry(2.8, 3.4, 24).rotateX(-Math.PI / 2), mat(0xf2d230));
    pad.position.set(-12.5, 6.65, 0);
    g.add(pad);
  } else if (category === "Tanker") {
    // Oil tanker: long low hull, red deck with the cargo pipelines and a
    // catwalk running fore and aft, the hose manifold midships with its
    // crane, and the accommodation and bridge right aft.
    const deck = mesh(hullGeometry(47, 12, 0.2), mat(0x7b2a22, { roughness: 0.8 }));
    deck.position.y = 4.1;
    g.add(mesh(hullGeometry(50, 13, 8), hull));
    g.add(deck);
    for (const z of [-1.8, -0.9, 0.9, 1.8]) {
      const pipe = cylinder(0.25, 0.25, 36, steel, 2, 5.8, z, 6);
      pipe.rotation.z = Math.PI / 2;
      g.add(pipe);
    }
    g.add(box(36, 0.3, 1.2, steel, 2, 7.4, 0));
    g.add(box(2, 1.4, 11.5, steel, 1, 6.1, 0));
    g.add(cylinder(0.4, 0.5, 5, mat(0xe0a21e), 1, 8, 3.8, 8));
    g.add(box(7, 10, 12, white, -19, 10.2, 0));
    g.add(box(7.1, 1.1, 12.1, glass, -19, 12.5, 0));
    g.add(box(5, 2, 14.5, white, -18.5, 16.2, 0));
    g.add(box(5.1, 1, 14.6, glass, -18.4, 16.4, 0));
    g.add(cylinder(0.25, 0.3, 5, steel, -19, 19.5, 0, 6));
    g.add(box(3, 7, 3.6, mat(0xb8322a, { roughness: 0.6 }), -23.3, 11, 0));
    g.add(box(3.1, 1.2, 3.7, mat(0x111111), -23.3, 14.8, 0));
  } else if (category === "GasTanker") {
    // Gas carrier: four big spherical cargo tanks standing half out of the
    // deck in their hull-coloured skirts, a pipe walkway over their tops,
    // and a tall accommodation block aft so the bridge sees over them.
    g.add(mesh(hullGeometry(50, 13, 8), hull));
    const tankMat = mat(0xf2f0ea, { roughness: 0.45, metalness: 0.1 });
    for (const x of [16.5, 7, -4, -13]) {
      const tank = mesh(new THREE.SphereGeometry(4.6, 24, 16), tankMat);
      tank.position.set(x, 6, 0);
      g.add(tank);
      g.add(cylinder(4.75, 4.75, 2.2, hull, x, 5.6, 0, 24));
    }
    g.add(box(38, 0.4, 1.2, steel, 1.5, 10.9, 0));
    g.add(box(1.6, 1.4, 11.5, steel, 1.5, 6, 0));
    g.add(box(6, 12, 12, white, -20, 11.2, 0));
    g.add(box(6.1, 1.1, 12.1, glass, -20, 14, 0));
    g.add(box(4.6, 2, 14.5, white, -19.6, 18.2, 0));
    g.add(box(4.7, 1, 14.6, glass, -19.5, 18.4, 0));
    g.add(cylinder(0.25, 0.3, 5, steel, -20, 21.5, 0, 6));
    g.add(box(3, 6, 3.6, hull, -23.8, 13, 0));
    g.add(box(3.1, 1.2, 3.7, mat(0x111111), -23.8, 16.4, 0));
  } else if (category === "Futuristic") {
    g.add(mesh(hullGeometry(40, 11, 6), hull));
    const canopy = mesh(new THREE.SphereGeometry(1, 24, 12), glass);
    canopy.scale.set(10, 3.2, 4.5);
    canopy.position.set(-1, 4, 0);
    g.add(canopy);
    const glow = mat(color, { emissive: color, emissiveIntensity: 3.5 });
    for (const z of [-5.6, 5.6]) g.add(box(30, 0.6, 0.4, glow, -2, 2.6, z));
    for (const z of [-3.5, 3.5]) {
      const fin = box(7, 6, 0.6, hull, -16, 6, z);
      fin.rotation.z = -0.4;
      g.add(fin);
    }
  } else {
    // Pirate galleon: dark wood, castle at the stern, two masts of dark sails.
    g.add(mesh(hullGeometry(40, 13, 9), darkWood));
    g.add(box(30, 1.2, 13.5, hull, -1, 3.4, 0)); // painted band so its colour still reads at a glance
    g.add(box(30, 0.8, 11, wood, 1, 4.8, 0));
    g.add(box(10, 6, 12, darkWood, -15, 8, 0));
    // Stern cabin windows; at night a single candle inside lights them.
    candle = mat(0x1c120a, { roughness: 0.3, emissive: 0xffa24a, emissiveIntensity: 0 });
    for (const z of [-3.2, 0, 3.2]) g.add(box(0.3, 2.2, 1.8, candle, -20.05, 8.6, z));
    for (const x of [-17.5, -12.5]) for (const z of [-6.05, 6.05]) g.add(box(1.8, 2, 0.3, candle, x, 8.6, z));
    const blackSail = mat(0x2a2522, { roughness: 0.95, side: THREE.DoubleSide });
    for (const [x, h] of [[7, 34], [-4, 30]]) {
      g.add(cylinder(0.7, 0.9, h, wood, x, h / 2 + 4, 0, 8));
      const sail = squareSail(15, 12, 2.6, blackSail);
      sail.position.set(x + 0.6, h * 0.62, 0);
      g.add(sail);
      const yard = cylinder(0.35, 0.35, 16, wood, x + 0.4, h * 0.62 + 6.4, 0, 6);
      yard.rotation.x = Math.PI / 2;
      g.add(yard);
    }
    const flag = mesh(new THREE.PlaneGeometry(6, 4), mat(0x0c0c0c, { side: THREE.DoubleSide }), false);
    flag.position.set(4, 39, 0);
    g.add(flag);
  }

  const mats = [];
  g.traverse((o) => {
    if (o.material && !mats.includes(o.material)) {
      o.material.userData.baseEmissive = o.material.emissive.clone();
      o.material.userData.baseColor = o.material.color.clone();
      mats.push(o.material);
    }
  });
  return { model: g, mats, candle, wheel, airWing };
}

// Each vessel's size on the sea: [hull length in model units, length drawn
// in world units]. Real lengths run from a 12 m yacht to a 333 m carrier (28
// times longer); that would make the small boats specks, so the scale is
// compressed, but the order stays true: sailing boat < catamaran < hydrofoil
// < pirate galleon < futuristic < warship < feeder container ship < cruise
// liner < aircraft carrier. Keep BUMP_SHAPE in game.js in step with these.
const SHIP_SIZE = {
  Sailing: [36, 26], // ~12 m yacht
  Catamaran: [38, 30], // ~15 m
  Hydrofoil: [38, 40], // ~30 m fast ferry
  Pirate: [42, 15], // ~45 m galleon, real size
  Futuristic: [42, 58],
  Assault: [44, 68], // ~155 m destroyer
  Cargo: [52, 76], // ~180 m feeder container ship
  Cruise: [CRUISE.len, CRUISE.len], // ~300 m liner, built at real size
  Carrier: [50, 109], // 333 m supercarrier (flight deck length), real size
  Tug: [31.5, 34], // ~30 m harbour tug
  Icebreaker: [40, 62], // ~120 m polar icebreaker
  Tanker: [52, 84], // ~250 m oil tanker
  GasTanker: [52, 86] // ~290 m gas carrier
};
function shipScale(kind) {
  const [hullLen, drawnLen] = SHIP_SIZE[kind] || SHIP_SIZE.Cruise;
  return drawnLen / hullLen;
}


// ---------------------------------------------------------------------------
// Bridge interior: what you see from the captain's eye (BRIDGE_EYE) when you are on the
// bridge: a textured console with radar / chart / engine screens, a joystick and throttle
// levers (modern ships steer by joystick, not wheel), window posts, chairs, a chart table,
// an overhead switch panel, carpet and ceiling tiles. Only the sailing boat has a wheel; the
// galleon has a whipstaff. The view starts inside (see bridgeBlend) and glides out to the
// plain window view when the player presses the navigation-screen button.
// Built in world units around the eye and shown only to the player on that bridge.
// ---------------------------------------------------------------------------
const OPEN_HELM = new Set(["Sailing", "Pirate"]);
const INTERIOR_SIZE = { Sailing: 0.8, Pirate: 0.9, Catamaran: 0.75, Hydrofoil: 0.8, Futuristic: 0.8, Tug: 0.8 };

function ibCanvas(w, h, draw, rx = 1, ry = 1) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function ibSpeckle(g, w, h, n, alpha) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = Math.random() < 0.5 ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha})`;
    g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}

let ibTex = null;
function bridgeTextures() {
  if (ibTex) return ibTex;
  ibTex = {
    carpet: ibCanvas(128, 128, (g, w, h) => {
      g.fillStyle = "#2e3943";
      g.fillRect(0, 0, w, h);
      ibSpeckle(g, w, h, 1800, 0.18);
      g.fillStyle = "rgba(255,255,255,0.05)";
      for (let y = 0; y < h; y += 8) g.fillRect(0, y, w, 1);
    }, 5, 5),
    ceiling: ibCanvas(128, 128, (g, w, h) => {
      g.fillStyle = "#d7dce0";
      g.fillRect(0, 0, w, h);
      ibSpeckle(g, w, h, 700, 0.08);
      g.fillStyle = "#aab1b7";
      g.fillRect(0, 0, w, 3);
      g.fillRect(0, 0, 3, h);
      g.fillStyle = "rgba(0,0,0,0.25)";
      for (let y = 16; y < h; y += 16) for (let x = 16; x < w; x += 16) g.fillRect(x, y, 2, 2);
    }, 6, 6),
    wall: ibCanvas(256, 128, (g, w, h) => {
      g.fillStyle = "#59636c";
      g.fillRect(0, 0, w, h);
      ibSpeckle(g, w, h, 900, 0.1);
      for (let x = 0; x < w; x += 64) {
        g.fillStyle = "rgba(0,0,0,0.35)";
        g.fillRect(x, 0, 2, h);
        g.fillStyle = "rgba(255,255,255,0.12)";
        g.fillRect(x + 2, 0, 1, h);
        for (const y of [10, h - 10]) {
          g.fillStyle = "rgba(255,255,255,0.3)";
          g.fillRect(x + 8, y, 3, 3);
        }
      }
      g.fillStyle = "rgba(0,0,0,0.25)";
      g.fillRect(0, h * 0.62, w, 3);
    }, 2, 1),
    metal: ibCanvas(256, 128, (g, w, h) => {
      g.fillStyle = "#2a3036";
      g.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y++) {
        g.fillStyle = `rgba(255,255,255,${Math.random() * 0.07})`;
        g.fillRect(0, y, w, 1);
      }
      ibSpeckle(g, w, h, 500, 0.12);
      for (let x = 0; x < w; x += 64) {
        g.fillStyle = "rgba(0,0,0,0.5)";
        g.fillRect(x, 0, 2, h);
        g.fillStyle = "rgba(255,255,255,0.15)";
        g.fillRect(x + 2, 0, 1, h);
      }
    }, 3, 1),
    frame: ibCanvas(64, 64, (g, w, h) => {
      g.fillStyle = "#1d2226";
      g.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y++) {
        g.fillStyle = `rgba(255,255,255,${Math.random() * 0.06})`;
        g.fillRect(0, y, w, 1);
      }
    }),
    wood: ibCanvas(128, 128, (g, w, h) => {
      g.fillStyle = "#7d5733";
      g.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y++) {
        g.fillStyle = `rgba(${Math.random() < 0.5 ? "40,20,5" : "200,150,90"},${0.05 + Math.random() * 0.12})`;
        g.fillRect(0, y, w, 1 + Math.random() * 2);
      }
    }, 2, 2),
    radar: ibCanvas(256, 256, (g, w, h) => {
      g.fillStyle = "#031a14";
      g.fillRect(0, 0, w, h);
      g.strokeStyle = "rgba(60,255,150,0.55)";
      g.lineWidth = 1.5;
      for (let r = 28; r <= 120; r += 30) {
        g.beginPath();
        g.arc(w / 2, h / 2, r, 0, Math.PI * 2);
        g.stroke();
      }
      g.beginPath();
      g.moveTo(w / 2, 6);
      g.lineTo(w / 2, h - 6);
      g.moveTo(6, h / 2);
      g.lineTo(w - 6, h / 2);
      g.stroke();
      g.fillStyle = "rgba(90,255,170,0.9)";
      for (let i = 0; i < 9; i++) {
        const a = Math.random() * 6.28;
        const r = 20 + Math.random() * 95;
        g.fillRect(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r, 4, 4);
      }
      g.fillStyle = "#ffffff";
      g.fillRect(w / 2 - 3, h / 2 - 3, 6, 6);
      g.font = "bold 11px monospace";
      g.fillStyle = "rgba(90,255,170,0.9)";
      g.fillText("RADAR  6 NM", 8, 16);
      g.fillText("HDG UP", 8, h - 8);
    }),
    chart: ibCanvas(256, 256, (g, w, h) => {
      g.fillStyle = "#12304a";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#c9b98a";
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(110, 0);
      g.bezierCurveTo(90, 50, 140, 90, 100, 150);
      g.bezierCurveTo(70, 190, 40, 200, 0, 220);
      g.fill();
      g.beginPath();
      g.ellipse(200, 190, 34, 22, 0.5, 0, 6.28);
      g.fill();
      g.strokeStyle = "rgba(255,255,255,0.25)";
      g.lineWidth = 1;
      for (let i = 0; i < w; i += 32) {
        g.beginPath();
        g.moveTo(i, 0);
        g.lineTo(i, h);
        g.moveTo(0, i);
        g.lineTo(w, i);
        g.stroke();
      }
      g.strokeStyle = "#ffd24a";
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(230, 250);
      g.lineTo(190, 130);
      g.lineTo(150, 60);
      g.stroke();
      g.fillStyle = "#fff";
      g.font = "bold 11px monospace";
      g.fillText("ECDIS  ROUTE 1", 8, h - 8);
    }),
    gauges: ibCanvas(256, 128, (g, w, h) => {
      g.fillStyle = "#07141c";
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 4; i++) {
        const x = 20 + i * 58;
        g.fillStyle = "rgba(255,255,255,0.15)";
        g.fillRect(x, 20, 26, 80);
        g.fillStyle = i === 3 ? "#ffb02a" : "#3be0c8";
        const v = 25 + Math.random() * 50;
        g.fillRect(x, 100 - v, 26, v);
      }
      g.fillStyle = "#cfe";
      g.font = "bold 11px monospace";
      g.fillText("ENG  RPM  FUEL  RDR", 12, 14);
    }),
    chartTable: ibCanvas(128, 128, (g, w, h) => {
      g.fillStyle = "#e8e0c4";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#9ec0cc";
      g.fillRect(0, 0, w * 0.55, h);
      g.strokeStyle = "rgba(60,40,20,0.5)";
      for (let i = 0; i < 6; i++) {
        g.beginPath();
        g.moveTo(0, 20 + i * 18);
        g.bezierCurveTo(40, 5 + i * 20, 70, 40, w, 30 + i * 14);
        g.stroke();
      }
    })
  };
  return ibTex;
}

// A sweeping radar beam: bright at the leading edge, fading behind it.
let ibSweepTex = null;
function radarSweepTexture() {
  if (ibSweepTex) return ibSweepTex;
  ibSweepTex = ibCanvas(128, 128, (g, w, h) => {
    for (let a = 0; a < 60; a++) {
      g.fillStyle = `rgba(80,255,160,${0.35 * (1 - a / 60) ** 2})`;
      g.beginPath();
      g.moveTo(w / 2, h / 2);
      g.arc(w / 2, h / 2, w / 2, -(a + 1) * 0.02 - Math.PI / 2, -a * 0.02 - Math.PI / 2);
      g.fill();
    }
  });
  return ibSweepTex;
}

// One set of materials per interior (each ship fades its own, so a split screen can show one
// player inside and the other outside).
// High graphics levels (Extreme, Ultra, High) get the realistic interior: surface relief,
// glass panes that reflect the sky, sun shadows falling through the windows, and small
// props. Lower levels keep the plain textured room.
const bridgeHigh = () => perf.level <= 2;

function bridgeMats() {
  const T = bridgeTextures();
  const sd = THREE.DoubleSide;
  const hi = bridgeHigh();
  const m = (map, extra = {}) => mat(0xffffff, { map, roughness: 0.75, side: sd, emissive: 0x1a2028, emissiveMap: map, emissiveIntensity: 0.45, ...(hi ? { bumpMap: map, bumpScale: 1.5, envMapIntensity: 1.2 } : {}), ...extra });
  const screen = (map) => mat(0xffffff, { map, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 1.1, roughness: 0.3, side: sd });
  return {
    wall: m(T.wall),
    console: m(T.metal, { roughness: 0.5, metalness: 0.3 }),
    frame: m(T.frame, { roughness: 0.6, metalness: 0.4 }),
    floor: m(T.carpet, { roughness: 0.95 }),
    ceiling: m(T.ceiling, { roughness: 0.9 }),
    wood: m(T.wood, { roughness: 0.6 }),
    chartTable: m(T.chartTable),
    light: mat(0xffffff, { emissive: 0xfff4dc, emissiveIntensity: 1.6, side: sd }),
    amber: mat(0x302000, { emissive: 0xffa21a, emissiveIntensity: 1.6 }),
    trim: mat(0xb9c0c6, { roughness: 0.35, metalness: 0.8 }),
    seat: mat(0x24282c, { roughness: 0.85 }),
    cushion: mat(0x4b5560, { roughness: 0.95, side: sd }),
    radar: screen(T.radar),
    chart: screen(T.chart),
    gauges: screen(T.gauges),
    sweep: new THREE.MeshBasicMaterial({ map: radarSweepTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: sd }),
    lamps: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0xaed4e8, transparent: true, opacity: 0.1, roughness: 0.04, metalness: 0, envMapIntensity: 1.8, side: sd, depthWrite: false, userData: { noDepth: true } }),
    red: mat(0xb3261e, { roughness: 0.4, metalness: 0.2 }),
    white: mat(0xf2f2ee, { roughness: 0.5 })
  };
}

// Redraws a bridge's wind instrument: speed, where it blows from, the trend, and the strongest gust so far.
function drawWindScreen(w) {
  const g = w.cv.getContext("2d");
  const W = w.cv.width;
  const H = w.cv.height;
  const kn = windKnots();
  const log = game.windLog || [];
  const gale = kn > 28;
  g.fillStyle = "#07141c";
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#8fd3e8";
  g.font = "bold 13px monospace";
  g.fillText("WIND", 10, 18);
  g.fillText(`FROM ${COMPASS_POINTS[Math.round(compassBearing(Math.atan2(-game.wind.y, -game.wind.x)) / 45) % 8]}`, W - 80, 18);
  g.fillStyle = gale ? "#ff5a4d" : "#e9fbff";
  g.font = "bold 40px monospace";
  g.fillText(kn.toFixed(0), 10, 62);
  g.font = "bold 16px monospace";
  g.fillText("kn", 76, 62);
  g.fillStyle = "#8fd3e8";
  g.font = "12px monospace";
  g.fillText(`MAX ${(game.windMax || 0).toFixed(0)} kn`, W - 100, 62);
  // trend
  const top = Math.max(20, game.windMax || 0);
  g.strokeStyle = "rgba(143,211,232,0.25)";
  g.strokeRect(10.5, 74.5, W - 21, 44);
  g.strokeStyle = gale ? "#ff5a4d" : "#6fe3c8";
  g.lineWidth = 2;
  g.beginPath();
  log.forEach((v, i) => {
    const x = 10 + ((W - 20) * i) / 89;
    const y = 118 - (v / top) * 42;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  });
  g.stroke();
  w.tex.needsUpdate = true;
}

function bridgeInterior(kind) {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.scale.setScalar(INTERIOR_SIZE[kind] || 1);
  g.add(inner);
  const M = bridgeMats();
  const ib = (w, h, d, m, x, y, z) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z);
    inner.add(b);
    return b;
  };
  const cyl = (rt, rb, h, m, x, y, z) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, 12), m);
    c.position.set(x, y, z);
    inner.add(c);
    return c;
  };
  let helm; // the part that follows the rudder
  if (kind === "Sailing") {
    helm = new THREE.Group();
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.05, 8, 24), M.wood);
    rim.rotation.y = Math.PI / 2;
    helm.add(rim);
    for (let i = 0; i < 4; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.0, 0.05), M.wood);
      spoke.rotation.x = (i * Math.PI) / 4;
      helm.add(spoke);
    }
    helm.position.set(2.1, -0.5, 0);
    helm.scale.setScalar(1.3);
    inner.add(helm);
    ib(0.3, 1.5, 0.3, M.wood, 2.1, -1.2, 0);
  } else if (kind === "Pirate") {
    // a whipstaff: a tall lever swung from side to side
    helm = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 2.6, 8), M.wood);
    pole.position.y = 1.2;
    helm.add(pole);
    helm.position.set(2.1, -1.7, 0);
    inner.add(helm);
    ib(0.5, 0.35, 0.5, M.wood, 2.1, -1.55, 0);
  }
  if (OPEN_HELM.has(kind)) {
    cyl(0.28, 0.34, 0.9, M.trim, 3.1, -1.3, 0); // binnacle
    ib(0.4, 0.06, 0.4, M.amber, 3.1, -0.82, 0); // compass glow
    ib(8, 0.12, 6, M.wood, -0.5, -1.8, 0); // deck
    for (const side of [-1, 1]) {
      ib(8, 0.08, 0.08, M.trim, -0.5, -0.9, side * 3.2);
      for (let x = -4; x <= 3; x += 1.75) ib(0.08, 0.9, 0.08, M.trim, x, -1.35, side * 3.2);
    }
    return { group: g, helm, mats: M, sweep: null, kind: kind === "Sailing" ? "wheel" : "staff", wind: null };
  }
  // ---- enclosed bridge ----
  ib(9.6, 0.12, 10.6, M.floor, -0.3, -1.75, 0);
  ib(9.6, 0.12, 10.6, M.ceiling, -0.3, 1.65, 0);
  for (const x of [-3, 0, 2.6]) ib(0.35, 0.05, 7, M.light, x, 1.57, 0);
  // front console: body, lip along the window sill, top
  ib(1.7, 1.25, 10.2, M.console, 3.2, -1.1, 0);
  ib(0.25, 0.1, 10.2, M.trim, 2.4, -0.45, 0);
  ib(1.5, 0.06, 10.0, M.frame, 3.3, -0.47, 0);
  // Navigation and system displays lie flat on the console, top edge away from the captain, so
  // the windows stay clear. The radar in the middle has a sweeping beam.
  // The wind instrument: the logged wind speed (game.js windLog), its direction and the last minute and a half as a graph.
  const windCv = document.createElement("canvas");
  windCv.width = 256;
  windCv.height = 128;
  const windTex = new THREE.CanvasTexture(windCv);
  windTex.colorSpace = THREE.SRGBColorSpace;
  M.wind = mat(0xffffff, { map: windTex, emissive: 0xffffff, emissiveMap: windTex, emissiveIntensity: 1.1, roughness: 0.3, side: THREE.DoubleSide });
  const wind = { cv: windCv, tex: windTex };
  const screens = [[0, M.radar], [-0.75, M.chart], [0.75, M.wind], [-1.5, M.gauges], [-2.3, M.chart], [2.3, M.chart], [3.1, M.gauges], [-3.1, M.gauges], [3.9, M.chart], [-3.9, M.chart]];
  const flatGeo = (w, d) => new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).rotateY(-Math.PI / 2);
  for (const [z, map] of screens) {
    ib(0.56, 0.03, 0.68, M.frame, 3.25, -0.43, z);
    const p = new THREE.Mesh(flatGeo(0.58, 0.5), map);
    p.position.set(3.25, -0.41, z);
    inner.add(p);
  }
  const sweep = new THREE.Mesh(flatGeo(0.5, 0.5), M.sweep);
  sweep.position.set(3.25, -0.4, 0);
  inner.add(sweep);
  // rows of small lit buttons on the console top
  const palette = [0x3be07a, 0xffb02a, 0xe0453b, 0x4aa3ff, 0xffffff];
  const lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.04, 0.12), M.lamps, 90);
  const mm = new THREE.Matrix4();
  for (let i = 0; i < 90; i++) {
    mm.makeTranslation(2.55 + (i % 3) * 0.16, -0.43, -4.8 + Math.floor(i / 3) * 0.32);
    lamps.setMatrixAt(i, mm);
    lamps.setColorAt(i, new THREE.Color(palette[(i * 7) % palette.length]).multiplyScalar(0.8));
  }
  inner.add(lamps);
  // throttle levers on the left, and a joystick on the right (modern ships have no wheel)
  for (const z of [-1.9, -1.55]) {
    ib(0.5, 0.05, 0.14, M.trim, 2.7, -0.42, z);
    ib(0.12, 0.5, 0.1, M.trim, 2.65, -0.2, z).rotation.z = 0.3;
    ib(0.14, 0.14, 0.14, M.amber, 2.57, 0.03, z);
  }
  helm = new THREE.Group();
  helm.position.set(2.55, -0.4, 1.8);
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.7, 10), M.frame);
  stick.position.y = 0.35;
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), M.seat);
  knob.position.y = 0.78;
  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.08), M.amber);
  trigger.position.set(-0.1, 0.7, 0);
  helm.add(stick, knob, trigger);
  inner.add(helm);
  cyl(0.28, 0.32, 0.12, M.trim, 2.55, -0.42, 1.8); // joystick base
  // overhead switch panel
  ib(1.6, 0.14, 6.5, M.console, 1.2, 1.5, 0);
  const sw = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.05, 0.1), M.lamps, 60);
  for (let i = 0; i < 60; i++) {
    mm.makeTranslation(0.85 + (i % 3) * 0.25, 1.42, -3 + Math.floor(i / 3) * 0.3);
    sw.setMatrixAt(i, mm);
    sw.setColorAt(i, new THREE.Color(palette[(i * 3) % palette.length]).multiplyScalar(0.7));
  }
  inner.add(sw);
  // window posts: front and both sides
  ib(0.3, 0.55, 10.2, M.frame, 4, 1.35, 0);
  for (const z of [-4.9, -3.2, -1.1, 1.1, 3.2, 4.9]) ib(0.3, 2.2, 0.3, M.frame, 4, 0.6, z);
  for (const side of [-1, 1]) {
    ib(9.2, 1.25, 0.2, M.wall, -0.3, -1.1, side * 5.1);
    ib(9.2, 0.55, 0.2, M.frame, -0.3, 1.35, side * 5.1);
    for (const x of [-4.5, -2.8, -0.6, 1.6, 3.9]) ib(0.3, 2.2, 0.3, M.frame, x, 0.6, side * 5.1);
    ib(9.2, 0.06, 0.4, M.trim, -0.3, -0.48, side * 5.0); // sill
  }
  // back wall with a door, a status screen, and a chart table with its lamp
  ib(0.2, 3.4, 10.6, M.wall, -5, -0.05, 0);
  ib(0.08, 2.3, 1.5, M.frame, -4.88, -0.55, 2.8);
  ib(0.06, 0.1, 0.25, M.trim, -4.82, -0.5, 2.2); // door handle
  const status = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.8), M.gauges);
  status.position.set(-4.88, 0.5, -2.2);
  status.rotation.y = Math.PI / 2;
  inner.add(status);
  ib(1.3, 0.1, 2.4, M.chartTable, -3.8, -0.9, -3.3);
  for (const dz of [-1, 1]) for (const dx of [-0.5, 0.5]) ib(0.1, 0.85, 0.1, M.trim, -3.8 + dx, -1.35, -3.3 + dz);
  ib(0.5, 0.05, 0.5, M.light, -3.8, 1.5, -3.3);
  // two captain's chairs
  for (const z of [-1.4, 1.4]) {
    cyl(0.1, 0.16, 0.9, M.trim, -2.6, -1.3, z);
    ib(0.9, 0.16, 0.9, M.seat, -2.6, -0.8, z);
    ib(0.14, 1.0, 0.9, M.seat, -3.0, -0.3, z);
    ib(0.8, 0.12, 0.8, M.cushion, -2.55, -0.66, z); // seat cushion
    ib(0.1, 0.8, 0.8, M.cushion, -2.9, -0.28, z); // back cushion
    for (const s of [-1, 1]) ib(0.6, 0.08, 0.12, M.seat, -2.6, -0.5, z + s * 0.5);
  }
  if (bridgeHigh()) {
    // glass in the window openings (it mirrors the sky), and small props that make it a workplace
    ib(0.02, 2.2, 10.2, M.glass, 4.06, 0.6, 0);
    for (const side of [-1, 1]) ib(9.2, 2.2, 0.02, M.glass, -0.3, 0.6, side * 5.18);
    cyl(0.12, 0.1, 0.22, M.white, 2.6, -0.34, -3.3); // a mug
    ib(0.5, 0.06, 0.38, M.red, -3.7, -0.82, -3.0); // log book on the chart table
    ib(0.36, 0.1, 0.22, M.frame, 2.62, -0.4, 3.4); // binoculars
    cyl(0.08, 0.08, 0.2, M.trim, 2.5, -0.35, 3.4);
    cyl(0.14, 0.14, 0.8, M.red, -4.78, -0.9, -4.4); // fire extinguisher
    ib(0.06, 0.06, 0.3, M.trim, -4.84, -0.55, -4.4);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.14, 8, 20), M.red);
    ring.position.set(-2, 0.2, 4.95);
    inner.add(ring);
    const clock = cyl(0.3, 0.3, 0.05, M.white, -4.85, 0.9, 0);
    clock.rotation.z = Math.PI / 2;
    for (const z of [-2, 2]) ib(0.7, 0.04, 0.7, M.frame, 1.0, 1.6, z * 1.2); // ceiling vents
    for (const z of [-3.4, 3.4]) ib(0.25, 0.4, 0.25, M.frame, -2, 1.45, z); // speakers
    // (No sun shadows inside: on a rolling ship the shadow map shimmered and made the room jitter.)
  }
  return { group: g, helm, mats: M, sweep, kind: "stick", wind };
}

// How far you are from the bridge's navigation screen, per player: 0 = inside the bridge
// (the room is shown, the camera stands back a little), 1 = at the window view, as before.
// It glides (see updateBridgeBlend) when game.js bridgeFocus is switched with the button.
const bridgeBlend = { p1: 0, p2: 0 };
const BRIDGE_BLEND_TIME = 1.6; // seconds for the glide
const BRIDGE_ROOF_CAM = [0.5, 3.2]; // the camera above the top of the bridge (world units from the eye: forward, up)
const BRIDGE_STAND_BACK = [1.3, 0.25]; // inside view: camera offset from the eye (world units, x forward, y up): a standing captain's eye height, near the windows

function bridgeSlot(ship) {
  return ship === game.player2 ? "p2" : "p1";
}

function updateBridgeBlend(ship, dt) {
  const slot = bridgeSlot(ship);
  const cur = bridgeBlend[slot];
  // Only the button (bridgeFocus) moves the camera in or out; turning the view never does.
  const want = bridgeFocus[slot] ? 1 : 0;
  bridgeBlend[slot] = cur < want ? Math.min(want, cur + dt / BRIDGE_BLEND_TIME) : Math.max(want, cur - dt / BRIDGE_BLEND_TIME);
}

function bridgeEase(ship) {
  return smoothstep(0, 1, bridgeBlend[bridgeSlot(ship)]);
}

// Interior fades out as the view glides to the window view.
function setInteriorFade(o, fade) {
  o.interior.visible = fade > 0.01;
  if (!o.interior.visible || o.interiorFade === fade) return;
  o.interiorFade = fade;
  for (const m of Object.values(o.interiorMats)) {
    const base = m.userData.baseOpacity ?? (m.userData.baseOpacity = m.opacity);
    m.transparent = fade < 0.999 || base < 1 || m.blending === THREE.AdditiveBlending;
    m.opacity = base * fade;
    m.depthWrite = m.blending === THREE.AdditiveBlending || m.userData.noDepth ? false : fade > 0.5;
  }
}

function createShip(ship) {
  const root = new THREE.Group();
  const tilt = new THREE.Group();
  const { model, mats, candle, wheel, airWing } = buildShipModel(ship);
  model.scale.setScalar(shipScale(ship.type === "pirate" ? "Pirate" : ship.category || "Cruise"));
  tilt.add(model);
  root.add(tilt);
  // Hull length and beam, for feeling the waves under the ship (a long hull
  // bridges short waves; only long swells lift and tip it).
  root.updateMatrixWorld(true);
  const hullBox = new THREE.Box3().setFromObject(model);
  const o = {
    top: hullBox.max.y, // tallest point (masts, funnel): name labels sit above it
    halfLen: (hullBox.max.x - hullBox.min.x) * 0.4,
    halfBeam: (hullBox.max.z - hullBox.min.z) * 0.45,
    root,
    tilt,
    model,
    mats,
    candle,
    wheel,
    airWing,
    sortie: null, // the carrier's patrol jet (updateSortieJet)
    flicker: 0.5,
    lift: 0,
    color: ship.displayColor,
    category: ship.category,
    lastAngle: ship.angle,
    yaw: ship.angle,
    roll: 0,
    rollV: 0,
    pitch: 0,
    pitchV: 0,
    heave: 0,
    heaveV: 0,
    seaYaw: 0,
    seaYawV: 0,
    swayX: 0,
    swayZ: 0,
    capsize: 0,
    sink: 0,
    seed: Math.random() * 10
  };
  o.navLights = buildNavLights(o, ship.type === "pirate" ? "Pirate" : ship.category);
  // Where a tow rope is made fast (model space): the tug's towing hook, the
  // bow of any other ship.
  const s = o.model.scale.x;
  const bowY = shipSurfaceY(o, hullBox.max.x * 0.85, 0) ?? 5;
  o.ropeAt = TOW_HOOK[o.category] ? new THREE.Vector3(...TOW_HOOK[o.category]) : new THREE.Vector3((hullBox.max.x * 0.92) / s, (bowY + 1) / s, 0);
  // The bridge interior (added last, so it does not change the ship's measured size) sits at the captain's eye, in world-sized units.
  const bridgeKind = ship.type === "pirate" ? "Pirate" : ship.category || "Cruise";
  const interior = bridgeInterior(bridgeKind);
  const [ex, ey, ez] = BRIDGE_EYE[bridgeKind] || BRIDGE_EYE.Cruise;
  interior.group.position.set(ex, ey, ez);
  interior.group.scale.setScalar(1 / model.scale.x);
  interior.group.visible = false;
  model.add(interior.group);
  o.interior = interior.group;
  o.interiorHelm = interior.helm;
  o.interiorKind = interior.kind;
  o.interiorMats = interior.mats;
  o.interiorSweep = interior.sweep;
  o.interiorWind = interior.wind;
  o.windDrawn = -9;
  o.interiorFade = -1;
  // The ship's own outside parts that sit inside the bridge room (window glass, wheelhouse walls,
  // rails...) would hang in front of the camera, so they are hidden while you are inside.
  root.updateMatrixWorld(true);
  const sz = INTERIOR_SIZE[bridgeKind] || 1;
  const room = new THREE.Box3();
  for (const cx of [-5.2, 4.2]) for (const cy of [-1.9, 1.7]) for (const cz of [-5.3, 5.3]) {
    room.expandByPoint(interior.group.localToWorld(new THREE.Vector3(cx * sz, cy * sz, cz * sz)));
  }
  room.expandByScalar(1);
  const part = new THREE.Box3();
  const mid = new THREE.Vector3();
  const dim = new THREE.Vector3();
  o.interiorClash = [];
  model.traverse((c) => {
    if (!c.isMesh) return;
    for (let up = c; up; up = up.parent) if (up === interior.group) return;
    part.setFromObject(c);
    part.getCenter(mid);
    part.getSize(dim);
    if (room.containsPoint(mid) && Math.max(dim.x, dim.y, dim.z) < 14) o.interiorClash.push(c);
  });
  o.clashHidden = false;
  return o;
}

// The tug's towing hook and the tankers' hose manifolds (model units; the
// manifold is on both sides, the hose takes the one facing the quay).
const TOW_HOOK = { Tug: [-10.5, 7, 0] };
const MANIFOLD = { Tanker: [1, 6.6, 7.2], GasTanker: [1.5, 6.5, 7.2] };

// Navigation lights, shown at night: red to port, green to starboard, a
// white masthead light forward and a white stern light. Glowing sprites (no
// real lights, so the light count, and the shaders, never change).
const MAST_X = { Sailing: 3, Catamaran: 3, Pirate: 7 };

function navLight(group, color, x, y, z) {
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowStar, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  halo.material.color.set(color).multiplyScalar(0.5);
  halo.scale.setScalar(10);
  const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowStar, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  core.material.color.set(color).multiplyScalar(1.3);
  core.scale.setScalar(2.4);
  halo.position.set(x, y, z);
  core.position.set(x, y, z);
  group.add(halo, core);
  return [halo, core];
}

function buildNavLights(o, category) {
  o.root.updateMatrixWorld(true);
  const box3 = new THREE.Box3().setFromObject(o.model);
  const s = o.model.scale.x;
  const deck = (x, z) => (shipSurfaceY(o, x, z) ?? box3.max.y * 0.4) + 1.6;
  const g = new THREE.Group();
  const sideX = box3.max.x * 0.15;
  navLight(g, 0xff2a1a, sideX, deck(sideX, box3.min.z * 0.6), box3.min.z * 0.98);
  navLight(g, 0x2aff5a, sideX, deck(sideX, box3.max.z * 0.6), box3.max.z * 0.98);
  navLight(g, 0xffffff, box3.min.x * 0.96, deck(box3.min.x * 0.9, 0), 0);
  const masted = MAST_X[category] !== undefined;
  const mastX = masted ? MAST_X[category] * s : box3.max.x * 0.25;
  const mastY = masted ? box3.max.y + 0.8 : deck(mastX, 0) + 4;
  g.userData.mast = navLight(g, 0xfff4e0, mastX, mastY, 0);
  // Measured in ship (root) space; the model carries the hydrofoil lift, so
  // the lights go inside the model, undoing its scale.
  g.scale.setScalar(1 / s);
  g.position.y = -o.model.position.y / s;
  g.visible = false;
  o.model.add(g);
  return g;
}

// One warm light shared by the pirate's candle (only one pirate sails at a
// time); it never changes the scene's light count.
const candleLight = new THREE.PointLight(0xff9a3c, 0, 110, 1.4);
scene.add(candleLight);
const CANDLE_SPOT = new THREE.Vector3(-13, 11, 0);

const flashColor = new THREE.Color(1, 0.12, 0.08);
const charColor = new THREE.Color(0x0b0807);
const fireGlowColor = new THREE.Color(1, 0.38, 0.08);

// How each hull moves in a seaway. Every motion is a mass on a spring with
// damping: the waves push the hull towards lying flat on the water, the
// hull's inertia makes it lag, overshoot and keep swinging, and the damping
// (bilge keels, hull shape, stabiliser fins) settles it. Each motion has its
// own natural period (seconds) and damping (share of critical):
// - roll: big ships roll slowly; seas whose rhythm matches the roll period
//   build it up (resonance), worst with the sea on the beam. The cruise liner
//   has fin stabilisers (heavily damped); the catamaran is very stiff (two
//   hulls far apart) so it rolls quick and small.
// - pitch, heave: shorter than the waves, so the hull mostly rides them.
// - yaw: seas from the quarter shove the stern round (the bow wanders).
// windHeel: the steady lean (radians) in a 20 kn wind on the beam; sails
// catch far more wind than a hull and superstructure.
const SHIP_MOTION = {
  Cruise: { roll: [13, 0.35], pitch: [4, 0.45], heave: [3, 0.5], yaw: [8, 0.6], windHeel: 0.02 },
  Cargo: { roll: [11, 0.2], pitch: [4, 0.45], heave: [3, 0.5], yaw: [8, 0.6], windHeel: 0.02 },
  Carrier: { roll: [15, 0.2], pitch: [5, 0.45], heave: [3.5, 0.5], yaw: [10, 0.6], windHeel: 0.03 },
  Assault: { roll: [9, 0.2], pitch: [3.5, 0.45], heave: [3, 0.5], yaw: [7, 0.6], windHeel: 0.015 },
  Sailing: { roll: [4, 0.2], pitch: [2.5, 0.4], heave: [2.5, 0.45], yaw: [4, 0.5], windHeel: 0.26 },
  Catamaran: { roll: [2.5, 0.5], pitch: [2.5, 0.4], heave: [2.5, 0.45], yaw: [4, 0.6], windHeel: 0.04 },
  Hydrofoil: { roll: [4, 0.3], pitch: [3, 0.45], heave: [2.5, 0.5], yaw: [5, 0.6], windHeel: 0.01 },
  Futuristic: { roll: [5, 0.3], pitch: [3, 0.45], heave: [2.5, 0.5], yaw: [5, 0.6], windHeel: 0.01 },
  Pirate: { roll: [7, 0.15], pitch: [3.5, 0.4], heave: [3, 0.45], yaw: [6, 0.5], windHeel: 0.18 },
  Tug: { roll: [5, 0.25], pitch: [2.8, 0.4], heave: [2.6, 0.45], yaw: [4.5, 0.55], windHeel: 0.03 },
  // Round-bottomed so it rides up on the ice: rolls a lot in open water.
  Icebreaker: { roll: [8, 0.15], pitch: [3.5, 0.45], heave: [3, 0.5], yaw: [7, 0.6], windHeel: 0.02 },
  Tanker: { roll: [12, 0.25], pitch: [4.5, 0.5], heave: [3.2, 0.55], yaw: [9, 0.6], windHeel: 0.01 },
  GasTanker: { roll: [12, 0.25], pitch: [4.5, 0.5], heave: [3.2, 0.55], yaw: [9, 0.6], windHeel: 0.025 }
};
const MAX_SEA_ROLL = 0.6; // about 35 degrees: a knockdown, the most the hull shows
const SEA_YAW_GAIN = 0.6; // yaw from the bow and stern being pushed sideways differently
const MAX_SEA_YAW = 0.15;
// Water at the surface moves in circles as a wave passes, carrying a floating
// hull to and fro (sway and surge). For a wave of number k the reach is
// slope / k; this is 1 / k for the main swell.
const SEA_ORBIT = 28;
const MAX_SEA_SWAY = 6;
const fwdSlope = { gx: 0, gz: 0 };
const aftSlope = { gx: 0, gz: 0 };
const midSlope = { gx: 0, gz: 0 };

// One step of a damped spring: o[key] is pulled towards `target`.
function springStep(o, key, target, [period, damping], dt) {
  const w = (Math.PI * 2) / period;
  const v = `${key}V`;
  o[v] += (w * w * (target - o[key]) - 2 * damping * w * o[v]) * dt;
  o[key] += o[v] * dt;
}

// The helm: hard over is one and a quarter turns of the wheel. Seen from
// behind the wheel, steering to starboard turns it clockwise.
const WHEEL_HARD_OVER = Math.PI * 2.5;

function updateShip(ship, o, dt) {
  const t = clock.t;
  toWorld(ship.x, ship.y, 0, o.root.position);
  // Computer-controlled ships steer in short taps (turn a few frames, then
  // straight); drawn as-is, that wags the hull left and right when seen from
  // behind. Their drawn heading follows the real one smoothly instead (looks
  // only; their course is unchanged). Your own ship is drawn as steered.
  if (ship.isHuman) o.yaw = ship.angle;
  else o.yaw += normalizeAngle(ship.angle - o.yaw) * (1 - Math.exp(-dt * 6));
  o.root.rotation.y = -o.yaw;

  // Heel outward in turns, scaled by speed.
  const turnRate = dt > 0 ? normalizeAngle(o.yaw - o.lastAngle) / dt : 0;
  o.lastAngle = o.yaw;
  const speedFactor = clamp(Math.abs(ship.speed || 0) / 200, 0, 1);
  const turnHeel = clamp(turnRate * 0.12 * speedFactor, -0.22, 0.22);
  o.capsize += ((ship.capsized ? 1 : 0) - o.capsize) * Math.min(1, dt * 1.6);
  // Sinking: once she is over on her side the wreck floods and goes down
  // stern first until the whole hull is under water (a few seconds).
  // Back afloat at once when the ship is restored (next level).
  o.sink += ((o.capsize > 0.9 ? 1 : 0) - o.sink) * Math.min(1, dt * (ship.capsized ? 0.35 : 3));

  // Hydrofoil: the hull rises clear of the water on its foils at speed and
  // the nose lifts a little; foil-borne it rides steadier on the swell.
  if (o.category === "Hydrofoil") {
    o.lift += ((ship.foilLift || 0) - o.lift) * Math.min(1, dt * 2.5);
    o.model.position.y = o.lift * 9;
    o.model.rotation.z = o.lift * 0.04 * (1 - o.lift * 0.5);
    updateFoilSpray(ship, o, dt);
  }

  // Ride the waves. The water under bow, stern and both sides gives the
  // wave's lift and tilt across this hull's length and beam; the hull follows
  // as a damped spring (SHIP_MOTION), so it lags, overshoots and swings like
  // a real hull. Moving through the waves changes how often they arrive.
  const motion = SHIP_MOTION[ship.type === "pirate" ? "Pirate" : o.category] || SHIP_MOTION.Cruise;
  const step = Math.min(dt, 0.05); // keeps the springs stable after a stall
  const p = o.root.position;
  const fx = Math.cos(o.yaw);
  const fz = Math.sin(o.yaw);
  const L = o.halfLen;
  const B = o.halfBeam;
  const bow = seaHeight(p.x + fx * L, p.z + fz * L, fwdSlope);
  const stern = seaHeight(p.x - fx * L, p.z - fz * L, aftSlope);
  const port = seaHeight(p.x - fz * B, p.z + fx * B); // local +Z side
  const starboard = seaHeight(p.x + fz * B, p.z - fx * B);
  const mid = seaHeight(p.x, p.z, midSlope);
  const steady = 1 - 0.7 * o.lift; // foil-borne: the foils ride under the waves

  // Wind heel: wind on the beam leans the ship away from it, growing with
  // the square of the wind speed (wind pressure).
  const windFrom = Math.atan2(-game.wind.y, -game.wind.x);
  const windKn = Math.hypot(game.wind.x, game.wind.y) * WIND_KNOTS_PER_UNIT;
  const windHeel = motion.windHeel * Math.min((windKn / 20) ** 2, 2.5) * Math.sin(normalizeAngle(windFrom - ship.angle));

  const waveRoll = clamp(-Math.atan2(port - starboard, B * 2), -0.5, 0.5) * steady;
  const wavePitch = clamp(Math.atan2(bow - stern, L * 2), -0.5, 0.5) * steady;
  springStep(o, "roll", waveRoll + windHeel + turnHeel, motion.roll, step);
  springStep(o, "pitch", wavePitch, motion.pitch, step);
  springStep(o, "heave", (bow + stern + port + starboard + mid) / 5, motion.heave, step);
  o.roll = clamp(o.roll, -MAX_SEA_ROLL, MAX_SEA_ROLL);

  // Yaw: the sea pushing the bow and stern sideways by different amounts
  // swings the heading a few degrees (worst with the sea on the quarter).
  // Looks only: your course and controls are unchanged.
  const sideBow = -fz * fwdSlope.gx + fx * fwdSlope.gz;
  const sideStern = -fz * aftSlope.gx + fx * aftSlope.gz;
  springStep(o, "seaYaw", clamp((sideBow - sideStern) * SEA_YAW_GAIN * steady, -MAX_SEA_YAW, MAX_SEA_YAW), motion.yaw, step);
  o.root.rotation.y = -(o.yaw + o.seaYaw);

  // Sway and surge: the wave's orbit carries the hull to and fro; a hull
  // with a slower heave period lags further behind the water.
  const carry = 1 - Math.exp(-step * ((Math.PI * 2) / motion.heave[0]));
  o.swayX += (clamp(midSlope.gx * SEA_ORBIT * steady, -MAX_SEA_SWAY, MAX_SEA_SWAY) - o.swayX) * carry;
  o.swayZ += (clamp(midSlope.gz * SEA_ORBIT * steady, -MAX_SEA_SWAY, MAX_SEA_SWAY) - o.swayZ) * carry;
  p.x += o.swayX;
  p.z += o.swayZ;
  // Going down in a whirlpool's throat.
  p.y = o.heave - (ship.whirlSink || 0) * 14;

  o.tilt.rotation.x = o.roll + o.capsize * 1.9;
  o.tilt.rotation.z = o.pitch + o.sink * 0.25; // bow lifts as the stern goes down
  o.tilt.position.y = -o.capsize * 5 - o.sink * (o.top + 6);

  // The sailing boat's wheel follows the rudder (game.js helmStep).
  if (o.wheel) o.wheel.rotation.z = (ship.helm ? ship.helm.rudder : 0) * WHEEL_HARD_OVER;

  updateShipFire(ship, o, dt);

  o.navLights.visible = night.on && o.capsize < 0.4;
  // Standing on your own bridge the masthead light sits right in front of
  // your eyes and its glow fills the view, so it is hidden there.
  const onOwnBridge = game.settings.cameraView === "bridge" && cameraFocus().inWorld &&
    (ship === game.player1 || (mode === "local" && ship === game.player2));
  for (const sprite of o.navLights.userData.mast) sprite.visible = !onOwnBridge;
  const fadeNow = onOwnBridge && !ship.capsized ? 1 - bridgeEase(ship) : 0;
  setInteriorFade(o, fadeNow);
  // While you are inside, the bridge's own outside parts (window glass, wheelhouse walls) are hidden so they don't
  // hang in front of the lens; from the camera above the bridge they are shown again.
  const hideClash = fadeNow > 0.5;
  if (o.clashHidden !== hideClash) {
    o.clashHidden = hideClash;
    for (const c of o.interiorClash) c.visible = !o.clashHidden;
  }
  if (o.interior.visible) {
    const rudder = ship.helm ? ship.helm.rudder : 0;
    // wheel (sailing boat) turns; the whipstaff and the joystick lean with the rudder
    if (o.interiorKind === "wheel") o.interiorHelm.rotation.x = rudder * WHEEL_HARD_OVER;
    else o.interiorHelm.rotation.x = -rudder * 0.5;
    if (o.interiorSweep) o.interiorSweep.rotation.y = -t * 1.6;
    if (o.interiorWind && t - o.windDrawn > 0.25) {
      o.windDrawn = t;
      drawWindScreen(o.interiorWind);
    }
  }
  if (o.candle) {
    // A candle: a slow waver plus quick little licks of the flame.
    o.flicker += (Math.random() - o.flicker) * Math.min(1, dt * 14);
    const f = 0.72 + 0.12 * Math.sin(t * 7.3 + o.seed) + 0.08 * Math.sin(t * 19.1 + o.seed * 3) + 0.22 * (o.flicker - 0.5);
    const lit = night.on && !ship.capsized;
    o.candle.emissiveIntensity = lit ? 3.2 * f : 0;
    if (lit && candleLight.intensity === 0) {
      o.model.localToWorld(candleLight.position.copy(CANDLE_SPOT));
      candleLight.intensity = 60 * f;
    }
  }

  const flash = clamp((ship.hitFlash || 0) * 5, 0, 1);
  // Burning: the hull chars black, and the fire throws a flickering orange
  // glow on it.
  const burn = ship.burn || 0;
  const glow = ship.fire ? (0.05 + 0.035 * ship.fire.intensity) * (0.7 + 0.3 * Math.sin(t * 17 + o.seed)) : 0;
  for (const m of o.mats) {
    m.color.copy(m.userData.baseColor).lerp(charColor, burn * 0.95);
    m.emissive.copy(m.userData.baseEmissive).lerp(fireGlowColor, glow).lerp(flashColor, flash);
  }
}

// A burning ship. Each flame is an animated fire shader (rising, wavering
// noise shaped into a tongue, white-yellow core to orange and red edges,
// glowing additively) on two crossed upright planes, so it looks right from
// any camera, including both halves of the split screen. Flames are sized to
// the deck and more of them light as the fire spreads; thick black smoke and
// embers rise and drift downwind.
const FIRE_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FIRE_FRAGMENT = `
uniform float time;
uniform float seed;
uniform float strength;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}
void main() {
  vec2 uv = vUv;
  float t = time * 1.8 + seed * 7.0;
  // Turbulence rising through the flame.
  float n = fbm(vec2(uv.x * 3.2 + seed * 3.0, uv.y * 2.6 - t));
  float n2 = fbm(vec2(uv.x * 6.0 - seed, uv.y * 5.0 - t * 1.7));
  // Tongue shape: wide at the base, licking to a point, bent by the noise.
  float sway = (n - 0.5) * 0.4 * uv.y;
  float halfWidth = mix(0.48, 0.03, pow(uv.y, 0.9));
  float dx = abs(uv.x - 0.5 + sway);
  float body = 1.0 - smoothstep(halfWidth * 0.2, halfWidth, dx);
  float top = 1.0 - smoothstep(0.45, 1.0, uv.y + (n2 - 0.5) * 0.5);
  float base = smoothstep(0.0, 0.08, uv.y);
  float f = clamp(body * top * base * (0.85 + n2 * 0.5), 0.0, 1.0) * strength;
  // Hot core low in the flame, cooling to orange and dark red at the edges
  // and tips. Drawn as solid colour (not added light) so it reads against a
  // bright sea and sky.
  float core = f * (1.0 - uv.y * 0.6);
  vec3 red = vec3(0.6, 0.06, 0.01);
  vec3 orange = vec3(1.0, 0.38, 0.03);
  vec3 yellow = vec3(1.0, 0.82, 0.3);
  vec3 col = mix(red, orange, smoothstep(0.1, 0.45, core));
  col = mix(col, yellow, smoothstep(0.5, 0.85, core));
  // Soft, flickering edges so the flame melts into the air around it.
  gl_FragColor = vec4(col * 1.25, smoothstep(0.0, 0.7, f) * 0.95);
}`;

const FIRE_FLAMES = 14;
const FIRE_SMOKE = 14;
const FIRE_EMBERS = 12;
const flameGeo = shared(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0));

function makeFlame() {
  const material = new THREE.ShaderMaterial({
    vertexShader: FIRE_VERTEX,
    fragmentShader: FIRE_FRAGMENT,
    uniforms: { time: { value: 0 }, seed: { value: Math.random() * 10 }, strength: { value: 1 } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const flame = new THREE.Group();
  for (let k = 0; k < 2; k++) {
    const plane = new THREE.Mesh(flameGeo, material);
    plane.rotation.y = (k * Math.PI) / 2 + Math.PI / 4;
    plane.renderOrder = 5;
    flame.add(plane);
  }
  flame.material = material;
  return flame;
}

// Height of the ship's top surface (cabin roof, deck, bow...) straight below
// a point in the ship's own frame, so flames sit on the ship, not inside it.
const fireRay = new THREE.Raycaster();
const rayDown = new THREE.Vector3(0, -1, 0);

function shipSurfaceY(o, x, z) {
  o.root.updateMatrixWorld(true);
  fireRay.set(o.root.localToWorld(new THREE.Vector3(x, 120, z)), rayDown);
  // Solid parts only: the nav-light sprites can't be ray-tested (three.js
  // needs a camera for sprites) and flames shouldn't stand on a light anyway.
  const solids = [];
  const inside = new Set(); // the bridge interior is not a surface to stand on
  if (o.interior) o.interior.traverse((c) => inside.add(c));
  o.tilt.traverse((c) => {
    if (c.isMesh && !inside.has(c)) solids.push(c);
  });
  const hit = fireRay.intersectObjects(solids, false)[0];
  return hit ? o.root.worldToLocal(hit.point.clone()).y : null;
}

function buildShipFire(o) {
  const fire = new THREE.Group();
  fire.flames = [];
  fire.smoke = [];
  fire.embers = [];
  for (let i = 0; i < FIRE_FLAMES; i++) {
    const f = makeFlame();
    // Spread order: the first flames sit mid-ship, later ones further fore
    // and aft; each stands on whatever part of the ship is below it.
    let along = 0;
    let across = 0;
    let y = null;
    for (let tries = 0; tries < 8 && y === null; tries++) {
      along = (i % 2 ? 1 : -1) * (i / FIRE_FLAMES) * 22 + (Math.random() - 0.5) * 8;
      across = (Math.random() - 0.5) * 9;
      y = shipSurfaceY(o, along, across);
    }
    f.userData = { dx: along, dz: across, y: (y ?? 6) - 0.5, w: 7 + Math.random() * 4, h: 10 + Math.random() * 6 };
    f.visible = false;
    fire.add(f);
    fire.flames.push(f);
  }
  for (let i = 0; i < FIRE_SMOKE; i++) {
    const sm = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0x0d0b0a, transparent: true, depthWrite: false, fog: true }));
    sm.userData = { phase: i / FIRE_SMOKE, dx: (Math.random() - 0.5) * 20 };
    fire.add(sm);
    fire.smoke.push(sm);
  }
  for (let i = 0; i < FIRE_EMBERS; i++) {
    const e = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSoft, color: 0xffa040, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    e.userData = { phase: Math.random(), dx: (Math.random() - 0.5) * 30, dz: (Math.random() - 0.5) * 10, drift: (Math.random() - 0.5) * 14 };
    fire.add(e);
    fire.embers.push(e);
  }
  o.root.add(fire);
  return fire;
}

function updateShipFire(ship, o, dt) {
  if (ship.fire && !o.fire) o.fire = buildShipFire(o);
  if (!o.fire) return;
  const burning = !!ship.fire && (!ship.capsized || !!ship.burnsWhileSinking);
  o.fire.visible = burning;
  if (burning) {
    const t = clock.t;
    const k = ship.fire.intensity; // 1 .. 4
    const lit = Math.min(FIRE_FLAMES, Math.round(3 + (k - 1) * 3.7));
    // Smoke drifts downwind; the fire group turns with the ship, so the wind
    // is turned into the ship's own frame.
    const ca = Math.cos(o.yaw);
    const sa = Math.sin(o.yaw);
    const windX = game.wind.x * ca + game.wind.y * sa;
    const windZ = -game.wind.x * sa + game.wind.y * ca;
    const grow = 0.85 + k * 0.12;
    o.fire.flames.forEach((f, i) => {
      f.visible = i < lit;
      if (!f.visible) return;
      const u = f.userData;
      f.material.uniforms.time.value = t;
      f.material.uniforms.strength.value = ship.fire.inRain ? 0.75 : 1;
      f.position.set(u.dx, u.y, u.dz);
      f.scale.set(u.w * grow, u.h * grow * (0.92 + 0.08 * Math.sin(t * 6 + i)), u.w * grow);
    });
    for (const sm of o.fire.smoke) {
      const u = sm.userData;
      const life = (t * 0.3 + u.phase) % 1;
      sm.position.set(u.dx * (1 - life) + windX * life * 1.2, 16 + life * (70 + k * 15), windZ * life * 1.2);
      sm.scale.setScalar((9 + life * 48) * (0.8 + k * 0.12));
      sm.material.opacity = (1 - life) * (0.5 + k * 0.08) * Math.min(1, life * 5);
      // Rain turns black smoke greyer (steam mixing in).
      sm.material.color.setHex(ship.fire.inRain ? 0x55524f : 0x0d0b0a);
    }
    for (const e of o.fire.embers) {
      const u = e.userData;
      const life = (t * 0.8 + u.phase) % 1;
      e.position.set(u.dx + u.drift * life + windX * life * 0.4, 10 + life * 45, u.dz + windZ * life * 0.4);
      e.scale.setScalar(1.4 + Math.random() * 1.0);
      e.material.opacity = (1 - life) * Math.min(1, k / 2);
    }
  }
  if (ship.fireOutAt && ship.fireOutAt !== o.lastFireOut) {
    o.lastFireOut = ship.fireOutAt;
    for (let i = 0; i < 5; i++) puffSteam(o.root.position.x + (Math.random() - 0.5) * 30, o.root.position.z + (Math.random() - 0.5) * 30, 1, 14);
  }
}

// White spray thrown up where the hydrofoil's struts cut the water, trailing
// behind; strongest when it is fast and foil-borne.
const FOIL_STRUTS = [[11, -4.2], [11, 4.2], [-12, -4.2], [-12, 4.2]].map(([x, z]) => [x * shipScale("Hydrofoil"), z * shipScale("Hydrofoil")]);

function updateFoilSpray(ship, o, dt) {
  if (!o.spray) {
    o.spray = [];
    for (let i = 0; i < 24; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0xf4fbff, transparent: true, depthWrite: false, opacity: 0 }));
      sp.userData = { strut: i % 4, phase: i / 24 };
      o.root.add(sp);
      o.spray.push(sp);
    }
  }
  const speed = Math.min(1, Math.abs(ship.speed || 0) / (ship.maxSpeed || 1));
  const amount = o.lift * speed;
  const t = clock.t;
  for (const sp of o.spray) {
    const u = sp.userData;
    const life = (t * 2.2 + u.phase) % 1;
    const [x, z] = FOIL_STRUTS[u.strut];
    sp.position.set(x - life * 26, 1 + Math.sin(life * Math.PI) * 4, z * (1 + life * 0.8));
    sp.scale.setScalar(3 + life * 7);
    sp.material.opacity = amount * (1 - life) * 0.8;
    sp.visible = amount > 0.02 && !ship.capsized;
  }
}

function shipList() {
  const list = [];
  if (game.player1) list.push(game.player1);
  if (mode === "local" && game.player2) list.push(game.player2);
  if (mode === "single") {
    if (game.ai) list.push(game.ai);
    list.push(...game.pirateRaiders);
  }
  return list;
}

const shipObjects = new Map();

// ---------------------------------------------------------------------------
// Islands, volcanoes, icebergs
// ---------------------------------------------------------------------------

const sandMat = shared(mat(0xd8c28a, { roughness: 0.95 }));
const grassMat = shared(mat(0x4d8a38, { roughness: 0.9 }));
const rockMat = shared(mat(0x6a645c, { roughness: 0.95 }));

// ---- Ground detail ----------------------------------------------------------
// Land is not one flat colour: grass, sand and rock each get a detail texture
// (light and dark patches, grain) and a matching relief (normal) map, so the
// sun picks out small bumps and dips. Both are made here from noise, once,
// while loading. They are greyscale: the material colour still decides the
// colour, so the snowy polar run (applyPolar recolours these materials) keeps
// working. Sharper on a computer than on a phone; texture sharpness at low
// angles follows the quality level (applyQuality).
const LAND_TEX_SIZE = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 512 : 1024;

// Smooth noise that tiles seamlessly: `cells` lattice cells across the
// texture, `octaves` layers each twice as fine and half as strong. 0..1.
function tileNoise(size, cells, octaves, seed) {
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const c = cells << o;
    const lattice = new Float32Array(c * c);
    for (let i = 0; i < c * c; i++) lattice[i] = hash3(i % c, Math.floor(i / c), o, seed);
    const k = c / size;
    for (let y = 0; y < size; y++) {
      const fy = y * k;
      const y0 = Math.floor(fy);
      const ty = (fy - y0) * (fy - y0) * (3 - 2 * (fy - y0));
      const r0 = y0 * c;
      const r1 = ((y0 + 1) % c) * c;
      for (let x = 0; x < size; x++) {
        const fx = x * k;
        const x0 = Math.floor(fx);
        const tx = (fx - x0) * (fx - x0) * (3 - 2 * (fx - x0));
        const x1 = (x0 + 1) % c;
        const top = lattice[r0 + x0] + (lattice[r0 + x1] - lattice[r0 + x0]) * tx;
        const bottom = lattice[r1 + x0] + (lattice[r1 + x1] - lattice[r1 + x0]) * tx;
        out[y * size + x] += amp * (top + (bottom - top) * ty);
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

// A greyscale detail map and a relief map from a brightness and a height field.
function groundTextures(size, shade, height, relief, worldSize) {
  const make = (fill, srgb) => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const cx = cv.getContext("2d");
    const img = cx.createImageData(size, size);
    fill(img.data);
    cx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1 / worldSize, 1 / worldSize); // UVs are in world units
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };
  const map = make((d) => {
    for (let i = 0; i < size * size; i++) {
      const v = Math.round(255 * clamp(shade[i], 0, 1));
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }
  }, true);
  const normalMap = make((d) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const at = (xx, yy) => height[((yy + size) % size) * size + ((xx + size) % size)];
        const nx = (at(x - 1, y) - at(x + 1, y)) * relief;
        const ny = (at(x, y - 1) - at(x, y + 1)) * relief;
        const len = Math.hypot(nx, ny, 1);
        const i = (y * size + x) * 4;
        d[i] = Math.round(127.5 + (127.5 * nx) / len);
        d[i + 1] = Math.round(127.5 + (127.5 * ny) / len);
        d[i + 2] = Math.round(127.5 + 127.5 / len);
        d[i + 3] = 255;
      }
    }
  }, false);
  return { map, normalMap };
}

const landTextures = [];

function detailGround(material, tex, strength) {
  material.map = tex.map;
  material.normalMap = tex.normalMap;
  material.normalScale.set(strength, strength);
  material.needsUpdate = true;
  landTextures.push(tex.map, tex.normalMap);
}

(() => {
  const n = LAND_TEX_SIZE;
  const grain = (i, seed) => hash3(i % n, Math.floor(i / n), 0, seed) - 0.5;
  // Grass: tufts and rolling patches, a little grain.
  const gHeight = tileNoise(n, 16, 5, 11);
  const gPatch = tileNoise(n, 3, 3, 12);
  const gShade = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) gShade[i] = 0.7 + 0.24 * gPatch[i] + 0.14 * (gHeight[i] - 0.5) + 0.08 * grain(i, 13);
  detailGround(grassMat, groundTextures(n, gShade, gHeight, 26, 60), 1);
  // Sand: wind ripples bent by noise, fine grain.
  const sBend = tileNoise(n, 4, 3, 21);
  const sHeight = new Float32Array(n * n);
  const sShade = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const y = Math.floor(i / n) / n;
    sHeight[i] = 0.5 + 0.5 * Math.sin(2 * Math.PI * (y * 18 + 2.5 * sBend[i]));
    sShade[i] = 0.86 + 0.06 * sHeight[i] + 0.08 * grain(i, 22);
  }
  detailGround(sandMat, groundTextures(n, sShade, sHeight, 7, 30), 0.6);
  // Rock: ridged, cracked stone.
  const rNoise = tileNoise(n, 6, 6, 31);
  const rHeight = new Float32Array(n * n);
  const rShade = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    rHeight[i] = 1 - Math.abs(2 * rNoise[i] - 1);
    rShade[i] = 0.72 + 0.28 * rHeight[i] + 0.06 * grain(i, 32);
  }
  detailGround(rockMat, groundTextures(n, rShade, rHeight, 24, 40), 0.9);
})();
const trunkMat = shared(mat(0x7a5634, { roughness: 0.9 }));
const leafMat = shared(mat(0x3f8f2f, { roughness: 0.75, side: THREE.DoubleSide }));

function palmTree(height) {
  const g = new THREE.Group();
  const lean = (Math.random() - 0.5) * 0.5;
  const trunk = mesh(new THREE.CylinderGeometry(height * 0.035, height * 0.07, height, 6), trunkMat);
  trunk.position.y = height / 2;
  g.add(trunk);
  const crown = new THREE.Group();
  crown.position.y = height;
  for (let i = 0; i < 7; i++) {
    const leaf = mesh(new THREE.ConeGeometry(height * 0.1, height * 0.6, 4), leafMat);
    leaf.scale.set(1, 1, 0.25);
    leaf.position.y = -1;
    leaf.rotation.z = -Math.PI / 2 - 0.45; // tip outward and drooping
    const holder = new THREE.Group();
    holder.rotation.y = (i / 7) * Math.PI * 2;
    leaf.position.x = height * 0.27;
    holder.add(leaf);
    crown.add(holder);
  }
  g.add(crown);
  g.rotation.z = lean;
  return g;
}

// Island ground: rolling contours from layered noise on a dome that sinks
// below the sea at the island's edge (so the coastline stays where ships hit
// it). Small fine noise adds rugged bumps; a mountain island gets ridged
// peaks. 0 is sea level.
function islandShape(r, mountain, seed) {
  const peak = mountain ? 0.55 : 0.3;
  // A ragged coast: headlands and coves of several sizes, never past the
  // island's solid radius (so a cove is only ever inside the reef ring).
  const wobble = (a) =>
    clamp(
      0.68 +
        0.12 * Math.sin(a * 2 + seed) +
        0.1 * Math.sin(a * 3 + seed * 1.7) +
        0.07 * Math.sin(a * 5 + seed * 2.9) +
        0.05 * Math.sin(a * 8 + seed * 4.1) +
        0.035 * Math.sin(a * 13 + seed * 5.3),
      0.45,
      0.93
    );
  const height = (x, z) => {
    const d = Math.hypot(x, z) / (r * 1.08 * wobble(Math.atan2(z, x)));
    if (d >= 1) return -3;
    const roll = fbm2(x / (r * 0.5), z / (r * 0.5), seed, 4);
    const fine = fbm2(x / 16, z / 16, seed + 5, 3) - 0.5;
    const ridge = mountain ? 1 - Math.abs(2 * fbm2(x / (r * 0.35), z / (r * 0.35), seed + 9, 4) - 1) : 0;
    const dome = Math.pow(1 - d * d, 1.4);
    const beach = clamp((1 - d) / 0.12, 0, 1); // rises out of the sea over the beach
    return -3 + 6 * beach + dome * r * peak * (0.35 + 0.9 * roll + 0.6 * ridge) + dome * 7 * fine;
  };
  return { height, edge: (a) => r * 1.12 * wobble(a), peak: r * peak };
}

// Smooth 2D noise, 0..1 (not tiling; for island shapes).
function fbm2(x, y, seed, octaves) {
  let sum = 0;
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = (x - xi) * (x - xi) * (3 - 2 * (x - xi));
    const ty = (y - yi) * (y - yi) * (3 - 2 * (y - yi));
    const h = (i, j) => hash3(i, j, o, seed);
    const top = h(xi, yi) + (h(xi + 1, yi) - h(xi, yi)) * tx;
    const bottom = h(xi, yi + 1) + (h(xi + 1, yi + 1) - h(xi, yi + 1)) * tx;
    sum += amp * (top + (bottom - top) * ty);
    total += amp;
    amp *= 0.5;
    x *= 2;
    y *= 2;
  }
  return sum / total;
}

// The island's ground as one mesh: sand on the beach, grass on the slopes,
// rock where it is steep or high. `detail` sets how fine the mesh is (the
// quality level's terrain setting). UVs are in world units for the ground
// textures.
function islandTerrain(r, mountain, seed, detail) {
  const shape = islandShape(r, mountain, seed);
  const rings = Math.max(8, Math.round(16 * detail));
  const segments = Math.max(48, Math.round(72 * detail));
  const pos = [0, shape.height(0, 0), 0];
  for (let i = 1; i <= rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      const rho = shape.edge(a) * Math.pow(i / rings, 0.8); // finer towards the shore
      const x = Math.cos(a) * rho;
      const z = Math.sin(a) * rho;
      pos.push(x, shape.height(x, z), z);
    }
  }
  const vi = (i, j) => (i === 0 ? 0 : 1 + (i - 1) * segments + (j % segments));
  const tris = [];
  for (let j = 0; j < segments; j++) tris.push([0, vi(1, j + 1), vi(1, j)]);
  for (let i = 1; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      tris.push([vi(i, j), vi(i, j + 1), vi(i + 1, j)], [vi(i, j + 1), vi(i + 1, j + 1), vi(i + 1, j)]);
    }
  }
  // Each triangle is sand, grass or rock by its height and steepness, with a
  // little noise so the borders wander like real ones.
  const groups = [[], [], []]; // sand, grass, rock
  const p = (k) => [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]];
  for (const t of tris) {
    const [a, b, c] = t.map(p);
    const y = (a[1] + b[1] + c[1]) / 3;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const up = Math.abs(ny) / (Math.hypot(nx, ny, nz) || 1);
    const jitter = hash3(Math.round(a[0]), Math.round(a[2]), 1, seed) - 0.5;
    const steep = up < 0.62 + 0.1 * jitter; // bare rock only where it is steep...
    const summit = mountain && y > shape.peak * (0.7 + 0.2 * jitter); // ...or high on a mountain
    const kind = y < 3.2 + 2 * jitter ? 0 : steep || summit ? 2 : 1;
    groups[kind].push(...t);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  const uv = [];
  for (let k = 0; k < pos.length; k += 3) uv.push(pos[k], pos[k + 2]);
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex([...groups[0], ...groups[1], ...groups[2]]);
  let start = 0;
  groups.forEach((g, m) => {
    geo.addGroup(start, g.length, m);
    start += g.length;
  });
  geo.computeVertexNormals();
  const ground = mesh(geo, [sandMat, grassMat, rockMat]);
  return { ground, shape };
}

// `detail`: how fine the ground mesh is; by default the quality level's
// (set once when the island is made, never during play).
function islandModel(r, mountain = false, detail = QUALITY_LEVELS[perf.level].terrain) {
  const g = new THREE.Group();
  const seed = Math.random() * 100;
  const { ground, shape } = islandTerrain(r, mountain, seed, detail);
  g.add(ground);
  for (let i = 0; i < 3; i++) {
    const rock = mesh(roughen(new THREE.DodecahedronGeometry(r * 0.1, 1), r * 0.03, seed + i), rockMat);
    const a = Math.random() * Math.PI * 2;
    const x = Math.cos(a) * r * 0.9;
    const z = Math.sin(a) * r * 0.9;
    rock.position.set(x, Math.max(0, shape.height(x, z)) - r * 0.02, z);
    rock.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    g.add(rock);
  }
  if (r < 120) {
    const palms = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < palms; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = r * (0.3 + Math.random() * 0.45);
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      const palm = palmTree(4.7 + Math.random() * 2); // 14-20 m
      palm.userData.palm = true;
      palm.position.set(x, shape.height(x, z) - 0.5, z);
      g.add(palm);
    }
  }
  return g;
}

const DANGER_STYLE = {
  island: { color: 0xd8b878, opacity: 0.32 },
  iceberg: { color: 0xc9f0ff, opacity: 0.34 },
  volcano: { color: 0xff5a3a, opacity: 0.42 }
};

function dangerMarkers(hz, group) {
  const style = DANGER_STYLE[hz.kind];
  group.add(flatDisc(hz.danger, style.color, 0.06, 0.6));
  group.add(flatRing(hz.danger - 2, hz.danger, style.color, style.opacity, 0.7));
}

function volcanoModel(hz, o) {
  const g = new THREE.Group();
  const r = hz.r;
  const seed = Math.random() * 100;
  const cone = mesh(
    roughen(new THREE.CylinderGeometry(r * 0.22, r * 1.08, r * 1.25, 30, 7, true), r * 0.12, seed),
    mat(0x6a5444, { roughness: 0.95, flatShading: true })
  );
  cone.position.y = r * 0.6;
  g.add(cone);
  const base = mesh(roughen(new THREE.CylinderGeometry(r * 1.1, r * 1.22, 4, 30), r * 0.08, seed + 3), mat(0x3d302a, { roughness: 1 }), false);
  base.position.y = 0;
  g.add(base);
  o.lava = lavaMaterial(lavaTex, { emissiveIntensity: 3 });
  const crater = mesh(new THREE.CircleGeometry(r * 0.26, 24).rotateX(-Math.PI / 2), o.lava, false);
  crater.position.y = r * 1.21;
  g.add(crater);
  // Lava streams start at the crater rim and grow down the slope as the
  // game's hz.lavaFlow rises (0.2 at rest, 1 = reaching the sea).
  o.flowMat = lavaMaterial(lavaFlowTex);
  o.streams = [];
  const streamGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, -0.5, 0);
  const angles = volcanoLavaAngles(hz);
  for (let i = 0; i < 5; i++) {
    const a = angles[i];
    const top = new THREE.Vector3(Math.cos(a) * r * 0.24, r * 1.21, Math.sin(a) * r * 0.24);
    const bottom = new THREE.Vector3(Math.cos(a) * r * 1.16, 1, Math.sin(a) * r * 1.16);
    const down = bottom.clone().sub(top);
    const pivot = new THREE.Group();
    pivot.position.copy(top);
    pivot.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), down.clone().normalize());
    const stream = mesh(streamGeo, o.flowMat, false);
    stream.scale.set(r * (0.11 + Math.random() * 0.07), 1, 3);
    pivot.add(stream);
    g.add(pivot);
    o.streams.push({ stream, length: down.length() * (0.85 + Math.random() * 0.2) });
  }
  // The blast: a column of fire out of the crater.
  o.column = mesh(
    new THREE.CylinderGeometry(r * 0.1, r * 0.3, 1, 18, 1, true).translate(0, 0.5, 0),
    new THREE.MeshBasicMaterial({ color: 0xff4a12, map: lavaFlowTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    false
  );
  o.column.position.y = r * 1.2;
  o.column.visible = false;
  g.add(o.column);
  // Glowing lava bombs thrown out while it erupts.
  o.bombs = [];
  o.bombGroup = new THREE.Group();
  g.add(o.bombGroup);
  for (let i = 0; i < 90; i++) {
    const b = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowSoft, color: 0xffa040, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    b.visible = false;
    b.userData = { vx: 0, vy: 0, vz: 0, life: 1 };
    o.bombGroup.add(b);
    o.bombs.push(b);
  }
  o.smoke = [];
  o.smokeGroup = new THREE.Group();
  g.add(o.smokeGroup);
  for (let i = 0; i < 12; i++) {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: dotTex, color: 0x4a4440, transparent: true, depthWrite: false, fog: true })
    );
    s.userData.phase = i / 12;
    o.smokeGroup.add(s);
    o.smoke.push(s);
  }
  // A dark ash plume that boils up during the eruption.
  o.ash = [];
  for (let i = 0; i < 22; i++) {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: dotTex, color: 0x2a2522, transparent: true, depthWrite: false, fog: true, opacity: 0 })
    );
    s.userData.phase = i / 22;
    s.userData.side = (Math.random() - 0.5) * 2;
    o.smokeGroup.add(s);
    o.ash.push(s);
  }
  o.top = r * 1.24;
  o.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSoft, color: 0xff5a18, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  o.halo.position.y = o.top + 6;
  o.halo.visible = false;
  g.add(o.halo);
  return g;
}

function icebergModel(hz) {
  const g = new THREE.Group();
  const r = hz.r;
  const ice = mesh(
    roughen(new THREE.IcosahedronGeometry(r * 0.85, 2), r * 0.38, Math.random() * 100),
    mat(0xeaf8ff, { roughness: 0.28, metalness: 0.02, flatShading: true, emissive: 0x0b2a3c, emissiveIntensity: 0.6 })
  );
  ice.scale.y = 0.75;
  ice.position.y = r * 0.12;
  g.add(ice);
  g.add(flatDisc(r * 1.05, 0x7fe0ff, 0.22, 1.2)); // pale water around the submerged ice
  return g;
}

function createHazard(hz) {
  const root = new THREE.Group();
  const o = { root, kind: hz.kind };
  if (hz.kind === "island") {
    root.add(islandModel(hz.r));
    root.traverse((c) => {
      if (c.userData.palm) c.visible = !game.polar;
    });
  }
  if (hz.kind === "volcano") root.add(volcanoModel(hz, o));
  if (hz.kind === "iceberg") root.add(icebergModel(hz));
  dangerMarkers(hz, root);
  return o;
}

function updateHazard(hz, o, dt) {
  toWorld(hz.x, hz.y, 0, o.root.position);
  if (hz.kind === "iceberg") {
    o.root.rotation.y += dt * 0.05;
    o.root.position.y = Math.sin(clock.t * 0.8 + hz.r) * 0.6;
  }
  if (hz.kind === "volcano") {
    const t = clock.t;
    const e = hz.eruption || 0;
    const flow = hz.lavaFlow || LAVA_REST;
    const nightBoost = night.on ? 1.6 : 1;
    o.lava.emissiveIntensity = (2.6 + e * 4 + Math.sin(t * 3.1) * 0.5 + Math.sin(t * 7.3) * 0.25) * nightBoost;
    // Fresh lava glows hot; it dulls as it cools between eruptions.
    o.flowMat.emissiveIntensity = (0.9 + 2.4 * Math.min(1, e * 2 + (flow - LAVA_REST)) + Math.sin(t * 2.3) * 0.2) * nightBoost;
    // At night the crater throws a warm halo into the dark.
    o.halo.visible = night.on;
    o.halo.scale.setScalar(hz.r * (1.7 + e * 1.2 + Math.sin(t * 1.7) * 0.06));
    o.halo.material.opacity = 0.55 + e * 0.35 + Math.sin(t * 3.1) * 0.05;
    for (const st of o.streams) st.stream.scale.y = Math.max(1, st.length * flow);
    for (const s of o.smoke) {
      const life = (t * (0.12 + e * 0.2) + s.userData.phase) % 1;
      s.position.set(game.wind.x * life * 0.9 + Math.sin(life * 6 + s.userData.phase * 20) * 6, o.top + life * (150 + e * 120), game.wind.y * life * 0.9);
      s.scale.setScalar(10 + life * (55 + e * 70));
      s.material.color.setScalar(0.29 - e * 0.12);
      s.material.opacity = (1 - life) * (0.55 + e * 0.35) * Math.min(1, life * 6);
    }
    const r = hz.r;
    // Column of fire, strongest right at the blast.
    const blast = Math.max(0, e - 0.25) / 0.75;
    o.columnOn = blast > 0.02;
    o.column.visible = o.columnOn;
    o.column.scale.set(1 + blast * 0.5, 25 + blast * 130 + Math.sin(t * 17) * 10 * blast, 1 + blast * 0.5);
    o.column.material.opacity = blast * 0.6;
    for (const s of o.ash) {
      const life = (t * 0.22 + s.userData.phase) % 1;
      const spread = life * life * r * 1.6;
      s.position.set(
        game.wind.x * life * 1.6 + s.userData.side * spread,
        o.top + life * (120 + blast * 380),
        game.wind.y * life * 1.6 + Math.cos(s.userData.phase * 40) * spread * 0.6
      );
      s.scale.setScalar(30 + life * 160);
      s.material.opacity = e * 0.8 * (1 - life) * Math.min(1, life * 5);
    }
    for (const b of o.bombs) {
      const u = b.userData;
      if (!b.visible && e > 0.3 && Math.random() < dt * 60 * e) {
        const a = Math.random() * Math.PI * 2;
        const out = 25 + Math.random() * 90 * e;
        u.vx = Math.cos(a) * out;
        u.vz = Math.sin(a) * out;
        u.vy = 90 + Math.random() * 170 * e;
        u.size = 5 + Math.random() * 7;
        b.position.set(0, o.top, 0);
        b.material.color.setHex(0xffc060);
        b.visible = true;
      }
      if (!b.visible) continue;
      u.vy -= 150 * dt;
      b.position.x += u.vx * dt;
      b.position.y += u.vy * dt;
      b.position.z += u.vz * dt;
      b.material.color.lerp(LAVA_COOL, dt * 0.6);
      b.scale.setScalar(u.size * (0.85 + Math.random() * 0.3));
      if (b.position.y < 0) {
        b.visible = false;
        if (Math.hypot(b.position.x, b.position.z) > r * 1.1) puffSteam(o.root.position.x + b.position.x, o.root.position.z + b.position.z, 0.6);
      }
    }
    // The strongest eruption lights the area and shakes the camera; at night
    // the volcano nearest the camera glows on its surroundings even at rest.
    const want = Math.max(e, night.on ? NIGHT_VOLCANO_GLOW : 0);
    const dist = o.root.position.distanceTo(camLook);
    if (want > volcanoGlow.strength + 0.01 || (want > 0 && want >= volcanoGlow.strength - 0.01 && dist < volcanoGlow.dist)) {
      volcanoGlow.strength = want;
      volcanoGlow.dist = dist;
      volcanoGlow.light.position.set(o.root.position.x, o.top + 40, o.root.position.z);
    }
  }
}

const LAVA_COOL = new THREE.Color(0x8a1c06);

// Steam puffs (lava or hot rocks meeting water, a fire being put out).
const steamGroup = new THREE.Group();
scene.add(steamGroup);
const steamPuffs = [];
for (let i = 0; i < 60; i++) {
  const st = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0xf2f4f5, transparent: true, depthWrite: false, opacity: 0 }));
  st.visible = false;
  st.userData = { life: 1, size: 1 };
  steamGroup.add(st);
  steamPuffs.push(st);
}

function puffSteam(x, z, size, y = 2) {
  const st = steamPuffs.find((p) => !p.visible);
  if (!st) return;
  st.position.set(x, y, z);
  st.userData.life = 0;
  st.userData.size = 14 + size * 22;
  st.visible = true;
}

function updateSteam(dt) {
  for (const st of steamPuffs) {
    if (!st.visible) continue;
    const u = st.userData;
    u.life += dt / 2.6;
    if (u.life >= 1) {
      st.visible = false;
      continue;
    }
    st.position.y += dt * 22;
    st.position.x += game.wind.x * dt * 0.3;
    st.position.z += game.wind.y * dt * 0.3;
    st.scale.setScalar(u.size * (0.6 + u.life * 1.8));
    st.material.opacity = 0.55 * (1 - u.life) * Math.min(1, u.life * 8);
  }
}

// Pack ice (game.iceSheets): a heightfield over the sheet, raised by the
// thickness game.js gives each floe and ridge (iceSurface), painted with the
// sheet's picture. Open water (outside the edge, the icebreaker's channels)
// drops to the waterline and the picture's clear pixels cut it away, so
// floe edges and channel sides show as walls of blue-green ice.
const ICE_GRID = 160; // squares along each side of the sheet
const ICE_SIDE = new THREE.Color(0x6fbfd3);
const ICE_TOP = new THREE.Color(0xffffff);
const ICE_REFRESH = 0.12; // seconds between reshaping a sheet that is being broken

function createIceSheet(s) {
  const tex = new THREE.CanvasTexture(s.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const geo = new THREE.PlaneGeometry(s.r * 2, s.r * 2, ICE_GRID, ICE_GRID).rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, iceSurface(s, pos.getX(i), pos.getZ(i)));
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));
  const root = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, alphaTest: 0.4, roughness: 0.5, metalness: 0, flatShading: true, emissive: 0x0b2a3c, emissiveIntensity: 0.25 })
  );
  root.castShadow = true;
  root.receiveShadow = true;
  const o = { root, tex, version: s.version, done: 0, wait: 0 };
  shapeIce(s, o);
  return o;
}

// Sinks the ice the icebreaker has broken since the last call, then redoes
// the shading: steep faces (floe edges, channel sides, ridge flanks) are
// tinted blue-green like real ice seen side on.
function shapeIce(s, o) {
  const geo = o.root.geometry;
  const pos = geo.attributes.position;
  const step = (s.r * 2) / ICE_GRID;
  const reach = Math.ceil(ICE_BREAK_R / step);
  for (; o.done < s.broken.length; o.done++) {
    const p = s.broken[o.done];
    const ci = Math.round((p.x - s.x + s.r) / step);
    const cj = Math.round((p.y - s.y + s.r) / step);
    for (let j = Math.max(0, cj - reach); j <= Math.min(ICE_GRID, cj + reach); j++) {
      for (let i = Math.max(0, ci - reach); i <= Math.min(ICE_GRID, ci + reach); i++) {
        const k = j * (ICE_GRID + 1) + i;
        if ((pos.getX(k) + s.x - p.x) ** 2 + (pos.getZ(k) + s.y - p.y) ** 2 < ICE_BREAK_R * ICE_BREAK_R) pos.setY(k, 0);
      }
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal;
  const col = geo.attributes.color;
  for (let i = 0; i < pos.count; i++) {
    const t = smoothstep(0.5, 0.92, nrm.getY(i));
    colorTmp.copy(ICE_SIDE).lerp(ICE_TOP, t);
    col.setXYZ(i, colorTmp.r, colorTmp.g, colorTmp.b);
  }
  col.needsUpdate = true;
  geo.computeBoundingSphere();
}

const colorTmp = new THREE.Color();

function updateIceSheet(s, o, dt) {
  toWorld(s.x, s.y, 0, o.root.position);
  o.root.position.y = seaHeight(o.root.position.x, o.root.position.z) + 0.15;
  o.wait -= dt;
  if (o.version !== s.version && o.wait <= 0) {
    o.version = s.version;
    o.wait = ICE_REFRESH;
    o.tex.needsUpdate = true;
    shapeIce(s, o);
  }
}

// Lava patches on the sea (game.lavaPools): they spread, glow, cool to a
// dark crust and sink, steaming as they go.
function createLavaPool(pool) {
  const tex = lavaTex.clone();
  tex.offset.set(Math.random(), Math.random());
  tex.repeat.setScalar(0.5 + Math.random() * 0.3);
  const m = lavaMaterial(tex, { alphaMap: blobTex, transparent: true, depthWrite: false, emissiveIntensity: 0 });
  const root = mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), m, false);
  root.rotation.y = pool.turn;
  toWorld(pool.x, pool.y, 0, projTmp);
  puffSteam(projTmp.x, projTmp.z, 1);
  return { root };
}

const projTmp = new THREE.Vector3();

function updateLavaPool(pool, o, dt) {
  const life = pool.life;
  toWorld(pool.x, pool.y, 0.5 - Math.max(0, life - 0.6) * 10, o.root.position);
  o.root.position.y += seaHeight(o.root.position.x, o.root.position.z);
  const grow = pool.size * (1 + life * 3.5);
  o.root.scale.set(grow, 1, grow * pool.stretch);
  o.root.rotation.y += dt * 0.05;
  o.root.material.emissiveIntensity = (night.on ? 3.6 : 2.6) * Math.pow(1 - life, 2.5);
  o.root.material.opacity = Math.min(1, (1 - life) * 1.8);
  if (Math.random() < dt * 1.5 * (1 - life)) puffSteam(o.root.position.x, o.root.position.z, 0.5);
}

// Rocks in flight from the crater, and a red ring on the sea where each
// will land (it tightens as the rock comes down).
const volcanoRockGeo = shared(new THREE.DodecahedronGeometry(7, 0));
const volcanoRockMat = shared(new THREE.MeshStandardMaterial({ color: 0x2a1a14, emissive: 0xff4a10, emissiveIntensity: 0.6, roughness: 0.9, flatShading: true }));

function createRock(rock) {
  const root = new THREE.Group();
  const stone = mesh(volcanoRockGeo, volcanoRockMat);
  stone.scale.setScalar(0.8 + Math.random() * 0.6);
  root.add(stone);
  const trail = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSoft, color: 0xff8a30, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  trail.scale.setScalar(22);
  root.add(trail);
  const ring = mesh(new THREE.RingGeometry(0.82, 1, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff3a20, transparent: true, opacity: 0.6, depthWrite: false }), false);
  scene.add(ring);
  return { root, stone, ring, start: new THREE.Vector3(), end: new THREE.Vector3() };
}

function updateRock(rock, o) {
  const hz = rock.volcano;
  toWorld(hz.x, hz.y, hz.r * 1.24, o.start);
  toWorld(rock.tx, rock.ty, 0, o.end);
  const t = rock.t;
  o.root.position.lerpVectors(o.start, o.end, t);
  o.root.position.y = o.start.y * (1 - t) + Math.sin(Math.PI * t) * 160;
  o.stone.rotation.set(rock.spin * t * 3, rock.spin * t * 2, 0);
  o.ring.position.set(o.end.x, 0.8, o.end.z);
  o.ring.scale.setScalar(ROCK_HIT_RADIUS * (1.6 - t * 0.6));
  o.ring.material.opacity = 0.35 + 0.5 * t * (0.7 + 0.3 * Math.sin(clock.t * 20));
}

function removeRock(o) {
  scene.remove(o.ring);
  o.ring.geometry.dispose();
  o.ring.material.dispose();
  if (o.end) puffSteam(o.end.x, o.end.z, 1.2);
}

// One orange light shared by all volcanoes; the strongest eruption owns it.
const volcanoGlow = { light: new THREE.PointLight(0xff6a20, 0, 1400, 1.2), strength: 0, dist: Infinity };
const NIGHT_VOLCANO_GLOW = 0.35;
scene.add(volcanoGlow.light);

const hazardObjects = new Map();
const lavaPoolObjects = new Map();
const iceSheetObjects = new Map();
const rockObjects = new Map();

// ---------------------------------------------------------------------------
// Storms, water spout, tsunami
// ---------------------------------------------------------------------------

// Storm clouds float high: above the sea in the view from above (still over
// their patch of rain), and higher still behind the ship (chase view), where
// a storm shows up far off near the horizon and passes overhead.
const CLOUD_HEIGHT_OVERVIEW = 240;
const CLOUD_HEIGHT_CHASE = 480;
// Seen from sea level a storm cloud is much wider than its patch of rain.
const CLOUD_SCALE_CHASE = 2.2;
const sky = { cloudHeight: CLOUD_HEIGHT_OVERVIEW };

// A cotton-wool puff: a cluster of soft round blobs, a little denser in the
// middle, with ragged edges. A few variants so the puffs don't repeat.
function cloudPuffTexture(seed) {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  let r = seed * 7919;
  const rand = () => (r = (r * 9301 + 49297) % 233280) / 233280;
  for (let i = 0; i < 26; i++) {
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand()) * size * 0.26;
    const x = size / 2 + Math.cos(a) * d;
    const y = size / 2 + Math.sin(a) * d * 0.8;
    const br = size * (0.1 + rand() * 0.16);
    const grad = g.createRadialGradient(x, y, 0, x, y, br);
    grad.addColorStop(0, "rgba(255,255,255,0.42)");
    grad.addColorStop(0.6, "rgba(255,255,255,0.22)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const cloudPuffTex = [1, 2, 3, 4].map(cloudPuffTexture);

// Cloud colours: bright sunlit tops, grey bases (dark under a storm). At night
// the moon lights them only faintly. Sprites aren't lit, so they're tinted.
const CLOUD_TOP = new THREE.Color(0xf4f6f9);
// The whole frame is tone mapped (exposure 0.5), so a cloud has to be brighter
// than plain white to look white against the bright day sky.
const CLOUD_DAY = 2.6;
const CLOUD_NIGHT = 0.2;
const cloudTint = new THREE.Color();

// A heap of puffs: flat base, billowing up into a dome. `tall` 1 = a towering
// storm cloud, less = a fair-weather cumulus. Each puff keeps its shade
// (0 base .. 1 top) for tinting.
function cloudHeap(width, tall, count, base) {
  const group = new THREE.Group();
  const height = width * 0.55 * tall;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.sqrt(Math.random()) * width;
    const dome = 1 - (d / width) ** 2;
    const y = height * dome * Math.random() ** 0.7;
    const material = new THREE.SpriteMaterial({
      map: cloudPuffTex[i % cloudPuffTex.length],
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      rotation: Math.random() * Math.PI * 2
    });
    const puff = new THREE.Sprite(material);
    const size = width * (0.5 + Math.random() * 0.45) * (1 - 0.3 * (y / height));
    puff.scale.set(size * 1.25, size, 1);
    puff.position.set(Math.cos(a) * d, y, Math.sin(a) * d * 0.85);
    // Lighter on top and on the side the sun is on.
    const sunSide = (Math.cos(a) * sunDir.x + Math.sin(a) * sunDir.z) * (d / width);
    puff.userData.shade = clamp(0.3 + 0.7 * (y / height) + 0.25 * sunSide, 0, 1);
    puff.userData.base = base;
    group.add(puff);
  }
  return group;
}

// Tints a heap's puffs for day or night; much brighter during a lightning flash.
// `under` (0..1) darkens it towards its base colour: a cloud seen from below.
function tintCloud(group, flash, fade = 1, under = 0) {
  for (const puff of group.children) {
    cloudTint.copy(puff.userData.base).lerp(CLOUD_TOP, puff.userData.shade * (1 - under));
    cloudTint.multiplyScalar(night.applied ? CLOUD_NIGHT : CLOUD_DAY);
    if (flash) cloudTint.copy(CLOUD_TOP).multiplyScalar(CLOUD_DAY * 1.5);
    puff.material.color.copy(cloudTint);
    puff.material.opacity = 0.95 * fade;
  }
}

const STORM_BASE = new THREE.Color(0x4e5763);
const DECK_BASE = new THREE.Color(0x5f6873);
// A storm is a whole weather system, not one cloud: a grey deck of cloud
// covers the area its heavy seas reach (game.js STORM_SEA_REACH), with the
// towering thundercloud over the rain in the middle. Lightning only strikes
// under the thundercloud, so it always comes out of a clouded sky.
const STORM_DECK_REACH = 380;
const DECK_HEAPS = 12;
// From above the deck is see-through, so the sea and ships under it still show.
const DECK_FADE_OVERVIEW = 0.35;

// Rain: thousands of fine streaks over a wide area, animated on the GPU.
// Heaviest under the thundercloud, thinning out towards the edge of the deck;
// game.js turns the whole storm's rain heavier and lighter (dz.rain).
const RAIN_DROPS = 6000;
const RAIN_REACH = 260; // rain falls this far past the storm's core
const rainVertex = /* glsl */ `
  attribute vec3 drop; // phase (0..1), length factor, threshold (0..1)
  attribute float tip; // 0 = top of the streak, 1 = bottom
  uniform float time;
  uniform float height;
  uniform float fall;
  uniform float dropLength;
  uniform vec2 slant;
  uniform float intensity;
  uniform float core;
  uniform float reach;
  varying float vShow;
  void main() {
    float y = height - mod(drop.x * height + time * fall, height);
    float d = length(position.xz);
    float local = intensity * mix(1.0, 0.25, smoothstep(core * 0.7, reach, d)) * (1.0 - smoothstep(reach * 0.9, reach, d));
    vShow = step(drop.z, local);
    float len = dropLength * drop.y;
    // The wind carries each drop sideways as it falls.
    vec2 xz = position.xz + slant * (height - y) * 0.15 - slant * tip * len * 0.15;
    vec3 p = vec3(xz.x, y - tip * len, xz.y);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;
const rainFragment = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  varying float vShow;
  void main() {
    if (vShow < 0.5) discard;
    gl_FragColor = vec4(color, opacity);
  }`;

function rainGeometry(reach) {
  const pos = new Float32Array(RAIN_DROPS * 6);
  const drop = new Float32Array(RAIN_DROPS * 6);
  const tip = new Float32Array(RAIN_DROPS * 2);
  for (let i = 0; i < RAIN_DROPS; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.sqrt(Math.random()) * reach;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const seed = [Math.random(), 0.6 + Math.random() * 0.8, Math.random()];
    pos.set([x, 0, z, x, 0, z], i * 6);
    drop.set([...seed, ...seed], i * 6);
    tip.set([0, 1], i * 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("drop", new THREE.BufferAttribute(drop, 3));
  geo.setAttribute("tip", new THREE.BufferAttribute(tip, 1));
  return geo;
}

function createStorm(dz) {
  const root = new THREE.Group();
  const r = dz.r;
  const cloud = new THREE.Group();
  cloud.position.y = sky.cloudHeight;
  // The thundercloud over the core.
  const core = cloudHeap(r * 1.3, 1, 42, STORM_BASE);
  core.userData.core = true;
  cloud.add(core);
  // The deck: flat, overlapping heaps spread over the whole storm area.
  const deckR = r + STORM_DECK_REACH;
  for (let i = 0; i < DECK_HEAPS; i++) {
    const a = (i / DECK_HEAPS) * Math.PI * 2 + Math.random() * 0.5;
    const d = r * 0.6 + Math.sqrt(Math.random()) * (deckR - r * 0.6);
    const heap = cloudHeap(150 + Math.random() * 90, 0.25, 8, DECK_BASE);
    heap.position.set(Math.cos(a) * d, -10 + Math.random() * 20, Math.sin(a) * d);
    cloud.add(heap);
  }
  root.add(cloud);

  // A soft shadow of the thundercloud on the sea.
  const shade = new THREE.Mesh(
    new THREE.PlaneGeometry(r * 3, r * 3).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x000000, map: dotTex, transparent: true, opacity: 0.3, depthWrite: false })
  );
  root.add(onSea(shade, 0.5));

  const reach = r + RAIN_REACH;
  const rainMat = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      height: { value: sky.cloudHeight },
      fall: { value: 420 },
      dropLength: { value: 2 },
      slant: { value: new THREE.Vector2() },
      intensity: { value: 1 },
      core: { value: r },
      reach: { value: reach },
      color: { value: new THREE.Color(0xc9d9e6) },
      opacity: { value: 0.22 }
    },
    vertexShader: rainVertex,
    fragmentShader: rainFragment,
    transparent: true,
    depthWrite: false
  });
  const rain = new THREE.LineSegments(rainGeometry(reach), rainMat);
  rain.frustumCulled = false;
  root.add(rain);

  const boltGeo = new THREE.BufferGeometry();
  boltGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(10 * 3), 3));
  const bolt = new THREE.Line(boltGeo, new THREE.LineBasicMaterial({ color: 0xf4f8ff }));
  bolt.visible = false;
  bolt.frustumCulled = false;
  root.add(bolt);

  return { root, cloud, core, rain, rainMat, bolt, lastBolt: -99 };
}

function updateStorm(dz, o, dt) {
  toWorld(dz.x, dz.y, 0, o.root.position);
  o.core.rotation.y += dt * 0.02; // the thundercloud slowly churns
  const h = sky.cloudHeight;
  const chaseBlend = (h - CLOUD_HEIGHT_OVERVIEW) / (CLOUD_HEIGHT_CHASE - CLOUD_HEIGHT_OVERVIEW);
  o.cloud.position.y = h;
  o.cloud.scale.setScalar(1 + (CLOUD_SCALE_CHASE - 1) * chaseBlend);

  const u = o.rainMat.uniforms;
  u.time.value = clock.t;
  u.height.value = h;
  u.fall.value = 420 + 240 * chaseBlend;
  u.dropLength.value = 1.2 + 0.8 * chaseBlend;
  u.slant.value.set(game.wind.x || 0, game.wind.y || 0).multiplyScalar(0.02);
  u.intensity.value = dz.rain === undefined ? 1 : dz.rain;
  u.opacity.value = night.applied ? 0.12 : 0.2;

  if (dz.boltAt !== undefined && dz.boltAt !== o.lastBolt) {
    o.lastBolt = dz.boltAt;
    const bp = o.bolt.geometry.attributes.position;
    let x = dz.boltX;
    let z = dz.boltY;
    for (let i = 0; i < 10; i++) {
      bp.setXYZ(i, x, h * (1 - i / 9), z);
      x += (Math.random() - 0.5) * 14;
      z += (Math.random() - 0.5) * 14;
    }
    bp.needsUpdate = true;
    lightningLight.position.set(o.root.position.x, h, o.root.position.z);
  }
  const flashing = natureClock - o.lastBolt < 0.16;
  o.bolt.visible = flashing;
  const deckFade = DECK_FADE_OVERVIEW + (1 - DECK_FADE_OVERVIEW) * chaseBlend;
  // From down at sea level the storm is seen from below: a grey cloud base.
  for (const heap of o.cloud.children) tintCloud(heap, flashing, heap.userData.core ? 1 : deckFade, 0.75 * chaseBlend);
  if (flashing) lightningLight.intensity = 60;
}

// ---------------------------------------------------------------------------
// The tempest sky (game.js tempest): a thick, dark cloud deck over the whole sea, heavy rain all round the
// camera, and lightning from the deck. It thickens first (cover, then rain), rages, then thins and moves out
// slowly with the wind. Seen from the overview camera the deck is held back so the map stays readable.
// ---------------------------------------------------------------------------
const TEMPEST_HEAPS = 100;
const tempestSky = (() => {
  const deck = new THREE.Group();
  const span = Math.max(WORLD_W, WORLD_H) * 1.6;
  const side = Math.ceil(Math.sqrt(TEMPEST_HEAPS));
  for (let i = 0; i < TEMPEST_HEAPS; i++) {
    const gx = (i % side) / (side - 1) - 0.5;
    const gz = Math.floor(i / side) / (side - 1) - 0.5;
    const heap = cloudHeap(430 + Math.random() * 170, 0.28, 10, STORM_BASE);
    heap.position.set(gx * span + (Math.random() - 0.5) * 160, -20 + Math.random() * 50, gz * span + (Math.random() - 0.5) * 160);
    deck.add(heap);
  }
  deck.visible = false;
  scene.add(deck);
  const reach = 700;
  const rainMat = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 }, height: { value: 240 }, fall: { value: 460 }, dropLength: { value: 2 }, slant: { value: new THREE.Vector2() },
      intensity: { value: 1 }, core: { value: reach }, reach: { value: reach }, color: { value: new THREE.Color(0xc9d9e6) }, opacity: { value: 0.22 }
    },
    vertexShader: rainVertex,
    fragmentShader: rainFragment,
    transparent: true,
    depthWrite: false
  });
  const rain = new THREE.LineSegments(rainGeometry(reach), rainMat);
  rain.frustumCulled = false;
  rain.visible = false;
  scene.add(rain);
  const boltGeo = new THREE.BufferGeometry();
  boltGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(10 * 3), 3));
  const bolt = new THREE.Line(boltGeo, new THREE.LineBasicMaterial({ color: 0xf4f8ff }));
  bolt.visible = false;
  bolt.frustumCulled = false;
  scene.add(bolt);
  return { deck, rain, rainMat, bolt, lastBolt: -99, spacing: span / (side - 1) };
})();

function updateTempestSky(dt) {
  const k = tempest.intensity;
  const on = k > 0.02;
  tempestSky.deck.visible = on;
  tempestSky.rain.visible = on;
  if (!on) {
    tempestSky.bolt.visible = false;
    return;
  }
  const h = sky.cloudHeight;
  const chaseBlend = (h - CLOUD_HEIGHT_OVERVIEW) / (CLOUD_HEIGHT_CHASE - CLOUD_HEIGHT_OVERVIEW);
  // lightning from the deck
  if (tempest.boltAt !== tempestSky.lastBolt) {
    tempestSky.lastBolt = tempest.boltAt;
    const bp = tempestSky.bolt.geometry.attributes.position;
    let x = tempest.boltX - HALF_W;
    let z = tempest.boltY - HALF_H;
    for (let i = 0; i < 10; i++) {
      bp.setXYZ(i, x, h * (1 - i / 9), z);
      x += (Math.random() - 0.5) * 14;
      z += (Math.random() - 0.5) * 14;
    }
    bp.needsUpdate = true;
    lightningLight.position.set(tempest.boltX - HALF_W, h, tempest.boltY - HALF_H);
  }
  const flashing = natureClock - tempestSky.lastBolt < 0.16;
  tempestSky.bolt.visible = flashing;
  if (flashing) lightningLight.intensity = Math.max(lightningLight.intensity, 60);
  // the cloud deck: thickens with the tempest; drifts with the wind and wraps round
  const deckFade = DECK_FADE_OVERVIEW + (1 - DECK_FADE_OVERVIEW) * chaseBlend;
  const deck = tempestSky.deck;
  deck.position.y = h;
  deck.scale.setScalar(1 + (CLOUD_SCALE_CHASE - 1) * chaseBlend);
  deck.position.x += (game.wind.x || 0) * 0.12 * dt;
  deck.position.z += (game.wind.y || 0) * 0.12 * dt;
  // wrapped by one grid step, so the deck carries on unbroken as it drifts
  const sp = tempestSky.spacing;
  if (deck.position.x > sp / 2) deck.position.x -= sp;
  if (deck.position.x < -sp / 2) deck.position.x += sp;
  if (deck.position.z > sp / 2) deck.position.z -= sp;
  if (deck.position.z < -sp / 2) deck.position.z += sp;
  const cover = clamp(k * 1.25, 0, 1) * deckFade;
  for (const heap of deck.children) tintCloud(heap, flashing, cover, 0.75 * chaseBlend);
  // heavy rain all round the camera (it starts with the cover and is full well before the lightning)
  const rain = tempestSky.rain;
  rain.position.set(camera.position.x, 0, camera.position.z);
  const u = tempestSky.rainMat.uniforms;
  u.time.value = clock.t;
  u.height.value = h;
  u.fall.value = 460 + 240 * chaseBlend;
  u.dropLength.value = 1.4 + 0.8 * chaseBlend;
  u.slant.value.set(game.wind.x || 0, game.wind.y || 0).multiplyScalar(0.02);
  u.intensity.value = clamp(k * 1.6, 0, 1);
  u.opacity.value = night.applied ? 0.14 : 0.22;
}

// Fair-weather clouds scattered high over the whole sea, drifting with the
// wind. Shown only from down at sea level (the chase view); from above they
// would hide the map.
const SKY_CLOUDS = 22;
const SKY_CLOUD_HEIGHT = [620, 900];
const SKY_CLOUD_SPAN = 2.2; // spread over this many map widths, so some sit near the horizon
const FAIR_BASE = new THREE.Color(0xa9b3be);
const skyClouds = [];
for (let i = 0; i < SKY_CLOUDS; i++) {
  const heap = cloudHeap(200 + Math.random() * 260, 0.3 + Math.random() * 0.4, 10 + Math.floor(Math.random() * 8), FAIR_BASE);
  heap.position.set(
    (Math.random() - 0.5) * WORLD_W * SKY_CLOUD_SPAN,
    SKY_CLOUD_HEIGHT[0] + Math.random() * (SKY_CLOUD_HEIGHT[1] - SKY_CLOUD_HEIGHT[0]),
    (Math.random() - 0.5) * WORLD_H * SKY_CLOUD_SPAN
  );
  heap.userData.pace = 0.5 + Math.random() * 0.7; // share of the wind speed it drifts at
  heap.visible = false;
  scene.add(heap);
  skyClouds.push(heap);
}

function updateSkyClouds(dt) {
  const chaseBlend = (sky.cloudHeight - CLOUD_HEIGHT_OVERVIEW) / (CLOUD_HEIGHT_CHASE - CLOUD_HEIGHT_OVERVIEW);
  const spanX = WORLD_W * SKY_CLOUD_SPAN;
  const spanZ = WORLD_H * SKY_CLOUD_SPAN;
  for (const heap of skyClouds) {
    heap.visible = chaseBlend > 0.05;
    if (!heap.visible) continue;
    heap.position.x += (game.wind.x || 0) * heap.userData.pace * dt;
    heap.position.z += (game.wind.y || 0) * heap.userData.pace * dt;
    // Off one side of the sky, back in on the other.
    if (heap.position.x > spanX / 2) heap.position.x -= spanX;
    if (heap.position.x < -spanX / 2) heap.position.x += spanX;
    if (heap.position.z > spanZ / 2) heap.position.z -= spanZ;
    if (heap.position.z < -spanZ / 2) heap.position.z += spanZ;
    tintCloud(heap, false, chaseBlend);
  }
}

// ---------------------------------------------------------------------------
// Seagulls: friendly birds over the sea. Most just glide and flap in wide
// circles; the "fishers" now and then fold their wings, dive at the water,
// and climb away again, usually with a fish in their beak.
// ---------------------------------------------------------------------------
const GULLS = 16;
const GULL_FISHERS = 6;
const GULL_SPAN = 1.15; // roam this far (in map halves) before turning back
const gullBodyMat = shared(mat(0xf4f4f0, { roughness: 0.9 }));
const gullWingMat = shared(mat(0xe6e8ea, { roughness: 0.9, side: THREE.DoubleSide }));
const gullTipMat = shared(mat(0x55595e, { roughness: 0.9, side: THREE.DoubleSide }));
const gullBeakMat = shared(mat(0xf0a020, { roughness: 0.6 }));
const gullFishMat = shared(mat(0xc4d2dc, { roughness: 0.3, metalness: 0.4 }));
function gullWingGeometry(tip) {
  const pts = tip ? [[-1.4, 3.6], [-0.6, 3.6], [-1.9, 5.2]] : [[0.8, 0], [-0.8, 0], [-1.4, 3.6], [-0.6, 3.6]];
  const verts = [];
  for (const [x, z] of pts) verts.push(x, 0, z);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(tip ? [0, 2, 1] : [0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}
const gullWingGeo = gullWingGeometry(false);
const gullTipGeo = gullWingGeometry(true);
const gullBodyGeo = new THREE.SphereGeometry(1, 10, 8);
const gullBeakGeo = new THREE.ConeGeometry(0.22, 0.9, 6);
const gullFlock = new THREE.Group();
scene.add(gullFlock);
const gulls = [];

function gullWing(side) {
  const wing = new THREE.Group();
  wing.add(mesh(gullWingGeo, gullWingMat, false), mesh(gullTipGeo, gullTipMat, false));
  wing.scale.z = side;
  return wing;
}

function createGull(fisher) {
  const root = new THREE.Group();
  const body = mesh(gullBodyGeo, gullBodyMat, false);
  body.scale.set(1.5, 0.6, 0.6);
  const head = mesh(gullBodyGeo, gullBodyMat, false);
  head.scale.set(0.5, 0.45, 0.45);
  head.position.set(1.5, 0.35, 0);
  const beak = mesh(gullBeakGeo, gullBeakMat, false);
  beak.rotation.z = -Math.PI / 2;
  beak.position.set(2.1, 0.3, 0);
  const tail = mesh(gullBeakGeo, gullBodyMat, false);
  tail.scale.set(2, 1, 1);
  tail.rotation.z = Math.PI / 2;
  tail.position.set(-1.9, 0.05, 0);
  const fish = mesh(gullBodyGeo, gullFishMat, false);
  fish.scale.set(0.75, 0.2, 0.2);
  fish.position.set(2.1, -0.1, 0);
  fish.visible = false;
  const wingL = gullWing(-1);
  const wingR = gullWing(1);
  wingL.position.z = -0.3;
  wingR.position.z = 0.3;
  root.add(body, head, beak, tail, fish, wingL, wingR);
  gullFlock.add(root);
  const heading = Math.random() * Math.PI * 2;
  const alt = fisher ? 45 + Math.random() * 25 : 70 + Math.random() * 90;
  return {
    root, wingL, wingR, fish, fisher,
    x: (Math.random() - 0.5) * WORLD_W * 1.6,
    z: (Math.random() - 0.5) * WORLD_H * 1.6,
    h: heading,
    turn: (Math.random() < 0.5 ? -1 : 1) * (0.12 + Math.random() * 0.12), // rad/s: circle radius = speed / turn
    speed: 22 + Math.random() * 10,
    alt, y: alt,
    phase: Math.random() * 10,
    flapRate: 5 + Math.random() * 2,
    mode: "fly", t: 0, next: 4 + Math.random() * 12, pitch: 0, catch: false, y0: 0
  };
}
for (let i = 0; i < GULLS; i++) gulls.push(createGull(i < GULL_FISHERS));

// Bats: out at night instead of the gulls. Small, dark, quick, with fast wingbeats and the darting, turning
// flight of a bat hunting insects over the water.
const BATS = 12;
const batMat = shared(mat(0x16161b, { roughness: 0.9, side: THREE.DoubleSide }));
const batFlock = new THREE.Group();
batFlock.visible = false;
scene.add(batFlock);
const bats = [];
for (let i = 0; i < BATS; i++) {
  const root = new THREE.Group();
  const body = mesh(gullBodyGeo, batMat, false);
  body.scale.set(0.8, 0.3, 0.3);
  const head = mesh(gullBodyGeo, batMat, false);
  head.scale.set(0.3, 0.26, 0.26);
  head.position.set(0.8, 0.1, 0);
  const wings = [-1, 1].map((side) => {
    const w = new THREE.Group();
    w.add(mesh(gullWingGeo, batMat, false));
    w.scale.set(0.8, 1, side * 0.9); // short, broad membrane wings
    w.position.z = side * 0.15;
    return w;
  });
  root.add(body, head, wings[0], wings[1]);
  batFlock.add(root);
  bats.push({
    root, wings,
    x: (Math.random() - 0.5) * WORLD_W * 1.4,
    z: (Math.random() - 0.5) * WORLD_H * 1.4,
    h: Math.random() * Math.PI * 2,
    y: 20 + Math.random() * 40,
    speed: 16 + Math.random() * 8,
    phase: Math.random() * 20
  });
}

function updateBats(dt) {
  const t = clock.t;
  for (const b of bats) {
    // darting: the heading jinks about, and it dives and climbs after insects
    b.h += (Math.sin(t * 1.9 + b.phase) + Math.sin(t * 3.7 + b.phase * 2.3)) * 0.9 * dt;
    if (Math.abs(b.x) > HALF_W * 1.1 || Math.abs(b.z) > HALF_H * 1.1) {
      const want = Math.atan2(-b.z, -b.x);
      b.h += Math.atan2(Math.sin(want - b.h), Math.cos(want - b.h)) * Math.min(1, 1.5 * dt);
    }
    b.x += Math.cos(b.h) * b.speed * dt;
    b.z += Math.sin(b.h) * b.speed * dt;
    const sea = seaHeight(b.x, b.z);
    const wantY = sea + 18 + 14 * (0.5 + 0.5 * Math.sin(t * 0.8 + b.phase)) + 5 * Math.sin(t * 2.6 + b.phase * 1.7);
    b.y += (wantY - b.y) * Math.min(1, dt * 1.5);
    b.root.position.set(b.x, b.y, b.z);
    b.root.rotation.set(0, -b.h, 0);
    b.root.rotateX(Math.sin(t * 1.9 + b.phase) * 0.5); // banks into the jinks
    const flap = Math.sin(t * 22 + b.phase) * 0.9; // fast wingbeat
    b.wings[0].rotation.x = flap;
    b.wings[1].rotation.x = -flap;
  }
}

function updateGulls(dt) {
  // Gulls roost at night; bats take the sky instead.
  gullFlock.visible = !night.on;
  batFlock.visible = night.on;
  if (night.on) updateBats(dt);
  if (night.on) return;
  const t = clock.t;
  for (const g of gulls) {
    g.t += dt;
    const sea = seaHeight(g.x, g.z);
    let flap = Math.sin(t * g.flapRate + g.phase);
    let spread = 0.45;
    if (g.mode === "fly") {
      // Out past the edge of the map: bend the circle back towards the middle.
      const out = Math.abs(g.x) > HALF_W * GULL_SPAN || Math.abs(g.z) > HALF_H * GULL_SPAN;
      if (out) {
        const want = Math.atan2(-g.z, -g.x);
        const diff = Math.atan2(Math.sin(want - g.h), Math.cos(want - g.h));
        g.h += Math.sign(diff) * Math.min(Math.abs(diff), 0.5 * dt);
      } else g.h += g.turn * dt;
      const target = sea + g.alt + Math.sin(t * 0.3 + g.phase) * 8;
      g.y += (target - g.y) * Math.min(1, dt * 0.8);
      // Mostly gliding, with bursts of flapping.
      const glide = Math.sin(t * 0.25 + g.phase * 2) > 0.2;
      if (glide) { flap *= 0.12; spread = 0.12; }
      g.pitch = 0;
      if (g.fisher && g.t > g.next) { g.mode = "dive"; g.t = 0; g.catch = Math.random() < 0.7; g.y0 = g.y; }
    } else if (g.mode === "dive") {
      const k = Math.min(1, g.t / 1.7);
      const ease = k * k;
      const top = sea + 0.8;
      const was = g.y;
      g.y = g.y0 + (top - g.y0) * ease;
      g.pitch = Math.atan2(g.y - was, g.speed * 1.6 * dt + 1e-3);
      flap = 0; spread = 0.9; // wings swept back
      if (k >= 1) {
        g.mode = "climb"; g.t = 0;
        g.fish.visible = g.catch;
        for (let i = 0; i < 4; i++) puffSteam(g.x + (Math.random() - 0.5) * 6, g.z + (Math.random() - 0.5) * 6, 0.35, 1);
      }
    } else {
      const k = Math.min(1, g.t / 2.2);
      const target = seaHeight(g.x, g.z) + g.alt;
      const was = g.y;
      g.y += (target - g.y) * Math.min(1, dt * (1 + 2 * k));
      g.pitch = Math.atan2(g.y - was, g.speed * dt + 1e-3);
      flap = Math.sin(t * g.flapRate * 1.8 + g.phase); spread = 0.7;
      if (k >= 1 && Math.abs(target - g.y) < 3) { g.mode = "fly"; g.t = 0; g.next = 10 + Math.random() * 14; }
    }
    const sp = g.mode === "dive" ? g.speed * 1.6 : g.speed;
    g.x += Math.cos(g.h) * sp * dt;
    g.z += Math.sin(g.h) * sp * dt;
    if (g.mode === "fly" && g.fish.visible && g.t > 6) g.fish.visible = false; // swallowed it
    g.root.position.set(g.x, g.y, g.z);
    g.root.rotation.set(0, -g.h, 0);
    g.root.rotateZ(g.pitch);
    g.root.rotateX(g.mode === "fly" ? -g.turn * 2.5 : 0); // lean into the turn
    g.wingR.rotation.x = -(flap * spread);
    g.wingL.rotation.x = flap * spread;
  }
}

const stormObjects = new Map();

function setReflectionHidden(hidden) {
  gullFlock.visible = !hidden;
  for (const o of stormObjects.values()) o.cloud.visible = !hidden;
  for (const heap of skyClouds) heap.visible = !hidden && sky.cloudHeight - CLOUD_HEIGHT_OVERVIEW > 12;
  for (const o of hazardObjects.values()) if (o.smokeGroup) {
    o.smokeGroup.visible = !hidden;
    o.bombGroup.visible = !hidden;
    o.column.visible = !hidden && o.columnOn;
  }
  steamGroup.visible = !hidden;
  starField.visible = !hidden;
  spout.cumulus.visible = !hidden && waterSpout.kind !== "strong";
  tempestSky.deck.visible = !hidden && tempest.intensity > 0.02;
  tempestSky.rain.visible = !hidden && tempest.intensity > 0.02;
  spout.funnel.visible = !hidden && waterSpout.state !== "forming";
  whirlThroat.material.visible = !hidden;
  whirlThroat.userData.veil.material.visible = !hidden;
  whirlFoam.material.visible = !hidden;
}

// Two tileable textures of churning water streaks (periodic value noise,
// stretched along the flow, which runs down and round the funnel wall):
// the wall's shading and a foam layer that slides over it.
function throatStreakTextures() {
  const N = 256;
  const hash = (i, j) => {
    const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const noise = (x, y, px, py) => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const h = (a, b) => hash(((a % px) + px) % px, ((b % py) + py) % py);
    return h(i, j) * (1 - ux) * (1 - uy) + h(i + 1, j) * ux * (1 - uy) + h(i, j + 1) * (1 - ux) * uy + h(i + 1, j + 1) * ux * uy;
  };
  const make = () => {
    const cv = document.createElement("canvas");
    cv.width = N;
    cv.height = N;
    return cv;
  };
  const wallCv = make();
  const foamCv = make();
  const wall = wallCv.getContext("2d").createImageData(N, N);
  const foam = foamCv.getContext("2d").createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      let n = 0;
      let amp = 0.55;
      let total = 0;
      for (let o = 0; o < 4; o++) {
        const f = 1 << o;
        // Sheared by one whole period so the streaks lean and still tile.
        n += amp * noise((u + v) * 20 * f, v * 3 * f, 20 * f, 3 * f);
        total += amp;
        amp *= 0.5;
      }
      n /= total;
      const k = (y * N + x) * 4;
      const l = Math.min(255, 255 * (0.4 + 0.45 * n + 0.5 * smoothstep(0.56, 0.78, n)));
      wall.data[k] = wall.data[k + 1] = wall.data[k + 2] = l;
      wall.data[k + 3] = 255;
      foam.data[k] = foam.data[k + 1] = foam.data[k + 2] = 255;
      foam.data[k + 3] = 255 * smoothstep(0.52, 0.8, n);
    }
  }
  wallCv.getContext("2d").putImageData(wall, 0, 0);
  foamCv.getContext("2d").putImageData(foam, 0, 0);
  return [wallCv, foamCv].map((cv) => {
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  });
}

// The whirlpool's throat: an open funnel of water pouring down into the
// dark, sitting in the hole the sea shader opens under it. The wall flares
// out to the rim like a real vortex, wobbles and wanders as it goes down, and
// its streaks run down and round; a foam layer slides over it faster.
const throatTime = { value: 0 };
const whirlThroat = (() => {
  const [wallTex, foamTex] = throatStreakTextures();
  wallTex.repeat.set(3, 1.5);
  foamTex.repeat.set(2, 1);
  const geo = new THREE.CylinderGeometry(1, 1, 1, 96, 40, true).translate(0, -0.5, 0);
  const p = geo.attributes.position;
  const col = new Float32Array(p.count * 4);
  const top = new THREE.Color(0xbfe6ea);
  const mid = new THREE.Color(0x1d6f7c);
  const deep = new THREE.Color(0x020c10);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const d = -p.getY(i); // 0 at the rim, 1 at the bottom
    const r = 0.05 + 0.95 * Math.pow(1 - d, 2.4);
    p.setXYZ(i, p.getX(i) * r, p.getY(i), p.getZ(i) * r);
    if (d < 0.3) c.copy(top).lerp(mid, d / 0.3);
    else c.copy(mid).lerp(deep, Math.min(1, (d - 0.3) / 0.5));
    col.set([c.r, c.g, c.b, 1 - smoothstep(0.05, 0.6, d)], i * 4);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 4));
  geo.computeVertexNormals();
  // The wall wobbles (lobes that turn with the water) and its lower end
  // wanders, so the throat is never a rigid circle.
  const wander = (mat) => {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.throatTime = throatTime;
      shader.vertexShader = "uniform float throatTime;\n" + shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n" +
          "float dd = -transformed.y;\n" +
          "float ang = atan( transformed.z, transformed.x );\n" +
          "transformed.xz *= 1.0 + min( dd * 4.0, 1.0 ) * ( 0.09 * sin( 3.0 * ang + throatTime * 2.3 + dd * 9.0 ) + 0.05 * sin( 5.0 * ang - throatTime * 3.1 + dd * 14.0 ) );\n" +
          "transformed.x += dd * dd * 0.3 * sin( throatTime * 0.7 );\n" +
          "transformed.z += dd * dd * 0.3 * cos( throatTime * 0.9 );"
      );
    };
  };
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, vertexColors: true, side: THREE.DoubleSide, roughness: 0.2, metalness: 0.1 });
  wander(wallMat);
  const m = new THREE.Mesh(geo, wallMat);
  const veilMat = new THREE.MeshStandardMaterial({
    map: foamTex,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    roughness: 0.4
  });
  wander(veilMat);
  const veil = new THREE.Mesh(geo, veilMat);
  veil.scale.set(0.985, 1, 0.985);
  m.add(veil);
  m.userData = { wallTex, foamTex, veil };
  m.visible = false;
  scene.add(m);
  return m;
})();

// Foam flecks drawn round and in by the current; how many are drawn follows
// the graphics quality (QUALITY_LEVELS foam).
const FOAM_FLECKS = 600;
const whirlFoam = (() => {
  const pos = new Float32Array(FOAM_FLECKS * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ map: dotTex, color: 0xf4fbff, size: 5, transparent: true, opacity: 0.9, depthWrite: false }));
  pts.frustumCulled = false;
  pts.visible = false;
  pts.userData.fleck = Array.from({ length: FOAM_FLECKS }, () => ({ a: Math.random() * Math.PI * 2, q: 0.2 + Math.random() * 0.95 }));
  scene.add(pts);
  return pts;
})();

function updateWhirlVisuals(dt) {
  const wp = whirlpool;
  const w = wp.state === "dormant" ? 0 : wp.strength;
  const cx = wp.x - HALF_W;
  const cz = wp.y - HALF_H;
  whirlThroat.visible = w > 0.05;
  if (whirlThroat.visible) {
    const rim = WHIRL_RIM * wp.r;
    whirlThroat.scale.set(rim, 40 + 60 * w, rim);
    whirlThroat.position.set(cx, seaHeight(cx + rim, cz) + 0.3, cz);
    whirlThroat.rotation.y -= wp.spin * dt * (1.5 + 3 * w);
    // The water pours down the wall; the foam slides faster and further round.
    const { wallTex, foamTex } = whirlThroat.userData;
    throatTime.value += dt * (0.5 + w);
    wallTex.offset.y += dt * (0.15 + 0.35 * w);
    foamTex.offset.y += dt * (0.3 + 0.6 * w);
    foamTex.offset.x -= wp.spin * dt * (0.05 + 0.15 * w);
  }
  whirlFoam.visible = w > 0.03;
  if (!whirlFoam.visible) return;
  whirlFoam.material.opacity = 0.9 * Math.min(1, w * 2);
  const pos = whirlFoam.geometry.attributes.position;
  const count = whirlFoam.geometry.drawRange.count === Infinity ? FOAM_FLECKS : whirlFoam.geometry.drawRange.count;
  for (let i = 0; i < count; i++) {
    const f = whirlFoam.userData.fleck[i];
    // Faster round and inward the nearer the middle, as in a real vortex.
    f.a += wp.spin * dt * (0.3 + 1.6 * w) / Math.max(f.q, 0.25);
    f.q -= dt * (0.02 + 0.06 * w) / Math.max(f.q, 0.4);
    if (f.q < WHIRL_RIM) {
      f.q = 0.95 + Math.random() * 0.2;
      f.a = Math.random() * Math.PI * 2;
    }
    const x = cx + Math.cos(f.a) * f.q * wp.r;
    const z = cz + Math.sin(f.a) * f.q * wp.r;
    pos.setXYZ(i, x, seaHeight(x, z) + 0.4, z);
  }
  pos.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Waterspouts. A condensation funnel hangs from the base of a big cloud: fair-weather spouts from a growing
// cumulus (a thin, pale rope), strong ones from the storm cell's own thunderhead (wide, grey and ragged).
// At the sea a spray vortex climbs round the foot of the funnel over a dark patch of disturbed water.
// ---------------------------------------------------------------------------
const SPRAY_N = 160;

const spoutFunnelVertex = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewDir;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewDir = cameraPosition - wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const spoutFunnelFragment = /* glsl */ `
uniform float time;
uniform float opacity;
uniform float light;
uniform vec3 color;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewDir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float y = vUv.y; // 0 at the sea, 1 at the cloud
  // noise round the funnel: swirling streaks that climb and turn
  float u = vUv.x;
  float n1 = noise(vec2(fract(u + time * 0.07) * 9.0, y * 6.0 - time * 0.9));
  float n2 = noise(vec2(fract(u - time * 0.11 + y * 0.3) * 21.0, y * 15.0 - time * 1.6));
  float n = 0.6 * n1 + 0.4 * n2;
  float facing = abs(dot(normalize(vNormalW), normalize(vViewDir)));
  float rim = pow(1.0 - facing, 1.4); // the edges are denser: more water along the line of sight
  // thin and ragged at the foot (broken by spray), full where it joins the cloud
  float profile = smoothstep(0.02, 0.38, y) * (0.3 + 0.7 * smoothstep(0.1, 0.95, y));
  float a = opacity * profile * (0.28 + 0.72 * rim) * (0.45 + 1.0 * n);
  vec3 c = color * light * mix(0.5, 1.0, n * 0.55 + rim * 0.45);
  gl_FragColor = vec4(c, clamp(a, 0.0, 1.0));
}`;

// The cumulus a fair-weather spout hangs from: a flat grey base under towers of white puffs.
const fairCumulusBase = FAIR_BASE.clone().multiplyScalar(0.78);
function fairCumulus() {
  const group = new THREE.Group();
  const heaps = [
    [cloudHeap(210, 0.16, 24, fairCumulusBase), 0, 0, 0],
    [cloudHeap(150, 1.3, 32, FAIR_BASE), 0, 60, 0],
    [cloudHeap(110, 1.5, 24, FAIR_BASE), 40, 140, -20],
    [cloudHeap(90, 1.2, 18, FAIR_BASE), -35, 120, 30],
    [cloudHeap(70, 1.4, 14, FAIR_BASE), 10, 215, 5]
  ];
  for (const [h, x, y, z] of heaps) {
    h.position.set(x, y, z);
    group.add(h);
  }
  group.userData.heaps = heaps.map((e) => e[0]);
  return group;
}

const spout = (() => {
  const root = new THREE.Group();
  const funnelGeo = new THREE.CylinderGeometry(1, 1, 1, 28, 28, true);
  // A thin, gently curved rope that flares into the cloud: narrow low down, wide at the top.
  const p = funnelGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) + 0.5; // 0 at the sea, 1 at the cloud
    const radius = 0.13 + 0.87 * Math.pow(y, 2.4);
    const bend = Math.sin(y * 3.1) * 0.2 + y * y * 0.3;
    p.setXYZ(i, p.getX(i) * radius + bend, y, p.getZ(i) * radius);
  }
  funnelGeo.computeVertexNormals();
  const funnelMat = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, opacity: { value: 0.8 }, light: { value: 1 }, color: { value: new THREE.Color(0xe8f0f5) } },
    vertexShader: spoutFunnelVertex,
    fragmentShader: spoutFunnelFragment,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const funnel = new THREE.Mesh(funnelGeo, funnelMat);
  funnel.frustumCulled = false;
  root.add(funnel);
  // the fair-weather cumulus (hidden for a strong spout, which uses the storm's own cloud)
  const cumulus = fairCumulus();
  root.add(cumulus);
  // spray: a ring of soft puffs climbing the foot of the funnel in a spiral
  const sprayPos = new Float32Array(SPRAY_N * 3);
  const sprayGeo = new THREE.BufferGeometry();
  sprayGeo.setAttribute("position", new THREE.BufferAttribute(sprayPos, 3));
  const sprayMat = new THREE.PointsMaterial({ map: dotTex, color: 0xf2f8fb, size: 16, sizeAttenuation: true, transparent: true, opacity: 0.55, depthWrite: false });
  const sprayPts = new THREE.Points(sprayGeo, sprayMat);
  sprayPts.frustumCulled = false;
  root.add(sprayPts);
  const sprayData = Array.from({ length: SPRAY_N }, () => ({ a: Math.random() * 6.283, q: 0.3 + Math.random() * 1.1, h: Math.random(), v: 0.08 + Math.random() * 0.14 }));
  // a dark, roughened patch of sea under the funnel
  const spot = flatDisc(1, 0x16303c, 0.4, 0.4);
  root.add(spot);
  const spray = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.18, 8, 36).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, roughness: 0.4 })
  );
  root.add(spray);
  const warnRing = flatRing(0.85, 1, 0xffcd5a, 0.6, 1);
  root.add(warnRing);
  root.visible = false;
  scene.add(root);
  return { root, funnel, funnelMat, cumulus, spray, spot, sprayPts, sprayData, sprayGeo, sprayMat, warnRing };
})();

const STRONG_SPOUT_COLOR = new THREE.Color(0x8d98a2);
const FAIR_SPOUT_COLOR = new THREE.Color(0xeaf1f6);

function updateSpout(dt) {
  const sp = waterSpout;
  spout.root.visible = sp.state !== "dormant";
  if (!spout.root.visible) return;
  const t = clock.t;
  const r = sp.r;
  const strong = sp.kind === "strong";
  toWorld(sp.x, sp.y, 0, spout.root.position);
  spout.root.position.y = seaHeight(spout.root.position.x, spout.root.position.z);
  const forming = sp.state === "forming";
  const warning = sp.state === "warning";
  const progress = warning ? 1 - sp.timer / WATER_SPOUT_WARN_TIME : forming ? 0 : 1;
  const fade = clamp((sp.lifeMax - sp.life) / 4, 0, 1); // the funnel and cloud thin out at the end

  // The funnel hangs from the cloud base overhead: a fair-weather spout from its own cumulus (grown while it forms),
  // a strong one from the storm cell's thunderhead.
  const height = sky.cloudHeight - 30;
  const grow = forming ? smoothstep(0, 1, 1 - sp.timer / sp.formTotal) : 1;
  spout.cumulus.visible = !strong;
  if (!strong) {
    spout.cumulus.position.y = height - spout.root.position.y;
    spout.cumulus.scale.set(0.35 + 0.65 * grow, 0.15 + 0.85 * grow, 0.35 + 0.65 * grow);
    spout.cumulus.rotation.y += dt * 0.05;
    for (const h of spout.cumulus.userData.heaps) tintCloud(h, false, Math.min(1, grow * 1.3) * fade, 0.25 * (1 - grow));
  }

  spout.warnRing.visible = warning;
  if (warning) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 14);
    spout.warnRing.scale.setScalar(r * (0.35 + 0.5 * progress));
    spout.warnRing.material.opacity = 0.35 + 0.4 * pulse;
  }

  // While warning the funnel reaches down out of the cloud base; once active it stands from the sea up into the cloud.
  const reach = forming ? 0 : warning ? 0.2 + 0.8 * progress : 1;
  const top = height - spout.root.position.y + 10;
  const width = strong ? r * 0.8 : r * 0.55;
  spout.funnel.visible = !forming;
  spout.funnel.scale.set(width, top * reach, width);
  spout.funnel.position.y = top * (1 - reach);
  spout.funnel.rotation.y += dt * (strong ? 3 : 2);
  spout.funnel.rotation.x = Math.sin(t * 0.6 + sp.x * 0.01) * 0.035; // it sways
  spout.funnel.rotation.z = Math.cos(t * 0.45) * 0.03;
  const u = spout.funnelMat.uniforms;
  u.time.value = t;
  u.opacity.value = (warning ? 0.3 + 0.5 * progress : strong ? 0.95 : 0.7) * fade;
  u.light.value = night.on ? 0.25 : 1;
  u.color.value.copy(strong ? STRONG_SPOUT_COLOR : FAIR_SPOUT_COLOR);

  // At the sea: spray spiralling up the foot, a dark patch, and a spray ring.
  const active = !warning && !forming;
  spout.sprayPts.visible = active;
  spout.spot.visible = active;
  spout.spray.visible = active;
  if (active) {
    const pos = spout.sprayGeo.attributes.position;
    const reachUp = r * (strong ? 3.2 : 1.8);
    for (let i = 0; i < SPRAY_N; i++) {
      const d = spout.sprayData[i];
      d.h += d.v * dt * (strong ? 1.4 : 1);
      d.a += dt * (1.2 + 2.4 * (1 - d.h)) * (strong ? 1.3 : 1);
      if (d.h > 1) {
        d.h = 0;
        d.a = Math.random() * 6.283;
        d.q = 0.3 + Math.random() * 1.1;
      }
      const rad = r * (strong ? 0.9 : 0.55) * d.q * (0.4 + 0.9 * (1 - d.h * 0.7));
      pos.setXYZ(i, Math.cos(d.a) * rad, 1.5 + d.h * reachUp, Math.sin(d.a) * rad);
    }
    pos.needsUpdate = true;
    spout.sprayMat.size = strong ? 24 : 15;
    spout.sprayMat.opacity = 0.55 * fade;
    spout.spot.scale.setScalar(r * (strong ? 1.8 : 1.2));
    spout.spot.material.opacity = 0.4 * fade;
    spout.spray.scale.setScalar(r * (0.75 + 0.1 * Math.sin(t * 9)) * (strong ? 1 : 0.7));
    spout.spray.position.y = 2 + Math.sin(t * 7) * 1.2;
  }
}

// The tsunami itself is part of the moving sea (seaAt / updateSea). Here
// only the red strip that flashes where it will come in during the warning.
const TSUNAMI_LENGTH = 6000;
const tsunamiWarning = (() => {
  const strip = new THREE.Mesh(
    new THREE.PlaneGeometry(22, TSUNAMI_LENGTH).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.5, depthWrite: false })
  );
  strip.visible = false;
  scene.add(strip);
  return strip;
})();

// Over land the water mesh is hidden under the ground, so the wave would seem to pop out of the coast. A wall of
// water is drawn over the land instead (only where there is land: the sea shows the real crest), moving with the
// crest and as tall as it, with a foam top.
const tsunamiWall = (() => {
  const geo = new THREE.PlaneGeometry(TSUNAMI_LENGTH, 1, 1, 1).translate(0, 0.5, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, leeCircles: { value: seaState.lee }, leeCount: { value: 0 }, opacity: { value: 0.9 } },
    vertexShader: `varying vec3 vW; varying vec2 vUv;
      void main() { vUv = uv; vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: `uniform float time; uniform vec4 leeCircles[40]; uniform int leeCount; uniform float opacity;
      varying vec3 vW; varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
      void main() {
        bool inland = false;
        for (int i = 0; i < 40; i++) {
          if (i >= leeCount) break;
          if (distance(vW.xz, leeCircles[i].xy) < leeCircles[i].z * 0.92) inland = true;
        }
        if (!inland) discard;
        float y = vUv.y;
        float streak = noise(vec2(vW.x * 0.02 + vW.z * 0.02, y * 5.0 - time * 2.0)) * 0.6 + noise(vec2(vW.x * 0.08 + vW.z * 0.08, y * 14.0 - time * 3.5)) * 0.4;
        vec3 deep = vec3(0.07, 0.30, 0.38);
        vec3 foam = vec3(0.92, 0.97, 1.0);
        float top = smoothstep(0.62, 1.0, y + (streak - 0.5) * 0.35);
        vec3 c = mix(deep, vec3(0.18, 0.5, 0.58), y * 0.8 + streak * 0.2);
        c = mix(c, foam, top);
        gl_FragColor = vec4(c, opacity * (0.7 + 0.3 * streak));
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const wall = new THREE.Mesh(geo, mat);
  wall.frustumCulled = false;
  wall.visible = false;
  scene.add(wall);
  return wall;
})();

function updateTsunami3d() {
  const ts = tsunami;
  // the wall of water over land follows the crest
  const s = seaState;
  tsunamiWall.visible = ts.state === "active" && s.tsuAmp > 0.5 && s.leeCount > 0;
  if (tsunamiWall.visible) {
    const dist = s.tsuFront - TSU_PEAK;
    tsunamiWall.position.set(s.tsuDir.x * dist, 0, s.tsuDir.y * dist);
    tsunamiWall.rotation.y = Math.atan2(s.tsuDir.x, s.tsuDir.y);
    tsunamiWall.scale.y = s.tsuAmp * 0.95 + 1;
    tsunamiWall.material.uniforms.time.value = clock.t;
    tsunamiWall.material.uniforms.leeCount.value = s.leeCount;
  }
  tsunamiWarning.visible = ts.state === "warning";
  if (!tsunamiWarning.visible) return;
  // On the line through the middle of the sea, just inside the front.
  const along = ts.front + 41 - (HALF_W * ts.dirX + HALF_H * ts.dirY);
  tsunamiWarning.position.set(ts.dirX * along, 2 + seaState.lift, ts.dirY * along);
  tsunamiWarning.rotation.y = -Math.atan2(ts.dirY, ts.dirX);
  tsunamiWarning.material.opacity = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(clock.t * 12));
}

// ---------------------------------------------------------------------------
// Creatures, submarines, missiles, boarding plank
// ---------------------------------------------------------------------------

const creatureMat = shared(mat(0x8e4fc0, { roughness: 0.35, metalness: 0.15 }));
const eyeMat = shared(mat(0xfff6c8, { emissive: 0xfff0a0, emissiveIntensity: 2.5 }));

function createCreature(c) {
  const root = new THREE.Group();
  const humps = [];
  for (let i = 0; i < 3; i++) {
    const hump = mesh(new THREE.TorusGeometry(7, 2.6 - i * 0.4, 10, 20, Math.PI), creatureMat);
    hump.position.x = 10 - i * 13;
    root.add(hump);
    humps.push(hump);
  }
  const head = mesh(new THREE.SphereGeometry(4.2, 16, 12), creatureMat);
  head.scale.set(1.5, 1, 1);
  head.position.set(22, 5, 0);
  root.add(head);
  for (const z of [-2.2, 2.2]) {
    const eye = mesh(new THREE.SphereGeometry(0.9, 8, 6), eyeMat, false);
    eye.position.set(26, 7, z);
    root.add(eye);
  }
  const tail = mesh(new THREE.ConeGeometry(2.4, 12, 8), creatureMat);
  tail.rotation.z = Math.PI / 2 + 0.5;
  tail.position.set(-32, 3, 0);
  root.add(tail);
  return { root, humps, head, seed: Math.random() * 10 };
}

function updateCreature(c, o) {
  const t = clock.t;
  toWorld(c.x, c.y, 0, o.root.position);
  o.root.position.y = seaHeight(o.root.position.x, o.root.position.z);
  o.root.rotation.y = -c.angle;
  o.humps.forEach((h, i) => {
    h.position.y = -2.5 + Math.sin(t * 5 + i * 1.4 + o.seed) * 2.2;
  });
  o.head.position.y = 5 + Math.sin(t * 5 + o.seed - 1.4) * 1.5;
}

const creatureObjects = new Map();

function createSub(e) {
  const root = new THREE.Group();
  const hullM = mat(e.color, { roughness: 0.45, metalness: 0.5 });
  const body = mesh(new THREE.CapsuleGeometry(5, 26, 6, 16), hullM);
  body.rotation.z = Math.PI / 2;
  root.add(body);
  root.add(box(7, 7, 3.6, hullM, 2, 5, 0));
  root.add(cylinder(0.4, 0.4, 7, mat(0x333a40, { metalness: 0.7, roughness: 0.3 }), 3, 11, 0, 6));
  if (e.kind === "uboat") {
    const gun = cylinder(0.5, 0.5, 6, mat(0x333a40, { metalness: 0.7 }), 12, 5.5, 0, 6);
    gun.rotation.z = Math.PI / 2;
    root.add(gun);
  }
  root.add(flatRing(e.radius + 10, e.radius + 12, 0xffffff, 0.16, 3));
  return { root, body, seed: Math.random() * 10 };
}

function updateSub(e, o) {
  toWorld(e.x, e.y, -2.2 + Math.sin(clock.t * 1.2 + o.seed) * 0.6, o.root.position);
  o.root.rotation.y = -e.angle;
}

const subObjects = new Map();

function createMissile(m) {
  const root = new THREE.Group();
  const color = new THREE.Color(m.color || (m.kind === "sonic" ? "#63e0ff" : "#ff7147"));
  if (m.kind === "laser") {
    // A unit-length beam along +X, stretched to the shot's length each frame.
    const glow = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthWrite: false });
    const outer = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 1, 10, 1, true), glow);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1, 8, 1, true), coreMat);
    outer.rotation.z = Math.PI / 2;
    core.rotation.z = Math.PI / 2;
    const beam = new THREE.Group();
    beam.add(outer, core);
    root.add(beam);
    return { root, beam, fade: [glow, coreMat] };
  }
  if (m.kind === "water") {
    const slug = new THREE.Mesh(
      new THREE.SphereGeometry(4, 10, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false })
    );
    slug.scale.set(2.2, 0.9, 0.9);
    root.add(slug);
    return { root };
  }
  if (m.kind === "bullet") {
    root.add(mesh(new THREE.BoxGeometry(7, 0.8, 0.8), mat(color, { emissive: color, emissiveIntensity: 4 }), false));
    return { root };
  }
  if (m.kind === "ball") {
    root.add(mesh(new THREE.SphereGeometry(3, 12, 8), mat(color, { metalness: 0.6, roughness: 0.4 }), false));
    return { root };
  }
  if (m.kind === "sonic") {
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(7, 16, 12),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    root.add(shell);
    const ring = mesh(new THREE.TorusGeometry(11, 0.9, 8, 32), mat(color, { emissive: color, emissiveIntensity: 3 }), false);
    ring.rotation.x = Math.PI / 2;
    root.add(ring);
    return { root, pulse: ring };
  }
  root.add(mesh(new THREE.SphereGeometry(2.6, 12, 8), mat(color, { emissive: color, emissiveIntensity: 3 }), false));
  const trail = new THREE.Mesh(
    new THREE.ConeGeometry(2.2, 16, 10, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  trail.rotation.z = Math.PI / 2; // tip points back along -X
  trail.position.x = -9;
  root.add(trail);
  return { root };
}

function updateMissile(m, o) {
  toWorld(m.x, m.y, 12, o.root.position);
  o.root.rotation.y = -Math.atan2(m.vy || 0, m.vx || 0.001);
  if (o.pulse) o.pulse.scale.setScalar(1 + 0.2 * Math.sin(clock.t * 18));
  // Rounds still waiting on deck stay hidden until they're fired.
  o.root.visible = !(m.delay > 0);
  if (o.beam) {
    o.beam.scale.x = Math.max(0.01, m.len);
    const a = Math.max(0, m.ttl / m.life);
    o.fade[0].opacity = 0.6 * a;
    o.fade[1].opacity = a;
  }
}

const missileObjects = new Map();

const plank = mesh(new THREE.BoxGeometry(1, 1.2, 5), mat(0x8b5a2b, { roughness: 0.9 }));
plank.visible = false;
scene.add(plank);

function updatePlank() {
  const ship = game.ai;
  const prey = game.player1;
  plank.visible = Boolean(
    mode === "single" && game.aiDirector && game.aiDirector.anchored && ship && !ship.capsized && prey && !prey.capsized
  );
  if (!plank.visible) return;
  const dx = prey.x - ship.x;
  const dy = prey.y - ship.y;
  toWorld((ship.x + prey.x) / 2, (ship.y + prey.y) / 2, 6, plank.position);
  plank.scale.x = Math.hypot(dx, dy);
  plank.rotation.y = -Math.atan2(dy, dx);
}

// Tow ropes and tankers' hoses: tubes rebuilt every frame along a curve.
const ropeMat = shared(mat(0xe8d9a8, { roughness: 0.9 }));
const hoseMats = { oil: shared(mat(0x161616, { roughness: 0.6 })), gas: shared(mat(0xc9ccd0, { roughness: 0.5 })) };
const lineMeshes = new Map();

function setLine(key, curve, radius, material, seen) {
  let m = lineMeshes.get(key);
  if (!m) {
    m = mesh(new THREE.BufferGeometry(), material);
    lineMeshes.set(key, m);
    scene.add(m);
  }
  m.geometry.dispose();
  m.geometry = new THREE.TubeGeometry(curve, 32, radius, 6);
  m.material = material;
  seen.add(key);
}

// A moored ship's four lines run from its deck to the quay bollards: bow
// line, stern line and two springs. They reach out one after another as they
// are made fast and are cast off in reverse; `ropes` (0..1) is how far along.
const chainMat = shared(mat(0x2a2d31, { roughness: 0.5, metalness: 0.7 }));
const mooringTmp = { a: new THREE.Vector3(), b: new THREE.Vector3() };

function mooringLines(ship, seen) {
  const { h, slot } = ship.berth;
  const s = bumpShape(ship);
  const len = s.h + s.r;
  const fwd = { x: Math.cos(ship.angle), y: Math.sin(ship.angle) };
  const side = slot === 0 ? { x: -h.sa, y: 0 } : { x: 0, y: -h.sb }; // towards the quay
  const along = slot === 0 ? (ship.y - h.corner.y) * h.sb : (ship.x - h.corner.x) * h.sa; // the ship's place along the quay
  // [where on the hull, where on the quay], as distances from midships.
  const lines = [[0.92 * len, 0.92 * len + 7], [-0.92 * len, -0.92 * len - 7], [0.7 * len, 0.25 * len], [-0.7 * len, -0.25 * len]];
  const bollardAt = (k) => {
    const b = BOLLARD_FIRST + BOLLARD_STEP * Math.round((k - BOLLARD_FIRST) / BOLLARD_STEP);
    return slot === 0 ? harbourPoint(h, 20.5, b) : harbourPoint(h, b, 20.5);
  };
  lines.forEach(([hullAt, quayAt], i) => {
    const f = clamp(ship.ropes * MOORING_LINES - i, 0, 1);
    if (f <= 0) return;
    const bol = bollardAt(along + quayAt);
    // The line is made fast at the deck edge on the quay side (found on the real model, so it never starts
    // inside the hull), not at a fixed point that the decks and lifeboats can hide.
    const o = shipObjects.get(ship);
    let a;
    if (o) {
      o.root.updateMatrixWorld(true);
      const zAxis = o.root.localToWorld(new THREE.Vector3(0, 0, 1)).sub(o.root.getWorldPosition(new THREE.Vector3()));
      const sign = zAxis.x * side.x + zAxis.z * side.y > 0 ? 1 : -1; // which local side faces the quay
      o.ropeDeckY = o.ropeDeckY || [];
      if (o.ropeDeckY[i] === undefined) o.ropeDeckY[i] = (shipSurfaceY(o, hullAt, sign * o.halfBeam * 0.75) ?? 4) + 0.4;
      a = o.root.localToWorld(mooringTmp.a.set(hullAt, o.ropeDeckY[i], sign * (o.halfBeam + 0.4)));
    } else {
      a = toWorld(ship.x + fwd.x * hullAt + side.x * s.r * 0.85, ship.y + fwd.y * hullAt + side.y * s.r * 0.85, 3.5, mooringTmp.a);
    }
    const b = toWorld(bol.x, bol.y, LAND_TOP + 0.8, mooringTmp.b);
    const end = a.clone().lerp(b, f);
    // Reaching out it hangs low; made fast it runs nearly straight.
    const mid = a.clone().lerp(end, 0.5);
    mid.y -= 0.3 + (1 - ship.ropes) * 0.8 + (f < 1 ? 1.2 : 0);
    setLine(`${ship.playerSlot}-moor${i}`, new THREE.QuadraticBezierCurve3(a.clone(), mid, end), 0.3, ropeMat, seen);
  });
  anchorChain(ship, seen);
}

// The anchor chain from the bow's hawse pipe down into the water.
function anchorChain(ship, seen) {
  if (!ship.anchored) return;
  const s = bumpShape(ship);
  const bow = s.h + s.r * 0.6;
  const x = ship.x + Math.cos(ship.angle) * bow;
  const y = ship.y + Math.sin(ship.angle) * bow;
  const a = toWorld(x, y, 3, new THREE.Vector3());
  const down = toWorld(x + Math.cos(ship.angle) * 7, y + Math.sin(ship.angle) * 7, -7, new THREE.Vector3());
  const mid = toWorld(x + Math.cos(ship.angle) * 2.5, y + Math.sin(ship.angle) * 2.5, 0.5, new THREE.Vector3());
  setLine(`${ship.playerSlot}-chain`, new THREE.QuadraticBezierCurve3(a, mid, down), 0.25, chainMat, seen);
}

function updateLines(dt) {
  const seen = new Set();
  const pumping = new Set();
  for (const ship of humanShips()) {
    const o = shipObjects.get(ship);
    if (!o) continue;
    const tow = ship.tow && shipObjects.get(ship.tow);
    if (tow) {
      // Taut it runs nearly straight; slack it sags into the water.
      const a = o.model.localToWorld(o.ropeAt.clone());
      const b = tow.model.localToWorld(tow.ropeAt.clone());
      const slack = Math.max(0, ship.towLength - Math.hypot(ship.tow.x - ship.x, ship.tow.y - ship.y));
      const mid = a.clone().lerp(b, 0.5);
      mid.y = Math.min(a.y, b.y) - 1 - slack * 0.6;
      setLine(`${ship.playerSlot}-tow`, new THREE.QuadraticBezierCurve3(a, mid, b), 0.35, ropeMat, seen);
    }
    if (ship.berth && ship.ropes > 0) mooringLines(ship, seen);
    else if (ship.anchored) anchorChain(ship, seen);
    const hose = pumpHose(ship);
    if (hose) {
      // From the riser on the quay down to the water, floating across the
      // basin, and up the ship's side to the manifold facing the quay.
      const q = toWorld(hose.quay.x, hose.quay.y, LAND_TOP + PUMP_RISER);
      const [mx, my, mz] = MANIFOLD[o.category];
      const port = o.model.localToWorld(new THREE.Vector3(mx, my, mz));
      const stbd = o.model.localToWorld(new THREE.Vector3(mx, my, -mz));
      const end = port.distanceToSquared(q) < stbd.distanceToSquared(q) ? port : stbd;
      const dir = end.clone().sub(q).setY(0).normalize();
      const float = (p) => p.setY(seaHeight(p.x, p.z) + 0.5);
      const q1 = float(q.clone().addScaledVector(dir, 6));
      const e1 = float(end.clone().addScaledVector(dir, -6));
      const m1 = float(q1.clone().lerp(e1, 0.5));
      setLine(`${ship.playerSlot}-hose`, new THREE.CatmullRomCurve3([q, q1, m1, e1, end]), 1.1, hoseMats[hose.kind], seen);
      pumping.add(hose.harbour.name + hose.kind);
    }
  }
  for (const [key, m] of lineMeshes) {
    if (seen.has(key)) continue;
    scene.remove(m);
    m.geometry.dispose();
    lineMeshes.delete(key);
  }
  for (const p of pumpFans) if (pumping.has(p.key)) p.fan.rotation.y += dt * 9;
}

// ---------------------------------------------------------------------------
// Harbours, map edge buoys, far-off islands
// ---------------------------------------------------------------------------

const lighthouseBeams = [];

// Lighthouse beam: light scattered in the air, so it is brightest along its
// core and near the lamp and melts away at its sides and far end (no hard
// cone outline). One material shared by both lighthouses.
const beamMaterial = new THREE.ShaderMaterial({
  uniforms: { opacity: { value: 0.07 }, color: { value: new THREE.Color(0xfff1c2) } },
  vertexShader: `
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
      vUv = uv;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vNormal = normalize(normalMatrix * normal);
      vView = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform float opacity;
    uniform vec3 color;
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
      // Facing the viewer = looking through the middle of the beam; grazing
      // = its edge, which fades to nothing.
      float core = pow(abs(dot(normalize(vNormal), normalize(vView))), 2.0);
      // uv.y is 1 at the lamp (apex) and 0 at the open end.
      float along = pow(clamp(vUv.y, 0.0, 1.0), 1.6);
      gl_FragColor = vec4(color, opacity * core * along);
    }`,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide
});

// ---- Harbours -------------------------------------------------------------
// The land comes from game.js (HARBOUR_LAYOUT / HARBOUR_LAND, capsules in
// each harbour's own frame a, b); what is drawn is exactly what is solid.
const LAND_TOP = 4; // quay and land height above the sea
const berthTwoMarkers = [];
const BOLLARD_FIRST = 30; // bollards along each quay face: first and spacing
const BOLLARD_STEP = 7;
const BERTH_LEN = 124; // the marked berths on the water: room for a 109 long carrier
const BERTH_WIDTH = 36;
const quayMat = shared(mat(0xa9a59c, { roughness: 0.9 }));
const apronMat = shared(mat(0xc4c0b6, { roughness: 0.85 }));
const darkMat = shared(mat(0x1d1f22, { roughness: 0.8 }));
const WALL_COLORS = [0xf1ece0, 0xe8d7b0, 0xd9a86c, 0xc9d6df, 0xe3c9c0, 0xf4f1ea];
const ROOF_COLORS = [0xa4452f, 0x8c3b2a, 0x6b4a3a, 0x4f5d6b];

// A capsule as a flat outline, raised into a block from `bottom` to `top`.
function capsuleBlock(p, bottom, top, materials) {
  const ax = p.ax - HALF_W;
  const ay = -(p.ay - HALF_H);
  const bx = p.bx - HALF_W;
  const by = -(p.by - HALF_H);
  const ang = Math.atan2(by - ay, bx - ax);
  const shape = new THREE.Shape();
  shape.absarc(ax, ay, p.r, ang + Math.PI / 2, ang + (Math.PI * 3) / 2, false);
  shape.absarc(bx, by, p.r, ang - Math.PI / 2, ang + Math.PI / 2, false);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: top - bottom, bevelEnabled: false, curveSegments: 24 });
  geo.rotateX(-Math.PI / 2); // outline (x, -z) lies flat, extrusion points up
  geo.translate(0, bottom, 0);
  return mesh(geo, materials);
}

// A box given by its span in the harbour's own frame (a0..a1, b0..b1).
function harbourBox(h, a0, a1, b0, b1, y, height, material) {
  const c = harbourPoint(h, (a0 + a1) / 2, (b0 + b1) / 2);
  return box(Math.abs(a1 - a0), height, Math.abs(b1 - b0), material, c.x - HALF_W, y, c.y - HALF_H);
}

// Inside the coast land (not the breakwaters), at least `margin` from its edge.
function onCoast(h, a, b, margin) {
  return HARBOUR_LAYOUT.some((p) => {
    if (p.kind !== "coast") return false;
    const dx = p.a2 - p.a1;
    const db = p.b2 - p.b1;
    const k = clamp(((a - p.a1) * dx + (b - p.b1) * db) / (dx * dx + db * db), 0, 1);
    return Math.hypot(a - (p.a1 + dx * k), b - (p.b1 + db * k)) < p.r - margin;
  });
}

// The oil and gas pumps on the first quay (PUMPS in game.js): a storage tank
// behind the quay road, the pump and its motor on the quay apron, and a
// riser at the quay edge where a tanker's hose is coupled. The motor's fan
// turns while a tanker is plugged in.
const PUMP_RISER = 7;
const pipeMat = shared(mat(0x8a949c, { roughness: 0.4, metalness: 0.6 }));
const pumpFans = [];

function harbourPumps(root, h) {
  for (const [kind, p] of Object.entries(PUMPS)) {
    const oil = kind === "oil";
    const body = mat(oil ? 0x3b3f44 : 0xe9edf0, { roughness: 0.5, metalness: 0.4 });
    const trim = mat(oil ? 0xe0a21e : 0x2f74b5, { roughness: 0.5 });
    const at = (a, b) => {
      const pt = harbourPoint(h, a, b);
      return toWorld(pt.x, pt.y, 0);
    };
    const tank = at(-30, p.b);
    if (oil) {
      root.add(cylinder(9, 9, 10, body, tank.x, LAND_TOP + 5, tank.z, 28));
      root.add(cylinder(9.1, 9.1, 1, trim, tank.x, LAND_TOP + 8.5, tank.z, 28));
    } else {
      const sphere = mesh(new THREE.SphereGeometry(7, 24, 16), body);
      sphere.position.set(tank.x, LAND_TOP + 11, tank.z);
      root.add(sphere);
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2;
        root.add(cylinder(0.4, 0.4, 9, trim, tank.x + Math.cos(ang) * 5.6, LAND_TOP + 4.5, tank.z + Math.sin(ang) * 5.6, 6));
      }
    }
    root.add(harbourBox(h, 7, 15, p.b - 3, p.b + 3, LAND_TOP + 0.6, 0.8, darkMat));
    root.add(harbourBox(h, 9, 13, p.b - 2.6, p.b - 0.2, LAND_TOP + 2.2, 2.6, trim));
    const motor = at(11, p.b + 1.5);
    root.add(cylinder(1.2, 1.2, 2.8, body, motor.x, LAND_TOP + 2.4, motor.z, 14));
    const fan = new THREE.Group();
    fan.add(box(2.2, 0.15, 0.4, pipeMat, 0, 0, 0));
    fan.add(box(0.4, 0.15, 2.2, pipeMat, 0, 0, 0));
    fan.position.set(motor.x, LAND_TOP + 3.9, motor.z);
    root.add(fan);
    pumpFans.push({ fan, key: h.name + kind });
    root.add(harbourBox(h, 15, PUMP_QUAY_A, p.b - 0.4, p.b + 0.4, LAND_TOP + 1.2, 0.8, pipeMat));
    const riser = at(PUMP_QUAY_A, p.b);
    root.add(cylinder(0.6, 0.6, PUMP_RISER, pipeMat, riser.x, LAND_TOP + PUMP_RISER / 2, riser.z, 8));
    root.add(cylinder(0.9, 0.9, 0.6, trim, riser.x, LAND_TOP + PUMP_RISER, riser.z, 10));
  }
}

// A small working boat tied up at a berth (the "moored" land pieces).
function mooredBoat(p, i) {
  const g = new THREE.Group();
  const len = Math.hypot(p.bx - p.ax, p.by - p.ay) + p.r * 2;
  const hullColor = [0x2c5f8a, 0xb23a2e, 0x2f6b45][i % 3];
  const beam = p.r * 2;
  const depth = beam * 0.32; // freeboard above the water
  g.add(mesh(hullGeometry(len * 0.96, beam * 0.92, depth), mat(hullColor, { roughness: 0.6 })));
  g.add(box(len * 0.3, depth * 0.9, beam * 0.6, mat(0xf2f2ee, { roughness: 0.6 }), -len * 0.15, depth * 1.05, 0));
  g.add(box(len * 0.31, depth * 0.25, beam * 0.62, mat(0x1a2b3c, { roughness: 0.2, metalness: 0.6 }), -len * 0.15, depth * 1.3, 0));
  g.add(cylinder(0.06, 0.06, beam, quayMat, -len * 0.15, depth * 1.5 + beam / 2, 0, 5));
  toWorld((p.ax + p.bx) / 2, (p.ay + p.by) / 2, 0.2, g.position);
  g.rotation.y = -Math.atan2(p.by - p.ay, p.bx - p.ax);
  return g;
}

// The lighthouse on the head of the first breakwater.
const LIGHTHOUSE_SCALE = 0.3;

function harbourLighthouse(root, at) {
  const islet = new THREE.Group();
  toWorld(at.x, at.y, LAND_TOP - 1, islet.position);
  islet.scale.setScalar(LIGHTHOUSE_SCALE); // modelled 160 m tall; real harbour lights are ~45 m
  const towerMat = mat(0xf3f1ea, { roughness: 0.5 });
  const red = mat(0xb8322a, { roughness: 0.5 });
  islet.add(cylinder(4.5, 7, 44, towerMat, 0, 22, 0, 18));
  islet.add(cylinder(6, 6.6, 6, red, 0, 12, 0, 18));
  islet.add(cylinder(5, 5.6, 6, red, 0, 28, 0, 18));
  islet.add(cylinder(6.5, 6.5, 1.2, mat(0x222222), 0, 44.5, 0, 18));
  const lamp = mesh(new THREE.SphereGeometry(3.4, 16, 10), mat(0xfff2b0, { emissive: 0xffe08a, emissiveIntensity: 5 }), false);
  lamp.position.y = 47.5;
  islet.add(lamp);
  fogLights.lamps.push(new THREE.Vector3(islet.position.x, islet.position.y + 47.5 * LIGHTHOUSE_SCALE, islet.position.z));
  const roof = mesh(new THREE.ConeGeometry(5.6, 6, 18), red);
  roof.position.y = 53;
  islet.add(roof);
  const beam = new THREE.Group();
  beam.position.y = 47.5;
  beam.scale.setScalar(1 / LIGHTHOUSE_SCALE); // the beam keeps its full reach
  const beamCone = new THREE.Mesh(new THREE.ConeGeometry(14, 170, 32, 1, true), beamMaterial);
  beamCone.rotation.z = -Math.PI / 2;
  beamCone.position.x = -85; // apex at the lamp, opening outward
  beam.add(beamCone);
  islet.add(beam);
  lighthouseBeams.push(beam);
  root.add(islet);
}

// The green light on the other breakwater head, marking the entrance.
function entranceLight(root, at) {
  const g = new THREE.Group();
  toWorld(at.x, at.y, LAND_TOP, g.position);
  g.scale.setScalar(0.4); // real size, about 12 m tall
  g.add(cylinder(1.6, 2, 9, mat(0xf3f1ea, { roughness: 0.5 }), 0, 4.5, 0, 10));
  g.add(cylinder(1.7, 1.7, 3, mat(0x2f8f4a, { roughness: 0.5 }), 0, 7.5, 0, 10));
  g.add(mesh(new THREE.SphereGeometry(1.2, 10, 8), mat(0x9dffb4, { emissive: 0x4dff7a, emissiveIntensity: 4 }), false).translateY(10));
  root.add(g);
}

// Roads in each harbour's own frame: [a0, a1, b0, b1] strips of asphalt. A
// road behind each quay, an inland ring road and cross streets between them.
// Real size: 1 game unit is about 3 m (a 250 m cruise liner is 82 units), so
// a two-lane street is ROAD_WIDTH (about 10 m) wide around these centre lines.
const ROAD_WIDTH = 3.4;
const HARBOUR_ROADS = [
  [-14, -4, -14, BASIN + 10], [-14, BASIN + 10, -14, -4], // quay roads
  [-96, -86, -96, 250], [-96, 250, -96, -86], // inland ring
  [-96, -4, 235, 245], [235, 245, -96, -4], // outer cross streets
  [-96, -4, 115, 125], [115, 125, -96, -4] // inner cross streets
].map(([a0, a1, b0, b1]) => {
  // Narrow each strip across its width, keeping its centre line.
  if (a1 - a0 < b1 - b0) return [(a0 + a1) / 2 - ROAD_WIDTH / 2, (a0 + a1) / 2 + ROAD_WIDTH / 2, b0, b1];
  return [a0, a1, (b0 + b1) / 2 - ROAD_WIDTH / 2, (b0 + b1) / 2 + ROAD_WIDTH / 2];
});
// Car loops along the road centre lines (cars keep to the right of them).
const CAR_LOOPS = [
  [[-9, -9], [-9, 240], [-91, 240], [-91, -91], [240, -91], [240, -9]],
  [[-9, -9], [-9, 120], [-91, 120], [-91, -91], [120, -91], [120, -9]]
];
const CAR_SPEED = 4.6; // units/s (about 50 km/h)
const CAR_LANE = 0.85; // from the centre line to the middle of the lane
const CAR_SCALE = 0.34; // the car model below at real size (about 4.5 m long)
const carSize = new THREE.Vector3(CAR_SCALE, CAR_SCALE, CAR_SCALE);
const CAR_COLORS = [0xc0392b, 0x2e5d9a, 0xe8e8e8, 0x2b2b2b, 0x8a8f96, 0xd4a017, 0x2f6b45];

function onRoad(a, b, margin) {
  return HARBOUR_ROADS.some(([a0, a1, b0, b1]) => a > a0 - margin && a < a1 + margin && b > b0 - margin && b < b1 + margin);
}

// Window pattern for house walls: the colour map (glass in the walls) and
// the glow map (which panes are lit at night). Two lit patterns, so not every
// lit house has the same windows on.
function windowTextures() {
  const make = (draw) => {
    const cv = document.createElement("canvas");
    cv.width = 64;
    cv.height = 64;
    const c = cv.getContext("2d");
    draw(c);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };
  const panes = [];
  for (const y of [14, 38]) for (const x of [8, 26, 44]) panes.push([x, y]);
  const wall = make((c) => {
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, 64, 64);
    c.fillStyle = "#3b4a58";
    for (const [x, y] of panes) c.fillRect(x, y, 12, 14);
  });
  const lit = (on) => make((c) => {
    c.fillStyle = "#000000";
    c.fillRect(0, 0, 64, 64);
    c.fillStyle = "#ffcf7a";
    panes.forEach(([x, y], i) => {
      if (on.includes(i)) c.fillRect(x, y, 12, 14);
    });
  });
  return { wall, glowA: lit([0, 2, 4]), glowB: lit([1, 3, 5, 0]) };
}

// Everything in the harbours that lights up at night: [material, intensity].
const harbourNightLights = [];
// Cars driving the harbour roads; moved every frame (updateHarbourCars).
const harbourCars = [];
// Night light pools on the ground (street lamps, lit windows): top quality only.
const harbourGlows = [];
const glowTex = (() => {
  const cv = document.createElement("canvas");
  cv.width = 64;
  cv.height = 64;
  const c = cv.getContext("2d");
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
})();

// Soft round pools of warm light lying on the ground at the given spots
// ({ x, y, r } in map units), as one instanced mesh.
function lightPools(root, spots, opacity) {
  const im = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: glowSoft, color: 0xffc97a, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
    spots.length
  );
  const m = new THREE.Matrix4();
  spots.forEach((sp, i) => im.setMatrixAt(i, m.makeScale(sp.r, 1, sp.r).setPosition(sp.x - HALF_W, LAND_TOP + 0.3, sp.y - HALF_H)));
  im.visible = false;
  harbourGlows.push(im);
  root.add(im);
}

function harbourRoads(root, h, seedStart) {
  let seed = seedStart;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const asphalt = mat(0x34373b, { roughness: 0.95 });
  for (const [a0, a1, b0, b1] of HARBOUR_ROADS) root.add(harbourBox(h, a0, a1, b0, b1, LAND_TOP + 0.1, 0.2, asphalt));

  // Dashed centre lines and street lamps along each road.
  const dashes = [];
  const lamps = [];
  for (const [a0, a1, b0, b1] of HARBOUR_ROADS) {
    const alongA = a1 - a0 > b1 - b0;
    const from = alongA ? a0 : b0;
    const to = alongA ? a1 : b1;
    const mid = alongA ? (b0 + b1) / 2 : (a0 + a1) / 2;
    for (let u = from + 2; u < to - 2; u += 3) dashes.push(alongA ? [u, mid, true] : [mid, u, false]);
    for (let u = from + 8; u < to - 4; u += 14) lamps.push(alongA ? [u, b1 + 0.6] : [a1 + 0.6, u]);
  }
  const m = new THREE.Matrix4();
  const dashMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.05, 1), mat(0xeeeeee, { roughness: 0.6 }), dashes.length);
  dashes.forEach(([a, b, alongA], i) => {
    const p = harbourPoint(h, a, b);
    m.makeScale(alongA ? 1.3 : 0.12, 1, alongA ? 0.12 : 1.3).setPosition(p.x - HALF_W, LAND_TOP + 0.23, p.y - HALF_H);
    dashMesh.setMatrixAt(i, m);
  });
  root.add(dashMesh);
  const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.09, 3, 6), darkMat, lamps.length);
  const headMat = mat(0x6b6b60, { emissive: 0xffd9a0, emissiveIntensity: 0 });
  harbourNightLights.push([headMat, 4]);
  const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.25, 8, 6), headMat, lamps.length);
  lamps.forEach(([a, b], i) => {
    const p = harbourPoint(h, a, b);
    posts.setMatrixAt(i, m.makeTranslation(p.x - HALF_W, LAND_TOP + 1.5, p.y - HALF_H));
    heads.setMatrixAt(i, m.makeTranslation(p.x - HALF_W, LAND_TOP + 3.1, p.y - HALF_H));
  });
  root.add(posts, heads);
  lightPools(root, lamps.map(([a, b]) => ({ ...harbourPoint(h, a, b), r: 4 })), 0.32);

  // Cars: a few on each loop, some driving the other way round.
  const cars = [];
  CAR_LOOPS.forEach((loop, li) => {
    const pts = loop.map(([a, b]) => harbourPoint(h, a, b));
    const n = li === 0 ? 7 : 5;
    for (let k = 0; k < n; k++) {
      const reverse = k % 2 === 1;
      cars.push({ pts: reverse ? [...pts].reverse() : pts, s: rnd() * 2000, speed: CAR_SPEED * (0.8 + rnd() * 0.4), color: CAR_COLORS[Math.floor(rnd() * CAR_COLORS.length)] });
    }
  });
  for (const car of cars) {
    car.lens = car.pts.map((p, i) => {
      const q = car.pts[(i + 1) % car.pts.length];
      return Math.hypot(q.x - p.x, q.y - p.y);
    });
    car.total = car.lens.reduce((x, y) => x + y, 0);
  }
  const n = cars.length;
  const body = new THREE.InstancedMesh(new THREE.BoxGeometry(4.4, 1.1, 2), mat(0xffffff, { roughness: 0.4, metalness: 0.4 }), n);
  const cabin = new THREE.InstancedMesh(new THREE.BoxGeometry(2.3, 0.9, 1.8), mat(0x1a2b3c, { roughness: 0.2, metalness: 0.6 }), n);
  const headMatCar = mat(0xfff4d6, { emissive: 0xfff1c8, emissiveIntensity: 3 });
  const tailMat = mat(0x550000, { emissive: 0xff2010, emissiveIntensity: 3 });
  const headlights = new THREE.InstancedMesh(new THREE.BoxGeometry(0.15, 0.3, 1.7), headMatCar, n);
  const taillights = new THREE.InstancedMesh(new THREE.BoxGeometry(0.15, 0.3, 1.7), tailMat, n);
  // A pool of headlight on the road ahead (a soft triangle).
  const beamShape = new THREE.Shape();
  beamShape.moveTo(0, -0.9);
  beamShape.lineTo(14, -4);
  beamShape.lineTo(14, 4);
  beamShape.lineTo(0, 0.9);
  const beams = new THREE.InstancedMesh(
    new THREE.ShapeGeometry(beamShape).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffe9b8, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }),
    n
  );
  const color = new THREE.Color();
  cars.forEach((car, i) => body.setColorAt(i, color.setHex(car.color)));
  body.castShadow = true;
  cabin.castShadow = true;
  for (const im of [headlights, taillights, beams]) im.visible = false;
  root.add(body, cabin, headlights, taillights, beams);
  harbourCars.push({ cars, body, cabin, headlights, taillights, beams });
}

const carTmp = { m: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(1, 1, 1), up: new THREE.Vector3(0, 1, 0), off: new THREE.Vector3() };

// Drives every car along its loop and switches the town's lights with the night.
function updateHarbourCars(dt) {
  for (const g of berthTwoMarkers) g.visible = mode === "local"; // one berth in a one-player game
  for (const [material, on] of harbourNightLights) material.emissiveIntensity = night.on ? on : 0;
  const glow = night.on && QUALITY_LEVELS[perf.level].townGlow;
  for (const im of harbourGlows) im.visible = glow;
  const { m, q, p, up } = carTmp;
  for (const fleet of harbourCars) {
    for (const im of [fleet.headlights, fleet.taillights, fleet.beams]) im.visible = night.on;
    fleet.cars.forEach((car, i) => {
      car.s = (car.s + car.speed * dt) % car.total;
      let d = car.s;
      let k = 0;
      while (d > car.lens[k]) {
        d -= car.lens[k];
        k++;
      }
      const a = car.pts[k];
      const b = car.pts[(k + 1) % car.pts.length];
      const dx = (b.x - a.x) / car.lens[k];
      const dy = (b.y - a.y) / car.lens[k];
      // Keep right: the lane is to the right of the direction of travel.
      const x = a.x + dx * d - dy * CAR_LANE;
      const y = a.y + dy * d + dx * CAR_LANE;
      q.setFromAxisAngle(up, -Math.atan2(dy, dx));
      // The car model is built at 3x real size: offsets and size scale by CAR_SCALE.
      const place = (im, along, height) => {
        toWorld(x + dx * along * CAR_SCALE, y + dy * along * CAR_SCALE, LAND_TOP + height * CAR_SCALE, p);
        im.setMatrixAt(i, m.compose(p, q, carSize));
      };
      place(fleet.body, 0, 0.85);
      place(fleet.cabin, -0.3, 1.85);
      place(fleet.headlights, 2.2, 0.9);
      place(fleet.taillights, -2.2, 0.9);
      place(fleet.beams, 2.3, 0.3);
    });
    for (const im of [fleet.body, fleet.cabin, fleet.headlights, fleet.taillights, fleet.beams]) im.instanceMatrix.needsUpdate = true;
  }
}

// Houses and trees on the land behind the quays, as instanced meshes (a
// handful of draw calls for the whole town). A fixed seed per harbour keeps
// the town the same every game.
let windowTex = null;

function harbourTown(root, h, seedStart) {
  let seed = seedStart;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const houses = [];
  const trees = [];
  const spots = [];
  // Real-size plots (about 30 m apart) for real-size houses (9-15 m).
  for (let a = -190; a <= 4; a += 10) for (let b = 34; b <= 380; b += 11) spots.push([a, b]);
  for (let b = -190; b <= 4; b += 10) for (let a = 34; a <= 380; a += 11) spots.push([a, b]);
  for (const [a0, b0] of spots) {
    const a = a0 + (rnd() - 0.5) * 3;
    const b = b0 + (rnd() - 0.5) * 3;
    // The warehouse and crane yard behind the second quay stays clear.
    if (a > 24 && a < 114 && b > -76) continue;
    // So does the pump yard on the first quay (harbourPumps).
    if (a > -48 && b > 58 && b < 116) continue;
    if (!onCoast(h, a, b, 5) || onRoad(a, b, 3)) continue;
    const p = harbourPoint(h, a, b);
    if (rnd() < 0.55) {
      // About half the houses have someone home at night (lights on).
      houses.push({ x: p.x, y: p.y, w: 3 + rnd() * 2, d: 2.7 + rnd() * 1.6, h: 2 + rnd() * 1.4, turn: rnd() < 0.5 ? 0 : Math.PI / 2, wall: Math.floor(rnd() * WALL_COLORS.length), roof: Math.floor(rnd() * ROOF_COLORS.length), lit: Math.floor(rnd() * 4) });
    } else {
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const ta = a + (rnd() - 0.5) * 7;
        const tb = b + (rnd() - 0.5) * 7;
        if (onRoad(ta, tb, 1)) continue;
        const q = harbourPoint(h, ta, tb);
        trees.push({ x: q.x, y: q.y, h: 3 + rnd() * 2.4, pine: rnd() < 0.5 });
      }
    }
  }
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const color = new THREE.Color();
  const place = (im, i, x, y, z, sx, sy, sz, turn) => {
    q.setFromAxisAngle(up, turn);
    im.setMatrixAt(i, m.compose(toWorld(x, y, z, pos), q, scl.set(sx, sy, sz)));
  };
  // Walls in three batches: dark at night, and two patterns of lit windows.
  if (!windowTex) windowTex = windowTextures();
  const wallMats = [
    mat(0xffffff, { roughness: 0.8, map: windowTex.wall }),
    mat(0xffffff, { roughness: 0.8, map: windowTex.wall, emissive: 0xffffff, emissiveMap: windowTex.glowA, emissiveIntensity: 0 }),
    mat(0xffffff, { roughness: 0.8, map: windowTex.wall, emissive: 0xffffff, emissiveMap: windowTex.glowB, emissiveIntensity: 0 })
  ];
  harbourNightLights.push([wallMats[1], 1.6], [wallMats[2], 1.6]);
  const groups = [0, 1, 2].map((g) => houses.filter((hs) => (hs.lit < 2 ? 0 : hs.lit - 1) === g));
  const wallSets = groups.map((list, g) => {
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), wallMats[g], list.length);
    list.forEach((hs, i) => {
      place(im, i, hs.x, hs.y, LAND_TOP + hs.h / 2, hs.w, hs.h, hs.d, hs.turn);
      im.setColorAt(i, color.setHex(WALL_COLORS[hs.wall]));
    });
    return im;
  });
  // Lamplight spilling out of the lit houses' windows onto the ground.
  lightPools(root, houses.filter((hs) => hs.lit >= 2).map((hs) => ({ x: hs.x, y: hs.y, r: Math.max(hs.w, hs.d) * 1.1 })), 0.16);
  const roofs = new THREE.InstancedMesh(new THREE.CylinderGeometry(0, 0.75, 1, 4).rotateY(Math.PI / 4), mat(0xffffff, { roughness: 0.75, flatShading: true }), houses.length);
  houses.forEach((hs, i) => {
    place(roofs, i, hs.x, hs.y, LAND_TOP + hs.h + 0.8, hs.w * 1.42, 1.6, hs.d * 1.42, hs.turn);
    roofs.setColorAt(i, color.setHex(ROOF_COLORS[hs.roof]));
  });
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.35, 0.5, 1, 6), trunkMat, trees.length);
  const pines = trees.filter((t) => t.pine);
  const rounds = trees.filter((t) => !t.pine);
  const pineCrowns = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 7), pineMat, pines.length);
  const roundCrowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), mat(0x4f8f3a, { roughness: 0.85, flatShading: true }), rounds.length);
  trees.forEach((t, i) => place(trunks, i, t.x, t.y, LAND_TOP + t.h * 0.2, 0.4, t.h * 0.4, 0.4, 0));
  pines.forEach((t, i) => place(pineCrowns, i, t.x, t.y, LAND_TOP + t.h * 0.6, t.h * 0.3, t.h * 0.8, t.h * 0.3, 0));
  rounds.forEach((t, i) => place(roundCrowns, i, t.x, t.y, LAND_TOP + t.h * 0.62, t.h * 0.33, t.h * 0.3, t.h * 0.33, i));
  // On a polar run the roofs are under snow: a white roof over each one.
  const snowRoofs = new THREE.InstancedMesh(roofs.geometry, mat(0xf4f8fb, { roughness: 0.7, flatShading: true }), houses.length);
  houses.forEach((hs, i) => place(snowRoofs, i, hs.x, hs.y, LAND_TOP + hs.h + 0.86, hs.w * 1.46, 1.65, hs.d * 1.46, hs.turn));
  snowRoofs.visible = false;
  polarOnly.push(snowRoofs);
  polarHidden.push(roundCrowns);
  for (const im of [...wallSets, roofs, snowRoofs, trunks, pineCrowns, roundCrowns]) {
    im.castShadow = true;
    im.receiveShadow = true;
    root.add(im);
  }
}

// A harbour is built from ~130 small parts (bollards, fenders, quay slabs,
// crane, moored boats...). Each is a separate draw call, drawn twice a frame
// (once more for the sea's reflection), which is what holds a budget phone
// back. Parts that never move or change are merged into one mesh per
// material: the picture is the same, with far fewer draw calls. Left as they
// are: anything animated or switched later (keep), see-through parts (drawn
// in order) and parts with several materials.
function mergeStaticMeshes(root, keep) {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map();
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || !o.visible || Array.isArray(o.material) || o.material.transparent) return;
    for (let a = o; a && a !== root; a = a.parent) if (keep.has(a)) return;
    const attrs = Object.keys(o.geometry.attributes).sort().join(",");
    const key = `${o.material.uuid}|${o.castShadow}|${o.receiveShadow}|${attrs}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  });
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const parts = list.map((o) => {
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      return g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toRoot, o.matrixWorld));
    });
    const merged = new THREE.BufferGeometry();
    for (const name of Object.keys(parts[0].attributes)) {
      const size = parts[0].attributes[name].itemSize;
      const data = new Float32Array(parts.reduce((n, g) => n + g.attributes[name].array.length, 0));
      let at = 0;
      for (const g of parts) {
        data.set(g.attributes[name].array, at);
        at += g.attributes[name].array.length;
      }
      merged.setAttribute(name, new THREE.BufferAttribute(data, size));
    }
    for (const g of parts) g.dispose();
    const m = new THREE.Mesh(merged, list[0].material);
    m.castShadow = list[0].castShadow;
    m.receiveShadow = list[0].receiveShadow;
    for (const o of list) o.parent.remove(o);
    root.add(m);
  }
}

function buildHarbour(h, color, seed) {
  const root = new THREE.Group();
  const pieces = HARBOUR_LAND.filter((p) => p.harbour === h);
  for (const p of pieces) {
    if (p.kind === "coast") root.add(capsuleBlock(p, -3, LAND_TOP, [grassMat, quayMat]));
    else if (p.kind === "mole") root.add(capsuleBlock(p, -3, LAND_TOP + 0.5, rockMat));
  }
  pieces.filter((p) => p.kind === "moored").forEach((p, i) => root.add(mooredBoat(p, i)));

  // Quays: a concrete apron along both quay faces, with bollards to tie up
  // to and black rubber fenders hung on the quay wall.
  root.add(harbourBox(h, 4, 22, 22, BASIN + 12, LAND_TOP + 0.15, 0.3, apronMat));
  root.add(harbourBox(h, 22, BASIN + 12, 4, 22, LAND_TOP + 0.15, 0.3, apronMat));
  for (let k = BOLLARD_FIRST; k <= BASIN - 4; k += BOLLARD_STEP) {
    for (const [a, b, fa, fb] of [[20.5, k, 22.2, k], [k, 20.5, k, 22.2]]) {
      const bp = harbourPoint(h, a, b);
      root.add(cylinder(0.22, 0.28, 0.5, darkMat, bp.x - HALF_W, LAND_TOP + 0.4, bp.y - HALF_H, 8));
      const fp = harbourPoint(h, fa, fb);
      root.add(box(0.5, 1, 0.4, darkMat, fp.x - HALF_W, LAND_TOP - 0.9, fp.y - HALF_H));
    }
  }
  // A walkway along the top of each breakwater.
  root.add(harbourBox(h, BASIN - 2.5, BASIN + 2.5, 22, MOLE_END, LAND_TOP + 0.6, 0.3, apronMat));
  root.add(harbourBox(h, 22, MOLE_END, BASIN - 2.5, BASIN + 2.5, LAND_TOP + 0.6, 0.3, apronMat));
  harbourLighthouse(root, harbourPoint(h, BASIN, MOLE_END));
  entranceLight(root, harbourPoint(h, MOLE_END, BASIN));

  // Cargo berth: a warehouse behind the second quay and a container crane
  // on the quay edge, its boom reaching out over the water.
  root.add(harbourBox(h, 32, 106, -72, -24, LAND_TOP + 7, 14, mat(0x7c8fa3, { roughness: 0.7, metalness: 0.2 })));
  root.add(harbourBox(h, 30, 108, -74, -22, LAND_TOP + 14.4, 0.8, mat(0x55606b, { roughness: 0.7 })));
  const craneMat = mat(0xd9a62b, { roughness: 0.6, metalness: 0.3 });
  for (const a of [70, 84]) {
    for (const b of [8, 20]) root.add(harbourBox(h, a - 0.8, a + 0.8, b - 0.8, b + 0.8, LAND_TOP + 13, 26, craneMat));
  }
  root.add(harbourBox(h, 69, 85, 6, 22, LAND_TOP + 26.5, 2, craneMat));
  root.add(harbourBox(h, 76, 78, -6, 62, LAND_TOP + 28, 1.6, craneMat)); // the boom
  root.add(harbourBox(h, 73, 81, 12, 18, LAND_TOP + 30, 3, mat(0x3b4148, { roughness: 0.6 })));

  harbourPumps(root, h);
  harbourRoads(root, h, seed + 1);
  harbourTown(root, h, seed);

  // The two berths, one along each quay: a ship that comes to rest in the
  // basin is eased into the nearer free one.
  for (const [slot, w, len] of [[0, BERTH_WIDTH, BERTH_LEN], [1, BERTH_LEN, BERTH_WIDTH]]) {
    const at = slot === 0 ? harbourPoint(h, 22 + BERTH_WIDTH / 2, BERTH_CENTRE) : harbourPoint(h, BERTH_CENTRE, 22 + BERTH_WIDTH / 2);
    const berth = new THREE.Group();
    toWorld(at.x, at.y, 0, berth.position);
    berth.add(onSea(new THREE.Mesh(new THREE.PlaneGeometry(w, len).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false })), 0.6));
    const edge = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false });
    for (const [ew, el, ex, ez] of [[w, 1, 0, len / 2], [w, 1, 0, -len / 2], [1, len, w / 2, 0], [1, len, -w / 2, 0]]) {
      const strip = onSea(new THREE.Mesh(new THREE.PlaneGeometry(ew, el).rotateX(-Math.PI / 2), edge), 0.7);
      strip.position.x = ex;
      strip.position.z = ez;
      berth.add(strip);
    }
    if (slot === 1) berthTwoMarkers.push(berth);
    root.add(berth);
  }
  const keep = new Set([...lighthouseBeams, ...pumpFans.map((p) => p.fan), ...harbourGlows, ...polarOnly, ...polarHidden]);
  mergeStaticMeshes(root, keep);
  scene.add(root);
}

// Map edge buoys: ~170 of them, each a post, a cone and a lamp. They are
// drawn as three instanced meshes (one draw call per part for all buoys,
// instead of three per buoy) and bob on the waves in updateBuoys.
const buoys = []; // { x, z, seed }
const buoyParts = []; // { im, y }: each part's height on the buoy
const buoyScale = new THREE.Vector3(2.2, 2.2, 2.2); // a navigation buoy as the pilot sees it: about 22 m up
const buoyTmp = { m: new THREE.Matrix4(), part: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), p: new THREE.Vector3(), one: new THREE.Vector3(1, 1, 1) };

function buildBuoys() {
  const step = 80;
  const spots = [];
  for (let x = 0; x <= WORLD_W; x += step) spots.push([x, 0], [x, WORLD_H]);
  for (let y = step; y < WORLD_H; y += step) spots.push([0, y], [WORLD_W, y]);
  spots.forEach(([x, y], i) => {
    if (landClearance(x, y) < 12) return;
    const at = toWorld(x, y, 0);
    buoys.push({ x: at.x, z: at.z, seed: i * 0.7, red: i % 2 === 1 });
  });
  const red = new THREE.Color(0xc8322a);
  const white = new THREE.Color(0xf0f0f0);
  const paint = mat(0xffffff, { roughness: 0.5 });
  const lampM = mat(0xffd27a, { emissive: 0xffc04a, emissiveIntensity: 7 });
  const parts = [
    // A large navigation buoy, drawn bigger than life (buoyScale) so it shows at sea.
    { geo: new THREE.CylinderGeometry(0.85, 1.2, 2.1, 10), material: paint, y: 0.35, shadow: true, color: (b) => (b.red ? red : white) },
    { geo: new THREE.ConeGeometry(0.85, 1.75, 10), material: paint, y: 2.3, shadow: true, color: (b) => (b.red ? white : red) },
    { geo: new THREE.SphereGeometry(0.5, 8, 6), material: lampM, y: 3.4, shadow: false }
  ];
  for (const part of parts) {
    const im = new THREE.InstancedMesh(part.geo, part.material, buoys.length);
    im.castShadow = part.shadow;
    im.receiveShadow = true;
    im.frustumCulled = false; // they ring the whole sea
    if (part.color) buoys.forEach((b, i) => im.setColorAt(i, part.color(b)));
    scene.add(im);
    buoyParts.push({ im, y: part.y });
  }
  updateBuoys();
}

function updateBuoys() {
  const { m, part, q, e, p, one } = buoyTmp;
  buoys.forEach((b, i) => {
    p.set(b.x, seaHeight(b.x, b.z), b.z);
    q.setFromEuler(e.set(0, 0, Math.sin(clock.t * 1.2 + b.seed) * 0.08));
    m.compose(p, q, buoyScale);
    for (const { im, y } of buoyParts) im.setMatrixAt(i, part.multiplyMatrices(m, part.makeTranslation(0, y, 0)));
  });
  for (const { im } of buoyParts) im.instanceMatrix.needsUpdate = true;
}

function buildDistantIslands() {
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + Math.random() * 0.4;
    const d = 3800 + Math.random() * 2800;
    const isl = islandModel(200 + Math.random() * 260, true, 1.2); // far off: moderate detail
    isl.traverse((c) => {
      if (c.userData.palm) polarHidden.push(c);
    });
    isl.position.set(Math.cos(a) * d, 0, Math.sin(a) * d);
    isl.traverse((o) => {
      o.castShadow = false;
    });
    scene.add(isl);
  }
}

// ---------------------------------------------------------------------------
// Camera: slow orbit behind menus; overview or chase while sailing
// ---------------------------------------------------------------------------

const camPos = new THREE.Vector3(0, 700, 2000);
const camLook = new THREE.Vector3();
const wantPos = new THREE.Vector3();
const wantLook = new THREE.Vector3();
const wantUp = new THREE.Vector3(0, 1, 0);
let orbit = 0;
let followDistance = 1100;

const OVERVIEW_ELEVATION = THREE.MathUtils.degToRad(56);
const OVERVIEW_DIR = new THREE.Vector3(0, Math.sin(OVERVIEW_ELEVATION), Math.cos(OVERVIEW_ELEVATION));
// How much sea the follow camera shows around its target (the old 2D screen).
const VIEW_W = 1200;
const VIEW_H = 700;

// Distance at which a VIEW_W x VIEW_H patch of sea just fits on screen.
function fitFollowDistance() {
  const corners = [
    new THREE.Vector3(-VIEW_W / 2, 0, -VIEW_H / 2),
    new THREE.Vector3(VIEW_W / 2, 0, -VIEW_H / 2),
    new THREE.Vector3(-VIEW_W / 2, 0, VIEW_H / 2),
    new THREE.Vector3(VIEW_W / 2, 0, VIEW_H / 2)
  ];
  const probe = camera.clone();
  const v = new THREE.Vector3();
  for (let d = 400; d < 6000; d += 10) {
    probe.position.copy(OVERVIEW_DIR).multiplyScalar(d);
    probe.lookAt(0, 0, 0);
    probe.updateMatrixWorld();
    const fits = corners.every((c) => {
      v.copy(c).project(probe);
      return Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1;
    });
    if (fits) {
      followDistance = d;
      return;
    }
  }
}

// The followed ship in the chase and bridge views (player 1).
// Once player 1 is out and the split has closed, the view follows player 2.
function chaseShip() {
  if (game.settings.cameraView === "overview") return null;
  const p2 = mode === "local" ? game.player2 : null;
  if (p2 && game.player1.capsized && !p2.capsized && !collapse.active) return p2;
  return game.player1;
}

// 2-player: when one ship sinks, a short pause to watch it go down, then
// the survivor's half of the split screen widens until it fills the screen.
const COLLAPSE_DELAY = 1.5;
const COLLAPSE_TIME = 1.2;
const collapse = { active: false, t: 0, toP2: false };
let splitAt = 0.5; // share of the screen width the left view takes

// 2-player chase or bridge view: the screen splits, player 1 left, player 2 right.
function splitActive() {
  return game.settings.cameraView !== "overview" && mode === "local" && !!game.player2 && cameraFocus().inWorld &&
    !game.player1.capsized && !game.player2.capsized;
}

// Bridge view: where the captain stands on each kind of ship (in the
// model's own units, before shipScale): in front of the bridge
// windows looking over the bow; on the sailing boat behind the wheel; on the
// carrier up on the island; on the pirate galleon at the stern-castle helm.
const BRIDGE_EYE = {
  Cruise: [28.2, 15.9, 0], // inside the wheelhouse, just behind the front windows (see cruiseLiner)
  Cargo: [-15.6, 20.2, 0], // bridge on the accommodation tower aft, high above the stacks
  Sailing: [-17.5, 11.5, 2.2], // standing behind the wheel, a little to starboard so the mast isn't dead ahead
  Catamaran: [-1, 11.5, 2.5], // to starboard of the mast
  Assault: [-1.5, 17.5, 0],
  Carrier: [-4.4, 7.4, -4.4], // the navigation bridge on the island (starboard edge), about 18 m above the flight deck
  Hydrofoil: [5.5, 10, 0],
  Futuristic: [1, 7.5, 0],
  Pirate: [-13, 15, 0], // the helm on the stern castle
  Tug: [6.5, 10.4, 0], // forward wheelhouse
  Icebreaker: [8.5, 16.6, 0],
  Tanker: [-16.3, 17, 0], // bridge aft, looking down the length of the deck
  GasTanker: [-17.5, 18.9, 0] // high enough to see over the tanks
};
const eyeTmp = new THREE.Vector3();

// Camera on the ship itself: it moves, turns, rolls, pitches and rises with
// the hull. `up` is the ship's own "up", so when she rolls the horizon tilts
// and, because the bridge stands high above the waterline, the eye also
// swings from side to side and up and down.
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const BRIDGE_LOOK_DOWN = Math.atan2(-14, 60);
const BRIDGE_LOOK_INSIDE = -0.04;
function bridgeWant(ship, pos, look, up) {
  const o = shipObjects.get(ship);
  if (!o) return false;
  const kind = ship.type === "pirate" ? "Pirate" : ship.category || "Cruise";
  const [x, y, z] = BRIDGE_EYE[kind] || BRIDGE_EYE.Cruise;
  o.model.updateWorldMatrix(true, false);
  // Inside the bridge the camera stands a little back and lower; gliding to the window view it moves to the eye.
  const inside = 1 - bridgeEase(ship);
  const sc = o.model.scale.x;
  // Inside: standing near the windows. Outside: a camera on top of the bridge, looking out ahead.
  pos.copy(o.model.localToWorld(eyeTmp.set(x + (BRIDGE_STAND_BACK[0] * inside + BRIDGE_ROOF_CAM[0] * (1 - inside)) / sc, y + (BRIDGE_STAND_BACK[1] * inside + BRIDGE_ROOF_CAM[1] * (1 - inside)) / sc, z)));
  // Facing the bow, tilted down about 13 degrees, turned by however far the
  // player has looked around (right-drag, game.js bridgeLook). Only the view
  // turns; the ship keeps its heading.
  const head = bridgeLook[ship === game.player2 ? "p2" : "p1"];
  // Inside, the view is nearly level (no floor in the picture); it tips down again on the way to the window view.
  const pitch = BRIDGE_LOOK_INSIDE + (BRIDGE_LOOK_DOWN - BRIDGE_LOOK_INSIDE) * (1 - inside) + head.pitch;
  const reach = 60 * Math.cos(pitch);
  look.copy(o.model.localToWorld(eyeTmp.set(x + reach * Math.cos(head.yaw), y + 60 * Math.sin(pitch), z - reach * Math.sin(head.yaw))));
  up.copy(WORLD_UP).transformDirection(o.model.matrixWorld);
  return true;
}

function viewWant(ship, state, pos, look, up, dt) {
  if (game.settings.cameraView === "bridge" && !ship.capsized) updateBridgeBlend(ship, dt);
  if (game.settings.cameraView === "bridge" && !ship.capsized && bridgeWant(ship, pos, look, up)) return;
  up.copy(WORLD_UP);
  chaseWant(ship, state, pos, look, dt);
}

// On the bridge: a wider lens (so your own bow fits in the picture) that can
// see things as close as 0.8 units (the chairs, the console).
function setBridgeLens(on) {
  const near = on ? 0.8 : 5; // close enough for the console and chairs, far enough that the depth buffer stays steady
  const fov = on ? 58 : 42;
  for (const cam of [camera, camera2]) {
    if (cam.near === near && cam.fov === fov) continue;
    cam.near = near;
    cam.fov = fov;
    cam.updateProjectionMatrix();
  }
}

// Turns a camera offset (from what it looks at) by the player's drag
// (game.js viewOrbit): round the vertical axis, and up or down, never under
// the sea or past straight overhead.
function applyViewOrbit(off) {
  if (!viewOrbit.yaw && !viewOrbit.pitch) return;
  const r = off.length();
  const az = Math.atan2(off.z, off.x) + viewOrbit.yaw;
  const el = clamp(Math.atan2(off.y, Math.hypot(off.x, off.z)) + viewOrbit.pitch, 0.05, 1.5);
  off.set(Math.cos(az) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(az) * Math.cos(el) * r);
}

// Where a chase camera behind `ship` sits and looks. Only the heading is
// smoothed; the camera is fixed to the ship (a position lag made it shake).
function chaseWant(ship, state, pos, look, dt) {
  if (state.angle === null) state.angle = ship.angle;
  state.angle += normalizeAngle(ship.angle - state.angle) * (1 - Math.exp(-dt * 5));
  const fx = Math.cos(state.angle);
  const fz = Math.sin(state.angle);
  toWorld(ship.x, ship.y, 0, look);
  // Low and behind, aimed at the sea ahead: the ship sits in the lower part
  // of the view with the horizon and sky above it. (Higher up and aimed
  // further ahead, the ship fell just below the bottom edge of the screen.)
  // It rises and falls with the ship on big waves (a tsunami, a storm).
  // The mouse wheel moves the camera closer or further (game.js viewZoom).
  // Distance and height follow the ship's length (real-size ships run from a
  // 12 m yacht to a 333 m carrier): a 300 m liner gets about 185 back and 63
  // up, a small boat a much closer camera.
  const o = shipObjects.get(ship);
  const heave = o?.heave || 0;
  const len = o ? o.halfLen * 2.5 : 98; // halfLen is 0.4 of the model length
  const back = (75 + len * 1.1) * viewZoom.chase;
  const off = new THREE.Vector3(-fx * back, (22 + len * 0.42) * viewZoom.chase + heave, -fz * back);
  applyViewOrbit(off);
  pos.set(look.x + off.x, look.y + off.y, look.z + off.z);
  // Dragged round, the camera looks at the ship itself instead of the sea ahead.
  const turned = clamp(Math.hypot(viewOrbit.yaw, viewOrbit.pitch) * 4, 0, 1);
  look.x += fx * 230 * (1 - turned);
  look.z += fz * 230 * (1 - turned);
  look.y = (16 + heave) * (1 - turned) + 10 * turned;
}

// Glide in when a chase view starts, then stay locked on.
function chaseFollow(state, k, dt) {
  state.blend = Math.min(1, state.blend + dt * 1.2);
  return state.blend >= 1 ? 1 : Math.max(k, state.blend * state.blend);
}

const cam2 = { pos: new THREE.Vector3(), look: new THREE.Vector3(), wantPos: new THREE.Vector3(), wantLook: new THREE.Vector3(), wantUp: new THREE.Vector3(0, 1, 0), chase: { angle: null, blend: 0 } };
let splitShown = false;

// Each half of the split screen is half as wide, so the cameras' shape changes.
function applyAspect(split) {
  const w = canvas3d.clientWidth;
  const h = canvas3d.clientHeight;
  if (!w || !h) return;
  // Each view's shape follows its share of the width (it changes while the
  // split screen closes).
  const aspect1 = split ? Math.max(0.05, (w * splitAt) / h) : w / h;
  const aspect2 = split ? Math.max(0.05, (w * (1 - splitAt)) / h) : w / h;
  if (camera.aspect !== aspect1) {
    camera.aspect = aspect1;
    camera.updateProjectionMatrix();
  }
  if (camera2.aspect !== aspect2) {
    camera2.aspect = aspect2;
    camera2.updateProjectionMatrix();
  }
}

// How far (world units) the view sways per unit of eruptionShake: at the
// strongest blast, close by, about one unit either way.
const QUAKE_SCALE = 0.1;

// How hard the ground shakes: strongest at the blast and close to it.
function eruptionShake() {
  const f = cameraFocus();
  if (!f.inWorld) return 0;
  let shake = 0;
  for (const hz of hazards) {
    if (hz.kind !== "volcano" || !hz.eruption || hz.eruption < 0.3) continue;
    const near = 1 - Math.min(1, Math.max(0, Math.hypot(hz.x - f.x, hz.y - f.y) - hz.r) / 900);
    shake = Math.max(shake, (hz.eruption - 0.3) * near * 14);
  }
  return shake;
}

const chase = { angle: null, blend: 0 };

function updateCamera(dt) {
  const focus = cameraFocus();
  const target = focus.inWorld ? chaseShip() : null;
  let cloudTarget = CLOUD_HEIGHT_OVERVIEW;
  let rate = 2.5;
  if (graphicsCheck.running) {
    // The graphics check looks out from a harbour, low over the sea: the
    // heaviest view in the game (what the chase view sees while sailing).
    toWorld(HarbourA.x + 220, HarbourA.y - 160, 45, wantPos);
    toWorld(WORLD_W / 2, WORLD_H / 2, 0, wantLook);
    cloudTarget = CLOUD_HEIGHT_CHASE;
    rate = 60;
  } else if (!focus.inWorld) {
    orbit += dt * 0.035;
    const menuOrbit = Math.max(HALF_W, HALF_H) * 1.6; // the whole map in view
    wantPos.set(Math.sin(orbit) * menuOrbit, menuOrbit * 0.33, Math.cos(orbit) * menuOrbit);
    wantLook.set(0, 0, 0);
    rate = 1.2;
  } else if (target) {
    viewWant(target, chase, wantPos, wantLook, wantUp, dt);
    rate = 4.5;
    cloudTarget = CLOUD_HEIGHT_CHASE;
  } else {
    // Tilted overview above the focus; pulls back when 2-player ships separate.
    // The wheel zooms in and out (game.js viewZoom); with two ships it never
    // zooms in so far that one of them leaves the screen.
    const both = focus.spanX || focus.spanY ? Math.max((focus.spanX + 500) / VIEW_W, (focus.spanY + 360) / VIEW_H) : 0;
    const zoom = Math.max(viewZoom.overview, both);
    toWorld(focus.x, focus.y, 0, wantLook);
    wantPos.copy(OVERVIEW_DIR).multiplyScalar(followDistance * zoom);
    applyViewOrbit(wantPos);
    wantPos.add(wantLook);
    rate = 3;
  }
  let k = 1 - Math.exp(-dt * rate);
  // Glide in when switching to the chase view, then stay locked on.
  if (target) {
    k = chaseFollow(chase, k, dt);
  } else {
    chase.blend = 0;
    chase.angle = null;
  }
  setBridgeLens(!!target && game.settings.cameraView === "bridge");
  sky.cloudHeight += (cloudTarget - sky.cloudHeight) * (1 - Math.exp(-dt * 1.5));
  if (!target) wantUp.copy(WORLD_UP);
  camPos.lerp(wantPos, k);
  camLook.lerp(wantLook, k);
  camera.up.lerp(wantUp, k).normalize();
  camera.position.copy(camPos);
  camera.lookAt(camLook);

  // Player 2's half of the split screen; otherwise it waits at the shared
  // view, so starting the split glides out from where the camera was.
  let split = target && splitActive();
  const p2 = mode === "local" ? game.player2 : null;
  const oneLeft = !!p2 && game.player1.capsized !== p2.capsized;
  if (!oneLeft) collapse.active = false;
  if (!split && splitShown && target && oneLeft && !collapse.active && splitAt === 0.5) {
    collapse.active = true;
    collapse.t = 0;
    collapse.toP2 = game.player1.capsized;
  }
  let handOver = false;
  if (collapse.active) {
    collapse.t += dt;
    const e = smoothstep(0, 1, (collapse.t - COLLAPSE_DELAY) / COLLAPSE_TIME);
    splitAt = collapse.toP2 ? 0.5 - 0.5 * e : 0.5 + 0.5 * e;
    split = e < 1;
    if (!split) {
      collapse.active = false;
      handOver = collapse.toP2;
    }
  }
  if (!split) splitAt = 0.5;
  view3d.splitAt = splitAt;
  if (split) {
    viewWant(game.player2, cam2.chase, cam2.wantPos, cam2.wantLook, cam2.wantUp, dt);
    const k2 = chaseFollow(cam2.chase, 1 - Math.exp(-dt * rate), dt);
    cam2.pos.lerp(cam2.wantPos, k2);
    cam2.look.lerp(cam2.wantLook, k2);
    camera2.up.lerp(cam2.wantUp, k2).normalize();
    camera2.position.copy(cam2.pos);
    camera2.lookAt(cam2.look);
  } else {
    cam2.chase.angle = null;
    cam2.chase.blend = 0;
    cam2.pos.copy(camPos);
    cam2.look.copy(camLook);
  }
  if (handOver) {
    // Player 2 is the one left: the full-screen camera takes over from
    // player 2's, exactly where it is, and follows player 2 from now on.
    camPos.copy(cam2.pos);
    camLook.copy(cam2.look);
    chase.angle = cam2.chase.angle ?? game.player2.angle;
    chase.blend = 1;
    camera.up.copy(camera2.up);
    camera.position.copy(camPos);
    camera.lookAt(camLook);
  }
  if (split !== splitShown) {
    splitShown = split;
    view3d.split = split;
  }
  applyAspect(splitShown);

  // An eruption sways the view gently: a slow, smooth tremor (a few
  // shakes a second, mixed so it never looks regular), not a buzz.
  const quake = eruptionShake() * QUAKE_SCALE;
  if (quake > 0) {
    const t = clock.t;
    const qx = Math.sin(t * 13.1) * 0.6 + Math.sin(t * 7.3 + 1.7) * 0.4;
    const qy = Math.sin(t * 11.7 + 0.9) * 0.6 + Math.sin(t * 5.9 + 2.3) * 0.4;
    for (const cam of split ? [camera, camera2] : [camera]) {
      cam.position.x += qx * quake;
      cam.position.y += qy * quake;
    }
  }

  // Keep the sun's shadow box centred on what the camera is looking at (in
  // split screen: between both players, wide enough for both).
  const shadowCentre = split ? cam2.look.clone().add(camLook).multiplyScalar(0.5) : camLook;
  const spread = split ? camLook.distanceTo(cam2.look) * 0.5 + 600 : 0;
  const reach = THREE.MathUtils.clamp(Math.max(camPos.distanceTo(camLook) * 0.9, spread), 700, split ? 3200 : 2400);
  const sc = sun.shadow.camera;
  if (Math.abs(sc.right - reach) > 50) {
    sc.left = -reach;
    sc.right = reach;
    sc.top = reach;
    sc.bottom = -reach;
    sc.updateProjectionMatrix();
  }
  sun.target.position.copy(shadowCentre).setY(0);
  sun.position.copy(sunDir).multiplyScalar(1600).add(sun.target.position);
}

// ---------------------------------------------------------------------------
// Fog banks (game.js fogBanks). From outside: a thick white mass of mist
// lying on the sea. With the camera down inside one (the view behind your
// ship), the scene fog closes in to a few metres and the sky greys out.
// Lights in or behind the fog (lighthouse lamps, burning ships, an erupting
// volcano) show as a soft glow as you get close.
// ---------------------------------------------------------------------------

const MIST_DAY = new THREE.Color(0xc9d2d7);
const MIST_NIGHT = new THREE.Color(0x1b2331);
const STORM_HAZE = new THREE.Color(0x7d8791); // rain haze under a storm, by day
// Seen from outside at night the bank is moonlit haze: a touch paler than
// the moonlit sea, never darker (a darker tint reads as a black hole).
const MIST_NIGHT_PUFF = new THREE.Color(0x56606e);
// By day the puffs are a soft grey close to the fair-weather clouds and only
// lightly opaque: 34 near-white puffs at full strength stacked up into a
// flat bright glare over the sea instead of mist the sea shows through.
const MIST_DAY_PUFF = new THREE.Color(0xaab4bc);
const FOG_PUFF_OPACITY = 0.2;
const FOG_INSIDE_MAX = 0.88; // how far the grey closes in with the camera inside a bank
const fogLights = { lamps: [], glows: [] };
const fogTmp = new THREE.Color();
const fogDome = new THREE.Mesh(
  new THREE.SphereGeometry(1100, 24, 16),
  new THREE.MeshBasicMaterial({ color: 0xc9d2d7, side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false, fog: false, toneMapped: false })
);
fogDome.renderOrder = 8;
// Overcast: under a storm the bright sky greys over. A dome inside the sky
// (land and sea in front of it still show), drawn before the clouds so they
// stay on top of it.
const overcastDome = new THREE.Mesh(
  new THREE.SphereGeometry(8000, 24, 16),
  new THREE.MeshBasicMaterial({ color: 0x7d8791, side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false, fog: false })
);
overcastDome.renderOrder = -1;
overcastDome.visible = false;
scene.add(overcastDome);
fogDome.visible = false;
scene.add(fogDome);
for (let i = 0; i < 12; i++) {
  const g = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowStar, color: 0xffd9a0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0 }));
  g.renderOrder = 9;
  g.visible = false;
  scene.add(g);
  fogLights.glows.push(g);
}

function createFogBank(bank) {
  const root = new THREE.Group();
  const puffs = [];
  for (let i = 0; i < 34; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.sqrt(Math.random()) * bank.r * 0.85;
    const puff = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0xdfe5e8, transparent: true, depthWrite: false, opacity: 0, toneMapped: false }));
    const size = 150 + Math.random() * 150;
    // Resting on the sea: low enough to hug it, high enough that the sea
    // surface doesn't slice a straight edge through the puff.
    puff.userData = { x: Math.cos(a) * d, z: Math.sin(a) * d, y: size * 0.42 + Math.random() * 20, size, phase: Math.random() * 10 };
    root.add(puff);
    puffs.push(puff);
  }
  return { root, puffs };
}

function updateFogBank(bank, o) {
  toWorld(bank.x, bank.y, 0, o.root.position);
  const t = clock.t;
  const color = night.applied ? MIST_NIGHT_PUFF : MIST_DAY_PUFF;
  for (const puff of o.puffs) {
    const u = puff.userData;
    // Churning inside the bank as it rolls along.
    puff.position.set(u.x + Math.sin(t * 0.13 + u.phase) * 35, u.y + Math.sin(t * 0.17 + u.phase) * 6, u.z + Math.cos(t * 0.11 + u.phase) * 35);
    puff.scale.setScalar(u.size * (0.88 + 0.12 * Math.sin(t * 0.15 + u.phase)));
    puff.material.color.copy(color);
    puff.material.opacity = bank.density * FOG_PUFF_OPACITY;
  }
}

const fogObjects = new Map();

// Where lights are this frame: lamps always; burning ships; erupting volcanoes.
function fogLightSources() {
  const list = fogLights.lamps.map((p) => ({ p, strength: 1, color: 0xffe2a0 }));
  for (const [ship, o] of shipObjects) {
    if (ship.fire && !ship.capsized) list.push({ p: o.root.position.clone().setY(18), strength: 0.6 + 0.15 * ship.fire.intensity, color: 0xff8a30 });
  }
  for (const hz of hazards) {
    if (hz.kind !== "volcano" || !(hz.eruption > 0.1 || hz.lavaFlow > 0.5)) continue;
    list.push({ p: toWorld(hz.x, hz.y, hz.r * 1.2, new THREE.Vector3()), strength: 0.5 + (hz.eruption || 0), color: 0xff5a20 });
  }
  return list;
}

// Sets the scene fog, the grey dome and the light glows for one camera
// (called before each render, so each half of the split screen gets its own).
function applyFogFor(cam) {
  const look = lookFor(night.applied);
  const mist = night.applied ? MIST_NIGHT : MIST_DAY;
  // Under a storm's cloud deck the sky is overcast: the sun (or moon) is
  // mostly hidden and the light goes flat and dim.
  const overcast = stormNearness(cam.position.x + HALF_W, cam.position.z + HALF_H);
  sun.intensity = look.sunI * (1 - 0.6 * overcast);
  hemiLight.intensity = look.hemi * (1 - 0.35 * overcast);
  // Only a camera down at sea level is "in" the fog; the high overview sees
  // the banks from above instead.
  const low = THREE.MathUtils.clamp(1 - (cam.position.y - 90) / 260, 0, 1);
  const inside = Math.pow(fogAt(cam.position.x + HALF_W, cam.position.z + HALF_H) * low, 0.8);
  // Thick: your own ship (just ahead of the camera) stays visible, anything
  // a few ship-lengths away is gone.
  // Rain haze under a storm: grey, and the far distance closes in.
  const haze = overcast * low;
  scene.fog.near = THREE.MathUtils.lerp(THREE.MathUtils.lerp(look.fogNear, 600, haze), 40, inside);
  scene.fog.far = THREE.MathUtils.lerp(THREE.MathUtils.lerp(look.fogFar, 4500, haze), 400, inside);
  scene.fog.color.copy(fogTmp.setHex(look.fog).lerp(night.applied ? MIST_NIGHT : STORM_HAZE, 0.8 * haze).lerp(mist, inside));
  overcastDome.visible = haze > 0.01;
  overcastDome.position.copy(cam.position);
  overcastDome.material.color.copy(scene.fog.color);
  overcastDome.material.opacity = 0.85 * haze;
  fogDome.visible = inside > 0.01;
  fogDome.position.copy(cam.position);
  fogDome.material.color.copy(scene.fog.color);
  fogDome.material.opacity = inside * FOG_INSIDE_MAX;

  const sources = fogLightSources();
  fogLights.glows.forEach((g, i) => {
    const src = sources[i];
    if (!src) {
      g.visible = false;
      return;
    }
    const fogHere = Math.max(inside, fogAt(src.p.x + HALF_W, src.p.z + HALF_H));
    const near = THREE.MathUtils.clamp(1 - cam.position.distanceTo(src.p) / 750, 0, 1);
    const a = fogHere * Math.pow(near, 0.7) * src.strength * (0.85 + 0.15 * Math.sin(clock.t * 7 + i));
    g.visible = a > 0.01;
    g.position.copy(src.p);
    g.material.color.setHex(src.color);
    g.material.opacity = Math.min(0.9, a);
    g.scale.setScalar(55 + 70 * fogHere);
  });
}

// ---------------------------------------------------------------------------
// Day / night (game.settings.nightMode). Night: moonlight from the sun's
// direction, dark sky with stars and a moon, darker sea; everything that
// glows (lava, lamps, navigation lights) stands out against it.
// ---------------------------------------------------------------------------

const night = { on: false, applied: null };
const DAY_LOOK = { fog: 0x9cc3dc, fogNear: 3200, fogFar: 15000, env: 0.7, sun: 0xfff0d6, sunI: 2.6, hemi: 0.55, glint: 0xfff1d6, sea: 0x0a4560, bloom: 0.42, beam: 0.07 };
const NIGHT_LOOK = { fog: 0x060d1c, fogNear: 2600, fogFar: 12000, env: 0.1, sun: 0x9fb6ff, sunI: 0.6, hemi: 0.14, glint: 0x2a3350, sea: 0x021626, bloom: 0.8, beam: 0.45 };
const nightSkyColor = new THREE.Color(0x050a17);
// A polar run (game.polar): cold dark water, a paler sun and whiter haze.
const POLAR_DAY = { fog: 0xc9d9e4, fogNear: 2600, sun: 0xf2f5ff, sunI: 2.4, hemi: 0.7, glint: 0xf4f7ff, sea: 0x062f3e };
const POLAR_NIGHT = { sea: 0x011520 };
const polar = { applied: false };

function lookFor(nightOn) {
  if (!polar.applied) return nightOn ? NIGHT_LOOK : DAY_LOOK;
  return nightOn ? { ...NIGHT_LOOK, ...POLAR_NIGHT } : { ...DAY_LOOK, ...POLAR_DAY };
}

// Snow over the land: snowy hills and pines, white roofs, no palms or leafy
// trees (polarOnly / polarHidden are filled by the harbour and island builders).
const polarOnly = [];
const polarHidden = [];
const pineMat = shared(mat(0x2f6b34, { roughness: 0.85, flatShading: true }));

function applyPolar(on) {
  polar.applied = on;
  grassMat.color.setHex(on ? 0xeef3f7 : 0x4d8a38);
  grassMat.roughness = on ? 0.7 : 0.9;
  sandMat.color.setHex(on ? 0x8c8a86 : 0xd8c28a);
  pineMat.color.setHex(on ? 0x6f8c80 : 0x2f6b34);
  for (const o of polarOnly) o.visible = on;
  for (const o of polarHidden) o.visible = !on;
  applyTimeOfDay(night.applied);
}

const nightSky = new THREE.Group();
// Stars: a sparse sky where most are tiny and faint and only a few reach the
// largest size (1.6 px); kept out of the sea's reflection.
const STAR_MAX_PX = 1.6;
const starField = (() => {
  const count = 650;
  const pos = new Float32Array(count * 3);
  const size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // Upper half of a big sphere.
    const a = Math.random() * Math.PI * 2;
    const up = Math.random() * 0.97 + 0.03; // even over the dome
    const flat = Math.sqrt(1 - up * up);
    pos.set([Math.cos(a) * flat * 9000, up * 9000, Math.sin(a) * flat * 9000], i * 3);
    // Skewed toward small: anything from a faint speck up to the max size.
    size[i] = 0.35 + (STAR_MAX_PX - 0.35) * Math.pow(Math.random(), 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("size", new THREE.BufferAttribute(size, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { pixelRatio: { value: 1 } },
    vertexShader: `
      attribute float size;
      uniform float pixelRatio;
      varying float vBright;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        // Below one pixel a point can't get smaller, so it gets fainter instead.
        vBright = clamp(size / ${STAR_MAX_PX.toFixed(1)}, 0.0, 1.0);
        gl_PointSize = max(size, 1.0) * pixelRatio;
      }`,
    fragmentShader: `
      varying float vBright;
      void main() {
        gl_FragColor = vec4(0.81, 0.86, 1.0, 0.15 + 0.75 * vBright * vBright);
      }`,
    transparent: true,
    depthWrite: false
  });
  const points = new THREE.Points(geo, material);
  points.onBeforeRender = (r) => {
    material.uniforms.pixelRatio.value = r.getPixelRatio();
  };
  return points;
})();
{
  nightSky.add(starField);
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0xe8eeff, fog: false, depthWrite: false }));
  moon.scale.setScalar(520);
  moon.position.copy(sunDir).multiplyScalar(8800);
  const moonHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSoft, color: 0x3a4a78, fog: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  moonHalo.scale.setScalar(2200);
  moonHalo.position.copy(moon.position);
  nightSky.add(moonHalo, moon);
  // Drawn before the overcast dome, so a storm's cloud hides the stars and moon.
  for (const o of [starField, moonHalo, moon]) o.renderOrder = -2;
  nightSky.visible = false;
  scene.add(nightSky);
}

function applyTimeOfDay(on) {
  const look = lookFor(on);
  scene.fog.color.setHex(look.fog);
  scene.fog.near = look.fogNear;
  scene.fog.far = look.fogFar;
  scene.background = on ? nightSkyColor : null;
  skyDome.visible = !on;
  nightSky.visible = on;
  scene.environmentIntensity = look.env;
  sun.color.setHex(look.sun);
  sun.intensity = look.sunI;
  hemiLight.intensity = look.hemi;
  water.material.uniforms.sunColor.value.setHex(look.glint);
  water.material.uniforms.waterColor.value.setHex(look.sea);
  if (on) water.material.uniforms.foamColor.value.setRGB(0.1, 0.13, 0.18);
  else water.material.uniforms.foamColor.value.setRGB(1.25, 1.35, 1.4);
  bloomPass.strength = look.bloom;
  beamMaterial.uniforms.opacity.value = look.beam;
  night.applied = on;
}

// ---------------------------------------------------------------------------
// Graphics quality: steps down by itself when the frame rate drops (e.g. on
// integrated graphics) and back up when there is headroom again.
// ---------------------------------------------------------------------------

// The quality ladder, best first. Every level keeps what is cheap and makes
// the scene look real (tone mapping, the moving sea, emissive lights at
// night: lit windows, car and street lights); each step up adds what costs
// more. Per level:
// - ss / maxRatio: pixels drawn per screen pixel (ss above 1 = supersampling,
//   smoother edges and finer detail), never above maxRatio;
// - msaa: anti-aliasing samples on the main picture (smooths edges);
// - shadows / shadowSize: sun shadows and their sharpness;
// - aniso: texture sharpness at grazing angles (the sea, decks);
// - bloom: glow around bright lights;
// - townGlow: light pools on the ground at night (street lamps, windows);
// - traffic: share of the harbour cars on the roads;
// - foam: share of the whirlpool's foam flecks drawn;
// - terrain: how fine island ground meshes are (set when an island is made).
// "3D Advanced" (dedicated graphics card) moves between Extreme and Ultra;
// "3D Automatic" moves between Ultra and Lowest, starting from what the
// graphics chip suggests, and climbs whenever the frame rate has headroom.
const QUALITY_LEVELS = [
  { name: "Extreme", ss: 1.5, maxRatio: 3, msaa: 8, shadows: true, shadowSize: 8192, aniso: 16, bloom: true, townGlow: true, traffic: 1, foam: 1, terrain: 3 },
  { name: "Ultra", ss: 1.25, maxRatio: 2.5, msaa: 4, shadows: true, shadowSize: 4096, aniso: 16, bloom: true, townGlow: true, traffic: 1, foam: 1, terrain: 2.5 },
  { name: "High", ss: 1, maxRatio: 1.5, msaa: 4, shadows: true, shadowSize: 2048, aniso: 8, bloom: true, townGlow: true, traffic: 1, foam: 0.8, terrain: 2 },
  { name: "Medium", ss: 1, maxRatio: 1, msaa: 2, shadows: true, shadowSize: 2048, aniso: 4, bloom: true, townGlow: false, traffic: 0.7, foam: 0.6, terrain: 1.5 },
  { name: "Low", ss: 1, maxRatio: 0.8, msaa: 0, shadows: false, shadowSize: 2048, aniso: 2, bloom: true, townGlow: false, traffic: 0.5, foam: 0.4, terrain: 1.2 },
  { name: "Lowest", ss: 1, maxRatio: 0.6, msaa: 0, shadows: false, shadowSize: 2048, aniso: 1, bloom: false, townGlow: false, traffic: 0.35, foam: 0.25, terrain: 1 }
];
const ON_PHONE = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent); // phone or tablet
const PHONE_MIN_RATIO = 1.25; // pixels drawn per screen point, at least
const PHONE_MIN_MSAA = 4; // edge smoothing samples, at least
const LEVEL_RANGE = { advanced: [0, 1], auto: [1, QUALITY_LEVELS.length - 1] };
const perf = { level: 2 }; // the quality level in use (QUALITY_LEVELS index)

function applyQuality(level) {
  perf.level = level;
  const q = QUALITY_LEVELS[level];
  const caps = renderer.capabilities;
  // A phone is held back by its processor, not by pixels (measured on a
  // Galaxy A14: 1x to 1.5x resolution and 4x smoothing cost about one frame a
  // second), so it keeps a sharp, smooth picture at every level and the
  // levels only switch effects. Lower resolution only made stepped edges.
  const minRatio = ON_PHONE ? PHONE_MIN_RATIO : 0;
  const ratio = Math.max(minRatio, Math.min((window.devicePixelRatio || 1) * q.ss, q.maxRatio));
  renderer.setPixelRatio(ratio);
  composer.setPixelRatio(ratio);
  const msaa = Math.min(ON_PHONE ? Math.max(q.msaa, PHONE_MIN_MSAA) : q.msaa, caps.maxSamples || 0);
  for (const target of [composer.renderTarget1, composer.renderTarget2]) {
    if (target.samples !== msaa) {
      target.samples = msaa;
      target.dispose(); // rebuilt with the new sample count on next use
    }
  }
  if (sun.castShadow !== q.shadows) sun.castShadow = q.shadows;
  const shadowSize = Math.min(q.shadowSize, caps.maxTextureSize);
  if (sun.shadow.mapSize.x !== shadowSize) {
    sun.shadow.mapSize.set(shadowSize, shadowSize);
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
      sun.shadow.map = null;
    }
  }
  const normals = water.material.uniforms.normalSampler.value;
  const aniso = Math.min(q.aniso, caps.getMaxAnisotropy());
  if (normals && normals.anisotropy !== aniso) {
    normals.anisotropy = aniso;
    // Still loading at start-up: the loader uploads it (with this setting)
    // when it arrives; marking it now would warn "no image data found".
    if (normals.image) normals.needsUpdate = true;
  }
  for (const tex of landTextures) {
    if (tex.anisotropy !== aniso) {
      tex.anisotropy = aniso;
      tex.needsUpdate = true;
    }
  }
  bloomPass.enabled = q.bloom;
  for (const fleet of harbourCars) {
    const n = Math.round(fleet.cars.length * q.traffic);
    for (const im of [fleet.body, fleet.cabin, fleet.headlights, fleet.taillights, fleet.beams]) im.count = n;
  }
  whirlFoam.geometry.setDrawRange(0, Math.round(FOAM_FLECKS * q.foam));
  view3d.quality = q.name;
  resize();
}

// Which graphics chip the browser is drawing with, e.g. "NVIDIA GeForce RTX 4060".
function detectGpu() {
  const gl = renderer.getContext();
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const raw = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const name = String(raw).replace(/^ANGLE \([^,]*,\s*/, "").replace(/\s*\(0x[0-9a-f]+\).*$/i, "").replace(/\s+Direct3D.*$/i, "").trim();
  // A phone or tablet never has a desktop graphics card (the Android
  // emulator reports the PC's card, e.g. "OpenGL ES Translator (NVIDIA ...)").
  const mobile = ON_PHONE;
  const dedicated = !mobile && /nvidia|geforce|quadro|radeon rx|radeon pro|arc\(tm\) a|arc a\d/i.test(name) && !/swiftshader|basic render/i.test(name);
  return { name: name || "unknown", dedicated, mobile };
}

// ---------------------------------------------------------------------------
// Graphics check. The quality level never changes while a game is played (a
// change shows as a flicker). It is chosen once per device, while loading:
// the first start tries the levels on a view like sailing (low over a
// harbour, looking out to sea: the heaviest view) and keeps the best one that
// runs smoothly. The result is saved, and later starts use it straight away.
// It is checked again only when the graphics chip or the screen size changes.
// ---------------------------------------------------------------------------
const GRAPHICS_KEY = "harbour-run-graphics-v1";
const CHECK_WARMUP_MS = 600; // after switching level (shaders compiling): not measured
const CHECK_WARMUP_FRAMES = 6;
const CHECK_MEASURE_MS = 1000;
const CHECK_MEASURE_FRAMES = 3; // a very slow level is still judged quickly
const CHECK_SMOOTH_SHARE = 0.85; // a level passes at this share of the device's top speed...
const CHECK_FPS_GOAL = 55; // ...or at this frame rate, whichever is lower
const graphicsCheck = { running: false, order: [], at: 0, phase: "", since: 0, last: 0, frames: [], ceiling: 0, results: {} };
let graphicsChoice = null; // { signature, best, ceiling, results, checkedOn }

function hardwareSignature() {
  return `${detectGpu().name} | ${screen.width}x${screen.height}`;
}

// The saved choice, if it was made on this graphics chip and screen size.
function loadGraphicsChoice() {
  try {
    const saved = JSON.parse(localStorage.getItem(GRAPHICS_KEY) || "null");
    return saved && saved.signature === hardwareSignature() ? saved : null;
  } catch {
    return null; // unreadable: check again
  }
}

// "auto": the checked level (Ultra at best); "advanced": Extreme or Ultra
// (dedicated graphics card); "2d": the classic flat map.
function setGraphicsMode(mode) {
  const on = mode !== "2d";
  view3d.active = on;
  canvas3d.style.display = on ? "" : "none";
  document.body.classList.toggle("view-3d", on);
  const [top, bottom] = LEVEL_RANGE[mode === "advanced" ? "advanced" : "auto"];
  if (on) applyQuality(clamp(graphicsChoice ? graphicsChoice.best : 2, top, bottom));
}

function applyChosenGraphicsMode() {
  let mode = game.settings.graphicsMode;
  if (mode === "advanced" && !detectGpu().dedicated) mode = "auto";
  setGraphicsMode(mode);
}

function startGraphicsCheck() {
  document.getElementById("loading").innerHTML = "Checking your graphics...<br />first start only";
  // 3D on for the check even when the 2D view is chosen (the loading screen covers it).
  view3d.active = true;
  canvas3d.style.display = "";
  const lowest = QUALITY_LEVELS.length - 1;
  const top = detectGpu().dedicated ? 0 : 1;
  graphicsCheck.order = [lowest]; // first: how fast this device can go at all
  for (let level = top; level < lowest; level += 1) graphicsCheck.order.push(level);
  graphicsCheck.at = 0;
  graphicsCheck.results = {};
  graphicsCheck.running = true;
  beginCheckLevel();
}

function beginCheckLevel() {
  applyQuality(graphicsCheck.order[graphicsCheck.at]);
  graphicsCheck.phase = "warmup";
  graphicsCheck.since = graphicsCheck.last = performance.now();
  graphicsCheck.frames = [];
}

// Once per frame while the check runs (renderFrame).
function stepGraphicsCheck() {
  const c = graphicsCheck;
  // A game started before the check finished: stop at a safe level, unsaved,
  // so the quality never changes during play; the next start checks again.
  if (gameState !== "menu") {
    finishGraphicsCheck(QUALITY_LEVELS.length - 2, false);
    return;
  }
  const now = performance.now();
  c.frames.push(now - c.last);
  c.last = now;
  if (c.phase === "warmup") {
    if (now - c.since >= CHECK_WARMUP_MS && c.frames.length >= CHECK_WARMUP_FRAMES) {
      c.phase = "measure";
      c.since = now;
      c.frames = [];
    }
    return;
  }
  if (now - c.since < CHECK_MEASURE_MS || c.frames.length < CHECK_MEASURE_FRAMES) return;
  const sorted = [...c.frames].sort((x, y) => x - y);
  const fps = 1000 / sorted[Math.floor(sorted.length / 2)]; // median: one hiccup doesn't count
  const level = c.order[c.at];
  c.results[QUALITY_LEVELS[level].name] = Math.round(fps);
  if (c.at === 0) {
    c.ceiling = fps;
  } else if (fps >= Math.min(CHECK_FPS_GOAL, c.ceiling * CHECK_SMOOTH_SHARE)) {
    finishGraphicsCheck(level, true);
    return;
  }
  c.at += 1;
  if (c.at < c.order.length) beginCheckLevel();
  else finishGraphicsCheck(QUALITY_LEVELS.length - 1, true); // nothing above Lowest kept up
}

function finishGraphicsCheck(best, save) {
  graphicsCheck.running = false;
  graphicsChoice = { signature: hardwareSignature(), best, ceiling: Math.round(graphicsCheck.ceiling), results: graphicsCheck.results, checkedOn: new Date().toISOString().slice(0, 10) };
  if (save) localStorage.setItem(GRAPHICS_KEY, JSON.stringify(graphicsChoice));
  document.getElementById("loading").innerHTML = "Loading Harbour Run...<br />please wait";
  applyChosenGraphicsMode();
  view3d.startupDone = true;
}

// ---------------------------------------------------------------------------
// Frame + projection for the 2D overlay
// ---------------------------------------------------------------------------

const projV = new THREE.Vector3();
const view = { left: 0, top: 0, width: 1, height: 1, offX: 0, offY: 0, scale: 1 };

// The overlay canvas is letterboxed (object-fit: contain) inside the same box
// as the 3D canvas; keep both mappings so labels land on the 3D objects.
function measure() {
  const r3 = canvas3d.getBoundingClientRect();
  const r2 = overlay.getBoundingClientRect();
  view.left = r3.left;
  view.top = r3.top;
  view.width = r3.width || 1;
  view.height = r3.height || 1;
  view.scale = Math.min(r2.width / WIDTH, r2.height / HEIGHT) || 1;
  view.offX = r2.left + (r2.width - WIDTH * view.scale) / 2;
  view.offY = r2.top + (r2.height - HEIGHT * view.scale) / 2;
}

function project(x, y, lift = 0) {
  let cam = camera;
  let left = 0;
  let width = 1;
  if (splitShown) {
    // A label belongs to the half of whichever player is closer to it.
    const p1 = game.player1;
    const p2 = game.player2;
    const second = Math.hypot(x - p2.x, y - p2.y) < Math.hypot(x - p1.x, y - p1.y);
    cam = second ? camera2 : camera;
    left = second ? splitAt : 0;
    width = second ? 1 - splitAt : splitAt;
  }
  // Labels ride the waves with what they label (a tsunami, a whirlpool).
  toWorld(x, y, lift, projV);
  projV.y += seaHeight(projV.x, projV.z);
  projV.project(cam);
  const sx = view.left + (left + ((projV.x + 1) / 2) * width) * view.width;
  const sy = view.top + ((1 - projV.y) / 2) * view.height;
  return {
    x: (sx - view.offX) / view.scale,
    y: (sy - view.offY) / view.scale,
    // In split screen a point outside its own half isn't drawn.
    visible: projV.z < 1 && (!splitShown || Math.abs(projV.x) <= 1)
  };
}

function resize() {
  const w = canvas3d.clientWidth;
  const h = canvas3d.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  fitFollowDistance();
  applyAspect(splitShown);
  measure();
}

function renderFrame(dt) {
  // The shop is the 3D dockyard; every other screen is the sea.
  if (gameState === "shop" && game.dock) {
    renderDockyard(dt);
    measure();
    return;
  }
  composer.passes[0].scene = scene;
  composer.passes[0].camera = camera;
  renderer.toneMappingExposure = 0.5;
  bloomPass.strength = lookFor(night.on).bloom;
  clock.t += dt;
  lightningLight.intensity = 0;
  volcanoGlow.strength = 0;
  volcanoGlow.dist = Infinity;
  candleLight.intensity = 0;
  night.on = !!game.settings.nightMode;
  if (night.applied !== night.on) applyTimeOfDay(night.on);
  lavaFlowTex.offset.y += dt * 0.12;
  lavaTex.offset.x += dt * 0.01;

  updateSea(dt);
  syncEntities(shipObjects, shipList(), createShip, updateShip, dt);
  // A ship that changed model (e.g. a new pick in the shop) is rebuilt.
  for (const [ship, o] of shipObjects) {
    if (o.color !== ship.displayColor || o.category !== ship.category) {
      scene.remove(o.root);
      disposeTree(o.root);
      shipObjects.delete(ship);
    }
  }
  // The carriers' patrol jets; a jet still in the air when its carrier's
  // model is gone (round over, ship changed) goes with it.
  for (const [ship, o] of shipObjects) if (o.airWing) updateSortieJet(ship, o);
  const liveObjects = new Set(shipObjects.values());
  for (const [grp, o] of flyingSorties) {
    if (liveObjects.has(o)) continue;
    scene.remove(grp);
    flyingSorties.delete(grp);
  }
  updateJetEffects();
  syncEntities(hazardObjects, hazards, createHazard, updateHazard, dt);
  syncEntities(stormObjects, dynamicDangers, createStorm, updateStorm, dt);
  updateSkyClouds(dt);
  updateTempestSky(dt);
  updateGulls(dt);
  syncEntities(creatureObjects, game.seaCreatures, createCreature, updateCreature, dt);
  syncEntities(subObjects, game.underwaterEnemies, createSub, updateSub, dt);
  syncEntities(missileObjects, game.missiles, createMissile, updateMissile, dt);
  syncEntities(lavaPoolObjects, game.lavaPools, createLavaPool, updateLavaPool, dt);
  syncEntities(iceSheetObjects, game.iceSheets, createIceSheet, updateIceSheet, dt, (o) => o.tex.dispose());
  if (polar.applied !== !!game.polar) applyPolar(!!game.polar);
  syncEntities(rockObjects, game.volcanoRocks, createRock, updateRock, dt, removeRock);
  syncEntities(fogObjects, fogBanks, createFogBank, updateFogBank, dt);
  updateSteam(dt);
  updateSpout(dt);
  updateTsunami3d();
  updatePlank();
  updateLines(dt);

  for (const beam of lighthouseBeams) beam.rotation.y += dt * 0.6;
  updateHarbourCars(dt);
  updateBuoys();

  water.material.uniforms.time.value += dt * 0.55;
  volcanoGlow.light.intensity = volcanoGlow.strength * (90 + Math.random() * 40);
  updateCamera(dt);
  nightSky.position.copy(camera.position);
  renderer.shadowMap.needsUpdate = true;
  if (splitShown) {
    // Two views side by side, drawn straight to the screen (the bloom pass
    // works on the whole screen, so split screen goes without it).
    const size = renderer.getSize(new THREE.Vector2());
    const half = Math.round(size.x * splitAt); // the left view's width
    renderer.setScissorTest(true);
    if (half > 0) {
      renderer.setViewport(0, 0, half, size.y);
      renderer.setScissor(0, 0, half, size.y);
      applyFogFor(camera);
      renderer.render(scene, camera);
    }
    if (size.x - half > 0) {
      renderer.setViewport(half, 0, size.x - half, size.y);
      renderer.setScissor(half, 0, size.x - half, size.y);
      applyFogFor(camera2);
      renderer.render(scene, camera2);
    }
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, size.x, size.y);
  } else {
    applyFogFor(camera);
    composer.render(dt);
  }
  measure();
  if (graphicsCheck.running) stepGraphicsCheck();
}

// ---------------------------------------------------------------------------
// Dockyard (the shop): a dry dock where the player's ship is refitted.
// The ship sails in through the gate, the gate shuts and the dock is pumped
// dry; choosing another ship floods the dock, sends the old ship out and
// brings the new one in. game.js draws the icons and text on top.
// 1 unit is about 3 m, like the ships.
// ---------------------------------------------------------------------------
const DK = { L: 130, W: 46, FLOOR: -8, Q: 4, GX: 65, REST_MIN: -3.2, X_START: 270 };
// What the dockyard draws at each of the game's quality levels (perf.level):
// tex = texture resolution multiplier, geo = how round the round things are,
// props = how much clutter, people = share of the workers, gulls, reflect =
// the sea mirror's size, bump = surface relief, detail = the extra fittings,
// wet = glossy puddles. The game's own settings (resolution, edge smoothing,
// shadow size, filtering, glow) apply to this scene as well.
const DK_TIERS = [
  { name: "Extreme", tex: 8, geo: 2, props: 2.5, people: 1, gulls: 24, reflect: 2048, bump: true, detail: true, wet: true },
  { name: "Ultra", tex: 4, geo: 1.6, props: 2, people: 1, gulls: 18, reflect: 1024, bump: true, detail: true, wet: true },
  { name: "High", tex: 2, geo: 1.2, props: 1.4, people: 1, gulls: 12, reflect: 1024, bump: true, detail: true, wet: false },
  { name: "Medium", tex: 1, geo: 1, props: 1, people: 0.7, gulls: 8, reflect: 512, bump: false, detail: false, wet: false },
  { name: "Low", tex: 1, geo: 0.8, props: 0.5, people: 0.4, gulls: 4, reflect: 256, bump: false, detail: false, wet: false },
  { name: "Lowest", tex: 0.5, geo: 0.6, props: 0.25, people: 0.2, gulls: 2, reflect: 256, bump: false, detail: false, wet: false }
];
let dkq = DK_TIERS[2];
const dkn = (n) => Math.max(1, Math.round(n * dkq.props));
function CylG(rt, rb, h, seg = 8) {
  return new THREE.CylinderGeometry(rt, rb, h, Math.max(5, Math.round(seg * dkq.geo)));
}
function SphG(r, w = 8, h = 6, ...rest) {
  return new THREE.SphereGeometry(r, Math.max(5, Math.round(w * dkq.geo)), Math.max(4, Math.round(h * dkq.geo)), ...rest);
}
const DK_ARRIVE = 4.8; // sail in
const DK_CLOSE = 1.2; // gate shuts
const DK_DRAIN = 3.0; // pumped dry (these three add up to DOCK_CLIP_TIME in game.js)
// "out" has no fixed length: the next ship waits until the leaver has cleared the channel (stepLeaver).
const DK_SWAP = { flood: 1.6, open: 0.8, out: 0, in: 0, close: 0.8, drain: 2.2 };
const DK_IN_START = 200; // where the next ship waits, outside the dock, until the old one has cleared the lane
const DK_HOLD_X = 700; // where the next ship first appears: far out of sight, then it sails up to the waiting point
const DK_ARRIVE_SPEED = 22; // its cruising speed (units/s)
const DK_ARRIVE_ACCEL = 4; // how gently it speeds up and slows down (units/s^2)
const LEAVER = { backMax: 22, back: 6, pivot: 0.8, pivotAccel: 0.8, ahead: 4, aheadMax: 30, heading: 0.7 };
const dockScene = new THREE.Scene();
const dockCamera = new THREE.PerspectiveCamera(48, 16 / 9, 0.5, 10000);
const dock3 = {
  built: false, openStart: null, ship: null, shipId: null, shipX: 0, level: DK.FLOOR, gate: 0,
  phase: "clip", pt: 0, shift: 0, time: 0, camAngle: -0.45, look: new THREE.Vector3(), rig: null, rig2: null,
  lookVel: new THREE.Vector3(), shipV: 0, obstacles: [], gateObj: null, basin: null, sea: null, cranes: [], gulls: [], people: [], smoke: [], sparks: null, weldLight: null,
  emitters: [], next: null, leaving: null, clipT: 0, movers: [], blink: [], litMats: [], pools: [], spots: [], truckGlows: [], stars: null, skyDome: null, sunLight: null, hemi: null,
  nightApplied: null
};
let DM = null; // dockyard materials

function seeded(seed) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function dockTexture(base, paint) {
  const size = clamp(Math.round(base * dkq.tex), 64, 2048);
  const k = size / base;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const c = cv.getContext("2d");
  c.scale(k, k);
  paint(c, base);
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (k >= 2) {
    // real fine grain at the higher resolutions, not just a bigger picture
    const rnd = seeded(31 + size);
    for (let i = 0; i < size * size * 0.025; i++) {
      const v = 70 + Math.floor(rnd() * 120);
      c.fillStyle = `rgba(${v},${v},${v},0.13)`;
      c.fillRect(rnd() * size, rnd() * size, 1, 1);
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(QUALITY_LEVELS[perf.level].aniso, renderer.capabilities.getMaxAnisotropy());
  return t;
}

const tiledCache = new Map();
// A material whose texture repeats every `tile` units over a w x h face.
function tiledMat(tex, w, h, tile, extra = {}) {
  const key = `${tex.uuid}|${Math.round((w / tile) * 10)}|${Math.round((h / tile) * 10)}|${extra.color || 0}|${extra.roughness || 0}|${extra.metalness || 0}`;
  if (!tiledCache.has(key)) {
    const t = tex.clone();
    t.repeat.set(w / tile, h / tile);
    t.needsUpdate = true;
    tiledCache.set(key, new THREE.MeshStandardMaterial({ map: t, roughness: 0.95, metalness: 0, ...(dkq.bump ? { bumpMap: t, bumpScale: 1.6 } : {}), ...extra }));
  }
  return tiledCache.get(key);
}

function dockTextures() {
  const rnd = seeded(7);
  const speckle = (c, s, n, base, spread, size) => {
    for (let i = 0; i < n; i++) {
      const v = base + Math.floor((rnd() - 0.5) * spread);
      c.fillStyle = `rgba(${v},${v},${v},${0.18 + rnd() * 0.3})`;
      c.fillRect(rnd() * s, rnd() * s, 1 + rnd() * size, 1 + rnd() * size);
    }
  };
  const concrete = dockTexture(256, (c, s) => {
    c.fillStyle = "#8e8d87";
    c.fillRect(0, 0, s, s);
    speckle(c, s, 7000, 130, 90, 2.5);
    for (let i = 0; i < 4; i++) {
      const x = rnd() * s;
      const y = rnd() * s;
      const g = c.createRadialGradient(x, y, 2, x, y, 30 + rnd() * 40);
      g.addColorStop(0, "rgba(40,40,36,0.16)");
      g.addColorStop(1, "rgba(40,40,36,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, s, s);
    }
    c.strokeStyle = "rgba(35,35,32,0.4)";
    c.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      let x = rnd() * s;
      let y = rnd() * s;
      c.beginPath();
      c.moveTo(x, y);
      for (let k = 0; k < 7; k++) {
        x += (rnd() - 0.5) * 26;
        y += (rnd() - 0.2) * 18;
        c.lineTo(x, y);
      }
      c.stroke();
    }
    c.strokeStyle = "rgba(25,25,22,0.7)";
    c.lineWidth = 3;
    c.strokeRect(0, 0, s, s);
  });
  const asphalt = dockTexture(256, (c, s) => {
    c.fillStyle = "#3b3d40";
    c.fillRect(0, 0, s, s);
    speckle(c, s, 9000, 70, 80, 2);
    c.fillStyle = "rgba(240,200,40,0.9)";
    c.fillRect(0, s / 2 - 3, s * 0.55, 6);
    c.fillStyle = "rgba(235,235,235,0.85)";
    c.fillRect(0, 2, s, 4);
    c.fillRect(0, s - 6, s, 4);
  });
  const corrugated = dockTexture(128, (c, s) => {
    for (let i = 0; i < 16; i++) {
      const g = c.createLinearGradient(i * 8, 0, i * 8 + 8, 0);
      g.addColorStop(0, "#d9dde0");
      g.addColorStop(0.5, "#98a0a6");
      g.addColorStop(1, "#c9cfd3");
      c.fillStyle = g;
      c.fillRect(i * 8, 0, 8, s);
    }
    for (let i = 0; i < 18; i++) {
      c.fillStyle = `rgba(120,70,40,${0.05 + rnd() * 0.1})`;
      c.fillRect(rnd() * s, 0, 1 + rnd() * 3, s * (0.3 + rnd() * 0.7));
    }
  });
  const container = dockTexture(128, (c, s) => {
    c.fillStyle = "#cfcfcf";
    c.fillRect(0, 0, s, s);
    for (let i = 0; i < 14; i++) {
      c.fillStyle = i % 2 ? "#b4b4b4" : "#dcdcdc";
      c.fillRect(8 + i * 8, 6, 8, s - 12);
    }
    c.fillStyle = "#8c8c8c";
    c.fillRect(0, 0, s, 6);
    c.fillRect(0, s - 6, s, 6);
    c.fillRect(0, 0, 8, s);
    c.fillRect(s - 8, 0, 8, s);
    speckle(c, s, 500, 120, 80, 2);
  });
  const wood = dockTexture(128, (c, s) => {
    c.fillStyle = "#8a6a45";
    c.fillRect(0, 0, s, s);
    for (let i = 0; i < 8; i++) {
      c.fillStyle = `rgba(${60 + rnd() * 40},${40 + rnd() * 30},20,0.4)`;
      c.fillRect(0, i * 16, s, 2);
    }
    for (let i = 0; i < 150; i++) {
      c.fillStyle = `rgba(50,30,15,${0.1 + rnd() * 0.15})`;
      c.fillRect(rnd() * s, rnd() * s, 8 + rnd() * 30, 1);
    }
  });
  const sign = dockTexture(1024, (c, s) => {
    c.fillStyle = "#12304a";
    c.fillRect(0, 0, s, s);
    c.fillStyle = "#f0b323";
    c.fillRect(0, 0, s, s * 0.06);
    c.fillRect(0, s * 0.94, s, s * 0.06);
    c.fillStyle = "#f4f7fa";
    c.font = "bold 150px Segoe UI, Arial";
    c.textAlign = "center";
    c.fillText("HARBOUR RUN", s / 2, s * 0.42);
    c.font = "bold 110px Segoe UI, Arial";
    c.fillStyle = "#f0b323";
    c.fillText("SHIPYARD & DRY DOCK", s / 2, s * 0.68);
    c.font = "60px Segoe UI, Arial";
    c.fillStyle = "#cfe3f0";
    c.fillText("REPAIRS  -  REFITS  -  UPGRADES", s / 2, s * 0.84);
  });
  const wt = windowTextures();
  const win = wt.wall;
  win.wrapS = win.wrapT = THREE.RepeatWrapping;
  wt.glowA.wrapS = wt.glowA.wrapT = THREE.RepeatWrapping;
  return { concrete, asphalt, corrugated, container, wood, sign, win, glow: wt.glowA };
}

function dockMaterials(T) {
  return {
    steel: mat(0x6c7782, { roughness: 0.5, metalness: 0.7 }),
    darkSteel: mat(0x2c3238, { roughness: 0.55, metalness: 0.6 }),
    yellow: mat(0xe7b016, { roughness: 0.55, metalness: 0.3 }),
    orange: mat(0xe0661a, { roughness: 0.55, metalness: 0.3 }),
    red: mat(0x8a2e24, { roughness: 0.6, metalness: 0.3 }),
    darkRed: mat(0x5c1f19, { roughness: 0.65, metalness: 0.3 }),
    white: mat(0xf1f1ee, { roughness: 0.6 }),
    rubber: mat(0x151515, { roughness: 0.9 }),
    glass: mat(0x1d3347, { roughness: 0.1, metalness: 0.8 }),
    rail: mat(0x4a4e52, { roughness: 0.4, metalness: 0.8 }),
    wood: mat(0xffffff, { map: T.wood, roughness: 0.85 }),
    timber: mat(0x6b4a2b, { roughness: 0.9 }),
    concreteBit: mat(0xffffff, { map: T.concrete, roughness: 0.95 }),
    jeans: mat(0x24344a, { roughness: 0.9 }),
    skinA: mat(0xd9a982, { roughness: 0.8 }),
    skinB: mat(0x7a5238, { roughness: 0.8 }),
    hatWhite: mat(0xf4f4f0, { roughness: 0.5 }),
    hatYellow: mat(0xf2c21a, { roughness: 0.5 }),
    vestOrange: mat(0xff6a10, { roughness: 0.7 }),
    vestLime: mat(0xc6e61a, { roughness: 0.7 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xfff1c9, emissive: 0xffe3a0, emissiveIntensity: 1.2 }),
    hazard: mat(0xf2c21a, { roughness: 0.6 }),
    tank: mat(0xe9ece9, { roughness: 0.45, metalness: 0.2 }),
    barrelRed: mat(0xb3261e, { roughness: 0.6, metalness: 0.3 }),
    barrelBlue: mat(0x1d4f9c, { roughness: 0.6, metalness: 0.3 }),
    barrelYellow: mat(0xe0b21a, { roughness: 0.6, metalness: 0.3 }),
    box: (hex) => mat(hex, { map: T.container, roughness: 0.55, metalness: 0.35 })
  };
}

// A wall of windows; the lit panes glow at night (dock3.litMats).
function litWallMat(T, w, h, tile, tint) {
  const m = tiledMat(T.win, w, h, tile, { color: tint });
  if (!m.emissiveMap) {
    const g = T.glow.clone();
    g.repeat.copy(m.map.repeat);
    g.needsUpdate = true;
    m.emissiveMap = g;
    m.emissive = new THREE.Color(0xffd48a);
    m.emissiveIntensity = 0;
    dock3.litMats.push(m);
  }
  return m;
}

function strut(a, b, r, material, seg = 6) {
  const d = new THREE.Vector3().subVectors(b, a);
  const m = mesh(CylG(r, r, d.length(), seg), material);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return m;
}

// A concrete block with texture that repeats every `tile` units on every face.
function slabBox(S, T, w, h, d, x, y, z, tile = 14) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [
    tiledMat(T.concrete, d, h, tile), tiledMat(T.concrete, d, h, tile),
    tiledMat(T.concrete, w, d, tile), tiledMat(T.concrete, w, d, tile),
    tiledMat(T.concrete, w, h, tile), tiledMat(T.concrete, w, h, tile)
  ]);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  S.add(m);
  return m;
}

function wheelMesh(r, w) {
  return mesh(CylG(r, r, w, 14).rotateX(Math.PI / 2), DM.rubber);
}

function makeWorker(R, vest, scale = 1.7) {
  const g = new THREE.Group();
  const skin = R() > 0.5 ? DM.skinA : DM.skinB;
  g.add(box(0.075, 0.27, 0.09, DM.jeans, -0.05, 0.135, 0));
  g.add(box(0.075, 0.27, 0.09, DM.jeans, 0.05, 0.135, 0));
  g.add(box(0.2, 0.25, 0.11, vest, 0, 0.4, 0));
  g.add(box(0.05, 0.22, 0.06, vest, -0.125, 0.4, 0));
  g.add(box(0.05, 0.22, 0.06, vest, 0.125, 0.4, 0));
  g.add(mesh(SphG(0.06, 10, 8), skin));
  g.children[g.children.length - 1].position.y = 0.59;
  const hat = mesh(SphG(0.07, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), R() > 0.5 ? DM.hatWhite : DM.hatYellow);
  hat.position.y = 0.6;
  g.add(hat);
  g.scale.setScalar(scale);
  return g;
}

function makeTruck(color) {
  const g = new THREE.Group();
  const body = mat(color, { roughness: 0.5, metalness: 0.4 });
  g.add(box(5.4, 0.4, 1.9, DM.darkSteel, 0, 0.8, 0));
  g.add(box(1.7, 1.5, 1.9, body, 1.95, 1.7, 0));
  g.add(box(0.1, 0.7, 1.7, DM.glass, 2.82, 1.95, 0));
  truckLights(g, 2.8, 1.2, [-0.6, 0.6]);
  g.add(box(3.4, 0.2, 1.95, DM.timber, -0.9, 1.1, 0));
  g.add(box(3.4, 0.5, 0.1, body, -0.9, 1.35, 0.95));
  g.add(box(3.4, 0.5, 0.1, body, -0.9, 1.35, -0.95));
  for (const x of [-2, -0.7, 2]) for (const z of [-0.95, 0.95]) {
    const w = wheelMesh(0.55, 0.4);
    w.position.set(x, 0.55, z);
    g.add(w);
  }
  return g;
}

// Headlights: a lamp that glows at night (see applyDockNight).
function truckLights(g, x, y, zs) {
  for (const z of zs) {
    g.add(box(0.14, 0.3, 0.42, DM.lamp, x, y, z));
    // a soft round glow (no thin streaks, which shimmer as the lorry moves), just ahead of the lamp
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSoft, color: 0xfff0c0, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.setScalar(2.6);
    glow.position.set(x + 0.6, y, z);
    glow.visible = false;
    g.add(glow);
    dock3.truckGlows.push(glow);
  }
}

// Heavy lorries (nose towards +x): container, tanker, tipper and mobile crane.
function makeBigTruck(cabColor, kind, boxColor) {
  const g = new THREE.Group();
  const cab = mat(cabColor, { roughness: 0.5, metalness: 0.4 });
  g.add(box(8.6, 0.35, 1.7, DM.darkSteel, -0.8, 0.85, 0));
  g.add(box(1.8, 1.7, 2.0, cab, 3.1, 1.9, 0));
  g.add(box(0.1, 0.8, 1.8, DM.glass, 4.02, 2.2, 0));
  g.add(box(0.7, 0.5, 2.0, DM.darkSteel, 4.0, 1.0, 0));
  g.add(box(1.0, 0.4, 2.1, cab, 2.0, 2.9, 0));
  if (kind === "container") {
    g.add(mesh(new THREE.BoxGeometry(6.2, 1.8, 2.0), DM.box(boxColor)));
    g.children[g.children.length - 1].position.set(-1.6, 2.2, 0);
  } else if (kind === "tanker") {
    const tank = mesh(CylG(1.0, 1.0, 6.4, 18).rotateZ(Math.PI / 2), DM.tank);
    tank.position.set(-1.4, 2.1, 0);
    g.add(tank);
    for (const x of [-3.6, -2.4, -0.4, 0.8]) {
      const ring = mesh(CylG(1.04, 1.04, 0.12, 18).rotateZ(Math.PI / 2), DM.steel);
      ring.position.set(x, 2.1, 0);
      g.add(ring);
    }
    g.add(box(0.5, 0.3, 0.5, DM.darkSteel, -1.4, 3.2, 0));
  } else if (kind === "tipper") {
    g.add(box(6.0, 0.25, 2.1, DM.orange, -1.5, 1.2, 0));
    for (const z of [-1.0, 1.0]) g.add(box(6.0, 1.1, 0.12, DM.orange, -1.5, 1.8, z));
    g.add(box(0.12, 1.1, 2.1, DM.orange, -4.5, 1.8, 0));
    g.add(box(1.4, 0.9, 0.12, DM.orange, 1.45, 2.4, 0));
  } else {
    g.add(box(2.0, 0.8, 2.0, DM.yellow, -0.2, 1.5, 0));
    g.add(strut(new THREE.Vector3(-0.8, 2.0, 0), new THREE.Vector3(-4.6, 5.2, 0), 0.22, DM.yellow, 8));
    g.add(strut(new THREE.Vector3(-4.6, 5.2, 0), new THREE.Vector3(-4.6, 3.4, 0), 0.04, DM.darkSteel));
    g.add(box(0.5, 0.6, 0.5, DM.darkSteel, -4.6, 3.1, 0));
    for (const z of [-1.7, 1.7]) g.add(box(0.5, 0.2, 1.0, DM.darkSteel, -1.0, 0.7, z));
  }
  for (const x of [3.1, -1.8, -3.0, -4.2]) for (const z of [-0.95, 0.95]) {
    const w = wheelMesh(0.62, 0.45);
    w.position.set(x, 0.62, z);
    g.add(w);
  }
  truckLights(g, 4.4, 1.1, [-0.7, 0.7]);
  return g;
}

function makeForklift() {
  const g = new THREE.Group();
  g.add(box(1.7, 0.7, 1.0, DM.yellow, 0, 0.7, 0));
  g.add(box(0.7, 0.55, 1.0, DM.darkSteel, -0.9, 0.85, 0));
  g.add(box(0.12, 1.7, 0.12, DM.darkSteel, 1.0, 1.1, -0.35));
  g.add(box(0.12, 1.7, 0.12, DM.darkSteel, 1.0, 1.1, 0.35));
  for (const z of [-0.3, 0.3]) g.add(box(0.9, 0.08, 0.14, DM.darkSteel, 1.45, 0.3, z));
  for (const x of [-0.5, 0.45]) for (const z of [-0.45, 0.45]) g.add(box(0.07, 1.0, 0.07, DM.darkSteel, x, 1.55, z));
  g.add(box(1.1, 0.07, 1.0, DM.darkSteel, -0.02, 2.05, 0));
  for (const x of [-0.6, 0.6]) for (const z of [-0.5, 0.5]) {
    const w = wheelMesh(0.33, 0.25);
    w.position.set(x, 0.33, z);
    g.add(w);
  }
  return g;
}

// Crane that rolls on rails along the dock; it carries a trolley and a hook.
function makePortalCrane(carry) {
  const g = new THREE.Group();
  const H = 58;
  const SZ = 28;
  const BASE = 6;
  for (const s of [-1, 1]) {
    for (const x of [-BASE, BASE]) g.add(box(1.5, H, 1.5, DM.yellow, x, H / 2, s * SZ));
    const ys = [0, 0.18, 0.4, 0.62, 0.84, 1].map((k) => k * H);
    for (let i = 0; i < 5; i++) {
      g.add(box(BASE * 2, 0.8, 0.8, DM.yellow, 0, ys[i + 1], s * SZ));
      const flip = i % 2 ? 1 : -1;
      g.add(strut(new THREE.Vector3(flip * BASE, ys[i], s * SZ), new THREE.Vector3(-flip * BASE, ys[i + 1], s * SZ), 0.28, DM.yellow));
    }
    g.add(box(BASE * 2 + 3, 1.4, 2.4, DM.darkSteel, 0, 0.9, s * SZ));
    for (const x of [-BASE - 1.2, -BASE + 1.2, BASE - 1.2, BASE + 1.2]) {
      const w = wheelMesh(0.9, 0.7);
      w.position.set(x, 0.9, s * SZ);
      g.add(w);
    }
  }
  g.add(box(7, 4.2, SZ * 2 + 10, DM.yellow, 0, H + 2.1, 0));
  for (let i = -13; i <= 13; i++) for (const sx of [-3.55, 3.55]) g.add(box(0.3, 3.6, 0.4, DM.darkSteel, sx, H + 2.1, i * 2.2));
  g.add(box(5.2, 3.2, 5.2, DM.white, 0, H + 5.8, SZ + 3));
  g.add(box(2.4, 0.8, 2.4, DM.darkSteel, 0, H + 7.8, SZ + 3));
  // operator's cab hung under the girder
  g.add(box(3.2, 3, 3.2, DM.white, 0, H - 2.2, -12));
  g.add(box(3.3, 1.4, 2.6, DM.glass, 0.05, H - 1.9, -12));
  g.add(box(0.6, 1.6, 0.6, DM.darkSteel, 0, H - 0.6, -12));
  for (const [x, z] of [[-3.4, -SZ - 3], [3.4, -SZ - 3], [-3.4, SZ + 3], [3.4, SZ + 3]]) {
    const lamp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowStar, color: 0xff2a1a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    lamp.scale.setScalar(3);
    lamp.position.set(x, H + 4.6, z);
    g.add(lamp);
    dock3.blink.push(lamp);
  }
  // trolley, rope and hook block
  const trolley = new THREE.Group();
  trolley.add(box(5, 1.6, 5, DM.darkSteel, 0, H - 1.1, 0));
  trolley.add(box(3.5, 1.2, 3.5, DM.yellow, 0, H - 2.5, 0));
  const cable = mesh(CylG(0.1, 0.1, 1, 6), DM.darkSteel);
  trolley.add(cable);
  const hook = new THREE.Group();
  hook.add(box(1.6, 2.2, 1.6, DM.yellow, 0, 0, 0));
  hook.add(mesh(new THREE.TorusGeometry(0.7, 0.18, 8, 14, Math.PI * 1.4), DM.darkSteel));
  hook.children[1].position.y = -1.7;
  if (carry) {
    hook.add(strut(new THREE.Vector3(0, -1.2, 0), new THREE.Vector3(-5, -4.4, 0), 0.08, DM.darkSteel));
    hook.add(strut(new THREE.Vector3(0, -1.2, 0), new THREE.Vector3(5, -4.4, 0), 0.08, DM.darkSteel));
    hook.add(box(12, 0.6, 0.6, DM.darkSteel, 0, -4.6, 0));
    hook.add(box(10, 3.4, 5, mat(0x2f6f9f, { roughness: 0.5, metalness: 0.4 }), 0, -6.6, 0));
  }
  trolley.add(hook);
  g.add(trolley);
  return { group: g, trolley, hook, cable, H, SZ };
}

function buildDockPit(S, T, R) {
  const { L, W, FLOOR, Q, GX } = DK;
  const hl = L / 2;
  const hw = W / 2;
  // land around the pit, and the pit's floor
  slabBox(S, T, 460, 14, 720, -65 - 230, Q - 7, 0);
  slabBox(S, T, 130, 14, 337, 0, Q - 7, hw + 337 / 2);
  slabBox(S, T, 130, 14, 337, 0, Q - 7, -(hw + 337 / 2));
  slabBox(S, T, L, 2, W, 0, FLOOR - 1, 0, 10);
  for (const s of [-1, 1]) {
    // stepped altars on the long walls, coping stones on the edge
    slabBox(S, T, L - 6, 0.5, 1.4, -3, -2.75, s * (hw - 0.7), 6);
    slabBox(S, T, L - 6, 0.5, 1.4, -3, -5.5, s * (hw - 0.7), 6);
    slabBox(S, T, L, 0.6, 1.6, 0, Q + 0.05, s * (hw + 0.8), 6);
    const line = box(L, 0.03, 0.3, DM.hazard, 0, Q + 0.02, s * (hw + 2.4));
    line.castShadow = false;
    S.add(line);
  }
  slabBox(S, T, 1.6, 0.6, W + 3.2, -hl - 0.8, Q + 0.05, 0, 6);
  // drain trenches and the centre line on the floor
  const dark = mat(0x1d2124, { roughness: 0.6, metalness: 0.4 });
  S.add(box(L - 4, 0.1, 1.2, dark, 0, FLOOR + 0.02, 0));
  for (let x = -55; x <= 55; x += 22) S.add(box(0.7, 0.1, W - 2, dark, x, FLOOR + 0.03, 0));
  S.add(box(L - 8, 0.03, 0.12, DM.white, 0, FLOOR + 0.07, 0));
  // pump outlets in the head wall
  for (const z of [-8, 0, 8]) {
    const pipe = mesh(CylG(0.9, 0.9, 1.6, 16).rotateZ(Math.PI / 2), DM.steel);
    pipe.position.set(-hl + 0.7, FLOOR + 1.8, z);
    S.add(pipe);
    const flange = mesh(CylG(1.15, 1.15, 0.25, 16).rotateZ(Math.PI / 2), DM.darkSteel);
    flange.position.set(-hl + 1.45, FLOOR + 1.8, z);
    S.add(flange);
  }
  // stairs down the +z wall near the head
  for (let k = 0; k < 12; k++) {
    const top = Q - 1 - k;
    slabBox(S, T, 1.2, top - FLOOR, 3, -44 - k * 1.2 - 0.6, (top + FLOOR) / 2, hw - 1.5, 6);
  }
  // ladders on the -z wall
  for (const x of [-30, 8, 40]) {
    for (const dx of [-0.35, 0.35]) S.add(box(0.08, Q - FLOOR + 1.2, 0.08, DM.steel, x + dx, (Q + 1.2 + FLOOR) / 2, -hw + 0.12));
    for (let y = FLOOR + 0.5; y < Q + 1; y += 0.45) S.add(box(0.8, 0.05, 0.05, DM.steel, x, y, -hw + 0.12));
  }
  // bollards, rail tracks and sleepers on the quay
  const RAIL_LEN = 122; // x = -61 .. 61
  for (const s of [-1, 1]) {
    for (let x = -60; x <= 60; x += 10) {
      const b = mesh(CylG(0.32, 0.4, 0.7, 10), DM.darkSteel);
      b.position.set(x, Q + 0.35, s * (hw + 3.2));
      S.add(b);
      const cap = mesh(SphG(0.4, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), DM.darkSteel);
      cap.position.set(x, Q + 0.7, s * (hw + 3.2));
      S.add(cap);
    }
    // the quay ends at the gate (x = GX), so the crane rails stop short of it, just past the crane's furthest reach
    S.add(box(RAIL_LEN, 0.22, 0.28, DM.rail, 0, Q + 0.11, s * 28 - 0.45));
    S.add(box(RAIL_LEN, 0.22, 0.28, DM.rail, 0, Q + 0.11, s * 28 + 0.45));
    for (let x = -RAIL_LEN / 2 + 1; x <= RAIL_LEN / 2 - 1; x += 1.8) S.add(box(0.4, 0.1, 2.4, DM.timber, x, Q + 0.05, s * 28));
    // drain grates and manholes
    for (let x = -50; x <= 50; x += 25) {
      S.add(box(1.6, 0.04, 0.6, dark, x, Q + 0.03, s * 36));
      const mh = mesh(CylG(0.5, 0.5, 0.04, 16), dark);
      mh.position.set(x + 8, Q + 0.03, s * 40);
      S.add(mh);
    }
  }
}

function buildDockGate() {
  const { W, FLOOR, GX } = DK;
  const g = new THREE.Group();
  const top = 3.5;
  const h = top - FLOOR;
  const mid = (top + FLOOR) / 2;
  g.add(box(2.4, h, W + 1.2, DM.red, 0, mid, 0));
  for (let z = -W / 2; z <= W / 2; z += 2.3) g.add(box(0.5, h - 1, 0.5, DM.darkRed, 1.45, mid, z));
  for (const y of [-6, -2, 1.5]) g.add(box(0.6, 0.6, W, DM.darkRed, 1.5, y, 0));
  g.add(box(3.4, 0.18, W + 1, DM.darkSteel, 0, top + 0.1, 0));
  for (const s of [-1, 1]) {
    for (let z = -W / 2; z <= W / 2; z += 3) g.add(box(0.07, 1.1, 0.07, DM.yellow, s * 1.6, top + 0.7, z));
    g.add(box(0.07, 0.07, W, DM.yellow, s * 1.6, top + 1.25, 0));
    g.add(box(0.07, 0.07, W, DM.yellow, s * 1.6, top + 0.7, 0));
  }
  for (const z of [-12, 12]) {
    const bitt = mesh(CylG(0.3, 0.4, 0.8, 10), DM.darkSteel);
    bitt.position.set(0, top + 0.6, z);
    g.add(bitt);
  }
  g.position.set(GX - 1.5, 0, 0);
  dockScene.add(g);
  dock3.gateObj = g;
}

function buildDockCranes(S) {
  const { Q } = DK;
  for (const [x, carry, phase] of [[-32, true, 0], [34, false, 2.1]]) {
    const c = makePortalCrane(carry);
    c.group.position.set(x, Q, 0);
    c.baseX = x;
    c.phase = phase;
    dockScene.add(c.group);
    dock3.cranes.push(c);
  }
}

function dockBuilding(S, T, x, z, w, d, h, wallTex, rise, tint) {
  const wall = (a, b) => (wallTex === T.win ? litWallMat(T, a, b, 6, tint) : tiledMat(wallTex, a, b, 6, { color: tint }));
  const wallMats = [wall(d, h), wall(d, h), wall(w, d), wall(w, d), wall(w, h), wall(w, h)];
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMats);
  body.position.set(x, DK.Q + h / 2, z);
  body.castShadow = body.receiveShadow = true;
  S.add(body);
  if (rise > 0) {
    const a = Math.atan2(rise, w / 2);
    const len = w / 2 / Math.cos(a) + 0.6;
    const roofMat = tiledMat(T.corrugated, len, d, 6, { color: 0x8d9aa3, metalness: 0.3 });
    for (const s of [-1, 1]) {
      const roof = new THREE.Mesh(new THREE.BoxGeometry(len, 0.35, d + 1.2), roofMat);
      roof.position.set(x + (s * w) / 4, DK.Q + h + rise / 2, z);
      roof.rotation.z = -s * a;
      roof.castShadow = roof.receiveShadow = true;
      S.add(roof);
    }
    const tri = new THREE.Shape([new THREE.Vector2(-w / 2, 0), new THREE.Vector2(w / 2, 0), new THREE.Vector2(0, rise)]);
    for (const s of [-1, 1]) {
      const gable = new THREE.Mesh(new THREE.ShapeGeometry(tri), tiledMat(wallTex, w, rise, 6, { color: tint, side: THREE.DoubleSide }));
      gable.position.set(x, DK.Q + h, z + (s * d) / 2);
      S.add(gable);
    }
  } else {
    S.add(box(w + 0.6, 0.5, d + 0.6, DM.concreteBit, x, DK.Q + h + 0.25, z));
  }
}

function buildDockYard(S, T, R) {
  const { Q } = DK;
  // roads
  const road = (cx, cz, len, wid, alongX) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(len, wid).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: (() => { const t = T.asphalt.clone(); t.repeat.set(len / 14, 1); t.needsUpdate = true; return t; })(), roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    );
    m.position.set(cx, Q + 0.04, cz);
    if (!alongX) m.rotation.y = Math.PI / 2;
    m.receiveShadow = true;
    S.add(m);
  };
  road(-136, 48, 388, 9, true);
  road(-136, -48, 388, 9, true);
  road(-318, 0, 105, 9, false);
  road(-80, 0, 96, 9, false);
  // the big workshop with its sign
  dockBuilding(S, T, -120, 108, 100, 56, 22, T.corrugated, 5, 0xb9c4cc);
  for (let i = 0; i < 4; i++) {
    S.add(box(10, 11, 0.4, mat(0x3a4a4f, { roughness: 0.5, metalness: 0.4 }), -152 + i * 21, Q + 5.5, 108 - 28.2));
    S.add(box(10.6, 0.5, 0.3, DM.hazard, -152 + i * 21, Q + 11.3, 108 - 28.3));
  }
  const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(40, 10), new THREE.MeshStandardMaterial({ map: T.sign, roughness: 0.6 }));
  signMesh.position.set(-120, Q + 17, 108 - 28.25);
  signMesh.rotation.y = Math.PI;
  S.add(signMesh);
  for (let i = 0; i < 9; i++) S.add(box(8, 0.12, 0.1, DM.glass, -156 + i * 9, Q + 14.4, 108 - 28.25));
  for (let i = 0; i < 6; i++) {
    const vent = mesh(CylG(0.9, 1.1, 1.2, 10), DM.steel);
    vent.position.set(-150 + i * 14, Q + 22 + 5.6, 108 + (i % 2 ? 6 : -6));
    S.add(vent);
  }
  // offices and a long tool shed
  dockBuilding(S, T, -20, 78, 32, 16, 14, T.win, 0, 0xe6dcc4);
  dockBuilding(S, T, -64, 78, 24, 10, 6, T.corrugated, 2, 0x9fb09c);
  dockBuilding(S, T, -80, 0, 22, 16, 9, T.corrugated, 2, 0xb0b8bc); // pump house
  for (const z of [-6, 0, 6]) {
    const p = mesh(CylG(0.6, 0.6, 14, 12).rotateZ(Math.PI / 2), DM.steel);
    p.position.set(-62 - 1, Q + 0.8, z);
    S.add(p);
  }
  // fuel tank farm with a bund wall
  for (const z of [-150, -112, -74]) {
    const tank = mesh(CylG(9, 9, 12, 28), DM.tank);
    tank.position.set(-300, Q + 6, z);
    S.add(tank);
    const roof = mesh(CylG(0.4, 9.2, 1.8, 28), DM.tank);
    roof.position.set(-300, Q + 12.9, z);
    S.add(roof);
    for (let k = 1; k < 4; k++) {
      const band = mesh(CylG(9.08, 9.08, 0.25, 28), DM.steel);
      band.position.set(-300, Q + k * 3, z);
      S.add(band);
    }
    S.add(box(0.2, 12, 0.7, DM.darkSteel, -300 + 9.2, Q + 6, z));
    S.add(box(3, 0.15, 1.5, DM.darkSteel, -300 + 8, Q + 12.2, z));
  }
  slabBox(S, T, 34, 1.6, 1, -300, Q + 0.8, -166, 6);
  slabBox(S, T, 34, 1.6, 1, -300, Q + 0.8, -58, 6);
  slabBox(S, T, 1, 1.6, 108, -317, Q + 0.8, -112, 6);
  slabBox(S, T, 1, 1.6, 108, -283, Q + 0.8, -112, 6);
  // striped chimney
  for (let i = 0; i < 6; i++) {
    const seg = mesh(CylG(2.6 - i * 0.2, 2.8 - i * 0.2, 10, 16), i % 2 ? DM.white : DM.red);
    seg.position.set(-250, Q + 5 + i * 10, 140);
    S.add(seg);
  }
  const lampHead = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowStar, color: 0xff2a1a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  lampHead.scale.setScalar(4);
  lampHead.position.set(-250, Q + 62, 140);
  dockScene.add(lampHead);
  dock3.blink.push(lampHead);

  // container yard (instanced)
  const cGeo = new THREE.BoxGeometry(2, 0.87, 0.8);
  const cMat = new THREE.MeshStandardMaterial({ map: T.container, roughness: 0.55, metalness: 0.35, ...(dkq.bump ? { bumpMap: T.container, bumpScale: 1.2 } : {}) });
  const spots = [];
  const blockZ = [-72, -100, -128, -156];
  for (const bz of blockZ) {
    for (let col = 0; col < 62; col++) {
      for (let row = 0; row < 5; row++) {
        if (R() < 1 - 0.78 * Math.min(1, dkq.props)) continue;
        const stack = 1 + Math.floor(R() * 4);
        for (let k = 0; k < stack; k++) spots.push([-250 + col * 2.2, Q + 0.44 + k * 0.87, bz - row * 0.9]);
      }
    }
  }
  const cont = new THREE.InstancedMesh(cGeo, cMat, spots.length);
  cont.castShadow = cont.receiveShadow = true;
  const cols = [0xb2362b, 0x2a5fa8, 0x2f8a52, 0xd7a21a, 0x8b8f93, 0x1f2f4a, 0xc8602a, 0x6c3b8c];
  const mm = new THREE.Matrix4();
  const cc = new THREE.Color();
  spots.forEach((p, i) => {
    cont.setMatrixAt(i, mm.makeTranslation(p[0], p[1], p[2]));
    cont.setColorAt(i, cc.setHex(cols[Math.floor(R() * cols.length)]));
  });
  S.add(cont);

  // loose stock: steel plate stacks, pipe racks, drums, cable reels, timber
  for (let i = 0; i < 6; i++) S.add(box(4, 0.7 + R() * 0.6, 1.5, DM.darkSteel, -200 + i * 6, Q + 0.5, 22 + (i % 2) * 6 + 40));
  for (let r = 0; r < 3; r++) for (let k = 0; k < 4 - r; k++) {
    const pipe = mesh(CylG(0.28, 0.28, 12, 12).rotateZ(Math.PI / 2), DM.steel);
    pipe.position.set(-176, Q + 0.6 + r * 0.55, 62 + k * 0.6 + r * 0.3);
    S.add(pipe);
  }
  for (const x of [-181, -171]) S.add(box(0.3, 1.2, 3, DM.timber, x, Q + 0.6, 63.2));
  const drums = new THREE.InstancedMesh(CylG(0.22, 0.22, 0.6, 12), DM.barrelRed, 48);
  for (let i = 0; i < 48; i++) {
    drums.setMatrixAt(i, mm.makeTranslation(-205 + (i % 12) * 0.55, Q + 0.3, 38 + Math.floor(i / 12) * 0.55));
    drums.setColorAt(i, cc.setHex([0xb3261e, 0x1d4f9c, 0xe0b21a][i % 3]));
  }
  drums.castShadow = true;
  S.add(drums);
  for (let i = 0; i < 3; i++) {
    const reel = mesh(CylG(1.1, 1.1, 0.2, 18).rotateX(Math.PI / 2), DM.timber);
    reel.position.set(-110 + i * 3, Q + 1.1, 30);
    const core = mesh(CylG(0.8, 0.8, 0.9, 18).rotateX(Math.PI / 2), DM.darkSteel);
    core.position.copy(reel.position);
    S.add(reel, core);
  }
  for (let i = 0; i < 5; i++) S.add(box(5, 0.22, 0.9, DM.wood, -92, Q + 0.14 + i * 0.22, 56 + 0));

  // lamp posts along the roads and floodlight towers at the dock
  const poleGeo = CylG(0.12, 0.16, 8, 8);
  for (let x = -300; x <= 40; x += 34) for (const z of [41, -41]) {
    const p = mesh(poleGeo, DM.darkSteel);
    p.position.set(x, Q + 4, z);
    S.add(p);
    S.add(box(1.4, 0.18, 0.5, DM.lamp, x, Q + 8, z));
    S.add(box(0.1, 0.1, z > 0 ? 1.2 : -1.2, DM.darkSteel, x, Q + 7.95, z > 0 ? z - 0.6 : z + 0.6));
  }
  for (const [x, z] of [[-72, -36], [-72, 36], [52, -38], [52, 38]]) {
    S.add(box(0.8, 26, 0.8, DM.darkSteel, x, Q + 13, z));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) S.add(box(1.1, 0.9, 0.3, DM.lamp, x - 1.2 + i * 1.2, Q + 26.5 + j, z));
    S.add(box(4, 0.3, 0.4, DM.darkSteel, x, Q + 25.8, z));
  }
  // pools of light on the ground at night (the higher quality levels)
  if (QUALITY_LEVELS[perf.level].townGlow) {
    const spots = [];
    for (let x = -300; x <= 40; x += 34) for (const z of [41, -41]) spots.push([x, z, 9]);
    for (const [x, z] of [[-72, -36], [-72, 36], [52, -38], [52, 38]]) spots.push([x, z, 24]);
    const im = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: glowSoft, color: 0xffc97a, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }),
      spots.length
    );
    const m4 = new THREE.Matrix4();
    spots.forEach(([x, z, r], i) => im.setMatrixAt(i, m4.makeScale(r, 1, r).setPosition(x, Q + 0.12, z)));
    im.visible = false;
    dockScene.add(im);
    dock3.pools.push(im);
  }
}

function buildDockSea(S, T, R) {
  const { Q, GX } = DK;
  const normals = new THREE.TextureLoader().load("vendor/three/textures/waternormals.jpg", (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
  });
  const sea = new Water(new THREE.PlaneGeometry(9000, 9000), {
    textureWidth: dkq.reflect, textureHeight: dkq.reflect, waterNormals: normals, sunDirection: sunDir.clone(), sunColor: 0xfff1d6,
    waterColor: 0x0a4560, distortionScale: 2.4, fog: true
  });
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(62 + 4500, 0, 0);
  sea.material.uniforms.size.value = 0.9;
  // less of the (pale) sky in the water and a little blue in what it does show, so the open sea reads like the sea in play
  sea.material.fragmentShader = sea.material.fragmentShader.replace("reflectionSample * 0.9", "reflectionSample * 0.52 * vec3(0.72, 0.9, 1.12)");
  dockScene.add(sea);
  dock3.sea = sea;
  // the water inside the dock; it rises and falls. It is the same kind of water as the open sea
  // (same colour, ripples and sky mirror), so the two meet at the gate without a seam.
  const basin = new Water(new THREE.PlaneGeometry(DK.L - 2.7, DK.W - 0.4), {
    textureWidth: Math.max(256, dkq.reflect / 2), textureHeight: Math.max(256, dkq.reflect / 2), waterNormals: normals,
    sunDirection: sunDir.clone(), sunColor: 0xfff1d6, waterColor: 0x0a4560, distortionScale: 2.4, fog: true, alpha: 1
  });
  basin.rotation.x = -Math.PI / 2;
  basin.material.uniforms.size.value = 0.9;
  basin.material.fragmentShader = sea.material.fragmentShader;
  basin.material.transparent = true; // thins out over the last bit of depth as the dock empties
  basin.position.x = -1.35;
  dockScene.add(basin);
  dock3.basin = basin;
  // shallower, greener water around the quay and the dock entrance (the open sea stays deep blue)
  const shallow = new THREE.Mesh(
    new THREE.PlaneGeometry(380, 300).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: glowTex, color: 0x3f8a9a, transparent: true, opacity: 0.4, depthWrite: false })
  );
  shallow.position.set(62 + 150, 0.08, 0);
  dockScene.add(shallow);
  dock3.shallow = shallow;
  // the dock water fades into the open sea beyond the gate instead of ending in a hard line
  const fc = document.createElement("canvas");
  fc.width = 256;
  fc.height = 64;
  const fx = fc.getContext("2d");
  const gx = fx.createLinearGradient(0, 0, 256, 0);
  gx.addColorStop(0, "rgba(255,255,255,1)");
  gx.addColorStop(0.35, "rgba(255,255,255,0.55)");
  gx.addColorStop(1, "rgba(255,255,255,0)");
  fx.fillStyle = gx;
  fx.fillRect(0, 0, 256, 64);
  const gz = fx.createLinearGradient(0, 0, 0, 64);
  gz.addColorStop(0, "rgba(0,0,0,0)");
  gz.addColorStop(0.3, "rgba(0,0,0,1)");
  gz.addColorStop(0.7, "rgba(0,0,0,1)");
  gz.addColorStop(1, "rgba(0,0,0,0)");
  fx.globalCompositeOperation = "destination-in";
  fx.fillStyle = gz;
  fx.fillRect(0, 0, 256, 64);
  const fadeTex = new THREE.CanvasTexture(fc);
  fadeTex.colorSpace = THREE.SRGBColorSpace;
  const fade = new THREE.Mesh(
    new THREE.PlaneGeometry(190, DK.W * 2.4).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: fadeTex, color: 0x1c5f78, transparent: true, opacity: 0.85, depthWrite: false })
  );
  fade.position.set(DK.GX + 95, 0.09, 0);
  dock3.fade = fade; // no longer added: the dock water now matches the open sea, so no blend patch is needed
  // earth behind the quay, with far hills and a town
  const earth = mat(0x58683f, { roughness: 1 });
  for (const [w, d, x, z] of [[5000, 9000, -3025, 0], [460, 4300, -295, 2510], [460, 4300, -295, -2510], [130, 4300, 0, 2510], [130, 4300, 0, -2510]]) {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), earth);
    ground.position.set(x, Q - 0.2, z);
    ground.receiveShadow = true;
    dockScene.add(ground);
  }
  for (const [x, z, r] of [[-2300, 900, 640], [-2600, -1100, 760], [-1900, -400, 420]]) {
    const hill = islandModel(r, true, QUALITY_LEVELS[perf.level].terrain);
    hill.position.set(x, Q - 3, z);
    dockScene.add(hill);
  }
  const win = T.win;
  for (let i = 0; i < Math.min(120, dkn(70)); i++) {
    const w = 18 + R() * 30;
    const h = 20 + R() * 70;
    const d = 18 + R() * 30;
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [0, 1, 2, 3, 4, 5].map(() => litWallMat(T, w, h, 16, [0xc9c2b4, 0xb8bcc0, 0xd2c4aa][i % 3])));
    b.position.set(-1250 - R() * 450, Q + h / 2, -600 + R() * 1200);
    S.add(b);
  }
  // quay face fenders (tyres), a tug and a pilot boat alongside
  const fend = new THREE.InstancedMesh(CylG(0.5, 0.5, 0.5, 12).rotateZ(Math.PI / 2), DM.rubber, 80);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < 80; i++) {
    const side = i < 40 ? 1 : -1;
    fend.setMatrixAt(i, m4.makeTranslation(GX + 0.45, 1.1, side * (28 + (i % 40) * 2.6)));
  }
  S.add(fend);
  for (const s of [-1, 1]) for (let z = 30; z < 140; z += 12) {
    const b = mesh(CylG(0.34, 0.42, 0.7, 10), DM.darkSteel);
    b.position.set(GX - 1.5, Q + 0.35, s * z);
    S.add(b);
  }
  const moored = (category, color, x, z, yaw) => {
    const o = createShip({ type: "cruise", category, displayColor: color, angle: 0 });
    o.root.position.set(x, 0, z);
    o.root.rotation.y = yaw;
    dockScene.add(o.root);
    o.baseY = 0;
    dock3.movers.push(o);
    dock3.obstacles.push({ x, z, r: o.halfLen * 1.25 });
    return o;
  };
  moored("Tug", "#d8452c", GX + 7, 70, -Math.PI / 2);
  moored("Catamaran", "#f2f2ee", GX + 9, -82, -Math.PI / 2);
  if (dkq.props >= 0.5) {
    moored("Cargo", "#2b5f8f", 900, -430, 2.2);
    moored("Tanker", "#7b2a24", 1250, 360, 0.9);
    moored("Cruise", "#f4f4f2", 1700, -60, -0.4);
  }
  // breakwaters with lighthouses
  const rockGeo = roughen(new THREE.DodecahedronGeometry(4.5, dkq.geo >= 1.6 ? 2 : 1), 2.2, 5);
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, 420);
  let n = 0;
  for (const [z, x0, x1, dz] of [[-250, 90, 520, 1], [230, 90, 400, -1]]) {
    for (let x = x0; x < x1; x += 3.6) for (const row of [-1, 0, 1]) {
      if (n >= 420) break;
      if (R() > Math.min(1, dkq.props * 1.2)) continue;
      const sc = 0.8 + R() * 0.7;
      m4.makeRotationFromEuler(new THREE.Euler(R() * 3, R() * 3, R() * 3));
      m4.scale(new THREE.Vector3(sc, sc * 0.8, sc));
      m4.setPosition(x, row === 0 ? 3.4 : 1.2, z + row * 7 * dz);
      rocks.setMatrixAt(n++, m4);
    }
    S.add(box(x1 - x0, 2.2, 7, DM.concreteBit, (x0 + x1) / 2, 5.4, z));
    const tower = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const seg = mesh(CylG(3.4 - i * 0.35, 3.6 - i * 0.35, 8, 16), i % 2 ? DM.red : DM.white);
      seg.position.y = 4 + i * 8;
      tower.add(seg);
    }
    tower.add(box(8, 0.5, 8, DM.darkSteel, 0, 33, 0));
    const lantern = mesh(CylG(2.2, 2.2, 3.2, 12), DM.glass);
    lantern.position.y = 35;
    tower.add(lantern);
    const cap = mesh(new THREE.ConeGeometry(2.8, 2.4, 12), DM.red);
    cap.position.y = 38.2;
    tower.add(cap);
    const lite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSoft, color: dz > 0 ? 0xff3a2a : 0x3aff6a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    lite.scale.setScalar(9);
    lite.position.y = 35;
    tower.add(lite);
    dock3.blink.push(lite);
    tower.position.set(x1, 6.3, z);
    S.add(tower);
  }
  rocks.count = n;
  // what a ship leaving the dock must steer round: the breakwaters (a row of circles along each wall)
  for (const [z, x0, x1] of [[-250, 90, 520], [230, 90, 400]]) {
    for (let x = x0; x <= x1 + 10; x += 18) dock3.obstacles.push({ x, z, r: 14 });
  }
  rocks.castShadow = true;
  S.add(rocks);
  // channel buoys
  for (let i = 0; i < 8; i++) {
    const buoy = new THREE.Group();
    const c = i % 2 ? 0xc4261c : 0x1f9a4a;
    buoy.add(mesh(CylG(0.9, 1.4, 2.4, 12), mat(c, { roughness: 0.5 })));
    buoy.add(mesh(CylG(0.15, 0.15, 3, 6), DM.darkSteel));
    buoy.children[1].position.y = 2.6;
    buoy.position.set(180 + i * 55, 0.6, (i % 2 ? 48 : -48) + (i % 3) * 6);
    buoy.userData.phase = i;
    dockScene.add(buoy);
    dock3.movers.push({ root: buoy, baseY: 0.6, buoy: true });
  }
  for (const [x, z, r] of [[1500, -800, 330], [2000, 700, 420], [1000, 1000, 260]]) {
    dock3.obstacles.push({ x, z, r: r * 0.95 });
    const isle = islandModel(r, r > 300, QUALITY_LEVELS[perf.level].terrain);
    isle.position.set(x, 0, z);
    dockScene.add(isle);
  }
}

// Site clutter around the dock edge: crates, cones, gas bottles, barriers, cabins.
// Safety barriers: a striped crash barrier across the end of each road, and a
// kerb with a steel guard rail all along the quay edge.
function buildDockBarriers(S, T) {
  const { Q, GX } = DK;
  for (const z of [48, -48]) {
    for (let i = 0; i < 6; i++) S.add(box(0.5, 0.9, 1.6, i % 2 ? DM.white : DM.red, 59.6, Q + 0.45, z - 4 + i * 1.6 + 0.8));
    S.add(box(0.2, 0.15, 9.6, DM.darkSteel, 59.6, Q + 0.95, z));
  }
  const m4 = new THREE.Matrix4();
  const posts = new THREE.InstancedMesh(CylG(0.08, 0.08, 1.1, 6), DM.hazard, 224);
  let n = 0;
  for (const s of [-1, 1]) {
    const mid = s * (26 + 358) / 2;
    const len = 358 - 26;
    S.add(box(0.6, 0.35, len, DM.concreteBit, GX - 0.5, Q + 0.17, mid));
    S.add(box(0.12, 0.14, len, DM.steel, GX - 0.7, Q + 0.95, mid));
    S.add(box(0.12, 0.14, len, DM.steel, GX - 0.7, Q + 0.62, mid));
    for (let z = 26; z <= 358 && n < 224; z += 3) posts.setMatrixAt(n++, m4.makeTranslation(GX - 0.7, Q + 0.55, s * z));
  }
  posts.count = n;
  posts.castShadow = true;
  S.add(posts);
}

function buildDockClutter(S, T, R) {
  const { Q } = DK;
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const place = (im, i, x, y, z, ry, sx = 1, sy = 1, sz = 1) => {
    q.setFromEuler(e.set(0, ry, 0));
    im.setMatrixAt(i, m4.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz)));
  };
  // The lorries drive the quay road (|z| about 38) and the two service roads (|z| about 48),
  // so crates, cones and the like only go beyond them, never on a lorry's path.
  const spot = () => {
    const side = R() > 0.5 ? 1 : -1;
    return [-60 + R() * 118, side * (58 + R() * 14)];
  };
  const nCrates = dkn(70);
  const crates = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), DM.wood, nCrates);
  for (let i = 0; i < nCrates; i++) {
    const [x, z] = spot();
    const sc = 0.7 + R() * 1.4;
    place(crates, i, x, Q + sc / 2, z, R() * 3, sc, sc * (0.7 + R() * 0.5), sc);
  }
  crates.castShadow = crates.receiveShadow = true;
  S.add(crates);
  const cones = new THREE.InstancedMesh(new THREE.ConeGeometry(0.22, 0.6, 8), mat(0xff6a10, { roughness: 0.6 }), dkn(60));
  for (let i = 0; i < dkn(60); i++) {
    const [x, z] = spot();
    place(cones, i, x, Q + 0.3, z, 0);
  }
  cones.castShadow = true;
  S.add(cones);
  const bottles = new THREE.InstancedMesh(CylG(0.16, 0.16, 1.1, 10), mat(0xffffff, { roughness: 0.4, metalness: 0.5 }), Math.min(40, dkn(40)));
  for (let i = 0; i < Math.min(40, dkn(40)); i++) {
    const g = Math.floor(i / 5);
    const bx = -50 + g * 14;
    const side = g % 2 ? 1 : -1;
    place(bottles, i, bx + (i % 5) * 0.4, Q + 0.55, side * 34 + (i % 2) * 0.4, 0);
    bottles.setColorAt(i, new THREE.Color(i % 3 ? 0xb3261e : 0x1d4f9c));
  }
  bottles.castShadow = true;
  S.add(bottles);
  const barriers = new THREE.InstancedMesh(new THREE.BoxGeometry(2.4, 0.8, 0.3), mat(0xf0f0ec, { roughness: 0.6 }), Math.min(36, dkn(36)));
  for (let i = 0; i < Math.min(36, dkn(36)); i++) {
    const side = i < 18 ? 1 : -1;
    place(barriers, i, -52 + (i % 18) * 6.5, Q + 0.4, side * 31, 0);
    barriers.setColorAt(i, new THREE.Color(i % 2 ? 0xe33a2a : 0xf0f0ec));
  }
  barriers.castShadow = true;
  S.add(barriers);
  // site cabins and skips
  for (const [x, z, ry] of [[-58, 62, 0], [-45, 63, 0], [58, -62, 0.2], [46, -62, 0]]) {
    const cab = new THREE.Group();
    cab.add(box(7, 2.6, 2.8, mat(0xd8d6cc, { roughness: 0.7 }), 0, 1.3, 0));
    cab.add(box(7.2, 0.2, 3, DM.darkSteel, 0, 2.7, 0));
    for (const wx of [-2, 2]) cab.add(box(1.2, 0.9, 0.06, DM.glass, wx, 1.6, 1.42));
    cab.add(box(0.9, 1.8, 0.06, DM.timber, 3, 0.9, 1.42));
    cab.position.set(x, Q, z);
    cab.rotation.y = ry;
    S.add(cab);
  }
  for (const [x, z] of [[-30, 60], [20, -60], [50, 60]]) {
    const skip = box(4, 1.2, 1.8, mat(0x2d6a3f, { roughness: 0.6, metalness: 0.4 }), x, Q + 0.6, z);
    S.add(skip);
    S.add(box(3.6, 0.3, 1.6, DM.rail, x, Q + 1.1, z));
  }
}

// Extra fittings for the higher quality levels: chain barriers, cable runs,
// hydrants and bins, and (Ultra and Extreme) glossy puddles that mirror the sky.
function buildDockDetail(S, T, R) {
  const { Q, L, W } = DK;
  const hw = W / 2;
  const m4 = new THREE.Matrix4();
  const post = new THREE.InstancedMesh(CylG(0.07, 0.07, 1.0, 6), DM.hazard, 2 * 21);
  let n = 0;
  for (const s of [-1, 1]) {
    for (let x = -60; x <= 60; x += 6) post.setMatrixAt(n++, m4.makeTranslation(x, Q + 0.5, s * (hw + 4.4)));
    S.add(box(L, 0.04, 0.04, DM.darkSteel, 0, Q + 0.85, s * (hw + 4.4)));
    S.add(box(L, 0.04, 0.04, DM.darkSteel, 0, Q + 0.55, s * (hw + 4.4)));
    for (const dz of [-0.6, 0, 0.6]) {
      const cable = mesh(CylG(0.1, 0.1, L + 10, 8).rotateZ(Math.PI / 2), mat(0x1a1a1a, { roughness: 0.7 }));
      cable.position.set(0, Q + 0.12, s * (hw + 5.6 + dz));
      S.add(cable);
    }
    S.add(box(L + 10, 0.1, 2.2, DM.orange, 0, Q + 0.05, s * (hw + 5.6)));
  }
  post.castShadow = true;
  S.add(post);
  for (let x = -280; x <= 40; x += 40) for (const z of [40, -40]) {
    const h = mesh(CylG(0.2, 0.25, 0.8, 10), DM.red);
    h.position.set(x, Q + 0.4, z);
    S.add(h);
    S.add(box(0.5, 0.12, 0.12, DM.red, x, Q + 0.62, z));
    S.add(box(0.7, 0.9, 0.7, mat(0x2f6f3f, { roughness: 0.6 }), x + 2.2, Q + 0.45, z));
  }
  if (dkq.wet) {
    const wetMat = new THREE.MeshStandardMaterial({ color: 0x1b2a33, roughness: 0.03, metalness: 0.15, transparent: true, opacity: 0.78, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    for (let i = 0; i < 18; i++) {
      const puddle = new THREE.Mesh(new THREE.CircleGeometry(1 + R() * 2.6, 24).rotateX(-Math.PI / 2), wetMat);
      const side = R() > 0.5 ? 1 : -1;
      puddle.scale.z = 0.5 + R() * 0.7;
      puddle.rotation.y = R() * 3;
      puddle.position.set(-58 + R() * 116, Q + 0.06, side * (hw + 5 + R() * 18));
      dockScene.add(puddle);
    }
  }
}

function buildDockPeople(S, R) {
  const { Q, FLOOR } = DK;
  const spots = [
    [-52, Q, 31, 0.5], [-48, Q, 33, 2.4], [-10, Q, -31, 1.1], [14, Q, 31, 3.6], [41, Q, -32, 4.4],
    [-100, Q, 40, 0.3], [-96, Q, 42, 3], [-131, Q, 36, 1.7], [-170, Q, 30, 5], [-150, Q, -42, 2.2],
    [-8, FLOOR + 1.2, 18, 2], [30, FLOOR + 1.2, -18, 4.2], [-35, -2.5, -20.8, 0.4], [10, -2.5, 20.8, 3.7]
  ];
  spots.slice(0, Math.max(2, Math.round(spots.length * dkq.people))).forEach(([x, y, z, yaw], i) => {
    const w = makeWorker(R, i % 3 ? DM.vestOrange : DM.vestLime);
    w.position.set(x, y, z);
    w.rotation.y = yaw;
    w.userData.base = yaw;
    w.userData.phase = i * 1.7;
    dockScene.add(w);
    dock3.people.push(w);
  });
  // vehicles: parked, and a truck driving the south road
  const fork = makeForklift();
  fork.position.set(-128, Q, 40);
  fork.rotation.y = 0.6;
  S.add(fork);
  const parked = makeTruck(0x2a4f7a);
  parked.position.set(-112, Q, 53);
  parked.rotation.y = Math.PI;
  S.add(parked);
  const pickup = makeTruck(0xc8c8c4);
  pickup.scale.set(0.7, 0.7, 0.7);
  pickup.position.set(-6, Q, 70);
  pickup.rotation.y = 0.15;
  S.add(pickup);
  // Lorries working the two roads (each keeps to its own lane), and others parked.
  const drive = (root, z0, speed, x0, x1, startX, dir) => {
    root.userData.lanes = [z0 - 1.7, z0 + 1.7];
    root.position.set(startX, Q + 0.05, root.userData.lanes[dir > 0 ? 0 : 1]);
    root.rotation.y = dir > 0 ? 0 : Math.PI;
    dockScene.add(root);
    dock3.movers.push({ root, truck: true, speed, x0, x1, dir });
  };
  drive(makeTruck(0xc23a22), 48, 9, -310, 45, -300, 1);
  drive(makeBigTruck(0x2a4f7a, "container", 0xd7a21a), 48, 7, -310, 45, -20, -1);
  drive(makeBigTruck(0xb0b4b8, "tanker"), 48, 6, -310, 45, -150, 1);
  const pick = makeTruck(0xc8c8c4);
  pick.scale.set(0.7, 0.7, 0.7);
  drive(pick, -48, 11, -310, 45, 0, -1);
  drive(makeBigTruck(0xe0661a, "tipper"), -48, 8, -310, 45, -250, 1);
  drive(makeBigTruck(0x8a2e24, "container", 0x2f8a52), -48, 6, -310, 45, -100, -1);
  drive(makeBigTruck(0xe7b016, "crane"), -48, 3.5, -310, 45, -200, 1);
  // along the quay beside the dock
  drive(makeBigTruck(0x2a4f7a, "container", 0xc8602a), 38, 4, -60, 50, -30, 1);
  drive(makeTruck(0x2f6f3f), -38, 5, -60, 50, 20, -1);
  for (const [x, z, ry, cab, kind, col] of [
    [-140, 62, 0, 0x2a4f7a, "container", 0xb2362b], [-122, 62, 0, 0x555a60, "container", 0x1f2f4a], [-104, 62, 0, 0x8a2e24, "container", 0x8b8f93],
    [-60, 38, 0, 0x2f6f3f, "container", 0xc8602a], [-262, -112, Math.PI / 2, 0xb0b4b8, "tanker", 0], [24, -40, Math.PI, 0xe7b016, "crane", 0]
  ]) {
    const t = makeBigTruck(cab, kind, col);
    t.position.set(x, Q + 0.05, z);
    t.rotation.y = ry;
    dockScene.add(t);
  }
  const fork2 = makeForklift();
  fork2.position.set(-170, Q, -52);
  dock3.movers.push({ root: fork2, truck: true, speed: 3, x0: -230, x1: -150, dir: 1 });
  dockScene.add(fork2);
}

function buildDockEffects() {
  // welding sparks
  const N = 160;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffd27a, size: 0.45, map: glowSoft, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  pts.frustumCulled = false;
  dockScene.add(pts);
  dock3.sparks = { N, pts, vel: new Float32Array(N * 3), life: new Float32Array(N), next: 0 };
  dock3.weldLight = new THREE.PointLight(0xaed4ff, 0, 45, 1.6);
  dockScene.add(dock3.weldLight);
  // chimney smoke
  const puffs = Math.max(4, Math.round(14 * Math.min(1, dkq.props)));
  for (let i = 0; i < puffs; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudPuffTex[i % cloudPuffTex.length], transparent: true, depthWrite: false, opacity: 0, color: 0x9a9a98 }));
    s.userData.age = (i / puffs) * 8;
    dockScene.add(s);
    dock3.smoke.push(s);
  }
  // gulls
  for (let i = 0; i < dkq.gulls; i++) {
    const g = new THREE.Group();
    const wing = new THREE.MeshBasicMaterial({ color: 0xf5f5f2, side: THREE.DoubleSide });
    for (const s of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.4).translate(s * 0.7, 0, 0), wing);
      g.add(w);
    }
    g.add(new THREE.Mesh(SphG(0.22, 6, 4).scale(2.2, 0.8, 0.8), wing));
    g.userData = { r: 30 + (i % 5) * 22, h: 22 + (i % 4) * 9, speed: 0.25 + (i % 3) * 0.08, a: i * 0.9, cx: (i % 2 ? 20 : -50), cz: (i % 3) * 25 - 25 };
    dockScene.add(g);
    dock3.gulls.push(g);
  }
}

function buildDockyard() {
  dock3.built = true;
  dock3.builtLevel = perf.level;
  dkq = DK_TIERS[clamp(perf.level, 0, DK_TIERS.length - 1)];
  const q = QUALITY_LEVELS[perf.level];
  const R = seeded(2024);
  tiledCache.clear();
  const T = dockTextures();
  DM = dockMaterials(T);
  dockScene.environment = scene.environment;
  dockScene.environmentIntensity = 0.75;
  dockScene.fog = new THREE.Fog(0xa4c8e6, 2600, 10000);
  const dkSky = new Sky();
  dkSky.scale.setScalar(5500);
  dock3.skyDome = dkSky;
  const su = dkSky.material.uniforms;
  su.turbidity.value = 1.2;
  su.rayleigh.value = 4.6;
  su.mieCoefficient.value = 0.0018;
  su.mieDirectionalG.value = 0.86;
  su.sunPosition.value.copy(sunDir);
  dockScene.add(dkSky);
  const sunLight = new THREE.DirectionalLight(0xfff0d6, 3.4);
  sunLight.position.copy(sunDir).multiplyScalar(800);
  sunLight.castShadow = q.shadows;
  const shadowSize = Math.min(q.shadowSize, renderer.capabilities.maxTextureSize);
  sunLight.shadow.mapSize.set(shadowSize, shadowSize);
  const sc = sunLight.shadow.camera;
  sc.left = sc.bottom = -210;
  sc.right = sc.top = 210;
  sc.near = 300;
  sc.far = 1700;
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.25;
  dockScene.add(sunLight, sunLight.target);
  dock3.sunLight = sunLight;
  dock3.hemi = new THREE.HemisphereLight(0xd4ecff, 0x4a4a40, 0.7);
  dockScene.add(dock3.hemi);
  // night sky (stars and moon), and floodlights on the dock that come on after dark
  const stars = new THREE.Group();
  const starPts = new THREE.Points(starField.geometry, starField.material);
  starPts.onBeforeRender = (r) => {
    starField.material.uniforms.pixelRatio.value = r.getPixelRatio();
  };
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0xe8eeff, fog: false, depthWrite: false }));
  moon.scale.setScalar(520);
  moon.position.copy(sunDir).multiplyScalar(8800);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSoft, color: 0x3a4a78, fog: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  halo.scale.setScalar(2200);
  halo.position.copy(moon.position);
  for (const o of [starPts, halo, moon]) {
    o.renderOrder = -2;
    stars.add(o);
  }
  stars.scale.setScalar(0.6); // inside the camera's far plane
  stars.visible = false;
  dockScene.add(stars);
  dock3.stars = stars;
  for (const [x, z] of [[-72, -36], [-72, 36], [52, -38], [52, 38]]) {
    const spot = new THREE.SpotLight(0xfff0d0, 0, 0, 0.62, 0.6, 2);
    spot.position.set(x, DK.Q + 26, z);
    spot.target.position.set(0, 0, 0);
    dockScene.add(spot, spot.target);
    dock3.spots.push(spot);
  }

  const S = new THREE.Group();
  dockScene.add(S);
  buildDockPit(S, T, R);
  buildDockGate();
  buildDockCranes(S);
  buildDockYard(S, T, R);
  buildDockBarriers(S, T);
  buildDockClutter(S, T, R);
  if (dkq.detail) buildDockDetail(S, T, R);
  buildDockSea(S, T, R);
  buildDockPeople(S, R);
  buildDockEffects();
  mergeStaticMeshes(S, new Set());
}

// A ship for the dock: its model, the blocks under it, and (once the dock is
// dry) the props, scaffold and workers around it. It is built ahead of time
// out of sight (under the ground) so that bringing it in doesn't stall a frame.
function prepareDockShip(id) {
  const def = getShipDefinition(id);
  const o = createShip({ type: "cruise", category: def.category, displayColor: def.color, angle: 0 });
  o.root.rotation.y = Math.PI; // bow towards the dock's head
  o.root.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(o.model);
  o.draft = -b.min.y;
  o.len = b.max.x - b.min.x;
  o.cx = (b.max.x + b.min.x) / 2;
  o.restY = Math.max(DK.REST_MIN, DK.FLOOR + 1.4 + o.draft);
  o.root.position.y = -400;
  dockScene.add(o.root);
  const rig = buildDockRig(o);
  rig.blocks.position.y = rig.rig2.position.y = -400;
  dockScene.add(rig.blocks, rig.rig2);
  return { id, o, ...rig };
}

function discardDockShip(p) {
  for (const obj of [p.o.root, p.blocks, p.rig2]) {
    dockScene.remove(obj);
    disposeTree(obj);
  }
}

// keepOld: the old ship is still sailing away (dock3.leaving), so it stays.
function installDockShip(p, keepOld) {
  if (dock3.ship && !keepOld) {
    dockScene.remove(dock3.ship.root);
    disposeTree(dock3.ship.root);
  }
  for (const r of [dock3.rig, dock3.rig2]) {
    if (!r) continue;
    dockScene.remove(r);
    disposeTree(r);
  }
  p.blocks.position.y = p.rig2.position.y = 0;
  dock3.ship = p.o;
  dock3.shipId = p.id;
  dock3.rig = p.blocks;
  dock3.rig2 = p.rig2;
  dock3.emitters = p.emitters;
}

function setDockShip(id, keepOld = false) {
  installDockShip(prepareDockShip(id), keepOld);
}

// The ship that has left the dock backs out stern first through the gate, then
// swings round slowly on the spot (turn rate builds up and eases off), and only
// then steams ahead and away. It is "clear" once the next ship can come in
// without its hull touching the leaver's.
function leaverClear(lv) {
  const nx = dock3.ship; // the incoming ship (already installed, sailing up to the waiting point)
  const len = nx ? nx.len : 150;
  const gap = lv.o.halfBeam + (nx ? nx.halfBeam : 12) + 15;
  for (let i = 0; i <= 12; i++) {
    const sa = i / 12 - 0.5;
    const ax = lv.x + Math.cos(lv.heading) * lv.o.len * sa;
    const az = lv.z + Math.sin(lv.heading) * lv.o.len * sa;
    for (let j = 0; j <= 12; j++) {
      if (Math.hypot(ax - (DK_IN_START + len * (j / 12 - 0.5)), az) < gap) return false;
    }
  }
  return true;
}

// How far a leaving ship could sail along `angle` from (x, z) before meeting a breakwater,
// island, moored ship or the incoming ship (it keeps `room` of clear water round its hull).
const LEAVER_LOOK = 600;
function freeRun(x, z, angle, room, extra) {
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  for (let d = 20; d <= LEAVER_LOOK; d += 20) {
    const px = x + c * d;
    const pz = z + sn * d;
    for (const ob of dock3.obstacles) if (Math.hypot(px - ob.x, pz - ob.z) < ob.r + room) return d;
    for (const ob of extra) if (Math.hypot(px - ob.x, pz - ob.z) < ob.r + room) return d;
  }
  return LEAVER_LOOK;
}

// The heading with the longest clear run ahead, leaning to the current one and to the usual
// heading away from the dock.
function pickHeading(lv) {
  const room = lv.o.len * 0.3 + 10;
  const nx = dock3.ship;
  const extra = nx ? [{ x: dock3.shipX, z: 0, r: nx.halfLen * 1.25 }] : [];
  let best = lv.heading;
  let bestScore = -Infinity;
  for (let a = -1; a <= 1.001; a += 0.1) {
    const score = freeRun(lv.x, lv.z, a, room, extra) / LEAVER_LOOK - 0.2 * Math.abs(a - lv.heading) - 0.1 * Math.abs(a - LEAVER.heading);
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best;
}

function stepLeaver(dt) {
  const lv = dock3.leaving;
  if (!lv) return;
  const o = lv.o;
  lv.u += dt;
  if (lv.stage === 0) {
    lv.speed = Math.min(LEAVER.backMax, lv.speed + LEAVER.back * dt);
    if (lv.x > 60 + o.len * 0.5) {
      lv.stage = 1; // stern well clear of the gate
      lv.heading = pickHeading(lv); // swing round to face clear water
    }
  } else if (lv.stage === 1) {
    lv.speed = Math.max(0, lv.speed - LEAVER.back * dt);
    const d = Math.atan2(Math.sin(-lv.heading - lv.yaw), Math.cos(-lv.heading - lv.yaw));
    lv.rate = Math.min(LEAVER.pivot, lv.rate + LEAVER.pivotAccel * dt, Math.abs(d) * 1.5 + 0.06); // builds up, cruises, eases off
    lv.yaw += Math.sign(d) * Math.min(Math.abs(d), lv.rate * dt);
    if (Math.abs(d) < 0.02) lv.stage = 2;
  } else {
    lv.speed = Math.min(LEAVER.aheadMax, lv.speed + LEAVER.ahead * dt);
    // keep steering round anything ahead (gently, so the turn is a wide curve)
    const want = pickHeading(lv);
    lv.heading += clamp(want - lv.heading, -0.12 * dt, 0.12 * dt);
    lv.yaw = -lv.heading;
    if (lv.u > 45 || leaverClear(lv)) lv.clear = true;
  }
  const dir = lv.stage === 2 ? lv.heading : 0;
  lv.x += Math.cos(dir) * lv.speed * dt;
  lv.z += Math.sin(dir) * lv.speed * dt;
  // the hull swings about its own middle, not about the model's origin
  const c0 = -o.cx;
  o.root.rotation.y = lv.yaw;
  o.root.position.set(lv.x - c0 * Math.cos(lv.yaw), Math.sin(dock3.time * 0.8) * 0.15, lv.z + c0 * Math.sin(lv.yaw));
  o.navLights.visible = !!dock3.nightApplied;
  if (lv.x > 1500 || lv.u > 150) {
    dockScene.remove(o.root);
    disposeTree(o.root);
    dock3.leaving = null;
  }
}

function buildDockRig(o) {
  const { FLOOR, W } = DK;
  const hw = W / 2;
  const keel = o.restY - o.draft; // underside of the hull
  const blocks = new THREE.Group();
  const bh = Math.max(0.6, keel - FLOOR);
  for (let x = -o.len * 0.44; x <= o.len * 0.44; x += 7) {
    for (const z of [-o.halfBeam * 0.5, 0, o.halfBeam * 0.5]) {
      const post = box(2.2, bh - 0.4, 1.8, DM.concreteBit, x, FLOOR + (bh - 0.4) / 2, z);
      const cap = box(2.5, 0.4, 2.1, DM.wood, x, keel - 0.2, z);
      blocks.add(post, cap);
    }
  }
  mergeStaticMeshes(blocks, new Set());

  const rig2 = new THREE.Group();
  const R = seeded(99);
  for (const s of [-1, 1]) {
    for (let k = 0; k < 5; k++) {
      const x = -o.len * 0.4 + k * o.len * 0.2;
      const ledgeY = -2.5;
      const a = new THREE.Vector3(x, ledgeY, s * (hw - 1.2));
      const bpt = new THREE.Vector3(x, keel + o.draft * 0.25, s * o.halfBeam * 0.98);
      rig2.add(strut(a, bpt, 0.24, DM.timber, 8));
      rig2.add(box(0.8, 0.3, 0.8, DM.timber, x, ledgeY + 0.15, s * (hw - 1.2)));
      rig2.add(box(0.6, 0.6, 0.15, DM.timber, bpt.x, bpt.y, bpt.z + (s > 0 ? -0.05 : 0.05)));
    }
  }
  // scaffold along the stern on the -z side
  const zS = -(o.halfBeam + 2.4);
  const x0 = o.len * 0.1;
  const x1 = o.len * 0.4;
  const topY = o.restY + 6;
  const levels = [];
  for (let y = FLOOR + 3.2; y < topY; y += 3.2) levels.push(y);
  for (let x = x0; x <= x1 + 0.01; x += 3.5) {
    for (const z of [zS, zS - 2]) rig2.add(box(0.14, topY - FLOOR, 0.14, DM.steel, x, (topY + FLOOR) / 2, z));
  }
  levels.forEach((y, i) => {
    rig2.add(box(x1 - x0 + 3.5, 0.14, 2.3, DM.wood, (x0 + x1) / 2, y, zS - 1));
    for (const z of [zS - 2.1]) {
      rig2.add(box(x1 - x0 + 3.5, 0.07, 0.07, DM.steel, (x0 + x1) / 2, y + 1.1, z));
      rig2.add(box(x1 - x0 + 3.5, 0.07, 0.07, DM.steel, (x0 + x1) / 2, y + 0.55, z));
    }
    if (i < levels.length) {
      for (let x = x0; x < x1 - 0.1; x += 7) {
        rig2.add(strut(new THREE.Vector3(x, y, zS - 2.05), new THREE.Vector3(x + 3.5, y + 3.2, zS - 2.05), 0.05, DM.steel));
      }
    }
  });
  // workers on the scaffold and one welding on the hull
  const topLevel = levels[levels.length - 1] || FLOOR + 3;
  for (const [x, y, z, yaw] of [[x0 + (x1 - x0) * 0.1, topLevel, zS - 1, 1.6], [x0 + (x1 - x0) * 0.5, levels[0] || FLOOR + 3, zS - 1, 1.5], [x0 + (x1 - x0) * 0.85, levels[Math.min(1, levels.length - 1)] || FLOOR + 3, zS - 1, 1.7]]) {
    const w = makeWorker(R, DM.vestOrange);
    w.position.set(x, y + 0.07, z);
    w.rotation.y = yaw;
    rig2.add(w);
  }
  // The welding always lands on the hull itself, whatever the ship's size: at the
  // scaffold worker's reach, but kept between the keel and the top of the hull's
  // side, on the side plating facing the scaffold.
  const weldY = clamp((levels[0] || FLOOR + 3) + 1.4, keel + 0.6, keel + Math.max(1, o.draft * 0.9));
  const emitters = [
    new THREE.Vector3(x0 + (x1 - x0) * 0.5, weldY, -o.halfBeam * 0.96),
    new THREE.Vector3(-o.len * 0.2, keel + o.draft * 0.6, o.halfBeam * 0.9),
    new THREE.Vector3(o.len * 0.05, keel + 0.4, -o.halfBeam * 0.2)
  ];
  mergeStaticMeshes(rig2, new Set(rig2.children.filter((c) => c.userData && c.children.length)));
  return { blocks, rig2, emitters };
}

const easeOutDock = (s) => 1 - Math.pow(1 - clamp(s, 0, 1), 2.2);

// The next ship sails up on its own: it speeds up gently, cruises, and brakes smoothly to a
// stop at the target (the waiting point, then the dock), so it never pops in or jerks.
function stepArrival(dt, target) {
  const dist = dock3.shipX - target;
  if (dist <= 0.05) {
    dock3.shipX = target;
    dock3.shipV = 0;
    return;
  }
  const want = Math.min(DK_ARRIVE_SPEED, Math.sqrt(2 * DK_ARRIVE_ACCEL * dist));
  dock3.shipV += clamp(want - dock3.shipV, -DK_ARRIVE_ACCEL * dt, DK_ARRIVE_ACCEL * dt);
  dock3.shipX = Math.max(target, dock3.shipX - Math.max(dock3.shipV, 0.3) * dt);
}

function posDockShip(level, bob) {
  const o = dock3.ship;
  o.navLights.visible = !!dock3.nightApplied;
  const floating = level > o.restY + 0.01;
  o.root.position.x = dock3.shipX - o.cx;
  o.root.position.y = Math.max(level, o.restY) + (floating ? bob * 0.18 : 0);
  o.tilt.rotation.z = floating ? Math.sin(dock3.time * 0.7) * 0.012 * bob : 0;
  o.tilt.rotation.x = floating ? Math.sin(dock3.time * 0.5 + 1) * 0.008 * bob : 0;
}

function updateDockState(t, dt) {
  const A = DK_ARRIVE;
  const C = DK_CLOSE;
  const END = A + C + DK_DRAIN;
  const wanted = usableShipId(game.shopSlot);
  const g = game.dock;
  if (dock3.openFor !== g) {
    dock3.openFor = g;
    g.horns = (g.horns || 0) + 1; // a horn as the ship arrives (audio.js)
    dock3.phase = "clip";
    dock3.camAngle = -0.45;
    dock3.look.set(0, 0, 0);
    dock3.firstFrame = true;
    for (const stale of [dock3.next]) if (stale) discardDockShip(stale);
    dock3.next = null;
    if (dock3.leaving) {
      dockScene.remove(dock3.leaving.o.root);
      disposeTree(dock3.leaving.o.root);
      dock3.leaving = null;
    }
    setDockShip(wanted);
  }
  stepLeaver(dt);
  if (dock3.phase === "clip") {
    if (t >= END) dock3.phase = "idle";
    const s = Math.min(t, A) / A;
    dock3.shipX = DK.X_START * (1 - easeOutDock(s));
    dock3.gate = 1 - smoothstep(0, 1, (t - A) / C);
    dock3.level = DK.FLOOR * smoothstep(0, 1, (t - A - C) / DK_DRAIN);
    if (t >= END) {
      dock3.shipX = 0;
      dock3.gate = 0;
      dock3.level = DK.FLOOR;
    }
  } else if (dock3.phase === "idle") {
    if (wanted !== dock3.shipId) {
      dock3.phase = "flood";
      dock3.pt = 0;
      dock3.next = prepareDockShip(wanted); // ready before it is needed
    }
  } else {
    dock3.pt += dt;
    const p = dock3.phase;
    if (p === "out") stepArrival(dt, DK_IN_START);
    else if (p === "in") stepArrival(dt, 0);
    const dur = p === "out" ? (dock3.leaving && !dock3.leaving.clear ? Infinity : 0) : p === "in" ? (dock3.shipX <= 0 ? 0 : Infinity) : DK_SWAP[p];
    const s = dur > 0 ? clamp(dock3.pt / dur, 0, 1) : 1;
    if (p === "flood") dock3.level = DK.FLOOR * (1 - smoothstep(0, 1, s));
    else if (p === "open") dock3.gate = smoothstep(0, 1, s);
    else if (p === "close") dock3.gate = 1 - smoothstep(0, 1, s);
    else if (p === "drain") dock3.level = DK.FLOOR * smoothstep(0, 1, s);
    if (dock3.pt >= dur) {
      const order = ["flood", "open", "out", "in", "close", "drain"];
      const next = order[order.indexOf(p) + 1];
      dock3.pt = 0;
      if (next === "out") {
        dock3.leaving = { o: dock3.ship, x: 0, z: 0, speed: 0, heading: LEAVER.heading, yaw: Math.PI, u: 0, stage: 0, rate: 0, clear: false };
        // The next ship is put far out at sea now and sails up while the old one leaves.
        if (dock3.next && dock3.next.id !== wanted) {
          discardDockShip(dock3.next);
          dock3.next = null;
        }
        installDockShip(dock3.next || prepareDockShip(wanted), true);
        dock3.next = null;
        dock3.shipX = DK_HOLD_X;
        dock3.shipV = 0;
      }
      dock3.phase = next || "idle";
      if (next === "in") g.horns = (g.horns || 0) + 1;
      if (!next) {
        dock3.shipX = 0;
        dock3.level = DK.FLOOR;
        dock3.gate = 0;
      }
    }
  }
  posDockShip(dock3.level, 1);
  // for the sound (audio.js)
  const clip = dock3.phase === "clip";
  g.pumping = (clip && t >= A + C && t < END) || dock3.phase === "flood" || dock3.phase === "drain";
  g.gateMoving = (clip && t >= A && t < A + C) || dock3.phase === "open" || dock3.phase === "close";
  // The open gate slides into its recess in the quay and lifts, so its top stays in view beside the entrance.
  dock3.gateObj.position.z = dock3.gate * (DK.W + 0.8);
  dock3.gateObj.position.y = dock3.gate * 2;
  dock3.basin.position.y = dock3.level - 0.03;
  // The last metres of water thin out gradually, showing the dock floor through them, rather than vanishing as a blue sheet.
  const depth = dock3.level - DK.FLOOR;
  dock3.basin.visible = depth > 0.02;
  dock3.basin.material.uniforms.alpha.value = Math.min(1, depth / 2.5) ** 1.5;
  dock3.rig2.visible = dock3.level <= DK.FLOOR + 3;
  dock3.rig.visible = true;
}

function updateDockEffects(dt) {
  const T = dock3.time;
  dock3.sea.material.uniforms.time.value += dt * 0.5;
  dock3.basin.material.uniforms.time.value += dt * 0.5;
  for (const c of dock3.cranes) {
    c.group.position.x = c.baseX + Math.sin(T * 0.07 + c.phase) * 14;
    c.trolley.position.z = Math.sin(T * 0.11 + c.phase * 2) * 12;
    const len = 14 + (Math.sin(T * 0.13 + c.phase) * 0.5 + 0.5) * 18;
    c.hook.position.y = c.H - 1.8 - len;
    c.cable.scale.y = len;
    c.cable.position.y = c.H - 1.8 - len / 2;
  }
  const on = Math.sin(T * 2.2) > 0;
  for (const l of dock3.blink) l.visible = on;
  for (const m of dock3.movers) {
    if (m.truck) {
      m.root.position.x += m.dir * m.speed * dt;
      const lanes = m.root.userData.lanes;
      if (m.root.position.x > m.x1) { m.dir = -1; m.root.rotation.y = Math.PI; if (lanes) m.root.position.z = lanes[1]; }
      if (m.root.position.x < m.x0) { m.dir = 1; m.root.rotation.y = 0; if (lanes) m.root.position.z = lanes[0]; }
    } else if (m.buoy) {
      m.root.position.y = m.baseY + Math.sin(T * 0.9 + m.root.userData.phase) * 0.35;
      m.root.rotation.z = Math.sin(T * 0.7 + m.root.userData.phase) * 0.1;
    } else if (m.tilt) {
      m.navLights.visible = !!dock3.nightApplied;
      m.root.position.y = m.baseY + Math.sin(T * 0.6 + m.root.position.x) * 0.2;
      m.tilt.rotation.z = Math.sin(T * 0.5 + m.root.position.z) * 0.015;
    }
  }
  for (const w of dock3.people) {
    w.rotation.y = w.userData.base + Math.sin(T * 0.4 + w.userData.phase) * 0.5;
  }
  for (const gl of dock3.gulls) {
    const u = gl.userData;
    u.a += dt * u.speed;
    gl.position.set(u.cx + Math.cos(u.a) * u.r, u.h + Math.sin(u.a * 3) * 2, u.cz + Math.sin(u.a) * u.r);
    gl.rotation.y = -u.a;
    const flap = Math.sin(T * 7 + u.a * 5) * 0.6;
    gl.children[0].rotation.z = flap;
    gl.children[1].rotation.z = -flap;
  }
  for (const s of dock3.smoke) {
    const u = s.userData;
    u.age += dt;
    if (u.age > 8) u.age = 0;
    const k = u.age / 8;
    s.position.set(-250 + k * 30, 66 + k * 70, 140 + k * 8);
    s.scale.setScalar(5 + k * 26);
    s.material.opacity = Math.sin(Math.min(1, k * 1.2) * Math.PI) * 0.38;
  }
  // sparks and the welding flash
  const sp = dock3.sparks;
  const pos = sp.pts.geometry.attributes.position;
  const welding = dock3.rig2.visible && dock3.phase === "idle";
  if (welding) {
    for (let i = 0; i < 6; i++) {
      const j = sp.next;
      sp.next = (sp.next + 1) % sp.N;
      const e = dock3.emitters[Math.floor(Math.random() * dock3.emitters.length)];
      pos.setXYZ(j, e.x, e.y, e.z);
      sp.vel[j * 3] = (Math.random() - 0.5) * 7;
      sp.vel[j * 3 + 1] = Math.random() * 6 + 1;
      sp.vel[j * 3 + 2] = (Math.random() - 0.5) * 7;
      sp.life[j] = 0.5 + Math.random() * 0.5;
    }
  }
  for (let j = 0; j < sp.N; j++) {
    if (sp.life[j] <= 0) { pos.setXYZ(j, 0, -1000, 0); continue; }
    sp.life[j] -= dt;
    sp.vel[j * 3 + 1] -= 18 * dt;
    pos.setXYZ(j, pos.getX(j) + sp.vel[j * 3] * dt, pos.getY(j) + sp.vel[j * 3 + 1] * dt, pos.getZ(j) + sp.vel[j * 3 + 2] * dt);
  }
  pos.needsUpdate = true;
  dock3.weldLight.visible = welding;
  game.dock.welding = welding;
  if (welding) {
    dock3.weldLight.position.copy(dock3.emitters[0]);
    dock3.weldLight.intensity = Math.random() > 0.35 ? 40 + Math.random() * 60 : 5;
  }
}

function updateDockCamera(t, dt) {
  const A = DK_ARRIVE;
  const END = DK_ARRIVE + DK_CLOSE + DK_DRAIN;
  const lv = dock3.phase === "out" ? dock3.leaving : null;
  const target = lv ? new THREE.Vector3(lv.x * 0.55, 4, lv.z * 0.55) : new THREE.Vector3(dock3.shipX, 4, 0);
  const shipLen = dock3.ship ? dock3.ship.len : 80;
  if (dock3.firstFrame || !dock3.camLen) dock3.camLen = shipLen;
  dock3.camLen += (shipLen - dock3.camLen) * (1 - Math.exp(-dt * 0.8));
  const orbitPos = (ang) => {
    // the orbit's size and centre follow the ship smoothly, so swapping ships never cuts the view
    const len = dock3.camLen;
    const rad = 45 + len * 1.1 + Math.sin(dock3.time * 0.17) * 14;
    const h = 26 + len * 0.3 + Math.sin(dock3.time * 0.11) * 7;
    return new THREE.Vector3(dock3.look.x * 0.35 + Math.sin(ang) * rad, h, dock3.look.z * 0.35 - Math.cos(ang) * rad);
  };
  const A0 = new THREE.Vector3(DK.GX + 85, 7, -52);
  const A1 = new THREE.Vector3(DK.GX + 12, 22, -78);
  let pos;
  if (t < A) pos = A0.lerp(A1, smoothstep(0, A, t));
  else if (t < END) pos = A1.lerp(orbitPos(-0.45), smoothstep(A, END, t));
  else {
    dock3.camAngle += dt * 0.05;
    pos = orbitPos(dock3.camAngle);
  }
  if (dock3.firstFrame) {
    dock3.look.copy(target);
    dock3.firstFrame = false;
  }
  if (t < END) {
    dock3.look.lerp(target, 1 - Math.exp(-dt * 7));
    dock3.lookVel.set(0, 0, 0);
  } else {
    // A spring that starts from rest: the view eases away from one ship and
    // settles on the next, with no sudden start or stop when the target jumps.
    const w = 0.6;
    const step = Math.min(dt, 0.05);
    dock3.lookVel.addScaledVector(target.sub(dock3.look), w * w * step).multiplyScalar(Math.exp(-2 * w * step));
    dock3.look.addScaledVector(dock3.lookVel, step);
  }
  dockCamera.position.copy(pos);
  dockCamera.up.set(0, 1, 0);
  dockCamera.lookAt(dock3.look);
  const w = canvas3d.clientWidth;
  const h = canvas3d.clientHeight;
  dockCamera.aspect = w / h;
  const ui = t >= END && !game.dock.hideUi;
  dock3.shift += ((ui ? 0.17 : 0) - dock3.shift) * (1 - Math.exp(-dt * 4));
  dockCamera.setViewOffset(w, h, 0, h * dock3.shift, w, h);
  dockCamera.updateProjectionMatrix();
}

// Day or night, like the rest of the game (game.settings.nightMode).
function applyDockNight(on) {
  dock3.nightApplied = on;
  const fog = dockScene.fog;
  fog.color.setHex(on ? 0x060d1c : 0xa4c8e6);
  fog.near = on ? 600 : 2600;
  fog.far = on ? 5200 : 10000;
  dockScene.background = on ? nightSkyColor : null;
  dock3.skyDome.visible = !on;
  dock3.stars.visible = on;
  dockScene.environmentIntensity = on ? 0.12 : 0.75;
  dock3.sunLight.color.setHex(on ? 0x9fb6ff : 0xfff0d6);
  dock3.sunLight.intensity = on ? 0.9 : 3.4;
  dock3.hemi.intensity = on ? 0.22 : 0.7;
  const u = dock3.sea.material.uniforms;
  u.sunColor.value.setHex(on ? 0x2a3350 : 0xfff1d6);
  u.waterColor.value.setHex(on ? 0x021626 : 0x0a4560);
  dock3.shallow.material.color.setHex(on ? 0x12384a : 0x3f8a9a);
  dock3.shallow.material.opacity = on ? 0.35 : 0.5;
  dock3.fade.material.color.setHex(on ? 0x082c3c : 0x1c5f78);
  // Bright enough to read as lit, not so bright that bloom turns small lamps into flickering glare.
  DM.lamp.emissiveIntensity = on ? 2.6 : 1.2;
  for (const m of dock3.litMats) m.emissiveIntensity = on ? 2.4 : 0;
  for (const im of dock3.pools) im.visible = on;
  for (const sp of dock3.spots) sp.intensity = on ? 6000 : 0;
  for (const g of dock3.truckGlows) g.visible = on;
}

function resetDockyard() {
  for (const child of [...dockScene.children]) {
    dockScene.remove(child);
    disposeTree(child);
  }
  tiledCache.clear();
  Object.assign(dock3, {
    built: false, obstacles: [], ship: null, shipId: null, rig: null, rig2: null, gateObj: null, basin: null, fade: null, sea: null, cranes: [], gulls: [],
    people: [], smoke: [], sparks: null, weldLight: null, emitters: [], movers: [], blink: [], litMats: [], pools: [], spots: [], truckGlows: [],
    next: null, leaving: null, stars: null, skyDome: null, sunLight: null, hemi: null, nightApplied: null, openFor: null, timedFor: null
  });
}

// Draws the whole scene once, small, from several sides before the clip
// starts, so every shader, texture and shape is already on the graphics card
// (otherwise things stall a frame when they first come into view).
function prewarmDock() {
  const rt = new THREE.WebGLRenderTarget(64, 64);
  const cam = new THREE.PerspectiveCamera(100, 1, 1, 7000);
  const prev = renderer.getRenderTarget();
  renderer.compile(dockScene, dockCamera);
  for (const [x, y, z, lx, ly, lz] of [[0, 520, 1, 0, 0, 0], [140, 60, 0, 700, 10, 0], [-60, 60, 0, -700, 10, 0], [0, 60, -140, 0, 10, 700], [0, 60, 140, 0, 10, -700]]) {
    cam.position.set(x, y, z);
    cam.lookAt(lx, ly, lz);
    renderer.shadowMap.needsUpdate = true;
    renderer.setRenderTarget(rt);
    renderer.render(dockScene, cam);
  }
  renderer.setRenderTarget(prev);
  rt.dispose();
}

function renderDockyard(dt) {
  if (dock3.built && dock3.builtLevel !== perf.level) resetDockyard();
  // Building the scene and compiling its shaders can take a while: the clip's
  // clock starts once the first frame is on screen, not when the shop opened.
  const first = dock3.timedFor !== game.dock;
  if (!dock3.built) buildDockyard();
  if (first) game.dock.start = performance.now() / 1000;
  dock3.time += dt;
  // The clip's clock moves with the frames (never more than 1/20 s at a time),
  // so a stalled frame slows the film a little instead of jumping it; skipping
  // the clip still jumps.
  const real = performance.now() / 1000 - game.dock.start;
  if (first) dock3.clipT = 0;
  dock3.clipT = real - dock3.clipT > 2 ? real : Math.min(real, dock3.clipT + Math.min(dt, 0.05));
  const t = dock3.clipT;
  updateDockState(t, dt);
  updateDockEffects(dt);
  updateDockCamera(t, dt);
  if (first) prewarmDock();
  const nightNow = !!game.settings.nightMode;
  if (dock3.nightApplied !== nightNow) applyDockNight(nightNow);
  dock3.stars.position.copy(dockCamera.position);
  bloomPass.strength = nightNow ? 0.8 : 0.42;
  const rp = composer.passes[0];
  rp.scene = dockScene;
  rp.camera = dockCamera;
  renderer.toneMappingExposure = nightNow ? 0.75 : 0.85;
  renderer.shadowMap.needsUpdate = true;
  composer.render(dt);
  if (first) {
    game.dock.start = performance.now() / 1000;
    dock3.timedFor = game.dock;
  }
}


if (renderer) {
  try {
    buildEnvironment();
    buildHarbour(HarbourA, 0x2f8f62, 4211);
    buildHarbour(HarbourB, 0x3f6fb8, 9277);
    buildBuoys();
    buildDistantIslands();
    new ResizeObserver(resize).observe(canvas3d);
    const gpu = detectGpu();
    view3d.gpu = gpu.name;
    view3d.advancedCapable = gpu.dedicated;
    view3d.render = renderFrame;
    view3d.project = project;
    view3d.shipTop = (ship) => shipObjects.get(ship)?.top ?? 40;
    view3d.setGraphicsMode = setGraphicsMode;
    // A new round or level: no fading tsunami wave carried over (game.js resetSea).
    view3d.resetSea = () => {
      seaState.tsuAmp = 0;
      seaState.whirlAngle = 0;
    };
    view3d.available = true;
    graphicsChoice = loadGraphicsChoice();
    if (graphicsChoice) applyChosenGraphicsMode();
    else startGraphicsCheck(); // first start on this hardware
  } catch (err) {
    console.warn("[3D] Could not start the 3D view, keeping the 2D view:", err);
  }
}
// Tells game.js the 3D start-up is over (worked or not), so its "please
// wait" screen can go once frames come smoothly; a first-start graphics check
// says so itself when it finishes.
if (!graphicsCheck.running) view3d.startupDone = true;
