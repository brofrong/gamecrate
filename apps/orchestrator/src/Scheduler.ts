// Планировщик: раз в 2 с раздаёт сессии из очереди по свободным слотам
// подключённых воркеров и отправляет агенту StartSession; сессии неустановленных
// игр отправляет ждать установку (`installing`); сессии удаляемых игр ждут в
// очереди.
import {
  Db,
  eligibleWorkers,
  gamestoreApps,
  installJobs,
  ownGames,
  sessions,
  user,
} from "@cg/db";
import {
  isOwnAppId,
  type OwnGamePackage,
  type ProfileRef,
  accessDeniedReason,
} from "@cg/rpc";
import { and, asc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { Cause, DateTime, Effect, Layer, Schedule } from "effect";
import { AgentHub } from "./AgentHub";
import * as InstallRepo from "./InstallRepo";
import * as SessionRepo from "./SessionRepo";
import { holdsSlot } from "./SessionRepo";
import { SteamLoginSeeds } from "./SteamLoginSeeds";

/** Период планировщика. */
export const SCHEDULER_INTERVAL = "2 seconds";

/** Наименьший свободный слот `0..slots-1` или `undefined`. */
const lowestFreeSlot = (slots: number, busy: ReadonlySet<number>) => {
  for (let slot = 0; slot < slots; slot++) if (!busy.has(slot)) return slot;
  return undefined;
};

/** Не больше стольких назначений (включая отправки в установку) за проход. */
export const SCHEDULE_BATCH = 20;

/** Назначение одной сессии, уже записанное в БД. */
interface Placement {
  readonly _tag: "Placed";
  readonly session: {
    readonly id: string;
    readonly userId: string;
    readonly appId: number;
    readonly stateSince: Date;
    readonly agentSeenAt: Date | null;
  };
  readonly workerId: string;
  readonly slot: number;
  readonly udpPort: number;
  readonly profile: ProfileRef | null;
  /** Пометка сброса входа Steam пользователя (`SessionRepo.steamLoginResetAt`). */
  readonly steamLoginResetAt: Date | null;
  /**
   * Пакет своей игры, который нужно запустить (спека 2026-11-03 «Свои игры»);
   * нет поля — обычный запуск Steam.
   */
  readonly ownGame?: OwnGamePackage;
}

/**
 * Итог `placeOne`: `Placed` — назначена на воркер; `Installing` — ждёт задачу
 * установки; `Retry` — игру только что установили, или сессию заблокированного
 * пользователя завалили, сессию разберёт следующий `placeOne`; `undefined` —
 * делать нечего (ничего не нашлось, или просмотренные сессии не разместились).
 */
type Outcome =
  | Placement
  | {
      readonly _tag: "Installing";
      readonly sessionId: string;
      readonly jobId: string;
    }
  | { readonly _tag: "Retry" };

/**
 * Строка игры сессии есть в `gamestore_apps` (подзапрос по внешней `sessions`),
 * в том числе у удаляемой: её не ставим, пока агент не удалит игру.
 */
const appInLibrary: SQL = sql`exists (select 1 from ${gamestoreApps} where ${gamestoreApps.appId} = ${sessions.appId})`;

/** Игра сессии в общей библиотеке и не удаляется (`deleting_at is null`). */
const appInstalled: SQL = sql`exists (select 1 from ${gamestoreApps} where ${gamestoreApps.appId} = ${sessions.appId} and ${gamestoreApps.deletingAt} is null)`;

/**
 * У игры сессии есть строка каталога своих игр (спека 2026-11-03 «Свои игры»):
 * это своя игра (фанатский ПК-порт вне Steam), а не Steam-приложение, —
 * независимо от `published`. Такая сессия никогда не уходит в установку
 * (`placeOne`): пакет раскатывается на воркеры заранее, а не задачей
 * установки.
 */
const ownGameRow: SQL = sql`exists (select 1 from ${ownGames} where ${ownGames.appId} = ${sessions.appId})`;

/** Строка каталога своей игры сессии есть и открыта игрокам (`published`). */
const ownGamePublished: SQL = sql`exists (select 1 from ${ownGames} where ${ownGames.appId} = ${sessions.appId} and ${ownGames.published})`;

/**
 * У игры сессии есть активная (`queued`/`running`) задача установки, которую
 * админ попросил отменить (`cancel_requested_at`). Частичный уникальный индекс
 * `install_jobs_active_app_idx` не даст завести вторую активную задачу этой
 * игры, пока первая не закончится, — значит `startInstall`
 * (`InstallRepo.lockActiveJob`) присоединил бы новую сессию к отменяемой
 * задаче, и она тут же провалилась бы с «Установка отменена администратором».
 * Такую сессию оставляем в очереди без установки: новая задача появится, как
 * только отменяемая завершится.
 */
const appInstallCancelling: SQL = sql`exists (select 1 from ${installJobs} where ${installJobs.appId} = ${sessions.appId} and ${installJobs.state} in ('queued', 'running') and ${installJobs.cancelRequestedAt} is not null)`;

/**
 * У пользователя сессии нет активной (`queued`/`running`) задачи установки,
 * которую качают его Steam-профилем. Иначе сессия ждёт в очереди её конца:
 * профиль пользователя в каждый момент держит ровно один процесс (спека §6),
 * иначе выгрузка установщика сделала бы выгрузку сессии устаревшей.
 */
const ownerFree: SQL = sql`not exists (select 1 from ${installJobs} where ${installJobs.userId} = ${sessions.userId} and ${installJobs.state} in ('queued', 'running'))`;

/**
 * Пользователь сессии заблокирован админом (`user.blocked_at`). api проверяет
 * это при создании сессии, но админ мог заблокировать уже после — такую сессию
 * не размещаем и не ставим в установку, а валим (`blockedFailure`).
 */
const userBlocked: SQL<boolean> = sql<boolean>`exists (select 1 from ${user} where ${user.id} = ${sessions.userId} and ${user.blockedAt} is not null)`;

/** Не больше стольких `queued`-сессий установленной игры за один проход `placeOne`. */
export const PLACE_SCAN = 50;

/**
 * До `limit` самых старых `queued`-сессий (`created_at asc`) без запроса
 * остановки, чей пользователь не владеет активной задачей установки
 * (`ownerFree`), под условием `where`; `userBlocked` — заблокирован ли
 * пользователь каждой из них. `FOR UPDATE SKIP LOCKED` — параллельный
 * `placeOne` их не увидит и возьмёт следующие; блокировка держится до конца
 * транзакции, так что непомещённые сессии освобождаются сразу после коммита.
 */
const lockOldestQueued = (where: SQL, limit = 1) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .select({
        id: sessions.id,
        userId: sessions.userId,
        appId: sessions.appId,
        stateSince: sessions.stateSince,
        agentSeenAt: sessions.agentSeenAt,
        userBlocked,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.state, "queued"),
          isNull(sessions.stopRequestedAt),
          ownerFree,
          where,
        ),
      )
      .orderBy(asc(sessions.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });
  });

