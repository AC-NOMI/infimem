# FEATURES — 功能设计(v0.1 为主,v0.2/v0.3 划界)

> 状态:v1 设计稿(2026-09-18)。依据 POSITIONING.md §7 拆解;与章程冲突处以章程为准。
> 定位提醒:本文件回答"做什么、做到什么程度算完成";模块内部实现细节归 ARCHITECTURE.md(待写)。

---

## 1. 功能总览

```
                    ┌─────────────────────────────────────────┐
                    │              infimem engine             │
  MCP 客户端 ──────▶│  ┌─────────┐   ┌──────────────────────┐ │
  (Claude Code 等)  │  │ mcp/    │──▶│ ingest/  写入管线     │ │
                    │  │ 4 tools │   │  校验→去重→冲突→提交  │ │
  CLI ─────────────▶│  └─────────┘   └──────────┬───────────┘ │
  (infimem ...)     │  ┌─────────┐   ┌──────────▼───────────┐ │
                    │  │ cli/    │──▶│ retrieval/ 检索管线    │ │
  评测 ────────────▶│  └─────────┘   │  召回→RRF→rerank→引用 │ │
                    │                └──────────┬───────────┘ │
                    │  governance/(审计·敏感级·遗忘)           │
                    │  embeddings/ extract/   ← 可替换 provider │
                    │        ┌──────────────────┐              │
                    │        │ SQLite 单文件     │              │
                    │        │ memories(正文)   │              │
                    │        │ + FTS5 + vec(派生)│              │
                    │        └──────────────────┘              │
                    └─────────────────────────────────────────┘
```

| 模块 | 职责 | 版本 |
|---|---|---|
| `schema/` | zod 类型 + SQL DDL + 迁移 | v0.1 |
| `ingest/` | 写入管线:校验、去重、冲突隔离、原子提交 | v0.1 |
| `retrieval/` | 四段检索管线:召回、RRF 融合、rerank 钩子、引用组装 | v0.1 |
| `governance/` | 审计事件、敏感级、遗忘(tombstone) | v0.1 骨架,v0.2 完整 |
| `embeddings/` | EmbeddingProvider 接口 + 默认零依赖实现 | v0.1 |
| `extract/` | Extractor 接口(导入原始文本用) | v0.1 规则版 |
| `mcp/` | MCP stdio Server,4 个工具 | v0.1 |
| `cli/` | 建库、读写、导入导出、跑评测 | v0.1 |
| `eval/` | 评测集、指标、报告、CI 回归对比 | v0.1 |
| 多租户 / HTTP server / 可插拔 embedding 扩展 | — | v0.3 |

**v0.1 硬性约束(验收时逐条核对)**:
1. 无网络、无 API key 时全部功能可用(默认 embedding 与抽取均为本地确定性实现)。
2. 全部状态存于单个 SQLite 文件,向量与全文索引是可重建的派生物。
3. 每次写入/遗忘产生审计事件;正文不入审计日志。

## 2. 数据模型

### 2.1 memories(唯一事实源,存正文)

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | UUID |
| `canonical_key` | TEXT | 去重键 = hash(type + 归一化 content);调用方可显式提供。**唯一性按作用域路径 (user, project, session) 判定**:不同 project/session 的同文本不是重复(W1 实现时明确) |
| `type` | TEXT | `fact \| preference \| event \| procedure`(v0.1 冻结四类) |
| `content` | TEXT | 正文,检索引用的最小单元 |
| `keywords` | TEXT(JSON 数组) | 实体/关键词标签,调用方或抽取器提供,FTS 加权用 |
| `scope_user` | TEXT NOT NULL | 作用域路径三层:必填 |
| `scope_project` | TEXT NULL | 作用域路径三层:可空 |
| `scope_session` | TEXT NULL | 作用域路径三层:可空(最内层) |
| `sensitivity` | TEXT | `public \| normal \| sensitive`,默认 `normal` |
| `confidence` | REAL | 0~1,默认 0.8 |
| `source` | TEXT | `mcp \| cli \| import \| seed` |
| `source_ref` | TEXT NULL | 出处描述(URL/文件/会话 id),引用溯源用 |
| `supersedes` | TEXT NULL FK | 版本链:指向被本条替代的旧版本 |
| `status` | TEXT | `active \| superseded \| deleted`,**不物理删**(v0.1) |
| `idempotency_key` | TEXT UNIQUE | 调用方幂等键,可空。实现注记(W1):落在独立 `idempotency_keys` 映射表(key → memory_id + 首次 action),重试原样返回首次结果 |
| `created_at / updated_at` | TEXT | ISO8601 |

索引:`(scope_user, scope_project, scope_session, status)`、`(canonical_key, status)`。

**作用域语义(设计决策)**:scope 是一条路径而非单值——session 记忆默认可被同 project 检索到,project 记忆可被同 user 检索到(`include_ancestors`,默认开)。这是"文件式记忆透明性"与"分级隔离"的折中。

