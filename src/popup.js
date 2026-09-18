/* NoteInSite — окно расширения: переключатели видимости, список заметок, настройки, экспорт/импорт */
'use strict';

const SETTINGS_KEY = 'nis:settings';
const DEFAULTS = {
  enabled: true,
  disabledSites: [],
  defaultScope: 'page',
  defaultStyle: { bg: '#fff59d', color: '#20242e', fontFamily: 'system-ui', fontSize: 15 },
  popupSize: { width: 980, height: 720 }
};

const FONTS = [
  ['system-ui', 'Системный'],
  ['Arial, sans-serif', 'Arial'],
  ['Georgia, serif', 'Georgia'],
  ['"Times New Roman", serif', 'Times'],
  ['"Courier New", monospace', 'Courier'],
  ['Verdana, sans-serif', 'Verdana'],
  ['Tahoma, sans-serif', 'Tahoma'],
  ['"Trebuchet MS", sans-serif', 'Trebuchet'],
  ['"Comic Sans MS", cursive', 'Comic Sans']
];
const SIZES = [11, 12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 40];

const $ = id => document.getElementById(id);
let tab = null;
let settings = JSON.parse(JSON.stringify(DEFAULTS));
let contentAlive = false;

const normPath = p => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

function keysFor(url) {
  const u = new URL(url);
  return { page: `nis:page:${u.origin}${normPath(u.pathname)}`, site: `nis:site:${u.origin}`, host: u.hostname };
}

/* Имя файла выгрузки: хост и путь страницы, чтобы в папке загрузок было видно,
   откуда файл. Латиница и цифры остаются, остальное — дефисы. */
function fileSlug(url) {
  const u = new URL(url);
  const path = normPath(u.pathname).replace(/^\/+/, '');
  const raw = u.hostname + (path ? '-' + path : '');
  return raw.replace(/[^\w.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function saveJson(data, name, extra) {
  const payload = Object.assign(
    { format: 'NoteInSite', version: 1, exportedAt: new Date().toISOString() },
    extra || {},
    { data }
  );
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const today = () => new Date().toISOString().slice(0, 10);

function ask(msg) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tab.id, msg, resp => {
      if (chrome.runtime.lastError) resolve(null); else resolve(resp);
    });
  });
}

/* ---------- инициализация ---------- */
async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settings = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), stored[SETTINGS_KEY] || {});
  settings.defaultStyle = Object.assign({}, DEFAULTS.defaultStyle, settings.defaultStyle || {});
  settings.popupSize = Object.assign({}, DEFAULTS.popupSize, settings.popupSize || {});

  fillSettingsUI();

  const usable = tab && tab.url && /^https?:/i.test(tab.url);
  $('site').textContent = usable ? new URL(tab.url).hostname : (tab ? tab.url.slice(0, 48) : '—');

  if (!usable) {
    $('warn').hidden = false;
    $('warn').textContent = 'На служебных страницах Chrome (chrome://, Интернет-магазин) заметки недоступны.';
    $('add').disabled = true;
    $('export-page').disabled = true;
  }

  const info = usable ? await ask({ type: 'nis:list' }) : null;
  contentAlive = !!info;
  if (usable && !contentAlive) {
    $('warn').hidden = false;
    $('warn').textContent = 'Страница загружена до установки расширения — обновите её (F5), чтобы заметки заработали.';
  }

  const host = usable ? new URL(tab.url).hostname : '';
  $('sw-global').checked = settings.enabled !== false;
  $('sw-site').checked = !(settings.disabledSites || []).includes(host);
  $('sw-site').disabled = !usable;

  renderList(info ? info.notes : await notesFromStorage());
  updateTotals();
  renderTrash();
  wireUI();
}

async function notesFromStorage() {
  if (!tab || !/^https?:/i.test(tab.url || '')) return [];
  const k = keysFor(tab.url);
  const res = await chrome.storage.local.get([k.page, k.site]);
  const strip = html => {
    const d = document.createElement('div');
    d.textContent = String(html || '').replace(/<[^>]*>/g, ' ');
    return d.textContent.replace(/\s+/g, ' ').trim().slice(0, 70);
  };
  return []
    .concat((res[k.page] || []).map(n => ({ id: n.id, scope: 'page', fixed: !!n.fixed, bg: n.bg, text: strip(n.html) || '(пустая заметка)' })))
    .concat((res[k.site] || []).map(n => ({ id: n.id, scope: 'site', fixed: !!n.fixed, bg: n.bg, text: strip(n.html) || '(пустая заметка)' })));
}

