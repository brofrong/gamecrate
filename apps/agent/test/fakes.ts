// Общие заготовки тестов агента: конфиг и «пустой» DockerClient.
import { Effect, Option, Redacted } from "effect";
import type { AgentConfigValues } from "../src/config";
import type { DockerClientShape } from "../src/DockerClient";

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
};

/**
 * Tar с одним файлом `name` (как отдаёт `GET /containers/{id}/archive` для
 * пути к файлу): заголовок ustar 512 байт, данные, выравнивание, два нулевых блока.
 */
export const tarOfFile = (name: string, data: Uint8Array) => {
  const header = new Uint8Array(512);
  const text = new TextEncoder();
  header.set(text.encode(name), 0);
  header.set(text.encode("0000644\0"), 100);
  header.set(text.encode("0001750\0"), 108);
  header.set(text.encode("0001750\0"), 116);
  header.set(
    text.encode(`${data.length.toString(8).padStart(11, "0")}\0`),
    124,
  );
  header.set(text.encode("00000000000\0"), 136);
  header.set(text.encode("        "), 148);
  header[156] = "0".charCodeAt(0);
  header.set(text.encode("ustar\0"), 257);
  header.set(text.encode("00"), 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.set(text.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  const padded = Math.ceil(data.length / 512) * 512;
  const tar = new Uint8Array(512 + padded + 1024);
  tar.set(header, 0);
  tar.set(data, 512);
  return tar;
};
