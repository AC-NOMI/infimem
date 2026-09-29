# LoCoMo 检索级评测 — llm + BAAI/bge-m3 (k=5)

对话 1 · 记忆 246 条(均 246/对话) · 计分 QA 149

| 指标 | 值 |
|---|---|
| Answer-hit@5 | 0.141 |
| MRR | 0.095 |
| Answer F1(LLM 答题) | 0.186 |
| Evidence-recall@5 | 0.117 |

| 类别 | QA | Answer-hit@5 | Evidence-recall@5 |
|---|---|---|---|
| single-hop | 31 | 0.065 | 0.065 |
| temporal | 37 | 0.000 | 0.135 |
| open-domain | 11 | 0.000 | 0.227 |
| multi-hop | 70 | 0.271 | 0.114 |
| adversarial | 47 | 0.000 | 0.064 |