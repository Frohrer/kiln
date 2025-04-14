const logplease = require("logplease");
const { v4: uuidv4 } = require("uuid");
const cp = require("child_process");
const path = require("path");
const config = require("./config");
const fs = require("fs/promises");
const globals = require("./globals");
const { pipIgnore } = require("./pip_ignore");

const job_states = {
    READY: Symbol("Ready to be primed"),
    PRIMED: Symbol("Primed and ready for execution"),
    EXECUTED: Symbol("Executed and ready for cleanup"),
};

const MAX_BOX_ID = 999;
const ISOLATE_PATH = "/usr/local/bin/isolate";
let box_id = 0;

let remaining_job_spaces = config.max_concurrent_jobs;
let job_queue = [];

const get_next_box_id = () => ++box_id % MAX_BOX_ID;

class Job {
    dirty_boxes;
    constructor({ runtime, files, args, stdin, timeouts, cpu_times, memory_limits, dependencies = [], long_running }) {
        this.uuid = uuidv4();
        this.long_running = !!long_running;
        this.dependencies = dependencies;
        this.logger = logplease.create(`job/${this.uuid}`);

        this.runtime = runtime;
        this.files = files.map((file, i) => ({
            name: file.name || `file${i}.code`,
            content: file.content,
            encoding: ["base64", "hex", "utf8"].includes(file.encoding) ? file.encoding : "utf8",
        }));

        this.args = args;
        this.stdin = stdin;
        // Add a trailing newline if it doesn't exist
        if (this.stdin.slice(-1) !== "\n") {
            this.stdin += "\n";
        }

        this.timeouts = timeouts;
        this.cpu_times = cpu_times;
        this.memory_limits = memory_limits;

        this.state = job_states.READY;
        this.dirty_boxes = [];
    }

    async forceCleanupBox(boxId) {
        try {
            // Force kill any processes in the box
            await new Promise((resolve) => {
                cp.exec(`lsof -t /var/local/lib/isolate/${boxId}/box | xargs kill -9`, () => resolve());
            });

            // Force cleanup with retry
            await new Promise((resolve, reject) => {
                const tryCleanup = (attempts = 3) => {
                    if (attempts <= 0) {
                        reject(new Error(`Failed to cleanup box ${boxId} after multiple attempts`));
                        return;
                    }

                    cp.exec(`isolate --cleanup --cg --box-id=${boxId}`, (error, stdout, stderr) => {
                        if (error && stderr.includes("box is currently in use")) {
                            setTimeout(() => tryCleanup(attempts - 1), 1000);
                        } else {
                            resolve();
                        }
                    });
                };
                tryCleanup();
            });
        } catch (error) {
            this.logger.error(`Force cleanup failed for box ${boxId}: ${error.message}`);
        }
    }

    getBoxIds() {
        // Since #dirty_boxes is private, we implement this to safely expose box IDs
        return Array.from(this.dirty_boxes).map((box) => box.id);
    }

    async create_isolate_box() {
        const box_id = get_next_box_id();
        const metadata_file_path = `/tmp/${box_id}-metadata.txt`;
        return new Promise((res, rej) => {
            // Use --box-id instead of -b for newer isolate version
            cp.exec(`isolate --init --cg --box-id=${box_id}`, (error, stdout, stderr) => {
                if (error) {
                    rej(`Failed to run isolate --init: ${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`);
                }
                if (stdout === "" || stdout === undefined) {
                    rej("Received empty or undefined stdout from isolate --init");
                }
                const box = {
                    id: box_id,
                    metadata_file_path,
                    dir: `${stdout.trim()}/box`,
                };
                this.dirty_boxes.push(box);
                res(box);
            });
        });
    }

    async prime() {
        if (remaining_job_spaces < 1) {
            this.logger.info(`Awaiting job slot`);
            await new Promise((resolve) => {
                job_queue.push(resolve);
            });
        }
        this.logger.info(`Priming job`);
        remaining_job_spaces--;
        this.logger.debug("Running isolate --init");
        const box = await this.create_isolate_box();

        this.logger.debug(`Creating submission files in Isolate box`);
        const submission_dir = path.join(box.dir, "submission");
        await fs.mkdir(submission_dir);
        for (const file of this.files) {
            const file_path = path.join(submission_dir, file.name);
            const rel = path.relative(submission_dir, file_path);

            if (rel.startsWith("..")) throw Error(`File path "${file.name}" tries to escape parent directory: ${rel}`);

            const file_content = Buffer.from(file.content, file.encoding);

            await fs.mkdir(path.dirname(file_path), {
                recursive: true,
                mode: 0o700,
            });
            await fs.write_file(file_path, file_content);
        }

        this.state = job_states.PRIMED;

        this.logger.debug("Primed job");
        return box;
    }

