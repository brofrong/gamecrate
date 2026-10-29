import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Обёртка образа сессии (спека 2026-10-29 §4.2): Steam запускает игру через
 * неё (`LaunchOptions`: `/usr/local/bin/cg-game-exit %command%`), она пишет,
 * чем кончился процесс игры, в `/tmp/cg-game-exit` (`CG_GAME_EXIT_FILE`).
 */
const script = join(import.meta.dir, "../../../images/session/cg-game-exit");

let dir: string;
let out: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cg-game-exit-"));
  out = join(dir, "cg-game-exit");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (...args: string[]) =>
  Bun.spawnSync(["bash", script, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CG_GAME_EXIT_FILE: out },
  });

const written = () => readFileSync(out, "utf8");

describe("cg-game-exit", () => {
  it("records exit code 0", () => {
    expect(run("bash", "-c", "exit 0").exitCode).toBe(0);
    expect(written()).toBe("code 0\n");
  });

  it("records a non-zero exit code and keeps it", () => {
    expect(run("bash", "-c", "exit 3").exitCode).toBe(3);
    expect(written()).toBe("code 3\n");
  });

  it("records death by signal as 128+n", () => {
    const result = run("bash", "-c", "kill -SEGV $$");
    expect(result.exitCode).toBe(139);
    expect(written()).toBe("code 139\n");
  });

  it("passes arguments through unchanged", () => {
    const marker = join(dir, "args");
    run("bash", "-c", 'printf "%s|" "$@" > "$0"', marker, "a b", "-c", "");
    expect(readFileSync(marker, "utf8")).toBe("a b|-c||");
  });

  it("leading NAME=value arguments become the game's environment", () => {
    // Параметры игрока вида `PROTON_LOG=1 %command%` — обёртка стоит перед ними.
    const marker = join(dir, "env");
    expect(
      run(
        "CG_TEST_VAR=x y",
        "bash",
        "-c",
        'printf "%s" "$CG_TEST_VAR" > "$0"',
        marker,
      ).exitCode,
    ).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("x y");
  });

  it("a missing command is recorded as code 127", () => {
    expect(run(join(dir, "no-such-game")).exitCode).toBe(127);
    expect(written()).toBe("code 127\n");
  });

  it("SIGTERM to the wrapper waits for the game and still records it", async () => {
    const proc = Bun.spawn(
      ["bash", script, "bash", "-c", "sleep 0.5; exit 4"],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CG_GAME_EXIT_FILE: out,
        },
      },
    );
    await Bun.sleep(150);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(4);
    expect(written()).toBe("code 4\n");
  });

  it("without a command writes nothing", () => {
    expect(run().exitCode).toBe(2);
    expect(existsSync(out)).toBe(false);
  });
});
