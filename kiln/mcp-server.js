const express = require("express");
const http = require("http");
const { MCPServer } = require("@modelcontextprotocol/server");
const { WebEnabledJob, runningProcesses } = require("./api/src/web-enabled-job");
const { ProxyManager } = require("./api/src/proxy-handler");
const runtime = require("./api/src/runtime");
const package = require("./api/src/package");
const globals = require("./api/src/globals");
const { jobTimer } = require("./api/src/timing");
const { processHistory } = require("./api/src/process-history");
const { pipIgnore } = require("./api/src/pip_ignore");
const { setupMonitoringRoutes, trackExecution } = require("./api/src/monitoring");
const { processOutputManager } = require("./api/src/process-output-manager");
const events = require("events");
const logplease = require("logplease");
const logger = logplease.create("mcp-server");

// Port for Express server
const PORT = process.env.PORT || 3000;

// Create Express app
const app = express();
const server = http.createServer(app);

app.use(express.json());

// Initialize MCP Server
const mcpServer = new MCPServer();

// Helper function from Kiln API
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

// Function to create a job (modified from Kiln API)
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

// Define MCP tools
mcpServer.defineTools([
    // Execute Code Tool
    {
        name: "execute_code",
        description: "Execute code in various programming languages",
        parameters: {
            type: "object",
            properties: {
                language: { 
                    type: "string", 
                    description: "Programming language (e.g., python, javascript, nodejs, streamlit)" 
                },
                version: { 
                    type: "string", 
                    description: "Version of the language runtime" 
                },
                files: { 
                    type: "array", 
                    description: "Array of files with their content",
                    items: {
                        type: "object",
                        properties: {
                            name: { type: "string" },
                            content: { type: "string" },
                            encoding: { type: "string", default: "utf8" }
                        },
                        required: ["name", "content"]
                    }
                },
                args: { 
                    type: "array", 
                    description: "Command line arguments", 
                    items: { type: "string" } 
                },
                stdin: { 
                    type: "string", 
                    description: "Standard input to provide to the program" 
                },
                dependencies: {
                    type: "array",
                    description: "Dependencies to install",
                    items: { type: "string" }
                },
                run_timeout: {
                    type: "number", 
                    description: "Maximum time (in seconds) allowed for execution" 
                },
                compile_timeout: {
                    type: "number", 
                    description: "Maximum time (in seconds) allowed for compilation" 
                },
                run_memory_limit: {
                    type: "number", 
                    description: "Maximum memory (in MB) allowed for execution" 
                },
                compile_memory_limit: {
                    type: "number", 
                    description: "Maximum memory (in MB) allowed for compilation" 
                },
                long_running: {
                    type: "boolean",
                    description: "Whether this is a long-running process (like a web app)"
                }
            },
            required: ["language", "version", "files"]
        },
        handler: async (params, context) => {
            try {
                logger.debug("Executing code with params:", params);
                
                // Parse dependencies from code if not provided
                if (!params.dependencies) {
                    params.dependencies = [];
                    if (Array.isArray(params.files)) {
                        for (let file of params.files) {
                            if (file && file.content) {
                                const deps = getDependencies(file.content, params.language);
                                params.dependencies = params.dependencies.concat(deps);
                            }
                        }
                        params.dependencies = [...new Set(params.dependencies)];
                    }
                } else if (typeof params.dependencies === "string") {
                    params.dependencies = [params.dependencies];
                }
                
                // Create job
                const job = await get_job(params);
                jobTimer.startTiming(job.uuid);
                
                // Setup event bus and capture output
                const event_bus = new events.EventEmitter();
                const outputs = {
                    install: { stdout: "", stderr: "" },
                    execute: { stdout: "", stderr: "" },
                };
                let currentStage = "execute"; // Default stage
                
                event_bus.on("stdout", (data) => {
                    const stage = currentStage in outputs ? currentStage : "execute";
                    outputs[stage].stdout += data.toString();
                    
                    // Send progress update
                    context.sendStreamingUpdate({
                        type: "progress",
                        stage: stage,
                        stream: "stdout",
                        data: data.toString()
                    });
                });
                
                event_bus.on("stderr", (data) => {
                    const stage = currentStage in outputs ? currentStage : "execute";
                    outputs[stage].stderr += data.toString();
                    
                    // Send progress update
                    context.sendStreamingUpdate({
                        type: "progress",
                        stage: stage,
                        stream: "stderr",
                        data: data.toString()
                    });
                });
                
                event_bus.on("stage", (stage) => {
                    if (stage in outputs) {
                        currentStage = stage;
                        
                        // Send stage update
                        context.sendStreamingUpdate({
                            type: "stage",
                            stage: stage
                        });
                    }
                });
                
                // Prime and execute the job
                const box = await job.prime();
                
                // Send runtime info
                context.sendStreamingUpdate({
                    type: "runtime",
                    language: job.runtime.language,
                    version: job.runtime.version.raw
                });
                
                // Execute the job
                let result = await job.execute(box, event_bus);
                const timingReport = jobTimer.endTiming(job.uuid);
                
                // Ensure run object has the output
                if (result.run) {
                    result.run.stdout = outputs.execute.stdout;
                    result.run.stderr = outputs.execute.stderr;
                    result.run.output = outputs.execute.stdout + outputs.execute.stderr;
                }
                
                // Build complete result
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
                    
                    // Send webApp URL
                    context.sendStreamingUpdate({
                        type: "webApp",
                        url: job.proxyPath
                    });
                }
                
                // Track execution
                trackExecution(job, result);
                
                // Clean up if not a long-running job
                if (!params.long_running) {
                    try {
                        await job.cleanup();
                        jobTimer.cleanup(job.uuid);
                    } catch (error) {
                        logger.error(`Error cleaning up job ${job.uuid}:`, error);
                    }
                }
                
                return result;
            } catch (error) {
                logger.error("Error executing code:", error);
                throw new Error(`Failed to execute code: ${error.message}`);
            }
        }
    },
    
    // List Runtimes Tool
    {
        name: "list_runtimes",
        description: "Get a list of available programming language runtimes",
        parameters: {
            type: "object",
            properties: {}
        },
        handler: async () => {
            try {
                const runtimes = runtime.map((rt) => {
                    return {
                        language: rt.language,
                        version: rt.version.raw,
                        aliases: rt.aliases,
                        runtime: rt.runtime,
                    };
                });
                
                return { runtimes };
            } catch (error) {
                logger.error("Error listing runtimes:", error);
                throw new Error(`Failed to list runtimes: ${error.message}`);
            }
        }
    },
    
    // List Processes Tool
    {
        name: "list_processes",
        description: "Get a list of all running and completed processes",
        parameters: {
            type: "object",
            properties: {}
        },
        handler: async () => {
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

                return {
                    count: running.length + completed.length,
                    processes: [...running, ...completed],
                };
            } catch (error) {
                logger.error("Error listing processes:", error);
                throw new Error(`Failed to list processes: ${error.message}`);
            }
        }
    },
    
    // Get Process Details Tool
    {
        name: "get_process",
        description: "Get details about a specific process by ID",
        parameters: {
            type: "object",
            properties: {
                process_id: { 
                    type: "string", 
                    description: "ID of the process to get details for" 
                }
            },
            required: ["process_id"]
        },
        handler: async (params) => {
            try {
                const processId = params.process_id;
                
                // Check running processes first
                const runningProcess = runningProcesses.get(processId);
                if (runningProcess) {
                    return {
                        id: processId,
                        language: runningProcess.runtime.language,
                        version: runningProcess.runtime.version.raw,
                        webAppUrl: runningProcess.proxyPath || null,
                        startTime: runningProcess.startTime,
                        status: "running",
                        timing: jobTimer.getTimingReport(processId),
                    };
                }
                
                // Check history if not running
                const historicalProcess = processHistory.getProcess(processId);
                if (historicalProcess) {
                    return {
                        id: processId,
                        ...historicalProcess,
                    };
                }
                
                throw new Error(`Process ${processId} not found`);
            } catch (error) {
                logger.error(`Error getting process: ${error.message}`);
                throw new Error(`Failed to get process: ${error.message}`);
            }
        }
    },
    
    // Terminate Process Tool
    {
        name: "terminate_process",
        description: "Terminate a running process by ID",
        parameters: {
            type: "object",
            properties: {
                process_id: { 
                    type: "string", 
                    description: "ID of the process to terminate" 
                }
            },
            required: ["process_id"]
        },
        handler: async (params) => {
            try {
                const processId = params.process_id;
                const job = runningProcesses.get(processId);
                
                if (!job) {
                    throw new Error(`Process ${processId} not found or already terminated`);
                }
                
                await job.terminate();
                return {
                    message: `Process ${processId} terminated successfully`,
                };
            } catch (error) {
                logger.error(`Error terminating process: ${error.message}`);
                throw new Error(`Failed to terminate process: ${error.message}`);
            }
        }
    },
    
    // Get Process Logs Tool
    {
        name: "get_process_logs",
        description: "Get logs for a specific process by ID",
        parameters: {
            type: "object",
            properties: {
                process_id: { 
                    type: "string", 
                    description: "ID of the process to get logs for" 
                }
            },
            required: ["process_id"]
        },
        handler: async (params) => {
            try {
                const processId = params.process_id;
                const output = processOutputManager.getProcessOutput(processId);
                
                if (!output) {
                    throw new Error(`Process ${processId} not found or has no output`);
                }
                
                return output;
            } catch (error) {
                logger.error(`Error getting process logs: ${error.message}`);
                throw new Error(`Failed to get process logs: ${error.message}`);
            }
        }
    },
    
    // List Packages Tool
    {
        name: "list_packages",
        description: "Get a list of available packages",
        parameters: {
            type: "object",
            properties: {}
        },
        handler: async () => {
            try {
                let packages = await package.get_package_list();
                
                packages = packages.map((pkg) => {
                    return {
                        language: pkg.language,
                        language_version: pkg.version.raw,
                        installed: pkg.installed,
                    };
                });
                
                return { packages };
            } catch (error) {
                logger.error(`Error listing packages: ${error.message}`);
                throw new Error(`Failed to list packages: ${error.message}`);
            }
        }
    },
    
    // Install Package Tool
    {
        name: "install_package",
        description: "Install a specific package",
        parameters: {
            type: "object",
            properties: {
                language: { 
                    type: "string", 
                    description: "Language of the package" 
                },
                version: { 
                    type: "string", 
                    description: "Version of the package" 
                }
            },
            required: ["language", "version"]
        },
        handler: async (params) => {
            try {
                const { language, version } = params;
                const pkg = await package.get_package(language, version);
                
                if (pkg == null) {
                    throw new Error(`Requested package ${language}-${version} does not exist`);
                }
                
                const response = await pkg.install();
                return response;
            } catch (error) {
                logger.error(`Error installing package: ${error.message}`);
                
                if (error.message === "Already installed") {
                    return {
                        status: "already_installed",
                        message: error.message
                    };
                }
                
                throw new Error(`Failed to install package: ${error.message}`);
            }
        }
    },
    
    // Uninstall Package Tool
    {
        name: "uninstall_package",
        description: "Uninstall a specific package",
        parameters: {
            type: "object",
            properties: {
                language: { 
                    type: "string", 
                    description: "Language of the package" 
                },
                version: { 
                    type: "string", 
                    description: "Version of the package" 
                }
            },
            required: ["language", "version"]
        },
        handler: async (params) => {
            try {
                const { language, version } = params;
                const pkg = await package.get_package(language, version);
                
                if (pkg == null) {
                    throw new Error(`Requested package ${language}-${version} does not exist`);
                }
                
                const response = await pkg.uninstall();
                return response;
            } catch (error) {
                logger.error(`Error uninstalling package: ${error.message}`);
                throw new Error(`Failed to uninstall package: ${error.message}`);
            }
        }
    }
]);

// Start MCP server
mcpServer.start();

// Express routes to expose MCP server
app.get('/mcp-info', (req, res) => {
    res.json({
        mcp: true,
        version: '1.0.0',
        tools: mcpServer.getTools().map(tool => ({
            name: tool.name,
            description: tool.description
        }))
    });
});

// Start the Express server
server.listen(PORT, () => {
    logger.info(`MCP Kiln server running on port ${PORT}`);
});

// Export for testing
module.exports = { app, mcpServer }; 