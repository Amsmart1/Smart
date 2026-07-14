/**
 * KofiAIManager - Dedicated Public AI Assistant
 *
 * Enterprise lightweight frontend layer for public kofi assistant.
 * NO Supabase, sessions, cookies, RBAC, ABAC, database, or RAG.
 * Enhanced with enterprise-grade Markdown processing, full Accessibility support,
 * Character Limit indicator, smooth UX scroll anchoring, and Keyboard controls.
 * Models: Public Kofi AI (Gemini 3.1 Flash Lite: gemini-3.1-flash-lite) and Voice Assistant (Gemini 2.5 Flash: gemini-2.5-flash)
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
     * Compatibility helper to support streaming requests.
     */
    static async _invokeStream(message, history = []) {
        return await this._invoke(message, history);
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
     * Streaming-compatible interface for public Kofi Assistant
     */
    static async askKofiStream(message, onChunk, onDone) {
        const historyKey = 'kofi';
        const history = this._history.get(historyKey) || [];
        const payload = { message, history, stream: true };

        try {
            const response = await fetch(this.CONFIG.endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`Kofi AI stream error: HTTP ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            let fullText = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');

                // Keep the last partial line in the buffer
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    if (trimmed.startsWith('data: ')) {
                        const jsonStr = trimmed.substring(6).trim();
                        try {
                            const parsed = JSON.parse(jsonStr);
                            if (parsed.chunk) {
                                fullText += parsed.chunk;
                                if (typeof onChunk === 'function') {
                                    onChunk(parsed.chunk);
                                }
                            } else if (parsed.final) {
                                fullText = parsed.final;
                            } else if (parsed.error) {
                                throw new Error(parsed.error);
                            }
                        } catch (e) {
                            console.warn("Error parsing stream chunk:", e, trimmed);
                        }
                    }
                }
            }

            // Save history
            history.push({ role: 'user', content: message });
            history.push({ role: 'assistant', content: fullText });
            this._history.set(historyKey, history.slice(-this.CONFIG.maxHistoryMessages));

            if (typeof onDone === 'function') {
                onDone(fullText);
            }

            return fullText;
        } catch (error) {
            console.error("Kofi AI stream failed:", error);
            throw error;
        }
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
     * Unified Chat UI Component delegated to the centralized AIManager
     */
    static renderChatbot(containerId, options = {}) {
        return AIManager.renderChatbot(containerId, options);
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
