// server.js — Cecilefy Proxy (serve index.html + proxy)
// node 18+ recommended
const express = require('express');
const stream = require('stream');
const { pipeline } = require('stream');
const { URL } = require('url');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow CORS for client requests (the frontend will call /proxy)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// Serve static files (index.html, css, etc.) from repo root
app.use(express.static(path.join(__dirname, '/')));

// --- helper funcs (copied from your original) ---
function isValidHttpUrl(string) {
  try {
    const u = new URL(string);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function sanitizeFilename(name) {
  return String(name)
    .replace(/["'\r\n\\]/g, '')
    .replace(/[^a-zA-Z0-9\-_.() ]/g, '_')
    .slice(0, 200);
}

function extFromPath(urlStr) {
  try {
    const u = new URL(urlStr);
    const m = u.pathname.match(/\.([a-z0-9]{2,5})(?:$|\?)/i);
    if (m) return m[1].toLowerCase();
  } catch (e) {}
  return null;
}

function extFromContentDisposition(cd) {
  if (!cd) return null;
  const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^;"']+)/i);
  if (m) {
    const fn = decodeURIComponent(m[1]);
    const mm = fn.match(/\.([a-z0-9]{2,5})$/i);
    if (mm) return mm[1].toLowerCase();
  }
  return null;
}

function extFromContentType(ct) {
  if (!ct) return null;
  const c = ct.toLowerCase();
  if (c.includes('mp4')) return 'mp4';
  if (c.includes('webm')) return 'webm';
  if (c.includes('mpeg') || c.includes('audio/mpeg')) return 'mp3';
  if (c.includes('ogg')) return 'ogg';
  if (c.includes('png')) return 'png';
  if (c.includes('jpeg') || c.includes('jpg')) return 'jpg';
  if (c.includes('gif')) return 'gif';
  if (c.includes('pdf')) return 'pdf';
  return null;
}

function sniffExtension(firstChunk) {
  if (!firstChunk || firstChunk.length < 4) return null;
  const b0 = firstChunk[0], b1 = firstChunk[1], b2 = firstChunk[2], b3 = firstChunk[3];

  if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return 'jpg';
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4E && b3 === 0x47) return 'png';
  if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46) return 'gif';
  if (b0 === 0x1A && b1 === 0x45 && b2 === 0xDF && b3 === 0xA3) return 'webm';
  const str = firstChunk.slice(4, 8).toString('utf8');
  if (str === 'ftyp') return 'mp4';
  const s3 = firstChunk.slice(0,3).toString('utf8');
  if (s3 === 'ID3') return 'mp3';
  if (b0 === 0xFF && (b1 & 0xE0) === 0xE0) return 'mp3';
  return null;
}

// --- proxy endpoint (copied + preserved behavior) ---
app.get('/proxy', async (req, res) => {
  const { url, filename } = req.query;
  if (!url || !isValidHttpUrl(url)) return res.status(400).send('Invalid url');

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(502).send(`Upstream returned ${upstream.status}`);

    const upstreamCD = upstream.headers.get('content-disposition');
    let ext =
      extFromContentDisposition(upstreamCD) ||
      extFromPath(url) ||
      extFromContentType(upstream.headers.get('content-type')) ||
      null;

    let dispositionName = filename && filename.trim().length > 0 ? sanitizeFilename(filename) : null;
    if (dispositionName && !dispositionName.includes('.') && ext) dispositionName += `.${ext}`;

    if (!ext) {
      if (upstream.body && typeof upstream.body.getReader === 'function') {
        const nodeStream = stream.Readable.fromWeb(upstream.body);
        const pass = new stream.PassThrough();
        let got = false;

        nodeStream.once('data', (chunk) => {
          got = true;
          const firstChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const sniffed = sniffExtension(firstChunk);
          if (sniffed) ext = sniffed;

          if (dispositionName && dispositionName.toLowerCase().endsWith('.bin') && ext) {
            dispositionName = dispositionName.replace(/\.bin$/i, `.${ext}`);
          }

          if (!dispositionName) {
            const rnd = Math.floor(100000 + Math.random() * 900000);
            dispositionName = `Cecilefy.xyz_${rnd}.${ext || 'bin'}`;
          }

          const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Disposition', `attachment; filename="${dispositionName}"`);
          res.setHeader('Cache-Control', 'no-cache');

          pass.write(firstChunk);
          nodeStream.pipe(pass);
          pipeline(pass, res, (err) => {
            if (err) {
              console.error('Pipeline error', err);
              if (!res.headersSent) res.status(500).end('Stream error');
            }
          });
        });

        nodeStream.once('end', () => {
          if (!got) {
            ext = ext || 'bin';
            if (!dispositionName) {
              const rnd = Math.floor(100000 + Math.random() * 900000);
              dispositionName = `Cecilefy.xyz_${rnd}.${ext}`;
            }
            res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename="${dispositionName}"`);
            res.end();
          }
        });

        return;
      } else if (upstream.body && typeof upstream.body.pipe === 'function') {
        const nodeStream = upstream.body;
        const pass = new stream.PassThrough();
        let got = false;
        nodeStream.once('data', (chunk) => {
          got = true;
          const firstChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const sniffed = sniffExtension(firstChunk);
          if (sniffed) ext = sniffed;

          if (dispositionName && dispositionName.toLowerCase().endsWith('.bin') && ext) {
            dispositionName = dispositionName.replace(/\.bin$/i, `.${ext}`);
          }

          if (!dispositionName) {
            const rnd = Math.floor(100000 + Math.random() * 900000);
            dispositionName = `Cecilefy.xyz_${rnd}.${ext || 'bin'}`;
          }

          const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Disposition', `attachment; filename="${dispositionName}"`);
          res.setHeader('Cache-Control', 'no-cache');

          pass.write(firstChunk);
          nodeStream.pipe(pass);
          pipeline(pass, res, (err) => {
            if (err) {
              console.error('Pipeline error', err);
              if (!res.headersSent) res.status(500).end('Stream error');
            }
          });
        });

        nodeStream.once('end', () => {
          if (!got) {
            ext = ext || 'bin';
            if (!dispositionName) {
              const rnd = Math.floor(100000 + Math.random() * 900000);
              dispositionName = `Cecilefy.xyz_${rnd}.${ext}`;
            }
            res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename="${dispositionName}"`);
            res.end();
          }
        });

        return;
      } else {
        const buf = await upstream.arrayBuffer();
        const firstChunk = Buffer.from(buf).slice(0, 512);
        const sniffed = sniffExtension(firstChunk);
        if (sniffed) ext = sniffed;
      }
    }

    ext = ext || 'bin';
    if (!dispositionName) {
      const rnd = Math.floor(100000 + Math.random() * 900000);
      dispositionName = `Cecilefy.xyz_${rnd}.${ext}`;
    } else {
      if (dispositionName.toLowerCase().endsWith('.bin') && ext) {
        dispositionName = dispositionName.replace(/\.bin$/i, `.${ext}`);
      }
      if (!dispositionName.includes('.')) dispositionName += `.${ext}`;
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${dispositionName}"`);
    res.setHeader('Cache-Control', 'no-cache');

    if (upstream.body && typeof upstream.body.getReader === 'function') {
      const nodeStream = stream.Readable.fromWeb(upstream.body);
      pipeline(nodeStream, res, (err) => {
        if (err) {
          console.error('Pipeline error', err);
          if (!res.headersSent) res.status(500).end('Stream error');
        }
      });
    } else if (upstream.body && typeof upstream.body.pipe === 'function') {
      upstream.body.pipe(res);
    } else {
      const buf = await upstream.arrayBuffer();
      res.end(Buffer.from(buf));
    }
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).send('Proxy error: ' + err.message);
  }
});

// explicit root route (serve index.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Proxy + frontend running at http://localhost:${PORT}/proxy`);
});
