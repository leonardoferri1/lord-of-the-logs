import Phaser from 'phaser';
/** Original vector-painted sprites, baked once into reusable GPU textures. No external assets. */
export function createArt(scene: Phaser.Scene) {
  const g = scene.make.graphics({ x: 0, y: 0 });
  const poly = (points: number[], color: number, alpha = 1) => {
    g.fillStyle(color, alpha);
    g.fillPoints(
      points.reduce<Phaser.Geom.Point[]>(
        (a, _, i) => (i % 2 ? a : [...a, new Phaser.Geom.Point(points[i], points[i + 1])]),
        [],
      ),
      true,
    );
  };
  const rect = (x: number, y: number, w: number, h: number, c: number) => {
    g.fillStyle(c);
    g.fillRect(x, y, w, h);
  };
  const ellipse = (x: number, y: number, w: number, h: number, c: number, a = 1) => {
    g.fillStyle(c, a);
    g.fillEllipse(x, y, w, h);
  };
  const bake = (name: string, w: number, h: number) => {
    g.generateTexture(name, w, h);
    g.clear();
  };
  for (let variant = 0; variant < 4; variant++) {
    ellipse(48, 110, 67, 23, 0x091f18, 0.3);
    poly([44, 108, 43, 67, 53, 63, 57, 110, 49, 115], 0x61402b);
    poly([47, 105, 49, 73, 52, 76, 53, 109], 0xad7c40);
    poly([48, 92, 27, 73, 30, 67, 50, 81, 67, 61, 70, 65, 53, 91], 0x68482d);
    const colors =
      variant === 3
        ? [0x455c27, 0x6b7a31, 0x91a346, 0xb2ba57]
        : [0x183d30, 0x286044, 0x3e7d4a, 0x64a35d];
    for (const [x, y, r, c] of [
      [28, 65, 25, 0],
      [67, 60, 24, 0],
      [46, 48, 33, 1],
      [24, 48, 21, 1],
      [66, 36, 24, 1],
      [44, 26, 24, 2],
      [26, 39, 16, 2],
      [60, 40, 17, 2],
      [41, 17, 13, 3],
      [29, 34, 8, 3],
      [58, 31, 9, 3],
    ]) {
      g.fillStyle(colors[c]);
      g.fillCircle(x, y, r);
    }
    for (let i = 0; i < 18; i++) {
      const x = 17 + ((i * 19 + variant * 7) % 60),
        y = 25 + ((i * 13) % 40);
      ellipse(x, y, 5, 3, colors[3], 0.35);
    }
    bake(`tree${variant}`, 96, 128);
  }
  ellipse(32, 48, 56, 20, 0x0a201b, 0.3);
  poly([7, 39, 15, 19, 29, 12, 47, 19, 57, 40, 41, 51, 21, 49], 0x58686a);
  poly([7, 39, 15, 19, 29, 12, 34, 30, 21, 49], 0x879591);
  poly([29, 12, 47, 19, 57, 40, 34, 30], 0xabb3a1);
  poly([34, 30, 57, 40, 41, 51, 21, 49], 0x697b78);
  poly([15, 21, 27, 17, 30, 25, 19, 29], 0xc2c8b0);
  bake('rock', 64, 64);
  ellipse(24, 24, 35, 12, 0x162920, 0.3);
  rect(11, 10, 25, 14, 0x775330);
  ellipse(23, 10, 25, 12, 0xb38a4c);
  ellipse(23, 10, 15, 7, 0x79552f);
  bake('stump', 48, 32);
  for (const kind of ['house', 'lumber', 'storage', 'tower']) {
    const tower = kind === 'tower',
      roofY = tower ? 24 : 55,
      bottom = 148;
    ellipse(96, 149, 161, 40, 0x0b201b, 0.28);
    poly([32, 104, 98, 71, 158, 104, 96, 141], 0xa27c47);
    poly([32, 104, 96, 137, 96, bottom + 17, 32, 130], 0x6e4a2c);
    poly([96, 137, 158, 104, 158, 131, 96, bottom + 17], 0x9e7040);
    poly(
      [40, roofY + 40, 96, roofY + 67, 96, 150, 40, 120],
      kind === 'storage' ? 0x67766b : 0x946133,
    );
    poly(
      [96, roofY + 67, 150, roofY + 40, 150, 121, 96, 150],
      kind === 'storage' ? 0x8d9580 : 0xc38b47,
    );
    for (let y = roofY + 48; y < 125; y += 10) {
      g.lineStyle(2, 0x452e20, 0.65);
      g.lineBetween(41, y, 95, y + 26);
      g.lineBetween(97, y + 26, 149, y);
    }
    poly([29, roofY + 43, 83, roofY - 3, 110, roofY + 12, 96, roofY + 79], 0x4a3530);
    poly(
      [83, roofY - 3, 157, roofY + 29, 166, roofY + 49, 96, roofY + 79],
      kind === 'lumber' ? 0x6c7545 : 0x9c552f,
    );
    for (let i = 0; i < 5; i++) {
      g.lineStyle(2, 0x382f28, 0.6);
      g.lineBetween(87 + i * 13, roofY + 1 + i * 6, 100 + i * 13, roofY + 72 - i * 6);
    }
    g.lineStyle(4, 0xd0934e);
    g.lineBetween(83, roofY - 3, 157, roofY + 29);
    poly([108, 119, 126, 110, 126, 135, 108, 144], 0x3e3025);
    poly([53, 97, 72, 106, 72, 123, 53, 114], 0xffc86b);
    g.lineStyle(2, 0x523823);
    g.lineBetween(62, 101, 62, 118);
    g.lineBetween(53, 106, 72, 115);
    poly([132, 92, 143, 87, 143, 103, 132, 109], 0xffd47d);
    rect(131, roofY + 4, 11, 23, 0x68746b);
    rect(129, roofY + 1, 15, 7, 0x919582);
    if (tower) {
      rect(83, 4, 3, 22, 0xbca06b);
      poly([86, 4, 112, 7, 104, 15, 86, 13], 0xcb6245);
    }
    if (kind === 'lumber') {
      for (let i = 0; i < 3; i++) {
        rect(16 + i * 8, 131 + i * 4, 32, 9, 0x74492b);
        ellipse(48 + i * 8, 135 + i * 4, 8, 10, 0xe0b36b);
      }
    }
    if (kind === 'storage') {
      poly([128, 143, 143, 122, 162, 130, 170, 148, 148, 157], 0x9ca495);
    }
    bake(kind, 192, 184);
  }
  for (let frame = 0; frame < 3; frame++) {
    ellipse(24, 56, 27, 10, 0x0a211b, 0.35);
    rect(16, 43, 7, 11 + (frame === 1 ? -3 : 0), 0x342f29);
    rect(26, 43, 7, 11 + (frame === 2 ? -3 : 0), 0x342f29);
    rect(13, 51 + (frame === 1 ? -3 : 0), 11, 5, 0x514633);
    rect(26, 51 + (frame === 2 ? -3 : 0), 11, 5, 0x514633);
    poly([14, 25, 33, 25, 37, 44, 11, 44], 0x267e87);
    rect(14, 39, 20, 5, 0x593f2b);
    rect(23, 39, 5, 5, 0xe7bc65);
    rect(9, 29 + frame, 6, 13, 0xe0aa6d);
    rect(33, 28 - frame, 6, 13, 0xe0aa6d);
    ellipse(24, 18, 22, 25, 0xd8a16a);
    ellipse(24, 8, 27, 13, 0x5f422e);
    rect(12, 9, 6, 14, 0x5f422e);
    rect(32, 10, 5, 10, 0x5f422e);
    rect(24, 17, 3, 3, 0x283731);
    rect(32, 17, 2, 3, 0x283731);
    rect(25, 25, 8, 2, 0x7d4c2e);
    bake(`peasant${frame}`, 48, 64);
  }
  ellipse(16, 43, 25, 12, 0x152a21, 0.3);
  rect(14, 20, 4, 25, 0x6b492d);
  ellipse(16, 18, 15, 24, 0xe78635);
  ellipse(16, 15, 9, 19, 0xffcc65);
  ellipse(16, 18, 4, 10, 0xffebad);
  bake('torch', 32, 48);
  g.destroy();
}
