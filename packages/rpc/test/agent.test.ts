import { describe, expect, it } from "bun:test";
import { Redacted, Schema } from "effect";
import {
  AgentCommand,
  AgentConnect,
  AgentReport,
  ProfileCommit,
  WorkerStats,
} from "../src/agent";
import { InstallStage, SessionStage } from "../src/session";

describe("agent protocol", () => {
  it("decodes InstallGame and InstallProgress round-trip", () => {
    const install = {
      _tag: "InstallGame",
      jobId: "job-1",
      appId: 570,
      userId: "u1",
      profile: { version: 3, objectKey: "profiles/u1/x.cgp" },
      steamLogin: null,
      steamLoginTimeoutSeconds: 90,
    } as const;
    expect(Schema.decodeUnknownSync(AgentCommand)(install)).toEqual(install);

    const progress = {
      _tag: "InstallProgress",
      jobId: "job-1",
      bytesDownloaded: 10,
      bytesTotal: 100,
    } as const;
    expect(Schema.decodeUnknownSync(AgentReport)(progress)).toEqual(progress);
  });

  it("decodes SessionStage and InstallStage reports round-trip", () => {
    const sessionStage = {
      _tag: "SessionStage",
      sessionId: "s1",
      stage: "login",
    } as const;
    expect(Schema.decodeUnknownSync(AgentReport)(sessionStage)).toEqual(
      sessionStage,
    );

    const installStage = {
      _tag: "InstallStage",
      jobId: "job-1",
      stage: "downloading",
    } as const;
    expect(Schema.decodeUnknownSync(AgentReport)(installStage)).toEqual(
      installStage,
    );
  });

  it("rejects unknown SessionStage/InstallStage literals", () => {
    expect(() =>
      Schema.decodeUnknownSync(SessionStage)("unknown"),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(InstallStage)("unknown"),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AgentReport)({
        _tag: "SessionStage",
        sessionId: "s1",
        stage: "unknown",
      }),
    ).toThrow();
  });

  it("rejects AgentConnect with unknown role", () => {
    const base = {
      workerId: "w1",
      publicIp: "203.0.113.7",
      slots: 1,
      udpPortBase: 59000,
      running: [],
      installs: [],
    };
    expect(() =>
      Schema.decodeUnknownSync(AgentConnect)({ ...base, roles: ["worker"] }),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AgentConnect)({ ...base, roles: ["boss"] }),
    ).toThrow();
  });

  it("InstallGame carries a redacted Steam login", () => {
    const json = {
      _tag: "InstallGame",
      jobId: "job-1",
      appId: 570,
      userId: "u1",
      profile: null,
      steamLogin: {
        accountName: "acc",
        steamId: "76561197960287930",
        refreshToken: "tok",
      },
      steamLoginTimeoutSeconds: 90,
    } as const;
    const decoded = Schema.decodeUnknownSync(AgentCommand)(json);
    if (decoded._tag !== "InstallGame" || decoded.steamLogin === null)
      throw new Error("expected InstallGame with steamLogin");
    // Redacted: ни String(), ни JSON.stringify не печатают сам токен.
    expect(Redacted.isRedacted(decoded.steamLogin.refreshToken)).toBe(true);
    expect(String(decoded.steamLogin.refreshToken)).not.toContain("tok");
    expect(JSON.stringify(decoded)).not.toContain("tok");
    // Кодирование обратно отдаёт исходный JSON — токен всё же уходит агенту
    // по WebSocket, Redacted только защищает от случайного лога/печати.
    expect(Schema.encodeSync(AgentCommand)(decoded)).toEqual(json);
  });

  it("AgentConnect без hardware/versions декодируется (старый агент совместим)", () => {
    const base = {
      workerId: "w1",
      publicIp: "203.0.113.7",
      slots: 1,
      udpPortBase: 59000,
      running: [],
      roles: ["worker"],
      installs: [],
    } as const;
    expect(Schema.decodeUnknownSync(AgentConnect)(base)).toEqual(base);
  });

  it("AgentConnect с hardware/versions декодируется", () => {
    const withExtras = {
      workerId: "w1",
      publicIp: "203.0.113.7",
      slots: 1,
      udpPortBase: 59000,
      running: [],
      roles: ["worker"],
      installs: [],
      hardware: {
        cpuModel: "AMD Ryzen 5 2600X Six-Core Processor",
        cpuCores: 6,
        cpuThreads: 12,
        memoryBytes: 32795732 * 1024,
        gpus: [{ name: "NVIDIA GeForce GTX 1650 SUPER", memoryBytes: 4096 * 2 ** 20 }],
        disks: [
          {
            name: "nvme0n1",
            kind: "nvme",
            sizeBytes: 488397168 * 512,
            raidLevel: null,
            members: [],
          },
        ],
      },
      versions: {
        agentCommit: "abc1234",
        sessionImage: "cg-session:latest",
        driver: "550.163.01",
        steamClientBuiltAt: "2026-10-28T00:00:00.000Z",
      },
    } as const;
    expect(Schema.decodeUnknownSync(AgentConnect)(withExtras)).toEqual(
      withExtras,
    );
  });

  it("AgentReport WorkerStats декодируется", () => {
    const stats: WorkerStats = {
      cpuPercent: 42,
      memory: { totalBytes: 100, usedBytes: 50, cacheBytes: 10 },
      gpus: [
        {
          utilPercent: 10,
          encoderPercent: 0,
          temperatureC: 40,
          memoryUsedBytes: 1,
          memoryTotalBytes: 2,
        },
      ],
      filesystems: [
        {
          purposes: ["scratch", "steamClient"],
          totalBytes: 100,
          usedBytes: 50,
          freeBytes: 50,
        },
      ],
      uptimeSeconds: 12345,
    };
    const report = { _tag: "WorkerStats", stats } as const;
    expect(Schema.decodeUnknownSync(AgentReport)(report)).toEqual(report);
    // Список библиотеки (роль gamestore) — необязательный.
    const withLibrary = {
      _tag: "WorkerStats",
      stats: {
        ...stats,
        library: [{ appId: 2379780, name: "Balatro", sizeBytes: 67108864 }],
      },
    } as const;
    expect(Schema.decodeUnknownSync(AgentReport)(withLibrary)).toEqual(
      withLibrary,
    );
    expect(() =>
      Schema.decodeUnknownSync(WorkerStats)({
        ...stats,
        library: [{ appId: 1, name: "x", sizeBytes: -1 }],
      }),
    ).toThrow();
  });

  it("DeleteGame, GameDeleted и GameDeleteFailed декодируются", () => {
    const command = { _tag: "DeleteGame", appId: 2379780 } as const;
    expect(Schema.decodeUnknownSync(AgentCommand)(command)).toEqual(command);
    const deleted = { _tag: "GameDeleted", appId: 2379780 } as const;
    expect(Schema.decodeUnknownSync(AgentReport)(deleted)).toEqual(deleted);
    const failed = {
      _tag: "GameDeleteFailed",
      appId: 2379780,
      reason: "Игра сейчас устанавливается",
    } as const;
    expect(Schema.decodeUnknownSync(AgentReport)(failed)).toEqual(failed);
    expect(() =>
      Schema.decodeUnknownSync(AgentCommand)({ _tag: "DeleteGame", appId: 1.5 }),
    ).toThrow();
  });

  it("ProfileCommit requires steamLoginSeeded", () => {
    const payload = {
      userId: "u1",
      baseVersion: null,
      objectKey: "profiles/u1/a.cgp",
      sizeBytes: 1,
      steamLoginSeeded: true,
    };
    expect(Schema.decodeUnknownSync(ProfileCommit)(payload)).toEqual(payload);
    expect(() =>
      Schema.decodeUnknownSync(ProfileCommit)({
        userId: "u1",
        baseVersion: null,
        objectKey: "profiles/u1/a.cgp",
        sizeBytes: 1,
      }),
    ).toThrow();
  });
});
