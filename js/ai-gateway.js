/**
 * AI Gateway Frontend Manager
 *
 * Enterprise frontend communication layer for SmartLMS AI services.
 *
 * Architecture:
 *
 * Browser
 *    ↓
 * AIManager
 *    ↓
 * /api/ai-gateway (Vercel Serverless Function)
 *    ↓
 * Authorization Layer
 *    ↓
 * Gemini AI Services
 *
 * Maintains compatibility with:
 * - Custom session authentication
 * - x-session-id header
 * - Existing Vercel gateway endpoint
 */

class AIManager {

    static _history = new Map();

    static _activeRequests = new Map();


    static CONFIG = {

        endpoint: '/api/ai-gateway',

        timeout: 60000,

        maxHistoryMessages: 10,

        retryAttempts: 2,

        retryDelay: 1000

    };



    /**
     * Safely retrieve current session ID.
     */
    static _getSessionId() {

        try {

            return sessionStorage.getItem('sessionId') || '';

        } catch (error) {

            console.warn(
                "Unable to access session storage",
                error
            );

            return '';

        }

    }




    /**
     * Internal helper to communicate with AI Gateway.
     *
     * Includes:
     * - Timeout protection
     * - Controlled retry
     * - Duplicate request prevention
     * - Safe JSON handling
     * - Structured error handling
     */
    static async _invoke(type, payload = {}) {


        if (!type) {

            throw new Error(
                "AI operation type is required"
            );

        }



        const requestKey =
            `${type}_${JSON.stringify(payload)}`;



        if (this._activeRequests.has(requestKey)) {

            return this._activeRequests.get(requestKey);

        }



        const requestPromise =
            this._executeRequest(type, payload);



        this._activeRequests.set(
            requestKey,
            requestPromise
        );



        try {

            return await requestPromise;


        } finally {


            this._activeRequests.delete(
                requestKey
            );


        }

    }





    /**
     * Executes actual AI request.
     */
    static async _executeRequest(type, payload) {


        const sid = this._getSessionId();



        const enrichedPayload = {

            ...payload,

            session_id: sid,

            sessionId: sid

        };



        let lastError;



        for (
            let attempt = 0;
            attempt <= this.CONFIG.retryAttempts;
            attempt++
        ) {


            try {


                const controller =
                    new AbortController();



                const timeout =
                    setTimeout(
                        () => controller.abort(),
                        this.CONFIG.timeout
                    );



                let response;



                try {


                    response = await fetch(
                        this.CONFIG.endpoint,
                        {
                            method: 'POST',

                            headers: {

                                'Content-Type':
                                    'application/json',

                                'x-session-id':
                                    sid

                            },


                            body: JSON.stringify({

                                type,

                                payload:
                                    enrichedPayload

                            }),


                            signal:
                                controller.signal

                        }
                    );


                } finally {


                    clearTimeout(timeout);


                }




                let data;



                try {


                    data =
                        await response.json();


                } catch {


                    throw new Error(
                        "AI gateway returned invalid response"
                    );

                }





                if (!response.ok) {


                    throw new Error(

                        data?.error ||
                        `AI Gateway HTTP ${response.status}`

                    );


                }




                return data;



            } catch (error) {


                lastError = error;



                if (
                    error.name === 'AbortError'
                ) {


                    lastError =
                        new Error(
                            "AI request timed out. Please try again."
                        );


                }



                if (
                    attempt <
                    this.CONFIG.retryAttempts
                ) {


                    await this._delay(
                        this.CONFIG.retryDelay *
                        (attempt + 1)
                    );


                    continue;


                }


            }

        }




        console.error(
            "AI Gateway failed",
            {
                operation: type,
                error:
                    lastError?.message
            }
        );



        throw lastError ||
            new Error(
                "AI service unavailable"
            );

    }




    /**
     * Delay helper for retry mechanism.
     */
    static _delay(ms) {

        return new Promise(
            resolve =>
                setTimeout(resolve, ms)
        );

    }




    /**
     * Maintain bounded conversation history.
     */
    static _updateHistory(
        key,
        messages
    ) {


        const limited =
            messages.slice(
                -this.CONFIG.maxHistoryMessages
            );


        this._history.set(
            key,
            limited
        );


    }

