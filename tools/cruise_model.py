"""Builds the cruise liner from the reference picture: blue hull (tinted by the
game), white superstructure with rows of balconies, orange lifeboats, bridge
with wings, pools, domes, mast and the blue funnel.

Run:  blender -b --factory-startup -P tools/cruise_model.py

Writes assets/models/cruise.bin with its pictures (colour, shading, relief and
the night lights), and cruise_extra.bin: the simple stand-in shape the game
places flames and ropes on, and the curved panels it writes the name on.
Coordinates are the game's model units: x forward, y up (0 = waterline),
z starboard. The ship is 98 long and 12.5 wide, as the game expects.
"""
import math
import random
import struct
import sys
from pathlib import Path

import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tug_model as t
from tug_model import V, bar, beam, cyl, rail, torus, tube

rng = random.Random(3)
HALF = 6.25
AFT, KEEL, WATER = -49.0, -4.7, -0.55
# parts the game keeps apart (render3d.js CRUISE_PARTS): what it is made of,
# and where it is, so that what stands round the bridge can be hidden inside it
CLASSES = ("base", "tint", "glow")
AREAS = ("low", "aft", "bridge")
BRIDGE_X, BRIDGE_FLOOR = 21.0, 10.35
# The mooring deck: open sides in the hull at bow and stern where the lines are
# worked, with the accommodation starting above it. Heights of its floor and
# ceiling, and each opening's ends (x on a hull 49 long forward of amidships).
DECK_LO, DECK_HI = 2.75, 4.4
OPENINGS = ((-47.2, -44.6), (-43.9, -41.3), (-40.6, -38.2), (32.8, 35.4), (36.4, 39.0), (40.0, 42.6))


def box(c, size, kind, bevel=0.0, yaw=0.0, tilt=0.0):
    t.box(c, size, kind, bevel, yaw, tilt)


# ---------------------------------------------------------------------------
# Hull
# ---------------------------------------------------------------------------
def sheer(x):
    return 5.2 + 1.35 * max(0.0, (x - 28) / 21) ** 2


def aftmost(y):
    """Where the hull ends astern at height y: cut away under water, so the
    rudders and screws sit beneath the overhanging stern."""
    return AFT + 6.0 * max(0.0, min(1.0, (-0.8 - y) / 0.5))


def stem(y):
    """How far forward the bow reaches at height y (raked)."""
    return 45.6 + 3.4 * max(0.0, min(1.0, y / 6.5)) ** 0.9 - 0.8 * max(0.0, min(1.0, -y / 4.7))


def skin(x, y, side, proud=0.0):
    """A point on the hull; x is measured on a hull 49 long forward of amidships."""
    tip = stem(y)
    px = 18 + (x - 18) * (tip - 18) / (49 - 18) if x > 18 else x
    w = HALF
    if x > 18:
        f = min(1.0, (x - 18) / 31)
        full = 1.7 + 1.1 * max(0.0, min(1.0, y / 5.5))  # fuller at deck level than at the waterline
        w = HALF * max(0.0, 1 - f ** full) ** 0.85
    elif x < -40:
        f = (-40 - x) / 9
        w = HALF * (1 - 0.13 * f * f)
    w *= 0.84 + 0.16 * math.sin(max(0.0, min(1.0, (y - KEEL) / 3.2)) * math.pi / 2)
    return V(px, y, side * (w + proud))


