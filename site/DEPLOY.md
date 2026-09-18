# Сайт NoteInSite — размещение

Исходники сайта лежат в этой папке. Это статические страницы: ни сборки, ни PHP.

## Где сейчас

Сайт работает по адресу <http://noteinsite.atmos.ho.ua/> (поддомен создан 17.09.2026).
Файлы лежат по FTP на аккаунте `atmos` хостинга ho.ua в папке `htdocs/noteinsite/`;
корень `htdocs/` занят другим сайтом (bible.atmos.ho.ua), его файлы не затрагивались.
Старый адрес <http://atmos.ho.ua/noteinsite/> тоже продолжает работать.

Поддомен ведёт в общий `htdocs/`, поэтому нужную папку подставляет правило в корневом
`htdocs/.htaccess`. Адрес в браузере при этом не меняется, а запрос вида `/noteinsite/…`
на поддомене отдаёт 301 на чистый адрес.

## Правило в корневом htdocs/.htaccess

Добавлено 17.09.2026 в конец файла. Исходная копия — `server-backup/htaccess-root-2026-09-17.bak`.

```apache
<IfModule mod_rewrite.c>
  RewriteEngine On

  RewriteCond %{HTTP_HOST} ^(www\.)?noteinsite\.atmos\.ho\.ua$ [NC]
  RewriteCond %{THE_REQUEST} \s/+noteinsite/ [NC]
  RewriteRule ^noteinsite/(.*)$ /$1 [R=301,L]

  RewriteCond %{HTTP_HOST} ^(www\.)?noteinsite\.atmos\.ho\.ua$ [NC]
  RewriteCond %{REQUEST_URI} !^/noteinsite/
  RewriteRule ^(.*)$ /noteinsite/$1 [L]
</IfModule>
```

Условие по `HTTP_HOST` ограничивает оба правила одним именем хоста, поэтому на
`atmos.ho.ua`, `www.atmos.ho.ua` и `bible.atmos.ho.ua` они не влияют — проверено после
загрузки. Условие по `THE_REQUEST` смотрит на исходный запрос браузера, поэтому
внутренняя подстановка не зацикливает 301.

Откат — залить сохранённую копию:

```bash
curl -T server-backup/htaccess-root-2026-09-17.bak "ftp://ЛОГИН:ПАРОЛЬ@atmos.ho.ua/htdocs/.htaccess"
```

Если поддомену когда-нибудь зададут собственный корень `htdocs/noteinsite`, правило
перестанет использоваться, а в `.htaccess` этой папки нужно будет заменить
`ErrorDocument 404 /noteinsite/404.html` на `ErrorDocument 404 /404.html`.

## HTTPS

Сертификат Let's Encrypt на аккаунте выписан на `atmos.ho.ua`, `www.atmos.ho.ua`
и `bible.atmos.ho.ua` (выдан 13.09.2026, действует до 12.12.2026). Нового поддомена
в нём нет, поэтому `https://noteinsite.atmos.ho.ua/` открывается с предупреждением
браузера. Сайт работает по `http://`, и `canonical`, Open Graph, `robots.txt`
и `sitemap.xml` пока указывают именно `http://` — чтобы не отправлять поисковики
на адрес с ошибкой сертификата.

Самостоятельно перевыпустить сертификат нельзя: раздела SSL в панели нет,
а по FAQ ho.ua сертификаты выдаются «за окремим запитом в службу підтримки».
Заявка через форму https://www.ho.ua/uk/contact/ 17.09.2026 отклонена ответом
«Техпідтримка безкоштовних хостингів не проводиться» — на бесплатном тарифе
поддержка не отвечает.

Варианты: дождаться планового перевыпуска сертификата (он охватывает домены аккаунта,
ближайшее продление — за месяц до 12.12.2026), спросить на форуме ho.ua либо перейти
на платный тариф, где поддержка принимает заявки. Когда поддомен попадёт в сертификат,
вернуть `https://` одной заменой по файлам `*.html`, `robots.txt`, `sitemap.xml`
и залить их заново; заодно можно добавить в `.htaccess` папки редирект с http на https.