/**
 * Сессия заблокированного пользователя (`userBlocked`): `Failed` с причиной
 * `accessDeniedReason` вместо установки или размещения; итог `Retry`.
 */
const blockedFailure = (now: Date, sessionId: string) =>
  Effect.gen(function* () {
    const settings = yield* SessionRepo.loadSettings();
    yield* SessionRepo.transition(sessionId, now, settings, (row) =>
      row.state === "queued"
        ? { _tag: "Failed", reason: accessDeniedReason }
        : null,
    );
    yield* Effect.logInfo("Queued session of a blocked user failed", {
      sessionId,
    });
    return { _tag: "Retry" } as const;
  });

/**
 * Сессия неустановленной игры: задача установки — активная этого appid или
 * новая `queued` с `userId` сессии; `installJobId` и `InstallStarted`
 * (→ `installing`). Задача блокируется до проверки библиотеки: если её как раз
 * завершают, видим уже установленную игру (`Retry`), а не завершённую задачу.
 *
 * `appInstallCancelling` в `lockOldestQueued` и блокировка задачи тут — два
 * разных запроса в одной транзакции: между ними админская отмена (отдельная
 * транзакция `cancelInstall`) могла успеть закоммититься — тогда первый запрос
 * ещё не видел отмену, а `lockActiveJob` на блокировке уже её видит
 * (`cancelRequestedAt` не пуст). Присоединять сессию к такой задаче нельзя —
 * её немедленно провалит админская отмена; вместо этого `Retry` без всякой
 * записи в БД. Спина нет: к следующему вызову `placeOne` (в том же проходе
 * или следующем тике) отмена уже закоммичена и видна и первому запросу —
 * `appInstallCancelling` вернёт эту сессию в ветку "отменяемая игра, ждать в
 * очереди", а не сюда (экспортируется для теста этой гонки, M1).
 */
