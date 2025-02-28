const logplease = require("logplease");
const cp = require("child_process");
const fs = require("fs/promises");
const path = require("path");

class SandboxPool {
    constructor(maxPoolSize = 10) {
        this.logger = logplease.create("sandbox-pool");
        this.maxPoolSize = maxPoolSize;
        this.warmBoxes = new Map(); // box_id -> {box, lastUsed, state, packages}
        this.boxIdCounter = 0;
        
        // Create package cache directories
        this.setupPackageCaches();
    }

    async setupPackageCaches() {
        try {
            // Create base cache directory
            await fs.mkdir('/var/local/lib/isolate/package-cache', { recursive: true });
            
            // Create language-specific cache directories
            const languages = ['python', 'node', 'go']; // Add other languages as needed
            for (const lang of languages) {
                await fs.mkdir(`/var/local/lib/isolate/package-cache/${lang}`, { recursive: true });
            }
            
            // Set permissions
            await cp.exec('chmod -R 755 /var/local/lib/isolate/package-cache');
        } catch (error) {
            this.logger.error(`Failed to setup package caches: ${error.message}`);
        }
    }

    getNextBoxId() {
        return ++this.boxIdCounter % 999; // MAX_BOX_ID from job.js
    }

    async initializeBox() {
        const box_id = this.getNextBoxId();
        const metadata_file_path = `/tmp/${box_id}-metadata.txt`;
        
        return new Promise((resolve, reject) => {
            cp.exec(`isolate --init --cg --box-id=${box_id}`, (error, stdout, stderr) => {
                if (error) {
                    reject(`Failed to run isolate --init: ${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`);
                    return;
                }
                if (!stdout) {
                    reject("Received empty stdout from isolate --init");
                    return;
                }
                
                const box = {
                    id: box_id,
                    metadata_file_path,
                    dir: `${stdout.trim()}/box`,
                    packages: new Set(), // Track installed packages
                };
                resolve(box);
            });
        });
    }

    async acquireBox() {
        // First try to find an available warm box
        for (const [boxId, boxInfo] of this.warmBoxes.entries()) {
            if (boxInfo.state === 'available') {
                boxInfo.state = 'in-use';
                boxInfo.lastUsed = Date.now();
                return boxInfo.box;
            }
        }

        // If no warm boxes available, create a new one if pool not full
        if (this.warmBoxes.size < this.maxPoolSize) {
            const box = await this.initializeBox();
            this.warmBoxes.set(box.id, {
                box,
                lastUsed: Date.now(),
                state: 'in-use',
                packages: new Set()
            });
            return box;
        }

        // If pool is full, reuse the oldest box
        let oldestBoxId = null;
        let oldestTime = Infinity;
        
        for (const [boxId, boxInfo] of this.warmBoxes.entries()) {
            if (boxInfo.lastUsed < oldestTime && boxInfo.state === 'available') {
                oldestTime = boxInfo.lastUsed;
                oldestBoxId = boxId;
            }
        }

        if (oldestBoxId) {
            const boxInfo = this.warmBoxes.get(oldestBoxId);
            boxInfo.state = 'in-use';
            boxInfo.lastUsed = Date.now();
            return boxInfo.box;
        }

        // If all boxes are in use, wait for one to become available
        return new Promise((resolve) => {
            const checkInterval = setInterval(async () => {
                for (const [boxId, boxInfo] of this.warmBoxes.entries()) {
                    if (boxInfo.state === 'available') {
                        clearInterval(checkInterval);
                        boxInfo.state = 'in-use';
                        boxInfo.lastUsed = Date.now();
                        resolve(boxInfo.box);
                        return;
                    }
                }
            }, 100);
        });
    }

    async releaseBox(box) {
        const boxInfo = this.warmBoxes.get(box.id);
        if (!boxInfo) {
            this.logger.warn(`Attempted to release unknown box ${box.id}`);
            return;
        }

        // Clean the box contents but preserve package cache
        try {
            const boxDir = path.join(box.dir);
            const files = await fs.readdir(boxDir);
            
            for (const file of files) {
                if (file !== 'packages') { // Don't delete the package cache
                    await fs.rm(path.join(boxDir, file), { recursive: true, force: true });
                }
            }
            
            boxInfo.state = 'available';
            boxInfo.lastUsed = Date.now();
        } catch (error) {
            this.logger.error(`Failed to clean box ${box.id}: ${error.message}`);
            // If cleaning fails, destroy and recreate the box
            await this.destroyBox(box);
            const newBox = await this.initializeBox();
            this.warmBoxes.set(newBox.id, {
                box: newBox,
                lastUsed: Date.now(),
                state: 'available',
                packages: new Set()
            });
        }
    }

    async destroyBox(box) {
        return new Promise((resolve) => {
            cp.exec(`isolate --cleanup --cg --box-id=${box.id}`, (error) => {
                if (error) {
                    this.logger.error(`Failed to cleanup box ${box.id}: ${error.message}`);
                }
                this.warmBoxes.delete(box.id);
                resolve();
            });
        });
    }

    async cleanup() {
        const promises = [];
        for (const [boxId, boxInfo] of this.warmBoxes.entries()) {
            promises.push(this.destroyBox(boxInfo.box));
        }
        await Promise.all(promises);
        this.warmBoxes.clear();
    }

    // Get the package cache directory for a specific language
    getPackageCacheDir(language) {
        return `/var/local/lib/isolate/package-cache/${language}`;
    }
}

// Create singleton instance
const sandboxPool = new SandboxPool();

module.exports = { sandboxPool }; 