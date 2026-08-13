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
