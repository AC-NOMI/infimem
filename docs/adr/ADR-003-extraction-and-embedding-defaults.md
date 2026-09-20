# ADR-003 — 抽取在调用方(D1)与默认 hash embedding(D2)

状态:已接受(2026-09,设计期定稿,W3 实现落地)

## 背景

记忆引擎需要两个"智能"环节:把对话内容抽取为结构化记忆,以及给文本做向量。行业常规(mem0 等)是引擎内部再调一次 LLM + 托管 embedding API——代价是:必须配 API key、有网络依赖、每次写入有成本与延迟、评测不可复现。

## 决策

**D1|抽取在调用方,引擎不内置 LLM。**
- MCP 场景:调用方本来就有 LLM,tool schema 就是"表单"——抽取发生在客户端模型生成 tool-call 参数的那一刻。
- 引擎侧的补偿:`instructions` 字段随 initialize 下发使用指引;工具 description 内嵌参数范例。
- CLI 导入原始文本的场景:Extractor 接口,v0.1 提供规则版;LLM 适配器留接口。

**D2|默认 embedding = 特征哈希(词元 + CJK 二元组,fnv1a,384 维,L2 归一化)。**
- 确定性、零依赖、离线可用 → 评测在 CI 里可复现(章程 §8 的前提)。
- 诚实定价:语义泛化弱(接近词面匹配)。评测如实报告:paraphrase 类 2/5,治理/时序/作用域类 5/5。
- `OpenAIEmbeddingProvider` 随 v0.1 提供(设 key 即用),共用 `EmbeddingProvider` 接口;本地 ONNX 小模型列为 v0.2。

## 后果

- 正面:npx 即跑、零 key 零网络;评测数字在 CI 完全可复现;引擎是纯确定性组件,审计与合规叙事成立。
- 负面:开箱检索质量上限受限(词面 + CJK 二元组);抽取质量依赖调用方模型,由评测 ingest case 持续校验。
- 检验:D2 的短板被评测集显式度量(paraphrase 类),换 provider 后的对比就是 v0.2 的第一张成绩单。