def hull():
    for side in (-1, 1):
        outward = lambda p, s=side: V(0.1 if p.x > 30 else 0, -0.05, s)
        t.surface(150, 10, lambda a, b, s=side: skin(t.along(aftmost(KEEL + (WATER - KEEL) * b), 49, a), KEEL + (WATER - KEEL) * b, s), "antifoul", outward)
        # the painted side: below the mooring deck, above it, and the plating between its openings
        t.surface(190, 9, lambda a, b, s=side: skin(t.along(AFT, 49, a), WATER + (DECK_LO - WATER) * b, s), "paint", outward)
        t.surface(190, 4, lambda a, b, s=side: skin(t.along(AFT, 49, a), DECK_HI + (sheer(t.along(AFT, 49, a)) - DECK_HI) * b, s), "paint", outward)
        edges = [AFT] + [x for opening in OPENINGS for x in opening] + [49]
        for x0, x1 in zip(edges[::2], edges[1::2]):
            t.surface(max(2, int((x1 - x0) * 2)), 4, lambda a, b, s=side, x0=x0, x1=x1: skin(t.along(x0, x1, a), DECK_LO + (DECK_HI - DECK_LO) * b, s), "paint", outward)
        mooring_deck(side)
        # white boot line, sheer moulding and the rubbing strake
        tube([skin(x, WATER + 0.02, side, 0.02) for x in (t.along(AFT, 48.9, i / 90) for i in range(91))], 0.07, "white", 6)
        tube([skin(x, sheer(x), side, -0.02) for x in (t.along(AFT, 48.95, i / 110) for i in range(111))], 0.12, "white", 8)
        tube([skin(x, 4.55, side, 0.03) for x in np.linspace(-47, 24, 60)], 0.06, "paint", 6)
        # two rows of ports and a row of larger windows
        for y, x0, x1, step, r in ((1.75, -31, 20, 1.55, 0.21), (3.05, -37, 31, 1.2, 0.23)):
            x = x0
            while x <= x1:
                lettered = (17.5 < x < 31.5 and y > 2.3) or (-37.2 < x < -23.6 and y > 1.8)
                if rng.random() > 0.07 and not lettered and not (y > 2 and -3.5 < x < -1.5):
                    port(x, y, side, r)
                x += step
        # shell doors and the small openings low in the hull
        for x, y, w, h in ((-2.5, 2.2, 1.3, 1.8), (17.5, 1.5, 1.5, 1.2), (-36, 1.0, 1.6, 1.1)):
            door_on_hull(x, y, side, w, h)
        for x, y in ((-45.5, 1.2), (-43.0, 1.2)):
            window_on_hull(x, y, side, 1.1, 0.5, "iron")
        # the anchor in its recess at the bow
        c = skin(43.9, 2.25, side, 0.06)
        ahead = (skin(44.9, 2.25, side) - skin(42.9, 2.25, side)).normalized()
        yaw = math.atan2(-ahead.z, ahead.x)
        box(c, (1.3, 1.3, 0.18), "iron", 0.08, yaw)
        o = V(math.sin(yaw) * side, 0, math.cos(yaw) * side) * 0.16
        beam(c + o + V(0, 0.5, 0), c + o + V(0, -0.35, 0), 0.18, 0.12, "steel")
        beam(c + o + V(0, -0.4, 0) - ahead * 0.55, c + o + V(0, -0.4, 0) + ahead * 0.55, 0.2, 0.16, "steel")
        for k in (-1, 1):
            beam(c + o + V(0, -0.4, 0) + ahead * 0.5 * k, c + o + V(0, 0.1, 0) + ahead * 0.66 * k, 0.16, 0.12, "steel")
    # transom and bottom
    t.surface(16, 20, lambda a, b: V(aftmost(KEEL + (WATER - KEEL) * b), KEEL + (WATER - KEEL) * b, skin(aftmost(KEEL + (WATER - KEEL) * b), KEEL + (WATER - KEEL) * b, 1).z * (2 * a - 1)), "antifoul", lambda p: V(-1, -0.5, 0))
    t.surface(16, 10, lambda a, b: V(AFT, WATER + (sheer(AFT) - WATER) * b, skin(AFT, WATER + (sheer(AFT) - WATER) * b, 1).z * (2 * a - 1)), "paint", lambda p: V(-1, 0, 0))
    t.surface(120, 2, lambda a, b: V(skin(t.along(aftmost(KEEL), 49, a), KEEL, 1).x, KEEL, skin(t.along(aftmost(KEEL), 49, a), KEEL, 1).z * (2 * b - 1)), "antifoul", lambda p: V(0, -1, 0))
    # decks closing the top of the hull: aft, midships, and the pale blue foredeck
    t.surface(90, 8, lambda a, b: V(skin(t.along(AFT, 33, a), sheer(t.along(AFT, 33, a)), 1).x, sheer(t.along(AFT, 33, a)) - 0.08, skin(t.along(AFT, 33, a), sheer(t.along(AFT, 33, a)), 1, -0.06).z * (2 * b - 1)), "teak", lambda p: V(0, 1, 0))
    t.surface(50, 10, lambda a, b: V(skin(t.along(33, 48.9, a), sheer(t.along(33, 48.9, a)), 1).x, sheer(t.along(33, 48.9, a)) - 0.35, skin(t.along(33, 48.9, a), sheer(t.along(33, 48.9, a)), 1, -0.1).z * (2 * b - 1)), "foredeck", lambda p: V(0, 1, 0))
    for side in (-1, 1):  # the white bulwark round the bow, with its rail
        t.surface(60, 2, lambda a, b, s=side: skin(t.along(33, 48.95, a), sheer(t.along(33, 48.95, a)) + 0.55 * b, s, -0.05), "white", lambda p, s=side: V(0.2, 0, s))
        t.surface(60, 2, lambda a, b, s=side: skin(t.along(33, 48.8, a), sheer(t.along(33, 48.8, a)) - 0.35 + 0.9 * b, s, -0.22), "white", lambda p, s=side: V(-0.2, 0, -s))
        tube([skin(x, sheer(x) + 0.58, side, -0.13) for x in (t.along(33, 48.9, i / 50) for i in range(51))], 0.1, "white", 8)
        rail([tuple(skin(x, sheer(x) - 0.05, side, -0.15)) for x in np.linspace(-48.5, -37, 8)], 0.95, "white", 1.4, False)
    rail([(AFT + 0.15, sheer(AFT) - 0.05, z) for z in (-5.2, -2.6, 0, 2.6, 5.2)], 0.95, "white", 1.3, False)


def hull_frame(x, y, side):
    """Position, heading and outward direction of the hull side at (x, y)."""
    c = skin(x, y, side)
    ahead = (skin(x + 0.4, y, side) - skin(x - 0.4, y, side)).normalized()
    up = (skin(x, y + 0.3, side) - skin(x, y - 0.3, side)).normalized()
    out = ahead.cross(up).normalized()
    if out.z * side < 0:
        out = -out
    return c, ahead, up, out


