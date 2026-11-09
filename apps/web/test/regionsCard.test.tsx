// Блок «Регионы» на вкладке «Серверы» (спека §6/§7): список, добавление, переименование,
// порядок, удаление. `../src/rpc` подменяется целиком (приём как в `adminClasses.test.tsx`).
import { describe, expect, it, mock } from "bun:test";
import type { AdminRegion } from "@cg/rpc";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { RegistryProvider } from "@effect/atom-react";
import { rpcStub } from "./moduleStubs";

type InitialValue =
  NonNullable<
    Parameters<typeof RegistryProvider>[0]["initialValues"]
  > extends Iterable<infer T>
    ? T
    : never;

const adminRegionsAtom = Atom.make(
  AsyncResult.initial<Array<AdminRegion>, { readonly _tag: string }>(),
);

const createCalls: Array<unknown> = [];
const updateCalls: Array<unknown> = [];
const deleteCalls: Array<unknown> = [];

const createResult: { id: string; code: string; name: string; position: number; workers: number } | "codeTaken" | "invalid" = {
  id: "r-new",
  code: "nsk",
  name: "Новосибирск",
  position: 2,
  workers: 0,
};
const updateResult: "ok" | "notFound" = "ok";
const deleteResult: "ok" | "notEmpty" | "notFound" = "ok";

const adminCreateRegionAtom = Atom.fn((arg: unknown) => {
  createCalls.push(arg);
  return Effect.succeed(createResult);
});
const adminUpdateRegionAtom = Atom.fn((arg: unknown) => {
  updateCalls.push(arg);
  return Effect.succeed(updateResult);
});
const adminDeleteRegionAtom = Atom.fn((arg: unknown) => {
  deleteCalls.push(arg);
  return Effect.succeed(deleteResult);
});

mock.module("../src/rpc", () => ({
  ...rpcStub(),
  adminRegionsAtom,
  adminCreateRegionAtom,
  adminCreateRegionArgs: (code: string, name: string) => ({
    payload: { code, name },
    reactivityKeys: ["admin"],
  }),
  adminUpdateRegionAtom,
  adminUpdateRegionArgs: (id: string, name: string, position: number) => ({
    payload: { id, name, position },
    reactivityKeys: ["admin"],
  }),
  adminDeleteRegionAtom,
  adminDeleteRegionArgs: (id: string) => ({
    payload: { id },
    reactivityKeys: ["admin"],
  }),
}));

const { RegionsCard } = await import("../src/components/admin/RegionsCard");

const regions: ReadonlyArray<AdminRegion> = [
  { id: "r-msk", code: "msk", name: "Москва", position: 0, workers: 2 },
  { id: "r-spb", code: "spb", name: "Питер", position: 1, workers: 0 },
];

function renderRegions(value: ReadonlyArray<AdminRegion> = regions) {
  const initialValues: Array<InitialValue> = [
    [adminRegionsAtom, AsyncResult.success(value as Array<AdminRegion>)],
  ];
  return render(
    <RegistryProvider initialValues={initialValues}>
      <RegionsCard />
    </RegistryProvider>,
  );
}

describe("RegionsCard", () => {
  it("delete is disabled for a region with workers", () => {
    renderRegions();

    const mskDelete = screen.getAllByRole("button", { name: "Удалить" })[0];
    expect((mskDelete as HTMLButtonElement).disabled).toBe(true);

    const spbDelete = screen.getAllByRole("button", { name: "Удалить" })[1];
    expect((spbDelete as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the region name, code and server count", () => {
    renderRegions();
    expect(screen.getByText("Москва")).toBeTruthy();
    expect(screen.getByText("msk")).toBeTruthy();
    expect(screen.getByText("2 сервера")).toBeTruthy();
    expect(screen.getByText("0 серверов")).toBeTruthy();
  });

  it("adds a region with name and code", async () => {
    renderRegions();

    fireEvent.change(screen.getByLabelText("Имя нового региона"), {
      target: { value: "Новосибирск" },
    });
    fireEvent.change(screen.getByLabelText("Код нового региона"), {
      target: { value: "nsk" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Добавить регион" }));

    await waitFor(() => {
      expect(createCalls.at(-1)).toEqual({
        payload: { code: "nsk", name: "Новосибирск" },
        reactivityKeys: ["admin"],
      });
    });
  });

  it("deletes a region without servers", async () => {
    renderRegions();

    const spbDelete = screen.getAllByRole("button", { name: "Удалить" })[1]!;
    fireEvent.click(spbDelete);

    await waitFor(() => {
      expect(deleteCalls.at(-1)).toEqual({
        payload: { id: "r-spb" },
        reactivityKeys: ["admin"],
      });
    });
  });

  it("moves a region up, swapping position with its neighbor", async () => {
    renderRegions();

    const upButtons = screen.getAllByRole("button", { name: "Поднять" });
    fireEvent.click(upButtons[1]!); // Питер — вверх

    await waitFor(() => {
      expect(updateCalls).toContainEqual({
        payload: { id: "r-spb", name: "Питер", position: 0 },
        reactivityKeys: ["admin"],
      });
      expect(updateCalls).toContainEqual({
        payload: { id: "r-msk", name: "Москва", position: 1 },
        reactivityKeys: ["admin"],
      });
    });
  });

  it("renames a region", async () => {
    renderRegions();

    fireEvent.click(
      screen.getAllByRole("button", { name: "Переименовать" })[1]!,
    );
    const input = screen.getByLabelText("Имя региона");
    fireEvent.change(input, { target: { value: "Ленинград" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      expect(updateCalls.at(-1)).toEqual({
        payload: { id: "r-spb", name: "Ленинград", position: 1 },
        reactivityKeys: ["admin"],
      });
    });
  });
});
