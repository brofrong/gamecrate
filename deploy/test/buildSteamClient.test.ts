import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Сборка шаблона клиента Steam (deploy/worker/build-steam-client.sh) с заглушками команд в PATH:
 * docker (журнал вызовов, «клиент» для `docker cp`), sleep и date (время идёт по 10 с за вызов —
 * без настоящих минут ожидания), find (проверка владельца uid 1000 вне root не пройдёт) и mv
 * (`-T` нет у BSD mv на macOS).
 */
const script = join(import.meta.dir, "../worker/build-steam-client.sh");

interface Sandbox {
  readonly dir: string;
  readonly bin: string;
  readonly log: string;
  readonly target: string;
}

let sandbox: Sandbox;

const stub = (name: string, body: string) => {
  const path = join(sandbox.bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
};

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "cg-steam-client-"));
  sandbox = {
    dir,
    bin: join(dir, "bin"),
    log: join(dir, "log"),
    target: join(dir, "steam/client"),
  };
  mkdirSync(sandbox.bin);
  writeFileSync(sandbox.log, "");
  // GBM-библиотека есть: с пустым массивом её монтирований bash 3.2 (macOS) под `set -u` падает
  // (на серверах bash 5 — там это не ошибка).
  const gbm = join(dir, "libnvidia-allocator.so");
  writeFileSync(gbm, "");
  writeFileSync(
    join(dir, ".env"),
    `SESSION_IMAGE=cg-session:test\nSTEAM_CLIENT_DIR=${sandbox.target}\nGBM_ALLOCATOR_PATH=${gbm}\n`,
  );
  const { log } = sandbox;

  // Контейнера сборки нет до `docker run`; cg-agent запущен, пока в песочнице нет agent-stopped;
  // `docker cp` кладёт клиент с ubuntu12_32/steam, пока нет файла cp-empty (тогда — пустой).
  stub(
    "docker",
    `echo "docker $*" >> "${log}"
case "$1" in
image | network | run | stop | rm | restart) exit 0 ;;
ps) exit 0 ;;
inspect)
  case "$*" in
  *cg-agent*) [ -e "${dir}/agent-stopped" ] && echo false || echo true ;;
  *State.Running*) echo true ;;
  *) exit 1 ;;
  esac
  ;;
exec)
  case "$*" in
  *" du "*) printf '2600000\\t/x\\n' ;;
  esac
  exit 0
  ;;
cp)
  if [ ! -e "${dir}/cp-empty" ]; then
    mkdir -p "$3/ubuntu12_32" "$3/logs"
    printf '#!/bin/sh\\n' > "$3/ubuntu12_32/steam"
    chmod 755 "$3/ubuntu12_32/steam"
  fi
  exit 0
  ;;
esac
exit 0`,
  );
  stub("sleep", "exit 0");
  stub(
    "date",
    `n=$(cat "${dir}/clock" 2>/dev/null || echo 1000)
echo $((n + 10)) > "${dir}/clock"
echo "$n"`,
  );
  stub("find", "exit 0");
  stub(
    "mv",
    `args=()
for a in "$@"; do [ "$a" = -T ] || args+=("$a"); done
exec /bin/mv "\${args[@]}"`,
  );
});

afterEach(() => {
  rmSync(sandbox.dir, { recursive: true, force: true });
});

const build = () => {
  const r = Bun.spawnSync(
    ["bash", script, "--env-file", join(sandbox.dir, ".env")],
    {
      env: { ...process.env, PATH: `${sandbox.bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: r.exitCode,
    stdout: r.stdout.toString("utf8"),
    stderr: r.stderr.toString("utf8"),
    log: readFileSync(sandbox.log, "utf8").split("\n"),
  };
};

describe("build-steam-client.sh", () => {
  it("restarts the running cg-agent after a successful build", () => {
    const r = build();
    expect(r.stderr).not.toContain("ОШИБКА");
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(sandbox.target, "ubuntu12_32/steam"))).toBe(true);
    const done = r.stdout.indexOf("==> готово");
    const restart = r.stdout.indexOf("==> перезапуск cg-agent");
    expect(done).toBeGreaterThanOrEqual(0);
    expect(restart).toBeGreaterThan(done);
    expect(r.log).toContain("docker restart cg-agent");
  });

  it("leaves a stopped cg-agent alone", () => {
    writeFileSync(join(sandbox.dir, "agent-stopped"), "");
    const r = build();
    expect(r.exitCode).toBe(0);
    expect(r.log.some((l) => l.startsWith("docker restart"))).toBe(false);
  });

  it("does not restart cg-agent when the build fails", () => {
    writeFileSync(join(sandbox.dir, "cp-empty"), "");
    const r = build();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("клиент не скачался");
    expect(r.log.some((l) => l.startsWith("docker restart"))).toBe(false);
    expect(existsSync(join(sandbox.target, "ubuntu12_32/steam"))).toBe(false);
  });
});
