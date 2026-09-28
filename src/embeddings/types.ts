export interface EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  embed(text: string): Promise<Float32Array>;
  /**
   * 批量嵌入(可选):服务端一次请求处理多条,且顺序与输入一致。
   * 大批量摄取(v4 等 HTTP provider)必须实现,否则会成为吞吐瓶颈。
   */
  embedMany?(texts: string[]): Promise<Float32Array[]>;
}
