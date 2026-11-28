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
    if (o.isInstancedMesh) o.dispose(); // frees its list of places
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) if (!m.userData.shared) m.dispose();
  });
}

function shared(thing) {
  thing.userData.shared = true;
  return thing;
}

// ---------------------------------------------------------------------------
// Ropes: three strands laid up together. The outline has three lobes that turn
// as the rope runs, the texture draws each strand's yarns, and a rope is never
// drawn dead straight: it hangs in a belly and takes loose bends.
// ---------------------------------------------------------------------------
const ROPE_LAY = 7; // the length of one full turn of a strand, in rope radii

// One strand from groove to groove (u), crossed by its yarns (v).
const ropeTexture = shared(ibCanvas(64, 64, (g, w, h) => {
  for (let x = 0; x < w; x++) {
    const grey = Math.round(80 + 175 * Math.sin((Math.PI * (x + 0.5)) / w) ** 0.55);
    g.fillStyle = `rgb(${grey},${grey},${grey})`;
    g.fillRect(x, 0, 1, h);
  }
  for (let y = -40; y < h; y += 8) { // each slants 40 down across the strand, so the tile repeats
    for (const [style, wide, shift] of [["rgba(50,34,16,0.5)", 2, 0], ["rgba(255,244,215,0.35)", 1.5, 3]]) {
      g.strokeStyle = style;
      g.lineWidth = wide;
      g.beginPath();
      g.moveTo(0, y + shift);
      g.lineTo(w, y + shift + 40);
      g.stroke();
    }
  }
  ibSpeckle(g, w, h, 260, 0.12);
}));
// Ropes built into a model stir where they hang: each vertex carries how far it
// may move (nothing at the fixings) and its rope's own beat (attribute "sway").
const ropeAir = { time: { value: 0 }, wind: { value: 1 } };
function swayRope(shader) {
  shader.uniforms.ropeTime = ropeAir.time;
  shader.uniforms.ropeWind = ropeAir.wind;
  shader.vertexShader = "attribute vec2 sway;\nuniform float ropeTime;\nuniform float ropeWind;\n" + shader.vertexShader.replace(
    "#include <begin_vertex>",
    `#include <begin_vertex>
    transformed += sway.x * ropeWind * vec3(
      sin(ropeTime * 1.7 + sway.y),
      0.4 * sin(ropeTime * 2.9 + sway.y * 2.1),
      sin(ropeTime * 1.3 + sway.y * 1.6));`
  );
}
const ropeSkin = (color) => {
  const skin = shared(mat(color, { map: ropeTexture, bumpMap: ropeTexture, bumpScale: 1.5, roughness: 0.95 }));
  skin.onBeforeCompile = swayRope;
  return skin;
};
const hempMat = ropeSkin(0xd9bf8a); // natural hemp: hawsers, mooring lines, running rigging, coils
const tarredMat = ropeSkin(0x6a5138); // tarred standing rigging
// The same under a name of its own: a sailing ship's rigging is merged by material.
const runningMat = ropeSkin(0xa88c60);

// One geometry holding every rope in `list` ({ curve, r, sides, stretch, sway,
// spans }). With 9 sides or more the three strands show in the outline; fewer is
// for thin rope. `stretch` is for a rope that is scaled longer after it is
// built. `sway` is how far it stirs midway between fixings; `spans` how many
// equal lengths it is held in (a ratline: one between each pair of shrouds).
function ropeGeometry(list) {
  const position = [];
  const normal = [];
  const uv = [];
  const index = [];
  const stir = [];
  const tangent = new THREE.Vector3();
  const across = new THREE.Vector3();
  const over = new THREE.Vector3();
  const out = new THREE.Vector3();
  for (const { curve, r, sides = 9, stretch = 1, sway = 0, spans = 1 } of list) {
    curve.arcLengthDivisions = Math.max(48, (curve.points?.length || 0) * 4); // moving ropes are rebuilt every frame: measure no finer than needed
    const length = curve.getLength() * stretch;
    // enough rings for the twist to read, or, on thin rope, for the curve
    const rings = sides < 9 ? Math.min(24, Math.max(6, Math.ceil(length / (r * 20)))) : Math.min(400, Math.max(12, Math.ceil(length / ((r * ROPE_LAY) / 10))));
    const path = curve.getSpacedPoints(rings);
    const first = position.length / 3;
    for (let i = 0; i <= rings; i++) {
      const u = i / rings;
      const at = path[i];
      tangent.subVectors(path[Math.min(rings, i + 1)], path[Math.max(0, i - 1)]).normalize();
      // The frame starts level, so the lay doesn't spin as a moving rope changes
      // shape, and is carried along it from there: turned afresh at each ring it
      // would flip on a steep stretch and pinch the rope as if cut.
      if (i === 0) across.set(-tangent.z, 0, tangent.x);
      across.addScaledVector(tangent, -across.dot(tangent));
      if (across.lengthSq() < 1e-6) across.set(tangent.y, -tangent.x, 0);
      across.normalize();
      over.crossVectors(across, tangent).normalize();
      const turn = (u * length) / (r * ROPE_LAY);
      for (let j = 0; j <= sides; j++) {
        const a = j / sides;
        const strand = (a - turn) * 3;
        const radius = sides < 9 ? r : r * (0.76 + 0.34 * Math.sqrt(Math.abs(Math.sin(Math.PI * strand))));
        out.copy(across).multiplyScalar(Math.cos(a * Math.PI * 2)).addScaledVector(over, Math.sin(a * Math.PI * 2));
        position.push(at.x + out.x * radius, at.y + out.y * radius, at.z + out.z * radius);
        normal.push(out.x, out.y, out.z);
        uv.push(strand, (u * length) / (r * 4));
        stir.push(sway * Math.abs(Math.sin(Math.PI * u * spans)), path[0].x * 1.3 + path[0].z * 0.7);
      }
    }
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < sides; j++) {
        const a = first + i * (sides + 1) + j;
        const b = a + sides + 1;
        index.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    if (sides < 9) continue;
    // both ends closed, so a rope seen end on is not a hollow tube
    for (const [ring, u, way] of [[0, 0, -1], [rings, 1, 1]]) {
      const middle = position.length / 3;
      const at = path[ring];
      tangent.subVectors(path[Math.min(rings, ring + 1)], path[Math.max(0, ring - 1)]).normalize().multiplyScalar(way);
      position.push(at.x, at.y, at.z);
      normal.push(tangent.x, tangent.y, tangent.z);
      uv.push(0.5, (u * length) / (r * 4));
      stir.push(0, 0);
      const edge = first + ring * (sides + 1);
      for (let j = 0; j < sides; j++) {
        if (way > 0) index.push(middle, edge + j + 1, edge + j);
        else index.push(middle, edge + j, edge + j + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute("sway", new THREE.Float32BufferAttribute(stir, 2));
  geo.setIndex(index);
  return geo;
}

// How a rope lies between `a` and `b`: bellied `sag` deep by its own weight,
// with loose bends `kink` wide, swinging `swing` wide at `time` (for a rope
// rebuilt every frame). It never drops below `floor(point, t)`: where it would,
// it rests there and, unless `snake` is false, snakes from side to side.
function ropeCurve(a, b, { sag = 0, kink = 0, seed = 0, swing = 0, time = 0, floor = null, keep = null, snake = true } = {}) {
  const side = new THREE.Vector3(a.z - b.z, 0, b.x - a.x).normalize();
  const points = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const inner = Math.sin(Math.PI * t); // nothing at the two ends, which are made fast
    let bend = kink * inner * (Math.sin(t * 8 + seed) + 0.5 * Math.sin(t * 19 + seed * 2.3));
    const p = a.clone().lerp(b, t);
    p.y -= sag * 4 * t * (1 - t);
    bend += swing * inner * Math.sin(time * 1.5 + seed + t * 3.5);
    p.y += swing * 0.6 * inner * Math.sin(time * 2.1 + seed * 1.7 + t * 6);
    const made = i === 0 || i === 16; // the ends are made fast: nothing shifts them
    const low = floor && !made ? floor(p, t) : -Infinity;
    if (p.y < low) {
      if (snake) bend += inner * Math.sin(t * 21 + seed) * Math.min(1.6, (low - p.y) * 0.6);
      p.y = low;
    }
    p.addScaledVector(side, bend);
    if (keep && !made) keep(p); // held clear of whatever it may not enter
    points.push(p);
  }
  return new THREE.CatmullRomCurve3(points);
}

// A line being hauled in, `k` (0..1) of the way: its free end drops from where
// it was made fast (`from`), is dragged across and climbs to the ship (`to`),
// the slack twisting into loops that travel up the rope as it comes. `away`
// points clear of the hull; `ground(point)` is the quay or sea it cannot pass,
// `keep(point)` holds it outside the hull; `aboard` is where it leads inboard.
function haulCurves(to, from, k, seed, away, ground, keep, aboard) {
  const ease = k * k * (3 - 2 * k);
  const free = from.clone().lerp(to, ease);
  const fall = Math.min(1, k / 0.22) ** 2; // let go, it drops
  const climb = Math.max(0, (k - 0.55) / 0.45) ** 1.5; // then comes up the side
  free.y = THREE.MathUtils.lerp(THREE.MathUtils.lerp(from.y, ground(free), fall), to.y, climb);
  const length = to.distanceTo(free);
  const along = free.clone().sub(to).normalize();
  const wild = Math.min(1, k / 0.2) * Math.min(1, (1 - k) / 0.15); // how tangled it is
  const radius = clamp(length * 0.16, 0.5, 1.7) * wild;
  const loops = clamp(length / 6, 2, 4.5);
  const points = [];
  for (let i = 0; i <= 40; i++) {
    const u = i / 40;
    const p = to.clone().lerp(free, u);
    p.y -= (length * 0.1 + 0.6) * wild * 4 * u * (1 - u);
    const grow = Math.min(1, u * 5) * (1 - 0.4 * u); // made fast aboard, loosest along the middle
    const turn = Math.PI * 2 * (u * loops + k * 5) + seed;
    const wide = radius * grow;
    p.addScaledVector(along, wide * 1.1 * Math.sin(turn));
    p.addScaledVector(away, wide * (1 - Math.cos(turn) + 0.45 * (1 + Math.sin(turn * 2.37 + 1.7))));
    p.y += wide * 0.8 * Math.sin(turn * 1.31 + seed);
    const low = ground(p);
    p.y = Math.max(p.y, THREE.MathUtils.lerp(Math.min(low, to.y), low, Math.min(1, u * 4)));
    if (keep && i > 0) keep(p);
    points.push(p);
  }
  // the eye at its end, swinging as it comes
  const end = points[points.length - 1];
  const lean = Math.sin(k * 21 + seed) * 0.7;
  const eye = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const down = (1 - Math.cos(a)) * 0.45;
    const p = new THREE.Vector3(end.x + Math.sin(a) * 0.45 + down * lean, end.y - down, end.z + Math.sin(a) * 0.2);
    p.y = Math.max(p.y, Math.min(ground(p), end.y));
    return p;
  });
  return [new THREE.CatmullRomCurve3(aboard ? [aboard, ...points] : points), new THREE.CatmullRomCurve3(eye, true)];
}

// Rope laid down in turns on a deck or quay, its tail wandering off: `outer` is
// the widest turn's radius; (x, y, z) is the middle of the coil's underside.
function ropeCoil(x, y, z, outer, r, turns = 4.5, seed = 0) {
  const points = [];
  const steps = Math.ceil(turns * 12);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * turns * Math.PI * 2 + seed;
    const wide = outer * (1 - 0.4 * t + 0.07 * Math.sin(a * 1.7 + seed));
    points.push(new THREE.Vector3(x + Math.cos(a) * wide, y + r + t * turns * r * 0.75, z + Math.sin(a) * wide));
  }
  const last = points[points.length - 1];
  const away = new THREE.Vector3(last.x - x, 0, last.z - z).normalize();
  points.push(
    new THREE.Vector3(x + away.x * outer * 1.35, y + r * 2, z + away.z * outer * 1.35),
    new THREE.Vector3(x + away.x * outer * 1.7 - away.z * outer * 0.5, y + r, z + away.z * outer * 1.7 + away.x * outer * 0.5)
  );
  return new THREE.CatmullRomCurve3(points);
}

// A sailing ship's fixed rigging, added to `ship` as one mesh per kind of rope.
// It is left out of every ray test (fire, mooring lines, deck heights), out of
// the camera's solids and out of the hiding of parts around the helm.
function addRigging(ship, list, material) {
  const rigging = mesh(ropeGeometry(list), material, false);
  rigging.raycast = () => {};
  rigging.userData.rigging = true;
  ship.add(rigging);
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
// The throat opens and closes with the strength, full size from this strength up.
const WHIRL_THROAT_FULL = 0.5;
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
    float tOpen = max(smoothstep(0.0, ${glslNum(WHIRL_THROAT_FULL)}, whirl.w), 0.001);
    h -= 400.0 * tOpen * tOpen * (1.0 - smoothstep(${glslNum(WHIRL_RIM * 0.7)}, ${glslNum(WHIRL_RIM * 1.05)}, wq / tOpen));
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
  u.gorge = { value: new THREE.Vector4() }; // the pit below a waterfall: lip x, z, downstream x, z
  u.gorgeSize = { value: new THREE.Vector2() }; // half width, length (0: none)
  u.foamColor = { value: new THREE.Color(1.25, 1.35, 1.4) };
  u.seaDetail = { value: 0 }; // 1 = fine ripples near the camera (applyQuality)
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
    "varying vec4 worldPosition;\nvarying vec4 vSea;\nuniform float seaRough;\nuniform float seaDetail;\nuniform vec3 foamColor;\n" +
      "uniform vec4 whirl;\nuniform float whirlSpin;\nuniform float whirlAngle;\nuniform float whirlAge;\n" +
      "uniform vec4 gorge;\nuniform vec2 gorgeSize;"
  );
  // No sea over a waterfall's pit.
  swap(
    "void main() {",
    "void main() {\n" +
      "if ( gorgeSize.x > 0.0 ) {\n" +
      "  vec2 gd = worldPosition.xz - gorge.xy;\n" +
      "  float along = dot( gd, gorge.zw );\n" +
      "  if ( along > 0.0 && along < gorgeSize.y && abs( gd.x * gorge.w - gd.y * gorge.z ) < gorgeSize.x ) discard;\n" +
      "}"
  );
  // Inside a whirlpool the ripples turn with the water, faster near the
  // middle, so they wind into a spiral.
  swap(
    "vec4 noise = getNoise( worldPosition.xz * size );",
    "vec2 wdf = worldPosition.xz - whirl.xy;\n" +
      "float wqf = length( wdf ) / max( whirl.z, 1.0 );\n" +
      "float wa = -whirlSpin * whirlAngle * pow( 1.0 - min( wqf, 1.0 ), 2.0 );\n" +
      "vec2 np = whirl.xy + mat2( cos( wa ), sin( wa ), -sin( wa ), cos( wa ) ) * wdf;\n" +
      "vec4 noise = getNoise( worldPosition.xz * size );\n" +
      // Cross-fades back to the open sea's ripples as the pool dies away.
      "if ( whirl.w > 0.0 ) noise = mix( noise, getNoise( np * size ), smoothstep( 0.0, 0.3, whirl.w ) );"
  );
  swap(
    "vec3 surfaceNormal = normalize( noise.xzy * vec3( 1.5, 1.0, 1.5 ) );",
    "float ripple = 1.5 + 1.5 * seaRough;\n" +
      "vec3 surfaceNormal = normalize( noise.xzy * vec3( ripple, 1.0, ripple ) + vec3( -vSea.x, 0.0, -vSea.y ) );\n" +
      // Small wind ripples on top of the waves, fading out before they would shimmer.
      "if ( seaDetail > 0.0 ) {\n" +
      "  vec2 fine = texture2D( normalSampler, worldPosition.xz / 23.0 + vec2( time / 9.0, time / 14.0 ) ).rg + texture2D( normalSampler, worldPosition.zx / 11.0 - vec2( time / 6.0, time / 10.0 ) ).rg - 1.0;\n" +
      "  float close = 1.0 - smoothstep( 120.0, 800.0, length( eye - worldPosition.xyz ) );\n" +
      "  surfaceNormal = normalize( surfaceNormal + vec3( fine.x, 0.0, fine.y ) * 0.28 * close * seaDetail );\n" +
      "}"
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
      "float tOpen = max( smoothstep( 0.0, " + glslNum(WHIRL_THROAT_FULL) + ", whirl.w ), 0.001 );\n" +
      "float edge = exp( -pow( ( wqf / tOpen - 0.215 + 0.025 * sin( 5.0 * th + noise.y * 4.0 ) ) / 0.035, 2.0 ) );\n" +
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

// The daytime sky as it looks at sea: a soft blue overhead, paling to a hazy
// blue-white at the horizon, with the sun and a little warmth round it. The
// colours are bright linear values so they come out as meant after the tone
// mapping (at exposure 0.5 the horizon shows as #bdd2e0, low sky #84acd9,
// overhead #3a67a3).
const SKY_HORIZON = new THREE.Color().setRGB(0.768, 1.301, 1.915);
const SKY_LOW = new THREE.Color().setRGB(0.3, 0.68, 1.52);
const SKY_ZENITH = new THREE.Color().setRGB(0.1, 0.245, 0.62);

const SUN_DAY = 0xffe3b8; // an afternoon sun, a little warm
// The sea's colour by day, looked into from above.
const SEA_BLUE = 0x1e4050;

// Makes three's water behave like sea water.
function trueWater(water) {
  // The sky is brighter than white: an ordinary mirror clips it, and the
  // reflected blue turns the water turquoise.
  water.material.uniforms.mirrorSampler.value.type = THREE.HalfFloatType;
  water.material.uniforms.mirrorBase = { value: 0 };
  water.material.uniforms.mirrorLift = { value: 0 };
  mirrorTime(water, false);
  let fs = water.material.fragmentShader;
  for (const [from, to] of [
    ["uniform vec3 waterColor;", "uniform vec3 waterColor;\nuniform float mirrorBase;\nuniform float mirrorLift;"],
    ["float rf0 = 0.3;", "float rf0 = mirrorBase;"],
    // a ruffled sea mirrors bright clouds only faintly (at night the lamps' reflections stay)
    ["float theta = max( dot( eyeDirection, surfaceNormal ), 0.0 );",
      "float glare = dot( reflectionSample, vec3( 0.2126, 0.7152, 0.0722 ) );\n if ( mirrorBase < 0.1 && glare > 1.05 ) reflectionSample *= ( 1.05 + 0.12 * ( glare - 1.05 ) ) / glare;\n float theta = max( dot( eyeDirection, surfaceNormal ), 0.0 );"],
    // far off, the waves tip the water's face towards the darker sky overhead,
    // so the horizon stays a crisp line
    ["float reflectance = rf0 + ( 1.0 - rf0 ) * pow( ( 1.0 - theta ), 5.0 );",
      "float reflectance = rf0 + ( 1.0 - rf0 ) * pow( ( 1.0 - theta ), 5.0 );\n reflectance *= 1.0 - 0.38 * smoothstep( 250.0, 2600.0, distance );"],
    ["sunColor * diffuseLight * 0.3 + scatter", "sunColor * diffuseLight * 0.04 + scatter"],
    // looked straight into (the overview camera), the water's own blue shows
    ["vec3 scatter = max( 0.0, dot( surfaceNormal, eyeDirection ) ) * waterColor;",
      "float into = max( 0.0, dot( surfaceNormal, eyeDirection ) );\n vec3 scatter = ( into + 3.5 * pow( into, 4.0 ) ) * waterColor;"],
    // the sun's glitter shows on the water from any height
    ["( vec3( 0.1 ) + reflectionSample * 0.9 + reflectionSample * specularLight ), reflectance);",
      "( vec3( mirrorLift ) + reflectionSample * 0.95 + reflectionSample * specularLight ), reflectance) + specularLight * 0.1;"]
  ]) {
    if (!fs.includes(from)) throw new Error("Water shader changed: " + from);
    fs = fs.replace(from, to);
  }
  water.material.fragmentShader = fs;
  const renderMirror = water.onBeforeRender;
  water.onBeforeRender = function (...args) {
    cloudShow.value = water.userData.mirrorClouds ?? MIRRORED_CLOUDS;
    renderMirror.apply(this, args);
    cloudShow.value = 1;
  };
  return water;
}

// By day water reflects little looked into from above and nearly everything
// towards the horizon. At night it mirrors more, with a little glow of its
// own, so the moonlit sea doesn't turn black under the dark sky.
function mirrorTime(water, night) {
  water.material.uniforms.mirrorBase.value = night ? 0.3 : 0.05;
  water.material.uniforms.mirrorLift.value = night ? 0.1 : 0;
}

// The dockyard is drawn brighter (exposure 0.85); this makes its sky the same.
const DOCK_SKY_GAIN = 0.5 / 0.85;
const DOCK_HAZE = SKY_HORIZON.clone().multiplyScalar(DOCK_SKY_GAIN);

// ---- Clouds ---------------------------------------------------------------
// Fair-weather cumulus with real depth: a ray is marched through a layer of
// 3D noise for every direction of the sky, lit from the sun's side so tops are
// bright and bases grey, with thin cirrus far above. That is far too heavy to
// do every frame, so it is done once while loading into a picture of the sky
// that every graphics level then simply looks up: red = sunlight on the
// cloud, green = light from the blue sky, blue = cirrus, alpha = cover.
const CLOUD_SIZES = [
  { width: 1024, height: 256, steps: 24, lightSteps: 3 }, // Lowest
  { width: 2048, height: 448, steps: 36, lightSteps: 4 }, // Low, Medium
  { width: 4096, height: 896, steps: 56, lightSteps: 5 } // High and up
];
const cloudSize = (level) => (QUALITY_LEVELS[level].fine ? 2 : level === QUALITY_LEVELS.length - 1 ? 0 : 1);
const noClouds = new THREE.DataTexture(new Uint8Array(4), 1, 1);
noClouds.needsUpdate = true;
const cloudMap = { value: noClouds }; // shared by every sky
// How strongly the clouds show: in full to the eye, faintly in the sea's
// mirror (a ruffled sea breaks them up).
const cloudShow = { value: 1 };
const MIRRORED_CLOUDS = 0.2;
const cloudBake = { size: -1, target: null };

const CLOUD_SHADER = /* glsl */ `
  uniform vec3 sunDirection;
  varying vec2 vUv;
  float speck(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(speck(i), speck(i + vec3(1, 0, 0)), f.x), mix(speck(i + vec3(0, 1, 0)), speck(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(speck(i + vec3(0, 0, 1)), speck(i + vec3(1, 0, 1)), f.x), mix(speck(i + vec3(0, 1, 1)), speck(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float billows(vec3 p, int octaves) {
    float sum = 0.0;
    float weight = 0.5;
    float total = 0.0;
    for (int i = 0; i < 5; i++) {
      if (i >= octaves) break;
      sum += weight * noise3(p);
      total += weight;
      p = p * 2.13 + vec3(11.7, 3.1, 5.3);
      weight *= 0.5;
    }
    return sum / total;
  }
  const float BASE = 1.0;  // height of the cloud bases
  const float DEPTH = 0.55; // tallest cloud
  const float EARTH = 90.0; // the layer curves down to the horizon
  float density(vec3 p, float h, bool fine) {
    if (h <= 0.0 || h >= 1.0) return 0.0;
    // where clouds gather, and how tall each one grows
    float cover = billows(vec3(p.xz * 0.62, 4.2), 3);
    float room = smoothstep(0.47, 0.66, cover);
    if (room <= 0.0) return 0.0;
    float flatBase = smoothstep(0.0, 0.1, h);
    float roundTop = 1.0 - smoothstep(0.15 + 0.75 * room, 0.35 + 0.75 * room, h);
    float lumps = billows(p * 2.6, fine ? 4 : 3);
    float d = lumps * 1.25 + room * 0.55 - 1.08;
    if (fine) d -= 0.16 * (1.0 - billows(p * 9.0, 3)); // ragged edges
    return clamp(d * 3.0, 0.0, 1.0) * flatBase * roundTop;
  }
  float reach(float up, float height) { // distance along a ray to a height above the curved earth
    return -EARTH * up + sqrt(EARTH * EARTH * up * up + 2.0 * EARTH * height + height * height);
  }
  void main() {
    float azimuth = (vUv.x - 0.5) * 6.2831853;
    float elevation = vUv.y * vUv.y * 1.5707963; // most detail near the horizon
    vec3 d = vec3(cos(elevation) * cos(azimuth), sin(elevation), cos(elevation) * sin(azimuth));
    float up = max(d.y, 0.0);
    float from = reach(up, BASE);
    float to = min(reach(up, BASE + DEPTH), from + 5.0);
    float stride = (to - from) / float(STEPS);
    float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    float t = from + stride * jitter;
    float clear = 1.0;
    float sunlight = 0.0;
    float skylight = 0.0;
    float toSun = max(dot(d, sunDirection), 0.0);
    for (int i = 0; i < STEPS; i++) {
      vec3 p = d * t;
      float height = (length(p + vec3(0.0, EARTH, 0.0)) - EARTH - BASE) / DEPTH;
      float k = density(p, height, true);
      if (k > 0.001) {
        float shade = 0.0;
        for (int j = 1; j <= LIGHT_STEPS; j++) {
          vec3 q = p + sunDirection * (0.055 * float(j) * float(j) * 0.55);
          shade += density(q, height + (q.y - p.y) / DEPTH, false) * float(j);
        }
        float lit = exp(-shade * 0.75) * (0.75 + 0.9 * pow(toSun, 6.0));
        float taken = 1.0 - exp(-k * stride * 14.0);
        sunlight += clear * taken * lit;
        skylight += clear * taken * (0.4 + 0.6 * height);
        clear *= 1.0 - taken;
        if (clear < 0.02) break;
      }
      t += stride;
    }
    // thin high cirrus, drawn out in long streaks
    vec2 high = d.xz / (up + 0.08) * 0.8;
    float streak = billows(vec3(high.x * 0.55 + billows(vec3(high * 0.4, 9.0), 3) * 2.0, high.y * 3.4, 1.7), 5);
    float cirrus = smoothstep(0.55, 0.8, streak) * smoothstep(0.45, 0.62, billows(vec3(high * 0.35, 21.0), 3));
    gl_FragColor = vec4(min(sunlight, 1.0), min(skylight, 1.0), cirrus, 1.0 - clear);
  }`;

// Draws the clouds for a graphics level, unless a picture at least as fine is
// already there. In small tiles, so a slow graphics chip is never held up by
// one long job.
function ensureClouds(level) {
  const index = cloudSize(level);
  if (index <= cloudBake.size) return;
  const size = CLOUD_SIZES[index];
  const target = new THREE.WebGLRenderTarget(size.width, size.height, { depthBuffer: false, wrapS: THREE.RepeatWrapping });
  const material = new THREE.ShaderMaterial({
    uniforms: { sunDirection: { value: sunDir } },
    defines: { STEPS: size.steps, LIGHT_STEPS: size.lightSteps },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: CLOUD_SHADER
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const stage = new THREE.Scene();
  stage.add(quad);
  const view = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const previous = renderer.getRenderTarget();
  const gl = renderer.getContext();
  target.scissorTest = true;
  for (let y = 0; y < size.height; y += 64) {
    for (let x = 0; x < size.width; x += 256) {
      target.scissor.set(x, y, 256, 64);
      renderer.setRenderTarget(target);
      renderer.render(stage, view);
      gl.flush();
    }
  }
  target.scissorTest = false;
  renderer.setRenderTarget(previous);
  material.dispose();
  quad.geometry.dispose();
  if (cloudBake.target) cloudBake.target.dispose();
  cloudBake.target = target;
  cloudBake.size = index;
  cloudMap.value = target.texture;
}

// `gain` evens out a scene drawn at another exposure.
function clearSky(size, gain = 1) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      horizon: { value: SKY_HORIZON.clone() },
      low: { value: SKY_LOW },
      zenith: { value: SKY_ZENITH },
      sunDirection: { value: sunDir },
      gain: { value: gain },
      clouds: cloudShow,
      cloudMap,
      drift: { value: 0 } // how far the clouds have moved round the sky
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w; // always behind everything
      }`,
    fragmentShader: `
      uniform vec3 horizon;
      uniform vec3 low;
      uniform vec3 zenith;
      uniform vec3 sunDirection;
      uniform float gain;
      uniform float clouds;
      uniform sampler2D cloudMap;
      uniform float drift;
      varying vec3 vWorld;
      void main() {
        vec3 d = normalize(vWorld - cameraPosition);
        float up = max(d.y, 0.0);
        vec3 colour = mix(horizon, low, smoothstep(0.0, 0.09, up));
        colour = mix(colour, zenith, smoothstep(0.07, 0.6, up));
        float toSun = max(dot(d, sunDirection), 0.0);
        float cover = 0.0;
        if (clouds > 0.0 && d.y > 0.0) {
          vec2 at = vec2(atan(d.z, d.x) / 6.2831853 + 0.5 + drift, sqrt(asin(min(d.y, 1.0)) / 1.5707963));
          vec4 c = texture2D(cloudMap, at);
          // far clouds fade into the haze over the horizon
          float clearAir = smoothstep(0.0, 0.16, d.y);
          colour = mix(colour, vec3(1.7, 2.05, 2.6), clouds * c.b * 0.5 * smoothstep(0.02, 0.2, d.y));
          cover = clouds * c.a * smoothstep(0.004, 0.06, d.y);
          if (c.a > 0.004) {
            vec3 cloud = (vec3(3.5, 3.1, 2.6) * c.r + vec3(0.45, 0.62, 0.95) * c.g) / c.a;
            colour = mix(colour, mix(horizon * 1.12, cloud, 0.3 + 0.7 * clearAir), cover);
          }
        }
        colour += vec3(1.0, 0.82, 0.55) * (0.35 * pow(toSun, 64.0) + 1.5 * pow(toSun, 900.0)) * (1.0 - cover);
        colour += vec3(30.0, 27.0, 22.0) * smoothstep(0.99993, 0.99997, toSun) * (1.0 - cover);
        gl_FragColor = vec4(colour * gain, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false
  });
  const sky = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  sky.scale.setScalar(size);
  return sky;
}

function buildEnvironment() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.5;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // The water mirror renders the scene a second time each frame; the shadow
  // map only needs drawing once, so it is refreshed by hand in renderFrame.
  renderer.shadowMap.autoUpdate = false;

  scene.fog = new THREE.Fog(SKY_HORIZON.clone(), 3200, 15000);

  // Image-based lighting from a physical daylight sky, so metal, ice and wet
  // hulls pick up believable reflections without extra lights. It only lights:
  // seen directly it washes out to grey-white, so clearSky is what is drawn.
  const light = new Sky();
  light.scale.setScalar(16000);
  const su = light.material.uniforms;
  su.turbidity.value = 2;
  su.rayleigh.value = 3;
  su.mieCoefficient.value = 0.003;
  su.mieDirectionalG.value = 0.86;
  su.sunPosition.value.copy(sunDir);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(light);
  scene.environment = pmrem.fromScene(envScene).texture;
  scene.environmentIntensity = 0.7;
  skyDome = clearSky(16000);
  scene.add(skyDome);

  const normals = new THREE.TextureLoader().load("vendor/three/textures/waternormals.jpg", (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
  });
  const reflection = detectGpu().dedicated ? 1024 : 512;
  water = trueWater(new Water(seaGeometry(), {
    textureWidth: reflection,
    textureHeight: reflection,
    waterNormals: normals,
    sunDirection: sunDir.clone(),
    sunColor: 0xfff1d6,
    waterColor: SEA_BLUE,
    distortionScale: 3.8,
    fog: true
  }));
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

// ---- Hospitaller carrack -----------------------------------------------------
// A 16th-century carrack of the navy of the Knights Hospitaller (model units,
// x forward, 40 long and 13 wide): a round-bellied hull with tumblehome and a
// curved sheer, two rows of gun ports between the wales, an overhanging
// forecastle, a three-storey aftercastle with gallery windows and a lantern,
// square sails on the fore and main masts, a lateen mizzen, a spritsail under
// the bowsprit, fighting tops, shrouds with ratlines, and flags with the cross.
const CARRACK_LIFT = 0.8; // how much higher she floats than drawn below, so both rows of ports stay dry
const CARRACK_HELM = [-9, 11.75 + CARRACK_LIFT, 2.2]; // the helmsman's eye on the quarterdeck, well to starboard so the mast isn't dead ahead
const CARRACK_QUARTERDECK = 10.2;
let carrackTex = null;

function carrackTextures() {
  const planks = ibCanvas(512, 512, (g, w, h) => {
    g.fillStyle = "#cdbba6";
    g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 32) {
      const shade = Math.random();
      g.fillStyle = shade < 0.5 ? `rgba(60,30,10,${shade * 0.4})` : `rgba(255,235,200,${(shade - 0.5) * 0.3})`;
      g.fillRect(0, y, w, 32);
      for (let i = 0; i < 26; i++) { // grain
        g.fillStyle = `rgba(70,40,15,${0.05 + Math.random() * 0.16})`;
        g.fillRect(Math.random() * w, y + Math.random() * 30, 40 + Math.random() * 160, 1 + Math.random());
      }
      g.fillStyle = "rgba(20,10,4,0.75)"; // caulked seam
      g.fillRect(0, y, w, 3);
      const butt = Math.random() * w; // where two planks meet, with their nails
      g.fillRect(butt, y, 2, 32);
      for (const dx of [-9, 10]) for (const dy of [9, 23]) g.fillRect((butt + dx + w) % w, y + dy, 3, 3);
    }
    ibSpeckle(g, w, h, 2600, 0.1);
  });
  const sail = ibCanvas(512, 512, (g, w, h) => {
    g.fillStyle = "#efe4c8";
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 60; i++) { // weather stains
      const x = Math.random() * w;
      const y = Math.random() * h;
      const r = 20 + Math.random() * 80;
      const stain = g.createRadialGradient(x, y, 0, x, y, r);
      stain.addColorStop(0, `rgba(150,115,70,${0.05 + Math.random() * 0.09})`);
      stain.addColorStop(1, "rgba(150,115,70,0)");
      g.fillStyle = stain;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let x = 0; x <= w; x += 46) { // the cloths, sewn side by side
      g.fillStyle = "rgba(110,88,55,0.35)";
      g.fillRect(x, 0, 2, h);
      g.fillStyle = "rgba(255,250,235,0.4)";
      g.fillRect(x + 3, 0, 2, h);
    }
    g.fillStyle = "rgba(110,88,55,0.28)"; // reef bands
    for (const y of [h * 0.3, h * 0.72]) g.fillRect(0, y, w, 4);
    g.strokeStyle = "rgba(95,70,40,0.55)"; // bolt rope round the edge
    g.lineWidth = 10;
    g.strokeRect(0, 0, w, h);
    ibSpeckle(g, w, h, 5000, 0.05);
  });
  // Red cross with spreading arms on white, as on the photo the ship is modelled on.
  const flag = ibCanvas(192, 128, (g, w, h) => {
    g.fillStyle = "#f4f0e6";
    g.fillRect(0, 0, w, h);
    g.translate(w / 2, h / 2);
    g.fillStyle = "#b3202a";
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      g.moveTo(-7, 0);
      g.lineTo(-9, -22);
      g.lineTo(-27, -52);
      g.lineTo(27, -52);
      g.lineTo(9, -22);
      g.lineTo(7, 0);
      g.closePath();
      g.fill();
      g.rotate(Math.PI / 2);
    }
    g.fillRect(-9, -9, 18, 18);
  });
  return { planks, sail, flag };
}

// The hull's line along the top of her sides, and her half-width at (x, y):
// round below, widest just above the water, leaning inwards higher up.
const carrackSheer = (x) => 5.6 + (x < -1 ? 2 * ((x + 1) / 18) ** 2 : 1.2 * ((x + 1) / 20) ** 2);
function carrackHalf(x, y) {
  const bow = clamp((x - 4) / 15.5, 0, 1);
  const stern = clamp((-8 - x) / 11, 0, 1);
  const plan = 6.5 * Math.max(0.05, (1 - bow ** 2.4) ** 0.65) * (1 - 0.32 * stern ** 2);
  const below = 0.2 + 0.8 * Math.sin(clamp((y + 3.5) / 5.5, 0, 1) * (Math.PI / 2)) ** 0.7;
  return plan * (y < 2 ? below : 1 - 0.3 * clamp((y - 2) / 11, 0, 1) ** 1.2);
}

// A closed piece of hull or castle between x = xa and xb: sides from low(x) to
// high(x) at half(x, y), end walls, a plank deck at deck(x) and, if it hangs
// over the water, an underside.
function carrackShell(g, material, deckMat, { xa, xb, low, high, half, deck = high, under = false }) {
  const surface = (nu, nv, point, flip, m) => {
    const pos = [];
    const uv = [];
    const index = [];
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const [x, y, z, u, v] = point(i / nu, j / nv);
        pos.push(x, y, z);
        uv.push(u, v);
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = j * (nu + 1) + i;
        const b = a + 1;
        const c = a + nu + 1;
        const d = c + 1;
        if (flip) index.push(a, c, b, b, c, d);
        else index.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(index);
    geo.computeVertexNormals();
    g.add(mesh(geo, m));
  };
  const across = (x, y, t) => [x, y, t * half(x, y), (t * half(x, y)) / 8, y / 8];
  for (const side of [-1, 1]) {
    surface(40, 14, (s, t) => {
      const x = xa + (xb - xa) * s;
      const y = low(x) + (high(x) - low(x)) * t;
      return [x, y, side * half(x, y), x / 8, (y - 0.7 * (carrackSheer(x) - 5.6)) / 8]; // planks follow the sheer
    }, side < 0, material);
  }
  for (const [x, flip] of [[xa, false], [xb, true]]) surface(8, 10, (s, t) => across(x, low(x) + (high(x) - low(x)) * t, s * 2 - 1), flip, material);
  const flat = (height, flip, m) => surface(40, 6, (s, t) => {
    const x = xa + (xb - xa) * s;
    const z = (t * 2 - 1) * half(x, height(x));
    return [x, height(x), z, z / 8, x / 8]; // deck planks run fore and aft
  }, flip, m);
  flat(deck, true, deckMat);
  if (under) flat(low, false, material);
}

// Square sail hung from its yard, bellying forward, its foot cut in an arch.
function carrackSail(x, top, h, headW, footW, depth, material) {
  const geo = new THREE.PlaneGeometry(2, 1, 16, 12);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i);
    const v = 0.5 - p.getY(i); // 0 at the head, 1 at the foot
    p.setXYZ(i, x + depth * (1 - 0.85 * u * u) * Math.sin(Math.PI * 0.85 * v), top - v * h + h * 0.13 * v * v * (1 - u * u), (u * (headW + (footW - headW) * v)) / 2);
  }
  geo.computeVertexNormals();
  return mesh(geo, material);
}

// The lateen: a three-cornered sail with corners a, b, c ([x, y]), bellying to one side.
function carrackLateen([a, b, c], depth, material) {
  const n = 14;
  const pos = [];
  const uv = [];
  const index = [];
  const row = (i) => i * (n + 1) - (i * (i - 1)) / 2;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n - i; j++) {
      const p = i / n;
      const q = j / n;
      const r = 1 - p - q;
      pos.push(a[0] * p + b[0] * q + c[0] * r, a[1] * p + b[1] * q + c[1] * r, depth * 27 * p * q * r);
      uv.push(q + r * 0.5, p);
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n - i; j++) {
      const k = row(i) + j;
      const up = row(i + 1) + j;
      index.push(k, k + 1, up);
      if (j < n - i - 1) index.push(k + 1, up + 1, up);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return mesh(geo, material);
}

// Returns the material of the stern windows (lit by candle at night).
function hospitallerCarrack(g, color) {
  if (!carrackTex) carrackTex = carrackTextures();
  const fine = bridgeHigh();
  const ship = new THREE.Group();
  const oak = mat(color, { map: carrackTex.planks, bumpMap: carrackTex.planks, bumpScale: 0.6, roughness: 0.72, side: THREE.DoubleSide });
  const deckWood = mat(0xc2a174, { map: carrackTex.planks, roughness: 0.88 });
  const dark = mat(0x2b1a0e, { roughness: 0.75 });
  const trim = mat(0xa87740, { roughness: 0.6 });
  const spar = mat(0x6b4526, { roughness: 0.7 });
  const iron = mat(0x1c1c1e, { roughness: 0.5, metalness: 0.7 });
  const bronze = mat(0x8a6a35, { roughness: 0.35, metalness: 0.85 });
  const cloth = mat(0xffffff, { map: carrackTex.sail, roughness: 0.95, side: THREE.DoubleSide });
  const flagCloth = mat(0xffffff, { map: carrackTex.flag, roughness: 0.9, side: THREE.DoubleSide });
  const glassLit = mat(0x1c120a, { roughness: 0.25, metalness: 0.4, emissive: 0xffa24a, emissiveIntensity: 0 });
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const beam = (a, b, r, m, seg = 8) => ship.add(strut(v(...a), v(...b), r, m, seg));

  // Hull and the castles stacked on it.
  const stern = (y) => (x) => carrackHalf(Math.max(x, -19), y);
  const hull = {
    xa: -19, xb: 19.5,
    low: (x) => -3.5 + (x > 12 ? 4 * ((x - 12) / 7.5) ** 2 : x < -14 ? 2 * ((-14 - x) / 5) ** 2 : 0),
    high: carrackSheer, deck: (x) => carrackSheer(x) - 0.9, half: carrackHalf
  };
  const fore = {
    xa: 9, xb: 21.5, under: true,
    low: (x) => (x < 16 ? carrackSheer(x) - 0.2 : carrackSheer(16) - 0.2 + (x - 16) * 0.3),
    high: (x) => 9 + (x - 9) * 0.06,
    half: (x, y) => (5.5 - 3.2 * ((x - 9) / 12.5) ** 1.6) * (1 - 0.03 * (y - 7))
  };
  const quarter = { xa: -19.8, xb: -5.5, low: (x) => carrackSheer(x) - 0.2, high: () => CARRACK_QUARTERDECK, half: (x, y) => stern(y)(x) };
  const poop = { xa: -20.4, xb: -13, under: true, low: () => CARRACK_QUARTERDECK, high: () => 13.2, half: (x, y) => stern(y)(x) * 0.97 };
  const top = { xa: -21, xb: -17.2, under: true, low: () => 13.2, high: () => 15.4, half: (x, y) => stern(y)(-19) * 0.88 };
  for (const part of [hull, fore, quarter, poop, top]) carrackShell(ship, oak, deckWood, part);

  // A moulding or wale running along both sides of a piece at height y(x).
  const wale = (part, y, r, m, from = part.xa, to = part.xb) => {
    for (const side of [-1, 1]) {
      const pts = [];
      for (let i = 0; i <= 24; i++) {
        const x = from + ((to - from) * i) / 24;
        pts.push(v(x, y(x), side * (part.half(x, y(x)) + r * 0.4)));
      }
      ship.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, r, 6), m));
    }
  };
  for (const [offset, r] of [[0.35, 0.2], [2.5, 0.2], [4.6, 0.17]]) wale(hull, (x) => offset + 0.7 * (carrackSheer(x) - 5.6), r, dark, -19, 18);
  wale(hull, carrackSheer, 0.2, trim);
  for (const part of [fore, quarter, poop, top]) {
    wale(part, part.high, 0.16, trim);
    if (part !== quarter) wale(part, part.low, 0.14, dark);
  }

  // Open rails on the castle decks, along both sides and across the ends.
  const rail = (part, from, to, ends, endH = 1.05) => {
    const h = 1.05;
    wale(part, (x) => part.high(x) + h, 0.09, trim, from, to);
    const post = (x, z) => ship.add(box(0.11, h, 0.11, spar, x, part.high(x) + h / 2, z));
    const step = fine ? 0.55 : 0.95;
    for (let x = from; x <= to + 0.01; x += step) for (const side of [-1, 1]) post(x, side * part.half(x, part.high(x)));
    for (const x of ends) {
      const w = part.half(x, part.high(x));
      for (let z = -w; z <= w; z += step * 1.3) ship.add(box(0.11, endH, 0.11, spar, x, part.high(x) + endH / 2, z));
      ship.add(box(0.14, 0.12, w * 2, trim, x, part.high(x) + endH, 0));
    }
  };
  rail(fore, 9.1, 21.4, [21.4, 9.1]);
  rail(quarter, -12.8, -5.7, [-5.6], 0.5); // low across the front: the helmsman looks over it
  rail(poop, -17, -13.1, [-13.1]);
  rail(top, -20.9, -17.3, [-17.3]);

  // A frame set flush on the side of a piece, turned to follow its curve.
  const onSide = (part, x, y, side) => {
    const at = new THREE.Group();
    at.position.set(x, y, side * part.half(x, y));
    at.rotation.y = -side * Math.atan((part.half(x + 0.3, y) - part.half(x - 0.3, y)) / 0.6);
    ship.add(at);
    return at;
  };
  // Two rows of gun ports, each with its bronze muzzle run out.
  for (const [first, count, y] of [[-14.5, 10, 1.55], [-13, 9, 3.6]]) {
    for (let i = 0; i < count; i++) {
      const x = first + i * 2.85;
      for (const side of [-1, 1]) {
        const at = onSide(hull, x, y + 0.7 * (carrackSheer(x) - 5.6), side);
        at.add(box(1.05, 0.95, 0.24, iron, 0, 0, 0), box(0.78, 0.68, 0.3, mat(0x050403, { roughness: 1 }), 0, 0, 0));
        const gun = cylinder(0.19, 0.25, 0.9, bronze, 0, -0.05, side * 0.4, 10);
        gun.rotation.x = side * (Math.PI / 2);
        at.add(gun, box(1.15, 0.14, 0.5, dark, 0, 0.62, side * 0.18)); // the lid, raised
      }
    }
  }
  // Windows: along the castle sides and across the stern.
  const windowAt = (parent, facingX) => {
    const w = new THREE.Group();
    w.add(box(0.78, 1.06, 0.14, trim, 0, 0, 0), box(0.56, 0.84, 0.18, glassLit, 0, 0, 0));
    w.add(box(0.06, 0.84, 0.22, trim, 0, 0, 0), box(0.56, 0.06, 0.22, trim, 0, 0.12, 0));
    if (facingX) w.rotation.y = Math.PI / 2;
    parent.add(w);
    return w;
  };
  for (const [part, from, to, y, step] of [[fore, 10.2, 16.6, 7.9, 1.05], [quarter, -18.2, -12, 8.75, 1.3], [poop, -19.6, -13.9, 11.7, 1.15], [top, -20.4, -17.8, 14.3, 1.05]]) {
    for (let x = from; x <= to; x += step) for (const side of [-1, 1]) windowAt(onSide(part, x, y, side), false);
  }
  for (const [part, y] of [[quarter, 8.9], [poop, 11.7], [top, 14.3]]) {
    const w = part.half(part.xa, y) - 0.6;
    const n = Math.max(2, Math.floor((w * 2) / 1.1) + 1);
    for (let i = 0; i < n; i++) windowAt(ship, true).position.set(part.xa - 0.04, y, -w + (i * w * 2) / (n - 1));
    // the gallery under each row
    ship.add(box(0.7, 0.18, w * 2 + 1.4, trim, part.xa - 0.3, y - 0.72, 0));
    if (fine) for (let z = -w - 0.4; z <= w + 0.4; z += 0.5) ship.add(box(0.1, 0.5, 0.1, spar, part.xa - 0.55, y - 0.42, z));
  }
  // The stern lantern and the shield with its cross.
  ship.add(cylinder(0.12, 0.16, 1.4, bronze, -20.6, 16.1, 0, 8));
  ship.add(cylinder(0.55, 0.4, 1.1, mat(0x1c120a, { roughness: 0.25, metalness: 0.4 }), -20.6, 17.35, 0, 8)); // unlit
  ship.add(cylinder(0.06, 0.7, 0.55, bronze, -20.6, 18.15, 0, 8));
  const shield = mesh(new THREE.CircleGeometry(1, 24), mat(0xffffff, { map: carrackTex.flag, roughness: 0.6, side: THREE.DoubleSide }));
  shield.position.set(-21.12, 12.9, 0);
  shield.rotation.y = -Math.PI / 2;
  ship.add(shield);

  // Rudder, stem, and an anchor catted at each bow.
  ship.add(box(0.9, 6.5, 0.5, dark, -19.4, 0.4, 0));
  const stem = new THREE.CatmullRomCurve3([v(15.5, -2.8, 0), v(18.8, -0.6, 0), v(20.2, 2.6, 0), v(21.6, 6.2, 0)]);
  ship.add(mesh(new THREE.TubeGeometry(stem, 30, 0.45, 8), dark));
  for (const side of [-1, 1]) {
    const z = side * (carrackHalf(15, 4) + 0.5);
    beam([15.6, 6.2, z], [15.1, 2.4, z], 0.14, iron);
    for (const dx of [-0.9, 0.9]) beam([15.1, 2.4, z], [15.1 + dx, 3.3, z], 0.12, iron);
    beam([15.5, 6, z - 0.7], [15.5, 6, z + 0.7], 0.14, spar);
  }

  // Masts, fighting tops, yards and sails.
  for (const [x, from, mid, to, r] of [[8.5, 4, 23.5, 33.5, 0.55], [-2, 4, 26, 41, 0.62], [-14.5, 10, 24, 29.5, 0.4]]) {
    ship.add(cylinder(r * 0.75, r, mid - from, spar, x, (mid + from) / 2, 0, 12));
    ship.add(cylinder(r * 0.28, r * 0.55, to - mid + 1.2, spar, x, (to + mid - 1.2) / 2, 0, 8));
    // rope wooldings binding the made-up lower mast
    for (let y = from + 3; y < mid - 3; y += 2.4) ship.add(cylinder(r * 1.07, r * 1.07, 0.35, dark, x, y, 0, 12));
  }
  const fightingTop = (x, y, r) => {
    ship.add(cylinder(r, r * 0.65, 0.5, dark, x, y, 0, 16));
    const ring = mesh(new THREE.TorusGeometry(r, 0.09, 6, 24), trim);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, y + 1.15, 0);
    ship.add(ring);
    for (let i = 0; i < 14; i++) ship.add(box(0.1, 1.1, 0.1, spar, x + Math.cos((i * Math.PI) / 7) * r, y + 0.65, Math.sin((i * Math.PI) / 7) * r));
  };
  fightingTop(8.5, 23, 1.55);
  fightingTop(-2, 25.6, 1.95);
  fightingTop(-2, 36.6, 0.9);
  fightingTop(28, 16.2, 0.75);
  const yard = (x, y, len, r) => {
    const m = cylinder(r * 0.6, r * 0.6, len, spar, x, y, 0, 8);
    m.rotation.x = Math.PI / 2;
    const middle = cylinder(r, r, len * 0.4, spar, x, y, 0, 8);
    middle.rotation.x = Math.PI / 2;
    ship.add(m, middle);
  };
  // [x, head height, drop, width at head, width at foot, belly]
  const sails = [
    [9.1, 22, 7.6, 13, 15, 3], [9, 30.6, 6.4, 8, 12.4, 2.2], // fore course and topsail
    [-1.3, 24.6, 9.4, 15.6, 17.4, 3.4], [-1.4, 35.4, 8.8, 9.6, 14.6, 2.8], // main course and topsail
    [26.3, 13.8, 4.6, 8.4, 9, 1.6] // spritsail
  ];
  for (const [x, head, drop, headW, footW, belly] of sails) {
    ship.add(carrackSail(x, head, drop, headW, footW, belly, cloth));
    yard(x, head + 0.15, headW + 1.2, 0.3);
  }
  beam([16, 8.2, 0], [29.5, 16.2, 0], 0.4, spar); // bowsprit
  ship.add(cylinder(0.12, 0.2, 5, spar, 28, 18.2, 0, 8)); // spritsail topmast
  beam([-7.4, 14.4, 0], [-22.8, 29.6, 0], 0.22, spar); // lateen yard
  ship.add(carrackLateen([[-8, 14.8], [-22.4, 29], [-22.8, 15.4]], 1.8, cloth));

  // Flags at the mastheads, flying forward with the wind astern.
  for (const [x, y, w] of [[8.5, 34.2, 5], [-2, 41.8, 6]]) {
    const geo = new THREE.PlaneGeometry(w, w * 0.64, 16, 1);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin((p.getX(i) / w + 0.5) * 8) * 0.45 * (p.getX(i) / w + 0.5));
    geo.computeVertexNormals();
    const flag = mesh(geo, flagCloth, false);
    flag.position.set(x + w / 2 + 0.2, y, 0);
    ship.add(flag, cylinder(0.07, 0.1, w * 0.64 + 1, spar, x, y - 0.1, 0, 6));
  }

  // Rigging: tarred shrouds, ratlines and stays, hemp lifts, braces and sheets.
  const standing = [];
  const running = [];
  // a rope from a to b, hanging `slack` of its length
  const rope = (into, a, b, r, slack, sides = 5) => {
    const from = v(...a);
    const to = v(...b);
    const seed = into.length * 2.4;
    const sway = slack < 0.005 ? 0 : into === running ? 0.09 : 0.04; // the shrouds are set up bar taut
    into.push({ curve: ropeCurve(from, to, { sag: from.distanceTo(to) * slack * (0.7 + 0.6 * hash3(...a, 1)), kink: slack, seed }), r, sides, sway });
  };
  // where a rope led down to the ship's side is made fast: on the rail or bulwark there
  const belay = (x, side) => {
    const part = x <= poop.xb ? poop : x <= quarter.xb ? quarter : x >= fore.xa ? fore : hull;
    return [x, part.high(x) + (part === hull ? 0.15 : 1.05), side * part.half(x, part.high(x))];
  };
  // [mast x, head of the shrouds, their half spread at the head, first foot x, foot spacing, foot height(x), foot half-width(x)]
  const shrouds = [
    [8.5, 22.8, 1.1, 8, -0.8, carrackSheer, (x) => carrackHalf(x, carrackSheer(x))],
    [-2, 25.4, 1.4, -1.8, -0.8, carrackSheer, (x) => carrackHalf(x, carrackSheer(x))],
    [-14.5, 23.4, 0.4, -14.8, -0.75, poop.high, (x) => poop.half(x, 13.2)],
    [8.5, 32.6, 0.2, 9.4, -0.55, () => 23.2, () => 1.5],
    [-2, 36.4, 0.3, -1.1, -0.6, () => 25.8, () => 1.9],
    [-2, 40.4, 0.1, -1.6, -0.35, () => 36.8, () => 0.85]
  ];
  for (const [mx, headY, headZ, x0, step, footY, footZ] of shrouds) {
    for (const side of [-1, 1]) {
      const legs = [0, 1, 2, 3, 4].map((k) => {
        const x = x0 + k * step;
        return [[x, footY(x), side * footZ(x)], [mx, headY, side * headZ]];
      });
      for (const [a, b] of legs) rope(standing, a, b, 0.1, 0.004);
      const rungs = Math.floor((headY - legs[0][0][1]) / (fine ? 0.75 : 1.8));
      for (let i = 1; i < rungs; i++) {
        // each rung is seized to every shroud and sags between them, no two quite alike
        const points = [];
        for (let k = 0; k < 5; k++) {
          const t = (i + (hash3(i, k, mx, side) - 0.5) * 0.22) / rungs;
          const at = v(...legs[k][0]).lerp(v(...legs[k][1]), t);
          if (k) points.push(at.clone().lerp(points[points.length - 1], 0.5).add(v(0, -0.05 - 0.1 * hash3(i, k, headY, side), 0)));
          points.push(at);
        }
        standing.push({ curve: new THREE.CatmullRomCurve3(points), r: 0.05, sides: 3, sway: 0.022, spans: 4 });
      }
    }
  }
  for (const [a, b] of [
    [[8.5, 23, 0], [22, 11.8, 0]], [[8.5, 33, 0], [29.5, 16.2, 0]], [[8.5, 28, 0], [26, 14.2, 0]], [[28, 20.6, 0], [8.5, 31, 0]], // fore stays
    [[-2, 25.8, 0], [9, 9.2, 0]], [[-2, 36.6, 0], [8.5, 24.2, 0]], [[-2, 41, 0], [8.5, 33, 0]], // main stays
    [[-14.5, 29, 0], [-2, 25.8, 0]], [[28, 20.6, 0], [29.5, 16.2, 0]], [[28, 20.6, 0], [21.4, 10.8, 0]], [[-22.8, 29.6, 0], [-14.5, 29.2, 0]], [[-22.8, 15.4, 0], [-20.8, 15.6, 0]]
  ]) rope(standing, a, b, 0.11, 0.012);
  for (const side of [-1, 1]) {
    rope(standing, [-2, 40.6, 0], [-12, 11.3, side * quarter.half(-12, 10.2)], 0.1, 0.007); // backstays
    rope(standing, [8.5, 33, 0], [3.5, carrackSheer(3.5), side * carrackHalf(3.5, 5.8)], 0.1, 0.007);
    sails.slice(0, 4).forEach(([x, head, drop, headW, footW, belly], i) => {
      const mastTop = x > 0 ? 33 : 40.6;
      const end = side * (headW / 2 + 0.6);
      rope(running, [x, head + 0.15, end], [x > 0 ? 8.5 : -2, Math.min(mastTop, head + 4), 0], 0.065, 0.02); // lift
      rope(running, [x, head + 0.15, end], belay(x - 9, side), 0.075, 0.025); // brace
      // sheet: from the sail's lower corner to the rail, or a topsail's to the yard below it
      const lower = i % 2 ? sails[i - 1] : null;
      const to = lower ? [lower[0], lower[1] + 0.15, side * (lower[3] / 2 + 0.4)] : belay(x - 4, side);
      rope(running, [x + belly * 0.07, head - drop, (side * footW) / 2], to, 0.09, 0.03);
    });
  }

  mergeStaticMeshes(ship, new Set());
  addRigging(ship, standing, tarredMat);
  addRigging(ship, running, runningMat);
  ship.position.y = CARRACK_LIFT;
  g.add(ship);
  return glassLit;
}

// ---- The Order's galley ------------------------------------------------------
// A Hospitaller galley (model units, x forward, about 44 long): a low narrow
// hull with a long spur at the bow, a rowing frame each side painted red with
// white crosses, two banks of long oars that sweep together, two masts with
// slanting lateen yards (sails furled on them) flying long red pennants, a
// skiff on deck and a red and gold awning over the stern.
const GALLEY_HELM = [-12.5, 5.2, 0.9]; // the helmsman's eye, just forward of the awning
const GALLEY_DECK = 2.6; // top of the after deck he stands on
const GALLEY_OARS = { count: 20, first: -11, step: 1.25, z: 4.5, y: 2.1 };
let galleyTex = null;

function galleyTextures() {
  const side = ibCanvas(512, 64, (g, w, h) => {
    g.fillStyle = "#a81c24";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#c9a24a";
    g.fillRect(0, 0, w, 6);
    g.fillRect(0, h - 6, w, 6);
    g.fillStyle = "#f2ede0";
    for (let x = 32; x < w; x += 64) {
      g.fillRect(x - 4, 14, 8, 36);
      g.fillRect(x - 15, 28, 30, 8);
    }
  });
  // the Order's banner: red with a white cross
  const banner = ibCanvas(128, 256, (g, w, h) => {
    g.fillStyle = "#b3202a";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#f4f0e6";
    g.fillRect(w / 2 - 7, 0, 14, h);
    g.fillRect(0, h * 0.22, w, 14);
    g.strokeStyle = "#c9a24a";
    g.lineWidth = 8;
    g.strokeRect(0, 0, w, h);
  });
  const awning = ibCanvas(256, 256, (g, w, h) => {
    g.fillStyle = "#a81c24";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#d7ab45";
    for (let x = 0; x < w; x += 32) g.fillRect(x, 0, 9, h);
    ibSpeckle(g, w, h, 900, 0.09);
  });
  return { side, banner, awning };
}

const galleyHalf = (x, y) => 3.5 * Math.max(0.08, 1 - clamp((Math.abs(x + 1) - 9) / 13, 0, 1) ** 2) * (0.55 + 0.45 * clamp((y + 1.4) / 2.6, 0, 1));

// Returns the oars (one instanced mesh each for looms and blades).
function hospitallerGalley(g) {
  if (!carrackTex) carrackTex = carrackTextures();
  if (!galleyTex) galleyTex = galleyTextures();
  const ship = new THREE.Group();
  const black = mat(0x1d1612, { map: carrackTex.planks, roughness: 0.6, side: THREE.DoubleSide });
  const deckWood = mat(0xb98f5e, { map: carrackTex.planks, roughness: 0.88 });
  const spar = mat(0x6b4526, { roughness: 0.7 });
  const gold = mat(0xb8913c, { roughness: 0.35, metalness: 0.8 });
  const red = mat(0xa81c24, { roughness: 0.7 });
  const cloth = mat(0xffffff, { map: carrackTex.sail, roughness: 0.95 });
  const bannerCloth = mat(0xffffff, { map: galleyTex.banner, roughness: 0.9, side: THREE.DoubleSide });
  const sideTex = galleyTex.side.clone();
  sideTex.repeat.set(4, 1);
  sideTex.needsUpdate = true;
  const painted = mat(0xffffff, { map: sideTex, roughness: 0.65 });
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const beam = (a, b, r, m, seg = 8) => ship.add(strut(v(...a), v(...b), r, m, seg));

  carrackShell(ship, black, deckWood, {
    xa: -21, xb: 20, low: (x) => -1.4 + (Math.abs(x) > 13 ? 1.6 * ((Math.abs(x) - 13) / 8) ** 2 : 0),
    high: (x) => 1.7 + 1.3 * (x / 21) ** 4, deck: () => 1.55, half: galleyHalf
  });
  // The after deck and the fighting platform at the bow.
  ship.add(box(8.5, 0.35, 5.4, deckWood, -13.6, GALLEY_DECK - 0.18, 0), box(8.5, 0.8, 5, red, -13.6, GALLEY_DECK - 0.75, 0));
  ship.add(box(4.5, 0.35, 5, deckWood, 14.6, 2.7, 0), box(4.5, 0.9, 4.6, red, 14.6, 2.1, 0));
  for (const z of [-1.2, 1.2]) beam([14.5, 3.3, z], [18.4, 3.3, z], 0.3, mat(0x25262a, { roughness: 0.4, metalness: 0.8 }), 10); // bow guns
  // The rowing frame, the gangway down the middle and the rowers' benches.
  for (const s of [-1, 1]) {
    ship.add(box(27, 0.75, 0.35, painted, 0.9, 2.0, s * GALLEY_OARS.z));
    for (let x = -12; x <= 14; x += 3.25) beam([x, 1.7, s * 3], [x, 1.8, s * GALLEY_OARS.z], 0.13, spar);
    for (let i = 0; i < GALLEY_OARS.count; i++) ship.add(box(0.35, 0.3, 2.5, spar, GALLEY_OARS.first + i * GALLEY_OARS.step + 0.35, 1.75, s * 1.9));
  }
  ship.add(box(24, 0.5, 0.9, deckWood, 0.5, 1.95, 0));
  // Spur, stem and rudder.
  beam([18.5, 2.1, 0], [28, 2.4, 0], 0.32, spar);
  beam([18.5, 1.2, 0], [24.5, 2.1, 0], 0.18, gold);
  ship.add(box(0.5, 3.4, 0.35, black, -21.2, 0.3, 0));
  // The awning on its gilded hoops, and the carved stern behind it.
  const awningMat = mat(0xffffff, { map: galleyTex.awning, roughness: 0.85, side: THREE.DoubleSide });
  const awning = mesh(new THREE.CylinderGeometry(2.9, 2.9, 5.6, 24, 1, true, 0, Math.PI), awningMat);
  awning.rotation.z = Math.PI / 2; // the axis fore and aft, the open half downwards
  awning.scale.set(0.5, 1, 1);
  awning.position.set(-18, 5.6, 0);
  ship.add(awning);
  for (const x of [-20.7, -18, -15.3]) for (const s of [-1, 1]) beam([x, GALLEY_DECK, s * 2.7], [x, 5.65, s * 2.85], 0.09, gold);
  ship.add(box(0.5, 2.2, 5.2, red, -21, 2.8, 0), box(0.6, 0.3, 5.5, gold, -21, 4, 0));
  for (const s of [-1, 1]) ship.add(box(8.8, 0.18, 0.18, gold, -13.6, GALLEY_DECK + 0.05, s * 2.75));
  // A skiff stowed amidships.
  carrackShell(ship, mat(0x7a5430, { roughness: 0.8, side: THREE.DoubleSide }), spar, {
    xa: 0.5, xb: 6, low: () => 2.5, high: () => 3.4, deck: () => 2.9, half: (x) => 1.1 * Math.max(0.15, 1 - ((x - 3.25) / 2.75) ** 4), under: true
  });
  // Masts, lateen yards with the furled sails, pennants and flags.
  const standing = [];
  const running = [];
  // a rope from a to b, hanging `slack` of its length
  const rope = (into, a, b, r, slack) => {
    const from = v(...a);
    const to = v(...b);
    const sway = slack <= 0.005 ? 0 : into === running ? 0.075 : 0.032;
    into.push({ curve: ropeCurve(from, to, { sag: from.distanceTo(to) * slack, kink: slack, seed: into.length * 2.4 }), r, sides: 5, sway });
  };
  for (const [x, top, fore, aft, low, high] of [[9, 20, 18.5, -1, 6.5, 25], [-4, 23, 6, -17, 7, 31]]) {
    ship.add(cylinder(0.2, 0.42, top - 1.5, spar, x, (top + 1.5) / 2, 0, 10));
    const from = [fore, low, 0.45];
    const to = [aft, high, 0.45];
    beam(from, to, 0.2, spar);
    const along = (t) => from.map((n, i) => n + (to[i] - n) * t);
    // the sail, gathered under the yard in bunches tied off with gaskets
    for (let i = 0; i < 7; i++) {
      const a = along(0.04 + i * 0.12);
      const b = along(0.04 + (i + 1) * 0.12);
      beam([a[0], a[1] - 0.45, a[2]], [b[0], b[1] - 0.45, b[2]], 0.5 - Math.abs(i - 3) * 0.05, cloth);
      beam([b[0] - 0.08, b[1] - 1, b[2]], [b[0] + 0.08, b[1] + 0.2, b[2]], 0.09, spar, 6);
    }
    // the long pennant hanging from the upper arm of the yard
    const at = along(0.78);
    const shape = new THREE.Shape();
    shape.moveTo(-1.7, 0);
    shape.lineTo(1.7, 0);
    shape.lineTo(0, -11.5);
    const cut = new THREE.ShapeGeometry(shape);
    const uv = cut.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) + 1.7) / 3.4, (uv.getY(i) + 11.5) / 11.5);
    const pennant = mesh(cut, bannerCloth, false);
    pennant.position.set(at[0], at[1] - 1, 0.9);
    ship.add(pennant);
    beam([at[0] - 1.9, at[1] - 1, 0.9], [at[0] + 1.9, at[1] - 1, 0.9], 0.08, gold, 6);
    rope(running, [at[0], at[1] - 1, 0.9], at, 0.04, 0);
    const flag = mesh(new THREE.PlaneGeometry(3, 1.9), bannerCloth, false);
    flag.position.set(x - 1.6, top + 0.2, 0);
    ship.add(flag);
    for (const s of [-1, 1]) for (const dx of [-1.5, -3.5, -5.5]) rope(standing, [x, top - 1, 0], [x + dx, 2.4, s * 3.6], 0.09, 0.005); // shrouds
    rope(standing, [x, top - 0.5, 0], [x + 9, 3, 0], 0.1, 0.015);
    rope(running, from, [fore + 1, 2.4, 0], 0.075, 0.04);
    rope(running, to, [aft + 1, 3.2, 2], 0.075, 0.05);
  }
  beam([-20.8, 4, 0], [-21.6, 9, 0], 0.1, spar);
  const ensign = mesh(new THREE.PlaneGeometry(3.4, 2.2), bannerCloth, false);
  ensign.position.set(-23.3, 7.9, 0);
  ship.add(ensign);
  mergeStaticMeshes(ship, new Set());
  addRigging(ship, standing, tarredMat);
  addRigging(ship, running, runningMat);
  g.add(ship);
  // The oars: each pivots on the rowing frame (posed by poseOars).
  const total = GALLEY_OARS.count * 2;
  const loom = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.16, 10.4).translate(0, 0, 3.2), mat(0x7e2a20, { roughness: 0.6 }), total);
  const blade = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.07, 1.8).translate(0, 0, 8.9), mat(0x8e2f22, { roughness: 0.55 }), total);
  for (const im of [loom, blade]) {
    im.castShadow = true;
    im.frustumCulled = false;
    g.add(im);
  }
  const oars = { parts: [loom, blade], phase: 0 };
  poseOars(oars, 0, 0);
  return oars;
}

const oarPose = new THREE.Object3D();

// All oars move together: forward and back, dipping as they pull. `work` 0
// (lifted clear, at rest) .. 1 (rowing).
function poseOars(oars, phase, work) {
  const { count, first, step, z, y } = GALLEY_OARS;
  let n = 0;
  for (const side of [-1, 1]) {
    for (let i = 0; i < count; i++) {
      const sweep = 0.34 * Math.cos(phase) * work;
      oarPose.position.set(first + i * step, y, side * z);
      oarPose.rotation.set(0.13 + (0.12 + 0.1 * Math.sin(phase)) * work, side > 0 ? sweep : Math.PI - sweep, 0, "YXZ");
      oarPose.updateMatrix();
      for (const im of oars.parts) im.setMatrixAt(n, oarPose.matrix);
      n++;
    }
  }
  for (const im of oars.parts) im.instanceMatrix.needsUpdate = true;
}

// ---- Harbour tug --------------------------------------------------------------
// Modelled on a modern harbour tug seen in the Grand Harbour (model units, x
// forward, +z starboard): a deep, blunt bow with a high sheer falling to a low
// after deck, a broad ribbed rubber belt round the bow with rubbing strakes
// sweeping aft from it, a white deckhouse, an eight-sided wheelhouse with tall
// outward-leaning windows under a glazed roof in the hull's colour, two horned
// exhaust stacks, a white mast crowded with radars, a black deck crane to
// starboard, and the towing winch and hook aft.
const TUG = { aft: -15.4, bow: 15.5, shoulder: 3, half: 6.1 };
const tugSheer = (x) => (x > TUG.shoulder ? 3.8 + 1.5 * ((x - TUG.shoulder) / 12.5) ** 1.6 : 3.3 + 0.5 * THREE.MathUtils.smoothstep(x, -5, TUG.shoulder));
const tugDeck = (x) => tugSheer(x) - 0.95;

// A point on the hull's skin, `proud` units outside it. x is measured along the
// top; the bow rakes back below it, so low points near the stem lie further aft.
function tugSkin(x, y, side, proud = 0) {
  const { shoulder, bow, half } = TUG;
  const f = clamp((x - shoulder) / (bow - shoulder), 0, 1);
  const stern = clamp((-9 - x) / (-9 - TUG.aft), 0, 1);
  const below = 0.5 + 0.5 * Math.sin(clamp((y + 3.4) / 4.4, 0, 1) * (Math.PI / 2)) ** 0.7;
  const flare = 1 - f * 0.14 * (1 - clamp(y / 5, 0, 1));
  const w = half * (1 - f ** 2.5) ** 0.55 * (1 - 0.3 * stern ** 3) * below * flare;
  const tip = bow - 2.4 * (1 - clamp((y + 0.5) / 5.5, 0, 1)) ** 1.4;
  const px = x > shoulder ? shoulder + ((x - shoulder) * (tip - shoulder)) / (bow - shoulder) : x;
  // outwards: sideways amidships, swinging round to straight ahead at the stem
  const turn = f ** 3;
  return new THREE.Vector3(px + proud * turn, y, side * (w + proud * (1 - turn)));
}

// A grid of points as one surface; point(s, t) gives [Vector3, u, v].
function tugSurface(nu, nv, point, material) {
  const pos = [];
  const uv = [];
  const index = [];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const [p, u, v] = point(i / nu, j / nv);
      pos.push(p.x, p.y, p.z);
      uv.push(u, v);
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      const c = a + nu + 1;
      index.push(a, a + 1, c, a + 1, c + 1, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return mesh(geo, material);
}

// An upright block from plan `low` at y0 to plan `high` at y1 (lists of [x, z],
// anticlockwise seen from above), with flat faces.
function tugPrism(low, high, y0, y1, material) {
  const pos = [];
  const uv = [];
  const tri = (...points) => {
    for (const [x, y, z] of points) {
      pos.push(x, y, z);
      uv.push((x + z) / 8, y / 8);
    }
  };
  const at = (plan, i, y) => [plan[i][0], y, plan[i][1]];
  const n = low.length;
  for (let i = 0; i < n; i++) {
    const k = (i + 1) % n;
    tri(at(low, i, y0), at(low, k, y0), at(high, k, y1));
    tri(at(low, i, y0), at(high, k, y1), at(high, i, y1));
  }
  for (let i = 1; i < n - 1; i++) {
    tri(at(high, 0, y1), at(high, i, y1), at(high, i + 1, y1));
    tri(at(low, 0, y0), at(low, i + 1, y0), at(low, i, y0));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return mesh(geo, material);
}

let tugTex = null;

function tugTextures() {
  // Painted steel: plate seams, rust weeps and scuffs (tinted by the hull colour).
  const paint = ibCanvas(512, 512, (g, w, h) => {
    g.fillStyle = "#f6f2ee";
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) {
      g.fillStyle = `rgba(90,50,30,${0.03 + Math.random() * 0.07})`;
      g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 20 + Math.random() * 90);
    }
    g.fillStyle = "rgba(60,30,20,0.16)";
    for (const y of [150, 330, 500]) g.fillRect(0, y, w, 2);
    for (let x = 0; x < w; x += 170) g.fillRect(x, 0, 2, h);
    ibSpeckle(g, w, h, 3000, 0.04);
  });
  // The rubber belt's moulded ribs.
  const ribs = ibCanvas(64, 16, (g, w, h) => {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#4a4a4a";
    for (let x = 0; x < w; x += 16) g.fillRect(x, 0, 7, h);
  });
  return { paint, ribs };
}

function harbourTug(g, color) {
  if (!tugTex) tugTex = tugTextures();
  const fine = bridgeHigh();
  const paint = mat(color, { map: tugTex.paint, roughness: 0.48, metalness: 0.12, side: THREE.DoubleSide });
  const white = mat(0xe9e8e2, { roughness: 0.5 });
  const rubber = mat(0x151515, { roughness: 0.92 });
  const belt = mat(0x1c1c1c, { map: tugTex.ribs, bumpMap: tugTex.ribs, bumpScale: 1.4, roughness: 0.85, side: THREE.DoubleSide });
  const deckPaint = mat(0x4a4f4c, { roughness: 0.9, side: THREE.DoubleSide });
  const iron = mat(0x1e2023, { roughness: 0.55, metalness: 0.5 });
  const soot = mat(0x37332e, { roughness: 0.5, metalness: 0.55 });
  const glass = mat(0x13232c, { roughness: 0.08, metalness: 0.8 });
  const red = mat(0xb81d14, { roughness: 0.5 });
  const blue = mat(0x244a9c, { roughness: 0.5 });
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  // Fixed parts are gathered in a few groups and merged by material (few draw
  // calls). Each group stays on its own side of the bridge room, so from inside
  // only the wheelhouse and mast are hidden.
  const low = new THREE.Group();
  const top = new THREE.Group();
  const crane = new THREE.Group();
  const stacks = [new THREE.Group(), new THREE.Group()];
  const bar = (into, a, b, r, m, seg = 6) => into.add(strut(v(...a), v(...b), r, m, seg));
  const tube = (into, points, r, m) => into.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), points.length * 3, r, 8), m));
  // x positions bunched towards both ends, where the hull curves most
  const along = (a, b, s) => a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * s));

  // Hull, bulwarks and decks.
  for (const side of [-1, 1]) {
    low.add(tugSurface(48, 16, (s, t) => {
      const x = along(TUG.aft, TUG.bow, s);
      const y = -3.4 + (tugSheer(x) + 3.4) * t;
      return [tugSkin(x, y, side), x / 8, y / 8];
    }, paint));
    const cap = [];
    for (let i = 0; i <= 40; i++) {
      const x = along(TUG.aft, TUG.bow, i / 40);
      cap.push(tugSkin(x, tugSheer(x), side));
    }
    tube(low, cap, 0.16, paint);
  }
  low.add(tugSurface(6, 12, (s, t) => {
    const y = -3.4 + (tugSheer(TUG.aft) + 3.4) * t;
    const p = tugSkin(TUG.aft, y, 1);
    p.z *= s * 2 - 1;
    return [p, p.z / 8, y / 8];
  }, paint));
  low.add(tugSurface(48, 4, (s, t) => {
    const x = along(TUG.aft, TUG.bow, s);
    const p = tugSkin(x, tugDeck(x), 1);
    p.z *= t * 2 - 1;
    return [p, x / 8, p.z / 8];
  }, deckPaint));

  // The ribbed belt round the bow, high under the bulwark.
  for (const side of [-1, 1]) {
    low.add(tugSurface(40, 8, (s, t) => {
      const x = along(4, TUG.bow, 0.5 + s / 2);
      const y = tugSheer(x) - 2.1 + 1.35 * t;
      return [tugSkin(x, y, side, 0.5 * Math.sin(Math.PI * t) ** 0.3), x * 1.1, t];
    }, belt));
    // Its edges, and the two strakes sweeping aft from it: one along the sheer, one down towards the water.
    const run = (from, to, y, r) => {
      const points = [];
      for (let i = 0; i <= 24; i++) {
        const x = along(from, to, i / 24);
        points.push(tugSkin(x, y(x), side, r * 0.6));
      }
      tube(low, points, r, rubber);
    };
    const upper = (x) => tugSheer(x) - 1;
    const lower = (x) => 0.9 + (tugSheer(x) - 3) * THREE.MathUtils.smoothstep(x, -1, 9.5);
    run(4, TUG.bow, (x) => tugSheer(x) - 0.75, 0.17);
    run(7, TUG.bow, (x) => tugSheer(x) - 2.1, 0.22);
    run(TUG.aft, 7.5, upper, 0.3);
    run(TUG.aft, 8, lower, 0.3);
    for (let x = -11.5; x <= 4; x += 2.4) {
      const a = tugSkin(x + 0.7, upper(x + 0.7), side, 0.15);
      const b = tugSkin(x, lower(x), side, 0.15);
      low.add(strut(a, b, 0.2, rubber));
    }
    // Anchor pocket in the bow, with its lip, and the draught marks under it.
    const x = 14.1;
    const a = tugSkin(x - 0.45, 1.75, side);
    const b = tugSkin(x + 0.45, 1.75, side);
    const mid = tugSkin(x, 1.75, side);
    const yaw = Math.atan2(a.z - b.z, b.x - a.x);
    for (const [w, h, d, m, y] of [[1.25, 0.8, 0.16, rubber, 1.75], [1.5, 0.14, 0.34, paint, 1.28]]) {
      const pocket = box(w, h, d, m, mid.x, y, mid.z);
      pocket.rotation.y = yaw;
      low.add(pocket);
    }
    for (let y = 0.25; y < 1.1; y += 0.32) {
      const p = tugSkin(14.7, y, side, 0.03);
      const mark = box(0.22, 0.12, 0.06, white, p.x, y, p.z);
      mark.rotation.y = yaw;
      low.add(mark);
    }
  }
  // Heavy stern fender, and the big rubber rolls on the quarters.
  const sternLine = [];
  for (let i = 0; i <= 12; i++) {
    const p = tugSkin(TUG.aft, 2.3, 1, 0);
    p.z *= i / 6 - 1;
    p.x -= 0.45 + 0.5 * (1 - (i / 6 - 1) ** 2);
    sternLine.push(p);
  }
  tube(low, sternLine, 0.7, rubber);
  for (const side of [-1, 1]) {
    for (const x of [-14.6, -12.4]) {
      const p = tugSkin(x, 2.4, side, 0.55);
      const roll = mesh(new THREE.CapsuleGeometry(0.72, 0.8, 4, 12), rubber);
      roll.rotation.z = Math.PI / 2;
      roll.position.copy(p);
      low.add(roll);
    }
  }

  // White rails: posts with a top and a middle bar along a line of points.
  const rail = (into, points, h = 1) => {
    for (let i = 0; i < points.length - 1; i++) {
      const a = v(...points[i]);
      const b = v(...points[i + 1]);
      for (const k of [h, h * 0.55]) into.add(strut(a.clone().setY(a.y + k), b.clone().setY(b.y + k), 0.05, white, 5));
      const posts = Math.max(1, Math.round(a.distanceTo(b) / (fine ? 0.9 : 1.8)));
      for (let n = 0; n <= posts; n++) {
        const p = a.clone().lerp(b, n / posts);
        into.add(strut(p, p.clone().setY(p.y + h), 0.05, white, 5));
      }
    }
  };
  for (const side of [-1, 1]) {
    const points = [];
    for (let x = -4.5; x <= 7.5; x += 2) {
      const p = tugSkin(x, tugSheer(x), side, -0.1);
      points.push([p.x, p.y, p.z]);
    }
    rail(low, points, 0.85);
  }

  // Deckhouse, with its doors, windows, lifebuoys and the fire locker.
  const house = [[9.4, 2.3], [9.4, -2.3], [8.2, -3.9], [-0.8, -3.9], [-1.8, -3], [-1.8, 3], [-0.8, 3.9], [8.2, 3.9]];
  low.add(tugPrism(house, house, 2.2, 6.1, white));
  const grow = (plan, k, cx = 4) => plan.map(([x, z]) => [cx + (x - cx) * k, z * k]);
  low.add(tugPrism(grow(house, 1.07), grow(house, 1.07), 6.1, 6.35, white));
  for (const side of [-1, 1]) {
    for (const x of [0.4, 2.4, 6.4]) low.add(box(0.8, 0.7, 0.08, glass, x, 5, side * 3.93));
    low.add(box(1, 2, 0.1, iron, 4.4, 4.1, side * 3.93));
  }
  for (const z of [0, 1.4]) low.add(box(0.08, 0.6, 0.7, glass, 9.43, 5.45, z));
  low.add(box(0.14, 0.95, 0.95, red, 9.47, 5.4, -1.5));
  const disc = cylinder(0.24, 0.24, 0.05, white, 9.56, 5.4, -1.5, 16);
  disc.rotation.z = Math.PI / 2;
  low.add(disc);
  rail(low, [[-1.9, 6.35, 3.2], [-0.8, 6.35, 4.15], [8.3, 6.35, 4.15], [9.75, 6.35, 2.4], [9.75, 6.35, -2.4], [8.3, 6.35, -4.15], [-0.8, 6.35, -4.15], [-1.9, 6.35, -3.2], [-1.9, 6.35, 3.2]]);
  for (const [x, z, yaw] of [[9.82, -2, Math.PI / 2], [4, 4.22, 0], [0.5, -4.22, 0]]) {
    const buoy = mesh(new THREE.TorusGeometry(0.42, 0.13, 8, 18), mat(0xff5a14, { roughness: 0.5 }));
    buoy.position.set(x, 6.95, z);
    buoy.rotation.y = yaw;
    low.add(buoy);
  }
  // Liferaft canister in its cradle to port, and the stair up beside it.
  const raft = mesh(new THREE.CapsuleGeometry(0.62, 1.1, 6, 14), white);
  raft.rotation.z = Math.PI / 2;
  raft.position.set(8, 7.25, -3.3);
  low.add(raft);
  for (const x of [7.4, 8.6]) low.add(box(0.2, 0.5, 1.3, iron, x, 6.5, -3.3));
  for (const z of [-4.25, -5.15]) {
    bar(low, [-0.4, 2.4, z], [3, 6.35, z], 0.1, iron);
    bar(low, [-0.4, 3.4, z], [3, 7.35, z], 0.05, white);
  }
  for (let i = 1; i < 10; i++) low.add(box(0.4, 0.08, 0.9, iron, -0.4 + i * 0.34, 2.4 + i * 0.395, -4.7));
  // Foredeck windlass and bollards.
  const windlass = cylinder(0.5, 0.5, 2.6, iron, 11.6, tugDeck(11.6) + 0.6, 0, 12);
  windlass.rotation.x = Math.PI / 2;
  low.add(windlass);
  for (const [x, z] of [[12.6, 1.8], [10.4, 3.9], [-6, 4.6], [-13.4, 2.6]]) {
    for (const side of [-1, 1]) low.add(cylinder(0.24, 0.28, 1.1, iron, x, tugDeck(x) + 0.55, side * z, 10));
  }
  // After deck: towing winch, hook post and the guard hoops over the tow rope.
  const winch = cylinder(1.25, 1.25, 3.6, iron, -5.2, 3.7, 0, 18);
  winch.rotation.x = Math.PI / 2;
  low.add(winch);
  for (const z of [-2, 2]) {
    const flange = cylinder(1.6, 1.6, 0.25, paint, -5.2, 3.7, z, 18);
    flange.rotation.x = Math.PI / 2;
    low.add(flange);
  }
  low.add(box(0.8, 2.2, 0.8, iron, -10.5, 3.3, 0));
  low.add(box(1.3, 0.5, 0.5, paint, -10.8, 4.35, 0));
  for (const x of [-8.2, -12.6]) {
    for (const z of [-3.4, 3.4]) bar(low, [x, 2.2, z], [x, 4.9, z], 0.16, iron);
    bar(low, [x, 4.9, -3.4], [x, 4.9, 3.4], 0.16, iron);
  }

  // The black knuckle-boom crane on the starboard side deck.
  crane.add(cylinder(0.42, 0.55, 3.2, iron, 7.2, 4.5, 4.9, 10));
  crane.add(box(1, 0.8, 0.9, iron, 7.2, 6.4, 4.9));
  bar(crane, [7.2, 6.5, 5], [7.5, 10.2, 3.8], 0.3, iron, 8);
  bar(crane, [7.5, 10.2, 3.8], [8.6, 10, 3.6], 0.2, iron, 8);
  bar(crane, [7.2, 5.4, 4.4], [7.35, 8.4, 4.4], 0.13, white, 8);
  bar(crane, [8.6, 10, 3.6], [8.6, 8.9, 3.6], 0.05, iron);
  for (const y of [4.9, 5.8]) crane.add(box(0.7, 0.55, 0.6, iron, 7.9, y, 4.9));

  // Exhaust stacks either side behind the wheelhouse, their tips horned outwards.
  [-1, 1].forEach((side, i) => {
    const into = stacks[i];
    const plan = (cx, z, a, b) => [[cx + a, side * z + b], [cx + a, side * z - b], [cx - a, side * z - b], [cx - a, side * z + b]];
    into.add(tugPrism(plan(0.6, 2.9, 1, 0.65), plan(0.6, 2.95, 0.85, 0.6), 6.3, 8.4, white));
    into.add(tugPrism(plan(0.6, 2.95, 0.85, 0.6), plan(0.5, 3.2, 0.7, 0.55), 8.4, 11.1, soot));
    into.add(tugPrism(plan(0.5, 3.2, 0.7, 0.55), plan(0.1, 4.2, 0.07, 0.05), 11.1, 13.4, soot));
    bar(into, [0.9, 10.8, side * 3], [0.7, 12.1, side * 2.9], 0.2, iron, 8);
  });

  // Wheelhouse: sill, tall windows leaning out to the top, then the glazed roof.
  const wh = [[7.9, 1.35], [7.9, -1.35], [6.8, -2.55], [4.2, -2.75], [2.4, -1.95], [2.4, 1.95], [4.2, 2.75], [6.8, 2.55]];
  const ring = (k) => grow(wh, k, 5);
  top.add(tugPrism(ring(0.96), ring(0.96), 6.3, 7.5, white));
  top.add(tugPrism(ring(0.95), ring(1.1), 7.5, 10, glass));
  const posts = (k0, y0, k1, y1, r, m) => {
    const a = ring(k0);
    const b = ring(k1);
    for (let i = 0; i < wh.length; i++) {
      const n = (i + 1) % wh.length;
      for (const t of i === 0 ? [0, 0.5] : i === 2 || i === 6 ? [0, 0.5] : [0]) {
        const point = (p, y) => v(p[i][0] + (p[n][0] - p[i][0]) * t, y, p[i][1] + (p[n][1] - p[i][1]) * t);
        top.add(strut(point(a, y0), point(b, y1), r, m, 5));
      }
    }
  };
  posts(0.955, 7.5, 1.105, 10, 0.09, white);
  top.add(tugPrism(ring(0.99), ring(0.99), 7.4, 7.62, white));
  top.add(tugPrism(ring(1.13), ring(1.13), 9.95, 10.2, white));
  top.add(tugPrism(ring(1.15), ring(1.12), 10.2, 10.55, paint));
  top.add(tugPrism(ring(1.07), ring(0.84), 10.55, 11.15, glass));
  posts(1.08, 10.55, 0.85, 11.15, 0.1, paint);
  top.add(tugPrism(ring(0.9), ring(0.82), 11.15, 11.45, paint));
  rail(top, ring(0.8).concat([ring(0.8)[0]]).map(([x, z]) => [x, 11.45, z]), 0.75);

  // The mast: a braced trunk with platforms, radar scanners, domes, lamps,
  // aerials and stays.
  bar(top, [4, 11.4, 0], [4, 19, 0], 0.3, white, 10);
  bar(top, [4, 19, 0], [4, 21.4, 0], 0.13, white, 8);
  bar(top, [4, 21.4, 0], [4, 22.2, 0], 0.22, iron, 8);
  for (const side of [-1, 1]) {
    bar(top, [4.4, 11.4, side * 1.7], [4.1, 16, side * 0.2], 0.12, white);
    bar(top, [2.6, 11.4, side * 0.9], [3.9, 15, 0], 0.12, white);
    bar(top, [4, 18.8, 0], [7, 11.5, side * 2.2], 0.025, iron, 4);
    bar(top, [4, 18.8, 0], [2.4, 11.5, side * 2.1], 0.025, iron, 4);
    bar(top, [6.6, 11.4, side * 2.3], [6.6, 15.6, side * 2.5], 0.035, white, 4);
    const dome = mesh(new THREE.SphereGeometry(0.46, 14, 10), white);
    dome.position.set(6, 12.8, side * 1.9);
    top.add(dome);
    bar(top, [6, 11.4, side * 1.9], [6, 12.5, side * 1.9], 0.1, white);
    top.add(box(0.5, 0.45, 0.45, white, 7.3, 11.9, side * 0.8));
  }
  for (const [y, w] of [[13.3, 2.2], [15.9, 2.8], [17.6, 2], [19.2, 1.5]]) {
    top.add(box(0.9, 0.16, w, white, 4.1, y, 0));
    for (const z of [-w / 2, w / 2]) {
      bar(top, [4.2, y, z], [4.2, y + 0.55, z], 0.05, white, 5);
      top.add(box(0.28, 0.34, 0.28, iron, 4.2, y + 0.7, z));
    }
    top.add(box(0.3, 0.36, 0.3, iron, 4.55, y - 0.4, 0));
  }
  for (const [x, y, w] of [[4.7, 14.7, 5.4], [4.8, 12.2, 3.4]]) {
    top.add(box(0.8, 0.35, 0.8, white, x - 0.2, y - 0.3, 0));
    top.add(box(0.4, 0.28, w, blue, x, y, 0));
  }
  bar(top, [4, 16.8, -2], [4, 16.8, 2], 0.06, white, 5);

  for (const group of [low, top, crane, ...stacks]) {
    mergeStaticMeshes(group, new Set());
    g.add(group);
  }
}

// ---- Wartime tanker -----------------------------------------------------------
// A 1943 tanker built on the Liberty hull and disguised as a cargo ship, from
// the player's photo (model units, x forward, +z starboard): a long grey hull
// streaked with rust, a raked stem and rounded counter stern, the bridge house
// and funnel midships, masts with cargo booms and their rigging, boats in
// davits, raft ramps, and gun tubs at the bow and stern.
const WAR = { aft: -28, bow: 28, half: 4.5, keel: -2.8 };
const WAR_HELM = [-0.2, 9.6, 0]; // the captain's eye inside the wheelhouse
// The wheelhouse room (model units): outside parts that reach into it are hidden while you are inside.
const WAR_ROOM = [[-2.5, 8.5, -2.25], [2.75, 10.78, 2.25]];
const warSheer = (x) => 4 + (x > 6 ? 1.5 * ((x - 6) / 22) ** 2 : x < -10 ? 0.8 * ((-10 - x) / 18) ** 2 : 0);

// A point on the hull's skin, `proud` units outside it.
function warSkin(x, y, side, proud = 0) {
  const f = clamp((x - 11) / (WAR.bow - 11), 0, 1);
  const s = clamp((-15 - x) / (-15 - WAR.aft), 0, 1);
  const bilge = 0.62 + 0.38 * Math.sin(clamp((y - WAR.keel) / 2.2, 0, 1) * (Math.PI / 2)) ** 0.6;
  const w = WAR.half * (1 - f ** 2) ** 0.65 * (1 - s ** 2.6) ** 0.5 * bilge;
  let px = x;
  if (x > 11) px = 11 + ((x - 11) * (WAR.bow - 1.7 * (1 - clamp((y + 0.5) / 6, 0, 1)) - 11)) / (WAR.bow - 11);
  if (x < -15) px = -15 + ((x + 15) * (WAR.aft + 3.2 * (1 - clamp((y - 0.2) / 3.2, 0, 1)) + 15)) / (WAR.aft + 15);
  const bowTurn = f ** 3;
  const aftTurn = s ** 3;
  return new THREE.Vector3(px + proud * (bowTurn - aftTurn), y, side * (w + proud * (1 - Math.max(bowTurn, aftTurn))));
}

let warTex = null;

function warTextures() {
  // Weathered grey paint (tinted by the hull colour): plate seams, rust weeps and patches.
  const paint = ibCanvas(1024, 512, (g, w, h) => {
    g.fillStyle = "#f4f4f4";
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) {
      const shade = Math.random() < 0.5 ? "255,255,255" : "70,76,84";
      g.fillStyle = `rgba(${shade},${0.04 + Math.random() * 0.08})`;
      g.fillRect(Math.random() * w, Math.random() * h, 20 + Math.random() * 90, 12 + Math.random() * 50);
    }
    for (let i = 0; i < 230; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      const len = 14 + Math.random() ** 2 * 150;
      const fall = g.createLinearGradient(0, y, 0, y + len);
      fall.addColorStop(0, `rgba(160,64,12,${0.4 + Math.random() * 0.5})`);
      fall.addColorStop(1, "rgba(160,64,12,0)");
      g.fillStyle = fall;
      g.fillRect(x, y, 2 + Math.random() ** 2 * 8, len);
      if (i % 4 === 0) {
        g.beginPath();
        g.ellipse(x + 2, y, 5 + Math.random() * 9, 2 + Math.random() * 3, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.fillStyle = "rgba(40,44,50,0.24)";
    for (let y = 0; y < h; y += 74) g.fillRect(0, y, w, 2);
    for (let row = 0; row < 7; row++) for (let x = (row % 2) * 90; x < w; x += 180) g.fillRect(x, row * 74, 2, 74);
    ibSpeckle(g, w, h, 6000, 0.05);
  });
  const name = ibCanvas(512, 64, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = "#f2f2ee";
    g.font = "bold 40px Arial, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("HARBOUR VALOUR", w / 2, h / 2, w - 12);
  });
  // The 48-star flag of the time.
  const flag = ibCanvas(260, 150, (g, w, h) => {
    for (let i = 0; i < 13; i++) {
      g.fillStyle = i % 2 ? "#f4f2ec" : "#a61f2b";
      g.fillRect(0, (i * h) / 13, w, h / 13 + 1);
    }
    g.fillStyle = "#1f2f5c";
    g.fillRect(0, 0, w * 0.4, (h * 7) / 13);
    g.fillStyle = "#f4f2ec";
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 8; col++) {
        g.beginPath();
        g.arc(((col + 0.5) * w * 0.4) / 8, ((row + 0.5) * h * 7) / 13 / 6, 3, 0, Math.PI * 2);
        g.fill();
      }
    }
  });
  return { paint, name, flag };
}

function wartimeTanker(g, color) {
  if (!warTex) warTex = warTextures();
  const fine = bridgeHigh();
  const hull = mat(color, { map: warTex.paint, roughness: 0.62, metalness: 0.28, side: THREE.DoubleSide });
  const boot = mat(0x4a1c17, { map: warTex.paint, roughness: 0.75, side: THREE.DoubleSide });
  const house = mat(0xb4b9bd, { map: warTex.paint, roughness: 0.6, metalness: 0.15 });
  const deckPaint = mat(0x565b5e, { map: warTex.paint, roughness: 0.9, side: THREE.DoubleSide });
  const gunGrey = mat(0x646a70, { roughness: 0.45, metalness: 0.55 });
  const roofPaint = mat(0x565b5e, { roughness: 0.9 });
  const tubPaint = mat(0x9aa0a5, { map: warTex.paint, roughness: 0.65, side: THREE.DoubleSide });
  const iron = mat(0x24272a, { roughness: 0.55, metalness: 0.5 });
  const white = mat(0xc9ccca, { roughness: 0.6 });
  const canvasCloth = mat(0xa9a48f, { roughness: 0.95 });
  const boatPaint = mat(0x8f969b, { map: warTex.paint, roughness: 0.6, side: THREE.DoubleSide });
  const brass = mat(0xb58a3c, { roughness: 0.35, metalness: 0.8 });
  const red = mat(0x9c2a20, { roughness: 0.6 });
  const orange = mat(0xd8561f, { roughness: 0.6 });
  const navy = mat(0x25324a, { roughness: 0.85 });
  const skin = mat(0xb98a68, { roughness: 0.8 });
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const low = new THREE.Group();
  const top = new THREE.Group();
  const bar = (into, a, b, r, m, seg = 6) => into.add(strut(v(...a), v(...b), r, m, seg));
  const wire = (a, b) => bar(top, a, b, 0.028, iron, 4);
  const put = (into, geo, m, x, y, z) => {
    const part = mesh(geo, m);
    part.position.set(x, y, z);
    into.add(part);
    return part;
  };
  const block = (into, x0, x1, halfZ, y0, y1, m) => {
    const plan = [[x1, halfZ], [x1, -halfZ], [x0, -halfZ], [x0, halfZ]];
    into.add(tugPrism(plan, plan, y0, y1, m));
  };
  // x positions bunched towards both ends, where the hull curves most
  const along = (s) => WAR.aft + (WAR.bow - WAR.aft) * (0.5 - 0.5 * Math.cos(Math.PI * s));

  // Hull: red-brown below the boot topping, weathered grey above, then the keel plating and deck.
  for (const side of [-1, 1]) {
    for (const [from, to, m, rows] of [[() => WAR.keel, () => 0.35, boot, 6], [() => 0.35, warSheer, hull, 8]]) {
      low.add(tugSurface(64, rows, (s, t) => {
        const x = along(s);
        const y = from(x) + (to(x) - from(x)) * t;
        return [warSkin(x, y, side), x / 18, y / 8];
      }, m));
    }
    const cap = [];
    for (let i = 0; i <= 56; i++) cap.push(warSkin(along(i / 56), warSheer(along(i / 56)), side));
    put(low, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(cap), 112, 0.09, 6), hull, 0, 0, 0);
    // the rubbing strake, the row of scuppers below the deck edge, and an anchor at the bow
    for (let i = 0; i < 40; i++) {
      const a = warSkin(-25 + i * 1.28, warSheer(-25 + i * 1.28) - 1.15, side, 0.03);
      const b = warSkin(-25 + (i + 1) * 1.28, warSheer(-25 + (i + 1) * 1.28) - 1.15, side, 0.03);
      low.add(strut(a, b, 0.045, hull, 5));
    }
    for (let i = 0; i < 26; i++) {
      if (i % 5 === 3) continue;
      const x = -22 + i * 1.55;
      const p = warSkin(x, warSheer(x) - 0.5, side, 0.03);
      const q = warSkin(x + 0.3, warSheer(x) - 0.5, side, 0.03);
      put(low, new THREE.BoxGeometry(0.5, 0.2, 0.08), iron, p.x, p.y, p.z).rotation.y = Math.atan2(p.z - q.z, q.x - p.x);
    }
    const foot = warSkin(24.9, 2.5, side, 0.22);
    low.add(strut(warSkin(25.2, 3.9, side, 0.18), foot, 0.1, iron));
    for (const x of [24.2, 25.6]) low.add(strut(warSkin(x, 2.9, side, 0.2), foot, 0.11, iron));
    const hawse = warSkin(25.3, 4.15, side, 0.14);
    put(low, new THREE.TorusGeometry(0.28, 0.07, 8, 16), iron, hawse.x, hawse.y, hawse.z);
    // draught marks down the stem
    for (let y = 0.5; y < 3; y += 0.45) {
      const p = warSkin(26.7, y, side, 0.04);
      put(low, new THREE.BoxGeometry(0.14, 0.2, 0.07), white, p.x, p.y, p.z);
    }
    // her name on the bow, following the curve of the plating
    const label = mat(0xffffff, { map: warTex.name, transparent: true, depthWrite: false, roughness: 0.7, side: THREE.DoubleSide });
    const plate = tugSurface(16, 2, (s, t) => {
      const x = 17.6 + 6.4 * s;
      const y = warSheer(x) - 2.05 + 0.8 * t;
      return [warSkin(x, y, side, 0.06), side < 0 ? 1 - s : s, t];
    }, label);
    plate.castShadow = false; // lettering only: it must not shade the plating behind it
    low.add(plate);
  }
  low.add(tugSurface(64, 4, (s, t) => {
    const x = along(s);
    const p = warSkin(x, WAR.keel, 1);
    p.z *= t * 2 - 1;
    return [p, x / 18, p.z / 8];
  }, boot));
  low.add(tugSurface(64, 4, (s, t) => {
    const x = along(s);
    const p = warSkin(x, warSheer(x) - 0.04, 1);
    p.z *= t * 2 - 1;
    return [p, x / 18, p.z / 8];
  }, deckPaint));
  // Rudder and propeller under the counter.
  put(low, new THREE.BoxGeometry(1.3, 2.4, 0.22), boot, -25.4, -1.5, 0);
  for (let i = 0; i < 4; i++) {
    const blade = put(low, new THREE.BoxGeometry(0.16, 1.1, 0.42).translate(0, 0.55, 0), gunGrey, -23.9, -1.7, 0);
    blade.rotation.x = (i * Math.PI) / 2;
  }

  // Guard rails: posts with a top and a middle bar.
  const rail = (into, points, h = 0.55) => {
    for (let i = 0; i < points.length - 1; i++) {
      const a = v(...points[i]);
      const b = v(...points[i + 1]);
      for (const k of [h, h * 0.5]) into.add(strut(a.clone().setY(a.y + k), b.clone().setY(b.y + k), 0.027, house, 4));
      const posts = Math.max(1, Math.round(a.distanceTo(b) / (fine ? 0.8 : 1.6)));
      for (let n = 0; n <= posts; n++) {
        const p = a.clone().lerp(b, n / posts);
        into.add(strut(p, p.clone().setY(p.y + h), 0.03, house, 4));
      }
    }
  };
  for (const side of [-1, 1]) {
    const points = [];
    for (let i = 0; i <= 28; i++) {
      const x = -27.4 + (i * 54.6) / 28;
      const p = warSkin(x, warSheer(x), side, -0.1);
      points.push([p.x, p.y, p.z]);
    }
    rail(low, points);
  }

  // Seamen in steel helmets.
  const sailor = (into, x, y, z) => {
    put(into, new THREE.CylinderGeometry(0.14, 0.18, 0.7, 8), navy, x, y + 0.35, z);
    put(into, new THREE.SphereGeometry(0.13, 8, 6), skin, x, y + 0.84, z);
    put(into, new THREE.SphereGeometry(0.17, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), gunGrey, x, y + 0.87, z);
  };
  // A gun on its pedestal inside a splinter tub; `dir` +1 points forward, -1 aft.
  const gunTub = (into, x, y, z, radius, dir, barrel) => {
    put(into, new THREE.CylinderGeometry(radius, radius * 0.94, 0.75, 24, 1, true), tubPaint, x, y + 0.45, z);
    put(into, new THREE.CylinderGeometry(radius, radius, 0.14, 24), deckPaint, x, y, z);
    put(into, new THREE.TorusGeometry(radius, 0.06, 6, 28).rotateX(Math.PI / 2), house, x, y + 0.82, z);
    const k = barrel / 3.4;
    into.add(cylinder(0.28 * k, 0.4 * k, 0.7, gunGrey, x, y + 0.42, z, 12));
    into.add(box(0.9 * k, 0.45 * k, 0.5 * k, gunGrey, x, y + 0.95, z));
    into.add(box(0.12, 0.8 * k, 1.15 * k, gunGrey, x + dir * 0.5 * k, y + 1.08, z));
    const at = (share) => [x + dir * barrel * share, y + 1 + barrel * 0.14 * share, z];
    bar(into, at(0), at(1), 0.13 * k, iron, 10);
    bar(into, at(0.8), at(1), 0.17 * k, iron, 10);
    sailor(into, x - dir * 0.45 * radius, y + 0.07, z + 0.45 * radius);
    sailor(into, x - dir * 0.15 * radius, y + 0.07, z - 0.55 * radius);
  };

  // Bow gun, raised on the forecastle.
  low.add(cylinder(0.55, 0.7, 1, house, 24.2, warSheer(24.2) + 0.45, 0, 14));
  gunTub(low, 24.2, warSheer(24.2) + 1, 0, 1.55, 1, 2.8);
  // Stern gun on top of the after deckhouse, trained astern.
  block(low, -25.6, -21.8, 2.1, warSheer(-24) - 0.1, 6.3, house);
  block(low, -26, -21.4, 2.35, 6.3, 6.45, roofPaint);
  gunTub(low, -24.4, 6.55, 0, 1.55, -1, 3.4);
  for (const side of [-1, 1]) {
    for (const x of [-24.6, -23]) low.add(box(0.55, 0.9, 0.08, iron, x, 5.3, side * 2.12));
    rail(low, [[-21.4, 6.45, side * 2.3], [-22.7, 6.45, side * 2.3]]);
    // the after anti-aircraft pair
    low.add(cylinder(0.2, 0.28, 0.6, house, -19.8, warSheer(-19.8) + 0.3, side * 2.8, 10));
    gunTub(low, -19.8, warSheer(-19.8) + 0.6, side * 2.8, 0.75, -1, 1.3);
  }

  // The bridge house midships: two decks and the enclosed wheelhouse under its roof.
  block(low, -13, 3.8, 3.5, 3.95, 6.2, house);
  block(low, -13.5, 4.2, 4.1, 6.2, 6.38, roofPaint);
  block(top, -9.5, 3, 2.8, 6.38, 8.2, house);
  block(top, -3.8, 3.5, 3.9, 8.2, 8.36, roofPaint);
  block(top, -2.6, 2.55, 2.05, 8.36, 10.8, house);
  block(top, -3, 3.3, 2.65, 10.8, 10.9, roofPaint);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 11; i++) {
      put(low, new THREE.CylinderGeometry(0.2, 0.2, 0.08, 12).rotateX(Math.PI / 2), iron, -12 + i * 1.5, 5.3, side * 3.52);
    }
    for (const x of [-7.8, -3.6, 1.4]) low.add(box(0.7, 1.35, 0.08, iron, x, 4.75, side * 3.54));
    for (let i = 0; i < 9; i++) top.add(box(0.5, 0.55, 0.08, iron, -8.6 + i * 1.35, 7.45, side * 2.82));
    for (let x = -1.9; x <= 2.1; x += 1) top.add(box(0.68, 0.7, 0.08, iron, x, 9.7, side * 2.07));
    for (const x of [-12.8, -9, -5, -1, 3.6]) bar(low, [x, warSheer(x), side * 3.95], [x, 6.2, side * 3.95], 0.07, house);
    rail(low, [[4.15, 6.38, side * 4.02], [-13.4, 6.38, side * 4.02]]);
    rail(top, [[3, 8.36, side * 3.82], [-3.7, 8.36, side * 3.82]]);
    // ladders between the decks
    for (const [x0, y0, x1, y1, z] of [[6, warSheer(6), 3.9, 6.38, 3], [-5, 6.38, -3.4, 8.36, 3.4]]) {
      for (const dz of [-0.3, 0.3]) bar(top, [x0, y0, side * (z + dz)], [x1, y1, side * (z + dz)], 0.06, house);
      for (let i = 1; i < 7; i++) top.add(box(0.24, 0.05, 0.6, iron, x0 + ((x1 - x0) * i) / 7, y0 + ((y1 - y0) * i) / 7, side * z));
    }
    gunTub(top, 2.3, 8.45, side * 3.35, 0.68, 1, 1.25); // bridge-wing guns
    put(top, new THREE.TorusGeometry(0.32, 0.1, 8, 18), orange, -7, 7.15, side * 2.9);
  }
  for (const z of [-1.4, -0.7, 0, 0.7, 1.4]) top.add(box(0.08, 0.7, 0.54, iron, 2.57, 9.7, z));
  for (const z of [-1.6, 0, 1.6]) top.add(box(0.08, 0.55, 0.6, iron, 3.02, 7.45, z));
  rail(top, [[-3, 10.9, 2.6], [3.25, 10.9, 2.6], [3.25, 10.9, -2.6], [-3, 10.9, -2.6], [-3, 10.9, 2.6]]);
  rail(low, [[-13.4, 6.38, -4], [-13.4, 6.38, 4]]);

  // The funnel with its black cap, steam pipe, whistle and stays.
  top.add(cylinder(1.3, 1.4, 5, house, -5.6, 10.6, 0, 24));
  top.add(cylinder(1.38, 1.36, 0.7, iron, -5.6, 13.25, 0, 24));
  top.add(cylinder(1.42, 1.42, 0.16, house, -5.6, 12.85, 0, 24));
  bar(top, [-4.1, 8.2, 0.5], [-4.1, 13.2, 0.5], 0.13, gunGrey);
  top.add(cylinder(0.2, 0.12, 0.4, brass, -4.1, 13.4, 0.5, 10));
  for (const side of [-1, 1]) for (const x of [-8.8, -2.9]) wire([-5.6, 12.6, side * 1.2], [x, 8.3, side * 2.8]);

  // Lifeboats in their davits, two a side, under canvas covers.
  for (const side of [-1, 1]) {
    for (const x of [-7.9, -11.4]) {
      put(low, new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), boatPaint, x, 7.55, side * 3.5).scale.set(1.55, 0.7, 0.62);
      put(low, new THREE.SphereGeometry(1, 20, 6, 0, Math.PI * 2, 0, Math.PI / 2), canvasCloth, x, 7.55, side * 3.5).scale.set(1.55, 0.3, 0.62);
      for (const dx of [-1.3, 1.3]) {
        const curve = new THREE.CatmullRomCurve3([v(x + dx, 6.38, side * 2.95), v(x + dx, 7.9, side * 2.95), v(x + dx, 8.55, side * 3.2), v(x + dx, 8.5, side * 3.55)]);
        put(low, new THREE.TubeGeometry(curve, 16, 0.09, 6), house, 0, 0, 0);
        bar(low, [x + dx, 8.5, side * 3.52], [x + dx, 7.7, side * 3.5], 0.03, iron, 4);
      }
    }
    for (const [x, z] of [[-12.6, 2.4], [-9.7, 2.2], [-6.2, 3.4]]) sailor(low, x, 6.38, side * z);
  }

  // The slanted life-raft ramps along the sides.
  for (const [x, y, lean] of [[9.2, 5.7, 1], [0.2, 7.4, -1], [-17.6, 5.9, 1]]) {
    for (const side of [-1, 1]) {
      const ramp = new THREE.Group();
      ramp.position.set(x, y, side * 3.75);
      ramp.rotation.z = lean * 0.98;
      ramp.add(box(3, 0.14, 1.1, house, 0, 0, 0));
      for (let i = 0; i < 6; i++) ramp.add(box(0.3, 0.16, 0.9, iron, -1.2 + i * 0.48, 0.08, 0));
      low.add(ramp);
      for (const dx of [-0.7, 0.6]) bar(low, [x + dx * 0.4, y - 1.8, side * 3.5], [x + dx * 0.56, y + dx * lean * 0.83, side * 3.7], 0.07, house);
    }
  }

  // Cargo pipelines, the tank hatches and the hose manifold midships with its valves.
  for (const z of [-1.1, 0, 1.1]) {
    for (const [from, to] of [[4.2, 21.2], [-20.6, -13.2]]) {
      const run = [];
      for (let i = 0; i <= 6; i++) {
        const x = from + ((to - from) * i) / 6;
        run.push(v(x, warSheer(x) + 0.28, z));
      }
      put(low, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(run), 24, 0.17, 8), gunGrey, 0, 0, 0);
    }
  }
  for (const x of [8, 12, 17, -17]) {
    for (const side of [-1, 1]) {
      low.add(cylinder(0.65, 0.65, 0.35, house, x, warSheer(x) + 0.17, side * 2, 16));
      low.add(cylinder(0.4, 0.4, 0.14, iron, x, warSheer(x) + 0.4, side * 2, 12));
    }
  }
  const manifoldY = warSheer(10.2) + 0.7;
  bar(low, [10.2, manifoldY, -4.35], [10.2, manifoldY, 4.35], 0.24, gunGrey, 10);
  for (const z of [-3.4, -1.1, 1.1, 3.4]) {
    bar(low, [10.2, manifoldY - 0.7, z], [10.2, manifoldY + 0.55, z], 0.08, iron);
    put(low, new THREE.TorusGeometry(0.28, 0.06, 6, 14).rotateX(Math.PI / 2), red, 10.2, manifoldY + 0.55, z);
  }

  // Mushroom ventilator cowls, their mouths facing forward.
  for (const [x, y, z] of [[20.4, warSheer(20.4), 2.2], [15.6, warSheer(15.6), -2.4], [5.4, warSheer(5.4), 2.7], [-1.2, 8.36, -3.3], [-9, 8.2, 1.7], [-14.4, warSheer(-14.4), -2.4], [-14.4, warSheer(-14.4), 2.4]]) {
    low.add(cylinder(0.24, 0.28, 1.2, house, x, y + 0.6, z, 12));
    put(low, new THREE.SphereGeometry(0.42, 16, 12), white, x + 0.06, y + 1.38, z).scale.set(0.8, 1, 1);
    put(low, new THREE.CircleGeometry(0.26, 16).rotateY(Math.PI / 2), iron, x + 0.41, y + 1.38, z);
  }

  // Masts, cargo booms, winches and rigging.
  const mast = (x, height, posts) => {
    const base = warSheer(x);
    const head = base + height;
    for (const z of posts) {
      top.add(cylinder(0.17, 0.3, height * 0.78, house, x, base + height * 0.39, z, 10));
      top.add(box(0.5, 0.3, 0.5, gunGrey, x, base + height * 0.78, z));
    }
    const span = Math.max(...posts.map(Math.abs)) * 2 + 1.1;
    top.add(box(0.35, 0.22, span, house, x, base + height * 0.72, 0));
    top.add(box(1, 0.14, 1.1, house, x, base + height * 0.74, 0));
    bar(top, [x - 0.15, base + height * 0.7, 0], [x - 0.15, head, 0], 0.12, house, 8);
    top.add(box(0.12, 0.1, 1, house, x - 0.15, head - 0.5, 0));
    top.add(box(0.3, 0.3, 0.3, iron, x - 0.15, head, 0));
    for (const side of [-1, 1]) {
      for (const dx of [-1.6, 0, 1.6]) {
        const foot = warSkin(x + dx, warSheer(x + dx) + 0.5, side, -0.15);
        wire([x, base + height * 0.74, side * 0.35], [foot.x, foot.y, foot.z]);
      }
      const drum = cylinder(0.36, 0.36, 1.1, iron, x + side * 1.15, base + 0.55, side * 1.9, 12);
      drum.rotation.x = Math.PI / 2;
      low.add(drum);
      low.add(box(0.9, 0.35, 1.4, gunGrey, x + side * 1.15, base + 0.18, side * 1.9));
    }
    return [x - 0.15, head - 0.2, 0];
  };
  const fore = mast(13.8, 11, [-0.95, 0.95]);
  const middle = mast(6.2, 12, [0]);
  const aft = mast(-16, 10.2, [-0.95, 0.95]);
  const boom = (from, to, peak) => {
    bar(top, from, to, 0.19, house, 8);
    top.add(box(0.28, 0.28, 0.28, iron, ...to));
    wire(to, peak);
    wire(to, [to[0], to[1] - 2.4, to[2]]);
    top.add(box(0.2, 0.34, 0.2, iron, to[0], to[1] - 2.5, to[2]));
  };
  boom([14.2, warSheer(14) + 1.1, 0.9], [23.4, 11.6, 1.3], fore);
  boom([13.4, warSheer(13.4) + 1.1, -0.9], [7.6, 12.2, -1.5], fore);
  boom([6.8, warSheer(6.8) + 1.4, 0.4], [11.6, 10.8, 2], middle);
  boom([-15.6, warSheer(-15.6) + 1.1, 0.9], [-11.4, 11, 2.4], aft);
  boom([-16.4, warSheer(-16.4) + 1.1, -0.9], [-23.6, 12, -1.2], aft);
  // stays from stem to stern over the mast heads
  wire([27.6, warSheer(27.6) + 0.4, 0], fore);
  wire(fore, middle);
  wire(middle, [-5.6, 13.5, 0]);
  wire(middle, aft);
  wire(aft, [-27.2, warSheer(-27) + 0.4, 0]);
  wire([fore[0], fore[1] - 1.5, 0], [middle[0], middle[1] - 2.5, 0]);
  // forecastle windlass and bollards fore and aft
  const windlass = cylinder(0.4, 0.4, 1.9, iron, 21.8, warSheer(21.8) + 0.45, 0, 12);
  windlass.rotation.x = Math.PI / 2;
  low.add(windlass);
  for (const x of [20, 5, -19, -26.6]) {
    for (const side of [-1, 1]) {
      const p = warSkin(x, warSheer(x), side, -0.7);
      low.add(cylinder(0.17, 0.2, 0.6, iron, p.x, p.y + 0.3, p.z, 8));
    }
  }

  // The ensign at the stern.
  const staffY = warSheer(-26.8);
  bar(top, [-26.8, staffY, 0], [-27.1, staffY + 4, 0], 0.08, house);
  const cloth = new THREE.PlaneGeometry(2.6, 1.5, 12, 1);
  const points = cloth.attributes.position;
  for (let i = 0; i < points.count; i++) points.setZ(i, Math.sin((points.getX(i) + 1.3) * 2.6) * 0.14 * ((points.getX(i) + 1.3) / 2.6));
  cloth.computeVertexNormals();
  // turned about: hoist at the staff, flying aft
  put(top, cloth, mat(0xffffff, { map: warTex.flag, roughness: 0.9, side: THREE.DoubleSide }), -28.4, staffY + 3.15, 0).rotation.y = Math.PI;

  // Merged by where each part lies about the wheelhouse, so that from inside only
  // what reaches into the room is hidden: the masts and decks stay in sight.
  const room = new THREE.Box3(v(...WAR_ROOM[0]), v(...WAR_ROOM[1]));
  const places = new Map();
  const bounds = new THREE.Box3();
  for (const group of [low, top]) group.updateMatrixWorld(true);
  const parts = [];
  for (const group of [low, top]) group.traverse((o) => o.isMesh && parts.push(o));
  for (const part of parts) {
    bounds.setFromObject(part);
    const place = bounds.intersectsBox(room) ? "inside" : bounds.max.y < room.min.y ? "below" : bounds.min.x > room.max.x ? "fore"
      : bounds.max.x < room.min.x ? "aft" : bounds.min.y > room.max.y ? "above" : bounds.max.z < room.min.z ? "port" : "starboard";
    if (!places.has(place)) places.set(place, new THREE.Group());
    places.get(place).attach(part);
  }
  for (const group of places.values()) {
    mergeStaticMeshes(group, new Set());
    g.add(group);
  }
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
  let station = null; // the sailing boat's open helm, part of the model

  let oars = null;
  if (category === "Galley") {
    oars = hospitallerGalley(g);
    // The open helm on the after deck.
    station = bridgeInterior("Galley");
    station.group.position.set(GALLEY_HELM[0], GALLEY_HELM[1], 0);
    station.group.scale.setScalar(1 / shipScale("Galley"));
    for (const m of [station.mats.wood, station.mats.planks]) m.emissiveIntensity = 0.06;
    wheel = station.helm;
    g.add(station.group);
  } else if (category === "Carrack") {
    candle = hospitallerCarrack(g, color);
    // The open helm on the quarterdeck: whipstaff, binnacle, rails and fittings.
    station = bridgeInterior("Carrack");
    station.group.position.set(CARRACK_HELM[0], CARRACK_HELM[1], 0);
    station.group.scale.setScalar(1 / shipScale("Carrack"));
    for (const m of [station.mats.wood, station.mats.planks]) m.emissiveIntensity = 0.06; // out in the open
    wheel = station.helm;
    g.add(station.group);
  } else if (category === "WarTanker") {
    wartimeTanker(g, color);
  } else if (category === "Cruise") {
    if (cruiseModel && !ship.plain) {
      // measured and tested against the stand-in; useCruiseModel dresses it
      g.add(mesh(cruiseModel.standIn[0], hull), mesh(cruiseModel.standIn[1], white));
    } else cruiseLiner(g, hull, white, glass, steel);
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
    // One cockpit (planked deck, wheel, binnacle, rails) at the stern, the same
    // one whether you look from above, from behind or stand at the helm.
    g.add(mesh(hullGeometry(34, 10, 7), hull));
    station = bridgeInterior("Sailing");
    station.group.position.set(SAIL_HELM_X, SAIL_EYE_Y, 0);
    station.group.scale.setScalar(1 / shipScale("Sailing"));
    // out in the open: lit by the sky, without the indoor self-glow
    for (const m of [station.mats.wood, station.mats.planks]) m.emissiveIntensity = 0.06;
    wheel = station.helm;
    g.add(station.group);
    g.add(box(28, 0.8, 7.5, station.mats.planks, -3, SAIL_DECK_TOP - 0.4, 0)); // above the hull's top, so it shows
    g.add(cylinder(0.45, 0.6, 38, steel, 3, 22, 0, 8));
    // the mainsail on its boom, high enough to clear the helmsman's head
    g.add(triSail([[2.4, 11], [2.4, 40], [-13, 11.4]], sailCloth));
    const boom = cylinder(0.22, 0.22, 15.8, steel, -5.4, 10.9, 0, 6);
    boom.rotation.z = Math.PI / 2;
    g.add(boom);
    g.add(triSail([[3.6, 9], [3.6, 38], [16, 5]], sailCloth));
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
    harbourTug(g, color);
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
    // A painted band all round the hull, just proud of its sides, so its colour still reads at a
    // glance, and a planked deck following the hull's shape, just above the hull's top (5.7).
    const band = mesh(hullGeometry(40.3, 13.3, 1.2), hull);
    band.position.y = 3.2;
    g.add(band);
    const planks = bridgeTextures().planks.clone();
    planks.repeat.set(1 / 8, 1 / 8); // the deck's texture runs in model units: one tile of planks per 8
    planks.needsUpdate = true;
    const deck = mesh(hullGeometry(38, 11.4, 0.2), mat(0xffffff, { map: planks, roughness: 0.85 }));
    deck.position.y = 4.5;
    g.add(deck);
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
    // (rope materials are shared by every ship, so one ship's fire must not tint them)
    if (!o.userData.rigging && o.material?.emissive && !mats.includes(o.material)) {
      o.material.userData.baseEmissive = o.material.emissive.clone();
      o.material.userData.baseColor = o.material.color.clone();
      mats.push(o.material);
    }
  });
  return { model: g, mats, candle, wheel, airWing, station, oars };
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
  Pirate: [42, 50], // ~45 m galleon, drawn larger than life like the carrack: well above the tug
  Carrack: [40, 42], // ~50 m great carrack, drawn larger than life like the yacht
  Galley: [49, 52], // ~45 m galley and her spur
  Futuristic: [42, 58],
  Assault: [44, 68], // ~155 m destroyer
  Cargo: [52, 76], // ~180 m feeder container ship
  Cruise: [CRUISE.len, CRUISE.len], // ~300 m liner, built at real size
  Carrier: [50, 109], // 333 m supercarrier (flight deck length), real size
  Tug: [31.5, 34], // ~30 m harbour tug
  Icebreaker: [40, 62], // ~120 m polar icebreaker
  Tanker: [52, 84], // ~250 m oil tanker
  GasTanker: [52, 86], // ~290 m gas carrier
  WarTanker: [56, 64] // ~135 m wartime tanker
};
function shipScale(kind) {
  const [hullLen, drawnLen] = SHIP_SIZE[kind] || SHIP_SIZE.Cruise;
  return drawnLen / hullLen;
}

// The sailing boat's helm (model units): her deck's top, where the cockpit stands, and the
// height of the helmsman's eye above it (the cockpit floor is 1.74 room units below the eye).
const SAIL_DECK_TOP = 4.95;
const SAIL_HELM_X = -11.5;
const SAIL_EYE_Y = 6.88;


// ---------------------------------------------------------------------------
// Bridge interior: what you see from the captain's eye (BRIDGE_EYE) when you are on the
// bridge: a shaped console with radar / chart / engine screens and labelled control panels, a
// joystick and throttle levers (modern ships steer by joystick, not wheel), framed windows,
// chairs, a chart table, an overhead panel, carpet and ceiling tiles. Only the sailing boat has
// a wheel; the galleon has a whipstaff. The view starts inside (see bridgeBlend) and glides out to the
// plain window view when the player presses the navigation-screen button.
// Built in world units around the eye and shown only to the player on that bridge.
// ---------------------------------------------------------------------------
const OPEN_HELM = new Set(["Sailing", "Pirate", "Carrack", "Galley"]);
const INTERIOR_SIZE = { Sailing: 0.8, Pirate: 0.9, Carrack: 0.9, Galley: 0.65, WarTanker: 0.8, Catamaran: 0.75, Hydrofoil: 0.8, Futuristic: 0.8, Tug: 0.8 };

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

// Parts of the bridge screens and dials: title bars, a column of readings, a round instrument.
function ibScreenBase(g, w, h, back, title, foot) {
  g.fillStyle = back;
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#0c2230";
  g.fillRect(0, 0, w, 36);
  g.fillRect(0, h - 34, w, 34);
  g.fillStyle = "#d6f1ff";
  g.font = "bold 20px monospace";
  g.fillText(title, 12, 25);
  g.font = "bold 16px monospace";
  g.fillText(foot, 12, h - 11);
}

function ibReadouts(g, x, rows) {
  rows.forEach(([name, value], i) => {
    const y = 44 + i * 58;
    g.fillStyle = "rgba(120,200,255,0.12)";
    g.fillRect(x, y, 112, 50);
    g.fillStyle = "#8fd3e8";
    g.font = "12px monospace";
    g.fillText(name, x + 8, y + 15);
    g.fillStyle = "#f1fcff";
    g.font = "bold 24px monospace";
    g.fillText(value, x + 8, y + 41);
  });
}

// `value` 0..1 places the needle over a 270 degree scale; null leaves a full compass scale without one.
function ibDial(g, x, y, r, name, value) {
  g.fillStyle = "#0a0f13";
  g.beginPath();
  g.arc(x, y, r, 0, 6.29);
  g.fill();
  g.strokeStyle = "#dfe8ee";
  const sweep = value === null ? Math.PI * 2 : Math.PI * 1.5;
  for (let i = 0; i <= 36; i++) {
    const a = -sweep / 2 + (sweep * i) / 36;
    const len = i % 3 === 0 ? 0.18 : 0.09;
    g.lineWidth = i % 3 === 0 ? r / 30 : r / 60;
    g.beginPath();
    g.moveTo(x + Math.sin(a) * r * 0.94, y - Math.cos(a) * r * 0.94);
    g.lineTo(x + Math.sin(a) * r * (0.94 - len), y - Math.cos(a) * r * (0.94 - len));
    g.stroke();
  }
  g.fillStyle = "#dfe8ee";
  g.textAlign = "center";
  g.font = `bold ${Math.round(r * 0.19)}px monospace`;
  g.fillText(name, x, value === null ? y - r * 0.5 : y + r * 0.62);
  g.textAlign = "left";
  if (value === null) return;
  const a = -sweep / 2 + sweep * value;
  g.strokeStyle = "#ff7a2a";
  g.lineWidth = r / 14;
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + Math.sin(a) * r * 0.75, y - Math.cos(a) * r * 0.75);
  g.stroke();
  g.fillStyle = "#c7d0d6";
  g.beginPath();
  g.arc(x, y, r * 0.1, 0, 6.29);
  g.fill();
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
    paint: ibCanvas(128, 128, (g, w, h) => {
      g.fillStyle = "#8b949b";
      g.fillRect(0, 0, w, h);
      ibSpeckle(g, w, h, 1400, 0.07);
    }, 2, 2),
    planks: ibCanvas(256, 256, (g, w, h) => {
      for (let i = 0; i < 12; i++) {
        const y = (i * h) / 12;
        g.fillStyle = ["#a57c4f", "#966e44", "#ad8558"][(i * 5) % 3];
        g.fillRect(0, y, w, h / 12);
        for (let n = 0; n < 14; n++) {
          g.fillStyle = `rgba(50,28,10,${0.08 + Math.random() * 0.14})`;
          g.fillRect(Math.random() * w, y + Math.random() * (h / 12), 30 + Math.random() * 90, 1);
        }
        g.fillStyle = "#2c1d10";
        g.fillRect(0, y, w, 2);
        const joint = (i * 97) % w;
        g.fillRect(joint, y, 2, h / 12);
        for (const dx of [-8, 8]) g.fillRect(joint + dx, y + h / 24, 3, 3);
      }
    }),
    gauges: ibCanvas(512, 372, (g, w, h) => {
      ibScreenBase(g, w, h, "#07141c", "MACHINERY", "ME PORT / STBD");
      ibDial(g, 90, 120, 68, "RPM P", 0.62);
      ibDial(g, 256, 120, 68, "RPM S", 0.6);
      ibDial(g, 422, 120, 68, "LOAD %", 0.47);
      ["FUEL", "LUBE", "COOL", "EXH", "BAT", "AIR", "BALL", "FW"].forEach((name, i) => {
        const x = 24 + i * 60;
        const v = [0.72, 0.55, 0.43, 0.66, 0.88, 0.7, 0.34, 0.6][i];
        g.fillStyle = "rgba(255,255,255,0.12)";
        g.fillRect(x, 205, 34, 105);
        g.fillStyle = v < 0.4 ? "#ffb02a" : "#3be0c8";
        g.fillRect(x, 310 - v * 105, 34, v * 105);
        g.fillStyle = "#cfe";
        g.font = "bold 12px monospace";
        g.fillText(name, x, 327);
      });
    }),
    alarms: ibCanvas(512, 372, (g, w, h) => {
      ibScreenBase(g, w, h, "#10161b", "ALARM AND MONITORING", "NO ACTIVE ALARMS");
      g.font = "bold 14px monospace";
      ["Bilge level", "Fire zones 1-6", "Watertight doors", "Steering pump 1", "Steering pump 2", "Navigation lights", "Generator 1", "Generator 2", "GMDSS radio"].forEach((name, i) => {
        const y = 62 + i * 31;
        g.fillStyle = "rgba(255,255,255,0.06)";
        g.fillRect(16, y - 19, w - 32, 27);
        g.fillStyle = "#cfe0ea";
        g.fillText(name, 56, y);
        g.fillStyle = i === 7 ? "#ffb02a" : "#3be07a";
        g.beginPath();
        g.arc(34, y - 5, 7, 0, 6.29);
        g.fill();
        g.fillText(i === 7 ? "STANDBY" : "NORMAL", w - 110, y);
      });
    }),
    clockFace: ibCanvas(256, 256, (g) => {
      ibDial(g, 128, 128, 126, "UTC", null);
      g.strokeStyle = "#fff";
      g.lineCap = "round";
      for (const [a, len, wide] of [[-1.05, 62, 10], [0.95, 96, 6]]) {
        g.lineWidth = wide;
        g.beginPath();
        g.moveTo(128, 128);
        g.lineTo(128 + Math.sin(a) * len, 128 - Math.cos(a) * len);
        g.stroke();
      }
    }),
    rudderDial: ibCanvas(256, 256, (g) => ibDial(g, 128, 128, 126, "RUDDER", 0.5)),
    rpmDial: ibCanvas(256, 256, (g) => ibDial(g, 128, 128, 126, "RPM", 0.38)),
    tiltDial: ibCanvas(256, 256, (g) => ibDial(g, 128, 128, 126, "HEEL", 0.5)),
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

// ---------------------------------------------------------------------------
// The live navigation instruments on a bridge: the compasses, the conning
// display and the radar. Each bridge draws its own from its own ship.
// ---------------------------------------------------------------------------
const NAV_METRES_PER_UNIT = 3;
const NAV_NM = 1852 / NAV_METRES_PER_UNIT; // game units in a nautical mile
const RADAR_RANGE_NM = 1.5;
const RADAR_RANGE = RADAR_RANGE_NM * NAV_NM;
const RADAR_RING_NM = 0.25;
const RADAR_SWEEP = (Math.PI * 2) / 2.5; // rad/s: the antenna turns 24 times a minute
const RADAR_RAY = 0.016; // rad between the rays painted (about the beam width)
const RADAR_STEP = 6; // game units between samples along a ray
const RADAR_CX = 205; // the picture on the 512 x 372 screen
const RADAR_CY = 187;
const RADAR_R = 144;
const RADAR_CPA_LIMIT = 0.1 * NAV_NM; // a target passing closer than this...
const RADAR_TCPA_LIMIT = 30; // ...within this many seconds is a collision risk

// The harbour land never moves, so it is rasterised once for the radar rays.
const LAND_CELL = 4;
let landGrid = null;
function radarLandAt(x, y) {
  // (the rock cave over the waterfall stands above the water: it echoes like any hill)
  if (game.mission && (terrainDepth(x, y) < 0 || underCave(game.mission, x, y))) return true;
  if (!landGrid) {
    const cols = Math.ceil(WORLD_W / LAND_CELL);
    const rows = Math.ceil(WORLD_H / LAND_CELL);
    const cells = new Uint8Array(cols * rows);
    for (const p of HARBOUR_LAND) {
      const dx = p.bx - p.ax;
      const dy = p.by - p.ay;
      const r = Math.max(p.r, LAND_CELL * 0.75); // small boats still fill a cell
      const x0 = Math.max(0, Math.floor((Math.min(p.ax, p.bx) - r) / LAND_CELL));
      const x1 = Math.min(cols - 1, Math.ceil((Math.max(p.ax, p.bx) + r) / LAND_CELL));
      const y0 = Math.max(0, Math.floor((Math.min(p.ay, p.by) - r) / LAND_CELL));
      const y1 = Math.min(rows - 1, Math.ceil((Math.max(p.ay, p.by) + r) / LAND_CELL));
      for (let j = y0; j <= y1; j++) {
        for (let i = x0; i <= x1; i++) {
          const px = (i + 0.5) * LAND_CELL;
          const py = (j + 0.5) * LAND_CELL;
          const k = clamp(((px - p.ax) * dx + (py - p.ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
          if (Math.hypot(px - p.ax - dx * k, py - p.ay - dy * k) <= r) cells[j * cols + i] = 1;
        }
      }
    }
    landGrid = { cols, rows, cells };
  }
  const i = Math.floor(x / LAND_CELL);
  const j = Math.floor(y / LAND_CELL);
  return i >= 0 && j >= 0 && i < landGrid.cols && j < landGrid.rows && landGrid.cells[j * landGrid.cols + i] === 1;
}

function navCanvas(w, h, scale) {
  const cv = document.createElement("canvas");
  cv.width = w * scale;
  cv.height = h * scale;
  const g = cv.getContext("2d");
  g.scale(scale, scale);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { cv, g, tex };
}

// The compass card, drawn once with north at the top; the instruments turn it.
let compassCardCanvas = null;
function compassCard() {
  if (compassCardCanvas) return compassCardCanvas;
  compassCardCanvas = ibCanvas(512, 512, (g) => {
    g.translate(256, 256);
    g.fillStyle = "#0a0f13";
    g.beginPath();
    g.arc(0, 0, 252, 0, 6.29);
    g.fill();
    g.strokeStyle = g.fillStyle = "#e6eef3";
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (let d = 0; d < 360; d += 2) {
      g.save();
      g.rotate((d * Math.PI) / 180);
      g.lineWidth = d % 10 === 0 ? 4 : 1.5;
      g.beginPath();
      g.moveTo(0, -246);
      g.lineTo(0, d % 10 === 0 ? -218 : -230);
      g.stroke();
      if (d % 30 === 0) {
        const cardinal = d % 90 === 0;
        g.fillStyle = d === 0 ? "#ff5a4d" : "#e6eef3";
        g.font = `bold ${cardinal ? 58 : 34}px monospace`;
        g.fillText(cardinal ? "NESW"[d / 90] : String(d).padStart(3, "0"), 0, cardinal ? -180 : -188);
      }
      g.restore();
    }
    // the rose: eight points, north in red
    for (let i = 7; i >= 0; i--) {
      g.save();
      g.rotate((i * Math.PI) / 4);
      const len = i % 2 ? 80 : 130;
      for (const side of [-1, 1]) {
        g.fillStyle = i === 0 ? (side < 0 ? "#ff5a4d" : "#a8281f") : side < 0 ? "#d9e1e6" : "#6d7a83";
        g.beginPath();
        g.moveTo(0, -len);
        g.lineTo(side * 22, -24);
        g.lineTo(0, 0);
        g.fill();
      }
      g.restore();
    }
  }).image;
  return compassCardCanvas;
}

// The card turned so that `bearing` (degrees) lies under the top of the dial.
function drawCompassCard(g, x, y, r, bearing) {
  g.save();
  g.translate(x, y);
  g.rotate((-bearing * Math.PI) / 180);
  g.drawImage(compassCard(), -r, -r, r * 2, r * 2);
  g.restore();
}

function drawCompassDial(c, bearing) {
  const g = c.g;
  g.fillStyle = "#1c1408";
  g.fillRect(0, 0, 256, 256);
  drawCompassCard(g, 128, 128, 126, bearing);
  // the lubber line (the ship's head), the pivot and the glass
  g.fillStyle = "#ffa21a";
  g.beginPath();
  g.moveTo(117, 0);
  g.lineTo(139, 0);
  g.lineTo(128, 34);
  g.fill();
  g.fillStyle = "#c79a3e";
  g.beginPath();
  g.arc(128, 128, 11, 0, 6.29);
  g.fill();
  const glare = g.createLinearGradient(40, 30, 190, 210);
  glare.addColorStop(0, "rgba(255,255,255,0.16)");
  glare.addColorStop(0.45, "rgba(255,255,255,0)");
  g.fillStyle = glare;
  g.beginPath();
  g.arc(128, 128, 126, 0, 6.29);
  g.fill();
  c.tex.needsUpdate = true;
}

const bearingText = (deg) => String(Math.round(deg) % 360).padStart(3, "0");

function drawConningScreen(nav, ship, own) {
  const { g, tex } = nav.conning;
  const heading = compassBearing(ship.angle);
  const topKnots = BRIDGE_TOP_KNOTS[ship.category || "Cruise"] || 20;
  const speedOver = Math.hypot(own.vx, own.vy);
  const moving = speedOver > 2;
  const course = moving ? compassBearing(Math.atan2(own.vy, own.vx)) : heading;
  const rudder = ship.helm ? ship.helm.rudder : 0;
  ibScreenBase(g, 512, 372, "#08151f", "CONNING", `HDG ${bearingText(heading)}   MANUAL STEERING`);
  drawCompassCard(g, 175, 155, 108, nav.card);
  // own ship and lubber line fixed; the green mark is the course over the ground
  g.strokeStyle = "#ffd24a";
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(175, 120);
  g.lineTo(190, 180);
  g.lineTo(175, 170);
  g.lineTo(160, 180);
  g.closePath();
  g.stroke();
  g.beginPath();
  g.moveTo(175, 40);
  g.lineTo(175, 66);
  g.stroke();
  if (moving) {
    const a = ((course - heading) * Math.PI) / 180;
    g.fillStyle = "#3be07a";
    g.beginPath();
    g.arc(175 + Math.sin(a) * 108, 155 - Math.cos(a) * 108, 6, 0, 6.29);
    g.fill();
  }
  ibDial(g, 175, 304, 32, "RUD", 0.5 + rudder * 0.5);
  ibReadouts(g, 372, [
    ["HDG", `${bearingText(heading)}°`],
    ["STW kn", ((ship.speed / ship.maxSpeed) * topKnots).toFixed(1)],
    ["SOG kn", ((speedOver / ship.maxSpeed) * topKnots).toFixed(1)],
    ["COG", moving ? `${bearingText(course)}°` : "---"],
    ["ROT °/s", `${nav.turn > 0.5 ? "S " : nav.turn < -0.5 ? "P " : ""}${Math.abs(nav.turn).toFixed(0)}`]
  ]);
  tex.needsUpdate = true;
}

// How something is moving over the ground, worked out from where it has been.
function navMotion(nav, e) {
  const now = game.elapsed;
  let m = nav.motion.get(e);
  const span = m ? now - m.at : 0;
  if (!m || span < 0 || span > 4 || Math.hypot(e.x - m.x, e.y - m.y) > 80 + span * 500) {
    const speed = e.speed || 0;
    m = { x: e.x, y: e.y, at: now, vx: Math.cos(e.angle || 0) * speed, vy: Math.sin(e.angle || 0) * speed };
    nav.motion.set(e, m);
  } else if (span >= 0.2) {
    m.vx += ((e.x - m.x) / span - m.vx) * 0.6;
    m.vy += ((e.y - m.y) / span - m.vy) * 0.6;
    m.x = e.x;
    m.y = e.y;
    m.at = now;
  }
  return m;
}

// Whether the beam is stopped by land or an island before it reaches the target.
function radarShadowed(x, y, tx, ty) {
  const d = Math.hypot(tx - x, ty - y);
  const dx = (tx - x) / d;
  const dy = (ty - y) / d;
  for (let s = 20; s < d - 24; s += RADAR_STEP) {
    const px = x + dx * s;
    const py = y + dy * s;
    if (radarLandAt(px, py)) return true;
    for (const hz of hazards) if (hz.kind !== "iceberg" && (px - hz.x) ** 2 + (py - hz.y) ** 2 < hz.r * hz.r) return true;
  }
  return false;
}

// Paints the echoes the beam finds as it turns from angle `from` to `to` (map angles).
// The echo picture is north-up and centred on the ship.
function radarPaint(nav, ship, from, to) {
  const r = nav.radar;
  const g = r.echo.g;
  const px = RADAR_R / RADAR_RANGE; // screen units per game unit
  const mid = RADAR_R;
  if (to - from >= Math.PI * 2 - 0.001) g.clearRect(0, 0, mid * 2, mid * 2);
  else {
    // what was painted here on earlier turns fades into an afterglow
    g.globalCompositeOperation = "destination-out";
    g.fillStyle = "rgba(0,0,0,0.75)";
    g.beginPath();
    g.moveTo(mid, mid);
    g.arc(mid, mid, RADAR_R + 2, from, to);
    g.fill();
    g.globalCompositeOperation = "source-over";
  }
  const near = (o, reach) => Math.hypot(o.x - ship.x, o.y - ship.y) < RADAR_RANGE + reach;
  const solids = hazards.filter((hz) => near(hz, hz.r));
  const rain = dynamicDangers.filter((dz) => dz.kind === "storm" && dz.arriveIn <= 0 && near(dz, dz.r));
  const ice = game.iceSheets.filter((s) => near(s, s.r * 1.3));
  const rough = clamp(sea.roughness, 0, 1);
  const clutter = 50 + 260 * rough; // how far out the waves return echoes
  const upwind = Math.atan2(-game.wind.y, -game.wind.x);
  const dot = (a, d, color, size) => {
    g.fillStyle = color;
    g.fillRect(mid + Math.cos(a) * d * px - size / 2, mid + Math.sin(a) * d * px - size / 2, size, size);
  };

  for (let a = from; a < to; a += RADAR_RAY) {
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let depth = 0; // how far into the first solid thing the beam has got
    for (let d = 14, n = 0; d < RADAR_RANGE; d += RADAR_STEP, n++) {
      const x = ship.x + dx * d;
      const y = ship.y + dy * d;
      const blur = 1.8 + d * px * RADAR_RAY;
      let strength = radarLandAt(x, y) ? 1 : 0;
      if (!strength) {
        for (const hz of solids) {
          if ((x - hz.x) ** 2 + (y - hz.y) ** 2 < hz.r * hz.r) {
            strength = hz.kind === "iceberg" ? 0.7 : 1;
            break;
          }
        }
      }
      if (strength) {
        // a bright leading edge, a ragged weaker return behind it
        const a0 = depth < 22 ? 0.95 : Math.max(0, 0.6 - (depth - 22) / 170) * (0.4 + Math.random());
        if (a0 > 0.03) dot(a, d, `rgba(255,${depth < 22 ? 214 : 176},64,${Math.min(1, a0 * strength)})`, blur);
        depth += RADAR_STEP;
        continue;
      }
      if (depth) break; // radar shadow behind it
      if (d < clutter) {
        const chance = rough * 0.45 * (1 - d / clutter) * (1 + 0.6 * Math.cos(a - upwind));
        if (Math.random() < chance) dot(a, d, `rgba(220,200,80,${0.2 + Math.random() * 0.4})`, 1.6);
      }
      for (const s of rain) {
        if ((x - s.x) ** 2 + (y - s.y) ** 2 < s.r * s.r && Math.random() < 0.45 * s.rain) dot(a, d, "rgba(170,230,120,0.4)", blur);
      }
      if (tempest.intensity > 0 && Math.random() < 0.025 * tempest.intensity) dot(a, d, "rgba(170,230,120,0.3)", blur);
      if (ice.length && n % 2 === 0 && Math.random() < 0.4 && iceAt(x, y) === "solid") dot(a, d, "rgba(225,190,90,0.35)", blur);
      // a tsunami's wall of water shows as a bright line sweeping in
      if (tsunami.state === "active" && Math.abs(x * tsunami.dirX + y * tsunami.dirY - tsunami.front) < 18 && Math.random() < 0.8) dot(a, d, "rgba(255,230,110,0.9)", blur);
      if (whirlpool.state !== "dormant" && Math.abs(Math.hypot(x - whirlpool.x, y - whirlpool.y) - whirlpool.r * 0.7) < 14 && Math.random() < 0.4) dot(a, d, "rgba(220,200,80,0.5)", blur);
      if (waterSpout.state === "active" && (x - waterSpout.x) ** 2 + (y - waterSpout.y) ** 2 < waterSpout.r ** 2 && Math.random() < 0.7) dot(a, d, "rgba(200,230,110,0.7)", blur);
    }
  }

  // Small targets, painted as the beam passes them: a blob stretched across the beam.
  const turn = Math.PI * 2;
  const sweptAt = (x, y) => {
    const dx = x - ship.x;
    const dy = y - ship.y;
    const d = Math.hypot(dx, dy);
    if (d < 20 || d > RADAR_RANGE) return null;
    const a = Math.atan2(dy, dx);
    if ((((a - from) % turn) + turn) % turn >= to - from) return null;
    return radarShadowed(ship.x, ship.y, x, y) ? null : { a, d };
  };
  const blob = (hit, size, alpha) => {
    g.fillStyle = `rgba(255,220,80,${alpha})`;
    g.beginPath();
    g.ellipse(mid + Math.cos(hit.a) * hit.d * px, mid + Math.sin(hit.a) * hit.d * px, 1.8 * size, 3.2 * size, hit.a, 0, turn);
    g.fill();
  };
  for (const b of buoys) {
    const hit = sweptAt(b.x + HALF_W, b.z + HALF_H);
    if (hit) blob(hit, 0.6, 0.75);
  }
  // sea creatures and periscopes only show now and then
  for (const c of game.seaCreatures) {
    const hit = sweptAt(c.x, c.y);
    if (hit && Math.random() < 0.55) blob(hit, 0.8, 0.5);
  }
  for (const u of game.underwaterEnemies) {
    const hit = sweptAt(u.x, u.y);
    if (hit && !u.capsized && Math.random() < 0.3) blob(hit, 0.5, 0.45);
  }
  const ships = allCombatShips().filter((s) => s !== ship);
  if (game.galley && game.galley.boat !== ship) ships.push(game.galley.boat);
  for (const s of ships) {
    const hit = sweptAt(s.x, s.y);
    if (!hit) continue;
    blob(hit, s.type === "pirate" ? 1 : 1.4, 1);
    const m = navMotion(nav, s);
    r.tracks.set(s, { x: s.x, y: s.y, vx: m.vx, vy: m.vy, at: game.elapsed });
  }
  for (const [s, t] of r.tracks) if (!ships.includes(s) || game.elapsed - t.at > 6 || game.elapsed < t.at) r.tracks.delete(s);
}

function drawRadarScreen(nav, ship, own, t) {
  const r = nav.radar;
  const { g, tex } = r.screen;
  const heading = compassBearing(ship.angle);
  const turn = -Math.PI / 2 - ship.angle; // map picture -> heading up
  const px = RADAR_R / RADAR_RANGE;
  const cx = RADAR_CX;
  const cy = RADAR_CY;
  const R = RADAR_R;

  // tracked targets: closest point of approach, from both courses and speeds
  const targets = [...r.tracks.values()].map((trk) => {
    const age = game.elapsed - trk.at;
    const rx = trk.x + trk.vx * age - ship.x;
    const ry = trk.y + trk.vy * age - ship.y;
    const vx = trk.vx - own.vx;
    const vy = trk.vy - own.vy;
    const tcpa = Math.max(0, -(rx * vx + ry * vy) / (vx * vx + vy * vy || 1));
    const cpa = Math.hypot(rx + vx * tcpa, ry + vy * tcpa);
    const range = Math.hypot(rx, ry);
    return { trk, tcpa, cpa, range, bearing: compassBearing(Math.atan2(ry, rx)), danger: tcpa > 0.5 && tcpa < RADAR_TCPA_LIMIT && cpa < RADAR_CPA_LIMIT };
  }).filter((o) => o.range < RADAR_RANGE);
  const risks = targets.filter((o) => o.danger).sort((a, b) => a.tcpa - b.tcpa);
  const shown = risks[0] || targets.sort((a, b) => a.range - b.range)[0];

  ibScreenBase(g, 512, 372, "#02120e", "RADAR X-BAND  ARPA", "");
  g.fillStyle = risks.length ? "#ff5a4d" : "#d6f1ff";
  g.fillText(risks.length ? "COLLISION RISK" : `${RADAR_RANGE_NM} NM  HDG UP  HDG ${bearingText(heading)}`, 12, 361);
  g.save();
  g.beginPath();
  g.arc(cx, cy, R, 0, 6.29);
  g.fillStyle = "#031d16";
  g.fill();
  g.clip();
  g.translate(cx, cy);
  g.rotate(turn);
  g.drawImage(r.echo.cv, -R, -R, R * 2, R * 2);
  // the beam and the glow it leaves behind
  for (let i = 0; i < 14; i++) {
    g.fillStyle = `rgba(80,255,160,${0.2 * (1 - i / 14) ** 2})`;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, R, r.angle - (i + 1) * 0.07, r.angle - i * 0.07);
    g.fill();
  }
  g.strokeStyle = "rgba(150,255,200,0.85)";
  g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(Math.cos(r.angle) * R, Math.sin(r.angle) * R);
  g.stroke();
  g.restore();

  // range rings, the relative bearing scale and the heading line
  g.strokeStyle = "rgba(60,255,150,0.4)";
  g.lineWidth = 1;
  for (let nm = RADAR_RING_NM; nm <= RADAR_RANGE_NM + 0.001; nm += RADAR_RING_NM) {
    g.beginPath();
    g.arc(cx, cy, nm * NAV_NM * px, 0, 6.29);
    g.stroke();
  }
  for (let d = 0; d < 360; d += 5) {
    const a = (d * Math.PI) / 180;
    const len = d % 30 === 0 ? 10 : 4;
    g.beginPath();
    g.moveTo(cx + Math.sin(a) * R, cy - Math.cos(a) * R);
    g.lineTo(cx + Math.sin(a) * (R - len), cy - Math.cos(a) * (R - len));
    g.stroke();
  }
  g.strokeStyle = "rgba(230,255,240,0.8)";
  g.beginPath();
  g.moveTo(cx, cy);
  g.lineTo(cx, cy - R);
  g.stroke();
  const north = (-heading * Math.PI) / 180;
  g.fillStyle = "#ff5a4d";
  g.font = "bold 15px monospace";
  g.textAlign = "center";
  g.fillText("N", cx + Math.sin(north) * (R - 18), cy - Math.cos(north) * (R - 18) + 5);
  g.textAlign = "left";

  // tracked targets with their course vectors (where each will be in 6 s)
  g.save();
  g.beginPath();
  g.arc(cx, cy, R, 0, 6.29);
  g.clip();
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const at = (x, y) => [cx + (x * c - y * s) * px, cy + (x * s + y * c) * px];
  for (const o of targets) {
    const [x, y] = at(o.trk.x - ship.x, o.trk.y - ship.y);
    const [x2, y2] = at(o.trk.x + o.trk.vx * 6 - ship.x, o.trk.y + o.trk.vy * 6 - ship.y);
    g.strokeStyle = o.danger ? "#ff5a4d" : "#7dffc0";
    g.lineWidth = o.danger ? 2.5 : 1.5;
    if (!o.danger || Math.sin(t * 8) > -0.3) g.strokeRect(x - 6, y - 6, 12, 12);
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x2, y2);
    g.stroke();
    if (o === shown) {
      g.beginPath();
      g.arc(x, y, 11, 0, 6.29);
      g.stroke();
    }
  }
  g.restore();
  g.fillStyle = "#fff";
  g.fillRect(cx - 2, cy - 5, 4, 10);

  const nm = (units) => (units / NAV_NM).toFixed(2);
  ibReadouts(g, 390, [
    ["TGT RNG", shown ? nm(shown.range) : "--"],
    ["TGT BRG", shown ? `${bearingText(shown.bearing)}°` : "--"],
    ["CPA NM", shown ? nm(shown.cpa) : "--"],
    ["TCPA", shown && shown.tcpa > 0.5 && shown.tcpa < 600 ? `${Math.round(shown.tcpa)} s` : "--"],
    ["TARGETS", String(targets.length)]
  ]);
  tex.needsUpdate = true;
}

// Turns the radar beam on by `since` seconds, then draws the screen.
function updateRadar(nav, ship, t, since) {
  const r = nav.radar;
  // first look, or a new voyage has moved the ship: start the picture again
  if (since > 0.5 || Math.hypot(ship.x - r.x, ship.y - r.y) > 150) {
    r.tracks.clear();
    r.x = ship.x;
    r.y = ship.y;
    radarPaint(nav, ship, r.angle, r.angle + Math.PI * 2);
  } else {
    radarShift(r, ship);
    const to = r.angle + RADAR_SWEEP * since;
    radarPaint(nav, ship, r.angle, to);
    r.angle = to % (Math.PI * 2);
  }
  drawRadarScreen(nav, ship, nav.own, t);
}

// Moves the echoes already painted back as the ship moves on, so they stay where
// the things are until the beam comes round again. By whole pixels (r.x, r.y is
// where the picture is centred), or the picture would blur.
function radarShift(r, ship) {
  const { g, cv } = r.echo;
  const k = (cv.width / (RADAR_R * 2)) * (RADAR_R / RADAR_RANGE); // canvas pixels per game unit
  const dx = Math.round((ship.x - r.x) * k);
  const dy = Math.round((ship.y - r.y) * k);
  if (!dx && !dy) return;
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = "copy";
  g.drawImage(cv, -dx, -dy);
  g.restore();
  r.x += dx / k;
  r.y += dy / k;
}

// ---------------------------------------------------------------------------
// The electronic chart (ECDIS): the waters as they were last surveyed, north up
// round the ship. A record, not a live picture: no ice, weather, other vessels
// or barriers, nothing that happened since the survey (the sink hole that made
// the waterfall), and blank where no one has surveyed. What is there now is for
// the radar and the lookout. Harbour B is added only while it is in sight.
// ---------------------------------------------------------------------------
const CHART_SPAN = 2000; // game units across the screen
const CHART_OLD_RIVER = { length: 600, half: 135 }; // the surveyed river ran on past today's falls
const CHART_HARBOUR_B_BLANK = 760; // mission charts are blank this far round Harbour B's corner
const CHART_LAND = "#d9c68c";
const CHART_SEA = "#e3f1f7";
const surveyCharts = {};

function surveyChart(m) {
  if (surveyCharts[m.id]) return surveyCharts[m.id];
  const cv = document.createElement("canvas");
  cv.width = WORLD_W * CHART_SCALE;
  cv.height = WORLD_H * CHART_SCALE;
  const g = cv.getContext("2d");
  const img = g.createImageData(cv.width, cv.height);
  const f = m.falls;
  const old = f && [f.x, f.y, f.x + f.dx * CHART_OLD_RIVER.length, f.y + f.dy * CHART_OLD_RIVER.length];
  for (let j = 0; j < cv.height; j++) {
    for (let i = 0; i < cv.width; i++) {
      const x = i / CHART_SCALE;
      const y = j / CHART_SCALE;
      let depth = terrainDepthRaw(m, x, y);
      if (old) depth = Math.max(depth, CHART_OLD_RIVER.half - segmentDistance(x, y, old));
      const c = depth < 0 ? [217, 198, 140] : depth < 30 ? [169, 211, 230] : [227, 241, 247];
      img.data.set([...c, 255], (j * cv.width + i) * 4);
    }
  }
  g.putImageData(img, 0, 0);
  return (surveyCharts[m.id] = cv);
}

function drawChartScreen(nav, ship) {
  const { g, tex } = nav.chart;
  const m = game.mission;
  const k = 512 / CHART_SPAN;
  const circle = (x, y, r) => {
    g.beginPath();
    g.arc(x, y, r, 0, 6.29);
  };
  ibScreenBase(g, 512, 372, "#8e989e", "ECDIS  NORTH UP", "SURVEY CHART - NOT LIVE");
  g.save();
  g.beginPath();
  g.rect(0, 36, 512, 302);
  g.clip();
  g.translate(256 - ship.x * k, 187 - ship.y * k);
  g.scale(k, k);
  if (m) g.drawImage(surveyChart(m), 0, 0, WORLD_W, WORLD_H);
  else {
    g.fillStyle = CHART_SEA;
    g.fillRect(0, 0, WORLD_W, WORLD_H);
  }
  g.strokeStyle = "rgba(30,80,120,0.3)";
  g.lineWidth = 1 / k;
  for (let x = 0; x <= WORLD_W; x += 300) g.strokeRect(x, 0, 0, WORLD_H);
  for (let y = 0; y <= WORLD_H; y += 300) g.strokeRect(0, y, WORLD_W, 0);
  // islands and volcanoes are on the chart; ice never is
  g.lineWidth = 2 / k;
  for (const hz of hazards) {
    if (hz.kind === "iceberg") continue;
    circle(hz.x, hz.y, hz.r);
    g.fillStyle = CHART_LAND;
    g.fill();
    g.strokeStyle = "#6d5a2c";
    g.stroke();
    if (hz.kind !== "volcano") continue;
    circle(hz.x, hz.y, hz.r * 0.35);
    g.fillStyle = "#b0207a";
    g.fill();
  }
  g.textAlign = "center";
  g.font = `bold ${13 / k}px monospace`;
  for (const [x, y, r] of m ? [[WORLD_W, 0, CHART_HARBOUR_B_BLANK], ...m.unsurveyed] : []) {
    g.save();
    circle(x, y, r);
    g.fillStyle = "#b4bcc1";
    g.fill();
    g.clip();
    g.strokeStyle = "rgba(60,70,80,0.35)";
    g.beginPath();
    for (let d = -r * 2; d < r * 2; d += 60) {
      g.moveTo(x + d - r, y + r);
      g.lineTo(x + d + r, y - r);
    }
    g.stroke();
    g.fillStyle = "#26323a";
    g.fillText("UNSURVEYED", x, y);
    g.restore();
  }
  const harbours = harbourBSighted() ? [HarbourA, HarbourB] : [HarbourA];
  g.lineCap = "round";
  for (const p of HARBOUR_LAND) {
    if (p.kind === "moored" || !harbours.includes(p.harbour)) continue;
    g.strokeStyle = p.kind === "coast" ? CHART_LAND : "#6d6a62";
    g.lineWidth = p.r * 2;
    g.beginPath();
    g.moveTo(p.ax, p.ay);
    g.lineTo(p.bx, p.by);
    g.stroke();
  }
  g.fillStyle = "#12232e";
  for (const h of harbours) g.fillText(h.name.toUpperCase(), h.x, h.y);
  // the track the chart plotter has kept
  if (ship.track && crewLevel(ship, "navigator") >= 1) {
    g.strokeStyle = "#b0207a";
    g.lineWidth = 2 / k;
    g.setLineDash([8 / k, 5 / k]);
    g.beginPath();
    [...ship.track, ship].forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.stroke();
    g.setLineDash([]);
  }
  // own ship (from her satellite fix) and where she will be in 6 s
  g.translate(ship.x, ship.y);
  g.rotate(ship.angle);
  g.scale(1 / k, 1 / k);
  g.strokeStyle = g.fillStyle = "#111";
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(Math.max(34, ship.speed * 6 * k), 0); // (a short heading line when stopped)
  g.stroke();
  g.beginPath();
  g.moveTo(18, 0);
  g.lineTo(-10, 9);
  g.lineTo(-4, 0);
  g.lineTo(-10, -9);
  g.fill();
  g.restore();
  tex.needsUpdate = true;
}

// One set of live screens for one bridge. An open helm has only the compass.
// Redrawing a screen means sending its picture to the graphics card again, so
// each has its own rate and only one is redrawn in any frame.
function createNavInstruments(hi, enclosed) {
  const sharp = hi ? 1.5 : 1;
  const nav = {
    compass: navCanvas(256, 256, hi ? 2 : 1),
    conning: navCanvas(512, 372, sharp),
    radar: enclosed ? { screen: navCanvas(512, 372, sharp), echo: navCanvas(RADAR_R * 2, RADAR_R * 2, sharp), angle: 0, tracks: new Map(), x: 0, y: 0 } : null,
    chart: enclosed ? navCanvas(512, 372, sharp) : null, // the electronic chart
    wind: null, // the wind instrument (drawWindScreen), set once the room is built
    motion: new WeakMap(),
    own: null,
    seen: -9,
    card: 0, // the compass card's bearing, and how fast it is swinging
    cardSpin: 0,
    shown: 0, // the bearing the compass was last drawn at
    heading: 0,
    turn: 0, // rate of turn, degrees per second
    screens: [{
      every: hi ? 1 / 15 : 1 / 10,
      moved: () => Math.abs(nav.card - nav.shown) > 0.25,
      draw: () => {
        nav.shown = nav.card;
        drawCompassDial(nav.compass, nav.card);
      }
    }]
  };
  if (enclosed) {
    nav.screens.push(
      { every: hi ? 1 / 20 : 1 / 12, draw: (ship, t, since) => updateRadar(nav, ship, t, since) },
      { every: 1 / 5, draw: (ship) => drawConningScreen(nav, ship, nav.own) },
      { every: 1 / 4, draw: () => drawWindScreen(nav.wind) },
      { every: 1 / 3, draw: (ship) => drawChartScreen(nav, ship) }
    );
  }
  for (const s of nav.screens) s.at = -9;
  drawCompassDial(nav.compass, 0); // never blank, also on ships nobody is steering
  return nav;
}

// Every frame: keeps the compass card and the ship's motion up to date, and
// redraws the one screen that is furthest behind its rate (if any is due).
function updateNavInstruments(nav, ship, t) {
  const dt = t - nav.seen;
  if (dt <= 0) return;
  nav.seen = t;
  const fresh = dt > 0.5; // first look, or back after a spell away
  const heading = compassBearing(ship.angle);
  const wrap = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
  if (fresh) {
    nav.card = heading;
    nav.cardSpin = 0;
    nav.turn = 0;
  } else {
    nav.turn += (wrap(heading - nav.heading) / dt - nav.turn) * Math.min(1, dt * 4);
    // the card floats in its bowl: it lags a turn a little and settles with a small swing
    const step = Math.min(dt, 0.1);
    nav.cardSpin += (wrap(heading - nav.card) * 30 - nav.cardSpin * 8) * step;
    nav.card += nav.cardSpin * step;
  }
  nav.heading = heading;
  nav.own = navMotion(nav, ship);
  let next = null;
  let behind = 1;
  for (const s of nav.screens) {
    const late = (t - s.at) / s.every;
    if (late >= behind && (!s.moved || s.moved())) {
      next = s;
      behind = late;
    }
  }
  if (!next) return;
  const since = t - next.at;
  next.at = t;
  next.draw(ship, t, since);
}

// The control panels on the console desk. Each item is [part, across, forward, label, colour],
// measured from the middle of the panel; the same list prints the labels and places the parts.
const PANEL_W = 0.66;
const PANEL_D = 0.4;
const BRIDGE_PANELS = {
  pilot: { title: "AUTOPILOT", items: [["lcd", -0.12, 0.05, "PILOT"], ["knob", 0.17, 0.05, "COURSE"], ["btn", -0.23, -0.11, "AUTO", "green"], ["btn", -0.12, -0.11, "NFU", "white"], ["btn", -0.01, -0.11, "TRACK", "white"], ["btn", 0.1, -0.11, "ACK", "yellow"], ["guard", 0.23, -0.1, "OVRD"]] },
  keys: { title: "NAV INPUT", items: [["keyboard", -0.08, -0.02, ""], ["ball", 0.23, -0.04, "CURSOR"], ["led", 0.19, 0.1, "PWR", "green"], ["led", 0.27, 0.1, "LINK", "blue"]] },
  lights: { title: "DECK AND NAV LIGHTS", items: [...["MAST", "PORT", "STBD", "STERN", "ANCH"].map((n, i) => ["toggle", -0.24 + i * 0.12, 0.06, n]), ...["DECK", "FLOOD", "NUC", "SIG"].map((n, i) => ["btn", -0.23 + i * 0.12, -0.09, n, i === 2 ? "red" : "white"]), ["knob", 0.24, -0.08, "DIM"]] },
  thrust: { title: "THRUSTERS", items: [["knob", -0.2, 0.05, "BOW"], ["knob", 0, 0.05, "STERN"], ["knob", 0.2, 0.05, "STAB"], ["btn", -0.23, -0.11, "ON", "green"], ["btn", -0.12, -0.11, "OFF", "red"], ["led", 0.02, -0.11, "READY", "green"], ["led", 0.12, -0.11, "FAULT", "yellow"], ["btn", 0.23, -0.11, "TEST", "blue"]] },
  engine: { title: "MAIN ENGINES", items: [["btn", -0.23, 0.07, "START", "green"], ["btn", -0.23, -0.09, "STOP", "red"], ["btn", 0.23, 0.07, "CLUTCH", "white"], ["guard", 0.23, -0.09, "EM STOP"]] },
  joy: { title: "STEERING", items: [["btn", -0.23, 0.07, "TAKE", "green"], ["btn", -0.23, -0.09, "WING", "white"], ["led", 0.23, 0.07, "P1", "green"], ["led", 0.23, -0.09, "P2", "green"]] },
  vhf: { title: "VHF  CH 16", items: [["phone", -0.17, -0.02, ""], ["lcd", 0.12, 0.08, ""], ...[0, 1, 2, 3, 4, 5].map((i) => ["btn", 0.04 + (i % 3) * 0.075, -0.04 - Math.floor(i / 3) * 0.08, "", "white"]), ["guard", 0.27, -0.08, "SOS"]] },
  alarm: { title: "ALARMS", items: [...["FIRE", "BILGE", "DOOR", "STEER", "GEN", "OIL", "TEMP", "GAS"].map((n, i) => ["led", -0.2 + (i % 4) * 0.133, 0.09 - Math.floor(i / 4) * 0.09, n, i === 4 ? "yellow" : "green"]), ["btn", -0.1, -0.11, "SILENCE", "yellow"], ["btn", 0.1, -0.11, "HORN", "red"]] }
};
const panelTextures = new Map();
function panelTexture(panel) {
  if (!panelTextures.has(panel)) {
    panelTextures.set(panel, ibCanvas(330, 200, (g, w, h) => {
      g.fillStyle = "#39434b";
      g.fillRect(0, 0, w, h);
      ibSpeckle(g, w, h, 900, 0.08);
      g.strokeStyle = "rgba(225,235,242,0.55)";
      g.lineWidth = 2;
      g.strokeRect(8, 8, w - 16, h - 16);
      g.font = "bold 13px sans-serif";
      g.textAlign = "center";
      g.fillStyle = "#39434b";
      const wide = g.measureText(panel.title).width + 12;
      g.fillRect((w - wide) / 2, 2, wide, 14);
      g.fillStyle = "#eef4f8";
      g.fillText(panel.title, w / 2, 14);
      g.font = "bold 10px sans-serif";
      for (const [part, across, forward, label] of panel.items) {
        const x = (across / PANEL_W + 0.5) * w;
        const y = (0.5 - forward / PANEL_D) * h;
        if (part === "knob") {
          for (let n = -4; n <= 4; n++) {
            g.beginPath();
            g.moveTo(x + Math.sin(n * 0.55) * 22, y - Math.cos(n * 0.55) * 22);
            g.lineTo(x + Math.sin(n * 0.55) * 27, y - Math.cos(n * 0.55) * 27);
            g.stroke();
          }
        }
        if (label) g.fillText(label, x, y + (part === "lcd" ? 31 : part === "led" ? 20 : 31));
      }
      for (const x of [16, w - 16]) {
        for (const y of [19, h - 19]) {
          g.fillStyle = "#aab4bb";
          g.beginPath();
          g.arc(x, y, 3.5, 0, 6.29);
          g.fill();
          g.fillStyle = "#222";
          g.fillRect(x - 3, y - 0.7, 6, 1.4);
        }
      }
    }));
  }
  return panelTextures.get(panel);
}

// One set of materials per interior (each ship fades its own, so a split screen can show one
// player inside and the other outside).
// High graphics levels (Extreme, Ultra, High) get the realistic interior: surface relief,
// glass panes that reflect the sky, sun shadows falling through the windows, and small
// props. Lower levels keep the plain textured room.
const bridgeHigh = () => perf.level <= 2;

function bridgeMats(nav) {
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
    radar: nav.radar ? screen(nav.radar.screen.tex) : null,
    chart: nav.chart ? screen(nav.chart.tex) : null,
    gauges: screen(T.gauges),
    lamps: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0xaed4e8, transparent: true, opacity: 0.1, roughness: 0.04, metalness: 0, envMapIntensity: 1.8, side: sd, depthWrite: false, userData: { noDepth: true } }),
    red: mat(0xb3261e, { roughness: 0.4, metalness: 0.2 }),
    white: mat(0xf2f2ee, { roughness: 0.5 }),
    conning: screen(nav.conning.tex),
    alarms: screen(T.alarms),
    paint: m(T.paint, { roughness: 0.55, metalness: 0.25, emissiveIntensity: 0.25 }),
    planks: m(T.planks, { roughness: 0.8 }),
    rubber: mat(0x0d0f11, { roughness: 0.9 }),
    brass: mat(0xc79a3e, { roughness: 0.28, metalness: 0.85, emissive: 0x2a1c05 }),
    sand: mat(0xbfa574, { roughness: 1 }), // in the sand glass
    cord: mat(0xd9bf8a, { map: ropeTexture, bumpMap: ropeTexture, bumpScale: 1.5, roughness: 0.95 }), // laid rope
    orange: mat(0xe4601a, { roughness: 0.8 }),
    green: mat(0x14763c, { roughness: 0.35, emissive: 0x0d5a2c }),
    blue: mat(0x1d5fa8, { roughness: 0.35, emissive: 0x0f3a70 }),
    yellow: mat(0xc98a10, { roughness: 0.35, emissive: 0x6a4200 }),
    clockFace: screen(T.clockFace),
    rudderDial: screen(T.rudderDial),
    rpmDial: screen(T.rpmDial),
    tiltDial: screen(T.tiltDial),
    compass: screen(nav.compass.tex),
    ...Object.fromEntries(Object.entries(BRIDGE_PANELS).map(([name, panel]) =>
      [`panel_${name}`, m(panelTexture(panel), { roughness: 0.5, metalness: 0.2 })]))
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

// The capsize alarm fitted on every bridge: two red beacons on the console (by
// the binnacle on an open helm) and a lit warning sign above them. Hidden until
// the ship is in danger (setBridgeAlarm), when the room flashes red with it.
const ALARM_RED = new THREE.Color(0xff1405);
const ALARM_ROOM = ["wall", "ceiling", "floor", "console", "frame", "paint"];

function bridgeAlarm(M, open) {
  const g = new THREE.Group();
  const cv = document.createElement("canvas");
  cv.width = 512;
  cv.height = 96;
  const c = cv.getContext("2d");
  c.fillStyle = "#b80d05";
  c.fillRect(0, 0, 512, 96);
  c.strokeStyle = "#ffd9d0";
  c.lineWidth = 6;
  c.strokeRect(6, 6, 500, 84);
  c.fillStyle = "#ffffff";
  c.font = "bold 42px Segoe UI, sans-serif";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText("DANGER OF CAPSIZE", 256, 50);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  M.alarmSign = mat(0x200000, { emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1, roughness: 0.4, side: THREE.DoubleSide });
  M.alarmLamp = mat(0x6a0904, { emissive: 0xff1405, emissiveIntensity: 1, roughness: 0.15, metalness: 0.1 });
  M.alarmGlow = new THREE.SpriteMaterial({ map: glowStar, color: 0xff2410, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 0.253), M.alarmSign);
  sign.rotation.y = -Math.PI / 2;
  sign.position.set(open ? 3.5 : 3.75, open ? -0.42 : 0.92, 0);
  g.add(sign);
  const glows = [];
  for (const side of [-1, 1]) {
    const x = open ? 3.4 : 3.56; // on a post by the binnacle, or on the console hood
    const y = open ? -0.42 : -0.21;
    const z = side * (open ? 0.95 : 1.15);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.08, 16), M.trim);
    base.position.set(x, y - 0.03, z);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.alarmLamp);
    dome.position.set(x, y, z);
    const glow = new THREE.Sprite(M.alarmGlow);
    glow.position.set(x, y + 0.09, z);
    if (!open) for (const part of [base, dome]) part.scale.setScalar(0.6);
    else {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 1.25, 10), M.trim);
      post.position.set(x, y - 0.695, z);
      g.add(post);
    }
    g.add(base, dome, glow);
    glows.push(glow);
  }
  g.visible = false;
  return { group: g, glows };
}

// Flashes in step with the red screen border (0.6 s).
function setBridgeAlarm(o, on, t) {
  if (!on && !o.alarm.group.visible) return;
  o.alarm.group.visible = on;
  const pulse = on ? 0.5 + 0.5 * Math.sin((t * Math.PI * 2) / 0.6) : 0;
  const M = o.interiorMats;
  for (const name of ALARM_ROOM) {
    const m = M[name];
    const rest = m.userData.rest || (m.userData.rest = { color: m.emissive.clone(), level: m.emissiveIntensity });
    m.emissive.copy(rest.color).lerp(ALARM_RED, pulse);
    m.emissiveIntensity = rest.level + 0.9 * pulse;
  }
  M.alarmLamp.emissiveIntensity = 0.3 + 3.5 * pulse;
  M.alarmSign.emissiveIntensity = 0.6 + 0.9 * pulse;
  for (const glow of o.alarm.glows) glow.scale.setScalar(0.3 + 1.1 * pulse);
}

// Shaped parts for the bridge room. Everything is added to `root`; mergeStaticMeshes later joins
// the parts that share a material, so the detail costs few draw calls.
function ibKit(root) {
  const add = (geo, m, x = 0, y = 0, z = 0, parent = root) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(x, y, z);
    parent.add(o);
    return o;
  };
  const group = (x, y, z, parent = root) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };
  // a flat outline (x, y) given thickness along z, with softened edges
  const slab = (shape, depth, bevel) => {
    const d = Math.max(0.001, depth - bevel * 2);
    const g = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelOffset: -bevel, bevelSegments: 2, curveSegments: 6 });
    return g.translate(0, 0, -d / 2);
  };
  const outline = (w, h, r, path = new THREE.Shape()) => {
    const x = w / 2;
    const y = h / 2;
    path.moveTo(-x + r, -y);
    path.lineTo(x - r, -y);
    path.quadraticCurveTo(x, -y, x, -y + r);
    path.lineTo(x, y - r);
    path.quadraticCurveTo(x, y, x - r, y);
    path.lineTo(-x + r, y);
    path.quadraticCurveTo(-x, y, -x, y - r);
    path.lineTo(-x, -y + r);
    path.quadraticCurveTo(-x, -y, -x + r, -y);
    return path;
  };
  return {
    add,
    group,
    box: (w, h, d, m, x, y, z, parent) => add(new THREE.BoxGeometry(w, h, d), m, x, y, z, parent),
    // a box with rounded edges and corners
    soft: (w, h, d, m, x, y, z, parent, r = Math.min(w, h, d) * 0.3) => {
      const e = Math.min(r, w * 0.45, h * 0.45, d * 0.45);
      return add(slab(outline(w, h, e), d, e), m, x, y, z, parent);
    },
    cyl: (rt, rb, h, m, x, y, z, parent, seg = 16) => add(new THREE.CylinderGeometry(rt, rb, h, seg), m, x, y, z, parent),
    ball: (r, m, x, y, z, parent) => add(new THREE.SphereGeometry(r, 12, 8), m, x, y, z, parent),
    ring: (r, tube, m, x, y, z, parent) => add(new THREE.TorusGeometry(r, tube, 8, 28), m, x, y, z, parent),
    // a rail, hose or cord through the given points
    pipe: (points, r, m, parent) => add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, "catmullrom", 0.1), points.length * 10, r, 8), m, 0, 0, 0, parent),
    // a turned part: [radius, height] from bottom to top
    turned: (profile, m, x, y, z, parent) => add(new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(r, h)), 16), m, x, y, z, parent),
    // a side view (x, y) stretched across the ship
    profile: (points, width, m) => add(slab(new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y))), width, 0.02), m),
    // a window surround facing the captain (or a side window when `side`)
    surround: (w, h, bar, m, x, y, z, side) => {
      const shape = outline(w, h, 0.14);
      shape.holes.push(outline(w - bar * 2, h - bar * 2, 0.1, new THREE.Path()));
      const o = add(slab(shape, 0.06, 0.018), m, x, y, z);
      if (!side) o.rotation.y = Math.PI / 2;
      return o;
    },
    // a flat face lying on a desk: the top of the picture points forward
    flat: (w, d, m, x, y, z, parent) => add(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).rotateY(-Math.PI / 2), m, x, y, z, parent),
    // a round instrument facing aft
    dial: (r, face, rim, x, y, z) => {
      add(new THREE.CylinderGeometry(r * 1.12, r * 1.12, 0.09, 24).rotateZ(Math.PI / 2), rim, x + 0.05, y, z);
      add(new THREE.CircleGeometry(r, 28).rotateY(-Math.PI / 2), face, x - 0.001, y, z);
      add(new THREE.TorusGeometry(r * 1.05, r * 0.09, 8, 28).rotateY(Math.PI / 2), rim, x - 0.005, y, z);
    }
  };
}

// One control panel on the desk (`desk` lies along the slope; its top is y = 0).
function bridgePanel(k, M, name, desk) {
  k.soft(PANEL_D + 0.04, 0.03, PANEL_W + 0.04, M.frame, 0, 0, 0, desk, 0.012);
  k.flat(PANEL_W, PANEL_D, M[`panel_${name}`], 0, 0.017, 0, desk);
  for (const [part, z, x, , colour] of BRIDGE_PANELS[name].items) {
    if (part === "btn") {
      k.cyl(0.03, 0.033, 0.014, M.trim, x, 0.024, z, desk);
      k.cyl(0.021, 0.024, 0.022, M[colour], x, 0.038, z, desk);
    } else if (part === "knob") {
      k.cyl(0.044, 0.048, 0.012, M.trim, x, 0.023, z, desk);
      k.cyl(0.031, 0.037, 0.05, M.rubber, x, 0.052, z, desk, 12);
      k.box(0.04, 0.004, 0.008, M.white, x + 0.014, 0.079, z, desk);
    } else if (part === "toggle") {
      k.cyl(0.022, 0.024, 0.016, M.trim, x, 0.025, z, desk, 6);
      k.cyl(0.007, 0.01, 0.07, M.trim, x + 0.012, 0.055, z, desk, 8).rotation.z = -0.4;
      k.ball(0.012, M.trim, x + 0.026, 0.087, z, desk);
    } else if (part === "led") {
      k.cyl(0.018, 0.02, 0.01, M.trim, x, 0.022, z, desk);
      k.ball(0.012, M[colour], x, 0.028, z, desk);
    } else if (part === "guard") {
      k.cyl(0.045, 0.05, 0.016, M.yellow, x, 0.025, z, desk);
      k.cyl(0.02, 0.024, 0.026, M.trim, x, 0.044, z, desk);
      k.turned([[0.038, 0], [0.034, 0.016], [0.018, 0.027], [0, 0.03]], M.red, x, 0.052, z, desk);
    } else if (part === "lcd") {
      k.soft(0.1, 0.026, 0.2, M.rubber, x, 0.024, z, desk, 0.01);
      k.flat(0.17, 0.07, M.conning, x, 0.039, z, desk);
    } else if (part === "keyboard") {
      k.soft(0.2, 0.022, 0.4, M.rubber, x, 0.026, z, desk, 0.01);
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 12; col++) k.box(0.032, 0.014, 0.024, M.cushion, x + 0.066 - row * 0.043, 0.043, z - 0.168 + col * 0.03 + (row % 2) * 0.006, desk);
      }
    } else if (part === "ball") {
      k.cyl(0.055, 0.062, 0.022, M.rubber, x, 0.026, z, desk);
      k.ring(0.034, 0.006, M.trim, x, 0.039, z, desk).rotation.x = Math.PI / 2;
      k.ball(0.03, M.red, x, 0.036, z, desk);
    } else if (part === "phone") {
      k.soft(0.28, 0.03, 0.11, M.rubber, x, 0.027, z, desk, 0.012);
      k.soft(0.21, 0.035, 0.05, M.seat, x, 0.082, z, desk, 0.017);
      for (const end of [-0.09, 0.09]) k.soft(0.075, 0.05, 0.08, M.seat, x + end, 0.063, z, desk, 0.022);
      const cord = [];
      for (let i = 0; i <= 60; i++) cord.push([x - 0.13 + i * 0.0012, 0.045 + Math.sin(i * 1.4) * 0.016, z + 0.06 + i * 0.0022 + Math.cos(i * 1.4) * 0.016]);
      k.pipe(cord, 0.005, M.rubber, desk);
    }
  }
}

// The bridge grows with the ship. Room units around the eye: `half` the half-width, `back` the
// back wall; the other lists give one side only (mirrored). `stand` is where the inside camera
// stands (world units from the eye: forward, up), near the windows so the view out stays clear.
const BRIDGE_ROOMS = {
  large: { half: 5.1, back: -5, posts: [1.1, 3.2, 4.9], lamps: [1.7, 4.2], overhead: 2.7, dials: [1.7, 2.15, 2.6], chairs: [[-2.6, -1.4], [-2.6, 1.4]], stand: [1.3, 0.25] },
  medium: { half: 2.8, back: -5, posts: [1, 2.6], lamps: [1.5], overhead: 1.8, dials: [0.8, 1.25, 1.7], chairs: [[-1.9, -1.2], [-1.9, 1.2]], stand: [1.1, 0.22] },
  small: { half: 2, back: -3, posts: [0.85, 1.8], lamps: [1.1], overhead: 0.9, dials: [0.5, 0.95], chairs: [[-1.5, 0]], stand: [0.5, 0.2] },
  war: { half: 3.1, back: -3.2, stand: [-0.55, 0.3] } // the 1943 wheelhouse (wartimeWheelhouse)
};
const BRIDGE_CLASS = { Cruise: "large", Carrier: "large", Cargo: "large", Tanker: "large", GasTanker: "large", WarTanker: "war", Tug: "small", Hydrofoil: "small", Catamaran: "small" };
const bridgeRoom = (kind) => BRIDGE_ROOMS[BRIDGE_CLASS[kind] || "medium"];
const mirrored = (side) => [...side.map((z) => -z).reverse(), ...side];

function enclosedBridge(k, M, hi, room) {
  const { half, back } = room;
  const small = half < 2.5;
  const len = 4.2 - back; // side walls, from the back wall to the front windows
  const midX = 4.3 - len / 2;
  // floor, a mat to stand on, ceiling
  k.box(len + 0.4, 0.12, half * 2 + 0.4, M.floor, midX, -1.75, 0);
  k.soft(1.2, 0.05, Math.min(half * 1.25, half * 2 - 0.6), M.rubber, 1.6, -1.68, 0, undefined, 0.02);
  k.box(len + 0.4, 0.12, half * 2 + 0.4, M.ceiling, midX, 1.65, 0);
  // ceiling grid and recessed lamps
  for (const x of [-4, -1.6, 1.4, 3.4]) if (x > back + 0.4) k.box(0.05, 0.04, half * 2, M.trim, x, 1.575, 0);
  for (const z of [-6.8, -3.4, 0, 3.4, 6.8]) if (Math.abs(z) < half) k.box(len, 0.04, 0.05, M.trim, midX, 1.575, z);
  for (const x of [-2.8, 0, 2.55]) {
    if (x < back + 0.7) continue;
    for (const z of mirrored(room.lamps)) {
      k.soft(0.46, 0.06, 1.1, M.trim, x, 1.575, z, undefined, 0.025);
      k.soft(0.34, 0.05, 0.96, M.light, x, 1.545, z, undefined, 0.02);
    }
  }

  // the console: a shaped body with a sloping desk, a tilted display bank and a rounded hood
  k.profile([[2.42, -1.6], [2.42, -0.57], [2.47, -0.52], [2.99, -0.455], [3.49, -0.29], [3.62, -0.29], [3.68, -0.46], [4, -0.47], [4, -1.72], [2.58, -1.72], [2.58, -1.6]], half * 2, M.paint);
  const end = half - 0.1;
  k.pipe([[2.33, -0.58, -end], [2.33, -0.58, end]], 0.035, M.trim);
  for (let z = -end + 0.1; z <= end; z += 1.4) k.box(0.12, 0.03, 0.04, M.trim, 2.38, -0.58, z);
  k.pipe([[2.3, -1.45, -end], [2.3, -1.45, end]], 0.03, M.trim); // foot rail
  k.pipe([[3.57, -0.27, -end], [3.57, -0.27, end]], 0.03, M.rubber); // padded edge of the hood
  const doors = Math.floor((half - 0.6) / 1.125);
  for (let i = -doors; i <= doors; i++) {
    const z = i * 1.125;
    // cupboard doors with handles and air slots
    k.soft(0.05, 0.82, 1.05, M.console, 2.4, -1.06, z, undefined, 0.02);
    k.soft(0.05, 0.05, 0.34, M.trim, 2.355, -0.76, z, undefined, 0.02);
    for (let i = 0; i < 4; i++) k.box(0.02, 0.025, 0.6, M.rubber, 2.372, -1.2 - i * 0.065, z);
  }
  // Navigation and system displays are tilted only a little, so the windows stay clear.
  // The wind instrument: the logged wind speed (game.js windLog), its direction and the last minute and a half as a graph.
  const windCv = document.createElement("canvas");
  windCv.width = 256;
  windCv.height = 128;
  const windTex = new THREE.CanvasTexture(windCv);
  windTex.colorSpace = THREE.SRGBColorSpace;
  M.wind = mat(0xffffff, { map: windTex, emissive: 0xffffff, emissiveMap: windTex, emissiveIntensity: 1.1, roughness: 0.3, side: THREE.DoubleSide });
  const wind = { cv: windCv, tex: windTex };
  const screens = [[0, M.radar], [-0.75, M.chart], [0.75, M.wind], [-1.5, M.gauges], [1.5, M.conning], [-2.3, M.chart], [2.3, M.radar], [-3.1, M.alarms], [3.1, M.gauges], [-3.9, M.conning], [3.9, M.chart]];
  const fits = ([z]) => Math.abs(z) <= half - 0.85; // as many screens and desks as the console is wide
  for (const [z, face] of screens.filter(fits)) {
    const stand = k.group(3.24, -0.355, z);
    stand.rotation.z = 0.32;
    k.soft(0.52, 0.05, 0.7, M.rubber, 0, 0, 0, stand, 0.022);
    k.flat(0.62, 0.45, face, 0, 0.027, 0, stand);
    for (let i = 0; i < 5; i++) k.cyl(0.009, 0.009, 0.012, i === 4 ? M.green : M.trim, -0.243, 0.027, -0.14 + i * 0.07, stand, 8);
  }
  // A small wheelhouse has just the three that matter: engine levers, pilot and joystick.
  const desks = small ? [[0, "pilot"], [-0.75, "engine"], [0.75, "joy"]]
    : [[0, "pilot"], [-0.75, "keys"], [0.75, "lights"], [-1.5, "engine"], [1.5, "joy"], [-2.3, "thrust"], [2.3, "vhf"], [-3.1, "lights"], [3.1, "keys"], [-3.9, "alarm"], [3.9, "thrust"]];
  const deskOf = {};
  for (const [z, name] of desks.filter(fits)) {
    const desk = k.group(2.73, -0.47, z);
    desk.rotation.z = 0.125;
    deskOf[name] = desk;
    bridgePanel(k, M, name, desk);
  }
  // throttle levers in their slotted quadrants
  for (const z of [-0.08, 0.08]) {
    k.soft(0.3, 0.035, 0.07, M.trim, 0, 0.03, z, deskOf.engine, 0.015);
    k.box(0.24, 0.006, 0.018, M.rubber, 0, 0.05, z, deskOf.engine);
    for (let i = -4; i <= 4; i++) k.box(0.004, 0.004, 0.014, M.rubber, i * 0.028, 0.05, z + 0.025, deskOf.engine);
    const lever = k.group(0, 0.04, z, deskOf.engine);
    lever.rotation.z = -0.35;
    k.soft(0.035, 0.18, 0.025, M.trim, 0, 0.09, 0, lever, 0.01);
    k.soft(0.07, 0.065, 0.1, z < 0 ? M.red : M.green, 0, 0.2, 0, lever, 0.028);
  }
  // the joystick on its collar, with a rubber boot (modern ships have no wheel)
  k.cyl(0.13, 0.145, 0.03, M.frame, 0, 0.03, 0, deskOf.joy, 24);
  for (let i = 0; i < 4; i++) k.ring(0.085 - i * 0.017, 0.014, M.rubber, 0, 0.052 + i * 0.016, 0, deskOf.joy).rotation.x = Math.PI / 2;
  const helm = k.group(0, 0.05, 0, deskOf.joy);
  k.cyl(0.018, 0.022, 0.19, M.trim, 0, 0.1, 0, helm);
  k.turned([[0, 0], [0.03, 0.005], [0.042, 0.05], [0.052, 0.1], [0.04, 0.13], [0, 0.14]], M.seat, 0, 0.15, 0, helm);
  k.cyl(0.014, 0.014, 0.016, M.red, 0, 0.292, 0, helm, 10);
  k.soft(0.025, 0.04, 0.025, M.amber, -0.05, 0.23, 0, helm, 0.01);

  // front windows: slim rounded posts with cover strips, a rubber-set frame round every pane,
  // rolled sun blinds and wipers parked at the side of the panes
  const posts = mirrored(room.posts);
  k.soft(0.3, 0.55, half * 2, M.paint, 4, 1.35, 0, undefined, 0.08);
  for (const z of posts) {
    k.soft(0.24, 2.2, 0.2, M.paint, 4, 0.6, z, undefined, 0.08);
    k.soft(0.04, 1.52, 0.055, M.trim, 3.87, 0.3, z, undefined, 0.015);
    for (const y of [-0.34, 0.3, 0.94]) k.ball(0.016, M.rubber, 3.845, y, z);
  }
  for (let i = 0; i < posts.length - 1; i++) {
    const mid = (posts[i] + posts[i + 1]) / 2;
    const wide = posts[i + 1] - posts[i] - 0.2;
    k.surround(wide, 1.54, 0.055, M.rubber, 3.97, 0.3, mid);
    k.cyl(0.055, 0.055, wide - 0.14, M.cushion, 3.84, 1.04, mid).rotation.x = Math.PI / 2;
    k.pipe([[3.84, 1.0, mid + wide * 0.4], [3.84, 0.74, mid + wide * 0.4]], 0.005, M.white);
    k.ball(0.018, M.trim, 3.84, 0.73, mid + wide * 0.4);
    if (!hi) continue;
    const edge = mid - wide / 2 + 0.12;
    k.cyl(0.045, 0.045, 0.05, M.rubber, 3.89, 1.0, edge).rotation.z = Math.PI / 2;
    k.pipe([[3.9, 1.0, edge], [3.9, 0.45, edge + 0.07]], 0.01, M.trim);
    k.box(0.025, 0.7, 0.022, M.rubber, 3.92, 0.34, edge + 0.08).rotation.x = -0.12;
  }
  // instruments above the front windows
  const faces = small ? [M.rpmDial, M.rudderDial, M.compass, M.clockFace] : [M.rpmDial, M.rpmDial, M.rudderDial, M.compass, M.tiltDial, M.clockFace];
  mirrored(room.dials).forEach((z, i) => k.dial(0.13, faces[i % faces.length], M.trim, 3.78, 1.24, z));

  // overhead switch panel: plates with rows of toggles and lamps, and grab rails
  k.soft(1.6, 0.14, room.overhead * 2 + 1.1, M.console, 1.2, 1.5, 0, undefined, 0.05);
  const plates = Math.round(room.overhead / 0.9);
  for (let n = -plates; n <= plates; n++) {
    const z = n * 0.9;
    k.soft(1.36, 0.03, 0.8, M.paint, 1.2, 1.425, z, undefined, 0.012);
    for (let row = 0; row < 4; row++) {
      for (let i = 0; i < 5; i++) {
        const x = 0.72 + row * 0.32;
        const at = z - 0.28 + i * 0.14;
        if (row % 2) k.ball(0.022, [M.green, M.yellow, M.green, M.blue, M.red][(i + row) % 5], x, 1.405, at);
        else {
          k.cyl(0.026, 0.028, 0.02, M.trim, x, 1.4, at, undefined, 8);
          k.cyl(0.008, 0.011, 0.075, M.trim, x - 0.012, 1.36, at, undefined, 8).rotation.z = -0.35;
        }
      }
    }
  }
  const railEnd = Math.max(-2.9, back + 0.5);
  for (const z of mirrored([Math.min(room.overhead + 0.9, half - 0.2)])) k.pipe([[3, 1.56, z], [2.9, 1.34, z], [railEnd, 1.34, z], [railEnd - 0.1, 1.56, z]], 0.035, M.trim);

  // side walls and windows
  for (const side of [-1, 1]) {
    k.box(len, 1.25, 0.2, M.wall, midX, -1.1, side * half);
    k.soft(len, 0.55, 0.2, M.paint, midX, 1.35, side * half, undefined, 0.07);
    const sidePosts = [back + 0.5, ...[-2.8, -0.6, 1.6, 3.9].filter((x) => x > back + 1.2)];
    for (const x of sidePosts) k.soft(0.2, 2.2, 0.24, M.paint, x, 0.6, side * half, undefined, 0.08);
    for (let i = 0; i < sidePosts.length - 1; i++) {
      const mid = (sidePosts[i] + sidePosts[i + 1]) / 2;
      const wide = sidePosts[i + 1] - sidePosts[i] - 0.2;
      k.surround(wide, 1.54, 0.055, M.rubber, mid, 0.3, side * (half - 0.03), true);
      k.cyl(0.055, 0.055, wide - 0.14, M.cushion, mid, 1.04, side * (half - 0.15)).rotation.z = Math.PI / 2;
    }
    k.soft(len, 0.08, 0.42, M.wood, midX, -0.48, side * (half - 0.11), undefined, 0.03); // sill
    k.pipe([[back + 0.4, -0.68, side * (half - 0.3)], [2.2, -0.68, side * (half - 0.3)]], 0.035, M.trim); // grab rail
    for (let x = back + 0.6; x <= 2.2; x += 1.1) k.box(0.04, 0.03, 0.2, M.trim, x, -0.68, side * (half - 0.2));
    // heater panels under the windows
    for (const x of [-1.8, 0.7]) {
      k.soft(1.9, 0.7, 0.08, M.paint, x, -1.25, side * (half - 0.14), undefined, 0.03);
      for (let i = 0; i < 9; i++) k.box(0.05, 0.52, 0.02, M.rubber, x - 0.8 + i * 0.2, -1.25, side * (half - 0.185));
    }
  }

  // back wall: a panelled door with a porthole and lever handle, a status screen and a clock
  // (placed as for a wall at x = -5, then moved to this room's back wall)
  const rear = ibKit(k.group(back + 5, 0, 0));
  const door = Math.min(2.8, half - 1.05);
  const status = -Math.min(2.2, half - 0.8);
  const clockY = small ? 1.2 : 0.9;
  rear.box(0.2, 3.4, half * 2 + 0.4, M.wall, -5, -0.05, 0);
  rear.soft(0.1, 2.5, 1.72, M.trim, -4.9, -0.5, door, undefined, 0.03);
  rear.soft(0.1, 2.34, 1.54, M.paint, -4.86, -0.55, door, undefined, 0.035);
  rear.add(new THREE.CircleGeometry(0.27, 24).rotateY(Math.PI / 2), M.rubber, -4.8, 0.15, door);
  rear.add(new THREE.TorusGeometry(0.27, 0.05, 8, 28).rotateY(Math.PI / 2), M.brass, -4.8, 0.15, door);
  rear.cyl(0.07, 0.07, 0.06, M.trim, -4.79, -0.55, door - 0.58).rotation.z = Math.PI / 2;
  rear.soft(0.06, 0.06, 0.34, M.trim, -4.73, -0.55, door - 0.45, undefined, 0.025);
  for (const y of [0.3, -0.6, -1.4]) rear.cyl(0.035, 0.035, 0.2, M.trim, -4.8, y, door + 0.8);
  rear.soft(0.08, 0.95, 1.4, M.rubber, -4.88, 0.5, status, undefined, 0.03);
  rear.add(new THREE.PlaneGeometry(1.24, 0.8).rotateY(Math.PI / 2), M.gauges, -4.83, 0.5, status);
  rear.add(new THREE.CircleGeometry(0.27, 28).rotateY(Math.PI / 2), M.clockFace, -4.84, clockY, 0);
  rear.add(new THREE.TorusGeometry(0.29, 0.035, 8, 28).rotateY(Math.PI / 2), M.brass, -4.84, clockY, 0);

  // (the chart table and shelves are placed for a half-width of 5.1, then moved out to this wall)
  const chartZ = 5.1 - half;
  if (!small) {
    const t = ibKit(k.group(0, 0, chartZ));
    // chart table with drawers, the chart, a parallel ruler, pencils, dividers and a jointed lamp
    t.soft(1.4, 0.09, 2.5, M.wood, -3.8, -0.92, -3.3, undefined, 0.03);
    t.flat(2.2, 1.2, M.chartTable, -3.8, -0.87, -3.3);
    t.soft(1.2, 0.5, 2.3, M.wood, -3.82, -1.22, -3.3, undefined, 0.025);
    for (const z of [-4.05, -3.3, -2.55]) {
      for (const y of [-1.1, -1.33]) {
        t.soft(0.04, 0.19, 0.66, M.wood, -3.2, y, z, undefined, 0.015);
        t.soft(0.04, 0.035, 0.22, M.brass, -3.17, y, z, undefined, 0.015);
      }
    }
    for (const dz of [-1, 1]) for (const dx of [-0.5, 0.5]) t.cyl(0.045, 0.035, 0.26, M.trim, -3.8 + dx, -1.58, -3.3 + dz);
    t.box(0.1, 0.012, 0.75, M.trim, -3.55, -0.855, -3.7).rotation.y = 0.5;
    for (const [x, z, a] of [[-3.45, -2.9, 0.35], [-3.4, -2.75, -0.15]]) t.cyl(0.012, 0.012, 0.34, M.yellow, x, -0.855, z).rotation.set(Math.PI / 2, 0, a);
    for (const a of [-0.22, 0.22]) t.cyl(0.006, 0.012, 0.4, M.brass, -4.0, -0.855, -2.95 + a * 0.35).rotation.set(Math.PI / 2, 0, a);
    t.cyl(0.14, 0.16, 0.04, M.rubber, -4.35, -0.85, -4.25);
    t.pipe([[-4.35, -0.85, -4.25], [-4.38, -0.35, -4.18], [-4.1, -0.15, -3.85]], 0.018, M.trim);
    t.turned([[0.17, 0], [0.12, 0.1], [0.04, 0.15], [0, 0.16]], M.brass, -4.05, -0.27, -3.8).rotation.set(0.25, 0, -0.25);
    t.ball(0.05, M.light, -4.02, -0.25, -3.77);
  }

  // the captain's chairs: footing, gas strut, foot ring, shaped seat, back, head rest and arms
  for (const [chairX, z] of room.chairs) {
    const c = ibKit(k.group(chairX + 2.6, 0, 0)); // a chair is drawn at x = -2.6 and moved to chairX
    c.turned([[0, 0], [0.42, 0], [0.4, 0.05], [0.14, 0.09], [0.11, 0.12]], M.trim, -2.6, -1.69, z);
    c.cyl(0.085, 0.11, 0.78, M.trim, -2.6, -1.22, z);
    c.ring(0.3, 0.025, M.trim, -2.6, -1.35, z).rotation.x = Math.PI / 2;
    for (let i = 0; i < 4; i++) c.box(0.58, 0.02, 0.025, M.trim, -2.6, -1.35, z).rotation.y = (i * Math.PI) / 4;
    c.soft(0.86, 0.14, 0.82, M.seat, -2.6, -0.8, z, undefined, 0.06);
    c.soft(0.68, 0.13, 0.62, M.cushion, -2.54, -0.7, z, undefined, 0.055);
    const rest = c.group(-2.98, -0.72, z);
    rest.rotation.z = 0.14;
    c.soft(0.18, 1.0, 0.8, M.seat, 0, 0.52, 0, rest, 0.08);
    c.soft(0.12, 0.7, 0.5, M.cushion, 0.1, 0.46, 0, rest, 0.055);
    for (const s of [-1, 1]) c.soft(0.18, 0.75, 0.14, M.seat, 0.08, 0.48, s * 0.34, rest, 0.065);
    for (const s of [-1, 1]) c.cyl(0.018, 0.018, 0.2, M.trim, 0, 1.08, s * 0.13, rest, 8);
    c.soft(0.17, 0.24, 0.46, M.cushion, 0.03, 1.27, 0, rest, 0.08);
    for (const s of [-1, 1]) {
      c.pipe([[-2.9, -0.62, z + s * 0.47], [-2.55, -0.6, z + s * 0.49], [-2.5, -0.5, z + s * 0.49]], 0.025, M.trim);
      c.soft(0.62, 0.08, 0.14, M.seat, -2.58, -0.47, z + s * 0.49, undefined, 0.035);
    }
  }

  if (hi) {
    // glass in the window openings (it mirrors the sky), and small things that make it a workplace
    k.box(0.02, 2.2, half * 2, M.glass, 4.06, 0.6, 0);
    for (const side of [-1, 1]) k.box(len, 2.2, 0.02, M.glass, midX, 0.6, side * (half + 0.08));
    // a mug on the hood
    const mug = -Math.min(2.7, half - 0.5);
    k.cyl(0.058, 0.05, 0.12, M.white, 3.55, -0.2, mug);
    k.cyl(0.048, 0.048, 0.005, M.wood, 3.55, -0.138, mug);
    k.ring(0.032, 0.01, M.white, 3.55, -0.2, mug + 0.065).rotation.y = Math.PI / 2;
    // binoculars on the hood
    const glasses = Math.min(2.75, half - 0.45);
    for (const z of [-0.055, 0.055]) {
      k.cyl(0.036, 0.05, 0.2, M.rubber, 3.55, -0.205, glasses + z).rotation.z = Math.PI / 2;
      k.cyl(0.04, 0.04, 0.01, M.blue, 3.655, -0.205, glasses + z).rotation.z = Math.PI / 2;
    }
    k.box(0.07, 0.035, 0.08, M.rubber, 3.54, -0.18, glasses);
    if (half > 4) {
      const t = ibKit(k.group(0, 0, chartZ));
      // log book and a shelf of binders
      t.soft(0.5, 0.07, 0.38, M.red, -3.85, -0.83, -2.4, undefined, 0.02);
      t.box(0.46, 0.04, 0.39, M.white, -3.83, -0.83, -2.4);
      t.soft(0.34, 0.05, 1.8, M.wood, -4.74, -0.15, -3.4, undefined, 0.02);
      for (let i = 0; i < 11; i++) {
        const z = -4.15 + i * 0.145;
        t.soft(0.26, 0.4 + (i % 3) * 0.03, 0.12, [M.red, M.blue, M.green, M.white][(i * 3) % 4], -4.75, 0.09 + (i % 3) * 0.015, z, undefined, 0.012);
        t.box(0.005, 0.1, 0.07, M.white, -4.615, 0.14, z);
      }
      // fire extinguisher with valve, hose and bracket
      k.turned([[0, 0], [0.14, 0.02], [0.14, 0.66], [0.1, 0.74], [0.045, 0.78], [0.045, 0.84]], M.red, -4.72, -1.45, -0.9);
      k.box(0.14, 0.04, 0.05, M.rubber, -4.68, -0.57, -0.9);
      k.pipe([[-4.72, -0.62, -0.86], [-4.62, -0.75, -0.72], [-4.64, -1.15, -0.74]], 0.022, M.rubber);
      for (const y of [-1.25, -0.85]) k.ring(0.145, 0.014, M.trim, -4.72, y, -0.9).rotation.x = Math.PI / 2;
      // life jackets on hooks
      for (const z of [0.4, 1.15]) {
        for (const s of [-1, 1]) k.soft(0.16, 0.72, 0.24, M.orange, -4.8, -0.6, z + s * 0.14, undefined, 0.07);
        k.soft(0.14, 0.2, 0.4, M.orange, -4.82, -0.18, z, undefined, 0.06);
        k.box(0.02, 0.05, 0.54, M.rubber, -4.71, -0.7, z);
        k.box(0.02, 0.08, 0.5, M.trim, -4.715, -0.44, z);
        k.cyl(0.02, 0.02, 0.12, M.trim, -4.86, -0.02, z).rotation.z = Math.PI / 2;
      }
    }
    // lifebuoy with its bands
    const buoy = back + 1.4;
    k.ring(0.42, 0.13, M.orange, buoy, 0.2, half - 0.2);
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + 0.78;
      k.ring(0.135, 0.022, M.white, buoy + Math.cos(a) * 0.42, 0.2 + Math.sin(a) * 0.42, half - 0.2).rotation.set(Math.PI / 2, 0, a, "ZXY");
    }
    // ceiling vents, speakers and an air duct
    for (const z of mirrored([Math.min(2.55, half - 0.55)])) {
      for (const x of [-1.3, -0.3]) for (let i = 0; i < 3; i++) k.ring(0.06 + i * 0.065, 0.014, M.trim, x, 1.57, z).rotation.x = Math.PI / 2;
    }
    for (const z of mirrored([Math.min(3, half - 0.4)])) {
      k.soft(0.32, 0.34, 0.32, M.console, back + 1.6, 1.42, z, undefined, 0.08);
      for (let i = 0; i < 4; i++) k.box(0.01, 0.02, 0.22, M.rubber, back + 1.765, 1.34 + i * 0.055, z);
    }
    k.pipe([[back + 0.3, 1.45, 0.3 - half], [back + 0.3, 1.45, half - 0.3]], 0.07, M.paint);
    // (No sun shadows inside: on a rolling ship the shadow map shimmered and made the room jitter.)
  }
  return { helm, wind };
}

// The carrack is navigated as in the 16th century: besides the whipstaff and the binnacle compass
// (openHelm), a half-hour sand glass, the ship's bell that strikes it, a traverse board pegged with
// the courses steered, and a portolan chart with brass dividers.
let navTex = null;

function navigatorsTextures() {
  if (navTex) return navTex;
  const rose = (g, x, y, r, colour) => {
    g.strokeStyle = colour;
    for (let i = 0; i < 32; i++) {
      const a = (i * Math.PI) / 16;
      g.lineWidth = i % 4 === 0 ? 2.5 : 1;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.sin(a) * r, y - Math.cos(a) * r);
      g.stroke();
    }
  };
  navTex = {
    chart: ibCanvas(512, 464, (g, w, h) => {
      g.fillStyle = "#d9c391";
      g.fillRect(0, 0, w, h);
      ibSpeckle(g, w, h, 1500, 0.07);
      // rhumb lines from two compass roses, then the coasts
      rose(g, 150, 180, 420, "rgba(90,50,20,0.35)");
      rose(g, 380, 320, 300, "rgba(130,30,20,0.3)");
      g.fillStyle = "#b99a63";
      g.strokeStyle = "#4a3014";
      g.lineWidth = 3;
      for (const coast of [[[0, 0], [250, 0], [215, 55], [140, 60], [120, 120], [55, 135], [0, 200]], [[512, 464], [180, 464], [235, 405], [330, 420], [385, 365], [455, 372], [512, 300]], [[300, 170], [345, 150], [372, 190], [330, 215]]]) {
        g.beginPath();
        coast.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.closePath();
        g.fill();
        g.stroke();
      }
      g.fillStyle = "#6e1c12";
      g.font = "italic bold 24px serif";
      g.fillText("Melita", 292, 245);
      g.fillText("Sicilia", 60, 45);
      g.fillText("Barbaria", 270, 446);
    }),
    traverse: ibCanvas(256, 256, (g, w, h) => {
      g.fillStyle = "#5a3a1e";
      g.fillRect(0, 0, w, h);
      ibSpeckle(g, w, h, 500, 0.12);
      rose(g, 128, 128, 120, "#d8b46a");
      g.fillStyle = "#120a04";
      for (let i = 0; i < 32; i++) {
        const a = (i * Math.PI) / 16;
        for (let ring = 1; ring <= 8; ring++) g.fillRect(126 + Math.sin(a) * ring * 14, 126 - Math.cos(a) * ring * 14, 4, 4);
      }
    })
  };
  return navTex;
}

function navigatorsTools(k, M) {
  const tex = navigatorsTextures();
  const chart = mat(0xffffff, { map: tex.chart, roughness: 0.9, side: THREE.DoubleSide });
  const board = mat(0xffffff, { map: tex.traverse, roughness: 0.7, side: THREE.DoubleSide });
  // the sand glass in its frame, on a turned stand beside the binnacle
  k.turned([[0.16, 0], [0.07, 0.08], [0.05, 0.7], [0.12, 0.76]], M.wood, 2.75, -1.74, 0.8);
  for (const y of [-0.96, -0.52]) k.cyl(0.14, 0.14, 0.04, M.wood, 2.75, y, 0.8);
  for (let i = 0; i < 3; i++) k.cyl(0.012, 0.012, 0.44, M.brass, 2.75 + Math.cos(i * 2.094) * 0.115, -0.74, 0.8 + Math.sin(i * 2.094) * 0.115);
  k.cyl(0.015, 0.09, 0.2, M.glass, 2.75, -0.84, 0.8);
  k.cyl(0.09, 0.015, 0.2, M.glass, 2.75, -0.64, 0.8);
  k.cyl(0.005, 0.075, 0.09, M.sand, 2.75, -0.895, 0.8);
  k.cyl(0.05, 0.012, 0.05, M.sand, 2.75, -0.7, 0.8);
  // the traverse board on its stand, tipped towards the helmsman, with the pegs of this watch
  k.turned([[0.15, 0], [0.06, 0.08], [0.045, 0.75]], M.wood, 3.05, -1.74, 1.55);
  const peg = k.group(3.0, -0.78, 1.55);
  peg.rotation.z = -0.4;
  k.cyl(0.34, 0.34, 0.05, M.wood, 0.03, 0, 0, peg, 24).rotation.z = Math.PI / 2;
  k.add(new THREE.CircleGeometry(0.31, 32).rotateY(-Math.PI / 2), board, 0.001, 0, 0, peg);
  for (let i = 0; i < 6; i++) {
    const a = 1.2 + i * 0.17;
    const r = 0.04 + i * 0.045;
    k.cyl(0.009, 0.009, 0.07, M.brass, -0.03, Math.cos(a) * r, Math.sin(a) * r, peg, 8).rotation.z = Math.PI / 2;
  }
  // the chart table: the portolan chart, a pair of dividers and a weight on it
  k.soft(0.76, 0.06, 0.7, M.wood, 2.85, -1.1, 2.3, undefined, 0.02);
  for (const x of [2.55, 3.15]) for (const z of [2.04, 2.56]) k.cyl(0.03, 0.025, 0.62, M.wood, x, -1.43, z);
  k.flat(0.62, 0.68, chart, 2.85, -1.066, 2.3);
  for (const side of [-1, 1]) k.cyl(0.004, 0.011, 0.28, M.brass, 2.82, -1.05, 2.3 + side * 0.04).rotation.set(Math.PI / 2 + side * 0.28, 0, 0);
  k.cyl(0.045, 0.055, 0.05, M.brass, 3.08, -1.04, 2.06);
  // the ship's bell in its frame
  for (const z of [-2.0, -1.4]) k.soft(0.09, 1.3, 0.09, M.wood, 3.45, -1.09, z, undefined, 0.02);
  k.soft(0.12, 0.1, 0.76, M.wood, 3.45, -0.42, -1.7, undefined, 0.03);
  k.cyl(0.015, 0.015, 0.12, M.brass, 3.45, -0.52, -1.7);
  k.turned([[0.22, 0], [0.19, 0.04], [0.14, 0.12], [0.12, 0.25], [0.08, 0.31], [0, 0.33]], M.brass, 3.45, -0.9, -1.7);
  // the bell's lanyard, hanging in a lazy curve with a knot at its end
  const lanyard = new THREE.CatmullRomCurve3([[3.45, -0.88, -1.7], [3.42, -1.0, -1.69], [3.37, -1.1, -1.65], [3.355, -1.19, -1.635], [3.37, -1.26, -1.64]].map((p) => new THREE.Vector3(...p)));
  k.add(ropeGeometry([{ curve: lanyard, r: 0.013, sides: 9 }]), M.cord);
  k.ball(0.028, M.cord, 3.37, -1.27, -1.64);
}

// The 1943 wheelhouse about the wheel: painted steel walls, wood-framed windows, brass engine
// order telegraph and voice pipe, instruments of the day and a chart table. No screens.
function wartimeWheelhouse(k, M, hi, { half, back }) {
  M.helmet = mat(0x4d5740, { roughness: 0.85, emissive: 0x0c0e0a });
  M.shipClock = mat(0xffffff, { map: shipClockFace(), roughness: 0.4 });
  const front = 4;
  const len = front - back;
  const midX = (front + back) / 2;
  const sill = -0.31;
  const head = 0.98;
  // planked floor, ceiling on its beams, caged lamps
  k.box(len + 0.2, 0.12, half * 2 + 0.2, M.planks, midX, -1.8, 0);
  k.box(len + 0.2, 0.1, half * 2 + 0.2, M.paint, midX, 1.66, 0);
  for (let x = back + 0.9; x < front - 0.5; x += 1.5) k.box(0.14, 0.12, half * 2, M.wood, x, 1.55, 0);
  for (const x of [-0.9, 2.1]) {
    for (const z of [-1.5, 1.5]) {
      k.cyl(0.13, 0.13, 0.05, M.brass, x, 1.46, z);
      k.ball(0.09, M.light, x, 1.37, z);
      for (const turn of [0, Math.PI / 2]) k.ring(0.11, 0.008, M.brass, x, 1.37, z).rotation.y = turn;
    }
  }
  // front wall: panelled below the sill, five windows in teak frames, the header above
  k.box(0.16, sill + 1.74, half * 2, M.paint, front, (sill - 1.74) / 2, 0);
  k.box(0.2, 1.62 - head, half * 2, M.paint, front, (1.62 + head) / 2, 0);
  const wide = (half * 2) / 5;
  for (let i = 0; i <= 5; i++) k.soft(0.2, head - sill, 0.13, M.wood, front - 0.02, (head + sill) / 2, -half + i * wide, undefined, 0.03);
  for (let i = 0; i < 5; i++) {
    const z = -half + (i + 0.5) * wide;
    k.surround(wide - 0.14, head - sill - 0.02, 0.07, M.wood, front - 0.06, (head + sill) / 2, z);
    k.ball(0.03, M.brass, front - 0.12, sill + 0.14, z); // the catch
  }
  k.soft(0.7, 0.08, half * 2 - 0.1, M.wood, 3.68, sill, 0, undefined, 0.025);
  k.pipe([[3.3, -0.6, -half + 0.2], [3.3, -0.6, half - 0.2]], 0.03, M.brass); // hand rail
  for (let z = -half + 0.4; z < half; z += 1.35) k.box(0.55, 0.03, 0.05, M.brass, 3.6, -0.6, z);
  // side walls with their windows; panelled doors to the bridge wings aft
  const posts = [back + 1.9, 0.55, 2.3, front];
  for (const side of [-1, 1]) {
    const z = side * half;
    k.box(len, sill + 1.74, 0.16, M.paint, midX, (sill - 1.74) / 2, z);
    k.box(len, 1.62 - head, 0.18, M.paint, midX, (1.62 + head) / 2, z);
    for (const x of posts) k.soft(0.14, head - sill, 0.2, M.wood, x, (head + sill) / 2, z, undefined, 0.03);
    for (let i = 0; i < posts.length - 1; i++) {
      k.surround(posts[i + 1] - posts[i] - 0.14, head - sill - 0.02, 0.07, M.wood, (posts[i] + posts[i + 1]) / 2, (head + sill) / 2, side * (half - 0.06), true);
    }
    k.soft(len, 0.07, 0.24, M.wood, midX, sill, side * (half - 0.1), undefined, 0.025);
    const door = back + 0.95;
    k.box(1.9, head - sill, 0.14, M.paint, door, (head + sill) / 2, z);
    k.soft(1.75, 2.62, 0.08, M.wood, door, -0.42, side * (half - 0.06), undefined, 0.03);
    for (const y of [-1.2, -0.35]) k.soft(1.35, 0.62, 0.05, M.wood, door, y, side * (half - 0.11), undefined, 0.03);
    k.ring(0.28, 0.05, M.brass, door, 0.45, side * (half - 0.11));
    k.add(new THREE.CircleGeometry(0.26, 24).rotateY(side > 0 ? Math.PI : 0), M.glass, door, 0.45, side * (half - 0.11));
    k.ball(0.055, M.brass, door + 0.65, -0.5, side * (half - 0.15));
  }
  // back wall, the chart table with its chart and rulers, helmets and the clock
  k.box(0.16, 3.4, half * 2 + 0.16, M.paint, back - 0.06, -0.05, 0);
  k.soft(1, 0.09, 2.3, M.wood, back + 0.55, -0.82, -1.2, undefined, 0.03);
  k.soft(0.86, 0.5, 2.2, M.wood, back + 0.5, -1.12, -1.2, undefined, 0.025);
  for (const z of [-1.9, -1.2, -0.5]) k.soft(0.05, 0.05, 0.24, M.brass, back + 0.95, -1.12, z, undefined, 0.015);
  k.flat(1.7, 0.85, M.chartTable, back + 0.55, -0.77, -1.2);
  k.box(0.08, 0.012, 0.8, M.brass, back + 0.7, -0.755, -1.5).rotation.y = 0.45;
  for (const z of [0.5, 1.2, 1.9]) {
    k.add(new THREE.SphereGeometry(0.23, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.helmet, back + 0.24, 0.25, z).rotation.z = -Math.PI / 2;
    k.ring(0.25, 0.022, M.helmet, back + 0.24, 0.25, z).rotation.y = Math.PI / 2;
  }
  const aft = ibKit(k.group(back + 0.06, 0, 0));
  aft.add(new THREE.CircleGeometry(0.24, 28).rotateY(Math.PI / 2), M.shipClock, 0.03, 0.9, -1.2);
  aft.add(new THREE.TorusGeometry(0.26, 0.04, 8, 28).rotateY(Math.PI / 2), M.brass, 0.03, 0.9, -1.2);
  // the instruments over the windows: shaft revolutions, rudder angle, inclinometer, clock
  [M.rpmDial, M.rudderDial, M.tiltDial, M.shipClock].forEach((face, i) => k.dial(0.16, face, M.brass, 3.85, 1.28, [-2.35, -1.35, 1.35, 2.35][i]));
  // the engine order telegraph: a pedestal, the dial drum and its handle
  k.turned([[0.2, 0], [0.09, 0.1], [0.08, 0.95], [0.13, 1.0]], M.brass, 2.5, -1.74, 1.45);
  k.dial(0.24, mat(0xffffff, { map: telegraphFace(), roughness: 0.4 }), M.brass, 2.5, -0.52, 1.45);
  k.pipe([[2.42, -0.52, 1.45], [2.34, -0.2, 1.62]], 0.025, M.brass);
  k.ball(0.055, M.wood, 2.34, -0.18, 1.63);
  // the voice pipe to the captain's cabin
  k.pipe([[2.9, -1.74, -1.4], [2.9, -0.82, -1.4], [2.72, -0.66, -1.4]], 0.085, M.brass);
  k.turned([[0.08, 0], [0.085, 0.09], [0.13, 0.17], [0.14, 0.19]], M.brass, 2.75, -0.69, -1.4).rotation.z = 0.85;
  k.add(new THREE.CircleGeometry(0.11, 20).rotateX(-Math.PI / 2), M.rubber, 2.607, -0.563, -1.4).rotation.z = 0.85; // its open mouth
  k.add(new THREE.TorusGeometry(0.125, 0.018, 8, 24).rotateX(Math.PI / 2), M.brass, 2.607, -0.563, -1.4).rotation.z = 0.85;
  if (!hi) return;
  // glass in the windows, binoculars and a mug on the sill, the signal bell, a lifebuoy
  k.box(0.02, head - sill, half * 2, M.glass, front + 0.06, (head + sill) / 2, 0);
  for (const side of [-1, 1]) k.box(front - posts[0], head - sill, 0.02, M.glass, (front + posts[0]) / 2, (head + sill) / 2, side * (half + 0.05));
  for (const z of [-0.055, 0.055]) k.cyl(0.036, 0.05, 0.2, M.rubber, 3.55, sill + 0.09, 2.2 + z).rotation.z = Math.PI / 2;
  k.cyl(0.058, 0.05, 0.12, M.white, 3.55, sill + 0.1, -2.1);
  k.turned([[0.19, 0], [0.16, 0.04], [0.12, 0.1], [0.1, 0.22], [0.07, 0.27], [0, 0.29]], M.brass, 3.2, 0.9, -2.75);
  k.cyl(0.015, 0.015, 0.4, M.brass, 3.2, 1.38, -2.75);
  k.ring(0.34, 0.1, M.orange, back + 0.16, -0.35, 1.2).rotation.y = Math.PI / 2;
}

// A bulkhead ship's clock: cream face, Roman numerals.
function shipClockFace() {
  return ibCanvas(256, 256, (g, w, h) => {
    g.fillStyle = "#efe6cf";
    g.fillRect(0, 0, w, h);
    g.translate(w / 2, h / 2);
    g.fillStyle = g.strokeStyle = "#1c140c";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = "bold 26px serif";
    ["XII", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI"].forEach((n, i) => {
      const a = (i * Math.PI) / 6;
      g.fillText(n, Math.sin(a) * 94, -Math.cos(a) * 94);
    });
    g.lineCap = "round";
    for (const [a, len, wide] of [[-1.05, 52, 9], [1.05, 76, 5]]) {
      g.lineWidth = wide;
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(Math.sin(a) * len, -Math.cos(a) * len);
      g.stroke();
    }
  });
}

// The face of an engine order telegraph: the orders round the dial, STOP at the top.
function telegraphFace() {
  return ibCanvas(256, 256, (g, w, h) => {
    g.fillStyle = "#efe6cf";
    g.fillRect(0, 0, w, h);
    g.translate(w / 2, h / 2);
    g.strokeStyle = g.fillStyle = "#1c140c";
    g.textAlign = "center";
    g.font = "bold 22px serif";
    [["STOP", 0], ["SLOW", 1], ["HALF", 2], ["FULL", 3], ["SLOW", -1], ["HALF", -2], ["FULL", -3]].forEach(([order, at]) => {
      g.save();
      g.rotate(at * 0.78);
      g.fillText(order, 0, -90);
      g.fillRect(-1, -80, 2, 22);
      g.restore();
    });
    g.fillText("ASTERN", -50, 62);
    g.fillText("AHEAD", 50, 62);
    g.fillRect(-2, -66, 4, 70);
    g.fillRect(-1, 24, 2, 90);
  });
}

// The sailing boat's and the galleon's open helm: planked deck, turned rails and the fittings.
// The wartime tanker's wheelhouse (`room`) has the same wheel and binnacle, within its walls.
function openHelm(k, M, hi, pirate, room) {
  let helm; // the part that follows the rudder
  if (!pirate) {
    helm = k.group(2.1, -0.5, 0);
    helm.scale.setScalar(1.3);
    k.ring(0.5, 0.045, M.wood, 0, 0, 0, helm).rotation.y = Math.PI / 2;
    k.ring(0.36, 0.018, M.brass, 0, 0, 0, helm).rotation.y = Math.PI / 2;
    for (let i = 0; i < 8; i++) {
      const spoke = k.group(0, 0, 0, helm);
      spoke.rotation.x = (i * Math.PI) / 4;
      k.turned([[0.022, 0.06], [0.036, 0.14], [0.018, 0.22], [0.026, 0.45], [0.016, 0.54], [0.034, 0.6], [0.03, 0.66], [0, 0.68]], M.wood, 0, 0, 0, spoke);
    }
    k.cyl(0.1, 0.1, 0.12, M.brass, 0, 0, 0, helm).rotation.z = Math.PI / 2;
    k.ball(0.05, M.brass, -0.08, 0, 0, helm);
    k.turned([[0.3, 0], [0.26, 0.08], [0.13, 0.16], [0.11, 0.9], [0.18, 1.05], [0.15, 1.2], [0.08, 1.3]], M.wood, 2.28, -1.74, 0);
    if (room) {
      helm.scale.setScalar(1.05); // a little smaller and lower, clear of the windows
      helm.position.y = -0.68;
    }
  } else {
    // a whipstaff: a tall lever swung from side to side
    helm = k.group(2.1, -1.7, 0);
    k.turned([[0.1, 0], [0.085, 0.4], [0.062, 2.2], [0.09, 2.34], [0.07, 2.5], [0, 2.54]], M.wood, 0, 0, 0, helm);
    for (const y of [0.5, 1.9, 2.22]) k.ring(0.085 - y * 0.008, 0.016, M.brass, 0, y, 0, helm).rotation.x = Math.PI / 2;
    // the serving wound round its grip
    const grip = new THREE.CatmullRomCurve3(Array.from({ length: 73 }, (_, i) => new THREE.Vector3(Math.cos((i * Math.PI) / 4) * 0.07, 1.97 + i * 0.0032, Math.sin((i * Math.PI) / 4) * 0.07)));
    k.add(ropeGeometry([{ curve: grip, r: 0.013, sides: 9 }]), M.cord, 0, 0, 0, helm);
    k.soft(0.6, 0.3, 0.8, M.wood, 2.1, -1.6, 0, undefined, 0.05);
  }
  // binnacle: a turned stand, a compass card under a brass guard, and its two iron spheres
  k.turned([[0.34, 0], [0.34, 0.1], [0.22, 0.2], [0.2, 0.62], [0.3, 0.74], [0.3, 0.86]], M.wood, 3.1, -1.74, 0);
  k.ring(0.28, 0.035, M.brass, 3.1, -0.87, 0).rotation.x = Math.PI / 2;
  k.add(new THREE.CircleGeometry(0.27, 28).rotateX(-Math.PI / 2).rotateY(-Math.PI / 2), M.compass, 3.1, -0.865, 0);
  k.pipe([[3.1, -0.87, -0.28], [3.1, -0.62, -0.18], [3.1, -0.56, 0], [3.1, -0.62, 0.18], [3.1, -0.87, 0.28]], 0.018, M.brass);
  for (const z of [-0.37, 0.37]) {
    k.ball(0.08, M.brass, 3.1, -0.98, z);
    k.ball(0.035, M.amber, 3.04, -0.87, z * 0.8);
  }
  if (room) {
    wartimeWheelhouse(k, M, hi, room);
    return { helm };
  }
  // deck (the galleon's; the sailing boat's cockpit stands on her own deck) and rails
  if (pirate) k.box(8, 0.12, 6, M.planks, -0.5, -1.8, 0);
  for (const side of [-1, 1]) {
    k.soft(8, 0.1, 0.16, M.wood, -0.5, -0.9, side * 3.2, undefined, 0.045);
    k.soft(8, 0.14, 0.2, M.wood, -0.5, -1.68, side * 3.2, undefined, 0.04);
    for (let x = -4.4; x <= 3.4; x += 0.52) {
      k.turned([[0.055, 0], [0.04, 0.1], [0.085, 0.28], [0.032, 0.52], [0.045, 0.66], [0.035, 0.74]], pirate ? M.wood : M.white, x, -1.65, side * 3.2);
    }
    // cleats and coiled rope
    for (const x of [-2.2, 1.4]) {
      k.pipe([[x - 0.2, -1.48, side * 2.9], [x - 0.08, -1.55, side * 2.9], [x + 0.08, -1.55, side * 2.9], [x + 0.2, -1.48, side * 2.9]], 0.03, M.brass);
      k.cyl(0.035, 0.05, 0.2, M.brass, x, -1.65, side * 2.9);
      k.add(ropeGeometry([{ curve: ropeCoil(x + 0.6, -1.74, side * 2.65, 0.34, 0.035, 4.5, x * side), r: 0.035, sides: 9 }]), M.cord);
    }
  }
  if (!hi) return { helm };
  if (pirate) {
    // barrels, a lantern on a post and a chest
    for (const [x, z] of [[2.9, -2.5], [2.2, -2.62], [-3.2, 2.45]]) {
      k.turned([[0, 0], [0.26, 0], [0.33, 0.2], [0.35, 0.4], [0.33, 0.6], [0.26, 0.8], [0, 0.8]], M.wood, x, -1.74, z);
      for (const [y, r] of [[0.1, 0.3], [0.28, 0.345], [0.52, 0.345], [0.7, 0.3]]) k.ring(r, 0.018, M.rubber, x, -1.74 + y, z).rotation.x = Math.PI / 2;
    }
    k.turned([[0.07, 0], [0.05, 1.5]], M.wood, 2.6, -1.74, 2.7);
    k.cyl(0.13, 0.13, 0.24, M.amber, 2.6, -0.12, 2.7, undefined, 6);
    for (let i = 0; i < 6; i++) k.box(0.02, 0.28, 0.02, M.rubber, 2.6 + Math.cos(i * 1.047) * 0.135, -0.12, 2.7 + Math.sin(i * 1.047) * 0.135);
    k.turned([[0.18, 0], [0.12, 0.08], [0, 0.17]], M.brass, 2.6, 0, 2.7);
    k.soft(0.7, 0.45, 1.0, M.wood, -3.4, -1.5, -2.2, undefined, 0.1);
    for (const z of [-2.55, -1.85]) k.soft(0.73, 0.48, 0.07, M.brass, -3.4, -1.5, z, undefined, 0.03);
  } else {
    // winches with their handles, an instrument pod and a lifebuoy
    for (const z of [-2.3, 2.3]) {
      k.turned([[0.24, 0], [0.24, 0.06], [0.15, 0.1], [0.12, 0.28], [0.18, 0.34], [0.18, 0.4], [0, 0.42]], M.trim, 0.2, -1.74, z);
      k.box(0.4, 0.035, 0.06, M.rubber, 0.36, -1.3, z).rotation.y = 0.5;
      k.cyl(0.035, 0.035, 0.14, M.rubber, 0.53, -1.24, z - 0.1);
    }
    k.soft(0.22, 0.34, 0.9, M.white, 3.0, -0.85, 1.55, undefined, 0.09);
    for (const [z, face] of [[1.32, M.rpmDial], [1.78, M.tiltDial]]) k.dial(0.12, face, M.trim, 2.87, -0.84, z);
    k.cyl(0.05, 0.07, 0.8, M.trim, 3.0, -1.38, 1.55);
    k.ring(0.34, 0.1, M.orange, -0.8, -1.2, -3.08);
  }
  return { helm };
}

function bridgeInterior(kind) {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.scale.setScalar(INTERIOR_SIZE[kind] || 1);
  g.add(inner);
  const open = OPEN_HELM.has(kind);
  const nav = createNavInstruments(bridgeHigh(), !open && kind !== "WarTanker"); // no radar screens in 1943
  const M = bridgeMats(nav);
  if (!M.radar) delete M.radar; // an open helm has no radar
  if (!M.chart) delete M.chart; // nor an electronic chart
  const k = ibKit(inner);
  const parts = open ? openHelm(k, M, bridgeHigh(), kind !== "Sailing")
    : kind === "WarTanker" ? openHelm(k, M, bridgeHigh(), false, bridgeRoom(kind))
    : enclosedBridge(k, M, bridgeHigh(), bridgeRoom(kind));
  if (kind === "Carrack") navigatorsTools(k, M);
  mergeStaticMeshes(inner, new Set([parts.helm]));
  mergeStaticMeshes(parts.helm, new Set());
  const alarm = bridgeAlarm(M, open); // added after merging: it is shown and hidden as one
  inner.add(alarm.group);
  nav.wind = parts.wind || null;
  return { group: g, helm: parts.helm, mats: M, nav, alarm };
}

// How far you are from the bridge's navigation screen, per player: 0 = inside the bridge
// (the room is shown, the camera stands back a little), 1 = at the window view, as before.
// It glides (see updateBridgeBlend) when game.js bridgeFocus is switched with the button.
const bridgeBlend = { p1: 0, p2: 0 };
const BRIDGE_BLEND_TIME = 1.6; // seconds for the glide
const BRIDGE_ROOF_CAM = [0.5, 3.2]; // the camera above the top of the bridge (world units from the eye: forward, up)
// The open helm's own camera places: standing behind the wheel (`aside`: moved towards the centre
// line so the wheel is in the picture), and above and behind the cockpit.
const SAIL_VIEW = { stand: [-0.6, 0.8], aside: -0.55, above: [-3.5, 2.4], lookIn: -0.27, lookOut: -0.32 };

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

function fitBridge(o) {
  const room = bridgeInterior(o.bridgeKind);
  o.interior.add(room.group);
  o.interiorHelm = room.helm;
  o.interiorMats = room.mats;
  o.interiorNav = room.nav;
  o.alarm = room.alarm;
}

// Interior fades out as the view glides to the window view.
function setInteriorFade(o, fade) {
  if (!o.interior) return; // the open helm is part of the ship itself
  if (fade > 0.01 && !o.interiorMats) fitBridge(o);
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
  const { model, mats, candle, wheel, airWing, station, oars } = buildShipModel(ship);
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
    oars, // the galley's oars (poseOars)
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
    sinkAge: 0, // seconds since she capsized
    seed: Math.random() * 10
  };
  o.navLights = buildNavLights(o, ship.type === "pirate" ? "Pirate" : ship.category);
  if (ship.category === "Cruise" && cruiseModel && !ship.plain && ship.type !== "pirate") useCruiseModel(o, ship);
  if (THRUSTER_SHIPS.includes(ship.category) && ship.type !== "pirate") addSteeringGear(o);
  // Where a tow rope is made fast (model space): the tug's towing hook, the
  // bow of any other ship, on its deck (led nearer midships where there is no
  // deck on the centre line, as between a catamaran's bows).
  const s = o.model.scale.x;
  const bowY = shipSurfaceY(o, hullBox.max.x * 0.85, 0) ?? 5;
  let hookX = hullBox.max.x * 0.92;
  while (hookX > 1 && shipSurfaceY(o, hookX, 0) === null) hookX *= 0.9;
  const hookY = Math.min(bowY, shipSurfaceY(o, hookX, 0) ?? bowY) + 0.3;
  o.ropeAt = TOW_HOOK[o.category] ? new THREE.Vector3(...TOW_HOOK[o.category]) : new THREE.Vector3(hookX / s, hookY / s, 0);
  const bridgeKind = ship.type === "pirate" ? "Pirate" : ship.category || "Cruise";
  o.bridgeKind = bridgeKind;
  o.interiorMats = null;
  o.interiorFade = -1;
  o.interiorClash = [];
  o.clashHidden = false;
  if (ship.category === "Tug" && tugModel && !ship.plain) useTugModel(o);
  if (station) {
    // her open helm is already part of the model: nothing separate to show or hide
    o.station = true;
    o.interiorMats = station.mats;
    o.interiorNav = station.nav;
    o.alarm = station.alarm;
    return o;
  }
  // The bridge interior (added last, so it does not change the ship's measured size) sits at the captain's eye, in world-sized units.
  const interior = new THREE.Group(); // filled by fitBridge the first time somebody looks inside
  const [ex, ey, ez] = BRIDGE_EYE[bridgeKind] || BRIDGE_EYE.Cruise;
  interior.position.set(ex, ey, ez);
  interior.scale.setScalar(1 / model.scale.x);
  interior.visible = false;
  model.add(interior);
  o.interior = interior;
  // The ship's own outside parts that reach into the bridge room (window glass, wheelhouse walls,
  // masts...) would hang in front of the camera, so they are hidden while you are inside. Parts
  // that stay under the floor (hull, decks, the blocks the bridge stands on) are left alone.
  root.updateMatrixWorld(true);
  const sz = INTERIOR_SIZE[bridgeKind] || 1;
  const { half, back } = bridgeRoom(bridgeKind);
  const room = new THREE.Box3(new THREE.Vector3(back, -1.5, -half).multiplyScalar(sz), new THREE.Vector3(4.1, 1.6, half).multiplyScalar(sz));
  const toRoom = interior.matrixWorld.clone().invert();
  const part = new THREE.Box3();
  model.traverse((c) => {
    if (!c.isMesh || c.userData.rigging) return;
    for (let up = c; up; up = up.parent) if (up === interior) return;
    if (part.setFromObject(c).applyMatrix4(toRoom).intersectsBox(room)) o.interiorClash.push(c);
  });
  return o;
}

// The tug's towing hook and the tankers' hose manifolds (model units; the
// manifold is on both sides, the hose takes the one facing the quay).
const TOW_HOOK = { Tug: [-11.2, 4.5, 0], Galley: [-21, 4, 0] };
const MANIFOLD = { Tanker: [1, 6.6, 7.2], GasTanker: [1.5, 6.5, 7.2], WarTanker: [10.2, 4.8, 4.4] };

// Navigation lights, shown at night: red to port, green to starboard, a
// white masthead light forward and a white stern light. Glowing sprites (no
// real lights, so the light count, and the shaders, never change).
const MAST_X = { Sailing: 3, Catamaran: 3, Pirate: 7, Galley: -4, WarTanker: 6.2 };

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
  // The carrack is far older than navigation lights: only the candles inside her show.
  if (category === "Carrack") {
    const none = new THREE.Group();
    none.userData.mast = [];
    o.model.add(none);
    return none;
  }
  o.root.updateMatrixWorld(true);
  const box3 = new THREE.Box3().setFromObject(o.model);
  const s = o.model.scale.x;
  const deck = (x, z) => (shipSurfaceY(o, x, z) ?? box3.max.y * 0.4) + 1.6;
  const g = new THREE.Group();
  const sideX = box3.max.x * 0.15;
  // The galley's yards reach far past her sides, so her lanterns go by the hull.
  const wide = category === "Galley" ? 4.8 * s : box3.max.z;
  navLight(g, 0xff2a1a, sideX, deck(sideX, -wide * 0.6), -wide * 0.98);
  navLight(g, 0x2aff5a, sideX, deck(sideX, wide * 0.6), wide * 0.98);
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
const CARRACK_CANDLE_SPOT = new THREE.Vector3(-16, 9 + CARRACK_LIFT, 0); // below the quarterdeck, in the great cabin

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
  // Long, low and light: quick to the sea, steadied by the oars.
  Galley: { roll: [4.5, 0.35], pitch: [3, 0.45], heave: [2.5, 0.5], yaw: [5, 0.6], windHeel: 0.03 },
  // Tall castles and a round belly: a slow, deep roll.
  Carrack: { roll: [8, 0.17], pitch: [3.5, 0.4], heave: [3, 0.45], yaw: [6, 0.5], windHeel: 0.13 },
  // Round-bottomed so it rides up on the ice: rolls a lot in open water.
  Icebreaker: { roll: [8, 0.15], pitch: [3.5, 0.45], heave: [3, 0.5], yaw: [7, 0.6], windHeel: 0.02 },
  Tanker: { roll: [12, 0.25], pitch: [4.5, 0.5], heave: [3.2, 0.55], yaw: [9, 0.6], windHeel: 0.01 },
  GasTanker: { roll: [12, 0.25], pitch: [4.5, 0.5], heave: [3.2, 0.55], yaw: [9, 0.6], windHeel: 0.025 },
  WarTanker: { roll: [10, 0.2], pitch: [4, 0.45], heave: [3, 0.5], yaw: [8, 0.6], windHeel: 0.015 }
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
  // (a ship under the pirate's cannon shot stays as she was until the ball arrives)
  const pending = shotPending(ship);
  const down = ship.capsized && !pending;
  o.capsize += ((down ? 1 : 0) - o.capsize) * Math.min(1, dt * 1.6);
  // Sinking: once she is over on her side the wreck floods and goes down
  // stern first until the whole hull is under water (a few seconds).
  // Back afloat at once when the ship is restored (next crossing).
  o.sink += ((o.capsize > 0.9 ? 1 : 0) - o.sink) * Math.min(1, dt * (down ? 0.25 : 3));
  o.sinkAge = down ? o.sinkAge + dt : 0;

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
  // Foil-borne, the foils ride under the waves; made fast, the lines hold her.
  const steady = (1 - 0.7 * o.lift) * (1 - 0.6 * (ship.berth ? ship.ropes || 0 : 0));

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
  // Going down in a whirlpool's throat. A wreck under water no longer rides the waves.
  p.y = o.heave * (1 - o.sink) - (ship.whirlSink || 0) * 14;

  // Over on her side, then right over (keel up) as she goes down.
  o.tilt.rotation.x = o.roll + o.capsize * 1.9 + o.sink * 1.2;
  o.tilt.rotation.z = o.pitch + o.sink * 0.25; // bow lifts as the stern goes down
  o.tilt.position.y = -o.capsize * 5 - o.sink * (o.top + 6);
  // Over the waterfall: she is swept into the cave, tips bow first and drops into the dark.
  if (ship.overFalls !== undefined && game.mission?.falls) {
    const f = game.mission.falls;
    const since = game.elapsed - ship.overFalls;
    const out = Math.min(95, since * 45);
    const drop = Math.max(0, since - 0.9);
    p.x += f.dx * out;
    p.z += f.dy * out;
    p.y = -Math.min(PIT_DEPTH + 20, drop * drop * 22);
    o.root.rotation.y = -Math.atan2(f.dy, f.dx);
    o.tilt.rotation.set(drop * 0.4, 0, -Math.min(1.3, drop * 0.8));
    o.tilt.position.y = 0;
  }

  // The sailing boat's wheel and the carrack's whipstaff follow the rudder (game.js helmStep): steer to
  // port and the wheel turns anticlockwise, the top of the whipstaff swings to port (+x rotation: starboard).
  if (o.wheel) o.wheel.rotation.x = (ship.helm ? ship.helm.rudder : 0) * (o.category === "Carrack" || o.category === "Galley" ? 0.5 : WHEEL_HARD_OVER);
  if (o.oars) {
    const way = Math.abs(ship.speed || 0) > 2 && !ship.anchored && !ship.capsized;
    o.oars.work = (o.oars.work || 0) + ((way ? 1 : 0) - (o.oars.work || 0)) * Math.min(1, dt * 2);
    // A long, slow stroke at easy speeds, quicker as she is driven.
    if (way) o.oars.phase += dt * clamp(1.2 + Math.abs(ship.speed) * 0.035, 1.2, 3.1) * Math.sign(ship.speed);
    poseOars(o.oars, o.oars.phase, o.oars.work);
  }

  if (!pending || game.cannonCinematic.targetBurning) updateShipFire(ship, o, dt);

  o.navLights.visible = night.on && o.capsize < 0.4;
  // Standing on your own bridge the masthead light sits right in front of
  // your eyes and its glow fills the view, so it is hidden there.
  const onOwnBridge = !game.cannonCinematic && game.settings.cameraView === "bridge" && cameraFocus().inWorld &&
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
  if (o.station) {
    // the open helm's binnacle compass is in sight from every camera
    if (ship.isHuman) updateNavInstruments(o.interiorNav, ship, t);
    setBridgeAlarm(o, fadeNow > 0.01 && inCapsizeDanger(ship), t);
  } else if (o.interior.visible) {
    const rudder = ship.helm ? ship.helm.rudder : 0;
    // the whipstaff and the joystick lean with the rudder; the wartime tanker's wheel turns
    o.interiorHelm.rotation.x = o.category === "WarTanker" ? rudder * WHEEL_HARD_OVER : -rudder * 0.5;
    updateNavInstruments(o.interiorNav, ship, t);
    setBridgeAlarm(o, inCapsizeDanger(ship), t);
  }
  if (o.candle) {
    // A candle: a slow waver plus quick little licks of the flame.
    o.flicker += (Math.random() - o.flicker) * Math.min(1, dt * 14);
    const f = 0.72 + 0.12 * Math.sin(t * 7.3 + o.seed) + 0.08 * Math.sin(t * 19.1 + o.seed * 3) + 0.22 * (o.flicker - 0.5);
    const lit = night.on && !ship.capsized;
    o.candle.emissiveIntensity = lit ? 3.2 * f : 0;
    if (lit && candleLight.intensity === 0) {
      o.model.localToWorld(candleLight.position.copy(o.category === "Carrack" ? CARRACK_CANDLE_SPOT : CANDLE_SPOT));
      candleLight.intensity = 60 * f;
    }
  }

  // (frozen at its brightest while the cannon shot plays, so left out there)
  const flash = game.cannonCinematic ? 0 : clamp((ship.hitFlash || 0) * 5, 0, 1);
  // Burning: the hull chars black, and the fire throws a flickering orange
  // glow on it.
  const burn = ship.burn || 0;
  if (o.rudders) turnSteeringGear(ship, o, dt);
  if (o.glow) o.glow.emissiveIntensity = night.on && !ship.capsized ? 2.6 : 0;
  const glow = ship.fire ? (0.05 + 0.035 * ship.fire.intensity) * (0.7 + 0.3 * Math.sin(t * 17 + o.seed)) : 0;
  for (const m of o.mats) {
    m.color.copy(m.userData.baseColor).lerp(charColor, burn * 0.95);
    m.emissive.copy(m.userData.baseEmissive).lerp(fireGlowColor, glow).lerp(flashColor, flash);
  }
}

// The cannon shot's jet of flame (a ship's own fire is drawn further below):
// rising, wavering noise shaped into a tongue, on two crossed upright planes.
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

// A burning ship, drawn with the pictures tools/fire_sheet.py makes: flames
// from a fluid simulation (64 frames that loop; grey = temperature, coloured
// here) and smoke billows lit from above. Each stands facing whichever camera
// is looking, including both halves of the split screen. More flames light as
// the fire spreads; smoke and sparks rise and drift downwind.
const FIRE_FLAMES = 18;
const FIRE_SMOKE = 26;
const FIRE_EMBERS = 30;
const fireSheet = new THREE.TextureLoader().load("assets/effects/fire.jpg");
const smokeSheet = new THREE.TextureLoader().load("assets/effects/smoke.jpg");

const SHIP_FLAME_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 origin = modelMatrix[3].xyz;
  float w = length(modelMatrix[0].xyz);
  float h = length(modelMatrix[1].xyz);
  vec3 toEye = normalize(cameraPosition - origin);
  // upright, leaning to the camera's own "up" when it looks down from above
  vec3 eyeUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 up = normalize(mix(vec3(0.0, 1.0, 0.0), eyeUp, smoothstep(0.55, 0.95, toEye.y)));
  vec3 right = normalize(cross(up, toEye));
  // the burning bed is a little above the picture's bottom edge
  vec3 world = origin + right * (position.x * w) + up * ((position.y - 0.07) * h) + toEye * (w * 0.2);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;
const SHIP_FLAME_FRAGMENT = `
uniform sampler2D sheet;
uniform float time;
uniform float seed;
uniform float strength;
varying vec2 vUv;
float heatAt(float frame, vec2 uv) {
  vec2 cell = vec2(mod(frame, 8.0), floor(frame / 8.0));
  return texture2D(sheet, vec2((cell.x + uv.x) / 8.0, 1.0 - (cell.y + 1.0 - uv.y) / 8.0)).r;
}
void main() {
  vec2 uv = clamp(vUv, 0.004, 0.996);
  if (fract(seed * 7.31) > 0.5) uv.x = 1.0 - uv.x; // half of them mirrored
  float at = mod((time + seed) * (21.0 + fract(seed * 3.7) * 8.0), 64.0);
  float frame = floor(at);
  float t = mix(heatAt(frame, uv), heatAt(mod(frame + 1.0, 64.0), uv), at - frame);
  t = min(1.0, t * 1.1) * strength;
  float body = smoothstep(0.035, 0.36, t);
  vec3 col = mix(vec3(0.14, 0.01, 0.0), vec3(0.85, 0.11, 0.003), smoothstep(0.07, 0.3, t));
  col = mix(col, vec3(1.0, 0.36, 0.015), smoothstep(0.28, 0.54, t));
  col = mix(col, vec3(1.0, 0.68, 0.14), smoothstep(0.55, 0.8, t));
  col = mix(col, vec3(1.0, 0.92, 0.62), smoothstep(0.82, 1.0, t));
  col *= 1.0 + 2.4 * smoothstep(0.3, 0.95, t); // brighter than white where hottest, so it glows
  // its own light, hiding some of what is behind it
  gl_FragColor = vec4(col * body, body * 0.78);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const SMOKE_VERTEX = `
uniform float spin;
varying vec2 vUv;
varying float vDown;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  float c = cos(spin);
  float s = sin(spin);
  vec2 p = mat2(c, s, -s, c) * position.xy;
  vDown = clamp(0.5 - p.y, 0.0, 1.0);
  vec4 mvPosition = viewMatrix * vec4(modelMatrix[3].xyz, 1.0);
  mvPosition.xy += p * length(modelMatrix[0].xyz);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const SMOKE_FRAGMENT = `
uniform sampler2D sheet;
uniform vec3 colour;
uniform vec3 underlight;
uniform float opacity;
uniform float variant;
varying vec2 vUv;
varying float vDown;
#include <fog_pars_fragment>
void main() {
  vec2 cell = vec2(mod(variant, 2.0), floor(variant / 2.0));
  vec2 puff = texture2D(sheet, (cell + clamp(vUv, 0.01, 0.99)) * 0.5).rg; // thickness, light
  vec3 col = colour * (0.3 + 1.6 * puff.g) + underlight * vDown * vDown * (1.0 - 0.5 * puff.g);
  gl_FragColor = vec4(col, smoothstep(0.03, 0.8, puff.r) * opacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

function makeShipFlame() {
  const flame = new THREE.Mesh(flameGeo, new THREE.ShaderMaterial({
    vertexShader: SHIP_FLAME_VERTEX,
    fragmentShader: SHIP_FLAME_FRAGMENT,
    uniforms: { sheet: { value: fireSheet }, time: { value: 0 }, seed: { value: Math.random() * 10 }, strength: { value: 1 } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor
  }));
  flame.renderOrder = 5;
  return flame;
}

const smokeGeo = shared(new THREE.PlaneGeometry(1, 1));
function makeSmokePuff() {
  const puff = new THREE.Mesh(smokeGeo, new THREE.ShaderMaterial({
    vertexShader: SMOKE_VERTEX,
    fragmentShader: SMOKE_FRAGMENT,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      sheet: { value: smokeSheet }, spin: { value: 0 }, opacity: { value: 0 }, variant: { value: Math.floor(Math.random() * 4) },
      colour: { value: new THREE.Color() }, underlight: { value: new THREE.Color() }
    },
    fog: true,
    transparent: true,
    depthWrite: false
  }));
  puff.renderOrder = 4;
  return puff;
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
    const f = makeShipFlame();
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
    const w = 6.5 + Math.random() * 4.5;
    f.userData = { dx: along, dz: across, y: (y ?? 6) - 0.3, w, h: w * (1.5 + Math.random() * 0.6) };
    f.visible = false;
    fire.add(f);
    fire.flames.push(f);
  }
  for (let i = 0; i < FIRE_SMOKE; i++) {
    const sm = makeSmokePuff();
    sm.userData = { phase: i / FIRE_SMOKE, dx: (Math.random() - 0.5) * 18, dz: (Math.random() - 0.5) * 7, spin: Math.random() * 6.3, turn: (Math.random() - 0.5) * 0.5, size: 0.8 + Math.random() * 0.45 };
    fire.add(sm);
    fire.smoke.push(sm);
  }
  for (let i = 0; i < FIRE_EMBERS; i++) {
    const e = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSoft, color: 0xffa040, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    e.userData = { phase: Math.random(), dx: (Math.random() - 0.5) * 28, dz: (Math.random() - 0.5) * 9, drift: (Math.random() - 0.5) * 16, rise: 26 + Math.random() * 34 };
    e.material.color.multiplyScalar(2.5);
    fire.add(e);
    fire.embers.push(e);
  }
  o.root.add(fire);
  return fire;
}

const SMOKE_OLD = new THREE.Color().setRGB(0.19, 0.175, 0.165);
const SMOKE_STEAM = new THREE.Color().setRGB(0.42, 0.43, 0.45);

function updateShipFire(ship, o, dt) {
  if (ship.fire && !o.fire) o.fire = buildShipFire(o);
  if (!o.fire) return;
  const burning = !!ship.fire && (!ship.capsized || (!!ship.burnsWhileSinking && o.sink < 0.3));
  o.fire.visible = burning;
  if (burning) {
    const t = clock.t;
    const k = ship.fire.intensity; // 1 .. 4
    const lit = Math.min(FIRE_FLAMES, Math.round(4 + (k - 1) * 4.7));
    // Smoke drifts downwind; the fire group turns with the ship, so the wind
    // is turned into the ship's own frame.
    const ca = Math.cos(o.yaw);
    const sa = Math.sin(o.yaw);
    const windX = game.wind.x * ca + game.wind.y * sa;
    const windZ = -game.wind.x * sa + game.wind.y * ca;
    const grow = 0.85 + k * 0.12;
    const wet = !!ship.fire.inRain;
    const day = night.on ? 0.22 : 1; // smoke is only as bright as the light on it
    o.fire.flames.forEach((f, i) => {
      f.visible = i < lit;
      if (!f.visible) return;
      const u = f.userData;
      f.material.uniforms.time.value = t;
      f.material.uniforms.strength.value = wet ? 0.74 : 1;
      f.position.set(u.dx, u.y, u.dz);
      const flick = 0.93 + 0.07 * Math.sin(t * 5.3 + i * 2.1);
      f.scale.set(u.w * grow, u.h * grow * flick, u.w * grow);
    });
    for (const sm of o.fire.smoke) {
      const u = sm.userData;
      const life = (t * 0.15 + u.phase) % 1;
      const sway = Math.sin(life * 6 + u.phase * 19) * 4 * life;
      sm.position.set(u.dx * (1 - life) + windX * life * life * 3.2 + sway, 9 + Math.pow(life, 0.85) * (62 + k * 16), u.dz * (1 - life) + windZ * life * life * 3.2);
      sm.scale.setScalar((7 + Math.pow(life, 0.7) * 34) * u.size * (0.75 + k * 0.13));
      const uni = sm.material.uniforms;
      uni.spin.value = u.spin + t * u.turn;
      uni.opacity.value = Math.min(1, life * 8) * Math.pow(1 - life, 1.2) * (0.62 + k * 0.1);
      // black and oily at the fire, thinning to brown-grey; rain mixes steam in
      uni.colour.value.setRGB(0.028, 0.023, 0.02).lerp(wet ? SMOKE_STEAM : SMOKE_OLD, wet ? 0.35 + life * 0.65 : life).multiplyScalar(day);
      uni.underlight.value.setRGB(1.5, 0.42, 0.05).multiplyScalar(Math.max(0, 1 - life * 4.5) * (wet ? 0.5 : 1));
    }
    o.fire.embers.forEach((e, i) => {
      const u = e.userData;
      const life = (t * 0.55 + u.phase) % 1;
      const swirl = Math.sin(life * 11 + u.phase * 31) * 2.4 * life;
      e.position.set(u.dx + u.drift * life + windX * life * 0.5 + swirl, 7 + life * u.rise, u.dz + windZ * life * 0.5 + swirl * 0.6);
      e.scale.setScalar(0.45 + 0.45 * (1 - life));
      e.material.opacity = (1 - life) * Math.min(1, k / 2) * (0.65 + 0.35 * Math.sin(t * 23 + i * 5));
    });
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
  if (game.harbourShip) return [game.harbourShip];
  const list = game.galley ? [game.galley.boat] : [];
  if (game.player1) list.push(game.player1);
  if (mode === "local" && game.player2) list.push(game.player2);
  if (piratesAbout()) {
    if (game.ai) list.push(game.ai);
    list.push(...game.pirateRaiders);
  }
  return list;
}

const shipObjects = new Map();

// ---- Wakes ------------------------------------------------------------------
// A moving ship leaves white water: it breaks at the bow, runs along the hull
// and spreads out astern, fading. One flat strip per ship, laid on the waves
// along the path the bow has taken.
const WAKE_POINTS = 30;
const WAKE_LIFE = 5.2; // seconds until the foam is gone
const WAKE_STEP = 0.18; // seconds between the points left behind
const wakeGroup = new THREE.Group();
scene.add(wakeGroup);
const wakes = new Map(); // ship object -> { mesh, trail, since }
let wakeMat = null; // one for every wake (foamTexture is made further down)

function createWake() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(WAKE_POINTS * 3 * 3), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(WAKE_POINTS * 3 * 4), 4));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(WAKE_POINTS * 3 * 2), 2));
  const normals = new Float32Array(WAKE_POINTS * 3 * 3);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  const index = [];
  for (let i = 0; i < WAKE_POINTS - 1; i++) {
    for (let k = 0; k < 2; k++) {
      const a = i * 3 + k;
      index.push(a, a + 3, a + 1, a + 1, a + 3, a + 4);
    }
  }
  geo.setIndex(index);
  wakeMat ||= new THREE.MeshStandardMaterial({ map: foamTexture, vertexColors: true, transparent: true, depthWrite: false, roughness: 1, side: THREE.DoubleSide });
  const m = new THREE.Mesh(geo, wakeMat);
  m.frustumCulled = false;
  wakeGroup.add(m);
  return { mesh: m, trail: [], since: 0 };
}

// The trail's first point rides at the bow; the others are left behind it and
// stay where they are, so the foam lies still in the water as the ship goes.
// `mark` is how far the bow had travelled when it passed that point.
function layWake(ship, o, w, pace, dt) {
  // from the ship's course, not the drawn hull: its sway would make the wake wriggle
  const reach = o.halfLen * 1.12 * (ship.speed < 0 ? -1 : 1);
  const x = ship.x - HALF_W + Math.cos(o.yaw) * reach;
  const z = ship.y - HALF_H + Math.sin(o.yaw) * reach;
  // a new wake, also for a ship put somewhere else (a new crossing)
  if (!w.trail.length || Math.hypot(w.trail[0].x - x, w.trail[0].z - z) > 80) {
    const start = { x, z, age: 0, pace, mark: 0 };
    w.trail = [start, { ...start }];
  }
  for (const point of w.trail) point.age += dt;
  const head = w.trail[0];
  head.mark += Math.hypot(x - head.x, z - head.z);
  Object.assign(head, { x, z, age: 0, pace });
  w.since += dt;
  if (w.since >= WAKE_STEP) {
    w.since = 0;
    w.trail.splice(1, 0, { ...head });
    if (w.trail.length > WAKE_POINTS) w.trail.pop();
  }
  while (w.trail.length > 2 && w.trail[w.trail.length - 1].age > WAKE_LIFE) w.trail.pop();
}

function shapeWake(o, w) {
  const { position, color, uv } = w.mesh.geometry.attributes;
  const last = w.trail.length - 1;
  const head = w.trail[0];
  for (let i = 0; i < WAKE_POINTS; i++) {
    const j = Math.min(i, last);
    const point = w.trail[j];
    let dx = j ? w.trail[j - 1].x - w.trail[Math.min(last, j + 1)].x : 0;
    let dz = j ? w.trail[j - 1].z - w.trail[Math.min(last, j + 1)].z : 0;
    const len = Math.hypot(dx, dz);
    // at the bow, and where the points lie on top of each other, the ship's heading
    if (len < 0.5) {
      dx = Math.cos(o.yaw);
      dz = Math.sin(o.yaw);
    } else {
      dx /= len;
      dz /= len;
    }
    // narrow at the bow, as wide as the hull a third of the way along, then spreading
    const wide = o.halfBeam * (0.25 + 1.15 * smoothstep(0, o.halfLen * 1.4, head.mark - point.mark)) + point.age * (1.8 + 2.8 * point.pace);
    const fade = i > last ? 0 : point.pace * Math.pow(Math.max(0, 1 - point.age / WAKE_LIFE), 1.6);
    const y = seaHeight(point.x, point.z) + 0.7; // one wave height across: the sea is costly to ask
    for (let k = 0; k < 3; k++) {
      const side = k - 1;
      const n = i * 3 + k;
      position.setXYZ(n, point.x - dz * wide * side, y, point.z + dx * wide * side);
      // the two arms of the wake are brightest; the churned middle fades sooner
      color.setXYZW(n, 1, 1, 1, fade * (side ? 0.75 : 0.5));
      uv.setXY(n, point.mark / 38, k / 2);
    }
  }
  position.needsUpdate = color.needsUpdate = uv.needsUpdate = true;
}

// ---- Propeller wash, bow spray and thruster jets ------------------------
// What the screws, rudders and side thrusters do to the water. Foam patches lie
// on the waves where they were thrown and spread out and fade; drops fly.
//  - the screws churn a stream astern, harder with speed and throttle, bent to
//    whichever side the rudder is over (two streams from twin screws);
//  - at speed the bow throws spray to both sides;
//  - side thrusters blast water out of the side they push away from;
//  - in a hard turn the stern skids and leaves foam along the outer side.
const WASH_PATCHES = 1500;
const WASH_DROPS = 900;
const SAIL_ONLY = new Set(["Sailing", "Pirate", "Carrack", "Galley"]); // no screws
let wash = null;

function washPicture() {
  const size = 128;
  const canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
  const g = canvas.getContext("2d");
  const picture = g.createImageData(size, size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i / (size - 1)) * 2 - 1;
      const y = (j / (size - 1)) * 2 - 1;
      // a ragged patch of bubbles and lace
      const edge = 1 - Math.hypot(x, y) - (fbm2(x * 3 + 7, y * 3, 91, 3) - 0.5) * 1.3;
      const lace = 1 - Math.abs(2 * fbm2(x * 5, y * 5 + 3, 17, 4) - 1);
      const fine = 1 - Math.abs(2 * fbm2(x * 12 + 4, y * 12, 5, 3) - 1);
      const a = smoothstep(0, 0.75, edge) * clamp(1.5 * lace ** 4 + 0.9 * fine ** 5 - 0.04, 0, 1);
      picture.data.set([255, 255, 255, a * 255], (j * size + i) * 4);
    }
  }
  g.putImageData(picture, 0, 0);
  return new THREE.CanvasTexture(canvas);
}

function createWash() {
  const geo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  const alpha = new THREE.InstancedBufferAttribute(new Float32Array(WASH_PATCHES), 1);
  geo.setAttribute("alpha", alpha);
  const material = new THREE.ShaderMaterial({
    vertexShader: `
      attribute float alpha;
      varying vec2 vUv;
      varying float vAlpha;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vAlpha = alpha;
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform sampler2D foam;
      uniform float light;
      varying vec2 vUv;
      varying float vAlpha;
      #include <fog_pars_fragment>
      void main() {
        gl_FragColor = vec4(vec3(1.15, 1.35, 1.5) * light, texture2D(foam, vUv).a * vAlpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), foam: { value: washPicture() }, light: { value: 1 } },
    fog: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
  });
  const patches = new THREE.InstancedMesh(geo, material, WASH_PATCHES);
  patches.frustumCulled = false;
  patches.renderOrder = 1;
  const nowhere = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < WASH_PATCHES; i++) patches.setMatrixAt(i, nowhere);
  const dropGeo = new THREE.BufferGeometry();
  dropGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(WASH_DROPS * 3).fill(-500), 3));
  const drops = new THREE.Points(dropGeo, new THREE.PointsMaterial({ map: dotTex, color: 0xeef6ff, size: 1.1, transparent: true, opacity: 0.9, depthWrite: false }));
  drops.frustumCulled = false;
  wakeGroup.add(patches, drops);
  return {
    patches, alpha, drops, next: 0, drop: 0, owed: new WeakMap(),
    foam: Array.from({ length: WASH_PATCHES }, () => ({ age: 9, life: 1, x: 0, z: 0, vx: 0, vz: 0, from: 1, to: 2, turn: 0, strength: 0 })),
    spray: Array.from({ length: WASH_DROPS }, () => ({ on: false, vx: 0, vy: 0, vz: 0 }))
  };
}

function addFoam(x, z, vx, vz, from, to, life, strength) {
  const f = wash.foam[(wash.next = (wash.next + 1) % WASH_PATCHES)];
  Object.assign(f, { age: 0, life, x, z, vx, vz, from, to, turn: Math.atan2(-vz, vx) + (Math.random() - 0.5) * 0.5, long: 1.35 + Math.random() * 0.8, strength });
}

function addDrop(x, y, z, vx, vy, vz) {
  const i = (wash.drop = (wash.drop + 1) % WASH_DROPS);
  Object.assign(wash.spray[i], { on: true, vx, vy, vz });
  wash.drops.geometry.attributes.position.setXYZ(i, x, y, z);
}

// This ship's share of the foam for one frame.
function churn(ship, o, dt) {
  if (ship.capsized) return;
  const speed = ship.speed || 0;
  const frac = Math.min(1, Math.abs(speed) / (ship.maxSpeed || 220));
  const throttle = ship.throttle ?? (frac > 0.1 ? 1 : 0);
  const rudder = ship.helm ? ship.helm.rudder : 0;
  const yaw = ship.helm ? ship.helm.yaw : 0;
  const fx = Math.cos(o.yaw);
  const fz = Math.sin(o.yaw);
  const ox = ship.x - HALF_W;
  const oz = ship.y - HALF_H;
  const long = o.halfLen * 1.18; // from amidships to the ends
  const wide = o.halfBeam;
  const size = clamp(wide / 9, 0.55, 1.7);
  // a point on the ship: `ahead` towards the bow, `right` to starboard
  const at = (ahead, right) => [ox + fx * ahead - fz * right, oz + fz * ahead + fx * right];
  const times = (rate) => Math.floor(rate * dt + Math.random());
  const some = (spread) => (Math.random() - 0.5) * spread;
  const category = ship.type === "pirate" ? "Pirate" : ship.category;

  // the screws: twin screws and twin rudders on the large ships, catamaran and tug
  if (!SAIL_ONLY.has(category)) {
    const power = Math.max(Math.abs(throttle) * 0.55, frac);
    if (power > 0.04) {
      const twin = THRUSTER_SHIPS.includes(category) || category === "Catamaran" || category === "Tug";
      const astern = throttle < 0 || (throttle === 0 && speed < 0);
      // the stream leaves straight astern, swung towards the side the rudder is over
      const swing = astern ? rudder * 0.15 : rudder * 0.75;
      const dirX = (astern ? 1 : -1) * (fx * Math.cos(swing)) - fz * Math.sin(swing);
      const dirZ = (astern ? 1 : -1) * (fz * Math.cos(swing)) + fx * Math.sin(swing);
      const push = 10 + 34 * Math.abs(throttle) + 22 * Math.abs(rudder);
      for (const side of twin ? [-1, 1] : [0]) {
        const [x, z] = at(-long, side * wide * 0.5);
        for (let n = times((twin ? 55 : 80) * (0.2 + power)); n > 0; n--) {
          const v = push * (0.4 + Math.random() * 0.9);
          addFoam(x + some(3 * size), z + some(3 * size), dirX * v + some(9), dirZ * v + some(9), 1.1 * size, (2.8 + 3.2 * power + Math.random() * 2) * size, 0.9 + 1.9 * power, 0.45 + 0.5 * power);
        }
        for (let n = times(30 * Math.max(0, power - 0.55)); n > 0; n--) addDrop(x, 1, z, dirX * push * 0.7 + some(10), 5 + Math.random() * 9 * power, dirZ * push * 0.7 + some(10));
      }
    }
  }
  // spray off the bow, from about half speed
  const bow = Math.max(0, frac - 0.4) / 0.6;
  if (bow > 0 && speed > 0) {
    for (const side of [-1, 1]) {
      for (let n = times(110 * bow * size); n > 0; n--) {
        const back = Math.random() * long * 0.25;
        const [x, z] = at(long * 0.96 - back, side * wide * (0.12 + back / long * 1.6));
        const out = (5 + Math.random() * 16) * (0.5 + bow);
        const along = speed * (0.35 + Math.random() * 0.4);
        addDrop(x, 0.8, z, fx * along - fz * out * side, 4 + Math.random() * (6 + 16 * bow), fz * along + fx * out * side);
      }
      for (let n = times(30 * bow); n > 0; n--) {
        const back = Math.random() * long * 0.9;
        const [x, z] = at(long * 0.85 - back, side * wide * (0.55 + Math.min(1, back / long) * 0.55));
        addFoam(x, z, -fz * side * 11 - fx * 8, fx * side * 11 - fz * 8, 0.8 * size, 3.4 * size, 1.2, 0.4 + 0.4 * bow);
      }
    }
  }
  // side thrusters: a boiling jet out of the side opposite the way they push
  if (ship.thrusters) {
    for (const [end, push] of [[0.72, ship.thrusters.bow], [-0.72, ship.thrusters.stern]]) {
      const force = Math.abs(push);
      if (force < 0.06) continue;
      const side = push > 0 ? -1 : 1;
      const [x, z] = at(long * end, side * wide * 1.02);
      for (let n = times(70 * force); n > 0; n--) {
        const v = (14 + Math.random() * 34) * force;
        addFoam(x + some(2), z + some(2), -fz * side * v + some(8), fx * side * v + some(8), 0.8 * size, (2.8 + Math.random() * 2.5) * size, 0.9 + 1.2 * force, 0.5 + 0.4 * force);
      }
      for (let n = times(45 * force); n > 0; n--) {
        const v = (10 + Math.random() * 22) * force;
        addDrop(x, 0.7, z, -fz * side * v + some(4), 2 + Math.random() * 7 * force, fx * side * v + some(4));
      }
    }
  }
  // a hard turn at speed: the stern skids, leaving foam along the outer side
  const skid = Math.abs(yaw) * frac;
  if (skid > 0.12) {
    const outer = yaw > 0 ? -1 : 1;
    for (let n = times(28 * skid); n > 0; n--) {
      const [x, z] = at(-long * (0.2 + Math.random() * 0.8), outer * wide);
      const v = 8 + Math.random() * 12;
      addFoam(x, z, -fz * outer * v, fx * outer * v, 1.3 * size, 5.5 * size, 1.6 + skid, Math.min(0.9, 0.3 + skid));
    }
  }
}

const washPlace = new THREE.Matrix4();
const washSize = new THREE.Vector3();

function updateWash(dt) {
  wash ||= createWash();
  for (const [ship, o] of shipObjects) churn(ship, o, dt);
  wash.patches.material.uniforms.light.value = night.on ? 0.18 : 1;
  wash.drops.material.color.setScalar(night.on ? 0.25 : 1);
  wash.foam.forEach((f, i) => {
    if (f.age >= f.life) return;
    f.age += dt;
    const k = Math.min(1, f.age / f.life);
    const drag = Math.exp(-dt * 1.9);
    f.vx *= drag;
    f.vz *= drag;
    f.x += f.vx * dt;
    f.z += f.vz * dt;
    const size = k < 1 ? f.from + (f.to - f.from) * Math.sqrt(k) : 0;
    washPlace.makeRotationY(f.turn).scale(washSize.set(size * (f.long || 1), 1, size * 0.85)).setPosition(f.x, size ? seaHeight(f.x, f.z) + 0.75 : -50, f.z);
    wash.patches.setMatrixAt(i, washPlace);
    wash.alpha.setX(i, f.strength * (1 - k) ** 1.4 * Math.min(1, k * 12));
  });
  wash.patches.instanceMatrix.needsUpdate = wash.alpha.needsUpdate = true;
  const position = wash.drops.geometry.attributes.position;
  wash.spray.forEach((d, i) => {
    if (!d.on) return;
    d.vy -= 28 * dt;
    const y = position.getY(i) + d.vy * dt;
    if (y < 0 && d.vy < 0) {
      d.on = false;
      position.setY(i, -500);
    } else position.setXYZ(i, position.getX(i) + d.vx * dt, y, position.getZ(i) + d.vz * dt);
  });
  position.needsUpdate = true;
}

// ---- Rudders, screws and thruster openings of the large ships ------------
// Two rudders behind two screws, and a tunnel through the hull for a side
// thruster near the bow and the stern. Under water at sea; seen in the dry
// dock. The rudders follow the helm and the screws turn with the engine.
const bronze = shared(mat(0xb08a3a, { roughness: 0.35, metalness: 0.85 }));
const antifoul = shared(mat(0x6e2019, { roughness: 0.7, metalness: 0.15 }));
const tunnelDark = shared(mat(0x0b0d10, { roughness: 0.9 }));
const sideRay = new THREE.Raycaster();

function addSteeringGear(o) {
  o.root.updateMatrixWorld(true);
  const hull = new THREE.Box3();
  const point = new THREE.Vector3();
  const toModel = o.model.matrixWorld.clone().invert();
  const solids = [];
  o.model.traverse((c) => {
    if (!c.isMesh) return;
    solids.push(c);
    const p = c.geometry.attributes.position;
    const place = new THREE.Matrix4().multiplyMatrices(toModel, c.matrixWorld);
    for (let i = 0; i < p.count; i++) {
      point.fromBufferAttribute(p, i).applyMatrix4(place);
      if (point.y < -1) hull.expandByPoint(point); // the under-water body
    }
  });
  if (hull.isEmpty()) return;
  // half the hull's width under water, `x` along her: a ray in from the side
  const halfWidth = (x, y) => {
    sideRay.set(o.model.localToWorld(new THREE.Vector3(x, y, 60)), new THREE.Vector3(0, 0, -1).transformDirection(o.model.matrixWorld));
    const hit = sideRay.intersectObjects(solids, false)[0];
    return hit ? o.model.worldToLocal(hit.point.clone()).z : null;
  };
  const stern = hull.min.x;
  const deep = Math.min(-2.2, hull.min.y);
  const height = Math.min(3.6, -deep * 0.62); // the overhang above them stays under water
  const apart = Math.max(1.2, (halfWidth(stern + 4, deep * 0.5) || hull.max.z) * 0.5);
  o.rudders = [];
  o.screws = [];
  // the stern overhang the rudders hang from, and a bracket holding each shaft
  const under = deep + 0.35 + height + 0.45;
  o.model.add(box(3.4, 0.7, apart * 2 + 1.6, antifoul, stern - 1.3, under, 0));
  for (const side of [-1, 1]) o.model.add(cylinder(0.11, 0.16, under - (deep + 0.35 + height * 0.46), antifoul, stern + 0.05, (under + deep + 0.35 + height * 0.46) / 2, side * apart, 8));
  for (const side of [-1, 1]) {
    const rudder = new THREE.Group(); // turns about its stock, at its leading edge
    rudder.position.set(stern - 1.7, deep + 0.35 + height / 2, side * apart);
    const blade = mesh(new THREE.CylinderGeometry(0.5, 0.5, height, 14), antifoul);
    blade.scale.set(1.9, 1, 0.32);
    blade.position.x = -0.75;
    rudder.add(blade, cylinder(0.18, 0.18, 1.2, antifoul, 0, height / 2 + 0.4, 0, 10));
    const screw = new THREE.Group();
    screw.position.set(stern - 0.55, deep + 0.35 + height * 0.46, side * apart);
    const hub = mesh(new THREE.CylinderGeometry(0.16, 0.34, 0.8, 14).rotateZ(Math.PI / 2), bronze);
    screw.add(hub);
    for (let i = 0; i < 4; i++) {
      const arm = new THREE.Group();
      arm.rotation.x = (i * Math.PI) / 2;
      const leaf = mesh(new THREE.SphereGeometry(1, 14, 8), bronze);
      leaf.scale.set(0.07, height * 0.23, height * 0.15);
      leaf.position.y = height * 0.25;
      leaf.rotation.y = 0.6; // the blade's pitch
      arm.add(leaf);
      screw.add(arm);
    }
    const shaft = cylinder(0.13, 0.13, 1.6, antifoul, stern + 0.4, screw.position.y, side * apart, 8);
    shaft.rotation.z = Math.PI / 2;
    o.model.add(rudder, screw, shaft);
    o.rudders.push(rudder);
    o.screws.push(screw);
  }
  const radius = Math.min(1.15, -deep * 0.24);
  for (const x of [hull.max.x * 0.72, stern * 0.72]) {
    const y = deep * 0.55;
    const z = halfWidth(x, y);
    if (z === null) continue;
    for (const side of [-1, 1]) {
      const mouth = mesh(new THREE.CircleGeometry(radius, 24), tunnelDark, false);
      mouth.position.set(x, y, side * (z + 0.05));
      if (side < 0) mouth.rotation.y = Math.PI;
      const rim = mesh(new THREE.TorusGeometry(radius, radius * 0.13, 8, 26), antifoul, false);
      rim.position.set(x, y, side * (z + 0.08));
      o.model.add(mouth, rim);
      for (const k of [-0.5, 0, 0.5]) o.model.add(box(0.07, radius * 2 * Math.cos(Math.asin(k)), 0.07, bronze, x + k * radius, y, side * (z + 0.09)));
    }
  }
}

// Helm over: the rudders swing; engine running: the screws turn.
function turnSteeringGear(ship, o, dt) {
  const rudder = ship.helm ? ship.helm.rudder : 0;
  for (const part of o.rudders) part.rotation.y = rudder * 0.6;
  const spin = (ship.throttle || 0) * 14 + ((ship.speed || 0) / 40);
  o.screws.forEach((screw, i) => (screw.rotation.x += spin * dt * (i ? 1 : -1))); // handed screws
}

function updateWakes(dt) {
  const alive = new Set();
  for (const [ship, o] of shipObjects) {
    alive.add(o);
    const pace = ship.capsized ? 0 : clamp((Math.abs(ship.speed || 0) - 12) / 150, 0, 1);
    let w = wakes.get(o);
    if (!w) {
      if (!pace) continue; // a ship that has not moved has no wake
      wakes.set(o, (w = createWake()));
    }
    layWake(ship, o, w, pace, dt);
    w.mesh.visible = w.trail.some((point) => point.pace > 0 && point.age < WAKE_LIFE);
    if (w.mesh.visible) shapeWake(o, w);
  }
  for (const [o, w] of wakes) {
    if (alive.has(o)) continue;
    wakeGroup.remove(w.mesh);
    w.mesh.geometry.dispose();
    wakes.delete(o);
  }
}

// ---------------------------------------------------------------------------
// Islands, volcanoes, icebergs
// ---------------------------------------------------------------------------

const sandMat = shared(mat(0xd8c28a, { roughness: 0.95 }));
const grassMat = shared(mat(0x4d8a38, { roughness: 0.9 }));
const rockMat = shared(mat(0x6a645c, { roughness: 0.95 }));
// Islands and volcanoes are painted point by point (vertex colours): rock,
// scrub, sand and wet shore blend into each other. On a polar run snow
// settles on whatever faces up.
const cragMat = shared(mat(0xffffff, { roughness: 0.93, vertexColors: true }));
const cragSnow = { value: 0 };
cragMat.onBeforeCompile = (shader) => {
  shader.uniforms.snow = cragSnow;
  shader.vertexShader = "varying float vLevel;\nvarying float vHeight;\n" + shader.vertexShader.replace(
    "#include <begin_vertex>",
    "#include <begin_vertex>\n vLevel = normalize( mat3( modelMatrix ) * objectNormal ).y;\n vHeight = ( modelMatrix * vec4( transformed, 1.0 ) ).y;"
  );
  shader.fragmentShader = "uniform float snow;\nvarying float vLevel;\nvarying float vHeight;\n" + shader.fragmentShader.replace(
    "#include <color_fragment>",
    "#include <color_fragment>\n diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.8, 0.85, 0.9 ), snow * smoothstep( 0.4, 0.75, vLevel ) * smoothstep( 1.5, 5.0, vHeight ) );"
  );
};

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
  const rockTex = groundTextures(n, rShade, rHeight, 24, 40);
  detailGround(rockMat, rockTex, 0.9);
  detailGround(cragMat, rockTex, 1.4);
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
    // A mountain: sharp ridges and peaks, with gullies cut between them.
    let ridge = 0;
    if (mountain) {
      const crest = 1 - Math.abs(2 * fbm2(x / (r * 0.34), z / (r * 0.34), seed + 9, 4) - 1);
      const gully = 1 - Math.abs(2 * fbm2(x / (r * 0.13), z / (r * 0.13), seed + 14, 3) - 1);
      ridge = crest * crest * 1.15 + gully * 0.22;
    }
    const crag = (fbm2(x / 7, z / 7, seed + 17, 2) - 0.5) * (mountain ? 7 : 2.5);
    const dome = Math.pow(1 - d * d, 1.4);
    const beach = clamp((1 - d) / 0.12, 0, 1); // rises out of the sea over the beach
    return -3 + 6 * beach + dome * r * peak * (mountain ? 0.15 + 0.75 * roll + ridge : 0.35 + 0.9 * roll) + dome * (7 * fine + crag);
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

const LAND = Object.fromEntries(Object.entries({
  rockLight: 0xb3a38b, rockDark: 0x5f574e, scrubDark: 0x35501f, scrubLight: 0x7d8f37, grass: 0x6fa23c, sand: 0xe3cd9b, wet: 0x3a352d, basalt: 0x55443b, tuff: 0x9a7a61, scorched: 0x8a4a33
}).map(([name, hex]) => [name, new THREE.Color(hex)]));

// The island's ground as one mesh, painted point by point: sand or wet rock at
// the shore, scrub and grass where the ground is gentle enough to hold soil,
// bare rock on cliffs and peaks. `detail` sets how fine the mesh is (the
// quality level's terrain setting). UVs are in world units for the ground
// textures.
function islandTerrain(r, mountain, seed, detail) {
  const shape = islandShape(r, mountain, seed);
  const rings = Math.max(24, Math.round(14 * detail));
  const segments = Math.max(96, Math.round(64 * detail));
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
  for (let j = 0; j < segments; j++) tris.push(0, vi(1, j + 1), vi(1, j));
  for (let i = 1; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      tris.push(vi(i, j), vi(i, j + 1), vi(i + 1, j), vi(i, j + 1), vi(i + 1, j + 1), vi(i + 1, j));
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  const uv = [];
  for (let k = 0; k < pos.length; k += 3) uv.push(pos[k], pos[k + 2]);
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(tris);
  geo.computeVertexNormals();
  const normal = geo.attributes.normal;
  const colors = new Float32Array(pos.length);
  const rock = new THREE.Color();
  const green = new THREE.Color();
  for (let k = 0; k < pos.length / 3; k++) {
    const x = pos[k * 3], y = pos[k * 3 + 1], z = pos[k * 3 + 2];
    const patch = fbm2(x / 9, z / 9, seed + 20, 3);
    const band = fbm2(x / 30 + y / 11, z / 30 - y / 13, seed + 31, 3);
    rock.copy(LAND.rockDark).lerp(LAND.rockLight, smoothstep(0.3, 0.72, band));
    rock.multiplyScalar(0.72 + 0.56 * patch);
    const soil = smoothstep(0.52, 0.8, normal.getY(k) + (patch - 0.5) * 0.9) * (mountain ? 1 - smoothstep(shape.peak * 0.55, shape.peak * 1.25, y) : 1);
    green.copy(LAND.scrubDark).lerp(mountain ? LAND.scrubLight : LAND.grass, smoothstep(0.32, 0.7, fbm2(x / 5, z / 5, seed + 40, 3)));
    rock.lerp(green, soil);
    const jitter = patch - 0.5;
    if (!mountain) rock.lerp(LAND.sand, 1 - smoothstep(2.4, 4.2, y + jitter * 3));
    rock.lerp(LAND.wet, 1 - smoothstep(0.4, mountain ? 3.4 : 1.4, y + jitter * 2));
    colors.set([rock.r, rock.g, rock.b], k * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const ground = mesh(geo, cragMat);
  return { ground, shape };
}

// White water breaking along an island's shore: a ragged ring of foam.
const foamTexture = (() => {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const g = c.getContext("2d");
  const rnd = seeded(515);
  for (let i = 0; i < 1500; i++) {
    const x = rnd() * 256;
    const y = 32 + (rnd() + rnd() + rnd() - 1.5) * 26;
    g.fillStyle = `rgba(255, 255, 255, ${0.12 + rnd() * 0.5 * (1 - Math.abs(y - 32) / 32)})`;
    for (const wrap of [-256, 0, 256]) {
      g.beginPath();
      g.ellipse(x + wrap, y, 1 + rnd() * 5, 0.7 + rnd() * 1.8, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
})();
const surfMat = shared(new THREE.MeshStandardMaterial({ map: foamTexture, transparent: true, depthWrite: false, roughness: 1 }));

function surfRing(shape, r) {
  const segments = 128;
  const pos = [];
  const uv = [];
  const index = [];
  const repeats = Math.max(4, Math.round(r / 12));
  for (let j = 0; j <= segments; j++) {
    const a = (j / segments) * Math.PI * 2;
    const edge = shape.edge(a);
    for (const [k, v] of [[0.865, 0], [1.02, 1]]) {
      pos.push(Math.cos(a) * edge * k, 0, Math.sin(a) * edge * k);
      uv.push((j / segments) * repeats, v);
    }
    if (j < segments) index.push(j * 2, j * 2 + 2, j * 2 + 1, j * 2 + 1, j * 2 + 2, j * 2 + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return onSea(new THREE.Mesh(geo, surfMat), 0.8);
}

// `detail`: how fine the ground mesh is; by default the quality level's
// (set once when the island is made, never during play).
function islandModel(r, mountain = false, detail = QUALITY_LEVELS[perf.level].terrain) {
  const g = new THREE.Group();
  const seed = Math.random() * 100;
  const { ground, shape } = islandTerrain(r, mountain, seed, detail);
  g.add(ground, surfRing(shape, r));
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

// A volcano's flanks: ribs and gullies running down from the crater, bands of
// old lava and ash, a scorched rim and scrub round the foot.
function volcanoCone(r, seed) {
  const geo = new THREE.CylinderGeometry(r * 0.22, r * 1.08, r * 1.25, 96, 30, true);
  const p = geo.attributes.position;
  const uv = geo.attributes.uv;
  const colors = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let k = 0; k < p.count; k++) {
    const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
    const a = Math.atan2(z, x);
    const h = y / (r * 1.25) + 0.5; // 0 at the foot, 1 at the rim
    const ca = Math.cos(a), sa = Math.sin(a);
    const rib = 1 - Math.abs(2 * fbm2(ca * 5 + h * 1.3 + 20, sa * 5 - h * 0.9 + 20, seed, 4) - 1);
    const lumps = fbm2(ca * 9 + h * 8 + 40, sa * 9 + h * 6 + 40, seed + 7, 3) - 0.5;
    const calm = 1 - smoothstep(0.86, 1, h); // the rim stays round for the crater
    const push = 1 + ((rib - 0.62) * 0.26 + lumps * 0.12) * calm;
    p.setXYZ(k, x * push, y + lumps * r * 0.05 * calm, z * push);
    c.copy(LAND.basalt).lerp(LAND.tuff, smoothstep(0.45, 0.9, rib) * (0.4 + 0.6 * fbm2(ca * 3 + h * 6, sa * 3 + 60, seed + 11, 3)));
    c.lerp(LAND.scrubDark, (1 - smoothstep(0.12, 0.42, h + lumps * 0.5)) * smoothstep(0.4, 0.75, rib));
    c.lerp(LAND.scorched, smoothstep(0.8, 0.98, h + lumps * 0.2));
    c.lerp(LAND.wet, 1 - smoothstep(0.0, 0.08, h));
    colors.set([c.r, c.g, c.b], k * 3);
    uv.setXY(k, uv.getX(k) * Math.PI * 2 * r * 0.65, h * r * 1.6); // world units, like the islands
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

function volcanoModel(hz, o) {
  const g = new THREE.Group();
  const r = hz.r;
  const seed = Math.random() * 100;
  const cone = mesh(volcanoCone(r, seed), cragMat);
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

const iceMat = shared(mat(0xffffff, { roughness: 0.6, metalness: 0.02, flatShading: true, vertexColors: true, emissive: 0x0b2a3c, emissiveIntensity: 0.25 }));
const ICE = { snow: new THREE.Color(0xf8fcff), shade: new THREE.Color(0xc4def0), crevice: new THREE.Color(0x5c9fc6), water: new THREE.Color(0x3f93b6) };

// A broken block of ice: sharp ridges and clefts, steep faces, flat below the
// water.
function icebergShape(r, seed) {
  const geo = new THREE.IcosahedronGeometry(r * 0.85, 11);
  const p = geo.attributes.position;
  const colors = new Float32Array(p.count * 3);
  const v = new THREE.Vector3();
  const c = new THREE.Color();
  for (let k = 0; k < p.count; k++) {
    v.fromBufferAttribute(p, k).normalize();
    const big = fbm2(v.x * 1.7 + v.y * 0.9 + 12, v.z * 1.7 - v.y * 0.7 + 12, seed, 3);
    const ridge = 1 - Math.abs(2 * fbm2(v.x * 3.1 - v.y * 2.1 + 30, v.z * 3.1 + v.y * 1.8 + 30, seed + 5, 3) - 1);
    const chip = fbm2(v.x * 9 + v.y * 5 + 50, v.z * 9 - v.y * 4 + 50, seed + 8, 2) - 0.5;
    const peak = Math.max(0, v.y) * Math.pow(fbm2(v.x * 2.1 + 70, v.z * 2.1 + 70, seed + 13, 2), 3) * 0.9; // pinnacles
    const reach = r * 0.85 * (0.55 + 0.5 * big + 0.34 * ridge * ridge * ridge + 0.08 * chip);
    v.multiplyScalar(Math.min(reach, r * 1.2));
    v.y = THREE.MathUtils.clamp(v.y * (0.78 + peak), -r * 0.22, r * (0.72 + chip * 0.5)); // a broken, flattish crown
    p.setXYZ(k, v.x, v.y, v.z);
    c.copy(ICE.crevice).lerp(ICE.shade, smoothstep(0.35, 0.65, ridge)).lerp(ICE.snow, smoothstep(0.62, 0.9, ridge * 0.6 + big * 0.7));
    c.lerp(ICE.water, 1 - smoothstep(-r * 0.08, r * 0.1, v.y));
    colors.set([c.r, c.g, c.b], k * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

function icebergModel(hz) {
  const g = new THREE.Group();
  const r = hz.r;
  const ice = mesh(icebergShape(r, Math.random() * 100), iceMat);
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
  if (hz.kind === "volcano") root.add(volcanoModel(hz, o), surfRing({ edge: () => hz.r * 1.34 }, hz.r));
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

const FAIR_BASE = new THREE.Color(0xa9b3be);

// The clouds move slowly round the sky with the wind.
function driftClouds(dome, dt) {
  dome.material.uniforms.drift.value += dt * (0.00025 + Math.hypot(game.wind.x || 0, game.wind.y || 0) * 0.000008);
}

// ---------------------------------------------------------------------------
// Seagulls: friendly birds over the sea. Most just glide and flap in wide
// circles; the "fishers" now and then fold their wings, dive at the water,
// and climb away again, usually with a fish in their beak.
// ---------------------------------------------------------------------------
const GULLS = 16;
const GULL_FISHERS = 6;
const GULL_SPAN = 1.15; // roam this far (in map halves) before turning back
const gullFishMat = shared(mat(0xc4d2dc, { roughness: 0.3, metalness: 0.4 }));
// the plain shapes the bats (and a caught fish) are made of
const ballGeo = new THREE.SphereGeometry(1, 10, 8);
const batWingGeo = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([0.8, 0, 0, -0.8, 0, 0, -1.4, 0, 3.6, -0.6, 0, 3.6], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
})();

// One gull for the sea and the dockyard, shaped and coloured point by point:
// white head and body, grey back and upper wings, black wingtips with a white
// spot, white trailing edge, yellow bill with its red spot. Each wing has two
// joints (shoulder and wrist), so it beats and folds like a bird's. x is
// forward, +z to the right; the wings span about 10 units before scaling.
const GULL_WHITE = [0.84, 0.84, 0.81];
const GULL_GREY = [0.15, 0.185, 0.235];
const GULL_BLACK = [0.012, 0.012, 0.015];
const GULL_YELLOW = [0.76, 0.43, 0.015];
const GULL_RED = [0.5, 0.02, 0.01];
const GULL_EYE = [0.01, 0.008, 0.006];
const gullMat = shared(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, side: THREE.DoubleSide, emissive: 0x0b0d0f }));

// A sheet of nu by nv squares; point(s, t) gives [x, y, z, colour].
function gullSheet(nu, nv, point) {
  const position = [];
  const colour = [];
  const index = [];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const [x, y, z, c] = point(i / nu, j / nv);
      position.push(x, y, z);
      colour.push(...c);
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      const b = a + nu + 1;
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = shared(new THREE.BufferGeometry());
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colour, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

// A value read off a list of [at, value, value...] rows, eased between them.
function gullProfile(rows, at, column) {
  let i = 1;
  while (i < rows.length - 1 && at > rows[i][0]) i++;
  const k = smoothstep(rows[i - 1][0], rows[i][0], at) * 0.5 + clamp((at - rows[i - 1][0]) / (rows[i][0] - rows[i - 1][0]), 0, 1) * 0.5;
  return rows[i - 1][column] + (rows[i][column] - rows[i - 1][column]) * k;
}

// Body, from tail to the base of the bill: [x, half height, half width, height of the middle]
const GULL_BODY = [[-2.2, 0.07, 0.1, 0.04], [-1.8, 0.24, 0.3, 0.03], [-1.0, 0.38, 0.45, -0.01], [-0.1, 0.46, 0.5, -0.02], [0.7, 0.42, 0.45, 0.03], [1.15, 0.3, 0.3, 0.17], [1.5, 0.29, 0.28, 0.3], [1.85, 0.34, 0.31, 0.37], [2.2, 0.27, 0.25, 0.34], [2.42, 0.13, 0.13, 0.29], [2.5, 0.02, 0.02, 0.28]];
const gullBodyGeo = gullSheet(26, 16, (s, t) => {
  const x = -2.2 + 4.7 * s;
  const a = t * Math.PI * 2;
  const back = Math.sin(a) > 0.5 && x > -1.5 && x < 0.75;
  return [x, gullProfile(GULL_BODY, x, 3) + gullProfile(GULL_BODY, x, 1) * Math.sin(a), gullProfile(GULL_BODY, x, 2) * Math.cos(a), back ? GULL_GREY : GULL_WHITE];
});
const gullBillGeo = gullSheet(10, 8, (s, t) => {
  const x = 2.38 + 0.82 * s;
  const a = t * Math.PI * 2;
  const r = 0.125 * (1 - s) ** 0.55 + 0.012;
  const y = 0.285 - 0.02 * s - 0.1 * s ** 3; // the tip hooks down
  const spot = s > 0.55 && s < 0.82 && Math.sin(a) < -0.35;
  return [x, y + r * Math.sin(a), r * 0.75 * Math.cos(a), spot ? GULL_RED : GULL_YELLOW];
});
const gullEyeGeo = gullSheet(6, 6, (s, t) => {
  const a = s * Math.PI;
  const b = t * Math.PI * 2;
  return [0.06 * Math.cos(a), 0.06 * Math.sin(a) * Math.cos(b), 0.045 * Math.sin(a) * Math.sin(b), GULL_EYE];
});
const gullTailGeo = gullSheet(6, 8, (s, t) => {
  const across = t * 2 - 1;
  return [-1.85 - s * (1.35 - 0.2 * across * across), 0.06 - 0.03 * s - 0.03 * across * across, across * (0.2 + 0.55 * s), GULL_WHITE];
});

// The wing's outline, from the shoulder to the tip: [distance out, leading edge x, trailing edge x]
const GULL_WING = [[0, 0.72, -1.05], [1.0, 0.9, -0.98], [2.1, 1.02, -0.76], [3.2, 0.66, -0.82], [4.2, -0.05, -1.05], [4.7, -0.58, -1.2], [4.98, -1.14, -1.3]];
const GULL_WRIST = 1.0; // the wrist joint sits on the leading edge, so folding there leaves no gap
// One face of the wing between two distances out; `hand` measures from the wrist.
function gullWingFace(from, to, top, hand) {
  return gullSheet(12, 16, (c, s) => {
    // the two sheets meet on a slanted line, so the folded joint shows no step
    const lo = hand ? from + 0.12 * c : from;
    const hi = hand ? to : to + 0.12 * c;
    const out = lo + (hi - lo) * s;
    let x = gullProfile(GULL_WING, out, 1) + (gullProfile(GULL_WING, out, 2) - gullProfile(GULL_WING, out, 1)) * c;
    if (c > 0.99 && out > 2.4) x += 0.11 * (Math.floor(s * 16) % 2); // the flight feathers' ends
    const thick = 0.16 * (1 - out / 5.4) * Math.sin(Math.PI * Math.min(1, c * 0.88 + 0.09)) * Math.sqrt(1 - c * 0.85);
    const y = 0.13 * (1 - out / 6) * Math.sin(Math.PI * c) + (top ? thick / 2 : -thick / 2);
    const tip = out > 3.55 + (1 - c) * 0.45;
    const mirror = out > 4.36 && out < 4.66 && c > 0.2 && c < 0.7;
    let colour = GULL_WHITE;
    if (tip && !mirror) colour = top || out > 4.1 ? GULL_BLACK : [0.16, 0.17, 0.19];
    else if (top && !mirror && c > 0.07 && c < 0.87) colour = GULL_GREY.map((v) => v * (c > 0.55 ? 0.9 + 0.1 * (Math.floor(out * 5) % 2) : 1));
    return [hand ? x - GULL_WRIST : x, y, hand ? out - 2.1 : out, colour];
  });
}
const gullArmGeos = [gullWingFace(0, 2.16, true, false), gullWingFace(0, 2.16, false, false)];
const gullHandGeos = [gullWingFace(2.08, 4.98, true, true), gullWingFace(2.08, 4.98, false, true)];

// Several sheets as one shape, each moved to [x, y, z].
function joinSheets(sheets) {
  const position = [];
  const normal = [];
  const colour = [];
  const index = [];
  for (const [g, x = 0, y = 0, z = 0] of sheets) {
    const first = position.length / 3;
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) position.push(p[i] + x, p[i + 1] + y, p[i + 2] + z);
    normal.push(...g.attributes.normal.array);
    colour.push(...g.attributes.color.array);
    for (const i of g.index.array) index.push(first + i);
  }
  const joined = shared(new THREE.BufferGeometry());
  joined.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  joined.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  joined.setAttribute("color", new THREE.Float32BufferAttribute(colour, 3));
  joined.setIndex(index);
  return joined;
}
const gullTrunkGeo = joinSheets([[gullBodyGeo], [gullBillGeo], [gullTailGeo], [gullEyeGeo, 2.05, 0.47, -0.285], [gullEyeGeo, 2.05, 0.47, 0.285]]);
const gullArmGeo = joinSheets(gullArmGeos.map((g) => [g]));
const gullHandGeo = joinSheets(gullHandGeos.map((g) => [g]));

function makeGull() {
  const root = new THREE.Group();
  const part = (geometry, into = root) => {
    const m = mesh(geometry, gullMat, false);
    into.add(m);
    return m;
  };
  part(gullTrunkGeo);
  const arms = [];
  const hands = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(0.08, 0.2, side * 0.32);
    arm.scale.z = side; // the left wing is the right one mirrored
    const hand = new THREE.Group();
    hand.position.set(GULL_WRIST, 0, 2.1);
    part(gullArmGeo, arm);
    part(gullHandGeo, hand);
    arm.add(hand);
    root.add(arm);
    arms.push(arm);
    hands.push(hand);
  }
  return { root, arms, hands };
}

// Sets the wings. `beat` runs through the wingbeat; `effort` goes from gliding
// (0: held out in a shallow M) to flapping (1: the wrist trails the shoulder and
// flexes on the way up); `fold` draws them back for a dive.
function poseGull(bird, beat, effort, fold = 0) {
  const mix = (a, b, k) => a + (b - a) * k;
  const stroke = beat + 0.35 * Math.sin(beat); // down slower and harder than up
  const lift = mix(mix(0.17, 0.08 + 0.62 * Math.sin(stroke), effort), 0.45, fold);
  const bend = mix(mix(-0.2, -0.05 + 0.46 * Math.sin(stroke - 1.05), effort), -0.15, fold);
  const sweep = mix(mix(0.13, 0.08 + 0.34 * Math.max(0, Math.cos(stroke)), effort), 1.3, fold);
  for (const arm of bird.arms) arm.rotation.set(-lift, -0.55 * fold, 0);
  for (const hand of bird.hands) hand.rotation.set(-bend, -sweep, 0);
}

const gullFlock = new THREE.Group();
scene.add(gullFlock);
const gulls = [];

function createGull(fisher) {
  const bird = makeGull();
  const root = bird.root;
  root.scale.setScalar(0.52);
  const fish = mesh(ballGeo, gullFishMat, false);
  fish.scale.set(0.75, 0.2, 0.2);
  fish.position.set(3.15, 0.1, 0);
  fish.visible = false;
  root.add(fish);
  gullFlock.add(root);
  const heading = Math.random() * Math.PI * 2;
  const alt = fisher ? 45 + Math.random() * 25 : 70 + Math.random() * 90;
  return {
    root, bird, fish, fisher,
    x: (Math.random() - 0.5) * WORLD_W * 1.6,
    z: (Math.random() - 0.5) * WORLD_H * 1.6,
    h: heading,
    turn: (Math.random() < 0.5 ? -1 : 1) * (0.1 + Math.random() * 0.12), // rad/s: circle radius = speed / turn
    speed: 22 + Math.random() * 10,
    alt, y: alt,
    phase: Math.random() * 10,
    flapRate: 10.5 + Math.random() * 2.5, // radians a second: under two beats
    beat: Math.random() * 6, effort: 0, fold: 0, bank: 0, pitch: 0,
    mode: "fly", t: 0, next: 4 + Math.random() * 12, catch: false, y0: 0
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
  const body = mesh(ballGeo, batMat, false);
  body.scale.set(0.8, 0.3, 0.3);
  const head = mesh(ballGeo, batMat, false);
  head.scale.set(0.3, 0.26, 0.26);
  head.position.set(0.8, 0.1, 0);
  const wings = [-1, 1].map((side) => {
    const w = new THREE.Group();
    w.add(mesh(batWingGeo, batMat, false));
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
    const was = g.y;
    let effort = 1; // how hard it is flapping
    let fold = 0;
    let turn = 0;
    if (g.mode === "fly") {
      // Wide wandering circles; out past the edge of the map, back towards the middle.
      const out = Math.abs(g.x) > HALF_W * GULL_SPAN || Math.abs(g.z) > HALF_H * GULL_SPAN;
      if (out) {
        const want = Math.atan2(-g.z, -g.x);
        turn = clamp(Math.atan2(Math.sin(want - g.h), Math.cos(want - g.h)), -0.5, 0.5);
      } else turn = g.turn + 0.14 * Math.sin(t * 0.37 + g.phase) + 0.07 * Math.sin(t * 0.91 + g.phase * 2.7);
      const target = sea + g.alt + Math.sin(t * 0.3 + g.phase) * 8;
      g.y += (target - g.y) * Math.min(1, dt * 0.8);
      // Mostly gliding, with bursts of flapping, and flapping to climb.
      effort = Math.sin(t * 0.31 + g.phase * 2) > 0.45 || target - g.y > 3 ? 1 : 0;
      if (g.fisher && g.t > g.next) { g.mode = "dive"; g.t = 0; g.catch = Math.random() < 0.7; g.y0 = g.y; }
    } else if (g.mode === "dive") {
      const k = Math.min(1, g.t / 1.7);
      const top = sea + 0.8;
      g.y = g.y0 + (top - g.y0) * k * k;
      effort = 0;
      fold = Math.min(1, k * 2.5);
      if (k >= 1) {
        g.mode = "climb"; g.t = 0;
        g.fish.visible = g.catch;
        for (let i = 0; i < 4; i++) puffSteam(g.x + (Math.random() - 0.5) * 6, g.z + (Math.random() - 0.5) * 6, 0.35, 1);
      }
    } else {
      const k = Math.min(1, g.t / 2.2);
      const target = seaHeight(g.x, g.z) + g.alt;
      g.y += (target - g.y) * Math.min(1, dt * (1 + 2 * k));
      if (k >= 1 && Math.abs(target - g.y) < 3) { g.mode = "fly"; g.t = 0; g.next = 10 + Math.random() * 14; }
    }
    const sp = g.mode === "dive" ? g.speed * 1.6 : g.speed;
    g.h += turn * dt;
    g.x += Math.cos(g.h) * sp * dt;
    g.z += Math.sin(g.h) * sp * dt;
    if (g.mode === "fly" && g.fish.visible && g.t > 6) g.fish.visible = false; // swallowed it
    // eased, so nothing about the bird snaps from one state to the next
    const ease = (from, to, rate) => from + (to - from) * Math.min(1, dt * rate);
    g.effort = ease(g.effort, effort, 3);
    g.fold = ease(g.fold, fold, 6);
    g.bank = ease(g.bank, clamp(Math.atan((sp * turn) / 14), -0.9, 0.9), 2.5); // leans into its turn
    g.pitch = ease(g.pitch, Math.atan2(g.y - was, sp * dt + 1e-3), 5);
    g.beat += dt * g.flapRate * (g.mode === "climb" ? 1.25 : 1);
    // the body rises as the wings beat down
    g.root.position.set(g.x, g.y - 0.3 * g.effort * Math.sin(g.beat), g.z);
    g.root.rotation.set(0, -g.h, 0);
    g.root.rotateZ(g.pitch);
    g.root.rotateX(g.bank);
    poseGull(g.bird, g.beat, g.effort, g.fold);
  }
}

// ---------------------------------------------------------------------------
// Fish: in the overhead view a small school now and then swims by near the
// surface, turning along quays, breakwaters and shores. Scenery only.
// ---------------------------------------------------------------------------
const FISH_SCHOOLS = 3; // at most at once
const FISH_PER_SCHOOL = 22;
const FISH_BACK = [0.012, 0.028, 0.026];
const FISH_FLANK = [0.34, 0.46, 0.44];

// About 2.4 units from nose to tail, x forward: dark back, paler flanks, forked tail.
const fishGeo = joinSheets([
  [gullSheet(12, 10, (s, t) => {
    const a = t * Math.PI * 2;
    const half = 0.06 + 0.36 * Math.sin(Math.PI * s) ** 0.8 * (0.35 + 0.65 * s);
    return [-0.9 + 2.2 * s, half * 0.6 * Math.sin(a), half * Math.cos(a), Math.abs(Math.cos(a)) > 0.45 ? FISH_FLANK : FISH_BACK];
  })],
  [gullSheet(4, 8, (s, t) => {
    const across = t * 2 - 1;
    return [-0.85 - s * (0.25 + 0.4 * across * across), 0, across * (0.05 + 0.38 * s), FISH_BACK];
  })]
]);
// see-through a little, as if just under the surface; the tail beats in the shader
const fishMat = shared(new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, roughness: 0.45, metalness: 0.2, side: THREE.DoubleSide }));
const fishTime = { value: 0 };
fishMat.onBeforeCompile = (shader) => {
  shader.uniforms.fishTime = fishTime;
  shader.vertexShader = "uniform float fishTime;\n" + shader.vertexShader.replace(
    "#include <begin_vertex>",
    "#include <begin_vertex>\n" +
      "float tailward = clamp( ( 0.6 - position.x ) / 2.0, 0.0, 1.0 );\n" +
      "transformed.z += sin( fishTime * 13.0 + position.x * 2.2 + float( gl_InstanceID ) * 1.7 ) * 0.34 * tailward * tailward;"
  );
};

function makeFishMesh(count) {
  const m = new THREE.InstancedMesh(fishGeo, fishMat, count);
  const white = new THREE.Color(1, 1, 1);
  for (let i = 0; i < count; i++) m.setColorAt(i, white);
  m.frustumCulled = false;
  return m;
}

const fishMesh = makeFishMesh(FISH_SCHOOLS * FISH_PER_SCHOOL);
fishMesh.visible = false;
scene.add(fishMesh);
const fishSchools = [];
const fishPose = new THREE.Object3D();
const fishTint = new THREE.Color();
let fishShown = false;
let fishNext = 4; // seconds until the next school turns up

// Open water at a game point, well off land, rocks, ice and the whirlpool.
function fishWater(x, y) {
  const off = (o) => Math.hypot(x - o.x, y - o.y) > o.r + 14;
  return x > 0 && y > 0 && x < WORLD_W && y < WORLD_H &&
    landClearance(x, y) > 14 && terrainDepth(x, y) > 14 &&
    hazards.every(off) && game.iceSheets.every(off) && (whirlpool.state === "dormant" || off(whirlpool));
}

// A new school somewhere in view; by a harbour it starts off along a quay.
function addFishSchool(focus, reach) {
  const harbour = [HarbourA, HarbourB].find((h) => Math.hypot(h.x - focus.x, h.y - focus.y) < reach + 250);
  for (let attempt = 0; attempt < 30; attempt++) {
    let x = focus.x + (Math.random() - 0.5) * reach * 1.6;
    let y = focus.y + (Math.random() - 0.5) * reach;
    let heading = Math.random() * Math.PI * 2;
    if (harbour && attempt < 20) {
      const first = Math.random() < 0.5; // the quay along a, or the one along b
      const along = 50 + Math.random() * (BASIN - 90);
      const out = 45 + Math.random() * 70;
      ({ x, y } = harbourPoint(harbour, first ? along : out, first ? out : along));
      const way = Math.random() < 0.5 ? -1 : 1;
      heading = first ? Math.atan2(0, way) : Math.atan2(way, 0);
    }
    if (!fishWater(x, y)) continue;
    fishSchools.push({
      x, y, h: heading, side: 1, age: 0,
      life: 35 + Math.random() * 30,
      speed: 9 + Math.random() * 6,
      phase: Math.random() * 20,
      fish: Array.from({ length: 10 + Math.floor(Math.random() * (FISH_PER_SCHOOL - 9)) }, () => ({
        along: (Math.random() - 0.5) * 24,
        across: (Math.random() - 0.5) * 14,
        size: 1.5 + Math.random() * 0.6,
        phase: Math.random() * 20
      }))
    });
    return;
  }
}

function updateFish(dt) {
  const focus = cameraFocus();
  if (!focus.inWorld) {
    fishSchools.length = 0;
    fishNext = 4;
  }
  fishShown = focus.inWorld && !game.harbourShip && game.settings.cameraView === "overview" &&
    !game.mission?.falls && !humanShips().every((s) => s.capsized);
  fishMesh.visible = fishShown;
  if (!fishShown) return;
  const t = clock.t;
  fishTime.value = t;
  const reach = 450 * clamp(viewZoom.overview, 0.3, 1.5); // about half the width in view
  fishNext -= dt;
  if (fishNext <= 0) {
    if (fishSchools.length < FISH_SCHOOLS) addFishSchool(focus, reach);
    fishNext = 10 + Math.random() * 18;
  }
  let n = 0;
  for (let i = fishSchools.length - 1; i >= 0; i--) {
    const s = fishSchools[i];
    s.age += dt;
    if (s.age >= s.life || Math.hypot(s.x - focus.x, s.y - focus.y) > reach * 3) {
      fishSchools.splice(i, 1);
      continue;
    }
    const clear = (turn) => [20, 40].every((d) => fishWater(s.x + Math.cos(s.h + turn) * d, s.y + Math.sin(s.h + turn) * d));
    let turn = 0.25 * Math.sin(t * 0.4 + s.phase); // a gentle wander
    if (!clear(0)) {
      // round it, keeping to the side already chosen, so they follow a wall along
      const way = [0.5, 1, 1.6, 2.3].flatMap((a) => [a * s.side, -a * s.side]).find(clear) ?? Math.PI;
      s.side = Math.sign(way);
      turn = way * 1.5;
    }
    if (!fishWater(s.x, s.y)) s.life = Math.min(s.life, s.age + 2);
    s.h += turn * dt;
    s.x += Math.cos(s.h) * s.speed * dt;
    s.y += Math.sin(s.h) * s.speed * dt;
    const grown = smoothstep(0, 3, s.age) * (1 - smoothstep(s.life - 3, s.life, s.age)); // they rise into sight and go down again
    for (const f of s.fish) {
      const along = f.along + 1.5 * Math.sin(t * 0.9 + f.phase);
      const across = f.across + 2 * Math.sin(t * 1.3 + f.phase * 2.1);
      const x = s.x - HALF_W + Math.cos(s.h) * along - Math.sin(s.h) * across;
      const z = s.y - HALF_H + Math.sin(s.h) * along + Math.cos(s.h) * across;
      fishPose.position.set(x, seaHeight(x, z) + 0.55, z);
      fishPose.rotation.set(0, -s.h + 0.18 * Math.sin(t * 2.1 + f.phase), 0);
      fishPose.scale.setScalar(f.size * grown);
      fishPose.updateMatrix();
      fishMesh.setMatrixAt(n, fishPose.matrix);
      // now and then one rolls and its silver side catches the light
      fishMesh.setColorAt(n, fishTint.setScalar(1 + 7 * Math.max(0, Math.sin(t * 0.9 + f.phase * 3.3)) ** 40));
      n++;
    }
  }
  fishMesh.count = n;
  fishMesh.instanceMatrix.needsUpdate = true;
  fishMesh.instanceColor.needsUpdate = true;
}

const stormObjects = new Map();

function setReflectionHidden(hidden) {
  gullFlock.visible = !hidden;
  fishMesh.visible = !hidden && fishShown;
  for (const o of stormObjects.values()) o.cloud.visible = !hidden;
  const lookingDown = sky.cloudHeight - CLOUD_HEIGHT_OVERVIEW <= 12; // the overview camera
  // Mirrored in the sea seen from above, clouds show as stray patches.
  water.userData.mirrorClouds = lookingDown ? 0 : MIRRORED_CLOUDS;
  wakeGroup.visible = !hidden;
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
  for (const o of oldPort.small) o.visible = !hidden;
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
  const open = smoothstep(0, WHIRL_THROAT_FULL, w);
  whirlThroat.visible = w > 0.01;
  if (whirlThroat.visible) {
    const rim = WHIRL_RIM * wp.r * open;
    whirlThroat.scale.set(rim, (40 + 60 * w) * open, rim);
    whirlThroat.userData.veil.material.opacity = open;
    whirlThroat.position.set(cx, seaHeight(cx + rim, cz) + 0.3, cz);
    whirlThroat.rotation.y -= wp.spin * dt * (1.5 + 3 * w);
    // The water pours down the wall; the foam slides faster and further round.
    const { wallTex, foamTex } = whirlThroat.userData;
    throatTime.value += dt * (0.5 + w);
    wallTex.offset.y += dt * (0.15 + 0.35 * w);
    foamTex.offset.y += dt * (0.3 + 0.6 * w);
    foamTex.offset.x -= wp.spin * dt * (0.05 + 0.15 * w);
  }
  whirlFoam.visible = w > 0.01;
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
  if (c.variant === "croc") return createCroc();
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
  if (c.variant === "croc") {
    // Low in the water, eyes and back showing; the tail sculls faster when it rushes.
    o.root.position.y += -0.9 + Math.sin(t * 1.6 + o.seed) * 0.35;
    o.tail.rotation.y = Math.sin(t * (c.speed > 60 ? 9 : 3) + o.seed) * 0.45;
    return;
  }
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

// Tow ropes, mooring lines, the anchor chain and tankers' hoses: rebuilt every
// frame along a curve; the ropes as laid rope, the rest as plain tubes.
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
  m.geometry = material === hempMat ? ropeGeometry([].concat(curve).map((c) => ({ curve: c, r: radius }))) : new THREE.TubeGeometry(curve, 32, radius, 6);
  m.material = material;
  seen.add(key);
}

// A moored ship's five lines run from holes in its side to the quay bollards:
// the long head line far forward, bow line, stern line and two springs. They
// reach out one after another as they are made fast and are cast off in
// reverse; `ropes` (0..1) is how far along.
const chainMat = shared(mat(0x2a2d31, { roughness: 0.5, metalness: 0.7 }));
const mooringTmp = { a: new THREE.Vector3(), b: new THREE.Vector3() };
const FAIRLEAD_MAX = 6.5; // no line is made fast higher than this above the water
// The modelled liner's mooring deck (cruise_model.py, mooring_leads): where
// each of the five lines leaves it on the starboard side, as [x, y, half-width,
// way out x, y, z] in model units.
const CRUISE_LEADS = [
  [40.06, 3.11, 3.38, 0.294, -0.272, 0.916], // head line, the foremost opening
  [36.65, 3.11, 4.34, 0.232, -0.244, 0.942], // bow line
  [-45.9, 3.11, 5.9, -0.118, 0, 0.993], // stern line
  [33.24, 3.11, 5.07, 0.177, -0.199, 0.964], // springs
  [-39.4, 3.11, 6.25, 0, 0, 1]
];
const EYE_RADIUS = 0.56; // the loop over a bollard

// Where a mooring line is led aboard: through the side just under the deck
// edge, `x` from midships, found on the model itself (a hull narrows to bow and
// stern, so its widest beam would leave the line hanging in the air). Past the
// end of the hull (or where only a stem or rudder is left) it is led nearer
// midships. `beam` is the hull's half width. Returns the place and the way
// `out` of the plating there, in the model's frame.
function fairlead(o, x, sign, beam) {
  o.root.updateMatrixWorld(true);
  const solids = [];
  const inside = new Set(); // neither the bridge interior nor the oars
  if (o.interior) o.interior.traverse((c) => inside.add(c));
  o.tilt.traverse((c) => {
    if (c.isMesh && !c.isInstancedMesh && !inside.has(c)) solids.push(c);
  });
  const from = new THREE.Vector3();
  const to = new THREE.Vector3();
  // the first solid thing met coming in from the side at height y
  const probe = (y) => {
    o.tilt.localToWorld(from.set(x, y, sign * (o.halfBeam * 2 + 5)));
    o.tilt.localToWorld(to.set(x, y, 0)).sub(from).normalize();
    fireRay.set(from, to);
    const hit = fireRay.intersectObjects(solids, false)[0];
    return { hit, wide: hit ? sign * o.tilt.worldToLocal(hit.point.clone()).z : 0 };
  };
  const toModel = new THREE.Matrix4().copy(o.model.matrixWorld).invert();
  for (let k = 0; k < 6; k++, x *= 0.9) {
    let found = null;
    let height = 0;
    let widest = 0;
    for (let y = 0.6; y <= FAIRLEAD_MAX; y += 0.4) {
      const { hit, wide } = probe(y);
      // Up the side until it falls away: above the deck edge there is air, or a cabin set back.
      if (wide < beam * 0.3 || wide < widest * 0.85) {
        if (found) break;
        continue;
      }
      widest = Math.max(widest, wide);
      found = hit;
      height = y;
    }
    if (!found) continue;
    const lower = probe(Math.max(0.8, height - 0.9));
    if (lower.wide > widest * 0.8) found = lower.hit; // room for the hole under the edge
    const out = found.face.normal.clone().transformDirection(found.object.matrixWorld).transformDirection(toModel);
    if (out.z * sign < 0.3) out.set(0, 0, sign);
    return { at: o.model.worldToLocal(found.point.clone()), out };
  }
  return { at: o.model.worldToLocal(o.tilt.localToWorld(from.set(x, 2, sign * o.halfBeam * 0.5))), out: new THREE.Vector3(0, 0, sign) };
}

// A hole through the ship's side for a line: an oval rim proud of the plating
// round the dark within. Like the rigging, it is no part of any ray test.
const holeSteel = shared(mat(0x353a40, { roughness: 0.45, metalness: 0.7 }));
const holeTimber = shared(mat(0x241509, { roughness: 0.8 }));
const holeDark = shared(new THREE.MeshBasicMaterial({ color: 0x050403 }));

function hawseHole(o, { at, out }) {
  const hole = new THREE.Group();
  const rim = mesh(new THREE.TorusGeometry(0.42, 0.14, 8, 22), WOODEN_HULLS.has(o.bridgeKind) ? holeTimber : holeSteel, false);
  const dark = new THREE.Mesh(new THREE.CircleGeometry(0.4, 22), holeDark);
  dark.position.z = 0.03;
  for (const part of [rim, dark]) {
    part.scale.x = 1.3;
    part.raycast = () => {};
    part.userData.rigging = true;
    hole.add(part);
  }
  const size = 1 / o.model.scale.x;
  hole.position.copy(at).addScaledVector(out, 0.03 * size);
  hole.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(out, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)));
  hole.scale.setScalar(size);
  o.model.add(hole);
}

function mooringLines(ship, seen) {
  const { h, slot } = ship.berth;
  const s = bumpShape(ship);
  const len = s.h + s.r;
  const fwd = { x: Math.cos(ship.angle), y: Math.sin(ship.angle) };
  const side = slot === 0 ? { x: -h.sa, y: 0 } : { x: 0, y: -h.sb }; // towards the quay
  const along = slot === 0 ? (ship.y - h.corner.y) * h.sb : (ship.x - h.corner.x) * h.sa; // the ship's place along the quay
  const way = (slot === 0 ? fwd.y * h.sb : fwd.x * h.sa) < 0 ? -1 : 1; // -1: bow towards the harbour corner
  // [where on the hull, where on the quay], as distances from midships.
  const spring = ship.category === "Galley" ? 0.45 : 0.7; // a galley's: within the length of her rowing frame, clear of its corners
  const lines = [[0.97 * len, 0.97 * len + 36], [0.9 * len, 0.9 * len + 7], [-0.92 * len, -0.92 * len - 7], [spring * len, 0.25 * len], [-spring * len, -0.25 * len]];
  const bollardAt = (k) => {
    const b = BOLLARD_FIRST + BOLLARD_STEP * clamp(Math.round((k - BOLLARD_FIRST) / BOLLARD_STEP), 0, Math.floor((BASIN - 4 - BOLLARD_FIRST) / BOLLARD_STEP));
    return slot === 0 ? harbourPoint(h, 20.5, b) : harbourPoint(h, b, 20.5);
  };
  const o = shipObjects.get(ship);
  if (o && !o.fairleads) {
    // each line's hole on both sides, so the ship has them whichever way she lies
    o.root.updateMatrixWorld(true);
    o.fairleads = {};
    const holes = [];
    const deck = o.category === "Cruise" && o.proxy; // the modelled liner has its openings built in
    for (const sign of [-1, 1]) {
      lines.forEach(([hullAt], i) => {
        if (deck) {
          const [x, y, z, ox, oy, oz] = CRUISE_LEADS[i];
          o.fairleads[`${i}:${sign}`] = { at: new THREE.Vector3(x, y, z * sign), out: new THREE.Vector3(ox, oy, oz * sign), open: true };
          return;
        }
        const lead = fairlead(o, hullAt, sign, s.r);
        // lines that come within a hole's width of each other share it
        const near = holes.find((other) => other.at.distanceTo(lead.at) * o.model.scale.x < 1.6);
        o.fairleads[`${i}:${sign}`] = near || lead;
        if (!near) holes.push(lead);
      });
    }
    for (const lead of holes) hawseHole(o, lead); // (a mooring deck has its openings already)
  }
  // where the quay's top is, under a rope lying on it (the old port's edge stones stand higher)
  const quayRest = LAND_TOP + 0.58;
  const edgeRest = LAND_TOP + (oldPort.shown ? 0.82 : 0.58);
  const thick = clamp(0.12 + len * 0.0022, 0.15, 0.24); // a small boat's lines are lighter than a liner's
  lines.forEach(([hullAt, quayAt], i) => {
    const f = clamp(ship.ropes * MOORING_LINES - i, 0, 1);
    if (f <= 0 || (f < 1 && !ship.anchored)) return; // not out yet, or being hauled in (updateHauls)
    const key = `${ship.playerSlot}-moor${i}`;
    hauls.delete(key);
    const bol = bollardAt(along + way * quayAt);
    let a;
    let lead = null;
    let keep = null;
    const curves = [];
    let inboard = null; // where the line starts, aboard
    let through = []; // from there out through the hole
    if (o) {
      o.root.updateMatrixWorld(true);
      const zAxis = o.root.localToWorld(new THREE.Vector3(0, 0, 1)).sub(o.root.getWorldPosition(new THREE.Vector3()));
      const sign = zAxis.x * side.x + zAxis.z * side.y > 0 ? 1 : -1; // which local side faces the quay
      lead = o.fairleads[`${i}:${sign}`];
      const size = 1 / o.model.scale.x;
      a = o.model.localToWorld(lead.at.clone().addScaledVector(lead.out, 0.3 * size));
      // inboard: through the hole, or across the mooring deck to its winch
      inboard = lead.at.clone().addScaledVector(lead.out, lead.open ? -1.3 : -0.8 * size);
      if (lead.open) inboard.y += 0.19;
      through = [o.model.localToWorld(inboard.clone()), o.model.localToWorld(lead.at.clone())];
      // While it is hauled aboard, its loops stay outside the ship: out to her
      // full width within a short way of the hole.
      const centre = o.root.position; // hers as she moves: a last line may still be coming aboard
      const sideways = new THREE.Vector3(side.x, 0, side.y);
      const ahead = new THREE.Vector3(fwd.x, 0, fwd.y);
      const clearOf = a.clone().sub(centre);
      const from = clearOf.dot(sideways);
      const at = clearOf.dot(ahead);
      const widest = Math.max(...lines.map((_, j) => Math.abs(o.fairleads[`${j}:${sign}`].at.z))) * o.model.scale.x + 0.5;
      keep = (p) => {
        const dx = p.x - centre.x;
        const dz = p.z - centre.z;
        const along = dx * ahead.x + dz * ahead.z;
        if (Math.abs(along) > len) return;
        const need = Math.min(widest, from + Math.abs(along - at) * 0.4);
        const out = dx * sideways.x + dz * sideways.z;
        if (out < need) p.addScaledVector(sideways, need - out);
      };
    } else {
      a = toWorld(ship.x + fwd.x * hullAt + side.x * s.r * 0.85, ship.y + fwd.y * hullAt + side.y * s.r * 0.85, 3.5, mooringTmp.a).clone();
    }
    // The line ends in an eye round the bollard, wide enough to clear it and
    // high enough to lie on the stone, and comes to the eye's near side.
    const post = toWorld(bol.x, bol.y, quayRest, mooringTmp.b).clone();
    const lie = Math.atan2(a.z - post.z, a.x - post.x);
    const b = post.clone().add(new THREE.Vector3(Math.cos(lie) * EYE_RADIUS, 0.05, Math.sin(lie) * EYE_RADIUS));
    // how far a point is out from the bollard towards the water
    const out = (p) => (p.x - post.x) * -side.x + (p.z - post.z) * -side.y;
    // (the support falls away smoothly past the edge, so the line runs over it
    // without a corner, and a line from a low hole climbs to it gradually)
    const stone = (p) => (out(p) > 4 ? -Infinity : out(p) > 0.7 ? edgeRest - Math.max(0, out(p) - 2.1) * 0.9 : quayRest);
    const floor = (p) => Math.min(stone(p), a.y + Math.hypot(p.x - a.x, p.z - a.z) * 0.8);
    const end = a.clone().lerp(b, f);
    // A hawser is heavy and stiff: made fast it runs straight from the ship to
    // the quay with a shallow belly, and moves only because the ship moves. It
    // hangs lower while it is still being run out. Over the quay it rests on the
    // stone.
    const sag = end.distanceTo(a) * 0.012 + (1 - ship.ropes) * 0.5 + (f < 1 ? 1 : 0);
    curves.push(new THREE.CatmullRomCurve3([...through, ...ropeCurve(a, end, { sag, floor, snake: false }).points]));
    if (f >= 1) {
      const eye = Array.from({ length: 12 }, (_, k) => {
        const turn = (k * Math.PI) / 6;
        return new THREE.Vector3(post.x + Math.cos(lie + turn) * EYE_RADIUS, post.y + Math.max(0, Math.cos(turn)) * 0.06, post.z + Math.sin(lie + turn) * EYE_RADIUS);
      });
      curves.push(new THREE.CatmullRomCurve3(eye, true));
      if (lead) {
        const away = new THREE.Vector3(side.x, 0, side.y); // towards the quay, clear of the hull
        const ground = (p) => (out(p) > 2.3 ? seaHeight(p.x, p.z) - 0.1 : out(p) > 0.7 ? edgeRest : quayRest);
        const loose = () => !ship.anchored && (!ship.berth || ship.ropes * MOORING_LINES - i < 1);
        fastLines.set(key, { ship, local: lead.at, inboard, end: b, r: thick, away, seed: i * 2.1, loose, ground, keep });
      }
    }
    setLine(key, curves, thick, hempMat, seen);
  });
  anchorChain(ship, seen);
}

// Lines made fast just now, and lines being hauled in since they were let go.
const fastLines = new Map(); // key -> { ship, local, inboard, end, r, away, seed, loose, ground, keep }
const hauls = new Map(); // the same, with `since` when it was let go
const HAUL_TIME = 3.6; // s for a line to come aboard

function updateHauls(seen) {
  for (const [key, line] of fastLines) {
    if (!shipObjects.has(line.ship)) fastLines.delete(key);
    else if (line.loose()) {
      hauls.set(key, { ...line, since: clock.t });
      fastLines.delete(key);
    }
  }
  for (const [key, h] of hauls) {
    const o = shipObjects.get(h.ship);
    const k = Math.max(0, clock.t - h.since) / HAUL_TIME;
    if (!o || k >= 1) {
      hauls.delete(key);
      continue;
    }
    o.root.updateMatrixWorld(true);
    const to = o.model.localToWorld(h.local.clone());
    const aboard = h.inboard && o.model.localToWorld(h.inboard.clone());
    setLine(key, haulCurves(to, h.end, k, h.seed, h.away, h.ground, h.keep, aboard), h.r, hempMat, seen);
  }
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
  const roped = game.harbourShip ? [game.harbourShip] : game.galley ? [...humanShips(), game.galley.boat] : humanShips();
  for (const ship of roped) {
    const o = shipObjects.get(ship);
    if (!o) continue;
    const tow = ship.tow && shipObjects.get(ship.tow);
    if (tow) {
      // Taut it runs nearly straight; slack it drops to the sea and lies awash
      // there in a wide, easy bend, as a heavy hawser does.
      const a = o.model.localToWorld(o.ropeAt.clone());
      const b = tow.model.localToWorld(tow.ropeAt.clone());
      const slack = Math.max(0, ship.towLength - Math.hypot(ship.tow.x - ship.x, ship.tow.y - ship.y));
      const sag = a.distanceTo(b) * 0.015 + Math.min(slack * 0.2, 4.5);
      // It leads level over each ship's end before it drops, clear of the hull.
      const clear = (end, s, p) => end.y - Math.max(0, Math.hypot(p.x - end.x, p.z - end.z) - shipHalfLength(s) * 0.2 - 1) * 1.2;
      const floor = (p) => Math.max(seaHeight(p.x, p.z) + 0.15, clear(a, ship, p), clear(b, ship.tow, p));
      const key = `${ship.playerSlot}-tow`;
      hauls.delete(key);
      setLine(key, ropeCurve(a, b, { sag, kink: Math.min(slack, 25) * 0.008, seed: 1.3, swing: 0.03, time: clock.t, floor, snake: false }), 0.35, hempMat, seen);
      // the ring at the towed ship's bow that the rope is passed through
      if (!tow.towRing) {
        const ring = mesh(new THREE.TorusGeometry(0.55, 0.17, 8, 20).rotateY(Math.PI / 2), WOODEN_HULLS.has(tow.bridgeKind) ? holeTimber : holeSteel, false);
        ring.raycast = () => {};
        ring.userData.rigging = true;
        ring.position.copy(tow.ropeAt);
        ring.scale.setScalar(1 / tow.model.scale.x);
        tow.model.add(ring);
        tow.towRing = ring;
      }
      const away = a.clone().sub(o.root.position).setY(0).normalize(); // astern of the tug
      fastLines.set(key, { ship, local: o.ropeAt, end: b, r: 0.35, away, seed: 1.3, loose: () => !ship.tow, ground: (p) => seaHeight(p.x, p.z) - 0.1 });
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
  updateHauls(seen);
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
const berthMarkers = []; // { group, slot }: shown in game play only
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
  // None behind the menus; one berth in a one-player game.
  for (const { group, slot } of berthMarkers) group.visible = !game.harbourShip && (slot === 0 || mode === "local");
  for (const [material, on] of harbourNightLights) material.emissiveIntensity = night.on ? on : 0;
  if (oldPort.shown) return; // no cars in the carrack's age
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

const seaWallMat = shared(mat(0x16302e, { roughness: 1 }));

// Each harbour's two ages: the present-day quays and town (`modern`), the
// oil and gas pumps (kept whenever a tanker is about), and the 16th-century
// port (`old`, built when the carrack is first wanted: buildOldPort).
const harbourEras = [];

function buildHarbour(h, color, seed) {
  const root = new THREE.Group();
  const modern = new THREE.Group();
  const pumps = new THREE.Group();
  const pieces = HARBOUR_LAND.filter((p) => p.harbour === h);
  for (const p of pieces) {
    if (p.kind === "coast") modern.add(capsuleBlock(p, -3, LAND_TOP, [grassMat, quayMat]));
    else if (p.kind === "mole") modern.add(capsuleBlock(p, -3, LAND_TOP + 0.5, rockMat));
    else continue;
    // Dark rock down to below the sea bed, so from under water (a wreck) the land is not a floating sheet.
    const foot = capsuleBlock(p, -165, -3, seaWallMat);
    foot.castShadow = foot.receiveShadow = false;
    root.add(foot);
  }
  pieces.filter((p) => p.kind === "moored").forEach((p, i) => modern.add(mooredBoat(p, i)));

  // Quays: a concrete apron along both quay faces, with bollards to tie up
  // to and black rubber fenders hung on the quay wall.
  modern.add(harbourBox(h, 4, 22, 22, BASIN + 12, LAND_TOP + 0.15, 0.3, apronMat));
  modern.add(harbourBox(h, 22, BASIN + 12, 4, 22, LAND_TOP + 0.15, 0.3, apronMat));
  for (let k = BOLLARD_FIRST; k <= BASIN - 4; k += BOLLARD_STEP) {
    for (const [a, b, fa, fb] of [[20.5, k, 22.2, k], [k, 20.5, k, 22.2]]) {
      const bp = harbourPoint(h, a, b);
      modern.add(cylinder(0.22, 0.28, 0.85, darkMat, bp.x - HALF_W, LAND_TOP + 0.72, bp.y - HALF_H, 10));
      modern.add(cylinder(0.38, 0.3, 0.18, darkMat, bp.x - HALF_W, LAND_TOP + 1.22, bp.y - HALF_H, 10)); // its head, over the lines' eyes
      const fp = harbourPoint(h, fa, fb);
      modern.add(box(0.5, 1, 0.4, darkMat, fp.x - HALF_W, LAND_TOP - 0.9, fp.y - HALF_H));
    }
  }
  // A walkway along the top of each breakwater.
  modern.add(harbourBox(h, BASIN - 2.5, BASIN + 2.5, 22, MOLE_END, LAND_TOP + 0.6, 0.3, apronMat));
  modern.add(harbourBox(h, 22, MOLE_END, BASIN - 2.5, BASIN + 2.5, LAND_TOP + 0.6, 0.3, apronMat));
  harbourLighthouse(modern, harbourPoint(h, BASIN, MOLE_END));
  entranceLight(modern, harbourPoint(h, MOLE_END, BASIN));

  // Cargo berth: a warehouse behind the second quay and a container crane
  // on the quay edge, its boom reaching out over the water.
  modern.add(harbourBox(h, 32, 106, -72, -24, LAND_TOP + 7, 14, mat(0x7c8fa3, { roughness: 0.7, metalness: 0.2 })));
  modern.add(harbourBox(h, 30, 108, -74, -22, LAND_TOP + 14.4, 0.8, mat(0x55606b, { roughness: 0.7 })));
  const craneMat = mat(0xd9a62b, { roughness: 0.6, metalness: 0.3 });
  for (const a of [70, 84]) {
    for (const b of [8, 20]) modern.add(harbourBox(h, a - 0.8, a + 0.8, b - 0.8, b + 0.8, LAND_TOP + 13, 26, craneMat));
  }
  modern.add(harbourBox(h, 69, 85, 6, 22, LAND_TOP + 26.5, 2, craneMat));
  modern.add(harbourBox(h, 76, 78, -6, 62, LAND_TOP + 28, 1.6, craneMat)); // the boom
  modern.add(harbourBox(h, 73, 81, 12, 18, LAND_TOP + 30, 3, mat(0x3b4148, { roughness: 0.6 })));

  harbourPumps(pumps, h);
  harbourRoads(modern, h, seed + 1);
  harbourTown(modern, h, seed);

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
    berthMarkers.push({ group: berth, slot });
    root.add(berth);
  }
  const keep = new Set([...lighthouseBeams, ...pumpFans.map((p) => p.fan), ...harbourGlows, ...polarOnly, ...polarHidden]);
  for (const group of [modern, pumps]) mergeStaticMeshes(group, keep);
  mergeStaticMeshes(root, new Set([modern, pumps])); // the see-through berth markers are never merged
  root.add(modern, pumps);
  root.userData.swaps = [modern, pumps];
  scene.add(root);
  harbourEras.push({ h, root, modern, pumps, old: null });
}

// Map edge buoys: ~170 of them, each a post, a cone and a lamp. They are
// drawn as three instanced meshes (one draw call per part for all buoys,
// instead of three per buoy) and bob on the waves in updateBuoys.
const buoys = []; // { x, z, seed }
const buoyParts = []; // { im, y, old }: each part's height on the buoy, and which age shows it
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
    { geo: new THREE.SphereGeometry(0.5, 8, 6), material: lampM, y: 3.4, shadow: false },
    // In the carrack's age the same marks are floating casks with a staff and pennant.
    { geo: new THREE.CylinderGeometry(0.8, 0.8, 1.5, 12), material: mat(0x6b4a2b, { roughness: 0.9 }), y: 0.35, shadow: true, old: true },
    { geo: new THREE.CylinderGeometry(0.07, 0.09, 3, 6), material: mat(0x3d2a18, { roughness: 0.9 }), y: 2.4, shadow: true, old: true },
    { geo: new THREE.BoxGeometry(1.1, 0.65, 0.05).translate(0.6, 0, 0), material: paint, y: 3.55, shadow: false, old: true, color: (b) => (b.red ? red : white) }
  ];
  for (const part of parts) {
    const im = new THREE.InstancedMesh(part.geo, part.material, buoys.length);
    im.castShadow = part.shadow;
    im.receiveShadow = true;
    im.frustumCulled = false; // they ring the whole sea
    if (part.color) buoys.forEach((b, i) => im.setColorAt(i, part.color(b)));
    im.visible = !part.old;
    scene.add(im);
    buoyParts.push({ im, y: part.y, old: !!part.old });
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

// ---------------------------------------------------------------------------
// Under the sea: when a captain's ship capsizes the camera dives after her.
// The scene below the surface (blue water, the bright rippling surface seen
// from underneath, shafts of light, bubbles, drifting specks, the sea bed) is
// shown only to a camera that is under water (applyUnderwater).
// ---------------------------------------------------------------------------
const SINK_DIVE_AFTER = 0.8; // seconds watching her roll over before the camera dives
const SINK_GLIDE = 2.2; // how fast the camera moves to the wreck
const SEABED_Y = -150;
const UNDER_FOG = 0x0d5468;
const UNDER_VERTEX = `
varying vec3 vPos;
uniform float time;
uniform float wave;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  w.y += wave * (sin(w.x * 0.09 + time * 1.3) * 0.7 + sin(w.z * 0.13 - time * 1.7) * 0.5);
  vPos = wave > 0.0 ? w.xyz : position;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const underUniforms = { time: { value: 0 }, dim: { value: 1 }, fogCol: { value: new THREE.Color(UNDER_FOG) } };
let under = null;

function underShader(wave, body, extra) {
  return new THREE.ShaderMaterial({
    uniforms: { ...underUniforms, wave: { value: wave } },
    vertexShader: UNDER_VERTEX,
    fragmentShader: `
varying vec3 vPos;
uniform float time;
uniform float dim;
uniform vec3 fogCol;
void main() {
${body}
  #include <colorspace_fragment>
}`,
    toneMapped: false,
    ...extra
  });
}

function shaftTexture() {
  const cv = document.createElement("canvas");
  cv.width = 64;
  cv.height = 256;
  const g = cv.getContext("2d");
  for (let x = 0; x < 64; x++) {
    const side = Math.sin((x / 63) * Math.PI) ** 2;
    const fade = g.createLinearGradient(0, 0, 0, 256);
    fade.addColorStop(0, `rgba(190,240,255,${side})`);
    fade.addColorStop(1, "rgba(190,240,255,0)");
    g.fillStyle = fade;
    g.fillRect(x, 0, 1, 256);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function underPoints(count, size, opacity, spread) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) pos.set(spread(), i * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({ map: softDotTexture(), color: 0xcdefff, size, transparent: true, opacity, depthWrite: false }));
  points.frustumCulled = false;
  return points;
}

function buildUnderwater() {
  const high = perf.level <= 2;
  const group = new THREE.Group();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(520, 32, 24), underShader(0, `
  float h = normalize(vPos).y;
  vec3 c = mix(fogCol, vec3(0.09, 0.45, 0.55), smoothstep(0.0, 0.8, h));
  c = mix(c, vec3(0.004, 0.04, 0.065), smoothstep(0.0, -0.7, h));
  gl_FragColor = vec4(c * dim, 1.0);`, { side: THREE.BackSide }));
  // The surface from below: a bright window overhead with dancing ripples.
  const cells = high ? 160 : 60;
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(1100, 1100, cells, cells).rotateX(-Math.PI / 2), underShader(1, `
  vec3 v = vPos - cameraPosition;
  float d = length(v);
  float sky = smoothstep(0.25, 0.8, v.y / d);
  float a = sin(vPos.x * 0.11 + 2.0 * sin(vPos.z * 0.07 + time)) * sin(vPos.z * 0.13 + 2.0 * sin(vPos.x * 0.05 - time * 1.2));
  float b = sin(vPos.x * 0.23 - time * 1.6 + sin(vPos.z * 0.19)) * sin(vPos.z * 0.21 + time * 1.1);
  float glint = pow(1.0 - abs(a), 8.0) + 0.5 * pow(1.0 - abs(b), 10.0);
  vec3 c = mix(vec3(0.04, 0.27, 0.36), vec3(0.42, 0.78, 0.86), sky) + glint * (0.12 + 0.35 * sky) * vec3(0.6, 0.9, 1.0);
  float far = smoothstep(60.0, 340.0, d);
  gl_FragColor = vec4(mix(c * dim, fogCol * dim, far), mix(0.78, 1.0, far));`, { side: THREE.DoubleSide, transparent: true, depthWrite: false }));
  surface.position.y = -0.5;
  group.add(dome, surface);

  const shaftMat = new THREE.MeshBasicMaterial({ map: shaftTexture(), transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const shafts = [];
  for (let i = 0; i < (high ? 14 : 6); i++) {
    const shaft = new THREE.Mesh(new THREE.PlaneGeometry(7 + Math.random() * 12, 120).translate(0, -60, 0), shaftMat);
    const a = Math.random() * Math.PI * 2;
    const r = 25 + Math.random() * 130;
    shaft.position.set(Math.cos(a) * r, -1, Math.sin(a) * r);
    shaft.userData.phase = Math.random() * 10;
    shafts.push(shaft);
    group.add(shaft);
  }

  const bubbles = underPoints(high ? 500 : 150, 1.3, 0.75, () => [(Math.random() - 0.5) * 50, -Math.random() * 50, (Math.random() - 0.5) * 50]);
  const specks = underPoints(high ? 900 : 200, 0.5, 0.4, () => [(Math.random() - 0.5) * 260, -2 - Math.random() * 130, (Math.random() - 0.5) * 260]);
  group.add(bubbles, specks);

  const bedCells = high ? 110 : 40;
  const bedGeo = new THREE.PlaneGeometry(1100, 1100, bedCells, bedCells).rotateX(-Math.PI / 2);
  const bedPos = bedGeo.attributes.position;
  for (let i = 0; i < bedPos.count; i++) {
    const x = bedPos.getX(i);
    const z = bedPos.getZ(i);
    bedPos.setY(i, Math.sin(x * 0.035) * Math.cos(z * 0.028) * 7 + Math.random() * 2);
  }
  bedGeo.computeVertexNormals();
  const bed = new THREE.Mesh(bedGeo, mat(0x8d7d58, { roughness: 1 }));
  bed.position.y = SEABED_Y;
  group.add(bed);
  const rockMat = mat(0x49524c, { roughness: 0.95, flatShading: true });
  for (let i = 0; i < (high ? 40 : 12); i++) {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(3 + Math.random() * 9, 0), rockMat);
    rock.position.set((Math.random() - 0.5) * 360, SEABED_Y + 2, (Math.random() - 0.5) * 360);
    rock.scale.y = 0.5 + Math.random() * 0.5;
    rock.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    group.add(rock);
  }
  group.visible = false;
  scene.add(group);
  return { group, shafts, bubbles, specks };
}

// The captain's ship that went down last (null if none has).
function lastWreck() {
  return humanShips().filter((s) => s.capsized).sort((a, b) => b.sankAt - a.sankAt)[0] || null;
}

// Moves the underwater scene to the wreck: bubbles pour out of her and rise.
function updateUnderwater(dt) {
  const ship = lastWreck();
  const o = ship && shipObjects.get(ship);
  if (!o) return;
  if (!under) under = buildUnderwater();
  underUniforms.time.value += dt;
  underUniforms.dim.value = night.on ? 0.3 : 1;
  under.group.position.set(o.root.position.x, 0, o.root.position.z);
  const t = underUniforms.time.value;
  for (const s of under.shafts) {
    s.rotation.set(0.12 * Math.sin(t * 0.31 + s.userData.phase), s.userData.phase, 0.25 + 0.08 * Math.sin(t * 0.47 + s.userData.phase));
  }
  under.specks.position.set(Math.sin(t * 0.09) * 6, Math.sin(t * 0.21) * 1.5, Math.cos(t * 0.07) * 6);
  const pos = under.bubbles.geometry.attributes.position;
  const wreckY = o.root.position.y + o.tilt.position.y;
  for (let i = 0; i < pos.count; i++) {
    let y = pos.getY(i) + (5 + (i % 11)) * dt;
    if (y > -1) {
      // back to somewhere along the hull
      const along = (Math.random() - 0.5) * o.halfLen * 2.2;
      const across = (Math.random() - 0.5) * o.halfBeam * 2;
      pos.setX(i, Math.cos(o.yaw) * along - Math.sin(o.yaw) * across);
      pos.setZ(i, Math.sin(o.yaw) * along + Math.cos(o.yaw) * across);
      y = Math.min(-1.5, wreckY + (Math.random() - 0.3) * 8);
    } else {
      pos.setX(i, pos.getX(i) + Math.sin(t * 3 + i) * dt * 1.2);
    }
    pos.setY(i, y);
  }
  pos.needsUpdate = true;
}

// Called for each camera before it draws: under water it sees the underwater
// scene through blue haze; above water nothing changes.
function applyUnderwater(cam) {
  const wet = !!under && cameraFocus().inWorld && !!lastWreck() && cam.position.y < seaHeight(cam.position.x, cam.position.z) - 0.5;
  if (under) under.group.visible = wet;
  sun.color.setHex(wet ? 0x86d6e4 : lookFor(night.applied).sun);
  if (!wet) return;
  scene.fog.near = 20;
  scene.fog.far = 330;
  scene.fog.color.setHex(UNDER_FOG).multiplyScalar(underUniforms.dim.value);
  fogDome.visible = false;
  overcastDome.visible = false;
  for (const g of fogLights.glows) g.visible = false;
}

// Under water beside the wreck, looking a little up at her against the bright
// surface, slowly circling; kept on the open-sea side if she sank by land.
function sinkWant(ship, pos, look) {
  const o = shipObjects.get(ship);
  if (!o || o.sinkAge < SINK_DIVE_AFTER || ship.overFalls !== undefined) return false;
  const { x, z } = o.root.position;
  const y = o.root.position.y + o.tilt.position.y;
  const away = 30 + o.halfLen * 2.1;
  let angle = o.yaw + 2.1 + o.sinkAge * 0.07;
  for (const c of tsunamiLandCircles()) {
    const dx = ship.x - c.x;
    const dy = ship.y - c.y;
    // seen at a slant along the shore, so open water stays in the picture
    if (Math.hypot(dx, dy) < c.r + away) angle = Math.atan2(dy, dx) + 1.1 + 0.1 * Math.sin(o.sinkAge * 0.2);
  }
  look.set(x, y - 2, z);
  pos.set(x + Math.cos(angle) * away, Math.min(-9, y - 12), z + Math.sin(angle) * away);
  return true;
}

// How far a camera following `ship` moves towards its place this frame.
function viewGlide(ship, state, dt) {
  return ship.capsized ? 1 - Math.exp(-dt * SINK_GLIDE) : chaseFollow(state, 1 - Math.exp(-dt * 4.5), dt);
}

// The followed ship in the chase and bridge views (player 1).
// Once player 1 is out and the split has closed, the view follows player 2.
function chaseShip() {
  if (game.settings.cameraView === "overview") return null;
  const p2 = mode === "local" ? game.player2 : null;
  // (While the split is still showing, player 1's half stays with the wreck.)
  if (p2 && game.player1.capsized && !p2.capsized && !collapse.active && !splitShown) return p2;
  return game.player1;
}

// 2-player: when one ship sinks, a short pause to watch it go down, then
// the survivor's half of the split screen widens until it fills the screen.
const COLLAPSE_DELAY = 5;
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
  Cargo: [-15.6, 21.8, 0], // bridge on the accommodation tower aft, high above the stacks (floor clear of the tower's top)
  Sailing: [SAIL_HELM_X, SAIL_EYE_Y, 2.2], // standing behind the wheel, a little to starboard so the mast isn't dead ahead
  Catamaran: [-1, 11.5, 2.5], // to starboard of the mast
  Assault: [-1.5, 17.5, 0],
  Carrier: [-4.4, 7.4, -4.4], // the navigation bridge on the island (starboard edge), about 18 m above the flight deck
  Hydrofoil: [5.5, 10.4, 0],
  Futuristic: [1, 7.5, 0],
  Pirate: [-13, 15, 0], // the helm on the stern castle
  Carrack: CARRACK_HELM,
  Galley: GALLEY_HELM,
  Tug: [5.6, 9.3, 0], // forward wheelhouse (see harbourTug)
  Icebreaker: [8.5, 16.6, 0],
  Tanker: [-16.3, 17, 0], // bridge aft, looking down the length of the deck
  GasTanker: [-17.5, 18.9, 0], // high enough to see over the tanks
  WarTanker: WAR_HELM // the wheelhouse midships
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
  // Inside: standing near the windows (or behind the wheel). Outside: a camera on top of the bridge, looking out ahead.
  const open = kind === "Sailing" || kind === "Carrack" || kind === "Galley";
  const [sx, sy] = open ? SAIL_VIEW.stand : bridgeRoom(kind).stand;
  const [rx, ry] = open ? SAIL_VIEW.above : BRIDGE_ROOF_CAM;
  const az = z + (open ? (SAIL_VIEW.aside * inside) / sc : 0);
  pos.copy(o.model.localToWorld(eyeTmp.set(x + (sx * inside + rx * (1 - inside)) / sc, y + (sy * inside + ry * (1 - inside)) / sc, az)));
  // Facing the bow, tilted down about 13 degrees, turned by however far the
  // player has looked around (right-drag, game.js bridgeLook). Only the view
  // turns; the ship keeps its heading.
  const head = bridgeLook[ship === game.player2 ? "p2" : "p1"];
  // Inside, the view is nearly level (no floor in the picture); it tips down again on the way to the window view.
  const lookIn = open ? SAIL_VIEW.lookIn : BRIDGE_LOOK_INSIDE;
  const lookOut = open ? SAIL_VIEW.lookOut : BRIDGE_LOOK_DOWN;
  const pitch = lookIn + (lookOut - lookIn) * (1 - inside) + head.pitch;
  const reach = 60 * Math.cos(pitch);
  look.copy(o.model.localToWorld(eyeTmp.set(x + reach * Math.cos(head.yaw), y + 60 * Math.sin(pitch), az - reach * Math.sin(head.yaw))));
  up.copy(WORLD_UP).transformDirection(o.model.matrixWorld);
  return true;
}

function viewWant(ship, state, pos, look, up, dt) {
  if (ship.capsized && sinkWant(ship, pos, look)) {
    up.copy(WORLD_UP);
    return;
  }
  if (game.settings.cameraView === "bridge" && !ship.capsized) updateBridgeBlend(ship, dt);
  if (game.settings.cameraView === "bridge" && !ship.capsized && bridgeWant(ship, pos, look, up)) return;
  up.copy(WORLD_UP);
  chaseWant(ship, state, pos, look, dt);
}

// On the bridge: a wider lens (so your own bow fits in the picture) that can
// see things as close as 0.8 units (the chairs, the console).
function setBridgeLens(on) {
  const near = on || closeLens ? 0.8 : 5; // close enough for the console, chairs and deck gear, far enough that the depth buffer stays steady
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
  orbitOffset(off, viewOrbit);
}

function orbitOffset(off, turn) {
  if (!turn.yaw && !turn.pitch) return;
  const r = off.length();
  const az = Math.atan2(off.z, off.x) + turn.yaw;
  const el = clamp(Math.atan2(off.y, Math.hypot(off.x, off.z)) + turn.pitch, 0.05, 1.5);
  off.set(Math.cos(az) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(az) * Math.cos(el) * r);
}

// Zooming in past CLOSE_FROM leaves the whole-ship framing: the camera closes
// on the spot of the ship that was pointed at (game.js zoomAim), right down to
// the decks. By CLOSE_FULL that spot is the middle of the view.
const CLOSE_FROM = 0.7;
const CLOSE_FULL = 0.2;
const CLOSE_TILT = 0.4; // radians the view also tips down by, to look onto the decks
const CLOSE_REPICK = 12; // screen pixels the pointer must move to choose a new spot
const CLOSE_LAP = 12; // radians of drag (about 2000 pixels) for one trip round the vessel
const closeRay = new THREE.Raycaster();
const closeSpots = new WeakMap(); // ship -> the held close view (spot, now and height in model coordinates)
let closeLens = false; // this frame has a close view (setBridgeLens)

// How far `zoom` has gone from the whole-ship view to the close one, 0 to 1.
function closeWeight(zoom) {
  return smoothstep(0, 1, (CLOSE_FROM - zoom) / (CLOSE_FROM - CLOSE_FULL));
}

// The first solid part of the ship along closeRay, in model coordinates.
function hitShip(o) {
  const solid = [];
  if (o.proxy) o.proxy.traverse((c) => c.isMesh && solid.push(c));
  else o.model.traverseVisible((c) => c.isMesh && solid.push(c));
  const hit = closeRay.intersectObjects(solid, false)[0];
  return hit ? o.model.worldToLocal(hit.point) : null;
}

// The point of the ship seen at screen position `ndc`.
function pickShipSpot(o, cam, ndc) {
  closeRay.setFromCamera(ndc, cam);
  return hitShip(o);
}

// The surface seen looking at `anchor` (model coordinates) from the camera's
// side (`dir`, in the world); where that misses the vessel, the deck below.
function surfaceSpot(o, anchor, dir) {
  const from = o.model.localToWorld(anchor.clone());
  closeRay.set(from.clone().addScaledVector(dir, o.halfLen * 4 + 50), dir.clone().negate());
  const seen = hitShip(o);
  if (seen) return seen;
  closeRay.set(from.setY(from.y + o.top), new THREE.Vector3(0, -1, 0));
  return hitShip(o);
}

// The way round a vessel seen from above: along both sides and round the bow and
// stern (straight sides from -a to a, ends of radius r), `s` from the bow.
// Gives the place on the keel line there and the angle that points outwards.
function hullTrack(a, r, s) {
  const arc = (Math.PI / 2) * r;
  const lap = 4 * a + 4 * arc;
  const u = ((s % lap) + lap) % lap;
  if (u < arc) return { x: a, out: u / r };
  if (u < arc + 2 * a) return { x: a - (u - arc), out: Math.PI / 2 };
  if (u < 3 * arc + 2 * a) return { x: -a, out: Math.PI / 2 + (u - arc - 2 * a) / r };
  if (u < 3 * arc + 4 * a) return { x: u - 3 * arc - 3 * a, out: (3 * Math.PI) / 2 };
  return { x: a, out: (3 * Math.PI) / 2 + (u - 3 * arc - 4 * a) / r };
}

// Where `spot` lies on that track: `s` round it and `q`, how far out from the
// keel line (1 = the ship's side). `side` is the side the camera is on.
function hullPlace(a, r, spot, side) {
  const arc = (Math.PI / 2) * r;
  if (Math.abs(spot.x) <= a) {
    const s = side > 0 ? arc + a - spot.x : 3 * arc + 3 * a + spot.x;
    return { s, q: clamp((spot.z * side) / r, -1, 1) };
  }
  const dx = spot.x - Math.sign(spot.x) * a;
  const out = (Math.atan2(spot.z, dx) + Math.PI * 2) % (Math.PI * 2);
  let s = out * r;
  if (spot.x < 0) s += 2 * a;
  else if (out > Math.PI) s += 4 * a;
  return { s, q: Math.min(1, Math.hypot(dx, spot.z) / r) };
}

// As `zoom` gets small, moves `pivot` (what the camera circles) to the chosen
// spot and turns `off` (the camera, from the pivot). Dragging (`turn`) then takes
// the camera along the vessel and round its ends, always outside it. Returns how
// far the close view has taken over, 0 to 1.
function closeUp(ship, cam, pivot, off, zoom, turn, view) {
  const o = shipObjects.get(ship);
  if (!o) return 0;
  const t = closeWeight(zoom);
  let held = closeSpots.get(ship);
  if (held && held.view !== view) held = undefined;
  const freeAz = Math.atan2(off.z, off.x) - ship.angle; // from the bow
  if (t <= 0) {
    if (held) {
      // zoomed back out: the free view carries on from this side
      const swung = normalizeAngle(held.az - freeAz);
      turn.yaw += swung;
      orbitOffset(off, { yaw: swung, pitch: 0 });
    }
    closeSpots.delete(ship);
    return 0;
  }
  if (!held || Math.hypot(zoomAim.x - held.x, zoomAim.y - held.y) > CLOSE_REPICK) {
    const box = canvas3d.getBoundingClientRect();
    // In split screen, or pointing past the ship, her middle is taken instead.
    const pointed = view3d.split ? null : pickShipSpot(o, cam, new THREE.Vector2(((zoomAim.x - box.left) / box.width) * 2 - 1, 1 - ((zoomAim.y - box.top) / box.height) * 2));
    const middle = o.root.position.clone().setY(o.root.position.y + o.top * 0.2);
    const spot = pointed || held?.spot || pickShipSpot(o, cam, middle.clone().project(cam)) || o.model.worldToLocal(middle);
    held = { view, x: zoomAim.x, y: zoomAim.y, spot, now: held?.now || spot.clone(), az: held ? held.az : freeAz, yaw: turn.yaw, pitch: turn.pitch };
    closeSpots.set(ship, held);
  }
  const drag = turn.yaw - held.yaw;
  const dragged = drag !== 0 || turn.pitch !== held.pitch;
  held.yaw = turn.yaw;
  held.pitch = turn.pitch;
  const sc = o.model.scale.x;
  const r = o.halfBeam / 0.9 / sc; // half the beam, in model units
  const a = Math.max(0, (o.halfLen * 1.25) / sc - r); // half the straight sides
  if (dragged) {
    if (held.s === undefined) {
      Object.assign(held, hullPlace(a, r, held.spot, Math.sin(held.az) >= 0 ? 1 : -1), { height: held.spot.y });
    }
    const before = hullTrack(a, r, held.s).out;
    held.s += (drag * (4 * a + 2 * Math.PI * r)) / CLOSE_LAP;
    const { out } = hullTrack(a, r, held.s);
    // Partly zoomed it still turns freely; fully, it turns as the hull does.
    held.az += (1 - t) * drag + t * normalizeAngle(out - before);
    // A slanting first view squares up to the hull as the drag goes on.
    const lean = normalizeAngle(held.az - out);
    held.az -= t * Math.sign(lean) * Math.min(Math.abs(lean), Math.abs(drag) * 0.5);
  }
  orbitOffset(off, { yaw: normalizeAngle(held.az + ship.angle - Math.atan2(off.z, off.x)), pitch: CLOSE_TILT * t });
  const dir = off.clone().normalize();
  if (dragged) {
    const { x, out } = hullTrack(a, r, held.s);
    const anchor = new THREE.Vector3(x + Math.cos(out) * r * held.q, held.height, Math.sin(out) * r * held.q);
    held.spot = surfaceSpot(o, anchor, dir) || held.spot;
  }
  held.now.lerp(held.spot, 0.15); // glides to a newly chosen spot
  // Where the surface stands further out towards the camera, it backs off faster.
  const outwards = dir.applyQuaternion(o.model.getWorldQuaternion(new THREE.Quaternion()).invert());
  const gap = held.spot.clone().sub(held.now).dot(outwards);
  if (gap > 0) held.now.addScaledVector(outwards, gap * 0.3);
  pivot.lerp(o.model.localToWorld(held.now.clone()), t);
  closeLens = true;
  return t;
}

// ---- A solid camera -------------------------------------------------------
// Close in (and on the menu once you have taken the view over) the camera can't
// go into anything: harbour, ships, islands, ice. It slides along what it meets
// and climbs over what stands in its way.
const SOLID_RADIUS = 1.2; // kept clear round the camera (more than the near plane reaches)
const SOLID_STEP = 0.7; // moved at most this far between checks, so nothing is skipped over
const SOLID_CELLS = [4, 32, 256]; // cube sizes: a big face (a quay, the ground) goes into bigger cubes
const solidGrids = new WeakMap(); // object -> its triangles, sorted into cells
const solidTri = new THREE.Triangle();
const solidNear = new THREE.Vector3();

// The triangles of an object's visible solid meshes, in its own coordinates,
// sorted into cubes so only those close by are tested.
function solidGrid(object) {
  const key = (object.userData.swaps || []).map((c) => (c.visible ? 1 : 0)).join(""); // parts shown and hidden (a harbour's)
  let grid = solidGrids.get(object);
  if (grid?.key === key) return grid;
  const scale = object.getWorldScale(new THREE.Vector3()).x;
  grid = { key, scale, points: [], levels: SOLID_CELLS.map((size) => ({ size: size / scale, cells: new Map() })) };
  object.updateWorldMatrix(true, true);
  const inverse = object.matrixWorld.clone().invert();
  const matrix = new THREE.Matrix4();
  const instance = new THREE.Matrix4();
  const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  object.traverseVisible((c) => {
    if (!c.isMesh || c.userData.rigging) return; // the camera passes through rigging
    // Glows, markers and other see-through effects are not solid.
    if ([].concat(c.material).every((m) => !m.visible || m.depthWrite === false)) return;
    const at = c.geometry.attributes.position;
    const index = c.geometry.index;
    const count = index ? index.count : at.count;
    for (let n = 0; n < (c.isInstancedMesh ? c.count : 1); n += 1) {
      matrix.multiplyMatrices(inverse, c.matrixWorld);
      if (c.isInstancedMesh) {
        c.getMatrixAt(n, instance);
        matrix.multiply(instance);
      }
      for (let i = 0; i + 2 < count; i += 3) {
        for (let k = 0; k < 3; k += 1) corners[k].fromBufferAttribute(at, index ? index.getX(i + k) : i + k).applyMatrix4(matrix);
        addSolidTriangle(grid, corners);
      }
    }
  });
  solidGrids.set(object, grid);
  return grid;
}

function addSolidTriangle(grid, [a, b, c]) {
  const id = grid.points.length;
  grid.points.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (const [n, { size, cells }] of grid.levels.entries()) {
    const low = ["x", "y", "z"].map((k) => Math.floor(Math.min(a[k], b[k], c[k]) / size));
    const high = ["x", "y", "z"].map((k) => Math.floor(Math.max(a[k], b[k], c[k]) / size));
    if (n < grid.levels.length - 1 && (high[0] - low[0] + 1) * (high[1] - low[1] + 1) * (high[2] - low[2] + 1) > 27) continue;
    for (let x = low[0]; x <= high[0]; x += 1) {
      for (let y = low[1]; y <= high[1]; y += 1) {
        for (let z = low[2]; z <= high[2]; z += 1) {
          const cell = solidCell(x, y, z);
          if (!cells.has(cell)) cells.set(cell, []);
          cells.get(cell).push(id);
        }
      }
    }
    return;
  }
}

function solidCell(x, y, z) {
  return x + 2048 + (y + 2048) * 4096 + (z + 2048) * 16777216;
}

// Pushes `point` (world) out of any surface of `object` it is closer to than
// the camera's radius.
function pushOutOf(object, point) {
  const grid = solidGrid(object);
  const local = object.worldToLocal(point.clone());
  const radius = SOLID_RADIUS / grid.scale;
  const test = (id) => {
    const p = grid.points;
    solidTri.a.set(p[id], p[id + 1], p[id + 2]);
    solidTri.b.set(p[id + 3], p[id + 4], p[id + 5]);
    solidTri.c.set(p[id + 6], p[id + 7], p[id + 8]);
    solidTri.closestPointToPoint(local, solidNear);
    const d = local.distanceTo(solidNear);
    if (d < radius && d > 1e-6) local.addScaledVector(solidNear.sub(local), -(radius - d) / d);
  };
  for (const { size, cells } of grid.levels) {
    const low = [local.x, local.y, local.z].map((v) => Math.floor((v - radius) / size));
    const high = [local.x, local.y, local.z].map((v) => Math.floor((v + radius) / size));
    for (let x = low[0]; x <= high[0]; x += 1) {
      for (let y = low[1]; y <= high[1]; y += 1) {
        for (let z = low[2]; z <= high[2]; z += 1) cells.get(solidCell(x, y, z))?.forEach(test);
      }
    }
  }
  point.copy(object.localToWorld(local));
}

// What is solid near `p`.
function solidThings(p) {
  const near = [];
  for (const e of harbourEras) {
    if (Math.hypot(e.h.corner.x - HALF_W - p.x, e.h.corner.y - HALF_H - p.z) > 1200) continue; // (the group itself sits at the middle of the map)
    for (const root of [e.root, e.old]) if (root?.visible) near.push(root);
  }
  for (const o of shipObjects.values()) if (o.root.position.distanceTo(p) < o.halfLen * 2.5 + 30) near.push(o.model);
  for (const o of hazardObjects.values()) if (Math.hypot(o.root.position.x - p.x, o.root.position.z - p.z) < 300) near.push(o.root);
  return near;
}

const solidStates = new WeakMap(); // camera -> where it got to, relative to the ship it watches

// Brings `cam` as near as it can to where it was placed without passing through
// anything; `ship` null lets it go where it likes.
function keepOutOfThings(cam, ship, look) {
  const o = ship && shipObjects.get(ship);
  if (!o) {
    solidStates.delete(cam);
    return;
  }
  const want = cam.position.clone();
  const held = solidStates.get(cam);
  const at = held?.ship === ship ? o.model.localToWorld(held.rel.clone()) : want.clone();
  if (at.distanceTo(want) > 250) at.copy(want); // a jump to a new place altogether
  const things = solidThings(at);
  const clear = (point) => {
    for (const thing of things) pushOutOf(thing, point);
    point.y = Math.max(point.y, SOLID_RADIUS); // and above the sea
  };
  clear(at);
  for (let i = 0; i < 60; i += 1) {
    const left = at.distanceTo(want);
    if (left < 0.01) break;
    const step = Math.min(SOLID_STEP, left);
    const next = at.clone().lerp(want, step / left);
    clear(next);
    const across = Math.hypot(want.x - at.x, want.z - at.z);
    const gained = across - Math.hypot(want.x - next.x, want.z - next.z);
    if (across > SOLID_RADIUS * 2) {
      // Held back by something between here and there: up and over it.
      if (gained < (step * across * 0.25) / left) {
        next.copy(at).y += step;
        clear(next);
      }
    } else if (next.distanceTo(want) > left - step * 0.25) {
      at.copy(next);
      break; // it is the place itself that is taken: rest against it
    }
    at.copy(next);
  }
  solidStates.set(cam, { ship, rel: o.model.worldToLocal(at.clone()) });
  cam.position.copy(at);
  cam.lookAt(look);
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
  const over = ship.tow ? 1 : 0; // towing: further back, much higher and looking at her own ship, over the masts of the one astern
  const back = (75 + len * 1.1 + 90 * over) * viewZoom.chase;
  const off = new THREE.Vector3(-fx * back, (22 + len * 0.42 + 150 * over) * viewZoom.chase + heave * (1 - closeWeight(viewZoom.chase)), -fz * back);
  applyViewOrbit(off);
  const close = closeUp(ship, state === cam2.chase ? camera2 : camera, look, off, viewZoom.chase, viewOrbit, "chase");
  pos.set(look.x + off.x, look.y + off.y, look.z + off.z);
  // Dragged round, the camera looks at the ship itself instead of the sea ahead.
  const turned = clamp(Math.hypot(viewOrbit.yaw, viewOrbit.pitch) * 4, 0, 1);
  look.x += fx * (230 - 225 * over) * (1 - turned) * (1 - close);
  look.z += fz * (230 - 225 * over) * (1 - turned) * (1 - close);
  look.y = THREE.MathUtils.lerp((16 + heave) * (1 - turned) + 10 * turned, look.y, close);
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

// The view behind the menus: out over the basin of Harbour A, looking back at
// your moored ship and the town, swinging slowly from side to side. A longer
// ship is seen from further off.
function harbourWant(ship, pos, look) {
  const o = shipObjects.get(ship);
  const len = o ? o.halfLen * 2.5 : 98; // halfLen is 0.4 of the model length
  const swing = Math.PI / 4 + Math.sin(clock.t * 0.06) * 0.55;
  const back = 55 + len * 1.15;
  toWorld(ship.x, ship.y, 0, look);
  pos.set(look.x + HarbourA.sa * Math.cos(swing) * back, 16 + len * 0.3, look.z + HarbourA.sb * Math.sin(swing) * back);
  look.y = 8;
  // The main menu's drag and zoom (game.js menuView), kept on the screens opened from it.
  const off = pos.clone().sub(look);
  orbitOffset(off, menuView);
  off.multiplyScalar(menuView.zoom);
  closeUp(ship, camera, look, off, menuView.zoom, menuView, "menu");
  pos.copy(look).add(off);
}

const chase = { angle: null, blend: 0 };

function updateCamera(dt) {
  const focus = cameraFocus();
  // With every captain's ship down, every view follows the last wreck under.
  const wreck = focus.inWorld && humanShips().every((s) => s.capsized) ? lastWreck() : null;
  const target = wreck || (focus.inWorld ? chaseShip() : null);
  let cloudTarget = CLOUD_HEIGHT_OVERVIEW;
  let rate = 2.5;
  closeLens = false;
  if (graphicsCheck.running) {
    // The graphics check looks out from a harbour, low over the sea: the
    // heaviest view in the game (what the chase view sees while sailing).
    toWorld(HarbourA.x + 220, HarbourA.y - 160, 45, wantPos);
    toWorld(WORLD_W / 2, WORLD_H / 2, 0, wantLook);
    cloudTarget = CLOUD_HEIGHT_CHASE;
    rate = 60;
  } else if (game.harbourShip) {
    harbourWant(game.harbourShip, wantPos, wantLook);
    cloudTarget = CLOUD_HEIGHT_CHASE;
    rate = menuView.touched ? 8 : 1.2; // keeps up with the drag
  } else if (!focus.inWorld) {
    orbit += dt * 0.035;
    const menuOrbit = Math.max(HALF_W, HALF_H) * 1.6; // the whole map in view
    wantPos.set(Math.sin(orbit) * menuOrbit, menuOrbit * 0.33, Math.cos(orbit) * menuOrbit);
    wantLook.set(0, 0, 0);
    rate = 1.2;
  } else if (target) {
    viewWant(target, chase, wantPos, wantLook, wantUp, dt);
    cloudTarget = CLOUD_HEIGHT_CHASE;
  } else {
    // Tilted overview above the focus; pulls back when 2-player ships separate.
    // The wheel zooms in and out (game.js viewZoom); with two ships it never
    // zooms in so far that one of them leaves the screen.
    const both = focus.spanX || focus.spanY ? Math.max((focus.spanX + 500) / VIEW_W, (focus.spanY + 360) / VIEW_H) : 0;
    const zoom = Math.max(viewZoom.overview, both);
    toWorld(focus.x, focus.y, 0, wantLook);
    const ship = focus.inWorld && !both ? humanShips()[0] : null;
    wantPos.copy(OVERVIEW_DIR).multiplyScalar(followDistance * zoom);
    applyViewOrbit(wantPos);
    const close = ship ? closeUp(ship, camera, wantLook, wantPos, zoom, viewOrbit, "overview") : 0;
    wantPos.add(wantLook);
    rate = 3 + 20 * close; // close in, a lagging camera would lose the deck
  }
  let k = 1 - Math.exp(-dt * rate);
  // Glide in when switching to the chase view, then stay locked on.
  if (target) {
    k = viewGlide(target, chase, dt);
  } else {
    chase.blend = 0;
    chase.angle = null;
  }
  setBridgeLens(!!target && game.settings.cameraView === "bridge" && humanShips().some((s) => !s.capsized));
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
    const k2 = viewGlide(game.player2, cam2.chase, dt);
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
  const solid = closeLens || (!!game.harbourShip && menuView.touched);
  keepOutOfThings(camera, solid ? game.harbourShip || target || humanShips()[0] : null, camLook);
  keepOutOfThings(camera2, solid && split ? game.player2 : null, cam2.look);
  keepAboveMissionGround(camera, camLook);
  keepAboveMissionGround(camera2, cam2.look);
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
// The pirate's cannon shot (game.js cannonCinematic), filmed in the real
// world: from the gun deck, across the same sea and sky, at the very ship
// being hit. The pirate's model is swapped for a close-up gun deck. The deck's
// own frame: +X towards the target, +Z to the right, deck top at SHOT_DECK.
// ---------------------------------------------------------------------------
const SHOT_DECK = 3;
const SHOT_EYE = new THREE.Vector3(-7.5, 6.4, 0);
const SHOT_GUN_X = 0.6; // the gun's trunnions along the deck
const SHOT_BORE = SHOT_DECK + 0.95; // height of the gun's axis
const SHOT_MUZZLE = 2.75; // trunnions to muzzle
const SHOT_RAIL = 2.25; // trunnions to the bulwark
const SHOT_PUFFS = 8; // smoke at the hit, spray in the splash
const SHOT_SPLINTERS = 24;
const WOODEN_HULLS = new Set(["Pirate", "Carrack", "Galley"]);
const shotTmp = new THREE.Vector3();
const shotLook = new THREE.Vector3();
let gunShot = null; // the deck and effects, built once
let shot = null; // the shot being filmed

function shotPending(ship) {
  const cin = game.cannonCinematic;
  return !!cin && cin.target === ship && cin.elapsed < CANNON_CINEMATIC_IMPACT_AT;
}

function gunBarrel(iron, black) {
  const g = new THREE.Group();
  // [radius, distance from the trunnions]: knob, breech, reinforce rings, chase, muzzle swell, bore
  const profile = [
    [0, -2.05], [0.13, -2.0], [0.15, -1.9], [0.08, -1.78], [0.1, -1.7], [0.5, -1.55], [0.56, -1.5], [0.56, -1.36], [0.5, -1.32],
    [0.47, -0.45], [0.53, -0.42], [0.53, -0.32], [0.43, -0.28], [0.4, 0.75], [0.45, 0.78], [0.45, 0.86], [0.37, 0.9],
    [0.29, 2.3], [0.34, 2.45], [0.4, 2.58], [0.38, 2.7], [0.3, SHOT_MUZZLE], [0.17, SHOT_MUZZLE]
  ].map(([r, y]) => new THREE.Vector2(r, y));
  g.add(mesh(new THREE.LatheGeometry(profile, 32).rotateZ(-Math.PI / 2), iron));
  const bore = mesh(new THREE.CircleGeometry(0.18, 24).rotateY(Math.PI / 2), black, false);
  bore.position.x = SHOT_MUZZLE - 0.02;
  g.add(bore);
  g.add(mesh(new THREE.CylinderGeometry(0.19, 0.19, 1.35, 14).rotateX(Math.PI / 2), iron)); // trunnions
  g.add(mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.14, 8), black).translateX(-1.43).translateY(0.56)); // vent
  return g;
}

function gunCarriage(oak, dark, iron) {
  const g = new THREE.Group(); // origin on the deck below the trunnions
  const side = new THREE.Shape();
  [[-1.9, 0.38], [1.0, 0.38], [1.0, 1.06], [0.3, 1.06], [0.15, 0.88], [-0.6, 0.88], [-0.65, 0.7], [-1.35, 0.7], [-1.4, 0.55], [-1.9, 0.55]]
    .forEach(([x, y], i) => (i ? side.lineTo(x, y) : side.moveTo(x, y)));
  const cheek = new THREE.ExtrudeGeometry(side, { depth: 0.24, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 1 });
  for (const z of [-0.78, 0.54]) g.add(mesh(cheek, oak).translateZ(z));
  g.add(box(2.7, 0.16, 1.1, dark, -0.45, 0.46, 0)); // bed
  for (const [x, r] of [[0.6, 0.45], [-1.45, 0.34]]) {
    g.add(box(0.34, 0.24, 2.1, dark, x, r, 0)); // axle
    for (const z of [-1.02, 1.02]) {
      g.add(mesh(new THREE.CylinderGeometry(r, r, 0.24, 24).rotateX(Math.PI / 2), oak).translateX(x).translateY(r).translateZ(z));
      for (const [ring, tube] of [[r, 0.035], [r * 0.3, 0.05]]) {
        g.add(mesh(new THREE.TorusGeometry(ring, tube, 8, 28), iron).translateX(x).translateY(r).translateZ(z + Math.sign(z) * 0.13));
      }
    }
  }
  for (const x of [-1.5, -0.7, 0.1, 0.8]) for (const z of [-0.82, 0.82]) g.add(mesh(new THREE.SphereGeometry(0.06, 8, 6), iron).translateX(x).translateY(0.62).translateZ(z));
  return g;
}

function buildGunShot() {
  const textures = carrackTextures();
  const planks = (rx, ry) => {
    const t = textures.planks.clone();
    t.repeat.set(rx, ry);
    t.anisotropy = 16;
    t.needsUpdate = true;
    return t;
  };
  const wood = (color, rx, ry, roughness = 0.82) => {
    const map = planks(rx, ry);
    return mat(color, { map, bumpMap: map, bumpScale: 1.2, roughness });
  };
  const deckWood = wood(0xa9906f, 3, 7);
  const side = wood(0x6b4a30, 1.5, 0.5);
  const oak = wood(0x7d3d24, 0.6, 0.4, 0.6); // gun carriages were painted red-brown
  const dark = wood(0x35231a, 1, 0.3);
  const iron = mat(0x2b2d31, { metalness: 0.85, roughness: 0.38 });
  const black = mat(0x030303, { roughness: 1 });

  const root = new THREE.Group();
  root.add(box(17, 0.3, 36, deckWood, -5.3, SHOT_DECK - 0.15, 0));
  root.add(box(16.8, SHOT_DECK + 1.2, 35.8, dark, -5.3, (SHOT_DECK - 1.8) / 2, 0)); // the hull under it
  // The bulwark in two lengths, leaving the gun port; it moves with the gun (placeGun).
  const rails = [-1, 1].map((s) => {
    const rail = new THREE.Group();
    rail.add(box(0.45, 1.05, 18, side, 0, SHOT_DECK + 0.52, s * 9));
    rail.add(box(0.8, 0.2, 18.1, dark, 0, SHOT_DECK + 1.14, s * 9));
    for (let z = 0.25; z < 18; z += 2.1) rail.add(box(0.28, 1.2, 0.32, dark, -0.34, SHOT_DECK + 0.6, s * z));
    for (let z = 1.2; z < 17; z += 2.1) rail.add(mesh(new THREE.TorusGeometry(0.14, 0.035, 6, 14).rotateY(Math.PI / 2), iron).translateX(-0.26).translateY(SHOT_DECK + 0.5).translateZ(s * z));
    rail.position.x = SHOT_GUN_X + SHOT_RAIL;
    rail.userData.side = s;
    root.add(rail);
    return rail;
  });

  // The gun and everything that stands beside it.
  const gun = new THREE.Group();
  const recoil = new THREE.Group();
  const barrel = gunBarrel(iron, black);
  barrel.position.y = SHOT_BORE - SHOT_DECK;
  recoil.add(gunCarriage(oak, dark, iron), barrel);
  gun.add(recoil);
  for (const s of [-1, 1]) {
    // breech rope from the bulwark round the knob
    const curve = new THREE.CatmullRomCurve3([[2.0, 0.55, s * 1.6], [1.1, 0.24, s * 1.62], [0.2, 0.17, s * 1.3], [-0.65, 0.42, s * 1.12], [-1.4, 0.75, s * 0.7], [-1.82, 0.95, s * 0.12]].map((p) => new THREE.Vector3(...p)));
    recoil.add(mesh(ropeGeometry([{ curve, r: 0.085, sides: 12 }]), hempMat));
  }
  const ball = new THREE.SphereGeometry(0.2, 16, 12);
  for (let level = 0; level < 3; level++) {
    const n = 3 - level;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) gun.add(mesh(ball, iron).translateX(-0.6 + (i - (n - 1) / 2) * 0.4).translateY(0.2 + level * 0.29).translateZ(2.2 + (j - (n - 1) / 2) * 0.4));
  }
  const cask = [[0, 0], [0.42, 0], [0.52, 0.4], [0.52, 0.75], [0.42, 1.15], [0, 1.15]].map(([r, y]) => new THREE.Vector2(r, y));
  gun.add(mesh(new THREE.LatheGeometry(cask, 20), side).translateX(0.9).translateZ(-2.3));
  for (const y of [0.22, 0.93]) gun.add(mesh(new THREE.TorusGeometry(0.48, 0.035, 6, 24).rotateX(Math.PI / 2), iron).translateX(0.9).translateY(y).translateZ(-2.3));
  gun.add(mesh(ropeGeometry([{ curve: ropeCoil(-1.6, 0, 2.9, 0.58, 0.075, 4.5, 2.2), r: 0.075, sides: 12 }]), hempMat));
  gun.position.set(SHOT_GUN_X, SHOT_DECK, 0);
  root.add(gun);

  // Shrouds and ratlines climbing out of view at the right.
  const shrouds = new THREE.Group();
  const foot = (i) => new THREE.Vector3(-i * 1.25, SHOT_DECK + 1.2, 0);
  const head = new THREE.Vector3(-1.9, SHOT_DECK + 17, -2.4);
  const legs = [0, 1, 2, 3].map((i) => ({ curve: ropeCurve(foot(i), head, { sag: 0.07 + 0.02 * i, kink: 0.015, seed: i * 3 }), r: 0.075, sides: 9 }));
  const rungs = [];
  for (let k = 1; k < 12; k++) {
    // seized to each shroud and sagging between them
    const points = [];
    for (let i = 0; i < 4; i++) {
      const at = legs[i].curve.getPoint(k / 16 + (hash3(i, k, 0, 3) - 0.5) * 0.012);
      if (i) points.push(at.clone().lerp(points[points.length - 1], 0.5).add(new THREE.Vector3(0, -0.04 - 0.09 * hash3(i, k, 1, 3), 0)));
      points.push(at);
    }
    rungs.push({ curve: new THREE.CatmullRomCurve3(points), r: 0.035, sides: 9, sway: 0.012, spans: 3 });
  }
  shrouds.add(mesh(ropeGeometry([...legs, ...rungs]), tarredMat));
  root.add(shrouds);

  // Effects, in world space.
  const fx = new THREE.Group();
  const sprite = (map, color, additive) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, color, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending }));
    s.renderOrder = 6;
    fx.add(s);
    return s;
  };
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const flash = [sprite(glowStar, 0xfff2cc, true), sprite(glowSoft, 0xffa030, true), sprite(glowSoft, 0xff6010, true)];
  const jet = makeFlame();
  fx.add(jet);
  const spark = sprite(glowStar, 0xffb050, true);
  const smoke = many(16, (i) => sprite(cloudPuffTex[i % 4], 0xffffff));
  const trail = many(6, (i) => sprite(cloudPuffTex[i % 4], 0xffffff));
  const cannonball = mesh(ball, iron);
  fx.add(cannonball);
  // the fire itself is solid colour (added light would vanish against a bright sky), its glow added
  const blast = [sprite(glowSoft, 0xfff0c0, true), sprite(cloudPuffTex[0], 0xff8420), sprite(cloudPuffTex[1], 0xff4a10)];
  blast.forEach((s, i) => (s.renderOrder = 8 - i));
  const blastSmoke = many(SHOT_PUFFS, (i) => sprite(cloudPuffTex[i % 4], 0xffffff));
  const splash = many(SHOT_PUFFS * 2, (i) => sprite(cloudPuffTex[i % 4], 0xffffff));
  const chip = new THREE.BoxGeometry(1, 0.22, 0.3);
  const chipMat = mat(0xffffff, { roughness: 0.8 });
  const splinters = many(SHOT_SPLINTERS, () => {
    const m = mesh(chip, chipMat, false);
    m.userData = { out: 4 + Math.random() * 16, up: 5 + Math.random() * 18, across: (Math.random() - 0.5) * 22, spin: 5 + Math.random() * 14, size: 0.35 + Math.random() * 1.1 };
    fx.add(m);
    return m;
  });
  for (const group of [root, fx]) group.traverse((c) => (c.frustumCulled = false)); // drawn by the warm-up too
  return { root, gun, recoil, barrel, rails, shrouds, fx, flash, jet, spark, smoke, trail, ball: cannonball, blast, blastSmoke, splash, splinters, chipMat };
}

function readyGunShot() {
  if (!gunShot) {
    gunShot = buildGunShot();
    showGunShot(false);
    scene.add(gunShot.root, gunShot.fx);
  }
}

function showGunShot(seen) {
  gunShot.root.visible = gunShot.fx.visible = seen;
}

// Lines the deck up on the target and finds where on her hull the ball strikes.
function startShot(cin, o) {
  readyGunShot();
  const target = toWorld(cin.target.x, cin.target.y);
  const from = toWorld(cin.attacker.x, cin.attacker.y).sub(target);
  const yaw = Math.atan2(from.z, -from.x); // the deck's +X looks back at the target
  const length = o.halfLen * 2.5;
  const distance = Math.max(length * 0.9 + 30, o.top * 2.6); // far enough to frame her, whatever her size
  const root = gunShot.root;
  root.rotation.y = yaw;
  root.position.copy(target).add(shotTmp.set(-distance, 0, 0).applyAxisAngle(WORLD_UP, yaw));
  // high enough that no wave washes over the deck and no ice ridge stands through it
  let lift = 0;
  for (let x = -12; x <= 4; x += 4) {
    for (let z = -16; z <= 16; z += 4) {
      shotTmp.set(x, 0, z).applyAxisAngle(WORLD_UP, yaw).add(root.position);
      lift = Math.max(lift, seaHeight(shotTmp.x, shotTmp.z));
      for (const s of game.iceSheets) {
        const lx = shotTmp.x + HALF_W - s.x;
        const ly = shotTmp.z + HALF_H - s.y;
        if (Math.hypot(lx, ly) < s.r) lift = Math.max(lift, iceSurface(s, lx, ly) - 1);
      }
    }
  }
  root.position.y = lift;
  root.updateMatrixWorld(true);
  // The gun stands left of the eye (closer in on narrow screens), laid on the target.
  const gunZ = -Math.min(3.1, camera.aspect * 1.75);
  gunShot.gun.position.z = gunZ;
  const aim = Math.atan2(-gunZ, distance - SHOT_GUN_X);
  gunShot.gun.rotation.y = -aim;
  const port = gunZ + SHOT_RAIL * Math.tan(aim); // where the barrel passes the bulwark
  for (const rail of gunShot.rails) rail.position.z = port + rail.userData.side * 1.15;
  gunShot.shrouds.position.set(SHOT_GUN_X + SHOT_RAIL, 0, Math.min(7.2, camera.aspect * 4));

  o.root.updateMatrixWorld(true);
  const eye = root.localToWorld(new THREE.Vector3(SHOT_GUN_X, SHOT_BORE, gunZ));
  const mark = o.root.position.clone().setY(o.root.position.y + Math.max(1.2, o.top * 0.12));
  const solids = [];
  o.tilt.traverse((c) => {
    if (!c.isMesh) return;
    for (let up = c; up; up = up.parent) if (up === o.interior) return;
    solids.push(c);
  });
  fireRay.set(eye, mark.clone().sub(eye).normalize());
  const found = fireRay.intersectObjects(solids, false)[0];
  const hit = found ? found.point.clone() : mark.addScaledVector(fireRay.ray.direction, -o.halfBeam);
  gunShot.chipMat.color.set(WOODEN_HULLS.has(o.bridgeKind) ? 0x8a6038 : cin.target.displayColor || 0x6d7782);
  return { cin, distance, length, yaw, hit: o.root.worldToLocal(hit), hidden: [] };
}

function endShot() {
  showGunShot(false);
  for (const o of shot.hidden) o.root.visible = true;
  shot = null;
}

// Moves the camera onto the gun deck and plays the shot; runs after updateCamera.
function updateCannonShot() {
  const cin = game.cannonCinematic;
  const o = cin && shipObjects.get(cin.target);
  if (shot && shot.cin !== cin) endShot();
  if (!o) return;
  if (!shot) shot = startShot(cin, o);
  const g = gunShot;
  showGunShot(true);
  // The pirate herself, and any ship crowding the deck, are out of the picture.
  for (const [ship, other] of shipObjects) {
    if (ship === cin.target || !other.root.visible) continue;
    if (ship !== cin.attacker && Math.hypot(other.root.position.x - g.root.position.x, other.root.position.z - g.root.position.z) > 30 + other.halfLen) continue;
    other.root.visible = false;
    shot.hidden.push(other);
  }
  plank.visible = false;

  const t = cin.elapsed;
  const since = t - CANNON_CINEMATIC_FIRE_AT;
  const flight = clamp(since / (CANNON_CINEMATIC_IMPACT_AT - CANNON_CINEMATIC_FIRE_AT), 0, 1);
  const age = t - CANNON_CINEMATIC_IMPACT_AT;
  const fine = QUALITY_LEVELS[perf.level].fine;
  const bright = night.on ? 0.3 : 1;

  // Recoil: a fast kick back, then a slower run out.
  g.recoil.position.x = since > 0 ? -1.1 * Math.min(1, since / 0.07) * (1 - 0.55 * smoothstep(0.15, 0.9, since)) : 0;
  g.root.updateMatrixWorld(true);
  const muzzle = g.recoil.localToWorld(new THREE.Vector3(SHOT_MUZZLE + 0.15, SHOT_BORE - SHOT_DECK, 0));
  const ahead = new THREE.Vector3(1, 0, 0).transformDirection(g.gun.matrixWorld);
  const hit = o.root.localToWorld(shot.hit.clone());

  // Camera: the whole gun deck at the shot, then closing in on the ship that is struck.
  const zoom = smoothstep(CANNON_CINEMATIC_FIRE_AT + 0.15, CANNON_CINEMATIC_IMPACT_AT + 0.1, t);
  const kick = since > 0 ? Math.max(0, 1 - since / 0.45) : 0;
  const jolt = age > 0 ? Math.max(0, 1 - age / 0.35) * 0.4 : 0;
  const shake = (kick + jolt) * 0.22;
  g.root.localToWorld(camera.position.copy(SHOT_EYE));
  camera.position.x += Math.sin(t * 61) * shake;
  camera.position.y += Math.sin(t * 47 + 1) * shake;
  const d = shot.distance;
  g.root.localToWorld(shotLook.set(d, 5, -d * 0.1 * (1 - zoom)));
  shotLook.y = THREE.MathUtils.lerp(g.root.position.y + 5, o.root.position.y + Math.max(5, o.top * 0.32), zoom);
  camera.up.copy(WORLD_UP);
  camera.lookAt(shotLook);
  const reach = d - SHOT_EYE.x; // eye to target
  const closeUp = 2 * Math.atan(Math.max((shot.length * 0.62 + 6) / camera.aspect, o.top * 0.75) / reach) * THREE.MathUtils.RAD2DEG;
  camera.fov = THREE.MathUtils.lerp(46, clamp(closeUp, 18, 46), zoom);
  camera.near = 0.8;
  camera.updateProjectionMatrix();

  // Sharp shadows over the short stretch in view.
  const sc = sun.shadow.camera;
  sc.right = sc.top = d * 0.75 + shot.length * 0.5;
  sc.left = sc.bottom = -sc.right;
  sc.updateProjectionMatrix();
  sun.target.position.copy(g.root.position).lerp(o.root.position, 0.5).setY(0);
  sun.position.copy(sunDir).multiplyScalar(1600).add(sun.target.position);

  // Match burning at the vent before the shot.
  g.spark.visible = since < 0;
  g.barrel.localToWorld(g.spark.position.set(-1.43, 0.7, 0));
  g.spark.scale.setScalar(0.7 + Math.random() * 0.5);
  g.spark.material.color.setRGB(4, 2.2, 0.8);

  // Muzzle flash and the tongue of flame.
  const fire = since >= 0 ? Math.max(0, 1 - since / 0.22) : 0;
  g.flash.forEach((s, i) => {
    s.visible = fire > 0;
    s.position.copy(muzzle).addScaledVector(ahead, i * 1.2);
    s.scale.setScalar([4, 6, 8][i] * (0.55 + 0.45 * fire));
    s.material.color.setRGB(...[[5, 4, 2.5], [4, 1.8, 0.4], [2.5, 0.6, 0.1]][i]);
    s.material.opacity = fire;
  });
  g.jet.visible = fire > 0;
  g.jet.position.copy(muzzle);
  g.jet.quaternion.setFromUnitVectors(WORLD_UP, ahead);
  g.jet.scale.set(2.2, 6 * (1.1 - fire * 0.4), 2.2);
  g.jet.material.uniforms.time.value = clock.t * 3;
  g.jet.material.uniforms.strength.value = fire;

  // Powder smoke rolling out of the muzzle and drifting off with the wind.
  const across = shotTmp.set(-ahead.z, 0, ahead.x);
  g.smoke.forEach((s, i) => {
    const p = cin.smoke[i];
    const old = since - p.delay;
    const alpha = clamp(0.8 - old * 0.45, 0, 0.8);
    s.visible = old > 0 && alpha > 0 && (fine || i % 2 === 0);
    if (!s.visible) return;
    const travel = (p.speed / 18) * (1 - Math.exp(-old * 2.4));
    s.position.copy(muzzle).addScaledVector(ahead, Math.cos(p.angle) * travel).addScaledVector(across, Math.sin(p.angle) * travel);
    s.position.y += old * (0.4 + (i % 5) * 0.22);
    s.position.x += game.wind.x * old * 0.05;
    s.position.z += game.wind.y * old * 0.05;
    s.scale.setScalar((p.size / 45) * (0.5 + old * 1.8));
    s.material.rotation = p.angle * 3;
    s.material.color.setScalar((p.shade / 170) * bright);
    s.material.opacity = alpha * Math.min(1, old * 12);
  });

  // The ball, with a thin smoke trail.
  const arc = (k, out) => {
    out.copy(muzzle).lerp(hit, k);
    out.y += Math.sin(k * Math.PI) * d * 0.045;
    return out;
  };
  const flying = since > 0 && flight < 1;
  g.ball.visible = flying;
  arc(flight, g.ball.position);
  g.ball.scale.setScalar(1 + flight * 2.5); // swells a little so the eye can follow it
  g.trail.forEach((s, i) => {
    const k = flight - (i + 1) * 0.035;
    s.visible = flying && k > 0;
    if (!s.visible) return;
    arc(k, s.position);
    s.scale.setScalar(0.7 + i * 0.35);
    s.material.color.setScalar(1.2 * bright);
    s.material.opacity = 0.4 * (1 - i / 6);
  });

  // The strike: fireball, black smoke, splinters and a column of water.
  const size = clamp(shot.length / 60, 0.7, 1.5);
  const burst = age >= 0 ? Math.max(0, 1 - age / 0.4) : 0;
  g.blast.forEach((s, i) => {
    s.visible = burst > 0;
    s.position.copy(hit).addScaledVector(ahead, -1.5 - i * 0.2);
    s.position.y += i * (1 - burst) * 3;
    s.scale.setScalar([22, 15, 20][i] * size * (1.25 - burst * 0.7));
    s.material.color.setRGB(...[[5, 4, 2.2], [7, 2.6, 0.3], [4, 0.7, 0.08]][i]);
    s.material.opacity = Math.min(1, burst * 1.6);
  });
  g.blastSmoke.forEach((s, i) => {
    s.visible = age > 0.04;
    const spread = (i / SHOT_PUFFS - 0.5) * 8 * size;
    s.position.copy(hit).addScaledVector(across, spread * (0.4 + age)).addScaledVector(ahead, -2);
    s.position.y += age * (6 + (i % 4) * 4) * size;
    s.scale.setScalar((4 + (i % 3) * 2 + age * 16) * size);
    s.material.color.setScalar((0.08 + (i % 3) * 0.05) * bright);
    s.material.opacity = clamp(0.85 - age * 0.5, 0, 0.85) * Math.min(1, age * 10);
  });
  const rise = Math.sin(clamp(age / 0.9, 0, 1) * Math.PI * 0.85);
  g.splash.forEach((s, i) => {
    s.visible = age > 0 && (fine || i % 2 === 0);
    if (!s.visible) return;
    const lane = ((i % SHOT_PUFFS) / (SHOT_PUFFS - 1) - 0.5) * 2; // -1 .. 1 along the hull
    const high = i < SHOT_PUFFS ? 1 : 0.5;
    s.position.copy(hit).addScaledVector(across, lane * (5 + age * 4) * size).addScaledVector(ahead, -2.5);
    s.position.y = o.root.position.y + rise * (11 - Math.abs(lane) * 7) * high * size;
    s.scale.set((2.5 + age * 3) * size, (3 + rise * 7 * high) * size, 1);
    s.material.color.setScalar(1.9 * bright);
    s.material.opacity = 0.75 * clamp(1.2 - age, 0, 1);
  });
  g.splinters.forEach((m, i) => {
    const u = m.userData;
    m.visible = age > 0 && (fine || i % 2 === 0);
    if (!m.visible) return;
    m.position.copy(hit).addScaledVector(ahead, -u.out * age).addScaledVector(across, u.across * age);
    m.position.y += u.up * age - 16 * age * age;
    m.rotation.set(u.spin * age, u.spin * age * 0.7, i);
    m.scale.setScalar(u.size * size);
  });

  // One of the shared lights flashes with the gun, then with the strike (the
  // light count never changes, so no shader is rebuilt).
  if (fire > 0 || burst > 0) {
    candleLight.position.copy(fire > 0 ? muzzle : hit).y += 1.5;
    if (burst > 0) candleLight.position.addScaledVector(ahead, -4);
    candleLight.intensity = fire > 0 ? 220 * fire : 600 * burst;
  } else candleLight.intensity = 0;
  renderer.toneMappingExposure += since >= 0 ? 0.45 * Math.max(0, 1 - since / 0.14) : 0;
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

// The horizon haze as the screen shows it (#bdd2e0) over SKY_HORIZON.
const SPLIT_HAZE = new THREE.Color(0xbdd2e0);
SPLIT_HAZE.setRGB(SPLIT_HAZE.r / SKY_HORIZON.r, SPLIT_HAZE.g / SKY_HORIZON.g, SPLIT_HAZE.b / SKY_HORIZON.b);

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
  scene.fog.color.copy(fogTmp.set(look.fog).lerp(night.applied ? MIST_NIGHT : STORM_HAZE, 0.8 * haze).lerp(mist, inside));
  overcastDome.visible = haze > 0.01;
  overcastDome.position.copy(cam.position);
  overcastDome.material.color.copy(scene.fog.color);
  overcastDome.material.opacity = 0.85 * haze;
  fogDome.visible = inside > 0.01;
  fogDome.position.copy(cam.position);
  fogDome.material.color.copy(scene.fog.color);
  fogDome.material.opacity = inside * FOG_INSIDE_MAX;
  // Split screen draws straight to the screen, where the haze is mixed in after
  // the tone mapping: brought down to what the sky shows, or the horizon glares.
  if (splitShown && !night.applied) scene.fog.color.multiply(SPLIT_HAZE);

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
  applyUnderwater(cam);
}

// ---------------------------------------------------------------------------
// Day / night (game.settings.nightMode). Night: moonlight from the sun's
// direction, dark sky with stars and a moon, darker sea; everything that
// glows (lava, lamps, navigation lights) stands out against it.
// ---------------------------------------------------------------------------

const night = { on: false, applied: null };
const DAY_LOOK = { fog: SKY_HORIZON, fogNear: 3200, fogFar: 15000, env: 0.7, sun: SUN_DAY, sunI: 3.1, hemi: 0.55, glint: 0xfff1d6, sea: SEA_BLUE, bloom: 0.42, beam: 0.07 };
const NIGHT_LOOK = { fog: 0x060d1c, fogNear: 2600, fogFar: 12000, env: 0.1, sun: 0x9fb6ff, sunI: 0.6, hemi: 0.14, glint: 0x2a3350, sea: 0x021626, bloom: 0.8, beam: 0.45 };
const nightSkyColor = new THREE.Color(0x050a17);
// A polar run (game.polar): cold dark water, a paler sun and whiter haze.
const POLAR_DAY = { fog: new THREE.Color().setRGB(0.85, 1.49, 2.34), fogNear: 2600, sun: 0xf2f5ff, sunI: 2.4, hemi: 0.7, glint: 0xf4f7ff, sea: 0x062f3e };
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
  cragSnow.value = on ? 1 : 0;
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
  scene.fog.color.set(look.fog);
  if (!on) skyDome.material.uniforms.horizon.value.set(look.fog); // sky meets the sea in the same haze
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
  mirrorTime(water, on);
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
// - terrain: how fine island ground meshes are (set when an island is made);
// - fine: the sharpest clouds (ensureClouds) and the strongest wind ripples on
//   the water close by (lighter on Low and Medium, none on Lowest).
// "3D Advanced" (dedicated graphics card) moves between Extreme and Ultra;
// "3D Automatic" moves between Ultra and Lowest, starting from what the
// graphics chip suggests, and climbs whenever the frame rate has headroom.
const QUALITY_LEVELS = [
  { name: "Extreme", ss: 1.5, maxRatio: 3, msaa: 8, shadows: true, shadowSize: 8192, aniso: 16, bloom: true, townGlow: true, traffic: 1, foam: 1, terrain: 3, fine: true },
  { name: "Ultra", ss: 1.25, maxRatio: 2.5, msaa: 4, shadows: true, shadowSize: 4096, aniso: 16, bloom: true, townGlow: true, traffic: 1, foam: 1, terrain: 2.5, fine: true },
  { name: "High", ss: 1, maxRatio: 1.5, msaa: 4, shadows: true, shadowSize: 2048, aniso: 8, bloom: true, townGlow: true, traffic: 1, foam: 0.8, terrain: 2, fine: true },
  { name: "Medium", ss: 1, maxRatio: 1, msaa: 2, shadows: true, shadowSize: 2048, aniso: 4, bloom: true, townGlow: false, traffic: 0.7, foam: 0.6, terrain: 1.5, fine: false },
  { name: "Low", ss: 1, maxRatio: 0.8, msaa: 0, shadows: false, shadowSize: 2048, aniso: 2, bloom: true, townGlow: false, traffic: 0.5, foam: 0.4, terrain: 1.2, fine: false },
  { name: "Lowest", ss: 1, maxRatio: 0.6, msaa: 0, shadows: false, shadowSize: 2048, aniso: 1, bloom: false, townGlow: false, traffic: 0.35, foam: 0.25, terrain: 1, fine: false }
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
  // while the graphics check tries the levels, any clouds will do
  ensureClouds(graphicsCheck.running ? QUALITY_LEVELS.length - 1 : level);
  water.material.uniforms.seaDetail.value = q.fine ? 1 : level === QUALITY_LEVELS.length - 1 ? 0 : 0.7;
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
const GRAPHICS_KEY = "harbour-run-graphics-v3";
const CHECK_WARMUP_MS = 600; // after switching level (shaders compiling): not measured
const CHECK_WARMUP_FRAMES = 6;
const CHECK_MEASURE_MS = 1000;
const CHECK_MEASURE_FRAMES = 3; // a very slow level is still judged quickly
const CHECK_SMOOTH_SHARE = 0.85; // a level passes at this share of the device's top speed...
const CHECK_FPS_GOAL = 55; // ...or at this frame rate, whichever is lower
const graphicsCheck = { running: false, waiting: false, order: [], at: 0, phase: "", since: 0, last: 0, frames: [], ceiling: 0, results: {} };
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
  setLoadingStatus("Checking your graphics... (first start only)");
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
  setLoadingStatus("Loading... please wait");
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

function project(x, y, lift = 0, slot) {
  let cam = camera;
  let left = 0;
  let width = 1;
  if (splitShown) {
    // A label belongs to the half of whichever player is closer to it.
    const p1 = game.player1;
    const p2 = game.player2;
    // ... unless the caller says whose it is (a navigator's course).
    const second = slot ? slot === "p2" : Math.hypot(x - p2.x, y - p2.y) < Math.hypot(x - p1.x, y - p1.y);
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

// The graphics chip builds a shader the first time something is drawn, which
// holds the picture up for a moment: at the start of a voyage, at the first
// eruption, the first wake. So one of each is drawn once behind the loading
// screen (and again after a change of graphics level). The samples are kept, so
// their shaders are too.
const warm = { samples: null, level: -1 };

function warmUpSamples() {
  if (!warm.samples) {
    const at = { x: HALF_W, y: HALF_H, tx: HALF_W, ty: HALF_H, turn: 0 };
    const rock = createRock(at);
    const wake = createWake();
    const made = [
      ...["island", "volcano", "iceberg"].map((kind) => createHazard({ ...at, kind, r: 40, danger: 60 })),
      createShip({ type: "pirate", angle: 0, displayColor: "#f0d034" }),
      createShip({ type: "cruise", category: "Tug", displayColor: "#ee4a16", angle: 0 }), // the modelled tug, once loaded
      createCreature(at),
      createSub({ ...at, kind: "uboat", color: "#334455", radius: 14 }),
      createMissile({ ...at, kind: "laser" }),
      createMissile({ ...at, kind: "sonic" }),
      createLavaPool(at),
      createStorm({ ...at, r: 60 }),
      createFogBank({ ...at, r: 300 }),
      rock
    ];
    warm.samples = new THREE.Group();
    warm.samples.add(makeFishMesh(1));
    warm.samples.add(...made.map((o) => o.root), rock.ring,wake.mesh, makeShipFlame(), makeSmokePuff());
    warm.samples.add(mesh(ropeGeometry([{ curve: new THREE.LineCurve3(new THREE.Vector3(HALF_W - 5, 2, 0), new THREE.Vector3(HALF_W + 5, 2, 0)), r: 0.3 }]), hempMat));
    warm.samples.traverse((c) => (c.frustumCulled = false));
  }
  return warm.samples;
}

function renderFrame(dt) {
  ropeAir.time.value = performance.now() / 1000;
  ropeAir.wind.value = game.wind ? 0.5 + Math.min(1, Math.hypot(game.wind.x, game.wind.y) / 34) : 1;
  // The shop is the 3D dockyard; every other screen is the sea.
  if (gameState === "shop" && game.dock) {
    // Building the dock holds everything up, so the first two frames after the
    // button only let the "please wait" splash get onto the screen.
    if (game.dock.waited < 2) game.dock.waited += 1;
    else renderDockyard(dt);
    measure();
    return;
  }
  if (stepEraChange()) {
    measure();
    return;
  }
  composer.passes[0].scene = scene;
  composer.passes[0].camera = camera;
  renderer.toneMappingExposure = 0.5;
  bloomPass.strength = lookFor(night.on).bloom;
  bloomPass.enabled = QUALITY_LEVELS[perf.level].bloom; // the dockyard may have left it off
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
  updateWakes(dt);
  updateWash(dt);
  syncEntities(hazardObjects, hazards, createHazard, updateHazard, dt);
  syncEntities(stormObjects, dynamicDangers, createStorm, updateStorm, dt);
  updateTempestSky(dt);
  updateGulls(dt);
  updateFish(dt);
  syncEntities(creatureObjects,game.seaCreatures, createCreature, updateCreature, dt);
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
  updateOldPorts(dt);
  updateBuoys();
  updateMissionScene();

  water.material.uniforms.time.value += dt * 0.55;
  driftClouds(skyDome, dt);
  volcanoGlow.light.intensity = volcanoGlow.strength * (90 + Math.random() * 40);
  updateUnderwater(dt);
  updateCamera(dt);
  updateCannonShot();
  nightSky.position.copy(camera.position);
  renderer.shadowMap.needsUpdate = true;
  const warming = warm.level !== perf.level && !graphicsCheck.running && !splitShown ? warmUpSamples() : null;
  if (warming) {
    scene.add(warming);
    readyGunShot();
    showGunShot(true);
  }
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
  if (warming) {
    scene.remove(warming);
    if (!shot) showGunShot(false);
    warm.level = perf.level;
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
    // the modelled concrete shows two slabs each way, and carries its own relief
    const relief = tex.userData.relief;
    const copy = (source) => {
      const t = source.clone();
      t.repeat.set(w / tile / (relief ? 2 : 1), h / tile / (relief ? 2 : 1));
      t.needsUpdate = true;
      return t;
    };
    const t = copy(tex);
    const surface = !dkq.bump ? {} // the lighter levels show the concrete flat: relief costs on every pixel
      : relief ? { normalMap: copy(relief.normalMap), roughnessMap: copy(relief.roughnessMap), roughness: 1 }
      : { bumpMap: t, bumpScale: 1.6 };
    tiledCache.set(key, new THREE.MeshStandardMaterial({ map: t, roughness: 0.95, metalness: 0, ...surface, ...extra }));
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
  const concrete = dockModels ? dockModels.concrete : dockTexture(256, (c, s) => {
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
    // period clothes and pitch for the shipwrights who work on the carrack
    linen: mat(0xcdbf9f, { roughness: 0.95 }),
    leather: mat(0x7a4a2a, { roughness: 0.9 }),
    hose: mat(0x3b2a1c, { roughness: 0.95 }),
    pitch: mat(0x0d0a08, { roughness: 0.2, metalness: 0.2 }),
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

// A 16th-century shipwright: tunic, hose and a soft cap, a caulking iron held
// out in one hand and a mallet in the other. `arm` swings from the shoulder.
function makeShipwright(R, tunic, tools = true) {
  const g = new THREE.Group();
  const skin = R() > 0.5 ? DM.skinA : DM.skinB;
  for (const x of [-0.05, 0.05]) g.add(box(0.075, 0.27, 0.09, DM.hose, x, 0.135, 0));
  g.add(box(0.2, 0.27, 0.12, tunic, 0, 0.39, 0));
  const head = mesh(SphG(0.06, 10, 8), skin);
  head.position.y = 0.59;
  const cap = mesh(SphG(0.08, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), DM.hose);
  cap.position.y = 0.61;
  cap.scale.y = 0.6;
  g.add(head, cap);
  if (tools) g.add(box(0.05, 0.06, 0.24, tunic, -0.125, 0.46, 0.11), box(0.025, 0.025, 0.2, DM.darkSteel, -0.09, 0.45, 0.31));
  else g.add(box(0.05, 0.22, 0.06, tunic, -0.125, 0.4, 0));
  const arm = new THREE.Group();
  arm.position.set(0.125, 0.5, 0);
  if (tools) arm.add(box(0.05, 0.06, 0.22, tunic, 0, 0, 0.11), box(0.025, 0.025, 0.14, DM.timber, 0, 0, 0.27), box(0.18, 0.09, 0.09, DM.wood, -0.05, 0, 0.34));
  else arm.add(box(0.05, 0.22, 0.06, tunic, 0, -0.1, 0));
  g.add(arm);
  g.scale.setScalar(1.7);
  return { g, arm };
}

// The cauldron of pitch kept hot over a wood fire, for sealing the seams.
function makePitchPot() {
  const g = new THREE.Group();
  g.add(mesh(CylG(0.95, 0.65, 1.1, 16), DM.darkSteel));
  g.children[0].position.y = 1.05;
  const rim = mesh(new THREE.TorusGeometry(0.95, 0.09, 8, 24).rotateX(Math.PI / 2), DM.darkSteel);
  rim.position.y = 1.6;
  const top = mesh(new THREE.CircleGeometry(0.9, 24).rotateX(-Math.PI / 2), DM.pitch, false);
  top.position.y = 1.62;
  g.add(rim, top);
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3;
    g.add(box(0.45, 0.55, 0.45, DM.concreteBit, Math.cos(a) * 0.85, 0.28, Math.sin(a) * 0.85)); // hearth stones
    const log = box(2.1, 0.2, 0.22, DM.timber, 0, 0.13 + i * 0.03, 0);
    log.rotation.y = a + 0.5;
    g.add(log);
  }
  const sprite = (map, color, blending) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, color, blending, transparent: true, depthWrite: false, opacity: 0 }));
    g.add(s);
    return s;
  };
  const flames = [0, 1, 2, 3, 4, 5].map(() => sprite(glowSoft, 0xff8a24, THREE.AdditiveBlending));
  const smoke = [0, 1, 2, 3, 4, 5, 6].map((i) => sprite(cloudPuffTex[i % cloudPuffTex.length], 0x8d877e, THREE.NormalBlending));
  return { group: g, flames, smoke };
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
  Object.assign(g.userData, { axles: [-2, -0.7, 2], track: 0.95, ends: [2.9, -2.7] }); // where its wheels meet the road, and its nose and tail
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
  Object.assign(g.userData, { axles: [3.1, -1.8, -3.0, -4.2], track: 0.95, ends: [4.4, -5.2] });
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
  Object.assign(g.userData, { axles: [0.45, -0.5], track: 0.5, ends: [1.9, -1.3] });
  return g;
}

// Crane that rolls on rails along the dock; it carries a trolley and a hook.
function makePortalCrane(carry) {
  const g = new THREE.Group();
  const H = 58;
  const SZ = 28;
  const BASE = 6;
  if (dockModels) return modelledCrane(g, carry, H, SZ);
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
  craneLamps(g, H, SZ);
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
  mergeStaticMeshes(hook, new Set());
  mergeStaticMeshes(trolley, new Set([hook, cable]));
  mergeStaticMeshes(g, new Set([trolley]));
  return { group: g, trolley, hook, cable, H, SZ };
}

// The red warning lamps on the ends of a gantry crane.
function craneLamps(g, H, SZ) {
  for (const [x, z] of [[-3.4, -SZ - 3], [3.4, -SZ - 3], [-3.4, SZ + 3], [3.4, SZ + 3]]) {
    const lamp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowStar, color: 0xff2a1a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    lamp.scale.setScalar(3);
    lamp.position.set(x, H + 4.6, z);
    g.add(lamp);
    dock3.blink.push(lamp);
  }
}

// makePortalCrane with the modelled parts: the same moving pieces in the same places.
function modelledCrane(g, carry, H, SZ) {
  const [frame, carriage, block, load] = dockModels.crane.parts.map((geometry) => mesh(geometry, dockModels.crane.material));
  g.add(frame);
  craneLamps(g, H, SZ);
  const trolley = new THREE.Group();
  const cable = mesh(CylG(0.1, 0.1, 1, 6), DM.darkSteel);
  const hook = new THREE.Group();
  hook.add(block);
  if (carry) hook.add(load);
  trolley.add(carriage, cable, hook);
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
  const along = Array.from({ length: 13 }, (_, i) => -60 + i * 10);
  if (dockModels) S.add(propRow("bollard", [-1, 1].flatMap((s) => along.map((x) => [x, Q, s * (hw + 3.2)]))));
  for (const s of [-1, 1]) {
    for (let x = -60; x <= 60 && !dockModels; x += 10) {
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

// Draws a mirror picture of the dock. It is a whole second drawing of the yard,
// so the lighter levels leave out of it what its small size can hardly show:
// the modelled props, and the detail of the modelled ships (their plain
// stand-ins are mirrored instead).
function mirrorDock(draw) {
  if (dkq.detail) return draw();
  const ships = [dock3.ship, dock3.leaving?.o].filter((o) => o?.proxy);
  const hidden = [dockModels?.propsMaterial, ...ships.flatMap((o) => o.mats)].filter(Boolean);
  for (const m of hidden) m.visible = false;
  for (const o of ships) o.proxy.visible = true;
  draw();
  for (const m of hidden) m.visible = true;
  for (const o of ships) o.proxy.visible = false;
}

function buildDockSea(S, T, R) {
  const { Q, GX } = DK;
  const normals = new THREE.TextureLoader().load("vendor/three/textures/waternormals.jpg", (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
  });
  const sea = trueWater(new Water(new THREE.PlaneGeometry(9000, 9000), {
    textureWidth: dkq.reflect, textureHeight: dkq.reflect, waterNormals: normals, sunDirection: sunDir.clone(), sunColor: 0xfff1d6,
    waterColor: SEA_BLUE, distortionScale: 3.8, fog: true
  }));
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(62 + 4500, 0, 0);
  sea.material.uniforms.size.value = 0.9;
  dockScene.add(sea);
  dock3.sea = sea;
  // the water inside the dock; it rises and falls. It is the same kind of water as the open sea
  // (same colour, ripples and sky mirror), so the two meet at the gate without a seam.
  const basin = trueWater(new Water(new THREE.PlaneGeometry(DK.L - 2.7, DK.W - 0.4), {
    textureWidth: Math.max(256, dkq.reflect / 2), textureHeight: Math.max(256, dkq.reflect / 2), waterNormals: normals,
    sunDirection: sunDir.clone(), sunColor: 0xfff1d6, waterColor: SEA_BLUE, distortionScale: 3.8, fog: true, alpha: 1
  }));
  basin.rotation.x = -Math.PI / 2;
  basin.material.uniforms.size.value = 0.9;
  basin.material.fragmentShader = sea.material.fragmentShader;
  basin.material.transparent = true; // thins out over the last bit of depth as the dock empties
  basin.position.x = -1.35;
  dockScene.add(basin);
  dock3.basin = basin;
  // Flooded to sea level, the dock water lies in the same plane as the open sea, so the sea's mirror is
  // exactly the dock's too: it is reused instead of drawing the whole scene a third time.
  const seaMirror = sea.onBeforeRender;
  sea.onBeforeRender = (...args) => {
    mirrorDock(() => seaMirror.apply(sea, args));
    dock3.seaMirrorFrame = dock3.frame;
  };
  const basinMirror = basin.onBeforeRender;
  const own = { sampler: basin.material.uniforms.mirrorSampler.value, matrix: basin.material.uniforms.textureMatrix.value };
  basin.onBeforeRender = (...args) => {
    const mine = basin.material.uniforms;
    const theirs = sea.material.uniforms;
    const level = Math.abs(dock3.level) < 0.05 && dock3.seaMirrorFrame === dock3.frame;
    mine.mirrorSampler.value = level ? theirs.mirrorSampler.value : own.sampler;
    mine.textureMatrix.value = level ? theirs.textureMatrix.value : own.matrix;
    if (level) mine.eye.value.copy(theirs.eye.value);
    else mirrorDock(() => basinMirror.apply(basin, args));
  };
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
    hill.userData.nature = true;
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
  if (dockModels) S.add(propRow("bollard", [-1, 1].flatMap((s) => Array.from({ length: 10 }, (_, i) => [GX - 1.5, Q, s * (30 + i * 12)]))));
  for (const s of dockModels ? [] : [-1, 1]) for (let z = 30; z < 140; z += 12) {
    const b = mesh(CylG(0.34, 0.42, 0.7, 10), DM.darkSteel);
    b.position.set(GX - 1.5, Q + 0.35, s * z);
    S.add(b);
  }
  const moored = (category, color, x, z, yaw) => {
    // moored in the distance: the plain build is enough
    const o = createShip({ type: "cruise", category, displayColor: color, angle: 0, plain: true });
    o.root.position.set(x, 0, z);
    o.root.rotation.y = yaw;
    slimDockShip(o);
    dockScene.add(o.root);
    o.baseY = 0;
    dock3.movers.push(o);
    dock3.obstacles.push({ x, z, r: o.halfLen * 1.25 });
    return o;
  };
  moored("Tug", "#ee4a16", GX + 7, 70, -Math.PI / 2);
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
    isle.userData.nature = true;
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
  const crates = new THREE.InstancedMesh(...propLook("crate", new THREE.BoxGeometry(1, 1, 1), DM.wood), nCrates);
  for (let i = 0; i < nCrates; i++) {
    const [x, z] = spot();
    const sc = 0.7 + R() * 1.4;
    place(crates, i, x, Q + sc / 2, z, R() * 3, sc, sc * (0.7 + R() * 0.5), sc);
  }
  crates.castShadow = crates.receiveShadow = true;
  S.add(crates);
  const cones = new THREE.InstancedMesh(...propLook("cone", new THREE.ConeGeometry(0.22, 0.6, 8), mat(0xff6a10, { roughness: 0.6 })), dkn(60));
  for (let i = 0; i < dkn(60); i++) {
    const [x, z] = spot();
    place(cones, i, x, Q + 0.3, z, 0);
  }
  cones.castShadow = true;
  S.add(cones);
  const bottles = new THREE.InstancedMesh(...propLook("bottle", CylG(0.16, 0.16, 1.1, 10), mat(0xffffff, { roughness: 0.4, metalness: 0.5 })), Math.min(40, dkn(40)));
  for (let i = 0; i < Math.min(40, dkn(40)); i++) {
    const g = Math.floor(i / 5);
    const bx = -50 + g * 14;
    const side = g % 2 ? 1 : -1;
    place(bottles, i, bx + (i % 5) * 0.4, Q + 0.55, side * 32.6 + (i % 2) * 0.4, 0);
    bottles.setColorAt(i, new THREE.Color(i % 3 ? 0xb3261e : 0x1d4f9c));
  }
  bottles.castShadow = true;
  S.add(bottles);
  const barriers = new THREE.InstancedMesh(...propLook("barrier", new THREE.BoxGeometry(2.4, 0.8, 0.3), mat(0xf0f0ec, { roughness: 0.6 })), Math.min(36, dkn(36)));
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
  if (dkq.wet) buildWetQuay(R);
}

// ---- Rain puddles on the quay (Ultra and Extreme) -----------------------
// Each puddle has a ragged outline of its own, with damp concrete round it,
// and mirrors the sky. A lorry's wheels throw spray and set ripples going as
// they cross one, and come out wet, leaving tyre tracks that fade away.
const PUDDLE_SIZE = 256;
const TRACK_MARKS = 900; // pieces of tyre track on the ground at once
const TRACK_STEP = 0.6; // length of a piece
const TRACK_WET_RUN = 30; // how far a wet tyre prints before it is dry
const TRACK_LIFE = 16; // seconds before a print has dried
const SPRAY_DROPS = 2400;
const puddlePictures = [];

// The picture of puddle shape number `n`: dark water (nearly mirror smooth)
// with ragged edges and stray splashes, inside a ring of damp ground.
function puddlePicture(n) {
  if (puddlePictures[n]) return puddlePictures[n];
  const size = PUDDLE_SIZE;
  const canvases = [0, 1].map(() => Object.assign(document.createElement("canvas"), { width: size, height: size }));
  const [colour, rough] = canvases.map((c) => c.getContext("2d").createImageData(size, size));
  const water = new Uint8Array(size * size);
  const seed = 31 + n * 17;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i / (size - 1)) * 2 - 1;
      const y = (j / (size - 1)) * 2 - 1;
      // the outline: a lopsided patch, pulled about by noise at two sizes
      const wx = x + (fbm2(x * 1.7 + 5, y * 1.7, seed, 3) - 0.5) * 0.75;
      const wy = y + (fbm2(x * 1.7, y * 1.7 + 9, seed + 1, 3) - 0.5) * 0.75;
      const level = 0.8 - Math.hypot(wx, wy * 1.15) + (fbm2(x * 4.3, y * 4.3, seed + 2, 4) - 0.5) * 0.85;
      const inside = 1 - smoothstep(0.8, 0.99, Math.max(Math.abs(x), Math.abs(y))); // clear of the picture's edge
      const wet = smoothstep(0.17, 0.215, level) * inside;
      const damp = smoothstep(-0.2, 0.2, level + (fbm2(x * 9, y * 9, seed + 3, 3) - 0.5) * 0.45) * inside;
      const at = (j * size + i) * 4;
      const shade = fbm2(x * 6, y * 6, seed + 4, 3);
      const rgb = wet > 0.5 ? [16 + shade * 12, 34 + shade * 14, 48 + shade * 16] : [34, 33, 31];
      colour.data.set([...rgb, 255 * Math.max(wet * (0.82 + 0.13 * smoothstep(0.2, 0.5, level)), damp * (0.3 + 0.3 * shade))], at);
      const matt = wet * 6 + (1 - wet) * (105 + shade * 90);
      rough.data.set([matt, matt, matt, 255], at);
      water[j * size + i] = wet > 0.5 ? 1 : 0;
    }
  }
  const textures = [colour, rough].map((data, k) => {
    canvases[k].getContext("2d").putImageData(data, 0, 0);
    const t = new THREE.CanvasTexture(canvases[k]);
    t.colorSpace = k === 0 ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return t;
  });
  const material = shared(new THREE.MeshStandardMaterial({ map: textures[0], roughnessMap: textures[1], roughness: 1, metalness: 0.45, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  puddlePictures[n] = { material, water };
  return puddlePictures[n];
}

const puddleGeo = shared(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2));

const TRACK_VERTEX = `
attribute float born;
attribute float wetness;
uniform float time;
varying vec2 vUv;
varying float vWet;
varying vec3 vAway;
void main() {
  vUv = uv;
  vWet = wetness * clamp(1.0 - (time - born) / ${TRACK_LIFE.toFixed(1)}, 0.0, 1.0);
  vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vAway = world.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;
const TRACK_FRAGMENT = `
varying vec2 vUv;
varying float vWet;
varying vec3 vAway;
void main() {
  // a tyre's print: two ribs at the edges and slanting blocks between
  float side = abs(vUv.y - 0.5) * 2.0;
  float block = smoothstep(0.28, 0.4, fract(vUv.x * 2.0 + side * 0.65));
  float tread = side > 0.72 ? 0.9 : side < 0.1 ? 0.25 : 0.3 + 0.7 * block;
  tread *= 1.0 - smoothstep(0.86, 1.0, side);
  float glance = pow(1.0 - abs(normalize(vAway).y), 3.0); // wet ground shines at a slant
  vec3 col = mix(vec3(0.006, 0.009, 0.012), vec3(0.45, 0.6, 0.8), glance * 0.8);
  gl_FragColor = vec4(col, vWet * tread * 0.78);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function buildWetQuay(R) {
  const { Q, W } = DK;
  const hw = W / 2;
  const wet = { puddles: [], next: 0, drop: 0, mistNext: 0, rippleNext: 0, trucks: new Map() };
  const add = (x, z, size) => {
    const picture = puddlePicture(wet.puddles.length % 7);
    const p = new THREE.Mesh(puddleGeo, picture.material);
    p.scale.set(size * (1.1 + R() * 0.7), 1, size * (0.7 + R() * 0.45));
    p.rotation.y = R() * Math.PI * 2;
    p.position.set(x, Q + 0.06 + wet.puddles.length * 0.0004, z);
    p.receiveShadow = true;
    p.renderOrder = 1;
    dockScene.add(p);
    wet.puddles.push({ x, z, reach: Math.max(p.scale.x, p.scale.z), cos: Math.cos(p.rotation.y), sin: Math.sin(p.rotation.y), sx: p.scale.x, sz: p.scale.z, water: picture.water });
  };
  // in the lorries' wheel tracks: the two quay lanes and the two service roads, each side
  for (const lane of [36.3, 39.7, -36.3, -39.7]) for (const from of [-52, -12, 24]) add(from + R() * 22, lane + (R() - 0.5) * 1.6, 1.7 + R() * 1.7);
  for (const lane of [46.3, -46.3, 49.7, -49.7]) add(-55 + R() * 90, lane + (R() - 0.5) * 1.4, 1.5 + R() * 1.5);
  // and lying about the quay
  for (let i = 0; i < 14; i++) add(-58 + R() * 116, (R() > 0.5 ? 1 : -1) * (hw + 5 + R() * 18), 1.2 + R() * 2.6);

  const trackGeo = new THREE.PlaneGeometry(TRACK_STEP * 1.04, 0.44).rotateX(-Math.PI / 2);
  wet.born = new THREE.InstancedBufferAttribute(new Float32Array(TRACK_MARKS).fill(-1000), 1);
  wet.wetness = new THREE.InstancedBufferAttribute(new Float32Array(TRACK_MARKS), 1);
  trackGeo.setAttribute("born", wet.born);
  trackGeo.setAttribute("wetness", wet.wetness);
  wet.tracks = new THREE.InstancedMesh(trackGeo, new THREE.ShaderMaterial({
    vertexShader: TRACK_VERTEX, fragmentShader: TRACK_FRAGMENT, uniforms: { time: { value: 0 } },
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5
  }), TRACK_MARKS);
  wet.tracks.renderOrder = 2;
  wet.tracks.frustumCulled = false;
  const nowhere = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < TRACK_MARKS; i++) wet.tracks.setMatrixAt(i, nowhere);
  dockScene.add(wet.tracks);

  const drops = new THREE.BufferGeometry();
  drops.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SPRAY_DROPS * 3).fill(-500), 3));
  wet.spray = new THREE.Points(drops, new THREE.PointsMaterial({ map: dotTex, color: 0xe4eef5, size: 0.5, transparent: true, opacity: 0.95, depthWrite: false }));
  wet.spray.frustumCulled = false;
  wet.speeds = Array.from({ length: SPRAY_DROPS }, () => ({ x: 0, y: 0, z: 0, life: 0 }));
  dockScene.add(wet.spray);
  wet.mist = Array.from({ length: 40 }, (_, i) => {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudPuffTex[i % cloudPuffTex.length], color: 0xdbe6ee, transparent: true, opacity: 0, depthWrite: false }));
    m.userData = { age: 9, drift: new THREE.Vector3() };
    dockScene.add(m);
    return m;
  });
  const ringGeo = new THREE.RingGeometry(0.88, 1, 40).rotateX(-Math.PI / 2);
  wet.ripples = Array.from({ length: 36 }, () => {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xbfd6e6, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }));
    m.userData.age = 9;
    m.renderOrder = 2;
    dockScene.add(m);
    return m;
  });
  dock3.wet = wet;
}

// Whether a point on the quay is under water.
function inPuddle(wet, x, z) {
  return wet.puddles.some((p) => {
    const dx = x - p.x;
    const dz = z - p.z;
    if (Math.abs(dx) > p.reach * 1.5 || Math.abs(dz) > p.reach * 1.5) return false;
    const u = (p.cos * dx - p.sin * dz) / p.sx; // in the puddle's own frame, -1..1
    const v = (p.sin * dx + p.cos * dz) / p.sz;
    if (Math.abs(u) >= 1 || Math.abs(v) >= 1) return false;
    const last = PUDDLE_SIZE - 1;
    return p.water[Math.round(((v + 1) / 2) * last) * PUDDLE_SIZE + Math.round(((u + 1) / 2) * last)] === 1;
  });
}

const trackSize = new THREE.Vector3();

function updateWetQuay(dt) {
  const wet = dock3.wet;
  if (!wet) return;
  const T = dock3.time;
  const { Q } = DK;
  wet.tracks.material.uniforms.time.value = T;
  const position = wet.spray.geometry.attributes.position;
  const m4 = new THREE.Matrix4();
  let printed = false;
  for (const m of dock3.movers) {
    const axles = m.route && m.root.userData.axles;
    if (!axles) continue;
    let state = wet.trucks.get(m);
    if (!state) wet.trucks.set(m, (state = { wet: [0, 0], last: [null, null] }));
    const scale = m.root.scale.x;
    const { x, z } = m.root.position;
    const fx = Math.cos(m.root.rotation.y); // which way it points
    const fz = -Math.sin(m.root.rotation.y);
    [-1, 1].forEach((side, k) => {
      const out = side * m.root.userData.track;
      const wheel = (axle) => [x + (fx * axle - fz * out) * scale, z + (fz * axle + fx * out) * scale];
      for (const axle of axles) {
        const [wx, wz] = wheel(axle);
        if (m.v < 0.3 || !inPuddle(wet, wx, wz)) continue;
        state.wet[k] = 1;
        // spray thrown up and out from the wheel, dragged along behind it
        for (let n = m.v * dt * 26 + Math.random(); n >= 1; n--) {
          const i = (wet.drop = (wet.drop + 1) % SPRAY_DROPS);
          const v = wet.speeds[i];
          const ahead = m.v * (0.15 + Math.random() * 0.65);
          const aside = side * (0.6 + Math.random() * 4.5) * Math.min(1, m.v / 5);
          v.x = fx * ahead - fz * aside;
          v.z = fz * ahead + fx * aside;
          v.y = 1.2 + Math.random() * (2.4 + m.v * 0.7);
          v.life = 1;
          const back = 0.2 + Math.random() * 0.6;
          position.setXYZ(i, wx - fx * back, Q + 0.12, wz - fz * back);
        }
        if (Math.random() < dt * m.v * 2.2) {
          const puff = wet.mist[(wet.mistNext = (wet.mistNext + 1) % wet.mist.length)];
          puff.userData.age = 0;
          puff.position.set(wx - fx * 0.8, Q + 0.5, wz - fz * 0.8);
          puff.userData.drift.set(fx * m.v * 0.3 - fz * side * 1.1, 0.7, fz * m.v * 0.3 + fx * side * 1.1);
        }
        if (Math.random() < dt * 5) {
          const ring = wet.ripples[(wet.rippleNext = (wet.rippleNext + 1) % wet.ripples.length)];
          ring.userData.age = 0;
          ring.position.set(wx + (Math.random() - 0.5), Q + 0.085, wz + (Math.random() - 0.5));
        }
      }
      // the rearmost wheels print the track, piece by piece along their curve
      const here = wheel(Math.min(...axles));
      const last = state.last[k];
      if (!last) {
        state.last[k] = here;
        return;
      }
      const dx = here[0] - last[0];
      const dz = here[1] - last[1];
      const run = Math.hypot(dx, dz);
      if (run < TRACK_STEP) return;
      state.last[k] = here;
      const midX = last[0] + dx / 2;
      const midZ = last[1] + dz / 2;
      if (run > 4 || state.wet[k] <= 0.02 || inPuddle(wet, midX, midZ)) return;
      const i = (wet.next = (wet.next + 1) % TRACK_MARKS);
      m4.makeRotationY(Math.atan2(-dz, dx)).scale(trackSize.set(run / TRACK_STEP, 1, scale)).setPosition(midX, Q + 0.07, midZ);
      wet.tracks.setMatrixAt(i, m4);
      wet.born.setX(i, T);
      wet.wetness.setX(i, state.wet[k] ** 0.7);
      state.wet[k] -= run / TRACK_WET_RUN;
      printed = true;
    });
  }
  if (printed) wet.tracks.instanceMatrix.needsUpdate = wet.born.needsUpdate = wet.wetness.needsUpdate = true;
  wet.speeds.forEach((v, i) => {
    if (v.life <= 0) return;
    v.life -= dt;
    v.y -= 14 * dt;
    const y = position.getY(i) + v.y * dt;
    if (y < Q + 0.05 || v.life <= 0) {
      v.life = 0;
      position.setY(i, -500);
    } else position.setXYZ(i, position.getX(i) + v.x * dt, y, position.getZ(i) + v.z * dt);
  });
  position.needsUpdate = true;
  for (const puff of wet.mist) {
    const u = puff.userData;
    u.age += dt;
    const k = Math.min(1, u.age / 0.8);
    puff.position.addScaledVector(u.drift, dt * (1 - k));
    puff.scale.setScalar(1.1 + k * 3.8);
    puff.material.opacity = k < 1 ? 0.5 * (1 - k) * Math.min(1, k * 6) : 0;
  }
  for (const ring of wet.ripples) {
    ring.userData.age += dt;
    const k = Math.min(1, ring.userData.age / 1.1);
    ring.scale.setScalar(0.25 + k * 1.9);
    ring.material.opacity = k < 1 ? 0.5 * (1 - k) ** 2 : 0;
  }
}

// ---- Lorry routes ----------------------------------------------------------
// A lorry drives a closed loop: out along one lane, a wide turning circle at
// the end, back along the other, and round again. Where something stands in a
// lane the route swings round it in a long curve, always away from the other
// lane, so lorries meeting never share road; behind a slower one a lorry slows
// and queues.
const LORRY_LANE = 1.7; // each lane this far from the middle of the road
const LORRY_CLEAR = 1.45; // from a lorry's middle line to anything beside it
const ROUTE_STEP = 0.5;

// Everything standing on the quay that a lorry could run into, as floor
// rectangles [x from, x to, z from, z to].
function quaySolids(roots) {
  const { Q } = DK;
  const solids = [];
  const bounds = new THREE.Box3();
  const place = new THREE.Matrix4();
  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      for (let i = 0; i < (o.isInstancedMesh ? o.count : 1); i++) {
        bounds.copy(o.geometry.boundingBox);
        if (o.isInstancedMesh) {
          o.getMatrixAt(i, place);
          bounds.applyMatrix4(place);
        }
        bounds.applyMatrix4(o.matrixWorld);
        // flat things (road paint, rails, cables) and anything overhead don't count
        if (bounds.max.y > Q + 0.3 && bounds.min.y < Q + 2.5) solids.push([bounds.min.x, bounds.max.x, bounds.min.z, bounds.max.z]);
      }
    });
  }
  return solids;
}

// The loop round the road whose middle is z0, between x0 and x1, bent clear of `solids`.
function lorryRoute(z0, x0, x1, solids) {
  const a = z0 - LORRY_LANE;
  const b = z0 + LORRY_LANE;
  const turn = (x, way, from, to) => [[x + way * 4, from + (from - z0) * 1.25], [x + way * 8, from + (from - z0) * 0.45], [x + way * 9.2, z0], [x + way * 8, to + (to - z0) * 0.45], [x + way * 4, to + (to - z0) * 1.25]].map(([px, pz]) => [px, pz, 0]);
  const marks = []; // [x, z, leg]: -1 the lane out, 1 the lane back, 0 turning
  for (let x = x0; x < x1 - 1.5; x += 3) marks.push([x, a, -1]);
  marks.push([x1, a, -1], ...turn(x1, 1, a, b));
  for (let x = x1; x > x0 + 1.5; x -= 3) marks.push([x, b, 1]);
  marks.push([x0, b, 1], ...turn(x0, -1, b, a));
  const smooth = new THREE.CatmullRomCurve3(marks.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, "centripetal");
  const length = smooth.getLength();
  const count = Math.round(length / ROUTE_STEP);
  const points = smooth.getSpacedPoints(count).slice(0, count).map((p) => {
    let leg = 0;
    if (p.x >= x0 - 0.1 && p.x <= x1 + 0.1) leg = p.z < z0 ? -1 : 1;
    return { x: p.x, z: p.z, leg };
  });
  // Which way each point may give: straight lanes away from the other lane,
  // turning circles outwards from their middle.
  for (const p of points) {
    const dx = p.leg ? 0 : p.x - (p.x > x1 ? x1 : x0);
    const dz = p.leg ? p.leg : p.z - z0;
    const size = Math.hypot(dx, dz) || 1;
    Object.assign(p, { dx: dx / size, dz: dz / size, shift: 0 });
  }
  const near = solids.filter(([ax, bx, az, bz]) => bx > x0 - 20 && ax < x1 + 20 && bz > z0 - 14 && az < z0 + 14);
  const blocked = (x, z) => near.some(([ax, bx, az, bz]) => x > ax - LORRY_CLEAR && x < bx + LORRY_CLEAR && z > az - LORRY_CLEAR && z < bz + LORRY_CLEAR);
  // Move each point clear, then ease into and out of every swerve over a
  // lorry's length or two, and look again at where that has put it.
  const reach = Math.round(16 / ROUTE_STEP);
  const flat = Math.round(4 / ROUTE_STEP); // held while the whole lorry goes by
  for (let round = 0; round < 3; round++) {
    const need = points.map((p) => {
      let t = p.shift;
      while (t < 9 && blocked(p.x + p.dx * t, p.z + p.dz * t)) t += 0.2;
      return t < 9 ? t : p.shift;
    });
    points.forEach((p, i) => {
      for (let k = -reach; k <= reach; k++) {
        const d = Math.abs(k);
        const weight = d <= flat ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (d - flat)) / (reach - flat));
        p.shift = Math.max(p.shift, need[(i + k + count) % count] * weight);
      }
    });
  }
  for (const p of points) {
    p.x += p.dx * p.shift;
    p.z += p.dz * p.shift;
  }
  return { points, count, step: length / count, length: (length / count) * count };
}

// The point `s` along a route.
function routeAt(route, s, into) {
  const t = (((s / route.step) % route.count) + route.count) % route.count;
  const i = Math.floor(t);
  const p = route.points[i];
  const q = route.points[(i + 1) % route.count];
  return into.set(p.x + (q.x - p.x) * (t - i), 0, p.z + (q.z - p.z) * (t - i));
}

const routeA = new THREE.Vector3();
const routeB = new THREE.Vector3();

// Stands a lorry on its route: front and back wheels both on the line, so it
// swings round bends as a long vehicle does.
function placeLorry(m) {
  const scale = m.root.scale.x;
  const front = Math.max(...m.root.userData.axles) * scale;
  const back = Math.min(...m.root.userData.axles) * scale;
  routeAt(m.route, m.s + front, routeA);
  routeAt(m.route, m.s + back, routeB);
  const turned = Math.atan2(-(routeA.z - routeB.z), routeA.x - routeB.x);
  m.root.rotation.y = turned;
  m.root.position.set(routeB.x - Math.cos(turned) * back, DK.Q + 0.05, routeB.z + Math.sin(turned) * back);
}

// Builds each road's route once everything that stands on the quay is there,
// and puts the lorries on them, spaced apart.
function buildLorryRoutes(roots) {
  const solids = quaySolids(roots);
  const routes = new Map();
  for (const m of dock3.movers.filter((v) => v.road)) {
    const [z0, x0, x1] = m.road;
    if (!routes.has(z0)) routes.set(z0, lorryRoute(z0, x0, x1, solids));
    m.route = routes.get(z0);
    const leg = m.dir > 0 ? -1 : 1;
    let nearest = 0;
    let gap = Infinity;
    m.route.points.forEach((p, i) => {
      if (p.leg === leg && Math.abs(p.x - m.startX) < gap) {
        gap = Math.abs(p.x - m.startX);
        nearest = i;
      }
    });
    m.s = nearest * m.route.step;
    const scale = m.root.scale.x;
    const [ahead, behind] = m.root.userData.ends;
    m.ahead = ahead * scale;
    m.behind = behind * scale;
    m.v = m.speed;
  }
  const lorries = dock3.movers.filter((v) => v.route);
  for (const m of lorries) {
    // (no one close ahead of it, nor it close ahead of anyone)
    const placed = lorries.slice(0, lorries.indexOf(m)).filter((o) => o.route === m.route);
    for (let tries = 0; tries < 80 && placed.some((o) => roomAhead(m, o) < 6 || roomAhead(o, m) < 6); tries++) m.s += 5;
    placeLorry(m);
  }
  dock3.solids = solids;
}

// Clear road between the nose of `m` and the tail of `o`, going the way they drive.
function roomAhead(m, o) {
  const ds = (((o.s - m.s) % m.route.length) + m.route.length) % m.route.length;
  return ds - m.ahead + o.behind; // (behind is measured backwards, so negative)
}

function stepLorries(dt) {
  const lorries = dock3.movers.filter((v) => v.route);
  for (const m of lorries) {
    let room = Infinity;
    for (const o of lorries) if (o !== m && o.route === m.route) room = Math.min(room, roomAhead(m, o));
    // slower into bends
    routeAt(m.route, m.s + 2, routeA);
    routeAt(m.route, m.s, routeB);
    const now = Math.atan2(routeA.z - routeB.z, routeA.x - routeB.x);
    routeAt(m.route, m.s + 11, routeA);
    routeAt(m.route, m.s + 9, routeB);
    const bend = Math.abs(normalizeAngle(Math.atan2(routeA.z - routeB.z, routeA.x - routeB.x) - now));
    const want = m.speed * clamp((room - 4) / 10, 0, 1) * clamp(1 - bend * 0.4, 0.45, 1);
    m.v += clamp(want - m.v, -9 * dt, 2.5 * dt);
    if (room < 2.5) m.v = 0;
    m.s = (m.s + m.v * dt) % m.route.length;
    placeLorry(m);
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
    mergeStaticMeshes(w, new Set()); // a worker only turns as a whole
    w.userData.solid = true;
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
    mergeStaticMeshes(root, new Set()); // a lorry only moves as a whole
    dockScene.add(root);
    dock3.movers.push({ root, speed, road: [z0, x0, x1], startX, dir });
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
  drive(makeBigTruck(0x2a4f7a, "container", 0xc8602a), 38, 4, -58, 23, -30, 1);
  drive(makeTruck(0x2f6f3f), -38, 5, -58, 23, 12, -1);
  for (const [x, z, ry, cab, kind, col] of [
    [-140, 62, 0, 0x2a4f7a, "container", 0xb2362b], [-122, 62, 0, 0x555a60, "container", 0x1f2f4a], [-104, 62, 0, 0x8a2e24, "container", 0x8b8f93],
    [-88, 38, 0, 0x2f6f3f, "container", 0xc8602a], [-262, -112, Math.PI / 2, 0xb0b4b8, "tanker", 0], [-86, -40, Math.PI, 0xe7b016, "crane", 0]
  ]) {
    const t = makeBigTruck(cab, kind, col);
    t.position.set(x, Q + 0.05, z);
    t.rotation.y = ry;
    mergeStaticMeshes(t, new Set());
    t.userData.solid = true; // lorries steer round it
    dockScene.add(t);
  }
  drive(makeForklift(), -57, 3, -222, -158, -170, 1);
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
    const bird = makeGull();
    bird.root.scale.setScalar(0.2 + (i % 3) * 0.015);
    bird.root.userData.flight = { bird, r: 30 + (i % 5) * 22, h: 22 + (i % 4) * 9, speed: 0.17 + (i % 3) * 0.05, a: i * 0.9, cx: i % 2 ? 20 : -50, cz: (i % 3) * 25 - 25, beat: i * 1.3, effort: i % 2 };
    dockScene.add(bird.root);
    dock3.gulls.push(bird.root);
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
  dockScene.fog = new THREE.Fog(DOCK_HAZE.clone(), 2600, 10000);
  const dkSky = clearSky(5500, DOCK_SKY_GAIN);
  dock3.skyDome = dkSky;
  dockScene.add(dkSky);
  const sunLight = new THREE.DirectionalLight(SUN_DAY, 3.7);
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

  const always = new Set(dockScene.children); // sky, sun and lamps
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
  buildLorryRoutes([S, ...dockScene.children.filter((c) => c.userData.solid)]);
  mergeStaticMeshes(S, new Set());
  // Everything of the modern yard in one group, so it can give way to the arsenal (setDockEra).
  // The water, the islands and hills, gulls, smoke and repair effects belong to both.
  const shared = new Set([dock3.sea, dock3.basin, dock3.shallow, dock3.sparks.pts, dock3.weldLight, ...dock3.gulls, ...dock3.smoke]);
  dock3.modern = new THREE.Group();
  for (const child of [...dockScene.children]) {
    if (!always.has(child) && !shared.has(child) && !child.userData.nature) dock3.modern.add(child);
  }
  dockScene.add(dock3.modern);
}

// ---- The Order's arsenal -----------------------------------------------------
// While the carrack is in the dockyard, the modern yard gives way to a 16th-
// century arsenal of the Knights Hospitaller. The Birgu arsenal in Malta had
// slipways, magazines and great stone arches under wooden roofs; the rest is a
// reconstruction of the period: honey-coloured limestone round a careening basin,
// treadwheel cranes, a capstan, a saw pit, a smithy, timber, casks, jars,
// anchors and guns, ox carts, mules, goats, hens, dogs and cats, windmills and
// bastions flying the cross. The carrack is careened here (buildCareenRig).
// It stands where the modern yard stands (same basin, same sea lanes).

// People and animals are drawn larger than life, so they can be made out from the camera.
const OLD_FOLK = 2.6;
const OLD_BEAST = 1.5;
function townsman(R, tunic, tools = false) {
  const p = makeShipwright(R, tunic, tools);
  p.g.scale.setScalar(OLD_FOLK);
  return p;
}

// A box whose texture repeats every `tile` units on every face, so that every
// box can share one material (and be merged into one draw).
function oldBox(w, h, d, material, x, y, z, tile = 6) {
  const m = box(w, h, d, material, x, y, z);
  const uv = m.geometry.attributes.uv;
  const faces = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let i = 0; i < uv.count; i++) {
    const [a, b] = faces[Math.floor(i / 4)];
    uv.setXY(i, (uv.getX(i) * a) / tile, (uv.getY(i) * b) / tile);
  }
  return m;
}

function arsenalMaterials(T) {
  const stone = dockTexture(256, (c, s) => {
    const r = seeded(61);
    c.fillStyle = "#96794a";
    c.fillRect(0, 0, s, s);
    for (let row = 0; row < 8; row++) {
      for (let x = -(row % 2) * 32; x < s; x += 64) {
        const v = r();
        c.fillStyle = `rgb(${182 + v * 30},${146 + v * 28},${92 + v * 24})`;
        c.fillRect(x + 1.5, row * 32 + 1.5, 61, 29);
        for (let i = 0; i < 50; i++) {
          c.fillStyle = `rgba(${r() < 0.5 ? "120,90,50" : "245,225,180"},${0.12 + r() * 0.2})`;
          c.fillRect(x + r() * 62, row * 32 + r() * 30, 1 + r() * 3, 1 + r() * 2);
        }
      }
    }
  });
  const paving = dockTexture(256, (c, s) => {
    const r = seeded(67);
    c.fillStyle = "#6f5c3c";
    c.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 42) {
      for (let x = 0; x < s;) {
        const w = Math.min(s - x, 30 + r() * 46);
        const v = r();
        c.fillStyle = `rgb(${140 + v * 30},${116 + v * 26},${78 + v * 22})`;
        c.fillRect(x + 1.5, y + 1.5, w - 3, 39);
        x += w;
      }
    }
    for (let i = 0; i < 2600; i++) {
      c.fillStyle = `rgba(${r() < 0.6 ? "90,70,40" : "235,215,170"},${0.1 + r() * 0.2})`;
      c.fillRect(r() * s, r() * s, 1 + r() * 2.5, 1 + r() * 2);
    }
  });
  const tiles = dockTexture(128, (c, s) => {
    const r = seeded(71);
    for (let x = 0; x < s; x += 16) {
      const g = c.createLinearGradient(x, 0, x + 16, 0);
      g.addColorStop(0, "#7d3a22");
      g.addColorStop(0.5, "#c06a41");
      g.addColorStop(1, "#7d3a22");
      c.fillStyle = g;
      c.fillRect(x, 0, 16, s);
      for (let y = Math.floor(r() * 10); y < s; y += 18) {
        c.fillStyle = "rgba(50,20,10,0.5)";
        c.fillRect(x, y, 16, 2);
      }
    }
  });
  const textured = (map, extra = {}) => new THREE.MeshStandardMaterial({ map, roughness: 0.93, ...(dkq.bump ? { bumpMap: map, bumpScale: 1.4 } : {}), ...extra });
  const archMap = stone.clone();
  archMap.repeat.set(1 / 6, 1 / 6); // for outlines drawn in world units
  archMap.needsUpdate = true;
  if (!carrackTex) carrackTex = carrackTextures();
  return {
    stone: textured(stone),
    arch: textured(archMap),
    paving: textured(paving),
    tiles: textured(tiles),
    plank: textured(T.wood),
    shell: textured(T.wood, { side: THREE.DoubleSide }), // open hulls, seen inside and out
    timber: DM.timber,
    oak: mat(0x4e3520, { roughness: 0.85 }),
    iron: mat(0x24262a, { roughness: 0.5, metalness: 0.75 }),
    bronze: mat(0x8a6a35, { roughness: 0.35, metalness: 0.85 }),
    rope: mat(0xc2a870, { roughness: 1 }),
    canvas: mat(0xe3d6b4, { roughness: 0.95, side: THREE.DoubleSide }),
    clay: mat(0xb4673c, { roughness: 0.8 }),
    dark: mat(0x17110c, { roughness: 1 }),
    red: mat(0xa81c24, { roughness: 0.75 }),
    white: mat(0xf2ede0, { roughness: 0.8 }),
    earth: mat(0x7d6840, { roughness: 1 }),
    banner: mat(0xffffff, { map: carrackTex.flag, roughness: 0.9, side: THREE.DoubleSide }),
    ember: new THREE.MeshStandardMaterial({ color: 0x3a1206, emissive: 0xff6a18, emissiveIntensity: 2.2 }),
    ox: mat(0x8a5a34, { roughness: 0.95 }),
    hide: mat(0xd9ccb4, { roughness: 0.95 }),
    mule: mat(0x6e6258, { roughness: 0.95 }),
    goat: mat(0xcfc4b2, { roughness: 1 }),
    black: mat(0x1d1a18, { roughness: 0.95 }),
    horn: mat(0xe6dcc0, { roughness: 0.6 }),
    hen: mat(0xa5602c, { roughness: 1 }),
    dog: mat(0xb58a55, { roughness: 1 })
  };
}

// ---- Animals (nose towards +x, feet at y = 0) --------------------------------

// A four-footed beast. Its legs swing from the hip (`legs`), the head nods
// from the neck (`head`).
function makeBeast(M, { len, height, girth, coat, legCoat = coat, neck = 0.35, ears = 0, horns = 0, tail = 0.5 }) {
  const g = new THREE.Group();
  const bodyY = height - girth;
  const body = mesh(new THREE.CapsuleGeometry(girth, Math.max(0.05, len - girth * 2), 4, Math.round(10 * dkq.geo)).rotateZ(Math.PI / 2), coat);
  body.position.y = bodyY;
  g.add(body);
  const legs = [];
  const hip = bodyY - girth * 0.45;
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const leg = new THREE.Group();
    leg.position.set(x * (len / 2 - girth * 0.7), hip, z * girth * 0.55);
    leg.add(box(girth * 0.34, hip, girth * 0.34, legCoat, 0, -hip / 2, 0), box(girth * 0.4, hip * 0.12, girth * 0.4, M.black, 0, -hip * 0.94, 0));
    g.add(leg);
    legs.push(leg);
  }
  const head = new THREE.Group();
  head.position.set(len / 2 - girth * 0.35, bodyY + girth * 0.4, 0);
  const reach = neck * len;
  head.add(strut(new THREE.Vector3(0, 0, 0), new THREE.Vector3(reach * 0.7, reach * 0.55, 0), girth * 0.42, coat, 8));
  head.add(box(girth * 1.15, girth * 0.7, girth * 0.7, coat, reach * 0.7 + girth * 0.4, reach * 0.55, 0));
  head.add(box(girth * 0.3, girth * 0.46, girth * 0.52, M.black, reach * 0.7 + girth * 1.05, reach * 0.55 - girth * 0.08, 0));
  for (const s of [-1, 1]) {
    if (ears) head.add(box(girth * 0.14, ears, girth * 0.24, coat, reach * 0.62, reach * 0.55 + girth * 0.3 + ears / 2, s * girth * 0.28));
    if (horns) {
      const horn = mesh(new THREE.ConeGeometry(girth * 0.12, horns, 6), M.horn);
      horn.position.set(reach * 0.75, reach * 0.55 + girth * 0.38 + horns * 0.35, s * girth * 0.42);
      horn.rotation.x = s * 0.9;
      head.add(horn);
    }
  }
  g.add(head);
  g.add(strut(new THREE.Vector3(-len / 2 + 0.05, bodyY + girth * 0.4, 0), new THREE.Vector3(-len / 2 - tail * 0.35, bodyY + girth * 0.4 - tail * 0.8, 0), girth * 0.1, legCoat, 6));
  mergeStaticMeshes(g, new Set([...legs, head]));
  mergeStaticMeshes(head, new Set());
  return { g, legs, head };
}

const makeOx = (M, coat) => makeBeast(M, { len: 2.1, height: 1.35, girth: 0.46, coat, neck: 0.22, horns: 0.42, tail: 0.9 });
const makeMule = (M) => makeBeast(M, { len: 1.5, height: 1.15, girth: 0.3, coat: M.mule, legCoat: M.black, neck: 0.42, ears: 0.34, tail: 0.7 });
const makeGoat = (M, coat) => makeBeast(M, { len: 0.8, height: 0.66, girth: 0.18, coat, neck: 0.36, ears: 0.1, horns: 0.2, tail: 0.18 });
const makeDog = (M) => makeBeast(M, { len: 0.7, height: 0.5, girth: 0.13, coat: M.dog, neck: 0.3, ears: 0.11, tail: 0.5 });

// Legs of a walking beast swing in diagonal pairs.
function stride(beast, T, speed, amount = 0.45) {
  beast.legs.forEach((leg, i) => (leg.rotation.z = Math.sin(T * speed + (i === 0 || i === 3 ? 0 : Math.PI)) * amount));
}

function makeHen(M, coat) {
  const g = new THREE.Group();
  const body = mesh(SphG(0.17, 8, 6).scale(1.25, 0.95, 0.9), coat);
  body.position.y = 0.26;
  const tail = box(0.14, 0.22, 0.06, coat, -0.22, 0.38, 0);
  tail.rotation.z = 0.6;
  const head = new THREE.Group();
  head.position.set(0.16, 0.34, 0);
  head.add(box(0.1, 0.12, 0.09, coat, 0.04, 0.09, 0), box(0.07, 0.05, 0.03, M.red, 0.04, 0.18, 0), box(0.08, 0.03, 0.03, M.horn, 0.12, 0.09, 0));
  for (const z of [-0.05, 0.05]) g.add(box(0.02, 0.14, 0.02, M.horn, 0, 0.07, z));
  g.add(body, tail, head);
  return { g, head };
}

function makeCat(M, coat) {
  const g = new THREE.Group();
  g.add(box(0.3, 0.16, 0.14, coat, 0, 0.14, 0), box(0.13, 0.13, 0.13, coat, 0.19, 0.27, 0));
  for (const z of [-0.04, 0.04]) g.add(box(0.03, 0.07, 0.03, coat, 0.19, 0.36, z), box(0.04, 0.1, 0.04, coat, 0.1, 0.05, z), box(0.04, 0.1, 0.04, coat, -0.1, 0.05, z));
  const tail = box(0.05, 0.3, 0.05, coat, -0.18, 0.3, 0);
  tail.rotation.z = 0.35;
  g.add(tail);
  mergeStaticMeshes(g, new Set());
  return g;
}

// ---- Things ------------------------------------------------------------------

// A two-wheeled cart behind an ox, loaded with `load` (casks, timber, stone).
function makeOxCart(M, R, load) {
  const g = new THREE.Group();
  const ox = makeOx(M, R() > 0.5 ? M.ox : M.hide);
  ox.g.position.x = 2.5;
  g.add(ox.g);
  const wheels = [];
  for (const z of [-0.85, 0.85]) {
    const wheel = new THREE.Group();
    wheel.add(mesh(new THREE.TorusGeometry(0.72, 0.09, 6, Math.round(18 * dkq.geo)), M.oak));
    for (let i = 0; i < 4; i++) {
      const spoke = box(1.36, 0.08, 0.08, M.timber, 0, 0, 0);
      spoke.rotation.z = (i * Math.PI) / 4;
      wheel.add(spoke);
    }
    wheel.add(mesh(CylG(0.16, 0.16, 0.24, 8).rotateX(Math.PI / 2), M.oak));
    mergeStaticMeshes(wheel, new Set());
    wheel.position.set(-0.4, 0.8, z);
    g.add(wheel);
    wheels.push(wheel);
  }
  g.add(box(2.4, 0.14, 1.4, M.plank, -0.4, 0.86, 0));
  for (const z of [-0.68, 0.68]) g.add(box(2.4, 0.34, 0.06, M.oak, -0.4, 1.1, z));
  g.add(strut(new THREE.Vector3(0.8, 0.86, 0), new THREE.Vector3(2.6, 0.95, 0), 0.07, M.timber, 6));
  if (load === "casks") for (const [x, y] of [[-1.1, 1.3], [-0.4, 1.3], [0.3, 1.3], [-0.75, 1.9]]) g.add(cask(M, x, y, 0));
  else if (load === "timber") for (let i = 0; i < 7; i++) g.add(mesh(CylG(0.17, 0.17, 3.2, 8).rotateZ(Math.PI / 2), M.timber).translateX(-0.5).translateY(1.12 + Math.floor(i / 3) * 0.3).translateZ(-0.36 + (i % 3) * 0.36));
  else for (const [x, y, z] of [[-1, 1.18, -0.3], [-1, 1.18, 0.3], [-0.2, 1.18, -0.3], [-0.2, 1.18, 0.3], [-0.6, 1.66, 0]]) g.add(oldBox(0.72, 0.46, 0.55, M.stone, x, y, z));
  const driver = makeShipwright(R, M.canvas, false);
  driver.g.position.set(2.4, 0, 1.15);
  driver.g.rotation.y = Math.PI / 2;
  g.add(driver.g);
  mergeStaticMeshes(g, new Set([ox.g, driver.g, ...wheels]));
  return { g, ox, wheels };
}

// An oak cask standing on end, centred at (x, y, z).
let caskGeo = null;
function cask(M, x, y, z) {
  if (!caskGeo) caskGeo = new THREE.LatheGeometry([[0.001, -0.42], [0.27, -0.42], [0.34, -0.18], [0.36, 0], [0.34, 0.18], [0.27, 0.42], [0.001, 0.42]].map(([r, h]) => new THREE.Vector2(r, h)), 12);
  const g = new THREE.Group();
  g.add(mesh(caskGeo.clone(), M.plank));
  for (const [h, r] of [[-0.28, 0.325], [0.28, 0.325]]) {
    const hoop = mesh(new THREE.TorusGeometry(r, 0.025, 4, 14).rotateX(Math.PI / 2), M.iron);
    hoop.position.y = h;
    g.add(hoop);
  }
  g.position.set(x, y, z);
  return g;
}

function jar(M, x, y, z, s = 1) {
  const m = mesh(new THREE.LatheGeometry([[0.001, 0], [0.12, 0.02], [0.3, 0.3], [0.32, 0.55], [0.2, 0.8], [0.11, 0.9], [0.14, 1], [0.1, 1]].map(([r, h]) => new THREE.Vector2(r, h)), 10), M.clay);
  m.position.set(x, y, z);
  m.scale.setScalar(s);
  return m;
}

function oldAnchor(M, x, y, z, yaw) {
  const g = new THREE.Group();
  const v = (a, b, c) => new THREE.Vector3(a, b, c);
  g.add(strut(v(-2, 0.25, 0), v(2, 0.25, 0), 0.14, M.iron));
  for (const s of [-1, 1]) {
    g.add(strut(v(2, 0.25, 0), v(1.1, 0.25, s * 1.2), 0.13, M.iron));
    g.add(box(0.5, 0.1, 0.5, M.iron, 1.1, 0.25, s * 1.25));
  }
  g.add(box(0.28, 0.28, 2.6, M.oak, -1.75, 0.3, 0));
  g.add(mesh(new THREE.TorusGeometry(0.32, 0.07, 6, 14).rotateX(Math.PI / 2), M.iron).translateX(-2.3).translateY(0.25));
  g.position.set(x, y, z);
  g.rotation.y = yaw;
  return g;
}

// A bronze gun on its sea carriage.
function oldGun(M, x, y, z, yaw) {
  const g = new THREE.Group();
  g.add(mesh(CylG(0.2, 0.34, 2.4, 14).rotateZ(-Math.PI / 2), M.bronze).translateX(0.2).translateY(0.72));
  g.add(mesh(new THREE.TorusGeometry(0.21, 0.06, 6, 14).rotateY(Math.PI / 2), M.bronze).translateX(1.4).translateY(0.72));
  g.add(box(1.7, 0.34, 0.75, M.oak, -0.3, 0.45, 0));
  for (const wx of [-0.9, 0.35]) for (const wz of [-0.48, 0.48]) g.add(mesh(CylG(0.24, 0.24, 0.16, 12).rotateX(Math.PI / 2), M.timber).translateX(wx).translateY(0.24).translateZ(wz));
  g.position.set(x, y, z);
  g.rotation.y = yaw;
  return g;
}

function shotPile(M, x, y, z) {
  const g = new THREE.Group();
  const ball = SphG(0.19, 8, 6);
  for (let level = 0; level < 4; level++) {
    const n = 4 - level;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) g.add(mesh(ball.clone(), M.iron).translateX((i - (n - 1) / 2) * 0.37).translateY(0.19 + level * 0.27).translateZ((j - (n - 1) / 2) * 0.37));
    }
  }
  g.position.set(x, y, z);
  return g;
}

// A banner with the cross on a pole.
function bannerPole(M, x, y, z, h = 12) {
  const g = new THREE.Group();
  g.add(cylinder(0.12, 0.18, h, M.oak, 0, h / 2, 0, 8));
  const flag = mesh(new THREE.PlaneGeometry(4.2, 2.8, 10, 1), M.banner, false);
  const p = flag.geometry.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin((p.getX(i) / 4.2 + 0.5) * 7) * 0.35 * (p.getX(i) / 4.2 + 0.5));
  flag.geometry.computeVertexNormals();
  flag.position.set(2.2, h - 1.5, 0);
  g.add(flag);
  g.position.set(x, y, z);
  return g;
}

// A torch on a post: its flame flickers, brighter after dark.
function torch(M, group, x, y, z, flames) {
  group.add(cylinder(0.09, 0.12, 2.6, M.oak, x, y + 1.3, z, 6), cylinder(0.28, 0.18, 0.3, M.iron, x, y + 2.7, z, 8));
  const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSoft, color: 0xff9a30, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  flame.position.set(x, y + 3.2, z);
  dock3.old.add(flame);
  flames.push(flame);
}

// ---- The yard ----------------------------------------------------------------

// The careening basin: stone quays round a sheltered inlet open to the sea,
// with steps and ladders down to the water.
function arsenalPit(M, S) {
  const { L, W, FLOOR, Q, GX } = DK;
  const hl = L / 2;
  const hw = W / 2;
  const slab = (w, h, d, x, y, z, m = M.paving, tile = 12) => S.add(oldBox(w, h, d, m, x, y, z, tile));
  slab(460, 14, 720, -295, Q - 7, 0);
  for (const s of [-1, 1]) slab(130, 14, 337, 0, Q - 7, s * (hw + 337 / 2));
  slab(L, 2, W, 0, FLOOR - 1, 0);
  for (const s of [-1, 1]) {
    // dressed stone faces and the altars (steps) the shores stand on
    slab(L, Q - FLOOR - 0.1, 0.12, 0, (Q + FLOOR) / 2 - 0.05, s * (hw - 0.05), M.stone, 5);
    slab(L - 6, 0.5, 1.4, -3, -2.75, s * (hw - 0.7), M.stone, 4);
    slab(L - 6, 0.5, 1.4, -3, -5.5, s * (hw - 0.7), M.stone, 4);
    slab(L, 0.7, 1.8, 0, Q + 0.05, s * (hw + 0.9), M.stone, 4);
    for (let x = -60; x <= 60; x += 12) S.add(cylinder(0.34, 0.42, 1.3, M.oak, x, Q + 0.65, s * (hw + 3.2), 8)); // mooring posts
  }
  slab(0.12, Q - FLOOR - 0.1, W, -hl + 0.05, (Q + FLOOR) / 2 - 0.05, 0, M.stone, 5);
  slab(1.8, 0.7, W + 3.6, -hl - 0.9, Q + 0.05, 0, M.stone, 4);
  for (let k = 0; k < 12; k++) {
    const top = Q - 1 - k;
    slab(1.2, top - FLOOR, 3, -44 - k * 1.2 - 0.6, (top + FLOOR) / 2, hw - 1.5, M.stone, 4);
  }
  for (const x of [-30, 8, 40]) {
    for (const dx of [-0.45, 0.45]) S.add(box(0.14, Q - FLOOR + 1.2, 0.14, M.timber, x + dx, (Q + 1.2 + FLOOR) / 2, -hw + 0.25));
    for (let y = FLOOR + 0.6; y < Q + 1; y += 0.65) S.add(box(1, 0.1, 0.1, M.timber, x, y, -hw + 0.25));
  }
}

// The galley sheds: a row of great stone arches under tiled wooden roofs, with
// a hull drawn up on its slip inside.
const SHED_BAY = 19;
const SHED_DEPTH = 30;
const SHED_WALL = 12;

// One bay, its arch facing -z at `front`, holding either a hull on the slip
// or stores.
function galleyBay(M, S, x, y, front, withHull) {
  const bay = SHED_BAY;
  const depth = SHED_DEPTH;
  const wall = SHED_WALL;
  const face = new THREE.Shape();
  face.moveTo(-bay / 2, 0);
  face.lineTo(-bay / 2, wall);
  face.lineTo(0, wall + 4);
  face.lineTo(bay / 2, wall);
  face.lineTo(bay / 2, 0);
  face.lineTo(7, 0);
  face.lineTo(7, 5);
  face.absarc(0, 5, 7, 0, Math.PI, false);
  face.lineTo(-7, 0);
  face.closePath();
  const arch = mesh(new THREE.ExtrudeGeometry(face, { depth: 2, bevelEnabled: false, curveSegments: Math.round(14 * dkq.geo) }), M.arch);
  arch.position.set(x, y, front);
  S.add(arch);
  // the voussoirs round the opening
  const ring = mesh(new THREE.TorusGeometry(7.25, 0.35, 4, Math.round(22 * dkq.geo), Math.PI), M.stone);
  ring.position.set(x, y + 5, front - 0.05);
  S.add(ring);
  S.add(oldBox(1.6, wall, depth, M.stone, x - bay / 2, y + wall / 2, front + depth / 2 + 1));
  S.add(oldBox(bay, wall, 1.2, M.dark, x, y + wall / 2, front + depth + 1));
  const slope = Math.atan2(4, bay / 2);
  for (const s of [-1, 1]) {
    const roof = oldBox(bay / 2 / Math.cos(slope) + 0.5, 0.45, depth + 2.4, M.tiles, x + (s * bay) / 4, y + wall + 2.3, front + depth / 2 + 1, 4);
    roof.rotation.z = -s * slope;
    S.add(roof);
  }
  S.add(box(0.5, 0.5, depth, M.oak, x, y + wall + 1.6, front + depth / 2 + 1)); // ridge beam
  if (withHull) {
    const hull = new THREE.Group();
    carrackShell(hull, M.shell, M.oak, {
      xa: -13, xb: 13, low: (u) => 0.2 * (u / 13) ** 4 * 8, high: (u) => 3 + 1.4 * (u / 13) ** 4,
      half: (u, v) => 3 * Math.max(0.06, 1 - (u / 13.2) ** 4) * clamp(0.25 + v / 3, 0.25, 1)
    });
    for (let u = -10; u <= 10; u += 2.5) for (const s of [-1, 1]) hull.add(box(0.28, 3.6, 0.28, M.timber, u, 5, s * 2.4 * (1 - (u / 15) ** 2))); // ribs still to be planked
    hull.rotation.y = -Math.PI / 2;
    hull.position.set(x, y + 0.9, front + 13);
    hull.traverse((c) => c.isMesh && (c.castShadow = true));
    S.add(hull);
    for (const s of [-1, 1]) S.add(box(0.8, 0.5, 34, M.oak, x + s * 2.4, y + 0.25, front + 8)); // the slipway's ways
    for (let z = front - 8; z <= front + 26; z += 3) S.add(box(7, 0.25, 0.6, M.timber, x, y + 0.15, z));
  } else {
    for (let k = 0; k < dkn(8); k++) S.add(cask(M, x - 6 + (k % 6) * 1.2, y + 0.42 + Math.floor(k / 6) * 0.85, front + 6 + (k % 3)));
    for (let k = 0; k < 5; k++) S.add(oldBox(6, 0.3, 1.4, M.plank, x + 2, y + 0.2 + k * 0.32, front + 16));
  }
}

function arsenalSheds(M, S) {
  const { Q } = DK;
  const front = 76;
  for (let i = 0; i < 8; i++) {
    const x = -118 + i * SHED_BAY;
    galleyBay(M, S, x, Q, front, i === 2 || i === 5);
    if (i % 2 === 0) S.add(bannerPole(M, x - SHED_BAY / 2, Q + SHED_WALL, front + 0.5, 7));
  }
  S.add(oldBox(1.6, SHED_WALL, SHED_DEPTH, M.stone, -118 + 8 * SHED_BAY - SHED_BAY / 2, Q + SHED_WALL / 2, front + SHED_DEPTH / 2 + 1));
}

// A bastion: sloping walls, battlements and domed sentry turrets.
function bastion(M, S, x, z, w, d, h, y) {
  const g = new THREE.CylinderGeometry(0.9, 1, h, 4, 1).rotateY(Math.PI / 4);
  g.scale(w / Math.SQRT2, 1, d / Math.SQRT2);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) + pos.getZ(i)) / 7, pos.getY(i) / 7);
  const m = mesh(g.toNonIndexed(), M.stone);
  m.geometry.computeVertexNormals();
  m.position.set(x, y + h / 2, z);
  S.add(m);
  const tw = w * 0.9;
  const td = d * 0.9;
  S.add(oldBox(tw + 1.6, 0.8, td + 1.6, M.stone, x, y + h - 0.2, z, 3)); // the cordon
  for (let u = -td / 2 + 8; u <= td / 2 - 8; u += 14) S.add(box(1.4, 1.8, 2.6, M.dark, x + w * 0.465, y + h * 0.62, z + u)); // gun ports
  for (let u = -tw / 2 + 2; u <= tw / 2 - 1; u += 4.5) for (const s of [-1, 1]) S.add(oldBox(2.4, 1.8, 1.2, M.stone, x + u, y + h + 0.9, z + s * (td / 2 - 0.6), 3));
  for (let u = -td / 2 + 2; u <= td / 2 - 1; u += 4.5) for (const s of [-1, 1]) S.add(oldBox(1.2, 1.8, 2.4, M.stone, x + s * (tw / 2 - 0.6), y + h + 0.9, z + u, 3));
  for (const s of [-1, 1]) {
    S.add(cylinder(1.5, 1.2, 4, M.stone, x + tw / 2, y + h + 2, z + (s * td) / 2, 8));
    S.add(mesh(new THREE.SphereGeometry(1.55, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), M.stone).translateX(x + tw / 2).translateY(y + h + 4).translateZ(z + (s * td) / 2));
  }
}

// A stone windmill with six cloth sails; the sails turn (`anims`).
function windmill(M, S, parent, anims, x, y, z, turn) {
  S.add(cylinder(4.2, 5.4, 17, M.stone, x, y + 8.5, z, 16));
  S.add(mesh(new THREE.ConeGeometry(4.8, 4.5, 16), M.tiles).translateX(x).translateY(y + 19.2).translateZ(z));
  const sails = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const arm = new THREE.Group();
    arm.rotation.x = (i * Math.PI) / 3;
    arm.add(box(0.25, 10, 0.25, M.oak, 0, 5, 0));
    const cloth = mesh(new THREE.PlaneGeometry(2.4, 6.5).rotateY(Math.PI / 2), M.canvas);
    cloth.position.set(0, 6, 1.2);
    arm.add(cloth);
    sails.add(arm);
  }
  mergeStaticMeshes(sails, new Set());
  sails.position.set(x + 5.4, y + 15, z);
  parent.add(sails);
  anims.push((T) => (sails.rotation.x = T * turn));
}

// Magazines and houses of stone, the bastions behind the dock head, windmills
// and the town beyond.
function arsenalBuildings(M, S, R) {
  const { Q } = DK;
  const house = (x, z, w, d, h, face = 1) => {
    S.add(oldBox(w, h, d, M.stone, x, Q + h / 2, z));
    S.add(oldBox(w + 0.7, 0.6, d + 0.7, M.stone, x, Q + h + 0.3, z, 3)); // cornice
    for (const s of [-1, 1]) S.add(oldBox(w, 0.9, 0.5, M.stone, x, Q + h + 1, z + s * (d / 2 - 0.2), 3)); // parapet
    for (let wx = -w / 2 + 3; wx <= w / 2 - 3; wx += 5) {
      S.add(box(1.1, 1.8, 0.2, M.dark, x + wx, Q + h * 0.66, z + face * (d / 2 + 0.02)));
      S.add(box(1.5, 0.25, 0.4, M.stone, x + wx, Q + h * 0.66 - 1, z + face * (d / 2 + 0.1)));
    }
    const door = mesh(new THREE.CircleGeometry(1.4, 12, 0, Math.PI), M.oak, false);
    door.position.set(x, Q + 3, z + face * (d / 2 + 0.04));
    if (face < 0) door.rotation.y = Math.PI;
    S.add(door, box(2.8, 3, 0.2, M.oak, x, Q + 1.5, z + face * (d / 2 + 0.02)));
  };
  house(-96, -92, 40, 18, 11);
  house(-48, -96, 30, 16, 8);
  house(-8, -90, 26, 18, 13);
  house(34, -98, 22, 14, 8);
  bastion(M, S, -205, 0, 96, 150, 16, Q);
  bastion(M, S, -222, 4, 62, 96, 14, Q + 16);
  S.add(oldBox(22, 15, 30, M.stone, -232, Q + 37.5, 8), oldBox(24, 1, 32, M.stone, -232, Q + 45.4, 8, 3)); // the keep
  for (let u = -14; u <= 14; u += 4.6) S.add(oldBox(1.4, 1.8, 2.4, M.stone, -221, Q + 46.8, 8 + u, 3));
  for (const u of [-8, 0, 8]) S.add(box(0.3, 3, 1.8, M.dark, -220.9, Q + 39, 8 + u));
  S.add(bannerPole(M, -232, Q + 46, 8, 18), bannerPole(M, -180, Q + 16, -66, 12), bannerPole(M, -180, Q + 16, 66, 12));
  for (const s of [-1, 1]) S.add(oldGun(M, -166, Q + 16, s * 34, 0));
  for (const [x, z] of [[-150, 150], [-215, 185], [-170, -170]]) windmill(M, S, dock3.old, dock3.oldAnim, x, Q, z, 0.5 + R() * 0.2);
  // the town: flat-roofed stone houses
  const n = Math.min(150, dkn(90));
  const town = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), M.stone, n);
  const holes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), M.dark, n * 3);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    const w = 9 + R() * 14;
    const h = 7 + R() * 16;
    const d = 9 + R() * 14;
    const x = -300 - R() * 260;
    const z = -330 + R() * 660;
    town.setMatrixAt(i, m4.makeScale(w, h, d).setPosition(x, Q + h / 2, z));
    for (let k = 0; k < 3; k++) holes.setMatrixAt(i * 3 + k, m4.makeScale(0.2, 2, 1.2).setPosition(x + w / 2 + 0.05, Q + h * 0.62, z + (k - 1) * d * 0.3));
  }
  town.castShadow = town.receiveShadow = true;
  dock3.old.add(town, holes);
  // the domed church of the town
  S.add(oldBox(30, 20, 20, M.stone, -330, Q + 10, 40), cylinder(7, 7, 8, M.stone, -330, Q + 24, 40, 16));
  S.add(mesh(new THREE.SphereGeometry(7.2, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.tiles).translateX(-330).translateY(Q + 28).translateZ(40));
  S.add(oldBox(7, 34, 7, M.stone, -312, Q + 17, 56));
}

// A crane worked by a man walking inside its great wheel, its jib reaching
// towards -z (turned by `yaw`), lowering and raising a load of casks.
function treadwheelCrane(M, R, parent, anims, x, y, z, yaw, phase) {
  const v = (a, b, c) => new THREE.Vector3(a, b, c);
  const c = new THREE.Group();
  for (const dx of [-3.4, 3.4]) c.add(strut(v(dx, 0, 3), v(dx * 0.35, 13, 0), 0.36, M.oak), strut(v(dx, 0, -3), v(dx * 0.35, 13, 0), 0.36, M.oak));
  c.add(oldBox(8, 0.5, 7, M.plank, 0, 0.25, 0), box(3.4, 0.6, 0.6, M.oak, 0, 13, 0));
  c.add(strut(v(0, 6, 0), v(0, 17, -13), 0.34, M.oak), mesh(ropeGeometry([{ curve: ropeCurve(v(0, 17, -13), v(0, 13, 0), { sag: 0.35, kink: 0.04, seed: phase }), r: 0.09, sides: 9, sway: 0.03 }]), hempMat));
  const wheel = new THREE.Group();
  for (const dx of [-0.8, 0.8]) {
    const rim = mesh(new THREE.TorusGeometry(3.1, 0.16, 6, Math.round(28 * dkq.geo)).rotateY(Math.PI / 2), M.oak);
    rim.position.x = dx;
    wheel.add(rim);
    for (let i = 0; i < 4; i++) {
      const spoke = box(0.18, 6.1, 0.18, M.timber, dx, 0, 0);
      spoke.rotation.x = (i * Math.PI) / 4;
      wheel.add(spoke);
    }
  }
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const tread = box(1.7, 0.12, 0.62, M.plank, 0, Math.cos(a) * 2.95, Math.sin(a) * 2.95);
    tread.rotation.x = a;
    wheel.add(tread);
  }
  wheel.add(mesh(CylG(0.3, 0.3, 4, 10).rotateZ(Math.PI / 2), M.oak));
  mergeStaticMeshes(wheel, new Set());
  wheel.position.set(0, 4, 0.6);
  c.add(wheel);
  const walker = townsman(R, M.canvas);
  walker.g.position.set(0, 1.2, 1.6);
  walker.g.rotation.y = Math.PI;
  c.add(walker.g);
  const load = new THREE.Group();
  // the hoist rope: built one long and stretched to the load's depth, about 9
  load.add(mesh(ropeGeometry([{ curve: new THREE.LineCurve3(v(0, 0, 0), v(0, -1, 0)), r: 0.08, sides: 9, stretch: 9 }]), hempMat));
  const bundle = new THREE.Group();
  for (let i = 0; i < 3; i++) bundle.add(cask(M, (i - 1) * 0.75, 0, 0));
  bundle.add(oldBox(2.5, 0.16, 1.1, M.plank, 0, -0.5, 0));
  load.position.set(0, 17, -13);
  c.add(load, bundle);
  mergeStaticMeshes(c, new Set([wheel, walker.g, load, bundle]));
  c.position.set(x, y, z);
  c.rotation.y = yaw;
  parent.add(c);
  anims.push((T) => {
    const lift = Math.sin(T * 0.22 + phase);
    const drop = 9 + lift * 5;
    wheel.rotation.x = lift * 5;
    load.scale.y = drop;
    bundle.position.set(0, 17 - drop - 0.6, -13);
  });
}

// The working yard: cranes worked by treadwheels, a capstan, a saw pit, the
// smithy, and the stores lying about.
function arsenalWorks(M, S, R) {
  const { Q, FLOOR } = DK;
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  // Treadwheel cranes on the quays, their jibs out over the dock.
  for (const [x, side, phase] of [[-36, 1, 0], [30, -1, 2.4]]) treadwheelCrane(M, R, dock3.old, dock3.oldAnim, x, Q, side * 33, side > 0 ? 0 : Math.PI, phase);
  // The capstan, four hands walking it round.
  const capstan = new THREE.Group();
  capstan.add(cylinder(0.6, 0.8, 2.2, M.oak, 0, 1.1, 0, 10), cylinder(0.95, 0.95, 0.4, M.oak, 0, 2.3, 0, 10));
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    capstan.add(strut(v(0, 1.2, 0), v(Math.cos(a) * 3.6, 1.2, Math.sin(a) * 3.6), 0.11, M.timber));
    const hand = townsman(R, i % 2 ? M.canvas : DM.leather);
    hand.g.position.set(Math.cos(a) * 3 - Math.sin(a) * 0.4, 0, Math.sin(a) * 3 + Math.cos(a) * 0.4);
    hand.g.rotation.y = -a;
    capstan.add(hand.g);
  }
  capstan.position.set(-82, Q, -34);
  dock3.old.add(capstan);
  dock3.oldAnim.push((T) => (capstan.rotation.y = -T * 0.35));
  S.add(mesh(ropeGeometry([{ curve: ropeCoil(-76, Q, -39, 1.3, 0.15, 5, 0.7), r: 0.15, sides: 9 }]), hempMat));
  // The saw pit: one sawyer above on the log, one below.
  S.add(box(8, 0.1, 2.4, M.dark, -22, Q + 0.07, 58));
  for (const x of [-25, -19]) for (const z of [57, 59]) S.add(box(0.3, 1.8, 0.3, M.oak, x, Q + 0.9, z));
  for (const x of [-25, -19]) S.add(box(0.3, 0.25, 2.6, M.oak, x, Q + 1.8, 58));
  S.add(mesh(CylG(0.45, 0.45, 8.5, 12).rotateZ(Math.PI / 2), M.timber).translateX(-22).translateY(Q + 2.3).translateZ(58));
  const saw = box(0.08, 2.6, 0.5, M.iron, -21, Q + 2.2, 58.5);
  dock3.old.add(saw);
  const sawyers = [[-21, 2.75, 57.3, 0], [-21, 0.05, 59.6, Math.PI]].map(([x, y, z, yaw]) => {
    const s = townsman(R, M.canvas);
    s.g.position.set(x, Q + y, z);
    s.g.rotation.y = yaw;
    dock3.old.add(s.g);
    return s;
  });
  dock3.oldAnim.push((T) => {
    const stroke = Math.sin(T * 3.2);
    saw.position.y = Q + 2.2 + stroke * 0.5;
    sawyers.forEach((s) => (s.arm.rotation.x = -0.3 - stroke * 0.5));
  });
  // Timber stacks, planks seasoning, and a pile of oak knees.
  for (const [x, z] of [[-48, 62], [-36, 64], [8, 60], [-60, -62]]) {
    for (let i = 0; i < 14; i++) {
      const row = i < 5 ? 0 : i < 9 ? 1 : i < 12 ? 2 : 3;
      const col = i - [0, 5, 9, 12][row];
      S.add(mesh(CylG(0.42, 0.42, 9, 10).rotateZ(Math.PI / 2), M.timber).translateX(x).translateY(Q + 0.42 + row * 0.72).translateZ(z - 1.8 + col * 0.86 + row * 0.43));
    }
  }
  for (let k = 0; k < 8; k++) S.add(oldBox(9, 0.2, 2.2, M.plank, 24, Q + 0.12 + k * 0.28, 58 + (k % 2) * 0.15));
  // The smithy: a lean-to with a glowing hearth, the anvil and the smith.
  const sx = 14;
  const sz = -58;
  for (const [x, z] of [[-4, -3], [4, -3], [-4, 3], [4, 3]]) S.add(box(0.35, z < 0 ? 5.4 : 4.4, 0.35, M.oak, sx + x, Q + (z < 0 ? 2.7 : 2.2), sz + z));
  const roof = oldBox(10, 0.3, 7.6, M.tiles, sx, Q + 5.1, sz, 4);
  roof.rotation.x = 0.17;
  S.add(roof, oldBox(2.6, 1.3, 2, M.stone, sx - 2, Q + 0.65, sz - 1.6), box(1.6, 0.12, 1.2, M.ember, sx - 2, Q + 1.34, sz - 1.6), oldBox(1.2, 6.5, 1.2, M.stone, sx - 3.4, Q + 4, sz - 2.4));
  S.add(cylinder(0.5, 0.6, 0.8, M.oak, sx + 0.6, Q + 0.4, sz + 0.4, 10), box(1.1, 0.35, 0.45, M.iron, sx + 0.6, Q + 0.98, sz + 0.4), cask(M, sx + 3, Q + 0.42, sz - 1.8));
  const smith = townsman(R, DM.leather, true);
  smith.g.position.set(sx + 0.6, Q, sz - 0.9);
  dock3.old.add(smith.g);
  dock3.oldAnim.push((T) => (smith.arm.rotation.x = 0.35 - Math.pow(Math.max(0, Math.sin(T * 5.5)), 0.5) * 1.3));
  dock3.forge = new THREE.Vector3(sx - 3.4, Q + 8, sz - 2.4);
  // Casks, jars, sacks, anchors, guns and shot lying ready.
  for (const [x, z, n] of [[44, 30, 14], [-60, 30, 10], [6, -32, 8], [-104, 30, 16]]) {
    for (let i = 0; i < n; i++) S.add(cask(M, x + (i % 4) * 0.8, Q + 0.42 + Math.floor(i / 8) * 0.85, z + Math.floor((i % 8) / 4) * 0.8));
  }
  for (const [x, z, n] of [[-12, 30, 14], [52, -30, 9], [-118, -34, 12]]) {
    for (let i = 0; i < n; i++) S.add(jar(M, x + (i % 5) * 0.75, Q, z + Math.floor(i / 5) * 0.8, 0.8 + R() * 0.4));
  }
  for (let i = 0; i < dkn(16); i++) {
    const sack = mesh(SphG(0.45, 8, 6).scale(1.2, 0.65, 0.85), M.canvas);
    sack.position.set(-48 + (i % 5) * 1.05, Q + 0.3 + Math.floor(i / 5) * 0.45, -32 - (i % 2) * 0.3);
    S.add(sack);
  }
  S.add(oldAnchor(M, -2, Q, 33, 0.5), oldAnchor(M, 4, Q, 34.5, 0.9), oldAnchor(M, -66, Q, -57, 2.4));
  for (let i = 0; i < 5; i++) S.add(oldGun(M, 14 + i * 3.2, Q, 33, Math.PI / 2));
  S.add(shotPile(M, 31.5, Q, 31), shotPile(M, 11, Q, 31), shotPile(M, -25, Q, -31));
  // A sailmaker's awning with canvas spread out under it.
  for (const [x, z] of [[-70, 56], [-58, 56], [-70, 66], [-58, 66]]) S.add(box(0.25, 3.6, 0.25, M.oak, x, Q + 1.8, z));
  const awning = mesh(new THREE.PlaneGeometry(13, 11).rotateX(-Math.PI / 2), M.canvas);
  awning.position.set(-64, Q + 3.65, 61);
  S.add(awning, oldBox(8, 0.12, 5, M.canvas, -64, Q + 0.1, 61));
  // Baulks laid ready on the floor of the dock.
  for (const z of [-18, 18]) for (let i = 0; i < 3; i++) S.add(box(9, 0.4, 0.4, M.timber, -38 + i * 0.5, FLOOR + 0.25 + i * 0.4, z));
}

// People about their business, and the animals.
function arsenalLife(M, S, R) {
  const { Q } = DK;
  const add = (g) => dock3.old.add(g);
  const knight = (x, z, yaw) => {
    const k = townsman(R, M.red);
    // the Order's white cross on the surcoat, front and back
    for (const s of [-1, 1]) k.g.add(box(0.035, 0.17, 0.01, M.white, 0, 0.39, s * 0.066), box(0.12, 0.035, 0.01, M.white, 0, 0.41, s * 0.066));
    k.g.position.set(x, Q, z);
    k.g.rotation.y = yaw;
    add(k.g);
  };
  knight(-52, 29.5, 2.6);
  knight(-50.6, 30.4, -1.2);
  knight(48, -31, 0.4);
  // hands standing about and walking to and fro
  const folk = Math.max(3, Math.round(18 * dkq.people));
  for (let i = 0; i < folk; i++) {
    const w = townsman(R, [M.canvas, DM.leather, M.red, M.mule][i % 4]);
    const side = i % 2 ? 1 : -1;
    const z = side * (27 + R() * 5 + (i % 3) * 12);
    const x = -110 + R() * 160;
    const walks = i % 3 !== 0;
    const span = 8 + R() * 22;
    const pace = 0.09 + R() * 0.08;
    const phase = R() * 6;
    w.g.position.set(x, Q, z);
    w.g.rotation.y = R() * 6;
    add(w.g);
    if (walks) {
      dock3.oldAnim.push((T) => {
        const a = T * pace + phase;
        w.g.position.x = x + Math.sin(a) * span;
        w.g.position.y = Q + Math.abs(Math.sin(T * 6 + phase)) * 0.05;
        w.g.rotation.y = Math.cos(a) > 0 ? Math.PI / 2 : -Math.PI / 2;
      });
    }
  }
  // ox carts on the two cart ways, and mules with panniers
  const road = (root, z, speed, x0, x1, start, dir, step) => {
    let x = start;
    let way = dir;
    dock3.oldAnim.push((T, dt) => {
      x += way * speed * dt;
      if (x > x1) way = -1;
      if (x < x0) way = 1;
      root.position.set(x, Q, z - way * 1.7);
      root.rotation.y = way > 0 ? 0 : Math.PI;
      step(T);
    });
    add(root);
  };
  [["casks", 47, 1.5, -40, 1], ["timber", 47, 1.1, -150, -1], ["stone", -47, 1.3, -90, 1], ["casks", -47, 1.0, 20, -1]].forEach(([load, z, speed, start, dir], i) => {
    const cart = makeOxCart(M, R, load);
    cart.g.scale.setScalar(OLD_BEAST);
    road(cart.g, z, speed, -190, 40, start, dir, (T) => {
      stride(cart.ox, T + i, speed * 3.2, 0.38);
      for (const w of cart.wheels) w.rotation.z = (-T * speed) / (0.72 * OLD_BEAST);
    });
  });
  [[39, 1.9, -20, -1], [-39, 1.6, -130, 1], [52.5, 1.4, -75, 1]].forEach(([z, speed, start, dir], i) => {
    const mule = makeMule(M);
    for (const s of [-1, 1]) mule.g.add(box(0.7, 0.45, 0.28, M.rope, -0.05, 0.82, s * 0.42));
    const lead = makeShipwright(R, M.canvas, false);
    lead.g.position.set(1.4, 0, 0.55);
    lead.g.rotation.y = Math.PI / 2;
    mule.g.add(lead.g);
    mule.g.scale.setScalar(OLD_BEAST);
    road(mule.g, z, speed, -150, 44, start, dir, (T) => stride(mule, T + i * 2, speed * 2.6));
  });
  // two oxen resting by the timber, mules tethered by the sheds
  for (const [x, z, yaw] of [[-30, 70, 0.4], [-25, 72, -0.3]]) {
    const ox = makeOx(M, M.ox);
    ox.g.position.set(x, Q, z);
    ox.g.scale.setScalar(OLD_BEAST);
    ox.g.rotation.y = yaw;
    add(ox.g);
    dock3.oldAnim.push((T) => (ox.head.rotation.z = -0.25 + Math.sin(T * 0.7 + x) * 0.2));
  }
  for (const x of [34, 37.5, 41]) {
    const mule = makeMule(M);
    mule.g.position.set(x, Q, 70);
    mule.g.scale.setScalar(OLD_BEAST);
    mule.g.rotation.y = Math.PI / 2 + (x - 37.5) * 0.06;
    add(mule.g);
    S.add(box(0.2, 1.1, 0.2, M.oak, x, Q + 0.55, 71.4));
    dock3.oldAnim.push((T) => (mule.head.rotation.z = -0.35 + Math.sin(T * 0.9 + x) * 0.3));
  }
  // a goatherd's flock, grazing as it wanders
  for (let i = 0; i < Math.max(3, Math.round(9 * Math.min(1, dkq.props))); i++) {
    const goat = makeGoat(M, [M.goat, M.black, M.ox][i % 3]);
    const x = -100 + R() * 26;
    const z = -60 + R() * 12;
    const phase = R() * 9;
    goat.g.position.set(x, Q, z);
    goat.g.scale.setScalar(OLD_BEAST * 1.15);
    add(goat.g);
    dock3.oldAnim.push((T) => {
      const a = T * 0.12 + phase;
      const moving = Math.sin(T * 0.5 + phase) > 0.2;
      goat.g.position.set(x + Math.sin(a) * 5, Q, z + Math.cos(a * 1.3) * 3);
      goat.g.rotation.y = Math.atan2(Math.sin(a * 1.3) * 3.9, Math.cos(a) * 5);
      stride(goat, T + phase, 7, moving ? 0.35 : 0);
      goat.head.rotation.z = moving ? 0 : -1.05;
    });
  }
  const herd = townsman(R, M.earth);
  herd.g.position.set(-72, Q, -58);
  herd.g.rotation.y = -1.4;
  add(herd.g);
  S.add(strut(new THREE.Vector3(-72.4, Q, -57.6), new THREE.Vector3(-72.4, Q + 1.4, -57.6), 0.04, M.timber, 5));
  // hens pecking round the smithy and the magazines
  for (let i = 0; i < Math.max(3, Math.round(14 * Math.min(1, dkq.props))); i++) {
    const hen = makeHen(M, [M.hen, M.white, M.black][i % 3]);
    const x = (i < 7 ? 20 : -42) + R() * 9;
    const z = (i < 7 ? -52 : -66) + R() * 7;
    const phase = R() * 9;
    hen.g.position.set(x, Q, z);
    hen.g.rotation.y = R() * 6;
    hen.g.scale.setScalar(2.2);
    add(hen.g);
    dock3.oldAnim.push((T) => (hen.head.rotation.z = -Math.pow(Math.max(0, Math.sin(T * 3 + phase)), 6) * 1.6));
  }
  // dogs trotting about, cats dozing on the casks and steps
  [[-8, 52, 7, 0.55], [-90, 36, 10, 0.4]].forEach(([x, z, r, pace], i) => {
    const dog = makeDog(M);
    dog.g.scale.setScalar(OLD_BEAST * 1.15);
    add(dog.g);
    dock3.oldAnim.push((T) => {
      const a = T * pace + i * 3;
      dog.g.position.set(x + Math.cos(a) * r, Q, z + Math.sin(a) * r * 0.5);
      dog.g.rotation.y = Math.atan2(-Math.cos(a) * r * 0.5, -Math.sin(a) * r);
      stride(dog, T + i, 11, 0.5);
    });
  });
  for (const [x, y, z, yaw, coat] of [[44.8, 0.86, 30.2, 2, M.black], [-48.2, 0.42, 25.2, -1, M.dog], [-45, 0, -27, 0.7, M.white]]) {
    const cat = makeCat(M, coat);
    cat.position.set(x, Q + y, z);
    cat.rotation.y = yaw;
    cat.scale.setScalar(2);
    S.add(cat);
  }
}

// The sea front: rubble moles with watchtowers (where the modern breakwaters
// are), a galley and boats alongside, and ships of the age in the roads.
function arsenalSea(M, S, R) {
  const { Q, GX } = DK;
  const rockGeo = roughen(new THREE.DodecahedronGeometry(4.5, 1), 2.2, 5);
  const rocks = new THREE.InstancedMesh(rockGeo, M.stone, 420);
  const m4 = new THREE.Matrix4();
  let n = 0;
  for (const [z, x0, x1, dz] of [[-250, 90, 520, 1], [230, 90, 400, -1]]) {
    for (let x = x0; x < x1; x += 3.6) {
      for (const row of [-1, 0, 1]) {
        if (n >= 420 || R() > Math.min(1, dkq.props * 1.2)) continue;
        const sc = 0.8 + R() * 0.7;
        m4.makeRotationFromEuler(new THREE.Euler(R() * 3, R() * 3, R() * 3));
        m4.scale(new THREE.Vector3(sc, sc * 0.8, sc));
        m4.setPosition(x, row === 0 ? 3.4 : 1.2, z + row * 7 * dz);
        rocks.setMatrixAt(n++, m4);
      }
    }
    S.add(oldBox(x1 - x0, 2.2, 7, M.stone, (x0 + x1) / 2, 5.4, z));
    S.add(cylinder(6, 7.5, 24, M.stone, x1, 18, z, 16), cylinder(7, 6, 2, M.stone, x1, 31, z, 16));
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      S.add(oldBox(1.8, 1.8, 1.8, M.stone, x1 + Math.cos(a) * 6.1, 32.8, z + Math.sin(a) * 6.1, 3));
    }
    S.add(bannerPole(M, x1, 32, z, 10));
    torch(M, S, x1, 32, z + 3, dock3.torches);
  }
  rocks.count = n;
  rocks.castShadow = true;
  dock3.old.add(rocks);
  // the quay along the water, with its posts
  for (const s of [-1, 1]) {
    for (let z = 28; z < 220; z += 7) S.add(cylinder(0.34, 0.42, 1.4, M.oak, GX - 1.2, Q + 0.7, s * z, 8));
    S.add(oldBox(2, 0.8, 332, M.stone, GX - 0.6, Q + 0.1, s * 192, 4));
  }
  const lying = (category, x, z, yaw) => {
    const o = createShip({ type: "cruise", category, displayColor: category === "Galley" ? "#b3202a" : "#8a5a38", angle: 0 });
    o.root.position.set(x, 0, z);
    o.root.rotation.y = yaw;
    slimDockShip(o);
    dock3.old.add(o.root);
    o.navLights.visible = false;
    dock3.oldAnim.push((T) => {
      o.root.position.y = Math.sin(T * 0.6 + x) * 0.2;
      o.tilt.rotation.z = Math.sin(T * 0.5 + z) * 0.012;
    });
  };
  lying("Galley", GX + 9, 70, -Math.PI / 2);
  if (dkq.props >= 0.5) {
    lying("Galley", GX + 11, -150, -Math.PI / 2);
    lying("Carrack", 900, -430, 2.2);
    lying("Galley", 1250, 360, 0.9);
  }
  // rowing boats at the quay
  for (const [x, z] of [[GX + 5, -62], [GX + 6, -80], [GX + 5, -96], [GX + 6, 120]]) {
    const boat = new THREE.Group();
    carrackShell(boat, M.shell, M.oak, {
      xa: -4, xb: 4, low: (u) => -0.5 + 1.1 * (u / 4) ** 4, high: (u) => 0.9 + 0.5 * (u / 4) ** 4,
      deck: () => 0.15, half: (u, y) => 1.5 * Math.max(0.08, 1 - (u / 4.1) ** 4) * clamp(0.55 + y * 0.5, 0.35, 1), under: true
    });
    for (const u of [-1.6, 0, 1.6]) boat.add(box(0.4, 0.12, 2.5, M.timber, u, 0.62, 0));
    boat.position.set(x, 0, z);
    boat.rotation.y = Math.PI / 2 + (z % 5) * 0.03;
    dock3.old.add(boat);
    dock3.oldAnim.push((T) => (boat.position.y = Math.sin(T * 0.9 + z) * 0.18));
  }
}

// Builds the arsenal (once, when the carrack is first wanted in the dock).
function buildArsenal() {
  if (dock3.old) return;
  const T = dockTextures();
  const R = seeded(1530); // the year the Order came to Malta
  const M = arsenalMaterials(T);
  dock3.old = new THREE.Group();
  dock3.old.visible = false;
  dock3.oldAnim = [];
  dock3.torches = [];
  dockScene.add(dock3.old);
  const S = new THREE.Group(); // everything that stands still
  dock3.old.add(S);
  arsenalPit(M, S);
  arsenalSheds(M, S);
  arsenalBuildings(M, S, R);
  arsenalWorks(M, S, R);
  arsenalLife(M, S, R);
  arsenalSea(M, S, R);
  const { Q, L, W } = DK;
  for (const s of [-1, 1]) {
    for (let x = -L / 2; x <= L / 2; x += L / 4) torch(M, S, x, Q, s * (W / 2 + 6), dock3.torches);
    for (let x = -150; x <= 40; x += 38) torch(M, S, x, Q, s * 43, dock3.torches);
  }
  // dry ground out to the hills
  for (const [w, d, x, z] of [[5000, 9000, -3025, 0], [460, 4300, -295, 2510], [460, 4300, -295, -2510], [130, 4300, 0, 2510], [130, 4300, 0, -2510]]) {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), M.earth);
    ground.position.set(x, Q - 0.2, z);
    ground.receiveShadow = true;
    S.add(ground);
  }
  mergeStaticMeshes(S, new Set());
}

// Changes the yard's age. The floodlight lamps stay in the scene (so no shader
// is rebuilt): in the arsenal they become the low, warm glow of the torches.
function setDockEra(old) {
  dock3.era = old;
  dock3.modern.visible = !old;
  if (dock3.old) dock3.old.visible = old;
  dock3.spots.forEach((sp, i) => {
    sp.color.setHex(old ? 0xff9440 : 0xfff0d0);
    sp.position.y = DK.Q + (old ? 12 : 26);
    sp.angle = old ? 1.1 : 0.62;
    sp.userData.watts = old ? 1100 : 6000;
  });
  dock3.nightApplied = null; // lamps and torches set afresh
}

// The change of age happens in a quick dip to black as the camera turns to the
// incoming ship. Returns the brightness to draw with (1 = normal).
const ERA_FADE = 0.55;
function updateDockEra(dt) {
  const focus = dock3.phase === "out" && dock3.leaving ? dock3.leaving.o.category : dock3.ship.category;
  const want = focus === "Carrack" && !!dock3.old;
  if (dock3.era === undefined || dock3.firstFrame) setDockEra(want);
  if (want !== dock3.era && !dock3.eraTurn) dock3.eraTurn = 0.0001;
  if (!dock3.eraTurn) return 1;
  const before = dock3.eraTurn;
  dock3.eraTurn += dt;
  if (before < ERA_FADE && dock3.eraTurn >= ERA_FADE) setDockEra(want);
  if (dock3.eraTurn >= ERA_FADE * 2) {
    dock3.eraTurn = 0;
    return 1;
  }
  return Math.abs(dock3.eraTurn - ERA_FADE) / ERA_FADE;
}

// A ship for the dock: its model, the blocks under it, and (once the dock is
// dry) the props, scaffold and workers around it. It is built ahead of time
// out of sight (under the ground) so that bringing it in doesn't stall a frame.
// A ship in the dockyard is only looked at from outside: it needs no bridge interior, and its fixed
// parts are merged by material, so it takes far fewer draw calls (the same picture, drawn faster).
// The scene is drawn again for the water's mirror, so every saved call counts twice.
function slimDockShip(o) {
  if (o.interior) {
    o.model.remove(o.interior);
    disposeTree(o.interior);
    o.interior = null;
    o.interiorClash = [];
  }
  if (!o.proxy) mergeStaticMeshes(o.model, new Set([o.wheel, o.alarm?.group, ...(o.rudders || []), ...(o.screws || [])].filter(Boolean)));
}

// A model written by tools/tug_model.py or tools/dock_model.py: separate parts
// (geometries) that share one set of pictures.
const modelPicture = (name) => new THREE.TextureLoader().loadAsync(`assets/models/${name}.jpg`);

// Pictures as they arrive: sharp at a slant, and sent to the graphics card
// now, not when the thing they cover first appears.
function readyPictures(...pictures) {
  for (const t of pictures) {
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    renderer.initTexture(t);
  }
}

async function loadModel(name) {
  const [response, map, orm, normalMap] = await Promise.all([fetch(`assets/models/${name}.bin`), modelPicture(`${name}_color`), modelPicture(`${name}_orm`), modelPicture(`${name}_normal`)]);
  if (!response.ok) throw new Error(`${name}.bin: ${response.status}`);
  const parts = modelShapes(await response.arrayBuffer());
  map.colorSpace = THREE.SRGBColorSpace;
  readyPictures(map, orm, normalMap);
  // one picture holds corner shading (red), how matt (green) and how metallic (blue)
  const material = shared(new THREE.MeshStandardMaterial({ map, normalMap, aoMap: orm, roughnessMap: orm, metalnessMap: orm, roughness: 1, metalness: 1 }));
  return { parts, material };
}

// The shapes in a model file.
function modelShapes(data) {
  let at = 4; // after the "TUG2" mark
  const read = (Type, count) => {
    const values = new Type(data, at, count);
    at += values.byteLength;
    return values;
  };
  return Array.from({ length: read(Uint32Array, 1)[0] }, () => {
    const [vertices, corners] = read(Uint32Array, 2);
    const geometry = shared(new THREE.BufferGeometry());
    geometry.setAttribute("position", new THREE.BufferAttribute(read(Float32Array, vertices * 3), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(read(Int16Array, vertices * 3), 3, true));
    geometry.setAttribute("uv", new THREE.BufferAttribute(read(Uint16Array, vertices * 2), 2, true));
    at = Math.ceil(at / 4) * 4;
    geometry.setIndex(new THREE.BufferAttribute(read(Uint32Array, corners), 1));
    return geometry;
  });
}

// The tug modelled in Blender: far more detail than the code-built harbourTug,
// with rounded plate edges, every fitting modelled, and paint, rust and corner
// shading painted into its pictures. Until it has loaded (or if it can't), the
// code-built tug is shown. Its parts are separate so those round the bridge can
// be hidden from inside it.
let tugModel = null; // { parts, material }

async function loadTugModel() {
  tugModel = await loadModel("tug");
  // anything already showing the plain tug is built again: ships at sea (as if
  // their colour had changed), the warm-up samples and an open dockyard
  for (const o of shipObjects.values()) if (o.category === "Tug") o.color = null;
  warm.samples = null;
  warm.level = -1;
  if (dock3.built) resetDockyard();
}

// The cruise liner modelled in Blender (tools/cruise_model.py). Its hull and
// funnel are painted white and tinted with the ship's colour, its cabin
// windows light up at night, and her captain's name is written on bow and
// stern. The parts are named by what they are made of and where they are, so
// those round the bridge can be hidden from inside it.
const CRUISE_PARTS = ["base_low", "base_aft", "base_bridge", "tint_low", "tint_aft", "tint_bridge", "glow_low", "glow_aft", "glow_bridge"]; // cruise_model.py
const CRUISE_MODEL_EYE = [26.6, 12, 0]; // the captain's eye in the modelled wheelhouse
let cruiseModel = null; // { parts, material, glow, standIn, panels }

async function loadCruiseModel() {
  const [model, glow, response] = await Promise.all([loadModel("cruise"), modelPicture("cruise_glow"), fetch("assets/models/cruise_extra.bin")]);
  if (!response.ok) throw new Error(`cruise_extra.bin: ${response.status}`);
  const [hull, upper, ...panels] = modelShapes(await response.arrayBuffer());
  glow.colorSpace = THREE.SRGBColorSpace;
  readyPictures(glow);
  cruiseModel = { ...model, glow, standIn: [hull, upper], panels };
  BRIDGE_EYE.Cruise = CRUISE_MODEL_EYE;
  for (const o of shipObjects.values()) if (o.category === "Cruise") o.color = null; // built again
  warm.samples = null;
  warm.level = -1;
  if (dock3.built) resetDockyard();
}

// The name, as painted on a liner: a flowing script in pale gold.
const namePictures = new Map();
function namePicture(name) {
  if (!namePictures.has(name)) {
    const canvas = Object.assign(document.createElement("canvas"), { width: 1024, height: 128 });
    const g = canvas.getContext("2d");
    g.font = "italic 600 96px 'Palatino Linotype', 'Book Antiqua', Georgia, serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineWidth = 5;
    g.strokeStyle = "rgba(10, 22, 44, 0.55)";
    g.strokeText(name, 512, 68, 990);
    g.fillStyle = "#f3e6bf";
    g.fillText(name, 512, 68, 990);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    namePictures.set(name, texture);
  }
  return namePictures.get(name);
}

// Swaps the modelled liner into a ship. The stand-in shape stays, unseen, for
// flames, ropes and shot marks to be placed on.
function useCruiseModel(o, ship) {
  const proxy = new THREE.Group();
  proxy.add(...o.model.children.filter((c) => c !== o.navLights));
  proxy.visible = false;
  const own = (color) => {
    const m = cruiseModel.material.clone(); // her own, so she alone chars when on fire
    if (color) m.color.set(color);
    m.userData = { baseColor: m.color.clone(), baseEmissive: m.emissive.clone() };
    return m;
  };
  const paint = new THREE.Color(ship.displayColor || "#2f7ef7").multiplyScalar(0.55); // a liner's deep gloss
  const materials = { base: own(), tint: own(paint), glow: own() };
  materials.glow.emissiveMap = cruiseModel.glow;
  materials.glow.emissive.set(0xffffff);
  materials.glow.emissiveIntensity = 0; // lit at night (updateShip, the dockyard)
  materials.glow.userData.baseEmissive = materials.glow.emissive.clone();
  const parts = [];
  cruiseModel.parts.forEach((geometry, i) => {
    if (geometry.attributes.position.count) parts.push(mesh(geometry, materials[CRUISE_PARTS[i].split("_")[0]]));
  });
  const lettering = new THREE.MeshStandardMaterial({ map: namePicture(ship.playerName || "Captain Azure"), transparent: true, depthWrite: false, roughness: 0.4, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  for (const geometry of cruiseModel.panels) parts.push(mesh(geometry, lettering, false));
  for (const part of parts) part.raycast = () => {};
  o.model.add(proxy, ...parts);
  o.mats = Object.values(materials);
  o.glow = materials.glow;
  o.proxy = proxy;
}

// The dockyard's modelled surroundings (tools/dock_model.py): the gantry
// cranes, the props on the quay and round the ship, and the concrete. Until
// they have loaded (or if they can't), the code-built ones are shown.
const DOCK_PROPS = ["bollard", "crate", "bottle", "barrier", "cone", "block", "cap", "shore", "scaffold"]; // dock_model.py PROPS
let dockModels = null; // { crane, props: geometry by name, propsMaterial, concrete }

async function loadDockModels() {
  const [crane, props, concrete, orm, normalMap] = await Promise.all([loadModel("crane"), loadModel("props"), modelPicture("concrete_color"), modelPicture("concrete_orm"), modelPicture("concrete_normal")]);
  concrete.colorSpace = THREE.SRGBColorSpace;
  for (const t of [concrete, orm, normalMap]) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  readyPictures(concrete, orm, normalMap);
  concrete.userData.relief = { normalMap, roughnessMap: orm };
  dockModels = { crane, props: Object.fromEntries(DOCK_PROPS.map((name, i) => [name, props.parts[i]])), propsMaterial: props.material, concrete };
  if (dock3.built) resetDockyard(); // already open with the plain ones: build it again
}

// The modelled prop's shape and material, or the plain ones given.
function propLook(name, geometry, material) {
  return dockModels ? [dockModels.props[name], dockModels.propsMaterial] : [geometry, material];
}

// Copies of one modelled prop, each at [x, y, z, height stretch].
function propRow(name, spots) {
  const row = new THREE.InstancedMesh(dockModels.props[name], dockModels.propsMaterial, spots.length);
  const m = new THREE.Matrix4();
  spots.forEach(([x, y, z, stretch = 1], i) => row.setMatrixAt(i, m.makeScale(1, stretch, 1).setPosition(x, y, z)));
  row.castShadow = row.receiveShadow = true;
  return row;
}

// Swaps the modelled tug into a ship. The code-built meshes stay, unseen, as
// the simple surface that flames, ropes and shot marks are placed on: testing
// rays against the detailed model would stall the game.
function useTugModel(o) {
  const proxy = new THREE.Group();
  proxy.add(...o.model.children.filter((c) => c !== o.navLights));
  proxy.visible = false;
  const material = tugModel.material.clone(); // her own, so she alone chars when on fire
  material.userData = { baseColor: material.color.clone(), baseEmissive: material.emissive.clone() };
  const parts = tugModel.parts.map((geometry) => mesh(geometry, material));
  for (const part of parts) part.raycast = () => {};
  o.model.add(proxy, ...parts);
  o.mats = [material];
  o.proxy = proxy;
}

function prepareDockShip(id) {
  const def = getShipDefinition(id);
  if (def.category === "Carrack") buildArsenal(); // ready before she comes in
  const o = createShip({ type: "cruise", category: def.category, displayColor: def.color, angle: 0, playerName: getProfile(game.shopSlot).name });
  slimDockShip(o);
  o.root.rotation.y = Math.PI; // bow towards the dock's head
  o.root.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(o.model);
  o.draft = -b.min.y;
  o.len = b.max.x - b.min.x;
  o.cx = (b.max.x + b.min.x) / 2;
  o.restY = Math.max(DK.REST_MIN, DK.FLOOR + 1.4 + o.draft);
  o.root.position.y = -400;
  o.careen = def.category === "Carrack";
  o.sails = [];
  if (o.careen) o.model.traverse((c) => c.isMesh && c.material.map === carrackTex.sail && o.sails.push(c));
  dockScene.add(o.root);
  if (o.proxy) {
    // her materials are made ready now, usually while she is still out of sight
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(composer.renderTarget1);
    renderer.compileAsync(o.root, dockCamera, dockScene);
    renderer.setRenderTarget(prev);
  }
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
  dock3.caulk = p.caulk;
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
  if (o.category === "Carrack") return buildCareenRig(o);
  const blocks = new THREE.Group();
  const bh = Math.max(0.6, keel - FLOOR);
  const stacks = [];
  for (let x = -o.len * 0.44; x <= o.len * 0.44; x += 7) for (const z of [-o.halfBeam * 0.5, 0, o.halfBeam * 0.5]) stacks.push([x, z]);
  if (dockModels) {
    blocks.add(propRow("block", stacks.map(([x, z]) => [x, FLOOR, z, bh - 0.4])), propRow("cap", stacks.map(([x, z]) => [x, keel - 0.2, z])));
  }
  for (let x = -o.len * 0.44; x <= o.len * 0.44 && !dockModels; x += 7) {
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
      if (dockModels) {
        const shore = mesh(dockModels.props.shore, dockModels.propsMaterial);
        shore.position.copy(a);
        shore.scale.y = a.distanceTo(bpt);
        shore.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), bpt.clone().sub(a).normalize());
        rig2.add(shore);
      } else rig2.add(strut(a, bpt, 0.24, DM.timber, 8));
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
  const bays = [];
  for (let x = x0; x <= x1 + 0.01; x += 3.5) bays.push(x);
  if (dockModels) rig2.add(propRow("scaffold", levels.flatMap((y) => bays.map((x) => [x, y, zS]))));
  for (const x of dockModels ? [] : bays) {
    for (const z of [zS, zS - 2]) rig2.add(box(0.14, topY - FLOOR, 0.14, DM.steel, x, (topY + FLOOR) / 2, z));
  }
  (dockModels ? [] : levels).forEach((y, i) => {
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
  mergeStaticMeshes(rig2, new Set(rig2.children.filter((c) => (c.userData && c.children.length) || c.geometry === dockModels?.props.shore)));
  return { blocks, rig2, emitters, caulk: null };
}

// The carrack is not dry-docked. As such ships were, she is careened: afloat at
// the quay, her sails struck, hove down by tackles from her mastheads until
// her bottom shows, while shipwrights on rafts caulk the seams and pay them
// with hot pitch.
const CAREEN_ANGLE = 0.6; // radians she is hove over, masts towards the quay

function buildCareenRig(o) {
  const { Q, W } = DK;
  const hw = W / 2;
  const blocks = new THREE.Group(); // nothing under her keel: she lies afloat
  const rig2 = new THREE.Group();
  const R = seeded(99);
  const caulk = { workers: [], pot: makePitchPot(), stirrer: null };
  // lay her where and how she will lie, to measure
  const home = o.root.position.clone();
  o.root.position.set(-o.cx, 0, 0);
  o.tilt.rotation.x = -CAREEN_ANGLE;
  o.root.updateMatrixWorld(true);
  // The heaving-down tackles: from the fighting tops to bitts on the quay, and
  // the gangs hauling on their falls.
  for (const [mx, my] of [[8.5, 24], [-2, 27]]) {
    const head = o.model.localToWorld(new THREE.Vector3(mx, my + CARRACK_LIFT, 0));
    rig2.add(box(0.9, 0.9, 0.9, DM.timber, head.x, head.y, head.z)); // the tackle block
    for (const dx of [-6, 6]) {
      const bitt = new THREE.Vector3(head.x + dx, Q + 1.7, hw + 3.4);
      // the tackle's two parts, nearly bar taut, and the fall to the hands with its tail coiled behind them
      const end = new THREE.Vector3(bitt.x, Q + 1.2, bitt.z + 8);
      const ropes = [-0.18, 0.18].map((off) => ({ curve: ropeCurve(head.clone().setX(head.x + off), bitt.clone().setX(bitt.x + off), { sag: 0.25 + off, seed: dx + off }), r: 0.1, sides: 9, sway: 0.025 }));
      ropes.push({ curve: ropeCurve(bitt, end, { sag: 0.12, kink: 0.06, seed: dx }), r: 0.1, sides: 9 });
      const coil = ropeCoil(bitt.x, Q, end.z + 2.6, 0.9, 0.1, 4, dx + mx);
      ropes.push({ curve: ropeCurve(end, coil.points[0], { sag: 0.5, kink: 0.35, seed: mx, floor: () => Q + 0.1 }), r: 0.1, sides: 9 });
      ropes.push({ curve: coil, r: 0.1, sides: 9 });
      rig2.add(mesh(ropeGeometry(ropes), hempMat));
      rig2.add(cylinder(0.55, 0.75, 2.4, DM.timber, bitt.x, Q + 1.1, bitt.z, 8));
      for (let i = 0; i < 3; i++) {
        const hand = townsman(R, i % 2 ? DM.leather : DM.linen);
        hand.g.position.set(bitt.x + 0.5, Q, bitt.z + 2.4 + i * 2.2);
        hand.g.rotation.y = Math.PI; // facing the ship, heaving
        hand.g.rotation.x = -0.25; // leaning back on the rope
        hand.arm.rotation.x = -0.15;
        rig2.add(hand.g);
      }
    }
  }
  // Rafts along her raised side, a caulker on each.
  const ray = new THREE.Raycaster();
  const planking = []; // solid parts only: the lantern glows (sprites) can't be ray-tested
  o.model.traverse((c) => {
    if (c.isMesh) planking.push(c);
  });
  const raft = (x, z, w, d) => {
    for (let k = 0; k < 5; k++) rig2.add(mesh(CylG(0.34, 0.34, w, 10).rotateZ(Math.PI / 2), DM.timber).translateX(x).translateY(0.05).translateZ(z - d / 2 + 0.35 + (k * (d - 0.7)) / 4));
    rig2.add(box(w - 0.6, 0.12, d - 0.3, DM.wood, x, 0.42, z));
  };
  const feet = 0.48;
  const strikeY = feet + 0.45 * OLD_FOLK; // the height of the caulking iron
  let outer = -o.halfBeam;
  [-12, 0, 11].forEach((along, i) => {
    const x = -o.cx + along;
    ray.set(new THREE.Vector3(x, strikeY, -60), new THREE.Vector3(0, 0, 1));
    const hit = ray.intersectObjects(planking, false)[0];
    if (!hit) return;
    const z = hit.point.z - 0.4 * OLD_FOLK;
    outer = Math.min(outer, z);
    const hand = townsman(R, i % 2 ? DM.leather : DM.linen, true);
    hand.g.position.set(x, feet, z);
    rig2.add(hand.g);
    raft(x, z - 0.4, 6.5, 3.6);
    caulk.workers.push({ arm: hand.arm, strike: new THREE.Vector3(x - 0.25, strikeY, hit.point.z - 0.05), phase: i * 0.37, beat: 0 });
  });
  // The pitch pot on a raft of its own, clear of the hull, and its tender.
  const potAt = new THREE.Vector3(-o.cx - 4, feet, outer - 6.5);
  raft(potAt.x - 0.8, potAt.z, 8, 5);
  caulk.pot.group.position.copy(potAt);
  const tender = townsman(R, DM.leather, true);
  tender.g.position.set(potAt.x - 2.3, feet, potAt.z);
  tender.g.rotation.y = Math.PI / 2; // facing the pot
  caulk.stirrer = tender.arm;
  caulk.light = potAt.clone().setY(1.8);
  rig2.add(caulk.pot.group, tender.g);
  o.tilt.rotation.x = 0;
  o.root.position.copy(home);
  o.root.updateMatrixWorld(true);
  mergeStaticMeshes(rig2, new Set(rig2.children.filter((c) => c.userData && c.children.length)));
  return { blocks, rig2, emitters: [], caulk };
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
  if (o.careen) {
    // afloat the whole time, going over (dock3.heel) instead of settling on blocks
    const upright = 1 - dock3.heel;
    o.root.position.set(dock3.shipX - o.cx, bob * 0.18 * (0.3 + 0.7 * upright), 0);
    o.tilt.rotation.z = Math.sin(dock3.time * 0.7) * 0.012 * bob * upright;
    o.tilt.rotation.x = Math.sin(dock3.time * 0.5 + 1) * 0.008 * bob - CAREEN_ANGLE * dock3.heel;
    for (const sail of o.sails) sail.visible = dock3.heel < 0.3;
    o.navLights.visible = o.navLights.visible && upright > 0.7;
    return;
  }
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
    const careen = dock3.ship.careen; // the basin stays full: she is hove down instead
    dock3.level = careen ? 0 : DK.FLOOR * smoothstep(0, 1, (t - A - C) / DK_DRAIN);
    dock3.heel = careen ? smoothstep(0, 1, (t - A) / (C + DK_DRAIN)) : 0;
    if (t >= END) {
      dock3.shipX = 0;
      dock3.gate = 0;
      dock3.level = careen ? 0 : DK.FLOOR;
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
    const careen = dock3.ship.careen;
    if (careen) dock3.heel = p === "flood" ? 1 - smoothstep(0, 1, s) : p === "drain" ? smoothstep(0, 1, s) : 0;
    if (careen && (p === "flood" || p === "drain")) dock3.level = 0;
    else if (p === "flood") dock3.level = DK.FLOOR * (1 - smoothstep(0, 1, s));
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
        dock3.level = dock3.ship.careen ? 0 : DK.FLOOR;
        dock3.heel = dock3.ship.careen ? 1 : 0;
        dock3.gate = 0;
      }
    }
  }
  posDockShip(dock3.level, 1);
  // for the sound (audio.js)
  const clip = dock3.phase === "clip";
  const dry = !dock3.ship.careen;
  g.pumping = dry && ((clip && t >= A + C && t < END) || dock3.phase === "flood" || dock3.phase === "drain");
  g.gateMoving = dry && ((clip && t >= A && t < A + C) || dock3.phase === "open" || dock3.phase === "close");
  // The open gate slides into its recess in the quay and lifts, so its top stays in view beside the entrance.
  dock3.gateObj.position.z = dock3.gate * (DK.W + 0.8);
  dock3.gateObj.position.y = dock3.gate * 2;
  dock3.basin.position.y = dock3.level - 0.03;
  // The last metres of water thin out gradually, showing the dock floor through them, rather than vanishing as a blue sheet.
  const depth = dock3.level - DK.FLOOR;
  dock3.basin.visible = depth > 0.02;
  dock3.basin.material.uniforms.alpha.value = Math.min(1, depth / 2.5) ** 1.5;
  dock3.rig2.visible = dry ? dock3.level <= DK.FLOOR + 3 : dock3.heel > 0.97;
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
  stepLorries(dt);
  for (const m of dock3.movers) {
    if (m.buoy) {
      m.root.position.y = m.baseY + Math.sin(T * 0.9 + m.root.userData.phase) * 0.35;
      m.root.rotation.z = Math.sin(T * 0.7 + m.root.userData.phase) * 0.1;
    } else if (m.tilt) {
      m.navLights.visible = !!dock3.nightApplied;
      m.root.position.y = m.baseY + Math.sin(T * 0.6 + m.root.position.x) * 0.2;
      m.tilt.rotation.z = Math.sin(T * 0.5 + m.root.position.z) * 0.015;
    }
  }
  updateWetQuay(dt);
  for (const w of dock3.people) {
    w.rotation.y = w.userData.base + Math.sin(T * 0.4 + w.userData.phase) * 0.5;
  }
  dock3.gulls.forEach((gull, i) => {
    const u = gull.userData.flight;
    u.a += dt * u.speed;
    // an uneven circle, so no two laps are the same
    const r = u.r * (1 + 0.18 * Math.sin(u.a * 2.3 + i) + 0.08 * Math.sin(u.a * 5.1 + i * 2));
    const flapping = Math.sin(T * 0.43 + i * 2.2) > 0.35;
    u.effort += ((flapping ? 1 : 0) - u.effort) * Math.min(1, dt * 3);
    u.beat += dt * (11 + (i % 3));
    gull.position.set(u.cx + Math.cos(u.a) * r, u.h + Math.sin(u.a * 3 + i) * 2.5 - 0.15 * u.effort * Math.sin(u.beat), u.cz + Math.sin(u.a) * r);
    gull.rotation.set(0, -(u.a + Math.PI / 2), 0);
    gull.rotateZ(0.07 * Math.cos(u.a * 3 + i));
    gull.rotateX(Math.min(0.6, Math.atan((u.speed * u.speed * r) / 6)) + 0.06 * Math.sin(T * 1.7 + i));
    poseGull(u.bird, u.beat, u.effort);
  });
  for (const s of dock3.smoke) {
    const u = s.userData;
    u.age += dt;
    if (u.age > 8) u.age = 0;
    const k = u.age / 8;
    if (dock3.era && dock3.forge) {
      s.position.set(dock3.forge.x + k * 7, dock3.forge.y + k * 16, dock3.forge.z + k * 2);
      s.scale.setScalar(1.2 + k * 7);
    } else {
      s.position.set(-250 + k * 30, 66 + k * 70, 140 + k * 8);
      s.scale.setScalar(5 + k * 26);
    }
    s.material.opacity = Math.sin(Math.min(1, k * 1.2) * Math.PI) * 0.38;
  }
  if (dock3.era) {
    for (const step of dock3.oldAnim) step(T, dt);
    dock3.torches.forEach((f, i) => {
      const flick = 0.8 + 0.2 * Math.sin(T * (11 + (i % 5)) + i * 2.3);
      f.scale.set((dock3.nightApplied ? 3.4 : 1.2) * flick, (dock3.nightApplied ? 4.2 : 1.8) * flick, 1);
      f.material.opacity = dock3.nightApplied ? 0.95 : 0.55;
    });
  }
  // Repairs: welding sparks and flash; on the carrack, mallet blows that knock
  // out shreds of oakum and splinters, and the fire under the pitch pot.
  const sp = dock3.sparks;
  const pos = sp.pts.geometry.attributes.position;
  const repairing = dock3.rig2.visible && dock3.phase === "idle";
  const caulk = dock3.caulk;
  const welding = repairing && !caulk;
  const look = sp.pts.material;
  look.color.setHex(caulk ? 0xb99a66 : 0xffd27a);
  look.size = caulk ? 0.22 : 0.45;
  look.blending = caulk ? THREE.NormalBlending : THREE.AdditiveBlending;
  const spray = (e, count, speed) => {
    for (let i = 0; i < count; i++) {
      const j = sp.next;
      sp.next = (sp.next + 1) % sp.N;
      pos.setXYZ(j, e.x, e.y, e.z);
      sp.vel[j * 3] = (Math.random() - 0.5) * speed;
      sp.vel[j * 3 + 1] = Math.random() * speed * 0.85 + 0.5;
      sp.vel[j * 3 + 2] = (Math.random() - 0.5) * speed;
      sp.life[j] = 0.5 + Math.random() * 0.5;
    }
  };
  if (welding) for (let i = 0; i < 6; i++) spray(dock3.emitters[Math.floor(Math.random() * dock3.emitters.length)], 1, 7);
  if (caulk && repairing) {
    for (const w of caulk.workers) {
      // lift the mallet slowly, bring it down smartly, rest a moment
      const k = (T / 0.95 + w.phase) % 1;
      const lift = k < 0.62 ? smoothstep(0, 0.62, k) : k < 0.75 ? 1 - (k - 0.62) / 0.13 : 0;
      w.arm.rotation.x = 0.12 - lift * 1.5;
      const beat = Math.floor(T / 0.95 + w.phase + 0.25); // turns over as the mallet lands (k = 0.75)
      if (beat !== w.beat) {
        w.beat = beat;
        spray(w.strike, 7, 3.2);
        game.dock.knocks = (game.dock.knocks || 0) + 1;
      }
    }
    caulk.stirrer.rotation.x = 0.35 + Math.sin(T * 1.8) * 0.3;
    caulk.pot.flames.forEach((f, i) => {
      const a = (i * Math.PI) / 3;
      const flick = 0.6 + 0.4 * Math.sin(T * (9 + i * 1.7) + i * 2);
      f.position.set(Math.cos(a) * 1.05, 0.4 + flick * 0.3, Math.sin(a) * 1.05); // licking up round the pot
      f.scale.set(1.1, 1 + flick * 1.3, 1);
      f.material.opacity = 0.55 + 0.35 * flick;
    });
    caulk.pot.smoke.forEach((s, i) => {
      const k = (T * 0.16 + i / caulk.pot.smoke.length) % 1;
      s.position.set(k * 2.2, 1.9 + k * 8, Math.sin(k * 5 + i) * 0.5);
      s.scale.setScalar(1.6 + k * 6);
      s.material.opacity = Math.sin(Math.PI * k) * 0.8;
    });
  }
  for (let j = 0; j < sp.N; j++) {
    if (sp.life[j] <= 0) { pos.setXYZ(j, 0, -1000, 0); continue; }
    sp.life[j] -= dt;
    sp.vel[j * 3 + 1] -= 18 * dt;
    pos.setXYZ(j, pos.getX(j) + sp.vel[j * 3] * dt, pos.getY(j) + sp.vel[j * 3 + 1] * dt, pos.getZ(j) + sp.vel[j * 3 + 2] * dt);
  }
  pos.needsUpdate = true;
  // One light for both, so the light count (and the shaders) never changes: blue arc or orange fire.
  dock3.weldLight.visible = repairing;
  game.dock.welding = welding;
  game.dock.caulking = repairing && !!caulk;
  if (repairing) {
    dock3.weldLight.color.setHex(caulk ? 0xff8a30 : 0xaed4ff);
    dock3.weldLight.position.copy(caulk ? caulk.light : dock3.emitters[0]);
    dock3.weldLight.intensity = caulk ? 22 + 7 * Math.sin(T * 11) + 4 * Math.sin(T * 27) : Math.random() > 0.35 ? 40 + Math.random() * 60 : 5;
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
  fog.color.set(on ? 0x060d1c : DOCK_HAZE);
  fog.near = on ? 600 : 2600;
  fog.far = on ? 5200 : 10000;
  dockScene.background = on ? nightSkyColor : null;
  dock3.skyDome.visible = !on;
  dock3.stars.visible = on;
  dockScene.environmentIntensity = on ? 0.12 : 0.75;
  dock3.sunLight.color.setHex(on ? 0x9fb6ff : SUN_DAY);
  dock3.sunLight.intensity = on ? 0.9 : 3.7;
  dock3.hemi.intensity = on ? 0.22 : 0.7;
  const u = dock3.sea.material.uniforms;
  u.sunColor.value.setHex(on ? 0x2a3350 : 0xfff1d6);
  u.waterColor.value.setHex(on ? 0x021626 : SEA_BLUE);
  for (const w of [dock3.sea, dock3.basin]) mirrorTime(w, on);
  dock3.shallow.material.color.setHex(on ? 0x12384a : 0x3d6670);
  dock3.shallow.material.opacity = on ? 0.35 : 0.5;
  dock3.fade.material.color.setHex(on ? 0x082c3c : 0x1c5f78);
  // Bright enough to read as lit, not so bright that bloom turns small lamps into flickering glare.
  DM.lamp.emissiveIntensity = on ? 2.6 : 1.2;
  for (const m of dock3.litMats) m.emissiveIntensity = on ? 2.4 : 0;
  for (const im of dock3.pools) im.visible = on;
  // By day the floodlights are taken out altogether: even a dark lamp is
  // worked out for every pixel it might light.
  for (const sp of dock3.spots) {
    sp.visible = on;
    sp.intensity = on ? sp.userData.watts || 6000 : 0;
  }
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
    people: [], wet: null, smoke: [], sparks: null, weldLight: null, emitters: [], caulk: null, movers: [], blink: [], litMats: [], pools: [], spots: [], truckGlows: [],
    next: null, leaving: null, stars: null, skyDome: null, sunLight: null, hemi: null, nightApplied: null, openFor: null, timedFor: null,
    modern: null, old: null, oldAnim: [], torches: [], forge: null, era: undefined, eraTurn: 0, heel: 0
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
  // clock starts once the dock is on screen, not when the button was pressed.
  const first = dock3.timedFor !== game.dock;
  if (!dock3.built) buildDockyard();
  if (first) game.dock.start = performance.now() / 1000;
  dock3.time += dt;
  dock3.frame = (dock3.frame || 0) + 1;
  // The clip's clock moves with the frames (never more than 1/20 s at a time),
  // so a stalled frame slows the film a little instead of jumping it; skipping
  // the clip still jumps.
  const real = performance.now() / 1000 - game.dock.start;
  if (first) dock3.clipT = 0;
  dock3.clipT = real - dock3.clipT > 2 ? real : Math.min(real, dock3.clipT + Math.min(dt, 0.05));
  const t = dock3.clipT;
  updateDockState(t, dt);
  const light = updateDockEra(dt);
  game.dock.arsenal = dock3.era; // the title and the sounds follow (game.js, audio.js)
  updateDockEffects(dt);
  updateDockCamera(t, dt);
  const nightNow = !!game.settings.nightMode;
  if (dock3.nightApplied !== nightNow) applyDockNight(nightNow);
  for (const ship of [dock3.ship, dock3.leaving?.o]) if (ship?.glow) ship.glow.emissiveIntensity = nightNow ? 2.4 : 0;
  if (first) prewarmDock(); // after day or night is set: the shaders differ with the lamps
  dock3.stars.position.copy(dockCamera.position);
  driftClouds(dock3.skyDome, dt);
  bloomPass.strength = nightNow ? 0.8 : 0.42;
  // By daylight hardly anything is bright enough to glow, so the lighter levels
  // save the work.
  bloomPass.enabled = QUALITY_LEVELS[perf.level].bloom && (nightNow || dkq.detail);
  const rp = composer.passes[0];
  rp.scene = dockScene;
  rp.camera = dockCamera;
  renderer.toneMappingExposure = (nightNow ? 0.75 : 0.85) * light;
  renderer.shadowMap.needsUpdate = true;
  composer.render(dt);
  dock3.timedFor = game.dock;
  if (!game.dock.ready) {
    // The splash goes after a few drawn frames (the first ones can still stall).
    game.dock.drawn += 1;
    game.dock.ready = game.dock.drawn >= 3;
    game.dock.start = performance.now() / 1000;
    dock3.clipT = 0;
  }
}


// ---------------------------------------------------------------------------
// The harbours in the carrack's age. While the Hospitaller carrack is in play,
// both harbours become the Order's port in the Grand Harbour of Malta as it
// looked in the 16th century: limestone quays and cliffs, a great fort over
// the anchorage, the walled town, galley sheds, a ropewalk, windmills, the
// boom chain swung open and small boats. The land, quay faces, breakwaters and
// moored boats keep the game's shapes (HARBOUR_LAYOUT): only the look changes.
// Built from the same kit as the arsenal in the dockyard, in each harbour's own
// frame (x = a along the first quay's normal, z = -b).
// ---------------------------------------------------------------------------

const oldPort = { built: false, level: -1, shown: false, frames: 0, since: 0, time: 0, anims: [], torches: [], lit: [], smoke: [], small: [], textures: [] };
const ERA_SPLASH_MS = 900; // the "please wait" screen stays at least this long
const FORT_AT = -48; // the fort's centre, the same distance in from both quays' land
const OLD_HARBOUR_FOLK = 1.8; // people here are a little larger than life, as in the arsenal

const cliffMat = shared(mat(0xcbb084, { roughness: 0.95 }));
const oldGroundMat = shared(mat(0xbd9d66, { roughness: 1 })); // bare, dry limestone ground
const strataMat = shared(mat(0xffffff, { roughness: 0.95, vertexColors: true, flatShading: true }));
for (const m of [cliffMat, oldGroundMat]) {
  m.map = rockMat.map;
  m.normalMap = rockMat.normalMap;
}

// Once per frame: when the wanted age differs from the one on screen, the
// "please wait" screen goes up (view3d.eraChange, game.js), the harbours are
// rebuilt behind it and it comes down after a few drawn frames. True while the
// screen is still on its way up: nothing is drawn then.
function stepEraChange() {
  if (graphicsCheck.running) return false;
  const old = oldEra();
  if (!view3d.eraChange) {
    const stale = old && oldPort.level !== perf.level; // built for another graphics level
    if (old === oldPort.shown && !stale) return false;
    view3d.eraChange = old ? "Returning the harbours to the age of the Knights..." : "Returning to the present-day harbours...";
    oldPort.frames = 0;
  }
  oldPort.frames += 1;
  if (oldPort.frames <= 2) return true;
  if (oldPort.frames === 3) {
    setHarbourEra(old);
    renderer.compile(scene, camera);
    oldPort.since = performance.now();
  } else if (oldPort.frames > 8 && performance.now() - oldPort.since > ERA_SPLASH_MS) view3d.eraChange = null;
  return false;
}

function setHarbourEra(old) {
  if (old && oldPort.level !== perf.level) {
    dismantleOldPorts();
    buildOldPorts();
  }
  oldPort.shown = old;
  for (const e of harbourEras) {
    e.modern.visible = !old;
    if (e.old) e.old.visible = old;
  }
  for (const part of buoyParts) part.im.visible = part.old === old;
}

function dismantleOldPorts() {
  for (const e of harbourEras) {
    if (!e.old) continue;
    scene.remove(e.old);
    disposeTree(e.old);
    e.old = null;
  }
  for (const t of oldPort.textures) t.dispose();
  Object.assign(oldPort, { built: false, level: -1, anims: [], torches: [], lit: [], smoke: [], small: [], textures: [] });
}

function buildOldPorts() {
  dkq = DK_TIERS[clamp(perf.level, 0, DK_TIERS.length - 1)];
  const T = dockTextures();
  if (!DM) DM = dockMaterials(T);
  const M = arsenalMaterials(T);
  oldPort.textures = [...Object.values(T), M.stone.map, M.arch.map, M.paving.map, M.tiles.map];
  harbourEras.forEach((e, i) => {
    e.old = buildOldPort(e.h, i, M);
    scene.add(e.old);
  });
  oldPort.built = true;
  oldPort.level = perf.level;
}

function updateOldPorts(dt) {
  const ships = game.harbourShip ? [game.harbourShip] : humanShips();
  const tanker = ships.some((s) => TANKERS[s.category]); // her hose needs the pumps, whatever the age
  for (const e of harbourEras) e.pumps.visible = !oldPort.shown || tanker;
  if (!oldPort.shown) return;
  const T = (oldPort.time += dt);
  for (const step of oldPort.anims) step(T, dt);
  oldPort.torches.forEach((flame, i) => {
    flame.size = (night.on ? 6.5 : 1.6) * (0.85 + 0.15 * Math.sin(T * 12 + i * 2.3));
    flame.opacity = night.on ? 0.95 : 0.55;
  });
  for (const m of oldPort.lit) m.emissiveIntensity = night.on ? 1.8 : 0;
  for (const s of oldPort.smoke) {
    const u = s.userData;
    const k = (T / 7 + u.phase) % 1;
    s.position.set(u.x + k * 5, u.y + k * 13, u.z + k * 1.5);
    s.scale.setScalar(1 + k * 6);
    s.material.opacity = Math.sin(Math.min(1, k * 1.2) * Math.PI) * 0.36;
  }
}

function buildOldPort(h, index, M) {
  const R = seeded(1530 + index * 41);
  const root = new THREE.Group();
  toWorld(h.corner.x, h.corner.y, 0, root.position);
  root.rotation.y = h.sa > 0 ? 0 : Math.PI; // both harbours share one layout, turned half round
  const S = new THREE.Group(); // everything that stands still
  root.add(S);
  const port = { h, R, M, root, S, flames: [] };
  oldLand(port);
  oldQuays(port);
  oldBreakwaters(port);
  oldFort(port, index ? 0.84 : 1);
  oldWaterfront(port);
  oldTown(port);
  oldCliffs(port);
  oldBoats(port);
  oldQuayLife(port);
  mergeStaticMeshes(S, new Set());
  // Small things are left out of the sea's mirror (they hardly show in it) and
  // cast shadows only on the best graphics.
  for (const o of S.children) {
    if (o.material !== M.iron && o.material !== M.clay && o.material !== M.dark) continue;
    o.castShadow = o.castShadow && dkq.geo >= 1.6;
    oldPort.small.push(o);
  }
  const flames = new THREE.Points(
    new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(port.flames, 3)),
    new THREE.PointsMaterial({ map: glowSoft, color: 0xff9a30, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  root.add(flames);
  oldPort.torches.push(flames.material);
  return root;
}

// A box given by its span in the harbour's frame.
function oldSlab(port, a0, a1, b0, b1, y, height, material, tile = 6) {
  port.S.add(oldBox(a1 - a0, height, b1 - b0, material, (a0 + a1) / 2, y, -(b0 + b1) / 2, tile));
}

// A torch on its post; the harbour's flames are gathered and drawn together.
function oldTorch(port, a, y, b) {
  const { M, S, flames } = port;
  S.add(cylinder(0.09, 0.12, 2.6, M.oak, a, y + 1.3, -b, 6), cylinder(0.28, 0.18, 0.3, M.iron, a, y + 2.7, -b, 8));
  flames.push(a, y + 3.2, -b);
}

function oldLand(port) {
  for (const p of HARBOUR_LAYOUT) {
    if (p.kind === "moored") continue;
    const flat = { ax: p.a1 + HALF_W, ay: HALF_H - p.b1, bx: p.a2 + HALF_W, by: HALF_H - p.b2, r: p.r };
    port.S.add(capsuleBlock(flat, -3, p.kind === "mole" ? LAND_TOP + 0.5 : LAND_TOP, p.kind === "mole" ? [port.M.paving, cliffMat] : [oldGroundMat, cliffMat]));
  }
}

// Dressed stone quays along both faces, with oak mooring posts, timber fender
// piles, iron rings and torches.
function oldQuays(port) {
  const { M, S } = port;
  const end = BASIN + 12;
  const top = LAND_TOP + 0.15;
  oldSlab(port, 4, 22, 4, end, top, 0.3, M.paving, 9);
  oldSlab(port, 22, end, 4, 22, top, 0.3, M.paving, 9);
  oldSlab(port, 21.4, 22.3, 22, end, LAND_TOP + 0.22, 0.6, M.stone, 3);
  oldSlab(port, 22, end, 21.4, 22.3, LAND_TOP + 0.22, 0.6, M.stone, 3);
  oldSlab(port, 21.8, 22.2, 22, end, 1.4, 5.4, M.stone, 3.5);
  oldSlab(port, 22, end, 21.8, 22.2, 1.4, 5.4, M.stone, 3.5);
  for (let k = BOLLARD_FIRST, n = 0; k <= BASIN - 4; k += BOLLARD_STEP, n++) {
    for (const [a, b, fa, fb] of [[20.5, k, 22.45, k + 3.5], [k, 20.5, k + 3.5, 22.45]]) {
      S.add(cylinder(0.2, 0.27, 0.8, M.oak, a, LAND_TOP + 0.55, -b, 8));
      if (n % 2) S.add(cylinder(0.24, 0.24, 5.2, M.oak, fa, 1.2, -fb, 8));
      else {
        const ring = mesh(new THREE.TorusGeometry(0.34, 0.07, 6, 14), M.iron);
        ring.position.set(fa - (fa < fb ? 0.15 : 0), 2.4, -(fb - (fb < fa ? 0.15 : 0)));
        ring.rotation.y = fa < fb ? Math.PI / 2 : 0;
        S.add(ring);
      }
    }
  }
  for (let k = 26; k < BASIN; k += 46) {
    oldTorch(port, 3, LAND_TOP, k);
    oldTorch(port, k + 14, LAND_TOP, 3);
  }
}

// The breakwaters: rubble-footed stone moles with a battlemented parapet, a
// watchtower with its beacon fire on each head, and the great boom of logs and
// chain swung open along the inside of the first.
function oldBreakwaters(port) {
  const { M, S, R } = port;
  const rock = roughen(new THREE.DodecahedronGeometry(1, 1), 0.35, 9);
  const spots = [];
  for (let u = 26; u < MOLE_END - 2; u += 2.2) {
    for (const side of [-5.6, 5.6]) {
      spots.push([BASIN + side, u], [u, BASIN + side]);
    }
  }
  const rubble = new THREE.InstancedMesh(rock, M.stone, spots.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  spots.forEach(([a, b], i) => {
    q.setFromEuler(e.set(R() * 3, R() * 3, R() * 3));
    const size = 0.8 + R() * 0.7;
    rubble.setMatrixAt(i, m4.compose(p.set(a + R() - 0.5, 0.2 + R() * 2, -(b + R() - 0.5)), q, sc.set(size, size * 0.75, size)));
  });
  rubble.castShadow = rubble.receiveShadow = true;
  S.add(rubble);
  const wallY = LAND_TOP + 1.4;
  oldSlab(port, BASIN + 3.6, BASIN + 5, 24, MOLE_END - 6, wallY, 1.8, M.stone, 3);
  oldSlab(port, 24, MOLE_END - 6, BASIN + 3.6, BASIN + 5, wallY, 1.8, M.stone, 3);
  for (let u = 27; u < MOLE_END - 8; u += 4.4) {
    oldSlab(port, BASIN + 3.6, BASIN + 5, u, u + 2.2, wallY + 1.5, 1.2, M.stone, 3);
    oldSlab(port, u, u + 2.2, BASIN + 3.6, BASIN + 5, wallY + 1.5, 1.2, M.stone, 3);
  }
  watchtower(port, BASIN, MOLE_END, 5.4, 13);
  watchtower(port, MOLE_END, BASIN, 4.2, 8);
  for (const u of [60, 125]) {
    S.add(bannerPole(M, BASIN + 1, LAND_TOP + 0.5, -u, 9));
    oldTorch(port, u + 20, LAND_TOP + 0.5, BASIN + 1);
  }
  // the boom: logs moored head to tail, joined by chain, from a capstan on the mole
  const inner = BASIN - 7.9;
  const link = (x0, y0, b0, x1, y1, b1) => S.add(strut(new THREE.Vector3(x0, y0, -b0), new THREE.Vector3(x1, y1, -b1), 0.16, M.iron, 6));
  for (let b = 64; b < 172; b += 7.4) {
    const log = mesh(CylG(0.6, 0.6, 6.2, 10).rotateX(Math.PI / 2), M.timber);
    log.position.set(inner, 0.3, -b - 3.1);
    S.add(log);
    link(inner, 0.7, b + 6.2, inner, 0.7, b + 7.4);
    for (const band of [1.2, 5]) S.add(box(1.35, 1.35, 0.2, M.iron, inner, 0.3, -b - band));
  }
  S.add(cylinder(0.7, 0.9, 2, M.oak, BASIN - 2, LAND_TOP + 1.5, -48, 10));
  for (let i = 0; i < 4; i++) S.add(strut(new THREE.Vector3(BASIN - 2, LAND_TOP + 1.9, -48), new THREE.Vector3(BASIN - 2 + Math.cos(i * 1.571) * 2.8, LAND_TOP + 1.9, -48 + Math.sin(i * 1.571) * 2.8), 0.12, M.timber));
  link(BASIN - 2.6, LAND_TOP + 1.4, 49, inner, 0.7, 64);
}

function watchtower(port, a, b, r, height) {
  const { M, S } = port;
  const y = LAND_TOP + height;
  S.add(cylinder(r, r * 1.18, height + 1, M.stone, a, LAND_TOP + (height - 1) / 2, -b, 18));
  S.add(cylinder(r * 1.12, r, 1.2, M.stone, a, y + 0.1, -b, 18));
  for (let i = 0; i < 10; i++) {
    const turn = (i / 10) * Math.PI * 2;
    S.add(oldBox(1.2, 1.5, 1.2, M.stone, a + Math.cos(turn) * r, y + 1.4, -b + Math.sin(turn) * r, 3));
  }
  for (let i = 0; i < 4; i++) S.add(box(0.5, 1.4, 0.5, M.dark, a + Math.cos(i * 1.571 + 0.7) * r * 1.04, LAND_TOP + height * 0.55, -b + Math.sin(i * 1.571 + 0.7) * r * 1.04));
  S.add(bannerPole(M, a - r * 0.5, y + 0.6, -b, 9));
  oldTorch(port, a + r * 0.3, y - 1.6, b); // the beacon fire
}

// The fort at the head of the creek, where the two quays meet: bastions stepped
// one above another with a keep and chapel on top and bronze guns trained on
// the anchorage (Fort St Angelo over Birgu; its smaller neighbour over Senglea).
function oldFort(port, size) {
  const { M, S, root } = port;
  const F = new THREE.Group();
  bastion(M, F, 0, 0, 66, 66, 12, 0);
  bastion(M, F, -5, 0, 44, 46, 10, 12);
  bastion(M, F, -9, 0, 24, 28, 9, 22);
  F.add(oldBox(11, 9, 12, M.stone, -10, 35.5, 0), oldBox(12, 0.7, 13, M.stone, -10, 40.3, 0, 3));
  F.add(cylinder(3.2, 3.2, 3, M.stone, -10, 42, 0, 14));
  F.add(mesh(new THREE.SphereGeometry(3.3, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.tiles).translateX(-10).translateY(43.5));
  for (const [x, y, z, h] of [[22, 12, -22, 12], [22, 12, 22, 12], [-17, 31, -9, 16], [8, 22, 0, 10]]) F.add(bannerPole(M, x, y, z, h));
  for (const z of [-18, -9, 0, 9, 18]) F.add(oldGun(M, 23, 12, z, 0));
  for (const z of [-11, 0, 11]) F.add(oldGun(M, 9.5, 22, z, 0));
  F.position.set(FORT_AT, LAND_TOP, -FORT_AT);
  F.rotation.y = Math.PI / 4; // a face looking down the creek
  F.scale.setScalar(size);
  S.add(F);
  for (const [a, b] of [[-4, -22], [-22, -4]]) oldTorch(port, a, LAND_TOP, b);
  windmill(M, S, root, oldPort.anims, -104, LAND_TOP, 64, 0.55); // at a = -104, b = -64
}

// Behind the quays: galley sheds and treadwheel cranes of the arsenal, the long
// roofed ropewalk and the bakehouse for ship's biscuit with its smoking oven.
function oldWaterfront(port) {
  const { M, S, R, root } = port;
  const sheds = new THREE.Group();
  for (let i = 0; i < 5; i++) galleyBay(M, sheds, i * SHED_BAY, 0, 0, i % 2 === 1);
  sheds.add(oldBox(1.6, SHED_WALL, SHED_DEPTH, M.stone, 4.5 * SHED_BAY, SHED_WALL / 2, SHED_DEPTH / 2 + 1));
  for (const i of [0, 2, 4]) sheds.add(bannerPole(M, (i - 0.5) * SHED_BAY, SHED_WALL, 0.5, 7));
  sheds.scale.setScalar(0.75);
  sheds.position.set(42, LAND_TOP, 7);
  S.add(sheds);
  treadwheelCrane(M, R, root, oldPort.anims, 205, LAND_TOP, -13, 0, 0.4);
  treadwheelCrane(M, R, root, oldPort.anims, 13, LAND_TOP, -212, -Math.PI / 2, 2.6);

  // the ropewalk
  for (let b = 150; b <= 300; b += 10) for (const a of [-86, -76]) S.add(box(0.5, 4.4, 0.5, M.oak, a, LAND_TOP + 2.2, -b));
  for (const side of [-1, 1]) {
    const roof = oldBox(6.4, 0.35, 153, M.tiles, -81 + side * 2.9, LAND_TOP + 5.2, -225, 4);
    roof.rotation.z = -side * 0.34;
    S.add(roof);
  }
  // three yarns being laid, resting on a trestle every so often and sagging between them
  S.add(mesh(ropeGeometry([-83, -81, -79].map((a, n) => {
    const end = (k) => new THREE.Vector3(a + Math.sin(k * 2.3 + n) * 0.12, LAND_TOP + 1.6, -151 - k * 18.5);
    const points = Array.from({ length: 8 }, (_, i) => ropeCurve(end(i), end(i + 1), { sag: 0.45 + 0.35 * hash3(a, i, 0, 5), kink: 0.1, seed: i + n * 4 }).points.slice(i ? 1 : 0)).flat();
    return { curve: new THREE.CatmullRomCurve3(points), r: 0.13, sides: 9, sway: 0.03, spans: 8 };
  })), hempMat));
  for (let i = 1; i < 8; i++) S.add(box(5.2, 0.16, 0.3, M.oak, -81, LAND_TOP + 1.4, -151 - i * 18.5), box(0.2, 1.4, 0.2, M.oak, -84, LAND_TOP + 0.7, -151 - i * 18.5), box(0.2, 1.4, 0.2, M.oak, -78, LAND_TOP + 0.7, -151 - i * 18.5));

  // the bakehouse
  oldSlab(port, -40, -22, 126, 144, LAND_TOP + 3.5, 7, M.stone);
  oldSlab(port, -41, -21, 125, 145, LAND_TOP + 7.3, 0.6, M.stone, 3);
  oldSlab(port, -37, -34, 129, 132, LAND_TOP + 10, 5, M.stone, 3);
  oldSlab(port, -22.1, -21.8, 132.4, 136.6, LAND_TOP + 1.5, 3, M.dark); // the oven's mouth
  oldSlab(port, -21.8, -21.7, 133.5, 135.5, LAND_TOP + 0.8, 0.9, M.ember);
  for (let i = 0; i < 7; i++) {
    const puff = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0x8d8a85, transparent: true, opacity: 0, depthWrite: false }));
    puff.userData = { x: -35.5, y: LAND_TOP + 13, z: -130.5, phase: i / 7 };
    root.add(puff);
    oldPort.smoke.push(puff);
  }
}

// Plots that stay clear of houses: the fort, the sheds, the pump yard on the
// first quay (harbourPumps), the ropewalk, bakehouse, churches and windmills.
const OLD_CHURCHES = [[-54, 186], [188, -56]];
function oldPlotTaken(a, b) {
  if (Math.hypot(a - FORT_AT, b - FORT_AT) < 52) return true;
  if (a > 28 && a < 118 && b > -32) return true;
  if (a > -48 && b > 58 && b < 116) return true;
  if (a > -93 && a < -69 && b > 143 && b < 307) return true;
  if (a > -48 && a < -14 && b > 118 && b < 152) return true;
  return [...OLD_CHURCHES, [-104, -64], [-100, 130], [-100, 330], [250, -100]].some(([x, y]) => Math.hypot(a - x, b - y) < 17);
}

// The walled town: flat-roofed limestone houses crowding down to the quays,
// two domed churches, windmills on the ridge and the curtain wall behind.
function oldTown(port) {
  const { h, M, S, R, root } = port;
  const houses = [];
  const trees = [];
  const keep = Math.min(1, 0.55 + dkq.props * 0.3);
  for (let i = 0; i < 57; i++) {
    for (let j = 0; j < 57; j++) {
      const a0 = -100 + i * 8.4;
      const b0 = -100 + j * 8.4;
      if (a0 > -18 && b0 > -18) continue; // the quays and the water
      if (i % 6 === 4 || j % 6 === 4) continue; // the narrow streets between the blocks
      const a = a0 + (R() - 0.5) * 2.6;
      const b = b0 + (R() - 0.5) * 2.6;
      if (oldPlotTaken(a, b) || !onCoast(h, a, b, 6)) continue;
      const pick = R();
      if (pick < 0.07) trees.push({ a, b, r: 1.2 + R() * 1.4 });
      else if (pick < keep) houses.push({ a, b, w: 4.2 + R() * 2.8, d: 4.2 + R() * 2.8, h: 2.8 + R() * R() * 5.5, tint: R(), lit: R() < 0.35 });
    }
  }
  const m4 = new THREE.Matrix4();
  const color = new THREE.Color();
  const batch = (material, count, shadow = true) => {
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, count);
    im.castShadow = im.receiveShadow = shadow;
    S.add(im);
    return im;
  };
  const walls = batch(M.stone, houses.length);
  const parapets = batch(M.stone, houses.length);
  const dark = batch(M.dark, houses.length * 4, false);
  const lamp = new THREE.MeshStandardMaterial({ color: 0x2a1c0e, emissive: 0xffb458, emissiveIntensity: 0 });
  oldPort.lit.push(lamp);
  const lit = batch(lamp, houses.filter((s) => s.lit).length, false);
  let n = 0;
  houses.forEach((s, i) => {
    walls.setMatrixAt(i, m4.makeScale(s.w, s.h, s.d).setPosition(s.a, LAND_TOP + s.h / 2, -s.b));
    // honey, pale and rose-washed stone side by side
    const warm = (s.tint * 7) % 1;
    walls.setColorAt(i, color.setRGB(0.8 + s.tint * 0.4, 0.74 + s.tint * 0.36 + warm * 0.1, 0.66 + s.tint * 0.3 + warm * 0.2));
    parapets.setMatrixAt(i, m4.makeScale(s.w + 0.5, 0.5, s.d + 0.5).setPosition(s.a, LAND_TOP + s.h + 0.1, -s.b));
    parapets.setColorAt(i, color.setRGB(0.78, 0.74, 0.68));
    // windows and the door look towards the nearer quay
    const toA = s.a > s.b;
    const openings = [[0, 0.7, 1.4, 0.8], [-0.28, s.h * 0.68, 0.8, 0.6], [0.28, s.h * 0.68, 0.8, 0.6], [0, s.h * 0.68, 0.8, 0.6]];
    openings.forEach(([along, up, tall, wide], k) => {
      const shown = k < 3 || s.w > 5.6;
      const x = toA ? s.a + along * s.w : s.a + s.w / 2;
      const z = toA ? -s.b - s.d / 2 : -s.b + along * s.d;
      dark.setMatrixAt(i * 4 + k, m4.makeScale(shown ? (toA ? wide : 0.12) : 0, shown ? tall : 0, shown ? (toA ? 0.12 : wide) : 0).setPosition(x, LAND_TOP + up, z));
    });
    if (s.lit) {
      const x = toA ? s.a + 0.28 * s.w : s.a + s.w / 2 + 0.04;
      const z = toA ? -s.b - s.d / 2 - 0.04 : -s.b + 0.28 * s.d;
      lit.setMatrixAt(n++, m4.makeScale(toA ? 0.55 : 0.1, 0.7, toA ? 0.1 : 0.55).setPosition(x, LAND_TOP + s.h * 0.68, z));
    }
  });
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.2, 0.32, 1, 6), trunkMat, trees.length);
  const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, dkq.geo > 1.1 ? 1 : 0), mat(0x5d6f38, { roughness: 0.95, flatShading: true }), trees.length);
  trees.forEach((t, i) => {
    trunks.setMatrixAt(i, m4.makeScale(1, t.r, 1).setPosition(t.a, LAND_TOP + t.r / 2, -t.b));
    crowns.setMatrixAt(i, m4.makeScale(t.r, t.r * 0.75, t.r).setPosition(t.a, LAND_TOP + t.r * 1.4, -t.b));
  });
  trunks.castShadow = crowns.castShadow = true;
  S.add(trunks, crowns);
  for (const [a, b] of OLD_CHURCHES) {
    oldSlab(port, a - 11, a + 11, b - 8, b + 8, LAND_TOP + 6, 12, M.stone);
    oldSlab(port, a - 11.6, a + 11.6, b - 8.6, b + 8.6, LAND_TOP + 12.3, 0.7, M.stone, 3);
    S.add(cylinder(5, 5, 5, M.stone, a, LAND_TOP + 15, -b, 18));
    S.add(mesh(new THREE.SphereGeometry(5.1, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2), M.tiles).translateX(a).translateY(LAND_TOP + 17.5).translateZ(-b));
    S.add(cylinder(0.5, 0.8, 2.4, M.stone, a, LAND_TOP + 23.5, -b, 8));
    oldSlab(port, a + 11, a + 16, b + 3, b + 8, LAND_TOP + 11, 22, M.stone);
    oldSlab(port, a + 10.6, a + 16.4, b + 2.6, b + 8.4, LAND_TOP + 22.3, 0.6, M.stone, 3);
    S.add(mesh(new THREE.ConeGeometry(3.8, 4.5, 4).rotateY(Math.PI / 4), M.tiles).translateX(a + 13.5).translateY(LAND_TOP + 24.8).translateZ(-b - 5.5));
    for (const k of [-1, 1]) S.add(box(0.3, 3, 1.4, M.dark, a + 16.05, LAND_TOP + 19, -b - 5.5 + k * 1.1));
  }
  for (const [a, b, turn] of [[-100, 130, 0.62], [-100, 330, 0.5], [250, -100, 0.57]]) windmill(M, S, root, oldPort.anims, a, LAND_TOP, -b, turn);
  // the curtain wall with its square towers, behind the town on both sides
  oldSlab(port, -112, -108, -108, 352, LAND_TOP + 3.5, 7, M.stone, 5);
  oldSlab(port, -112, 352, -112, -108, LAND_TOP + 3.5, 7, M.stone, 5);
  for (let u = -108; u < 350; u += 6) {
    oldSlab(port, -109.6, -108, u, u + 3, LAND_TOP + 7.7, 1.4, M.stone, 3);
    oldSlab(port, u, u + 3, -109.6, -108, LAND_TOP + 7.7, 1.4, M.stone, 3);
  }
  for (let u = -110; u < 360; u += 92) {
    bastion(M, S, -110, -u, 15, 15, 12, LAND_TOP);
    if (u > -100) bastion(M, S, u, 110, 15, 15, 12, LAND_TOP);
    S.add(bannerPole(M, -110, LAND_TOP + 12, -u, 8));
  }
}

// Layered limestone crags beyond the walls and on the headlands, rising from
// the land (never past the shapes a hull can touch).
function oldCliffs(port) {
  const { h, S, R } = port;
  const detail = dkq.geo >= 1.6 ? 4 : dkq.geo >= 1.2 ? 2 : 1;
  // A flat-topped block of limestone (a ball squared off): steep faces cut into
  // by gullies and ledges, in beds of lighter and darker stone, with dry scrub
  // on top.
  const shapes = [3, 17, 29].map((seed) => {
    const g = new THREE.IcosahedronGeometry(1, detail);
    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const out = Math.hypot(pos.getX(i), pos.getZ(i));
      const turn = Math.atan2(pos.getZ(i), pos.getX(i));
      let y = Math.sign(pos.getY(i)) * Math.pow(Math.abs(pos.getY(i)), 0.3) * 0.5;
      const gully = fbm2(Math.cos(turn) * 2.6 + 9, Math.sin(turn) * 2.6 + y * 1.4 + 9, seed, 4);
      const bed = Math.floor((y + 0.5) * 7);
      const grow = (Math.pow(out, 0.4) / Math.max(out, 0.001)) * (0.28 + 1.2 * gully + 0.2 * hash3(bed, 1, 0, seed));
      const x = pos.getX(i) * grow;
      const z = pos.getZ(i) * grow;
      const top = y > 0.4;
      if (top) y += (fbm2(x * 2.5 + 9, z * 2.5 + 9, seed + 5, 3) - 0.5) * 0.35;
      pos.setXYZ(i, x, y, z);
      const patch = fbm2(x * 4 + 20, z * 4 + y * 3 + 20, seed + 11, 3);
      if (top) c.setHex(patch > 0.62 ? 0x77723e : 0xbfa06a).multiplyScalar(0.8 + patch * 0.36);
      else c.setHex(0xc29c64).multiplyScalar(0.62 + hash3(bed, 0, 0, seed) * 0.4 + (patch - 0.5) * 0.5);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return g;
  });
  const spots = [[], [], []];
  for (let a = -200; a <= 440; a += 15) {
    for (let b = -200; b <= 440; b += 15) {
      const inland = a < -122 || b < -122;
      const headland = (b > BASIN + 30 && a < 4) || (a > BASIN + 30 && b < 4);
      if (!inland && !headland) continue;
      const x = a + (R() - 0.5) * 8;
      const y = b + (R() - 0.5) * 8;
      const r = 9 + R() * 10;
      // The far side of the land is off the map, so its crags may stand in the sea.
      if (!onCoast(h, x, y, x < -122 || y < -122 ? 0 : r * 1.1)) continue;
      spots[Math.floor(R() * 3)].push({ a: x, b: y, r, h: inland ? 9 + R() * 17 : 4 + R() * 7, turn: R() * 6 });
    }
  }
  // A low outcrop on each of the small headlands and rocks past the quays.
  for (const p of HARBOUR_LAYOUT) {
    const x = (p.a1 + p.a2) / 2;
    const y = (p.b1 + p.b2) / 2;
    if (p.kind !== "coast" || p.r >= COAST_R || Math.max(x, y) < BASIN + 20) continue;
    spots[Math.floor(R() * 3)].push({ a: x, b: y, r: p.r * 0.72, h: 2.5 + p.r * 0.18, turn: R() * 6 });
  }
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  spots.forEach((list, k) => {
    const im = new THREE.InstancedMesh(shapes[k], strataMat, list.length);
    list.forEach((s, i) => {
      q.setFromAxisAngle(up, s.turn);
      im.setMatrixAt(i, m4.compose(p.set(s.a, LAND_TOP + s.h * 0.5 - 1, -s.b), q, sc.set(s.r, s.h, s.r)));
    });
    im.castShadow = dkq.geo >= 1.6; // their shadows only on the best graphics
    im.receiveShadow = true;
    S.add(im);
  });
}

// Where the present-day yachts and coaster lie (solid in the game): two painted
// water taxis (dghajsa) with their standing oarsmen, and a supply barge.
function oldBoats(port) {
  const { M, R, root } = port;
  HARBOUR_LAYOUT.filter((p) => p.kind === "moored").forEach((p, i) => {
    const long = Math.hypot(p.a2 - p.a1, p.b2 - p.b1) + p.r * 2;
    const half = long / 2;
    const w = p.r;
    const barge = long > 8;
    const paint = barge ? M.shell : new THREE.MeshStandardMaterial({ color: i % 2 ? 0x1f5f8b : 0x9c2a1e, roughness: 0.7, side: THREE.DoubleSide });
    const boat = new THREE.Group();
    carrackShell(boat, paint, M.oak, {
      xa: -half, xb: half, low: (u) => -0.35 * w + 0.7 * w * (u / half) ** 4, high: (u) => 0.65 * w + (barge ? 0.35 : 0.9) * w * (u / half) ** 4,
      deck: () => 0.12 * w, half: (u, y) => w * Math.max(0.08, 1 - (u / half / 1.03) ** 4) * clamp(0.6 + (y / w) * 0.5, 0.4, 1), under: true
    });
    for (const s of [-1, 1]) boat.add(strut(new THREE.Vector3(s * half * 0.96, 0.8 * w, 0), new THREE.Vector3(s * half * 1.02, (barge ? 1.5 : 2.3) * w, 0), w * 0.09, M.oak));
    if (barge) {
      for (let k = 0; k < 9; k++) boat.add(cask(M, -3.4 + (k % 5) * 0.8, 0.6 + Math.floor(k / 5) * 0.8, ((k % 2) - 0.5) * 0.8));
      for (let k = 0; k < 6; k++) boat.add(oldBox(0.9, 0.5, 0.7, M.canvas, 1.2 + (k % 3), 0.45 + Math.floor(k / 3) * 0.45, ((k % 2) - 0.5) * 0.7, 2));
    } else {
      for (const u of [-0.9, 0.5]) boat.add(box(0.28, 0.1, w * 1.6, M.timber, u, 0.42, 0));
      const hand = townsman(R, i % 2 ? M.canvas : M.red);
      hand.g.scale.setScalar(OLD_HARBOUR_FOLK);
      hand.g.position.set(-half * 0.5, 0.12 * w, 0);
      hand.g.rotation.y = Math.PI / 2;
      boat.add(hand.g);
    }
    boat.position.set((p.a1 + p.a2) / 2, 0, -(p.b1 + p.b2) / 2);
    boat.rotation.y = Math.atan2(p.b2 - p.b1, p.a2 - p.a1);
    mergeStaticMeshes(boat, new Set());
    root.add(boat);
    oldPort.anims.push((T) => {
      boat.position.y = Math.sin(T * 0.9 + i * 2) * 0.12;
      boat.rotation.x = Math.sin(T * 0.7 + i) * 0.04;
    });
  });
}

const figureMat = shared(mat(0xffffff, { roughness: 0.9, vertexColors: true }));

// Paints a small figure's colours onto its points and joins it into one mesh,
// so each person walking the quays costs a single draw.
function paintFigure(figure) {
  figure.traverse((o) => {
    if (!o.isMesh) return;
    const painted = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    const colors = new Float32Array(painted.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) o.material.color.toArray(colors, i);
    painted.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    o.geometry.dispose();
    o.geometry = painted;
    o.material = figureMat;
    o.castShadow = false;
  });
  mergeStaticMeshes(figure, new Set());
}

// The working port: stores on the quays, ox carts on the quay road,
// townsfolk and knights of the Order.
function oldQuayLife(port) {
  const { M, S, R, root } = port;
  const y = LAND_TOP + 0.3;
  // Stores, at places along each quay; `at` swaps them onto the other one.
  for (const at of [(u, v) => [v, u], (u, v) => [u, v]]) {
    for (const [u, kind] of [[42, 0], [146, 1], [182, 2], [244, 0], [272, 3], [318, 1]]) {
      const put = (thing, du, dv) => {
        const [a, b] = at(u + du, 10 + dv);
        thing.position.x += a;
        thing.position.z -= b;
        S.add(thing);
      };
      if (kind === 0) for (let k = 0; k < dkn(10); k++) put(cask(M, 0, y + 0.42 + Math.floor(k / 8) * 0.85, 0), (k % 4) * 0.85, Math.floor((k % 8) / 4) * 0.85);
      else if (kind === 1) for (let k = 0; k < dkn(8); k++) put(jar(M, 0, y, 0, 0.8 + R() * 0.4), (k % 4) * 0.8, Math.floor(k / 4) * 0.8);
      else if (kind === 2) {
        put(oldAnchor(M, 0, y, 0, R() * 6), 0, 0);
        put(shotPile(M, 0, y, 0), 5, -1);
        put(oldGun(M, 0, y, 0, at(0, 1)[0] ? 0 : Math.PI / 2), 9, 0);
      } else for (let k = 0; k < 9; k++) {
        const along = at(1, 0)[0] ? 0 : Math.PI / 2;
        const log = mesh(CylG(0.42, 0.42, 8, 8).rotateZ(Math.PI / 2).rotateY(along), M.timber);
        log.position.y = y + 0.42 + Math.floor(k / 4) * 0.72;
        put(log, 0, -1.6 + (k % 4) * 0.86);
      }
    }
  }
  // carts to and fro along the road behind each quay
  const traveller = (g, step, onFirst, lane, from, speed) => {
    let u = from;
    let way = R() < 0.5 ? 1 : -1;
    root.add(g);
    oldPort.anims.push((T, dt) => {
      u += way * speed * dt;
      if (u > BASIN - 10) way = -1;
      if (u < 4) way = 1;
      const v = (onFirst ? lane : 1.5) - way * 1.8; // the sheds stand close behind the second quay
      g.position.set(onFirst ? v : u, LAND_TOP + 0.1, onFirst ? -u : -v);
      g.rotation.y = onFirst ? (way * Math.PI) / 2 : way > 0 ? 0 : Math.PI;
      step(T);
    });
  };
  for (const onFirst of [true, false]) {
    const cart = makeOxCart(M, R, onFirst ? "casks" : "stone");
    const speed = 0.9 + R() * 0.4;
    traveller(cart.g, (T) => {
      stride(cart.ox, T, speed * 3.4, 0.38);
      for (const w of cart.wheels) w.rotation.z = (-T * speed) / 0.72;
    }, onFirst, -8, 60 + R() * 200, speed);
    // people on the quay: some walking, some standing about
    const folk = Math.max(4, Math.round(14 * dkq.people));
    for (let i = 0; i < folk; i++) {
      const w = townsman(R, [M.canvas, DM.leather, M.red, M.mule][i % 4]);
      w.g.scale.setScalar(OLD_HARBOUR_FOLK);
      const u = 12 + R() * (BASIN - 40);
      const v = 5 + R() * 13;
      if (i % 3 === 0) {
        w.g.position.set(onFirst ? v : u, y, onFirst ? -u : -v);
        w.g.rotation.y = R() * 6;
        S.add(w.g);
        continue;
      }
      paintFigure(w.g);
      root.add(w.g);
      oldPort.small.push(w.g);
      const span = 5 + R() * 18;
      const pace = 0.07 + R() * 0.07;
      const phase = R() * 6;
      oldPort.anims.push((T) => {
        const a = T * pace + phase;
        const along = u + Math.sin(a) * span;
        w.g.position.set(onFirst ? v : along, y + Math.abs(Math.sin(T * 6 + phase)) * 0.04, onFirst ? -along : -v);
        const heading = Math.cos(a) > 0 ? 1 : -1;
        w.g.rotation.y = onFirst ? (heading > 0 ? Math.PI : 0) : (heading * Math.PI) / 2;
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Mission scenery (missions.js): the land of a mission as one ground mesh with
// its trees or rocks, the waterfall, and the markers at the objectives. Built
// when a mission starts and removed when the harbour screens return.
// ---------------------------------------------------------------------------
const MISSION_MARGIN = 600; // the land carries on this far beyond the map
const MISSION_CELL = 16;
const PIT_DEPTH = 75; // below the falls, out of sight inside the cave
const PIT_LENGTH = 215; // from the drop to the back of the pool

// slope: height gained per unit inland; cap: height it levels off at; rough:
// extra broken ground; step: spacing of the trees / rocks.
const MISSION_LOOKS = {
  jungle: { slope: 0.2, cap: 12, rough: 14, step: 24, bank: 0x9a8458, low: 0x2f6a28, high: 0x163f1c, rock: 0x4f4a38 },
  ice: { slope: 0.9, cap: 28, rough: 24, step: 70, bank: 0xbcdcea, low: 0xeef4f8, high: 0xffffff, rock: 0x9fbdd0 },
  volcanic: { slope: 0.28, cap: 20, rough: 30, step: 52, bank: 0x4a3a32, low: 0x2f2826, high: 0x6a3a28, rock: 0x1d1a19 },
  rock: { slope: 1.1, cap: 40, rough: 28, step: 44, bank: 0xbfa476, low: 0x8f7a58, high: 0xb09a74, rock: 0x6b5843 },
  swamp: { slope: 0.07, cap: 4, rough: 4, step: 28, bank: 0x6c6440, low: 0x3d5a2c, high: 0x2a4426, rock: 0x4a4430 }
};

let missionScene = null; // { mission, root, ... }

function missionGroundHeight(m, x, y) {
  const look = MISSION_LOOKS[m.style];
  if (m.falls) {
    const { along, across } = fallsFrame(m.falls, x, y);
    // the river bed falls away inside the cave, to the rounded end of the pool
    if (along > CAVE.drop && Math.abs(across) < CAVE.mouthHalf && terrainDepthRaw(m, x, y) > -4) {
      return -PIT_DEPTH + 9 * fbm2(x / 26, y / 26, 53, 2);
    }
  }
  const inland = -terrainDepthRaw(m, x, y);
  if (inland <= 0) return Math.max(-8, -1.5 + inland * 0.15);
  const broken = (fbm2(x / 70, y / 70, 7, 4) - 0.35) * look.rough * smoothstep(8, 90, inland);
  return 0.4 + Math.min(look.cap, inland * look.slope) + broken;
}

function missionGround(m) {
  const look = MISSION_LOOKS[m.style];
  const cols = Math.ceil((WORLD_W + 2 * MISSION_MARGIN) / MISSION_CELL) + 1;
  const rows = Math.ceil((WORLD_H + 2 * MISSION_MARGIN) / MISSION_CELL) + 1;
  const pos = new Float32Array(cols * rows * 3);
  const uv = new Float32Array(cols * rows * 2);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * MISSION_CELL - MISSION_MARGIN;
      const y = j * MISSION_CELL - MISSION_MARGIN;
      const k = j * cols + i;
      pos.set([x - HALF_W, missionGroundHeight(m, x, y), y - HALF_H], k * 3);
      uv.set([x, y], k * 2);
    }
  }
  // Squares wholly under deep water are left out (nobody sees the river bed).
  const tris = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      const hs = [a, b, c, d].map((k) => pos[k * 3 + 1]);
      if (Math.max(...hs) < -5 && Math.min(...hs) > -20) continue;
      tris.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(tris);
  geo.computeVertexNormals();
  const normal = geo.attributes.normal;
  const colors = new Float32Array(cols * rows * 3);
  const [bank, low, high, rock] = [look.bank, look.low, look.high, look.rock].map((c) => new THREE.Color(c));
  const paint = new THREE.Color();
  for (let k = 0; k < cols * rows; k++) {
    const x = uv[k * 2], y = uv[k * 2 + 1], h = pos[k * 3 + 1];
    const patch = fbm2(x / 38, y / 38, 23, 3);
    paint.copy(low).lerp(high, smoothstep(0.35, 0.68, patch));
    paint.lerp(rock, 1 - smoothstep(0.55, 0.82, normal.getY(k) + (patch - 0.5) * 0.3));
    paint.lerp(bank, 1 - smoothstep(1.2, 3.4, h + (patch - 0.5) * 2));
    if (h < -12) paint.setHex(0x05090b); // the dark under the falls
    paint.multiplyScalar(0.82 + 0.36 * fbm2(x / 11, y / 11, 29, 2));
    colors.set([paint.r, paint.g, paint.b], k * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const ground = mesh(geo, cragMat, false);
  ground.frustumCulled = false;
  return ground;
}

// Scatters instanced shapes over the land: parts = [{ geo, color, y, sx, sy }]
// stacked on each spot (y, sx and sy scale with the spot's own size).
function scatter(root, spots, parts, seed) {
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const tint = new THREE.Color();
  const R = seeded(seed);
  for (const part of parts) {
    const im = new THREE.InstancedMesh(part.geo, mat(0xffffff, { roughness: 0.9, flatShading: true }), spots.length);
    spots.forEach((spot, i) => {
      p.set(spot.x, spot.h + part.y * spot.size, spot.z);
      q.setFromEuler(e.set((R() - 0.5) * (part.tilt || 0), R() * 6.28, (R() - 0.5) * (part.tilt || 0)));
      s.set(part.sx * spot.size, part.sy * spot.size, part.sx * spot.size);
      im.setMatrixAt(i, m4.compose(p, q, s));
      im.setColorAt(i, tint.setHex(part.color).multiplyScalar(0.7 + 0.6 * R()));
    });
    im.castShadow = true;
    im.receiveShadow = true;
    im.frustumCulled = false;
    root.add(im);
  }
}

function missionPlants(root, m) {
  const look = MISSION_LOOKS[m.style];
  const R = seeded(911);
  // phones and weak cards get a thinner forest
  const step = look.step * (QUALITY_LEVELS[perf.level].terrain < 1.5 ? 1.5 : 1);
  const near = [];
  for (let y = -MISSION_MARGIN * 0.6; y < WORLD_H + MISSION_MARGIN * 0.6; y += step) {
    for (let x = -MISSION_MARGIN * 0.6; x < WORLD_W + MISSION_MARGIN * 0.6; x += step) {
      const sx = x + (R() - 0.5) * step;
      const sy = y + (R() - 0.5) * step;
      const inland = -terrainDepthRaw(m, sx, sy);
      if (inland < 10 || R() < smoothstep(60, 320, inland) * 0.75 || underCave(m, sx, sy)) continue;
      const h = missionGroundHeight(m, sx, sy);
      if (h < 0) continue;
      near.push({ x: sx - HALF_W, z: sy - HALF_H, h: h - 0.5, size: 0.7 + R() * 0.7 });
    }
  }
  const trunk = new THREE.CylinderGeometry(0.5, 0.8, 1, 5);
  const crown = roughen(new THREE.IcosahedronGeometry(1, 1), 0.45, 3);
  const frond = new THREE.ConeGeometry(1, 0.35, 7);
  const boulder = roughen(new THREE.DodecahedronGeometry(1, 0), 0.5, 5);
  if (m.style === "jungle") {
    const palms = near.filter((_, i) => i % 7 === 0);
    scatter(root, near.filter((_, i) => i % 7 !== 0), [
      { geo: trunk, color: 0x5a4028, y: 2.2, sx: 0.8, sy: 4.4 },
      { geo: crown, color: 0x2f7a2a, y: 5.4, sx: 4.4, sy: 3.1, tilt: 0.5 }
    ], 41);
    scatter(root, palms, [
      { geo: trunk, color: 0x7a5a34, y: 4.5, sx: 0.5, sy: 9, tilt: 0.15 },
      { geo: frond, color: 0x4f9a34, y: 9.3, sx: 4.6, sy: 4.6, tilt: 0.3 }
    ], 42);
  } else if (m.style === "swamp") {
    scatter(root, near, [
      { geo: new THREE.ConeGeometry(1, 1, 5, 1, true), color: 0x3a2c1c, y: 0.9, sx: 1.8, sy: 2.2 },
      { geo: trunk, color: 0x4a3a26, y: 2.8, sx: 0.5, sy: 3.4, tilt: 0.35 },
      { geo: crown, color: 0x35602c, y: 4.9, sx: 3.2, sy: 1.8, tilt: 0.6 }
    ], 43);
  } else if (m.style === "ice") {
    scatter(root, near, [{ geo: boulder, color: 0xd5ecf8, y: 0.8, sx: 4.5, sy: 3.4, tilt: 0.8 }], 44);
  } else if (m.style === "volcanic") {
    scatter(root, near.filter((_, i) => i % 2 === 0), [{ geo: boulder, color: 0x262220, y: 0.5, sx: 3.4, sy: 2.6, tilt: 1.5 }], 45);
    scatter(root, near.filter((_, i) => i % 2 === 1), [{ geo: trunk, color: 0x1c1512, y: 2.6, sx: 0.45, sy: 5.2, tilt: 0.7 }], 46);
  } else {
    scatter(root, near.filter((_, i) => i % 3 !== 0), [{ geo: boulder, color: 0x8a7658, y: 0.9, sx: 4, sy: 3.6, tilt: 1.2 }], 47);
    scatter(root, near.filter((_, i) => i % 3 === 0), [{ geo: crown, color: 0x5c6e2e, y: 0.8, sx: 2.2, sy: 1.6 }], 48);
  }
}

// White streaks on clear water, for the falling sheet.
function fallTexture() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(150, 200, 215, 0.75)";
  g.fillRect(0, 0, 256, 256);
  const R = seeded(77);
  for (let i = 0; i < 420; i++) {
    const x = R() * 256;
    const y = R() * 256;
    g.fillStyle = `rgba(255, 255, 255, ${0.25 + R() * 0.7})`;
    for (const wrap of [-256, 0]) g.fillRect(x, y + wrap, 1 + R() * 4, 20 + R() * 90);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// A surface from a grid of points: point(u, v) in local space, paint(u, v) its colour.
function caveSurface(nu, nv, point, paint, material) {
  const pos = [];
  const uv = [];
  const colors = [];
  const index = [];
  const c = new THREE.Color();
  for (let i = 0; i <= nu; i++) {
    for (let j = 0; j <= nv; j++) {
      const p = point(i / nu, j / nv);
      pos.push(p.x, p.y, p.z);
      uv.push(p.x + p.z * 0.4, p.z + p.y * 1.4);
      paint(c, p, i / nu, j / nv);
      colors.push(c.r, c.g, c.b);
      if (i < nu && j < nv) {
        const a = i * (nv + 1) + j;
        const b = a + nv + 1;
        index.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const m = mesh(geo, material);
  m.frustumCulled = false;
  return m;
}

// One trailing vine, a unit long from its root downwards: a thin wavy stem
// with small leaves all the way along it.
function vineGeometry() {
  const R = seeded(37);
  const pos = [];
  const add = (geo) => pos.push(...(geo.index ? geo.toNonIndexed() : geo).attributes.position.array);
  const sway = (k) => Math.sin(k * 9) * 0.025;
  for (let i = 0; i < 8; i++) {
    add(new THREE.CylinderGeometry(0.006, 0.006, 0.13, 3, 1, true).translate(sway((i + 0.5) / 8), -(i + 0.5) / 8, 0));
  }
  for (let i = 0; i < 26; i++) {
    const k = (i + R()) / 26;
    const size = 0.022 + R() * 0.028;
    add(new THREE.OctahedronGeometry(size).scale(1.3, 0.7, 0.6).rotateY(R() * 6.3).rotateZ((R() - 0.5) * 1.4)
      .translate(sway(k) + (R() - 0.5) * 0.08, -k, (R() - 0.5) * 0.08));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

// The falls: the river runs into the mouth of a rounded, rugged rock hill
// grown over with jungle, and drops away into the dark inside. Local +X is
// downstream; th runs over the arch from one bank (0) to the other (PI).
function missionFalls(root, f) {
  const group = new THREE.Group();
  toWorld(f.x, f.y, 0, group.position);
  group.rotation.y = -Math.atan2(f.dy, f.dx);
  const R = seeded(77);
  const jag = (th) => (fbm2(th * 7, 3, 75, 3) - 0.5) * 44; // the broken edge of the mouth
  const outer = (along, th) => {
    const r = caveRadius(along);
    const k = 1 + 0.55 * (fbm2(along / 34, th * 5, 71, 4) - 0.5);
    const edge = jag(th) * (1 - smoothstep(0, 50, along));
    return new THREE.Vector3(along + edge, CAVE.height * r * Math.sin(th) * k - 3, CAVE.half * r * Math.cos(th) * (0.5 + 0.5 * k));
  };
  const inner = (along, th) => {
    const r = Math.sqrt(Math.max(0, 1 - (along / 265) ** 4));
    const k = fbm2(along / 28, th * 6, 73, 3) - 0.5;
    const edge = jag(th) * (1 - smoothstep(0, 50, along));
    return new THREE.Vector3(along + edge, CAVE.mouthHeight * r * Math.sin(th) * (1 + 0.35 * k) - 3, CAVE.mouthHalf * r * Math.cos(th) * (1 + 0.1 * k));
  };
  // the rock between the mouth and the outside of the hill
  const face = (k, th) => {
    const p = inner(0, th).lerp(outer(0, th), k);
    p.x -= Math.sin(Math.PI * k) * 30 * fbm2(k * 4, th * 9, 79, 3);
    return p;
  };
  const stone = new THREE.Color(0x776c5c);
  const darkStone = new THREE.Color(0x3d372e);
  const moss = new THREE.Color(0x2f5a22);
  const rocky = (c, p, green) => {
    c.copy(darkStone).lerp(stone, smoothstep(0.3, 0.7, fbm2(p.x / 17 + p.y / 13, p.z / 17, 81, 3)));
    c.lerp(moss, green * smoothstep(0.38, 0.62, fbm2(p.x / 29, p.z / 29 + p.y / 23, 83, 3)));
  };
  group.add(
    caveSurface(44, 60, (u, v) => outer(u * CAVE.length, v * Math.PI), (c, p, u, v) => rocky(c, p, 0.35 + 0.65 * Math.sin(v * Math.PI)), cragMat),
    caveSurface(8, 60, (u, v) => face(u, v * Math.PI), (c, p, u) => rocky(c, p, u * 0.7), cragMat),
    // inside: dim wet rock fading to black
    caveSurface(24, 60, (u, v) => inner(u * 265, v * Math.PI), (c, p) => c.setHex(0x2a2a26).multiplyScalar(1 - smoothstep(0, 105, p.x)),
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }))
  );

  // the water curling over the drop, fading into the dark
  const tex = fallTexture();
  tex.repeat.set(1, 3);
  tex.center.set(0.5, 0.5);
  tex.rotation = Math.PI / 2; // the streaks run down the drop
  const sheet = new THREE.PlaneGeometry(1, CAVE.mouthHalf * 1.9, 14, 12);
  const sp = sheet.attributes.position;
  const fade = new Float32Array(sp.count * 3);
  for (let i = 0; i < sp.count; i++) {
    const k = sp.getX(i) + 0.5; // 0 at the lip, 1 at the foot
    const across = sp.getY(i);
    sp.setXYZ(i, CAVE.drop - 8 + k * 50, 0.5 - k * k * PIT_DEPTH, across);
    fade.fill(Math.max(0, 0.75 - k * 1.1), i * 3, i * 3 + 3);
  }
  sheet.setAttribute("color", new THREE.BufferAttribute(fade, 3));
  group.add(new THREE.Mesh(sheet, new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false })));

  // boulders, greenery, hanging vines and stone teeth, placed over the surfaces
  const spot = (p, size) => {
    const at = p.clone().applyAxisAngle(WORLD_UP, group.rotation.y).add(group.position);
    return { x: at.x, z: at.z, h: at.y, size };
  };
  const list = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const boulder = roughen(new THREE.DodecahedronGeometry(1, 1), 0.55, 9);
  const crown = roughen(new THREE.IcosahedronGeometry(1, 1), 0.5, 13);
  const stem = new THREE.CylinderGeometry(0.5, 0.8, 1, 5);
  const rocks = [
    ...list(60, (i) => spot(face(0.1 + R() * 0.75, ((i + R()) / 60) * Math.PI), 4 + R() * 9)),
    // heaped at both ends of the arch, where it meets the banks
    ...list(34, (i) => spot(new THREE.Vector3(-45 + R() * 55, -1 + R() * 5, (i % 2 ? 1 : -1) * (CAVE.mouthHalf + 8 + R() * 90)), 7 + R() * 16)),
    ...list(70, () => spot(outer(R() * CAVE.length * 0.94, R() * Math.PI), 6 + R() * 13))
  ];
  scatter(root, rocks, [{ geo: boulder, color: 0x6f675a, y: 0, sx: 1, sy: 0.8, tilt: 2.5 }], 91);
  const bushes = [
    ...list(650, () => {
      const p = outer(R() * CAVE.length * 0.97, 0.06 + R() * (Math.PI - 0.12));
      p.y -= 1.5;
      return spot(p, 0.7 + R());
    }),
    // spilling over the brow of the arch
    ...list(110, () => spot(face(0.45 + R() * 0.55, 0.2 + R() * (Math.PI - 0.4)), 0.6 + R() * 0.8))
  ];
  scatter(root, bushes, [{ geo: crown, color: 0x2f7428, y: 0.6, sx: 5.5, sy: 3.4, tilt: 0.6 }], 92);
  scatter(root, list(90, () => spot(outer(15 + R() * CAVE.length * 0.8, 0.55 + R() * (Math.PI - 1.1)), 0.9 + R() * 0.8)), [
    { geo: stem, color: 0x5a4028, y: 3.5, sx: 0.8, sy: 7 },
    { geo: crown, color: 0x35802a, y: 8, sx: 6, sy: 4.2, tilt: 0.5 }
  ], 93);
  const vines = list(150, (i) => {
    const p = face(R() * 0.45, 0.18 + ((i + R()) / 150) * (Math.PI - 0.36));
    p.x -= 6;
    // long, but high enough for a ship's masts to pass under
    return spot(p, clamp(p.y - 30 + R() * 14, 6, 34) * (0.35 + R() * 0.65));
  });
  scatter(root, vines, [{ geo: vineGeometry(), color: 0x3f8a2c, y: 0, sx: 1, sy: 1 }], 94);
  scatter(root, list(26, (i) => spot(inner(2 + R() * 14, 0.45 + ((i + R()) / 26) * (Math.PI - 0.9)), 5 + R() * 11)),
    [{ geo: new THREE.ConeGeometry(1, 1, 6).rotateX(Math.PI), color: 0x4a4338, y: -0.45, sx: 0.22, sy: 1 }], 95);

  // white mist rolling out of the mouth
  const spray = list(55, () => {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0xeef6f8, transparent: true, depthWrite: false, opacity: 0 }));
    m.userData = { phase: R(), across: (R() - 0.5) * CAVE.mouthHalf * 1.7, pace: 0.1 + R() * 0.14 };
    group.add(m);
    return m;
  });
  root.add(group);
  return (t) => {
    tex.offset.x = -((t * 0.9) % 1);
    for (const m of spray) {
      const u = m.userData;
      const life = (t * u.pace + u.phase) % 1;
      m.position.set(CAVE.drop + 5 - life * 95, 1 + life * life * 30, u.across + Math.sin(life * 5 + u.phase * 20) * 9);
      m.scale.setScalar(8 + life * 30);
      m.material.opacity = (1 - life) * 0.3 * Math.min(1, life * 5);
    }
  };
}

// A sailing ship gone down in the shallows: her stern castle and broken ribs
// stand out of the water, the masts lean, rags of sail hang from the yards.
function sunkenWreck() {
  const g = new THREE.Group();
  const dark = mat(0x4a3421, { roughness: 0.95 });
  const weed = mat(0x39452a, { roughness: 0.95 });
  const canvas = mat(0xcfc6ab, { roughness: 0.9, side: THREE.DoubleSide });
  const hull = mesh(new THREE.CapsuleGeometry(8, 34, 4, 12).rotateZ(Math.PI / 2), weed);
  hull.scale.set(1, 0.62, 1);
  hull.position.set(0, -1.6, -8);
  hull.rotation.set(0.28, 0.12, 0.1);
  g.add(hull);
  const stern = box(13, 11, 15, dark, -21, 3.5, -8);
  stern.rotation.set(0.28, 0.12, 0.16);
  g.add(stern);
  // the ribs of the broken bow
  for (let i = 0; i < 6; i++) {
    for (const side of [-1, 1]) {
      const rib = cylinder(0.45, 0.8, 11 - i, dark, 8 + i * 4.4, 3.5 - i * 0.5, -8 + side * (7 - i * 0.7), 6);
      rib.rotation.set(side * 0.35, 0, -0.12);
      g.add(rib);
    }
  }
  const sail = (width, height, seed) => {
    const R = seeded(seed);
    const shape = new THREE.Shape();
    shape.moveTo(-width / 2, 0);
    shape.lineTo(width / 2, 0);
    // a ragged foot, torn into strips
    for (let i = 8; i >= 0; i--) shape.lineTo(-width / 2 + (width * i) / 8, -height * (i % 2 ? 0.25 + R() * 0.35 : 0.6 + R() * 0.4));
    return new THREE.Mesh(new THREE.ShapeGeometry(shape), canvas);
  };
  for (const [x, height, lean, torn] of [[-14, 34, 0.3, 31], [3, 42, -0.14, 47], [19, 24, -0.5, 59]]) {
    const mast = new THREE.Group();
    mast.position.set(x, -3, -8);
    mast.rotation.z = lean;
    mast.add(cylinder(0.7, 1.3, height, dark, 0, height / 2, 0, 8));
    const yard = cylinder(0.45, 0.45, 18, dark, 0, height * 0.82, 0, 6);
    yard.rotation.x = Math.PI / 2;
    mast.add(yard);
    const rag = sail(16, height * 0.45, torn);
    rag.position.set(0, height * 0.82, 0);
    rag.rotation.y = Math.PI / 2;
    mast.add(rag);
    g.add(mast);
  }
  // flotsam
  for (const [x, z, turn] of [[24, 8, 0.7], [-8, 11, -0.4], [14, -24, 1.4], [-30, 4, 2.1]]) {
    const plank = box(8, 0.5, 1.6, dark, x, 0.5, z);
    plank.rotation.y = turn;
    g.add(plank);
  }
  const cask = cylinder(1.6, 1.6, 3.6, mat(0x6b4a2b, { roughness: 0.9 }), 16, 0.6, 10, 10);
  cask.rotation.z = Math.PI / 2;
  g.add(cask);
  return g;
}

// A raft of survivors waving a flare, the masts of a sunken ship, a boom's
// winch, or a depot's jetty with its crates.
function missionSite(site) {
  const g = new THREE.Group();
  toWorld(site.x, site.y, 0, g.position);
  const wood = mat(0x6b4a2b, { roughness: 0.9 });
  const thing = new THREE.Group();
  if (site.model === "winch") {
    const stone = mat(0x7c7568, { roughness: 0.95 });
    thing.add(cylinder(9, 11, 5, stone, 0, 1, 0, 10));
    for (const x of [-5, 5]) thing.add(box(1.4, 11, 1.4, wood, x, 8, 0));
    const drum = cylinder(2.6, 2.6, 8.6, wood, 0, 9, 0, 10);
    drum.rotation.z = Math.PI / 2;
    const wheel = mesh(new THREE.TorusGeometry(5, 0.6, 8, 20), wood);
    wheel.position.set(6.8, 9, 0);
    wheel.rotation.y = Math.PI / 2;
    thing.add(drum, wheel);
  } else if (site.model === "depot") {
    thing.add(box(24, 1.6, 16, wood, 0, 0.8, 0));
    thing.add(box(9, 7, 8, mat(0xa8402e), -6, 5, 0), box(10.5, 1.2, 9.5, mat(0x3a3f45), -6, 9.1, 0));
    for (const [x, y, z] of [[3, 3, -4], [7, 3, -1], [4, 3, 3], [5.5, 5.8, -2]]) thing.add(box(3, 3, 3, mat(0xc9a15a), x, y, z));
    thing.add(cylinder(0.4, 0.4, 16, wood, 11, 9, 6, 6));
    thing.add(box(0.3, 4, 7, mat(0xe0b040), 11, 15, 2.4));
  } else if (site.model === "wreck") {
    thing.add(sunkenWreck());
  } else {
    thing.add(box(16, 1.2, 11, wood, 0, 0.6, 0));
    for (const [x, z, color] of [[-4, -2, 0xd8503a], [1, 2, 0x3a78c8], [5, -1, 0xe0b040]]) {
      thing.add(cylinder(0.8, 1, 3.2, mat(color), x, 2.8, z, 8));
      const head = mesh(new THREE.SphereGeometry(0.8, 8, 6), mat(0xd9a57e));
      head.position.set(x, 5.1, z);
      thing.add(head);
    }
    const flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0xff4a2a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    flare.position.set(5, 11, -1);
    flare.scale.setScalar(12);
    thing.add(flare);
  }
  const ring = flatRing(SITE_RADIUS - 4, SITE_RADIUS, 0xffd860, 0.55, 1.2);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(4, 4, 160, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffd860, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })
  );
  beam.position.y = 90;
  g.add(thing, ring, beam);
  return { root: g, thing, ring, beam };
}

// Keeps the mission scenery in step with the game: built once per voyage.
// What bars a channel: a log boom, a chain on floating casks between two stone
// posts, a tongue of lava, or jammed ice.
function missionGate(gate) {
  const [ax, ay, bx, by] = gate.line;
  const g = new THREE.Group();
  toWorld((ax + bx) / 2, (ay + by) / 2, 0, g.position);
  g.rotation.y = -Math.atan2(by - ay, bx - ax);
  const length = Math.hypot(bx - ax, by - ay);
  const R = seeded(Math.round(ax + by));
  const every = (step, make) => {
    for (let x = -length / 2; x <= length / 2; x += step) make(x);
  };
  const rock = (x, y, z, size, material) => {
    const m = mesh(roughen(new THREE.DodecahedronGeometry(size, 1), size * 0.5, x + z), material);
    m.position.set(x, y, z);
    m.rotation.set(R() * 3, R() * 3, R() * 3);
    g.add(m);
  };
  if (gate.kind === "logs") {
    const bark = mat(0x6e4a28, { roughness: 0.95 });
    every(30, (x) => {
      for (const z of [-gate.r * 0.55, 0, gate.r * 0.55]) {
        const log = cylinder(3.4, 3, 33 + R() * 8, bark, x + (R() - 0.5) * 8, 1.4 + R() * 1.6, z + (R() - 0.5) * 5, 9);
        log.rotation.set(0, (R() - 0.5) * 0.35, Math.PI / 2);
        g.add(log);
      }
    });
    every(length / 4, (x) => g.add(cylinder(2, 2.4, 20, bark, x, 6, 0, 8)));
  } else if (gate.kind === "chain") {
    const iron = mat(0x3a3d42, { metalness: 0.7, roughness: 0.45 });
    every(9, (x) => {
      const link = mesh(new THREE.TorusGeometry(4, 1.1, 6, 12), iron);
      link.position.set(x, 3, 0);
      link.scale.x = 1.5;
      link.rotation.x = (Math.round(x / 9) % 2) * (Math.PI / 2);
      g.add(link);
    });
    every(46, (x) => {
      const cask = cylinder(5, 5, 11, mat(0x7a2e22, { roughness: 0.8 }), x, 1, 0, 12);
      cask.rotation.z = Math.PI / 2;
      g.add(cask);
    });
    for (const side of [-1, 1]) {
      g.add(cylinder(11, 15, 40, mat(0x726a5c, { roughness: 0.95 }), side * (length / 2 + 6), 14, 0, 10));
    }
  } else if (gate.kind === "lava") {
    const crust = mat(0x1c1210, { roughness: 0.9, flatShading: true });
    const molten = mat(0xff5a14, { emissive: 0xff4a08, emissiveIntensity: 2.6, flatShading: true });
    every(17, (x) => {
      rock(x + R() * 8, R() * 4 - 2, (R() - 0.5) * gate.r, 11 + R() * 12, crust);
      rock(x - R() * 8, -2, (R() - 0.5) * gate.r * 1.7, 6 + R() * 7, molten);
    });
  } else {
    const ice = mat(0xdcf0fb, { roughness: 0.35, flatShading: true });
    every(19, (x) => {
      rock(x, R() * 5 - 2, (R() - 0.5) * gate.r, 12 + R() * 14, ice);
      rock(x + 9, -1, (R() - 0.5) * gate.r * 1.7, 7 + R() * 8, ice);
    });
  }
  return g;
}

function updateMissionScene() {
  const m = game.mission;
  const state = game.missionState;
  if (missionScene && missionScene.state !== state) {
    scene.remove(missionScene.root);
    disposeTree(missionScene.root);
    missionScene = null;
  }
  const f = m && m.falls;
  water.material.uniforms.gorge.value.set(f ? f.x + f.dx * CAVE.drop - HALF_W : 0, f ? f.y + f.dy * CAVE.drop - HALF_H : 0, f ? f.dx : 0, f ? f.dy : 0);
  water.material.uniforms.gorgeSize.value.set(f ? CAVE.mouthHalf : 0, f ? PIT_LENGTH : 0);
  for (const part of buoyParts) part.im.count = m ? 0 : buoys.length; // no buoy line across the land
  if (!m) return;
  if (!missionScene) {
    const root = new THREE.Group();
    root.add(missionGround(m));
    missionPlants(root, m);
    const falls = m.falls ? missionFalls(root, m.falls) : null;
    const gates = state.gates.map((gate) => {
      const o = missionGate(gate);
      o.position.y = gate.closed ? 0 : -60;
      root.add(o);
      return o;
    });
    scene.add(root);
    missionScene = { state, root, falls, gates, list: null, sites: [] };
  }
  // each stage brings its own markers
  if (missionScene.list !== state.sites) {
    for (const o of missionScene.sites) {
      missionScene.root.remove(o.root);
      disposeTree(o.root);
    }
    missionScene.list = state.sites;
    missionScene.sites = state.sites.map((site) => {
      const o = missionSite(site);
      missionScene.root.add(o.root);
      return o;
    });
  }
  // a gate rises out of the water when it closes and sinks away when it opens
  missionScene.gates.forEach((o, i) => {
    o.position.y += ((state.gates[i].closed ? 0 : -60) - o.position.y) * 0.03;
    o.visible = o.position.y > -55;
  });
  const t = clock.t;
  missionScene.falls?.(t);
  missionScene.sites.forEach((o, i) => {
    const done = state.sites[i].done;
    o.ring.visible = !done;
    o.beam.visible = !done;
    // survivors go aboard and their raft goes; wrecks, winches and jetties stay
    if (!state.sites[i].model) o.thing.visible = !done;
    o.thing.position.y = Math.sin(t * 1.3 + i * 2) * 0.5;
    o.beam.material.opacity = 0.12 + 0.08 * Math.sin(t * 3 + i);
  });
}

// A camera never dips into a mission's hills, or goes inside the cave.
function keepAboveMissionGround(cam, look) {
  if (!game.mission) return;
  const f = game.mission.falls;
  if (f) {
    const { along, across } = fallsFrame(f, cam.position.x + HALF_W, cam.position.z + HALF_H);
    if (along > -50 && along < CAVE.length && Math.abs(across) < CAVE.half + 15 && cam.position.y < CAVE.height + 25) {
      cam.position.x -= f.dx * (along + 50);
      cam.position.z -= f.dy * (along + 50);
      cam.position.y = Math.min(cam.position.y, CAVE.mouthHeight * 0.7); // looking in under the arch
      cam.lookAt(look);
      return;
    }
  }
  const x = cam.position.x + HALF_W;
  const y = cam.position.z + HALF_H;
  if (terrainDepth(x, y) > 0) return;
  const floor = missionGroundHeight(game.mission, x, y) + 14;
  if (cam.position.y >= floor) return;
  cam.position.y = floor;
  cam.lookAt(look);
}

const crocMat = shared(mat(0x4c6128, { roughness: 0.8 }));
const crocBellyMat = shared(mat(0x9a9a58, { roughness: 0.8 }));

function createCroc() {
  const root = new THREE.Group();
  const body = mesh(roughen(new THREE.SphereGeometry(1, 16, 10), 0.18, 4), crocMat);
  body.scale.set(11, 2.6, 4.2);
  root.add(body);
  root.add(box(9, 1.6, 3.4, crocMat, 13, 0.4, 0), box(9, 0.7, 3, crocBellyMat, 13, -0.9, 0));
  for (let x = -8; x <= 7; x += 2.5) {
    const ridge = mesh(new THREE.ConeGeometry(0.8, 1.6, 4), crocMat);
    ridge.position.set(x, 2.6, 0);
    root.add(ridge);
  }
  for (const z of [-1.3, 1.3]) {
    const eye = mesh(new THREE.SphereGeometry(0.65, 8, 6), eyeMat, false);
    eye.position.set(10, 2, z);
    root.add(eye);
  }
  const tail = mesh(new THREE.ConeGeometry(2.2, 18, 8), crocMat);
  tail.rotation.z = Math.PI / 2;
  const tailPivot = new THREE.Group();
  tailPivot.position.x = -9;
  tail.position.x = -8.5;
  tailPivot.add(tail);
  root.add(tailPivot);
  return { root, tail: tailPivot, seed: Math.random() * 10 };
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
    const models = Promise.all([
      loadTugModel().catch((err) => console.warn("[3D] Tug model not loaded, using the plain tug:", err)),
      loadDockModels().catch((err) => console.warn("[3D] Dockyard models not loaded, using the plain dockyard:", err)),
      loadCruiseModel().catch((err) => console.warn("[3D] Cruise liner model not loaded, using the plain one:", err))
    ]);
    graphicsChoice = loadGraphicsChoice();
    if (graphicsChoice) applyChosenGraphicsMode();
    else {
      // First start on this hardware. The check waits for the models: loading
      // them while it measures would make every level look slower than it is.
      graphicsCheck.waiting = true;
      models.then(() => {
        graphicsCheck.waiting = false;
        startGraphicsCheck();
      });
    }
  } catch (err) {
    console.warn("[3D] Could not start the 3D view, keeping the 2D view:", err);
  }
}
// Tells game.js the 3D start-up is over (worked or not), so its "please
// wait" screen can go once frames come smoothly; a first-start graphics check
// says so itself when it finishes.
if (!graphicsCheck.running && !graphicsCheck.waiting) view3d.startupDone = true;
