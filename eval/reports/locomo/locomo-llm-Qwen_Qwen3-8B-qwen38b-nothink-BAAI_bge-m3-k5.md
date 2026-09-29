# LoCoMo 检索级评测 — llm + BAAI/bge-m3 (k=5)

对话 1 · 记忆 241 条(均 241/对话) · 计分 QA 149

| 指标 | 值 |
|---|---|
| Answer-hit@5 | 0.148 |
| MRR | 0.103 |
| Answer F1(LLM 答题) | 0.202 |
| Evidence-recall@5 | 0.110 |

| 类别 | QA | Answer-hit@5 | Evidence-recall@5 |
|---|---|---|---|
| single-hop | 31 | 0.097 | 0.059 |
| temporal | 37 | 0.000 | 0.108 |
| open-domain | 11 | 0.000 | 0.227 |
| multi-hop | 70 | 0.271 | 0.114 |
| adversarial | 47 | 0.000 | 0.064 |