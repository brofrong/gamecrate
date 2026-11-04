// Свои сборки (фанатские ПК-порты вне Steam): номера appId, пакет на воркере,
// описание манифеста игры и тексты страницы игры (спека 2026-11-03 «Свои игры»).
import { Schema } from "effect";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Начало диапазона appId своих игр (Global Constraints): всё, что `>=`, — не
 * Steam-приложение, а своя сборка из `own_games`. Верхняя граница — обычный
 * предел `Int32` (`AppId` везде кодируется как `Schema.Int`).
 */
export const OWN_APP_ID_MIN = 1_900_000_000;

/** appId этого диапазона — своя игра, а не Steam-приложение. */
export const isOwnAppId = (appId: number): boolean => appId >= OWN_APP_ID_MIN;

/**
 * Адрес картинки своей игры: `header.jpg`/`hero.jpg`/`cover.jpg` и скриншоты
 * из `site.screenshots` манифеста (Global Constraints — размеры и список
 * имён). Сайт отдаёт их статикой по этому пути, без похода к api.
 */
export const ownGameAssetUrl = (appId: number, file: string): string =>
  `/own-games/${appId}/${file}`;

/**
 * Имя своей игры в путях и метках контейнера: `^[a-z0-9][a-z0-9-]{0,31}$`.
 * Без `,`, `:` и пробела — они зарезервированы под bind-монтирование
 * (`источник:цель:ro`).
 */
export const OwnGameSlug = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,31}$/),
);
export type OwnGameSlug = typeof OwnGameSlug.Type;

/**
 * Версия пакета игры на воркере: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Как и
 * `OwnGameSlug`, без `,`, `:` и пробела — путь к пакету
 * (`<GAMES_DIR>/<slug>/<version>/`) идёт в bind-монтирование сессии.
 */
export const OwnGameVersion = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
);
export type OwnGameVersion = typeof OwnGameVersion.Type;

/**
 * Пакет своей игры, который нужно запустить: что (`slug`) и какая версия.
 * Кладётся в `WorkerStats.ownGames` (что есть на воркере) и
 * `StartSession.ownGame` (что запустить).
 */
export const OwnGamePackage = Schema.Struct({
  slug: OwnGameSlug,
  version: OwnGameVersion,
});
export type OwnGamePackage = typeof OwnGamePackage.Type;

/** Строка таблицы «Управление» на странице игры: действие и обе раскладки ввода. */
export const OwnGameControl = Schema.Struct({
  action: Schema.String,
  keyboard: Schema.String,
  gamepad: Schema.String,
});
export type OwnGameControl = typeof OwnGameControl.Type;

/** Ссылка на исходники фанатского порта («Фанатский ПК-порт» → upstream). */
export const OwnGameSource = Schema.Struct({
  label: Schema.String,
  url: Schema.String,
});
export type OwnGameSource = typeof OwnGameSource.Type;

/**
 * Манифест своей игры (файл в репозитории, один на игру): номер, пакет,
 * бинарник, upstream, доступные входы и тексты страницы игры. Это то, что
 * видит сборка/агент — скриншоты `site.screenshots` здесь ещё просто имена
 * файлов (`^[a-z0-9-]+\.jpg$`), а не адреса (их отдаёт `OwnGameInfo`).
 */
export const OwnGameManifest = Schema.Struct({
  /** appId своей игры — обязательно в диапазоне `OWN_APP_ID_MIN..Int32`. */
  appId: Schema.Int.check(
    Schema.isBetween({ minimum: OWN_APP_ID_MIN, maximum: 2147483647 }),
  ),
  slug: OwnGameSlug,
  name: Schema.String,
  version: OwnGameVersion,
  /** Имя исполняемого файла игры внутри пакета — без `/` (например, `soh.elf`). */
  binary: Schema.String.check(Schema.isPattern(/^[^/]+$/)),
  upstream: Schema.Struct({
    repo: Schema.String,
    ref: Schema.String,
  }),
  /**
   * Входные файлы сборки, не профили ввода: каждый `name` — обязательный
   * `deploy/add-game.sh --input <name>=<путь>`, сборщик видит его как
   * `/input/<name>` (у SoH — ROM, из него `build.sh` извлекает `oot.o2r`);
   * `label` — что передать. Сами файлы — ни в пакете, ни в git.
   */
  inputs: Schema.Array(
    Schema.Struct({ name: OwnGameSlug, label: Schema.String }),
  ),
  site: Schema.Struct({
    description: Schema.String,
    controls: Schema.Array(OwnGameControl),
    source: OwnGameSource,
    screenshots: Schema.Array(
      Schema.String.check(Schema.isPattern(/^[a-z0-9-]+\.jpg$/)),
    ),
  }),
  requirements: Schema.Struct({
    minVramBytes: NonNegativeInt,
    minRamBytes: NonNegativeInt,
    minCpuThreads: NonNegativeInt,
  }),
});
export type OwnGameManifest = typeof OwnGameManifest.Type;

/**
 * Описание своей игры на странице игры (`GameView.own`) — то же, что
 * `OwnGameManifest.site`, но `screenshots` здесь уже адреса (`ownGameAssetUrl`),
 * а не голые имена файлов.
 */
export const OwnGameInfo = Schema.Struct({
  description: Schema.String,
  controls: Schema.Array(OwnGameControl),
  source: OwnGameSource,
  screenshots: Schema.Array(Schema.String),
});
export type OwnGameInfo = typeof OwnGameInfo.Type;
