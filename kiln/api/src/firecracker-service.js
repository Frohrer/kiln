const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('logplease').create('firecracker-service');
const runtime = require('./runtime');
const fetch = require('node-fetch');
const http = require('http');
const { Agent } = require('http');
const { createConnection } = require('net');

class FirecrackerService {
    constructor() {
        this.vmInstances = new Map();
        this.imagesDir = '/var/lib/firecracker/images';
        this.kernelsDir = '/var/lib/firecracker/kernels';
        this.rootfsDir = '/var/lib/firecracker/rootfs';
        
        // Ensure directories exist
        [this.imagesDir, this.kernelsDir, this.rootfsDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });

        // Verify kernel and base rootfs exist
        const kernelPath = path.join(this.kernelsDir, 'vmlinux');
        const baseRootfsPath = path.join(this.rootfsDir, 'base.ext4');
        
        if (!fs.existsSync(kernelPath)) {
            throw new Error('Kernel image not found');
        }
        if (!fs.existsSync(baseRootfsPath)) {
            throw new Error('Base rootfs not found');
        }

        // Register existing VM images
        this.registerExistingImages();
    }

    registerExistingImages() {
        try {
            const files = fs.readdirSync(this.imagesDir);
            for (const file of files) {
                if (file.endsWith('.ext4')) {
                    const imagePath = path.join(this.imagesDir, file);
                    runtime.load_package(imagePath);
                }
            }
        } catch (error) {
            logger.error('Failed to register existing images:', error);
        }
    }

    async buildImage(language, version, files) {
        const imageId = `${language}-${version}`;
        const imagePath = path.join(this.imagesDir, `${imageId}.ext4`);
        const baseRootfsPath = path.join(this.rootfsDir, 'base.ext4');
        
        try {
            // Create a new image with more space (4GB)
            execSync(`dd if=/dev/zero of=${imagePath} bs=1M count=4096`);
            execSync(`mkfs.ext4 ${imagePath}`);
            
            // Create mount points
            const mountPoint = `/tmp/mount-${imageId}`;
            const baseRootfsMount = `/tmp/base-rootfs`;
            fs.mkdirSync(mountPoint, { recursive: true });
            fs.mkdirSync(baseRootfsMount, { recursive: true });

            try {
                // Mount the new image
                execSync(`mount -o loop ${imagePath} ${mountPoint}`);

                try {
                    // Mount base rootfs and copy files
                    execSync(`mount -o loop ${baseRootfsPath} ${baseRootfsMount}`);
                    execSync(`cp -a ${baseRootfsMount}/. ${mountPoint}/`);
                    execSync(`umount ${baseRootfsMount}`);

                    // Create necessary directories
                    execSync(`mkdir -p ${mountPoint}/app`);
                    execSync(`mkdir -p ${mountPoint}/var/cache/apt/archives`);
                    execSync(`mkdir -p ${mountPoint}/var/lib/apt/lists`);

                    // Copy files to the image
                    for (const file of files) {
                        const filePath = path.join(mountPoint, 'app', file.name);
                        fs.writeFileSync(filePath, file.content);
                        fs.chmodSync(filePath, 0o755); // Make files executable
                    }

                    // Setup language-specific environment
                    await this.setupLanguageEnvironment(mountPoint, language, version);

                    // Register the runtime
                    runtime.load_package(imagePath);

                    return {
                        success: true,
                        imageId,
                        path: imagePath
                    };
                } finally {
                    // Clean up base rootfs mount
                    try {
                        if (fs.existsSync(baseRootfsMount)) {
                            execSync(`umount ${baseRootfsMount} 2>/dev/null || true`);
                            // Wait a bit before trying to remove the directory
                            setTimeout(() => {
                                try {
                                    fs.rmdirSync(baseRootfsMount);
                                } catch (e) {
                                    logger.warn(`Could not remove base rootfs mount point: ${e}`);
                                }
                            }, 1000);
                        }
                    } catch (error) {
                        logger.error(`Failed to clean up base rootfs mount: ${error}`);
                    }
                }
            } finally {
                // Clean up new image mount
                try {
                    execSync(`umount ${mountPoint} 2>/dev/null || true`);
                    // Wait a bit before trying to remove the directory
                    setTimeout(() => {
                        try {
                            fs.rmdirSync(mountPoint);
                        } catch (e) {
                            logger.warn(`Could not remove mount point: ${e}`);
                        }
                    }, 1000);
                } catch (error) {
                    logger.error(`Failed to clean up mount point: ${error}`);
                }
            }
        } catch (error) {
            // Cleanup on failure
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }
            logger.error(`Failed to build image: ${error}`);
            throw error;
        }
    }

    async setupLanguageEnvironment(mountPoint, language, version) {
        // Create a script to setup the environment
        const setupScript = this.generateSetupScript(language, version);
        const scriptPath = path.join(mountPoint, 'setup.sh');
        fs.writeFileSync(scriptPath, setupScript);
        fs.chmodSync(scriptPath, 0o755);

        // Execute setup in chroot
        execSync(`chroot ${mountPoint} /setup.sh`);
    }

    generateSetupScript(language, version) {
        let script = '#!/bin/bash\n';
        
        // Add base system setup
        script += `
            # Setup DNS
            echo "nameserver 8.8.8.8" > /etc/resolv.conf
            echo "nameserver 8.8.4.4" >> /etc/resolv.conf

            # Setup dpkg directories
            mkdir -p /var/lib/dpkg
            touch /var/lib/dpkg/status
            mkdir -p /var/lib/apt/lists
            mkdir -p /var/cache/apt/archives/partial
            mkdir -p /var/lib/dpkg/updates
            mkdir -p /var/lib/dpkg/info
            mkdir -p /var/lib/dpkg/alternatives
            mkdir -p /var/lib/dpkg/parts
            mkdir -p /var/lib/dpkg/triggers
            mkdir -p /run/lock

            # Initialize dpkg status
            if [ ! -f /var/lib/dpkg/status ]; then
                touch /var/lib/dpkg/status
                echo "" > /var/lib/dpkg/status
            fi

            # Mount required filesystems
            mount -t devpts devpts /dev/pts
            mount -t proc proc /proc

            # Update package lists
            apt-get clean
            rm -rf /var/lib/apt/lists/*
            apt-get update

            # Install essential packages first
            DEBIAN_FRONTEND=noninteractive apt-get install -y apt-utils
            DEBIAN_FRONTEND=noninteractive apt-get install -y software-properties-common gnupg wget ca-certificates
        `;
        
        switch(language) {
            case 'python':
                script += `
                    # Add deadsnakes PPA for Python versions
                    add-apt-repository -y ppa:deadsnakes/ppa
                    apt-get update

                    # Install Python and dependencies
                    DEBIAN_FRONTEND=noninteractive apt-get install -y python${version} python${version}-distutils

                    # Install pip
                    wget https://bootstrap.pypa.io/get-pip.py
                    python${version} get-pip.py
                    rm get-pip.py

                    # Create symlinks
                    ln -sf /usr/bin/python${version} /usr/bin/python
                    ln -sf /usr/local/bin/pip${version} /usr/bin/pip

                    # Create app directory
                    mkdir -p /app
                    chmod 755 /app
                `;
                break;
            case 'nodejs':
                script += `
                    curl -fsSL https://deb.nodesource.com/setup_${version}.x | bash -
                    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs

                    # Create app directory
                    mkdir -p /app
                    chmod 755 /app
                `;
                break;
        }

        // Cleanup
        script += `
            # Cleanup to save space
            apt-get clean
            rm -rf /var/lib/apt/lists/*
        `;

        return script;
    }

    async removeImage(imageId) {
        const imagePath = path.join(this.imagesDir, `${imageId}.ext4`);
        if (fs.existsSync(imagePath)) {
            fs.unlinkSync(imagePath);
            return true;
        }
        return false;
    }

    async startVM(imageId, config) {
        const vmId = uuidv4();
        const socketPath = `/tmp/firecracker-${vmId}.sock`;

        try {
            // Remove socket file if it exists
            if (fs.existsSync(socketPath)) {
                fs.unlinkSync(socketPath);
            }

            // Start Firecracker process
            const firecracker = spawn('firecracker', ['--api-sock', socketPath]);
            
            // Wait for the socket file to be created and available
            await new Promise((resolve, reject) => {
                const checkSocket = () => {
                    if (fs.existsSync(socketPath)) {
                        resolve();
                    } else {
                        setTimeout(checkSocket, 100);
                    }
                };
                checkSocket();
                
                // Add error handler for the Firecracker process
                firecracker.on('error', reject);
                firecracker.stderr.on('data', (data) => {
                    logger.error(`Firecracker stderr: ${data}`);
                });
            });

            // Wait a bit more for Firecracker to be ready
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Configure VM via API
            const vmConfig = {
                boot_source: {
                    kernel_image_path: path.join(this.kernelsDir, 'vmlinux'),
                    boot_args: 'console=ttyS0 reboot=k panic=1 init=/bin/systemd'
                },
                drives: [{
                    drive_id: 'rootfs',
                    path_on_host: path.join(this.imagesDir, `${imageId}.ext4`),
                    is_root_device: true,
                    is_read_only: false
                }],
                machine_config: {
                    vcpu_count: config.cpu_count || 1,
                    mem_size_mib: config.memory_limit || 1024,
                    ht_enabled: false
                },
                network_interfaces: [{
                    iface_id: 'eth0',
                    host_dev_name: 'tap0',
                    guest_mac: 'AA:FC:00:00:00:01'
                }]
            };

            // Configure the VM using Firecracker's API
            await this.configureVM(socketPath, vmConfig);

            // Store VM instance
            this.vmInstances.set(vmId, {
                process: firecracker,
                socket: socketPath,
                config: vmConfig,
                startTime: Date.now()
            });

            return {
                vmId,
                socket: socketPath
            };
        } catch (error) {
            logger.error(`Failed to start VM: ${error}`);
            throw error;
        }
    }

    async configureVM(socketPath, config) {
        // Helper function to make API calls to Firecracker via Unix socket
        const makeRequest = async (method, path, body) => {
            return new Promise((resolve, reject) => {
                const agent = new Agent({
                    createConnection: () => createConnection(socketPath)
                });

                const options = {
                    agent,
                    method,
                    path,
                    headers: {
                        'Accept': '*/*'
                    }
                };

                if (body) {
                    const bodyStr = JSON.stringify(body);
                    options.headers['Content-Type'] = 'application/json';
                    options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
                }

                // Wait for socket to be available
                const req = http.request(options, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(data ? JSON.parse(data) : undefined);
                        } else {
                            reject(new Error(`Firecracker API request failed with status ${res.statusCode}: ${data}`));
                        }
                    });
                });

                req.on('error', reject);

                if (body) {
                    req.write(JSON.stringify(body));
                }
                req.end();
            });
        };

        try {
            // Wait for the socket to be available
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Configure boot source
            await makeRequest('PUT', '/boot-source', config.boot_source);

            // Configure drives
            for (const drive of config.drives) {
                await makeRequest('PUT', `/drives/${drive.drive_id}`, drive);
            }

            // Configure machine
            await makeRequest('PUT', '/machine-config', config.machine_config);

            // Configure network if specified
            if (config.network_interfaces) {
                for (const network of config.network_interfaces) {
                    await makeRequest('PUT', `/network-interfaces/${network.iface_id}`, network);
                }
            }

            // Start the VM
            await makeRequest('PUT', '/actions', { action_type: 'InstanceStart' });
        } catch (error) {
            logger.error(`Failed to configure VM: ${error}`);
            throw error;
        }
    }

    async stopVM(vmId) {
        const instance = this.vmInstances.get(vmId);
        if (!instance) {
            return false;
        }

        try {
            const agent = new Agent({
                createConnection: () => createConnection(instance.socket)
            });

            const options = {
                agent,
                method: 'PUT',
                path: '/actions',
                headers: {
                    'Accept': '*/*',
                    'Content-Type': 'application/json'
                }
            };

            await new Promise((resolve, reject) => {
                const req = http.request(options, (res) => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve();
                    } else {
                        reject(new Error(`Failed to send shutdown signal: ${res.statusCode}`));
                    }
                });

                req.on('error', reject);
                const body = JSON.stringify({ action_type: 'SendCtrlAltDel' });
                req.setHeader('Content-Length', Buffer.byteLength(body));
                req.write(body);
                req.end();
            });

            // Wait for VM to shutdown
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Force kill if still running
            instance.process.kill();

            // Clean up socket file
            if (fs.existsSync(instance.socket)) {
                fs.unlinkSync(instance.socket);
            }

            this.vmInstances.delete(vmId);
            return true;
        } catch (error) {
            logger.error(`Failed to stop VM: ${error}`);
            throw error;
        }
    }

    async executeInVM(vmId, command) {
        const instance = this.vmInstances.get(vmId);
        if (!instance) {
            throw new Error('VM not found');
        }

        try {
            // Execute command via vsock or SSH
            // This is a placeholder - actual implementation would depend on the communication method
            // You might want to use SSH, vsock, or another method to execute commands
            return {
                stdout: '',
                stderr: '',
                exitCode: 0
            };
        } catch (error) {
            logger.error(`Failed to execute command in VM: ${error}`);
            throw error;
        }
    }
}

module.exports = new FirecrackerService(); 