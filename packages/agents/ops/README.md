# What runs on the sandbox VM

The engine talks to a second machine over `DOCKER_HOST=ssh://joule-sandbox-env`,
and every dev-environment container lives there rather than beside the engine.
These two files belong on that machine, not in the engine's image, which is why
they are here as sources rather than as something the build installs.

```
sudo install -m 0755 joule-sandbox-firewall.sh /usr/local/sbin/
sudo install -m 0644 joule-sandbox-firewall.service /etc/systemd/system/
sudo systemctl enable --now joule-sandbox-firewall.service
```

The engine gives each environment a docker network of its own, which stops one
container reaching another. It cannot stop a container reaching the machine
underneath it — that is netfilter's job, and this is it. Without these rules a
sandbox can open a socket to the host's sshd, to the cloud metadata endpoint
that hands out instance identity, and to every other VM on the subnet.

Check it is doing something, from inside any environment container:

    node -e 'require("net").connect({host:"169.254.169.254",port:80,timeout:3000})
      .on("connect",()=>console.log("REACHABLE — the rules are not in place"))
      .on("timeout",()=>console.log("blocked"))'

## The seccomp profile

`seccomp.json` is docker's own default profile with the syscalls a sandbox has
no business making removed: mount, umount, ptrace, process_vm_readv/writev,
unshare, setns, bpf, perf_event_open, the module family, kexec, reboot,
open_by_handle_at and the new mount API. 388 syscalls remain allowed.

Derived from the default rather than written from scratch, because a profile
is an allowlist: anything left out is denied, and one omission breaks every
container in a way that looks like anything but seccomp.

```
sudo install -m 0644 -D seccomp.json /etc/joule/seccomp.json
# then, in packages/agents/.env
AGENTS_ENV_SECCOMP=/etc/joule/seccomp.json
```

It goes on the machine the **engine** runs on, not the sandbox VM: the docker
CLI reads the file itself and sends its contents, so the path is resolved on
the client side. Unset the variable and docker's default applies — the flag is
opt-in and reverting is one line.

io_uring is worth knowing about: it is absent from docker's default allowlist,
so it was already denied before this profile existed. Async Lumen programs
that need it need `seccomp=unconfined`, and that was true yesterday too.

## The AppArmor profile

`apparmor-joule-sandbox` is docker-default's shape — the same `/proc` and
`/sys` denials — plus this deployment's own: `curl`, `wget`, `nc` and `ssh`
are refused execution.

That last part is a fence, not a wall. AppArmor is path-based, so a program
that brings its own client walks around it; and node and python hold sockets
regardless. It is here for the stray command, which is most of them. It is
also not redundant: `agents-web:1` ships curl, wget and ssh, and
`agents-runtime:1` ships curl. The dev image ships none of them.

```
sudo install -m 0644 apparmor-joule-sandbox /etc/apparmor.d/joule-sandbox
sudo apparmor_parser -r -W /etc/apparmor.d/joule-sandbox
# then, in packages/agents/.env
AGENTS_ENV_APPARMOR=joule-sandbox
```

This one goes on the **sandbox VM**, not the engine box: an AppArmor profile
is loaded into the kernel that runs the container. The seccomp profile is the
other way round. Two security options, two machines — worth saying twice,
because getting it backwards produces an error that names a file and not a
machine.

## gVisor, when it is wanted

Not on. The images a sandbox runs are operator-chosen, and gVisor's layer —
a user-space kernel between the container and the host — is what you want the
day a person can bring their own. It costs syscall performance and does not
support io_uring.

The engine side is already wired: set `AGENTS_ENV_RUNTIME=runsc` and every
environment container is created with `--runtime runsc`. Unset, the daemon's
own runtime is used and nothing is passed.

The machine side needs a privileged hand on the sandbox VM:

```
curl -fsSLO https://storage.googleapis.com/gvisor/releases/release/latest/x86_64/runsc
curl -fsSLO https://storage.googleapis.com/gvisor/releases/release/latest/x86_64/runsc.sha512
sha512sum -c runsc.sha512
sudo install -m 0755 runsc /usr/local/bin/runsc

# /etc/docker/daemon.json — additive, keep live-restore true
#   "runtimes": { "runsc": { "path": "/usr/local/bin/runsc" } }
sudo systemctl restart docker
```

Declaring a runtime changes nothing for containers that do not ask for it, so
this is safe to install ahead of deciding to use it. Back the file up first,
and test one real workload — a vite install and dev server — under
`--runtime=runsc` before setting the variable.
