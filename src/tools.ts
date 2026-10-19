import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { constants } from "node:os";
import { join, resolve } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Adapter } from "./adapter.js";
import { Events } from "./events.js";

function tool<T extends TSchema>(name: string, description: string, parameters: T,
  execute: (args: Static<T>, signal?: AbortSignal) => Promise<unknown>): ToolDefinition<T> {
  return {
    name, label: name, description, parameters, executionMode: "sequential",
    execute: async (_id, args, signal) => {
      const details = await execute(args, signal);
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  };
}

export async function inspectProcesses(pid?: number) {
  const ids = pid === undefined
    ? (await readdir("/proc")).filter((s) => /^\d+$/.test(s)).map(Number).sort((a, b) => a - b)
    : [pid];
  const processes = [];
  for (const id of ids.slice(0, 256)) {
    try {
      const stat = await readFile(`/proc/${id}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      const fields = stat.slice(end + 2).split(" ");
      const cmdline = (await readFile(`/proc/${id}/cmdline`, "utf8")).slice(0, 4096).replaceAll("\0", " ").trim();
      processes.push({ pid: id, name: stat.slice(stat.indexOf("(") + 1, end), state: fields[0],
        ppid: Number(fields[1]), pgid: Number(fields[2]), command: cmdline });
    } catch (error) {
      if (pid !== undefined) throw error;
      // /proc is a live view; a disappearing process isn't a snapshot failure.
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return { processes, truncated: ids.length > 256 };
}

export function createTools(adapter: Adapter, events: Events, stateDir: string) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const tools = [
    tool("spawn", "Launch a direct child of PID 1 in its own process group. Returns before exec success is known. stdin is /dev/null; output appends to files. No automatic restart or reaping. Environment inherits the adapter's environment plus these overrides.", Type.Object({
      argv: Type.Array(Type.String(), { minItems: 1, maxItems: 256 }),
      cwd: Type.Optional(Type.String()),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      stdout: Type.Optional(Type.String()), stderr: Type.Optional(Type.String()),
    }), async (args) => {
      const logDir = join(stateDir, "logs");
      await mkdir(logDir, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const cwd = resolve(args.cwd ?? process.cwd());
      const stdout = resolve(cwd, args.stdout ?? join(logDir, `${id}.out`));
      const stderr = resolve(cwd, args.stderr ?? join(logDir, `${id}.err`));
      const env = Object.entries(args.env ?? {});
      const reply = await adapter.request("spawn", [cwd, stdout, stderr, String(env.length), ...env.flat(), ...args.argv]);
      return { ...reply, stdout, stderr };
    }),
    tool("signal", "Call kill(2). Positive target = PID; negative = process group; 0 = adapter's group; -1 = all permitted processes. Use numeric signals or names such as SIGTERM. No implicit forwarding.", Type.Object({
      target: Type.Integer({ minimum: -2147483647, maximum: 2147483647 }),
      signal: Type.Union([Type.String(), Type.Integer({ minimum: 0, maximum: 64 })]),
    }), async (args) => {
      const number = typeof args.signal === "number" ? args.signal : constants.signals[args.signal as keyof typeof constants.signals];
      if (number === undefined) throw new Error(`Unknown signal ${args.signal}`);
      return adapter.request("signal", [String(args.target), String(number)]);
    }),
    tool("wait", "Collect ONE child state using nonblocking waitpid in PID 1. pid=-1 means any child. Exits are reaped only here. After SIGCHLD, call repeatedly until pid=0; signals can coalesce. Also returns stopped/continued states. no_children distinguishes ECHILD from children still running.", Type.Object({
      pid: Type.Optional(Type.Integer({ minimum: -1, maximum: 2147483647 })),
    }), async (args) => adapter.request("wait", [String(args.pid ?? -1)])),
    tool("inspect", "Read /proc for one PID or the first 256 PIDs. A live view, not an atomic snapshot. Z means an unreaped zombie. Does not reap anything.", Type.Object({
      pid: Type.Optional(Type.Integer({ minimum: 1, maximum: 2147483647 })),
    }), async (args) => inspectProcesses(args.pid)),
    tool("poll_next", "Block until queued input is available, then return up to 64 events as this tool's result. Abortable. Idle turns already wait automatically. Not allowed inside a critical section.", Type.Object({}), async (_args, signal) => events.poll(signal)),
    tool("critical_section", "begin suppresses event delivery across model turns, not collection. end releases queued input at the next turn boundary. Not nestable, no lease or watchdog. Does NOT freeze processes or make syscalls atomic. Always end explicitly; settling inside one can wedge the agent.", Type.Object({
      action: Type.Union([Type.Literal("begin"), Type.Literal("end")]),
    }), async (args) => {
      if (args.action === "begin") events.enter(); else events.leave();
      return { critical: events.locked, pending: events.size };
    }),
    tool("timer", "Explicitly request a one-shot timer event, or cancel a requested timer. No timer automatically signals, restarts or exits anything. delay_ms uses the local monotonic timer; event timestamps use wall time.", Type.Union([
      Type.Object({ action: Type.Literal("set"), id: Type.String({ minLength: 1, maxLength: 128 }), delay_ms: Type.Integer({ minimum: 1, maximum: 2147483647 }) }),
      Type.Object({ action: Type.Literal("cancel"), id: Type.String({ minLength: 1, maxLength: 128 }) }),
    ]), async (args) => {
      if (args.action === "cancel") {
        const timer = timers.get(args.id);
        if (timer) clearTimeout(timer);
        return { cancelled: timers.delete(args.id) };
      }
      if (timers.has(args.id)) throw new Error(`Timer ${args.id} already exists`);
      if (timers.size >= 1024) throw new Error("Timer limit exceeded (1024)");
      timers.set(args.id, setTimeout(() => {
        timers.delete(args.id);
        // Queue exhaustion is an explicit agent failure, not silent event loss.
        try { events.push({ event: "timer", id: args.id }); }
        catch (error) { events.fail(error instanceof Error ? error : new Error(String(error))); }
      }, args.delay_ms));
      return { scheduled: args.id, delay_ms: args.delay_ms };
    }),
    tool("exit", "Exit PID 1 immediately with this status. Linux kills every remaining process in the PID namespace, including this agent. No reply or automatic graceful shutdown; do any desired signalling/waiting first.", Type.Object({
      status: Type.Integer({ minimum: 0, maximum: 255 }),
    }), async (args) => adapter.request("exit", [String(args.status)])),
  ];
  return {
    tools,
    dispose: () => { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); },
  };
}
