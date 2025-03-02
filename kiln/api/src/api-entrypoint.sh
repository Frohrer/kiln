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
    apt-get install -y curl wget tar
}

# Function to download and install Firecracker
install_firecracker() {
    echo "Downloading Firecracker v1.5.0..."
    curl -Lo firecracker https://github.com/firecracker-microvm/firecracker/releases/download/v1.5.0/firecracker-v1.5.0-x86_64
    chmod +x firecracker
    mv firecracker /usr/local/bin/
}

# Run setup tasks as root
if [ "$(id -u)" = "0" ]; then
    # Install dependencies if needed
    if ! command -v curl &> /dev/null; then
        install_dependencies
    fi

    # Install Firecracker if needed
    if ! check_firecracker; then
        install_firecracker
    fi

    # Ensure directories exist and have correct permissions
    mkdir -p /var/lib/firecracker/{kernels,rootfs,images}
    mkdir -p /kiln
    chown -R kiln:kiln /var/lib/firecracker /kiln
    chmod -R 755 /var/lib/firecracker /kiln

    # Drop privileges and run the actual application
    exec gosu kiln "$0" "$@"
else
    # Application code here (running as kiln user)
    echo "Starting Kiln API service..."
    cd /kiln_api
    exec node src/index.js
fi