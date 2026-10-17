// Пакет @cg/rpc: схемы RPC-групп auth/library/admin, общие для сервера и SPA,
// и протокол агента `AgentRpcs` (только оркестратор, не входит в `AppRpcs`).
import { AdminRpcs } from "./admin";
import { AuthRpcs } from "./auth";
import { LibraryRpcs } from "./library";

export * from "./admin";
export * from "./agent";
export * from "./auth";
export * from "./library";
export * from "./settings";

/** Все RPC-группы приложения; сервер обслуживает их на `/rpc`, SPA строит по ней клиента. */
export const AppRpcs = AuthRpcs.merge(AdminRpcs, LibraryRpcs);
