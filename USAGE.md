# USAGE — 使用者视角:接入与日常使用

> 状态:v1 设计稿(2026-09-18)。开发视角的契约见 FEATURES.md;用户实际要做的步骤以本文件为准,README 快速上手将由此改写。

---

## 1. 三类使用者,各自要做的事

| 使用者 | 第一次 | 日常 | 典型:章程 §3 目标用户 |
|---|---|---|---|
| **MCP 用户**(主路径) | 改一段配置 | 只管自然对话 | Claude Code / Cursor 个人开发者 |
| **CLI 用户** | 一条建库命令 | 命令行读写 | 本地脚本、批量导入 |
| **自研 Agent 开发者** | 进程里接 stdio | 代码调 4 个工具 | Agent 平台 |

共同点:**不需要装数据库服务、不需要 API key、不需要懂 schema**。

## 2. 主路径:Claude Code / Cursor 用户

### 2.1 接入(唯一要做的一步)

Claude Code:

```bash
claude mcp add infimem -- npx -y infimem@latest mcp
```

Cursor / 通用 MCP 客户端(mcp.json):

```json
{
  "mcpServers": {
    "infimem": {
      "command": "npx",
      "args": ["-y", "infimem@latest", "mcp"],
      "env": { "INFIMEM_DB": "~/.infimem/memory.db" }
    }
  }
}
```

就这样。首次启动 server 自动建库(默认 `~/.infimem/memory.db`,可用 `INFIMEM_DB` 改);4 个工具自动注册;数据库就是那一个文件,备份 = 复制文件。

### 2.2 接入后:你只管说话

记忆的写入与检索由**客户端 LLM 决定何时调用工具**,用户不需要记命令:

| 你说 | agent 会做 |
|---|---|
| "记住我部署后端用 pnpm,不用 npm" | `remember`(type=preference, scope=user) |
| "我后端平时怎么装依赖?" | `search` → 引用着记忆回答 |
| "以后别用那个旧仓库了" | `remember` 一条新记忆 supersedes 旧的(经 canonical_key 判定) |
| "忘掉我说过的 XX" | `forget` |
| (无需指令)每次相关提问 | agent 主动 `search`,你看到带引用来源的回答 |

### 2.3 让 agent 记得更主动(可选)

MCP server 会在 initialize 响应里返回 `instructions`(使用指引:何时 remember、何时 search、scope 怎么填),标准客户端会读它,**多数人不需要再做任何事**。想让行为更强,可在 CLAUDE.md / 系统提示里加一段(文档提供现成模板):

```markdown
## 长期记忆(infimem)
- 用户陈述稳定事实/偏好/决定时,调用 remember(标注 type 与 keywords)
- 回答涉及用户背景、既往决定前,先 search;回答须引用返回的来源
- 用户明确要求忘记时调用 forget;不要静默忽略
```

## 3. CLI 用户

```bash
npx infimem init                          # 显式建库
npx infimem add "用户偏好 pnpm" --type preference --keywords pnpm,包管理
npx infimem search "怎么装依赖" --k 5
npx infimem forget <id>
npx infimem export memories.jsonl         # 全字段导出,随时可迁走
npx infimem import memories.jsonl
npx infimem compact --rebuild-index       # 升级/换 embedding 后重建索引
npx infimem eval --suite ./my-cases       # 自建 case 跑评测
```

## 4. 自研 Agent 开发者

- **接入**:`spawn` 一个 `infimem mcp` 子进程,MCP stdio 协议,无端口、无鉴权面(本机单用户)。
- **scope 映射约定**(建议):`project` = 项目名或仓库 id,`session` = 会话 id;不传则落 user 作用域。
- **重试**:写操作带 `idempotency_key` 即可安全重试,引擎保证不重复入库。
- **敏感数据**:写入时标 `sensitivity: "sensitive"`,检索默认 `max_sensitivity: normal` 不会带出。
- **HTTP 接入**(v0.1.1 新增,无 MCP 运行时的场景):`infimem serve --port 8787 --token <key>`;`GET /health`、`POST /add`(参数同 remember 工具)、`POST /search`(参数同 search 工具),JSON 直传,校验语义与 MCP 完全一致。

## 5. 数据在用户手里

| 诉求 | 做法 |
|---|---|
| 看存了什么 | `infimem search` 或任何 SQLite 工具打开库文件 |
| 备份 / 换机器 | 复制单个 `.db` 文件 |
| 导出可读格式 | `infimem export`(JSONL,全字段含来源) |
| 彻底删除 | `forget`(逻辑删)→ v0.2 提供"导出后物理清除";现在直接删文件即全清 |
| 审计 | 库内 `audit_events` 表,只记动作不记正文 |

## 6. 使用者明确不用做的事

装/部署任何服务(无 Postgres、无向量库、无 Redis)、申请 embedding API key(默认离线)、设计记忆 schema、手动去重或处理冲突(引擎隔离并提示)、写迁移脚本(升级自动迁移)。

## 7. 使用视角回写 FEATURES.md 的设计决策

1. **MCP 首跑自动建库**(原设计只有 CLI `init`),默认库路径 `~/.infimem/memory.db`。
2. **server 在 MCP initialize 响应中返回 `instructions` 字段**承载使用指引——这是"引擎不内置 LLM"(FEATURES 决策 D1)在客户端侧的补偿机制:指引由 server 分发,而不是要求每个用户手改 CLAUDE.md。
3. 4 个工具的 description 内嵌最小参数范例,降低调用方 LLM 填错字段率(评测的 ingest case 需覆盖)。

---

*README 的 Quickstart 将以本文件 §2 为底稿。*
