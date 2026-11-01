# cf-cliproxy

cliproxy running full time free on cf

A Workers-only fork of [PlaygrndLabs/sub2api](https://github.com/PlaygrndLabs/sub2api), with Antigravity Gemini support adapted from [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). It serves the official CLIProxyAPI management client at `/management.html` and OpenAI-compatible inference at `/v1`.

The endpoint is available on demand around the clock. It does not keep a server running while idle, and free-tier quotas apply. No container, paid Workers plan upgrade, R2 bucket, or D1 database is required.

## State and access

One SQLite-backed Durable Object stores configuration, inference keys, provider auth files, OAuth sessions, refreshed tokens, cooldowns, and bounded usage records. Worker restarts and ordinary deployments preserve this state. The object also coalesces concurrent token refreshes. Deleting its namespace or changing its identity loses access to that saved state; preserve the `Store` class, migration history and `main` object name.

`MANAGEMENT_KEY` is a Worker secret. The official manager prompts for it, and every management API request must present it. There is no additional dashboard password. The HTML application is public, while configuration and provider credentials require the management key. Inference uses a separate API key stored in the protected configuration. Keep both credentials out of Git, command arguments and logs.

## Antigravity

Import a CLIProxyAPI Antigravity JSON auth file through **Auth files**, or use **OAuth login → Antigravity**. The login follows Google's registered localhost callback; paste the complete callback address into the manager. Google account/project onboarding must already be complete, or import an existing working auth file.

The Worker refreshes Google access tokens in the Durable Object, retains the refresh token when Google does not replace it, and stores the provider project ID. Inference uses the Antigravity Cloud Code `v1internal` envelope, with streamed responses unwrapped incrementally. Gemini text, inline images, tools, thinking configuration, and OpenAI JSON output schemas pass through the existing protocol translators.

The advertised Antigravity models are `gemini-3.5-flash-lite` and `gemini-3.8-flash-high`. Claude models through Antigravity are not advertised: their signature replay path has not been ported or verified. Existing Claude, ChatGPT/Codex and Kimi OAuth and API-key providers remain available. Workers Free has a 10 ms CPU limit, so large translated conversations/PDF image payloads may exceed the budget. This independent endpoint does not change AllPYQ's Azure primary or laptop backup.

The reference implementation is CLIProxyAPI's `internal/auth/antigravity/`, `internal/runtime/executor/antigravity_executor_request.go`, and Gemini/OpenAI translators. The OAuth desktop client secret is supplied as `ANTIGRAVITY_CLIENT_SECRET`, outside source. Provider error bodies from token exchanges are not logged or returned.

## Operations

Install the pinned dependencies with `npm ci --ignore-scripts`. Existing checks are `npm run typecheck`, `npm run lint`, and `npm test`. Discover the tracked operator with `pnpm ops help` (or `npm run ops -- help`). It uses the existing cf CLI OAuth session or `CLOUDFLARE_API_TOKEN` without printing the token.

```sh
pnpm ops doctor --prod
pnpm ops deploy --prod
pnpm ops deploy --prod --apply
pnpm ops secrets --prod < /private/setup.json
pnpm ops secrets --prod --apply < /private/setup.json
pnpm ops configure --prod < /private/setup.json
pnpm ops configure --prod --apply < /private/setup.json
pnpm ops status --prod < /private/setup.json
pnpm ops probe --prod < /private/setup.json
```

The protected JSON file contains `secrets` (`MANAGEMENT_KEY`, `ANTIGRAVITY_CLIENT_SECRET`), `apiKey`, `managementKey`, and optional `authFiles` entries with `name` and parsed `data`. It must be mode 0600 and remain outside the repository. Configuration imports replace this gateway's inference-key list with the selected shared key and upload only the listed auth files. `status` emits hashes/counts/model names, not credentials. A probe sends one fixed small inference request; optional `imageDataUrl` must show the fixture digits 47.

The tracked production configuration targets `infer-cf.allpyq.in` on Noel's account. Change those target identifiers before deploying a different installation. Deployment previews bundle locally without changing Cloudflare. Deployment uses a pinned official management-client release and prints its SHA-256. Read `plan/infer-cf/receipt.json` for actual deployment and test evidence, when present. GitHub Actions checks every push; deployment is manual and requires repository credentials.
