import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  REVIEW_TOOL_NAME,
  REVIEWER_SYSTEM_PROMPT,
  REVIEWER_TOOLS,
} from "./review-protocol.ts";

// Upstream-pi reviewer path for the behavior-control review process. Registers
// a model-callable tool that spawns a child `pi --mode json -p --no-session`
// running the read-only reviewer persona, parses its JSON event stream, and
// returns the reviewer's final findings text. Adapted from pi's
// `examples/extensions/subagent`. OMP uses its native `task` tool instead, so
// this tool is registered on both runtimes but only driven on upstream pi.

// Liveness for a single child-reviewer run. A thorough review legitimately
// takes many minutes (the OMP `task` reviewer runs 9+ minutes on a real diff),
// so a fixed wall-clock cap either kills good long runs or lingers on dead
// ones. Instead we watch the child's `--mode json` event stream: as long as it
// keeps emitting output it is alive, however long the review takes.
//
//   - Idle watchdog: kill if NO output (stdout or stderr) arrives for this
//     long. The child streams token deltas and turn/tool events constantly
//     while working, so only a genuinely stalled child (network hang, deadlock,
//     lost auth) trips it.
//   - Absolute backstop: a hard ceiling that bounds a pathological child that
//     keeps emitting forever (e.g. an infinite tool loop).
const REVIEWER_IDLE_TIMEOUT_MS = 120_000;
const REVIEWER_ABSOLUTE_TIMEOUT_MS = 1_800_000;
// Grace period between SIGTERM and SIGKILL when killing a child reviewer.
const KILL_GRACE_MS = 5_000;

export interface PiArgsOptions {
  /** The reviewer assignment passed to the child pi as the prompt. */
  task: string;
  /** Read-only tool set for the child reviewer. */
  tools?: readonly string[];
  /** Optional model override; omitted -> child uses its default model. */
  model?: string;
  /** Path to a file whose contents are appended to the child system prompt. */
  appendSystemPromptPath?: string;
}

// Build the argv for the child `pi` reviewer. Pure for testability.
export function buildPiArgs(opts: PiArgsOptions): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.tools && opts.tools.length > 0) {
    args.push("--tools", opts.tools.join(","));
  }
  if (opts.appendSystemPromptPath) {
    args.push("--append-system-prompt", opts.appendSystemPromptPath);
  }
  args.push(`Task: ${opts.task}`);
  return args;
}

// Runtime facts `getPiInvocation` needs, injected so the resolution logic is
// unit-testable without mutating the real process globals.
export interface PiRuntimeInfo {
  /** Current runtime executable (process.execPath). */
  execPath: string;
  /** Script the runtime is executing (process.argv[1]), if any. */
  scriptPath: string | undefined;
  /** Whether a path exists on disk. */
  fileExists: (p: string) => boolean;
}

const defaultPiRuntime: PiRuntimeInfo = {
  execPath: process.execPath,
  scriptPath: process.argv[1],
  fileExists: (p) => fs.existsSync(p),
};

// Resolve how to invoke `pi` from the current process. Mirrors the upstream
// subagent example: prefer re-running the current script under the same
// runtime; fall back to a `pi` on PATH only for generic node/bun runtimes.
//
// This re-runs whichever binary the current process is, so it is only correct
// when that binary is actually `pi` (upstream pi). The OMP path must never reach
// here -- see the runtime guard in registerPiReviewSubagent's execute.
export function getPiInvocation(
  args: string[],
  runtime: PiRuntimeInfo = defaultPiRuntime,
): {
  command: string;
  args: string[];
} {
  const currentScript = runtime.scriptPath;
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && runtime.fileExists(currentScript)) {
    return { command: runtime.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(runtime.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: runtime.execPath, args };
  }

  return { command: "pi", args };
}

export interface ReviewerOutput {
  /** All text parts of the last assistant message, joined (the findings). */
  finalText: string;
  /** Number of assistant turns seen. */
  turns: number;
  /** Stop reason of the last assistant message, if any. */
  stopReason?: string;
  /** Error message of the last assistant message, if any. */
  errorMessage?: string;
}

