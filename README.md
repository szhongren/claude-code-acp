# Claude Code ACP Server![2025-08-30 02 26 17](https://github.com/user-attachments/assets/6812b5a1-3dbe-4bd3-8555-758ab14f98f5)


🚀 **Bring the power of Claude Code directly to your Zed editor!** This bridge server seamlessly integrates Claude Code's advanced AI capabilities with Zed through the Agent Client Protocol (ACP), giving you an intelligent coding assistant right in your favorite editor.

## ✨ Features

**Already available:**

- 🛠️ Full Claude Code tool suite (Glob, Grep, LS, Read, Write, Edit, MultiEdit, and more)
- 📋 Interactive todo list management with visual progress tracking
- 📁 Comprehensive file operations and intelligent code analysis
- 🖼️ Rich content support (text, images, resources, and resource links)
- 💭 Thinking blocks
- ⚡ Session cancellation and interruption support
- 🔒 Flexible permission mode configuration
- ✏️ **Native Zed diff integration** - See exactly what changes are being applied with beautiful, native diffs for all edits and writes

**Coming soon:**

- 🎛️ **Granular permissions management** - Fine-tuned control over what Claude can and cannot do
- 🎵 Audio content block support
- 📊 Session load and restore operations
- ⚡ Enhanced performance optimizations
- 🔐 Authentication and security improvements

## Prerequisites

- [Bun](https://bun.sh/) - JavaScript runtime and package manager
- Claude Code installed and visible on PATH and already logged in

## Binary Installation (Only for Apple Silicon, no bun required)

1. Download the latest release from the [releases page](https://github.com/szhongren/claude-code-acp/releases).
2. Place the `ccacp-arm64` binary in a directory on your PATH.
3. Add the following configuration to your Zed settings (`~/.config/zed/settings.json`):
   ```json
   {
     "agent_servers": {
       "claudecode": {
         "command": "ccacp-arm64",
         "args": ["--permission-mode", "acceptEdits"]
       }
     }
   }
   ```

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
         "command": "/path/to/claude-code-acp/dist/ccacp",
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

The server supports flexible permission management through the `--permission-mode` flag:

- `acceptEdits` - Automatically accept all edit operations
- `bypassPermissions` - Bypass all permission prompts
- `default` - Use Claude Code's default permission behavior
- `plan` - Use planning mode

Configure permissions at startup to match your workflow preferences. Granular permission management with runtime controls is coming soon!

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
