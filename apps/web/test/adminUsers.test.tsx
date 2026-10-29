// Вкладка «Пользователи» (`/admin?tab=users`, Task 4): таблица пользователей со способами
// входа, Steam, наигранным временем и профилем; поиск на клиенте; смена роли, блокировка и
// сброс входа Steam (подтверждение для блокировки и сброса); своя строка — действия неактивны.
//
// `../src/rpc` подменяется целиком (приём как в `adminGames.test.tsx`). `errorTag`/
// `resultErrorTag` — настоящая реализация (как в `adminSessions.test.tsx`), не заглушка
// «всегда `undefined`»: `mock.module` действует на весь прогон `bun test`, и файлы после
// этого по алфавиту (например, `landing.test.tsx`, `indexView`) получат именно этот мок —
// заглушка там тихо ломает ветку `Unauthorized` → «landing».
import { describe, expect, it, mock, spyOn } from "bun:test";
import type { AdminUser, CurrentUserShape } from "@cg/rpc";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Cause, Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { RegistryProvider } from "@effect/atom-react";
import { toast } from "sonner";

/** Элемент `initialValues` у `RegistryProvider` — без своего `any` в этом файле. */
type InitialValue =
  NonNullable<
    Parameters<typeof RegistryProvider>[0]["initialValues"]
  > extends Iterable<infer T>
    ? T
    : never;

const meAtom = Atom.make(
  AsyncResult.initial<CurrentUserShape, { readonly _tag: string }>(),
);
const adminPingAtom = Atom.make(
  AsyncResult.success<"pong", { readonly _tag: string }>("pong"),
);
const adminUsersAtom = Atom.make(
  AsyncResult.initial<ReadonlyArray<AdminUser>, { readonly _tag: string }>(),
);

const setRoleCalls: unknown[] = [];
const setBlockedCalls: unknown[] = [];
const resetSteamLoginCalls: unknown[] = [];

// Ответ сервера для следующего вызова `setRole`/`setBlocked` — по умолчанию
// «ok», тесты тостов «self»/«notFound» подставляют своё и возвращают обратно.
let nextSetRoleResult: "ok" | "self" | "notFound" = "ok";
let nextSetBlockedResult: "ok" | "self" | "notFound" = "ok";

const adminSetRoleAtom = Atom.fn((arg: unknown) => {
  setRoleCalls.push(arg);
  return Effect.succeed(nextSetRoleResult);
});
const adminSetBlockedAtom = Atom.fn((arg: unknown) => {
  setBlockedCalls.push(arg);
  return Effect.succeed(nextSetBlockedResult);
});
const adminResetSteamLoginAtom = Atom.fn((arg: unknown) => {
  resetSteamLoginCalls.push(arg);
  return Effect.succeed(true);
});

const adminSetRoleArgs = (userId: string, role: "player" | "admin") => ({
  payload: { userId, role },
  reactivityKeys: ["admin"],
});
const adminSetBlockedArgs = (userId: string, blocked: boolean) => ({
  payload: { userId, blocked },
  reactivityKeys: ["admin"],
});
const adminResetSteamLoginArgs = (userId: string) => ({
  payload: { userId },
  reactivityKeys: ["admin"],
});

// `routes/admin.tsx` импортирует и другие атомы других вкладок — им здесь хватает заглушек,
// эта вкладка их не трогает.
const adminSessionsAtom = Atom.family((_failedOnly: boolean) =>
  Atom.make(AsyncResult.initial()),
);
const adminWorkersAtom = Atom.make(AsyncResult.initial());
const adminGamesAtom = Atom.make(AsyncResult.initial());
const adminInstallsAtom = Atom.make(AsyncResult.initial());
const sessionSettingsAtom = Atom.make(AsyncResult.initial());
const adminStopSessionAtom = Atom.fn((_arg: unknown) => Effect.succeed(true));
const adminSetDrainingAtom = Atom.fn((_arg: unknown) => Effect.succeed(true));
const adminDeleteGameAtom = Atom.fn((_arg: unknown) =>
  Effect.succeed("started" as const),
);
const adminCancelInstallAtom = Atom.fn((_arg: unknown) =>
  Effect.succeed(true),
);
const updateSessionSettingsAtom = Atom.fn((_arg: unknown) =>
  Effect.succeed(undefined),
);

const errorTag = (cause: Cause.Cause<{ readonly _tag: string }>) =>
  Option.getOrUndefined(
    Option.map(Cause.findErrorOption(cause), (error) => error._tag),
  );
const resultErrorTag = <A, E extends { readonly _tag: string }>(
  result: AsyncResult.AsyncResult<A, E>,
) => (AsyncResult.isFailure(result) ? errorTag(result.cause) : undefined);

