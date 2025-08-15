// server.js
const express = require('express');
const multer = require('multer');
const JSZip = require('jszip');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

// --- Polyfill necesario para shpjs en Node (Render puede usar Node 20/24)
if (typeof globalThis.self === 'undefined') {
  globalThis.self = globalThis;
}

// En algunos runtimes, require('shpjs') devuelve { default: fn } en vez de la fn directa
const shpModule = require('shpjs');            // debe ser 3.6.3 en package.json
const shp = typeof shpModule === 'function' ? shpModule : (shpModule.default || shpModule);

// Asegurar carpeta de subidas ANTES de usar multer
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Servir frontend estático desde /public
app.use(express.static(path.join(__dirname, 'public')));

// Multer para manejar archivos subidos
const upload = multer({ dest: path.join(__dirname, 'uploads') });

/* ===================== Helpers ===================== */

const bufferToArrayBuffer = (buf) =>
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const countFeatures = (g) => {
  if (!g) return 0;
  if (Array.isArray(g)) return g.reduce((s, x) => s + countFeatures(x), 0);
  if (g.type === 'FeatureCollection' && Array.isArray(g.features)) return g.features.length;
  if (typeof g === 'object') return Object.values(g).reduce((s, x) => s + countFeatures(x), 0);
  return 0;
};

/* ---------- SHP (.zip) ---------- */
async function parseShapefileZip(buf) {
  // 1) Intento directo (zip plano)
  try {
    return await shp(bufferToArrayBuffer(buf));
  } catch (_) {
    // 2) Fallback: rearmar zip “limpio” (tolera subcarpetas y mayúsculas/minúsculas)
    const originalZip = await JSZip.loadAsync(bufferToArrayBuffer(buf));
    const files = Object.keys(originalZip.files);       // nombres originales
    const filesLC = files.map((f) => f.toLowerCase());  // para buscar sin case-sensitive

    const shpIdx = filesLC.findIndex((n) => n.endsWith('.shp'));
    if (shpIdx === -1) throw new Error(`No .shp found in ZIP. Files: ${files.join(', ')}`);

    const shpEntry = files[shpIdx];
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
    if (!dbfEntry) throw new Error(`.dbf missing for ${baseLower}. Files: ${files.join(', ')}`);
    const shxEntry = findFile('shx');
    const prjEntry = findFile('prj');

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
    return await shp(rebundled);
  }
}

/* ---------- KML ---------- */
async function parseKML(buffer) {
  const { DOMParser } = require('@xmldom/xmldom');
  const xml = new DOMParser().parseFromString(buffer.toString(), 'text/xml');
  const togeo = await import('@tmcw/togeojson'); // ESM dinámico
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

// Healthcheck
app.get('/health', (_req, res) =>
  res.json({ ok: true, name: 'PreSeeds App', version: '1.0.0' })
);

/**
 * POST /api/process-shp
 * Acepta: .zip (SHP), .kml, .kmz
 * Campo: file
 */
app.post('/api/process-shp', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const filePath = req.file.path;
  const originalName = (req.file.originalname || '').toLowerCase();

  try {
    const buf = await fs.promises.readFile(filePath);
    let geojson;

    if (originalName.endsWith('.zip')) {
      geojson = await parseShapefileZip(buf);
    } else if (originalName.endsWith('.kml')) {
      geojson = await parseKML(buf);
    } else if (originalName.endsWith('.kmz')) {
      geojson = await parseKMZ(buf);
    } else {
      return res.status(400).json({
        error: 'Unsupported file type. Use .zip (SHP), .kml or .kmz'
      });
    }

    const features = countFeatures(geojson);
    return res.json({ features });
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

// Demo: endpoint de perfil productivo
app.post('/api/profile', async (req, res) => {
  try {
    const { lotId, startDate, endDate } = req.body || {};
    if (!lotId) return res.status(400).json({ error: 'lotId is required' });

    // TODO: reemplazar con fuentes reales (GEE, clima, suelo, etc.)
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

// Fallback: servir index.html del frontend
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Arranque
app.listen(PORT, () => {
  console.log(`PreSeeds app listening on http://localhost:${PORT}`);
});
