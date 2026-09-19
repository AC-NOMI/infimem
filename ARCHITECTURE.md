# ARCHITECTURE — 架构与实现说明

> 状态:v1(2026-09-19,对应 v0.1 进度:W1-W2 已实现,CLI/评测待 W3-W4)。
> 本文回答"代码怎么组织、为什么这样组织"。功能契约见 FEATURES.md,使用者视角见 USAGE.md。
> ADR-1/2/3(索引派生、supersedes 软删除链、D1/D2)在 W4 成文,本文的"决策记录"表是它们的索引。

---

## 1. 系统总览

单进程、单文件。MCP 客户端(Claude Code / Cursor / 自研 agent)通过 stdio 起一个 `infimem` 子进程,进程内是引擎,引擎底下是唯一一个 SQLite 文件——正文、FTS、向量、治理数据都在里面。

```
MCP 客户端 (LLM 在这一侧,D1:抽取与答案生成都归它)
   │  stdio JSON-RPC (@modelcontextprotocol/sdk)
   ▼
src/mcp/server.ts ─── 4 个工具:remember / search / forget / compact
   │                   initialize 时下发 SERVER_INSTRUCTIONS(使用指引)
   ▼
引擎层(纯 TypeScript 函数,不感知 MCP)
   ├─ ingest/ingest.ts      写入管线
   ├─ retrieval/search.ts   检索管线
   └─ governance/           forget / compact / audit
   ▼
基础层
   ├─ db/connection.ts      打开库 + PRAGMA + 加载 sqlite-vec + 迁移
   ├─ db/migrate.ts         user_version 迁移
   ├─ schema/               zod 契约 + canonical key + 行映射
   └─ embeddings/           EmbeddingProvider 接口 + hash 默认实现
   ▼
SQLite 单文件(WAL)
   memories(唯一事实源)+ memories_fts + memories_vec(可重建派生物)
   + conflicts + audit_events + idempotency_keys(治理)
```

**依赖方向规则**:接入层 → 引擎层 → 基础层,禁止反向。引擎层函数不 import mcp/;schema 不 import 引擎。这保证 CLI(未来)与评测脚本可以绕过 MCP 直接调用引擎。

## 2. 模块地图(全部当前文件)

| 文件 | 职责 | 关键点 |
|---|---|---|
| `db/connection.ts` | `openDb(path)` | WAL、foreign_keys、`sqliteVec.load`、迁移,顺序敏感(vec 必须在迁移建 vec0 表前加载) |
| `db/migrate.ts` | 迁移数组 + `user_version` 推进 | 迁移只追加不修改;M001 一次建齐全部表 |
| `schema/memory.ts` | zod 契约 | `rememberInputSchema` / `scopeSchema`;类型枚举冻结四类 |
| `schema/keys.ts` | 归一化、内容哈希、自动 canonical key | NFC + 小写 + 空白压缩 |
| `schema/row.ts` | `MemoryRecord` + 行映射 | MEMORY_COLUMNS 全部带表名限定(FTS join 需要) |
| `ingest/ingest.ts` | remember 全管线 | 见 §3.1 |
| `retrieval/search.ts` | search 全管线 | 见 §3.2;`sanitizeMatchQuery` 防 FTS5 语法注入 |
| `retrieval/scope.ts` | 作用域 SQL 条件 | 路径展开:session→project→user(可关) |
| `retrieval/rerank.ts` | Reranker 接口 + Identity | v0.2 换本地关键词/API 实现 |
| `governance/audit.ts` | 审计写入 | detail 永不含正文 |
| `governance/forget.ts` | tombstone + 双索引清理 | 见 §3.3 |
| `governance/compact.ts` | 报告 + 索引重建 | 见 §3.4 |
| `embeddings/hash.ts` | 默认 provider | 词元+CJK 二元组 → fnv1a 特征哈希 → L2 归一化,384 维,确定性 |
| `mcp/server.ts` | 4 工具 + instructions | 工具 shape 宽松,**校验权统一在引擎 zod** |

