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

// Procesar Shapefile .zip → contar features usando shpjs (ArrayBuffer)
app.post('/api/process-shp', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const filePath = req.file.path;
  try {
    // Leer el ZIP local y pasarlo a shpjs como ArrayBuffer
    const buf = await fs.promises.readFile(filePath);
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const geojson = await shp(arrayBuffer);

    // Contador robusto (maneja una o múltiples capas)
    const countFeatures = (g) => {
      if (!g) return 0;
      if (Array.isArray(g)) return g.reduce((s, x) => s + countFeatures(x), 0);
      if (g.type === 'FeatureCollection' && Array.isArray(g.features)) return g.features.length;
      if (typeof g === 'object') return Object.values(g).reduce((s, x) => s + countFeatures(x), 0);
      return 0;
    };

    const features = countFeatures(geojson);
    res.json({ features });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error processing shapefile' });
  } finally {
    fs.unlink(filePath, () => {}); // limpiar archivo temporal
  }
});

// Endpoint demo de perfil productivo
app.post('/api/profile', async (req, res) => {
  try {
    const { lotId, startDate, endDate } = req.body || {};
    if (!lotId) return res.status(400).json({ error: 'lotId is required' });

    // TODO: reemplazar por tus datos reales (GEE, clima, suelo, etc.)
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

