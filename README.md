# PreSeeds App

Backend Node/Express con frontend estático mínimo.

## Requisitos
- Node.js 18+

## Ejecución local
```bash
npm install
npm start
# http://localhost:3000
```

### Endpoints
- `GET /health` → estado del servidor
- `POST /api/profile` → demo (JSON: `{ lotId, startDate, endDate }`)
- `POST /api/process-shp` → subir `.zip` con shapefile (form-data: `file=<archivo>`)

## Deploy en Render
1. Subí este repo a GitHub.
2. En Render.com → New → Web Service → conectá el repo.
3. **Build command:** `npm install`
4. **Start command:** `npm start`
5. Render te dará una URL pública.

> Asegurate de que `server.js` use `process.env.PORT`.
