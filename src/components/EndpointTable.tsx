import { Ellipsis, Loader2, LockKeyhole } from "lucide-react";
import type { MouseEvent } from "react";
import type { PortEntry } from "../ports";
import { progressBarStyle, type ScanProgress } from "../scanProgress";
import type { ScanStatus } from "../usePortController";

const skeletonRows = [0, 1, 2, 3, 4, 5];

function LoadingRows({ progress }: { progress: ScanProgress }) {
  return (
    <tr className="loading-table-row">
      <td colSpan={8}>
        <div className="table-loading" role="status" aria-live="polite">
          <div className="loading-copy">
            <Loader2 className="spin" size={18} aria-hidden="true" />
            <strong>{progress.label}</strong>
            <span>{Math.round(progress.value)}%</span>
          </div>
          <div className="loading-progress" aria-hidden="true">
            <span style={progressBarStyle(progress)} />
          </div>
          <div className="table-skeleton" aria-hidden="true">
            {skeletonRows.map((row) => (
              <span key={row} />
            ))}
          </div>
        </div>
      </td>
    </tr>
  );
}

type EndpointTableProps = {
  entries: PortEntry[];
  selectedEntry: PortEntry | null;
  scanStatus: ScanStatus;
  scanProgress: ScanProgress;
  activeMenuEntryId: string | null;
  onSelect: (entry: PortEntry) => void;
  onOpenActions: (entry: PortEntry, trigger: HTMLButtonElement) => void;
};

export function EndpointTable({
  entries,
  selectedEntry,
  scanStatus,
  scanProgress,
  activeMenuEntryId,
  onSelect,
  onOpenActions,
}: EndpointTableProps) {
  function openActions(event: MouseEvent<HTMLButtonElement>, entry: PortEntry) {
    event.stopPropagation();
    onSelect(entry);
    onOpenActions(entry, event.currentTarget);
  }

  return (
    <section className="endpoint-surface" aria-labelledby="endpoint-table-title">
      <header className="surface-heading">
        <div>
          <p className="eyebrow">Observed bindings</p>
          <h2 id="endpoint-table-title">端点清单</h2>
        </div>
        <p>选择端点后，在右侧核对进程身份与操作权限。</p>
      </header>

      <div className="table-viewport">
        <table className="endpoint-table">
          <caption className="sr-only">本机 TCP 与 UDP 端点及其所属进程</caption>
          <thead>
            <tr>
              <th scope="col">端口</th>
              <th scope="col">协议</th>
              <th scope="col">状态</th>
              <th scope="col">本地端点</th>
              <th scope="col">远程端点</th>
              <th scope="col">PID</th>
              <th scope="col">进程</th>
              <th scope="col"><span className="sr-only">行操作</span></th>
            </tr>
          </thead>
          <tbody>
            {scanStatus === "loading" && entries.length === 0 ? (
              <LoadingRows progress={scanProgress} />
            ) : entries.length === 0 ? (
              <tr className="empty-table-row">
                <td colSpan={8}>
                  <div className="empty-state">
                    <strong>
                      {scanStatus === "idle"
                        ? "等待首次扫描"
                        : scanStatus === "failed"
                          ? "端点清单不可用"
                          : "没有匹配的端点"}
                    </strong>
                    <span>
                      {scanStatus === "idle"
                        ? "使用刷新开始读取本机端点。"
                        : scanStatus === "failed"
                          ? "检查扫描错误后重试。"
                          : "调整搜索条件或协议筛选后重试。"}
                    </span>
                  </div>
                </td>
              </tr>
            ) : (
              entries.map((entry) => {
                const selected = entry.entry_id === selectedEntry?.entry_id;
                const menuOpen = activeMenuEntryId === entry.entry_id;

                return (
                  <tr
                    className={`${selected ? "selected" : ""} ${
                      entry.can_terminate ? "" : "constrained"
                    }`}
                    key={entry.entry_id}
                    data-entry-id={entry.entry_id}
                  >
                    <td>
                      <button
                        className="row-selector mono"
                        type="button"
                        aria-label={`${entry.port}，选择 ${entry.protocol} ${entry.local_address}，${entry.process_name}，PID ${entry.pid}`}
                        aria-pressed={selected}
                        onClick={() => onSelect(entry)}
                      >
                        <span className="selection-mark" aria-hidden="true" />
                        {entry.port}
                      </button>
                    </td>
                    <td>
                      <span className={`protocol-tag ${entry.protocol.toLowerCase()}`}>
                        {entry.protocol}
                      </span>
                    </td>
                    <td>
                      <span className={`state-tag ${entry.state === "LISTEN" ? "listen" : ""}`}>
                        {entry.state}
                      </span>
                    </td>
                    <td className="mono endpoint-value" title={entry.local_address}>
                      {entry.local_address}
                    </td>
                    <td className="mono endpoint-value muted" title={entry.remote_address}>
                      {entry.remote_address || "—"}
                    </td>
                    <td className="mono">{entry.pid}</td>
                    <td className="process-cell" title={entry.process_name}>
                      {!entry.can_terminate && <LockKeyhole size={13} aria-hidden="true" />}
                      <span>{entry.process_name}</span>
                    </td>
                    <td className="row-actions-cell">
                      <button
                        className="row-action-trigger"
                        type="button"
                        aria-label={`${entry.process_name} ${entry.protocol} ${entry.local_address} 的行操作`}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        onClick={(event) => openActions(event, entry)}
                      >
                        <Ellipsis size={18} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
