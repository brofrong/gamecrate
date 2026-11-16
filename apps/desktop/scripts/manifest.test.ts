// Манифест автообновления (`latest.json`, формат updater Tauri v2): сборка из списка файлов,
// поиск файлов обновления среди артефактов CI и CLI, которым пользуется джоб публикации.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManifest,
  findInstallers,
  findUpdaterFiles,
  type ManifestFile,
} from "./manifest";

const base = {
  version: "0.1.0",
  notes: "Первая версия",
  pubDate: "2026-11-16T12:00:00.000Z",
  baseUrl: "https://game.brofrong.ru/download/desktop",
};

const files: ManifestFile[] = [
  {
    platform: "darwin-universal",
    file: "GameCrate_universal.app.tar.gz",
    signature: "sig-mac",
  },
  {
    platform: "windows-x86_64",
    file: "GameCrate_0.1.0_x64-setup.exe",
    signature: "sig-win",
  },
  {
    platform: "linux-x86_64",
    file: "GameCrate_0.1.0_amd64.AppImage",
    signature: "sig-linux",
  },
];

describe("buildManifest", () => {
  test("три платформы дают четыре ключа updater, подписи на месте", () => {
    const manifest = buildManifest({ ...base, files });
    expect(Object.keys(manifest.platforms).sort()).toEqual([
      "darwin-aarch64",
      "darwin-x86_64",
      "linux-x86_64",
      "windows-x86_64",
    ]);
    expect(manifest.platforms["windows-x86_64"]).toEqual({
      signature: "sig-win",
      url: "https://game.brofrong.ru/download/desktop/0.1.0/GameCrate_0.1.0_x64-setup.exe",
    });
    expect(manifest.platforms["linux-x86_64"]?.signature).toBe("sig-linux");
  });

  test("обе архитектуры macOS указывают на один универсальный архив", () => {
    const { platforms } = buildManifest({ ...base, files });
    const arm = platforms["darwin-aarch64"];
    const intel = platforms["darwin-x86_64"];
    expect(arm).toEqual(intel);
    expect(arm?.url).toBe(
      "https://game.brofrong.ru/download/desktop/0.1.0/GameCrate_universal.app.tar.gz",
    );
    expect(arm?.signature).toBe("sig-mac");
  });

  test("версия, заметки и дата — поля updater; `/` в конце адреса не удваивается", () => {
    const manifest = buildManifest({
      ...base,
      baseUrl: `${base.baseUrl}/`,
      files,
    });
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.notes).toBe("Первая версия");
    expect(manifest.pub_date).toBe("2026-11-16T12:00:00.000Z");
    expect(manifest.platforms["windows-x86_64"]?.url).toBe(
      "https://game.brofrong.ru/download/desktop/0.1.0/GameCrate_0.1.0_x64-setup.exe",
    );
  });

  test("часть платформ — только они и попадают в манифест", () => {
    const manifest = buildManifest({ ...base, files: files.slice(0, 2) });
    expect(Object.keys(manifest.platforms).sort()).toEqual([
      "darwin-aarch64",
      "darwin-x86_64",
      "windows-x86_64",
    ]);
  });

  test("не принимает ни версию не из X.Y.Z, ни пустой список, ни повтор платформы, ни пустую подпись", () => {
    expect(() => buildManifest({ ...base, version: "1.0", files })).toThrow();
    expect(() => buildManifest({ ...base, version: "v1.0.0", files })).toThrow();
    expect(() => buildManifest({ ...base, files: [] })).toThrow();
    expect(() =>
      buildManifest({ ...base, files: [files[0]!, files[0]!] }),
    ).toThrow();
    expect(() =>
      buildManifest({
        ...base,
        files: [{ ...files[0]!, signature: "  " }],
      }),
    ).toThrow();
  });

  test("без установщиков поля downloads нет (манифест чисто для updater)", () => {
    expect("downloads" in buildManifest({ ...base, files })).toBe(false);
  });

  test("downloads — ссылки на установщики для страницы «Скачать» (updater их игнорирует)", () => {
    const manifest = buildManifest({
      ...base,
      files,
      installers: [
        { os: "macos", file: "GameCrate_0.1.0_universal.dmg", size: 1000 },
        { os: "windows", file: "GameCrate_0.1.0_x64-setup.exe" },
      ],
    });
    expect(manifest.downloads).toEqual({
      macos: {
        url: "https://game.brofrong.ru/download/desktop/0.1.0/GameCrate_0.1.0_universal.dmg",
        size: 1000,
      },
      windows: {
        url: "https://game.brofrong.ru/download/desktop/0.1.0/GameCrate_0.1.0_x64-setup.exe",
      },
    });
    // платформы updater при этом те же
    expect(Object.keys(manifest.platforms)).toHaveLength(4);
  });

  test("установщик с недопустимым именем или повтором ОС — ошибка", () => {
    expect(() =>
      buildManifest({
        ...base,
        files,
        installers: [{ os: "macos", file: "a b.dmg" }],
      }),
    ).toThrow();
    expect(() =>
      buildManifest({
        ...base,
        files,
        installers: [
          { os: "macos", file: "a.dmg" },
          { os: "macos", file: "b.dmg" },
        ],
      }),
    ).toThrow();
  });

  test("имя файла только из безопасных символов (его раздаёт API по тому же шаблону)", () => {
    expect(() =>
      buildManifest({
        ...base,
        files: [{ ...files[0]!, file: "Game Crate.app.tar.gz" }],
      }),
    ).toThrow();
    expect(() =>
      buildManifest({
        ...base,
        files: [{ ...files[0]!, file: "../a.tar.gz" }],
      }),
    ).toThrow();
  });
});

