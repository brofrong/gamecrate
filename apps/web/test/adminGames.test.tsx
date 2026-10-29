// Вкладка «Игры» (`/admin?tab=games`, Task 4): таблица игр общей библиотеки с
// размером/датами/запусками и кнопкой «Удалить»; строка «Служебные: …» без кнопки.
// `../src/rpc` подменяется целиком (приём как в `adminSessions.test.tsx`).
import { describe, expect, it, mock } from "bun:test";
import type {
  AdminGame,
  AdminGameRequirements,
  AdminGames,
  CurrentUserShape,
} from "@cg/rpc";
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
import { Effect } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { RegistryProvider } from "@effect/atom-react";

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
const adminGamesAtom = Atom.make(
  AsyncResult.initial<AdminGames, { readonly _tag: string }>(),
);

const deleteCalls: unknown[] = [];
const adminDeleteGameAtom = Atom.fn((arg: unknown) => {
  deleteCalls.push(arg);
  return Effect.succeed("started" as const);
});
const adminDeleteGameArgs = (appId: number) => ({
  payload: { appId },
  reactivityKeys: ["admin"],
});

/**
 * Требования и замеры по игре (панель, раскрывающаяся из строки): `Atom.family`
 * создаёт атом для `appId` лениво, при первом обращении — поэтому каждый новый
 * тест ниже использует свой `appId` и заполняет этот стор непосредственно перед
 * рендером (см. `adminGames.test.tsx` → `renderGames`/клик по строке).
 */
const requirementsStore: Record<number, AdminGameRequirements> = {};
const adminGameRequirementsAtom = Atom.family((appId: number) =>
  Atom.make(AsyncResult.success(requirementsStore[appId]!)),
);
const setRequirementsCalls: unknown[] = [];
const adminSetGameRequirementsAtom = Atom.fn((arg: unknown) => {
  setRequirementsCalls.push(arg);
  return Effect.succeed(true);
});
const adminSetGameRequirementsArgs = (
  appId: number,
  requirements: unknown,
) => ({ payload: { appId, requirements }, reactivityKeys: ["admin"] });

// `routes/admin.tsx` импортирует и другие атомы часть 1 — им здесь хватает заглушек,
// эта вкладка их не трогает.
const adminSessionsAtom = Atom.family((_failedOnly: boolean) =>
  Atom.make(AsyncResult.initial()),
);
const adminWorkersAtom = Atom.make(AsyncResult.initial());
const sessionSettingsAtom = Atom.make(AsyncResult.initial());
const adminStopSessionAtom = Atom.fn((_arg: unknown) => Effect.succeed(true));
const adminSetDrainingAtom = Atom.fn((_arg: unknown) => Effect.succeed(true));
const updateSessionSettingsAtom = Atom.fn((_arg: unknown) =>
  Effect.succeed(undefined),
);

mock.module("../src/rpc", () => ({
  meAtom,
  adminPingAtom,
  adminGamesAtom,
  adminDeleteGameAtom,
  adminDeleteGameArgs,
  adminGameRequirementsAtom,
  adminSetGameRequirementsAtom,
  adminSetGameRequirementsArgs,
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
  errorTag: () => undefined,
  resultErrorTag: () => undefined,
}));

const { adminRoute } = await import("../src/routes/admin");
const { rootRoute } = await import("../src/routes/__root");

const admin: CurrentUserShape = {
  id: "u1",
  name: "Админ",
  image: null,
  role: "admin",
  steamId: null,
  email: "admin@example.com",
  emailVerified: true,
};

const game = (
  patch: Partial<AdminGame> & { appId: number; name: string },
): AdminGame => ({
  sizeBytes: 100 * 1024 * 1024,
  installedAt: new Date("2026-10-27T10:00:00Z").toISOString(),
  lastLaunchAt: new Date("2026-10-27T12:00:00Z").toISOString(),
  launches: 1,
  activeSessions: 0,
  installing: false,
  deleting: false,
  ...patch,
});

const routeTree = rootRoute.addChildren([adminRoute]);

function renderGames(games: AdminGames) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/admin?tab=games"] }),
  });
  const initialValues: Array<InitialValue> = [
    [meAtom, AsyncResult.success(admin)],
    [adminGamesAtom, AsyncResult.success(games)],
  ];
  return render(
    <RegistryProvider initialValues={initialValues}>
      <RouterProvider router={router} />
    </RegistryProvider>,
  );
}

