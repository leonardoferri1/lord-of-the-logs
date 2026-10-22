import Phaser from 'phaser';
import {
  toIso,
  fromIso,
  terrain,
  WORLD_SIZE,
  initialNodes,
  noise,
  blockers,
  placementError,
  footprint,
  distance,
  findPath,
  type Point,
  type Snapshot,
} from '@logs/shared';
import { createArt } from './art';
import { useWorld } from '../state';
import { move, build } from '../network';

export class WorldScene extends Phaser.Scene {
  private ground!: Phaser.GameObjects.Graphics;
  private highlight!: Phaser.GameObjects.Graphics;
  private nodes = new Map<string, Phaser.GameObjects.Image>();
  private structures = new Map<string, Phaser.GameObjects.Image>();
  private people = new Map<
    string,
    { sprite: Phaser.GameObjects.Image; label: Phaser.GameObjects.Text }
  >();
  private lastSnapshot: Snapshot | null = null;
  private focusRevision = -1;
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private panOrigin?: { x: number; y: number; scrollX: number; scrollY: number };
  constructor() {
    super('valley');
  }
  create() {
    createArt(this);
    this.cameras.main.setBackgroundColor('#102c31');
    this.ground = this.add.graphics();
    this.highlight = this.add.graphics().setDepth(10000);
    this.drawTerrain();
    for (const node of initialNodes()) this.drawNode(node.id, node.x, node.y, node.kind, true);
    // A public village landmark is scenery, not a player-owned economic structure.
    const inn = toIso({ x: 18, y: 14 });
    this.add
      .image(inn.x, inn.y, 'house')
      .setOrigin(0.5, 0.84)
      .setDepth(inn.y + 4)
      .setScale(1.1);
    this.add
      .text(inn.x, inn.y - 118, 'POUSADA DO PRIMEIRO TRONCO', {
        fontFamily: 'Georgia',
        fontSize: '10px',
        color: '#f5ddaa',
        backgroundColor: '#132820dd',
        padding: { x: 9, y: 5 },
      })
      .setOrigin(0.5)
      .setDepth(inn.y + 5);
    for (const p of [
      { x: 16, y: 18 },
      { x: 21, y: 18 },
      { x: 18, y: 23 },
      { x: 25, y: 18 },
    ]) {
      const t = toIso(p);
      const glow = this.add.circle(t.x, t.y - 20, 30, 0xffb754, 0.07).setDepth(t.y + 1);
      this.tweens.add({
        targets: glow,
        alpha: 0.35,
        scale: 1.3,
        duration: 1300 + p.x * 17,
        yoyo: true,
        repeat: -1,
      });
      this.add.image(t.x, t.y, 'torch').setOrigin(0.5, 0.9).setDepth(t.y);
    }
    for (let i = 0; i < 22; i++) {
      const p = toIso({ x: 8 + noise(i, 1) * 19, y: 8 + noise(i, 2) * 19 });
      const dot = this.add.circle(p.x, p.y - 30, 1.5, 0xf9d386, 0.6).setDepth(3000);
      this.tweens.add({
        targets: dot,
        x: p.x + 35,
        y: p.y - 70,
        alpha: 0,
        duration: 3000 + i * 130,
        yoyo: true,
        repeat: -1,
      });
    }
    this.center({ x: 18, y: 18 });
    this.cameras.main.setZoom(this.scale.width < 700 ? 0.9 : 1.1);
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.input.mouse?.disableContextMenu();
    this.input.on('wheel', (_p: Phaser.Input.Pointer, _o: unknown, _x: number, dy: number) =>
      this.cameras.main.setZoom(Phaser.Math.Clamp(this.cameras.main.zoom - dy * 0.001, 0.6, 2)),
    );
    this.input.on(
      'pointerdown',
      (p: Phaser.Input.Pointer, objects: Phaser.GameObjects.GameObject[]) => {
        if (p.rightButtonDown()) {
          this.panOrigin = {
            x: p.x,
            y: p.y,
            scrollX: this.cameras.main.scrollX,
            scrollY: this.cameras.main.scrollY,
          };
          return;
        }
        const state = useWorld.getState();
        if (!state.connected) return;
        const hit = objects.find((o) => o.getData('tile'))?.getData('tile') as Point | undefined;
        const tile =
          !state.buildKind && hit ? hit : fromIso(this.cameras.main.getWorldPoint(p.x, p.y));
        if (tile.x < 0 || tile.y < 0 || tile.x >= WORLD_SIZE || tile.y >= WORLD_SIZE) return;
        if (state.buildKind) {
          build(tile, state.buildKind);
          return;
        }
        const snapshot = state.snapshot!;
        const node = snapshot.nodes.find((n) => n.x === tile.x && n.y === tile.y);
        const building = snapshot.buildings.find((b) =>
          footprint(b, b.kind).some((t) => t.x === tile.x && t.y === tile.y),
        );
        state.set({ selected: node?.id ?? building?.id ?? null });
        if (node) {
          const self = snapshot.players.find((p) => p.id === snapshot.selfId)!;
          const occupied = blockers(snapshot.nodes, snapshot.buildings);
          const choices = [
            { x: node.x + 1, y: node.y },
            { x: node.x - 1, y: node.y },
            { x: node.x, y: node.y + 1 },
            { x: node.x, y: node.y - 1 },
          ]
            .map((p) => ({ p, path: findPath(self, p, occupied) }))
            .filter((c) => c.path.length)
            .sort((a, b) => a.path.length - b.path.length);
          if (distance(self, node) > 1 && choices[0]) move(choices[0].p);
        } else if (!building) move(tile);
      },
    );
    this.input.on('pointerup', () => {
      this.panOrigin = undefined;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.panOrigin) {
        this.cameras.main.scrollX =
          this.panOrigin.scrollX - (p.x - this.panOrigin.x) / this.cameras.main.zoom;
        this.cameras.main.scrollY =
          this.panOrigin.scrollY - (p.y - this.panOrigin.y) / this.cameras.main.zoom;
      }
      useWorld.getState().set({ hover: fromIso(this.cameras.main.getWorldPoint(p.x, p.y)) });
    });
  }
  private center(p: Point) {
    const iso = toIso(p);
    this.cameras.main.centerOn(iso.x, iso.y - 30);
  }
  private diamond(p: Point, color: number, alpha = 1, outline = false) {
    const iso = toIso(p);
    const g = outline ? this.highlight : this.ground;
    const points = [
      { x: iso.x, y: iso.y - 16 },
      { x: iso.x + 32, y: iso.y },
      { x: iso.x, y: iso.y + 16 },
      { x: iso.x - 32, y: iso.y },
    ];
    g.fillStyle(color, alpha);
    g.fillPoints(points, true);
    if (outline) {
      g.lineStyle(1.5, color, 0.9);
      g.strokePoints(points, true);
    }
  }
  private drawTerrain() {
    const colors = {
      grass: [0x537545, 0x587b48, 0x5e804b],
      forest: [0x3d6240, 0x456b40, 0x4c6d3d],
      dirt: [0xa08755, 0xaa925f, 0x97814e],
      stone: [0x657557, 0x6e7d5e, 0x72815f],
      water: [0x1b5058, 0x205860, 0x245d63],
    };
    for (let y = 0; y < WORLD_SIZE; y++)
      for (let x = 0; x < WORLD_SIZE; x++) {
        const t = terrain(x, y),
          iso = toIso({ x, y }),
          n = noise(x, y, 88);
        this.diamond({ x, y }, colors[t][Math.floor(n * 3)]);
        if (t === 'water') {
          this.ground.lineStyle(1, 0x67a49a, 0.25);
          this.ground.lineBetween(iso.x - 12, iso.y + 2, iso.x + 5, iso.y + 2);
          if (noise(x, y, 18) > 0.8) {
            this.ground.fillStyle(0x6b9064, 0.8);
            this.ground.fillEllipse(iso.x + 9, iso.y - 4, 11, 5);
          }
        } else {
          for (let j = 0; j < 3; j++) {
            this.ground.fillStyle(t === 'dirt' ? 0x5c633d : 0x8ca65b, 0.35);
            this.ground.fillEllipse(
              iso.x + noise(x + j, y, 25) * 32 - 16,
              iso.y + noise(x, y + j, 27) * 12 - 6,
              3,
              2,
            );
          }
          if (t === 'grass' && n > 0.7) {
            this.ground.fillStyle(0xe9c174, 0.8);
            this.ground.fillCircle(iso.x + 6, iso.y - 3, 1.5);
          }
        }
      }
    // Timber bridge over the river on the public road.
    for (let x = 23; x <= 27; x++) {
      this.diamond({ x, y: 18 }, 0x9d7948);
      const p = toIso({ x, y: 18 });
      this.ground.lineStyle(2, 0x654c32);
      this.ground.lineBetween(p.x - 24, p.y + 4, p.x + 24, p.y - 4);
    }
  }
  private drawNode(id: string, x: number, y: number, kind: string, alive: boolean) {
    const p = toIso({ x, y }),
      texture = alive ? (kind === 'wood' ? `tree${Math.floor(noise(x, y) * 4)}` : 'rock') : 'stump';
    const image = this.nodes.get(id);
    if (image) image.setTexture(texture).setAlpha(alive ? 1 : 0.7);
    else
      this.nodes.set(
        id,
        this.add
          .image(p.x, p.y, texture)
          .setOrigin(0.5, kind === 'wood' ? 0.86 : 0.75)
          .setDepth(p.y)
          .setScale(kind === 'wood' ? 0.85 : 1)
          .setData('tile', { x, y })
          .setInteractive({ pixelPerfect: true, alphaTolerance: 128 }),
      );
  }
  update(time: number, delta: number) {
    const state = useWorld.getState(),
      snapshot = state.snapshot;
    if (this.focusRevision !== state.focus) {
      this.focusRevision = state.focus;
      this.center(snapshot?.players.find((p) => p.id === snapshot.selfId) ?? { x: 18, y: 18 });
    }
    const camera = this.cameras.main,
      speed = (delta * 0.45) / camera.zoom;
    if (this.cursors?.left.isDown) camera.scrollX -= speed;
    if (this.cursors?.right.isDown) camera.scrollX += speed;
    if (this.cursors?.up.isDown) camera.scrollY -= speed;
    if (this.cursors?.down.isDown) camera.scrollY += speed;
    if (snapshot && snapshot !== this.lastSnapshot) {
      this.lastSnapshot = snapshot;
      for (const node of snapshot.nodes)
        this.drawNode(node.id, node.x, node.y, node.kind, node.quantity > 0);
      for (const b of snapshot.buildings)
        if (!this.structures.has(b.id)) {
          const p = toIso(b);
          this.structures.set(
            b.id,
            this.add
              .image(p.x, p.y + 16, b.kind)
              .setOrigin(0.5, 0.84)
              .setDepth(p.y + 32)
              .setData('tile', { x: b.x, y: b.y })
              .setInteractive({ pixelPerfect: true, alphaTolerance: 128 }),
          );
        }
      for (const [id, objects] of this.people)
        if (!snapshot.players.some((p) => p.id === id)) {
          objects.sprite.destroy();
          objects.label.destroy();
          this.people.delete(id);
        }
    }
    if (snapshot)
      for (const p of snapshot.players) {
        let objects = this.people.get(p.id);
        const iso = toIso(p);
        if (!objects) {
          objects = {
            sprite: this.add.image(iso.x, iso.y, 'peasant0').setOrigin(0.5, 0.88),
            label: this.add
              .text(iso.x, iso.y - 57, p.name, {
                fontFamily: 'Georgia',
                fontSize: '12px',
                color: p.id === snapshot.selfId ? '#ffe0a0' : '#e3eee3',
                backgroundColor: '#14251cbb',
                padding: { x: 5, y: 3 },
              })
              .setOrigin(0.5),
          };
          this.people.set(p.id, objects);
        }
        const moving = Math.hypot(objects.sprite.x - iso.x, objects.sprite.y - iso.y) > 0.6;
        const factor = 1 - Math.exp(-delta / 85);
        objects.sprite.x += (iso.x - objects.sprite.x) * factor;
        objects.sprite.y += (iso.y - objects.sprite.y) * factor;
        objects.sprite
          .setTexture(`peasant${moving || p.gathering ? 1 + (Math.floor(time / 160) % 2) : 0}`)
          .setFlipX(p.facing < 0)
          .setDepth(objects.sprite.y + 5);
        objects.label
          .setPosition(objects.sprite.x, objects.sprite.y - 65)
          .setDepth(objects.sprite.y + 6);
      }
    this.highlight.clear();
    if (state.hover && state.connected) {
      const cells = state.buildKind ? footprint(state.hover, state.buildKind) : [state.hover];
      const invalid =
        state.buildKind &&
        snapshot &&
        placementError(
          state.hover,
          state.buildKind,
          blockers(snapshot.nodes, snapshot.buildings),
          snapshot.players,
        );
      for (const tile of cells)
        this.diamond(tile, invalid ? 0xf08266 : state.buildKind ? 0xc8eaa1 : 0xf7d99a, 0.22, true);
    }
  }
}
