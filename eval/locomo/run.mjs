#!/usr/bin/env node
// LoCoMo 第 1 级评测(检索级):官方对话 → Add 契约注入 → QA 检索 → answer-hit / evidence-recall
// 用法: node eval/locomo/run.mjs [--data path] [--limit N] [--k 5] [--extractor heuristic|llm] [--embedding hash|v4]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return a;
}, []));

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { openDb } = await import(join(root, 'dist', 'index.js'));
const { HeuristicExtractor } = await import(join(root, 'dist', 'extract', 'heuristic.js'));
const { LlmExtractor } = await import(join(root, 'dist', 'extract', 'llm.js'));
const { ingestRaw } = await import(join(root, 'dist', 'extract', 'ingest.js'));
const { search } = await import(join(root, 'dist', 'retrieval', 'search.js'));
const { HashEmbeddingProvider } = await import(join(root, 'dist', 'embeddings', 'hash.js'));
const { OpenAIEmbeddingProvider } = await import(join(root, 'dist', 'embeddings', 'openai.js'));

const dataPath = args.data ?? join(root, 'eval', 'locomo', 'data', 'locomo10.json');
const K = Number(args.k ?? 5);
const LIMIT = args.limit ? Number(args.limit) : 10;
// --answers 启用 LLM 答题;建议先 --limit 1 小样本验证再全量
const extractorKind = args.extractor ?? 'heuristic';
const embeddingKind = args.embedding ?? 'hash';

const provider = embeddingKind === 'v4'
  ? new OpenAIEmbeddingProvider({ name: 'text-embedding-v4' })
  : embeddingKind === 'openai'
    ? new OpenAIEmbeddingProvider({
        name: process.env.INFIMEM_OPENAI_MODEL ?? 'BAAI/bge-m3',
        apiKey: process.env.INFIMEM_OPENAI_API_KEY,
        model: process.env.INFIMEM_OPENAI_MODEL ?? 'BAAI/bge-m3',
        endpoint: process.env.INFIMEM_OPENAI_BASE_URL ?? 'https://api.siliconflow.cn/v1/embeddings',
        dim: Number(process.env.INFIMEM_EMBEDDING_DIM ?? process.env.INFIMEM_OPENAI_DIM ?? 1024),
        dimRange: [1, 4096],
        // bge-m3 为固定维度模型,拒绝 dimensions 参数:默认不发送,除非显式置 0
        sendDimensions: process.env.INFIMEM_OPENAI_NO_DIMENSIONS === '0', // bge-m3 拒收 dimensions,默认不发送
        batchSize: Number(process.env.INFIMEM_EMBEDDING_BATCH ?? 10),
      })
    : new HashEmbeddingProvider();
const MODEL = args.model ?? process.env.INFIMEM_LLM_MODEL ?? 'Qwen/Qwen2.5-7B-Instruct';
const extractThinking = args['extract-thinking'] !== 'off';
const answerThinking = args['answer-thinking'] !== 'off';
const extractor = extractorKind === 'llm'
  ? new LlmExtractor({ model: MODEL, ...(extractThinking ? {} : { thinking: false }) })
  : new HeuristicExtractor();
let chat = null;
if (args.answers) {
  const baseUrl = process.env.INFIMEM_LLM_BASE_URL ?? 'https://api.siliconflow.cn/v1';
  const apiKey = process.env.INFIMEM_LLM_API_KEY;
  if (!apiKey) throw new Error('--answers 需要 INFIMEM_LLM_API_KEY');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  chat = async (messages) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: MODEL, temperature: 0, messages, ...(answerThinking ? {} : { enable_thinking: false }) }),
        });
        if (res.status === 429) {
          const wait = 3000 * (attempt + 1);
          console.error(`[answer] 429 限速,${wait}ms 后重试 (${attempt + 1}/3) ${new Date().toISOString()}`);
          await sleep(wait);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return (data.choices?.[0]?.message?.content ?? '').trim();
      } catch (e) {
        if (attempt === 2) throw e;
        await sleep(1000);
      }
    }
  };
}
const f1 = (pred, gold) => {
  const P = new Set(norm(pred).split(' ').filter(Boolean));
  const G = new Set(norm(gold).split(' ').filter(Boolean));
  if (P.size === 0 || G.size === 0) return 0;
  const overlap = [...P].filter(t => G.has(t)).length;
  const precision = overlap / P.size, recall = overlap / G.size;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
};

