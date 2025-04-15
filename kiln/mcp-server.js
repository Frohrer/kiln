import express from "express";
import http from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HttpServerTransport } from "@modelcontextprotocol/sdk/server/http.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import events from "events";
import logplease from "logplease";

// Get the directory name for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Dynamic imports for Kiln modules
const importKilnModules = async () => {
  const { WebEnabledJob, runningProcesses } = await import(join(__dirname, "api/src/web-enabled-job.js"));
  const { ProxyManager } = await import(join(__dirname, "api/src/proxy-handler.js"));
  const runtime = await import(join(__dirname, "api/src/runtime.js"));
  const package_manager = await import(join(__dirname, "api/src/package.js"));
  const globals = await import(join(__dirname, "api/src/globals.js"));
  const { jobTimer } = await import(join(__dirname, "api/src/timing.js"));
  const { processHistory } = await import(join(__dirname, "api/src/process-history.js"));
  const { pipIgnore } = await import(join(__dirname, "api/src/pip_ignore.js"));
  const { setupMonitoringRoutes, trackExecution } = await import(join(__dirname, "api/src/monitoring.js"));
  const { processOutputManager } = await import(join(__dirname, "api/src/process-output-manager.js"));
  
  return {
    WebEnabledJob,
    runningProcesses,
    ProxyManager,
    runtime,
    package: package_manager,
    globals,
    jobTimer,
    processHistory,
    pipIgnore,
    setupMonitoringRoutes,
    trackExecution,
    processOutputManager
  };
};

// Port for Express server
const PORT = process.env.PORT || 3000;
const logger = logplease.create("mcp-server");

// Create MCP server
const server = new McpServer({
  name: "Kiln",
  version: "1.0.0"
});

// Setup Express server for HTTP transport
const app = express();
const httpServer = http.createServer(app);
app.use(express.json());

// Helper function to get dependencies
function getDependencies(code, language, pipIgnore) {
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
    return getDependencies(code, "python", pipIgnore);
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

// Function to create a job
function get_job(body, kilnModules) {
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

    const rt = kilnModules.runtime.get_latest_runtime_matching_language_version(language, version);
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
      new kilnModules.WebEnabledJob({
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
        proxyManager: kilnModules.ProxyManager,
        long_running: body.long_running === true,
      })
    );
  });
}

