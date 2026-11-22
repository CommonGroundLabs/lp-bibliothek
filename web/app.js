'use strict';

/* ============================================================ Helfer */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const DEFAULT_COLORS = ['#33333d', '#222228', '#3f3f4b'];

const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });

function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase();
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function initials(album) {
  const words = String(album.artist || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2);
  return words.map((w) => w[0] || '').join('').toUpperCase() || 'LP';
}

function fmtDate(iso) {
  if (!iso) return 'unbekannt';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function slug(s) {
  return norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'setliste';
}

function download(name, text, type) {
  const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ============================================================ Zustand */
const SORT_FIELDS = [
  { key: 'added', label: 'Hinzugefügt' },
  { key: 'year', label: 'Erscheinungsjahr' },
  { key: 'artist', label: 'Artist' },
  { key: 'title', label: 'Titel' },
  { key: 'genre', label: 'Genre' },
  { key: 'label', label: 'Label' },
];
const SORT_SHORT = { added: 'Zuletzt', year: 'Jahr', artist: 'Artist', title: 'Titel', genre: 'Genre', label: 'Label' };

const app = {
  albums: [],
  view: [],
  index: 0,
  query: '',
  sort: { key: 'added', dir: 'desc' },
  filters: { genre: [], style: [], label: [], decade: [], medium: [], tags: [] },
  mode: 'flow',
  meta: null,
  sets: [],
  activeSet: null,
  detailAlbum: null,
  cards: new Map(),
  facets: { genre: [], style: [], label: [], decade: [] },
  trackmeta: {},
  tags: {},
  setopts: { target: 60 },
  cw: 340,
  gridDirty: true,
  glassDirty: true,
  lastFocus: null,
};

const KEY_UI = 'lpb.ui.v1';
const KEY_SETS = 'lpb.sets.v1';
const KEY_TRACKMETA = 'lpb.trackmeta.v1';
const KEY_TAGS = 'lpb.tags.v1';
const KEY_SETOPTS = 'lpb.setopts.v1';

/* ============================================================ Laden */
async function loadCollection() {
  let data;
  try {
    const res = await fetch('collection.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    $('#npTitle').textContent = 'Keine collection.json gefunden';
    $('#npArtist').textContent = 'Setup offen';
    $('#npMeta').innerHTML = 'Bitte zuerst <code>python sync.py</code> ausführen (Token in <code>.env</code>).';
    throw err;
  }
  app.meta = data.meta || {};
  app.albums = (data.albums || []).map(normalizeAlbum);
  if (app.meta.fixture) {
    $('#npArtist').textContent = 'Demo-Daten';
    const btn = $('#demoConnect');
    if (btn) btn.hidden = false;
    toast('Demo-Daten aktiv – noch kein echter Sync gelaufen');
  }
}

function normalizeAlbum(a) {
  const colors = Array.isArray(a.colors) && a.colors.length ? a.colors : DEFAULT_COLORS;
  const tracklist = Array.isArray(a.tracklist) ? a.tracklist : [];
  const labels = Array.isArray(a.labels) ? a.labels : [];
  const year = Number(a.year) || 0;
  const mediums = Array.from(new Set(
    (Array.isArray(a.formats) ? a.formats : [])
      .map((f) => String(f && f.name ? f.name : '').trim())
      .filter((n) => n && n.toLowerCase() !== 'all media'),
  ));
  const blob = norm([
    a.artist, a.title, a.label, a.catno,
    (a.genres || []).join(' '), (a.styles || []).join(' '), mediums.join(' '),
    labels.map((l) => l.name || '').join(' '),
    tracklist.map((t) => t.title || '').join(' '),
  ].join(' '));
  return Object.assign({}, a, {
    colors,
    tracklist,
    labels,
    genres: a.genres || [],
    styles: a.styles || [],
    year,
    mediums,
    medium: mediums[0] || '',
    decade: year ? Math.floor(year / 10) * 10 : 0,
    blob,
    key: String(a.instance_id != null ? a.instance_id : a.release_id),
  });
}

/* ============================================================ Filter + Sort */
function applyFilter() {
  const q = norm(app.query).trim();
  const f = app.filters;
  const out = app.albums.filter((a) => {
    if (f.genre.length && !a.genres.some((g) => f.genre.includes(g))) return false;
    if (f.style.length && !a.styles.some((s) => f.style.includes(s))) return false;
    if (f.label.length && !f.label.includes(a.label)) return false;
    if (f.decade.length) {
      const d = a.year ? String(a.decade) : 'unbekannt';
      if (!f.decade.includes(d)) return false;
    }
    if (f.tags.length && !tagsOf(a).some((t) => f.tags.includes(t))) return false;
    if (f.medium.length && !a.mediums.some((m) => f.medium.includes(m))) return false;
    if (q && !a.blob.includes(q)) return false;
    return true;
  });
  out.sort(compareAlbums);
  app.view = out;
  validateSetlists();
}

function compareAlbums(a, b) {
  const { key, dir } = app.sort;
  let v = 0;
  if (key === 'year') {
    if (!a.year && !b.year) v = 0;
    else if (!a.year) return 1;      // Alben ohne Jahr immer ans Ende
    else if (!b.year) return -1;
    else v = a.year - b.year;
  } else if (key === 'added') v = String(a.added || '').localeCompare(String(b.added || ''));
  else if (key === 'genre') v = collator.compare(a.genres.join(', '), b.genres.join(', '));
  else if (key === 'label') v = collator.compare(a.label || '', b.label || '');
  else if (key === 'artist') v = collator.compare(a.artist || '', b.artist || '');
  else v = collator.compare(a.title || '', b.title || '');
  if (v === 0) v = collator.compare(a.artist || '', b.artist || '') || collator.compare(a.title || '', b.title || '');
  return dir === 'asc' ? v : -v;
}

function buildFacets() {
  const count = (fn) => {
    const map = new Map();
    app.albums.forEach((a) => {
      const vals = fn(a);
      const seen = new Set();
      vals.forEach((v) => {
        if (!v || seen.has(v)) return;
        seen.add(v);
        map.set(v, (map.get(v) || 0) + 1);
      });
    });
    return Array.from(map.entries()).sort((x, y) => y[1] - x[1] || collator.compare(x[0], y[0]));
  };
  app.facets = {
    genre: count((a) => a.genres),
    style: count((a) => a.styles),
    label: count((a) => [a.label]),
    medium: count((a) => a.mediums),
    decade: count((a) => [a.year ? String(a.decade) : 'unbekannt'])
      .sort((x, y) => (x[0] === 'unbekannt' ? 1 : y[0] === 'unbekannt' ? -1 : parseInt(x[0], 10) - parseInt(y[0], 10))),
    tags: allTags(),
  };
}

/* ============================================================ Rendern: Buehne */
function resetFlow() {
  $('#flow').innerHTML = '';
  app.cards.clear();
  app.gridDirty = true;
  app.glassDirty = true;
}

function makeCard(pos) {
  const album = app.view[pos];
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'card';
  el.dataset.pos = String(pos);
  el.setAttribute('role', 'option');

  const media = document.createElement('span');
  media.className = 'card-media';
  media.style.setProperty('--c1', album.colors[0]);
  media.style.setProperty('--c2', album.colors[1] || album.colors[0]);

  if (album.cover) {
    const img = document.createElement('img');
    img.src = album.cover;
    img.alt = `Cover von ${album.artist} – ${album.title}`;
    img.decoding = 'async';
    img.draggable = false;
    img.onerror = () => {
      img.remove();
      media.classList.add('is-empty');
      media.innerHTML = `<span class="ph">${esc(initials(album))}</span>`;
    };
    media.appendChild(img);
  } else {
    media.classList.add('is-empty');
    media.innerHTML = `<span class="ph">${esc(initials(album))}</span>`;
  }
  el.appendChild(media);
  el.addEventListener('click', () => {
    const p = Number(el.dataset.pos);
    if (p === app.index) openDetail(app.view[p]);
    else setIndex(p);
  });
  return el;
}

function renderFlow() {
  const flow = $('#flow');
  if (!app.view.length) {
    flow.querySelectorAll('.card').forEach((c) => c.remove());
    app.cards.clear();
    return;
  }
  const w = flow.clientWidth || 900;
  const h = flow.clientHeight || 520;
  const cw = Math.round(Math.max(150, Math.min(h * (w < 760 ? 0.52 : 0.66), w * (w < 760 ? 0.56 : 0.42), 520)));
  app.cw = cw;
  flow.style.setProperty('--cw', cw + 'px');
  const maxOff = cw > 400 ? 4 : cw > 300 ? 3 : 2;

  const need = new Set();
  for (let o = -maxOff; o <= maxOff; o++) {
    const p = app.index + o;
    if (p >= 0 && p < app.view.length) need.add(p);
  }
  for (const [pos, el] of Array.from(app.cards)) {
    if (!need.has(pos)) {
      el.remove();
      app.cards.delete(pos);
    }
  }
  need.forEach((pos) => {
    if (!app.cards.has(pos)) {
      const el = makeCard(pos);
      app.cards.set(pos, el);
      flow.appendChild(el);
    }
  });

  app.cards.forEach((el, pos) => {
    const album = app.view[pos];
    const o = pos - app.index;
    const dist = Math.abs(o);
    const x = o * cw * 0.60;
    const scale = Math.max(0.5, 1 - dist * 0.14);
    const rot = o * -22;
    const z = -dist * 150;
    const op = Math.max(0, 1 - dist * 0.21);
    el.style.transform = `translate(-50%,-50%) translate3d(${x}px,0,${z}px) rotateY(${rot}deg) scale(${scale})`;
    el.style.opacity = op.toFixed(3);
    el.style.zIndex = String(100 - dist);
    el.style.filter = dist ? `brightness(${(1 - dist * 0.16).toFixed(2)}) saturate(${(1 - dist * 0.18).toFixed(2)})` : 'none';
    el.classList.toggle('is-active', dist === 0);
    el.dataset.offset = String(o);
    el.setAttribute('aria-selected', dist === 0 ? 'true' : 'false');
    el.tabIndex = dist === 0 ? 0 : -1;
    const kind = o === 0 ? 'aktuelle Auswahl, Details öffnen' : o < 0 ? 'vorheriges Album' : 'nächstes Album';
    el.setAttribute('aria-label', `${album.artist} – ${album.title}${album.year ? ` (${album.year})` : ''}, ${kind}`);
  });
}

let lastGlow = '';
function updateGlow(album) {
  if (!album) return;
  const c = album.colors && album.colors.length ? album.colors : DEFAULT_COLORS;
  const key = c.join('|');
  if (key === lastGlow) return;
  lastGlow = key;
  const [a, b = a, d = a] = c;
  $('.glow-a').style.backgroundColor = a;
  $('.glow-b').style.backgroundColor = b;
  $('.glow-c').style.backgroundColor = d;
}

function updateNowPlaying() {
  const album = app.view[app.index];
  if (!album) {
    $('#npArtist').textContent = 'Ergebnis';
    $('#npTitle').textContent = app.albums.length ? 'Keine Alben für diese Auswahl' : 'Sammlung wird geladen …';
    $('#npMeta').textContent = app.albums.length ? 'Filter oder Suche anpassen.' : '';
    $('#slider').value = '0';
    $('#slider').max = '0';
    $('#scrubPos').textContent = '0 / 0';
    updateDock();
    return;
  }
  $('#npArtist').textContent = album.artist;
  $('#npTitle').textContent = album.title;
  const bits = [];
  if (album.year) bits.push(album.year);
  if (album.label) bits.push(album.label);
  if (album.format) bits.push(album.format);
  $('#npMeta').textContent = bits.join('  ·  ');
  $('#scrubPos').textContent = `${app.index + 1} / ${app.view.length}`;
  const slider = $('#slider');
  slider.max = String(Math.max(0, app.view.length - 1));
  slider.value = String(app.index);
  updateStar();
  updateDock();
  updatePreviewChip(app.detailAlbum || album);
  const active = $('#detail');
  if (!active.hidden && app.detailAlbum) {
    /* Detail bleibt bewusst stehen, wenn per Tastatur geblaettert wird */
  }
}

function updateStar() {
  const album = app.view[app.index];
  const set = activeSetlist();
  const inSet = !!(album && set && set.items.some((i) => i.iid === album.key));
  const btn = $('#starBtn');
  btn.setAttribute('aria-pressed', inSet ? 'true' : 'false');
  $('#starIcon').textContent = inSet ? '★' : '☆';
  $('#starLabel').textContent = inSet ? 'Gemerkt' : 'Setliste';
  $('#setBadge').textContent = String(set ? set.items.length : 0);
  const d = $('#dStar');
  const album2 = app.detailAlbum;
  const inSet2 = !!(album2 && set && set.items.some((i) => i.iid === album2.key));
  d.setAttribute('aria-pressed', inSet2 ? 'true' : 'false');
  d.textContent = inSet2 ? '★ In Setliste' : '☆ Setliste';
}

function setIndex(i, opts) {
  if (!app.view.length) return;
  const next = Math.max(0, Math.min(app.view.length - 1, i));
  if (next === app.index && app.cards.size) return;
  if (PV.current) stopPreview();
  app.index = next;
  renderFlow();
  updateNowPlaying();
  updateGlow(app.view[next]);
  saveUI();
  if (opts && opts.focus) {
    const card = app.cards.get(next);
    if (card) card.focus({ preventScroll: true });
  }
}

function randomAlbum() {
  if (!app.view.length) return;
  let next = app.index;
  for (let k = 0; k < 12 && next === app.index; k += 1) next = Math.floor(Math.random() * app.view.length);
  setIndex(next, { focus: true });
  toast(`Zufall: ${app.view[next].artist} – ${app.view[next].title}`);
}

/* ============================================================ GUI-Aufbau */
function renderCount() {
  const total = app.albums.length;
  const shown = app.view.length;
  $('#countLabel').textContent = shown === total ? `${total} Alben` : `${shown} von ${total}`;
  const active = Object.values(app.filters).reduce((n, arr) => n + arr.length, 0);
  const badge = $('#filterBadge');
  badge.hidden = active === 0;
  badge.textContent = String(active);
  $('#filterBtn').setAttribute('aria-expanded', String(!$('#filterPanel').hidden));
  $('#sortBtn').setAttribute('aria-expanded', String(!$('#sortPanel').hidden));
}

function renderFilterPanel(force) {
  const body = $('#filterBody');
  // Nur neu aufbauen, wenn noetig: ein Rebuild waehrend eines Klicks loest das
  // Panel vom Event-Ziel und die Klick-Auswertung schliesst es faelschlich.
  const existing = body.querySelectorAll('.chip');
  if (!force && existing.length) {
    existing.forEach((chip) => {
      const active = app.filters[chip.dataset.group].includes(chip.dataset.value);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    return;
  }
  const groups = [
    { key: 'medium', title: 'Medium' },
    { key: 'genre', title: 'Genre' },
    { key: 'style', title: 'Style' },
    { key: 'label', title: 'Label' },
    { key: 'decade', title: 'Jahrzehnt' },
    { key: 'tags', title: 'Tags' },
  ];
  body.innerHTML = groups.map((g) => {
    const entries = app.facets[g.key] || [];
    if (!entries.length) return '';
    const chips = entries.map(([value, n]) => {
      const on = app.filters[g.key].includes(value);
      const label = g.key === 'decade'
        ? (value === 'unbekannt' ? 'Unbekannt' : `${value}er`)
        : value;
      return `<button class="chip" type="button" data-group="${g.key}" data-value="${esc(value)}" aria-pressed="${on}">${esc(label)}<em>${n}</em></button>`;
    }).join('');
    return `<div class="fgroup"><h3>${g.title}</h3><div class="chips">${chips}</div></div>`;
  }).join('') || '<p class="tracks-empty">Keine Filterwerte vorhanden.</p>';
}

function renderSortPanel() {
  $('#sortBody').innerHTML = `<div class="sortrow">${SORT_FIELDS.map((f) => {
    const active = app.sort.key === f.key;
    const arrow = active ? (app.sort.dir === 'asc' ? '↑ aufsteigend' : '↓ absteigend') : '';
    return `<button class="sortopt" type="button" role="menuitemradio" aria-checked="${active}" data-sort="${f.key}">${f.label}<span>${arrow}</span></button>`;
  }).join('')}</div>`;
  $('#sortBtn').innerHTML = `${SORT_SHORT[app.sort.key]} <span id="sortDir">${app.sort.dir === 'asc' ? '↑' : '↓'}</span>`;
}

function renderGrid() {
  if (!app.gridDirty) return;
  const grid = $('#grid');
  const frag = document.createDocumentFragment();
  if (!app.view.length) {
    const p = document.createElement('p');
    p.className = 'tracks-empty';
    p.textContent = 'Keine Alben für diese Auswahl.';
    frag.appendChild(p);
  }
  app.view.forEach((album, pos) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gitem';
    btn.dataset.pos = String(pos);
    const cover = document.createElement('span');
    cover.className = 'gcover';
    cover.style.setProperty('--c1', album.colors[0]);
    cover.style.setProperty('--c2', album.colors[1] || album.colors[0]);
    if (album.cover) {
      const img = document.createElement('img');
      img.src = album.cover;
      img.alt = `Cover von ${album.artist} – ${album.title}`;
      img.loading = 'lazy';
      img.decoding = 'async';
      cover.appendChild(img);
    } else {
      cover.classList.add('is-empty');
      cover.innerHTML = `<span>${esc(initials(album))}</span>`;
    }
    const star = document.createElement('span');
    star.className = 'gstar';
    star.setAttribute('role', 'button');
    star.setAttribute('tabindex', '-1');
    const set = activeSetlist();
    const inSet = !!(set && set.items.some((i) => i.iid === album.key));
    star.setAttribute('aria-pressed', inSet ? 'true' : 'false');
    star.textContent = inSet ? '★' : '☆';
    star.title = inSet ? 'Aus Setliste entfernen' : 'Zur Setliste';
    star.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleInSet(album);
      star.setAttribute('aria-pressed', 'false');
    });
    cover.appendChild(star);
    const meta = document.createElement('span');
    meta.className = 'gmeta';
    meta.innerHTML = `<span class="ga">${esc(album.artist)}</span><span class="gt">${esc(album.title)}</span>`;
    btn.append(cover, meta);
    btn.addEventListener('click', () => {
      app.index = pos;
      openDetail(album);
      updateNowPlaying();
      updateGlow(album);
      renderFlow();
    });
    frag.appendChild(btn);
  });
  grid.innerHTML = '';
  grid.appendChild(frag);
  app.gridDirty = false;
}

function renderAll() {
  renderCount();
  renderFilterPanel();
  renderSortPanel();
  renderFlow();
  updateNowPlaying();
  updateGlow(app.view[app.index]);
  if (app.mode === 'grid') renderGrid();
  if (app.mode === 'glass') renderGlass();
}

/* ============================================================ Glas-Ansicht */
function renderGlass() {
  const grid = $('#glassGrid');
  if (!grid) return;
  if (!app.glassDirty && grid.childElementCount) {
    updateDock();
    return;
  }
  const frag = document.createDocumentFragment();
  app.view.forEach((album, pos) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'gtile';
    tile.dataset.pos = String(pos);
    tile.style.setProperty('--c1', album.colors[0]);
    tile.style.setProperty('--c2', album.colors[1] || album.colors[0]);
    tile.setAttribute('aria-label', `${album.artist} – ${album.title}${album.year ? ` (${album.year})` : ''}, Details öffnen`);

    const media = document.createElement('span');
    media.className = 'gtile-media';
    if (album.cover) {
      const img = document.createElement('img');
      img.src = album.cover;
      img.alt = `Cover von ${album.artist} – ${album.title}`;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.onerror = () => {
        img.remove();
        media.classList.add('is-empty');
        media.innerHTML = `<span>${esc(initials(album))}</span>`;
      };
      media.appendChild(img);
    } else {
      media.classList.add('is-empty');
      media.innerHTML = `<span>${esc(initials(album))}</span>`;
    }

    const sheen = document.createElement('span');
    sheen.className = 'gtile-sheen';
    const cap = document.createElement('span');
    cap.className = 'gtile-cap';
    cap.innerHTML = `<span class="g-artist">${esc(album.artist)}</span><span class="g-title">${esc(album.title)}</span>`;

    tile.append(media, sheen, cap);
    tile.addEventListener('click', () => {
      app.index = pos;
      updateNowPlaying();
      updateGlow(album);
      openDetail(album);
    });
    tile.addEventListener('pointermove', (ev) => {
      const rect = tile.getBoundingClientRect();
      tile.style.setProperty('--mx', `${(((ev.clientX - rect.left) / rect.width) * 100).toFixed(1)}%`);
      tile.style.setProperty('--my', `${(((ev.clientY - rect.top) / rect.height) * 100).toFixed(1)}%`);
    });
    frag.appendChild(tile);
  });
  grid.innerHTML = '';
  grid.appendChild(frag);
  app.glassDirty = false;
  updateDock();
}

function updateDock() {
  const dock = $('#glassDock');
  if (!dock) return;
  const album = app.view[app.index];
  if (!album || app.mode !== 'glass') {
    dock.hidden = true;
    return;
  }
  dock.hidden = false;
  const img = $('#dockCover');
  if (album.cover) {
    img.src = album.cover;
    img.alt = `Cover von ${album.artist} – ${album.title}`;
    img.hidden = false;
  } else {
    img.removeAttribute('src');
    img.hidden = true;
  }
  $('#dockArtist').textContent = album.artist;
  $('#dockTitle').textContent = album.title;
  $('#dockMeta').textContent = [album.year || '—', album.label].filter(Boolean).join(' · ');
  updatePreviewChip(album);
  const tile = $(`.gtile[data-pos="${app.index}"]`);
  if (tile && app.glassDirty === false) {
    const box = tile.getBoundingClientRect();
    if (box.top < 80 || box.bottom > window.innerHeight - 110) {
      tile.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
}

/* ============================================================ Detail */
function openDetail(album, opts) {
  if (!album) return;
  app.detailAlbum = album;
  app.lastFocus = document.activeElement;
  const overlay = $('#detail');
  const img = $('#dCover');
  const ph = $('#dPh');
  if (album.cover) {
    img.src = album.cover;
    img.alt = `Cover von ${album.artist} – ${album.title}`;
    img.hidden = false;
    ph.hidden = true;
    $('.sheet').style.setProperty('--cover-bg', `url("${album.cover.replace(/"/g, '%22')}")`);
  } else {
    img.removeAttribute('src');
    img.hidden = true;
    ph.hidden = false;
    ph.textContent = initials(album);
    ph.style.setProperty('--c1', album.colors[0]);
    ph.style.setProperty('--c2', album.colors[1] || album.colors[0]);
    $('.sheet').style.removeProperty('--cover-bg');
  }

  $('#dArtist').textContent = album.artist;
  $('#dTitle').textContent = album.title;
  const sub = [album.year || 'Jahr unbekannt', album.country, album.format].filter(Boolean).join('  ·  ');
  $('#dSub').textContent = sub;

  renderFacts(album);
  renderTracklist(album);
  renderTags();
  renderSuggestions();

  $('#dLink').href = album.discogs_url || `https://www.discogs.com/release/${album.release_id}`;

  updateStar();
  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  if (!(opts && opts.fromHash)) setHash(album);
  $('#detailClose').focus({ preventScroll: true });
}

function renderFacts(album) {
  const facts = [];
  facts.push(['Jahr', album.year ? String(album.year) : 'unbekannt']);
  const labels = (album.labels || []).filter((l) => l.name || l.catno);
  facts.push(['Label', labels.length ? labels.map((l) => esc(l.name) + (l.catno ? ` <span style="color:var(--dim)">· ${esc(l.catno)}</span>` : '')).join('<br>') : '—']);
  facts.push(['Katalognr.', album.catno ? esc(album.catno) : '—']);
  facts.push(['Format', album.format ? esc(album.format) : '—']);
  facts.push(['Land', album.country ? esc(album.country) : '—']);
  facts.push(['Genre', album.genres.length ? esc(album.genres.join(', ')) : '—']);
  facts.push(['Styles', album.styles.length ? esc(album.styles.join(', ')) : '—']);
  const bpm = albumBpm(album);
  const key = albumKey(album);
  if (bpm || key) facts.push(['BPM / Key', [key, bpm ? `Ø ${bpm}` : ''].filter(Boolean).join(' · ')]);
  const dur = albumDuration(album);
  if (dur) facts.push(['Laufzeit', fmtDur(dur)]);
  facts.push(['In Sammlung', fmtDate(album.added)]);
  if (album.notes) facts.push(['Release-Notiz', esc(album.notes.length > 300 ? album.notes.slice(0, 300) + '…' : album.notes)]);
  facts.push(['Release', `#${esc(album.release_id)}`]);
  $('#dFacts').innerHTML = facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function renderTracklist(album) {
  const tracks = album.tracklist || [];
  $('#dTrackCount').textContent = tracks.length ? `${tracks.length}` : '';
  if (!tracks.length) {
    $('#dTracks').innerHTML = '<li class="tracks-empty" style="display:block">Keine Tracklist bei Discogs hinterlegt.</li>';
    return;
  }
  $('#dTracks').innerHTML = tracks.map((t, i) => {
    const m = getTrackMeta(album, i) || {};
    return `<li data-pos="${esc(t.position || '')}">
      <span class="tpv"></span>
      <span class="tp">${esc(t.position || '')}</span>
      <span class="tt">${esc(t.title)}</span>
      <span class="td">${esc(t.duration || '')}</span>
      <span class="tmeta-cell">
        <input class="tmeta t-bpm" data-idx="${i}" type="number" min="40" max="220" step="1" inputmode="numeric" placeholder="BPM" value="${m.bpm ? Number(m.bpm) : ''}" aria-label="BPM für ${esc(t.title)}">
        <input class="tmeta t-key" data-idx="${i}" maxlength="3" placeholder="Key" value="${esc(m.key || '')}" aria-label="Camelot-Key für ${esc(t.title)}">
        <select class="tmeta t-energy" data-idx="${i}" aria-label="Energie für ${esc(t.title)}">
          <option value="">–</option>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}"${Number(m.energy) === n ? ' selected' : ''}>${n}</option>`).join('')}
        </select>
      </span>
    </li>`;
  }).join('');
  $('#dTracks').classList.toggle('has-pv', !!firstPreviewPos(album));
  decoratePreviews(album);
}

function closeDetail() {
  if ($('#detail').hidden) return;
  stopPreview();
  $('#detail').hidden = true;
  app.detailAlbum = null;
  clearHash();
  document.body.style.overflow = '';
  if (app.lastFocus && app.lastFocus.isConnected) app.lastFocus.focus({ preventScroll: true });
}

/* ============================================================ Vorschau: 30-Sekunden-Clips */
/* Quelle: iTunes-Search-API (siehe sync_previews.py). Es wird nichts gespeichert,
   nur der Clip gestreamt – ein gemeinsames <audio>-Element für die ganze Seite. */
const PV = { byRelease: null, promise: null, audio: null, current: null };

function releaseKey(album) {
  return album ? String(album.release_id != null ? album.release_id : album.instance_id) : '';
}

function previewsReady() {
  return !!PV.byRelease;
}

function loadPreviews() {
  if (PV.promise) return PV.promise;
  PV.promise = fetch('previews.json', { cache: 'force-cache' })
    .then((r) => (r.ok ? r.json() : { byRelease: {} }))
    .then((data) => {
      PV.byRelease = (data && data.byRelease) || {};
      refreshPreviewButtons();
      return PV.byRelease;
    })
    .catch(() => {
      PV.byRelease = {};
      refreshPreviewButtons();
      return PV.byRelease;
    });
  return PV.promise;
}

function previewEntry(album) {
  if (!PV.byRelease || !album) return null;
  return PV.byRelease[releaseKey(album)] || null;
}

function previewFor(album, pos) {
  const entry = previewEntry(album);
  if (!entry || !entry.tracks) return null;
  return entry.tracks[String(pos)] || null;
}

function firstPreviewPos(album) {
  const entry = previewEntry(album);
  if (!entry || !entry.tracks) return null;
  for (const t of album.tracklist || []) {
    const pos = String(t.position || '');
    if (pos && entry.tracks[pos]) return pos;
  }
  return Object.keys(entry.tracks)[0] || null;
}

function pvAudio() {
  if (!PV.audio) {
    const a = new Audio();
    a.preload = 'none';
    a.addEventListener('timeupdate', onPreviewTime);
    a.addEventListener('ended', () => stopPreview());
    a.addEventListener('play', syncPreviewUI);
    a.addEventListener('pause', syncPreviewUI);
    a.addEventListener('error', () => {
      if (!PV.current) return;
      toast('Vorschau nicht abspielbar');
      stopPreview();
    });
    PV.audio = a;
  }
  return PV.audio;
}

function pvClock(v) {
  const s = Math.max(0, Math.floor(Number(v) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function showPvBar(album, pos, item) {
  const bar = $('#pvBar');
  if (!bar || !album) return;
  const img = $('#pvCover');
  if (album.cover) {
    img.src = album.cover;
    img.alt = `Cover von ${album.artist} – ${album.title}`;
    img.hidden = false;
  } else {
    img.removeAttribute('src');
    img.hidden = true;
  }
  const discogsTitle = ((album.tracklist || []).find((t) => String(t.position) === String(pos)) || {}).title;
  $('#pvTrack').textContent = discogsTitle || item.name || album.title;
  $('#pvMeta').textContent = [album.artist, pos].filter(Boolean).join(' · ');
  $('#pvFill').style.width = '0%';
  $('#pvTime').textContent = `0:00 / 0:30`;
  bar.hidden = false;
  document.body.classList.add('pv-open');
}

function hidePvBar() {
  const bar = $('#pvBar');
  if (bar) bar.hidden = true;
  document.body.classList.remove('pv-open');
}

function onPreviewTime() {
  if (!PV.current || !PV.audio) return;
  const a = PV.audio;
  const pct = a.duration ? Math.min(1, a.currentTime / a.duration) : 0;
  const row = $(`#dTracks li[data-pos="${PV.current.pos}"]`);
  if (row) row.style.setProperty('--p', pct.toFixed(3));
  const bar = $('#pvBar');
  if (bar && !bar.hidden) {
    $('#pvFill').style.width = `${(pct * 100).toFixed(2)}%`;
    $('#pvTime').textContent = `${pvClock(a.currentTime)} / ${pvClock(a.duration || 30)}`;
  }
  ['#playBtn', '#dPlay', '#dockPlay'].forEach((sel) => {
    const el = document.querySelector(sel);
    if (el && el.classList.contains('pv-live')) el.style.setProperty('--p', pct.toFixed(3));
  });
}

function togglePreview(album, pos) {
  if (!album || !pos) return false;
  const item = previewFor(album, pos);
  if (!item) return false;
  const audio = pvAudio();
  const key = releaseKey(album);
  const same = !!(PV.current && PV.current.key === key && PV.current.pos === String(pos));
  if (same) {
    if (audio.paused) audio.play().catch(() => toast('Vorschau nicht abspielbar'));
    else audio.pause();
    return true;
  }
  PV.current = { key, pos: String(pos), title: item.name || '', album };
  audio.src = item.url;
  audio.currentTime = 0;
  audio.play().catch(() => toast('Vorschau nicht abspielbar'));
  showPvBar(album, pos, item);
  syncPreviewUI();
  return true;
}

function stopPreview() {
  if (PV.audio) PV.audio.pause();
  PV.current = null;
  hidePvBar();
  syncPreviewUI();
}

function toggleAlbumPreview(album) {
  if (!album) return;
  const play = () => {
    const cur = PV.current;
    if (cur && cur.key === releaseKey(album) && PV.audio) {
      if (PV.audio.paused) PV.audio.play().catch(() => toast('Vorschau nicht abspielbar'));
      else stopPreview();
      return;
    }
    const pos = firstPreviewPos(album);
    if (pos) togglePreview(album, pos);
    else toast('Keine Vorschau gefunden');
  };
  if (previewsReady()) play();
  else loadPreviews().then(play);
}

function syncPreviewUI() {
  const cur = PV.current;
  const playing = !!(cur && PV.audio && !PV.audio.paused);
  $$('#dTracks li').forEach((li) => {
    const on = !!(cur && li.dataset.pos === cur.pos);
    li.classList.toggle('pv-on', on);
    li.classList.toggle('pv-live', on && playing);
    if (!on) li.style.setProperty('--p', '0');
  });
  const album = app.detailAlbum || app.view[app.index];
  const onThisAlbum = !!(cur && album && cur.key === releaseKey(album));
  ['#playBtn', '#dPlay', '#dockPlay'].forEach((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.classList.toggle('pv-live', onThisAlbum && playing);
    el.setAttribute('aria-pressed', String(onThisAlbum && playing));
  });
  const tog = $('#pvToggle');
  if (tog) {
    tog.classList.toggle('is-playing', playing);
    tog.setAttribute('aria-label', playing ? 'Pause' : 'Weiterhören');
    tog.setAttribute('aria-pressed', String(playing));
  }
}

function updatePreviewChip(album) {
  const has = !!(PV.byRelease && firstPreviewPos(album));
  ['#playBtn', '#dPlay', '#dockPlay'].forEach((sel) => {
    const el = document.querySelector(sel);
    if (el) el.hidden = !has;
  });
}

function refreshPreviewButtons() {
  updatePreviewChip(app.detailAlbum || app.view[app.index]);
  syncPreviewUI();
}

async function decoratePreviews(album) {
  const note = $('#dPvNote');
  await loadPreviews();
  if (!album || app.detailAlbum !== album) return;
  const entry = previewEntry(album);
  let found = 0;
  $$('#dTracks li').forEach((li, i) => {
    const pos = li.dataset.pos || '';
    const item = entry && entry.tracks ? entry.tracks[pos] : null;
    const cell = li.querySelector('.tpv');
    if (!cell) return;
    if (!item) {
      cell.innerHTML = '';
      return;
    }
    found += 1;
    const title = ((album.tracklist || [])[i] || {}).title || item.name || '';
    const src = (entry.match && entry.match.collection) || '';
    const hint = `30 s reinhören${src ? ` · Quelle: ${src}` : ''}`;
    cell.innerHTML = `<button class="pv" type="button" data-pos="${esc(pos)}" aria-pressed="false" aria-label="30 Sekunden reinhören: ${esc(title)}" title="${esc(hint)}"><span class="pv-ico" aria-hidden="true"></span></button>`;
  });
  if (note) note.hidden = found > 0;
  $('#dTracks').classList.toggle('has-pv', found > 0);
  updatePreviewChip(album);
  syncPreviewUI();
}

/* ============================================================ Track-Metadaten, Tags */
function loadLocal() {
  try {
    app.trackmeta = JSON.parse(localStorage.getItem(KEY_TRACKMETA) || '{}') || {};
  } catch (err) { app.trackmeta = {}; }
  try {
    app.tags = JSON.parse(localStorage.getItem(KEY_TAGS) || '{}') || {};
  } catch (err) { app.tags = {}; }
  try {
    const o = JSON.parse(localStorage.getItem(KEY_SETOPTS) || 'null');
    if (o && typeof o === 'object') app.setopts = { target: Number(o.target) || 60 };
  } catch (err) { /* Standard */ }
}

let metaTimer = 0;
function saveLocal() {
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY_TRACKMETA, JSON.stringify(app.trackmeta));
      localStorage.setItem(KEY_TAGS, JSON.stringify(app.tags));
      localStorage.setItem(KEY_SETOPTS, JSON.stringify(app.setopts));
    } catch (err) { console.warn('Metadaten konnten nicht gespeichert werden', err); }
  }, 150);
}

