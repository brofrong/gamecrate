import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Скрипт установки игрового сервера (deploy/worker/install.sh). Его отдаёт оркестратор
 * (`GET /agent/install.sh`), подставляя адрес главного, версию релиза и драйверы релиза, —
 * тест делает ту же подстановку сам.
 */
const script = readFileSync(
  join(import.meta.dir, "../worker/install.sh"),
  "utf8",
);

const CODE = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const TOKEN = `cgw_${"A".repeat(43)}`;
const PASSWORD = "pull-secret-123";
const DRIVER = "550.163.01";
const SESSION_IMAGE = `registry.imtechnologies.ru/gamecrate/imt-cloud-gaming/cg-session:${DRIVER}-v1.2.3`;

/** Песочница одного запуска: заглушки команд, корень ФС, sysfs, журнал вызовов. */
interface Sandbox {
  readonly dir: string;
  readonly bin: string;
  readonly root: string;
  readonly sys: string;
  readonly log: string;
  /** Сколько раз фейковый главный получил POST /agent/enroll. */
  enrolls: number;
  url: string;
}

let sandbox: Sandbox;
let server: ReturnType<typeof Bun.serve>;

/** Заглушка команды `name`: bash-скрипт `body` (или bun-скрипт, если `bun` = true). */
const stub = (name: string, body: string, bun = false) => {
  const path = join(sandbox.bin, name);
  writeFileSync(path, `#!/usr/bin/env ${bun ? "bun" : "bash"}\n${body}\n`);
  chmodSync(path, 0o755);
};

/** Модуль nvidia_drm с `modeset` = `value`. */
const setModeset = (value: string) => {
  const dir = join(sandbox.sys, "module/nvidia_drm/parameters");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "modeset"), `${value}\n`);
};

/** nvidia-smi с двумя GPU драйвера `version`. */
const setDriver = (version: string) =>
  stub(
    "nvidia-smi",
    `case "$*" in
*--query-gpu=driver_version*) printf '%s\\n%s\\n' ${version} ${version} ;;
*) exit 0 ;;
esac`,
  );

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "cg-install-"));
  sandbox = {
    dir,
    bin: join(dir, "bin"),
    root: join(dir, "root"),
    sys: join(dir, "sys"),
    log: join(dir, "log"),
    enrolls: 0,
    url: "",
  };
  mkdirSync(sandbox.bin);
  mkdirSync(join(sandbox.root, "usr/lib/x86_64-linux-gnu/nvidia/current"), {
    recursive: true,
  });
  writeFileSync(
    join(
      sandbox.root,
      `usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.${DRIVER}`,
    ),
    "",
  );
  writeFileSync(sandbox.log, "");
  const log = sandbox.log;

  // Фейковый главный: обмен кода и файлы, которые скачивает установка (помощники — заглушки,
  // которые только пишут свой вызов в журнал).
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/agent/enroll") {
        sandbox.enrolls++;
        const body = (await request.json()) as { code?: string };
        if (body.code !== CODE)
          return Response.json(
            { error: "Код недействителен или истёк" },
            { status: 403 },
          );
        return Response.json({
          workerId: "spb-1",
          token: TOKEN,
          regionCode: "spb",
          orchestratorUrl: "wss://game.example.ru/agent",
          version: "v1.2.3",
          registry: {
            server: "registry.example.ru",
            username: "cg-pull",
            password: PASSWORD,
          },
        });
      }
      if (path === "/agent/compose.worker.yaml")
        return new Response("services: {}\n");
      if (path === "/agent/session-isolation.sh")
        return new Response(
          `#!/usr/bin/env bash\necho "isolation $*" >> "${log}"\n`,
        );
      if (path === "/agent/build-steam-client.sh")
        return new Response(
          `#!/usr/bin/env bash\necho "steam-client $*" >> "${log}"\n`,
        );
      return new Response("not found", { status: 404 });
    },
  });
  sandbox.url = `http://127.0.0.1:${server.port}`;

  // docker: журнал вызовов; NVIDIA runtime есть; пароль `login` — в отдельный файл (stdin).
  stub(
    "docker",
    `echo "docker $*" >> "${log}"
case "$1" in
info) echo '{"nvidia":{"path":"nvidia-container-runtime"},"runc":{"path":"runc"}}' ;;
compose) case "$*" in *version*) echo "Docker Compose version v2.30.0" ;; esac ;;
login) cat > "${sandbox.dir}/login-stdin" ;;
network) [ "$2" = inspect ] && exit 1 ;;
esac
exit 0`,
  );
  stub("stat", "echo 995");
  stub("chown", `echo "chown $*" >> "${log}"`);
  stub("id", `[ "$1" = -u ] && echo 0`);
  // curl: то подмножество, которым пользуется установка (-X, -H, -o, -w, --data-binary @-,
  // -f), через fetch к фейковому главному; в CI-образе (oven/bun) настоящего curl нет.
  stub(
    "curl",
    `const args = process.argv.slice(2);
let method = "GET", out, write, data, url, fail = false;
const headers = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-X") method = args[++i];
  else if (a === "-H") { const [k, ...v] = args[++i].split(":"); headers[k.trim()] = v.join(":").trim(); }
  else if (a === "-o") out = args[++i];
  else if (a === "--max-time") i++;
  else if (a === "-w") write = args[++i];
  else if (a === "--data-binary") { const v = args[++i]; data = v === "@-" ? await Bun.stdin.text() : v; }
  else if (a.startsWith("-")) { if (!a.startsWith("--") && a.includes("f")) fail = true; }
  else url = a;
}
await Bun.write(Bun.file(${JSON.stringify(log)}), (await Bun.file(${JSON.stringify(log)}).text()) + "curl " + method + " " + url + "\\n");
let r;
try { r = await fetch(url, { method, headers, body: data }); } catch { process.exit(7); }
if (fail && r.status >= 400) process.exit(22);
const body = await r.text();
if (out) await Bun.write(out, body); else process.stdout.write(body);
if (write) process.stdout.write(write.replaceAll("\\\\n", "\\n").replaceAll("%{http_code}", String(r.status)));`,
    true,
  );
  setModeset("Y");
  setDriver(DRIVER);
});

