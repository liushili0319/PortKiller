import { invoke } from "@tauri-apps/api/tauri";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeContext,
  killPortProcess,
  sampleEntries,
} from "./api";

vi.mock("@tauri-apps/api/tauri", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  appWindow: { show: vi.fn(), setFocus: vi.fn() },
}));

function enableDesktopRuntime() {
  Object.defineProperty(window, "__TAURI_IPC__", {
    configurable: true,
    value: () => undefined,
  });
}

describe("runtime capabilities", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_IPC__");
  });

  it("turns every system action off in preview mode", async () => {
    await expect(getRuntimeContext()).resolves.toEqual({
      status: { is_windows: false, is_admin: false },
      capabilities: {
        mode: "preview",
        can_elevate: false,
        can_reveal_path: false,
        can_terminate: false,
      },
    });
  });

  it("enables the Windows desktop command surface in Tauri", async () => {
    enableDesktopRuntime();
    vi.mocked(invoke).mockResolvedValueOnce({ is_windows: true, is_admin: false });

    await expect(getRuntimeContext()).resolves.toEqual({
      status: { is_windows: true, is_admin: false },
      capabilities: {
        mode: "desktop",
        can_elevate: true,
        can_reveal_path: true,
        can_terminate: true,
      },
    });
  });
});

describe("preview samples", () => {
  it("carry complete backend identity fields and an IPv6 endpoint", () => {
    expect(sampleEntries.some((entry) => entry.endpoint.address_family === "ipv6")).toBe(true);

    for (const entry of sampleEntries) {
      expect(entry.entry_id).not.toBe("");
      expect(entry.process_instance_id).toMatch(/^[0-9a-f]{16}$/);
      expect(entry.endpoint.protocol).toBe(entry.protocol);
      expect(entry.endpoint.local_port).toBe(entry.port);

      if (entry.protocol === "TCP") {
        expect(entry.endpoint.remote_ip).not.toBeNull();
        expect(entry.endpoint.remote_scope_id).not.toBeNull();
        expect(entry.endpoint.remote_port).not.toBeNull();
      } else {
        expect(entry.endpoint.remote_ip).toBeNull();
        expect(entry.endpoint.remote_scope_id).toBeNull();
        expect(entry.endpoint.remote_port).toBeNull();
      }
    }
  });
});

describe("killPortProcess", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_IPC__");
  });

  it("forwards the four backend-issued request fields without rebuilding them", async () => {
    enableDesktopRuntime();
    const entry = sampleEntries[1];
    const outcome = {
      pid: entry.pid,
      status: "terminated" as const,
      reason: "confirmed" as const,
      message: "confirmed",
    };
    vi.mocked(invoke).mockResolvedValueOnce(outcome);

    await expect(killPortProcess(entry)).resolves.toEqual(outcome);
    expect(invoke).toHaveBeenCalledWith("kill_port_process", {
      request: {
        entry_id: entry.entry_id,
        pid: entry.pid,
        endpoint: entry.endpoint,
        process_instance_id: entry.process_instance_id,
      },
    });
  });

  it("fails closed without invoking Tauri in preview mode", async () => {
    await expect(killPortProcess(sampleEntries[0])).resolves.toMatchObject({
      status: "failed",
      reason: "unsupported_platform",
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
