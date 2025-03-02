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
        this.firecrackerPath = process.env.FIRECRACKER_PATH || '/usr/local/bin/firecracker';
        
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

        // Verify Firecracker binary exists and is executable
        if (!fs.existsSync(this.firecrackerPath)) {
            throw new Error(`Firecracker binary not found at ${this.firecrackerPath}`);
        }
        try {
            fs.accessSync(this.firecrackerPath, fs.constants.X_OK);
        } catch (error) {
            throw new Error(`Firecracker binary at ${this.firecrackerPath} is not executable`);
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

            // Verify Firecracker binary exists and is executable
            if (!fs.existsSync(this.firecrackerPath)) {
                throw new Error(`Firecracker binary not found at ${this.firecrackerPath}`);
            }

            try {
                fs.accessSync(this.firecrackerPath, fs.constants.X_OK);
            } catch (error) {
                throw new Error(`Firecracker binary at ${this.firecrackerPath} is not executable: ${error}`);
            }

            // Log binary details
            try {
                const stats = fs.statSync(this.firecrackerPath);
                logger.debug(`Firecracker binary details: size=${stats.size}, mode=${stats.mode.toString(8)}, uid=${stats.uid}, gid=${stats.gid}`);
                
                // Try to read first few bytes to verify it's a valid binary
                const fd = fs.openSync(this.firecrackerPath, 'r');
                const buffer = Buffer.alloc(4);
                fs.readSync(fd, buffer, 0, 4, 0);
                fs.closeSync(fd);
                
                if (buffer[0] !== 0x7f || buffer[1] !== 0x45 || buffer[2] !== 0x4c || buffer[3] !== 0x46) {
                    throw new Error('Firecracker binary is not a valid ELF file');
                }
            } catch (error) {
                logger.error(`Error checking Firecracker binary: ${error}`);
            }

            // Start Firecracker process with full path
            logger.debug(`Starting Firecracker from ${this.firecrackerPath}`);
            const firecracker = spawn(this.firecrackerPath, ['--api-sock', socketPath], {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: process.env
            });

            // Collect stdout and stderr
            let stdout = '';
            let stderr = '';
            firecracker.stdout.on('data', (data) => {
                stdout += data;
                logger.debug(`Firecracker stdout: ${data}`);
            });
            firecracker.stderr.on('data', (data) => {
                stderr += data;
                logger.error(`Firecracker stderr: ${data}`);
            });
            
            // Wait for the socket file to be created and available
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Timeout waiting for Firecracker socket'));
                }, 5000);

                const checkSocket = () => {
                    if (fs.existsSync(socketPath)) {
                        clearTimeout(timeout);
                        resolve();
                    } else {
                        // Check if process has exited
                        if (firecracker.exitCode !== null) {
                            clearTimeout(timeout);
                            reject(new Error(`Firecracker process exited with code ${firecracker.exitCode}. Stdout: ${stdout}, Stderr: ${stderr}`));
                        }
                        setTimeout(checkSocket, 100);
                    }
                };
                checkSocket();
                
                // Add error handler for the Firecracker process
                firecracker.on('error', (error) => {
                    clearTimeout(timeout);
                    reject(new Error(`Failed to start Firecracker: ${error.message}`));
                });
            });

            // Wait a bit more for Firecracker to be ready
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Get the actual image path
            const imagePath = path.join(this.imagesDir, `${imageId}.ext4`);
            
            // Verify the image exists
            if (!fs.existsSync(imagePath)) {
                throw new Error(`Image not found at ${imagePath}`);
            }

            logger.debug(`Using image at path: ${imagePath}`);

            // Configure VM via API
            const vmConfig = {
                boot_source: {
                    kernel_image_path: path.join(this.kernelsDir, 'vmlinux'),
                    boot_args: 'console=ttyS0 reboot=k panic=1 init=/bin/systemd'
                },
                drives: [{
                    drive_id: 'rootfs',
                    path_on_host: imagePath,
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
                // Wait for socket to be available
                const maxRetries = 10;
                let retries = 0;
                
                const tryConnect = () => {
                    const options = {
                        socketPath,
                        method,
                        path,
                        headers: {
                            'Accept': '*/*',
                            'Content-Type': 'application/json'
                        }
                    };

                    if (body) {
                        const bodyStr = JSON.stringify(body);
                        options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
                    }

                    logger.debug(`Making request to Firecracker API: ${method} ${path}`);
                    
                    const req = http.request(options, (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => {
                            if (res.statusCode >= 200 && res.statusCode < 300) {
                                logger.debug(`Firecracker API request successful: ${method} ${path}`);
                                resolve(data ? JSON.parse(data) : undefined);
                            } else {
                                reject(new Error(`Firecracker API request failed with status ${res.statusCode}: ${data}`));
                            }
                        });
                    });

                    req.on('error', (err) => {
                        if ((err.code === 'ENOENT' || err.code === 'ECONNREFUSED') && retries < maxRetries) {
                            logger.debug(`Retrying connection to socket (attempt ${retries + 1}/${maxRetries})`);
                            retries++;
                            setTimeout(tryConnect, 500);
                        } else {
                            reject(err);
                        }
                    });

                    if (body) {
                        const bodyStr = JSON.stringify(body);
                        logger.debug(`Request body: ${bodyStr}`);
                        req.write(bodyStr);
                    }
                    req.end();
                };

                tryConnect();
            });
        };

        try {
            // Wait for the socket to be available
            await new Promise(resolve => setTimeout(resolve, 1000));

            logger.debug(`Configuring VM with socket at ${socketPath}`);

            // Configure boot source
            logger.debug('Configuring boot source...');
            await makeRequest('PUT', '/boot-source', config.boot_source);

            // Configure drives
            logger.debug('Configuring drives...');
            for (const drive of config.drives) {
                await makeRequest('PUT', `/drives/${drive.drive_id}`, drive);
            }

            // Configure machine
            logger.debug('Configuring machine...');
            await makeRequest('PUT', '/machine-config', config.machine_config);

            // Configure network if specified
            if (config.network_interfaces) {
                logger.debug('Configuring network interfaces...');
                for (const network of config.network_interfaces) {
                    await makeRequest('PUT', `/network-interfaces/${network.iface_id}`, network);
                }
            }

            // Start the VM
            logger.debug('Starting VM...');
            await makeRequest('PUT', '/actions', { action_type: 'InstanceStart' });
            logger.debug('VM started successfully');
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
            logger.debug(`Stopping VM ${vmId}`);
            
            const options = {
                socketPath: instance.socket,
                method: 'PUT',
                path: '/actions',
                headers: {
                    'Accept': '*/*',
                    'Content-Type': 'application/json'
                }
            };

            const body = JSON.stringify({ action_type: 'SendCtrlAltDel' });
            options.headers['Content-Length'] = Buffer.byteLength(body);

            await new Promise((resolve, reject) => {
                logger.debug('Sending shutdown signal to VM');
                const req = http.request(options, (res) => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        logger.debug('Shutdown signal sent successfully');
                        resolve();
                    } else {
                        reject(new Error(`Failed to send shutdown signal: ${res.statusCode}`));
                    }
                });

                req.on('error', (err) => {
                    logger.error(`Error sending shutdown signal: ${err}`);
                    reject(err);
                });

                req.write(body);
                req.end();
            });

            // Wait for VM to shutdown
            logger.debug('Waiting for VM to shutdown');
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Force kill if still running
            logger.debug('Force killing VM process');
            instance.process.kill();

            // Clean up socket file
            if (fs.existsSync(instance.socket)) {
                logger.debug('Cleaning up socket file');
                fs.unlinkSync(instance.socket);
            }

            this.vmInstances.delete(vmId);
            logger.debug(`VM ${vmId} stopped successfully`);
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