describe("findUpdaterFiles", () => {
  const names = [
    "gamecrate-macos/GameCrate_0.1.0_universal.dmg",
    "gamecrate-macos/GameCrate_universal.app.tar.gz",
    "gamecrate-macos/GameCrate_universal.app.tar.gz.sig",
    "gamecrate-windows/GameCrate_0.1.0_x64-setup.exe",
    "gamecrate-windows/GameCrate_0.1.0_x64-setup.exe.sig",
    "gamecrate-linux/GameCrate_0.1.0_amd64.AppImage",
    "gamecrate-linux/GameCrate_0.1.0_amd64.AppImage.sig",
    "gamecrate-linux/GameCrate_0.1.0_amd64.deb",
  ];

  test("берёт файл обновления каждой ОС и соответствующий `.sig`", () => {
    expect(findUpdaterFiles(names)).toEqual([
      {
        platform: "darwin-universal",
        path: "gamecrate-macos/GameCrate_universal.app.tar.gz",
        sigPath: "gamecrate-macos/GameCrate_universal.app.tar.gz.sig",
      },
      {
        platform: "windows-x86_64",
        path: "gamecrate-windows/GameCrate_0.1.0_x64-setup.exe",
        sigPath: "gamecrate-windows/GameCrate_0.1.0_x64-setup.exe.sig",
      },
      {
        platform: "linux-x86_64",
        path: "gamecrate-linux/GameCrate_0.1.0_amd64.AppImage",
        sigPath: "gamecrate-linux/GameCrate_0.1.0_amd64.AppImage.sig",
      },
    ]);
  });

  test("ограничение платформами пропускает остальные", () => {
    const found = findUpdaterFiles(names, ["windows-x86_64"]);
    expect(found.map((f) => f.platform)).toEqual(["windows-x86_64"]);
  });

  test("нет файла платформы, нет `.sig` или файлов несколько — ошибка", () => {
    expect(() =>
      findUpdaterFiles(names.filter((n) => !n.includes("windows"))),
    ).toThrow(/windows-x86_64/);
    expect(() =>
      findUpdaterFiles(names.filter((n) => !n.endsWith("-setup.exe.sig"))),
    ).toThrow(/sig/);
    expect(() =>
      findUpdaterFiles([...names, "other/Other_x64-setup.exe"]),
    ).toThrow(/windows-x86_64/);
  });
});

