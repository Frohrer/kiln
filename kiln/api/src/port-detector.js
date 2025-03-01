const cp = require("child_process");
const logger = require("logplease").create("port-detector");

class PortDetector {
	constructor() {
		this.logger = logger;
	}

	async detectPort(vmId) {
		try {
			// Run netstat inside the VM to detect listening ports
			const result = await new Promise((resolve, reject) => {
				cp.exec(`netstat -tlpn`, (error, stdout, stderr) => {
					if (error) {
						reject(error);
						return;
					}
					resolve(stdout);
				});
			});

			// Parse netstat output to find listening ports
			const lines = result.split("\n");
			for (const line of lines) {
				if (line.includes("LISTEN")) {
					const parts = line.trim().split(/\s+/);
					const address = parts[3];
					if (address.endsWith(":80") || address.endsWith(":8000") || address.endsWith(":8080")) {
						return parseInt(address.split(":").pop());
					}
				}
			}
		} catch (error) {
			this.logger.error(`Error detecting port: ${error}`);
		}
		return null;
	}
}

module.exports = new PortDetector();
