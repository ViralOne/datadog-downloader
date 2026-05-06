# DataDog Log Downloader

Bulk download DataDog logs via the API. Supports flat file export (JSON/NDJSON) and DD-compatible archive format with parallel S3 upload.

## Quick Start

```bash
npm install
cp .env.example .env  # add your DD_API_KEY and DD_APP_KEY
```

## Authentication

Set environment variables (or use a `.env` file):
- `DD_API_KEY` — API key from Organization Settings > API Keys
- `DD_APP_KEY` — App key from Personal Settings > Application Keys

### AWS Credentials (for S3 upload)

The AWS SDK picks up credentials automatically. Any of these work:

**Option A** — Add to your `.env` file:
```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

**Option B** — Use a named profile:
```bash
AWS_PROFILE=my-profile node index.mjs --query '*' --format archive --s3Bucket my-bucket
```

**Option C** — IAM role (if running on EC2/ECS).

The script only needs `s3:PutObject` permission on your target bucket.

## Usage

### Basic download (NDJSON)

```bash
node index.mjs --query '*' --from 2025-04-06 --to 2025-05-06
```

### DD-compatible archive (local)

```bash
node index.mjs --query '*' --from 2025-04-06 --format archive --output logs
```

Produces:
```
logs/
  dt=20250406/hour=00/archive_143201.0042.a1b2c3d4-....json.gz
  dt=20250406/hour=01/archive_143205.0012.e5f6g7h8-....json.gz
  ...
```

### Archive + parallel S3 upload

```bash
node index.mjs --query '*' --from 2025-04-06 --format archive --output logs \
  --s3Bucket my-log-archive \
  --s3Prefix datadog/backfill \
  --s3Region eu-west-1 \
  --s3Concurrency 8
```

Downloads from DD and uploads to S3 in parallel. By the time the download finishes, most files are already in S3.

### Download from Flex Logs (longer retention)

```bash
node index.mjs --query 'service:api' --from 2025-01-01 --storageTier flex --site eu
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--query` | Datadog search query (required) | — |
| `--index` | Log index to read from | `main` |
| `--from` | Start date (e.g. `2025-04-06`) | 1 year ago |
| `--to` | End date | now |
| `--pageSize` | Results per page (max 5000) | `1000` |
| `--output` | Output file/directory path | `results.json` |
| `--format` | `json`, `ndjson`, or `archive` | `ndjson` |
| `--cursor` | Resume from cursor position | — |
| `--append` | Append to output file (ndjson only) | `false` |
| `--storageTier` | `indexes`, `online-archives`, or `flex` | — |
| `--site` | Datadog site (see below) | `datadoghq.com` |
| `--s3Bucket` | S3 bucket name for upload | — |
| `--s3Prefix` | S3 key prefix | `""` |
| `--s3Region` | AWS region | `eu-west-1` |
| `--s3Concurrency` | Parallel S3 upload threads | `4` |

### Site shortcuts

| Shortcut | Resolves to |
|----------|-------------|
| `eu` | `datadoghq.eu` |
| `us3` | `us3.datadoghq.com` |
| `us5` | `us5.datadoghq.com` |
| `gov` | `ddog-gov.com` |
| `ap1` | `ap1.datadoghq.com` |

## Archive Format

Matches Datadog's native archive structure:

```
<prefix>/dt=YYYYMMDD/hour=HH/archive_HHmmss.SSSS.<uuid>.json.gz
```

Each `.json.gz` file contains a JSON array of log objects. This is the same format DD's built-in Archive feature writes, so you can:
- Query with Athena/Spark using the date/hour partitioning
- Place alongside DD's own archive output in the same bucket
- Rehydrate back into DD (if using their rehydration feature)

## Features

- **Rate limit handling** — Exponential backoff on HTTP 429 (1s → 60s, up to 10 retries)
- **Crash recovery** — Cursor auto-saved on crash/SIGINT. Resumes automatically on next run.
- **Streaming archive** — Partitions flush to disk every 5000 logs (low memory for large exports)
- **Parallel S3 upload** — Uploads happen concurrently with downloads (configurable concurrency)
- **Flex Logs support** — `--storageTier flex` for longer-retention data
- **Multi-region** — All Datadog sites via `--site` flag

## Examples

```bash
# Dump all logs from last 30 days as NDJSON
node index.mjs --query '*' --from 2025-04-06

# Archive specific service to S3
node index.mjs --query 'service:payments' --from 2025-04-01 --format archive \
  --output payments-archive --s3Bucket my-logs --s3Prefix archives/payments

# EU site, high concurrency
node index.mjs --query '*' --from 2025-04-01 --site eu --format archive \
  --output logs --s3Bucket my-eu-bucket --s3Region eu-central-1 --s3Concurrency 16

# Resume after crash (automatic)
node index.mjs --query '*' --from 2025-04-01 --format archive --output logs
```