def mooring_deck(side):
    """The rooms behind the openings: deck, bulkheads, winches wound with rope,
    bitts, the roller fairleads in each sill and a lamp overhead."""
    def inner(x, y, depth):
        """A point `depth` in from the hull side, never past the centre line."""
        w = abs(skin(x, y, side).z)
        return V(skin(x, y, side).x, y, side * max(0.25, w - depth))

    for x0, x1 in OPENINGS:
        mid = (x0 + x1) / 2
        span = lambda a, x0=x0, x1=x1: t.along(x0, x1, a)
        t.surface(8, 3, lambda a, b: inner(span(a), DECK_LO, 2.2 * b), "steel", lambda p: V(0, 1, 0))
        t.surface(8, 3, lambda a, b: inner(span(a), DECK_HI, 2.2 * b), "white", lambda p: V(0, -1, 0))
        t.surface(8, 3, lambda a, b: inner(span(a), t.along(DECK_LO, DECK_HI, b), 2.2), "white", lambda p, s=side: V(0, 0, s))
        for end, face in ((x0, 1), (x1, -1)):
            t.surface(3, 3, lambda a, b, end=end: inner(end, t.along(DECK_LO, DECK_HI, b), 2.2 * a), "white", lambda p, f=face: V(f, 0, 0))
        # the frame round the opening
        frame = [skin(span(i / 8), DECK_LO, side, 0.03) for i in range(9)] + [skin(span(i / 8), DECK_HI, side, 0.03) for i in range(8, -1, -1)]
        tube(frame, 0.075, "white", 6, True)
        # a winch: its bed, the drum of rope and the flanges
        c = inner(mid, DECK_LO + 0.55, 1.35)
        along = (inner(x1, c.y, 1.35) - inner(x0, c.y, 1.35)).normalized()
        box(V(c.x, DECK_LO + 0.12, c.z), (1.3, 0.24, 0.6), "iron", 0.05, math.atan2(-along.z, along.x))
        cyl(c - along * 0.5, c + along * 0.5, 0.3, "rope", seg=16)
        for k in (-0.52, 0.52, 0.0):
            cyl(c + along * (k - 0.04), c + along * (k + 0.04), 0.44 if k else 0.34, "steel", seg=16, bevel=0.02)
        for dx in (-0.85, 0.85):  # bitts, in pairs
            for k in (-0.14, 0.14):
                b = inner(mid + dx + k, DECK_LO, 0.55)
                cyl(b, b + V(0, 0.42, 0), 0.1, "iron", seg=10, bevel=0.03)
        for dx in (-0.34, 0.34):  # the fairlead's upright rollers, either side of the line
            r = inner(mid + dx, DECK_LO, 0.1)
            cyl(r, r + V(0, 0.5, 0), 0.11, "steel", seg=10, bevel=0.02)
        box(inner(mid, DECK_LO + 0.04, 0.08), (0.95, 0.09, 0.2), "steel", 0.02)
        box(inner(mid, DECK_HI - 0.07, 0.9), (0.7, 0.08, 0.22), "cabin")  # the lamp


def mooring_leads():
    """Where each line leaves the mooring deck, for render3d.js (CRUISE_LEADS):
    x, y, half-width and the way out of the hull there."""
    for x0, x1 in OPENINGS:
        x, y = (x0 + x1) / 2, DECK_LO + 0.36
        c, _, _, out = hull_frame(x, y, 1)
        print("LEAD", [round(c.x, 2), round(c.y, 2), round(c.z, 2)], [round(out.x, 3), round(out.y, 3), round(out.z, 3)])


def port(x, y, side, r):
    c, _, _, out = hull_frame(x, y, side)
    cyl(c - out * 0.06, c + out * 0.035, r, "cabin", seg=12)
    torus(c + out * 0.035, out, r + 0.02, 0.035, "white", 14, 5)


def window_on_hull(x, y, side, w, h, kind="cabin"):
    c, ahead, up, out = hull_frame(x, y, side)
    ring = t.rrect(c + out * 0.02, ahead, up, w, h, min(w, h) * 0.3, 3)
    t.loft([[p - out * 0.05 for p in ring], [p + out * 0.02 for p in ring]], kind)
    tube(t.rrect(c + out * 0.04, ahead, up, w + 0.06, h + 0.06, min(w, h) * 0.32, 3), 0.035, "white", 5, True)


def door_on_hull(x, y, side, w, h):
    c, ahead, up, out = hull_frame(x, y, side)
    tube(t.rrect(c + out * 0.03, ahead, up, w, h, 0.25, 4), 0.07, "steel", 6, True)
    tube(t.rrect(c + out * 0.02, ahead, up, w * 0.8, h * 0.82, 0.18, 4), 0.025, "iron", 4, True)


# ---------------------------------------------------------------------------
# Superstructure
# ---------------------------------------------------------------------------
def outline(back, front, half, curve):
    """A deck's outline seen from above: straight sides and a rounded front."""
    pts = [(back, -half), (front - curve, -half)]
    for i in range(1, 12):
        a = -math.pi / 2 + math.pi * i / 12
        pts.append((front - curve + curve * math.cos(a) ** 0.75, half * math.copysign(abs(math.sin(a)) ** 0.8, math.sin(a))))
    pts += [(front - curve, half), (back, half)]
    return pts


def windows_round(back, front, half, curve, y, w, h, step, kind="cabin", skip=0.0):
    """Windows spaced along a deck outline."""
    pts = [V(x, y, z) for x, z in outline(back, front, half, curve)]
    walked = step / 2
    for a, b in zip(pts, pts[1:]):
        edge = b - a
        length = edge.length
        along = edge / length
        out = V(along.z, 0, -along.x)
        if out.dot((a + b) / 2 - V((back + front) / 2, y, 0)) < 0:
            out = -out
        while walked < length:
            c = a + along * walked + out * 0.025
            if rng.random() >= skip:
                ring = t.rrect(c, along, V(0, 1, 0), w, h, min(w, h) * 0.22, 2)
                t.loft([[p - out * 0.05 for p in ring], [p + out * 0.015 for p in ring]], kind)
            walked += step
        walked -= length


