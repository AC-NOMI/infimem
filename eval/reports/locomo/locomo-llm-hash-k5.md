# LoCoMo 检索级评测 — llm + hash (k=5)

对话 1 · 记忆 167 条(均 167/对话) · 计分 QA 149

| 指标 | 值 |
|---|---|
| Answer-hit@5 | 0.067 |
| MRR | 0.056 |
| Answer F1(LLM 答题) | 0.095 |
| Evidence-recall@5 | 0.023 |

| 类别 | QA | Answer-hit@5 | Evidence-recall@5 |
|---|---|---|---|
| single-hop | 31 | 0.032 | 0.016 |
| temporal | 37 | 0.027 | 0.054 |
| open-domain | 11 | 0.000 | 0.000 |
| multi-hop | 70 | 0.114 | 0.014 |
| adversarial | 47 | 0.000 | 0.021 |