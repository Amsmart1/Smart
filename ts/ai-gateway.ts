// Supabase Edge Function: ai-gateway
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-session-id, x-supabase-signature',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');

    if (!supabaseUrl) throw new Error('Missing environment variable: SUPABASE_URL');
    if (!supabaseAnonKey) throw new Error('Missing environment variable: SUPABASE_ANON_KEY');

    // Secure private gateway secret key for backend-to-backend communication
    // Falls back to SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY if not explicitly defined
    const gatewaySecret = Deno.env.get('AI_GATEWAY_SECRET') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || supabaseAnonKey;

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

    // Secure, non-SSRF target Vercel URL configuration
    // Load exclusively from backend environment variables to prevent token/signature theft
    const vercelProjectUrl = Deno.env.get('VERCEL_PROJECT_URL');
    if (!vercelProjectUrl) {
      throw new Error('Missing environment variable: VERCEL_PROJECT_URL');
    }

    const cleanBaseUrl = vercelProjectUrl.replace(/\/$/, '');
    const vercelTarget = `${cleanBaseUrl}/api/ai-gateway`;

    // Process materials / semantic search directly in Supabase RAG before Vercel call
    let vercelPayload = { ...payload };

    if (type === 'tutor') {
      const { course_id, message } = payload;
      const embeddingResponse = await fetch(vercelTarget, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-supabase-signature': gatewaySecret
        },
        body: JSON.stringify({
          type: 'generate_embedding',
          payload: { text: message }
        })
      });

      if (!embeddingResponse.ok) {
        throw new Error(`Embedding Proxy failed: ${await embeddingResponse.text()}`);
      }

      const embeddingResult = await embeddingResponse.json();
      const userMessageEmbedding = embeddingResult.embedding;

      // Perform Semantic Search using match_materials RPC
      const { data: matches, error: matchError } = await supabaseClient.rpc('match_materials', {
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
          context = matches.map((m: any) => m.content).join('\n---\n');
      } else {
          // Fallback to basic retrieval if no semantic matches (e.g., Knowledge Base not indexed)
          const [{ data: materials }, { data: lessons }] = await Promise.all([
              supabaseClient.from('materials').select('title, description').eq('course_id', course_id).limit(5),
              supabaseClient.from('lessons').select('title, content').eq('course_id', course_id).limit(5)
          ]);

          // Safe fallbacks for materials and lessons to prevent mapping errors if null
          context = [
              ...(materials || []).map((m: any) => `Material: ${m.title} - ${m.description}`),
              ...(lessons || []).map((l: any) => `Lesson: ${l.title}\nContent: ${l.content}`)
          ].join('\n\n');
      }

      vercelPayload.context = context;
    } else if (type === 'index_course') {
      const { course_id } = payload;
      if (!course_id) throw new Error('course_id is required');

      // Idempotency: Delete existing embeddings for this course before re-indexing
      const { error: deleteError } = await supabaseClient.from('material_embeddings').delete().eq('course_id', course_id);
      if (deleteError) throw new Error(`Failed to clear existing index: ${deleteError.message}`);

      // Fetch all materials and lessons for the course
      const [{ data: materials }, { data: lessons }] = await Promise.all([
          supabaseClient.from('materials').select('id, title, description').eq('course_id', course_id),
          supabaseClient.from('lessons').select('id, title, content').eq('course_id', course_id)
      ]);

      const chunks: any[] = [];

      materials?.forEach((m: any) => {
          chunks.push({
              material_id: m.id,
              course_id: course_id,
              content: `Material Title: ${m.title}\nDescription: ${m.description}`,
              metadata: { type: 'material', title: m.title }
          });
      });

      lessons?.forEach((l: any) => {
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

      // Process in batches of 10
      const batchSize = 10;
      for (let i = 0; i < chunks.length; i += batchSize) {
          const batch = chunks.slice(i, i + batchSize);
          const embeddingResponse = await fetch(vercelTarget, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-supabase-signature': gatewaySecret
            },
            body: JSON.stringify({
              type: 'generate_batch_embeddings',
              payload: { texts: batch.map(c => c.content) }
            })
          });

          if (!embeddingResponse.ok) {
            throw new Error(`Batch Embedding Proxy failed: ${await embeddingResponse.text()}`);
          }

          const embeddingResult = await embeddingResponse.json();
          const embeddings = embeddingResult.embeddings;

          const records = batch.map((chunk, idx) => ({
              ...chunk,
              embedding: embeddings[idx]
          }));

          const { error } = await supabaseClient.from('material_embeddings').insert(records);
          if (error) throw error;
      }

      return new Response(JSON.stringify({ success: true, message: `Successfully indexed ${chunks.length} chunks for course ${course_id}` }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
      });
    }

    // Attach verified user identity from DB to payload for context tracking
    vercelPayload.email = userEmail;
    vercelPayload.role = userRole;

    // Forward the fully validated & authorized request to Vercel to do the Gemini API calls
    const vercelResponse = await fetch(vercelTarget, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-supabase-signature': gatewaySecret
      },
      body: JSON.stringify({
        type,
        payload: vercelPayload
      })
    });

    if (!vercelResponse.ok) {
      throw new Error(`Vercel downstream service returned ${vercelResponse.status}: ${await vercelResponse.text()}`);
    }

    const vercelData = await vercelResponse.json();

    return new Response(JSON.stringify(vercelData), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error: any) {
    const errorMsg = error instanceof Error ? error.message : (error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error));
    console.error('AI Gateway Error:', errorMsg);
    const status = errorMsg.includes('Authentication') ? 401 :
                   errorMsg.includes('Unauthorized') || errorMsg.includes('Access Denied') ? 403 : 500;

    return new Response(JSON.stringify({
        error: errorMsg,
        timestamp: new Date().toISOString(),
        type: 'ai_gateway_error'
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: status,
    });
  }
})
