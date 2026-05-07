#!/usr/bin/env node

import { client, v2 } from "@datadog/datadog-api-client";
import chalk from "chalk";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import * as crypto from "crypto";
let S3Client, PutObjectCommand;
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

dotenv.config();

const argv = yargs(hideBin(process.argv))
    .option("query", { type: "string", describe: "Datadog search query", demandOption: true })
    .option("index", { type: "string", default: "main", describe: "Log index to read from" })
    .option("from", { type: "string", describe: "Start date (e.g. 2024-01-01)" })
    .option("to", { type: "string", describe: "End date" })
    .option("pageSize", { type: "number", default: 1000, describe: "Results per page (max 5000)" })
    .option("output", { type: "string", default: "results.json", describe: "Output file path" })
    .option("format", { type: "string", default: "ndjson", choices: ["json", "ndjson", "archive"], describe: "Output format (archive = DD-compatible gzipped, date-partitioned)" })
    .option("cursor", { type: "string", describe: "Resume from cursor position" })
    .option("append", { type: "boolean", default: false, describe: "Append to output file" })
    .option("storageTier", { type: "string", choices: ["indexes", "online-archives", "flex"], describe: "Storage tier (flex for Flex Logs)" })
    .option("sort", { type: "string", default: "timestamp", choices: ["timestamp", "-timestamp"], describe: "Sort order: timestamp (oldest first) or -timestamp (newest first)" })
    .option("site", { type: "string", describe: "Datadog site (e.g. datadoghq.eu, us3.datadoghq.com, us5.datadoghq.com, ddog-gov.com)" })
    .option("s3Bucket", { type: "string", describe: "S3 bucket for archive upload" })
    .option("s3Prefix", { type: "string", default: "", describe: "S3 key prefix (e.g. logs/archive)" })
    .option("s3Region", { type: "string", default: "eu-west-1", describe: "S3 region" })
    .option("s3Concurrency", { type: "number", default: 4, describe: "Parallel S3 uploads" })
    .help()
    .argv;

// Configure Datadog site
const configuration = client.createConfiguration();
if (argv.site) {
    const siteMap = {
        "eu": "datadoghq.eu",
        "us3": "us3.datadoghq.com",
        "us5": "us5.datadoghq.com",
        "gov": "ddog-gov.com",
        "ap1": "ap1.datadoghq.com",
    };
    const resolvedSite = siteMap[argv.site] || argv.site;
    configuration.setServerVariables({ site: resolvedSite });
}

const apiInstance = new v2.LogsApi(configuration);

const CURSOR_FILE = `${argv.output}.cursor`;
let totalCount = 0;
let lastCursor = null;

// S3 client (lazy init)
let s3 = null;
if (argv.s3Bucket) {
    const sdk = await import("@aws-sdk/client-s3");
    S3Client = sdk.S3Client;
    PutObjectCommand = sdk.PutObjectCommand;
    s3 = new S3Client({ region: argv.s3Region });
}

// Auto-save cursor on crash
function saveCursor() {
    if (lastCursor) {
        fs.writeFileSync(CURSOR_FILE, JSON.stringify({ cursor: lastCursor, count: totalCount, timestamp: new Date().toISOString() }));
        process.stderr.write(chalk.yellow(`\nCursor saved to ${CURSOR_FILE} (${totalCount} logs downloaded). Resume with --cursor flag or it will be read automatically.\n`));
    }
}
process.on("SIGINT", () => { saveCursor(); process.exit(1); });
process.on("SIGTERM", () => { saveCursor(); process.exit(1); });
process.on("uncaughtException", (e) => { saveCursor(); console.error(chalk.red(e.message)); process.exit(1); });

// Exponential backoff for 429s
async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(apiInstance, query, maxRetries = 10) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await apiInstance.listLogsGet(query);
        } catch (e) {
            const status = e.code || e.httpStatusCode || e.status;
            if (status === 429 || status === 408 || status >= 500) {
                const waitMs = Math.min(1000 * Math.pow(2, attempt), 60000);
                console.log(chalk.yellow(`\nHTTP ${status}. Waiting ${waitMs / 1000}s before retry (attempt ${attempt + 1}/${maxRetries})...`));
                await sleep(waitMs);
            } else {
                throw e;
            }
        }
    }
    throw new Error("Max retries exceeded");
}

