// Защита от open redirect: `next`/`callbackURL` из query-строки может прийти
// от злоумышленника (`//evil.com`, `https://evil.com`, `/\evil.com`) — пропускаем
// только относительный путь на этом же origin, иначе отдаём `fallback`.
export const safeNext = (value: unknown, fallback = "/app"): string => {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//")) return fallback;
  if (value.includes("\\")) return fallback;
  return value;
};
