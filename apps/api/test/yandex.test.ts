// Маппинг профиля Яндекс.ID (generic OAuth) на локального пользователя.
import { describe, expect, it } from "bun:test";
import { yandexUserInfo } from "../src/auth/yandex";

describe("yandexUserInfo", () => {
  it("maps yandex info with avatar", () =>
    expect(
      yandexUserInfo({
        id: "1",
        default_email: "a@yandex.ru",
        display_name: "Аня",
        default_avatar_id: "0/0-0",
        is_avatar_empty: false,
      }),
    ).toEqual({
      id: "1",
      email: "a@yandex.ru",
      emailVerified: true,
      name: "Аня",
      image: "https://avatars.yandex.net/get-yapic/0/0-0/islands-200",
    }));

  it("yandex without email is rejected", () =>
    expect(yandexUserInfo({ id: "1" })).toBeNull());

  it("yandex falls back to login for the name and null avatar", () =>
    expect(
      yandexUserInfo({
        id: "1",
        default_email: "a@yandex.ru",
        login: "anya",
        is_avatar_empty: true,
      }),
    ).toEqual({
      id: "1",
      email: "a@yandex.ru",
      emailVerified: true,
      name: "anya",
      image: null,
    }));
});
