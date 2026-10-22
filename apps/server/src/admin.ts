import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;

const strip = (ip: string) => ip.replace(/^::ffff:/, '');

/** True for the host machine itself: loopback, or the server's own LAN address (laptop opening its own IP). */
export function isLocalAddress(remote: string | undefined, local: string | undefined): boolean {
  if (!remote) return false;
  const r = strip(remote);
  return r === '127.0.0.1' || r === '::1' || (!!local && r === strip(local));
}

/**
 * Headers a tunnel or reverse proxy (Cloudflare Tunnel, ngrok, Tailscale Funnel, nginx) adds. Their traffic reaches
 * us from the laptop itself (127.0.0.1), so the address alone would wrongly look "local". Any of these means the
 * request came from outside. A genuine local browser never sends them.
 */
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'true-client-ip'];
export function looksProxied(headers: Record<string, string | string[] | undefined>): boolean {
  return PROXY_HEADERS.some((h) => headers[h] !== undefined);
}

/** Compares in constant time regardless of length. */
export function passwordMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** In-memory admin sessions: a server restart signs the host out, which is fine for one laptop. */
export class AdminSessions {
  private tokens = new Map<string, number>();

  start(): string {
    const token = randomBytes(24).toString('base64url');
    this.tokens.set(token, Date.now() + ADMIN_TTL_MS);
    return token;
  }
  valid(token: string | undefined): boolean {
    if (!token) return false;
    const exp = this.tokens.get(token);
    if (!exp) return false;
    if (exp < Date.now()) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }
  end(token: string | undefined) {
    if (token) this.tokens.delete(token);
  }
}

/** Blocks a key for a minute after 5 wrong tries. Used for admin password and player PINs. */
export class Throttle {
  private fails = new Map<string, { n: number; until: number }>();
  constructor(private max = 5, private lockMs = 60_000) {}

  locked(key: string): boolean {
    const f = this.fails.get(key);
    return !!f && f.until > Date.now();
  }
  fail(key: string) {
    const n = (this.fails.get(key)?.n ?? 0) + 1;
    const locking = n >= this.max;
    this.fails.set(key, { n, until: locking ? Date.now() + this.lockMs : 0 });
    if (locking) setTimeout(() => this.fails.delete(key), this.lockMs).unref();
  }
  clear(key: string) {
    this.fails.delete(key);
  }
}
