/* NoteInSite — очистка HTML заметок.
   Содержимое заметок хранится как HTML и вставляется обратно в страницу,
   поэтому перед сохранением всё, кроме безопасного набора тегов и стилей, удаляется. */
var NIS_SANITIZE = (function () {
  const ALLOWED_TAGS = new Set([
    'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SUB', 'SUP', 'BR', 'P', 'DIV', 'SPAN',
    'A', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'CODE', 'PRE', 'BLOCKQUOTE', 'FONT', 'HR'
  ]);
  const ALLOWED_STYLE = new Set([
    'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style',
    'text-decoration', 'text-decoration-line', 'text-align', 'line-height', 'letter-spacing'
  ]);
  const SAFE_URL = /^(https?:|mailto:|tel:)/i;

  function cleanStyle(style) {
    const out = [];
    for (const decl of String(style).split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim().toLowerCase();
      const val = decl.slice(i + 1).trim();
      if (!ALLOWED_STYLE.has(prop)) continue;
      if (/url\s*\(|expression|javascript:|@import/i.test(val)) continue;
      if (!val || val.length > 120) continue;
      out.push(prop + ': ' + val);
    }
    return out.join('; ');
  }

  function walk(node) {
    const kids = Array.from(node.childNodes);
    for (const child of kids) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue; }

      if (!ALLOWED_TAGS.has(child.tagName)) {
        // тег не разрешён — сохраняем его содержимое, убираем обёртку
        const frag = child.ownerDocument.createDocumentFragment();
        while (child.firstChild) frag.appendChild(child.firstChild);
        child.replaceWith(frag);
        walk(node);
        return;
      }

      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        if (name === 'style') {
          const st = cleanStyle(attr.value);
          if (st) child.setAttribute('style', st); else child.removeAttribute('style');
        } else if (child.tagName === 'A' && name === 'href') {
          if (!SAFE_URL.test(attr.value.trim())) child.removeAttribute('href');
        } else if (child.tagName === 'A' &&
                   (name === 'data-nis-popup' || name === 'data-nis-w' || name === 'data-nis-h' || name === 'title')) {
          /* оставляем */
        } else if (child.tagName === 'FONT' && (name === 'color' || name === 'face' || name === 'size')) {
          /* оставляем */
        } else {
          child.removeAttribute(attr.name);
        }
      }
      if (child.tagName === 'A') {
        if (!child.getAttribute('href')) {
          const frag = child.ownerDocument.createDocumentFragment();
          while (child.firstChild) frag.appendChild(child.firstChild);
          child.replaceWith(frag);
          continue;
        }
        child.setAttribute('rel', 'noopener noreferrer');
      }
      walk(child);
    }
  }

  return function sanitize(html) {
    const doc = new DOMParser().parseFromString(
      '<!doctype html><body>' + String(html == null ? '' : html), 'text/html');
    walk(doc.body);
    return doc.body.innerHTML;
  };
})();
