"""Upload corpus/ directory to Cloudflare R2.

Reads R2 credentials from .env and uploads all files under corpus/
preserving the directory structure as the S3 key prefix.

Usage:
    uv run python scrapers/upload_corpus.py              # upload everything
    uv run python scrapers/upload_corpus.py corpus/lenin  # upload a subdirectory
"""

import argparse
import logging
import os
import sys
from pathlib import Path

import boto3
from dotenv import load_dotenv

log = logging.getLogger(__name__)

CORPUS_DIR = Path("corpus")


def get_client():
    load_dotenv()

    account_id = os.environ["R2_ACCOUNT_ID"]
    access_key = os.environ["R2_ACCESS_KEY_ID"]
    secret_key = os.environ["R2_SECRET_ACCESS_KEY"]

    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )


def upload(root: Path) -> None:
    load_dotenv()
    bucket = os.environ["R2_BUCKET_NAME"]
    client = get_client()

    files = sorted(root.rglob("*"))
    files = [f for f in files if f.is_file() and not f.name.startswith(".")]

    log.info("uploading %d files from %s to r2://%s/", len(files), root, bucket)

    uploaded = 0
    skipped = 0

    for filepath in files:
        key = str(filepath)
        content_type = (
            "application/json" if filepath.suffix == ".json" else "text/markdown"
        )

        try:
            client.upload_file(
                str(filepath),
                bucket,
                key,
                ExtraArgs={"ContentType": content_type},
            )
            uploaded += 1

            if uploaded % 200 == 0:
                log.info("progress: %d / %d", uploaded, len(files))
        except Exception:
            log.exception("failed to upload %s", key)
            skipped += 1

    log.info("done — %d uploaded, %d failed", uploaded, skipped)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    parser = argparse.ArgumentParser(description="Upload corpus to R2")
    parser.add_argument(
        "path",
        nargs="?",
        default=str(CORPUS_DIR),
        help="Directory to upload (default: corpus/)",
    )
    args = parser.parse_args()

    root = Path(args.path)
    if not root.exists():
        log.error("path does not exist: %s", root)
        sys.exit(1)

    upload(root)


if __name__ == "__main__":
    main()
