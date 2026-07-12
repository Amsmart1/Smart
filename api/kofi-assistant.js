// Vercel Serverless Function: api/kofi-assistant.js
// Handles platform guide (Kofi AI) requests publicly without auth, session or Supabase check.
// Enhanced with enterprise-grade rate limiting, same-origin domain lock, input sanitization, and robust error handling.
// Public Kofi AI assistant model: gemini-3.1-flash-lite by default.

const fs = require('fs');
const path = require('path');
const { classifyIntent, routeConversation } = require('./conversation-manager');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

// Static in-memory cache for IP-based rate limiting
const ipRateLimitCache = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 30; // 30 requests per minute per IP

/**
 * Clean up rate limit cache lazily to prevent memory leaks
 */
function cleanRateLimitCache() {
  if (ipRateLimitCache.size > 2000) {
    const now = Date.now();
    for (const [ip, timestamps] of ipRateLimitCache.entries()) {
      const active = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
      if (active.length === 0) {
        ipRateLimitCache.delete(ip);
      } else {
        ipRateLimitCache.set(ip, active);
      }
    }
  }
}

/**
 * Checks if an IP is rate limited
 */
function checkRateLimit(ip) {
  const now = Date.now();
  cleanRateLimitCache();

  if (!ipRateLimitCache.has(ip)) {
    ipRateLimitCache.set(ip, [now]);
    return false;
  }

  const timestamps = ipRateLimitCache.get(ip);
  const activeTimestamps = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  activeTimestamps.push(now);
  ipRateLimitCache.set(ip, activeTimestamps);

  return activeTimestamps.length > MAX_REQUESTS_PER_WINDOW;
}

/**
 * Assesses if the referer/origin is authorized (Same-Origin Protection)
 */
function isAuthorizedOrigin(req) {
  const referer = req.headers.referer;
  const origin = req.headers.origin;
  const host = req.headers.host;

  // Local development bypass
  if (process.env.NODE_ENV !== 'production') {
    return true;
  }

  try {
    const refOrOrig = referer || origin;
    if (!refOrOrig) {
      if (host && (host.startsWith('localhost') || host.startsWith('127.0.0.1'))) {
        return true;
      }
      return false;
    }

    const urlObj = new URL(refOrOrig);
    const refHost = urlObj.host;

    if (host && refHost === host) {
      return true;
    }

    const vercelUrl = process.env.VERCEL_PROJECT_URL || process.env.VERCEL_URL;
    if (vercelUrl) {
      const vercelHost = vercelUrl.replace(/^https?:\/\//, '');
      if (urlObj.hostname === vercelHost || urlObj.hostname.endsWith('.' + vercelHost)) {
        return true;
      }
    }

    if (urlObj.hostname === 'localhost' || urlObj.hostname === '127.0.0.1') {
      return true;
    }

    return false;
  } catch (err) {
    return false;
  }
}

// Global cached documentation sections
let cachedDocs = null;

/**
 * Loads, splits, and caches sections from local documentation files (PLATFORM_DOCS.md & README.md)
 */
function loadPlatformDocs() {
  if (cachedDocs) return cachedDocs;

  const docsPath = path.join(process.cwd(), 'PLATFORM_DOCS.md');
  const readmePath = path.join(process.cwd(), 'README.md');

  let docsContent = "";
  let readmeContent = "";

  try {
    if (fs.existsSync(docsPath)) {
      docsContent = fs.readFileSync(docsPath, 'utf8');
    }
  } catch (err) {
    console.error("Failed to read PLATFORM_DOCS.md:", err);
  }

  try {
    if (fs.existsSync(readmePath)) {
      readmeContent = fs.readFileSync(readmePath, 'utf8');
    }
  } catch (err) {
    console.error("Failed to read README.md:", err);
  }

  const sections = [];
  const combined = docsContent + "\n\n" + readmeContent;
  const lines = combined.split('\n');

  let currentHeader = "";
  let currentContent = [];

  for (const line of lines) {
    const match = line.match(/^(##+)\s+(.*)$/);
    if (match) {
      if (currentHeader && currentContent.length > 0) {
        sections.push({
          header: currentHeader,
          content: currentContent.join('\n').trim()
        });
      }
      currentHeader = match[2].trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentHeader && currentContent.length > 0) {
    sections.push({
      header: currentHeader,
      content: currentContent.join('\n').trim()
    });
  }

  cachedDocs = sections;
  return cachedDocs;
}

/**
 * Searches parsed sections using weighted keyword frequencies
 */
function findRelevantSection(query, sections) {
  if (!query || !sections || sections.length === 0) return null;

  const normalizedQuery = query.toLowerCase().trim();
  let bestMatch = null;
  let highestScore = 0;

  const stopWords = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'and', 'or', 'but', 'if', 'then', 'else',
    'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off',
    'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where',
    'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
    'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'can', 'will',
    'just', 'should', 'now', 'what', 'does', 'do', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
    'my', 'your', 'his', 'her', 'its', 'our', 'their'
  ]);

  const queryWords = normalizedQuery
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));

  for (const section of sections) {
    let score = 0;
    const headerLower = section.header.toLowerCase();
    const contentLower = section.content.toLowerCase();

    if (headerLower.includes(normalizedQuery)) {
      score += 15;
    }

    for (const word of queryWords) {
      const headerRegex = new RegExp(`\\b${word}\\b`, 'gi');
      const headerMatches = headerLower.match(headerRegex);
      if (headerMatches) {
        score += headerMatches.length * 8;
      }

      const contentRegex = new RegExp(`\\b${word}\\b`, 'gi');
      const contentMatches = contentLower.match(contentRegex);
      if (contentMatches) {
        score += contentMatches.length * 1.5;
      }
    }

    if (score > highestScore) {
      highestScore = score;
      bestMatch = { section, score };
    }
  }

  if (highestScore >= 6) {
    return bestMatch.section;
  }

  return null;
}

