import { describe, expect, it } from "vitest";
import { progressBarStyle, scanProgressSteps } from "./scanProgress";

describe("progressBarStyle", () => {
  it("clamps progress values into a percent width", () => {
    expect(progressBarStyle({ label: "Too low", value: -12 })).toEqual({ width: "0%" });
    expect(progressBarStyle(scanProgressSteps.scanning)).toEqual({ width: "62%" });
    expect(progressBarStyle({ label: "Too high", value: 180 })).toEqual({ width: "100%" });
  });
});
