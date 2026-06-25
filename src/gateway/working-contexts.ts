import { readdirSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import type { WorkingContextRecord, WorkingContextStore } from "@/db/working-contexts.js";

export type WorkingContextResolverOptions = {
  allowedRoots?: readonly string[];
  allowUnconfiguredLocalPaths?: boolean;
  store: WorkingContextStore;
};

export type WorkingContextCandidate = {
  label: string;
  path: string;
};

export class WorkingContextResolver {
  readonly #allowedRoots: string[];
  readonly #allowUnconfiguredLocalPaths: boolean;
  readonly #store: WorkingContextStore;

  constructor(options: WorkingContextResolverOptions) {
    this.#allowedRoots = (options.allowedRoots ?? []).map((root) => resolve(root));
    this.#allowUnconfiguredLocalPaths = options.allowUnconfiguredLocalPaths ?? false;
    this.#store = options.store;
  }

  discover(input: { scanAllowedRoots?: boolean } = {}): {
    allowedRoots: string[];
    candidates: WorkingContextCandidate[];
    recent: WorkingContextRecord[];
  } {
    return {
      allowedRoots: this.#allowedRoots,
      candidates: input.scanAllowedRoots ? this.#scanAllowedRoots() : [],
      recent: this.#store.listRecent(),
    };
  }

  resolve(input: { label?: string; path?: string; slug?: string }): WorkingContextRecord {
    if (input.slug) {
      const existing = this.#store.findBySlug(input.slug);
      if (existing) {
        return existing;
      }
    }

    if (!input.path) {
      throw new Error("path is required when working context slug is unknown");
    }

    const path = resolve(input.path);
    this.#assertAllowed(path);
    return this.#store.upsert({
      label: input.label ?? basename(path),
      path,
      ...(input.slug ? { slug: input.slug } : {}),
    });
  }

  #assertAllowed(path: string): void {
    if (this.#allowedRoots.length === 0) {
      if (this.#allowUnconfiguredLocalPaths) {
        return;
      }
      throw new Error("No working context allowed roots are configured");
    }

    if (!this.#allowedRoots.some((root) => isInsideOrEqual(root, path))) {
      throw new Error(`Working context path is outside allowed roots: ${path}`);
    }
  }

  #scanAllowedRoots(): WorkingContextCandidate[] {
    return this.#allowedRoots.flatMap((root) => {
      try {
        return readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => resolve(root, entry.name))
          .filter((path) => statSync(path).isDirectory())
          .map((path) => ({ label: basename(path), path }));
      } catch {
        return [];
      }
    });
  }
}

function isInsideOrEqual(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith("/"));
}