// One completed assistant turn parsed from the child `--mode json` stream.
interface ReviewerAssistantEnd {
  /** Joined text parts of the assistant message, or null if it had none. */
  text: string | null;
  stopReason?: string;
  errorMessage?: string;
}

// Parse a single NDJSON line. Returns the assistant `message_end` payload, or
// null for blank/unparseable/non-terminal lines. Shared by the buffered final
// parse and the incremental progress stream so both agree on exactly what
// counts as a completed reviewer turn.
function parseReviewerEventLine(line: string): ReviewerAssistantEnd | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let event: {
    type?: string;
    message?: {
      role?: string;
      stopReason?: string;
      errorMessage?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
  };
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (event.type !== "message_end" || !event.message) return null;
  const msg = event.message;
  if (msg.role !== "assistant") return null;

  let text: string | null = null;
  if (Array.isArray(msg.content)) {
    const texts: string[] = [];
    for (let j = 0; j < msg.content.length; j++) {
      const part = msg.content[j];
      if (part?.type === "text" && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
    if (texts.length > 0) text = texts.join("\n");
  }

  return { text, stopReason: msg.stopReason, errorMessage: msg.errorMessage };
}

// Parse the child pi `--mode json` stdout stream. Pure for testability: takes
// the full buffered stdout and returns the reviewer's final text plus status.
export function parseReviewerStdout(stdout: string): ReviewerOutput {
  let finalText = "";
  let turns = 0;
  let stopReason: string | undefined;
  let errorMessage: string | undefined;

  const lines = stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const ev = parseReviewerEventLine(lines[i] ?? "");
    if (!ev) continue;
    turns++;
    if (ev.stopReason) stopReason = ev.stopReason;
    if (ev.errorMessage) errorMessage = ev.errorMessage;
    if (ev.text !== null) finalText = ev.text;
  }

  return { finalText, turns, stopReason, errorMessage };
}

interface TempPrompt {
  dir: string;
  filePath: string;
}

async function writeReviewerPrompt(): Promise<TempPrompt> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-bc-review-"));
  const filePath = path.join(dir, "reviewer-prompt.md");
  await fs.promises.writeFile(filePath, REVIEWER_SYSTEM_PROMPT, {
    encoding: "utf-8",
    mode: 0o600,
  });
  return { dir, filePath };
}

function cleanupReviewerPrompt(tmp: TempPrompt): void {
  try {
    fs.unlinkSync(tmp.filePath);
  } catch {
    /* best-effort temp cleanup */
  }
  try {
    fs.rmdirSync(tmp.dir);
  } catch {
    /* best-effort temp cleanup */
  }
}

interface ReviewerToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: { turns: number; stopReason?: string };
}

// Minimal child-process surface runReviewer depends on. An injectable seam so
// the spawn/timeout/kill/cleanup logic is unit-testable with a fake child.
export interface ReviewerChildProcess {
  readonly stdout: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  } | null;
  readonly stderr: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  } | null;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}

export type ReviewerSpawn = (
  command: string,
  args: string[],
  options: { cwd: string },
) => ReviewerChildProcess;

export interface RunReviewerDeps {
  /** Spawner for the child reviewer; defaults to node's child_process.spawn. */
  spawnChild?: ReviewerSpawn;
  /** Kill if no output arrives for this long; defaults to REVIEWER_IDLE_TIMEOUT_MS. */
  idleTimeoutMs?: number;
  /** Hard ceiling on total run time; defaults to REVIEWER_ABSOLUTE_TIMEOUT_MS. */
  absoluteTimeoutMs?: number;
  /** SIGTERM -> SIGKILL grace; defaults to KILL_GRACE_MS. */
  killGraceMs?: number;
  /** Streams partial findings/progress to the caller as assistant turns land. */
  onUpdate?: (partial: ReviewerToolResult) => void;
}

