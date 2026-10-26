# 08. M8 — Упаковка

> Этап: M8 · Оценка: 2–3 дня · Зависит от: M1–M7 · Разблокирует: M9, M10
> Владелец: writer-release

## 1. Цель и границы

**Цель.** Получить воспроизводимый релизный артефакт для Ubuntu: sidecar-бэкенд, собранный PyInstaller `--onedir`, статические `ffmpeg`/`ffprobe` и модель `faster-whisper small` внутри пакета, `.deb` и `.AppImage`, собранные electron-builder **только** в контейнере `ubuntu:22.04` (A10). Результат — критерий `../TARGET.md` §7 п.1: на чистой Ubuntu без Python и ffmpeg `.deb` устанавливается и запускается, окно открывается < 5 с, транскрипция работает без сети.

**Границы (этап не делает):**

1. Новые пользовательские функции, правки UI-логики и API — M1–M7; M8 меняет только пути ресурсов, сборочные конфиги и запуск sidecar.
2. Подпись кода (GPG/Sigstore), автообновление, публикация релизов на хостинге — вне объёма TARGET.md; `.deb` не подписывается.
3. Сборка под другие архитектуры (`aarch64`), `.rpm`, Snap/Flatpak, Windows/macOS — вне объёма.
4. Загрузка моделей/ffmpeg в рантайме — запрещена A11: всё внутри пакета, сеть в рантайме не используется.
5. Профилирование производительности и RAM-бюджета под нагрузкой — M9/M10; M8 фиксирует только время старта и работоспособность транскрипции на чистой ВМ.
6. Финальные тексты ошибок, окно «О клавишах», настройки — M9; M8 даёт минимальные диалоги запуска, M9 их локализует и причёсывает.

## 2. Предусловия

- M1–M7 завершены, `scripts/test.sh` зелёный, критерии `../TARGET.md` §7 п.2–10 прогнаны (M10 фиксирует в `docs/acceptance.md`; TARGET.md §11 требует прогон «перед M8»).
- Handshake A3 реализован: бэкенд печатает `VL_READY:{"port":n}` в stdout, читает `VL_TOKEN`, `VL_DATA_DIR`, `VL_RESOURCES_DIR`; Electron ждёт строку ≤ 15 с.
- Бэкенд умеет отдавать SPA из `frontend/dist` (A1) и брать пути к ffmpeg/модели из `VL_RESOURCES_DIR` (A11) — в dev-режиме это уже проверено.
- На машине разработчика есть Docker; dev-машина (Gentoo, Python 3.14, Node 26) **не используется** для релизной сборки (A10) — только запуск контейнера.
- В `packaging/`, `scripts/` есть заглушки из M1; каталоги `resources/ffmpeg/` и `resources/models/` в `.gitignore`; `frontend/dist` собирается Vite и монтируется бэкендом через `VL_FRONTEND_DIR` (M1).
- Версия приложения задана в `package.json` (`version`) и в `backend/app/version.py`; версии синхронизирует `make-release.sh`.

## 3. Решения

