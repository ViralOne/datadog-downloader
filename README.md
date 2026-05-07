# Datadog Log Downloader

Bulk download Datadog logs via the API and produce Datadog-compatible S3 archives. Supports flat file export (JSON/NDJSON) and the native archive format with parallel S3 upload — ideal for backfilling log archives or migrating historical data.

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

### Datadog-compatible archive (local)

```bash
node index.mjs --query '*' --from 2025-04-06 --format archive --output logs
```

Produces:
```
logs/
  dt=20250406/hour=00/archive_000000.0000.a1b2c3d4-....json.gz
  dt=20250406/hour=01/archive_000000.0000.e5f6g7h8-....json.gz
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

Downloads from Datadog and uploads to S3 in parallel. By the time the download finishes, most files are already in S3.

### Download from Flex Logs (longer retention)

```bash
node index.mjs --query 'service:api' --from 2025-01-01 --storageTier flex --site eu
```

## Resuming Downloads

The tool automatically saves a cursor file on crash or Ctrl+C. On the next run with the same `--output`, it resumes from where it left off:

```bash
# Start a large download
node index.mjs --query '*' --from 2025-01-01 --format archive --output logs

# Press Ctrl+C to stop — cursor is saved automatically

# Resume — just run the same command again
node index.mjs --query '*' --from 2025-01-01 --format archive --output logs
```

To start fresh, delete the cursor file (`<output>.json.cursor`).

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
| `--sort` | `timestamp` (oldest first) or `-timestamp` (newest first) | `timestamp` |
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

Produces archives identical to Datadog's native S3 archive format:

```
<prefix>/dt=YYYYMMDD/hour=HH/archive_000000.0000.<uuid>.json.gz
```

Each `.json.gz` file contains gzipped NDJSON (one JSON object per line) with this structure:

```json
{"_id":"...","date":"2025-04-06T12:34:56.789Z","host":"...","service":"...","source":"...","status":"info","tags":[...],"attributes":{...}}
```

This is the same format Datadog's built-in Archive feature writes, so you can:
- Place files alongside Datadog's own archive output in the same S3 bucket
- Query with Athena/Spark using the `dt=`/`hour=` partitioning
- Rehydrate back into Datadog using their rehydration feature

## Features

- **Native archive format** — Output matches Datadog's own S3 archive structure exactly (NDJSON, partitioning, naming)
- **Rate limit handling** — Exponential backoff on HTTP 429/5xx (1s → 60s, up to 10 retries)
- **Crash recovery** — Cursor auto-saved on crash/SIGINT, resumes automatically on next run
- **Streaming** — Partitions flush to disk every 5000 logs (constant memory for large exports)
- **Parallel S3 upload** — Uploads happen concurrently with downloads (configurable concurrency)
- **Flex Logs support** — `--storageTier flex` for longer-retention data
- **Multi-region** — All Datadog sites supported via `--site` flag
- **Cursor expiry recovery** — Automatically restarts from last known timestamp if cursor expires (HTTP 410)

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

# Flex Logs (longer retention tier)
node index.mjs --query 'env:production' --from 2024-06-01 --storageTier flex \
  --format archive --output prod-archive --s3Bucket my-logs
```
