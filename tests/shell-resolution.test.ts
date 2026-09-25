/**
 * Regression tests for POSIX shell resolution.
 *
 * Context: GUI-launched apps on macOS (Dock/Finder) can inherit a minimal or
 * empty PATH, so a bare `"sh"` argv0 passed to `spawn()` / `Bun.spawn()`
 * fails with `posix_spawn 'sh' ENOENT` even though /bin/sh exists. These
 * tests pin the fix: `shellInvocation()` / `spawnShell()` / `bunShellArgs()`
 * must resolve and use an *absolute* shell path — resolved from the parent
 * process's own environment, independent of whatever PATH is handed to the
 * child.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  _resetPosixShellCache,
  bunShellArgs,
  describeShellSpawnError,
  IS_WIN,
  resolvePosixShell,
  shellInvocation,
  spawnShell,
} from "../src/core/platform/index.js";

function withEnvVar(name: string, value: string, fn: () => void) {
  const orig = process.env[name];
  process.env[name] = value;
  try {
    fn();
  } finally {
    if (orig === undefined) delete process.env[name];
    else process.env[name] = orig;
  }
}

afterEach(() => {
  delete process.env.SOULFORGE_SHELL;
  _resetPosixShellCache();
});

describe("resolvePosixShell", () => {
  test.if(!IS_WIN)("returns an absolute path", () => {
    const shell = resolvePosixShell();
    expect(shell.startsWith("/")).toBe(true);
  });

  test.if(!IS_WIN)("is cached across calls", () => {
    expect(resolvePosixShell()).toBe(resolvePosixShell());
  });

  test.if(!IS_WIN)("honours a valid absolute SOULFORGE_SHELL override", () => {
    withEnvVar("SOULFORGE_SHELL", "/bin/sh", () => {
      _resetPosixShellCache();
      expect(resolvePosixShell()).toBe("/bin/sh");
    });
  });

  test.if(!IS_WIN)("ignores a SOULFORGE_SHELL override pointing at a nonexistent file", () => {
    withEnvVar("SOULFORGE_SHELL", "/definitely/not/a/real/shell-xyzzy", () => {
      _resetPosixShellCache();
      const shell = resolvePosixShell();
      expect(shell).not.toBe("/definitely/not/a/real/shell-xyzzy");
      expect(shell.startsWith("/")).toBe(true);
    });
  });

  test.if(!IS_WIN)("ignores a relative SOULFORGE_SHELL override", () => {
    withEnvVar("SOULFORGE_SHELL", "sh", () => {
      _resetPosixShellCache();
      const shell = resolvePosixShell();
      expect(shell).not.toBe("sh");
      expect(shell.startsWith("/")).toBe(true);
    });
  });
});

describe("shellInvocation / bunShellArgs resolve an absolute path", () => {
  test.if(!IS_WIN)("shellInvocation().cmd is absolute", () => {
    _resetPosixShellCache();
    const { cmd, flag } = shellInvocation();
    expect(cmd.startsWith("/")).toBe(true);
    expect(flag).toBe("-c");
  });

  test.if(!IS_WIN)("bunShellArgs()[0] is absolute", () => {
    _resetPosixShellCache();
    const args = bunShellArgs("echo hi");
    expect(args[0]?.startsWith("/")).toBe(true);
    expect(args.slice(1)).toEqual(["-c", "echo hi"]);
  });
});

describe("regression: a stripped child PATH no longer breaks shell spawning", () => {
  test.if(!IS_WIN)(
    "spawnShell succeeds when the child env has an empty PATH",
    async () => {
      _resetPosixShellCache();
      const proc = spawnShell("echo ok", {
        env: { PATH: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const result = await new Promise<{ code: number | null; stdout: string }>(
        (resolve, reject) => {
          let stdout = "";
          proc.stdout?.on("data", (d: Buffer) => {
            stdout += d.toString();
          });
          proc.on("error", reject);
          proc.on("close", (code) => resolve({ code, stdout }));
        },
      );
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("ok");
    },
  );

  test.if(!IS_WIN)(
    "Bun.spawn(bunShellArgs(...)) succeeds when the child env has an empty PATH",
    async () => {
      _resetPosixShellCache();
      const proc = Bun.spawn(bunShellArgs("echo ok"), {
        env: { PATH: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("ok");
    },
  );
});

describe("describeShellSpawnError", () => {
  test.if(!IS_WIN)(
    "produces a clear, attributed message for a missing shell binary",
    async () => {
      const shellPath = "/definitely/not/a/real/shell-xyzzy";
      const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
        const proc = spawn(shellPath, ["-c", "echo hi"]);
        proc.on("error", (e) => resolve(e as NodeJS.ErrnoException));
      });
      expect(err.code).toBe("ENOENT");

      const msg = describeShellSpawnError(err, shellPath);
      expect(msg).toContain(shellPath);
      expect(msg).toContain("ENOENT");
      expect(msg).toContain("SOULFORGE_SHELL");
    },
  );

  test("passes non-ENOENT errors through unchanged", () => {
    const err = Object.assign(new Error("some other failure"), { code: "EACCES" });
    expect(describeShellSpawnError(err, "/bin/sh")).toBe("some other failure");
  });

  test("stringifies a non-Error thrown value", () => {
    expect(describeShellSpawnError("boom", "/bin/sh")).toBe("boom");
  });
});
