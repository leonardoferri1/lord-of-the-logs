import { z } from 'zod';

export const WORLD_SIZE = 38;
export const WORLD_SEED = 7391;
export const TICK_MS = 100;
export const STEP_MS = 300;
export const GATHER_MS = 1500;
export const REGEN_MS = 45000;
export type Point = { x: number; y: number };
export type Terrain = 'grass' | 'forest' | 'dirt' | 'stone' | 'water';
export type Resource = 'wood' | 'stone';
export type Inventory = Record<Resource, number>;
export const RECIPES = {
  house: {
    name: 'Casa de madeira',
    wood: 12,
    stone: 4,
    size: 2,
    description: 'Um teto para ambições nada modestas.',
  },
  lumber: {
    name: 'Serraria',
    wood: 8,
    stone: 2,
    size: 2,
    description: 'O começo de um império de gravetos.',
  },
  storage: {
    name: 'Depósito de pedra',
    wood: 6,
    stone: 8,
    size: 2,
    description: 'Pedras organizadas também são progresso.',
  },
  tower: {
    name: 'Torre de vigia',
    wood: 16,
    stone: 12,
    size: 1,
    description: 'Uma vista à altura dos seus planos.',
  },
} as const;
export type BuildingKind = keyof typeof RECIPES;
export type Building = Point & {
  id: string;
  kind: BuildingKind;
  ownerId: string;
  durability: number;
};
export type ResourceNode = Point & {
  id: string;
  kind: Resource;
  quantity: number;
  capacity: number;
  regeneratesAt: number | null;
};
export type Player = Point & {
  id: string;
  name: string;
  facing: number;
  gathering: null | { nodeId: string; endsAt: number };
};
export type Snapshot = {
  time: number;
  players: Player[];
  nodes: ResourceNode[];
  buildings: Building[];
  inventory: Inventory;
  selfId: string;
  seed: number;
};
export type ActionResult = { ok: boolean; message: string; actionId?: string };
export const pointSchema = z
  .object({
    x: z
      .number()
      .int()
      .min(0)
      .max(WORLD_SIZE - 1),
    y: z
      .number()
      .int()
      .min(0)
      .max(WORLD_SIZE - 1),
  })
  .strict();
export const gatherSchema = z
  .object({ nodeId: z.string().max(80), actionId: z.string().uuid() })
  .strict();
export const buildSchema = pointSchema.extend({
  kind: z.enum(['house', 'lumber', 'storage', 'tower']),
  actionId: z.string().uuid(),
});
export const sessionSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(20)
      .regex(/^[\p{L}\p{N} _-]+$/u),
  })
  .strict();
export type BuildRequest = z.infer<typeof buildSchema>;
export interface ClientEvents {
  move: (data: Point) => void;
  gather: (data: z.infer<typeof gatherSchema>) => void;
  build: (data: BuildRequest) => void;
  resync: () => void;
}
export interface ServerEvents {
  snapshot: (data: Snapshot) => void;
  result: (data: ActionResult) => void;
  activity: (message: string) => void;
}

