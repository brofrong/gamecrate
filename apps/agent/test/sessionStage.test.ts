import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Скрипт образа сессии: агент зовёт его `docker exec <container> cg-session-stage <appid>`
 * раз в 2 с (план «экран загрузки», §4.1).
 *
 * Фейковые `pgrep`/`xdotool`/`xwininfo` в `PATH` вместо настоящих:
 * - `pgrep` ищет по таблице процессов `${FAKE_PGREP_DIR}/processes` (строки «pid командная
 *   строка») настоящим `grep -E`, так что сам шаблон (`AppId=…`, `<буква>:\common\`,
 *   `ubuntu12_32/steam`) проверяется реальным регулярным выражением скрипта, а не угадыванием
 *   фейка; `pgrep -P <pid>` отдаёт `${FAKE_PGREP_DIR}/children-<pid>`.
 * - `xdotool search --onlyvisible --class/--pid …` отдаёт `${FAKE_XDOTOOL_DIR}/class-*`/`pid-*`
 *   (значение без `[^A-Za-z0-9_]`).
 * - `xwininfo -id <win>` отдаёт `${FAKE_XWININFO_DIR}/geom-<win>` (строки `Width:`/`Height:`).
 * - `timeout` — на этой машине нет ни GNU, ни BSD `timeout`; фейк ведёт себя как настоящий
 *   (SIGTERM и ненулевой код, если команда не успела), чтобы проверить, что сам скрипт не
 *   зависает на зависшем xdotool/xwininfo, а не угадывание фейка.
 */
const script = join(import.meta.dir, "../../../images/session/cg-session-stage");

const APP_ID = "1966900";
const REAPER_PID = "500";
const CLIENT_PID = "600";

let dir: string;
let bin: string;
let pgrepDir: string;
let xdotoolDir: string;
let xwininfoDir: string;
let procDir: string;
let home: string;
let processes: string[];

const writeExecutable = (path: string, content: string) => {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
};

const sanitize = (value: string) => value.replace(/[^A-Za-z0-9_]/g, "_");

const writeLines = (path: string, lines: string[]) =>
  writeFileSync(path, lines.length ? `${lines.join("\n")}\n` : "");

const addProcess = (pid: string, cmdline: string) => {
  processes.push(`${pid} ${cmdline}`);
  writeLines(join(pgrepDir, "processes"), processes);
};

const setChildren = (parentPid: string, children: string[]) =>
  writeLines(join(pgrepDir, `children-${parentPid}`), children);

const setClientEnviron = (pid: string) => {
  mkdirSync(join(procDir, pid), { recursive: true });
  writeFileSync(join(procDir, pid, "environ"), `DISPLAY=:0\0XAUTHORITY=${home}/.Xauthority\0`);
};

const setWindowsByClass = (pattern: string, ids: string[]) =>
  writeLines(join(xdotoolDir, `class-${sanitize(pattern)}`), ids);

const setWindowsByPid = (pid: string, ids: string[]) =>
  writeLines(join(xdotoolDir, `pid-${pid}`), ids);

const setGeometry = (winId: string, width: number, height: number) =>
  writeFileSync(join(xwininfoDir, `geom-${winId}`), `  Width: ${width}\n  Height: ${height}\n`);

const setLoginLog = (hasEntry: boolean) => {
  const logDir = join(home, ".local/share/Steam/logs");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    join(logDir, "steamui_login.txt"),
    hasEntry
      ? "[2026-10-27 09:04:32] [ None ] SetLoginState: WaitingForNetwork - OK\n"
      : "[2026-10-27 09:04:00] [ None ] SomethingElse\n",
  );
};

// Клиент Steam + reaper этой игры: общий фон для тестов этапов "login" и позже.
const addClient = () =>
  addProcess(
    CLIENT_PID,
    `/home/ubuntu/.local/share/Steam/ubuntu12_32/steam -srt-logger-opened -silent -applaunch ${APP_ID}`,
  );

const addReaper = () =>
  addProcess(
    REAPER_PID,
    `/home/ubuntu/.local/share/Steam/ubuntu12_32/reaper SteamLaunch AppId=${APP_ID} -- ` +
      "/home/ubuntu/.local/share/Steam/steamapps/common/SteamLinuxRuntime_4/_v2-entry-point",
  );

const stage = (appId: string = APP_ID) => {
  const result = Bun.spawnSync(["bash", script, appId], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      FAKE_PGREP_DIR: pgrepDir,
      FAKE_XDOTOOL_DIR: xdotoolDir,
      FAKE_XWININFO_DIR: xwininfoDir,
      CG_STAGE_PROC: procDir,
      HOME: home,
    },
  });
  return { stdout: result.stdout.toString().trim(), exitCode: result.exitCode };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cg-session-stage-"));
  bin = join(dir, "bin");
  pgrepDir = join(dir, "pgrep");
  xdotoolDir = join(dir, "xdotool");
  xwininfoDir = join(dir, "xwininfo");
  procDir = join(dir, "proc");
  home = join(dir, "home");
  processes = [];
  mkdirSync(bin);
  mkdirSync(pgrepDir);
  mkdirSync(xdotoolDir);
  mkdirSync(xwininfoDir);
  mkdirSync(procDir);
  mkdirSync(home);

  writeExecutable(
    join(bin, "pgrep"),
    `#!/bin/bash
set -u
dir="\${FAKE_PGREP_DIR:?}"

if [ "\${1:-}" = "-P" ]; then
  f="\${dir}/children-$2"
  if [ -s "\${f}" ]; then
    cat "\${f}"
    exit 0
  fi
  exit 1
fi

pattern="$2"
procfile="\${dir}/processes"
found=1
if [ -f "\${procfile}" ]; then
  while IFS= read -r line; do
    [ -n "\${line}" ] || continue
    pid="\${line%% *}"
    cmdline="\${line#* }"
    if grep -Eq -- "\${pattern}" <<<"\${cmdline}"; then
      echo "\${pid}"
      found=0
    fi
  done <"\${procfile}"
fi
exit "\${found}"
`,
  );

  writeExecutable(
    join(bin, "xdotool"),
    `#!/bin/bash
set -u
dir="\${FAKE_XDOTOOL_DIR:?}"
cmd="$1"
shift
if [ "\${cmd}" != "search" ]; then
  exit 1
fi
mode=""
value=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --onlyvisible) ;;
    --class)
      shift
      mode=class
      value="$1"
      ;;
    --pid)
      shift
      mode=pid
      value="$1"
      ;;
  esac
  shift