function trackKey(album, idx) {
  return `${album.release_id}:${idx}`;
}

function getTrackMeta(album, idx) {
  return app.trackmeta[trackKey(album, idx)] || null;
}

function setTrackMeta(album, idx, patch) {
  const k = trackKey(album, idx);
  const meta = Object.assign({}, app.trackmeta[k] || {}, patch);
  if (patch.bpm !== undefined && patch.bpm !== '' && patch.bpm != null) {
    meta.bpm = Math.max(20, Math.min(300, Math.round(Number(patch.bpm) || 0))) || '';
  }
  Object.keys(meta).forEach((f) => {
    if (meta[f] === '' || meta[f] == null || (f === 'bpm' && !Number(meta[f]))) delete meta[f];
  });
  if (Object.keys(meta).length) app.trackmeta[k] = meta;
  else delete app.trackmeta[k];
  saveLocal();
}

/* --- Dauer --- */
function parseDuration(value) {
  const m = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(String(value || '').trim());
  if (!m) return 0;
  return m[3] !== undefined
    ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    : Number(m[1]) * 60 + Number(m[2]);
}

function fmtDur(sec) {
  if (!sec) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${m}:${String(rest).padStart(2, '0')}`;
}

function trackDuration(album, idx) {
  const t = album && album.tracklist ? album.tracklist[idx] : null;
  return t ? parseDuration(t.duration) : 0;
}

function albumDuration(album) {
  return (album && album.tracklist ? album.tracklist : []).reduce((sum, t) => sum + parseDuration(t.duration), 0);
}

function itemDuration(item) {
  const album = albumByKey(item.iid);
  if (!album) return 0;
  return item.track != null ? trackDuration(album, item.track) : albumDuration(album);
}

/* --- Camelot / BPM --- */
function camelot(key) {
  const m = /^(\d{1,2})\s*([AB])$/i.exec(String(key || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 12) return null;
  return { n, l: m[2].toUpperCase() };
}

function normKey(raw) {
  const c = camelot(raw);
  return c ? `${c.n}${c.l}` : String(raw || '').trim().toUpperCase().slice(0, 4);
}

function keyScore(a, b) {
  const A = camelot(a);
  const B = camelot(b);
  if (!A || !B) return 0;
  if (A.n === B.n && A.l === B.l) return 3;
  const diff = Math.min(Math.abs(A.n - B.n), 12 - Math.abs(A.n - B.n));
  if (diff === 1 && A.l === B.l) return 2.5;
  if (diff === 0) return 2;
  if (diff === 2 && A.l === B.l) return 0.8;
  return 0;
}

function bpmScore(a, b) {
  if (!a || !b) return 0;
  const diff = Math.abs(a - b);
  if (diff <= 3) return 2;
  if (diff <= 6) return 1.2;
  if (diff <= 10) return 0.5;
  return 0;
}

function albumBpm(album) {
  if (!album) return 0;
  const vals = album.tracklist
    .map((_, i) => getTrackMeta(album, i))
    .filter((m) => m && Number(m.bpm))
    .map((m) => Number(m.bpm));
  if (!vals.length) return 0;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function albumKey(album) {
  if (!album) return '';
  const counts = new Map();
  album.tracklist.forEach((_, i) => {
    const m = getTrackMeta(album, i);
    if (m && m.key) counts.set(m.key, (counts.get(m.key) || 0) + 1);
  });
  const best = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : '';
}

function albumEnergy(album) {
  if (!album) return 0;
  const vals = album.tracklist
    .map((_, i) => getTrackMeta(album, i))
    .filter((m) => m && m.energy)
    .map((m) => Number(m.energy));
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function itemEnergy(item) {
  const album = albumByKey(item.iid);
  if (!album) return 0;
  if (item.track != null) {
    const m = getTrackMeta(album, item.track);
    return m && m.energy ? Number(m.energy) : 0;
  }
  return albumEnergy(album);
}

function itemLabel(item) {
  const album = albumByKey(item.iid);
  if (!album) return '';
  if (item.track != null && album.tracklist[item.track]) {
    const t = album.tracklist[item.track];
    return `${t.position ? t.position + ' · ' : ''}${t.title}`;
  }
  return '';
}

function itemBpmKey(item) {
  const album = albumByKey(item.iid);
  if (!album) return '';
  if (item.track != null) {
    const m = getTrackMeta(album, item.track);
    if (m) return [m.key, m.bpm ? `${m.bpm} BPM` : ''].filter(Boolean).join(' · ');
    return '';
  }
  return [albumKey(album), albumBpm(album) ? `Ø ${albumBpm(album)} BPM` : ''].filter(Boolean).join(' · ');
}

/* --- Tags --- */
function tagsOf(album) {
  return (album && app.tags[album.key]) || [];
}

function allTags() {
  const counts = new Map();
  Object.values(app.tags).forEach((list) => (list || []).forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]));
}

function toggleTag(album, tag) {
  const clean = String(tag || '').trim().slice(0, 24);
  if (!clean) return;
  const list = new Set(tagsOf(album));
  if (list.has(clean)) list.delete(clean);
  else list.add(clean);
  if (list.size) app.tags[album.key] = Array.from(list).sort((a, b) => collator.compare(a, b));
  else delete app.tags[album.key];
  saveLocal();
  renderTags();
  buildFacets();
  renderFilterPanel(true);
}

function renderTags() {
  const album = app.detailAlbum;
  const wrap = $('#dTags');
  if (!album) { wrap.innerHTML = ''; return; }
  const tags = tagsOf(album);
  wrap.innerHTML = tags.map((t) => `<button class="tag" type="button" data-tag="${esc(t)}" title="Tag entfernen">${esc(t)} <span aria-hidden="true">×</span></button>`).join('');
  $('#tagOptions').innerHTML = allTags().map(([t]) => `<option value="${esc(t)}"></option>`).join('');
}

function renderSuggestions() {
  const album = app.detailAlbum;
  const box = $('#dSuggest');
  if (!album) { box.hidden = true; return; }
  const styles = new Set(album.styles);
  const key = albumKey(album);
  const bpm = albumBpm(album);
  const scored = app.albums
    .filter((a) => a.key !== album.key)
    .map((a) => {
      let score = keyScore(key, albumKey(a)) + bpmScore(bpm, albumBpm(a));
      score += a.styles.filter((s) => styles.has(s)).length * 1.2;
      if (a.label && a.label === album.label) score += 0.8;
      if (a.year && album.year) score += Math.max(0, 1 - Math.abs(a.year - album.year) / 20) * 0.6;
      return { a, score };
    })
    .filter((x) => x.score >= 1.6)
    .sort((x, y) => y.score - x.score)
    .slice(0, 6);

  if (!scored.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<h3>Passt dazu</h3><div class="chips">${scored.map(({ a }) => {
    const bk = albumKey(a);
    const bp = albumBpm(a);
    const meta = [bk, bp ? `${bp}` : ''].filter(Boolean).join(' · ');
    return `<button class="chip" type="button" data-key="${esc(a.key)}" title="${esc(a.artist + ' – ' + a.title)}">${esc(a.title)}<em>${esc(a.artist)}${meta ? ' · ' + esc(meta) : ''}</em></button>`;
  }).join('')}</div>`;
}


