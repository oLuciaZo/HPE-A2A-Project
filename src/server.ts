import type { Server } from 'node:http';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { hub } from './hub.js';
import { runQuestion } from './orchestrator.js';
import type { StampedEvent } from './types.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const digest = (s: string) => createHash('sha256').update(s).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/** HTTP basic auth with one shared password (any username). Off when no password is set. */
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.password) return next();
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    if (safeEqual(pass, config.password)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="A2A twin", charset="UTF-8"').status(401).send('Authentication required');
}

export function startServer(): Promise<Server> {
  const app = express();
  app.disable('x-powered-by');

  // Unauthenticated, for load balancers and uptime checks. Reveals nothing.
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:",
    });
    next();
  });
  app.use(requireAuth);
  app.use(express.json({ limit: '4kb' }));

  app.get('/api/config', (_req, res) => {
    res.json({ mock: config.mock, model: config.mock ? null : config.model });
  });

  app.post('/api/ask', (req, res) => {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (question.length < 3 || question.length > 500) {
      res.status(400).json({ error: 'question must be 3 to 500 characters' });
      return;
    }
    if (hub.activeCount() >= config.maxConcurrentRuns) {
      res.status(429).json({ error: 'The team is busy with other questions. Try again in a moment.' });
      return;
    }
    const runId = hub.create(question);
    void runQuestion(runId, question);
    res.status(202).json({ runId });
  });

  app.get('/api/runs/:id', (req, res) => {
    const snap = hub.snapshot(req.params.id);
    if (!snap) {
      res.status(404).json({ error: 'run not found' });
      return;
    }
    res.json(snap);
  });

  app.get('/api/runs/:id/events', (req, res) => {
    const id = req.params.id;
    if (!hub.has(id)) {
      res.status(404).json({ error: 'run not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const lastId = Number(req.header('last-event-id') ?? 0) || 0;
    const send = (e: StampedEvent) => {
      res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
      if (e.type === 'run.report' || e.type === 'run.error') res.end();
    };
    const unsubscribe = hub.subscribe(id, send, lastId);
    const beat = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(beat);
      unsubscribe?.();
    });
  });

  app.use(express.static(publicDir));

  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => {
      console.log(`[web] dashboard on http://${config.host}:${config.port}${config.password ? ' (password protected)' : ''}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}