/* ---------- список заметок ---------- */
function renderList(list) {
  const ul = $('list');
  ul.textContent = '';
  $('cnt').textContent = String(list.length);
  $('empty').hidden = list.length > 0;

  for (const n of list) {
    const li = document.createElement('li');
    li.title = 'Показать заметку на странице';

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = n.bg || '#fff59d';

    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = n.text;

    li.append(dot, txt);

    if (n.scope === 'site') {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'сайт';
      tag.title = 'Заметка показывается на всех страницах этого сайта';
      li.appendChild(tag);
    }
    if (n.fixed) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '📌';
      tag.title = 'Закреплена на экране';
      li.appendChild(tag);
    }

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Удалить заметку';
    del.addEventListener('click', async e => {
      e.stopPropagation();
      await deleteNote(n);
      li.remove();
      const left = $('list').children.length;
      $('cnt').textContent = String(left);
      $('empty').hidden = left > 0;
      updateTotals();
      renderTrash();                 // удалённая тут же появляется в корзине
    });
    li.appendChild(del);

    li.addEventListener('click', async () => {
      const r = await ask({ type: 'nis:focus', id: n.id });
      if (r && r.ok) window.close();
    });

    ul.appendChild(li);
  }
}

async function deleteNote(n) {
  if (contentAlive) { await ask({ type: 'nis:delete', id: n.id }); return; }
  const k = keysFor(tab.url);
  const key = n.scope === 'site' ? k.site : k.page;
  const res = await chrome.storage.local.get(key);
  const arr = (res[key] || []).filter(x => x.id !== n.id);
  const gone = (res[key] || []).find(x => x.id === n.id);
  if (arr.length) await chrome.storage.local.set({ [key]: arr });
  else await chrome.storage.local.remove(key);
  await bury([n.id]);
  if (gone) await toTrash([{ note: gone, key, scope: n.scope, text: n.text }]);
}

/* Надгробия: id удалённых заметок со временем удаления. Без них вкладка,
   в которой заметка ещё лежит в памяти, при следующем сохранении вернула бы её
   обратно — для неё отсутствие заметки в хранилище неотличимо от «ничего
   не менялось». Тот же список читает и content.js. */
const TOMB_KEY = 'nis:tombstones';

async function bury(ids) {
  if (!ids.length) return;
  const cur = (await chrome.storage.local.get(TOMB_KEY))[TOMB_KEY] || {};
  const now = Date.now();
  for (const id of ids) cur[id] = now;
  await chrome.storage.local.set({ [TOMB_KEY]: cur });
}

/* Обратная операция для импорта: заметку, которую восстанавливают из файла,
   надгробие иначе спрятало бы сразу после загрузки. */
async function unbury(ids) {
  if (!ids.length) return;
  const cur = (await chrome.storage.local.get(TOMB_KEY))[TOMB_KEY] || {};
  let hit = false;
  for (const id of ids) if (id in cur) { delete cur[id]; hit = true; }
  if (hit) await chrome.storage.local.set({ [TOMB_KEY]: cur });
}

/* ---------- проверка импортируемого файла ----------
   До сих пор в хранилище уезжало всё, что подошло под маску ключа: ни формы
   записи, ни типов полей никто не проверял. Правило простое: что можно починить — чиним
   (недостающее берём из умолчаний, числа зажимаем в пределы), что нельзя —
   выбрасываем и считаем, сколько выбросили. */

const MAX_HTML = 64 * 1024;          // на заметку; больше — почти наверняка не заметка
const MAX_KEY = 2048;
const MAX_SEL = 1024;
const HEX = /^#[0-9a-f]{6}$/i;

/* Свойства, которые заметка может задать себе сама (кнопки Ж/К/Ч в панели).
   Без этого списка extra из файла уходил прямо в el.style.setProperty(): чужой
   файл мог бы дотянуться до любого свойства, вплоть до фоновой картинки с чужого
   адреса — то есть отметки о том, что заметку открыли. */
