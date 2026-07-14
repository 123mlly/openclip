#!/usr/bin/env python3
"""
Whisper Transcript Generation via faster-whisper (CTranslate2).
"""

from __future__ import annotations

import logging
import os
import re
import sys
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from faster_whisper import WhisperModel

from core.config import TRANSCRIPT_LANGUAGE_DETECT_MODEL, WHISPER_MODEL
from core.transcript_generation_paraformer import ParaformerTranscriptProcessor

logger = logging.getLogger(__name__)

try:
    from core.transcript_generation_whisperx import TranscriptProcessorWhisperX, WHISPERX_AVAILABLE
except ImportError:
    WHISPERX_AVAILABLE = False

# openai-whisper style aliases → faster-whisper / Hugging Face CTranslate2 ids
_FASTER_WHISPER_MODEL_ALIASES = {
    "turbo": "large-v3-turbo",
    "large": "large-v3",
}

_model_cache: dict[Tuple[str, str, str], WhisperModel] = {}
_model_lock = threading.Lock()


def select_transcript_backend(
    detected_language: str,
    paraformer_available: bool,
    use_whisperx: bool,
) -> str:
    """Choose the transcript backend for a detected language."""
    language = (detected_language or "").lower()
    if language.startswith("zh") and paraformer_available:
        return "paraformer"
    return "whisperx" if use_whisperx else "whisper"


def summarize_transcript_sources(sources: List[str]) -> str:
    """Summarize one or more transcript source names into a display value."""
    unique_sources = []
    for source in sources:
        if source and source not in unique_sources:
            unique_sources.append(source)
    if not unique_sources:
        return "unknown"
    if len(unique_sources) == 1:
        return unique_sources[0]
    return "mixed:" + ",".join(unique_sources)


def build_whisper_initial_prompt(language: Optional[str]) -> Optional[str]:
    """Return a style prompt for Whisper when a language benefits from steering."""
    normalized = (language or "").strip().lower()
    if normalized.startswith("zh") or normalized == "chinese":
        return "以下是普通话的简体中文字幕。"
    return None


def resolve_faster_whisper_model_name(model_name: str) -> str:
    """Map legacy openai-whisper names onto faster-whisper model ids."""
    key = (model_name or "").strip()
    return _FASTER_WHISPER_MODEL_ALIASES.get(key, key or WHISPER_MODEL)


def _resolve_device_and_compute_type() -> Tuple[str, str]:
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"


def _get_faster_whisper_model(model_name: str) -> WhisperModel:
    resolved = resolve_faster_whisper_model_name(model_name)
    device, compute_type = _resolve_device_and_compute_type()
    cache_key = (resolved, device, compute_type)
    with _model_lock:
        cached = _model_cache.get(cache_key)
        if cached is not None:
            return cached
        logger.info(
            "Loading faster-whisper model=%s device=%s compute_type=%s",
            resolved,
            device,
            compute_type,
        )
        model = WhisperModel(resolved, device=device, compute_type=compute_type)
        _model_cache[cache_key] = model
        return model


def _format_srt_timestamp(seconds: float) -> str:
    total_ms = max(0, int(round(float(seconds) * 1000)))
    hours, rem = divmod(total_ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def write_faster_whisper_srt(segments: List[Any], output_path: Path) -> None:
    """Write faster-whisper segments to an SRT file."""
    lines: List[str] = []
    index = 1
    for segment in segments:
        text = (getattr(segment, "text", None) or "").strip()
        if not text:
            continue
        start = float(getattr(segment, "start", 0.0) or 0.0)
        end = float(getattr(segment, "end", start) or start)
        if end <= start:
            end = start + 0.5
        lines.append(str(index))
        lines.append(f"{_format_srt_timestamp(start)} --> {_format_srt_timestamp(end)}")
        lines.append(text)
        lines.append("")
        index += 1
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines).rstrip() + ("\n" if lines else ""), encoding="utf-8")


