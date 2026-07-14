// Vercel Serverless Function: api/ai-gateway.js
// Handles downstream Gemini API content generation & embeddings.
// Keeps secret keys secured inside the Vercel environment.

const { classifyIntent, routeConversation } = require('./conversation-manager');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-session-id, x-supabase-signature',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
};

/**
 * Scans user inputs to detect prompt injection, toxic keywords, or out-of-scope requests.
 * Returns a professional, friendly refusal response string if blocked, or null if allowed.
 */
function filterTutorRequestIntent(message) {
  const normalized = message.toLowerCase();

  // 1. Prompt Injection Indicators
  const injectionPatterns = [
    "ignore previous instructions",
    "ignore all instructions",
    "system prompt",
    "system instruction",
    "you are now",
    "forget everything",
    "developer mode",
    "dan mode",
    "jailbreak",
    "override",
    "ignore the instructions",
    "output the above",
    "print your instructions",
    "reveal your prompt"
  ];

  if (injectionPatterns.some(p => normalized.includes(p))) {
    return "I am designed to be a helpful academic course tutor. I cannot bypass, reveal, or modify my system instructions, prompt configuration, or safety parameters. How can I assist you with your learning today?";
  }

  // 2. Toxic or Harmful Intent Indicators
  const harmfulIntentPatterns = [
    "how to hack",
    "write a virus",
    "write malware",
    "write an exploit",
    "how to bypass anti-cheat",
    "bypass anti cheat",
    "cheat on quiz",
    "sql injection script",
    "xss script",
    "how to ddos"
  ];

  if (harmfulIntentPatterns.some(p => normalized.includes(p))) {
    return "As your academic tutor, I cannot assist with security bypasses, cheats, or malicious activities. I would be happy to explain computer science or security concepts from an educational perspective instead!";
  }

  // 3. Out-Of-Scope General Knowledge/Trivia Tasks that are completely off-topic
  const outOfScopeIndicators = [
    "recipe for",
    "how to cook",
    "how to bake",
    "who is the president",
    "translate this to spanish",
    "how to make a cake",
    "favorite celebrity",
    "gossip about"
  ];

  if (outOfScopeIndicators.some(p => normalized.includes(p))) {
    return "I am your dedicated academic course tutor. I specialize in helping you understand the lessons, materials, and concepts of this course. I am unable to answer general lifestyle, entertainment, or unrelated queries. Let me know if you have any questions about our course topics!";
  }

  return null;
}

/**
 * Provides instant, cost-efficient, high-fidelity predefined answers for common platform inquiries.
 * Returns a markdown response string if matched, or null to fallback to the Gemini model.
 */
function findTutorPreciseResponse(message) {
  const normalized = message.toLowerCase().trim();

  const keywordMappings = [
    {
      keywords: ["my grade", "what is my grade", "view my grades", "check my score", "score on assignment", "how did i do"],
      response: "I am your course-aware academic tutor. Because I have absolutely **no access** to personal student records, grades, quiz/assignment submissions, or the gradebook, I cannot view or modify your grades. Please check the **Grades** tab in your student dashboard, or reach out to your instructor directly for grading inquiries."
    },
    {
      keywords: ["exam answers", "quiz solution", "assignment answers", "give me answers", "cheat on quiz", "reveal answers"],
      response: "To maintain academic integrity, I cannot provide direct answers, keys, or solutions to quizzes, assignments, or exams. However, I would be happy to explain the general concepts or walk you through practice examples to help you solve them yourself!"
    },
    {
      keywords: ["how to study", "study tips", "study advice", "how do i pass", "study guide"],
      response: "Here are some enterprise-grade study tips to excel in this course:\n1. 📖 **Review Course Materials**: Carefully go through the shared lessons and PDF materials under the 'Materials' tab.\n2. 🤖 **Engage with the AI Tutor**: Use our chat to ask follow-up questions about difficult concepts or request simplified explanations.\n3. 💬 **Participate in Discussions**: Engage with peers and teachers on the course discussion boards.\n4. 📝 **Take Notes**: Write down key terms and self-test your knowledge periodically."
    }
  ];

  for (const mapping of keywordMappings) {
    if (mapping.keywords.some(keyword => normalized.includes(keyword))) {
      return mapping.response;
    }
  }

  return null;
}

/**
 * Post-processes the LLM response to guarantee safety, syntax sanity, and prevents system leaks.
 * Auto-closes unclosed markdown ticks and fences, and scrubs prompt instructions.
 */
