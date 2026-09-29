# LoCoMo 检索级评测 — llm + BAAI/bge-m3 (k=5)

对话 1 · 记忆 385 条(均 385/对话) · 计分 QA 149

| 指标 | 值 |
|---|---|
| Answer-hit@5 | 0.101 |
| MRR | 0.079 |
| Answer F1(LLM 答题) | 0.121 |
| Evidence-recall@5 | 0.081 |

| 类别 | QA | Answer-hit@5 | Evidence-recall@5 |
|---|---|---|---|
| single-hop | 31 | 0.097 | 0.000 |
| temporal | 37 | 0.000 | 0.135 |
| open-domain | 11 | 0.000 | 0.091 |
| multi-hop | 70 | 0.171 | 0.086 |
| adversarial | 47 | 0.000 | 0.128 |