# Quality Guidelines

> Executable quality and build-output contracts for the PortKiller frontend.

## Required Quality Gate

Run `npm run check` before packaging. It owns the following stable entry points:

| Command | Contract |
| --- | --- |
| `npm run typecheck` | TypeScript validation without emission |
| `npm run lint` | TypeScript, React Hooks, and JSX accessibility rules with zero warnings |
| `npm test` | Frontend unit tests in run mode |
| `npm run test:build-output` | A real Vite build plus release-artifact preservation assertions |
| `npm run check:rust` | Rustfmt, Clippy with warnings denied, and locked Rust tests |
| `npm run check` | Frontend checks followed by Rust checks |

Do not suppress lint warnings to make the aggregate pass. Fix hook dependencies
and accessible interaction behavior at the source.

## Scenario: Isolated Web and Release Outputs

### 1. Scope / Trigger

Apply this contract whenever changing Vite output, Tauri `distDir`, packaging,
or any command that builds the frontend. Vite normally empties its output
directory, so sharing `dist/` with the packaged executable can delete a release.

### 2. Signatures

- `npm run build:web` writes the production web bundle.
- `npm run build` runs type checking and then `build:web`.
- `npm run build:exe` invokes `scripts/build-exe.ps1`.
- `npm run test:build-output` invokes `scripts/verify-build-output.mjs`.

### 3. Contracts

- Vite owns `dist/web/**` through `build.outDir: "dist/web"`.
- Tauri consumes that same directory through `distDir: "../dist/web"`.
- The packaging script owns `dist/PortKiller.exe` and resolves the project root
  from `$PSScriptRoot`, not the caller's current directory.
- Packaging must use `node_modules/.bin/tauri.cmd`; it must not use `npx` or
  download an unpinned CLI.
- A frontend-only build must preserve every file directly under `dist/`,
  including `PortKiller.exe`, byte for byte.
- On Windows, Node scripts launch npm through `ComSpec /d /s /c` because direct
  `spawnSync`/`execFileSync` of `npm.cmd` can fail with `EINVAL` on Node 24.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Local Tauri CLI is missing | Packaging stops with an instruction to run `npm ci` |
| Visual Studio C++ tools are missing | Packaging stops before invoking Cargo |
| A web build removes or changes the sentinel | Regression command fails |
| A web build removes or changes an existing EXE | Regression command fails and restores the saved EXE bytes |
| A build fails after the sentinel is written | `finally` removes the sentinel and restores the saved EXE when needed |

### 5. Good / Base / Bad Cases

- Good: `dist/PortKiller.exe` exists; `npm run test:build-output` rebuilds only
  `dist/web` and reports that release artifacts are isolated.
- Base: no EXE exists yet; the same command still verifies a random sentinel
  directly under `dist/` survives.
- Bad: `outDir` is changed back to `dist`; the regression must fail instead of
  silently accepting a deleted release.

### 6. Tests Required

- Run `npm run test:build-output` after every build-path change.
- Assert the sentinel exists after Vite returns and its SHA-256 is unchanged.
- If `dist/PortKiller.exe` exists, assert its presence and SHA-256 are unchanged.
- Invoke `scripts/build-exe.ps1` from outside the repository for packaging
  changes and assert `dist/PortKiller.exe` is produced.
- Run `npm audit` and `npm audit --omit=dev` after dependency changes; document
  any constrained advisory with its dependency path and runtime reachability.

### 7. Wrong vs Correct

#### Wrong

```ts
export default defineConfig({
  build: { outDir: "dist" },
});
```

#### Correct

```ts
export default defineConfig({
  build: { outDir: "dist/web" },
});
```

Keep the matching Tauri `distDir` update in the same change.

## Review Checklist

- [ ] `npm run check` passes without ignored warnings.
- [ ] Web and EXE output owners remain separate.
- [ ] The output-preservation regression executes a real production build.
- [ ] Package manifest and lockfile change together.
- [ ] Full and production-only npm audits have been reviewed.
- [ ] No generated directory or user artifact was deleted as part of validation.