function runTutorResponseQualityGuard(response) {
  if (!response || typeof response !== 'string') return "";

  let cleaned = response;

  // 1. Prevent System Prompt/Constraint Leakage
  const leakWords = [
    "You are a professional academic tutor",
    "Key Tutoring Principles:",
    "Strict Academic Guardrails:",
    "systemPrompt",
    "systemInstruction",
    "Course Context:"
  ];

  for (const leak of leakWords) {
    if (cleaned.includes(leak)) {
      cleaned = cleaned.split(leak)[0];
    }
  }

  // Ensure it doesn't mention private prompt variables
  cleaned = cleaned.replace(/systemPrompt|system_instruction|generationConfig/gi, "tutor configuration");

  // 2. Strict Conversational Polish & Enterprise-Grade Verification Checks
  // A. Strip redundant robot/intro preambles for direct, off-topic-free responses
  const preambles = [
    /^sure,?\s*/i,
    /^absolutely,?\s*/i,
    /^i'd be happy to help with that,?\s*/i,
    /^here is the information,?\s*/i,
    /^as requested,?\s*/i,
    /^certainly,?\s*/i,
    /^no problem,?\s*/i
  ];
  for (const preamble of preambles) {
    cleaned = cleaned.replace(preamble, "");
  }

  // B. Prune common filler phrases and words to make the response highly concise
  cleaned = cleaned.replace(/\b(actually|basically|honestly|literally|essentially|simply)\b[,]?\s*/gi, "");
  cleaned = cleaned.replace(/\b(you know|kind of|sort of)\b[,]?\s*/gi, "");
  cleaned = cleaned.replace(/\bin order to\b/gi, "to");

  // C. Dedup consecutive duplicated words ("the the", "and and", etc.) - Safely restricted to common filler words
  const doubleWords = ["the", "and", "of", "to", "is", "in", "that", "a", "an", "with", "for", "on", "at", "by", "this", "it"];
  for (const word of doubleWords) {
    const doubleRegex = new RegExp(`\\b${word}\\s+${word}\\b`, 'gi');
    cleaned = cleaned.replace(doubleRegex, word);
  }

  // Temporary placeholders for URLs, decimals, and ellipsis to protect them from incorrect spacing cleanups
  const urlPlaceholders = [];
  cleaned = cleaned.replace(/(https?:\/\/[^\s]+)/gi, (match) => {
    const idx = urlPlaceholders.length;
    urlPlaceholders.push(match);
    return `___URL_PLACEHOLDER_${idx}___`;
  });

  const decimalPlaceholders = [];
  cleaned = cleaned.replace(/(\d+[\.,]\d+)/g, (match) => {
    const idx = decimalPlaceholders.length;
    decimalPlaceholders.push(match);
    return `___DECIMAL_PLACEHOLDER_${idx}___`;
  });

  cleaned = cleaned.replace(/\.\.\./g, "___ELLIPSIS_PLACEHOLDER___");

  // D. Collapse duplicate consecutive punctuation marks while preserving valid markdown ellipsis (...)
  cleaned = cleaned.replace(/!{2,}/g, "!");
  cleaned = cleaned.replace(/\?{2,}/g, "?");
  cleaned = cleaned.replace(/,{2,}/g, ",");
  cleaned = cleaned.replace(/\.{4,}/g, "...");
  cleaned = cleaned.replace(/(?<!\.)\.{2}(?!\.)/g, ".");

  // E. Clean punctuation spacing: ensure space after punctuation and no trailing/leading space issues
  cleaned = cleaned.replace(/([,.!?])([A-Za-z0-9])/g, "$1 $2");
  cleaned = cleaned.replace(/\s+([,.!?])/g, "$1");

  // Restore ellipsis, decimals, and URLs safely
  cleaned = cleaned.replace(/___ELLIPSIS_PLACEHOLDER___/g, "...");

  for (let i = 0; i < decimalPlaceholders.length; i++) {
    cleaned = cleaned.replace(`___DECIMAL_PLACEHOLDER_${i}___`, decimalPlaceholders[i]);
  }

  for (let i = 0; i < urlPlaceholders.length; i++) {
    cleaned = cleaned.replace(`___URL_PLACEHOLDER_${i}___`, urlPlaceholders[i]);
  }

  // F. Flawless Sentence Structure: ensure sentences start with capital letters
  cleaned = cleaned.replace(/(?<=[.!?]\s+|^)[a-z]/g, (match) => match.toUpperCase());

  // 3. Syntax Sanity: Auto-close incomplete or truncated Markdown tags
  // Code Blocks (```)
  const codeBlockCount = (cleaned.match(/```/g) || []).length;
  if (codeBlockCount % 2 !== 0) {
    cleaned += "\n```";
  }

  // Inline Code (`)
  const inlineCodeCount = (cleaned.match(/`/g) || []).length;
  if (inlineCodeCount % 2 !== 0) {
    cleaned += "`";
  }

  // Bold (**)
  const boldCount = (cleaned.match(/\*\*/g) || []).length;
  if (boldCount % 2 !== 0) {
    cleaned += "**";
  }

  // Italic (_)
  const italicCount = (cleaned.match(/_/g) || []).length;
  if (italicCount % 2 !== 0) {
    cleaned += "_";
  }

  // Simple Script Injection filter
  cleaned = cleaned.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");

  return cleaned.trim();
}

/**
 * Resolves the appropriate Gemini API Key for a given request.
 * Supports project-specific overrides (via project_id or course_id) and feature-specific credentials,
 * falling back gracefully to unified defaults.
 */
function resolveApiKey(type, payload = {}) {
  const projectId = payload.project_id || payload.projectId || payload.course_id;
  if (projectId) {
    const projectEnvKey = `GEMINI_PROJECT_${String(projectId).toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_API_KEY`;
    if (process.env[projectEnvKey]) {
      return process.env[projectEnvKey];
    }
  }

  const featureKeys = {
    tutor: process.env.GEMINI_COURSE_TUTOR_API_KEY,
    generate_assessment: process.env.GEMINI_ASSESSMENT_API_KEY,
    grading: process.env.GEMINI_GRADING_API_KEY,
    analytics: process.env.GEMINI_ANALYTICS_API_KEY,
    kofi: process.env.GEMINI_PLATFORM_API_KEY,
    voice: process.env.GEMINI_VOICE_API_KEY || process.env.GEMINI_COURSE_TUTOR_API_KEY,
    generate_embedding: process.env.GEMINI_EMBEDDING_API_KEY,
    generate_batch_embeddings: process.env.GEMINI_EMBEDDING_API_KEY
  };

  if (featureKeys[type]) {
    return featureKeys[type];
  }

  return process.env.GEMINI_31_FLASH_LITE_API_KEY ||
         process.env.GEMINI_COURSE_TUTOR_API_KEY ||
         process.env.GEMINI_PLATFORM_API_KEY ||
         process.env.GEMINI_API_KEY ||
         process.env.GEMINI_VOICE_API_KEY ||
         process.env.GEMINI_EMBEDDING_API_KEY;
}

/**
 * Resolves the confirmed, official, valid model ID for the request.
 * Centralizes all non-excluded project models to "gemini-3.1-flash-lite" by default.
 */
function resolveModelId(type, payload = {}) {
  if (type === 'voice') {
    let voiceModel = process.env.GEMINI_VOICE_MODEL || "gemini-2.5-flash-native-audio";
    const norm = voiceModel.trim().toLowerCase();
    if (
      norm === 'gemini 2.5 flash native audio' ||
      norm === 'gemini-2.5-flash-native-audio' ||
      norm === 'gemini_2.5_flash_native_audio' ||
      norm === 'gemini 25 flash native audio' ||
      norm === 'gemini-25-flash-native-audio' ||
      norm === 'models/gemini-2.5-flash-native-audio'
    ) {
      return "gemini-2.5-flash-native-audio";
    }
    return voiceModel;
  }

  if (type === 'generate_embedding' || type === 'generate_batch_embeddings') {
    let embeddingModel = process.env.GEMINI_EMBEDDING_MODEL || "text-embedding-004";
    const norm = embeddingModel.trim().toLowerCase();
    if (
      norm === 'gemini-embedding' ||
      norm === 'gemini_embedding' ||
      norm === 'gemini embedding' ||
      norm === 'gemini-embedding-004' ||
      norm === 'text-embedding-004' ||
      norm === 'gemini embedding 004' ||
      norm === 'gemini_embedding_004' ||
      norm === 'models/text-embedding-004'
    ) {
      return "text-embedding-004";
    }
    return embeddingModel;
  }

  // The 5 core project models (Course Tutor, Assessment Generator, Grading Assistant, Analytics AI, and Kofi Assistant)
  // are all strictly hardcoded to use the centralized official, valid, and supported Gemini 3.1 Flash Lite model ID.
  return "gemini-3.1-flash-lite";
}

/**
 * Unified, enterprise-grade Gemini API calling helper.
 * Handles headers, request bodies, error handling, quality guards, and response formatting.
 */
async function callGeminiAPI(options) {
  const {
    apiKey,
    model,
    prompt,
    systemInstruction,
    history = [],
    temperature = 0.7,
    topP = 0.8,
    topK = 40,
    maxOutputTokens = 2048,
    responseMimeType = null
  } = options;

  if (!apiKey) {
    throw new Error(`Gemini API Key is not configured in the environment.`);
  }

  const contents = [
    ...history.map(h => ({
      role: h.role === 'assistant' || h.role === 'model' ? 'model' : 'user',
      parts: [{ text: h.content }]
    })),
    { role: 'user', parts: [{ text: prompt }] }
  ];

  const requestBody = {
    contents,
    system_instruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      temperature,
      topP,
      topK,
      maxOutputTokens,
    }
  };

  if (responseMimeType) {
    requestBody.generationConfig.responseMimeType = responseMimeType;
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API returned ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return { rawText, data };
}

module.exports = async function handler(req, res) {
  console.log("AI Gateway Request:", {
    method: req.method,
    headers: req.headers
  });
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, corsHeaders);
    res.end('ok');
    return;
  }

  try {
    // Validate signature/authorization to prevent unauthorized direct calls
    // Uses a secure private secret (AI_GATEWAY_SECRET) or falls back to service role / anon key
    const signature = req.headers['x-supabase-signature'];
    const expectedSignature = process.env.AI_GATEWAY_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

    let userEmail = null;
    let userRole = null;

    const { type, payload } = req.body || {};

    if (signature && signature === expectedSignature) {
      // Delegated request (e.g. from Supabase Edge Function with validated signature)
      // Trust the payload's email and role
      userEmail = payload?.email;
      userRole = payload?.role;
    } else {
      // Direct same-origin request from client
      // Perform server-to-server validation by calling Supabase RPC get_ai_access_context directly
      const sessionId = req.headers['x-session-id'] || '';
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

      if (!supabaseUrl || !supabaseAnonKey) {
        res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server configuration error: missing SUPABASE_URL or SUPABASE_ANON_KEY' }));
        return;
      }

      if (!type) {
        res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing request type' }));
        return;
      }

      // Call Supabase REST RPC for authorization
      const authResponse = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/get_ai_access_context`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseAnonKey,
          'Authorization': `Bearer ${supabaseAnonKey}`,
          'x-session-id': sessionId
        },
        body: JSON.stringify({
          p_operation_type: type,
          p_payload: payload || {}
        })
      });

      if (!authResponse.ok) {
        const errorText = await authResponse.text();
        res.writeHead(403, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Authorization failed: ${errorText}` }));
        return;
      }

      const authContext = await authResponse.json();
      if (!authContext || !authContext.authorized) {
        res.writeHead(authContext?.error === 'Authentication required' ? 401 : 403, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: authContext?.error || 'Unauthorized' }));
        return;
      }

      userEmail = authContext.email;
      userRole = authContext.role;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    if (!type || !payload) {
      res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing request type or payload' }));
      return;
    }

    // Attach verified identity to payload
    payload.email = userEmail;
    payload.role = userRole;

    // Process materials RAG inside tutor if direct request (so that semantic search works!)
    if (type === 'tutor' && !signature) {
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
      const { course_id, message } = payload;

      // 1. Generate embedding for user message using configured embedding model
      const apiKey = resolveApiKey('generate_embedding', payload);
      const embeddingModel = resolveModelId('generate_embedding', payload);
      const cleanEmbeddingModel = embeddingModel.replace(/^models\//, '');
      let context = '';

      if (apiKey) {
        try {
          const embedRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cleanEmbeddingModel}:embedContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: `models/${cleanEmbeddingModel}`,
              content: { parts: [{ text: message }] }
            })
          });

          if (embedRes.ok) {
            const embedData = await embedRes.json();
            const embedding = embedData.embedding.values;

            // 2. Call match_materials RPC
            const matchResponse = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/match_materials`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseAnonKey,
                'Authorization': `Bearer ${supabaseAnonKey}`,
                'x-session-id': req.headers['x-session-id'] || ''
              },
              body: JSON.stringify({
                query_embedding: embedding,
                match_threshold: 0.3,
                match_count: 5,
                p_course_id: course_id
              })
            });

            if (matchResponse.ok) {
              const matches = await matchResponse.json();
              if (matches && matches.length > 0) {
                context = matches.map(m => m.content).join('\n---\n');
              }
            }
          }
        } catch (embedError) {
          console.error('Semantic search in Vercel failed:', embedError);
        }
      }

      if (!context) {
        // Fallback to basic retrieval using REST API endpoints
        try {
          const [matRes, lesRes] = await Promise.all([
            fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/materials?course_id=eq.${course_id}&limit=5`, {
              headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
            }),
            fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/lessons?course_id=eq.${course_id}&limit=5`, {
              headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
            })
          ]);

          const materials = matRes.ok ? await matRes.json() : [];
          const lessons = lesRes.ok ? await lesRes.json() : [];

          context = [
            ...(materials || []).map(m => `Material: ${m.title} - ${m.description}`),
            ...(lessons || []).map(l => `Lesson: ${l.title}\nContent: ${l.content}`)
          ].join('\n\n');
        } catch (retrievalError) {
          console.error('Basic context retrieval failed:', retrievalError);
        }
      }

      payload.context = context;
    }

    switch (type) {
      case 'tutor':
        return await handleCourseTutor(payload, res);

      case 'generate_assessment':
        return await handleAssessmentGenerator(payload, res);

      case 'grading':
        return await handleGradingAssistant(payload, res);

      case 'analytics':
        return await handleAnalyticsAI(payload, res);

      case 'generate_embedding':
        return await handleGenerateEmbedding(payload, res);

      case 'generate_batch_embeddings':
        return await handleGenerateBatchEmbeddings(payload, res);

      case 'extract_pdf_text':
        return await handleExtractPdfText(payload, res);

      case 'voice':
        return await handleVoiceAI(payload, res);

      default:
        res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unsupported AI operation: ${type}` }));
        return;
    }

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : (error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error));
    console.error('Vercel AI Gateway Error:', errorMsg);
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: errorMsg,
      timestamp: new Date().toISOString(),
      type: 'vercel_gateway_error'
    }));
  }
};