const EXTRA_PROPS = new Set(['font-weight', 'font-style', 'text-decoration-line']);

function num(v, min, max, dflt) {
  const x = typeof v === 'number' ? v : parseFloat(v);
  if (!isFinite(x)) return dflt;
  return Math.min(max, Math.max(min, x));
}

function validKey(k) {
  if (typeof k !== 'string' || k.length > MAX_KEY) return false;
  const m = /^nis:(page|site):(https?:\/\/[^/]+)(\/.*)?$/.exec(k);
  if (!m || (m[1] === 'site' && m[3])) return false;   // ключ сайта — только origin, без пути
  try { new URL(m[2]); } catch (e) { return false; }
  return true;
}

/* Селектор из файла уходит в document.querySelector(). Там он обёрнут в try,
   но проверить дешевле, чем каждый раз ловить исключение на отрисовке. */
function validSel(s) {
  if (typeof s !== 'string' || !s || s.length > MAX_SEL) return false;
  try { document.createDocumentFragment().querySelector(s); return true; }
  catch (e) { return false; }
}

function cleanAnchor(a) {
  if (!a || typeof a !== 'object' || !validSel(a.sel)) return null;
  return { sel: a.sel, ox: num(a.ox, -1e6, 1e6, 0), oy: num(a.oy, -1e6, 1e6, 0) };
}

function cleanFlow(f) {
  if (!f || typeof f !== 'object' || !validSel(f.sel)) return null;
  const side = (f.side === 'left' || f.side === 'right') ? f.side : 'block';
  return { sel: f.sel, side, idx: num(f.idx, 0, 1e5, 0), off: num(f.off, 0, 1e6, 0) };
}

function cleanExtra(e) {
  if (!e || typeof e !== 'object') return null;
  const out = {};
  let any = false;
  for (const p in e) {
    if (!EXTRA_PROPS.has(p)) continue;
    const v = e[p];
    if (typeof v !== 'string' || !v || v.length > 60) continue;
    out[p] = v; any = true;
  }
  return any ? out : null;
}

/* Возвращает вычищенную заметку или null, если чинить нечего:
   без внятного id и текстового html это не заметка. */
function cleanNote(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !/^[\w-]{1,64}$/.test(raw.id)) return null;
  if (raw.html != null && typeof raw.html !== 'string') return null;
  if (String(raw.html || '').length > MAX_HTML) return null;

  const now = Date.now();
  const ds = DEFAULTS.defaultStyle;
  const n = {
    id: raw.id,
    html: NIS_SANITIZE(String(raw.html || '')),
    x: num(raw.x, -1e6, 1e6, 0),
    y: num(raw.y, -1e6, 1e6, 0),
    w: num(raw.w, 80, 2000, 240),
    h: raw.h == null ? null : num(raw.h, 20, 4000, null),
    fixed: !!raw.fixed,
    collapsed: !!raw.collapsed,
    z: num(raw.z, 0, 1e6, 10),
    bg: HEX.test(raw.bg) ? raw.bg : ds.bg,
    color: HEX.test(raw.color) ? raw.color : ds.color,
    fontFamily: FONTS.some(f => f[0] === raw.fontFamily) ? raw.fontFamily : ds.fontFamily,
    fontSize: Math.round(num(raw.fontSize, 8, 72, ds.fontSize)),
    createdAt: num(raw.createdAt, 0, 8.64e15, now),
    updatedAt: num(raw.updatedAt, 0, 8.64e15, now)
  };
  const a = cleanAnchor(raw.anchor); if (a) n.anchor = a;
  const f = cleanFlow(raw.flow);     if (f) n.flow = f;
  const e = cleanExtra(raw.extra);   if (e) n.extra = e;
  return n;
}

