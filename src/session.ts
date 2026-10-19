import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime,
  SessionManager, SettingsManager, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { Adapter } from "./adapter.js";
import { Events, eventMessage } from "./events.js";
import { createTools } from "./tools.js";

export type Log = (type: string, data: Record<string, unknown>) => void;

/** Delivery is decided AT the boundary, never pre-queued in Pi's steering queue.
 * Thus an event received before begin cannot leak into a critical section. */
export function eventExtension(events: Events, log: Log) {
  return (pi: ExtensionAPI) => {
    pi.on("turn_end", (boundary) => {
      if (boundary.outcome !== "completed") return;
      const batch = events.take();
      if (!batch.length) return;
      log("delivered", { via: "steer", sequences: batch.map((e) => e.sequence) });
      return {
        entries: [{ type: "custom_message" as const, customType: "pid1.events", content: eventMessage(batch), display: true }],
        continue: true,
      };
    });
  };
}

export async function createInitSession(adapter: Adapter, events: Events, stateDir: string, log: Log) {
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: process.env.PID1_AUTH_PATH ?? join(agentDir, "auth.json"),
    modelsPath: process.env.PID1_MODELS_PATH ?? join(agentDir, "models.json"),
  });
  const provider = process.env.PID1_PROVIDER ?? "openai-codex";
  const modelId = process.env.PID1_MODEL ?? "gpt-6.1-sol";
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) throw new Error(`Unknown model ${provider}/${modelId}`);
  const thinking = process.env.PID1_THINKING ?? "low";
  if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinking))
    throw new Error(`Invalid PID1_THINKING: ${thinking}`);
  const systemPrompt = await readFile(new URL("../src/system.md", import.meta.url), "utf8");
  // In-memory settings prevent accidental discovery of host extensions, tools,
  // retries and cache-warming policy. Context compaction remains a Pi mechanism.
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: true },
    cacheWarming: "off",
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(), agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionFactories: [eventExtension(events, log)],
  });
  await resourceLoader.reload();
  const { tools, dispose } = createTools(adapter, events, stateDir);
  const { session } = await createAgentSession({
    cwd: process.cwd(), agentDir, modelRuntime, model,
    thinkingLevel: thinking as "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
    settingsManager, resourceLoader,
    sessionManager: SessionManager.create(process.cwd(), resolve(stateDir, "sessions")),
    customTools: tools,
    tools: ["read", "write", "edit", ...tools.map((tool) => tool.name)],
  });
  session.agent.toolExecution = "sequential";
  await session.bindExtensions({ mode: "print", onError: (error) => {
    log("extension_error", { error });
    events.fail(new Error(`Pi extension failed: ${JSON.stringify(error)}`));
  } });
  session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      log("assistant", { text, stopReason: event.message.stopReason, error: event.message.errorMessage });
    } else if (event.type === "tool_execution_start") {
      log("tool_start", { tool: event.toolName, args: event.args });
    } else if (event.type === "tool_execution_end") {
      log("tool_end", { tool: event.toolName, isError: event.isError, result: JSON.stringify(event.result).slice(0, 8192) });
    }
  });
  log("ready", { provider, model: modelId, session: session.sessionManager.getSessionFile() });
  return { session, dispose: () => { session.dispose(); dispose(); } };
}
