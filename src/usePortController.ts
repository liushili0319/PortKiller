import { useCallback, useMemo, useReducer, useRef } from "react";
import { defaultPortApi, type PortApi } from "./api";
import { resolveAdminRestart } from "./adminRestart";
import {
  filterPortEntries,
  findPortEntriesByPort,
  findRemainingPortOwners,
  formatError,
  portEntryId,
  protocolCounts,
  uniqueProcessCount,
  type PortEntry,
  type RuntimeContext,
  type TerminationStatus,
} from "./ports";
import { scanProgressSteps, type ScanProgress } from "./scanProgress";

export type ProtocolFilter = "ALL" | "TCP" | "UDP";
export type ScanStatus = "idle" | "loading" | "ready" | "failed";
export type OperationStatus = "idle" | "killing" | "elevating" | "revealing";
export type FeedbackSeverity = "info" | "success" | "warning" | "error";

type ActiveOperation = Exclude<OperationStatus, "idle">;
type OperationLease = {
  id: number;
  operation: ActiveOperation;
};

export type Feedback = {
  id: number;
  severity: FeedbackSeverity;
  title: string;
  message: string;
  origin: "scan" | "interaction";
};

export type PortControllerState = {
  entries: PortEntry[];
  selectedId: string | null;
  query: string;
  releasePort: string;
  protocol: ProtocolFilter;
  runtime: RuntimeContext;
  runtimeReady: boolean;
  scanStatus: ScanStatus;
  scanProgress: ScanProgress;
  scanRequestId: number;
  operation: OperationStatus;
  operationLeaseId: number | null;
  feedback: Feedback | null;
  lastRefresh: Date | null;
  confirmingId: string | null;
};

type Action =
  | { type: "scanStarted"; requestId: number }
  | { type: "scanProgressed"; requestId: number; progress: ScanProgress }
  | { type: "runtimeResolved"; requestId: number; runtime: RuntimeContext }
  | { type: "scanSucceeded"; requestId: number; entries: PortEntry[]; refreshedAt: Date }
  | { type: "scanFailed"; requestId: number; feedback: Feedback | null }
  | { type: "queryChanged"; query: string }
  | { type: "releasePortChanged"; releasePort: string }
  | { type: "protocolChanged"; protocol: ProtocolFilter }
  | { type: "entrySelected"; entryId: string }
  | { type: "portLocated"; entryId: string }
  | { type: "confirmationOpened"; entryId: string }
  | { type: "confirmationClosed" }
  | { type: "operationStarted"; lease: OperationLease }
  | { type: "operationFinished"; leaseId: number }
  | { type: "feedbackChanged"; feedback: Feedback | null };

const previewRuntime: RuntimeContext = {
  status: { is_windows: false, is_admin: false },
  capabilities: {
    mode: "preview",
    can_elevate: false,
    can_reveal_path: false,
    can_terminate: false,
  },
};

export const initialControllerState: PortControllerState = {
  entries: [],
  selectedId: null,
  query: "",
  releasePort: "",
  protocol: "ALL",
  runtime: previewRuntime,
  runtimeReady: false,
  scanStatus: "idle",
  scanProgress: scanProgressSteps.preparing,
  scanRequestId: 0,
  operation: "idle",
  operationLeaseId: null,
  feedback: null,
  lastRefresh: null,
  confirmingId: null,
};

