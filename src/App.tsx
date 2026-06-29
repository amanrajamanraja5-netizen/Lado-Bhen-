import { useState, useEffect, useRef } from "react";
import { 
  Mic, 
  MicOff, 
  Power, 
  Volume2, 
  VolumeX, 
  Sparkles, 
  Heart, 
  ExternalLink, 
  AlertCircle, 
  RefreshCw, 
  Info,
  Laptop
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// --- AUDIO HELPERS ---

// Convert PCM16 ArrayBuffer to Base64
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Convert Base64 back to ArrayBuffer
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

// Audio states for the visual indicators
type AppState = "disconnected" | "connecting" | "idle" | "listening" | "speaking" | "error";

// Cute sibling banner banter lines to showcase Lado Bhen's personality
const SISTER_BANTER = [
  "Clean your room first, then let's talk, bhaiya! 🧹",
  "Are you wearing that shirt again? Please tell me no. 🤦‍♀️",
  "I'm clearly the smarter sibling, let's just agree on that. 🤫",
  "Of course I care about you! Now hand over the TV remote. 📺",
  "Pappu, don't stay up too late, or I'm telling Mumma! 🤫",
  "Don't worry, bhaiya, your Lado Bhen has your back. Always! 💪❤️",
  "Are you trying to sound smart? It's working... a tiny bit. 😉",
  "I'm always watching. So don't even think of doing anything silly! 👀",
  "Aww, look who came running to their sister. Need advice? 💅",
  "You're lucky to have an AI sister as cool and witty as me. 👑",
];

export default function App() {
  const [appState, setAppState] = useState<AppState>("disconnected");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  
  // Audio volume indicators for visualization
  const [micLevel, setMicLevel] = useState<number>(0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  
  // captions / transcript states
  const [captions, setCaptions] = useState<string>("");
  const [captionTimeout, setCaptionTimeout] = useState<NodeJS.Timeout | null>(null);

  // Bannister message rotation
  const [banterIndex, setBanterIndex] = useState<number>(0);

  // Tool Call state (backup link if window.open is blocked by browser)
  const [recentToolCall, setRecentToolCall] = useState<{
    id: string;
    url: string;
    siteName?: string;
  } | null>(null);

  // Refs for audio context and node management
  const wsRef = useRef<WebSocket | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  
  // Audio queue refs for gapless response playback
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Rotate sister banter quotes
  useEffect(() => {
    const interval = setInterval(() => {
      setBanterIndex((prev) => (prev + 1) % SISTER_BANTER.length);
    }, 9000);
    return () => clearInterval(interval);
  }, []);

  // Update mic volume level from analyser node
  const updateMicLevel = () => {
    if (analyserRef.current && appState === "listening") {
      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
      analyserRef.current.getByteFrequencyData(dataArray);
      
      // Calculate average volume
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const average = sum / dataArray.length;
      setMicLevel(average / 128.0); // Normalize between 0 and 2
    }
    animationFrameRef.current = requestAnimationFrame(updateMicLevel);
  };

  useEffect(() => {
    if (appState === "listening") {
      animationFrameRef.current = requestAnimationFrame(updateMicLevel);
    } else {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      setMicLevel(0);
    }
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [appState]);

  // Clean up floating captions after inactivity
  const showCaption = (text: string) => {
    setCaptions(text);
    if (captionTimeout) clearTimeout(captionTimeout);
    
    const timeout = setTimeout(() => {
      setCaptions("");
    }, 6000);
    setCaptionTimeout(timeout);
  };

  // Stop response audio playback
  const stopAllResponseAudio = () => {
    activeSourcesRef.current.forEach((src) => {
      try {
        src.stop();
      } catch (err) {
        // Already stopped
      }
    });
    activeSourcesRef.current = [];
    if (outputAudioCtxRef.current) {
      nextStartTimeRef.current = outputAudioCtxRef.current.currentTime;
    }
  };

  // Playback PCM chunk
  const playResponseAudioChunk = (base64Chunk: string) => {
    if (!outputAudioCtxRef.current) return;

    try {
      // Create output audio context if it was suspended
      if (outputAudioCtxRef.current.state === "suspended") {
        outputAudioCtxRef.current.resume();
      }

      const buffer = base64ToArrayBuffer(base64Chunk);
      const int16Data = new Int16Array(buffer);
      const float32Data = new Float32Array(int16Data.length);
      for (let i = 0; i < int16Data.length; i++) {
        float32Data[i] = int16Data[i] / 32768.0;
      }

      // Live API delivers audio at 24000Hz (24kHz)
      const audioBuffer = outputAudioCtxRef.current.createBuffer(1, float32Data.length, 24000);
      audioBuffer.copyToChannel(float32Data, 0);

      const source = outputAudioCtxRef.current.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(outputAudioCtxRef.current.destination);

      const currentTime = outputAudioCtxRef.current.currentTime;
      if (nextStartTimeRef.current < currentTime) {
        // Fallback buffer time
        nextStartTimeRef.current = currentTime + 0.02;
      }

      source.start(nextStartTimeRef.current);
      
      activeSourcesRef.current.push(source);
      source.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source);
      };

      // Advance start time by chunk duration
      nextStartTimeRef.current += audioBuffer.duration;
      
    } catch (err) {
      console.error("Error playing audio chunk:", err);
    }
  };

  // Establish full websocket connection and audio capture
  const handleConnect = async () => {
    setAppState("connecting");
    setErrorMessage(null);
    setRecentToolCall(null);

    try {
      // 1. Initialize Web Audio contexts
      // Microphone capture audio context runs at 16000Hz (16kHz) for PCM streaming
      inputAudioCtxRef.current = new AudioContext({ sampleRate: 16000 });
      outputAudioCtxRef.current = new AudioContext({ sampleRate: 24000 });
      nextStartTimeRef.current = outputAudioCtxRef.current.currentTime;

      // 2. Request user microphone permissions
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      // 3. Establish WebSocket connection to port 3000 custom route /ws
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      console.log("Connecting to WebSocket:", wsUrl);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("WebSocket connection established");
      };

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "ready") {
            setAppState("idle");
            showCaption("Lado Bhen is ready! Speak, bhaiya!");
            
            // Set up mic input processing node once connected
            if (inputAudioCtxRef.current && mediaStreamRef.current) {
              const inputCtx = inputAudioCtxRef.current;
              sourceNodeRef.current = inputCtx.createMediaStreamSource(mediaStreamRef.current);
              
              // Standard processor node
              processorNodeRef.current = inputCtx.createScriptProcessor(2048, 1, 1);
              
              // Set up analyzer node to show mic animations
              analyserRef.current = inputCtx.createAnalyser();
              analyserRef.current.fftSize = 64;
              
              sourceNodeRef.current.connect(analyserRef.current);
              analyserRef.current.connect(processorNodeRef.current);
              processorNodeRef.current.connect(inputCtx.destination);

              // Capture mic PCM and stream to WS
              processorNodeRef.current.onaudioprocess = (e) => {
                if (isMuted) return; // Drop audio buffers if muted
                
                const inputData = e.inputBuffer.getChannelData(0);
                
                // Convert Float32Array to Int16 PCM
                const pcm16 = new Int16Array(inputData.length);
                let hasSignal = false;
                for (let i = 0; i < inputData.length; i++) {
                  const sample = Math.max(-1, Math.min(1, inputData[i]));
                  pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
                  if (Math.abs(sample) > 0.01) {
                    hasSignal = true;
                  }
                }

                // If user is speaking, update state to listening
                if (hasSignal && appState !== "speaking" && appState !== "connecting") {
                  setAppState("listening");
                }

                // Send PCM buffer base64 to server
                if (ws.readyState === WebSocket.OPEN) {
                  const base64 = arrayBufferToBase64(pcm16.buffer);
                  ws.send(JSON.stringify({ type: "audio", data: base64 }));
                }
              };
            }
          } else if (msg.type === "audio") {
            setAppState("speaking");
            playResponseAudioChunk(msg.data);
          } else if (msg.type === "transcript") {
            // Elegant speech floating captions
            showCaption(msg.data);
          } else if (msg.type === "interrupted") {
            console.log("Interrupted by user speech! Clearing playback queue.");
            stopAllResponseAudio();
            setAppState("listening");
            showCaption("Ah! Speak, bhaiya, I am listening.");
          } else if (msg.type === "turnComplete") {
            setAppState("idle");
          } else if (msg.type === "toolCall") {
            // Handle browser action requested by Gemini
            if (msg.name === "openWebsite" && msg.args?.url) {
              const destUrl = msg.args.url;
              const nameOfSite = msg.args.siteName || "Requested Website";
              
              console.log(`Executing toolCall: openWebsite URL=${destUrl}`);
              
              // Register tool call state so user can manually tap if popup-blocked
              setRecentToolCall({
                id: msg.id,
                url: destUrl,
                siteName: nameOfSite
              });

              // Try opening immediately
              const openedWindow = window.open(destUrl, "_blank");
              const isBlocked = !openedWindow || openedWindow.closed || typeof openedWindow.closed === "undefined";
              
              // Immediately respond back to Gemini Live session
              ws.send(JSON.stringify({
                type: "toolResponse",
                id: msg.id,
                name: "openWebsite",
                response: {
                  output: {
                    success: !isBlocked,
                    message: isBlocked 
                      ? "The website open command was sent, but the user's browser blocked the popup. A visual link was shown so they can click it manually."
                      : "Website opened successfully in a new tab."
                  }
                }
              }));

              showCaption(`🔗 Opened ${nameOfSite}! Check your browser tabs.`);
            }
          } else if (msg.type === "error") {
            setAppState("error");
            setErrorMessage(msg.message);
          }
        } catch (err) {
          console.error("Error processing websocket message:", err);
        }
      };

      ws.onerror = (err) => {
        console.error("WS error:", err);
        setAppState("error");
        setErrorMessage("A connection error occurred. Make sure your GEMINI_API_KEY is configured.");
      };

      ws.onclose = () => {
        console.log("WebSocket connection closed.");
        handleDisconnect();
      };

    } catch (err: any) {
      console.error("Initialization failed:", err);
      setAppState("error");
      setErrorMessage(err.message || "Failed to initialize audio or connect to the server.");
    }
  };

  // Clean disconnect
  const handleDisconnect = () => {
    setAppState("disconnected");
    setMicLevel(0);
    setCaptions("");
    setRecentToolCall(null);

    // Stop and close everything
    stopAllResponseAudio();

    if (processorNodeRef.current) {
      processorNodeRef.current.disconnect();
      processorNodeRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (inputAudioCtxRef.current) {
      inputAudioCtxRef.current.close().catch(() => {});
      inputAudioCtxRef.current = null;
    }
    if (outputAudioCtxRef.current) {
      outputAudioCtxRef.current.close().catch(() => {});
      outputAudioCtxRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  };

  // Mute microphone
  const toggleMute = () => {
    setIsMuted(!isMuted);
    showCaption(!isMuted ? "Muted! Your sister can't hear you now." : "Unmuted! Speak freely, bhaiya.");
  };

  // Helper for status styling
  const getStatusInfo = () => {
    switch (appState) {
      case "disconnected":
        return { text: "OFFLINE", color: "bg-neutral-600 text-neutral-300 ring-neutral-500/20" };
      case "connecting":
        return { text: "CONNECTING...", color: "bg-amber-500/20 text-amber-300 ring-amber-500/30 animate-pulse" };
      case "idle":
        return { text: "READY & WATCHING 👀", color: "bg-emerald-500/20 text-emerald-400 ring-emerald-500/30" };
      case "listening":
        return { text: "LISTENING...", color: "bg-rose-500/20 text-rose-300 ring-rose-500/30 animate-pulse" };
      case "speaking":
        return { text: "LADO BHEN IS SPEAKING 🗣️", color: "bg-violet-500/20 text-violet-300 ring-violet-500/30" };
      case "error":
        return { text: "SYSTEM ERROR", color: "bg-red-500/20 text-red-400 ring-red-500/30" };
    }
  };

  const status = getStatusInfo();

  return (
    <div className="relative min-h-screen bg-[#05050a] text-white flex flex-col items-center justify-between overflow-hidden font-sans select-none pb-8">
      
      {/* Background Ambience & Pulse Glows */}
      <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,_rgba(124,58,237,0.1)_0%,_transparent_70%)]" />
        
        {/* State-dependent core glow behind the main screen */}
        <motion.div 
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[350px] h-[350px] rounded-full blur-[100px]"
          animate={{
            backgroundColor: 
              appState === "listening" ? "rgba(244, 63, 94, 0.12)" : 
              appState === "speaking" ? "rgba(139, 92, 246, 0.15)" : 
              appState === "connecting" ? "rgba(245, 158, 11, 0.08)" : 
              "rgba(99, 102, 241, 0.04)",
            scale: appState === "speaking" ? [1, 1.15, 1] : [1, 1.05, 1],
          }}
          transition={{
            duration: appState === "speaking" ? 1.5 : 4,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
      </div>

      {/* HEADER SECTION */}
      <header className="relative w-full max-w-4xl mx-auto px-6 pt-6 flex justify-between items-start z-10">
        <div>
          <h1 className="text-4xl font-black tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-violet-400 via-fuchsia-400 to-pink-500 font-display">
            LADO BHEN
          </h1>
          <p className="text-xs font-mono uppercase tracking-widest text-violet-400 mt-1 opacity-80">
            Active Session &bull; Gemini 3.1 Live
          </p>
        </div>
        <div className="flex gap-4">
          <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-full px-4 py-2 backdrop-blur-md">
            <div className={`w-2 h-2 rounded-full transition-all duration-300 ${appState !== "disconnected" && appState !== "error" ? "bg-green-400 shadow-[0_0_8px_#4ade80]" : "bg-neutral-500"}`} />
            <span className="text-xs font-bold tracking-wider opacity-90 uppercase">
              {appState === "disconnected" ? "Offline" : appState === "connecting" ? "Connecting" : "Live Audio Only"}
            </span>
          </div>
        </div>
      </header>

      {/* SISTER BANTER BAR - Cute sibling Quotes */}
      <section className="relative w-full max-w-md mx-auto px-6 z-10 flex justify-center mt-4">
        <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-6 w-full text-center relative shadow-2xl">
          <div className="absolute top-2 left-2 flex gap-1">
            <Heart className="w-3.5 h-3.5 text-rose-500 fill-rose-500/20" />
          </div>
          
          <AnimatePresence mode="wait">
            <motion.p 
              key={banterIndex}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.4 }}
              className="text-lg font-medium leading-relaxed text-neutral-200"
            >
              "{SISTER_BANTER[banterIndex]}"
            </motion.p>
          </AnimatePresence>
        </div>
      </section>

      {/* CENTRAL CORE ORB / INTERACTION ARENA */}
      <main className="relative flex-1 flex flex-col items-center justify-center w-full max-w-md mx-auto px-6 py-4 z-10">
        
        <div className="relative w-80 h-80 flex items-center justify-center">
          
          {/* Glowing Aura Outer Ring */}
          <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-violet-600/30 via-fuchsia-600/30 to-pink-600/30 blur-3xl" />
          <div className="absolute inset-0 border-2 border-white/5 rounded-full scale-110" />
          <div className="absolute inset-0 border border-white/10 rounded-full scale-125 opacity-30" />

          {/* Core Orb Sphere */}
          <motion.button
            id="core-orb-button"
            onClick={appState === "disconnected" ? handleConnect : undefined}
            disabled={appState === "connecting"}
            className={`relative w-full h-full rounded-full bg-[#0a0a14] border border-white/20 shadow-2xl flex flex-col items-center justify-center overflow-hidden z-20 cursor-pointer focus:outline-none transition-all duration-500 select-none
              ${appState === "disconnected" ? "hover:border-rose-500/40" : ""}
              ${appState === "connecting" ? "border-amber-500/50" : ""}
              ${appState === "idle" ? "border-rose-500/30" : ""}
              ${appState === "listening" ? "border-rose-500" : ""}
              ${appState === "speaking" ? "border-violet-500" : ""}
            `}
            animate={
              appState === "listening" 
                ? { scale: 1 + micLevel * 0.08 } 
                : appState === "speaking" 
                ? { scale: [1, 1.03, 0.99, 1.01, 1] } 
                : appState === "connecting" 
                ? { scale: [1, 0.97, 1.03, 1] }
                : { scale: [1, 1.01, 1] }
            }
            transition={
              appState === "listening" 
                ? { type: "spring", stiffness: 120, damping: 12 } 
                : { duration: 4, repeat: Infinity, ease: "easeInOut" }
            }
          >
            {/* Spinning/revolving elements inside the core during connection */}
            {appState === "connecting" && (
              <motion.div 
                className="absolute inset-4 rounded-full border-r-2 border-t-2 border-amber-400"
                animate={{ rotate: 360 }}
                transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}
              />
            )}

            {/* Glowing internal sister visual matrix */}
            <div className={`absolute inset-0 rounded-full transition-all duration-700 opacity-40
              ${appState === "idle" ? "bg-gradient-radial from-rose-500/20 via-transparent to-transparent blur-md" : ""}
              ${appState === "listening" ? "bg-gradient-radial from-rose-500/40 via-pink-500/10 to-transparent blur-lg" : ""}
              ${appState === "speaking" ? "bg-gradient-radial from-violet-400/40 via-indigo-500/10 to-transparent blur-lg" : ""}
            `} />

            {/* Live Audio Animated Waveform inside the Core Orb */}
            <div className="relative flex flex-col items-center justify-center z-10 text-center p-4 w-full h-full select-none">
              
              <AnimatePresence mode="wait">
                {appState === "speaking" && (
                  <motion.div 
                    key="speaking-wave"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    className="flex items-end gap-[6px] h-24 mb-2 justify-center"
                  >
                    <motion.div className="w-2 bg-gradient-to-t from-violet-500 to-fuchsia-400 rounded-full" animate={{ height: [16, 48, 20, 64, 16] }} transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }} />
                    <motion.div className="w-2 bg-gradient-to-t from-violet-500 to-fuchsia-400 rounded-full" animate={{ height: [24, 72, 32, 88, 24] }} transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut", delay: 0.1 }} />
                    <motion.div className="w-2 bg-gradient-to-t from-violet-500 to-fuchsia-400 rounded-full" animate={{ height: [32, 60, 48, 96, 32] }} transition={{ duration: 1.3, repeat: Infinity, ease: "easeInOut", delay: 0.25 }} />
                    <motion.div className="w-2 bg-gradient-to-t from-violet-500 to-fuchsia-400 rounded-full" animate={{ height: [20, 56, 28, 76, 20] }} transition={{ duration: 1.0, repeat: Infinity, ease: "easeInOut", delay: 0.15 }} />
                    <motion.div className="w-2 bg-gradient-to-t from-violet-500 to-fuchsia-400 rounded-full" animate={{ height: [28, 80, 36, 84, 28] }} transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut", delay: 0.3 }} />
                    <motion.div className="w-2 bg-gradient-to-t from-violet-500 to-fuchsia-400 rounded-full" animate={{ height: [12, 40, 20, 52, 12] }} transition={{ duration: 0.8, repeat: Infinity, ease: "easeInOut", delay: 0.05 }} />
                  </motion.div>
                )}

                {appState === "listening" && (
                  <motion.div 
                    key="listening-wave"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    className="flex items-end gap-[6px] h-24 mb-2 justify-center"
                  >
                    <div className="w-2 bg-gradient-to-t from-rose-500 to-pink-400 rounded-full transition-all duration-75" style={{ height: `${Math.max(16, micLevel * 50)}px` }} />
                    <div className="w-2 bg-gradient-to-t from-rose-500 to-pink-400 rounded-full transition-all duration-75" style={{ height: `${Math.max(24, micLevel * 70)}px` }} />
                    <div className="w-2 bg-gradient-to-t from-rose-500 to-pink-400 rounded-full transition-all duration-75" style={{ height: `${Math.max(32, micLevel * 90)}px` }} />
                    <div className="w-2 bg-gradient-to-t from-rose-500 to-pink-400 rounded-full transition-all duration-75" style={{ height: `${Math.max(20, micLevel * 60)}px` }} />
                    <div className="w-2 bg-gradient-to-t from-rose-500 to-pink-400 rounded-full transition-all duration-75" style={{ height: `${Math.max(28, micLevel * 78)}px` }} />
                    <div className="w-2 bg-gradient-to-t from-rose-500 to-pink-400 rounded-full transition-all duration-75" style={{ height: `${Math.max(12, micLevel * 45)}px` }} />
                  </motion.div>
                )}

                {appState === "disconnected" && (
                  <motion.div
                    key="disconnected"
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.8, opacity: 0 }}
                    className="flex flex-col items-center gap-2 text-rose-400"
                  >
                    <Power className="w-12 h-12 drop-shadow-[0_0_15px_rgba(244,63,94,0.5)] animate-pulse" />
                    <span className="text-xs font-bold tracking-[0.3em] uppercase font-mono">WAKE UP SISTAH</span>
                  </motion.div>
                )}

                {appState === "connecting" && (
                  <motion.div
                    key="connecting"
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.8, opacity: 0 }}
                    className="flex flex-col items-center gap-1 text-amber-300"
                  >
                    <RefreshCw className="w-10 h-10 animate-spin" />
                    <span className="text-[10px] font-mono tracking-[0.2em] uppercase font-bold">TUNING VOICE...</span>
                  </motion.div>
                )}

                {appState === "idle" && (
                  <motion.div
                    key="idle"
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="flex flex-col items-center gap-2"
                  >
                    <Mic className="w-10 h-10 text-rose-400" />
                    <span className="text-[10px] font-mono tracking-[0.3em] uppercase text-rose-400 font-bold">
                      बात करें भैया
                    </span>
                  </motion.div>
                )}

                {appState === "error" && (
                  <motion.div
                    key="error"
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.8, opacity: 0 }}
                    className="flex flex-col items-center gap-1 text-red-400"
                  >
                    <AlertCircle className="w-10 h-10" />
                    <span className="text-[10px] font-mono tracking-widest uppercase">TAP TO RETRY</span>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Central text feedback inside the orb matching the theme footer */}
              {appState !== "disconnected" && appState !== "connecting" && (
                <div className="absolute bottom-8 left-1/2 -translate-x-1/2 text-[10px] font-mono tracking-[0.3em] uppercase text-fuchsia-400 font-bold whitespace-nowrap">
                  {isMuted ? "Lado Bhen is Muted" : appState === "listening" ? "Listening to you..." : appState === "speaking" ? "Lado Bhen is Speaking..." : "Lado Bhen is Ready"}
                </div>
              )}
            </div>
          </motion.button>

        </div>

        {/* Real-time speech subtitle captions */}
        <div className="h-20 w-full text-center flex items-center justify-center mt-4 px-4 select-text">
          <AnimatePresence mode="wait">
            {captions && (
              <motion.div
                key={captions}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="max-w-md font-medium text-white text-base font-sans leading-relaxed bg-white/5 backdrop-blur-xl border border-white/10 px-6 py-3 rounded-2xl shadow-2xl"
              >
                {captions}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

      </main>

      {/* POPUP BLOCKER BACKUP TOOL LINK TO ENSURE FUNCTION CALLING WORKS PERFECTLY */}
      <AnimatePresence>
        {recentToolCall && (
          <motion.div 
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 30 }}
            className="w-full max-w-sm mx-auto px-6 mb-4 z-10"
          >
            <div className="bg-gradient-to-r from-violet-950/80 to-neutral-900/90 border border-violet-500/30 rounded-2xl p-4 shadow-2xl flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-1 text-violet-400 font-bold text-xs uppercase font-mono tracking-wider">
                  <Laptop className="w-4 h-4" />
                  Tool: Browser Action
                </div>
                <p className="text-xs text-neutral-300 truncate">
                  Lado Bhen requested opening <span className="font-semibold text-rose-400">{recentToolCall.siteName || recentToolCall.url}</span>
                </p>
              </div>
              <a 
                href={recentToolCall.url}
                target="_blank"
                rel="noreferrer"
                className="bg-violet-500 hover:bg-violet-600 text-white font-semibold text-xs px-3 py-2 rounded-xl flex items-center gap-1 shadow-lg shadow-violet-500/20 active:scale-95 transition-all"
              >
                Go <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* DOCK BAR CONTROLS - RE-STYLIZED FOR VIBRANT PALETTE THEME */}
      <footer className="relative w-full max-w-4xl mx-auto px-6 z-10 flex flex-col items-center">
        {appState !== "disconnected" && appState !== "connecting" && (
          <motion.div 
            className="w-full flex items-center justify-between bg-white/5 border border-white/10 rounded-2xl p-4 md:p-6 backdrop-blur-xl shadow-2xl"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            {/* Left slot: Function/Action log */}
            <div className="w-1/3 flex items-center gap-4">
              <div className="flex flex-col text-left">
                <span className="text-[10px] font-mono text-white/40 uppercase tracking-tighter">Function Execution</span>
                <span className="text-sm text-green-400 font-bold truncate max-w-[120px] md:max-w-none">
                  {recentToolCall ? `openWebsite("${recentToolCall.siteName || 'Site'}")` : "Listening for tools..."}
                </span>
              </div>
            </div>

            {/* Middle slot: Interaction Center trigger (Mute / Unmute sister) */}
            <div className="w-1/3 flex justify-center gap-3">
              <button
                onClick={toggleMute}
                className={`p-4 rounded-full transition-all duration-300 active:scale-90 select-none cursor-pointer border
                  ${isMuted 
                    ? "bg-red-500/20 text-red-400 border-red-500/30" 
                    : "bg-white/5 hover:bg-white/10 text-white border-white/10"
                  }
                `}
                title={isMuted ? "Unmute Mic" : "Mute Mic"}
              >
                {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
              </button>
            </div>

            {/* Right slot: Session stats & Disconnect */}
            <div className="w-1/3 flex justify-end items-center gap-4 md:gap-6 text-right">
              <div className="hidden sm:block">
                <span className="block text-[10px] font-mono text-white/40 uppercase tracking-widest">Active Mode</span>
                <span className="text-sm font-bold text-violet-400">Sibling Banter</span>
              </div>
              <button
                onClick={handleDisconnect}
                className="px-5 py-2 md:px-6 md:py-2.5 bg-red-500/10 border border-red-500/30 rounded-full text-red-500 text-xs font-bold uppercase tracking-wider hover:bg-red-500/20 active:scale-95 transition-all cursor-pointer"
                title="Disconnect"
              >
                Disconnect
              </button>
            </div>
          </motion.div>
        )}

        {appState === "disconnected" && (
          <motion.button
            onClick={handleConnect}
            className="relative group w-full max-w-sm"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <div className="absolute -inset-1.5 bg-gradient-to-r from-violet-600 to-pink-600 rounded-full blur opacity-40 group-hover:opacity-70 transition duration-1000"></div>
            <div className="relative w-full bg-gradient-to-br from-violet-500 to-fuchsia-600 hover:from-violet-600 hover:to-fuchsia-700 text-white font-black text-sm py-4 px-8 rounded-full shadow-[0_0_30px_rgba(139,92,246,0.5)] border border-white/20 select-none active:scale-[0.98] transition-all cursor-pointer flex items-center justify-center gap-2 tracking-[0.2em] font-display" >
              <Power className="w-4 h-4" /> CONNECT VOICE CELL
            </div>
          </motion.button>
        )}

        {appState === "error" && (
          <motion.button
            onClick={handleConnect}
            className="w-full max-w-sm bg-neutral-900 border border-neutral-800 hover:border-red-500/40 text-red-400 font-bold text-sm py-4 px-6 rounded-full shadow-xl select-none active:scale-[0.98] transition-all cursor-pointer flex items-center justify-center gap-2 font-mono tracking-wider"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <RefreshCw className="w-4 h-4 animate-spin-slow" /> RECONNECT CORE
          </motion.button>
        )}

        {/* Informative instructions for first time user */}
        <p className="text-[10px] text-neutral-500 font-medium tracking-normal mt-4 text-center">
          Tap the center core to begin your session. Powered by Gemini 3.1 Live Audio.
        </p>
      </footer>

      {/* Error Message display block */}
      <AnimatePresence>
        {errorMessage && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="absolute top-4 left-4 right-4 z-50 bg-red-950/95 border-2 border-red-500/40 p-4 rounded-2xl shadow-2xl flex items-start gap-3 backdrop-blur-md"
          >
            <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <h4 className="text-xs font-bold text-red-300 uppercase tracking-widest font-mono mb-1">Session Failure</h4>
              <p className="text-xs text-red-200 leading-relaxed font-sans">{errorMessage}</p>
              <button 
                onClick={() => setErrorMessage(null)}
                className="mt-2 text-[10px] font-bold text-neutral-300 hover:text-white uppercase tracking-wider underline cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
