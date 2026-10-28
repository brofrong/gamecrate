// Вкладка «Установки» (`/admin?tab=installs`, Task 5): активные задачи установки — этап,
// прогресс закачки, сколько сессий ждёт и «Отменить» с подтверждением; «За 7 дней» — итог
// (готово / причина красным бейджем). `../src/rpc` подменяется целиком (приём как в
// `adminGames.test.tsx`).
import { describe, expect, it, mock } from "bun:test";
import type { AdminInstall, AdminInstalls, CurrentUserShape } from "@cg/rpc";
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
const adminInstallsAtom = Atom.make(
  AsyncResult.initial<AdminInstalls, { readonly _tag: string }>(),
);

const cancelCalls: unknown[] = [];
const adminCancelInstallAtom = Atom.fn((arg: unknown) => {
  cancelCalls.push(arg);
  return Effect.succeed(true);
});
const adminCancelInstallArgs = (jobId: string) => ({
  payload: { jobId },
  reactivityKeys: ["admin"],
});

// `routes/admin.tsx` импортирует и другие атомы частей 1-2 — им здесь хватает заглушек,
// эта вкладка их не трогает.
const adminGamesAtom = Atom.make(AsyncResult.initial());
const adminDeleteGameAtom = Atom.fn((_arg: unknown) =>
  Effect.succeed("started" as const),
);
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
  adminInstallsAtom,
  adminCancelInstallAtom,
  adminCancelInstallArgs,
  adminGamesAtom,
  adminDeleteGameAtom,
  adminDeleteGameArgs: (appId: number) => ({
    payload: { appId },
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

const install = (
  patch: Partial<AdminInstall> & {
    id: string;
    appId: number;
    gameName: string;
  },
): AdminInstall => ({
  userName: "Игрок",
  workerId: "gamestore-1",
  state: "running",
  stage: "downloading",
  bytesDownloaded: null,
  bytesTotal: null,
  error: null,
  cancelRequested: false,
  waitingSessions: 0,
  createdAt: new Date("2026-10-27T10:00:00Z").toISOString(),
  updatedAt: new Date("2026-10-27T10:05:00Z").toISOString(),
  ...patch,
});

const routeTree = rootRoute.addChildren([adminRoute]);

function renderInstalls(installs: AdminInstalls) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/admin?tab=installs"] }),
  });
  const initialValues: Array<InitialValue> = [
    [meAtom, AsyncResult.success(admin)],
    [adminInstallsAtom, AsyncResult.success(installs)],
  ];
  return render(
    <RegistryProvider initialValues={initialValues}>
      <RouterProvider router={router} />
    </RegistryProvider>,
  );
}

describe("InstallsTab", () => {
  const running = install({
    id: "job-running",
    appId: 2379780,
    gameName: "Balatro",
    bytesDownloaded: 45,
    bytesTotal: 100,
    waitingSessions: 2,
  });
  const queued = install({
    id: "job-queued",
    appId: 1296610,
    gameName: "Peglin",
    userName: "Игрок2",
    state: "queued",
    stage: null,
    workerId: null,
  });
  const cancelling = install({
    id: "job-cancelling",
    appId: 1091500,
    gameName: "Katana ZERO",
    cancelRequested: true,
  });

  it("shows active installs with progress, queue label and the cancelling badge", async () => {
    renderInstalls({ active: [running, queued, cancelling], recent: [] });

    const runningRow = (await screen.findByText("Balatro")).closest("tr");
    if (runningRow === null) throw new Error("row not found");
    expect(within(runningRow).getByText(/45 %/)).toBeTruthy();
    expect(within(runningRow).getByText("2")).toBeTruthy();

    const queuedRow = screen.getByText("Peglin").closest("tr");
    if (queuedRow === null) throw new Error("row not found");
    expect(within(queuedRow).getByText("В очереди")).toBeTruthy();

    const cancellingRow = screen.getByText("Katana ZERO").closest("tr");
    if (cancellingRow === null) throw new Error("row not found");
    expect(within(cancellingRow).getByText("Отменяется…")).toBeTruthy();
    expect(within(cancellingRow).queryByRole("button")).toBeNull();
  });

  it("opens the confirm dialog on click and sends the jobId on confirm", async () => {
    renderInstalls({ active: [running], recent: [] });

    const row = (await screen.findByText("Balatro")).closest("tr");
    if (row === null) throw new Error("row not found");
    const cancelButton = within(row).getByRole("button", { name: "Отменить" });
    fireEvent.click(cancelButton);

    expect(await screen.findByText("Отменить установку Balatro?")).toBeTruthy();
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByText(
        "Игроки, которые её ждут, увидят «Установка отменена администратором».",
      ),
    ).toBeTruthy();

    const confirm = within(dialog).getByRole("button", { name: "Отменить" });
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(cancelCalls.at(-1)).toEqual({
        payload: { jobId: "job-running" },
        reactivityKeys: ["admin"],
      });
    });
  });

  it("shows the cancellation reason in recent as a red badge", async () => {
    const failed = install({
      id: "job-failed",
      appId: 2379780,
      gameName: "Balatro",
      state: "failed",
      error: "Установка отменена администратором",
    });
    renderInstalls({ active: [], recent: [failed] });

    expect(
      await screen.findByText("Установка отменена администратором"),
    ).toBeTruthy();
  });

  it("shows the empty state when nothing is installing", async () => {
    renderInstalls({ active: [], recent: [] });

    expect(await screen.findByText("Сейчас ничего не ставится")).toBeTruthy();
  });
});
