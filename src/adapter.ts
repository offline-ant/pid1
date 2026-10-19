import { Socket } from "node:net";
import { getSystemErrorName } from "node:util";

export type KernelEvent = { event: string; [key: string]: unknown };
export type Reply = { id: number; ok: boolean; errno?: number; [key: string]: unknown };

/** One private, inherited channel. Workloads never receive this descriptor. */
export class Adapter {
  readonly disconnected: Promise<Error>;
  private disconnectedResolve!: (error: Error) => void;
  private pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private input = "";
  private failure?: Error;

  constructor(private socket: Socket, onEvent: (event: KernelEvent) => void) {
    this.disconnected = new Promise((resolve) => { this.disconnectedResolve = resolve; });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      try {
        this.input += chunk;
        if (this.input.length > 1024 * 1024) throw new Error("Adapter input limit exceeded");
        let end: number;
        while ((end = this.input.indexOf("\n")) >= 0) {
          const message = JSON.parse(this.input.slice(0, end)) as Reply | KernelEvent;
          this.input = this.input.slice(end + 1);
          if ("event" in message) onEvent(message as KernelEvent);
          else {
            const reply = message as Reply;
            const pending = this.pending.get(reply.id);
            if (!pending) throw new Error(`Unexpected reply ${reply.id}`);
            this.pending.delete(reply.id);
            if (reply.ok) pending.resolve(reply);
            else pending.reject(new Error(`Adapter: ${getSystemErrorName(-(reply.errno ?? 22))}`));
          }
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        socket.destroy();
      }
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("PID 1 control channel closed")));
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.disconnectedResolve(error);
  }

  request(operation: string, fields: string[] = []): Promise<Reply> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.nextId > 2147483647) return Promise.reject(new Error("Request IDs exhausted"));
    const id = this.nextId++;
    const values = [String(id), operation, ...fields];
    if (values.length > 512 || values.some((value) => value.includes("\0")))
      return Promise.reject(new Error("Invalid request fields"));
    const payload = Buffer.from(values.join("\0") + "\0");
    if (payload.length > 65536) return Promise.reject(new Error("Request exceeds 65536 bytes"));
    // Bound writes as well as reads; do not hide a broken channel with retries.
    if (this.socket.writableLength + payload.length + 4 > 1024 * 1024)
      return Promise.reject(new Error("Adapter write queue limit exceeded"));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(Buffer.concat([header, payload]), (error) => {
        if (error) this.fail(error);
      });
    });
  }

  close(): void { this.socket.destroy(); }
}
