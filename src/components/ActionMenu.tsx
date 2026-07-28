import { Copy, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { PortEntry, RuntimeCapabilities } from "../ports";

type ActionMenuProps = {
  entry: PortEntry;
  trigger: HTMLButtonElement;
  capabilities: RuntimeCapabilities;
  systemBusy: boolean;
  onCopy: (label: string, value: string | number) => void;
  onReveal: (entry: PortEntry) => void;
  onClose: () => void;
};

export function ActionMenu({
  entry,
  trigger,
  capabilities,
  systemBusy,
  onCopy,
  onReveal,
  onClose,
}: ActionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const hasProcessPath = Boolean(entry.process_path.trim());
  const position = useMemo(() => {
    const rect = trigger.getBoundingClientRect();
    const width = 224;
    const estimatedHeight = capabilities.can_reveal_path ? 184 : 146;
    return {
      left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
      top: Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - estimatedHeight - 12)),
    };
  }, [capabilities.can_reveal_path, trigger]);

  useEffect(() => {
    const firstEnabledIndex = itemRefs.current.findIndex((item) => item && !item.disabled);
    if (firstEnabledIndex >= 0) {
      setActiveIndex(firstEnabledIndex);
      itemRefs.current[firstEnabledIndex]?.focus();
    }

    function closeFromOutside(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target) &&
        !trigger.contains(event.target)
      ) {
        onClose();
      }
    }

    window.addEventListener("pointerdown", closeFromOutside);
    return () => window.removeEventListener("pointerdown", closeFromOutside);
  }, [onClose, trigger]);

  function closeAndRestore() {
    trigger.focus();
    onClose();
  }

  function run(action: () => void) {
    action();
    closeAndRestore();
  }

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    const items = itemRefs.current
      .map((item, index) => ({ item, index }))
      .filter(
        (candidate): candidate is { item: HTMLButtonElement; index: number } =>
          Boolean(candidate.item && !candidate.item.disabled),
      );
    const currentIndex = items.findIndex(({ item }) => item === document.activeElement);

    function focusItem(candidate: (typeof items)[number] | undefined) {
      if (!candidate) {
        return;
      }
      setActiveIndex(candidate.index);
      candidate.item.focus();
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusItem(items[(currentIndex + 1 + items.length) % items.length]);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusItem(items[(currentIndex - 1 + items.length) % items.length]);
        break;
      case "Home":
        event.preventDefault();
        focusItem(items[0]);
        break;
      case "End":
        event.preventDefault();
        focusItem(items[items.length - 1]);
        break;
      case "Escape":
      case "Tab":
        event.preventDefault();
        closeAndRestore();
        break;
    }
  }

  return (
    <div
      className="action-menu"
      role="menu"
      aria-label={`${entry.process_name} 的端点操作`}
      ref={menuRef}
      tabIndex={-1}
      style={position}
      onKeyDown={moveFocus}
    >
      <p>端点操作</p>
      <button
        ref={(node) => {
          itemRefs.current[0] = node;
        }}
        type="button"
        role="menuitem"
        tabIndex={activeIndex === 0 ? 0 : -1}
        onFocus={() => setActiveIndex(0)}
        onClick={() => run(() => onCopy("本地端点", entry.local_address))}
      >
        <Copy size={15} aria-hidden="true" />
        复制本地端点
      </button>
      <button
        ref={(node) => {
          itemRefs.current[1] = node;
        }}
        type="button"
        role="menuitem"
        tabIndex={activeIndex === 1 ? 0 : -1}
        onFocus={() => setActiveIndex(1)}
        onClick={() => run(() => onCopy("PID", entry.pid))}
      >
        <Copy size={15} aria-hidden="true" />
        复制 PID
      </button>
      <button
        ref={(node) => {
          itemRefs.current[2] = node;
        }}
        type="button"
        role="menuitem"
        tabIndex={activeIndex === 2 && hasProcessPath ? 0 : -1}
        disabled={!hasProcessPath}
        onFocus={() => setActiveIndex(2)}
        onClick={() => run(() => onCopy("进程路径", entry.process_path))}
      >
        <Copy size={15} aria-hidden="true" />
        复制进程路径
      </button>
      {capabilities.can_reveal_path && (
        <button
          ref={(node) => {
            itemRefs.current[3] = node;
          }}
          type="button"
          role="menuitem"
          tabIndex={activeIndex === 3 && hasProcessPath && !systemBusy ? 0 : -1}
          disabled={!hasProcessPath || systemBusy}
          onFocus={() => setActiveIndex(3)}
          onClick={() => run(() => onReveal(entry))}
        >
          <FolderOpen size={15} aria-hidden="true" />
          打开所在目录
        </button>
      )}
    </div>
  );
}