1. **Только Docker `ubuntu:22.04`** (A10). Образ `videolessons-build:22.04` ставит Python 3.11 (deadsnakes PPA), Node 20, `libgomp1`, `patchelf`, `rpm`; сборка и бэкенда, и Electron идёт внутри одного контейнера. Базовый образ фиксируется digest'ом (`ubuntu:22.04@sha256:…`) в `packaging/docker/Dockerfile.build`, чтобы glibc-базлайн 2.35 не «уплывал». Сеть нужна только на этапе сборки (pip/npm/README-загрузки), в рантайме — нет.
2. **PyInstaller `--onedir`** (TARGET.md §9 запрещает `--onefile`). Спека `packaging/backend.spec` собирает `dist/backend/` c `vl-backend` + `_internal`; `collect_all()` для `ctranslate2`, `faster_whisper`, `tokenizers`, `av`, `onnxruntime` (если пакет установлен), `collect_submodules("uvicorn")`, `datas` для `backend/app/migrations/*.sql` (иначе миграции не найдутся в рантайме). `console=True` нужен для `VL_READY` в stdout. `upx=False` — UPX ломает разделяемые библиотеки CTranslate2/OpenMP.
3. **ffmpeg/ffprobe — статические бинарники**; приоритет — **LGPL-сборка** (BtbN `linux64-lgpl`, pinned по версии и sha256, `FFMPEG_VERSION=6.0.1`), чтобы не навязывать GPL-обязательства приложению; fallback — GPL-сборка (johnvansickle) с `LICENSE.GPLv3.txt` + `SOURCE-OFFER.md`. Скачиваются `scripts/fetch-ffmpeg.sh` с проверкой sha256, попадают в `resources/ffmpeg/` и далее в `extraResources`. В пакет кладём `THIRD-PARTY-NOTICES.md` для всех бинарников; динамическая линковка системного ffmpeg исключена (на целевой ВМ его нет).
4. **Модель** `faster-whisper small` скачивается `scripts/fetch-model.sh` из `Systran/faster-whisper-small` с зафиксированной ревизией, затем **предквантуется в INT8** внутри контейнера (`ct2-transformers-converter --quantization int8`); это уменьшает пакет примерно вдвое и убирает разовую квантизацию при первом запуске. Если конвертация не удалась, скрипт оставляет float16-снапшот и пишет в `release.json` `"model_quantized": false`; рантайм всё равно работает с `compute_type="int8"` (M3).
5. **electron-builder**: `asar: true`, `asarUnpack: ["**/*.node"]`; бэкенд, `frontend/dist`, `ffmpeg` и модели — в `extraResources`, то есть вне asar (их нельзя исполнять из архива, а `extraResources` не требуют распаковки при каждом старте). Никаких нативных npm-модулей в рендерере не планируется; если появятся — объявить в `asarUnpack`.
6. **Песочница Chromium.** `../TARGET.md` §9 запрещает отключать sandbox. В `.deb` `chrome-sandbox` обязан быть `root:root` с режимом `4755` — это делает `deb.afterInstall` (`packaging/linux/after-install.tpl`), проверяется `dpkg-deb` в CI. AppImage не может сохранить SUID (squashfs монтируется `nosuid`), поэтому полагается на unprivileged user namespaces; на Ubuntu 24.04+ AppArmor (`kernel.apparmor_restrict_unprivileged_userns=1`) их блокирует. Решение: `.deb` — основной канал, AppImage — secondary; для AppImage при отказе sandbox приложение показывает диалог с инструкцией установить AppArmor-профиль `packaging/linux/apparmor/videolessons`; флаг `--no-sandbox` по умолчанию не используется.
7. **Размер.** Бюджет: установленный размер ≤ 1.4 ГБ, `.deb` ≤ 700 МБ, AppImage ≤ 750 МБ (ориентир 400–550 МБ). Гейт в `scripts/make-release.sh`: при превышении сборка падает с перечнем крупнейших каталогов. Модели `tiny/base/medium` в пакет не входят (офлайн-сборка одна) — это следствие для M9 (список моделей в настройках).
8. **Скрипты:** `build-backend.sh` (PyInstaller в контейнере), `build-electron.sh` (vite build + tsc + electron-builder), `make-release.sh` (fetch-ffmpeg → fetch-model → build-backend → build-electron → размерные гейты → `sha256sum` → `dist/release.json`). Все запускаются только через `docker run --rm -v "$PWD:/build" videolessons-build:22.04 …`.
9. **Проверка на чистой ВМ** — по процедуре `./10-acceptance-ci.md` (D5, D12): Ubuntu 22.04 LTS и 24.04 LTS, без `python3`/`ffmpeg`, offline-сеть через `unshare -n`, установка `.deb` и запуск AppImage. M8 использует готовые `scripts/vm-smoke.sh` и `scripts/measure-startup.sh` (собственник — M10), не дублирует их; замер старта — по лог-маркеру `startup.window_visible` в `electron/logger.ts` (микро-изменение M1/M10), порог < 5 с.
10. **Откаты:** при падении PyInstaller-сборки релиз блокируется (не «упаковываем старое»), откат — предыдущий тег `v<ver>` с готовыми артефактами; AppImage может быть исключён из релиза без влияния на `.deb`; при проблемах с моделью — вернуть float16-снапшот (M3 не меняется).

Фрагмент `packaging/docker/Dockerfile.build`:

```dockerfile
FROM ubuntu:22.04@sha256:<pinned-digest>
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends software-properties-common gnupg curl ca-certificates xz-utils file \
 && add-apt-repository -y ppa:deadsnakes/ppa && apt-get update \
 && apt-get install -y --no-install-recommends python3.11 python3.11-venv python3.11-dev libgomp1 \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs binutils patchelf rpm \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
```

Фрагмент `packaging/backend.spec`:

```python
from PyInstaller.utils.hooks import collect_all, collect_submodules

datas, binaries, hiddenimports = [], [], []
for pkg in ("ctranslate2", "faster_whisper", "tokenizers", "av", "onnxruntime"):
    d, b, h = collect_all(pkg)
    datas += d; binaries += b; hiddenimports += h
hiddenimports += collect_submodules("uvicorn") + collect_submodules("app")
datas += [("backend/app/migrations", "app/migrations")]

a = Analysis(["backend/app/main.py"], pathex=["backend"], datas=datas,
             binaries=binaries, hiddenimports=hiddenimports,
             excludes=["tkinter", "pytest", "matplotlib"])
exe = EXE(PYZ(a.pure), a.scripts, [], exclude_binaries=True,
          name="vl-backend", console=True, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name="backend")
```