export const key = (p: Point) => `${p.x},${p.y}`;
export const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export function noise(x: number, y: number, seed = WORLD_SEED): number {
  let n = Math.imul(x + seed, 374761393) + Math.imul(y, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
export function terrain(x: number, y: number): Terrain {
  if (x < 0 || y < 0 || x >= WORLD_SIZE || y >= WORLD_SIZE) return 'water';
  const river = 27 + Math.sin(y * 0.23) * 2;
  if (x < 2 || y < 2 || x > 35 || y > 35 || (Math.abs(x - river) < 1.65 && y !== 17 && y !== 18))
    return 'water';
  if (
    (x >= 17 && x <= 18 && y >= 13 && y <= 14) ||
    x === 18 ||
    y === 18 ||
    (x >= 15 && x <= 21 && y >= 15 && y <= 21)
  )
    return 'dirt';
  const n = noise(x, y);
  return n > 0.87 ? 'stone' : n < 0.48 ? 'forest' : 'grass';
}
export function initialNodes(): ResourceNode[] {
  const nodes: ResourceNode[] = [];
  for (let y = 2; y < WORLD_SIZE - 2; y++)
    for (let x = 2; x < WORLD_SIZE - 2; x++) {
      const t = terrain(x, y);
      if ((t === 'forest' && noise(x, y, 123) > 0.32) || (t === 'stone' && noise(x, y, 55) > 0.3))
        nodes.push({
          id: `node-${x}-${y}`,
          x,
          y,
          kind: t === 'forest' ? 'wood' : 'stone',
          capacity: 24,
          quantity: 24,
          regeneratesAt: null,
        });
    }
  return nodes;
}
export function footprint(p: Point, kind: BuildingKind): Point[] {
  return Array.from({ length: RECIPES[kind].size ** 2 }, (_, i) => ({
    x: p.x + (i % RECIPES[kind].size),
    y: p.y + Math.floor(i / RECIPES[kind].size),
  }));
}
export function blockers(nodes: ResourceNode[], buildings: Building[]): Set<string> {
  return new Set([
    '17,13',
    '18,13',
    '17,14',
    '18,14',
    ...nodes.map(key),
    ...buildings.flatMap((b) => footprint(b, b.kind).map(key)),
  ]);
}
export function walkable(p: Point, occupied: Set<string>): boolean {
  return terrain(p.x, p.y) !== 'water' && !occupied.has(key(p));
}
export function placementError(
  p: Point,
  kind: BuildingKind,
  occupied: Set<string>,
  players: Point[],
): string | null {
  if (footprint(p, kind).some((t) => !walkable(t, occupied)))
    return 'Local ocupado ou terreno inválido.';
  if (footprint(p, kind).some((t) => players.some((player) => key(player) === key(t))))
    return 'Há um viajante neste local.';
  if (footprint(p, kind).some((t) => t.x === 18 || t.y === 18))
    return 'Mantenha os caminhos livres.';
  return null;
}
export function gatheringError(player: Point, node: ResourceNode | undefined): string | null {
  if (!node) return 'Recurso inexistente.';
  if (distance(player, node) > 1) return 'Aproxime-se do recurso primeiro.';
  if (node.quantity <= 0) return 'Recurso esgotado. Aguarde a regeneração.';
  return null;
}
export function canAfford(inventory: Inventory, kind: BuildingKind): boolean {
  return inventory.wood >= RECIPES[kind].wood && inventory.stone >= RECIPES[kind].stone;
}
export function toIso(p: Point): Point {
  return { x: (p.x - p.y) * 32, y: (p.x + p.y) * 16 };
}
export function fromIso(p: Point): Point {
  return { x: Math.round(p.x / 64 + p.y / 32), y: Math.round(p.y / 32 - p.x / 64) };
}
/** Bounded A*: orthogonal steps, Manhattan heuristic, no corner cutting. */
export function findPath(start: Point, goal: Point, occupied: Set<string>): Point[] {
  if (!walkable(goal, occupied)) return [];
  const open = [start],
    costs = new Map([[key(start), 0]]),
    previous = new Map<string, Point>();
  while (open.length) {
    open.sort(
      (a, b) => costs.get(key(a))! + distance(a, goal) - costs.get(key(b))! - distance(b, goal),
    );
    const current = open.shift()!;
    if (key(current) === key(goal)) {
      const path: Point[] = [];
      let p = current;
      while (key(p) !== key(start)) {
        path.unshift(p);
        p = previous.get(key(p))!;
      }
      return path;
    }
    for (const d of [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ]) {
      const next = { x: current.x + d.x, y: current.y + d.y },
        cost = costs.get(key(current))! + 1;
      if (walkable(next, occupied) && cost < (costs.get(key(next)) ?? Infinity)) {
        costs.set(key(next), cost);
        previous.set(key(next), current);
        if (!open.some((p) => key(p) === key(next))) open.push(next);
      }
    }
  }
  return [];
}
