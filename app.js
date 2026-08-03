// ============================================
// Bitácora Sonora — lógica principal
// ============================================

document.getElementById('wordmark').textContent = SITE_NAME;
document.title = SITE_NAME;

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let session = null;
let currentAlbum = null;      // álbum elegido en la búsqueda, con tracks temporales
let shelfEntries = [];        // caché de lo guardado en Supabase
let activeGenreFilter = 'Todos';
let compareState = null;      // estado de la comparación binaria en curso
let computedRating = null;    // resultado final de la comparación / slider bootstrap

// ---------- Navegación entre vistas ----------

function switchView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('.tab-bar button').forEach(b => {
    b.classList.toggle('active', b.dataset.view === name);
  });
  if (name === 'shelf') loadShelf();
  if (name === 'profile') renderProfile();
}

document.querySelectorAll('.tab-bar button').forEach(b => {
  b.addEventListener('click', () => switchView(b.dataset.view));
});

// ---------- Sesión / login del dueño ----------

async function refreshSession() {
  const { data } = await sb.auth.getSession();
  session = data.session;
}
refreshSession();

function openLogin() {
  document.getElementById('login-modal').classList.add('active');
}
document.getElementById('login-fab-2').addEventListener('click', () => {
  if (session) {
    sb.auth.signOut().then(() => { refreshSession(); renderProfile(); });
  } else {
    openLogin();
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
    renderProfile();
  }
});

// ---------- Perfil ----------

function renderProfile() {
  document.getElementById('profile-avatar').textContent = (SITE_OWNER || '?').charAt(0).toUpperCase();
  document.getElementById('profile-name').textContent = SITE_OWNER || 'Mi bitácora';

  const rated = shelfEntries.filter(e => e.album_rating != null);
  document.getElementById('stat-count').textContent = shelfEntries.length;
  document.getElementById('stat-avg').textContent = rated.length
    ? (rated.reduce((s, e) => s + Number(e.album_rating), 0) / rated.length).toFixed(1)
    : '–';

  const genreCounts = {};
  shelfEntries.forEach(e => {
    if (!e.genre) return;
    genreCounts[e.genre] = (genreCounts[e.genre] || 0) + 1;
  });
  const topGenre = Object.entries(genreCounts).sort((a, b) => b[1] - a[1])[0];
  document.getElementById('stat-genre').textContent = topGenre ? topGenre[0] : '–';

  const btn = document.getElementById('login-fab-2');
  btn.textContent = session ? 'Cerrar sesión de editor' : 'Entrar como editor';
}

// ---------- Búsqueda: identificar catálogo real (sin karaoke/tributos) ----------

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
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchJSON(url) {
  const res = await fetch(url);
  return res.json();
}

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
    .filter(a => a.primaryGenreName !== 'Karaoke')
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
    .filter(x => x.score >= 15)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map(x => x.artist);
}

async function albumsForArtist(artistId) {
  const json = await fetchJSON(`https://itunes.apple.com/lookup?id=${artistId}&entity=album&limit=200&country=US`);
  return (json.results || []).filter(r => r.wrapperType === 'collection' && r.collectionType === 'Album');
}

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

document.getElementById('search-btn').addEventListener('click', runSearch);
document.getElementById('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') runSearch();
});