done
safe=$(printf '%s' "\${value}" | tr -c 'A-Za-z0-9_' '_')
f="\${dir}/\${mode}-\${safe}"
[ -s "\${f}" ] && cat "\${f}"
exit 0
`,
  );

  writeExecutable(
    join(bin, "xwininfo"),
    `#!/bin/bash
set -u
dir="\${FAKE_XWININFO_DIR:?}"
# вызывается как: xwininfo -id <winid>
winid="$2"
f="\${dir}/geom-\${winid}"
if [ -s "\${f}" ]; then
  cat "\${f}"
  exit 0
fi
exit 1
`,
  );

  // На этой машине нет ни GNU, ни BSD `timeout` (в образе сессии — coreutils, есть всегда):
  // как и xdotool/xwininfo, подменяем для теста. Поведение — как у настоящего: не успел за
  // "$1" секунд — SIGTERM и ненулевой код, а не зависание.
  writeExecutable(
    join(bin, "timeout"),
    `#!/bin/bash
set -u
dur="$1"
shift
"$@" &
cmd_pid=$!
( sleep "\${dur}"; kill -TERM "\${cmd_pid}" 2>/dev/null ) &
watcher_pid=$!
wait "\${cmd_pid}" 2>/dev/null
status=$?
kill "\${watcher_pid}" 2>/dev/null
exit "\${status}"
`,
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("cg-session-stage", () => {
  it("prints steam before the login log exists", () => {
    expect(stage()).toEqual({ stdout: "steam", exitCode: 0 });
  });

  it("prints login once SetLoginState is logged", () => {
    setLoginLog(true);
    expect(stage()).toEqual({ stdout: "login", exitCode: 0 });
  });

  it("prints prepare when reaper for the app runs", () => {
    setLoginLog(true);
    addReaper();
    expect(stage()).toEqual({ stdout: "prepare", exitCode: 0 });
  });

  it("prints loading when the game exe runs, not Proton's own exe", () => {
    addReaper();
    addProcess(
      "700",
      String.raw`\\?\S:\common\Proton - Experimental\files\share\wine\xalia.exe`,
    );
    expect(stage()).toEqual({ stdout: "prepare", exitCode: 0 });

    addProcess("701", String.raw`S:\common\1966900\Game.exe`);
    expect(stage()).toEqual({ stdout: "loading", exitCode: 0 });
  });

  it("prints visible for a steam_app_<appid> window", () => {
    addReaper();
    addClient();
    setClientEnviron(CLIENT_PID);
    setWindowsByClass(`^steam_app_${APP_ID}$`, ["12345"]);
    setGeometry("12345", 1920, 1080);
    expect(stage()).toEqual({ stdout: "visible", exitCode: 0 });
  });

  it("prints visible for a window of a reaper descendant", () => {
    addReaper();
    addClient();
    setClientEnviron(CLIENT_PID);
    setChildren(REAPER_PID, ["501"]);
    setWindowsByClass(`^steam_app_${APP_ID}$`, []);
    setWindowsByPid("501", ["999"]);
    setGeometry("999", 1280, 720);
    expect(stage()).toEqual({ stdout: "visible", exitCode: 0 });
  });

  it("ignores windows smaller than 64x64", () => {
    addReaper();
    addClient();
    setClientEnviron(CLIENT_PID);
    setWindowsByClass(`^steam_app_${APP_ID}$`, ["12345"]);
    setGeometry("12345", 32, 32);
    expect(stage()).toEqual({ stdout: "prepare", exitCode: 0 });
  });

  it("rejects a non-numeric appid with exit 2", () => {
    expect(stage("abc").exitCode).toBe(2);
  });

  it("does not hang when xdotool hangs: a non-visible stage still comes back quickly", () => {
    addReaper();
    addClient();
    setClientEnviron(CLIENT_PID);
    // Висит дольше, чем agent готов ждать между опросами (2 с) и дольше таймаута скрипта.
    // `exec` — иначе kill -TERM в фейковом `timeout` убьёт только интерпретатор-обёртку этого
    // скрипта, а сам `sleep` осиротеет и будет держать открытым пайп команды $(...) все 30 с.
    writeExecutable(join(bin, "xdotool"), "#!/bin/bash\nexec sleep 30\n");

    const start = Date.now();
    const result = stage();
    const elapsedMs = Date.now() - start;

    expect(result).toEqual({ stdout: "prepare", exitCode: 0 });
    expect(elapsedMs).toBeLessThan(5000);
  });
});
