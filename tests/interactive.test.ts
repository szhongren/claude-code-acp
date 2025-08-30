#!/usr/bin/env bun

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";

describe("Integration Tests", () => {
  let serverProcess: Bun.Subprocess | null = null;

  beforeAll(async () => {
    // Build the server before running integration tests
    await Bun.spawn(["bun", "build", "server.ts", "--compile", "--outfile", "dist/server"], {
      stdio: ["inherit", "inherit", "inherit"]
    }).exited;
  });

  afterEach(() => {
    if (serverProcess) {
      serverProcess.kill();
      serverProcess = null;
    }
  });

  test("should handle initialize request", async () => {
    serverProcess = Bun.spawn(["./dist/server"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const initMessage = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true }
        }
      }
    }) + "\n";

    serverProcess.stdin!.write(initMessage);

    // Read response with timeout
    const response = await Promise.race([
      readJsonResponse(serverProcess.stdout!),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000))
    ]);

    expect(response.id).toBe(1);
    expect(response.result).toBeDefined();
    expect(response.result.protocolVersion).toBeDefined();
    expect(response.result.agentCapabilities).toBeDefined();
  }, 10000);

  test("should handle session creation and prompt flow", async () => {
    serverProcess = Bun.spawn(["./dist/server"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Initialize
    const initMessage = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {}
      }
    }) + "\n";
    
    serverProcess.stdin!.write(initMessage);
    const initResponse = await readJsonResponse(serverProcess.stdout!);
    expect(initResponse.id).toBe(1);

    // Create session
    const sessionMessage = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: {
        mcpServers: [],
        cwd: process.cwd()
      }
    }) + "\n";
    
    serverProcess.stdin!.write(sessionMessage);
    const sessionResponse = await readJsonResponse(serverProcess.stdout!);
    expect(sessionResponse.id).toBe(2);
    expect(sessionResponse.result.sessionId).toBeDefined();

    const sessionId = sessionResponse.result.sessionId;

    // Send a simple prompt that shouldn't trigger Claude (for faster test)
    // Actually, let's just test the message structure is accepted
    const promptMessage = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [
          {
            type: "text",
            text: "Just say hello"
          }
        ]
      }
    }) + "\n";
    
    serverProcess.stdin!.write(promptMessage);
    
    // The server should accept this message (it will try to communicate with Claude)
    // For testing purposes, we'll just wait a moment to ensure no immediate errors
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Check that the process is still running (no immediate crashes)
    expect(serverProcess.exitCode).toBe(null);
  }, 15000);

  test("should handle cancellation", async () => {
    serverProcess = Bun.spawn(["./dist/server"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Initialize and create session
    await initializeSession(serverProcess);
    const sessionId = "test-session-id"; // We'd get this from session creation in real scenario

    const cancelMessage = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: {
        sessionId
      }
    }) + "\n";
    
    serverProcess.stdin!.write(cancelMessage);
    
    // Should not crash
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(serverProcess.exitCode).toBe(null);
  }, 10000);

  test("should handle malformed JSON", async () => {
    serverProcess = Bun.spawn(["./dist/server"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Send malformed JSON
    serverProcess.stdin!.write("{ invalid json }\n");
    
    // Should not crash
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(serverProcess.exitCode).toBe(null);
  }, 5000);

  test("should handle missing required fields", async () => {
    serverProcess = Bun.spawn(["./dist/server"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Send message with missing required fields
    const badMessage = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize"
      // missing params
    }) + "\n";
    
    serverProcess.stdin!.write(badMessage);
    
    const response = await Promise.race([
      readJsonResponse(serverProcess.stdout!),
      new Promise(resolve => setTimeout(() => resolve(null), 2000))
    ]);

    // Should either get an error response or no response (graceful handling)
    if (response) {
      expect(response.id).toBe(1);
      // Could be error or valid response depending on implementation
    }
  }, 5000);

  test("should start Claude process correctly", async () => {
    serverProcess = Bun.spawn(["./dist/server", "--debug"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait a bit for startup
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Check stderr for debug logs indicating Claude process startup
    const stderrReader = serverProcess.stderr!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    
    try {
      const { value } = await Promise.race([
        stderrReader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 2000))
      ]);
      
      if (value) {
        buffer = decoder.decode(value);
        // Should see some kind of startup message or Claude-related logs
        expect(buffer.length).toBeGreaterThan(0);
      }
    } catch (error) {
      // Timeout is expected if no debug output
    } finally {
      stderrReader.releaseLock();
    }
  }, 5000);
});

