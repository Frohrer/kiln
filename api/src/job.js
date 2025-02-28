const logplease = require("logplease");
const { v4: uuidv4 } = require("uuid");
const cp = require("child_process");
const path = require("path");
const config = require("./config");
const fs = require("fs/promises");
const globals = require("./globals");
const { sandboxPool } = require("./sandbox-pool");

const job_states = {
    READY: Symbol("Ready to be primed"),
    PRIMED: Symbol("Primed and ready for execution"),
    EXECUTED: Symbol("Executed and ready for cleanup"),
};

const ISOLATE_PATH = "/usr/local/bin/isolate";
let remaining_job_spaces = config.max_concurrent_jobs;
let job_queue = [];

class Job {
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
        this.activeBox = null;
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

    async prime() {
        if (remaining_job_spaces < 1) {
            this.logger.info(`Awaiting job slot`);
            await new Promise((resolve) => {
                job_queue.push(resolve);
            });
        }
        this.logger.info(`Priming job`);
        remaining_job_spaces--;
        
        // Get a box from the pool instead of creating a new one
        this.logger.debug("Acquiring sandbox from pool");
        const box = await sandboxPool.acquireBox();
        this.activeBox = box;

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
                    kiln_LANGUAGE: this.runtime.language,
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

        proc.stdout.on("data", (data) => {
            const str = data.toString();
            stdout += str;
            output += str;
            if (event_bus) event_bus.emit("stdout", str);
        });

        proc.stderr.on("data", (data) => {
            const str = data.toString();
            stderr += str;
            output += str;
            if (event_bus) event_bus.emit("stderr", str);
        });

        await new Promise((resolve, reject) => {
            proc.on("error", reject);
            proc.on("exit", resolve);
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
            stdout,
            stderr,
            output,
            memory,
            code,
            signal,
            message,
            status,
            cpu_time: cpu_time_stat,
            wall_time: wall_time_stat,
            error: signal !== null || code !== 0,
        };
    }

    async cleanup() {
        this.logger.info(`Cleaning up job`);

        remaining_job_spaces++;
        if (job_queue.length > 0) {
            job_queue.shift()();
        }

        if (this.activeBox) {
            // Release the box back to the pool instead of destroying it
            await sandboxPool.releaseBox(this.activeBox);
            this.activeBox = null;
        }
    }
}

module.exports = { Job }; 