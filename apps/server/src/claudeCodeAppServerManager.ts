import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import readline from "node:readline";

import {
  EventId,
  ThreadId,
  TurnId,
  type ProviderEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type RuntimeMode,
} from "@t3tools/contracts";
import { Effect, ServiceMap } from "effect";

const CLAUDE_CODE_VERSION_CHECK_TIMEOUT_MS = 4_000;

/** How long to wait after the last stderr line before considering the CLI "settled". */
const CLAUDE_CODE_STDERR_SETTLE_MS = 1_500;
/** Maximum time to wait for the CLI to settle before writing to stdin. */
const CLAUDE_CODE_SETTLE_TIMEOUT_MS = 180_000; // 3 minutes

interface ClaudeCodeSessionContext {
  session: ProviderSession;
  child: ChildProcessWithoutNullStreams;
  output: readline.Interface;
  stopping: boolean;
  activeTurnId: TurnId | undefined;
  /** True once the first valid JSON line has been received on stdout. */
  initialized: boolean;
  /**
   * Resolves when the CLI is considered "settled" — either the first stdout
   * JSON line arrives (definitive) or stderr activity has quieted for a short
   * window (heuristic for SSO auth completion).
   */
  settledPromise: Promise<void>;
  resolveSettled: () => void;
  settleTimer: ReturnType<typeof setTimeout> | undefined;
  settleTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  settled: boolean;
}

export interface ClaudeCodeStartSessionInput {
  readonly threadId: ThreadId;
  readonly cwd?: string;
  readonly model?: string;
  readonly runtimeMode: RuntimeMode;
  readonly resumeCursor?: unknown;
  readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
}

export interface ClaudeCodeSendTurnInput {
  readonly threadId: ThreadId;
  readonly input?: string;
  readonly model?: string;
}

export interface ClaudeCodeAppServerManagerEvents {
  event: [event: ProviderEvent];
}

interface ClaudeCodeProviderOptions {
  readonly binaryPath?: string;
  readonly useBedrock?: boolean;
  readonly awsRegion?: string;
  readonly awsProfile?: string;
  readonly bedrockModelOverrideHaiku?: string;
  readonly bedrockModelOverrideSonnet?: string;
  readonly bedrockModelOverrideOpus?: string;
}

function readClaudeCodeProviderOptions(input: ClaudeCodeStartSessionInput): ClaudeCodeProviderOptions {
  const options = input.providerOptions?.claudeCode;
  if (!options) return {};
  return {
    ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
    ...(options.useBedrock !== undefined ? { useBedrock: options.useBedrock } : {}),
    ...(options.awsRegion ? { awsRegion: options.awsRegion } : {}),
    ...(options.awsProfile ? { awsProfile: options.awsProfile } : {}),
    ...(options.bedrockModelOverrideHaiku ? { bedrockModelOverrideHaiku: options.bedrockModelOverrideHaiku } : {}),
    ...(options.bedrockModelOverrideSonnet ? { bedrockModelOverrideSonnet: options.bedrockModelOverrideSonnet } : {}),
    ...(options.bedrockModelOverrideOpus ? { bedrockModelOverrideOpus: options.bedrockModelOverrideOpus } : {}),
  };
}

/**
 * Resolve the Bedrock ARN for the selected model slug.
 * Falls back to the sonnet ARN, then opus ARN, then the raw slug.
 */
function resolveBedrockModelArn(
  modelSlug: string | undefined,
  opts: ClaudeCodeProviderOptions,
): string | undefined {
  if (!modelSlug) return opts.bedrockModelOverrideSonnet ?? opts.bedrockModelOverrideOpus;
  const slug = modelSlug.toLowerCase();
  if (slug.includes("haiku") && opts.bedrockModelOverrideHaiku) return opts.bedrockModelOverrideHaiku;
  if (slug.includes("opus") && opts.bedrockModelOverrideOpus) return opts.bedrockModelOverrideOpus;
  if (opts.bedrockModelOverrideSonnet) return opts.bedrockModelOverrideSonnet;
  if (opts.bedrockModelOverrideOpus) return opts.bedrockModelOverrideOpus;
  return undefined;
}

function readResumeCursorSessionId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) return undefined;
  const raw = (resumeCursor as Record<string, unknown>).sessionId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function mapRuntimeModeToPermissionMode(runtimeMode: RuntimeMode): string {
  return runtimeMode === "full-access" ? "bypassPermissions" : "default";
}

