// Vercel Serverless Function: api/ai-gateway.js
// Enterprise-Grade Secure AI Gateway Router for SmartLMS.
// Securely processes Gemini AI API requests, enforces database authorization via Supabase RPCs,
// and resolves CORS/preflight issues completely by serving as a same-origin endpoint.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-session-id',
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
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server misconfiguration: missing Supabase environment variables' }));
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

    // Retrieve the session ID from incoming headers to verify authorization securely
    const sessionId = req.headers['x-session-id'] || '';

    // Standardized PostgREST fetch client options
    const postgrestHeaders = {
      'apikey': supabaseAnonKey,
      'Authorization': `Bearer ${supabaseAnonKey}`,
      'Content-Type': 'application/json',
      'x-session-id': sessionId
    };

    // 1. Authoritative DB Check: 100% reliance on the database's existing RBAC, ABAC, and sessions identity validation
    const authResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/get_ai_access_context`, {
      method: 'POST',
      headers: postgrestHeaders,
      body: JSON.stringify({
        p_operation_type: type,
        p_payload: payload
      })
    });

    if (!authResponse.ok) {
      const errorText = await authResponse.text();
      res.writeHead(403, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Database authorization check failed: ${errorText}` }));
      return;
    }

    const authContext = await authResponse.json();

    if (!authContext || !authContext.authorized) {
      res.writeHead(authContext?.error === 'Authentication required' ? 401 : 403, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: authContext?.error || 'Unauthorized' }));
      return;
    }

    const { email: userEmail, role: userRole } = authContext;

    // Feature Routing
    switch (type) {
      case 'platform_assistant':
        return await handlePlatformAssistant(payload, res);

      case 'tutor':
        return await handleCourseTutor(payload, userEmail, userRole, postgrestHeaders, supabaseUrl, res);

      case 'index_course':
        return await handleIndexCourse(payload, userEmail, userRole, postgrestHeaders, supabaseUrl, res);

      case 'generate_assessment':
        return await handleAssessmentGenerator(payload, userEmail, userRole, res);

      case 'grading':
        return await handleGradingAssistant(payload, userEmail, userRole, res);

      case 'analytics':
        return await handleAnalyticsAI(payload, userEmail, userRole, res);

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
 * Feature 1 & 6: Course-aware Tutor with Semantic Search (RAG)
 */
async function handleCourseTutor(payload, userEmail, userRole, postgrestHeaders, supabaseUrl, res) {
  const { course_id, message, history = [] } = payload;
  const embeddingApiKey = process.env.GEMINI_EMBEDDING_API_KEY;
  const tutorApiKey = process.env.GEMINI_COURSE_TUTOR_API_KEY;

  if (!embeddingApiKey || !tutorApiKey) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Gemini Keys not configured' }));
    return;
  }

  // 1. Generate embedding for user message
  const userMessageEmbedding = await generateEmbedding(embeddingApiKey, message);

  // 2. Perform Semantic Search using match_materials RPC via PostgREST
  const matchResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/match_materials`, {
    method: 'POST',
    headers: postgrestHeaders,
    body: JSON.stringify({
      query_embedding: userMessageEmbedding,
      match_threshold: 0.3,
      match_count: 5,
      p_course_id: course_id
    })
  });

  let context = '';
  if (matchResponse.ok) {
    const matches = await matchResponse.json();
    if (matches && matches.length > 0) {
      context = matches.map(m => m.content).join('\n---\n');
    }
  }

  // Fallback to basic retrieval if no matches or match failed
  if (!context) {
    const materialsUrl = `${supabaseUrl}/rest/v1/materials?course_id=eq.${course_id}&limit=5`;
    const lessonsUrl = `${supabaseUrl}/rest/v1/lessons?course_id=eq.${course_id}&limit=5`;

    const [materialsRes, lessonsRes] = await Promise.all([
      fetch(materialsUrl, { method: 'GET', headers: postgrestHeaders }),
      fetch(lessonsUrl, { method: 'GET', headers: postgrestHeaders })
    ]);

    let materials = [];
    let lessons = [];
    if (materialsRes.ok) materials = await materialsRes.json();
    if (lessonsRes.ok) lessons = await lessonsRes.json();

    context = [
      ...materials.map(m => `Material: ${m.title} - ${m.description}`),
      ...lessons.map(l => `Lesson: ${l.title}\nContent: ${l.content}`)
    ].join('\n\n');
  }

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

  return callGemini(tutorApiKey, message, systemPrompt, history, res);
}

/**
 * Feature 6: Knowledge Base Indexing (Chunking & Embedding)
 */
async function handleIndexCourse(payload, userEmail, userRole, postgrestHeaders, supabaseUrl, res) {
  const { course_id } = payload;
  const embeddingApiKey = process.env.GEMINI_EMBEDDING_API_KEY;

  if (!course_id) {
    res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'course_id is required' }));
    return;
  }

  // 1. Idempotency: Delete existing embeddings for this course
  const deleteRes = await fetch(`${supabaseUrl}/rest/v1/material_embeddings?course_id=eq.${course_id}`, {
    method: 'DELETE',
    headers: postgrestHeaders
  });

  if (!deleteRes.ok) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Failed to clear existing index: ${await deleteRes.text()}` }));
    return;
  }

  // 2. Fetch all materials and lessons for the course
  const materialsUrl = `${supabaseUrl}/rest/v1/materials?course_id=eq.${course_id}`;
  const lessonsUrl = `${supabaseUrl}/rest/v1/lessons?course_id=eq.${course_id}`;

  const [materialsRes, lessonsRes] = await Promise.all([
    fetch(materialsUrl, { method: 'GET', headers: postgrestHeaders }),
    fetch(lessonsUrl, { method: 'GET', headers: postgrestHeaders })
  ]);

  let materials = [];
  let lessons = [];
  if (materialsRes.ok) materials = await materialsRes.json();
  if (lessonsRes.ok) lessons = await lessonsRes.json();

  const chunks = [];

  materials.forEach(m => {
    chunks.push({
      material_id: m.id,
      course_id: course_id,
      content: `Material Title: ${m.title}\nDescription: ${m.description}`,
      metadata: { type: 'material', title: m.title }
    });
  });

  lessons.forEach(l => {
    const content = l.content || '';
    const chunkSize = 2000;
    for (let i = 0; i < content.length; i += chunkSize) {
      chunks.push({
        lesson_id: l.id,
        course_id: course_id,
        content: `Lesson Title: ${l.title}\nContent Chunk: ${content.substring(i, i + chunkSize)}`,
        metadata: { type: 'lesson', title: l.title, chunk_index: Math.floor(i / chunkSize) }
      });
    }
  });

  if (chunks.length === 0) {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'No content to index for this course.' }));
    return;
  }

  // Process in batches of 10
  const batchSize = 10;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const embeddings = await generateBatchEmbeddings(embeddingApiKey, batch.map(c => c.content));

    const records = batch.map((chunk, idx) => ({
      ...chunk,
      embedding: embeddings[idx]
    }));

    const insertRes = await fetch(`${supabaseUrl}/rest/v1/material_embeddings`, {
      method: 'POST',
      headers: {
        ...postgrestHeaders,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(records)
    });

    if (!insertRes.ok) {
      res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Insertion failed: ${await insertRes.text()}` }));
      return;
    }
  }

  res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, message: `Successfully indexed ${chunks.length} chunks for course ${course_id}` }));
}

/**
 * Feature 2: Assessment Generator
 */
async function handleAssessmentGenerator(payload, userEmail, userRole, res) {
  const { topic, type, count, difficulty, rubrics } = payload;
  const apiKey = process.env.GEMINI_ASSESSMENT_API_KEY;

  const prompt = `Generate a ${type} with ${count} questions about "${topic}".
  Difficulty level: ${difficulty}.
  ${rubrics ? `Follow these rubrics: ${rubrics}` : ''}
  Output MUST be a valid JSON array of question objects matching the SmartLMS schema.
  Wrap your JSON response in \`\`\`json [CODE] \`\`\` markers.`;

  const systemPrompt = `You are an expert curriculum designer and assessment generator.
  Generating for Teacher: ${userEmail}
  Role: ${userRole}
  You output only valid JSON.`;
  return callGemini(apiKey, prompt, systemPrompt, [], res);
}

/**
 * Feature 3: Grading Assistant
 */
async function handleGradingAssistant(payload, userEmail, userRole, res) {
  const { assignment_title, student_submission, rubric, questions } = payload;
  const apiKey = process.env.GEMINI_GRADING_API_KEY;

  const prompt = `Assignment: ${assignment_title}
  Rubric: ${rubric}
  Questions: ${JSON.stringify(questions)}
  Student Work: ${student_submission}

  Provide a detailed critique, suggested scores per question, and overall feedback for the student.`;

  const systemPrompt = `You are a fair and insightful teaching assistant.
  Assisting Teacher: ${userEmail}
  Role: ${userRole}
  Help the teacher grade by providing insights based on the rubric.`;
  return callGemini(apiKey, prompt, systemPrompt, [], res);
}

/**
 * Feature 4: Role-based Analytics
 */
async function handleAnalyticsAI(payload, userEmail, userRole, res) {
  const { analytics_data, question } = payload;
  const apiKey = process.env.GEMINI_ANALYTICS_API_KEY;

  const prompt = `My Role: ${userRole}
  My Identity: ${userEmail}
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
 * Gemini Embedding Helpers
 */
async function generateEmbedding(apiKey, text) {
  if (!apiKey) throw new Error('GEMINI_EMBEDDING_API_KEY not configured');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: "models/text-embedding-004",
      content: { parts: [{ text }] }
    })
  });
  if (!response.ok) throw new Error(`Embedding API Error: ${await response.text()}`);
  const data = await response.json();
  return data.embedding.values;
}

async function generateBatchEmbeddings(apiKey, texts) {
  if (!apiKey) throw new Error('GEMINI_EMBEDDING_API_KEY not configured');
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
  if (!response.ok) throw new Error(`Batch Embedding API Error: ${await response.text()}`);
  const data = await response.json();
  return data.embeddings.map(e => e.values);
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
