# Backend Development Guidelines

> Executable contracts for PortKiller's Rust and Win32 backend.

## Pre-Development Checklist

- Read [Windows endpoint and termination safety](./windows-safety.md) before
  changing endpoint inventory, process metadata, IPC payloads, or termination.
- Read `../guides/cross-layer-thinking-guide.md` when a serialized field or
  command signature changes.

## Guidelines Index

| Guide | Description | Status |
| --- | --- | --- |
| [Windows endpoint and termination safety](./windows-safety.md) | Win32 table acquisition, normalized endpoint identity, and verified single-process termination | Active |

**Language**: All documentation should be written in English.
