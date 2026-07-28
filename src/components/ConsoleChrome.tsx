import {
  Activity,
  Clock3,
  EthernetPort,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  SearchCheck,
  Shield,
  ShieldAlert,
} from "lucide-react";
import type { FormEvent } from "react";
import type { RuntimeContext } from "../ports";
import type {
  OperationStatus,
  ProtocolFilter,
  ScanStatus,
} from "../usePortController";
import type { ScanProgress } from "../scanProgress";

function formatDateTime(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

type CommandHeaderProps = {
  runtime: RuntimeContext;
  runtimeReady: boolean;
  operation: OperationStatus;
  scanStatus: ScanStatus;
  lastRefresh: Date | null;
  onRefresh: () => void;
  onElevate: () => void;
};

export function CommandHeader({
  runtime,
  runtimeReady,
  operation,
  scanStatus,
  lastRefresh,
  onRefresh,
  onElevate,
}: CommandHeaderProps) {
  const isPreview = runtime.capabilities.mode === "preview";
  const statusLabel = !runtimeReady
    ? "检测运行环境"
    : isPreview
      ? "交互预览"
      : runtime.status.is_admin
        ? "管理员模式"
        : "标准权限";
  const StatusIcon = !runtimeReady
    ? Loader2
    : isPreview
      ? Activity
      : runtime.status.is_admin
        ? Shield
        : ShieldAlert;

  return (
    <header className="command-header">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          <EthernetPort size={21} strokeWidth={2.3} />
        </div>
        <div>
          <p className="eyebrow">Endpoint authority / local</p>
          <h1>PortKiller</h1>
        </div>
      </div>

      <div className="header-telemetry" aria-label="运行状态与刷新控制">
        <span className="refresh-stamp" title="最近完成扫描时间">
          <Clock3 size={14} aria-hidden="true" />
          {lastRefresh ? formatDateTime(lastRefresh) : "--:--:--"}
        </span>
        <span
          className={`runtime-badge ${
            !runtimeReady ? "pending" : isPreview ? "preview" : runtime.status.is_admin ? "admin" : "limited"
          }`}
        >
          <StatusIcon
            className={!runtimeReady ? "spin" : undefined}
            size={15}
            aria-hidden="true"
          />
          {statusLabel}
        </span>
        {runtimeReady &&
          runtime.capabilities.can_elevate &&
          !runtime.status.is_admin && (
            <button
              className="button secondary"
              type="button"
              onClick={onElevate}
              disabled={operation !== "idle"}
            >
              {operation === "elevating" ? (
                <Loader2 className="spin" size={15} aria-hidden="true" />
              ) : (
                <KeyRound size={15} aria-hidden="true" />
              )}
              管理员重启
            </button>
          )}
        <button
          className="button primary"
          type="button"
          onClick={onRefresh}
          disabled={scanStatus === "loading"}
        >
          {scanStatus === "loading" ? (
            <Loader2 className="spin" size={16} aria-hidden="true" />
          ) : (
            <RefreshCw size={16} aria-hidden="true" />
          )}
          刷新
        </button>
      </div>
    </header>
  );
}

type SignalRailProps = {
  total: number;
  visible: number;
  tcp: number;
  udp: number;
  processes: number;
  scanStatus: ScanStatus;
  scanProgress: ScanProgress;
};

export function SignalRail({
  total,
  visible,
  tcp,
  udp,
  processes,
  scanStatus,
  scanProgress,
}: SignalRailProps) {
  const scanLabel =
    scanStatus === "failed"
      ? "扫描异常"
      : scanStatus === "loading"
        ? scanProgress.label
        : scanStatus === "ready"
          ? "数据就绪"
          : "等待扫描";

  return (
    <section className="signal-rail" aria-label="端点扫描概览">
      <div className={`scan-signal ${scanStatus}`}>
        <span className="signal-pulse" aria-hidden="true" />
        <span aria-live="polite">{scanLabel}</span>
      </div>
      <dl>
        <div>
          <dt>可见 / 总计</dt>
          <dd>{visible} / {total}</dd>
        </div>
        <div className="tcp-signal">
          <dt>TCP</dt>
          <dd>{tcp}</dd>
        </div>
        <div className="udp-signal">
          <dt>UDP</dt>
          <dd>{udp}</dd>
        </div>
        <div>
          <dt>进程</dt>
          <dd>{processes}</dd>
        </div>
      </dl>
    </section>
  );
}

type CommandDeckProps = {
  query: string;
  releasePort: string;
  releaseMatchCount: number;
  protocol: ProtocolFilter;
  preview: boolean;
  systemBusy: boolean;
  onQueryChange: (value: string) => void;
  onReleasePortChange: (value: string) => void;
  onProtocolChange: (protocol: ProtocolFilter) => void;
  onLocatePort: () => void;
};

export function CommandDeck({
  query,
  releasePort,
  releaseMatchCount,
  protocol,
  preview,
  systemBusy,
  onQueryChange,
  onReleasePortChange,
  onProtocolChange,
  onLocatePort,
}: CommandDeckProps) {
  function submit(event: FormEvent) {
    event.preventDefault();
    onLocatePort();
  }

  return (
    <section className="command-deck" aria-label="端点筛选与定位">
      <label className="field search-control">
        <span className="field-label">搜索端点</span>
        <span className="field-input">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="端口、地址、PID 或进程名"
          />
        </span>
      </label>

      <form className="field port-locator" onSubmit={submit}>
        <label className="field-label" htmlFor="target-port">
          精确端口
        </label>
        <div className="field-input">
          <SearchCheck size={16} aria-hidden="true" />
          <input
            id="target-port"
            inputMode="numeric"
            maxLength={5}
            value={releasePort}
            onChange={(event) => onReleasePortChange(event.target.value)}
            placeholder="1–65535"
          />
          <span className="match-count" aria-live="polite">
            {releasePort.trim() ? `${releaseMatchCount} 条` : "快速定位"}
          </span>
          <button className="inline-command" type="submit" disabled={systemBusy}>
            {preview ? "定位" : "定位并处理"}
          </button>
        </div>
      </form>

      <div className="field protocol-control">
        <span className="field-label">协议视图</span>
        <div className="protocol-toggles" aria-label="协议筛选">
          {(["ALL", "TCP", "UDP"] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={protocol === item}
              onClick={() => onProtocolChange(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
