import { describe, expect, it, vi } from "vitest";
import { resolveAdminRestart } from "./adminRestart";

describe("resolveAdminRestart", () => {
  it("reenables the admin restart action after a successful request", async () => {
    const restartAsAdmin = vi.fn().mockResolvedValue(undefined);

    await expect(resolveAdminRestart(restartAsAdmin)).resolves.toEqual({
      restarting: false,
      notice: "已请求管理员权限，请在弹出的窗口中确认。",
      error: "",
    });
  });

  it("reenables the admin restart action after a failed request", async () => {
    const restartAsAdmin = vi.fn().mockRejectedValue(new Error("用户取消了 UAC。"));

    await expect(resolveAdminRestart(restartAsAdmin)).resolves.toEqual({
      restarting: false,
      notice: "",
      error: "用户取消了 UAC。",
    });
  });
});
