const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('logplease').create('firecracker-service');
const runtime = require('./runtime');

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
            // Copy base rootfs to new image
            execSync(`cp ${baseRootfsPath} ${imagePath}`);
            
            // Mount the image
            const mountPoint = `/tmp/mount-${imageId}`;
            fs.mkdirSync(mountPoint, { recursive: true });
            execSync(`mount -o loop ${imagePath} ${mountPoint}`);

            try {
                // Create necessary directories
                execSync(`mkdir -p ${mountPoint}/app`);

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
                // Always try to unmount
                try {
                    execSync(`umount ${mountPoint}`);
                    fs.rmdirSync(mountPoint);
                } catch (error) {
                    logger.error(`Failed to unmount image: ${error}`);
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

            # Update package lists
            apt-get clean
            rm -rf /var/lib/apt/lists/*
            apt-get update

            # Install essential packages
            DEBIAN_FRONTEND=noninteractive apt-get install -y software-properties-common gnupg wget
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
            // Add more languages as needed
        }

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
            // Start Firecracker process
            const firecracker = spawn('firecracker', ['--api-sock', socketPath]);
            
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
                    host_dev_name: 'tap0', // This needs to be configured on the host
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
        // Helper function to make API calls to Firecracker
        const makeRequest = async (method, path, body) => {
            const response = await fetch(`http://localhost/${path}`, {
                method,
                body: body ? JSON.stringify(body) : undefined,
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) {
                throw new Error(`Firecracker API request failed: ${response.statusText}`);
            }
            
            return response;
        };

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
    }

    async stopVM(vmId) {
        const instance = this.vmInstances.get(vmId);
        if (!instance) {
            return false;
        }

        try {
            // Send shutdown signal via API
            await fetch(`http://localhost/${instance.socket}/actions`, {
                method: 'PUT',
                body: JSON.stringify({ action_type: 'SendCtrlAltDel' }),
                headers: {
                    'Content-Type': 'application/json'
                }
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