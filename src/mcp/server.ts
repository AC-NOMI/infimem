import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../db/connection.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import { MEMORY_TYPES, SENSITIVITY_LEVELS } from '../schema/memory.js';
import { remember } from '../ingest/ingest.js';
import { search } from '../retrieval/search.js';
import { forget } from '../governance/forget.js';
import { compact } from '../governance/compact.js';
import { InfimemError } from '../errors.js';

/**
 * 使用指引随 initialize 响应分发给宿主 agent(见 USAGE.md §7):
 * 引擎不内置 LLM(D1 决策),调用时机与参数填写完全由客户端模型负责。
 */
export const SERVER_INSTRUCTIONS = [
  'infimem is a governable long-term memory engine backed by a single SQLite file.',
  'When to use:',
  '- remember: the user states a stable fact, preference, decision, or procedure worth keeping. Fill the structured fields yourself (type, keywords, scope); the schema is the form.',
  '- search: before answering anything that may depend on the user\'s background, past decisions, or earlier context. Cite the returned memories (id + source) in your answer.',
  '- forget: the user explicitly asks to forget or retract something. Never ignore such requests.',
  '- compact: maintenance; usually not needed during conversation.',
  'Scope conventions: pass project for a project name and session for a conversation id when the memory is only relevant in that context; omit them for user-level memories.',
  'Search respects sensitivity levels: memories marked sensitive are only returned when max_sensitivity allows it.',
].join('\n');

const mcpScopeShape = {
  user: z.string().min(1).optional().describe('Owner scope, defaults to "default"'),
  project: z.string().min(1).optional().describe('Project name when the memory is project-specific'),
  session: z.string().min(1).optional().describe('Conversation id when the memory is session-specific'),
};

export function createInfimemServer(db: Db, provider: EmbeddingProvider): McpServer {
  const server = new McpServer({ name: 'infimem', version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    'remember',
    {
      title: 'Remember',
      description:
        'Store or update a memory. Example: {"content": "deploys backend with pnpm", "type": "preference", "keywords": ["pnpm", "deploy"], "scope": {"project": "myapp"}}',
      inputSchema: {
        content: z.string().describe('The memory text, one fact per call'),
        type: z.enum(MEMORY_TYPES).optional().describe('fact | preference | event | procedure, default fact'),
        keywords: z.array(z.string()).optional().describe('Entity/keyword tags, boost keyword retrieval'),
        scope: z.object(mcpScopeShape).optional().describe('Scope path, defaults to user level'),
        canonicalKey: z.string().optional().describe('Identity key for dedup/versioning; omit to auto-derive'),
        sensitivity: z.enum(SENSITIVITY_LEVELS).optional().describe('default normal; use sensitive for private data'),
        confidence: z.number().optional().describe('0~1, default 0.8'),
        sourceRef: z.string().optional().describe('Where this memory came from (URL, file, session)'),
        supersedes: z.string().optional().describe('Memory id this one replaces'),
        idempotencyKey: z.string().optional().describe('Client-generated key so retries never double-write'),
      },
    },
    async (args) => {
      try {
        const result = await remember(db, provider, args);
        return json(result);
      } catch (e) {
        return errorOf(e);
      }
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Search',
      description:
        'Hybrid retrieval (keyword + vector) with transparent per-stage scores and citations. Example: {"query": "how do we deploy", "k": 5}',
      inputSchema: {
        query: z.string().describe('Natural language or keyword query'),
        scope: z.object(mcpScopeShape).optional().describe('Restrict to a scope path; ancestors included by default'),
        includeAncestors: z.boolean().optional().describe('Also search project/user level, default true'),
        k: z.number().int().optional().describe('Max results, default 5'),
        maxSensitivity: z.enum(SENSITIVITY_LEVELS).optional().describe('Sensitivity ceiling, default normal'),
        type: z.enum(MEMORY_TYPES).optional().describe('Filter by memory type'),
        maxDistance: z.number().optional().describe('Vector distance cutoff (0~2), default 0.95; raise for API embeddings'),
      },
    },
    async (args) => {
      try {
        const result = await search(db, provider, args);
        return json(result);
      } catch (e) {
        return errorOf(e);
      }
    },
  );

  server.registerTool(
    'forget',
    {
      title: 'Forget',
      description: 'Tombstone active memories by id, or by canonical key within a scope. Audited and reversible via backups only.',
      inputSchema: {
        id: z.string().optional().describe('Memory id to forget'),
        canonicalKey: z.string().optional().describe('Forget all active memories with this canonical key (requires scope)'),
        scope: z.object(mcpScopeShape).optional().describe('Required when forgetting by canonical key'),
      },
    },
    async (args) => {
      try {
        const result = await forget(db, args);
        return json(result);
      } catch (e) {
        return errorOf(e);
      }
    },
  );

  server.registerTool(
    'compact',
    {
      title: 'Compact',
      description: 'Maintenance report (chains, conflicts); optionally rebuild FTS/vector indexes from the memories table.',
      inputSchema: {
        rebuildIndex: z.boolean().optional().describe('Rebuild derived indexes, also backfills missing vectors'),
      },
    },
    async (args) => {
      try {
        const result = await compact(db, provider, { rebuildIndex: args.rebuildIndex });
        return json(result);
      } catch (e) {
        return errorOf(e);
      }
    },
  );

  return server;
}

function json(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorOf(e: unknown): { isError: true; content: { type: 'text'; text: string }[] } {
  const message =
    e instanceof InfimemError || e instanceof Error
      ? e.message
      : 'unknown error';
  return { isError: true, content: [{ type: 'text', text: message }] };
}
