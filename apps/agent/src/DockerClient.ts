// Клиент Docker Engine API (v1.47) поверх unix-сокета: `fetch(url, { unix })` Bun.
// Только то, что нужно агенту: контейнеры сессий и помощников, exec, логи,
// список по метке, overlay-тома, архивы файлов контейнера (профиль).
import { Context, Duration, Effect, Layer, Schema } from "effect";
import { AgentConfig } from "./config";

/** Версия API в пути запросов. Docker 25+ (минимум API 1.44) её поддерживает. */
export const DOCKER_API_VERSION = "v1.47";

/** Таймаут одного запроса к dockerd (у `stop` — плюс время остановки). */
const REQUEST_TIMEOUT = Duration.seconds(60);

/**
 * Ошибка Docker API. `status` — HTTP-статус ответа dockerd (нет — сокет
 * недоступен или таймаут); `message` — текст ошибки dockerd.
 */
export class DockerError extends Schema.TaggedError<DockerError>()(
  "DockerError",
  {
    operation: Schema.String,
    status: Schema.optional(Schema.Number),
    message: Schema.String,
  },
) {}

/** Контейнера больше нет (или он остановлен): exec отвечает 404/409. */
export const isGone = (error: DockerError) =>
  error.status === 404 || error.status === 409;

/** Именованный том в контейнере (`HostConfig.Mounts`, `Type: volume`). */
export interface VolumeMount {
  readonly volume: string;
  readonly target: string;
  readonly readOnly?: boolean;
}

/** Что создаёт `create` (переводится в тело `POST /containers/create`). */
export interface ContainerSpec {
  readonly name: string;
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  /** Docker-сеть (`NetworkMode` + единственный endpoint). */
  readonly network: string;
  /** UDP-порты, публикуемые наружу 1:1 (`-p P:P/udp`). */
  readonly udpPorts: ReadonlyArray<number>;
  /** `-v`: bind-монты, `источник:цель[:ro]`. */
  readonly binds: ReadonlyArray<string>;
  /** `--mount type=volume`: именованные тома (в т.ч. вложенные один в другой). */
  readonly mounts: ReadonlyArray<VolumeMount>;
  /** `--runtime`. */
  readonly runtime: string;
  /** `--gpus all`. */
  readonly gpus: boolean;
  readonly shmSizeBytes: number;
  /** `--security-opt`, напр. `no-new-privileges:true`. */
  readonly securityOpt: ReadonlyArray<string>;
  /** `--tmpfs`: точка монтирования → опции (`mode=1777,size=64k`). */
  readonly tmpfs: Readonly<Record<string, string>>;
  /** `--entrypoint` (нет — entrypoint образа). */
  readonly entrypoint?: ReadonlyArray<string>;
  /** Аргументы entrypoint (нет — `CMD` образа). */
  readonly cmd?: ReadonlyArray<string>;
  /** `--user` (нет — `USER` образа). */
  readonly user?: string;
}

/**
 * Том `local` с драйвером overlay: `upper`/`work` должны существовать заранее и
 * лежать на одной ФС; монтирует его сам dockerd (sudo не нужен).
 */
export interface OverlayVolumeSpec {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly overlay: {
    readonly lower: string;
    readonly upper: string;
    readonly work: string;
  };
}

