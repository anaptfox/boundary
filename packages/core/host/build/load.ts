import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { snapshotDefinitions } from "../definition-snapshot";
import { failHost } from "../errors";
import type {
  LoadInteractionsEntryOptions,
  LoadedInteractions,
} from "./types";
import type { InteractionDefinitions } from "../types";

function entryUrl(entry: string | URL): URL {
  let url: URL;
  if (entry instanceof URL) {
    url = new URL(entry.href);
  } else if (typeof entry === "string" && entry.length > 0) {
    try {
      url = new URL(entry);
    } catch {
      url = pathToFileURL(resolve(entry));
    }
  } else {
    return failHost(
      "INVALID_INTERACTION_MODULE",
      "entry",
      "an explicit interaction module path or file URL is required",
    );
  }
  if (url.protocol !== "file:") {
    return failHost(
      "INVALID_INTERACTION_MODULE",
      "entry",
      "interaction module entries must be local file URLs",
    );
  }
  return url;
}

function exportedInteractions(module: unknown): unknown {
  if (module === null || typeof module !== "object") {
    return failHost(
      "INVALID_INTERACTION_MODULE",
      "module",
      "interaction loader must return a module namespace object",
    );
  }
  const property = Object.getOwnPropertyDescriptor(module, "interactions");
  if (!property || !("value" in property) || !property.enumerable) {
    return failHost(
      "INVALID_INTERACTION_MODULE",
      "module.interactions",
      "interaction module must export one named interactions data property",
    );
  }
  const value = property.value;
  if (
    typeof value === "function" ||
    (value !== null &&
      typeof value === "object" &&
      typeof (value as { then?: unknown }).then === "function")
  ) {
    return failHost(
      "INVALID_INTERACTION_MODULE",
      "module.interactions",
      "interactions must be a closed record, not a factory or Promise",
    );
  }
  return value;
}

export async function loadInteractionsEntry<
  Definitions extends InteractionDefinitions = InteractionDefinitions,
>(
  options: LoadInteractionsEntryOptions,
): Promise<LoadedInteractions<Definitions>> {
  if (options === null || typeof options !== "object") {
    return failHost(
      "INVALID_INTERACTION_MODULE",
      "options",
      "loadInteractionsEntry options are required",
    );
  }
  const url = entryUrl(options.entry);
  let module: unknown;
  try {
    module = options.loadModule
      ? await options.loadModule(url)
      : await import(/* @vite-ignore */ url.href);
  } catch (cause) {
    return failHost(
      "INVALID_INTERACTION_MODULE",
      "module",
      "interaction module evaluation failed",
      cause,
    );
  }
  const interactions = snapshotDefinitions(
    exportedInteractions(module),
    "module.interactions",
  );
  return Object.freeze({ interactions }) as LoadedInteractions<Definitions>;
}
