# Windows Endpoint and Termination Safety

## Scenario: Inventory and verified termination

### 1. Scope / Trigger

Apply this contract whenever changing `get_port_entries`,
`kill_port_process`, the IP Helper table readers, process metadata, or their
TypeScript consumer. These paths cross a destructive trust boundary: cached UI
data can be stale, a PID can be reused, and Win32 tables can change size while
being read.

### 2. Signatures

```rust
async fn get_port_entries() -> Result<Vec<PortEntry>, String>;
async fn kill_port_process(
    request: KillProcessRequest,
) -> Result<TerminationOutcome, String>;

struct KillProcessRequest {
    entry_id: String,
    pid: u32,
    endpoint: EndpointKey,
    process_instance_id: Option<String>,
}
```

Both Tauri commands keep Win32 work inside
`tauri::async_runtime::spawn_blocking`. Command names are stable even when the
typed payload evolves.

### 3. Contracts

- A `PortEntry` carries its display fields plus `entry_id`, `endpoint`,
  `process_instance_id`, `can_terminate`, and `protection_reason`.
- The frontend forwards `entry_id`, `endpoint`, PID, and instance ID unchanged.
  It never parses a display address or maintains a protected-process list.
- `entry_id` covers endpoint, PID, and instance ID. The backend recomputes it
  before acting; it is opaque to the frontend, not an authorization token.
- Process instance IDs are non-zero Windows creation `FILETIME` values encoded
  as exactly 16 lowercase hexadecimal characters.
- A termination opens one PID once. Identity, liveness, termination, and final
  wait all use that retained handle. No same-name or process-tree expansion is
  permitted.
- Exact endpoint ownership is reread immediately before termination. Unknown
  identity, ownership, protection, or wait state fails closed.
- `terminated` means `TerminateProcess` succeeded and the retained handle
  became signaled. The other statuses are `already_exited`, `rejected`, and
  `failed`; consumers branch on `status`/`reason`, never `message`.
- A complete scan reads TCP/UDP for IPv4 and IPv6. Failure of any required table
  fails the scan; a partial inventory must not be returned as complete.
- Each table uses a null sizing probe followed by at most four allocated reads,
  a 256 MiB maximum, fallible zero-initialized allocation, checked row extents,
  and `read_unaligned` through a sealed/unsafe POD contract.
- Treat the IP Helper return value as the error code. On success accept trailing
  allocation slack after validating the returned logical length and the
  count-derived row extent.
- Normalize LISTEN remote data to the family wildcard and port zero. IPv6
  scopes are network byte order and display inside brackets as
  `[address%scope]:port`.

### 4. Validation & Error Matrix

| Condition | Required result | Terminate call |
| --- | --- | --- |
| Missing instance ID | `rejected/identity_unavailable` | No |
| Malformed/zero ID, invalid endpoint, mismatched `entry_id` | `failed/invalid_request` | No |
| Protected PID/live executable | `rejected/protected_process` | No |
| Different process instance | `rejected/process_instance_changed` | No |
| Endpoint missing or owned by another PID | `rejected/endpoint_changed` | No |
| Endpoint table acquisition/parse failure | `failed/endpoint_verification_failed` | No |
| Process already gone | `already_exited/already_exited` | No |
| Access denied | `failed/access_denied` | No |
| Termination call fails while live | `failed/termination_failed` | Attempted once |
| Confirmation timeout / wait ambiguity | `failed/confirmation_timeout` or `failed/wait_failed` | Attempted once |
| Retained handle signals after termination | `terminated/confirmed` | Attempted once |

### 5. Good / Base / Bad Cases

- Good: a current row is forwarded unchanged, the same process instance still
  owns the endpoint, and only its retained handle is terminated and confirmed.
- Base: an endpoint row whose metadata cannot be queried remains visible with
  `can_terminate = false` and `protection_reason = "identity_unavailable"`.
- Bad: accepting PID plus process name, rebuilding an endpoint from
  `local_address`, returning a partial four-table scan, or treating a timeout as
  successful termination.

### 6. Tests Required

- Script probe/read calls and assert the input size is reset for each attempt,
  repeated resize is bounded, non-growing and over-limit sizes fail, trailing
  slack succeeds, and declared row extents never exceed logical bytes.
- Decode independent asymmetric fixtures for all four table layouts, including
  unaligned input, truncated rows, IPv6 scope, LISTEN normalization, and UDP's
  empty remote display.
- Shuffle mixed endpoint records and assert one deterministic total order.
- Fake each termination observation and assert every precondition failure makes
  zero termination calls; success targets exactly the requested PID once.
- Default automated tests never terminate ambient processes. A real smoke test
  may terminate only a disposable child created and tracked by that test.
- Run locked Rustfmt, tests, and Clippy with warnings denied.

### 7. Wrong vs Correct

#### Wrong

```rust
// PID/name are stale display data; reopening after checks permits retargeting.
kill_port_process(pid, process_name);
OpenProcess(..., pid); // again after validation
```

#### Correct

```rust
kill_port_process(KillProcessRequest {
    entry_id,
    pid,
    endpoint,
    process_instance_id,
});
// Open once, validate and act through the same RAII handle, then confirm exit.
```
