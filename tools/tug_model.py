"""Builds the dockyard tug: a detailed model with painted textures.

Run (about a few minutes on an RTX card):
    blender -b --factory-startup -P tools/tug_model.py
    add `-- --quick` for a fast low-resolution check (written to the temp folder)

Writes assets/models/tug.bin (geometry) and tug_color/orm/normal.jpg, which
render3d.js loads. Coordinates are the game's own model units, as in
harbourTug (render3d.js): x forward, y up, z to starboard.
"""
import math
import random
import struct
import sys
import tempfile
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Vector

QUICK = "--quick" in sys.argv
# a quick check writes elsewhere, so it never replaces the game's model
OUT = Path(tempfile.gettempdir()) / "tug_quick" if QUICK else Path(__file__).resolve().parent.parent / "assets" / "models"
SIZE = 1024 if QUICK else 4096  # colour picture; the others are half this
if "--size" in sys.argv:  # smaller pictures, for a PC short of memory (baking 4096 needs about 3 GB free)
    SIZE = int(sys.argv[sys.argv.index("--size") + 1])
rng = random.Random(7)

# ---------------------------------------------------------------------------
# Materials ("kinds"): colour (sRGB), roughness, metalness
# ---------------------------------------------------------------------------
KINDS = [
    ("hull", (226, 70, 22), 0.50, 0.00),
    ("white", (224, 224, 217), 0.48, 0.00),
    ("deck", (64, 74, 70), 0.88, 0.00),
    ("rubber", (26, 26, 27), 0.90, 0.00),
    ("iron", (31, 33, 36), 0.52, 0.45),
    ("glass", (20, 33, 42), 0.05, 0.75),
    ("steel", (118, 122, 122), 0.42, 0.70),
    ("soot", (50, 45, 41), 0.62, 0.25),
    ("trim", (228, 76, 26), 0.46, 0.00),
    ("red", (172, 30, 22), 0.45, 0.05),
    ("blue", (34, 72, 148), 0.40, 0.05),
    ("rope", (164, 142, 102), 0.95, 0.00),
    ("yellow", (218, 168, 30), 0.46, 0.00),
    ("chrome", (188, 190, 194), 0.22, 0.95),
    ("lens_green", (30, 150, 72), 0.12, 0.20),
    ("lens_red", (176, 22, 22), 0.12, 0.20),
    ("lens_white", (232, 232, 214), 0.12, 0.20),
    ("wood", (140, 106, 68), 0.85, 0.00),
    ("concrete", (146, 142, 132), 0.90, 0.00),
    # the cruise liner (cruise_model.py)
    ("paint", (236, 238, 240), 0.34, 0.05),  # tinted with the ship's colour by the game
    ("cabin", (24, 46, 62), 0.07, 0.65),  # cabin windows, lit at night
    ("balustrade", (96, 140, 150), 0.08, 0.55),
    ("lounge", (14, 30, 54), 0.05, 0.75),
    ("teak", (178, 138, 94), 0.72, 0.00),
    ("water", (36, 146, 196), 0.05, 0.20),
    ("orange", (238, 100, 20), 0.40, 0.00),
    ("antifoul", (128, 32, 26), 0.62, 0.05),
    ("foredeck", (112, 168, 196), 0.60, 0.00),
]
K = {name: i for i, (name, *_) in enumerate(KINDS)}

VERTS, FACES, FACE_KIND, FACE_GROUP = [], [], [], []
WEAR = [1.0]  # how weathered the paint is (a cruise liner is kept clean)
POSITIONS = [64.0]  # model positions are baked as p / this + 0.5: more than twice the model's reach
OFFSET = [0.0, 0.0, 0.0]  # moves what is being built (dock_model.py keeps its parts apart)
# the parts the game keeps apart, to hide those round the bridge when inside it
GROUPS = ("low", "top", "crane", "stack_port", "stack_starboard")
group = "low"
STREAKS = []  # rust or dirt runs: (x, y, z, length, width, strength, rgb)
RUST = (122, 54, 18)
DIRT = (70, 62, 50)


def streak(p, length, width, strength, rgb=RUST):
    STREAKS.append((p[0] + OFFSET[0], p[1] + OFFSET[1], p[2] + OFFSET[2], length, width, strength, rgb))


# ---------------------------------------------------------------------------
# Shapes
# ---------------------------------------------------------------------------
def V(*p):
    return Vector(p)


def add_raw(points, faces, kind):
    base = len(VERTS)
    VERTS.extend((p[0] + OFFSET[0], p[1] + OFFSET[1], p[2] + OFFSET[2]) for p in points)
    FACES.extend([base + i for i in f] for f in faces)
    FACE_KIND.extend([K[kind]] * len(faces))
    FACE_GROUP.extend([GROUPS.index(group)] * len(faces))


def solid(points, faces, kind, bevel=0.0, segments=2):
    """A closed shape: faces turned outwards, sharp edges rounded off."""
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in points]
    for f in faces:
        bm.faces.new([vs[i] for i in f])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    if bevel > 0:
        edges = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0) > 0.5]
        bmesh.ops.bevel(bm, geom=edges, offset=bevel, segments=segments, profile=0.6, affect="EDGES", clamp_overlap=True)
    bm.verts.index_update()
    add_raw([v.co.copy() for v in bm.verts], [[v.index for v in f.verts] for f in bm.faces], kind)
    bm.free()


def loft(rings, kind, caps=True, closed=False, bevel=0.0):
    """Joins rings of equally many points into a skin."""
    n = len(rings[0])
    points = [p for r in rings for p in r]
    faces = []
    count = len(rings)
    for j in range(count if closed else count - 1):
        k = (j + 1) % count
        for i in range(n):
            m = (i + 1) % n
            faces.append([j * n + i, j * n + m, k * n + m, k * n + i])
    if caps and not closed:
        faces.append([i for i in range(n)][::-1])
        faces.append([(count - 1) * n + i for i in range(n)])
    solid(points, faces, kind, bevel)


def frame_of(direction):
    d = Vector(direction).normalized()
    a = V(0, 1, 0) if abs(d.y) < 0.9 else V(1, 0, 0)
    u = d.cross(a).normalized()
    return d, u, d.cross(u).normalized()


def cyl(p0, p1, r0, kind, r1=None, seg=14, bevel=0.0, caps=True):
    p0, p1 = Vector(p0), Vector(p1)
    _, u, v = frame_of(p1 - p0)
    r1 = r0 if r1 is None else r1
    ring = lambda c, r: [c + (u * math.cos(a) + v * math.sin(a)) * r for a in (2 * math.pi * i / seg for i in range(seg))]
    loft([ring(p0, r0), ring(p1, r1)], kind, caps, bevel=bevel)


def smooth_path(points, per=6):
    p = [Vector(q) for q in points]
    out = []
    for i in range(len(p) - 1):
        a, b, c, d = p[max(i - 1, 0)], p[i], p[i + 1], p[min(i + 2, len(p) - 1)]
        for s in range(per):
            t = s / per
            out.append(0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t ** 3))
    out.append(p[-1])
    return out


def tube(path, r, kind, seg=8, closed=False):
    path = [Vector(p) for p in path]
    rings = []
    normal = None
    n = len(path)
    for i, p in enumerate(path):
        before = path[(i - 1) % n] if closed or i else p
        after = path[(i + 1) % n] if closed or i < n - 1 else p
        t = (after - before).normalized()
        if normal is None:
            normal = frame_of(t)[1]
        normal = (normal - t * normal.dot(t)).normalized()
        other = t.cross(normal)
        rings.append([p + (normal * math.cos(a) + other * math.sin(a)) * r for a in (2 * math.pi * k / seg for k in range(seg))])
    loft(rings, kind, caps=not closed, closed=closed)


def bar(a, b, r, kind, seg=7):
    cyl(a, b, r, kind, seg=seg)


def torus(c, axis, R, r, kind, seg=26, side=8):
    c = Vector(c)
    _, u, v = frame_of(axis)
    tube([c + (u * math.cos(a) + v * math.sin(a)) * R for a in (2 * math.pi * i / seg for i in range(seg))], r, kind, side, True)


def box(c, size, kind, bevel=0.03, yaw=0.0, tilt=0.0):
    """Centre, (length x, height y, width z), turned `yaw` about y and `tilt` about z."""
    c = Vector(c)
    w, h, d = (s / 2 for s in size)
    ct, st, cy, sy = math.cos(tilt), math.sin(tilt), math.cos(yaw), math.sin(yaw)

    def place(x, y, z):
        x, y = x * ct - y * st, x * st + y * ct
        return c + V(x * cy + z * sy, y, -x * sy + z * cy)

    low = [place(-w, -h, -d), place(w, -h, -d), place(w, -h, d), place(-w, -h, d)]
    high = [place(-w, h, -d), place(w, h, -d), place(w, h, d), place(-w, h, d)]
    loft([low, high], kind, bevel=min(bevel, min(size) * 0.3))


