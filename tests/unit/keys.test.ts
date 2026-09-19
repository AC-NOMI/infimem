import { describe, expect, it } from 'vitest';
import { autoCanonicalKey, contentHash, normalizeContent } from '../../src/schema/keys.js';

describe('normalizeContent', () => {
  it('collapses whitespace, trims, and lowercases', () => {
    expect(normalizeContent('  Deploy   with PNPM\n\n  ')).toBe('deploy with pnpm');
  });

  it('keeps CJK text stable via NFC normalization', () => {
    expect(normalizeContent('部署用　ＰＮＰＭ')).toBe(normalizeContent('部署用　ＰＮＰＭ'));
  });
});

describe('contentHash', () => {
  it('is equal for texts that differ only in whitespace and case', () => {
    expect(contentHash('Deploy with PNPM')).toBe(contentHash('deploy with pnpm'));
  });

  it('differs for different content', () => {
    expect(contentHash('deploy with pnpm')).not.toBe(contentHash('deploy with yarn'));
  });
});

describe('autoCanonicalKey', () => {
  it('is deterministic for equivalent content of the same type', () => {
    expect(autoCanonicalKey('preference', '部署用 PNPM')).toBe(autoCanonicalKey('preference', '部署用 pnpm'));
  });

  it('differs across types for identical content', () => {
    expect(autoCanonicalKey('preference', 'deploy with pnpm')).not.toBe(autoCanonicalKey('fact', 'deploy with pnpm'));
  });
});
