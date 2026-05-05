# Remaining Optimization Ideas

## High impact, complex (require code changes)

- **Replace markitdown with lighter HTML→markdown converter**: Would drop onnxruntime (43MB) + magika (3MB). Options: `html2text`, `beautifulsoup4` (already a dep), or custom converter. The ingest_service.py uses markitdown for URL→markdown and file→markdown conversion. Could be replaced with BeautifulSoup + markdownify (already a dep).

- **Replace boto3 with lighter S3 client**: botocore is 27MB (includes service models for ALL AWS services). Options: `aioboto3` (team rejected due to sync issues), direct HTTP to R2 API, or stripped botocore with only S3 service model. High risk, core functionality.

## Moderate impact, moderate complexity

- **Remove SQLAlchemy dialects not used**: SQLAlchemy ships PostgreSQL, MySQL, SQLite, Oracle, MSSQL drivers. Removing unused dialects could save 3-5MB. Risk: SQLAlchemy introspection might need them.

## Low impact, simple (already done or near limit)

- **Remove remaining .so files with debug info**: Already stripped with `strip --strip-unneeded`
- **Compile .py→.pyc**: Backfired due to triple .pyc files per source
- **Smaller base image**: Alpine blocked by onnxruntime (no musl wheels), bare debian blocked by glibc mismatch