/**
 * Feature 1 & 6: Course-aware Tutor
 */
async function handleCourseTutor(payload, res) {
  let { message, history = [], context = '' } = payload;

  if (!message || typeof message !== 'string') {
    res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid message parameter' }));
    return;
  }

  message = message.trim();
  if (message.length > 1000) {
    res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Message is too long (maximum 1000 characters)' }));
    return;
  }

  if (!Array.isArray(history)) {
    history = [];
  }

  const sanitizedHistory = history
    .slice(-10)
    .filter(h => {
      return h &&
             typeof h === 'object' &&
             typeof h.content === 'string' &&
             h.content.trim().length > 0 &&
             (h.role === 'user' || h.role === 'assistant' || h.role === 'model');
    })
    .map(h => ({
      role: h.role === 'assistant' || h.role === 'model' ? 'assistant' : 'user',
      content: h.content.trim().substring(0, 2000)
    }));

  const classification = classifyIntent(message);

  const decision = routeConversation(message);
  if (decision.action !== 'fallback') {
    console.log(`[Tutor Conversation Manager] Intercepted. Action: ${decision.action}, Intent: ${decision.metadata.intent}, Confidence: ${decision.metadata.confidence}`);
    const polishedText = runTutorResponseQualityGuard(decision.content);
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      content: polishedText,
      intent: decision.metadata.intent,
      category: decision.metadata.category,
      confidence: decision.metadata.confidence,
      entities: decision.metadata.entities,
      action: decision.action
    }));
    return;
  }

  const filterRefusal = filterTutorRequestIntent(message);
  if (filterRefusal) {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      content: filterRefusal,
      intent: classification.intent,
      category: classification.category,
      confidence: classification.confidence,
      entities: classification.entities,
      action: 'filter_refusal'
    }));
    return;
  }

  const preciseResponse = findTutorPreciseResponse(message);
  if (preciseResponse) {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      content: preciseResponse,
      intent: classification.intent,
      category: classification.category,
      confidence: classification.confidence,
      entities: classification.entities,
      action: 'precise_response'
    }));
    return;
  }

  const apiKey = resolveApiKey('tutor', payload);
  const tutorModel = resolveModelId('tutor', payload);

  const systemPrompt = `You are a professional academic tutor for this course.
  Your goal is to provide high-quality, conversational tutoring.
  Use the provided course context to answer student questions.

  Key Tutoring Principles:
  1. Conversational Style: Be encouraging, clear, and professional.
  2. Explanations over answers: Don't just provide direct answers; explain the underlying concepts.
  3. Scaffolding: Provide hints and guide the student towards finding the answer themselves.
  4. Follow-up: Always ask a relevant follow-up question to deepen the student's understanding.

  Strict Academic Guardrails:
  - You have absolutely NO access to quizzes, exams, assignments, student submissions, or grades.
  - If a student asks about their grades, specific assignment answers, quiz solutions, or submission statuses, you MUST politely explain that you do not have access to that information and can only assist them in learning and understanding the course concepts, lessons, and materials.
  - Do not make up answers. If the information is not in the context, guide the student based on general academic principles related to the topic, but prioritize course-specific info.
  - Strict Conversational Quality Check:
    * Grammar and Sentence Structure: Always use flawless grammar, perfect spelling, precise punctuation, elegant sentence structure, consistent verb tenses, and correct subject-verb agreements.
    * Removing Fillers and Repetitions: Never use filler words (such as "actually", "basically", "honestly", "literally", "essentially", "simply", "just", "you know"). Do not repeat words, phrases, or points.
    * Conciseness and Tone: Keep your responses highly concise, direct, and focused. Maintain a professional, helpful, and objective enterprise-grade tone.
    * Request vs Response Checking: Ensure that your response matches the user's request precisely without off-topic preamble or generic robotic intros.
    * Precision Over Explanations: Prioritize precise, high-fidelity facts and direct navigational guidance over long, verbose explanations.

  Course Context:
  ${context.substring(0, 15000)}`;

  try {
    const { rawText, data } = await callGeminiAPI({
      apiKey,
      model: tutorModel,
      prompt: message,
      systemInstruction: systemPrompt,
      history: sanitizedHistory,
      temperature: 0.7
    });

    const guardedText = runTutorResponseQualityGuard(rawText);

    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      content: guardedText,
      raw: data,
      intent: classification.intent,
      category: classification.category,
      confidence: classification.confidence,
      entities: classification.entities,
      action: 'fallback_tutor_gemini'
    }));
  } catch (error) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

