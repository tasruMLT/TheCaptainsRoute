// Tiny static file server for Harbour Run, used by start.ps1 when Python is missing.
// Usage: node serve.js [port]
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = Number(process.argv[2]) || 8080;
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ogg": "audio/ogg",
  ".glb": "model/gltf-binary",
};

http
  .createServer((req, res) => {
    let file = path.join(root, decodeURIComponent(req.url.split("?")[0]));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (file.endsWith(path.sep)) file = path.join(file, "index.html");
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      // no-cache: always revalidate, so edits to game.js show up on a normal reload.
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-cache"
      });
      res.end(data);
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`Serving Harbour Run on http://localhost:${port}`));
