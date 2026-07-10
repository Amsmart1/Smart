/**
 * KofiAIManager - Dedicated Public AI Assistant
 *
 * Enterprise lightweight frontend layer for public kofi assistant.
 * NO Supabase, sessions, cookies, RBAC, ABAC, database, or RAG.
 * Enhanced with enterprise-grade Markdown processing, full Accessibility support,
 * Character Limit indicator, smooth UX scroll anchoring, and Keyboard controls.
 * Integrates flawlessly with SmartLMS Centralized Voice Engine.
 */

class KofiAIManager {
    static _history = new Map();
    static _activeRequests = new Map();

    static CONFIG = {
        endpoint: '/api/kofi-assistant',
        timeout: 60000,
        maxHistoryMessages: 10,
        retryAttempts: 2,
        retryDelay: 1000
    };

    /**
     * Internal helper to communicate with Kofi AI Assistant.
     */
    static async _invoke(message, history = []) {
        const payload = { message, history };
        const requestKey = JSON.stringify(payload);

        if (this._activeRequests.has(requestKey)) {
            return this._activeRequests.get(requestKey);
        }

        const requestPromise = this._executeRequest(payload);
        this._activeRequests.set(requestKey, requestPromise);

        try {
            return await requestPromise;
        } finally {
            this._activeRequests.delete(requestKey);
        }
    }

