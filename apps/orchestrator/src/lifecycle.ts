/**
 * Автомат жизненного цикла сессии (спека §6). Чистый модуль: без Effect-сервисов
 * и I/O, текущее время и настройки передаются аргументами.
 *
 * Применение `Decision` вызывающей стороной (одной транзакцией):
 * Снимок: `openSegment` — открытый (`open = true`) отрезок сессии из
 * `play_segments` или `null`; его `endedAt` — сохранённый конец, который
 * вызывающая сторона продлевает до `now` на каждом heartbeat агента, пока
 * игра жива (т.е. это время последнего подтверждённого heartbeat'а игры).
 *
 * - `ops` применяются строго по порядку к отрезкам `play_segments` сессии:
 *   `Close` — закрыть текущий открытый отрезок (`endedAt = at`, `open = false`;
 *   `at` может быть раньше уже продлённого `endedAt` — перезаписать);
 *   `Open` — вставить новый открытый отрезок (`startedAt = endedAt = at`);
 *   `MarkOpenBillable` — пометить текущий открытый отрезок `billable = true`.
 * - если `state` отличается от `snapshot.state` — записать его и `stateSince = now`;
 * - `failReason !== null` — записать причину (`null` — не трогать);
 * - `limitGraceUntil` задан (`Date` или `null`) — записать `sessions.limit_grace_until`
 *   (`undefined` — не трогать);
 * - `command === "StopContainer"` — попросить агента погасить контейнер.
 */
import type { SessionLimit, SessionState } from "@cg/db";
import type { SessionSettings } from "@cg/rpc";

/** Нет heartbeat браузера дольше 15 с → клиент отключён. */
export const CLIENT_TIMEOUT_MS = 15_000;
/** Нет heartbeat агента дольше 90 с → сервер с игрой потерян. */
export const AGENT_TIMEOUT_MS = 90_000;
/**
 * Нет heartbeat браузера дольше 2 мин у `queued`-сессии → игрок вышел из
 * очереди (спека 2026-11-10 §5; heartbeat очереди идёт с любой страницы сайта).
 */
export const QUEUE_CLIENT_TIMEOUT_MS = 120_000;
/**
 * Минимальное окно предупреждения перед остановкой по лимиту тарифа: остаток
 * меньше этого впервые замечен — сессия доигрывает не меньше этого времени, даже
 * если остаток разом ушёл в ноль (истекла выдача тарифа, админ урезал лимит).
 */
export const LIMIT_GRACE_MS = 120_000;

export type Snapshot = {
  state: SessionState;
  stateSince: Date;
  clientSeenAt: Date | null;
  lastInputAt: Date | null;
  agentSeenAt: Date | null;
  openSegment: { startedAt: Date; endedAt: Date; billable: boolean } | null;
  /**
   * Остаток минут/длины сессии по тарифу (`SessionRepo.snapshotOf`,
   * `sessionLimit` из `@cg/db`, Task 8); считается только в `playing`/
   * `idle_warning` — вне них `null` (никогда не запрещает очередь и запуск).
   */
  limit: SessionLimit | null;
  /**
   * `sessions.limit_grace_until`: раньше этого момента сессию по лимиту не
   * останавливаем (`LIMIT_GRACE_MS`); `null` — окно не выставлено.
   */
  limitGraceUntil: Date | null;
};

export type LifecycleEvent =
  | { _tag: "Scheduled" }
  | { _tag: "StreamReady" }
  | { _tag: "GameStarted" }
  | { _tag: "GameExited" }
  | { _tag: "UserStop" }
  | { _tag: "StopFinished" }
  | { _tag: "Failed"; reason: string }
  | { _tag: "InstallStarted" }
  | { _tag: "InstallFinished" }
  /**
   * `reason` — техническая причина задачи (она в `install_jobs.error`);
   * `userReason` — причина, которую нужно показать пользователю как есть (иначе
   * общая `failReasons.installFailed`).
   */
  | { _tag: "InstallFailed"; reason: string; userReason?: string }
  /** Задачу отменили, пока сессия к ней присоединялась: ждать новую. */
  | { _tag: "InstallCancelled" }
  | { _tag: "Tick" };