def tier(back, front, half, curve, y0, y1, kind="white"):
    shape = outline(back, front, half, curve)
    t.prism(shape, shape, y0, y1, kind, 0.12)


def slab(back, front, half, curve, y, thick=0.16, kind="white"):
    shape = outline(back, front, half, curve)
    t.prism(shape, shape, y - thick / 2, y + thick / 2, kind, 0.04)


def outline_rail(back, front, half, curve, y, glass=True):
    pts = [V(x, y, z) for x, z in outline(back, front, half, curve)]
    if glass:
        for a, b in zip(pts, pts[1:]):
            mid, edge = (a + b) / 2, b - a
            box(mid + V(0, 0.34, 0), (edge.length - 0.04, 0.56, 0.045), "balustrade", yaw=math.atan2(-edge.z, edge.x))
    tube([p + V(0, 0.68, 0) for p in pts], 0.045, "white", 6)


def promenade():
    """The lifeboat deck: a wall set back from the side, davits and boats."""
    box((-8, 6.35, 0), (58, 2.3, 10.5), "white", 0.1)
    for side in (-1, 1):
        for i in range(48):
            x = -36.2 + i * 1.18
            box((x, 6.35, side * 5.27), (0.72, 0.85, 0.05), "cabin")
            if i % 4 == 0:
                box((x - 0.6, 6.35, side * 5.32), (0.16, 2.25, 0.1), "white")
        rail([(x, 5.15, side * 6.12) for x in np.linspace(-37, 21, 14)], 0.8, "white", 2.1, False)
        for i in range(9):
            lifeboat(-30.8 + i * 5.55, side)
    # forward and aft of the boats the side is plated flush
    for x0, x1, front in ((21.0, 31.0, True), (-42.0, -37.0, False)):
        tier(x0, x1 + (4 if front else 0), 6.0 if not front else 5.9, 6.0 if front else 0.6, 5.15, 7.45)
        windows_round(x0, x1 + (4 if front else 0), 6.0 if not front else 5.9, 6.0 if front else 0.6, 6.35, 0.55, 0.55, 1.25)


def lifeboat(x, side):
    c = V(x, 6.15, side * 6.2)
    # white boat below, orange cover on top
    for kind, y0, y1, grow in (("white", -0.62, 0.0, 1.0), ("orange", 0.0, 0.66, 1.02)):
        rings = []
        for k in range(7):
            f = k / 6
            y = y0 + (y1 - y0) * f
            squash = math.sqrt(max(0.06, 1 - (abs(y) / 0.72) ** 2.2))
            rings.append([c + V(2.25 * grow * squash ** 0.45 * math.copysign(abs(math.cos(a)) ** 0.6, math.cos(a)), y, 0.82 * grow * squash * math.sin(a))
                          for a in (2 * math.pi * i / 18 for i in range(18))])
        t.loft(rings, kind)
    tube([c + V(2.28 * math.copysign(abs(math.cos(a)) ** 0.6, math.cos(a)), 0.0, 0.83 * math.sin(a)) for a in (2 * math.pi * i / 22 for i in range(22))], 0.06, "iron", 5, True)
    for dx in (-0.9, -0.3, 0.3, 0.9):
        box(c + V(dx, 0.32, side * 0.77), (0.34, 0.2, 0.05), "cabin")
    box(c + V(1.35, 0.6, 0), (0.8, 0.28, 0.7), "orange", 0.1)
    for dx in (-2.45, 2.45):  # davits
        tube([V(x + dx, 5.2, side * 5.3), V(x + dx, 7.0, side * 5.45), V(x + dx, 7.28, side * 6.25), V(x + dx, 6.85, side * 6.5)], 0.11, "white", 7)
        bar((x + dx, 6.85, side * 6.45), (x + dx * 0.85, 6.5, side * 6.25), 0.035, "steel", 5)


def balconies():
    """Six decks of cabins, each with its door, dividing screen and glass front."""
    for deck in range(6):
        y = 7.45 + deck
        aft = -42.0 + deck * 0.75
        slab(aft, BRIDGE_X, 6.3, 0.05, y, 0.17)
        for x0, x1 in ((aft + 0.4, BRIDGE_X),):
            box(((x0 + x1) / 2, y + 0.5, 0), (x1 - x0, 1.0, 10.9), "white")
            count = int((x1 - x0) / 1.13)
            width = (x1 - x0) / count
            for side in (-1, 1):
                for i in range(count):
                    x = x0 + (i + 0.5) * width
                    swell = 0.2 if -12 < x < 8 else 0.0  # the middle of the ship stands out a little
                    edge = side * (6.18 + swell)
                    box((x, y + 0.45, side * 5.47), (width * 0.72, 0.76, 0.05), "cabin")
                    box((x - width / 2, y + 0.5, (side * 5.45 + edge) / 2), (0.07, 0.86, abs(edge - side * 5.45)), "white")
                    box((x, y + 0.31, edge), (width - 0.06, 0.4, 0.04), "balustrade")
                    box((x, y + 0.54, edge), (width, 0.055, 0.08), "white")
                    if swell:
                        box((x, y + 0.02, side * 6.37), (width, 0.15, 0.24), "white")
                    if rng.random() < 0.18:  # a chair or a towel
                        box((x + rng.uniform(-0.2, 0.2), y + 0.24, side * 5.85), (0.25, 0.26, 0.25), rng.choice(("white", "blue", "red", "teak")))
        for side in (-1, 1):  # the stepped stern ends, each a terrace with its rail
            rail([(aft, y + 0.08, side * 6.2), (aft, y + 0.08, 0)], 0.62, "white", 1.0, False)
        box((aft + 0.43, y + 0.45, 0), (0.08, 0.7, 8.6), "cabin")


