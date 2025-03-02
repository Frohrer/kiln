#!/bin/bash

# Function to download Firecracker
download_firecracker() {
    local version="v1.5.0"
    local arch="x86_64"
    local base_url="https://github.com/firecracker-microvm/firecracker/releases/download"
    
    echo "Downloading Firecracker ${version}..."
    
    # Download binary
    curl -L -o /usr/local/bin/firecracker "${base_url}/${version}/firecracker-${version}-${arch}.tgz"
    
    # Extract the binary
    cd /usr/local/bin
    tar xvf firecracker
    rm firecracker # Remove the tar file
    mv release-${version}-${arch}/firecracker-${version}-${arch} firecracker
    rm -rf release-${version}-${arch}
    
    # Make it executable
    chmod +x firecracker
    
    # Test the binary
    if ! ./firecracker --version &> /dev/null; then
        echo "Binary verification failed!"
        rm -f firecracker
        return 1
    fi
    
    return 0
}

# Verify and setup Firecracker binary
if [ ! -f /usr/local/bin/firecracker ] || ! /usr/local/bin/firecracker --version &> /dev/null; then
    echo "Firecracker binary not found or invalid. Downloading..."
    if ! download_firecracker; then
        echo "Failed to download Firecracker binary"
        exit 1
    fi
fi

chmod +x /usr/local/bin/firecracker
chown root:root /usr/local/bin/firecracker

# Verify binary is valid
echo "Verifying Firecracker binary..."
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