// Вкладка «Серверы» (`/admin?tab=workers`, Task 9): серверы сгруппированы по регионам
// в порядке `position`, «Без региона» — последняя группа. `../src/rpc` подменяется
// целиком (приём как в `adminGames.test.tsx`): полный набор экспортов, которые
// транзитивно тянет `routes/admin.tsx` (все вкладки импортируются в нём статически).
import { describe, expect, it, mock } from "bun:test";
import type { AdminRegion, AdminWorker, CurrentUserShape } from "@cg/rpc";
import { render, screen } from "@testing-library/react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { RegistryProvider } from "@effect/atom-react";
import { rpcStub } from "./moduleStubs";

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
const adminWorkersAtom = Atom.make(
  AsyncResult.initial<Array<AdminWorker>, { readonly _tag: string }>(),
);
const adminRegionsAtom = Atom.make(
  AsyncResult.initial<Array<AdminRegion>, { readonly _tag: string }>(),
);

mock.module("../src/rpc", () => ({
  ...rpcStub(),
  meAtom,
  adminPingAtom,
  adminWorkersAtom,
  adminRegionsAtom,
  adminClassesAtom: Atom.make(AsyncResult.success([])),
  adminSessionsAtom: Atom.family((_failedOnly: boolean) =>
    Atom.make(AsyncResult.success({ active: [], recent: [] })),
  ),
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

const worker = (patch: Partial<AdminWorker> & { id: string }): AdminWorker => ({
  publicIp: "1.2.3.4",
  slots: 1,
  roles: ["worker"],
  online: true,
  lastSeenAt: new Date("2026-11-09T12:00:00Z").toISOString(),
  draining: false,
  classId: null,
  regionId: null,
  enrolled: true,
  pendingCode: null,
  hardware: null,
  versions: null,
  stats: null,
  sessions: [],
  ...patch,
});

const routeTree = rootRoute.addChildren([adminRoute]);

function renderWorkers(
  workers: ReadonlyArray<AdminWorker>,
  regions: ReadonlyArray<AdminRegion>,
) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/admin?tab=workers"] }),
  });
  const initialValues: Array<InitialValue> = [
    [meAtom, AsyncResult.success(admin)],
    [adminWorkersAtom, AsyncResult.success(workers)],
    [adminRegionsAtom, AsyncResult.success(regions)],
  ];
  return render(
    <RegistryProvider initialValues={initialValues}>
      <RouterProvider router={router} />
    </RegistryProvider>,
  );
}

describe("WorkersTab", () => {
  it('groups workers by region in position order with "Без региона" last', async () => {
    // `admin.regions.list` отдаёт регионы `position asc` (см. комментарий в `rpc.ts`) —
    // `RegionsCard` (как и `ClassesCard`) показывает список, как он пришёл, без своей
    // пересортировки; порядок здесь — как от настоящего API.
    const regions: ReadonlyArray<AdminRegion> = [
      { id: "r-msk", code: "msk", name: "Москва", position: 0, workers: 1 },
      { id: "r-spb", code: "spb", name: "Питер", position: 1, workers: 1 },
    ];
    const workers: ReadonlyArray<AdminWorker> = [
      worker({ id: "spb-1", regionId: "r-spb" }),
      worker({ id: "msk-1", regionId: "r-msk" }),
      worker({ id: "no-region-1", regionId: null }),
    ];
    renderWorkers(workers, regions);
    await screen.findByText("spb-1");

    const text = document.body.textContent ?? "";
    const mskIndex = text.indexOf("Москва");
    const spbIndex = text.indexOf("Питер");
    const noRegionIndex = text.indexOf("Без региона");

    expect(mskIndex).toBeGreaterThan(-1);
    expect(spbIndex).toBeGreaterThan(-1);
    expect(noRegionIndex).toBeGreaterThan(-1);
    expect(mskIndex).toBeLessThan(spbIndex);
    expect(spbIndex).toBeLessThan(noRegionIndex);
  });

  it("shows the empty message when there are no workers at all", async () => {
    renderWorkers([], []);
    expect(
      await screen.findByText(
        "Воркеров нет: ни один агент ещё не подключался.",
      ),
    ).toBeTruthy();
  });
});
