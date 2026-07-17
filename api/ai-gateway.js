// Vercel Serverless Function: api/ai-gateway.js
// Handles downstream Gemini API content generation & embeddings.
// Keeps secret keys secured inside the Vercel environment.

const {
  classifyIntent,
  routeConversation,
  filterRequestIntent,
  runResponseQualityGuard,
  resolveApiKey,
  resolveModelId
} = require('./conversation-manager');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-session-id, x-supabase-signature',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
};

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

      // Query course title if not already provided to ensure the tutor is course-aware of its own subject and title
      if (!payload.course_title) {
        try {
          const courseRes = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/courses?id=eq.${course_id}`, {
            headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
          });
          if (courseRes.ok) {
            const courseData = await courseRes.json();
            if (courseData && courseData.length > 0) {
              payload.course_title = courseData[0].title;
            }
          }
        } catch (courseError) {
          console.warn('Failed to query course title in Vercel RAG step:', courseError);
        }
      }

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
              content: { parts: [{ text: message }] },
              outputDimensionality: 768
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
          const [matRes, lesRes, topRes, courseRes] = await Promise.all([
            fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/materials?course_id=eq.${course_id}&limit=5`, {
              headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
            }),
            fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/lessons?course_id=eq.${course_id}&limit=5`, {
              headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
            }),
            fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/topics?course_id=eq.${course_id}&limit=5`, {
              headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
            }),
            fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/courses?id=eq.${course_id}`, {
              headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
            })
          ]);

          const materials = matRes.ok ? await matRes.json() : [];
          const lessons = lesRes.ok ? await lesRes.json() : [];
          const topics = topRes.ok ? await topRes.json() : [];
          const courseData = courseRes.ok ? await courseRes.json() : [];
          const course = courseData?.[0] || null;

          const courseCtx = course ? `Course: ${course.title}\nDescription: ${course.description || ''}\nSemester: ${course.semester || ''}\n\n` : '';

          context = [
            courseCtx,
            ...(topics || []).map(t => `Topic: ${t.title}\nDescription: ${t.description || ''}`),
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

      case 'index_course':
        return await handleIndexCourse(payload, res);

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

  const filterRefusal = filterRequestIntent(message, 'tutor');
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

  const courseTitle = payload.course_title || 'this course';
  const systemPrompt = `You are an expert academic tutor supporting Ghanaian SHS learners for the course "${courseTitle}".
  Your goal is to provide high-quality, conversational tutoring. Explain concepts clearly and build learner understanding progressively. Connect explanations to classroom, real-world, or family contexts where applicable.

  Your teaching approach must align with:
  - Ghana Education Service (GES) curriculum expectations.
  - SHS learning standards.
  - WASSCE examination preparations where relevant.

  Use the provided course context to answer student questions. If information is missing, state that the course material or lesson does not contain the answer and provide general academic guidance where appropriate. Never invent course-specific facts.

  Classroom Teacher Feedback Integration:
  - If the student shares classroom teacher feedback, grade comments, or scores from an assignment or quiz, act as their supportive tutor explaining the feedback constructively. Highlight conceptual gaps, correct terminology errors, and provide step-by-step guidance to help them master the topics and improve.

  Strict Token Bloat Prevention Rules:
  - Do not repeat or restate the student's question or the provided teacher feedback in your response.
  - Keep explanations highly direct, concise, and academically focused.
  - Avoid wordy preambles, generic robotic intros, or repetitive summaries.
  - Limit responses to a maximum of 3-4 highly informative paragraphs, utilizing bullet points for step-by-step clarity.

  Key Tutoring Principles:
  1. Conversational Style: Be encouraging, clear, and professional.
  2. Answers & Explanations: Provide precise and accurate answers; explain the underlying concepts.
  3. Follow-up: Ask a short follow-up question when it helps assess understanding or continue learning. Do not force a follow-up question for simple factual answers or calculations.

  Strict Academic Guardrails:
  - You have absolutely NO access to quizzes, exams, assignments, student submissions, grades, secrets, personal or private data.
  - If a student asks about their grades, specific assignment answers, quiz solutions, submission statuses, secrets, personal or private data, you MUST politely explain that you do not have access to that information and can only assist them in learning and understanding the course concepts, lessons, and materials.
  - Do not make up answers. If the information is not in the context, guide the student based on general academic principles related to the topic, but prioritize course-specific info.
  - Strict Conversational Quality Check: Always use flawless grammar, perfect spelling, and elegant sentence structure. Maintain a professional, friendly teacher tone suitable suitable for students. Match the user's request precisely.

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

    const guardedText = runResponseQualityGuard(rawText, 'tutor');

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
 * Bounded Concurrency Helper
 */
