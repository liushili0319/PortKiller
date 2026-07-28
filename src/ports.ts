export type Protocol = "TCP" | "UDP";
export type AddressFamily = "ipv4" | "ipv6";

export type EndpointKey = {
  address_family: AddressFamily;
  protocol: Protocol;
  local_ip: string;
  local_scope_id: number;
  local_port: number;
  remote_ip: string | null;
  remote_scope_id: number | null;
  remote_port: number | null;
};

/** The serialized shape owned by the Rust backend. */
export type PortEntry = {
  port: number;
  protocol: Protocol;
  state: string;
  local_address: string;
  remote_address: string;
  pid: number;
  process_name: string;
  process_path: string;
  entry_id: string;
  endpoint: EndpointKey;
  process_instance_id: string | null;
  can_terminate: boolean;
  protection_reason: string;
};

export type RuntimeStatus = {
  is_windows: boolean;
  is_admin: boolean;
};

export type RuntimeMode = "desktop" | "preview";

export type RuntimeCapabilities = {
  mode: RuntimeMode;
  can_elevate: boolean;
  can_reveal_path: boolean;
  can_terminate: boolean;
};

export type RuntimeContext = {
  status: RuntimeStatus;
  capabilities: RuntimeCapabilities;
};

export type KillProcessRequest = Pick<
  PortEntry,
  "entry_id" | "pid" | "endpoint" | "process_instance_id"
>;

export type TerminationStatus =
  | "terminated"
  | "already_exited"
  | "rejected"
  | "failed";

export type TerminationReason =
  | "confirmed"
  | "already_exited"
  | "protected_process"
  | "identity_unavailable"
  | "process_instance_changed"
  | "endpoint_changed"
  | "endpoint_verification_failed"
  | "access_denied"
  | "termination_failed"
  | "confirmation_timeout"
  | "wait_failed"
  | "invalid_request"
  | "unsupported_platform";

export type TerminationOutcome = {
  pid: number;
  status: TerminationStatus;
  reason: TerminationReason;
  message: string;
};

export function createKillProcessRequest(entry: PortEntry): KillProcessRequest {
  return {
    entry_id: entry.entry_id,
    pid: entry.pid,
    endpoint: entry.endpoint,
    process_instance_id: entry.process_instance_id,
  };
}

/** Backend identifiers are opaque. Never rebuild one from display fields. */
export function portEntryId(entry: PortEntry) {
  return entry.entry_id;
}

export function findPortEntriesByPort(entries: PortEntry[], query: string): PortEntry[] {
  const trimmedQuery = query.trim();

  if (!/^\d+$/.test(trimmedQuery)) {
    return [];
  }

  const port = Number(trimmedQuery);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return [];
  }

  return entries.filter((entry) => entry.port === port);
}

export function findRemainingPortOwners(
  entries: PortEntry[],
  target: Pick<PortEntry, "port" | "protocol">,
) {
  return entries.filter((entry) => entry.port === target.port && entry.protocol === target.protocol);
}

export function directoryFromProcessPath(processPath: string) {
  const trimmedPath = processPath.trim();

  if (!trimmedPath) {
    return "";
  }

  const separatorIndex = Math.max(trimmedPath.lastIndexOf("\\"), trimmedPath.lastIndexOf("/"));
  return separatorIndex > 0 ? trimmedPath.slice(0, separatorIndex) : "";
}

export function filterPortEntries(entries: PortEntry[], query: string): PortEntry[] {
  const needle = query.trim().toLowerCase();

  if (!needle) {
    return entries;
  }

  return entries.filter((entry) => {
    const fields = [
      entry.port,
      entry.protocol,
      entry.state,
      entry.local_address,
      entry.remote_address,
      entry.endpoint.local_ip,
      entry.endpoint.remote_ip ?? "",
      entry.pid,
      entry.process_name,
      entry.process_path,
      entry.protection_reason,
    ];

    return fields.some((field) => String(field).toLowerCase().includes(needle));
  });
}

export function protocolCounts(entries: PortEntry[]) {
  return entries.reduce(
    (counts, entry) => {
      counts[entry.protocol] += 1;
      return counts;
    },
    { TCP: 0, UDP: 0 },
  );
}

export function uniqueProcessCount(entries: PortEntry[]) {
  return new Set(entries.map((entry) => entry.pid)).size;
}

export function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
