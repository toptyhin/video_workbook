"""M13: импорт моделей из каталога/архива и удаление (plans/13 §5 T-13.3)."""
from __future__ import annotations

import io
import tarfile
import zipfile
from pathlib import Path

import pytest

from app.services import model_store
from app.services.model_store import ModelError, ModelStore
from tests.test_m13_common import (
    DEFAULT_ID,
    DEFAULT_LOCAL_DIR,
    RecordingBus,
    install_entry,
    migrate_db,
    model_entry,
    model_item,
    use_manifest,
)


@pytest.fixture(autouse=True)
def _db(config):
    migrate_db(config)


@pytest.fixture(autouse=True)
def _big_disk(monkeypatch):
    monkeypatch.setattr(model_store, "_free_disk_bytes", lambda path: 10**12)


@pytest.fixture
def store(config):
    instance = ModelStore(config, RecordingBus())
    instance.start()
    try:
        yield instance
    finally:
        instance.shutdown()


@pytest.fixture
def entry(monkeypatch):
    payload = b"imported-model-data" * 100
    entry, contents = model_entry([("weights.bin", payload), ("config.json", b"{}")])
    use_manifest(monkeypatch, [entry])
    return entry, contents


def _write_dir(root: Path, contents: dict[str, bytes], prefix: str = "") -> Path:
    for local, data in contents.items():
        target = root / prefix / local
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return root


def test_import_directory(store, config, entry, tmp_path):
    entry_data, contents = entry
    source = _write_dir(tmp_path / "src", contents)
    result = store.import_model(DEFAULT_ID, str(source))
    assert result == {"id": DEFAULT_ID, "status": "ready"}
    base = config.models_dir / DEFAULT_LOCAL_DIR
    for local, payload in contents.items():
        assert (base / local).read_bytes() == payload
    marker = (base / ".installed.json").is_file()
    assert marker
    item = model_item(store, DEFAULT_ID)
    assert item["status"] == "ready"
    assert item["installed"] is True
    assert item["path"] == str(base)


def test_import_directory_with_local_dir_subfolder(store, config, entry, tmp_path):
    _entry, contents = entry
    source = _write_dir(tmp_path / "src", contents, prefix=DEFAULT_LOCAL_DIR)
    store.import_model(DEFAULT_ID, str(source))
    assert (config.models_dir / DEFAULT_LOCAL_DIR / "weights.bin").is_file()


def test_import_zip(store, config, entry, tmp_path):
    _entry, contents = entry
    archive = tmp_path / "model.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        for local, data in contents.items():
            bundle.writestr(f"{DEFAULT_LOCAL_DIR}/{local}", data)
    store.import_model(DEFAULT_ID, str(archive))
    assert (config.models_dir / DEFAULT_LOCAL_DIR / "weights.bin").is_file()


def test_import_tar_gz(store, config, entry, tmp_path):
    _entry, contents = entry
    archive = tmp_path / "model.tar.gz"
    with tarfile.open(archive, "w:gz") as bundle:
        for local, data in contents.items():
            info = tarfile.TarInfo(local)
            info.size = len(data)
            bundle.addfile(info, io.BytesIO(data))
    store.import_model(DEFAULT_ID, str(archive))
    assert (config.models_dir / DEFAULT_LOCAL_DIR / "weights.bin").is_file()


def test_import_zip_traversal_rejected(store, config, entry, tmp_path):
    _entry, contents = entry
    archive = tmp_path / "evil.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        for local, data in contents.items():
            bundle.writestr(local, data)
        bundle.writestr("../escape.txt", b"evil")
    with pytest.raises(ModelError) as error:
        store.import_model(DEFAULT_ID, str(archive))
    assert error.value.code == "archive_unsafe"
    assert error.value.status_code == 400
    assert not (config.models_dir.parent / "escape.txt").exists()
    assert not (config.models_dir / DEFAULT_LOCAL_DIR).exists()


def test_import_zip_absolute_path_rejected(store, entry, tmp_path):
    _entry, contents = entry
    archive = tmp_path / "evil.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        for local, data in contents.items():
            bundle.writestr(local, data)
        bundle.writestr("/tmp/absolute-evil.txt", b"evil")
    with pytest.raises(ModelError) as error:
        store.import_model(DEFAULT_ID, str(archive))
    assert error.value.code == "archive_unsafe"
    assert not Path("/tmp/absolute-evil.txt").exists()


def test_import_tar_symlink_rejected(store, entry, tmp_path):
    _entry, contents = entry
    archive = tmp_path / "evil.tar"
    with tarfile.open(archive, "w") as bundle:
        for local, data in contents.items():
            info = tarfile.TarInfo(local)
            info.size = len(data)
            bundle.addfile(info, io.BytesIO(data))
        link = tarfile.TarInfo("link.bin")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        bundle.addfile(link)
    with pytest.raises(ModelError) as error:
        store.import_model(DEFAULT_ID, str(archive))
    assert error.value.code == "archive_unsafe"