/* ============================================================ Setlisten */
function newSet(name) {
  return { id: 'sl_' + Math.random().toString(36).slice(2, 9), name: name || 'Neue Setliste', items: [] };
}

function activeSetlist() {
  return app.sets.find((s) => s.id === app.activeSet) || null;
}

function loadSets() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY_SETS) || 'null');
    if (raw && Array.isArray(raw.lists) && raw.lists.length) {
      app.sets = raw.lists.filter((s) => s && Array.isArray(s.items)).map((s) => ({
        id: s.id || 'sl_' + Math.random().toString(36).slice(2, 9),
        name: s.name || 'Setliste',
        items: s.items.filter((i) => i && i.iid != null).map((i) => ({
          iid: String(i.iid),
          note: i.note || '',
          track: i.track === null || i.track === undefined || i.track === '' ? null : Number(i.track),
        })),
      }));
      app.activeSet = raw.active || app.sets[0].id;
    }
  } catch (err) {
    console.warn('Setlisten konnten nicht gelesen werden', err);
  }
  if (!app.sets.length) {
    app.sets = [newSet('Meine Auswahl')];
    app.activeSet = app.sets[0].id;
  }
  if (!app.sets.some((s) => s.id === app.activeSet)) app.activeSet = app.sets[0].id;
  saveSets();
}

