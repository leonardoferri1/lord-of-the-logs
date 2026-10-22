import { Injectable, Inject, OnModuleDestroy, Logger } from '@nestjs/common';
import { Store, inventoryOf, statsOf, toolsOf, type EconomicResult } from './store';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  blockers,
  findPath,
  gatheringError,
  walkable,
  neighbors,
  pathToAdjacent,
  distance,
  key,
  maxHp,
  xpToNext,
  swordDamage,
  mobSpawns,
  GATHER_MS,
  GATHER_ENERGY,
  ATTACK_ENERGY,
  ATTACK_MS,
  MAX_ENERGY,
  MOB_RESPAWN_MS,
  MOBS,
  LEASH,
  TOWER,
  STEP_MS,
  TICK_MS,
  WORLD_SEED,
  SPAWN,
  type Player,
  type Point,
  type Snapshot,
  type BuildRequest,
  type TradeRequest,
  type Inventory,
  type Tools,
  type Tool,
  type Stats,
  type Mob,
  type MobKind,
  type Effect,
  type ChatMessage,
} from '@logs/shared';
import type { Socket } from 'socket.io';

type Agent = Player & {
  socket: Socket;
  path: Point[];
  nextStep: number;
  inventory: Inventory;
  tools: Tools;
  stats: Stats;
  claimed: string[];
  xp: number;
  energy: number;
  pendingId?: string;
  busy: boolean;
  tokens: number;
  refillAt: number;
  nextAttack: number;
  repathAt: number;
  hurtAt: number;
  chatAt: number;
  sentRevision: number;
};
type MobState = Mob & {
  home: Point;
  nextMove: number;
  nextAttack: number;
  lastHitBy: string | null;
  respawnAt: number;
  generation: number;
  returning: boolean;
};
/** Facing is a direction index: 0 = +x, 1 = +y, 2 = -x, 3 = -y. */
const facingOf = (from: Point, to: Point) =>
  to.x > from.x ? 0 : to.y > from.y ? 1 : to.x < from.x ? 2 : to.y < from.y ? 3 : -1;
const between = (range: readonly [number, number]) =>
  range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1));

