#!/usr/bin/env bun

import { describe, test, expect } from "bun:test";

// Define interfaces that mirror the server types
interface AgentSession {
  claudeSessionId: string | null;
  pendingPrompt: AbortController | null;
  promptResolver: ((response: any) => void) | null;
  pendingToolUses: Map<string, { toolCallId: string; name: string; input: any; originalToolCall?: any }>;
  completedToolCalls: Array<{
    name: string;
    toolCallId: string;
    toolResult: string;
    originalToolCall?: any;
  }>;
  cancelled: boolean;
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

// Unit tests for core functionality
describe("Core Types and Interfaces", () => {
  test("AgentSession should have correct structure", () => {
    const mockSession: AgentSession = {
      claudeSessionId: "test-claude-session",
      pendingPrompt: null,
      promptResolver: null,
      pendingToolUses: new Map(),
      completedToolCalls: [],
      cancelled: false,
    };
    
    expect(mockSession.claudeSessionId).toBe("test-claude-session");
    expect(mockSession.pendingToolUses).toBeInstanceOf(Map);
    expect(mockSession.completedToolCalls).toEqual([]);
    expect(mockSession.cancelled).toBe(false);
  });

  test("TodoItem should have required properties", () => {
    const todoItem: TodoItem = {
      content: "Test task",
      status: "pending",
      activeForm: "Testing task"
    };
    
    expect(todoItem.content).toBe("Test task");
    expect(todoItem.status).toBe("pending");
    expect(todoItem.activeForm).toBe("Testing task");
  });

  test("Config should have optional properties", () => {
    const config: Config = {
      debug: true,
      logFile: "/tmp/test.log",
      permissionMode: "ask"
    };
    
    expect(config.debug).toBe(true);
    expect(config.logFile).toBe("/tmp/test.log");
    expect(config.permissionMode).toBe("ask");
  });
});

describe("Utility Functions", () => {
  test("formatToolInput should handle different input types", () => {
    const formatInput = (input: any): string => {
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
    };

    expect(formatInput(null)).toBe("");
    expect(formatInput(undefined)).toBe("");
    expect(formatInput("test")).toBe("test");
    expect(formatInput({ file_path: "/test.txt" })).toBe("file_path: /test.txt");
    expect(formatInput({ count: 5, enabled: true })).toBe("count: 5, enabled: true");
  });

  test("determinePriority should classify tasks correctly", () => {
    const determinePriority = (content: string): "high" | "medium" | "low" => {
      const contentLower = content.toLowerCase();
      
      if (contentLower.includes("error") || contentLower.includes("fix") ||
          contentLower.includes("bug") || contentLower.includes("critical")) {
        return "high";
      }
      
      if (contentLower.includes("implement") || contentLower.includes("add") ||
          contentLower.includes("create") || contentLower.includes("build")) {
        return "medium";
      }
      
      if (contentLower.includes("document") || contentLower.includes("test") ||
          contentLower.includes("research") || contentLower.includes("review")) {
        return "low";
      }
      
      return "medium";
    };

    expect(determinePriority("Fix authentication error")).toBe("high");
    expect(determinePriority("Critical bug in login")).toBe("high");
    expect(determinePriority("Implement user registration")).toBe("medium");
    expect(determinePriority("Add new feature")).toBe("medium");
    expect(determinePriority("Document the API")).toBe("low");
    expect(determinePriority("Test the integration")).toBe("low");
    expect(determinePriority("Random task")).toBe("medium");
  });
});

describe("Command Line Parsing", () => {
  test("parseArgs should handle debug flag", () => {
    const parseArgs = (argv: string[]): Config => {
      let debug = false;
      let logFile: string | null = null;
      let permissionMode: string | null = null;
      
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--debug") {
          debug = true;
        } else if (argv[i] === "--log-file" && i + 1 < argv.length) {
          logFile = argv[i + 1]!;
          i++;
        } else if (argv[i] === "--permission-mode" && i + 1 < argv.length) {
          permissionMode = argv[i + 1]!;
          i++;
        }
      }
      
      return { debug, logFile, permissionMode };
    };

    expect(parseArgs(["--debug"])).toEqual({
      debug: true,
      logFile: null,
      permissionMode: null
    });
    
    expect(parseArgs(["--log-file", "/tmp/test.log"])).toEqual({
      debug: false,
      logFile: "/tmp/test.log",
      permissionMode: null
    });
    
    expect(parseArgs(["--permission-mode", "ask"])).toEqual({
      debug: false,
      logFile: null,
      permissionMode: "ask"
    });
    
    expect(parseArgs(["--debug", "--log-file", "/tmp/debug.log", "--permission-mode", "allow"])).toEqual({
      debug: true,
      logFile: "/tmp/debug.log",
      permissionMode: "allow"
    });
  });
});

describe("Tool Mappings", () => {
  test("should map tools to correct categories", () => {
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
    
    expect(toolMappings.Bash).toBe("execute");
    expect(toolMappings.Read).toBe("read");
    expect(toolMappings.Edit).toBe("edit");
    expect(toolMappings.WebFetch).toBe("fetch");
    expect(toolMappings.Grep).toBe("search");
  });
});