// Initialize and set up tools
const setupServer = async () => {
  const kilnModules = await importKilnModules();
  
  // Define execute_code tool
  server.tool(
    "execute_code",
    z.object({
      language: z.string().describe("Programming language (e.g., python, javascript, nodejs, streamlit)"),
      version: z.string().describe("Version of the language runtime"),
      files: z.array(
        z.object({
          name: z.string(),
          content: z.string(),
          encoding: z.string().optional().default("utf8")
        })
      ).describe("Array of files with their content"),
      args: z.array(z.string()).optional().describe("Command line arguments"),
      stdin: z.string().optional().describe("Standard input to provide to the program"),
      dependencies: z.array(z.string()).optional().describe("Dependencies to install"),
      run_timeout: z.number().optional().describe("Maximum time (in seconds) allowed for execution"),
      compile_timeout: z.number().optional().describe("Maximum time (in seconds) allowed for compilation"),
      run_memory_limit: z.number().optional().describe("Maximum memory (in MB) allowed for execution"),
      compile_memory_limit: z.number().optional().describe("Maximum memory (in MB) allowed for compilation"),
      long_running: z.boolean().optional().describe("Whether this is a long-running process (like a web app)")
    }),
    async (params, context) => {
      try {
        logger.debug("Executing code with params:", params);
        
        // Parse dependencies from code if not provided
        if (!params.dependencies) {
          params.dependencies = [];
          if (Array.isArray(params.files)) {
            for (let file of params.files) {
              if (file && file.content) {
                const deps = getDependencies(file.content, params.language, kilnModules.pipIgnore);
                params.dependencies = params.dependencies.concat(deps);
              }
            }
            params.dependencies = [...new Set(params.dependencies)];
          }
        } else if (typeof params.dependencies === "string") {
          params.dependencies = [params.dependencies];
        }
        
        // Create job
        const job = await get_job(params, kilnModules);
        kilnModules.jobTimer.startTiming(job.uuid);
        
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
          context.sendStreaming({
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
          context.sendStreaming({
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
            context.sendStreaming({
              type: "stage",
              stage: stage
            });
          }
        });
        
        // Prime and execute the job
        const box = await job.prime();
        
        // Send runtime info
        context.sendStreaming({
          type: "runtime",
          language: job.runtime.language,
          version: job.runtime.version.raw
        });
        
        // Execute the job
        let result = await job.execute(box, event_bus);
        const timingReport = kilnModules.jobTimer.endTiming(job.uuid);
        
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
          context.sendStreaming({
            type: "webApp",
            url: job.proxyPath
          });
        }
        
        // Track execution
        kilnModules.trackExecution(job, result);
        
        // Clean up if not a long-running job
        if (!params.long_running) {
          try {
            await job.cleanup();
            kilnModules.jobTimer.cleanup(job.uuid);
          } catch (error) {
            logger.error(`Error cleaning up job ${job.uuid}:`, error);
          }
        }
        
        return {
          content: [{ type: "text", text: JSON.stringify(result) }]
        };
      } catch (error) {
        logger.error("Error executing code:", error);
        throw new Error(`Failed to execute code: ${error.message}`);
      }
    }
  );
  
  // List Runtimes Tool
  server.tool(
    "list_runtimes",
    z.object({}),
    async () => {
      try {
        const runtimes = kilnModules.runtime.map((rt) => {
          return {
            language: rt.language,
            version: rt.version.raw,
            aliases: rt.aliases,
            runtime: rt.runtime,
          };
        });
        
        return {
          content: [{ type: "text", text: JSON.stringify({ runtimes }) }]
        };
      } catch (error) {
        logger.error("Error listing runtimes:", error);
        throw new Error(`Failed to list runtimes: ${error.message}`);
      }
    }
  );
  
  // List Processes Tool
  server.tool(
    "list_processes",
    z.object({}),
    async () => {
      try {
        // Get running processes
        const running = Array.from(kilnModules.runningProcesses.entries()).map(([id, job]) => ({
          id: id,
          language: job.runtime.language,
          version: job.runtime.version.raw,
          webAppUrl: job.proxyPath || null,
          startTime: job.startTime,
          status: "running",
          timing: kilnModules.jobTimer.getTimingReport(id),
        }));

        // Get completed processes from history
        const completed = kilnModules.processHistory.getHistory();

        const result = {
          count: running.length + completed.length,
          processes: [...running, ...completed],
        };
        
        return {
          content: [{ type: "text", text: JSON.stringify(result) }]
        };
      } catch (error) {
        logger.error("Error listing processes:", error);
        throw new Error(`Failed to list processes: ${error.message}`);
      }
    }
  );
  
  // Get Process Details Tool
  server.tool(
    "get_process",
    z.object({
      process_id: z.string().describe("ID of the process to get details for")
    }),
    async (params) => {
      try {
        const processId = params.process_id;
        
        // Check running processes first
        const runningProcess = kilnModules.runningProcesses.get(processId);
        if (runningProcess) {
          const result = {
            id: processId,
            language: runningProcess.runtime.language,
            version: runningProcess.runtime.version.raw,
            webAppUrl: runningProcess.proxyPath || null,
            startTime: runningProcess.startTime,
            status: "running",
            timing: kilnModules.jobTimer.getTimingReport(processId),
          };
          
          return {
            content: [{ type: "text", text: JSON.stringify(result) }]
          };
        }
        
        // Check history if not running
        const historicalProcess = kilnModules.processHistory.getProcess(processId);
        if (historicalProcess) {
          const result = {
            id: processId,
            ...historicalProcess,
          };
          
          return {
            content: [{ type: "text", text: JSON.stringify(result) }]
          };
        }
        
        throw new Error(`Process ${processId} not found`);
      } catch (error) {
        logger.error(`Error getting process: ${error.message}`);
        throw new Error(`Failed to get process: ${error.message}`);
      }
    }
  );
  
  // Terminate Process Tool
  server.tool(
    "terminate_process",
    z.object({
      process_id: z.string().describe("ID of the process to terminate")
    }),
    async (params) => {
      try {
        const processId = params.process_id;
        const job = kilnModules.runningProcesses.get(processId);
        
        if (!job) {
          throw new Error(`Process ${processId} not found or already terminated`);
        }
        
        await job.terminate();
        const result = {
          message: `Process ${processId} terminated successfully`,
        };
        
        return {
          content: [{ type: "text", text: JSON.stringify(result) }]
        };
      } catch (error) {
        logger.error(`Error terminating process: ${error.message}`);
        throw new Error(`Failed to terminate process: ${error.message}`);
      }
    }
  );
  
  // Get Process Logs Tool
  server.tool(
    "get_process_logs",
    z.object({
      process_id: z.string().describe("ID of the process to get logs for")
    }),
    async (params) => {
      try {
        const processId = params.process_id;
        const output = kilnModules.processOutputManager.getProcessOutput(processId);
        
        if (!output) {
          throw new Error(`Process ${processId} not found or has no output`);
        }
        
        return {
          content: [{ type: "text", text: JSON.stringify(output) }]
        };
      } catch (error) {
        logger.error(`Error getting process logs: ${error.message}`);
        throw new Error(`Failed to get process logs: ${error.message}`);
      }
    }
  );
  
  // List Packages Tool
  server.tool(
    "list_packages",
    z.object({}),
    async () => {
      try {
        let packages = await kilnModules.package.get_package_list();
        
        packages = packages.map((pkg) => {
          return {
            language: pkg.language,
            language_version: pkg.version.raw,
            installed: pkg.installed,
          };
        });
        
        return {
          content: [{ type: "text", text: JSON.stringify({ packages }) }]
        };
      } catch (error) {
        logger.error(`Error listing packages: ${error.message}`);
        throw new Error(`Failed to list packages: ${error.message}`);
      }
    }
  );
  
  // Install Package Tool
  server.tool(
    "install_package",
    z.object({
      language: z.string().describe("Language of the package"),
      version: z.string().describe("Version of the package")
    }),
    async (params) => {
      try {
        const { language, version } = params;
        const pkg = await kilnModules.package.get_package(language, version);
        
        if (pkg == null) {
          throw new Error(`Requested package ${language}-${version} does not exist`);
        }
        
        const response = await pkg.install();
        
        return {
          content: [{ type: "text", text: JSON.stringify(response) }]
        };
      } catch (error) {
        logger.error(`Error installing package: ${error.message}`);
        
        if (error.message === "Already installed") {
          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify({ 
                status: "already_installed", 
                message: error.message 
              }) 
            }]
          };
        }
        
        throw new Error(`Failed to install package: ${error.message}`);
      }
    }
  );
  
  // Uninstall Package Tool
  server.tool(
    "uninstall_package",
    z.object({
      language: z.string().describe("Language of the package"),
      version: z.string().describe("Version of the package")
    }),
    async (params) => {
      try {
        const { language, version } = params;
        const pkg = await kilnModules.package.get_package(language, version);
        
        if (pkg == null) {
          throw new Error(`Requested package ${language}-${version} does not exist`);
        }
        
        const response = await pkg.uninstall();
        
        return {
          content: [{ type: "text", text: JSON.stringify(response) }]
        };
      } catch (error) {
        logger.error(`Error uninstalling package: ${error.message}`);
        throw new Error(`Failed to uninstall package: ${error.message}`);
      }
    }
  );
  
  // Set up HTTP transport
  const httpTransport = new HttpServerTransport({ server: httpServer });
  
  // Set up stdout/stdin transport for local connection
  const stdioTransport = new StdioServerTransport();
  
  // Detect transport
  const isDocker = process.env.RUNNING_IN_DOCKER === 'true';
  
  // Express routes for MCP info
  app.get('/mcp-info', (req, res) => {
    res.json({
      name: server.name,
      version: server.version,
      tools: server.getTools().map(tool => ({
        name: tool.name,
        description: tool.description
      }))
    });
  });
  
  // Start HTTP server if in Docker environment
  if (isDocker) {
    httpServer.listen(PORT, () => {
      logger.info(`MCP Kiln server running on HTTP port ${PORT}`);
    });
    await server.connect(httpTransport);
  } else {
    // Use stdio transport for local execution
    logger.info("Starting MCP Kiln server with stdio transport");
    await server.connect(stdioTransport);
  }
};

// Run the server
setupServer().catch(err => {
  logger.error("Failed to start MCP server:", err);
  process.exit(1);
}); 