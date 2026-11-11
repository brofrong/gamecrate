// Планировщик: раз в 2 с раздаёт сессии из очереди по свободным слотам
// подключённых воркеров и отправляет агенту StartSession. Библиотека игр своя
// у каждого сервера (спека 2026-11-09 §5): сессия Steam-игры размещается
// только там, где игра стоит; нет её ни на одном подходящем сервере — сессия
// ждёт установку (`installing`) на выбранный сервер.
import {
  Db,
  eligibleWorkers,
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
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
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
 * У игры сессии есть строка каталога своих игр (спека 2026-11-03 «Свои игры»):
 * это своя игра (фанатский ПК-порт вне Steam), а не Steam-приложение, —
 * независимо от `published`. Такая сессия никогда не уходит в установку
 * (`placeOne`): пакет раскатывается на воркеры заранее, а не задачей
 * установки; непубликованную `placeOne` даже не просматривает.
 */
const ownGameRow: SQL = sql`exists (select 1 from ${ownGames} where ${ownGames.appId} = ${sessions.appId})`;

/** Строка каталога своей игры сессии есть и открыта игрокам (`published`). */
const ownGamePublished: SQL = sql`exists (select 1 from ${ownGames} where ${ownGames.appId} = ${sessions.appId} and ${ownGames.published})`;

/**
 * Игру сессии можно запустить: Steam-игра или открытая игрокам своя игра
 * (`placeOne` просматривает только такие сессии).
 */
export const placeableGame: SQL = sql`(${ownGamePublished} or not ${ownGameRow})`;

/**
 * Игры, у которых есть активная (`queued`/`running`) задача установки (на
 * любом сервере), которую админ попросил отменить (`cancel_requested_at`).
 * `startInstall` (`InstallRepo.lockActiveJob`) мог бы присоединить новую
 * сессию к отменяемой задаче, и она тут же провалилась бы с «Установка
 * отменена администратором». Сессию такой игры, если игра не стоит ни на
 * одном подходящем сервере, оставляем в очереди без установки: новая задача
 * появится, как только отменяемая завершится.
 */
const installCancellingApps = () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .selectDistinct({ appId: installJobs.appId })
      .from(installJobs)
      .where(
        and(
          inArray(installJobs.state, ["queued", "running"]),
          isNotNull(installJobs.cancelRequestedAt),
        ),
      );
    return new Set(rows.map((r) => r.appId));
  });

/**
 * У пользователя сессии нет активной (`queued`/`running`) задачи установки,
 * которую качают его Steam-профилем. Иначе сессия ждёт в очереди её конца:
 * профиль пользователя в каждый момент держит ровно один процесс (спека §6),
 * иначе выгрузка установщика сделала бы выгрузку сессии устаревшей.
 */
export const ownerFree: SQL = sql`not exists (select 1 from ${installJobs} where ${installJobs.userId} = ${sessions.userId} and ${installJobs.state} in ('queued', 'running'))`;

/**
 * Пользователь сессии заблокирован админом (`user.blocked_at`). api проверяет
 * это при создании сессии, но админ мог заблокировать уже после — такую сессию
 * не размещаем и не ставим в установку, а валим (`blockedFailure`).
 */
export const userBlocked: SQL<boolean> = sql<boolean>`exists (select 1 from ${user} where ${user.id} = ${sessions.userId} and ${user.blockedAt} is not null)`;

/** Не больше стольких `queued`-сессий за один проход `placeOne`. */
export const PLACE_SCAN = 50;

/**
 * Сессия ждёт в очереди: `queued` без запроса остановки, пользователь не
 * владеет активной задачей установки (`ownerFree`).
 */
export const waitingInQueue: SQL = and(
  eq(sessions.state, "queued"),
  isNull(sessions.stopRequestedAt),
  ownerFree,
)!;

/**
 * Порядок размещения (спека 2026-11-10 §5): приоритет тарифа по убыванию,
 * затем время входа в очередь (`created_at`; после установки сессия его
 * сохраняет и не уходит в хвост).
 */
export const queueOrder = [
  desc(sessions.queuePriority),
  asc(sessions.createdAt),
] as const;

