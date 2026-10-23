// Сборка четырёх файлов, которыми клиент Steam внутри контейнера узнаёт о
// готовом входе (спека §4, проверено пробой на brofrong 2026-10-23). Чистые
// функции: чтение/запись контейнера — дело вызывающего (Task 3).
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { formatVdf, parseVdf, setPath, type VdfNode } from "./vdf";

/** Пути файлов входа относительно `/home/ubuntu` (дома сессии/установщика). */
export const LOGIN_FILES = {
  localVdf: ".local/share/Steam/local.vdf",
  loginUsers: ".local/share/Steam/config/loginusers.vdf",
  config: ".local/share/Steam/config/config.vdf",
  registry: ".steam/registry.vdf",
} as const;

/**
 * Ключ записи `ConnectCache`: CRC-32 (IEEE) от `accountName`, hex строчными,
 * **без** дополнения нулями слева, плюс `"1"`. Вариант с ведущим нулём клиент
 * Steam проигнорировал (проба) — поэтому паддинг не добавляется никогда.
 */
export const connectCacheKey = (accountName: string): string =>
  `${crc32(accountName).toString(16)}1`;

/** `K = SHA-256(accountName)` — ключ AES-256 для обеих стадий шифрования. */
const deriveKey = (accountName: string) =>
  createHash("sha256").update(accountName, "utf8").digest();

const IV_LENGTH = 16;

/**
 * `hex(accountName, token)` по формату §4: `AES-256-ECB(K)(IV) ‖
 * AES-256-CBC(K, IV, PKCS7(token))`. ECB здесь шифрует сам IV одним блоком
 * (без паддинга — он уже 16 байт), чтобы клиент мог восстановить IV для CBC
 * без отдельного канала; `iv` — обычно случайный, но параметр фиксируется в
 * тестах.
 */
export const encryptConnectCache = (
  accountName: string,
  token: string,
  iv: Uint8Array = crypto.getRandomValues(new Uint8Array(IV_LENGTH)),
): string => {
  const key = deriveKey(accountName);
  const ivCipher = createCipheriv("aes-256-ecb", key, null);
  ivCipher.setAutoPadding(false);
  const encryptedIv = Buffer.concat([
    ivCipher.update(iv),
    ivCipher.final(),
  ]);
  const bodyCipher = createCipheriv("aes-256-cbc", key, iv);
  const body = Buffer.concat([
    bodyCipher.update(token, "utf8"),
    bodyCipher.final(),
  ]);
  return Buffer.concat([encryptedIv, body]).toString("hex");
};

/** Обратное преобразование `encryptConnectCache` — только для тестов/проверки. */
export const decryptConnectCache = (
  accountName: string,
  hex: string,
): string => {
  const key = deriveKey(accountName);
  const bytes = Buffer.from(hex, "hex");
  const encryptedIv = bytes.subarray(0, IV_LENGTH);
  const body = bytes.subarray(IV_LENGTH);
  const ivDecipher = createDecipheriv("aes-256-ecb", key, null);
  ivDecipher.setAutoPadding(false);
  const iv = Buffer.concat([
    ivDecipher.update(encryptedIv),
    ivDecipher.final(),
  ]);
  const bodyDecipher = createDecipheriv("aes-256-cbc", key, iv);
  const token = Buffer.concat([
    bodyDecipher.update(body),
    bodyDecipher.final(),
  ]);
  return token.toString("utf8");
};

/** Разобрать файл или начать с пустого дерева — нечитаемый не бросает исключение. */
const parseOrEmpty = (text: string | undefined): ReadonlyArray<VdfNode> =>
  (text !== undefined ? parseVdf(text) : undefined) ?? [];

/** `setPath` для нескольких полей одного блока за один проход. */
const setFields = (
  nodes: ReadonlyArray<VdfNode>,
  fields: Record<string, string>,
): ReadonlyArray<VdfNode> =>
  Object.entries(fields).reduce(
    (acc, [key, value]) => setPath(acc, [key], value),
    nodes,
  );

interface Seed {
  readonly accountName: string;
  readonly steamId: string;
  readonly token: string;
}

const findChild = (nodes: ReadonlyArray<VdfNode>, key: string) =>
  nodes.find((node) => node.key.toLowerCase() === key.toLowerCase());