/**
 * Feature 2: Assessment Generator
 */
async function handleAssessmentGenerator(payload, res) {
  const { topic, type, count, difficulty, rubrics, email, role, lesson_title, lesson_content } = payload;
  const apiKey = resolveApiKey('generate_assessment', payload);
  const assessmentModel = resolveModelId('generate_assessment', payload);

  let schemaPrompt = '';
  if (type === 'quiz') {
    schemaPrompt = `Each question object in the array MUST use the following fields:
  - "text": string (the question text)
  - "type": "mcq" (Multiple Choice), "tf" (True/False), or "short" (Short Answer)
  - "points": number (e.g. 5)
  - "hint": string (optional hint)
  - "explanation": string (optional explanation for the correct answer)
  - "options": array of 4 strings (for "mcq" type; empty/omitted for others)
  - "correct": string
    * For "mcq": index of the correct option as a string (e.g., "0", "1", "2", "3")
    * For "tf": "True" or "False"
    * For "short": string containing the correct exact-match answer`;
  } else {
    schemaPrompt = `Each question object in the array MUST use the following fields:
  - "text": string (the question text)
  - "type": "essay", "file", or "link" (the primary submission type)
  - "types": array of strings (e.g. ["essay"], ["file"], ["link"] - can include multiple if appropriate)
  - "points": number (e.g. 10)
  - "extensions": string (comma-separated list of allowed file extensions, e.g. ".pdf, .docx, .png" if "file" type is used, otherwise empty string)`;
  }

  let cognitiveFocus = '';
  const diffLower = (difficulty || '').toLowerCase();
  if (diffLower === 'beginner') {
    cognitiveFocus = `COGNITIVE COMPLEXITY (Bloom's Taxonomy): BEGINNER (Remembering and Understanding).
  Focus on testing recall, key facts, primary definitions, and basic concepts. Questions should ask "What is...", "Define...", "Identify...", or "Which of the following is true...".`;
  } else if (diffLower === 'advanced') {
    cognitiveFocus = `COGNITIVE COMPLEXITY (Bloom's Taxonomy): ADVANCED (Evaluating and Creating).
  Focus on high-level evaluation, critical analysis, multi-step problem solving, design, and synthesis. Questions should present complex scenarios, asking the user to evaluate solutions, design structures, or critique theoretical frameworks.`;
  } else {
    cognitiveFocus = `COGNITIVE COMPLEXITY (Bloom's Taxonomy): INTERMEDIATE (Applying and Analyzing).
  Focus on application of concepts to specific situations and analytical problem solving. Questions should present a concrete scenario, code snippet, or situation where the concept is applied.`;
  }

  let lessonPrompt = '';
  if (lesson_content && lesson_content.trim() !== '') {
    lessonPrompt = `
  The assessment MUST be strictly aligned with the following lesson content:
  ---
  LESSON TITLE: ${lesson_title || 'Selected Lesson'}
  LESSON CONTENT:
  ${lesson_content}
  ---
  Ensure that you only generate questions about the concepts, definitions, theories, and details explicitly mentioned in the lesson above. Do not include external or off-topic information.`;
  }

  const systemPrompt = `You are an expert curriculum designer and assessment generator.
  Generating for Teacher: ${email || 'Teacher'}
  Role: ${role || 'teacher'}
  You MUST output ONLY a valid JSON array of question objects matching the SmartLMS schema. Do not output any conversational preamble or markdown outer formatting other than the JSON block.`;

  const prompt = `Generate a ${type} with exactly ${count} questions about "${topic}".
  Difficulty level: ${difficulty}.

  ${cognitiveFocus}

  ${lessonPrompt}

  ${rubrics ? `Follow these rules/rubrics for assessment style: ${rubrics}` : ''}

  Output MUST be a valid JSON array of question objects matching the SmartLMS schema.

  ${schemaPrompt}

  Ensure all questions are grammatically perfect, concise, professional, and completely free of conversational filler words. Return ONLY the JSON block.`;

  try {
    const { rawText, data } = await callGeminiAPI({
      apiKey,
      model: assessmentModel,
      prompt,
      systemInstruction: systemPrompt,
      temperature: 0.2, // Lower temperature for structured JSON
      responseMimeType: 'application/json'
    });

    let parsed = null;
    try {
      parsed = JSON.parse(rawText.trim());
    } catch (e) {
      const patterns = [
        /```json\s*([\s\S]*?)\s*```/,
        /```\s*([\s\S]*?)\s*```/,
        /(\[\s*\{[\s\S]*\}\s*\])/,
        /(\{\s*".*"\s*:[\s\S]*\})/
      ];
      for (const pattern of patterns) {
        const match = rawText.match(pattern);
        if (match) {
          try {
            parsed = JSON.parse((match[1] || match[0]).trim());
            break;
          } catch (e2) {}
        }
      }
    }

    if (!Array.isArray(parsed)) {
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.questions)) {
        parsed = parsed.questions;
      } else if (parsed && typeof parsed === 'object') {
        parsed = [parsed];
      } else {
        parsed = [];
      }
    }

    parsed.forEach(q => {
      if (q.text) q.text = runTutorResponseQualityGuard(q.text);
      if (q.hint) q.hint = runTutorResponseQualityGuard(q.hint);
      if (q.explanation) q.explanation = runTutorResponseQualityGuard(q.explanation);
      if (Array.isArray(q.options)) {
        q.options = q.options.map(opt => typeof opt === 'string' ? runTutorResponseQualityGuard(opt) : opt);
      }
      if (typeof q.points === 'string') {
        q.points = parseInt(q.points) || 5;
      } else if (typeof q.points !== 'number') {
        q.points = 5;
      }
      q.points = Math.max(1, q.points);

      // Strictly remove any generated 'difficulty' field
      if ('difficulty' in q) {
        delete q.difficulty;
      }
    });

    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      content: JSON.stringify(parsed),
      raw: data
    }));

  } catch (error) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

