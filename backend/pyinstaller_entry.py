"""Точка входа PyInstaller: запускает sidecar-бэкенд."""
from __future__ import annotations

import multiprocessing


def main() -> None:
    # PyInstaller + multiprocessing (spawn): дочерний процесс запускается как
    # `vl-backend --multiprocessing-fork ...` и обязан уйти в spawn_main(), иначе
    # заново выполнится entrypoint и поднимется второй backend (рекурсивная
    # лавина процессов, транскрипция не запускается). Импорт app.main — после
    # freeze_support(), чтобы не грузить тяжёлые зависимости в дочернем процессе.
    multiprocessing.freeze_support()
    from app.main import run

    run()


if __name__ == "__main__":
    main()
