const express = require("express");
const router = express.Router();
const events = require("events");
const { WebEnabledJob, runningProcesses } = require("../web-enabled-job");
const { ProxyManager } = require("../proxy-handler");
const runtime = require("../runtime");
const package = require("../package");
const globals = require("../globals");
const logger = require("logplease").create("api/v2");
const { jobTimer } = require("../timing");
const { processHistory } = require("../process-history");
const { pipIgnore } = require("../pip_ignore");
const { setupMonitoringRoutes, trackExecution } = require("../monitoring");
const { processOutputManager } = require("../process-output-manager");

function getDependencies(code, language) {
    let dependencies = [];
    if (language.startsWith("python")) {
        // Regular expressions to match 'import module' and 'from module import ...'
        const importRegex = /^\s*import\s+([a-zA-Z_][\w]*)/gm;
        const fromImportRegex = /^\s*from\s+([a-zA-Z_][\w]*)/gm;
        let match;
        while ((match = importRegex.exec(code)) !== null) {
            dependencies.push(match[1]);
        }
        while ((match = fromImportRegex.exec(code)) !== null) {
            dependencies.push(match[1]);
        }
        // Filter out built-in deps
        dependencies = dependencies.filter((dep) => !pipIgnore.includes(dep));
        logger.debug(dependencies);
        // Remove duplicates
        dependencies = [...new Set(dependencies)];
    } else if (language === "streamlit") {
        return getDependencies(code, "python");
    } else if (language === "javascript" || language === "nodejs") {
        // For Node.js, match 'require("module")' or 'import ... from "module"'
        const requireRegex = /require\(['"]([^'"]+)['"]\)/gm;
        const importFromRegex = /import\s+.*\s+from\s+['"]([^'"]+)['"]/gm;
        const importRegex = /import\s+['"]([^'"]+)['"]/gm; // For 'import "module"'
        let match;
        while ((match = requireRegex.exec(code)) !== null) {
            dependencies.push(match[1]);
        }
        while ((match = importFromRegex.exec(code)) !== null) {
            dependencies.push(match[1]);
        }
        while ((match = importRegex.exec(code)) !== null) {
            dependencies.push(match[1]);
        }
        // Remove duplicates
        dependencies = [...new Set(dependencies)];
    }
    return dependencies;
}

function get_job(body) {
    let { language, version, dependencies, args, stdin, files, compile_memory_limit, run_memory_limit, run_timeout, compile_timeout, run_cpu_time, compile_cpu_time } = body;

    return new Promise((resolve, reject) => {
        if (!language || typeof language !== "string") {
            return reject({
                message: "language is required as a string",
            });
        }
        if (!version || typeof version !== "string") {
            return reject({
                message: "version is required as a string",
            });
        }
        if (!files || !Array.isArray(files)) {
            return reject({
                message: "files is required as an array",
            });
        }
        for (const [i, file] of files.entries()) {
            if (typeof file.content !== "string") {
                return reject({
                    message: `files[${i}].content is required as a string`,
                });
            }
        }

        const rt = runtime.get_latest_runtime_matching_language_version(language, version);
        if (rt === undefined) {
            return reject({
                message: `${language}-${version} runtime is unknown`,
            });
        }

        if (rt.language !== "file" && !files.some((file) => !file.encoding || file.encoding === "utf8")) {
            return reject({
                message: "files must include at least one utf8 encoded file",
            });
        }

        for (const constraint of["memory_limit", "timeout", "cpu_time"]) {
            for (const type of["compile", "run"]) {
                const constraint_name = `${type}_${constraint}`;
                const constraint_value = body[constraint_name];
                const configured_limit = rt[`${constraint}s`][type];
                if (!constraint_value) {
                    continue;
                }
                if (typeof constraint_value !== "number") {
                    return reject({
                        message: `If specified, ${constraint_name} must be a number`,
                    });
                }
                if (configured_limit <= 0) {
                    continue;
                }
                if (constraint_value > configured_limit) {
                    return reject({
                        message: `${constraint_name} cannot exceed the configured limit of ${configured_limit}`,
                    });
                }
                if (constraint_value < 0) {
                    return reject({
                        message: `${constraint_name} must be non-negative`,
                    });
                }
            }
        }

        resolve(
            new WebEnabledJob({
                runtime: rt,
                args: args ?? [],
                stdin: stdin ?? "",
                dependencies: dependencies,
                files,
                timeouts: {
                    run: run_timeout ?? rt.timeouts.run,
                    compile: compile_timeout ?? rt.timeouts.compile,
                },
                cpu_times: {
                    run: run_cpu_time ?? rt.cpu_times.run,
                    compile: compile_cpu_time ?? rt.cpu_times.compile,
                },
                memory_limits: {
                    run: run_memory_limit ?? rt.memory_limits.run,
                    compile: compile_memory_limit ?? rt.memory_limits.compile,
                },
                proxyManager: ProxyManager,
                long_running: body.long_running === true,
            })
        );
    });
}

