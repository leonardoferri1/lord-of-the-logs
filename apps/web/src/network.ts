import { io, type Socket } from 'socket.io-client';
import type { ClientEvents, ServerEvents, Point, BuildingKind } from '@logs/shared';
import { useWorld } from './state';
export const API = import.meta.env.VITE_API_URL || '';
let socket: Socket<ServerEvents, ClientEvents> | undefined;
export function connect(token: string) {
  socket?.disconnect();
  socket = io(API || undefined, { auth: { token }, reconnection: true, reconnectionDelay: 1000 });
  socket.on('snapshot', (snapshot) =>
    useWorld.getState().set({ snapshot, connected: true, entered: true }),
  );
  socket.on('disconnect', () => useWorld.getState().set({ connected: false }));
  socket.on('connect_error', () => {
    useWorld.getState().set({ connected: false });
    useWorld.getState().notify('Conexão interrompida. Tentando reconectar ao vale…', true);
  });
  socket.on('result', (result) => useWorld.getState().notify(result.message, !result.ok));
  socket.on('activity', (message) => useWorld.getState().notify(message));
}
export function move(p: Point) {
  if (socket?.connected) socket.emit('move', p);
}
export function gather(nodeId: string) {
  if (socket?.connected) socket.emit('gather', { nodeId, actionId: crypto.randomUUID() });
}
export function build(p: Point, kind: BuildingKind) {
  if (socket?.connected) socket.emit('build', { ...p, kind, actionId: crypto.randomUUID() });
}
export function logout() {
  socket?.disconnect();
  sessionStorage.removeItem('logs:token');
  useWorld.getState().set({ entered: false, snapshot: null, connected: false });
}