export class ClaudeCodeAppServerManager extends EventEmitter<ClaudeCodeAppServerManagerEvents> {
  private readonly sessions = new Map<ThreadId, ClaudeCodeSessionContext>();
  private readonly runPromise: (effect: Effect.Effect<unknown, never>) => Promise<unknown>;
  /** Tracks the last session-exit time per thread to prevent rapid restart loops. */
  private readonly lastExitByThread = new Map<ThreadId, number>();
  /** Minimum interval between session exits and restarts for the same thread (ms). */
  private static readonly SESSION_RESTART_COOLDOWN_MS = 5_000;

  constructor(services?: ServiceMap.ServiceMap<never>) {
    super();
    this.runPromise = services ? Effect.runPromiseWith(services) : Effect.runPromise;
  }

  assertSupportedClaudeCodeCliVersion(input: { binaryPath: string; cwd: string }): void {
    const result = spawnSync(input.binaryPath, ["--version"], {
      cwd: input.cwd,
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CLAUDE_CODE_VERSION_CHECK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    if (result.error) {
      const lower = result.error.message.toLowerCase();
      if (lower.includes("enoent") || lower.includes("command not found") || lower.includes("not found")) {
        throw new Error(`Claude Code CLI (${input.binaryPath}) is not installed or not executable.`);
      }
      throw new Error(`Failed to execute Claude Code CLI version check: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `Command exited with code ${result.status}.`;
      throw new Error(`Claude Code CLI version check failed. ${detail}`);
    }
  }

  async startSession(input: ClaudeCodeStartSessionInput): Promise<ProviderSession> {
    const { threadId } = input;
    const now = new Date().toISOString();
    let context: ClaudeCodeSessionContext | undefined;

    try {
      // Prevent rapid restart loops: if the previous session for this thread
      // exited very recently, reject the start request. This breaks the cycle
      // where an SSO auth flow causes the session to exit before initializing,
      // which triggers recovery, which spawns a new CLI, which opens another
      // SSO browser window.
      const lastExit = this.lastExitByThread.get(threadId);
      if (lastExit !== undefined) {
        const elapsed = Date.now() - lastExit;
        if (elapsed < ClaudeCodeAppServerManager.SESSION_RESTART_COOLDOWN_MS) {
          throw new Error(
            `Claude Code session for this thread exited ${elapsed}ms ago. ` +
            "Waiting before restarting to avoid an authentication loop. Please try again.",
          );
        }
        this.lastExitByThread.delete(threadId);
      }

      // Stop any existing session for this thread before starting a new one,
      // to avoid orphaning child processes.
      if (this.sessions.has(threadId)) {
        this.stopSession(threadId);
      }

      const resolvedCwd = input.cwd ?? process.cwd();
      const opts = readClaudeCodeProviderOptions(input);
      const binaryPath = opts.binaryPath ?? "claude";
      const resumeSessionId = readResumeCursorSessionId(input.resumeCursor);

      this.assertSupportedClaudeCodeCliVersion({ binaryPath, cwd: resolvedCwd });

      const session: ProviderSession = {
        provider: "claudeCode",
        status: "connecting",
        runtimeMode: input.runtimeMode,
        model: input.model,
        cwd: resolvedCwd,
        threadId,
        createdAt: now,
        updatedAt: now,
      };

      const hasSettingsOverrides = Boolean(
        opts.useBedrock ||
        opts.awsRegion ||
        opts.awsProfile ||
        opts.bedrockModelOverrideHaiku ||
        opts.bedrockModelOverrideSonnet ||
        opts.bedrockModelOverrideOpus,
      );
      const resolvedModelArn = resolveBedrockModelArn(input.model, opts);

      const permissionMode = mapRuntimeModeToPermissionMode(input.runtimeMode);
      const args: string[] = [
        "--print",
        "--output-format", "stream-json",
        "--verbose",
        "--input-format", "stream-json",
        "--replay-user-messages",
        "--permission-mode", permissionMode,
        ...(permissionMode === "bypassPermissions"
          ? ["--dangerously-skip-permissions"]
          : []),
        // Skip user MCP servers and plugins to avoid hanging on
        // unreachable servers during init. The embedded session only
        // needs built-in tools.
        "--strict-mcp-config",
        "--disable-slash-commands",
      ];
      if (resolvedModelArn) {
        // Have an explicit ARN from settings — use it
        args.push("--model", resolvedModelArn);
      } else if (input.model) {
        // Pass the model slug through. For non-Bedrock this is the plain
        // slug (e.g. "claude-sonnet-4-6"). For Bedrock without explicit ARN
        // overrides, the Claude Code CLI will resolve the slug to the
        // appropriate Bedrock model.
        args.push("--model", input.model);
      }
      if (resumeSessionId) {
        args.push("--resume", resumeSessionId);
      }

      // Build the environment. Always start from the shell environment so
      // that AWS_REGION, AWS_PROFILE, ANTHROPIC_* and other vars the user
      // has configured in their shell are inherited. Only override specific
      // vars when the user has explicitly provided values in the app settings.
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (hasSettingsOverrides) {
        env.CLAUDE_CODE_USE_BEDROCK = "1";
        if (opts.awsRegion) {
          env.AWS_REGION = opts.awsRegion;
          env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION = opts.awsRegion;
        }
        if (opts.awsProfile) {
          env.AWS_PROFILE = opts.awsProfile;
        }
        if (opts.bedrockModelOverrideHaiku) {
          env.ANTHROPIC_DEFAULT_HAIKU_MODEL = opts.bedrockModelOverrideHaiku;
        }
        if (opts.bedrockModelOverrideSonnet) {
          env.ANTHROPIC_DEFAULT_SONNET_MODEL = opts.bedrockModelOverrideSonnet;
        }
        if (opts.bedrockModelOverrideOpus) {
          env.ANTHROPIC_DEFAULT_OPUS_MODEL = opts.bedrockModelOverrideOpus;
        }
        if (resolvedModelArn) {
          env.ANTHROPIC_MODEL = resolvedModelArn;
        }
      }

      const child = spawn(binaryPath, args, {
        cwd: resolvedCwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });

      const output = readline.createInterface({ input: child.stdout });

      let resolveSettled!: () => void;
      const settledPromise = new Promise<void>((resolve) => { resolveSettled = resolve; });

      context = {
        session, child, output, stopping: false, activeTurnId: undefined,
        initialized: false, settledPromise, resolveSettled, settleTimer: undefined,
        settleTimeoutTimer: undefined, settled: false,
      };
      this.sessions.set(threadId, context);

      // Attach event listeners immediately — with --input-format stream-json
      // the init event only arrives after the first message is sent on stdin,
      // so we cannot block on it. Instead we mark ready and let sendTurn
      // drive the interaction. The handleStdoutLine method picks up init,
      // result, assistant, and tool events as they arrive.
      //
      // During the period before `initialized` is set (i.e. before the CLI
      // has emitted its first JSON line), stderr output is emitted as
      // informational notifications rather than errors to prevent SSO/auth
      // messages from triggering session-error recovery loops.
      this.attachProcessListeners(context);

      this.emitLifecycleEvent(context, "session/connecting", "Starting Claude Code session");

      // Start the initial settle timer immediately. If the CLI doesn't emit
      // any stderr (e.g. no SSO needed, or SSO opens browser silently), this
      // fires after STDERR_SETTLE_MS and allows sendTurn to proceed. If
      // stderr lines arrive (SSO auth messages), each one resets this timer
      // so we keep waiting until auth activity quiets down.
      this.resetSettleTimer(context);

      // Hard timeout so the settle wait doesn't hang forever if the user
      // abandons SSO auth.
      const capturedCtx = context;
      context.settleTimeoutTimer = setTimeout(() => {
        if (!capturedCtx.settled) {
          this.markSettled(capturedCtx);
        }
      }, CLAUDE_CODE_SETTLE_TIMEOUT_MS);

      await Effect.logInfo("claude code session starting", {
        threadId,
        requestedRuntimeMode: input.runtimeMode,
        requestedModel: input.model ?? null,
        requestedCwd: resolvedCwd,
        resumeSessionId: resumeSessionId ?? null,
      }).pipe(this.runPromise);

      this.updateSession(context, { status: "ready" });
      this.emitLifecycleEvent(context, "session/ready", "Claude Code session ready");

      return { ...context.session };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start Claude Code session.";
      if (context) {
        this.updateSession(context, { status: "error", lastError: message });
        this.emitErrorEvent(context, "session/startFailed", message);
        this.stopSession(threadId);
      } else {
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "error",
          provider: "claudeCode",
          threadId,
          createdAt: new Date().toISOString(),
          method: "session/startFailed",
          message,
        });
      }
      throw new Error(message, { cause: error });
    }
  }

  async sendTurn(input: ClaudeCodeSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);

    if (!input.input || !input.input.trim()) {
      throw new Error("Turn input must include text.");
    }

    // Wait for the CLI to settle (auth complete) before writing to stdin.
    // This prevents interfering with SSO auth flows that open browser windows.
    if (!context.settled) {
      await context.settledPromise;
    }

    const turnId = TurnId.makeUnsafe(randomUUID());
    context.activeTurnId = turnId;
    this.updateSession(context, { status: "running", activeTurnId: turnId });

    const message = JSON.stringify({
      type: "user",
      message: { role: "user", content: input.input },
    });
    context.child.stdin.write(message + "\n");

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "claudeCode",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "turn/started",
      turnId,
      payload: { turn: { id: turnId } },
    });

    return {
      threadId: context.session.threadId,
      turnId,
    };
  }

  async interruptTurn(threadId: ThreadId): Promise<void> {
    const context = this.sessions.get(threadId);
    if (!context) return;
    // Send SIGINT to interrupt the current turn
    if (!context.child.killed) {
      context.child.kill("SIGINT");
    }
  }

  stopSession(threadId: ThreadId): void {
    const context = this.sessions.get(threadId);
    if (!context) return;

    context.stopping = true;
    this.clearSettleTimers(context);
    if (!context.settled) this.markSettled(context);
    context.output.close();

    if (!context.child.killed) {
      try { context.child.stdin.end(); } catch { /* ignore */ }
      if (process.platform === "win32" && context.child.pid !== undefined) {
        try {
          spawnSync("taskkill", ["/pid", String(context.child.pid), "/T", "/F"], { stdio: "ignore" });
        } catch { context.child.kill(); }
      } else {
        context.child.kill();
      }
    }

    this.updateSession(context, { status: "closed", activeTurnId: undefined });
    this.emitLifecycleEvent(context, "session/closed", "Session stopped");
    this.sessions.delete(threadId);
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values(), ({ session }) => ({ ...session }));
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  stopAll(): void {
    for (const threadId of this.sessions.keys()) {
      this.stopSession(threadId);
    }
  }

  private requireSession(threadId: ThreadId): ClaudeCodeSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) throw new Error(`Unknown session for thread: ${threadId}`);
    if (context.session.status === "closed") throw new Error(`Session is closed for thread: ${threadId}`);
    return context;
  }

  private attachProcessListeners(context: ClaudeCodeSessionContext): void {
    context.output.on("line", (line) => this.handleStdoutLine(context, line));

    context.child.stderr.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split(/\r?\n/g);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (context.initialized) {
          // After the CLI has initialized, treat stderr as errors.
          this.emitErrorEvent(context, "process/stderr", trimmed);
        } else {
          // Before the CLI has emitted its first JSON line on stdout it may
          // still be performing authentication (e.g. AWS SSO). Stderr output
          // during this phase (auth URLs, progress messages) is informational
          // and must NOT be surfaced as errors — otherwise the orchestration
          // layer marks the session as "error" and triggers a restart loop.
          this.emitLifecycleEvent(context, "process/stderr", trimmed);

          // Reset the settle timer: each new stderr line means the CLI is
          // still doing auth/init work. We wait for stderr to go quiet for
          // CLAUDE_CODE_STDERR_SETTLE_MS before writing to stdin.
          if (!context.settled) {
            this.resetSettleTimer(context);
          }
        }
      }
    });

    context.child.on("error", (error) => {
      const message = error.message || "Claude Code process errored.";
      this.updateSession(context, { status: "error", lastError: message });
      this.emitErrorEvent(context, "process/error", message);
    });

    context.child.on("exit", (code, signal) => {
      this.clearSettleTimers(context);
      if (!context.settled) this.markSettled(context);
      if (context.stopping) return;
      const message = `Claude Code exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      this.updateSession(context, {
        status: "closed",
        activeTurnId: undefined,
        lastError: code === 0 ? context.session.lastError : message,
      });
      // Record the exit time so startSession can enforce a cooldown and
      // prevent rapid restart loops (e.g. during SSO authentication).
      this.lastExitByThread.set(context.session.threadId, Date.now());
      this.emitLifecycleEvent(context, "session/exited", message);
      this.sessions.delete(context.session.threadId);
    });
  }

  private handleStdoutLine(context: ClaudeCodeSessionContext, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") return;
    const msg = parsed as Record<string, unknown>;
    const type = msg.type;

    // First valid JSON line means the CLI has finished any auth/init and is
    // actively processing. From this point on stderr is treated as errors.
    if (!context.initialized) {
      context.initialized = true;
    }
    // Stdout arriving means the CLI is definitely past auth — resolve the
    // settle promise immediately so any blocked sendTurn can proceed.
    if (!context.settled) {
      this.markSettled(context);
    }

    if (type === "assistant") {
      const message = msg.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          this.emitEvent({
            id: EventId.makeUnsafe(randomUUID()),
            kind: "notification",
            provider: "claudeCode",
            threadId: context.session.threadId,
            createdAt: new Date().toISOString(),
            method: "item/agentMessage/delta",
            turnId: context.activeTurnId,
            textDelta: b.text,
            payload: { delta: b.text },
          });
        } else if (b.type === "tool_use") {
          this.emitEvent({
            id: EventId.makeUnsafe(randomUUID()),
            kind: "notification",
            provider: "claudeCode",
            threadId: context.session.threadId,
            createdAt: new Date().toISOString(),
            method: "item/tool/started",
            turnId: context.activeTurnId,
            payload: { tool: b },
          });
        }
      }
    } else if (type === "result") {
      const isError = msg.is_error === true;
      const sessionId = typeof msg.session_id === "string" ? msg.session_id : undefined;

      // Update resume cursor with session id
      if (sessionId) {
        this.updateSession(context, {
          status: isError ? "error" : "ready",
          activeTurnId: undefined,
          resumeCursor: { sessionId },
        });
      } else {
        this.updateSession(context, {
          status: isError ? "error" : "ready",
          activeTurnId: undefined,
        });
      }

      this.emitEvent({
        id: EventId.makeUnsafe(randomUUID()),
        kind: "notification",
        provider: "claudeCode",
        threadId: context.session.threadId,
        createdAt: new Date().toISOString(),
        method: "turn/completed",
        turnId: context.activeTurnId,
        payload: {
          turn: {
            id: context.activeTurnId,
            status: isError ? "failed" : "completed",
            ...(isError ? { error: { message: String(msg.result ?? "Unknown error") } } : {}),
          },
        },
      });
      context.activeTurnId = undefined;
    } else if (type === "system" && msg.subtype === "init") {
      // Session initialized, store session id for resume
      const sessionId = typeof msg.session_id === "string" ? msg.session_id : undefined;
      if (sessionId) {
        this.updateSession(context, { resumeCursor: { sessionId } });
      }
    } else if (type === "system" && msg.subtype === "api_retry") {
      // The CLI is retrying an API call. If the error is authentication_failed,
      // stop the session immediately rather than letting the CLI retry 10 times
      // (which can open repeated SSO browser windows for Bedrock).
      const error = typeof msg.error === "string" ? msg.error : "";
      const attempt = typeof msg.attempt === "number" ? msg.attempt : 0;
      if (error === "authentication_failed" && attempt >= 2) {
        const errorMsg = `Bedrock authentication failed after ${attempt} attempts. Check your AWS region, profile, and model ARN settings.`;
        this.updateSession(context, { status: "error", lastError: errorMsg });
        this.emitErrorEvent(context, "session/authFailed", errorMsg);
        this.stopSession(context.session.threadId);
      }
    }
  }

