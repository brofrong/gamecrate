// Разбор составного ustar (`filesTar`, несколько записей подряд) для тестов:
// `extractSingleFile` (src/profile/codec.ts) понимает только архив с ровно
// одной записью, а посев входа (Task 3) кладёт каталоги и файлы одним tar.

/**
 * Данные файловой записи `name` в составном ustar; каталоги и записи с другим
 * именем пропускаются. Нет такой записи (или это каталог) — `undefined`.
 */
export const findTarEntry = (
  tar: Uint8Array,
  name: string,
): Uint8Array | undefined => {
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const entryName = decoder
      .decode(header.subarray(0, 100))
      .replace(/\0.*$/s, "");
    if (entryName === "") break;
    const sizeText = decoder
      .decode(header.subarray(124, 136))
      .replace(/\0/g, "")
      .trim();
    const size = Number.parseInt(sizeText, 8);
    const dataStart = offset + 512;
    if (entryName === name || entryName.endsWith(`/${name}`))
      return header[156] === "5".charCodeAt(0)
        ? undefined
        : tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return undefined;
};