Проверить состав сертификата:

```bash
echo | openssl s_client -connect 91.228.146.11:443 -servername noteinsite.atmos.ho.ua 2>/dev/null | openssl x509 -noout -dates -ext subjectAltName
```

## Повторная загрузка

Из папки `site/` (curl входит в состав Windows 10/11):

```bash
for f in $(find . -type f | sed 's|^\./||'); do curl --ftp-create-dirs -T "$f" "ftp://ЛОГИН:ПАРОЛЬ@atmos.ho.ua/htdocs/noteinsite/$f"; done
```

Логин и пароль — в `D:\_PROJECT\Chronos\data.txt`. Файлы `DEPLOY.md` и папка
`server-backup/` на сервер не заливаются.

## Что где лежит

| Файл | Назначение |
| --- | --- |
| `index.html` | Главная: описание, скриншоты, быстрый старт, FAQ |
| `features.html` | Подробный разбор возможностей |
| `install.html` | Установка из магазина и вручную, разрешения |
| `help.html` | Справка, таблица действий, решение проблем |
| `privacy.html` | Политика конфиденциальности (ссылку указывать в Chrome Web Store) |
| `terms.html` | Условия использования |
| `support.html` | Контакты и что приложить к сообщению об ошибке |
| `changelog.html` | История версий |
| `404.html` | Страница ошибки, со своими стилями внутри файла |
| `robots.txt`, `sitemap.xml` | Для поисковых систем |
| `download/` | Архив расширения для установки вручную |
| `assets/` | CSS, JS, изображения |

## Картинки

Скриншоты сняты в двойном разрешении и показываются вдвое меньше своего размера —
иначе на экранах с высокой плотностью пикселей они выглядят мыльными. Снимаются
headless-браузером со страниц из папки `test/`:

```bash
python -m http.server 8779
```

```bash
"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=1077,790 --virtual-time-budget=4000 --screenshot=out.png http://localhost:8779/test/shot.html
```

* `test/shot.html` — страница с заметками, вплетёнными в текст;
* `test/shot.html?edit=demo2` — та же страница с открытой панелью правки;
* `test/shot.html?drag=demo1&to=395,648` — заметку тащат: видны рамка блока, полоса
  строки вставки и пунктир будущего места (`to` — точка, где «держат» заметку,
  в координатах окна: подбирается под размер кадра);
* `test/shot-popup.html` — окно расширения;
* `test/promo.html` — плашка 440×280 для витрины и `og:image` (снимается
  с `--window-size=440,280 --force-device-scale-factor=1`).

Кадр сохраняется в двух форматах: `.webp` (его берут все современные браузеры) и `.png`
как запасной. В разметке они связаны через `<picture>`, а атрибуты `width`/`height`
у `<img>` равны половине пикселей файла — именно это и даёт чёткость. Текущие размеры:
`shot-notes`, `shot-drop` и `shot-editing` — 2154×1580 (показываются как 1077×790),
`shot-popup` — 748×1139 (374×569), `og-cover` — 440×280.

Те же страницы снимаются для карточки в Chrome Web Store, но в размере 1280×800
и с `--force-device-scale-factor=1`: `store/screenshots/01-notes.png`, `02-editing.png`,
`03-popup.png`, `04-drop.png`.

## Кэш

CSS и JS подключаются с версией в адресе: `style.css?v=2`, `main.js?v=2`. Заголовок
`Cache-Control` держит их в кэше неделю, поэтому после правки оформления номер версии
нужно поднять во всех страницах, иначе у тех, кто уже заходил, останется старый файл.
Заменить `?v=2` на `?v=3` во всех `*.html` и залить страницы заново.

## При выпуске новой версии расширения

1. Положить новый архив в `download/` и поправить ссылки и размер в `index.html` и `install.html`.
2. Добавить раздел в `changelog.html`.
3. Обновить `<lastmod>` в `sitemap.xml`.
4. Когда расширение появится в Chrome Web Store — заменить в `install.html` кнопку
   «Скоро в Chrome Web Store» на ссылку карточки.
