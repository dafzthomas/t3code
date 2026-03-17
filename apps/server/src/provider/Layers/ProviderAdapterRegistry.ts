/**
 * ProviderAdapterRegistryLive - In-memory provider adapter lookup layer.
 *
 * Binds provider kinds (codex/cursor/...) to concrete adapter services.
 * This layer only performs adapter lookup; it does not route session-scoped
 * calls or own provider lifecycle workflows.
 *
 * @module ProviderAdapterRegistryLive
 */
import { Effect, Layer } from "effect";

import { ProviderUnsupportedError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "../Services/ProviderAdapterRegistry.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";
import { ClaudeCodeAdapter } from "../Services/ClaudeCodeAdapter.ts";

export interface ProviderAdapterRegistryLiveOptions {
  readonly adapters?: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>;
}

function buildRegistry(adapters: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>) {
  const byProvider = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  const getByProvider: ProviderAdapterRegistryShape["getByProvider"] = (provider) => {
    const adapter = byProvider.get(provider);
    if (!adapter) return Effect.fail(new ProviderUnsupportedError({ provider }));
    return Effect.succeed(adapter);
  };
  const listProviders: ProviderAdapterRegistryShape["listProviders"] = () =>
    Effect.sync(() => Array.from(byProvider.keys()));
  return { getByProvider, listProviders } satisfies ProviderAdapterRegistryShape;
}

const makeProviderAdapterRegistryDefault = Effect.gen(function* () {
  const codex = yield* CodexAdapter;
  const claudeCode = yield* ClaudeCodeAdapter;
  return buildRegistry([codex, claudeCode]);
});

export const ProviderAdapterRegistryLive = Layer.effect(
  ProviderAdapterRegistry,
  makeProviderAdapterRegistryDefault,
);

export function makeProviderAdapterRegistryLive(
  options: Required<ProviderAdapterRegistryLiveOptions>,
): Layer.Layer<ProviderAdapterRegistry> {
  const { adapters } = options;
  return Layer.effect(
    ProviderAdapterRegistry,
    Effect.sync(() => buildRegistry(adapters)),
  );
}
