// Trilhos Portal — reorganização: barra superior fixa com separadores de
// atividade e filtros, mapa a toda a largura, painel lateral sempre visível
// com 3 estados: resumo (queijo anual + acordeão de meses), zona (percursos
// de um pino), detalhe (traçado + métricas + elevação de um percurso).

const CLIENT_ID = '271389330523-4jg4e39cgf31v7mecjabj4hji6pjug1k.apps.googleusercontent.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const CACHE_KEY = 'trilhos_portal_cache_v3';
const SESSION_KEY = 'trilhos_portal_session';
const TOKEN_KEY = 'trilhos_portal_token_v1';
const TOKEN_SAFETY_MARGIN_MS = 60 * 1000;
const ZONE_RADIUS_M = 500;

const MONTH_COLORS = ['#1565C0', '#00838F', '#2E7D32', '#558B2F', '#9E9D24', '#F9A825', '#EF6C00', '#D84315', '#C62828', '#AD1457', '#6A1B9A', '#4527A0'];
const MONTH_ABBR = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MONTH_NAMES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

// ---- Referencias DOM ----
const viewLogin = document.getElementById('view-login');
const viewAuthed = document.getElementById('view-authed');
const gSignInWrap = document.getElementById('g-signin-wrap');
const sessionChip = document.getElementById('session-chip');
const sessionToggle = document.getElementById('session-toggle');
const sessionPopover = document.getElementById('session-popover');
const popoverAvatar = document.getElementById('popover-avatar');
const popoverEmail = document.getElementById('popover-email');
const btnSignout = document.getElementById('btn-signout');
const driveGateWrap = document.getElementById('drive-gate-wrap');
const btnLoad = document.getElementById('btn-load');
const globalStatus = document.getElementById('global-status');
const appLayout = document.getElementById('app-layout');
const filterBar = document.getElementById('filter-bar');
const sidePanel = document.getElementById('side-panel');
const btnHome = document.getElementById('btn-home');
const selDistance = document.getElementById('filter-distance');
const selElevation = document.getElementById('filter-elevation');

let tokenClient = null;
let accessToken = null;
let allTracks = [];
let map = null;
let markersLayer = null;
let selectedLayer = null;

// Estado de navegacao do painel lateral
let panelState = 'summary'; // 'summary' | 'zone' | 'detail'
let currentZone = null;
let currentYear = null;
let detailBackTo = null;
let detailBackZone = null;
const expandedMonths = new Set();
const fullGpxCache = {};

// Filtros (afetam mapa + painel; qualquer alteracao volta ao resumo geral)
let filterActivity = 'all';
let filterMinDistance = 0;
let filterMinElevation = 0;

// ---------------------------------------------------------------
// Utilitarios
// ---------------------------------------------------------------

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

function fmtDuration(totalSeconds) {
  if (totalSeconds == null) return '—';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.round(totalSeconds % 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

function metricHtml(label, value) {
  return `<div class="metric"><span class="m-label">${label}</span><span class="m-value">${value}</span></div>`;
}

function setStatus(msg, isError) {
  globalStatus.hidden = !msg;
  globalStatus.textContent = msg || '';
  globalStatus.classList.toggle('error', !!isError);
}

// ---------------------------------------------------------------
// Sessao (identidade Google)
// ---------------------------------------------------------------

function decodeJwt(token) {
  const payload = token.split('.')[1];
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(decodeURIComponent(escape(json)));
}

function showAuthed(profile) {
  popoverAvatar.src = profile.picture || '';
  popoverEmail.textContent = profile.email || '';
  viewLogin.hidden = true;
  viewAuthed.hidden = false;
  gSignInWrap.hidden = true;
  sessionChip.hidden = false;
}

function showLogin() {
  viewLogin.hidden = false;
  viewAuthed.hidden = true;
  gSignInWrap.hidden = false;
  sessionChip.hidden = true;
  sessionPopover.hidden = true;
  driveGateWrap.hidden = false;
  appLayout.hidden = true;
  filterBar.hidden = true;
  accessToken = null;
  document.getElementById('drive-gate-note').innerHTML =
    'Falta autorizar o acesso à pasta <strong>Trilhos/</strong> na tua Google Drive (só os ficheiros criados pela app — nada mais é tocado).';
}

function handleCredentialResponse(response) {
  try {
    const profile = decodeJwt(response.credential);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(profile));
    showAuthed(profile);
  } catch (err) {
    console.error('Falha ao processar a sessão Google:', err);
  }
}

sessionToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  sessionPopover.hidden = !sessionPopover.hidden;
});
document.addEventListener('click', (e) => {
  if (!sessionPopover.hidden && !sessionChip.contains(e.target)) sessionPopover.hidden = true;
});

