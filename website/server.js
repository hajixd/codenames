const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const dir = path.join(__dirname);
const port = 8080;

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  let filePath = path.join(dir, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath);
  const ct = mimeTypes[ext] || 'text/plain';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found: ' + filePath); return; }
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  });
}).listen(port, () => console.log('Serving on http://localhost:' + port));
