// Effect RPC-клиент по WebSocket на `/rpc` (NDJSON, как на сервере) и атомы для React.
import { AppRpcs, type Requirements, type Role, type StreamSettings } from "@cg/rpc";
import { BrowserSocket } from "@effect/platform-browser";
import { Cause, Effect, Layer, Option, Stream } from "effect";
import { AsyncResult, Atom, AtomRpc } from "effect/reactivity";
import { RpcClient, RpcSerialization } from "effect/rpc";

/** `ws(s)://<тот же хост>/rpc`: cookie сессии уходит с апгрейдом сам (same origin). */
const rpcUrl = () => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/rpc`;
};

export class Api extends AtomRpc.Service<Api>()("@cg/web/Api", {
  group: AppRpcs,
  protocol: (_get) =>
    RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
      Layer.provide(BrowserSocket.layerWebSocket(rpcUrl())),
      Layer.provide(RpcSerialization.layerNdjson),
    ),
}) {}

/** Ключ реактивности библиотеки: `library.refresh` после успеха перезапрашивает `library.list`. */
const libraryKeys = ["library"] as const;

/** Пользователь сессии; `Unauthorized` — не вошёл. */
export const meAtom = Api.query("auth.me", undefined);

/** Какие способы входа включены на сервере — доступно без сессии. */
export const providersAtom = Api.query("auth.providers", undefined);

/** Библиотека из БД (сервер сам синхронизирует её при первом обращении). */
export const libraryAtom = Api.query("library.list", undefined, {
  reactivityKeys: libraryKeys,
});

/** Синхронизировать библиотеку со Steam сейчас. */
export const refreshLibraryAtom = Api.mutation("library.refresh");
export const refreshLibraryArgs = {
  payload: undefined,
  reactivityKeys: libraryKeys,
} as const;

/** Блок «Запускал недавно» на главной `/app`. */
export const recentAtom = Api.query("library.recent", undefined, {
  reactivityKeys: libraryKeys,
});

/** Блок «В тренде» на главной `/app`: сейчас и за неделю. */
export const trendingAtom = Api.query("library.trending", undefined);

/** Сводка времени за месяц (`"YYYY-MM"`) для страницы «Время». */
export const timeSummaryAtom = Atom.family((month: string) =>
  Api.query("time.summary", { month }),
);

/** Страница игры `/app/game/<appId>` (`library.game`); обновляется вместе с библиотекой. */
export const gameAtom = Atom.family((appId: number) =>
  Api.query("library.game", { appId }, { reactivityKeys: libraryKeys }),
);

/** Проверка доступа к `admin.*` (только роль admin). */
export const adminPingAtom = Api.query("admin.ping", undefined);

/** Ключ реактивности сессий: `session.start` перезапрашивает `session.active`. */
const sessionKeys = ["session"] as const;

/** Активная сессия пользователя (не `ended`/`failed`) или null. */
export const activeSessionAtom = Api.query("session.active", undefined, {
  reactivityKeys: sessionKeys,
});

/** Запустить игру (или получить уже активную сессию). */
export const startSessionAtom = Api.mutation("session.start");
export const startSessionArgs = (appId: number) =>
  ({ payload: { appId }, reactivityKeys: sessionKeys }) as const;

/**
 * Поток `session.watch`: последнее представление сессии. Пока поток идёт — `Success`
 * с `waiting`; после терминального состояния поток завершается — `Success` без `waiting`.
 * Обрыв сокета — `Failure` (с прошлым значением): переподписка — `useAtomRefresh`.
 * Атом не keepAlive: ушли со страницы — подписка отменяется.
 */
export const sessionWatchAtom = Atom.family((sessionId: string) =>
  Api.runtime.atom(
    Stream.unwrap(
      Api.use((client) =>
        Effect.succeed(client("session.watch", { sessionId })),
      ),
    ),
  ),
);

/** Heartbeat страницы сессии (`inputAgeMs` — мс с последнего ввода). */
export const heartbeatAtom = Api.mutation("session.heartbeat");

/** Попросить остановить сессию («Выйти из игры»). */
export const stopSessionAtom = Api.mutation("session.stop");

/** Завести новую попытку входа в Steam по QR (отменяет прежнюю активную). */
export const startSteamLoginAtom = Api.mutation("steamLogin.start");

/** Текущее состояние попытки входа в Steam по QR — опрашивается вручную, не атомом-запросом. */
export const steamLoginStatusAtom = Api.mutation("steamLogin.status");

/** Ключ реактивности настроек сессий в админке. */
const settingsKeys = ["settings"] as const;

export const sessionSettingsAtom = Api.query("admin.settings.get", undefined, {
  reactivityKeys: settingsKeys,
});
export const updateSessionSettingsAtom = Api.mutation("admin.settings.update");
export const updateSessionSettingsArgs = <A>(payload: A) =>
  ({ payload, reactivityKeys: settingsKeys }) as const;

/** Ключ реактивности воркеров и сессий админки: «Остановить»/обслуживание перезапрашивают списки. */
const adminKeys = ["admin"] as const;

/** Воркеры со снимками железа/загрузки и активными сессиями (вкладка «Воркеры», опрос раз в 5 с). */
export const adminWorkersAtom = Api.query("admin.workers.list", undefined, {
  reactivityKeys: adminKeys,
});

/** Активные и недавние сессии; `true` — только сбои («Последние сбои», «Только сбои»). */
export const adminSessionsAtom = Atom.family((failedOnly: boolean) =>
  Api.query(
    "admin.sessions.list",
    { failedOnly },
    { reactivityKeys: adminKeys },
  ),
);

/** «Остановить» чужую сессию из админки (тот же `stop_requested_at`, что у игрока). */
export const adminStopSessionAtom = Api.mutation("admin.sessions.stop");
export const adminStopSessionArgs = (sessionId: string) =>
  ({ payload: { sessionId }, reactivityKeys: adminKeys }) as const;

/** «На обслуживание» / «Вернуть в работу». */
export const adminSetDrainingAtom = Api.mutation("admin.workers.setDraining");
export const adminSetDrainingArgs = (workerId: string, draining: boolean) =>
  ({ payload: { workerId, draining }, reactivityKeys: adminKeys }) as const;

/** Классы воркеров (блок «Классы» на вкладке «Воркеры», спека §5.1). */
export const adminClassesAtom = Api.query("admin.classes.list", undefined, {
  reactivityKeys: adminKeys,
});

/** Новый класс самым слабым («Добавить класс»). */
export const adminCreateClassAtom = Api.mutation("admin.classes.create");
export const adminCreateClassArgs = (name: string) =>
  ({ payload: { name }, reactivityKeys: adminKeys }) as const;

/** Переименовать класс. */
export const adminRenameClassAtom = Api.mutation("admin.classes.rename");
export const adminRenameClassArgs = (id: string, name: string) =>
  ({ payload: { id, name }, reactivityKeys: adminKeys }) as const;

/** Поднять/опустить класс («вверх» — сильнее, «вниз» — слабее). */
export const adminMoveClassAtom = Api.mutation("admin.classes.move");
export const adminMoveClassArgs = (id: string, direction: "up" | "down") =>
  ({ payload: { id, direction }, reactivityKeys: adminKeys }) as const;

/** Удалить класс (запрет, если у него есть воркеры — `"inUse"`). */
export const adminDeleteClassAtom = Api.mutation("admin.classes.delete");
export const adminDeleteClassArgs = (id: string) =>
  ({ payload: { id }, reactivityKeys: adminKeys }) as const;

/** Назначить класс воркеру (выбор в карточке воркера; `null` — без класса). */
export const adminSetWorkerClassAtom = Api.mutation("admin.workers.setClass");
export const adminSetWorkerClassArgs = (
  workerId: string,
  classId: string | null,
) => ({ payload: { workerId, classId }, reactivityKeys: adminKeys }) as const;

/** Игры общей библиотеки + служебные пакеты (вкладка «Игры», опрос раз в 5 с). */
export const adminGamesAtom = Api.query("admin.games.list", undefined, {
  reactivityKeys: adminKeys,
});

/** Пометить игру к удалению («Удалить» на вкладке «Игры»). */
export const adminDeleteGameAtom = Api.mutation("admin.games.delete");
export const adminDeleteGameArgs = (appId: number) =>
  ({ payload: { appId }, reactivityKeys: adminKeys }) as const;

/** Требования и замеры по моделям GPU одной игры (панель на вкладке «Игры», спека §5.2). */
export const adminGameRequirementsAtom = Atom.family((appId: number) =>
  Api.query(
    "admin.games.requirements",
    { appId },
    { reactivityKeys: adminKeys },
  ),
);

/** Сохранить требования игры или удалить строку (`requirements: null`). */
export const adminSetGameRequirementsAtom = Api.mutation(
  "admin.games.setRequirements",
);
export const adminSetGameRequirementsArgs = (
  appId: number,
  requirements: Requirements | null,
) => ({ payload: { appId, requirements }, reactivityKeys: adminKeys }) as const;

/** Активные и недавние задачи установки (вкладка «Установки»). */
export const adminInstallsAtom = Api.query("admin.installs.list", undefined, {
  reactivityKeys: adminKeys,
});

/** Ключ реактивности настроек стрима: `save` перезапрашивает `get` следующей сессией. */
const streamSettingsKeys = ["streamSettings"] as const;

/** Настройки стрима из аккаунта (качество, битрейт, разрешение, отладка, спека §4). */
export const streamSettingsAtom = Api.query("streamSettings.get", undefined, {
  reactivityKeys: streamSettingsKeys,
});

/** Сохранить настройки стрима (меню сессии, с debounce — `useStreamSettings`). */
export const saveStreamSettingsAtom = Api.mutation("streamSettings.save");
export const saveStreamSettingsArgs = (settings: StreamSettings) =>
  ({ payload: settings, reactivityKeys: streamSettingsKeys }) as const;

/** Попросить отменить активную задачу установки («Отменить» на вкладке «Установки»). */
export const adminCancelInstallAtom = Api.mutation("admin.installs.cancel");
export const adminCancelInstallArgs = (jobId: string) =>
  ({ payload: { jobId }, reactivityKeys: adminKeys }) as const;

/** Пользователи (вкладка «Пользователи», опрос раз в 5 с). */
export const adminUsersAtom = Api.query("admin.users.list", undefined, {
  reactivityKeys: adminKeys,
});

/** Сменить роль пользователя («Сделать админом» / «Сделать игроком»). */
export const adminSetRoleAtom = Api.mutation("admin.users.setRole");
export const adminSetRoleArgs = (userId: string, role: Role) =>
  ({ payload: { userId, role }, reactivityKeys: adminKeys }) as const;

/** Заблокировать/разблокировать пользователя. */
export const adminSetBlockedAtom = Api.mutation("admin.users.setBlocked");
export const adminSetBlockedArgs = (userId: string, blocked: boolean) =>
  ({ payload: { userId, blocked }, reactivityKeys: adminKeys }) as const;

/** Попросить сбросить вход Steam в контейнере пользователя. */
export const adminResetSteamLoginAtom = Api.mutation(
  "admin.users.resetSteamLogin",
);
export const adminResetSteamLoginArgs = (userId: string) =>
  ({ payload: { userId }, reactivityKeys: adminKeys }) as const;

/** `_tag` типизированной ошибки RPC (`Unauthorized`, `Forbidden`, `SteamUnavailable`, `RpcClientError`…). */
export const errorTag = (cause: Cause.Cause<{ readonly _tag: string }>) =>
  Option.getOrUndefined(
    Option.map(Cause.findErrorOption(cause), (error) => error._tag),
  );

/** `_tag` ошибки неуспешного `AsyncResult`, иначе `undefined`. */
export const resultErrorTag = <A, E extends { readonly _tag: string }>(
  result: AsyncResult.AsyncResult<A, E>,
) => (AsyncResult.isFailure(result) ? errorTag(result.cause) : undefined);