def test_import_checksum_mismatch(store, entry, tmp_path):
    entry_data, contents = entry
    source = _write_dir(tmp_path / "src", contents)
    (source / "weights.bin").write_bytes(b"tampered")
    with pytest.raises(ModelError) as error:
        store.import_model(DEFAULT_ID, str(source))
    assert error.value.code == "checksum_mismatch"


def test_import_size_mismatch(store, entry, tmp_path):
    _entry_data, contents = entry
    source = _write_dir(tmp_path / "src", contents)
    original = (source / "weights.bin").read_bytes()
    (source / "weights.bin").write_bytes(original[:-1])
    with pytest.raises(ModelError) as error:
        store.import_model(DEFAULT_ID, str(source))
    assert error.value.code == "checksum_mismatch"


def test_import_invalid_path(store, entry, tmp_path):
    with pytest.raises(ModelError) as error:
        store.import_model(DEFAULT_ID, str(tmp_path / "missing"))
    assert error.value.code == "import_path_invalid"
    with pytest.raises(ModelError) as error:
        store.import_model(DEFAULT_ID, "   ")
    assert error.value.code == "import_path_invalid"


def test_import_wrong_layout(store, entry, tmp_path):
    source = tmp_path / "src"
    source.mkdir()
    (source / "unexpected.bin").write_bytes(b"x")
    with pytest.raises(ModelError) as error:
        store.import_model(DEFAULT_ID, str(source))
    assert error.value.code == "import_path_invalid"


def test_import_unsupported_archive(store, entry, tmp_path):
    archive = tmp_path / "model.rar"
    archive.write_bytes(b"not an archive")
    with pytest.raises(ModelError) as error:
        store.import_model(DEFAULT_ID, str(archive))
    assert error.value.code == "import_path_invalid"


def test_import_works_offline(store, config, entry, tmp_path, monkeypatch):
    _entry, contents = entry
    monkeypatch.setattr(config, "offline", True)
    source = _write_dir(tmp_path / "src", contents)
    store.import_model(DEFAULT_ID, str(source))
    assert model_item(store, DEFAULT_ID)["status"] == "ready"


def test_delete(store, config, entry, tmp_path):
    _entry, contents = entry
    install_entry(config, _entry, contents)
    assert store.delete(DEFAULT_ID)["status"] == "absent"
    assert not (config.models_dir / DEFAULT_LOCAL_DIR).exists()
    assert model_item(store, DEFAULT_ID)["status"] == "absent"
    # идемпотентно
    assert store.delete(DEFAULT_ID)["status"] == "absent"


def test_delete_bundled_rejected(store, config, entry):
    entry_data, contents = entry
    install_entry(config, entry_data, contents, legacy=True)
    with pytest.raises(ModelError) as error:
        store.delete(DEFAULT_ID)
    assert error.value.code == "model_bundled"
    assert error.value.status_code == 409
    assert model_item(store, DEFAULT_ID)["bundled"] is True


def test_delete_in_use_rejected(store, config, entry):
    entry_data, contents = entry
    install_entry(config, entry_data, contents)
    store.set_in_use_checker(lambda model_id: model_id == DEFAULT_ID)
    assert store.is_in_use(DEFAULT_ID) is True
    with pytest.raises(ModelError) as error:
        store.delete(DEFAULT_ID)
    assert error.value.code == "model_in_use"
    assert error.value.status_code == 409
    assert (config.models_dir / DEFAULT_LOCAL_DIR).exists()
    store.set_in_use_checker(lambda model_id: False)
    store.delete(DEFAULT_ID)
    assert not (config.models_dir / DEFAULT_LOCAL_DIR).exists()


def test_import_overwrites_installed_model(store, config, entry, tmp_path):
    entry_data, contents = entry
    install_entry(config, entry_data, contents)
    source = _write_dir(tmp_path / "src2", contents)
    store.import_model(DEFAULT_ID, str(source))
    assert model_item(store, DEFAULT_ID)["status"] == "ready"


def test_update_in_use_rejected(store, config, entry):
    entry_data, contents = entry
    install_entry(config, entry_data, contents, marker_revision="old-revision")
    assert model_item(store, DEFAULT_ID)["update_available"] is True
    store.set_in_use_checker(lambda model_id: True)
    with pytest.raises(ModelError) as error:
        store.download(DEFAULT_ID)
    assert error.value.code == "model_in_use"
    assert error.value.status_code == 409


def test_update_available_after_import(store, config, entry, tmp_path):
    entry_data, contents = entry
    install_entry(config, entry_data, contents, marker_revision="old-revision")
    item = model_item(store, DEFAULT_ID)
    assert item["status"] == "ready"
    assert item["update_available"] is True
    source = _write_dir(tmp_path / "src", contents)
    store.import_model(DEFAULT_ID, str(source))
    item = model_item(store, DEFAULT_ID)
    assert item["update_available"] is False