async function runSearch() {
  const term = document.getElementById('search-input').value.trim();
  if (!term) return;
  const list = document.getElementById('results-list');
  list.innerHTML = `<div class="empty-state">Buscando…</div>`;
  document.getElementById('rating-panel').style.display = 'none';

  try {
    const queryNorm = normalize(term);
    const queryWords = queryNorm.split(' ').filter(Boolean);

    let candidateAlbums = [];
    const artists = await findArtistCandidates(term);
    if (artists.length) {
      const lists = await Promise.all(artists.map(a => albumsForArtist(a.artistId)));
      const merged = new Map();
      lists.flat().forEach(it => { if (it.collectionId) merged.set(it.collectionId, it); });
      candidateAlbums = Array.from(merged.values());
    }
    if (!candidateAlbums.length) {
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
      <div class="ryear">${(it.releaseDate || '').slice(0,4)}</div>
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
    const json = await fetchJSON(`https://itunes.apple.com/lookup?id=${item.collectionId}&entity=song`);
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
    genre: item.primaryGenreName || null,
    tracks
  };
  computedRating = null;

  renderRatingPanel();
}

function renderRatingPanel() {
  const panel = document.getElementById('rating-panel');
  const a = currentAlbum;
  const pool = shelfEntries.filter(e => e.album_rating != null);

  panel.innerHTML = `
    <div class="rp-header">
      <img src="${a.cover_url}" alt="">
      <div>
        <h2>${escapeHtml(a.title)}</h2>
        <p class="artist">${escapeHtml(a.artist)}</p>
        <p class="ryear">${a.release_year}${a.genre ? ' · ' + escapeHtml(a.genre) : ''}</p>
      </div>
    </div>

    <label class="field-label">Notas / diario</label>
    <textarea id="album-notes" placeholder="¿Qué te dejó este disco?"></textarea>

    ${a.tracks.length ? `
      <label class="field-label" style="margin-top:1.2rem;display:block">Canciones (opcional)</label>
      <div class="track-list">
        ${a.tracks.map((t, i) => `
          <div class="track-row">
            <span class="tnum">${String(t.number || i+1).padStart(2,'0')}</span>
            <span>${escapeHtml(t.name)}</span>
            <span style="display:flex;align-items:center;gap:0.5rem">
              <input type="range" min="0" max="10" step="0.5" value="0" data-track="${i}" class="track-slider">
              <span class="tval" data-trackval="${i}">–</span>
            </span>
          </div>
        `).join('')}
      </div>
    ` : ''}

    <div id="rating-section" style="margin-top:1.4rem"></div>

    <button class="btn-primary" id="save-entry" disabled>Guardar en el estante</button>
    <button class="btn-secondary" id="cancel-entry">Cancelar</button>
  `;

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

  const section = document.getElementById('rating-section');
  if (pool.length === 0) {
    // primer disco del estante: no hay nada contra qué comparar todavía
    computedRating = 7.5;
    section.innerHTML = `
      <label class="field-label">Calificación (sos el primer disco del estante — luego los próximos se comparan contra este)</label>
      <div class="rating-slider-row">
        <input type="range" id="bootstrap-rating" min="0" max="10" step="0.5" value="7.5">
        <span id="bootstrap-val" style="font-weight:700">7.5</span>
      </div>
    `;
    document.getElementById('bootstrap-rating').addEventListener('input', e => {
      computedRating = Number(e.target.value);
      document.getElementById('bootstrap-val').textContent = computedRating.toFixed(1);
    });
    document.getElementById('save-entry').disabled = false;
  } else {
    section.innerHTML = `
      <button class="btn-primary" id="start-compare" type="button">Comparar y calificar</button>
      <div id="rating-result"></div>
    `;
    document.getElementById('start-compare').addEventListener('click', beginComparison);
  }
}

// ---------- Comparación binaria (estilo Podiums) ----------

function beginComparison() {
  const pool = shelfEntries.filter(e => e.album_rating != null).sort((a, b) => b.album_rating - a.album_rating);
  compareState = { pool, lo: 0, hi: pool.length, history: [] };
  document.getElementById('compare-modal').classList.add('active');
  openCompareStep();
}

function openCompareStep() {
  const { pool, lo, hi } = compareState;
  if (lo >= hi) {
    finishComparison(lo, false);
    return;
  }
  const mid = Math.floor((lo + hi) / 2);
  compareState.mid = mid;
  const rival = pool[mid];

  document.getElementById('compare-sub').textContent = '¿Cuál te gustó más?';
  document.getElementById('compare-cards').innerHTML = `
    <div class="compare-card" data-pick="candidate" style="background-image:url('${currentAlbum.cover_url}')">
      <div class="cc-info">
        <div class="cc-title">${escapeHtml(currentAlbum.title)}</div>
        <div class="cc-artist">${escapeHtml(currentAlbum.artist)}</div>
      </div>
    </div>
    <div class="compare-card" data-pick="rival" style="background-image:url('${rival.cover_url}')">
      <div class="cc-info">
        <div class="cc-title">${escapeHtml(rival.title)}</div>
        <div class="cc-artist">${escapeHtml(rival.artist)}</div>
      </div>
    </div>
  `;
  document.querySelectorAll('.compare-card').forEach(card => {
    card.addEventListener('click', () => pick(card.dataset.pick));
  });
  const totalSteps = Math.ceil(Math.log2(Math.max(pool.length, 1))) + 1;
  document.getElementById('compare-progress').textContent = `Ronda ${compareState.history.length + 1} de ~${totalSteps}`;
}

function pick(who) {
  const { lo, hi, mid } = compareState;
  compareState.history.push({ lo, hi });
  if (who === 'candidate') {
    compareState.hi = mid; // el candidato queda por encima de este punto
  } else {
    compareState.lo = mid + 1;
  }
  openCompareStep();
}

document.getElementById('compare-tie').addEventListener('click', () => {
  if (!compareState) return;
  finishComparison(compareState.mid, true);
});

document.getElementById('compare-undo').addEventListener('click', () => {
  if (!compareState || !compareState.history.length) return;
  const prev = compareState.history.pop();
  compareState.lo = prev.lo;
  compareState.hi = prev.hi;
  openCompareStep();
});

document.getElementById('compare-close').addEventListener('click', () => {
  document.getElementById('compare-modal').classList.remove('active');
});

function finishComparison(insertIndex, tie) {
  const { pool, mid } = compareState;
  let rating;
  if (tie) {
    rating = Number(pool[mid].album_rating);
  } else if (insertIndex <= 0) {
    rating = Math.min(10, Number(pool[0].album_rating) + 0.3);
  } else if (insertIndex >= pool.length) {
    rating = Math.max(0, Number(pool[pool.length - 1].album_rating) - 0.3);
  } else {
    rating = (Number(pool[insertIndex - 1].album_rating) + Number(pool[insertIndex].album_rating)) / 2;
  }
  rating = Math.round(rating * 10) / 10;
  computedRating = rating;

  document.getElementById('compare-modal').classList.remove('active');
  const resultBox = document.getElementById('rating-result');
  if (resultBox) {
    resultBox.innerHTML = `
      <div class="result-score">
        <div class="num">${rating.toFixed(1)}</div>
        <div class="label">tu calificación calculada</div>
      </div>
      <button class="btn-secondary" id="redo-compare" type="button">Volver a comparar</button>
    `;
    document.getElementById('redo-compare').addEventListener('click', beginComparison);
  }
  document.getElementById('save-entry').disabled = false;
}

// ---------- Guardar entrada ----------

async function saveEntry() {
  if (!session) {
    openLogin();
    document.getElementById('login-msg').textContent = 'Iniciá sesión como editor para guardar.';
    return;
  }
  if (computedRating == null) return;

  const btn = document.getElementById('save-entry');
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  const payload = {
    itunes_collection_id: currentAlbum.itunes_collection_id,
    title: currentAlbum.title,
    artist: currentAlbum.artist,
    cover_url: currentAlbum.cover_url,
    release_year: currentAlbum.release_year,
    genre: currentAlbum.genre,
    album_rating: computedRating,
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
  computedRating = null;
  switchView('shelf');
}

// ---------- Estante ----------

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

  shelfEntries = data || [];
  renderGenreChips();
  renderShelfGrid();
}

function renderGenreChips() {
  const genres = Array.from(new Set(shelfEntries.map(e => e.genre).filter(Boolean))).sort();
  const row = document.getElementById('genre-chips');
  if (!genres.length) { row.innerHTML = ''; return; }
  const all = ['Todos', ...genres];
  row.innerHTML = all.map(g => `<button class="chip ${g === activeGenreFilter ? 'active' : ''}" data-genre="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join('');
  row.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      activeGenreFilter = chip.dataset.genre;
      renderGenreChips();
      renderShelfGrid();
    });
  });
}

function renderShelfGrid() {
  const grid = document.getElementById('shelf-grid');
  const empty = document.getElementById('shelf-empty');
  const filtered = activeGenreFilter === 'Todos'
    ? shelfEntries
    : shelfEntries.filter(e => e.genre === activeGenreFilter);

  document.getElementById('shelf-count').textContent = shelfEntries.length ? `(${shelfEntries.length})` : '';

  if (!filtered.length) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  grid.innerHTML = filtered.map(e => `
    <div class="card" data-id="${e.id}">
      <img class="cover" src="${e.cover_url}" alt="">
      ${e.album_rating != null ? `<div class="badge">${Number(e.album_rating).toFixed(1)}</div>` : ''}
      <div class="card-hover">
        <div class="t">${escapeHtml(e.title)}</div>
        <div class="a">${escapeHtml(e.artist)}</div>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', () => openEntry(card.dataset.id));
  });
}