function cleanSettings(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ds = DEFAULTS.defaultStyle, s = raw.defaultStyle || {}, p = raw.popupSize || {};
  return {
    enabled: raw.enabled !== false,
    disabledSites: Array.isArray(raw.disabledSites)
      ? raw.disabledSites.filter(h => typeof h === 'string' && h && h.length < 256).slice(0, 5000)
      : [],
    defaultScope: raw.defaultScope === 'site' ? 'site' : 'page',
    defaultStyle: {
      bg: HEX.test(s.bg) ? s.bg : ds.bg,
      color: HEX.test(s.color) ? s.color : ds.color,
      fontFamily: FONTS.some(f => f[0] === s.fontFamily) ? s.fontFamily : ds.fontFamily,
      fontSize: Math.round(num(s.fontSize, 8, 72, ds.fontSize))
    },
    popupSize: {
      width: Math.round(num(p.width, 200, 3000, DEFAULTS.popupSize.width)),
      height: Math.round(num(p.height, 200, 3000, DEFAULTS.popupSize.height))
    }
  };
}

/* ---------- корзина ----------
   Те же записи, что кладёт content.js: сама заметка, ключ, откуда её убрали,
   и время удаления. Живут три дня. */
const TRASH_KEY = 'nis:trash';
const TRASH_TTL = 3 * 24 * 60 * 60 * 1000;
const TRASH_MAX = 100;

async function trashList() {
  const cur = (await chrome.storage.local.get(TRASH_KEY))[TRASH_KEY] || [];
  const edge = Date.now() - TRASH_TTL;
  return cur.filter(r => r && r.at > edge && r.note);
}

async function putTrash(list) {
  const next = list.slice(0, TRASH_MAX);
  if (next.length) await chrome.storage.local.set({ [TRASH_KEY]: next });
  else await chrome.storage.local.remove(TRASH_KEY);
}

async function toTrash(items) {
  if (!items.length) return;
  const now = Date.now();
  const host = tab && /^https?:/i.test(tab.url || '') ? new URL(tab.url).hostname : '';
  const recs = items.map(it => ({
    id: it.note.id, at: now, key: it.key, scope: it.scope || 'page', host,
    text: it.text || '(пустая заметка)', note: it.note
  }));
  const ids = new Set(recs.map(r => r.id));
  await putTrash(recs.concat((await trashList()).filter(r => !ids.has(r.id))));
}

/* Возврат: заметке проставляется свежее время правки — иначе надгробие,
   которое старше её последней правки, спрячет заметку сразу после возврата
   (то же правило действует и при слиянии вкладок). */
async function restoreFromTrash(rec) {
  const res = await chrome.storage.local.get(rec.key);
  const arr = Array.isArray(res[rec.key]) ? res[rec.key] : [];
  if (!arr.some(n => n.id === rec.id)) {
    arr.push(Object.assign({}, rec.note, { updatedAt: Date.now() }));
    await chrome.storage.local.set({ [rec.key]: arr });
  }
  await unbury([rec.id]);
  await putTrash((await trashList()).filter(r => r.id !== rec.id));
  if (contentAlive) await ask({ type: 'nis:reload' });
}

function fmtWhen(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return min + ' мин назад';
  const h = Math.round(min / 60);
  if (h < 24) return h + ' ч назад';
  return Math.round(h / 24) + ' дн назад';
}

async function renderTrash() {
  const list = await trashList();
  $('trash-card').hidden = !list.length;
  $('trash-cnt').textContent = String(list.length);
  const ul = $('trash');
  ul.textContent = '';
  const here = tab && /^https?:/i.test(tab.url || '') ? new URL(tab.url).hostname : '';

  for (const rec of list) {
    const li = document.createElement('li');

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = (rec.note && rec.note.bg) || '#fff59d';

    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = rec.text;
    txt.title = (rec.host && rec.host !== here ? rec.host + ' · ' : '') + fmtWhen(rec.at);

    const when = document.createElement('span');
    when.className = 'tag';
    when.textContent = rec.host && rec.host !== here ? rec.host : fmtWhen(rec.at);

    const back = document.createElement('button');
    back.className = 'del back';
    back.textContent = '⟲';
    back.title = 'Вернуть заметку';
    back.addEventListener('click', async e => {
      e.stopPropagation();
      await restoreFromTrash(rec);
      await renderTrash();
      await updateTotals();
      renderList(await notesFromStorage());
    });

    li.append(dot, txt, when, back);
    ul.appendChild(li);
  }
}

