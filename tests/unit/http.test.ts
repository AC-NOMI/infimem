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

const competitionAddBody = (request_id = 'eval:run1:locomo_refined:conv-0:chunk-0') => ({
  request_id,
  messages: [
    { role: 'user', timestamp: 1704067200000, content: '偏好:部署用 pnpm' },
    { role: 'assistant', content: '好的,记住了' },
  ],
  user_id: 'eval:run1:locomo:conv-0',
  session_id: 'eval:run1:sample:0',
});

describe('POST /add(竞赛契约)+ /search', () => {
  it('accepts the competition contract, echoes request_id, and stores via the real pipeline', async () => {
    const d = openDb(join(dir, `contract-${Math.random().toString(36).slice(2)}.db`));
    const { server, url: base } = await startHttpServer(d, hashProvider, { port: 0, host: '127.0.0.1' });
    servers.push(server);
    const added = await post(base, '/add', competitionAddBody());
    expect(added.status).toBe(200);
    expect(added.json).toMatchObject({
      success: true,
      request_id: 'eval:run1:locomo_refined:conv-0:chunk-0',
      user_id: 'eval:run1:locomo:conv-0',
      session_id: 'eval:run1:sample:0',
    });
    // user_id 是隔离边界,session 记到来源引用
    const mem = d.prepare('SELECT scope_user, scope_project, scope_session, source_ref FROM memories LIMIT 1').get() as any;
    expect(mem.scope_user).toBe('eval:run1:locomo:conv-0');
    expect(mem.scope_session).toBeNull();
    expect(mem.source_ref).toBe('session:eval:run1:sample:0');
    d.close();
  });

  it('is idempotent: retrying the same request_id writes nothing new', async () => {
    const d = openDb(join(dir, `idem-${Math.random().toString(36).slice(2)}.db`));
    const { server, url: base } = await startHttpServer(d, hashProvider, { port: 0, host: '127.0.0.1' });
    servers.push(server);
    const first = await post(base, '/add', competitionAddBody());
    const second = await post(base, '/add', competitionAddBody());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ success: true, request_id: first.json.request_id });
    expect((d.prepare('SELECT count(*) c FROM memories').get() as any).c).toBe(2);
    d.close();
  });

  it('search by user_id crosses sessions and returns official data shape', async () => {
    const base = await makeServer();
    await post(base, '/add', competitionAddBody());
    const found = await post(base, '/search', { user_id: 'eval:run1:locomo:conv-0', query: 'pnpm', top_k: 100 });
    expect(found.status).toBe(200);
    expect(Array.isArray(found.json.data)).toBe(true);
    const hit = found.json.data.find((x: any) => x.content.includes('pnpm'));
    expect(hit).toBeDefined();
    expect(hit.id).toBeDefined();
    expect(typeof hit.score).toBe('number');
    expect(hit.created_at).toBeDefined();
  });

  it('accepts multiple-choice options and honors top_k as the cap', async () => {
    const base = await makeServer();
    await post(base, '/add', competitionAddBody());
    const found = await post(base, '/search', {
      query: 'Which answer best matches the memory?',
      options: ['A. uses npm', 'B. uses pnpm', 'C. uses yarn'],
      user_id: 'eval:run1:locomo:conv-0',
      top_k: 1,
    });
    expect(found.status).toBe(200);
    expect(found.json.data.length).toBeLessThanOrEqual(1);
    expect(found.json.data[0].content).toContain('pnpm');
  });

  it('returns data: [] (not omitted) when nothing matches', async () => {
    const base = await makeServer();
    await post(base, '/add', competitionAddBody());
    const found = await post(base, '/search', { user_id: 'eval:other-user', query: 'pnpm', top_k: 10 });
    expect(found.status).toBe(200);
    expect(found.json).toEqual({ data: [] });
  });

  it('rejects missing required fields with 400', async () => {
    const base = await makeServer();
    const r = await post(base, '/add', { request_id: 'x', messages: [], user_id: 'u', session_id: 's' });
    expect(r.status).toBe(400);
    expect(r.json.request_id).toBe('x');
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
    const noAuth = await post(base, '/add', competitionAddBody());
    expect(noAuth.status).toBe(401);
    const wrongAuth = await post(base, '/add', competitionAddBody(), 'wrong');
    expect(wrongAuth.status).toBe(401);
    const rightAuth = await post(base, '/add', competitionAddBody(), 'secret-token');
    expect(rightAuth.status).toBe(200);
    expect(rightAuth.json.success).toBe(true);
  });
});

describe('POST /ingest (raw text extraction)', () => {
  it('extracts from raw text via heuristic extractor and ingests', async () => {
    const base = await makeServer();
    const r = await post(base, '/ingest', { text: '偏好:部署用 pnpm', scope: { project: 'aml' } });
    expect(r.status).toBe(200);
    expect(r.json.extracted).toBe(1);
    expect(r.json.results[0].action).toBe('created');
  });

  it('returns 400 when llm extractor is requested but not configured', async () => {
    const base = await makeServer();
    const r = await post(base, '/ingest', { text: 'x', extractor: 'llm' });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('llm extractor not configured');
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