def bridge_front():
    """The rounded forward end: terraces stepping back, the bridge with its
    wings, and the dark observation lounge above."""
    for y0, y1, front, half, curve in ((7.45, 8.9, 31.2, 6.05, 6.5), (8.9, 10.3, 29.4, 6.0, 6.0)):
        tier(BRIDGE_X, front, half, curve, y0, y1)
        windows_round(BRIDGE_X, front, half, curve, (y0 + y1) / 2, 0.5, 0.52, 1.05)
        slab(BRIDGE_X, front + 0.45, half + 0.22, curve + 0.2, y1, 0.14)
        outline_rail(BRIDGE_X + 3, front + 0.35, half + 0.14, curve + 0.15, y1 + 0.05, False)
    # the navigation bridge: a wide band of raked windows, and its wings
    tier(BRIDGE_X, 28.0, 5.85, 5.0, 10.37, 11.2)
    t.prism(outline(BRIDGE_X, 28.05, 5.9, 5.0), outline(BRIDGE_X, 28.75, 6.15, 5.2), 11.2, 12.55, "lounge", 0.02)
    low, high = outline(BRIDGE_X, 28.1, 5.93, 5.0), outline(BRIDGE_X, 28.8, 6.18, 5.2)
    for (ax, az), (bx, bz) in zip(low[1:-1], high[1:-1]):
        bar((ax, 11.18, az), (bx, 12.57, bz), 0.075, "white", 6)
    slab(BRIDGE_X, 29.35, 6.45, 5.4, 12.68, 0.28)
    for side in (-1, 1):
        box((25.0, 11.05, side * 6.9), (2.6, 0.25, 1.9), "white", 0.08)
        box((25.0, 11.85, side * 7.45), (2.5, 1.2, 0.75), "lounge", 0.1)
        box((25.0, 12.6, side * 6.95), (2.8, 0.2, 2.0), "white", 0.07)
        for dx in (-1.1, 1.1):
            bar((25.0 + dx, 10.95, side * 7.5), (25.0 + dx, 9.4, side * 6.1), 0.09, "white")
    # the observation lounge, a deep blue curved band
    t.prism(outline(BRIDGE_X, 26.4, 5.7, 4.6), outline(BRIDGE_X, 25.7, 5.5, 4.4), 12.8, 14.45, "lounge", 0.05)
    for (ax, az), (bx, bz) in list(zip(outline(BRIDGE_X, 26.43, 5.73, 4.6), outline(BRIDGE_X, 25.73, 5.53, 4.4)))[1:-1:2]:
        bar((ax, 12.8, az), (bx, 14.45, bz), 0.04, "steel", 5)
    slab(BRIDGE_X, 27.1, 6.05, 4.9, 14.62, 0.3)
    outline_rail(BRIDGE_X, 26.9, 5.92, 4.8, 14.75)


def deck_at(px):
    """The foredeck's height at the true position px (it rises towards the bow)."""
    x = px
    for _ in range(4):
        x = 18 + (px - 18) * (49 - 18) / (stem(sheer(x)) - 18)
    return sheer(x) - 0.35


def foredeck():
    y = sheer(40) - 0.35
    for side in (-1, 1):
        # the windlass: its bed, the wheel the chain is wound round and the warping head
        z = side * 1.5
        cyl((40.5, y, z), (40.5, y + 0.12, z), 0.86, "steel", seg=24, bevel=0.03)
        cyl((40.5, y + 0.1, z), (40.5, y + 0.55, z), 0.55, "steel", seg=24, bevel=0.06)
        cyl((40.5, y + 0.55, z), (40.5, y + 0.9, z), 0.4, "iron", seg=14, bevel=0.03)
        # one chain, never ending in plating: up out of the hawse pipe, along the
        # deck, half round the wheel and down the spurling pipe to the chain locker
        hawse, locker = V(43.75, 0, side * 1.2), V(41.6, 0, side * 2.22)
        turn = [math.radians(-82 - 188 * i / 16) for i in range(17)]
        wheel = [(40.5 + 0.72 * math.cos(a), y + 0.29, z + side * 0.72 * math.sin(a)) for a in turn]
        lead = V(wheel[0][0], 0, wheel[0][2])
        along = [lead.lerp(hawse, k) for k in (0.75, 0.5, 0.25)]
        t.chain_run(
            [(hawse.x + 0.16, deck_at(hawse.x) - 0.3, hawse.z), (hawse.x - 0.06, deck_at(hawse.x), hawse.z),
             (hawse.x - 0.42, deck_at(hawse.x - 0.42) + 0.19, lead.lerp(hawse, 0.87).z)]
            + [(p.x, deck_at(p.x) + 0.17, p.z) for p in along]
            + wheel
            + [(41.0, y + 0.29, locker.z), (locker.x - 0.26, deck_at(locker.x) + 0.22, locker.z),
               (locker.x, deck_at(locker.x), locker.z), (locker.x + 0.08, deck_at(locker.x) - 0.3, locker.z)],
            0.3)
        t.deck_pipe(hawse.x, hawse.z, 0.46, 0.3, 0.07, deck_at)
        t.deck_pipe(locker.x, locker.z, 0.36, 0.28, 0.07, deck_at)
    for x, z in((36, 3.6), (36, -3.6), (43, 2.2), (43, -2.2)):
        for k in (-0.3, 0.3):
            cyl((x + k, y, z), (x + k, y + 0.55, z), 0.17, "iron", seg=10, bevel=0.04)
    cyl((46.5, y, 0), (46.5, y + 3.2, 0), 0.1, "white", 0.05, 8)  # the jack staff
    bar((46.5, y + 2.4, -0.7), (46.5, y + 2.4, 0.7), 0.04, "white")
    box((35.0, y + 0.55, 0), (0.5, 1.1, 4.0), "white", 0.12)  # breakwater


