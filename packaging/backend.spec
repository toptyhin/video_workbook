# -*- mode: python ; coding: utf-8 -*-
import os
from PyInstaller.utils.hooks import collect_all

BACKEND_DIR = os.path.abspath(os.path.join(SPECPATH, "..", "backend"))

datas = [
    (os.path.join(BACKEND_DIR, "app", "migrations"), "app/migrations"),
    # M13: реестр моделей читается из bundle (app/model_manifest.json).
    (os.path.join(BACKEND_DIR, "app", "model_manifest.json"), "app"),
]
binaries = []
hiddenimports = [
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
    # M13: потоковая загрузка моделей (httpx напрямую, не только транзитивно).
    "httpx",
]

for package in (
    "faster_whisper",
    "ctranslate2",
    "tokenizers",
    "av",
    "huggingface_hub",
    # M12: семантический поиск (ONNX-эмбеддинги) — numpy/onnxruntime в поставке.
    "onnxruntime",
    "numpy",
):
    try:
        pkg_datas, pkg_binaries, pkg_hidden = collect_all(package)
        datas += pkg_datas
        binaries += pkg_binaries
        hiddenimports += pkg_hidden
    except Exception:
        pass

a = Analysis(
    [os.path.join(BACKEND_DIR, "pyinstaller_entry.py")],
    pathex=[BACKEND_DIR],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="vl-backend",
    debug=False,
    strip=False,
    upx=False,
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="vl-backend",
)
