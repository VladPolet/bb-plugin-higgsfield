// Host worker: runs on the user's machine and shells out to the `higgsfield`
// CLI. The CLI keeps its own OAuth credentials in ~/.config/higgsfield; this
// worker only runs read-only account commands plus login/logout.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract, hostSignals, type CliResult } from "./contract.js";

const CALL_TIMEOUT_MS = 25_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const AUTH_ERROR =
  /not authenticated|session expired|unauthori[sz]ed|\b401\b|auth login|no credentials|token (is )?(missing|expired|invalid)/i;

function runCli(
  binary: string,
  args: string[],
  signal: AbortSignal,
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      binary,
      [...args, "--json", "--no-color"],
      { timeout: CALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, signal },
      (error, stdout, stderr) => {
        const text = `${stderr}\n${stdout}`.trim();
        if (error !== null) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            resolve({
              ok: false,
              reason: "missing-cli",
              message: `Could not find "${binary}". Install the Higgsfield CLI or set its path in the plugin settings.`,
            });
            return;
          }
          resolve({
            ok: false,
            reason: AUTH_ERROR.test(text) ? "auth" : "failed",
            message: firstLine(text) || error.message,
          });
          return;
        }
        try {
          resolve({ ok: true, data: JSON.parse(stdout) as unknown });
        } catch {
          resolve({
            ok: false,
            reason: AUTH_ERROR.test(text) ? "auth" : "failed",
            message: `Unexpected non-JSON output: ${firstLine(text).slice(0, 300)}`,
          });
        }
      },
    );
  });
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

let loginProcess: ChildProcess | null = null;
let loginUrl: string | null = null;

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    accountStatus: ({ binary }, context) =>
      runCli(binary, ["account", "status"], context.signal),
    transactions: ({ binary, size, cursor }, context) =>
      runCli(
        binary,
        [
          "account",
          "transactions",
          "--size",
          String(size),
          ...(cursor === undefined ? [] : ["--cursor", cursor]),
        ],
        context.signal,
      ),
    jobs: ({ binary, size, kind }, context) =>
      runCli(
        binary,
        [
          "generate",
          "list",
          "--size",
          String(size),
          ...(kind === undefined ? [] : [`--${kind}`]),
        ],
        context.signal,
      ),
    models: ({ binary, kind }, context) =>
      runCli(binary, ["model", "list", `--${kind}`], context.signal),
    workspaceStatus: ({ binary }, context) =>
      runCli(binary, ["workspace", "status"], context.signal),
    logout: ({ binary }, context) =>
      runCli(binary, ["auth", "logout"], context.signal),
    login: ({ binary }, context) => {
      if (loginProcess !== null) {
        return {
          started: true,
          url: loginUrl,
          message: "A Higgsfield login is already waiting for the browser.",
        };
      }
      return new Promise((resolve) => {
        const lease = context.experimental_retainWorker();
        const child = spawn(binary, ["auth", "login"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        loginProcess = child;
        loginUrl = null;
        let output = "";
        let settled = false;
        const settle = (value: {
          started: boolean;
          url: string | null;
          message: string;
        }) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const onData = (chunk: Buffer) => {
          output = (output + chunk.toString("utf8")).slice(-16_384);
          const match = /https?:\/\/[^\s"'<>]+/.exec(output);
          if (match !== null && loginUrl === null) {
            loginUrl = match[0];
            settle({
              started: true,
              url: loginUrl,
              message:
                "Finish signing in in your browser (Continue with Google works).",
            });
          }
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        // The CLI usually opens the browser itself; answer the UI even when
        // it prints no URL.
        const early = setTimeout(
          () =>
            settle({
              started: true,
              url: null,
              message:
                "A browser window should have opened. Finish signing in there.",
            }),
          4_000,
        );
        const killer = setTimeout(() => child.kill("SIGTERM"), LOGIN_TIMEOUT_MS);
        const onLifecycleAbort = () => child.kill("SIGTERM");
        context.lifecycle.signal.addEventListener("abort", onLifecycleAbort, {
          once: true,
        });
        let finished = false;
        const finish = (ok: boolean, message: string) => {
          // "error" and "exit" can both fire for one child.
          if (finished) return;
          finished = true;
          clearTimeout(early);
          clearTimeout(killer);
          context.lifecycle.signal.removeEventListener("abort", onLifecycleAbort);
          loginProcess = null;
          loginUrl = null;
          settle({ started: ok, url: null, message });
          void context
            .experimental_emitSignal("authChanged", { ok, message })
            .catch(() => undefined)
            .finally(() => lease.dispose());
        };
        child.on("error", (error) => {
          const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
          finish(
            false,
            missing
              ? `Could not find "${binary}". Install the Higgsfield CLI first.`
              : error.message,
          );
        });
        child.on("exit", (code) =>
          finish(
            code === 0,
            code === 0
              ? "Signed in to Higgsfield."
              : firstLine(output) || `Login exited with code ${code ?? "?"}.`,
          ),
        );
      });
    },
  },
  dispose: () => {
    loginProcess?.kill("SIGTERM");
  },
});
