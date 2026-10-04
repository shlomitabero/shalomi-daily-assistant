import type { ProductSpec } from "@forge/shared";

export interface SpecProvider {
  readonly name: string;
  generate(description: string): Promise<ProductSpec>;
}
