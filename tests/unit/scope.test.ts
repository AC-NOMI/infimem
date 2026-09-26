import { describe, expect, it } from 'vitest';
import { scopeCondition, scopePairs } from '../../src/retrieval/scope.js';
import type { Scope } from '../../src/schema/memory.js';

const s = (project?: string, session?: string): Scope => ({ user: 'u1', ...(project ? { project } : {}), ...(session ? { session } : {}) });

describe('scopePairs(祖先链)', () => {
  it('full path expands to (p,s) -> (p,-) -> (-,-)', () => {
    expect(scopePairs(s('proj', 'sess'), true)).toEqual([
      ['proj', 'sess'],
      ['proj', null],
      [null, null],
    ]);
  });

  it('session-only scope includes the user-level ancestor (competition semantics)', () => {
    expect(scopePairs(s(undefined, 'sess'), true)).toEqual([
      [null, 'sess'],
      [null, null],
    ]);
  });

  it('project-only scope includes user level; user-only scope is a single pair', () => {
    expect(scopePairs(s('proj'), true)).toEqual([
      ['proj', null],
      [null, null],
    ]);
    expect(scopePairs(s(), true)).toEqual([[null, null]]);
  });

  it('includeAncestors=false yields exactly one exact pair', () => {
    expect(scopePairs(s('proj', 'sess'), false)).toEqual([['proj', 'sess']]);
  });

  it('scopeCondition emits IS triplets with flat params', () => {
    const { sql, params } = scopeCondition(s('proj', 'sess'), true);
    expect(sql).toBe(
      '(scope_user IS ? AND scope_project IS ? AND scope_session IS ?) OR ' +
      '(scope_user IS ? AND scope_project IS ? AND scope_session IS ?) OR ' +
      '(scope_user IS ? AND scope_project IS ? AND scope_session IS ?)',
    );
    expect(params).toEqual(['u1', 'proj', 'sess', 'u1', 'proj', null, 'u1', null, null]);
  });
});
