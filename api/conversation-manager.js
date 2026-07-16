/**
 * SmartLMS Enterprise Conversation & Conversion Manager
 *
 * Implements intent classification, entity extraction, confidence scoring,
 * and confidence-based execution routing using Enterprise Confidence Thresholds.
 *
 * Designed for local, zero-Gemini-call, zero-documentation-search conversational
 * handling to minimize latency, API costs, and resource footprint.
 */

// Simple Conversational Interactions / Conversation Management Responses
const predefinedResponses = {
  greeting: "Hello! Welcome to SmartLMS. I'm Kofi AI, your platform guide. How can I assist you with navigating our features today?",
  confirmation: "Understood! Let me know how I can help you next, or what feature you would like to explore.",
  rejection: "No problem. Let me know if there's anything else you'd like to ask or explore instead.",
  fun_request: "Why did the HTML tag go to the therapist? Because it had too many unclosed elements! Let me know if you want to explore actual platform features like Proctored Assessments or Live Virtual Classes!",
  farewell: "Goodbye! Thank you for visiting SmartLMS. Feel free to reach out if you need assistance in the future. Have a great day!",
  self_introduction: "I am Kofi AI, the professional guide for the SmartLMS platform. My mission is to help visitors and users understand and navigate our platform features, such as Proctored Assessments, Live Virtual Classes, and Verified Certifications.",
  appreciation: "You're very welcome! Helping you navigate SmartLMS is my top priority. Let me know if you need anything else!",
  casual_conversation: "I am doing exceptionally well, thank you for asking! I am ready to guide you through the features of SmartLMS. What would you like to learn about today?",
  unknown: "I'm not entirely sure I understood that, but I'm here to help you navigate SmartLMS. Feel free to ask about our Proctored Assessments, Live Classes, or Verified Certifications!"
};

// Plain English labels for user-friendly execution and confirmation prompts
const intentLabels = {
  greeting: "saying hello or greeting me",
  confirmation: "confirming something",
  rejection: "declining or rejecting something",
  fun_request: "hearing a joke or having some fun",
  farewell: "saying goodbye or farewell",
  self_introduction: "who I am or my introduction",
  appreciation: "expressing appreciation or gratitude",
  casual_conversation: "having a casual conversation",
  unknown: "asking a general question"
};

/**
 * Counts matches in word list against target keywords
 */
function countMatches(wordList, keywords) {
  let count = 0;
  for (const word of wordList) {
    if (keywords.includes(word)) {
      count++;
    }
  }
  return count;
}

/**
 * Classifies the intent of a given message, extracts relevant entities, and computes a confidence score.
 *
 * @param {string} message - The raw text input from the user
 * @returns {Object} Classified results containing:
 *  - intent: {string} Name of classified intent
 *  - category: {string} 'conversation_management' | 'task_oriented'
 *  - confidence: {number} Score between 0.00 and 1.00
 *  - entities: {Object} Extracted entities structured as informational dimensions (who, what, why, where, when, how, which)
 *  - entities_list: {Array<Object>} Legacy compatibility list of extracted entities
 */