const defaultSpawn: ReviewerSpawn = (command, args, options) =>
  spawn(command, args, {
    cwd: options.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

export async function runReviewer(
  task: string,
  cwd: string,
  signal: AbortSignal | undefined,
  deps: RunReviewerDeps = {},
): Promise<ReviewerToolResult> {
  const spawnChild = deps.spawnChild ?? defaultSpawn;
  const idleTimeoutMs = deps.idleTimeoutMs ?? REVIEWER_IDLE_TIMEOUT_MS;
  const absoluteTimeoutMs =
    deps.absoluteTimeoutMs ?? REVIEWER_ABSOLUTE_TIMEOUT_MS;
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;
  const onUpdate = deps.onUpdate;

  const tmp = await writeReviewerPrompt();
  try {
    const args = buildPiArgs({
      task,
      tools: REVIEWER_TOOLS,
      appendSystemPromptPath: tmp.filePath,
    });
    const invocation = getPiInvocation(args);

    let stdout = "";
    let stderr = "";
    let wasAborted = false;
    let idleTimedOut = false;
    let absoluteTimedOut = false;
    let signalKilled: NodeJS.Signals | null = null;
    // Captured from the spawn `error` event (e.g. `spawn pi ENOENT` when pi is
    // not resolvable -- the README's documented misconfiguration). Without
    // this the failure detail collapses to a misleading "exited with code 1".
    let spawnError: string | undefined;
    // Incremental NDJSON progress: buffer partial lines, count completed
    // assistant turns, and stream each to `onUpdate` as it lands. Best-effort
    // UI signal only -- the returned findings still come from the full buffer.
    let lineBuffer = "";
    let progressTurns = 0;
    const streamProgress = (chunk: string) => {
      lineBuffer += chunk;
      let newlineIndex = lineBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = lineBuffer.slice(0, newlineIndex);
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        const ev = parseReviewerEventLine(line);
        if (ev) {
          progressTurns++;
          const turnLabel = progressTurns === 1 ? "turn" : "turns";
          onUpdate?.({
            content: [
              {
                type: "text",
                text:
                  ev.text?.trim() || `reviewing… (${progressTurns} ${turnLabel})`,
              },
            ],
            details: { turns: progressTurns, stopReason: ev.stopReason },
          });
        }
        newlineIndex = lineBuffer.indexOf("\n");
      }
    };

    const code = await new Promise<number>((resolve) => {
      const proc = spawnChild(invocation.command, invocation.args, { cwd });

      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let absoluteTimer: ReturnType<typeof setTimeout> | undefined;

      // SIGTERM first, then SIGKILL after a grace period if it lingers.
      const killProc = () => {
        proc.kill("SIGTERM");
        // `proc.killed` flips true the moment a signal is *sent* (not when the
        // child exits), so it cannot gate escalation. `cleanup()` clears this
        // timer on close/error; if it still fires, the child ignored SIGTERM,
        // so force-kill only when it is genuinely still alive.
        killTimer ??= setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill("SIGKILL");
          }
        }, killGraceMs);
      };
      // Re-arm the idle watchdog on every chunk of output. A working reviewer
      // streams events continuously, so this fires only when the child goes
      // silent (network hang, deadlock, lost auth) -- not on a long review.
      const armIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleTimedOut = true;
          killProc();
        }, idleTimeoutMs);
      };
      const onAbort = () => {
        wasAborted = true;
        killProc();
      };
      // Clear every timer and the abort listener so a finished reviewer never
      // keeps the event loop alive.
      const cleanup = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (absoluteTimer) clearTimeout(absoluteTimer);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
      };

      proc.stdout?.on("data", (data) => {
        const chunk = data.toString();
        stdout += chunk;
        armIdleTimer();
        if (onUpdate) streamProgress(chunk);
      });
      proc.stderr?.on("data", (data) => {
        // stderr is liveness too -- a child logging progress is not stalled.
        stderr += data.toString();
        armIdleTimer();
      });
      proc.on("close", (closeCode) => {
        cleanup();
        // Flush any final NDJSON object that arrived without a trailing
        // newline so the streamed progress UI matches the buffered parse.
        if (onUpdate && lineBuffer.length > 0) {
          const remaining = lineBuffer;
          lineBuffer = "";
          streamProgress(`${remaining}\n`);
        }
        // A child terminated by a signal we did NOT send (external SIGKILL/OOM,
        // a supervisor, SIGINT to the group) exits with code null -> would map
        // to 0 below. Capture the signal so the failure check fails loud
        // instead of returning any partial findings as a successful review.
        if (proc.signalCode !== null) signalKilled = proc.signalCode;
        resolve(closeCode ?? 0);
      });
      proc.on("error", (err) => {
        cleanup();
        spawnError = err.message;
        resolve(1);
      });

      // Absolute backstop: never re-armed, bounds a child that streams forever.
      absoluteTimer = setTimeout(() => {
        absoluteTimedOut = true;
        killProc();
      }, absoluteTimeoutMs);
      armIdleTimer();

      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    const parsed = parseReviewerStdout(stdout);
    const failed =
      wasAborted ||
      idleTimedOut ||
      absoluteTimedOut ||
      signalKilled !== null ||
      code !== 0 ||
      parsed.stopReason === "error" ||
      parsed.stopReason === "aborted";

    // Signal failure by throwing: pi marks a tool result as an error only when
    // execute throws -- an `isError` field on the returned object is ignored.
    if (failed) {
      // Surface whatever the reviewer emitted before dying so a kill is
      // diagnosable instead of an opaque status.
      const partial = (parsed.finalText || stderr).trim();
      const tail = partial ? ` — last output: ${partial.slice(-400)}` : "";
      let detail: string;
      if (wasAborted) {
        detail = `reviewer aborted by caller${tail}`;
      } else if (idleTimedOut) {
        detail = `reviewer stalled (no output for ${idleTimeoutMs}ms)${tail}`;
      } else if (absoluteTimedOut) {
        detail = `reviewer exceeded the ${absoluteTimeoutMs}ms hard cap${tail}`;
      } else if (signalKilled !== null) {
        detail = `reviewer was terminated by signal ${signalKilled}${tail}`;
      } else {
        detail =
          spawnError ||
          parsed.errorMessage ||
          stderr.trim() ||
          parsed.finalText ||
          `reviewer pi exited with code ${code}`;
      }
      throw new Error(`Reviewer failed: ${detail}`);
    }

    return {
      content: [
        {
          type: "text",
          text: parsed.finalText || "(reviewer produced no findings)",
        },
      ],
      details: { turns: parsed.turns, stopReason: parsed.stopReason },
    };
  } finally {
    cleanupReviewerPrompt(tmp);
  }
}

