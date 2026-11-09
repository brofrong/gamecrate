// AgentHub: подключённые агенты воркеров. Держит по одному потоку команд на воркер,
// отправляет команды и публикует события (подключение, отчёты, отключение) в PubSub.
import { Db, sha256Hex, workerOfTokenHash, workers } from "@cg/db";
import {
  type AgentCommand,
  type AgentConnect,
  AgentNotConnected,
  type AgentReport,
  type AgentRoles,
  AgentUnauthorized,
  type RunningSession,
  type WorkerHardware,
  type WorkerVersions,
} from "@cg/rpc";
import { eq } from "drizzle-orm";
import {
  type Cause,
  Context,
  Effect,
  Layer,
  Option,
  PubSub,
  Queue,
  Redacted,
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
 * - `Disconnected` — соединение воркера оборвалось и более нового нет, либо
 *   хаб закрыл его сам (`disconnect`: токен сервера отозван). Замена
 *   соединения более новым `Disconnected` не публикует.
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
  /**
   * SHA-256 токена, с которым подключено текущее соединение воркера
   * (`undefined` — не подключён): по нему `WorkerAuth` раз в
   * `REVOKE_CHECK_MS` проверяет, действует ли ещё этот токен.
   */
  readonly tokenHash: (workerId: string) => string | undefined;
  /**
   * Закрыть текущее соединение воркера, как при вытеснении (поток команд
   * завершается, агент закрывает WebSocket и переподключается), но с
   * `Disconnected`: более нового соединения нет. Не подключён — ничего.
   */
  readonly disconnect: (workerId: string) => Effect.Effect<void>;
  /** PubSub событий хаба (неограниченный). */
  readonly events: PubSub.PubSub<AgentHubEvent>;
  /** Подписка на события с этого момента; живёт в scope. */
  readonly subscribe: Effect.Effect<
    PubSub.Subscription<AgentHubEvent>,
    never,
    Scope.Scope
  >;
  /**
   * Обработчик `agent.connect`: сверка токена с `workerId`, регистрация
   * соединения, обновление строки `workers`, поток команд. Токен не
   * действует или принадлежит другому серверу — поток падает с
   * `AgentUnauthorized`, ни соединения, ни записи в БД. `clientId` — id
   * WebSocket-клиента RPC-сервера.
   */
  readonly connect: (
    clientId: number,
    payload: AgentConnect,
  ) => Stream.Stream<AgentCommand, AgentUnauthorized>;
  /** Обработчик `agent.report` от WebSocket-клиента `clientId`. */
  readonly report: (
    clientId: number,
    report: AgentReport,
  ) => Effect.Effect<void, AgentNotConnected>;
}

interface Connection {
  /** Порядковый номер `agent.connect` по приходу: больше — новее. */
  readonly id: number;
  readonly clientId: number;
  readonly info: WorkerInfo;
  /** `sha256Hex` токена из `agent.connect` (для проверки отзыва). */
  readonly tokenHash: string;
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

  /**
   * Обновляет строку `workers` тем, что сообщил агент. Только обновление:
   * строку (вместе с учётными данными) заводит админка, а у неизвестного
   * `workerId` нет и токена — до сюда он не доходит. Строки нет (сервер
   * удалили, пока шёл connect) — `false`.
   */
  const updateWorker = (info: WorkerInfo) =>
    db
      .update(workers)
      .set({
        publicIp: info.publicIp,
        slots: info.slots,
        roles: [...info.roles],
        hardware: info.hardware ?? null,
        versions: info.versions ?? null,
        lastSeenAt: new Date(),
      })
      .where(eq(workers.id, info.workerId))
      .returning({ id: workers.id })
      .pipe(Effect.map((rows) => rows.length > 0));

  /** Соединение всё ещё текущее для своего воркера. */
  const isCurrent = (connection: Connection) =>
    byWorker.get(connection.info.workerId)?.id === connection.id;

