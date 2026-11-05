// Экран сессии: стрим Selkies во весь экран (iframe /stream/<id>/) с плашками поверх,
// экран загрузки до появления игры (LoadingScreen, поверх ещё скрытого стрима),
// либо статус без стрима (SessionStatus).
import {
  defaultStreamSettings,
  type SessionState,
  type SessionView,
  type StreamSettings,
} from "@cg/rpc";
import { type RefObject, useEffect, useRef, useState } from "react";
import { createSelkiesBridge, type SelkiesBridge } from "@/lib/selkiesBridge";
import { useStreamStats } from "@/lib/useStreamStats";
import type { StreamSettingsControl } from "@/lib/useStreamSettings";
import { revealDue, showsLoading } from "@/lib/loadingSteps";
import { IdlePrompt } from "./IdlePrompt";
import { LoadingScreen } from "./LoadingScreen";
import { afterBreak, SessionControls } from "./session/SessionControls";
import { StatsOverlay } from "./session/StatsOverlay";
import { SessionStatus } from "./SessionStatus";
import { SteamQrLogin, type SteamQrLoginComponent } from "./SteamQrLogin";

/** Состояния, в которых показывается стрим (если он готов). */
const streamStates: ReadonlySet<SessionState> = new Set([
  "starting",
  "playing",
  "idle_warning",
  "disconnected",
]);

/** Состояния с идущим игровым временем: в них часы в меню тикают между обновлениями с сервера. */
const clockStates: ReadonlySet<SessionState> = new Set([
  "playing",
  "idle_warning",
]);

export const showsStream = (view: SessionView) =>
  view.streamReady && streamStates.has(view.state);

/** Как часто обновлять полоску, таймеры и подсказку экрана загрузки. */
const LOADING_TICK_MS = 1_000;

/** Пока `active` — перерисовка раз в `LOADING_TICK_MS` (полоска, таймеры и подсказка). */
function useLoadingTick(active: boolean) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick((n) => n + 1), LOADING_TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
}

/** Когда (`Date.now()`) клиент увидел текущее значение `key`. */
function useChangedAt(key: string): number {
  const since = useRef({ key, at: Date.now() });
  if (since.current.key !== key) since.current = { key, at: Date.now() };
  return since.current.at;
}

/** Сколько мс клиент видит `key` неизменным: отсчёт с его последней смены. */
function useMsSince(key: string): number {
  return Date.now() - useChangedAt(key);
}

/**
 * «Сейчас» сервера, мс: часы браузера с поправкой `serverNow − момент, когда
 * клиент получил это представление`. Таймеры экрана загрузки не врут из-за
 * расхождения часов и не обнуляются при перезагрузке страницы. Без `timing` —
 * часы браузера (таймеров тогда нет).
 */
function useServerNow(view: SessionView): number {
  const serverNow = view.timing?.serverNow ?? null;
  const receivedAt = useChangedAt(`${view.id}/${serverNow}`);
  return serverNow === null
    ? Date.now()
    : Date.now() + (Date.parse(serverNow) - receivedAt);
}

/** Через сколько перезагрузить iframe, если прокси ответил 5xx (Selkies ещё не поднялся). */
const STREAM_RETRY_MS = 3_000;

/** HTTP-статус документа iframe (тот же origin); `undefined` — неизвестно. */
const frameStatus = (frame: HTMLIFrameElement): number | undefined => {
  try {
    const [entry] =
      frame.contentWindow?.performance.getEntriesByType("navigation") ?? [];
    const status = (entry as { responseStatus?: number } | undefined)
      ?.responseStatus;
    return typeof status === "number" && status > 0 ? status : undefined;
  } catch {
    return undefined;
  }
};

function StreamFrame({
  sessionId,
  hidden,
  onLoad,
  ref,
}: {
  sessionId: string;
  /** Под экраном загрузки: без фокуса и ввода — Tab не уводит клавиши в скрытый стол. */
  hidden: boolean;
  onLoad: (frame: HTMLIFrameElement) => void;
  ref: RefObject<HTMLIFrameElement | null>;
}) {
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(retry.current), []);

  return (
    <iframe
      ref={ref}
      title="Игра"
      src={`/stream/${sessionId}/`}
      allow="autoplay; fullscreen; gamepad; clipboard-read; clipboard-write"
      inert={hidden}
      aria-hidden={hidden || undefined}
      className="absolute inset-0 size-full border-0"
      onLoad={(event) => {
        const frame = event.currentTarget;
        onLoad(frame);
        const status = frameStatus(frame);
        if (status !== undefined && status >= 500) {
          clearTimeout(retry.current);
          retry.current = setTimeout(() => {
            try {
              frame.contentWindow?.location.reload();
            } catch {
              frame.src = `/stream/${sessionId}/`;
            }
          }, STREAM_RETRY_MS);
        }
      }}
    />
  );
}

/** Настройки по умолчанию, пока маршрут не подал свои (тесты, превью): без сохранения. */
const defaultStreamSettingsControl: StreamSettingsControl = {
  settings: defaultStreamSettings,
  loaded: false,
  update: () => {},
};

/**
 * Мост к Selkies на `Player`: на каждую загрузку iframe — `attach`, на каждую смену настроек —
 * `update(prev, next)`, при размонтировании — `detach`. Возвращает обработчик загрузки iframe и
 * номер загрузки (растёт с каждым `load`: новый документ стрима — новые глобалы Selkies).
 */
