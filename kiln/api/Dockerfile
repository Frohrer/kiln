FROM node:15.10.0-buster-slim
ENV DEBIAN_FRONTEND=noninteractive

RUN dpkg-reconfigure -p critical dash
RUN apt-get update && \
    apt-get install -y git libxml2 gnupg tar coreutils util-linux libc6-dev \
    binutils build-essential locales libpcre3-dev libevent-dev libgmp3-dev \
    libncurses6 libncurses5 libedit-dev libseccomp-dev rename procps python3 \
    libreadline-dev libblas-dev liblapack-dev libpcre3-dev libarpack2-dev \
    libfftw3-dev libglpk-dev libqhull-dev libqrupdate-dev libsuitesparse-dev \
    libsundials-dev libpcre2-dev libcap-dev curl wget iproute2 jq docker.io e2fsprogs && \
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

# Set up Firecracker directories and create rootfs
RUN set -ex && \
    # Create necessary directories
    mkdir -p /var/lib/firecracker/kernels && \
    mkdir -p /var/lib/firecracker/rootfs && \
    mkdir -p /var/lib/firecracker/images && \
    mkdir -p /kiln && \
    ls -la /var/lib/firecracker/ && \
    # Create rootfs
    dd if=/dev/zero of=/var/lib/firecracker/rootfs/base.ext4 bs=1M count=200 && \
    ls -la /var/lib/firecracker/rootfs/ && \
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