    async safe_call(box, executable, args, timeout, cpu_time, memory_limit, event_bus = null) {
        let stdout = "";
        let stderr = "";
        let output = "";
        let memory = null;
        let code = null;
        let signal = null;
        let message = null;
        let status = null;
        let cpu_time_stat = null;
        let wall_time_stat = null;

        const proc = cp.spawn(
            ISOLATE_PATH, [
                "--run",
                `--box-id=${box.id}`,
                `--meta=${box.metadata_file_path}`,
                "--cg",
                "-s",
                "-c",
                "/box/submission",
                "-e",
                `--dir=${this.runtime.pkgdir}`,
                `--dir=/etc:noexec`,
                `--processes=${this.runtime.max_process_count}`,
                `--open-files=${this.runtime.max_open_files}`,
                `--fsize=${Math.floor(this.runtime.max_file_size / 1000)}`,
                `--wall-time=${timeout / 1000}`,
                `--time=${cpu_time / 1000}`,
                `--extra-time=0`,
                ...(memory_limit >= 0 ? [`--cg-mem=${Math.floor(memory_limit / 1000)}`] : []),
                ...(config.disable_networking ? [] : ["--share-net"]),
                "--",
                "/bin/bash",
                path.join(this.runtime.pkgdir, executable),
                ...args,
            ], {
                env: {
                    ...this.runtime.env_vars,
                    KILN_LANGUAGE: this.runtime.language,
                },
                stdio: "pipe",
            }
        );

        if (event_bus === null) {
            proc.stdin.write(this.stdin);
            proc.stdin.end();
            proc.stdin.destroy();
        } else {
            event_bus.on("stdin", (data) => {
                proc.stdin.write(data);
            });

            event_bus.on("kill", (signal) => {
                proc.kill(signal);
            });
        }

        proc.stderr.on("data", async(data) => {
            if (event_bus !== null) {
                event_bus.emit("stderr", data);
            } else if (stderr.length + data.length > this.runtime.output_max_size) {
                message = "stderr length exceeded";
                status = "EL";
                this.logger.info(message);
                try {
                    process.kill(proc.pid, "SIGABRT");
                } catch (e) {
                    // Could already be dead and just needs to be waited on
                    this.logger.debug(`Got error while SIGABRTing process ${proc}:`, e);
                }
            } else {
                stderr += data;
                output += data;
            }
        });

        proc.stdout.on("data", async(data) => {
            if (event_bus !== null) {
                event_bus.emit("stdout", data);
            } else if (stdout.length + data.length > this.runtime.output_max_size) {
                message = "stdout length exceeded";
                status = "OL";
                this.logger.info(message);
                try {
                    process.kill(proc.pid, "SIGABRT");
                } catch (e) {
                    // Could already be dead and just needs to be waited on
                    this.logger.debug(`Got error while SIGABRTing process ${proc}:`, e);
                }
            } else {
                stdout += data;
                output += data;
            }
        });

        const data = await new Promise((res, rej) => {
            proc.on("exit", (_, signal) => {
                res({
                    signal,
                });
            });

            proc.on("error", (err) => {
                rej({
                    error: err,
                });
            });
        });

        try {
            const metadata_str = (await fs.read_file(box.metadata_file_path)).toString();
            const metadata_lines = metadata_str.split("\n");
            for (const line of metadata_lines) {
                if (!line) continue;

                const [key, value] = line.split(":");
                if (key === undefined || value === undefined) {
                    throw new Error(`Failed to parse metadata file, received: ${line}`);
                }
                switch (key) {
                    case "cg-mem":
                        memory = parse_int(value) * 1000;
                        break;
                    case "exitcode":
                        code = parse_int(value);
                        break;
                    case "exitsig":
                        signal = globals.SIGNALS[parse_int(value)] ?? null;
                        break;
                    case "message":
                        message = message || value;
                        break;
                    case "status":
                        status = status || value;
                        break;
                    case "time":
                        cpu_time_stat = parse_float(value) * 1000;
                        break;
                    case "time-wall":
                        wall_time_stat = parse_float(value) * 1000;
                        break;
                    default:
                        break;
                }
            }
        } catch (e) {
            throw new Error(`Error reading metadata file: ${box.metadata_file_path}\nError: ${e.message}\nIsolate run stdout: ${stdout}\nIsolate run stderr: ${stderr}`);
        }

        return {
            ...data,
            stdout,
            stderr,
            code,
            signal: ["TO", "OL", "EL"].includes(status) ? "SIGKILL" : signal,
            output,
            memory,
            message,
            status,
            cpu_time: cpu_time_stat,
            wall_time: wall_time_stat,
        };
    }