  /**
   * Регистрирует соединение: побеждает самое новое по порядку прихода
   * `agent.connect` (`id`), прежнее соединение воркера завершается. Номер
   * берётся до проверки токена (поход в БД), поэтому более старое
   * соединение, чья проверка закончилась позже, не вытесняет более новое, а
   * само завершается сразу.
   */
  const register = (connection: Connection) =>
    Effect.gen(function* () {
      const { workerId } = connection.info;
      const previous = byWorker.get(workerId);
      if (previous !== undefined && previous.id > connection.id) {
        yield* Queue.end(connection.commands);
        return;
      }
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
   * Записи `workers` по одной: соединение пишет строку, только если оно ещё
   * текущее, поэтому вытесненное (более старое) соединение не перезапишет
   * `publicIp`/`slots` более нового.
   */
  const upsertLock = yield* Semaphore.make(1);

  /**
   * Обновление `workers`, затем `Connected` — строка воркера уже обновлена (на
   * неё ссылаются сессии). Вытесненное за это время соединение ничего не
   * пишет и не публикует. Строки нет — `Connected` тоже нет: без неё
   * планировщику на этом воркере делать нечего, а токен удалённого сервера
   * перестал действовать (учётные данные удалены каскадом) — фоновая
   * проверка `WorkerAuth` закроет и соединение.
   */
  const announce = (
    connection: Connection,
    running: ReadonlyArray<RunningSession>,
    installs: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      if (!isCurrent(connection)) return;
      const updated = yield* updateWorker(connection.info).pipe(Effect.orDie);
      if (!updated) {
        yield* Effect.logWarning(
          "Agent connected, but its worker row is gone",
          {
            workerId: connection.info.workerId,
          },
        );
        return;
      }
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
        const { running, installs, token, ...info } = payload;
        // Номер — в порядке прихода, до похода в БД (см. `register`).
        const id = nextId++;
        // Токен уже пустили на апгрейде, но апгрейд пускает любой действующий
        // токен, а `workerId` приходит только здесь (заголовки RPC-сообщений
        // контролирует клиент): токен должен принадлежать именно этому
        // серверу (спека §3). Сам токен в лог не попадает.
        const tokenHash = sha256Hex(Redacted.value(token));
        const owner = yield* workerOfTokenHash(tokenHash).pipe(
          Effect.provideService(Db, db),
        );
        if (Option.getOrUndefined(owner) !== info.workerId) {
          yield* Effect.logWarning(
            "Agent connect refused: token does not belong to this worker",
            { workerId: info.workerId },
          );
          return yield* new AgentUnauthorized();
        }
        // Scope этого эффекта — время жизни потока: release срабатывает при обрыве
        // соединения (сервер прерывает поток) или замене более новым соединением.
        const connection = yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const connection: Connection = {
              id,
              clientId,
              info,
              tokenHash,
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
      // PubSub: подписчики хаба (SessionRunner и т.п.) его не ждут. Сбой
      // записи (транзиентная ошибка БД) — не повод рвать agent.report и с ним
      // соединение агента: следующий снимок придёт через STATS_INTERVAL.
      if (agentReport._tag === "WorkerStats") {
        yield* db
          .update(workers)
          .set({ stats: agentReport.stats, statsAt: new Date() })
          .where(eq(workers.id, workerId))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Worker stats write failed", {
                workerId,
                cause,
              }),
            ),
          );
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

  const disconnect: AgentHubShape["disconnect"] = (workerId) =>
    Effect.suspend(() => {
      const connection = byWorker.get(workerId);
      if (connection === undefined) return Effect.void;
      // Сначала снять как текущее (с `Disconnected`), потом закрыть поток:
      // release самого потока затем видит, что соединение уже не текущее.
      return unregister(connection).pipe(
        Effect.andThen(Queue.end(connection.commands)),
        Effect.asVoid,
      );
    });

  return {
    send,
    connected: () => new Set(byWorker.keys()),
    info: (workerId) => byWorker.get(workerId)?.info,
    workerOf: (clientId) => byClient.get(clientId),
    tokenHash: (workerId) => byWorker.get(workerId)?.tokenHash,
    disconnect,
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