export interface VolumeInfo {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface ContainerInfo {
  /** Имя без ведущего `/`. */
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly running: boolean;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/** Для долгих шагов (упаковка и выгрузка профиля): свой таймаут запроса. */
export interface RequestOptions {
  readonly timeout?: Duration.Input;
}

export interface DockerClientShape {
  /** Создать контейнер, не запуская; id контейнера. */
  readonly create: (spec: ContainerSpec) => Effect.Effect<string, DockerError>;
  /** Запустить созданный контейнер; уже запущен — успех. */
  readonly start: (name: string) => Effect.Effect<void, DockerError>;
  /** Создать и запустить контейнер; id контейнера. Старт не удался — созданный удаляется. */
  readonly createAndStart: (
    spec: ContainerSpec,
  ) => Effect.Effect<string, DockerError>;
  /** Дождаться выхода контейнера (до 10 мин); код выхода. */
  readonly wait: (name: string) => Effect.Effect<number, DockerError>;
  /** `docker stop -t`; уже остановлен или нет такого — успех. */
  readonly stop: (
    name: string,
    timeoutSec: number,
  ) => Effect.Effect<void, DockerError>;
  /** `docker rm -f` (тома не трогает); нет такого — успех. */
  readonly remove: (name: string) => Effect.Effect<void, DockerError>;
  /**
   * `docker exec` без TTY: код выхода и stdout (stderr отбрасывается).
   * `timeout` — сколько ждать завершения команды (по умолчанию 60 с).
   */
  readonly exec: (
    name: string,
    cmd: ReadonlyArray<string>,
    options?: RequestOptions,
  ) => Effect.Effect<ExecResult, DockerError>;
  /** `docker logs` целиком: stdout и stderr вперемешку, в порядке записи. */
  readonly logs: (name: string) => Effect.Effect<string, DockerError>;
  /** Контейнер по имени; нет такого — `undefined`. */
  readonly inspect: (
    name: string,
  ) => Effect.Effect<ContainerInfo | undefined, DockerError>;
  /** Все контейнеры (и остановленные) с меткой `label`. */
  readonly listByLabel: (
    label: string,
  ) => Effect.Effect<ReadonlyArray<ContainerInfo>, DockerError>;
  /** `POST /volumes/create`: overlay-том `local`. */
  readonly createVolume: (
    spec: OverlayVolumeSpec,
  ) => Effect.Effect<void, DockerError>;
  /** `docker volume rm`; нет такого — успех, используется контейнером — ошибка (409). */
  readonly removeVolume: (name: string) => Effect.Effect<void, DockerError>;
  readonly volumeExists: (name: string) => Effect.Effect<boolean, DockerError>;
  /** Тома с меткой `label`. */
  readonly listVolumes: (
    label: string,
  ) => Effect.Effect<ReadonlyArray<VolumeInfo>, DockerError>;
  /**
   * `PUT /containers/{id}/archive`: распаковать tar в каталог `path` контейнера
   * (можно в созданный, ещё не запущенный). Владелец файлов — из заголовков tar;
   * недостающих родителей записей Docker создаёт от root.
   */
  readonly putArchive: (
    name: string,
    path: string,
    tar: Uint8Array,
  ) => Effect.Effect<void, DockerError>;
  /** `GET /containers/{id}/archive`: tar с `path` (и в остановленном контейнере). */
  readonly getArchive: (
    name: string,
    path: string,
    options?: RequestOptions,
  ) => Effect.Effect<Uint8Array, DockerError>;
}

/** Тело `POST /containers/create` для спецификации. */
export const createBody = (spec: ContainerSpec) => {
  const ports = spec.udpPorts.map((port) => [`${port}/udp`, port] as const);
  return {
    Image: spec.image,
    Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
    Labels: spec.labels,
    ExposedPorts: Object.fromEntries(ports.map(([key]) => [key, {}])),
    HostConfig: {
      Runtime: spec.runtime,
      DeviceRequests: spec.gpus
        ? [{ Driver: "", Count: -1, Capabilities: [["gpu"]] }]
        : [],
      ShmSize: spec.shmSizeBytes,
      Binds: spec.binds,
      Mounts: spec.mounts.map((mount) => ({
        Type: "volume",
        Source: mount.volume,
        Target: mount.target,
        ReadOnly: mount.readOnly ?? false,
        // Наши тома никогда не наполняются содержимым образа: старый
        // cg-home-* только читается, overlay-тома — это клиент Steam и библиотека.
        VolumeOptions: { NoCopy: true },
      })),
      PortBindings: Object.fromEntries(
        ports.map(([key, port]) => [
          key,
          [{ HostIp: "", HostPort: String(port) }],
        ]),
      ),
      NetworkMode: spec.network,
      RestartPolicy: { Name: "no" },
      SecurityOpt: spec.securityOpt,
      Tmpfs: spec.tmpfs,
    },
    NetworkingConfig: { EndpointsConfig: { [spec.network]: {} } },
    ...(spec.entrypoint === undefined ? {} : { Entrypoint: spec.entrypoint }),
    ...(spec.cmd === undefined ? {} : { Cmd: spec.cmd }),
    ...(spec.user === undefined ? {} : { User: spec.user }),
  };
};

/** Тело `POST /volumes/create` для overlay-тома. */
export const volumeBody = (spec: OverlayVolumeSpec) => ({
  Name: spec.name,
  Driver: "local",
  DriverOpts: {
    type: "overlay",
    device: "overlay",
    o: `lowerdir=${spec.overlay.lower},upperdir=${spec.overlay.upper},workdir=${spec.overlay.work}`,
  },
  Labels: spec.labels,
});

/**
 * Разбор мультиплексированного потока Docker (exec/logs без TTY): кадры
 * `[поток, 0, 0, 0, длина u32 BE] + данные`, поток 1 — stdout, 2 — stderr.
 * Не похоже на кадры (TTY) — весь поток считается stdout.
 */
export const demux = (bytes: Uint8Array) => {
  const decoder = new TextDecoder();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stdout: Array<Uint8Array> = [];
  const all: Array<Uint8Array> = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const stream = bytes[offset];
    if (stream !== 0 && stream !== 1 && stream !== 2) {
      const raw = decoder.decode(bytes);
      return { stdout: raw, combined: raw };
    }
    const size = view.getUint32(offset + 4);
    const chunk = bytes.subarray(offset + 8, offset + 8 + size);
    if (stream === 1) stdout.push(chunk);
    all.push(chunk);
    offset += 8 + size;
  }
  const text = (chunks: Array<Uint8Array>) =>
    chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") +
    decoder.decode();
  return { stdout: text(stdout), combined: text(all) };
};

const ContainerList = Schema.Array(
  Schema.Struct({
    Names: Schema.Array(Schema.String),
    Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
    State: Schema.String,
  }),
);
const IdResponse = Schema.Struct({ Id: Schema.String });
const ContainerInspect = Schema.Struct({
  Name: Schema.String,
  Config: Schema.Struct({
    Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  }),
  State: Schema.Struct({ Running: Schema.Boolean }),
});
const ExecInspect = Schema.Struct({ ExitCode: Schema.NullOr(Schema.Number) });
const WaitResponse = Schema.Struct({ StatusCode: Schema.Number });
const VolumeList = Schema.Struct({
  Volumes: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        Name: Schema.String,
        Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
      }),
    ),
  ),
});

