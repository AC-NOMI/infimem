import type { Scope } from '../schema/memory.js';

/**
 * 作用域过滤条件。作用域是路径:session 记忆属于 project,project 记忆属于 user。
 * includeAncestors=true 时,查询 session 作用域会同时命中同 project、同 user 的记忆。
 */
export function scopeCondition(scope: Scope, includeAncestors: boolean): { sql: string; params: unknown[] } {
  const exact: [string | null, string | null] = [scope.project ?? null, scope.session ?? null];
  const pairs: Array<[string | null, string | null]> = [exact];
  if (includeAncestors && scope.project != null) {
    if (scope.session != null) pairs.push([scope.project, null]);
    pairs.push([null, null]);
  }
  const sql = pairs.map(() => '(scope_user IS ? AND scope_project IS ? AND scope_session IS ?)').join(' OR ');
  const params = pairs.flatMap(([project, session]) => [scope.user, project, session]);
  return { sql, params };
}

export const SENSITIVITY_SQL = `(
  CASE memories.sensitivity WHEN 'public' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END
  <= CASE ? WHEN 'public' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END
)`;
