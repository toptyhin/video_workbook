# Third-party notices

- Electron — MIT
- Python / FastAPI / Uvicorn / Starlette — MIT/BSD
- faster-whisper — MIT; модель Whisper — MIT (OpenAI)
- CTranslate2 — MIT
- SQLite — Public Domain
- FFmpeg — LGPL 2.1+ (используется LGPL-сборка; при GPL-сборке см. LICENSE.GPLv3.txt и SOURCE-OFFER.md)
- ONNX Runtime — MIT (CPU-инференс эмбеддингов, M12)
- HuggingFace `tokenizers` — Apache-2.0 (токенизация e5, M12)
- numpy — BSD-3-Clause (косинус/матрица векторов, M12)
- Модель `intfloat/multilingual-e5-small` — MIT (в т.ч. ONNX int8-экспорт `Xenova/multilingual-e5-small`); файлы
  лежат в `resources/models/multilingual-e5-small-onnx/` (~130 МБ: `onnx/model_quantized.onnx`, `tokenizer.json`,
  `config.json`, `tokenizer_config.json`) и скачиваются `scripts/fetch-embed-model.sh`; рантайм работает офлайн.

## M13 — менеджер моделей (модели скачиваются пользователем)

Начиная с M13 веса моделей **не входят в поставку**; пользователь скачивает их из «Настройки → Модели»
в `$VL_DATA_DIR/models/` (или импортирует файл). Для каждой загруженной модели рядом сохраняется
её лицензия/атрибуция; в приложении доступен список установленных моделей и лицензий.

- `Systran/faster-whisper-{tiny,base,small,medium}` — MIT (Whisper, OpenAI; CTranslate2-конвертация Systran).
- `Xenova/multilingual-e5-small` (ONNX int8) — MIT (`intfloat/multilingual-e5-small`).
- `KoarAI/LFM2.5-350M-Thinking` (GGUF Q4_K_M) — производная от `LiquidAI/LFM2.5-350M`; распространяется
  под **LFM Open License v1.0** (https://www.liquid.ai/lfm-license): commercial use при выручке < $10M,
  требуется сохранять copyright/notices и приложить копию лицензии; см. также карточку модели.
- `Qwen/Qwen2.5-0.5B-Instruct` (GGUF Q4_K_M) — **Apache-2.0**.

## M14 — llama.cpp runtime и саммари

- **llama.cpp** (CPU-сборка `llama-cli` + библиотеки, pinned b11669, `resources/llama/`) — MIT;
  файл LICENSE поставляется рядом с бинарём.
- Генерация саммари выполняется локально на CPU; сеть для инференса не используется.
