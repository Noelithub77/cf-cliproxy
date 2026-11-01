import type { Store } from "./store.ts";

export interface Env {
  readonly STORE: DurableObjectNamespace<Store>;
  readonly ASSETS: Fetcher;
  readonly MANAGEMENT_KEY?: string;
  readonly ANTIGRAVITY_CLIENT_SECRET?: string;
}
