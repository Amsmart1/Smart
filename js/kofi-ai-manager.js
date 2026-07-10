/**
 * KofiAIManager - Dedicated Public AI Assistant
 *
 * Enterprise lightweight frontend layer for public kofi assistant.
 * NO Supabase, sessions, cookies, RBAC, ABAC, database, or RAG.
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
                    throw new Error("Kofi AI assistant returned invalid response");
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
            <div class="ai-chatbot-container card p-0 flex-column" style="height: 500px; max-height: 80vh;">
                <div class="ai-chatbot-header p-15 border-bottom flex-between bg-light" style="border-radius: 12px 12px 0 0">
                    <div class="flex-center-y gap-10">
                        <span style="font-size: 1.5rem">🤖</span>
                        <strong style="color: var(--p)">${window.escapeHtml(title)}</strong>
                    </div>
                    <button class="button secondary tiny w-auto ai-clear-btn">Clear</button>
                </div>
                <div class="ai-chat-messages flex-1 p-15 overflow-y-auto" style="background: #f8fafc">
                </div>
                <div class="ai-chat-input p-10 border-top bg-white" style="border-radius: 0 0 12px 12px">
                    <div class="flex gap-10">
                        <input type="text" class="m-0 ai-input-field" placeholder="${window.escapeAttr(placeholder)}" style="border-radius: 20px">
                        <button class="button small w-auto ai-send-btn" style="border-radius: 20px; padding: 0 20px">Send</button>
                    </div>
                </div>
            </div>
        `;

        container.innerHTML = chatHtml;

        const input = container.querySelector('.ai-input-field');
        const sendBtn = container.querySelector('.ai-send-btn');
        const clearBtn = container.querySelector('.ai-clear-btn');
        const messagesArea = container.querySelector('.ai-chat-messages');

        const appendMessage = (role, content, isTrustedHtml = false) => {
            const msgDiv = document.createElement('div');
            msgDiv.className = `ai-msg ${role} mb-15 ${role === 'user' ? 'text-right' : ''}`;

            let formatted;
            if (isTrustedHtml) {
                formatted = content;
            } else {
                // Escape HTML and format content (simple markdown-like replacement)
                let escaped = window.escapeHtml(content);

                // Format bullet points: lines starting with '*' or '-'
                escaped = escaped.replace(/^([ \t]*)[*-][ \t]+(.*)$/gm, '$1• $2');

                // Format links: [text](url) -> <a href="url" target="_blank" class="text-link">text</a>
                escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
                    const decodedUrl = url.replace(/&amp;/g, '&');
                    if (window.isValidUrl(decodedUrl)) {
                        return `<a href="${window.escapeAttr(decodedUrl)}" target="_blank" class="text-link">${text}</a>`;
                    }
                    return match;
                });

                // Format bold: **text** -> <strong>text</strong>
                escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

                // Format line breaks
                formatted = escaped.replace(/\n/g, '<br>');
            }

            msgDiv.innerHTML = `
                <div class="p-10 border-radius-md small text-left" style="background: ${role === 'user' ? 'var(--p)' : '#fff'}; color: ${role === 'user' ? '#fff' : 'var(--text)'}; border: 1px solid #e2e8f0; display: inline-block; max-width: 85%">
                    ${formatted}
                </div>
            `;
            messagesArea.appendChild(msgDiv);
            messagesArea.scrollTop = messagesArea.scrollHeight;
        };

        const resetUI = () => {
            messagesArea.innerHTML = '';
            appendMessage('assistant', welcomeMessage);
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

            input.value = '';
            input.disabled = true;
            sendBtn.disabled = true;

            appendMessage('user', msg);

            // Typing indicator
            const typingDiv = document.createElement('div');
            typingDiv.className = 'ai-msg assistant mb-15 typing-indicator';
            typingDiv.innerHTML = `<div class="p-10 border-radius-md small" style="background: #fff; border: 1px solid #e2e8f0; display: inline-block;"><span class="animate-pulse">AI is thinking...</span></div>`;
            messagesArea.appendChild(typingDiv);
            messagesArea.scrollTop = messagesArea.scrollHeight;

            try {
                const response = await onSend(msg);
                typingDiv.remove();
                appendMessage('assistant', response);
            } catch (e) {
                typingDiv.remove();
                const errorMessage = window.escapeHtml(e.message || 'Sorry, I encountered an error. Please try again.');
                appendMessage('assistant', `<span style="color: #ef4444">⚠️ Error: ${errorMessage}</span>`, true);
                console.error(e);
            } finally {
                input.disabled = false;
                sendBtn.disabled = false;
                input.focus();
            }
        };

        sendBtn.onclick = handleSend;
        input.onkeypress = (e) => { if (e.key === 'Enter') handleSend(); };
    }
}

window.KofiAIManager = KofiAIManager;