/** `local.vdf`: запись ConnectCache этого аккаунта; остальное — как было. */
const applyLocalVdf = (text: string | undefined, seed: Seed): string =>
  formatVdf(
    setPath(
      parseOrEmpty(text),
      [
        "MachineUserConfigStore",
        "Software",
        "Valve",
        "Steam",
        "ConnectCache",
        connectCacheKey(seed.accountName),
      ],
      encryptConnectCache(seed.accountName, seed.token),
    ),
  );

/**
 * `loginusers.vdf`: блок `users/<steamId>` — автологин этого аккаунта;
 * у остальных пользователей `MostRecent`/`AutoLogin` сбрасываются в `"0"`.
 */
const applyLoginUsers = (
  text: string | undefined,
  seed: Seed,
  now: number,
): string => {
  const nodes = parseOrEmpty(text);
  const usersNode = findChild(nodes, "users");
  const usersKey = usersNode?.key ?? "users";
  const existingUsers: ReadonlyArray<VdfNode> =
    usersNode !== undefined && typeof usersNode.value !== "string"
      ? usersNode.value
      : [];
  const targetNode = findChild(existingUsers, seed.steamId);
  const targetKey = targetNode?.key ?? seed.steamId;
  const targetFields =
    targetNode !== undefined && typeof targetNode.value !== "string"
      ? targetNode.value
      : [];
  const previousPersona = findChild(targetFields, "PersonaName");
  const personaName =
    previousPersona !== undefined && typeof previousPersona.value === "string"
      ? previousPersona.value
      : seed.accountName;
  const others = existingUsers
    .filter((user) => user.key !== targetKey)
    .map((user) =>
      typeof user.value === "string"
        ? user
        : {
            key: user.key,
            value: setFields(user.value, {
              MostRecent: "0",
              AutoLogin: "0",
            }),
          },
    );
  const updatedTarget: VdfNode = {
    key: targetKey,
    value: setFields(targetFields, {
      AccountName: seed.accountName,
      PersonaName: personaName,
      RememberPassword: "1",
      WantsOfflineMode: "0",
      SkipOfflineModeWarning: "0",
      AutoLogin: "1",
      MostRecent: "1",
      timestamp: String(now),
    }),
  };
  const newUsersNode: VdfNode = {
    key: usersKey,
    value: [...others, updatedTarget],
  };
  const updated =
    usersNode !== undefined
      ? nodes.map((node) => (node === usersNode ? newUsersNode : node))
      : [...nodes, newUsersNode];
  return formatVdf(updated);
};

/** `config.vdf`: `SteamID` аккаунта; остальное — как было. */
const applyConfig = (text: string | undefined, seed: Seed): string =>
  formatVdf(
    setPath(
      parseOrEmpty(text),
      [
        "InstallConfigStore",
        "Software",
        "Valve",
        "Steam",
        "Accounts",
        seed.accountName,
        "SteamID",
      ],
      seed.steamId,
    ),
  );

/** `registry.vdf`: автологин этого аккаунта. */
const applyRegistry = (text: string | undefined, seed: Seed): string => {
  const base = parseOrEmpty(text);
  const withUser = setPath(
    base,
    ["Registry", "HKCU", "Software", "Valve", "Steam", "AutoLoginUser"],
    seed.accountName,
  );
  return formatVdf(
    setPath(
      withUser,
      ["Registry", "HKCU", "Software", "Valve", "Steam", "RememberPassword"],
      "1",
    ),
  );
};

/**
 * Собирает все четыре файла входа (спека §4) из текущего содержимого (может
 * отсутствовать — пустой дом, или не парситься — повреждён, в обоих случаях
 * файл создаётся с нуля без исключения) и посеянного входа.
 */
export const applyLoginSeed = (
  current: Partial<Record<keyof typeof LOGIN_FILES, string>>,
  seed: Seed,
  now: number,
): Record<keyof typeof LOGIN_FILES, string> => ({
  localVdf: applyLocalVdf(current.localVdf, seed),
  loginUsers: applyLoginUsers(current.loginUsers, seed, now),
  config: applyConfig(current.config, seed),
  registry: applyRegistry(current.registry, seed),
});
