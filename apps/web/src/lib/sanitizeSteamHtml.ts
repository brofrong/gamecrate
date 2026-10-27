// Очистка HTML описания игры из Steam Store (спека 2026-10-27 §3.5) без зависимостей:
// разрешённые теги остаются без атрибутов, `img` — только `src` (https, домен
// `*.steamstatic.com`) и `alt`, `script`/`style` удаляются вместе с содержимым,
// остальные теги заменяются своим содержимым. Разбор через `DOMParser` — так
// «HTML» из Steam никогда не исполняется, а только переписывается.

const ALLOWED = new Set([
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "ul",
  "ol",
  "li",
  "h2",
  "img",
]);
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object"]);

const isSteamImage = (src: string): boolean => {
  try {
    const url = new URL(src);
    return (
      url.protocol === "https:" &&
      (url.hostname === "steamstatic.com" ||
        url.hostname.endsWith(".steamstatic.com"))
    );
  } catch {
    return false;
  }
};

function clean(node: Node, out: Node, doc: Document): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.appendChild(doc.createTextNode(child.textContent ?? ""));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    const tag = element.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) continue;
    if (!ALLOWED.has(tag)) {
      clean(element, out, doc);
      continue;
    }
    if (tag === "img") {
      const src = element.getAttribute("src") ?? "";
      if (!isSteamImage(src)) continue;
      const img = doc.createElement("img");
      img.setAttribute("src", src);
      const alt = element.getAttribute("alt");
      if (alt !== null) img.setAttribute("alt", alt);
      out.appendChild(img);
      continue;
    }
    const copy = doc.createElement(tag);
    clean(element, copy, doc);
    out.appendChild(copy);
  }
}

export function sanitizeSteamHtml(html: string): string {
  const doc = new DOMParser().parseFromString(
    `<body>${html}</body>`,
    "text/html",
  );
  const out = doc.createElement("div");
  clean(doc.body, out, doc);
  return out.innerHTML;
}
