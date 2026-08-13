#!/bin/sh
# Shout before the disk fills, because the way this box tells you it is full is
# that Postgres stops answering while every page still returns 200.
#
# It has been at 95%, 98% and 85% in a single day. Deleting things buys a week;
# knowing buys the difference between a warning and an outage.
#
# Two ways it shouts, both visible without anyone having subscribed to
# anything: a warning in the journal, and a non-zero exit, which leaves the
# unit in `systemctl --failed` until the disk is dealt with.
set -e

THRESHOLD=${JOULE_DISK_THRESHOLD:-80}
USED=$(df --output=pcent / | tail -1 | tr -dc '0-9')
FREE=$(df -h --output=avail / | tail -1 | tr -d ' ')

if [ "$USED" -lt "$THRESHOLD" ]; then
  echo "disk at ${USED}% (${FREE} free), under the ${THRESHOLD}% line"
  exit 0
fi

# The four that have actually mattered, so the message says where to look
# rather than only that something is wrong.
BIG=$(du -shx /var/lib/containerd /home/ubuntu/joule-crawl /home/ubuntu/projects /var/log 2>/dev/null \
      | sort -rh | head -4 | tr '\n' ' ')

echo "DISK AT ${USED}% — only ${FREE} free on /" >&2
echo "biggest: ${BIG}" >&2
echo "Postgres has been taken down by a full disk on this machine before." >&2
exit 1
