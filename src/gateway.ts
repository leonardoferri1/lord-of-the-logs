import { Inject, Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Socket } from 'socket.io';
import {
  pointSchema,
  gatherSchema,
  buildSchema,
  attackSchema,
  interactSchema,
  upgradeSchema,
  tradeSchema,
  eatSchema,
  claimSchema,
  chatSchema,
} from '@logs/shared';
import { Simulation } from './simulation';

type Schema<T> = { safeParse(body: unknown): { success: true; data: T } | { success: false } };

@WebSocketGateway({
  cors: { origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' },
  maxHttpBufferSize: 4096,
})
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(GameGateway.name);
  constructor(@Inject(Simulation) private readonly simulation: Simulation) {}
  async handleConnection(socket: Socket) {
    try {
      await this.simulation.join(socket, socket.handshake.auth.token);
    } catch {
      socket.emit('result', { ok: false, message: 'Sessão inválida ou servidor indisponível.' });
      socket.disconnect(true);
    }
  }
  async handleDisconnect(socket: Socket) {
    try {
      await this.simulation.leave(socket);
    } catch (error) {
      this.logger.error(error);
    }
  }
  /** Authenticates, rate limits and strictly parses one intention before handing it over. */
  private async action<T>(
    socket: Socket,
    body: unknown,
    schema: Schema<T>,
    invalid: string,
    fn: (agent: ReturnType<Simulation['agent']>, data: T) => void | Promise<void>,
  ) {
    try {
      const agent = this.simulation.agent(socket);
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new Error(invalid);
      await fn(agent, parsed.data);
    } catch (error) {
      socket.emit('result', {
        ok: false,
        message:
          error instanceof Error && !error.message.includes('prisma')
            ? error.message
            : 'Não foi possível concluir a ação. Tente novamente.',
      });
    }
  }
  @SubscribeMessage('move') move(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    return this.action(socket, body, pointSchema, 'Destino inválido.', (a, p) =>
      this.simulation.move(a, p),
    );
  }
  @SubscribeMessage('gather') gather(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    return this.action(socket, body, gatherSchema, 'Coleta inválida.', (a, p) =>
      this.simulation.gather(a, p.nodeId, p.actionId),
    );
  }
  @SubscribeMessage('build') build(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    return this.action(socket, body, buildSchema, 'Construção inválida.', (a, p) =>
      this.simulation.build(a, p),
    );
  }
  @SubscribeMessage('attack') attack(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    return this.action(socket, body, attackSchema, 'Alvo inválido.', (a, p) =>
      this.simulation.attack(a, p.mobId),
    );
  }
  @SubscribeMessage('interact') interact(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    return this.action(socket, body, interactSchema, 'Interação inválida.', (a, p) =>
      this.simulation.interact(a, p.buildingId, p.actionId),
    );
  }
  @SubscribeMessage('upgrade') upgrade(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    return this.action(socket, body, upgradeSchema, 'Ferramenta inválida.', (a, p) =>
      this.simulation.upgrade(a, p.tool, p.actionId),
    );
  }
  @SubscribeMessage('trade') trade(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    return this.action(socket, body, tradeSchema, 'Negociação inválida.', (a, p) =>
      this.simulation.trade(a, p),
    );
  }
  @SubscribeMessage('eat') eat(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    return this.action(socket, body, eatSchema, 'Ação inválida.', (a, p) =>
      this.simulation.eat(a, p.actionId),
    );
  }
  @SubscribeMessage('claim') claim(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    return this.action(socket, body, claimSchema, 'Missão inválida.', (a, p) =>
      this.simulation.claim(a, p.questId, p.actionId),
    );
  }
  @SubscribeMessage('chat') chat(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    return this.action(socket, body, chatSchema, 'Mensagem inválida (1–140 caracteres).', (a, p) =>
      this.simulation.say(a, p.text),
    );
  }
  @SubscribeMessage('stop') stop(@ConnectedSocket() socket: Socket) {
    return this.action(socket, undefined, eatSchema.optional(), 'Ação inválida.', (a) =>
      this.simulation.stop(a),
    );
  }
  @SubscribeMessage('resync') resync(@ConnectedSocket() socket: Socket) {
    return this.action(socket, undefined, eatSchema.optional(), 'Ação inválida.', (a) => {
      a.sentRevision = -1;
      this.simulation.send(a);
    });
  }
}
