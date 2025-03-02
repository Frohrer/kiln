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
    kmod util-linux iproute2 procps systemd fuse psmisc && \
    rm -rf /var/lib/apt/lists/*

# Install gosu properly
RUN set -eux; \
    apt-get update; \
    apt-get install -y gosu; \
    rm -rf /var/lib/apt/lists/*; \
    # verify that the binary works
    gosu nobody true

# Install KVM kernel module and required tools
RUN apt-get update && \
    apt-get install -y qemu-kvm && \
    rm -rf /var/lib/apt/lists/* && \
    # Create kvm group if it doesn't exist
    groupadd -f kvm

# Create kiln user and group with proper permissions
RUN useradd -M kiln && \
    usermod -aG kvm kiln && \
    usermod -aG disk kiln && \
    # Create /dev/kvm if it doesn't exist (for Docker environments)
    mkdir -p /dev && \
    mknod /dev/kvm c 10 232 || true && \
    chown root:kvm /dev/kvm && \
    chmod 660 /dev/kvm && \
    # Verify group membership
    groups kiln | grep kvm

# Install Firecracker
RUN curl -Lo firecracker https://github.com/firecracker-microvm/firecracker/releases/download/v1.5.0/firecracker-v1.5.0-x86_64 && \
    chmod +x firecracker && \
    mv firecracker /usr/local/bin/

# Set up Firecracker directories with proper permissions
RUN mkdir -p /var/lib/firecracker/{kernels,rootfs,images} && \
    mkdir -p /kiln && \
    mkdir -p /tmp/mount-python-3.12 && \
    chown -R kiln:kiln /var/lib/firecracker && \
    chmod -R 775 /var/lib/firecracker && \
    chown -R kiln:kiln /kiln /tmp/mount-python-3.12 && \
    chmod -R 755 /kiln /tmp/mount-python-3.12

WORKDIR /kiln_api
COPY kiln/api/package.json ./
RUN npm install
COPY kiln/api/src ./src
RUN chmod +x ./src/api-entrypoint.sh && \
    find . -type f -name "*.sh" -exec chmod +x {} \; && \
    chown -R kiln:kiln .

# Create a wrapper script for privileged operations
RUN echo '#!/bin/bash\n\
exec gosu root "$@"' > /usr/local/bin/run-as-root.sh && \
chmod +x /usr/local/bin/run-as-root.sh

# Create the entrypoint wrapper
RUN echo '#!/bin/bash\n\
# Ensure /dev/kvm exists and has proper permissions\n\
if [ ! -e /dev/kvm ]; then\n\
    mknod /dev/kvm c 10 232 || true\n\
fi\n\
chown root:kvm /dev/kvm\n\
chmod 660 /dev/kvm\n\
\n\
# Ensure Firecracker directories exist with proper permissions\n\
mkdir -p /var/lib/firecracker/{kernels,rootfs,images}\n\
chown -R kiln:kiln /var/lib/firecracker\n\
chmod -R 775 /var/lib/firecracker\n\
\n\
# Run the actual entrypoint script as kiln user\n\
exec gosu kiln /bin/bash ./src/api-entrypoint.sh' > /usr/local/bin/entrypoint-wrapper.sh && \
chmod +x /usr/local/bin/entrypoint-wrapper.sh

# Run as root initially, the entrypoint script will drop privileges
ENTRYPOINT ["/bin/bash", "/usr/local/bin/entrypoint-wrapper.sh"]
EXPOSE 2000
EXPOSE 2020