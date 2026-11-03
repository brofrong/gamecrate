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
 * Скрипт образа сессии: его запускает автостарт labwc в контейнере
 * (/etc/xdg/labwc/autostart).
 */
const script = join(import.meta.dir, "../../../images/session/cg-launch");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cg-launch-"));
  mkdirSync(join(dir, "bin"));
  // Фейковый steam: дописывает свои аргументы в файл.
  writeFileSync(
    join(dir, "bin", "steam"),
    `#!/bin/bash\necho "$*" >> "${join(dir, "steam.log")}"\n`,
  );
  chmodSync(join(dir, "bin", "steam"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const launch = (env: Record<string, string>) =>
  Bun.spawnSync(["bash", script], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      CG_LAUNCH_LOCK: join(dir, "lock"),
      ...env,
    },
  });

const steamRuns = () =>
  existsSync(join(dir, "steam.log"))
    ? readFileSync(join(dir, "steam.log"), "utf8").split("\n").filter(Boolean)
    : [];

describe("cg-launch", () => {
  it("launches the game once per container", () => {
    expect(launch({ CG_APP_ID: "1794680" }).exitCode).toBe(0);
    expect(launch({ CG_APP_ID: "1794680" }).exitCode).toBe(0);
    expect(steamRuns()).toEqual(["-silent -applaunch 1794680"]);
  });

  it("install mode starts Steam without launching a game, once", () => {
    expect(launch({ CG_MODE: "install", CG_APP_ID: "" }).exitCode).toBe(0);
    expect(launch({ CG_MODE: "install" }).exitCode).toBe(0);
    expect(steamRuns()).toEqual(["-silent"]);
  });

  it("empty or non-numeric CG_APP_ID outside install mode does not start Steam", () => {
    expect(launch({}).exitCode).toBe(0);
    expect(launch({ CG_APP_ID: "1; rm -rf /" }).exitCode).toBe(1);
    expect(steamRuns()).toEqual([]);
  });

  it("CG_GAME runs the game through cg-game-exit, not steam", () => {
    mkdirSync(join(dir, "game"), { recursive: true });
    const gamePath = join(dir, "game", "run");
    writeFileSync(gamePath, "#!/bin/bash\n");
    chmodSync(gamePath, 0o755);

    // Фейковая обёртка: дописывает свой argv в файл вместо настоящего запуска игры.
    const wrapperLog = join(dir, "game-exit.log");
    const wrapper = join(dir, "cg-game-exit");
    writeFileSync(wrapper, `#!/bin/bash\necho "$*" >> "${wrapperLog}"\n`);
    chmodSync(wrapper, 0o755);

    const result = launch({ CG_GAME: gamePath, CG_GAME_EXIT: wrapper });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(wrapperLog, "utf8").trim()).toBe(gamePath);
    expect(steamRuns()).toEqual([]);
  });

  it("CG_GAME that is not executable exits 1", () => {
    mkdirSync(join(dir, "game"), { recursive: true });
    const gamePath = join(dir, "game", "run");
    writeFileSync(gamePath, "#!/bin/bash\n");
    // без chmod +x

    expect(launch({ CG_GAME: gamePath }).exitCode).toBe(1);
    expect(steamRuns()).toEqual([]);
  });
});
