"""Convert a PDF to markdown using markitdown.

Usage:
    uv run python scrapers/pdf_to_md.py path/to/file.pdf                  # writes path/to/file.md
    uv run python scrapers/pdf_to_md.py path/to/file.pdf -o output.md     # explicit output path
"""

import argparse
from pathlib import Path

from markitdown import MarkItDown


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert PDF to markdown")
    parser.add_argument("pdf", type=Path, help="Path to the PDF file")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Output markdown path (default: same name with .md)",
    )
    args = parser.parse_args()

    if not args.pdf.exists():
        raise SystemExit(f"File not found: {args.pdf}")

    output = args.output or args.pdf.with_suffix(".md")

    result = MarkItDown().convert(str(args.pdf))
    output.write_text(result.text_content, encoding="utf-8")
    print(f"{args.pdf} -> {output} ({len(result.text_content)} chars)")


if __name__ == "__main__":
    main()
