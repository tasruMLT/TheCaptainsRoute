"""Makes the pictures the ship fires are drawn with.

Run:  python tools/fire_sheet.py      (needs numpy and Pillow)

assets/effects/fire.jpg   64 frames (8 x 8) of a burning flame that loops, from
                          a small fluid simulation: hot gas rising, curling and
                          tearing off. Grey = temperature; render3d.js colours it.
assets/effects/smoke.jpg  four smoke billows (2 x 2): red = how thick,
                          green = how much light falls on it.
"""
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "assets" / "effects"
W, H = 128, 224  # one flame frame, in simulation cells
FRAMES = 64
STEPS = 1  # simulation steps between frames
rng = np.random.default_rng(11)


def smooth_noise(w, h, cell, t=None):
    gw, gh = w // cell + 3, h // cell + 3
    grid = rng.random((gh, gw)).astype(np.float32)
    y, x = np.mgrid[0:h, 0:w].astype(np.float32) / cell
    i, j = x.astype(int), y.astype(int)
    fx, fy = x - i, y - j
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    low = grid[j, i] * (1 - fx) + grid[j, i + 1] * fx
    high = grid[j + 1, i] * (1 - fx) + grid[j + 1, i + 1] * fx
    return low * (1 - fy) + high * fy


def sample(field, x, y):
    x = np.clip(x, 0, W - 1.001)
    y = np.clip(y, 0, H - 1.001)
    i, j = x.astype(int), y.astype(int)
    fx, fy = x - i, y - j
    return ((field[j, i] * (1 - fx) + field[j, i + 1] * fx) * (1 - fy)
            + (field[j + 1, i] * (1 - fx) + field[j + 1, i + 1] * fx) * fy)


def project(u, v, pressure):
    """Takes out the part of the flow that would squash or stretch the gas."""
    div = np.zeros_like(u)
    div[1:-1, 1:-1] = 0.5 * (u[1:-1, 2:] - u[1:-1, :-2] + v[2:, 1:-1] - v[:-2, 1:-1])
    for _ in range(60):
        pressure[1:-1, 1:-1] = 0.25 * (pressure[1:-1, 2:] + pressure[1:-1, :-2] + pressure[2:, 1:-1] + pressure[:-2, 1:-1] - div[1:-1, 1:-1])
        pressure[0, :] = pressure[1, :]  # a floor; the sides and top are open
        pressure[-1, :] = pressure[:, 0] = pressure[:, -1] = 0
    u[1:-1, 1:-1] -= 0.5 * (pressure[1:-1, 2:] - pressure[1:-1, :-2])
    v[1:-1, 1:-1] -= 0.5 * (pressure[2:, 1:-1] - pressure[:-2, 1:-1])


