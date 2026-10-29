// Захват мыши в полном экране (слово владельца 2026-10-29): клик по игре захватывает мышь на
// элементе ввода Selkies — тогда Selkies шлёт в игру движение, а не положение курсора.
import { describe, expect, it, mock } from "bun:test";
import { lockPointerOnClick } from "../src/lib/fullscreen";

/** Окно iframe Selkies: свой документ (события) и элемент ввода `webrtcInput.element`. */
const fakeFrame = () => {
  const doc = new EventTarget() as EventTarget & {
    pointerLockElement: Element | null;
    exitPointerLock: () => void;
  };
  doc.pointerLockElement = null;
  doc.exitPointerLock = mock(() => {
    doc.pointerLockElement = null;
  });
  const element = {
    requestPointerLock: mock(async () => {
      doc.pointerLockElement = element as unknown as Element;
    }),
  };
  const frameEvents = new EventTarget();
  const frame = {
    contentWindow: { webrtcInput: { element } },
    contentDocument: doc,
    addEventListener: frameEvents.addEventListener.bind(frameEvents),
    removeEventListener: frameEvents.removeEventListener.bind(frameEvents),
    dispatchEvent: frameEvents.dispatchEvent.bind(frameEvents),
  };
  return { frame: frame as unknown as HTMLIFrameElement, doc, element };
};

const press = (target: EventTarget, button = 0) =>
  target.dispatchEvent(Object.assign(new Event("mousedown"), { button }));

describe("lockPointerOnClick", () => {
  it("left click locks the pointer on the Selkies input element", async () => {
    const { frame, doc, element } = fakeFrame();
    lockPointerOnClick(frame);
    press(doc, 2);
    expect(element.requestPointerLock).not.toHaveBeenCalled();
    press(doc);
    expect(element.requestPointerLock).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    // Уже захвачено — повторный клик идёт в игру, не перезахватывает.
    press(doc);
    expect(element.requestPointerLock).toHaveBeenCalledTimes(1);
  });

  it("stop releases the lock and ignores further clicks", async () => {
    const { frame, doc, element } = fakeFrame();
    const stop = lockPointerOnClick(frame);
    press(doc);
    await Promise.resolve();
    stop();
    expect(doc.exitPointerLock).toHaveBeenCalledTimes(1);
    press(doc);
    expect(element.requestPointerLock).toHaveBeenCalledTimes(1);
  });

  it("re-attaches to the new document after the frame reloads", () => {
    const { frame, element } = fakeFrame();
    lockPointerOnClick(frame);
    const reloaded = fakeFrame();
    Object.assign(frame, {
      contentWindow: reloaded.frame.contentWindow,
      contentDocument: reloaded.doc,
    });
    frame.dispatchEvent(new Event("load"));
    press(reloaded.doc);
    expect(reloaded.element.requestPointerLock).toHaveBeenCalledTimes(1);
    expect(element.requestPointerLock).not.toHaveBeenCalled();
  });

  it("no Selkies input yet — click does nothing", () => {
    const { frame, doc } = fakeFrame();
    Object.assign(frame, { contentWindow: {} });
    lockPointerOnClick(frame);
    expect(() => press(doc)).not.toThrow();
  });
});
