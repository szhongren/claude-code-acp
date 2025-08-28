#!/usr/bin/env bun

async function simpleTest() {
  console.log("Starting simple server test...");
  
  const proc = Bun.spawn(["./dist/server"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Send initialize message
  const initMessage = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {}
    }
  }) + "\n";
  
  // Send session/new message  
  const sessionMessage = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: {
      mcpServers: [],
      cwd: process.cwd()
    }
  }) + "\n";
  
  proc.stdin!.write(initMessage);
  proc.stdin!.write(sessionMessage);
  
  // Wait a bit for session creation, then send prompt
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Use a dummy session ID for now - the server will assign sessions internally
  const promptMessage = JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: {
      sessionId: "dummy-session-id",
      prompt: [
        {
          type: "text",
          text: "Help me create a plan for building a web scraper"
        }
      ]
    }
  }) + "\n";
  
  proc.stdin!.write(promptMessage);
  proc.stdin!.end();
  
  console.log("✓ Sent initialize, session/new, and prompt messages");
  
  // Read response with timeout (longer since Claude needs to respond)
  const timeout = new Promise(resolve => setTimeout(resolve, 10000));
  const outputPromise = proc.stdout!.text();
  const errorPromise = proc.stderr!.text();
  
  await timeout;
  
  try {
    proc.kill();
    const output = await outputPromise;
    const errorOutput = await errorPromise;
    
    console.log("Raw output:", output);
    if (errorOutput.trim()) {
      console.log("Error output:", errorOutput);
    }
  } catch (error) {
    console.error("Process error:", error);
  }
}

await simpleTest();