export function portControllerReducer(
  state: PortControllerState,
  action: Action,
): PortControllerState {
  switch (action.type) {
    case "scanStarted":
      return {
        ...state,
        scanStatus: "loading",
        scanProgress: scanProgressSteps.checkingRuntime,
        scanRequestId: action.requestId,
        feedback: state.feedback?.origin === "scan" ? null : state.feedback,
      };
    case "scanProgressed":
      return action.requestId === state.scanRequestId
        ? { ...state, scanProgress: action.progress }
        : state;
    case "runtimeResolved":
      return action.requestId === state.scanRequestId
        ? { ...state, runtime: action.runtime, runtimeReady: true }
        : state;
    case "scanSucceeded": {
      if (action.requestId !== state.scanRequestId) {
        return state;
      }

      const nextIds = new Set(action.entries.map(portEntryId));
      const selectedId =
        state.selectedId && nextIds.has(state.selectedId)
          ? state.selectedId
          : action.entries[0]?.entry_id ?? null;

      return {
        ...state,
        entries: action.entries,
        selectedId,
        scanStatus: "ready",
        scanProgress: scanProgressSteps.complete,
        feedback: state.feedback?.origin === "scan" ? null : state.feedback,
        lastRefresh: action.refreshedAt,
      };
    }
    case "scanFailed":
      return action.requestId === state.scanRequestId
        ? {
            ...state,
            scanStatus: "failed",
            feedback: action.feedback ?? state.feedback,
          }
        : state;
    case "queryChanged":
      return { ...state, query: action.query };
    case "releasePortChanged":
      return { ...state, releasePort: action.releasePort };
    case "protocolChanged":
      return { ...state, protocol: action.protocol };
    case "entrySelected":
      return { ...state, selectedId: action.entryId };
    case "portLocated":
      return {
        ...state,
        selectedId: action.entryId,
        protocol: "ALL",
        query: "",
      };
    case "confirmationOpened":
      return { ...state, confirmingId: action.entryId };
    case "confirmationClosed":
      return { ...state, confirmingId: null };
    case "operationStarted":
      return {
        ...state,
        operation: action.lease.operation,
        operationLeaseId: action.lease.id,
      };
    case "operationFinished":
      return action.leaseId === state.operationLeaseId
        ? { ...state, operation: "idle", operationLeaseId: null }
        : state;
    case "feedbackChanged":
      return { ...state, feedback: action.feedback };
  }
}

export function terminationFeedbackSeverity(status: TerminationStatus): FeedbackSeverity {
  switch (status) {
    case "terminated":
      return "success";
    case "already_exited":
      return "info";
    case "rejected":
      return "warning";
    case "failed":
      return "error";
  }
}

function terminationFeedbackTitle(status: TerminationStatus) {
  switch (status) {
    case "terminated":
      return "终止完成";
    case "already_exited":
      return "进程已退出";
    case "rejected":
      return "操作被拒绝";
    case "failed":
      return "终止失败";
  }
}

export function protectionReasonLabel(reason: string) {
  switch (reason) {
    case "protected_process":
      return "系统保护目标";
    case "identity_unavailable":
      return "无法验证进程实例";
    case "":
      return "后端未授予终止能力";
    default:
      return reason.split("_").join(" ");
  }
}

type RefreshOptions = {
  reportError?: boolean;
};

