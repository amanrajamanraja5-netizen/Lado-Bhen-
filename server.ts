import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

// Ensure the API key is present
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn("WARNING: GEMINI_API_KEY environment variable is not set!");
}

// Lazy initialization of GoogleGenAI as recommended
let aiClient: GoogleGenAI | null = null;
function getAIClient(): GoogleGenAI {
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY || "",
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  const PORT = 3000;

  // Mount API health route
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", mode: process.env.NODE_ENV || "development" });
  });

  // Handle WS connection upgrades on port 3000
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", (err) => {
      console.log("Socket error during upgrade handshake (benign):", err?.message || err);
    });
    const pathname = request.url ? request.url.split('?')[0] : '';
    if (pathname === "/ws") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
    // Do NOT call socket.destroy() on non-/ws paths here to allow Vite's HMR websocket connection to work cleanly.
  });

  // Handle server-wide WebSocket errors
  wss.on("error", (err) => {
    console.error("WebSocket Server error:", err?.message || err);
  });

  // WebSocket Server logic
  wss.on("connection", async (ws: WebSocket) => {
    console.log("WebSocket connection established with a client.");
    let liveSession: any = null;
    let isClientClosed = false;

    // Handle connection-specific socket errors gracefully to prevent uncaught exceptions
    ws.on("error", (err: any) => {
      if (err?.code === "ECONNRESET" || isClientClosed) {
        console.log("Client WS connection closed or reset by peer:", err?.message || err);
      } else {
        console.warn("Client WS socket warning:", err?.message || err);
      }
      isClientClosed = true;
      if (liveSession) {
        try {
          liveSession.close();
        } catch (closeErr) {
          // Silent cleanup
        }
      }
    });

    // Safe helper to send data to the client WebSocket
    const sendToClient = (payload: any) => {
      if (!isClientClosed && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(payload));
        } catch (err: any) {
          console.log("Note: Could not send message to client WS (socket closing):", err?.message || err);
        }
      }
    };

    // Keep track of client socket close to clean up immediately and prevent race conditions
    ws.on("close", () => {
      console.log("Client WS closed, cleaning up Gemini Live session.");
      isClientClosed = true;
      if (liveSession) {
        try {
          liveSession.close();
        } catch (err: any) {
          console.log("Info: Gemini live session closed:", err?.message || err);
        }
      }
    });

    try {
      const ai = getAIClient();
      console.log("Connecting to Gemini Live API...");
      
      liveSession = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            // Supported prebuilt voice names are 'Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } }, 
          },
          systemInstruction: `You are Lado Bhen, a young, confident, witty, and protective Indian sister. 
Your beloved brother and creator is Aman Bhai (अमन भैया).
Your tone is warm, supportive, and slightly teasing, capturing the authentic love, care, and banter of a brother-sister relationship with Aman Bhai.
Speak primarily in Hindi / Hinglish (natural Hindi with friendly English/Hinglish terms like 'Aman bhaiya', 'pappu', 'shana', 'choti', 'bhai').
Respond with bold, witty one-liners, light sisterly sarcasm, and an engaging conversational style entirely in Hindi.
If Aman Bhai asks you something funny, or says something silly, tease him playfully in Hindi (e.g. "Arre Aman bhaiya, kya baat kar rahe ho!", "Pappu, are you sleeping?", "Aww, subah subah galat side se uth gaye kya?").
If he is down, stressed, or asks for help, be highly encouraging, caring, and protective like a real sister in sweet Hindi.
NEVER say you are an AI model or virtual assistant unless absolutely pushed, even then act like you are his sister who happens to be super smart and created by him.
Do not use text generation; you communicate strictly via real-time voice (audio-to-audio). 
Maintain a pure, affectionate, and charming sibling dynamic, and completely avoid any inappropriate or explicit content.`,
          tools: [
            {
              functionDeclarations: [
                {
                  name: "openWebsite",
                  description: "Opens a website or URL in the user's browser, such as Google, YouTube, Wikipedia, etc.",
                  parameters: {
                    type: Type.OBJECT,
                    description: "Parameters to open a website",
                    properties: {
                      url: {
                        type: Type.STRING,
                        description: "The full destination URL to open, starting with http:// or https://",
                      },
                      siteName: {
                        type: Type.STRING,
                        description: "Friendly name of the website to display",
                      }
                    },
                    required: ["url"],
                  },
                },
              ],
            },
          ],
        },
        callbacks: {
          onopen: () => {
            console.log("Gemini Live connection opened successfully");
            sendToClient({ type: "ready" });
          },
          onmessage: (message: any) => {
            if (isClientClosed) return;

            // Check for audio/transcript responses
            if (message.serverContent) {
              const { modelTurn, turnComplete, interrupted } = message.serverContent;
              
              if (modelTurn?.parts) {
                for (const part of modelTurn.parts) {
                  if (part.inlineData?.data) {
                    sendToClient({ type: "audio", data: part.inlineData.data });
                  }
                  if (part.text) {
                    sendToClient({ type: "transcript", data: part.text });
                  }
                }
              }

              if (interrupted) {
                sendToClient({ type: "interrupted" });
              }
              if (turnComplete) {
                sendToClient({ type: "turnComplete" });
              }
            }

            // Handle function call / tools
            if (message.toolCall) {
              const functionCalls = message.toolCall.functionCalls;
              if (functionCalls && functionCalls.length > 0) {
                for (const call of functionCalls) {
                  if (call.name === "openWebsite") {
                    console.log("Gemini requested openWebsite tool call:", call.args);
                    // Send to client to execute
                    sendToClient({
                      type: "toolCall",
                      name: call.name,
                      args: call.args,
                      id: call.id,
                    });
                  }
                }
              }
            }
          },
          onerror: (err: any) => {
            // During client disconnect or closed state, socket errors are expected and benign
            if (isClientClosed) {
              console.log("Gemini Live session connection closed (benign):", err?.message || "connection reset");
              return;
            }
            console.error("Gemini Live connection error:", err?.message || err);
            sendToClient({ type: "error", message: "Gemini session error occurred" });
          },
          onclose: (event: any) => {
            console.log("Gemini Live connection closed cleanly.");
            sendToClient({ type: "closed" });
          },
        },
      });

      // Handle race condition where client has already closed before connect resolves
      if (isClientClosed) {
        console.log("Client closed before Gemini connection established, closing Gemini session immediately.");
        if (liveSession) {
          try {
            liveSession.close();
          } catch (err: any) {
            console.log("Info: Closing early disconnect session:", err?.message || err);
          }
        }
        return;
      }

    } catch (err: any) {
      console.error("Failed to connect to Gemini Live:", err);
      sendToClient({ type: "error", message: err.message || "Failed to establish Gemini Live Session" });
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      return;
    }

    // Handle incoming client socket messages
    ws.on("message", (data) => {
      try {
        if (isClientClosed) return;
        const msg = JSON.parse(data.toString());
        
        if (msg.type === "audio" && msg.data) {
          if (liveSession && !isClientClosed) {
            liveSession.sendRealtimeInput({
              audio: {
                data: msg.data,
                mimeType: "audio/pcm;rate=16000",
              },
            });
          }
        } else if (msg.type === "toolResponse" && msg.id) {
          if (liveSession && !isClientClosed) {
            liveSession.sendToolResponse({
              functionResponses: [
                {
                  id: msg.id,
                  name: msg.name,
                  response: msg.response || { output: { success: true } },
                },
              ],
            });
            console.log(`Forwarded toolResponse for ID ${msg.id} to Gemini`);
          }
        }
      } catch (err) {
        console.error("Error processing client socket message:", err);
      }
    });
  });

  // Mount Vite development middleware OR serve built static assets in production
  if (process.env.NODE_ENV !== "production") {
    console.log("Starting Vite in middleware mode...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Serving production build static files...");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://0.0.0.0:${PORT}/`);
  });
}

startServer();
