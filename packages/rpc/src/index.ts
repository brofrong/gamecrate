// Пакет @cg/rpc: схемы RPC-групп auth/library/admin/session, общие для сервера и SPA,
// и протокол агента `AgentRpcs` (только оркестратор, не входит в `AppRpcs`).
import { AdminRpcs } from "./admin";
import { AuthRpcs, PublicAuthRpcs } from "./auth";
import { LibraryRpcs } from "./library";
import { SessionRpcs } from "./session";
import { SteamLoginRpcs } from "./steamLogin";

export * from "./admin";
export * from "./agent";
export * from "./auth";
export * from "./library";
export * from "./loginMethods";
export * from "./session";
export * from "./settings";
export * from "./steamLogin";

/** Все RPC-группы приложения; сервер обслуживает их на `/rpc`, SPA строит по ней клиента. */
export const AppRpcs = AuthRpcs.merge(
  PublicAuthRpcs,
  AdminRpcs,
  LibraryRpcs,
  SessionRpcs,
  SteamLoginRpcs,
);