### 2.2 派生索引(可随时 drop + 重建)

- `memories_fts`:FTS5(content, keywords),BM25,external content 模式。
- `memories_vec`:sqlite-vec `vec0`,维度随 embedding provider(默认 384)。

章程 §4.1 的落地:`compact --rebuild-index` 必须能从 memories 表全量重建二者;索引损坏不影响正文正确性。

### 2.3 audit_events 与 conflicts

- `audit_events(id, ts, action, memory_id, actor, detail)`;action ∈ `write | supersede | forget | compact | purge`;`detail` 只存变更摘要(**不含正文**——审计日志本身可能被导出)。搜索默认不审计(查询词属隐私),留配置开关。
- `conflicts(a_id, b_id, created_at)`:冲突隔离的显式记录。

## 3. MCP 工具(章程冻结为 4 个)

| 工具 | 作用 |
|---|---|
| `remember` | 写入/更新一条记忆 |
| `search` | 混合检索,Top-K 带引用 |
| `forget` | 显式遗忘(tombstone + 审计) |
| `compact` | 整理:重建索引、冲突/版本链报告 |

MCP 的 tool schema(zod)本身就是"填表单"——**调用方 LLM 负责把自己的对话内容抽取为结构化字段**(章程"抽取只是填表"的落地方式);引擎默认不内置 LLM,详见 §4 决策 D1。

接入侧契约(使用者视角见 USAGE.md):server **首跑自动建库**(默认 `~/.infimem/memory.db`,`INFIMEM_DB` 可改),并在 MCP initialize 响应的 `instructions` 字段返回使用指引(何时 remember / search / forget、scope 填法)——调用方 LLM 的行为引导由 server 分发,不依赖用户手改 CLAUDE.md;4 个工具的 description 内嵌最小参数范例。

### 3.1 remember

| 参数 | 必填 | 说明 |
|---|---|---|
| `content` | ✓ | 正文 |
| `type` | | 默认 `fact` |
| `keywords` | | string[] |
| `scope` | | `{project?, session?}`;user 维度 v0.1 固定 `default`(多用户 v0.3) |
| `canonical_key` | | 不传则按规则生成 |
| `sensitivity` / `confidence` | | 默认 `normal` / 0.8 |
| `source_ref` | | 出处 |
| `supersedes` | | 显式指名要替代的旧 id |
| `idempotency_key` | | 重试安全 |

返回:`{id, action: created | duplicate | superseded | conflict, superseded_id?, conflict_with?}`。

### 3.2 search

| 参数 | 必填 | 说明 |
|---|---|---|
| `query` | ✓ | 自然语言或关键词 |
| `scope` | | 同上;默认 `include_ancestors: true` |
| `k` | | 默认 5,上限 20 |
| `max_sensitivity` | | 默认 `normal`——**检索侧硬过滤,v0.1 即生效**(章程把它列在 v0.2,但只存不过滤等于没治理,提前) |
| `type` | | 类型过滤 |

返回:results[]{id, content, type, scope, sensitivity, confidence, created_at, source_ref, scores{fts, vec, rrf, rerank}},外层附 `pipeline_trace`(各阶段耗时与候选数)。**每条结果能回答"为什么被召回"**——这是与黑盒记忆库的核心差异。

### 3.3 forget

参数:`id`(或 `canonical_key`)。行为:置 `status=deleted`(tombstone)+ 审计事件;从 FTS/vec 索引移除。物理清除仅 CLI 提供(v0.2 导出后清除流)。

### 3.4 compact

参数:`rebuild_index?`、`collapse_chains?`(默认 false,只报告不动数据)。返回报告:重复计数、版本链深度分布、冲突清单、索引是否重建、耗时。

## 4. 写入管线(`remember` 内部顺序)

1. **校验与归一化**(zod;content 截断上限 2000 字符,超限报错而非静默截断)。
2. **幂等检查**:`idempotency_key` 命中 → 原样返回首次结果。
3. **canonical_key 解析**:传入优先,否则 hash(type + 归一化 content)。
4. **完全重复检测**:同 key 且 content hash 相同 → `duplicate`,no-op(幂等的另一保障)。
5. **冲突处理(冲突隔离,不静默覆盖)**:
   - 调用方声明 `supersedes` → 旧条目置 `superseded`,新条目入链;
   - 同 key、内容不同、未声明 → **两条均保留 active**,写入 `conflicts` 表,返回 `conflict`;裁决推迟给调用方或 compact。
6. **原子提交**:memories + FTS + vec 三表写入在**同一事务**;embedding 失败则整体回滚(此时可降级为仅 FTS 入库并标记 `vec_pending`,不阻塞写入)。
7. **审计事件**。

## 5. 检索管线(`search` 内部顺序)

