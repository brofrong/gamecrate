import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { ProtonDb } from "../src/steam/ProtonDb";

/** Фейковый `HttpClient`: `respond` строит ответ (или сетевую ошибку) на любой запрос. */
const fakeHttpClient = (
  respond: () => { status: number; body: unknown } | "network-error",
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const result = respond();
      if (result === "network-error")
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error("network down"),
            }),
          }),
        );
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(result.body), {
            status: result.status,
          }),
        ),
      );
    }),
  );

const run = (
  respond: () => { status: number; body: unknown } | "network-error",
) =>
  Effect.runPromise(
    ProtonDb.use((protonDb) => protonDb.fetchTier(1794680)).pipe(
      Effect.provide(ProtonDb.layer),
      Effect.provide(fakeHttpClient(respond)),
    ),
  );

describe("ProtonDb.fetchTier", () => {
  it("reads tier", async () => {
    const tier = await run(() => ({
      status: 200,
      body: { tier: "gold", total: 10, bestReportedTier: "gold" },
    }));
    expect(tier).toBe("gold");
  });

  it("maps 404 to pending", async () => {
    const tier = await run(() => ({ status: 404, body: {} }));
    expect(tier).toBe("pending");
  });

  it("maps network error to pending", async () => {
    const tier = await run(() => "network-error");
    expect(tier).toBe("pending");
  });

  it("maps unknown tier to pending", async () => {
    const tier = await run(() => ({ status: 200, body: { tier: "native" } }));
    expect(tier).toBe("pending");
  });
});
