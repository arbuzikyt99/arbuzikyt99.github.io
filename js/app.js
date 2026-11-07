/* ================= ArbMusic app ================= */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* ---------- state ---------- */
const state = {
  tracks: [],            // всё вместе: каталог + устройство + локальная база
  cloudTracks: [],       // общий каталог с сервера
  deviceTracks: [],      // найденные на устройстве (Android)
  localTracks: [],       // сохранённые в базу на устройстве
  queue: [],             // current queue (track objects)
  baseQueue: [],         // unshuffled queue
  qi: -1,                // current index in queue
  shuffle: false,
  repeat: 'off',         // off | all | one
  favs: new Set(JSON.parse(localStorage.getItem('arbmusic.favs') || '[]')),
  lrcMap: {},            // web: basename -> lyrics text
  view: 'home',
  listKind: 'all',       // 'mix' | 'favs'
  artCache: new Map(),   // id -> dataURL
  seeking: false,
};

const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const Native = isNative ? window.Capacitor.Plugins.MusicScanner : null;

const audio = new Audio();
audio.preload = 'metadata';

/* Chrome sometimes reports Infinity for WAV streams — fall back to seekable range */
function realDuration() {
  if (isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  try {
    if (audio.seekable && audio.seekable.length) return audio.seekable.end(audio.seekable.length - 1);
  } catch (_) { /* ignore */ }
  return 0;
}

/* ---------- utils ---------- */
const fmt = s => {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const m = Math.floor(s / 60), sec = s % 60;
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
};
const hash = str => { let h = 0; for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; } return Math.abs(h); };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, few, many) => { const m10 = n % 10, m100 = n % 100; if (m10 === 1 && m100 !== 11) return one; if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 > 20)) return few; return many; };

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.remove('show'), 2400);
}

/* deterministic pretty gradient per track */
function gradFor(track) {
  const h0 = hash(track.id) % 360;
  // зелёные оттенки (70–175) сдвигаем в фиолетово-розовый диапазон
  const h = (h0 >= 65 && h0 <= 180) ? 195 + (h0 - 65) % 140 : h0;
  const h2 = (h + 45) % 360;
  return `linear-gradient(135deg, hsl(${h} 65% 42%), hsl(${h2} 70% 30%))`;
}

const NOTE_SVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M9 18.5V6.8l9-2.3v11" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.6" cy="18.5" r="2.4" fill="#fff"/><circle cx="15.6" cy="15.5" r="2.4" fill="#fff"/></svg>';

/* обложка облачного трека (файл covers/ в репозитории) */
function coverUrl(t) {
  return t && t.cover ? MUSIC_BASE + encodeURIComponent(t.cover) : null;
}

/* удалять трек может админ или его автор */
function canDeleteTrack(t) {
  const s = session();
  if (!s || !t || !t.id || !t.id.startsWith('cloud_')) return false;
  return !!(s.admin || (t.by && t.by.toLowerCase() === s.name.toLowerCase()));
}
/* удалять трек может админ или его автор */
function canDeleteTrack(t) {
  const s = session();
  if (!s || !t || !t.id || !t.id.startsWith('cloud_')) return false;
  return !!(s.admin || (t.by && t.by.toLowerCase() === s.name.toLowerCase()));
}

/* премиум: владелец и админ — всегда, остальные — по подписке 80₽/мес */
function isPremium() {
  const s = session();
  return !!(s && (s.admin || s.premium));
}
function refreshSessionStatus() {
  if (!session()) return;
  api('/api/me', { noAuth: false }).then(d => {
    if (!d.authorized) { setSession(null); refreshProfile(); return; }
    const s = session();
    if (s && (s.premium !== d.premium || s.admin !== d.admin)) {
      s.premium = d.premium; s.admin = d.admin; s.owner = d.owner;
      setSession(s); refreshProfile();
    }
  }).catch(() => {});
}
window.__onBackground = () => { if (!isPremium()) { audio.pause(); toast('Фоновое прослушивание — только с Премиум'); } };

function thumbHTML(track, cls) {
  const cov = coverUrl(track);
  const img = cov ? `<img src="${esc(cov)}" alt="" loading="lazy">` : '';
  return `<div class="thumb ${cls || ''}" style="background:${gradFor(track)}">${img}${NOTE_SVG}</div>`;
}

function trackUrl(t) {
  if (t.url) return t.url;
  if (isNative && t.path) {
    let u = window.Capacitor.convertFileSrc(t.path);
    u = encodeURI(u).replace(/%253A/g, '%3A');
    t.url = u;
  }
  return t.url;
}

/* ---------- favorites ---------- */
function saveFavs() {
  localStorage.setItem('arbmusic.favs', JSON.stringify([...state.favs]));
}

/* корзина админа и автора: мини-плеер + полный плеер (только треки общей базы) */
function updateDeleteButtons() {
  const s = session();
  const t = current();
  const can = canDeleteTrack(t);
  for (const el of [$('#mini-del'), $('#p-del')]) {
    if (!el) continue;
    el.hidden = !can;
    if (can) { el.dataset.del = t.id; el.dataset.title = t.title; }
  }
}

function deleteTrackFlow(id, title) {
  if (!confirm('Удалить «' + title + '» из общей базы? Он станет недоступен всем пользователям.')) return;
  api('/api/delete-track', { body: { id } }).then(() => {
    const wasCurrent = current() && current().id === id;
    if (wasCurrent) {
      audio.pause();
      audio.removeAttribute('src');
      $('#mini').classList.remove('up');
      closePlayer();
    }
    state.favs.delete(id); saveFavs();
    loadCatalog();
    updateDeleteButtons();
    toast('Трек удалён из базы');
  }).catch(err => toast('Ошибка: ' + err.message));
}

function toggleFav(id) {
  if (!session()) {
    toast('Войди, чтобы сохранять треки');
    $('#auth-err').classList.add('hidden');
    openModal('modal-auth');
    return;
  }
  if (state.favs.has(id)) state.favs.delete(id); else state.favs.add(id);
  saveFavs();
  refreshFavUI();
}
function refreshFavUI() {
  const cur = current();
  const pf = $('#btn-fav');
  pf.classList.toggle('fav', !!(cur && state.favs.has(cur.id)));
  $$(`.rheart[data-id]`).forEach(b => b.classList.toggle('fav', state.favs.has(b.dataset.id)));
}

/* ---------- scan ---------- */
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|wma)$/i;

