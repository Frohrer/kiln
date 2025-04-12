#!/bin/bash

# Debug cgroup setup
echo "Debugging cgroup setup..."
echo "Current cgroup mounts:"
mount | grep cgroup
echo "Cgroup controllers:"
cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null || echo "No cgroup controllers file"
echo "Cgroup type:"
cat /sys/fs/cgroup/cgroup.type 2>/dev/null || echo "No cgroup type file"
echo "Cgroup subtree control:"
cat /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || echo "No subtree control file"

# Setup cgroup v2 if available, otherwise fallback to v1
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    # cgroup v2
    echo "Setting up cgroup v2"
    
    # First, ensure the isolate directory exists and has proper permissions
    mkdir -p /sys/fs/cgroup/isolate
    chmod 777 /sys/fs/cgroup/isolate
    
    # Try to enable controllers one by one
    for controller in cpu cpuset memory pids; do
        if grep -q $controller /sys/fs/cgroup/cgroup.controllers; then
            echo "Enabling $controller controller"
            echo "+$controller" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
        fi
    done
    
    # Create box directory with proper permissions
    mkdir -p /sys/fs/cgroup/isolate/box-1
    chmod 777 /sys/fs/cgroup/isolate/box-1
    
    # Try to create memory files if they don't exist
    if [ ! -f /sys/fs/cgroup/isolate/box-1/memory.events ]; then
        echo "Creating memory.events file"
        echo "populated 0" > /sys/fs/cgroup/isolate/box-1/memory.events 2>/dev/null || true
        chmod 666 /sys/fs/cgroup/isolate/box-1/memory.events 2>/dev/null || true
    fi
    
    if [ ! -f /sys/fs/cgroup/isolate/box-1/memory.max ]; then
        echo "Creating memory.max file"
        echo "max" > /sys/fs/cgroup/isolate/box-1/memory.max 2>/dev/null || true
        chmod 666 /sys/fs/cgroup/isolate/box-1/memory.max 2>/dev/null || true
    fi
    
    # Verify the setup
    echo "Verifying cgroup setup:"
    ls -la /sys/fs/cgroup/isolate/box-1/
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