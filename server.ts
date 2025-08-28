#!/usr/bin/env bun

import {
  AgentSideConnection,
  type Agent,
  PROTOCOL_VERSION,
} from "@zed-industries/agent-client-protocol";
import * as schema from "@zed-industries/agent-client-protocol";
import { WritableStream, ReadableStream } from "node:stream/web";
import { Readable, Writable } from "node:stream";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

interface AgentSession {
  claudeSessionId: string | null;
  pendingPrompt: AbortController | null;
  promptResolver: ((response: schema.PromptResponse) => void) | null;
  pendingToolUses: Map<
    string,
    { toolCallId: string; name: string; input: any }
  >;
}

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

interface LoggerConfig {
  debug: boolean;
  logFile: string | null;
}

class Logger {
  private config: LoggerConfig;

  constructor(config: LoggerConfig) {
    this.config = config;
  }

  private async writeLog(message: string): Promise<void> {
    // Only log if debug or logFile is set
    if (!this.config.debug && !this.config.logFile) return;

    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;

    try {
      // Log to stderr if debug is enabled
      if (this.config.debug) {
        process.stderr.write(logLine);
      }

      // Log to file if logFile is set
      if (this.config.logFile) {
        await mkdir(dirname(this.config.logFile), { recursive: true });
        await appendFile(this.config.logFile, logLine);
      }
    } catch (error) {
      // Fallback to stderr if file write fails
      process.stderr.write(
        `[LOG ERROR] Failed to write to log file: ${error}\n`
      );
      if (this.config.debug) {
        process.stderr.write(logLine);
      }
    }
  }

  async logClientMessage(
    direction: "RECV" | "SEND",
    message: string
  ): Promise<void> {
    try {
      const parsed = JSON.parse(message);
      const prettyJson = JSON.stringify(parsed, null, 2);
      await this.writeLog(`CLIENT ${direction}:\n${prettyJson}`);
    } catch (error) {
      await this.writeLog(`CLIENT ${direction} (invalid JSON): ${message}`);
    }
  }

  async logClaudeMessage(
    direction: "RECV" | "SEND",
    message: string
  ): Promise<void> {
    try {
      const parsed = JSON.parse(message);
      const prettyJson = JSON.stringify(parsed, null, 2);
      await this.writeLog(`CLAUDE ${direction}:\n${prettyJson}`);
    } catch (error) {
      await this.writeLog(`CLAUDE ${direction} (invalid JSON): ${message}`);
    }
  }

  async logInfo(message: string): Promise<void> {
    await this.writeLog(`INFO: ${message}`);
  }

  async logError(message: string): Promise<void> {
    await this.writeLog(`ERROR: ${message}`);
  }
}

class ClaudeCodeAgent implements Agent {
  private connection: AgentSideConnection;
  private sessions = new Map<string, AgentSession>();
  private claudeProcess: Bun.Subprocess | null = null;
  private claudeSessionToClientSession = new Map<string, string>();
  private clientCapabilities: any = null;
  private logger: Logger;

  constructor(connection: AgentSideConnection, logger: Logger) {
    this.connection = connection;
    this.logger = logger;
    this.startClaudeProcess();
  }