Фрагмент `packaging/electron-builder.yml`:

```yaml
appId: org.videolessons.app
productName: VideoLessons
directories: { output: dist, buildResources: build }
files: ["electron/dist/**/*", "package.json"]
asar: true
asarUnpack: ["**/*.node"]
extraResources:
  - { from: dist/backend, to: backend }
  - { from: frontend/dist, to: frontend/dist }
  - { from: resources/ffmpeg, to: ffmpeg }
  - { from: resources/models/faster-whisper-small, to: models/faster-whisper-small }
linux:
  target: [deb, AppImage]
  category: AudioVideo
  executableName: videolessons
  icon: build/icon.png
deb:
  afterInstall: packaging/linux/after-install.tpl
  depends: [libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, libgbm1,
            xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0]
```

## 4. Изменения контрактов

### 4.1. Раскладка ресурсов и переменные окружения (уточнение §7 конвенций / A11)

| Путь в пакете | Содержимое | Кто читает |
|---|---|---|
| `${VL_RESOURCES_DIR}/backend/vl-backend` | sidecar PyInstaller (onedir) | `electron/backend.ts` (spawn) |
| `${VL_RESOURCES_DIR}/frontend/dist/` | `frontend/dist` (A1) | бэкенд, static mount (`VL_FRONTEND_DIR`) |
| `${VL_RESOURCES_DIR}/ffmpeg/{ffmpeg,ffprobe}` | статические бинарники + лицензии | `services/probe.py`, `services/transcriber.py` |
| `${VL_RESOURCES_DIR}/models/faster-whisper-small/` | CT2 INT8 модель | `services/transcriber.py` |
| `${VL_RESOURCES_DIR}/THIRD-PARTY-NOTICES.md` | GPL/лицензии | пользователь, `.deb`/AppImage |

Согласовано с `./01-skeleton-m1.md` (D-01.4, §4): путь к статике задаётся env `VL_FRONTEND_DIR`, по умолчанию `${VL_RESOURCES_DIR}/frontend/dist` (prod) и `<repo>/frontend/dist` (dev). M8 кладёт сборку именно в `${VL_RESOURCES_DIR}/frontend/dist`; отдельная переменная `VL_WEB_DIR` не вводится.

### 4.2. Сборочные контракты

- `packaging/docker/Dockerfile.build` — образ `videolessons-build:22.04`; единственная точка, где доступна сеть.
- `packaging/backend.spec` — артефакт `dist/backend/vl-backend` + `_internal`; стороны, которые можно менять без правок M1: spec-файл, набор `collect_*`.
- `packaging/electron-builder.yml` — `extraResources` как в §3.5; имена артефактов `VideoLessons-<ver>-amd64.deb` и `VideoLessons-<ver>.AppImage` (`../TARGET.md` §10 п.4).
- `packaging/linux/after-install.tpl` — `chown root:root` + `chmod 4755` для `chrome-sandbox` (обязательное условие `../TARGET.md` §9 «не отключать sandbox»).
- `packaging/linux/videolessons.desktop`, `packaging/linux/apparmor/videolessons`, `build/icon.png` (512×512) — новые файлы.
- Права/владелец в `.deb`: пакет `videolessons`, установка в `/opt/VideoLessons`, `Section: video`, `Priority: optional`.
- Новые скрипты: `scripts/build-backend.sh`, `scripts/build-electron.sh`, `scripts/make-release.sh`; `scripts/vm-smoke.sh`, `scripts/measure-startup.sh`, `scripts/ci.sh`, `scripts/acceptance.sh` — зона M10, M8 их вызывает, но не переписывает.
- Новый файл `dist/release.json`: `{version, git_sha, built_at, artifacts:[{name,size,sha256}], model_quantized, ffmpeg_version}`.
- `scripts/fetch-ffmpeg.sh`, `scripts/fetch-model.sh` — фиксированные версии и sha256; повторный запуск идемпотентен (проверка чексуммы перед скачиванием).

### 4.3. Ратифицировано Lead'ом (`00` §4.1, A11)

1. `frontend/dist` в `extraResources` как `${VL_RESOURCES_DIR}/frontend/dist` и env `VL_FRONTEND_DIR` — **принято**, внесено в `00` §7.
2. `THIRD-PARTY-NOTICES.md` в `extraResources` — **принято**, внесено в A11.
3. `deb.afterInstall` с SUID-фиксом `chrome-sandbox` (4755) — **обязательно** (`TARGET.md` §9).
4. AppArmor-профиль `packaging/linux/apparmor/videolessons` — **принято** как поставляемый файл (не устанавливается автоматически).
5. `dist/release.json` — **принято** как обязательный артефакт релиза (для M10/CI).
6. `onnxruntime` в `collect_all` — условно: если пакета нет, spec не падает (флаг в spec).

