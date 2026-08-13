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
