const MIB = 1024 * 1024;

const form = document.getElementById("form");
const urlInput = document.getElementById("url");
const requestsInput = document.getElementById("requests");
const timeoutInput = document.getElementById("timeout");
const runButton = document.getElementById("run");
const stopButton = document.getElementById("stop");

const errorBox = document.getElementById("error");
const progressBox = document.getElementById("progress");
const progressText = document.getElementById("progress-text");
const progressCount = document.getElementById("progress-count");
const progressBar = document.getElementById("progress-bar");

const metricsBox = document.getElementById("metrics");
const metricAvg = document.getElementById("metric-avg");
const metricBytes = document.getElementById("metric-bytes");
const metricSpeed = document.getElementById("metric-speed");
const caption = document.getElementById("caption");

const resultsBlock = document.getElementById("results-block");
const resultsBody = document.getElementById("results-body");
const summaryBlock = document.getElementById("summary-block");
const summaryBody = document.getElementById("summary-body");
const downloadButton = document.getElementById("download");

let controller = null;
let csv = "";

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

function setBusy(busy) {
  runButton.disabled = busy;
  stopButton.hidden = !busy;
}

function resetOutput() {
  csv = "";
  downloadButton.disabled = true;
  resultsBody.replaceChildren();
  summaryBody.replaceChildren();
  resultsBlock.hidden = true;
  summaryBlock.hidden = true;
  metricsBox.hidden = true;
  caption.hidden = true;
  progressBox.hidden = true;
  progressBar.style.width = "0%";
  progressText.textContent = "Запуск…";
  progressCount.textContent = "";
}

function cell(text, className = "") {
  const td = document.createElement("td");
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function addResultRow(event) {
  const tr = document.createElement("tr");
  tr.append(
    cell(String(event.number), "num"),
    cell(event.ok ? "ok" : "ошибка", event.ok ? "status status--ok" : "status status--fail"),
    cell(event.ok ? event.ms.toFixed(1) : "", "num"),
    cell(event.ok ? String(event.bytes) : "", "num"),
    cell(event.ok ? event.mbit.toFixed(1) : "", "num"),
    cell(event.error ?? ""),
  );
  resultsBody.append(tr);
}

function renderSummary(event) {
  const { summary, rows, summaryRows } = event;

  if (summary.successes) {
    metricAvg.textContent = summary.avgMs.toFixed(1);
    metricBytes.textContent = (summary.totalBytes / MIB).toFixed(2);
    metricSpeed.textContent = summary.speedMbit.toFixed(1);
    caption.textContent =
      `min ${summary.minMs.toFixed(1)} мс, max ${summary.maxMs.toFixed(1)} мс, ` +
      `медиана ${summary.medianMs.toFixed(1)} мс. ` +
      `Успешных запросов: ${summary.successes} из ${summary.total}`;
    metricsBox.hidden = false;
    caption.hidden = false;
  } else {
    metricsBox.hidden = true;
    caption.hidden = true;
    showError("Нет успешных запросов");
  }

  resultsBody.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.append(
      cell(String(row["№"]), "num"),
      cell(row["статус"], row["статус"] === "ok" ? "status status--ok" : "status status--fail"),
      cell(row["время, мс"] === "" ? "" : Number(row["время, мс"]).toFixed(1), "num"),
      cell(row["объём, байт"] === "" ? "" : String(row["объём, байт"]), "num"),
      cell(row["скорость, Мбит/с"] === "" ? "" : Number(row["скорость, Мбит/с"]).toFixed(1), "num"),
      cell(row["ошибка"] ?? ""),
    );
    resultsBody.append(tr);
  }

  summaryBody.replaceChildren();
  for (const [name, value] of summaryRows) {
    const tr = document.createElement("tr");
    tr.append(cell(name), cell(String(value), "num"));
    summaryBody.append(tr);
  }

  resultsBlock.hidden = rows.length === 0;
  summaryBlock.hidden = false;

  csv = event.csv ?? "";
  downloadButton.disabled = csv === "";
}

async function* readEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield JSON.parse(line);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) yield JSON.parse(buffer.trim());
}

async function runTest() {
  showError("");
  resetOutput();
  setBusy(true);

  controller = new AbortController();

  try {
    const response = await fetch("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: urlInput.value.trim(),
        requests: Number(requestsInput.value),
        timeout: Number(timeoutInput.value),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      showError(payload.error ?? `HTTP ${response.status}`);
      return;
    }

    if (!response.body) {
      showError("сервер вернул пустой ответ");
      return;
    }

    progressBox.hidden = false;

    for await (const event of readEvents(response.body)) {
      if (event.type === "start") {
        progressText.textContent = `Замер: ${event.url}`;
        progressCount.textContent = `0 из ${event.total}`;
        continue;
      }

      if (event.type === "progress") {
        addResultRow(event);
        resultsBlock.hidden = false;
        progressBar.style.width = `${(event.number / event.total) * 100}%`;
        progressCount.textContent = `${event.number} из ${event.total}`;
        progressText.textContent = event.ok
          ? `${event.ms.toFixed(1)} мс, ${event.mbit.toFixed(1)} Мбит/с`
          : `ошибка: ${event.error}`;
        continue;
      }

      if (event.type === "done") {
        renderSummary(event);
        progressText.textContent = "Готово";
        continue;
      }

      if (event.type === "error") {
        showError(event.message);
      }
    }
  } catch (err) {
    if (err.name === "AbortError") showError("Замер остановлен");
    else showError(err.message || String(err));
  } finally {
    setBusy(false);
    controller = null;
    if (progressBox.hidden === false && progressText.textContent !== "Готово") {
      progressText.textContent = "Остановлено";
    }
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  runTest();
});

stopButton.addEventListener("click", () => controller?.abort());

downloadButton.addEventListener("click", () => {
  if (!csv) return;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "results.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
});

urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    form.requestSubmit();
  }
});
