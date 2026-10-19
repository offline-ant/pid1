#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/* Private inherited socket: requests are length-prefixed NUL-separated fields;
 * replies/events are JSONL. No listening socket, process registry or policies. */
#define FRAME_LIMIT 65536U
#define FIELD_LIMIT 512U
#define OUTPUT_LIMIT (1024U * 1024U)
static int control = -1;
static char output[OUTPUT_LIMIT];
static size_t output_start, output_end;

static void fatal(const char *message) {
    perror(message);
    _exit(70);
}

static void emit(const char *format, ...) {
    if (control < 0) return; /* A dead agent leaves init inert. */
    if (output_start) {
        memmove(output, output + output_start, output_end - output_start);
        output_end -= output_start;
        output_start = 0;
    }
    va_list ap;
    va_start(ap, format);
    int n = vsnprintf(output + output_end, OUTPUT_LIMIT - output_end, format, ap);
    va_end(ap);
    if (n < 0 || (size_t)n >= OUTPUT_LIMIT - output_end) {
        errno = ENOBUFS;
        fatal("pid1: output queue limit");
    }
    output_end += (size_t)n;
}

static void reply_error(long id, int error) {
    emit("{\"id\":%ld,\"ok\":false,\"errno\":%d}\n", id, error);
}

static bool integer(const char *s, long min, long max, long *value) {
    char *end;
    errno = 0;
    long n = strtol(s, &end, 10);
    if (errno || !*s || *end || n < min || n > max) return false;
    *value = n;
    return true;
}

static void child_error(const char *operation) {
    dprintf(STDERR_FILENO, "pid1: %s: %s\n", operation, strerror(errno));
    _exit(127);
}

static void redirect_file(const char *path, int fd, int flags) {
    int opened = open(path, flags | O_CLOEXEC, 0600);
    if (opened < 0) child_error(path);
    if (dup2(opened, fd) < 0) child_error("dup2");
    if (opened != fd) close(opened);
    /* dup2(oldfd, oldfd) does not clear CLOEXEC. */
    if (fcntl(fd, F_SETFD, 0) < 0) child_error("fcntl");
}

static void prepare_child(void) {
    sigset_t empty;
    sigemptyset(&empty);
    if (sigprocmask(SIG_SETMASK, &empty, NULL) < 0) child_error("sigprocmask");
    if (setpgid(0, 0) < 0) child_error("setpgid");
}

/* spawn fields: id, spawn, cwd, stdout, stderr, env-count, key,value..., argv... */
static void spawn_request(long id, char **f, size_t count) {
    long env_count;
    if (count < 7 || !integer(f[5], 0, 128, &env_count)) {
        reply_error(id, EINVAL);
        return;
    }
    size_t argv_start = 6 + (size_t)env_count * 2;
    if (argv_start >= count || !*f[argv_start]) {
        reply_error(id, EINVAL);
        return;
    }
    for (size_t i = 6; i < argv_start; i += 2) {
        if (!*f[i] || strchr(f[i], '=')) {
            reply_error(id, EINVAL);
            return;
        }
    }
    pid_t pid = fork();
    if (pid < 0) {
        reply_error(id, errno);
        return;
    }
    if (pid == 0) {
        prepare_child();
        if (*f[2] && chdir(f[2]) < 0) child_error("chdir");
        redirect_file("/dev/null", STDIN_FILENO, O_RDONLY);
        if (*f[3]) redirect_file(f[3], STDOUT_FILENO, O_WRONLY | O_CREAT | O_APPEND);
        if (*f[4]) redirect_file(f[4], STDERR_FILENO, O_WRONLY | O_CREAT | O_APPEND);
        for (size_t i = 6; i < argv_start; i += 2)
            if (setenv(f[i], f[i + 1], 1) < 0) child_error("setenv");
        unsetenv("PID1_CONTROL_FD");
        if (close_range(3, ~0U, 0) < 0) child_error("close_range");
        f[count] = NULL;
        execvp(f[argv_start], f + argv_start);
        child_error("execvp");
    }
    /* Both sides establish the group, so it exists before the reply. */
    if (setpgid(pid, pid) < 0 && errno != EACCES && errno != ESRCH)
        fatal("pid1: setpgid");
    emit("{\"id\":%ld,\"ok\":true,\"pid\":%d,\"pgid\":%d}\n", id, pid, pid);
}