router.use((req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        return next();
    }

    if (!req.headers["content-type"]?.startsWith("application/json")) {
        return res.status(415).send({
            message: "requests must be of type application/json",
        });
    }

    next();
});

router.ws("/connect", async(ws, req) => {
    let job = null;
    let event_bus = new events.EventEmitter();
    let installOutput = { stdout: "", stderr: "" };
    let executeOutput = { stdout: "", stderr: "" };
    let currentStage = null;

    event_bus.on("stdout", (data) => {
        const output = data.toString();
        if (currentStage === "install") {
            installOutput.stdout += output;
        } else {
            executeOutput.stdout += output;
        }

        // Store output in ProcessOutputManager if job exists
        if (job) {
            processOutputManager.addOutput(job.uuid, "stdout", output);
        }

        ws.send(
            JSON.stringify({
                type: "data",
                stream: "stdout",
                stage: currentStage,
                data: output,
            })
        );
    });

    event_bus.on("stderr", (data) => {
        const output = data.toString();
        if (currentStage === "install") {
            installOutput.stderr += output;
        } else {
            executeOutput.stderr += output;
        }

        // Store output in ProcessOutputManager if job exists
        if (job) {
            processOutputManager.addOutput(job.uuid, "stderr", output);
        }

        ws.send(
            JSON.stringify({
                type: "data",
                stream: "stderr",
                stage: currentStage,
                data: output,
            })
        );
    });

    event_bus.on("stage", (stage) => {
        currentStage = stage;
        ws.send(JSON.stringify({ type: "stage", stage }));
    });

    event_bus.on("dependency-install", (result) => {
        ws.send(
            JSON.stringify({
                type: "dependency-install",
                ...result,
            })
        );
    });

    event_bus.on("webAppReady", (url) =>
        ws.send(
            JSON.stringify({
                type: "webApp",
                url: url,
            })
        )
    );

    event_bus.on("exit", (stage, status) => ws.send(JSON.stringify({ type: "exit", stage, ...status })));

    ws.on("close", () => {
        if (job) {
            // Don't clear process output immediately as other clients might be listening
            // processOutputManager.clearProcess(job.uuid);
        }
    });

    ws.on("message", async(data) => {
        try {
            const msg = JSON.parse(data);

            switch (msg.type) {
                case "init":
                    if (job === null) {
                        job = await get_job(msg);
                        try {
                            const box = await job.prime();
                            ws.send(
                                JSON.stringify({
                                    type: "runtime",
                                    language: job.runtime.language,
                                    version: job.runtime.version.raw,
                                })
                            );

                            event_bus.emit("stage", "install");
                            const result = await job.execute(box, event_bus);

                            if (result.webAppUrl) {
                                event_bus.emit("webAppReady", result.webAppUrl);
                            }
                        } catch (error) {
                            logger.error(`Error in job: ${job.uuid}:\n${error}`);
                            throw error;
                        } finally {
                            await job.cleanup();
                        }
                        ws.close(4999, "Job Completed");
                    } else {
                        ws.close(4000, "Already Initialized");
                    }
                    break;
                case "data":
                    if (job !== null) {
                        if (msg.stream === "stdin") {
                            event_bus.emit("stdin", msg.data);
                        } else {
                            ws.close(4004, "Can only write to stdin");
                        }
                    } else {
                        ws.close(4003, "Not yet initialized");
                    }
                    break;
                case "signal":
                    if (job !== null) {
                        if (Object.values(globals.SIGNALS).includes(msg.signal)) {
                            event_bus.emit("signal", msg.signal);
                        } else {
                            ws.close(4005, "Invalid signal");
                        }
                    } else {
                        ws.close(4003, "Not yet initialized");
                    }
                    break;
            }
        } catch (error) {
            ws.send(JSON.stringify({ type: "error", message: error.message }));
            ws.close(4002, "Notified Error");
            // ws.close message is limited to 123 characters, so we notify over WS then close.
        }
    });

    setTimeout(() => {
        //Terminate the socket after 1 second, if not initialized.
        if (job === null) ws.close(4001, "Initialization Timeout");
    }, 1000);
});

