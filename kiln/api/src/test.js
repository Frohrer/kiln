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

async function test() {
	try {
		// First create Python runtime image
		logger.info("Creating Python runtime image...");
		const pythonImage = await selfCurl("/api/v2/images", "POST", {
			language: "python",
			version: "3.8",
			files: [
				{
					name: "requirements.txt",
					content: "# Base Python requirements\n"
				}
			]
		});

		logger.info("Python runtime image creation result:", pythonImage);

		// Wait a bit for the image to be ready
		await new Promise(resolve => setTimeout(resolve, 5000));

		// Now test execution
		logger.info("Testing code execution...");
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
