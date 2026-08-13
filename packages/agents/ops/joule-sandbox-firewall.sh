#!/bin/sh
# What a sandbox may reach.
#
# Every dev environment now has a docker network to itself, which is what keeps
# one conversation's container from reaching another's. Docker does not do the
# other half: a container can still talk to the machine hosting it, and to
# whatever else that machine can route to. This closes both.
#
# Two chains, because they are two different paths through netfilter. Traffic
# aimed AT this host is INPUT; traffic aimed THROUGH it is FORWARD, where
# docker leaves DOCKER-USER for exactly this. A rule in one does nothing for
# the other, which is the mistake worth not making twice.
#
# `br-+` matches docker's user-defined bridges and not docker0, so this covers
# the sandboxes and leaves Collabora alone. Langfuse shares the br-+ shape, so
# it is exempted by subnet rather than by luck.
set -e

SANDBOX_CHAIN=JOULE-SANDBOX
LANGFUSE=172.18.0.0/16
VNET=172.26.144.0/20
METADATA=169.254.169.254/32

# --- container -> this host ---------------------------------------------
iptables -N "$SANDBOX_CHAIN" 2>/dev/null || true
iptables -F "$SANDBOX_CHAIN"
# Answers to what the host itself began, and to what it forwarded in.
iptables -A "$SANDBOX_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
# Langfuse is not a sandbox; it shares the interface pattern and nothing else.
iptables -A "$SANDBOX_CHAIN" -s "$LANGFUSE" -j RETURN
iptables -A "$SANDBOX_CHAIN" -j DROP

iptables -D INPUT -i br+ -j "$SANDBOX_CHAIN" 2>/dev/null || true
iptables -I INPUT 1 -i br+ -j "$SANDBOX_CHAIN"

# --- container -> anywhere else this machine can route ------------------
# The metadata endpoint first: on this cloud it hands out instance identity to
# anything that asks, and a sandbox asking is exactly the shape of the problem.
for target in "$METADATA" "$VNET" 10.0.0.0/8 192.168.0.0/16; do
  iptables -D DOCKER-USER -i br+ -d "$target" -j DROP 2>/dev/null || true
  iptables -I DOCKER-USER 1 -i br+ -d "$target" -j DROP
done

echo "sandbox firewall in place"
