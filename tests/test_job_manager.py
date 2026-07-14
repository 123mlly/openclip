import json
from datetime import datetime
from pathlib import Path

from job_manager import JobManager, JobStatus


def _job_payload(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_job(path: Path, **overrides) -> dict:
    payload = {
        "id": "job-1",
        "video_source": "https://example.com/watch?v=1",
        "options": {},
        "status": "processing",
        "progress": 70,
        "current_step": "Generating video clips...",
        "result": None,
        "error": None,
        "created_at": datetime.now().isoformat(),
        "started_at": datetime.now().isoformat(),
        "completed_at": None,
    }
    payload.update(overrides)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return payload



def test_list_jobs_filters_by_owner_session(tmp_path):
    manager = JobManager(str(tmp_path))
    owner_a = manager.create_job("/tmp/a.mp4", {"owner_session_id": "owner-a"})
    owner_b = manager.create_job("/tmp/b.mp4", {"owner_session_id": "owner-b"})
    legacy = manager.create_job("/tmp/legacy.mp4", {})

    owner_jobs = manager.list_jobs(owner_session_id="owner-a", limit=10)

    assert [job.id for job in owner_jobs] == [owner_a]
    assert legacy not in [job.id for job in owner_jobs]
    assert owner_b not in [job.id for job in owner_jobs]



def test_get_stats_filters_by_owner_session(tmp_path):
    manager = JobManager(str(tmp_path))
    job_id = manager.create_job("/tmp/a.mp4", {"owner_session_id": "owner-a"})
    job = manager.get_job(job_id)
    assert job is not None
    job.status = JobStatus.COMPLETED
    manager._save_job(job)
    manager.create_job("/tmp/b.mp4", {"owner_session_id": "owner-b"})

    stats = manager.get_stats(owner_session_id="owner-a")

    assert stats == {
        "total": 1,
        "pending": 0,
        "processing": 0,
        "completed": 1,
        "failed": 0,
        "cancelled": 0,
    }



def test_retry_job_returns_none_when_upload_source_deleted(tmp_path):
    manager = JobManager(str(tmp_path))
    job_id = manager.create_job(
        "/tmp/upload.mp4",
        {
            "owner_session_id": "owner-a",
            "source_kind": "uploaded_file",
            "source_deleted": True,
        },
    )

    assert manager.retry_job(job_id) is None



def test_mark_upload_deleted_updates_jobs_and_disables_retry(tmp_path):
    manager = JobManager(str(tmp_path))
    job_id = manager.create_job(
        "/tmp/upload.mp4",
        {
            "owner_session_id": "owner-a",
            "source_kind": "uploaded_file",
            "upload_id": "upload-1",
            "source_deleted": False,
        },
    )

    manager.mark_upload_deleted("upload-1")

    payload = _job_payload(tmp_path / f"{job_id}.json")
    assert payload["options"]["source_deleted"] is True
    assert manager.retry_job(job_id) is None



def test_has_active_upload_reference_only_counts_pending_or_processing(tmp_path):
    manager = JobManager(str(tmp_path))
    pending_job = manager.create_job("/tmp/upload.mp4", {"upload_id": "upload-1"})
    assert manager.has_active_upload_reference("upload-1") is True

    job = manager.get_job(pending_job)
    assert job is not None
    job.status = JobStatus.COMPLETED
    manager._save_job(job)

    assert manager.has_active_upload_reference("upload-1") is False


def test_retry_job_preserves_owner_metadata_when_source_exists(tmp_path):
    manager = JobManager(str(tmp_path))
    job_id = manager.create_job(
        "/tmp/upload.mp4",
        {
            "owner_session_id": "owner-a",
            "source_kind": "uploaded_file",
            "upload_id": "upload-1",
            "source_deleted": False,
        },
    )

    retried_job_id = manager.retry_job(job_id)

    assert retried_job_id is not None
    retried_job = manager.get_job(retried_job_id)
    assert retried_job is not None
    assert retried_job.options["owner_session_id"] == "owner-a"
    assert retried_job.options["upload_id"] == "upload-1"
    assert retried_job.options["source_kind"] == "uploaded_file"


def test_load_persists_interrupted_pipeline_job_as_failed(tmp_path):
    job_path = tmp_path / "job-1.json"
    _write_job(job_path)

    manager = JobManager(str(tmp_path))

    payload = _job_payload(job_path)
    assert payload["status"] == "failed"
    assert payload["error"] == "Interrupted by server restart"
    assert payload["current_step"] == "Interrupted by server restart"
    assert payload["completed_at"] is not None
    assert manager.get_job("job-1") is None
    assert manager.list_jobs()[0].status == JobStatus.FAILED


def test_load_persists_interrupted_editor_job_as_recoverable(tmp_path):
    job_path = tmp_path / "job-1.json"
    _write_job(
        job_path,
        options={"kind": "editor_rerender", "project_id": "p1", "clip_id": "c1"},
    )

    manager = JobManager(str(tmp_path))

    payload = _job_payload(job_path)
    assert payload["status"] == "pending"
    assert payload["current_step"] == "Interrupted - ready to restart"
    assert payload["error"] is None
    job = manager.get_job("job-1")
    assert job is not None
    assert job.status == JobStatus.PENDING
    assert job.current_step == "Interrupted - ready to restart"