// --- Archive format (DD-compatible) ---
// Path: prefix/dt=YYYYMMDD/hour=HH/archive_HHmmss.SSSS.<uuid>.json.gz
const archiveBuffers = {}; // key: "dt=YYYYMMDD/hour=HH" -> logs[]

function getArchiveKey(log) {
    const ts = log.attributes?.timestamp || log.attributes?.attributes?.timestamp || new Date().toISOString();
    const d = new Date(ts);
    const date = d.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
    const hour = String(d.getUTCHours()).padStart(2, "0");
    return `dt=${date}/hour=${hour}`;
}

function generateArchiveFilename() {
    const now = new Date();
    const hms = now.toISOString().slice(11, 19).replace(/:/g, "");
    const ms = String(now.getMilliseconds()).padStart(4, "0");
    const uuid = crypto.randomUUID();
    return `archive_${hms}.${ms}.${uuid}.json.gz`;
}

// --- S3 upload queue ---
const uploadQueue = [];
let activeUploads = 0;
let uploadsDone = 0;
let uploadsFailed = 0;
let draining = false;

async function uploadToS3(key, buffer, retries = 3) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const cmd = new PutObjectCommand({
                Bucket: argv.s3Bucket,
                Key: key,
                Body: buffer,
                ContentType: "application/json",
                ContentEncoding: "gzip",
            });
            await s3.send(cmd);
            return;
        } catch (e) {
            if (attempt < retries) {
                await sleep(1000 * Math.pow(2, attempt));
            } else {
                throw e;
            }
        }
    }
}

function drainQueue() {
    while (activeUploads < argv.s3Concurrency && uploadQueue.length > 0) {
        const { key, buffer } = uploadQueue.shift();
        activeUploads++;
        uploadToS3(key, buffer)
            .then(() => { uploadsDone++; })
            .catch((e) => { uploadsFailed++; console.error(chalk.red(`\nS3 upload failed: ${key} - ${e.message}`)); })
            .finally(() => { activeUploads--; drainQueue(); });
    }
}

function enqueueUpload(key, buffer) {
    uploadQueue.push({ key, buffer });
    drainQueue();
}

async function waitForUploads() {
    while (uploadQueue.length > 0 || activeUploads > 0) {
        await sleep(200);
    }
}

// Flush a single partition to disk and optionally S3
function flushPartition(partitionKey, logs) {
    const outDir = argv.output.replace(/\.\w+$/, "") || "archive";
    const dir = path.join(outDir, partitionKey);
    const filename = generateArchiveFilename();

    const content = JSON.stringify(logs);
    const gz = zlib.gzipSync(content);

    // Write locally
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), gz);

    // Enqueue S3 upload
    if (s3) {
        const s3Key = [argv.s3Prefix, partitionKey, filename].filter(Boolean).join("/");
        enqueueUpload(s3Key, gz);
    }
}

// --- Output handling ---
const data = [];
let writer = null;
const FLUSH_THRESHOLD = 5000; // flush partition every N logs

function processLog(row) {
    if (argv.format === "archive") {
        const key = getArchiveKey(row);
        if (!archiveBuffers[key]) archiveBuffers[key] = [];
        archiveBuffers[key].push(row);
        // Stream: flush partition when it hits threshold
        if (archiveBuffers[key].length >= FLUSH_THRESHOLD) {
            flushPartition(key, archiveBuffers[key]);
            archiveBuffers[key] = [];
        }
    } else if (argv.format === "ndjson") {
        if (writer === null) {
            writer = fs.createWriteStream(argv.output, { flags: argv.append ? "a" : "w" });
        }
        writer.write(JSON.stringify(row) + "\n");
    } else {
        data.push(row);
    }
    totalCount++;
}

function oneYearAgo() {
    return new Date(new Date().setFullYear(new Date().getFullYear() - 1));
}

// Load saved cursor if available and no explicit cursor provided
let savedLastTimestamp = null;

function loadSavedCursor() {
    if (argv.cursor) return argv.cursor;
    if (fs.existsSync(CURSOR_FILE)) {
        try {
            const saved = JSON.parse(fs.readFileSync(CURSOR_FILE, "utf-8"));
            console.log(chalk.yellow(`Found saved cursor from ${saved.timestamp} (${saved.count} logs previously downloaded)`));
            console.log(chalk.yellow(`   Resuming from saved position. Delete ${CURSOR_FILE} to start fresh.`));
            totalCount = saved.count || 0;
            savedLastTimestamp = saved.lastTimestamp || null;
            return saved.cursor;
        } catch { /* ignore corrupt file */ }
    }
    return null;
}

