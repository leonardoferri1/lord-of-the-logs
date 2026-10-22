import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { Store } from '../src/store';
import {
  blockers,
  distance,
  findPath,
  gatheringError,
  initialNodes,
  type Snapshot,
  type Point,
  type ResourceNode,
} from '@logs/shared';

const baseUrl = process.env.DATABASE_URL || 'postgresql://logs:logs_local@localhost:55432/logs';
const schema = `test_${Date.now()}`;
const url = new URL(baseUrl);
url.searchParams.set('schema', schema);
const admin = new Store({ datasourceUrl: baseUrl });
const store = new Store({ datasourceUrl: url.toString() });
const address = 'http://localhost:3101';
let server: ChildProcess;
let output = '';
const sockets: Socket[] = [];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, timeout = 12000) {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > timeout)
      throw new Error(`Timed out. Server output: ${output.slice(-3000)}`);
    await pause(50);
  }
}
async function startServer() {
  server = spawn(process.execPath, [resolve('dist/main.js')], {
    env: {
      ...process.env,
      DATABASE_URL: url.toString(),
      PORT: '3101',
      REDIS_URL: '',
      CLIENT_ORIGIN: 'http://localhost:5173',
    },
    stdio: 'pipe',
  });
  server.stdout?.on('data', (b) => {
    output += String(b);
  });
  server.stderr?.on('data', (b) => {
    output += String(b);
  });
  await until(async () => {
    try {
      return (await fetch(`${address}/api/health`)).ok;
    } catch {
      return false;
    }
  });
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    server.once('exit', () => resolve());
    server.kill('SIGTERM');
  });
}
async function client(token?: string, name = 'Test Peasant') {
  if (!token) {
    const response = await fetch(`${address}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const session = (await response.json()) as { token: string };
    token = session.token;
  }
  const socket = io(address, { auth: { token }, transports: ['websocket'], reconnection: false });
  sockets.push(socket);
  const state: { snapshot?: Snapshot } = {};
  socket.on('snapshot', (s) => {
    state.snapshot = s;
  });
  await until(() => !!state.snapshot);
  return { socket, token, state };
}
beforeAll(async () => {
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const sql = readFileSync(resolve('prisma/migrations/202610220001_initial/migration.sql'), 'utf8');
  for (const statement of sql.split(';').filter((s) => s.trim()))
    await store.$executeRawUnsafe(statement);
  await store.onModuleInit();
  await startServer();
});
afterAll(async () => {
  sockets.forEach((s) => s.disconnect());
  await stopServer();
  await store.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.$disconnect();
});

describe.sequential('PostgreSQL authority and multiplayer', () => {
  it('rejects forged identities and malformed movement', async () => {
    const bad = io(address, {
      auth: { token: 'forged-player-id' },
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(bad);
    let rejected = false;
    bad.on('result', (r) => {
      if (!r.ok) rejected = true;
    });
    await until(() => rejected);
    const c = await client();
    const before = c.state.snapshot!.players.find((p) => p.id === c.state.snapshot!.selfId)!;
    let invalid = false;
    c.socket.on('result', (r) => {
      if (!r.ok) invalid = true;
    });
    c.socket.emit('move', { x: 999, y: -12 });
    await until(() => invalid);
    expect(c.state.snapshot!.players.find((p) => p.id === before.id)).toMatchObject({
      x: before.x,
      y: before.y,
    });
    c.socket.disconnect();
  });
  it('completes real movement, timed gathering, shared construction, reconnect and server restart', async () => {
    const a = await client(undefined, 'Ada Lumber'),
      b = await client(undefined, 'Beto Stone');
    await until(
      () =>
        a.state.snapshot!.players.length >= 2 &&
        b.state.snapshot!.players.some((p) => p.id === a.state.snapshot!.selfId),
    );
    const self = () => a.state.snapshot!.players.find((p) => p.id === a.state.snapshot!.selfId)!;
    const go = async (p: Point) => {
      if (distance(self(), p) === 0) return;
      a.socket.emit('move', p);
      await until(() => distance(self(), p) === 0, 20000);
    };
    const nearest = (kind: 'wood' | 'stone') => {
      const occupied = blockers(a.state.snapshot!.nodes, a.state.snapshot!.buildings);
      return a.state
        .snapshot!.nodes.filter((n) => n.kind === kind && n.quantity >= 12)
        .flatMap((node) =>
          [
            { x: node.x + 1, y: node.y },
            { x: node.x - 1, y: node.y },
            { x: node.x, y: node.y + 1 },
            { x: node.x, y: node.y - 1 },
          ].map((p) => ({ node, p, path: findPath(self(), p, occupied) })),
        )
        .filter((c) => c.path.length)
        .sort((x, y) => x.path.length - y.path.length)[0];
    };
    for (const kind of ['wood', 'stone'] as const) {
      const target = nearest(kind);
      expect(target).toBeTruthy();
      await go(target.p);
      await until(() =>
        b.state.snapshot!.players.some((p) => p.id === self().id && distance(p, target.p) === 0),
      );
      const repeats = kind === 'wood' ? 3 : 1;
      for (let i = 0; i < repeats; i++) {
        const before = a.state.snapshot!.inventory[kind],
          actionId = crypto.randomUUID();
        a.socket.emit('gather', { nodeId: target.node.id, actionId });
        await until(() => !!self().gathering);
        expect(a.state.snapshot!.inventory[kind]).toBe(before);
        await until(() => a.state.snapshot!.inventory[kind] === before + 4 && !self().gathering);
        a.socket.emit('gather', { nodeId: target.node.id, actionId });
        await pause(200);
        expect(a.state.snapshot!.inventory[kind]).toBe(before + 4);
      }
    }
    await go({ x: 19, y: 20 });
    const actionId = crypto.randomUUID();
    a.socket.emit('build', { x: 20, y: 20, kind: 'house', actionId });
    await until(() => a.state.snapshot!.buildings.some((b) => b.ownerId === self().id));
    const house = a.state.snapshot!.buildings.find((b) => b.ownerId === self().id)!;
    await until(() => b.state.snapshot!.buildings.some((b) => b.id === house.id));
    expect(a.state.snapshot!.inventory).toEqual({ wood: 0, stone: 0 });
    a.socket.emit('build', { x: 20, y: 20, kind: 'house', actionId });
    await pause(250);
    expect(await store.building.count({ where: { ownerId: house.ownerId } })).toBe(1);
    a.socket.disconnect();
    const restored = await client(a.token);
    expect(restored.state.snapshot!.selfId).toBe(house.ownerId);
    expect(restored.state.snapshot!.buildings).toContainEqual(house);
    restored.socket.disconnect();
    b.socket.disconnect();
    await pause(150);
    await stopServer();
    await startServer();
    const restartedA = await client(a.token),
      restartedB = await client(b.token);
    expect(restartedA.state.snapshot!.buildings).toContainEqual(house);
    expect(restartedB.state.snapshot!.buildings).toContainEqual(house);
    expect(restartedA.state.snapshot!.inventory).toEqual({ wood: 0, stone: 0 });
    restartedA.socket.disconnect();
    restartedB.socket.disconnect();
  }, 60000);
  it('serializes competing harvests and deduplicates replayed economic actions', async () => {
    const a = await store.createSession('Concurrent A'),
      b = await store.createSession('Concurrent B');
    const node = initialNodes().find((n) => n.kind === 'wood')!;
    await store.resourceNode.update({ where: { id: node.id }, data: { quantity: 3 } });
    const requests = await Promise.allSettled([
      store.gather(a.player.id, crypto.randomUUID(), node.id, node),
      store.gather(b.player.id, crypto.randomUUID(), node.id, node),
    ]);
    expect(requests.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const players = await store.player.findMany({
      where: { id: { in: [a.player.id, b.player.id] } },
    });
    expect(players.reduce((sum, p) => sum + p.wood, 0)).toBe(3);
    expect((await store.resourceNode.findUniqueOrThrow({ where: { id: node.id } })).quantity).toBe(
      0,
    );
    const second = initialNodes().find((n) => n.kind === 'stone')!;
    const id = crypto.randomUUID();
    await Promise.all([
      store.gather(a.player.id, id, second.id, second),
      store.gather(a.player.id, id, second.id, second),
    ]);
    expect((await store.player.findUniqueOrThrow({ where: { id: a.player.id } })).stone).toBe(4);
  });
  it('allows only one concurrent placement and rolls back rejected costs', async () => {
    const a = await store.createSession('Builder A'),
      b = await store.createSession('Builder B');
    await store.player.updateMany({
      where: { id: { in: [a.player.id, b.player.id] } },
      data: { wood: 12, stone: 4 },
    });
    const request = { x: 15, y: 19, kind: 'house' as const, actionId: crypto.randomUUID() };
    const results = await Promise.allSettled([
      store.build(a.player.id, request, { x: 17, y: 19 }, []),
      store.build(b.player.id, { ...request, actionId: crypto.randomUUID() }, { x: 17, y: 19 }, []),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const players = await store.player.findMany({
      where: { id: { in: [a.player.id, b.player.id] } },
    });
    expect(players.reduce((sum, p) => sum + p.wood, 0)).toBe(12);
    expect(players.reduce((sum, p) => sum + p.stone, 0)).toBe(4);
    expect(
      await store.occupiedCell.count({ where: { x: { in: [15, 16] }, y: { in: [19, 20] } } }),
    ).toBe(4);
  });
  it('regenerates depleted resources and enforces range at commit time', async () => {
    const node = initialNodes()[0];
    await store.resourceNode.update({
      where: { id: node.id },
      data: { quantity: 0, regeneratesAt: new Date(0) },
    });
    await store.regenerate();
    expect((await store.resourceNode.findUniqueOrThrow({ where: { id: node.id } })).quantity).toBe(
      24,
    );
    const player = await store.createSession('Far Away');
    await expect(
      store.gather(player.player.id, crypto.randomUUID(), node.id, { x: 18, y: 18 }),
    ).rejects.toThrow('Aproxime');
    expect(gatheringError({ x: 18, y: 18 }, node as ResourceNode)).toBeTruthy();
  });
});
