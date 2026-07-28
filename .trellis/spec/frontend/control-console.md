# Endpoint Control Console Contract

## Scenario: Inventory presentation and verified termination flows

### 1. Scope / Trigger

Apply this contract whenever changing the React port inventory, Tauri IPC
adapter, scan controller, runtime capability checks, endpoint table, row action
menu, target inspector, termination dialog, or operation feedback.

This UI crosses the backend's destructive trust boundary. Display fields may be
stale, preview mode cannot execute system commands, and a late scan response
must not replace a newer inventory.

### 2. Signatures

```ts
type KillProcessRequest = Pick<
  PortEntry,
  "entry_id" | "pid" | "endpoint" | "process_instance_id"
>;

type PortApi = {
  getRuntimeContext(): Promise<RuntimeContext>;
  getPortEntries(): Promise<PortEntry[]>;
  killPortProcess(entry: PortEntry): Promise<TerminationOutcome>;
  restartAsAdmin(): Promise<void>;
  revealProcessPath(processPath: string): Promise<void>;
};

type RuntimeCapabilities = {
  mode: "desktop" | "preview";
  can_elevate: boolean;
  can_reveal_path: boolean;
  can_terminate: boolean;
};

type TerminationOutcome = {
  pid: number;
  status: "terminated" | "already_exited" | "rejected" | "failed";
  reason: TerminationReason;
  message: string;
};
```

The Tauri termination call is always:

```ts
invoke<TerminationOutcome>("kill_port_process", {
  request: createKillProcessRequest(entry),
});
```

### 3. Contracts

- `src/ports.ts` owns the serialized frontend types. Components import those
  types and must not reconstruct a private backend payload.
- The frontend forwards `entry_id`, `pid`, the complete `endpoint`, and
  `process_instance_id` unchanged. `entry_id` is opaque; selection keys use it
  directly and never rebuild it from display addresses.
- Backend `can_terminate` and `protection_reason` are authoritative. The
  frontend must not maintain a protected-process name list.
- `src/api.ts` derives `RuntimeCapabilities` once. Preview mode sets all three
  system capabilities to `false`; unsupported actions are omitted from the UI,
  not rendered as controls that are guaranteed to fail.
- `usePortController` owns scan, selection, operation, filters, confirmation,
  and typed feedback. Every scan carries a monotonically increasing request ID;
  only the latest request may update runtime, progress, entries, or errors.
- Reveal, elevation, and termination share one synchronous ref-backed operation
  lease. Acquisition happens before any IPC call, including same-tick calls,
  and reducer completion carries the lease ID so an older completion cannot set
  a newer operation to `idle`.
- Feedback records their `scan` or `interaction` origin. Starting or completing
  a successful retry clears only stale scan failures; a refresh must not erase
  an unrelated operation outcome.
- Termination presentation branches on `status`, never on message text:
  `terminated -> success`, `already_exited -> info`, `rejected -> warning`, and
  `failed -> error`. `reason` may refine copy but cannot downgrade severity.
- `App.tsx` is a composition root. IPC orchestration stays in the controller;
  table, inspector, menu, dialog, chrome, and event rendering stay in focused
  components.
- Endpoint rows use a native table with `th`/`td`. Protocol toggles and row
  selectors expose `aria-pressed`. Row and action names include protocol and
  local endpoint so duplicate process bindings remain distinguishable. The
  action column stays sticky at the table's right edge at the minimum width.
- The row menu focuses its first item, supports Arrow Up/Down, Home, End, and
  Escape, and restores focus to its trigger when it closes.
- Destructive confirmation uses `HTMLDialogElement.showModal()`. Cancel receives
  initial focus, Escape only cancels, busy state prevents cancellation, and
  closing restores the prior focus target.
- `EventStrip` remains mounted as an atomic live region. Errors use an alert;
  other outcomes use status semantics and their stable severity class.
- The 980 x 640 Tauri minimum must not produce page-level horizontal overflow.
  The table may scroll horizontally, the inspector may scroll internally, and
  narrower web previews may stack the workspace with document scrolling.
- Small labels, table headers, detail keys, and placeholders retain at least
  4.5:1 contrast against their actual surfaces. Responsive CSS may condense
  them but must not remove metric labels or event titles from the accessibility
  tree.
- Nonessential entrance, shimmer, spinner, and transition motion is disabled by
  `prefers-reduced-motion: reduce`.

### 4. Validation & Error Matrix

| Condition | Required UI result |
| --- | --- |
| Preview runtime | Clearly labelled preview; no elevate, reveal, or terminate control |
| Older scan completes after a newer scan | Ignore the older success, progress, runtime, or failure action |
| Selected `entry_id` disappears after refresh | Select the first returned entry, or `null` for an empty inventory |
| Invalid exact port | Error event; no confirmation opens |
| Port has no visible owner | Warning event; no confirmation opens |
| Backend marks the row constrained | Show its protection reason; do not open confirmation |
| Reveal, elevation, or termination is already running | Disable competing system controls and make a second controller call a no-op |
| An older operation completion arrives | Ignore it unless its lease ID is still current |
| A failed scan is retried | Remove scan-origin failure feedback while preserving interaction feedback |
| `terminated` | Success event, followed by a refresh |
| `already_exited` | Informational event, followed by a refresh |
| `rejected` | Warning event; never success styling |
| `failed` or thrown IPC error | Error event; never success styling |
| Refresh itself fails | Failed scan state plus an error event; no partial inventory presented as ready |

### 5. Good / Base / Bad Cases

- Good: a selected backend row is forwarded unchanged, the controller refreshes
  after the typed outcome, and a rejection remains amber/warning.
- Base: preview samples include valid IPv4 and IPv6 endpoint shapes while all
  system actions remain hidden; copy and filtering still work.
- Bad: pass `pid` plus process name, derive an ID from `local_address`, infer
  success from message text, expose a preview terminate button, or implement a
  `div`-based table/dialog without the required keyboard model.

### 6. Tests Required

- Assert the exact nested Tauri request and all four authoritative request
  fields.
- Assert preview capability derivation and absence of elevate, reveal, and
  terminate controls.
- Resolve two scans out of order and prove the older response cannot overwrite
  the newer state.
- Cover loading, ready, empty, and failed scans; combined search/port/protocol
  filtering; and selection preservation by backend `entry_id`.
- Cover all four termination statuses and assert both semantic role and severity
  class; rejected and failed outcomes must never render as success.
- Exercise the row menu's initial focus, Arrow Up/Down, Home, End, Escape, and
  Tab, trigger focus restoration, and disabled-item skipping.
- Exercise dialog initial cancel focus, Escape cancellation, explicit confirm,
  busy state, and focus restoration.
- Hold each system operation pending and assert pairwise exclusion, same-tick
  duplicate termination suppression, and stale lease completion handling.
- Give one process multiple bindings and assert row/action accessible names are
  unique. Verify idle copy does not claim that data is ready and a successful
  retry removes its prior scan failure.
- Run `npm run check`, `npm audit`, and `npm audit --omit=dev`. Browser QA must
  cover a normal desktop viewport, 980 x 640, a narrower stacked layout,
  console errors, and Preview action omission.

### 7. Wrong vs Correct

#### Wrong

```ts
invoke("kill_port_process", { pid: entry.pid, processName: entry.process_name });

if (result.killed) {
  showSuccess(result.message);
}
```

#### Correct

```ts
const outcome = await invoke<TerminationOutcome>("kill_port_process", {
  request: createKillProcessRequest(entry),
});

setFeedback(terminationFeedbackSeverity(outcome.status), title, outcome.message);
```
