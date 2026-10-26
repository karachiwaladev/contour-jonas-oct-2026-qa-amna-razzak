// Tiny static server for the e2e tests: serves the todo/ folder on PORT (default 8765).
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const port = Number(process.env.PORT) || 8765;

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const file = path.resolve(root, "." + (urlPath === "/" ? "/index.html" : urlPath));
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" }).end(data);
    });
  })
  .listen(port, () => console.log(`todo test server on http://localhost:${port}`));