let saveTimer = 0;
function saveSets() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY_SETS, JSON.stringify({ active: app.activeSet, lists: app.sets }));
    } catch (err) {
      console.warn('Setlisten konnten nicht gespeichert werden', err);
    }
  }, 120);
}

function validateSetlists() {
  /* Verwaiste Einträge (Album nicht mehr in der Sammlung) bleiben sichtbar
     und werden in der Liste als "Nicht in der Sammlung" gekennzeichnet. */
}

function albumByKey(key) {
  return app.albums.find((a) => a.key === String(key)) || null;
}

function toggleInSet(album) {
  if (!album) return;
  let set = activeSetlist();
  if (!set) {
    set = newSet('Meine Auswahl');
    app.sets.push(set);
    app.activeSet = set.id;
  }
  const idx = set.items.findIndex((i) => i.iid === album.key);
  if (idx >= 0) {
    set.items.splice(idx, 1);
    toast(`„${album.title}“ entfernt`);
  } else {
    set.items.push({ iid: album.key, note: '' });
    toast(`„${album.title}“ zur Setliste hinzugefügt`);
  }
  saveSets();
  updateStar();
  if (app.mode === 'grid') {
    app.gridDirty = true;
    renderGrid();
  }
  if (!$('#setPanel').hidden) renderSetItems();
}

