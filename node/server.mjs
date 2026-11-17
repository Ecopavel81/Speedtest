#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCsv,
  checkUrl,
  resultRows,
  runTest,
  speedMbit,
  summarize,
  summaryRows,
} from "./speedtest.mjs";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const MAX_REQUESTS = 100;
const MAX_BODY_BYTES = 64 * 1024;
const CLIENT_GONE = Symbol("client-gone");

const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

const USAGE = [
  "Использование: node server.mjs [--port 8787] [--host 127.0.0.1]",
  "  -p, --port   порт (по умолчанию 8787)",
  "  --host       адрес прослушивания (по умолчанию 127.0.0.1)",
].join("\n");

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("слишком большое тело запроса"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("тело запроса не является JSON"));
      }
    });
    req.on("error", reject);
  });
}

function validateRequest(url, count, timeoutSec) {
  if (!url) return "укажите адрес";
  if (!checkUrl(url)) return "адрес должен начинаться с http:// или https://";
  if (!Number.isInteger(count) || count < 1) {
    return "количество запросов должно быть целым числом не меньше 1";
  }
  if (count > MAX_REQUESTS) {
    return `количество запросов не должно превышать ${MAX_REQUESTS}`;
  }
  if (!(timeoutSec > 0)) return "таймаут должен быть больше 0";
  return "";
}

async function handleTest(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  const count = Number(body.requests);
  const timeoutSec = Number(body.timeout);
  const problem = validateRequest(url, count, timeoutSec);
  if (problem) {
    sendJson(res, 400, { error: problem });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  let gone = false;
  res.on("close", () => {
    gone = true;
  });
  const send = (event) => {
    if (!gone) res.write(JSON.stringify(event) + "\n");
  };

  send({ type: "start", url, total: count });

  try {
    const results = await runTest(url, count, timeoutSec * 1000, (result, total) => {
      if (gone) throw CLIENT_GONE;
      send({
        type: "progress",
        number: result.number,
        total,
        ok: result.ok,
        ms: result.ok ? Number((result.seconds * 1000).toFixed(1)) : null,
        bytes: result.ok ? result.bytes : null,
        mbit: result.ok ? Number(speedMbit(result.bytes, result.seconds).toFixed(1)) : null,
        error: result.error,
      });
    });

    const summary = summarize(results);
    send({
      type: "done",
      summary,
      rows: resultRows(results),
      summaryRows: summaryRows(summary),
      csv: buildCsv(results, summary),
    });
  } catch (err) {
    if (err !== CLIENT_GONE) send({ type: "error", message: err.message });
  } finally {
    if (!gone) res.end();
  }
}

async function handleStatic(pathname, req, res) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) {
    sendJson(res, 404, { error: "не найдено" });
    return;
  }
  const [file, type] = entry;
  const content = await readFile(join(PUBLIC_DIR, file));
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": content.length,
    "Cache-Control": "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : content);
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");

  if (pathname === "/api/test") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { error: "метод не поддерживается" });
      return;
    }
    handleTest(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: "внутренняя ошибка сервера" });
      else res.end();
    });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    handleStatic(pathname, req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: "внутренняя ошибка сервера" });
      else res.end();
    });
    return;
  }

  sendJson(res, 404, { error: "не найдено" });
});

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: false,
      options: {
        port: { type: "string", short: "p", default: "8787" },
        host: { type: "string", default: "127.0.0.1" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    console.error(`Ошибка: ${err.message}`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const { values } = parsed;
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("Ошибка: порт должен быть целым числом от 0 до 65535");
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  server.on("error", (err) => {
    console.error(`Ошибка: ${err.message}`);
    process.exitCode = 1;
  });

  server.listen(port, values.host, () => {
    const address = server.address();
    const shown = values.host === "0.0.0.0" || values.host === "::" ? "localhost" : values.host;
    console.log(`Веб-интерфейс: http://${shown}:${address.port}`);
    if (!["127.0.0.1", "::1", "localhost"].includes(values.host)) {
      console.warn(
        `Внимание: сервер слушает ${values.host} и доступен по сети. ` +
          "Он скачивает любые http/https-адреса по запросу — не открывайте его в недоверенной сети.",
      );
    }
    console.log("Ctrl+C — остановить");
  });
}

main();
