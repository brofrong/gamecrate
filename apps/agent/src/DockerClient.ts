// Клиент Docker Engine API (v1.47) поверх unix-сокета: `fetch(url, { unix })` Bun.
// Только то, что нужно агенту: контейнеры сессий, exec, логи, список по метке.
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

/** Что создаёт `createAndStart` (переводится в тело `POST /containers/create`). */
export interface ContainerSpec {
  readonly name: string;
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  /** Docker-сеть (`NetworkMode` + единственный endpoint). */
  readonly network: string;
  /** UDP-порты, публикуемые наружу 1:1 (`-p P:P/udp`). */
  readonly udpPorts: ReadonlyArray<number>;
  /** `-v`: именованные тома и bind-монты, `источник:цель[:ro]`. */
  readonly binds: ReadonlyArray<string>;
  /** `--runtime`. */
  readonly runtime: string;
  /** `--gpus all`. */
  readonly gpus: boolean;
  readonly shmSizeBytes: number;
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

export interface DockerClientShape {
  /** Создать и запустить контейнер; id контейнера. Старт не удался — созданный удаляется. */
  readonly createAndStart: (
    spec: ContainerSpec,
  ) => Effect.Effect<string, DockerError>;
  /** `docker stop -t`; уже остановлен или нет такого — успех. */
  readonly stop: (
    name: string,
    timeoutSec: number,
  ) => Effect.Effect<void, DockerError>;
  /** `docker rm -f` (тома не трогает); нет такого — успех. */
  readonly remove: (name: string) => Effect.Effect<void, DockerError>;
  /** `docker exec` без TTY: код выхода и stdout (stderr отбрасывается). */
  readonly exec: (
    name: string,
    cmd: ReadonlyArray<string>,
  ) => Effect.Effect<ExecResult, DockerError>;
  /** `docker logs` целиком: stdout и stderr вперемешку, в порядке записи. */
  readonly logs: (name: string) => Effect.Effect<string, DockerError>;
  /** Все контейнеры (и остановленные) с меткой `label`. */
  /** Контейнер по имени; нет такого — `undefined`. */
  readonly inspect: (
    name: string,
  ) => Effect.Effect<ContainerInfo | undefined, DockerError>;
  readonly listByLabel: (
    label: string,
  ) => Effect.Effect<ReadonlyArray<ContainerInfo>, DockerError>;
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
      PortBindings: Object.fromEntries(
        ports.map(([key, port]) => [
          key,
          [{ HostIp: "", HostPort: String(port) }],
        ]),
      ),
      NetworkMode: spec.network,
      RestartPolicy: { Name: "no" },
    },
    NetworkingConfig: { EndpointsConfig: { [spec.network]: {} } },
  };
};

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

/** Клиент Docker API на unix-сокете `socketPath`. */
export const make = (socketPath: string): DockerClientShape => {
  /**
   * Запрос к dockerd. Статусы из `ok` — успех (тело), прочие — `DockerError`
   * с `message` из JSON-ответа dockerd.
   */
  const request = (
    operation: string,
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: {
      readonly body?: unknown;
      readonly ok?: ReadonlyArray<number>;
      readonly timeout?: Duration.Duration;
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
            ...(options.body === undefined
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

  return {
    createAndStart: (spec) =>
      Effect.gen(function* () {
        const { Id } = yield* request(
          "create",
          "POST",
          `/containers/create?name=${encodeURIComponent(spec.name)}`,
          { body: createBody(spec) },
        ).pipe(Effect.flatMap(json("create", IdResponse)));
        yield* request("start", "POST", `${containerPath(Id)}/start`, {
          ok: [204, 304],
        }).pipe(Effect.tapError(() => remove(Id).pipe(Effect.ignore)));
        return Id;
      }),

    stop: (name, timeoutSec) =>
      request("stop", "POST", `${containerPath(name)}/stop?t=${timeoutSec}`, {
        ok: [204, 304, 404],
        timeout: Duration.sum(Duration.seconds(timeoutSec), REQUEST_TIMEOUT),
      }).pipe(Effect.asVoid),

    remove,

    exec: (name, cmd) =>
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