export const startInstall = (
  now: Date,
  session: {
    readonly id: string;
    readonly userId: string;
    readonly appId: number;
  },
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const locked = yield* InstallRepo.lockActiveJob(session.appId);
    if (yield* InstallRepo.isInstalled(session.appId))
      return { _tag: "Retry" } as const;
    if (locked !== undefined && locked.cancelRequestedAt !== null)
      return { _tag: "Retry" } as const;
    const jobId =
      locked?.id ??
      (yield* InstallRepo.createJob(session.appId, session.userId));
    yield* db
      .update(sessions)
      .set({ installJobId: jobId })
      .where(eq(sessions.id, session.id));
    const settings = yield* SessionRepo.loadSettings();
    yield* SessionRepo.transition(session.id, now, settings, (row) =>
      row.state === "queued" ? { _tag: "InstallStarted" } : null,
    );
    return { _tag: "Installing", sessionId: session.id, jobId } as const;
  });

/**
 * Одна транзакция на один проход. Сессия заблокированного пользователя (в
 * любой из веток ниже) не ставится и не размещается, а валится с
 * `accessDeniedReason` (`blockedFailure`). Сначала самая старая `queued`-
 * сессия неустановленной игры (её игры нет в `gamestore_apps`, `LIMIT 1`, и
 * она не своя игра — своя игра никогда не уходит в установку, `ownGameRow`),
 * чья задача установки не отменяется админом (`appInstallCancelling`), уходит
 * в установку (`startInstall`) — слот ей не нужен, поэтому она не ждёт
 * воркеров; сессия отменяемой игры остаётся в очереди и дождётся новой задачи
 * после её конца. Иначе — очередь без затора (спека §2.5): до `PLACE_SCAN`
 * самых старых `queued`-сессий установленных (`appInstalled`) или открытых
 * игрокам своих игр (`ownGamePublished`, спека 2026-11-03 «Свои игры»)
 * (`created_at asc`, `FOR UPDATE SKIP LOCKED`) просматриваются по очереди, для
 * каждой — `eligibleWorkers(userId, appId, { workerIds: candidates })`
 * (классы воркеров и железо, спека §2.1–§2.3; для своей игры он же проверяет
 * раскатанный пакет, `hasPackage`), первый из них со свободным слотом (слот —
 * наименьший свободный) размещает сессию; не нашёлся — переходим к следующей
 * сессии. Строка игры читается под `FOR SHARE` — `gamestore_apps` для
 * Steam-игры (api помечает удаление под `FOR UPDATE` и проверяет активные
 * сессии — либо мы видим пометку, либо api видит нашу сессию), `own_games`
 * для своей игры; удаляемая/непубликованная или пропавшая игра — сессия
 * пропускается, как и при отсутствии свободного воркера. Просмотренные, но не
 * размещённые сессии остаются заблокированными только до конца транзакции —
 * следующий проход их не пропустит. Размещение — `workerId`, `slot`,
 * `state = 'starting'`, `stateSince = agentSeenAt = now` и коммит; профиль и
 * пометка сброса входа Steam читаются в той же транзакции: сбой чтения
 * откатывает размещение, а не оставляет его без команды. Своя игра не входит
 * в Steam — пометка сброса входа для неё не читается (`steamLoginResetAt:
 * null` без запроса), `Placement.ownGame` несёт её пакет (`slug`/`version`).
 */
