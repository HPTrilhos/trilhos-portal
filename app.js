// Trilhos Portal — Fase P2: leitura da Drive + cache
//
// Fase P1: login com Google Identity Services (ID token), so identidade.
// Fase P2 (esta): pede um token de acesso com o scope drive.file,
// le a pasta Trilhos/, descarrega cada GPX (uma vez, com cache local
// por data de modificacao) e mostra uma lista simples de percursos.
// O mapa e os pinos entram na Fase P3.

const CLIENT_ID = '271389330523-4jg4e39cgf31v7mecjabj4hji6pjug1k.apps.googleusercontent.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const CACHE_KEY = 'trilhos_portal_cache_v2';
const SESSION_KEY = 'trilhos_portal_session';

const viewLogin = document.getElementById('view-login');
const viewAuthed = document.getElementById('view-authed');
const userAvatar = document.getElementById('user-avatar');
const userEmail = document.getElementById('user-email');
const btnSignout = document.getElementById('btn-signout');
const driveGate = document.getElementById('drive-gate');
const btnLoad = document.getElementById('btn-load');
const btnRefresh = document.getElementById('btn-refresh');
const trackArea = document.getElementById('track-area');
const loadStatus = document.getElementById('load-status');
const trackList = document.getElementById('track-list');

let tokenClient = null;
let accessToken = null;

// ---------------------------------------------------------------
// Sessao (identidade) — Fase P1, inalterado
// ---------------------------------------------------------------

function decodeJwt(token) {
  const payload = token.split('.')[1];
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(decodeURIComponent(escape(json)));
}

function showAuthed(profile) {
  userAvatar.src = profile.picture || '';
  userEmail.textContent = profile.email || '';
  viewLogin.hidden = true;
  viewAuthed.hidden = false;
}

function showLogin() {
  viewLogin.hidden = false;
  viewAuthed.hidden = true;
  driveGate.hidden = false;
  trackArea.hidden = true;
  accessToken = null;
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

// ---------------------------------------------------------------
// Acesso a Drive (Fase P2)
// ---------------------------------------------------------------

function ensureTokenClient() {
  if (tokenClient) return tokenClient;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: (resp) => {
      if (resp.error) {
        loadStatus.textContent = 'Não foi possível autorizar o acesso à Drive. Tenta novamente.';
        return;
      }
      accessToken = resp.access_token;
      loadTracks();
    },
  });
  return tokenClient;
}

function driveHeaders() {
  return { Authorization: `Bearer ${accessToken}` };
}

async function findTrilhosFolder() {
  const q = encodeURIComponent(
    "name='Trilhos' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents"
  );
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, {
    headers: driveHeaders(),
  });
  if (!resp.ok) throw new Error('Não foi possível consultar a Google Drive.');
  const data = await resp.json();
  return (data.files && data.files[0]) ? data.files[0].id : null;
}

