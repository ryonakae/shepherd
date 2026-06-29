#!/usr/bin/env node
import { resolve } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";
import { runGatewayService } from "@/gateway/service.js";

async function main(): Promise<void> {
  if (argv.length > 2) {
    throw new Error("shepherd-gateway does not accept CLI arguments");
  }
  await runGatewayService();
}

if (fileURLToPath(import.meta.url) === resolve(argv[1] ?? "")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    exit(1);
  });
}
