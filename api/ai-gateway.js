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
 * Helper to compute cosine similarity between two numeric vectors.
 */
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
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

    // Process materials RAG inside tutor (single-source of truth logic inside Vercel!)
    if (type === 'tutor') {
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
      const { course_id, message } = payload;

      // 1. Fetch full course structural metadata
      const { course, topics, lessons, materials } = await fetchCourseMetadata(course_id, supabaseUrl, supabaseAnonKey);
      if (course) {
        payload.course_title = course.title;
      }

      // 2. Generate embedding for user message
      const apiKey = resolveApiKey('generate_embedding', payload);
      const embeddingModel = resolveModelId('generate_embedding', payload);
      const cleanEmbeddingModel = embeddingModel.replace(/^models\//, '');
      let matches = [];
      let userEmbedding = null;

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
            userEmbedding = embedData.embedding.values;

            // Broader candidate set retrieval: Retrieve exactly 20 matches (Requirement 10)
            const matchResponse = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/match_knowledge`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseAnonKey,
                'Authorization': `Bearer ${supabaseAnonKey}`,
                'x-session-id': req.headers['x-session-id'] || ''
              },
              body: JSON.stringify({
                query_embedding: userEmbedding,
                match_threshold: 0.25, // inclusive default threshold
                match_count: 20, // Retrieve exactly 20 matches
                p_course_id: course_id
              })
            });

            if (matchResponse.ok) {
              matches = await matchResponse.json();
            }
          }
        } catch (embedError) {
          console.error('Semantic search in Vercel failed:', embedError);
        }
      }

      // 3. Topic lookup using cosine similarity (Requirement 1 & 5)
      // Occurs strictly AFTER semantic search/user embedding generation
      let activeTopic = null;
      if (userEmbedding) {
        let topicEmbeddings = [];
        try {
          const topicEmbedsRes = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/knowledge_embeddings?course_id=eq.${course_id}&source_type=eq.topic&select=source_id,embedding`, {
            headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
          });
          if (topicEmbedsRes.ok) {
            topicEmbeddings = await topicEmbedsRes.json();
          }
        } catch (e) {
          console.error('Failed to fetch topic embeddings for topic detection:', e);
        }

        let highestSimilarity = -1.0;
        for (const tEmbed of topicEmbeddings) {
          if (!tEmbed.embedding) continue;
          const sim = cosineSimilarity(userEmbedding, tEmbed.embedding);
          if (sim > highestSimilarity) {
            highestSimilarity = sim;
            activeTopic = topics.find(t => t.id === tEmbed.source_id) || null;
          }
        }

        // Enforce a reasonable threshold for topic detection to avoid false positives
        if (highestSimilarity < 0.3) {
          activeTopic = null;
        }
      }

      payload.active_topic = activeTopic;
      payload.user_embedding = userEmbedding;
      payload.semantic_matches = matches;
      payload.course_metadata = { course, topics, lessons, materials };
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
 * Helper to retrieve full course structural metadata from Supabase
 */
async function fetchCourseMetadata(courseId, supabaseUrl, supabaseAnonKey) {
  try {
    const [courseRes, topicsRes, lessonsRes, materialsRes] = await Promise.all([
      fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/courses?id=eq.${courseId}`, {
        headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
      }),
      fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/topics?course_id=eq.${courseId}&limit=100`, {
        headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
      }),
      fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/lessons?course_id=eq.${courseId}&select=id,title,content,topic_id&limit=100`, {
        headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
      }),
      fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/materials?course_id=eq.${courseId}&select=id,title,description,file_url,file_type&limit=100`, {
        headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
      })
    ]);

    const course = courseRes.ok ? (await courseRes.json())[0] : null;
    const topics = topicsRes.ok ? await topicsRes.json() : [];
    const lessons = lessonsRes.ok ? await lessonsRes.json() : [];
    const materials = materialsRes.ok ? await materialsRes.json() : [];

    return { course, topics, lessons, materials };
  } catch (err) {
    console.error('fetchCourseMetadata failed:', err);
    return { course: null, topics: [], lessons: [], materials: [] };
  }
}

/**
 * Feature 1 & 6: Course-aware Tutor
 */