## 3. 三条数据流(对着代码讲)

### 3.1 写入:`remember(db, provider, input)` — ingest/ingest.ts

1. **zod 校验**:失败抛 `ValidationError`(issues 带回);`scope` 在此处显式二次解析(zod 的 `.default({})` 不会重跑内层 schema——实测踩过的坑)。
2. **embedding 在事务外计算**:纯计算、可能失败。失败不拒绝写入,降级 `vec_pending=1`(检索时该条只走 FTS 路)。这一步放事务外还有个原因:better-sqlite3 事务是同步的,未来 async provider(openai)不能堵在事务里。
3. **同步事务内依次**:幂等键命中→原样返回首次结果;同 canonical_key + 同内容哈希 + 同作用域路径→`duplicate` no-op;声明 supersedes→校验目标存在且 active,旧版本置 `superseded`;同 key 不同内容的活跃版本→全部记入 `conflicts`(**不静默覆盖**),`action='conflict'`;INSERT memories → INSERT memories_vec(同一事务)→ 审计 → 幂等映射落表。
4. **canonical_key 的唯一性按作用域路径判定**:`(user, project, session)` 三列 IS 匹配。不同 project 记"周五发版"是两条记忆。

### 3.2 检索:`search(db, provider, input)` — retrieval/search.ts

1. **召回(双路并行语义,串行执行)**:
   - FTS 路:用户查询经 `sanitizeMatchQuery`(提取词元→逐个 `"tok"*` 前缀→OR)变成安全的 MATCH 表达式,零词元则跳过;SQL 内联完成 scope/status/敏感级/类型过滤,BM25 取 Top-50。
   - 向量路:查询向量化 → vec0 KNN Top-150(超量)→ JS 后置过滤(同条件)+ `maxDistance` 截断(默认 0.95)。
2. **融合**:RRF(k=60),`score = Σ 1/(60+rank)`;两路都命中的记忆分数累加——这是最自然的信号融合。
3. **重排**:Reranker 钩子,v0.1 是 Identity(保 RRF 序并回填 rerank 分)。
4. **组装**:截断 Top-K,扁平引用结构(`id/content/type/scope/.../scores.fts|vec|rrf`)+ `trace`(两路候选数、reranker 名、分段耗时)。每条结果可回答"为什么被召回"。

### 3.3 遗忘:`forget` — governance/forget.ts

按 id 或"canonical_key + 作用域"定位**活跃**记忆 → `status='deleted'`(tombstone,不物理删)→ 显式从 FTS 删行(UPDATE 会触发 AU 触发器重写 FTS,所以删完 UPDATE 后要再补一次 `'delete'` 插入)→ 按 metadata 回链删向量 → 逐条审计。物理清除留给 v0.2 的导出后清除流。

### 3.4 整理:`compact` — governance/compact.ts

报告(记忆数、冲突数、版本链深度、vec_pending)是默认行为;`rebuildIndex` 时:embedding 事务外批量算 → 事务内 FTS `'rebuild'` 指令 + 清空 memories_vec 全量重灌 + 逐行清 `vec_pending`。这就是章程 §4.1"索引是可重建的派生物"的机械保障:**删掉两个索引表,一条命令恢复,正文无损**。

## 4. 存储布局

| 表 | 角色 | 可重建 |
|---|---|---|
| `memories` | 唯一事实源:正文 + 元数据 + supersedes 链 + status | — |
| `memories_fts` | FTS5 派生索引,external content 模式 + 三触发器同步 | `INSERT INTO memories_fts(memories_fts) VALUES('rebuild')` |
| `memories_vec` | vec0 派生索引,`distance_metric=cosine`,`memory_rowid` metadata 回链 | compact --rebuild-index |
| `conflicts` | 冲突对(a_id, b_id),UNIQUE 约束 | — |
| `audit_events` | 审计(动作/对象/参与者/摘要,无正文) | — |
| `idempotency_keys` | 幂等键 → (memory_id, 首次 action) | — |

