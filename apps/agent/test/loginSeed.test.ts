import { describe, expect, it } from "bun:test";
import { crc32 } from "node:zlib";
import { getPath, parseVdf } from "../src/steam/vdf";
import {
  applyLoginSeed,
  clearLogin,
  connectCacheKey,
  decryptConnectCache,
  encryptConnectCache,
  LOGIN_FILES,
} from "../src/steam/loginSeed";

describe("connectCacheKey", () => {
  it("drops leading zeros", () => {
    // Перебор коротких строк, пока CRC-32 не окажется < 0x10000000 (тогда
    // toString(16) без паддинга даёт 7 hex-символов, а не 8).
    let found: string | undefined;
    for (let i = 0; i < 100_000 && found === undefined; i++) {
      const name = String(i);
      if (crc32(name) < 0x10000000) found = name;
    }
    expect(found).toBeDefined();
    const name = found as string;
    const expected = `${crc32(name).toString(16)}1`;
    expect(expected.length).toBe(8);
    expect(connectCacheKey(name)).toBe(expected);
  });

  it("matches CRC-32 for an ordinary name", () => {
    const name = "builder@example.com";
    expect(connectCacheKey(name)).toBe(`${crc32(name).toString(16)}1`);
  });
});

describe("encryptConnectCache/decryptConnectCache", () => {
  it("round-trips", () => {
    const accountName = "builder@example.com";
    const token = "t".repeat(498);
    const hex = encryptConnectCache(accountName, token);
    expect(hex.length).toBe((16 + 512) * 2);
    expect(decryptConnectCache(accountName, hex)).toBe(token);
  });

  it("two calls with different IVs give different hex", () => {
    const accountName = "builder@example.com";
    const token = "a-refresh-token";
    const a = encryptConnectCache(accountName, token);
    const b = encryptConnectCache(accountName, token);
    expect(a).not.toBe(b);
    expect(decryptConnectCache(accountName, a)).toBe(token);
    expect(decryptConnectCache(accountName, b)).toBe(token);
  });

  it("accepts an explicit IV for deterministic tests", () => {
    const accountName = "builder@example.com";
    const token = "a-refresh-token";
    const iv = new Uint8Array(16).fill(7);
    const a = encryptConnectCache(accountName, token, iv);
    const b = encryptConnectCache(accountName, token, iv);
    expect(a).toBe(b);
  });
});

const seed = {
  accountName: "builder@example.com",
  steamId: "76561198000000001",
  token: "fresh-token",
};

