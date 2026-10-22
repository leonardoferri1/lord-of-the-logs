# Lord of the Logs — delivery plan

## Scope and assumptions

An original, Portuguese-language isometric browser settlement game. The supplied reference informs the forest palette, timber buildings and compact HUD, not copyrighted assets. The MVP ends at gathering and persistent construction; combat, quests and clans are future work. One authoritative process owns one seeded world. Anonymous identities are kept per browser tab so two tabs can demonstrate multiplayer; refresh/reconnect preserves identity, closing the tab loses the local credential.

## Milestones / meaningful commits

1. Foundation: pnpm monorepo, shared deterministic terrain, A*, contracts and domain tests.
2. Server: NestJS, PostgreSQL/Prisma persistence, bearer sessions, authoritative ticks, atomic gathering/building, Redis presence, integration tests.
3. Client: React/Phaser original procedural art, onboarding, movement, camera, minimap, contextual gathering, placement preview and responsive HUD.
4. Delivery: Docker Compose, CI, security/architecture/setup documentation, verified checks and GitHub publication.

## Architecture

Shared package owns geometry, terrain, collision, recipes and wire schemas. The Nest gateway authenticates/validates/rate-limits intentions. A simulation service owns paths and timed gathering. A persistence service commits economic actions under a PostgreSQL advisory transaction lock, retaining idempotency receipts and events. The browser interpolates snapshots independently of React. Redis stores expiring presence only; PostgreSQL is the source of truth.

## Risks and verification

- Concurrent gathering/placement: real PostgreSQL integration tests, resource constraints and unique occupied cells.
- Disconnect/restart: snapshot resynchronization, periodic position checkpoints and durable economic commits.
- Visual quality: procedural sprites, depth sorting, responsive panels and browser QA.
- Abuse: unguessable hashed session tokens, strict schemas, bounded paths, per-session socket and per-IP entry limits.
- Single-process simulation: no horizontal scaling claims. Public hosting requires TLS/reverse proxy and persistent database volumes.
- Docker CLI exists; engine initially stopped. Start and verify before integration testing.

## Status

Implementation in progress. See README for final verified commands and known limitations.
