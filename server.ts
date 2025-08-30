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
import { homedir } from "node:os";
import { join } from "node:path";
import {
  query,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKUserMessageReplay,
} from "@anthropic-ai/claude-code";
import {
  type TextBlock,
  type ToolResultBlockParam,
  type ToolUseBlock,
  type ThinkingBlock,
  type RedactedThinkingBlock,
} from "@anthropic-ai/sdk/resources/messages/messages";

// Helper function to format tool input for display
function formatToolInput(input: any): string {
  if (!input || typeof input !== "object") {
    return String(input || "");
  }

  const entries = Object.entries(input).map(([key, value]) => {
    let formattedValue: string;

    if (typeof value === "string") {
      formattedValue = value;
    } else if (value === null || value === undefined) {
      formattedValue = String(value);
    } else {
      formattedValue = JSON.stringify(value);
    }

    return `${key}: ${formattedValue}`;
  });

  return entries.join(", ");
}

interface AgentSession {
  claudeSessionId: string | null;
  pendingPrompt: AbortController | null;
  promptResolver: ((response: schema.PromptResponse) => void) | null;
  pendingToolUses: Map<
    string,
    { toolCallId: string; name: string; input: any; originalToolCall?: any }
  >;
  completedToolCalls: Array<{
    name: string;
    toolCallId: string;
    toolResult: string;
    originalToolCall?: any;
    isError?: boolean;
  }>;
  cancelled: boolean;
  sessionLogFile?: string;
}

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

interface Config {
  debug: boolean;
  logFile: string | null;
  permissionMode: string | null;
}

class Logger {
  private config: Config;

  constructor(config: Config) {
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
        `[LOG ERROR] Failed to write to log file: ${error}\n`,
      );
      if (this.config.debug) {
        process.stderr.write(logLine);
      }
    }
  }

  async logClientMessage(
    direction: "RECV" | "SEND",
    message: string,
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
    message: string,
  ): Promise<void> {
    if (message.startsWith("[DEBUG]")) {
      await this.writeLog(`CLAUDE DEBUG: ${message}`);
      return;
    }
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

  async logSessionMessage(
    sessionLogFile: string,
    timestamp: string,
    direction: string | null,
    acpMessage: any,
  ): Promise<void> {
    try {
      const logEntry: any = { timestamp };
      if (direction) logEntry.direction = direction;
      logEntry["acp-message"] = acpMessage;
      await appendFile(sessionLogFile, JSON.stringify(logEntry) + "\n");
    } catch (error) {
      await this.logError(`Failed to write session log: ${error}`);
    }
  }
}

class ClaudeCodeAgent implements Agent {
  private connection: AgentSideConnection;
  private sessions = new Map<string, AgentSession>();
  private claudeSessionToClientSession = new Map<string, string>();
  private clientCapabilities: any = null;
  private logger: Logger;
  private config: Config;
  private activeQueries = new Map<string, AsyncIterator<any>>();

  constructor(connection: AgentSideConnection, logger: Logger, config: Config) {
    this.connection = connection;
    this.logger = logger;
    this.config = config;
  }

  private getSessionDir(): string {
    return (
      process.env.SESSION_DATA_DIR ||
      join(homedir(), ".claude-code-acp", "sessions")
    );
  }

