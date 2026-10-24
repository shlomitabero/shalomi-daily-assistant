import { fetchAnthropic } from "./anthropicFetch.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Part 1 of the Lovable.dev/Base44-style upgrade שלומי asked for (round
 * 925): the system prompt a future "AI Code Mode" agent sends to Claude.
 * This is a NEW, separate generation path from the existing
 * AnthropicSpecProvider (anthropic.ts) -- that one outputs a ProductSpec
 * JSON object that packages/api/codegen.ts then deterministically
 * template-generates into a fixed React CRUD app. This agent instead
 * writes (and later patches) real application files directly, the way
 * Lovable/Base44 do. The two paths are kept independent on purpose: the
 * live product's existing spec-driven projects must keep working exactly
 * as they do today while this new path is built out and proven, not be
 * put at risk by it.
 */
export const ELITE_SYSTEM_PROMPT = `You are an elite AI software engineer building production-grade web applications, in the style of Lovable.dev and Base44.

## UI/UX Excellence
Every app you build must look like a polished, modern SaaS product (the visual bar of Linear, Vercel, and Stripe) --
never a generic, unstyled scaffold. Use React, TypeScript, Tailwind CSS, lucide-react icons, and shadcn/ui
components. Use refined spacing and a restrained color palette, subtle borders rather than heavy drop shadows,
smooth transitions via framer-motion, real skeleton loaders while data is loading, a designed empty state for
every list/table that can be empty, toast notifications (sonner) for the outcome of every user action, and
layouts that work correctly on a narrow mobile viewport, not just desktop.

## Full-Stack Completeness
Never ship a static mock shell unless the user explicitly asked for one. Design a clean data schema, real state
management, full create/read/update/delete flows, and real form validation with Zod. Leave the app ready to add
authentication, even if auth itself isn't requested yet.

## Modular & Complete Code
Never put everything in one file. Split code across /components, /pages, /hooks, /lib, and /types, each file
doing one clear job. Every file you write must be complete and immediately compilable: never leave a "// TODO"
or "// ... rest of the code" placeholder, and never write a patch that references code you haven't shown.

## Structure of Your Response
Before writing any code, output one <thought> block: a short, concrete plan of the files you'll touch and the
UX decisions you're making. Then stream your actions using exactly these tags, nothing else:

- <file path="relative/path.tsx">...</file> -- the file's ENTIRE new contents, for a new file or a full
  rewrite of an existing one.
- <patch path="relative/path.tsx">...</patch> -- one or more surgical edits to an EXISTING file, each shaped
  exactly like this, with the literal markers on their own lines:
  <<<<<<< SEARCH
  (the exact existing text to find -- must match the file's current content exactly, and must appear only
  once in the file)
  =======
  (the text to replace it with)
  >>>>>>> REPLACE
  Use <patch> whenever you are changing part of a file that already exists; use <file> only for a brand-new
  file or when the change is so pervasive that a full rewrite is clearer than a patch.
- <shell>a single command to install a package or run a script</shell>

Never use any other tag, and never write prose outside a <thought> block.`;

export type AgentAction =
  | { type: "thought"; content: string }
  | { type: "file"; path: string; content: string }
  | { type: "patch"; path: string; hunks: PatchHunk[] }
  | { type: "shell"; command: string };

export interface PatchHunk {
  search: string;
  replace: string;
}

// Matches one <<<<<<< SEARCH / ======= / >>>>>>> REPLACE hunk. The markers
// must each sit alone on their own line (the format the system prompt
// above instructs), which is also what keeps this from misfiring on a
// file's own content that merely happens to mention the word "SEARCH" or
// "REPLACE" elsewhere.
const HUNK_PATTERN = /^<{7} SEARCH\r?\n([\s\S]*?)\r?\n^={7}\r?\n([\s\S]*?)\r?\n^>{7} REPLACE$/gm;

/**
 * Parses the <patch>...</patch> body above into its individual
 * search/replace hunks. A patch block most commonly holds exactly one
 * hunk, but the system prompt allows several edits to the same file in
 * one <patch> block, so this always returns an array.
 */
export function parsePatchHunks(patchBody: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  for (const match of patchBody.matchAll(HUNK_PATTERN)) {
    hunks.push({ search: match[1], replace: match[2] });
  }
  return hunks;
}

