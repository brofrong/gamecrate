import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { AgentCommand, AgentConnect, AgentReport } from "../src/agent";

describe("agent protocol", () => {
  it("decodes InstallGame and InstallProgress round-trip", () => {
    const install = {
      _tag: "InstallGame",
      jobId: "job-1",
      appId: 570,
      userId: "u1",
      profile: { version: 3, objectKey: "profiles/u1/x.cgp" },
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
});
