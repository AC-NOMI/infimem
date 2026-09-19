import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createInfimemServer } from '../../src/mcp/server.js';
import { makeDb, hashProvider, type Db } from '../helpers.js';

async function makeClient(): Promise<{ db: Db; server: McpServer; client: Client; close: () => Promise<void> }> {
  const db = makeDb();
  const server = createInfimemServer(db, hashProvider);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    db,
    server,
    client,
    close: async () => {
      await client.close();
      await server.close();
      db.close();
    },
  };
}

function textOf(result: unknown): Record<string, unknown> {
  const r = result as { content: { type: string; text: string }[]; isError?: boolean };
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

describe('infimem MCP server', () => {
  it('exposes exactly the four charter tools', async () => {
    const { client, close } = await makeClient();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['compact', 'forget', 'remember', 'search']);
    await close();
  });

  it('ships non-empty usage instructions for the host agent', async () => {
    const { client, close } = await makeClient();
    const instructions = client.getInstructions();
    expect(instructions).toBeTruthy();
    expect(instructions).toContain('remember');
    expect(instructions).toContain('search');
    await close();
  });

  it('remember → search roundtrip works end to end', async () => {
    const { client, close } = await makeClient();
    const remembered = await client.callTool({
      name: 'remember',
      arguments: { content: 'deploy with pnpm not npm', keywords: ['pnpm'] },
    });
    expect(textOf(remembered)).toMatchObject({ action: 'created' });

    const found = await client.callTool({ name: 'search', arguments: { query: 'pnpm' } });
    const out = textOf(found) as unknown as {
      results: { content: string; scores: Record<string, number> }[];
    };
    expect(out.results[0]!.content).toBe('deploy with pnpm not npm');
    expect(out.results[0]!.scores.rrf).toBeGreaterThan(0);
    await close();
  });

  it('forget tool tombstones a memory', async () => {
    const { client, close } = await makeClient();
    const remembered = textOf(
      await client.callTool({ name: 'remember', arguments: { content: 'ephemeral mcp note' } })
    ) as { id: string };
    const forgotten = textOf(await client.callTool({ name: 'forget', arguments: { id: remembered.id } })) as {
      forgotten: string[];
    };
    expect(forgotten.forgotten).toEqual([remembered.id]);
    await close();
  });

  it('compact tool returns a report', async () => {
    const { client, close } = await makeClient();
    await client.callTool({ name: 'remember', arguments: { content: 'compact via mcp' } });
    const report = textOf(await client.callTool({ name: 'compact', arguments: {} })) as { memories: number };
    expect(report.memories).toBe(1);
    await close();
  });

  it('invalid tool input returns an isError result with the message', async () => {
    const { client, close } = await makeClient();
    const bad = (await client.callTool({ name: 'remember', arguments: { content: '' } })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('invalid remember input');
    await close();
  });

  it('search tool returns empty results rather than an error on unknown topics', async () => {
    const { client, close } = await makeClient();
    const out = textOf(await client.callTool({ name: 'search', arguments: { query: 'nonexistent topic xyz' } })) as {
      results: unknown[];
    };
    expect(out.results).toEqual([]);
    await close();
  });
});
