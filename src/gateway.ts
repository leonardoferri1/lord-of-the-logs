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
import { pointSchema, gatherSchema, buildSchema } from '@logs/shared';
import { Simulation } from './simulation';

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
  private async action(socket: Socket, fn: () => void | Promise<void>) {
    try {
      await fn();
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
    return this.action(socket, () => {
      const a = this.simulation.agent(socket);
      const p = pointSchema.safeParse(body);
      if (!p.success) throw new Error('Destino inválido.');
      this.simulation.move(a, p.data);
    });
  }
  @SubscribeMessage('gather') gather(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    return this.action(socket, async () => {
      const a = this.simulation.agent(socket);
      const p = gatherSchema.safeParse(body);
      if (!p.success) throw new Error('Coleta inválida.');
      await this.simulation.gather(a, p.data.nodeId, p.data.actionId);
    });
  }
  @SubscribeMessage('build') build(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ) {
    return this.action(socket, async () => {
      const a = this.simulation.agent(socket);
      const p = buildSchema.safeParse(body);
      if (!p.success) throw new Error('Construção inválida.');
      await this.simulation.build(a, p.data);
    });
  }
  @SubscribeMessage('resync') resync(@ConnectedSocket() socket: Socket) {
    return this.action(socket, () => this.simulation.send(this.simulation.agent(socket)));
  }
}
