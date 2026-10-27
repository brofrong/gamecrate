#!/bin/bash
# Probe run (plan 4, task 2 step 3; throwaway, not prod). usage: gpu-run.sh IMAGE NAME [poll_seconds]
# Starts the container with desktopSpec flags and polls milestones; writes $NAME-<ts>.log.
set -u
IMAGE=$1; NAME=$2; MAX=${3:-600}
GBM=/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.550.163.01
dir=$(dirname "$0"); out="$dir/$NAME-$(date +%H%M%S).log"
busy() { for l in cg.session cg.install cg.template; do [ -n "$(docker ps -q --filter label=$l)" ] && return 0; done; return 1; }
if busy; then echo "slot busy, abort" | tee -a "$out"; exit 3; fi
PASSWD=$(head -c 24 /dev/urandom | base64 | tr -d '/+='); export PASSWD
t0=$(date +%s.%N)
echo "t0 $(date -Is) image=$IMAGE name=$NAME" | tee -a "$out"
docker run -d --name "$NAME" --label cg.probe=kiosk \
  --entrypoint /etc/container-entrypoint.sh \
  --runtime nvidia --gpus all --shm-size 2g \
  --security-opt no-new-privileges:true \
  --tmpfs /dev/input:mode=1777,size=64k,nosuid,nodev,noexec \
  -v "$GBM:/usr/lib/x86_64-linux-gnu/libnvidia-allocator.so.1:ro" \
  -v "$GBM:/usr/lib/x86_64-linux-gnu/gbm/nvidia-drm_gbm.so:ro" \
  --network cg-sessions -p 59001:59001/udp \
  -e SELKIES_WEBRTC_UDP_MUX_PORT=59001 \
  -e SELKIES_WEBRTC_PUBLIC_IP=37.153.14.138 \
  -e CG_MODE=install -e PASSWD \
  "$IMAGE" >/dev/null || { echo "docker run failed" | tee -a "$out"; exit 1; }
unset PASSWD
el() { awk -v a="$(date +%s.%N)" -v b="$t0" "BEGIN{printf \"%6.1f\", a-b}"; }
seen_status=; seen_zc=; seen_pid=; declare -A seenwin
probe_win='
pid=$(pgrep -f "ubuntu12_32/steam( |\$)" | head -1); src=client
[ -n "$pid" ] || { pid=$(pgrep -o -f "steam" ); src=other; }
[ -n "$pid" ] || exit 0
while IFS= read -r -d "" v; do case $v in DISPLAY=*|XAUTHORITY=*) export "$v";; esac; done </proc/$pid/environ
for w in $(timeout 2 xdotool search --onlyvisible --class steam 2>/dev/null); do
  g=$(timeout 2 xwininfo -id $w | sed -n "s/^ *Absolute upper-left X: *//p;s/^ *Absolute upper-left Y: *//p;s/^ *Width: *//p;s/^ *Height: *//p" | tr "\n" " ")
  echo "WIN $w src=$src pid=$pid geom=[$g] name=$(timeout 2 xdotool getwindowname $w 2>/dev/null)"
done
for w in $(timeout 2 xdotool search --onlyvisible --name . 2>/dev/null); do
  echo "ANY $w class=$(timeout 2 xprop -id $w WM_CLASS 2>/dev/null | cut -d= -f2 | tr -d " ") name=$(timeout 2 xdotool getwindowname $w 2>/dev/null)"
done'
end=$(( $(date +%s) + MAX ))
while [ "$(date +%s)" -lt "$end" ]; do
  if busy; then echo "$(el) PLAYER CONTAINER APPEARED -> removing $NAME" | tee -a "$out"; docker rm -f -v "$NAME" >/dev/null; exit 4; fi
  if [ -z "$seen_status" ] && docker exec "$NAME" curl -fsS -o /dev/null --max-time 2 http://localhost:8080/api/status 2>/dev/null; then seen_status=1; echo "$(el) api/status 200" | tee -a "$out"; fi
  if [ -z "$seen_zc" ]; then l=$(docker logs "$NAME" 2>&1 | grep -m1 -i "zero-copy"); [ -n "$l" ] && { seen_zc=1; echo "$(el) LOG $l" | tee -a "$out"; }; fi
  if [ -z "$seen_pid" ]; then p=$(docker exec "$NAME" pgrep -f "ubuntu12_32/steam( |\$)" 2>/dev/null | head -1); [ -n "$p" ] && { seen_pid=1; echo "$(el) steam client pid $p" | tee -a "$out"; }; fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    key=$(echo "$line" | awk '{print $1, $2, $NF}')
    if [ -z "${seenwin[$key]:-}" ]; then seenwin[$key]=1; echo "$(el) $line" | tee -a "$out"; fi
  done < <(docker exec "$NAME" bash -c "$probe_win" 2>/dev/null)
  sleep 1
done
echo "$(el) poll end" | tee -a "$out"
