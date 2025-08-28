#!/usr/bin/env bun

async function testResourceLink() {
  console.log("Testing resource_link handling...");
  
  const proc = Bun.spawn(["./dist/server"], {
    stdin: "pipe",
    stdout: "pipe", 
    stderr: "pipe",
  });

  try {
    const reader = proc.stdout!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sessionId = "";
    
    // Send initialize with readTextFile capability
    const initMessage = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize", 
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true
          }
        }
      }
    }) + "\n";
    
    proc.stdin!.write(initMessage);
    console.log("✓ Sent initialize with readTextFile capability");

    // Process responses
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      
      const lines = buffer.split('\n');
      buffer = lines.pop() || "";
      
      for (const line of lines) {
        if (line.trim()) {
          console.log("Received:", line);
          try {
            const parsed = JSON.parse(line);
            
            if (parsed.id === 1 && parsed.result) {
              console.log("✓ Initialize successful");
              
              // Send session/new
              const sessionMessage = JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "session/new",
                params: {
                  mcpServers: [],
                  cwd: process.cwd()
                }
              }) + "\n";
              
              proc.stdin!.write(sessionMessage);
              console.log("✓ Sent session/new");
            }
            
            if (parsed.id === 2 && parsed.result?.sessionId) {
              sessionId = parsed.result.sessionId;
              console.log("✓ Got session ID:", sessionId);
              
              // Send prompt with resource_link
              const promptMessage = JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "session/prompt",
                params: {
                  sessionId,
                  prompt: [
                    {
                      type: "text", 
                      text: "Please analyze this file:"
                    },
                    {
                      type: "resource_link",
                      uri: "file:///Users/shaoz/work/claude-code-acp/server.ts",
                      name: "server.ts",
                      mimeType: "text/typescript",
                      size: 15000
                    }
                  ]
                }
              }) + "\n";
              
              proc.stdin!.write(promptMessage);
              console.log("✓ Sent prompt with resource_link");
            }
            
            // Check for fs/read_text_file request from server
            if (parsed.method === "fs/read_text_file") {
              console.log("🎯 Server made fs/read_text_file request!");
              console.log("Path:", parsed.params.path);
              console.log("Line:", parsed.params.line);
              console.log("Limit:", parsed.params.limit);
              
              // Respond with mock file content
              const responseMessage = JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: {
                  content: "#!/usr/bin/env bun\n\nimport {\n  AgentSideConnection,\n  type Agent,\n  PROTOCOL_VERSION,\n} from \"@zed-industries/agent-client-protocol\";\nimport * as schema from \"@zed-industries/agent-client-protocol\";\nimport { WritableStream, ReadableStream } from \"node:stream/web\";\nimport { Readable, Writable } from \"node:stream\";\n\ninterface AgentSession {\n  claudeSessionId: string | null;\n  pendingPrompt: AbortController | null;\n}\n\ninterface TodoItem {\n  content: string;\n  status: \"pending\" | \"in_progress\" | \"completed\";\n  activeForm: string;\n}"
                }
              }) + "\n";
              
              proc.stdin!.write(responseMessage);
              console.log("✓ Sent file content response");
            }
            
            if (parsed.id === 3 && parsed.result) {
              console.log("✓ Prompt completed successfully!");
              console.log("✅ PASS: resource_link handling working");
              break;
            }
            
          } catch (error) {
            // Not JSON, continue
          }
        }
      }
    }
    
  } catch (error) {
    console.error("Test error:", error);
  } finally {
    proc.kill();
  }
}

await testResourceLink();