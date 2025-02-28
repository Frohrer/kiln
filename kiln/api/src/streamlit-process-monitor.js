const EventEmitter = require("events");
const { processOutputManager } = require("./process-output-manager");
const { jobTimer } = require("./timing");

class StreamlitProcessMonitor {
    constructor(job) {
        this.job = job;
        this.errorBuffer = "";
        this.hasStarted = false;
        this.startTime = null;
        this.lastHeartbeat = null;
        this.errorPatterns = [
            /Exception: (.*)/i,
            /Error: (.*)/i,
            /Traceback \(most recent call last\):/,
            /RuntimeError: (.*)/i,
            /ImportError: (.*)/i,
            /ModuleNotFoundError: (.*)/i
        ];
        
        // Track various timing metrics
        this.metrics = {
            startupTime: null,
            lastError: null,
            totalErrors: 0,
            stages: {
                startup: { start: null, end: null },
                running: { start: null, end: null }
            },
            heartbeats: []
        };
    }

    monitorProcess(eventBus) {
        return new Promise((resolve, reject) => {
            this.startTime = Date.now();
            this.metrics.stages.startup.start = this.startTime;
            
            const startupTimeout = setTimeout(() => {
                this.emitTimingData("startup_timeout");
                reject(new Error("Timeout: Streamlit failed to start within 30 seconds"));
            }, 30000);

            // Set up heartbeat monitoring
            const heartbeatInterval = setInterval(() => {
                this.checkHeartbeat();
            }, 5000);

            const handleOutput = (data, type) => {
                const chunk = data.toString();
                this.errorBuffer += chunk;
                
                // Store output in ProcessOutputManager
                processOutputManager.addOutput(this.job.uuid, type, chunk);

                // Check for startup success
                if (!this.hasStarted && this.checkStartupSuccess(chunk)) {
                    this.handleStartupSuccess();
                    clearTimeout(startupTimeout);
                    resolve({ status: "started" });
                }

                // Update heartbeat
                this.updateHeartbeat();

                // Check for errors
                this.checkForErrors(chunk, eventBus);
            };

            eventBus.on("stdout", data => handleOutput(data, "stdout"));
            eventBus.on("stderr", data => handleOutput(data, "stderr"));

            // Handle process exit
            eventBus.on("exit", (stage, info) => {
                clearInterval(heartbeatInterval);
                this.metrics.stages.running.end = Date.now();
                this.emitTimingData("process_exit", info);
                
                if (info.code !== 0) {
                    reject(new Error(`Process exited with code ${info.code}: ${this.errorBuffer}`));
                }
            });
        });
    }

    checkStartupSuccess(chunk) {
        return chunk.includes("You can now view your Streamlit app in your browser") ||
               chunk.includes("Network URL: http") ||
               chunk.includes("Streamlit listening on");
    }

    handleStartupSuccess() {
        this.hasStarted = true;
        this.metrics.stages.startup.end = Date.now();
        this.metrics.stages.running.start = Date.now();
        this.metrics.startupTime = this.metrics.stages.startup.end - this.metrics.stages.startup.start;
        this.emitTimingData("startup_complete");
    }

    checkForErrors(chunk, eventBus) {
        for (const pattern of this.errorPatterns) {
            if (pattern.test(this.errorBuffer)) {
                const error = this.parseError(this.errorBuffer);
                this.metrics.totalErrors++;
                this.metrics.lastError = {
                    timestamp: Date.now(),
                    message: error
                };

                // Emit error event
                eventBus.emit("streamlit-error", {
                    type: "error",
                    message: error,
                    timestamp: new Date().toISOString(),
                    metrics: this.getMetrics()
                });

                // Clear the error buffer after emitting
                this.errorBuffer = "";
            }
        }
    }

    updateHeartbeat() {
        const now = Date.now();
        this.lastHeartbeat = now;
        this.metrics.heartbeats.push(now);
        
        // Keep only last 10 heartbeats
        if (this.metrics.heartbeats.length > 10) {
            this.metrics.heartbeats.shift();
        }
    }

    checkHeartbeat() {
        if (!this.lastHeartbeat) return;
        
        const now = Date.now();
        const timeSinceLastHeartbeat = now - this.lastHeartbeat;
        
        if (timeSinceLastHeartbeat > 15000) { // 15 seconds threshold
            this.emitTimingData("heartbeat_warning", {
                timeSinceLastHeartbeat
            });
        }
    }

    emitTimingData(event, data = {}) {
        const metrics = this.getMetrics();
        processOutputManager.addOutput(this.job.uuid, "timing", JSON.stringify({
            event,
            timestamp: Date.now(),
            metrics,
            ...data
        }));
    }

    getMetrics() {
        return {
            ...this.metrics,
            uptime: this.hasStarted ? Date.now() - this.startTime : null,
            isRunning: this.hasStarted && !this.metrics.stages.running.end
        };
    }

    parseError(buffer) {
        const lines = buffer.split("\n");
        let errorMessage = "";
        let inTraceback = false;

        for (const line of lines) {
            if (line.includes("Traceback (most recent call last)")) {
                inTraceback = true;
                errorMessage = "Python Error: ";
                continue;
            }
            if (inTraceback) {
                if (line.match(/^\s*File/)) continue;
                if (line.trim().length > 0) {
                    errorMessage += line.trim() + " ";
                }
            }
        }

        return errorMessage.trim() || buffer;
    }
}

module.exports = StreamlitProcessMonitor; 