  private async startClaudeProcess(): Promise<void> {
    try {
      await this.logger.logInfo("Starting Claude process");
      this.claudeProcess = Bun.spawn(
        [
          "claude",
          "-p",
          "--input-format=stream-json",
          "--output-format=stream-json",
          "--verbose",
        ],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      this.readClaudeOutput();
    } catch (error) {
      await this.logger.logError(`Failed to start Claude: ${error}`);
      console.error("Failed to start Claude:", error);
    }
  }

  private async readClaudeOutput(): Promise<void> {
    if (!this.claudeProcess?.stdout) return;

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      const reader = this.claudeProcess.stdout.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunkStr = decoder.decode(value, { stream: true });
        buffer += chunkStr;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            await this.logger.logClaudeMessage("RECV", line.trim());
            try {
              const parsed = JSON.parse(line);
              await this.processClaudeMessage(parsed);
            } catch (error) {
              await this.logger.logError(`Claude parse error: ${error}`);
              console.error("Claude parse error:", error);
            }
          }
        }
      }
    } catch (error) {
      await this.logger.logError(`Claude output error: ${error}`);
      console.error("Claude output error:", error);
    }
  }

  private async processClaudeMessage(claudeMessage: any): Promise<void> {
    // Map Claude session to client session
    const claudeSessionId = claudeMessage.session_id;
    const clientSessionId =
      this.claudeSessionToClientSession.get(claudeSessionId);

    if (!clientSessionId) {
      // Handle session creation
      if (claudeSessionId) {
        const pendingSession = Array.from(this.sessions.entries()).find(
          ([_, session]) => session.claudeSessionId === null
        );

        if (pendingSession) {
          const [sessionId, session] = pendingSession;
          session.claudeSessionId = claudeSessionId;
          this.claudeSessionToClientSession.set(claudeSessionId, sessionId);
          await this.logger.logInfo(
            `Mapped Claude session ${claudeSessionId} to client session ${sessionId}`
          );
        }
      }

      // For system messages, we still want to process them after mapping
      if (claudeMessage.type === "system") {
        const newClientSessionId =
          this.claudeSessionToClientSession.get(claudeSessionId);
        if (newClientSessionId) {
          // Process system message - this is where Claude tells us about available tools
          await this.logger.logInfo(
            `System message for session ${newClientSessionId}: ${
              claudeMessage.subtype || "unknown"
            }`
          );
        }
      }

      return;
    }

    // Handle assistant messages
    if (claudeMessage.type === "assistant") {
      await this.handleAssistantMessage(clientSessionId, claudeMessage);
    }

    // Handle tool result messages (when Claude receives tool results)
    if (
      claudeMessage.type === "user" &&
      claudeMessage.message?.content?.[0]?.type === "tool_result"
    ) {
      await this.handleToolResultMessage(clientSessionId, claudeMessage);
    }

    // Handle result messages (end of conversation turn)
    if (claudeMessage.type === "result") {
      await this.handleResultMessage(clientSessionId, claudeMessage);
    }
  }

  private async handleAssistantMessage(
    sessionId: string,
    claudeMessage: any
  ): Promise<void> {
    const content = claudeMessage.message?.content;
    if (!Array.isArray(content)) return;

    for (const item of content) {
      if (item.type === "tool_use") {
        await this.handleToolUse(sessionId, item);
      } else if (item.type === "text") {
        await this.handleTextMessage(sessionId, item);
      }
    }
  }

  private async handleToolUse(sessionId: string, toolUse: any): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const toolCallId = toolUse.id; // Use Claude's tool_use_id directly

    // Track this pending tool use
    session.pendingToolUses.set(toolUse.id, {
      toolCallId,
      name: toolUse.name,
      input: toolUse.input,
    });

    await this.logger.logInfo(
      `Tool use started: ${toolUse.name} (${toolUse.id})`
    );

    const toolMappings = {
      Task: "other",
      Bash: "execute",
      Glob: "search",
      Grep: "search",
      LS: "read",
      ExitPlanMode: "other",
      Read: "read",
      Edit: "edit",
      MultiEdit: "edit",
      Write: "edit",
      NotebookEdit: "edit",
      WebFetch: "fetch",
      WebSearch: "search",
      BashOutput: "other",
      KillBash: "other",
    };
    // Send tool_call notification to client - just report what Claude requested
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: `${toolUse.name}(${JSON.stringify(toolUse.input)})`,
        kind: toolMappings[toolUse.name],
        status: "pending",
        rawInput: toolUse.input,
      },
    });

    // Special handling for TodoWrite since we can process it locally
    if (toolUse.name === "TodoWrite") {
      await this.executeTodoWriteTool(sessionId, toolUse);
    }

    // Note: We don't send tool results back to Claude here - Claude handles its own tools
    // We just report the tool usage to the client for visibility
  }

  private async handleToolResultMessage(
    sessionId: string,
    claudeMessage: any
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const toolResult = claudeMessage.message.content[0];
    const toolUseId = toolResult.tool_use_id;

    const pendingTool = session.pendingToolUses.get(toolUseId);
    if (!pendingTool) {
      await this.logger.logInfo(
        `Received tool result for unknown tool: ${toolUseId}`
      );
      return;
    }

    await this.logger.logInfo(
      `Tool result received: ${pendingTool.name} (${toolUseId})`
    );

    // Send tool_call_update to client with the result from Claude
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: pendingTool.toolCallId,
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: toolResult.content,
            },
          },
        ],
      },
    });

    // Remove from pending tool uses
    session.pendingToolUses.delete(toolUseId);
    await this.logger.logInfo(
      `Tool use completed: ${pendingTool.name} (${toolUseId})`
    );
  }

  private async executeTodoWriteTool(
    sessionId: string,
    toolUse: any
  ): Promise<void> {
    const todos: TodoItem[] = toolUse.input.todos;

    const entries = todos.map((todo) => ({
      content: todo.content,
      priority: this.determinePriority(todo.content),
      status: todo.status,
    }));

    // Send plan update to client
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "plan",
        entries,
      },
    });
  }

  private async handleTextMessage(
    sessionId: string,
    textItem: any
  ): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: textItem.text,
        },
      },
    });
  }

  private async handleResultMessage(
    sessionId: string,
    resultMessage: any
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    await this.logger.logInfo(
      `Result message for session ${sessionId}, has resolver: ${!!session?.promptResolver}, pending tools: ${
        session?.pendingToolUses.size || 0
      }`
    );

    if (!session || !session.promptResolver) {
      await this.logger.logInfo(
        `No resolver found for session ${sessionId} - result message ignored`
      );
      return;
    }

    // Check if there are still pending tool uses
    if (session.pendingToolUses.size > 0) {
      await this.logger.logInfo(
        `Still have ${session.pendingToolUses.size} pending tool uses, not sending end_turn yet`
      );
      return;
    }

    // Resolve the pending prompt with the result
    const stopReason = resultMessage.is_error ? "max_tokens" : "end_turn";
    await this.logger.logInfo(
      `Resolving prompt for session ${sessionId} with stopReason: ${stopReason}`
    );
    session.promptResolver({
      stopReason,
    });

    // Clear the resolver
    session.promptResolver = null;
  }

  private determinePriority(content: string): "high" | "medium" | "low" {
    const contentLower = content.toLowerCase();

    if (
      contentLower.includes("error") ||
      contentLower.includes("fix") ||
      contentLower.includes("bug") ||
      contentLower.includes("critical")
    ) {
      return "high";
    }

    if (
      contentLower.includes("implement") ||
      contentLower.includes("add") ||
      contentLower.includes("create") ||
      contentLower.includes("build")
    ) {
      return "medium";
    }

    if (
      contentLower.includes("document") ||
      contentLower.includes("test") ||
      contentLower.includes("research") ||
      contentLower.includes("review")
    ) {
      return "low";
    }

    return "medium";
  }

  private async sendToClaude(message: any): Promise<void> {
    if (!this.claudeProcess?.stdin) return;

    try {
      const json = JSON.stringify(message) + "\n";
      await this.logger.logClaudeMessage("SEND", json.trim());
      (this.claudeProcess.stdin as any).write(json);
    } catch (error) {
      await this.logger.logError(`Failed to send to Claude: ${error}`);
      console.error("Failed to send to Claude:", error);
    }
  }

  async initialize(
    params: schema.InitializeRequest
  ): Promise<schema.InitializeResponse> {
    // Store client capabilities for later use
    this.clientCapabilities = params.clientCapabilities;

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
      },
    };
  }

  async newSession(
    params: schema.NewSessionRequest
  ): Promise<schema.NewSessionResponse> {
    const sessionId = crypto.randomUUID();

    this.sessions.set(sessionId, {
      claudeSessionId: null,
      pendingPrompt: null,
      promptResolver: null,
      pendingToolUses: new Map(),
    });

    // Claude session will be started when user sends first message

    return { sessionId };
  }

  async authenticate(params: schema.AuthenticateRequest): Promise<void> {
    // No authentication needed
  }

  async prompt(params: schema.PromptRequest): Promise<schema.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    session.pendingPrompt?.abort();
    session.pendingPrompt = new AbortController();

    // Initialize Claude session if this is the first message
    if (!session.claudeSessionId) {
      await logger.logClaudeMessage("SEND", `Initializing Claude session for session ${params.sessionId}`);
    }

    // Convert ACP content to Claude format, handling resource_links
    const claudeContent = [];

    for (const item of params.prompt) {
      if (item.type === "text") {
        claudeContent.push(item);
      } else if (item.type === "image") {
        claudeContent.push({
          type: "image",
          source: {
            data: item.data,
            media_type: item.mimeType,
            type: "base64",
          },
        });
      } else if (item.type === "resource_link") {
        // Check if client supports readTextFile
        if (this.clientCapabilities?.fs?.readTextFile) {
          try {
            // Make fs/read_text_file request to client
            const fileContent = await this.connection.readTextFile({
              sessionId: params.sessionId,
              path: item.uri.replace("file://", ""), // Convert file:// URI to path
              // Note: line and limit would come from item.annotations or be handled differently
              // For now, read the whole file
            });

            // Convert to text content for Claude
            claudeContent.push({
              type: "text",
              text: `File: ${item.uri}\n\`\`\`\n${fileContent.content}\n\`\`\``,
            });
          } catch (error) {
            console.error("Failed to read file:", error);
            // Fallback: pass resource_link through to Claude
            claudeContent.push(item);
          }
        } else {
          // Client doesn't support file reading, pass through
          claudeContent.push(item);
        }
      } else if (item.type === "resource") {
        // Resource type contains the content directly
        if ("text" in item.resource) {
          // Convert to document format for Claude
          claudeContent.push({
            type: "document",
            source: {
              data: item.resource.text,
              media_type: item.resource.mimeType || "text/plain",
              type: "text",
            },
          });
        } else if ("blob" in item.resource) {
          // Convert blob to document format for Claude
          claudeContent.push({
            type: "document",
            source: {
              data: item.resource.blob,
              media_type: item.resource.mimeType || "application/octet-stream",
              type: "base64",
            },
          });
        } else {
          // No content, pass through to Claude
          claudeContent.push(item);
        }
      }
    }

    // Send to Claude
    await this.sendToClaude({
      type: "user",
      message: {
        role: "user",
        content: claudeContent,
      },
    });

    // Wait for Claude to respond with a result message
    return new Promise<schema.PromptResponse>((resolve, reject) => {
      session.promptResolver = resolve;

      // Set up abort handling
      session.pendingPrompt?.signal.addEventListener("abort", () => {
        session.promptResolver = null;
        resolve({ stopReason: "cancelled" });
      });
    });
  }

  async cancel(params: schema.CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    session?.pendingPrompt?.abort();
  }
}

