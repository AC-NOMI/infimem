import type { Scope } from '../schema/memory.js';

/**
 * 作用域过滤条件。作用域是路径:session 记忆属于 project,project/session 记忆都属于 user。
 * 竞赛语义(重要):user_id 是隔离边界——按 user 检索必须能跨 session 看到该 user 的全部记忆,
 * 所以祖先链永远终止于 user 级(scopePairs 最后一个元素)。
 */
export function scopePairs(scope: Scope, includeAncestors: boolean): Array<[string | null, string | null]> {
  const project = scope.project ?? null;
  const session = scope.session ?? null;
  const exact: [string | null, string | null] = [project, session];
  if (!includeAncestors) return [exact];
  const pairs: Array<[string | null, string | null]> = [exact];
  if (session != null) pairs.push([project, null]);
  if (project != null) pairs.push([null, null]); // session-only 时 mid 已是 user 级,不重复
  return pairs;
}

export function scopeCondition(scope: Scope, includeAncestors: boolean): { sql: string; params: unknown[] } {
  const pairs = scopePairs(scope, includeAncestors);
  const sql = pairs.map(() => '(scope_user IS ? AND scope_project IS ? AND scope_session IS ?)').join(' OR ');
  const params = pairs.flatMap(([project, session]) => [scope.user, project, session]);
  return { sql, params };
}

export const SENSITIVITY_SQL = `(
  CASE memories.sensitivity WHEN 'public' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END
  <= CASE ? WHEN 'public' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END
)`;
