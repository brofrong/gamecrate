import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Скрипт образа сессии: агент зовёт его `docker exec` перед снятием профиля, чтобы закрыть
 * клиент Steam штатно (`steam -shutdown`), а не оставить недописанные config.vdf/local.vdf.
 * Окружение для Steam скрипт берёт через cg-session-exec (реальный скрипт из images/session —
 * он уже проверен отдельно в cgSessionExec.test.ts, здесь он просто должен быть на PATH, как
 * в образе, где оба лежат в /usr/local/bin). Фейковые `pgrep`/`steam` — как в cgSessionExec.test.ts.
 */
const script = join(import.meta.dir, "../../../images/session/cg-steam-shutdown");
const sessionDir = join(import.meta.dir, "../../../images/session");

const CLIENT_PID = "500";

const CLIENT_ENV: Record<string, string> = {
  DISPLAY: ":1",
  XDG_RUNTIME_DIR: "/run/user/1000",
  HOME: "/home/ubuntu",
  USER: "ubuntu",
};

let dir: string;
let bin: string;
let pgrepDir: string;
let procDir: string;
let processesFile: string;
let processes: string[];

const writeExecutable = (path: string, content: string) => {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
};

const writeLines = (path: string, lines: string[]) =>
  writeFileSync(path, lines.length ? `${lines.join("\n")}\n` : "");

const addProcess = (pid: string, name: string, cmdline: string) => {
  processes.push(`${pid} ${name} ${cmdline}`);
  writeLines(processesFile, processes);
};

const setEnviron = (pid: string, vars: Record<string, string>) => {
  mkdirSync(join(procDir, pid), { recursive: true });
  const body = `${Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\0")}\0`;
  writeFileSync(join(procDir, pid, "environ"), body);
};

const addClient = () => {
  addProcess(CLIENT_PID, "steam", "/home/ubuntu/.local/share/Steam/ubuntu12_32/steam -silent");
  setEnviron(CLIENT_PID, CLIENT_ENV);
};

/** Фейковый `steam -shutdown`: имитирует выход клиента, убирая его из таблицы процессов. */
const addShutdownSteam = () => {
  writeExecutable(
    join(bin, "steam"),
    `#!/bin/bash
if [ "\${1:-}" = "-shutdown" ]; then
  grep -v '^${CLIENT_PID} ' "${processesFile}" > "${processesFile}.tmp" 2>/dev/null || true
  mv "${processesFile}.tmp" "${processesFile}"
fi
exit 0
`,
  );
};

const run = () =>
  Bun.spawnSync(["bash", script], {
    env: {
      PATH: `${bin}:${sessionDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      FAKE_PGREP_DIR: pgrepDir,
      CG_PROC_DIR: procDir,
    },
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cg-steam-shutdown-"));
  bin = join(dir, "bin");
  pgrepDir = join(dir, "pgrep");
  procDir = join(dir, "proc");
  processesFile = join(pgrepDir, "processes");
  processes = [];
  mkdirSync(bin);
  mkdirSync(pgrepDir);
  mkdirSync(procDir);
  writeLines(processesFile, processes);

  writeExecutable(
    join(bin, "pgrep"),
    `#!/bin/bash
set -u
dir="\${FAKE_PGREP_DIR:?}"
procfile="\${dir}/processes"
opt="\${1:-}"
pattern="\${2:-}"
exact=0
oldest=0
case "\${opt}" in *x*) exact=1 ;; esac
case "\${opt}" in *o*) oldest=1 ;; esac
found=1
if [ -f "\${procfile}" ]; then
  while IFS= read -r line; do
    [ -n "\${line}" ] || continue
    pid="\${line%% *}"
    rest="\${line#* }"
    name="\${rest%% *}"
    cmdline="\${rest#* }"
    if [ "\${exact}" -eq 1 ]; then target="\${name}"; else target="\${cmdline}"; fi
    if grep -Eq -- "\${pattern}" <<<"\${target}"; then
      echo "\${pid}"
      found=0
      [ "\${oldest}" -eq 1 ] && break
    fi
  done <"\${procfile}"
fi
exit "\${found}"
`,
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("cg-steam-shutdown", () => {
  it("exits 0 when the client is not running", () => {
    const result = run();
    expect(result.exitCode).toBe(0);
  });

  it("runs steam -shutdown with the client environment and waits for exit", () => {
    addClient();
    addShutdownSteam();

    const start = Date.now();
    const result = run();
    const elapsedMs = Date.now() - start;

    expect(result.exitCode).toBe(0);
    // Фейковый steam убирает клиента из таблицы процессов почти мгновенно — ждать все 30 с
    // (цикл опроса) скрипт не должен.
    expect(elapsedMs).toBeLessThan(10000);
  });

  it("does not need plasmashell", () => {
    addClient();
    addShutdownSteam();

    const result = run();

    expect(result.exitCode).toBe(0);
    expect(readFileSync(script, "utf8")).not.toContain("plasmashell");
  });
});