async function parallelLimit(items, concurrency, processor) {
  const results = [];
  const executing = new Set();

  for (const item of items) {
    const p = Promise.resolve().then(() => processor(item));
    results.push(p);
    executing.add(p);

    const clean = () => executing.delete(p);
    p.then(clean, clean);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

async function getIndexingState(supabaseUrl, supabaseAnonKey, materialId) {
  try {
    const res = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/material_indexing_states?material_id=eq.${materialId}`, {
      headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
    });
    if (res.ok) {
      const data = await res.json();
      return data?.[0] || null;
    }
  } catch (err) {
    console.error(`Error fetching indexing state for ${materialId}:`, err);
  }
  return null;
}

async function upsertIndexingState(supabaseUrl, supabaseAnonKey, state) {
  try {
    await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/material_indexing_states`, {
      method: 'POST',
      headers: {
        'apikey': supabaseAnonKey,
        'Authorization': `Bearer ${supabaseAnonKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(state)
    });
  } catch (err) {
    console.error(`Error upserting indexing state for ${state.material_id}:`, err);
  }
}

async function getExistingChunkIndexes(supabaseUrl, supabaseAnonKey, materialId) {
  try {
    const res = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/material_embeddings?material_id=eq.${materialId}&select=metadata`, {
      headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
    });
    if (res.ok) {
      const data = await res.json();
      return new Set(data.map(d => d.metadata?.chunk_index).filter(idx => idx !== undefined && idx !== null));
    }
  } catch (err) {
    console.error(`Error fetching existing chunk indexes for ${materialId}:`, err);
  }
  return new Set();
}

/**
 * Feature 6: Knowledge Base Indexing Support
 */
async function handleIndexCourse(payload, res) {
  const { course_id, material_id } = payload;
  if (!course_id) {
    res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'course_id is required' }));
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Server configuration error: missing SUPABASE_URL or SUPABASE_ANON_KEY' }));
    return;
  }

  try {
    let materials = [];
    let lessons = [];
    let topics = [];
    let course = null;

    if (material_id) {
      // Indexing a single, specific material
      const materialsRes = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/materials?id=eq.${material_id}&select=id,title,description,file_url,file_type`, {
        headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
      });
      if (!materialsRes.ok) throw new Error(`Failed to fetch material: ${await materialsRes.text()}`);
      materials = await materialsRes.json();
    } else {
      // Full course level indexing
      const [materialsRes, lessonsRes, topicsRes, courseRes] = await Promise.all([
        fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/materials?course_id=eq.${course_id}&select=id,title,description,file_url,file_type`, {
          headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
        }),
        fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/lessons?course_id=eq.${course_id}&select=id,title,content,topic_id`, {
          headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
        }),
        fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/topics?course_id=eq.${course_id}&select=id,title,description`, {
          headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
        }),
        fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/courses?id=eq.${course_id}&select=title,description,semester`, {
          headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
        })
      ]);

      if (!materialsRes.ok) throw new Error(`Failed to fetch materials: ${await materialsRes.text()}`);
      if (!lessonsRes.ok) throw new Error(`Failed to fetch lessons: ${await lessonsRes.text()}`);
      if (!topicsRes.ok) throw new Error(`Failed to fetch topics: ${await topicsRes.text()}`);
      if (!courseRes.ok) throw new Error(`Failed to fetch course: ${await courseRes.text()}`);

      materials = await materialsRes.json();
      lessons = await lessonsRes.json();
      topics = await topicsRes.json();
      const courseList = await courseRes.json();
      course = courseList?.[0] || null;
    }

    const chunks = [];

    // 1. Index course info itself (only if course-level indexing)
    if (course) {
      // Skip if course info embedding already exists
      const courseEmbedsRes = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/material_embeddings?course_id=eq.${course_id}&lesson_id=is.null&material_id=is.null&select=id`, {
        headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
      });
      const exists = courseEmbedsRes.ok && (await courseEmbedsRes.json()).length > 0;

      if (!exists) {
        chunks.push({
          course_id: course_id,
          content: `Course Title: ${course.title}\nDescription: ${course.description || ''}\nSemester: ${course.semester || ''}`,
          metadata: { type: 'course', title: course.title }
        });
      } else {
        console.log(`✓ Course info embedding already exists for course ${course_id}. Skipping.`);
      }
    }

    // 2. Index topics (only if course-level indexing)
    if (topics && Array.isArray(topics)) {
      // Query existing topic embeddings for this course to skip duplicates
      const topicEmbedsRes = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/material_embeddings?course_id=eq.${course_id}&material_id=is.null&lesson_id=is.null&select=metadata`, {
        headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
      });
      const existingTopics = new Set();
      if (topicEmbedsRes.ok) {
        const data = await topicEmbedsRes.json();
        data.forEach(d => {
          if (d.metadata?.type === 'topic' && d.metadata?.topic_id) {
            existingTopics.add(d.metadata.topic_id);
          }
        });
      }

      topics.forEach((t) => {
        if (!existingTopics.has(t.id)) {
          chunks.push({
            course_id: course_id,
            content: `Topic Title: ${t.title}\nDescription: ${t.description || ''}`,
            metadata: { type: 'topic', title: t.title, topic_id: t.id }
          });
        } else {
          console.log(`✓ Topic embedding already exists for topic ${t.title} (${t.id}). Skipping.`);
        }
      });
    }

    // 3. Index lessons (only if course-level indexing)
    if (lessons && Array.isArray(lessons)) {
      // Query existing lesson embeddings to skip duplicates
      const lessonEmbedsRes = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/material_embeddings?course_id=eq.${course_id}&lesson_id=not.is.null&select=lesson_id`, {
        headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
      });
      const existingLessons = new Set();
      if (lessonEmbedsRes.ok) {
        const data = await lessonEmbedsRes.json();
        data.forEach(d => existingLessons.add(d.lesson_id));
      }

      // Build topics map for lookup
      const topicsMap = {};
      if (topics && Array.isArray(topics)) {
        topics.forEach(t => {
          topicsMap[t.id] = t.title;
        });
      }

      lessons.forEach((l) => {
        if (!existingLessons.has(l.id)) {
          const content = l.content || '';
          const topicTitle = l.topic_id ? (topicsMap[l.topic_id] || '') : '';
          const topicContext = topicTitle ? ` (Topic: ${topicTitle})` : '';
          const chunkSize = 2000;
          for (let i = 0; i < content.length; i += chunkSize) {
            chunks.push({
              lesson_id: l.id,
              course_id: course_id,
              content: `Lesson Title: ${l.title}${topicContext}\nContent Chunk: ${content.substring(i, i + chunkSize)}`,
              metadata: { type: 'lesson', title: l.title, chunk_index: Math.floor(i / chunkSize), topic_id: l.topic_id }
            });
          }
        } else {
          console.log(`✓ Lesson embedding already exists for lesson ${l.title} (${l.id}). Skipping.`);
        }
      });
    }

    // 4. Index materials (using full robust state machine for PDFs)
    if (materials && Array.isArray(materials)) {
      for (const m of materials) {
        const fileUrl = m.file_url || '';
        const fileType = m.file_type || '';
        let isPdf = false;

        if (fileType.toLowerCase().includes('pdf')) {
          isPdf = true;
        } else {
          try {
            const urlObj = new URL(fileUrl);
            const pathOnly = urlObj.pathname.toLowerCase();
            isPdf = pathOnly.endsWith('.pdf') || pathOnly.includes('pdf') || urlObj.search.toLowerCase().includes('.pdf');
          } catch (e) {
            isPdf = fileUrl.toLowerCase().includes('.pdf') || fileUrl.includes('content-type=application/pdf');
          }
        }

        if (isPdf) {
          const mStart = Date.now();
          let state = await getIndexingState(supabaseUrl, supabaseAnonKey, m.id);

          let extractedText = '';
          let chunksJson = null;
          let status = 'pending';
          let currentStep = 'none';
          let retryCount = 0;
          let timingLogs = {};

          if (state) {
            extractedText = state.extracted_text || '';
            chunksJson = state.chunks || null;
            status = state.status || 'pending';
            currentStep = state.current_step || 'none';
            retryCount = state.retry_count || 0;
            timingLogs = state.timing_logs || {};
          }

          // If PDF file URL changed or no state exists, do a fresh start for this material
          if (!state || state.file_url !== fileUrl) {
            console.log(`Initializing fresh indexing state for PDF material: ${m.title}`);
            // Delete existing embeddings for this material
            const deleteUrl = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/material_embeddings?material_id=eq.${m.id}`;
            await fetch(deleteUrl, {
              method: 'DELETE',
              headers: {
                'apikey': supabaseAnonKey,
                'Authorization': `Bearer ${supabaseAnonKey}`
              }
            });

            extractedText = '';
            chunksJson = null;
            status = 'pending';
            currentStep = 'none';
            retryCount = 0;
            timingLogs = {};

            state = {
              material_id: m.id,
              course_id: course_id,
              file_url: fileUrl,
              extracted_text: null,
              chunks: null,
              status: 'pending',
              current_step: 'none',
              timing_logs: {},
              retry_count: 0
            };
            await upsertIndexingState(supabaseUrl, supabaseAnonKey, state);
          }

          // If already completed, skip processing
          if (status === 'completed') {
            console.log(`✓ PDF material ${m.title} is already fully indexed. Skipping.`);
            continue;
          }

          try {
            // Stage 1: Download & Text Extraction
            if (extractedText && (status === 'extracted' || status === 'chunked' || status === 'embedding')) {
              console.log(`✓ PDF text already extracted for ${m.title}. Skipping extraction.`);
            } else {
              console.log(`Starting PDF download and extraction for: ${m.title}`);
              const extStart = Date.now();

              await upsertIndexingState(supabaseUrl, supabaseAnonKey, {
                ...state,
                status: 'extracting',
                current_step: 'extraction'
              });

              const pdfResponse = await fetch(fileUrl);
              if (!pdfResponse.ok) {
                throw new Error(`Failed to download PDF from storage: ${pdfResponse.statusText}`);
              }
              const arrayBuffer = await pdfResponse.arrayBuffer();
              const base64Data = Buffer.from(arrayBuffer).toString('base64');

              const apiKey = resolveApiKey('extract_pdf_text', payload);
              const model = resolveModelId('extract_pdf_text', payload);

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
                throw new Error(`Gemini PDF parse API returned status ${response.status}: ${errorText}`);
              }

              const data = await response.json();
              extractedText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

              if (!extractedText || extractedText.trim().length === 0) {
                throw new Error("Gemini extracted zero text from this PDF document.");
              }

              timingLogs.extraction = Date.now() - extStart;
              status = 'extracted';
              currentStep = 'extraction';

              await upsertIndexingState(supabaseUrl, supabaseAnonKey, {
                ...state,
                extracted_text: extractedText,
                status,
                current_step: currentStep,
                timing_logs: timingLogs
              });
              console.log(`✓ Extraction completed for ${m.title} in ${timingLogs.extraction}ms`);
            }

            // Stage 2: Dynamic Chunking
            if (chunksJson && (status === 'chunked' || status === 'embedding')) {
              console.log(`✓ Chunks already parsed for ${m.title}. Skipping chunking.`);
            } else {
              console.log(`Starting chunking for: ${m.title}`);
              const chunkStart = Date.now();

              await upsertIndexingState(supabaseUrl, supabaseAnonKey, {
                ...state,
                status: 'chunking',
                current_step: 'chunking'
              });

              // Dynamic Structure-Aware Segmenting
              const allowedOptions = payload.chunk_options || ['chapter', 'chapters', 'section', 'sections', 'topic', 'topics', 'week', 'weeks', 'lesson', 'lessons'];
              const optionsPattern = allowedOptions.map(opt => opt.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
              const boundaryRegex = new RegExp(`(?:\\r?\\n|^)(?=(?:${optionsPattern})\\s+(?:[0-9]+|[a-z]+|[ivxldm]+)\\b|\\r?\\n{2,}(?=[a-z\\s]{3,100}:))`, 'i');
              const rawSegments = extractedText.split(boundaryRegex).map(s => s.trim()).filter(s => s.length > 0);
              const parsedChunks = [];

              for (const segment of rawSegments) {
                if (segment.length > 2500) {
                  let start = 0;
                  while (start < segment.length) {
                    let end = start + 2500;
                    if (end < segment.length) {
                      const lastBreak = segment.lastIndexOf('\n', end);
                      if (lastBreak > start + 1000) {
                        end = lastBreak;
                      } else {
                        const lastPeriod = segment.lastIndexOf('. ', end);
                        if (lastPeriod > start + 1000) {
                          end = lastPeriod + 2;
                        }
                      }
                    } else {
                      end = segment.length;
                    }
                    parsedChunks.push(segment.substring(start, end).trim());
                    start = end;
                  }
                } else {
                  parsedChunks.push(segment);
                }
              }

              const localChunks = [];
              let chunkIndex = 0;
              for (const chunkText of parsedChunks) {
                let structureType = 'segment';
                const firstWords = chunkText.substring(0, 50).toLowerCase();

                for (const opt of allowedOptions) {
                  const cleanOpt = opt.toLowerCase().trim();
                  if (firstWords.includes(cleanOpt)) {
                    if (cleanOpt.endsWith('s')) {
                      const singular = cleanOpt.slice(0, -1);
                      structureType = allowedOptions.map(o => o.toLowerCase()).includes(singular) ? singular : cleanOpt;
                    } else {
                      structureType = cleanOpt;
                    }
                    break;
                  }
                }

                if (structureType === 'segment') {
                  if (firstWords.includes('chapter')) structureType = 'chapter';
                  else if (firstWords.includes('section')) structureType = 'section';
                  else if (firstWords.includes('topic')) structureType = 'topic';
                  else if (firstWords.includes('week')) structureType = 'week';
                  else if (firstWords.includes('lesson')) structureType = 'lesson';
                }

                localChunks.push({
                  material_id: m.id,
                  course_id: course_id,
                  content: `Document: ${m.title}\nStructure: ${structureType.toUpperCase()}\nContent Segment:\n${chunkText}`,
                  metadata: {
                    type: 'material_pdf',
                    title: m.title,
                    chunk_index: chunkIndex++,
                    structure_type: structureType
                  }
                });
              }

              chunksJson = localChunks;
              timingLogs.chunking = Date.now() - chunkStart;
              status = 'chunked';
              currentStep = 'chunking';

              await upsertIndexingState(supabaseUrl, supabaseAnonKey, {
                ...state,
                chunks: chunksJson,
                status,
                current_step: currentStep,
                timing_logs: timingLogs
              });
              console.log(`✓ Chunking completed for ${m.title} in ${timingLogs.chunking}ms (${chunksJson.length} chunks generated)`);
            }

            // Stage 3: Embedding and Storage with Bounded Concurrency Pool
            console.log(`Embedding chunks for: ${m.title}`);
            const embedStart = Date.now();

            await upsertIndexingState(supabaseUrl, supabaseAnonKey, {
              ...state,
              status: 'embedding',
              current_step: 'embedding'
            });

            // Fetch already indexed chunk indexes from DB
            const existingChunkIndexes = await getExistingChunkIndexes(supabaseUrl, supabaseAnonKey, m.id);
            const missingChunks = chunksJson.filter(c => !existingChunkIndexes.has(c.metadata?.chunk_index));

            if (missingChunks.length === 0) {
              console.log(`✓ All ${chunksJson.length} chunks already embedded and stored in DB. Skipping.`);
            } else {
              console.log(`Found ${missingChunks.length} missing chunk embeddings to process (out of ${chunksJson.length} total).`);

              const batchSize = 10;
              const batches = [];
              for (let i = 0; i < missingChunks.length; i += batchSize) {
                batches.push(missingChunks.slice(i, i + batchSize));
              }

              const apiKey = resolveApiKey('generate_batch_embeddings', payload);
              const embeddingModel = resolveModelId('generate_batch_embeddings', payload);
              const cleanEmbeddingModel = embeddingModel.replace(/^models\//, '');

              // Bounded concurrency processor (3-5 simultaneous batch requests)
              await parallelLimit(batches, 4, async (batch) => {
                const embedResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cleanEmbeddingModel}:batchEmbedContents?key=${apiKey}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    requests: batch.map(c => ({
                      model: `models/${cleanEmbeddingModel}`,
                      content: { parts: [{ text: c.content }] },
                      outputDimensionality: 768
                    }))
                  })
                });

                if (!embedResponse.ok) {
                  throw new Error(`Batch Embedding Generation failed: ${await embedResponse.text()}`);
                }

                const embedResult = await embedResponse.json();
                const embeddings = embedResult.embeddings.map(e => e.values);

                const records = batch.map((chunk, idx) => ({
                  ...chunk,
                  embedding: embeddings[idx]
                }));

                const insertResponse = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/material_embeddings`, {
                  method: 'POST',
                  headers: {
                    'apikey': supabaseAnonKey,
                    'Authorization': `Bearer ${supabaseAnonKey}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation'
                  },
                  body: JSON.stringify(records)
                });

                if (!insertResponse.ok) {
                  throw new Error(`Failed to insert batch embeddings: ${await insertResponse.text()}`);
                }
              });
            }

            timingLogs.embedding = Date.now() - embedStart;
            timingLogs.total = Date.now() - mStart;
            status = 'completed';
            currentStep = 'completed';

            await upsertIndexingState(supabaseUrl, supabaseAnonKey, {
              ...state,
              status,
              current_step: currentStep,
              error_message: null,
              timing_logs: timingLogs
            });
            console.log(`✓ Indexing successfully completed for PDF material ${m.title} in ${timingLogs.total}ms!`);

          } catch (materialError) {
            console.error(`Error during processing material ${m.title}:`, materialError);
            const errStr = materialError.message || String(materialError);

            await upsertIndexingState(supabaseUrl, supabaseAnonKey, {
              ...state,
              status: 'failed',
              current_step: currentStep,
              error_message: errStr,
              retry_count: retryCount + 1
            });

            if (material_id) {
              throw materialError;
            }
          }
          continue; // Skip the metadata fallback since we processed the PDF content
        }

        // Fallback to title and description for non-PDFs or failed extractions
        chunks.push({
          material_id: m.id,
          course_id: course_id,
          content: `Material Title: ${m.title}\nDescription: ${m.description || ''}`,
          metadata: { type: 'material', title: m.title }
        });
      }
    }

    // 5. Embed and store remaining non-PDF chunks (lessons, topics, course info, non-PDF materials)
    if (chunks.length > 0) {
      console.log(`Processing ${chunks.length} non-PDF metadata chunks...`);
      const batchSize = 10;
      const batches = [];
      for (let i = 0; i < chunks.length; i += batchSize) {
        batches.push(chunks.slice(i, i + batchSize));
      }

      const apiKey = resolveApiKey('generate_batch_embeddings', payload);
      const embeddingModel = resolveModelId('generate_batch_embeddings', payload);
      const cleanEmbeddingModel = embeddingModel.replace(/^models\//, '');

      await parallelLimit(batches, 4, async (batch) => {
        const embedResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cleanEmbeddingModel}:batchEmbedContents?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: batch.map(c => ({
              model: `models/${cleanEmbeddingModel}`,
              content: { parts: [{ text: c.content }] },
              outputDimensionality: 768
            }))
          })
        });

        if (!embedResponse.ok) {
          throw new Error(`Batch Embedding Generation failed for non-PDF chunk: ${await embedResponse.text()}`);
        }

        const embedResult = await embedResponse.json();
        const embeddings = embedResult.embeddings.map(e => e.values);

        const records = batch.map((chunk, idx) => ({
          ...chunk,
          embedding: embeddings[idx]
        }));

        const insertResponse = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/material_embeddings`, {
          method: 'POST',
          headers: {
            'apikey': supabaseAnonKey,
            'Authorization': `Bearer ${supabaseAnonKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify(records)
        });

        if (!insertResponse.ok) {
          throw new Error(`Failed to insert non-PDF batch embeddings: ${await insertResponse.text()}`);
        }
      });
    }

    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: `Successfully completed indexing for course ${course_id}` }));

  } catch (error) {
    console.error('Indexing failed:', error);
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message || String(error) }));
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
  The assessment MUST be strictly aligned with the following lesson content and GES SHS curriculum expectations and WASSCE examination standards:
  ---
  LESSON TITLE: ${lesson_title || 'Selected Lesson'}
  LESSON CONTENT:
  ${lesson_content}
  ---
  Ensure that you only generate questions about the concepts, definitions, theories, and details explicitly mentioned in the lesson above. Do not include external or off-topic information.`;
  }

  const systemPrompt = `You are an expert Ghana Education Service (GES) Senior High School (SHS) curriculum designer, WASSCE examination questions setter, and assessment specialist.
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

Assessment Design Requirements:
- Align questions with GES SHS curriculum expectations and WASSCE examination standards.
- Match the cognitive demand to the specified proficiency level.
- Use appropriate WASSCE command verbs.
- Ensure questions assess knowledge, recall, understanding, skills, application, and reasoning where appropriate.
- Ensure questions have clear marking expectations.

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
      if (q.text) q.text = runResponseQualityGuard(q.text, 'tutor');
      if (q.hint) q.hint = runResponseQualityGuard(q.hint, 'tutor');
      if (q.explanation) q.explanation = runResponseQualityGuard(q.explanation, 'tutor');
      if (Array.isArray(q.options)) {
        q.options = q.options.map(opt => typeof opt === 'string' ? runResponseQualityGuard(opt, 'tutor') : opt);
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
     Question-by-Question Evaluation:
   - Highlight correct concepts before indicating weaknesses.
   - Provide specific corrections for errors.
   - Include spelling, grammar, terminology, and conceptual accuracy checks.
   - Write comments in a natural teacher feedback style.
  2. "overall_feedback": A summarized, precise, sanitized, and professional overall feedback/recommendation text for the teacher to apply directly. No conversational fillers or preambles. Max 3 sentences.
  3. "questions": An array of objects for each question:
   - "question_index": (integer, 0-indexed corresponding to the Questions array)
   - "score": (number, suggested score for this question, clamped between 0 and the max points for this question)
   - "feedback": (string, a teacher-written feedback comment specific to this student's submission. Maximum 2 sentences.)
   Feedback requirements:
   - Write feedback as if a teacher is marking the student's work directly.
   - Mention specific strengths when the answer is correct.
   - Identify exact mistakes when present (spelling errors, misconceptions, missing key points, incorrect terms).
   - When correcting an error, provide the correct term or explanation where helpful.
   - Focus on improvement and learning rather than only criticism.
   - Avoid generic statements such as "good job", "needs improvement", or "incorrect answer" without explanation.
   - If the answer is excellent, acknowledge what was done correctly.
   - If errors are mainly spelling/grammar mistakes, explicitly mention proofreading and careful review.
   - Keep the tone professional, concise, supportive, and same as handwritten teacher comments.

  Ensure all scores are numeric and clamped to the max points for the corresponding question. Keep descriptions of feedback professional, constructive, and precise. No conversational filler or preamble in the JSON. Output ONLY the raw JSON block without any markdown code fences or conversational text outside the block.`;

  const systemPrompt = `You are an experienced classroom teacher marking student work.
  Assisting Teacher: ${email}
  Role: ${role}
  Your feedback should resemble handwritten teacher comments based on the rubric: specific, encouraging, corrective, and focused on student improvement.
  Avoid generic AI-style evaluations & feedback. Output ONLY valid JSON containing report, feedback, and questions keys.`;

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
      if (parsed.report) parsed.report = runResponseQualityGuard(parsed.report, 'tutor');
      if (parsed.overall_feedback) parsed.overall_feedback = runResponseQualityGuard(parsed.overall_feedback, 'tutor');
      if (Array.isArray(parsed.questions)) {
        parsed.questions.forEach(q => {
          if (q.feedback) q.feedback = runResponseQualityGuard(q.feedback, 'tutor');
        });
      }
    } else {
      const guardedText = runResponseQualityGuard(rawText, 'tutor');
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
    Since you are a teacher, focus on course-level performance, tracking student completion rates, average scores, identifying low-performing or \"at-risk\" students, recommending targeted academic interventions, and suggesting updates or adjustments to lesson materials or assignments based on performance gaps.`;
  } else {
    systemPrompt += `
    Since you are a student, focus on personal progress tutoring. Highlight strengths, identify areas of improvement based on recent grades, suggest helpful study habits, and provide encouragement. Be a supportive personal study assistant.`;
  }

  systemPrompt += `
Strict Feedback Quality Check:
- Grammar and Sentence Structure: Use flawless grammar, correct spelling, precise punctuation, and clear sentence structure.
- Teacher Feedback Style: Write feedback as an experienced teacher marking a student's work. Keep comments natural, supportive, specific, and educational rather than robotic or corporate.
- Specificity Over Generic Comments: Always refer to the student's actual answer, identifying exact strengths, errors, missing concepts, incorrect terms, spelling mistakes, or grammar issues where applicable.
- Constructive Corrections: When identifying mistakes, provide the correct term or explanation when useful. Encourage proofreading and careful review when errors are caused by avoidable mistakes.
- Balanced Evaluation: Recognize correct work before highlighting areas requiring improvement. Do not make every comment negative.
- Conciseness: Keep feedback focused and avoid unnecessary explanations, repetition, or lengthy summaries.
- Remove Fillers: Avoid conversational fillers and generic introductions. Begin directly with the evaluation.
- Professional Tone: Maintain a respectful, encouraging, and objective teacher tone suitable for student assessment.
`;

  try {
    const { rawText, data } = await callGeminiAPI({
      apiKey,
      model: analyticsModel,
      prompt,
      systemInstruction: systemPrompt,
      temperature: 0.7
    });

    const guardedText = runResponseQualityGuard(rawText, 'tutor');

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

    const apiKey = resolveApiKey('extract_pdf_text', payload);
    const model = resolveModelId('extract_pdf_text', payload);

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
        content: { parts: [{ text }] },
        outputDimensionality: 768
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
          content: { parts: [{ text }] },
          outputDimensionality: 768
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
    const guardedText = runResponseQualityGuard(rawText, 'tutor');

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
