# LoCoMo 检索级评测 — llm + BAAI/bge-m3 (k=5)

对话 1 · 记忆 230 条(均 230/对话) · 计分 QA 149

| 指标 | 值 |
|---|---|
| Answer-hit@5 | 0.121 |
| MRR | 0.085 |
| Answer F1(LLM 答题) | 0.143 |
| Evidence-recall@5 | 0.052 |

| 类别 | QA | Answer-hit@5 | Evidence-recall@5 |
|---|---|---|---|
| single-hop | 31 | 0.065 | 0.024 |
| temporal | 37 | 0.000 | 0.108 |
| open-domain | 11 | 0.000 | 0.000 |
| multi-hop | 70 | 0.229 | 0.043 |
| adversarial | 47 | 0.000 | 0.021 |