/** Сколько ждать выхода контейнера-помощника (`wait`). */
const WAIT_TIMEOUT = Duration.minutes(10);

/** Клиент Docker API на unix-сокете `socketPath`. */
export const make = (socketPath: string): DockerClientShape => {
  /**
   * Запрос к dockerd. Статусы из `ok` — успех (тело), прочие — `DockerError`
   * с `message` из JSON-ответа dockerd.
   */
  const request = (
    operation: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: {
      readonly body?: unknown;
      /** Тело-tar (`application/x-tar`) вместо JSON. */
      readonly tar?: Uint8Array;
      readonly ok?: ReadonlyArray<number>;
      readonly timeout?: Duration.Input | undefined;
    } = {},
  ) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(
          `http://docker/${DOCKER_API_VERSION}${path}`,
          {
            unix: socketPath,
            // Ответ dockerd с редиректом — не наш dockerd: никуда не идти.
            redirect: "error",
            method,
            signal,
            ...(options.tar !== undefined
              ? {
                  headers: { "content-type": "application/x-tar" },
                  // Копия на ArrayBuffer: BodyInit не принимает SharedArrayBuffer.
                  body: new Uint8Array(options.tar),
                }
              : options.body === undefined
                ? {}
                : {
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(options.body),
                  }),
          },
        );
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { status: response.status, bytes };
      },
      catch: (cause) =>
        new DockerError({
          operation,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: options.timeout ?? REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(new DockerError({ operation, message: "timeout" })),
      }),
      Effect.flatMap(({ status, bytes }) => {
        const ok = options.ok ?? [200, 201, 204];
        if (ok.includes(status)) return Effect.succeed({ status, bytes });
        const text = new TextDecoder().decode(bytes);
        let message = text.trim();
        try {
          const parsed: unknown = JSON.parse(text);
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "message" in parsed &&
            typeof parsed.message === "string"
          )
            message = parsed.message;
        } catch {
          // Не JSON — в message остаётся текст ответа как есть.
        }
        return Effect.fail(
          new DockerError({
            operation,
            status,
            message: message || `HTTP ${status}`,
          }),
        );
      }),
    );

  const json =
    <S extends Schema.Top & { readonly DecodingServices: never }>(
      operation: string,
      schema: S,
    ) =>
    ({ bytes }: { readonly bytes: Uint8Array }) =>
      Effect.try({
        try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
        catch: () =>
          new DockerError({ operation, message: "invalid JSON from dockerd" }),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        Effect.mapError((error) =>
          error instanceof DockerError
            ? error
            : new DockerError({ operation, message: String(error) }),
        ),
      );

  const containerPath = (name: string) =>
    `/containers/${encodeURIComponent(name)}`;

  const remove: DockerClientShape["remove"] = (name) =>
    request("remove", "DELETE", `${containerPath(name)}?force=true`, {
      ok: [200, 204, 404],
    }).pipe(Effect.asVoid);

  const create: DockerClientShape["create"] = (spec) =>
    request(
      "create",
      "POST",
      `/containers/create?name=${encodeURIComponent(spec.name)}`,
      { body: createBody(spec) },
    ).pipe(
      Effect.flatMap(json("create", IdResponse)),
      Effect.map(({ Id }) => Id),
    );

  const start: DockerClientShape["start"] = (name) =>
    request("start", "POST", `${containerPath(name)}/start`, {
      ok: [204, 304],
    }).pipe(Effect.asVoid);

  const volumePath = (name: string) => `/volumes/${encodeURIComponent(name)}`;
  const archivePath = (name: string, path: string) =>
    `${containerPath(name)}/archive?path=${encodeURIComponent(path)}`;

  return {
    create,
    start,

    createAndStart: (spec) =>
      Effect.gen(function* () {
        const id = yield* create(spec);
        yield* start(id).pipe(
          Effect.tapError(() => remove(id).pipe(Effect.ignore)),
        );
        return id;
      }),

    wait: (name) =>
      request("wait", "POST", `${containerPath(name)}/wait`, {
        ok: [200],
        timeout: WAIT_TIMEOUT,
      }).pipe(
        Effect.flatMap(json("wait", WaitResponse)),
        Effect.map(({ StatusCode }) => StatusCode),
      ),

    stop: (name, timeoutSec) =>
      request("stop", "POST", `${containerPath(name)}/stop?t=${timeoutSec}`, {
        ok: [204, 304, 404],
        timeout: Duration.sum(Duration.seconds(timeoutSec), REQUEST_TIMEOUT),
      }).pipe(Effect.asVoid),

    remove,

    exec: (name, cmd, options = {}) =>
      Effect.gen(function* () {
        const { Id } = yield* request(
          "exec",
          "POST",
          `${containerPath(name)}/exec`,
          { body: { AttachStdout: true, AttachStderr: true, Cmd: cmd } },
        ).pipe(Effect.flatMap(json("exec", IdResponse)));
        const execPath = `/exec/${encodeURIComponent(Id)}`;
        const { bytes } = yield* request("exec", "POST", `${execPath}/start`, {
          body: { Detach: false, Tty: false },
          ok: [200],
          timeout: options.timeout,
        });
        const { ExitCode } = yield* request(
          "exec",
          "GET",
          `${execPath}/json`,
        ).pipe(Effect.flatMap(json("exec", ExecInspect)));
        return { exitCode: ExitCode ?? -1, stdout: demux(bytes).stdout };
      }),

    logs: (name) =>
      request(
        "logs",
        "GET",
        `${containerPath(name)}/logs?stdout=true&stderr=true`,
        { ok: [200] },
      ).pipe(Effect.map(({ bytes }) => demux(bytes).combined)),

    inspect: (name) =>
      request("inspect", "GET", `${containerPath(name)}/json`, {
        ok: [200, 404],
      }).pipe(
        Effect.flatMap((response) =>
          response.status === 404
            ? Effect.succeed(undefined)
            : json(
                "inspect",
                ContainerInspect,
              )(response).pipe(
                Effect.map((container) => ({
                  name: container.Name.replace(/^\//, ""),
                  labels: container.Config.Labels ?? {},
                  running: container.State.Running,
                })),
              ),
        ),
      ),

    listByLabel: (label) =>
      request(
        "list",
        "GET",
        `/containers/json?all=true&filters=${encodeURIComponent(
          JSON.stringify({ label: [label] }),
        )}`,
        { ok: [200] },
      ).pipe(
        Effect.flatMap(json("list", ContainerList)),
        Effect.map((containers) =>
          containers.map((container) => ({
            name: (container.Names[0] ?? "").replace(/^\//, ""),
            labels: container.Labels ?? {},
            running: container.State === "running",
          })),
        ),
      ),

    createVolume: (spec) =>
      request("createVolume", "POST", "/volumes/create", {
        body: volumeBody(spec),
      }).pipe(Effect.asVoid),

    removeVolume: (name) =>
      request("removeVolume", "DELETE", volumePath(name), {
        ok: [204, 404],
      }).pipe(Effect.asVoid),

    volumeExists: (name) =>
      request("volumeExists", "GET", volumePath(name), {
        ok: [200, 404],
      }).pipe(Effect.map(({ status }) => status === 200)),

    listVolumes: (label) =>
      request(
        "listVolumes",
        "GET",
        `/volumes?filters=${encodeURIComponent(JSON.stringify({ label: [label] }))}`,
        { ok: [200] },
      ).pipe(
        Effect.flatMap(json("listVolumes", VolumeList)),
        Effect.map(({ Volumes }) =>
          (Volumes ?? []).map((volume) => ({
            name: volume.Name,
            labels: volume.Labels ?? {},
          })),
        ),
      ),

    putArchive: (name, path, tar) =>
      request("putArchive", "PUT", archivePath(name, path), {
        tar,
        ok: [200],
      }).pipe(Effect.asVoid),

    getArchive: (name, path, options = {}) =>
      request("getArchive", "GET", archivePath(name, path), {
        ok: [200],
        timeout: options.timeout,
      }).pipe(Effect.map(({ bytes }) => bytes)),
  };
};

export class DockerClient extends Context.Service<
  DockerClient,
  DockerClientShape
>()("@cg/agent/DockerClient") {
  static readonly make = make;
  /** Клиент на сокете `DOCKER_SOCKET` из конфига. */
  static readonly layer: Layer.Layer<DockerClient, never, AgentConfig> =
    Layer.effect(
      DockerClient,
      AgentConfig.useSync((config) => make(config.dockerSocket)),
    );
}
