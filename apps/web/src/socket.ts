import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@party/shared';

// Connects only after sign-in (the session cookie authenticates the handshake).
// Socket.IO reconnects by itself; the server re-sends a full `sync` every time.
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
  autoConnect: false,
  // Polling first is the most forgiving on flaky phone browsers; it upgrades if it can.
  transports: ['polling', 'websocket'],
});
