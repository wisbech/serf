import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { getSerfDir, ensureDir } from "./paths";
import { seedAgentEnvironment, type SeedResult } from "./agent-config";
import type { Config } from "./state";

export interface SandboxProfile {
  profilePath: string;
  homeDir: string;
  tmpDir: string;
}

export interface SandboxRunOptions {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

const SANDBOX_DIR = "sandboxes";

/**
 * Build a macOS sandbox-exec profile that uses an allow-default policy with
 * targeted denials. This is much more compatible with interactive agents
 * (opencode, claude, etc.) than an explicit-allow policy, while still
 * preventing persistent writes to user/system directories.
 */
export function createSandboxProfile(worktreePath: string, cardId?: string, config?: Config): SandboxProfile {
  const serfDir = getSerfDir();
  const sandboxDir = join(serfDir, SANDBOX_DIR);
  ensureDir(sandboxDir);

  const homeDir = join(worktreePath, ".serf", "home");
  const tmpDir = join(worktreePath, ".serf", "tmp");
  if (!existsSync(homeDir)) mkdirSync(homeDir, { recursive: true });
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  const resolvedWorktree = resolve(worktreePath);
  const resolvedSerf = resolve(serfDir);

  const profileName = cardId ? `${cardId}.sb` : "default.sb";
  const profilePath = join(sandboxDir, profileName);

  // Derive the user's home directory so we can block ~/.config, ~/.ssh, etc.
  const userHome = resolve(process.env.HOME ?? "/Users/unknown");
  const sshPath = join(userHome, ".ssh");
  const configPath = join(userHome, ".config");

  const lines = [
    "(version 1)",
    "",
    "; Allow most operations by default; deny specific dangerous paths",
    "(allow default)",
    "",
    "; Explicitly protect project and serf state directories (redundant but clear)",
    `(allow file-read* file-write* (subpath "${resolvedWorktree}"))`,
    `(allow file-read* file-write* (subpath "${resolvedSerf}"))`,
    "",
    "; Deny writes to persistent user/system config directories",
    `(deny file-write* (subpath "${configPath}"))`,
    `(deny file-write* (subpath "${sshPath}"))`,
    '(deny file-write* (subpath "/usr/local"))',
    '(deny file-write* (subpath "/Applications"))',
    "",
    "; Network is allowed by default; explicitly deny if needed in a stricter profile",
  ];

  writeFileSync(profilePath, lines.join("\n") + "\n");

  if (config) {
    seedAgentEnvironment(homeDir, config);
  }

  return { profilePath, homeDir, tmpDir };
}

/**
 * Run a command inside the sandbox. Returns the child process handle.
 */
export function runSandboxed(options: SandboxRunOptions, profile: SandboxProfile): ChildProcess {
  const { command, cwd, env, timeoutMs } = options;
  const args = ["-f", profile.profilePath, "/bin/sh", "-c", command];

  const child = spawn("sandbox-exec", args, {
    cwd: cwd ?? process.cwd(),
    env: {
      ...process.env,
      HOME: profile.homeDir,
      TMPDIR: profile.tmpDir,
      PATH: process.env.PATH,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (timeoutMs && timeoutMs > 0) {
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, 5000);
    }, timeoutMs);

    child.on("exit", () => clearTimeout(timer));
  }

  return child;
}

export function isSandboxAvailable(): boolean {
  try {
    // sandbox-exec is part of macOS and does not require root.
    return process.platform === "darwin";
  } catch {
    return false;
  }
}