    /**
     * Executes actual AI request.
     */
    static async _executeRequest(payload) {
        let lastError;

        for (let attempt = 0; attempt <= this.CONFIG.retryAttempts; attempt++) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), this.CONFIG.timeout);

                let response;
                try {
                    response = await fetch(this.CONFIG.endpoint, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(payload),
                        signal: controller.signal
                    });
                } finally {
                    clearTimeout(timeout);
                }

                let data;
                try {
                    data = await response.json();
                } catch {
                    throw new Error("Kofi AI assistant returned invalid response format.");
                }

                if (!response.ok) {
                    throw new Error(data?.error || `Kofi AI assistant HTTP ${response.status}`);
                }

                return data;
            } catch (error) {
                lastError = error;
                if (error.name === 'AbortError') {
                    lastError = new Error("Kofi AI request timed out. Please try again.");
                }
                if (attempt < this.CONFIG.retryAttempts) {
                    await this._delay(this.CONFIG.retryDelay * (attempt + 1));
                    continue;
                }
            }
        }

        console.error("Kofi AI assistant failed", { error: lastError?.message });
        throw lastError || new Error("Kofi AI assistant service unavailable");
    }

    static _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * LMS UI Feature Assistant (Kofi AI)
     */
    static async askKofi(message) {
        const historyKey = 'kofi';
        const history = this._history.get(historyKey) || [];

        const response = await this._invoke(message, history);

        history.push({ role: 'user', content: message });
        history.push({ role: 'assistant', content: response.content });
        this._history.set(historyKey, history.slice(-this.CONFIG.maxHistoryMessages));

        return response.content;
    }

    /**
     * Clears conversational history for a specific key or all history if no key is provided.
     */
    static clearHistory(historyKey = null) {
        if (historyKey) {
            this._history.delete(historyKey);
        } else {
            this._history.clear();
        }
    }

    /**
     * Unified Chat UI Component
     */
    static renderChatbot(containerId, options = {}) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const {
            title = 'AI Assistant',
            placeholder = 'Ask me anything...',
            onSend = async (msg) => {},
            onClear = () => {},
            welcomeMessage = 'Hello! How can I help you today?'
        } = options;

        const chatHtml = `
            <div class="ai-chatbot-container card p-0 flex-column" role="region" aria-label="${window.escapeAttr(title)}" style="height: 500px; max-height: 80vh; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border, #e2e8f0); box-shadow: 0 10px 25px rgba(0,0,0,0.05); border-radius: 12px; background: #fff;">
                <div class="ai-chatbot-header p-15 border-bottom flex-between bg-light" style="border-radius: 12px 12px 0 0; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border, #e2e8f0); padding: 12px 15px; background: #f8fafc; gap: 10px; flex-wrap: wrap;">
                    <div class="flex-center-y gap-10" style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 1.5rem" aria-hidden="true">🤖</span>
                        <strong style="color: var(--p, #5b2ea6); font-size: 1.05rem;">${window.escapeHtml(title)}</strong>
                    </div>
                    <div class="flex-center-y gap-5" style="display: flex; align-items: center; gap: 5px; margin-left: auto;">
                        <button class="button secondary tiny w-auto ai-handsfree-btn" aria-label="Toggle hands-free conversation mode" style="margin: 0; padding: 6px 10px; font-size: 0.75rem; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 4px;">🎙️ Hands-Free: Off</button>
                        <button class="button secondary tiny w-auto ai-tts-btn" aria-label="Toggle voice output" style="margin: 0; padding: 6px 10px; font-size: 0.75rem; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 4px;">🔇 Read Aloud: Off</button>
                        <button class="button secondary tiny w-auto ai-clear-btn" aria-label="Clear conversation history" style="margin: 0; padding: 6px 12px; font-size: 0.75rem; border-radius: 4px;">Clear</button>
                    </div>
                </div>
                <div class="ai-chat-messages flex-1 p-15 overflow-y-auto" role="log" aria-live="polite" aria-label="Chat messages" style="background: #f8fafc; flex: 1; overflow-y: auto; padding: 15px;">
                </div>
                <div class="ai-chat-input p-10 border-top bg-white" style="border-top: 1px solid var(--border, #e2e8f0); background: #fff; padding: 10px; border-radius: 0 0 12px 12px;">
                    <div class="flex gap-10" style="display: flex; gap: 10px; align-items: center;">
                        <button class="button secondary small w-auto ai-mic-btn" aria-label="Start voice input" style="border-radius: 20px; padding: 8px 12px; margin: 0; display: flex; align-items: center; justify-content: center; background: #f1f5f9; border: 1px solid #cbd5e1; font-size: 1.1rem; line-height: 1;" title="Start voice input">🎙️</button>
                        <input type="text" class="m-0 ai-input-field" placeholder="${window.escapeAttr(placeholder)}" maxlength="1000" aria-label="Type your message" style="flex: 1; border-radius: 20px; padding: 10px 15px; border: 1px solid #cbd5e1; outline: none; margin: 0; font-size: 0.9rem;">
                        <button class="button small w-auto ai-send-btn" aria-label="Send message" style="border-radius: 20px; padding: 8px 20px; font-weight: 600; margin: 0;">Send</button>
                    </div>
                    <div class="ai-char-counter text-right mt-5" aria-hidden="true" style="font-size: 10px; color: #64748b; padding-right: 15px; margin-top: 5px; text-align: right;">0 / 1000</div>
                </div>
            </div>
        `;

        container.innerHTML = chatHtml;

        const input = container.querySelector('.ai-input-field');
        const sendBtn = container.querySelector('.ai-send-btn');
        const clearBtn = container.querySelector('.ai-clear-btn');
        const messagesArea = container.querySelector('.ai-chat-messages');
        const counter = container.querySelector('.ai-char-counter');
        const micBtn = container.querySelector('.ai-mic-btn');
        const ttsBtn = container.querySelector('.ai-tts-btn');
        const handsFreeBtn = container.querySelector('.ai-handsfree-btn');

        // Initial setup for voice elements
        let ttsEnabled = false;
        const supported = window.voiceEngine ? window.voiceEngine.isSupported() : { recognition: false, synthesis: false };

        if (!supported.recognition) {
            if (micBtn) micBtn.style.display = 'none';
            if (handsFreeBtn) handsFreeBtn.style.display = 'none';
        }
        if (!supported.synthesis) {
            if (ttsBtn) ttsBtn.style.display = 'none';
        }

        const updateCharCounter = () => {
            const len = input.value.length;
            if (counter) {
                counter.textContent = `${len} / 1000`;
                if (len >= 900) {
                    counter.style.color = '#ef4444';
                    counter.style.fontWeight = '700';
                } else {
                    counter.style.color = '#64748b';
                    counter.style.fontWeight = '400';
                }
            }
        };

        input.addEventListener('input', updateCharCounter);

        const appendMessage = (role, content, isTrustedHtml = false) => {
            const msgDiv = document.createElement('div');
            msgDiv.className = `ai-msg ${role} mb-15 ${role === 'user' ? 'text-right' : ''}`;
            msgDiv.style.marginBottom = '15px';
            if (role === 'user') {
                msgDiv.style.textAlign = 'right';
            }

            let formatted;
            if (isTrustedHtml) {
                formatted = content;
            } else {
                // Escape HTML first
                let escaped = window.escapeHtml(content);

                // Placeholder-based markdown tokenizer to prevent tag clashing inside code blocks
                const placeholders = [];

                // 1. Extract and preserve code blocks (no underscores to prevent italic clash)
                let temp = escaped.replace(/```(?:[a-zA-Z0-9]+)?\n([\s\S]*?)\n```/g, (match, code) => {
                    const idx = placeholders.length;
                    placeholders.push(`<pre style="background: #0f172a; color: #f8fafc; padding: 12px; border-radius: 8px; font-family: monospace; font-size: 0.85rem; overflow-x: auto; margin: 10px 0; white-space: pre-wrap; word-break: break-all; text-align: left; line-height: 1.4;"><code>${code}</code></pre>`);
                    return `%%%PLACEHOLDER${idx}%%%`;
                });

                // 2. Extract and preserve inline code (no underscores to prevent italic clash)
                temp = temp.replace(/`([^`\n]+)`/g, (match, code) => {
                    const idx = placeholders.length;
                    placeholders.push(`<code style="background: #e2e8f0; color: #0f172a; padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 0.9em; font-weight: 600; word-break: break-all;">${code}</code>`);
                    return `%%%PLACEHOLDER${idx}%%%`;
                });

                // 3. Format bullet points: lines starting with '*' or '-'
                temp = temp.replace(/^([ \t]*)[*-][ \t]+(.*)$/gm, '$1• $2');

                // 4. Format markdown links safely [text](url)
                temp = temp.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
                    const decodedUrl = url.replace(/&amp;/g, '&');
                    if (window.isValidUrl(decodedUrl)) {
                        const lowerUrl = decodedUrl.toLowerCase().trim();
                        // Prevent javascript: or other script execution protocol hacks
                        if (lowerUrl.startsWith('http://') || lowerUrl.startsWith('https://')) {
                            return `<a href="${window.escapeAttr(decodedUrl)}" target="_blank" class="text-link" style="color: var(--p, #5b2ea6); font-weight: 700; text-decoration: underline;">${text}</a>`;
                        }
                    }
                    return match;
                });

                // 5. Format bold and italics
                temp = temp.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                temp = temp.replace(/_([^_]+)_/g, '<em>$1</em>');

                // 6. Format line breaks
                temp = temp.replace(/\n/g, '<br>');

                // 7. Restore placeholders
                for (let i = 0; i < placeholders.length; i++) {
                    temp = temp.replace(`%%%PLACEHOLDER${i}%%%`, placeholders[i]);
                }

                formatted = temp;
            }

            msgDiv.innerHTML = `
                <div class="p-10 border-radius-md small text-left" style="background: ${role === 'user' ? 'var(--p, #5b2ea6)' : '#fff'}; color: ${role === 'user' ? '#fff' : 'var(--text, #1e293b)'}; border: 1px solid #cbd5e1; display: inline-block; max-width: 85%; border-radius: 8px; padding: 10px; text-align: left; line-height: 1.5; box-shadow: 0 1px 3px rgba(0,0,0,0.02);">
                    ${formatted}
                </div>
            `;
            messagesArea.appendChild(msgDiv);

            // Smooth, native-like scroll to bottom
            messagesArea.scrollTo({
                top: messagesArea.scrollHeight,
                behavior: 'smooth'
            });
        };

        const resetUI = () => {
            messagesArea.innerHTML = '';
            appendMessage('assistant', welcomeMessage);
            if (counter) counter.textContent = '0 / 1000';
            if (window.voiceEngine) {
                window.voiceEngine.stop();
                window.voiceEngine.stopListening();
                window.voiceEngine.stopConversation();
            }
        };

        // Initial welcome
        resetUI();

        clearBtn.onclick = () => {
            resetUI();
            if (typeof onClear === 'function') {
                onClear();
            }
        };

        const handleSend = async () => {
            const msg = input.value.trim();
            if (!msg) return;

            // Enforce character limit guard on submit
            if (msg.length > 1000) {
                alert("Message is too long. Please shorten it below 1000 characters.");
                return;
            }

            input.value = '';
            input.disabled = true;
            sendBtn.disabled = true;
            updateCharCounter();

            appendMessage('user', msg);

            // Typing indicator
            const typingDiv = document.createElement('div');
            typingDiv.className = 'ai-msg assistant mb-15 typing-indicator';
            typingDiv.style.marginBottom = '15px';
            typingDiv.innerHTML = `<div class="p-10 border-radius-md small" style="background: #fff; border: 1px solid #cbd5e1; display: inline-block;"><span class="animate-pulse" style="font-weight: 500; color: #64748b;">Kofi is thinking...</span></div>`;
            messagesArea.appendChild(typingDiv);

            messagesArea.scrollTo({
                top: messagesArea.scrollHeight,
                behavior: 'smooth'
            });

            try {
                const response = await onSend(msg);
                typingDiv.remove();
                appendMessage('assistant', response);

                // Synthesize/speak response if active
                if (ttsEnabled && window.voiceEngine) {
                    window.voiceEngine.speak(response);
                }
            } catch (e) {
                typingDiv.remove();
                const errorMessage = window.escapeHtml(e.message || 'Sorry, I encountered an error. Please try again.');
                appendMessage('assistant', `<span style="color: #ef4444; font-weight: 600;">⚠️ Error: ${errorMessage}</span>`, true);
                console.error(e);
            } finally {
                input.disabled = false;
                sendBtn.disabled = false;
                // If hands-free is active, we don't steal focus aggressively
                if (window.voiceEngine && !window.voiceEngine.settings.conversationMode) {
                    input.focus();
                }
            }
        };

        sendBtn.onclick = handleSend;
        input.onkeypress = (e) => { if (e.key === 'Enter') handleSend(); };

        // Synchronize Voice Engine state with UI indicators
        const syncVoiceUI = (state) => {
            if (!state) return;

            // Mic button styling
            if (state.status === 'listening') {
                if (micBtn) {
                    micBtn.style.background = '#ef4444';
                    micBtn.style.borderColor = '#ef4444';
                    micBtn.style.color = '#fff';
                    micBtn.innerHTML = '🛑';
                    micBtn.title = 'Stop listening';
                }
            } else {
                if (micBtn) {
                    micBtn.style.background = '#f1f5f9';
                    micBtn.style.borderColor = '#cbd5e1';
                    micBtn.style.color = 'inherit';
                    micBtn.innerHTML = '🎙️';
                    micBtn.title = 'Start voice input';
                }
            }

            // Handsfree button styling
            if (handsFreeBtn) {
                if (window.voiceEngine && window.voiceEngine.settings.conversationMode) {
                    handsFreeBtn.textContent = '🎙️ Hands-Free: On';
                    handsFreeBtn.style.background = '#dcfce7';
                    handsFreeBtn.style.color = '#15803d';
                    handsFreeBtn.style.borderColor = '#bbf7d0';
                } else {
                    handsFreeBtn.textContent = '🎙️ Hands-Free: Off';
                    handsFreeBtn.style.background = '#f1f5f9';
                    handsFreeBtn.style.color = 'inherit';
                    handsFreeBtn.style.borderColor = '#cbd5e1';
                }
            }

            // TTS Read Aloud button styling
            if (ttsBtn) {
                if (ttsEnabled) {
                    ttsBtn.textContent = '🔊 Read Aloud: On';
                    ttsBtn.style.background = '#dbeafe';
                    ttsBtn.style.color = '#1d4ed8';
                    ttsBtn.style.borderColor = '#bfdbfe';
                } else {
                    ttsBtn.textContent = '🔇 Read Aloud: Off';
                    ttsBtn.style.background = '#f1f5f9';
                    ttsBtn.style.color = 'inherit';
                    ttsBtn.style.borderColor = '#cbd5e1';
                }
            }
        };

        // Hook up Voice Engine callback subscriptions
        if (window.voiceEngine) {
            window.voiceEngine.onStateChange = syncVoiceUI;

            window.voiceEngine.conversationManager.aiCallback = async (text) => {
                if (!text) return;
                input.value = text;
                updateCharCounter();
                await handleSend();
            };

            // Handle system-level microphone or recognition errors gracefully
            window.voiceEngine.onError = (err) => {
                if (!err) return;
                console.warn("[Voice Engine Alert]", err);

                // For permissions denied or user inactivity pause, append an informative system card
                let alertHtml = '';
                if (err.type === 'permission_denied') {
                    alertHtml = `<span style="color: #ef4444; font-weight: 600;">🎙️ Mic Access Denied:</span> Please enable microphone permissions in your browser address bar to use voice features.`;
                } else if (err.type === 'silence_timeout') {
                    alertHtml = `🎙️ <em>${window.escapeHtml(err.message)}</em>`;
                    // Automatically disable hands-free states on error/silence timeout
                    syncVoiceUI(window.voiceEngine.getStatus());
                } else if (err.type === 'no_speech') {
                    // Suppress noise alerts unless continuous/hands-free gets stuck
                    return;
                } else {
                    alertHtml = `<span style="color: #ef4444;">⚠️ Voice Error:</span> ${window.escapeHtml(err.message)}`;
                }

                if (alertHtml) {
                    appendMessage('assistant', alertHtml, true);
                }
            };

            // Set initial state
            syncVoiceUI(window.voiceEngine.getStatus());
        }

        if (micBtn) {
            micBtn.onclick = () => {
                if (!window.voiceEngine) return;
                const state = window.voiceEngine.getStatus();
                if (state.status === 'listening') {
                    window.voiceEngine.stopListening();
                } else {
                    window.voiceEngine.listen();
                }
            };
        }

        if (ttsBtn) {
            ttsBtn.onclick = () => {
                ttsEnabled = !ttsEnabled;
                if (!ttsEnabled && window.voiceEngine) {
                    window.voiceEngine.stop();
                }
                syncVoiceUI(window.voiceEngine ? window.voiceEngine.getStatus() : null);
            };
        }

        if (handsFreeBtn) {
            handsFreeBtn.onclick = () => {
                if (!window.voiceEngine) return;
                const isConv = !window.voiceEngine.settings.conversationMode;
                if (isConv) {
                    ttsEnabled = true; // Auto-enable read aloud for conversational flow
                    window.voiceEngine.startConversation();
                } else {
                    window.voiceEngine.stopConversation();
                }
                syncVoiceUI(window.voiceEngine.getStatus());
            };
        }
    }
}

// Register global keyboard event listener for seamless window closure (Escape key)
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const chatWindow = document.getElementById('kofiChatWindow');
        if (chatWindow && !chatWindow.classList.contains('hidden') && window.LandingUI && typeof window.LandingUI.toggleKofi === 'function') {
            window.LandingUI.toggleKofi();
        }
    }
});

window.KofiAIManager = KofiAIManager;
