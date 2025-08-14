// server.js
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const JSZip = require('jszip');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

// --- Polyfill para shpjs en Node (Render puede usar Node 24) ---
if (typeof globalThis.self === 'undefined') {
  globalThis.self = globalThis;
}
const shp = require('shpjs'); // cargar después del polyfill

// Asegurar carpeta de subidas ANTES de usar multer
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Static files (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Multer para uploads
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// Health check
app.get('/health', (_req, res) =>
  res.json({ ok: true, name: 'PreSeeds App', version: '1.0.0' })
);

// Procesar Shapefile .zip → contar features usando shpjs (con fallback robusto)
app.post('/api/process-shp', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const filePath = req.file.path;

  // util para contar features de distintos formatos/resultados
  const countFeatures = (g) => {
    if (!g) return 0;
    if (Array.isArray(g)) return g.reduce((s, x) => s + countFeatures(x), 0);
    if (g.type === 'FeatureCollection' && Array.isArray(g.features)) return g.features.length;
    if (typeof g === 'object') return Object.values(g).reduce((s, x) => s + countFeatures(x), 0);
    return 0;
  };

  try {
    const buf = await fs.promises.readFile(filePath);
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    let geojson;
    try {
      // Intento directo: ZIP plano
      geojson = await shp(arrayBuffer);
    } catch (_directErr) {
      // Fallback: rearmar un ZIP “limpio” aunque los archivos estén en subcarpetas
      // y con diferencias de mayúsculas/minúsculas.
      const originalZip = await JSZip.loadAsync(arrayBuffer);
      const files = Object.keys(originalZip.files);        // nombres tal cual
      const filesLC = files.map((f) => f.toLowerCase());   // para buscar sin case-sensitive

      // localizar el .shp (cualquiera)
      const shpIdx = filesLC.findIndex((n) => n.endsWith('.shp'));
      if (shpIdx === -1) {
        throw new Error(`No .shp found in ZIP. Files: ${files.join(', ')}`);
      }

      const shpEntry = files[shpIdx];
      // base en minúsculas (nombre sin path ni extensión)
      const baseLower = filesLC[shpIdx]
        .replace(/\\/g, '/')
        .split('/')
        .pop()
        .replace(/\.[^/.]+$/, '');

      const findFile = (ext) => {
        const idx = filesLC.findIndex(
          (n) => n.endsWith(`/${baseLower}.${ext}`) || n.endsWith(`${baseLower}.${ext}`)
        );
        return idx >= 0 ? files[idx] : null;
      };

      const dbfEntry = findFile('dbf');
      if (!dbfEntry) {
        throw new Error(`.dbf missing for ${baseLower}. Files: ${files.join(', ')}`);
      }
      const shxEntry = findFile('shx');
      const prjEntry = findFile('prj');

      // construir un zip mínimo con los pares requeridos
      const mini = new JSZip();
      const shpBuf = await originalZip.file(shpEntry).async('arraybuffer');
      mini.file(`${baseLower}.shp`, shpBuf);

      const dbfBuf = await originalZip.file(dbfEntry).async('arraybuffer');
      mini.file(`${baseLower}.dbf`, dbfBuf);

      if (shxEntry) {
        const shxBuf = await originalZip.file(shxEntry).async('arraybuffer');
        mini.file(`${baseLower}.shx`, shxBuf);
      }
      if (prjEntry) {
        const prjTxt = await originalZip.file(prjEntry).async('string');
        mini.file(`${baseLower}.prj`, prjTxt);
      }

      const rebundled = await mini.generateAsync({ type: 'arraybuffer' });
      geojson = await shp(rebundled);
    }

    const features = countFeatures(geojson);
    return res.json({ features });
  } catch (err) {
    console.error('Shapefile error:', err);
    return res.status(500).json({
      error: 'Error processing shapefile',
      message: String(err?.message || err),
    });
  } finally {
    // limpiar archivo temporal
    fs.unlink(filePath, () => {});
  }
});

// Endpoint demo de perfil productivo
app.post('/api/profile', async (req, res) => {
  try {
    const { lotId, startDate, endDate } = req.body || {};
    if (!lotId) return res.status(400).json({ error: 'lotId is required' });
    // TODO: reemplazar por tus fuentes reales (GEE, clima, suelo, etc.)
    const profile = {
      lotId,
      period: { startDate, endDate },
      ndviMean: 0.62,
      clusters: ['Alta', 'Media', 'Baja'],
    };
    res.json(profile);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to generate profile' });
  }
});

// Fallback: servir index.html
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PreSeeds app listening on http://localhost:${PORT}`);
});
