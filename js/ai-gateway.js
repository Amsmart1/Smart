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
     * Enterprise-grade Markdown and code-block parsing pipeline.
     * Delegated to the centralized KofiAIManager.formatMarkdown.
     */
    static formatMarkdown(content) {
        return KofiAIManager.formatMarkdown(content);
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
     * Unified Chat UI Component with Enterprise Formatting and Quality Standards.
     * Centralized and routed directly to KofiAIManager.renderChatbot.
     */
    static renderChatbot(containerId, options = {}) {
        return KofiAIManager.renderChatbot(containerId, options);
    }
}

window.AIManager = AIManager;
