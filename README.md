# НутриКод

Анонимный веб-чат с ИИ-нутрициологом. Без регистрации и без сбора имени. Русский интерфейс.

## Стек

- Node.js + Express
- Vanilla HTML / CSS / JS
- Google Gemini (SSE streaming); без ключа — демо-стрим для превью UI

## Быстрый старт

```bash
npm install
cp .env.example .env
# при желании: впишите GEMINI_API_KEY в .env
npm start
```

Откройте [http://127.0.0.1:3000](http://127.0.0.1:3000).

Без `GEMINI_API_KEY` чат отвечает mock-стримом — удобно смотреть дизайн.

### Обновить уже скачанную копию

Простыми шагами (если сайт уже лежит у вас на компьютере):

1. Откройте папку проекта (например `C:\Users\alexandr\nutrikod`).
2. Откройте терминал в этой папке.
3. Скачайте обновления:

```bash
git pull
```

4. Если попросит зависимости — один раз:

```bash
npm install
```

5. Запустите снова:

```bash
npm start
```

6. В браузере откройте [http://127.0.0.1:3000](http://127.0.0.1:3000) и обновите страницу.

Ключ `GEMINI_API_KEY` в `.env` менять не нужно.

После обновления:
- под чатом — тихие режимы **Обычный / Детский стол / Нет времени / Список покупок**;
- история диалога сохраняется **только в браузере** (без аккаунта); кнопка **Очистить чат** сверху;
- в подвале ссылка **О данных и границах** → страница `/privacy.html` (что уходит в Gemini, без аккаунтов, не врач).

По умолчанию сайт берёт быстрые модели: `gemini-3.5-flash-lite` → при перегрузке `gemini-3.6-flash`. Если в `.env` ещё стоит старое `GEMINI_MODEL=gemini-3.8-flash` или `gemini-2.0-flash` — либо удалите строку (подставится lite), либо оставьте 3.8 осознанно (она опциональна и при нагрузке Google может ждать дольше).

Если ответы обрывались на полуслове, убедитесь что нет `GEMINI_MAX_OUTPUT_TOKENS=1024` (или поставьте `8192`).

При ошибке **503 / UNAVAILABLE** сервер сам повторяет запрос с паузой, затем пробует запасную модель. В чате — спокойное сообщение на русском, без технических кодов.

## Переменные окружения

| Переменная                   | Описание                                                                 |
|------------------------------|--------------------------------------------------------------------------|
| `GEMINI_API_KEY`             | ключ Gemini (опционально для демо)                                       |
| `GEMINI_MODEL`               | основная модель, по умолчанию `gemini-3.5-flash-lite`                    |
| `GEMINI_FALLBACK_MODELS`     | запасные модели через запятую (по умолчанию `gemini-3.6-flash`)          |
| `GEMINI_MODEL_CHAIN`         | полная цепочка моделей через запятую (если задана — перекрывает два поля выше) |
| `GEMINI_OVERLOAD_RETRIES`    | повторы на каждую модель при 503, по умолчанию `2`                       |
| `GEMINI_OVERLOAD_BACKOFF_MS` | стартовая пауза перед повтором (мс), по умолчанию `800`                  |
| `GEMINI_MAX_OUTPUT_TOKENS`   | длина ответа, по умолчанию `8192`                                        |
| `PORT`                       | порт, по умолчанию `3000`                                                |
| `COMMUNITY_VK_URL`           | ссылка на сообщество ВК в футере                                         |
| `ADMITAD_VKUSVILL_BASE`      | Admitad webmaster base для `ulp=` (kdbov…, не email-лендинг vkusvill.ru) |
| `ADMITAD_VKUSVILL_ERID`      | erid для дисклеймера «Реклама…» у блока корзины VV                       |
| `ADMITAD_VIPFISH_BASE`       | Admitad webmaster base Важной рыбы (dorinebeaumont…, не vipfish.ru)      |
| `ADMITAD_VIPFISH_ERID`       | erid для дисклеймера у блока ссылок Важной рыбы                          |
| `ADMITAD_BEFIT_BASE`         | Admitad webmaster base BeFit (uuwgc…, не letbefit.ru)                    |
| `ADMITAD_BEFIT_ERID`         | erid для дисклеймера у блока ссылок BeFit                                |
| `ADMITAD_HVALWATERS_BASE`    | Admitad webmaster base Хваловской воды (xmknb… без i=3, не hvalwaters.ru)|
| `ADMITAD_HVALWATERS_ERID`    | erid для дисклеймера у блока ссылок Хваловской воды                      |
| `ADMITAD_GROWFOOD_BASE`      | Admitad webmaster base GrowFood (naiawork…, не growfood.pro / gf.ru)     |
| `ADMITAD_GROWFOOD_ERID`      | erid для дисклеймера у блока ссылок GrowFood                             |

`gemini-3.8-flash` — опционально через `GEMINI_MODEL` или `GEMINI_MODEL_CHAIN` (см. `.env.example`).

### Автодиплинк ВкусВилл, Важная рыба, BeFit, Хваловская вода и GrowFood

Модель помечает товары метками (без сырых Admitad URL). Клиент (`renderProductDeeplinks`) снимает `[[…]]` из текста (оставляет обычные названия) и собирает блок «Собрать корзину» / «Полезные ссылки» под ответом:

1. целевой URL на витрине (поиск или страница товара/программы);
2. Admitad webmaster base + `&ulp=` + `encodeURIComponent(targetUrl)`.

| Метка | Target (проверено) | Admitad base |
|-------|--------------------|--------------|
| `[[авокадо]]` | `https://vkusvill.ru/search/?q=` | `ADMITAD_VKUSVILL_BASE` (kdbov…) |
| `[[vipfish:лосось]]` / `[[ryba:лосось]]` | `https://vipfish.ru/search/?q=` | `ADMITAD_VIPFISH_BASE` (dorinebeaumont…) |
| `[[befit:keto-start]]` / `[[letbefit:superstrongpremium]]` | `/programmy/{slug}/` или WP `https://letbefit.ru/?s=` (`/search/?q=` → 404) | `ADMITAD_BEFIT_BASE` (uuwgc…) |
| `[[hval:premium]]` / `[[water:premium]]` / `[[hvalwaters:premium]]` | `/water/{slug}/` или WP `https://hvalwaters.ru/?s=` (`/search/?q=` → 404) | `ADMITAD_HVALWATERS_BASE` (xmknb…, prefer без i=3) |
| `[[growfood:super-fit]]` / `[[gf:daily]]` | `/new-order/{slug}` или каталог `https://growfood.pro/#menu-plans` (поиска нет) | `ADMITAD_GROWFOOD_BASE` (naiawork…) |

База берётся из env → `partners.json` (`admitad_base` / Admitad-`link`) → дефолт в коде. URL вида `vkusvill.ru/?utm_…`, `vipfish.ru/…`, `letbefit.ru/…`, `hvalwaters.ru/…` или `growfood.pro/…` (merchant-лендинг) **не** считаются базой. Промокод VV `VSC7247`, BeFit shortlist (`promos` + `promo_code=ADMBF2026`) и GrowFood shortlist (`ДВОЙНОЙБОНУС` / `БИГБОНУС`) — для плашки/`/api/config`, не для ulp. Coupon-ish Hvalwaters (`admitad_coupon_base`, i=3) — справочно, чипы используют base без i=3.

Важная рыба — soft-geo: только города из баннера зон (СПб, Мурино, Бугры, Пушкин, Петергоф, Всеволожск, Кудрово, Шушары, Сестрорецк). BeFit, GrowFood и Хваловская вода — soft-geo Москва и Санкт-Петербург. В одном ответе не мешать VV / рыбу / BeFit / GrowFood / Хваловскую (готовая еда — один бренд). Магнит/Лавка/Perfluence — не подключены.

## Структура

```
package.json
.env.example
partners.json      # заготовки партнёров (live:false = не показывать)
prompt.txt         # системный промпт
server.js
public/
  index.html
  privacy.html     # короткая страница «О данных и границах»
  history-store.js # localStorage история (без сервера)
  script.js
  style.css
README.md
```

## Партнёры и промо

В `partners.json` — три демо-заготовки. У всех `"live": false` и ссылки на `example.com`, поэтому в чат они **не** подмешиваются.

Чтобы вставить реального партнёра позже:

1. Откройте `partners.json`.
2. Замените `link` на настоящий `https://…` URL (affiliate / лендинг).
3. При желании задайте `promo_code` (строка) и `offer_type` (`meal_plan` или `promo`).
4. Поставьте `"live": true` только для проверенной записи.
5. Сохраните файл и перезапустите: `npm start`.

Правила вставки: сервер даёт **0–1** оффер только при намерении («готовое», «заказать», «нет времени готовить»), не в первом ответе, не чаще одного раза за диалог (клиент шлёт `allowPartner`). Без живых партнёров ссылки не выдумываются. Демо-хосты `example.com` никогда не показываются как живые.

## Поведение

- Приветствие и первый вопрос о рационе / аллергиях / цели
- Тихие режимы-надстройки под чатом: Обычный / Детский стол / Нет времени / Список покупок — один бот, сервер кратко подмешивает акцент в системный контекст; явный выбор важнее авто-угадывания по словам
- История чата только в `localStorage` браузера: восстанавливается после перезагрузки, очищается кнопкой «Очистить чат»; аккаунтов нет, на сервере диалоги не хранятся
- Стриминг ответа (SSE): сначала спокойные статусы («Думает…» → «Печатает…»), потом текст по словам
- Тихий блок партнёра под ответом ассистента — только по сигналу сервера, вне медицинского совета
- Метки `[[продукт]]` → ВкусВилл; `[[vipfish:…]]` / `[[ryba:…]]` → Важная рыба; `[[befit:…]]` / `[[letbefit:…]]` → BeFit; `[[growfood:…]]` / `[[gf:…]]` → GrowFood; `[[hval:…]]` / `[[water:…]]` / `[[hvalwaters:…]]` → Хваловская вода: в тексте — имена без скобок, чипы в блоке под ответом; одна промо-плашка (если есть) внутри/под блоком; серый дисклеймер «Реклама…» + erid (и юрлицо из `partners.json`), если есть хотя бы одна ссылка
- Анонимные 👍/👎 в `localStorage`
- В подвале — короткий дисклеймер и ссылка на `/privacy.html` (Gemini, история в браузере, без аккаунтов, не врач)
- В чате и ответах Gemini нет доната / «поддержки» / кнопок оплаты

## Важно

Сервис информационный, не медицинская услуга. Детский рацион — про баланс еды, не про лечение.