router.post("/execute", async(req, res) => {
    logger.debug(req.body);
    let job;

    try {
        // Handle dependencies
        if (req.body.dependencies) {
            if (typeof req.body.dependencies === "string") {
                req.body.dependencies = [req.body.dependencies];
            } else if (!Array.isArray(req.body.dependencies)) {
                req.body.dependencies = [];
            }
        } else {
            req.body.dependencies = [];
            if (Array.isArray(req.body.files)) {
                for (let file of req.body.files) {
                    if (file && file.content) {
                        const deps = getDependencies(file.content, req.body.language);
                        req.body.dependencies = req.body.dependencies.concat(deps);
                    }
                }

                req.body.dependencies = [...new Set(req.body.dependencies)];
            }
        }

        job = await get_job(req.body);
        jobTimer.startTiming(job.uuid);
    } catch (error) {
        logger.error(error);
        return res.status(400).json({
            message: "Failed to create job",
            error: error.message,
            details: error.details || null,
        });
    }

    try {
        const box = await job.prime();
        const event_bus = new events.EventEmitter();
        const outputs = {
            install: { stdout: "", stderr: "" },
            execute: { stdout: "", stderr: "" },
        };
        let currentStage = "execute"; // Default stage

        event_bus.on("stdout", (data) => {
            const stage = currentStage in outputs ? currentStage : "execute";
            outputs[stage].stdout += data.toString();
        });

        event_bus.on("stderr", (data) => {
            const stage = currentStage in outputs ? currentStage : "execute";
            outputs[stage].stderr += data.toString();
        });

        event_bus.on("stage", (stage) => {
            if (stage in outputs) {
                currentStage = stage;
            }
        });

        let result = await job.execute(box, event_bus);
        const timingReport = jobTimer.endTiming(job.uuid);

        // Ensure run object has the output
        if (result.run) {
            result.run.stdout = outputs.execute.stdout;
            result.run.stderr = outputs.execute.stderr;
            result.run.output = outputs.execute.stdout + outputs.execute.stderr;
        }

        result = {
            ...result,
            execution_id: job.uuid,
            stages: {
                install: {
                    stdout: outputs.install.stdout,
                    stderr: outputs.install.stderr,
                },
                execute: {
                    stdout: outputs.execute.stdout,
                    stderr: outputs.execute.stderr,
                },
            },
            timing: timingReport,
        };

        if (job.proxyPath) {
            result.webAppUrl = job.proxyPath;
        }
        trackExecution(job, result);
        return res.status(200).send(result);
    } catch (error) {
        logger.error(`Error executing job ${job.uuid}:`, error);

        // Create detailed error response
        const errorResponse = {
            message: "Job execution failed",
            error: error.message,
            execution_id: job.uuid,
            stages: {
                install: error.installOutput || null,
                execute: error.executeOutput || null,
            },
            details: {
                stage: error.stage || "unknown",
                code: error.code,
                signal: error.signal,
                stdout: error.stdout,
                stderr: error.stderr,
            },
        };

        // Track failed execution
        trackExecution(job, {...errorResponse, status: "failed" });

        return res.status(500).json(errorResponse);
    } finally {
        if (!job.long_running) {
            try {
                await job.cleanup();
                jobTimer.cleanup(job.uuid);
            } catch (error) {
                logger.error(`Error cleaning up job ${job.uuid}:`, error);
            }
        }
    }
});

router.get("/logs/:id", (req, res) => {
    const processId = req.params.id;

    // Set headers for SSE
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });

    // Function to send SSE data
    const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Subscribe to process output
    const unsubscribe = processOutputManager.subscribeToProcess(processId, sendEvent);

    // Handle client disconnect
    req.on("close", () => {
        unsubscribe();
    });
});

router.get("/process/:id/logs", (req, res) => {
    const processId = req.params.id;
    const output = processOutputManager.getProcessOutput(processId);

    if (!output) {
        return res.status(404).json({
            message: `Process ${processId} not found or has no output`,
        });
    }

    res.status(200).json(output);
});

router.get("/process", (req, res) => {
    logger.debug("Request to list all processes");

    try {
        // Get running processes
        const running = Array.from(runningProcesses.entries()).map(([id, job]) => ({
            id: id,
            language: job.runtime.language,
            version: job.runtime.version.raw,
            webAppUrl: job.proxyPath || null,
            startTime: job.startTime,
            status: "running",
            timing: jobTimer.getTimingReport(id),
        }));

        // Get completed processes from history
        const completed = processHistory.getHistory();

        return res.status(200).json({
            count: running.length + completed.length,
            processes: [...running, ...completed],
        });
    } catch (error) {
        logger.error("Error retrieving process list:", error);
        return res.status(500).json({
            message: "Failed to retrieve process list",
            error: error.message,
        });
    }
});

