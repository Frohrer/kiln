# Kiln MCP Server

A Model Context Protocol (MCP) server implementation for the Kiln code execution platform. This server provides the same functionality as the original Kiln API but using the MCP standard for improved interoperability with AI tools and clients.

## What is MCP?

The [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) is a standard for LLM-powered applications to communicate with servers that provide tools, resources, and other capabilities. MCP allows AI models to interact with code execution engines like Kiln in a standardized way.

## Features

- **Code Execution**: Run code in various programming languages
- **Process Management**: Monitor, inspect, and terminate running processes
- **Package Management**: Install and uninstall language packages
- **Runtime Information**: List available language runtimes
- **Streaming Output**: Stream execution output in real-time
- **Web App Support**: Run web applications and expose them through proxies

## Installation

### Standalone Installation

```bash
# Clone the repository
git clone https://github.com/your-org/kiln-mcp.git
cd kiln-mcp

# Install dependencies
npm install
```

### Docker Installation

The MCP server is included in the Docker Compose configuration and can be run alongside the other Kiln services:

```bash
# Start all services including the MCP server
docker-compose up -d

# Start only the MCP server
docker-compose up -d mcp
```

## Usage

### Standalone Usage

```bash
# Start the MCP server
npm start
```

The server will start on port 3000 by default. You can change the port by setting the `PORT` environment variable.

### Docker Usage

When using Docker Compose, the MCP server will be available at:

```
http://localhost:3000
```

You can check the server status with:

```bash
# Check if the MCP server is running
curl http://localhost:3000/mcp-info
```

## MCP Tools

The server provides the following MCP tools:

- `execute_code`: Execute code in various programming languages
- `list_runtimes`: Get a list of available programming language runtimes
- `list_processes`: Get a list of all running and completed processes
- `get_process`: Get details about a specific process by ID
- `terminate_process`: Terminate a running process by ID
- `get_process_logs`: Get logs for a specific process by ID
- `list_packages`: Get a list of available packages
- `install_package`: Install a specific package
- `uninstall_package`: Uninstall a specific package

## API Endpoints

- `GET /mcp-info`: Get information about the MCP server and available tools

## Environment Variables

- `PORT`: The port to run the server on (default: 3000)
- `KILN_RUN_TIMEOUT`: Maximum execution timeout in milliseconds (default: 300000)
- `KILN_LOG_LEVEL`: Log level for the application (default: INFO)
- `KILN_MAX_FILE_SIZE`: Maximum file size in bytes (default: 500000000)
- `KILN_PROXY_DOMAIN`: Domain for proxying web applications

## Compatible MCP Clients

This server is compatible with any MCP-compliant client, including:

- Claude Desktop App
- Cursor
- Continue
- VS Code GitHub Copilot
- And many more - see the [full list of MCP clients](https://modelcontextprotocol.io/clients)

## License

MIT 