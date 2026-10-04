# LoCoMo 检索级评测 — llm + BAAI/bge-m3 (k=5)

对话 1 · 记忆 248 条(均 248/对话) · 计分 QA 149

| 指标 | 值 |
|---|---|
| Answer-hit@5 | 0.181 |
| MRR | 0.143 |
| Answer F1(LLM 答题) | 0.202 |
| Evidence-recall@5 | 0.134 |

| 类别 | QA | Answer-hit@5 | Evidence-recall@5 |
|---|---|---|---|
| single-hop | 31 | 0.129 | 0.081 |
| temporal | 37 | 0.027 | 0.108 |
| open-domain | 11 | 0.000 | 0.136 |
| multi-hop | 70 | 0.314 | 0.171 |
| adversarial | 47 | 0.000 | 0.085 |