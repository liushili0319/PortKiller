import { invoke } from "@tauri-apps/api/tauri";
import {
  createKillProcessRequest,
  type PortEntry,
  type RuntimeCapabilities,
  type RuntimeContext,
  type RuntimeStatus,
  type TerminationOutcome,
} from "./ports";

export const sampleEntries: PortEntry[] = [
  {
    port: 3000,
    protocol: "TCP",
    state: "LISTEN",
    local_address: "127.0.0.1:3000",
    remote_address: "0.0.0.0:0",
    pid: 18420,
    process_name: "node.exe",
    process_path: "C:\\Program Files\\nodejs\\node.exe",
    entry_id: "preview|tcp4|127.0.0.1|3000|18420|01dcbeef12345678",
    endpoint: {
      address_family: "ipv4",
      protocol: "TCP",
      local_ip: "127.0.0.1",
      local_scope_id: 0,
      local_port: 3000,
      remote_ip: "0.0.0.0",
      remote_scope_id: 0,
      remote_port: 0,
    },
    process_instance_id: "01dcbeef12345678",
    can_terminate: true,
    protection_reason: "",
  },
  {
    port: 5173,
    protocol: "TCP",
    state: "LISTEN",
    local_address: "[::1]:5173",
    remote_address: "[::]:0",
    pid: 22044,
    process_name: "vite.exe",
    process_path: "C:\\Projects\\PortKiller\\node_modules\\.bin\\vite.cmd",
    entry_id: "preview|tcp6|::1|5173|22044|01dcbeef12345679",
    endpoint: {
      address_family: "ipv6",
      protocol: "TCP",
      local_ip: "::1",
      local_scope_id: 0,
      local_port: 5173,
      remote_ip: "::",
      remote_scope_id: 0,
      remote_port: 0,
    },
    process_instance_id: "01dcbeef12345679",
    can_terminate: true,
    protection_reason: "",
  },
  {
    port: 5432,
    protocol: "TCP",
    state: "LISTEN",
    local_address: "0.0.0.0:5432",
    remote_address: "0.0.0.0:0",
    pid: 9120,
    process_name: "postgres.exe",
    process_path: "C:\\Program Files\\PostgreSQL\\16\\bin\\postgres.exe",
    entry_id: "preview|tcp4|0.0.0.0|5432|9120|01dcbeef1234567a",
    endpoint: {
      address_family: "ipv4",
      protocol: "TCP",
      local_ip: "0.0.0.0",
      local_scope_id: 0,
      local_port: 5432,
      remote_ip: "0.0.0.0",
      remote_scope_id: 0,
      remote_port: 0,
    },
    process_instance_id: "01dcbeef1234567a",
    can_terminate: true,
    protection_reason: "",
  },
  {
    port: 5353,
    protocol: "UDP",
    state: "BOUND",
    local_address: "[fe80::1%12]:5353",
    remote_address: "",
    pid: 4016,
    process_name: "mDNSResponder.exe",
    process_path: "C:\\Program Files\\Bonjour\\mDNSResponder.exe",
    entry_id: "preview|udp6|fe80::1|12|5353|4016|01dcbeef1234567b",
    endpoint: {
      address_family: "ipv6",
      protocol: "UDP",
      local_ip: "fe80::1",
      local_scope_id: 12,
      local_port: 5353,
      remote_ip: null,
      remote_scope_id: null,
      remote_port: null,
    },
    process_instance_id: "01dcbeef1234567b",
    can_terminate: true,
    protection_reason: "",
  },
];

export type PortApi = {
  getRuntimeContext: () => Promise<RuntimeContext>;
  getPortEntries: () => Promise<PortEntry[]>;
  killPortProcess: (entry: PortEntry) => Promise<TerminationOutcome>;
  restartAsAdmin: () => Promise<void>;
  revealProcessPath: (processPath: string) => Promise<void>;
};

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_IPC__" in window;
}

function capabilitiesFor(status: RuntimeStatus, desktop: boolean): RuntimeCapabilities {
  const supportedDesktop = desktop && status.is_windows;

  return {
    mode: supportedDesktop ? "desktop" : "preview",
    can_elevate: supportedDesktop,
    can_reveal_path: supportedDesktop,
    can_terminate: supportedDesktop,
  };
}

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  if (!isTauriRuntime()) {
    return { is_windows: false, is_admin: false };
  }

  return invoke<RuntimeStatus>("get_runtime_status");
}

export async function getRuntimeContext(): Promise<RuntimeContext> {
  const desktop = isTauriRuntime();
  const status = await getRuntimeStatus();

  return {
    status,
    capabilities: capabilitiesFor(status, desktop),
  };
}

export async function getPortEntries(): Promise<PortEntry[]> {
  if (!isTauriRuntime()) {
    return sampleEntries;
  }

  return invoke<PortEntry[]>("get_port_entries");
}

export async function killPortProcess(entry: PortEntry): Promise<TerminationOutcome> {
  if (!isTauriRuntime()) {
    return {
      pid: entry.pid,
      status: "failed",
      reason: "unsupported_platform",
      message: "预览模式不会执行进程终止操作。",
    };
  }

  return invoke<TerminationOutcome>("kill_port_process", {
    request: createKillProcessRequest(entry),
  });
}

export async function restartAsAdmin(): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("预览模式不能请求管理员权限。");
  }

  return invoke<void>("restart_as_admin");
}

export async function revealProcessPath(processPath: string): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("预览模式不能打开进程目录。");
  }

  return invoke<void>("reveal_process_path", {
    processPath,
  });
}

export async function revealMainWindow(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }

  const { appWindow } = await import("@tauri-apps/api/window");
  await appWindow.show();
  await appWindow.setFocus();
}

export const defaultPortApi: PortApi = {
  getRuntimeContext,
  getPortEntries,
  killPortProcess,
  restartAsAdmin,
  revealProcessPath,
};