mock.module("../src/rpc", () => ({
  meAtom,
  adminPingAtom,
  adminUsersAtom,
  adminSetRoleAtom,
  adminSetRoleArgs,
  adminSetBlockedAtom,
  adminSetBlockedArgs,
  adminResetSteamLoginAtom,
  adminResetSteamLoginArgs,
  adminGamesAtom,
  adminDeleteGameAtom,
  adminDeleteGameArgs: (appId: number) => ({
    payload: { appId },
    reactivityKeys: ["admin"],
  }),
  adminInstallsAtom,
  adminCancelInstallAtom,
  adminCancelInstallArgs: (jobId: string) => ({
    payload: { jobId },
    reactivityKeys: ["admin"],
  }),
  adminSessionsAtom,
  adminStopSessionAtom,
  adminStopSessionArgs: (sessionId: string) => ({
    payload: { sessionId },
    reactivityKeys: ["admin"],
  }),
  adminWorkersAtom,
  adminSetDrainingAtom,
  adminSetDrainingArgs: (workerId: string, draining: boolean) => ({
    payload: { workerId, draining },
    reactivityKeys: ["admin"],
  }),
  sessionSettingsAtom,
  updateSessionSettingsAtom,
  updateSessionSettingsArgs: (payload: unknown) => ({
    payload,
    reactivityKeys: ["settings"],
  }),
  errorTag,
  resultErrorTag,
}));

const { adminRoute } = await import("../src/routes/admin");
const { rootRoute } = await import("../src/routes/__root");

const admin: CurrentUserShape = {
  id: "u-admin",
  name: "Админ",
  image: null,
  role: "admin",
  steamId: null,
  email: "admin@example.com",
  emailVerified: true,
};

const baseUser = (
  patch: Partial<AdminUser> & { id: string; name: string },
): AdminUser => ({
  email: `${patch.id}@example.test`,
  role: "player",
  providers: ["google"],
  steamId: null,
  createdAt: new Date("2026-10-01T10:00:00Z").toISOString(),
  lastSessionAt: null,
  playedSeconds: 0,
  profileSizeBytes: null,
  profileVersion: null,
  blockedAt: null,
  steamLoginResetPending: false,
  activeSession: false,
  ...patch,
});

const routeTree = rootRoute.addChildren([adminRoute]);

function renderUsers(users: ReadonlyArray<AdminUser>) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/admin?tab=users"] }),
  });
  const initialValues: Array<InitialValue> = [
    [meAtom, AsyncResult.success(admin)],
    [adminUsersAtom, AsyncResult.success(users)],
  ];
  return render(
    <RegistryProvider initialValues={initialValues}>
      <RouterProvider router={router} />
    </RegistryProvider>,
  );
}

