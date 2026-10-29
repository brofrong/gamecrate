// Ключ `SEED_KEY` для тестов (base64 ровно 32 байт) и слой `SteamLoginSeeds` на нём.
import type { AgentCommand } from "@cg/rpc";
import { Redacted } from "effect";
import { SteamLoginSeeds } from "../src/SteamLoginSeeds";

/** Тестовый `SEED_KEY`: 32 байта 0x01 в base64. */
export const testSeedKey = Redacted.make(
  Buffer.alloc(32, 1).toString("base64"),
);

/** `SteamLoginSeeds` на тестовом ключе; нужен `Db` (обычно `DbTest`). */
export const SteamLoginSeedsTest = SteamLoginSeeds.layerWith(testSeedKey);

/**
 * Refresh-токен входа, приложенного к команде (`null` — не приложен).
 * `toEqual` не различает значения `Redacted`, поэтому токен сверяется явно.
 */
export const sentToken = (command: AgentCommand | undefined) =>
  command !== undefined &&
  "steamLogin" in command &&
  command.steamLogin !== null
    ? Redacted.value(command.steamLogin.refreshToken)
    : null;
