import {
  Copy,
  FolderOpen,
  LockKeyhole,
  RadioTower,
  ShieldCheck,
  Skull,
  TerminalSquare,
} from "lucide-react";
import type { PortEntry, RuntimeCapabilities } from "../ports";
import { protectionReasonLabel, type OperationStatus } from "../usePortController";

type TargetInspectorProps = {
  entry: PortEntry | null;
  capabilities: RuntimeCapabilities;
  operation: OperationStatus;
  onCopy: (label: string, value: string | number) => void;
  onReveal: (entry: PortEntry) => void;
  onTerminate: (entry: PortEntry) => void;
};

export function TargetInspector({
  entry,
  capabilities,
  operation,
  onCopy,
  onReveal,
  onTerminate,
}: TargetInspectorProps) {
  return (
    <aside className="target-inspector" aria-labelledby="target-inspector-title">
      <header className="surface-heading inspector-heading">
        <div>
          <p className="eyebrow">Verified target</p>
          <h2 id="target-inspector-title">目标检查器</h2>
        </div>
        <RadioTower size={18} aria-hidden="true" />
      </header>

      {!entry ? (
        <div className="empty-inspector">
          <TerminalSquare size={25} aria-hidden="true" />
          <strong>尚未选择端点</strong>
          <span>从左侧清单选择一行以核对进程身份。</span>
        </div>
      ) : (
        <div className="inspector-body">
          <section className="target-identity" aria-label="所选进程身份">
            <div className="identity-glyph" aria-hidden="true">
              <TerminalSquare size={21} />
            </div>
            <div>
              <strong title={entry.process_name}>{entry.process_name}</strong>
              <span className="mono">PID {entry.pid}</span>
            </div>
            <span className={`authority-state ${entry.can_terminate ? "ready" : "constrained"}`}>
              {entry.can_terminate ? (
                <ShieldCheck size={13} aria-hidden="true" />
              ) : (
                <LockKeyhole size={13} aria-hidden="true" />
              )}
              {entry.can_terminate ? "可验证" : "受限"}
            </span>
          </section>

          <div className="inspector-actions" aria-label="复制与目录操作">
            <button type="button" onClick={() => onCopy("本地端点", entry.local_address)}>
              <Copy size={14} aria-hidden="true" />
              端点
            </button>
            <button type="button" onClick={() => onCopy("PID", entry.pid)}>
              <Copy size={14} aria-hidden="true" />
              PID
            </button>
            {capabilities.can_reveal_path && (
              <button
                type="button"
                disabled={!entry.process_path.trim() || operation !== "idle"}
                onClick={() => onReveal(entry)}
              >
                <FolderOpen size={14} aria-hidden="true" />
                目录
              </button>
            )}
          </div>

          <dl className="target-details">
            <div>
              <dt>本地</dt>
              <dd title={entry.local_address}>{entry.local_address}</dd>
            </div>
            <div>
              <dt>远程</dt>
              <dd title={entry.remote_address}>{entry.remote_address || "—"}</dd>
            </div>
            <div>
              <dt>协议 / 状态</dt>
              <dd>{entry.protocol} · {entry.state}</dd>
            </div>
            <div>
              <dt>地址族</dt>
              <dd>{entry.endpoint.address_family.toUpperCase()}</dd>
            </div>
            <div>
              <dt>进程实例</dt>
              <dd title={entry.process_instance_id ?? ""}>
                {entry.process_instance_id ?? "不可用"}
              </dd>
            </div>
            <div>
              <dt>可执行路径</dt>
              <dd title={entry.process_path}>{entry.process_path || "无权读取"}</dd>
            </div>
          </dl>

          {capabilities.can_terminate ? (
            <section className="danger-zone" aria-labelledby="danger-zone-title">
              <div>
                <p className="eyebrow danger-label">Destructive boundary</p>
                <h3 id="danger-zone-title">结束所选进程</h3>
                <p>
                  仅请求终止此 PID。后端会在执行前重新核对实例与端点归属。
                </p>
              </div>
              {!entry.can_terminate && (
                <p className="constraint-reason">
                  <LockKeyhole size={14} aria-hidden="true" />
                  {protectionReasonLabel(entry.protection_reason)}
                </p>
              )}
              <button
                className="button danger full-width"
                type="button"
                disabled={!entry.can_terminate || operation !== "idle"}
                onClick={() => onTerminate(entry)}
              >
                <Skull size={16} aria-hidden="true" />
                {entry.can_terminate ? "检查并终止" : "终止不可用"}
              </button>
            </section>
          ) : (
            <section className="preview-boundary" aria-label="预览能力说明">
              <ShieldCheck size={17} aria-hidden="true" />
              <div>
                <strong>只读交互预览</strong>
                <span>系统级目录、提权和终止命令已隐藏。</span>
              </div>
            </section>
          )}
        </div>
      )}
    </aside>
  );
}
