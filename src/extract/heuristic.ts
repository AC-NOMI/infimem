import type { MemoryType } from '../schema/memory.js';
import type { ExtractedMemory, Extractor } from './types.js';

const MAX_CONTENT = 2000;

const PREFIX_RULES: ReadonlyArray<[RegExp, MemoryType]> = [
  [/^(偏好|preference)\s*[:：、.，,]\s*/i, 'preference'],
  [/^(事件|event)\s*[:：、.，,]\s*/i, 'event'],
  [/^(流程|步骤|procedure|howto)\s*[:：、.，,]\s*/i, 'procedure'],
  [/^(事实|fact)\s*[:：、.，,]\s*/i, 'fact'],
];

/**
 * 规则抽取器:按行切分、前缀标记分类、超长行按句子边界再切。
 * 零依赖、确定性 —— 作为 LLM 抽取的离线基线与兜底。
 */
export class HeuristicExtractor implements Extractor {
  readonly name = 'heuristic';

  async extract(text: string): Promise<ExtractedMemory[]> {
    const out: ExtractedMemory[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      for (const piece of splitSentences(line)) {
        let type: MemoryType = 'fact';
        let content = piece;
        for (const [re, t] of PREFIX_RULES) {
          if (re.test(content)) {
            type = t;
            content = content.replace(re, '');
            break;
          }
        }
        if (content.trim()) out.push({ content: content.trim(), type, keywords: [] });
      }
    }
    return out;
  }
}

function splitSentences(line: string): string[] {
  if (line.length <= MAX_CONTENT) return [line];
  const sentences = line.split(/(?<=[。!?；;.!?)])\s*/);
  const chunks: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length > MAX_CONTENT) {
      chunks.push(cur);
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}