@Injectable()
export class Simulation implements OnModuleDestroy {
  readonly agents = new Map<string, Agent>();
  readonly mobs = new Map<string, MobState>();
  private world: Awaited<ReturnType<Store['state']>> = { nodes: [], buildings: [] };
  private revision = 0;
  private effects: Effect[] = [];
  private effectId = 0;
  private chat: ChatMessage[] = [];
  private towerShots = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private redis?: Redis;
  private tickBusy = false;
  private worldMutations = 0;
  private lastMaintenance = 0;
  private lastVitals = 0;
  private readonly logger = new Logger(Simulation.name);
  constructor(@Inject(Store) readonly store: Store) {}
  async start() {
    this.world = await this.store.state();
    for (const spawn of mobSpawns()) {
      const mob = MOBS[spawn.kind];
      this.mobs.set(spawn.id, {
        id: spawn.id,
        kind: spawn.kind,
        ...spawn.home,
        home: spawn.home,
        hp: mob.hp,
        maxHp: mob.hp,
        facing: 1,
        targetId: null,
        dead: false,
        nextMove: 0,
        nextAttack: 0,
        lastHitBy: null,
        respawnAt: 0,
        generation: 0,
        returning: false,
      });
    }
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
    const safe = walkable(position, this.occupied()) ? position : { ...SPAWN };
    const top = maxHp(player.level);
    const agent: Agent = {
      id: player.id,
      name: player.name,
      x: safe.x,
      y: safe.y,
      facing: 1,
      level: player.level,
      hp: old?.hp ?? (player.hp > 0 ? Math.min(player.hp, top) : Math.round(top / 2)),
      maxHp: top,
      gathering: null,
      attacking: null,
      socket,
      path: [],
      nextStep: 0,
      inventory: inventoryOf(player),
      tools: toolsOf(player),
      stats: statsOf(player),
      claimed: player.claimed,
      xp: player.xp,
      energy: old?.energy ?? Math.min(player.energy, MAX_ENERGY),
      busy: false,
      tokens: 20,
      refillAt: Date.now(),
      nextAttack: 0,
      repathAt: 0,
      hurtAt: 0,
      chatAt: 0,
      sentRevision: -1,
    };
    this.agents.set(player.id, agent);
    socket.data.playerId = player.id;
    socket.emit('chatHistory', this.chat);
    this.system(`${player.name} chegou ao vale.`);
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
  private occupied() {
    return blockers(this.world.nodes, this.world.buildings);
  }
  private effect(kind: Effect['kind'], at: Point, amount = 0, extra: Partial<Effect> = {}) {
    this.effects.push({
      id: ++this.effectId,
      kind,
      x: at.x,
      y: at.y,
      amount,
      at: Date.now(),
      ...extra,
    });
  }
  move(agent: Agent, target: Point) {
    if (agent.busy) throw new Error('Aguarde a ação atual.');
    const path = findPath(agent, target, this.occupied());
    if (!path.length) throw new Error('Não há caminho livre até esse local.');
    this.stop(agent);
    agent.path = path;
  }
  stop(agent: Agent) {
    agent.gathering = null;
    agent.pendingId = undefined;
    agent.attacking = null;
    agent.path = [];
  }
  attack(agent: Agent, mobId: string) {
    const mob = this.mobs.get(mobId);
    if (!mob || mob.dead) throw new Error('Esse inimigo já caiu.');
    if (agent.busy || agent.gathering) throw new Error('Aguarde a ação atual.');
    agent.attacking = mob.id;
    agent.repathAt = 0;
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
    const node = this.world.nodes.find((n) => n.id === nodeId);
    const error = gatheringError(agent, node);
    if (error) throw new Error(error);
    if (agent.energy < GATHER_ENERGY)
      throw new Error('Sem energia. Coma algo ou descanse em casa.');
    agent.energy -= GATHER_ENERGY;
    agent.path = [];
    agent.attacking = null;
    agent.facing = facingOf(agent, node!);
    agent.pendingId = actionId;
    agent.gathering = { nodeId, endsAt: Date.now() + GATHER_MS };
  }
  /** Serializes an economic commit with movement paused, then reports and refreshes caches. */
  private async commit(agent: Agent, actionId: string, run: () => Promise<EconomicResult>) {
    if (agent.busy || agent.gathering) throw new Error('Aguarde a ação atual.');
    agent.busy = true;
    agent.path = [];
    this.worldMutations++;
    try {
      const result = await run();
      await this.refresh();
      agent.socket.emit('result', { ok: true, message: result.message, actionId });
      return result;
    } finally {
      agent.busy = false;
      this.worldMutations--;
    }
  }
  async build(agent: Agent, request: BuildRequest) {
    const result = await this.commit(agent, request.actionId, () =>
      this.store.build(agent.id, request, agent, [...this.agents.values()]),
    );
    if (!result.duplicate) this.system(`${agent.name}: ${result.message}`);
  }
  async interact(agent: Agent, buildingId: string, actionId: string) {
    const result = await this.commit(agent, actionId, () =>
      this.store.interact(agent.id, actionId, buildingId, agent),
    );
    if (result.rest && !result.duplicate) {
      agent.energy = Math.min(MAX_ENERGY, agent.energy + 60);
      this.heal(agent, 40);
    }
  }
  async upgrade(agent: Agent, tool: Tool, actionId: string) {
    await this.commit(agent, actionId, () => this.store.upgrade(agent.id, actionId, tool, agent));
  }
  async trade(agent: Agent, request: TradeRequest) {
    await this.commit(agent, request.actionId, () => this.store.trade(agent.id, request, agent));
  }
  async claim(agent: Agent, questId: string, actionId: string) {
    await this.commit(agent, actionId, () => this.store.claim(agent.id, actionId, questId));
  }
  async eat(agent: Agent, actionId: string) {
    if (agent.hp >= agent.maxHp && agent.energy >= MAX_ENERGY)
      throw new Error('Você está satisfeito.');
    const result = await this.commit(agent, actionId, () => this.store.eat(agent.id, actionId));
    if (!result.duplicate) {
      agent.energy = Math.min(MAX_ENERGY, agent.energy + 30);
      this.heal(agent, 25);
    }
  }
  say(agent: Agent, text: string) {
    const now = Date.now();
    if (now < agent.chatAt) throw new Error('Calma, viajante. Uma mensagem por vez.');
    agent.chatAt = now + 1200;
    this.publish({ id: randomUUID(), channel: 'global', name: agent.name, text, at: now });
  }
  private heal(agent: Agent, amount: number) {
    const healed = Math.min(agent.maxHp - agent.hp, amount);
    agent.hp += healed;
    if (healed > 0) this.effect('heal', agent, healed);
  }
  async refresh(worldChanged = true) {
    if (worldChanged) {
      this.world = await this.store.state();
      this.revision++;
    }
    const players = await this.store.player.findMany({
      where: { id: { in: [...this.agents.keys()] } },
    });
    for (const player of players) {
      const a = this.agents.get(player.id);
      if (!a) continue;
      a.inventory = inventoryOf(player);
      a.tools = toolsOf(player);
      a.stats = statsOf(player);
      a.claimed = player.claimed;
      a.xp = player.xp;
      if (player.level > a.level) {
        a.level = player.level;
        a.maxHp = maxHp(player.level);
        a.hp = a.maxHp;
        a.energy = MAX_ENERGY;
        this.effect('level', a, player.level);
        this.system(`${a.name} alcançou o nível ${player.level}!`);
      }
    }
  }
  private async tick() {
    if (this.tickBusy) return;
    this.tickBusy = true;
    try {
      const now = Date.now(),
        occupied = this.occupied();
      for (const a of this.agents.values()) {
        if (a.attacking) this.fight(a, now, occupied);
        if (!this.worldMutations && !a.busy && a.path.length && now >= a.nextStep) {
          const next = a.path.shift()!;
          if (walkable(next, occupied)) {
            a.facing = facingOf(a, next);
            a.x = next.x;
            a.y = next.y;
            a.nextStep = now + STEP_MS;
          } else a.path = [];
        }
        if (!a.busy && a.gathering && now >= a.gathering.endsAt) {
          a.busy = true;
          const node = this.world.nodes.find((n) => n.id === a.gathering!.nodeId);
          try {
            const result = await this.store.gather(a.id, a.pendingId!, a.gathering.nodeId, a);
            await this.refresh();
            if (node) this.effect('loot', node, 0, { text: result.message.split(' no ')[0] });
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
      await this.mobsTick(now, occupied);
      await this.towersTick(now);
      if (now - this.lastVitals >= 1000) {
        this.lastVitals = now;
        for (const a of this.agents.values()) {
          const home = this.world.buildings.some(
            (b) => b.kind === 'house' && b.ownerId === a.id && distance(a, b) <= 3,
          );
          a.energy = Math.min(MAX_ENERGY, a.energy + (home ? 3 : 1));
          if (now - a.hurtAt > 6000) a.hp = Math.min(a.maxHp, a.hp + (home ? 4 : 1));
        }
      }
      if (now - this.lastMaintenance >= 5000) {
        this.lastMaintenance = now;
        const regenerated = await this.store.regenerate();
        await this.refresh(regenerated > 0);
        await this.checkpoint();
        if (this.redis)
          await this.redis
            .set('logs:presence', JSON.stringify([...this.agents.keys()]), 'EX', 15)
            .catch(() => undefined);
      }
      this.effects = this.effects.filter((e) => now - e.at < 1500);
      for (const a of this.agents.values()) this.send(a);
    } finally {
      this.tickBusy = false;
    }
  }
  private fight(a: Agent, now: number, occupied: Set<string>) {
    const mob = this.mobs.get(a.attacking!);
    if (a.busy) return;
    if (!mob || mob.dead) {
      a.attacking = null;
      return;
    }
    if (distance(a, mob) <= 1) {
      a.path = [];
      if (now < a.nextAttack) return;
      a.nextAttack = now + ATTACK_MS;
      a.facing = facingOf(a, mob);
      const tired = a.energy < ATTACK_ENERGY;
      if (!tired) a.energy -= ATTACK_ENERGY;
      const damage = Math.max(
        1,
        Math.round(swordDamage(a.tools.sword, a.level, Math.random()) / (tired ? 2 : 1)),
      );
      mob.hp = Math.max(0, mob.hp - damage);
      mob.lastHitBy = a.id;
      if (!mob.returning) mob.targetId = a.id;
      this.effect('damage', mob, damage);
    } else if (now >= a.repathAt) {
      a.repathAt = now + 400;
      const path = pathToAdjacent(a, mob, occupied);
      if (!path || distance(a, mob) > 28) {
        a.attacking = null;
        a.path = [];
      } else a.path = path;
    }
  }
  private async mobsTick(now: number, occupied: Set<string>) {
    const taken = new Set([...this.mobs.values()].filter((m) => !m.dead).map(key));
    for (const mob of this.mobs.values()) {
      const kind = MOBS[mob.kind];
      if (mob.dead) {
        if (now >= mob.respawnAt) {
          Object.assign(mob, {
            ...mob.home,
            hp: mob.maxHp,
            dead: false,
            targetId: null,
            lastHitBy: null,
            returning: false,
          });
          taken.add(key(mob));
        }
        continue;
      }
      if (mob.hp <= 0) {
        await this.defeat(mob, now);
        taken.delete(key(mob));
        continue;
      }
      let target = mob.targetId ? this.agents.get(mob.targetId) : undefined;
      if (distance(mob, mob.home) > LEASH) {
        mob.returning = true;
        target = undefined;
      }
      if (mob.returning && distance(mob, mob.home) <= 1) {
        mob.returning = false;
        mob.hp = mob.maxHp;
      }
      if (!mob.returning && !target)
        target = [...this.agents.values()]
          .filter((a) => distance(a, mob) <= kind.aggro && distance(a, mob.home) <= LEASH)
          .sort((a, b) => distance(a, mob) - distance(b, mob))[0];
      mob.targetId = target?.id ?? null;
      if (target && distance(mob, target) <= 1) {
        if (now >= mob.nextAttack) {
          mob.nextAttack = now + kind.attackMs;
          mob.facing = facingOf(mob, target);
          const damage = between(kind.damage);
          target.hp = Math.max(0, target.hp - damage);
          target.hurtAt = now;
          // Idle travellers defend themselves instead of standing still under attack.
          if (!target.attacking && !target.gathering && !target.path.length && !target.busy)
            target.attacking = mob.id;
          this.effect('hurt', target, damage);
          if (target.hp <= 0) await this.fall(target, kind.name);
        }
        continue;
      }
      if (now < mob.nextMove) continue;
      mob.nextMove = now + kind.stepMs * (target || mob.returning ? 1 : 3 + Math.random() * 4);
      const goal = target ?? (mob.returning || Math.random() < 0.5 ? mob.home : undefined);
      const options = neighbors(mob).filter(
        (p) =>
          walkable(p, occupied) &&
          !taken.has(key(p)) &&
          distance(p, mob.home) <= (target || mob.returning ? LEASH + 1 : 3),
      );
      const step = goal
        ? options
            .filter((p) => distance(p, goal) < distance(mob, goal))
            .sort((a, b) => distance(a, goal) - distance(b, goal))[0]
        : options[Math.floor(Math.random() * options.length)];
      if (step) {
        taken.delete(key(mob));
        mob.facing = facingOf(mob, step);
        mob.x = step.x;
        mob.y = step.y;
        taken.add(key(mob));
      }
    }
  }
  private async towersTick(now: number) {
    for (const tower of this.world.buildings.filter((b) => b.kind === 'tower')) {
      if (now < (this.towerShots.get(tower.id) ?? 0)) continue;
      const mob = [...this.mobs.values()]
        .filter((m) => !m.dead && m.hp > 0 && distance(m, tower) <= TOWER.range)
        .sort((a, b) => distance(a, tower) - distance(b, tower))[0];
      if (!mob) continue;
      this.towerShots.set(tower.id, now + TOWER.every);
      mob.hp = Math.max(0, mob.hp - TOWER.damage);
      mob.lastHitBy ??= tower.ownerId;
      this.effect('arrow', mob, TOWER.damage, { from: { x: tower.x, y: tower.y } });
    }
  }
  private async defeat(mob: MobState, now: number) {
    mob.dead = true;
    mob.respawnAt = now + MOB_RESPAWN_MS;
    mob.targetId = null;
    const generation = mob.generation++;
    for (const a of this.agents.values()) if (a.attacking === mob.id) a.attacking = null;
    if (!mob.lastHitBy) return;
    try {
      const result = await this.store.reward(
        mob.lastHitBy,
        `kill:${mob.id}:${generation}:${now}`,
        mob.kind as MobKind,
        [Math.random(), Math.random()],
      );
      await this.refresh(false);
      this.effect('xp', mob, MOBS[mob.kind].xp);
      const killer = this.agents.get(mob.lastHitBy);
      killer?.socket.emit('result', { ok: true, message: result.message });
      if (killer && mob.kind === 'warrior')
        this.system(`${killer.name} derrotou um ${MOBS[mob.kind].name}!`);
    } catch (error) {
      this.logger.error(error);
    }
  }
  private async fall(agent: Agent, by: string) {
    this.effect('death', agent);
    this.stop(agent);
    Object.assign(agent, { ...SPAWN, hp: Math.round(agent.maxHp / 2) });
    agent.energy = Math.max(agent.energy, 30);
    this.system(`${agent.name} foi derrotado por um ${by} e acordou na vila.`);
    try {
      const result = await this.store.penalty(agent.id, `fall:${randomUUID()}`);
      await this.refresh(false);
      agent.socket.emit('result', { ok: false, message: result.message });
    } catch (error) {
      this.logger.error(error);
    }
  }
  send(agent: Agent) {
    const snapshot: Snapshot = {
      time: Date.now(),
      seed: WORLD_SEED,
      selfId: agent.id,
      revision: this.revision,
      inventory: agent.inventory,
      me: {
        level: agent.level,
        xp: agent.xp,
        xpNext: xpToNext(agent.level),
        hp: agent.hp,
        maxHp: agent.maxHp,
        energy: agent.energy,
        maxEnergy: MAX_ENERGY,
        tools: agent.tools,
        stats: agent.stats,
        claimed: agent.claimed,
      },
      buildings: this.world.buildings,
      nodes: agent.sentRevision === this.revision ? undefined : this.world.nodes,
      effects: this.effects,
      mobs: [...this.mobs.values()].map(
        ({ id, kind, x, y, hp, maxHp: top, facing, targetId, dead }) => ({
          id,
          kind,
          x,
          y,
          hp,
          maxHp: top,
          facing,
          targetId,
          dead,
        }),
      ),
      players: [...this.agents.values()].map(
        ({ id, name, x, y, facing, level, hp, maxHp: top, gathering, attacking }) => ({
          id,
          name,
          x,
          y,
          facing,
          level,
          hp,
          maxHp: top,
          gathering,
          attacking,
        }),
      ),
    };
    agent.sentRevision = this.revision;
    agent.socket.emit('snapshot', snapshot);
  }
  private publish(message: ChatMessage) {
    this.chat = [...this.chat.slice(-39), message];
    for (const a of this.agents.values()) a.socket.emit('chat', message);
  }
  system(text: string) {
    this.publish({ id: randomUUID(), channel: 'system', name: 'Vale', text, at: Date.now() });
  }
  async leave(socket: Socket) {
    const agent = this.agents.get(socket.data.playerId as string);
    if (!agent || agent.socket.id !== socket.id) return;
    this.agents.delete(agent.id);
    for (const mob of this.mobs.values()) if (mob.targetId === agent.id) mob.targetId = null;
    await this.store.player.update({
      where: { id: agent.id },
      data: { x: agent.x, y: agent.y, hp: agent.hp, energy: agent.energy },
    });
  }
  async checkpoint() {
    await Promise.all(
      [...this.agents.values()].map((a) =>
        this.store.player.update({
          where: { id: a.id },
          data: { x: a.x, y: a.y, hp: a.hp, energy: a.energy },
        }),
      ),
    );
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.checkpoint();
    this.redis?.disconnect();
  }
}
