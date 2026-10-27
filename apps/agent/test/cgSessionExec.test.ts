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
 * Скрипт образа сессии: выполняет команду в окружении процесса сессии (клиент Steam, композитор
 * labwc, или, на старом образе KDE, plasmashell), потому что `docker exec` сам его не знает —
 * без DISPLAY/XAUTHORITY графические программы не находят дисплей. Зовут его cg-steam-shutdown
 * (своё окружение для `steam -shutdown`) и build-steam-client.sh (второй цикл, `steam -silent`).
 *
 * Фейковый `pgrep` в `PATH` ищет по таблице процессов `${FAKE_PGREP_DIR}/processes` (строки
 * «pid имя командная_строка»): `-f ШАБЛОН` — по командной строке (настоящим `grep -E`, так что
 * шаблон `ubuntu12_32/steam( |$)` из самого скрипта проверяется буквально), `-x` — по точному
 * имени процесса, `-o` — выдаёт только первое совпадение (как настоящий «oldest»).
 */
const script = join(import.meta.dir, "../../../images/session/cg-session-exec");

const STEAM_PID = "500";
const LABWC_PID = "600";
const PLASMA_PID = "700";

const SESSION_VARS: Record<string, string> = {
  DISPLAY: ":1",
  WAYLAND_DISPLAY: "wayland-1",
  XDG_RUNTIME_DIR: "/run/user/1000",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  HOME: "/home/ubuntu",
  USER: "ubuntu",
  LD_PRELOAD: "/usr/lib/libselkies-interposer.so",
  XAUTHORITY: "/home/ubuntu/.Xauthority",
  XDG_SESSION_TYPE: "wayland",
};

let dir: string;
let bin: string;
let pgrepDir: string;
let procDir: string;
let processesFile: string;
let probeOut: string;
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

const run = (args: string[]) =>
  Bun.spawnSync(["bash", script, ...args], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      FAKE_PGREP_DIR: pgrepDir,
      CG_PROC_DIR: procDir,
    },
  });

const probeEnv = () => (existsSync(probeOut) ? readFileSync(probeOut, "utf8") : null);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cg-session-exec-"));
  bin = join(dir, "bin");
  pgrepDir = join(dir, "pgrep");
  procDir = join(dir, "proc");
  processesFile = join(pgrepDir, "processes");
  probeOut = join(dir, "probe.env");
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

  // Пишет своё окружение (отфильтрованное env -i внутри скрипта) в файл — тест проверяет,
  // какие переменные дошли до команды.
  writeExecutable(
    join(bin, "probe"),
    `#!/bin/bash
env | sort > "${probeOut}"
`,
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("cg-session-exec", () => {
  it("takes the environment from the Steam client", () => {
    addProcess(STEAM_PID, "steam", "/home/ubuntu/.local/share/Steam/ubuntu12_32/steam -silent");
    setEnviron(STEAM_PID, SESSION_VARS);

    const result = run(["probe"]);

    expect(result.exitCode).toBe(0);
    const output = probeEnv();
    expect(output).not.toBeNull();
    for (const [key, value] of Object.entries(SESSION_VARS)) {
      expect(output).toContain(`${key}=${value}`);
    }
  });

  it("prefers the Steam client over the compositor when both are running", () => {
    addProcess(STEAM_PID, "steam", "/home/ubuntu/.local/share/Steam/ubuntu12_32/steam -silent");
    setEnviron(STEAM_PID, SESSION_VARS);
    addProcess(LABWC_PID, "labwc", "/usr/bin/labwc");
    setEnviron(LABWC_PID, { ...SESSION_VARS, DISPLAY: ":9" });

    const result = run(["probe"]);

    expect(result.exitCode).toBe(0);
    expect(probeEnv()).toContain(`DISPLAY=${SESSION_VARS.DISPLAY}`);
  });

  it("falls back to the compositor when Steam is not running", () => {
    addProcess(LABWC_PID, "labwc", "/usr/bin/labwc");
    setEnviron(LABWC_PID, SESSION_VARS);

    const result = run(["probe"]);

    expect(result.exitCode).toBe(0);
    expect(probeEnv()).toContain(`HOME=${SESSION_VARS.HOME}`);
  });

  it("falls back to plasmashell on the KDE image", () => {
    addProcess(PLASMA_PID, "plasmashell", "/usr/bin/plasmashell");
    setEnviron(PLASMA_PID, SESSION_VARS);

    const result = run(["probe"]);

    expect(result.exitCode).toBe(0);
    expect(probeEnv()).toContain(`USER=${SESSION_VARS.USER}`);
  });

  it("fails with 1 without a session process", () => {
    const result = run(["probe"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("[cg-session-exec] no session process");
    expect(probeEnv()).toBeNull();
  });

  it("passes only the session variables", () => {
    addProcess(STEAM_PID, "steam", "/home/ubuntu/.local/share/Steam/ubuntu12_32/steam -silent");
    setEnviron(STEAM_PID, { ...SESSION_VARS, SECRET: "x" });

    run(["probe"]);

    const output = probeEnv();
    expect(output).not.toBeNull();
    expect(output).not.toContain("SECRET");
  });
});