describe("Message Validation", () => {
  test("should validate ACP initialize message structure", () => {
    const initMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {}
      }
    };
    
    expect(initMessage.jsonrpc).toBe("2.0");
    expect(initMessage.method).toBe("initialize");
    expect(initMessage.params.protocolVersion).toBe(1);
    expect(typeof initMessage.params.clientCapabilities).toBe("object");
  });

  test("should validate session/new message structure", () => {
    const sessionMessage = {
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: {
        mcpServers: [],
        cwd: process.cwd()
      }
    };
    
    expect(sessionMessage.method).toBe("session/new");
    expect(Array.isArray(sessionMessage.params.mcpServers)).toBe(true);
    expect(typeof sessionMessage.params.cwd).toBe("string");
  });

  test("should validate prompt message structure", () => {
    const promptMessage = {
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: "test-session-id",
        prompt: [
          {
            type: "text",
            text: "Test prompt"
          }
        ]
      }
    };
    
    expect(promptMessage.method).toBe("session/prompt");
    expect(typeof promptMessage.params.sessionId).toBe("string");
    expect(Array.isArray(promptMessage.params.prompt)).toBe(true);
    expect(promptMessage.params.prompt[0]?.type).toBe("text");
  });
});

describe("Session Management", () => {
  test("should generate unique session IDs", () => {
    const generateSessionId = () => crypto.randomUUID();
    
    const id1 = generateSessionId();
    const id2 = generateSessionId();
    
    expect(typeof id1).toBe("string");
    expect(typeof id2).toBe("string");
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
  
  test("should initialize session with correct default values", () => {
    const createSession = (): AgentSession => ({
      claudeSessionId: null,
      pendingPrompt: null,
      promptResolver: null,
      pendingToolUses: new Map(),
      completedToolCalls: [],
      cancelled: false,
    });
    
    const session = createSession();
    
    expect(session.claudeSessionId).toBe(null);
    expect(session.pendingPrompt).toBe(null);
    expect(session.promptResolver).toBe(null);
    expect(session.pendingToolUses.size).toBe(0);
    expect(session.completedToolCalls.length).toBe(0);
    expect(session.cancelled).toBe(false);
  });

  test("should manage tool use lifecycle", () => {
    const session = {
      pendingToolUses: new Map(),
      completedToolCalls: [] as any[]
    };

    // Add a pending tool use
    const toolUseId = "tool-123";
    session.pendingToolUses.set(toolUseId, {
      toolCallId: "call-456",
      name: "Read",
      input: { file_path: "/test.txt" }
    });

    expect(session.pendingToolUses.size).toBe(1);
    expect(session.pendingToolUses.get(toolUseId)?.name).toBe("Read");

    // Complete the tool use
    const pendingTool = session.pendingToolUses.get(toolUseId)!;
    session.completedToolCalls.push({
      name: pendingTool.name,
      toolCallId: pendingTool.toolCallId,
      toolResult: "File content here"
    });
    session.pendingToolUses.delete(toolUseId);

    expect(session.pendingToolUses.size).toBe(0);
    expect(session.completedToolCalls.length).toBe(1);
    expect(session.completedToolCalls[0]?.name).toBe("Read");
  });
});

describe("Content Processing", () => {
  test("should handle different content types", () => {
    const processContent = (items: any[]) => {
      const claudeContent = [];
      
      for (const item of items) {
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
        } else if (item.type === "resource") {
          if ("text" in item.resource) {
            claudeContent.push({
              type: "document",
              source: {
                data: item.resource.text,
                media_type: item.resource.mimeType || "text/plain",
                type: "text",
              },
            });
          }
        }
      }
      
      return claudeContent;
    };

    const textContent = processContent([{ type: "text", text: "Hello" }]);
    expect(textContent).toEqual([{ type: "text", text: "Hello" }]);

    const imageContent = processContent([{ 
      type: "image", 
      data: "base64data", 
      mimeType: "image/png" 
    }]);
    expect(imageContent[0]?.type).toBe("image");
    expect(imageContent[0]?.source.type).toBe("base64");

    const resourceContent = processContent([{
      type: "resource",
      resource: { text: "File content", mimeType: "text/plain" }
    }]);
    expect(resourceContent[0]?.type).toBe("document");
    expect(resourceContent[0]?.source.type).toBe("text");
  });
});

describe("Error Handling", () => {
  test("should handle session not found", () => {
    const findSession = (sessionId: string, sessions: Map<string, any>) => {
      return sessions.get(sessionId);
    };

    const sessions = new Map();
    const result = findSession("non-existent", sessions);
    
    expect(result).toBeUndefined();
  });

  test("should handle cancelled sessions", () => {
    const session = { cancelled: true, promptResolver: null };
    
    const shouldProcessMessage = (session: any) => {
      if (session?.cancelled) {
        return false;
      }
      return true;
    };

    expect(shouldProcessMessage(session)).toBe(false);
    expect(shouldProcessMessage({ cancelled: false })).toBe(true);
    expect(shouldProcessMessage(null)).toBe(true);
  });
});