  async logMessageToSessions(
    message: string,
    direction: "sent" | "received",
  ): Promise<void> {
    // Parse the message to try to extract session information
    try {
      // Skip empty messages
      if (!message.trim()) return;

      await this.logger.logInfo(
        `[SESSION DEBUG] ${direction} message: ${message.substring(0, 200)}${message.length > 200 ? "..." : ""}`,
      );
      await this.logger.logInfo(
        `[SESSION DEBUG] Active sessions: ${Array.from(this.sessions.keys()).join(", ")}`,
      );

      const lines = message.trim().split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;

        const timestamp = new Date().toISOString();

        try {
          const parsed = JSON.parse(line);
          // Try to find session ID in the message
          const clientSessionId =
            parsed.params?.sessionId || parsed.params?.session_id;

          await this.logger.logInfo(
            `[SESSION DEBUG] Parsed JSON, sessionId: ${clientSessionId}`,
          );

          if (clientSessionId) {
            const session = this.sessions.get(clientSessionId);
            if (session?.sessionLogFile) {
              await this.logger.logInfo(
                `[SESSION DEBUG] Logging to file: ${session.sessionLogFile}`,
              );
              await this.logger.logSessionMessage(
                session.sessionLogFile,
                timestamp,
                direction,
                parsed,
              );
            } else {
              await this.logger.logInfo(
                `[SESSION DEBUG] No session log file for session: ${clientSessionId}`,
              );
            }
          } else {
            await this.logger.logInfo(
              `[SESSION DEBUG] No session ID found in message`,
            );
          }
        } catch {
          // Not JSON, log as raw message for all active sessions
          await this.logger.logInfo(
            `[SESSION DEBUG] Not JSON, logging to all ${this.sessions.size} active sessions`,
          );
          for (const [sessionId, session] of this.sessions.entries()) {
            if (session.sessionLogFile) {
              await this.logger.logInfo(
                `[SESSION DEBUG] Logging non-JSON to session ${sessionId}: ${session.sessionLogFile}`,
              );
              await this.logger.logSessionMessage(
                session.sessionLogFile,
                timestamp,
                direction,
                line,
              );
            }
          }
        }
      }
    } catch (error) {
      await this.logger.logError(`Failed to log message to sessions: ${error}`);
    }
  }

  private async startClaudeQuery(
    sessionId: string,
    claudeContent: any[],
  ): Promise<void> {
    try {
      await this.logger.logInfo(
        `Starting Claude query for session ${sessionId}`,
      );

      const options: any = {
        maxTurns: 10,
      };

      // Add permission mode if specified
      if (this.config.permissionMode) {
        options.permissionMode = this.config.permissionMode;
      }

      const queryIterator = query({
        prompt: claudeContent
          .map((item) => {
            if (item.type === "text") {
              return item.text;
            } else if (item.type === "image") {
              // Handle image content
              return `[Image: ${item.source?.media_type || "unknown"}]`;
            }
            return JSON.stringify(item);
          })
          .join("\n\n"),
        options,
      });

      this.activeQueries.set(sessionId, queryIterator);

      // Process messages from the query
      for await (const message of queryIterator) {
        await this.processClaudeMessage(sessionId, message);
      }
    } catch (error) {
      await this.logger.logError(`Failed to start Claude query: ${error}`);
      console.error("Failed to start Claude query:", error);
    }
  }

  private async processClaudeMessage(
    sessionId: string,
    claudeMessage: SDKMessage,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      await this.logger.logInfo(`No session found for ${sessionId}`);
      return;
    }

    // Check if this session has been cancelled - if so, ignore all responses
    if (session.cancelled) {
      await this.logger.logInfo(
        `Ignoring Claude response for cancelled session ${sessionId}`,
      );
      return;
    }

    await this.logger.logInfo(
      `Received message: ${JSON.stringify(claudeMessage, null, 2)}`,
    );

    if (claudeMessage.type === "system") {
      await this.handleSystemMessage(sessionId, claudeMessage);
    } else if (claudeMessage.type === "assistant") {
      await this.handleAssistantMessage(sessionId, claudeMessage);
    } else if (claudeMessage.type === "user") {
      await this.handleUserMessage(sessionId, claudeMessage);
    } else if (claudeMessage.type === "result") {
      await this.handleResultMessage(sessionId, claudeMessage);
    }
  }

  private async handleSystemMessage(
    sessionId: string,
    claudeMessage: SDKSystemMessage,
  ) {
    // Handle system init message to set up Claude session ID
    if (claudeMessage.subtype === "init" && claudeMessage.session_id) {
      const session = this.sessions.get(sessionId);
      if (session) {
        // Set the Claude session ID in the session
        session.claudeSessionId = claudeMessage.session_id;

        // Update the mapping from Claude session ID to client session ID
        this.claudeSessionToClientSession.set(
          claudeMessage.session_id,
          sessionId,
        );

        await this.logger.logInfo(
          `Set Claude session ID ${claudeMessage.session_id} for client session ${sessionId}`,
        );

        // Update session log file with the Claude session ID
        if (session.sessionLogFile) {
          try {
            const sessionHeader = {
              type: "session_init",
              clientSessionId: sessionId,
              claudeSessionId: claudeMessage.session_id,
            };
            const timestamp = new Date().toISOString();
            await this.logger.logSessionMessage(
              session.sessionLogFile,
              timestamp,
              null,
              sessionHeader,
            );
            await this.logger.logInfo(
              `Updated session log with Claude session ID: ${session.sessionLogFile}`,
            );
          } catch (error) {
            await this.logger.logError(
              `Failed to update session header with Claude session ID: ${error}`,
            );
          }
        }
      }
    }
  }

  private async handleAssistantMessage(
    sessionId: string,
    claudeMessage: SDKAssistantMessage,
  ) {
    const content = claudeMessage.message.content;
    for (const contentBlock of content) {
      if (contentBlock.type === "text") {
        await this.handleTextMessage(sessionId, contentBlock);
      } else if (contentBlock.type === "thinking") {
        await this.handleThinkingMessage(sessionId, contentBlock);
      } else if (contentBlock.type === "redacted_thinking") {
        await this.handleThinkingMessage(sessionId, contentBlock);
      } else if (contentBlock.type === "server_tool_use") {
        await this.handleToolUse(sessionId, contentBlock);
      } else if (contentBlock.type === "tool_use") {
        await this.handleToolUse(sessionId, contentBlock);
      } else if (contentBlock.type === "web_search_tool_result") {
        await this.handleToolResultMessage(sessionId, contentBlock);
      }
    }
  }

  private async handleUserMessage(
    sessionId: string,
    claudeMessage: SDKUserMessage | SDKUserMessageReplay,
  ) {
    const content = claudeMessage.message.content;
    if (typeof content === "string") {
      await this.handleTextMessage(sessionId, content);
      return;
    }
    for (const contentBlock of content) {
      if (contentBlock.type === "text") {
        await this.handleTextMessage(sessionId, contentBlock);
      } else if (contentBlock.type === "tool_result") {
        await this.handleToolResultMessage(sessionId, contentBlock);
      } else if (contentBlock.type === "thinking") {
        await this.handleThinkingMessage(sessionId, contentBlock);
      } else if (contentBlock.type === "redacted_thinking") {
        await this.handleThinkingMessage(sessionId, contentBlock);
      } else if (contentBlock.type === "server_tool_use") {
        await this.handleToolUse(sessionId, contentBlock);
      } else if (contentBlock.type === "tool_use") {
        await this.handleToolUse(sessionId, contentBlock);
      } else if (contentBlock.type === "web_search_tool_result") {
        await this.handleToolResultMessage(sessionId, contentBlock);
      } else if (contentBlock.type === "document") {
        await this.handleTextMessage(sessionId, contentBlock);
      } else if (contentBlock.type === "image") {
        await this.handleTextMessage(sessionId, contentBlock);
      } else if (contentBlock.type === "search_result") {
        await this.handleTextMessage(sessionId, contentBlock);
      }
    }
  }

  // private async handleErrorMessage(
  //   sessionId: string,
  //   claudeMessage: any,
  // ): Promise<void> {
  //   await this.logger.logError(
  //     `Claude error for session ${sessionId}: ${claudeMessage.error}`,
  //   );

  //   const session = this.sessions.get(sessionId);
  //   if (session?.promptResolver) {
  //     session.promptResolver({
  //       stopReason: "error",
  //     });
  //     session.promptResolver = null;
  //   }
  // }

  private async handleToolUse(
    sessionId: string,
    toolUse: ToolUseBlock,
  ): Promise<void> {
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
      `Tool use started: ${toolUse.name} (${toolUse.id})`,
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

    if (toolUse.name === "Edit") {
      const originalToolCall = {
        sessionUpdate: "tool_call" as const,
        toolCallId,
        title: `Editing ${toolUse.input.file_path}`,
        kind: "edit" as const,
        status: "pending" as const,
        rawInput: toolUse.input,
        content: [
          {
            type: "diff",
            path: toolUse.input.file_path || "",
            oldText: toolUse.input.old_string || "",
            newText: toolUse.input.new_string || "",
          },
        ],
      };

      // Store the original tool call data
      const pendingTool = session.pendingToolUses.get(toolUse.id);
      if (pendingTool) {
        pendingTool.originalToolCall = originalToolCall;
      }

      await this.connection.sessionUpdate({
        sessionId,
        update: originalToolCall,
      });
      return;
    }

    if (toolUse.name === "Write") {
      const originalToolCall = {
        sessionUpdate: "tool_call" as const,
        toolCallId,
        title: `Writing to ${toolUse.input.file_path}`,
        kind: "edit" as const,
        status: "pending" as const,
        rawInput: toolUse.input,
        content: [
          {
            type: "diff",
            path: toolUse.input.file_path || "",
            oldText: "",
            newText: toolUse.input.content || "",
          },
        ],
      };

      // Store the original tool call data
      const pendingTool = session.pendingToolUses.get(toolUse.id);
      if (pendingTool) {
        pendingTool.originalToolCall = originalToolCall;
      }

      await this.connection.sessionUpdate({
        sessionId,
        update: originalToolCall,
      });
      return;
    }

    if (toolUse.name === "MultiEdit") {
      const edits = toolUse.input.edits || [];
      const content = edits.map((edit: any) => ({
        type: "diff",
        path: toolUse.input.file_path || "",
        oldText: edit.old_string || "",
        newText: edit.new_string || "",
      }));

      const originalToolCall = {
        sessionUpdate: "tool_call" as const,
        toolCallId,
        title: `Multi-editing ${toolUse.input.file_path}`,
        kind: "edit" as const,
        status: "pending" as const,
        rawInput: toolUse.input,
        content,
      };

      // Store the original tool call data
      const pendingTool = session.pendingToolUses.get(toolUse.id);
      if (pendingTool) {
        pendingTool.originalToolCall = originalToolCall;
      }

      await this.connection.sessionUpdate({
        sessionId,
        update: originalToolCall,
      });
      return;
    }

    // Send tool_call notification to client - just report what Claude requested
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call" as const,
        toolCallId,
        title: `${toolUse.name}(${formatToolInput(toolUse.input)})`,
        kind: toolMappings[toolUse.name] as any,
        status: "pending" as const,
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
    toolResult: ToolResultBlockParam,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const toolUseId = toolResult.tool_use_id;

    const pendingTool = session.pendingToolUses.get(toolUseId);
    if (!pendingTool) {
      await this.logger.logInfo(
        `Received tool result for unknown tool: ${toolUseId}`,
      );
      return;
    }

    const isError = toolResult.is_error === true;
    await this.logger.logInfo(
      `Tool result received: ${pendingTool.name} (${toolUseId})${isError ? " [ERROR]" : ""}`,
    );

    // Store the completion to be sent after the next agent_message_chunk
    session.completedToolCalls.push({
      name: pendingTool.name,
      toolCallId: pendingTool.toolCallId,
      toolResult: toolResult.content,
      originalToolCall: pendingTool.originalToolCall,
      isError,
    });

    // Remove from pending tool uses
    session.pendingToolUses.delete(toolUseId);
    await this.logger.logInfo(
      `Tool use completed and queued for next message: ${pendingTool.name} (${toolUseId})`,
    );
  }

  private async executeTodoWriteTool(
    sessionId: string,
    toolUse: any,
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
    textItem: TextBlockParam | string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);

    if (typeof textItem === "string") {
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: textItem,
          },
        },
      });
    } else {
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

    // Send any completed tool calls that were queued
    if (session && session.completedToolCalls.length > 0) {
      for (const completedTool of session.completedToolCalls) {
        const updateData: any = {
          sessionUpdate: "tool_call_update",
          toolCallId: completedTool.toolCallId,
          status: completedTool.isError ? "failed" : "completed",
        };

        // Handle Write/Edit/MultiEdit tools with original data, append to content, and set rawOutput
        if (completedTool.originalToolCall) {
          // Start with the original tool call data
          let title;
          if (completedTool.name === "Edit") {
            title = "Edited";
          } else if (completedTool.name === "MultiEdit") {
            title = "Multi-edited";
          } else {
            title = "Created";
          }
          updateData.title = `${title} ${completedTool.originalToolCall.rawInput?.file_path || "file"}`;
          updateData.kind = completedTool.originalToolCall.kind;
          updateData.rawInput = completedTool.originalToolCall.rawInput;
          updateData.rawOutput = {
            content: { type: "text", text: completedTool.toolResult },
          };
          // Append to existing content
          updateData.content = [
            ...completedTool.originalToolCall.content,
            {
              type: "content",
              content: {
                type: "text",
                text: completedTool.toolResult,
              },
            },
          ];
        } else {
          // Handle other tools with regular content
          updateData.content = [
            {
              type: "content",
              content: {
                type: "text",
                text: completedTool.toolResult,
              },
            },
          ];
        }

        await this.connection.sessionUpdate({
          sessionId,
          update: updateData,
        });

        await this.logger.logInfo(
          `Sent queued tool completion: ${completedTool.toolCallId}`,
        );
      }

      // Clear the completed tool calls queue
      session.completedToolCalls = [];
    }
  }

  private async handleThinkingMessage(
    sessionId: string,
    thinkingItem: ThinkingBlock,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    await this.logger.logInfo(
      `Thinking block received for session ${sessionId}`,
    );

    // Send thinking as agent_thought_chunk instead of tool_call
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk" as const,
        content: {
          type: "text" as const,
          text: thinkingItem.thinking,
          annotations: { audience: ["user" as const] },
        },
      },
    });
  }

  private async handleResultMessage(
    sessionId: string,
    resultMessage: SDKResultMessage,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    await this.logger.logInfo(
      `Result message for session ${sessionId}, has resolver: ${!!session?.promptResolver}, pending tools: ${
        session?.pendingToolUses.size || 0
      }`,
    );

    if (!session || !session.promptResolver) {
      await this.logger.logInfo(
        `No resolver found for session ${sessionId} - result message ignored`,
      );
      return;
    }

    // Check if there are still pending tool uses
    if (session.pendingToolUses.size > 0) {
      await this.logger.logInfo(
        `Still have ${session.pendingToolUses.size} pending tool uses, not sending end_turn yet`,
      );
      return;
    }

    // Resolve the pending prompt with the result
    const stopReason = resultMessage.is_error ? "max_tokens" : "end_turn";
    await this.logger.logInfo(
      `Resolving prompt for session ${sessionId} with stopReason: ${stopReason}`,
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

  private cleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      // Clean up Claude session mapping
      if (session.claudeSessionId) {
        this.claudeSessionToClientSession.delete(session.claudeSessionId);
        this.logger
          .logInfo(
            `Removed Claude session mapping for ${session.claudeSessionId}`,
          )
          .catch(() => {});
      }

      // Remove from sessions map
      this.sessions.delete(sessionId);

      // Clean up active query
      this.activeQueries.delete(sessionId);

      this.logger.logInfo(`Cleaned up session ${sessionId}`).catch(() => {});
    }
  }

  async initialize(
    params: schema.InitializeRequest,
  ): Promise<schema.InitializeResponse> {
    // Store client capabilities for later use
    this.clientCapabilities = params.clientCapabilities;

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
      },
    };
  }

  async newSession(
    params: schema.NewSessionRequest,
  ): Promise<schema.NewSessionResponse> {
    const sessionId = crypto.randomUUID();

    // Initialize session log file immediately
    const sessionDir = this.getSessionDir();
    await mkdir(sessionDir, { recursive: true });
    const sessionLogFile = join(sessionDir, `${sessionId}.jsonl`);

    this.sessions.set(sessionId, {
      claudeSessionId: null,
      pendingPrompt: null,
      promptResolver: null,
      pendingToolUses: new Map(),
      completedToolCalls: [],
      cancelled: false,
      sessionLogFile, // Set the log file immediately
    });

    // Write session_init message immediately, even without Claude session ID
    try {
      const sessionHeader = {
        type: "session_init",
        clientSessionId: sessionId,
        claudeSessionId: null, // Will be updated later when Claude session starts
      };
      const timestamp = new Date().toISOString();
      await this.logger.logSessionMessage(
        sessionLogFile,
        timestamp,
        null,
        sessionHeader,
      );
      await this.logger.logInfo(
        `Created session log file with initial session_init: ${sessionLogFile}`,
      );
    } catch (error) {
      await this.logger.logError(
        `Failed to write initial session header: ${error}`,
      );
    }

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

    // Reset cancelled flag when starting a new prompt
    session.cancelled = false;

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

    // Start Claude query using the SDK
    this.startClaudeQuery(params.sessionId, claudeContent);

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

  async loadSession(
    params: schema.LoadSessionRequest, // Using 'any' to handle custom sessionId parameter
  ): Promise<void> {
    // Using 'any' since we return custom response
    const { sessionId, cwd, mcpServers } = params;

    await this.logger.logInfo(`Loading session: ${sessionId}`);

    // Build the session history file path
    const sessionDir = this.getSessionDir();
    const sessionHistoryFile = join(sessionDir, `${sessionId}.jsonl`);

    try {
      // Check if the session history file exists
      const file = Bun.file(sessionHistoryFile);
      const exists = await file.exists();

      if (!exists) {
        await this.logger.logError(
          `Session history file not found: ${sessionHistoryFile}`,
        );
        return;
      }

      // Read and parse the session history file
      const content = await file.text();
      const lines = content
        .trim()
        .split("\n")
        .filter((line) => line.trim());

      if (lines.length < 3) {
        await this.logger.logError(
          `Session history file has insufficient data: ${lines.length} lines`,
        );
        return;
      }

      // Parse and log the first and third lines (session_init lines)
      try {
        const firstLine = JSON.parse(lines[0]);
        const thirdLine = JSON.parse(lines[2]);

        await this.logger.logInfo(
          `Session history first line (session_init): ${JSON.stringify(firstLine, null, 2)}`,
        );
        await this.logger.logInfo(
          `Session history third line (session_init): ${JSON.stringify(thirdLine, null, 2)}`,
        );

        // TODO: Add logic to restore session state based on history

        return;
      } catch (parseError) {
        await this.logger.logError(
          `Failed to parse session history lines: ${parseError}`,
        );
        return;
      }
    } catch (error) {
      await this.logger.logError(`Failed to load session: ${error}`);
      return;
    }
  }

  async cancel(params: schema.CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      await this.logger.logInfo(
        `Cancel requested for unknown session: ${params.sessionId}`,
      );
      return;
    }

    await this.logger.logInfo(`Cancelling session ${params.sessionId}`);

    // Set cancelled flag to ignore future Claude responses
    session.cancelled = true;

    // Stop the active Claude query if there is one
    const activeQuery = this.activeQueries.get(params.sessionId);
    if (activeQuery && activeQuery.return) {
      try {
        await activeQuery.return();
      } catch (error) {
        await this.logger.logError(`Error stopping Claude query: ${error}`);
      }
    }
    this.activeQueries.delete(params.sessionId);

    // If there's a pending prompt resolver, respond with cancelled before clearing
    if (session.promptResolver) {
      await this.logger.logInfo(
        `Resolving pending prompt with cancelled status for session ${params.sessionId}`,
      );
      session.promptResolver({
        stopReason: "cancelled",
      });
    }

    // Abort any pending prompt
    session.pendingPrompt?.abort();

    // Clean up Claude session mapping if it exists
    if (session.claudeSessionId) {
      this.claudeSessionToClientSession.delete(session.claudeSessionId);
      await this.logger.logInfo(
        `Removed Claude session mapping for ${session.claudeSessionId}`,
      );
    }

    // Clear all pending state
    session.pendingPrompt = null;
    session.promptResolver = null;
    session.pendingToolUses.clear();
    session.completedToolCalls = [];

    await this.logger.logInfo(
      `Session ${params.sessionId} cancelled and reset`,
    );
  }
}

