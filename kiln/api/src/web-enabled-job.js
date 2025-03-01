const { Job } = require("./job");
const fs = require("fs/promises");
const path = require("path");
const { jobTimer } = require("./timing");
const { processHistory } = require("./process-history");
const EventEmitter = require("events");
const StreamlitProcessMonitor = require("./streamlit-process-monitor");
const { processOutputManager } = require("./process-output-manager");
const firecrackerService = require("./firecracker-service");

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

    async execute(box, event_bus = null) {
        const isStreamlit = this.runtime.language === "streamlit";
        this.logger.debug(`Executing with runtime language: ${this.runtime.language}`);
        jobTimer.startStage(this.uuid, "execute");
        const localEventBus = event_bus || new EventEmitter();

        let stdout = "";
        let stderr = "";
        let stage = "execute";

        try {
            // Build VM image with the code
            const imageId = `${this.runtime.language}-${this.runtime.version.raw}-${this.uuid}`;
            await firecrackerService.buildImage(this.runtime.language, this.runtime.version.raw, this.files);

            // Start VM
            const vmConfig = {
                memory_limit: this.memory_limits.run,
                cpu_count: 1
            };
            const { vmId } = await firecrackerService.startVM(imageId, vmConfig);
            this.vmId = vmId;

            const combinedEnv = {
                ...this.runtime.env_vars,
                ...this.additionalEnvVars,
            };

            if (isStreamlit) {
                // Create a proxy for this job
                const proxyInfo = proxyManager.createProxy(this.uuid);
                this.webAppPort = proxyInfo.port;
                this.proxyPath = proxyManager.getBaseUrl() + proxyInfo.path + "/";

                if (this.dependencies && this.dependencies.length > 0) {
                    stage = "install";
                    this.logger.debug(`Installing additional Python dependencies for Streamlit: ${this.dependencies.join(", ")}`);
                    const installResult = await this.installDependencies(vmId, localEventBus);
                    if (installResult && installResult.code !== 0) {
                        const error = new Error("Failed to install dependencies");
                        error.stage = "install";
                        error.code = installResult.code;
                        error.stdout = installResult.stdout;
                        error.stderr = installResult.stderr;
                        throw error;
                    }
                }

                const mainFile = this.files[0]?.name;
                if (!mainFile) {
                    throw new Error("No file provided for Streamlit execution");
                }

                this.args = [mainFile, "--server.baseUrlPath", proxyInfo.path, "--server.port", this.webAppPort.toString()];

                this.logger.debug(`Created proxy with port ${this.webAppPort} and path ${this.proxyPath}`);
                this.logger.debug(`Streamlit args: ${this.args.join(" ")}`);

                await this.setupStreamlitEnvironment(vmId);

                // Create and set up process monitor
                const monitor = new StreamlitProcessMonitor(this);

                // Set up output collection
                localEventBus.on("stdout", (data) => {
                    stdout += data.toString();
                });

                localEventBus.on("stderr", (data) => {
                    stderr += data.toString();
                });

                try {
                    stage = "execute";
                    this.logger.debug("Starting Streamlit process");
                    
                    // Start the process in VM
                    const command = `cd /app && streamlit run ${this.args.join(" ")}`;
                    const result = await firecrackerService.executeInVM(vmId, command);

                    // Monitor process with enhanced monitoring
                    await monitor.monitorProcess(localEventBus);

                    return {
                        run: {
                            code: result.exitCode,
                            signal: null,
                            stdout: result.stdout,
                            stderr: result.stderr,
                            output: result.stdout + result.stderr,
                            memory: null,
                            message: "Streamlit server started",
                            status: "success",
                            webAppUrl: this.proxyPath,
                            metrics: monitor.getMetrics()
                        },
                        language: this.runtime.language,
                        version: this.runtime.version.raw,
                    };
                } catch (error) {
                    // Clean up proxy if startup failed
                    if (this.proxyPath) {
                        proxyManager.removeProxy(this.uuid);
                    }
                    error.stage = stage;
                    error.stdout = stdout;
                    error.stderr = stderr;
                    throw error;
                }
            }

            // For non-Streamlit jobs
            if (this.dependencies && this.dependencies.length > 0) {
                stage = "install";
                const installResult = await this.installDependencies(vmId, localEventBus);
                if (installResult && installResult.code !== 0) {
                    const error = new Error("Failed to install dependencies");
                    error.stage = "install";
                    error.code = installResult.code;
                    error.stdout = installResult.stdout;
                    error.stderr = installResult.stderr;
                    throw error;
                }
            }

            // Execute the code in VM
            stage = "execute";
            const mainFile = this.files[0]?.name;
            const command = `cd /app && ${this.runtime.command} ${mainFile} ${this.args.join(" ")}`;
            const result = await firecrackerService.executeInVM(vmId, command);

            // Update metrics
            jobTimer.updateMetrics(this.uuid, {
                cpuTime: result.cpuTime,
                wallTime: result.wallTime,
                memory: result.memory,
            });

            // Add to process history
            processHistory.addProcess(this.uuid, {
                language: this.runtime.language,
                version: this.runtime.version.raw,
                startTime: Date.now(),
                status: "completed",
                timing: jobTimer.getTimingReport(this.uuid),
            });

            return {
                run: {
                    code: result.exitCode,
                    signal: null,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    output: result.stdout + result.stderr,
                    memory: result.memory,
                    message: result.exitCode === 0 ? "Success" : "Failed",
                    status: result.exitCode === 0 ? "success" : "error",
                },
                language: this.runtime.language,
                version: this.runtime.version.raw,
            };

        } catch (error) {
            this.logger.error(`Error in ${stage} stage:`, error);
            throw {
                stage,
                error: error.message,
                stdout,
                stderr,
                code: error.code || 1,
            };
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