export type SegmentOp =
  | { _tag: "Open"; at: Date; billable: boolean }
  | { _tag: "Close"; at: Date }
  | { _tag: "MarkOpenBillable" };

export type Decision = {
  state: SessionState;
  ops: ReadonlyArray<SegmentOp>;
  command: "StopContainer" | null;
  failReason: string | null;
  /** Новое окно предупреждения о лимите: `Date` — выставить, `null` — снять, нет поля — не трогать. */
  limitGraceUntil?: Date | null;
};

export const failReasons = {
  agentLost: "Сервер с игрой перестал отвечать",
  startTimeout: "Игра не запустилась за отведённое время",
  clientGone: "Игрок отключился",
  installFailed: "Не удалось установить игру",
  installTimeout: "Установка не закончилась за отведённое время",
  queueLeft: "Вы вышли из очереди",
  minutesOut: "Часы закончились",
  sessionTooLong: "Достигнут лимит длины сессии",
} as const;

const MINUTE_MS = 60_000;

/** Состояния, в которых у сессии может быть открытый отрезок. */
const segmentStates: ReadonlySet<SessionState> = new Set([
  "playing",
  "idle_warning",
  "disconnected",
]);

const isTerminal = (state: SessionState): boolean =>
  state === "ended" || state === "failed";

const ms = (from: Date, to: Date): number => to.getTime() - from.getTime();

const max = (a: Date, b: Date): Date => (a.getTime() >= b.getTime() ? a : b);
const min = (a: Date, b: Date): Date => (a.getTime() <= b.getTime() ? a : b);

/** Закрыть открытый отрезок в момент `at`, но не раньше его начала и не позже `now`. */
const closeAt = (s: Snapshot, at: Date, now: Date): SegmentOp[] =>
  s.openSegment
    ? [{ _tag: "Close", at: max(s.openSegment.startedAt, min(at, now)) }]
    : [];

/** Отрезок, которого быть не должно, закрываем нулевой длины — ничего не оплачивается. */
const closeStray = (s: Snapshot): SegmentOp[] =>
  s.openSegment ? [{ _tag: "Close", at: s.openSegment.startedAt }] : [];

const decision = (
  state: SessionState,
  ops: SegmentOp[] = [],
  command: Decision["command"] = null,
  failReason: string | null = null,
): Decision => ({ state, ops, command, failReason });

const clientVisible = (s: Snapshot, now: Date): boolean =>
  s.clientSeenAt !== null && ms(s.clientSeenAt, now) <= CLIENT_TIMEOUT_MS;

/**
 * Окно предупреждения о лимите в `playing`/`idle_warning` (клиент на месте):
 * остаток впервые меньше `LIMIT_GRACE_MS` — окно `now + max(остаток, LIMIT_GRACE_MS)`;
 * остаток снова не меньше (пополнение) или лимита больше нет — окно снимается,
 * чтобы следующее падение получило свежее. `undefined` — не трогать.
 */
const limitGraceUpdate = (s: Snapshot, now: Date): Date | null | undefined => {
  const grace = s.limitGraceUntil;
  if (s.limit === null) return grace === null ? undefined : null;
  const remaining = Math.max(0, s.limit.remainingMs);
  if (remaining >= LIMIT_GRACE_MS) return grace === null ? undefined : null;
  if (grace !== null) return undefined;
  return new Date(now.getTime() + Math.max(remaining, LIMIT_GRACE_MS));
};