// One combined scan across the whole response, in document order --
// matchAll preserves source order, which is what lets a <thought> that
// plans several files stay correctly interleaved with the <file>/<patch>/
// <shell> blocks that follow it, exactly as the model streamed them.
//
// Each tag's content is captured as the raw text up to the next LITERAL
// occurrence of its own closing tag, not via a real XML/HTML parser --
// genuine file content (JSX, HTML, comparison operators) is not itself
// valid XML, so treating these as structural tags around opaque text is
// the same pragmatic approach Anthropic's own artifact format already
// uses, and matches this parser's one real assumption: the model never
// emits its own closing-tag string verbatim inside a file/patch/shell
// body.
const ACTION_PATTERN =
  /<thought>([\s\S]*?)<\/thought>|<file path="([^"]*)">([\s\S]*?)<\/file>|<patch path="([^"]*)">([\s\S]*?)<\/patch>|<shell>([\s\S]*?)<\/shell>/g;

/**
 * Part 2 of the round-925 upgrade: turns the elite agent's raw streamed
 * (or complete, non-streamed) response text into a structured, ordered
 * list of actions a caller can actually apply -- the "surgical code-diff
 * engine" parsing half. applyPatch (below) is the other half: actually
 * applying a <patch> block's hunks to a real file's current content.
 */
export function parseAgentResponse(text: string): AgentAction[] {
  const actions: AgentAction[] = [];
  for (const match of text.matchAll(ACTION_PATTERN)) {
    const [, thoughtContent, filePath, fileContent, patchPath, patchBody, shellCommand] = match;
    if (thoughtContent !== undefined) {
      actions.push({ type: "thought", content: thoughtContent.trim() });
    } else if (filePath !== undefined) {
      actions.push({ type: "file", path: filePath, content: fileContent });
    } else if (patchPath !== undefined) {
      actions.push({ type: "patch", path: patchPath, hunks: parsePatchHunks(patchBody) });
    } else if (shellCommand !== undefined) {
      actions.push({ type: "shell", command: shellCommand.trim() });
    }
  }
  return actions;
}

export interface ApplyPatchResult {
  content: string;
  /** How many of the patch's own hunks were actually applied, in order. */
  appliedCount: number;
  /**
   * The first hunk index (0-based) that could not be applied, or null if
   * every hunk succeeded. A hunk fails when its `search` text doesn't
   * appear in the file's CURRENT content (stale: the model's patch was
   * written against an earlier version of the file) or appears more than
   * once (ambiguous: applying it could silently edit the wrong spot) --
   * the same "must match exactly once" discipline this codebase's own
   * Artifact-edit tooling already requires, for the identical reason:
   * guessing which occurrence was meant is how a patch silently corrupts
   * the wrong part of a file.
   */
  failedHunkIndex: number | null;
  failedHunkReason: "not_found" | "ambiguous" | null;
}

/**
 * Applies a <patch> block's hunks to an existing file's content, one hunk
 * at a time, in order -- each hunk's `search` must appear in the content
 * EXACTLY once (not found, or found more than once, both fail that hunk
 * rather than guess). Stops at the first failing hunk rather than
 * applying the rest out of order against content the failure already
 * left in an unexpected state; every hunk before the failure is still
 * applied and returned, so a caller can decide whether a partial
 * application is still safe to keep or should be discarded.
 */
export function applyPatch(originalContent: string, hunks: PatchHunk[]): ApplyPatchResult {
  let content = originalContent;
  for (let i = 0; i < hunks.length; i++) {
    const { search, replace } = hunks[i];
    const firstIndex = content.indexOf(search);
    if (firstIndex === -1) {
      return { content, appliedCount: i, failedHunkIndex: i, failedHunkReason: "not_found" };
    }
    if (content.indexOf(search, firstIndex + 1) !== -1) {
      return { content, appliedCount: i, failedHunkIndex: i, failedHunkReason: "ambiguous" };
    }
    content = content.slice(0, firstIndex) + replace + content.slice(firstIndex + search.length);
  }
  return { content, appliedCount: hunks.length, failedHunkIndex: null, failedHunkReason: null };
}

export interface EliteAgentOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxTokens?: number;
}

export interface EliteAgentResult {
  rawText: string;
  actions: AgentAction[];
}

/**
 * Calls Claude with ELITE_SYSTEM_PROMPT and the user's own request,
 * returning both the raw text and its already-parsed actions. Not yet
 * wired into any live route or UI -- this round's scope is the prompt
 * and the parsing/patch-application engine (Parts 1-2) as a real, tested
 * building block, not the live wiring (a new project mode, file storage,
 * and UI) that would put the existing, already-live spec-driven product
 * at risk before this path is proven. Non-streaming for now (returns the
 * complete response in one call); real token-by-token streaming into a
 * UI is a later increment once this foundation is reviewed.
 */
export async function generateEliteCodeResponse(prompt: string, options: EliteAgentOptions): Promise<EliteAgentResult> {
  const response = await fetchAnthropic(
    options.fetchImpl ?? fetch,
    ANTHROPIC_API_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": options.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: options.model ?? "claude-sonnet-5",
        max_tokens: options.maxTokens ?? 8192,
        system: ELITE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      }),
    },
    options.timeoutMs,
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Anthropic API request failed (${response.status}): ${body}`);
  }

  let payload: { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
  try {
    payload = await response.json();
  } catch (err) {
    throw new Error(`Anthropic API response body was not valid JSON: ${(err as Error).message}`);
  }

  if (payload.stop_reason === "refusal") {
    throw new Error("Anthropic API refused to generate code for this request (stop_reason: refusal)");
  }

  const text = payload.content?.find((block) => block.type === "text")?.text;
  if (!text) {
    throw new Error("Anthropic API response contained no text content");
  }

  return { rawText: text, actions: parseAgentResponse(text) };
}
