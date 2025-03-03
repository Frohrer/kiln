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
            let isInVM = false;
            let vmType = '';
            try {
                const isVM = execSync('which systemd-detect-virt && systemd-detect-virt || true').toString().trim();
                isInVM = isVM !== 'none' && isVM !== '';
                if (isInVM) {
                    vmType = isVM;
                }
            } catch (error) {
                // Try alternative VM detection methods
                try {
                    const dmiInfo = execSync('cat /sys/class/dmi/id/product_name 2>/dev/null || true').toString().trim();
                    if (dmiInfo.includes('VMware') || dmiInfo.includes('VirtualBox') || dmiInfo.includes('Hyper-V')) {
                        isInVM = true;
                        vmType = dmiInfo;
                    }
                } catch (error) {
                    logger.warn('Could not check DMI info for VM detection');
                }

                try {
                    const cpuInfo = execSync('grep -i "^flags.*\( vmx\| svm\)" /proc/cpuinfo || true').toString().trim();
                    if (cpuInfo.includes('vmx') || cpuInfo.includes('svm')) {
                        logger.debug('CPU supports virtualization');
                    }
                } catch (error) {
                    logger.warn('Could not check CPU virtualization support');
                }
            }

            // Check if KVM module is loaded
            try {
                const lsmodExists = execSync('which lsmod || true').toString().trim();
                if (!lsmodExists) {
                    logger.warn('lsmod command not found, checking /proc/modules directly');
                    try {
                        const modules = execSync('cat /proc/modules').toString();
                        if (!modules.includes('kvm')) {
                            throw new Error('KVM module not found in /proc/modules');
                        }
                    } catch (error) {
                        if (isInVM) {
                            logger.error('Running in VM environment, but KVM module is not loaded');
                            logger.error('VM Type detected:', vmType);
                            logger.error('Please ensure:');
                            logger.error('1. Nested virtualization is enabled in your hypervisor settings');
                            logger.error('2. Your host system has KVM support enabled in BIOS/UEFI');
                            logger.error('3. The KVM module is loaded on your host system');
                            throw new Error(`KVM module is not loaded. Since you are running in a VM (${vmType}), please ensure nested virtualization is enabled in your hypervisor settings.`);
                        } else {
                            throw new Error('KVM module is not loaded. Please ensure KVM is enabled in BIOS/UEFI and the kvm module is loaded.');
                        }
                    }
                }
                
                const lsmod = execSync('lsmod | grep kvm || true').toString();
                if (!lsmod.includes('kvm')) {
                    if (isInVM) {
                        logger.error('Running in VM environment, but KVM module is not loaded');
                        logger.error('VM Type detected:', vmType);
                        logger.error('Please ensure:');
                        logger.error('1. Nested virtualization is enabled in your hypervisor settings');
                        logger.error('2. Your host system has KVM support enabled in BIOS/UEFI');
                        logger.error('3. The KVM module is loaded on your host system');
                        throw new Error(`KVM module is not loaded. Since you are running in a VM (${vmType}), please ensure nested virtualization is enabled in your hypervisor settings.`);
                    } else {
                        throw new Error('KVM module is not loaded. Please ensure KVM is enabled in BIOS/UEFI and the kvm module is loaded.');
                    }
                }
            } catch (error) {
                if (error.message.includes('not found')) {
                    throw error;
                }
                logger.error('Error checking KVM module:', error);
                throw new Error('Failed to check KVM module status. Please ensure KVM is properly installed.');
            }

            // Check for nested virtualization if in a VM
            if (isInVM) {
                try {
                    const nestedEnabled = fs.existsSync('/sys/module/kvm_intel/parameters/nested') ?
                        fs.readFileSync('/sys/module/kvm_intel/parameters/nested', 'utf8').trim() === 'Y' :
                        fs.existsSync('/sys/module/kvm_amd/parameters/nested') &&
                        fs.readFileSync('/sys/module/kvm_amd/parameters/nested', 'utf8').trim() === '1';
                    
                    if (!nestedEnabled) {
                        logger.error('Nested virtualization is not enabled');
                        logger.error('VM Type detected:', vmType);
                        logger.error('Please ensure:');
                        logger.error('1. Nested virtualization is enabled in your hypervisor settings');
                        logger.error('2. Your host system has KVM support enabled in BIOS/UEFI');
                        throw new Error('Nested virtualization is not enabled. Please enable it in your hypervisor settings.');
                    }
                    logger.debug('Nested virtualization is enabled');
                } catch (error) {
                    if (!error.message.includes('ENOENT')) {
                        logger.error('Error checking nested virtualization:', error);
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

            logger.debug(`KVM verification passed successfully${isInVM ? ` (running in VM type: ${vmType})` : ''}`);
        } catch (error) {
            logger.error('KVM verification failed:', error);
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
        // Normalize version for Python (extract major.minor only)
        let normalizedVersion = version;
        if (language === 'python') {
            // If version is already in major.minor format, use it as is
            // Otherwise extract major.minor from the full version (e.g., 3.12.8 -> 3.12)
            normalizedVersion = version.split('.').slice(0, 2).join('.');
        }
        
        const imageId = `${language}-${normalizedVersion}`;
        const imagePath = path.join(this.imagesDir, `${imageId}.ext4`);
        const baseRootfsPath = path.join(this.rootfsDir, 'base.ext4');
        const mountPoint = `/tmp/mount-${imageId}`;
        
        logger.debug(`Building image for ${language} ${version} (normalized: ${normalizedVersion})`);
        logger.debug(`Image path: ${imagePath}`);
        logger.debug(`Mount point: ${mountPoint}`);
        
        try {
            // Create a new image with more space (4GB)
            execSync(`dd if=/dev/zero of=${imagePath} bs=1M count=4096`);
            execSync(`mkfs.ext4 ${imagePath}`);
            
            // Create mount point
            execSync(`mkdir -p ${mountPoint}`);

            try {
                // Mount the new image
                execSync(`mount -o loop ${imagePath} ${mountPoint}`);

                try {
                    // Copy base rootfs content
                    execSync(`mount -o loop,ro ${baseRootfsPath} /mnt`);
                    execSync(`cp -a /mnt/. ${mountPoint}/`);
                    execSync(`umount /mnt`);

                    // Create necessary directories
                    execSync(`mkdir -p ${mountPoint}/app`);
                    execSync(`mkdir -p ${mountPoint}/var/cache/apt/archives`);
                    execSync(`mkdir -p ${mountPoint}/var/lib/apt/lists`);

                    // Copy files to the image
                    for (const file of files) {
                        const filePath = path.join(mountPoint, 'app', file.name);
                        fs.writeFileSync(filePath, file.content);
                        execSync(`chmod 755 ${filePath}`);
                    }

                    // Setup language-specific environment
                    try {
                        await this.setupLanguageEnvironment(mountPoint, language, version);
                    } catch (error) {
                        logger.error(`Failed to setup language environment: ${error.message}`);
                        throw new Error(`Failed to setup ${language} ${version} environment: ${error.message}`);
                    }

                    // Create package manifest
                    const manifest = {
                        language,
                        version,  // Use full version number for semver compatibility
                        runtime: language,
                        aliases: [],
                        limits: {
                            compile_timeout: 30000,
                            run_timeout: 30000,
                            compile_memory_limit: 512,
                            run_memory_limit: 512,
                            compile_cpu_time: 10,
                            run_cpu_time: 10,
                            max_process_count: 64,
                            max_open_files: 1024,
                            max_file_size: 10485760,
                            output_max_size: 1048576
                        }
                    };

                    // Write manifest file with new name
                    const manifestPath = path.join(mountPoint, 'kiln-manifest');
                    logger.debug(`Writing manifest to ${manifestPath}`);
                    logger.debug(`Manifest content: ${JSON.stringify(manifest, null, 2)}`);
                    
                    try {
                        // List directory contents before writing
                        logger.debug(`Directory contents before writing manifest:`, fs.readdirSync(mountPoint));
                        
                        // Write manifest with sync to ensure it's written to disk
                        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
                        execSync(`chmod 644 ${manifestPath}`);
                        execSync('sync');  // Ensure all writes are flushed to disk
                        
                        // List directory contents after writing
                        logger.debug(`Directory contents after writing manifest:`, fs.readdirSync(mountPoint));
                        
                        // Verify manifest was written
                        if (!fs.existsSync(manifestPath)) {
                            throw new Error('Manifest file was not created');
                        }
                        
                        const writtenContent = fs.readFileSync(manifestPath, 'utf8');
                        logger.debug(`Verified manifest content: ${writtenContent}`);
                        
                        // Double check manifest is valid JSON
                        try {
                            JSON.parse(writtenContent);
                            logger.debug('Manifest is valid JSON');
                        } catch (e) {
                            throw new Error(`Written manifest is not valid JSON: ${e.message}`);
                        }
                    } catch (error) {
                        logger.error(`Failed to write manifest: ${error.message}`);
                        throw error;
                    }

                    // Ensure all writes are complete before unmounting
                    execSync('sync');
                    
                    // Unmount the image
                    execSync(`umount ${mountPoint}`);
                    
                    // Verify the image exists
                    if (!fs.existsSync(imagePath)) {
                        throw new Error('Image file does not exist after build');
                    }

                    // Mount the image again to verify the manifest
                    const verifyMountPoint = `${mountPoint}-verify`;
                    try {
                        execSync(`mkdir -p ${verifyMountPoint}`);
                        execSync(`mount -o loop ${imagePath} ${verifyMountPoint}`);
                        
                        // List contents of verification mount
                        logger.debug(`Contents of verification mount:`, fs.readdirSync(verifyMountPoint));
                        
                        // Check if manifest exists in the mounted image
                        const verifyManifestPath = path.join(verifyMountPoint, 'kiln-manifest');
                        if (!fs.existsSync(verifyManifestPath)) {
                            logger.error(`Manifest not found in verification mount at ${verifyManifestPath}`);
                            logger.debug(`Directory contents:`, fs.readdirSync(verifyMountPoint));
                            throw new Error('Manifest file not found in mounted image');
                        }
                        
                        // Read and verify manifest content
                        const verifyContent = fs.readFileSync(verifyManifestPath, 'utf8');
                        logger.debug(`Verified manifest in mounted image: ${verifyContent}`);
                        
                        // Verify manifest is valid JSON
                        try {
                            JSON.parse(verifyContent);
                            logger.debug('Verified manifest in mounted image is valid JSON');
                        } catch (e) {
                            throw new Error(`Manifest in mounted image is not valid JSON: ${e.message}`);
                        }
                        
                        // Unmount verification mount
                        execSync('sync');
                        execSync(`umount ${verifyMountPoint}`);
                        execSync(`rmdir ${verifyMountPoint}`);
                        
                        // Now register the runtime
                        logger.debug(`Loading package from ${imagePath}`);
                        runtime.load_package(imagePath);
                        
                        return {
                            success: true,
                            imageId,
                            path: imagePath
                        };
                    } catch (error) {
                        logger.error(`Failed to verify manifest: ${error.message}`);
                        throw error;
                    }
                } catch (error) {
                    logger.error(`Error during image build: ${error.message}`);
                    throw error;
                } finally {
                    // Ensure all processes are done with the mount
                    try {
                        execSync('sync');
                        execSync(`umount ${mountPoint} 2>/dev/null || true`);
                    } catch (error) {
                        logger.warn(`Error during cleanup: ${error.message}`);
                    }
                }
            } finally {
                // Clean up mount point
                try {
                    execSync(`rmdir ${mountPoint}`);
                } catch (error) {
                    logger.warn(`Could not remove mount point: ${error.message}`);
                }
            }
        } catch (error) {
            // Cleanup on failure
            logger.error(`Failed to build image: ${error.message}`);
            if (fs.existsSync(imagePath)) {
                try {
                    execSync(`rm -f ${imagePath}`);
                } catch (cleanupError) {
                    logger.error(`Failed to cleanup image file: ${cleanupError.message}`);
                }
            }
            throw error;
        }
    }

    async cleanupMount(mountPath) {
        if (!fs.existsSync(mountPath)) return;

        const maxRetries = 3;
        for (let i = 0; i < maxRetries; i++) {
            try {
                // Check if the path is actually mounted
                const mountInfo = execSync('mount').toString();
                if (!mountInfo.includes(mountPath)) {
                    logger.debug(`${mountPath} is not mounted`);
                    try {
                        execSync(`rmdir ${mountPath}`);
                    } catch (error) {
                        logger.warn(`Could not remove directory ${mountPath}: ${error.message}`);
                    }
                    return;
                }

                // Ensure all processes are done with the mount
                execSync('sync');
                
                // Try to kill any processes using the mount
                try {
                    execSync(`fuser -k ${mountPath} 2>/dev/null || true`);
                    // Wait a bit for processes to die
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (error) {
                    logger.debug(`No processes using ${mountPath}`);
                }
                
                // Try unmounting with increasing force
                try {
                    execSync(`umount ${mountPath}`);
                } catch (error) {
                    try {
                        execSync(`umount -f ${mountPath}`);
                    } catch (error) {
                        execSync(`umount -l ${mountPath}`);
                    }
                }
                
                // Wait before trying to remove the directory
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Try to remove the mount point
                execSync(`rmdir ${mountPath}`);
                logger.debug(`Successfully cleaned up mount point ${mountPath}`);
                return;
            } catch (error) {
                if (i === maxRetries - 1) {
                    logger.warn(`Could not cleanup mount point ${mountPath} after ${maxRetries} attempts: ${error.message}`);
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
        
        logger.debug(`Writing setup script content:`, setupScript);
        
        try {
            // Write the script directly to the root of the mount point
            const scriptPath = path.join(mountPoint, 'setup.sh');
            logger.debug(`Writing script to: ${scriptPath}`);
            
            // Write script with Unix line endings
            fs.writeFileSync(scriptPath, setupScript.replace(/\r\n/g, '\n'), { mode: 0o755, encoding: 'utf8' });
            
            // Double check the script exists
            if (!fs.existsSync(scriptPath)) {
                throw new Error(`Failed to create script at ${scriptPath}`);
            }
            
            // Ensure script has proper permissions
            execSync(`chmod 755 ${scriptPath}`);
            execSync(`chown root:root ${scriptPath}`);
            
            // Verify the script exists and is executable
            try {
                fs.accessSync(scriptPath, fs.constants.X_OK);
                logger.debug('Setup script is executable');
            } catch (error) {
                logger.error(`Setup script is not executable: ${error.message}`);
                throw error;
            }

            // Mount required filesystems for chroot
            try {
                execSync(`mount -t proc proc ${mountPoint}/proc`);
                execSync(`mount -t sysfs sys ${mountPoint}/sys`);
                execSync(`mount -t devpts devpts ${mountPoint}/dev/pts`);
                execSync(`mount -t tmpfs tmpfs ${mountPoint}/dev/shm`);
            } catch (error) {
                logger.warn(`Some filesystem mounts failed, but continuing: ${error.message}`);
            }

            try {
                // Execute setup using chroot
                logger.debug('Executing setup in chroot...');
                const result = execSync(`chroot ${mountPoint} /setup.sh`, {
                    maxBuffer: 10 * 1024 * 1024 // 10MB buffer for output
                });
                logger.debug('Setup execution output:', result.toString());
            } catch (error) {
                logger.error(`Setup execution failed: ${error.message}`);
                if (error.stdout) logger.error('Stdout:', error.stdout.toString());
                if (error.stderr) logger.error('Stderr:', error.stderr.toString());
                throw error;
            } finally {
                // Unmount filesystems in reverse order
                try {
                    execSync(`umount ${mountPoint}/dev/shm`);
                    execSync(`umount ${mountPoint}/dev/pts`);
                    execSync(`umount ${mountPoint}/sys`);
                    execSync(`umount ${mountPoint}/proc`);
                } catch (error) {
                    logger.warn(`Some filesystem unmounts failed: ${error.message}`);
                }
            }
        } finally {
            // Clean up the script
            try {
                const scriptPath = path.join(mountPoint, 'setup.sh');
                if (fs.existsSync(scriptPath)) {
                    fs.unlinkSync(scriptPath);
                    logger.debug('Cleaned up setup script');
                }
            } catch (error) {
                logger.warn(`Failed to remove setup script: ${error.message}`);
            }
        }
    }

    generateSetupScript(language, version) {
        // Start with shebang and basic setup
        const lines = [
            '#!/bin/sh',  // Use sh instead of bash as it's more likely to be available
            'set -ex',
            'export DEBIAN_FRONTEND=noninteractive',
            '',
            '# Setup DNS',
            'echo "nameserver 8.8.8.8" > /etc/resolv.conf',
            'echo "nameserver 8.8.4.4" >> /etc/resolv.conf',
            '',
            '# Create required directories',
            'mkdir -p /var/lib/dpkg',
            'mkdir -p /var/lib/apt/lists/partial',
            'mkdir -p /var/cache/apt/archives/partial',
            'mkdir -p /run',
            '',
            '# Configure Debian repositories',
            'echo "deb http://deb.debian.org/debian bookworm main" > /etc/apt/sources.list',
            'echo "deb http://deb.debian.org/debian-security bookworm-security main" >> /etc/apt/sources.list',
            'echo "deb http://deb.debian.org/debian bookworm-updates main" >> /etc/apt/sources.list',
            '',
            '# Update package lists',
            'apt-get clean',
            'rm -rf /var/lib/apt/lists/*',
            'apt-get update',
            '',
            '# Install essential packages first',
            'apt-get install -y apt-utils',
            'apt-get install -y build-essential wget ca-certificates'
        ];

        // Add language-specific setup
        switch(language) {
            case 'python':
                // Extract major.minor version for binary names
                const majorMinor = version.split('.').slice(0, 2).join('.');
                
                lines.push(
                    '',
                    '# Install Python build dependencies',
                    'apt-get install -y zlib1g-dev libssl-dev libffi-dev libreadline-dev libsqlite3-dev libbz2-dev',
                    '',
                    '# Download and build Python from source',
                    'cd /tmp',
                    `wget https://www.python.org/ftp/python/${version}/Python-${version}.tgz`,
                    `tar xzf Python-${version}.tgz`,
                    `cd Python-${version}`,
                    './configure --enable-optimizations',
                    'make -j$(nproc)',
                    'make install',
                    'cd ..',
                    `rm -rf Python-${version}*`,
                    '',
                    '# Verify Python installation',
                    `if ! command -v python${majorMinor} > /dev/null 2>&1; then`,
                    `    echo "Python ${version} installation failed"`,
                    '    exit 1',
                    'fi',
                    '',
                    '# Install pip',
                    'wget -q https://bootstrap.pypa.io/get-pip.py -O /tmp/get-pip.py',
                    `python${majorMinor} /tmp/get-pip.py`,
                    'rm /tmp/get-pip.py',
                    '',
                    '# Create symlinks',
                    `ln -sf /usr/local/bin/python${majorMinor} /usr/bin/python`,
                    `ln -sf /usr/local/bin/pip${majorMinor} /usr/bin/pip`,
                    '',
                    '# Verify pip installation',
                    'if ! command -v pip > /dev/null 2>&1; then',
                    '    echo "pip installation failed"',
                    '    exit 1',
                    'fi'
                );
                break;
            case 'nodejs':
                lines.push(
                    '',
                    '# Install Node.js',
                    `curl -fsSL https://deb.nodesource.com/setup_${version}.x | bash -`,
                    'apt-get install -y nodejs',
                    '',
                    '# Verify Node.js installation',
                    'if ! command -v node > /dev/null 2>&1; then',
                    '    echo "Node.js installation failed"',
                    '    exit 1',
                    'fi'
                );
                break;
        }

        // Add cleanup steps
        lines.push(
            '',
            '# Cleanup',
            'apt-get clean',
            'rm -rf /var/lib/apt/lists/*',
            'rm -rf /tmp/*',
            '',
            'exit 0'
        );

        // Join lines with Unix line endings
        return lines.map(line => line.trimRight()).join('\n');
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

            logger.debug(`Using image at path: ${imagePath}`);

            // Configure the VM
            const kernelPath = path.join(this.kernelsDir, 'vmlinux');
            const vmConfig = {
                boot_source: {
                    kernel_image_path: kernelPath,
                    boot_args: "console=ttyS0 reboot=k panic=1 pci=off"
                },
                drives: [
                    {
                        drive_id: "rootfs",
                        path_on_host: imagePath,
                        is_root_device: true,
                        is_read_only: false
                    }
                ],
                machine_config: {
                    vcpu_count: 2,
                    mem_size_mib: config.memory_limit || 512,
                    smt: false
                },
                network_interfaces: [
                    {
                        iface_id: "eth0",
                        guest_mac: "AA:FC:00:00:00:01",
                        host_dev_name: "tap0"
                    }
                ]
            };

            // Store VM instance info
            this.vmInstances.set(vmId, {
                process: firecracker,
                socketPath,
                config: vmConfig
            });

            return {
                vmId,
                socketPath,
                config: vmConfig
            };
        } catch (error) {
            logger.error(`Failed to start VM: ${error}`);
            throw error;
        }
    }
}

module.exports = new FirecrackerService();