/**
 * Post-processes LLM response to guarantee safety, syntax sanity, and prevents system leaks.
 * Auto-closes unclosed markdown ticks and fences, and scrubs prompt instructions.
 */
function runResponseQualityGuard(response) {
  if (!response || typeof response !== 'string') return "";

  let cleaned = response;

  const leakWords = [
    "You are a professional academic tutor",
    "Key Tutoring Principles:",
    "Strict Academic Guardrails:",
    "systemPrompt",
    "systemInstruction",
    "Course Context:",
    "Key Platform Features",
    "Important Constraints:",
    "Strict Conversational Quality Check:"
  ];

  for (const leak of leakWords) {
    if (cleaned.includes(leak)) {
      cleaned = cleaned.split(leak)[0];
    }
  }

  cleaned = cleaned.replace(/systemPrompt|system_instruction|generationConfig/gi, "configuration");

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

  cleaned = cleaned.replace(/\b(actually|basically|honestly|literally|essentially|simply)\b[,]?\s*/gi, "");
  cleaned = cleaned.replace(/\b(you know|kind of|sort of)\b[,]?\s*/gi, "");
  cleaned = cleaned.replace(/\bin order to\b/gi, "to");

  cleaned = cleaned.replace(/\b(\w+)\s+\1\b/gi, "$1");

  cleaned = cleaned.replace(/!{2,}/g, "!");
  cleaned = cleaned.replace(/\?{2,}/g, "?");
  cleaned = cleaned.replace(/,{2,}/g, ",");
  cleaned = cleaned.replace(/\.{4,}/g, "...");
  cleaned = cleaned.replace(/(?<!\.)\.{2}(?!\.)/g, ".");

  cleaned = cleaned.replace(/([,.!?])([A-Za-z0-9])/g, "$1 $2");
  cleaned = cleaned.replace(/\s+([,.!?])/g, "$1");

  cleaned = cleaned.replace(/(?<=[.!?]\s+|^)[a-z]/g, (match) => match.toUpperCase());

  const codeBlockCount = (cleaned.match(/```/g) || []).length;
  if (codeBlockCount % 2 !== 0) {
    cleaned += "\n```";
  }

  const inlineCodeCount = (cleaned.match(/`/g) || []).length;
  if (inlineCodeCount % 2 !== 0) {
    cleaned += "`";
  }

  const boldCount = (cleaned.match(/\*\*/g) || []).length;
  if (boldCount % 2 !== 0) {
    cleaned += "**";
  }

  const italicCount = (cleaned.match(/_/g) || []).length;
  if (italicCount % 2 !== 0) {
    cleaned += "_";
  }

  cleaned = cleaned.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");

  return cleaned.trim();
}

/**
 * Resolves appropriate Gemini API Key. Supports fallbacks.
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
    voice: process.env.GEMINI_VOICE_API_KEY || process.env.GEMINI_COURSE_TUTOR_API_KEY
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
 * Resolves dynamic model ID, defaulting non-excluded project models to "gemini-3.1-flash-lite".
 */
function resolveModelId(type, payload = {}) {
  let modelOverride = null;
  if (type === 'tutor') modelOverride = process.env.GEMINI_TUTOR_MODEL;
  else if (type === 'generate_assessment') modelOverride = process.env.GEMINI_ASSESSMENT_MODEL;
  else if (type === 'grading') modelOverride = process.env.GEMINI_GRADING_MODEL;
  else if (type === 'analytics') modelOverride = process.env.GEMINI_ANALYTICS_MODEL;
  else if (type === 'kofi') modelOverride = process.env.GEMINI_PLATFORM_MODEL;

  if (modelOverride) {
    const norm = modelOverride.trim().toLowerCase();
    if (
      norm === 'gemini 3.1 flash lite' ||
      norm === 'gemini-3.1-flash-lite' ||
      norm === 'gemini_3.1_flash_lite' ||
      norm === 'gemini-3.1-flash-lite-preview' ||
      norm === 'gemini 31 flash lite' ||
      norm === 'gemini-31-flash-lite' ||
      norm === 'gemini 3.1 flash lite preview' ||
      norm === 'models/gemini-3.1-flash-lite' ||
      norm === 'gemma-4-31b' ||
      norm === 'gemma-4-31b-it' ||
      norm === 'gemma-4' ||
      norm === 'gemma2-27b-it'
    ) {
      return "gemini-3.1-flash-lite";
    }
    return modelOverride;
  }

  return "gemini-3.1-flash-lite";
}

module.exports = async function handler(req, res) {
  console.log("Kofi AI Request:", {
    method: req.method,
    headers: req.headers
  });

  if (req.method === 'OPTIONS') {
    res.writeHead(200, corsHeaders);
    res.end('ok');
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  if (!isAuthorizedOrigin(req)) {
    res.writeHead(403, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden: Request origin is not authorized' }));
    return;
  }

  const clientIp = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
  if (checkRateLimit(clientIp)) {
    res.writeHead(429, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too Many Requests: Please slow down and try again in a minute.' }));
    return;
  }

  try {
    let { message, history = [] } = req.body || {};

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
      console.log(`[Conversation Manager] Intercepted. Action: ${decision.action}, Intent: ${decision.metadata.intent}, Confidence: ${decision.metadata.confidence}`);
      const polishedText = runResponseQualityGuard(decision.content);
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

    const sections = loadPlatformDocs();
    const matchedSection = findRelevantSection(message, sections);

    if (matchedSection) {
      console.log(`[Local Search] Matches section: "${matchedSection.header}"`);
      const responseText = `**${matchedSection.header}**\n\n${matchedSection.content}`;
      const polishedText = runResponseQualityGuard(responseText);

      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        content: polishedText,
        intent: classification.intent,
        category: classification.category,
        confidence: classification.confidence,
        entities: classification.entities,
        action: 'fallback_local_search'
      }));
      return;
    }

    const apiKey = resolveApiKey('kofi', req.body);
    const kofiModel = resolveModelId('kofi', req.body);

    const systemPrompt = `You are "Kofi AI", the professional guide for the SmartLMS platform.
  Your mission is to help visitors and users understand and navigate the platform's features.

  Key Platform Features you should highlight when relevant, with the following details:
  1. Proctored Assessments: Maintain absolute academic integrity with our event-driven anti-cheat monitoring system. It features real-time integrity alert streams, webcam snapshot captures with face-detection, tab-switch tracking, copy-paste blockages, and browser focus tracking. It uploads recordings and events chunk-by-chunk for extensive proctoring logs and comprehensive violation reports.
  2. Live Virtual Classes: Engage in real-time learning with seamlessly integrated virtual meeting tools, automated localized timezone-aligned attendance tracking (visualized as attendance heatmaps), and secure, on-demand meeting recording playbacks.
  3. Verified Certification: Earn secure, verifiable, and high-fidelity PDF certificates of completion featuring elegant golden borders, watermark designs, registrar digital signatures, a unique Verification ID, and an embedded QR code for real-time validation against our secure database.
  4. Advanced Analytics: Access highly detailed visual reports using Chart.js radar charts for multi-dimensional student profiling, GitHub-style 7-row student attendance heatmaps, AI-driven automated grading and feedback insights, and predictive models to identify student academic risks early.
  5. Interactive Discussions: Collaborate deeply with course-specific real-time discussion boards supporting nested reply threads, post view-count tracking (recording views of posts currently in the viewport), direct file attachment uploads, and official Staff badges to recognize teachers and admins.

  Important Constraints:
  - You are a client-side guide ONLY. You do NOT have any access to personal student data, grades, quiz/assignment submissions, or private course content.
  - If a user asks for sensitive backend information, SQL databases, server configurations, private student/course records, or personal details, you must politely refuse and remind them that you are a frontend guide designed solely for navigation and feature demonstration.
  - You cannot perform any administrative or transactional actions like enrollment, course creation, account deletion, password resets, or changing grades.
  - For technical support, account billing, or official issues beyond navigation, direct users to the "Help Center" or "Contact Us" pages.
  - Keep responses professional, friendly, and concise.
  - Use markdown for formatting (bullet points for features, bold for emphasis).
  - Strict Conversational Quality Check:
    * Grammar and Sentence Structure: Always use flawless grammar, perfect spelling, precise punctuation, elegant sentence structure, consistent verb tenses, and correct subject-verb agreements.
    * Removing Fillers and Repetitions: Never use filler words (such as "actually", "basically", "honestly", "literally", "essentially", "simply", "just", "you know"). Do not repeat words, phrases, or points.
    * Conciseness and Tone: Keep your responses highly concise, direct, and focused. Maintain a professional, helpful, and objective enterprise-grade tone.
    * Request vs Response Checking: Ensure that your response matches the user's request precisely without off-topic preamble or generic robotic intros.
    * Precision Over Explanations: Prioritize precise, high-fidelity facts and direct navigational guidance over long, verbose explanations.`;

    await callGemini(apiKey, message, systemPrompt, sanitizedHistory, kofiModel, res);

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('Kofi AI Gateway Error:', errorMsg);
    if (!res.headersSent) {
      res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: errorMsg,
        timestamp: new Date().toISOString(),
        type: 'kofi_gateway_error'
      }));
    } else {
      res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
      res.end();
    }
  }
};

