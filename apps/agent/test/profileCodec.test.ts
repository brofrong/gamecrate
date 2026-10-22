import { describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import {
  extractSingleFile,
  importProfileKey,
  openProfile,
  PROFILE_MAGIC,
  ProfileCorrupt,
  ProfileKeyInvalid,
  sealProfile,
} from "../src/profile/codec";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const runError = <A, E>(effect: Effect.Effect<A, E>) =>
  run(Effect.flip(effect));

/** base64 случайного ключа заданной длины (по умолчанию — 32 байта, валидный). */
const randomKeyBase64 = (length = 32) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(length))).toString(
    "base64",
  );

describe("importProfileKey", () => {
  it("rejects a 31-byte key", async () => {
    const error = await runError(
      importProfileKey(Redacted.make(randomKeyBase64(31))),
    );
    expect(error).toBeInstanceOf(ProfileKeyInvalid);
  });

  it("accepts an exact 32-byte key", async () => {
    const key = await run(importProfileKey(Redacted.make(randomKeyBase64(32))));
    expect(key).toBeDefined();
  });
});

describe("seal/open", () => {
  it("round-trips and starts with CGP1", async () => {
    const key = await run(importProfileKey(Redacted.make(randomKeyBase64())));
    const tar = crypto.getRandomValues(new Uint8Array(4096));
    const sealed = await run(sealProfile(tar, key));
    expect(new TextDecoder().decode(sealed.subarray(0, 4))).toBe(PROFILE_MAGIC);
    const opened = await run(openProfile(sealed, key));
    expect(opened).toEqual(tar);
  });

  it("open fails with ProfileCorrupt on a flipped ciphertext byte", async () => {
    const key = await run(importProfileKey(Redacted.make(randomKeyBase64())));
    const tar = new TextEncoder().encode("hello profile");
    const sealed = await run(sealProfile(tar, key));
    const tampered = new Uint8Array(sealed);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    const error = await runError(openProfile(tampered, key));
    expect(error).toBeInstanceOf(ProfileCorrupt);
  });

  it("open fails with ProfileCorrupt on the wrong key", async () => {
    const key = await run(importProfileKey(Redacted.make(randomKeyBase64())));
    const otherKey = await run(
      importProfileKey(Redacted.make(randomKeyBase64())),
    );
    const sealed = await run(
      sealProfile(new TextEncoder().encode("hello"), key),
    );
    const error = await runError(openProfile(sealed, otherKey));
    expect(error).toBeInstanceOf(ProfileCorrupt);
  });
});

describe("extractSingleFile", () => {
  it("returns the payload of a one-entry ustar tar", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-agent-profile-"));
    try {
      const payload = crypto.getRandomValues(new Uint8Array(1500));
      writeFileSync(join(dir, "payload.bin"), payload);
      const tarPath = join(dir, "out.tar");
      const result = Bun.spawnSync([
        "tar",
        "--format",
        "ustar",
        "-cf",
        tarPath,
        "-C",
        dir,
        "payload.bin",
      ]);
      if (result.exitCode !== 0)
        throw new Error(
          `tar failed: ${new TextDecoder().decode(result.stderr)}`,
        );
      const tarBytes = new Uint8Array(readFileSync(tarPath));
      expect(extractSingleFile(tarBytes)).toEqual(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
