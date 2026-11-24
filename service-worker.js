const CACHE = "harbour-run-v77";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./game.js",
  "./audio.js",
  "./render3d.js",
  "./vendor/three/three.module.js",
  "./vendor/three/addons/objects/Water.js",
  "./vendor/three/addons/objects/Sky.js",
  "./vendor/three/addons/postprocessing/EffectComposer.js",
  "./vendor/three/addons/postprocessing/RenderPass.js",
  "./vendor/three/addons/postprocessing/UnrealBloomPass.js",
  "./vendor/three/addons/postprocessing/OutputPass.js",
  "./vendor/three/addons/postprocessing/ShaderPass.js",
  "./vendor/three/addons/postprocessing/MaskPass.js",
  "./vendor/three/addons/postprocessing/Pass.js",
  "./vendor/three/addons/shaders/CopyShader.js",
  "./vendor/three/addons/shaders/LuminosityHighPassShader.js",
  "./vendor/three/addons/shaders/OutputShader.js",
  "./vendor/three/textures/waternormals.jpg",
  "./manifest.json",
  "./assets/icon-48.png",
  "./assets/icon-72.png",
  "./assets/icon-96.png",
  "./assets/icon-128.png",
  "./assets/icon-144.png",
  "./assets/icon-152.png",
  "./assets/icon-192.png",
  "./assets/icon-384.png",
  "./assets/icon-512.png",
  "./assets/audio/bubbles.ogg",
  "./assets/audio/cannon_fire.ogg",
  "./assets/audio/explosion.ogg",
  "./assets/audio/gull_1.ogg",
  "./assets/audio/gull_2.ogg",
  "./assets/audio/gull_3.ogg",
  "./assets/audio/gull_4.ogg",
  "./assets/audio/gull_5.ogg",
  "./assets/audio/gull_6.ogg",
  "./assets/audio/gull_7.ogg",
  "./assets/audio/hit_rock.ogg",
  "./assets/audio/hit_ship.ogg",
  "./assets/audio/intro.ogg",
  "./assets/audio/lava_loop.ogg",
  "./assets/audio/level_complete.ogg",
  "./assets/audio/missile_launch.ogg",
  "./assets/audio/rain_loop.ogg",
  "./assets/audio/sea_loop.ogg",
  "./assets/audio/ship_bump.ogg",
  "./assets/audio/ship_sink.ogg",
  "./assets/audio/thunder.ogg",
  "./assets/audio/ui_back.ogg",
  "./assets/audio/ui_click.ogg",
  "./assets/audio/ui_confirm.ogg",
  "./assets/audio/ui_error.ogg",
  "./assets/audio/ui_move.ogg",
  "./assets/audio/volcano_rumble.ogg",
  "./assets/audio/wave_1.ogg",
  "./assets/audio/wave_2.ogg",
  "./assets/audio/wave_3.ogg",
  "./assets/icon-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  // Network-first: always prefer the latest deployed file, only falling back
  // to the cache when offline. Prevents stale gameplay code from sticking
  // around after a deploy, at the cost of one extra round trip while online.
  // "no-cache" makes the browser check with the server every time; a plain
  // fetch could be answered from the browser's HTTP cache, which kept serving
  // an old game.js because the local dev server sends no caching headers.
  const sameOrigin = new URL(event.request.url).origin === self.location.origin;
  const request = sameOrigin ? fetch(event.request.url, { cache: "no-cache" }) : fetch(event.request);
  event.respondWith(
    request
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
