import { z } from 'zod';
import { MEMORY_TYPES } from '../schema/memory.js';
import { InfimemError } from '../errors.js';
import type { ExtractedMemory, Extractor } from './types.js';

export class ExtractError extends InfimemError {}

const outputSchema = z.object({
  memories: z
    .array(
      z.object({
        content: z.string().trim().min(1).max(2000),
        type: z.enum(MEMORY_TYPES).default('fact'),
        keywords: z.array(z.string()).max(20).default([]),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .max(50),
});

const SYSTEM_PROMPT = [
  'You extract long-term memories for an AI agent memory engine.',
  'From the given text, extract atomic, self-contained memory items.',
  'Types: fact (information), preference (likes/dislikes/choices), event (happening, often with time), procedure (how-to / steps).',
  'Merge duplicates; keep the original language; drop trivia and filler.',
  'Return STRICT JSON only, no commentary, in the shape:',
  '{"memories":[{"content":"...","type":"fact|preference|event|procedure","keywords":["..."],"confidence":0.0}]}',
].join('\n');

export interface LlmExtractorOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  chunkSize?: number;
  retries?: number;
}

/** gpt-4o-mini(OpenAI 兼容端点)抽取器 —— 赛事 Add 场景的系统内抽取(D1 的可选增强路径) */
export class LlmExtractor implements Extractor {
  readonly name = 'llm';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly chunkSize: number;
  private readonly retries: number;

  constructor(opts: LlmExtractorOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.INFIMEM_LLM_API_KEY ?? '';
    this.model = opts.model ?? process.env.INFIMEM_LLM_MODEL ?? 'gpt-4o-mini';
    this.baseUrl = (opts.baseUrl ?? process.env.INFIMEM_LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.chunkSize = opts.chunkSize ?? 3000;
    this.retries = opts.retries ?? 1;
    if (!this.apiKey) throw new InfimemError('LlmExtractor requires an API key (INFIMEM_LLM_API_KEY)');
  }

  async extract(text: string): Promise<ExtractedMemory[]> {
    const out: ExtractedMemory[] = [];
    for (const chunk of chunkText(text, this.chunkSize)) {
      out.push(...(await this.extractChunk(chunk)));
    }
    return out;
  }

  private async extractChunk(chunk: string): Promise<ExtractedMemory[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            temperature: 0,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: chunk },
            ],
          }),
        });
        if (!res.ok) throw new ExtractError(`llm http ${res.status}`);
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        return parseLlmMemories(data.choices?.[0]?.message?.content ?? '');
      } catch (e) {
        lastError = e; // 网络抖动与 LLM 输出抖动都重试一次
      }
    }
    if (lastError instanceof ExtractError) throw lastError;
    throw new ExtractError(`llm extraction failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
}

function parseLlmMemories(content: string): ExtractedMemory[] {
  const cleaned = content
    .replace(/^```(?:json)?\s*/gm, '')
    .replace(/```\s*/g, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ExtractError('llm output is not valid JSON');
  }
  const r = outputSchema.safeParse(parsed);
  if (!r.success) throw new ExtractError('llm output failed schema validation');
  return r.data.memories.map(m => ({
    content: m.content,
    type: m.type,
    keywords: m.keywords,
    ...(m.confidence !== undefined ? { confidence: m.confidence } : {}),
  }));
}

function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let cur = '';
  for (const para of text.split(/\n{2,}/)) {
    if (para.length > size) {
      if (cur) {
        chunks.push(cur);
        cur = '';
      }
      for (let i = 0; i < para.length; i += size) chunks.push(para.slice(i, i + size));
      continue;
    }
    if (cur && cur.length + para.length + 2 > size) {
      chunks.push(cur);
      cur = para;
    } else {
      cur = cur ? `${cur}\n\n${para}` : para;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}
