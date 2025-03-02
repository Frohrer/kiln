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
        
        // Verify KVM is available and accessible
        this.verifyKVM();
        
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

    verifyKVM() {
        try {
            // Check if running in a VM
            const isVM = execSync('systemd-detect-virt || true').toString().trim();
            const isInVM = isVM !== 'none' && isVM !== '';
            
            // Check if KVM module is loaded
            const lsmod = execSync('lsmod | grep kvm').toString();
            if (!lsmod.includes('kvm')) {
                if (isInVM) {
                    throw new Error('KVM module is not loaded. Since you are running in a VM, please ensure nested virtualization is enabled in your hypervisor settings.');
                } else {
                    throw new Error('KVM module is not loaded. Please ensure KVM is enabled in BIOS/UEFI and the kvm module is loaded.');
                }
            }

            // Check for nested virtualization if in a VM
            if (isInVM) {
                try {
                    const nestedEnabled = fs.readFileSync('/sys/module/kvm_intel/parameters/nested', 'utf8').trim() === 'Y' ||
                                        fs.readFileSync('/sys/module/kvm_amd/parameters/nested', 'utf8').trim() === '1';
                    if (!nestedEnabled) {
                        throw new Error('Nested virtualization is not enabled. Please enable it in your hypervisor settings.');
                    }
                    logger.debug('Nested virtualization is enabled');
                } catch (error) {
                    if (!error.message.includes('ENOENT')) {
                        throw new Error(`Failed to check nested virtualization status: ${error.message}`);
                    }
                }
            }

            // Check if /dev/kvm exists and is accessible
            if (!fs.existsSync('/dev/kvm')) {
                if (isInVM) {
                    throw new Error('/dev/kvm does not exist. Please ensure nested virtualization is enabled in your hypervisor settings and KVM is properly installed.');
                } else {
                    throw new Error('/dev/kvm does not exist. Please ensure KVM is properly installed.');
                }
            }

            try {
                fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
            } catch (error) {
                throw new Error('/dev/kvm is not accessible. Please ensure current user has proper permissions (usually needs to be in kvm group).');
            }

            logger.debug(`KVM verification passed successfully${isInVM ? ' (running in VM with nested virtualization)' : ''}`);
        } catch (error) {
            if (error.message.includes('Command failed')) {
                throw new Error('Failed to check KVM status. Please ensure KVM and required utilities are installed.');
            }
            throw error;
        }
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
        const mountPoint = `/tmp/mount-${imageId}`;
        const baseRootfsMount = `/tmp/base-rootfs`;
        
        try {
            // Create a new image with more space (4GB)
            execSync(`dd if=/dev/zero of=${imagePath} bs=1M count=4096`);
            execSync(`mkfs.ext4 ${imagePath}`);
            
            // Create mount points
            fs.mkdirSync(mountPoint, { recursive: true });
            fs.mkdirSync(baseRootfsMount, { recursive: true });

            try {
                // Mount the new image
                execSync(`mount -o loop ${imagePath} ${mountPoint}`);

                try {
                    // Mount base rootfs and copy files
                    execSync(`mount -o loop ${baseRootfsPath} ${baseRootfsMount}`);
                    execSync(`cp -a ${baseRootfsMount}/. ${mountPoint}/`);
                    
                    // Ensure all processes are done with the mount before unmounting
                    execSync('sync');
                    execSync(`fuser -k ${baseRootfsMount} || true`);
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
                    // Clean up base rootfs mount with retries
                    await this.cleanupMount(baseRootfsMount);
                }
            } finally {
                // Clean up new image mount with retries
                await this.cleanupMount(mountPoint);
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

    async cleanupMount(mountPath) {
        if (!fs.existsSync(mountPath)) return;

        const maxRetries = 3;
        for (let i = 0; i < maxRetries; i++) {
            try {
                // Ensure all processes are done with the mount
                execSync('sync');
                
                // Try to kill any processes using the mount
                execSync(`fuser -k ${mountPath} || true`);
                
                // Force unmount if needed
                execSync(`umount -f ${mountPath} || umount -l ${mountPath} || true`);
                
                // Wait a bit before trying to remove the directory
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Try to remove the mount point
                fs.rmdirSync(mountPath);
                return;
            } catch (error) {
                if (i === maxRetries - 1) {
                    logger.warn(`Could not cleanup mount point ${mountPath} after ${maxRetries} attempts: ${error}`);
                } else {
                    logger.debug(`Retry ${i + 1}/${maxRetries} cleaning up mount point ${mountPath}`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
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

            // Handle version number differences by extracting major.minor
            const versionMatch = imageId.match(/^([^-]+)-(\d+\.\d+)/);
            if (!versionMatch) {
                throw new Error(`Invalid imageId format: ${imageId}`);
            }
            const [, language, version] = versionMatch;
            const normalizedImageId = `${language}-${version}`;

            // Get the actual image path
            const imagePath = path.join(this.imagesDir, `${normalizedImageId}.ext4`);
            
            // Verify the image exists
            if (!fs.existsSync(imagePath)) {
                throw new Error(`Image not found at ${imagePath}`);
            }

            logger.debug(`