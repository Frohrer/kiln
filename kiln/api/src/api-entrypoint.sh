#!/bin/bash

# Setup KVM
if [ ! -e /dev/kvm ]; then
    mknod /dev/kvm c 10 232
fi

# Setup network for Firecracker
ip tuntap add tap0 mode tap
ip addr add 172.16.0.1/24 dev tap0
ip link set tap0 up

# Start the API server
cd /kiln_api
exec node src/index.js