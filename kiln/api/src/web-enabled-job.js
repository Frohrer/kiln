const { Job } = require("./job");
const fs = require("fs/promises");
const path = require("path");
const { jobTimer } = require("./timing");
const { processHistory } = require("./process-history");
const EventEmitter = require("events");
const StreamlitProcessMonitor = require("./streamlit-process-monitor");
const { processOutputManager } = require("./process-output-manager");
const firecrackerService = require("./firecracker-service");
const { v4: uuidv4 } = require("uuid");
const logger = require("logplease").create("web-enabled-job");

// Import the ProxyManager class (exported as a singleton in your code).
const ProxyManager = require("./proxy-handler");
const proxyManager = new ProxyManager(); // This will return the singleton instance

const runningProcesses = new Map();

class WebEnabledJob extends Job {
    constructor(options) {
        const filteredDeps = options.dependencies ? options.dependencies.filter((dep) => !dep.match(/^streamlit$/i)) : options.dependencies;

        // If it's a Streamlit runtime, ensure .py extension on files
        if (options.runtime.language === "streamlit") {
            options.files = options.files.map((file) => ({
                ...file,
                name: file.name.endsWith(".py") ? file.name : `${file.name}.py`,
            }));
        }

        super({
            runtime: options.runtime,
            files: options.files,
            args: options.args,
            stdin: options.stdin,
            timeouts: options.timeouts,
            cpu_times: options.cpu_times,
            memory_limits: options.memory_limits,
            dependencies: filteredDeps,
        });

        this.webAppPort = null;
        this.proxyPath = null;
        this.additionalEnvVars = {};
        this.processPromise = null;
        this.vmId = null;
        this.proxyManager = options.proxyManager;
        this.long_running = options.long_running || false;

        jobTimer.startTiming(this.uuid);
        runningProcesses.set(this.uuid, this);
    }

    async installDependencies(vmId, event_bus = null) {
        if (!this.dependencies || this.dependencies.length === 0) {
            this.logger.debug("No dependencies to install after filtering");
            return { code: 0, status: "success" };
        }

        // Replace PIL with pillow if present
        if (this.runtime.language === "python" || this.runtime.language === "streamlit") {
            this.dependencies = this.dependencies.map(dep =>
                dep.toLowerCase() === "pil" ? "pillow" : dep
            );
        }

        const packageInstallCommands = {
            python: (dependencies) => `pip install ${dependencies.join(" ")}`,
            streamlit: (dependencies) => `pip install ${dependencies.join(" ")}`,
            javascript: (dependencies) => `npm install ${dependencies.join(" ")}`,
        };

        const installCommand = packageInstallCommands[this.runtime.language];

        if (!installCommand) {
            throw new Error(`Package installation not implemented for language ${this.runtime.language}`);
        }

        const command = installCommand(this.dependencies);
        this.logger.info(`Running install command: ${command}`);

        const result = await firecrackerService.executeInVM(vmId, command);

        if (result.exitCode !== 0) {
            this.logger.error(`Failed to install dependencies:`);
            this.logger.error(`stdout: ${result.stdout}`);
            this.logger.error(`stderr: ${result.stderr}`);
            if (event_bus) {
                event_bus.emit("exit", "install", {
                    error: result.stderr,
                    code: result.exitCode,
                    signal: null,
                });
            }
            return result;
        }

        this.logger.debug("Dependencies installed successfully");
        return { code: 0, status: "success" };
    }

    waitForStreamlitServer(event_bus) {
        let stdout = "";
        let stderr = "";

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.logger.debug("Timeout waiting for Streamlit server");
                this.logger.debug(`Collected stdout: ${stdout}`);
                this.logger.debug(`Collected stderr: ${stderr}`);
                reject(new Error("Timeout waiting for Streamlit server"));
            }, 30000);

            event_bus.on("stdout", (data) => {
                const chunk = data.toString();
                stdout += chunk;
                this.logger.debug(`Received stdout: ${chunk}`);

                if (chunk.includes("You can now view your Streamlit app in your browser") || chunk.includes("Network URL: http") || chunk.includes("Streamlit listening on")) {
                    this.logger.debug("Found Streamlit ready message");
                    clearTimeout(timeout);
                    resolve({ stdout, stderr });
                }
            });

            event_bus.on("stderr", (data) => {
                const chunk = data.toString();
                stderr += chunk;
                this.logger.debug(`Received stderr: ${chunk}`);
            });
        });
    }

    async execute(event_bus = null) {
        try {
            // Start VM using the runtime's VM image
            const vmConfig = {
                cpu_count: 1,
                memory_limit: Math.floor(this.memory_limits.run / (1024 * 1024)) // Convert bytes to MB
            };

            // Get the image path from the runtime
            const imageId = `${this.runtime.language}-${this.runtime.version.raw}`;
            
            // Start the VM
            const { vmId } = await firecrackerService.startVM(imageId, vmConfig);
            this.vmId = vmId;

            // Copy files to VM
            for (const file of this.files) {
                const command = `cat > /app/${file.name} << 'EOF'\n${file.content}\nEOF`;
                await firecrackerService.executeInVM(vmId, command);
            }

            // Execute the code
            const mainFile = this.files[0]?.name;
            if (!mainFile) {
                throw new Error('No file provided for execution');
            }

            const command = `cd /app && python ${mainFile}`;
            const result = await firecrackerService.executeInVM(vmId, command);
            
            return {
                success: true,
                run: {
                    status: result.exitCode,
                    signal: null,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    output: result.stdout + result.stderr
                }
            };
        } catch (error) {
            logger.error(`Error executing job ${this.uuid}:`, error);
            throw error;
        }
    }

    async terminate() {
        if (this.vmId) {
            try {
                await firecrackerService.stopVM(this.vmId);
            } catch (error) {
                this.logger.error(`Error stopping VM ${this.vmId}:`, error);
            }
        }

        if (this.proxyPath) {
            proxyManager.removeProxy(this.uuid);
        }

        runningProcesses.delete(this.uuid);
        jobTimer.cleanup(this.uuid);
    }

    async cleanup() {
        await this.terminate();
        
        // Remove the VM image
        const imageId = `${this.runtime.language}-${this.runtime.version.raw}-${this.uuid}`;
        try {
            await firecrackerService.removeImage(imageId);
        } catch (error) {
            this.logger.error(`Error removing image ${imageId}:`, error);
        }
    }

    async setupStreamlitEnvironment(vmId) {
        // Install Streamlit in VM
        const command = "pip install streamlit";
        const result = await firecrackerService.executeInVM(vmId, command);
        
        if (result.exitCode !== 0) {
            throw new Error(`Failed to install Streamlit: ${result.stderr}`);
        }
    }

    isWebApp() {
        return this.runtime.language === "streamlit";
    }
}

module.exports = {
    WebEnabledJob,
    runningProcesses,
};