| 阶段 | 做法 | 可替换点 |
|---|---|---|
| 1. 召回 | FTS5 BM25 Top-50 ∪ sqlite-vec KNN Top-50;均先按 scope + status + sensitivity 过滤 | 召回器接口 |
| 2. 融合 | RRF(k=60):`score = Σ 1/(60+rank)` | 融合器接口 |
| 3. 重排 | Reranker 接口;v0.1 默认 Identity(即 RRF 序) | v0.2:本地关键词 rerank / API rerank |
| 4. 组装 | 截断 Top-K,附引用与各阶段分数、耗时 | — |

已知取舍:sqlite-vec 的 KNN 预过滤能力有限,v0.1 采用"超量取回后置过滤"(取 3k 再过滤),百万级以下够用;规模问题留给 v0.3。

## 6. Embedding 与抽取(两个关键决策)

**D1|抽取:调用方填表,引擎不内置 LLM。** MCP 场景下调用方本来就有 LLM,tool schema 即表单;CLI 导入场景走 Extractor 接口,v0.1 默认规则版(按行、前缀标记分类),LLM 适配器可选。理由:零依赖、可离线、评测可复现;代价是抽取质量取决于调用方,用评测集的 ingest case 校验。

D1 数据流(MCP 路径,引擎全程无 LLM 调用):

```
用户:"记住我部署用 pnpm"
  └─ 客户端 LLM 生成 tool-call,按 remember 的 JSON Schema 填参
     = 抽取发生在这里(模型 = 正在对话的那个)
       └─ infimem 收到结构化参数:zod 校验 → 去重/冲突 → 事务入库
search 同理:引擎内是纯确定性管线,引用编织进回答由客户端 LLM 完成
引擎内唯一可能触到 LLM 的位置:可选的 Extractor LLM 适配器(CLI 导入用,默认关闭)
```

**D2|Embedding:默认 `hash` 提供方。** 字符 n-gram 特征哈希,384 维,确定性、零依赖、离线可用——诚实地说它语义泛化弱(接近词面匹配),所以 FTS 才是 v0.1 召回的主力、向量是补语义改写的副手,评测数字按 provider 分别如实报告。`openai` 适配器随 v0.1 提供(设 key 即用),本地 ONNX 小模型列为 v0.2。两实现共用 EmbeddingProvider 接口,换 provider 后 `compact --rebuild-index` 重建。

## 7. CLI

```
infimem init   [--db path]           # 建库 + 迁移
infimem add    (结构化参数,同 remember)
infimem search <query> [--k N] [--scope ...]
infimem forget <id>
infimem import / export <file.jsonl>  # 全字段 JSONL
infimem compact [--rebuild-index]
infimem mcp                          # 启动 MCP stdio server
infimem eval   --suite <dir> [--report out/] [--baseline file]
```

配置:数据库路径 `--db` > `INFIMEM_DB` > `./infimem.db`;embedding provider `INFIMEM_EMBEDDING=hash|openai`。

## 8. 评测套件 v1(章程 §8 的落地)

- **Case 格式**(JSONL):`{id, corpus[], query, expected_ids[], tags}`;corpus 即该 case 需先注入的记忆(含同 key 不同版本、跨 scope 干扰项、敏感条目)。
- **构成(≥30 条,6 类 × 5)**:实体/关键词精确命中、语义改写、时序新旧(supersedes 后应只召回新版本)、scope 隔离(不应跨 scope 召回)、敏感过滤(不应召回 sensitive)、冲突共存(应同时返回并标记)。
- **指标**:Recall@K(K=1/5/10)、MRR、引用正确率(返回引用中 expected 占比)、答案忠实度(v0.1 用词面 grounding 代理:答案 token 须被引用正文支持;LLM judge 可选,开启时报告须注明)、P95 检索延迟(1k 条语料)。
- **报告**:JSON + Markdown 入仓库 `eval/reports/`;`--baseline` 对比,Recall@5 或 MRR 绝对退化 >2% 时退出码非零——CI 据此卡合并(章程 §4.6)。

## 9. v0.1 明确不做(对章程 §5 的具体化)

自动遗忘/TTL、时间旅行查询、敏感写入人工确认流、跨会话画像归并、HTTP server、GUI、Python 绑定、引擎内置 LLM、云同步。

## 10. 验收清单(映射章程 §7/§12)

- [ ] W1:Schema + 迁移;remember 全路径(幂等/去重/冲突/事务)单测覆盖
- [ ] W2:search 四段管线 + 分数透明返回;forget/compact;MCP 4 工具联调
- [ ] W3:CLI 全命令;import/export 往返一致;评测 30 case 跑通出报告
- [ ] W4:CI(vitest + eval 回归);README 架构图与评测数字;ADR-1(索引派生)、ADR-2(supersedes 软删除链)、ADR-3(D1/D2 抽取与 embedding 默认)→ 发 v0.1.0

---

*v0.2/v0.3 范围以章程 §7 为准,本文件仅在实现临近时细化。*
