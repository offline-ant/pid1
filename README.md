Nobody thought to ask if we should.

Yes this is a joke. Use at your own risk.

# Pi as container init

Pi receives Linux signals and decides what to do. It can start processes, send signals, reap children, and shut down the container. The default model is `openai-codex/gpt-6.1-sol`.

A tiny C adapter is the real PID 1. Pi runs as its child through the stock Pi SDK. The adapter does **not** reap children, restart services, forward signals, or shut down unless the model asks. If the agent dies, PID 1 stays alive and does nothing.

## Run

Use Linux and rootless Podman. For Docker, replace `podman` with `docker` and remove `:Z`.

```sh
podman build -t pi-pid1 -f Containerfile .
install -d -m 700 .local/auth
install -m 600 "$HOME/.pi/agent/auth.json" .local/auth/auth.json

podman run --rm --name pi-pid1 -i \
  --cap-drop=all --security-opt=no-new-privileges \
  --pids-limit=128 --memory=512m --cpus=1 --stop-timeout=60 \
  -v "$PWD/.local/auth:/auth:Z" -v pi-pid1-state:/state \
  -e PID1_AUTH_PATH=/auth/auth.json \
  -e PID1_TASK='Start /bin/sleep 100. On SIGTERM, stop it, reap it, then exit.' \
  pi-pid1
```

We copy auth so token refreshes do not change your main Pi credentials. The image runs as root inside the container. Workloads share its files, environment, and credentials: **this is not a sandbox for hostile code.** Never use `--init`, `--pid=host`, `--privileged`, or mount a host Docker socket.

Resource limits need cgroup delegation. Fix that on the host if the flags fail; removing them removes protection. For rootless build DNS problems, try `podman build --network=host ...`.

Send requests as lines on stdin. Read events, model output, and tool calls as JSONL on stdout. Logs and Pi sessions live in `/state`; each boot starts a new session. Disk use is not bounded.

```sh
podman kill --signal TERM pi-pid1  # Let the model decide how to stop.
podman kill --signal KILL pi-pid1  # Stop it without asking the model.
```

## Controls

Set `PID1_TASK` or `PID1_TASK_FILE` for the startup task. Override the model with `PID1_PROVIDER`, `PID1_MODEL`, and `PID1_THINKING` (default: `low`). `PID1_MODELS_PATH` accepts Pi custom model config. `PID1_STATE_DIR` changes `/state`; `PID1_EVENT_LIMIT` changes the 1024-event queue limit.

Events steer Pi between complete model/tool turns. When idle, the host waits without calling the model. `poll_next` lets the model wait during a turn. `critical_section` with `action: "begin"` queues input until `action: "end"`. It has no timeout and does not freeze processes. Forgetting to end it can wedge the agent.

Tools: `spawn`, `signal`, `wait`, `inspect`, `timer`, `exit`, `poll_next`, `critical_section`, plus Pi file tools. There is no built-in bash tool; launch shells through `spawn`. SIGCHLD can coalesce, so the model must drain statuses with `wait`. No automatic retries, health checks, or recovery; Pi context compaction stays enabled. Linux and the container runtime still enforce signals, exit rules, and resource limits.

See [tool schemas](src/tools.ts), [model instructions](src/system.md), and [transport/failure rules](PROTOCOL.md).

## Test

Requires Linux 5.9+, user/PID/mount namespaces, Node 22.19+, Make, and a C compiler.

```sh
npm ci --ignore-scripts
npm test
PID1_IMAGE=pi-pid1 npm run test:container
# Optional live test; uses a temporary auth copy and real inference:
PID1_LIVE_AUTH="$HOME/.pi/agent/auth.json" npm run test:live
```

Tests cover real PID namespaces, deferred reaping, orphans, process groups, and Pi event delivery. The live test checks model-driven SIGTERM handling. Container tests default to Podman; `PID1_ENGINE` accepts another engine executable or wrapper. Live-test logs can go to `PID1_LIVE_LOG`; use an ignored `.local/` path.
