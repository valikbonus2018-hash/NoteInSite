/* NoteInSite — стили, изолированные внутри Shadow DOM */
var NIS_CSS = `
:host {
  all: initial;
  position: absolute !important;
  top: 0 !important;
  left: 0 !important;
  width: 0 !important;
  height: 0 !important;
  overflow: visible !important;
  z-index: 2147483600 !important;
  contain: none !important;
}
* { box-sizing: border-box; }

.nis-layer { position: absolute; top: 0; left: 0; width: 0; height: 0; }

/* ---- заметка: простое текстовое поле ---- */
.nis-note {
  position: absolute;
  min-width: 120px;
  display: flex;
  flex-direction: column;
  border-radius: 8px;
  box-shadow: 0 3px 12px rgba(0,0,0,.18), 0 0 0 1px rgba(0,0,0,.08);
  background: #fff59d;
  color: #20242e;
  font: 15px/1.45 system-ui, "Segoe UI", Arial, sans-serif;
  overflow: hidden;
  pointer-events: auto;
}
/* в режиме просмотра заметка перетаскивается за любое место.
   touch-action: none — иначе на тачскрине браузер через пару пикселей забирает
   жест себе (прокрутка) и обрывает перетаскивание; user-select/callout — чтобы
   долгое нажатие не превращалось в выделение текста и системное меню */
.nis-note:not(.tools) {
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.nis-note.tools { touch-action: auto; }
.nis-note.tools .nis-body { user-select: text; -webkit-user-select: text; touch-action: pan-y; }
.nis-grip, .nis-grow { touch-action: none; }
.nis-note.dragging { box-shadow: 0 12px 30px rgba(0,0,0,.32); opacity: .9; cursor: grabbing; }
.nis-note.flash { outline: 3px solid #2f6fed; outline-offset: 2px; }
/* заметка спрятана, потому что её перекрыло всплывающее окно самого сайта */
.nis-note.nis-covered { visibility: hidden !important; pointer-events: none !important; }

/* строка поля: текст + кнопка-карандаш в конце */
.nis-field { display: flex; align-items: flex-start; flex: 1 1 auto; min-height: 0; }
.nis-body {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 1.5em;
  padding: 6px 10px 7px 10px;
  outline: none;
  overflow-y: auto;
  word-wrap: break-word;
  white-space: pre-wrap;
}
.nis-note.tools .nis-body { cursor: text; background: rgba(255,255,255,.28); }
.nis-note.collapsed .nis-body { height: auto !important; max-height: 1.6em; overflow: hidden; }
.nis-body:empty::before { content: attr(data-ph); opacity: .45; }
.nis-body a {
  color: #0b57d0; text-decoration: underline; cursor: pointer;
  padding: 0 1px; border-radius: 3px;
}
.nis-body a:hover { background: rgba(11,87,208,.14); }
.nis-body a[data-nis-popup="1"]::after { content: "⧉"; font-size: .8em; margin-left: 2px; opacity: .7; }
.nis-body ul, .nis-body ol { margin: 4px 0 4px 18px; padding: 0; }
.nis-body p { margin: 0 0 6px; }

/* ---- панель редактирования (по нажатию карандаша) ---- */
.nis-tools {
  display: none;
  flex-wrap: wrap; align-items: center; gap: 3px;
  padding: 4px 5px; background: rgba(0,0,0,.07);
  border-bottom: 1px solid rgba(0,0,0,.1);
  flex: 0 0 auto;
}
.nis-note.tools .nis-tools { display: flex; }
.nis-note.collapsed .nis-tools { display: none; }
.nis-sep { width: 1px; height: 15px; background: rgba(0,0,0,.15); margin: 0 2px; }

.nis-grip {
  cursor: grab; opacity: .55; font-size: 13px; letter-spacing: -2px;
  padding: 0 3px; user-select: none;
}
.nis-grip:active { cursor: grabbing; }

.nis-b {
  all: unset;
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 22px; height: 20px; padding: 0 4px;
  border-radius: 5px; cursor: pointer;
  font: 12px/1 system-ui, Arial, sans-serif; color: inherit;
  background: rgba(255,255,255,.4);
}
.nis-b:hover { background: rgba(255,255,255,.9); }
.nis-b.on { background: rgba(0,0,0,.25); color: #fff; }
.nis-b.nis-danger:hover { background: #e5484d; color: #fff; }

.nis-sel {
  all: unset; height: 20px; max-width: 92px; padding: 0 2px;
  border-radius: 5px; background: rgba(255,255,255,.75);
  font: 11px/1 system-ui, Arial, sans-serif; color: #111; cursor: pointer;
}
.nis-sel.nis-size { max-width: 46px; }
.nis-color {
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 20px; border-radius: 5px; cursor: pointer;
  background: rgba(255,255,255,.4); font-size: 12px; overflow: hidden;
}
.nis-color:hover { background: rgba(255,255,255,.9); }
.nis-color input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }

.nis-grow {
  display: none;
  position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
  cursor: nwse-resize;
  background: linear-gradient(135deg, transparent 50%, rgba(0,0,0,.28) 50%, rgba(0,0,0,.28) 60%, transparent 60%, transparent 75%, rgba(0,0,0,.28) 75%);
}
.nis-note.tools .nis-grow { display: block; }
.nis-note.collapsed .nis-grow { display: none; }

/* ---- подсказка при перетаскивании: куда встанет заметка ----
   .nis-drop-box — рамка блока вёрстки, в который заметка впишется,
   .nis-drop-ghost — курсор вставки: прямоугольник на месте будущей заметки */
.nis-drop { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; }
.nis-drop-box {
  position: absolute; z-index: 4;                 /* рамка блока — под заметками */
  border: 1px solid rgba(47,111,237,.5);
  border-radius: 6px;
  background: rgba(47,111,237,.06);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.4);
}
.nis-drop-tag {
  position: absolute; left: -1px; top: -17px;
  max-width: 260px; padding: 1px 6px;
  border-radius: 5px 5px 0 0;
  background: #2f6fed; color: #fff;
  font: 11px/1.45 system-ui, Arial, sans-serif;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.nis-drop-box.nis-inside .nis-drop-tag { top: 1px; border-radius: 5px; }   /* блок у верхнего края страницы */
/* строка вёрстки, перед которой встанет заметка */
.nis-drop-line {
  position: absolute; z-index: 2147483000;
  height: 3px; margin-top: -2px; border-radius: 2px;
  background: #2f6fed; box-shadow: 0 0 0 1px rgba(255,255,255,.55);
}
.nis-drop-ghost {
  position: absolute; z-index: 2147483000;        /* курсор вставки виден и из-под заметки */
  border: 2px dashed #2f6fed;
  border-radius: 8px;
  background: rgba(47,111,237,.12);
}
/* уголок — сам «курсор вставки»: показывает левый верхний угол заметки */
.nis-drop-ghost::before {
  content: ""; position: absolute; left: -2px; top: -2px; width: 15px; height: 15px;
  border-top: 4px solid #2f6fed; border-left: 4px solid #2f6fed;
  border-radius: 8px 0 0 0;
}

/* ---- выбор эмодзи ---- */
.nis-emoji {
  position: fixed; z-index: 2147483200;
  display: grid; grid-template-columns: repeat(8, 28px); gap: 2px;
  padding: 7px; border-radius: 10px;
  background: #fff;
  box-shadow: 0 12px 34px rgba(0,0,0,.28), 0 0 0 1px rgba(0,0,0,.1);
}
.nis-em {
  all: unset;
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 6px; cursor: pointer;
  font: 18px/1 "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", system-ui;
}
.nis-em:hover { background: rgba(47,111,237,.14); }

/* ---- модальные окна ---- */
.nis-modal {
  position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(15,18,25,.45); z-index: 2147483000;
}
.nis-modal-box {
  width: 340px; max-width: 92vw; padding: 14px 16px 12px;
  background: #fff; color: #171c26; border-radius: 12px;
  box-shadow: 0 18px 50px rgba(0,0,0,.4);
  font: 13px/1.4 system-ui, "Segoe UI", Arial, sans-serif;
}
.nis-modal-title { font-size: 15px; font-weight: 600; margin-bottom: 10px; }
.nis-modal-box label { display: block; margin-bottom: 8px; font-size: 12px; color: #4b5261; }
.nis-in {
  all: unset; display: block; width: 100%; margin-top: 3px;
  padding: 6px 8px; border: 1px solid #ccd2de; border-radius: 7px;
  font: 13px/1.3 system-ui, Arial, sans-serif; color: #171c26; background: #fff;
}
.nis-in:focus { border-color: #2f6fed; box-shadow: 0 0 0 3px rgba(47,111,237,.16); }
.nis-row { display: flex; gap: 10px; align-items: center; }
.nis-row label { flex: 1 1 auto; }
.nis-check { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 12px; color: #4b5261; }
.nis-check input { width: 14px; height: 14px; }
.nis-confirm-text {
  margin: -4px 0 10px; font-size: 13px; color: #4b5261;
  max-height: 60px; overflow: hidden;
}
.nis-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.nis-b2 {
  all: unset; padding: 6px 14px; border-radius: 7px; cursor: pointer;
  font: 13px/1 system-ui, Arial, sans-serif; background: #eceef3; color: #171c26;
}
.nis-b2:hover { background: #e0e3ea; }
.nis-b2.nis-primary { background: #2f6fed; color: #fff; }
.nis-b2.nis-primary:hover { background: #2760d4; }

/* ---- всплывающее уведомление ---- */
.nis-toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
  padding: 9px 16px; border-radius: 20px; background: rgba(20,24,33,.92); color: #fff;
  font: 13px/1 system-ui, Arial, sans-serif; z-index: 2147483100;
  animation: nis-fade 2.6s ease forwards;
}
@keyframes nis-fade { 0%,85% { opacity: 1; } 100% { opacity: 0; } }

/* Сообщение о том, что заметка не сохранилась. Не гаснет само и потому не
   анимируется; текст в несколько строк, отсюда своя высота строки и ширина. */
.nis-toast.nis-toast-err {
  max-width: min(460px, calc(100vw - 32px));
  padding: 11px 16px; border-radius: 12px; text-align: left; cursor: pointer;
  background: #8c1d18; box-shadow: 0 6px 22px rgba(20,24,33,.35);
  font: 13px/1.4 system-ui, Arial, sans-serif;
  animation: none; opacity: 1;
}
.nis-toast.nis-toast-err:hover { background: #7a1813; }
`;