const onTick = (
  s: Snapshot,
  now: Date,
  settings: SessionSettings,
): Decision => {
  const K = settings.disconnectGraceMinutes * MINUTE_MS;
  const M = settings.idleGraceMinutes * MINUTE_MS;
  const N = settings.idleWarningMinutes * MINUTE_MS;
  const inState = ms(s.stateSince, now);
  const keep = decision(s.state);

  // 1. Агент молчит — в любом активном состоянии, кроме queued и installing
  // (агента сессии ещё нет).
  if (s.state !== "queued" && s.state !== "installing") {
    const agentRef = s.agentSeenAt ?? s.stateSince;
    if (ms(agentRef, now) > AGENT_TIMEOUT_MS) {
      return decision(
        "failed",
        closeAt(s, agentRef, now),
        null,
        failReasons.agentLost,
      );
    }
  }

  switch (s.state) {
    // Установка не оплачивается и браузера не ждёт: ушедший игрок не отменяет
    // загрузку, сессия после неё вернётся в queued и там закончится по
    // QUEUE_CLIENT_TIMEOUT_MS.
    case "installing":
      return inState > settings.installTimeoutMinutes * MINUTE_MS
        ? decision("failed", [], null, failReasons.installTimeout)
        : keep;

    case "queued":
    case "starting": {
      if (
        s.state === "starting" &&
        inState > settings.startTimeoutMinutes * MINUTE_MS
      ) {
        return decision(
          "stopping",
          [],
          "StopContainer",
          failReasons.startTimeout,
        );
      }
      // Очередь ждёт браузер QUEUE_CLIENT_TIMEOUT_MS, запуск — K.
      const clientRef = s.clientSeenAt ?? s.stateSince;
      if (s.state === "queued") {
        // Heartbeat очереди обновляет clientSeenAt только в queued: во время
        // установки он стоит, и после возврата в queued отсчёт идёт заново
        // от stateSince, а не от давнего heartbeat'а.
        const queueRef = max(clientRef, s.stateSince);
        return ms(queueRef, now) > QUEUE_CLIENT_TIMEOUT_MS
          ? decision("ended", [], null, failReasons.queueLeft)
          : keep;
      }
      return ms(clientRef, now) > K
        ? decision("stopping", [], "StopContainer", failReasons.clientGone)
        : keep;
    }

    case "playing":
    case "idle_warning": {
      if (!clientVisible(s, now)) {
        const cut = s.clientSeenAt ?? s.stateSince;
        const close = closeAt(s, cut, now);
        const openAt = close[0]?._tag === "Close" ? close[0].at : min(cut, now);
        return decision("disconnected", [
          ...close,
          { _tag: "Open", at: openAt, billable: false },
        ]);
      }
      // Клиент на месте: кончились минуты или длина сессии (тариф, спека §2–§3) —
      // останавливаем, только когда истекло и окно предупреждения (`LIMIT_GRACE_MS`).
      const grace = s.limitGraceUntil;
      if (
        s.limit !== null &&
        s.limit.remainingMs <= 0 &&
        grace !== null &&
        now.getTime() >= grace.getTime()
      ) {
        return decision(
          "stopping",
          closeAt(s, now, now),
          "StopContainer",
          s.limit.reason === "minutes"
            ? failReasons.minutesOut
            : failReasons.sessionTooLong,
        );
      }
      const graceUpdate = limitGraceUpdate(s, now);
      const withGrace = (d: Decision): Decision =>
        graceUpdate === undefined ? d : { ...d, limitGraceUntil: graceUpdate };
      if (s.state === "playing") {
        // Простой меряется внутри игрового времени: ввод до старта игры не в счёт.
        const lastInput = max(s.lastInputAt ?? s.stateSince, s.stateSince);
        return withGrace(
          ms(lastInput, now) > N ? decision("idle_warning") : keep,
        );
      }
      // idle_warning: ответ засчитывается, только если ввод пришёл в окне M.
      const answered =
        s.lastInputAt !== null &&
        s.lastInputAt.getTime() > s.stateSince.getTime() &&
        ms(s.stateSince, s.lastInputAt) <= M;
      if (answered) return withGrace(decision("playing"));
      if (inState > M) {
        return decision("stopping", closeAt(s, now, now), "StopContainer");
      }
      return withGrace(keep);
    }

    case "disconnected": {
      // Возврат засчитывается, только если клиента снова увидели в окне K.
      const returned =
        clientVisible(s, now) &&
        s.clientSeenAt !== null &&
        ms(s.stateSince, s.clientSeenAt) <= K;
      if (returned) {
        return decision("playing", [
          ...(s.openSegment ? [{ _tag: "MarkOpenBillable" } as const] : []),
          ...closeAt(s, now, now),
          { _tag: "Open", at: now, billable: true },
        ]);
      }
      if (inState > K) {
        return decision(
          "stopping",
          closeAt(s, s.stateSince, now),
          "StopContainer",
        );
      }
      return keep;
    }

    default:
      return keep;
  }
};