为什么 metadata 回链而不是显式 rowid:见 §5 上游 bug。为什么 keywords 存 JSON 而非逗号串:对调用方是数组契约,对 FTS 是一段会被 tokenizer 自然切分的文本,一列两用。

## 5. 已知约束与上游 bug(实现期实测,ADR 素材)

1. **sqlite-vec 0.1.9 显式 rowid INSERT 路径损坏**:任何驱动下 `INSERT INTO v(rowid, embedding) VALUES(1, ?)` 都报 "Only integers are allows for primary key values"。对策:vec0 表声明 `memory_rowid integer metadata`,插入 embedding + metadata,自动分配 rowid;删除/回链全走 metadata。值得给上游提 issue。
2. **better-sqlite3 把 JS number 绑定为 FLOAT**:vec0 的 metadata 列要求 SQLITE_INTEGER,整数必须用 `bigint` 绑定。
3. **vec0 默认距离是 L2 不是余弦**:必须在建表时显式 `distance_metric=cosine`,否则 `maxDistance` 截断的语义(不相关 ≈ 1.0)失效。
4. **FTS5 unicode61 不切分 CJK**:整句中文成一个 token,子串匹配靠向量路(hash 的 CJK 二元组)兜底。v0.2 评估 trigram tokenizer。
5. **vec0 KNN 无预过滤**:大库上"超量取回后置过滤"会浪费,规模瓶颈留到 v0.3(章程已声明 non-goal:不做超大分布式)。

## 6. 决策记录(ADR 的索引)

| # | 决策 | 理由一句话 | ADR |
|---|---|---|---|
| 1 | 索引与正文分离,索引可重建 | 存储介质不决定检索精度 | ADR-1(W4) |
| 2 | 更新走 supersedes 软链,删除走 tombstone | 记忆有历史语义,原地 UPDATE 是谎言 | ADR-2(W4) |
| 3 | 抽取在调用方(D1)、默认 hash embedding(D2) | 零依赖离线、评测可复现 | ADR-3(W4) |
| 4 | 冲突隔离而非静默覆盖/自动合并 | 记忆冲突的裁决权在用户,不在引擎 | 纳入 ADR-2 |
| 5 | canonical_key 唯一性按作用域路径 | 跨 project 的同文本不是重复 | 纳入 ADR-2 |
| 6 | embedding 在事务外 + vec_pending 降级 | 写入可用性优先于向量完备性 | 纳入 ADR-1 |
| 7 | 工具 shape 宽松、校验权在引擎 zod | 错误语义单一出口,MCP 层薄 | — |

## 7. 测试策略

- **单测(tests/unit/,67 个)**:一源一测。ingest 全路径(幂等/去重/冲突/supersedes/降级/审计)是重灾区,因为这是本项目区别于"SQLite 封装"的全部证据。
- **MCP 集成**:SDK 的 `InMemoryTransport` + Client 走真实协议roundtrip(listTools / callTool / isError / getInstructions),不 mock 协议层。
- **约定**:测试状态而非交互(不 mock db);每个上游兼容性约束(§5)都有对应断言钉住,升级 sqlite-vec 时如果上游修复,测试会告诉我们哪些对策可以拆掉。
- **待补(W3-W4)**:评测套件 30 case 进 CI,Recall@K/MRR 退化 >2% 卡合并——数字层面的回归保护。

## 8. 演进触点(v0.2/v0.3 改哪里)

- Reranker 接口已留好:v0.2 加本地关键词/API 实现,引擎不动。
- EmbeddingProvider 接口已留好:v0.2 加 ONNX 本地模型 / openai 适配器,换 provider 后 `compact(rebuildIndex)` 重建;维度变更需要新迁移(384 硬编码在 M001)。
- 敏感级人工确认流(v0.2):在 remember 管线第 2 步后插"待确认"状态,管线其余不变。
- 多租户(v0.3):scope_user 之上加 namespace 列,查询条件同源展开。

---

*本文随代码演进修订;实现与本文不一致时,要么改代码,要么改本文,不允许静默漂移。*
