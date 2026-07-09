// Supabase Edge Function: ai-gateway
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-session-id',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');

    if (!supabaseUrl) throw new Error('Missing environment variable: SUPABASE_URL');
    if (!supabaseAnonKey) throw new Error('Missing environment variable: SUPABASE_ANON_KEY');

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { 'x-session-id': req.headers.get('x-session-id') || '' }
      }
    });

    const { type, payload } = await req.json();

    if (!type || !payload) {
      return new Response(JSON.stringify({ error: 'Missing request type or payload' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      });
    }

    // Enterprise Grade Authorization: Use the existing identity system via DB RPC.
    // This avoids duplicated authentication and inconsistent session validation.
    // We inject the session ID into the RPC call via headers which are handled by the DB.

    // To allow the RPC to identify the user, we must set the session context in the client.
    // In Edge Functions using service_role, we simulate the user context for the RPC call.
    const { data: authContext, error: authError } = await supabaseClient.rpc('get_ai_access_context', {
        p_operation_type: type,
        p_payload: payload
    });

    if (authError) {
        throw new Error(`Authorization RPC failed: ${authError.message}`);
    }

    // Explicit null check for authContext to prevent runtime exceptions
    if (!authContext) {
        throw new Error('Authorization RPC returned no context');
    }

    if (!authContext.authorized) {
        return new Response(JSON.stringify({ error: authContext.error || 'Unauthorized' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: authContext.error === 'Authentication required' ? 401 : 403,
        });
    }

    const { email: userEmail, role: userRole } = authContext;

    // Feature Routing (RBAC/ABAC already verified by RPC)
    switch (type) {
      case 'platform_assistant':
        return await handlePlatformAssistant(payload);

      case 'tutor':
        return await handleCourseTutor(userEmail, userRole, payload, supabaseClient);

      case 'index_course':
        return await handleIndexCourse(userEmail, userRole, payload, supabaseClient);

      case 'generate_assessment':
        return await handleAssessmentGenerator(userEmail, userRole, payload, supabaseClient);

      case 'grading':
        return await handleGradingAssistant(userEmail, userRole, payload, supabaseClient);

      case 'analytics':
        return await handleAnalyticsAI(userEmail, userRole, payload, supabaseClient);

      default:
        return new Response(JSON.stringify({ error: `Unsupported AI operation: ${type}` }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        });
    }

  } catch (error) {
    console.error('AI Gateway Error:', error.message);
    const status = error.message.includes('Authentication') ? 401 :
                   error.message.includes('Unauthorized') || error.message.includes('Access Denied') ? 403 : 500;

    return new Response(JSON.stringify({
        error: error.message,
        timestamp: new Date().toISOString(),
        type: 'ai_gateway_error'
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: status,
    });
  }
})

/**
 * Feature 1 & 6: Course-aware Tutor with Semantic Search (RAG)
 */
async function handleCourseTutor(email, role, payload, supabase) {
    const { course_id, message, history = [] } = payload;
    // Note: Verification of enrollment already performed by DB RPC

    // 1. Generate embedding for the user's message
    const embeddingApiKey = Deno.env.get('GEMINI_EMBEDDING_API_KEY');
    const userMessageEmbedding = await generateEmbedding(embeddingApiKey, message);

    // 2. Perform Semantic Search using match_materials RPC
    const { data: matches, error: matchError } = await supabase.rpc('match_materials', {
        query_embedding: userMessageEmbedding,
        match_threshold: 0.3, // Tunable
        match_count: 5,
        p_course_id: course_id
    });

    if (matchError) {
        console.warn('Semantic search failed, falling back to basic retrieval:', matchError.message);
    }

    let context = '';
    if (matches && matches.length > 0) {
        context = matches.map(m => m.content).join('\n---\n');
    } else {
        // Fallback to basic retrieval if no semantic matches (e.g., Knowledge Base not indexed)
        const [{ data: materials }, { data: lessons }] = await Promise.all([
            supabase.from('materials').select('title, description').eq('course_id', course_id).limit(5),
            supabase.from('lessons').select('title, content').eq('course_id', course_id).limit(5)
        ]);

        // Safe fallbacks for materials and lessons to prevent mapping errors if null
        context = [
            ...(materials || []).map(m => `Material: ${m.title} - ${m.description}`),
            ...(lessons || []).map(l => `Lesson: ${l.title}\nContent: ${l.content}`)
        ].join('\n\n');
    }

    const apiKey = Deno.env.get('GEMINI_COURSE_TUTOR_API_KEY');
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

    return callGemini(apiKey, message, systemPrompt, history);
}

/**
 * Feature 6: Knowledge Base Indexing (Chunking & Embedding)
 */
