# ADR-001 — 正文存储与检索索引分离,索引是可重建的派生物

状态:已接受(2026-09,W1-W2 实现期定稿)

## 背景

记忆引擎的检索精度由什么决定?如果把向量/全文索引当作"主数据"的组成部分,那么:索引损坏即数据损坏;换 embedding provider 意味着数据迁移;任何索引参数调整(距离度量、分词器)都是危险操作。

## 决策

1. `memories` 表是**唯一事实源**,保存正文与全部元数据(supersedes 链、status、审计关联)。
2. `memories_fts`(FTS5,external content + 触发器同步)与 `memories_vec`(sqlite-vec,metadata 回链)是**派生物**,随时可删可重建:`compact(rebuildIndex)` 从 memories 表全量重建。
3. embedding 在写入事务**外**计算;失败不拒绝写入,降级 `vec_pending=1`,由 compact 补齐——写入可用性优先于向量完备性。
4. 建库时确定向量维度并记录于 `infimem_meta`;v0.1 每库绑定一个 provider 维度。

## 后果

- 正面:索引参数可自由演进(实测就改过一次距离度量,零数据迁移);provider 可插拔;索引损坏自愈。
- 负面:compact 重建需要重算全部向量(有 provider 时产生 API 成本);维度切换在 v0.1 需新建库。
- 约束:任何绕过触发器直写 FTS 的代码都是 bug;检索必须永远过滤 `status='active'`。

## 实测依据

- W2 实现期将 vec0 距离从默认 L2 改为显式 cosine,仅改一行迁移,旧库重建即可迁移——分离原则的直接收益。
- compact 测试覆盖"FTS 被整体清空后一键恢复可检索"。
