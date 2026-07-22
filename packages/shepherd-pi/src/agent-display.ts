const HERDR_AGENT_TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;

const AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
  pi: "Pi",
};

function safeAgentToken(value: string): string | null {
  return HERDR_AGENT_TOKEN.test(value) ? value : null;
}

export function agentDisplayName(agent: string): string {
  const safeAgent = safeAgentToken(agent) ?? "unknown";
  return AGENT_DISPLAY_NAMES[safeAgent] ?? safeAgent;
}

export function agentIdentityLabel(input: {
  agent: string;
  name?: string | null | undefined;
}): string {
  const kind = agentDisplayName(input.agent);
  const name = input.name ? safeAgentToken(input.name) : null;
  return name ? `${name} · ${kind}` : kind;
}
