// Вкладка «Тарифы» (`/admin?tab=tariffs`, Task 9, спека §1/§8) и диалог тарифа
// пользователя (`UserPlanDialog`, карточка пользователя): тестируем компоненты
// напрямую (приём как в `regionsCard.test.tsx`/`addWorkerDialog.test.tsx`), без
// похода через весь маршрут `/admin` — им не нужна проверка роли, которую уже
// покрывают `adminUsers.test.tsx`/`adminSessions.test.tsx`.
import { describe, expect, it, mock, spyOn } from "bun:test";
import type { AdminUserPlan, HourPack, Tariff } from "@cg/rpc";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { RegistryProvider } from "@effect/atom-react";
import { toast } from "sonner";
import { rpcStub } from "./moduleStubs";

type InitialValue =
  NonNullable<
    Parameters<typeof RegistryProvider>[0]["initialValues"]
  > extends Iterable<infer T>
    ? T
    : never;

const adminTariffsAtom = Atom.make(
  AsyncResult.initial<ReadonlyArray<Tariff>, { readonly _tag: string }>(),
);
const adminHourPacksAtom = Atom.make(
  AsyncResult.initial<ReadonlyArray<HourPack>, { readonly _tag: string }>(),
);
const adminUserPlanAtom = Atom.family((_userId: string) =>
  Atom.make(AsyncResult.initial<AdminUserPlan | null, { readonly _tag: string }>()),
);

const createCalls: Array<unknown> = [];
const updateCalls: Array<unknown> = [];
const setDefaultCalls: Array<unknown> = [];
const setArchivedCalls: Array<unknown> = [];
const grantCalls: Array<unknown> = [];
const revokeCalls: Array<unknown> = [];
const addMinutesCalls: Array<unknown> = [];

/** Меняются перед каждым тестом, что ожидает нестандартный ответ сервера. */
let createResult: "ok" | "duplicate" = "ok";
let grantResult: "ok" | "notFound" | "archived" | "badEnd" = "ok";

const adminCreateTariffAtom = Atom.fn((arg: unknown) => {
  createCalls.push(arg);
  return Effect.succeed(createResult);
});
const adminUpdateTariffAtom = Atom.fn((arg: unknown) => {
  updateCalls.push(arg);
  return Effect.succeed("ok" as const);
});
const adminSetTariffDefaultAtom = Atom.fn((arg: unknown) => {
  setDefaultCalls.push(arg);
  return Effect.succeed("ok" as const);
});
const adminSetTariffArchivedAtom = Atom.fn((arg: unknown) => {
  setArchivedCalls.push(arg);
  return Effect.succeed("ok" as const);
});
const adminCreateHourPackAtom = Atom.fn((_arg: unknown) =>
  Effect.succeed("ok" as const),
);
const adminUpdateHourPackAtom = Atom.fn((_arg: unknown) =>
  Effect.succeed("ok" as const),
);
const adminSetHourPackArchivedAtom = Atom.fn((_arg: unknown) =>
  Effect.succeed("ok" as const),
);
const adminGrantTariffAtom = Atom.fn((arg: unknown) => {
  grantCalls.push(arg);
  return Effect.succeed(grantResult);
});
const adminRevokeTariffAtom = Atom.fn((arg: unknown) => {
  revokeCalls.push(arg);
  return Effect.succeed("ok" as const);
});
const adminAddMinutesAtom = Atom.fn((arg: unknown) => {
  addMinutesCalls.push(arg);
  return Effect.succeed("ok" as const);
});

mock.module("../src/rpc", () => ({
  ...rpcStub(),
  adminTariffsAtom,
  adminCreateTariffAtom,
  adminCreateTariffArgs: (input: unknown) => ({
    payload: { input },
    reactivityKeys: ["admin"],
  }),
  adminUpdateTariffAtom,
  adminUpdateTariffArgs: (id: string, input: unknown) => ({
    payload: { id, input },
    reactivityKeys: ["admin"],
  }),
  adminSetTariffDefaultAtom,
  adminSetTariffDefaultArgs: (id: string) => ({
    payload: { id },
    reactivityKeys: ["admin"],
  }),
  adminSetTariffArchivedAtom,
  adminSetTariffArchivedArgs: (id: string, archived: boolean) => ({
    payload: { id, archived },
    reactivityKeys: ["admin"],
  }),
  adminHourPacksAtom,
  adminCreateHourPackAtom,
  adminCreateHourPackArgs: (input: unknown) => ({
    payload: { input },
    reactivityKeys: ["admin"],
  }),
  adminUpdateHourPackAtom,
  adminUpdateHourPackArgs: (id: string, input: unknown) => ({
    payload: { id, input },
    reactivityKeys: ["admin"],
  }),
  adminSetHourPackArchivedAtom,
  adminSetHourPackArchivedArgs: (id: string, archived: boolean) => ({
    payload: { id, archived },
    reactivityKeys: ["admin"],
  }),
  adminUserPlanAtom,
  adminGrantTariffAtom,
  adminGrantTariffArgs: (userId: string, tariffId: string, endsAt: string | null) => ({
    payload: { userId, tariffId, endsAt },
    reactivityKeys: ["admin"],
  }),
  adminRevokeTariffAtom,
  adminRevokeTariffArgs: (userId: string) => ({
    payload: { userId },
    reactivityKeys: ["admin"],
  }),
  adminAddMinutesAtom,
  adminAddMinutesArgs: (userId: string, minutes: number, comment: string) => ({
    payload: { userId, minutes, comment },
    reactivityKeys: ["admin"],
  }),
}));

const { TariffsTab } = await import("../src/components/admin/TariffsTab");
const { UserPlanDialog } = await import("../src/components/admin/UserPlanDialog");