describe("GamesTab", () => {
  const vampire = game({
    appId: 1794680,
    name: "Vampire Survivors",
    sizeBytes: 2000 * 1024 * 1024,
    activeSessions: 1,
  });
  const peglin = game({
    appId: 1296610,
    name: "Peglin",
    sizeBytes: 317 * 1024 * 1024,
  });
  const katana = game({
    appId: 1091500,
    name: "Katana ZERO",
    deleting: true,
  });
  const balatro = game({
    appId: 2379780,
    name: "Balatro",
    sizeBytes: 64 * 1024 * 1024,
  });

  it("shows games with sizes, play status and the deleting state; service row has no button", async () => {
    renderGames({
      games: [vampire, peglin, katana, balatro],
      service: {
        count: 1,
        sizeBytes: 500 * 1024 * 1024,
        names: ["Proton Experimental"],
      },
    });

    expect(await screen.findByText("Balatro")).toBeTruthy();
    expect(screen.getByText("317 МБ")).toBeTruthy();
    expect(screen.getByText("играют сейчас")).toBeTruthy();

    const vampireRow = screen.getByText("Vampire Survivors").closest("tr");
    if (vampireRow === null) throw new Error("row not found");
    const deleteButton = within(vampireRow).getByRole("button", {
      name: "Удалить",
    });
    expect((deleteButton as HTMLButtonElement).disabled).toBe(true);

    const katanaRow = screen.getByText("Katana ZERO").closest("tr");
    if (katanaRow === null) throw new Error("row not found");
    expect(within(katanaRow).getByText("Удаляется…")).toBeTruthy();
    expect(within(katanaRow).queryByRole("button")).toBeNull();

    expect(
      screen.getByText("Служебные: Proton Experimental"),
    ).toBeTruthy();
  });

  it("opens the confirm dialog on click and sends the appId on confirm", async () => {
    renderGames({
      games: [vampire, peglin, katana, balatro],
      service: null,
    });

    const peglinRow = await screen.findByText("Peglin");
    const row = peglinRow.closest("tr");
    if (row === null) throw new Error("row not found");
    const deleteButton = within(row).getByRole("button", { name: "Удалить" });
    fireEvent.click(deleteButton);

    expect(await screen.findByText("Удалить Peglin?")).toBeTruthy();
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/317 МБ/)).toBeTruthy();

    const confirm = within(dialog).getByRole("button", { name: "Удалить" });
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(deleteCalls.at(-1)).toEqual({
        payload: { appId: 1296610 },
        reactivityKeys: ["admin"],
      });
    });
  });
});

// Панель требований (спека §5.2): строка раскрывается в `GameRequirementsPanel`
// по клику. Каждый тест — свой `appId`, не пересекающийся с `describe("GamesTab")`
// выше (комментарий у `requirementsStore`).
describe("GameRequirementsPanel (expand row)", () => {
  const GiB = 1024 ** 3;

  const emptyRequirements = (
    patch: Partial<AdminGameRequirements> = {},
  ): AdminGameRequirements => ({
    requirements: null,
    rows: [],
    overall: { sessions: 0, vramP95: null, ramP95: null, cpuP95: null },
    ...patch,
  });

  it("shows 'нет данных' when the game has no stored requirements", async () => {
    const noDataGame = game({ appId: 9001, name: "No Data Game" });
    requirementsStore[9001] = emptyRequirements();

    renderGames({ games: [noDataGame], service: null });
    fireEvent.click(await screen.findByText("No Data Game"));

    expect(
      await screen.findByText(
        "нет данных, запускается только на самом сильном классе",
      ),
    ).toBeTruthy();
  });

  it("«Принять» fills in the requirement fields from the suggestion", async () => {
    const suggestGame = game({ appId: 9002, name: "Suggest Game" });
    requirementsStore[9002] = emptyRequirements({
      overall: {
        sessions: 3,
        vramP95: 3.3 * GiB,
        ramP95: 1 * GiB,
        cpuP95: 2.1,
      },
    });

    renderGames({ games: [suggestGame], service: null });
    fireEvent.click(await screen.findByText("Suggest Game"));

    const accept = await screen.findByRole("button", { name: "Принять" });
    fireEvent.click(accept);

    expect((screen.getByLabelText("VRAM, GB") as HTMLInputElement).value).toBe(
      "4",
    );
    expect((screen.getByLabelText("RAM, GB") as HTMLInputElement).value).toBe(
      "2",
    );
    expect(
      (screen.getByLabelText("Потоки CPU") as HTMLInputElement).value,
    ).toBe("3");
  });

  it("shows a crash hint line for a GPU with a high crash share", async () => {
    const crashGame = game({ appId: 9003, name: "Crash Game" });
    requirementsStore[9003] = emptyRequirements({
      rows: [
        {
          gpuName: "Test GPU",
          className: null,
          sessions: 5,
          vramP95: null,
          ramP95: null,
          cpuP95: null,
          gpuUtilP95: null,
          crashShare: 0.5,
          otherShare: 0,
          vramSources: ["process"],
          perSlotVramBytes: 4 * GiB,
        },
      ],
    });

    renderGames({ games: [crashGame], service: null });
    fireEvent.click(await screen.findByText("Crash Game"));

    expect(
      await screen.findByText(
        "На Test GPU игра падает в 50% сессий — поднять минимум VRAM выше 4.0 GB?",
      ),
    ).toBeTruthy();
  });
});