# ---------------------------------------------------------------------------
# The top deck
# ---------------------------------------------------------------------------
def lido():
    y = 14.55
    # the long band of windows under the top deck
    box((-9.6, 13.95, 0), (61.2, 1.05, 11.5), "lounge", 0.04)
    for i in range(41):
        for side in (-1, 1):
            box((-39.6 + i * 1.5, 13.95, side * 5.78), (0.12, 1.1, 0.08), "white")
    slab(-40.4, BRIDGE_X, 6.3, 0.3, y, 0.22)
    box((-9.7, y + 0.14, 0), (60.6, 0.05, 11.4), "teak")
    for side in (-1, 1):
        for x0 in np.arange(-40.0, 20.0, 3.0):
            box((x0 + 1.5, y + 0.52, side * 6.18), (2.92, 0.6, 0.045), "balustrade")
            bar((x0, y + 0.1, side * 6.18), (x0, y + 0.86, side * 6.18), 0.045, "white")
        bar((-40.0, y + 0.86, side * 6.18), (20.0, y + 0.86, side * 6.18), 0.05, "white")
    rail([(-40.3, y + 0.15, z) for z in (-6.1, -3, 0, 3, 6.1)], 0.7, "white", 1.0, False)
    # two pools, their surrounds, ladders and the sun loungers
    for cx, length in ((9.0, 8.4), (-4.2, 6.6)):
        box((cx, y + 0.34, 0), (length + 1.2, 0.34, 6.0), "white", 0.14)
        box((cx, y + 0.53, 0), (length, 0.06, 4.7), "water")
        for k in (-1, 1):
            tube([V(cx + k * length / 2, y + 0.5, 1.5), V(cx + k * length / 2, y + 1.1, 1.5), V(cx + k * (length / 2 + 0.4), y + 1.1, 1.5), V(cx + k * (length / 2 + 0.4), y + 0.5, 1.5)], 0.045, "steel", 6)
        for side in (-1, 1):
            for i in range(int(length / 0.75)):
                x = cx - length / 2 + 0.4 + i * 0.75
                z = side * 4.25
                box((x, y + 0.34, z), (0.42, 0.08, 0.95), rng.choice(("white", "white", "blue")))
                box((x, y + 0.5, z + side * 0.55), (0.42, 0.08, 0.4), "white", yaw=0, tilt=0)
    for x, z in ((2.6, 4.9), (2.6, -4.9), (15.2, 3.9), (15.2, -3.9), (-9.6, 4.6), (-9.6, -4.6)):
        cyl((x, y + 0.1, z), (x, y + 1.5, z), 0.05, "white", seg=6)
        cyl((x, y + 1.45, z), (x, y + 1.7, z), 0.95, rng.choice(("white", "red", "blue")), 0.06, 16)
    # the rounded lounge with its white roof, ahead of the funnel
    tier(-19.0, -11.0, 4.3, 3.2, y + 0.1, y + 0.75)
    t.prism(outline(-19.0, -11.2, 4.2, 3.1), outline(-19.0, -10.6, 4.55, 3.4), y + 0.75, y + 2.35, "lounge", 0.04)
    for (ax, az), (bx, bz) in list(zip(outline(-19.0, -11.18, 4.23, 3.1), outline(-19.0, -10.58, 4.58, 3.4)))[1:-1:2]:
        bar((ax, y + 0.75, az), (bx, y + 2.35, bz), 0.05, "white", 5)
    slab(-19.4, -9.9, 4.9, 3.6, y + 2.55, 0.42)
    # sports deck and houses aft
    tier(-34.5, -19.0, 4.4, 0.4, y + 0.1, y + 1.7)
    windows_round(-34.5, -19.0, 4.4, 0.4, y + 1.0, 0.7, 0.55, 1.15)
    slab(-35.0, -18.8, 4.9, 0.4, y + 1.82, 0.2)
    outline_rail(-35.0, -18.9, 4.82, 0.4, y + 1.9)
    box((-37.5, y + 0.55, 0), (3.0, 0.9, 5.4), "white", 0.18)
    for x in (-38.5, 17.8):
        for z in (-2.8, 2.8):
            cyl((x, y + 0.1, z), (x, y + 0.8, z), 0.45, "white", 0.32, 12)
    for i in range(26):  # ventilators and lockers
        x, side = rng.uniform(-39, 19), rng.choice((-1, 1))
        if -20 < x < -9 or -9 < x < 15:
            continue
        box((x, y + 0.45, side * rng.uniform(5.0, 5.7)), (rng.uniform(0.5, 1.3), rng.uniform(0.4, 0.8), 0.5), "white", 0.08)


def dome(x, y, z, r):
    cyl((x, y, z), (x, y + r * 0.75, z), r * 0.34, "white", r * 0.26, 12)
    torus((x, y + r * 0.75, z), (0, 1, 0), r * 0.6, r * 0.09, "white", 18, 6)
    t.ellipsoid((x, y + r * 1.5, z), (r, r, r), "white", 24, 16, -0.78)