const tariff = (patch: Partial<Tariff> & { id: string; name: string }): Tariff => ({
  priceRub: null,
  queuePriority: 0,
  monthlyMinutes: null,
  rollover: false,
  maxResolution: "1440p",
  maxBitrateMbps: 40,
  maxSessionMinutes: null,
  isDefault: false,
  archived: false,
  ...patch,
});

const basic = tariff({ id: "t-base", name: "Базовый", isDefault: true });
const pro = tariff({
  id: "t-pro",
  name: "Про",
  priceRub: 500,
  queuePriority: 10,
  monthlyMinutes: 2400,
  rollover: true,
  maxBitrateMbps: 30,
});

function renderTariffsTab(
  tariffs: ReadonlyArray<Tariff> = [basic, pro],
  hourPacks: ReadonlyArray<HourPack> = [],
) {
  const initialValues: Array<InitialValue> = [
    [adminTariffsAtom, AsyncResult.success(tariffs)],
    [adminHourPacksAtom, AsyncResult.success(hourPacks)],
  ];
  return render(
    <RegistryProvider initialValues={initialValues}>
      <TariffsTab />
    </RegistryProvider>,
  );
}

describe("TariffsTab", () => {
  it("lists tariffs with the default badge on the default tariff only", async () => {
    renderTariffsTab();

    const baseRow = (await screen.findByText("Базовый")).closest("tr");
    if (baseRow === null) throw new Error("row not found");
    expect(within(baseRow).getByText("По умолчанию")).toBeTruthy();

    const proRow = screen.getByText("Про").closest("tr");
    if (proRow === null) throw new Error("row not found");
    expect(within(proRow).queryByText("По умолчанию")).toBeNull();
    expect(within(proRow).getByText("500 ₽/мес")).toBeTruthy();
    expect(within(proRow).getByText("40 ч")).toBeTruthy();
  });

  it("create dialog sends monthlyMinutes = hours × 60", async () => {
    createResult = "ok";
    renderTariffsTab();

    fireEvent.click(screen.getByRole("button", { name: "Добавить тариф" }));
    fireEvent.change(screen.getByLabelText("Название тарифа"), {
      target: { value: "Стандарт" },
    });
    fireEvent.change(screen.getByLabelText("Часы в месяц"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      const call = createCalls.at(-1) as { payload: { input: { monthlyMinutes: unknown } } };
      expect(call.payload.input.monthlyMinutes).toBe(600);
    });
  });

  it("create dialog sends monthlyMinutes = null when the hours field is empty", async () => {
    createResult = "ok";
    renderTariffsTab();

    fireEvent.click(screen.getByRole("button", { name: "Добавить тариф" }));
    fireEvent.change(screen.getByLabelText("Название тарифа"), {
      target: { value: "Безлимитный" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      const call = createCalls.at(-1) as { payload: { input: { monthlyMinutes: unknown } } };
      expect(call.payload.input.monthlyMinutes).toBeNull();
    });
  });

  it("shows a duplicate-name error next to the form, not as a toast", async () => {
    createResult = "duplicate";
    const toastError = spyOn(toast, "error").mockImplementation(() => "" as never);
    renderTariffsTab();

    fireEvent.click(screen.getByRole("button", { name: "Добавить тариф" }));
    fireEvent.change(screen.getByLabelText("Название тарифа"), {
      target: { value: "Про" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Тариф с таким названием уже есть");
    expect(toastError).not.toHaveBeenCalled();
    toastError.mockRestore();
    createResult = "ok";
  });
});

const plan = (patch: Partial<AdminUserPlan> = {}): AdminUserPlan => ({
  tariff: pro,
  grantEndsAt: null,
  periodEndsAt: "2026-12-01T00:00:00.000Z",
  remainingMinutes: 750,
  grants: [],
  credits: [],
  ...patch,
});

function renderUserPlanDialog(userPlan: AdminUserPlan | null = plan()) {
  const initialValues: Array<InitialValue> = [
    [adminTariffsAtom, AsyncResult.success([basic, pro])],
    [adminUserPlanAtom("u1"), AsyncResult.success(userPlan)],
  ];
  return render(
    <RegistryProvider initialValues={initialValues}>
      <UserPlanDialog
        userId="u1"
        userName="Вася"
        open
        onOpenChange={() => {}}
      />
    </RegistryProvider>,
  );
}

describe("UserPlanDialog", () => {
  it("shows the remaining hours of the current plan", async () => {
    renderUserPlanDialog();
    expect(await screen.findByText(/12 ч 30 м/)).toBeTruthy();
  });

  it("grants a tariff with an end date", async () => {
    grantResult = "ok";
    renderUserPlanDialog();

    fireEvent.change(await screen.findByLabelText("Тариф для выдачи"), {
      target: { value: "t-pro" },
    });
    fireEvent.change(screen.getByLabelText("Дата окончания (пусто — бессрочно)"), {
      target: { value: "2026-12-31" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Выдать" }));

    await waitFor(() => {
      expect(grantCalls.at(-1)).toEqual({
        payload: { userId: "u1", tariffId: "t-pro", endsAt: "2026-12-31" },
        reactivityKeys: ["admin"],
      });
    });
  });

  it("sends minutes and comment when crediting hours", async () => {
    renderUserPlanDialog();

    fireEvent.change(await screen.findByLabelText("Минуты"), {
      target: { value: "90" },
    });
    fireEvent.change(screen.getByLabelText("Комментарий"), {
      target: { value: "Компенсация" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Начислить" }));

    await waitFor(() => {
      expect(addMinutesCalls.at(-1)).toEqual({
        payload: { userId: "u1", minutes: 90, comment: "Компенсация" },
        reactivityKeys: ["admin"],
      });
    });
  });
});