    /**
     * 1. Course-aware Tutor
     */
    static async askTutor(courseId, message) {
        const historyKey = `tutor_${courseId}`;
        const history = this._history.get(historyKey) || [];

        const response = await this._invoke('tutor', {
            course_id: courseId,
            message,
            history
        });

        // Update history
        history.push({ role: 'user', content: message });
        history.push({ role: 'assistant', content: response.content });
        this._history.set(historyKey, history.slice(-10)); // Keep last 5 exchanges

        return response.content;
    }

    /**
     * 2. Assessment Generator
     */
    static async generateAssessment(params) {
        // params: { topic, type, count, difficulty, rubrics, course_id }
        const response = await this._invoke('generate_assessment', params);
        return this._extractJSON(response.content);
    }

    /**
     * Feature 6: Knowledge Base Indexing
     */
    static async indexCourse(courseId) {
        return await this._invoke('index_course', { course_id: courseId });
    }

    /**
     * Robust JSON extraction from LLM response
     */
    static _extractJSON(text) {
        if (!text) throw new Error("AI response is empty");

        try {
            // Attempt 1: Direct parse (stripping potential whitespace)
            return JSON.parse(text.trim());
        } catch (e) {
            // Attempt 2: Find json block in markdown or raw array/object structure
            const patterns = [
                /```json\s*([\s\S]*?)\s*```/, // Markdown JSON block
                /```\s*([\s\S]*?)\s*```/,     // Generic code block
                /(\[\s*\{[\s\S]*\}\s*\])/,    // Raw array of objects
                /(\{\s*".*"\s*:[\s\S]*\})/    // Raw single object
            ];

            for (const pattern of patterns) {
                const match = text.match(pattern);
                if (match) {
                    try {
                        const jsonStr = (match[1] || match[0]).trim();
                        return JSON.parse(jsonStr);
                    } catch (e2) {
                        continue; // Try next pattern
                    }
                }
            }
            console.error("JSON Extraction failed for text:", text);
            throw new Error("Could not parse AI response as valid JSON");
        }
    }

    /**
     * 3. Grading Assistant
     */
    static async getGradingInsights(params) {
        // params: { assignment_id, course_id, assignment_title, student_submission, rubric, questions }
        const response = await this._invoke('grading', params);
        return response.content;
    }

