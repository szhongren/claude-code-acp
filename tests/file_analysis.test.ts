#!/usr/bin/env bun

async function testFileAnalysis() {
  console.log("Testing file analysis to trigger Read tool usage...");
  
  const proc = Bun.spawn(["./dist/server", "--debug", "--log-file", "/tmp/file-analysis.log"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    const reader = proc.stdout!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sessionId = "";
    
    // Send initialize
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
    console.log("✓ Sent initialize");

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
              // Don't send the file analysis prompt yet - wait for Claude's greeting first
            }
            
            // Wait for session update with Claude's initial greeting
            if (parsed.method === "session/update" && 
                parsed.params?.sessionId === sessionId && 
                parsed.params?.update?.sessionUpdate === "agent_message_chunk") {
              console.log("✓ Received Claude's initial greeting, now sending file analysis request");
              
              // Now send a prompt that should trigger Read tool usage
              const promptMessage = JSON.stringify({
                jsonrpc: "2.0",
                id: 4, // Use id 4 since the greeting was probably id 3
                method: "session/prompt",
                params: {
                  sessionId,
                  prompt: [
                    {
                      type: "text",
                      text: "Please read and analyze the server.ts file. Tell me what the main class is and what it does."
                    }
                  ]
                }
              }) + "\n";
              
              proc.stdin!.write(promptMessage);
              console.log("✓ Sent prompt asking to analyze server.ts file");
            }
            
            if ((parsed.id === 3 || parsed.id === 4) && parsed.result) {
              console.log("✓ Prompt completed!");
              console.log("Check /tmp/file-analysis.log for tool usage sequence!");
              // Wait a bit more to see if there are any session updates
              setTimeout(() => {
                proc.kill();
              }, 2000);
              return;
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

await testFileAnalysis();