// Parse command line arguments
function parseArgs(): LoggerConfig {
  const args = process.argv.slice(2);
  let debug = false;
  let logFile: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--debug") {
      debug = true;
    } else if (args[i] === "--log-file" && i + 1 < args.length) {
      logFile = args[i + 1]!;
      i++; // skip the next argument since it's the log file path
    }
  }

  return { debug, logFile };
}

// Create logger
const loggerConfig = parseArgs();
const logger = new Logger(loggerConfig);

// Create logging wrapper for streams
class LoggingWritableStream extends WritableStream {
  constructor(originalStream: WritableStream, logger: Logger, debug: boolean) {
    super({
      write(chunk) {
        // Only decode and log if debug is enabled
        if (debug) {
          const message = new TextDecoder().decode(chunk);
          logger.logClientMessage("SEND", message.trim()).catch(() => {});
        }

        // Write to original stream
        const writer = originalStream.getWriter();
        return writer.write(chunk).finally(() => writer.releaseLock());
      },
    });
  }
}

function createLoggingReadableStream(
  originalStream: ReadableStream<Uint8Array>,
  logger: Logger,
  debug: boolean
): ReadableStream<Uint8Array> {
  const reader = originalStream.getReader();
  return new ReadableStream({
    start(controller) {
      function pump(): Promise<void> {
        return reader.read().then(({ done, value }) => {
          if (done) {
            controller.close();
            return;
          }

          // Only decode and log if debug is enabled
          if (debug) {
            const message = new TextDecoder().decode(value);
            logger.logClientMessage("RECV", message.trim()).catch(() => {});
          }

          controller.enqueue(value);
          return pump();
        });
      }
      return pump();
    },
  });
}

// Set up the connection with logging
const originalInput = Writable.toWeb(process.stdout) as WritableStream;
const originalOutput = Readable.toWeb(
  process.stdin
) as ReadableStream<Uint8Array>;

const input = new LoggingWritableStream(
  originalInput,
  logger,
  loggerConfig.debug
);
const output = createLoggingReadableStream(
  originalOutput,
  logger,
  loggerConfig.debug
);

// Only log startup message if debug is enabled
if (loggerConfig.debug) {
  logger.logInfo("Starting ACP server").catch(() => {});
}
new AgentSideConnection(
  (conn) => new ClaudeCodeAgent(conn, logger),
  input,
  output
);
