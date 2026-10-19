import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db, Device } from './db.js';

declare module 'fastify' {
  interface FastifyRequest {
    device?: Device;
    authDurationMs?: number;
  }
}

export function extractToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  const q = (req.query as Record<string, unknown> | undefined)?.token;
  if (typeof q === 'string' && q) return q;
  const b = (req.body as Record<string, unknown> | undefined)?.token;
  if (typeof b === 'string' && b) return b;
  return null;
}

export function makeAuth(db: Db, opts: { kinds?: ('app' | 'quick')[] } = {}) {
  const kinds = opts.kinds ?? ['app'];
  return async function auth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const started=performance.now();
    const token = extractToken(req);
    if (!token) {
      reply.code(401).send({ error: 'missing token' });
      return;
    }
    if (/^[A-Z0-9]{4}-?[A-Z0-9]{4}-?[A-Z0-9]{4}$/i.test(token)) {
      reply.code(401).send({ error: 'this is the connection code, not a device key' });
      return;
    }
    const device = db.findDevice(token);
    if (!device || !kinds.includes(device.kind)) {
      reply.code(401).send({ error: 'invalid or revoked token' });
      return;
    }
    db.touchDevice(device.id);
    req.device = device;
    req.authDurationMs=performance.now()-started;
  };
}

export function makeAdminAuth(secret: string) {
  return async function adminAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const given = (req.headers['x-admin-secret'] as string | undefined) ?? '';
    if (!secret || given !== secret) {
      reply.code(403).send({ error: 'admin secret required' });
    }
  };
}
