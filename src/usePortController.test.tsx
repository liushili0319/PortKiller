import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { sampleEntries, type PortApi } from "./api";
import type { PortEntry, RuntimeContext, TerminationOutcome } from "./ports";
import {
  initialControllerState,
  portControllerReducer,
  terminationFeedbackSeverity,
  usePortController,
} from "./usePortController";

const previewRuntime: RuntimeContext = {
  status: { is_windows: false, is_admin: false },
  capabilities: {
    mode: "preview",
    can_elevate: false,
    can_reveal_path: false,
    can_terminate: false,
  },
};

const desktopRuntime: RuntimeContext = {
  status: { is_windows: true, is_admin: true },
  capabilities: {
    mode: "desktop",
    can_elevate: true,
    can_reveal_path: true,
    can_terminate: true,
  },
};

function fakeApi(overrides: Partial<PortApi> = {}): PortApi {
  return {
    getRuntimeContext: vi.fn(async () => previewRuntime),
    getPortEntries: vi.fn(async () => sampleEntries),
    killPortProcess: vi.fn(
      async (entry): Promise<TerminationOutcome> => ({
        pid: entry.pid,
        status: "terminated",
        reason: "confirmed",
        message: "confirmed",
      }),
    ),
    restartAsAdmin: vi.fn(async () => undefined),
    revealProcessPath: vi.fn(async () => undefined),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("termination feedback", () => {
  it.each([
    ["terminated", "success"],
    ["already_exited", "info"],
    ["rejected", "warning"],
    ["failed", "error"],
  ] as const)("maps %s to %s", (status, severity) => {
    expect(terminationFeedbackSeverity(status)).toBe(severity);
  });
});

describe("controller reducer", () => {
  it("clears stale scan feedback when retry starts but preserves interaction feedback", () => {
    const scanFeedback = {
      id: 1,
      severity: "error" as const,
      title: "扫描失败",
      message: "unavailable",
      origin: "scan" as const,
    };
    const interactionFeedback = {
      ...scanFeedback,
      id: 2,
      title: "终止失败",
      origin: "interaction" as const,
    };

    const retryingScan = portControllerReducer(
      { ...initialControllerState, feedback: scanFeedback },
      { type: "scanStarted", requestId: 1 },
    );
    expect(retryingScan.feedback).toBeNull();

    const retryingAfterInteraction = portControllerReducer(
      { ...initialControllerState, feedback: interactionFeedback },
      { type: "scanStarted", requestId: 1 },
    );
    expect(retryingAfterInteraction.feedback).toEqual(interactionFeedback);
  });

  it("preserves selection only while the opaque backend id still exists", () => {
    const first = sampleEntries[0];
    const second = sampleEntries[1];
    let state = portControllerReducer(initialControllerState, {
      type: "scanStarted",
      requestId: 1,
    });
    state = portControllerReducer(state, {
      type: "scanSucceeded",
      requestId: 1,
      entries: [first, second],
      refreshedAt: new Date(1),
    });
    state = portControllerReducer(state, {
      type: "entrySelected",
      entryId: second.entry_id,
    });
    state = portControllerReducer(state, {
      type: "scanStarted",
      requestId: 2,
    });
    state = portControllerReducer(state, {
      type: "scanSucceeded",
      requestId: 2,
      entries: [{ ...second }],
      refreshedAt: new Date(2),
    });
    expect(state.selectedId).toBe(second.entry_id);

    state = portControllerReducer(state, {
      type: "scanStarted",
      requestId: 3,
    });
    state = portControllerReducer(state, {
      type: "scanSucceeded",
      requestId: 3,
      entries: [first],
      refreshedAt: new Date(3),
    });
    expect(state.selectedId).toBe(first.entry_id);
  });

  it("ignores completion from an older system-operation lease", () => {
    let state = portControllerReducer(initialControllerState, {
      type: "operationStarted",
      lease: { id: 1, operation: "revealing" },
    });
    state = portControllerReducer(state, {
      type: "operationStarted",
      lease: { id: 2, operation: "killing" },
    });
    state = portControllerReducer(state, {
      type: "operationFinished",
      leaseId: 1,
    });

    expect(state.operation).toBe("killing");
    expect(state.operationLeaseId).toBe(2);

    state = portControllerReducer(state, {
      type: "operationFinished",
      leaseId: 2,
    });
    expect(state.operation).toBe("idle");
    expect(state.operationLeaseId).toBeNull();
  });
});

describe("usePortController", () => {
  it("ignores an older scan that resolves after a newer request", async () => {
    let resolveFirst: (entries: PortEntry[]) => void = () => undefined;
    let resolveSecond: (entries: PortEntry[]) => void = () => undefined;
    const first = new Promise<PortEntry[]>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<PortEntry[]>((resolve) => {
      resolveSecond = resolve;
    });
    const api = fakeApi({
      getRuntimeContext: vi.fn(async () => desktopRuntime),
      getPortEntries: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
    });
    const { result } = renderHook(() => usePortController(api));

    let firstRefresh: Promise<PortEntry[] | null>;
    let secondRefresh: Promise<PortEntry[] | null>;
    act(() => {
      firstRefresh = result.current.refreshPorts();
      secondRefresh = result.current.refreshPorts();
    });
    await waitFor(() => expect(api.getPortEntries).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveSecond([sampleEntries[1]]);
      await secondRefresh;
    });
    expect(result.current.state.entries).toEqual([sampleEntries[1]]);

    await act(async () => {
      resolveFirst([sampleEntries[0]]);
      await firstRefresh;
    });
    expect(result.current.state.entries).toEqual([sampleEntries[1]]);
  });

  it("keeps exact-port targeting read-only in preview mode", async () => {
    const api = fakeApi();
    const { result } = renderHook(() => usePortController(api));

    await act(async () => {
      await result.current.refreshPorts();
    });
    act(() => result.current.setReleasePort(String(sampleEntries[0].port)));
    act(() => result.current.locatePort());

    expect(result.current.selectedEntry?.entry_id).toBe(sampleEntries[0].entry_id);
    expect(result.current.confirmingEntry).toBeNull();
    expect(result.current.state.feedback?.severity).toBe("info");
    expect(api.killPortProcess).not.toHaveBeenCalled();
  });

  it("serializes reveal, elevation, and termination requests", async () => {
    const revealRequest = deferred<void>();
    const elevationRequest = deferred<void>();
    const terminationRequest = deferred<TerminationOutcome>();
    const api = fakeApi({
      getRuntimeContext: vi.fn(async () => desktopRuntime),
      revealProcessPath: vi.fn(() => revealRequest.promise),
      restartAsAdmin: vi.fn(() => elevationRequest.promise),
      killPortProcess: vi.fn(() => terminationRequest.promise),
    });
    const { result } = renderHook(() => usePortController(api));
    const target = sampleEntries[0];

    await act(async () => {
      await result.current.refreshPorts();
    });
    act(() => result.current.requestTermination(target));

    let revealRun = Promise.resolve();
    act(() => {
      revealRun = result.current.revealProcess(target);
    });
    expect(result.current.state.operation).toBe("revealing");

    await act(async () => {
      await Promise.all([
        result.current.requestAdminRestart(),
        result.current.confirmTermination(),
      ]);
    });
    expect(api.restartAsAdmin).not.toHaveBeenCalled();
    expect(api.killPortProcess).not.toHaveBeenCalled();

    await act(async () => {
      revealRequest.resolve(undefined);
      await revealRun;
    });
    expect(result.current.state.operation).toBe("idle");

    let elevationRun = Promise.resolve();
    act(() => {
      elevationRun = result.current.requestAdminRestart();
    });
    expect(result.current.state.operation).toBe("elevating");

    await act(async () => {
      await Promise.all([
        result.current.revealProcess(target),
        result.current.confirmTermination(),
      ]);
    });
    expect(api.revealProcessPath).toHaveBeenCalledTimes(1);
    expect(api.killPortProcess).not.toHaveBeenCalled();

    await act(async () => {
      elevationRequest.resolve(undefined);
      await elevationRun;
    });
    expect(result.current.state.operation).toBe("idle");

    let firstTerminationRun = Promise.resolve();
    let duplicateTerminationRun = Promise.resolve();
    act(() => {
      firstTerminationRun = result.current.confirmTermination();
      duplicateTerminationRun = result.current.confirmTermination();
      void result.current.revealProcess(target);
      void result.current.requestAdminRestart();
    });

    expect(result.current.state.operation).toBe("killing");
    expect(api.killPortProcess).toHaveBeenCalledTimes(1);
    expect(api.revealProcessPath).toHaveBeenCalledTimes(1);
    expect(api.restartAsAdmin).toHaveBeenCalledTimes(1);

    await act(async () => {
      terminationRequest.resolve({
        pid: target.pid,
        status: "terminated",
        reason: "confirmed",
        message: "confirmed",
      });
      await Promise.all([firstTerminationRun, duplicateTerminationRun]);
    });
    expect(result.current.state.operation).toBe("idle");
    expect(result.current.confirmingEntry).toBeNull();
  });

  it("reports scan failures without discarding entries and clears them after retry", async () => {
    const api = fakeApi();
    const { result } = renderHook(() => usePortController(api));

    await act(async () => {
      await result.current.refreshPorts();
    });
    vi.mocked(api.getPortEntries).mockRejectedValueOnce(new Error("inventory unavailable"));
    await act(async () => {
      await result.current.refreshPorts();
    });

    expect(result.current.state.scanStatus).toBe("failed");
    expect(result.current.state.entries).toEqual(sampleEntries);
    expect(result.current.state.feedback).toMatchObject({
      severity: "error",
      title: "扫描失败",
      message: "inventory unavailable",
    });

    await act(async () => {
      await result.current.refreshPorts();
    });

    expect(result.current.state.scanStatus).toBe("ready");
    expect(result.current.state.entries).toEqual(sampleEntries);
    expect(result.current.state.feedback).toBeNull();
  });
});
