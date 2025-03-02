#!/bin/bash

# Verify and setup Firecracker binary
if [ ! -f /usr/local/bin/firecracker ]; then
    echo "Firecracker binary not found. Downloading..."
    curl -Lo /usr/local/bin/firecracker https://github.com/firecracker-microvm/firecracker/releases/download/v1.5.0/firecracker-v1.5.0-x86_64
fi

chmod +x /usr/local/bin/firecracker
chown root:root /usr/local/bin/firecracker

# Verify binary is valid
if ! /usr/local/bin/firecracker --version; then
    echo "Error: Firecracker binary is invalid or corrupted"
    exit 1
fi

# Setup KVM
if [ ! -e /dev/kvm ]; then
    mknod /dev/kvm c 10 232
fi
chmod 666 /dev/kvm

# Setup network for Firecracker
ip tuntap add tap0 mode tap
ip addr add 172.16.0.1/24 dev tap0
ip link set tap0 up

# Start the API server
cd /kiln_api
exec node src/index.js