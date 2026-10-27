// Фильтры библиотеки: строка на десктопе (FilterBar) и шторка на телефоне
// (FilterSheet). Оба компонента контролируемые и ничего не знают про URL —
// адрес хранит родитель (Task 10, MyGamesPage).
import { describe, expect, it, jest, mock } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { FilterBar } from "../src/components/app/FilterBar";
import { FilterSheet } from "../src/components/app/FilterSheet";
import { DEFAULT_FILTERS, type Filters } from "../src/lib/libraryFilters";
import { testRouter } from "./router";

function renderBar(
  overrides: Partial<{
    filters: Filters;
    onChange: (next: Filters) => void;
    onOpenSheet: () => void;
    total: number;
    focusSearch: boolean;
  }> = {},
) {
  const onChange = overrides.onChange ?? mock(() => {});
  const onOpenSheet = overrides.onOpenSheet ?? mock(() => {});
  render(
    <RouterProvider
      router={testRouter(
        <FilterBar
          filters={overrides.filters ?? DEFAULT_FILTERS}
          onChange={onChange}
          onOpenSheet={onOpenSheet}
          total={overrides.total ?? 148}
          {...(overrides.focusSearch !== undefined
            ? { focusSearch: overrides.focusSearch }
            : {})}
        />,
      )}
    />,
  );
  return { onChange, onOpenSheet };
}

async function openPanel() {
  fireEvent.click(await screen.findByRole("button", { name: /Фильтры/ }));
  return screen.getByRole("dialog", { name: "Фильтры" });
}

describe("FilterBar", () => {
  it("верхняя строка — поиск и кнопка «Фильтры» рядом, без селектов и «Привязать аккаунт»", async () => {
    renderBar();
    const input = await screen.findByLabelText("Найти игру");
    const button = screen.getByRole("button", { name: /Фильтры/ });
    const row = input.closest("div")?.parentElement;
    expect(row?.contains(button)).toBe(true);
    expect(screen.queryByLabelText("Статус")).toBeNull();
    expect(
      screen.queryByRole("link", { name: /Привязать аккаунт/ }),
    ).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("кнопка «Фильтры» открывает панель; «по названию» вызывает onChange с sort: name", async () => {
    const { onChange } = renderBar();
    const panel = await openPanel();
    fireEvent.click(within(panel).getByRole("button", { name: "по названию" }));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_FILTERS, sort: "name" });
  });

  it("в панели «нужен вход в Steam» ставит status: noprofile", async () => {
    const { onChange } = renderBar();
    const panel = await openPanel();
    fireEvent.click(
      within(panel).getByRole("button", { name: "нужен вход в Steam" }),
    );
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_FILTERS,
      status: "noprofile",
    });
  });

  it("«Не запускались» живёт в панели, а не в строке чипов", async () => {
    const { onChange } = renderBar();
    await screen.findByLabelText("Найти игру");
    expect(screen.queryByRole("button", { name: "Не запускались" })).toBeNull();
    const panel = await openPanel();
    const chip = within(panel).getByRole("button", { name: "Не запускались" });
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
    const panel = await openPanel();
    const chip = within(panel).getByRole("button", { name: "Не запускались" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_FILTERS, chips: [] });
  });

  it("в панели тир Proton «gold» ставит proton: gold", async () => {
    const { onChange } = renderBar();
    const panel = await openPanel();
    fireEvent.click(within(panel).getByRole("button", { name: "gold" }));
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_FILTERS,
      proton: "gold",
    });
  });

  it("Escape закрывает панель", async () => {
    renderBar();
    await openPanel();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("клик мимо панели закрывает её", async () => {
    renderBar();
    await openPanel();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("на кнопке число активных фильтров; при умолчаниях числа нет", async () => {
    renderBar({
      filters: { ...DEFAULT_FILTERS, status: "ready", sort: "name" },
    });
    const button = await screen.findByRole("button", { name: /Фильтры/ });
    expect(button.textContent).toContain("2");
  });

  it("при умолчаниях на кнопке только слово «Фильтры»", async () => {
    renderBar();
    const button = await screen.findByRole("button", { name: /Фильтры/ });
    expect(button.textContent?.trim()).toBe("Фильтры");
  });

  it("чип «Готовы к запуску» ставит status: ready, повторно — all", async () => {
    const { onChange } = renderBar();
    const chip = await screen.findByRole("button", {
      name: "Готовы к запуску",
    });
    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_FILTERS,
      status: "ready",
    });
  });

  it("чип «Нужна установка» при активном статусе сбрасывает его в all", async () => {
    const { onChange } = renderBar({
      filters: { ...DEFAULT_FILTERS, status: "installing" },
    });
    const chip = await screen.findByRole("button", { name: "Нужна установка" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_FILTERS,
      status: "all",
    });
  });

  it("чип «Играть бесплатно» заблокирован с title «Скоро»; «Из ящика» и «Нужен вход в Steam» в строке нет", async () => {
    renderBar();
    const chip = await screen.findByRole("button", {
      name: "Играть бесплатно",
    });
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    expect(chip.getAttribute("title")).toBe("Скоро");
    expect(screen.queryByRole("button", { name: "Из ящика" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Нужен вход в Steam" }),
    ).toBeNull();
  });

  it("«Сбросить» не отображается, когда фильтры по умолчанию (поиск не считается)", async () => {
    renderBar({ filters: { ...DEFAULT_FILTERS, q: "zelda" } });
    await screen.findByLabelText("Найти игру");
    expect(screen.queryByRole("button", { name: "Сбросить" })).toBeNull();
  });

  it("«Сбросить» виден при изменённых фильтрах и сбрасывает их, оставляя поиск", async () => {
    const { onChange } = renderBar({
      filters: { ...DEFAULT_FILTERS, status: "ready", q: "zelda" },
    });
    const reset = await screen.findByRole("button", { name: "Сбросить" });
    fireEvent.click(reset);
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_FILTERS, q: "zelda" });
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

  it("на узком экране «Фильтры» открывает шторку (onOpenSheet), а не панель", async () => {
    // Другие файлы подменяют `window.matchMedia` глобально (утечка на весь прогон),
    // поэтому не полагаемся на `innerWidth`, а подменяем сами и возвращаем как было.
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes("max-width"),
      }) as MediaQueryList) as typeof window.matchMedia;
    try {
      const { onOpenSheet } = renderBar();
      fireEvent.click(await screen.findByRole("button", { name: /Фильтры/ }));
      expect(onOpenSheet).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      window.matchMedia = original;
    }
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

  it("чипа «Из ящика» в шторке больше нет", () => {
    render(
      <FilterSheet
        open={true}
        filters={DEFAULT_FILTERS}
        onApply={() => {}}
        onClose={() => {}}
        countFor={countFor}
      />,
    );
    expect(screen.queryByRole("button", { name: "Из ящика" })).toBeNull();
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
