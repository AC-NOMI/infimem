# LoCoMo 检索级评测 — llm + BAAI/bge-m3 (k=5)

对话 1 · 记忆 171 条(均 171/对话) · 计分 QA 149

| 指标 | 值 |
|---|---|
| Answer-hit@5 | 0.128 |
| MRR | 0.106 |
| Answer F1(LLM 答题) | 0.167 |
| Evidence-recall@5 | 0.040 |

| 类别 | QA | Answer-hit@5 | Evidence-recall@5 |
|---|---|---|---|
| single-hop | 31 | 0.032 | 0.065 |
| temporal | 37 | 0.027 | 0.054 |
| open-domain | 11 | 0.000 | 0.000 |
| multi-hop | 70 | 0.243 | 0.029 |
| adversarial | 47 | 0.000 | 0.021 |