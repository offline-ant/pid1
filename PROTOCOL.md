# Native adapter transport

Drive Linux PID 1 through a private inherited socket, without putting process policy in native code. `native/pid1.c` implements the server; `src/adapter.ts` implements the client. Tools use this channel rather than creating workloads as Node children.

## Bootstrap and ownership

`pid1 -- AGENT [ARGS...]` refuses to start unless its PID is 1. It establishes its own process group, blocks asynchronous catchable signals, opens `signalfd`, creates a Unix stream socketpair, forks once, and execs AGENT. The agent gets one endpoint as descriptor 3 and `PID1_CONTROL_FD=3`. There is no listening socket or reconnection mechanism. Workloads do not inherit the control descriptor.

PID 1 owns direct workloads and adopts orphans. The model's `wait` request is the only place the adapter calls `waitpid`. Signal collection never consumes a child status. The bootstrap agent is itself a child of PID 1; its exit does not cause automatic reaping, restart, or adapter exit.

## Requests

Each request is a 4-byte unsigned big-endian payload length followed by that many bytes. The payload is UTF-8 fields, each terminated by a NUL, including the last field. The first two fields are a decimal request ID (`1..2147483647`) and an operation. Fields cannot contain NUL. Maximum payload: 65536 bytes. Maximum fields, including ID and operation: 512.

| Operation | Fields after ID and operation |
| --- | --- |
| `spawn` | cwd, stdout path, stderr path, environment-pair count, key/value pairs, argv elements |
| `signal` | signed target PID/group, signal number (`0..64` on Linux) |
| `wait` | positive child PID or `-1` for any child |
| `exit` | status (`0..255`) |

Spawn inherits the adapter environment and applies the supplied overrides. Empty cwd means inherit cwd; empty output paths mean inherit stdout/stderr. Otherwise output files open with append/create mode 0600. stdin is `/dev/null`. Both sides establish a process group whose ID equals the new PID. The child unblocks signals, removes `PID1_CONTROL_FD`, closes descriptors 3 and above using `close_range`, and calls `execvp`. A spawn reply confirms fork/group creation, not exec: child setup/exec failure writes its current stderr (possibly still inherited if setup failed before redirection) and exits 127. There is no exec handshake or rollback policy.

Signal directly calls `kill`. Negative targets address groups; zero addresses the adapter's group; `-1` has Linux broadcast semantics. There is no ownership allowlist beyond the namespace and kernel permission checks.

Wait calls `waitpid` with `WNOHANG | WUNTRACED | WCONTINUED` once. It can reap an exit or consume a stop/continue notification. It never blocks. `ECHILD` is a successful `pid:0, no_children:true` reply; an alive child with no available state yields `pid:0, no_children:false`. Wait repeatedly until `pid:0` after SIGCHLD; standard signals can coalesce, and there can be more than one available child status.

Exit calls `_exit` immediately without a reply. When PID 1 exits, Linux kills the namespace, including the agent. An outstanding exit request is expected to lose its channel.

## Replies and events

The reverse stream is newline-delimited UTF-8 JSON. Fixed keys/numeric values avoid needing a JSON parser in C. Replies include `id`, `ok`, and operation-specific fields. Syscall/argument failures use `ok:false, errno:<positive Linux errno>`; the agent client rejects that request. Example:

```json
{"id":1,"ok":true,"pid":3,"pgid":3}
{"id":2,"ok":true,"pid":3,"state":"exited","status":7}
{"id":3,"ok":true,"pid":0,"no_children":false}
{"id":4,"ok":false,"errno":3}
```

Wait states are `exited` with `status`, `signaled` with `signal` and `core`, `stopped` with `signal`, and `continued`.

Unsolicited events have no request ID:

```json
{"event":"boot","adapter_pid":1,"agent_pid":2}
{"event":"signal","signal":17,"sender_pid":3,"sender_uid":0,"code":1,"status":7}
```

Signal fields come from `signalfd_siginfo`. SIGCHLD status is a notification hint; `wait` is authoritative. Request replies and events can interleave, and a child event can precede its spawn reply. Requests execute in receive order. There is no total ordering guarantee between kernel signal generation and socket requests.

## Agent-side events and delivery

The host adds a monotonically increasing `sequence` and wall-clock ISO `time` to collected events. Operator lines, the startup task and explicitly requested timers enter the same queue. Timer delays use Node's local monotonic timers; wall-clock timestamps need not be monotonic. The default queue limit is 1024 events and delivery batch limit is 64. Operator lines are limited to 8192 JavaScript characters; timer IDs to 128 characters; outstanding timers to 1024.

At `turn_end`, completed turns drain one batch into a Pi custom message and request continuation. Critical sections prevent that drain, not collection. Nothing is pre-queued in Pi's steering queue, so even an event received before `begin` stays hidden until `end`. A model turn's tools execute sequentially. Idle settlement returns to a blocking queue wait. `poll_next` consumes a batch into its tool result instead of also injecting it.

A section has one boolean state, no lease or automatic release. Explicit polling inside one fails. If the model settles while locked, the host waits without delivering new input. Only an external kill can reliably rescue a permanently stalled agent. In-flight inference/tool actions are not preempted or rolled back by new input.

## Failure semantics

- Native framing violations, output backlog beyond 1 MiB, and unrecoverable adapter errors exit with status 70. Startup misuse exits 64. PID-1 exit destroys the namespace; this is fail-stop, not recovery.
- The native channel is nonblocking. A lost channel is closed, pending output discarded, and the adapter remains inert while draining signal notifications. There is no persistent kernel-event log after agent loss.
- The client bounds buffered input and writes to 1 MiB each. A malformed/unexpected reply or channel loss rejects outstanding requests and fails the agent. Event overflow, invalid operator input, extension failure, or an unrecoverable model error also fails the agent. No workloads are cleaned up on its behalf.
- No process limits, timeouts or restart decisions are embedded in the adapter. The container runtime's configured limits remain effective. The JS queue is bounded by event count, not total conversation/disk size.
- SIGKILL and SIGSTOP cannot be collected; SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGTRAP, SIGABRT and SIGSYS retain their inherited dispositions rather than turning synchronous faults into input. Signals 32/33 reserved by libc are not a supported control interface. Ordinary Linux signal queuing/PID-1 rules still apply.
