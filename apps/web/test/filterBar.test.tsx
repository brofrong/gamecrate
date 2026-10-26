// Фильтры библиотеки: строка на десктопе (FilterBar) и шторка на телефоне
// (FilterSheet). Оба компонента контролируемые и ничего не знают про URL —
// адрес хранит родитель (Task 10, MyGamesPage).
import { describe, expect, it, jest, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { FilterBar } from "../src/components/app/FilterBar";
import { FilterSheet } from "../src/components/app/FilterSheet";
import { DEFAULT_FILTERS, type Filters } from "../src/lib/libraryFilters";
import { testRouter } from "./router";

function renderBar(
  overrides: Partial<{
    filters: Filters;
    onChange: (next: Filters) => void;
    total: number;
    focusSearch: boolean;
  }> = {},
) {
  const onChange = overrides.onChange ?? mock(() => {});
  render(
    <RouterProvider
      router={testRouter(
        <FilterBar
          filters={overrides.filters ?? DEFAULT_FILTERS}
          onChange={onChange}
          total={overrides.total ?? 148}
          {...(overrides.focusSearch !== undefined
            ? { focusSearch: overrides.focusSearch }
            : {})}
        />,
      )}
    />,
  );
  return { onChange };
}

describe("FilterBar", () => {
  it("выбор в select «Статус» вызывает onChange со status: ready", async () => {
    const { onChange } = renderBar();
    const select = await screen.findByLabelText("Статус");
    fireEvent.change(select, { target: { value: "ready" } });
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_FILTERS,
      status: "ready",
    });
  });

  it("чип «Не запускались» добавляет chip never", async () => {
    const { onChange } = renderBar();
    const chip = await screen.findByRole("button", { name: "Не запускались" });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_FILTERS,
      chips: ["never"],
    });
  });

  it("повторное нажатие на «Не запускались» убирает chip", async () => {
    const { onChange } = renderBar({
      filters: { ...DEFAULT_FILTERS, chips: ["never"] },
    });
    const chip = await screen.findByRole("button", { name: "Не запускались" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_FILTERS, chips: [] });
  });

  it("«Сбросить» не отображается, когда фильтры по умолчанию", async () => {
    renderBar();
    await screen.findByLabelText("Статус");
    expect(screen.queryByRole("button", { name: "Сбросить" })).toBeNull();
  });

  it("«Сбросить» виден при изменённых фильтрах и возвращает DEFAULT_FILTERS", async () => {
    const { onChange } = renderBar({
      filters: { ...DEFAULT_FILTERS, q: "zelda" },
    });
    const reset = await screen.findByRole("button", { name: "Сбросить" });
    fireEvent.click(reset);
    expect(onChange).toHaveBeenCalledWith(DEFAULT_FILTERS);
  });

  it("поиск вызывает onChange с q через 150 мс", async () => {
    const { onChange } = renderBar();
    const input = await screen.findByLabelText("Найти игру");
    jest.useFakeTimers();
    try {
      fireEvent.change(input, { target: { value: "zelda" } });
      expect(onChange).not.toHaveBeenCalled();
      jest.advanceTimersByTime(149);
      expect(onChange).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(onChange).toHaveBeenCalledWith({
        ...DEFAULT_FILTERS,
        q: "zelda",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("ссылка «Привязать аккаунт» ведёт на /profile", async () => {
    renderBar();
    const link = await screen.findByRole("link", {
      name: /Привязать аккаунт/,
    });
    expect(link.getAttribute("href")).toBe("/profile");
  });

  it("чип «Из ящика» заблокирован с title «Скоро»", async () => {
    renderBar();
    const chip = await screen.findByRole("button", { name: "Из ящика" });
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    expect(chip.getAttribute("title")).toBe("Скоро");
  });

  it("первая строка (селекты/привязать/поиск) переносится, а не вылезает за экран", async () => {
    renderBar();
    const select = await screen.findByLabelText("Статус");
    // Первая строка — общий родитель `<select>`'ов, «Привязать аккаунт» и поиска.
    const row = select.closest("div");
    expect(row).not.toBeNull();
    expect(Array.from(row?.classList ?? [])).toContain("flex-wrap");
  });

  it("⌘K фокусирует поле поиска", async () => {
    renderBar();
    const input = await screen.findByLabelText("Найти игру");
    (input as HTMLInputElement).blur();
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(document.activeElement).toBe(input);
  });

  it("Ctrl+K тоже фокусирует поле поиска", async () => {
    renderBar();
    const input = await screen.findByLabelText("Найти игру");
    (input as HTMLInputElement).blur();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(input);
  });
});

describe("FilterSheet", () => {
  function countFor(filters: Filters): number {
    return filters.status === "ready" ? 7 : 20;
  }

  it("рендерит диалог с role=dialog и aria-label «Фильтры», когда open", () => {
    render(
      <FilterSheet
        open={true}
        filters={DEFAULT_FILTERS}
        onApply={() => {}}
        onClose={() => {}}
        countFor={countFor}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Фильтры" })).toBeTruthy();
  });

  it("не рендерит ничего, когда open=false", () => {
    render(
      <FilterSheet
        open={false}
        filters={DEFAULT_FILTERS}
        onApply={() => {}}
        onClose={() => {}}
        countFor={countFor}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("выбор сегмента и «Показать 7 игр» вызывает onApply с черновиком, затем закрывает", () => {
    const onApply = mock(() => {});
    const onClose = mock(() => {});
    render(
      <FilterSheet
        open={true}
        filters={DEFAULT_FILTERS}
        onApply={onApply}
        onClose={onClose}
        countFor={countFor}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Готовы" }));
    const applyButton = screen.getByRole("button", { name: "Показать 7 игр" });
    fireEvent.click(applyButton);
    expect(onApply).toHaveBeenCalledWith({
      ...DEFAULT_FILTERS,
      status: "ready",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("«Из ящика» заблокирован с title «Скоро»", () => {
    render(
      <FilterSheet
        open={true}
        filters={DEFAULT_FILTERS}
        onApply={() => {}}
        onClose={() => {}}
        countFor={countFor}
      />,
    );
    const chip = screen.getByRole("button", { name: "Из ящика" });
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    expect(chip.getAttribute("title")).toBe("Скоро");
  });

  it("Escape закрывает шторку и отбрасывает черновик", () => {
    const onApply = mock(() => {});
    const onClose = mock(() => {});
    render(
      <FilterSheet
        open={true}
        filters={DEFAULT_FILTERS}
        onApply={onApply}
        onClose={onClose}
        countFor={countFor}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Готовы" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("клик по затемнению закрывает шторку и отбрасывает черновик", () => {
    const onApply = mock(() => {});
    const onClose = mock(() => {});
    render(
      <FilterSheet
        open={true}
        filters={DEFAULT_FILTERS}
        onApply={onApply}
        onClose={onClose}
        countFor={countFor}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Закрыть фильтры" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("«Сбросить» в заголовке возвращает черновик к DEFAULT_FILTERS", () => {
    const onApply = mock(() => {});
    render(
      <FilterSheet
        open={true}
        filters={{ ...DEFAULT_FILTERS, status: "ready" }}
        onApply={onApply}
        onClose={() => {}}
        countFor={countFor}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    fireEvent.click(screen.getByRole("button", { name: "Показать 20 игр" }));
    expect(onApply).toHaveBeenCalledWith(DEFAULT_FILTERS);
  });
});
