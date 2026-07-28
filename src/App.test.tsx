import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { sampleEntries, type PortApi } from "./api";
import type {
  PortEntry,
  RuntimeContext,
  TerminationOutcome,
  TerminationStatus,
} from "./ports";

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

const standardDesktopRuntime: RuntimeContext = {
  ...desktopRuntime,
  status: { is_windows: true, is_admin: false },
};

function buildApi(
  runtime: RuntimeContext,
  outcome?: TerminationOutcome,
): PortApi {
  return {
    getRuntimeContext: vi.fn(async () => runtime),
    getPortEntries: vi.fn(async () => sampleEntries),
    killPortProcess: vi.fn(
      async (entry): Promise<TerminationOutcome> =>
        outcome ?? {
          pid: entry.pid,
          status: "terminated",
          reason: "confirmed",
          message: "confirmed",
        },
    ),
    restartAsAdmin: vi.fn(async () => undefined),
    revealProcessPath: vi.fn(async () => undefined),
  };
}

describe("scan presentation", () => {
  it("labels the idle state without claiming data is ready", () => {
    const api = buildApi(previewRuntime);
    render(<App api={api} autoStart={false} />);

    expect(screen.getByText("等待扫描")).toBeVisible();
    expect(screen.getByText("等待首次扫描")).toBeVisible();
    expect(screen.queryByText("数据就绪")).not.toBeInTheDocument();
  });

  it("moves from a live loading state to the semantic empty state", async () => {
    let resolveEntries: (entries: PortEntry[]) => void = () => undefined;
    const pendingEntries = new Promise<PortEntry[]>((resolve) => {
      resolveEntries = resolve;
    });
    const api = buildApi(previewRuntime);
    api.getPortEntries = vi.fn(() => pendingEntries);
    render(<App api={api} startupDelayMs={0} />);

    expect(await screen.findAllByText("扫描 TCP / UDP 端口")).not.toHaveLength(0);
    resolveEntries([]);
    expect(await screen.findByText("没有匹配的端点")).toBeVisible();
  });

  it("announces a failed scan as an error event", async () => {
    const api = buildApi(previewRuntime);
    api.getPortEntries = vi.fn(async () => {
      throw new Error("table unavailable");
    });
    const { container } = render(<App api={api} startupDelayMs={0} />);

    expect(await screen.findByText("扫描失败")).toBeVisible();
    expect(screen.getByText("table unavailable")).toBeVisible();
    expect(screen.getByRole("alert", { name: "操作事件" })).toBeVisible();
    expect(container.querySelector(".event-strip.error")).toBeInTheDocument();
  });

  it("gives duplicate process bindings distinct row and action names", async () => {
    const api = buildApi(previewRuntime);
    const first = sampleEntries[0];
    const second: PortEntry = {
      ...first,
      entry_id: `${first.entry_id}-ipv6`,
      local_address: "[::1]:3000",
      endpoint: {
        ...first.endpoint,
        address_family: "ipv6",
        local_ip: "::1",
      },
    };
    api.getPortEntries = vi.fn(async () => [first, second]);
    render(<App api={api} startupDelayMs={0} />);

    expect(
      await screen.findByRole("button", {
        name: "3000，选择 TCP 127.0.0.1:3000，node.exe，PID 18420",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "3000，选择 TCP [::1]:3000，node.exe，PID 18420",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "node.exe TCP 127.0.0.1:3000 的行操作",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "node.exe TCP [::1]:3000 的行操作",
      }),
    ).toBeVisible();
  });
});