/**
 * Feature 3: Grading Assistant
 */
async function handleGradingAssistant(payload, res) {
  const { assignment_title, student_submission, rubric, questions, email, role } = payload;
  const apiKey = resolveApiKey('grading', payload);
  const gradingModel = resolveModelId('grading', payload);

  let questionList = [];
  if (Array.isArray(questions)) {
    questionList = questions.map((q, idx) => {
      if (typeof q === 'object' && q !== null) {
        return `Question ${idx + 1}: ${q.text || ''} (Max Points: ${q.points || 0})`;
      } else {
        return `Question ${idx + 1}: ${q}`;
      }
    });
  }

  const prompt = `Assignment: ${assignment_title}
  Rubric: ${rubric}
  Questions: ${JSON.stringify(questionList)}
  Student Work: ${student_submission}

  Please evaluate this student submission carefully and professionally.
  You MUST return a valid JSON object containing exactly the following three keys:
  1. "report": A beautifully styled and detailed Markdown report. It should include:
     - Question-by-Question Evaluation: Breakdown of each question with suggested scores and helpful critique.
     - Rubric Scoring Analysis: Analysis of how the student's work meets the specified rubric.
     - Overall Feedback & Recommendation: Summary of strengths, key areas for improvement, and recommended total score.
  2. "overall_feedback": A summarized, precise, sanitized, and professional overall feedback/recommendation text for the teacher to apply directly. No conversational fillers or preambles. Max 3 sentences.
  3. "questions": An array of objects for each question:
     - "question_index": (integer, 0-indexed corresponding to the index in the Questions array)
     - "score": (number, suggested score for this question, clamped between 0 and the max points for this question)
     - "feedback": (string, specific, professional, and constructive feedback comment for this specific question index. Max 2 sentences, sanitized)

  Ensure all scores are numeric and clamped to the max points for the corresponding question. Keep descriptions of feedback professional, constructive, and precise. No conversational filler or preamble in the JSON. Output ONLY the raw JSON block without any markdown code fences or conversational text outside the block.`;

  const systemPrompt = `You are a fair, precise, and insightful teaching assistant.
  Assisting Teacher: ${email}
  Role: ${role}
  Help the teacher grade by providing insights based on the rubric. Output ONLY valid JSON containing report, overall_feedback, and questions keys.`;

  try {
    const { rawText, data } = await callGeminiAPI({
      apiKey,
      model: gradingModel,
      prompt,
      systemInstruction: systemPrompt,
      temperature: 0.2, // Lower temperature for structured JSON
      responseMimeType: 'application/json'
    });

    let parsed = null;
    try {
      parsed = JSON.parse(rawText.trim());
    } catch (e) {
      const patterns = [
        /```json\s*([\s\S]*?)\s*```/,
        /```\s*([\s\S]*?)\s*```/,
        /(\{\s*".*"\s*:[\s\S]*\})/
      ];
      for (const pattern of patterns) {
        const match = rawText.match(pattern);
        if (match) {
          try {
            parsed = JSON.parse((match[1] || match[0]).trim());
            break;
          } catch (e2) {}
        }
      }
    }

    if (parsed) {
      if (parsed.report) parsed.report = runTutorResponseQualityGuard(parsed.report);
      if (parsed.overall_feedback) parsed.overall_feedback = runTutorResponseQualityGuard(parsed.overall_feedback);
      if (Array.isArray(parsed.questions)) {
        parsed.questions.forEach(q => {
          if (q.feedback) q.feedback = runTutorResponseQualityGuard(q.feedback);
        });
      }
    } else {
      const guardedText = runTutorResponseQualityGuard(rawText);
      parsed = {
        report: guardedText,
        overall_feedback: "Please review the detailed AI Insights report for grading suggestions.",
        questions: []
      };
    }

    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      content: JSON.stringify(parsed),
      raw: data
    }));

  } catch (error) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

