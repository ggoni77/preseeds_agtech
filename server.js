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

// Procesar Shapefile .zip → contar features usando shpjs (con fallback)
app.post('/api/process-shp', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const filePath = req.file.path;

  // util: contar features de distintos formatos
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
      // intento directo: zip plano
      geojson = await shp(arrayBuffer);
    } catch (directErr) {
      // Fallback: rearmar un zip “limpio” con la capa principal aunque esté en subcarpetas
      const originalZip = await JSZip.loadAsync(arrayBuffer);
      const files = Object.keys(originalZip.files);

      const shpEntry = files.find((n) => n.toLowerCase().endsWith('.shp'));
      if (!shpEntry) throw new Error(`No .shp found in ZIP. Files: ${files.join(', ')}`);
      const base = shpEntry.replace(/\\/g, '/').split('/').pop().replace(/\.[^/.]+$/, '');

      const findFile = (ext) => files.find((n) => n.toLowerCase().endsWith(`/${base}.${ext}`) || n.toLowerCase().endsWith(`${base}.${ext}`));
      const dbfEntry = findFile('dbf');
      if (!dbfEntry) throw new Error(`.dbf missing for ${base}. Files: ${files.join(', ')}`);

      const shxEntry = findFile('shx');
      const prjEntry = findFile('prj');

      const mini = new JSZip();
      // cargar contenidos como arraybuffer/string
      const shpBuf = await originalZip.file(shpEntry).async('arraybuffer');
      const dbfBuf = await originalZip.file(dbfEntry).async('arraybuffer');
      mini.file(`${base}.shp`, shpBuf);
      mini.file(`${base}.dbf`, dbfBuf);
      if (shxEntry) {
        const shxBuf = await originalZip.file(shxEntry).async('arraybuffer');
        mini.file(`${base}.shx`, shxBuf);
      }
      if (prjEntry) {
        const prjTxt = await originalZip.file(prjEntry).async('string');
        mini.file(`${base}.prj`, prjTxt);
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