function parseName(name) {
  let base = name.replace(/\.[^.]+$/, '');
  const m = base.match(/^\s*(?:\d+[\s.\-_]+)?(.+?)\s*-\s*(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: 'Неизвестный исполнитель', title: base.trim() };
}

function sortByDefault(arr) {
  arr.sort((a, b) => (a.artist || '').localeCompare(b.artist || '', 'ru') || (a.title || '').localeCompare(b.title || '', 'ru'));
}

/* библиотека = общий каталог сервера. Никаких локальных хранений. */
function mergeLibrary() {
  const seen = new Set();
  const out = [];
  const push = t => { if (t && !seen.has(t.id)) { out.push(t); seen.add(t.id); } };
  (state.cloudTracks || []).forEach(push);
  state.tracks = out;
  sortByDefault(state.tracks);
  refreshUI();
}

function refreshUI() {
  const n = state.tracks.length;
  $('#all-count').textContent = n ? `${n} ${plural(n, 'трек', 'трека', 'треков')}` : '';
  $('#home-sub').textContent = n ? `${n} ${plural(n, 'трек', 'трека', 'треков')}` : 'общая база';
  renderHome();
  if (state.view === 'list') renderListView();
  refreshFavUI();
}

/* лениво узнаём длительность по URL (для отображения в списке) */
const probeQueue = [];
let probing = 0;
function probeDuration(track) {
  if (!track.url || track.dur) return;
  probeQueue.push(track);
  pumpProbe();
}
function pumpProbe() {
  while (probing < 4 && probeQueue.length) {
    const t = probeQueue.shift();
    probing++;
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      if (isFinite(a.duration)) t.dur = a.duration;
      a.src = '';
      probing--;
      pumpProbe();
      $$(`.rdur[data-id="${CSS.escape(t.id)}"]`).forEach(el => el.textContent = fmt(t.dur));
    };
    a.onerror = () => { probing--; pumpProbe(); };
    a.src = t.url;
  }
}

/* ---------- общий каталог (все треки сервера — видны всем) ---------- */
const CATALOG_URL = 'https://raw.githubusercontent.com/arbuzikyt99/ArbMusicPlayer/main/catalog.json';
const MUSIC_BASE = 'https://raw.githubusercontent.com/arbuzikyt99/ArbMusicPlayer/main/music/';