async function listGpxFiles(folderId) {
  const q = encodeURIComponent(
    `'${folderId}' in parents and trashed=false and mimeType != 'application/vnd.google-apps.folder'`
  );
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=1000`,
    { headers: driveHeaders() }
  );
  if (!resp.ok) throw new Error('Não foi possível listar os ficheiros da pasta Trilhos/.');
  const data = await resp.json();
  return (data.files || []).filter((f) => f.name.toLowerCase().endsWith('.gpx'));
}

async function downloadGpx(fileId) {
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: driveHeaders(),
  });
  if (!resp.ok) throw new Error('Não foi possível descarregar um percurso.');
  return resp.text();
}

// ---------------------------------------------------------------
// Parser leve: le so os metadados do cabecalho GPX (a mesma
// estrutura <metadata><extensions> escrita pelo gpx_service.dart
// da app). Nao le os milhares de <trkpt> em detalhe — so o
// primeiro, para a Fase P3 saber onde colocar o pino.
// ---------------------------------------------------------------

function parseGpxMeta(xmlText, fallbackName) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) return null;

  const metadata = doc.getElementsByTagName('metadata')[0] || null;
  const metaExt = metadata ? metadata.getElementsByTagName('extensions')[0] : null;

  const ext = {};
  if (metaExt) {
    for (const child of metaExt.children) {
      // "trilhos:distanceMeters" -> localName "distanceMeters"
      ext[child.localName] = child.textContent.trim();
    }
  }

  const trk = doc.getElementsByTagName('trk')[0];
  const trkName = trk ? trk.getElementsByTagName('name')[0]?.textContent : null;
  const metaName = metadata ? metadata.getElementsByTagName('name')[0]?.textContent : null;
  const metaTime = metadata ? metadata.getElementsByTagName('time')[0]?.textContent : null;

  const firstPt = doc.getElementsByTagName('trkpt')[0];
  const lat = firstPt ? parseFloat(firstPt.getAttribute('lat')) : null;
  const lon = firstPt ? parseFloat(firstPt.getAttribute('lon')) : null;

  return {
    fileId: null, // preenchido no chamador (loadTracks), onde o file.id esta disponivel
    name: metaName || trkName || fallbackName,
    date: metaTime ? new Date(metaTime) : null,
    activity: ext.activity || (trk?.getElementsByTagName('type')[0]?.textContent === 'cycling' ? 'bike' : 'walk'),
    locality: ext.locality || null,
    distanceKm: ext.distanceMeters ? parseFloat(ext.distanceMeters) / 1000 : null,
    elevGain: ext.elevGain ? parseFloat(ext.elevGain) : null,
    lat, lon,
  };
}

// ---------------------------------------------------------------
// Cache local (localStorage): evita descarregar de novo um GPX
// cujo modifiedTime na Drive nao mudou desde a ultima visita.
// ---------------------------------------------------------------

function loadCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
  } catch (_) {
    return {};
  }
}

function saveCache(cache) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

// ---------------------------------------------------------------
// Mapa (Fase P3): agrupa percursos por proximidade do ponto de
// partida (~500m) e desenha um pino por zona. Clicar no pino mostra
// um resumo (lista de percursos dessa zona) — a analise completa de
// um percurso (traçado, elevação, Google Earth) entra na Fase P4.
// ---------------------------------------------------------------

const ZONE_RADIUS_M = 500;
let map = null;
let markersLayer = null;

// Distancia aproximada entre duas coordenadas, em metros (formula de Haversine)
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
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

function popupHtml(zone) {
  const list = [...zone.tracks]
    .sort((a, b) => (b.date || 0) - (a.date || 0))
    .map((t) => {
      const km = t.distanceKm != null ? `${t.distanceKm.toFixed(2)} km` : '';
      const icon = t.activity === 'bike' ? '🚴' : '🚶';
      const dateStr = t.date ? t.date.toLocaleDateString('pt-PT') : '';
      return `<div class="popup-track"><span class="n">${icon} ${t.name}<br><small>${dateStr}</small></span><span class="k">${km}</span></div>`;
    })
    .join('');
  return `<div class="popup-zone"><h3>${zone.label}</h3>${list}</div>`;
}

function renderMap(tracks) {
  if (!map) {
    map = L.map('map');
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);
  }

  markersLayer.clearLayers();
  const zones = groupIntoZones(tracks);

  if (zones.length === 0) {
    map.setView([39.5, -8], 6); // vista geral de Portugal por omissao
    return;
  }

  const bounds = [];
  for (const zone of zones) {
    const marker = L.marker([zone.lat, zone.lon], { icon: zoneMarkerIcon(zone.tracks.length) });
    marker.bindPopup(popupHtml(zone));
    marker.addTo(markersLayer);
    bounds.push([zone.lat, zone.lon]);
  }

  if (bounds.length === 1) {
    map.setView(bounds[0], 13);
  } else {
    map.fitBounds(bounds, { padding: [32, 32] });
  }
}

// ---------------------------------------------------------------
// Fluxo principal
// ---------------------------------------------------------------

async function loadTracks() {
  driveGate.hidden = true;
  trackArea.hidden = false;
  loadStatus.textContent = 'A consultar a Google Drive…';
  trackList.innerHTML = '';

  try {
    const folderId = await findTrilhosFolder();
    if (!folderId) {
      loadStatus.textContent = 'Ainda não existe a pasta Trilhos/ na tua Drive — sincroniza um percurso na app primeiro.';
      return;
    }

    const files = await listGpxFiles(folderId);
    const cache = loadCache();
    const tracks = [];
    let downloaded = 0;

    for (const file of files) {
      const cached = cache[file.id];
      if (cached && cached.modifiedTime === file.modifiedTime) {
        tracks.push(cached.meta);
        continue;
      }
      loadStatus.textContent = `A descarregar percursos… (${++downloaded})`;
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
    renderMap(tracks);
    renderTracks(tracks);
    loadStatus.textContent = `${tracks.length} percurso${tracks.length === 1 ? '' : 's'} encontrado${tracks.length === 1 ? '' : 's'} na Drive.`;
  } catch (err) {
    console.error(err);
    loadStatus.textContent = err.message || 'Ocorreu um erro a ler a Google Drive.';
  }
}

function renderTracks(tracks) {
  trackList.innerHTML = '';
  if (tracks.length === 0) {
    const li = document.createElement('li');
    li.className = 'track-empty';
    li.textContent = 'Sem percursos para mostrar.';
    trackList.appendChild(li);
    return;
  }

  tracks.sort((a, b) => (b.date || 0) - (a.date || 0));

  for (const t of tracks) {
    const li = document.createElement('li');
    li.className = 'track-item';

    const icon = document.createElement('div');
    icon.className = 'track-icon';
    icon.textContent = t.activity === 'bike' ? '🚴' : '🚶';

    const info = document.createElement('div');
    info.className = 'track-info';

    const name = document.createElement('span');
    name.className = 'track-name';
    name.textContent = t.locality ? `${t.locality} — ${t.name}` : t.name;

    const meta = document.createElement('span');
    meta.className = 'track-meta';
    const dateStr = t.date ? t.date.toLocaleDateString('pt-PT') : '';
    const kmStr = t.distanceKm != null ? `${t.distanceKm.toFixed(2)} km` : '';
    meta.textContent = [dateStr, kmStr].filter(Boolean).join(' · ');

    info.append(name, meta);
    li.append(icon, info);
    trackList.appendChild(li);
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

btnSignout.addEventListener('click', () => {
  sessionStorage.removeItem(SESSION_KEY);
  if (window.google && google.accounts && google.accounts.id) {
    google.accounts.id.disableAutoSelect();
  }
  showLogin();
});

btnLoad.addEventListener('click', () => {
  ensureTokenClient().requestAccessToken({ prompt: accessToken ? '' : 'consent' });
});

btnRefresh.addEventListener('click', () => {
  if (!accessToken) return;
  loadTracks();
});

init();
