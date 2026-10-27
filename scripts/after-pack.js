const fs = require('fs');
const path = require('path');

/**
 * afterPack-хук electron-builder: готовит распакованное приложение до упаковки
 * в .deb/AppImage.
 *
 * Зачем: sidecar (PyInstaller onedir) и static ffmpeg/ffprobe лежат в
 * resources/ вне asar и запускаются как дочерние процессы. В AppImage файлы
 * попадают из этого каталога в squashfs, поэтому бит исполнения нужно выставить
 * до упаковки.
 */
exports.default = async function (context) {
  // Нас интересует только Linux (и, возможно, macOS)
  if (context.electronPlatformName !== 'linux' && context.electronPlatformName !== 'darwin') {
    return;
  }

  // Путь к папке resources в собранном приложении (до упаковки в AppImage)
  const resourcesDir = path.join(context.appOutDir, 'resources');
  const backendPath = path.join(resourcesDir, 'backend', 'vl-backend');

  if (!fs.existsSync(backendPath) || !fs.statSync(backendPath).isFile()) {
    // Раньше здесь было только предупреждение, и сборка «успешно» выпускала
    // AppImage без backend: приложение запускалось, но sidecar не находился
    // (spawn ENOENT/EACCES). Отсутствие backend — это ошибка сборки, а не деталь.
    const message =
      `[afterPack] Backend not found at ${backendPath} (ожидается файл). ` +
      'electron-builder запущен без --config packaging/electron-builder.yml, ' +
      'в package.json появился ключ "build", или extraResources для backend ' +
      'делает лишний уровень вложенности (to: backend, а не backend/vl-backend).';
    if (context.electronPlatformName === 'linux') {
      throw new Error(message);
    }
    console.warn(message);
    return;
  }

  // Устанавливаем права: владелец rwx, группа rx, остальные rx (0o755)
  fs.chmodSync(backendPath, 0o755);
  console.log(`[afterPack] Set executable permission on ${backendPath}`);

  // ffmpeg/ffprobe запускаются backend'ом напрямую из resources/ffmpeg.
  // Копирование extraResources не гарантирует сохранение режима файла.
  for (const bin of ['ffmpeg', 'ffprobe']) {
    const binPath = path.join(resourcesDir, 'ffmpeg', bin);
    if (!fs.existsSync(binPath)) {
      throw new Error(`[afterPack] ${bin} not found at ${binPath}`);
    }
    fs.chmodSync(binPath, 0o755);
    console.log(`[afterPack] Set executable permission on ${binPath}`);
  }

  // SPA отдаётся backend'ом из resources/frontend/dist; без index.html
  // приложение откроет API-only и покажет пустой экран.
  const indexHtml = path.join(resourcesDir, 'frontend', 'dist', 'index.html');
  if (!fs.existsSync(indexHtml)) {
    throw new Error(`[afterPack] frontend build not found at ${indexHtml}`);
  }
  console.log(`[afterPack] Frontend build found at ${indexHtml}`);

  // onedir-backend без _internal не запустится (Python-рантайм и .so).
  const internalDir = path.join(resourcesDir, 'backend', '_internal');
  if (!fs.existsSync(internalDir)) {
    throw new Error(`[afterPack] backend _internal dir not found at ${internalDir}`);
  }

  // M13: модели больше НЕ поставляются в бандле (скачиваются пользователем
  // в $VL_DATA_DIR/models). Если каталог случайно попал в пакет — это ошибка.
  const modelsDir = path.join(resourcesDir, 'models');
  if (fs.existsSync(modelsDir) && fs.readdirSync(modelsDir).length > 0) {
    throw new Error(`[afterPack] resources/models must not be bundled (M13); found ${modelsDir}`);
  }

  // M14: pinned CPU-runtime llama.cpp для саммари.
  const llamaCli = path.join(resourcesDir, 'llama', 'llama-cli');
  if (!fs.existsSync(llamaCli)) {
    throw new Error(`[afterPack] llama.cpp runtime not found at ${llamaCli} — выполните scripts/fetch-llama-runtime.sh`);
  }
  fs.chmodSync(llamaCli, 0o755);
  console.log(`[afterPack] llama.cpp runtime found at ${llamaCli}`);

  const notices = path.join(resourcesDir, 'THIRD-PARTY-NOTICES.md');
  if (!fs.existsSync(notices)) {
    throw new Error(`[afterPack] THIRD-PARTY-NOTICES.md not found at ${notices}`);
  }
};
