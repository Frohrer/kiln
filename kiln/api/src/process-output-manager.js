const EventEmitter = require("events");

class ProcessOutputManager {
	constructor() {
		this.outputs = new Map(); // jobId -> {stdout: string[], stderr: string[], errors: string[], timing: string[], subscribers: Set}
		this.MAX_OUTPUT_LENGTH = 1000; // Maximum number of lines to keep in memory
	}

	initializeProcess(jobId) {
		if (!this.outputs.has(jobId)) {
			this.outputs.set(jobId, {
				stdout: [],
				stderr: [],
				errors: [],
				timing: [], // Add timing array
				subscribers: new Set(),
				emitter: new EventEmitter(),
			});
		}
		return this.outputs.get(jobId);
	}

	addOutput(jobId, type, data) {
		const process = this.initializeProcess(jobId);
		const lines = data
			.toString()
			.split("\n")
			.filter((line) => line.length > 0);

		// Add to appropriate output buffer
		if (type === "error") {
			process.errors.push(...lines);
			if (process.errors.length > this.MAX_OUTPUT_LENGTH) {
				process.errors = process.errors.slice(-this.MAX_OUTPUT_LENGTH);
			}
		} else {
			process[type].push(...lines);
			if (process[type].length > this.MAX_OUTPUT_LENGTH) {
				process[type] = process[type].slice(-this.MAX_OUTPUT_LENGTH);
			}
		}

		// Notify all subscribers
		process.emitter.emit("output", {
			type,
			data: lines.join("\n"),
		});
	}

	subscribeToProcess(jobId, callback) {
		const process = this.initializeProcess(jobId);
		process.subscribers.add(callback);
		process.emitter.on("output", callback);

		// Send existing output immediately
		for (const type of ['stdout', 'stderr', 'timing', 'errors']) {
			if (process[type] && process[type].length > 0) {
				callback({
					type,
					data: process[type].join("\n"),
				});
			}
		}

		return () => {
			process.subscribers.delete(callback);
			process.emitter.removeListener("output", callback);
		};
	}

	getProcessOutput(jobId) {
		const process = this.outputs.get(jobId);
		if (!process) return null;

		return {
			stdout: process.stdout.join("\n"),
			stderr: process.stderr.join("\n"),
			errors: process.errors.join("\n"),
			timing: process.timing.join("\n")
		};
	}

	getOutputs(jobId) {
		const process = this.outputs.get(jobId);
		if (!process) return [];

		const outputs = [];
		for (const type of ['stdout', 'stderr', 'timing', 'errors']) {
			if (process[type]) {
				outputs.push(...process[type].map(content => ({
					type,
					content
				})));
			}
		}
		return outputs;
	}

	clearProcess(jobId) {
		const process = this.outputs.get(jobId);
		if (process) {
			process.emitter.removeAllListeners();
			this.outputs.delete(jobId);
		}
	}
}

// Create singleton instance
const processOutputManager = new ProcessOutputManager();
module.exports = { processOutputManager };