function openEntry(id) {
  const entry = shelfEntries.find(e => String(e.id) === String(id));
  if (!entry) return;
  const box = document.getElementById('entry-detail');
  box.innerHTML = `
    <div class="rp-header">
      <img src="${entry.cover_url}" alt="">
      <div>
        <h2>${escapeHtml(entry.title)}</h2>
        <p class="artist">${escapeHtml(entry.artist)}</p>
        <p class="ryear">${entry.release_year || ''}${entry.genre ? ' · ' + escapeHtml(entry.genre) : ''}</p>
      </div>
      ${entry.album_rating != null ? `<div class="badge-lg">${Number(entry.album_rating).toFixed(1)}</div>` : ''}
    </div>
    ${entry.notes ? `<p class="entry-notes">${escapeHtml(entry.notes)}</p>` : ''}
    ${(entry.tracks && entry.tracks.length) ? `
      <div class="track-list">
        ${entry.tracks.map(t => `
          <div class="track-row">
            <span class="tnum">${String(t.number || '').padStart(2,'0')}</span>
            <span>${escapeHtml(t.name)}</span>
            <span>${t.rating != null ? Number(t.rating).toFixed(1) : '–'}</span>
          </div>
        `).join('')}
      </div>
    ` : ''}
    <button class="btn-secondary" id="back-to-shelf">← Volver al estante</button>
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

loadShelf();