const ReviewParams = Type.Object({
  task: Type.String({
    description:
      "The full reviewer assignment: inputs (original ask, change intent, intended behavior, coding-rules path, verification run) plus an instruction to audit the current uncommitted diff and return actionable findings only.",
  }),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the reviewer process (defaults to the session cwd).",
    }),
  ),
});

// Register the upstream-pi reviewer tool. On OMP the command drives the native
// `task` tool instead; this tool's execute refuses there (see the guard below)
// rather than re-spawning the wrong runtime binary.
export function registerPiReviewSubagent(pi: ExtensionAPI): void {
  pi.registerTool({
    name: REVIEW_TOOL_NAME,
    label: "Uncommitted Review",
    description:
      "Spawn a read-only adversarial reviewer (child pi process) to audit the current uncommitted diff and return actionable findings only. The behavior-control review process uses this on upstream pi (OMP uses the native task tool instead). Pass the full reviewer assignment as `task`.",
    parameters: ReviewParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // This adapter spawns a child `pi`. On OMP the running binary is `omp`,
      // not `pi`, so re-invoking it would launch the wrong runtime. OMP review
      // runs through the native `task` tool (agent: "reviewer"); refuse here
      // (throw -> tool error) instead of spawning the wrong process.
      // `getActiveTools()` is intentionally called directly here (not via the
      // command's `activeToolsSafe` degrade): inside a tool, an unavailable
      // runtime API should fail loud as a tool error, not silently proceed.
      if (pi.getActiveTools().includes("task")) {
        throw new Error(
          'uncommitted_review is the upstream-pi-only adapter. On this runtime, run the review through the `task` tool with `agent: "reviewer"` instead.',
        );
      }
      const cwd = params.cwd && params.cwd.length > 0 ? params.cwd : ctx.cwd;
      return await runReviewer(params.task, cwd, signal, { onUpdate });
    },
  });
}
