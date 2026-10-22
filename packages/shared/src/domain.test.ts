import { describe, expect, it } from 'vitest';
import {
  blockers,
  canAfford,
  distance,
  findPath,
  footprint,
  fromIso,
  gatheringError,
  initialNodes,
  key,
  placementError,
  terrain,
  toIso,
  walkable,
} from './index';
describe('deterministic world', () => {
  it('round trips every tile through isometric coordinates', () => {
    for (let x = 0; x < 38; x++)
      for (let y = 0; y < 38; y++) expect(fromIso(toIso({ x, y }))).toEqual({ x, y });
  });
  it('generates stable resources on land, outside spawn and roads', () => {
    expect(initialNodes()).toEqual(initialNodes());
    for (const node of initialNodes()) {
      expect(terrain(node.x, node.y)).not.toBe('water');
      expect(node.x).not.toBe(18);
      expect(node.y).not.toBe(18);
    }
  });
  it('finds adjacent, collision-free steps and rejects water', () => {
    const occupied = blockers(initialNodes(), []);
    const start = { x: 18, y: 18 };
    const path = findPath(start, { x: 18, y: 28 }, occupied);
    expect(path).toHaveLength(10);
    path.forEach((p, i) => {
      expect(distance(i ? path[i - 1] : start, p)).toBe(1);
      expect(walkable(p, occupied)).toBe(true);
    });
    expect(findPath(start, { x: 0, y: 0 }, occupied)).toEqual([]);
  });
  it('routes around obstacles without stepping diagonally', () => {
    const path = findPath({ x: 16, y: 16 }, { x: 16, y: 18 }, new Set(['16,17']));
    expect(path).toHaveLength(4);
    expect(path.map(key)).not.toContain('16,17');
  });
  it('checks full footprints, players, roads and affordability', () => {
    expect(footprint({ x: 20, y: 20 }, 'house')).toHaveLength(4);
    expect(placementError({ x: 20, y: 20 }, 'house', new Set(['21,21']), [])).toBeTruthy();
    expect(placementError({ x: 20, y: 20 }, 'house', new Set(), [{ x: 21, y: 20 }])).toBeTruthy();
    expect(placementError({ x: 18, y: 18 }, 'tower', new Set(), [])).toBeTruthy();
    expect(placementError({ x: 20, y: 20 }, 'house', new Set(), [])).toBeNull();
    expect(canAfford({ wood: 12, stone: 4 }, 'house')).toBe(true);
    expect(canAfford({ wood: 11, stone: 4 }, 'house')).toBe(false);
  });
  it('checks gathering range and depletion', () => {
    const node = initialNodes()[0];
    expect(gatheringError(node, undefined)).toBeTruthy();
    expect(gatheringError({ x: node.x + 1, y: node.y }, node)).toBeNull();
    expect(gatheringError({ x: node.x + 2, y: node.y }, node)).toBeTruthy();
    expect(gatheringError(node, { ...node, quantity: 0 })).toBeTruthy();
  });
});
