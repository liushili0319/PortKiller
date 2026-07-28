import { AlertTriangle, CheckCircle2, CircleX, Info, X } from "lucide-react";
import type { Feedback } from "../usePortController";

type EventStripProps = {
  feedback: Feedback | null;
  onDismiss: () => void;
};

const icons = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: CircleX,
};

export function EventStrip({ feedback, onDismiss }: EventStripProps) {
  const Icon = feedback ? icons[feedback.severity] : Info;

  return (
    <section
      className={`event-strip ${feedback?.severity ?? "idle"}`}
      aria-label="操作事件"
      role={feedback?.severity === "error" ? "alert" : "status"}
      aria-live={feedback?.severity === "error" ? "assertive" : "polite"}
      aria-atomic="true"
    >
      {feedback ? (
        <div className="event-content">
          <Icon size={16} aria-hidden="true" />
          <strong>{feedback.title}</strong>
          <span>{feedback.message}</span>
          <button type="button" onClick={onDismiss} aria-label="关闭操作事件">
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div className="event-content event-placeholder">
          <Icon size={15} aria-hidden="true" />
          <span>操作结果与安全拒绝会显示在这里。</span>
        </div>
      )}
    </section>
  );
}
