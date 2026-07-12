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
 *  - entities: {Array<Object>} Extracted entities
 */
function classifyIntent(message) {
  if (!message || typeof message !== 'string') {
    return {
      intent: 'unknown',
      category: 'conversation_management',
      confidence: 0.0,
      entities: []
    };
  }

  const text = message.toLowerCase().trim();
  let intent = "unknown";
  let category = "conversation_management";
  let confidence = 0.0;
  let entities = [];

  // Conversation Management Keyword Groups
  const appreciationWords = ["thank", "thanks", "appreciate", "thankful", "grateful", "awesome", "perfect", "helpful"];
  const greetingWords = ["hi", "hello", "hey", "greetings", "morning", "afternoon", "evening", "howdy", "yo", "wassup", "sup"];
  const byeWords = ["bye", "goodbye", "farewell", "adios", "exit", "quit", "later"];
  const introWords = ["who", "name", "introduce", "kofi", "identity", "what"];
  const casualWords = ["how", "going", "doing", "life", "ok", "things"];
  const jokeWords = ["joke", "jokes", "funny", "laugh", "amuse", "comedy"];
  const confirmWords = ["yes", "correct", "indeed", "sure", "definitely", "absolutely", "exactly", "ok", "okay", "yup", "yeah", "agree"];
  const rejectWords = ["no", "incorrect", "nope", "nah", "stop", "cancel", "disagree", "refuse"];

  // Task-Oriented Keyword Groups
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

  // 1. High-fidelity exact phrase matching (Confidence 1.00)
  if (/^(hi|hello|hey|howdy|greetings|yo)$/i.test(text)) {
    intent = "greeting";
    category = "conversation_management";
    confidence = 1.00;
  } else if (/^(thanks|thank you|thank you very much|much appreciated|appreciate it)$/i.test(text)) {
    intent = "appreciation";
    category = "conversation_management";
    confidence = 1.00;
  } else if (/^(bye|goodbye|see you|farewell)$/i.test(text)) {
    intent = "farewell";
    category = "conversation_management";
    confidence = 1.00;
  } else if (/^(who are you|what is your name|who is kofi|what do you do)$/i.test(text)) {
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

  // 2. Keyword density classification if no exact match found
  if (confidence === 0.0) {
    const wordList = text.replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);

    if (wordList.length === 0) {
      return {
        intent: 'unknown',
        category: 'conversation_management',
        confidence: 0.10,
        entities: []
      };
    }

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

      // Assign granular, realistic confidence scores
      if (maxCount >= 3) {
        confidence = 0.95;
      } else if (maxCount === 2) {
        confidence = 0.85;
      } else {
        // Single keyword match
        confidence = matchRatio >= 0.5 ? 0.75 : 0.60;
      }

      const convManagementIntents = [
        "greeting", "confirmation", "rejection", "fun_request", "farewell", "self_introduction", "appreciation", "casual_conversation"
      ];

      if (convManagementIntents.includes(intent)) {
        category = "conversation_management";
      } else {
        category = "task_oriented";
      }
    } else {
      // No recognized keywords matched
      if (wordList.length <= 2) {
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

  // 3. Entity Extraction
  // PlatformFeature
  const featureEntities = [
    { value: "proctor", syns: ["proctor", "anti-cheat", "anti cheat", "webcam"] },
    { value: "classes", syns: ["class", "classes", "meeting", "zoom", "lecture"] },
    { value: "certificates", syns: ["certificate", "certificates", "completion", "diploma", "qr code"] },
    { value: "analytics", syns: ["analytics", "chart", "radar chart", "metrics"] },
    { value: "discussions", syns: ["discussion", "forum", "reply", "thread"] }
  ];

  featureEntities.forEach(item => {
    if (item.syns.some(syn => text.includes(syn))) {
      entities.push({ value: item.value, type: "PlatformFeature" });
    }
  });

  // LMSAction
  const actionEntities = ["enroll", "register", "grade", "create", "delete", "reset", "join", "submit", "check", "view"];
  actionEntities.forEach(ent => {
    if (text.includes(ent)) {
      entities.push({ value: ent, type: "LMSAction" });
    }
  });

  // Role
  const roleEntities = ["student", "teacher", "admin", "instructor", "visitor", "user"];
  roleEntities.forEach(ent => {
    if (text.includes(ent)) {
      entities.push({ value: ent, type: "Role" });
    }
  });

  // CourseConcept
  const conceptEntities = ["lesson", "homework", "quiz", "assignment", "exam", "gradebook", "feedback", "materials", "syllabus"];
  conceptEntities.forEach(ent => {
    if (text.includes(ent)) {
      entities.push({ value: ent, type: "CourseConcept" });
    }
  });

  return {
    intent,
    category,
    confidence: Number(confidence.toFixed(2)),
    entities
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

module.exports = {
  classifyIntent,
  routeConversation,
  predefinedResponses,
  intentLabels
};
