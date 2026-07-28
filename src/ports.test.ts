import { describe, expect, it } from "vitest";
import {
  createKillProcessRequest,
  directoryFromProcessPath,
  filterPortEntries,
  findPortEntriesByPort,
  findRemainingPortOwners,
  portEntryId,
} from "./ports";
import type { PortEntry } from "./ports";

function tcpEntry(overrides: Partial<PortEntry> = {}): PortEntry {
  return {
    port: 3000,
    protocol: "TCP",
    state: "LISTEN",
    local_address: "127.0.0.1:3000",
    remote_address: "0.0.0.0:0",
    pid: 18420,
    process_name: "node.exe",
    process_path: "C:\\Program Files\\nodejs\\node.exe",
    entry_id: "backend-entry-node",
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
    ...overrides,
  };
}

const entries: PortEntry[] = [
  tcpEntry(),
  tcpEntry({
    port: 5432,
    local_address: "0.0.0.0:5432",
    pid: 9120,
    process_name: "postgres.exe",
    process_path: "C:\\PostgreSQL\\postgres.exe",
    entry_id: "backend-entry-postgres",
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
  }),
];

describe("filterPortEntries", () => {
  it("matches port, pid, process name and address fields", () => {
    expect(filterPortEntries(entries, "3000")).toHaveLength(1);
    expect(filterPortEntries(entries, "9120")[0].process_name).toBe("postgres.exe");
    expect(filterPortEntries(entries, "node")[0].port).toBe(3000);
    expect(filterPortEntries(entries, "0.0.0.0").map((entry) => entry.port)).toEqual([
      3000,
      5432,
    ]);
  });
});

describe("findPortEntriesByPort", () => {
  it("returns exact port matches only for valid port input", () => {
    expect(findPortEntriesByPort(entries, "3000")).toHaveLength(1);
    expect(findPortEntriesByPort(entries, "300")).toHaveLength(0);
    expect(findPortEntriesByPort(entries, "70000")).toHaveLength(0);
    expect(findPortEntriesByPort(entries, "node")).toHaveLength(0);
  });
});

describe("findRemainingPortOwners", () => {
  it("returns refreshed owners still bound to the target port and protocol", () => {
    const target = entries[0];
    const refreshedEntries: PortEntry[] = [
      tcpEntry({
        pid: 2048,
        process_name: "nginx.exe",
        entry_id: "backend-entry-nginx",
      }),
      tcpEntry({
        protocol: "UDP",
        pid: 5353,
        process_name: "mDNSResponder.exe",
        entry_id: "backend-entry-mdns",
      }),
      entries[1],
    ];

    expect(findRemainingPortOwners(refreshedEntries, target)).toEqual([refreshedEntries[0]]);
  });
});

describe("backend identity contract", () => {
  it("uses the opaque backend entry id without rebuilding it", () => {
    expect(portEntryId(entries[0])).toBe("backend-entry-node");
  });

  it("forwards every authoritative kill-request field unchanged", () => {
    expect(createKillProcessRequest(entries[0])).toEqual({
      entry_id: entries[0].entry_id,
      pid: entries[0].pid,
      endpoint: entries[0].endpoint,
      process_instance_id: entries[0].process_instance_id,
    });
  });
});

describe("directoryFromProcessPath", () => {
  it("extracts the containing directory from Windows and slash paths", () => {
    expect(directoryFromProcessPath("C:\\Program Files\\nodejs\\node.exe")).toBe(
      "C:\\Program Files\\nodejs",
    );
    expect(directoryFromProcessPath("D:/tools/app.exe")).toBe("D:/tools");
    expect(directoryFromProcessPath("")).toBe("");
  });
});
