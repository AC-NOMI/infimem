# EVALUATIONS — 评测方法论与公开数字

> 状态:v1(2026-09-20,对应 v0.1 基线)。章程 §8 的展开:评测集与代码同仓库,任何人可复现。

## 1. 复现方式

```bash
npm ci && npm run build
npm run eval              # 跑 30 case,报告写入 eval/reports/latest/
npm run eval:regress      # 对比 eval/reports/baseline.json,退化 >2% 退出码非零(CI 用)
```

Case 文件:`eval/suites/v1.jsonl`;基线:`eval/reports/baseline.json`(随影响检索/写入的 PR 更新,更新必须在 PR 描述中给出理由与新数字)。

## 2. Case 设计

30 条合成 case,6 类 × 5,每条自带语料(经真实 `remember` 管线注入独立内存库)与查询(走真实 `search` 管线):

| 类别 | 考察点 | v0.1 基线(Recall@5) |
|---|---|---|
| entity | 关键词/实体精确命中(FTS 主场) | 5/5 |
| paraphrase | 语义改写(向量路应兜底) | **2/5** |
| temporal | supersedes 后只应召回最新版本 | 5/5 |
| scope | 作用域隔离与祖先包含 | 5/5 |
| sensitivity | 敏感级检索侧硬过滤(泄漏必须为 0) | 5/5,泄漏 0 |
| conflict | 同 key 冲突版本应共存可见 | 5/5 |

全部 case 为合成数据,由作者编写并注明局限:语料规模小(每条 1-6 条记忆)、英文为主、无跨 case 干扰——它度量的是**行为正确性**(治理语义、版本链、过滤),不是大规模检索质量。

## 3. 指标定义

- **Recall@K**(K=1/5/10):期望命中项出现在前 K 的比例;期望为空(负向 case)不计惩罚。
- **MRR**:首个期望命中项排名倒数的均值。
- **引用正确率**:返回结果中期望项的占比(没有返回就没有错误引用)。
- **答案忠实度**:v0.1 为**词面 grounding 代理**——答案词元(简单去复数)被引用正文支持的比例;不是语义判断,LLM judge 列为 v0.2 并会在报告中注明。
- **P95 检索延迟**:全 case 检索耗时分布的 95 分位。
- **敏感泄漏**:maxSensitivity=normal 时敏感条目被返回的 case 数——**必须恒为 0**,该指标退化直接卡 CI,不受 2% 容差保护。

## 4. 当前基线(provider: hash,2026-09-20)

| Metric | Value |
|---|---|
| Recall@1 | 0.811 |
| Recall@5 | 0.900 |
| Recall@10 | 0.900 |
| MRR | 0.900 |
| Citation precision | 1.000 |
| Faithfulness(词面代理) | 0.917 |
| P95 latency | <1 ms(内存库,供回归对比;非生产延迟声明) |
| Sensitivity leaks | 0 |

(Recall@1 < Recall@5 是设计使然:conflict 类 case 的期望是 2-3 个并存版本,Recall@1 只计第一名。)

**跨平台复现证据**:v0.1.0 的首次 CI 运行(ubuntu-latest, x64)与本地基线(macOS, arm64)全部指标逐位一致,低于满分的三条 case(p2/p3/p5)也完全相同——确定性管线跨平台可复现是本项目的验收标准之一,此后每次 CI 都在对这条性质做持续校验。

## 5. 诚实声明与计划

- 默认 hash embedding 是词面级:paraphrase 类 2/5 是它的真实水平,不是 bug。这是 ADR-002/003 决策(零依赖、可复现)的**已定价代价**;v0.2 引入本地 ONNX provider 后,同一套 case 的对比数字就是升级依据。
- 合成数据的局限:真实记忆库的语料噪声、时序跨度、多用户干扰远比 case 复杂;本次评测不声称代表生产表现。
- 禁止事项(章程 §8):不使用私有数据集;不写"内部测试表明"这类不可验证表述;每次发版附随版本的可复现报告。