def run_whisper_cli(
    file_path,
    model_name=WHISPER_MODEL,
    language=None,
    output_format="srt",
    output_dir=None,
):
    """
    Transcribe audio/video with faster-whisper and write sidecar transcript files.

    Kept name `run_whisper_cli` for backward compatibility with callers/tests.
    Currently supports `srt` (primary pipeline format). Other formats fall back to SRT.
    """
    media_path = Path(file_path)
    if not media_path.exists():
        logger.error("Media file not found: %s", media_path)
        return False

    fmt = (output_format or "srt").lower()
    if fmt not in {"srt", "all"}:
        logger.warning("faster-whisper path currently emits SRT only; requested format=%s", fmt)

    target_dir = Path(output_dir) if output_dir else media_path.parent
    target_dir.mkdir(parents=True, exist_ok=True)
    srt_path = target_dir / f"{media_path.stem}.srt"

    print(f"🎵 Transcribing: {file_path}")
    print(f"📊 Model: {resolve_faster_whisper_model_name(model_name)} (faster-whisper)")
    print("📝 Output format: srt")
    if language:
        print(f"🌍 Language: {language}")
    else:
        print("🔍 Language: Auto-detection")

    initial_prompt = build_whisper_initial_prompt(language)
    if initial_prompt:
        print("🈶 Script preference: Simplified Chinese")

    try:
        print("\n⏳ Running faster-whisper...")
        print("-" * 50)
        model = _get_faster_whisper_model(model_name)
        segments_iter, info = model.transcribe(
            str(media_path),
            language=language,
            task="transcribe",
            beam_size=5,
            vad_filter=True,
            initial_prompt=initial_prompt,
        )
        segments = list(segments_iter)
        write_faster_whisper_srt(segments, srt_path)
        detected = getattr(info, "language", None)
        if detected:
            print(f"🔎 Detected language: {detected}")
        print("-" * 50)
        print(f"✅ Transcription completed successfully! → {srt_path.name}")
        return srt_path.exists()
    except Exception as exc:
        print("-" * 50)
        print(f"❌ Transcription failed: {exc}")
        logger.exception("faster-whisper transcription failed for %s", media_path)
        return False


def demonstrate_whisper():
    """Demonstrate faster-whisper usage examples."""
    print("=== faster-whisper Demo ===\n")
    sample_file = "../video_sample.mp4"
    if os.path.exists(sample_file):
        print("📁 Found sample video file!")
        print("\n--- Example 1: Basic transcription (tiny model, fast) ---")
        success = run_whisper_cli(sample_file, model_name="tiny")
        if success:
            base_name = os.path.splitext(os.path.basename(sample_file))[0]
            srt_file = f"{base_name}.srt"
            if os.path.exists(srt_file):
                print(f"\n📄 Transcript saved to: {srt_file}")
    else:
        print("📂 No sample file found. Here are usage examples:")

    print("\n🎯 Usage Examples:")
    print("1. Basic transcription:")
    print("   python -m core.transcript_generation_whisper audio.mp3")
    print("\n2. Specify model size:")
    print("   python -m core.transcript_generation_whisper audio.mp3 small")
    print("\n📏 Available Models (speed vs accuracy):")
    for model, desc in [
        ("tiny", "Fastest, least accurate"),
        ("base", "Good balance"),
        ("small", "Better accuracy"),
        ("medium", "High accuracy"),
        ("large", "Maps to large-v3"),
        ("turbo", "Maps to large-v3-turbo"),
    ]:
        print(f"   • {model}: {desc}")


def simple_transcribe(audio_file, model="base"):
    """Simple function to transcribe an audio file."""
    if not os.path.exists(audio_file):
        print(f"❌ File not found: {audio_file}")
        return False
    return run_whisper_cli(audio_file, model_name=model)


