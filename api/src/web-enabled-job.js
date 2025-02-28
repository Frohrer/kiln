const { Job } = require("./job");
const fs = require("fs/promises");
const path = require("path");
const { jobTimer } = require("./timing");
const { processHistory } = require("./process-history");
const EventEmitter = require("events");
const StreamlitProcessMonitor = require("./streamlit-process-monitor");
const { processOutputManager } = require("./process-output-manager");
const { sandboxPool } = require("./sandbox-pool");

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
            long_running: options.long_running,
        });

        this.webAppPort = null;
        this.proxyPath = null;
        this.additionalEnvVars = {};
        this.processPromise = null;

        jobTimer.startTiming(this.uuid);

        runningProcesses.set(this.uuid, this);
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
            // For long-running jobs, we want to destroy the box rather than just release it
            if (this.long_running && this.activeBox) {
                await sandboxPool.destroyBox(this.activeBox);
                this.activeBox = null;
            } else {
                await super.cleanup();
            }
        } catch (error) {
            this.logger.error(`Error in cleanup: ${error.message}`);
            // Force cleanup for each box
            if (this.activeBox) {
                await this.forceCleanupBox(this.activeBox.id);
                this.activeBox = null;
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
        // For non-streamlit jobs or jobs without running processes, clean up normally
        if (this.runtime.language !== "streamlit" || !this.processPromise) {
            if (this.webAppPort) {
                this.logger.debug(`Cleaning up proxy for port ${this.webAppPort}`);
                proxyManager.removeProxy(this.uuid);
            }
            await super.cleanup();
        }
    }
}

module.exports = { WebEnabledJob, runningProcesses }; 