// `cardAction` — действие кнопки карточки игры на главной `/app`, чистая логика без React.
import { describe, expect, it } from "bun:test";
import type { SessionView } from "@cg/rpc";
import { cardAction, type LibraryPlay } from "../src/lib/cardAction";

const session: SessionView = {
  id: "s1",
  appId: 620,
  gameName: "Portal 2",
  state: "playing",
  streamReady: true,
  failReason: null,
  idleDeadline: null,
  installPercent: null,
  stage: null,
  installStage: null,
  hadInstall: false,
  playedSeconds: 10,
  createdAt: "2026-10-23T00:00:00.000Z",
};

const basePlay: LibraryPlay = {
  active: null,
  startingAppId: null,
  onPlay: () => {},
  onResume: () => {},
};

describe("cardAction", () => {
  it("resume: active session for the same appId", () => {
    const play: LibraryPlay = { ...basePlay, active: session };
    expect(cardAction({ appId: 620 }, play)).toEqual({
      kind: "resume",
      onResume: play.onResume,
    });
  });

  it("blocked: active session for another appId", () => {
    const play: LibraryPlay = { ...basePlay, active: session };
    expect(cardAction({ appId: 10 }, play)).toEqual({ kind: "blocked" });
  });

  it("play with disabled=true while active is undefined (not yet loaded)", () => {
    const play: LibraryPlay = { ...basePlay, active: undefined };
    const action = cardAction({ appId: 620 }, play);
    expect(action.kind).toBe("play");
    if (action.kind === "play") {
      expect(action.disabled).toBe(true);
      expect(action.pending).toBe(false);
    }
  });

  it("play: no active session, not disabled, not pending", () => {
    const play: LibraryPlay = { ...basePlay, active: null };
    const action = cardAction({ appId: 620 }, play);
    expect(action.kind).toBe("play");
    if (action.kind === "play") {
      expect(action.disabled).toBe(false);
      expect(action.pending).toBe(false);
    }
  });

  it("play: pending while this app is starting (disabled covers any app starting)", () => {
    const play: LibraryPlay = {
      ...basePlay,
      active: null,
      startingAppId: 620,
    };
    const action = cardAction({ appId: 620 }, play);
    expect(action.kind).toBe("play");
    if (action.kind === "play") {
      expect(action.pending).toBe(true);
      expect(action.disabled).toBe(true);
    }
  });
});
