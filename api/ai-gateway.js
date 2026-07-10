// Vercel Serverless Function: api/ai-gateway.js
// Handles downstream Gemini API content generation & embeddings.
// Keeps secret keys secured inside the Vercel environment.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-session-id, x-supabase-signature',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
};

module.exports = async function handler(req, res) {
  console.log("AI Gateway Request:", {
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

      // 1. Generate embedding for user message
      const apiKey = process.env.GEMINI_EMBEDDING_API_KEY;
      let context = '';

      if (apiKey) {
        try {
          const embedRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: "models/text-embedding-004",
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

  Strict Academic Guardrails:
  - You have absolutely NO access to quizzes, exams, assignments, student submissions, or grades.
  - If a student asks about their grades, specific assignment answers, quiz solutions, or submission statuses, you MUST politely explain that you do not have access to that information and can only assist them in learning and understanding the course concepts, lessons, and materials.
  - Do not make up answers. If the information is not in the context, guide the student based on general academic principles related to the topic, but prioritize course-specific info.

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

  const prompt = `Generate a ${type} with ${count} questions about "${topic}".
  Difficulty level: ${difficulty}.
  ${rubrics ? `Follow these rubrics: ${rubrics}` : ''}

  Output MUST be a valid JSON array of question objects matching the SmartLMS schema.
  ${schemaPrompt}

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

  Please evaluate this student submission carefully and professionally.
  Provide a detailed Markdown report containing the following sections:
  1. **Question-by-Question Evaluation**: For each question, provide a suggested score out of its maximum points, brief critique, and helpful feedback.
  2. **Rubric Scoring Analysis**: Break down how the student's work aligns with and meets the specified rubric criteria.
  3. **Overall Feedback & Recommendation**: A final, constructive overall summary highlighting strengths and key areas for improvement, alongside a recommended total score out of the total possible points.`;

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

  return callGemini(apiKey, prompt, systemPrompt, [], res);
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

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`, {
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
