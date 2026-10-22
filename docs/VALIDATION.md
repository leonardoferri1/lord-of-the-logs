# Validation record

## World v2 — 2026-10-22

- Shared `pnpm lint`, `pnpm test` (11 domain tests) and `pnpm build`, with `dist` rebuilt.
- Server `pnpm lint`, `pnpm build` and `pnpm test`: 7 integration tests against PostgreSQL 17 (Docker), including a networked goblin fight with loot, chat relay and control-character rejection, idempotent loot, quest claiming, villager-range trading and forging.
- Web `pnpm lint`, `tsc --noEmit` and `vite build`.
- The v1 → v2 world migration ran against the existing development database: the only structure (a house on the new inn's cells) was removed, its cost refunded, every player moved to the new spawn, 346 resource nodes reseeded and one `migration` event recorded.
- Browser QA (desktop, 1366 × 820): entry, auto-gathering until depletion, floating loot text, quest claim and level-up, goblin aggro, death and respawn with the gold penalty, construction preview over blocked ground, world map, blacksmith dialog after walking to him, dusk and night lighting. QA found and drove two fixes: stale Phaser canvas bounds broke click mapping after layout shifts (now refreshed on resize and pointer entry), and idle players did not defend themselves (now they retaliate; camp damage was also softened).

Not verified in this pass: the Docker Compose full stack (`docker compose up --build`), which builds the web client from a pinned remote commit, and mobile layouts beyond the CSS breakpoints.

## MVP — 2026-10-22

### Automated

- `pnpm lint`: ESLint + TypeScript rules.
- Shared repository `pnpm test`: 6 deterministic domain tests.
- Each repository `pnpm build`: shared declarations, NestJS TypeScript build and Vite production bundle, independently.
- Server repository `pnpm test` / `pnpm test:integration`: 5 tests against real PostgreSQL 17, with independent Socket.IO clients and a restarted Node process.
- `docker compose build` and `docker compose up -d`: all four services started; PostgreSQL, Redis and the server passed their health checks. The Nginx-proxied `/api/health` returned `ok` at port 8080.

The multiplayer test gathers its construction resources through timed socket actions; it does not fake the gameplay inventory. Dedicated concurrency tests seed controlled inventories to isolate atomicity and race conditions. Each run uses its own temporary database schema.

One initial integration failure exposed a readiness race: a fresh process accepted clients before loading its world cache. Initialization now loads the world before listening. The restart test passed after that correction.

### Browser

The local application was opened in the browser to inspect the original procedural scene, entry form, HUD and selection controls. Two independent browser tabs joined as Leonardo and Lyria. Clicking resources moved the character to an adjacent cell; three wood collections and one stone collection funded a house. The interface deducted 12 wood and 4 stone and both tabs displayed the new building. Refresh restored the session, and replacing the running server container reconnected the client successfully.

Screenshots in `docs/screenshots` show the actual application, not design mockups. Unit and network integration tests do not establish mobile usability, assistive-technology coverage or production capacity. No load-test or cross-browser certification is claimed.

### Build characteristics

The Phaser vendor chunk is approximately 1.5 MB before compression (about 340 KB gzip). Vite reports its standard large-chunk warning; the engine is intentionally separate from the application bundle. Future optimization should measure initial load and reduce/bundle engine features where practical.