### 4.4. Решения по открытым вопросам (ратифицировано Lead'ом)

1. **Модели:** в офлайн-пакете только `small` INT8 (A11); `tiny/base/medium` видны в настройках, но недоступны с пояснением «доступно после загрузки модели»; внешние пути моделей — вне объёма (ключ `whisper_model_path` не вводится).
2. **AppImage:** остаётся secondary (с AppArmor-профилем и диагностикой userns), `.deb` — основной артефакт; критерий §10 п.4 выполняется для обоих.
3. **Лицензии:** приоритет — LGPL-сборка ffmpeg (без GPL-обязательств для приложения); если использовать GPL-сборку — `LICENSE.GPLv3.txt` + `SOURCE-OFFER.md` + `THIRD-PARTY-NOTICES.md`, исходники в `dist/` не вкладываются (только ссылка на источник + хеши).
4. **Maintainer:** плейсхолдер `VideoLessons Maintainers <maintainers@videolessons.local>` остаётся до релиза; заменить перед публикацией.
5. **Подпись `.deb`:** не требуется для приёмки (внутренний артефакт), SHA256SUMS обязательны.
6. **Версии:** Node 20 LTS, Electron 31 (pinned в lock-файле); обновление Electron — после M9.
7. **ОС:** проверка 22.04 и 24.04 (LTS); 26.04 — best effort на момент RC (согласовано с `./10-acceptance-ci.md` D12).

## 5. Задачи

### T-08.1. Воспроизводимый build-образ `ubuntu:22.04`

**Файлы:** `packaging/docker/Dockerfile.build`, `.dockerignore`, `scripts/docker-build.sh`, `packaging/docker/README.md`
**Что сделать:**
1. Написать Dockerfile из §3 с зафиксированным digest базового образа, Python 3.11 (deadsnakes), Node 20, `libgomp1`, `patchelf`, `binutils`.
2. Добавить `.dockerignore` (исключить `node_modules`, `dist`, `resources/`, `.git`, `**/__pycache__`), иначе контекст весит гигабайты.
3. `scripts/docker-build.sh`: собрать образ `videolessons-build:22.04`, печатать версии `python3.11 -V`, `node -v`, `glibc` (`ldd --version`).
4. Проверить, что установка `pip install -r backend/requirements.txt` и `npm ci` проходит внутри контейнера при выключенной сети после прогрева кэша (offline-sanity).
5. Зафиксировать в README: сборка только в контейнере (A10), образ пересобирается при изменении requirements/package-lock.

**Готово, когда:** `docker build` детерминирован (повторная сборка — то же дерево пакетов), версии Python 3.11/Node 20/glibc 2.35 подтверждены, `pip install` и `npm ci` проходят в контейнере.
**Оценка:** 0.25 дня

### T-08.2. PyInstaller `--onedir`: спека, hooks, hidden imports

**Файлы:** `packaging/backend.spec`, `packaging/hooks/hook-ctranslate2.py`, `packaging/entrypoint.py`, `backend/app/main.py` (точка входа `main()`), `backend/tests/test_packaged_backend.py`, `scripts/build-backend.sh`
**Что сделать:**
1. Реализовать спеку из §3: `collect_all` для `ctranslate2`, `faster_whisper`, `tokenizers`, `av`, `onnxruntime` (условно); `datas` для миграций; `console=True`; `upx=False`.
2. Добавить hook для `ctranslate2`, если автосбор не находит разделяемые библиотеки (`libctranslate2*.so*`, `libiomp5`/`libgomp`); фиксировать найденные hidden imports **в спеке**, не в командной строке (TARGET.md §11).
3. `scripts/build-backend.sh`: `pyinstaller --clean --noconfirm packaging/backend.spec` внутри контейнера; после сборки —
   `ldd dist/backend/vl-backend | grep "not found"` (должно быть пусто) и `objdump -T | grep GLIBC_` (максимум ≤ 2.35).
4. Smoke-тест в контейнере: запустить `dist/backend/vl-backend` с `VL_TOKEN`, `VL_DATA_DIR=/tmp/vl`, дождаться `VL_READY`, вызвать `/api/health` через `curl` с токеном, погасить процесс.
5. Проверить, что миграции применяются из `_internal/app/migrations` (создаётся `library.db` с `user_version=7`).

**Готово, когда:** бинарник стартует без Python на PATH, `/api/health` отвечает, миграции применяются, `ldd` не показывает отсутствующих библиотек, smoke-тест зелёный.
**Оценка:** 0.5 дня

### T-08.3. Статические ffmpeg/ffprobe, модель INT8 и лицензионные уведомления