def funnel():
    base, top = 16.35, 23.4
    plan = lambda back, front, half: outline(back, front, half, (front - back) * 0.32)
    t.prism(plan(-33.0, -22.6, 2.7), plan(-34.0, -26.2, 2.25), base, 19.6, "paint", 0.3)
    t.prism(plan(-34.0, -26.2, 2.25), plan(-35.0, -29.4, 1.75), 19.6, top, "paint", 0.2)
    # white collar, dark louvred casing and uptakes on top
    t.prism(plan(-33.3, -22.2, 3.0), plan(-33.4, -22.7, 2.85), base, base + 0.5, "white", 0.1)
    t.prism(plan(-35.2, -29.2, 1.85), plan(-35.5, -29.7, 1.8), top, top + 0.35, "iron", 0.08)
    for i in range(6):
        x = -34.7 + i * 0.95
        cyl((x, top + 0.3, 0), (x - 0.35, top + 1.45, 0), 0.34, "soot", seg=10, caps=False)
        torus((x - 0.35, top + 1.45, 0), (-0.3, 1, 0), 0.34, 0.05, "iron", 14, 5)
    for k in (-1.1, 1.1):
        bar((-34.9, top + 1.2, k), (-29.8, top + 1.2, k), 0.07, "iron")
    for side in (-1, 1):  # louvres in the sides of the casing
        for i in range(7):
            y = 19.9 + i * 0.42
            f = (y - 19.6) / (top - 19.6)
            x0, x1 = -33.2 - f * 1.1, -28.6 - f * 2.4
            beam((x0, y, side * (2.27 - 0.5 * f)), (x1, y, side * (2.27 - 0.5 * f)), 0.1, 0.13, "iron", 0.02)


def masts():
    y = 14.75
    # the forward mast: a tapering white tower raked aft, with its platforms
    t.prism([(24.4, -1.3), (24.4, 1.3), (20.8, 1.3), (20.8, -1.3)], [(22.4, -0.45), (22.4, 0.45), (21.0, 0.45), (21.0, -0.45)], y, 19.4, "white", 0.14)
    cyl((21.7, 19.3, 0), (21.2, 24.2, 0), 0.34, "white", 0.14, 12)
    for h, w, reach in ((17.2, 5.2, 1.6), (19.4, 4.2, 1.2), (21.4, 3.0, 0.8)):
        box((22.0, h, 0), (reach, 0.16, w), "white", 0.05)
        rail([(22.0 + reach / 2, h + 0.08, -w / 2), (22.0 + reach / 2, h + 0.08, w / 2)], 0.4, "white", 0.6, False)
        for k in (-1, 1):
            cyl((22.0, h + 0.08, k * w / 2), (22.0, h + 0.7, k * w / 2), 0.07, "white", seg=8)
            t.ellipsoid((22.0, h + 0.75, k * w / 2), (0.13, 0.13, 0.13), "lens_white", 10, 7)
    for h, w in ((18.3, 3.6), (20.5, 2.6)):  # radar scanners
        cyl((23.0, h - 0.45, 0), (23.0, h - 0.1, 0), 0.2, "white", seg=10)
        beam((23.0, h, -w / 2), (23.0, h, w / 2), 0.16, 0.3, "white", 0.06)
    for z in (-0.5, 0.0, 0.5):
        cyl((21.25, 24.0, z), (21.15, 25.6 - abs(z), z), 0.03, "white", 0.012, 6)
    for z in (-2.6, 2.6):
        bar((24.0, y + 0.2, z * 1.8), (21.6, 21.2, z * 0.2), 0.025, "steel", 4)
    for x, z in ((17.4, 2.9), (17.4, -2.9)):
        dome(x, y + 0.1, z, 1.15)
    for x, z in ((-39.0, 2.4), (-39.0, -2.4)):
        dome(x, y + 1.0, z, 0.95)
    cyl((-24.0, 18.2, 3.6), (-24.0, 20.6, 3.6), 0.07, "white", seg=8)


def flags():
    for x, y, kind in ((-48.4, 5.2, "red"), (22.6, 21.6, "blue")):
        cyl((x, y, 0), (x - 0.2, y + 2.6, 0), 0.05, "white", seg=6)
        box((x - 0.85, y + 2.15, 0), (1.3, 0.75, 0.04), kind)


# ---------------------------------------------------------------------------
# The stand-in shape and the name panels (a second, unpainted file)
# ---------------------------------------------------------------------------
def stand_in():
    for side in (-1, 1):
        t.surface(24, 5, lambda a, b, s=side: skin(t.along(aftmost(KEEL + (sheer(-45) - KEEL) * b), 49, a), KEEL + (sheer(t.along(AFT, 49, a)) - KEEL) * b, s), "white", lambda p, s=side: V(0, 0, s))
    t.surface(20, 2, lambda a, b: V(skin(t.along(AFT, 48.8, a), sheer(t.along(AFT, 48.8, a)), 1).x, sheer(t.along(AFT, 48.8, a)) - 0.2, skin(t.along(AFT, 48.8, a), sheer(t.along(AFT, 48.8, a)), 1).z * (2 * b - 1)), "white", lambda p: V(0, 1, 0))
    t.surface(8, 5, lambda a, b: V(aftmost(KEEL + (sheer(AFT) - KEEL) * b), KEEL + (sheer(AFT) - KEEL) * b, skin(aftmost(KEEL + (sheer(AFT) - KEEL) * b), KEEL + (sheer(AFT) - KEEL) * b, 1).z * (2 * a - 1)), "white", lambda p: V(-1, 0, 0))