async function handleIndexCourse(email, role, payload, supabase) {
    const { course_id } = payload;
    if (!course_id) throw new Error('course_id is required');

    // 1. Idempotency: Delete existing embeddings for this course before re-indexing
    const { error: deleteError } = await supabase.from('material_embeddings').delete().eq('course_id', course_id);
    if (deleteError) throw new Error(`Failed to clear existing index: ${deleteError.message}`);

    // 2. Fetch all materials and lessons for the course
    const [{ data: materials }, { data: lessons }] = await Promise.all([
        supabase.from('materials').select('id, title, description').eq('course_id', course_id),
        supabase.from('lessons').select('id, title, content').eq('course_id', course_id)
    ]);

    const chunks = [];

    materials?.forEach(m => {
        chunks.push({
            material_id: m.id,
            course_id: course_id,
            content: `Material Title: ${m.title}\nDescription: ${m.description}`,
            metadata: { type: 'material', title: m.title }
        });
    });

    lessons?.forEach(l => {
        // Simple chunking: if content is large, split it. For now, we take whole lesson or chunks of 2000 chars
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
        return new Response(JSON.stringify({ message: 'No content to index for this course.' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        });
    }

    const embeddingApiKey = Deno.env.get('GEMINI_EMBEDDING_API_KEY');

    // Process in batches of 10 to avoid Gemini/Supabase limits
    const batchSize = 10;
    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const embeddings = await generateBatchEmbeddings(embeddingApiKey, batch.map(c => c.content));

        const records = batch.map((chunk, idx) => ({
            ...chunk,
            embedding: embeddings[idx]
        }));

        const { error } = await supabase.from('material_embeddings').insert(records);
        if (error) throw error;
    }

    return new Response(JSON.stringify({ success: true, message: `Successfully indexed ${chunks.length} chunks for course ${course_id}` }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
    });
}

/**
 * Gemini Embedding Generator
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
 * Feature 2: Assessment Generator
 */
async function handleAssessmentGenerator(email, role, payload, supabase) {
    const { topic, type, count, difficulty, rubrics } = payload;
    const apiKey = Deno.env.get('GEMINI_ASSESSMENT_API_KEY');

    const prompt = `Generate a ${type} with ${count} questions about "${topic}".
    Difficulty level: ${difficulty}.
    ${rubrics ? `Follow these rubrics: ${rubrics}` : ''}
    Output MUST be a valid JSON array of question objects matching the SmartLMS schema.
    Wrap your JSON response in \`\`\`json [CODE] \`\`\` markers.`;

    const systemPrompt = `You are an expert curriculum designer and assessment generator.
    Generating for Teacher: ${email}
    Role: ${role}
    You output only valid JSON.`;
    return callGemini(apiKey, prompt, systemPrompt);
}

/**
 * Feature 3: Grading Assistant
 */
async function handleGradingAssistant(email, role, payload, supabase) {
    const { assignment_title, student_submission, rubric, questions } = payload;
    const apiKey = Deno.env.get('GEMINI_GRADING_API_KEY');

    const prompt = `Assignment: ${assignment_title}
    Rubric: ${rubric}
    Questions: ${JSON.stringify(questions)}
    Student Work: ${student_submission}

    Provide a detailed critique, suggested scores per question, and overall feedback for the student.`;

    const systemPrompt = `You are a fair and insightful teaching assistant.
    Assisting Teacher: ${email}
    Role: ${role}
    Help the teacher grade by providing insights based on the rubric.`;
    return callGemini(apiKey, prompt, systemPrompt);
}

/**
 * Feature 4: Role-based Analytics
 */
async function handleAnalyticsAI(email, role, payload, supabase) {
    const { analytics_data, question } = payload;
    const apiKey = Deno.env.get('GEMINI_ANALYTICS_API_KEY');

    const prompt = `My Role: ${role}
    My Identity: ${email}
    Analytics Data: ${JSON.stringify(analytics_data)}
    Question: ${question}

    Analyze the data and provide actionable insights, trends, and risk predictions.`;

    const systemPrompt = "You are a senior educational data analyst. You provide deep insights from LMS performance data.";
    return callGemini(apiKey, prompt, systemPrompt);
}

/**
 * Feature 5: LMS UI Feature Assistant (Kofi AI)
 */
async function handlePlatformAssistant(payload) {
    const { message, history = [] } = payload;
    const apiKey = Deno.env.get('GEMINI_PLATFORM_API_KEY');

    const systemPrompt = `You are "Kofi AI", the professional guide for the SmartLMS platform.
    Your mission is to help visitors and users understand and navigate the platform's features.

    Key Platform Features you should highlight when relevant:
    1. Proctored Assessments: Maintain academic integrity with advanced anti-cheat monitoring, real-time integrity alerts, and detailed violation reports.
    2. Live Virtual Classes: Engage in real-time with integrated meeting tools and automated attendance tracking.
    3. Verified Certification: Earn and share secure, verifiable certificates of completion for your courses.
    4. Advanced Analytics: Track progress with detailed visual reports, automated grading, and AI-driven risk predictions.
    5. Interactive Discussions: Collaborate with peers and teachers through course-specific discussion boards.

    Important Constraints:
    - You have NO access to personal student data, grades, or private course content.
    - You cannot perform administrative actions like enrollment, account deletion, or password resets.
    - For support issues beyond navigation, direct users to the "Help Center" or "Contact Us" pages.
    - Keep responses professional, friendly, and concise.
    - Use markdown for formatting (bullet points for features, bold for emphasis).`;

    return callGemini(apiKey, message, systemPrompt, history);
}

/**
 * Generic Gemini API Caller
 */
async function callGemini(apiKey, prompt, systemInstruction, history = []) {
    if (!apiKey) throw new Error('Gemini API Key not configured in environment');

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
        throw new Error(`Gemini API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    // Standardize response format for LMS client
    const aiResponse = {
        content: data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from AI.',
        raw: data
    };

    return new Response(JSON.stringify(aiResponse), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
    });
}