// Parse command line arguments
function parseArgs(): Config {
  const args = process.argv.slice(2);
  let debug = false;
  let logFile: string | null = null;
  let permissionMode: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--debug") {
      debug = true;
    } else if (args[i] === "--log-file" && i + 1 < args.length) {
      logFile = args[i + 1]!;
      i++; // skip the next argument since it's the log file path
    } else if (args[i] === "--permission-mode" && i + 1 < args.length) {
      permissionMode = args[i + 1]!;
      i++; // skip the next argument since it's the permission mode
    }
  }

  return { debug, logFile, permissionMode };
}

// Create config and logger
const config = parseArgs();
const logger = new Logger(config);

// Create logging wrapper for streams
class LoggingWritableStream extends WritableStream {
  constructor(
    originalStream: WritableStream,
    logger: Logger,
    debug: boolean,
    agent: ClaudeCodeAgent,
  ) {
    super({
      write(chunk) {
        // Only decode and log if debug is enabled
        if (debug) {
          const message = new TextDecoder().decode(chunk);
          logger.logClientMessage("SEND", message.trim()).catch(() => {});
        }

        // Log to session files
        const message = new TextDecoder().decode(chunk);
        agent.logMessageToSessions(message, "sent").catch(() => {});

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
  debug: boolean,
  agent: ClaudeCodeAgent,
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

          // Log to session files
          const message = new TextDecoder().decode(value);
          agent.logMessageToSessions(message, "received").catch(() => {});

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
  process.stdin,
) as ReadableStream<Uint8Array>;

// Create a holder for the agent that will be set after connection creation
let currentAgent: ClaudeCodeAgent | null = null;

const input = new LoggingWritableStream(originalInput, logger, config.debug, {
  logMessageToSessions: (message: string, direction: "sent" | "received") =>
    currentAgent?.logMessageToSessions(message, direction) || Promise.resolve(),
} as ClaudeCodeAgent);

const output = createLoggingReadableStream(
  originalOutput,
  logger,
  config.debug,
  {
    logMessageToSessions: (message: string, direction: "sent" | "received") =>
      currentAgent?.logMessageToSessions(message, direction) ||
      Promise.resolve(),
  } as ClaudeCodeAgent,
);

// Only log startup message if debug is enabled
if (config.debug) {
  logger.logInfo("Starting ACP server").catch(() => {});
}

new AgentSideConnection(
  (conn) => {
    const agent = new ClaudeCodeAgent(conn, logger, config);
    currentAgent = agent; // Set the agent reference
    return agent;
  },
  input,
  output,
);