def stand_in_upper():
    tier(-41.0, BRIDGE_X, 6.2, 0.1, 5.1, 14.7)
    tier(BRIDGE_X, 31.0, 5.9, 5.5, 5.1, 10.35)
    tier(BRIDGE_X, 28.0, 5.8, 4.6, 10.35, 14.75)
    tier(-34.5, -11.0, 4.4, 1.0, 14.7, 16.5)
    t.prism(outline(-33.0, -22.6, 2.7, 3.0), outline(-35.0, -29.4, 1.75, 1.8), 16.5, 24.6, "white", 0)
    cyl((21.8, 14.7, 0), (21.2, 24.2, 0), 0.7, "white", 0.2, 8)


def name_panels():
    """Curved strips on the hull for the name, with their own picture positions:
    one at each bow and one near each stern."""
    for x0, length, height in ((18.0, 13.5, 1.75), (-36.4, 11.0, 1.45)):
        for side in (-1, 1):
            nu = 24
            pts, uvs, faces = [], [], []
            for j in range(3):
                for i in range(nu + 1):
                    x = x0 + length * i / nu
                    top = 4.35 if x0 > 0 else 3.45
                    pts.append(skin(x, top - height + height * j / 2, side, 0.09))
                    uvs.append((i / nu if side > 0 else 1 - i / nu, j / 2))
            for j in range(2):
                for i in range(nu):
                    a = j * (nu + 1) + i
                    f = [a, a + 1, a + nu + 2, a + nu + 1]
                    faces.append(f if side > 0 else f[::-1])
            yield pts, uvs, faces


def write_parts(path, parts):
    """The game's model format: 'TUG2', the number of parts, then each part's
    counts, positions, normals, picture positions and indices."""
    data = b"TUG2" + struct.pack("<I", len(parts))
    for pts, normals, uvs, index in parts:
        data += struct.pack("<II", len(pts), len(index))
        data += np.asarray(pts, "<f4").tobytes() + np.rint(np.asarray(normals) * 32767).astype("<i2").tobytes()
        data += np.rint(np.asarray(uvs) * 65535).astype("<u2").tobytes()
        data += b"\0" * (-len(data) % 4) + np.asarray(index, "<u4").tobytes()
    path.write_bytes(data)


def triangulated(points, faces, uvs):
    """Flat lists of a mesh's triangles with their own corners and normals."""
    pts, normals, tex, index = [], [], [], []
    for f in faces:
        for k in range(1, len(f) - 1):
            tri = [f[0], f[k], f[k + 1]]
            a, b, c = (V(*points[i]) for i in tri)
            n = (b - a).cross(c - a)
            if n.length < 1e-9:
                continue
            n.normalize()
            for i in tri:
                index.append(len(pts))
                pts.append(tuple(points[i]))
                normals.append(tuple(n))
                tex.append(uvs[i] if uvs else (0, 0))
    return pts, normals, tex, index


def extra():
    parts = []
    for build_it in (stand_in, stand_in_upper):
        for items in (t.VERTS, t.FACES, t.FACE_KIND, t.FACE_GROUP):
            items.clear()
        build_it()
        parts.append(triangulated(t.VERTS, t.FACES, None))
    for pts, uvs, faces in name_panels():
        parts.append(triangulated([tuple(p) for p in pts], faces, uvs))
    write_parts(t.OUT / "cruise_extra.bin", parts)


def sort_into_parts():
    """Puts every face in its part by what it is made of and where it lies."""
    verts = np.array(t.VERTS)
    t.GROUPS = tuple(f"{c}_{a}" for c in CLASSES for a in AREAS)
    for i, face in enumerate(t.FACES):
        corners = verts[face]
        kind = t.KINDS[t.FACE_KIND[i]][0]
        cls = 1 if kind == "paint" else 2 if kind == "cabin" else 0
        if corners[:, 1].max() <= BRIDGE_FLOOR:
            area = 0
        elif corners[:, 0].max() <= BRIDGE_X + 0.05:
            area = 1
        else:
            area = 2
        t.FACE_GROUP[i] = cls * 3 + area


def main():
    np.seterr(over="ignore")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    t.OUT.mkdir(parents=True, exist_ok=True)
    extra()
    mooring_leads()
    for items in (t.VERTS, t.FACES, t.FACE_KIND, t.FACE_GROUP, t.STREAKS):
        items.clear()
    t.GROUPS = ("low",)
    t.group = "low"
    for part in (hull, promenade, balconies, bridge_front, foredeck, lido, funnel, masts, flags):
        part()
        print(part.__name__, "faces so far", len(t.FACES))
    # a little rust weeping from the anchors and a few openings, no more
    for side in (-1, 1):
        for x, y, length, wide in ((43.9, 1.5, 1.6, 0.35), (24.8, 3.6, 1.2, 0.2), (-45.5, 0.9, 0.7, 0.2)):
            t.streak(skin(x, y, side, 0.02), length, wide, 0.45)
    sort_into_parts()
    t.WEAR[0] = 0.22
    t.POSITIONS[0] = 256.0
    obj = t.make_object()
    t.unwrap(obj)
    t.setup_cycles()
    t.textures(obj, "cruise", t.SIZE, tug=False, glow=True)
    t.export(obj, "cruise", [0.0] * len(t.GROUPS))


if __name__ == "__main__":
    main()
