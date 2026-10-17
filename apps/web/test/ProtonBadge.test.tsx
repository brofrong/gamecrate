import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ProtonBadge } from "../src/components/ProtonBadge";

describe("ProtonBadge", () => {
  it("ProtonBadge shows russian label per tier", () => {
    render(<ProtonBadge tier="gold" />);
    expect(screen.getByText("Работает после мелких настроек")).toBeTruthy();
  });

  it("ProtonBadge shows «Нет данных» for pending", () => {
    render(<ProtonBadge tier="pending" />);
    expect(screen.getByText("Нет данных")).toBeTruthy();
  });
});
