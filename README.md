# Claude Code ACP Server

A bridge server that enables Claude Code functionality in Zed editor through the Agent Client Protocol (ACP).

## Features

Currently supported:

- Claude Code tools (Glob, Grep, LS, Read, Write, Edit, MultiEdit, etc.)
- Todo list management with visual progress tracking
- File operations and code analysis
- Text, Image, Resource, Resource Link content blocks
- Thinking blocks with timing display
- Session cancellation support
- Permission mode configuration on startup

Missing/Coming Soon:

- Interactive permissions control (blocked until Claude Code supports stdio-based permission prompts)
- Audio content blocks
- Session load operations
- Performance improvements
- Authentication

## Prerequisites

- [Bun](https://bun.sh/) - JavaScript runtime and package manager
- Claude Code installed and visible on PATH and already logged in

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
         "args": [
           "/path/to/claude-code-acp/server.ts",
           "--permission-mode",
           "acceptEdits"
         ]
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
         "command": "/path/to/claude-code-acp/dist/server",
         "args": ["--permission-mode", "acceptEdits"]
       }
     }
   }
   ```

## Development

- `bun run dev` - Start the development server
- `bun run test` - Run tests
- `bun run build` - Build the server binary

## Permissions

The server supports Claude Code's permission modes through the `--permission-mode` flag:

- `acceptEdits` - Automatically accept all edit operations
- `bypassPermissions` - Bypass all permission prompts
- `default` - Use Claude Code's default permission behavior
- `plan` - Use planning mode

**Note:** Interactive permission control (like `/permissions` command) is not currently supported when Claude Code runs via stdio. This is a limitation of Claude Code itself - permission prompts require TTY interaction which is not available in the stdio channel. Until Claude Code adds support for stdio-based permission management, you must configure permissions via the `--permission-mode` flag at startup.

## Debugging

The server supports debug logging and permission configuration with command-line flags:

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
