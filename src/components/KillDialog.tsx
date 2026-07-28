import { Loader2, ShieldAlert, Skull } from "lucide-react";
import { useEffect, useRef, type SyntheticEvent } from "react";
import type { PortEntry } from "../ports";

type KillDialogProps = {
  entry: PortEntry | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function KillDialog({ entry, busy, onCancel, onConfirm }: KillDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!entry || !dialog) {
      return;
    }

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (!dialog.open) {
      dialog.showModal();
    }
    cancelRef.current?.focus();

    return () => {
      if (dialog.open) {
        dialog.close();
      }
      previousFocusRef.current?.focus();
    };
  }, [entry]);

  if (!entry) {
    return null;
  }

  function handleNativeCancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    if (!busy) {
      onCancel();
    }
  }

  return (
    <dialog
      className="kill-dialog"
      ref={dialogRef}
      aria-labelledby="kill-dialog-title"
      aria-describedby="kill-dialog-description"
      onCancel={handleNativeCancel}
    >
      <div className="dialog-kicker">
        <span className="danger-glyph" aria-hidden="true">
          <Skull size={20} />
        </span>
        <span>Destructive command</span>
      </div>
      <h2 id="kill-dialog-title">确认终止所选进程</h2>
      <p id="kill-dialog-description">
        后端将重新验证此进程实例及端点归属，只终止下面显示的 PID。其他同名进程不会被扩展选中。
      </p>

      <dl className="confirmation-target">
        <div>
          <dt>进程</dt>
          <dd>{entry.process_name}</dd>
        </div>
        <div>
          <dt>PID</dt>
          <dd>{entry.pid}</dd>
        </div>
        <div>
          <dt>端点</dt>
          <dd>{entry.local_address}</dd>
        </div>
        <div>
          <dt>实例</dt>
          <dd>{entry.process_instance_id ?? "不可用"}</dd>
        </div>
      </dl>

      <div className="dialog-assurance">
        <ShieldAlert size={16} aria-hidden="true" />
        身份或归属发生变化时，操作将被拒绝。
      </div>

      <div className="dialog-actions">
        <button
          className="button secondary"
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          disabled={busy}
        >
          取消，返回检查
        </button>
        <button
          className="button danger"
          type="button"
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="spin" size={16} aria-hidden="true" />
          ) : (
            <Skull size={16} aria-hidden="true" />
          )}
          {busy ? "正在确认结果" : "确认终止"}
        </button>
      </div>
    </dialog>
  );
}
