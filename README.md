# Claude Code ACP Server

A bridge server that enables Claude Code functionality in Zed editor through the Agent Client Protocol (ACP).

## Features

Currently supported:

- Claude Code tools (Glob, Grep, LS)
- Todo list management
- File reads and code analysis
- Text, Image, Resource, Resource Link content blocks

Missing/Coming Soon:

- Writes, Edits (coming soon)
- Permissions system
- Audio content blocks
- Session load/cancel operations

## Prerequisites

- [Bun](https://bun.sh/) - JavaScript runtime and package manager
- Claude Code installed and visible on PATH
- An Anthropic API key for Claude, or Claude subscription

## Installation

### Option 1: Run from source (recommended for development)

1. Clone this repository:

   ```bash
   git clone https://github.com/szhongren/claude-code-acp.git
   cd claude-code-acp
   ```

2. Install dependencies:

   ```bash
   bun install
   ```

3. Add the following configuration to your Zed settings (`~/.config/zed/settings.json`):
   ```json
   {
     "agent_servers": {
       "claudecode": {
         "command": "bun",
         "args": ["/path/to/claude-code-acp/server.ts"]
       }
     }
   }
   ```

### Option 2: Build and run binary

1. Build the server:

   ```bash
   bun run build
   ```

2. Add the following configuration to your Zed settings:
   ```json
   {
     "agent_servers": {
       "claudecode": {
         "command": "/path/to/claude-code-acp/dist/server"
       }
     }
   }
   ```

## Configuration

Make sure you are already logged into Claude Code

## Development

- `bun run dev` - Start the development server
- `bun run test` - Run tests
- `bun run build` - Build the server binary

## Debugging

The server supports debug logging with command-line flags:

- `--debug` - Enable debug logging to stderr
- `--log-file <path>` - Write logs to specified file

Example with debugging enabled:

```json
{
  "agent_servers": {
    "claudecode": {
      "command": "bun",
      "args": [
        "/path/to/claude-code-acp/server.ts",
        "--debug",
        "--log-file",
        "/path/to/claude-code-acp/server.log"
      ]
    }
  }
}
```

## Usage

Once configured in Zed, you can access Claude Code functionality through the agent interface in your editor.
