import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Effect, Redacted } from "effect";
import { importProfileKey } from "../src/profile/codec";
import {
  ProfileStore,
  ProfileStoreError,
  type ProfileStoreShape,
} from "../src/profile/ProfileStore";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const runError = <A, E>(effect: Effect.Effect<A, E>) =>
  run(Effect.flip(effect));

const bucket = "cg-profiles-test";

/** Фейковый S3: хранит тела PUT по пути, отдаёт их на GET, удаляет на DELETE. Подписи не проверяет. */
const makeFakeS3 = () => {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const prefix = `/${bucket}/`;
      if (!url.pathname.startsWith(prefix))
        return new Response(null, { status: 404 });
      const key = url.pathname.slice(prefix.length);
      if (request.method === "PUT") {
        const bytes = new Uint8Array(await request.arrayBuffer());
        objects.set(key, bytes);
        return new Response(null, { status: 200 });
      }
      if (request.method === "GET") {
        const bytes = objects.get(key);
        if (!bytes) return new Response(null, { status: 404 });
        return new Response(bytes, { status: 200 });
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      if (request.method === "HEAD") {
        const bytes = objects.get(key);
        if (!bytes) return new Response(null, { status: 404 });
        return new Response(null, {
          status: 200,
          headers: { "content-length": String(bytes.length) },
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  return { server, objects };
};

let fake: ReturnType<typeof makeFakeS3>;
let store: ProfileStoreShape;

beforeAll(async () => {
  fake = makeFakeS3();
  const profileKey = await run(
    importProfileKey(
      Redacted.make(
        Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
          "base64",
        ),
      ),
    ),
  );
  store = ProfileStore.make({
    endpoint: `http://127.0.0.1:${fake.server.port}`,
    bucket,
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    profileKey,
  });
});

afterAll(() => {
  fake.server.stop(true);
});

describe("ProfileStore", () => {
  it("put uses profiles/<userId>/<uuid>.cgp and get returns the original tar", async () => {
    const tar = crypto.getRandomValues(new Uint8Array(2048));
    const { objectKey, sizeBytes } = await run(store.put("u1", tar));
    expect(objectKey).toMatch(/^profiles\/u1\/[0-9a-f-]{36}\.cgp$/);
    expect(sizeBytes).toBe(fake.objects.get(objectKey)?.length ?? -1);
    expect(sizeBytes).toBeGreaterThan(tar.length);

    const restored = await run(store.get(objectKey));
    expect(restored).toEqual(tar);
  });

  it("remove deletes the object so a later get fails", async () => {
    const tar = new TextEncoder().encode("profile data");
    const { objectKey } = await run(store.put("u2", tar));
    await run(store.remove(objectKey));
    const error = await runError(store.get(objectKey));
    expect(error).toBeInstanceOf(ProfileStoreError);
  });
});
