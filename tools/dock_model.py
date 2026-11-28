"""Builds the dockyard's modelled surroundings: gantry crane, quay and repair
props, and the concrete of the ground and walls.

Run:  blender -b --factory-startup -P tools/dock_model.py

Writes assets/models/crane.bin, props.bin (+ their pictures) and
concrete_color/orm/normal.jpg, which render3d.js loads. Coordinates and sizes
match the plain versions in render3d.js, so everything stands where it did.
The shapes and painting come from tug_model.py.
"""
import math
import sys
from pathlib import Path

import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tug_model as t
from tug_model import V, bar, beam, bolts, box, cyl, rail, streak, torus, tube

# ---------------------------------------------------------------------------
# Gantry crane (see makePortalCrane): legs on bogies, box girder, cab, trolley
# ---------------------------------------------------------------------------
H, SZ, BASE = 58.0, 28.0, 6.0


def crane_frame():
    levels = [k * H for k in (0, 0.18, 0.4, 0.62, 0.84, 1)]
    for s in (-1, 1):
        for x in (-BASE, BASE):
            box((x, H / 2, s * SZ), (1.5, H, 1.5), "yellow", 0.14)
            for y in levels[1:-1]:
                box((x, y, s * SZ), (1.72, 0.5, 1.72), "yellow", 0.05)
                streak((x, y - 0.3, s * SZ + s * 0.78), t.rng.uniform(1.5, 5), 0.28, 0.6)
                streak((x + 0.78 * (1 if x > 0 else -1), y - 0.3, s * SZ), t.rng.uniform(1.5, 5), 0.28, 0.6)
        for i in range(5):
            y0, y1 = levels[i], levels[i + 1]
            flip = 1 if i % 2 else -1
            box((0, y1, s * SZ), (BASE * 2, 0.8, 0.8), "yellow", 0.08)
            a, b = V(flip * BASE, y0, s * SZ), V(-flip * BASE, y1, s * SZ)
            tube([a, b], 0.28, "yellow", 10)
            mid = a.lerp(b, 0.5)
            bar(mid, (-flip * BASE, y0 + (y1 - y0) * 0.5, s * SZ), 0.14, "yellow", 8)
            for p, side in ((a, flip), (b, -flip)):
                plate_at = p + V(-side * 0.9, 0.75 if p is a else -0.75, 0)
                box((plate_at.x, plate_at.y, s * SZ), (1.4, 1.2, 0.2), "yellow", 0.03)
                for dx in (-0.45, 0.45):
                    for dy in (-0.35, 0.35):
                        cyl((plate_at.x + dx, plate_at.y + dy, s * SZ + 0.1), (plate_at.x + dx, plate_at.y + dy, s * SZ + 0.18), 0.09, "steel", seg=6)
                streak((plate_at.x, plate_at.y - 0.6, s * SZ + 0.15), 2.0, 0.3, 0.55)
        # sill beam, bogies and wheels
        box((0, 1.75, s * SZ), (BASE * 2 + 3, 1.1, 2.1), "iron", 0.18)
        for x in (-BASE, BASE):
            box((x, 1.05, s * SZ), (4.4, 0.8, 1.5), "iron", 0.2)
            box((x, 2.55, s * SZ + s * 1.15), (1.3, 1.0, 0.7), "yellow", 0.18)
            for dx in (-1.2, 1.2):
                cyl((x + dx, 0.9, s * SZ - 0.36), (x + dx, 0.9, s * SZ + 0.36), 0.9, "steel", seg=28, bevel=0.07)
                for dz in (-0.42, 0.42):
                    cyl((x + dx, 0.9, s * SZ + dz - 0.06), (x + dx, 0.9, s * SZ + dz + 0.06), 1.0, "iron", seg=28, bevel=0.02)
                cyl((x + dx, 0.9, s * SZ - 0.9), (x + dx, 0.9, s * SZ + 0.9), 0.22, "iron", seg=12)
                bolts((x + dx, 0.9, s * SZ + s * 0.9), 0.15, 6, (0, 0, s), 0.05)
        for end in (-1, 1):
            x = end * (BASE + 1.9)
            for k in range(6):  # warning stripes on the buffer beam
                box((x, 1.75, s * SZ - 0.88 + k * 0.35), (0.16, 1.0, 0.18), "yellow" if k % 2 else "rubber", 0.02)
            cyl((x, 1.75, s * SZ), (x + end * 0.55, 1.75, s * SZ), 0.34, "rubber", seg=16, bevel=0.1)
        # ladder with safety hoops up one leg
        t.ladder((-BASE - 1.05, 2.6, s * SZ), (-BASE - 1.05, H - 0.4, s * SZ), (0, 0, 1), 0.7, 0.55, "steel")
        for y in np.arange(5.0, H - 1.0, 1.9):
            tube([V(-BASE - 1.05 - 0.75 * math.sin(a), float(y), s * SZ + 0.55 * math.cos(a)) for a in (math.pi * k / 10 for k in range(11))], 0.05, "yellow", 6)
        for y in levels[1:-1]:  # rest platforms
            box((-BASE - 1.5, y + 0.5, s * SZ), (1.6, 0.14, 2.0), "steel", 0.03)
            rail([(-BASE - 0.8, y + 0.57, s * SZ + 1.0), (-BASE - 2.3, y + 0.57, s * SZ + 1.0), (-BASE - 2.3, y + 0.57, s * SZ - 1.0), (-BASE - 0.8, y + 0.57, s * SZ - 1.0)], 1.1, "yellow", 1.0)
    # the girder, with its stiffeners, walkways and cable runs
    length = SZ * 2 + 10
    box((0, H + 2.1, 0), (6.6, 4.2, length), "yellow", 0.25)
    for i in range(-14, 15):
        for side in (-1, 1):
            box((side * 3.4, H + 2.1, i * 2.2), (0.22, 3.7, 0.3), "yellow", 0.04)
            streak((side * 3.5, H + 0.35, i * 2.2 + 0.5), t.rng.uniform(0.2, 0.8), 0.15, 0.5)
            streak((side * 3.35, H + t.rng.uniform(2.5, 4.1), i * 2.2 + t.rng.uniform(0.3, 1.9)), t.rng.uniform(1.0, 3.0), 0.12, 0.55)
    for y in (H + 0.15, H + 4.05):
        for side in (-1, 1):
            box((side * 3.42, y, 0), (0.28, 0.3, length), "yellow", 0.05)
    for side in (-1, 1):
        box((side * 4.25, H + 4.25, 0), (1.5, 0.12, length), "steel", 0.03)
        rail([(side * 4.95, H + 4.3, -length / 2), (side * 4.95, H + 4.3, length / 2)], 1.15, "yellow", 2.2)
        for i in range(-15, 16, 2):
            beam((side * 3.4, H + 3.1, i * 2.1), (side * 4.9, H + 4.15, i * 2.1), 0.14, 0.14, "yellow", 0.02)
        tube([V(side * 3.7, H + 3.6, -length / 2 + 1), V(side * 3.7, H + 3.6, length / 2 - 1)], 0.12, "rubber", 8)
    for z in (-length / 2, length / 2):
        for side in (-1, 1):
            cyl((side * 2.2, H + 4.6, z), (side * 2.2, H + 4.6, z + math.copysign(0.6, -z)), 0.35, "rubber", seg=14, bevel=0.08)
    # machinery house
    c = V(0, H + 5.8, SZ + 3)
    box(c, (5.2, 3.0, 5.2), "white", 0.18)
    box(c + V(0, 1.6, 0), (5.6, 0.25, 5.6), "iron", 0.08)
    box(c + V(0, 2.0, 0), (2.4, 0.6, 2.4), "steel", 0.14)
    for x, z in ((-1.5, -1.5), (1.6, 1.4)):
        cyl(c + V(x, 1.7, z), c + V(x, 2.5, z), 0.3, "steel", seg=14)
        cyl(c + V(x, 2.5, z), c + V(x, 2.75, z), 0.5, "iron", seg=18, bevel=0.06)
    for side in (-1, 1):
        t.louvre((side * 2.6, c.y, c.z - 0.9), (side, 0, 0), 1.8, 1.6)
        t.door((side * 2.6, c.y - 0.25, c.z + 1.4), (side, 0, 0), 1.0, 2.1)
    t.louvre((0, c.y, c.z - 2.6), (0, 0, -1), 2.2, 1.5)
    # driver's cab under the girder
    cab = V(0, H - 2.2, -12)
    box(cab, (3.2, 3.0, 3.2), "white", 0.2)
    for normal, w in (((1, 0, 0), 2.7), ((-1, 0, 0), 2.7), ((0, 0, 1), 2.7), ((0, 0, -1), 2.7)):
        t.window((cab.x + normal[0] * 1.6, cab.y + 0.25, cab.z + normal[2] * 1.6), normal, w, 1.5, 0.15, "iron")
    box(cab + V(0, -1.65, 0), (3.9, 0.15, 3.9), "steel", 0.04)
    rail([(1.9, cab.y - 1.6, -14), (1.9, cab.y - 1.6, -10), (-1.9, cab.y - 1.6, -10), (-1.9, cab.y - 1.6, -14)], 0.95, "yellow", 1.3, False)
    for x in (-0.9, 0.9):
        box((x, H - 0.45, -12), (0.35, 0.9, 0.35), "iron", 0.06)
    for x, z in ((-3.4, -SZ - 3), (3.4, -SZ - 3), (-3.4, SZ + 3), (3.4, SZ + 3)):
        cyl((x, H + 4.2, z), (x, H + 4.6, z), 0.18, "iron", seg=10)
    for z in (-20, 0, 20):
        for side in (-1, 1):
            t.lamp((side * 3.4, H + 0.4, z), (side, -0.4, 0))


