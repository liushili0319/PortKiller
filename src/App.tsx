import { useCallback, useEffect, useState } from "react";
import { defaultPortApi, revealMainWindow, type PortApi } from "./api";
import { ActionMenu } from "./components/ActionMenu";
import {
  CommandDeck,
  CommandHeader,
  SignalRail,
} from "./components/ConsoleChrome";
import { EndpointTable } from "./components/EndpointTable";
import { EventStrip } from "./components/EventStrip";
import { KillDialog } from "./components/KillDialog";
import { TargetInspector } from "./components/TargetInspector";
import type { PortEntry } from "./ports";
import { afterStartupPaint } from "./startup";
import { usePortController } from "./usePortController";

type MenuState = {
  entry: PortEntry;
  trigger: HTMLButtonElement;
} | null;

type AppProps = {
  api?: PortApi;
  autoStart?: boolean;
  startupDelayMs?: number;
};

export function App({
  api = defaultPortApi,
  autoStart = true,
  startupDelayMs = 120,
}: AppProps) {
  const controller = usePortController(api);
  const { refreshPorts } = controller;
  const [menu, setMenu] = useState<MenuState>(null);

  useEffect(() => {
    if (!autoStart) {
      return;
    }

    const revealTimer = window.setTimeout(() => {
      void revealMainWindow().catch((error: unknown) => {
        console.warn("Unable to reveal PortKiller window.", error);
      });
    }, 0);
    const cancelInitialRefresh = afterStartupPaint(
      () => {
        void refreshPorts();
      },
      startupDelayMs,
    );

    return () => {
      window.clearTimeout(revealTimer);
      cancelInitialRefresh();
    };
  }, [autoStart, refreshPorts, startupDelayMs]);

  const closeMenu = useCallback(() => setMenu(null), []);

  function refresh() {
    closeMenu();
    void controller.refreshPorts();
  }

  return (
    <main className="app-shell">
      <CommandHeader
        runtime={controller.state.runtime}
        runtimeReady={controller.state.runtimeReady}
        operation={controller.state.operation}
        scanStatus={controller.state.scanStatus}
        lastRefresh={controller.state.lastRefresh}
        onRefresh={refresh}
        onElevate={() => void controller.requestAdminRestart()}
      />

      <SignalRail
        total={controller.state.entries.length}
        visible={controller.filteredEntries.length}
        tcp={controller.counts.TCP}
        udp={controller.counts.UDP}
        processes={controller.processCount}
        scanStatus={controller.state.scanStatus}
        scanProgress={controller.state.scanProgress}
      />

      <CommandDeck
        query={controller.state.query}
        releasePort={controller.state.releasePort}
        releaseMatchCount={controller.releaseMatches.length}
        protocol={controller.state.protocol}
        preview={controller.state.runtime.capabilities.mode === "preview"}
        systemBusy={controller.state.operation !== "idle"}
        onQueryChange={controller.setQuery}
        onReleasePortChange={controller.setReleasePort}
        onProtocolChange={controller.setProtocol}
        onLocatePort={controller.locatePort}
      />

      <div className="console-workspace">
        <EndpointTable
          entries={controller.filteredEntries}
          selectedEntry={controller.selectedEntry}
          scanStatus={controller.state.scanStatus}
          scanProgress={controller.state.scanProgress}
          activeMenuEntryId={menu?.entry.entry_id ?? null}
          onSelect={(entry) => {
            closeMenu();
            controller.selectEntry(entry);
          }}
          onOpenActions={(entry, trigger) => setMenu({ entry, trigger })}
        />
        <TargetInspector
          entry={controller.selectedEntry}
          capabilities={controller.state.runtime.capabilities}
          operation={controller.state.operation}
          onCopy={(label, value) => void controller.copyValue(label, value)}
          onReveal={(entry) => void controller.revealProcess(entry)}
          onTerminate={controller.requestTermination}
        />
      </div>

      <EventStrip
        feedback={controller.state.feedback}
        onDismiss={controller.clearFeedback}
      />

      {menu && (
        <ActionMenu
          entry={menu.entry}
          trigger={menu.trigger}
          capabilities={controller.state.runtime.capabilities}
          systemBusy={controller.state.operation !== "idle"}
          onCopy={(label, value) => void controller.copyValue(label, value)}
          onReveal={(entry) => void controller.revealProcess(entry)}
          onClose={closeMenu}
        />
      )}

      <KillDialog
        entry={controller.confirmingEntry}
        busy={controller.state.operation !== "idle"}
        onCancel={controller.closeConfirmation}
        onConfirm={() => void controller.confirmTermination()}
      />
    </main>
  );
}