  private updateSession(
    context: ClaudeCodeSessionContext,
    patch: Partial<ProviderSession & { resumeCursor?: unknown }>,
  ): void {
    const { resumeCursor, ...sessionPatch } = patch as Record<string, unknown>;
    Object.assign(context.session, { ...sessionPatch, updatedAt: new Date().toISOString() });
    if (resumeCursor !== undefined) {
      context.session = { ...context.session, resumeCursor };
    }
  }

  /** (Re)start the "settle" debounce timer — stderr went quiet → CLI is past auth. */
  private resetSettleTimer(context: ClaudeCodeSessionContext): void {
    if (context.settleTimer) clearTimeout(context.settleTimer);
    context.settleTimer = setTimeout(() => {
      if (!context.settled) {
        this.markSettled(context);
      }
    }, CLAUDE_CODE_STDERR_SETTLE_MS);
  }

  /** Mark the session as settled so sendTurn can proceed. */
  private markSettled(context: ClaudeCodeSessionContext): void {
    context.settled = true;
    this.clearSettleTimers(context);
    context.resolveSettled();
  }

  private clearSettleTimers(context: ClaudeCodeSessionContext): void {
    if (context.settleTimer) { clearTimeout(context.settleTimer); context.settleTimer = undefined; }
    if (context.settleTimeoutTimer) { clearTimeout(context.settleTimeoutTimer); context.settleTimeoutTimer = undefined; }
  }

  private emitLifecycleEvent(context: ClaudeCodeSessionContext, method: string, summary: string): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "claudeCode",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message: summary,
    });
  }

  private emitErrorEvent(context: ClaudeCodeSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "error",
      provider: "claudeCode",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitEvent(event: ProviderEvent): void {
    this.emit("event", event);
  }
}