function renderSetSelect() {
  const sel = $('#setSelect');
  sel.innerHTML = app.sets.map((s) => `<option value="${s.id}"${s.id === app.activeSet ? ' selected' : ''}>${esc(s.name)} (${s.items.length})</option>`).join('');
}

function renderSetItems() {
  renderSetSelect();
  const set = activeSetlist();
  const list = $('#setItems');
  const stat = $('#setStats');
  const target = $('#setTarget');
  if (target && document.activeElement !== target) target.value = String(app.setopts.target || '');

  if (!set) {
    list.innerHTML = '';
    stat.textContent = 'Keine Setliste';
    $('#setEnergy').innerHTML = '';
    return;
  }

  const total = set.items.length;
  const durations = set.items.map(itemDuration);
  const sum = durations.reduce((a, b) => a + b, 0);
  const missing = durations.filter((d) => !d).length;
  const bpms = set.items
    .map((item) => {
      const a = albumByKey(item.iid);
      if (!a) return 0;
      if (item.track != null) return Number((getTrackMeta(a, item.track) || {}).bpm) || 0;
      return albumBpm(a);
    })
    .filter(Boolean);
  const avgBpm = bpms.length ? Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length) : 0;
  const targetSec = (Number(app.setopts.target) || 0) * 60;

  const parts = [`${total} ${total === 1 ? 'Track' : 'Einträge'}`];
  if (sum) parts.push(fmtDur(sum));
  if (missing) parts.push(`${missing} ohne Länge`);
  if (bpms.length) parts.push(bpms.length > 1 ? `Ø ${avgBpm} BPM` : `${avgBpm} BPM`);
  if (targetSec && sum) {
    const diff = targetSec - sum;
    parts.push(diff >= 0 ? `${fmtDur(diff)} Luft` : `${fmtDur(-diff)} zu lang`);
  }
  stat.textContent = parts.join(' · ');

  renderEnergy();

  if (!total) {
    list.innerHTML = '<li class="setempty">Noch nichts gemerkt.<br>Über „☆ Setliste“ unter dem Cover oder in der Detailansicht hinzufügen.</li>';
    return;
  }

  list.innerHTML = set.items.map((item, i) => {
    const a = albumByKey(item.iid);
    const thumb = a && a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy">` : (a ? esc(initials(a)) : '?');
    const name = a ? esc(a.title) : 'Nicht in der Sammlung';
    const dur = itemDuration(item);
    const extra = [a ? esc(a.artist) : String(item.iid), a && a.year ? a.year : '', dur ? fmtDur(dur) : '', itemBpmKey(item)]
      .filter(Boolean).join(' · ');
    const trackOpts = a
      ? a.tracklist.map((t, ti) => `<option value="${ti}"${item.track === ti ? ' selected' : ''}>${esc((t.position ? t.position + ' · ' : '') + t.title)}</option>`).join('')
      : '';
    const whole = a && albumDuration(a) ? ` · ${fmtDur(albumDuration(a))}` : '';
    return `<li class="sitem" draggable="true" data-idx="${i}">
      <span class="sthumb">${thumb}</span>
      <span class="sinfo">
        <span class="sname">${name}</span>
        <span class="ssub">${extra}</span>
        <select class="strack" data-idx="${i}" aria-label="Track für ${name}"><option value="">Ganzes Album${whole}</option>${trackOpts}</select>
        <input class="snote" data-idx="${i}" value="${esc(item.note || '')}" placeholder="BPM · Key · Track/Seite" aria-label="Notiz zu ${name}">
      </span>
      <button class="sremove" data-idx="${i}" aria-label="${name} entfernen">×</button>
    </li>`;
  }).join('');
  updateStar();
  renderSetSelect();
}

function renderEnergy() {
  const svg = $('#setEnergy');
  if (!svg) return;
  const items = (activeSetlist() || { items: [] }).items;
  const pts = [];
  items.forEach((item, i) => {
    const e = itemEnergy(item);
    if (e) pts.push({ i, e });
  });
  if (pts.length < 2) {
    svg.style.display = 'none';
    svg.innerHTML = '';
    return;
  }
  const n = Math.max(1, items.length - 1);
  const points = pts.map(({ i, e }) => `${((i / n) * 100).toFixed(1)},${(32 - ((e - 1) / 4) * 28).toFixed(1)}`).join(' ');
  svg.style.display = '';
  svg.innerHTML = `<polyline points="${points}" fill="none" stroke="rgba(255,214,140,.9)" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"></polyline>`;
}

function refreshSetPanel() {
  renderSetItems();
}

/* --- Drag & Drop --- */
let dragFrom = null;
function bindSetDnD() {
  const list = $('#setItems');
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.sitem');
    if (!li) return;
    dragFrom = Number(li.dataset.idx);
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(dragFrom)); } catch (err) { /* egal */ }
  });
  list.addEventListener('dragend', () => {
    $$('.sitem', list).forEach((li) => li.classList.remove('dragging', 'over'));
    dragFrom = null;
  });
  list.addEventListener('dragover', (e) => {
    const li = e.target.closest('.sitem');
    if (!li) return;
    e.preventDefault();
    $$('.sitem.over', list).forEach((x) => x.classList.remove('over'));
    li.classList.add('over');
  });
  list.addEventListener('drop', (e) => {
    const li = e.target.closest('.sitem');
    if (!li || dragFrom == null) return;
    e.preventDefault();
    const to = Number(li.dataset.idx);
    const set = activeSetlist();
    if (!set || to === dragFrom) return;
    const [moved] = set.items.splice(dragFrom, 1);
    set.items.splice(to, 0, moved);
    saveSets();
    renderSetItems();
  });
}

/* --- Export / Import --- */
function setAsText(set) {
  const lines = [];
  set.items.forEach((item, i) => {
    const a = albumByKey(item.iid);
    const head = a ? `${a.artist} – ${a.title}${a.year ? ` (${a.year})` : ''}` : `Unbekannt (${item.iid})`;
    const extra = a && a.label ? ` [${a.label}${a.catno ? ' ' + a.catno : ''}]` : '';
    const track = item.track != null && a ? ` → ${itemLabel(item)}${itemBpmKey(item) ? ` (${itemBpmKey(item)})` : ''}` : '';
    const note = item.note ? `  — ${item.note}` : '';
    lines.push(`${String(i + 1).padStart(2, ' ')}. ${head}${track}${extra}${note}`);
  });
  return `${set.name}\n${'='.repeat(set.name.length)}\n\n${lines.join('\n')}\n`;
}

function setAsCsv(set) {
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const rows = [['Nr', 'Artist', 'Titel', 'Track', 'Dauer', 'Jahr', 'Label', 'Katalognr.', 'BPM/Key', 'Notiz', 'Discogs']];
  set.items.forEach((item, i) => {
    const a = albumByKey(item.iid);
    const dur = itemDuration(item);
    rows.push([
      i + 1,
      a ? a.artist : '',
      a ? a.title : '',
      a && item.track != null ? itemLabel(item) : '',
      dur ? fmtDur(dur) : '',
      a ? a.year || '' : '',
      a ? a.label : '',
      a ? a.catno : '',
      itemBpmKey(item),
      item.note || '',
      a ? a.discogs_url : '',
    ]);
  });
  return '\ufeff' + rows.map((r) => r.map(q).join(';')).join('\r\n');
}

function exportPayload() {
  return {
    app: 'lp-bibliothek',
    version: 1,
    exported_at: new Date().toISOString(),
    lists: app.sets.map((s) => ({
      name: s.name,
      items: s.items.map((item) => {
        const a = albumByKey(item.iid);
        return {
          instance_id: a ? a.instance_id : item.iid,
          release_id: a ? a.release_id : null,
          artist: a ? a.artist : '',
          title: a ? a.title : '',
          year: a ? a.year : 0,
          note: item.note || '',
          track: item.track != null ? item.track : null,
          duration: itemDuration(item) || 0,
        };
      }),
    })),
  };
}

async function importPayload(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    toast('JSON konnte nicht gelesen werden');
    return;
  }
  const lists = Array.isArray(data) ? data : data.lists || (data.items ? [data] : []);
  if (!Array.isArray(lists) || !lists.length) {
    toast('Keine Setlisten in der Datei gefunden');
    return;
  }
  let added = 0;
  lists.forEach((raw) => {
    const set = newSet(raw.name || 'Import');
    (raw.items || []).forEach((it) => {
      const iid = it.instance_id != null ? String(it.instance_id) : it.release_id != null ? String(it.release_id) : null;
      let album = iid ? albumByKey(iid) : null;
      if (!album && it.release_id != null) album = app.albums.find((a) => String(a.release_id) === String(it.release_id)) || null;
      if (album) {
        set.items.push({ iid: album.key, note: it.note || '', track: Number.isInteger(it.track) ? it.track : null });
        added += 1;
      }
    });
    app.sets.push(set);
  });
  app.activeSet = app.sets[app.sets.length - 1].id;
  saveSets();
  refreshSetPanel();
  updateStar();
  toast(`${lists.length} Setliste(n) importiert · ${added} Alben zugeordnet`);
}

function printSetlist() {
  const set = activeSetlist();
  if (!set || !set.items.length) {
    toast('Setliste ist leer');
    return;
  }
  const rows = set.items.map((item, i) => {
    const a = albumByKey(item.iid);
    const track = item.track != null && a ? `<span class="pnote">${esc(itemLabel(item))}${itemBpmKey(item) ? ` · ${esc(itemBpmKey(item))}` : ''}</span>` : '';
    const note = item.note ? `<span class="pnote">${esc(item.note)}</span>` : '';
    return `<tr>
      <td class="num">${i + 1}</td>
      <td class="artist">${esc(a ? a.artist : '—')}</td>
      <td class="title">${esc(a ? a.title : 'Nicht in Sammlung')}${track}${note}</td>
      <td class="yr">${a && a.year ? a.year : ''}</td>
    </tr>`;
  }).join('');
  $('#printArea').innerHTML = `
    <h1>${esc(set.name)}</h1>
    <p class="pmeta">${set.items.length} Alben · erstellt ${new Date().toLocaleDateString('de-DE')} · LP-Bibliothek</p>
    <table><thead><tr><th></th><th>Artist</th><th>Titel</th><th>Jahr</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="pfoot">Notizen in Kursivspalte = BPM / Key / Track / Seite.</p>`;
  window.print();
}

/* ============================================================ Statistik */
const MONTHS_DE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