btnSignout.addEventListener('click', () => {
  sessionStorage.removeItem(SESSION_KEY);
  clearToken();
  if (window.google && google.accounts && google.accounts.id) {
    google.accounts.id.disableAutoSelect();
  }
  showLogin();
});

// ---------------------------------------------------------------
// Token de acesso a Drive (persistido em localStorage)
// ---------------------------------------------------------------

function saveToken(accessTokenValue, expiresInSeconds) {
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: accessTokenValue, expiresAt }));
}

function loadValidToken() {
  try {
    const saved = JSON.parse(localStorage.getItem(TOKEN_KEY));
    if (saved && saved.expiresAt - TOKEN_SAFETY_MARGIN_MS > Date.now()) return saved.token;
  } catch (_) { /* sem token guardado ou invalido */ }
  return null;
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function ensureTokenClient() {
  if (tokenClient) return tokenClient;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: (resp) => {
      if (resp.error) {
        setStatus('Não foi possível autorizar o acesso à Drive. Tenta novamente.', true);
        return;
      }
      accessToken = resp.access_token;
      saveToken(resp.access_token, resp.expires_in);
      loadTracks();
    },
  });
  return tokenClient;
}

btnLoad.addEventListener('click', () => {
  ensureTokenClient().requestAccessToken({ prompt: accessToken ? '' : 'consent' });
});

// ---------------------------------------------------------------
// Acesso a Drive
// ---------------------------------------------------------------

function driveHeaders() {
  return { Authorization: `Bearer ${accessToken}` };
}

class DriveAuthError extends Error {}

async function findTrilhosFolder() {
  const q = encodeURIComponent(
    "name='Trilhos' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents"
  );
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, { headers: driveHeaders() });
  if (resp.status === 401) throw new DriveAuthError('Sessão de acesso à Drive expirada');
  if (!resp.ok) throw new Error('Não foi possível consultar a Google Drive.');
  const data = await resp.json();
  return (data.files && data.files[0]) ? data.files[0].id : null;
}

async function listGpxFiles(folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and mimeType != 'application/vnd.google-apps.folder'`);
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=1000`, { headers: driveHeaders() });
  if (resp.status === 401) throw new DriveAuthError('Sessão de acesso à Drive expirada');
  if (!resp.ok) throw new Error('Não foi possível listar os ficheiros da pasta Trilhos/.');
  const data = await resp.json();
  return (data.files || []).filter((f) => f.name.toLowerCase().endsWith('.gpx'));
}

async function downloadGpx(fileId) {
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: driveHeaders() });
  if (resp.status === 401) throw new DriveAuthError('Sessão de acesso à Drive expirada');
  if (!resp.ok) throw new Error('Não foi possível descarregar um percurso.');
  return resp.text();
}

// ---------------------------------------------------------------
// Parser leve: metadados do cabecalho GPX (nome, data, distancia,
// atividade, localidade, duracao/passos para as estatisticas mensais,
// e as coordenadas do primeiro ponto para o agrupamento por zona).
// ---------------------------------------------------------------

