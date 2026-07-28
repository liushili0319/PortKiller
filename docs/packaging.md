# Windows Packaging

PortKiller packages a raw Windows executable with the lockfile-installed
Tauri 1 CLI. The default packaging command intentionally skips MSI creation,
so it does not need to download WiX.

## Prerequisites

- Windows 10 or Windows 11
- Node.js `^20.19.0`, `^22.13.0`, or `>=24`
- npm 11
- A recent stable Rust toolchain with the MSVC target
- Visual Studio 2022 C++ Build Tools with the
  `Microsoft.VisualStudio.Component.VC.Tools.x86.x64` component
- A Windows SDK
- Microsoft Edge WebView2 Runtime

Windows 10 and Windows 11 commonly include WebView2 already. Microsoft also
provides a standalone Evergreen installer when it is missing.

## Build

Install the pinned frontend and Tauri CLI dependencies first:

```powershell
npm ci
```

Run the packaging script:

```powershell
npm run build:exe
```

The script:

1. Locates Visual Studio Build Tools and loads the x64 MSVC environment.
2. Uses `node_modules/.bin/tauri.cmd` instead of downloading a CLI through
   `npx`.
3. Runs `tauri build --bundles none`.
4. Copies the resulting executable to `dist/PortKiller.exe`.

The outputs are:

- `src-tauri/target/release/PortKiller.exe`
- `dist/PortKiller.exe`

`scripts/build-exe.ps1` resolves the repository from its own location, so it
can also be invoked by path from another working directory.

## Build Output Isolation

Vite owns `dist/web`, while the packaging script owns
`dist/PortKiller.exe`. A frontend-only build may recreate `dist/web`, but it
must not modify or delete files directly under `dist`.

The regression command performs a real web build and verifies that a sentinel
and any existing executable keep the same SHA-256 hash:

```powershell
npm run test:build-output
```

## Verification

Run the aggregate quality gate before packaging:

```powershell
npm run check
npm audit
npm audit --omit=dev
```

After packaging, inspect the executable and record its checksum:

```powershell
Get-Item dist\PortKiller.exe
Get-FileHash dist\PortKiller.exe -Algorithm SHA256
```

## Troubleshooting

### The local Tauri CLI is missing

Run `npm ci`. Packaging deliberately refuses to fall back to an unpinned or
downloaded CLI.

### Rust cannot parse a dependency or use the selected target

Install or update the stable toolchain:

```powershell
rustup toolchain install stable --profile minimal
rustup default stable
```

### `cl.exe` or `link.exe` is missing

Install the Visual Studio Build Tools "Desktop development with C++" workload,
including the MSVC x64 tools and a Windows SDK. The packaging script loads
`VsDevCmd.bat` automatically after locating the installation.

### An MSI installer is required

The default task produces only the raw executable. To request an MSI bundle,
run:

```powershell
npm run tauri -- build --bundles msi
```

MSI creation requires WiX and may need network access the first time it runs.
