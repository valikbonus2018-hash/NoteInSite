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
      const data = parsed && parsed.data ? parsed.data : parsed;
      const add = {};
      const restored = [];
      const cur = await chrome.storage.local.get(null);
      for (const k in data) {
        if (!/^nis:(page|site):/.test(k)) continue;
        const incoming = Array.isArray(data[k]) ? data[k] : [];
        const existing = Array.isArray(cur[k]) ? cur[k] : [];
        const ids = new Set(existing.map(n => n.id));
        const fresh = incoming.filter(n => n && n.id && !ids.has(n.id));
        restored.push(...fresh.map(n => n.id));
        add[k] = existing.concat(fresh);
      }
      if (data[SETTINGS_KEY] && !cur[SETTINGS_KEY]) add[SETTINGS_KEY] = data[SETTINGS_KEY];
      await chrome.storage.local.set(add);
      await unbury(restored);       // иначе надгробие спрячет только что восстановленное
      $('warn').hidden = false;
      $('warn').textContent = 'Импорт завершён. Обновите страницу, чтобы увидеть заметки.';
      await updateTotals();
      renderList(await notesFromStorage());
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