function parseGpxMeta(xmlText, fallbackName) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) return null;

  const metadata = doc.getElementsByTagName('metadata')[0] || null;
  const metaExt = metadata ? metadata.getElementsByTagName('extensions')[0] : null;
  const ext = {};
  if (metaExt) {
    for (const child of metaExt.children) ext[child.localName] = child.textContent.trim();
  }

  const trk = doc.getElementsByTagName('trk')[0];
  const trkName = trk ? trk.getElementsByTagName('name')[0]?.textContent : null;
  const metaName = metadata ? metadata.getElementsByTagName('name')[0]?.textContent : null;
  const metaTime = metadata ? metadata.getElementsByTagName('time')[0]?.textContent : null;

  const firstPt = doc.getElementsByTagName('trkpt')[0];
  const lat = firstPt ? parseFloat(firstPt.getAttribute('lat')) : null;
  const lon = firstPt ? parseFloat(firstPt.getAttribute('lon')) : null;

  return {
    fileId: null, // preenchido pelo chamador
    name: metaName || trkName || fallbackName,
    date: metaTime ? new Date(metaTime) : null,
    activity: ext.activity || (trk?.getElementsByTagName('type')[0]?.textContent === 'cycling' ? 'bike' : 'walk'),
    locality: ext.locality || null,
    distanceKm: ext.distanceMeters ? parseFloat(ext.distanceMeters) / 1000 : null,
    durationSeconds: ext.durationSeconds ? parseInt(ext.durationSeconds, 10) : null,
    movingSeconds: ext.movingSeconds ? parseInt(ext.movingSeconds, 10) : null,
    steps: ext.steps ? parseInt(ext.steps, 10) : null,
    elevGain: ext.elevGain ? parseFloat(ext.elevGain) : null,
    lat, lon,
  };
}

// ---------------------------------------------------------------
// Cache local (localStorage)
// ---------------------------------------------------------------

function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch (_) { return {}; }
}
function saveCache(cache) { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); }

// ---------------------------------------------------------------
// Fluxo principal: ler a Drive e preencher allTracks
// ---------------------------------------------------------------

async function loadTracks() {
  driveGateWrap.hidden = true;
  appLayout.hidden = false;
  filterBar.hidden = false;
  setStatus('A consultar a Google Drive…');

  try {
    const folderId = await findTrilhosFolder();
    if (!folderId) {
      setStatus('Ainda não existe a pasta Trilhos/ na tua Drive — sincroniza um percurso na app primeiro.');
      appLayout.hidden = true;
      filterBar.hidden = true;
      return;
    }

    const files = await listGpxFiles(folderId);
    const cache = loadCache();
    const tracks = [];
    let downloaded = 0;

    for (const file of files) {
      const cached = cache[file.id];
      if (cached && cached.modifiedTime === file.modifiedTime) {
        const meta = { ...cached.meta, date: cached.meta.date ? new Date(cached.meta.date) : null };
        tracks.push(meta);
        continue;
      }
      setStatus(`A descarregar percursos… (${++downloaded})`);
      try {
        const xml = await downloadGpx(file.id);
        const meta = parseGpxMeta(xml, file.name);
        if (meta) {
          meta.fileId = file.id;
          cache[file.id] = { modifiedTime: file.modifiedTime, meta };
          tracks.push(meta);
        }
      } catch (err) {
        console.warn(`Não foi possível ler ${file.name}:`, err);
      }
    }

    saveCache(cache);
    allTracks = tracks;
    setStatus(`${tracks.length} percurso${tracks.length === 1 ? '' : 's'} encontrado${tracks.length === 1 ? '' : 's'} na Drive.`);
    goHome();
  } catch (err) {
    if (err instanceof DriveAuthError) {
      clearToken();
      accessToken = null;
      appLayout.hidden = true;
      filterBar.hidden = true;
      driveGateWrap.hidden = false;
      document.getElementById('drive-gate-note').textContent =
        'A autorização de acesso à Drive expirou. Autoriza novamente para continuar.';
      return;
    }
    console.error(err);
    setStatus(err.message || 'Ocorreu um erro a ler a Google Drive.', true);
  }
}

