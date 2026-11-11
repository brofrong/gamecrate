// Полные заглушки модулей `src/rpc.ts` и `src/auth.ts` для `mock.module`.
//
// `mock.module` в Bun подменяет модуль на весь прогон `bun test`, а не на файл: какой
// файл подменил последним, того набор имён и видят модули, загруженные позже. При
// `--randomize` порядок файлов случаен — если в подмене нет имени, которое импортирует
// загружаемый позже компонент, падает «Export named … not found». Поэтому каждая
// подмена начинается с `...rpcStub()`/`...authStub()` (все имена настоящего модуля,
// инертные значения) и поверх задаёт свои. Что набор имён совпадает с настоящим —
// проверяет `moduleStubs.test.ts`.
import { Cause, Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

const query = () => Atom.make(AsyncResult.initial());
const queryFamily = () => Atom.family((_key: unknown) => query());
const mutation = () => Atom.fn((_arg: unknown) => Effect.succeed(undefined));

const libraryKeys = ["library"] as const;
const sessionKeys = ["session"] as const;
const settingsKeys = ["settings"] as const;
const adminKeys = ["admin"] as const;
const streamSettingsKeys = ["streamSettings"] as const;

const errorTag = (cause: Cause.Cause<{ readonly _tag: string }>) =>
  Option.getOrUndefined(
    Option.map(Cause.findErrorOption(cause), (error) => error._tag),
  );

/** Все экспорты `src/rpc.ts`: запросы — `initial`, мутации — успех без значения, `…Args` — как настоящие. */
export const rpcStub = () => ({
  Api: class {},
  meAtom: query(),
  providersAtom: query(),
  libraryAtom: query(),
  refreshLibraryAtom: mutation(),
  refreshLibraryArgs: { payload: undefined, reactivityKeys: libraryKeys },
  recentAtom: query(),
  trendingAtom: query(),
  timeSummaryAtom: queryFamily(),
  gameAtom: queryFamily(),
  adminPingAtom: query(),
  activeSessionAtom: query(),
  startSessionAtom: mutation(),
  startSessionArgs: (appId: number) => ({
    payload: { appId },
    reactivityKeys: sessionKeys,
  }),
  sessionWatchAtom: queryFamily(),
  heartbeatAtom: mutation(),
  stopSessionAtom: mutation(),
  startSteamLoginAtom: mutation(),
  steamLoginStatusAtom: mutation(),
  sessionSettingsAtom: query(),
  updateSessionSettingsAtom: mutation(),
  updateSessionSettingsArgs: (payload: unknown) => ({
    payload,
    reactivityKeys: settingsKeys,
  }),
  adminWorkersAtom: query(),
  adminSessionsAtom: queryFamily(),
  adminStopSessionAtom: mutation(),
  adminStopSessionArgs: (sessionId: string) => ({
    payload: { sessionId },
    reactivityKeys: adminKeys,
  }),
  adminSetDrainingAtom: mutation(),
  adminSetDrainingArgs: (workerId: string, draining: boolean) => ({
    payload: { workerId, draining },
    reactivityKeys: adminKeys,
  }),
  adminClassesAtom: query(),
  adminCreateClassAtom: mutation(),
  adminCreateClassArgs: (name: string) => ({
    payload: { name },
    reactivityKeys: adminKeys,
  }),
  adminRenameClassAtom: mutation(),
  adminRenameClassArgs: (id: string, name: string) => ({
    payload: { id, name },
    reactivityKeys: adminKeys,
  }),
  adminMoveClassAtom: mutation(),
  adminMoveClassArgs: (id: string, direction: "up" | "down") => ({
    payload: { id, direction },
    reactivityKeys: adminKeys,
  }),
  adminDeleteClassAtom: mutation(),
  adminDeleteClassArgs: (id: string) => ({
    payload: { id },
    reactivityKeys: adminKeys,
  }),
  adminSetWorkerClassAtom: mutation(),
  adminSetWorkerClassArgs: (workerId: string, classId: string | null) => ({
    payload: { workerId, classId },
    reactivityKeys: adminKeys,
  }),
  adminRegionsAtom: query(),
  adminCreateRegionAtom: mutation(),
  adminCreateRegionArgs: (code: string, name: string) => ({
    payload: { code, name },
    reactivityKeys: adminKeys,
  }),
  adminUpdateRegionAtom: mutation(),
  adminUpdateRegionArgs: (id: string, name: string, position: number) => ({
    payload: { id, name, position },
    reactivityKeys: adminKeys,
  }),
  adminDeleteRegionAtom: mutation(),
  adminDeleteRegionArgs: (id: string) => ({
    payload: { id },
    reactivityKeys: adminKeys,
  }),
  adminCreateWorkerAtom: mutation(),
  adminCreateWorkerArgs: (id: string, regionId: string) => ({
    payload: { id, regionId },
    reactivityKeys: adminKeys,
  }),
  adminIssueWorkerCodeAtom: mutation(),
  adminIssueWorkerCodeArgs: (workerId: string) => ({
    payload: { workerId },
    reactivityKeys: adminKeys,
  }),
  adminRevokeWorkerAtom: mutation(),
  adminRevokeWorkerArgs: (workerId: string) => ({
    payload: { workerId },
    reactivityKeys: adminKeys,
  }),
  adminSetWorkerRegionAtom: mutation(),
  adminSetWorkerRegionArgs: (workerId: string, regionId: string | null) => ({
    payload: { workerId, regionId },
    reactivityKeys: adminKeys,
  }),
  adminGamesAtom: query(),
  adminDeleteGameAtom: mutation(),
  adminDeleteGameArgs: (appId: number) => ({
    payload: { appId },
    reactivityKeys: adminKeys,
  }),
  adminGameRequirementsAtom: queryFamily(),
  adminSetGameRequirementsAtom: mutation(),
  adminSetGameRequirementsArgs: (appId: number, requirements: unknown) => ({
    payload: { appId, requirements },
    reactivityKeys: adminKeys,
  }),
  adminSetOwnGamePublishedAtom: mutation(),
  adminSetOwnGamePublishedArgs: (appId: number, published: boolean) => ({
    payload: { appId, published },
    reactivityKeys: adminKeys,
  }),
  adminInstallsAtom: query(),
  streamSettingsAtom: query(),
  saveStreamSettingsAtom: mutation(),
  saveStreamSettingsArgs: (settings: unknown) => ({
    payload: settings,
    reactivityKeys: streamSettingsKeys,
  }),
  adminCancelInstallAtom: mutation(),
  adminCancelInstallArgs: (jobId: string) => ({
    payload: { jobId },
    reactivityKeys: adminKeys,
  }),
  adminUsersAtom: query(),
  adminSetRoleAtom: mutation(),
  adminSetRoleArgs: (userId: string, role: string) => ({
    payload: { userId, role },
    reactivityKeys: adminKeys,
  }),
  adminSetBlockedAtom: mutation(),
  adminSetBlockedArgs: (userId: string, blocked: boolean) => ({
    payload: { userId, blocked },
    reactivityKeys: adminKeys,
  }),
  adminResetSteamLoginAtom: mutation(),
  adminResetSteamLoginArgs: (userId: string) => ({
    payload: { userId },
    reactivityKeys: adminKeys,
  }),
  adminTariffsAtom: query(),
  adminCreateTariffAtom: mutation(),
  adminCreateTariffArgs: (input: unknown) => ({
    payload: { input },
    reactivityKeys: adminKeys,
  }),
  adminUpdateTariffAtom: mutation(),
  adminUpdateTariffArgs: (id: string, input: unknown) => ({
    payload: { id, input },
    reactivityKeys: adminKeys,
  }),
  adminSetTariffDefaultAtom: mutation(),
  adminSetTariffDefaultArgs: (id: string) => ({
    payload: { id },
    reactivityKeys: adminKeys,
  }),
  adminSetTariffArchivedAtom: mutation(),
  adminSetTariffArchivedArgs: (id: string, archived: boolean) => ({
    payload: { id, archived },
    reactivityKeys: adminKeys,
  }),
  adminHourPacksAtom: query(),
  adminCreateHourPackAtom: mutation(),
  adminCreateHourPackArgs: (input: unknown) => ({
    payload: { input },
    reactivityKeys: adminKeys,
  }),
  adminUpdateHourPackAtom: mutation(),
  adminUpdateHourPackArgs: (id: string, input: unknown) => ({
    payload: { id, input },
    reactivityKeys: adminKeys,
  }),
  adminSetHourPackArchivedAtom: mutation(),
  adminSetHourPackArchivedArgs: (id: string, archived: boolean) => ({
    payload: { id, archived },
    reactivityKeys: adminKeys,
  }),
  adminUserPlanAtom: queryFamily(),
  adminGrantTariffAtom: mutation(),
  adminGrantTariffArgs: (
    userId: string,
    tariffId: string,
    endsAt: string | null,
  ) => ({
    payload: { userId, tariffId, endsAt },
    reactivityKeys: adminKeys,
  }),
  adminRevokeTariffAtom: mutation(),
  adminRevokeTariffArgs: (userId: string) => ({
    payload: { userId },
    reactivityKeys: adminKeys,
  }),
  adminAddMinutesAtom: mutation(),
  adminAddMinutesArgs: (userId: string, minutes: number, comment: string) => ({
    payload: { userId, minutes, comment },
    reactivityKeys: adminKeys,
  }),
  errorTag,
  resultErrorTag: <A, E extends { readonly _tag: string }>(
    result: AsyncResult.AsyncResult<A, E>,
  ) => (AsyncResult.isFailure(result) ? errorTag(result.cause) : undefined),
});

/** Все экспорты `src/auth.ts`: без сети, ответы «успех» (`{ error: null }`, пустой список). */
export const authStub = () => ({
  authClient: {},
  signInWithProvider: async () => {},
  sendEmailCode: async () => ({ error: null }),
  signInWithEmailCode: async () => ({ error: null }),
  linkProvider: async () => {},
  unlinkProvider: async () => ({ error: null }),
  linkSteam: async () => {},
  listLinkedAccounts: async () => [],
  requestEmailChange: async () => ({ data: null, error: null }),
  confirmEmailChange: async () => ({ data: null, error: null }),
  signOut: async () => {},
});
