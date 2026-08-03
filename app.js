// ============================================
// Bitácora Sonora — lógica principal
// ============================================

document.getElementById('wordmark').firstChild.textContent = SITE_NAME + ' ';
document.getElementById('wordmark-sub').textContent = SITE_OWNER ? `DIARIO DE ${SITE_OWNER.toUpperCase()}` : 'DIARIO DE ESCUCHA';
document.title = SITE_NAME;

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let session = null;
let currentAlbum = null; // álbum elegido en la búsqueda, con tracks temporales

// ---------- Navegación entre vistas ----------

function switchView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('nav.site-nav button').forEach(b => {
    b.classList.toggle('active', b.dataset.view === name);
  });
  if (name === 'shelf') loadShelf();
}

document.querySelectorAll('nav.site-nav button').forEach(b => {
  b.addEventListener('click', () => switchView(b.dataset.view));
});

// ---------- Sesión / login del dueño ----------

async function refreshSession() {
  const { data } = await sb.auth.getSession();
  session = data.session;
  const fab = document.getElementById('login-fab');
  fab.textContent = session ? 'Editor ✓' : 'Editor';
  fab.classList.toggle('owned', !!session);
}
refreshSession();

document.getElementById('login-fab').addEventListener('click', () => {
  if (session) {
    sb.auth.signOut().then(refreshSession);
  } else {
    document.getElementById('login-modal').classList.add('active');
  }
});

document.getElementById('login-cancel').addEventListener('click', () => {
  document.getElementById('login-modal').classList.remove('active');
});

document.getElementById('login-submit').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const pass = document.getElementById('login-pass').value;
  const msg = document.getElementById('login-msg');
  msg.textContent = 'Verificando…';
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
  if (error) {
    msg.textContent = 'No se pudo entrar: ' + error.message;
  } else {
    msg.textContent = '';
    document.getElementById('login-modal').classList.remove('active');
    await refreshSession();
  }
});

// ---------- Sello de calificación (elemento firma) ----------

function stampHTML(rating, max = 10) {
  if (rating === null || rating === undefined) {
    return `<span class="stamp empty mono">SIN<br>SELLO</span>`;
  }
  return `<span class="stamp mono"><span class="num">${Number(rating).toFixed(1)}</span><span class="of">/${max}</span></span>`;
}

// ---------- Búsqueda en catálogo iTunes ----------

document.getElementById('search-btn').addEventListener('click', runSearch);
document.getElementById('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') runSearch();
});

// palabras/etiquetas que delatan discos "tributo"/karaoke que no son el álbum real
const JUNK_PATTERNS = [
  'karaoke', 'tribute', 'made famous', 'originally performed',
  'in the style of', 'as made famous', 'cover version', 'this is a tribute',
  'a tribute to', 'performed by', 'sound-alike', 'soundalike', 'instrumental version',
  'backing track', 'studio band', 'party tyme', 'ameritz', 'vox freaks',
  'sing karaoke', 'starlite karaoke', 'karaoke universe', 'missing link karaoke',
  'the karaoke channel', 'high score karaoke'
];

function isJunkText(text) {
  const t = (text || '').toLowerCase();
  return JUNK_PATTERNS.some(p => t.includes(p));
}

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca acentos
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchJSON(url) {
  const res = await fetch(url);
  return res.json();
}

// ---- Paso 1: encontrar el/los artistas REALES a los que se refiere la búsqueda ----
async function findArtistCandidates(term) {
  const [byTerm, general] = await Promise.all([
    fetchJSON(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=musicArtist&attribute=artistTerm&country=US&limit=10`),
    fetchJSON(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=musicArtist&country=US&limit=10`)
  ]);

  const merged = new Map();
  [...(byTerm.results || []), ...(general.results || [])].forEach(a => {
    if (a.artistId) merged.set(a.artistId, a);
  });

  const queryNorm = normalize(term);
  const queryWords = queryNorm.split(' ').filter(Boolean);

  const scored = Array.from(merged.values())
    .filter(a => a.primaryGenreName !== 'Karaoke') // Apple etiqueta así a los sellos de karaoke
    .filter(a => !isJunkText(a.artistName))
    .map(a => {
      const name = normalize(a.artistName);
      let score = 0;
      if (name === queryNorm) score += 50;
      if (queryNorm.includes(name) || name.includes(queryNorm)) score += 25;
      const nameWords = name.split(' ').filter(Boolean);
      const hits = nameWords.filter(w => queryWords.includes(w)).length;
      if (nameWords.length) score += (hits / nameWords.length) * 30;
      return { artist: a, score };
    })
    .filter(x => x.score >= 15) // umbral: evita "adivinar" un artista sin relación real
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 3).map(x => x.artist);
}

// ---- Paso 2: traer la discografía oficial real de ese artistId ----
async function albumsForArtist(artistId) {
  const json = await fetchJSON(`https://itunes.apple.com/lookup?id=${artistId}&entity=album&limit=200&country=US`);
  return (json.results || []).filter(r => r.wrapperType === 'collection' && r.collectionType === 'Album');
}

