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
            # Load the appropriate module based on CPU vendor
            if grep -q "^vendor_id.*Intel" /proc/cpuinfo; then
                modprobe kvm_intel
            elif grep -q "^vendor_id.*AMD" /proc/cpuinfo; then
                modprobe kvm_amd
            fi
        fi
    fi
}

# Function to verify required files
verify_files() {
    echo "Verifying required files..."
    
    # Check kernel
    if [ ! -f /var/lib/firecracker/kernels/vmlinux ]; then
        echo "Error: Kernel image not found at /var/lib/firecracker/kernels/vmlinux"
        echo "Please run: docker-compose --profile build-kernel up kernel-builder"
        exit 1
    fi
    
    # Check rootfs
    if [ ! -f /var/lib/firecracker/rootfs/base.ext4 ]; then
        echo "Error: Base rootfs not found at /var/lib/firecracker/rootfs/base.ext4"
        echo "Please run: docker-compose --profile build-rootfs up rootfs-builder"
        exit 1
    fi
    
    echo "All required files present"
}

# Run setup tasks as root
if [ "$(id -u)" = "0" ]; then
    # Install dependencies if needed
    if ! command -v curl &> /dev/null || ! command -v lsmod &> /dev/null; then
        install_dependencies
    fi

    # Install Firecracker if needed
    if ! check_firecracker; then
        install_firecracker
    fi

    # Verify KVM setup
    verify_kvm

    # Ensure directories exist and have correct permissions
    mkdir -p /var/lib/firecracker/{kernels,rootfs,images}
    mkdir -p /kiln
    chown -R kiln:kiln /var/lib/firecracker /kiln
    chmod -R 755 /var/lib/firecracker /kiln

    # Verify required files
    verify_files

    # Drop privileges and run the actual application
    exec gosu kiln "$0" "$@"
else
    # Application code here (running as kiln user)
    echo "Starting Kiln API service..."
    cd /kiln_api
    exec node src/index.js
fi