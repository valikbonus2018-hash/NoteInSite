/* NoteInSite — сайт расширения. Небольшие улучшения интерфейса, без зависимостей. */
(function () {
  'use strict';

  // Мобильное меню
  var burger = document.querySelector('.burger');
  var links = document.querySelector('.nav-links');
  if (burger && links) {
    burger.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      if (!links.classList.contains('open')) return;
      if (links.contains(e.target) || burger.contains(e.target)) return;
      links.classList.remove('open');
      burger.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        links.classList.remove('open');
        burger.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Текущий год в подвале
  Array.prototype.forEach.call(document.querySelectorAll('[data-year]'), function (el) {
    el.textContent = String(new Date().getFullYear());
  });

  // Почта собирается на лету — чтобы её не собирали спам-роботы из исходника
  Array.prototype.forEach.call(document.querySelectorAll('[data-mail]'), function (el) {
    var user = el.getAttribute('data-mail');
    var host = el.getAttribute('data-host');
    if (!user || !host) return;
    var addr = user + '@' + host;
    if (el.tagName === 'A') {
      el.setAttribute('href', 'mailto:' + addr + (el.getAttribute('data-subject')
        ? '?subject=' + encodeURIComponent(el.getAttribute('data-subject')) : ''));
    }
    if (!el.getAttribute('data-keep-text')) el.textContent = addr;
  });

  // Плавное появление блоков
  var revealables = document.querySelectorAll('.reveal');
  if (revealables.length && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    Array.prototype.forEach.call(revealables, function (el) { io.observe(el); });
  } else {
    Array.prototype.forEach.call(revealables, function (el) { el.classList.add('in'); });
  }
})();
