import { Injectable, Inject, OnModuleDestroy, Logger } from '@nestjs/common';
import { Store } from './store';
import { Redis } from 'ioredis';
import {
  blockers,
  findPath,
  gatheringError,
  walkable,
  GATHER_MS,
  STEP_MS,
  TICK_MS,
  WORLD_SEED,
  type Player,
  type Point,
  type Snapshot,
  type BuildRequest,
  type Inventory,
} from '@logs/shared';
import type { Socket } from 'socket.io';

type Agent = Player & {
  socket: Socket;
  path: Point[];
  nextStep: number;
  inventory: Inventory;
  pendingId?: string;
  busy: boolean;
  tokens: number;
  refillAt: number;
};
@Injectable()
export class Simulation implements OnModuleDestroy {
  readonly agents = new Map<string, Agent>();
  private world: Awaited<ReturnType<Store['state']>> = { nodes: [], buildings: [] };
  private timer?: NodeJS.Timeout;
  private redis?: Redis;
  private tickBusy = false;
  private worldMutations = 0;
  private lastMaintenance = 0;
  private readonly logger = new Logger(Simulation.name);
  constructor(@Inject(Store) readonly store: Store) {}
  async start() {
    this.world = await this.store.state();
    if (process.env.REDIS_URL) {
      this.redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
      this.redis.on('error', () =>
        this.logger.warn('Redis unavailable; PostgreSQL authority remains active.'),
      );
    }
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.logger.error(error));
    }, TICK_MS);
  }
  async join(socket: Socket, token: unknown) {
    const player = await this.store.authenticate(token);
    if (!player) throw new Error('Sessão inválida ou expirada. Entre novamente.');
    // The last socket wins, without allowing an old disconnect to delete the new connection.
    const old = this.agents.get(player.id);
    if (old) {
      this.agents.delete(player.id);
      old.socket.disconnect(true);
    }
    const position = old ? { x: old.x, y: old.y } : player;
    const safe = walkable(position, blockers(this.world.nodes, this.world.buildings))
      ? position
      : { x: 18, y: 18 };
    const agent: Agent = {
      id: player.id,
      name: player.name,
      x: safe.x,
      y: safe.y,
      facing: 1,
      gathering: null,
      socket,
      path: [],
      nextStep: 0,
      inventory: { wood: player.wood, stone: player.stone },
      busy: false,
      tokens: 20,
      refillAt: Date.now(),
    };
    this.agents.set(player.id, agent);
    socket.data.playerId = player.id;
    this.broadcastActivity(`${player.name} chegou ao vale.`);
    this.send(agent);
  }
  agent(socket: Socket): Agent {
    const agent = this.agents.get(socket.data.playerId as string);
    if (!agent || agent.socket.id !== socket.id) throw new Error('Conexão não autenticada.');
    const now = Date.now();
    agent.tokens = Math.min(20, agent.tokens + (now - agent.refillAt) * 0.01);
    agent.refillAt = now;
    if (agent.tokens < 1) throw new Error('Muitas ações. Respire um instante.');
    agent.tokens--;
    return agent;
  }
  move(agent: Agent, target: Point) {
    if (agent.busy) throw new Error('Aguarde a ação atual.');
    const path = findPath(agent, target, blockers(this.world.nodes, this.world.buildings));
    if (!path.length) throw new Error('Não há caminho livre até esse local.');
    agent.gathering = null;
    agent.pendingId = undefined;
    agent.path = path;
  }
  async gather(agent: Agent, nodeId: string, actionId: string) {
    if (agent.busy || agent.gathering) throw new Error('Uma coleta já está em andamento.');
    const receipt = await this.store.receipt.findUnique({
      where: { playerId_actionId: { playerId: agent.id, actionId } },
    });
    if (receipt) {
      agent.socket.emit('result', { ok: true, message: receipt.message, actionId });
      return;
    }
    // Recheck after the async receipt lookup: simultaneous requests cannot replace a running action.
    if (agent.busy || agent.gathering) throw new Error('Uma coleta já está em andamento.');
    const error = gatheringError(
      agent,
      this.world.nodes.find((n) => n.id === nodeId),
    );
    if (error) throw new Error(error);
    agent.path = [];
    agent.pendingId = actionId;
    agent.gathering = { nodeId, endsAt: Date.now() + GATHER_MS };
  }
  async build(agent: Agent, request: BuildRequest) {
    if (agent.busy || agent.gathering) throw new Error('Aguarde a ação atual.');
    agent.busy = true;
    agent.path = [];
    this.worldMutations++;
    try {
      const result = await this.store.build(agent.id, request, agent, [...this.agents.values()]);
      await this.refresh();
      agent.socket.emit('result', {
        ok: true,
        message: result.message,
        actionId: request.actionId,
      });
      if (!result.duplicate) this.broadcastActivity(`${agent.name}: ${result.message}`);
    } finally {
      agent.busy = false;
      this.worldMutations--;
    }
  }
  async refresh() {
    this.world = await this.store.state();
    const players = await this.store.player.findMany({
      where: { id: { in: [...this.agents.keys()] } },
    });
    for (const player of players) {
      const a = this.agents.get(player.id);
      if (a) a.inventory = { wood: player.wood, stone: player.stone };
    }
  }
  private async tick() {
    if (this.tickBusy) return;
    this.tickBusy = true;
    try {
      const now = Date.now(),
        occupied = blockers(this.world.nodes, this.world.buildings);
      for (const a of this.agents.values()) {
        if (!this.worldMutations && !a.busy && a.path.length && now >= a.nextStep) {
          const next = a.path.shift()!;
          if (walkable(next, occupied)) {
            a.facing = next.x - a.x || next.y - a.y;
            a.x = next.x;
            a.y = next.y;
            a.nextStep = now + STEP_MS;
          } else a.path = [];
        }
        if (!a.busy && a.gathering && now >= a.gathering.endsAt) {
          a.busy = true;
          try {
            const result = await this.store.gather(a.id, a.pendingId!, a.gathering.nodeId, a);
            await this.refresh();
            a.socket.emit('result', { ok: true, message: result.message, actionId: a.pendingId });
          } catch (error) {
            a.socket.emit('result', {
              ok: false,
              message: error instanceof Error ? error.message : 'Falha na coleta.',
            });
          } finally {
            a.busy = false;
            a.gathering = null;
            a.pendingId = undefined;
          }
        }
      }
      if (now - this.lastMaintenance >= 5000) {
        this.lastMaintenance = now;
        await this.store.regenerate();
        await this.refresh();
        await this.checkpoint();
        if (this.redis)
          await this.redis
            .set('logs:presence', JSON.stringify([...this.agents.keys()]), 'EX', 15)
            .catch(() => undefined);
      }
      for (const a of this.agents.values()) this.send(a);
    } finally {
      this.tickBusy = false;
    }
  }
  send(agent: Agent) {
    const snapshot: Snapshot = {
      time: Date.now(),
      seed: WORLD_SEED,
      selfId: agent.id,
      inventory: agent.inventory,
      ...this.world,
      players: [...this.agents.values()].map(({ id, name, x, y, facing, gathering }) => ({
        id,
        name,
        x,
        y,
        facing,
        gathering,
      })),
    };
    agent.socket.emit('snapshot', snapshot);
  }
  broadcastActivity(message: string) {
    for (const a of this.agents.values()) a.socket.emit('activity', message);
  }
  async leave(socket: Socket) {
    const agent = this.agents.get(socket.data.playerId as string);
    if (!agent || agent.socket.id !== socket.id) return;
    this.agents.delete(agent.id);
    await this.store.player.update({ where: { id: agent.id }, data: { x: agent.x, y: agent.y } });
  }
  async checkpoint() {
    await Promise.all(
      [...this.agents.values()].map((a) =>
        this.store.player.update({ where: { id: a.id }, data: { x: a.x, y: a.y } }),
      ),
    );
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.checkpoint();
    this.redis?.disconnect();
  }
}
