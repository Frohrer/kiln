FROM node:15.10.0-buster-slim
ENV DEBIAN_FRONTEND=noninteractive

RUN dpkg-reconfigure -p critical dash
RUN apt-get update && \
    apt-get install -y git libxml2 gnupg tar coreutils util-linux libc6-dev \
    binutils build-essential locales libpcre3-dev libevent-dev libgmp3-dev \
    libncurses6 libncurses5 libedit-dev libseccomp-dev rename procps python3 \
    libreadline-dev libblas-dev liblapack-dev libpcre3-dev libarpack2-dev \
    libfftw3-dev libglpk-dev libqhull-dev libqrupdate-dev libsuitesparse-dev \
    libsundials-dev libpcre2-dev libcap-dev curl wget iproute2 jq docker.io e2fsprogs \
    bc flex bison libelf-dev && \
    rm -rf /var/lib/apt/lists/*

# Install KVM kernel module and required tools
RUN apt-get update && \
    apt-get install -y qemu-kvm && \
    rm -rf /var/lib/apt/lists/* && \
    # Create kvm group if it doesn't exist
    groupadd -f kvm

# Create kiln user and group
RUN useradd -M kiln && \
    usermod -aG kvm kiln && \
    # Verify group membership
    groups kiln | grep kvm

# Install Firecracker
RUN curl -Lo firecracker https://github.com/firecracker-microvm/firecracker/releases/download/v1.5.0/firecracker-v1.5.0-x86_64 && \
    chmod +x firecracker && \
    mv firecracker /usr/local/bin/

# Build custom kernel and create rootfs
RUN set -e && \
    ARCH="$(uname -m)" && \
    # Create necessary directories
    mkdir -p /var/lib/firecracker/{kernels,rootfs,images} && \
    mkdir -p /kiln && \
    # Clone and build Linux kernel
    cd /tmp && \
    git clone --depth 1 --branch v5.10 https://github.com/torvalds/linux.git linux.git && \
    cd linux.git && \
    # Basic kernel config for Firecracker
    echo 'CONFIG_SERIAL_8250=y' > .config && \
    echo 'CONFIG_SERIAL_8250_CONSOLE=y' >> .config && \
    echo 'CONFIG_EXT4_FS=y' >> .config && \
    echo 'CONFIG_VIRTIO_BLK=y' >> .config && \
    echo 'CONFIG_VIRTIO_NET=y' >> .config && \
    echo 'CONFIG_VIRTIO=y' >> .config && \
    echo 'CONFIG_VIRTIO_PCI=y' >> .config && \
    echo 'CONFIG_VIRTIO_MMIO=y' >> .config && \
    echo 'CONFIG_NET_9P=y' >> .config && \
    echo 'CONFIG_NET_9P_VIRTIO=y' >> .config && \
    echo 'CONFIG_9P_FS=y' >> .config && \
    echo 'CONFIG_SQUASHFS=y' >> .config && \
    echo 'CONFIG_SQUASHFS_XZ=y' >> .config && \
    echo 'CONFIG_DEVTMPFS=y' >> .config && \
    echo 'CONFIG_CGROUPS=y' >> .config && \
    echo 'CONFIG_INOTIFY_USER=y' >> .config && \
    echo 'CONFIG_SIGNALFD=y' >> .config && \
    echo 'CONFIG_TIMERFD=y' >> .config && \
    echo 'CONFIG_EPOLL=y' >> .config && \
    echo 'CONFIG_NR_CPUS=1' >> .config && \
    echo 'CONFIG_EMBEDDED=y' >> .config && \
    echo 'CONFIG_SYSFS=y' >> .config && \
    echo 'CONFIG_PROC_FS=y' >> .config && \
    echo 'CONFIG_NAMESPACES=y' >> .config && \
    echo 'CONFIG_UNIX=y' >> .config && \
    echo 'CONFIG_POSIX_MQUEUE=y' >> .config && \
    echo 'CONFIG_FUTEX=y' >> .config && \
    echo 'CONFIG_SHMEM=y' >> .config && \
    echo 'CONFIG_PRINTK=y' >> .config && \
    echo 'CONFIG_BUG=y' >> .config && \
    echo 'CONFIG_PCIEPORTBUS=y' >> .config && \
    echo 'CONFIG_PCI_MSI=y' >> .config && \
    echo 'CONFIG_DEBUG_KERNEL=n' >> .config && \
    echo 'CONFIG_SMP=n' >> .config && \
    make olddefconfig && \
    make -j$(nproc) vmlinux && \
    cp vmlinux /var/lib/firecracker/kernels/ && \
    cd / && rm -rf /tmp/linux.git && \
    # Create rootfs
    dd if=/dev/zero of=/var/lib/firecracker/rootfs/base.ext4 bs=1M count=200 && \
    mkfs.ext4 /var/lib/firecracker/rootfs/base.ext4 && \
    mkdir -p /tmp/my-rootfs && \
    mount /var/lib/firecracker/rootfs/base.ext4 /tmp/my-rootfs && \
    # Use Alpine to create the rootfs
    docker run --rm -v /tmp/my-rootfs:/my-rootfs alpine sh -c '\
        apk add openrc util-linux && \
        ln -s agetty /etc/init.d/agetty.ttyS0 && \
        echo ttyS0 > /etc/securetty && \
        rc-update add agetty.ttyS0 default && \
        rc-update add devfs boot && \
        rc-update add procfs boot && \
        rc-update add sysfs boot && \
        for d in bin etc lib root sbin usr; do tar c "/$d" | tar x -C /my-rootfs; done && \
        for dir in dev proc run sys var; do mkdir /my-rootfs/${dir}; done \
    ' && \
    umount /tmp/my-rootfs && \
    rm -rf /tmp/my-rootfs && \
    # Verify files exist and have size
    [ -s /var/lib/firecracker/kernels/vmlinux ] && \
    [ -s /var/lib/firecracker/rootfs/base.ext4 ] && \
    # Set permissions
    chown -R kiln:kiln /var/lib/firecracker /kiln && \
    chmod -R 755 /var/lib/firecracker /kiln

WORKDIR /kiln_api
COPY ["package.json", "./"]
RUN npm install
COPY ./src ./src
RUN chmod +x ./src/api-entrypoint.sh && \
    find . -type f -name "*.sh" -exec chmod +x {} \; && \
    chown -R kiln:kiln .

USER kiln
ENTRYPOINT ["/bin/bash", "./src/api-entrypoint.sh"]
EXPOSE 2000
EXPOSE 2020