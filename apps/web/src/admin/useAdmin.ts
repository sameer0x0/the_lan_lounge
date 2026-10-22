import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { AdminResult, AdminState, ClientToServerEvents, ServerToClientEvents } from '@party/shared';

type AdminSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type AdminEvent = Extract<keyof ClientToServerEvents, `admin:${string}`>;
/** The payload an admin event takes, or `undefined` for events that only take an ack (skip, end...). */
type Payload<E extends AdminEvent> = Parameters<ClientToServerEvents[E]> extends [infer P, unknown] ? P : undefined;

/** Connects the admin socket (authenticated by the admin cookie) and keeps the latest AdminState. */
export function useAdmin(onUnauthorized: () => void) {
  const [state, setState] = useState<AdminState | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<AdminSocket | null>(null);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

  useEffect(() => {
    const socket: AdminSocket = io({ transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('admin:state', setState);
    socket.on('connect_error', (e) => e.message === 'unauthorized' && unauthorized.current());
    return () => void socket.disconnect();
  }, []);

  /** Sends one admin command and resolves with the server's verdict. */
  const send = useCallback(
    <E extends AdminEvent>(event: E, ...args: Payload<E> extends undefined ? [] : [Payload<E>]) =>
      new Promise<AdminResult>((resolve) => {
        const socket = socketRef.current;
        if (!socket) return resolve({ ok: false, error: 'Not connected' });
        const emit = socket.emit.bind(socket) as (...a: unknown[]) => void;
        emit(event, ...args, resolve);
      }),
    [],
  );

  return { state, connected, send };
}
