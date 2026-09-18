/* NoteInSite — service worker: контекстное меню, горячие клавиши, всплывающие окна для ссылок */

const MENU_ADD = 'nis-add-note';
const MENU_TOGGLE = 'nis-toggle';
const MENU_TOGGLE_SITE = 'nis-toggle-site';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ADD,
      title: 'Добавить заметку здесь',
      contexts: ['page', 'selection', 'image', 'link']
    });
    chrome.contextMenus.create({
      id: MENU_TOGGLE,
      title: 'Показать / скрыть все заметки',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: MENU_TOGGLE_SITE,
      title: 'Показать / скрыть заметки на этом сайте',
      contexts: ['page']
    });
  });
});

function send(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === MENU_ADD) send(tab.id, { type: 'nis:add', at: 'menu' });
  else if (info.menuItemId === MENU_TOGGLE) send(tab.id, { type: 'nis:toggle', scope: 'global' });
  else if (info.menuItemId === MENU_TOGGLE_SITE) send(tab.id, { type: 'nis:toggle', scope: 'site' });
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === 'add-note') send(tab.id, { type: 'nis:add' });
  else if (command === 'toggle-notes') send(tab.id, { type: 'nis:toggle', scope: 'global' });
});

/* Открытие ссылки из заметки во всплывающем окне */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'nis:open-link') return false;

  const url = String(msg.url || '').trim();
  if (!/^(https?:|mailto:|tel:)/i.test(url)) {
    sendResponse({ ok: false, error: 'Недопустимый адрес ссылки' });
    return false;
  }

  // mailto:/tel: нельзя показать в окне — отдаём системному обработчику во вкладке
  if (!/^https?:/i.test(url) || !msg.popup) {
    chrome.tabs.create({ url, active: true }, () => sendResponse({ ok: true }));
    return true;
  }

  const w = Math.min(3000, Math.max(200, parseInt(msg.w, 10) || 980));
  const h = Math.min(3000, Math.max(200, parseInt(msg.h, 10) || 720));

  chrome.windows.getCurrent({}, (cur) => {
    void chrome.runtime.lastError;
    let left, top;
    if (cur && typeof cur.left === 'number' && cur.width) {
      left = Math.max(0, Math.round(cur.left + (cur.width - w) / 2));
      top = Math.max(0, Math.round(cur.top + (cur.height - h) / 2));
    }
    chrome.windows.create(
      { url, type: 'popup', width: w, height: h, left, top, focused: true },
      (win) => {
        if (chrome.runtime.lastError || !win) {
          chrome.tabs.create({ url, active: true }, () => sendResponse({ ok: true }));
        } else {
          sendResponse({ ok: true, windowId: win.id });
        }
      }
    );
  });
  return true;
});
