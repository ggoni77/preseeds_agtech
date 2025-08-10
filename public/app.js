async function checkHealth() {
  const el = document.getElementById('healthOutput');
  const status = document.getElementById('status');
  el.textContent = 'Consultando /health...';
  try {
    const res = await fetch('/health');
    const data = await res.json();
    el.textContent = JSON.stringify(data, null, 2);
    status.textContent = data.ok ? 'Online' : 'Offline';
    status.style.color = data.ok ? '#f7bf2c' : 'tomato';
  } catch (e) {
    el.textContent = 'Error consultando /health';
    status.textContent = 'Offline';
    status.style.color = 'tomato';
  }
}

document.getElementById('checkHealth').addEventListener('click', checkHealth);
checkHealth();

document.getElementById('profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = Object.fromEntries(fd.entries());
  const out = document.getElementById('profileOutput');
  out.textContent = 'Consultando /api/profile...';
  try {
    const res = await fetch('/api/profile', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    out.textContent = 'Error en /api/profile';
  }
});

document.getElementById('shpForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const out = document.getElementById('shpOutput');
  out.textContent = 'Subiendo y procesando shapefile...';
  try {
    const res = await fetch('/api/process-shp', { method:'POST', body: fd });
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    out.textContent = 'Error en /api/process-shp';
  }
});