def crane_trolley():
    box((0, H - 1.1, 0), (5.0, 1.0, 5.0), "iron", 0.2)
    box((0, H - 2.5, 0), (3.5, 1.2, 3.5), "yellow", 0.25)
    for x in (-1.9, 1.9):
        for z in (-2.7, 2.7):
            cyl((x, H - 0.55, z - 0.2), (x, H - 0.55, z + 0.2), 0.5, "steel", seg=18, bevel=0.05)
        box((x, H - 1.75, 0), (0.9, 0.6, 3.6), "yellow", 0.15)
    for x in (-0.8, 0.8):
        cyl((x, H - 3.25, -0.5), (x, H - 3.25, 0.5), 0.55, "steel", seg=20, bevel=0.06)
    cyl((-1.9, H - 1.6, 1.3), (-1.9, H - 1.6, 2.3), 0.55, "blue", seg=16, bevel=0.1)
    bolts((0, H - 1.88, 0), 1.3, 12, (0, -1, 0), 0.1)


def crane_hook():
    box((0, 0, 0), (1.6, 2.0, 1.3), "yellow", 0.4)
    for z in (-0.7, 0.7):
        cyl((0, 0.25, z - 0.08), (0, 0.25, z + 0.08), 0.7, "iron", seg=22, bevel=0.03)
        bolts((0, 0.25, z * 1.14), 0.45, 6, (0, 0, z), 0.08)
    box((0, -0.55, 0), (1.66, 0.14, 1.36), "rubber", 0.02)
    cyl((0, -1.0, 0), (0, -1.45, 0), 0.22, "steel", seg=12, bevel=0.04)
    tube(t.smooth_path([(0, -1.35, 0), (0, -1.75, 0), (0.55, -2.0, 0), (0.45, -2.5, 0), (-0.15, -2.55, 0), (-0.55, -2.15, 0), (-0.45, -1.9, 0)], 6), 0.17, "iron", 10)


