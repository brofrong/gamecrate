// Общие заготовки тестов агента: конфиг и «пустой» DockerClient.
import { Effect, Option, Redacted } from "effect";
import type { AgentConfigValues } from "../src/config";
import type { DockerClientShape } from "../src/DockerClient";
import { singleFileTar } from "../src/profile/codec";

/** Конфиг агента для тестов; `patch` перекрывает поля. */
export const testConfig = (
  patch: Partial<AgentConfigValues> = {},
): AgentConfigValues => ({
  workerId: "w1",
  orchestratorUrl: "ws://orchestrator:3001/agent",
  agentToken: Redacted.make("x".repeat(32)),
  publicIp: "203.0.113.7",
  slots: 2,
  udpPortBase: 59000,
  sessionImage: "cg-session:550.163.01",
  sessionNetwork: "cg-sessions",
  s3Endpoint: "http://cg-rustfs:9000",
  s3Bucket: "cg-profiles",
  s3AccessKey: Redacted.make("test-access-key"),
  s3SecretKey: Redacted.make("test-secret-key"),
  profileKey: Redacted.make(Buffer.from(new Uint8Array(32)).toString("base64")),
  gbmAllocatorPath: Option.some(
    "/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.550.163.01",
  ),
  dockerSocket: "/var/run/docker.sock",
  libraryDir: "/raid/cloud-gaming/library",
  steamClientDir: "/raid/cloud-gaming/steam-client",
  scratchDir: "/scratch",
  roles: ["worker"],
  installScratchDir: Option.none(),
  minFreeGb: 20,
  ...patch,
});

const unused = (method: string) => () =>
  Effect.die(new Error(`unexpected DockerClient.${method}`));

/** DockerClient, любой вызов которого — дефект теста; нужные методы перекрываются. */
export const unusedDocker: DockerClientShape = {
  create: unused("create"),
  start: unused("start"),
  createAndStart: unused("createAndStart"),
  wait: unused("wait"),
  stop: unused("stop"),
  remove: unused("remove"),
  exec: unused("exec"),
  logs: unused("logs"),
  inspect: unused("inspect"),
  listByLabel: unused("listByLabel"),
  createVolume: unused("createVolume"),
  removeVolume: unused("removeVolume"),
  volumeExists: unused("volumeExists"),
  listVolumes: unused("listVolumes"),
  putArchive: unused("putArchive"),
  getArchive: unused("getArchive"),
  archiveSize: unused("archiveSize"),
};

/**
 * Tar с одним файлом `name` (как отдаёт `GET /containers/{id}/archive` для
 * пути к файлу): владелец 1000:1000, права 0644.
 */
export const tarOfFile = (name: string, data: Uint8Array) =>
  singleFileTar(name, data, { uid: 1000, gid: 1000, mode: 0o644, mtime: 0 });
