#!/bin/bash

# Debug cgroup setup
echo "Debugging cgroup setup..."
echo "Current cgroup mounts:"
mount | grep cgroup
echo "Cgroup controllers:"
cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null || echo "No cgroup controllers file"
echo "Cgroup subtree control:"
cat /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || echo "No subtree control file"

# Setup cgroup v2
echo "Setting up cgroup v2"
    
# First, ensure the isolate directory exists and has proper permissions
mkdir -p /sys/fs/cgroup/isolate
chown -R root:root /sys/fs/cgroup/isolate
chmod 755 /sys/fs/cgroup/isolate

# Enable all available controllers
echo "+cpu +cpuset +memory +pids" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true

# Create box directory with proper permissions
mkdir -p /sys/fs/cgroup/isolate/box-1
chown -R root:root /sys/fs/cgroup/isolate/box-1
chmod 755 /sys/fs/cgroup/isolate/box-1

# Initialize memory files
echo "max" > /sys/fs/cgroup/isolate/box-1/memory.max
echo "populated 0" > /sys/fs/cgroup/isolate/box-1/memory.events
chmod 644 /sys/fs/cgroup/isolate/box-1/memory.max
chmod 644 /sys/fs/cgroup/isolate/box-1/memory.events

# Verify the setup
echo "Verifying cgroup setup:"
ls -la /sys/fs/cgroup/isolate/box-1/

# Ensure correct permissions
chown -R kiln:kiln /kiln

# Set file descriptor limit
ulimit -n 65536

# Start API as kiln user
exec su -- kiln -c 'node /kiln_api/src'