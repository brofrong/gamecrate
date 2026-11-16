import { describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import {
  extractSingleFile,
  filesTar,
  importProfileKey,
  openProfile,
  PROFILE_MAGIC,
  ProfileCorrupt,
  ProfileKeyInvalid,
  sealProfile,
  singleFileTar,
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
  it("returns the payload of a one-entry ustar tar", async () => {
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
      expect(await run(extractSingleFile(tarBytes, "payload.bin"))).toEqual(
        payload,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const options = { uid: 1000, gid: 1000, mode: 0o644, mtime: 0 };
  const payload = new TextEncoder().encode("profile");

  it("accepts a regular file whose name ends with the expected one (typeflag '0' or NUL)", async () => {
    const tar = singleFileTar("tmp/cg-profile.tar", payload, options);
    expect(await run(extractSingleFile(tar, "cg-profile.tar"))).toEqual(
      payload,
    );
    tar[156] = 0;
    expect(await run(extractSingleFile(tar, "cg-profile.tar"))).toEqual(
      payload,
    );
  });

  it("rejects an entry that is not a regular file", async () => {
    const tar = singleFileTar("cg-profile.tar", payload, options);
    // '5' — каталог, '2' — символическая ссылка.
    for (const flag of ["5", "2"]) {
      tar[156] = flag.charCodeAt(0);
      const error = await runError(extractSingleFile(tar, "cg-profile.tar"));
      expect(error).toBeInstanceOf(ProfileCorrupt);
      expect(error.reason).toContain("typeflag");
    }
  });

  it("rejects an entry with another name", async () => {
    const tar = singleFileTar("cg-profile.tar.partial", payload, options);
    const error = await runError(extractSingleFile(tar, "cg-profile.tar"));
    expect(error).toBeInstanceOf(ProfileCorrupt);
    expect(error.reason).toContain("cg-profile.tar.partial");
    const other = singleFileTar("evil-cg-profile.tar", payload, options);
    expect(
      (await runError(extractSingleFile(other, "cg-profile.tar"))).reason,
    ).toContain("evil-cg-profile.tar");
  });

  it("rejects a truncated archive", async () => {
    const tar = singleFileTar("cg-profile.tar", payload, options);
    const error = await runError(
      extractSingleFile(tar.subarray(0, 512 + 3), "cg-profile.tar"),
    );
    expect(error).toBeInstanceOf(ProfileCorrupt);
    expect(
      (await runError(extractSingleFile(new Uint8Array(100), "cg-profile.tar")))
        ._tag,
    ).toBe("ProfileCorrupt");
  });
});

describe("singleFileTar", () => {
  it("is a valid ustar archive with the given owner, mode and content", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-single-tar-"));
    try {
      const data = new TextEncoder().encode("x".repeat(700));
      const tarPath = join(dir, "one.tar");
      writeFileSync(
        tarPath,
        singleFileTar("appmanifest_736260.acf", data, {
          uid: 1000,
          gid: 1000,
          mode: 0o644,
          mtime: 1_760_000_000,
        }),
      );
      // Системный tar проверяет контрольную сумму заголовка.
      const list = Bun.spawnSync(["tar", "-tvf", tarPath, "--numeric-owner"]);
      expect(new TextDecoder().decode(list.stderr)).toBe("");
      expect(list.exitCode).toBe(0);
      const line = new TextDecoder().decode(list.stdout).trim();
      expect(line).toStartWith("-rw-r--r--");
      expect(line).toMatch(/\b1000[\s/]+1000\b/);
      expect(line).toEndWith("appmanifest_736260.acf");
      const extract = Bun.spawnSync(["tar", "-xf", tarPath, "-C", dir]);
      expect(extract.exitCode).toBe(0);
      expect(readFileSync(join(dir, "appmanifest_736260.acf"), "utf8")).toBe(
        "x".repeat(700),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses names a ustar header cannot hold", () => {
    const options = { uid: 1000, gid: 1000, mode: 0o644, mtime: 0 };
    expect(() =>
      singleFileTar("x".repeat(101), new Uint8Array(), options),
    ).toThrow();
    expect(() => singleFileTar("файл", new Uint8Array(), options)).toThrow();
  });
});

describe("filesTar", () => {
  it("writes directories and files", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-files-tar-"));
    try {
      const tarPath = join(dir, "many.tar");
      writeFileSync(
        tarPath,
        filesTar(
          [
            { path: "a", mode: 0o755 },
            { path: "a/b", data: new TextEncoder().encode("hi"), mode: 0o644 },
          ],
          { uid: 1000, gid: 1000, mtime: 1_760_000_000 },
        ),
      );
      const list = Bun.spawnSync(["tar", "-tvf", tarPath, "--numeric-owner"]);
      expect(new TextDecoder().decode(list.stderr)).toBe("");
      expect(list.exitCode).toBe(0);
      const lines = new TextDecoder().decode(list.stdout).trim().split("\n");
      const dirLine = lines.find((line) => line.endsWith("a/"));
      const fileLine = lines.find((line) => line.endsWith("a/b"));
      expect(dirLine).toBeDefined();
      expect(dirLine).toStartWith("d");
      expect(fileLine).toBeDefined();
      expect(fileLine).toStartWith("-");
      expect(fileLine).toMatch(/\b1000[\s/]+1000\b/);
      const extract = Bun.spawnSync(["tar", "-xf", tarPath, "-C", dir]);
      expect(extract.exitCode).toBe(0);
      expect(readFileSync(join(dir, "a", "b"), "utf8")).toBe("hi");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
