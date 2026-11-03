#!/usr/bin/env node
import { runRunBridge } from "./run-bridge.js";

void runRunBridge().catch((error) => {
  console.error("Failed to start Paperclip run bridge:", error);
  process.exit(1);
});