def flame():
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    u = np.zeros((H, W), np.float32)
    v = np.zeros((H, W), np.float32)
    heat = np.zeros((H, W), np.float32)
    pressure = np.zeros((H, W), np.float32)
    # where the fuel burns: a ragged bed near the bottom
    bed = np.exp(-(((x - W / 2) / (W * 0.31)) ** 6)) * np.exp(-(((y - 13) / 7.5) ** 2))
    flicker = [smooth_noise(W, H, 13) for _ in range(11)]
    frames = []
    warm = 220
    for step in range(warm + FRAMES * 2 * STEPS):
        a = (step / 9.0) % len(flicker)
        k = int(a)
        patch = flicker[k] * (1 - (a - k)) + flicker[(k + 1) % len(flicker)] * (a - k)
        feed = bed * np.clip((patch - 0.36) * 4.0, 0, 1.4)  # several separate tongues
        heat = np.maximum(heat, np.clip(feed, 0, 1))
        v += heat * 0.19  # hot gas rises
        # keep the eddies alive (vorticity confinement), and stir a little
        curl = np.zeros_like(u)
        curl[1:-1, 1:-1] = 0.5 * (v[1:-1, 2:] - v[1:-1, :-2] - u[2:, 1:-1] + u[:-2, 1:-1])
        size = np.abs(curl)
        gx = np.zeros_like(u)
        gy = np.zeros_like(u)
        gx[1:-1, 1:-1] = 0.5 * (size[1:-1, 2:] - size[1:-1, :-2])
        gy[1:-1, 1:-1] = 0.5 * (size[2:, 1:-1] - size[:-2, 1:-1])
        norm = np.sqrt(gx * gx + gy * gy) + 1e-5
        u += 0.24 * (gy / norm) * curl
        v -= 0.24 * (gx / norm) * curl
        if step % 3 == 0:
            u += (smooth_noise(W, H, 14) - 0.5) * heat * 0.9
        # the air round the flame draws it back towards the middle
        u -= (x - W / 2) * 0.00016 * (heat + 0.15)
        project(u, v, pressure)
        bx, by = x - u, y - v
        u, v, heat = sample(u, bx, by) * 0.995, sample(v, bx, by) * 0.985, sample(heat, bx, by)
        heat = np.clip(heat * 0.989 - 0.0052, 0, 1)
        if step >= warm and (step - warm) % STEPS == 0:
            frames.append(heat.copy())
    # make it loop: fade the second run into the first
    edge = np.clip(np.minimum(x, W - 1 - x) / 10, 0, 1) * np.clip((H - 1 - y) / 24, 0, 1) * np.clip(y / 9, 0, 1)
    sheet = np.zeros((H * 8, W * 8), np.uint8)
    peak = 0.0
    for i in range(FRAMES):
        mix = i / FRAMES
        frame = (frames[FRAMES + i] * (1 - mix) + frames[i] * mix) * edge
        peak = max(peak, float(frame.max()))
        r, c = divmod(i, 8)
        sheet[r * H:(r + 1) * H, c * W:(c + 1) * W] = (np.clip(frame[::-1], 0, 1) * 255).astype(np.uint8)
    rows = np.nonzero(sheet.reshape(8, H, 8, W).max(axis=(0, 2, 3)) > 12)[0]
    print("flame peak %.2f, fills rows %d..%d of %d (from the top)" % (peak, rows.min(), rows.max(), H))
    Image.fromarray(sheet).save(OUT / "fire.jpg", quality=90)


def smoke():
    size = 512
    y, x = (np.mgrid[0:size, 0:size].astype(np.float32) / size - 0.5) * 2
    sheet = np.zeros((size * 2, size * 2, 3), np.uint8)
    for n in range(4):
        # a billow: many overlapping balls, their surfaces broken up by noise
        shape = np.zeros((size, size), np.float32)
        light = np.zeros((size, size), np.float32)
        warp_x = (smooth_noise(size, size, 64) - 0.5) * 0.22 + (smooth_noise(size, size, 22) - 0.5) * 0.1
        warp_y = (smooth_noise(size, size, 64) - 0.5) * 0.22 + (smooth_noise(size, size, 22) - 0.5) * 0.1
        balls = [(0.0, 0.0, 0.45)] + [(*(rng.uniform(-0.45, 0.45, 2)), rng.uniform(0.17, 0.34)) for _ in range(22)]
        for cx, cy, radius in balls:
            dx, dy = x + warp_x - cx, y + warp_y - cy
            inside = np.clip(1 - (dx * dx + dy * dy) / (radius * radius), 0, 1)
            depth = np.sqrt(inside)
            # lit from above and a little to one side
            lit = np.clip(0.5 - 0.55 * dy / radius - 0.25 * dx / radius + 0.25 * depth, 0, 1)
            here = inside ** 0.8 * 0.55
            light = light * (1 - here) + lit * here
            shape = shape + here * (1 - shape)
        detail = smooth_noise(size, size, 40) * 0.55 + smooth_noise(size, size, 15) * 0.3 + smooth_noise(size, size, 6) * 0.15
        rim = np.clip((0.97 - np.sqrt(x * x + y * y)) / 0.35, 0, 1)
        density = np.clip(shape * (0.45 + 1.1 * detail), 0, 1) * rim
        light = np.clip(light * (0.75 + 0.5 * detail), 0, 1)
        r, c = divmod(n, 2)
        sheet[r * size:(r + 1) * size, c * size:(c + 1) * size, 0] = (density * 255).astype(np.uint8)
        sheet[r * size:(r + 1) * size, c * size:(c + 1) * size, 1] = (light * 255).astype(np.uint8)
    Image.fromarray(sheet).save(OUT / "smoke.jpg", quality=93, subsampling=0)  # keep red and green apart


OUT.mkdir(parents=True, exist_ok=True)
flame()
smoke()
print("written to", OUT)
