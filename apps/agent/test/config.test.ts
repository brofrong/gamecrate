import { describe, expect, it } from "bun:test";
import { ConfigProvider, Effect, Option } from "effect";
import { agentConfig } from "../src/config";

/** Минимальное окружение агента воркера. */
const base: Record<string, string> = {
  WORKER_ID: "w1",
  ORCHESTRATOR_URL: "ws://cg-orchestrator:3001/agent",
  AGENT_TOKEN: "x".repeat(32),
  WORKER_PUBLIC_IP: "203.0.113.7",
  SESSION_IMAGE: "cg-session:550.163.01",
  S3_ENDPOINT: "http://cg-rustfs:9000",
  S3_ACCESS_KEY: "access-key-0123456789",
  S3_SECRET_KEY: "secret-key-0123456789",
  PROFILE_KEY: Buffer.from(new Uint8Array(32)).toString("base64"),
  LIBRARY_DIR: "/raid/cloud-gaming/library",
  STEAM_CLIENT_DIR: "/raid/cloud-gaming/steam-client",
  SCRATCH_DIR: "/home/brofrong/cloud-gaming/scratch",
};

const parse = (env: Record<string, string>) =>
  Effect.runPromise(
    Effect.result(agentConfig.parse(ConfigProvider.fromEnv({ env }))),
  );

const ok = async (env: Record<string, string>) => {
  const result = await parse(env);
  if (result._tag === "Failure") throw new Error(String(result.failure));
  return result.success;
};

const error = async (env: Record<string, string>) => {
  const result = await parse(env);
  if (result._tag === "Success") throw new Error("expected a config error");
  return result.failure.message;
};

describe("agentConfig roles", () => {
  it("defaults to a worker without an install scratch dir", async () => {
    const config = await ok(base);
    expect(config.roles).toEqual(["worker"]);
    expect(config.installScratchDir).toEqual(Option.none());
  });

  it("reads comma-separated roles and the install scratch dir", async () => {
    const config = await ok({
      ...base,
      ROLES: " worker , gamestore,worker",
      INSTALL_SCRATCH_DIR: "/raid/cloud-gaming/install-scratch",
    });
    expect(config.roles).toEqual(["worker", "gamestore"]);
    expect(config.installScratchDir).toEqual(
      Option.some("/raid/cloud-gaming/install-scratch"),
    );
  });

  it("gamestore without INSTALL_SCRATCH_DIR is a config error", async () => {
    expect(await error({ ...base, ROLES: "gamestore" })).toContain(
      "INSTALL_SCRATCH_DIR",
    );
  });

  it("unknown or empty roles are a config error", async () => {
    expect(await error({ ...base, ROLES: "worker,builder" })).toContain(
      "builder",
    );
    expect(await error({ ...base, ROLES: " , " })).toContain("ROLES");
  });

  it("install scratch must not share a directory tree with session scratch", async () => {
    for (const dir of [
      base.SCRATCH_DIR,
      `${base.SCRATCH_DIR}/install`,
      "/home/brofrong/cloud-gaming",
    ])
      expect(
        await error({
          ...base,
          ROLES: "worker,gamestore",
          INSTALL_SCRATCH_DIR: dir as string,
        }),
      ).toContain("INSTALL_SCRATCH_DIR");
    // Общий префикс имени — не вложенность.
    await ok({
      ...base,
      ROLES: "gamestore",
      INSTALL_SCRATCH_DIR: `${base.SCRATCH_DIR}-install`,
    });
  });
});