static void wait_request(long id, char **f, size_t count) {
    long target;
    if (count != 3 || !integer(f[2], -1, INT_MAX, &target) || target == 0) {
        reply_error(id, EINVAL);
        return;
    }
    int status;
    pid_t pid = waitpid((pid_t)target, &status, WNOHANG | WUNTRACED | WCONTINUED);
    if (pid < 0) {
        if (errno == ECHILD)
            emit("{\"id\":%ld,\"ok\":true,\"pid\":0,\"no_children\":true}\n", id);
        else reply_error(id, errno);
        return;
    }
    if (!pid) {
        emit("{\"id\":%ld,\"ok\":true,\"pid\":0,\"no_children\":false}\n", id);
        return;
    }
    if (WIFEXITED(status))
        emit("{\"id\":%ld,\"ok\":true,\"pid\":%d,\"state\":\"exited\",\"status\":%d}\n",
             id, pid, WEXITSTATUS(status));
    else if (WIFSIGNALED(status))
        emit("{\"id\":%ld,\"ok\":true,\"pid\":%d,\"state\":\"signaled\",\"signal\":%d,\"core\":%s}\n",
             id, pid, WTERMSIG(status), WCOREDUMP(status) ? "true" : "false");
    else if (WIFSTOPPED(status))
        emit("{\"id\":%ld,\"ok\":true,\"pid\":%d,\"state\":\"stopped\",\"signal\":%d}\n",
             id, pid, WSTOPSIG(status));
    else
        emit("{\"id\":%ld,\"ok\":true,\"pid\":%d,\"state\":\"continued\"}\n", id, pid);
}

static void request(char *buffer, size_t size) {
    char *fields[FIELD_LIMIT + 1];
    size_t count = 0, offset = 0;
    while (offset < size && count < FIELD_LIMIT) {
        fields[count++] = buffer + offset;
        char *end = memchr(buffer + offset, 0, size - offset);
        if (!end) { errno = EPROTO; fatal("pid1: unterminated field"); }
        offset = (size_t)(end - buffer) + 1;
    }
    if (offset != size || count < 2) { errno = EPROTO; fatal("pid1: malformed request"); }
    long id;
    if (!integer(fields[0], 1, INT_MAX, &id)) { errno = EPROTO; fatal("pid1: invalid id"); }
    if (!strcmp(fields[1], "spawn")) spawn_request(id, fields, count);
    else if (!strcmp(fields[1], "wait")) wait_request(id, fields, count);
    else if (!strcmp(fields[1], "signal")) {
        long target, number;
        if (count != 4 || !integer(fields[2], -INT_MAX, INT_MAX, &target) ||
            !integer(fields[3], 0, NSIG - 1, &number)) reply_error(id, EINVAL);
        else if (kill((pid_t)target, (int)number) < 0) reply_error(id, errno);
        else emit("{\"id\":%ld,\"ok\":true}\n", id);
    } else if (!strcmp(fields[1], "exit")) {
        long status;
        if (count != 3 || !integer(fields[2], 0, 255, &status)) reply_error(id, EINVAL);
        else _exit((int)status); /* No response: exiting PID 1 destroys its namespace. */
    } else reply_error(id, ENOSYS);
}

static void disconnect(void) {
    close(control);
    control = -1;
    output_start = output_end = 0;
    dprintf(STDERR_FILENO, "pid1: control disconnected; remaining inert (no reaping or recovery)\n");
}