def crane_load():
    for x in (-5.0, 5.0):
        tube([V(0, -1.2, 0), V(x, -4.4, 0)], 0.08, "steel", 8)
        torus((x, -4.4, 0), (0, 0, 1), 0.22, 0.07, "iron", 14, 8)
    box((0, -4.65, 0), (12.0, 0.5, 0.6), "yellow", 0.12)
    c = V(0, -6.6, 0)
    box(c, (9.8, 3.1, 4.7), "blue", 0.05)
    for sx in (-1, 1):
        for sz in (-1, 1):
            box(c + V(sx * 4.92, 0, sz * 2.37), (0.24, 3.4, 0.24), "blue", 0.04)
            for sy in (-1, 1):
                box(c + V(sx * 4.92, sy * 1.6, sz * 2.37), (0.42, 0.34, 0.42), "iron", 0.05)
    for sy in (-1, 1):
        for sz in (-1, 1):
            box(c + V(0, sy * 1.62, sz * 2.37), (10.0, 0.18, 0.18), "blue", 0.03)
        for sx in (-1, 1):
            box(c + V(sx * 4.92, sy * 1.62, 0), (0.18, 0.18, 4.9), "blue", 0.03)
    for i in range(24):  # corrugations
        x = -4.55 + i * 0.395
        for sz in (-1, 1):
            box(c + V(x, 0, sz * 2.4), (0.19, 2.9, 0.1), "blue", 0.035)
            streak((x, c.y + 1.5, sz * 2.45), t.rng.uniform(0.2, 1.6), 0.08, t.rng.uniform(0.15, 0.6))
    for z in (-1.6, -0.55, 0.55, 1.6):  # doors with their locking bars
        bar(c + V(4.99, -1.45, z), c + V(4.99, 1.45, z), 0.055, "steel", 8)
        box(c + V(5.02, -0.35, z + 0.18), (0.08, 0.1, 0.45), "steel", 0.02)


