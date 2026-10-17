// Клиент ProtonDB: тир совместимости игры. Никогда не падает — неизвестность это "pending".
import { ProtonTier } from "@cg/rpc";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

const ProtonSummary = Schema.Struct({
  tier: Schema.optional(Schema.Unknown),
});

const isProtonTier = Schema.is(ProtonTier);

export class ProtonDb extends Context.Service<
  ProtonDb,
  {
    /** Тир совместимости; 404, неизвестный тир, сеть или таймаут (5 с) → `"pending"`. */
    readonly fetchTier: (appId: number) => Effect.Effect<ProtonTier>;
  }
>()("@cg/api/ProtonDb") {
  static readonly layer: Layer.Layer<ProtonDb, never, HttpClient.HttpClient> =
    Layer.effect(
      ProtonDb,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;

        const fetchTier = (appId: number) =>
          client
            .get(
              `https://www.protondb.com/api/v1/reports/summaries/${appId}.json`,
            )
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap(HttpClientResponse.schemaBodyJson(ProtonSummary)),
              Effect.map((summary) =>
                isProtonTier(summary.tier) ? summary.tier : "pending",
              ),
              Effect.catch(() => Effect.succeed("pending" as const)),
              Effect.timeoutOption("5 seconds"),
              Effect.map(Option.getOrElse(() => "pending" as const)),
            );

        return ProtonDb.of({ fetchTier });
      }),
    );
}
