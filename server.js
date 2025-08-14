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
const shp = require('shpjs'); // <-- cargar después del polyfill

// Asegurar la carpeta de subidas ANTES de usar multer
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Static files (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Multer for uploads
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// Health check
app.get('/health', (_req, res) =>
  res.json({ ok: true, name: 'PreSeeds App', version: '1.0.0' })
);

// Example: process a shapefile .zip and return GeoJSON quick stats
app.post('/api/process-shp', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const geojson = await shp(req.file.path);
    // Clean up temp file
    fs.unlink(req.file.path, () => {});
    const features = Array.isArray(geojson.features) ? geojson.features.length : 0;
    res.json({ features, crs: geojson.crs || null, bbox: geojson.bbox || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error processing shapefile' });
  }
});

// Example: dummy endpoint for productive profile (stub for now)
app.post('/api/profile', async (req, res) => {
  try {
    const { lotId, startDate, endDate } = req.body || {};
    if (!lotId) return res.status(400).json({ error: 'lotId is required' });
    // TODO: reemplazar con tus fuentes reales (GEE, clima, suelo, etc.)
    const profile = {
      lotId,
      period: { startDate, endDate },
      ndviMean: 0.62,
      clusters: ['Alta', 'Media', 'Baja']
    };
    res.json(profile);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to generate profile' });
  }
});

// Fallback: serve index.html for root
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PreSeeds app listening on http://localhost:${PORT}`);
});