# ---------------------------------------------------------------------------
# Quay and repair props (each about its own origin)
# ---------------------------------------------------------------------------
def bollard():
    cyl((0, 0, 0), (0, 0.1, 0), 0.58, "iron", seg=24, bevel=0.025)
    bolts((0, 0.1, 0), 0.47, 8, size=0.055)
    cyl((0, 0.08, 0), (0, 0.62, 0), 0.34, "iron", 0.27, 24)
    cyl((0, 0.58, 0), (0, 0.8, 0), 0.3, "iron", 0.44, 24)
    t.ellipsoid((0, 0.8, 0), (0.44, 0.24, 0.44), "iron", 24, 8, 0.0)
    for k in (-1, 1):
        cyl((k * 0.22, 0.68, 0), (k * 0.62, 0.74, 0), 0.14, "iron", seg=14, bevel=0.05)
    torus((0, 0.3, 0), (0, 1, 0), 0.315, 0.025, "yellow", 28, 8)


def crate():
    box((0, 0, 0), (0.92, 0.92, 0.92), "wood", 0.015)
    for axis in range(3):
        for side in (-1, 1):
            def at(u, v):
                p = [0.0, 0.0, 0.0]
                p[axis], p[(axis + 1) % 3], p[(axis + 2) % 3] = side * 0.475, u, v
                return V(*p)

            def board(a, b, width):
                size = [0.0, 0.0, 0.0]
                size[axis] = 0.05
                along = 1 if abs(b[0] - a[0]) > 0 else 2
                size[(axis + 1) % 3] = abs(b[0] - a[0]) if along == 1 else width
                size[(axis + 2) % 3] = abs(b[1] - a[1]) if along == 2 else width
                box(at((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), tuple(size), "wood", 0.012)

            for v in (-0.43, 0.43):
                board((-0.5, v), (0.5, v), 0.14)
                board((v, -0.36), (v, 0.36), 0.14)
            beam(at(-0.34, -0.34) * 1.0, at(0.34, 0.34), 0.11, 0.05, "wood", 0.01)
            for u in (-0.43, 0.43):
                for v in (-0.43, 0.43):
                    p = at(u, v)
                    out = V(*[side if i == axis else 0 for i in range(3)])
                    cyl(p + out * 0.02, p + out * 0.035, 0.018, "iron", seg=6)


def bottle():  # height 1.1 about its middle; white, so the game can colour it
    cyl((0, -0.55, 0), (0, 0.3, 0), 0.16, "white", seg=20, bevel=0.04)
    t.ellipsoid((0, 0.3, 0), (0.16, 0.14, 0.16), "white", 20, 8, 0.0)
    cyl((0, 0.42, 0), (0, 0.5, 0), 0.05, "chrome", seg=10)
    torus((0, 0.5, 0), (0, 1, 0), 0.07, 0.016, "iron", 16, 6)
    for y in (-0.48, 0.02):
        torus((0, y, 0), (0, 1, 0), 0.163, 0.012, "steel", 24, 5)


def barrier():  # 2.4 long, 0.8 high, 0.3 thick; white, coloured by the game
    profile = [(-0.4, -0.2), (-0.27, -0.2), (-0.1, -0.08), (0.4, -0.065), (0.4, 0.065), (-0.1, 0.08), (-0.27, 0.2), (-0.4, 0.2)]
    t.loft([[V(x, y, z) for y, z in profile] for x in (-1.18, 1.18)], "white", bevel=0.02)
    for x in (-0.7, 0.7):
        for z in (-0.19, 0.19):
            box((x, -0.34, z), (0.3, 0.08, 0.05), "rubber", 0.01)
    for x in (-1.19, 1.19):
        torus((x, 0.12, 0), (0, 0, 1), 0.07, 0.018, "iron", 14, 6)


def cone():  # height 0.6 about its middle
    box((0, -0.275, 0), (0.46, 0.05, 0.46), "rubber", 0.02)
    cyl((0, -0.26, 0), (0, -0.05, 0), 0.17, "trim", 0.12, 20, caps=False)
    cyl((0, -0.05, 0), (0, 0.08, 0), 0.12, "white", 0.085, 20, caps=False)
    cyl((0, 0.08, 0), (0, 0.3, 0), 0.085, "trim", 0.022, 20)


def block():  # keel block: 2.2 x 1 x 1.8, standing on the dock floor (the game stretches it)
    box((0, 0.5, 0), (2.2, 1.0, 1.8), "concrete", 0.08)
    for x in (-0.72, 0.72):
        for z in (-0.905, 0.905):
            box((x, 0.5, z), (0.28, 0.8, 0.04), "iron", 0.01)


def cap():  # the timber on a keel block: 2.5 x 0.4 x 2.1
    for i in range(4):
        z = -0.79 + i * 0.527
        box((t.rng.uniform(-0.04, 0.04), -0.1, z), (2.5, 0.19, 0.5), "wood", 0.025)
    for i in range(3):
        x = -0.86 + i * 0.86
        box((x, 0.1, t.rng.uniform(-0.04, 0.04)), (0.7, 0.2, 2.1), "wood", 0.025)
        for z in (-0.8, 0.8):
            cyl((x, 0.19, z), (x, 0.215, z), 0.045, "iron", seg=8)


def shore():  # a timber prop one unit long along y, radius 0.24 (the game stretches it)
    cyl((0, 0, 0), (0, 1, 0), 0.24, "wood", 0.22, 16)
    for y in (0.035, 0.965):
        cyl((0, y - 0.02, 0), (0, y + 0.02, 0), 0.262, "iron", seg=18, caps=False)


def scaffold():
    """One bay: standards from a lift below up to this deck (y = 0), the planks,
    ledgers, bracing, guard rails, toe board and couplers. 3.5 wide, 2 deep."""
    for z in (0.0, -2.0):
        cyl((0, -3.2, z), (0, 1.2, z), 0.065, "steel", seg=10)
        cyl((0, -3.2, z), (0, -3.14, z), 0.19, "iron", seg=14)
        for y in (-3.0, -0.12, 0.55, 1.1):
            cyl((0, y - 0.08, z), (0, y + 0.08, z), 0.095, "iron", seg=10, bevel=0.02)
    for i in range(5):
        z = -0.1 - i * 0.45
        box((t.rng.uniform(-0.03, 0.03), 0.0, z - 0.1), (3.48, 0.09, 0.41), "wood", 0.015)
        for x in (-1.65, 1.65):
            box((x, 0.0, z - 0.1), (0.07, 0.11, 0.42), "steel", 0.008)
    for z in (0.0, -2.0):
        bar((-1.75, -0.12, z), (1.75, -0.12, z), 0.05, "steel", 8)
    for x in (-1.2, 0.0, 1.2):
        bar((x, -0.12, 0.0), (x, -0.12, -2.0), 0.045, "steel", 8)
    for y in (0.55, 1.1):
        bar((-1.75, y, -2.1), (1.75, y, -2.1), 0.045, "yellow", 8)
    box((0, 0.13, -2.08), (3.5, 0.17, 0.05), "wood", 0.012)
    bar((0, -3.0, -2.06), (1.75, -0.2, -2.06), 0.04, "steel", 7)
    bar((0, -3.0, -2.06), (-1.75, -0.2, -2.06), 0.04, "steel", 7)


# the order the game expects (render3d.js loadDockModels)
CRANE = (crane_frame, crane_trolley, crane_hook, crane_load)
PROPS = (bollard, crate, bottle, barrier, cone, block, cap, shore, scaffold)


def build(name, makers, size):
    """Builds the parts well apart (so none shades another), bakes and paints one
    set of pictures for them all, and writes each about its own origin."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for items in (t.VERTS, t.FACES, t.FACE_KIND, t.FACE_GROUP, t.STREAKS):
        items.clear()
    t.GROUPS = tuple(f.__name__ for f in makers)
    for i, make in enumerate(makers):
        t.OFFSET[0] = i * 160.0
        t.group = make.__name__
        make()
    obj = t.make_object()
    t.unwrap(obj)
    t.setup_cycles()
    t.textures(obj, name, size, tug=False)
    t.export(obj, name, [i * 160.0 for i in range(len(makers))])


# ---------------------------------------------------------------------------
# Concrete: a picture that repeats edge to edge, two slabs by two
# ---------------------------------------------------------------------------
def wrap_noise(u, v, cells, seed):
    x, y = u * cells, v * cells
    i, j = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    fx, fy = x - i, y - j
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    value = lambda a, b: t.lattice((a % cells).astype(np.uint32), (b % cells).astype(np.uint32), np.zeros(a.shape, np.uint32), seed)
    low = value(i, j) * (1 - fx) + value(i + 1, j) * fx
    high = value(i, j + 1) * (1 - fx) + value(i + 1, j + 1) * fx
    return (low * (1 - fy) + high * fy).astype(np.float32)


def concrete(size=2048):
    rng = np.random.default_rng(5)
    v, u = np.mgrid[0:size, 0:size].astype(np.float32) / size
    colour = np.empty((size, size, 3), np.float32)
    colour[:] = (150, 147, 138)
    height = np.zeros((size, size), np.float32)
    rough = np.full((size, size), 0.9, np.float32)

    def mix(rgb, amount):
        colour[:] += (np.array(rgb, np.float32) - colour) * amount[:, :, None]

    broad = wrap_noise(u, v, 5, 1)
    mid = wrap_noise(u, v, 17, 2)
    fine = wrap_noise(u, v, 160, 3)
    grain = wrap_noise(u, v, 620, 4)
    # each slab was poured on its own day
    slab = t.lattice((u >= 0.5).astype(np.uint32), (v >= 0.5).astype(np.uint32), np.zeros(u.shape, np.uint32), 8)
    colour *= (1 + (slab - 0.5) * 0.1 + (broad - 0.5) * 0.11 + (mid - 0.5) * 0.07 + (fine - 0.5) * 0.09 + (grain - 0.5) * 0.14)[:, :, None]
    height += (fine - 0.5) * 0.35 + (grain - 0.5) * 0.25
    stones = t.step(0.72, 0.86, wrap_noise(u, v, 260, 5))
    mix((192, 186, 170), stones * 0.28)
    pits = t.step(0.79, 0.9, wrap_noise(u, v, 340, 6))
    mix((52, 48, 42), pits * 0.42)
    height -= pits * 1.1
    stain = t.step(0.55, 0.85, wrap_noise(u, v, 7, 9) * 0.7 + mid * 0.3)
    mix((74, 68, 58), stain * 0.26)
    oil = t.step(0.74, 0.9, wrap_noise(u, v, 11, 10) * 0.75 + fine * 0.25)
    mix((34, 31, 27), oil * 0.42)
    rough -= oil * 0.35 + stain * 0.1
    rusty = t.step(0.7, 0.88, wrap_noise(u, v, 9, 11) * 0.65 + fine * 0.35)
    mix((128, 82, 48), rusty * 0.2)
    damp = t.step(0.6, 0.85, wrap_noise(u, v, 4, 12))
    mix((100, 102, 96), damp * 0.25)

    def stroke(x, y, dark, deep, wide):
        xi, yi = int(x) % size, int(y) % size
        for dx in range(wide):
            colour[yi, (xi + dx) % size] *= dark
            height[yi, (xi + dx) % size] -= deep

    for _ in range(16):  # hairline cracks
        x, y = rng.uniform(0, size, 2)
        heading = rng.uniform(0, 2 * math.pi)
        for _ in range(int(rng.uniform(150, 800))):
            heading += rng.normal(0, 0.28)
            x, y = x + math.cos(heading), y + math.sin(heading)
            stroke(x, y, 0.62, 0.9, 2)
    # the joints between slabs, with their chamfered and chipped edges
    off = np.minimum(np.abs(u - np.round(u * 2) / 2), np.abs(v - np.round(v * 2) / 2)) * size
    ragged = off + (wrap_noise(u, v, 90, 13) - 0.5) * 7
    gap = t.step(5.0, 2.5, ragged)
    edge = t.step(15.0, 4.0, ragged)
    mix((120, 114, 102), edge * 0.35)
    mix((30, 28, 25), gap * 0.9)
    height -= gap * 4.0 + edge * 1.2
    mix((92, 80, 62), t.step(34.0, 6.0, off) * t.step(0.4, 0.8, mid) * 0.4)

    du = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * 0.5
    dv = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * 0.5
    vector = np.stack([-du * 0.9, -dv * 0.9, np.ones_like(du)], 2)
    vector /= np.linalg.norm(vector, axis=2)[:, :, None]
    t.save_jpg("concrete_color", np.clip(colour, 0, 255).astype(np.uint8), 88)
    t.save_jpg("concrete_normal", ((vector[::2, ::2] * 0.5 + 0.5) * 255).astype(np.uint8), 88)
    orm = np.stack([np.ones_like(rough), np.clip(rough, 0, 1), np.zeros_like(rough)], 2)
    t.save_jpg("concrete_orm", (orm[::2, ::2] * 255).astype(np.uint8), 85)
    print("concrete done")


def main():
    np.seterr(over="ignore")
    build("crane", CRANE, 2048)
    build("props", PROPS, 2048)
    concrete()


if __name__ == "__main__":
    main()