const placeOne = (now: Date, candidates: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const hub = yield* AgentHub;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const [uninstalled] = yield* lockOldestQueued(
          sql`not (${appInLibrary} or ${ownGameRow}) and not ${appInstallCancelling}`,
        );
        if (uninstalled !== undefined)
          return uninstalled.userBlocked
            ? yield* blockedFailure(now, uninstalled.id)
            : ((yield* startInstall(now, uninstalled)) as Outcome);

        if (candidates.length === 0) return undefined;
        const queued = yield* lockOldestQueued(
          sql`${appInstalled} or ${ownGamePublished}`,
          PLACE_SCAN,
        );
        if (queued.length === 0) return undefined;

        const taken = yield* db
          .select({ workerId: sessions.workerId, slot: sessions.slot })
          .from(sessions)
          .where(and(inArray(sessions.workerId, [...candidates]), holdsSlot));
        const busyOf = (workerId: string) =>
          new Set(
            taken.flatMap((t) =>
              t.workerId === workerId && t.slot !== null ? [t.slot] : [],
            ),
          );

        for (const session of queued) {
          if (session.userBlocked)
            return yield* blockedFailure(now, session.id);

          let ownGame: OwnGamePackage | undefined;
          if (isOwnAppId(session.appId)) {
            const [row] = yield* db
              .select({
                slug: ownGames.slug,
                version: ownGames.version,
                published: ownGames.published,
              })
              .from(ownGames)
              .where(eq(ownGames.appId, session.appId))
              .for("share");
            if (row === undefined || !row.published) continue;
            ownGame = { slug: row.slug, version: row.version };
          } else {
            const [app] = yield* db
              .select({ deletingAt: gamestoreApps.deletingAt })
              .from(gamestoreApps)
              .where(eq(gamestoreApps.appId, session.appId))
              .for("share");
            if (app === undefined || app.deletingAt !== null) continue;
          }

          const eligible = yield* eligibleWorkers(
            session.userId,
            session.appId,
            { workerIds: candidates },
          );
          for (const { id: workerId } of eligible) {
            const info = hub.info(workerId);
            if (info === undefined) continue;
            const slot = lowestFreeSlot(info.slots, busyOf(workerId));
            if (slot === undefined) continue;
            yield* db
              .update(sessions)
              .set({
                state: "starting",
                stateSince: now,
                workerId,
                slot,
                agentSeenAt: now,
              })
              .where(eq(sessions.id, session.id));
            const profile = yield* SessionRepo.profileOf(session.userId);
            // Своя игра не входит в Steam — ни читать, ни сбрасывать её вход
            // не нужно (ниже, в `tick`, это и держит `steamLogin: null`).
            const steamLoginResetAt =
              ownGame === undefined
                ? yield* SessionRepo.steamLoginResetAt(session.userId)
                : null;
            return {
              _tag: "Placed",
              session,
              workerId,
              slot,
              udpPort: info.udpPortBase + slot,
              profile,
              steamLoginResetAt,
              ...(ownGame !== undefined && { ownGame }),
            } satisfies Placement;
          }
        }
        return undefined;
      }),
    );
  });

/**
 * Агент не принял StartSession: вернуть сессию в очередь (прежние `stateSince`
 * и `agentSeenAt`), если её за это время никто не трогал.
 */
const unplace = (placement: Placement) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .update(sessions)
      .set({
        state: "queued",
        stateSince: placement.session.stateSince,
        agentSeenAt: placement.session.agentSeenAt,
        workerId: null,
        slot: null,
      })
      .where(
        and(
          eq(sessions.id, placement.session.id),
          eq(sessions.state, "starting"),
          eq(sessions.workerId, placement.workerId),
        ),
      );
  });

