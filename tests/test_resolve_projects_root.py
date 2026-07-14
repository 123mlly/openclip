from pathlib import Path

from web_api import resolve_projects_root


def test_resolve_projects_root_falls_back_from_foreign_absolute_path(tmp_path, monkeypatch):
    default = tmp_path / "processed_videos"
    default.mkdir()
    monkeypatch.chdir(tmp_path)

    foreign = "/Users/other/Documents/openclip/processed_videos"
    assert resolve_projects_root(foreign, str(default)) == str(default.resolve())


def test_resolve_projects_root_keeps_existing_relative_path(tmp_path, monkeypatch):
    default = tmp_path / "processed_videos"
    default.mkdir()
    monkeypatch.chdir(tmp_path)

    assert resolve_projects_root("processed_videos", str(default)) == str(default.resolve())


def test_resolve_projects_root_defaults_when_missing(tmp_path):
    default = tmp_path / "processed_videos"
    default.mkdir()
    assert resolve_projects_root(None, str(default)) == str(default.resolve())
