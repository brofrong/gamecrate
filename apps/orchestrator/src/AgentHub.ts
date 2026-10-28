// AgentHub: подключённые агенты воркеров. Держит по одному потоку команд на воркер,
// отправляет команды и публикует события (подключение, отчёты, отключение) в PubSub.
import { Db, workers } from "@cg/db";
import {
  type AgentCommand,
  type AgentConnect,
  AgentNotConnected,
  type AgentReport,
  type AgentRoles,
  type RunningSession,
  type WorkerHardware,
  type WorkerVersions,
} from "@cg/rpc";
import { eq, sql } from "drizzle-orm";
import {
  type Cause,
  Context,
  Effect,
  Layer,
  PubSub,
  Queue,
  type Scope,
  Semaphore,
  Stream,
} from "effect";

/** Сведения о подключённом воркере (из `agent.connect`). */
export interface WorkerInfo {
  readonly workerId: string;
  readonly publicIp: string;
  readonly slots: number;
  /** Слот `i` — UDP-порт `udpPortBase + i`. В БД не хранится. */
  readonly udpPortBase: number;
  /** `worker` — принимает сессии, `gamestore` — установки игр; пишется в `workers.roles`. */
  readonly roles: AgentRoles;
  /** Снимок железа и версий воркера (админка); нет в `agent.connect` → `undefined`, в БД — `null`. */
  readonly hardware?: WorkerHardware | undefined;
  readonly versions?: WorkerVersions | undefined;
}

/**
 * События хаба.
 * - `Connected` — агент подключился (или переподключился), строка `workers` уже
 *   записана; `running` — сессии, которые уже идут на воркере, `installs` —
 *   id задач установки, чьи контейнеры у агента ещё живы.
 * - `Report` — отчёт агента текущего соединения воркера.
 * - `Disconnected` — соединение воркера оборвалось и более нового нет.
 *   Замена соединения более новым `Disconnected` не публикует.
 */
export type AgentHubEvent =
  | (WorkerInfo & {
      readonly _tag: "Connected";
      readonly running: ReadonlyArray<RunningSession>;
      readonly installs: ReadonlyArray<string>;
    })
  | {
      readonly _tag: "Report";
      readonly workerId: string;
      readonly report: AgentReport;
    }
  | { readonly _tag: "Disconnected"; readonly workerId: string };

export interface AgentHubShape {
  /** Отправить команду воркеру; `false` — агент воркера не подключён. */
  readonly send: (
    workerId: string,
    command: AgentCommand,
  ) => Effect.Effect<boolean>;
  /** Воркеры с открытым соединением агента. */
  readonly connected: () => ReadonlySet<string>;
  /** Сведения о подключённом воркере; не подключён — `undefined`. */
  readonly info: (workerId: string) => WorkerInfo | undefined;
  /** Воркер текущего соединения WebSocket-клиента `clientId` (`undefined` — нет `agent.connect`). */
  readonly workerOf: (clientId: number) => string | undefined;
  /** PubSub событий хаба (неограниченный). */
  readonly events: PubSub.PubSub<AgentHubEvent>;
  /** Подписка на события с этого момента; живёт в scope. */
  readonly subscribe: Effect.Effect<
    PubSub.Subscription<AgentHubEvent>,
    never,
    Scope.Scope
  >;
  /**
   * Обработчик `agent.connect`: upsert `workers`, регистрация соединения,
   * поток команд. `clientId` — id WebSocket-клиента RPC-сервера.
   */
  readonly connect: (
    clientId: number,
    payload: AgentConnect,
  ) => Stream.Stream<AgentCommand>;
  /** Обработчик `agent.report` от WebSocket-клиента `clientId`. */
  readonly report: (
    clientId: number,
    report: AgentReport,
  ) => Effect.Effect<void, AgentNotConnected>;
}

interface Connection {
  readonly id: number;
  readonly clientId: number;
  readonly info: WorkerInfo;
  readonly commands: Queue.Queue<AgentCommand, Cause.Done>;
}