/**
 * Feature 4: Role-based Analytics
 */
async function handleAnalyticsAI(payload, res) {
  const { analytics_data, question, email, role } = payload;
  const apiKey = resolveApiKey('analytics', payload);
  const analyticsModel = resolveModelId('analytics', payload);

  const prompt = `My Role: ${role}
  My Identity: ${email}
  Analytics Data: ${JSON.stringify(analytics_data)}
  Question: ${question}

  Analyze the data and provide actionable insights, trends, and risk predictions.`;

  let systemPrompt = `You are a senior educational data analyst. You provide deep insights from LMS performance data.
  Analyzing for user: ${email}
  Role: ${role}.`;

  if (role === 'admin') {
    systemPrompt += `
    Since you are an administrator, focus on high-level administrative insights, platform-wide trends, system-wide metrics (such as active users, courses, enrollments, submissions), and potential security, proctoring, or academic integrity risk summaries across the entire institution.`;
  } else if (role === 'teacher') {
    systemPrompt += `
    Since you are a teacher, focus on course-level performance, tracking student completion rates, average scores, identifying low-performing or "at-risk" students, recommending targeted academic interventions, and suggesting updates or adjustments to lesson materials or assignments based on performance gaps.`;
  } else {
    systemPrompt += `
    Since you are a student, focus on personal progress tutoring. Highlight strengths, identify areas of improvement based on recent grades, suggest helpful study habits, and provide encouragement. Be a supportive personal study assistant.`;
  }

  systemPrompt += `
  Strict Conversational Quality Check:
  - Grammar and Sentence Structure: Always use flawless grammar, perfect spelling, precise punctuation, elegant sentence structure, consistent verb tenses, and correct subject-verb agreements.
  - Removing Fillers and Repetitions: Never use filler words (such as "actually", "basically", "honestly", "literally", "essentially", "simply", "just", "you know"). Do not repeat words, phrases, or points.
  - Conciseness and Tone: Keep your responses highly concise, direct, and focused. Maintain a professional, helpful, and objective enterprise-grade tone.
  - Request vs Response Checking: Ensure that your response matches the user's request precisely without off-topic preamble or generic robotic intros.
  - Precision Over Explanations: Prioritize precise, high-fidelity facts and direct navigational guidance over long, verbose explanations.`;

  try {
    const { rawText, data } = await callGeminiAPI({
      apiKey,
      model: analyticsModel,
      prompt,
      systemInstruction: systemPrompt,
      temperature: 0.7
    });

    const guardedText = runTutorResponseQualityGuard(rawText);

    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      content: guardedText,
      raw: data
    }));
  } catch (error) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