// ---------------------------------------------------------------
// Filtros
// ---------------------------------------------------------------

function getVisibleTracks() {
  return allTracks.filter((t) => {
    if (filterActivity !== 'all' && t.activity !== filterActivity) return false;
    if (filterMinDistance > 0 && (t.distanceKm == null || t.distanceKm < filterMinDistance)) return false;
    if (filterMinElevation > 0 && (t.elevGain == null || t.elevGain < filterMinElevation)) return false;
    return true;
  });
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    filterActivity = btn.dataset.activity;
    goHome();
  });
});
selDistance.addEventListener('change', (e) => { filterMinDistance = parseInt(e.target.value, 10); goHome(); });
selElevation.addEventListener('change', (e) => { filterMinElevation = parseInt(e.target.value, 10); goHome(); });
btnHome.addEventListener('click', goHome);

// ---------------------------------------------------------------
// Mapa: agrupamento por zona (~500m) e desenho dos pinos
// ---------------------------------------------------------------

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function groupIntoZones(tracks) {
  const zones = [];
  for (const t of tracks) {
    if (t.lat == null || t.lon == null) continue;
    let zone = zones.find((z) => haversineM(z.lat, z.lon, t.lat, t.lon) <= ZONE_RADIUS_M);
    if (!zone) {
      zone = { lat: t.lat, lon: t.lon, label: t.locality || t.name, tracks: [] };
      zones.push(zone);
    }
    zone.tracks.push(t);
  }
  return zones;
}

function zoneMarkerIcon(count) {
  return L.divIcon({
    className: '',
    html: `<div class="zone-marker" style="width:${count > 1 ? 34 : 26}px;height:${count > 1 ? 34 : 26}px;">${count}</div>`,
    iconSize: count > 1 ? [34, 34] : [26, 26],
  });
}

function renderMap(tracks) {
  if (!map) {
    map = L.map('map');
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);
    selectedLayer = L.layerGroup().addTo(map);
  }

  markersLayer.clearLayers();
  const zones = groupIntoZones(tracks);

  if (zones.length === 0) {
    map.setView([39.5, -8], 6);
    return;
  }

  const bounds = [];
  for (const zone of zones) {
    const marker = L.marker([zone.lat, zone.lon], { icon: zoneMarkerIcon(zone.tracks.length) });
    marker.on('click', () => openZone(zone));
    marker.addTo(markersLayer);
    bounds.push([zone.lat, zone.lon]);
  }

  if (bounds.length === 1) map.setView(bounds[0], 13);
  else map.fitBounds(bounds, { padding: [32, 32] });
}

// ---------------------------------------------------------------
// Navegacao do painel lateral
// ---------------------------------------------------------------

function goHome() {
  panelState = 'summary';
  currentZone = null;
  if (selectedLayer) selectedLayer.clearLayers();
  const visible = getVisibleTracks();
  renderMap(visible);
  renderSummaryPanel(visible);
}

function openZone(zone) {
  panelState = 'zone';
  currentZone = zone;
  if (selectedLayer) selectedLayer.clearLayers();
  map.setView([zone.lat, zone.lon], Math.max(map.getZoom(), 13));
  renderZonePanel(zone);
}

function trackItemHtml(t) {
  const km = t.distanceKm != null ? `${t.distanceKm.toFixed(2)} km` : '';
  const dateStr = t.date ? t.date.toLocaleDateString('pt-PT') : '';
  // Evita duplicar a data quando o nome do percurso ja e a propria data
  // (o nome por omissao da app, se nunca foi renomeado)
  const showDate = dateStr && t.name !== dateStr;
  const meta = [showDate ? dateStr : null, km].filter(Boolean).join(' · ');
  return `<li><button class="panel-track-item" data-fileid="${esc(t.fileId || '')}">
    <span class="pt-icon">${t.activity === 'bike' ? '🚴' : '🚶'}</span>
    <span class="pt-info">
      <span class="pt-name">${esc(t.name)}</span>
      <span class="pt-meta">${meta}</span>
    </span>
  </button></li>`;
}

