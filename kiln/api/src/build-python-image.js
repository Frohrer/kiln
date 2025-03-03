const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

async function buildPythonImage() {
    try {
        console.log('Building Python 3.12.8 image using Docker...');
        
        // Create a temporary directory for the build
        const tempDir = path.join(__dirname, 'temp-build');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }

        // Create a simple Python file
        const pythonFile = path.join(tempDir, 'main.py');
        fs.writeFileSync(pythonFile, 'print("Hello from Python 3.12.8!")');

        // Build the image using docker-compose
        execSync('docker-compose build api', { stdio: 'inherit' });
        
        // Clean up
        fs.rmSync(tempDir, { recursive: true, force: true });
        
        console.log('Image built successfully!');
    } catch (error) {
        console.error('Failed to build image:', error);
        process.exit(1);
    }
}

buildPythonImage(); 