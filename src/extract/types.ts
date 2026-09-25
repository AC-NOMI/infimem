import type { MemoryType } from '../schema/memory.js';

export interface ExtractedMemory {
  content: string;
  type: MemoryType;
  keywords: string[];
  confidence?: number;
}

/** 抽取器:原始文本 → 结构化记忆候选(契约同 FEATURES 决策 D1 的预留钩子) */
export interface Extractor {
  readonly name: string;
  extract(text: string): Promise<ExtractedMemory[]>;
}
