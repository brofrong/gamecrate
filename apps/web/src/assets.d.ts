// Импорт файла-ассета (loader `file` у Bun) даёт его URL в бандле.
declare module "*.woff2" {
  const url: string;
  export default url;
}