def beam(a, b, width, height, kind, bevel=0.04):
    a, b = Vector(a), Vector(b)
    _, u, v = frame_of(b - a)
    ring = lambda c: [c + u * (sx * width / 2) + v * (sy * height / 2) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    loft([ring(a), ring(b)], kind, bevel=bevel)


def prism(low, high, y0, y1, kind, bevel=0.08):
    loft([[V(x, y0, z) for x, z in low], [V(x, y1, z) for x, z in high]], kind, bevel=bevel)


def ellipsoid(c, radii, kind, seg=20, rings=12, bottom=-1.0):
    c = Vector(c)
    out = []
    for j in range(rings + 1):
        lat = math.asin(max(-0.995, min(0.995, bottom + (1 - bottom) * j / rings)))
        out.append([c + V(radii[0] * math.cos(lat) * math.cos(a), radii[1] * math.sin(lat), radii[2] * math.cos(lat) * math.sin(a))
                    for a in (2 * math.pi * i / seg for i in range(seg))])
    loft(out, kind)


def rrect(c, u, v, w, h, r, n=4):
    """Points round a rounded rectangle centred at c, spanned by unit vectors u, v."""
    c, u, v = Vector(c), Vector(u), Vector(v)
    out = []
    for cx, cy, a0 in ((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)):
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            out.append(c + u * (cx * (w / 2 - r) + r * math.cos(a)) + v * (cy * (h / 2 - r) + r * math.sin(a)))
    return out


def plate(c, u, v, w, h, r, depth, kind, bevel=0.012):
    n = Vector(u).cross(Vector(v)).normalized()
    ring = rrect(c, u, v, w, h, r)
    loft([[p - n * depth / 2 for p in ring], [p + n * depth / 2 for p in ring]], kind, bevel=bevel)


def window(c, normal, w, h, r=0.12, frame="steel", drip=True):
    c, n = Vector(c), Vector(normal).normalized()
    u = V(0, 1, 0).cross(n).normalized()
    v = n.cross(u)
    plate(c + n * 0.015, u, v, w, h, r, 0.05, "glass", 0.008)
    tube(rrect(c + n * 0.045, u, v, w + 0.02, h + 0.02, r), 0.036, "rubber", 6, True)
    tube(rrect(c + n * 0.045, u, v, w + 0.13, h + 0.13, r + 0.05), 0.042, frame, 6, True)
    for su in (-1, 1):
        for sv in (-1, 1):
            p = c + u * (su * (w / 2 + 0.07)) + v * (sv * (h / 2 - 0.05))
            cyl(p + n * 0.03, p + n * 0.1, 0.022, "chrome", seg=6)
        if drip:
            streak(c + u * (su * w * 0.45) - v * (h / 2 + 0.08) + n * 0.02, rng.uniform(0.4, 1.3), 0.05, rng.uniform(0.25, 0.55))


def porthole(c, normal, r=0.2):
    c, n = Vector(c), Vector(normal).normalized()
    cyl(c - n * 0.02, c + n * 0.04, r, "glass", seg=20)
    torus(c + n * 0.045, n, r + 0.035, 0.05, "chrome", 24, 8)
    for i in range(6):
        _, u, v = frame_of(n)
        p = c + (u * math.cos(i * math.pi / 3) + v * math.sin(i * math.pi / 3)) * (r + 0.1)
        cyl(p, p + n * 0.06, 0.018, "steel", seg=6)
    streak(c + V(0, -r - 0.08, 0), rng.uniform(0.5, 1.4), 0.06, 0.5)


def door(c, normal, w=0.95, h=1.95):
    """A steel weathertight door with its coaming, hinges, dogs and port."""
    c, n = Vector(c), Vector(normal).normalized()
    u = V(0, 1, 0).cross(n).normalized()
    up = n.cross(u)
    tube(rrect(c + n * 0.05, u, up, w + 0.16, h + 0.16, 0.3, 5), 0.06, "iron", 8, True)
    plate(c + n * 0.06, u, up, w, h, 0.25, 0.08, "white", 0.02)
    tube(rrect(c + n * 0.11, u, up, w * 0.82, h * 0.88, 0.2, 5), 0.02, "white", 6, True)
    porthole(c + up * (h * 0.24) + n * 0.1, n, 0.13)
    for s in (-0.34, 0.0, 0.34):
        a = c + u * (-w / 2 - 0.06) + up * (s * h)
        cyl(a + up * -0.09 + n * 0.1, a + up * 0.09 + n * 0.1, 0.045, "steel", seg=8)
        box_at = c + u * (w / 2 - 0.1) + up * (s * h) + n * 0.14
        bar(box_at, box_at + u * -0.18 + up * 0.05, 0.028, "chrome")
        cyl(box_at - n * 0.05, box_at + n * 0.02, 0.05, "steel", seg=8)
        streak(a + n * 0.05 + up * -0.1, rng.uniform(0.3, 0.9), 0.06, 0.6)
    torus(c + up * -0.05 + u * 0.1 + n * 0.17, n, 0.12, 0.022, "chrome", 16, 6)
    box(c + up * (-h / 2 - 0.14) + n * 0.2, (0.45 if abs(n.x) > 0.5 else w + 0.25, 0.1, w + 0.25 if abs(n.x) > 0.5 else 0.45), "iron", 0.025)


def chain(a, b, size=0.13, kind="iron"):
    a, b = Vector(a), Vector(b)
    d, u, v = frame_of(b - a)
    count = max(2, int((b - a).length / (size * 1.45)))
    for i in range(count):
        c = a.lerp(b, (i + 0.5) / count)
        s = u if i % 2 else v
        half = (b - a).length / count * 0.45
        ring = []
        for end, a0 in ((1, -90), (-1, 90)):
            for k in range(5):
                t = math.radians(a0 + 45 * k)
                ring.append(c + d * (end * half + math.cos(t) * size * 0.36) + s * (math.sin(t) * size * 0.36))
        tube(ring, size * 0.17, kind, 5, True)


def chain_run(path, size):
    """A chain lying along a path, its links turned one way and the other in turn."""
    pts = [Vector(p) for p in path]
    lengths = [0.0]
    for a, b in zip(pts, pts[1:]):
        lengths.append(lengths[-1] + (b - a).length)

    def at(s):
        i = next(i for i in range(1, len(lengths)) if s <= lengths[i] or i == len(lengths) - 1)
        return pts[i - 1].lerp(pts[i], (s - lengths[i - 1]) / (lengths[i] - lengths[i - 1]))

    count = round(lengths[-1] / (size * 1.45))
    step = lengths[-1] / count
    flat = V(0, 0, 1)
    for i in range(count):
        c = at((i + 0.5) * step)
        d = (at((i + 0.9) * step) - at((i + 0.1) * step)).normalized()
        flat = (flat - d * flat.dot(d)).normalized()
        s = flat if i % 2 else flat.cross(d)
        ring = [c + d * (end * step * 0.45 + math.cos(a) * size * 0.36) + s * (math.sin(a) * size * 0.36)
                for end, a0 in ((1, -90), (-1, 90)) for a in (math.radians(a0 + 45 * k) for k in range(5))]
        tube(ring, size * 0.17, "iron", 6, True)


def deck_pipe(x, z, long, wide, lip, floor):
    """A pipe mouth in the deck: the dark opening and the rounded lip round it.
    `floor(x)` is the deck's height there."""
    ring = [(x + long * math.cos(a), z + wide * math.sin(a)) for a in (2 * math.pi * i / 24 for i in range(24))]
    loft([[V(px, floor(px) + h, pz) for px, pz in ring] for h in (-0.02, 0.025)], "rubber")
    tube([V(px, floor(px) + lip * 0.4, pz) for px, pz in ring], lip, "steel", 8, True)


def rail(points, height=1.0, kind="white", step=0.85, toe=True):
    pts = [Vector(p) for p in points]
    for level, r in ((1.0, 0.045), (0.66, 0.028), (0.34, 0.028)):
        tube([p + V(0, height * level, 0) for p in pts], r, kind, 7)
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        n = max(1, round((b - a).length / step))
        for k in range(n + (1 if i == len(pts) - 2 else 0)):
            p = a.lerp(b, k / n)
            bar(p, p + V(0, height, 0), 0.038, kind, 6)
            cyl(p, p + V(0, 0.06, 0), 0.085, kind, seg=8)
        if toe:
            beam(a + V(0, 0.09, 0), b + V(0, 0.09, 0), 0.04, 0.14, kind, 0.008)


def ladder(a, b, side, width=0.5, step=0.3, kind="steel"):
    a, b, s = Vector(a), Vector(b), Vector(side).normalized() * (width / 2)
    for k in (-1, 1):
        bar(a + s * k, b + s * k, 0.04, kind)
    n = int((b - a).length / step)
    for i in range(1, n):
        p = a.lerp(b, i / n)
        bar(p - s, p + s, 0.025, kind, 6)


def bolts(centre, radius, count, y_axis=(0, 1, 0), size=0.04, kind="steel"):
    c = Vector(centre)
    d, u, v = frame_of(y_axis)
    for i in range(count):
        a = 2 * math.pi * i / count
        p = c + (u * math.cos(a) + v * math.sin(a)) * radius
        cyl(p, p + d * size, size, kind, seg=6)


def lifebuoy(c, normal):
    c, n = Vector(c), Vector(normal).normalized()
    _, u, v = frame_of(n)
    torus(c, n, 0.4, 0.12, "trim", 32, 10)
    for i in range(4):
        a = math.pi / 4 + i * math.pi / 2
        arc = [c + (u * math.cos(a + t) + v * math.sin(a + t)) * 0.4 for t in (-0.13, -0.065, 0, 0.065, 0.13)]
        tube(arc, 0.128, "white", 10)
    ring = []
    for i in range(33):
        a = 2 * math.pi * i / 32
        r = 0.53 + 0.07 * abs(math.sin(2 * a))
        ring.append(c + (u * math.cos(a) + v * math.sin(a)) * r + n * 0.06)
    tube(ring, 0.016, "rope", 5)
    box(c - n * 0.16 + V(0, -0.52, 0), (0.28, 0.07, 0.28), "iron")
    streak(c + V(0, -0.55, 0), 0.9, 0.12, 0.35)


def coil(c, R, turns=5, r=0.055):
    c = Vector(c)
    path = []
    for i in range(turns * 20 + 1):
        a = i / 20 * 2 * math.pi
        rad = R - 0.11 * ((i // 20) % 3)
        path.append(c + V(rad * math.cos(a), r + i / (turns * 20) * r * 5, rad * math.sin(a)))
    path += [c + V(R + 0.25, r, 0.35), c + V(R + 0.7, r, 0.2)]
    tube(path, r, "rope", 6)


# ---------------------------------------------------------------------------
# The hull (the same lines as harbourTug in render3d.js)
# ---------------------------------------------------------------------------
AFT, BOW, SHOULDER, HALF = -15.4, 15.5, 3.0, 6.1
KEEL = -3.4


def clamp(v, a=0.0, b=1.0):
    return max(a, min(b, v))


def smoothstep(a, b, x):
    t = clamp((x - a) / (b - a))
    return t * t * (3 - 2 * t)


def sheer(x):
    return 3.8 + 1.5 * ((x - SHOULDER) / 12.5) ** 1.6 if x > SHOULDER else 3.3 + 0.5 * smoothstep(-5, SHOULDER, x)


def deck_y(x):
    return sheer(x) - 0.95


def deck_at(px):
    """The deck's height at the true position px: forward of the shoulder the
    hull's x is drawn in towards the stem, so deck_y(px) would lie under it."""
    x = px
    for _ in range(6):
        x += px - skin(x, deck_y(x), 1, -0.12).x
    return deck_y(x)


def skin(x, y, side, proud=0.0):
    f = clamp((x - SHOULDER) / (BOW - SHOULDER))
    stern = clamp((-9 - x) / (-9 - AFT))
    below = 0.5 + 0.5 * math.sin(clamp((y + 3.4) / 4.4) * math.pi / 2) ** 0.7
    flare = 1 - f * 0.14 * (1 - clamp(y / 5))
    w = HALF * max(0.0, 1 - f ** 2.5) ** 0.55 * (1 - 0.3 * stern ** 3) * below * flare
    tip = BOW - 2.4 * (1 - clamp((y + 0.5) / 5.5)) ** 1.4
    px = SHOULDER + (x - SHOULDER) * (tip - SHOULDER) / (BOW - SHOULDER) if x > SHOULDER else x
    turn = f ** 3
    return V(px + proud * turn, y, side * (w + proud * (1 - turn)))


def surface(nu, nv, point, kind, outward):
    """A grid of points as one sheet, its faces turned towards `outward(point)`."""
    pts = [point(i / nu, j / nv) for j in range(nv + 1) for i in range(nu + 1)]
    faces = []
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i
            f = [a, a + 1, a + nu + 2, a + nu + 1]
            q = [pts[k] for k in f]
            normal = (q[2] - q[0]).cross(q[3] - q[1])
            if normal.length < 1e-9:
                continue
            centre = (q[0] + q[1] + q[2] + q[3]) / 4
            faces.append(f if normal.dot(outward(centre)) >= 0 else f[::-1])
    add_raw(pts, faces, kind)


def along(a, b, s):
    return a + (b - a) * (0.5 - 0.5 * math.cos(math.pi * s))


def run(x0, x1, y, proud, n=60, side=1):
    return [skin(x, y(x), side, proud) for x in (along(x0, x1, i / n) for i in range(n + 1))]


def hull():
    for side in (-1, 1):
        surface(110, 44, lambda s, t: skin(along(AFT, BOW, s), KEEL + (sheer(along(AFT, BOW, s)) - KEEL) * t, side), "hull", lambda p: V(0.15 if p.x > 8 else 0, -0.1, side))
        # the bulwark's inner face, cap rail and stays
        top = BOW - 0.5
        surface(100, 3, lambda s, t: skin(along(AFT, top, s), deck_y(along(AFT, top, s)) + 0.95 * t, side, -0.2), "trim", lambda p: V(-0.4 if p.x > 8 else 0, 0, -side))
        tube(run(AFT, BOW, sheer, -0.08, 80, side), 0.17, "trim", 10)
        x = -14.6
        while x < 12.6:
            foot, head = skin(x, deck_y(x) + 0.02, side, -0.62), skin(x, sheer(x) - 0.08, side, -0.22)
            root = skin(x, deck_y(x) + 0.02, side, -0.2)
            tube([root, foot], 0.035, "trim", 6)
            tube([foot, head], 0.05, "trim", 6)
            x += 1.15
        # freeing ports with their runs
        for x in (-12.9, -9.6, -6.1, -2.7, 0.9, 4.1):
            c = skin(x, deck_y(x) + 0.17, side, 0.015)
            ahead = skin(x + 0.3, deck_y(x) + 0.17, side, 0.015)
            yaw = math.atan2(c.z - ahead.z, ahead.x - c.x)
            box(c, (0.72, 0.2, 0.03), "iron", 0.008, yaw)
            for k in (-0.2, 0.2):
                streak(skin(x + k, deck_y(x) + 0.05, side, 0.02), rng.uniform(1.2, 3.0), 0.12, rng.uniform(0.55, 0.9))
        x = AFT
        while x < BOW - 0.6:
            streak(skin(x, sheer(x) - rng.uniform(0.15, 1.2), side, 0.02), rng.uniform(0.4, 2.4), rng.uniform(0.03, 0.1), rng.uniform(0.2, 0.7))
            x += rng.uniform(0.35, 1.3)
    surface(14, 20, lambda s, t: V(skin(AFT, KEEL + (sheer(AFT) - KEEL) * t, 1).x, KEEL + (sheer(AFT) - KEEL) * t, skin(AFT, KEEL + (sheer(AFT) - KEEL) * t, 1).z * (2 * s - 1)), "hull", lambda p: V(-1, 0, 0))
    surface(12, 3, lambda s, t: V(AFT + 0.2, deck_y(AFT) + 0.95 * t, skin(AFT, sheer(AFT), 1, -0.2).z * (2 * s - 1)), "trim", lambda p: V(1, 0, 0))
    tube([V(AFT, sheer(AFT), skin(AFT, sheer(AFT), 1, -0.08).z * k / 6) for k in range(-6, 7)], 0.17, "trim", 10)
    surface(60, 2, lambda s, t: V(skin(along(AFT, BOW, s), KEEL, 1).x, KEEL, skin(along(AFT, BOW, s), KEEL, 1).z * (2 * t - 1)), "hull", lambda p: V(0, -1, 0))
    surface(100, 16, lambda s, t: V(skin(along(AFT, BOW - 0.35, s), deck_y(along(AFT, BOW - 0.35, s)), 1, -0.12).x, deck_y(along(AFT, BOW - 0.35, s)), skin(along(AFT, BOW - 0.35, s), deck_y(along(AFT, BOW - 0.35, s)), 1, -0.12).z * (2 * t - 1)), "deck", lambda p: V(0, 1, 0))


def fenders():
    upper = lambda x: sheer(x) - 1
    lower = lambda x: 0.9 + (sheer(x) - 3) * smoothstep(-1, 9.5, x)
    for side in (-1, 1):
        # the bow belt: separate moulded rubber blocks, each bolted on
        blocks = 46
        for b in range(blocks):
            rings = []
            for part, swell in ((0.08, 0.78), (0.2, 1.0), (0.8, 1.0), (0.92, 0.78)):
                s = 0.5 + (b + part) / blocks / 2
                x = along(4, BOW, s)
                y = sheer(x) - 2.1
                rings.append([skin(x, y + 1.35 * t, side, 0.04 + swell * 0.55 * math.sin(math.pi * t) ** 0.35) for t in (i / 10 for i in range(11))])
            loft(rings, "rubber", caps=True)
        tube(run(4, BOW, lambda x: sheer(x) - 0.75, 0.1, 60, side), 0.16, "rubber", 10)
        tube(run(7, BOW, lambda x: sheer(x) - 2.12, 0.13, 60, side), 0.21, "rubber", 10)
        tube(run(AFT, 7.5, upper, 0.18, 60, side), 0.29, "rubber", 12)
        tube(run(AFT, 8, lower, 0.18, 60, side), 0.29, "rubber", 12)
        for x in [-11.5 + 2.4 * i for i in range(7)]:
            tube([skin(x + 0.7 * (1 - t), lower(x + 0.7) + (upper(x + 0.7) - lower(x + 0.7)) * (1 - t), side, 0.14) for t in (i / 8 for i in range(9))], 0.19, "rubber", 8)
        for y_of in (upper, lower):
            x = -14.0
            while x < 7:
                c = skin(x, y_of(x), side, 0.47)
                cyl(c, c + V(0, 0, side * 0.04), 0.055, "steel", seg=6)
                streak(skin(x, y_of(x) - 0.3, side, 0.02), rng.uniform(0.2, 0.9), 0.05, rng.uniform(0.35, 0.7))
                x += 1.35
        # tyres on chains
        for x in (-11, -8.2, 0.4):
            p = skin(x, sheer(x) - 1.75, side, 0.74)
            torus(p, (0, 0, 1), 0.5, 0.23, "rubber", 36, 12)
            for k in range(36):
                a = 2 * math.pi * k / 36
                u = V(math.cos(a), math.sin(a), 0)
                bar(p + u * 0.66 + V(0, 0, -0.14), p + u * 0.66 + V(0, 0, 0.14), 0.075, "rubber", 6)
            torus(p, (0, 0, 1), 0.28, 0.035, "iron", 24, 6)
            for k in (-1, 1):
                top = skin(x + k * 0.55, sheer(x) + 0.02, side, 0.1)
                chain(top, p + V(k * 0.36, 0.48, side * 0.12))
                torus(top, (1, 0, 0), 0.09, 0.028, "steel", 14, 6)
            streak(skin(x, sheer(x) - 2.4, side, 0.02), rng.uniform(0.8, 1.6), 0.25, 0.4, DIRT)
        # anchor in its pocket, hawse ring and cable
        a, b, c = skin(13.65, 1.75, side), skin(14.55, 1.75, side), skin(14.1, 1.75, side, 0.14)
        yaw = math.atan2(a.z - b.z, b.x - a.x)
        out = V(math.sin(yaw) * side, 0, math.cos(yaw) * side)
        ahead = (b - a).normalized()
        box(c + V(0, 0.05, 0) - out * 0.1, (1.3, 0.95, 0.12), "iron", 0.1, yaw)
        torus(c + V(0, 0.58, 0) + out * 0.03, out, 0.17, 0.065, "iron", 18, 8)
        beam(c + V(0, 0.55, 0) + out * 0.14, c + V(0, -0.32, 0) + out * 0.14, 0.15, 0.15, "iron")
        beam(c - ahead * 0.5 + V(0, -0.36, 0) + out * 0.14, c + ahead * 0.5 + V(0, -0.36, 0) + out * 0.14, 0.22, 0.2, "iron", 0.07)
        for k in (-1, 1):
            cyl(c + ahead * (0.43 * k) + V(0, -0.36, 0) + out * 0.16, c + ahead * (0.6 * k) + V(0, 0.18, 0) + out * 0.18, 0.13, "iron", 0.015, 6, 0.02)
        for k in (-0.35, 0, 0.35):
            streak(c + ahead * k + V(0, -0.5, 0), rng.uniform(0.9, 2.0), 0.14, 0.8)
    # stern fender: a fat roll with its lashing bands, and big rolls on the quarters
    line = []
    for i in range(25):
        k = i / 12 - 1
        p = skin(AFT, 2.3, 1)
        line.append(V(p.x - 0.45 - 0.5 * (1 - k * k), 2.3, p.z * k))
    tube(line, 0.7, "rubber", 16)
    for i in range(2, 23, 2):
        d = (line[i + 1] - line[i - 1]).normalized()
        torus(line[i], d, 0.72, 0.035, "iron", 20, 6)
        chain(line[i] + V(0, 0.7, 0), V(AFT - 0.02, sheer(AFT) - 0.08, line[i].z), 0.11)
    for side in (-1, 1):
        for x in (-14.6, -12.4):
            p = skin(x, 2.4, side, 0.55)
            cyl(p + V(-1.1, 0, 0), p + V(1.1, 0, 0), 0.7, "rubber", seg=18, bevel=0.3)
            for k in (-0.55, 0.55):
                torus(p + V(k, 0, 0), (1, 0, 0), 0.72, 0.04, "iron", 22, 6)
                chain(p + V(k, 0.7, 0), skin(x + k, sheer(x) - 0.05, side, 0.08), 0.11)


# ---------------------------------------------------------------------------
# Deckhouse and wheelhouse
# ---------------------------------------------------------------------------
HOUSE = [(9.4, 2.3), (9.4, -2.3), (8.2, -3.9), (-0.8, -3.9), (-1.8, -3), (-1.8, 3), (-0.8, 3.9), (8.2, 3.9)]
WHEEL = [(7.9, 1.35), (7.9, -1.35), (6.8, -2.55), (4.2, -2.75), (2.4, -1.95), (2.4, 1.95), (4.2, 2.75), (6.8, 2.55)]


def grow(plan, k, cx=4.0):
    return [(cx + (x - cx) * k, z * k) for x, z in plan]


def louvre(c, normal, w, h):
    c, n = Vector(c), Vector(normal).normalized()
    u = V(0, 1, 0).cross(n).normalized()
    plate(c + n * 0.02, u, V(0, 1, 0), w, h, 0.05, 0.05, "iron")
    tube(rrect(c + n * 0.06, u, V(0, 1, 0), w + 0.06, h + 0.06, 0.07), 0.03, "white", 6, True)
    count = int(h / 0.11)
    for i in range(count):
        y = -h / 2 + (i + 0.5) * h / count
        beam(c + u * (-w / 2 + 0.04) + V(0, y, 0) + n * 0.07, c + u * (w / 2 - 0.04) + V(0, y, 0) + n * 0.07, 0.05, 0.025, "steel", 0.004)
    streak(c + V(0, -h / 2 - 0.05, 0), 1.0, w * 0.35, 0.45, DIRT)


def lamp(c, normal):
    c, n = Vector(c), Vector(normal).normalized()
    box(c + n * 0.1, (0.28, 0.2, 0.28), "iron", 0.04)
    cyl(c + n * 0.2 + V(0, -0.02, 0), c + n * 0.28 + V(0, -0.06, 0), 0.11, "lens_white", seg=14)
    torus(c + n * 0.28 + V(0, -0.06, 0), n + V(0, -0.5, 0), 0.115, 0.018, "steel", 16, 6)


def deckhouse():
    prism(HOUSE, HOUSE, 2.2, 6.1, "white", 0.12)
    prism(grow(HOUSE, 1.07), grow(HOUSE, 1.07), 6.1, 6.35, "white", 0.06)
    tube([V(x, 6.09, z) for x, z in grow(HOUSE, 1.075)], 0.035, "steel", 6, True)
    # coaming round the foot of the walls, and welded panel stiffeners
    tube([V(x, deck_y(x) + 0.06, z) for x, z in grow(HOUSE, 1.012)], 0.07, "iron", 8, True)
    for i in range(len(HOUSE)):
        ax, az = HOUSE[i]
        bx, bz = HOUSE[(i + 1) % len(HOUSE)]
        bar(V(ax, 2.6, az), V(ax, 6.05, az), 0.06, "white", 8)
        for t in (rng.random(), rng.random(), rng.random()):
            streak((ax + (bx - ax) * t, 6.05, az + (bz - az) * t), rng.uniform(0.5, 2.2), rng.uniform(0.04, 0.12), rng.uniform(0.2, 0.55))
    for side in (-1, 1):
        n = (0, 0, side)
        for x in (0.4, 2.4, 6.4):
            window((x, 5.0, side * 3.9), n, 0.78, 0.68)
        for x in (1.4, 7.5):
            porthole((x, 3.7, side * 3.9), n, 0.19)
        door((4.4, 4.1, side * 3.9), n)
        louvre((-0.2, 3.7, side * 3.9), n, 0.85, 0.75)
        lamp((3.4, 5.65, side * 3.9), n)
        lamp((8.0, 5.65, side * 3.9), n)
        # fire main along the wall, with flanges, brackets and hydrant valves
        pipe = [V(-0.7, 2.75, side * 4.06), V(3.2, 2.78, side * 4.06), V(3.5, 3.1, side * 4.06)]
        tube(pipe, 0.075, "red", 10)
        tube([V(5.5, 3.1, side * 4.06), V(5.8, 2.92, side * 4.06), V(8.1, 2.98, side * 4.06)], 0.075, "red", 10)
        for x in (-0.5, 1.2, 2.9, 6.2, 7.8):
            torus((x, 2.76 if x < 4 else 2.95, side * 4.06), (1, 0, 0), 0.095, 0.03, "red", 14, 6)
            box((x + 0.15, 2.76 if x < 4 else 2.95, side * 3.98), (0.08, 0.24, 0.18), "iron", 0.01)
        cyl((0.9, 2.75, side * 4.06), (0.9, 3.15, side * 4.06), 0.05, "red", seg=8)
        torus((0.9, 3.18, side * 4.06), (0, 1, 0), 0.13, 0.022, "yellow", 16, 6)
        # electrical locker and cable tray
        box((9.0 - 1.0, 3.2, side * 3.99), (0.6, 0.8, 0.16), "steel", 0.04)
        tube([V(8.0, 3.6, side * 3.96), V(8.0, 5.9, side * 3.96)], 0.04, "iron", 6)
    # front: windows, name board, fire locker; back: door and hose reel
    for z in (0.0, 1.4):
        window((9.4, 5.42, z), (1, 0, 0), 0.7, 0.58)
    box((9.5, 5.4, -1.5), (0.22, 1.05, 1.05), "red", 0.05)
    cyl((9.6, 5.4, -1.5), (9.64, 5.4, -1.5), 0.28, "white", seg=24)
    box((9.66, 5.4, -1.5), (0.02, 0.34, 0.09), "red", 0.004)
    box((9.66, 5.4, -1.5), (0.02, 0.09, 0.34), "red", 0.004)
    door((9.4, 3.75, -0.55), (1, 0, 0), 0.9, 1.7)
    louvre((9.4, 3.8, 1.3), (1, 0, 0), 0.8, 0.9)
    door((-1.8, 3.65, 1.3), (-1, 0, 0), 0.95, 1.9)
    for k in (-1, 1):
        torus((-2.05, 3.5, -1.4 + 0.22 * k), (0, 0, 1), 0.55, 0.05, "iron", 24, 6)
        for i in range(6):
            a = i * math.pi / 3
            bar((-2.05, 3.5, -1.4 + 0.22 * k), (-2.05 + 0.55 * math.cos(a), 3.5 + 0.55 * math.sin(a), -1.4 + 0.22 * k), 0.025, "iron")
    for r, z in ((0.42, -1.5), (0.4, -1.4), (0.42, -1.3), (0.3, -1.45), (0.3, -1.35)):
        torus((-2.05, 3.5, z), (0, 0, 1), r, 0.065, "red", 28, 8)
    # upper deck: rails, buoys, rafts, stair, monitors, lockers
    ring = [(-1.9, 3.2), (-0.8, 4.12), (8.3, 4.12), (9.72, 2.4), (9.72, -2.4), (8.3, -4.12), (-0.8, -4.12), (-1.9, -3.2), (-1.9, 3.2)]
    rail([(x, 6.35, z) for x, z in ring], 1.05)
    for x, z, n in ((9.86, -2.0, (1, 0, 0)), (4.0, 4.28, (0, 0, 1)), (0.5, -4.28, (0, 0, -1)), (-2.02, 1.8, (-1, 0, 0))):
        lifebuoy((x, 6.95, z), n)
    for x, z in ((8.0, -3.25), (0.6, 3.1)):
        cyl((x - 1.05, 7.25, z), (x + 1.05, 7.25, z), 0.6, "white", seg=22, bevel=0.35)
        torus((x, 7.25, z), (1, 0, 0), 0.605, 0.022, "iron", 24, 5)
        for k in (-0.6, 0.6):
            torus((x + k, 7.25, z), (1, 0, 0), 0.62, 0.035, "steel", 24, 6)
            box((x + k, 6.55, z), (0.18, 0.45, 1.15), "iron", 0.04)
            bar((x + k, 6.4, z - 0.7), (x + k, 7.0, z - 0.55), 0.035, "iron")
    for z in (-4.35, -5.2):
        beam((-0.4, 2.45, z), (3.0, 6.37, z), 0.09, 0.28, "iron", 0.02)
        tube([V(-0.4, 2.45, z), V(-0.4, 3.45, z), V(3.0, 7.37, z), V(3.0, 6.37, z)], 0.045, "white", 8)
        for i in range(1, 5):
            bar((-0.4 + i * 0.68, 2.45 + i * 0.784, z), (-0.4 + i * 0.68, 3.45 + i * 0.784, z), 0.032, "white")
    for i in range(1, 12):
        box((-0.4 + i * 0.285, 2.42 + i * 0.33, -4.78), (0.34, 0.06, 0.82), "steel", 0.012)
    box((2.9, 6.3, -4.5), (0.7, 0.1, 1.0), "steel", 0.02)
    for side in (-1, 1):  # fire monitors
        p = V(8.5, 6.35, side * 1.9 + 0.9)
        cyl(p, p + V(0, 0.75, 0), 0.16, "red", seg=12)
        torus(p + V(0, 0.78, 0), (0, 1, 0), 0.17, 0.05, "red", 16, 8)
        tube([p + V(0, 0.8, 0), p + V(0.15, 1.05, 0), p + V(0.55, 1.12, 0)], 0.12, "red", 10)
        cyl(p + V(0.5, 1.115, 0), p + V(0.95, 1.18, 0), 0.12, "chrome", 0.075, 14)
        torus(p + V(0, 0.45, 0.22), (0, 0, 1), 0.14, 0.02, "yellow", 16, 6)
    for x, z in ((7.2, 3.0), (-0.9, -1.6)):
        box((x, 6.7, z), (1.1, 0.7, 0.8), "white", 0.07)
        box((x, 7.08, z), (1.16, 0.08, 0.86), "steel", 0.02)
        for k in (-0.3, 0.3):
            box((x + k, 6.75, z + 0.42), (0.1, 0.18, 0.04), "chrome", 0.008)


def wheelhouse():
    ring = lambda k: grow(WHEEL, k, 5.0)
    prism(ring(0.96), ring(0.96), 6.3, 7.5, "white", 0.07)
    prism(ring(0.935), ring(1.085), 7.5, 10.0, "glass", 0.01)
    prism(ring(1.0), ring(1.0), 7.38, 7.62, "white", 0.05)
    prism(ring(1.13), ring(1.13), 9.93, 10.22, "white", 0.07)
    prism(ring(1.155), ring(1.12), 10.22, 10.55, "trim", 0.07)
    prism(ring(1.055), ring(0.83), 10.55, 11.15, "glass", 0.01)
    prism(ring(0.9), ring(0.82), 11.15, 11.45, "trim", 0.07)
    a, b = ring(0.955), ring(1.105)
    n = len(WHEEL)
    for i in range(n):
        m = (i + 1) % n
        cuts = [0, 0.5, 1] if i in (0, 2, 3, 5, 6) else [0, 1]
        pt = lambda p, y, t: V(p[i][0] + (p[m][0] - p[i][0]) * t, y, p[i][1] + (p[m][1] - p[i][1]) * t)
        for c0, c1 in zip(cuts, cuts[1:]):
            q = [pt(a, 7.62, c0), pt(a, 7.62, c1), pt(b, 9.93, c1), pt(b, 9.93, c0)]
            mid = (q[0] + q[1] + q[2] + q[3]) / 4
            inner = [mid.lerp(p, 0.9) for p in q]
            normal = (q[1] - q[0]).cross(q[3] - q[0]).normalized()
            if normal.dot(mid - V(5, mid.y, 0)) < 0:
                normal = -normal
            tube([p + normal * 0.05 for p in inner], 0.05, "rubber", 6, True)
            beam(q[0] + normal * 0.03, q[3] + normal * 0.03, 0.14, 0.14, "white", 0.03)
            if i == 0 or (i in (1, 7) and c0 == 0):  # wipers on the forward panes
                hub = q[0].lerp(q[1], 0.5).lerp(q[3].lerp(q[2], 0.5), 0.07) + normal * 0.1
                tip = hub.lerp(q[3].lerp(q[2], 0.72), 0.55) + normal * 0.05
                bar(hub, tip, 0.022, "iron", 6)
                bar(tip + V(0, -0.38, 0), tip + V(0, 0.38, 0), 0.026, "rubber", 6)
                cyl(hub - normal * 0.06, hub + normal * 0.05, 0.07, "steel", seg=8)
        streak(pt(ring(1.0), 7.38, 0.3), 1.0, 0.1, 0.4)
        streak(pt(ring(1.13), 9.93, 0.7), 0.7, 0.08, 0.3)
        # roof glazing bars
        beam(V(ring(1.065)[i][0], 10.55, ring(1.065)[i][1]), V(ring(0.84)[i][0], 11.16, ring(0.84)[i][1]), 0.17, 0.12, "trim", 0.03)
    tube([V(x, 7.66, z) for x, z in ring(1.03)], 0.04, "chrome", 6, True)
    top = ring(0.8)
    rail([(x, 11.45, z) for x, z in top + [top[0]]], 0.8, step=0.7, toe=False)
    for x, z, yaw in ((6.5, 1.35, 0.35), (6.5, -1.35, -0.35)):  # searchlights
        cyl((x, 11.45, z), (x, 11.95, z), 0.07, "steel")
        d = V(math.cos(yaw), -0.05, math.sin(yaw))
        cyl(V(x, 12.15, z) - d * 0.22, V(x, 12.15, z) + d * 0.22, 0.27, "chrome", 0.31, 18, 0.03)
        cyl(V(x, 12.15, z) + d * 0.2, V(x, 12.15, z) + d * 0.24, 0.26, "lens_white", seg=18)
    for z in (-0.35, 0.35):  # air horns
        cyl((6.9, 11.7, z), (7.7, 11.7, z), 0.06, "chrome", 0.18, 14)
        box((6.85, 11.6, z), (0.16, 0.3, 0.16), "iron")
    for x, z, h in ((3.0, 1.5, 3.2), (3.0, -1.5, 2.6), (6.2, 0, 1.8)):
        cyl((x, 11.45, z), (x, 11.45 + h, z), 0.035, "white", 0.012, 6)
        cyl((x, 11.45, z), (x, 11.75, z), 0.08, "iron")


def mast():
    cyl((4, 11.4, 0), (4, 19, 0), 0.34, "white", 0.24, 16)
    cyl((4, 19, 0), (4, 21.4, 0), 0.14, "white", 0.1, 10)
    cyl((4, 21.4, 0), (4, 22.2, 0), 0.22, "iron", seg=10, bevel=0.04)
    ellipsoid((4, 22.35, 0), (0.17, 0.17, 0.17), "lens_white", 12, 8)
    for y in (12.5, 14.5, 17.0, 19.0):
        torus((4, y, 0), (0, 1, 0), 0.33 - (y - 12) * 0.012, 0.045, "steel", 20, 6)
    ladder((3.55, 11.5, 0), (3.68, 18.8, 0), (0, 0, 1), 0.42, 0.34, "white")
    for side in (-1, 1):
        bar((4.4, 11.4, side * 1.7), (4.1, 16, side * 0.2), 0.12, "white", 10)
        bar((2.6, 11.4, side * 0.9), (3.9, 15, 0), 0.12, "white", 10)
        for t in (0.3, 0.62):
            bar(V(4.4, 11.4, side * 1.7).lerp(V(4.1, 16, side * 0.2), t), (4, 11.4 + t * 5.2, 0), 0.05, "white")
        for end in ((7, 11.5, side * 2.2), (2.4, 11.5, side * 2.1)):
            bar((4, 18.8, 0), end, 0.016, "iron", 5)
            cyl(V(*end), V(*end).lerp(V(4, 18.8, 0), 0.05), 0.05, "steel", seg=6)
        bar((6.6, 11.4, side * 2.3), (6.6, 15.6, side * 2.5), 0.035, "white", 6)
        ellipsoid((6, 12.85, side * 1.9), (0.48, 0.55, 0.48), "white", 24, 14, -0.55)
        cyl((6, 11.4, side * 1.9), (6, 12.55, side * 1.9), 0.11, "white")
        torus((6, 12.55, side * 1.9), (0, 1, 0), 0.36, 0.05, "steel", 20, 6)
        box((7.3, 11.9, side * 0.8), (0.5, 0.45, 0.45), "white", 0.06)
        cyl((7.55, 11.9, side * 0.8), (7.6, 11.9, side * 0.8), 0.15, "glass")
    lenses = ("lens_red", "lens_green", "lens_white", "lens_white")
    for (y, w), lens in zip(((13.3, 2.4), (15.9, 3.0), (17.6, 2.1), (19.2, 1.5)), lenses):
        box((4.15, y, 0), (0.7, 0.1, w), "white", 0.03)
        for dx in (-0.3, 0.3):
            tube([V(4.15 + dx, y, -w / 2), V(4.15 + dx, y + 0.34, -w / 2), V(4.15 + dx, y + 0.34, w / 2), V(4.15 + dx, y, w / 2)], 0.025, "white", 5)
        for z in (-w / 2, w / 2):
            bar((4.2, y, z), (4.2, y + 0.55, z), 0.05, "white", 6)
            cyl((4.2, y + 0.55, z), (4.2, y + 0.65, z), 0.17, "iron", seg=10)
            cyl((4.2, y + 0.65, z), (4.2, y + 0.86, z), 0.13, lens, seg=12)
            cyl((4.2, y + 0.86, z), (4.2, y + 0.94, z), 0.17, "iron", 0.08, 10)
        cyl((4.55, y - 0.55, 0), (4.55, y - 0.2, 0), 0.16, "iron", seg=10, bevel=0.03)
        bar((4.55, y - 0.38, 0), (4.2, y - 0.38, 0), 0.04, "steel")
    for x, y, w in ((4.75, 14.7, 5.4), (4.85, 12.2, 3.4)):
        box((x - 0.3, y - 0.42, 0), (0.85, 0.3, 0.85), "white", 0.08)
        cyl((x, y - 0.28, 0), (x, y - 0.08, 0), 0.18, "steel")
        beam((x, y, -w / 2), (x, y, w / 2), 0.2, 0.36, "blue", 0.08)
        for z in (-w / 2 + 0.3, w / 2 - 0.3):
            torus((x, y, z), (0, 0, 1), 0.2, 0.018, "white", 14, 5)
    bar((4, 16.8, -2), (4, 16.8, 2), 0.06, "white", 6)
    for z in (-2, -1.2, 1.2, 2):
        cyl((4, 16.8, z), (4, 17.5, z), 0.03, "white", 0.012, 6)
    bar((4, 20.6, -0.6), (4, 20.6, 0.6), 0.03, "steel")
    for z in (-0.6, 0.6):
        for k in range(3):
            a = k * 2.1
            bar((4, 20.75, z), (4 + 0.2 * math.cos(a), 20.75, z + 0.2 * math.sin(a)), 0.012, "iron", 4)
            ellipsoid((4 + 0.2 * math.cos(a), 20.75, z + 0.2 * math.sin(a)), (0.07, 0.07, 0.07), "iron", 8, 6)


def stacks():
    global group
    for side in (-1, 1):
        group = "stack_port" if side < 0 else "stack_starboard"
        plan = lambda cx, z, a, b: [(cx + a, side * z + b), (cx + a, side * z - b), (cx - a, side * z - b), (cx - a, side * z + b)]
        prism(plan(0.6, 2.9, 1, 0.65), plan(0.6, 2.95, 0.85, 0.6), 6.3, 8.4, "white", 0.2)
        prism(plan(0.6, 2.95, 0.85, 0.6), plan(0.5, 3.2, 0.7, 0.55), 8.4, 11.1, "soot", 0.2)
        prism(plan(0.5, 3.2, 0.7, 0.55), plan(0.1, 4.2, 0.07, 0.05), 11.1, 13.4, "soot", 0.03)
        tube([V(x, 8.4, z) for x, z in plan(0.6, 2.95, 0.9, 0.65)], 0.06, "steel", 8, True)
        tube([V(x, 10.35, z) for x, z in plan(0.52, 3.15, 0.78, 0.61)], 0.045, "iron", 8, True)
        louvre((0.6, 7.4, side * (2.93 + 0.63)), (0, 0, side), 1.1, 1.1)
        louvre((0.55, 9.45, side * 3.7), (0, 0.1, side), 0.8, 0.85)
        for dx, dz in ((-0.25, -0.15), (0.3, 0.05)):
            base = V(0.5 + dx, 10.9, side * (3.15 + dz))
            tip = base + V(-0.15, 1.25, side * 0.12)
            cyl(base, tip, 0.2, "soot", seg=14, caps=False)
            torus(tip, tip - base, 0.2, 0.035, "iron", 16, 6)
        ladder((-0.42, 6.4, side * 2.9), (-0.25, 10.8, side * 3.1), (0, 0, 1), 0.4, 0.32, "steel")
        streak((0.6, 8.35, side * 3.58), 1.8, 0.3, 0.55, DIRT)
        for x in (0.1, 1.2):
            streak((x, 8.4, side * 3.6), rng.uniform(0.8, 1.8), 0.08, 0.6)


def crane():
    cyl((7.2, 2.85, 4.9), (7.2, 3.0, 4.9), 0.78, "iron", seg=24, bevel=0.03)
    bolts((7.2, 3.0, 4.9), 0.68, 14, size=0.05)
    cyl((7.2, 2.9, 4.9), (7.2, 6.1, 4.9), 0.55, "iron", 0.42, 20)
    for y in (3.9, 5.4):
        torus((7.2, y, 4.9), (0, 1, 0), 0.52 - (y - 3.9) * 0.05, 0.04, "steel", 22, 6)
    box((7.2, 6.4, 4.9), (1.0, 0.8, 0.9), "iron", 0.14)
    cyl((7.2, 6.4, 4.35), (7.2, 6.4, 5.45), 0.16, "chrome", seg=12)
    beam((7.2, 6.5, 5.0), (7.5, 10.2, 3.8), 0.52, 0.46, "iron", 0.1)
    beam((7.5, 10.2, 3.8), (8.6, 10.0, 3.6), 0.34, 0.32, "iron", 0.07)
    for p in ((7.2, 6.5, 5.0), (7.5, 10.2, 3.8)):
        cyl(V(*p) + V(-0.34, 0, 0), V(*p) + V(0.34, 0, 0), 0.13, "steel", seg=14, bevel=0.02)
    for a, b in (((7.2, 5.4, 4.35), (7.35, 8.5, 4.4)), ((7.6, 8.8, 4.55), (8.2, 9.9, 3.75))):
        a, b = V(*a), V(*b)
        mid = a.lerp(b, 0.6)
        cyl(a, mid, 0.15, "white", seg=12, bevel=0.02)
        cyl(mid, b, 0.075, "chrome", seg=10)
        for p in (a, b):
            torus(p, (1, 0, 0), 0.1, 0.05, "steel", 14, 6)
    for k, off in enumerate((-0.18, 0.0, 0.18)):
        tube(smooth_path([(7.6, 6.2, 5.35 + off * 0.3), (7.85 + off, 7.6, 5.2 - k * 0.1), (7.75 + off, 9.0, 4.5), (7.6, 10.1, 4.0)]), 0.032, "rubber", 6)
    bar((8.6, 10.0, 3.6), (8.6, 8.95, 3.6), 0.02, "steel", 5)
    box((8.6, 8.85, 3.6), (0.24, 0.28, 0.18), "yellow", 0.05)
    tube(smooth_path([(8.6, 8.72, 3.6), (8.6, 8.45, 3.6), (8.75, 8.32, 3.6), (8.9, 8.45, 3.6), (8.86, 8.6, 3.6)], 5), 0.045, "iron", 7)
    for y in (4.9, 5.8):
        box((7.9, y, 4.9), (0.7, 0.55, 0.6), "iron", 0.08)
        for i in range(3):
            cyl((8.26, y - 0.14 + i * 0.14, 4.75), (8.34, y - 0.14 + i * 0.14, 4.75), 0.035, "chrome", seg=8)


# ---------------------------------------------------------------------------
# Deck gear
# ---------------------------------------------------------------------------
def bitts(x, z, yaw=0.0):
    y = deck_y(x)
    c = V(x, y, z)
    d = V(math.cos(yaw), 0, -math.sin(yaw))
    box(c + V(0, 0.06, 0), (1.15, 0.12, 0.55), "iron", 0.04, yaw)
    for k in (-0.32, 0.32):
        p = c + d * k
        cyl(p + V(0, 0.1, 0), p + V(0, 0.92, 0), 0.17, "iron", seg=18)
        cyl(p + V(0, 0.9, 0), p + V(0, 1.02, 0), 0.23, "iron", seg=18, bevel=0.05)
        torus(p + V(0, 0.14, 0), (0, 1, 0), 0.19, 0.04, "iron", 18, 6)
    bar(c + d * -0.55 + V(0, 0.62, 0), c + d * 0.55 + V(0, 0.62, 0), 0.07, "iron", 10)
    for k in (-0.48, 0.48):
        for s in (-0.17, 0.17):
            p = c + d * k + V(math.sin(yaw) * s, 0.12, math.cos(yaw) * s)
            cyl(p, p + V(0, 0.05, 0), 0.045, "steel", seg=6)
    for i in range(2):
        torus(c + d * -0.32 + V(0, 0.34 + i * 0.09, 0), (0.06, 1, 0), 0.24, 0.05, "rope", 20, 6)


def hatch(x, z, w, d):
    y = deck_y(x)
    box((x, y + 0.14, z), (w, 0.28, d), "trim", 0.06)
    box((x, y + 0.32, z), (w * 0.86, 0.12, d * 0.86), "iron", 0.05)
    for k in (-0.28, 0.28):
        cyl((x + k * w - 0.12, y + 0.36, z - d * 0.46), (x + k * w + 0.12, y + 0.36, z - d * 0.46), 0.05, "steel", seg=8)
        bar((x + k * w, y + 0.4, z + d * 0.38), (x + k * w, y + 0.4, z + d * 0.52), 0.03, "chrome")
        cyl((x + k * w, y + 0.28, z + d * 0.47), (x + k * w, y + 0.45, z + d * 0.47), 0.045, "steel", seg=8)
    tube([V(x - 0.18, y + 0.38, z), V(x - 0.18, y + 0.46, z), V(x + 0.18, y + 0.46, z), V(x + 0.18, y + 0.38, z)], 0.025, "chrome", 6)


def vent(x, z):
    y = deck_y(x)
    cyl((x, y, z), (x, y + 0.9, z), 0.17, "white", seg=16)
    torus((x, y + 0.08, z), (0, 1, 0), 0.21, 0.05, "white", 18, 6)
    bolts((x, y + 0.03, z), 0.27, 8, size=0.03)
    cyl((x, y + 0.86, z), (x, y + 0.94, z), 0.37, "red", seg=22, bevel=0.02)
    ellipsoid((x, y + 0.93, z), (0.37, 0.26, 0.37), "red", 22, 8, 0.0)


def windlass():
    y = deck_y(11.6)
    for z in (-1.35, 0.0, 1.35):
        prism([(12.15, z + 0.1), (12.15, z - 0.1), (11.05, z - 0.1), (11.05, z + 0.1)], [(11.8, z + 0.1), (11.8, z - 0.1), (11.4, z - 0.1), (11.4, z + 0.1)], y, y + 0.75, "iron", 0.04)
    cyl((11.6, y + 0.7, -1.9), (11.6, y + 0.7, 1.9), 0.17, "steel", seg=14)
    for z, r in ((-1.75, 0.42), (-0.85, 0.5), (0.85, 0.5), (1.75, 0.42)):
        cyl((11.6, y + 0.7, z - 0.17), (11.6, y + 0.7, z + 0.17), r, "iron", seg=24, bevel=0.04)
        for k in (-0.2, 0.2):
            cyl((11.6, y + 0.7, z + k - 0.04), (11.6, y + 0.7, z + k + 0.04), r + 0.13, "iron", seg=24, bevel=0.02)
    for i in range(8):
        a = i * math.pi / 4
        for z in (-0.85, 0.85):
            box((11.6 + 0.54 * math.cos(a), y + 0.7 + 0.54 * math.sin(a), z), (0.13, 0.13, 0.26), "iron", 0.03, 0, a)
    box((11.45, y + 0.72, 0.0), (0.75, 0.8, 0.75), "yellow", 0.14)
    cyl((11.0, y + 0.75, 0), (11.1, y + 0.75, 0), 0.24, "steel", seg=16)
    for z in (-2.2, 2.2):
        torus((11.6, y + 0.7, z), (0, 0, 1), 0.34, 0.04, "red", 24, 6)
        for i in range(4):
            a = i * math.pi / 2
            bar((11.6, y + 0.7, z), (11.6 + 0.34 * math.cos(a), y + 0.7 + 0.34 * math.sin(a), z), 0.028, "red")
    # each chain, never ending in plating: up out of its hawse pipe, over the
    # wheel and down the spurling pipe behind to the chain locker
    for side in (-1, 1):
        z, hawse_z = side * 0.85, side * 1.3
        lead = V(13.15, deck_at(13.15) + 0.13, side * 1.23)
        dx, dy = lead.x - 11.6, lead.y - (y + 0.7)
        top = math.atan2(dy, dx) + math.acos(0.66 / math.hypot(dx, dy))  # where it leaves the wheel
        turn = [top + (math.pi - top) * i / 10 for i in range(11)]
        chain_run(
            [(13.64, deck_at(13.5) - 0.2, hawse_z), (13.48, deck_at(13.48), hawse_z), lead]
            + [(11.6 + 0.66 * math.cos(a), y + 0.7 + 0.66 * math.sin(a), z) for a in turn]
            + [(10.94, deck_at(10.94) - 0.25, z)],
            0.2)
        deck_pipe(13.5, hawse_z, 0.34, 0.22, 0.055, deck_at)
        deck_pipe(10.94, z, 0.24, 0.24, 0.055, deck_at)


def towing_gear():
    y = deck_y(-5.2)
    cy_ = 3.7
    cyl((-5.2, cy_, -1.9), (-5.2, cy_, 1.9), 0.62, "iron", seg=24)
    # the wire wound on the drum, turn by turn
    for layer, (radius, span) in enumerate(((0.69, 1.78), (0.82, 1.72), (0.95, 1.66))):
        turns = int(2 * span / 0.14)
        path = []
        for i in range(turns * 18 + 1):
            a = i / 18 * 2 * math.pi
            path.append(V(-5.2 + radius * math.cos(a), cy_ + radius * math.sin(a), -span + 2 * span * i / (turns * 18)))
        tube(path, 0.068, "steel", 5)
    for z in (-2.0, 2.0):
        cyl((-5.2, cy_, z - 0.12), (-5.2, cy_, z + 0.12), 1.6, "trim", seg=40, bevel=0.05)
        torus((-5.2, cy_, z * 1.07), (0, 0, 1), 1.38, 0.05, "trim", 40, 6)
        torus((-5.2, cy_, z * 1.07), (0, 0, 1), 0.42, 0.08, "steel", 24, 8)
        bolts((-5.2, cy_, z * 1.06), 0.6, 10, (0, 0, z), 0.07)
        for i in range(6):
            a = i * math.pi / 3 + 0.3
            cyl((-5.2 + 0.95 * math.cos(a), cy_ + 0.95 * math.sin(a), z * 1.055), (-5.2 + 0.95 * math.cos(a), cy_ + 0.95 * math.sin(a), z * 1.07), 0.24, "iron", seg=14)
        for dx in (-1.05, 1.05):
            beam((-5.2 + dx, y, z * 1.32), (-5.2, cy_, z * 1.2), 0.2, 0.3, "iron", 0.04)
        box((-5.2, y + 0.07, z * 1.3), (2.6, 0.14, 0.55), "iron", 0.04)
        bolts((-6.2, y + 0.14, z * 1.3), 0.17, 4)
        bolts((-4.2, y + 0.14, z * 1.3), 0.17, 4)
    box((-5.2, y + 0.75, 3.05), (1.35, 1.2, 0.85), "yellow", 0.18)
    cyl((-5.2, y + 0.9, 3.4), (-5.2, y + 0.9, 3.75), 0.32, "iron", seg=18, bevel=0.04)
    for k, z in enumerate((2.85, 3.0, 3.15)):
        tube(smooth_path([(-4.6, y + 1.1, z), (-3.9, y + 0.9 + 0.1 * k, z + 0.35), (-2.9, y + 0.12, z + 0.4), (-1.9, y + 0.1, z)]), 0.05, "rubber", 6)
    # tow hook post, hook and the guard arches over the wire
    box((-10.5, 3.3, 0), (0.8, 2.2, 0.8), "iron", 0.1)
    bolts((-10.5, deck_y(-10.5) + 0.02, 0), 0.62, 10, size=0.06)
    box((-10.85, 4.35, 0), (1.3, 0.5, 0.5), "trim", 0.14)
    tube(smooth_path([(-11.3, 4.4, 0), (-11.75, 4.38, 0), (-11.95, 4.05, 0), (-11.75, 3.8, 0), (-11.5, 3.9, 0)], 6), 0.13, "iron", 10)
    tube(smooth_path([(-6.2, cy_ + 0.5, 0.2), (-8.2, 4.45, 0.15), (-10.6, 4.62, 0.05), (-11.5, 4.45, 0)]), 0.075, "steel", 8)
    for x in (-8.2, -12.6):
        base = deck_y(x)
        arch = smooth_path([(x, base, -3.55), (x, 4.35, -3.45), (x, 4.88, -2.9), (x, 4.9, 0), (x, 4.88, 2.9), (x, 4.35, 3.45), (x, base, 3.55)], 8)
        tube(arch, 0.17, "iron", 12)
        for z in (-3.5, 3.5):
            beam((x + 0.9, base, z), (x, 4.0, z), 0.14, 0.14, "iron", 0.03)
            cyl((x, base, z), (x, base + 0.12, z), 0.34, "iron", seg=16, bevel=0.02)
            bolts((x, base + 0.12, z), 0.27, 6, size=0.045)
            streak((x, 4.2, z), 1.0, 0.14, 0.6)
    # stern roller and guide pins
    cyl((-14.95, deck_y(-15) + 0.75, -2.6), (-14.95, deck_y(-15) + 0.75, 2.6), 0.27, "steel", seg=18, bevel=0.03)
    for z in (-2.8, 0.0, 2.8):
        box((-14.95, deck_y(-15) + 0.45, z), (0.5, 0.9, 0.18), "iron", 0.05)


def deck_gear():
    windlass()
    towing_gear()
    for x, z, yaw in ((12.7, 1.9, 0.5), (12.7, -1.9, -0.5), (10.3, 3.85, 0.3), (10.3, -3.85, -0.3), (-3.0, 5.15, 0.0), (-3.0, -5.15, 0.0), (-13.4, 3.1, 0.0), (-13.4, -3.1, 0.0)):
        bitts(x, z, yaw)
    for x, z, w, d in ((-9.8, 2.1, 1.5, 1.2), (-10.0, -2.2, 1.2, 1.2), (10.4, -2.2, 1.1, 1.2), (-2.9, -1.9, 1.0, 1.0)):
        hatch(x, z, w, d)
    for x, z in ((-2.8, 4.25), (-2.8, -3.5), (10.3, 2.4)):
        vent(x, z)
    for x, z, r in ((-13.2, 1.1, 0.72), (12.8, -0.1, 0.6), (-7.2, -3.9, 0.75), (-1.0, -5.0, 0.45)):
        coil((x, deck_y(x), z), r)
    # gas bottles in a rack, drums, a deck locker and a hose box
    y = deck_y(-3.2)
    for i in range(5):
        x = -3.9 + i * 0.36
        cyl((x, y, 1.0), (x, y + 1.15, 1.0), 0.15, "blue" if i < 2 else "red", seg=14, bevel=0.07)
        cyl((x, y + 1.14, 1.0), (x, y + 1.32, 1.0), 0.05, "chrome", seg=8)
    for h in (0.45, 0.9):
        tube([V(-4.12, y + h, 0.78), V(-2.24, y + h, 0.78), V(-2.24, y + h, 1.22), V(-4.12, y + h, 1.22)], 0.032, "iron", 6, True)
    for x, z, k in ((-13.5, -1.2, "blue"), (-13.5, -0.4, "yellow")):
        base = deck_y(x)
        cyl((x, base, z), (x, base + 0.95, z), 0.34, k, seg=20, bevel=0.03)
        for h in (0.3, 0.65):
            torus((x, base + h, z), (0, 1, 0), 0.345, 0.022, k, 22, 5)
        cyl((x + 0.15, base + 0.95, z), (x + 0.15, base + 0.99, z), 0.06, "chrome", seg=8)
    box((-7.3, deck_y(-7.3) + 0.45, 4.2), (1.7, 0.9, 0.85), "white", 0.09)
    box((-7.3, deck_y(-7.3) + 0.94, 4.2), (1.8, 0.1, 0.95), "red", 0.03)
    # fairleads and pipe runs along the after deck
    for side in (-1, 1):
        for x in (-13.8, -6.8, 8.4):
            p = skin(x, sheer(x) + 0.24, side, -0.1)
            torus(p, (1, 0, 0) if x < 5 else (1, 0, side * 0.2), 0.2, 0.08, "iron", 18, 8)
            box(p + V(0, -0.2, 0), (0.55, 0.14, 0.3), "iron", 0.04)
        run_ = [skin(x, deck_y(x) + 0.16, side, -0.78) for x in (-12.0 + i * 1.3 for i in range(8))]
        tube(run_, 0.065, "red" if side > 0 else "steel", 8)
        for p in run_[::2]:
            torus(p, (1, 0, 0), 0.085, 0.028, "iron", 12, 6)
        rail([tuple(skin(x, sheer(x) + 0.12, side, -0.1)) for x in (-4.5 + i * 2.0 for i in range(7))], 0.8, step=1.0, toe=False)


# ---------------------------------------------------------------------------
# Painting the textures
# ---------------------------------------------------------------------------
def lattice(ix, iy, iz, seed):
    h = ix * np.uint32(374761393) + iy * np.uint32(668265263) + iz * np.uint32(2147483629) + np.uint32(seed * 1013904223 % (2 ** 32))
    h = (h ^ (h >> np.uint32(13))) * np.uint32(1274126177)
    return ((h ^ (h >> np.uint32(16))) & np.uint32(0xFFFFFF)).astype(np.float32) / 16777215.0


def noise(p, sx, sy=None, sz=None, seed=0):
    """Smooth random values 0..1 at the points p (n x 3), cell size 1/scale."""
    q = p * np.array([sx, sx if sy is None else sy, sx if sz is None else sz], np.float32) + 117.0
    base = np.floor(q)
    f = q - base
    f = f * f * (3 - 2 * f)
    i = base.astype(np.uint32)
    one = np.uint32(1)
    out = np.zeros(len(p), np.float32)
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                out += w * lattice(i[:, 0] + (one * dx), i[:, 1] + (one * dy), i[:, 2] + (one * dz), seed)
    return out


def step(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def blend(colour, rgb, amount):
    colour += (np.asarray(rgb, np.float32) - colour) * amount[:, None]


def segments_distance(u, v, strokes):
    d = np.full(len(u), 9.0, np.float32)
    for line in strokes:
        for (ax, ay), (bx, by) in zip(line, line[1:]):
            dx, dy = bx - ax, by - ay
            t = np.clip(((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy), 0, 1)
            d = np.minimum(d, np.hypot(u - ax - t * dx, v - ay - t * dy))
    return d


LETTERS = {  # strokes in a box 0.6 wide, 1 high
    "S": [[(0.6, 0.84), (0.45, 1), (0.15, 1), (0, 0.84), (0, 0.66), (0.15, 0.53), (0.45, 0.47), (0.6, 0.34), (0.6, 0.16), (0.45, 0), (0.15, 0), (0, 0.16)]],
    "T": [[(0, 1), (0.6, 1)], [(0.3, 1), (0.3, 0)]],
    "E": [[(0.6, 1), (0, 1), (0, 0), (0.6, 0)], [(0, 0.5), (0.45, 0.5)]],
    "A": [[(0, 0), (0.3, 1), (0.6, 0)], [(0.12, 0.38), (0.48, 0.38)]],
    "D": [[(0, 0), (0, 1), (0.34, 1), (0.6, 0.74), (0.6, 0.26), (0.34, 0), (0, 0)]],
    "F": [[(0.6, 1), (0, 1), (0, 0)], [(0, 0.5), (0.45, 0.5)]],
    "1": [[(0.15, 0.75), (0.35, 1), (0.35, 0)]],
    "2": [[(0, 0.8), (0.15, 1), (0.45, 1), (0.6, 0.8), (0.55, 0.62), (0, 0), (0.6, 0)]],
    "3": [[(0, 1), (0.6, 1), (0.28, 0.6), (0.6, 0.35), (0.45, 0), (0, 0.05)]],
}


def word(text, x0, y0, height, advance=0.82):
    return [[(x0 + (i * advance + px) * height, y0 + py * height) for px, py in line] for i, ch in enumerate(text) for line in LETTERS[ch]]


def paint(kind, p, n, ao, edge, tug):
    """Colour, roughness, metalness and relief height for texels of the model."""
    count = len(p)
    base = np.array([k[1] for k in KINDS], np.float32)[kind]
    rough = np.array([k[2] for k in KINDS], np.float32)[kind]
    metal = np.array([k[3] for k in KINDS], np.float32)[kind]
    colour = base.copy()
    height = np.zeros(count, np.float32)
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    is_ = lambda *names: np.isin(kind, [K[m] for m in names])
    painted = is_("hull", "white", "trim", "red", "blue", "yellow", "iron", "steel", "soot", "paint", "orange", "antifoul", "foredeck")
    broad = noise(p, 0.55, seed=1)
    mid = noise(p, 2.3, seed=2)
    fine = noise(p, 11.0, seed=3)
    grain = noise(p, 38.0, seed=4)
    upright = 1 - np.abs(n[:, 1])

    # every painted surface ages unevenly
    shade = 1 + ((broad - 0.5) * 0.13 + (mid - 0.5) * 0.07) * np.where(is_("white"), 0.35, 1.0) + (grain - 0.5) * 0.05
    colour *= shade[:, None]
    rough += (mid - 0.5) * 0.14

    # ---- hull: plates, waterline, anti-fouling --------------------------------
    hull_ = is_("hull")
    if hull_.any():
        rows = np.array([-2.1, -0.9, 0.35, 1.65, 2.95, 4.25], np.float32)
        row = np.searchsorted(rows, y)
        near_row = np.min(np.abs(y[:, None] - rows[None, :]), axis=1)
        long_ = x + row * 1.37
        plate_no = np.floor(long_ / 3.3)
        near_col = np.abs(long_ - np.round(long_ / 3.3) * 3.3)
        seam = np.where(hull_, np.exp(-(np.minimum(near_row, near_col) / 0.022) ** 2), 0)
        tone = lattice(plate_no.astype(np.int64).astype(np.uint32), row.astype(np.uint32), (z > 0).astype(np.uint32), 9)
        colour *= np.where(hull_, 1 + (tone - 0.5) * 0.14, 1)[:, None]
        height += seam * 0.011 + np.where(hull_, (tone - 0.5) * 0.004 + (broad - 0.5) * 0.012, 0)
        blend(colour, (95, 40, 18), seam * step(0.45, 0.8, noise(p, 3.1, seed=11)) * 0.7)
        blend(colour, (255, 190, 150), np.where(hull_, np.exp(-((near_row - 0.045) / 0.018) ** 2), 0) * 0.18)
        under = hull_ * step(0.37, 0.33, y)
        blend(colour, (104, 31, 25), under)
        blend(colour, (52, 16, 13), under * step(0.5, 0.75, noise(p, 1.7, seed=12)) * 0.65)
        blend(colour, (160, 96, 74), under * step(0.58, 0.82, noise(p, 3.9, seed=13)) * 0.45)
        weed = under * step(-1.0, 0.3, y) * step(0.3, 0.7, noise(p, 4.5, 7.0, 4.5, seed=14))
        blend(colour, (62, 74, 30), weed * 0.8)
        barnacle = under * step(0.74, 0.86, noise(p, 14.0, seed=15)) * step(0.45, 0.65, noise(p, 1.4, seed=16))
        blend(colour, (170, 160, 135), barnacle * 0.45)
        height += barnacle * 0.014
        rough += under * 0.3
        boot = hull_ * step(0.31, 0.35, y) * step(0.82, 0.78, y)
        blend(colour, (19, 20, 22), boot)
        salt = hull_ * np.exp(-((y - 0.9 - (noise(p, 2.5, seed=17) - 0.5) * 0.45) / 0.14) ** 2) * step(0.35, 0.8, noise(p, 9.0, 3.0, 9.0, seed=18))
        blend(colour, (222, 214, 192), salt * 0.5)
        film = hull_ * step(2.0, 0.85, y) * step(0.78, 0.85, y)
        blend(colour, (62, 42, 24), film * (0.2 + 0.35 * noise(p, 6.0, 1.2, 6.0, seed=19)))
        # lettering: name, draught marks and load line, mirrored on the port side
        for side in (-1, 1):
            face = hull_ & (z * side > 0.5) & (n[:, 2] * side > 0.25)
            if not face.any():
                continue
            u = (x[face] if side > 0 else -x[face]).astype(np.float32)
            sheer_here = np.where(x[face] > 3, 3.8 + 1.5 * (np.clip(x[face] - 3, 0, None) / 12.5) ** 1.6, 3.3 + 0.5 * step(-5, 3, x[face]))
            name = word("STEADFAST", -6.6 if side > 0 else 1.2, 0.0, 0.48)
            mark = np.exp(-(segments_distance(u, y[face] - sheer_here + 0.64, name) / 0.036) ** 4)
            for i, digit in enumerate("123"):
                tick = word(digit + "2", 10.6 if side > 0 else -11.2, -0.25 + i * 0.5, 0.26)
                mark = np.maximum(mark, np.exp(-(segments_distance(u, y[face], tick) / 0.022) ** 4))
            lu = u - (-2.0 if side > 0 else 2.0)
            ring = np.abs(np.hypot(lu, y[face] - 1.68) - 0.24)
            load = np.minimum(ring, segments_distance(lu, y[face], [[(-0.42, 1.68), (0.42, 1.68)]]))
            mark = np.maximum(mark, np.exp(-(load / 0.024) ** 4))
            part = colour[face]
            blend(part, (236, 233, 222), mark * (0.75 + 0.25 * step(0.25, 0.5, fine[face])))
            colour[face] = part

    # ---- deck: non-slip grit, stains, wear and painted lines ------------------
    deck = is_("deck")
    if deck.any():
        d = deck.astype(np.float32)
        height += d * (noise(p, 26.0, seed=21) - 0.5) * 0.012
        blend(colour, (30, 27, 22), d * step(0.58, 0.8, noise(p, 0.9, seed=22)) * 0.6)
        blend(colour, (112, 68, 38), d * step(0.62, 0.85, noise(p, 1.9, seed=23)) * 0.55)
        blend(colour, (128, 130, 122), d * step(0.66, 0.86, noise(p, 3.4, seed=24)) * 0.35)
        blend(colour, (150, 150, 140), d * step(0.78, 0.92, grain) * 0.35)
        line = np.maximum(
            np.where((np.abs(x + 5.4) < 3.6) & (np.abs(np.abs(z) - 3.15) < 0.08), 1.0, 0),
            np.where((np.abs(z) < 3.2) & (np.abs(np.abs(x + 5.4) - 3.6) < 0.08), 1.0, 0))
        blend(colour, (200, 158, 34), d * line * step(0.25, 0.55, noise(p, 5.0, seed=25)) * 0.85)

    # ---- paint chips on edges, rust scabs and pitting -------------------------
    chip = painted * step(0.2, 0.6, edge) * step(0.62, 0.8, noise(p, 7.5, seed=31)) * WEAR[0]
    dark = is_("iron", "steel", "soot")
    blend(colour, (104, 52, 24), np.where(dark, 0, chip) * 0.9)
    blend(colour, (128, 112, 96), np.where(dark, chip, 0) * 0.75)
    blend(colour, (255, 255, 250), painted * step(0.2, 0.6, edge) * 0.07)
    rough += chip * 0.2
    height -= chip * 0.006
    damp = np.where(hull_, 0.55 + 0.45 * np.exp(-((y - 1.1) / 0.9) ** 2), 0.35 + 0.65 * (1 - ao))
    scab = painted * step(0.70, 0.83, noise(p, 2.1, seed=32) * 0.6 + noise(p, 8.0, seed=33) * 0.4) * damp * np.where(is_("white"), 0.45, 1.0) * np.where(is_("iron", "steel", "soot"), 0.3, 1.0) * WEAR[0]
    blend(colour, (110, 47, 15), scab * 0.9)
    blend(colour, (61, 26, 10), scab * step(0.5, 0.8, grain) * 0.8)
    rough += scab * 0.35
    height += scab * (grain - 0.5) * 0.012
    iron_rust = dark * step(0.55, 0.8, noise(p, 3.2, seed=34))
    blend(colour, (96, 55, 32), iron_rust * 0.22)

    # ---- runs of rust and dirt below fittings ---------------------------------
    order = np.argsort(x)
    sx_ = x[order]
    ragged = noise(p, 17.0, 1.6, 17.0, seed=35)
    flat = np.stack([n[:, 0], n[:, 2]], 1)
    flat /= np.maximum(np.linalg.norm(flat, axis=1), 1e-3)[:, None]
    for sx, sy, sz, length, width, strength, rgb in STREAKS:
        reach = 0.7 + width * 2
        i = order[np.searchsorted(sx_, sx - reach): np.searchsorted(sx_, sx + reach)]
        i = i[(y[i] < sy + 0.04) & (y[i] > sy - length) & (np.abs(z[i] - sz) < reach)]
        if not len(i):
            continue
        dx, dz = x[i] - sx, z[i] - sz
        across = np.abs(dx * -flat[i, 1] + dz * flat[i, 0])
        deep = np.abs(dx * flat[i, 0] + dz * flat[i, 1])
        fall = np.clip((sy - y[i]) / length, 0, 1)
        w = np.exp(-(across / (width * (1.15 - 0.6 * fall))) ** 2) * (1 - fall) ** 0.9
        w *= strength * (0.35 + 1.1 * ragged[i]) * step(0.25, 0.7, upright[i]) * (deep < 0.55) * painted[i] * np.where(kind[i] == K["white"], 0.7, 1.0)
        part = colour[i]
        blend(part, rgb, np.clip(w, 0, 0.95))
        colour[i] = part
        rough[i] += w * 0.2

    # ---- other materials ------------------------------------------------------
    rubber = is_("rubber")
    blend(colour, (92, 88, 82), rubber * step(0.55, 0.85, noise(p, 4.0, seed=41)) * 0.28)
    blend(colour, (120, 116, 108), rubber * step(0.1, 0.5, edge) * step(0.45, 0.7, fine) * 0.5)
    height += rubber * (fine - 0.5) * 0.006
    rope = is_("rope")
    twist = np.sin((x + y * 1.7 + z * 1.3) * 55.0)
    colour *= np.where(rope, 0.86 + 0.18 * twist, 1)[:, None]
    height += rope * twist * 0.008
    wood = is_("wood")
    if wood.any():
        long_grain = np.maximum(noise(p, 1.3, 16.0, 16.0, seed=44), 0) * 0.5 + noise(p, 16.0, 16.0, 1.3, seed=45) * 0.5
        colour *= np.where(wood, 0.72 + 0.56 * long_grain, 1)[:, None]
        blend(colour, (62, 44, 28), wood * step(0.6, 0.85, noise(p, 2.6, seed=46)) * 0.55)
        blend(colour, (150, 140, 120), wood * step(0.55, 0.8, noise(p, 0.9, seed=47)) * 0.4)
        height += wood * (long_grain - 0.5) * 0.02
    stone = is_("concrete")
    if stone.any():
        colour *= np.where(stone, 0.86 + 0.28 * noise(p, 14.0, seed=48), 1)[:, None]
        blend(colour, (70, 62, 50), stone * step(0.55, 0.85, noise(p, 1.4, seed=49)) * 0.5)
        blend(colour, (45, 42, 38), stone * step(0.74, 0.88, noise(p, 9.0, seed=50)) * 0.6)
        height += stone * (noise(p, 14.0, seed=48) - 0.5) * 0.025
    glass = is_("glass")
    if glass.any():
        sky = step(-1.0, 1.2, (y % 3.0) - 1.4 + (x * 0.35 - z * 0.25) % 1.1)
        blend(colour, (74, 104, 122), glass * sky * 0.4)
        blend(colour, (150, 150, 140), glass * step(0.7, 0.9, noise(p, 20.0, 5.0, 20.0, seed=42)) * 0.18)
        rough[glass] = 0.05 + 0.12 * fine[glass]
    soot_ = tug & painted & ~hull_ & (y > 9.0) & (np.abs(np.abs(z) - 3.4) < 1.2) & (x < 1.9)
    blend(colour, (22, 19, 17), soot_ * step(9.0, 12.5, y) * (0.4 + 0.5 * mid))

    # ---- shading painted in: dirt gathers where the light does not reach ------
    crevice = np.clip((1 - ao) * 1.5 - 0.18, 0, 1) * ~glass
    blend(colour, DIRT, crevice * (0.1 + 0.3 * mid) * painted * WEAR[0])
    colour *= (1 - 0.2 * (1 - ao) * ~glass)[:, None]
    settle = painted * step(0.75, 0.98, n[:, 1]) * step(0.48, 0.75, noise(p, 1.6, seed=43))
    blend(colour, (110, 100, 84), settle * 0.28 * WEAR[0])
    teak = is_("teak")
    if teak.any():  # narrow planks fore and aft, with dark seams
        seam = np.exp(-((np.abs((z / 0.32) % 1.0 - 0.5) - 0.5) / 0.07) ** 2)
        colour *= np.where(teak, 0.9 + 0.2 * noise(p, 0.7, 3.0, 3.2, seed=61), 1)[:, None]
        blend(colour, (78, 56, 36), teak * seam * 0.6)
    pool = is_("water")
    if pool.any():
        blend(colour, (130, 214, 236), pool * step(0.55, 0.85, noise(p, 2.2, seed=62)) * 0.55)
    return np.clip(colour, 0, 255), np.clip(rough, 0.04, 1), np.clip(metal, 0, 1), height


# ---------------------------------------------------------------------------
# Blender: mesh, texture unwrapping, baking, saving
# ---------------------------------------------------------------------------
def make_object():
    mesh = bpy.data.meshes.new("tug")
    mesh.from_pydata([(x, -z, y) for x, y, z in VERTS], [], FACES)
    mesh.update()
    for name, *_ in KINDS:
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        mesh.materials.append(m)
    mesh.polygons.foreach_set("material_index", np.array(FACE_KIND, np.int32))
    mesh.polygons.foreach_set("use_smooth", np.ones(len(mesh.polygons), bool))
    mesh.set_sharp_from_angle(angle=math.radians(38))
    obj = bpy.data.objects.new("tug", mesh)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    return obj


def unwrap(obj):
    obj.data.uv_layers.new(name="uv")
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0009, area_weight=0.0, margin_method="FRACTION")
    bpy.ops.object.mode_set(mode="OBJECT")


def setup_cycles():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for backend in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = backend
            prefs.get_devices()
            chosen = [d for d in prefs.devices if d.type == backend]
            if chosen:
                for d in prefs.devices:
                    d.use = d.type == backend
                scene.cycles.device = "GPU"
                print("baking on", chosen[0].name, backend)
                break
        except TypeError:
            continue
    scene.world = bpy.data.worlds.new("w")
    scene.world.light_settings.distance = 2.4


def bake(obj, what, size, samples, kind="EMIT"):
    image = bpy.data.images.new(what, size, size, alpha=True, float_buffer=True)
    image.colorspace_settings.name = "Non-Color"
    for index, mat in enumerate(obj.data.materials):
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        nodes.clear()
        out = nodes.new("ShaderNodeOutputMaterial")
        emit = nodes.new("ShaderNodeEmission")
        links.new(emit.outputs[0], out.inputs[0])
        geometry = nodes.new("ShaderNodeNewGeometry")

        def math3(op, a, b):
            m = nodes.new("ShaderNodeVectorMath")
            m.operation = op
            for socket, value in zip(m.inputs, (a, b)):
                if isinstance(value, tuple):
                    socket.default_value = value
                else:
                    links.new(value, socket)
            return m

        if what == "position":
            v = math3("MULTIPLY_ADD", geometry.outputs["Position"], (1 / POSITIONS[0],) * 3)
            v.inputs[2].default_value = (0.5, 0.5, 0.5)
            links.new(v.outputs[0], emit.inputs[0])
        elif what == "normal":
            v = math3("MULTIPLY_ADD", geometry.outputs["Normal"], (0.5,) * 3)
            v.inputs[2].default_value = (0.5, 0.5, 0.5)
            links.new(v.outputs[0], emit.inputs[0])
        elif what == "kind":
            emit.inputs[0].default_value = ((index + 1) / 32, 0, 0, 1)
        elif what == "edge":
            bevel = nodes.new("ShaderNodeBevel")
            bevel.samples = 8
            bevel.inputs["Radius"].default_value = 0.025
            dot = math3("DOT_PRODUCT", bevel.outputs[0], geometry.outputs["Normal"])
            sub = nodes.new("ShaderNodeMath")
            sub.operation = "SUBTRACT"
            sub.inputs[0].default_value = 1.0
            links.new(dot.outputs["Value"], sub.inputs[1])
            times = nodes.new("ShaderNodeMath")
            times.operation = "MULTIPLY"
            times.inputs[1].default_value = 6.0
            links.new(sub.outputs[0], times.inputs[0])
            links.new(times.outputs[0], emit.inputs[0])
        target = nodes.new("ShaderNodeTexImage")
        target.image = image
        nodes.active = target
    bpy.context.scene.cycles.samples = samples
    bpy.ops.object.bake(type=kind, margin=max(2, size // 1024), use_clear=True)
    pixels = np.empty(size * size * 4, np.float32)
    image.pixels.foreach_get(pixels)
    bpy.data.images.remove(image)
    print("baked", what)
    return pixels.reshape(size, size, 4)


def save_jpg(name, rgb, quality):
    h, w, _ = rgb.shape
    image = bpy.data.images.new(name, w, h, alpha=True)
    rgba = np.ones((h, w, 4), np.float32)
    rgba[:, :, :3] = rgb.astype(np.float32) / 255.0
    image.pixels.foreach_set(rgba.ravel())
    image.file_format = "JPEG"
    image.save(filepath=str(OUT / f"{name}.jpg"), quality=quality)
    bpy.data.images.remove(image)


def spread(image, filled, times):
    """Copies colours outwards from the filled texels into the empty ones."""
    filled = filled.copy()
    for _ in range(times):
        for axis, shift in ((0, 1), (0, -1), (1, 1), (1, -1)):
            near = np.roll(filled, shift, axis) & ~filled
            image[near] = np.roll(image, shift, axis)[near]
            filled |= near
    image[~filled] = image[filled].mean(0)


def textures(obj, name, size, tug, glow=False):
    kinds = np.rint(bake(obj, "kind", size, 1)[:, :, 0] * 32).astype(np.int16) - 1
    position = ((bake(obj, "position", size, 1)[:, :, :3] - 0.5) * POSITIONS[0]).astype(np.float16)
    normal = (bake(obj, "normal", size, 1)[:, :, :3] * 2 - 1).astype(np.float16)
    edge = np.clip(bake(obj, "edge", size // 2, 4 if QUICK else 16)[:, :, 0], 0, 1).astype(np.float16)
    ao = np.clip(bake(obj, "ao", size // 2, 16 if QUICK else 96, "AO")[:, :, 0], 0, 1).astype(np.float16)
    print("texture coverage %.0f%%" % (100 * np.mean(kinds >= 0)))
    colour = np.zeros((size, size, 3), np.uint8)
    orm = np.zeros((size, size, 3), np.uint8)
    relief = np.zeros((size, size), np.float32)
    lights = np.zeros((size, size, 3), np.uint8)
    rows = 256
    for top in range(0, size, rows):
        r, c = np.nonzero(kinds[top: top + rows] >= 0)
        if not len(r):
            continue
        r = r + top
        # blocks and normals came out in Blender's axes (z up): back to the game's
        p = position[r, c].astype(np.float32)[:, [0, 2, 1]] * np.array([1, 1, -1], np.float32)
        n = normal[r, c].astype(np.float32)[:, [0, 2, 1]] * np.array([1, 1, -1], np.float32)
        a = ao[r // 2, c // 2].astype(np.float32)
        col, rough, metal, h = paint(kinds[r, c], p, n, a, edge[r // 2, c // 2].astype(np.float32), tug)
        colour[r, c] = col.astype(np.uint8)
        orm[r, c] = np.stack([a, rough, metal], 1) * 255
        relief[r, c] = h
        if glow:
            window = kinds[r, c] == K["cabin"]
            wr, wc, q = r[window], c[window], p[window]
            if len(wr):
                # some cabins are lit, each in its own warm or cool white
                cell = (np.floor((q[:, 0] + 200) / 0.8).astype(np.uint32), np.floor((q[:, 1] + 200) / 1.0).astype(np.uint32), (q[:, 2] > 0).astype(np.uint32))
                on = lattice(*cell, 71) > 0.44
                tone = np.array([(255, 213, 138), (255, 231, 176), (255, 196, 107), (255, 220, 160), (188, 215, 255)], np.float32)[(lattice(*cell, 72) * 4.99).astype(int)]
                lights[wr, wc] = (tone * (on * (0.6 + 0.4 * lattice(*cell, 73)))[:, None]).astype(np.uint8)
        print("painted rows", top)
    filled = kinds >= 0
    spread(colour, filled, 6)
    spread(orm, filled, 6)
    save_jpg(name + "_color", colour, 90)
    half = orm.reshape(size // 2, 2, size // 2, 2, 3)[:, 0, :, 0, :]
    save_jpg(name + "_orm", half, 90)
    h = relief[::2, ::2]
    k = kinds[::2, ::2]
    area = sum(face.area for face in obj.data.polygons)
    texel = math.sqrt(area / max(1, np.count_nonzero(k >= 0)))  # model units to a texel
    print("texels per model unit %.0f" % (2 / texel))
    du = np.zeros_like(h)
    dv = np.zeros_like(h)
    same_u = (k[:, 2:] == k[:, :-2]) & (k[:, 1:-1] >= 0)
    same_v = (k[2:, :] == k[:-2, :]) & (k[1:-1, :] >= 0)
    du[:, 1:-1] = np.where(same_u, (h[:, 2:] - h[:, :-2]) / (2 * texel), 0)
    dv[1:-1, :] = np.where(same_v, (h[2:, :] - h[:-2, :]) / (2 * texel), 0)
    vector = np.stack([-np.clip(du, -1.2, 1.2), -np.clip(dv, -1.2, 1.2), np.ones_like(h)], 2)
    vector /= np.linalg.norm(vector, axis=2)[:, :, None]
    save_jpg(name + "_normal", ((vector * 0.5 + 0.5) * 255).astype(np.uint8), 92)
    if glow:
        spread(lights, kinds >= 0, 3)
        save_jpg(name + "_glow", lights.reshape(size // 2, 2, size // 2, 2, 3).max(axis=(1, 3)), 88)


def export(obj, name, offsets):
    """'TUG2' and the number of parts; then for each part its vertex and index
    counts, positions (float32), normals (int16), texture coordinates (uint16),
    padding to 4 bytes and indices (uint32)."""
    mesh = obj.data
    mesh.calc_loop_triangles()
    loops = np.empty(len(mesh.loop_triangles) * 3, np.int32)
    mesh.loop_triangles.foreach_get("loops", loops)
    vertex_of = np.empty(len(mesh.loops), np.int32)
    mesh.loops.foreach_get("vertex_index", vertex_of)
    co = np.empty(len(mesh.vertices) * 3, np.float32)
    mesh.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    nrm = np.empty(len(mesh.loops) * 3, np.float32)
    mesh.corner_normals.foreach_get("vector", nrm)
    nrm = nrm.reshape(-1, 3)
    uv = np.empty(len(mesh.loops) * 2, np.float32)
    mesh.uv_layers.active.uv.foreach_get("vector", uv)
    uv = uv.reshape(-1, 2)
    back = lambda a: a[:, [0, 2, 1]] * np.array([1, 1, -1], np.float32)
    corners = np.zeros(len(loops), dtype=[("p", "<f4", 3), ("n", "<i2", 3), ("t", "<u2", 2)])
    corners["p"] = back(co[vertex_of[loops]])
    corners["n"] = np.rint(back(nrm[loops]) * 32767)
    corners["t"] = np.rint(np.clip(uv[loops], 0, 1) * 65535)
    of_face = np.empty(len(mesh.loop_triangles), np.int32)
    mesh.loop_triangles.foreach_get("polygon_index", of_face)
    part_of = np.repeat(np.array(FACE_GROUP, np.int32)[of_face], 3)
    data = b"TUG2" + struct.pack("<I", len(GROUPS))
    for number, part in enumerate(GROUPS):
        unique, index = np.unique(corners[part_of == number], return_inverse=True)
        unique["p"][:, 0] -= offsets[number]  # back about its own origin
        data += struct.pack("<II", len(unique), len(index))
        data += np.ascontiguousarray(unique["p"]).tobytes() + np.ascontiguousarray(unique["n"]).tobytes() + np.ascontiguousarray(unique["t"]).tobytes()
        data += b"\0" * (-len(data) % 4) + index.astype("<u4").tobytes()
        print("part", part, "triangles", len(index) // 3, "highest point %.2f" % unique["p"][:, 1].max() if len(unique) else 0)
    (OUT / f"{name}.bin").write_bytes(data)
    print("triangles", len(loops) // 3, "bytes", len(data))


def main():
    np.seterr(over="ignore")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    OUT.mkdir(parents=True, exist_ok=True)
    global group
    for part, where in ((hull, "low"), (fenders, "low"), (deckhouse, "low"), (wheelhouse, "top"), (mast, "top"),
                        (stacks, "low"), (crane, "crane"), (deck_gear, "low")):
        group = where
        part()
        print(part.__name__, "faces so far", len(FACES))
    obj = make_object()
    unwrap(obj)
    print("unwrapped")
    setup_cycles()
    textures(obj, "tug", SIZE, tug=True)
    export(obj, "tug", [0.0] * len(GROUPS))


if __name__ == "__main__":
    main()
