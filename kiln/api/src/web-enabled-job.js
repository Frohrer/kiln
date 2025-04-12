const { Job } = require("./job");
const fs = require("fs/promises");
const path = require("path");
const { jobTimer } = require("./timing");
const { processHistory } = require("./process-history");
const EventEmitter = require("events");
const StreamlitErrorMonitor = require("./streamlit-error-monitor");
const { processOutputManager } = require("./process-output-manager");

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

        jobTimer.startTiming(this.uuid);

        runningProcesses.set(this.uuid, this);
    }

    async installDependencies(box, event_bus = null) {
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
            python: (dependencies) => ["--disable-pip-version-check", "install", "--target=/box/submission", ...dependencies],
            streamlit: (dependencies) => ["--disable-pip-version-check", "install", "--target=/box/submission", ...dependencies],
            javascript: (dependencies) => ["install", "--prefix", "/box/submission", ...dependencies],
        };

        const installCommandArgs = packageInstallCommands[this.runtime.language];

        if (!installCommandArgs) {
            throw new Error(`Package installation not implemented for language ${this.runtime.language}`);
        }

        const args = installCommandArgs(this.dependencies);

        this.logger.info(`Running install command for ${this.runtime.language} (using ${this.runtime.language} package manager): packagemanager ${args.join(" ")}`);

        const installResult = await this.safe_call(box, "packagemanager", args, this.timeouts.run, this.cpu_times.run, this.memory_limits.run, event_bus);

        if (installResult.code !== 0) {
            this.logger.error(`Failed to install dependencies:`);
            this.logger.error(`stdout: ${installResult.stdout}`);
            this.logger.error(`stderr: ${installResult.stderr}`);
            this.logger.error(`message: ${installResult.message}`);
            if (event_bus) {
                event_bus.emit("exit", "install", {
                    error: installResult.error,
                    code: installResult.code,
                    signal: installResult.signal,
                });
            }
            return installResult;
        }

        this.logger.debug("Dependencies installed successfully");
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
                    const installResult = await this.installDependencies(box, localEventBus);
                    if (installResult && installResult.code !== 0) {
                        this.logger.warn(`Dependency installation failed, but continuing execution. Errors: ${installResult.stderr}`);
                    }
                }
                // Get the main file from the files array
                const mainFile = this.files[0]?.name;
                if (!mainFile) {
                    throw new Error("No file provided for Streamlit execution");
                }

                // Place the file first, then the Streamlit args
                this.args = [mainFile, "--server.baseUrlPath", proxyInfo.path, "--server.port", this.webAppPort.toString()];

                this.logger.debug(`Created proxy with port ${this.webAppPort} and path ${this.proxyPath}`);
                this.logger.debug(`Streamlit args: ${this.args.join(" ")}`);

                await this.setupStreamlitEnvironment(box);

                // Create error monitor
                const monitor = new StreamlitErrorMonitor(this);

                // Set up error collection
                localEventBus.on("stdout", (data) => {
                    stdout += data.toString();
                });

                localEventBus.on("stderr", (data) => {
                    stderr += data.toString();
                });

                // Forward Streamlit errors to ProcessOutputManager
                localEventBus.on("streamlit-error", (error) => {
                    processOutputManager.addOutput(this.uuid, "error", JSON.stringify(error));
                    this.logger.error(`Streamlit error: ${error.message}`);
                });

                try {
                    stage = "execute";
                    this.logger.debug("Starting Streamlit process");
                    
                    // Start the process
                    this.processPromise = this.safe_call(
                        box,
                        "run",
                        this.args,
                        22200000,
                        21600000,
                        this.memory_limits.run,
                        localEventBus, { env: combinedEnv }
                    );

                    // Monitor for startup and errors
                    await monitor.monitorStreamlitOutput(localEventBus);

                    return {
                        run: {
                            code: 0,
                            signal: null,
                            stdout,
                            stderr,
                            output: stdout + stderr,
                            memory: null,
                            message: "Streamlit server started",
                            status: "success",
                            webAppUrl: this.proxyPath,
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

            // For non-Streamlit jobs, run the parent execute method
            const result = await super.execute(box, localEventBus);

            // Update metrics for all jobs
            if (result.run) {
                jobTimer.updateMetrics(this.uuid, {
                    cpuTime: result.run.cpu_time,
                    wallTime: result.run.wall_time,
                    memory: result.run.memory,
                });
            }

            // Add to process history
            processHistory.addProcess(this.uuid, {
                language: this.runtime.language,
                version: this.runtime.version.raw,
                startTime: new Date(this.startTime),
                status: result.run?.code === 0 ? "completed" : "failed",
                timing: jobTimer.getTimingReport(this.uuid),
                result: result,
            });

            return result;
        } catch (error) {
            // Enhance error with additional context
            error.stage = stage;
            error.stdout = stdout;
            error.stderr = stderr;
            error.language = this.runtime.language;
            error.version = this.runtime.version.raw;
            
            // Record failed process with detailed error information
            processHistory.addProcess(this.uuid, {
                language: this.runtime.language,
                version: this.runtime.version.raw,
                startTime: new Date(this.startTime),
                status: "failed",
                timing: jobTimer.getTimingReport(this.uuid),
                error: {
                    message: error.message,
                    stage: error.stage,
                    stdout: error.stdout,
                    stderr: error.stderr
                }
            });

            throw error;
        } finally {
            jobTimer.endStage(this.uuid);
        }
    }

    async terminate() {
        this.logger.info("Terminating job");

        // First kill any running process
        if (this.process) {
            try {
                process.kill(this.process.pid, "SIGKILL");
                // Wait for process to actually terminate
                await new Promise((resolve) => setTimeout(resolve, 1000));
            } catch (error) {
                this.logger.error(`Error killing process: ${error.message}`);
            }
        }

        // Remove proxy before cleanup
        if (this.proxyPath) {
            this.logger.debug(`Cleaning up proxy for port ${this.webAppPort}`);
            proxyManager.removeProxy(this.uuid);
        }

        // Wait for any ongoing isolate operations
        await new Promise((resolve) => setTimeout(resolve, 2000));

        try {
            await super.cleanup();
        } catch (error) {
            this.logger.error(`Error in cleanup: ${error.message}`);
            // Force cleanup for each box
            const boxIds = this.getBoxIds();
            for (const boxId of boxIds) {
                await this.forceCleanupBox(boxId);
            }
        }

        // End timing and get final report
        const timingReport = jobTimer.endTiming(this.uuid);
        this.logger.debug("Job timing report:", timingReport);

        // Save to history before removing from running processes
        processHistory.addProcess(this.uuid, {
            language: this.runtime.language,
            version: this.runtime.version.raw,
            startTime: new Date(this.startTime),
            status: "terminated",
            timing: timingReport,
        });

        runningProcesses.delete(this.uuid);
    }

    async cleanup() {
        // If the runtime is not streamlit or there's no running process, remove the proxy if it exists
        if (this.runtime.language !== "streamlit" || !this.processPromise) {
            if (this.webAppPort) {
                this.logger.debug(`Cleaning up proxy for port ${this.webAppPort}`);
                proxyManager.removeProxy(this.uuid);
            }
            await super.cleanup();
        }
    }

    async setupStreamlitEnvironment(box) {
        const homeDir = path.join(box.dir, "submission", "home");
        await fs.mkdir(homeDir, { recursive: true });

        this.additionalEnvVars = {
            HOME: "/box/submission/home",
            PORT: this.webAppPort.toString(),
        };
    }

    isWebApp() {
        const webFrameworks = ["flask", "dash", "gradio"];
        return this.files.some((file) => webFrameworks.some((framework) => file.content.includes(`import ${framework}`) || file.content.includes(`from ${framework}`)));
    }
}

module.exports = { WebEnabledJob, runningProcesses };