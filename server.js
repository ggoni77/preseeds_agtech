// server.js
const express = require('express');
const multer = require('multer');
const JSZip = require('jszip');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const turf = require('@turf/turf');

// --- Polyfill para shpjs (necesita globalThis.self en Node) ---
if (typeof globalThis.self === 'undefined') {
  globalThis.self = globalThis;
}

// Carga robusta de shpjs (aseguramos función)
const shpMod = require('shpjs'); // usa 3.6.3 en package.json
const shp = typeof shpMod === 'function' ? shpMod : (shpMod.default || shpMod);

// Asegurar carpeta de subidas ANTES de usar multer
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Frontend estático
app.use(express.static(path.join(__dirname, 'public')));

// Multer
const upload = multer({ dest: UPLOAD_DIR });

/* ===================== Helpers ===================== */
const bufferToArrayBuffer = (buf) =>
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

// Normaliza a FeatureCollection
const toFC = (g) => {
  if (!g) return { type: 'FeatureCollection', features: [] };
  if (g.type === 'FeatureCollection') return g;
  if (Array.isArray(g)) {
    const feats = [];
    g.forEach((x) => { feats.push(...toFC(x).features); });
    return { type: 'FeatureCollection', features: feats };
  }
  if (g.type && g.geometry) return { type: 'FeatureCollection', features: [g] };
  const feats = [];
  Object.values(g).forEach((x) => { feats.push(...toFC(x).features); });
  return { type: 'FeatureCollection', features: feats };
};

/* ---------- SHP (.zip) ---------- */
async function parseShapefileZip(buf) {
  try {
    // ZIP plano
    return await shp(bufferToArrayBuffer(buf));
  } catch (_) {
    // Fallback: rearmar ZIP “limpio” tolerando subcarpetas y mayúsc/minúsculas
    const originalZip = await JSZip.loadAsync(bufferToArrayBuffer(buf));
    const files = Object.keys(originalZip.files);
    const filesLC = files.map((f) => f.toLowerCase());

    const shpIdx = filesLC.findIndex((n) => n.endsWith('.shp'));
    if (shpIdx === -1) throw new Error(`No .shp found in ZIP. Files: ${files.join(', ')}`);

    const shpEntry = files[shpIdx];
    const baseLower = filesLC[shpIdx].replace(/\\/g, '/').split('/').pop().replace(/\.[^/.]+$/, '');

    const findFile = (ext) => {
      const i = filesLC.findIndex(
        (n) => n.endsWith(`/${baseLower}.${ext}`) || n.endsWith(`${baseLower}.${ext}`)
      );
      return i >= 0 ? files[i] : null;
    };

    const dbfEntry = findFile('dbf');
    if (!dbfEntry) throw new Error(`.dbf missing for ${baseLower}. Files: ${files.join(', ')}`);
    const shxEntry = findFile('shx');
    const prjEntry = findFile('prj');

    const mini = new JSZip();
    mini.file(`${baseLower}.shp`, await originalZip.file(shpEntry).async('arraybuffer'));
    mini.file(`${baseLower}.dbf`, await originalZip.file(dbfEntry).async('arraybuffer'));
    if (shxEntry) mini.file(`${baseLower}.shx`, await originalZip.file(shxEntry).async('arraybuffer'));
    if (prjEntry) mini.file(`${baseLower}.prj`, await originalZip.file(prjEntry).async('string'));

    const rebundled = await mini.generateAsync({ type: 'arraybuffer' });
    return await shp(rebundled);
  }
}

/* ---------- KML ---------- */
async function parseKML(buffer) {
  const { DOMParser } = require('@xmldom/xmldom');
  const xml = new DOMParser().parseFromString(buffer.toString(), 'text/xml');
  const togeo = await import('@tmcw/togeojson');
  return togeo.kml(xml);
}

/* ---------- KMZ ---------- */
async function parseKMZ(buffer) {
  const zip = await JSZip.loadAsync(bufferToArrayBuffer(buffer));
  const names = Object.keys(zip.files);
  const kmlName = names.find((n) => n.toLowerCase().endsWith('.kml'));
  if (!kmlName) throw new Error(`No .kml found inside KMZ. Files: ${names.join(', ')}`);
  const kmlText = await zip.file(kmlName).async('string');
  const { DOMParser } = require('@xmldom/xmldom');
  const xml = new DOMParser().parseFromString(kmlText, 'text/xml');
  const togeo = await import('@tmcw/togeojson');
  return togeo.kml(xml);
}

/* ===================== Rutas ===================== */

// Health
app.get('/health', (_req, res) =>
  res.json({ ok: true, name: 'PreSeeds App', version: '1.0.0' })
);

/**
 * POST /api/process-shp
 * Campo: file  |  Tipos: .zip (SHP), .kml, .kmz
 * Respuesta: { features, geomTypes, areaHa, bbox, crs }
 */
app.post('/api/process-shp', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const filePath = req.file.path;
  const originalName = (req.file.originalname || '').toLowerCase();

  try {
    const buf = await fs.promises.readFile(filePath);
    let geojson;

    if (originalName.endsWith('.zip')) geojson = await parseShapefileZip(buf);
    else if (originalName.endsWith('.kml')) geojson = await parseKML(buf);
    else if (originalName.endsWith('.kmz')) geojson = await parseKMZ(buf);
    else return res.status(400).json({ error: 'Unsupported file type. Use .zip (SHP), .kml or .kmz' });

    const fc = toFC(geojson);

    // Conteo por tipo de geometría
    const geomTypes = {};
    for (const f of fc.features) {
      const t = f?.geometry?.type || 'Unknown';
      geomTypes[t] = (geomTypes[t] || 0) + 1;
    }

    // Área total en hectáreas (suma polígonos; ignora features inválidos)
    let areaHa = 0;
    for (const f of fc.features) {
      try { areaHa += turf.area(f) / 10000; } catch {}
    }

    // BBox [minX, minY, maxX, maxY]
    let bbox = null;
    try { bbox = turf.bbox(fc); } catch {}

    return res.json({
      features: fc.features.length,
      geomTypes,
      areaHa: Number(areaHa.toFixed(2)),
      bbox,
      crs: geojson.crs || null
    });
  } catch (err) {
    console.error('Geom error:', err);
    return res.status(500).json({
      error: 'Error processing geometry',
      message: String(err?.message || err),
    });
  } finally {
    fs.unlink(filePath, () => {}); // limpiar temporal
  }
});

// Demo: perfil productivo
app.post('/api/profile', async (req, res) => {
  try {
    const { lotId, startDate, endDate } = req.body || {};
    if (!lotId) return res.status(400).json({ error: 'lotId is required' });

    // TODO: reemplazar por fuentes reales (GEE, clima, suelo, etc.)
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

// Fallback frontend
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Arranque
app.listen(PORT, () => {
  console.log(`PreSeeds app listening on http://localhost:${PORT}`);
});
