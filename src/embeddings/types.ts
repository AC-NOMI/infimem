export interface EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  embed(text: string): Promise<Float32Array>;
}