    /**
     * Enterprise-grade Markdown and code-block parsing pipeline
     */
    static formatMarkdown(content) {
        if (!content) return '';
        // Escape HTML first safely (handling deferred loading)
        const escapeHtmlFn = window.escapeHtml || ((s) => {
            if (s === null || s === undefined) return '';
            return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        });
        let escaped = escapeHtmlFn(content);

        // Placeholder-based markdown tokenizer to prevent tag clashing inside code blocks
        const placeholders = [];

        // 1. Extract and preserve code blocks
        let temp = escaped.replace(/```(?:[a-zA-Z0-9]+)?\n([\s\S]*?)\n```/g, (match, code) => {
            const idx = placeholders.length;
            placeholders.push(`<pre style="background: #0f172a; color: #f8fafc; padding: 12px; border-radius: 8px; font-family: monospace; font-size: 0.85rem; overflow-x: auto; margin: 10px 0; white-space: pre-wrap; word-break: break-all; text-align: left; line-height: 1.4;"><code>${code}</code></pre>`);
            return `%%%PLACEHOLDER${idx}%%%`;
        });

        // 2. Extract and preserve inline code
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
            const isValidUrlFn = window.isValidUrl || ((u) => {
                try { return !!new URL(u); } catch (e) { return false; }
            });
            if (isValidUrlFn(decodedUrl)) {
                const lowerUrl = decodedUrl.toLowerCase().trim();
                if (lowerUrl.startsWith('http://') || lowerUrl.startsWith('https://')) {
                    const escapeAttrFn = window.escapeAttr || ((s) => {
                        if (s === null || s === undefined) return '';
                        return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                    });
                    return `<a href="${escapeAttrFn(decodedUrl)}" target="_blank" class="text-link" style="color: var(--p, #5b2ea6); font-weight: 700; text-decoration: underline;">${text}</a>`;
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

        return temp;
    }

    /**
     * 4. Role-based Analytics
     */
    static async analyzeAnalytics(question, analyticsData, options = {}) {
        const user = await window.SessionManager.getCurrentUser();
        const response = await this._invoke('analytics', {
            user_email: user?.email,
            course_id: options.courseId || null,
            question,
            analytics_data: analyticsData
        });
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
     * Unified Chat UI Component with Enterprise Formatting and Quality Standards
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

        const formatMarkdown = (content) => {
            return AIManager.formatMarkdown(content);
        };

        const chatHtml = `
            <div class="ai-chatbot-container card p-0 flex-column" role="region" aria-label="${window.escapeAttr(title)}" style="height: 500px; max-height: 80vh; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border, #e2e8f0); box-shadow: 0 10px 25px rgba(0,0,0,0.05); border-radius: 12px; background: #fff;">
                <div class="ai-chatbot-header p-15 border-bottom flex-between bg-light" style="border-radius: 12px 12px 0 0; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border, #e2e8f0); padding: 12px 15px; background: #f8fafc; gap: 10px; flex-wrap: wrap;">
                    <div class="flex-center-y gap-10" style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 1.5rem" aria-hidden="true">🤖</span>
                        <strong style="color: var(--p, #5b2ea6); font-size: 1.05rem;">${window.escapeHtml(title)}</strong>
                    </div>
                    <button class="button secondary tiny w-auto ai-clear-btn" aria-label="Clear conversation history" style="margin: 0; padding: 6px 12px; font-size: 0.75rem; border-radius: 4px;">Clear</button>
                </div>
                <div class="ai-chat-messages flex-1 p-15 overflow-y-auto" role="log" aria-live="polite" aria-label="Chat messages" style="background: #f8fafc; flex: 1; overflow-y: auto; padding: 15px;">
                </div>
                <div class="ai-chat-input p-10 border-top bg-white" style="border-top: 1px solid var(--border, #e2e8f0); background: #fff; padding: 10px; border-radius: 0 0 12px 12px;">
                    <div class="flex gap-10" style="display: flex; gap: 10px; align-items: center;">
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
                formatted = formatMarkdown(content);
            }

            msgDiv.innerHTML = `
                <div class="p-10 border-radius-md small text-left" style="background: ${role === 'user' ? 'var(--p, #5b2ea6)' : '#fff'}; color: ${role === 'user' ? '#fff' : 'var(--text, #1e293b)'}; border: 1px solid #cbd5e1; display: inline-block; max-width: 85%; border-radius: 8px; padding: 10px; text-align: left; line-height: 1.5; box-shadow: 0 1px 3px rgba(0,0,0,0.02);">
                    ${formatted}
                </div>
            `;
            messagesArea.appendChild(msgDiv);

            messagesArea.scrollTo({
                top: messagesArea.scrollHeight,
                behavior: 'smooth'
            });
        };

        const resetUI = () => {
            messagesArea.innerHTML = '';
            appendMessage('assistant', welcomeMessage);
            if (counter) counter.textContent = '0 / 1000';
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
            typingDiv.innerHTML = `<div class="p-10 border-radius-md small" style="background: #fff; border: 1px solid #cbd5e1; display: inline-block;"><span class="animate-pulse" style="font-weight: 500; color: #64748b;">AI is thinking...</span></div>`;
            messagesArea.appendChild(typingDiv);

            messagesArea.scrollTo({
                top: messagesArea.scrollHeight,
                behavior: 'smooth'
            });

            try {
                const response = await onSend(msg);
                typingDiv.remove();
                appendMessage('assistant', response);
            } catch (e) {
                typingDiv.remove();
                const errorMessage = window.escapeHtml(e.message || 'Sorry, I encountered an error. Please try again.');
                appendMessage('assistant', `<span style="color: #ef4444; font-weight: 600;">⚠️ Error: ${errorMessage}</span>`, true);
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

window.AIManager = AIManager;