function classifyIntent(message) {
  if (!message || typeof message !== 'string') {
    return {
      intent: 'unknown',
      category: 'conversation_management',
      confidence: 0.0,
      entities: {},
      entities_list: []
    };
  }

  const text = message.toLowerCase().trim();
  let intent = "unknown";
  let category = "conversation_management";
  let confidence = 0.0;
  let entities = {};
  let entities_list = [];

  // 1. Operational / Task-oriented detection
  const taskKeywords = [
    "dashboard", "update", "account", "profile", "grade", "score", "course", "lesson", "quiz",
    "test", "exam", "assignment", "materials", "enroll", "register", "setting", "settings",
    "change", "upload", "submit", "how to", "how do", "how can", "where is", "where are",
    "navigate", "help", "contact", "support", "ticket", "service", "class", "classes",
    "meeting", "video", "certification", "qr", "analytics", "discussion", "forum"
  ];

  const hasTaskKeyword = taskKeywords.some(keyword => {
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    return regex.test(text);
  });

  // 1.1 High-fidelity Task Intent Matching (e.g. upload_material)
  if (/(?:upload|add|post|create|insert|publish|submit)\b/i.test(text) && /(?:notes|material|materials|slides|syllabus|document|file)\b/i.test(text)) {
    intent = "upload_material";
    category = "task_oriented";
    confidence = 0.95;
  }

  // 2. High-precision exact phrase matching for conversational intents (Confidence 1.00)
  if (intent === "unknown") {
    if (/^(hi|hello|hey|howdy|greetings|yo)$/i.test(text)) {
      intent = "greeting";
      category = "conversation_management";
      confidence = 1.00;
    } else if (/^(thanks|thank you|thank you very much|much appreciated|appreciate it|grateful)$/i.test(text)) {
      intent = "appreciation";
      category = "conversation_management";
      confidence = 1.00;
    } else if (/^(bye|goodbye|see you|farewell)$/i.test(text)) {
      intent = "farewell";
      category = "conversation_management";
      confidence = 1.00;
    } else if (/^(who are you|what is your name|who is kofi|what do you do|introduce yourself|introduce kofi|tell me about yourself)$/i.test(text)) {
      intent = "self_introduction";
      category = "conversation_management";
      confidence = 1.00;
    } else if (/^(how are you|how is it going|how are you doing|what's up|whats up)$/i.test(text)) {
      intent = "casual_conversation";
      category = "conversation_management";
      confidence = 1.00;
    } else if (/^(tell me a joke|tell a joke|say something funny|make me laugh)$/i.test(text)) {
      intent = "fun_request";
      category = "conversation_management";
      confidence = 1.00;
    } else if (/^(yes|correct|sure|ok|okay|yup|yeah)$/i.test(text)) {
      intent = "confirmation";
      category = "conversation_management";
      confidence = 1.00;
    } else if (/^(no|nope|nah|incorrect)$/i.test(text)) {
      intent = "rejection";
      category = "conversation_management";
      confidence = 1.00;
    }
  }

  // 3. Keyword density classification if no exact match or task match found
  if (intent === "unknown" && confidence === 0.0) {
    const wordList = text.replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);

    if (wordList.length === 0) {
      return {
        intent: 'unknown',
        category: 'conversation_management',
        confidence: 0.10,
        entities: {},
        entities_list: []
      };
    }

    // Conversational word groups
    const greetingWords = ["hi", "hello", "hey", "greetings", "morning", "afternoon", "evening", "howdy", "yo", "wassup", "sup"];
    const appreciationWords = ["thank", "thanks", "appreciate", "thankful", "grateful"];
    const byeWords = ["bye", "goodbye", "farewell", "adios", "exit", "quit", "later"];
    const introWords = ["introduce", "kofi", "identity"];
    const casualWords = ["going", "doing", "life", "ok", "things"];
    const jokeWords = ["joke", "jokes", "funny", "laugh", "amuse", "comedy"];
    const confirmWords = ["yes", "correct", "indeed", "sure", "definitely", "absolutely", "exactly", "ok", "okay", "yup", "yeah", "agree"];
    const rejectWords = ["no", "incorrect", "nope", "nah", "stop", "cancel", "disagree", "refuse"];

    // Task-oriented word groups
    const proctorWords = ["proctor", "proctored", "anti-cheat", "webcam", "eye", "snapshot", "tab", "switch", "lockdown", "violation", "integrity", "cheating"];
    const classWords = ["live", "class", "virtual", "meeting", "zoom", "teams", "video", "lecture", "heatmap", "attendance"];
    const certWords = ["certificate", "completion", "diploma", "verified", "certification", "qr", "gold"];
    const analyticsWords = ["analytics", "chart", "radar", "profiling", "metrics", "data", "analysis", "insights", "progress", "risk"];
    const discussionWords = ["discussion", "board", "reply", "forum", "thread", "badge", "nested"];
    const helpWords = ["help", "contact", "support", "ticket", "service"];
    const tutorWords = ["lesson", "explain", "concept", "homework", "study", "tips", "curriculum", "syllabus"];
    const gradingWords = ["grade", "score", "evaluation", "rubric", "feedback", "gradebook"];
    const enrollWords = ["enroll", "register", "join", "add", "admission"];
    const courseMgmtWords = ["create", "delete", "reset", "admin", "database", "sql", "config"];

    const matches = {
      greeting: countMatches(wordList, greetingWords),
      confirmation: countMatches(wordList, confirmWords),
      rejection: countMatches(wordList, rejectWords),
      fun_request: countMatches(wordList, jokeWords),
      farewell: countMatches(wordList, byeWords),
      self_introduction: countMatches(wordList, introWords),
      appreciation: countMatches(wordList, appreciationWords),
      casual_conversation: countMatches(wordList, casualWords),

      // Task-oriented
      navigate_proctor: countMatches(wordList, proctorWords),
      navigate_classes: countMatches(wordList, classWords),
      navigate_certificates: countMatches(wordList, certWords),
      navigate_analytics: countMatches(wordList, analyticsWords),
      navigate_discussions: countMatches(wordList, discussionWords),
      navigate_help: countMatches(wordList, helpWords),
      academic_tutor: countMatches(wordList, tutorWords),
      academic_grading: countMatches(wordList, gradingWords),
      admin_enrollment: countMatches(wordList, enrollWords),
      admin_course_management: countMatches(wordList, courseMgmtWords)
    };

    let maxIntent = "unknown";
    let maxCount = 0;

    for (const [key, count] of Object.entries(matches)) {
      if (count > maxCount) {
        maxCount = count;
        maxIntent = key;
      }
    }

    if (maxCount > 0) {
      intent = maxIntent;
      const matchRatio = maxCount / wordList.length;

      if (maxCount >= 3) {
        confidence = 0.95;
      } else if (maxCount === 2) {
        confidence = 0.85;
      } else {
        confidence = matchRatio >= 0.40 ? 0.75 : 0.40;
      }

      const convManagementIntents = [
        "greeting", "confirmation", "rejection", "fun_request", "farewell", "self_introduction", "appreciation", "casual_conversation"
      ];

      if (convManagementIntents.includes(intent) && !hasTaskKeyword) {
        category = "conversation_management";
      } else {
        category = "task_oriented";
      }
    } else {
      if (wordList.length <= 2 && !hasTaskKeyword) {
        intent = "unknown";
        category = "conversation_management";
        confidence = 0.40;
      } else {
        intent = "unknown";
        category = "task_oriented";
        confidence = 0.15;
      }
    }
  }

  // Overrule category and confidence if task keyword is found (Safeguard)
  if (hasTaskKeyword && category === "conversation_management") {
    category = "task_oriented";
    if (confidence >= 0.50) {
      confidence = 0.45;
    }
  }

  // 4. Generalized Entity Extraction answering:
  // "What, why, where, when, how, who, which, etc specific questions, objects, features, or values involved?"

  // --- WHO ---
  const personMatch = message.match(/(?:i am|i'm|my name is)\s+((?:mr\.|ms\.|mrs\.|dr\.|prof\.|mr|ms|mrs|dr|prof)?\s*[a-za-z0-9_-]+(?:\s+[a-za-z0-9_-]+)?)/i);
  let whoVal = "";
  if (personMatch && personMatch[1]) {
    whoVal = personMatch[1].trim().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
  }
  const roleMatch = message.match(/\b(teacher|student|admin|instructor|lecturer|professor|educator)\b/i);
  if (roleMatch) {
    whoVal = whoVal ? `${whoVal}, ${roleMatch[1]}` : roleMatch[1];
  }
  if (whoVal) entities.who = whoVal;

  // --- WHAT ---
  const objectMatch = message.match(/\b(notes|syllabus|quiz|exam|test|slides|homework|assignment|book|paper|material|materials|document|file|account|profile|name|joke|greetings)\b/i);
  if (objectMatch) {
    entities.what = objectMatch[1];
  }

  // --- WHY ---
  const whyMatch = message.match(/\b(guidance|help|understand|study|prepare|excel|grade|check|view|learn)\b/i);
  if (whyMatch) {
    entities.why = whyMatch[1];
  }

  // --- WHERE ---
  const whereMatch = message.match(/\b(dashboard|forum|discussion board|classroom|database|meeting|help center|support)\b/i);
  if (whereMatch) {
    entities.where = whereMatch[1];
  }

  // --- WHEN ---
  const whenMatch = message.match(/\b(now|today|live|scheduled|before|after|tomorrow|later)\b/i);
  if (whenMatch) {
    entities.when = whenMatch[1];
  }

  // --- HOW ---
  const howMatch = message.match(/\b(upload|register|enroll|change|update|reset|webcam|video|qr code|link)\b/i);
  if (howMatch) {
    entities.how = howMatch[1];
  }

  // --- WHICH ---
  const whichMatch = message.match(/\b(biology|physics|chemistry|mathematics|math|english|history|science|computer\s+science|shs|jhs|beginner|advanced)\b/i);
  if (whichMatch) {
    entities.which = whichMatch[1];
  }

  // F. Create legacy list of entities for compatibility
  for (const [key, val] of Object.entries(entities)) {
    entities_list.push({
      value: val,
      type: key.charAt(0).toUpperCase() + key.slice(1) // Who, What, Why, Where, When, How, Which
    });
  }

  return {
    intent,
    category,
    confidence: Number(confidence.toFixed(2)),
    entities,
    entities_list
  };
}

/**
 * Executes action routing based on classified confidence and predefined thresholds.
 *
 * Thresholds:
 *  - 0.90 to 1.00: Execute automatically
 *  - 0.75 to 0.89: Execute with confirmation
 *  - 0.50 to 0.74: Ask clarification
 *  - < 0.50: Send to AI Fallback
 *
 * @param {string} message - Raw user message
 * @returns {Object} Router decision containing:
 *  - action: {string} 'execute' | 'execute_confirmation' | 'ask_clarification' | 'fallback'
 *  - content: {string|null} Predefined response content or clarification request
 *  - metadata: {Object} Intent classification payload
 */
function routeConversation(message) {
  const classification = classifyIntent(message);
  const { intent, category, confidence } = classification;

  // We only intercept conversation management intents at the local level.
  // Task-oriented requests (navigation, academic, admin) are routed to fallback (Gemini/docs search)
  if (category !== 'conversation_management') {
    return {
      action: 'fallback',
      content: null,
      metadata: classification
    };
  }

  const responseTemplate = predefinedResponses[intent] || predefinedResponses.unknown;
  const label = intentLabels[intent] || "asking a general question";

  if (confidence >= 0.90) {
    // Execute automatically
    return {
      action: 'execute',
      content: responseTemplate,
      metadata: classification
    };
  } else if (confidence >= 0.75) {
    // Execute with confirmation
    const confirmationResponse = `I believe you are ${label}. Let me confirm if this is correct. If so, here is the information: ${responseTemplate}`;
    return {
      action: 'execute_confirmation',
      content: confirmationResponse,
      metadata: classification
    };
  } else if (confidence >= 0.50) {
    // Ask clarification
    const clarificationResponse = `It seems like you might be ${label}, but I want to make sure I understand you correctly. Could you please specify or clarify what you need?`;
    return {
      action: 'ask_clarification',
      content: clarificationResponse,
      metadata: classification
    };
  } else {
    // AI Fallback
    return {
      action: 'fallback',
      content: null,
      metadata: classification
    };
  }
}

/**
 * Centralized request intent safety and scope filtering helper.
 */
function filterRequestIntent(message, context = 'kofi') {
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
    if (context === 'tutor') {
      return "I am designed to be a helpful academic course tutor. I cannot bypass, reveal, or modify my system instructions, prompt configuration, or safety parameters. How can I assist you with your learning today?";
    } else {
      return "I am designed to be a helpful guide for the SmartLMS platform. I cannot bypass, reveal, or modify my system instructions, prompt configuration, or safety parameters. How can I assist you with navigating our features today?";
    }
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
    if (context === 'tutor') {
      return "As your academic tutor, I cannot assist with security bypasses, cheats, or malicious activities. I would be happy to explain computer science or security concepts from an educational perspective instead!";
    } else {
      return "As the SmartLMS guide, I cannot assist with security bypasses, cheats, or malicious activities. I would be happy to explain our platform security or proctoring features from an educational perspective instead!";
    }
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
    if (context === 'tutor') {
      return "I am your dedicated academic course tutor. I specialize in helping you understand the lessons, materials, and concepts of this course. I am unable to answer general lifestyle, entertainment, or unrelated queries. Let me know if you have any questions about our course topics!";
    } else {
      return "I am your dedicated platform guide. I specialize in helping you understand the features, tools, and capabilities of SmartLMS. I am unable to answer general lifestyle, entertainment, or unrelated queries. Let me know if you have any questions about navigating our platform!";
    }
  }

  return null;
}

/**
 * Centralized post-processing quality guard to ensure safety, formatting correctness, and grammar.
 */
function runResponseQualityGuard(response, context = 'kofi') {
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

  if (context === 'tutor') {
    cleaned = cleaned.replace(/systemPrompt|system_instruction|generationConfig/gi, "tutor configuration");
  } else {
    cleaned = cleaned.replace(/systemPrompt|system_instruction|generationConfig/gi, "configuration");
  }

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

  const doubleWords = ["the", "and", "of", "to", "is", "in", "that", "a", "an", "with", "for", "on", "at", "by", "this", "it"];
  for (const word of doubleWords) {
    const doubleRegex = new RegExp(`\\b${word}\\s+${word}\\b`, 'gi');
    cleaned = cleaned.replace(doubleRegex, word);
  }

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

  cleaned = cleaned.replace(/!{2,}/g, "!");
  cleaned = cleaned.replace(/\?{2,}/g, "?");
  cleaned = cleaned.replace(/,{2,}/g, ",");
  cleaned = cleaned.replace(/\.{4,}/g, "...");
  cleaned = cleaned.replace(/(?<!\.)\.{2}(?!\.)/g, ".");

  cleaned = cleaned.replace(/([,.!?])([A-Za-z0-9])/g, "$1 $2");
  cleaned = cleaned.replace(/\s+([,.!?])/g, "$1");

  cleaned = cleaned.replace(/___ELLIPSIS_PLACEHOLDER___/g, "...");

  for (let i = 0; i < decimalPlaceholders.length; i++) {
    cleaned = cleaned.replace(`___DECIMAL_PLACEHOLDER_${i}___`, decimalPlaceholders[i]);
  }

  for (let i = 0; i < urlPlaceholders.length; i++) {
    cleaned = cleaned.replace(`___URL_PLACEHOLDER_${i}___`, urlPlaceholders[i]);
  }

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
 * Centralized API key resolution helper.
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
 * Centralized model ID resolution helper.
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
    let embeddingModel = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
    const norm = embeddingModel.trim().toLowerCase();
    if (
      norm === 'gemini-embedding' ||
      norm === 'gemini_embedding' ||
      norm === 'gemini embedding' ||
      norm === 'gemini-embedding-001' ||
      norm === 'gemini-embedding-004' ||
      norm === 'text-embedding-004' ||
      norm === 'gemini embedding 001' ||
      norm === 'gemini_embedding_001' ||
      norm === 'gemini embedding 004' ||
      norm === 'gemini_embedding_004' ||
      norm === 'models/gemini-embedding-001' ||
      norm === 'models/text-embedding-004'
    ) {
      return "gemini-embedding-001";
    }
    return embeddingModel;
  }

  // The 5 core project models (Course Tutor, Assessment Generator, Grading Assistant, Analytics AI, and Kofi Assistant)
  // are all strictly hardcoded to use the centralized official, valid, and supported Gemini 3.1 Flash Lite model ID.
  return "gemini-3.1-flash-lite";
}

module.exports = {
  classifyIntent,
  routeConversation,
  predefinedResponses,
  intentLabels,
  filterRequestIntent,
  runResponseQualityGuard,
  resolveApiKey,
  resolveModelId
};