describe("UsersTab", () => {
  const selfRow = baseUser({
    id: "u-admin",
    name: "Админ",
    role: "admin",
    providers: ["pocket-id"],
  });
  const blockedWithPocketId = baseUser({
    id: "u1",
    name: "Alice",
    email: "alice@example.test",
    providers: ["pocket-id"],
    steamId: "76561190000000001",
    blockedAt: new Date("2026-10-27T08:00:00Z").toISOString(),
    steamLoginResetPending: true,
    playedSeconds: 3600,
    profileSizeBytes: 2 * 1024 * 1024,
    profileVersion: 3,
    lastSessionAt: new Date("2026-10-27T09:00:00Z").toISOString(),
  });
  const plain = baseUser({
    id: "u2",
    name: "Bob",
    email: "bob@example.test",
    providers: [],
    activeSession: true,
  });

  it("shows rows with columns from the fixture", async () => {
    renderUsers([selfRow, blockedWithPocketId, plain]);

    expect(await screen.findByText("Alice")).toBeTruthy();

    const aliceRow = screen.getByText("Alice").closest("tr");
    if (aliceRow === null) throw new Error("row not found");
    expect(within(aliceRow).getByText("alice@example.test")).toBeTruthy();
    expect(within(aliceRow).getByText("Pocket ID")).toBeTruthy();
    expect(within(aliceRow).getByText(/76561190000000001/)).toBeTruthy();
    expect(within(aliceRow).getByText(/вход сброшен/)).toBeTruthy();
    expect(within(aliceRow).getByText(/Заблокирован/)).toBeTruthy();
    expect(within(aliceRow).getByText("2 МБ · v3")).toBeTruthy();
    expect(within(aliceRow).getByText("1 ч")).toBeTruthy();

    const bobRow = screen.getByText("Bob").closest("tr");
    if (bobRow === null) throw new Error("row not found");
    expect(within(bobRow).getByText("Почта")).toBeTruthy();
    expect(within(bobRow).getByText("не привязан")).toBeTruthy();
    expect(within(bobRow).getByText("0 м")).toBeTruthy();
    expect(within(bobRow).getByText("в игре")).toBeTruthy();
  });

  it("M4: shows a pending Steam login reset even without a linked steamId", async () => {
    const unlinkedPendingReset = baseUser({
      id: "u3",
      name: "Carol",
      email: "carol@example.test",
      providers: ["pocket-id"],
      steamId: null,
      steamLoginResetPending: true,
    });
    renderUsers([selfRow, blockedWithPocketId, plain, unlinkedPendingReset]);

    const carolRow = (await screen.findByText("Carol")).closest("tr");
    if (carolRow === null) throw new Error("row not found");
    expect(within(carolRow).getByText("не привязан · вход сброшен")).toBeTruthy();
  });

  it("filters by name/email on the client", async () => {
    renderUsers([selfRow, blockedWithPocketId, plain]);
    await screen.findByText("Alice");
    expect(screen.getByText("Bob")).toBeTruthy();

    const search = screen.getByRole("textbox", { name: /Поиск/ });
    fireEvent.change(search, { target: { value: "bob@example" } });

    expect(screen.queryByText("Alice")).toBeNull();
    expect(screen.getByText("Bob")).toBeTruthy();
  });

  it("disables actions on the admin's own row with a hint", async () => {
    renderUsers([selfRow, blockedWithPocketId, plain]);
    // «Админ» — и подпись в шапке (AppHeader), и имя в своей строке таблицы.
    await screen.findByText("Bob");
    const ownRow = screen
      .getAllByText("Админ")
      .map((el) => el.closest("tr"))
      .find((tr) => tr !== null);
    if (ownRow === undefined || ownRow === null)
      throw new Error("row not found");
    const buttons = within(ownRow).getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("opens a confirm dialog for blocking and sends setBlocked on confirm", async () => {
    renderUsers([selfRow, blockedWithPocketId, plain]);
    const bobRow = (await screen.findByText("Bob")).closest("tr");
    if (bobRow === null) throw new Error("row not found");

    fireEvent.click(within(bobRow).getByRole("button", { name: "Заблокировать" }));

    expect(await screen.findByText("Заблокировать Bob?")).toBeTruthy();
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByText(/Новые игры запустить не получится/),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Заблокировать" }));

    await waitFor(() => {
      expect(setBlockedCalls.at(-1)).toEqual({
        payload: { userId: "u2", blocked: true },
        reactivityKeys: ["admin"],
      });
    });
  });

  it("opens a confirm dialog for resetting Steam login and sends the mutation on confirm", async () => {
    renderUsers([selfRow, blockedWithPocketId, plain]);
    const aliceRow = (await screen.findByText("Alice")).closest("tr");
    if (aliceRow === null) throw new Error("row not found");

    fireEvent.click(
      within(aliceRow).getByRole("button", { name: "Сбросить вход Steam" }),
    );

    expect(await screen.findByText("Сбросить вход Steam у Alice?")).toBeTruthy();
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByText(/Steam попросит войти заново/),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Сбросить" }));

    await waitFor(() => {
      expect(resetSteamLoginCalls.at(-1)).toEqual({
        payload: { userId: "u1" },
        reactivityKeys: ["admin"],
      });
    });
  });

  it("toggles role without a confirm dialog", async () => {
    renderUsers([selfRow, blockedWithPocketId, plain]);
    const bobRow = (await screen.findByText("Bob")).closest("tr");
    if (bobRow === null) throw new Error("row not found");

    fireEvent.click(
      within(bobRow).getByRole("button", { name: "Сделать админом" }),
    );

    await waitFor(() => {
      expect(setRoleCalls.at(-1)).toEqual({
        payload: { userId: "u2", role: "admin" },
        reactivityKeys: ["admin"],
      });
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows a message when there are no users", async () => {
    renderUsers([]);
    expect(await screen.findByText("Пользователей нет")).toBeTruthy();
  });

  it("shows «Нельзя изменить себя» when the server reports self", async () => {
    nextSetRoleResult = "self";
    const toastError = spyOn(toast, "error").mockImplementation(
      () => "" as never,
    );
    renderUsers([selfRow, blockedWithPocketId, plain]);
    const bobRow = (await screen.findByText("Bob")).closest("tr");
    if (bobRow === null) throw new Error("row not found");

    fireEvent.click(
      within(bobRow).getByRole("button", { name: "Сделать админом" }),
    );

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Нельзя изменить себя");
    });
    toastError.mockRestore();
    nextSetRoleResult = "ok";
  });

  it("shows «Пользователь не найден» when the server reports notFound", async () => {
    nextSetBlockedResult = "notFound";
    const toastError = spyOn(toast, "error").mockImplementation(
      () => "" as never,
    );
    renderUsers([selfRow, blockedWithPocketId, plain]);
    const bobRow = (await screen.findByText("Bob")).closest("tr");
    if (bobRow === null) throw new Error("row not found");

    fireEvent.click(
      within(bobRow).getByRole("button", { name: "Заблокировать" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Заблокировать" }),
    );

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Пользователь не найден");
    });
    toastError.mockRestore();
    nextSetBlockedResult = "ok";
  });
});