async function loadCatalog() {
  let data = null;
  // 1) наш сервер (без лимитов), 2) GitHub API, 3) raw, 4) офлайн-копия
  try {
    const r = await fetch(API_URL + '/api/catalog', { cache: 'no-cache' });
    if (r.ok) data = await r.json();
  } catch (_) { /* ignore */ }
  if (!data) {
    try {
      const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/catalog.json`, { headers: { Accept: 'application/vnd.github+json' } });
      if (r.ok) data = b64ToJSON((await r.json()).content);
    } catch (_) { /* ignore */ }
  }
  if (!data) {
    try {
      const r = await fetch(CATALOG_URL, { cache: 'no-cache' });
      if (r.ok) data = await r.json();
    } catch (_) { /* offline */ }
  }
  if (data) {
    try { localStorage.setItem('arbmusic.catalog', JSON.stringify(data)); } catch (_) { /* ignore */ }
  } else {
    try { data = JSON.parse(localStorage.getItem('arbmusic.catalog') || 'null'); } catch (_) { /* ignore */ }
  }
  if (!data || !Array.isArray(data.tracks)) return;
  state.cloudTracks = data.tracks.map(t => ({
    id: 'cloud_' + t.file, name: t.file, title: t.title, artist: t.artist || 'Неизвестный исполнитель', album: '',
    dur: 0, ext: (t.file.match(/\.(\w+)$/i) || [, ''])[1].toLowerCase(),
    cloud: true, lrcFile: t.lrc || null, cover: t.cover || null, by: t.by || null,
    url: MUSIC_BASE + encodeURIComponent(t.file),
  }));
  mergeLibrary();
}

/* ---------- rendering ---------- */
function rowHTML(t, i) {
  const fav = state.favs.has(t.id);
  const del = canDeleteTrack(t)
    ? `<button class="rdel" data-del="${esc(t.id)}" data-title="${esc(t.title)}" aria-label="Удалить из базы">
      <svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2M6.5 7l1 12.2A1.5 1.5 0 0 0 9 20.6h6a1.5 1.5 0 0 0 1.5-1.4l1-12.2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>`
    : '';
  return `<div class="row" data-i="${i}">
    ${thumbHTML(t)}
    <div class="rmeta">
      <div class="rtitle">${esc(t.title)}</div>
      <div class="rartist">${esc(t.artist)}</div>
    </div>
    <span class="rdur" data-id="${esc(t.id)}">${t.dur ? fmt(t.dur) : ''}</span>
    ${del}
    <button class="rheart ${fav ? 'fav' : ''}" data-id="${esc(t.id)}" aria-label="В избранное">
      <svg viewBox="0 0 24 24" fill="none"><path d="M12 20.7C7 16.5 3.5 13.3 3.5 9.7 3.5 7 5.6 5 8.2 5c1.5 0 3 .7 3.8 2 .8-1.3 2.3-2 3.8-2 2.6 0 4.7 2 4.7 4.7 0 3.6-3.5 6.8-8.5 11z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
    </button>
  </div>`;
}

function renderRows(container, list, emptyEl) {
  container.innerHTML = list.map((t, i) => rowHTML(t, i)).join('');
  if (emptyEl) emptyEl.classList.toggle('show', list.length === 0);
  markPlaying();
  if (container === $('#tracklist')) list.forEach(probeDuration);
}

function renderHome() {
  renderRows($('#tracklist'), state.tracks, $('#empty-home'));
  $('#empty-home-text').textContent = 'Треки появятся, когда админ опубликует их в общей базе';
}

function renderListView() {
  const isFav = state.listKind === 'favs';
  $('#list-title').textContent = isFav ? 'Моя музыка' : 'Микс';
  if (isFav && !session()) {
    renderRows($('#list-tracks'), [], null);
    $('#empty-list').classList.add('show');
    $('#empty-list h3').textContent = 'Войди в аккаунт';
    $('#empty-list p').textContent = 'Жми сердечко у трека — сохранённое появится здесь';
    return;
  }
  $('#empty-list h3').textContent = 'Здесь пока пусто';
  $('#empty-list p').textContent = 'Сохрани треки — жми сердечко у трека или в плеере';
  const list = isFav ? state.tracks.filter(t => state.favs.has(t.id)) : state.tracks;
  renderRows($('#list-tracks'), list, $('#empty-list'));
}

function renderSearch(q) {
  q = (q || '').trim().toLowerCase();
  const list = q ? state.tracks.filter(t =>
    t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || (t.album || '').toLowerCase().includes(q)
  ) : state.tracks;
  state.searchList = list;
  renderRows($('#search-results'), list, $('#empty-search'));
  $('#empty-search').style.display = q || state.tracks.length ? '' : 'none';
}

function markPlaying() {
  const cur = current();
  $$('.row').forEach(r => {
    const inQueue = r.closest('#tracklist') ? state.tracks
      : r.closest('#list-tracks') ? getListForView()
      : r.closest('#search-results') ? (state.searchList || state.tracks)
      : state.tracks;
    const t = inQueue[+r.dataset.i];
    r.classList.toggle('playing', !!(cur && t && t.id === cur.id));
  });
}

function getListForView() {
  return state.listKind === 'favs' ? state.tracks.filter(t => state.favs.has(t.id)) : state.tracks;
}

/* ---------- views ---------- */
function moveHotbarPill() {
  const btn = document.querySelector('.hb-btn.active');
  const pill = document.getElementById('hb-pill');
  if (!btn || !pill) return;
  pill.style.left = btn.offsetLeft + 'px';
  pill.style.width = btn.offsetWidth + 'px';
}
window.addEventListener('resize', moveHotbarPill);

function showView(name) {
  state.view = name;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  const navMap = { home: 'home', search: 'search', list: 'favs', profile: 'profile' };
  const navKey = navMap[name] || 'home';
  $$('.hb-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === navKey));
  moveHotbarPill();
  if (name === 'list') renderListView();
  if (name === 'search') renderSearch($('#search-input').value);
  if (name === 'profile') refreshProfile();
  if (name === 'studio') loadStudio();
}

/* ================= API / аккаунты / модерация ================= */
const API_URL = 'https://arbmusic-7371.zai-ai.site';
const GH_REPO = 'arbuzikyt99/ArbMusicPlayer';

function session() {
  try { return JSON.parse(localStorage.getItem('arbmusic.session') || 'null'); } catch (_) { return null; }
}
function setSession(s) {
  if (s) localStorage.setItem('arbmusic.session', JSON.stringify(s));
  else localStorage.removeItem('arbmusic.session');
}
async function api(path, opts = {}) {
  const s = session();
  const init = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: {} };
  if (s && !opts.noAuth) init.headers.Authorization = 'Bearer ' + s.token;
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body != null) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const r = await fetch(API_URL + path, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    // мёртвая сессия — разлогиниваем и просим войти заново
    if (r.status === 401 && session() && path !== '/api/login') {
      setSession(null);
      refreshProfile();
      openModal('modal-auth');
      throw new Error('Сессия истекла — войди заново');
    }
    throw new Error(d.error || 'Ошибка ' + r.status);
  }
  return d;
}

/* ---------- профиль ---------- */
function refreshProfile() {
  const s = session();
  $('#profile-out').classList.toggle('hidden', !!s);
  updateDeleteButtons();
  $('#profile-in').classList.toggle('hidden', !s);
  if (s) {
    $('#profile-name').textContent = s.name;
    $('#profile-avatar').textContent = (s.name[0] || 'A').toUpperCase();
    $('#profile-admin-badge').classList.toggle('hidden', !s.admin);
    $('#btn-admin').classList.toggle('hidden', !s.admin);
    // зелёная точка, если обновление скачано и ждёт установки
    const vbtn = $('#btn-version');
    if (vbtn && !vbtn.querySelector('.upd-dot')) {
      const dot = document.createElement('i');
      dot.className = 'upd-dot';
      vbtn.appendChild(dot);
      dot.style.display = window.__updateReady ? 'block' : 'none';
    }
    // версия: веб — просто номер, apk/exe — кнопка обновлений
    const p = platformType();
    const vb = $('#btn-version'), vs = $('#ver-static'), vn = $('#ver-num');
    if (p === 'web') { vb.classList.add('hidden'); vs.classList.remove('hidden'); vn.textContent = APP_VER; }
    else { vb.classList.remove('hidden'); vs.classList.add('hidden'); }
    const pb = $('#profile-premium-badge');
    if (pb) {
      if (s.owner || s.admin) { pb.textContent = s.owner ? 'Владелец · ∞ Премиум' : 'Админ · Премиум'; pb.classList.remove('hidden'); }
      else if (s.premium) { pb.textContent = 'Премиум'; pb.classList.remove('hidden'); }
      else pb.classList.add('hidden');
    }
    const bb = $('#btn-buy-premium');
    if (bb) bb.classList.toggle('hidden', !!(s.premium || s.admin));
  }
  // «Моя музыка» зависит от входа
  if (state.view === 'list' && state.listKind === 'favs') renderListView();
}

/* ---------- модалки ---------- */
function openModal(id) { $('#' + id).classList.add('show'); }
function closeModal(id) { $('#' + id).classList.remove('show'); }

/* ---------- авторизация ---------- */
let authTab = 'login';
function wireAuth() {
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    authTab = t.dataset.tab;
    $$('.tab').forEach(x => x.classList.toggle('active', x === t));
    $('#auth-submit').textContent = authTab === 'login' ? 'Войти' : 'Создать аккаунт';
  }));
  $('#btn-open-auth').addEventListener('click', () => {
    $('#auth-err').classList.add('hidden');
    openModal('modal-auth');
  });
  $('#auth-submit').addEventListener('click', async () => {
    const err = $('#auth-err');
    err.classList.add('hidden');
    try {
      const d = await api('/api/' + (authTab === 'login' ? 'login' : 'register'), {
        body: { username: $('#auth-name').value.trim(), password: $('#auth-pass').value },
      });
      setSession({ token: d.token, name: d.name, admin: d.admin });
      closeModal('modal-auth');
      refreshProfile();
      toast(authTab === 'login' ? `С возвращением, ${d.name}!` : `Аккаунт создан, ${d.name}!`);
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
  });
  $('#btn-buy-premium').addEventListener('click', () => {
    const s2 = session();
    if (!s2) { openModal('modal-auth'); return; }
    const nm = $('#prem-myname'); if (nm) nm.textContent = s2.name;
    openModal('modal-premium');
  });
  $('#prem-ok').addEventListener('click', () => {
    closeModal('modal-premium');
    refreshSessionStatus();
    setTimeout(refreshSessionStatus, 8000);
    toast('Обновляю статус…');
  });
  $('#prem-pay').addEventListener('click', async () => {
    const err = $('#prem-err');
    err.classList.add('hidden');
    const btn = $('#prem-pay');
    btn.disabled = true; btn.textContent = 'Создаю счёт…';
    try {
      const d = await api('/api/premium/pay', { body: { email: $('#prem-email').value.trim() } });
      // открываем страницу оплаты Lava
      const w = window.open(d.url, '_blank');
      if (!w) location.href = d.url;
      toast('Страница оплаты открыта — после оплаты премиум включится сам');
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
    btn.disabled = false; btn.textContent = 'Оплатить 80 ₽';
  });
  $('#btn-logout').addEventListener('click', () => {
    setSession(null);
    refreshProfile();
    toast('Вышел из аккаунта');
  });
  $$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); }));
  $$('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));
}

/* ---------- загрузка трека на модерацию ---------- */
let upAudio = null, upLrc = null, upCover = null;
function wireUpload() {
  $('#btn-studio-upload').addEventListener('click', () => {
    if (!session()) { openModal('modal-auth'); return; }
    upAudio = upLrc = upCover = null;
    $('#upload-audio-name').textContent = 'Выбрать аудиофайл';
    $('#upload-lrc-name').textContent = 'Текст песни .lrc (необязательно)';
    $('#upload-cover-name').textContent = 'Обложка трека (необязательно)';
    $('#upload-audio-btn').classList.remove('filled');
    $('#upload-lrc-btn').classList.remove('filled');
    $('#upload-cover-btn').classList.remove('filled');
    $('#upload-cover-preview').innerHTML =
      '<svg viewBox="0 0 24 24" fill="none"><rect x="3.5" y="3.5" width="17" height="17" rx="4" stroke="currentColor" stroke-width="1.7"/><circle cx="9" cy="9" r="1.6" fill="currentColor"/><path d="M4.5 17l4.5-4.5 3 3 3.5-3.5 4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    $('#upload-title').value = '';
    $('#upload-artist').value = '';
    $('#upload-err').classList.add('hidden');
    openModal('modal-upload');
  });
  $('#upload-audio-btn').addEventListener('click', () => $('#upload-audio').click());
  $('#upload-lrc-btn').addEventListener('click', () => $('#upload-lrc').click());
  $('#upload-audio').addEventListener('change', e => {
    upAudio = e.target.files[0] || null;
    if (upAudio) {
      $('#upload-audio-name').textContent = upAudio.name + ' · ' + (upAudio.size / 1048576).toFixed(1) + ' МБ';
      $('#upload-audio-btn').classList.add('filled');
      const pn = parseName(upAudio.name);
      if (!$('#upload-title').value) $('#upload-title').value = pn.title;
      if (!$('#upload-artist').value && pn.artist !== 'Неизвестный исполнитель') $('#upload-artist').value = pn.artist;
    }
  });
  $('#upload-lrc').addEventListener('change', e => {
    upLrc = e.target.files[0] || null;
    $('#upload-lrc-name').textContent = upLrc ? upLrc.name : 'Текст песни .lrc (необязательно)';
    $('#upload-lrc-btn').classList.toggle('filled', !!upLrc);
  });
  $('#upload-cover-btn').addEventListener('click', () => $('#upload-cover').click());
  $('#upload-cover').addEventListener('change', e => {
    upCover = e.target.files[0] || null;
    $('#upload-cover-name').textContent = upCover ? upCover.name : 'Обложка трека (необязательно)';
    $('#upload-cover-btn').classList.toggle('filled', !!upCover);
    const pv = $('#upload-cover-preview');
    if (upCover) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(upCover);
      pv.innerHTML = '';
      pv.appendChild(img);
    } else {
      pv.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none"><rect x="3.5" y="3.5" width="17" height="17" rx="4" stroke="currentColor" stroke-width="1.7"/><circle cx="9" cy="9" r="1.6" fill="currentColor"/><path d="M4.5 17l4.5-4.5 3 3 3.5-3.5 4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
  });
  $('#upload-submit').addEventListener('click', async () => {
    const err = $('#upload-err');
    err.classList.add('hidden');
    if (!upAudio) { err.textContent = 'Выбери аудиофайл'; err.classList.remove('hidden'); return; }
    if (!session()) { err.textContent = 'Сессия истекла — войди заново'; err.classList.remove('hidden'); return; }
    const btn = $('#upload-submit');
    btn.disabled = true; btn.textContent = 'Загружаю…';
    try {
    const fd = new FormData();
    fd.append('file', upAudio, upAudio.name);
    if (upLrc) fd.append('lrc', upLrc, upLrc.name);
    if (upCover) fd.append('cover', upCover, upCover.name);
      fd.append('title', $('#upload-title').value.trim() || parseName(upAudio.name).title);
      fd.append('artist', $('#upload-artist').value.trim() || session().name);
      await api('/api/upload', { body: fd });
      closeModal('modal-upload');
      toast('Трек отправлен на модерацию ✅');
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
    btn.disabled = false; btn.textContent = 'Отправить на модерацию';
  });
}

/* ---------- админ-панель (публикация делает сервер) ---------- */
function b64ToJSON(b64) {
  return JSON.parse(decodeURIComponent(escape(atob(b64.replace(/\n/g, '')))));
}

function adminItemHTML(t) {
  const mb = (t.size / 1048576).toFixed(1);
  const cov = t.coverExt ? `<img src="${esc(API_URL + '/audio/' + t.id + '/cover')}" alt="">` : '';
  return `<div class="admin-item" data-id="${esc(t.id)}">
    <div class="thumb" style="background:${gradFor({ id: t.id })}">${cov}${NOTE_SVG}</div>
    <div class="ameta"><b>${esc(t.title)}</b><span>${esc(t.artist)} · от ${esc(t.by)} · ${mb} МБ</span></div>
    <button class="abtn play" title="Послушать"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.4v13.2c0 .8.9 1.3 1.6.9l10-6.6a1.06 1.06 0 0 0 0-1.8l-10-6.6c-.7-.5-1.6 0-1.6.9z"/></svg></button>
    <button class="abtn ok" title="Одобрить"><svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    <button class="abtn no" title="Отклонить"><svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button>
  </div>`;
}

async function loadAdminQueue() {
  const box = $('#admin-queue');
  box.innerHTML = '<div class="admin-spin">Загружаю очередь…</div>';
  $('#admin-empty').classList.add('hidden');
  try {
    const d = await api('/api/queue');
    box.innerHTML = d.items.map(adminItemHTML).join('');
    $('#admin-empty').classList.toggle('hidden', d.items.length > 0);
  } catch (e) {
    box.innerHTML = `<div class="admin-spin">${esc(e.message)}</div>`;
  }
}

/* ---------- версия и обновления ---------- */
/* ---------- ArbStudio ---------- */
function wireStudio() {
  $('#btn-studio').addEventListener('click', async () => {
    if (!session()) { openModal('modal-auth'); return; }
    showView('studio');
    loadStudio();
  });
  $('#btn-studio-upload2') && $('#btn-studio-upload2').addEventListener('click', () => openModal('modal-upload'));
  $('#btn-studio-upload').addEventListener('click', () => openModal('modal-upload'));
  $('#studio-refresh').addEventListener('click', () => loadStudio());
}
async function loadStudio() {
  if (!session()) { showView('profile'); return; }
  const refresh = $('#studio-refresh');
  refresh.classList.add('spin');
  try {
    const d = await api('/api/studio');
    $('#st-plays').textContent = d.totals.plays;
    $('#st-pub').textContent = d.totals.published;
    $('#st-pend').textContent = d.totals.pending;
    const box = $('#studio-tracks');
    const rows = [];
    for (const t of d.published) {
      rows.push(`<div class="studio-track">
        <div class="thumb" style="background:${gradFor({ id: 'cloud_' + t.file })}">${NOTE_SVG}</div>
        <div class="smeta"><b>${esc(t.title)}</b><span>${esc(t.artist)} · в общей базе</span></div>
        <div class="splays"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.4v13.2c0 .8.9 1.3 1.6.9l10-6.6a1.06 1.06 0 0 0 0-1.8l-10-6.6c-.7-.5-1.6 0-1.6.9z"/></svg>${t.plays}</div>
      </div>`);
    }
    for (const t of d.pending) {
      rows.push(`<div class="studio-track">
        <div class="thumb" style="background:${gradFor({ id: t.id })}">${NOTE_SVG}</div>
        <div class="smeta"><b>${esc(t.title)}</b><span>${esc(t.artist)} · на модерации</span></div>
        <span class="badge pending">Проверка</span>
      </div>`);
    }
    box.innerHTML = rows.join('');
    $('#empty-studio').classList.toggle('hidden', rows.length > 0);
  } catch (e) {
    const box = $('#studio-tracks');
    box.innerHTML = '<div class="admin-spin">' + esc(e.message) + '</div>';
  } finally {
    refresh.classList.remove('spin');
  }
}

function wireVersion() {
  $('#btn-version').addEventListener('click', async () => {
    openModal('modal-version');
    renderVersionInfo(null);
    const res = $('#ver-result');
    res.classList.remove('hidden');
    res.style.color = '';
    $('#ver-install').classList.add('hidden');
    $('#ver-download').classList.add('hidden');
    $('#ver-download').textContent = 'Скачать обновление';
    hideVerProgress();
    try {
      if (window.arbShell) {
        // оболочка EXE: проверка через встроенный апдейтер
        res.textContent = 'Проверяю…';
        arbShell.checkForUpdates();
      } else if (platformType() === 'apk') {
        const b = await fetchBuild(true);
        renderVersionInfo(b);
        res.textContent = 'Обновления приложения — через RuStore';
        res.style.color = '#6ee7b7';
      } else {
        const b = await fetchBuild(true);
        renderVersionInfo(b);
        const msg = [];
        if (b.ui > APP_VER) msg.push('Доступно обновление интерфейса (v' + b.ui + ') — жми «Обновить интерфейс»');
        if (compareVersions(b.shellVersionName, SHELL_VERSION_NAME) > 0 && b.exeUrl) {
          msg.push('Доступна новая версия приложения (' + b.versionName + ') — скачай и установи');
          showDownload(b);
        }
        res.textContent = msg.length ? msg.join('. ') : 'У тебя последняя версия ✓';
        res.style.color = '#6ee7b7';
      }
    } catch (e) {
      res.style.color = '#fca5a5';
      res.textContent = 'Не удалось проверить: ' + e.message;
    }
  });
  $('#ver-download').addEventListener('click', () => {
    if (window.arbShell) { arbShell.downloadUpdate(); return; }
    const b = window.__latestBuild;
    if (b && b.exeUrl) window.open(b.exeUrl, '_blank');
  });
  $('#ver-install').addEventListener('click', () => {
    if (window.arbShell) arbShell.installUpdate();
  });
  if (window.arbShell) {
    arbShell.onUpdaterEvent(d => {
      const res = $('#ver-result');
      if (!res) return;
      res.classList.remove('hidden');
      if (d.event === 'update-available') {
        res.style.color = '#fde68a';
        res.textContent = 'Доступна версия оболочки ' + d.version + ' — скачиваю…';
        arbShell.downloadUpdate();
      } else if (d.event === 'download-progress') {
        res.style.color = '#fde68a';
        res.textContent = 'Скачиваю обновление: ' + d.percent + '%';
      } else if (d.event === 'update-downloaded') {
        res.style.color = '#6ee7b7';
        res.textContent = 'Обновление ' + d.version + ' скачано — жми «Перезапустить и установить»';
        $('#ver-install').classList.remove('hidden');
        $('#ver-download').classList.add('hidden');
      }
        window.__updateReady = true;
        const vb = $('#btn-version .upd-dot');
        if (vb) vb.style.display = 'block'; else if (d.event === 'update-not-available') {
        res.style.color = '#6ee7b7';
        res.textContent = 'У тебя последняя версия ✓';
      } else if (d.event === 'update-not-available') {
        res.style.color = '#6ee7b7';
        res.textContent = 'У тебя последняя версия ✓';
        hideVerProgress();
      } else if (d.event === 'download-progress') {
        res.style.color = '#fde68a';
        res.textContent = 'Скачиваю: ' + d.percent + '% · ' + d.transferredMB.toFixed(1) + ' из ' + d.totalMB.toFixed(1) + ' МБ · ' + d.speedMBps.toFixed(1) + ' МБ/с · осталось ' + (d.totalMB - d.transferredMB).toFixed(1) + ' МБ';
        showVerProgress(d.percent);
      } else if (d.event === 'update-downloaded') {
        res.style.color = '#6ee7b7';
        res.textContent = 'Обновление ' + d.version + ' скачано — жми «Перезапустить и установить»';
        hideVerProgress();
        $('#ver-install').classList.remove('hidden');
        $('#ver-download').classList.add('hidden');
      } else if (d.event === 'error') {
        res.style.color = '#fca5a5';
        hideVerProgress();
        res.textContent = 'Обновление: ' + d.message;
      }
    });
  }
}
function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}
function showVerProgress(p) {
  const bar = $('#ver-progress');
  if (!bar) return;
  bar.classList.remove('hidden');
  const fill = $('#ver-progress-fill');
  if (fill) fill.style.width = p + '%';
}
function hideVerProgress() {
  const bar = $('#ver-progress');
  if (bar) bar.classList.add('hidden');
}
async function fetchBuild(bust) {
  const r = await fetch('./version.json' + (bust ? '?cb=' + Date.now() : ''), { cache: 'no-cache' });
  const b = await r.json();
  window.__latestBuild = b;
  return b;
}
function renderVersionInfo(b) {
  const el = $('#ver-info');
  if (!el) return;
  const p = platformType();
  const platName = { apk: 'Android (APK)', exe: 'Windows (EXE)', web: 'Веб-версия' }[p];
  const shellName = window.arbShell ? ('v' + SHELL_VERSION_NAME) : '—';
  el.innerHTML =
    '<div class="ver-row">Интерфейс: <b>v' + APP_VER + '</b></div>' +
    '<div class="ver-row">Приложение: <b>' + shellName + '</b> · ' + platName + '</div>' +
    (b ? '<div class="ver-row">На сервере: <b>интерфейс v' + b.ui + ' · оболочка ' + b.shellVersionName + '</b></div>' +
         '<div class="ver-row">' + esc(b.versionName) + '</div>' : '');
  const dl = $('#ver-download');
  if (!window.arbShell && p === 'web' && b && b.exeUrl) dl.classList.remove('hidden');
  else dl.classList.add('hidden');
}
function showDownload(b) {
  const dl = $('#ver-download');
  if (dl) dl.classList.remove('hidden');
}

function wireAdmin() {
  $('#mini-del').addEventListener('click', e => {
    e.stopPropagation();
    const el = e.currentTarget;
    if (el.dataset.del) deleteTrackFlow(el.dataset.del, el.dataset.title);
  });
  $('#p-del').addEventListener('click', e => {
    e.stopPropagation();
    const el = e.currentTarget;
    if (el.dataset.del) deleteTrackFlow(el.dataset.del, el.dataset.title);
  });
  $('#btn-admin').addEventListener('click', () => {
    openModal('modal-admin');
    loadAdminQueue();
    loadAdminUsers();
  });
  $('#admin-refresh').addEventListener('click', loadAdminQueue);

  // пользователи и премиум
  async function loadAdminUsers() {
    const box = $('#admin-users');
    if (!box) return;
    try {
      const d = await api('/api/users');
      box.innerHTML = d.users.map(u => {
        const prem = u.premium === 'owner' ? '<span class="badge premium">Владелец · ∞</span>'
          : u.premium ? '<span class="badge premium">до ' + new Date(u.premium).toLocaleDateString('ru') + '</span>'
          : '';
        const btn = u.premium === 'owner' ? ''
          : u.premium ? '<button class="ubtn off" data-unprem="' + esc(u.name) + '">Снять</button>'
          : '<button class="ubtn" data-prem="' + esc(u.name) + '">+1 мес</button>';
        return '<div class="user-item"><div class="uinfo"><b>' + esc(u.name) + '</b><span>' + new Date(u.created).toLocaleDateString('ru') + '</span></div>' + prem + btn + '</div>';
      }).join('');
    } catch (e) {
      box.innerHTML = '<div class="admin-spin">' + esc(e.message) + '</div>';
    }
  }
  window.__loadAdminUsers = loadAdminUsers;
  $('#admin-users').addEventListener('click', async e => {
    const p = e.target.closest('[data-prem]');
    const un = e.target.closest('[data-unprem]');
    if (p) { await api('/api/setpremium', { body: { user: p.dataset.prem, months: 1 } }); loadAdminUsers(); toast('Премиум выдан: ' + p.dataset.prem); }
    if (un) { await api('/api/setpremium', { body: { user: un.dataset.unprem, months: 0 } }); loadAdminUsers(); toast('Премиум снят'); }
  });
  $('#admin-queue').addEventListener('click', async e => {
    const el = e.target.closest('.admin-item');
    if (!el) return;
    const id = el.dataset.id;
    const items = (await api('/api/queue').catch(() => ({ items: [] }))).items;
    const item = items.find(i => i.id === id);
    if (!item) return;

    if (e.target.closest('.play')) {
      const t = { id: 'mod_' + id, url: API_URL + '/audio/' + id, title: item.title, artist: item.artist + ' · модерация', album: '', dur: 0, ext: item.ext };
      playList([t], 0);
      openPlayer();
      return;
    }
    if (e.target.closest('.no')) {
      if (!confirm('Отклонить трек «' + item.title + '»?')) return;
      await api('/api/moderate', { body: { id, action: 'reject' } });
      loadAdminQueue();
      toast('Трек отклонён');
      return;
    }
    if (e.target.closest('.ok')) {
      const btn = e.target.closest('.ok');
      btn.disabled = true;
      try {
        await api('/api/publish', { body: { id } });
        toast('Опубликован в общей базе ✅');
        loadAdminQueue();
        loadCatalog();
      } catch (err) {
        toast('Ошибка: ' + err.message);
        btn.disabled = false;
      }
    }
  });
}

/* ---------- queue & playback ---------- */
function current() { return state.queue[state.qi] || null; }

function shuffleArr(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function playList(list, startIdx, opts = {}) {
  state.baseQueue = [...list];
  if (opts.shuffle || state.shuffle) {
    state.queue = shuffleArr([...list]);
    state.qi = 0; // случайно выбранный трек — первый в перемешанной очереди
    state.shuffle = true;
  } else {
    state.queue = [...list];
    state.qi = startIdx >= 0 ? startIdx : 0;
  }
  updateShuffleUI();
  playCurrent();
}

function playCurrent() {
  const t = current();
  if (!t) return;
  audio.src = trackUrl(t);
  audio.play().catch(err => { console.error(err); toast('Не удалось воспроизвести файл'); });
  onTrackChanged(t);
}

function next(auto = false) {
  if (!state.queue.length) return;
  if (state.qi < state.queue.length - 1) { state.qi++; }
  else if (state.repeat === 'all' || !auto) { state.qi = 0; }
  else { // end of queue, repeat off
    audio.pause(); audio.currentTime = 0;
    updatePlayUI();
    return;
  }
  playCurrent();
}

function prev() {
  if (audio.currentTime > 3 || state.queue.length < 2) { audio.currentTime = 0; return; }
  state.qi = state.qi > 0 ? state.qi - 1 : state.queue.length - 1;
  playCurrent();
}

function togglePlay() {
  if (!current()) {
    if (state.tracks.length) playList(state.tracks, 0);
    return;
  }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

function onTrackChanged(t) {
  // mini
  const mini = $('#mini');
  mini.classList.remove('hidden');
  mini.classList.remove('closed');
  mini.classList.add('up');
  $('#mini-title').textContent = t.title;
  $('#mini-artist').textContent = t.artist;
  $('#mini-art').outerHTML = thumbHTML(t, 'mini-art').replace('class="thumb', 'id="mini-art" class="thumb');
  // full player
  $('#p-title').textContent = t.title;
  $('#p-artist').textContent = t.artist;
  const pa = $('#p-art');
  pa.style.background = gradFor(t);
  pa.innerHTML = NOTE_SVG;
  const img = pa.querySelector('img'); if (img) img.remove();
  $('#p-art-glow').style.background = gradFor(t);
  loadArt(t);
  loadLyrics(t);
  updatePlayUI();
  markPlaying();
  refreshFavUI();
  updateDeleteButtons();
  updateMediaSession(t);
  trackPlay(t);
  // lazy duration probe for web
  if (!isNative) probeDuration(t);
}

/* учёт прослушивания: раз за сессию на трек */
const playsSent = new Set();
function trackPlay(t) {
  if (!t || !t.cloud || !t.file || playsSent.has(t.id)) return;
  playsSent.add(t.id);
  api('/api/play', { body: { file: t.file } }).catch(() => {});
}

function updatePlayUI() {
  const playing = !audio.paused && !audio.ended && !!audio.src;
  $('#btn-play').classList.toggle('playing', playing);
  $('#btn-play').innerHTML = playing
    ? '<svg class="ic-pause" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4.2" height="15" rx="1.6"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.6"/></svg>'
    : '<svg class="ic-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.4v13.2c0 .8.9 1.3 1.6.9l10-6.6a1.06 1.06 0 0 0 0-1.8l-10-6.6c-.7-.5-1.6 0-1.6.9z"/></svg>';
  const mp = $('#mini-play');
  mp.innerHTML = playing
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4.2" height="15" rx="1.6"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.6"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.4v13.2c0 .8.9 1.3 1.6.9l10-6.6a1.06 1.06 0 0 0 0-1.8l-10-6.6c-.7-.5-1.6 0-1.6.9z"/></svg>';
}

function updateShuffleUI() {
  $('#btn-shuffle').classList.toggle('on', state.shuffle);
}

function updateRepeatUI() {
  const b = $('#btn-repeat');
  b.classList.toggle('on', state.repeat !== 'off');
  b.querySelector('.rep-one').classList.toggle('hidden', state.repeat !== 'one');
}

/* ---------- art ---------- */
async function loadArt(t) {
  const cov = coverUrl(t);
  if (cov) {
    // обложка из каталога — просто подставляем картинку
    const img = new Image();
    img.onload = () => applyArt(t, cov);
    img.src = cov;
    return;
  }
  if (!isNative) return;
  if (state.artCache.has(t.id)) return applyArt(t, state.artCache.get(t.id));
  try {
    const r = await Native.getArt({ path: t.path });
    if (r && r.data) { state.artCache.set(t.id, r.data); applyArt(t, r.data); }
  } catch (_) { /* no art */ }
}
function applyArt(t, src) {
  const cur = current();
  if (!cur || cur.id !== t.id) return;
  const img = document.createElement('img');
  img.src = src;
  img.onload = () => {
    const pa = $('#p-art');
    if (current() && current().id === t.id) {
      pa.querySelector('img')?.remove();
      pa.appendChild(img);
      $('#p-art-glow').style.opacity = '.75';
    }
    // mini art too
    const ma = $('#mini-art');
    if (ma && current().id === t.id) {
      ma.querySelector('img')?.remove();
      const mi = document.createElement('img'); mi.src = src; ma.appendChild(mi);
    }
  };
}

/* ---------- lyrics ---------- */
let lyricLines = [];       // {t, el} or plain
let lyricSync = false;
let lastLyricIdx = -1;
let userScrollUntil = 0;

function parseLrc(text) {
  const out = [];
  const re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  let hasTags = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    re.lastIndex = 0;
    let m, times = [], lastIndex = 0;
    while ((m = re.exec(raw))) { hasTags = true; times.push(+m[1] * 60 + +m[2] + (m[3] ? +(('0.' + m[3])) : 0)); lastIndex = re.lastIndex; }
    const txt = raw.slice(lastIndex).trim();
    if (times.length && txt) times.forEach(t => out.push({ t, txt }));
  }
  out.sort((a, b) => a.t - b.t);
  return { lines: out, synced: hasTags && out.length > 0 };
}

async function loadLyrics(t) {
  lyricLines = []; lyricSync = false; lastLyricIdx = -1;
  let text = null;
  try {
    if (isNative && t.path) {
      const r = await Native.getLyrics({ path: t.path });
      if (r && r.lyrics) text = r.lyrics;
    } else if (t.name) {
      const base = t.name.replace(/\.[^.]+$/, '').toLowerCase();
      const v = state.lrcMap[base];
      if (typeof v === 'string') text = v;
    }
    if (!text && t.cloud && t.lrcFile) {
      // текст трека из общего каталога — с офлайн-копией
      const key = 'arbmusic.lrc.' + t.id;
      try {
        const saved = localStorage.getItem(key);
        if (saved) text = saved;
        else {
          const r = await fetch(MUSIC_BASE + encodeURIComponent(t.lrcFile));
          if (r.ok) {
            text = await r.text();
            try { localStorage.setItem(key, text); } catch (_) { /* ignore */ }
          }
        }
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }

  const box = $('#lyrics-scroll');
  if (!text || !text.trim()) {
    box.innerHTML = '<div class="lrc-empty">Текст недоступен для этого трека<br><br>Положи файл <b>.lrc</b> рядом с треком</div>';
    return;
  }
  const { lines, synced } = parseLrc(text);
  if (!lines.length) {
    box.innerHTML = '<div class="lrc-empty">Текст недоступен для этого трека</div>';
    return;
  }
  lyricSync = synced;
  lyricLines = lines;
  box.innerHTML = lines.map((l, i) =>
    `<div class="lrc-line" data-i="${i}">${esc(l.txt)}</div>`).join('');
  [...box.children].forEach((el, i) => { lyricLines[i].el = el; });
  lastLyricIdx = -1;
}

function syncLyrics(t) {
  if (!lyricSync || state.seeking) return;
  const cur = current(); if (!cur) return;
  const time = audio.currentTime;
  // find last line with t <= time
  let lo = 0, hi = lyricLines.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (lyricLines[mid].t <= time) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  if (idx === lastLyricIdx) return;
  if (lastLyricIdx >= 0 && lyricLines[lastLyricIdx]) lyricLines[lastLyricIdx].el.classList.remove('active');
  lastLyricIdx = idx;
  if (idx >= 0) {
    const el = lyricLines[idx].el;
    el.classList.add('active');
    if (Date.now() > userScrollUntil) {
      const box = $('#lyrics-scroll');
      const top = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
      box.scrollTo({ top, behavior: 'smooth' });
    }
  }
}

/* ---------- seekbar ---------- */
const seekbar = $('#seekbar');
function seekFromEvent(e) {
  const r = seekbar.getBoundingClientRect();
  const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
  return Math.min(1, Math.max(0, x / r.width));
}
function startSeek(e) {
  if (!audio.src) return;
  state.seeking = true;
  seekbar.classList.add('drag');
  moveSeek(e);
  window.addEventListener('pointermove', moveSeek);
  window.addEventListener('pointerup', endSeek);
  window.addEventListener('pointercancel', endSeek);
}
function moveSeek(e) {
  const p = seekFromEvent(e);
  $('#seek-fill').style.width = (p * 100) + '%';
  $('#seek-thumb').style.left = (p * 100) + '%';
  $('#t-cur').textContent = fmt(p * realDuration());
}
function endSeek(e) {
  const p = seekFromEvent(e.changedTouches ? { clientX: e.changedTouches[0].clientX } : e);
  const d = realDuration();
  if (d > 0) audio.currentTime = p * d;
  state.seeking = false;
  seekbar.classList.remove('drag');
  window.removeEventListener('pointermove', moveSeek);
  window.removeEventListener('pointerup', endSeek);
  window.removeEventListener('pointercancel', endSeek);
}
seekbar.addEventListener('pointerdown', startSeek);

/* ---------- audio events ---------- */
audio.addEventListener('timeupdate', () => {
  const d = realDuration();
  const p = d ? audio.currentTime / d : 0;
  if (!state.seeking) {
    $('#seek-fill').style.width = (p * 100) + '%';
    $('#seek-thumb').style.left = (p * 100) + '%';
    $('#t-cur').textContent = fmt(audio.currentTime);
  }
  $('#t-dur').textContent = fmt(d);
  $('#mini-fill').style.width = (p * 100) + '%';
  syncLyrics();
});
audio.addEventListener('loadedmetadata', () => {
  if (!isFinite(audio.duration)) {
    // Chrome отдаёт Infinity для WAV-потоков — заставляем досчитать длительность
    audio.currentTime = 1e7;
    const reset = () => {
      audio.removeEventListener('durationchange', reset);
      // сбрасываем позицию только если пользователь не перемотал во время пересчёта
      if (audio.currentTime > 1e6) audio.currentTime = 0;
      $('#t-dur').textContent = fmt(realDuration());
    };
    audio.addEventListener('durationchange', reset);
    return;
  }
  const t = current();
  if (t && !t.dur && isFinite(audio.duration)) {
    t.dur = audio.duration;
    $$(`.rdur[data-id="${CSS.escape(t.id)}"]`).forEach(el => el.textContent = fmt(t.dur));
  }
  $('#t-dur').textContent = fmt(audio.duration);
});
audio.addEventListener('play', updatePlayUI);
audio.addEventListener('pause', updatePlayUI);
audio.addEventListener('ended', () => {
  if (state.repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  next(true);
});
audio.addEventListener('error', () => {
  if (audio.src) toast('Ошибка воспроизведения файла');
});

/* ---------- media session ---------- */
function updateMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  try {
    const art = state.artCache.get(t.id) || coverUrl(t);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album || 'ArbMusic',
      artwork: art ? [{ src: art, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
    navigator.mediaSession.setActionHandler('play', () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', prev);
    navigator.mediaSession.setActionHandler('nexttrack', () => next());
    navigator.mediaSession.setActionHandler('seekto', d => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
  } catch (_) { /* ignore */ }
}

/* ---------- player sheet ---------- */
function openPlayer() {
  if (!current()) { toast('Сначала выбери трек'); return; }
  $('#player').classList.add('open');
  showLyrics(false);
}
function closePlayer() { $('#player').classList.remove('open'); }

let lyricsOpen = false;
function showLyrics(on) {
  lyricsOpen = on;
  $('#p-art-wrap').classList.toggle('hidden', on);
  $('#p-lyrics').classList.toggle('hidden', !on);
  $('#btn-lyrics').classList.toggle('active', on);
  if (on) {
    const cur = current();
    if (cur) loadLyrics(cur);
  }
}

/* ---------- events wiring ---------- */
function wire() {
  // home
  $('#btn-rescan').addEventListener('click', () => {
    const btn = $('#btn-rescan');
    btn.classList.add('spin');
    loadCatalog().finally(() => btn.classList.remove('spin'));
  });
  $('#card-mix').addEventListener('click', () => {
    if (!state.tracks.length) { toast('Сначала найди музыку'); return; }
    state.shuffle = true;
    playList(state.tracks, -1, { shuffle: true });
    openPlayer();
  });
  $('#btn-search').addEventListener('click', () => {
    showView('search');
    setTimeout(() => $('#search-input').focus(), 250);
  });
  // hotbar
  $$('.hb-btn').forEach(b => b.addEventListener('click', () => {
    const n = b.dataset.nav;
    if (n === 'home') showView('home');
    else if (n === 'search') { showView('search'); setTimeout(() => $('#search-input').focus(), 250); }
    else if (n === 'favs') { state.listKind = 'favs'; showView('list'); }
    else if (n === 'profile') showView('profile');
  }));
  wireAuth();
  wireUpload();
  wireAdmin();
  wireVersion();
  wireStudio();

  // list view
  $('#btn-list-shuffle').addEventListener('click', () => {
    const list = getListForView();
    if (!list.length) { toast('Пусто'); return; }
    state.shuffle = true;
    playList(list, -1, { shuffle: true });
    openPlayer();
  });
  $$('[data-back]').forEach(b => b.addEventListener('click', () => showView('home')));

  // search
  $('#search-input').addEventListener('input', e => renderSearch(e.target.value));

  // row clicks (delegation)
  const rowHandler = (container, getList) => {
    container.addEventListener('click', e => {
      const del = e.target.closest('.rdel');
      if (del) {
        e.stopPropagation();
        if (!session() || !session().admin) return;
        deleteTrackFlow(del.dataset.del, del.dataset.title);
        return;
      }
      const heart = e.target.closest('.rheart');
      const row = e.target.closest('.row');
      if (!row) return;
      const list = getList();
      const t = list[+row.dataset.i];
      if (!t) return;
      if (heart) { toggleFav(heart.dataset.id); return; }
      const cur = current();
      if (cur && cur.id === t.id) { openPlayer(); return; }
      const idx = state.queue.findIndex(q => q.id === t.id);
      if (idx >= 0 && state.queue.length && sameQueue(getList())) {
        state.qi = idx; playCurrent(); openPlayer(); return;
      }
      playList(list, +row.dataset.i);
      openPlayer();
    });
  };
  const sameQueue = list => state.baseQueue.length === list.length && state.baseQueue[0] === list[0];
  rowHandler($('#tracklist'), () => state.tracks);
  rowHandler($('#list-tracks'), getListForView);
  rowHandler($('#search-results'), () => state.searchList || state.tracks);

  // mini
  $('#mini').addEventListener('click', e => {
    if (e.target.closest('.iconbtn') || e.target.closest('.rdel')) return;
    openPlayer();
  });
  $('#mini-close').addEventListener('click', e => {
    e.stopPropagation();
    audio.pause();
    updatePlayUI();
    $('#mini').classList.remove('up');
    $('#mini').classList.add('closed'); // закрыть полностью
  });
  $('#mini-play').addEventListener('click', togglePlay);
  $('#mini-next').addEventListener('click', () => next());

  // full player
  $('#btn-collapse').addEventListener('click', closePlayer);
  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-next').addEventListener('click', () => next());
  $('#btn-prev').addEventListener('click', prev);
  $('#btn-fav').addEventListener('click', () => { const c = current(); if (c) toggleFav(c.id); });
  $('#btn-shuffle').addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    if (state.queue.length) {
      const cur = current();
      if (state.shuffle) {
        const rest = state.baseQueue.filter(t => t.id !== cur.id);
        state.queue = [cur, ...shuffleArr([...rest])];
        state.qi = 0;
      } else {
        state.queue = [...state.baseQueue];
        state.qi = Math.max(0, state.queue.findIndex(t => t.id === cur.id));
      }
    }
    updateShuffleUI();
    toast(state.shuffle ? 'Перемешивание включено' : 'Перемешивание выключено');
  });
  $('#btn-repeat').addEventListener('click', () => {
    state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
    updateRepeatUI();
    toast(state.repeat === 'off' ? 'Повтор выключен' : state.repeat === 'all' ? 'Повтор очереди' : 'Повтор трека');
  });
  $('#btn-lyrics').addEventListener('click', () => showLyrics(!lyricsOpen));

  // lyrics interactions
  $('#lyrics-scroll').addEventListener('click', e => {
    const line = e.target.closest('.lrc-line');
    if (line && lyricSync && isFinite(audio.duration)) {
      const l = lyricLines[+line.dataset.i];
      if (l) audio.currentTime = l.t;
    }
  });
  const userScroll = () => { userScrollUntil = Date.now() + 3200; };
  $('#lyrics-scroll').addEventListener('pointerdown', userScroll);
  $('#lyrics-scroll').addEventListener('wheel', userScroll, { passive: true });

  // space = play/pause (desktop)
  window.addEventListener('keydown', e => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); togglePlay(); }
  });
}

/* ---------- авто-обновление веб-версии ---------- */
const APP_VER = 22;
/* версия оболочки: EXE сообщает свою, APK возьмёт из устройства, веб — 0 */
let SHELL_VERSION_NAME = '0';
/* номер оболочки (нативного приложения): ?shell=N в адресе, 0 — чистый веб */
const SHELL_VER = parseInt(new URLSearchParams(location.search).get('shell')) || 0;
function platformType() {
  if (window.Capacitor && window.Capacitor.getPlatform) {
    const p = window.Capacitor.getPlatform();
    if (p === 'android') return 'apk';
  }
  if (navigator.userAgent.includes('Electron')) return 'exe';
  return 'web';
}
async function checkVersion() {
  if (isNative || !/^https?:$/.test(location.protocol)) return;
  try {
    const r = await fetch('./version.json?cb=' + Date.now(), { cache: 'no-cache' });
    if (!r.ok) return;
    const j = await r.json();
    if (typeof j.ui !== 'number') return;
    if (j.ui !== APP_VER && sessionStorage.getItem('arbmv') !== String(j.ui)) {
      sessionStorage.setItem('arbmv', String(j.ui));
      for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
      for (const k of await caches.keys()) await caches.delete(k);
      location.reload();
    }
  } catch (_) { /* ignore */ }
}

/* ---------- init ---------- */
async function init() {
  if (!isNative) document.body.classList.add('web');
  wire();
  updateShuffleUI();
  updateRepeatUI();
  updatePlayUI();
  refreshFavUI();
  refreshProfile();
  renderHome();
  moveHotbarPill();
  // общий каталог — единственный источник треков, на всех платформах
  loadCatalog();
  checkVersion();
  // версия APK из устройства (для раздела «Версия»)
  if (isNative && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Device) {
    window.Capacitor.Plugins.Device.getInfo().then(i => {
      if (i.appVersion) { SHELL_VERSION_NAME = i.appVersion; }
    }).catch(() => {});
  }
  // фоновое прослушивание — только с премиумом
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !isPremium()) window.__onBackground();
  });
  if (isNative && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.addListener('appStateChange', st => {
      if (!st.isActive && !isPremium()) window.__onBackground();
    });
  }
  // service worker — только для оффлайн-запаса приложения (не в Electron file://)
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}


/* скрываем платформенный водяной знак, если он появляется */
new MutationObserver(() => {
  document.querySelectorAll('#zcode-site-badge').forEach(el => el.remove());
}).observe(document.documentElement, { childList: true, subtree: true });

document.addEventListener('DOMContentLoaded', init);
window.__arb = { get audio() { return audio; }, get state() { return state; } };
