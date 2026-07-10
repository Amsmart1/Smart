/**
==========================================================
SmartLMS Centralized Voice Engine

VoiceEngine.js

Sections:

1. voiceSettings

2. speechSynthesis (Text-to-Speech)

3. speechRecognition (Speech-to-Text)

4. conversationManager

5. voiceEngine (Public API)

==========================================================
*/

// ==========================================================
// 1. VOICE SETTINGS
// ==========================================================

const voiceSettings = {
  language: "en-US",
  speechRate: 0.9,
  pitch: 1,
  volume: 1,
  preferredVoiceKeywords: [
    "Google",
    "Microsoft",
    "Natural"
  ],
  autoRestartListening: false,
  conversationMode: false
};

// ==========================================================
// GLOBAL STATE MANAGEMENT
// ==========================================================

const voiceState = {
  status: "idle",
  // idle | listening | speaking
  currentText: "",
  recognitionActive: false,
  speaking: false
};

/**
 * Triggers state change notifications.
 */
function updateVoiceState(updates) {
  Object.assign(voiceState, updates);
  if (typeof window.voiceEngine?.onStateChange === 'function') {
    try {
      window.voiceEngine.onStateChange(voiceState);
    } catch (e) {
      console.error("Error in voice state change callback:", e);
    }
  }
}

// ==========================================================
// 2. SPEECH SYNTHESIS (TEXT TO SPEECH)
// ==========================================================

