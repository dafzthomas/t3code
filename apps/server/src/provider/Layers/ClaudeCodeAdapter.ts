import {
  type ProviderEvent,
  type ProviderRuntimeEvent,
  ProviderItemId,
  RuntimeItemId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, ServiceMap, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterShape } from "../Services/ClaudeCodeAdapter.ts";
import {
  ClaudeCodeAppServerManager,
  type ClaudeCodeStartSessionInput,
} from "../../claudeCodeAppServerManager.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "claudeCode" as const;

export interface ClaudeCodeAdapterLiveOptions {
  readonly manager?: ClaudeCodeAppServerManager;
  readonly makeManager?: (services?: ServiceMap.ServiceMap<never>) => ClaudeCodeAppServerManager;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toSessionError(
  threadId: import("@t3tools/contracts").ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session")) {
    return new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId, cause });
  }
  if (normalized.includes("session is closed")) {
    return new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId, cause });
  }
  return undefined;
}

function toRequestError(
  threadId: import("@t3tools/contracts").ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) return sessionError;
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRuntimeItemId(itemId: ProviderItemId): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(itemId);
}

function providerRefsFromEvent(event: ProviderEvent): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;
  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: import("@t3tools/contracts").ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: "claude-code.notification" as const,
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: import("@t3tools/contracts").ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);

  if (event.kind === "error") {
    if (!event.message) return [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: event.message,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: { state: "starting", ...(event.message ? { reason: event.message } : {}) },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: { state: "ready", ...(event.message ? { reason: event.message } : {}) },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) return [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {},
      },
    ];
  }

  if (event.method === "turn/completed") {
    const turn = asObject(payload?.turn);
    const isError = asObject(turn?.error) !== undefined;
    const errorMessage = asString(asObject(turn?.error)?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: isError ? "failed" : "completed",
          ...(errorMessage ? { errorMessage } : {}),
        },
      },
    ];
  }

  if (event.method === "item/agentMessage/delta") {
    const delta = event.textDelta ?? asString(payload?.delta);
    if (!delta || delta.length === 0) return [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "assistant_text" as const,
          delta,
        },
      },
    ];
  }

  if (event.method === "item/tool/started") {
    const tool = asObject(payload?.tool);
    const toolName = asString(tool?.name) ?? "tool";
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.started",
        payload: {
          itemType: "dynamic_tool_call" as const,
          status: "inProgress" as const,
          title: toolName,
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  return [];
}

const makeClaudeCodeAdapter = (options?: ClaudeCodeAdapterLiveOptions) =>
  Effect.gen(function* () {
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);

    const manager = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        if (options?.manager) return options.manager;
        const services = yield* Effect.services<never>();
        return options?.makeManager?.(services) ?? new ClaudeCodeAppServerManager(services);
      }),
      (m) =>
        Effect.sync(() => {
          try { m.stopAll(); } catch { /* ignore */ }
        }),
    );

    const startSession: ClaudeCodeAdapterShape["startSession"] = (input) => {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      const managerInput: ClaudeCodeStartSessionInput = {
        threadId: input.threadId,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
        runtimeMode: input.runtimeMode,
        ...(input.model !== undefined ? { model: input.model } : {}),
      };

      return Effect.tryPromise({
        try: () => manager.startSession(managerInput),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start Claude Code session."),
            cause,
          }),
      });
    };

    const sendTurn: ClaudeCodeAdapterShape["sendTurn"] = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.sendTurn({
            threadId: input.threadId,
            ...(input.input !== undefined ? { input: input.input } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
          }),
        catch: (cause) => toRequestError(input.threadId, "turn/start", cause),
      }).pipe(Effect.map((result) => ({ ...result, threadId: input.threadId })));

    const interruptTurn: ClaudeCodeAdapterShape["interruptTurn"] = (threadId) =>
      Effect.tryPromise({
        try: () => manager.interruptTurn(threadId),
        catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
      });

    const readThread: ClaudeCodeAdapterShape["readThread"] = (threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/read",
          detail: "readThread is not supported for Claude Code.",
          cause: undefined,
        }),
      );

    const rollbackThread: ClaudeCodeAdapterShape["rollbackThread"] = (threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "rollbackThread is not supported for Claude Code.",
          cause: undefined,
        }),
      );

    const respondToRequest: ClaudeCodeAdapterShape["respondToRequest"] = (threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "item/requestApproval/decision",
          detail: "respondToRequest is not supported for Claude Code.",
          cause: undefined,
        }),
      );

    const respondToUserInput: ClaudeCodeAdapterShape["respondToUserInput"] = (threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "item/tool/requestUserInput",
          detail: "respondToUserInput is not supported for Claude Code.",
          cause: undefined,
        }),
      );

    const stopSession: ClaudeCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.sync(() => { manager.stopSession(threadId); });

    const listSessions: ClaudeCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => manager.listSessions());

    const hasSession: ClaudeCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => manager.hasSession(threadId));

    const stopAll: ClaudeCodeAdapterShape["stopAll"] = () =>
      Effect.sync(() => { manager.stopAll(); });

    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const services = yield* Effect.services<never>();
        const listener = (event: ProviderEvent) =>
          Effect.gen(function* () {
            if (nativeEventLogger) {
              yield* nativeEventLogger.write(event, event.threadId);
            }
            const runtimeEvents = mapToRuntimeEvents(event, event.threadId);
            if (runtimeEvents.length === 0) {
              yield* Effect.logDebug("ignoring unhandled Claude Code provider event", {
                method: event.method,
                threadId: event.threadId,
              });
              return;
            }
            yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
          }).pipe(Effect.runPromiseWith(services));
        manager.on("event", listener);
        return listener;
      }),
      (listener) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => { manager.off("event", listener); });
          yield* Queue.shutdown(runtimeEventQueue);
        }),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "restart-session" as const },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies ClaudeCodeAdapterShape;
  });

export const ClaudeCodeAdapterLive = Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter());

export function makeClaudeCodeAdapterLive(options?: ClaudeCodeAdapterLiveOptions) {
  return Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter(options));
}
