#!/bin/bash
set -e

# Function to check if Firecracker is installed
check_firecracker() {
    if ! command -v firecracker &> /dev/null || ! firecracker --version &> /dev/null; then
        return 1
    fi
    return 0
}

# Function to install system dependencies
install_dependencies() {
    echo "Installing required system utilities..."
    apt-get update
    apt-get install -y \
        curl \
        wget \
        tar \
        kmod \
        util-linux \
        iproute2 \
        procps \
        systemd \
        fuse \
        psmisc
}

# Function to download and install Firecracker
install_firecracker() {
    echo "Downloading Firecracker v1.5.0..."
    curl -Lo firecracker https://github.com/firecracker-microvm/firecracker/releases/download/v1.5.0/firecracker-v1.5.0-x86_64
    chmod +x firecracker
    mv firecracker /usr/local/bin/
}

# Function to verify KVM setup
verify_kvm() {
    echo "Verifying KVM setup..."
    if [ ! -e /dev/kvm ]; then
        echo "Creating /dev/kvm device node..."
        mknod /dev/kvm c 10 232
    fi
    chmod 666 /dev/kvm

    # Load KVM modules if not loaded
    if ! lsmod | grep -q '^kvm_intel\|^kvm_amd'; then
        echo "Loading KVM modules..."
        modprobe kvm
        if [ -e /dev/cpu/*/cpuid ]; then
            if grep -q -w vmx /proc/cpuinfo; then
                modprobe kvm_intel
            elif grep -q -w svm /proc/cpuinfo; then
                modprobe kvm_amd
            fi
        fi
    fi
}

# Function to verify required files exist
verify_files() {
    echo "Verifying required files..."
    
    # Check kernel image
    if [ ! -f /var/lib/firecracker/kernels/vmlinux ]; then
        echo "Error: Kernel image not found at /var/lib/firecracker/kernels/vmlinux"
        exit 1
    fi
    
    # Check base rootfs
    if [ ! -f /var/lib/firecracker/rootfs/base.ext4 ]; then
        echo "Error: Base rootfs not found at /var/lib/firecracker/rootfs/base.ext4"
        exit 1
    fi
}

# Function to setup directories
setup_directories() {
    echo "Setting up directories..."
    mkdir -p /var/lib/firecracker/{kernels,rootfs,images}
    chmod -R 777 /var/lib/firecracker
    mkdir -p /tmp/mount-python-3.12
    chmod -R 777 /tmp/mount-python-3.12
}

# Main execution
echo "Starting API entrypoint script..."

# Install dependencies if needed
if ! check_firecracker; then
    install_dependencies
    install_firecracker
fi

# Setup and verify environment
verify_kvm
setup_directories
verify_files

# Start the API server
echo "Starting API server..."
cd /kiln_api
exec node src/index.js