function topEntries(map, n) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]))
    .slice(0, n);
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function barHTML(entries, fmt) {
  const max = Math.max(1, ...entries.map((e) => e[1]));
  return `<div class="bars">${entries.map(([k, v]) => `
    <div class="bar">
      <span class="bar-label" title="${esc(k)}">${esc(fmt ? fmt(k) : k)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${((v / max) * 100).toFixed(1)}%"></span></span>
      <span class="bar-val">${v}</span>
    </div>`).join('')}</div>`;
}

function computeStats() {
  const decades = new Map();
  const labels = new Map();
  const styles = new Map();
  const genres = new Map();
  const months = new Map();
  const byRelease = new Map();
  let tracks = 0;
  let noYear = 0;
  let noCover = 0;
  let minYear = Infinity;
  let maxYear = 0;
  let lastAdded = '';

  app.albums.forEach((a) => {
    tracks += a.tracklist.length;
    if (!a.year) noYear += 1;
    else { minYear = Math.min(minYear, a.year); maxYear = Math.max(maxYear, a.year); }
    if (!a.cover) noCover += 1;
    bump(decades, a.year ? Math.floor(a.year / 10) * 10 : 0);
    if (a.label) bump(labels, a.label);
    a.styles.forEach((s) => bump(styles, s));
    a.genres.forEach((g) => bump(genres, g));
    if (a.added) {
      bump(months, a.added.slice(0, 7));
      if (a.added > lastAdded) lastAdded = a.added;
    }
    const rid = String(a.release_id);
    if (!byRelease.has(rid)) byRelease.set(rid, []);
    byRelease.get(rid).push(a);
  });

  const dupes = Array.from(byRelease.values()).filter((g) => g.length > 1)
    .sort((a, b) => b.length - a.length);

  return {
    total: app.albums.length,
    tracks,
    labels: labels.size,
    genres: genres.size,
    minYear: minYear === Infinity ? 0 : minYear,
    maxYear,
    noYear,
    noCover,
    lastAdded,
    decades: Array.from(decades.entries()).sort((a, b) => (a[0] === 0 ? 1 : b[0] === 0 ? -1 : a[0] - b[0])),
    months: Array.from(months.entries()).sort((a, b) => a[0].localeCompare(b[0])).slice(-12),
    topLabels: topEntries(labels, 10),
    topStyles: topEntries(styles, 10),
    topGenres: topEntries(genres, 7),
    dupes,
    years: app.albums.filter((a) => !a.year),
  };
}

function renderStats() {
  const s = computeStats();
  const monthLabel = (key) => {
    const [y, m] = key.split('-');
    return `${MONTHS_DE[Number(m) - 1]} ${y.slice(2)}`;
  };
  $('#statsSub').textContent = `${s.total} Alben · ${s.tracks.toLocaleString('de-DE')} Tracks · ${s.labels} Labels · Stand ${fmtDate(s.lastAdded)}`;

  const kpis = [
    [s.total, 'Alben'],
    [s.tracks.toLocaleString('de-DE'), 'Tracks'],
    [s.labels, 'Labels'],
    [s.genres, 'Genres'],
    [s.minYear && s.maxYear ? `${s.minYear}–${s.maxYear}` : '—', 'Erscheinungsjahre'],
    [s.noYear, 'ohne Jahr'],
    [s.dupes.length, 'Duplikate'],
    [s.noCover, 'ohne Cover'],
  ];

  const yearChips = s.years.length
    ? s.years.map((a) => `<button class="gap-item" type="button" data-key="${esc(a.key)}" title="${esc(a.artist + ' – ' + a.title)}">${esc(a.artist)} – ${esc(a.title)}</button>`).join('')
    : '<p class="stat-hint">Keine Lücken – bei allen Alben ist ein Jahr hinterlegt.</p>';

  const dupRows = s.dupes.length
    ? s.dupes.slice(0, 30).map((g) => `<div class="dup-row"><button type="button" data-key="${esc(g[0].key)}">${esc(g[0].artist)} – ${esc(g[0].title)}</button><span class="dup-count">${g.length}× im Regal</span></div>`).join('')
    : '<p class="stat-hint">Keine doppelten Releases gefunden.</p>';

  $('#statsBody').innerHTML = `
    <div class="kpis">${kpis.map(([v, l]) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join('')}</div>
    <div class="stat-grid">
      <section class="stat-sec">
        <h3>Nach Jahrzehnt</h3>
        ${barHTML(s.decades, (k) => (Number(k) ? `${k}er` : 'unbekannt'))}
      </section>
      <section class="stat-sec">
        <h3>Zugänge pro Monat</h3>
        ${barHTML(s.months, monthLabel)}
      </section>
      <section class="stat-sec">
        <h3>Top-Labels</h3>
        ${barHTML(s.topLabels)}
      </section>
      <section class="stat-sec">
        <h3>Top-Styles</h3>
        ${barHTML(s.topStyles)}
      </section>
      <section class="stat-sec stat-wide">
        <h3>Genres</h3>
        ${barHTML(s.topGenres)}
      </section>
      <section class="stat-sec stat-wide">
        <h3>Lücken: Alben ohne Jahr (${s.years.length})</h3>
        <div class="gap-list">${yearChips}</div>
      </section>
      <section class="stat-sec stat-wide">
        <h3>Duplikate (${s.dupes.length})</h3>
        ${dupRows}
      </section>
    </div>`;
}

function openStats() {
  renderStats();
  const el = $('#stats');
  el.hidden = false;
  document.body.style.overflow = 'hidden';
  $('#statsClose').focus({ preventScroll: true });
}

function closeStats() {
  if ($('#stats').hidden) return;
  $('#stats').hidden = true;
  if ($('#detail').hidden && !gig.open) document.body.style.overflow = '';
}

/* ============================================================ Gig-Modus */
const gig = { open: false, i: 0, lock: null };

function gigItems() {
  const set = activeSetlist();
  return set ? set.items : [];
}

function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !gig.lock) {
      navigator.wakeLock.request('screen').then((lock) => { gig.lock = lock; }).catch(() => {});
    }
  } catch (err) { /* nicht unterstützt */ }
}

function releaseWakeLock() {
  try { if (gig.lock) gig.lock.release(); } catch (err) { /* egal */ }
  gig.lock = null;
}

function openGig() {
  if (!gigItems().length) {
    toast('Setliste ist leer');
    return;
  }
  closeSetPanel();
  gig.open = true;
  gig.i = 0;
  $('#gig').hidden = false;
  document.body.style.overflow = 'hidden';
  renderGig();
  requestWakeLock();
  $('#gigNextBtn').focus({ preventScroll: true });
}

function closeGig() {
  if (!gig.open) return;
  gig.open = false;
  $('#gig').hidden = true;
  releaseWakeLock();
  if (!app.detailAlbum) document.body.style.overflow = '';
}

function gigMove(step) {
  const n = gigItems().length;
  if (!n) return;
  gig.i = (gig.i + step + n) % n;
  renderGig();
}

function renderGig() {
  const items = gigItems();
  if (!items.length) return closeGig();
  if (gig.i >= items.length) gig.i = 0;
  const item = items[gig.i];
  const album = albumByKey(item.iid);
  const cover = $('#gigCover');
  const ph = $('#gigPh');

  if (album && album.cover) {
    cover.src = album.cover;
    cover.alt = `Cover von ${album.artist} – ${album.title}`;
    cover.hidden = false;
    ph.hidden = true;
    $('#gigBg').style.setProperty('--cover-bg', `url("${album.cover.replace(/"/g, '%22')}")`);
  } else {
    cover.removeAttribute('src');
    cover.hidden = true;
    ph.hidden = false;
    ph.textContent = album ? initials(album) : '?';
    ph.style.setProperty('--c1', album ? album.colors[0] : '#2c2c34');
    ph.style.setProperty('--c2', album ? (album.colors[1] || album.colors[0]) : '#18181d');
    $('#gigBg').style.removeProperty('--cover-bg');
  }

  $('#gigArtist').textContent = album ? album.artist : 'Nicht in der Sammlung';
  $('#gigTitle').textContent = album ? album.title : String(item.iid);
  const trackInfo = album && item.track != null ? itemLabel(item) : '';
  $('#gigMeta').textContent = album
    ? [album.year || 'Jahr unbekannt', album.label, album.format, trackInfo, itemBpmKey(item)].filter(Boolean).join('  ·  ')
    : '';
  const note = $('#gigNote');
  note.textContent = item.note || (album ? 'Keine Notiz – im Setlisten-Panel ergänzen' : '');
  note.classList.toggle('is-empty', !item.note);
  $('#gigPos').textContent = `${gig.i + 1} / ${items.length}`;
  const set = activeSetlist();
  $('#gigSet').textContent = set ? `${set.name} · ${items.length} ${items.length === 1 ? 'Album' : 'Alben'}` : '';
  const next = items[(gig.i + 1) % items.length];
  const nextAlbum = albumByKey(next ? next.iid : '');
  $('#gigNextLabel').textContent = nextAlbum ? `nächstes: ${nextAlbum.artist} – ${nextAlbum.title}` : '';
}

/* ============================================================ Deep-Links */
function setHash(album) {
  const h = `#release/${album.release_id}`;
  if (location.hash !== h) history.replaceState(null, '', `${location.pathname}${location.search}${h}`);
}

function clearHash() {
  if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
}

function focusAlbum(album) {
  const pos = app.view.findIndex((a) => a.key === album.key);
  if (pos >= 0) {
    app.index = pos;
    resetFlow();
    renderFlow();
    updateNowPlaying();
  }
  updateGlow(album);
  saveUI();
}

function applyHash() {
  const m = location.hash.match(/^#release\/(\d+)/);
  if (!m) {
    if (!$('#detail').hidden) closeDetail();
    return;
  }
  const album = app.albums.find((a) => String(a.release_id) === m[1]);
  if (!album) return;
  focusAlbum(album);
  openDetail(album, { fromHash: true });
  if (app.mode === 'grid') {
    app.gridDirty = true;
    renderGrid();
  }
}


/* ============================================================ UI-Zustand */
function saveUI() {
  try {
    const album = app.view[app.index];
    localStorage.setItem(KEY_UI, JSON.stringify({
      query: app.query,
      sort: app.sort,
      filters: app.filters,
      mode: app.mode,
      activeSet: app.activeSet,
      current: album ? album.key : null,
    }));
  } catch (err) { /* Speicher voll/gesperrt */ }
}

function restoreUI() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY_UI) || 'null');
    if (!raw) return;
    if (typeof raw.query === 'string') app.query = raw.query;
    if (raw.sort && raw.sort.key) app.sort = { key: raw.sort.key, dir: raw.sort.dir === 'asc' ? 'asc' : 'desc' };
    if (raw.filters) {
      Object.keys(app.filters).forEach((k) => {
        if (Array.isArray(raw.filters[k])) app.filters[k] = raw.filters[k].map(String);
      });
      // Altbestand: Jahrzehnte wurden frueher als "1980er" gespeichert
      app.filters.decade = app.filters.decade.map((v) => v.replace(/er$/, ''));
    }
    if (raw.mode === 'grid' || raw.mode === 'glass') app.mode = raw.mode;
    if (raw.activeSet) app.activeSet = raw.activeSet;
    app.restoreCurrent = raw.current || null;
  } catch (err) { /* ignorieren */ }
}

