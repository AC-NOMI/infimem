import http from 'node:http';
import type { Db } from '../db/connection.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import { remember } from '../ingest/ingest.js';
import { search } from '../retrieval/search.js';
import { InfimemError, NotFoundError, ValidationError } from '../errors.js';
import { HeuristicExtractor } from '../extract/heuristic.js';
import { ingestRaw } from '../extract/ingest.js';
import type { Extractor } from '../extract/types.js';

/**
 * 竞赛/自托管集成的 HTTP 薄层(COMPETITION.md G3):只做协议转换,
 * 校验权与业务语义完全在引擎 zod —— 与 MCP 层同一原则。
 * 字段契约现阶段按引擎参数直传;赛事精确契约确定后在此做映射。
 */

export interface HttpServerOptions {
  port?: number;   // 默认 8787;0 = 随机端口(测试用)
  host?: string;   // 默认 127.0.0.1
  token?: string;  // 配置后 /add /search /ingest 要求 Authorization: Bearer <token>(评测 Key)
  extractors?: { heuristic: Extractor; llm?: Extractor };  // /ingest 用;llm 需 INFIMEM_LLM_API_KEY
}

const DEFAULT_PORT = 8787;
const BODY_LIMIT = 1 << 20; // 1 MiB

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

export function createHttpServer(db: Db, provider: EmbeddingProvider, opts: HttpServerOptions = {}): http.Server {
  return http.createServer((req, res) => {
    handle(req, res, db, provider, opts).catch(e => {
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      console.error('[infimem-http]', e);
    });
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Db,
  provider: EmbeddingProvider,
  opts: HttpServerOptions,
): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const token = opts.token;
  const extractors = opts.extractors ?? { heuristic: new HeuristicExtractor() };

  if (path !== '/health' && token) {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${token}`) {
      return send(res, 401, { error: 'unauthorized: missing or invalid bearer token' });
    }
  }

  if (path === '/health') {
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed, use GET' });
    return send(res, 200, {
      ok: true,
      name: 'infimem',
      provider: { name: provider.name, dim: provider.dim },
      time: new Date().toISOString(),
    });
  }

  if (path === '/add') {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed, use POST' });
    try {
      const body = await readJsonBody(req);
      return send(res, 200, await remember(db, provider, body));
    } catch (e) {
      return sendError(res, e);
    }
  }

  if (path === '/search') {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed, use POST' });
    try {
      const body = await readJsonBody(req);
      return send(res, 200, await search(db, provider, body));
    } catch (e) {
      return sendError(res, e);
    }
  }

  if (path === '/ingest') {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed, use POST' });
    try {
      const body = (await readJsonBody(req)) as { text?: unknown; extractor?: unknown; scope?: unknown };
      if (typeof body.text !== 'string' || body.text.trim() === '') {
        return send(res, 400, { error: 'invalid ingest input: text is required' });
      }
      const kind = body.extractor ?? 'heuristic';
      if (kind !== 'heuristic' && kind !== 'llm') {
        return send(res, 400, { error: 'invalid ingest input: extractor must be heuristic | llm' });
      }
      const extractor: Extractor | undefined = kind === 'llm' ? extractors.llm : extractors.heuristic;
      if (!extractor) return send(res, 400, { error: 'llm extractor not configured (set INFIMEM_LLM_API_KEY)' });
      const result = await ingestRaw(db, provider, {
        text: body.text,
        extractor,
        scope: (body.scope ?? {}) as Parameters<typeof ingestRaw>[2] extends infer O ? O extends { scope?: infer S } ? S : never : never,
        source: 'import',
      });
      return send(res, 200, result);
    } catch (e) {
      return sendError(res, e);
    }
  }

  return send(res, 404, { error: 'not found (available: GET /health, POST /add, POST /search, POST /ingest)' });
}

function sendError(res: http.ServerResponse, e: unknown): void {
  if (e instanceof HttpError) return send(res, e.status, { error: e.message });
  if (e instanceof ValidationError) return send(res, 400, { error: e.message });
  if (e instanceof NotFoundError) return send(res, 404, { error: e.message });
  if (e instanceof InfimemError) return send(res, 500, { error: e.message });
  console.error('[infimem-http]', e);
  return send(res, 500, { error: 'internal error' });
}

export function startHttpServer(
  db: Db,
  provider: EmbeddingProvider,
  opts: HttpServerOptions = {},
): Promise<{ server: http.Server; url: string }> {
  const server = createHttpServer(db, provider, opts);
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const realPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, url: `http://${host}:${realPort}` });
    });
  });
}
