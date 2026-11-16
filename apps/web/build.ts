// Продакшн-сборка SPA: `src/index.html` → `dist/` (index.html + хэшированные ассеты)
// и картинки своих игр `games/<slug>/site/*.jpg` → `dist/own-games/<appId>/`,
// и файлы витрин `src/brands/<id>/public/*` → `dist/brands/<id>/` (favicon и т. п.).
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { BRAND_IDS } from "@cg/brands";
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

for (const id of BRAND_IDS) {
  const publicDir = new URL(`./src/brands/${id}/public`, import.meta.url)
    .pathname;
  if (!existsSync(publicDir)) continue;
  const target = join(outdir, "brands", id);
  await mkdir(target, { recursive: true });
  const files = (await readdir(publicDir, { withFileTypes: true })).filter(
    (entry) => entry.isFile(),
  );
  for (const file of files) {
    await copyFile(join(publicDir, file.name), join(target, file.name));
  }
  console.log(`dist/brands/${id}/  ${files.length} файлов`);
}
