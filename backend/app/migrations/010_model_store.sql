-- M13: менеджер моделей (plans/13-model-store.md §4.2).
-- Модели живут в $VL_DATA_DIR/models; таблица хранит состояние загрузок между запусками.
CREATE TABLE IF NOT EXISTS model_downloads (
  model_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'absent',
  bytes_received INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  revision TEXT,
  error TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Структурированная причина ошибки обработки видео (UI показывает CTA,
-- например «скачать модель распознавания»).
ALTER TABLE videos ADD COLUMN error_code TEXT;