/* ---------- настройки ---------- */
function fillSettingsUI() {
  $('set-font').innerHTML = FONTS
    .map(f => `<option value="${f[0].replace(/"/g, '&quot;')}">${f[1]}</option>`).join('');
  $('set-size').innerHTML = SIZES.map(s => `<option value="${s}">${s} px</option>`).join('');
  $('set-scope').value = settings.defaultScope;
  $('set-font').value = settings.defaultStyle.fontFamily;
  $('set-size').value = String(settings.defaultStyle.fontSize);
  $('set-color').value = settings.defaultStyle.color;
  $('set-bg').value = settings.defaultStyle.bg;
  $('set-pw').value = settings.popupSize.width;
  $('set-ph').value = settings.popupSize.height;
}

async function saveSettings() {
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  } catch (e) {
    $('warn').hidden = false;
    $('warn').textContent = 'Не удалось сохранить настройки: ' + (e && e.message ? e.message : e);
  }
}

/* Размер, при котором стоит напомнить про резервную копию. Жёсткого предела
   больше нет (в манифесте unlimitedStorage), но разросшееся хранилище — повод
   сделать экспорт: место на диске всё-таки конечно. */
const BIG_STORAGE = 8 * 1024 * 1024;

function fmtSize(n) {
  if (n < 1024) return n + ' Б';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' КБ';
  return (n / (1024 * 1024)).toFixed(1).replace('.', ',') + ' МБ';
}

async function updateTotals() {
  const all = await chrome.storage.local.get(null);
  let total = 0, pages = 0, size = 0;
  for (const k in all) {
    if (!/^nis:/.test(k)) continue;
    // так же размер считает и сам Chrome: длина ключа плюс длина JSON значения
    size += k.length + JSON.stringify(all[k]).length;
    if (!/^nis:(page|site):/.test(k)) continue;
    const arr = all[k] || [];
    if (!arr.length) continue;
    pages++;
    total += arr.length;
  }
  $('total').textContent = String(total);
  $('pages').textContent = String(pages);
  $('used').textContent = size ? ' · ' + fmtSize(size) : '';

  // не затираем уже показанное предупреждение — оно важнее напоминания о копии
  if (size > BIG_STORAGE && $('warn').hidden) {
    $('warn').hidden = false;
    $('warn').textContent = 'Заметки занимают ' + fmtSize(size) +
      '. Стоит сделать «Экспорт всех» — резервная копия пригодится.';
  }
}

