FROM buildpack-deps:buster AS isolate
RUN apt-get update && \
    apt-get install -y --no-install-recommends git libcap-dev && \
    rm -rf /var/lib/apt/lists/* && \
    git clone https://github.com/envicutor/isolate.git /tmp/isolate/ && \
    cd /tmp/isolate && \
    git checkout af6db68042c3aa0ded80787fbb78bc0846ea2114 && \
    make -j$(nproc) install && \
    rm -rf /tmp/*

FROM node:15.10.0-buster-slim
ENV DEBIAN_FRONTEND=noninteractive

RUN dpkg-reconfigure -p critical dash
RUN apt-get update && \
    apt-get install -y git libxml2 gnupg tar coreutils util-linux libc6-dev \
    binutils build-essential locales libpcre3-dev libevent-dev libgmp3-dev \
    libncurses6 libncurses5 libedit-dev libseccomp-dev rename procps python3 \
    libreadline-dev libblas-dev liblapack-dev libpcre3-dev libarpack2-dev \
    libfftw3-dev libglpk-dev libqhull-dev libqrupdate-dev libsuitesparse-dev \
    libsundials-dev libpcre2-dev libcap-dev && \
    rm -rf /var/lib/apt/lists/*

RUN useradd -M kiln

# Create kiln directory and set permissions
RUN mkdir -p /kiln && chown kiln:kiln /kiln

COPY --from=isolate /usr/local/bin/isolate /usr/local/bin
COPY --from=isolate /usr/local/etc/isolate /usr/local/etc/isolate
RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen
RUN chmod 4755 /usr/local/bin/isolate
RUN chmod -R 755 /usr/local/etc/isolate
RUN mkdir -p /var/local/lib/isolate
RUN chown -R root:root /var/local/lib/isolate

WORKDIR /kiln_api
COPY ["package.json", "./"]
RUN npm install
COPY ./src ./src
RUN chmod +x ./src/api-entrypoint.sh
RUN find . -type f -name "*.sh" -exec chmod +x {} \;

ENTRYPOINT ["/bin/bash", "./src/api-entrypoint.sh"]
EXPOSE 2000
EXPOSE 2020