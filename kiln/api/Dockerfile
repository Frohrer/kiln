FROM node:15.10.0-buster-slim
ENV DEBIAN_FRONTEND=noninteractive

RUN dpkg-reconfigure -p critical dash
RUN apt-get update && \
    apt-get install -y git libxml2 gnupg tar coreutils util-linux libc6-dev \
    binutils build-essential locales libpcre3-dev libevent-dev libgmp3-dev \
    libncurses6 libncurses5 libedit-dev libseccomp-dev rename procps python3 \
    libreadline-dev libblas-dev liblapack-dev libpcre3-dev libarpack2-dev \
    libfftw3-dev libglpk-dev libqhull-dev libqrupdate-dev libsuitesparse-dev \
    libsundials-dev libpcre2-dev libcap-dev curl wget iproute2 && \
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

# Create directories, set permissions, and download Firecracker assets
RUN mkdir -p /var/lib/firecracker/{kernels,rootfs,images} && \
    mkdir -p /kiln && \
    chown -R kiln:kiln /var/lib/firecracker /kiln && \
    chmod -R 755 /var/lib/firecracker /kiln && \
    # Download kernel and rootfs
    wget https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/x86_64/kernels/vmlinux.bin -O /var/lib/firecracker/kernels/vmlinux && \
    wget https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/x86_64/rootfs/bionic.rootfs.ext4 -O /var/lib/firecracker/rootfs/base.ext4 && \
    # Ensure proper ownership of downloaded files
    chown -R kiln:kiln /var/lib/firecracker

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