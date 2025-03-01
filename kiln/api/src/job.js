const cp = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const logger = require("logplease").create("job");

class Job {
    constructor(options) {
        this.runtime = options.runtime;
        this.files = options.files;
        this.args = options.args || [];
        this.stdin = options.stdin || "";
        this.timeouts = options.timeouts || { compile: 10000, run: 10000 };
        this.cpu_times = options.cpu_times || { compile: 10000, run: 10000 };
        this.memory_limits = options.memory_limits || { compile: 512, run: 512 };
        this.dependencies = options.dependencies || [];
        this.uuid = uuidv4();
        this.startTime = Date.now();
        this.logger = logger;
    }

    async execute(event_bus = null) {
        throw new Error("execute() must be implemented by subclasses");
    }

    async cleanup() {
        // Cleanup will be handled by subclasses
    }
}

module.exports = {
    Job
};