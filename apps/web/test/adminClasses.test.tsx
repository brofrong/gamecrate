// Блок «Классы» на вкладке «Воркеры» (спека §5.1): список по силе, добавление,
// переименование, кнопки вверх/вниз/удалить. `../src/rpc` подменяется целиком
// (приём как в `adminGames.test.tsx`).
import { describe, expect, it, mock } from "bun:test";
import type { AdminWorkerClass } from "@cg/rpc";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { RegistryProvider } from "@effect/atom-react";
import { rpcStub } from "./moduleStubs";

/** Элемент `initialValues` у `RegistryProvider` — без своего `any` в этом файле. */
type InitialValue =
  NonNullable<
    Parameters<typeof RegistryProvider>[0]["initialValues"]
  > extends Iterable<infer T>
    ? T
    : never;

const adminClassesAtom = Atom.make(
  AsyncResult.initial<Array<AdminWorkerClass>, { readonly _tag: string }>(),
);

const createCalls: Array<unknown> = [];
const renameCalls: Array<unknown> = [];
const moveCalls: Array<unknown> = [];
const deleteCalls: Array<unknown> = [];

const createResult: "ok" | "duplicate" = "ok";
const moveResult: "ok" | "edge" | "notFound" = "ok";
const deleteResult: "ok" | "inUse" | "notFound" = "ok";

const adminCreateClassAtom = Atom.fn((arg: unknown) => {
  createCalls.push(arg);
  return Effect.succeed(createResult);
});
const adminRenameClassAtom = Atom.fn((arg: unknown) => {
  renameCalls.push(arg);
  return Effect.succeed("ok" as const);
});
const adminMoveClassAtom = Atom.fn((arg: unknown) => {
  moveCalls.push(arg);
  return Effect.succeed(moveResult);
});
const adminDeleteClassAtom = Atom.fn((arg: unknown) => {
  deleteCalls.push(arg);
  return Effect.succeed(deleteResult);
});

mock.module("../src/rpc", () => ({
  ...rpcStub(),
  adminClassesAtom,
  adminCreateClassAtom,
  adminCreateClassArgs: (name: string) => ({
    payload: { name },
    reactivityKeys: ["admin"],
  }),
  adminRenameClassAtom,
  adminRenameClassArgs: (id: string, name: string) => ({
    payload: { id, name },
    reactivityKeys: ["admin"],
  }),
  adminMoveClassAtom,
  adminMoveClassArgs: (id: string, direction: "up" | "down") => ({
    payload: { id, direction },
    reactivityKeys: ["admin"],
  }),
  adminDeleteClassAtom,
  adminDeleteClassArgs: (id: string) => ({
    payload: { id },
    reactivityKeys: ["admin"],
  }),
}));

const { ClassesCard } = await import("../src/components/admin/ClassesCard");

const classes: Array<AdminWorkerClass> = [
  { id: "c-fast", name: "Быстрое", rank: 2, workers: 0 },
  { id: "c-standard", name: "Стандарт", rank: 1, workers: 1 },
];

function renderClasses(value: Array<AdminWorkerClass>) {
  const initialValues: Array<InitialValue> = [
    [adminClassesAtom, AsyncResult.success(value)],
  ];
  return render(
    <RegistryProvider initialValues={initialValues}>
      <ClassesCard />
    </RegistryProvider>,
  );
}

describe("ClassesCard", () => {
  it("список по силе (сильнейший сверху), кнопки вверх/вниз на краях неактивны", () => {
    renderClasses(classes);

    const names = screen
      .getAllByText(/Быстрое|Стандарт/, { selector: "span.font-medium" })
      .map((node) => node.textContent);
    expect(names).toEqual(["Быстрое", "Стандарт"]);
    expect(screen.getByText("0 воркеров")).toBeTruthy();
    expect(screen.getByText("1 воркер")).toBeTruthy();

    const upButtons = screen.getAllByRole("button", { name: "Поднять" });
    const downButtons = screen.getAllByRole("button", { name: "Опустить" });
    // Быстрое — самый сильный: "Поднять" неактивна.
    expect((upButtons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((downButtons[0] as HTMLButtonElement).disabled).toBe(false);
    // Стандарт — самый слабый: "Опустить" неактивна.
    expect((upButtons[1] as HTMLButtonElement).disabled).toBe(false);
    expect((downButtons[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("добавляет класс по кнопке «Добавить»", async () => {
    renderClasses(classes);

    const input = screen.getByLabelText("Новый класс");
    fireEvent.change(input, { target: { value: "Экстремальное" } });
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }));

    await waitFor(() => {
      expect(createCalls.at(-1)).toEqual({
        payload: { name: "Экстремальное" },
        reactivityKeys: ["admin"],
      });
    });
  });

  it("поднимает класс кнопкой «Поднять»", async () => {
    renderClasses(classes);

    const upButtons = screen.getAllByRole("button", { name: "Поднять" });
    fireEvent.click(upButtons[1]!); // Стандарт — вверх

    await waitFor(() => {
      expect(moveCalls.at(-1)).toEqual({
        payload: { id: "c-standard", direction: "up" },
        reactivityKeys: ["admin"],
      });
    });
  });

  it("переименование: переключает в режим правки и отправляет новое имя", async () => {
    renderClasses(classes);

    const row = screen.getByText("Стандарт").closest("div");
    if (row === null) throw new Error("row not found");
    fireEvent.click(
      screen.getAllByRole("button", { name: "Переименовать" })[1]!,
    );

    const input = screen.getByLabelText("Имя класса");
    fireEvent.change(input, { target: { value: "Базовый" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      expect(renameCalls.at(-1)).toEqual({
        payload: { id: "c-standard", name: "Базовый" },
        reactivityKeys: ["admin"],
      });
    });
  });

  it("удаляет класс кнопкой «Удалить»", async () => {
    renderClasses(classes);

    const deleteButtons = screen.getAllByRole("button", { name: "Удалить" });
    fireEvent.click(deleteButtons[0]!); // Быстрое — без воркеров

    await waitFor(() => {
      expect(deleteCalls.at(-1)).toEqual({
        payload: { id: "c-fast" },
        reactivityKeys: ["admin"],
      });
    });
  });
});