**Файлы:** `scripts/fetch-ffmpeg.sh`, `scripts/fetch-model.sh`, `resources/ffmpeg/LICENSE.LGPLv2.1.txt` (fallback `LICENSE.GPLv3.txt`), `resources/THIRD-PARTY-NOTICES.md`, `resources/SOURCE-OFFER.md`, `packaging/docker/build-assets.sh`, `docs/licenses.md`
**Что сделать:**
1. `fetch-ffmpeg.sh`: зафиксированная версия (`6.0.1`), URL LGPL-сборки (BtbN `linux64-lgpl`; fallback — johnvansickle GPL), sha256, распаковка `ffmpeg`/`ffprobe` в `resources/ffmpeg/`, `chmod +x`, проверка `ffmpeg -version`.
2. `fetch-model.sh`: снапшот `Systran/faster-whisper-small` на зафиксированной ревизии, sha256 файлов; в контейнере — `ct2-transformers-converter --quantization int8` в `resources/models/faster-whisper-small/`; fallback — float16 + флаг в `release.json`.
3. Лицензии: `LICENSE.LGPLv2.1.txt` для LGPL-сборки ffmpeg (при GPL-сборке — `LICENSE.GPLv3.txt` + `SOURCE-OFFER.md`), `THIRD-PARTY-NOTICES.md` (ffmpeg, CTranslate2 MIT, faster-whisper MIT, Electron MIT, Python-зависимости), `SOURCE-OFFER.md` с ссылкой на исходники ffmpeg.
4. Проверить, что модель грузится офлайн: тест `backend/tests/test_model_offline.py` — `WhisperModel(path, device="cpu", compute_type="int8")` при выключенной сети, короткий WAV (5 с) даёт непустой текст.
5. Записать в `docs/licenses.md` происхождение бинарников, версии, хеши и обязательства.

**Готово, когда:** `ffmpeg`/`ffprobe` исполняются из `resources/`, модель загружается офлайн, размеры укладываются в бюджет §3.7, лицензионные файлы на месте.
**Оценка:** 0.5 дня

### T-08.4. `.deb` через electron-builder: сборка, зависимости, SUID-песочница

**Файлы:** `packaging/electron-builder.yml`, `packaging/linux/after-install.tpl`, `packaging/linux/videolessons.desktop`, `build/icon.png`, `package.json` (build-секция/скрипты), `scripts/build-electron.sh`
**Что сделать:**
1. Настроить `extraResources` (§3.5), `asar`/`asarUnpack`, `files`, `appId`, `productName`, `directories.output`.
2. Добавить `deb.depends` (GTK3/notify/nss/xss/xtst/gbm/xdg-utils/atspi/uuid/secret), `Section: video`, `Priority: optional`, `executableName: videolessons`.
3. `after-install.tpl`: `chown root:root /opt/VideoLessons/chrome-sandbox; chmod 4755 …`; проверить, что режим сохраняется в пакете (`dpkg-deb --fsys-tarfile | tar -tv | grep chrome-sandbox` → `-rwsr-xr-x`).
4. Desktop-файл: `Name=VideoLessons`, `Comment`, `Categories=AudioVideo;Education;Video;`, `StartupWMClass=videolessons`, `Icon=videolessons`; иконка 512×512.
5. В `electron/backend.ts` реализовать выбор пути sidecar: prod — `${process.resourcesPath}/backend/vl-backend`, dev — `python -m app.main`; передавать `VL_RESOURCES_DIR=process.resourcesPath`.
6. Проверить установку/удаление в контейнере: `dpkg -i`, запуск под `xvfb-run`, `dpkg -r` без «залипших» файлов в `~/.config`.

**Готово, когда:** `.deb` ставится, приложение стартует под Xvfb, `chrome-sandbox` в пакете SUID 4755, `desktop-file-validate` без предупреждений, удаление пакета чистое.
**Оценка:** 0.5 дня

### T-08.5. AppImage и совместимость с Ubuntu 24.04+

**Файлы:** `packaging/electron-builder.yml` (target AppImage), `packaging/linux/apparmor/videolessons`, `electron/main.ts` (диалог sandbox-ошибки), `docs/user-guide.md`
**Что сделать:**
1. Включить `AppImage` в `linux.target`, проверить запуск на Ubuntu 22.04 (userns доступен) без SUID.
2. Подготовить AppArmor-профиль `videolessons` (allow `userns`, `network` только loopback, доступ к `$HOME` библиотеки и `resources`); включить в артефакты как отдельный файл с инструкцией установки.
3. В `electron/main.ts` перехватить ошибку sandbox (`chrome-sandbox is owned by root and has mode 4755`/`userns`), показать человекочитаемый диалог: «Используйте .deb или установите профиль AppArmor» + кнопка «Открыть документацию» (`shell.openExternal` на локальный файл запрещён — открывать README через `revealInExplorer`).
4. Проверить запуск AppImage на 24.04 LTS: до установки профиля — контролируемый диалог, после — штатный старт.
5. Обновить `docs/user-guide.md`: различия каналов, почему `.deb` рекомендуется.

