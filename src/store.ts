import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { randomBytes, createHash } from 'node:crypto';
import {
  initialNodes,
  WORLD_SEED,
  type Building,
  type ResourceNode,
  type Point,
  type BuildRequest,
  RECIPES,
  footprint,
  blockers,
  placementError,
  canAfford,
  gatheringError,
  REGEN_MS,
} from '@logs/shared';

export const hash = (token: string) => createHash('sha256').update(token).digest('hex');
@Injectable()
export class Store extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
    await this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7391)`;
      const world = await tx.world.findUnique({ where: { id: 'valley' } });
      if (world && (world.seed !== WORLD_SEED || world.version !== 1))
        throw new Error('World geometry version mismatch; migrate explicitly.');
      await tx.world.upsert({
        where: { id: 'valley' },
        create: { id: 'valley', seed: WORLD_SEED },
        update: {},
      });
      await tx.resourceNode.createMany({
        data: initialNodes().map((n) => ({ ...n, regeneratesAt: null })),
        skipDuplicates: true,
      });
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
  async state(tx: Prisma.TransactionClient = this) {
    const [nodes, buildings] = await Promise.all([
      tx.resourceNode.findMany(),
      tx.building.findMany(),
    ]);
    return {
      nodes: nodes.map((n) => ({
        ...n,
        regeneratesAt: n.regeneratesAt?.getTime() ?? null,
      })) as ResourceNode[],
      buildings: buildings as Building[],
    };
  }
  /** ReadCommitted + a common transaction-scoped lock: every economy write sees the last commit.
   * The cell PK and nonnegative checks remain independent DB safety nets. */
  async economic(
    playerId: string,
    actionId: string,
    mutation: (tx: Prisma.TransactionClient) => Promise<string>,
  ) {
    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(7391)`;
        const receipt = await tx.receipt.findUnique({
          where: { playerId_actionId: { playerId, actionId } },
        });
        if (receipt) return { message: receipt.message, duplicate: true };
        const message = await mutation(tx);
        await tx.receipt.create({ data: { playerId, actionId, message } });
        return { message, duplicate: false };
      },
      { maxWait: 10000, timeout: 10000 },
    );
  }
  async gather(playerId: string, actionId: string, nodeId: string, position: Point) {
    return this.economic(playerId, actionId, async (tx) => {
      const raw = await tx.resourceNode.findUnique({ where: { id: nodeId } });
      const node = raw
        ? ({ ...raw, regeneratesAt: raw.regeneratesAt?.getTime() ?? null } as ResourceNode)
        : undefined;
      const error = gatheringError(position, node);
      if (error || !node) throw new Error(error ?? 'Recurso inexistente.');
      const amount = Math.min(4, node.quantity);
      await tx.resourceNode.update({
        where: { id: nodeId },
        data: {
          quantity: { decrement: amount },
          regeneratesAt: node.quantity === amount ? new Date(Date.now() + REGEN_MS) : null,
        },
      });
      await tx.player.update({
        where: { id: playerId },
        data: { [node.kind]: { increment: amount } },
      });
      await tx.worldEvent.create({
        data: { type: 'gather', playerId, payload: { nodeId, amount } },
      });
      return `+${amount} ${node.kind === 'wood' ? 'madeiras' : 'pedras'} no inventário.`;
    });
  }
  async build(playerId: string, request: BuildRequest, position: Point, players: Point[]) {
    return this.economic(playerId, request.actionId, async (tx) => {
      if (Math.abs(position.x - request.x) + Math.abs(position.y - request.y) > 6)
        throw new Error('Construa a até 6 passos de distância.');
      const state = await this.state(tx);
      const error = placementError(
        request,
        request.kind,
        blockers(state.nodes, state.buildings),
        players,
      );
      if (error) throw new Error(error);
      const player = await tx.player.findUniqueOrThrow({ where: { id: playerId } });
      if (!canAfford(player, request.kind))
        throw new Error('Faltam recursos para esta construção.');
      const recipe = RECIPES[request.kind];
      await tx.player.update({
        where: { id: playerId },
        data: { wood: { decrement: recipe.wood }, stone: { decrement: recipe.stone } },
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
      return `${recipe.name} construída! O vale agradece.`;
    });
  }
  async regenerate() {
    await this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7391)`;
      await tx.$executeRaw`UPDATE "ResourceNode" SET quantity = capacity, "regeneratesAt" = NULL WHERE "regeneratesAt" <= NOW()`;
    });
  }
}