/* ============================================================ Events */
function bindEvents() {
  /* Navigation */
  $('#prevBtn').addEventListener('click', () => setIndex(app.index - 1));
  $('#nextBtn').addEventListener('click', () => setIndex(app.index + 1));
  $('#dockPrev').addEventListener('click', () => setIndex(app.index - 1));
  $('#dockNext').addEventListener('click', () => setIndex(app.index + 1));
  $('#slider').addEventListener('input', (e) => setIndex(Number(e.target.value)));
  $('#detailBtn').addEventListener('click', () => openDetail(app.view[app.index]));
  $('#starBtn').addEventListener('click', () => toggleInSet(app.view[app.index]));
  $('#dStar').addEventListener('click', () => {
    if (app.detailAlbum) {
      toggleInSet(app.detailAlbum);
      updateStar();
    }
  });
  $('#detailClose').addEventListener('click', closeDetail);
  $('#detail').addEventListener('click', (e) => {
    if (e.target.id === 'detail') closeDetail();
  });

  /* Vorschau */
  $('#playBtn').addEventListener('click', () => toggleAlbumPreview(app.view[app.index]));
  $('#dPlay').addEventListener('click', () => toggleAlbumPreview(app.detailAlbum));
  $('#dockPlay').addEventListener('click', () => toggleAlbumPreview(app.view[app.index]));
  $('#dTracks').addEventListener('click', (e) => {
    const btn = e.target.closest('.pv');
    if (!btn || !app.detailAlbum) return;
    togglePreview(app.detailAlbum, btn.dataset.pos);
  });
  $('#pvToggle').addEventListener('click', () => {
    if (PV.current && PV.current.album) togglePreview(PV.current.album, PV.current.pos);
  });
  $('#pvClose').addEventListener('click', () => stopPreview());

  /* Track-Metadaten (BPM / Key / Energie) */
  $('#dTracks').addEventListener('input', (e) => {
    const el = e.target;
    if (!(el instanceof Element) || !app.detailAlbum) return;
    const idx = Number(el.dataset.idx);
    if (el.classList.contains('t-bpm')) setTrackMeta(app.detailAlbum, idx, { bpm: el.value === '' ? '' : Number(el.value) });
    else if (el.classList.contains('t-key')) setTrackMeta(app.detailAlbum, idx, { key: normKey(el.value) });
  });
  $('#dTracks').addEventListener('change', (e) => {
    const el = e.target;
    if (!(el instanceof Element) || !app.detailAlbum) return;
    const idx = Number(el.dataset.idx);
    if (el.classList.contains('t-energy')) setTrackMeta(app.detailAlbum, idx, { energy: el.value ? Number(el.value) : '' });
    if (el.classList.contains('t-key')) el.value = normKey(el.value);
    if (el.classList.contains('t-bpm') || el.classList.contains('t-key') || el.classList.contains('t-energy')) {
      renderFacts(app.detailAlbum);
      renderSuggestions();
      if (!$('#setPanel').hidden) renderSetItems();
    }
  });

  /* Tags */
  $('#dTags').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-tag]');
    if (!chip || !app.detailAlbum) return;
    toggleTag(app.detailAlbum, chip.dataset.tag);
  });
  $('#dTagInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const value = e.target.value.trim();
    if (!value || !app.detailAlbum) return;
    toggleTag(app.detailAlbum, value);
    e.target.value = '';
  });

  /* Übergangsvorschläge */
  $('#dSuggest').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-key]');
    if (!chip) return;
    const album = albumByKey(chip.dataset.key);
    if (!album) return;
    focusAlbum(album);
    openDetail(album);
  });

  /* Zufallsalbum */
  $('#randomBtn').addEventListener('click', randomAlbum);

  /* Statistik */
  $('#statsBtn').addEventListener('click', openStats);
  $('#statsClose').addEventListener('click', closeStats);
  $('#stats').addEventListener('click', (e) => {
    if (e.target.id === 'stats') closeStats();
  });
  $('#statsBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-key]');
    if (!btn) return;
    const album = albumByKey(btn.dataset.key);
    if (!album) return;
    closeStats();
    focusAlbum(album);
    openDetail(album);
  });

  /* Gig-Modus */
  $('#gigBtn').addEventListener('click', openGig);
  $('#gigClose').addEventListener('click', closeGig);
  $('#gigPrev').addEventListener('click', () => gigMove(-1));
  $('#gigNextBtn').addEventListener('click', () => gigMove(1));
  let gigTouchX = 0;
  let gigTouchY = 0;
  $('#gig').addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    gigTouchX = e.touches[0].clientX;
    gigTouchY = e.touches[0].clientY;
  }, { passive: true });
  $('#gig').addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    const dx = t.clientX - gigTouchX;
    const dy = t.clientY - gigTouchY;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) gigMove(dx < 0 ? 1 : -1);
  }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (gig.open && document.visibilityState === 'visible') requestWakeLock();
  });

  /* Deep-Links */
  window.addEventListener('hashchange', applyHash);

  /* Tastatur */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (gig.open) return closeGig();
      if (!$('#stats').hidden) return closeStats();
      if (!$('#detail').hidden) return closeDetail();
      if (!$('#setPanel').hidden) return closeSetPanel();
      if (!$('#filterPanel').hidden || !$('#sortPanel').hidden) return closePopovers();
      return;
    }
    if (gig.open) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault();
        return gigMove(1);
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault();
        return gigMove(-1);
      }
      return;
    }
    const t = e.target;
    if (t instanceof Element && t.matches('input, textarea, select, [contenteditable="true"]')) return;
    if ((e.key === 'p' || e.key === 'P') && !$('#detail').hidden) {
      e.preventDefault();
      return toggleAlbumPreview(app.detailAlbum);
    }
    if (!$('#detail').hidden || !$('#stats').hidden) return;
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault(); setIndex(app.index - 1); break;
      case 'ArrowRight':
        e.preventDefault(); setIndex(app.index + 1); break;
      case 'ArrowUp':
        e.preventDefault(); setIndex(app.index - 1); break;
      case 'ArrowDown':
        e.preventDefault(); setIndex(app.index + 1); break;
      case 'PageUp':
        e.preventDefault(); setIndex(app.index - 10); break;
      case 'PageDown':
        e.preventDefault(); setIndex(app.index + 10); break;
      case 'Home':
        e.preventDefault(); setIndex(0); break;
      case 'End':
        e.preventDefault(); setIndex(app.view.length - 1); break;
      case 'r':
      case 'R':
        e.preventDefault(); randomAlbum(); break;
      case 'p':
      case 'P':
        e.preventDefault(); toggleAlbumPreview(app.detailAlbum || app.view[app.index]); break;
      default: break;
    }
  });

  /* Mausrad */
  let wheelAcc = 0;
  let wheelLock = 0;
  $('#stage').addEventListener('wheel', (e) => {
    if ($('#detail').hidden === false) return;
    e.preventDefault();
    const now = Date.now();
    if (now < wheelLock) return;
    wheelAcc += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(wheelAcc) > 55) {
      setIndex(app.index + (wheelAcc > 0 ? 1 : -1));
      wheelAcc = 0;
      wheelLock = now + 260;
    }
  }, { passive: false });

  /* Touch */
  let touchX = 0, touchY = 0, touching = false;
  const stage = $('#stage');
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    touchX = e.touches[0].clientX;
    touchY = e.touches[0].clientY;
    touching = true;
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (!touching) return;
    touching = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchX;
    const dy = t.clientY - touchY;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) setIndex(app.index + (dx < 0 ? 1 : -1));
  }, { passive: true });

  /* Suche */
  let searchTimer = 0;
  $('#search').addEventListener('input', (e) => {
    app.query = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      applyFilter();
      app.index = 0;
      resetFlow();
      renderAll();
      saveUI();
    }, 140);
  });
  $('#search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.target.value = '';
      app.query = '';
      applyFilter();
      app.index = 0;
      resetFlow();
      renderAll();
      saveUI();
      e.target.blur();
    }
  });

  /* Panels */
  $('#filterBtn').addEventListener('click', () => togglePopover('filterPanel'));
  $('#sortBtn').addEventListener('click', () => togglePopover('sortPanel'));
  $('.viewswitch').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });
  $('#setBtn').addEventListener('click', () => {
    if ($('#setPanel').hidden) openSetPanel();
    else closeSetPanel();
  });
  $('#setClose').addEventListener('click', closeSetPanel);

  document.addEventListener('click', (e) => {
    // Nach einem Re-Render ist das Klickziel nicht mehr im Dokument; dann
    // nichts schliessen (sonst klappt das Filterpanel nach jedem Chip zu).
    if (e.target instanceof Element && !e.target.isConnected) return;
    if (!$('#filterPanel').hidden && !$('#filterPanel').contains(e.target) && !$('#filterBtn').contains(e.target)) $('#filterPanel').hidden = true;
    if (!$('#sortPanel').hidden && !$('#sortPanel').contains(e.target) && !$('#sortBtn').contains(e.target)) $('#sortPanel').hidden = true;
    renderCount();
  });

  $('#filterBody').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const group = chip.dataset.group;
    const value = chip.dataset.value;
    const arr = app.filters[group];
    const i = arr.indexOf(value);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(value);
    chip.setAttribute('aria-pressed', i >= 0 ? 'false' : 'true');
    applyFilter();
    app.index = 0;
    resetFlow();
    renderAll();
    saveUI();
  });
  $('#filterReset').addEventListener('click', () => {
    Object.keys(app.filters).forEach((k) => { app.filters[k] = []; });
    applyFilter();
    app.index = 0;
    resetFlow();
    renderAll();
    saveUI();
  });

  $('#sortBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sort]');
    if (!btn) return;
    const key = btn.dataset.sort;
    if (app.sort.key === key) app.sort.dir = app.sort.dir === 'asc' ? 'desc' : 'asc';
    else app.sort = { key, dir: key === 'added' ? 'desc' : key === 'year' ? 'asc' : 'asc' };
    applyFilter();
    app.index = 0;
    resetFlow();
    renderAll();
    saveUI();
  });

  /* Raster: native Button-Aktivierung genügt (Enter/Space) */

  /* Setlisten */
  $('#setSelect').addEventListener('change', (e) => {
    app.activeSet = e.target.value;
    saveSets();
    saveUI();
    renderSetItems();
    updateStar();
  });
  $('#setNew').addEventListener('click', () => {
    const name = prompt('Name der neuen Setliste:', `Set ${app.sets.length + 1}`);
    if (name == null) return;
    const set = newSet(name.trim() || `Set ${app.sets.length + 1}`);
    app.sets.push(set);
    app.activeSet = set.id;
    saveSets();
    renderSetItems();
    updateStar();
    toast('Setliste angelegt');
  });
  $('#setRename').addEventListener('click', () => {
    const set = activeSetlist();
    if (!set) return;
    const name = prompt('Neuer Name:', set.name);
    if (name == null || !name.trim()) return;
    set.name = name.trim();
    saveSets();
    renderSetItems();
  });
  $('#setDelete').addEventListener('click', () => {
    const set = activeSetlist();
    if (!set) return;
    if (!confirm(`Setliste „${set.name}“ mit ${set.items.length} Alben löschen?`)) return;
    app.sets = app.sets.filter((s) => s.id !== set.id);
    if (!app.sets.length) app.sets = [newSet('Meine Auswahl')];
    app.activeSet = app.sets[0].id;
    saveSets();
    renderSetItems();
    updateStar();
    toast('Setliste gelöscht');
  });
  $('#setItems').addEventListener('click', (e) => {
    const rm = e.target.closest('.sremove');
    if (rm) {
      const set = activeSetlist();
      if (!set) return;
      set.items.splice(Number(rm.dataset.idx), 1);
      saveSets();
      renderSetItems();
      updateStar();
    }
  });
  $('#setItems').addEventListener('input', (e) => {
    const input = e.target.closest('.snote');
    if (!input) return;
    const set = activeSetlist();
    if (!set) return;
    const item = set.items[Number(input.dataset.idx)];
    if (item) {
      item.note = input.value;
      saveSets();
    }
  });
  $('#setItems').addEventListener('change', (e) => {
    const sel = e.target.closest('.strack');
    if (!sel) return;
    const set = activeSetlist();
    if (!set) return;
    const item = set.items[Number(sel.dataset.idx)];
    if (!item) return;
    item.track = sel.value === '' ? null : Number(sel.value);
    saveSets();
    renderSetItems();
  });
  $('#setTarget').addEventListener('change', (e) => {
    const v = Math.max(0, Math.min(600, Number(e.target.value) || 0));
    app.setopts.target = v;
    e.target.value = String(v);
    saveLocal();
    renderSetItems();
  });

  $('#exportText').addEventListener('click', async () => {
    const set = activeSetlist();
    if (!set) return;
    const text = setAsText(set);
    try {
      await navigator.clipboard.writeText(text);
      toast('Textliste in die Zwischenablage kopiert');
    } catch (err) {
      download(`${slug(set.name)}.txt`, text);
      toast('Textliste als Datei gespeichert');
    }
  });
  $('#exportCsv').addEventListener('click', () => {
    const set = activeSetlist();
    if (!set) return;
    download(`${slug(set.name)}.csv`, setAsCsv(set), 'text/csv;charset=utf-8');
    toast('CSV gespeichert');
  });
  $('#exportJson').addEventListener('click', () => {
    download('setlisten.json', JSON.stringify(exportPayload(), null, 2), 'application/json');
    toast('JSON gespeichert');
  });
  $('#importJson').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    await importPayload(await file.text());
    e.target.value = '';
  });
  $('#printSet').addEventListener('click', printSetlist);

  /* Resize */
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (app.mode === 'flow') renderFlow();
    }, 100);
  });
}

