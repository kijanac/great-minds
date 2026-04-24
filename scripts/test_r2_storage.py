"""Exercise R2Storage against an in-memory S3 mock (moto).

Patches boto3 in-process — no Docker, no network, no real R2. Runs the
full Storage Protocol surface so the R2 code path is covered by CI even
when a live bucket isn't available.

Usage:
    uv run python scripts/test_r2_storage.py
"""

import os
import sys

BUCKET = "test-bucket"
PREFIX = "brains/11111111-1111-1111-1111-111111111111"
FAKE_ACCOUNT = "fake"
FAKE_ENDPOINT = f"https://{FAKE_ACCOUNT}.r2.cloudflarestorage.com"

# Moto only intercepts S3-shaped requests when the endpoint is either the
# AWS default or explicitly registered as a custom S3 endpoint. R2Storage
# points at an R2 hostname, so we register it before importing boto3.
os.environ["MOTO_S3_CUSTOM_ENDPOINTS"] = FAKE_ENDPOINT

import boto3  # noqa: E402
from moto import mock_aws  # noqa: E402

from great_minds.core.storage import R2Storage  # noqa: E402

_failures: list[str] = []


def _check(label: str, ok: bool) -> None:
    status = "PASS" if ok else "FAIL"
    print(f"{status}  {label}")
    if not ok:
        _failures.append(label)


def _make_storage() -> R2Storage:
    return R2Storage(
        account_id=FAKE_ACCOUNT,
        access_key_id="fake",
        secret_access_key="fake",
        bucket=BUCKET,
        prefix=PREFIX,
    )


def main() -> int:
    with mock_aws():
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=BUCKET)
        s = _make_storage()

        s.write("wiki/foo.md", "hello")
        _check("write then read roundtrip", s.read("wiki/foo.md") == "hello")

        _check(
            "read missing strict=False returns None",
            s.read("wiki/missing.md", strict=False) is None,
        )

        try:
            s.read("wiki/missing.md", strict=True)
            _check("read missing strict=True raises FileNotFoundError", False)
        except FileNotFoundError:
            _check("read missing strict=True raises FileNotFoundError", True)

        _check("exists existing", s.exists("wiki/foo.md") is True)
        _check("exists missing", s.exists("wiki/missing.md") is False)

        s.write("wiki/bar.md", "x")
        s.write("wiki/subdir/baz.md", "y")
        _check(
            "glob single-level excludes subdirectories",
            sorted(s.glob("wiki/*.md")) == ["wiki/bar.md", "wiki/foo.md"],
        )

        s.write("raw/lenin/01.md", "a")
        s.write("raw/lenin/works/1893/02.md", "b")
        _check(
            "glob recursive descends all levels",
            sorted(s.glob("raw/**/*.md"))
            == ["raw/lenin/01.md", "raw/lenin/works/1893/02.md"],
        )

        s.append("log.md", "line1\n")
        _check("append creates file when missing", s.read("log.md") == "line1\n")
        s.append("log.md", "line2\n")
        _check(
            "append concatenates onto existing file",
            s.read("log.md") == "line1\nline2\n",
        )

        s.mkdir("some/dir")
        _check("mkdir is a no-op and does not raise", True)

        s.delete("wiki/foo.md")
        _check("delete removes the file", s.exists("wiki/foo.md") is False)

        try:
            s.delete("wiki/never-existed.md", missing_ok=True)
            _check("delete missing with missing_ok=True is a no-op", True)
        except Exception:
            _check("delete missing with missing_ok=True is a no-op", False)

        raw = boto3.client("s3", region_name="us-east-1").get_object(
            Bucket=BUCKET, Key=f"{PREFIX}/log.md"
        )
        _check(
            "keys land under the brain prefix",
            raw["Body"].read().decode("utf-8") == "line1\nline2\n",
        )

    if _failures:
        print(f"\n{len(_failures)} failing check(s):")
        for f in _failures:
            print(f"  - {f}")
        return 1
    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
