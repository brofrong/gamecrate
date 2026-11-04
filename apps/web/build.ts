// Продакшн-сборка SPA: `src/index.html` → `dist/` (index.html + хэшированные ассеты)
// и картинки своих игр `games/<slug>/site/*.jpg` → `dist/own-games/<appId>/`.
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { OWN_ASSET_FILE, ownGameSiteDirs } from "./scripts/ownGameAssets";

const outdir = new URL("./dist", import.meta.url).pathname;
await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [new URL("./src/index.html", import.meta.url).pathname],
  outdir,
  minify: true,
  // Абсолютные пути ассетов: index.html отдаётся и на /library, /admin (SPA fallback api).
  publicPath: "/",
  plugins: [tailwind],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const output of result.outputs) {
  console.log(
    `${output.path.replace(`${outdir}/`, "dist/")}  ${(output.size / 1024).toFixed(1)} KB`,
  );
}

for (const [appId, siteDir] of ownGameSiteDirs()) {
  const target = join(outdir, "own-games", String(appId));
  await mkdir(target, { recursive: true });
  const files = (await readdir(siteDir, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && OWN_ASSET_FILE.test(entry.name),
  );
  for (const file of files) {
    await copyFile(join(siteDir, file.name), join(target, file.name));
  }
  console.log(`dist/own-games/${appId}/  ${files.length} файлов`);
}
