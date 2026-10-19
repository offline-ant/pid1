import { readFile, mkdir } from "node:fs/promises";
import { Socket } from "node:net";
import { resolve } from "node:path";
import { Adapter } from "./adapter.js";
import { Events, eventMessage } from "./events.js";
import { createInitSession, type Log } from "./session.js";

const log: Log = (type, data) => process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), type, ...data })}\n`);

async function main() {
  const fd = Number(process.env.PID1_CONTROL_FD);
  if (!Number.isInteger(fd) || fd < 3) throw new Error("Launch through the native PID 1 adapter; PID1_CONTROL_FD is required");
  const events = new Events(Number(process.env.PID1_EVENT_LIMIT ?? 1024), (event) => log("received", { event }));
  const adapter = new Adapter(new Socket({ fd, readable: true, writable: true }), (event) => events.push(event));
  adapter.disconnected.then((error) => events.fail(error));
  let runtime: Awaited<ReturnType<typeof createInitSession>> | undefined;
  let input = "";
  const operatorInput = (chunk: string) => {
    try {
      input += chunk;
      let end: number;
      while ((end = input.indexOf("\n")) >= 0) {
        if (end > 8192) throw new Error("Operator input line exceeds 8192 characters");
        const text = input.slice(0, end).trim();
        input = input.slice(end + 1);
        if (text) events.push({ event: "operator", text });
      }
      if (input.length > 8192) throw new Error("Operator input line exceeds 8192 characters");
    } catch (error) { events.fail(error instanceof Error ? error : new Error(String(error))); }
  };
  try {
    const stateDir = resolve(process.env.PID1_STATE_DIR ?? "/state");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    runtime = await createInitSession(adapter, events, stateDir, log);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", operatorInput);
    process.stdin.on("end", () => { if (input.trim()) operatorInput("\n"); });
    const task = process.env.PID1_TASK_FILE
      ? await readFile(process.env.PID1_TASK_FILE, "utf8")
      : process.env.PID1_TASK ?? "Observe the container. Start no workloads unless requested. Wait for events and operator requests; choose appropriate actions when they arrive.";
    events.push({ event: "task", text: task });
    const session = runtime.session;
    const run = async () => {
      for (;;) {
        await events.wait();
        const batch = events.take();
        log("delivered", { via: "idle", sequences: batch.map((e) => e.sequence) });
        await session.sendCustomMessage({ customType: "pid1.events", content: eventMessage(batch), display: true }, { triggerTurn: true });
        const last = session.messages.at(-1);
        if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted"))
          throw new Error(last.errorMessage ?? `Model ${last.stopReason}`);
        if (events.locked) log("critical_stalled", { pending: events.size });
        else log("idle", { pending: events.size });
      }
    };
    await Promise.race([run(), events.failed.then((error) => { throw error; })]);
  } finally {
    process.stdin.off("data", operatorInput);
    process.stdin.pause();
    if (runtime) {
      await runtime.session.abort();
      runtime.dispose();
    }
    adapter.close();
  }
}

main().catch((error: unknown) => {
  log("fatal", { error: error instanceof Error ? error.stack : String(error) });
  // Failing the agent does not decide a policy for the adapter or its workloads.
  process.exit(1);
});
