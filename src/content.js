/* NoteInSite — content script: отрисовка, перетаскивание, редактирование и хранение заметок */
(() => {
  'use strict';
  if (window.__NIS_ACTIVE__) return;
  window.__NIS_ACTIVE__ = true;

  const SETTINGS_KEY = 'nis:settings';
  const TOMB_KEY = 'nis:tombstones';        // id удалённых заметок, чтобы слияние их не воскрешало
  const TOMB_TTL = 30 * 24 * 60 * 60 * 1000;
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

  /* Набор для кнопки 😊 — то, что обычно и ставят в рабочих заметках:
     пометки, сроки, контакты, короткая эмоция. Восемь в ряд. */
  const EMOJI = [
    '✅', '❗', '❓', '⚠️', '⭐', '🔥', '📌', '📝',
    '💡', '🔗', '📅', '⏰', '💰', '📞', '✉️', '🔒',
    '👍', '👎', '👌', '🙏', '👀', '✍️', '🤝', '💪',
    '😀', '🙂', '😐', '🙁', '😮', '😍', '🤔', '😴',
    '❤️', '🎯', '🚀', '🐞', '📈', '📉', '🧩', '🎁'
  ];

  let settings = JSON.parse(JSON.stringify(DEFAULTS));
  let notes = [];
  const els = new Map();            // id -> HTMLElement
  let host = null, shadow = null, layer = null;
  let off = { x: 0, y: 0 };         // смещение системы координат слоя относительно документа
  let zTop = 10;
  let tombs = {};                   // id удалённой заметки -> когда удалили
  const lastWritten = new Map();    // ключ -> JSON того, что мы записали последними
  let saveTimer = null, inputTimer = null;
  let dirty = false;                // есть несохранённые изменения
  let saveRetry = 0, retryTimer = null, failToast = null;
  let lastPoint = null;             // последняя точка правого клика (координаты документа)
  let curHref = location.href;
  let savedRange = null, savedRangeNote = null;
  let lastDragEnd = 0;          // чтобы двойное касание сразу после перетаскивания не открывало правку

  /* ---------------- ключи хранилища ---------------- */
  const normPath = p => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);
  const pageKey = () => `nis:page:${location.origin}${normPath(location.pathname)}`;
  const siteKey = () => `nis:site:${location.origin}`;
  const myKeys = () => [SETTINGS_KEY, TOMB_KEY, pageKey(), siteKey()];

  /* ---------------- загрузка / сохранение ---------------- */
  const notesFrom = res => []
    .concat((res[pageKey()] || []).map(n => Object.assign({}, n, { scope: 'page' })))
    .concat((res[siteKey()] || []).map(n => Object.assign({}, n, { scope: 'site' })));

  function applySettings(raw) {
    settings = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), raw || {});
    settings.defaultStyle = Object.assign({}, DEFAULTS.defaultStyle, settings.defaultStyle || {});
    settings.popupSize = Object.assign({}, DEFAULTS.popupSize, settings.popupSize || {});
  }

  async function loadAll() {
    let res = {};
    try { res = await chrome.storage.local.get(myKeys()); } catch (e) { return; }
    applySettings(res[SETTINGS_KEY]);
    tombs = pruneTombs(res[TOMB_KEY]);
    notes = notesFrom(res).filter(n => !buried(n));
    zTop = notes.reduce((m, n) => Math.max(m, n.z || 0), 10);
  }

  /* ---------------- слияние состояний ----------------
     Раньше saveAll() перезаписывала оба ключа целиком тем, что лежало в памяти
     вкладки. Две вкладки одной страницы из-за этого затирали правки друг друга:
     та, что сохранила последней, побеждала вместе со своим устаревшим списком.
     Теперь перед записью читаем, что там сейчас, и сливаем. */

  const stamp = n => n.updatedAt || n.createdAt || 0;

  /* Удалённую заметку нельзя просто «не найти» в чужом списке: для той вкладки,
     где она ещё в памяти, это выглядело бы как отсутствие изменений, и слияние
     вернуло бы её обратно. Поэтому удаление оставляет надгробие — id и время. */
  function pruneTombs(raw) {
    const out = {}, edge = Date.now() - TOMB_TTL;
    for (const id in (raw || {})) if (raw[id] > edge) out[id] = raw[id];
    return out;
  }

  const buried = n => tombs[n.id] >= stamp(n);

  /* Заметки, которые сейчас правят или тащат: их версия в памяти всегда главная,
     иначе текст менялся бы под руками, а заметка прыгала из-под курсора. */
  function busyIds() {
    const s = new Set();
    for (const [id, el] of els) if (isEditing(el) || dragging(el)) s.add(id);
    return s;
  }

  /* Побеждает версия с большим updatedAt; при равенстве — своя, иначе две вкладки
     перекидывали бы заметку туда-сюда на каждой записи. */
  function mergeNotes(mine, theirs) {
    const busy = busyIds();
    const by = new Map();
    for (const n of theirs) by.set(n.id, n);
    for (const n of mine) {
      const other = by.get(n.id);
      if (busy.has(n.id) || !other || stamp(n) >= stamp(other)) by.set(n.id, n);
    }
    return Array.from(by.values()).filter(n => busy.has(n.id) || !buried(n));
  }

  /* Свою же запись storage.onChanged присылает обратно. Раньше её отличали
     по флагу, который снимался через 80 мс: чужая запись, попавшая в это окно,
     терялась, а затянувшаяся своя вызывала лишнее перечитывание. Теперь просто
     сравниваем пришедшее значение с тем, что записали сами, — без таймеров. */
  const stored = v => (v === undefined ? 'null' : JSON.stringify(v));
  const markWritten = (k, v) => lastWritten.set(k, stored(v));
  const wroteThis = (k, v) => lastWritten.get(k) === stored(v);

  function scheduleSave() { dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(saveAll, 250); }

  async function saveAll() {
    clearTimeout(saveTimer);

    // читаем то, что лежит сейчас: за время правки соседняя вкладка могла записать своё
    let res = {};
    try { res = await chrome.storage.local.get([pageKey(), siteKey(), TOMB_KEY]); }
    catch (e) { dirty = true; writeFailed(e); return; }

    tombs = pruneTombs(Object.assign({}, res[TOMB_KEY], tombs));
    const merged = mergeNotes(notes, notesFrom(res));
    const grew = merged.length !== notes.length ||
                 merged.some(n => !notes.includes(n));   // в слиянии победила чужая версия
    notes = merged;
    zTop = notes.reduce((m, n) => Math.max(m, n.z || 0), zTop);

    const pack = sc => notes
      .filter(n => (n.scope || 'page') === sc)
      .map(n => { const c = Object.assign({}, n); delete c.scope; return c; });
    const p = pack('page'), s = pack('site');
    const set = {}, del = [];
    if (p.length) set[pageKey()] = p; else del.push(pageKey());
    if (s.length) set[siteKey()] = s; else del.push(siteKey());
    if (Object.keys(tombs).length) set[TOMB_KEY] = tombs; else del.push(TOMB_KEY);

    dirty = false;
    /* Пометку ставим до записи, а не после: onChanged о своей же записи приходит
       раньше, чем разрешается промис set(), и «пометим потом» опаздывает —
       вкладка перечитывает хранилище следом за каждым своим сохранением.
       Если запись не удастся, пометка останется лишней, но и вреда не будет:
       уведомления о неслучившемся изменении не приходит. */
    for (const k in set) markWritten(k, set[k]);
    for (const k of del) markWritten(k, undefined);
    try {
      if (Object.keys(set).length) await chrome.storage.local.set(set);
      if (del.length) await chrome.storage.local.remove(del);
      writeOk();
    } catch (e) {
      dirty = true;                   // записи не было — изменения всё ещё только в памяти
      writeFailed(e);
    }
    if (grew) syncDom();              // подхватили чужие заметки — показываем их
  }

  async function saveSettings() {
    markWritten(SETTINGS_KEY, settings);        // до записи — см. пояснение в saveAll()
    try {
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      writeOk();
    } catch (e) { writeFailed(e, true); }
  }

  /* ---------------- неудачная запись ---------------- */
  /* Раньше здесь стоял пустой catch: заметка не сохранялась, а пользователь узнавал
     об этом, только открыв страницу заново. Теперь о неудаче говорим вслух и пробуем
     ещё раз — разовый сбой переживём молча, постоянный покажем. */
  const RETRY_DELAYS = [1500, 5000, 15000];

  /* Расширение обновили, выключили или переустановили: эта страница с ним больше
     не связана, и записывать в хранилище ей уже нечем — поможет только перезагрузка. */
  function storageGone() {
    try { return !(chrome.runtime && chrome.runtime.id); } catch (e) { return true; }
  }

  function writeErrorText(err) {
    const msg = String((err && err.message) || err || '');
    if (storageGone() || /context invalidated|Extension context/i.test(msg))
      return 'Расширение было обновлено или перезапущено — правки этой страницы больше не сохраняются. ' +
             'Обновите страницу (F5): заметки, сохранённые раньше, на месте.';
    if (/quota|exceeded|QUOTA_BYTES/i.test(msg))
      return 'В хранилище закончилось место — заметка не сохранена. Откройте окно расширения, ' +
             'сделайте «Экспорт всех» и удалите ненужные заметки.';
    return 'Не удалось сохранить заметки: ' + (msg || 'неизвестная ошибка') +
           '. Пробую ещё раз; если сообщение повторится — сделайте экспорт из окна расширения.';
  }

  function writeOk() {
    clearTimeout(retryTimer);
    saveRetry = 0;
    if (failToast) {                  // было сообщение о неудаче — снимаем и успокаиваем
      failToast.remove();
      failToast = null;
      toast('Заметки сохранены');
    }
  }

  function writeFailed(err, noRetry) {
    if (failToast) failToast.remove();
    failToast = toast(writeErrorText(err), 'error');
    if (noRetry || storageGone()) return;        // повторять нечем и незачем
    if (saveRetry >= RETRY_DELAYS.length) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(saveAll, RETRY_DELAYS[saveRetry++]);
  }

  /* Правка уходит в хранилище с задержкой (400 мс на разбор текста плюс 250 мс
     на запись). Если вкладку закрыть в этот промежуток, последние набранные символы
     пропадали — поэтому при скрытии страницы дописываем немедленно. */
  function flushSave() {
    clearTimeout(inputTimer);
    for (const n of notes) {
      const el = els.get(n.id);
      if (el && isEditing(el)) commitBody(n, el);
    }
    if (dirty) saveAll();
  }

  const siteDisabled = () => (settings.disabledSites || []).includes(location.hostname);
  const visible = () => settings.enabled !== false && !siteDisabled();

  /* ---------------- слой Shadow DOM ---------------- */
  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = 'note-in-site-root';
    const fix = {
      position: 'absolute', top: '0', left: '0', width: '0', height: '0',
      margin: '0', padding: '0', border: '0', 'z-index': '2147483600',
      display: 'block', float: 'none', transform: 'none', visibility: 'visible', opacity: '1'
    };
    for (const k in fix) host.style.setProperty(k, fix[k], 'important');
    shadow = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = NIS_CSS;
    shadow.appendChild(st);
    layer = document.createElement('div');
    layer.className = 'nis-layer';
    shadow.appendChild(layer);
    (document.documentElement || document.body).appendChild(host);
    measureOffset();
  }

  function measureOffset() {
    if (!host || !host.isConnected) return;
    const r = host.getBoundingClientRect();
    off = { x: r.left + window.scrollX, y: r.top + window.scrollY };
  }

  const getSel = () => (shadow && shadow.getSelection ? shadow.getSelection() : document.getSelection());

  /* ---------------- привязка к элементам страницы ---------------- */
  /* Путь всегда доводится до <html> (или до уникального id), иначе на глубокой
     вёрстке обрезанный путь совпадает с несколькими элементами, привязка
     отбрасывается и заметка возвращается к абсолютным координатам — а они при
     смене ширины окна уезжают вместе с перевёрсткой текста. */
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.id && /^[A-Za-z][\w:.-]*$/.test(cur.id)) {
        try {
          if (document.querySelectorAll('#' + CSS.escape(cur.id)).length === 1) {
            parts.unshift('#' + CSS.escape(cur.id));
            return parts.join(' > ');
          }
        } catch (e) { /* невалидный id — игнорируем */ }
      }
      const tag = cur.tagName.toLowerCase();
      if (tag === 'html') { parts.unshift('html'); break; }
      let idx = 1, sib = cur;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === cur.tagName) idx++;
      parts.unshift(`${tag}:nth-of-type(${idx})`);
      if (parts.length > 40) return null;
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  /* Текстовые блоки, к которым имеет смысл привязывать заметку. */
  const TEXT_TAGS = 'p,h1,h2,h3,h4,h5,h6,li,td,th,dt,dd,blockquote,pre,figcaption,caption,label,legend';

  function hasOwnText(el) {
    for (const nd of el.childNodes) if (nd.nodeType === 3 && nd.nodeValue.trim()) return true;
    return false;
  }

  /* Поднимаемся только от совсем мелких кусочков (обрывок инлайна, пустой span).
     Порог намеренно низкий: строка заголовка высотой 20 px — уже хороший якорь,
     а подъём до большого контейнера как раз и приводил к «уплыванию» заметок
     при смене ширины окна: текст перевёрстывался, а контейнер оставался на месте. */
  function climbToBlock(el) {
    let guard = 0;
    while (el && el.parentElement && guard++ < 6) {
      const r = el.getBoundingClientRect();
      if (r.width >= 40 && r.height >= 12) break;
      el = el.parentElement;
    }
    return el;
  }

  /* Элемент, к которому привязывается точка. Если попали в текст — берём его,
     если в пустое поле контейнера (заметки часто ставят на поля справа) — ищем
     ближайший текстовый блок, иначе при смене ширины окна заметка «уплывёт»
     вместе с высоким контейнером, хотя текст рядом с ней сдвинется иначе. */
  function anchorTarget(cx, cy) {
    let hit = null, stack = [];
    try { stack = document.elementsFromPoint(cx, cy) || []; } catch (e) {}
    for (const e of stack) {
      if (!e || e === host || e.id === 'note-in-site-root') continue;
      if (e === document.documentElement) continue;
      hit = e; break;
    }
    if (!hit) hit = document.body;
    if (!hit) return null;
    if (hasOwnText(hit)) return climbToBlock(hit);

    let scope = hit, best = null, bestD = Infinity, guard = 0;
    while (scope && scope !== document.documentElement && guard++ < 4) {
      let list = [];
      try { list = scope.querySelectorAll(TEXT_TAGS); } catch (e) {}
      let seen = 0;
      for (const el of list) {
        if (seen++ > 2000) break;
        if (el.id === 'note-in-site-root' || el.closest('#note-in-site-root')) continue;
        if (!el.textContent || !el.textContent.trim()) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 6) continue;
        const dx = Math.max(r.left - cx, 0, cx - r.right);
        const dy = Math.max(r.top - cy, 0, cy - r.bottom);
        const d = Math.hypot(dx, dy * 2);          // совпадение по вертикали важнее
        if (d < bestD) { bestD = d; best = el; }
      }
      if (best && bestD < 260) return best;
      scope = scope.parentElement;
    }
    return (best && bestD < 600) ? best : climbToBlock(hit);
  }

  function computeAnchor(docX, docY) {
    const cx = docX - window.scrollX, cy = docY - window.scrollY;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return null;
    let target = anchorTarget(cx, cy);
    for (let i = 0; i < 3 && target && target !== document.documentElement; i++) {
      const sel = cssPath(target);
      let unique = false;
      try { unique = !!sel && document.querySelectorAll(sel).length === 1; } catch (e) {}
      if (unique) {
        const r = target.getBoundingClientRect();
        return {
          sel,
          ox: Math.round(docX - (r.left + window.scrollX)),
          oy: Math.round(docY - (r.top + window.scrollY))
        };
      }
      target = target.parentElement;
    }
    return null;
  }

  function resolvePos(n) {
    if (n.anchor && n.anchor.sel) {
      try {
        const t = document.querySelector(n.anchor.sel);
        if (t) {
          const r = t.getBoundingClientRect();
          if (r.width || r.height) {
            return { x: r.left + window.scrollX + n.anchor.ox, y: r.top + window.scrollY + n.anchor.oy };
          }
        }
      } catch (e) {}
    }
    return { x: n.x, y: n.y };
  }

  function pageWidth() {
    const de = document.documentElement, b = document.body;
    return Math.max(de.clientWidth || 0, b ? b.scrollWidth || 0 : 0);
  }

  /* ---------------- вставка заметки в поток вёрстки ----------------
     Заметка не просто лежит поверх страницы: на её месте в DOM сайта появляется
     распорка — пустой div[data-nis-spacer] размером с заметку, и текст вокруг
     раздвигается: обтекает её слева или справа, а в узком блоке уезжает вниз.
     Пока заметку тащат, рамка показывает блок вёрстки, полоса — строку, перед
     которой заметка встанет, пунктир — её будущее место.

     Распорка наша, сайту она не принадлежит: в хранилище лежит только описание
     места (контейнер, номер узла в нём, смещение в тексте, сторона обтекания),
     а сам элемент создаётся заново при каждой отрисовке. Если вёрстка сайта
     изменилась и место не нашлось, заметка просто ложится поверх страницы по
     сохранённым координатам, как раньше. */
  const FIT_PAD = 6;                 // отступ от границ блока, если в поток встроиться не удалось
  const FIT_MIN_W = 150;             // уже этого заметку не сужаем
  const SPACER_GAP = 14;             // зазор между заметкой и обтекающим текстом
  const SPACER_VGAP = 10;            // и зазор снизу
  const TEXT_ROOM = 120;             // меньше этого текста рядом не остаётся — раздвигаем по вертикали

  /* Теги, внутрь которых распорку не вставляем: либо это не контейнер для потока
     (таблица, список, элемент формы), либо мы сломаем то, что внутри. */
  const NO_FLOW_TAGS = /^(input|textarea|select|button|svg|canvas|video|audio|img|picture|iframe|object|embed|table|thead|tbody|tfoot|tr|colgroup|col|ul|ol|dl|pre|code|script|style|template|slot|option|optgroup|map|area|br|hr)$/;
  /* Только обычные блоки: во flex/grid наш div стал бы ещё одной ячейкой раскладки. */
  const FLOW_DISPLAY = /^(block|flow-root|list-item|table-cell)$/;

  function fitCandidate(el, r) {
    if (r.width < 120 || r.height < 40) return false;
    if (NO_FLOW_TAGS.test(el.tagName.toLowerCase())) return false;
    if (el.isContentEditable) return false;          // редактор сайта — не наше место
    let cs = null;
    try { cs = getComputedStyle(el); } catch (e) { return false; }
    if (!FLOW_DISPLAY.test(cs.display) || cs.visibility === 'hidden') return false;
    // обёртка всей страницы — это не блок вёрстки, вписывать в неё нечего
    if (r.width >= pageWidth() - 8 && r.height > window.innerHeight * 0.8) return false;
    return true;
  }

  /* Блок вёрстки под точкой: самый маленький подходящий контейнер. */
  function layoutBlockAt(cx, cy) {
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return null;
    let stack = [];
    try { stack = document.elementsFromPoint(cx, cy) || []; } catch (e) { return null; }
    let hit = null;
    for (const e of stack) {
      if (!e || e === host || e.id === 'note-in-site-root') continue;
      if (e === document.body || e === document.documentElement) continue;
      hit = e; break;
    }
    let cur = hit, guard = 0;
    while (cur && cur !== document.body && cur !== document.documentElement && guard++ < 14) {
      if (fitCandidate(cur, cur.getBoundingClientRect())) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  /* Внутренняя область блока, без padding и рамок: именно в неё встаёт распорка,
     поэтому по ней считаются и ширина заметки, и предпросмотр. */
  function contentBox(el) {
    const r = el.getBoundingClientRect();
    let cs = null;
    try { cs = getComputedStyle(el); } catch (e) {}
    const px = k => (cs ? parseFloat(cs[k]) || 0 : 0);
    const dl = px('borderLeftWidth') + px('paddingLeft'), dr = px('borderRightWidth') + px('paddingRight');
    const dt = px('borderTopWidth') + px('paddingTop'), db = px('borderBottomWidth') + px('paddingBottom');
    const w = Math.max(0, r.width - dl - dr), h = Math.max(0, r.height - dt - db);
    return { left: r.left + dl, top: r.top + dt, width: w, height: h, right: r.left + dl + w, bottom: r.top + dt + h };
  }

  /* Узлы контейнера, между которыми можно встать. Пустые переносы строк между
     тегами и наши распорки пропускаем — список должен получаться одинаковым
     и при сохранении места, и при его восстановлении. */
  function flowNodes(cont) {
    const out = [];
    for (const nd of cont.childNodes) {
      if (nd.nodeType === 1) {
        if (nd.id === 'note-in-site-root' || (nd.dataset && nd.dataset.nisSpacer)) continue;
        out.push(nd);
      } else if (nd.nodeType === 3 && nd.nodeValue.trim()) {
        out.push(nd);
      }
      if (out.length >= 400) break;
    }
    return out;
  }

  function nodeRect(nd) {
    if (nd.nodeType === 1) return nd.getBoundingClientRect();
    try {
      const rg = document.createRange();
      rg.selectNodeContents(nd);
      return rg.getBoundingClientRect();
    } catch (e) { return null; }
  }

  /* Смещение в текстовом узле, с которого начинается строка под точкой cy.
     Нужно, чтобы заметка встала в ту строку, куда её принесли: обтекание идёт
     с той строки, где стоит распорка, а не с начала абзаца. Поиск двоичный —
     строки идут сверху вниз, поэтому первый символ, чья строка ниже точки,
     и есть начало нужной строки. */
  function textOffsetAt(nd, cy) {
    const len = nd.nodeValue.length;
    if (!len) return null;
    const rg = document.createRange();
    const rectAt = off => {
      try {
        rg.setStart(nd, off);
        rg.setEnd(nd, Math.min(off + 1, len));
        const r = rg.getBoundingClientRect();
        return r.height ? r : null;
      } catch (e) { return null; }
    };
    const first = rectAt(0);
    if (!first) return null;
    if (cy <= first.bottom) return { off: 0, top: first.top };
    let lo = 1, hi = len - 1, best = { off: 0, top: first.top };
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = rectAt(mid);
      if (!r) { lo = mid + 1; continue; }
      if (r.bottom <= cy) lo = mid + 1;
      else { best = { off: mid, top: r.top }; hi = mid - 1; }
    }
    return best;
  }

  /* Место внутри контейнера: { node, off, top }. node === null — в самый конец,
     off === null — перед узлом целиком, иначе — внутри текста на этом смещении.
     top — верх строки, с которой начнётся обтекание: по нему рисуется подсказка,
     поэтому для вставки в конец берётся низ последнего содержимого, а не низ
     самого блока: в поток заметка встанет сразу за текстом, а не в пустоту. */
  function flowSpot(cont, cy) {
    let last = null;
    for (const nd of flowNodes(cont)) {
      const r = nodeRect(nd);
      if (!r || (!r.width && !r.height)) continue;
      if (r.bottom <= cy) { last = { nd, r }; continue; }     // узел целиком выше точки
      if (nd.nodeType === 3) {
        const t = textOffsetAt(nd, cy);
        if (t) return { node: nd, off: t.off, top: t.top };
      }
      return { node: nd, off: null, top: r.top };
    }
    if (!last) return { node: null, off: null, top: contentBox(cont).top };
    let gap = 0;
    if (last.nd.nodeType === 1) {
      try { gap = parseFloat(getComputedStyle(last.nd).marginBottom) || 0; } catch (e) {}
    }
    return { node: null, off: null, top: last.r.bottom + gap };
  }

  function uniqueSel(el) {
    const sel = cssPath(el);
    if (!sel) return null;
    try { return document.querySelectorAll(sel).length === 1 ? sel : null; } catch (e) { return null; }
  }

  /* Куда встанет заметка, если отпустить её сейчас. Координаты — те же, что в
     el.style.left/top незакреплённой заметки, то есть координаты слоя. */
  function planDrop(left, top, w, h) {
    const plan = { block: null, rect: null, flow: null, line: null, w, left: Math.round(left), top: Math.round(top) };
    // блок ищем по точке чуть ниже верхнего края заметки: именно туда смотрит
    // пользователь, а середина высокой заметки попадает уже в соседний блок
    const cx = left + off.x - window.scrollX + w / 2;
    const cy = top + off.y - window.scrollY + Math.min(h / 2, 24);
    const first = layoutBlockAt(cx, cy);
    if (!first) return plan;

    /* Кандидаты: блок под точкой и его ближайшие родители. Обтекание (float)
       красивее всего, но работает только если заметка целиком укладывается
       в блок: вылезший float не раздвигает вёрстку, а наезжает на то, что ниже.
       Поэтому заметку, которая не влезает в маленький абзац, пробуем поставить
       в колонку, внутри которой этот абзац лежит, — тогда текст абзаца обтекает
       заметку. Не уложилась нигде — ставим её блоком в самый глубокий блок:
       он раздвинется по вертикали, и ничего не будет перекрыто. */
    let block = null, cb = null, spot = null, side = null, fw = w;
    for (let cur = first, guard = 0; cur && cur !== document.body && cur !== document.documentElement && guard < 4;
         cur = cur.parentElement, guard++) {
      if (cur !== first && !fitCandidate(cur, cur.getBoundingClientRect())) continue;
      const box = contentBox(cur);
      const cw = w > box.width ? Math.max(FIT_MIN_W, Math.round(box.width)) : w;
      if (cw + TEXT_ROOM > box.width) continue;              // текста рядом не останется
      const sp = flowSpot(cur, cy);
      if (sp.top + h > box.bottom + 1) continue;             // заметка вылезет за низ блока
      block = cur; cb = box; spot = sp; fw = cw;
      side = cx < box.left + box.width / 2 ? 'left' : 'right';
      break;
    }
    if (!block) {
      block = first;
      cb = contentBox(first);
      spot = flowSpot(first, cy);
      fw = w > cb.width ? Math.max(FIT_MIN_W, Math.round(cb.width)) : w;
      side = 'block';
    }

    const r = block.getBoundingClientRect();
    plan.block = block;
    plan.rect = { left: r.left + window.scrollX - off.x, top: r.top + window.scrollY - off.y, width: r.width, height: r.height };
    plan.w = fw;
    plan.flow = { cont: block, node: spot.node, off: spot.off, side };
    plan.line = {
      left: Math.round(cb.left + window.scrollX - off.x),
      top: Math.round(spot.top + window.scrollY - off.y),
      width: Math.round(cb.width)
    };
    plan.left = Math.round((side === 'right' ? cb.right - fw : cb.left) + window.scrollX - off.x);
    plan.top = Math.round(spot.top + window.scrollY - off.y + (side === 'block' ? SPACER_VGAP : 0));

    // если встроиться в поток не удастся — просто вписываем заметку в границы блока
    const avail = r.width - FIT_PAD * 2;
    const bl = plan.rect.left, bt = plan.rect.top;
    plan.fit = {
      left: avail >= fw
        ? Math.round(Math.min(Math.max(left, bl + FIT_PAD), bl + r.width - FIT_PAD - fw))
        : Math.round(bl + FIT_PAD),
      top: r.height - FIT_PAD * 2 >= h
        ? Math.round(Math.min(Math.max(top, bt + FIT_PAD), bt + r.height - FIT_PAD - h))
        : Math.round(top)
    };
    return plan;
  }

  /* ---------------- распорка в DOM сайта ---------------- */
  const SPACER_FIX = {
    'box-sizing': 'border-box', position: 'static', clear: 'none',
    margin: '0', padding: '0', border: '0', outline: 'none',
    background: 'none', 'box-shadow': 'none', 'list-style': 'none',
    'min-width': '0', 'min-height': '0', 'max-width': 'none', 'max-height': 'none',
    transform: 'none', visibility: 'visible', opacity: '1',
    'pointer-events': 'none'                      // не мешаем ни мыши, ни поиску блока под курсором
  };

  const spacerId = id => 'nis-spacer-' + id;
  const spacerOf = n => document.getElementById(spacerId(n.id));

  function removeSpacer(n) {
    const s = spacerOf(n);
    if (s) s.remove();
  }

  function makeSpacer(n) {
    const s = document.createElement('div');
    s.id = spacerId(n.id);
    s.dataset.nisSpacer = n.id;
    s.setAttribute('aria-hidden', 'true');
    // инлайновые !important: CSS сайта не должен ни раздуть распорку, ни показать её
    for (const k in SPACER_FIX) s.style.setProperty(k, SPACER_FIX[k], 'important');
    return s;
  }

  function removeAllSpacers() {
    let list = [];
    try { list = document.querySelectorAll('[data-nis-spacer]'); } catch (e) { return; }
    for (const s of list) s.remove();
  }

  function styleSpacer(s, side, w, h) {
    const st = s.style;
    const put = (prop, val) => { if (st.getPropertyValue(prop) !== val) st.setProperty(prop, val, 'important'); };
    put('display', 'block');
    put('float', side === 'block' ? 'none' : side);
    put('width', Math.round(w) + 'px');
    put('height', Math.round(h) + 'px');
    put('margin', side === 'block' ? SPACER_VGAP + 'px 0'
      : side === 'left' ? '0 ' + SPACER_GAP + 'px ' + SPACER_VGAP + 'px 0'
      : '0 0 ' + SPACER_VGAP + 'px ' + SPACER_GAP + 'px');
  }

  function insertSpacer(cont, s, idx, off) {
    const nodes = flowNodes(cont);
    const ref = idx >= 0 && idx < nodes.length ? nodes[idx] : null;
    try {
      if (off != null && ref && ref.nodeType === 3 && off > 0 && off < ref.nodeValue.length) {
        cont.insertBefore(s, ref.splitText(off));     // встаём внутрь абзаца, в нужную строку
      } else if (off != null && ref && ref.nodeType === 3 && off > 0) {
        cont.insertBefore(s, ref.nextSibling);
      } else {
        cont.insertBefore(s, ref);                    // ref === null — в конец контейнера
      }
    } catch (e) { return false; }
    return s.isConnected;
  }

  /* Вставляем заметку в поток по свежему плану перетаскивания. */
  function placeInFlow(n, el, flow) {
    n.flow = null;
    removeSpacer(n);                                  // место считаем по вёрстке без нашей распорки
    const cont = flow.cont;
    if (!cont || !cont.isConnected) return false;
    const sel = uniqueSel(cont);
    if (!sel) return false;
    const nodes = flowNodes(cont);
    const idx = flow.node ? nodes.indexOf(flow.node) : nodes.length;
    if (idx < 0) return false;
    const off = flow.node && flow.node.nodeType === 3 ? flow.off : null;
    if (!insertSpacer(cont, makeSpacer(n), idx, off)) return false;
    const s = spacerOf(n);
    styleSpacer(s, flow.side, n.w || el.offsetWidth || 240, el.offsetHeight || 40);
    n.flow = { sel, side: flow.side, idx, off };
    n.anchor = { sel: '#' + CSS.escape(spacerId(n.id)), ox: 0, oy: 0 };
    return true;
  }

  /* Восстанавливаем распорку по сохранённому описанию и подгоняем её под
     текущий размер заметки. */
  function ensureFlow(n, el) {
    if (!n.flow || n.fixed || !visible()) return false;
    let s = spacerOf(n);
    if (!s) {
      let cont = null;
      try { cont = document.querySelector(n.flow.sel); } catch (e) {}
      if (!cont || cont === host || cont.closest('#note-in-site-root')) return false;
      if (!insertSpacer(cont, makeSpacer(n), n.flow.idx, n.flow.off)) return false;
      s = spacerOf(n);
      if (!s) return false;
    }
    styleSpacer(s, n.flow.side, n.w || el.offsetWidth || 240, el.offsetHeight || 40);
    return true;
  }

  /* Заметку тащат или закрепляют на экране — вынимаем её из потока, текст сходится обратно. */
  function pickFromFlow(n) {
    removeSpacer(n);
    if (n.flow) n.flow = null;
  }

  /* Размер заметки изменился (правка, свёртывание, растягивание) — подгоняем распорку. */
  function refitFlow(n, el) {
    if (!n.flow || n.fixed || dragging(el)) return;
    ensureFlow(n, el);
    applyPos(n, el);
  }

  /* ---------------- подсказка при перетаскивании ----------------
     Живёт в том же слое, что и заметки, поэтому её координаты считаются так же
     (документ минус off) и она едет вместе со страницей. */
  let dropHint = null;

  function dropHintEl() {
    if (dropHint && dropHint.isConnected) return dropHint;
    ensureHost();
    dropHint = document.createElement('div');
    dropHint.className = 'nis-drop';
    dropHint.innerHTML = '<div class="nis-drop-box"><span class="nis-drop-tag"></span></div>' +
                         '<div class="nis-drop-line"></div>' +
                         '<div class="nis-drop-ghost"></div>';
    layer.appendChild(dropHint);
    return dropHint;
  }

  function showDropHint(plan, h) {
    const d = dropHintEl();
    const box = d.querySelector('.nis-drop-box');
    const line = d.querySelector('.nis-drop-line');
    const ghost = d.querySelector('.nis-drop-ghost');
    if (plan.rect) {
      box.style.display = 'block';
      box.style.left = Math.round(plan.rect.left) + 'px';
      box.style.top = Math.round(plan.rect.top) + 'px';
      box.style.width = Math.round(plan.rect.width) + 'px';
      box.style.height = Math.round(plan.rect.height) + 'px';
      d.querySelector('.nis-drop-tag').textContent = 'Вставить в текст';
      box.classList.toggle('nis-inside', plan.rect.top < 18);
    } else {
      box.style.display = 'none';                 // блок не нашёлся — показываем только курсор вставки
    }
    if (plan.line) {                              // строка, перед которой заметка встанет
      line.style.display = 'block';
      line.style.left = plan.line.left + 'px';
      line.style.top = plan.line.top + 'px';
      line.style.width = plan.line.width + 'px';
    } else {
      line.style.display = 'none';
    }
    ghost.style.left = plan.left + 'px';
    ghost.style.top = plan.top + 'px';
    ghost.style.width = Math.round(plan.w) + 'px';
    ghost.style.height = Math.round(h) + 'px';
    d.style.display = 'block';
  }

  function hideDropHint() { if (dropHint) dropHint.style.display = 'none'; }

  function applyPos(n, el) {
    const w = el.offsetWidth || n.w || 240;
    if (n.fixed) {
      el.style.position = 'fixed';
      el.style.left = Math.round(Math.min(Math.max(0, n.x), Math.max(0, window.innerWidth - w - 6))) + 'px';
      el.style.top = Math.round(Math.max(0, n.y)) + 'px';
    } else {
      const p = resolvePos(n);
      const maxX = Math.max(0, pageWidth() - w - 6);
      el.style.position = 'absolute';
      el.style.left = Math.round(Math.min(Math.max(0, p.x), maxX) - off.x) + 'px';
      el.style.top = Math.round(Math.max(0, p.y) - off.y) + 'px';
    }
  }

  const dragging = el => el.classList.contains('dragging');

  function repositionAll() {
    if (!host || !host.isConnected) return;
    // сначала распорки: они сами меняют вёрстку, и только после этого имеет
    // смысл считать, где оказались заметки. Ту, которую сейчас тащат, не
    // трогаем: её вынули из потока, и перевёрстка не должна возвращать её
    // на прежнее место из-под рук
    for (const n of notes) {
      const el = els.get(n.id);
      if (el && !dragging(el)) ensureFlow(n, el);
    }
    measureOffset();
    for (const n of notes) {
      const el = els.get(n.id);
      if (el && !dragging(el)) applyPos(n, el);
    }
    scheduleOcclusion(120);
  }

  /* ---------------- отрисовка ---------------- */
  function applyNoteStyle(n, el) {
    el.style.background = n.bg || '#fff59d';
    el.style.color = n.color || '#20242e';
    el.style.fontFamily = n.fontFamily || 'system-ui';
    el.style.fontSize = (n.fontSize || 15) + 'px';
    el.style.width = (n.w || 240) + 'px';
    el.style.height = 'auto';
    // n.h — высота именно текстового поля: панель редактирования на неё не влияет,
    // поэтому после выхода из правки заметка сжимается ровно до текста
    const body = el.querySelector('.nis-body');
    body.style.height = (n.collapsed || !n.h) ? 'auto' : n.h + 'px';
    el.style.zIndex = String(n.z || 10);
    if (n.extra) for (const k in n.extra) el.style.setProperty(k, n.extra[k]);
    el.classList.toggle('collapsed', !!n.collapsed);
    const pin = el.querySelector('[data-act="pin"]');
    if (pin) pin.classList.toggle('on', !!n.fixed);
    const sc = el.querySelector('[data-act="scope"]');
    if (sc) sc.classList.toggle('on', n.scope === 'site');
    const col = el.querySelector('[data-act="collapse"]');
    if (col) col.textContent = n.collapsed ? '+' : '–';
  }

  function previewText(n) {
    const d = document.createElement('div');
    d.innerHTML = NIS_SANITIZE(n.html || '');
    return (d.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70);
  }

  function optionsHtml(list, cur, valueIsNum) {
    return list.map(item => {
      const v = valueIsNum ? item : item[0];
      const label = valueIsNum ? item : item[1];
      const sel = String(v) === String(cur) ? ' selected' : '';
      return `<option value="${String(v).replace(/"/g, '&quot;')}"${sel}>${label}</option>`;
    }).join('');
  }

  function renderNote(n) {
    ensureHost();
    const el = document.createElement('div');
    el.className = 'nis-note';
    el.dataset.id = n.id;
    el.innerHTML = `
      <div class="nis-tools">
        <span class="nis-grip" title="Перетащить заметку">⠿</span>
        <button class="nis-b" data-act="bold" title="Жирный (Ctrl+B)"><b>B</b></button>
        <button class="nis-b" data-act="italic" title="Курсив (Ctrl+I)"><i>I</i></button>
        <button class="nis-b" data-act="underline" title="Подчёркнутый (Ctrl+U)"><u>U</u></button>
        <button class="nis-b" data-act="strike" title="Зачёркнутый"><s>S</s></button>
        <select class="nis-sel" data-act="font" title="Шрифт">${optionsHtml(FONTS, n.fontFamily)}</select>
        <select class="nis-sel nis-size" data-act="size" title="Размер шрифта">${optionsHtml(SIZES, n.fontSize, true)}</select>
        <label class="nis-color" title="Цвет текста: выделите фрагмент или примените ко всей заметке">A<input type="color" data-act="color" value="${n.color || '#20242e'}"></label>
        <label class="nis-color" title="Цвет заметки">🎨<input type="color" data-act="bg" value="${n.bg || '#fff59d'}"></label>
        <button class="nis-b" data-act="list" title="Маркированный список">•—</button>
        <button class="nis-b" data-act="emoji" title="Вставить эмодзи">😊</button>
        <button class="nis-b" data-act="link" title="Вставить ссылку (Ctrl+K)">🔗</button>
        <button class="nis-b" data-act="clear" title="Убрать форматирование">⌫</button>
        <span class="nis-sep"></span>
        <button class="nis-b" data-act="pin" title="Закрепить на экране (не прокручивать вместе со страницей)">📌</button>
        <button class="nis-b" data-act="scope" title="Показывать на всём сайте / только на этой странице">🌐</button>
        <button class="nis-b" data-act="collapse" title="Свернуть / развернуть">–</button>
        <button class="nis-b nis-danger" data-act="del" title="Удалить заметку">✕</button>
      </div>
      <div class="nis-field">
        <div class="nis-body" data-ph="Текст заметки…"></div>
      </div>
      <div class="nis-grow" title="Изменить размер"></div>`;

    const body = el.querySelector('.nis-body');
    body.innerHTML = NIS_SANITIZE(n.html || '');

    wire(n, el);
    applyNoteStyle(n, el);
    layer.appendChild(el);
    ensureFlow(n, el);                // возвращаем распорку в вёрстку, если заметка стоит в потоке
    applyPos(n, el);
    els.set(n.id, el);
    return el;
  }

  function renderAll() {
    ensureHost();
    layer.textContent = '';
    els.clear();
    removeAllSpacers();               // распорки создаются заново вместе с заметками
    if (!visible()) return;
    measureOffset();
    for (const n of notes) renderNote(n);
    scheduleOcclusion(150);
  }

  async function reload() {
    await loadAll();
    renderAll();
  }

  /* Перерисовка после слияния. Полный renderAll() снёс бы и ту заметку, которую
     сейчас правят или тащат, — вместе с курсором, выделением и жестом. Поэтому
     занятые оставляем как есть, остальные пересобираем: так не нужно обновлять
     каждое поле по отдельности и не появляется расхождений с renderNote(). */
  function syncDom() {
    ensureHost();
    if (!visible()) { layer.textContent = ''; els.clear(); removeAllSpacers(); return; }
    measureOffset();
    const alive = new Set(notes.map(n => n.id));
    for (const [id, el] of Array.from(els)) {
      if (alive.has(id)) continue;
      removeSpacer({ id });           // заметку удалили в другой вкладке — убираем и распорку
      el.remove();
      els.delete(id);
    }
    for (const n of notes) {
      const el = els.get(n.id);
      if (el && (isEditing(el) || dragging(el))) continue;
      if (el) { removeSpacer(n); el.remove(); els.delete(n.id); }
      renderNote(n);
    }
    scheduleOcclusion(150);
  }

  /* Чужая запись в хранилище: подмешиваем её к тому, что в памяти. Раньше здесь
     был полный reload(), и он пропускался, если на странице открыта правка, —
     то есть правка соседней вкладки просто терялась при следующем сохранении. */
  async function external() {
    let res = {};
    try { res = await chrome.storage.local.get(myKeys()); } catch (e) { return; }
    const wasVisible = visible();
    applySettings(res[SETTINGS_KEY]);
    tombs = pruneTombs(Object.assign({}, tombs, res[TOMB_KEY]));
    const merged = mergeNotes(notes, notesFrom(res));
    const changed = merged.length !== notes.length || merged.some(n => !notes.includes(n));
    notes = merged;
    zTop = notes.reduce((m, n) => Math.max(m, n.z || 0), zTop);
    if (visible() !== wasVisible) renderAll();
    else if (changed) syncDom();
  }

  /* ---------------- поведение заметки ---------------- */
  const isEditing = el => el.classList.contains('editing');
  const anyEditing = () => Array.from(els.values()).some(isEditing);

  /* withTools: true — показать панель форматирования, false — скрыть,
     не передан — оставить как есть (панель открывается только кнопкой ✎) */
  function setEditing(n, el, on, withTools) {
    el.classList.toggle('editing', on);
    if (!on) el.classList.remove('tools');
    else if (withTools !== undefined) el.classList.toggle('tools', !!withTools);
    const body = el.querySelector('.nis-body');
    body.contentEditable = on ? 'true' : 'false';
    if (!on) closeEmoji();
    refitFlow(n, el);                 // панель правки меняет высоту — распорка едет за ней
    if (on) {
      bringToFront(n, el);
      setTimeout(() => body.focus(), 0);
    } else {
      commitBody(n, el);
      if (!previewText(n) && !body.querySelector('a')) removeNote(n.id);   // пустую заметку не храним
    }
  }

  /* Ставим курсор туда, куда кликнули: до этого поле не было редактируемым,
     поэтому браузер каретку не поставил. Не вышло — просто в конец текста. */
  function caretAt(el, cx, cy) {
    const body = el.querySelector('.nis-body');
    setTimeout(() => {
      body.focus();
      const sel = getSel();
      if (!sel) return;
      let r = null;
      try {
        if (shadow && shadow.caretRangeFromPoint) r = shadow.caretRangeFromPoint(cx, cy);
        else if (document.caretRangeFromPoint) r = document.caretRangeFromPoint(cx, cy);
      } catch (e) {}
      if (!r || !body.contains(r.startContainer)) {
        r = document.createRange();
        r.selectNodeContents(body);
        r.collapse(false);
      }
      try { sel.removeAllRanges(); sel.addRange(r); } catch (e) {}
    }, 0);
  }

  function commitBody(n, el) {
    const body = el.querySelector('.nis-body');
    const html = NIS_SANITIZE(body.innerHTML);
    if (html !== n.html) { n.html = html; n.updatedAt = Date.now(); refitFlow(n, el); scheduleSave(); }
  }

  function bringToFront(n, el) {
    if (n.z === zTop) return;
    n.z = ++zTop;
    el.style.zIndex = String(n.z);
    scheduleSave();
  }

  function removeNote(id) {
    const i = notes.findIndex(n => n.id === id);
    if (i < 0) return;
    pickFromFlow(notes[i]);           // убираем распорку — текст сходится обратно
    tombs[id] = Date.now();           // надгробие: слияние не вернёт заметку из чужой памяти
    notes.splice(i, 1);
    const el = els.get(id);
    if (el) el.remove();
    els.delete(id);
    saveAll();
  }

  function wire(n, el) {
    const body = el.querySelector('.nis-body');
    const tools = el.querySelector('.nis-tools');
    const grip = el.querySelector('.nis-grip');

    el.addEventListener('pointerdown', () => bringToFront(n, el), true);
    // страница не должна перехватывать ввод внутри заметки (горячие клавиши сайтов и т.п.)
    ['keydown', 'keypress', 'keyup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']
      .forEach(t => el.addEventListener(t, e => e.stopPropagation()));

    // в режиме просмотра заметка перетаскивается за любое место,
    // в режиме правки — только за ⠿, чтобы можно было выделять текст
    grip.addEventListener('pointerdown', e => startDrag(n, el, e));
    grip.addEventListener('dblclick', () => toggleCollapse(n, el));
    el.addEventListener('pointerdown', e => {
      if (el.classList.contains('tools')) return;
      if (e.target.closest('.nis-b, .nis-grow, a')) return;
      startDrag(n, el, e);
    });

    el.querySelector('.nis-grow').addEventListener('pointerdown', e => startResize(n, el, e));

    el.addEventListener('click', e => {
      const btn = e.target.closest('.nis-b');
      if (!btn) return;
      e.preventDefault();
      handleAction(btn.dataset.act, n, el);
    });

    /* Отдельной кнопки правки нет: в режиме просмотра клик или касание по самой
       заметке открывает правку вместе с панелью. Перетаскивание не мешает —
       после него клика либо нет, либо он приходит сразу за жестом. */
    el.addEventListener('click', e => {
      if (isEditing(el)) return;                              // уже правим — это обычный клик по тексту
      if (e.target.closest('.nis-b, .nis-grow, a')) return;   // кнопки и ссылки со своей логикой
      if (Date.now() - lastDragEnd < 400) return;             // только что тащили
      setEditing(n, el, true, true);
      caretAt(el, e.clientX, e.clientY);
    });

    // запоминаем выделение до того, как фокус уйдёт на элемент панели
    tools.addEventListener('pointerdown', e => {
      rememberRange(n);
      if (e.target.closest('.nis-b')) e.preventDefault();   // кнопки не должны забирать фокус
    }, true);

    tools.addEventListener('change', e => {
      const t = e.target;
      const act = t.dataset.act;
      if (act === 'font') setStyle(n, el, { 'font-family': t.value }, 'fontFamily', t.value);
      else if (act === 'size') setStyle(n, el, { 'font-size': t.value + 'px' }, 'fontSize', parseInt(t.value, 10));
      else if (act === 'color') setStyle(n, el, { color: t.value }, 'color', t.value);
      else if (act === 'bg') { n.bg = t.value; n.updatedAt = Date.now(); applyNoteStyle(n, el); scheduleSave(); }
    });

    body.addEventListener('input', () => { clearTimeout(inputTimer); inputTimer = setTimeout(() => commitBody(n, el), 400); });
    body.addEventListener('mouseup', () => rememberRange(n));
    body.addEventListener('keyup', () => rememberRange(n));
    body.addEventListener('blur', () => { rememberRange(n); commitBody(n, el); });
    body.addEventListener('paste', e => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      if (document.execCommand) document.execCommand('insertText', false, text);
    });
    // перетаскивание в заметку тоже вставляет только текст — чужой HTML внутрь не попадает
    body.addEventListener('drop', e => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      const text = e.dataTransfer.getData('text/plain');
      if (text && document.execCommand) document.execCommand('insertText', false, text);
    });
    body.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); setEditing(n, el, false); return; }
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'b') { e.preventDefault(); handleAction('bold', n, el); }
        else if (k === 'i') { e.preventDefault(); handleAction('italic', n, el); }
        else if (k === 'u') { e.preventDefault(); handleAction('underline', n, el); }
        else if (k === 'k') { e.preventDefault(); handleAction('link', n, el); }
      }
    });

    body.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (!a) return;
      if (isEditing(el) && !(e.ctrlKey || e.metaKey)) return;   // в режиме правки клик ставит курсор
      e.preventDefault();
      e.stopPropagation();
      openLink(a);
    });
  }

  /* ---------------- эмодзи ----------------
     Панель живёт рядом с заметкой, а не внутри неё: у заметки overflow: hidden,
     внутри её бы обрезало. Координаты — экранные (position: fixed), потому что
     это короткоживущее окошко и прокручиваться вместе со страницей ему незачем. */
  let emojiPanel = null, emojiNote = null;

  function closeEmoji() {
    if (emojiPanel) emojiPanel.remove();
    emojiPanel = null;
    emojiNote = null;
  }

  function toggleEmoji(n, el) {
    if (emojiNote === n.id) { closeEmoji(); return; }
    closeEmoji();
    ensureHost();
    const pan = document.createElement('div');
    pan.className = 'nis-emoji';
    pan.innerHTML = EMOJI.map(ch => `<button class="nis-em" type="button">${ch}</button>`).join('');
    shadow.appendChild(pan);

    // кнопки не должны забирать фокус из текста — иначе некуда вставлять
    pan.addEventListener('pointerdown', e => { rememberRange(n); e.preventDefault(); }, true);
    pan.addEventListener('click', e => {
      const b = e.target.closest('.nis-em');
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      insertEmoji(n, el, b.textContent);
    });

    const r = el.getBoundingClientRect();
    const pw = pan.offsetWidth, ph = pan.offsetHeight;
    let left = r.left, top = r.bottom + 6;
    if (left + pw > window.innerWidth - 6) left = window.innerWidth - pw - 6;
    if (top + ph > window.innerHeight - 6) top = Math.max(6, r.top - ph - 6);
    pan.style.left = Math.max(6, Math.round(left)) + 'px';
    pan.style.top = Math.round(top) + 'px';

    emojiPanel = pan;
    emojiNote = n.id;
  }

  function insertEmoji(n, el, ch) {
    const body = el.querySelector('.nis-body');
    if (!isEditing(el)) setEditing(n, el, true, true);
    const r = activeRange(n, el);
    const node = document.createTextNode(ch);
    if (r) {
      r.deleteContents();
      r.insertNode(node);
      r.setStartAfter(node);
      r.collapse(true);
      const sel = getSel();
      if (sel) { try { sel.removeAllRanges(); sel.addRange(r); } catch (e) {} }
      savedRange = r.cloneRange();
      savedRangeNote = n.id;
    } else {
      body.appendChild(node);
    }
    commitBody(n, el);
    refitFlow(n, el);
    body.focus();
  }

  function toggleCollapse(n, el) {
    n.collapsed = !n.collapsed;
    n.updatedAt = Date.now();
    applyNoteStyle(n, el);
    refitFlow(n, el);
    scheduleSave();
  }

  function handleAction(act, n, el) {
    switch (act) {
      case 'collapse': toggleCollapse(n, el); break;
      case 'del':
        if (!previewText(n)) { removeNote(n.id); break; }
        askConfirm('Удалить заметку?', previewText(n)).then(yes => { if (yes) removeNote(n.id); });
        break;
      case 'pin': {
        const r = el.getBoundingClientRect();
        if (!n.fixed) {
          pickFromFlow(n);            // закреплённая заметка живёт в окне, в вёрстке ей места нет
          n.fixed = true;
          n.x = Math.round(r.left);
          n.y = Math.round(r.top);
          n.anchor = null;
        } else {
          n.fixed = false;
          n.x = Math.round(r.left + window.scrollX);
          n.y = Math.round(r.top + window.scrollY);
          n.anchor = computeAnchor(n.x, n.y);
        }
        n.updatedAt = Date.now();
        applyNoteStyle(n, el);
        applyPos(n, el);
        scheduleSave();
        toast(n.fixed ? 'Заметка закреплена на экране' : 'Заметка привязана к месту на странице');
        break;
      }
      case 'scope': {
        n.scope = (n.scope === 'site') ? 'page' : 'site';
        n.updatedAt = Date.now();
        applyNoteStyle(n, el);
        saveAll();
        toast(n.scope === 'site'
          ? 'Заметка видна на всех страницах этого сайта'
          : 'Заметка видна только на этой странице');
        break;
      }
      case 'bold':
        toggleInline(n, el, 'font-weight', '700', 'fontWeight', v => v === 'bold' || parseInt(v, 10) >= 600);
        break;
      case 'italic':
        toggleInline(n, el, 'font-style', 'italic', 'fontStyle', v => v === 'italic' || v === 'oblique');
        break;
      case 'underline':
        toggleInline(n, el, 'text-decoration-line', 'underline', 'textDecorationLine', v => /underline/.test(v));
        break;
      case 'strike':
        toggleInline(n, el, 'text-decoration-line', 'line-through', 'textDecorationLine', v => /line-through/.test(v));
        break;
      case 'list': insertList(n, el); break;
      case 'emoji': toggleEmoji(n, el); break;
      case 'link': openLinkDialog(n, el); break;
      case 'clear': clearFormatting(n, el); break;
    }
  }

  /* ---------------- выделение и форматирование ---------------- */
  /* запоминаем только реальное выделение: свёрнутый курсор сбрасывает его,
     иначе стиль «ко всей заметке» уходил бы в старый выделенный фрагмент */
  function rememberRange(n) {
    const sel = getSel();
    if (!sel || sel.rangeCount === 0) return;
    const el = els.get(n.id);
    if (!el) return;
    const body = el.querySelector('.nis-body');
    const r = sel.getRangeAt(0);
    if (!body.contains(r.commonAncestorContainer) && r.commonAncestorContainer !== body) return;
    if (r.collapsed) {
      if (savedRangeNote === n.id) { savedRange = null; savedRangeNote = null; }
      return;
    }
    savedRange = r.cloneRange();
    savedRangeNote = n.id;
  }

  function activeRange(n, el) {
    const body = el.querySelector('.nis-body');
    const inBody = r => body.contains(r.commonAncestorContainer) || r.commonAncestorContainer === body;
    const sel = getSel();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (inBody(r) && !r.collapsed) return r;
    }
    if (savedRangeNote === n.id && savedRange && !savedRange.collapsed && inBody(savedRange)) return savedRange;
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (inBody(r)) return r;
    }
    return null;
  }

  function wrapRange(range, styles) {
    const span = document.createElement('span');
    for (const k in styles) span.style.setProperty(k, styles[k]);
    try {
      range.surroundContents(span);
    } catch (e) {
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    const sel = getSel();
    if (sel) {
      const r = document.createRange();
      r.selectNodeContents(span);
      sel.removeAllRanges();
      sel.addRange(r);
      savedRange = r.cloneRange();
    }
    return span;
  }

  /* стиль применяется к выделению, а если выделения нет — ко всей заметке */
  function setStyle(n, el, cssProps, noteProp, noteVal) {
    const body = el.querySelector('.nis-body');
    const r = activeRange(n, el);
    if (isEditing(el) && r && !r.collapsed) {
      wrapRange(r, cssProps);
      commitBody(n, el);
    } else {
      n[noteProp] = noteVal;
      n.updatedAt = Date.now();
      // убираем конфликтующие инлайновые стили внутри, иначе новый стиль заметки не будет виден
      body.querySelectorAll('[style]').forEach(s => { for (const p in cssProps) s.style.removeProperty(p); });
      applyNoteStyle(n, el);
      commitBody(n, el);
      refitFlow(n, el);
      scheduleSave();
    }
    if (isEditing(el)) body.focus();
  }

  function toggleInline(n, el, cssProp, onVal, computedProp, isOnFn) {
    const offVal = cssProp === 'text-decoration-line' ? 'none' : (cssProp === 'font-weight' ? '400' : 'normal');
    const body = el.querySelector('.nis-body');
    const r = activeRange(n, el);
    if (isEditing(el) && r && !r.collapsed) {
      let node = r.startContainer;
      if (node.nodeType === 3) node = node.parentElement;
      const cur = node ? getComputedStyle(node)[computedProp] : '';
      wrapRange(r, { [cssProp]: isOnFn(String(cur)) ? offVal : onVal });
      commitBody(n, el);
      body.focus();
    } else {
      const cur = String(el.style.getPropertyValue(cssProp) || '');
      const val = isOnFn(cur) ? offVal : onVal;
      el.style.setProperty(cssProp, val);
      n.extra = Object.assign({}, n.extra, { [cssProp]: val });
      n.updatedAt = Date.now();
      refitFlow(n, el);
      scheduleSave();
    }
  }

  function insertList(n, el) {
    const body = el.querySelector('.nis-body');
    if (!isEditing(el)) setEditing(n, el, true);
    const r = activeRange(n, el);
    const ul = document.createElement('ul');
    if (r && !r.collapsed) {
      const lines = r.toString().split('\n').map(s => s.trim()).filter(Boolean);
      r.deleteContents();
      (lines.length ? lines : ['']).forEach(t => {
        const li = document.createElement('li');
        li.textContent = t;
        ul.appendChild(li);
      });
      r.insertNode(ul);
    } else {
      const li = document.createElement('li');
      li.innerHTML = '<br>';
      ul.appendChild(li);
      if (r) r.insertNode(ul); else body.appendChild(ul);
    }
    commitBody(n, el);
    body.focus();
  }

  function clearFormatting(n, el) {
    const body = el.querySelector('.nis-body');
    const r = activeRange(n, el);
    if (r && !r.collapsed) {
      const text = r.toString();
      r.deleteContents();
      r.insertNode(document.createTextNode(text));
    } else {
      body.querySelectorAll('[style]').forEach(s => s.removeAttribute('style'));
    }
    commitBody(n, el);
    body.focus();
  }

  /* ---------------- перетаскивание и размер ----------------
     Пальцем всё иначе, чем мышью: если не перехватить указатель и не запретить
     браузеру его жест, тот через несколько пикселей забирает движение себе
     (прокрутка/выделение) и присылает pointercancel вместо pointerup — заметка
     срывается и не сохраняется. Поэтому здесь: setPointerCapture, обработка
     pointercancel как обычного отпускания и порог побольше для пальца. */
  function dragGesture(el, e, onMove, onEnd) {
    const id = e.pointerId;
    const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    let captured = false;
    try { el.setPointerCapture(id); captured = true; } catch (err) {}

    const move = ev => { if (ev.pointerId === id) onMove(ev, touch); };
    const end = ev => {
      if (ev && ev.pointerId !== id) return;
      detach();
      onEnd(ev);
    };
    function detach() {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      el.removeEventListener('lostpointercapture', end);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      try { if (captured && el.hasPointerCapture && el.hasPointerCapture(id)) el.releasePointerCapture(id); } catch (err) {}
    }

    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);          // палец «отобрали» — тоже конец жеста
    if (!captured) {                                    // на всякий случай, если захват не дали
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', end, true);
      window.addEventListener('pointercancel', end, true);
    }
    return touch;
  }

  function startDrag(n, el, e) {
    if (e.button > 0) return;
    bringToFront(n, el);
    const sx = e.clientX, sy = e.clientY;
    const left0 = parseFloat(el.style.left) || 0, top0 = parseFloat(el.style.top) || 0;
    let moved = false, raf = 0;

    // курсор вставки пересчитываем не чаще кадра: hit-тест и промер строк
    // на каждое движение мыши на тяжёлой вёрстке заметно тормозят
    const drawHint = () => {
      raf = 0;
      if (!moved) return;
      const h = el.offsetHeight || 40;
      showDropHint(planDrop(parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0,
                            el.offsetWidth || n.w || 240, h), h);
    };

    dragGesture(el, e, (ev, touch) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      const threshold = touch ? 8 : 4;                  // палец дрожит сильнее мыши
      if (!moved) {
        if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;   // это ещё касание, а не перетаскивание
        moved = true;
        el.classList.add('dragging');
        const sel = getSel();
        if (sel && sel.removeAllRanges) sel.removeAllRanges();
        pickFromFlow(n);            // вынимаем заметку из потока: текст сходится, место ищем по чистой вёрстке
      }
      if (ev.cancelable) ev.preventDefault();
      el.style.left = (left0 + dx) + 'px';
      el.style.top = (top0 + dy) + 'px';
      if (!n.fixed && !raf) raf = requestAnimationFrame(drawHint);   // закреплённая заметка живёт в окне, а не в вёрстке
    }, () => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      hideDropHint();
      el.classList.remove('dragging');
      if (!moved) return;
      lastDragEnd = Date.now();
      const left = parseFloat(el.style.left) || 0, top = parseFloat(el.style.top) || 0;
      if (n.fixed) {
        n.x = Math.round(left);
        n.y = Math.round(top);
        n.anchor = null;
      } else {
        dropIntoPage(n, el, left, top);
      }
      n.updatedAt = Date.now();
      scheduleSave();                                   // сохраняем и после pointercancel
    });
  }

  /* Отпустили незакреплённую заметку: встраиваем её в поток вёрстки (текст
     раздвигается), а если это невозможно — просто вписываем в границы блока. */
  function dropIntoPage(n, el, left, top) {
    const h = el.offsetHeight || 40;
    const plan = planDrop(left, top, el.offsetWidth || n.w || 240, h);
    if (plan.w < (el.offsetWidth || 0)) {               // заметка была шире блока — сужаем
      n.w = Math.round(plan.w);
      el.style.width = n.w + 'px';
    }
    if (plan.flow && placeInFlow(n, el, plan.flow)) {
      applyPos(n, el);                                  // заметка встала на распорку
      const p = resolvePos(n);
      n.x = Math.round(p.x);
      n.y = Math.round(p.y);
      return true;
    }
    const fx = plan.fit ? plan.fit.left : left, fy = plan.fit ? plan.fit.top : top;
    el.style.left = Math.round(fx) + 'px';
    el.style.top = Math.round(fy) + 'px';
    n.x = Math.round(fx + off.x);
    n.y = Math.round(fy + off.y);
    n.anchor = computeAnchor(n.x, n.y);
    return false;
  }

  function startResize(n, el, e) {
    if (e.button > 0) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    const body = el.querySelector('.nis-body');
    const sx = e.clientX, sy = e.clientY;
    const w0 = el.offsetWidth, h0 = body.offsetHeight;

    dragGesture(el, e, ev => {
      if (ev.cancelable) ev.preventDefault();
      el.style.width = Math.max(170, w0 + ev.clientX - sx) + 'px';
      body.style.height = Math.max(24, h0 + ev.clientY - sy) + 'px';
    }, () => {
      lastDragEnd = Date.now();
      n.w = el.offsetWidth;
      n.h = body.offsetHeight;          // сохраняем высоту текста, а не окна с панелью
      n.updatedAt = Date.now();
      refitFlow(n, el);
      scheduleSave();
    });
  }

  /* ---------------- ссылки ---------------- */
  function openLink(a) {
    const url = (a.getAttribute('href') || '').trim();
    if (!url) return;
    const popup = a.dataset.nisPopup !== '0';
    const w = parseInt(a.dataset.nisW, 10) || settings.popupSize.width;
    const h = parseInt(a.dataset.nisH, 10) || settings.popupSize.height;
    try {
      chrome.runtime.sendMessage({ type: 'nis:open-link', url, popup, w, h }, resp => {
        void chrome.runtime.lastError;
        if (resp && resp.ok === false) toast(resp.error || 'Не удалось открыть ссылку');
      });
    } catch (e) {
      toast('Расширение было перезагружено — обновите страницу');
    }
  }

  function openLinkDialog(n, el) {
    const body = el.querySelector('.nis-body');
    if (!isEditing(el)) setEditing(n, el, true);
    const r = activeRange(n, el);
    let existing = null;
    if (r) {
      let node = r.startContainer;
      if (node.nodeType === 3) node = node.parentElement;
      existing = node && node.closest ? node.closest('a') : null;
      if (existing && !body.contains(existing)) existing = null;
    }
    const selText = existing ? existing.textContent : (r ? r.toString() : '');
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

    const dlg = document.createElement('div');
    dlg.className = 'nis-modal';
    dlg.innerHTML = `
      <div class="nis-modal-box">
        <div class="nis-modal-title">${existing ? 'Изменить ссылку' : 'Вставить ссылку'}</div>
        <label>Адрес (URL)
          <input class="nis-in" data-f="url" type="text" placeholder="https://example.com"
                 value="${existing ? esc(existing.getAttribute('href') || '') : ''}">
        </label>
        <label>Текст ссылки
          <input class="nis-in" data-f="text" type="text" placeholder="подпись" value="${esc(selText)}">
        </label>
        <div class="nis-check">
          <input type="checkbox" data-f="popup" ${(!existing || existing.dataset.nisPopup !== '0') ? 'checked' : ''}>
          <span>Открывать во всплывающем окне</span>
        </div>
        <div class="nis-row">
          <label>Ширина окна<input class="nis-in" data-f="w" type="number" min="200" max="3000"
                 value="${existing && existing.dataset.nisW ? esc(existing.dataset.nisW) : settings.popupSize.width}"></label>
          <label>Высота окна<input class="nis-in" data-f="h" type="number" min="200" max="3000"
                 value="${existing && existing.dataset.nisH ? esc(existing.dataset.nisH) : settings.popupSize.height}"></label>
        </div>
        <div class="nis-modal-actions">
          ${existing ? '<button class="nis-b2" data-a="unlink">Убрать ссылку</button>' : ''}
          <button class="nis-b2" data-a="cancel">Отмена</button>
          <button class="nis-b2 nis-primary" data-a="ok">${existing ? 'Сохранить' : 'Вставить'}</button>
        </div>
      </div>`;
    shadow.appendChild(dlg);
    const f = k => dlg.querySelector(`[data-f="${k}"]`);
    setTimeout(() => f('url').focus(), 0);

    const close = () => dlg.remove();
    dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
    dlg.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); apply(); }
    });
    dlg.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', ev => {
      const a = ev.currentTarget.dataset.a;
      if (a === 'cancel') return close();
      if (a === 'unlink') {
        const frag = document.createDocumentFragment();
        while (existing.firstChild) frag.appendChild(existing.firstChild);
        existing.replaceWith(frag);
        commitBody(n, el);
        return close();
      }
      apply();
    }));

    function apply() {
      let url = f('url').value.trim();
      if (!url) return close();
      if (!/^[a-z][\w+.-]*:/i.test(url)) url = 'https://' + url;
      if (!/^(https?:|mailto:|tel:)/i.test(url)) { toast('Поддерживаются только http(s), mailto и tel'); return; }
      const text = f('text').value.trim() || url;
      const popup = f('popup').checked;
      const w = Math.min(3000, Math.max(200, parseInt(f('w').value, 10) || settings.popupSize.width));
      const h = Math.min(3000, Math.max(200, parseInt(f('h').value, 10) || settings.popupSize.height));

      const a = existing || document.createElement('a');
      a.setAttribute('href', url);
      a.setAttribute('title', (popup ? 'Открыть во всплывающем окне: ' : 'Открыть в новой вкладке: ') + url);
      a.dataset.nisPopup = popup ? '1' : '0';
      a.dataset.nisW = String(w);
      a.dataset.nisH = String(h);
      if (!existing || f('text').value.trim()) a.textContent = text;

      if (!existing) {
        const r2 = activeRange(n, el);
        if (r2) { r2.deleteContents(); r2.insertNode(a); }
        else body.appendChild(a);
        if (a.parentNode) a.parentNode.insertBefore(document.createTextNode(' '), a.nextSibling);
      }
      commitBody(n, el);
      close();
      body.focus();
    }
  }

  /* ---------------- создание заметок ---------------- */
  function createNote(docX, docY, fixed) {
    const ds = settings.defaultStyle;
    const n = {
      id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      scope: settings.defaultScope || 'page',
      x: Math.round(docX), y: Math.round(docY),
      w: 240, h: null,
      fixed: !!fixed,
      collapsed: false,
      html: '',
      bg: ds.bg, color: ds.color, fontFamily: ds.fontFamily, fontSize: ds.fontSize,
      z: ++zTop,
      anchor: null,
      createdAt: Date.now(), updatedAt: Date.now()
    };
    if (!fixed) n.anchor = computeAnchor(n.x, n.y);
    notes.push(n);
    const el = renderNote(n);
    // новая заметка сразу встраивается в поток: текст раздвигается под неё
    if (!fixed) dropIntoPage(n, el, n.x - off.x, n.y - off.y);
    setEditing(n, el, true, true);
    scheduleSave();
    return n;
  }

  async function addNote(at) {
    if (!visible()) {
      // пользователь явно создаёт заметку — включаем отображение
      settings.enabled = true;
      settings.disabledSites = (settings.disabledSites || []).filter(h => h !== location.hostname);
      await saveSettings();
      renderAll();
      toast('Показ заметок включён');
    }
    ensureHost();
    measureOffset();
    let x, y;
    if (at && typeof at.x === 'number') { x = at.x; y = at.y; }
    else if (at === 'menu' && lastPoint) { x = lastPoint.x; y = lastPoint.y; }
    else {
      x = window.scrollX + Math.max(20, window.innerWidth / 2 - 130);
      y = window.scrollY + Math.max(20, window.innerHeight / 3);
    }
    // если в этой точке уже есть заметка — немного сдвигаем новую
    while (notes.some(n => !n.fixed && Math.abs(n.x - x) < 12 && Math.abs(n.y - y) < 12)) { x += 22; y += 22; }
    return createNote(x, y, false);
  }

  /* ---------------- заметки не должны закрывать всплывающие окна сайта ----------------
     Проверяем, что реально нарисовано под заметкой: если верхний элемент страницы
     в этой точке принадлежит плавающему слою (fixed/sticky, absolute с z-index,
     dialog, role=dialog и т. п.), заметка прячется, пока этот слой открыт. */
  const OVERLAY_SEL = 'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
  const OVERLAY_NAME = /popup|modal|lightbox|tooltip|overlay|dropdown|flyout|drawer/i;

  /* anchorEl — элемент, к которому привязана заметка. Контейнер, внутри которого
     он лежит, оверлеем не считается: так постоянные fixed-колонки вёрстки (например,
     панель примечаний на wol.jw.org) не прячут заметки, поставленные внутри них. */
  function isOverlayEl(el, anchorEl) {
    for (let cur = el, guard = 0; cur && cur.nodeType === 1 && guard < 12; cur = cur.parentElement, guard++) {
      if (cur === host || cur === document.body || cur === document.documentElement) return false;
      let cs = null;
      try { cs = getComputedStyle(cur); } catch (e) { return false; }
      const cls = typeof cur.className === 'string' ? cur.className : '';
      const z = parseInt(cs.zIndex, 10);
      let floating = false;
      try { floating = cur.matches(OVERLAY_SEL); } catch (e) {}
      if (!floating) {
        floating = cs.position === 'fixed' || cs.position === 'sticky' ||
                   (cs.position === 'absolute' && !isNaN(z) && z >= 1) ||
                   (OVERLAY_NAME.test(cls) && cs.position !== 'static');
      }
      if (floating) return !(anchorEl && cur.contains(anchorEl));
    }
    return false;
  }

  function anchorElementOf(n) {
    if (!n.anchor || !n.anchor.sel) return null;
    try { return document.querySelector(n.anchor.sel); } catch (e) { return null; }
  }

  function isCovered(el, anchorEl) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const pts = [
      [r.left + r.width / 2, r.top + Math.min(12, r.height / 2)],
      [r.left + 3, r.top + 3],
      [r.right - 3, r.top + 3],
      [r.left + r.width / 2, r.bottom - 3]
    ];
    for (const [x, y] of pts) {
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
      let stack = [];
      try { stack = document.elementsFromPoint(x, y) || []; } catch (e) { return false; }
      const top = stack.find(e => e && e !== host && e.id !== 'note-in-site-root');
      if (top && isOverlayEl(top, anchorEl)) return true;
    }
    return false;
  }

  function updateOcclusion() {
    if (!host || !host.isConnected || !visible()) return;
    for (const n of notes) {
      const el = els.get(n.id);
      if (!el) continue;
      // то, что сейчас правят или тащат, не прячем — иначе пропадёт из-под рук
      if (el.classList.contains('tools') || el.classList.contains('dragging')) {
        el.classList.remove('nis-covered');
        continue;
      }
      el.classList.toggle('nis-covered', isCovered(el, anchorElementOf(n)));
    }
  }

  let occTimer = null;
  function scheduleOcclusion(delay) {
    clearTimeout(occTimer);
    occTimer = setTimeout(updateOcclusion, delay || 120);
  }

  /* ---------------- вспомогательное ---------------- */
  /* kind === 'error' — сообщение о несохранённых данных: само не исчезает,
     потому что за 2,7 секунды его можно не заметить, а речь о потере заметки.
     Убирается кликом или следующей удачной записью. */
  function toast(text, kind) {
    ensureHost();
    const t = document.createElement('div');
    t.className = kind === 'error' ? 'nis-toast nis-toast-err' : 'nis-toast';
    t.textContent = text;
    shadow.appendChild(t);
    if (kind === 'error') {
      t.title = 'Нажмите, чтобы скрыть';
      t.addEventListener('click', () => { t.remove(); if (failToast === t) failToast = null; });
    } else {
      setTimeout(() => t.remove(), 2700);
    }
    return t;
  }

  /* собственное подтверждение: window.confirm сайт может переопределить */
  function askConfirm(title, text) {
    ensureHost();
    return new Promise(resolve => {
      const dlg = document.createElement('div');
      dlg.className = 'nis-modal';
      const box = document.createElement('div');
      box.className = 'nis-modal-box';
      const h = document.createElement('div');
      h.className = 'nis-modal-title';
      h.textContent = title;
      const p = document.createElement('div');
      p.className = 'nis-confirm-text';
      p.textContent = text || '';
      const actions = document.createElement('div');
      actions.className = 'nis-modal-actions';
      const no = document.createElement('button');
      no.className = 'nis-b2';
      no.textContent = 'Отмена';
      const yes = document.createElement('button');
      yes.className = 'nis-b2 nis-primary';
      yes.textContent = 'Удалить';
      actions.append(no, yes);
      box.append(h, p, actions);
      dlg.appendChild(box);
      shadow.appendChild(dlg);
      const done = v => { dlg.remove(); resolve(v); };
      no.addEventListener('click', () => done(false));
      yes.addEventListener('click', () => done(true));
      dlg.addEventListener('click', e => { if (e.target === dlg) done(false); });
      dlg.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Escape') done(false);
        if (e.key === 'Enter') done(true);
      });
      setTimeout(() => yes.focus(), 0);
    });
  }

  function focusNote(id) {
    const n = notes.find(x => x.id === id);
    const el = els.get(id);
    if (!n || !el) return false;
    if (!n.fixed) {
      const p = resolvePos(n);
      window.scrollTo({ top: Math.max(0, p.y - window.innerHeight / 3), behavior: 'smooth' });
    }
    bringToFront(n, el);
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1400);
    return true;
  }

  /* ---------------- события страницы ---------------- */
  document.addEventListener('contextmenu', e => {
    lastPoint = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY };
  }, true);

  /* Alt + двойной клик — быстрая заметка в этом месте.
     На ссылках до dblclick дело не доходило: первый же клик уводил на другую
     страницу (а Alt+клик в Chrome ещё и начинает скачивание файла по ссылке).
     Поэтому клики с зажатым Alt гасим в фазе перехвата — до обработчиков сайта:
     сочетание целиком наше, и на карточках-ссылках (OLX и подобные) заметка
     теперь ставится. */
  const altOurs = e => e.altKey && !e.ctrlKey && !e.metaKey &&
                       !(e.target && e.target.id === 'note-in-site-root');

  ['mousedown', 'mouseup', 'click', 'auxclick'].forEach(type => {
    document.addEventListener(type, e => {
      if (!altOurs(e)) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  });

  document.addEventListener('dblclick', e => {
    if (!altOurs(e)) return;
    e.preventDefault();
    e.stopPropagation();
    addNote({ x: e.clientX + window.scrollX, y: e.clientY + window.scrollY });
  }, true);

  /* Карандаша, который закрывал правку, больше нет, поэтому выходим из неё
     по клику мимо заметки (и по Esc — он обрабатывается в самой заметке).
     composedPath нужен, чтобы отличить клик внутри заметки: на уровне документа
     цель у таких событий подменяется на хост нашего слоя. */
  document.addEventListener('pointerdown', e => {
    if (!anyEditing()) return;
    const path = e.composedPath ? e.composedPath() : [];
    const inPanel = path.some(t => t && t.classList &&
      (t.classList.contains('nis-emoji') || t.classList.contains('nis-modal')));
    if (inPanel) return;
    if (!path.some(t => t && t.classList && t.classList.contains('nis-emoji'))) closeEmoji();
    for (const n of notes.slice()) {
      const el = els.get(n.id);
      if (el && isEditing(el) && !path.includes(el)) setEditing(n, el, false);
    }
  }, true);

  // клик по странице часто и открывает всплывающее окно сайта
  document.addEventListener('click', () => { scheduleOcclusion(120); setTimeout(updateOcclusion, 450); }, true);
  window.addEventListener('scroll', () => scheduleOcclusion(120), true);
  if (window.MutationObserver) {
    new MutationObserver(() => scheduleOcclusion(150)).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'open', 'aria-modal', 'aria-hidden']
    });
  }

  let rsTimer = null;
  window.addEventListener('resize', () => {
    repositionAll();                      // сразу, чтобы заметки не отставали от перевёрстки
    clearTimeout(rsTimer);
    rsTimer = setTimeout(repositionAll, 150);   // и ещё раз, когда вёрстка устаканилась
  });
  window.addEventListener('load', () => setTimeout(repositionAll, 300));

  // вкладку закрывают или уводят в фон — дописываем то, что ещё не успело уйти в хранилище
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

  // страница может дорисовываться (картинки, ленивая подгрузка) — держим заметки на своих местах
  if (window.ResizeObserver && document.body) {
    new ResizeObserver(() => { clearTimeout(rsTimer); rsTimer = setTimeout(repositionAll, 200); })
      .observe(document.body);
  }

  let lastScroll = -1;
  setInterval(() => {
    if (location.href !== curHref) {          // переход внутри SPA
      curHref = location.href;
      reload();
      return;
    }
    if (visible() && (!host || !host.isConnected)) {
      host = null;                            // страница снесла наш слой — восстанавливаем
      renderAll();
      return;
    }
    // вёрстка сайта могла перерисоваться и выбросить наши распорки — возвращаем
    if (visible() && notes.some(n => n.flow && !n.fixed && !spacerOf(n))) {
      repositionAll();
      return;
    }
    // подстраховка: некоторые страницы (и фоновые вкладки) не шлют события прокрутки
    const y = window.scrollY + window.scrollX;
    const anyCovered = Array.from(els.values()).some(el => el.classList.contains('nis-covered'));
    if (y !== lastScroll || anyCovered) {
      lastScroll = y;
      updateOcclusion();
    }
  }, 800);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const mine = myKeys();
    const touched = Object.keys(changes).filter(k => mine.includes(k));
    if (!touched.length) return;
    if (touched.every(k => wroteThis(k, changes[k].newValue))) return;   // это наша же запись
    external();
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    switch (msg.type) {
      case 'nis:ping':
        sendResponse({ ok: true, host: location.hostname, count: notes.length, visible: visible() });
        return false;

      case 'nis:add':
        addNote(msg.at);
        sendResponse({ ok: true });
        return false;

      case 'nis:list':
        sendResponse({
          ok: true,
          visible: visible(),
          enabled: settings.enabled !== false,
          siteEnabled: !siteDisabled(),
          hostname: location.hostname,
          notes: notes.map(n => ({
            id: n.id, scope: n.scope || 'page', fixed: !!n.fixed,
            text: previewText(n) || '(пустая заметка)', bg: n.bg, updatedAt: n.updatedAt
          }))
        });
        return false;

      case 'nis:focus':
        sendResponse({ ok: focusNote(msg.id) });
        return false;

      case 'nis:delete':
        removeNote(msg.id);
        sendResponse({ ok: true });
        return false;

      case 'nis:toggle':
        (async () => {
          if (msg.scope === 'site') {
            const list = new Set(settings.disabledSites || []);
            if (list.has(location.hostname)) list.delete(location.hostname);
            else list.add(location.hostname);
            settings.disabledSites = Array.from(list);
          } else {
            settings.enabled = settings.enabled === false;
          }
          await saveSettings();
          renderAll();
          toast(visible() ? 'Заметки показаны' : 'Заметки скрыты');
          sendResponse({ ok: true, visible: visible() });
        })();
        return true;

      case 'nis:reload':
        reload().then(() => sendResponse({ ok: true }));
        return true;
    }
    return false;
  });

  /* ---------------- старт ---------------- */
  (async function init() {
    await loadAll();
    ensureHost();
    renderAll();
    setTimeout(repositionAll, 600);
    setTimeout(repositionAll, 1800);
  })();
})();