function attachTrackItemHandlers(pool, backTo, zoneRef) {
  sidePanel.querySelectorAll('.panel-track-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const track = pool.find((t) => t.fileId === btn.dataset.fileid);
      if (track) openTrackDetail(track, backTo, zoneRef);
    });
  });
}

// ---- Estado 1: resumo (queijo anual + acordeao de meses) ----

function buildPieSvg(kmByMonth) {
  const months = Object.keys(kmByMonth).map(Number).sort((a, b) => a - b);
  const total = months.reduce((s, m) => s + kmByMonth[m], 0);
  if (total <= 0) return '<p class="pie-empty">Sem distância registada.</p>';

  const cx = 100, cy = 100, r = 92;

  // Caso especial: um so mes = 100% da distancia. Um arco SVG nao
  // consegue desenhar uma volta completa num unico comando (o ponto
  // inicial e final coincidem e o navegador nao desenha nada) —
  // usa-se um circulo simples em vez de um arco degenerado.
  if (months.length === 1) {
    const m = months[0];
    return `
      <svg viewBox="0 0 200 200" class="pie-svg" role="img" aria-label="Distância por mês">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="${MONTH_COLORS[m - 1]}" />
        <text x="${cx}" y="${cy - 6}" text-anchor="middle" class="pie-label" style="font-size:16px">${MONTH_ABBR[m - 1]}</text>
        <text x="${cx}" y="${cy + 14}" text-anchor="middle" class="pie-label pie-label-km" style="font-size:12px">${kmByMonth[m].toFixed(0)} km</text>
      </svg>`;
  }

  let angle = -Math.PI / 2;
  let svg = `<svg viewBox="0 0 200 200" class="pie-svg" role="img" aria-label="Distância por mês">`;
  for (const m of months) {
    const sweep = (kmByMonth[m] / total) * 2 * Math.PI;
    const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
    const end = angle + sweep;
    const x2 = cx + r * Math.cos(end), y2 = cy + r * Math.sin(end);
    const large = sweep > Math.PI ? 1 : 0;
    svg += `<path d="M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${MONTH_COLORS[m - 1]}" stroke="#fff" stroke-width="2"></path>`;
    if (sweep > 0.45) {
      const mid = angle + sweep / 2;
      const lx = cx + r * 0.62 * Math.cos(mid), ly = cy + r * 0.62 * Math.sin(mid);
      svg += `<text x="${lx.toFixed(1)}" y="${(ly - 3).toFixed(1)}" text-anchor="middle" class="pie-label">${MONTH_ABBR[m - 1]}</text>`;
      svg += `<text x="${lx.toFixed(1)}" y="${(ly + 10).toFixed(1)}" text-anchor="middle" class="pie-label pie-label-km">${kmByMonth[m].toFixed(0)} km</text>`;
    }
    angle = end;
  }
  svg += `</svg>`;
  return svg;
}