const make = Effect.gen(function* () {
  const db = yield* Db;
  const events = yield* PubSub.unbounded<AgentHubEvent>();
  /** Текущее соединение каждого воркера. */
  const byWorker = new Map<string, Connection>();
  /** Воркер текущего соединения по id WebSocket-клиента. */
  const byClient = new Map<number, string>();
  /** Воркеры, о подключении которых подписчики узнали (`Connected` без `Disconnected`). */
  const announced = new Set<string>();
  let nextId = 0;

  const upsertWorker = (info: WorkerInfo) => {
    const now = new Date();
    return db
      .insert(workers)
      .values({
        id: info.workerId,
        publicIp: info.publicIp,
        slots: info.slots,
        roles: [...info.roles],
        hardware: info.hardware ?? null,
        versions: info.versions ?? null,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: workers.id,
        set: {
          publicIp: sql`excluded.public_ip`,
          slots: sql`excluded.slots`,
          roles: sql`excluded.roles`,
          hardware: sql`excluded.hardware`,
          versions: sql`excluded.versions`,
          lastSeenAt: now,
        },
      });
  };

  /** Соединение всё ещё текущее для своего воркера. */
  const isCurrent = (connection: Connection) =>
    byWorker.get(connection.info.workerId)?.id === connection.id;

  /**
   * Регистрирует соединение (синхронно, в порядке прихода `agent.connect`):
   * побеждает самое новое, прежнее соединение воркера завершается.
   */
  const register = (connection: Connection) =>
    Effect.gen(function* () {
      const { workerId } = connection.info;
      const previous = byWorker.get(workerId);
      // Сначала убрать маршрут прежнего соединения: у повторного connect по тому
      // же сокету clientId совпадает, и удаление после set стёрло бы новый маршрут.
      if (
        previous !== undefined &&
        byClient.get(previous.clientId) === workerId
      )
        byClient.delete(previous.clientId);
      byWorker.set(workerId, connection);
      byClient.set(connection.clientId, workerId);
      if (previous !== undefined) yield* Queue.end(previous.commands);
    });

  /** Соединение закрыто: если оно ещё текущее — воркер отключён. */
  const unregister = (connection: Connection) =>
    Effect.gen(function* () {
      if (!isCurrent(connection)) return;
      const { workerId } = connection.info;
      byWorker.delete(workerId);
      if (byClient.get(connection.clientId) === workerId)
        byClient.delete(connection.clientId);
      // Подписчики не видели `Connected` этого воркера — нечего отключать.
      if (!announced.delete(workerId)) return;
      yield* PubSub.publish(events, { _tag: "Disconnected", workerId });
      yield* Effect.logInfo("Agent disconnected", { workerId });
    });

  /**
   * Upsert'ы `workers` по одному: соединение пишет строку, только если оно ещё
   * текущее, поэтому вытесненное (более старое) соединение не перезапишет
   * `publicIp`/`slots` более нового.
   */
  const upsertLock = yield* Semaphore.make(1);

  /**
   * Upsert `workers`, затем `Connected` — строка воркера уже есть (на неё ссылаются
   * сессии). Вытесненное за это время соединение ничего не пишет и не публикует.
   */
  const announce = (
    connection: Connection,
    running: ReadonlyArray<RunningSession>,
    installs: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      if (!isCurrent(connection)) return;
      yield* upsertWorker(connection.info).pipe(Effect.orDie);
      if (!isCurrent(connection)) return;
      announced.add(connection.info.workerId);
      yield* PubSub.publish(events, {
        _tag: "Connected",
        ...connection.info,
        running,
        installs,
      });
      yield* Effect.logInfo("Agent connected", {
        workerId: connection.info.workerId,
        roles: connection.info.roles,
        running: running.length,
        installs: installs.length,
      });
    });

  const connect: AgentHubShape["connect"] = (clientId, payload) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { running, installs, ...info } = payload;
        // Scope этого эффекта — время жизни потока: release срабатывает при обрыве
        // соединения (сервер прерывает поток) или замене более новым соединением.
        const connection = yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const connection: Connection = {
              id: nextId++,
              clientId,
              info,
              commands: yield* Queue.unbounded<AgentCommand, Cause.Done>(),
            };
            yield* register(connection);
            return connection;
          }),
          unregister,
        );
        yield* upsertLock.withPermit(announce(connection, running, installs));
        return Stream.fromQueue(connection.commands);
      }),
    );

  const report: AgentHubShape["report"] = (clientId, agentReport) =>
    Effect.gen(function* () {
      const workerId = byClient.get(clientId);
      if (workerId === undefined) return yield* new AgentNotConnected();
      // Снимок загрузки — только в БД (история не нужна), без публикации в
      // PubSub: подписчики хаба (SessionRunner и т.п.) его не ждут.
      if (agentReport._tag === "WorkerStats") {
        yield* db
          .update(workers)
          .set({ stats: agentReport.stats, statsAt: new Date() })
          .where(eq(workers.id, workerId))
          .pipe(Effect.orDie);
        return;
      }
      yield* PubSub.publish(events, {
        _tag: "Report",
        workerId,
        report: agentReport,
      });
    });

  const send: AgentHubShape["send"] = (workerId, command) =>
    Effect.suspend(() => {
      const connection = byWorker.get(workerId);
      if (connection === undefined) return Effect.succeed(false);
      return Queue.offer(connection.commands, command);
    });

  return {
    send,
    connected: () => new Set(byWorker.keys()),
    info: (workerId) => byWorker.get(workerId)?.info,
    workerOf: (clientId) => byClient.get(clientId),
    events,
    subscribe: PubSub.subscribe(events),
    connect,
    report,
  } satisfies AgentHubShape;
});

export class AgentHub extends Context.Service<AgentHub, AgentHubShape>()(
  "@cg/orchestrator/AgentHub",
) {
  static readonly layer: Layer.Layer<AgentHub, never, Db> = Layer.effect(
    AgentHub,
    make,
  );
}
