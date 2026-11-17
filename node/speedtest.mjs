#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const MIB = 1024 * 1024;
const MEGABIT = 1_000_000;
const USAGE = [
  "Использование: node speedtest.mjs <URL> [-n 10] [--timeout 30] [--csv файл.csv]",
  "  -n, --requests  количество запросов (по умолчанию 10)",
  "  --timeout       таймаут одного запроса в секундах (по умолчанию 30)",
  "  --csv           сохранить результаты в CSV-файл",
].join("\n");
const RESULT_FIELDS = ["№", "статус", "время, мс", "объём, байт", "скорость, Мбит/с", "ошибка"];

function fail(message) {
  console.error(`Ошибка: ${message}`);
  console.error(USAGE);
  process.exit(1);
}

function checkUrl(url) {
  try {
    const { protocol, host } = new URL(url);
    return (protocol === "http:" || protocol === "https:") && host !== "";
  } catch {
    return false;
  }
}

function speedMbit(bytes, seconds) {
  return seconds > 0 ? (bytes * 8) / MEGABIT / seconds : 0;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function fetchOnce(url, timeoutMs) {
  const start = performance.now();
  try {
    const response = await fetch(url, {
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, seconds: 0, bytes: 0, error: `HTTP ${response.status}` };
    }
    let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
    }
    return { ok: true, seconds: (performance.now() - start) / 1000, bytes, error: "" };
  } catch (err) {
    const error =
      err.name === "TimeoutError"
        ? `превышен таймаут ${timeoutMs / 1000} с`
        : err.cause?.message ?? err.message;
    return { ok: false, seconds: 0, bytes: 0, error };
  }
}

async function runTest(url, count, timeoutMs, onResult) {
  const results = [];
  for (let number = 1; number <= count; number++) {
    const result = { number, ...(await fetchOnce(url, timeoutMs)) };
    results.push(result);
    onResult?.(result, count);
  }
  return results;
}

function summarize(results) {
  const ok = results.filter((r) => r.ok);
  const summary = { total: results.length, successes: ok.length };
  if (ok.length === 0) return summary;
  const timesMs = ok.map((r) => r.seconds * 1000);
  const totalBytes = ok.reduce((sum, r) => sum + r.bytes, 0);
  const totalSeconds = ok.reduce((sum, r) => sum + r.seconds, 0);
  return {
    ...summary,
    avgMs: mean(timesMs),
    minMs: Math.min(...timesMs),
    maxMs: Math.max(...timesMs),
    medianMs: median(timesMs),
    totalBytes,
    speedMbit: speedMbit(totalBytes, totalSeconds),
  };
}

function resultRows(results) {
  return results.map((r) => ({
    "№": r.number,
    статус: r.ok ? "ok" : "ошибка",
    "время, мс": r.ok ? Number((r.seconds * 1000).toFixed(1)) : "",
    "объём, байт": r.ok ? r.bytes : "",
    "скорость, Мбит/с": r.ok ? Number(speedMbit(r.bytes, r.seconds).toFixed(1)) : "",
    ошибка: r.error,
  }));
}

function summaryRows(summary) {
  const rows = [
    ["Запросов", summary.total],
    ["Успешных", summary.successes],
  ];
  if (summary.successes) {
    rows.push(
      ["Среднее время, мс", Number(summary.avgMs.toFixed(1))],
      ["Минимум, мс", Number(summary.minMs.toFixed(1))],
      ["Максимум, мс", Number(summary.maxMs.toFixed(1))],
      ["Медиана, мс", Number(summary.medianMs.toFixed(1))],
      ["Скачано, байт", summary.totalBytes],
      ["Средняя скорость, Мбит/с", Number(summary.speedMbit.toFixed(1))],
    );
  }
  return rows;
}

function summaryLines(summary) {
  const lines = [`Запросов: ${summary.total} (успешных: ${summary.successes})`];
  if (!summary.successes) return [...lines, "Нет успешных запросов"];
  return [
    ...lines,
    `Среднее время:    ${summary.avgMs.toFixed(1)} мс  ` +
      `(min ${summary.minMs.toFixed(1)}, max ${summary.maxMs.toFixed(1)}, медиана ${summary.medianMs.toFixed(1)})`,
    `Скачано всего:    ${(summary.totalBytes / MIB).toFixed(2)} МБ`,
    `Средняя скорость: ${summary.speedMbit.toFixed(1)} Мбит/с`,
  ];
}

function progressLine(result, total) {
  const prefix = `[${result.number}/${total}]`;
  if (!result.ok) return `${prefix} ошибка: ${result.error}`;
  const mbit = speedMbit(result.bytes, result.seconds);
  return `${prefix} ${(result.seconds * 1000).toFixed(1)} мс, ` +
    `${(result.bytes / MIB).toFixed(2)} МБ, ${mbit.toFixed(1)} Мбит/с`;
}

function csvCell(value) {
  const text = String(value);
  return /[";\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvLine(cells) {
  return cells.map(csvCell).join(";");
}

function buildCsv(results, summary) {
  const lines = [csvLine(RESULT_FIELDS)];
  for (const row of resultRows(results)) {
    lines.push(csvLine(RESULT_FIELDS.map((field) => row[field])));
  }
  lines.push("", csvLine(["показатель", "значение"]));
  for (const [name, value] of summaryRows(summary)) {
    lines.push(csvLine([name, value]));
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        requests: { type: "string", short: "n", default: "10" },
        timeout: { type: "string", default: "30" },
        csv: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    fail(err.message);
  }

  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length !== 1) fail("укажите один адрес");

  const [url] = positionals;
  const count = Number(values.requests);
  const timeoutSec = Number(values.timeout);
  if (!checkUrl(url)) fail("адрес должен начинаться с http:// или https://");
  if (!Number.isInteger(count) || count < 1) fail("количество запросов должно быть не меньше 1");
  if (!(timeoutSec > 0)) fail("таймаут должен быть больше 0");

  console.log(`Замер: ${url}, запросов: ${count}`);
  const results = await runTest(url, count, timeoutSec * 1000, (result, total) =>
    console.log(progressLine(result, total)),
  );
  const summary = summarize(results);

  console.log();
  for (const line of summaryLines(summary)) console.log(line);

  if (values.csv) {
    await writeFile(values.csv, buildCsv(results, summary), "utf8");
    console.log(`Результаты сохранены в ${values.csv}`);
  }

  process.exitCode = summary.successes ? 0 : 1;
}

main();
