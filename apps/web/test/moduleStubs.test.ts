// Заглушки `moduleStubs.ts` несут ровно те имена, что экспортируют настоящие модули:
// новый экспорт без заглушки снова уронил бы `--randomize` (см. комментарий там).
// Имена — из исходника: импорт настоящего `src/rpc.ts` открыл бы WebSocket.
import { describe, expect, it } from "bun:test";
import { authStub, rpcStub } from "./moduleStubs";

const exportedNames = async (path: string) =>
  [
    ...(await Bun.file(new URL(path, import.meta.url)).text()).matchAll(
      /^export (?:const|class|function) (\w+)/gm,
    ),
  ]
    .map(([, name]) => name ?? "")
    .sort();

describe("module stubs", () => {
  it("rpcStub has every export of src/rpc.ts", async () => {
    expect(Object.keys(rpcStub()).sort()).toEqual(
      await exportedNames("../src/rpc.ts"),
    );
  });

  it("authStub has every export of src/auth.ts", async () => {
    expect(Object.keys(authStub()).sort()).toEqual(
      await exportedNames("../src/auth.ts"),
    );
  });
});
