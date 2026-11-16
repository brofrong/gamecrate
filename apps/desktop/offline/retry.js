// @ts-check
// Заглушка из бандла — первая страница окна. Проверяет, что сайт отвечает, и уходит на него;
// без сети показывает «Нет связи с сервером» и кнопку «Повторить». Адрес сайта приложение
// передаёт в `?retry=` (src-tauri/src/nav.rs, offline_query).

/** Сколько ждать ответа сайта, прежде чем показать «нет связи». */
export const PROBE_TIMEOUT_MS = 8000;

/**
 * Адрес из `?retry=`: только http(s), иначе `null` (кнопке некуда вести).
 * @param {string} search `location.search`
 * @returns {string | null}
 */
export function retryTarget(search) {
  const raw = new URLSearchParams(search).get("retry");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Отвечает ли сайт. `no-cors`: заглушка живёт на другом origin, тело ответа не нужно —
 * любой ответ значит «связь есть», сетевая ошибка или таймаут — «нет».
 * @param {string} url
 * @param {typeof fetch} [fetchImpl]
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function reachable(url, fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    await fetchImpl(url, {
      mode: "no-cors",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return true;
  } catch {
    return false;
  }
}

/** @param {Document} doc */
function start(doc) {
  const target = retryTarget(doc.location.search);
  const button = /** @type {HTMLButtonElement} */ (doc.getElementById("retry"));

  /** @param {"checking" | "offline"} state */
  const show = (state) => {
    doc.body.dataset.state = state;
    button.disabled = state === "checking" || target === null;
  };

  const attempt = async () => {
    show("checking");
    if (target && (await reachable(target))) {
      doc.location.replace(target);
      return;
    }
    show("offline");
  };

  button.addEventListener("click", () => void attempt());
  void attempt();
}

if (typeof document !== "undefined") start(document);
