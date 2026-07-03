import { runObservabilityDaemonService } from "@/daemon/service.js";

export async function runGatewayService(
  input: { environment?: NodeJS.ProcessEnv | undefined } = {},
): Promise<void> {
  await runObservabilityDaemonService(input);
}
