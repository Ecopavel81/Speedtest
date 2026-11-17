#!/usr/bin/env python3
"""Замер скорости скачивания: последовательные GET-запросы к одному URL."""

import argparse
import csv
import io
import statistics
import sys
import time
from urllib.parse import urlparse

import requests

CHUNK_SIZE = 64 * 1024
MIB = 1024 * 1024
MEGABIT = 1_000_000
RESULT_FIELDS = ["№", "статус", "время, мс", "объём, байт", "скорость, Мбит/с", "ошибка"]


def check_url(url):
    parsed = urlparse(url)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def prompt_url():
    """Спрашивает адрес в консоли, пока не введён корректный URL или пустая строка."""
    prompt = "Адрес (URL, например https://example.com/big.jpg): "
    while True:
        try:
            value = input(prompt).strip()
        except EOFError:
            print()
            return ""
        except KeyboardInterrupt:
            print()
            return ""
        if not value:
            return ""
        if check_url(value):
            return value
        print("Адрес должен начинаться с http:// или https://", file=sys.stderr)


def speed_mbit(num_bytes, seconds):
    return num_bytes * 8 / MEGABIT / seconds if seconds > 0 else 0.0


def fetch_once(url, timeout):
    start = time.perf_counter()
    try:
        with requests.get(
            url,
            stream=True,
            timeout=timeout,
            headers={"Cache-Control": "no-cache"},
        ) as response:
            if not 200 <= response.status_code < 300:
                return {"ok": False, "seconds": 0.0, "bytes": 0, "error": f"HTTP {response.status_code}"}
            total = 0
            for chunk in response.iter_content(CHUNK_SIZE):
                total += len(chunk)
                if time.perf_counter() - start > timeout:
                    raise TimeoutError(f"превышен таймаут {timeout} с")
    except (requests.RequestException, TimeoutError) as exc:
        return {"ok": False, "seconds": 0.0, "bytes": 0, "error": str(exc)}
    return {"ok": True, "seconds": time.perf_counter() - start, "bytes": total, "error": ""}


def run_test(url, count, timeout, on_result=None):
    results = []
    for number in range(1, count + 1):
        result = {"number": number, **fetch_once(url, timeout)}
        results.append(result)
        if on_result:
            on_result(result, count)
    return results


def summarize(results):
    ok = [r for r in results if r["ok"]]
    summary = {"total": len(results), "successes": len(ok)}
    if not ok:
        return summary
    times_ms = [r["seconds"] * 1000 for r in ok]
    total_bytes = sum(r["bytes"] for r in ok)
    total_seconds = sum(r["seconds"] for r in ok)
    summary.update({
        "avg_ms": statistics.mean(times_ms),
        "min_ms": min(times_ms),
        "max_ms": max(times_ms),
        "median_ms": statistics.median(times_ms),
        "total_bytes": total_bytes,
        "speed_mbit": speed_mbit(total_bytes, total_seconds),
    })
    return summary


def result_rows(results):
    rows = []
    for r in results:
        ok = r["ok"]
        rows.append({
            "№": r["number"],
            "статус": "ok" if ok else "ошибка",
            "время, мс": round(r["seconds"] * 1000, 1) if ok else "",
            "объём, байт": r["bytes"] if ok else "",
            "скорость, Мбит/с": round(speed_mbit(r["bytes"], r["seconds"]), 1) if ok else "",
            "ошибка": r["error"],
        })
    return rows


def summary_rows(summary):
    rows = [("Запросов", summary["total"]), ("Успешных", summary["successes"])]
    if summary["successes"]:
        rows += [
            ("Среднее время, мс", round(summary["avg_ms"], 1)),
            ("Минимум, мс", round(summary["min_ms"], 1)),
            ("Максимум, мс", round(summary["max_ms"], 1)),
            ("Медиана, мс", round(summary["median_ms"], 1)),
            ("Скачано, байт", summary["total_bytes"]),
            ("Средняя скорость, Мбит/с", round(summary["speed_mbit"], 1)),
        ]
    return rows


def summary_lines(summary):
    lines = [f"Запросов: {summary['total']} (успешных: {summary['successes']})"]
    if not summary["successes"]:
        return lines + ["Нет успешных запросов"]
    return lines + [
        f"Среднее время:    {summary['avg_ms']:.1f} мс  "
        f"(min {summary['min_ms']:.1f}, max {summary['max_ms']:.1f}, медиана {summary['median_ms']:.1f})",
        f"Скачано всего:    {summary['total_bytes'] / MIB:.2f} МБ",
        f"Средняя скорость: {summary['speed_mbit']:.1f} Мбит/с",
    ]


def progress_line(result, total):
    prefix = f"[{result['number']}/{total}]"
    if not result["ok"]:
        return f"{prefix} ошибка: {result['error']}"
    mbit = speed_mbit(result["bytes"], result["seconds"])
    return (
        f"{prefix} {result['seconds'] * 1000:.1f} мс, "
        f"{result['bytes'] / MIB:.2f} МБ, {mbit:.1f} Мбит/с"
    )


def build_csv(results, summary):
    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=";")
    writer.writerow(RESULT_FIELDS)
    for row in result_rows(results):
        writer.writerow([row[field] for field in RESULT_FIELDS])
    writer.writerow([])
    writer.writerow(["показатель", "значение"])
    writer.writerows(summary_rows(summary))
    return buffer.getvalue()


def main():
    parser = argparse.ArgumentParser(
        description="Замер скорости скачивания: последовательные запросы к одному адресу."
    )
    parser.add_argument(
        "url",
        nargs="?",
        help="адрес для запросов, например https://example.com/big.jpg; "
             "если не указан, будет запрошен в консоли",
    )
    parser.add_argument("-n", "--requests", type=int, default=10, help="количество запросов (по умолчанию 10)")
    parser.add_argument(
        "--timeout", type=float, default=30.0,
        help="таймаут одного запроса в секундах (по умолчанию 30)",
    )
    parser.add_argument("--csv", metavar="ФАЙЛ", help="сохранить результаты в CSV-файл")
    args = parser.parse_args()

    url = args.url
    if not url:
        if not sys.stdin.isatty():
            parser.error("укажите адрес: speedtest.py https://example.com/big.jpg")
        url = prompt_url()
        if not url:
            parser.error("адрес не введён")
    if not check_url(url):
        parser.error("адрес должен начинаться с http:// или https://")
    if args.requests < 1:
        parser.error("количество запросов должно быть не меньше 1")
    if args.timeout <= 0:
        parser.error("таймаут должен быть больше 0")

    print(f"Замер: {url}, запросов: {args.requests}")
    results = run_test(
        url,
        args.requests,
        args.timeout,
        on_result=lambda result, total: print(progress_line(result, total), flush=True),
    )
    summary = summarize(results)

    print()
    for line in summary_lines(summary):
        print(line)

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8-sig") as f:
            f.write(build_csv(results, summary))
        print(f"Результаты сохранены в {args.csv}")

    return 0 if summary["successes"] else 1


if __name__ == "__main__":
    sys.exit(main())
