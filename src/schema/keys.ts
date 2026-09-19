import { createHash } from 'node:crypto';

/** 比较与哈希前的一致化:NFC 折叠、小写、空白压缩 */
export function normalizeContent(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function contentHash(text: string): string {
  return createHash('sha256').update(normalizeContent(text)).digest('hex');
}

/** 调用方未提供 canonical_key 时的回退:类型 + 归一化内容的短哈希 */
export function autoCanonicalKey(type: string, text: string): string {
  return `auto:${type}:${contentHash(text).slice(0, 24)}`;
}
