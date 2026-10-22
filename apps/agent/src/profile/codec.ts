// Формат зашифрованного профиля: `CGP1` (4 байта ASCII) + IV (12 байт) +
// AES-256-GCM(gzip(tar)) с тегом аутентификации в конце шифротекста.
import { Effect, Redacted, Schema } from "effect";

/** Сигнатура формата (первые 4 байта объекта). */
export const PROFILE_MAGIC = "CGP1";
const MAGIC_BYTES = new TextEncoder().encode(PROFILE_MAGIC);
/** Длина IV для AES-GCM (96 бит — рекомендация NIST). */
const IV_LENGTH = 12;
/** Длина ключа AES-256. */
export const PROFILE_KEY_LENGTH = 32;

/**
 * Объект повреждён или зашифрован другим ключом: не прошёл магическую
 * сигнатуру, AES-GCM тег аутентификации или распаковку gzip.
 */
export class ProfileCorrupt extends Schema.TaggedError<ProfileCorrupt>()(
  "ProfileCorrupt",
  { reason: Schema.String },
) {}

/** `PROFILE_KEY` не является валидным base64 ровно 32 байт. */
export class ProfileKeyInvalid extends Schema.TaggedError<ProfileKeyInvalid>()(
  "ProfileKeyInvalid",
  { reason: Schema.String },
) {}

/**
 * Разбирает `PROFILE_KEY` (base64) в `CryptoKey` AES-256-GCM. Ровно
 * {@link PROFILE_KEY_LENGTH} байт после декодирования — иначе `ProfileKeyInvalid`.
 * Значение ключа никогда не попадает в ошибку.
 */
export const importProfileKey = (
  base64: Redacted.Redacted<string>,
): Effect.Effect<CryptoKey, ProfileKeyInvalid> =>
  Effect.gen(function* () {
    const raw = new Uint8Array(Buffer.from(Redacted.value(base64), "base64"));
    if (raw.length !== PROFILE_KEY_LENGTH)
      return yield* Effect.fail(
        new ProfileKeyInvalid({
          reason: `ожидается ${PROFILE_KEY_LENGTH} байт, получено ${raw.length}`,
        }),
      );
    return yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
          "encrypt",
          "decrypt",
        ]),
      catch: () =>
        new ProfileKeyInvalid({ reason: "не удалось импортировать ключ" }),
    });
  });

/** Шифрует и сжимает tar профиля: `CGP1` + IV + AES-256-GCM(gzip(tar)). */
export const sealProfile = (
  tar: Uint8Array,
  key: CryptoKey,
): Effect.Effect<Uint8Array> =>
  Effect.promise(async () => {
    const gzipped = Bun.gzipSync(new Uint8Array(tar));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, gzipped),
    );
    const blob = new Uint8Array(
      MAGIC_BYTES.length + iv.length + ciphertext.length,
    );
    blob.set(MAGIC_BYTES, 0);
    blob.set(iv, MAGIC_BYTES.length);
    blob.set(ciphertext, MAGIC_BYTES.length + iv.length);
    return blob;
  });

/** Проверяет сигнатуру, расшифровывает и распаковывает `blob` в исходный tar. */
export const openProfile = (
  blob: Uint8Array,
  key: CryptoKey,
): Effect.Effect<Uint8Array, ProfileCorrupt> =>
  Effect.gen(function* () {
    const headerLength = MAGIC_BYTES.length + IV_LENGTH;
    if (blob.length <= headerLength)
      return yield* Effect.fail(
        new ProfileCorrupt({ reason: "объект короче заголовка" }),
      );
    const magic = blob.subarray(0, MAGIC_BYTES.length);
    const magicOk = MAGIC_BYTES.every((byte, index) => magic[index] === byte);
    if (!magicOk)
      return yield* Effect.fail(
        new ProfileCorrupt({ reason: "неверная сигнатура" }),
      );
    const iv = blob.subarray(MAGIC_BYTES.length, headerLength);
    const ciphertext = blob.subarray(headerLength);
    const gzipped = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.decrypt(
          { name: "AES-GCM", iv: new Uint8Array(iv) },
          key,
          new Uint8Array(ciphertext),
        ),
      catch: () =>
        new ProfileCorrupt({ reason: "не удалось расшифровать (AES-GCM)" }),
    });
    return yield* Effect.try({
      try: () => Bun.gunzipSync(new Uint8Array(gzipped)),
      catch: () => new ProfileCorrupt({ reason: "повреждён gzip" }),
    });
  });

/**
 * Содержимое единственного файла из ustar tar (заголовок 512 байт, размер —
 * октальное поле со смещением 124, длиной 12 байт).
 */
export const extractSingleFile = (tar: Uint8Array): Uint8Array => {
  const HEADER_SIZE = 512;
  const SIZE_FIELD_OFFSET = 124;
  const SIZE_FIELD_LENGTH = 12;
  const sizeText = new TextDecoder()
    .decode(
      tar.subarray(SIZE_FIELD_OFFSET, SIZE_FIELD_OFFSET + SIZE_FIELD_LENGTH),
    )
    .replace(/\0/g, "")
    .trim();
  const size = Number.parseInt(sizeText, 8);
  return tar.subarray(HEADER_SIZE, HEADER_SIZE + size);
};

/**
 * Ustar tar с одним файлом `name` (для `PUT /containers/{id}/archive`):
 * заголовок 512 байт, данные с выравниванием, два нулевых блока. Владелец и права
 * — из `options` (Docker распаковывает с ними). `name` — до 100 байт ASCII.
 */
export const singleFileTar = (
  name: string,
  data: Uint8Array,
  options: {
    readonly uid: number;
    readonly gid: number;
    readonly mode: number;
    /** Время изменения, секунды Unix. */
    readonly mtime: number;
  },
): Uint8Array => {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);
  if (nameBytes.length > 100 || /[^\x20-\x7e]/.test(name))
    throw new Error(`tar entry name not supported: ${JSON.stringify(name)}`);
  const octal = (value: number, width: number) =>
    encoder.encode(`${value.toString(8).padStart(width - 1, "0")}\0`);
  const header = new Uint8Array(512);
  header.set(nameBytes, 0);
  header.set(octal(options.mode, 8), 100);
  header.set(octal(options.uid, 8), 108);
  header.set(octal(options.gid, 8), 116);
  header.set(octal(data.length, 12), 124);
  header.set(octal(options.mtime, 12), 136);
  header.set(encoder.encode("        "), 148);
  header[156] = "0".charCodeAt(0);
  header.set(encoder.encode("ustar\0"), 257);
  header.set(encoder.encode("00"), 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  const tar = new Uint8Array(512 + Math.ceil(data.length / 512) * 512 + 1024);
  tar.set(header, 0);
  tar.set(data, 512);
  return tar;
};
