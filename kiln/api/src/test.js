const fetch = require("node-fetch");
const config = require("./config");
const Logger = require("logplease");
const logger = Logger.create("selfcurl");

async function selfCurl(endpoint, method = "POST", data = {}) {
	const port = config.bind_address.split(":")[1];
	const url = `http://localhost:${port}${endpoint}`;

	try {
		const response = await fetch(url, {
			method: method,
			headers: {
				"Content-Type": "application/json",
				Accept: "*/*",
				Origin: `http://localhost:${port}`,
			},
			body: JSON.stringify(data),
		});

		return await response.json();
	} catch (error) {
		logger.error("Self-curl request failed:", error);
		throw error;
	}
}

async function test() {
	logger.info("Waiting 10 seconds before starting tests...");
	await new Promise((resolve) => setTimeout(resolve, 10000));
	logger.info("Starting tests...");

	// Test case 1: Install node package
	try {
		const result = await selfCurl("/api/v2/packages", "POST", {
			language: "node",
			version: "20.11.1",
		});
		logger.info("Package installation test result:", result);
	} catch (error) {
		logger.error("Package installation test failed:", error);
	}

	// Test case x: Install Streamlit 3.11.0
	try {
		const result = await selfCurl("/api/v2/packages", "POST", {
			language: "streamlit",
			version: "3.11.0",
		});
		logger.info("Package installation test result:", result);
	} catch (error) {
		logger.error("Package installation test failed:", error);
	}

	// Test case 2: Install Python 3.11.11
	try {
		const result = await selfCurl("/api/v2/packages", "POST", {
			language: "python",
			version: "3.11.11",
		});
		logger.info("Package installation test result:", result);
	} catch (error) {
		logger.error("Package installation test failed:", error);
	}

	// Test case 3: Install Python 3.12.8
	try {
		const result = await selfCurl("/api/v2/packages", "POST", {
			language: "python",
			version: "3.12.8",
		});
		logger.info("Package installation test result:", result);
	} catch (error) {
		logger.error("Package installation test failed:", error);
	}

	// Test case 4: Install Python 3.13.1
	try {
		const result = await selfCurl("/api/v2/packages", "POST", {
			language: "python",
			version: "3.13.1",
		});
		logger.info("Package installation test result:", result);
	} catch (error) {
		logger.error("Package installation test failed:", error);
	}

	// Test case 5: Execute code
	try {
		const result = await selfCurl("/api/v2/execute", "POST", {
			language: "python",
			version: "3.11.11",
			files: [
				{
					name: "app",
					content: "print('Try Royksopp!')",
				},
			],
			stdin: "",
			args: [""],
		});
		logger.info("Code execution test result:", result);
	} catch (error) {
		logger.error("Code execution test failed:", error);
	}

	// Test case 6: Install dependencies and execute code
	try {
		const result = await selfCurl("/api/v2/execute", "POST", {
			language: "python",
			version: "3.11.11",
			files: [
				{
					name: "app",
					content: "import requests; print(requests.get('https://www.google.com').text)",
				},
			],
			stdin: "",
			args: [""],
			dependencies: ["requests"],
		});
		logger.info("Code execution test result:", result);
	} catch (error) {
		logger.error("Code execution test failed:", error);
	}
}

module.exports = { test };
