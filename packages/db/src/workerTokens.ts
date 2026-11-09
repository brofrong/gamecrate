// Токены серверов и одноразовые коды подключения (спека §3, план, «Global
// Constraints»): общие хелперы для api (выдача в админке, Task 2) и
// оркестратора (проверка `Authorization: Bearer` при подключении агента,
// Task 3) — отсюда и место в `@cg/db`, а не в `apps/api`. Секреты в БД
// хранятся только как SHA-256 hex (`worker_credentials.token_hash`/
// `enroll_code_hash`), сам код/токен виден вызывающему только один раз,
// в момент выдачи.
import { createHash, randomBytes } from "node:crypto";

/** SHA-256 значения в hex — то, что хранится в БД и с чем сравнивают присланный секрет. */
export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** Постоянный токен сервера: `cgw_` + 43 символа base64url (32 случайных байта). */
export const newWorkerToken = (): string =>
  `cgw_${randomBytes(32).toString("base64url")}`;

/**
 * Алфавит одноразового кода подключения: без символов, которые легко
 * спутать при ручном наборе (нет `0`/`O`, `1`/`I`). 32 символа —
 * специально степень двойки, чтобы ниже не нужен был `% length`, который
 * сместил бы частоты символов для алфавита произвольной длины.
 */
const ENROLL_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ENROLL_CODE_LENGTH = 24;

/** Код подключения живёт 24 часа — см. `worker_credentials.enroll_expires_at`. */
export const ENROLL_CODE_TTL_MS = 86_400_000;

/**
 * Одноразовый код подключения: 24 символа `ENROLL_CODE_ALPHABET`. Отбор с
 * отбрасыванием (rejection sampling), а не `byte % alphabet.length`: при
 * алфавите длиной не степень двойки `%` сместил бы частоты символов
 * (некоторые индексы алфавита получали бы больше значений байта, чем
 * другие) — здесь длина алфавита (32) делит 256 без остатка, так что
 * смещения не было бы и без отбора, но код написан не завязанным на это
 * совпадение.
 */
export const newEnrollCode = (): string => {
  const limit =
    Math.floor(256 / ENROLL_CODE_ALPHABET.length) * ENROLL_CODE_ALPHABET.length;
  let code = "";
  while (code.length < ENROLL_CODE_LENGTH) {
    for (const byte of randomBytes(ENROLL_CODE_LENGTH - code.length)) {
      if (byte >= limit) continue;
      code += ENROLL_CODE_ALPHABET[byte % ENROLL_CODE_ALPHABET.length];
      if (code.length === ENROLL_CODE_LENGTH) break;
    }
  }
  return code;
};

/** Id сервера (`workers.id`, `WORKER_ID` в конфиге агента). */
export const WORKER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** Короткий код региона (`regions.code`), например `spb`, `msk`. */
export const REGION_CODE_PATTERN = /^[a-z][a-z0-9-]{1,15}$/;