// ---- Plan B: búsqueda de texto libre con filtros, solo si no se identificó un artista real ----
async function fallbackTextSearch(term) {
  const [broad, byTitle] = await Promise.all([
    fetchJSON(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&country=US&limit=50`),
    fetchJSON(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&country=US&limit=50&attribute=albumTerm`)
  ]);
  const merged = new Map();
  [...(broad.results || []), ...(byTitle.results || [])].forEach(it => {
    if (it.collectionId) merged.set(it.collectionId, it);
  });
  return Array.from(merged.values()).filter(it => !isJunkText(`${it.collectionName} ${it.artistName}`));
}

function scoreAlbum(it, queryNorm, queryWords) {
  const title = normalize(it.collectionName);
  const artist = normalize(it.artistName);
  const combined = `${title} ${artist}`;
  let score = 0;
  if (queryNorm && combined.includes(queryNorm)) score += 60;
  if (queryNorm && title === queryNorm) score += 40;
  queryWords.forEach(w => {
    if (w.length < 2) return;
    if (title.includes(w)) score += 3;
    if (artist.includes(w)) score += 5;
  });
  score += Math.min(it.trackCount || 0, 20) * 0.15;
  return score;
}

async function runSearch() {
  const term = document.getElementById('search-input').value.trim();
  if (!term) return;
  const list = document.getElementById('results-list');
  list.innerHTML = `<div class="empty-state">Buscando…</div>`;

  try {
    const queryNorm = normalize(term);
    const queryWords = queryNorm.split(' ').filter(Boolean);

    let candidateAlbums = [];
    const artists = await findArtistCandidates(term);

    if (artists.length) {
      // discografía oficial real de los artistas que coinciden — sin karaoke, sin ruido
      const lists = await Promise.all(artists.map(a => albumsForArtist(a.artistId)));
      const merged = new Map();
      lists.flat().forEach(it => { if (it.collectionId) merged.set(it.collectionId, it); });
      candidateAlbums = Array.from(merged.values());
    }

    if (!candidateAlbums.length) {
      // no se identificó un artista real con confianza: buscamos por texto con filtros
      candidateAlbums = await fallbackTextSearch(term);
    }

    const results = candidateAlbums
      .sort((a, b) => scoreAlbum(b, queryNorm, queryWords) - scoreAlbum(a, queryNorm, queryWords))
      .slice(0, 12);

    renderResults(results);
  } catch (err) {
    list.innerHTML = `<div class="empty-state">Error al buscar. Revisá tu conexión.</div>`;
  }
}

function renderResults(items) {
  const list = document.getElementById('results-list');
  if (!items.length) {
    list.innerHTML = `<div class="empty-state">Sin resultados.</div>`;
    return;
  }
  list.innerHTML = items.map((it, i) => `
    <div class="result-row" data-idx="${i}">
      <img src="${it.artworkUrl100}" alt="">
      <div>
        <div class="rtitle">${escapeHtml(it.collectionName)}</div>
        <div class="rartist">${escapeHtml(it.artistName)}</div>
      </div>
      <div class="ryear mono">${(it.releaseDate || '').slice(0,4)}</div>
    </div>
  `).join('');
  list.querySelectorAll('.result-row').forEach(row => {
    row.addEventListener('click', () => selectAlbum(items[+row.dataset.idx]));
  });
}

async function selectAlbum(item) {
  const panel = document.getElementById('rating-panel');
  panel.style.display = 'block';
  panel.innerHTML = `<div class="empty-state">Cargando canciones…</div>`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  let tracks = [];
  try {
    const res = await fetch(`https://itunes.apple.com/lookup?id=${item.collectionId}&entity=song`);
    const json = await res.json();
    tracks = (json.results || [])
      .filter(r => r.wrapperType === 'track')
      .map(t => ({ id: t.trackId, name: t.trackName, number: t.trackNumber, rating: null }));
  } catch (err) { /* seguimos sin tracklist si falla */ }

  currentAlbum = {
    itunes_collection_id: item.collectionId,
    title: item.collectionName,
    artist: item.artistName,
    cover_url: (item.artworkUrl100 || '').replace('100x100', '600x600'),
    release_year: (item.releaseDate || '').slice(0, 4),
    tracks
  };

  renderRatingPanel();
}