/**
 * Generic Gemini API Caller with Streaming (Server-Sent Events)
 */
async function callGemini(apiKey, prompt, systemInstruction, history = [], modelName = 'gemini-3.1-flash-lite', res) {
  if (!apiKey) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'GEMINI_PLATFORM_API_KEY not configured in environment' }));
    return;
  }

  const contents = [
    ...history.map(h => ({
      role: h.role === 'assistant' || h.role === 'model' ? 'model' : 'user',
      parts: [{ text: h.content }]
    })),
    { role: 'user', parts: [{ text: prompt }] }
  ];

  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        system_instruction: { parts: [{ text: systemInstruction }] },
        generationConfig: {
          temperature: 0.7,
          topP: 0.8,
          topK: 40,
          maxOutputTokens: 2048,
        }
      })
    });
  } catch (fetchErr) {
    console.error('Failed to contact Gemini API:', fetchErr);
    res.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Bad Gateway: Unable to connect to upstream AI model. ${fetchErr.message}` }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    ...corsHeaders
  });

  let buffer = "";
  let accumulatedText = "";

  try {
    const reader = response.body;
    for await (const chunk of reader) {
      buffer += chunk.toString();

      let inString = false;
      let escaped = false;
      let braceCount = 0;
      let startIdx = -1;
      let i = 0;

      while (i < buffer.length) {
        const char = buffer[i];
        if (escaped) {
          escaped = false;
          i++;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          i++;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          i++;
          continue;
        }
        if (!inString) {
          if (char === '{') {
            if (braceCount === 0) {
              startIdx = i;
            }
            braceCount++;
          } else if (char === '}') {
            braceCount--;
            if (braceCount === 0 && startIdx !== -1) {
              const jsonStr = buffer.substring(startIdx, i + 1);
              try {
                const obj = JSON.parse(jsonStr);
                const rawText = obj.candidates?.[0]?.content?.parts?.[0]?.text;
                if (rawText) {
                  accumulatedText += rawText;
                  res.write(`data: ${JSON.stringify({ chunk: rawText })}\n\n`);
                }
              } catch (e) {}
              buffer = buffer.substring(i + 1);
              i = -1;
              startIdx = -1;
            }
          }
        }
        i++;
      }
    }

    const polishedText = runResponseQualityGuard(accumulatedText);
    res.write(`data: ${JSON.stringify({ final: polishedText })}\n\n`);
    res.end();

  } catch (streamErr) {
    console.error("Stream reader error:", streamErr);
    res.write(`data: ${JSON.stringify({ error: streamErr.message })}\n\n`);
    res.end();
  }
}

/**
 * Generic Gemini API Caller (Non-Streaming)
 */
async function callGeminiNonStream(apiKey, model, prompt, systemInstruction, history = [], res, classification = null) {
  if (!apiKey) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'GEMINI_PLATFORM_API_KEY not configured in environment' }));
    return;
  }

  const contents = [
    ...history.map(h => ({
      role: h.role === 'assistant' || h.role === 'model' ? 'model' : 'user',
      parts: [{ text: h.content }]
    })),
    { role: 'user', parts: [{ text: prompt }] }
  ];

  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        system_instruction: { parts: [{ text: systemInstruction }] },
        generationConfig: {
          temperature: 0.7,
          topP: 0.8,
          topK: 40,
          maxOutputTokens: 2048,
        }
      })
    });
  } catch (fetchErr) {
    console.error('Failed to contact Gemini API:', fetchErr);
    res.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Bad Gateway: Unable to connect to upstream AI model. ${fetchErr.message}` }));
    return;
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Gemini API Error:', errorText);
    res.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Gemini API returned ${response.status}: ${errorText}` }));
    return;
  }

  let data;
  try {
    data = await response.json();
  } catch (jsonErr) {
    console.error('Malformed JSON from Gemini API:', jsonErr);
    res.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad Gateway: Upstream AI model returned invalid JSON response.' }));
    return;
  }

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const guardedText = runResponseQualityGuard(rawText);

  const aiResponse = {
    content: guardedText,
    raw: data,
    ...(classification ? {
      intent: classification.intent,
      category: classification.category,
      confidence: classification.confidence,
      entities: classification.entities,
      action: 'fallback_gemini'
    } : {})
  };

  res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(aiResponse));
}