class TranscriptProcessor:
    """Handles all transcript-related operations."""

    def __init__(
        self,
        whisper_model: str = WHISPER_MODEL,
        language: Optional[str] = None,
        enable_diarization: bool = False,
        speaker_references_dir: Optional[str] = None,
    ):
        self.whisper_model = whisper_model
        self.language = language  # None = auto-detect
        self.enable_diarization = enable_diarization
        self.language_detection_model = TRANSCRIPT_LANGUAGE_DETECT_MODEL
        # WhisperX is required for diarization; enable it automatically when requested.
        self.use_whisperx = enable_diarization and WHISPERX_AVAILABLE
        self.paraformer_processor = ParaformerTranscriptProcessor()
        self._language_detector = None

        if enable_diarization and not WHISPERX_AVAILABLE:
            logger.warning(
                "⚠️  Speaker diarization requested but WhisperX is not installed. "
                "Falling back to faster-whisper (no speaker labels). "
                "Run: uv sync --extra speakers"
            )

        self.whisperx_processor = None
        if self.use_whisperx:
            self.whisperx_processor = TranscriptProcessorWhisperX(
                whisper_model,
                enable_diarization=enable_diarization,
                speaker_references_dir=speaker_references_dir,
            )

        if self.paraformer_processor.is_available():
            logger.info(f"🈶 Chinese ASR backend: Paraformer ({self.paraformer_processor.project_dir})")
        else:
            logger.warning(
                "⚠️  Paraformer is unavailable; Chinese audio will fall back to faster-whisper. "
                f"Reason: {self.paraformer_processor.availability_error()}"
            )

    async def process_transcripts(
        self,
        subtitle_path: str,
        video_files: List[str] or str,
        force_whisper: bool,
        progress_callback: Optional[Callable[[str, float], None]],
    ) -> Dict[str, Any]:
        """Process transcripts - either use existing subtitles or generate locally."""
        has_existing = subtitle_path and os.path.exists(subtitle_path)

        if force_whisper or not has_existing:
            logger.info("📝 Generating transcripts locally with automatic language routing")
            return await self._generate_routed_transcripts(video_files, progress_callback)

        if self.whisperx_processor and self.enable_diarization:
            if self._has_speaker_labels(subtitle_path):
                logger.info("📥 Source transcript already has speaker labels, skipping diarization")
                return {
                    "source": "existing_diarized",
                    "transcript_path": subtitle_path if isinstance(video_files, str) else "",
                    "transcript_parts": [] if isinstance(video_files, str) else self._get_existing_transcript_parts(video_files),
                }
            logger.info("⚡ Using WhisperX diarization on existing transcript")
            return await self._add_speakers_to_existing(video_files, progress_callback)

        logger.info("📥 Using existing subtitles")
        return {
            "source": "bilibili" if "bilibili" in subtitle_path else "existing",
            "transcript_path": subtitle_path if isinstance(video_files, str) else "",
            "transcript_parts": [] if isinstance(video_files, str) else self._get_existing_transcript_parts(video_files),
        }

    def _get_language_detector(self) -> WhisperModel:
        if self._language_detector is None:
            self._language_detector = _get_faster_whisper_model(self.language_detection_model)
        return self._language_detector

    def _detect_transcript_language(self, media_path: str) -> str:
        media_path = str(media_path)
        try:
            detector = self._get_language_detector()
            # Short beam + VAD keeps language sniffing cheap before full transcription.
            _segments, info = detector.transcribe(
                media_path,
                task="transcribe",
                beam_size=1,
                vad_filter=True,
                language=None,
            )
            # Consume at most a couple segments so language metadata is populated.
            for _ in zip(_segments, range(2)):
                pass
            detected_language = (getattr(info, "language", None) or "en").lower()
            confidence = float(getattr(info, "language_probability", 0.0) or 0.0)
            logger.info(
                f"🔎 Transcript language for {Path(media_path).name}: "
                f"{detected_language} ({confidence:.1%})"
            )
            return detected_language
        except Exception as e:
            logger.warning(
                f"⚠️  Transcript language detection failed for {Path(media_path).name} "
                f"({e}). Falling back to English/Whisper."
            )
            return "en"

    async def _generate_routed_transcripts(
        self,
        video_files: List[str] or str,
        progress_callback: Optional[Callable[[str, float], None]],
    ) -> Dict[str, Any]:
        """Generate transcripts with Whisper for English and Paraformer for Chinese."""
        if isinstance(video_files, str):
            video_files = [video_files]

        transcript_parts = []
        transcript_sources = []
        total_files = len(video_files)

        for i, video_file in enumerate(video_files):
            video_path = Path(video_file)
            video_dir = video_path.parent
            base_progress = 35 + (i / total_files) * 13 if total_files else 35

            detected_language = self._detect_transcript_language(str(video_path))
            backend = select_transcript_backend(
                detected_language=detected_language,
                paraformer_available=self.paraformer_processor.is_available(),
                use_whisperx=self.use_whisperx,
            )

            if progress_callback:
                progress_callback(
                    f"Generating transcript {i+1}/{total_files} with {backend}...",
                    base_progress,
                )

            logger.info(
                f"🔀 Transcript backend for {video_path.name}: {backend} "
                f"(detected language: {detected_language})"
            )

            srt_path = ""
            source = backend

            try:
                if backend == "paraformer":
                    srt_path, _ = self.paraformer_processor.transcribe_chinese_to_srt(
                        str(video_path),
                        video_dir,
                    )
                    logger.info(f"✅ Paraformer generated: {Path(srt_path).name}")
                    if self.whisperx_processor and self.enable_diarization:
                        logger.info("⚡ Running WhisperX diarization on Paraformer transcript")
                        srt_path = await self.whisperx_processor.add_speakers_to_existing_transcript(
                            srt_path,
                            str(video_path),
                            progress_callback,
                        )
                        source = "paraformer_diarized"
                elif backend == "whisperx":
                    srt_path = await self.whisperx_processor.transcribe_with_whisperx(
                        str(video_path),
                        progress_callback,
                    )
                    if srt_path:
                        logger.info(f"✅ WhisperX generated: {Path(srt_path).name}")
                else:
                    success = run_whisper_cli(
                        str(video_path),
                        model_name=self.whisper_model,
                        language=detected_language,
                        output_format="srt",
                        output_dir=str(video_dir),
                    )
                    if success:
                        srt_path = str(video_dir / f"{video_path.stem}.srt")
                        logger.info(f"✅ faster-whisper generated: {Path(srt_path).name}")
            except Exception as e:
                if backend == "paraformer":
                    logger.warning(
                        f"⚠️  Paraformer failed for {video_path.name} ({e}). Falling back to faster-whisper."
                    )
                    source = "whisper_fallback"
                    success = run_whisper_cli(
                        str(video_path),
                        model_name=self.whisper_model,
                        language=detected_language,
                        output_format="srt",
                        output_dir=str(video_dir),
                    )
                    if success:
                        srt_path = str(video_dir / f"{video_path.stem}.srt")
                        logger.info(f"✅ faster-whisper fallback generated: {Path(srt_path).name}")
                else:
                    logger.error(f"❌ {backend} failed for {video_path.name}: {e}")

            if srt_path and Path(srt_path).exists():
                transcript_parts.append(str(srt_path))
                transcript_sources.append(source)
            else:
                logger.error(f"❌ Transcript generation failed for {video_path.name}")

        return {
            "source": summarize_transcript_sources(transcript_sources),
            "transcript_path": transcript_parts[0] if len(transcript_parts) == 1 else "",
            "transcript_parts": transcript_parts,
        }

    async def _generate_whisper_transcripts(
        self,
        video_files: List[str] or str,
        progress_callback: Optional[Callable[[str, float], None]],
    ) -> Dict[str, Any]:
        """Generate transcripts using faster-whisper."""
        if isinstance(video_files, str):
            video_files = [video_files]

        transcript_parts = []
        total_files = len(video_files)

        for i, video_file in enumerate(video_files):
            if progress_callback:
                base_progress = 35 + (i / total_files) * 13
                progress_callback(f"Generating transcript {i+1}/{total_files}...", base_progress)

            logger.info(f"🎙️  Generating transcript for: {Path(video_file).name}")
            video_path = Path(video_file)
            video_dir = video_path.parent

            success = run_whisper_cli(
                str(video_path),
                model_name=self.whisper_model,
                language=self.language,
                output_format="srt",
                output_dir=str(video_dir),
            )

            if success:
                srt_path = video_dir / f"{video_path.stem}.srt"
                if srt_path.exists():
                    transcript_parts.append(str(srt_path))
                    logger.info(f"✅ Generated: {srt_path.name}")
                else:
                    logger.warning(f"⚠️  SRT file not found for {video_path.name}")
            else:
                logger.error(f"❌ faster-whisper failed for {video_path.name}")

        return {
            "source": "whisper",
            "transcript_path": transcript_parts[0] if len(transcript_parts) == 1 else "",
            "transcript_parts": transcript_parts,
        }

    async def _generate_whisperx_transcripts(
        self,
        video_files: List[str] or str,
        progress_callback: Optional[Callable[[str, float], None]],
    ) -> Dict[str, Any]:
        """Generate transcripts using WhisperX (Scenario 1)."""
        if isinstance(video_files, str):
            video_files = [video_files]

        transcript_parts = []
        total_files = len(video_files)

        for i, video_file in enumerate(video_files):
            if progress_callback:
                base_progress = 35 + (i / total_files) * 13
                progress_callback(f"Transcribing {i+1}/{total_files} with WhisperX...", base_progress)

            logger.info(f"⚡ WhisperX transcribing: {Path(video_file).name}")
            srt_path = await self.whisperx_processor.transcribe_with_whisperx(video_file, progress_callback)

            if srt_path and Path(srt_path).exists():
                transcript_parts.append(srt_path)
                logger.info(f"✅ Generated: {Path(srt_path).name}")
            else:
                logger.error(f"❌ WhisperX failed for {Path(video_file).name}")

        return {
            "source": "whisperx",
            "transcript_path": transcript_parts[0] if len(transcript_parts) == 1 else "",
            "transcript_parts": transcript_parts,
        }

    async def _add_speakers_to_existing(
        self,
        video_files: List[str] or str,
        progress_callback: Optional[Callable[[str, float], None]],
    ) -> Dict[str, Any]:
        """Add speaker labels to existing SRT files via diarization (Scenario 2)."""
        if isinstance(video_files, str):
            video_files = [video_files]

        transcript_parts = []
        total_files = len(video_files)

        for i, video_file in enumerate(video_files):
            video_path = Path(video_file)
            srt_path = video_path.parent / f"{video_path.stem}.srt"

            if not srt_path.exists():
                logger.warning(f"⚠️  No subtitle found next to {video_path.name}, skipping diarization")
                continue

            if progress_callback:
                base_progress = 35 + (i / total_files) * 13
                progress_callback(f"Diarizing {i+1}/{total_files}...", base_progress)

            logger.info(f"⚡ WhisperX diarizing: {video_path.name}")
            updated_srt = await self.whisperx_processor.add_speakers_to_existing_transcript(
                str(srt_path), video_file, progress_callback
            )
            transcript_parts.append(updated_srt)

        return {
            "source": "whisperx_diarized",
            "transcript_path": transcript_parts[0] if len(transcript_parts) == 1 else "",
            "transcript_parts": transcript_parts,
        }

    def _has_speaker_labels(self, srt_path: str) -> bool:
        """Return True if the SRT file already contains [SpeakerName] prefixes."""
        try:
            with open(srt_path, "r", encoding="utf-8") as f:
                for line in f:
                    if re.match(r"^\[[A-Z]", line.strip()):
                        return True
        except (OSError, IOError):
            pass
        return False

    def _get_existing_transcript_parts(self, video_files: List[str]) -> List[str]:
        """Get existing transcript parts (they should already exist from splitting)."""
        transcript_parts = []
        for video_file in video_files:
            video_path = Path(video_file)
            srt_path = video_path.parent / f"{video_path.stem}.srt"
            if srt_path.exists():
                transcript_parts.append(str(srt_path))
            else:
                logger.warning(f"⚠️  Expected transcript not found: {srt_path}")
        return transcript_parts


def main():
    """Main function."""
    if len(sys.argv) > 1:
        audio_file = sys.argv[1]
        model = sys.argv[2] if len(sys.argv) > 2 else "base"
        print(f"🎵 Transcribing file: {audio_file}")
        simple_transcribe(audio_file, model)
    else:
        demonstrate_whisper()

    print("\n🚀 To transcribe your own file:")
    print("   python -m core.transcript_generation_whisper your_audio_file.mp3 [model]")
    print("   Example: python -m core.transcript_generation_whisper speech.wav tiny")


if __name__ == "__main__":
    main()
