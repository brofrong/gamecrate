import { describe, expect, it } from "bun:test";
import { canUnlink, isSyntheticEmail } from "../src/loginMethods";

describe("isSyntheticEmail", () => {
  it("synthetic emails are recognised", () => {
    expect(isSyntheticEmail("steam_7656@steam.local")).toBe(true);
    expect(isSyntheticEmail("tg_42@telegram.invalid")).toBe(true);
    expect(isSyntheticEmail("ivan@gmail.com")).toBe(false);
  });
});

describe("canUnlink", () => {
  it("unlinking google with only steam left is refused", () =>
    expect(
      canUnlink(
        [{ providerId: "google" }, { providerId: "steam-openid" }],
        "google",
        { email: "tg_1@telegram.invalid", emailVerified: false },
      ),
    ).toBe(false));

  it("unlinking steam is always allowed", () =>
    expect(
      canUnlink(
        [{ providerId: "google" }, { providerId: "steam-openid" }],
        "steam-openid",
        { email: "tg_1@telegram.invalid", emailVerified: false },
      ),
    ).toBe(true));

  it("verified real email counts as a login method", () =>
    expect(
      canUnlink([{ providerId: "google" }], "google", {
        email: "ivan@gmail.com",
        emailVerified: true,
      }),
    ).toBe(true));

  it("unverified email does not count", () =>
    expect(
      canUnlink([{ providerId: "google" }], "google", {
        email: "ivan@gmail.com",
        emailVerified: false,
      }),
    ).toBe(false));
});
