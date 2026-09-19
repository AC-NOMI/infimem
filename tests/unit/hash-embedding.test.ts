import { describe, expect, it } from 'vitest';
import { HashEmbeddingProvider } from '../../src/embeddings/hash.js';

describe('HashEmbeddingProvider', () => {
  const provider = new HashEmbeddingProvider();

  it('produces vectors of dimension 384', async () => {
    const v = await provider.embed('deploy with pnpm');
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(384);
  });

  it('is deterministic for the same input', async () => {
    const a = await provider.embed('用户偏好 pnpm 包管理');
    const b = await provider.embed('用户偏好 pnpm 包管理');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('is unit-normalized (L2 norm = 1)', async () => {
    const v = await provider.embed('long text with many tokens about databases and sqlite internals');
    const norm = Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('distinguishes different inputs (not all-same vector)', async () => {
    const a = await provider.embed('deploy with pnpm');
    const b = await provider.embed('cooking italian pasta');
    const dot = Array.from(a).reduce((s, x, i) => s + x * b[i], 0);
    expect(dot).toBeLessThan(0.9);
  });

  it('is similar for texts sharing vocabulary (sanity for lexical hashing)', async () => {
    const a = await provider.embed('deploy backend with pnpm workspace');
    const b = await provider.embed('pnpm workspace for backend deploy');
    const dot = Array.from(a).reduce((s, x, i) => s + x * b[i], 0);
    expect(dot).toBeGreaterThan(0.5);
  });

  it('handles CJK input via character bigrams', async () => {
    const v = await provider.embed('部署用包管理器');
    const norm = Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});
