#!/bin/bash

# Setup cgroup v2 if available, otherwise fallback to v1
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    # cgroup v2
    echo "Setting up cgroup v2"
    mkdir -p /sys/fs/cgroup/isolate
    echo "+cpu +cpuset +memory +pids" > /sys/fs/cgroup/cgroup.subtree_control
else
    # cgroup v1 fallback
    echo "Setting up cgroup v1"
    for subsys in cpuset cpu memory pids; do
        mkdir -p /sys/fs/cgroup/$subsys/isolate
        echo 1 > /sys/fs/cgroup/$subsys/isolate/tasks
    done
fi

# Ensure correct permissions
chown -R kiln:kiln /kiln

# Set file descriptor limit
ulimit -n 65536

# Start API as kiln user
exec su -- kiln -c 'node /kiln_api/src'