function renderRatingPanel() {
  const panel = document.getElementById('rating-panel');
  const a = currentAlbum;
  panel.innerHTML = `
    <div class="rp-header">
      <img src="${a.cover_url}" alt="">
      <div>
        <h2>${escapeHtml(a.title)}</h2>
        <p class="artist">${escapeHtml(a.artist)}</p>
        <p class="ryear mono">${a.release_year}</p>
      </div>
    </div>

    <label class="field-label">Calificación del álbum (0–10)</label>
    <div class="rating-slider-row">
      <input type="range" id="album-rating" min="0" max="10" step="0.5" value="7">
      <span class="mono" id="album-rating-val" style="width:2.6rem">7.0</span>
    </div>

    <label class="field-label">Notas / diario</label>
    <textarea id="album-notes" placeholder="¿Qué te dejó este disco?"></textarea>

    ${a.tracks.length ? `
      <label class="field-label" style="margin-top:1.4rem;display:block">Canciones</label>
      <div class="track-list">
        ${a.tracks.map((t, i) => `
          <div class="track-row">
            <span class="tnum mono">${String(t.number || i+1).padStart(2,'0')}</span>
            <span>${escapeHtml(t.name)}</span>
            <span style="display:flex;align-items:center;gap:0.5rem">
              <input type="range" min="0" max="10" step="0.5" value="0" data-track="${i}" class="track-slider">
              <span class="tval mono" data-trackval="${i}">–</span>
            </span>
          </div>
        `).join('')}
      </div>
    ` : ''}

    <button class="btn-primary" id="save-entry">Guardar en el estante</button>
    <button class="btn-secondary" id="cancel-entry">Cancelar</button>
  `;

  const albumSlider = document.getElementById('album-rating');
  albumSlider.addEventListener('input', () => {
    document.getElementById('album-rating-val').textContent = Number(albumSlider.value).toFixed(1);
  });

  panel.querySelectorAll('.track-slider').forEach(sl => {
    sl.addEventListener('input', () => {
      const idx = +sl.dataset.track;
      const val = Number(sl.value);
      document.querySelector(`[data-trackval="${idx}"]`).textContent = val === 0 ? '–' : val.toFixed(1);
      a.tracks[idx].rating = val === 0 ? null : val;
    });
  });

  document.getElementById('cancel-entry').addEventListener('click', () => {
    panel.style.display = 'none';
    currentAlbum = null;
  });

  document.getElementById('save-entry').addEventListener('click', saveEntry);
}

async function saveEntry() {
  if (!session) {
    document.getElementById('login-modal').classList.add('active');
    document.getElementById('login-msg').textContent = 'Iniciá sesión como editor para guardar.';
    return;
  }
  const btn = document.getElementById('save-entry');
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  const payload = {
    itunes_collection_id: currentAlbum.itunes_collection_id,
    title: currentAlbum.title,
    artist: currentAlbum.artist,
    cover_url: currentAlbum.cover_url,
    release_year: currentAlbum.release_year,
    album_rating: Number(document.getElementById('album-rating').value),
    notes: document.getElementById('album-notes').value.trim(),
    tracks: currentAlbum.tracks
  };

  const { error } = await sb.from('entries').insert(payload);
  btn.disabled = false;
  btn.textContent = 'Guardar en el estante';

  if (error) {
    alert('No se pudo guardar: ' + error.message);
    return;
  }

  document.getElementById('rating-panel').style.display = 'none';
  document.getElementById('search-input').value = '';
  document.getElementById('results-list').innerHTML = '';
  currentAlbum = null;
  switchView('shelf');
}

// ---------- Estante (listado guardado) ----------

async function loadShelf() {
  const grid = document.getElementById('shelf-grid');
  const empty = document.getElementById('shelf-empty');
  grid.innerHTML = `<div class="empty-state">Cargando…</div>`;

  const { data, error } = await sb.from('entries').select('*').order('created_at', { ascending: false });

  if (error) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = 'Error al cargar: ' + error.message;
    return;
  }

  document.getElementById('shelf-count').textContent = data.length ? `(${data.length})` : '';

  if (!data.length) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  grid.innerHTML = data.map(e => `
    <div class="card" data-id="${e.id}">
      <div class="cover-wrap">
        <img class="cover" src="${e.cover_url}" alt="">
        ${stampHTML(e.album_rating)}
      </div>
      <div class="meta-label">${e.release_year || ''}</div>
      <h3>${escapeHtml(e.title)}</h3>
      <p class="artist">${escapeHtml(e.artist)}</p>
    </div>
  `).join('');

  grid.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', () => openEntry(card.dataset.id, data));
  });
}

function openEntry(id, cached) {
  const entry = cached.find(e => String(e.id) === String(id));
  if (!entry) return;
  const box = document.getElementById('entry-detail');
  box.innerHTML = `
    <div class="rp-header">
      <img src="${entry.cover_url}" alt="">
      <div>
        <h2>${escapeHtml(entry.title)}</h2>
        <p class="artist">${escapeHtml(entry.artist)}</p>
        <p class="ryear mono">${entry.release_year || ''}</p>
      </div>
      ${stampHTML(entry.album_rating)}
    </div>
    ${entry.notes ? `<p class="entry-notes">${escapeHtml(entry.notes)}</p>` : ''}
    ${(entry.tracks && entry.tracks.length) ? `
      <div class="track-list">
        ${entry.tracks.map(t => `
          <div class="track-row">
            <span class="tnum mono">${String(t.number || '').padStart(2,'0')}</span>
            <span>${escapeHtml(t.name)}</span>
            <span class="mono">${t.rating != null ? t.rating.toFixed(1) : '–'}</span>
          </div>
        `).join('')}
      </div>
    ` : ''}
    <button class="btn-secondary" id="back-to-shelf" style="margin-left:0">← Volver al estante</button>
  `;
  switchView('entry');
  document.getElementById('back-to-shelf').addEventListener('click', () => switchView('shelf'));
}

// ---------- Utilidades ----------

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Carga inicial
loadShelf();