describe("PortKiller preview flow", () => {
  it("keeps system actions hidden while search, filters, selection and port targeting work", async () => {
    const user = userEvent.setup();
    const api = buildApi(previewRuntime);
    render(<App api={api} startupDelayMs={0} />);

    await waitFor(() => expect(api.getPortEntries).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("table", { name: /本机 TCP 与 UDP 端点/ })).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "搜索端点" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "精确端口" })).toBeVisible();

    expect(screen.queryByRole("button", { name: "管理员重启" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "检查并终止" })).not.toBeInTheDocument();

    const udpFilter = screen.getByRole("button", { name: "UDP" });
    await user.click(udpFilter);
    expect(udpFilter).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("mDNSResponder.exe")).not.toHaveLength(0);
    expect(screen.queryByText("node.exe")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "ALL" }));
    const portInput = screen.getByRole("textbox", { name: "精确端口" });
    await user.type(portInput, String(sampleEntries[0].port));
    await user.click(screen.getByRole("button", { name: "定位" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("已定位端口")).toBeVisible();
    expect(screen.getByRole("status", { name: "操作事件" })).toBeVisible();
    expect(api.killPortProcess).not.toHaveBeenCalled();

    const rowActions = screen.getByRole("button", {
      name: /node\.exe TCP 127\.0\.0\.1:3000 的行操作/,
    });
    rowActions.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menu")).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "打开所在目录" })).not.toBeInTheDocument();
  });
});

describe("system operation controls", () => {
  it("disables every competing system entry point while reveal is pending", async () => {
    const user = userEvent.setup();
    let resolveReveal: () => void = () => undefined;
    const pendingReveal = new Promise<void>((resolve) => {
      resolveReveal = resolve;
    });
    const api = buildApi(standardDesktopRuntime);
    api.revealProcessPath = vi.fn(() => pendingReveal);
    render(<App api={api} startupDelayMs={0} />);

    await waitFor(() => expect(api.getPortEntries).toHaveBeenCalledTimes(1));
    const reveal = await screen.findByRole("button", { name: "目录" });
    const elevate = screen.getByRole("button", { name: "管理员重启" });
    const locate = screen.getByRole("button", { name: "定位并处理" });
    const terminate = screen.getByRole("button", { name: "检查并终止" });

    await user.click(reveal);
    await waitFor(() => expect(api.revealProcessPath).toHaveBeenCalledTimes(1));
    expect(elevate).toBeDisabled();
    expect(locate).toBeDisabled();
    expect(terminate).toBeDisabled();

    resolveReveal();
    await waitFor(() => expect(terminate).toBeEnabled());
    expect(elevate).toBeEnabled();
    expect(locate).toBeEnabled();
  });
});

describe("structured termination outcomes", () => {
  const cases: Array<{
    status: TerminationStatus;
    reason: TerminationOutcome["reason"];
    severity: string;
    title: string;
  }> = [
    { status: "terminated", reason: "confirmed", severity: "success", title: "终止完成" },
    {
      status: "already_exited",
      reason: "already_exited",
      severity: "info",
      title: "进程已退出",
    },
    {
      status: "rejected",
      reason: "endpoint_changed",
      severity: "warning",
      title: "操作被拒绝",
    },
    {
      status: "failed",
      reason: "termination_failed",
      severity: "error",
      title: "终止失败",
    },
  ];

  it.each(cases)("renders $status as $severity", async ({ status, reason, severity, title }) => {
    const user = userEvent.setup();
    const target = sampleEntries[0];
    const api = buildApi(desktopRuntime, {
      pid: target.pid,
      status,
      reason,
      message: `backend ${status}`,
    });
    const { container } = render(<App api={api} startupDelayMs={0} />);

    await waitFor(() => expect(api.getPortEntries).toHaveBeenCalledTimes(1));
    await user.click(await screen.findByRole("button", { name: "检查并终止" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "确认终止" }));

    expect(await screen.findByText(title)).toBeVisible();
    expect(container.querySelector(`.event-strip.${severity}`)).toBeInTheDocument();
    expect(api.killPortProcess).toHaveBeenCalledWith(target);
    if (status === "rejected" || status === "failed") {
      expect(container.querySelector(".event-strip.success")).not.toBeInTheDocument();
    }
  });
});
