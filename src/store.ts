import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient, Prisma, type Player as PlayerRow } from '@prisma/client';
import { randomBytes, createHash } from 'node:crypto';
import {
  initialNodes,
  WORLD_SEED,
  WORLD_VERSION,
  SPAWN,
  type Building,
  type BuildingKind,
  type ResourceNode,
  type Point,
  type BuildRequest,
  type TradeRequest,
  type Inventory,
  type Item,
  type Stats,
  type Tool,
  type Tools,
  type MobKind,
  RECIPES,
  MOBS,
  PRICES,
  PRODUCTION,
  ITEMS,
  GATHER_XP,
  MAX_TOOL_TIER,
  TOOLS,
  TIER_NAMES,
  footprint,
  blockers,
  placementError,
  buildError,
  canAfford,
  gatheringError,
  gatherYield,
  applyXp,
  activeQuests,
  questProgress,
  upgradeCost,
  npcInRange,
  nearBuilding,
  buildingState,
  emptyStats,
  key,
  REGEN_MS,
} from '@logs/shared';

export const hash = (token: string) => createHash('sha256').update(token).digest('hex');
type Tx = Prisma.TransactionClient;
type Outcome = string | { message: string; rest?: boolean };
export type EconomicResult = { message: string; duplicate: boolean; rest?: boolean };
export const inventoryOf = (p: PlayerRow): Inventory => ({
  wood: p.wood,
  stone: p.stone,
  iron: p.iron,
  food: p.food,
  gold: p.gold,
});
export const toolsOf = (p: PlayerRow): Tools => ({
  sword: p.sword,
  axe: p.axe,
  pickaxe: p.pickaxe,
});
export const statsOf = (p: PlayerRow): Stats => ({
  ...emptyStats(),
  ...(p.stats as Partial<Stats>),
});
const sum = (cost: Partial<Inventory>) => Object.values(cost).reduce((a, n) => a + (n ?? 0), 0);
const describe = (items: Partial<Inventory>) =>
  (Object.entries(items) as [Item, number][])
    .filter(([, n]) => n)
    .map(([item, n]) => `+${n} ${n === 1 ? ITEMS[item].name.toLowerCase() : ITEMS[item].plural}`)
    .join(', ');
const toBuilding = (b: Prisma.BuildingGetPayload<object>): Building => ({
  id: b.id,
  kind: b.kind as BuildingKind,
  x: b.x,
  y: b.y,
  ownerId: b.ownerId,
  durability: b.durability,
  producedAt: b.producedAt.getTime(),
  plantedAt: b.plantedAt?.getTime() ?? null,
});

