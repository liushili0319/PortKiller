import { afterEach, describe, expect, it, vi } from "vitest";
import { afterStartupPaint } from "./startup";

describe("afterStartupPaint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("runs startup work after two animation frames when frames are available", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const callback = vi.fn();
    afterStartupPaint(callback);

    expect(callback).not.toHaveBeenCalled();

    frameCallbacks.shift()?.(0);
    expect(callback).not.toHaveBeenCalled();

    frameCallbacks.shift()?.(16);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("falls back to a timeout when animation frames do not run", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", undefined);

    const callback = vi.fn();
    afterStartupPaint(callback, 120);

    vi.advanceTimersByTime(119);
    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("cancels pending startup work", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", undefined);

    const callback = vi.fn();
    const cancel = afterStartupPaint(callback, 120);

    cancel();
    vi.advanceTimersByTime(120);

    expect(callback).not.toHaveBeenCalled();
  });
});
