#!/bin/bash

# Setup cgroup v2
mkdir -p /sys/fs/cgroup/isolate
chmod -R 777 /sys/fs/cgroup/isolate
echo "+memory +cpu +pids" > /sys/fs/cgroup/isolate/cgroup.subtree_control 2>/dev/null || true

# Ensure correct permissions
chown -R kiln:kiln /kiln

# Set file descriptor limit
ulimit -n 65536

# Start API as kiln user
exec su -- kiln -c 'node /kiln_api/src'