const norm = (s) => (s.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? []).join(' ');
const parseDT = (s) => {
  const m = /(\d+):(\d+) (am|pm) on (\d+) (\w+), (\d+)/.exec(s ?? '');
  if (!m) return undefined;
  const months = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
  let h = Number(m[1]) % 12;
  if (m[3] === 'pm') h += 12;
  return new Date(Number(m[6]), months[m[5].toLowerCase()], Number(m[4]), h, Number(m[2])).getTime();
};

const dataset = JSON.parse(readFileSync(dataPath, 'utf8')).slice(0, LIMIT);
const CATEGORY_LABELS = { 1: 'single-hop', 2: 'temporal', 3: 'open-domain', 4: 'multi-hop', 5: 'adversarial' };

const perConv = [];
let totalMemories = 0;

for (const conv of dataset) {
  const sampleId = conv.sample_id;
  const convMeta = conv.conversation;
  const speakerA = convMeta.speaker_a;
  const sessions = Object.keys(convMeta)
    .filter(k => /^session_\d+$/.test(k))
    .map(k => Number(k.split('_')[1]))
    .sort((a, b) => a - b);

  const diaText = new Map(); // dia_id -> 归一化文本
  const db = openDb(':memory:', { dim: provider.dim });

  for (const n of sessions) {
    const turns = convMeta[`session_${n}`] ?? [];
    const ts = parseDT(convMeta[`session_${n}_date_time`]);
    const messages = turns.map(t => ({
      role: t.speaker === speakerA ? 'user' : 'assistant',
      ...(ts !== undefined ? { timestamp: ts } : {}),
      content: `${t.speaker}: ${t.text}`,
    }));
    for (const t of turns) diaText.set(t.dia_id, norm(`${t.speaker}: ${t.text}`));
    await ingestRaw(db, provider, {
      text: messages.map(m => `${m.role}: ${m.content}`).join('\n'),
      extractor,
      scope: { user: `locomo:${sampleId}` },
      source: 'seed',
      idempotencyKeyPrefix: `${sampleId}:s${n}`,
      sourceRef: convMeta[`session_${n}_date_time`],
    });
  }

  const memCount = (db.prepare('SELECT count(*) c FROM memories').get()).c;
  totalMemories += memCount;

  const pendingAnswers = [];
  for (const qa of conv.qa) {
    const cat = Number(qa.category);
    const out = await search(db, provider, { query: qa.question, k: K, scope: { user: `locomo:${sampleId}` } });
    const retrieved = out.results.map(r => norm(r.content));
    const answerNorm = norm(String(qa.answer ?? ''));
    // answer-hit:金标答案(≥3 归一化字符)被某条返回记忆包含
    let hitRank = 0;
    if (answerNorm.length >= 3) {
      const idx = retrieved.findIndex(c => c.includes(answerNorm));
      hitRank = idx === -1 ? 0 : idx + 1;
    }
    // evidence-recall:证据轮次文本与返回记忆的 token 覆盖率 ≥ 0.5 记为覆盖
    const evIds = Array.isArray(qa.evidence) ? qa.evidence : (() => { try { return JSON.parse(String(qa.evidence ?? '[]').replace(/'/g, '"')); } catch { return []; } })();
    const evTexts = evIds.map(id => diaText.get(id)).filter(Boolean);
    let covered = 0;
    if (evTexts.length > 0) {
      for (const ev of evTexts) {
        const evTokens = new Set(ev.split(' ').filter(t => t.length > 2));
        const hit = retrieved.some(c => {
          const cs = new Set(c.split(' '));
          let n = 0;
          for (const t of evTokens) if (cs.has(t)) n++;
          return n / evTokens.size >= 0.5;
        });
        if (hit) covered++;
      }
    }
    const entry = {
      sample_id: sampleId, category: cat, question: qa.question, answer: String(qa.answer ?? ''),
      answerHit: hitRank > 0, answerRank: hitRank,
      evidenceTotal: evTexts.length, evidenceCovered: covered,
      evidenceRecall: evTexts.length > 0 ? covered / evTexts.length : null,
      memories: memCount,
    };
    if (chat) {
      entry._top = out.results.slice(0, 5).map((r, i) => `${i + 1}. ${r.content}`).join('\n');
      pendingAnswers.push(entry);
    }
    perConv.push(entry);
  }
  // 答题并发化:检索(本地)全部完成后,LLM 答题用 worker pool 并发
  if (chat && pendingAnswers.length > 0) {
    let next = 0;
    const answerWorker = async () => {
      while (next < pendingAnswers.length) {
        const e = pendingAnswers[next++];
        if (e.answerRank % 25 === 0) console.error(`[answers] ${next}/${pendingAnswers.length}`);
        try {
          e.genAnswer = await chat([
            { role: 'system', content: 'Answer the question using ONLY the memories provided. If the memories do not contain the answer, reply exactly: no information. Reply in the same language as the question, as briefly as possible.' },
            { role: 'user', content: `Memories:\n${e._top}\n\nQuestion: ${e.question}` },
          ]);
          e.genF1 = f1(e.genAnswer, e.answer);
        } catch (err) {
          console.error(`[answer-fail] ${e.question.slice(0, 40)}: ${err instanceof Error ? err.message : err}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, answerWorker)); // 并发 6,免费档限速内
  }
  console.error(`[${sampleId}] turns-sessions=${sessions.length} memories=${memCount} qa=${conv.qa.length}`);
  db.close();
}

// ---- 聚合 ----
const scored = perConv.filter(p => p.category !== 5 && p.evidenceTotal > 0);
const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const mrr = mean(scored.map(p => (p.answerRank ? 1 / p.answerRank : 0)));
const report = {
  dataset: 'locomo10', extractor: extractor.name, provider: provider.name, k: K,
  conversations: dataset.length, memories: totalMemories,
  memoriesPerConversation: Math.round(totalMemories / dataset.length),
  qasScored: scored.length,
  answerHitAtK: mean(scored.map(p => (p.answerHit ? 1 : 0))),
  mrr,
  answerF1: (() => { const fs = perConv.filter(p => p.genF1 !== null && p.genF1 !== undefined).map(p => p.genF1); return fs.length ? mean(fs) : null; })(),
  evidenceRecallAtK: mean(scored.map(p => p.evidenceRecall ?? 0).filter((_, i) => scored[i].evidenceTotal > 0)),
  byCategory: Object.fromEntries(Object.entries(CATEGORY_LABELS).map(([cat, label]) => {
    const rows = perConv.filter(p => p.category === Number(cat) && p.evidenceTotal > 0);
    return [label, {
      qas: rows.length,
      answerHitAtK: mean(rows.map(p => (p.answerHit ? 1 : 0))),
      evidenceRecallAtK: rows.length ? mean(rows.map(p => p.evidenceRecall ?? 0)) : null,
    }];
  })),
  generatedAt: new Date().toISOString(),
};

const outDir = join(root, 'eval', 'reports', 'locomo');
const safe = (x) => x.replace(/[^A-Za-z0-9._-]/g, '_');
const tag = args.tag ? '-' + safe(String(args.tag)) : '';
const reportName = 'locomo-' + safe(extractor.name) + '-' + safe(MODEL) + tag + '-' + safe(provider.name) + '-k' + K; // 含 LLM 模型名与标签,防覆盖
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${reportName}.json`), JSON.stringify({ ...report, perCase: perConv }, null, 2));
const md = [
  `# LoCoMo 检索级评测 — ${report.extractor} + ${report.provider} (k=${K})`,
  '',
  `对话 ${report.conversations} · 记忆 ${report.memories} 条(均 ${report.memoriesPerConversation}/对话) · 计分 QA ${report.qasScored}`,
  '',
  `| 指标 | 值 |`, `|---|---|`,
  `| Answer-hit@${K} | ${report.answerHitAtK.toFixed(3)} |`,
  `| MRR | ${report.mrr.toFixed(3)} |`,
  `| Answer F1(LLM 答题) | ${report.answerF1 === null ? 'n/a' : report.answerF1.toFixed(3)} |`,
  `| Evidence-recall@${K} | ${report.evidenceRecallAtK.toFixed(3)} |`,
  '',
  `| 类别 | QA | Answer-hit@${K} | Evidence-recall@${K} |`,
  `|---|---|---|---|`,
  ...Object.entries(report.byCategory).map(([l, v]) => `| ${l} | ${v.qas} | ${v.answerHitAtK.toFixed(3)} | ${v.evidenceRecallAtK === null ? 'n/a' : v.evidenceRecallAtK.toFixed(3)} |`),
].join('\n');
writeFileSync(join(outDir, `${reportName}.md`), md);
console.log(md);
console.log(`\nreport → eval/reports/locomo/locomo-${safe(extractor.name)}-${safe(provider.name)}-k${K}.{json,md}`);