/**
 * До `limit` первых по `queueOrder` сессий очереди (`waitingInQueue`) под
 * условием `where`; `userBlocked` — заблокирован ли пользователь каждой из
 * них. `FOR UPDATE SKIP LOCKED` — параллельный
 * `placeOne` их не увидит и возьмёт следующие; блокировка держится до конца
 * транзакции, так что непомещённые сессии освобождаются сразу после коммита.
 */
const lockQueueHead = (where: SQL, limit = 1) =>
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
      .where(and(waitingInQueue, where))
      .orderBy(...queueOrder)
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
 * Сессия игры, которой нет в библиотеке ни одного подходящего ей сервера
 * (`eligible` — годные ей подключённые воркеры, спека 2026-11-09 §5):
 * задача установки — активная этой игры на одном из `eligible`
 * (`lockActiveJob`) или новая `queued` на `targets[0]` с `userId` сессии;
 * `installJobId` и `InstallStarted` (→ `installing`). Слот за сессией не
 * держится: после установки она снова `queued` и ждёт слот на сервере, где
 * игра теперь стоит. `targets` — серверы, куда можно ставить (с ролью
 * `gamestore`, без строки библиотеки этой игры, сначала со свободным слотом,
 * см. `placeOne`); пусто и активной задачи нет — `undefined`, сессия ждёт в
 * очереди без записи в БД. Задача блокируется до проверки библиотеки: если её
 * как раз завершают, видим уже установленную игру (`Retry`), а не
 * завершённую задачу.
 *
 * `installCancellingApps` в `placeOne` и блокировка задачи тут — два
 * разных запроса в одной транзакции: между ними админская отмена (отдельная
 * транзакция `cancelInstall`) могла успеть закоммититься — тогда первый запрос
 * ещё не видел отмену, а `lockActiveJob` на блокировке уже её видит
 * (`cancelRequestedAt` не пуст). Присоединять сессию к такой задаче нельзя —
 * её немедленно провалит админская отмена; вместо этого `Retry` без всякой
 * записи в БД. Спина нет: к следующему вызову `placeOne` (в том же проходе
 * или следующем тике) отмена уже закоммичена и видна и первому запросу —
 * `installCancellingApps` оставит эту сессию ждать в очереди, а не пошлёт
 * сюда (экспортируется для теста этой гонки, M1).
 */
