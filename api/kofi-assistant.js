// Vercel Serverless Function: api/kofi-assistant.js
// Handles platform guide (Kofi AI) requests publicly without auth, session or Supabase check.
// Enhanced with enterprise-grade rate limiting, same-origin domain lock, input sanitization, and robust error handling.

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
      // In production, browsers send Referer/Origin for POST. If completely missing,
      // block to prevent direct terminal curls/hotlinking, but allow if host matches localhost.
      if (host && (host.startsWith('localhost') || host.startsWith('127.0.0.1'))) {
        return true;
      }
      return false;
    }

    const urlObj = new URL(refOrOrig);
    const refHost = urlObj.host; // e.g. "smartlms.vercel.app"

    // If referrer host matches API server host, it's same-origin
    if (host && refHost === host) {
      return true;
    }

    // Check against standard Vercel environment variables
    const vercelUrl = process.env.VERCEL_PROJECT_URL || process.env.VERCEL_URL;
    if (vercelUrl) {
      const vercelHost = vercelUrl.replace(/^https?:\/\//, '');
      if (urlObj.hostname === vercelHost || urlObj.hostname.endsWith('.' + vercelHost)) {
        return true;
      }
    }

    // Allow typical localhost development
    if (urlObj.hostname === 'localhost' || urlObj.hostname === '127.0.0.1') {
      return true;
    }

    return false;
  } catch (err) {
    return false;
  }
}

module.exports = async function handler(req, res) {
  console.log("Kofi AI Request:", {
    method: req.method,
    headers: req.headers,
    body: req.body
  });

  // Handle CORS preflight
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

  // 1. Same-Origin & Referer Domain Lock Protection
  if (!isAuthorizedOrigin(req)) {
    res.writeHead(403, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden: Request origin is not authorized' }));
    return;
  }

  // 2. Client-IP based sliding window rate limiting
  const clientIp = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
  if (checkRateLimit(clientIp)) {
    res.writeHead(429, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too Many Requests: Please slow down and try again in a minute.' }));
    return;
  }

  try {
    let { message, history = [] } = req.body || {};

    // 3. Strict Input Verification and Sanitization
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

    // Keep history tight and validate schemas
    const sanitizedHistory = history
      .slice(-10) // Limit conversational memory to prevent API injection or token overhead
      .filter(h => {
        return h &&
               typeof h === 'object' &&
               typeof h.content === 'string' &&
               h.content.trim().length > 0 &&
               (h.role === 'user' || h.role === 'assistant' || h.role === 'model');
      })
      .map(h => ({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: h.content.trim().substring(0, 2000)
      }));

    const apiKey = process.env.GEMINI_PLATFORM_API_KEY;

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
  - Use markdown for formatting (bullet points for features, bold for emphasis).`;

    await callGemini(apiKey, message, systemPrompt, sanitizedHistory, res);

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('Kofi AI Gateway Error:', errorMsg);
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: errorMsg,
      timestamp: new Date().toISOString(),
      type: 'kofi_gateway_error'
    }));
  }
};

/**
 * Generic Gemini API Caller
 */
async function callGemini(apiKey, prompt, systemInstruction, history = [], res) {
  if (!apiKey) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Gemini API Key not configured in environment' }));
    return;
  }

  const contents = [
    ...history.map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }]
    })),
    { role: 'user', parts: [{ text: prompt }] }
  ];

  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`, {
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

  const aiResponse = {
    content: data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from AI.',
    raw: data
  };

  res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(aiResponse));
}
