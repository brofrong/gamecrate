// Разбор и запись VDF (KeyValues Steam): лексер общий для манифестов
// (`parseAppManifest`) и файлов входа (`loginSeed.ts`, спека §4).
// Steam пишет ключи в разном регистре (`valve`/`Valve`) — поиск по пути
// регистронезависимый, но при записи существующее написание ключа сохраняется.

export type Token =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "open" }
  | { readonly kind: "close" };

/** Лексемы KeyValues (VDF) Steam: строки в кавычках, `{`, `}`, `//`-комментарии. */
export const tokenize = (text: string): Array<Token> | undefined => {
  const tokens: Array<Token> = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i] ?? "";
    if (char === '"') {
      let value = "";
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) {
          const next = text[i + 1];
          value += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
        } else {
          value += text[i];
          i++;
        }
      }
      if (i >= text.length) return undefined;
      i++;
      tokens.push({ kind: "string", value });
    } else if (char === "{" || char === "}") {
      tokens.push(char === "{" ? { kind: "open" } : { kind: "close" });
      i++;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (/\s/.test(char)) i++;
    else return undefined;
  }
  return tokens;
};

/** Узел дерева KeyValues: лист — строка, блок — дочерние узлы по порядку. */
export type VdfNode = {
  readonly key: string;
  readonly value: string | ReadonlyArray<VdfNode>;
};

/**
 * Разбирает подряд идущие пары ключ/значение начиная с `index`, пока не
 * встретится `}` (не потреблённая) или конец токенов. Возвращает узлы и индекс
 * сразу после последнего разобранного токена; `undefined` — на любое
 * нарушение формы (ключ не строка, нет значения после ключа, несогласованные
 * скобки).
 */
const parseNodes = (
  tokens: ReadonlyArray<Token>,
  index: number,
): [Array<VdfNode>, number] | undefined => {
  const nodes: Array<VdfNode> = [];
  let i = index;
  while (true) {
    const token = tokens[i];
    if (token === undefined || token.kind === "close") return [nodes, i];
    if (token.kind !== "string") return undefined;
    const key = token.value;
    const valueToken = tokens[i + 1];
    if (valueToken === undefined) return undefined;
    if (valueToken.kind === "string") {
      nodes.push({ key, value: valueToken.value });
      i += 2;
    } else if (valueToken.kind === "open") {
      const children = parseNodes(tokens, i + 2);
      if (children === undefined) return undefined;
      const [childNodes, nextIndex] = children;
      if (tokens[nextIndex]?.kind !== "close") return undefined;
      nodes.push({ key, value: childNodes });
      i = nextIndex + 1;
    } else {
      return undefined;
    }
  }
};

/** Разбирает текст VDF в список корневых узлов; не VDF — `undefined`. */
export const parseVdf = (text: string): ReadonlyArray<VdfNode> | undefined => {
  const tokens = tokenize(text);
  if (tokens === undefined) return undefined;
  const result = parseNodes(tokens, 0);
  if (result === undefined) return undefined;
  const [nodes, index] = result;
  if (index !== tokens.length) return undefined;
  return nodes;
};

/** Экранирование значения так же, как его понимает {@link tokenize}. */
const escapeValue = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");

const formatNode = (node: VdfNode, depth: number): string => {
  const indent = "\t".repeat(depth);
  if (typeof node.value === "string")
    return `${indent}"${node.key}"\t\t"${escapeValue(node.value)}"`;
  return [
    `${indent}"${node.key}"`,
    `${indent}{`,
    ...node.value.map((child) => formatNode(child, depth + 1)),
    `${indent}}`,
  ].join("\n");
};

/** Пишет дерево обратно в VDF: табы, `"key"\t\t"value"`, как пишет Steam. */
export const formatVdf = (nodes: ReadonlyArray<VdfNode>): string =>
  nodes.length === 0
    ? ""
    : `${nodes.map((node) => formatNode(node, 0)).join("\n")}\n`;

const findChild = (nodes: ReadonlyArray<VdfNode>, key: string) =>
  nodes.find((node) => node.key.toLowerCase() === key.toLowerCase());

/** Значение по пути (регистронезависимый поиск ключей); нет — `undefined`. */
export const getPath = (
  nodes: ReadonlyArray<VdfNode> | undefined,
  path: ReadonlyArray<string>,
): VdfNode["value"] | undefined => {
  let current: ReadonlyArray<VdfNode> | undefined = nodes;
  let value: VdfNode["value"] | undefined;
  for (const key of path) {
    if (current === undefined) return undefined;
    const node = findChild(current, key);
    if (node === undefined) return undefined;
    value = node.value;
    current = typeof node.value === "string" ? undefined : node.value;
  }
  return value;
};

/**
 * Записывает значение (строку или — для очистки блока целиком, спека §4
 * «стирание входа» — пустой список узлов) по пути: существующие ключи на пути
 * ищутся регистронезависимо и сохраняют своё написание; недостающие —
 * создаются с написанием из `path`. Возвращает новое дерево (входное не
 * меняется).
 */
export const setPath = (
  nodes: ReadonlyArray<VdfNode>,
  path: ReadonlyArray<string>,
  value: VdfNode["value"],
): ReadonlyArray<VdfNode> => {
  const [key, ...rest] = path;
  if (key === undefined) throw new Error("setPath: empty path");
  const index = nodes.findIndex(
    (node) => node.key.toLowerCase() === key.toLowerCase(),
  );
  const existing = index === -1 ? undefined : nodes[index];
  const newNode: VdfNode =
    rest.length === 0
      ? { key: existing?.key ?? key, value }
      : {
          key: existing?.key ?? key,
          value: setPath(
            existing !== undefined && typeof existing.value !== "string"
              ? existing.value
              : [],
            rest,
            value,
          ),
        };
  if (index === -1) return [...nodes, newNode];
  const copy = [...nodes];
  copy[index] = newNode;
  return copy;
};

/**
 * Поля верхнего уровня блока `"AppState" { … }` манифеста Steam (вложенные
 * блоки — `InstalledDepots`, `UserConfig` — пропускаются). Не манифест —
 * `undefined`.
 */
export const parseAppManifest = (
  text: string,
): Record<string, string> | undefined => {
  const tokens = tokenize(text);
  const head = tokens?.[0];
  if (
    tokens === undefined ||
    head?.kind !== "string" ||
    head.value.toLowerCase() !== "appstate" ||
    tokens[1]?.kind !== "open"
  )
    return undefined;
  const fields: Record<string, string> = {};
  let depth = 1;
  let index = 2;
  while (depth > 0) {
    const token = tokens[index];
    if (token === undefined || token.kind === "open") return undefined;
    if (token.kind === "close") {
      depth--;
      index++;
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.kind === "close") return undefined;
    if (value.kind === "open") depth++;
    else if (depth === 1) fields[token.value] = value.value;
    index += 2;
  }
  return fields;
};

/** Имя каталога игры в `common/`: один компонент пути. */
export const isInstallDir = (name: string | undefined): name is string =>
  name !== undefined &&
  name !== "" &&
  name !== "." &&
  name !== ".." &&
  !name.includes("/") &&
  !name.includes("\0") &&
  Buffer.byteLength(name) <= 255;
