# LoCoMo 检索级评测 — llm + BAAI/bge-m3 (k=5)

对话 1 · 记忆 236 条(均 236/对话) · 计分 QA 149

| 指标 | 值 |
|---|---|
| Answer-hit@5 | 0.168 |
| Store-recall(答案在库率) | 0.235 |
| MRR | 0.135 |
| Answer F1(LLM 答题) | 0.193 |
| Evidence-recall@5 | 0.117 |

| 类别 | QA | Answer-hit@5 | Evidence-recall@5 |
|---|---|---|---|
| single-hop | 31 | 0.129 | 0.065 |
| temporal | 37 | 0.027 | 0.135 |
| open-domain | 11 | 0.000 | 0.091 |
| multi-hop | 70 | 0.286 | 0.136 |
| adversarial | 47 | 0.000 | 0.117 |