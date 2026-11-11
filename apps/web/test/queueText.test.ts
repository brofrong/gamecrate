// Строка очереди на экране загрузки (дизайн §5/§7, спека §5, бриф задачи 11):
// место, сколько ждут (с русским склонением «человек/человека») и оценка времени
// («≈ N мин» / «оцениваем…» / «больше часа»).
import { describe, expect, it } from "bun:test";
import type { SessionQueue } from "@cg/rpc";
import { queueLine } from "../src/lib/queueText";

const queue = (
  patch: Partial<SessionQueue> & { position: number; total: number },
): SessionQueue => ({
  etaMinutes: null,
  ...patch,
});

describe("queueLine", () => {
  it("renders position, total and the eta estimate", () => {
    expect(queueLine({ position: 3, total: 7, etaMinutes: 10 })).toBe(
      "Вы 3-й в очереди · ждут 7 человек · ≈ 10 мин",
    );
  });

  it("switches to «человека» for 2–4, except 12–14", () => {
    expect(queueLine(queue({ position: 1, total: 2, etaMinutes: 5 }))).toBe(
      "Вы 1-й в очереди · ждут 2 человека · ≈ 5 мин",
    );
    expect(queueLine(queue({ position: 1, total: 4, etaMinutes: 5 }))).toBe(
      "Вы 1-й в очереди · ждут 4 человека · ≈ 5 мин",
    );
    // 22 — последняя цифра 2, но не 12–14 — «человека».
    expect(queueLine(queue({ position: 1, total: 22, etaMinutes: 5 }))).toBe(
      "Вы 1-й в очереди · ждут 22 человека · ≈ 5 мин",
    );
    // 12 — исключение диапазона 12–14 — «человек», как и 11.
    expect(queueLine(queue({ position: 1, total: 12, etaMinutes: 5 }))).toBe(
      "Вы 1-й в очереди · ждут 12 человек · ≈ 5 мин",
    );
    expect(queueLine(queue({ position: 1, total: 11, etaMinutes: 5 }))).toBe(
      "Вы 1-й в очереди · ждут 11 человек · ≈ 5 мин",
    );
    expect(queueLine(queue({ position: 1, total: 5, etaMinutes: 5 }))).toBe(
      "Вы 1-й в очереди · ждут 5 человек · ≈ 5 мин",
    );
  });

  it("eta null shows «оцениваем…», 61 shows «больше часа»", () => {
    expect(queueLine(queue({ position: 2, total: 3, etaMinutes: null }))).toBe(
      "Вы 2-й в очереди · ждут 3 человека · оцениваем…",
    );
    expect(queueLine(queue({ position: 2, total: 3, etaMinutes: 61 }))).toBe(
      "Вы 2-й в очереди · ждут 3 человека · больше часа",
    );
  });
});
