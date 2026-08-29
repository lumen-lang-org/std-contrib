# The environment a delegated joule agent runs in: the joule daemon itself, on
# top of the same toolchain a script run gets, so the agent inside the
# container can do the work someone would otherwise ask it to do at a terminal.
#
# Its own image rather than more weight in agents-runtime:1, because a
# conversation that never delegates should not carry a release archive it will
# never exec, and because the release moves on joule's schedule rather than the
# runtime's — bumping one should not rebuild the other.
FROM python:3.12-slim

# The same set runtime.Dockerfile installs, minus the imaging libraries no
# daemon links against, and for the same reasons: python and node together so
# the agent can write in either without apt, git because the work handed to it
# is usually a working tree, curl and ca-certificates because the daemon talks
# to a model API over TLS and gets nowhere without the trust store.
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs npm \
    curl ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# The pin, and the one line to change when bumping it. A tag rather than
# `latest`: a delegated turn's behaviour is the daemon's behaviour, and an
# image that quietly picked up a new release would change what a conversation
# does with nothing in this repository having moved.
ARG JOULE_VERSION=v0.23.20

# Installed the way install.sh does — same asset, unpacked whole and kept
# whole. `joule` resolves `joule-daemon` beside its own real path, so an
# install that separates the two has no daemon mode at all. That is also why
# the directory goes on PATH instead of being symlinked binary by binary into
# /usr/local/bin: PATH costs nothing and cannot get the layout wrong.
RUN set -eu; \
    url="https://github.com/joule-sh/code/releases/download/${JOULE_VERSION}/code-x86_64-linux.tar.gz"; \
    tmp="$(mktemp -d)"; \
    curl -fsSL "$url" -o "$tmp/code.tar.gz"; \
    tar -xzf "$tmp/code.tar.gz" -C "$tmp"; \
    mv "$tmp/code-x86_64-linux" /opt/joule-code; \
    rm -rf "$tmp"
ENV PATH=/opt/joule-code:$PATH

# install.sh ends by running every binary it unpacked, on the grounds that an
# install is not finished until they start. That check cannot run here, and why
# it cannot is worth writing down, because it is the same reason a joule
# environment cannot be launched like any other sandbox.
#
# The Lumen runtime brings up an io_uring event loop before main. io_uring_setup
# is absent from docker's default seccomp allowlist — during a build as much as
# at run time — so it comes back EPERM and the loop's init unwraps it:
#
#   thread 1 panic: attempt to unwrap error: PermissionDenied
#     .../std/os/linux/IoUring.zig:64:18 in init_params
#
# There is no fallback path to epoll and no environment variable that picks
# one, so no amount of image content answers it, and `docker build` takes no
# --security-opt to relax the profile for one step. ops/README.md already
# records the general shape of this — async Lumen programs need
# seccomp=unconfined — and joule is one of them; whoever teaches
# environments.ts to launch this image has to decide what that means for
# --security-opt on a joule environment. Measured here: with
# `--security-opt seccomp=unconfined` the daemon answers `joule-daemon 0.23.20`,
# and with docker's default it aborts before printing anything.
#
# So what is checkable at build time is checked, which is that the archive
# unpacked into the layout the loader expects: both names present, both
# executable, and beside each other, which is what `joule` needs to find its
# daemon.
RUN test -x /opt/joule-code/joule && test -x /opt/joule-code/joule-daemon

# HOME, and it is load-bearing.
#
# environments.ts runs these containers with --read-only, so the only place
# the daemon may write is a volume, and the volume it is handed is
# agents-home-<thread> at /home/sandbox. The daemon's runtime directory is
# $HOME/.config/joule-code/daemon/<session> — its inbox and broadcast log —
# so with HOME left at the base image's default the very first thing it does
# is write to a read-only rootfs.
#
# Declared in the image and not only in the run arguments because the script
# sandbox branch of envRunArgs mounts that volume without setting HOME: it
# runs as root, and root's home is /root. Setting it here makes the image
# right under either branch and when run by hand.
#
# Owned by 65534 so a serving environment, which runs as that uid under
# --cap-drop ALL and cannot chown anything for itself, can write to it. Docker
# seeds a fresh named volume from the image's directory, ownership included,
# so this is the ownership the volume gets.
RUN mkdir -p /home/sandbox && chown 65534:65534 /home/sandbox
ENV HOME=/home/sandbox

# No ENTRYPOINT and no CMD, the same as office-render.Dockerfile and for the
# same reason: environments.ts starts every sandbox with `--entrypoint sleep
# … infinity` and execs into it afterwards. An ENTRYPOINT here would be
# appended to and quietly break that.
