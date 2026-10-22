import type { AdminResult } from '@party/shared';
import { socket } from '../socket';

type UnoEventName = 'uno:play' | 'uno:draw' | 'uno:pass' | 'uno:callUno' | 'uno:catch' | 'uno:challenge';

/** Sends one UNO move and resolves with the server's verdict (never rejects). */
export function sendUno(event: UnoEventName, payload?: { cardId: number; color?: string }): Promise<AdminResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'No answer from the server' }), 6000);
    const done = (r: AdminResult) => {
      clearTimeout(timer);
      resolve(r);
    };
    const emit = socket.emit.bind(socket) as (...args: unknown[]) => void;
    if (payload) emit(event, payload, done);
    else emit(event, done);
  });
}
