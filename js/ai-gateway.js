/**
 * AI Gateway Frontend Manager
 * Centralizes communication with the Supabase Edge Function AI Gateway.
 */
class AIManager {
    static _history = new Map();

    /**
     * Internal helper to invoke the AI Gateway edge function.
     */
    static async _invoke(type, payload) {
        const sid = sessionStorage.getItem('sessionId');
        const headers = {
            'Content-Type': 'application/json',
            'x-session-id': sid || ''
        };

        try {
            // We use the same name as the edge function: 'ai-gateway'
            const { data, error } = await window.supabaseClient.functions.invoke('ai-gateway', {
                body: { type, payload },
                headers: headers
            });

            if (error) throw error;
            return data;
        } catch (e) {
            console.error(`AI Gateway (${type}) failed:`, e);
            throw e;
        }
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
     * 5. LMS UI Feature Assistant (Kofi AI)
     */
    static async askKofi(message) {
        const historyKey = 'kofi';
        const history = this._history.get(historyKey) || [];

        const response = await this._invoke('platform_assistant', {
            message,
            history
        });

        history.push({ role: 'user', content: message });
        history.push({ role: 'assistant', content: response.content });
        this._history.set(historyKey, history.slice(-10)); // Maintain moderate history for Kofi

        return response.content;
    }

    /**
     * Clears conversational history for a specific key or all history if no key is provided.
     */
    static clearHistory(key = null) {
        if (key) {
            this._history.delete(key);
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
                formatted = window.escapeHtml(content)
                    .replace(/\n/g, '<br>')
                    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
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
            onClear();
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

window.AIManager = AIManager;