**Готово, когда:** AppImage запускается на 22.04; на 24.04 при заблокированном userns показывается диалог с инструкцией (без падения), после установки профиля — запускается.
**Оценка:** 0.25 дня

### T-08.6. Скрипты сборки, размерные гейты, чексуммы

**Файлы:** `scripts/build-backend.sh`, `scripts/build-electron.sh`, `scripts/make-release.sh`, `dist/release.json` (генерируемый), `docs/packaging.md`
**Что сделать:**
1. `build-backend.sh`: PyInstaller в контейнере, проверки `ldd`/`objdump`, smoke-запуск, копирование `dist/backend` в ожидаемое место.
2. `build-electron.sh`: `npm ci`, `vite build`, `tsc -p electron`, `electron-builder --linux --x64`; сборка только из контейнера.
3. `make-release.sh`: последовательность fetch-ffmpeg → fetch-model → build-backend → build-electron; гейты размеров (§3.7) и `scripts/check-artifacts.sh`; генерация `SHA256SUMS` и `dist/release.json`.
4. `docs/packaging.md`: ручной чек-лист чистой ВМ (проверки `! command -v python3`, `! command -v ffmpeg`, установка `.deb`, запуск, offline-прогон `unshare -n`, `ss -tp`), команды вызова `scripts/vm-smoke.sh` и `scripts/measure-startup.sh` (M10), порядок записи результатов в `docs/acceptance.md`.
5. `docs/packaging.md`: как собрать релиз с нуля, где лежат артефакты, как обновлять версии ffmpeg/модели, таблица размеров.

**Готово, когда:** `make-release.sh` с нуля (пустые `resources/`, `dist/`) выдаёт оба артефакта, `SHA256SUMS` и `release.json`; гейты размера работают; повторный запуск идемпотентен.
**Оценка:** 0.5 дня

### T-08.7. Проверка на чистых Ubuntu 22.04 и 24.04 и документирование

**Файлы:** `docs/packaging.md`, `docs/acceptance.md` (секция M8), `docs/user-guide.md`, `README.md` (сборка)
**Что сделать:**
1. Чистая ВМ Ubuntu 22.04 LTS (или контейнер по `scripts/vm-smoke.sh`): без `python3`, `ffmpeg`, моделей; установка `apt install ./VideoLessons-<ver>-amd64.deb`; запуск из меню GNOME.
2. Замер: `scripts/measure-startup.sh` (M10) — медиана из 5 запусков по лог-маркеру `startup.window_visible`, порог < 5 с; записать в `docs/acceptance.md`.
3. Транскрипция 10-минутного русского видео на чистой ВМ: `queued → processing → done`, сегменты видны; RAM ≤ 3 ГБ (мониторинг `ps`/`gnome-system-monitor`), временные WAV удалены.
4. Offline-проверка: `unshare -n` (с поднятым loopback) — приложение стартует и транскрибирует; `ss -tp` не показывает внешних соединений (критерий §7 п.10).
5. Повторить п.1–3 для Ubuntu 24.04 LTS (`.deb` и AppImage); зафиксировать ограничения AppImage в `docs/user-guide.md`.
6. Проверить `dpkg -c`/`dpkg -I`, `desktop-file-validate`, `appstreamcli validate` (если установлен), отсутствие Python/ffmpeg в зависимостях.

**Готово, когда:** критерий §7 п.1 и п.10 подтверждены на двух ВМ, результаты и размеры артефактов внесены в `docs/acceptance.md`, README описывает воспроизводимую сборку.
**Оценка:** 0.5 дня

**Итого:** 3.0 дня (в пределах оценки 2–3 дня).

## 6. UI/UX-спецификация

Этап меняет только сценарий запуска и служебные диалоги; основная UI-работа M1–M7 не переделывается.

- **Splash-окно** 420×240: логотип, «Запуск VideoLessons…», индикатор. Показывается сразу после `app.whenReady()`, закрывается после `did-finish-load` и `VL_READY`. Таймаут 20 с.
- **Диалог ошибки запуска** (Electron `dialog.showMessageBox`): заголовок «Не удалось запустить приложение», текст из класса ошибки (бэкенд не стартовал / нет ресурсов / sandbox), кнопки «Повторить», «Открыть папку логов» (`revealInExplorer(logsDir)`), «Выход». Не показывать traceback пользователю.
- **Диалог sandbox (AppImage)**: «Песочница Chromium недоступна в AppImage на этой системе. Установите пакет .deb или профиль AppArmor из каталога docs/». Кнопки «Открыть документацию» (локальный `README.md` через `revealInExplorer`), «Выход».
- **Desktop entry**: `Name=VideoLessons`, `Comment=Локальные видеоуроки с транскрипцией и поиском`, `Categories=AudioVideo;Education;Video;`, `StartupWMClass=videolessons`, `Icon=videolessons`. Иконка 512×512 PNG.
- **«О программе»** (M9 дорабатывает): версия приложения и бэкенда из `getAppInfo().version` и `/api/health.version`, путь данных (`dataDir`), путь логов (`logsDir`).
- **Тексты** — через `i18n/ru.json` (M9 выносит финальные формулировки); M8 использует минимальный набор ключей `app.start.*`, `app.error.*`, `sandbox.*`.