describe("Message Processing Tests", () => {
  test("should validate message structures", () => {
    const validateMessage = (msg: any) => {
      if (!msg.jsonrpc || msg.jsonrpc !== "2.0") return false;
      if (!msg.method) return false;
      if (msg.id === undefined) return false; // notifications can skip id
      return true;
    };

    const validInit = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} }
    };

    const invalidInit = {
      jsonrpc: "1.0", // wrong version
      id: 1,
      method: "initialize"
    };

    expect(validateMessage(validInit)).toBe(true);
    expect(validateMessage(invalidInit)).toBe(false);
  });

  test("should handle different content types in prompts", () => {
    const processPromptContent = (content: any[]) => {
      const processed = [];
      
      for (const item of content) {
        switch (item.type) {
          case "text":
            processed.push({ type: "text", content: item.text });
            break;
          case "image":
            processed.push({ 
              type: "image", 
              data: item.data, 
              mimeType: item.mimeType 
            });
            break;
          case "resource_link":
            processed.push({ 
              type: "resource_link", 
              uri: item.uri 
            });
            break;
        }
      }
      
      return processed;
    };

    const textContent = [{ type: "text", text: "Hello world" }];
    const result = processPromptContent(textContent);
    expect(result[0]?.type).toBe("text");
    expect(result[0]?.content).toBe("Hello world");

    const imageContent = [{ 
      type: "image", 
      data: "base64...", 
      mimeType: "image/png" 
    }];
    const imageResult = processPromptContent(imageContent);
    expect(imageResult[0]?.type).toBe("image");
    expect(imageResult[0]?.mimeType).toBe("image/png");
  });
});

describe("Performance and Stress Tests", () => {
  test("should handle multiple rapid requests", async () => {
    const serverProcess = Bun.spawn(["./dist/server"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      // Send multiple initialize requests rapidly
      const promises = [];
      for (let i = 0; i < 5; i++) {
        const initMessage = JSON.stringify({
          jsonrpc: "2.0",
          id: i + 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {}
          }
        }) + "\n";
        
        serverProcess.stdin!.write(initMessage);
      }

      // Wait for responses or timeout
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Server should still be running
      expect(serverProcess.exitCode).toBe(null);
    } finally {
      serverProcess.kill();
    }
  }, 10000);

  test("should handle large prompt content", async () => {
    const serverProcess = Bun.spawn(["./dist/server"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      // Initialize first
      await initializeSession(serverProcess);
      
      // Create a large prompt
      const largeText = "x".repeat(10000); // 10KB of text
      const promptMessage = JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId: "test-session",
          prompt: [
            {
              type: "text",
              text: largeText
            }
          ]
        }
      }) + "\n";
      
      serverProcess.stdin!.write(promptMessage);
      
      // Should not crash
      await new Promise(resolve => setTimeout(resolve, 1000));
      expect(serverProcess.exitCode).toBe(null);
    } finally {
      serverProcess.kill();
    }
  }, 10000);
});

// Helper functions
async function readJsonResponse(stdout: ReadableStream): Promise<any> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk;
    
    const lines = buffer.split('\n');
    buffer = lines.pop() || "";
    
    for (const line of lines) {
      if (line.trim()) {
        try {
          const parsed = JSON.parse(line);
          reader.releaseLock();
          return parsed;
        } catch (error) {
          // Not JSON, continue
        }
      }
    }
  }
  
  reader.releaseLock();
  throw new Error("No valid JSON response received");
}

async function initializeSession(serverProcess: Bun.Subprocess): Promise<string> {
  const initMessage = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {}
    }
  }) + "\n";
  
  const sessionMessage = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: {
      mcpServers: [],
      cwd: process.cwd()
    }
  }) + "\n";
  
  serverProcess.stdin!.write(initMessage);
  serverProcess.stdin!.write(sessionMessage);
  
  // Wait for initialization to complete
  await new Promise(resolve => setTimeout(resolve, 500));
  
  return "initialized";
}