const speechSynthesisEngine = {
  voices: [],

  loadVoices() {
    if (typeof speechSynthesis !== 'undefined') {
      this.voices = speechSynthesis.getVoices();
    }
  },

  getPreferredVoice() {
    let voice = this.voices.find(v =>
      voiceSettings.preferredVoiceKeywords.some(keyword =>
        v.name.includes(keyword)
      ) &&
      v.lang.startsWith("en")
    );

    if (!voice) {
      voice = this.voices.find(v =>
        v.lang.startsWith("en")
      );
    }

    return voice || this.voices[0];
  },

  /**
   * Sanitizes text prior to speaking to prevent markdown syntax readouts.
   */
  sanitizeText(text) {
    if (!text) return "";
    return text
      .replace(/```[\s\S]*?```/g, "") // Strip code blocks completely
      .replace(/`([^`\n]+)`/g, "$1")  // Inline code ticks removed
      .replace(/\*\*(.*?)\*\*/g, "$1") // Bold markdown stripped
      .replace(/_([^_]+)_/g, "$1")     // Italic markdown stripped
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1") // Links replace with text
      .replace(/[•*-]\s+/g, "")       // Bullet points cleaned
      .replace(/<[^>]*>/g, "")        // HTML tags stripped
      .replace(/&[a-z0-9#]+;/gi, ""); // HTML entities stripped
  },

  speak(text) {
    if (!text) return;

    // Prevent microphone conflict
    speechRecognitionEngine.stop();

    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.cancel();
    }

    const cleanText = this.sanitizeText(text);
    if (!cleanText.trim()) return;

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = voiceSettings.language;
    utterance.rate = voiceSettings.speechRate;
    utterance.pitch = voiceSettings.pitch;
    utterance.volume = voiceSettings.volume;

    const voice = this.getPreferredVoice();
    if (voice) {
      utterance.voice = voice;
    }

    utterance.onstart = () => {
      updateVoiceState({
        status: "speaking",
        speaking: true
      });
      console.log("Kofi AI speaking...");
    };

    utterance.onend = () => {
      updateVoiceState({
        status: "idle",
        speaking: false
      });
      console.log("Finished speaking");

      // Hands-free conversation logic
      if (voiceSettings.conversationMode) {
        setTimeout(() => {
          if (voiceSettings.conversationMode && !voiceState.speaking) {
            speechRecognitionEngine.start();
          }
        }, 300);
      }
    };

    utterance.onerror = (error) => {
      console.error("Speech error:", error);
      updateVoiceState({
        status: "idle",
        speaking: false
      });
    };

    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.speak(utterance);
    }
  },

  pause() {
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.pause();
    }
  },

  resume() {
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.resume();
    }
  },

  stop() {
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.cancel();
    }
    updateVoiceState({
      status: "idle",
      speaking: false
    });
  }
};

if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.onvoiceschanged = () => {
    speechSynthesisEngine.loadVoices();
  };
  speechSynthesisEngine.loadVoices();
}

// ==========================================================
// 3. SPEECH RECOGNITION (VOICE INPUT)
// ==========================================================

const speechRecognitionEngine = {
  recognition: null,
  _manuallyStopped: false,

  initialize() {
    const SpeechRecognition =
      window.SpeechRecognition ||
      window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      console.warn("Speech recognition unavailable in this browser.");
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.lang = voiceSettings.language;
    this.recognition.continuous = false;
    this.recognition.interimResults = false;

    this.recognition.onstart = () => {
      this._manuallyStopped = false;
      updateVoiceState({
        status: "listening",
        recognitionActive: true
      });
      console.log("Listening...");
    };

    this.recognition.onresult = (event) => {
      const text = event.results[0][0].transcript;
      updateVoiceState({
        currentText: text
      });
      console.log("User:", text);
      conversationManager.processUserInput(text);
    };

    this.recognition.onend = () => {
      updateVoiceState({
        status: "idle",
        recognitionActive: false
      });
      console.log("Listening stopped.");

      // Handle auto-restart if enabled and not manually stopped
      if (voiceSettings.autoRestartListening && !this._manuallyStopped && !voiceState.speaking) {
        setTimeout(() => {
          this.start();
        }, 100);
      }
    };

    this.recognition.onerror = (event) => {
      console.error("Recognition error:", event.error);
      if (event.error === 'not-allowed') {
        console.warn("Microphone access permission denied.");
      }
      updateVoiceState({
        status: "idle",
        recognitionActive: false
      });
    };
  },

  start() {
    // Stop AI voice first to prevent microphone conflict
    speechSynthesisEngine.stop();

    if (this.recognition) {
      try {
        this.recognition.start();
      } catch (e) {
        // Recognition might already be running
        console.warn("Speech recognition start failed or already active:", e.message);
      }
    }
  },

  stop() {
    this._manuallyStopped = true;
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch (e) {
        console.warn("Speech recognition stop failed:", e.message);
      }
    }
  }
};

speechRecognitionEngine.initialize();

// ==========================================================
// 4. CONVERSATION MANAGER
// ==========================================================

const conversationManager = {
  enabled: false,
  aiCallback: null,

  start() {
    this.enabled = true;
    voiceSettings.conversationMode = true;
    speechRecognitionEngine.start();
  },

  stop() {
    this.enabled = false;
    voiceSettings.conversationMode = false;
    speechRecognitionEngine.stop();
    speechSynthesisEngine.stop();
  },

  processUserInput(text) {
    if (!this.enabled) return;
    console.log("Sending to AI:", text);

    if (this.aiCallback) {
      this.aiCallback(text);
    }
  },

  receiveAIResponse(response) {
    speechSynthesisEngine.speak(response);
  }
};

// ==========================================================
// 5. VOICE ENGINE (PUBLIC LMS API)
// ==========================================================

const voiceEngine = {
  // Expose the sub-components for extensibility
  settings: voiceSettings,
  speechSynthesis: speechSynthesisEngine,
  speechRecognition: speechRecognitionEngine,
  conversationManager: conversationManager,

  speak(text) {
    speechSynthesisEngine.speak(text);
  },

  stop() {
    speechSynthesisEngine.stop();
  },

  pause() {
    speechSynthesisEngine.pause();
  },

  resume() {
    speechSynthesisEngine.resume();
  },

  listen() {
    speechRecognitionEngine.start();
  },

  stopListening() {
    speechRecognitionEngine.stop();
  },

  startConversation() {
    conversationManager.start();
  },

  stopConversation() {
    conversationManager.stop();
  },

  getStatus() {
    return voiceState;
  },

  // Extension: Callbacks for state-driven UI updates
  onStateChange: null,

  isSupported() {
    const recognitionSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    const synthesisSupported = typeof speechSynthesis !== 'undefined';
    return {
      recognition: recognitionSupported,
      synthesis: synthesisSupported
    };
  }
};

// Export for LMS usage
window.voiceEngine = voiceEngine;