/**
 * Один проход планировщика: по одной сессии за транзакцию (`placeOne`), не
 * больше `SCHEDULE_BATCH` за проход. Сессии размещаются только на агентах с
 * ролью `worker`. StartSession (`udpPort = udpPortBase + slot`)
 * уходит после коммита, поэтому сбой не откатит уже отправленные команды.
 * Есть пометка сброса входа Steam — посеянный раньше неё вход забывается
 * (`clearOlderThan`), а команда несёт `steamLoginResetAt` (ISO); пометки нет —
 * поля в команде нет. Своя игра (`placement.ownGame`, спека 2026-11-03 «Свои
 * игры») не входит в Steam: `steamLoginResetAt` для неё всегда `null`
 * (`placeOne` его не читал), `seeds.get` не вызывается — команда несёт
 * `steamLogin: null` и `ownGame` вместо обычного Steam-входа.
 * `send` вернул `false` — сессия возвращается в `queued` (`unplace`), а воркер
 * до конца прохода не используется. Если процесс упадёт между коммитом и
 * отправкой, сессия останется `starting` без агента и её завершит таймаут
 * агента (90 с от `agentSeenAt = now`).
 */
export const tick = (now: Date) =>
  Effect.gen(function* () {
    const hub = yield* AgentHub;
    const seeds = yield* SteamLoginSeeds;
    let candidates = [...hub.connected()].filter(
      (id) => hub.info(id)?.roles.includes("worker") ?? false,
    );
    let placed = 0;
    while (placed < SCHEDULE_BATCH) {
      const placement = yield* placeOne(now, candidates);
      if (placement === undefined) return;
      if (placement._tag !== "Placed") {
        placed++;
        if (placement._tag === "Installing")
          yield* Effect.logInfo("Session waits for game install", {
            sessionId: placement.sessionId,
            jobId: placement.jobId,
          });
        continue;
      }
      const {
        session,
        workerId,
        slot,
        udpPort,
        profile,
        steamLoginResetAt,
        ownGame,
      } = placement;
      // Вход, посеянный до сброса админом, устарел: не отправляем и забываем.
      // Своя игра не входит в Steam (`steamLoginResetAt` для неё всегда
      // `null`, см. `placeOne`) — эта ветка для неё не выполняется.
      if (steamLoginResetAt !== null)
        yield* seeds.clearOlderThan(session.userId, steamLoginResetAt);
      // Своя игра не читает посеянный вход Steam — он ей не нужен.
      const steamLogin =
        ownGame === undefined ? yield* seeds.get(session.userId) : null;
      const display = yield* SessionRepo.displaySizeFor(session.userId);
      const sent = yield* hub.send(workerId, {
        _tag: "StartSession",
        sessionId: session.id,
        userId: session.userId,
        appId: session.appId,
        slot,
        udpPort,
        profile,
        steamLogin,
        display,
        ...(steamLoginResetAt !== null && {
          steamLoginResetAt: steamLoginResetAt.toISOString(),
        }),
        ...(ownGame !== undefined && { ownGame }),
      });
      if (sent) {
        placed++;
        yield* Effect.logInfo("Session scheduled", {
          sessionId: session.id,
          workerId,
          slot,
          udpPort,
        });
      } else {
        yield* unplace(placement);
        // Агент отключился между проверкой и отправкой — в этом проходе не трогаем.
        candidates = candidates.filter((id) => id !== workerId);
        yield* Effect.logWarning(
          "StartSession not delivered, session stays queued",
          { sessionId: session.id, workerId },
        );
      }
    }
  });

/** Фоновый цикл планировщика (каждые 2 с); сбои прохода логируются. */
export const layer: Layer.Layer<never, never, Db | AgentHub | SteamLoginSeeds> =
  Layer.effectDiscard(
    DateTime.nowAsDate.pipe(
      Effect.flatMap(tick),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logError("Scheduler tick failed", Cause.pretty(cause)),
      ),
      Effect.repeat(Schedule.spaced(SCHEDULER_INTERVAL)),
      Effect.forkScoped,
    ),
  );
