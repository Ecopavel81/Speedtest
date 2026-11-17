import streamlit as st

from speedtest import MIB, build_csv, check_url, result_rows, run_test, summarize, summary_rows

st.set_page_config(page_title="Замер скорости скачивания")
st.title("Замер скорости скачивания")

url = st.text_input("Адрес", placeholder="https://example.com/big.jpg")
count = st.number_input("Количество запросов", min_value=1, max_value=100, value=10, step=1)
timeout = st.number_input("Таймаут одного запроса, с", min_value=1.0, value=30.0, step=1.0)

if st.button("Запустить", type="primary"):
    if not check_url(url):
        st.session_state.pop("results", None)
        st.error("Адрес должен начинаться с http:// или https://")
    else:
        collected = []
        progress = st.progress(0.0, text="Запуск...")

        def on_result(result, total):
            collected.append(result)
            progress.progress(len(collected) / total, text=f"Запрос {len(collected)} из {total}")

        results = run_test(url, int(count), float(timeout), on_result=on_result)
        progress.empty()
        st.session_state["results"] = results
        st.session_state["summary"] = summarize(results)

if "results" in st.session_state:
    results = st.session_state["results"]
    summary = st.session_state["summary"]

    if summary["successes"]:
        col1, col2, col3 = st.columns(3)
        col1.metric("Среднее время, мс", f"{summary['avg_ms']:.1f}")
        col2.metric("Скачано, МБ", f"{summary['total_bytes'] / MIB:.2f}")
        col3.metric("Средняя скорость, Мбит/с", f"{summary['speed_mbit']:.1f}")
        st.caption(
            f"min {summary['min_ms']:.1f} мс, max {summary['max_ms']:.1f} мс, "
            f"медиана {summary['median_ms']:.1f} мс. "
            f"Успешных запросов: {summary['successes']} из {summary['total']}"
        )
    else:
        st.error("Нет успешных запросов")

    st.dataframe(result_rows(results), hide_index=True)
    st.table([{"показатель": name, "значение": value} for name, value in summary_rows(summary)])
    st.download_button(
        "Скачать CSV",
        data=build_csv(results, summary).encode("utf-8-sig"),
        file_name="results.csv",
        mime="text/csv",
    )