const onEvent = (
  s: Snapshot,
  e: LifecycleEvent,
  now: Date,
  settings: SessionSettings,
): Decision => {
  const keep = decision(s.state);
  if (isTerminal(s.state)) return keep;

  switch (e._tag) {
    case "Tick":
      return onTick(s, now, settings);

    case "Scheduled":
      return s.state === "queued" ? decision("starting") : keep;

    case "StreamReady":
      // Стрим показан, но игра ещё не идёт — состояние и время не меняются.
      return keep;

    case "GameStarted":
      return s.state === "starting"
        ? decision("playing", [
            ...closeStray(s),
            { _tag: "Open", at: now, billable: true },
          ])
        : keep;

    case "InstallStarted":
      return s.state === "queued" ? decision("installing") : keep;

    case "InstallFinished":
    case "InstallCancelled":
      return s.state === "installing" ? decision("queued") : keep;

    case "InstallFailed":
      return s.state === "installing"
        ? decision(
            "failed",
            [],
            null,
            e.userReason ?? failReasons.installFailed,
          )
        : keep;

    case "GameExited":
      return s.state === "queued" ||
        s.state === "installing" ||
        s.state === "stopping"
        ? keep
        : decision("stopping", closeAt(s, now, now));

    // Из `disconnected` отрезок закрывается неоплачиваемым — разрыв не учитывается намеренно.
    case "UserStop":
      if (s.state === "queued" || s.state === "installing")
        return decision("ended");
      if (s.state === "stopping") return keep;
      return decision("stopping", closeAt(s, now, now), "StopContainer");

    case "StopFinished":
      // GameExited мог потеряться: закрываем по последнему heartbeat'у игры,
      // ожидание выгрузки сохранений не оплачивается.
      return decision(
        "ended",
        s.openSegment ? closeAt(s, s.openSegment.endedAt, now) : [],
      );

    case "Failed":
      // Падение воркера: не учитываем время после последнего heartbeat'а агента.
      return decision(
        "failed",
        closeAt(s, s.agentSeenAt ?? now, now),
        null,
        e.reason,
      );
  }
};

/**
 * Следующий шаг автомата. Инвариант: вне `playing`/`idle_warning`/`disconnected`
 * открытого отрезка после применения `ops` не остаётся.
 */
export const decide = (
  s: Snapshot,
  e: LifecycleEvent,
  now: Date,
  settings: SessionSettings,
): Decision => {
  const d = onEvent(s, e, now, settings);
  if (segmentStates.has(d.state)) return d;

  let open = s.openSegment?.startedAt ?? null;
  for (const op of d.ops) {
    if (op._tag === "Close") open = null;
    else if (op._tag === "Open") open = op.at;
  }
  // Несогласованный снимок (например, открытый отрезок в ended/failed):
  // закрываем отрезок нулевой длины — ожидание никогда не оплачивается.
  return open ? { ...d, ops: [...d.ops, { _tag: "Close", at: open }] } : d;
};
