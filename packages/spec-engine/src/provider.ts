import type { ProductSpec } from "@forge/shared";

export interface SpecProvider {
  readonly name: string;
  /**
   * `isHebrewOverride`, when given, pins which language/script every
   * "label"/summary/role/assumption/question comes back in, instead of each
   * provider inferring it from whether `description` itself contains any
   * Hebrew character. Needed because `description` here is often a
   * CONCATENATION of the project's own established text plus new,
   * unrelated text (a /refine instruction, a clarifying-question answer) --
   * without this, one stray Hebrew word/name in that new text alone (e.g.
   * a pasted proper noun) flips an already-English project's entire set of
   * labels to Hebrew, not just whatever the new text was actually about.
   * Callers that already know the project's real, established language
   * (see routes/projects.ts's /refine and /answers) pass it explicitly
   * rather than letting the provider re-derive it from the mixed text.
   */
  generate(description: string, isHebrewOverride?: boolean): Promise<ProductSpec>;
}