int main(int argc, char **argv) {
    if (getpid() != 1) {
        fprintf(stderr, "pid1: refuses to run outside a private PID namespace as PID 1\n");
        return 64;
    }
    if (argc < 3 || strcmp(argv[1], "--")) {
        fprintf(stderr, "usage: pid1 -- AGENT [ARGS...]\n");
        return 64;
    }
    if (getpgrp() != getpid() && setpgid(0, 0) < 0) fatal("pid1: own process group");
    /* Explicitly undo inherited SIG_IGN/SA_NOCLDWAIT: reaping is a tool only. */
    struct sigaction disposition = {.sa_handler = SIG_DFL};
    sigemptyset(&disposition.sa_mask);
    if (sigaction(SIGCHLD, &disposition, NULL) < 0) fatal("pid1: SIGCHLD disposition");
    /* Synchronous fatal signals retain their disposition. All other catchable
     * signals become input, including SIGPIPE rather than an implicit exit. */
    sigset_t mask;
    sigfillset(&mask);
    const int excluded[] = {SIGKILL, SIGSTOP, SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGTRAP, SIGABRT, SIGSYS};
    for (size_t i = 0; i < sizeof(excluded) / sizeof(excluded[0]); i++) sigdelset(&mask, excluded[i]);
    if (sigprocmask(SIG_BLOCK, &mask, NULL) < 0) fatal("pid1: sigprocmask");
    int signals = signalfd(-1, &mask, SFD_CLOEXEC | SFD_NONBLOCK);
    if (signals < 0) fatal("pid1: signalfd");
    int sockets[2];
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sockets) < 0) fatal("pid1: socketpair");
    pid_t agent = fork();
    if (agent < 0) fatal("pid1: fork agent");
    if (!agent) {
        prepare_child();
        if (sockets[1] != 3 && dup2(sockets[1], 3) < 0) child_error("dup2 control");
        if (fcntl(3, F_SETFD, 0) < 0) child_error("fcntl control");
        if (close_range(4, ~0U, 0) < 0) child_error("close_range");
        if (setenv("PID1_CONTROL_FD", "3", 1) < 0) child_error("setenv control");
        execvp(argv[2], argv + 2);
        child_error("exec agent");
    }
    close(sockets[1]);
    control = sockets[0];
    if (fcntl(control, F_SETFL, O_NONBLOCK) < 0) fatal("pid1: nonblocking");
    emit("{\"event\":\"boot\",\"adapter_pid\":1,\"agent_pid\":%d}\n", agent);
    char input[FRAME_LIMIT + 4];
    size_t used = 0;
    for (;;) {
        struct pollfd fds[2] = {
            {.fd = signals, .events = POLLIN},
            {.fd = control, .events = POLLIN | (output_end > output_start ? POLLOUT : 0)}
        };
        if (poll(fds, 2, -1) < 0) {
            if (errno == EINTR) continue;
            fatal("pid1: poll");
        }
        if (fds[0].revents & POLLIN) {
            struct signalfd_siginfo info;
            ssize_t n;
            while ((n = read(signals, &info, sizeof(info))) == sizeof(info))
                emit("{\"event\":\"signal\",\"signal\":%u,\"sender_pid\":%u,\"sender_uid\":%u,\"code\":%d,\"status\":%d}\n",
                     info.ssi_signo, info.ssi_pid, info.ssi_uid, (int32_t)info.ssi_code, (int32_t)info.ssi_status);
            if (n < 0 && errno != EAGAIN && errno != EINTR) fatal("pid1: read signals");
        }
        if (control >= 0 && (fds[1].revents & POLLIN)) {
            ssize_t n = read(control, input + used, sizeof(input) - used);
            if (n == 0) disconnect();
            else if (n < 0) {
                if (errno != EAGAIN && errno != EINTR) disconnect();
            } else {
                used += (size_t)n;
                while (used >= 4) {
                    uint32_t length;
                    memcpy(&length, input, 4);
                    length = ntohl(length);
                    if (!length || length > FRAME_LIMIT) { errno = EPROTO; fatal("pid1: frame length"); }
                    if (used < length + 4U) break;
                    request(input + 4, length);
                    memmove(input, input + length + 4U, used - length - 4U);
                    used -= length + 4U;
                }
            }
        }
        if (control >= 0 && output_end > output_start && (fds[1].revents & POLLOUT)) {
            ssize_t n = send(control, output + output_start, output_end - output_start, MSG_NOSIGNAL);
            if (n > 0) {
                output_start += (size_t)n;
                if (output_start == output_end) output_start = output_end = 0;
            } else if (n < 0 && errno != EAGAIN && errno != EINTR) disconnect();
        }
        if (control >= 0 && (fds[1].revents & (POLLERR | POLLHUP | POLLNVAL))) disconnect();
    }
}
