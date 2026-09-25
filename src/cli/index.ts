#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDb } from '../db/connection.js';
import { createInfimemServer } from '../mcp/server.js';
import { startHttpServer } from '../http/server.js';
import { getProviderFromEnv } from '../embeddings/env.js';
import { runSuite, compareWithBaseline, reportToMarkdown } from '../eval/run.js';
import type { EvalCase } from '../eval/types.js';
import type { ScoredResult } from '../retrieval/types.js';
import { InfimemError } from '../errors.js';
import * as h from './handlers.js';

const program = new Command();
program.name('infimem').description('Governable, evaluable memory engine for AI agents').version('0.1.0');

program
  .command('init')
  .description('Create the memory database')
  .option('--db <path>', 'Database file (default $INFIMEM_DB or ./infimem.db)')
  .action(async (opts) => {
    const r = await h.cmdInit(h.resolveDbPath(opts.db));
    console.log(`infimem database ready at ${r.path}`);
  });

program
  .command('add')
  .description('Store a memory')
  .argument('<content>')
  .option('--db <path>')
  .option('--type <type>', 'fact | preference | event | procedure')
  .option('--keywords <csv>', 'Comma-separated keywords')
  .option('--project <name>')
  .option('--session <id>')
  .option('--sensitivity <level>', 'public | normal | sensitive')
  .option('--confidence <n>')
  .option('--canonical-key <key>')
  .option('--source-ref <ref>')
  .option('--supersedes <id>')
  .option('--idempotency-key <key>')
  .action(async (content, opts) => {
    const r = await h.cmdAdd(h.resolveDbPath(opts.db), {
      content,
      type: opts.type,
      keywords: opts.keywords
        ? String(opts.keywords)
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean)
        : undefined,
      project: opts.project,
      session: opts.session,
      sensitivity: opts.sensitivity,
      confidence: opts.confidence !== undefined ? Number(opts.confidence) : undefined,
      canonicalKey: opts.canonicalKey,
      sourceRef: opts.sourceRef,
      supersedes: opts.supersedes,
      idempotencyKey: opts.idempotencyKey,
    });
    console.log(JSON.stringify(r, null, 2));
  });

program
  .command('search')
  .description('Hybrid retrieval with citations')
  .argument('<query>')
  .option('--db <path>')
  .option('-k, --limit <n>', 'Max results (default 5)')
  .option('--project <name>')
  .option('--session <id>')
  .option('--no-include-ancestors', 'Do not include project/user level memories')
  .option('--max-sensitivity <level>', 'public | normal | sensitive (default normal)')
  .option('--type <type>')
  .option('--json', 'Print full JSON with scores and trace')
  .action(async (query, opts) => {
    const r = await h.cmdSearch(h.resolveDbPath(opts.db), {
      query,
      k: opts.limit ? Number(opts.limit) : undefined,
      project: opts.project,
      session: opts.session,
      includeAncestors: opts.includeAncestors,
      maxSensitivity: opts.maxSensitivity,
      type: opts.type,
    });
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (r.results.length === 0) {
      console.log('no results');
      return;
    }
    r.results.forEach((x: ScoredResult, i: number): void => {
      const s = x.scores;
      console.log(
        `${i + 1}. ${x.content}`,
        `\n   id=${x.id} type=${x.type} scope=${x.scope.user}/${x.scope.project ?? '-'}/${x.scope.session ?? '-'} sens=${x.sensitivity}`,
        `\n   rrf=${s.rrf.toFixed(4)}${s.fts !== undefined ? ` fts=${Number(s.fts).toFixed(2)}` : ''}${s.vec !== undefined ? ` vec=${s.vec.toFixed(3)}` : ''} created=${x.createdAt}`,
      );
    });
    console.log(`\ntrace: fts=${r.trace.ftsCandidates} vec=${r.trace.vecCandidates} fused=${r.trace.fused} reranker=${r.trace.reranker} ${r.trace.elapsedMs.total}ms`);
  });

program
  .command('forget')
  .description('Tombstone active memories')
  .argument('[id]')
  .option('--db <path>')
  .option('--canonical-key <key>', 'Forget all active memories with this key')
  .option('--project <name>')
  .option('--session <id>')
  .action(async (id, opts) => {
    const r = await h.cmdForget(h.resolveDbPath(opts.db), {
      id,
      canonicalKey: opts.canonicalKey,
      scope: { user: 'default', project: opts.project, session: opts.session },
    });
    console.log(JSON.stringify(r, null, 2));
  });

