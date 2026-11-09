// Диалог «Добавить сервер» (вкладка «Серверы», спека §3/§7): форма → команда установки
// с кодом. `../src/rpc` подменяется целиком (приём как в `adminClasses.test.tsx`).
import { describe, expect, it, mock, spyOn } from "bun:test";
import type { AdminRegion } from "@cg/rpc";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import { toast } from "sonner";
import { rpcStub } from "./moduleStubs";

const createCalls: Array<unknown> = [];
/** Меняется перед каждым тестом — читает её замыкание `Atom.fn` ниже при вызове. */
let createResult:
  | { code: string; expiresAt: string }
  | "idTaken"
  | "invalid" = { code: "ABC123", expiresAt: "2026-11-10T12:00:00Z" };

const adminCreateWorkerAtom = Atom.fn((arg: unknown) => {
  createCalls.push(arg);
  return Effect.succeed(createResult);
});

mock.module("../src/rpc", () => ({
  ...rpcStub(),
  adminCreateWorkerAtom,
  adminCreateWorkerArgs: (id: string, regionId: string) => ({
    payload: { id, regionId },
    reactivityKeys: ["admin"],
  }),
}));

const { AddWorkerDialog } = await import(
  "../src/components/admin/AddWorkerDialog"
);

const regions: ReadonlyArray<AdminRegion> = [
  { id: "r-msk", code: "msk", name: "Москва", position: 0, workers: 1 },
  { id: "r-spb", code: "spb", name: "Питер", position: 1, workers: 0 },
];

function openDialog(regionsArg: ReadonlyArray<AdminRegion> = regions) {
  render(<AddWorkerDialog regions={regionsArg} />);
  fireEvent.click(screen.getByRole("button", { name: "Добавить сервер" }));
}

describe("AddWorkerDialog", () => {
  it("shows the install command with the code", async () => {
    createResult = { code: "ZXY987", expiresAt: "2026-11-10T12:00:00Z" };
    openDialog();

    fireEvent.change(screen.getByLabelText("Имя сервера"), {
      target: { value: "spb-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Получить команду" }));

    await waitFor(() => {
      expect(createCalls.at(-1)).toEqual({
        payload: { id: "spb-1", regionId: "r-msk" },
        reactivityKeys: ["admin"],
      });
    });

    const command = await screen.findByText(/\/agent\/install\.sh/);
    expect(command.textContent).toContain("ZXY987");
    expect(screen.getByRole("button", { name: "Скопировать" })).toBeTruthy();
    expect(screen.getByText(/Код действует до/)).toBeTruthy();
  });

  it("shows idTaken message", async () => {
    const toastError = spyOn(toast, "error").mockImplementation(
      () => "" as never,
    );
    createResult = "idTaken";
    openDialog();

    fireEvent.change(screen.getByLabelText("Имя сервера"), {
      target: { value: "spb-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Получить команду" }));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Сервер с таким именем уже есть");
    });
    expect(screen.queryByText(/\/agent\/install\.sh/)).toBeNull();
    toastError.mockRestore();
  });

  it("no regions — hint and submit disabled", () => {
    openDialog([]);
    expect(screen.getByText("Сначала добавьте регион")).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Получить команду" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });
});