## 7. Тесты и проверки

| Проверка | Инструмент | Где | Ожидаемый результат |
|---|---|---|---|
| Воспроизводимость контейнера | docker build + повторный прогон | `scripts/docker-build.sh` | одинаковые версии Python/Node/glibc |
| Сборка sidecar без Python в PATH | smoke в контейнере | `scripts/build-backend.sh` | `/api/health` отвечает |
| Отсутствующие библиотеки | `ldd`, `objdump -T` | `scripts/build-backend.sh` | нет `not found`, GLIBC ≤ 2.35 |
| Миграции внутри `_internal` | pytest + smoke | `backend/tests/test_packaged_backend.py` | `user_version` актуален |
| Модель офлайн | pytest | `backend/tests/test_model_offline.py` | непустой текст |
| Содержимое `.deb` | `dpkg-deb -I`, `dpkg-deb -c` | `scripts/check-artifacts.sh` | зависимости, SUID 4755, desktop, иконка |
| Установка/удаление `.deb` | `dpkg -i` / `dpkg -r` в контейнере с Xvfb | `scripts/check-artifacts.sh` | старт, чистое удаление |
| `desktop-file-validate` | утилита | `scripts/check-artifacts.sh` | без ошибок |
| Размер артефактов | `du`/`stat` + гейт | `scripts/make-release.sh` | `.deb` ≤ 700 МБ, AppImage ≤ 750 МБ |
| Чексуммы | `sha256sum -c` | `dist/SHA256SUMS` | сходится |
| Старт на чистой 22.04 | `scripts/measure-startup.sh` (M10) | `docs/acceptance.md` | окно < 5 с |
| Транскрипция на чистой ВМ | ручной прогон | `docs/acceptance.md` | `done`, RAM ≤ 3 ГБ |
| Нет сети | `unshare -n` + `ss -tp` | `scripts/vm-smoke.sh` (M10) / ручной чек-лист | 0 внешних соединений (критерий п.10) |
| AppImage 22.04/24.04 | ручной прогон | `docs/acceptance.md` | старт / контролируемый диалог |
| Sandbox `.deb` | запуск с проверкой `chrome-sandbox` | `scripts/check-artifacts.sh` | sandbox активен, без `--no-sandbox` |

## 8. Критерии готовности и коммиты

**DoD:**

- [ ] `make-release.sh` на чистом дереве собирает `.deb` и `.AppImage` только в контейнере `ubuntu:22.04`.
- [ ] В пакете: sidecar `vl-backend`, `frontend/dist`, статические ffmpeg/ffprobe, модель `small` INT8, лицензионные уведомления.
- [ ] `chrome-sandbox` в `.deb` — root:root, режим 4755; приложение не использует `--no-sandbox` по умолчанию.
- [ ] Критерий `../TARGET.md` §7 п.1 подтверждён на чистых 22.04 и 24.04; п.10 подтверждён при `unshare -n`.
- [ ] Размеры в пределах гейтов; `SHA256SUMS` и `dist/release.json` сформированы.
- [ ] AppImage: старт на 22.04; на 24.04 — человекочитаемый диалог и инструкция AppArmor.
- [ ] `docs/packaging.md`, `docs/licenses.md`, обновлённые README и `docs/acceptance.md` (секция M8) на месте.
- [ ] Нет изменений API и UI-логики, кроме путей ресурсов и диалогов запуска.

**Ожидаемые коммиты (6):**

1. `build(m8): add reproducible ubuntu 22.04 docker build image`
2. `build(m8): package backend sidecar with pyinstaller onedir spec`
3. `build(m8): bundle static ffmpeg, int8 whisper model and license notices`
4. `build(m8): add electron-builder deb target with chrome-sandbox fixup`
5. `build(m8): add appimage target and apparmor profile for ubuntu 24.04`
6. `build(m8): add release scripts with size gates, checksums and vm verification docs`

## 9. Риски и откаты

