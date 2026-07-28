import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { sampleEntries } from "../api";
import type { RuntimeCapabilities } from "../ports";
import { ActionMenu } from "./ActionMenu";
import { KillDialog } from "./KillDialog";

const previewCapabilities: RuntimeCapabilities = {
  mode: "preview",
  can_elevate: false,
  can_reveal_path: false,
  can_terminate: false,
};

describe("ActionMenu", () => {
  it("uses roving keyboard focus and restores focus on Escape", async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();

    function Harness() {
      const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
      return (
        <>
          <button type="button" onClick={(event) => setTrigger(event.currentTarget)}>
            行操作
          </button>
          {trigger && (
            <ActionMenu
              entry={sampleEntries[0]}
              trigger={trigger}
              capabilities={previewCapabilities}
              systemBusy={false}
              onCopy={onCopy}
              onReveal={vi.fn()}
              onClose={() => setTrigger(null)}
            />
          )}
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "行操作" });
    await user.click(trigger);

    const endpointItem = screen.getByRole("menuitem", { name: "复制本地端点" });
    const pidItem = screen.getByRole("menuitem", { name: "复制 PID" });
    const pathItem = screen.getByRole("menuitem", { name: "复制进程路径" });
    await waitFor(() => expect(endpointItem).toHaveFocus());

    await user.keyboard("{ArrowDown}");
    expect(pidItem).toHaveFocus();
    await user.keyboard("{End}");
    expect(pathItem).toHaveFocus();
    await user.keyboard("{Home}");
    expect(endpointItem).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("skips disabled path actions and closes on Tab", async () => {
    const user = userEvent.setup();
    const entryWithoutPath = { ...sampleEntries[0], process_path: "" };

    function Harness() {
      const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
      return (
        <>
          <button type="button" onClick={(event) => setTrigger(event.currentTarget)}>
            无路径行操作
          </button>
          {trigger && (
            <ActionMenu
              entry={entryWithoutPath}
              trigger={trigger}
              capabilities={previewCapabilities}
              systemBusy={false}
              onCopy={vi.fn()}
              onReveal={vi.fn()}
              onClose={() => setTrigger(null)}
            />
          )}
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "无路径行操作" });
    await user.click(trigger);

    const endpointItem = screen.getByRole("menuitem", { name: "复制本地端点" });
    const pidItem = screen.getByRole("menuitem", { name: "复制 PID" });
    const pathItem = screen.getByRole("menuitem", { name: "复制进程路径" });
    await waitFor(() => expect(endpointItem).toHaveFocus());
    expect(endpointItem).toHaveAttribute("tabindex", "0");
    expect(pathItem).toBeDisabled();
    expect(pathItem).toHaveAttribute("tabindex", "-1");

    await user.keyboard("{ArrowUp}");
    expect(pidItem).toHaveFocus();
    await user.keyboard("{End}");
    expect(pidItem).toHaveFocus();
    await user.keyboard("{Tab}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe("KillDialog", () => {
  it("focuses the safe action, maps native cancellation to cancel, and restores focus", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开确认
          </button>
          <KillDialog
            entry={open ? sampleEntries[0] : null}
            busy={false}
            onCancel={() => {
              onCancel();
              setOpen(false);
            }}
            onConfirm={onConfirm}
          />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "打开确认" });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog");
    const cancel = screen.getByRole("button", { name: "取消，返回检查" });
    await waitFor(() => expect(cancel).toHaveFocus());

    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("does not let Escape cancel or submit while an operation is busy", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <KillDialog
        entry={sampleEntries[0]}
        busy
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const dialog = screen.getByRole("dialog");
    fireEvent(dialog, new Event("cancel", { cancelable: true }));

    expect(dialog).toBeVisible();
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "取消，返回检查" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在确认结果" })).toBeDisabled();
  });
});