function useSelkiesBridge(
  bridge: SelkiesBridge,
  settings: StreamSettings,
  onFrameLoad: ((frame: HTMLIFrameElement) => void) | undefined,
) {
  const [frameGeneration, setFrameGeneration] = useState(0);

  const prevSettings = useRef(settings);
  useEffect(() => {
    const prev = prevSettings.current;
    prevSettings.current = settings;
    if (prev !== settings) bridge.update(prev, settings);
  }, [bridge, settings]);

  useEffect(() => () => bridge.detach(), [bridge]);

  const onLoad = (frame: HTMLIFrameElement) => {
    bridge.attach(frame);
    setFrameGeneration((n) => n + 1);
    onFrameLoad?.(frame);
  };

  return { frameGeneration, onLoad };
}

export function Player({
  view,
  onExit,
  onHere,
  onLibrary,
  onFrameLoad,
  onPlayAgain,
  QrLogin = SteamQrLogin,
  streamSettings = defaultStreamSettingsControl,
  bridge: bridgeProp,
}: {
  view: SessionView;
  /** Пользователь подтвердил «Закончить игру» (или «Отменить» на экране загрузки). */
  onExit: () => void;
  /** «Я здесь» на предупреждении о простое. */
  onHere: () => void;
  onLibrary: () => void;
  /** Документ стрима загружен (на каждую загрузку iframe). */
  onFrameLoad?: (frame: HTMLIFrameElement) => void;
  /** Установщик не дождался входа в Steam: «Готово» на экране QR запускает игру заново. */
  onPlayAgain: () => void;
  QrLogin?: SteamQrLoginComponent;
  /** Настройки стрима из аккаунта (меню сессии); по умолчанию — умолчания без сохранения. */
  streamSettings?: StreamSettingsControl;
  /** Мост к Selkies; по умолчанию свой на каждый `Player` над текущими `streamSettings`. */
  bridge?: SelkiesBridge;
}) {
  const { settings } = streamSettings;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [ownBridge] = useState(() =>
    createSelkiesBridge(() => settingsRef.current),
  );
  const bridge = bridgeProp ?? ownBridge;
  const { frameGeneration, onLoad } = useSelkiesBridge(
    bridge,
    settings,
    onFrameLoad,
  );
  const rootRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // «Показать экран» — до конца сессии на этой странице (состояние клиента, §4.4).
  // Хранится id сессии: «Играть снова» уводит на новую сессию в том же `Player`.
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const stream = showsStream(view);
  // Открыть можно только готовую трансляцию — без неё снова экран загрузки.
  const loading = showsLoading(view, revealedId === view.id && stream);
  useLoadingTick(loading);
  // В текущем этапе — с последней смены `state`/`stage`/`installStage` (полоске,
  // пока у этапа нет серверной отметки; с ней — по `nowServerMs`).
  const msInStage = useMsSince(
    `${view.id}/${view.state}/${view.stage}/${view.installStage}`,
  );
  const nowServerMs = useServerNow(view);
  // «Показать экран» предлагается по `revealDue` и, раз предложена, остаётся до
  // конца экрана загрузки этой сессии — даже если новый этап ещё в норме.
  const offeredId = useRef<string | null>(null);
  if (stream && loading && revealDue(view, nowServerMs)) {
    offeredId.current = view.id;
  }
  const offered = stream && offeredId.current === view.id;
  // Игровое время приходит с сервера раз в несколько секунд — меню досчитывает от момента прихода.
  const playedAt = useChangedAt(`${view.id}/${view.playedSeconds}`);
  // Статистика — только над показанным стримом: под экраном загрузки и без стрима сбор выключен.
  const debug = stream && !loading ? settings.debug : "off";
  const stats = useStreamStats(bridge, frameGeneration, debug);

  if (!stream && !loading) {
    return (
      <SessionStatus
        view={view}
        onLibrary={onLibrary}
        onPlayAgain={onPlayAgain}
        QrLogin={QrLogin}
      />
    );
  }

  // Порядок детей постоянный: iframe первым — React не пересоздаёт его при смене
  // состояния и при снятии экрана загрузки, и стрим не переподключается.
  return (
    <main ref={rootRef} className="fixed inset-0 bg-black">
      {stream && (
        <StreamFrame
          ref={frameRef}
          sessionId={view.id}
          hidden={loading}
          onLoad={onLoad}
        />
      )}
      {loading && (
        <LoadingScreen
          view={view}
          msInStage={msInStage}
          nowServerMs={nowServerMs}
          onCancel={onExit}
          onReveal={offered ? () => setRevealedId(view.id) : undefined}
        />
      )}
      {!loading &&
        view.state === "idle_warning" &&
        view.idleDeadline !== null && (
          <IdlePrompt deadline={view.idleDeadline} onHere={onHere} />
        )}
      {!loading && debug !== "off" && (
        <StatsOverlay mode={debug} snapshot={stats} />
      )}
      {!loading && (
        <SessionControls
          control={streamSettings}
          gameName={view.gameName}
          played={{
            seconds: view.playedSeconds,
            at: playedAt,
            running: clockStates.has(view.state),
          }}
          onExit={onExit}
          rootRef={rootRef}
          frameRef={frameRef}
          returning={afterBreak(view.previousPlayedAt, Date.now())}
        />
      )}
    </main>
  );
}