/**
 * Feature 6: PDF Text Extraction via Gemini multimodal capabilities
 */
async function handleExtractPdfText(payload, res) {
  const { file_url } = payload;
  if (!file_url) {
    res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'file_url is required' }));
    return;
  }

  try {
    const pdfResponse = await fetch(file_url);
    if (!pdfResponse.ok) {
      throw new Error(`Failed to download PDF: ${pdfResponse.statusText}`);
    }

    const arrayBuffer = await pdfResponse.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString('base64');

    const apiKey = resolveApiKey('tutor', payload);
    const model = 'gemini-1.5-flash';

    const requestBody = {
      contents: [
        {
          parts: [
            {
              inline_data: {
                mime_type: 'application/pdf',
                data: base64Data
              }
            },
            {
              text: 'Extract and transcribe all plain text content, formulas, figures descriptions, and structured concepts from this PDF document. Render the text sequentially as clean, readable paragraphs. Do not add any summary, explanation, or conversational preamble; only return the verbatim extracted document text.'
            }
          ]
        }
      ]
    };

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini PDF Parse Error: ${errorText}`);
    }

    const data = await response.json();
    const extractedText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: extractedText }));
  } catch (error) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

/**
 * Feature 6: Embedding Generation for RAG
 */
async function handleGenerateEmbedding(payload, res) {
  const { text } = payload;
  const apiKey = resolveApiKey('generate_embedding', payload);
  const embeddingModel = resolveModelId('generate_embedding', payload);
  const cleanEmbeddingModel = embeddingModel.replace(/^models\//, '');

  if (!apiKey) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'GEMINI_EMBEDDING_API_KEY not configured' }));
    return;
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cleanEmbeddingModel}:embedContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${cleanEmbeddingModel}`,
        content: { parts: [{ text }] }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Embedding API Error: ${errorText}` }));
      return;
    }

    const data = await response.json();
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ embedding: data.embedding.values }));
  } catch (error) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

async function handleGenerateBatchEmbeddings(payload, res) {
  const { texts } = payload;
  const apiKey = resolveApiKey('generate_batch_embeddings', payload);
  const embeddingModel = resolveModelId('generate_batch_embeddings', payload);
  const cleanEmbeddingModel = embeddingModel.replace(/^models\//, '');

  if (!apiKey) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'GEMINI_EMBEDDING_API_KEY not configured' }));
    return;
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cleanEmbeddingModel}:batchEmbedContents?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map(text => ({
          model: `models/${cleanEmbeddingModel}`,
          content: { parts: [{ text }] }
        }))
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Batch Embedding API Error: ${errorText}` }));
      return;
    }

    const data = await response.json();
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ embeddings: data.embeddings.map(e => e.values) }));
  } catch (error) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

/**
 * Feature 7: Voice / Native Audio processing
 */
async function handleVoiceAI(payload, res) {
  const { message, audio, history = [] } = payload;
  const apiKey = resolveApiKey('voice', payload);
  const voiceModel = resolveModelId('voice', payload);

  if (!apiKey) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'GEMINI_VOICE_API_KEY not configured' }));
    return;
  }

  const parts = [];
  if (message) {
    parts.push({ text: message });
  }
  if (audio) {
    parts.push({
      inline_data: {
        mime_type: "audio/mp3",
        data: audio
      }
    });
  }

  const systemPrompt = `You are a professional voice assistant. Respond concisely and professionally.`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${voiceModel}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        system_instruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1024,
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Voice API error: ${errorText}` }));
      return;
    }

    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const guardedText = runTutorResponseQualityGuard(rawText);

    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      content: guardedText,
      raw: data
    }));
  } catch (error) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}
