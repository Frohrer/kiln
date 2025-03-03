FROM node:20-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive

RUN dpkg-reconfigure -p critical dash
RUN apt-get update && \
    apt-get install -y git libxml2 gnupg tar coreutils util-linux libc6-dev \
    binutils build-essential locales libpcre3-dev libevent-dev libgmp3-dev \
    libncurses6 libncurses5 libedit-dev libseccomp-dev rename procps python3 \
    libreadline-dev libblas-dev liblapack-dev libpcre3-dev libarpack2-dev \
    libfftw3-dev libglpk-dev libqhull-dev libqrupdate-dev libsuitesparse-dev \
    libsundials-dev libpcre2-dev libcap-dev curl wget iproute2 jq docker.io e2fsprogs \
    kmod util-linux iproute2 procps systemd fuse psmisc && \
    rm -rf /var/lib/apt/lists/*

# Install KVM kernel module and required tools
RUN apt-get update && \
    apt-get install -y qemu-kvm && \
    rm -rf /var/lib/apt/lists/* && \
    # Create kvm group if it doesn't exist
    groupadd -f kvm

# Create /dev/kvm if it doesn't exist
RUN mkdir -p /dev && \
    mknod /dev/kvm c 10 232 || true && \
    chmod 666 /dev/kvm

# Install Firecracker
RUN ARCH="x86_64" && \
    RELEASE_URL="https://github.com/firecracker-microvm/firecracker/releases" && \
    LATEST_RELEASE_TAG=$(curl -s ${RELEASE_URL}/latest | grep -o 'v[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1) && \
    DOWNLOAD_URL="${RELEASE_URL}/download/${LATEST_RELEASE_TAG}/firecracker-${LATEST_RELEASE_TAG}-${ARCH}" && \
    echo "Downloading Firecracker from: ${DOWNLOAD_URL}" && \
    curl -L -o firecracker "${DOWNLOAD_URL}" && \
    echo "Verifying Firecracker binary..." && \
    chmod +x firecracker && \
    ./firecracker --version && \
    mv firecracker /usr/local/bin/ && \
    echo "Firecracker installation completed successfully"

# Set up Firecracker directories and chroot requirements
RUN mkdir -p /var/lib/firecracker/{kernels,rootfs,images} && \
    mkdir -p /kiln && \
    mkdir -p /tmp/mount-python-3.12/{proc,sys,dev/pts,dev/shm} && \
    chmod -R 777 /var/lib/firecracker && \
    chmod -R 777 /kiln /tmp/mount-python-3.12

WORKDIR /kiln_api
COPY kiln/api/package.json ./
RUN npm install
COPY kiln/api/src ./src
RUN chmod +x ./src/api-entrypoint.sh && \
    find . -type f -name "*.sh" -exec chmod +x {} \;

ENTRYPOINT ["./src/api-entrypoint.sh"]
EXPOSE 2000
EXPOSE 2020