describe("findInstallers", () => {
  const names = [
    "mac/GameCrate_0.1.0_universal.dmg",
    "mac/GameCrate_universal.app.tar.gz",
    "win/GameCrate_0.1.0_x64-setup.exe",
    "linux/GameCrate_0.1.0_amd64.AppImage",
    "linux/GameCrate_0.1.0_amd64.deb",
  ];

  test("macOS — dmg, Windows и Linux — те же файлы, что у updater", () => {
    expect(findInstallers(names)).toEqual([
      { os: "macos", path: "mac/GameCrate_0.1.0_universal.dmg" },
      { os: "windows", path: "win/GameCrate_0.1.0_x64-setup.exe" },
      { os: "linux", path: "linux/GameCrate_0.1.0_amd64.AppImage" },
    ]);
  });

  test("нет установщика ОС — её просто нет в списке; несколько — ошибка", () => {
    expect(
      findInstallers(names.filter((n) => !n.endsWith(".dmg"))).map((i) => i.os),
    ).toEqual(["windows", "linux"]);
    expect(() => findInstallers([...names, "mac/Other.dmg"])).toThrow(/macos/);
  });
});

describe("CLI", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  const run = (args: string[]) =>
    Bun.spawn(["bun", join(import.meta.dir, "manifest.ts"), ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

  test("собирает latest.json из каталога артефактов", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cg-manifest-"));
    dirs.push(dir);
    const artifacts = join(dir, "artifacts");
    for (const [path, body] of [
      ["mac/GameCrate_universal.app.tar.gz", "tar"],
      ["mac/GameCrate_universal.app.tar.gz.sig", "sig-mac\n"],
      ["mac/GameCrate_0.1.0_universal.dmg", "dmg-body"],
      ["win/GameCrate_0.1.0_x64-setup.exe", "exe"],
      ["win/GameCrate_0.1.0_x64-setup.exe.sig", "sig-win\n"],
    ] as const) {
      await mkdir(join(artifacts, path, ".."), { recursive: true });
      await writeFile(join(artifacts, path), body);
    }
    const out = join(dir, "latest.json");
    const proc = run([
      "--tag",
      "desktop-v0.1.0",
      "--base-url",
      "https://game.brofrong.ru/download/desktop",
      "--dir",
      artifacts,
      "--out",
      out,
      "--platforms",
      "darwin-universal,windows-x86_64",
      "--notes",
      "Первая версия",
      "--pub-date",
      "2026-11-16T12:00:00.000Z",
    ]);
    expect(await proc.exited).toBe(0);
    const manifest = await Bun.file(out).json();
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.pub_date).toBe("2026-11-16T12:00:00.000Z");
    expect(manifest.platforms["darwin-aarch64"].signature).toBe("sig-mac");
    expect(manifest.platforms["windows-x86_64"].url).toBe(
      "https://game.brofrong.ru/download/desktop/0.1.0/GameCrate_0.1.0_x64-setup.exe",
    );
    expect(manifest.downloads.macos).toEqual({
      url: "https://game.brofrong.ru/download/desktop/0.1.0/GameCrate_0.1.0_universal.dmg",
      size: 8,
    });
    expect(manifest.downloads.windows.size).toBe(3);
    expect(manifest.downloads.linux).toBeUndefined();
    // в stdout — файлы к загрузке (путь в каталоге артефактов), по одному в строке
    const listed = (await new Response(proc.stdout).text())
      .trim()
      .split("\n")
      .sort();
    expect(listed).toEqual([
      "mac/GameCrate_0.1.0_universal.dmg",
      "mac/GameCrate_universal.app.tar.gz",
      "mac/GameCrate_universal.app.tar.gz.sig",
      "win/GameCrate_0.1.0_x64-setup.exe",
      "win/GameCrate_0.1.0_x64-setup.exe.sig",
    ]);
  });

  test("без обязательных аргументов — ненулевой код и пояснение в stderr", async () => {
    const proc = run(["--tag", "desktop-v0.1.0"]);
    expect(await proc.exited).not.toBe(0);
    expect(await new Response(proc.stderr).text()).toContain("--base-url");
  });
});