    async installDependencies(box, event_bus = null) {
        if (!this.dependencies || this.dependencies.length === 0) {
            this.logger.debug("No dependencies to install after filtering");
            return { code: 0, status: "success" };
        }

        // Filter out native Python packages
        if (this.runtime.language === "python") {
            this.dependencies = this.dependencies.filter(dep => !pipIgnore.includes(dep));
            if (this.dependencies.length === 0) {
                this.logger.debug("All dependencies are native Python packages, skipping installation");
                return { code: 0, status: "success" };
            }
        }

        const packageInstallCommands = {
            python: (dependencies) => ["install", "--target=/box/submission", ...dependencies],
            node: (dependencies) => ["install", "--prefix", "/box/submission", ...dependencies],
            // Add other languages as needed
        };

        const installCommandArgs = packageInstallCommands[this.runtime.language];

        if (!installCommandArgs) {
            throw new Error(`Package installation not implemented for language ${this.runtime.language}`);
        }

        const args = installCommandArgs(this.dependencies);

        this.logger.info(`Running install command: packagemanager ${args.join(" ")}`);

        // Run the install command inside the isolated environment
        const installResult = await this.safe_call(box, "packagemanager", args, this.timeouts.run, this.cpu_times.run, this.memory_limits.run, event_bus);
        console.log(installResult);
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

    async execute(box, event_bus = null) {
        if (this.state !== job_states.PRIMED) {
            throw new Error("Job must be in primed state, current state: " + this.state.toString());
        }

        this.logger.info(`Executing job runtime=${this.runtime.toString()}`);

        // Ensure Python files have .py extension
        if (this.runtime.language === "python") {
            this.files = this.files.map(file => ({
                ...file,
                name: file.name.endsWith('.py') ? file.name : `${file.name}.py`
            }));
        }

        const code_files = (this.runtime.language === "file" && this.files) || this.files.filter((file) => file.encoding == "utf8");

        let compile;
        let run;
        let compile_errored = false;
        const { emit_event_bus_result, emit_event_bus_stage } =
        event_bus === null ?
            {
                emit_event_bus_result: () => {},
                emit_event_bus_stage: () => {},
            } :
            {
                emit_event_bus_result: (stage, result) => {
                    const { error, code, signal } = result;
                    event_bus.emit("exit", stage, {
                        error,
                        code,
                        signal,
                    });
                },
                emit_event_bus_stage: (stage) => {
                    event_bus.emit("stage", stage);
                },
            };

        if (this.runtime.compiled) {
            this.logger.debug("Compiling");
            emit_event_bus_stage("compile");
            compile = await this.safe_call(
                box,
                "compile",
                code_files.map((x) => x.name),
                this.timeouts.compile,
                this.cpu_times.compile,
                this.memory_limits.compile,
                event_bus
            );
            emit_event_bus_result("compile", compile);
            compile_errored = compile.code !== 0;
            if (!compile_errored) {
                const old_box_dir = box.dir;
                box = await this.create_isolate_box();
                await fs.rename(path.join(old_box_dir, "submission"), path.join(box.dir, "submission"));
            }
        }

        if (!compile_errored) {
            // Install dependencies if any
            if (this.dependencies && this.dependencies.length > 0) {
                this.logger.debug(`Installing dependencies: ${this.dependencies.join(", ")}`);
                emit_event_bus_stage("install");
                const installErrors = await this.installDependencies(box, event_bus);
                if (installErrors !== undefined) {
                    emit_event_bus_stage("execute");
                    return {
                        compile,
                        run: installErrors,
                        language: this.runtime.language,
                        version: this.runtime.version.raw,
                    };
                }
            }

            this.logger.debug("Running code");
            emit_event_bus_stage("execute");
            run = await this.safe_call(box, "run", [code_files[0].name, ...this.args], this.timeouts.run, this.cpu_times.run, this.memory_limits.run, event_bus);
            emit_event_bus_result("execute", run);
        }

        this.state = job_states.EXECUTED;

        return {
            compile,
            run,
            language: this.runtime.language,
            version: this.runtime.version.raw,
        };
    }

    async cleanup() {
        this.logger.info(`Cleaning up job`);

        remaining_job_spaces++;
        if (job_queue.length > 0) {
            job_queue.shift()();
        }
        await Promise.all(
            this.dirty_boxes.map(async(box) => {
                cp.exec(
                    `isolate --cleanup --cg --box-id=${box.id}`, // Updated flags
                    (error, stdout, stderr) => {
                        if (error) {
                            this.logger.error(`Failed to run isolate --cleanup: ${error.message} on box #${box.id}\nstdout: ${stdout}\nstderr: ${stderr}`);
                        }
                    }
                );
                try {
                    // Check if file exists before trying to remove it
                    const exists = await fs.access(box.metadata_file_path).then(() => true).catch(() => false);
                    if (exists) {
                        await fs.rm(box.metadata_file_path);
                    } else {
                        this.logger.debug(`Metadata file for box #${box.id} already removed or does not exist: ${box.metadata_file_path}`);
                    }
                } catch (e) {
                    this.logger.error(`Failed to remove the metadata file of box #${box.id} at ${box.metadata_file_path}. Error: ${e.message}`);
                }
            })
        );
    }
}

module.exports = {
    Job,
};