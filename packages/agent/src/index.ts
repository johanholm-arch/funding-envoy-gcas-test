import type { AssistantProvider } from "./provider.ts";
import { DemoProvider } from "./demo.ts";

export * from "./provider.ts";
export * from "./policy.ts";
export * from "./documents.ts";
export { DemoProvider, extractLabelled } from "./demo.ts";

/** Claude when a credential is configured and FE_ASSISTANT is not "demo"; otherwise the deterministic demo provider. */
export async function createProvider(): Promise<AssistantProvider> {
  const want = process.env.FE_ASSISTANT ?? (process.env.ANTHROPIC_API_KEY ? "claude" : "demo");
  if (want === "claude") {
    const { ClaudeProvider } = await import("./claude.ts");
    return new ClaudeProvider();
  }
  return new DemoProvider();
}
