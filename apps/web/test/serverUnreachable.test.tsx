import { describe, expect, it, mock } from "bun:test";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { ServerUnreachable } from "../src/components/ServerUnreachable";
import { useStalled } from "../src/lib/useStalled";

describe("server unreachable", () => {
  it("server unreachable state renders message and retry button", () => {
    const onRetry = mock(() => {});
    render(<ServerUnreachable onRetry={onRetry} />);
    expect(screen.getByText("Не удалось связаться с сервером")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("useStalled flips after the timeout and restarts on retry", async () => {
    const { result, rerender } = renderHook(
      ({ pending }) => useStalled(pending, 20),
      { initialProps: { pending: true } },
    );
    expect(result.current[0]).toBe(false);
    await waitFor(() => expect(result.current[0]).toBe(true));

    act(() => result.current[1]());
    expect(result.current[0]).toBe(false);
    await waitFor(() => expect(result.current[0]).toBe(true));

    rerender({ pending: false });
    expect(result.current[0]).toBe(false);
  });
});
