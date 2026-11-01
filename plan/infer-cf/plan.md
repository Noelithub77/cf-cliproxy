# Free Cloudflare proxy

## Decisions [chosen]

Keep Azure infer-vm primary and laptop fallback. Deploy this Workers-only fork at infer-cf.allpyq.in with the existing API and management keys. Retain the SQLite Durable Object to avoid a storage rewrite; no containers, D1 or paid plan changes. Add Antigravity Gemini OAuth import, login, refresh and request translation using CLIProxyAPI as the reference, without new runtime dependencies.

## Work

- Remove container-only files and make the Worker the repository root.
- Add Antigravity authentication, model routing and response handling with tests.
- Deploy, import the existing login privately, verify authentication, text, images and persistence.
- Keep all production routing on the existing primary and fallback.

## Completed verification

196 tests across 17 files, both typechecks and lint passed. Direct Gemini text, vision, structured AllPYQ vision and OpenAI streaming passed on the deployed Worker. Both imported Google logins refreshed. API and management access, models, and keys survived redeployment without reconfiguration. The official manager asset checksum matched. Large PDF load and browser manager interaction were not run. See receipt.json.
