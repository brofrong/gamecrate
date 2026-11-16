// Витрина (бренд) запроса по хосту: письма, `index.html` и т. п. Подмена хоста клиентом
// допустима — бренд влияет только на оформление, не на доступ.
import { BRANDS, type BrandMeta, brandForHost } from "@cg/brands";
import type { AppConfigValues } from "../config";

/** Хост запроса: `x-forwarded-host` (первое значение), иначе `host`; нет обоих — `undefined`. */
export const requestHost = (headers: Headers): string | undefined => {
  const forwarded = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const host = headers.get("host")?.trim();
  return host ? host : undefined;
};

/** Бренд по хосту запроса; без заголовков или с неизвестным хостом — основной. */
export const brandOfRequest = (
  headers: Headers | undefined,
  config: AppConfigValues,
): BrandMeta =>
  BRANDS[
    brandForHost(
      headers === undefined ? undefined : requestHost(headers),
      config.brandHosts,
    )
  ];