describe("applyLoginSeed", () => {
  it("builds all four files from nothing", () => {
    const files = applyLoginSeed({}, seed, 1_760_000_000);

    const local = parseVdf(files.localVdf);
    expect(local).toBeDefined();
    const key = connectCacheKey(seed.accountName);
    const hex = getPath(local, [
      "MachineUserConfigStore",
      "Software",
      "Valve",
      "Steam",
      "ConnectCache",
      key,
    ]);
    expect(typeof hex).toBe("string");
    expect(decryptConnectCache(seed.accountName, hex as string)).toBe(
      seed.token,
    );

    const loginUsers = parseVdf(files.loginUsers);
    expect(loginUsers).toBeDefined();
    expect(getPath(loginUsers, ["users", seed.steamId, "AccountName"])).toBe(
      seed.accountName,
    );
    expect(getPath(loginUsers, ["users", seed.steamId, "PersonaName"])).toBe(
      seed.accountName,
    );
    expect(
      getPath(loginUsers, ["users", seed.steamId, "RememberPassword"]),
    ).toBe("1");
    expect(
      getPath(loginUsers, ["users", seed.steamId, "WantsOfflineMode"]),
    ).toBe("0");
    expect(
      getPath(loginUsers, ["users", seed.steamId, "SkipOfflineModeWarning"]),
    ).toBe("0");
    expect(getPath(loginUsers, ["users", seed.steamId, "AutoLogin"])).toBe("1");
    expect(getPath(loginUsers, ["users", seed.steamId, "MostRecent"])).toBe(
      "1",
    );
    expect(getPath(loginUsers, ["users", seed.steamId, "timestamp"])).toBe(
      "1760000000",
    );

    const config = parseVdf(files.config);
    expect(
      getPath(config, [
        "InstallConfigStore",
        "Software",
        "Valve",
        "Steam",
        "Accounts",
        seed.accountName,
        "SteamID",
      ]),
    ).toBe(seed.steamId);

    const registry = parseVdf(files.registry);
    expect(
      getPath(registry, [
        "Registry",
        "HKCU",
        "Software",
        "Valve",
        "Steam",
        "AutoLoginUser",
      ]),
    ).toBe(seed.accountName);
    expect(
      getPath(registry, [
        "Registry",
        "HKCU",
        "Software",
        "Valve",
        "Steam",
        "RememberPassword",
      ]),
    ).toBe("1");
  });

  it("switches autologin to the new account and keeps others", () => {
    const otherId = "76561198000000002";
    const otherKey = connectCacheKey("other@example.com");
    const otherHex = encryptConnectCache("other@example.com", "other-token");
    const current = {
      loginUsers: [
        '"users"',
        "{",
        `\t"${otherId}"`,
        "\t{",
        '\t\t"AccountName"\t\t"other@example.com"',
        '\t\t"PersonaName"\t\t"Other"',
        '\t\t"RememberPassword"\t\t"1"',
        '\t\t"WantsOfflineMode"\t\t"0"',
        '\t\t"SkipOfflineModeWarning"\t\t"0"',
        '\t\t"AutoLogin"\t\t"1"',
        '\t\t"MostRecent"\t\t"1"',
        '\t\t"timestamp"\t\t"1700000000"',
        "\t}",
        "}",
        "",
      ].join("\n"),
      localVdf: [
        '"MachineUserConfigStore"',
        "{",
        '\t"software"',
        "\t{",
        '\t\t"valve"',
        "\t\t{",
        '\t\t\t"steam"',
        "\t\t\t{",
        '\t\t\t\t"ConnectCache"',
        "\t\t\t\t{",
        `\t\t\t\t\t"${otherKey}"\t\t"${otherHex}"`,
        "\t\t\t\t}",
        "\t\t\t}",
        "\t\t}",
        "\t}",
        "}",
        "",
      ].join("\n"),
    };

    const files = applyLoginSeed(current, seed, 1_760_000_100);

    // Чужая запись ConnectCache осталась на месте и расшифровывается как раньше.
    const local = parseVdf(files.localVdf);
    const otherEntry = getPath(local, [
      "MachineUserConfigStore",
      "software",
      "valve",
      "steam",
      "ConnectCache",
      otherKey,
    ]);
    expect(otherEntry).toBe(otherHex);
    expect(decryptConnectCache("other@example.com", otherEntry as string)).toBe(
      "other-token",
    );
    const newKey = connectCacheKey(seed.accountName);
    const newEntry = getPath(local, [
      "MachineUserConfigStore",
      "software",
      "valve",
      "steam",
      "ConnectCache",
      newKey,
    ]);
    expect(decryptConnectCache(seed.accountName, newEntry as string)).toBe(
      seed.token,
    );

    const loginUsers = parseVdf(files.loginUsers);
    expect(getPath(loginUsers, ["users", otherId, "MostRecent"])).toBe("0");
    expect(getPath(loginUsers, ["users", otherId, "AutoLogin"])).toBe("0");
    expect(getPath(loginUsers, ["users", otherId, "AccountName"])).toBe(
      "other@example.com",
    );
    expect(getPath(loginUsers, ["users", seed.steamId, "MostRecent"])).toBe(
      "1",
    );
    expect(getPath(loginUsers, ["users", seed.steamId, "AutoLogin"])).toBe("1");

    const registry = parseVdf(files.registry);
    expect(
      getPath(registry, [
        "Registry",
        "HKCU",
        "Software",
        "Valve",
        "Steam",
        "AutoLoginUser",
      ]),
    ).toBe(seed.accountName);
  });

  it("replaces the token of the same account", () => {
    const first = applyLoginSeed({}, seed, 1_760_000_000);
    const second = applyLoginSeed(
      { localVdf: first.localVdf },
      { ...seed, token: "another-token" },
      1_760_000_200,
    );
    const local = parseVdf(second.localVdf);
    const key = connectCacheKey(seed.accountName);
    const cache = getPath(local, [
      "MachineUserConfigStore",
      "Software",
      "Valve",
      "Steam",
      "ConnectCache",
    ]);
    expect(Array.isArray(cache)).toBe(true);
    expect((cache as ReadonlyArray<unknown>).length).toBe(1);
    const hex = getPath(local, [
      "MachineUserConfigStore",
      "Software",
      "Valve",
      "Steam",
      "ConnectCache",
      key,
    ]);
    expect(decryptConnectCache(seed.accountName, hex as string)).toBe(
      "another-token",
    );
  });

  it("falls back to creating from scratch when a file is unreadable", () => {
    const files = applyLoginSeed(
      { loginUsers: "garbage" },
      seed,
      1_760_000_000,
    );
    const loginUsers = parseVdf(files.loginUsers);
    expect(loginUsers).toBeDefined();
    expect(getPath(loginUsers, ["users", seed.steamId, "AccountName"])).toBe(
      seed.accountName,
    );
  });
});