async function getLogs() {
    const startCursor = loadSavedCursor();
    let nextPage = startCursor;
    let page = 0;
    let lastLogTimestamp = savedLastTimestamp;

    const params = {
        filterQuery: argv.query,
        filterIndex: argv.index,
        filterFrom: argv.from ? new Date(argv.from) : oneYearAgo(),
        filterTo: argv.to ? new Date(argv.to) : new Date(),
        pageLimit: Math.min(argv.pageSize, 5000),
        sort: argv.sort,
    };

    if (argv.storageTier) {
        const tierMap = { "flex": "flex", "indexes": "indexes", "online-archives": "online-archives" };
        params.filterStorageTier = tierMap[argv.storageTier] || argv.storageTier;
    }

    console.log(chalk.cyan("Downloading logs:\n" + JSON.stringify(params, null, 2) + "\n"));

    do {
        page++;
        const query = nextPage ? { ...params, pageCursor: nextPage } : params;

        let result;
        try {
            result = await fetchWithRetry(apiInstance, query);
        } catch (e) {
            const status = e.code || e.httpStatusCode || e.status;
            if (status === 410 && lastLogTimestamp) {
                // Cursor expired — restart from last known timestamp
                console.log(chalk.yellow(`\nCursor expired (410). Restarting from ${lastLogTimestamp}...`));
                nextPage = null;
                params.filterFrom = new Date(lastLogTimestamp);
                if (fs.existsSync(CURSOR_FILE)) fs.unlinkSync(CURSOR_FILE);
                continue;
            }
            throw e;
        }

        const logs = result.data || [];
        logs.forEach((row) => processLog(row));

        // Track last log timestamp for restart on cursor expiry
        if (logs.length > 0) {
            const last = logs[logs.length - 1];
            lastLogTimestamp = last.attributes?.timestamp || last.attributes?.attributes?.timestamp;
        }

        nextPage = result?.meta?.page?.after || null;
        lastCursor = nextPage;

        // Save cursor + timestamp periodically (every 10 pages)
        if (page % 10 === 0 && lastCursor) {
            fs.writeFileSync(CURSOR_FILE, JSON.stringify({ cursor: lastCursor, count: totalCount, lastTimestamp: lastLogTimestamp, timestamp: new Date().toISOString() }));
        }

        // Progress display
        const s3Status = s3 ? ` | S3: ${uploadsDone} uploaded` : "";
        process.stdout.write(`\r${chalk.green("+")} Page ${page} | ${chalk.bold(totalCount)} logs downloaded${s3Status}${lastCursor ? " | fetching next..." : " | done"}`);
    } while (nextPage);

    console.log(""); // newline after progress
}

// Main
(async function () {
    try {
        await getLogs();
    } catch (e) {
        saveCursor();
        console.error(chalk.red(`\nError: ${e.message}`));
        process.exit(1);
    }

    // Flush remaining archive partitions
    if (argv.format === "archive") {
        const keys = Object.keys(archiveBuffers).sort();
        for (const key of keys) {
            if (archiveBuffers[key].length > 0) {
                flushPartition(key, archiveBuffers[key]);
            }
        }
        // Wait for all S3 uploads to finish
        if (s3) {
            console.log(chalk.cyan("Waiting for S3 uploads to complete..."));
            await waitForUploads();
            console.log(chalk.green(`S3: ${uploadsDone} uploaded, ${uploadsFailed} failed`));
        }
        const outDir = argv.output.replace(/\.\w+$/, "") || "archive";
        console.log(chalk.cyan(`Archive written to ${outDir}/`));
    } else if (argv.format === "ndjson") {
        if (writer) writer.end();
    } else {
        console.log(chalk.cyan(`Writing ${data.length} logs to ${argv.output}`));
        fs.writeFileSync(argv.output, JSON.stringify(data, null, 2));
    }

    // Clean up cursor file on successful completion
    if (fs.existsSync(CURSOR_FILE)) {
        fs.unlinkSync(CURSOR_FILE);
    }

    console.log(chalk.green(`Done. ${totalCount} logs saved to ${argv.output}`));
})();
