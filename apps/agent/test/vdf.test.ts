import { describe, expect, it } from "bun:test";
import { formatVdf, getPath, parseVdf, setPath } from "../src/steam/vdf";

/** Фикстура `config.vdf`: вложенные блоки, ключи в разном регистре (как у настоящего Steam). */
const configFixture = [
  '"InstallConfigStore"',
  "{",
  '\t"Software"',
  "\t{",
  '\t\t"valve"',
  "\t\t{",
  '\t\t\t"Steam"',
  "\t\t\t{",
  '\t\t\t\t"Accounts"',
  "\t\t\t\t{",
  '\t\t\t\t\t"someuser"',
  "\t\t\t\t\t{",
  '\t\t\t\t\t\t"SteamID"\t\t"76561198000000000"',
  "\t\t\t\t\t}",
  "\t\t\t\t}",
  '\t\t\t\t"AutoUpdateWindowEnabled"\t\t"1"',
  "\t\t\t}",
  "\t\t}",
  "\t}",
  "}",
  "",
].join("\n");

describe("parseVdf/formatVdf", () => {
  it("formatVdf(parseVdf(x)) keeps structure", () => {
    const nodes = parseVdf(configFixture);
    expect(nodes).toBeDefined();
    const formatted = formatVdf(nodes ?? []);
    const reparsed = parseVdf(formatted);
    expect(reparsed).toEqual(nodes);
    expect(
      getPath(reparsed, [
        "InstallConfigStore",
        "Software",
        "valve",
        "Steam",
        "Accounts",
        "someuser",
        "SteamID",
      ]),
    ).toBe("76561198000000000");
  });

  it("parseVdf rejects garbage", () => {
    expect(parseVdf("")).toEqual([]);
    expect(parseVdf("hello world")).toBeUndefined();
    expect(parseVdf('"a"\n{\n')).toBeUndefined();
    expect(parseVdf('"a"\n{\n}\n}\n')).toBeUndefined();
    expect(parseVdf('"a" "b" "c"')).toBeUndefined();
  });
});

describe("getPath/setPath", () => {
  it("getPath is case-insensitive and missing paths are undefined", () => {
    const nodes = parseVdf(configFixture) ?? [];
    expect(
      getPath(nodes, ["installconfigstore", "SOFTWARE", "VALVE", "steam"]),
    ).toBeDefined();
    expect(getPath(nodes, ["InstallConfigStore", "Nope"])).toBeUndefined();
  });

  it("setPath creates missing keys and preserves existing casing", () => {
    const nodes = parseVdf(configFixture) ?? [];
    const updated = setPath(
      nodes,
      ["InstallConfigStore", "Software", "valve", "Steam", "Accounts", "new", "SteamID"],
      "1",
    );
    // существующий путь ("valve" строчными) сохранил регистр.
    expect(
      getPath(updated, [
        "InstallConfigStore",
        "Software",
        "valve",
        "Steam",
        "Accounts",
        "new",
        "SteamID",
      ]),
    ).toBe("1");
    const software = getPath(updated, ["InstallConfigStore", "Software"]);
    expect(Array.isArray(software)).toBe(true);
    const valveNode = (software as ReadonlyArray<{ key: string }>).find(
      (node) => node.key.toLowerCase() === "valve",
    );
    expect(valveNode?.key).toBe("valve");
    // старое значение осталось на месте.
    expect(
      getPath(updated, [
        "InstallConfigStore",
        "Software",
        "valve",
        "Steam",
        "Accounts",
        "someuser",
        "SteamID",
      ]),
    ).toBe("76561198000000000");
  });

  it("setPath on an empty tree creates the full chain", () => {
    const updated = setPath([], ["A", "B", "C"], "x");
    expect(getPath(updated, ["A", "B", "C"])).toBe("x");
    expect(formatVdf(updated)).toContain('"x"');
  });
});