describe("clearLogin", () => {
  it("removes a seeded login", () => {
    const seeded = applyLoginSeed({}, seed, 1_760_000_000);
    const cleared = clearLogin(seeded);

    const local = parseVdf(cleared.localVdf ?? "");
    expect(
      getPath(local, [
        "MachineUserConfigStore",
        "Software",
        "Valve",
        "Steam",
        "ConnectCache",
        connectCacheKey(seed.accountName),
      ]),
    ).toBeUndefined();

    const loginUsers = parseVdf(cleared.loginUsers ?? "");
    expect(getPath(loginUsers, ["users", seed.steamId])).toBeUndefined();

    const config = parseVdf(cleared.config ?? "");
    expect(
      getPath(config, [
        "InstallConfigStore",
        "Software",
        "Valve",
        "Steam",
        "Accounts",
        seed.accountName,
      ]),
    ).toBeUndefined();

    expect(cleared.registry).toContain('"AutoLoginUser"\t\t""');
    expect(cleared.registry).toContain('"RememberPassword"\t\t"0"');
    const registry = parseVdf(cleared.registry ?? "");
    expect(
      getPath(registry, [
        "Registry",
        "HKCU",
        "Software",
        "Valve",
        "Steam",
        "AutoLoginUser",
      ]),
    ).toBe("");
    expect(
      getPath(registry, [
        "Registry",
        "HKCU",
        "Software",
        "Valve",
        "Steam",
        "RememberPassword",
      ]),
    ).toBe("0");

    for (const text of Object.values(cleared))
      expect(text).not.toContain(seed.accountName);
  });

  it("keeps unrelated keys", () => {
    const config = [
      '"InstallConfigStore"',
      "{",
      '\t"Software"',
      "\t{",
      '\t\t"Valve"',
      "\t\t{",
      '\t\t\t"Steam"',
      "\t\t\t{",
      '\t\t\t\t"CompatToolMapping"',
      "\t\t\t\t{",
      '\t\t\t\t\t"440"\t\t"proton_7"',
      "\t\t\t\t}",
      '\t\t\t\t"Accounts"',
      "\t\t\t\t{",
      `\t\t\t\t\t"${seed.accountName}"`,
      "\t\t\t\t\t{",
      `\t\t\t\t\t\t"SteamID"\t\t"${seed.steamId}"`,
      "\t\t\t\t\t}",
      "\t\t\t\t}",
      "\t\t\t}",
      "\t\t}",
      "\t}",
      "}",
      "",
    ].join("\n");

    const cleared = clearLogin({ config });
    const nodes = parseVdf(cleared.config ?? "");
    expect(
      getPath(nodes, [
        "InstallConfigStore",
        "Software",
        "Valve",
        "Steam",
        "CompatToolMapping",
        "440",
      ]),
    ).toBe("proton_7");
    expect(
      getPath(nodes, [
        "InstallConfigStore",
        "Software",
        "Valve",
        "Steam",
        "Accounts",
        seed.accountName,
      ]),
    ).toBeUndefined();
  });

  it("missing files are absent from the result", () => {
    expect(clearLogin({})).toEqual({});
  });

  it("unreadable localVdf, loginUsers and registry are rebuilt from an empty tree", () => {
    // Наш парсер строже клиента Steam (не понимает условия вида `[$WIN32]` и
    // неэкранированные токены) — файл, который мы не смогли разобрать, может
    // всё равно хранить токен. Пересобираем его с нуля, а не оставляем как был.
    const cleared = clearLogin({
      localVdf: "garbage {",
      loginUsers: "garbage {",
      registry: "garbage {",
    });
    expect(Object.keys(cleared).sort()).toEqual(
      ["localVdf", "loginUsers", "registry"].sort(),
    );

    const local = parseVdf(cleared.localVdf ?? "");
    expect(
      getPath(local, [
        "MachineUserConfigStore",
        "Software",
        "Valve",
        "Steam",
        "ConnectCache",
      ]),
    ).toEqual([]);

    const loginUsers = parseVdf(cleared.loginUsers ?? "");
    expect(getPath(loginUsers, ["users"])).toEqual([]);

    const registry = parseVdf(cleared.registry ?? "");
    expect(
      getPath(registry, [
        "Registry",
        "HKCU",
        "Software",
        "Valve",
        "Steam",
        "AutoLoginUser",
      ]),
    ).toBe("");
    expect(
      getPath(registry, [
        "Registry",
        "HKCU",
        "Software",
        "Valve",
        "Steam",
        "RememberPassword",
      ]),
    ).toBe("0");
  });

  it("unreadable config is absent from the result (holds no token, left untouched by the caller)", () => {
    expect(clearLogin({ config: "garbage {" })).toEqual({});
  });
});

describe("LOGIN_FILES", () => {
  it("has the four expected paths", () => {
    expect(LOGIN_FILES).toEqual({
      localVdf: ".local/share/Steam/local.vdf",
      loginUsers: ".local/share/Steam/config/loginusers.vdf",
      config: ".local/share/Steam/config/config.vdf",
      registry: ".steam/registry.vdf",
    });
  });
});
