// Initialize Ace editor
const editor = ace.edit("editor");
editor.setTheme("ace/theme/monokai");
editor.session.setMode("ace/mode/python");
editor.setFontSize(14);

// Store available runtimes
let availableRuntimes = [];

// Function to load available runtimes
async function loadRuntimes() {
    try {
        const response = await fetch('/api/runtimes');
        const data = await response.json();
        availableRuntimes = data.runtimes;

        const languageSelect = document.getElementById('languageSelect');
        languageSelect.innerHTML = '<option value="" selected disabled>Select Language</option>';

        // Group runtimes by language
        const runtimesByLanguage = availableRuntimes.reduce((acc, runtime) => {
            if (!acc[runtime.language]) {
                acc[runtime.language] = [];
            }
            acc[runtime.language].push(runtime);
            return acc;
        }, {});

        // Create optgroups for each language
        Object.entries(runtimesByLanguage).forEach(([language, runtimes]) => {
            const optgroup = document.createElement('optgroup');
            optgroup.label = language.charAt(0).toUpperCase() + language.slice(1);

            // Sort versions in descending order
            runtimes.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));

            runtimes.forEach(runtime => {
                const option = document.createElement('option');
                option.value = `${runtime.language}-${runtime.version}`;
                option.textContent = `${runtime.version}${runtime.available ? '' : ' (No Image)'}`;
                option.disabled = !runtime.available;
                if (runtime.available) {
                    option.title = `Memory: ${runtime.limits.memory.run}MB, CPU: ${runtime.limits.cpu.run}s`;
                } else {
                    option.title = 'VM image not available';
                }
                optgroup.appendChild(option);
            });

            languageSelect.appendChild(optgroup);
        });

        // Set editor mode based on selected language
        languageSelect.addEventListener('change', (e) => {
            const [language] = e.target.value.split('-');
            const modeMap = {
                'python': 'python',
                'nodejs': 'javascript',
                'streamlit': 'python'
            };
            editor.session.setMode(`ace/mode/${modeMap[language] || 'text'}`);
        });
    } catch (error) {
        console.error('Error loading runtimes:', error);
        document.getElementById('languageSelect').innerHTML = '<option value="" disabled>Error loading runtimes</option>';
    }
}

// Function to run code
async function runCode() {
    const runButton = document.getElementById('runCode');
    const outputDiv = document.getElementById('output');
    const spinner = document.getElementById('outputSpinner');
    const webAppUrlContainer = document.getElementById('webAppUrlContainer');
    const executionDetails = document.getElementById('executionDetails');

    const runtime = document.getElementById('languageSelect').value;
    if (!runtime) {
        alert('Please select a runtime');
        return;
    }

    const [language, version] = runtime.split('-');
    const code = editor.getValue();

    // Disable run button and show spinner
    runButton.disabled = true;
    spinner.classList.remove('d-none');
    outputDiv.textContent = 'Running...';
    webAppUrlContainer.classList.add('d-none');
    executionDetails.classList.add('d-none');

    try {
        const response = await fetch('/api/execute', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                language,
                version,
                files: [{
                    name: 'main.py',
                    content: code
                }]
            })
        });

        const result = await response.json();

        if (result.error) {
            outputDiv.textContent = `Error: ${result.error}`;
            return;
        }

        // Display output
        let output = '';
        if (result.stages) {
            if (result.stages.install) {
                output += '=== Installation Output ===\n';
                output += result.stages.install.stdout || '';
                output += result.stages.install.stderr || '';
                output += '\n';
            }
            if (result.stages.execute) {
                output += '=== Execution Output ===\n';
                output += result.stages.execute.stdout || '';
                output += result.stages.execute.stderr || '';
            }
        }
        outputDiv.textContent = output;

        // Show web app URL if available
        if (result.webAppUrl) {
            webAppUrlContainer.classList.remove('d-none');
            const urlText = webAppUrlContainer.querySelector('.url-text');
            const urlLink = webAppUrlContainer.querySelector('#webAppUrl');
            urlText.textContent = result.webAppUrl;
            urlLink.href = result.webAppUrl;
        }

        // Show execution details
        if (result.timing) {
            executionDetails.classList.remove('d-none');
            document.getElementById('totalDuration').textContent = `${result.timing.total_duration.toFixed(2)}s`;
            document.getElementById('cpuTime').textContent = `${result.timing.cpu_time.toFixed(2)}s`;
            document.getElementById('memoryUsage').textContent = `${(result.timing.memory_usage / 1024 / 1024).toFixed(2)}MB`;

            // Update stage metrics
            if (result.stages.install) {
                document.getElementById('installMetrics').textContent = JSON.stringify(result.stages.install, null, 2);
            }
            if (result.stages.execute) {
                document.getElementById('executeMetrics').textContent = JSON.stringify(result.stages.execute, null, 2);
            }
        }
    } catch (error) {
        console.error('Error running code:', error);
        outputDiv.textContent = `Error: ${error.message}`;
    } finally {
        // Re-enable run button and hide spinner
        runButton.disabled = false;
        spinner.classList.add('d-none');
    }
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
    loadRuntimes();
    document.getElementById('runCode').addEventListener('click', runCode);
});