afterEach(() => {
  server.stop(true);
  rmSync(sandbox.dir, { recursive: true, force: true });
});

/** Запуск скрипта с подстановками оркестратора; асинхронно — фейковый главный в этом же процессе. */
const install = async (args: string[]) => {
  const rendered = join(sandbox.dir, "install.sh");
  writeFileSync(
    rendered,
    script
      .replaceAll("__ORCHESTRATOR_PUBLIC_URL__", sandbox.url)
      .replaceAll("__CG_VERSION__", "v1.2.3")
      .replaceAll("__CG_DRIVERS__", `${DRIVER} 570.86.16`),
  );
  const proc = Bun.spawn(["bash", rendered, ...args], {
    env: {
      ...process.env,
      PATH: `${sandbox.bin}:${process.env.PATH}`,
      CG_SYSFS: sandbox.sys,
      CG_INSTALL_ROOT: sandbox.root,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode, log: readFileSync(sandbox.log, "utf8") };
};

const envFile = () => join(sandbox.root, "opt/cloud-gaming/.env");

describe("install.sh", () => {
  it("refuses without modeset", async () => {
    setModeset("N");
    const r = await install(["--dry-run", CODE]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("nvidia-drm modeset=1");
    expect(sandbox.enrolls).toBe(0);
  });

  it("refuses a driver the release has no session image for, before using the code", async () => {
    setDriver("535.183.01");
    const r = await install(["--public-ip", "203.0.113.7", CODE]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("535.183.01");
    expect(r.stderr).toContain(DRIVER);
    expect(sandbox.enrolls).toBe(0);
    expect(existsSync(envFile())).toBe(false);
  });

  it("dry run prints the plan with placeholders and does not use the code", async () => {
    const r = await install(["--dry-run", "--public-ip", "203.0.113.7", CODE]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(sandbox.url);
    expect(r.stdout).toContain("v1.2.3");
    expect(r.stdout).toContain(SESSION_IMAGE);
    expect(r.stdout).toContain("SLOTS=2");
    expect(r.stdout).toContain("WORKER_ID=<выдаст главный>");
    expect(r.stdout).toContain("203.0.113.7");
    expect(sandbox.enrolls).toBe(0);
    expect(r.log).not.toContain("docker login");
    expect(r.log).not.toContain("docker network create");
    expect(existsSync(join(sandbox.root, "opt"))).toBe(false);
    expect(existsSync(join(sandbox.root, "srv"))).toBe(false);
  });

  it("enrolls, writes .env with mode 600 and starts the agent", async () => {
    const r = await install(["--public-ip", "203.0.113.7", CODE]);
    expect(r.stderr).not.toContain("ОШИБКА");
    expect(r.exitCode).toBe(0);
    expect(sandbox.enrolls).toBe(1);

    const env = readFileSync(envFile(), "utf8").split("\n");
    for (const line of [
      "WORKER_ID=spb-1",
      `WORKER_TOKEN=${TOKEN}`,
      "ORCHESTRATOR_URL=wss://game.example.ru/agent",
      "CG_VERSION=v1.2.3",
      `SESSION_IMAGE=${SESSION_IMAGE}`,
      "WORKER_PUBLIC_IP=203.0.113.7",
      "SLOTS=2",
      "UDP_PORT_BASE=59000",
      "DOCKER_GID=995",
      `GBM_ALLOCATOR_PATH=/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.${DRIVER}`,
      "CG_DATA_DIR=/srv/cloud-gaming",
      "SCRATCH_DIR=/srv/cloud-gaming-scratch",
      "STEAM_CLIENT_DIR=/srv/cloud-gaming-steam/client",
      "STEAM_CLIENT_PARENT=/srv/cloud-gaming-steam",
    ])
      expect(env).toContain(line);
    expect(statSync(envFile()).mode & 0o777).toBe(0o600);

    // Пароль реестра — только через stdin, не в аргументах и не в выводе.
    expect(readFileSync(join(sandbox.dir, "login-stdin"), "utf8")).toBe(
      PASSWORD,
    );
    expect(r.log).toContain(
      "docker login --username cg-pull --password-stdin registry.example.ru",
    );
    expect(r.log).not.toContain(PASSWORD);
    expect(r.stdout + r.stderr).not.toContain(PASSWORD);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);

    expect(r.log).toContain(`docker pull ${SESSION_IMAGE}`);
    expect(r.log).toContain("docker network create cg-sessions");
    const lines = r.log.split("\n");
    const pull = lines.findIndex((l) => /^docker compose .* pull$/.test(l));
    const up = lines.findIndex((l) => /^docker compose .* up -d$/.test(l));
    const isolation = lines.findIndex((l) => l === "isolation apply-local");
    const steam = lines.findIndex((l) => l.startsWith("steam-client "));
    expect(pull).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThan(pull);
    expect(isolation).toBeGreaterThan(up);
    expect(steam).toBeGreaterThan(isolation);

    for (const dir of [
      "srv/cloud-gaming/library/steamapps",
      "srv/cloud-gaming/install-scratch",
      "srv/cloud-gaming/games",
      "srv/cloud-gaming-scratch",
      "srv/cloud-gaming-steam",
    ])
      expect(existsSync(join(sandbox.root, dir))).toBe(true);
    expect(r.log).toContain(
      `chown 1000:1000 ${join(sandbox.root, "srv/cloud-gaming-scratch")}`,
    );
    expect(
      existsSync(join(sandbox.root, "opt/cloud-gaming/compose.yaml")),
    ).toBe(true);

    expect(r.stdout).toContain("Сервер spb-1 подключён");
    expect(r.stdout).toContain("UDP 59000-59001");
  });

  it("stops with a clear message when the code is not accepted", async () => {
    const r = await install([
      "--public-ip",
      "203.0.113.7",
      "WRONGCODEWRONGCODEWRONGC",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Код подключения недействителен");
    expect(sandbox.enrolls).toBe(1);
    expect(existsSync(envFile())).toBe(false);
    expect(r.log).not.toContain("docker login");
  });
});