@Injectable()
export class Store extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
    await this.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(7391)`;
        const world = await tx.world.findUnique({ where: { id: 'valley' } });
        if (world && (world.seed !== WORLD_SEED || world.version > WORLD_VERSION))
          throw new Error('World geometry version mismatch; migrate explicitly.');
        if (world && world.version < WORLD_VERSION) await this.migrateWorld(tx);
        await tx.world.upsert({
          where: { id: 'valley' },
          create: { id: 'valley', seed: WORLD_SEED, version: WORLD_VERSION },
          update: { version: WORLD_VERSION },
        });
        const built = new Set(
          (await tx.occupiedCell.findMany()).map((cell) => key({ x: cell.x, y: cell.y })),
        );
        await tx.resourceNode.createMany({
          data: initialNodes()
            .filter((n) => !built.has(key(n)))
            .map((n) => ({ ...n, regeneratesAt: null })),
          skipDuplicates: true,
        });
      },
      { timeout: 30000 },
    );
  }
  /** v1 → v2: new geometry. Resources are reseeded; structures on now-invalid ground are removed
   * and refunded, every traveller wakes at the new spawn. Recorded as a world event. */
  private async migrateWorld(tx: Tx) {
    await tx.resourceNode.deleteMany();
    const kept: Building[] = [];
    let removed = 0;
    for (const raw of await tx.building.findMany({ orderBy: { createdAt: 'asc' } })) {
      const building = toBuilding(raw);
      if (!placementError(building, building.kind, blockers([], kept), [])) {
        kept.push(building);
        continue;
      }
      const cost = RECIPES[building.kind].cost as Partial<Inventory>;
      await tx.building.delete({ where: { id: building.id } });
      await tx.player.update({
        where: { id: building.ownerId },
        data: Object.fromEntries(Object.entries(cost).map(([k, n]) => [k, { increment: n }])),
      });
      removed++;
    }
    await tx.player.updateMany({ data: { x: SPAWN.x, y: SPAWN.y } });
    await tx.worldEvent.create({
      data: { type: 'migration', playerId: 'system', payload: { to: WORLD_VERSION, removed } },
    });
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
  async createSession(name: string) {
    const token = randomBytes(32).toString('hex');
    const player = await this.player.create({
      data: {
        name,
        x: SPAWN.x,
        y: SPAWN.y,
        sessions: {
          create: { tokenHash: hash(token), expiresAt: new Date(Date.now() + 30 * 86400000) },
        },
      },
    });
    return { token, player: { id: player.id, name: player.name } };
  }
  async authenticate(token: unknown) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const session = await this.session.findUnique({
      where: { tokenHash: hash(token) },
      include: { player: true },
    });
    return session && session.expiresAt.getTime() > Date.now() ? session.player : null;
  }
  async state(tx: Tx = this) {
    const [nodes, buildings] = await Promise.all([
      tx.resourceNode.findMany(),
      tx.building.findMany({ orderBy: { createdAt: 'asc' } }),
    ]);
    return {
      nodes: nodes.map((n) => ({
        ...n,
        regeneratesAt: n.regeneratesAt?.getTime() ?? null,
      })) as ResourceNode[],
      buildings: buildings.map(toBuilding),
    };
  }
  /** ReadCommitted + a common transaction-scoped lock: every economy write sees the last commit.
   * The cell PK and nonnegative checks remain independent DB safety nets. */
  async economic(
    playerId: string,
    actionId: string,
    mutation: (tx: Tx, player: PlayerRow) => Promise<Outcome>,
  ): Promise<EconomicResult> {
    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(7391)`;
        const receipt = await tx.receipt.findUnique({
          where: { playerId_actionId: { playerId, actionId } },
        });
        if (receipt) return { message: receipt.message, duplicate: true };
        const outcome = await mutation(
          tx,
          await tx.player.findUniqueOrThrow({ where: { id: playerId } }),
        );
        const result = typeof outcome === 'string' ? { message: outcome } : outcome;
        await tx.receipt.create({ data: { playerId, actionId, message: result.message } });
        return { ...result, duplicate: false };
      },
      { maxWait: 10000, timeout: 10000 },
    );
  }
  /** Applies inventory deltas, experience and statistic increments to a locked player row. */
  private async award(
    tx: Tx,
    player: PlayerRow,
    change: {
      items?: Partial<Inventory>;
      xp?: number;
      stats?: Partial<Stats>;
      data?: Prisma.PlayerUpdateInput;
    },
  ) {
    const progress = applyXp(player.level, player.xp, change.xp ?? 0);
    const stats = statsOf(player);
    for (const [k, n] of Object.entries(change.stats ?? {})) stats[k as keyof Stats] += n;
    const items = Object.fromEntries(
      Object.entries(change.items ?? {}).map(([k, n]) => [k, { increment: n }]),
    );
    await tx.player.update({
      where: { id: player.id },
      data: { ...items, ...change.data, level: progress.level, xp: progress.xp, stats },
    });
    return progress.gained ? ` Nível ${progress.level}!` : '';
  }
  async gather(playerId: string, actionId: string, nodeId: string, position: Point) {
    return this.economic(playerId, actionId, async (tx, player) => {
      const raw = await tx.resourceNode.findUnique({ where: { id: nodeId } });
      const node = raw
        ? ({ ...raw, regeneratesAt: raw.regeneratesAt?.getTime() ?? null } as ResourceNode)
        : undefined;
      const error = gatheringError(position, node);
      if (error || !node) throw new Error(error ?? 'Recurso inexistente.');
      const amount = Math.min(gatherYield(node.kind, toolsOf(player)), node.quantity);
      await tx.resourceNode.update({
        where: { id: nodeId },
        data: {
          quantity: { decrement: amount },
          regeneratesAt: node.quantity === amount ? new Date(Date.now() + REGEN_MS) : null,
        },
      });
      const level = await this.award(tx, player, {
        items: { [node.kind]: amount },
        xp: GATHER_XP[node.kind],
        stats: { [node.kind]: amount },
      });
      await tx.worldEvent.create({
        data: { type: 'gather', playerId, payload: { nodeId, amount } },
      });
      return `${describe({ [node.kind]: amount })} no inventário.${level}`;
    });
  }
  async build(playerId: string, request: BuildRequest, position: Point, players: Point[]) {
    return this.economic(playerId, request.actionId, async (tx, player) => {
      const rule = buildError(request, request.kind, position, player.level);
      if (rule) throw new Error(rule);
      const state = await this.state(tx);
      const error = placementError(
        request,
        request.kind,
        blockers(state.nodes, state.buildings),
        players,
      );
      if (error) throw new Error(error);
      const recipe = RECIPES[request.kind];
      if (!canAfford(inventoryOf(player), recipe.cost))
        throw new Error('Faltam recursos para esta construção.');
      const level = await this.award(tx, player, {
        items: Object.fromEntries(Object.entries(recipe.cost).map(([k, n]) => [k, -n])),
        xp: 20 + 2 * sum(recipe.cost),
      });
      const building = await tx.building.create({
        data: {
          kind: request.kind,
          x: request.x,
          y: request.y,
          ownerId: playerId,
          cells: { create: footprint(request, request.kind) },
        },
      });
      await tx.worldEvent.create({
        data: {
          type: 'build',
          playerId,
          payload: { buildingId: building.id, kind: request.kind, x: request.x, y: request.y },
        },
      });
      return `${recipe.name} construída! O vale agradece.${level}`;
    });
  }
  /** Loot for a defeated goblin; the action ID is derived from the mob's spawn generation. */
  async reward(playerId: string, actionId: string, kind: MobKind, rolls: [number, number]) {
    return this.economic(playerId, actionId, async (tx, player) => {
      const mob = MOBS[kind];
      const items = {
        gold: Math.round(mob.gold[0] + rolls[0] * (mob.gold[1] - mob.gold[0])),
        iron: rolls[1] < mob.iron ? 1 : 0,
      };
      const level = await this.award(tx, player, {
        items,
        xp: mob.xp,
        stats: { goblins: 1, warriors: kind === 'warrior' ? 1 : 0 },
      });
      return `${mob.name} derrotado! +${mob.xp} XP, ${describe(items)}.${level}`;
    });
  }
  async penalty(playerId: string, actionId: string) {
    return this.economic(playerId, actionId, async (tx, player) => {
      const lost = Math.floor(player.gold * 0.1);
      await this.award(tx, player, { items: { gold: -lost } });
      return lost ? `Você perdeu ${lost} de ouro ao cair.` : 'Você foi derrotado.';
    });
  }
  async claim(playerId: string, actionId: string, questId: string) {
    return this.economic(playerId, actionId, async (tx, player) => {
      const quest = activeQuests(player.claimed).find((q) => q.id === questId);
      if (!quest) throw new Error('Missão indisponível.');
      const owned = Object.fromEntries(
        (
          await tx.building.groupBy({ by: ['kind'], where: { ownerId: playerId }, _count: true })
        ).map((g) => [g.kind, g._count]),
      );
      if (
        questProgress(quest, { stats: statsOf(player), level: player.level, owned }) < quest.target
      )
        throw new Error('Missão ainda não concluída.');
      const level = await this.award(tx, player, {
        items: { gold: quest.reward.gold },
        xp: quest.reward.xp,
        data: { claimed: { push: quest.id } },
      });
      return `Missão “${quest.title}” concluída! +${quest.reward.xp} XP, +${quest.reward.gold} ouro.${level}`;
    });
  }
  async upgrade(playerId: string, actionId: string, tool: Tool, position: Point) {
    return this.economic(playerId, actionId, async (tx, player) => {
      if (!npcInRange(position, 'smith')) throw new Error('Fale com o ferreiro na forja.');
      const tier = toolsOf(player)[tool];
      if (tier >= MAX_TOOL_TIER) throw new Error('Esta ferramenta já é lendária.');
      const cost = upgradeCost(tier);
      if (!canAfford(inventoryOf(player), cost)) throw new Error('Faltam materiais para a forja.');
      const level = await this.award(tx, player, {
        items: Object.fromEntries(Object.entries(cost).map(([k, n]) => [k, -n])),
        xp: 40 * tier,
        stats: { upgrades: 1 },
        data: { [tool]: tier + 1 },
      });
      return `${TOOLS[tool].name} ${TIER_NAMES[tier + 1]} forjada!${level}`;
    });
  }
  async trade(playerId: string, request: TradeRequest, position: Point) {
    return this.economic(playerId, request.actionId, async (tx, player) => {
      if (!npcInRange(position, 'merchant')) throw new Error('Visite a mercadora na praça.');
      const price = PRICES[request.item]?.[request.mode];
      if (!price) throw new Error('A mercadora não negocia isso.');
      const total = price * request.amount;
      const inventory = inventoryOf(player);
      const sell = request.mode === 'sell';
      if (sell ? inventory[request.item] < request.amount : inventory.gold < total)
        throw new Error(sell ? 'Você não tem tudo isso.' : 'Ouro insuficiente.');
      await this.award(tx, player, {
        items: {
          [request.item]: sell ? -request.amount : request.amount,
          gold: sell ? total : -total,
        },
        stats: { trades: 1 },
      });
      const goods = `${request.amount} ${request.amount === 1 ? ITEMS[request.item].name.toLowerCase() : ITEMS[request.item].plural}`;
      return sell ? `Vendeu ${goods} por ${total} ouro.` : `Comprou ${goods} por ${total} ouro.`;
    });
  }
  async eat(playerId: string, actionId: string) {
    return this.economic(playerId, actionId, async (tx, player) => {
      if (player.food < 1) throw new Error('Sem comida na bolsa.');
      await this.award(tx, player, { items: { food: -1 } });
      return 'Você comeu e recuperou as forças.';
    });
  }
  async interact(playerId: string, actionId: string, buildingId: string, position: Point) {
    return this.economic(playerId, actionId, async (tx, player): Promise<Outcome> => {
      const raw = await tx.building.findUnique({ where: { id: buildingId } });
      if (!raw) throw new Error('Construção inexistente.');
      const building = toBuilding(raw);
      if (building.ownerId !== playerId)
        throw new Error('Apenas o dono pode usar esta construção.');
      if (!nearBuilding(position, building)) throw new Error('Aproxime-se da construção.');
      const now = Date.now(),
        state = buildingState(building, now);
      if (state.action === 'collect') {
        if (!state.amount) throw new Error('Ainda não há produção para recolher.');
        const p = PRODUCTION[building.kind]!;
        const producedAt =
          state.amount >= p.cap ? now : building.producedAt + state.amount * p.every;
        await tx.building.update({
          where: { id: buildingId },
          data: { producedAt: new Date(producedAt) },
        });
        const level = await this.award(tx, player, {
          items: { [state.item]: state.amount },
          xp: state.amount,
        });
        return `Recolheu ${describe({ [state.item]: state.amount }).slice(1)}.${level}`;
      }
      if (state.action === 'plant') {
        await tx.building.update({ where: { id: buildingId }, data: { plantedAt: new Date(now) } });
        return 'Trigo plantado. Volte em 1 minuto.';
      }
      if (state.action === 'growing') throw new Error('A plantação ainda está crescendo.');
      if (state.action === 'harvest') {
        await tx.building.update({ where: { id: buildingId }, data: { plantedAt: null } });
        const level = await this.award(tx, player, {
          items: { food: 5 },
          xp: 15,
          stats: { harvests: 1, food: 5 },
        });
        return `Colheita! +5 comidas.${level}`;
      }
      if (state.action === 'rest') {
        if (!state.ready) throw new Error('Você descansou há pouco. Volte mais tarde.');
        await tx.building.update({
          where: { id: buildingId },
          data: { producedAt: new Date(now) },
        });
        return { message: 'Você descansou em casa. Energia e vida renovadas.', rest: true };
      }
      throw new Error('Nada para fazer aqui.');
    });
  }
  async regenerate() {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7391)`;
      return tx.$executeRaw`UPDATE "ResourceNode" SET quantity = capacity, "regeneratesAt" = NULL WHERE "regeneratesAt" <= NOW()`;
    });
  }
}
