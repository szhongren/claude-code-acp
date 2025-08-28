#!/usr/bin/env bun

async function interactiveTest() {
  console.log("Starting interactive server test...");
  
  const proc = Bun.spawn(["./dist/server"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    // Send initialize first
    const initMessage = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {}
      }
    }) + "\n";
    
    proc.stdin!.write(initMessage);
    console.log("✓ Sent initialize");

    // Read response using stream reader
    const reader = proc.stdout!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    
    // Read initialize response
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      
      const lines = buffer.split('\n');
      buffer = lines.pop() || ""; // Keep incomplete line in buffer
      
      for (const line of lines) {
        if (line.trim()) {
          console.log("Received:", line);
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === 1 && parsed.result) {
              console.log("✓ Initialize successful");
              
              // Now send session/new
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
              const sessionId = parsed.result.sessionId;
              console.log("✓ Got session ID:", sessionId);
              
              // Now send prompt with correct session ID
              const promptMessage = JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "session/prompt",
                params: {
                  sessionId,
                  prompt: [
                    {
                      type: "text",
                      text: "Help me create a plan for building a web scraper"
                    }
                  ]
                }
              }) + "\n";
              
              proc.stdin!.write(promptMessage);
              console.log("✓ Sent prompt");
            }
            
            if (parsed.method === "session/update") {
              console.log("📢 Session update:", parsed.params.update.sessionUpdate);
              if (parsed.params.update.sessionUpdate === "plan") {
                console.log("🎯 Found TodoWrite plan update!");
                console.log("Plan entries:", parsed.params.update.entries.length);
              }
              if (parsed.params.update.sessionUpdate === "agent_message_chunk") {
                console.log("💬 Agent message:", parsed.params.update.content.text.substring(0, 100) + "...");
              }
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
    // Check stderr for any errors
    try {
      const errorOutput = await proc.stderr!.text();
      if (errorOutput.trim()) {
        console.log("Error output:", errorOutput);
      }
    } catch (e) {
      // ignore
    }
    proc.kill();
  }
}

await interactiveTest();