| Риск | Вероятность | Влияние | Меры / откат |
|---|---|---|---|
| Missing hidden imports в PyInstaller (`ctranslate2`, `tokenizers`, `av`) | Высокая | Высокое: sidecar падает в рантайме, приёмка блокируется | `collect_all` + hook-файлы, smoke-тест с реальной транскрипцией в контейнере, фиксация импортов в `spec` (не в CLI, TARGET.md §11); откат — добавить пакет/hook и пересобрать, релиз не выпускать до зелёного smoke |
| glibc/портируемость (сборка на dev-машине или на Ubuntu 24.04) | Средняя | Высокое: `GLIBC_2.38 not found` на целевой 22.04 | Сборка только в `ubuntu:22.04` с pinned digest (A10), проверка `objdump -T`; откат — пересобрать с предыдущим рабочим digest, артефакты старой версии остаются в `dist/` |
| Размер `.deb`/AppImage выше бюджета | Средняя | Среднее: долгая загрузка, отказ от AppImage | INT8-модель, `--exclude` для тестов/доков, `strip=False` только для libs CT2, xz-сжатие; откат — исключить AppImage из релиза, уменьшить модель (решение Lead'а по 4.4-1) |
| SUID-песочница `chrome-sandbox` не сохраняется в `.deb`/AppImage | Высокая | Высокое: приложение не стартует или sandbox отключён | `afterInstall` + проверка `dpkg-deb --fsys-tarfile`; AppImage — AppArmor-профиль; откат — `.deb` как единственный канал, AppImage помечается experimental в `docs/user-guide.md` |
| AppImage + userns/AppArmor на Ubuntu 24.04+ | Высокая | Среднее: AppImage не запускается на новых системах | Диалог с инструкцией, профиль AppArmor, документирование; откат — публиковать только `.deb`, AppImage не включать в `dist/` без пометки |

## 10. Трассировка и ссылки

**Трассировка на `../TARGET.md`:**

| Раздел спеки | Пункт | Где в плане |
|---|---|---|
| §1 | Стек: Electron 31+, PyInstaller `--onedir`, целевая Ubuntu 22.04+ | §3.1–3.2, T-08.1, T-08.2 |
| §6 (M8) | PyInstaller, ffmpeg и модели внутрь, electron-builder, проверка на чистой ВМ | §5, T-08.2–T-08.7 |
| §7 п.1 | Первый запуск: `.deb` на Ubuntu без Python/ffmpeg, окно < 5 с | T-08.4, T-08.7 |
| §7 п.10 | Нет исходящих запросов | T-08.3, T-08.7 |
| §8 | RAM ≤ 3 ГБ, CPU 6 потоков, логи, безопасность (sandbox) | T-08.4, T-08.7 |
| §9 | Запрет `--onefile`, запрет отключения sandbox, динамический порт | §3.2, §3.6, T-08.4 |
| §10 | Артефакты `dist/VideoLessons-<ver>-amd64.deb` и `.AppImage`, скрипты сборки | §4.2, T-08.6 |
| §11 | Прогон приёмки перед M8; hidden imports — в spec | §2, §3.2, T-08.7 |

**Ссылки:** `../TARGET.md` §1, §6 (M8), §7 п.1/п.10, §8, §9, §10, §11; `./00-conventions.md` §2 (A3, A10, A11, A12, A13), §3 (структура `packaging/`, `scripts/`), §7 (пути, порт, ресурсы), §9 (сборка в Docker); `./01-skeleton-m1.md` (handshake `VL_READY`, `backend.ts`, `VL_RESOURCES_DIR`, `VL_FRONTEND_DIR`); `./02-library-m2.md` (ffprobe-пути, обработка отсутствующих бинарников); `./03-transcription-m3.md` (модель, `compute_type`, временные WAV); `./04-search-m4.md` (SPA-статика из `frontend/dist`); `./05-player-timings-m5.md` (Range-стриминг в упакованном виде); `./07-annotations-m7.md` (миграции 005/006 должны попасть в `datas`); `./09-polish-m9.md` (финальные тексты ошибок, «О программе», AppArmor-диалог); `./10-acceptance-ci.md` (`vm-smoke.sh`, `measure-startup.sh`, `ci.sh`, чистая ВМ, `docs/acceptance.md`).

**Координация с M10:** упаковка остаётся в `scripts/make-release.sh` (M8), а `scripts/ci.sh` (M10) вызывает её стадией `build` и затем проверяет артефакт; `SHA256SUMS` формирует M8 в `dist/`, M10 копирует/ссылается на них в `dist/ci/`. Дублирования сборки нет.

**Критерий §7 → проверка:**

| Критерий | Проверка |
|---|---|
| п.1 Первый запуск | T-08.7, `docs/acceptance.md`, `scripts/measure-startup.sh` |
| п.3 Транскрипция (на установленном пакете) | T-08.3, T-08.7 |
| п.8 Перезапуск | T-08.7 (данные в `$VL_DATA_DIR`) |
| п.9 Остановка обработки | T-08.4 (sidecar stop), T-08.7 |
| п.10 Нет сети | T-08.3, T-08.7 (`unshare -n`, `ss -tp`) |