function renderSummaryPanel(visible) {
  const withDate = visible.filter((t) => t.date);
  const years = [...new Set(withDate.map((t) => t.date.getFullYear()))].sort((a, b) => a - b);

  if (years.length === 0) {
    sidePanel.innerHTML = `
      <div class="panel-summary-header">
        <h2 class="panel-title">Os teus percursos</h2>
        <button id="btn-refresh" class="icon-btn" title="Atualizar">⟳</button>
      </div>
      <p class="track-empty">Sem percursos para os filtros selecionados.</p>`;
    document.getElementById('btn-refresh').addEventListener('click', () => { if (accessToken) loadTracks(); });
    return;
  }

  if (currentYear == null || !years.includes(currentYear)) currentYear = years[years.length - 1];
  const idx = years.indexOf(currentYear);
  const tracksYear = withDate.filter((t) => t.date.getFullYear() === currentYear);

  const kmByMonth = {};
  const byMonth = {};
  for (const t of tracksYear) {
    const m = t.date.getMonth() + 1;
    if (t.distanceKm != null) kmByMonth[m] = (kmByMonth[m] || 0) + t.distanceKm;
    (byMonth[m] = byMonth[m] || []).push(t);
  }
  const months = Object.keys(byMonth).map(Number).sort((a, b) => b - a);

  const anyExpanded = months.some((m) => expandedMonths.has(`${currentYear}-${m}`));
  if (!anyExpanded && months.length) expandedMonths.add(`${currentYear}-${months[0]}`);

  let html = `
    <div class="panel-summary-header">
      <h2 class="panel-title">Os teus percursos</h2>
      <button id="btn-refresh" class="icon-btn" title="Atualizar">⟳</button>
    </div>
    <div class="year-nav">
      <button id="year-prev" class="icon-btn" ${idx === 0 ? 'disabled' : ''}>‹</button>
      <span class="year-label">${currentYear}</span>
      <button id="year-next" class="icon-btn" ${idx === years.length - 1 ? 'disabled' : ''}>›</button>
    </div>
    ${buildPieSvg(kmByMonth)}
  `;

  for (const m of months) {
    const list = byMonth[m].sort((a, b) => b.date - a.date);
    const dist = list.reduce((s, t) => s + (t.distanceKm || 0), 0);
    const dur = list.reduce((s, t) => s + (t.durationSeconds || 0), 0);
    const mov = list.reduce((s, t) => s + (t.movingSeconds || t.durationSeconds || 0), 0);
    const gain = list.reduce((s, t) => s + (t.elevGain || 0), 0);
    const steps = list.reduce((s, t) => s + (t.steps || 0), 0);
    const expanded = expandedMonths.has(`${currentYear}-${m}`);

    html += `
      <div class="month-card">
        <button class="month-header" data-month="${m}">
          <span class="month-dot" style="background:${MONTH_COLORS[m - 1]}"></span>
          <span class="month-name">${MONTH_NAMES[m - 1]} ${currentYear}</span>
          <span class="month-chevron">${expanded ? '▾' : '▸'}</span>
        </button>
        <p class="month-stats">${dist.toFixed(1)} km · ${list.length} percurso${list.length === 1 ? '' : 's'} · ${fmtDuration(dur)} (mov. ${fmtDuration(mov)}) · ↑ ${gain.toFixed(0)} m · ${steps} passos</p>
        <ul class="month-tracks" ${expanded ? '' : 'hidden'}>${list.map(trackItemHtml).join('')}</ul>
      </div>`;
  }

  sidePanel.innerHTML = html;

  document.getElementById('btn-refresh').addEventListener('click', () => { if (accessToken) loadTracks(); });
  const prevBtn = document.getElementById('year-prev');
  const nextBtn = document.getElementById('year-next');
  if (prevBtn) prevBtn.addEventListener('click', () => { currentYear = years[idx - 1]; renderSummaryPanel(getVisibleTracks()); });
  if (nextBtn) nextBtn.addEventListener('click', () => { currentYear = years[idx + 1]; renderSummaryPanel(getVisibleTracks()); });

  sidePanel.querySelectorAll('.month-header').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = `${currentYear}-${btn.dataset.month}`;
      if (expandedMonths.has(key)) expandedMonths.delete(key); else expandedMonths.add(key);
      renderSummaryPanel(getVisibleTracks());
    });
  });

  attachTrackItemHandlers(tracksYear, 'summary', null);
}

// ---- Estado 2: percursos de uma zona ----

