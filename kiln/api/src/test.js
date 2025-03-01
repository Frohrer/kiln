const http = require("http");
const logger = require("logplease").create("test");

async function selfCurl(path, method = "GET", body = null) {
	return new Promise((resolve, reject) => {
		const options = {
			hostname: "localhost",
			port: 2000,
			path,
			method,
			headers: {
				"Content-Type": "application/json",
			},
		};

		const req = http.request(options, (res) => {
			let data = "";

			res.on("data", (chunk) => {
				data += chunk;
			});

			res.on("end", () => {
				resolve({
					status: res.statusCode,
					data: JSON.parse(data),
				});
			});
		});

		req.on("error", (error) => {
			reject(error);
		});

		if (body) {
			req.write(JSON.stringify(body));
		}

		req.end();
	});
}

// Rename main to test and export it
async function test() {
	try {
		// Test execution endpoints
		const result = await selfCurl("/api/v2/execute", "POST", {
			language: "python",
			version: "3.8",
			files: [
				{
					name: "test.py",
					content: 'print("Hello, World!")',
				},
			],
		});

		logger.info("Test execution result:", result);

		// Test VM image endpoints
		const imageResult = await selfCurl("/api/v2/images", "POST", {
			language: "python",
			version: "3.8",
			files: [
				{
					name: "app.py",
					content: 'print("Test VM")',
				},
			],
		});

		logger.info("Test VM image creation:", imageResult);

		// List images
		const images = await selfCurl("/api/v2/images");
		logger.info("Available images:", images);

		process.exit(0);
	} catch (error) {
		logger.error("Test failed:", error);
		process.exit(1);
	}
}

// Export the test function
module.exports = { test };

// Run test if this is the main module
if (require.main === module) {
	test();
}
