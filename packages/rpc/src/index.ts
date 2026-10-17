// Пакет @cg/rpc: схемы RPC-групп auth/library/admin, общие для сервера и SPA.
import { AdminRpcs } from "./admin";
import { AuthRpcs } from "./auth";
import { LibraryRpcs } from "./library";

export * from "./admin";
export * from "./auth";
export * from "./library";

/** Все RPC-группы приложения; сервер обслуживает их на `/rpc`, SPA строит по ней клиента. */
export const AppRpcs = AuthRpcs.merge(AdminRpcs, LibraryRpcs);