function togglePopover(id) {
  const el = $('#' + id);
  const other = id === 'filterPanel' ? $('#sortPanel') : $('#filterPanel');
  other.hidden = true;
  el.hidden = !el.hidden;
  renderCount();
}
function closePopovers() {
  $('#filterPanel').hidden = true;
  $('#sortPanel').hidden = true;
  renderCount();
}
function openSetPanel() {
  $('#setPanel').hidden = false;
  document.body.classList.add('set-open');
  renderSetItems();
  updateStar();
  $('#setBtn').setAttribute('aria-expanded', 'true');
  setTimeout(renderFlow, 320);
}
function closeSetPanel() {
  $('#setPanel').hidden = true;
  document.body.classList.remove('set-open');
  $('#setBtn').setAttribute('aria-expanded', 'false');
  setTimeout(renderFlow, 320);
}
const MODE_LABEL = { flow: 'Flow', grid: 'Raster', glass: 'Glas' };

function setMode(mode) {
  app.mode = MODE_LABEL[mode] ? mode : 'flow';
  const stage = $('#stage');
  const grid = $('#grid');
  const glass = $('#glass');
  stage.style.visibility = app.mode === 'flow' ? '' : 'hidden';
  grid.hidden = app.mode !== 'grid';
  glass.hidden = app.mode !== 'glass';
  document.body.classList.toggle('glass-mode', app.mode === 'glass');
  $$('.viewswitch button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mode === app.mode));
  });
  if (app.mode === 'grid') {
    app.gridDirty = true;
    renderGrid();
  } else if (app.mode === 'glass') {
    app.glassDirty = true;
    renderGlass();
  } else {
    resetFlow();
    renderFlow();
  }
  updateDock();
  saveUI();
}

/* ============================================================ Einrichtung (lokaler Server) */
const API = {
  async status() {
    try {
      const res = await fetch('api/status', { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      data.local = true;
      return data;
    } catch {
      return null;
    }
  },
  async post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
  async progress() {
    try {
      const res = await fetch('api/progress', { cache: 'no-store' });
      return res.ok ? await res.json() : { running: false, idle: true };
    } catch {
      return { running: false, idle: true };
    }
  },
};

const W = { timer: 0 };

function wStep(step) {
  $('#wForm').hidden = step !== 'form';
  $('#wResult').hidden = step !== 'result';
  $('#wProgress').hidden = step !== 'progress';
  $('#wStatic').hidden = step !== 'static';
}

function wError(msg) {
  const el = $('#wError');
  el.hidden = !msg;
  el.textContent = msg || '';
}

function renderWelcome(status) {
  $('#welcome').hidden = false;
  document.body.classList.add('welcome-open');
  wError('');
  stopPolling();
  if (!status || !status.local) {
    $('#wDemo').hidden = true;
    wStep('static');
    return;
  }
  $('#wForm').hidden = false;
  if (status.configured) {
    $('#wWho').textContent = status.user || 'Discogs-Account';
    $('#wReleases').textContent = status.count ? ` · ${status.count} Alben lokal` : '';
    $('#wSync').textContent = status.count ? 'Sammlung aktualisieren' : 'Sammlung laden';
    wStep('result');
  } else {
    wStep('form');
    setTimeout(() => $('#wUser').focus(), 60);
  }
  if (status.job && status.job.running) {
    wStep('progress');
    renderProgress(status.job);
    startPolling();
  }
}

function stopPolling() {
  if (W.timer) clearInterval(W.timer);
  W.timer = 0;
}

async function tick() {
  const p = await API.progress();
  renderProgress(p);
  if (p.idle) {
    stopPolling();
    return;
  }
  if (!p.running) {
    stopPolling();
    onJobDone(p);
  }
}

function startPolling() {
  stopPolling();
  W.timer = setInterval(tick, 1200);
  tick();
}

function renderProgress(p) {
  const stage = p.stage || (p.name === 'previews' ? 'Vorschauen werden geladen …' : 'Sammlung wird geladen …');
  $('#wStage').textContent = stage;
  $('#wCount').textContent = p.total ? `${p.done} / ${p.total}` : (p.seconds ? `${p.seconds} s` : '');
  if (p.total) {
    $('#wBar').classList.remove('indet');
    $('#wFill').style.width = `${p.percent}%`;
  } else {
    $('#wBar').classList.add('indet');
  }
  const tail = (p.tail || []).slice(-4).join('\n');
  if (tail) $('#wLog').textContent = tail;
}

function onJobDone(p) {
  const ok = p.exit === 0;
  $('#wBar').classList.remove('indet');
  if (ok) {
    $('#wStage').textContent = 'Fertig';
    $('#wFill').style.width = '100%';
    $('#wNote').textContent = p.name === 'demo'
      ? 'Demo-Daten liegen bereit – du kannst die Bibliothek ansehen.'
      : 'Die Sammlung liegt jetzt lokal in web/collection.json.';
    $('#wFinish').hidden = false;
    $('#wCancel').textContent = 'Schließen';
  } else {
    $('#wStage').textContent = 'Abgebrochen';
    wError(`Der Lauf endete mit Code ${p.exit}. Details im Protokoll oben – häufig fehlt der Token oder die Verbindung.`);
    $('#wCancel').textContent = 'Zurück';
  }
}

async function startJob(path, body, stageText) {
  wError('');
  $('#wStage').textContent = stageText;
  $('#wFill').style.width = '0%';
  $('#wBar').classList.add('indet');
  $('#wLog').textContent = '';
  $('#wFinish').hidden = true;
  $('#wCancel').textContent = 'Abbrechen';
  $('#wNote').textContent = 'Der Fortschritt läuft hier live mit. Das Fenster kann offen bleiben.';
  wStep('progress');
  try {
    const res = await API.post(path, body);
    if (res.job) renderProgress(res.job);
    startPolling();
  } catch (err) {
    wError(err.message);
    wStep('form');
  }
}

function bindWelcome() {
  $('#wForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    wError('');
    const username = $('#wUser').value.trim().replace(/^@/, '');
    const token = $('#wToken').value.trim();
    if (!username || !token) return wError('Bitte Benutzername und Token ausfüllen.');
    const btn = $('#wSubmit');
    btn.disabled = true;
    btn.textContent = 'Prüfe …';
    try {
      const res = await API.post('api/connect', { username, token });
      $('#wToken').value = '';
      $('#wWho').textContent = res.user || username;
      $('#wReleases').textContent = res.releases
        ? ` · ${res.releases} Releases in der Sammlung`
        : ' · Sammlung ist leer';
      $('#wSync').textContent = res.releases ? 'Sammlung laden' : 'Sammlung prüfen';
      wStep('result');
    } catch (err) {
      wError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Account verbinden';
    }
  });

  $('#wSync').addEventListener('click', () => startJob('api/sync', {}, 'Sammlung wird geladen …'));
  $('#wDemo').addEventListener('click', () => startJob('api/demo', {}, 'Demo-Daten werden erzeugt …'));
  $('#wChange').addEventListener('click', () => {
    wStep('form');
    $('#wUser').value = '';
    $('#wUser').focus();
  });
  $('#wFinish').addEventListener('click', () => location.reload());
  $('#wCancel').addEventListener('click', async () => {
    if (!$('#wFinish').hidden) return location.reload();
    try {
      await API.post('api/cancel', {});
    } catch {
      /* egal – Hauptsache zurück */
    }
    stopPolling();
    const status = await API.status();
    renderWelcome(status || { local: false });
  });
  $('#demoConnect').addEventListener('click', async () => {
    renderWelcome(await API.status());
  });
}

/* ============================================================ Start */
async function init() {
  restoreUI();
  $('#search').value = app.query;
  bindWelcome();
  const status = await API.status();
  if (status && status.count === 0) {
    document.title = 'LP · Bibliothek – einrichten';
    return renderWelcome(status);
  }
  try {
    await loadCollection();
  } catch (err) {
    return renderWelcome(status);
  }
  loadLocal();
  loadSets();
  buildFacets();
  applyFilter();
  if (app.restoreCurrent) {
    const pos = app.view.findIndex((a) => a.key === String(app.restoreCurrent));
    app.index = pos >= 0 ? pos : 0;
  }
  app.index = Math.max(0, Math.min(app.view.length - 1, app.index));
  bindEvents();
  bindSetDnD();
  setMode(app.mode);
  renderAll();
  if (app.mode === 'grid') renderGrid();
  updateStar();
  if (location.hash) applyHash();
  if (app.meta && app.meta.count) {
    document.title = `LP · Bibliothek – ${app.meta.count} Alben`;
  }
  loadPreviews();  // Clips nachladen, sobald die Seite steht
}

init();
