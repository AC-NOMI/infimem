import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer } from '../../src/http/server.js';
import { openDb } from '../../src/db/connection.js';
import { hashProvider } from '../helpers.js';
import type { Db } from '../../src/db/connection.js';

let dir: string;
let db: Db;
let baseUrl: string;
let servers: import('node:http').Server[] = [];

async function makeServer(token?: string): Promise<string> {
  const dbPath = join(dir, `http-${Math.random().toString(36).slice(2)}.db`);
  const d = openDb(dbPath);
  if (!db) db = d;
  const { server, url } = await startHttpServer(d, hashProvider, { port: 0, host: '127.0.0.1', token });
  servers.push(server);
  return url;
}

async function post(base: string, path: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'infimem-http-'));
});
afterAll(async () => {
  await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r()))));
});

describe('GET /health', () => {
  it('reports ok with provider info, no auth required', async () => {
    const base = await makeServer('secret-token');
    const res = await fetch(base + '/health');
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, name: 'infimem', provider: { name: 'hash', dim: 384 } });
  });
});

describe('POST /add + /search roundtrip', () => {
  it('stores through the real ingest pipeline and retrieves via the real search pipeline', async () => {
    const base = await makeServer();
    const added = await post(base, '/add', {
      content: 'backend deploys use pnpm',
      type: 'preference',
      keywords: ['pnpm'],
      scope: { project: 'aml' },
    });
    expect(added.status).toBe(200);
    expect(added.json).toMatchObject({ action: 'created' });
    expect(added.json.id).toBeDefined();

    const found = await post(base, '/search', { query: 'pnpm', k: 5, scope: { project: 'aml' } });
    expect(found.status).toBe(200);
    expect(found.json.results[0].content).toBe('backend deploys use pnpm');
    expect(found.json.results[0].scores.rrf).toBeGreaterThan(0);
    expect(found.json.trace.fused).toBeGreaterThan(0);
  });

  it('rejects invalid add payloads with 400 and the engine error message', async () => {
    const base = await makeServer();
    const r = await post(base, '/add', { content: '' });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('invalid remember input');
  });

  it('rejects malformed JSON bodies with 400', async () => {
    const base = await makeServer();
    const r = await post(base, '/add', '{not json');
    expect(r.status).toBe(400);
    expect(r.json.error).toBeDefined();
  });

  it('rejects invalid search payloads with 400', async () => {
    const base = await makeServer();
    const r = await post(base, '/search', { query: '' });
    expect(r.status).toBe(400);
  });
});

describe('bearer token enforcement', () => {
  it('returns 401 without or with wrong token, 200 with the right one', async () => {
    const base = await makeServer('secret-token');
    const noAuth = await post(base, '/add', { content: 'hello world note' });
    expect(noAuth.status).toBe(401);
    const wrongAuth = await post(base, '/add', { content: 'hello world note' }, 'wrong');
    expect(wrongAuth.status).toBe(401);
    const rightAuth = await post(base, '/add', { content: 'hello world note' }, 'secret-token');
    expect(rightAuth.status).toBe(200);
    expect(rightAuth.json.action).toBe('created');
  });
});

describe('routing', () => {
  it('returns 404 for unknown paths and 405 for wrong methods', async () => {
    const base = await makeServer();
    const notFound = await fetch(base + '/nope');
    expect(notFound.status).toBe(404);
    const badMethod = await fetch(base + '/search');
    expect(badMethod.status).toBe(405);
  });
});
