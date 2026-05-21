const TRANSLATION_CALL_URL = "https://api.openai.com/v1/realtime/translations/calls";

const targetLanguage = document.querySelector("#targetLanguage");
const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const muteAudio = document.querySelector("#muteAudio");
const apiKeyInput = document.querySelector("#apiKey");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const inputMeter = document.querySelector("#inputMeter");
const chunksSent = document.querySelector("#chunksSent");
const translatedTranscript = document.querySelector("#translatedTranscript");
const eventLog = document.querySelector("#eventLog");

let peerConnection = null;
let dataChannel = null;
let captureStream = null;
let meterContext = null;
let meterSource = null;
let meterAnalyser = null;
let meterTimer = null;
let translatedAudio = null;

// Load API Key from localStorage
const savedKey = localStorage.getItem("openai_api_key");
if (savedKey) {
  apiKeyInput.value = savedKey;
}

muteAudio.addEventListener("change", () => {
  if (translatedAudio) {
    translatedAudio.muted = muteAudio.checked;
  }
});

apiKeyInput.addEventListener("input", () => {
  localStorage.setItem("openai_api_key", apiKeyInput.value.trim());
});

startButton.addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    alert("Please enter your OpenAI API Key.");
    return;
  }

  clearTranscript();
  eventLog.innerHTML = "";
  setControls({ running: true });
  setStatus("Connecting to Microphone", "idle");

  try {
    captureStream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      } 
    });
    
    startInputMeter(captureStream);

    setStatus("Creating Realtime Translation session", "idle");
    const session = await createSession(apiKey, targetLanguage.value);

    setStatus("Connecting WebRTC", "idle");
    await connectRealtimeTranslation(session, captureStream);

    setStatus("Translating", "live");
  } catch (error) {
    logEvent("error", error instanceof Error ? error.message : String(error));
    await stop("Error occurred", "error");
  }
});

stopButton.addEventListener("click", async () => {
  await stop("Disconnected", "idle");
});

async function createSession(apiKey, language) {
  const response = await fetch("https://api.openai.com/v1/realtime/translations/client_secrets", {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      session: {
        model: "gpt-realtime-translate",
        audio: {
          input: {
            transcription: { model: "gpt-realtime-whisper" },
          },
          output: { language: language },
        },
      }
    }),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error?.message ?? "Failed to create session. Check your API key.");
  }

  return { client_secret: body.value, targetLanguage: language };
}

async function connectRealtimeTranslation(session, stream) {
  peerConnection = new RTCPeerConnection();
  dataChannel = peerConnection.createDataChannel("oai-events");

  translatedAudio = new Audio();
  translatedAudio.autoplay = true;
  translatedAudio.playsInline = true;
  translatedAudio.muted = muteAudio.checked;
  
  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection?.connectionState ?? "closed";
    chunksSent.textContent = state;
    logEvent("webrtc", state);
  };

  peerConnection.ontrack = ({ streams }) => {
    translatedAudio.srcObject = streams[0];
    void translatedAudio.play().catch((error) => logEvent("audio.play", error.message));
    logEvent("remote.audio", "Receiving translated audio");
  };

  dataChannel.onmessage = handleRealtimeEvent;

  // Add local microphone tracks to WebRTC
  for (const track of stream.getAudioTracks()) {
    peerConnection.addTrack(track, stream);
  }

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  const sdpResponse = await fetch(TRANSLATION_CALL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.client_secret}`,
      "Content-Type": "application/sdp",
    },
    body: offer.sdp,
  });

  const answerSdp = await sdpResponse.text();
  if (!sdpResponse.ok) {
    throw new Error("WebRTC Handshake failed");
  }

  await peerConnection.setRemoteDescription({
    type: "answer",
    sdp: answerSdp,
  });

  logEvent("system", `Connected to model for ${session.targetLanguage}`);
}

function startInputMeter(stream) {
  meterContext = new (window.AudioContext || window.webkitAudioContext)();
  meterSource = meterContext.createMediaStreamSource(stream);
  meterAnalyser = meterContext.createAnalyser();
  meterAnalyser.fftSize = 256;
  meterSource.connect(meterAnalyser);

  const samples = new Float32Array(meterAnalyser.fftSize);
  meterTimer = window.setInterval(() => {
    meterAnalyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / samples.length);
    inputMeter.value = Math.min(1, rms * 12);
  }, 100);
}

function handleRealtimeEvent(message) {
  let event;
  try {
    event = JSON.parse(message.data);
  } catch {
    return;
  }

  if (event.type === "error") {
    logEvent("error", JSON.stringify(event.error ?? event));
    return;
  }

  // Handle out-of-beta output text delta
  if (event.type === "session.output_transcript.delta" || event.type === "response.output_text.delta" || event.type === "response.audio_transcript.delta") {
    if (typeof event.delta === "string") {
      appendTranslatedText(event.delta);
    }
    return;
  }

  // Hide original language (do not append input transcript deltas to the UI)
  if (event.type === "session.input_transcript.delta" || event.type === "response.text.delta") {
    // Only translated text is displayed
    return;
  }
}

async function stop(message, state = "idle") {
  if (meterTimer) {
    window.clearInterval(meterTimer);
    meterTimer = null;
  }
  meterSource?.disconnect();
  meterAnalyser?.disconnect();
  if (meterContext?.state !== "closed") {
    await meterContext?.close();
  }

  dataChannel?.close();
  peerConnection?.close();
  
  if (translatedAudio) {
    translatedAudio.pause();
    translatedAudio.srcObject = null;
  }
  
  captureStream?.getTracks().forEach((track) => track.stop());
  
  inputMeter.value = 0;
  setControls({ running: false });
  setStatus(message, state);
}

function setControls({ running }) {
  startButton.disabled = running;
  stopButton.disabled = !running;
  targetLanguage.disabled = running;
}

function setStatus(message, state) {
  statusText.textContent = message;
  statusDot.className = `status-dot ${state === "live" ? "live" : ""} ${state === "error" ? "error" : ""}`;
}

function appendTranslatedText(text) {
  const placeholder = translatedTranscript.querySelector(".placeholder");
  if (placeholder) placeholder.remove();
  
  translatedTranscript.textContent += text;
  translatedTranscript.scrollTop = translatedTranscript.scrollHeight;
}

function clearTranscript() {
  translatedTranscript.innerHTML = '<div class="placeholder">Translations will appear here...</div>';
}

function logEvent(type, detail) {
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${type}: ${detail}`;
  eventLog.append(entry);
  eventLog.scrollTop = eventLog.scrollHeight;
}
