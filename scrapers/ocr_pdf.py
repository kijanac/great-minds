"""OCR scanned PDFs using PaddleOCR and assemble into markdown.

Two-step process:
1. Run paddleocr via uvx to produce per-page JSON files
2. Assemble JSON text into a single markdown file

Usage:
    uv run python scrapers/ocr_pdf.py /tmp/file.pdf -o corpus/copeland/output.md
    uv run python scrapers/ocr_pdf.py /tmp/file.pdf  # writes /tmp/file.md
"""

import argparse
import json
import logging
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)


def assemble_markdown(json_dir: Path, pdf_stem: str) -> str:
    """Read per-page JSON files and assemble into markdown text."""
    pages: list[tuple[int, str]] = []

    for f in json_dir.glob(f"{pdf_stem}_*_res.json"):
        # Extract page number from filename like "stem_0_res.json"
        parts = f.stem.replace(f"{pdf_stem}_", "").replace("_res", "")
        page_num = int(parts)

        data = json.loads(f.read_text())
        texts = data.get("rec_texts", [])
        page_text = "\n".join(texts)
        pages.append((page_num, page_text))

    pages.sort(key=lambda x: x[0])
    return "\n\n---\n\n".join(text for _, text in pages)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    parser = argparse.ArgumentParser(description="OCR a scanned PDF to markdown")
    parser.add_argument("pdf", type=Path, help="Path to the PDF file")
    parser.add_argument("-o", "--output", type=Path, help="Output markdown path")
    args = parser.parse_args()

    if not args.pdf.exists():
        raise SystemExit(f"File not found: {args.pdf}")

    output = args.output or args.pdf.with_suffix(".md")
    tmp_dir = Path(f"/tmp/paddleocr-{args.pdf.stem}")

    # Step 1: Run paddleocr
    log.info("running paddleocr on %s", args.pdf)
    result = subprocess.run(
        [
            "uvx",
            "--python",
            "3.13",
            "--with",
            "paddlepaddle",
            "paddleocr",
            "ocr",
            "-i",
            str(args.pdf),
            "--save_path",
            str(tmp_dir),
        ],
        capture_output=True,
        text=True,
        env={
            "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK": "True",
            "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        },
    )

    if result.returncode != 0:
        log.error("paddleocr failed:\n%s", result.stderr[-1000:])
        raise SystemExit(1)

    # Step 2: Assemble markdown
    log.info("assembling markdown from %s", tmp_dir)
    markdown = assemble_markdown(tmp_dir, args.pdf.stem)

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(markdown, encoding="utf-8")
    log.info("wrote %s (%d chars)", output, len(markdown))


if __name__ == "__main__":
    main()
