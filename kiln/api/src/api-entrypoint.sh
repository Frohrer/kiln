#!/bin/bash

# Debug cgroup setup
echo "Debugging cgroup setup..."
echo "Current cgroup mounts:"
mount | grep cgroup
echo "Cgroup controllers:"
cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null || echo "No cgroup controllers file"

# Setup cgroup v2 if available, otherwise fallback to v1
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    # cgroup v2
    echo "Setting up cgroup v2"
    mkdir -p /sys/fs/cgroup/isolate
    
    # Try to enable controllers, but don't fail if it doesn't work
    echo "+cpu +cpuset +memory +pids" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
    
    # Create initial box directory and required files
    mkdir -p /sys/fs/cgroup/isolate/box-1
    touch /sys/fs/cgroup/isolate/box-1/memory.events
    touch /sys/fs/cgroup/isolate/box-1/memory.max
    chmod 666 /sys/fs/cgroup/isolate/box-1/memory.events
    chmod 666 /sys/fs/cgroup/isolate/box-1/memory.max
    chmod 777 /sys/fs/cgroup/isolate/box-1
    
    # Set permissions
    chmod 777 /sys/fs/cgroup/isolate 2>/dev/null || true
else
    # cgroup v1 fallback
    echo "Setting up cgroup v1"
    for subsys in cpuset cpu memory pids; do
        mkdir -p /sys/fs/cgroup/$subsys/isolate 2>/dev/null || true
        echo 1 > /sys/fs/cgroup/$subsys/isolate/tasks 2>/dev/null || true
        chmod 777 /sys/fs/cgroup/$subsys/isolate 2>/dev/null || true
    done
fi

# Ensure correct permissions
chown -R kiln:kiln /kiln

# Set file descriptor limit
ulimit -n 65536

# Start API as kiln user
exec su -- kiln -c 'node /kiln_api/src'