function renderZonePanel(zone) {
  const list = [...zone.tracks].sort((a, b) => (b.date || 0) - (a.date || 0));
  sidePanel.innerHTML = `
    <button id="zone-home" class="panel-back">‹ Início</button>
    <h2 class="panel-title">${esc(zone.label)}</h2>
    <ul class="panel-track-list">${list.map(trackItemHtml).join('')}</ul>
  `;
  document.getElementById('zone-home').addEventListener('click', goHome);
  attachTrackItemHandlers(zone.tracks, 'zone', zone);
}

// ---- Estado 3: percurso expandido (tracado + metricas + elevacao) ----

function buildElevationProfile(points, cumDist) {
  const valid = [];
  for (let i = 0; i < points.length; i++) {
    if (points[i].ele != null) valid.push({ d: cumDist[i], e: points[i].ele });
  }
  if (valid.length < 2) return null;

  const totalD = valid[valid.length - 1].d || 1;
  const eles = valid.map((p) => p.e);
  const eMin = Math.min(...eles);
  const eMax = Math.max(...eles);
  const range = Math.max(eMax - eMin, 1);
  const W = 400, H = 130, PAD = 6;

  const coords = valid.map((p) => {
    const x = (p.d / totalD) * W;
    const y = PAD + (1 - (p.e - eMin) / range) * (H - PAD * 2);
    return [x, y];
  });

  const linePoints = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPoints = `0,${H} ${linePoints} ${W},${H}`;
  return { linePoints, areaPoints, eMin, eMax };
}

function parseGpxFull(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) return null;

  const metadata = doc.getElementsByTagName('metadata')[0] || null;
  const metaExt = metadata ? metadata.getElementsByTagName('extensions')[0] : null;
  const ext = {};
  if (metaExt) { for (const child of metaExt.children) ext[child.localName] = child.textContent.trim(); }

  const points = [];
  for (const pt of doc.getElementsByTagName('trkpt')) {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    const eleEl = pt.getElementsByTagName('ele')[0];
    points.push({ lat, lon, ele: eleEl ? parseFloat(eleEl.textContent) : null });
  }
  if (points.length < 2) return null;

  let cum = 0;
  const cumDist = [0];
  for (let i = 1; i < points.length; i++) {
    cum += haversineM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    cumDist.push(cum);
  }

  const distanceKm = ext.distanceMeters ? parseFloat(ext.distanceMeters) / 1000 : cum / 1000;
  const durationSeconds = ext.durationSeconds ? parseInt(ext.durationSeconds, 10) : null;
  const movingSeconds = ext.movingSeconds ? parseInt(ext.movingSeconds, 10) : durationSeconds;
  const avgSpeedKmh = ext.avgSpeedKmh ? parseFloat(ext.avgSpeedKmh) : (movingSeconds ? distanceKm / (movingSeconds / 3600) : null);

  return {
    points, cumDist, distanceKm, durationSeconds, movingSeconds, avgSpeedKmh,
    steps: ext.steps ? parseInt(ext.steps, 10) : null,
    elevGain: ext.elevGain ? parseFloat(ext.elevGain) : null,
    elevLoss: ext.elevLoss ? parseFloat(ext.elevLoss) : null,
    pauseSeconds: ext.pauseSeconds ? parseInt(ext.pauseSeconds, 10) : null,
  };
}

