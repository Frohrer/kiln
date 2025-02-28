const fetch = require("node-fetch");
const config = require("./config");
const Logger = require("logplease");
const logger = Logger.create("selfcurl");
const { Job } = require('./job');
const { Runtime } = require('./runtime');

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
					name: "app.py",
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
}

async function testPackageCaching() {
	// Create a Python runtime
	const runtime = new Runtime('python', '3.12.8');

	// Test script that uses requests
	const testCode = `
import requests
response = requests.get('https://httpbin.org/get')
print(response.json())
	`.trim();

	// Create and run first job
	console.log('First run - should install requests from PyPI:');
	const job1 = new Job({
		runtime,
		files: [{ name: 'test.py', content: testCode }],
		args: [],
		stdin: '',
		timeouts: { compile: 10000, run: 10000 },
		cpu_times: { compile: 10000, run: 10000 },
		memory_limits: { compile: -1, run: -1 },
		dependencies: ['requests']
	});

	const box1 = await job1.prime();
	const result1 = await job1.execute(box1);
	console.log('First run output:', result1.run.stdout);
	await job1.cleanup();

	// Wait a bit
	await new Promise(resolve => setTimeout(resolve, 1000));

	// Create and run second job
	console.log('\nSecond run - should use cached requests package:');
	const job2 = new Job({
		runtime,
		files: [{ name: 'test.py', content: testCode }],
		args: [],
		stdin: '',
		timeouts: { compile: 10000, run: 10000 },
		cpu_times: { compile: 10000, run: 10000 },
		memory_limits: { compile: -1, run: -1 },
		dependencies: ['requests']
	});

	const box2 = await job2.prime();
	const result2 = await job2.execute(box2);
	console.log('Second run output:', result2.run.stdout);
	await job2.cleanup();
}

// Run the test
testPackageCaching().catch(console.error);

module.exports = { test };
