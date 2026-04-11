#!/usr/bin/env python3
"""Transcribe an MP3 file in diarized mode via a Modal-hosted Parakeet API.

Usage:
    python scripts/transcribe.py audio.mp3
    python scripts/transcribe.py audio.mp3 --mode plain

Environment variables:
    TRANSCRIPTION_API_URL          Base URL for plain transcription endpoint
    TRANSCRIPTION_API_KEY          API key for plain transcription
    DIARIZED_TRANSCRIPTION_API_URL Base URL for diarized endpoint (Parakeet + diarization)
    DIARIZED_TRANSCRIPTION_API_KEY API key for diarized endpoint
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx

RETRIES = 3
Mode = Literal["plain", "diarize"]


@dataclass
class Config:
    file_path: Path
    api_url: str | None
    api_key: str
    diarized_api_url: str | None = None
    diarized_api_key: str | None = None
    mode: Mode = "diarize"

    def progress(self, msg: str) -> None:
        print(msg, file=sys.stderr)


def _to_flac(src: Path, dst: Path) -> None:
    """Convert any audio file to 16 kHz mono FLAC."""
    result = subprocess.run(
        [
            "ffmpeg", "-i", str(src),
            "-vn", "-acodec", "flac",
            "-ar", "16000", "-ac", "1",
            "-y", str(dst),
        ],
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg conversion failed: {result.stderr.decode(errors='replace')[-200:]}"
        )


def format_timestamp(seconds: float) -> str:
    """Format seconds as [HH:]MM:SS."""
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def _call_diarize_api(config: Config, audio_path: Path) -> str:
    """POST audio to the diarize endpoint and stream NDJSON utterances."""
    base_url = config.diarized_api_url
    auth_key = config.diarized_api_key

    for attempt in range(RETRIES):
        try:
            with (
                open(audio_path, "rb") as f,
                httpx.stream(
                    "POST",
                    f"{base_url}/diarize",
                    params={"stream": "true"},
                    files={"audio_file": (audio_path.name, f, "audio/flac")},
                    headers={"Authorization": f"Bearer {auth_key}"},
                    timeout=None,
                ) as response,
            ):
                if response.status_code == 200:
                    lines: list[str] = []
                    for raw_line in response.iter_lines():
                        if not raw_line.strip():
                            continue
                        utterance = json.loads(raw_line)
                        speaker = utterance.get("speaker", "")
                        text = utterance.get("text", "")
                        start = utterance.get("start", 0)
                        if text.strip():
                            ts = format_timestamp(float(start))
                            lines.append(f"[{ts}] {speaker}: {text.strip()}")
                    return "\n".join(lines)
                if response.status_code < 500:
                    response.read()
                    raise RuntimeError(
                        f"Diarize API error {response.status_code}: {response.text[:200]}"
                    )
                print(f"Retry {attempt + 1}/{RETRIES} after {response.status_code}", file=sys.stderr)
        except httpx.RequestError as e:
            if attempt == RETRIES - 1:
                raise RuntimeError("Diarize request failed after retries.") from e
            print(f"Retry {attempt + 1}/{RETRIES} after {e}", file=sys.stderr)

    raise RuntimeError("Diarize API failed after retries.")


def _call_plain_api(config: Config, audio_path: Path) -> str:
    """POST audio to the plain transcription endpoint."""
    base_url = config.api_url
    auth_key = config.api_key

    with httpx.Client(timeout=None, headers={"Authorization": f"Bearer {auth_key}"}) as client:
        for attempt in range(RETRIES):
            try:
                with open(audio_path, "rb") as f:
                    response = client.post(
                        f"{base_url}/transcribe",
                        files={"audio_file": (audio_path.name, f, "audio/flac")},
                    )
                if response.status_code == 200:
                    data = response.json()
                    transcript = data.get("transcript")
                    if not isinstance(transcript, str):
                        raise RuntimeError("API 200 response missing string 'transcript'.")
                    return transcript
                if response.status_code < 500:
                    raise RuntimeError(
                        f"Transcription API error {response.status_code}: {response.text[:200]}"
                    )
                print(f"Retry {attempt + 1}/{RETRIES} after {response.status_code}", file=sys.stderr)
            except httpx.RequestError as e:
                if attempt == RETRIES - 1:
                    raise RuntimeError("Transcription request failed after retries.") from e
                print(f"Retry {attempt + 1}/{RETRIES} after {e}", file=sys.stderr)

    raise RuntimeError("Transcription API failed after retries.")


def transcribe(config: Config) -> str:
    """Convert the MP3 to FLAC and send it to the appropriate API."""
    with tempfile.TemporaryDirectory() as tmpdir:
        flac_path = Path(tmpdir) / config.file_path.with_suffix(".flac").name
        config.progress(f"Converting {config.file_path.name} to FLAC...")
        _to_flac(config.file_path, flac_path)

        if config.mode == "diarize":
            if not config.diarized_api_url:
                raise RuntimeError("DIARIZED_TRANSCRIPTION_API_URL is required for diarize mode.")
            if not config.diarized_api_key:
                raise RuntimeError("DIARIZED_TRANSCRIPTION_API_KEY is required for diarize mode.")
            config.progress("Transcribing with speaker separation (Parakeet + diarization)...")
            return _call_diarize_api(config, flac_path)

        if not config.api_url:
            raise RuntimeError("TRANSCRIPTION_API_URL is required for plain mode.")
        config.progress("Transcribing...")
        return _call_plain_api(config, flac_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Diarized MP3 transcription via Modal Parakeet API")
    parser.add_argument("mp3", help="Path to the MP3 file to transcribe")
    parser.add_argument("--mode", choices=["plain", "diarize"], default="diarize")
    parser.add_argument("--api-url", default=os.environ.get("TRANSCRIPTION_API_URL"))
    parser.add_argument("--api-key", default=os.environ.get("TRANSCRIPTION_API_KEY", ""))
    parser.add_argument("--diarized-api-url", default=os.environ.get("DIARIZED_TRANSCRIPTION_API_URL"))
    parser.add_argument("--diarized-api-key", default=os.environ.get("DIARIZED_TRANSCRIPTION_API_KEY"))
    args = parser.parse_args()

    file_path = Path(args.mp3)
    if not file_path.exists():
        print(f"Error: file not found: {args.mp3}", file=sys.stderr)
        sys.exit(1)

    if args.mode == "diarize" and not args.diarized_api_url:
        print("Error: DIARIZED_TRANSCRIPTION_API_URL is required for diarize mode", file=sys.stderr)
        sys.exit(1)
    if args.mode == "plain" and not args.api_url:
        print("Error: TRANSCRIPTION_API_URL is required for plain mode", file=sys.stderr)
        sys.exit(1)

    config = Config(
        file_path=file_path,
        api_url=args.api_url,
        api_key=args.api_key or "",
        diarized_api_url=args.diarized_api_url,
        diarized_api_key=args.diarized_api_key,
        mode=args.mode,
    )

    print(transcribe(config))


if __name__ == "__main__":
    main()
