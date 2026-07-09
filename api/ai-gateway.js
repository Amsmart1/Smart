// Vercel Serverless Function: api/ai-gateway.js
// Handles downstream Gemini API content generation & embeddings.
// Keeps secret keys secured inside the Vercel environment.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-session-id, x-supabase-signature',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
};

module.exports = async function handler(req, res) {
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

    if (!signature || signature !== expectedSignature) {
      res.writeHead(401, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing gateway signature' }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    const { type, payload } = req.body || {};

    if (!type || !payload) {
      res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing request type or payload' }));
      return;
    }

    switch (type) {
      case 'platform_assistant':
        return await handlePlatformAssistant(payload, res);

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

      default:
        res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unsupported AI operation: ${type}` }));
        return;
    }

  } catch (error) {
    console.error('Vercel AI Gateway Error:', error.message);
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: error.message,
      timestamp: new Date().toISOString(),
      type: 'vercel_gateway_error'
    }));
  }
};

/**
 * Feature 1 & 6: Course-aware Tutor
 */
async function handleCourseTutor(payload, res) {
  const { message, history = [], context = '' } = payload;
  const apiKey = process.env.GEMINI_COURSE_TUTOR_API_KEY;

  const systemPrompt = `You are a professional academic tutor for this course.
  Your goal is to provide high-quality, conversational tutoring.
  Use the provided course context to answer student questions.

  Key Tutoring Principles:
  1. Conversational Style: Be encouraging, clear, and professional.
  2. Explanations over answers: Don't just provide direct answers; explain the underlying concepts.
  3. Scaffolding: Provide hints and guide the student towards finding the answer themselves.
  4. Follow-up: Always ask a relevant follow-up question to deepen the student's understanding.

  If the information is not in the context, guide the student based on general academic principles related to the topic, but prioritize course-specific info.

  Course Context:
  ${context.substring(0, 15000)}`;

  return callGemini(apiKey, message, systemPrompt, history, res);
}

/**
 * Feature 2: Assessment Generator
 */
async function handleAssessmentGenerator(payload, res) {
  const { topic, type, count, difficulty, rubrics, email, role } = payload;
  const apiKey = process.env.GEMINI_ASSESSMENT_API_KEY;

  const prompt = `Generate a ${type} with ${count} questions about "${topic}".
  Difficulty level: ${difficulty}.
  ${rubrics ? `Follow these rubrics: ${rubrics}` : ''}
  Output MUST be a valid JSON array of question objects matching the SmartLMS schema.
  Wrap your JSON response in \`\`\`json [CODE] \`\`\` markers.`;

  const systemPrompt = `You are an expert curriculum designer and assessment generator.
  Generating for Teacher: ${email}
  Role: ${role}
  You output only valid JSON.`;
  return callGemini(apiKey, prompt, systemPrompt, [], res);
}

/**
 * Feature 3: Grading Assistant
 */
async function handleGradingAssistant(payload, res) {
  const { assignment_title, student_submission, rubric, questions, email, role } = payload;
  const apiKey = process.env.GEMINI_GRADING_API_KEY;

  const prompt = `Assignment: ${assignment_title}
  Rubric: ${rubric}
  Questions: ${JSON.stringify(questions)}
  Student Work: ${student_submission}

  Provide a detailed critique, suggested scores per question, and overall feedback for the student.`;

  const systemPrompt = `You are a fair and insightful teaching assistant.
  Assisting Teacher: ${email}
  Role: ${role}
  Help the teacher grade by providing insights based on the rubric.`;
  return callGemini(apiKey, prompt, systemPrompt, [], res);
}

/**
 * Feature 4: Role-based Analytics
 */
async function handleAnalyticsAI(payload, res) {
  const { analytics_data, question, email, role } = payload;
  const apiKey = process.env.GEMINI_ANALYTICS_API_KEY;

  const prompt = `My Role: ${role}
  My Identity: ${email}
  Analytics Data: ${JSON.stringify(analytics_data)}
  Question: ${question}

  Analyze the data and provide actionable insights, trends, and risk predictions.`;

  const systemPrompt = "You are a senior educational data analyst. You provide deep insights from LMS performance data.";
  return callGemini(apiKey, prompt, systemPrompt, [], res);
}

/**
 * Feature 5: LMS UI Feature Assistant (Kofi AI)
 */
async function handlePlatformAssistant(payload, res) {
  const { message, history = [] } = payload;
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
  - You have NO access to personal student data, grades, or private course content.
  - You cannot perform administrative actions like enrollment, account deletion, or password resets.
  - For support issues beyond navigation, direct users to the "Help Center" or "Contact Us" pages.
  - Keep responses professional, friendly, and concise.
  - Use markdown for formatting (bullet points for features, bold for emphasis).`;

  return callGemini(apiKey, message, systemPrompt, history, res);
}

/**
 * Feature 6: Embedding Generation for RAG
 */
async function handleGenerateEmbedding(payload, res) {
  const { text } = payload;
  const apiKey = process.env.GEMINI_EMBEDDING_API_KEY;
  if (!apiKey) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'GEMINI_EMBEDDING_API_KEY not configured' }));
    return;
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: "models/text-embedding-004",
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
}

async function handleGenerateBatchEmbeddings(payload, res) {
  const { texts } = payload;
  const apiKey = process.env.GEMINI_EMBEDDING_API_KEY;
  if (!apiKey) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'GEMINI_EMBEDDING_API_KEY not configured' }));
    return;
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: texts.map(text => ({
        model: "models/text-embedding-004",
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
}

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

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
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

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Gemini API Error:', errorText);
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Gemini API returned ${response.status}: ${errorText}` }));
    return;
  }

  const data = await response.json();

  const aiResponse = {
    content: data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from AI.',
    raw: data
  };

  res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(aiResponse));
}