program
  .command('export')
  .description('Export all memories as JSONL (re-ingestible; for backup copy the .db file)')
  .argument('<file>')
  .option('--db <path>')
  .action(async (file, opts) => {
    const r = await h.cmdExport(h.resolveDbPath(opts.db), file);
    console.log(`exported ${r.count} memories to ${file}`);
  });

program
  .command('import')
  .description('Import a JSONL export (idempotent: re-importing the same file writes nothing new)')
  .argument('<file>')
  .option('--db <path>')
  .action(async (file, opts) => {
    const r = await h.cmdImport(h.resolveDbPath(opts.db), file);
    console.log(JSON.stringify(r, null, 2));
  });

program
  .command('compact')
  .description('Report maintenance stats; optionally rebuild derived indexes')
  .option('--db <path>')
  .option('--rebuild-index', 'Rebuild FTS and vector indexes from the memories table')
  .action(async (opts) => {
    const r = await h.cmdCompact(h.resolveDbPath(opts.db), { rebuildIndex: opts.rebuildIndex });
    console.log(JSON.stringify(r, null, 2));
  });

program
  .command('mcp')
  .description('Start the MCP stdio server (used by MCP clients; prints nothing)')
  .option('--db <path>')
  .action(async (opts) => {
    const provider = getProviderFromEnv();
    const db = openDb(h.resolveDbPath(opts.db), { dim: provider.dim });
    const server = createInfimemServer(db, provider);
    await server.connect(new StdioServerTransport());
  });

program
  .command('serve')
  .description('Start the HTTP Add/Search server (competition / self-hosted integration)')
  .option('--db <path>')
  .option('--port <n>', 'Port (default 8787)')
  .option('--host <h>', 'Bind address (default 127.0.0.1)')
  .option('--token <t>', 'Require bearer auth (default $INFIMEM_HTTP_TOKEN)')
  .action(async (opts) => {
    const provider = getProviderFromEnv();
    const db = openDb(h.resolveDbPath(opts.db), { dim: provider.dim });
    const { url } = await startHttpServer(db, provider, {
      port: opts.port ? Number(opts.port) : undefined,
      host: opts.host,
      token: opts.token ?? process.env.INFIMEM_HTTP_TOKEN,
    });
    console.log(`infimem HTTP server listening at ${url} (provider: ${provider.name}, dim: ${provider.dim})`);
    console.log('endpoints: GET /health · POST /add · POST /search');
  });

program
  .command('eval')
  .description('Run an eval suite (JSONL cases) and optionally compare against a baseline')
  .requiredOption('--suite <file>', 'JSONL file of eval cases')
  .option('--name <name>', 'Suite name for the report', 'v1')
  .option('--report <dir>', 'Write report.json and report.md to this directory')
  .option('--baseline <file>', 'Compare against a baseline report.json')
  .option('--fail-on-regression', 'Exit non-zero when metrics regress beyond tolerance')
  .action(async (opts) => {
    const cases = readFileSync(opts.suite, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as EvalCase);
    const provider = getProviderFromEnv();
    const report = await runSuite(provider, cases, opts.name);
    console.log(reportToMarkdown(report));
    if (opts.report) {
      mkdirSync(opts.report, { recursive: true });
      writeFileSync(join(opts.report, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
      writeFileSync(join(opts.report, 'report.md'), reportToMarkdown(report), 'utf8');
      console.log(`\nreport written to ${join(opts.report, 'report.json')}`);
    }
    if (opts.baseline) {
      const baseline = JSON.parse(readFileSync(opts.baseline, 'utf8')) as Parameters<typeof compareWithBaseline>[1];
      const cmp = compareWithBaseline(report, baseline);
      if (cmp.ok) {
        console.log('baseline check: OK');
      } else {
        console.error(`baseline check: REGRESSION in ${cmp.regressions.join(', ')}`);
        if (opts.failOnRegression) process.exitCode = 1;
      }
    }
  });

program.parseAsync().catch((e: unknown) => {
  if (e instanceof InfimemError) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  throw e;
});
