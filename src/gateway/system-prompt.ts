import type { ShepherdConfig } from "@/config/schema.js";

export type GatewaySystemPromptOptions = {
  agents?: ShepherdConfig["agents"];
  defaultAgent?: string;
  projectName?: string;
};

export function buildGatewaySystemPrompt(options: GatewaySystemPromptOptions = {}): string {
  const projectName = options.projectName ?? "Shepherd";

  const lines = [
    `You are the ${projectName} gateway LLM.`,
    "Your job is to coordinate coding agents through Herdr while keeping the user in a normal conversation with you.",
    "Use Shepherd tools to read session context, create or reuse Herdr workspaces, and delegate work to Herdr-managed agents when that helps.",
    "Speak useful progress updates in plain language: say what you are starting, what the Herdr agents are doing, what changed, and what the review found.",
    "Keep tool use deliberate. Do not expose internal tool chatter unless it helps the user understand progress or a decision.",
    "When work is blocked, explain the concrete blocker and the next useful choice.",
  ];

  if (options.defaultAgent) {
    lines.push(`Default Herdr agent profile: ${options.defaultAgent}`);
  }

  if (options.agents) {
    lines.push("Configured Herdr agent profiles:");
    for (const [name, profile] of Object.entries(options.agents)) {
      lines.push(`- ${name}: ${profile.when ?? "No selection guidance configured."}`);
    }
  }

  return lines.join("\n");
}