/* ---------- обработчики ---------- */
function wireUI() {
  $('sw-global').addEventListener('change', async e => {
    settings.enabled = e.target.checked;
    await saveSettings();
    if (contentAlive) await ask({ type: 'nis:reload' });
  });

  $('sw-site').addEventListener('change', async e => {
    const host = new URL(tab.url).hostname;
    const set = new Set(settings.disabledSites || []);
    if (e.target.checked) set.delete(host); else set.add(host);
    settings.disabledSites = Array.from(set);
    await saveSettings();
    if (contentAlive) await ask({ type: 'nis:reload' });
  });

  $('add').addEventListener('click', async () => {
    const r = await ask({ type: 'nis:add' });
    if (!r) {
      $('warn').hidden = false;
      $('warn').textContent = 'Обновите страницу (F5) — расширение ещё не подключилось к ней.';
      return;
    }
    window.close();
  });

  const bind = (id, fn) => $(id).addEventListener('change', async e => { fn(e.target.value); await saveSettings(); });
  bind('set-scope', v => { settings.defaultScope = v; });
  bind('set-font', v => { settings.defaultStyle.fontFamily = v; });
  bind('set-size', v => { settings.defaultStyle.fontSize = parseInt(v, 10); });
  bind('set-color', v => { settings.defaultStyle.color = v; });
  bind('set-bg', v => { settings.defaultStyle.bg = v; });
  bind('set-pw', v => { settings.popupSize.width = Math.min(3000, Math.max(200, parseInt(v, 10) || 980)); });
  bind('set-ph', v => { settings.popupSize.height = Math.min(3000, Math.max(200, parseInt(v, 10) || 720)); });

  $('export').addEventListener('click', async () => {
    const all = await chrome.storage.local.get(null);
    const data = {};
    for (const k in all) if (/^nis:/.test(k)) data[k] = all[k];
    saveJson(data, 'noteinsite-backup-' + today() + '.json');
  });

  /* Выгрузка одной страницы: её ключ плюс ключ сайта — то есть ровно то,
     что на этой странице видно. Настройки в такой файл не кладём. */
  $('export-page').addEventListener('click', async () => {
    if (!tab || !/^https?:/i.test(tab.url || '')) return;
    const k = keysFor(tab.url);
    const got = await chrome.storage.local.get([k.page, k.site]);
    const data = {};
    let count = 0;
    for (const key of [k.page, k.site]) {
      const list = Array.isArray(got[key]) ? got[key] : [];
      if (list.length) { data[key] = list; count += list.length; }
    }
    if (!count) {
      $('warn').hidden = false;
      $('warn').textContent = 'На этой странице заметок нет — выгружать нечего.';
      return;
    }
    saveJson(data, 'noteinsite-' + fileSlug(tab.url) + '-' + today() + '.json', { pageUrl: tab.url });
    $('warn').hidden = false;
    $('warn').textContent = 'Выгружено заметок: ' + count + '.';
  });

  $('import').addEventListener('click', () => $('file').click());

  $('file').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const parsed = JSON.parse(await f.text());
      if (!parsed || typeof parsed !== 'object') throw new Error('в файле не объект');
      const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;

      const add = {};
      const restored = [];
      let added = 0, dup = 0, bad = 0, badKeys = 0;
      const cur = await chrome.storage.local.get(null);

      for (const k in data) {
        if (!/^nis:(page|site):/.test(k)) continue;      // не заметки — молча мимо
        if (!validKey(k) || !Array.isArray(data[k])) { badKeys++; continue; }

        const existing = Array.isArray(cur[k]) ? cur[k] : [];
        const ids = new Set(existing.map(n => n.id));
        const fresh = [];
        for (const raw of data[k]) {
          const n = cleanNote(raw);
          if (!n) { bad++; continue; }
          if (ids.has(n.id)) { dup++; continue; }        // повторная загрузка того же файла
          ids.add(n.id);
          fresh.push(n);
          restored.push(n.id);
        }
        added += fresh.length;
        if (fresh.length) add[k] = existing.concat(fresh);
      }

      if (data[SETTINGS_KEY] && !cur[SETTINGS_KEY]) {
        const s = cleanSettings(data[SETTINGS_KEY]);
        if (s) add[SETTINGS_KEY] = s;
      }

      if (Object.keys(add).length) await chrome.storage.local.set(add);
      await unbury(restored);       // иначе надгробие спрячет только что восстановленное

      $('warn').hidden = false;
      if (!added && !dup && !bad && !badKeys) {
        $('warn').textContent = 'В этом файле нет заметок NoteInSite.';
      } else {
        const parts = ['Добавлено заметок: ' + added];
        if (dup) parts.push('уже были: ' + dup);
        if (bad) parts.push('не похожи на заметки: ' + bad);
        if (badKeys) parts.push('пропущено разделов: ' + badKeys);
        $('warn').textContent = parts.join(', ') + '.' +
          (added ? ' Обновите страницу, чтобы увидеть заметки.' : '');
      }

      await updateTotals();
      renderList(await notesFromStorage());
      await renderTrash();
    } catch (err) {
      $('warn').hidden = false;
      $('warn').textContent = 'Не удалось прочитать файл: ' + err.message;
    }
    e.target.value = '';
  });

  $('wipe-page').addEventListener('click', async () => {
    if (!tab || !/^https?:/i.test(tab.url || '')) return;
    if (!confirm('Удалить все заметки этой страницы (включая заметки всего сайта)?')) return;
    const k = keysFor(tab.url);
    const got = await chrome.storage.local.get([k.page, k.site]);
    const strip = html => String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
    const items = []
      .concat((got[k.page] || []).map(n => ({ note: n, key: k.page, scope: 'page' })))
      .concat((got[k.site] || []).map(n => ({ note: n, key: k.site, scope: 'site' })))
      .map(it => Object.assign(it, { text: strip(it.note.html) || '(пустая заметка)' }));
    await chrome.storage.local.remove([k.page, k.site]);
    await bury(items.map(it => it.note.id).filter(Boolean));
    await toTrash(items);            // самая опасная кнопка в окне — из корзины её можно отыграть
    if (contentAlive) await ask({ type: 'nis:reload' });
    renderList([]);
    updateTotals();
    renderTrash();
  });
}

init();
