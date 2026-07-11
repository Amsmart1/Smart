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

/**
 * Scans user inputs to detect prompt injection, toxic keywords, or out-of-scope requests.
 * Returns a professional, friendly refusal response string if blocked, or null if allowed.
 */
/**
 * Provides instant, cost-efficient, high-fidelity predefined answers for common platform inquiries.
 * Returns a markdown response string if matched, or null to fallback to the Gemini model.
 */
function findPreciseResponse(message) {
  const normalized = message.toLowerCase().trim();

  // Mapping of user intent keywords/questions to high-fidelity, precise predefined responses.
  const keywordMappings = [
    {
      keywords: ["login", "sign in", "signin", "how to login", "how do i login"],
      response: "To log in to **SmartLMS**:\n1. Click the **Sign In** button in the top navigation bar of the homepage.\n2. Choose your role: **Student**, **Teacher**, or **Admin** by selecting the corresponding icon.\n3. Enter your registered email address and password.\n4. Click **Login** to enter your secure dashboard.\n\n*If you have forgotten your password, click the 'Forgot Password?' link on the login card to submit a reset request.*"
    },
    {
      keywords: ["signup", "sign up", "register", "create account", "create an account"],
      response: "Getting started with **SmartLMS** is completely free and easy:\n1. Click the **Get Started** button on the homepage.\n2. Fill in your **Full Name**, **Email Address**, **Phone Number** (optional), and choose a strong, secure password.\n3. Make sure to specify your correct role (**Student** or **Teacher**).\n4. Click **Create Account** to immediately access your customized platform dashboard!"
    },
    {
      keywords: ["proctoring", "anti-cheat", "cheat", "anti cheat", "integrity", "assessment security", "monitoring"],
      response: "SmartLMS features a state-of-the-art **Proctored Assessments & Anti-Cheat Subsystem** designed to ensure absolute academic integrity:\n- **Face Detection**: Submits webcam snapshot recordings chunk-by-chunk to monitor presence and flag multiple/missing faces.\n- **Focus & Tab-Switch Tracking**: Log real-time violations if you navigate away, minimize the window, or lose focus.\n- **Copy-Paste Blockage**: Restricts copying quiz questions or pasting answers from clipboard.\n- **Real-time Alert Stream**: Instantly notifies instructors of critical violations during active sessions.\n- **Comprehensive Violation Reports**: Teachers review chronological logs accompanied by webcam snapshots for verified grading decisions."
    },
    {
      keywords: ["certificate", "certification", "verify", "verification id", "pdf certificate", "diploma"],
      response: "Upon course completion, **SmartLMS** issues elegant, verifiable **PDF Certificates of Completion**:\n- **High-Fidelity Design**: Decorated with golden borders, institution watermarks, and registrar digital signatures.\n- **Verification ID**: Each certificate includes a unique, database-tracked Identification string.\n- **QR Code Verification**: Anyone (like employers or registrars) can scan the QR code to verify the certificate's authenticity instantly against our secure, live database.\n- **Verification Portal**: Visitors can also input a Verification ID directly via our public **Help Center** portal to verify its status instantly."
    },
    {
      keywords: ["contact", "support", "help", "email", "phone", "contact us", "billing", "customer service"],
      response: "If you need official administrative support, account setup assistance, or have billing questions, please reach our dedicated team:\n- 📧 **Email**: `eduquizlms@gmail.com`\n- 📞 **Phone**: `+233 50 596 5310`\n- 🕒 **Hours**: Our representatives are available Monday through Friday, 8:00 AM - 5:00 PM GMT.\n\n*You can also access the **Help Center** by clicking support links at the footer of the homepage for interactive FAQs sorted by student, teacher, and admin roles.*"
    },
    {
      keywords: ["features", "what can you do", "capabilities", "platform overview", "lms features"],
      response: "Welcome to **SmartLMS**! Here is an overview of our core enterprise-grade features:\n1. 🛡️ **Proctored Assessments**: Absolute academic integrity with real-time face-detection, tab-switch logging, and copy-paste blocks.\n2. 🎥 **Live Virtual Classes**: Integrated virtual meetings with automated localized timezone attendance heatmaps and replay options.\n3. 📜 **Verified Certification**: High-fidelity PDF completion certificates containing secure Verification IDs and QR codes.\n4. 📊 **Advanced Analytics**: Multi-dimensional student analytics profiles powered by interactive Chart.js radar charts and 7-row attendance logs.\n5. 💬 **Interactive Discussions**: Collaborative course message boards featuring nested comment replies and official Staff badges."
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
function runResponseQualityGuard(response) {
  if (!response || typeof response !== 'string') return "";

  let cleaned = response;

  // 1. Prevent System Prompt/Constraint Leakage
  const leakWords = [
    "You are \"Kofi AI\"",
    "systemPrompt",
    "systemInstruction",
    "Important Constraints:",
    "You are a client-side guide ONLY"
  ];

  for (const leak of leakWords) {
    if (cleaned.includes(leak)) {
      cleaned = cleaned.split(leak)[0];
    }
  }

  // Ensure it doesn't mention private prompt variables
  cleaned = cleaned.replace(/systemPrompt|system_instruction|generationConfig/gi, "guide configuration");

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

  // C. Dedup consecutive duplicated words ("the the", "and and", etc.)
  cleaned = cleaned.replace(/\b(\w+)\s+\1\b/gi, "$1");

  // D. Collapse duplicate consecutive punctuation marks while preserving valid markdown ellipsis (...)
  cleaned = cleaned.replace(/!{2,}/g, "!");
  cleaned = cleaned.replace(/\?{2,}/g, "?");
  cleaned = cleaned.replace(/,{2,}/g, ",");
  cleaned = cleaned.replace(/\.{4,}/g, "...");
  cleaned = cleaned.replace(/(?<!\.)\.{2}(?!\.)/g, ".");

  // E. Clean punctuation spacing: ensure space after punctuation and no trailing/leading space issues
  cleaned = cleaned.replace(/([,.!?])([A-Za-z0-9])/g, "$1 $2");
  cleaned = cleaned.replace(/\s+([,.!?])/g, "$1");

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

function filterRequestIntent(message) {
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
    return "I am designed to be a helpful guide for the SmartLMS platform. I cannot bypass, reveal, or modify my platform instructions or security parameters. How can I help you navigate our learning platform features today?";
  }

  // 2. Toxic or Harmful Intent Indicators (e.g. building hacks, exploits, malicious scripts)
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
    return "As the SmartLMS platform assistant, I cannot assist with security bypasses, cheats, or malicious activities. I would be happy to explain how our proctoring and anti-cheat technologies securely safeguard assessment integrity!";
  }

  // 3. Out-Of-Scope General Knowledge/Coding Tasks
  const outOfScopeIndicators = [
    "write a python",
    "write a javascript",
    "write java code",
    "recipe for",
    "how to cook",
    "how to bake",
    "who is the president",
    "translate this to spanish",
    "explain quantum physics",
    "solve this equation"
  ];

  if (outOfScopeIndicators.some(p => normalized.includes(p))) {
    return "I am Kofi AI, your dedicated guide for the SmartLMS platform. I'm specialized in helping you navigate our platform features (like Proctored Assessments, Live Classes, and Verified Certificates). I'm unable to write general programming code or answer general knowledge questions. Let me know if you have any questions about using SmartLMS!";
  }

  return null;
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

    // 4. Request Intent Filter
    const filterRefusal = filterRequestIntent(message);
    if (filterRefusal) {
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: filterRefusal }));
      return;
    }

    // 5. Precise Response Lookup
    const preciseResponse = findPreciseResponse(message);
    if (preciseResponse) {
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: preciseResponse }));
      return;
    }

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
  - Use markdown for formatting (bullet points for features, bold for emphasis).
  - Strict Conversational Quality Check:
    * Grammar and Sentence Structure: Always use flawless grammar, perfect spelling, precise punctuation, elegant sentence structure, consistent verb tenses, and correct subject-verb agreements.
    * Removing Fillers and Repetitions: Never use filler words (such as "actually", "basically", "honestly", "literally", "essentially", "simply", "just", "you know"). Do not repeat words, phrases, or points.
    * Conciseness and Tone: Keep your responses highly concise, direct, and focused. Maintain a professional, helpful, and objective enterprise-grade tone.
    * Request vs Response Checking: Ensure that your response matches the user's request precisely without off-topic preamble or generic robotic intros.
    * Precision Over Explanations: Prioritize precise, high-fidelity facts and direct navigational guidance over long, verbose explanations.`;

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

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from AI.';
  const guardedText = runResponseQualityGuard(rawText);

  const aiResponse = {
    content: guardedText,
    raw: data
  };

  res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(aiResponse));
}