async function handleCourseTutor(payload, res) {
  let { message, history = [], semantic_matches = [], course_metadata = {}, active_topic = null, user_embedding = null } = payload;

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

  // 1. Build candidate pool of semantic matches and structural pieces (Requirement 10 & 11)
  const candidates = [];
  const { course, topics = [], lessons = [], materials = [] } = course_metadata;

  // Add semantic matches
  (semantic_matches || []).forEach(match => {
    candidates.push({
      id: match.id,
      source_type: match.source_type,
      source_id: match.source_id,
      content: match.content,
      metadata: match.metadata || {},
      similarity: match.similarity || 0.5
    });
  });

  // Inject structural topics, lessons, and materials as candidate chunks if not already present
  lessons.forEach(l => {
    if (!candidates.some(c => c.source_type === 'lesson' && c.source_id === l.id)) {
      candidates.push({
        source_type: 'lesson',
        source_id: l.id,
        content: `Lesson Title: ${l.title}\nContent Chunk: ${l.content || ''}`,
        metadata: { type: 'lesson', title: l.title, topic_id: l.topic_id },
        similarity: 0.35 // lower default similarity
      });
    }
  });

  materials.forEach(m => {
    if (!candidates.some(c => c.source_type === 'material' && c.source_id === m.id)) {
      candidates.push({
        source_type: 'material',
        source_id: m.id,
        content: `Material Title: ${m.title}\nDescription: ${m.description || ''}`,
        metadata: { type: 'material', title: m.title },
        similarity: 0.35
      });
    }
  });

  // 2. Perform semantic topic-aware rerank (Requirement 11)
  // Completely removed lexical keyword scoring as per Requirement 1.
  candidates.forEach(c => {
    let score = c.similarity;

    // Structural boost: if the chunk aligns with the cosine-detected active topic
    if (active_topic) {
      const activeTopicTitle = active_topic.title.toLowerCase();
      const contentLower = c.content.toLowerCase();
      const isSameTopic = (c.metadata?.topic_id === active_topic.id) ||
                          (c.metadata?.topic && String(c.metadata.topic).toLowerCase().includes(activeTopicTitle)) ||
                          contentLower.includes(activeTopicTitle);
      if (isSameTopic) {
        score += 0.15; // 15% structural/semantic boost
      }
    }
    c.reranked_score = score;
  });

  // Re-rank candidates descending
  candidates.sort((a, b) => b.reranked_score - a.reranked_score);

  // Confidence thresholds and metadata-based filtering
  // Enforce Course Boundary: tutor must refuse if the top candidate score is below our strict threshold
  const CONFIDENCE_THRESHOLD = 0.4;
  const bestCandidate = candidates[0];

  if (!bestCandidate || bestCandidate.reranked_score < CONFIDENCE_THRESHOLD) {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      content: "I am sorry, but I cannot find sufficiently verified evidence in the course materials to answer your question. I am designed to assist you strictly using the official course curriculum and resources. Could you please specify or rephrase your question regarding our course topics?",
      intent: classification.intent,
      category: classification.category,
      confidence: classification.confidence,
      entities: classification.entities,
      action: 'unsupported_refusal'
    }));
    return;
  }

  // Filter down to exactly the top 5 highest-quality chunks (Requirement 10)
  const selectedChunks = candidates.slice(0, 5);

  // 3. Build highly structured prompts sections without using JSON.stringify
  const structuredCourseSection = course
    ? `Title: ${course.title}\nDescription: ${course.description || ''}\nSemester: ${course.semester || ''}`
    : `Title: ${payload.course_title || 'Unknown Course'}`;

  const structuredTopicSection = active_topic
    ? `Active Topic: ${active_topic.title}\nDescription: ${active_topic.description || ''}`
    : `Active Topic: General / Global Search`;

  const lessonTitles = lessons.map(l => l.title).join(', ') || 'None';
  const structuredLessonSection = `Available Lessons: ${lessonTitles}`;

  const materialTitles = materials.map(m => m.title).join(', ') || 'None';
  const structuredMaterialSection = `Available Materials: ${materialTitles}`;

  let evidenceText = '';
  selectedChunks.forEach((c, idx) => {
    evidenceText += `Evidence [${idx + 1}] (Source: ${c.source_type.toUpperCase()}, ID: ${c.source_id}):\n${c.content}\n\n`;
  });

  const apiKey = resolveApiKey('tutor', payload);
  const tutorModel = resolveModelId('tutor', payload);

  const systemPrompt = `You are a curriculum-grounded expert academic tutor supporting Ghanaian SHS learners.
Your goal is to provide high-quality, conversational tutoring.
You must be strictly course-aware and topic-aware, framing your entire response within the provided course and active topic structures.

Key Grounding Rules:
- Answer the student's question ONLY using the retrieved evidence.
- Never introduce any facts, concepts, or details not supported by the retrieved context.
- Quote or reference the specific lesson, topic, or material used.
- Require direct citations (e.g. "[Lesson: Lesson Title]" or "[Material: PDF Title]") to the lesson/material used in your answer.
- If the retrieved evidence is insufficient to answer the question, or if the question lies outside the course boundary, strictly refuse to answer. Do not use general knowledge to fill in gaps.

Classroom Teacher Feedback Integration:
- If the student shares classroom teacher feedback, grade comments, or scores from an assignment or quiz, act as their supportive tutor explaining the feedback constructively using the retrieved course evidence.

Strict Token Bloat Prevention Rules:
- Do not repeat or restate the student's question or the provided teacher feedback in your response.
- Keep explanations highly direct, concise, and academically focused.
- Avoid wordy preambles, generic robotic intros, or repetitive summaries.
- Limit responses to a maximum of 3-4 highly informative paragraphs, utilizing bullet points for step-by-step clarity.

Strict Academic Guardrails:
- You have absolutely NO access to quizzes, exams, assignments, student submissions, grades, secrets, personal or private data.
- If a student asks about their grades, specific assignment answers, quiz solutions, submission statuses, secrets, personal or private data, you MUST politely explain that you do not have access to that information and can only assist them in learning and understanding the course concepts, lessons, and materials.
- Strict Conversational Quality Check: Always use flawless grammar, perfect spelling, and elegant sentence structure. Maintain a professional, friendly teacher tone suitable suitable for students. Match the user's request precisely.`;

  const structuredPrompt = `--- COURSE CONTEXT ---
${structuredCourseSection}

--- TOPIC CONTEXT ---
${structuredTopicSection}

--- LESSON CONTEXT ---
${structuredLessonSection}

--- MATERIAL CONTEXT ---
${structuredMaterialSection}

--- RETRIEVED EVIDENCE ---
${evidenceText}

--- STUDENT QUESTION ---
${message}`;

  try {
    const { rawText, data } = await callGeminiAPI({
      apiKey,
      model: tutorModel,
      prompt: structuredPrompt,
      systemInstruction: systemPrompt,
      history: sanitizedHistory,
      temperature: 0.3 // slightly lower temperature for stricter grounding adherence
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

async function getExistingChunkIndexes(supabaseUrl, supabaseAnonKey, materialId, activeVersion) {
  try {
    const res = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/knowledge_embeddings?source_id=eq.${materialId}&select=metadata,embedding_version`, {
      headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.length > 0) {
        // Mismatch check triggers re-indexing when embedding models change
        const mismatch = data.some(d => d.embedding_version !== activeVersion);
        if (mismatch) {
          console.warn(`Embedding model version mismatch for ${materialId}. Re-indexing required.`);
          return { chunkIndexes: new Set(), versionMismatch: true };
        }
        return {
          chunkIndexes: new Set(data.map(d => d.metadata?.chunk_index).filter(idx => idx !== undefined && idx !== null)),
          versionMismatch: false
        };
      }
    }
  } catch (err) {
    console.error(`Error fetching existing chunk indexes for ${materialId}:`, err);
  }
  return { chunkIndexes: new Set(), versionMismatch: false };
}

/**
 * Shared chunk, embed, and store engine for course knowledge items.
 */
async function indexText({
    sourceType,
    sourceId,
    courseId,
    title,
    text,
    chunkOptions = null,
    supabaseUrl = null,
    supabaseAnonKey = null,
    payload = null,
    geminiChunks = null
}) {

    const normalizeText = (t) => {
        return t ? t.trim() : '';
    };

    const chunkText = (normalizedText) => {
        if (sourceType === 'material' && geminiChunks && Array.isArray(geminiChunks)) {
            console.log(`Using ${geminiChunks.length} pre-segmented chunks from Gemini for material ${sourceId}`);
            return geminiChunks.map((c, idx) => {
                let pathHeader = `Document: ${title}`;
                if (c.chapter) pathHeader += ` > Chapter: ${c.chapter}`;
                if (c.section) pathHeader += ` > Section: ${c.section}`;
                if (c.topic) pathHeader += ` > Topic: ${c.topic}`;

                return {
                    content: `Hierarchy Context: ${pathHeader}\nStructure: ${(c.structure_type || 'segment').toUpperCase()}\nContent Segment:\n${c.content}`,
                    metadata: {
                        type: 'material_pdf',
                        title: title,
                        chunk_index: idx,
                        structure_type: c.structure_type || 'segment',
                        chapter: c.chapter || null,
                        section: c.section || null,
                        topic: c.topic || null
                    }
                };
            });
        }

        const splitSemantically = (rawText, limit) => {
            const paragraphs = rawText.split(/\r?\n{2,}/);
            const subChunks = [];
            let currentBlock = "";

            for (const para of paragraphs) {
                const cleanPara = para.trim();
                if (!cleanPara) continue;

                if ((currentBlock + "\n\n" + cleanPara).length <= limit) {
                    currentBlock = currentBlock ? currentBlock + "\n\n" + cleanPara : cleanPara;
                } else {
                    if (currentBlock) {
                        subChunks.push(currentBlock);
                        currentBlock = "";
                    }

                    if (cleanPara.length <= limit) {
                        currentBlock = cleanPara;
                    } else {
                        const sentences = cleanPara.match(/[^.!?]+[.!?]+(\s+|$)/g) || [cleanPara];
                        for (const sentence of sentences) {
                            const cleanSentence = sentence.trim();
                            if (!cleanSentence) continue;

                            if ((currentBlock + " " + cleanSentence).length <= limit) {
                                currentBlock = currentBlock ? currentBlock + " " + cleanSentence : cleanSentence;
                            } else {
                                if (currentBlock) {
                                    subChunks.push(currentBlock);
                                }
                                currentBlock = cleanSentence;
                            }
                        }
                    }
                }
            }
            if (currentBlock) {
                subChunks.push(currentBlock);
            }
            return subChunks;
        };

        if (sourceType === 'lesson') {
            const parts = splitSemantically(normalizedText, 2000);
            return parts.map((chunk, idx) => ({
                content: `Lesson Title: ${title}\nContent Chunk: ${chunk}`,
                metadata: { type: 'lesson', title: title, chunk_index: idx }
            }));
        } else if (sourceType === 'material') {
            const allowedOptions = chunkOptions || ['chapter', 'chapters', 'section', 'sections', 'topic', 'topics', 'week', 'weeks', 'lesson', 'lessons'];
            const optionsPattern = allowedOptions.map(opt => opt.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
            const boundaryRegex = new RegExp(`(?:\\r?\\n|^)(?=(?:${optionsPattern})\\s+(?:[0-9]+|[a-z]+|[ivxldm]+)\\b|\\r?\\n(?=[a-z\\s]{3,100}:))`, 'i');
            const rawSegments = normalizedText.split(boundaryRegex).map(s => s.trim()).filter(s => s.length > 0);

            const localChunks = [];
            let chunkIndex = 0;

            // Track hierarchy state across segments
            let currentChapter = "";
            let currentSection = "";
            let currentTopic = "";

            for (const segment of rawSegments) {
                const firstWords = segment.substring(0, 100).toLowerCase();

                // Update hierarchy context
                if (/\b(?:chapter|chapters)\b/i.test(firstWords)) {
                    const match = segment.match(/^(?:chapter|chapters)\s+([^\r\n:]+)/i);
                    if (match) currentChapter = match[1].trim();
                } else if (/\b(?:section|sections)\b/i.test(firstWords)) {
                    const match = segment.match(/^(?:section|sections)\s+([^\r\n:]+)/i);
                    if (match) currentSection = match[1].trim();
                } else if (/\b(?:topic|topics)\b/i.test(firstWords)) {
                    const match = segment.match(/^(?:topic|topics)\s+([^\r\n:]+)/i);
                    if (match) currentTopic = match[1].trim();
                }

                // Split large segments semantically (2500 max characters)
                const parts = splitSemantically(segment, 2500);

                for (const part of parts) {
                    let structureType = 'segment';
                    const partFirstWords = part.substring(0, 100).toLowerCase();

                    // Detect document elements (Definitions, Examples, Exercises)
                    if (/\b(?:definition|definitions|define)\b/i.test(partFirstWords)) {
                        structureType = 'definition';
                    } else if (/\b(?:example|examples|eg\.?)\b/i.test(partFirstWords)) {
                        structureType = 'example';
                    } else if (/\b(?:exercise|exercises|practice|question|quiz)\b/i.test(partFirstWords)) {
                        structureType = 'exercise';
                    } else {
                        // Check standard or custom option keys
                        for (const opt of allowedOptions) {
                            const cleanOpt = opt.toLowerCase().trim();
                            if (partFirstWords.includes(cleanOpt)) {
                                if (cleanOpt.endsWith('s')) {
                                    const singular = cleanOpt.slice(0, -1);
                                    structureType = allowedOptions.map(o => o.toLowerCase()).includes(singular) ? singular : cleanOpt;
                                } else {
                                    structureType = cleanOpt;
                                }
                                break;
                            }
                        }
                    }

                    if (structureType === 'segment') {
                        if (partFirstWords.includes('chapter')) structureType = 'chapter';
                        else if (partFirstWords.includes('section')) structureType = 'section';
                        else if (partFirstWords.includes('topic')) structureType = 'topic';
                        else if (partFirstWords.includes('week')) structureType = 'week';
                        else if (partFirstWords.includes('lesson')) structureType = 'lesson';
                    }

                    // Build full path-based hierarchical context path header
                    let pathHeader = `Document: ${title}`;
                    if (currentChapter) pathHeader += ` > Chapter: ${currentChapter}`;
                    if (currentSection) pathHeader += ` > Section: ${currentSection}`;
                    if (currentTopic) pathHeader += ` > Topic: ${currentTopic}`;

                    localChunks.push({
                        content: `Hierarchy Context: ${pathHeader}\nStructure: ${structureType.toUpperCase()}\nContent Segment:\n${part}`,
                        metadata: {
                            type: 'material_pdf',
                            title: title,
                            chunk_index: chunkIndex++,
                            structure_type: structureType,
                            chapter: currentChapter || null,
                            section: currentSection || null,
                            topic: currentTopic || null
                        }
                    });
                }
            }
            return localChunks;
        } else {
            // Course, topic, or generic fallback
            const parts = splitSemantically(normalizedText, 2000);
            return parts.map((chunk, idx) => ({
                content: chunk,
                metadata: { type: sourceType, title: title, chunk_index: idx }
            }));
        }
    };

    const generateEmbeddingsForBatch = async (batch) => {
        const apiKeyVal = resolveApiKey('generate_batch_embeddings', payload || {});
        const embeddingModel = resolveModelId('generate_batch_embeddings', payload || {});
        const cleanEmbeddingModel = embeddingModel.replace(/^models\//, '');

        const fetchWithBackoff = async (url, options, maxRetries = 5, initialDelay = 1000) => {
            let attempt = 0;
            while (true) {
                try {
                    const res = await fetch(url, options);
                    if (res.ok) {
                        return res;
                    }
                    if (res.status === 429 || res.status >= 500) {
                        if (attempt >= maxRetries) {
                            throw new Error(`Failed after ${attempt} retries. Status: ${res.status}. Text: ${await res.text()}`);
                        }
                    } else {
                        throw new Error(`Non-retriable error. Status: ${res.status}. Text: ${await res.text()}`);
                    }
                } catch (err) {
                    if (attempt >= maxRetries) {
                        throw err;
                    }
                }
                const delay = initialDelay * Math.pow(2, attempt) + Math.random() * 500;
                console.warn(`Retry attempt ${attempt + 1} for embedding call. Waiting ${Math.round(delay)}ms due to rate limit/server error.`);
                await new Promise(resolve => setTimeout(resolve, delay));
                attempt++;
            }
        };

        const embedResponse = await fetchWithBackoff(
            `https://generativelanguage.googleapis.com/v1beta/models/${cleanEmbeddingModel}:batchEmbedContents?key=${apiKeyVal}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requests: batch.map(c => ({
                        model: `models/${cleanEmbeddingModel}`,
                        content: { parts: [{ text: c.content }] },
                        outputDimensionality: 768
                    }))
                })
            }
        );

        const embedResult = await embedResponse.json();
        return embedResult.embeddings.map(e => e.values);
    };

    const activeVersion = resolveModelId('generate_batch_embeddings', payload || {});

    const upsertKnowledgeEmbeddings = async ({
        sourceType,
        sourceId,
        courseId,
        title,
        chunks,
        embeddings,
        isAtomicReplace = false
    }) => {
        if (chunks.length === 0) return;

        if (isAtomicReplace) {
            const records = chunks.map((chunk, idx) => ({
                content: chunk.content,
                embedding: embeddings[idx],
                metadata: chunk.metadata
            }));

            console.log(`Performing ATOMIC delete-and-insert for ${sourceType} ${sourceId}`);
            const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/atomic_update_embeddings`, {
                method: 'POST',
                headers: {
                    'apikey': supabaseAnonKey,
                    'Authorization': `Bearer ${supabaseAnonKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    p_source_type: sourceType,
                    p_source_id: sourceId,
                    p_course_id: courseId,
                    p_embedding_version: activeVersion,
                    p_records: records
                })
            });
            if (!response.ok) {
                throw new Error(`Atomic update RPC failed: ${await response.text()}`);
            }
        } else {
            const fullRecords = chunks.map((chunk, idx) => ({
                source_type: sourceType,
                source_id: sourceId,
                course_id: courseId,
                content: chunk.content,
                embedding: embeddings[idx],
                metadata: chunk.metadata,
                material_id: sourceType === 'material' ? sourceId : null,
                lesson_id: sourceType === 'lesson' ? sourceId : null,
                embedding_version: activeVersion
            }));

            const insertResponse = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/knowledge_embeddings`, {
                method: 'POST',
                headers: {
                    'apikey': supabaseAnonKey,
                    'Authorization': `Bearer ${supabaseAnonKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(fullRecords)
            });

            if (!insertResponse.ok) {
                throw new Error(`Failed to insert batch embeddings: ${await insertResponse.text()}`);
            }
        }
    };

    const normalizedText = normalizeText(text);
    const chunks = chunkText(normalizedText);

    // Fetch transactional last_chunk_index to support resumption (Requirement 7)
    let lastChunkIndex = -1;
    if (sourceType === 'material') {
        const state = await getIndexingState(supabaseUrl, supabaseAnonKey, sourceId);
        if (state && typeof state.last_chunk_index === 'number') {
            lastChunkIndex = state.last_chunk_index;
        }
    }

    // Fetch already indexed chunk indexes from DB
    const { chunkIndexes: existingChunkIndexes, versionMismatch } = await getExistingChunkIndexes(supabaseUrl, supabaseAnonKey, sourceId, activeVersion);

    const isAtomicReplace = versionMismatch || (existingChunkIndexes.size === 0 && lastChunkIndex === -1);

    const chunksToProcess = isAtomicReplace
        ? chunks
        : chunks.filter(c => {
            const idx = c.metadata?.chunk_index;
            return idx > lastChunkIndex && !existingChunkIndexes.has(idx);
        });

    if (chunksToProcess.length === 0) {
        console.log(`✓ All chunks for ${sourceType} ${sourceId} are already fully indexed. Skipping.`);
        return;
    }

    console.log(`Found ${chunksToProcess.length} chunks to process (out of ${chunks.length} total, isAtomicReplace: ${isAtomicReplace}) for ${sourceType} ${sourceId}.`);

    // Process chunk insertion in sequential transactional batches of 100
    const batchSize = 100;
    for (let i = 0; i < chunksToProcess.length; i += batchSize) {
        const batch = chunksToProcess.slice(i, i + batchSize);
        console.log(`Embedding and inserting batch ${i / batchSize + 1} (${batch.length} chunks) for ${sourceType} ${sourceId}`);

        const batchEmbeddings = await generateEmbeddingsForBatch(batch);

        await upsertKnowledgeEmbeddings({
            sourceType,
            sourceId,
            courseId,
            title,
            chunks: batch,
            embeddings: batchEmbeddings,
            isAtomicReplace: isAtomicReplace && (i === 0) // Atomic replace on the very first batch only
        });

        // Update the database last_chunk_index transition status (Requirement 7)
        if (sourceType === 'material') {
            const maxBatchIndex = Math.max(...batch.map(c => c.metadata?.chunk_index || 0));
            lastChunkIndex = maxBatchIndex;
            await upsertIndexingState(supabaseUrl, supabaseAnonKey, {
                material_id: sourceId,
                course_id: courseId,
                last_chunk_index: lastChunkIndex,
                status: 'embedding',
                current_step: 'embedding'
            });
        }
    }
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

  const lockKey = material_id ? `indexing_lock_${material_id}` : `indexing_lock_${course_id}`;
  const lockRequester = 'req_' + Math.random().toString(36).substring(2) + Date.now();

  try {
    // 1. Acquire Distributed Lock to prevent race conditions
    const acquireLockRes = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/acquire_indexing_lock`, {
      method: 'POST',
      headers: {
        'apikey': supabaseAnonKey,
        'Authorization': `Bearer ${supabaseAnonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_lock_key: lockKey,
        p_locked_by: lockRequester,
        p_lease_duration: '10 minutes'
      })
    });

    if (!acquireLockRes.ok) {
      throw new Error(`Lock acquisition failed with status ${acquireLockRes.status}`);
    }

    const acquired = await acquireLockRes.json();
    if (!acquired) {
      res.writeHead(409, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Indexing operation already in progress for this ${material_id ? 'material' : 'course'}. Please try again later.` }));
      return;
    }

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

    // Query existing embeddings using the optimized distinct RPC (Requirement 6)
    let existingCourses = new Set();
    let existingTopics = new Set();
    let existingLessons = new Set();

    try {
      const distinctRes = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/get_distinct_knowledge_sources`, {
        method: 'POST',
        headers: {
          'apikey': supabaseAnonKey,
          'Authorization': `Bearer ${supabaseAnonKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ p_course_id: course_id })
      });

      if (distinctRes.ok) {
        const existingEmbeds = await distinctRes.json();
        existingEmbeds.forEach(e => {
          if (e.source_type === 'course') existingCourses.add(e.source_id);
          else if (e.source_type === 'topic') existingTopics.add(e.source_id);
          else if (e.source_type === 'lesson') existingLessons.add(e.source_id);
        });
      } else {
        console.warn(`RPC get_distinct_knowledge_sources returned status: ${distinctRes.status}. Falling back to select.`);
        const embedsRes = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/knowledge_embeddings?course_id=eq.${course_id}&select=source_type,source_id`, {
          headers: { 'apikey': supabaseAnonKey, 'Authorization': `Bearer ${supabaseAnonKey}` }
        });
        const existingEmbeds = embedsRes.ok ? await embedsRes.json() : [];
        existingEmbeds.forEach(e => {
          if (e.source_type === 'course') existingCourses.add(e.source_id);
          else if (e.source_type === 'topic') existingTopics.add(e.source_id);
          else if (e.source_type === 'lesson') existingLessons.add(e.source_id);
        });
      }
    } catch (rpcErr) {
      console.error('Error fetching distinct knowledge sources:', rpcErr);
    }

    // Prepare list of asynchronous concurrent tasks for parallel execution (Requirement 4)
    const tasks = [];

    // 1. Index course info itself
    if (course && !existingCourses.has(course_id)) {
      tasks.push(async () => {
        console.log(`Indexing course info for course: ${course.title}`);
        await indexText({
          sourceType: 'course',
          sourceId: course_id,
          courseId: course_id,
          title: course.title,
          text: `Course Title: ${course.title}\nDescription: ${course.description || ''}\nSemester: ${course.semester || ''}`,
          supabaseUrl,
          supabaseAnonKey,
          payload
        });
      });
    }

    // 2. Index topics
    if (topics && Array.isArray(topics)) {
      for (const t of topics) {
        if (!existingTopics.has(t.id)) {
          tasks.push(async () => {
            console.log(`Indexing topic: ${t.title}`);
            await indexText({
              sourceType: 'topic',
              sourceId: t.id,
              courseId: course_id,
              title: t.title,
              text: `Topic Title: ${t.title}\nDescription: ${t.description || ''}`,
              supabaseUrl,
              supabaseAnonKey,
              payload
            });
          });
        }
      }
    }

    // 3. Index lessons
    if (lessons && Array.isArray(lessons)) {
      const topicsMap = {};
      if (topics && Array.isArray(topics)) {
        topics.forEach(t => {
          topicsMap[t.id] = t.title;
        });
      }

      for (const l of lessons) {
        if (!existingLessons.has(l.id)) {
          tasks.push(async () => {
            console.log(`Indexing lesson content for lesson: ${l.title}`);
            const content = l.content || '';
            const topicTitle = l.topic_id ? (topicsMap[l.topic_id] || '') : '';
            const topicContext = topicTitle ? ` (Topic: ${topicTitle})` : '';

            await indexText({
              sourceType: 'lesson',
              sourceId: l.id,
              courseId: course_id,
              title: `${l.title}${topicContext}`,
              text: content,
              supabaseUrl,
              supabaseAnonKey,
              payload
            });
          });
        }
      }
    }

    // 4. Index materials (using full robust state machine for PDFs and parallelized concurrency)
    if (materials && Array.isArray(materials)) {
      for (const m of materials) {
        tasks.push(async () => {
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
            let status = 'pending';
            let currentStep = 'none';
            let retryCount = 0;
            let timingLogs = {};
            let savedChunks = null;

            if (state) {
              extractedText = state.extracted_text || '';
              status = state.status || 'pending';
              currentStep = state.current_step || 'none';
              retryCount = state.retry_count || 0;
              timingLogs = state.timing_logs || {};
              savedChunks = state.chunks || null;
            }

            // If PDF file URL changed or no state exists, do a fresh start for this material
            if (!state || state.file_url !== fileUrl) {
              console.log(`Initializing fresh indexing state for PDF material: ${m.title}`);
              const deleteUrl = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/knowledge_embeddings?source_id=eq.${m.id}`;
              await fetch(deleteUrl, {
                method: 'DELETE',
                headers: {
                  'apikey': supabaseAnonKey,
                  'Authorization': `Bearer ${supabaseAnonKey}`
                }
              });

              extractedText = '';
              status = 'pending';
              currentStep = 'none';
              retryCount = 0;
              timingLogs = {};
              savedChunks = null;

              state = {
                material_id: m.id,
                course_id: course_id,
                file_url: fileUrl,
                extracted_text: null,
                chunks: null,
                status: 'pending',
                current_step: 'none',
                timing_logs: {},
                retry_count: 0,
                last_chunk_index: -1
              };
              await upsertIndexingState(supabaseUrl, supabaseAnonKey, state);
            }

            // If already completed, skip processing
            if (status === 'completed') {
              console.log(`✓ PDF material ${m.title} is already fully indexed. Skipping.`);
              return;
            }

            try {
              // Stage 1: Download & Text Extraction with Gemini-based Structural Segmentation (Requirement 8)
              if (savedChunks && Array.isArray(savedChunks) && savedChunks.length > 0) {
                console.log(`✓ Chunks already segmented and saved for ${m.title}. Skipping extraction.`);
              } else {
                console.log(`Starting PDF download and structured extraction for: ${m.title}`);
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
                          text: `Analyze this PDF document and perform complete structural segmentation. Break the document down into logical, coherent chunks based on chapters, sections, topics, weeks, lessons, definitions, examples, exercises, or general segments.

Output MUST be a valid JSON object matching the following schema:
{
  "chunks": [
    {
      "chapter": "Chapter name or empty string",
      "section": "Section name or empty string",
      "topic": "Topic name or empty string",
      "structure_type": "one of: chapter, section, topic, week, lesson, definition, example, exercise, segment",
      "content": "Verbatim extracted text content of this chunk"
    }
  ]
}

Strict requirements:
- Do not summarize or alter the text content; extract the verbatim document text.
- Ensure every chunk content is complete, coherent, and around 1000-2500 characters max. If a section is very long, split it into multiple chunks with the same hierarchy metadata.
- Output ONLY the raw JSON block. No conversational preamble, no markdown formatting.`
                        }
                      ]
                    }
                  ],
                  generationConfig: {
                    responseMimeType: 'application/json'
                  }
                };

                // Better PDF extraction retry logic using exponential backoff (Requirement 9)
                let response;
                let attempt = 0;
                const maxRetries = 5;
                const initialDelay = 2000;

                while (attempt < maxRetries) {
                  try {
                    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(requestBody)
                    });

                    if (response.ok) {
                      break;
                    }

                    if (response.status === 429 || response.status >= 500) {
                      attempt++;
                      if (attempt >= maxRetries) {
                        throw new Error(`Gemini PDF parse API failed after ${maxRetries} attempts with status ${response.status}: ${await response.text()}`);
                      }
                      const delay = initialDelay * Math.pow(2, attempt) + Math.random() * 1000;
                      console.warn(`Extraction failed with ${response.status}. Retrying in ${Math.round(delay)}ms...`);
                      await new Promise(resolve => setTimeout(resolve, delay));
                    } else {
                      throw new Error(`Non-retriable Gemini parse error: ${response.status} ${await response.text()}`);
                    }
                  } catch (err) {
                    attempt++;
                    if (attempt >= maxRetries) {
                      throw err;
                    }
                    const delay = initialDelay * Math.pow(2, attempt) + Math.random() * 1000;
                    console.warn(`Extraction error: ${err.message || err}. Retrying in ${Math.round(delay)}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                  }
                }

                const data = await response.json();
                const rawResult = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

                let parsedChunks = [];
                try {
                    const parsedJson = JSON.parse(rawResult.trim());
                    if (parsedJson && Array.isArray(parsedJson.chunks)) {
                        parsedChunks = parsedJson.chunks;
                    }
                } catch (parseErr) {
                    console.warn("Failed to parse structural JSON from Gemini. Falling back to plain text extraction.", parseErr);
                }

                if (parsedChunks.length > 0) {
                    extractedText = parsedChunks.map(c => c.content).join('\n\n');
                    savedChunks = parsedChunks;
                } else {
                    // Fallback to plain text extraction request (zero regression / robust fallback)
                    console.log("Using plain text extraction fallback...");
                    const fallbackRequestBody = {
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

                    const fallbackResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(fallbackRequestBody)
                    });

                    if (!fallbackResponse.ok) {
                      throw new Error(`Fallback Gemini PDF Parse Error: ${await fallbackResponse.text()}`);
                    }
                    const fallbackData = await fallbackResponse.json();
                    extractedText = fallbackData.candidates?.[0]?.content?.parts?.[0]?.text || '';
                    savedChunks = null;
                }

                if (!extractedText || extractedText.trim().length === 0) {
                  throw new Error("Gemini extracted zero text from this PDF document.");
                }

                timingLogs.extraction = Date.now() - extStart;
                status = 'extracted';
                currentStep = 'extraction';

                state = {
                    ...state,
                    extracted_text: extractedText,
                    chunks: savedChunks,
                    status,
                    current_step: currentStep,
                    timing_logs: timingLogs
                };
                await upsertIndexingState(supabaseUrl, supabaseAnonKey, state);
                console.log(`✓ Extraction completed for ${m.title} in ${timingLogs.extraction}ms`);
              }

              // Stage 2 & 3: Chunk, Embed and Store
              console.log(`Indexing text/chunks for PDF: ${m.title}`);
              const indexStart = Date.now();

              await upsertIndexingState(supabaseUrl, supabaseAnonKey, {
                  ...state,
                  status: 'embedding',
                  current_step: 'embedding'
              });

              await indexText({
                  sourceType: 'material',
                  sourceId: m.id,
                  courseId: course_id,
                  title: m.title,
                  text: extractedText,
                  chunkOptions: payload.chunk_options,
                  supabaseUrl,
                  supabaseAnonKey,
                  payload,
                  geminiChunks: savedChunks
              });

              timingLogs.embedding = Date.now() - indexStart;
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
          } else {
            // Fallback to title and description for non-PDFs
            console.log(`Indexing metadata for non-PDF material: ${m.title}`);
            await indexText({
              sourceType: 'material',
              sourceId: m.id,
              courseId: course_id,
              title: m.title,
              text: `Material Title: ${m.title}\nDescription: ${m.description || ''}`,
              supabaseUrl,
              supabaseAnonKey,
              payload
            });
          }
        });
      }
    }

    // Execute all tasks in parallel using the bounded concurrency pool to respect API rate limits (Requirement 4)
    await parallelLimit(tasks, 4, async (task) => await task());

    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: `Successfully completed indexing for course ${course_id}` }));

  } catch (error) {
    console.error('Indexing failed:', error);
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message || String(error) }));
  } finally {
    // Safely release the distributed lock under all conditions
    try {
      await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/release_indexing_lock`, {
        method: 'POST',
        headers: {
          'apikey': supabaseAnonKey,
          'Authorization': `Bearer ${supabaseAnonKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          p_lock_key: lockKey,
          p_locked_by: lockRequester
        })
      });
    } catch (releaseErr) {
      console.warn('Failed to release indexing distributed lock:', releaseErr);
    }
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
