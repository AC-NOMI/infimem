# ADR-002 — 记忆生命周期:supersedes 软链、tombstone 与冲突隔离

状态:已接受(2026-09,W1-W2 实现期定稿)

## 背景

记忆与普通数据不同:它有历史语义("当时的记忆"是有意义的概念)、会互相矛盾、且"删除"在企业场景里必须是可审计的事件而非静默消失。原地 UPDATE 一条记忆,等于销毁证据。

## 决策

1. **更新 = supersedes 软链**:新版本 INSERT,旧版本 `status='superseded'` 并保留;`supersedes` 列构成版本链。检索永远只见 active 版本。
2. **删除 = tombstone**:`status='deleted'`,双索引同步移除,物理清除留给 v0.2 的导出后清除流;每次 forget 产生审计事件。
3. **冲突隔离**:同 canonical_key、同作用域路径、内容不同、且调用方未声明 supersedes → **双方保留 active**,写入 `conflicts` 表并在返回值中标记。引擎不裁决谁对——裁决权在用户,或留给后续 compact 流程。
4. **canonical_key 的唯一性按作用域路径 (user, project, session) 判定**:不同 project 记"周五发版"是两条记忆,不是重复。
5. 幂等键存独立映射表(key → memory_id + 首次 action):契约要求"重试原样返回首次结果",UNIQUE 列存不下首次 action。

## 后果

- 正面:时间旅行查询(v0.2)有数据基础;矛盾记忆显式可见而非静默覆盖;误删可从备份恢复全链。
- 负面:表会膨胀(superseded/tombstone 常驻);查询必须永远带 status 过滤(已由检索管线统一封装)。
- 检验:评测集 temporal 5/5、conflict 5/5——版本链与冲突共存是可测的行为,不是宣传语。
