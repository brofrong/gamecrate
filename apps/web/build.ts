// Продакшн-сборка SPA: `src/index.html` → `dist/` (index.html + хэшированные ассеты).
import { rm } from "node:fs/promises";
import tailwind from "bun-plugin-tailwind";

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
