import { z } from 'zod';

export const MEMORY_TYPES = ['fact', 'preference', 'event', 'procedure'] as const;
export const SENSITIVITY_LEVELS = ['public', 'normal', 'sensitive'] as const;
export const WRITE_SOURCES = ['mcp', 'cli', 'import', 'seed'] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number];
export type WriteSource = (typeof WRITE_SOURCES)[number];

export const scopeSchema = z.object({
  user: z.string().min(1).max(128).default('default'),
  project: z.string().min(1).max(128).optional(),
  session: z.string().min(1).max(256).optional(),
});

export const rememberInputSchema = z.object({
  content: z.string().trim().min(1).max(2000),
  type: z.enum(MEMORY_TYPES).default('fact'),
  keywords: z.array(z.string().min(1).max(64)).max(20).default([]),
  // 注意:default({}) 不会把 {} 重新过一遍内层 schema,scope 的内层默认值在 remember() 里显式解析
  scope: scopeSchema.optional(),
  canonicalKey: z.string().min(1).max(256).optional(),
  sensitivity: z.enum(SENSITIVITY_LEVELS).default('normal'),
  confidence: z.number().min(0).max(1).default(0.8),
  source: z.enum(WRITE_SOURCES).default('mcp'),
  sourceRef: z.string().max(1024).optional(),
  supersedes: z.string().min(1).max(64).optional(),
  idempotencyKey: z.string().min(1).max(256).optional(),
});

export type Scope = z.infer<typeof scopeSchema>;
export type RememberInput = z.infer<typeof rememberInputSchema>;