export function usePortController(api: PortApi = defaultPortApi) {
  const [state, dispatch] = useReducer(portControllerReducer, initialControllerState);
  const scanSequence = useRef(0);
  const feedbackSequence = useRef(0);
  const operationSequence = useRef(0);
  const operationLease = useRef<OperationLease | null>(null);

  const createFeedback = useCallback(
    (
      severity: FeedbackSeverity,
      title: string,
      message: string,
      origin: Feedback["origin"] = "interaction",
    ): Feedback => ({
      id: ++feedbackSequence.current,
      severity,
      title,
      message,
      origin,
    }),
    [],
  );

  const beginOperation = useCallback((operation: ActiveOperation) => {
    if (operationLease.current) {
      return null;
    }

    const lease = { id: ++operationSequence.current, operation };
    operationLease.current = lease;
    dispatch({ type: "operationStarted", lease });
    return lease;
  }, []);

  const finishOperation = useCallback((lease: OperationLease) => {
    if (operationLease.current?.id !== lease.id) {
      return;
    }

    operationLease.current = null;
    dispatch({ type: "operationFinished", leaseId: lease.id });
  }, []);

  const refreshPorts = useCallback(
    async ({ reportError = true }: RefreshOptions = {}) => {
      const requestId = ++scanSequence.current;
      dispatch({ type: "scanStarted", requestId });

      try {
        const runtime = await api.getRuntimeContext();
        dispatch({ type: "runtimeResolved", requestId, runtime });
        dispatch({
          type: "scanProgressed",
          requestId,
          progress: scanProgressSteps.scanning,
        });

        const entries = await api.getPortEntries();
        dispatch({
          type: "scanProgressed",
          requestId,
          progress: scanProgressSteps.rendering,
        });
        dispatch({
          type: "scanSucceeded",
          requestId,
          entries,
          refreshedAt: new Date(),
        });

        return requestId === scanSequence.current ? entries : null;
      } catch (error) {
        dispatch({
          type: "scanFailed",
          requestId,
          feedback: reportError
            ? createFeedback("error", "扫描失败", formatError(error), "scan")
            : null,
        });
        return null;
      }
    },
    [api, createFeedback],
  );

  const filteredEntries = useMemo(() => {
    const queried = filterPortEntries(state.entries, state.query);
    return state.protocol === "ALL"
      ? queried
      : queried.filter((entry) => entry.protocol === state.protocol);
  }, [state.entries, state.protocol, state.query]);

  const selectedEntry = useMemo(
    () =>
      filteredEntries.find((entry) => entry.entry_id === state.selectedId) ??
      filteredEntries[0] ??
      null,
    [filteredEntries, state.selectedId],
  );

  const confirmingEntry = useMemo(
    () => state.entries.find((entry) => entry.entry_id === state.confirmingId) ?? null,
    [state.confirmingId, state.entries],
  );

  const releaseMatches = useMemo(
    () => findPortEntriesByPort(state.entries, state.releasePort),
    [state.entries, state.releasePort],
  );

  const counts = useMemo(() => protocolCounts(state.entries), [state.entries]);
  const visibleCounts = useMemo(() => protocolCounts(filteredEntries), [filteredEntries]);
  const processCount = useMemo(() => uniqueProcessCount(state.entries), [state.entries]);

  const setFeedback = useCallback(
    (severity: FeedbackSeverity, title: string, message: string) => {
      dispatch({ type: "feedbackChanged", feedback: createFeedback(severity, title, message) });
    },
    [createFeedback],
  );

  const locatePort = useCallback(() => {
    const portText = state.releasePort.trim();
    const port = Number(portText);

    if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
      setFeedback("error", "端口无效", "请输入 1 到 65535 之间的端口号。");
      return;
    }

    if (releaseMatches.length === 0) {
      setFeedback("warning", "未找到绑定", `端口 ${portText} 当前没有可见的占用记录。`);
      return;
    }

    const target =
      releaseMatches.find(
        (entry) => state.runtime.capabilities.can_terminate && entry.can_terminate,
      ) ?? releaseMatches[0];
    dispatch({ type: "portLocated", entryId: target.entry_id });

    if (!state.runtime.capabilities.can_terminate) {
      setFeedback(
        "info",
        "已定位端口",
        `找到 ${releaseMatches.length} 条记录；预览模式仅展示，不执行系统操作。`,
      );
      return;
    }

    if (!target.can_terminate) {
      setFeedback(
        "warning",
        "目标受限",
        `${target.process_name}：${protectionReasonLabel(target.protection_reason)}。`,
      );
      return;
    }

    if (operationLease.current) {
      setFeedback("info", "系统操作进行中", "已定位目标，请等待当前系统操作完成后再确认。");
      return;
    }

    setFeedback(
      "info",
      "已定位端口",
      `端口 ${target.port} 匹配 ${releaseMatches.length} 条记录，请核对目标后确认。`,
    );
    dispatch({ type: "confirmationOpened", entryId: target.entry_id });
  }, [releaseMatches, setFeedback, state.releasePort, state.runtime.capabilities.can_terminate]);

  const requestTermination = useCallback(
    (entry: PortEntry) => {
      if (!state.runtime.capabilities.can_terminate) {
        setFeedback("info", "预览模式", "当前环境仅展示端口数据，不提供终止操作。");
        return;
      }

      if (!entry.can_terminate) {
        setFeedback(
          "warning",
          "目标受限",
          `${entry.process_name}：${protectionReasonLabel(entry.protection_reason)}。`,
        );
        return;
      }

      if (operationLease.current) {
        setFeedback("info", "系统操作进行中", "请等待当前系统操作完成后再打开终止确认。");
        return;
      }

      dispatch({ type: "confirmationOpened", entryId: entry.entry_id });
    },
    [setFeedback, state.runtime.capabilities.can_terminate],
  );

  const confirmTermination = useCallback(async () => {
    if (!confirmingEntry) {
      return;
    }

    const lease = beginOperation("killing");
    if (!lease) {
      return;
    }

    const target = confirmingEntry;

    try {
      const outcome = await api.killPortProcess(target);
      dispatch({ type: "confirmationClosed" });
      const refreshedEntries = await refreshPorts({ reportError: false });
      const remainingOwners = refreshedEntries
        ? findRemainingPortOwners(refreshedEntries, target)
        : [];
      const remainingNote =
        outcome.status === "terminated" && remainingOwners.length > 0
          ? ` 端口仍由 ${remainingOwners.length} 个进程绑定，请查看刷新后的列表。`
          : "";

      setFeedback(
        terminationFeedbackSeverity(outcome.status),
        terminationFeedbackTitle(outcome.status),
        `${target.process_name} · PID ${outcome.pid}：${outcome.message}${remainingNote}`,
      );
    } catch (error) {
      dispatch({ type: "confirmationClosed" });
      setFeedback("error", "命令执行失败", formatError(error));
    } finally {
      finishOperation(lease);
    }
  }, [api, beginOperation, confirmingEntry, finishOperation, refreshPorts, setFeedback]);

  const requestAdminRestart = useCallback(async () => {
    if (!state.runtime.capabilities.can_elevate) {
      setFeedback("info", "当前环境不支持", "预览模式不能请求管理员权限。");
      return;
    }

    const lease = beginOperation("elevating");
    if (!lease) {
      return;
    }

    try {
      const result = await resolveAdminRestart(api.restartAsAdmin);

      if (result.error) {
        setFeedback("error", "提权失败", result.error);
      } else {
        setFeedback("info", "等待 UAC 确认", result.notice);
      }
    } finally {
      finishOperation(lease);
    }
  }, [
    api.restartAsAdmin,
    beginOperation,
    finishOperation,
    setFeedback,
    state.runtime.capabilities.can_elevate,
  ]);

  const revealProcess = useCallback(
    async (entry: PortEntry) => {
      if (!state.runtime.capabilities.can_reveal_path) {
        setFeedback("info", "预览模式", "当前环境不能打开本机进程目录。");
        return;
      }

      if (!entry.process_path.trim()) {
        setFeedback("warning", "路径不可用", "后端没有返回可打开的进程路径。");
        return;
      }

      const lease = beginOperation("revealing");
      if (!lease) {
        return;
      }

      try {
        await api.revealProcessPath(entry.process_path);
        setFeedback("info", "已打开目录", entry.process_path);
      } catch (error) {
        setFeedback("error", "打开目录失败", formatError(error));
      } finally {
        finishOperation(lease);
      }
    },
    [
      api,
      beginOperation,
      finishOperation,
      setFeedback,
      state.runtime.capabilities.can_reveal_path,
    ],
  );

  const copyValue = useCallback(
    async (label: string, value: string | number) => {
      const text = String(value).trim();

      if (!text) {
        setFeedback("warning", "无法复制", `${label}为空。`);
        return;
      }

      try {
        await navigator.clipboard.writeText(text);
        setFeedback("info", "已复制", `${label}已写入剪贴板。`);
      } catch (error) {
        setFeedback("error", "复制失败", formatError(error));
      }
    },
    [setFeedback],
  );

  return {
    state,
    filteredEntries,
    selectedEntry,
    confirmingEntry,
    releaseMatches,
    counts,
    visibleCounts,
    processCount,
    refreshPorts,
    setQuery: (query: string) => dispatch({ type: "queryChanged", query }),
    setReleasePort: (releasePort: string) =>
      dispatch({ type: "releasePortChanged", releasePort }),
    setProtocol: (protocol: ProtocolFilter) =>
      dispatch({ type: "protocolChanged", protocol }),
    selectEntry: (entry: PortEntry) =>
      dispatch({ type: "entrySelected", entryId: entry.entry_id }),
    locatePort,
    requestTermination,
    closeConfirmation: () => dispatch({ type: "confirmationClosed" }),
    confirmTermination,
    requestAdminRestart,
    revealProcess,
    copyValue,
    clearFeedback: () => dispatch({ type: "feedbackChanged", feedback: null }),
  };
}

export type PortController = ReturnType<typeof usePortController>;