async function openTrackDetail(track, backTo, zoneRef) {
  panelState = 'detail';
  detailBackTo = backTo;
  detailBackZone = zoneRef || currentZone;

  const dateStr = track.date ? track.date.toLocaleDateString('pt-PT') : '';
  const showDate = dateStr && track.name !== dateStr;

  sidePanel.innerHTML = `
    <button id="detail-back" class="panel-back">‹ Voltar</button>
    <h2 class="panel-title">${esc(track.name)}</h2>
    ${showDate ? `<p class="detail-sub">${dateStr}</p>` : ''}
    <div id="detail-body"><p class="loading-note">A carregar percurso…</p></div>
  `;
  document.getElementById('detail-back').addEventListener('click', () => {
    if (detailBackTo === 'zone' && detailBackZone) {
      panelState = 'zone';
      currentZone = detailBackZone;
      if (selectedLayer) selectedLayer.clearLayers();
      renderZonePanel(detailBackZone);
    } else {
      goHome();
    }
  });

  const body = document.getElementById('detail-body');
  try {
    let detail = fullGpxCache[track.fileId];
    if (!detail) {
      const xml = await downloadGpx(track.fileId);
      detail = parseGpxFull(xml);
      if (detail) fullGpxCache[track.fileId] = detail;
    }
    if (!detail) {
      body.innerHTML = `<p class="loading-note">Não foi possível ler este percurso.</p>`;
      return;
    }

    const metrics = [
      metricHtml('Distância', `${detail.distanceKm.toFixed(2)} km`),
      metricHtml('Duração', fmtDuration(detail.durationSeconds)),
    ];
    if (detail.movingSeconds != null && detail.movingSeconds !== detail.durationSeconds) {
      metrics.push(metricHtml('Em movimento', fmtDuration(detail.movingSeconds)));
    }
    if (detail.avgSpeedKmh != null) metrics.push(metricHtml('Vel. média', `${detail.avgSpeedKmh.toFixed(1)} km/h`));
    if (detail.steps != null) metrics.push(metricHtml('Passos', detail.steps));
    if (detail.elevGain != null) metrics.push(metricHtml('Subida', `${detail.elevGain.toFixed(0)} m`));
    if (detail.elevLoss != null) metrics.push(metricHtml('Descida', `${detail.elevLoss.toFixed(0)} m`));
    if (detail.pauseSeconds) metrics.push(metricHtml('Pausas', fmtDuration(detail.pauseSeconds)));

    let elevHtml = '';
    const profile = buildElevationProfile(detail.points, detail.cumDist);
    if (profile) {
      elevHtml = `
        <p class="elev-label">Perfil de elevação</p>
        <svg viewBox="0 0 400 130" class="elev-chart" preserveAspectRatio="none">
          <polygon points="${profile.areaPoints}" fill="#E8F5E9" />
          <polyline points="${profile.linePoints}" fill="none" stroke="#2E7D32" stroke-width="2.5" />
        </svg>
        <div class="elev-scale"><span>${profile.eMin.toFixed(0)} m</span><span>${profile.eMax.toFixed(0)} m</span></div>`;
    }

    body.innerHTML = `<div class="metrics-grid">${metrics.join('')}</div>${elevHtml}`;

    if (selectedLayer) selectedLayer.clearLayers();
    const latlngs = detail.points.map((p) => [p.lat, p.lon]);
    const poly = L.polyline(latlngs, { color: '#2E7D32', weight: 4 }).addTo(selectedLayer);
    L.circleMarker(latlngs[0], { radius: 6, color: '#fff', weight: 2, fillColor: '#2E7D32', fillOpacity: 1 }).addTo(selectedLayer);
    L.circleMarker(latlngs[latlngs.length - 1], { radius: 6, color: '#fff', weight: 2, fillColor: '#C62828', fillOpacity: 1 }).addTo(selectedLayer);
    map.fitBounds(poly.getBounds(), { padding: [28, 28] });
  } catch (err) {
    console.error(err);
    body.innerHTML = `<p class="loading-note">Erro ao carregar o percurso.</p>`;
  }
}

// ---------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------

function init() {
  const saved = sessionStorage.getItem(SESSION_KEY);
  if (saved) {
    try {
      showAuthed(JSON.parse(saved));
      const validToken = loadValidToken();
      if (validToken) {
        accessToken = validToken;
        loadTracks();
      }
    } catch (_) {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }

  if (!window.google || !google.accounts || !google.accounts.id) {
    setTimeout(init, 300);
    return;
  }

  google.accounts.id.initialize({
    client_id: CLIENT_ID,
    callback: handleCredentialResponse,
    auto_select: false,
  });

  google.accounts.id.renderButton(
    document.getElementById('g_id_signin'),
    { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with' }
  );
}

init();