export const startInstall = (
  now: Date,
  session: {
    readonly id: string;
    readonly userId: string;
    readonly appId: number;
  },
  eligible: ReadonlyArray<string>,
  targets: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const locked = yield* InstallRepo.lockActiveJob(session.appId, eligible);
    const installed = yield* InstallRepo.installedOn(session.appId);
    if (installed.some((workerId) => eligible.includes(workerId)))
      return { _tag: "Retry" } as const;
    if (locked !== undefined && locked.cancelRequestedAt !== null)
      return { _tag: "Retry" } as const;
    const [target] = targets;
    if (locked === undefined && target === undefined) return undefined;
    const jobId =
      locked?.id ??
      (yield* InstallRepo.createJob(target!, session.appId, session.userId));
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
 * Одна транзакция на один проход: до `PLACE_SCAN` первых по `queueOrder`
 * `queued`-сессий Steam-игр и открытых игрокам своих игр (`placeableGame`,
 * спека 2026-11-03 «Свои игры»; `FOR UPDATE SKIP LOCKED`)
 * просматриваются по очереди — очередь без затора (спека §2.5): сессия,
 * которой сейчас некуда, не держит следующие. Для каждой:
 *
 * 1. Пользователь заблокирован админом — сессия валится с
 *    `accessDeniedReason` (`blockedFailure`), итог `Retry`.
 * 2. `eligible = eligibleWorkers(userId, appId, { workerIds: candidates })`
 *    (подключённые воркеры с ролью `worker`; классы и железо, спека
 *    §2.1–§2.3; для Steam-игры — собранный клиент Steam, для своей игры —
 *    раскатанный пакет, `hasPackage`). Пусто — следующая сессия.
 * 3. Своя игра: строка `own_games` под `FOR SHARE`, пропавшая или
 *    непубликованная — следующая сессия; иначе её размещают на первом из
 *    `eligible` со свободным слотом. Своя игра никогда не уходит в установку.
 * 4. Steam-игра — библиотека сервера (спека 2026-11-09 §5): `installed` —
 *    серверы из `eligible`, где игра стоит и не удаляется
 *    (`InstallRepo.installedOn`, строки под `FOR SHARE` — api помечает
 *    удаление под `FOR UPDATE` и проверяет сессии этого сервера: либо мы
 *    видим пометку, либо api видит нашу сессию). Не пусто — первый из них
 *    со свободным слотом, иначе сессия ждёт: игра где-то уже стоит, вторую
 *    копию на другой сервер не ставим, даже если там свободно.
 * 5. Игры нет ни на одном подходящем сервере (на серверах вне `eligible` —
 *    не на связи, на обслуживании, слабых — она не в счёт): установку игры
 *    отменяет админ (`installCancellingApps`) — сессия ждёт; иначе
 *    `startInstall` — присоединиться к активной задаче на одном из
 *    `eligible` или завести новую на первом из `eligible` с ролью
 *    `gamestore`, без строки этой игры (удаляемой) и со свободным слотом,
 *    иначе на первом такой же без свободного слота. Таких серверов нет —
 *    сессия ждёт.
 *
 * Слот — наименьший свободный. Просмотренные, но не размещённые сессии
 * остаются заблокированными только до конца транзакции — следующий проход их
 * не пропустит. Размещение — `workerId`, `slot`, `state = 'starting'`,
 * `stateSince = agentSeenAt = now` и коммит; профиль и пометка сброса входа
 * Steam читаются в той же транзакции: сбой чтения откатывает размещение, а не
 * оставляет его без команды. Своя игра не входит в Steam — пометка сброса
 * входа для неё не читается (`steamLoginResetAt: null` без запроса),
 * `Placement.ownGame` несёт её пакет (`slug`/`version`).
 */
const placeOne = (now: Date, candidates: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const hub = yield* AgentHub;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const queued = yield* lockQueueHead(placeableGame, PLACE_SCAN);
        if (queued.length === 0) return undefined;
        const cancelling = yield* installCancellingApps();

        const taken =
          candidates.length === 0
            ? []
            : yield* db
                .select({ workerId: sessions.workerId, slot: sessions.slot })
                .from(sessions)
                .where(
                  and(inArray(sessions.workerId, [...candidates]), holdsSlot),
                );
        const busyOf = (workerId: string) =>
          new Set(
            taken.flatMap((t) =>
              t.workerId === workerId && t.slot !== null ? [t.slot] : [],
            ),
          );
        /** Наименьший свободный слот подключённого воркера или `undefined`. */
        const freeSlotOf = (workerId: string) => {
          const info = hub.info(workerId);
          if (info === undefined) return undefined;
          const slot = lowestFreeSlot(info.slots, busyOf(workerId));
          return slot === undefined ? undefined : { info, slot };
        };

        for (const session of queued) {
          if (session.userBlocked)
            return yield* blockedFailure(now, session.id);

          const eligible = (yield* eligibleWorkers(
            session.userId,
            session.appId,
            { workerIds: candidates },
          )).map((w) => w.id);
          if (eligible.length === 0) continue;

          let ownGame: OwnGamePackage | undefined;
          let placeOn: ReadonlyArray<string>;
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
            placeOn = eligible;
          } else {
            const installed = new Set(
              yield* InstallRepo.installedOn(session.appId),
            );
            placeOn = eligible.filter((id) => installed.has(id));
            if (placeOn.length === 0) {
              if (cancelling.has(session.appId)) continue;
              const inLibrary = new Set(
                yield* InstallRepo.libraryWorkersOf(session.appId),
              );
              const gamestores = eligible.filter(
                (id) =>
                  !inLibrary.has(id) &&
                  (hub.info(id)?.roles.includes("gamestore") ?? false),
              );
              const targets = [
                ...gamestores.filter((id) => freeSlotOf(id) !== undefined),
                ...gamestores.filter((id) => freeSlotOf(id) === undefined),
              ];
              const outcome = yield* startInstall(
                now,
                session,
                eligible,
                targets,
              );
              if (outcome === undefined) continue;
              return outcome as Outcome;
            }
          }

          for (const workerId of placeOn) {
            const free = freeSlotOf(workerId);
            if (free === undefined) continue;
            const { info, slot } = free;
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