router.get("/process/:id", (req, res) => {
    const processId = req.params.id;

    // Check running processes first
    const runningProcess = runningProcesses.get(processId);
    if (runningProcess) {
        return res.status(200).json({
            id: processId,
            language: runningProcess.runtime.language,
            version: runningProcess.runtime.version.raw,
            webAppUrl: runningProcess.proxyPath || null,
            startTime: runningProcess.startTime,
            status: "running",
            timing: jobTimer.getTimingReport(processId),
        });
    }

    // Check history if not running
    const historicalProcess = processHistory.getProcess(processId);
    if (historicalProcess) {
        return res.status(200).json({
            id: processId,
            ...historicalProcess,
        });
    }

    return res.status(404).json({
        message: `Process ${processId} not found`,
    });
});

router.delete("/process/:id", async(req, res) => {
    const processId = req.params.id;
    logger.debug(`Request to terminate process ${processId}`);

    const job = runningProcesses.get(processId);
    if (!job) {
        return res.status(404).json({
            message: `Process ${processId} not found or already terminated`,
        });
    }

    try {
        await job.terminate();
        return res.status(200).json({
            message: `Process ${processId} terminated successfully`,
        });
    } catch (error) {
        logger.error(`Error terminating process ${processId}:`, error);
        return res.status(500).json({
            message: `Failed to terminate process ${processId}`,
            error: error.message,
        });
    }
});

router.get("/runtimes", (req, res) => {
    const runtimes = runtime.map((rt) => {
        return {
            language: rt.language,
            version: rt.version.raw,
            aliases: rt.aliases,
            runtime: rt.runtime,
        };
    });

    return res.status(200).send(runtimes);
});

router.get("/packages", async(req, res) => {
    logger.debug("Request to list packages");
    let packages = await package.get_package_list();

    packages = packages.map((pkg) => {
        return {
            language: pkg.language,
            language_version: pkg.version.raw,
            installed: pkg.installed,
        };
    });

    return res.status(200).send(packages);
});

router.post("/packages", async(req, res) => {
    logger.debug("Request to install package");

    let { language, version } = req.body;

    const pkg = await package.get_package(language, version);

    if (pkg == null) {
        return res.status(404).send({
            message: `Requested package ${language}-${version} does not exist`,
        });
    }

    try {
        const response = await pkg.install();

        return res.status(200).send(response);
    } catch (e) {
        logger.error(`Error while installing package ${pkg.language}-${pkg.version.raw}:`, e.message);

        if (e.message && e.message === "Already installed") {
            return res.status(409).send({
                message: e.message,
            });
        }

        return res.status(500).send({
            message: e.message,
        });
    }
});

router.delete("/packages", async(req, res) => {
    logger.debug("Request to uninstall package");

    const { language, version } = req.body;

    const pkg = await package.get_package(language, version);

    if (pkg == null) {
        return res.status(404).send({
            message: `Requested package ${language}-${version} does not exist`,
        });
    }

    try {
        const response = await pkg.uninstall();

        return res.status(200).send(response);
    } catch (e) {
        logger.error(`Error while uninstalling package ${pkg.language}-${pkg.version}:`, e.message);

        return res.status(500).send({
            message: e.message,
        });
    }
});

router.get("/process/:id/timing", (req, res) => {
    const processId = req.params.id;

    // Check running processes first
    const runningProcess = runningProcesses.get(processId);
    if (runningProcess) {
        return res.status(200).json(jobTimer.getTimingReport(processId));
    }

    // Check history if not running
    const historicalProcess = processHistory.getProcess(processId);
    if (historicalProcess?.timing) {
        return res.status(200).json(historicalProcess.timing);
    }

    return res.status(404).json({
        message: `Timing information for process ${processId} not found`,
    });
});

// Add new endpoint for process metrics
router.get("/process/:id/metrics", async(req, res) => {
    try {
        const processId = req.params.id;
        const process = runningProcesses.get(processId);
        
        if (!process) {
            return res.status(404).json({
                error: "Process not found"
            });
        }

        // Get process metrics from ProcessOutputManager
        const outputs = processOutputManager.getOutputs(processId);
        
        // Extract timing data
        const timingData = outputs
            .filter(output => output.type === "timing")
            .map(output => JSON.parse(output.content));

        // Extract error data
        const errorData = outputs
            .filter(output => output.type === "error")
            .map(output => JSON.parse(output.content));

        // Get the latest metrics
        const latestTiming = timingData[timingData.length - 1] || null;
        
        return res.json({
            process_id: processId,
            status: process.status || "unknown",
            metrics: latestTiming?.metrics || null,
            errors: errorData,
            timing_history: timingData
        });
    } catch (error) {
        logger.error(`Error fetching process metrics: ${error}`);
        return res.status(500).json({
            error: "Failed to fetch process metrics"
        });
    }
});

setupMonitoringRoutes(router);

module.exports = router;