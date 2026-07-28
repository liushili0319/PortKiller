import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const distDirectory = path.join(projectRoot, "dist");
const executablePath = path.join(distDirectory, "PortKiller.exe");
const sentinelPath = path.join(
  distDirectory,
  `.release-output-sentinel-${process.pid}`,
);

function hash(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

mkdirSync(distDirectory, { recursive: true });

if (existsSync(sentinelPath)) {
  throw new Error(`Refusing to overwrite existing sentinel: ${sentinelPath}`);
}

const sentinelContents = randomBytes(32);
const executableContents = existsSync(executablePath)
  ? readFileSync(executablePath)
  : null;

writeFileSync(sentinelPath, sentinelContents);

try {
  const npmOptions = {
    cwd: projectRoot,
    stdio: "inherit",
  };

  if (process.platform === "win32") {
    const commandProcessor =
      process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
    execFileSync(
      commandProcessor,
      ["/d", "/s", "/c", "npm.cmd run build:web"],
      npmOptions,
    );
  } else {
    execFileSync("npm", ["run", "build:web"], npmOptions);
  }

  if (!existsSync(sentinelPath)) {
    throw new Error("The frontend build removed a release-directory sentinel.");
  }

  const currentSentinel = readFileSync(sentinelPath);
  if (hash(currentSentinel) !== hash(sentinelContents)) {
    throw new Error("The frontend build modified a release-directory sentinel.");
  }

  if (executableContents) {
    if (!existsSync(executablePath)) {
      throw new Error("The frontend build removed dist/PortKiller.exe.");
    }

    const currentExecutable = readFileSync(executablePath);
    if (hash(currentExecutable) !== hash(executableContents)) {
      throw new Error("The frontend build modified dist/PortKiller.exe.");
    }
  }

  console.log("Verified: frontend output is isolated from release artifacts.");
} finally {
  rmSync(sentinelPath, { force: true });

  if (executableContents) {
    const currentExecutable = existsSync(executablePath)
      ? readFileSync(executablePath)
      : null;

    if (!currentExecutable || hash(currentExecutable) !== hash(executableContents)) {
      writeFileSync(executablePath, executableContents);
    }
  }
}
