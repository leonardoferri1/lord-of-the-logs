import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module, Controller, Get, Post, Body, Req, Inject, HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { Store } from './store';
import { Simulation } from './simulation';
import { GameGateway } from './gateway';
import {
  sessionSchema,
  WORLD_SEED,
  WORLD_SIZE,
  WORLD_VERSION,
  RECIPES,
  REGIONS,
  QUESTS,
} from '@logs/shared';
import { inventoryOf } from './store';

@Controller('api')
class ApiController {
  private entries = new Map<string, { count: number; reset: number }>();
  constructor(@Inject(Store) private readonly store: Store) {}
  @Get('health') async health() {
    await this.store.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  }
  @Get('world') world() {
    return {
      title: 'Lord of the Logs',
      seed: WORLD_SEED,
      size: WORLD_SIZE,
      version: WORLD_VERSION,
      regions: REGIONS,
      recipes: RECIPES,
      quests: QUESTS,
    };
  }
  @Get('me') async me(@Req() request: Request) {
    const player = await this.store.authenticate(
      request.headers.authorization?.replace(/^Bearer /, ''),
    );
    if (!player) throw new HttpException('Sessão inválida.', 401);
    return { id: player.id, name: player.name, level: player.level, ...inventoryOf(player) };
  }
  @Post('sessions') async session(@Body() body: unknown, @Req() request: Request) {
    const now = Date.now(),
      ip = request.ip ?? 'unknown';
    for (const [key, entry] of this.entries) if (entry.reset < now) this.entries.delete(key);
    const entry = this.entries.get(ip) ?? { count: 0, reset: now + 60000 };
    if (++entry.count > 20) throw new HttpException('Muitas entradas. Tente em um minuto.', 429);
    this.entries.set(ip, entry);
    const parsed = sessionSchema.safeParse(body);
    if (!parsed.success)
      throw new HttpException('Use um nome de 2–20 letras, números ou espaços.', 400);
    return this.store.createSession(parsed.data.name);
  }
}
@Module({ controllers: [ApiController], providers: [Store, Simulation, GameGateway] })
class AppModule {}
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' });
  app.enableShutdownHooks();
  await app.init();
  await app.get(Simulation).start();
  await app.listen(Number(process.env.PORT || 3001), '0.0.0.0');
}
void bootstrap();
