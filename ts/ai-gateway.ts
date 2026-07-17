// Supabase Edge Function: ai-gateway
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-session-id, x-supabase-signature',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
}

async function parallelLimit<T, R>(
  items: T[],
  concurrency: number,
  processor: (item: T) => Promise<R>
): Promise<R[]> {
  const results: Promise<R>[] = [];
  const executing = new Set<Promise<R>>();

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

async function getIndexingState(supabaseClient: any, materialId: string) {
  try {
    const { data } = await supabaseClient
      .from('material_indexing_states')
      .select('*')
      .eq('material_id', materialId)
      .maybeSingle();
    return data || null;
  } catch (err) {
    console.error(`Error fetching indexing state for ${materialId}:`, err);
  }
  return null;
}

async function upsertIndexingState(supabaseClient: any, state: any) {
  try {
    await supabaseClient
      .from('material_indexing_states')
      .upsert(state);
  } catch (err) {
    console.error(`Error upserting indexing state for ${state.material_id}:`, err);
  }
}

async function getExistingChunkIndexes(supabaseClient: any, materialId: string) {
  try {
    const { data } = await supabaseClient
      .from('knowledge_embeddings')
      .select('metadata')
      .eq('source_id', materialId);
    if (data) {
      return new Set(data.map((d: any) => d.metadata?.chunk_index).filter((idx: any) => idx !== undefined && idx !== null));
    }
  } catch (err) {
    console.error(`Error fetching existing chunk indexes for ${materialId}:`, err);
  }
  return new Set();
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
    supabaseClient = null,
    vercelTarget = null,
    gatewaySecret = null
}: {
    sourceType: string;
    sourceId: string;
    courseId: string;
    title: string;
    text: string;
    chunkOptions?: string[] | null;
    supabaseClient?: any;
    vercelTarget?: string | null;
    gatewaySecret?: string | null;
}) {

    const normalizeText = (t: string) => {
        return t ? t.trim() : '';
    };

    const chunkText = (normalizedText: string) => {
        if (sourceType === 'lesson') {
            const chunkSize = 2000;
            const localChunks = [];
            for (let i = 0; i < normalizedText.length; i += chunkSize) {
                localChunks.push({
                    content: `Lesson Title: ${title}\nContent Chunk: ${normalizedText.substring(i, i + chunkSize)}`,
                    metadata: { type: 'lesson', title: title, chunk_index: Math.floor(i / chunkSize) }
                });
            }
            return localChunks;
        } else if (sourceType === 'material') {
            const allowedOptions = chunkOptions || ['chapter', 'chapters', 'section', 'sections', 'topic', 'topics', 'week', 'weeks', 'lesson', 'lessons'];
            const optionsPattern = allowedOptions.map(opt => opt.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
            const boundaryRegex = new RegExp(`(?:\\r?\\n|^)(?=(?:${optionsPattern})\\s+(?:[0-9]+|[a-z]+|[ivxldm]+)\\b|\\r?\\n{2,}(?=[a-z\\s]{3,100}:))`, 'i');
            const rawSegments = normalizedText.split(boundaryRegex).map(s => s.trim()).filter(s => s.length > 0);
            const parsedChunks: string[] = [];

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
                    content: `Document: ${title}\nStructure: ${structureType.toUpperCase()}\nContent Segment:\n${chunkText}`,
                    metadata: {
                        type: 'material_pdf',
                        title: title,
                        chunk_index: chunkIndex++,
                        structure_type: structureType
                    }
                });
            }
            return localChunks;
        } else {
            // Course or topic or fallback generic
            const chunkSize = 2000;
            const localChunks = [];
            for (let i = 0; i < normalizedText.length; i += chunkSize) {
                localChunks.push({
                    content: normalizedText.substring(i, i + chunkSize),
                    metadata: { type: sourceType, title: title, chunk_index: Math.floor(i / chunkSize) }
                });
            }
            return localChunks;
        }
    };

    const generateEmbeddings = async (chunks: any[]) => {
        if (chunks.length === 0) return [];
        const batchSize = 10;
        const batches = [];
        for (let i = 0; i < chunks.length; i += batchSize) {
            batches.push(chunks.slice(i, i + batchSize));
        }

        const batchResults = await parallelLimit(batches, 4, async (batch) => {
            const embeddingResponse = await fetch(vercelTarget!, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-supabase-signature': gatewaySecret!
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
            return embeddingResult.embeddings;
        });

        return batchResults.flat();
    };

    const upsertKnowledgeEmbeddings = async ({
        sourceType,
        sourceId,
        courseId,
        title,
        chunks,
        embeddings
    }: {
        sourceType: string;
        sourceId: string;
        courseId: string;
        title: string;
        chunks: any[];
        embeddings: any[];
    }) => {
        if (chunks.length === 0) return;
        const records = chunks.map((chunk, idx) => ({
            source_type: sourceType,
            source_id: sourceId,
            course_id: courseId,
            content: chunk.content,
            embedding: embeddings[idx],
            metadata: chunk.metadata,
            material_id: sourceType === 'material' ? sourceId : null,
            lesson_id: sourceType === 'lesson' ? sourceId : null
        }));

        const { error } = await supabaseClient.from('knowledge_embeddings').insert(records);
        if (error) throw error;
    };

    const normalizedText = normalizeText(text);

    const chunks = chunkText(normalizedText);

    const embeddings = await generateEmbeddings(chunks);

    await upsertKnowledgeEmbeddings({
        sourceType,
        sourceId,
        courseId,
        title,
        chunks,
        embeddings
    });
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
    // Never fall back to SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY if not explicitly defined
    const gatewaySecret = Deno.env.get('AI_GATEWAY_SECRET');

    if (!gatewaySecret) {
      throw new Error('Missing environment variable: AI_GATEWAY_SECRET');
    }
    const { type, payload } = await req.json();

    if (!type || !payload) {
      return new Response(JSON.stringify({ error: 'Missing request type or payload' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      });
    }

    // Enforce robust identity resolution: support both HTTP header and JSON body payload session_id
    const sessionId = req.headers.get('x-session-id') || payload?.session_id || payload?.sessionId || '';

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { 'x-session-id': sessionId }
      }
    });

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

      // Query course title to ensure the tutor is course-aware of its own subject and title
      let courseTitle = '';
      try {
          const { data: courseData } = await supabaseClient.from('courses').select('title').eq('id', course_id).maybeSingle();
          if (courseData) {
              courseTitle = courseData.title;
          }
      } catch (e) {
          console.warn('Failed to query course title in Edge Function:', e);
      }
      vercelPayload.course_title = courseTitle;

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

      // Perform Semantic Search using match_knowledge RPC
      const { data: matches, error: matchError } = await supabaseClient.rpc('match_knowledge', {
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
          const formattedMatches = matches.map((m: any) => ({
              source_type: m.source_type || 'material',
              content: m.content
          }));
          context = JSON.stringify(formattedMatches, null, 2);
      } else {
          // Fallback to basic retrieval if no semantic matches (e.g., Knowledge Base not indexed)
          const [
              { data: materials },
              { data: lessons },
              { data: topics },
              { data: course }
          ] = await Promise.all([
              supabaseClient.from('materials').select('title, description').eq('course_id', course_id).limit(5),
              supabaseClient.from('lessons').select('title, content').eq('course_id', course_id).limit(5),
              supabaseClient.from('topics').select('title, description').eq('course_id', course_id).limit(5),
              supabaseClient.from('courses').select('title, description, semester').eq('id', course_id).maybeSingle()
          ]);

          const fallbackList = [];
          if (course) {
              fallbackList.push({
                  source_type: "course",
                  content: `Course Title: ${course.title}\nDescription: ${course.description || ''}\nSemester: ${course.semester || ''}`
              });
          }
          (topics || []).forEach((t: any) => {
              fallbackList.push({
                  source_type: "topic",
                  content: `Topic: ${t.title}\nDescription: ${t.description || ''}`
              });
          });
          (materials || []).forEach((m: any) => {
              fallbackList.push({
                  source_type: "material",
                  content: `Material: ${m.title}\nDescription: ${m.description || ''}`
              });
          });
          (lessons || []).forEach((l: any) => {
              fallbackList.push({
                  source_type: "lesson",
                  content: `Lesson: ${l.title}\nContent: ${l.content || ''}`
              });
          });

          context = JSON.stringify(fallbackList, null, 2);
      }

      vercelPayload.context = context;
    } else if (type === 'index_course') {
      const { course_id, material_id } = payload;
      if (!course_id) throw new Error('course_id is required');

      let materials: any[] = [];
      let lessons: any[] = [];
      let topics: any[] = [];
      let course: any = null;

      if (material_id) {
          // Indexing a single, specific material
          const { data: mats, error: matsErr } = await supabaseClient
              .from('materials')
              .select('id, title, description, file_url, file_type')
              .eq('id', material_id);
          if (matsErr) throw new Error(`Failed to fetch material: ${matsErr.message}`);
          materials = mats || [];
      } else {
          // Fetch everything for course-level indexing
          const [
              { data: mats },
              { data: les },
              { data: tops },
              { data: crs }
          ] = await Promise.all([
              supabaseClient.from('materials').select('id, title, description, file_url, file_type').eq('course_id', course_id),
              supabaseClient.from('lessons').select('id, title, content, topic_id').eq('course_id', course_id),
              supabaseClient.from('topics').select('id, title, description').eq('course_id', course_id),
              supabaseClient.from('courses').select('title, description, semester').eq('id', course_id).maybeSingle()
          ]);
          materials = mats || [];
          lessons = les || [];
          topics = tops || [];
          course = crs;
      }

      // Query existing embeddings from knowledge_embeddings for this course to avoid duplicate work
      const { data: existingEmbeds, error: embedsErr } = await supabaseClient
          .from('knowledge_embeddings')
          .select('source_type, source_id')
          .eq('course_id', course_id);

      const existingEmbedsList = !embedsErr && existingEmbeds ? existingEmbeds : [];
      const existingCourses = new Set(existingEmbedsList.filter((e: any) => e.source_type === 'course').map((e: any) => e.source_id));
      const existingTopics = new Set(existingEmbedsList.filter((e: any) => e.source_type === 'topic').map((e: any) => e.source_id));
      const existingLessons = new Set(existingEmbedsList.filter((e: any) => e.source_type === 'lesson').map((e: any) => e.source_id));

      // 1. Index course info itself (only if course-level indexing)
      if (course && !existingCourses.has(course_id)) {
          console.log(`Indexing course info for course: ${course.title}`);
          await indexText({
              sourceType: 'course',
              sourceId: course_id,
              courseId: course_id,
              title: course.title,
              text: `Course Title: ${course.title}\nDescription: ${course.description || ''}\nSemester: ${course.semester || ''}`,
              supabaseClient,
              vercelTarget,
              gatewaySecret
          });
      }

      // 2. Index topics (only if course-level indexing)
      if (topics && topics.length > 0) {
          for (const t of topics) {
              if (!existingTopics.has(t.id)) {
                  console.log(`Indexing topic: ${t.title}`);
                  await indexText({
                      sourceType: 'topic',
                      sourceId: t.id,
                      courseId: course_id,
                      title: t.title,
                      text: `Topic Title: ${t.title}\nDescription: ${t.description || ''}`,
                      supabaseClient,
                      vercelTarget,
                      gatewaySecret
                  });
              }
          }
      }

      // 3. Index lessons (only if course-level indexing)
      if (lessons && lessons.length > 0) {
          // Build topics map for lookup
          const topicsMap: Record<string, string> = {};
          if (topics) {
              topics.forEach((t: any) => {
                  topicsMap[t.id] = t.title;
              });
          }

          for (const l of lessons) {
              if (!existingLessons.has(l.id)) {
                  console.log(`Indexing lesson: ${l.title}`);
                  const content = l.content || '';
                  const topicTitle = l.topic_id ? (topicsMap[l.topic_id] || '') : '';
                  const topicContext = topicTitle ? ` (Topic: ${topicTitle})` : '';

                  await indexText({
                      sourceType: 'lesson',
                      sourceId: l.id,
                      courseId: course_id,
                      title: `${l.title}${topicContext}`,
                      text: content,
                      supabaseClient,
                      vercelTarget,
                      gatewaySecret
                  });
              }
          }
      }

      if (materials) {
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
                  let state = await getIndexingState(supabaseClient, m.id);

                  let extractedText = '';
                  let status = 'pending';
                  let currentStep = 'none';
                  let retryCount = 0;
                  let timingLogs: Record<string, number> = {};

                  if (state) {
                      extractedText = state.extracted_text || '';
                      status = state.status || 'pending';
                      currentStep = state.current_step || 'none';
                      retryCount = state.retry_count || 0;
                      timingLogs = state.timing_logs || {};
                  }

                  // If PDF file URL changed or no state exists, do a fresh start for this material
                  if (!state || state.file_url !== fileUrl) {
                      console.log(`Initializing fresh indexing state for PDF material: ${m.title}`);
                      // Delete existing embeddings for this material
                      const { error: deleteError } = await supabaseClient
                          .from('knowledge_embeddings')
                          .delete()
                          .eq('source_id', m.id);
                      if (deleteError) throw new Error(`Failed to clear existing material index: ${deleteError.message}`);

                      extractedText = '';
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
                      await upsertIndexingState(supabaseClient, state);
                  }

                  // If already completed, skip processing
                  if (status === 'completed') {
                      console.log(`✓ PDF material ${m.title} is already fully indexed. Skipping.`);
                      continue;
                  }

                  try {
                      // Stage 1: Download & Text Extraction
                      if (extractedText && (status === 'extracted' || status === 'completed')) {
                          console.log(`✓ PDF text already extracted for ${m.title}. Skipping extraction.`);
                      } else {
                          console.log(`Starting PDF download and extraction for: ${m.title}`);
                          const extStart = Date.now();

                          await upsertIndexingState(supabaseClient, {
                              ...state,
                              status: 'extracting',
                              current_step: 'extraction'
                          });

                          // Call the Vercel helper to extract PDF text
                          const extractResponse = await fetch(vercelTarget!, {
                              method: 'POST',
                              headers: {
                                  'Content-Type': 'application/json',
                                  'x-supabase-signature': gatewaySecret!
                              },
                              body: JSON.stringify({
                                  type: 'extract_pdf_text',
                                  payload: { file_url: fileUrl, course_id, material_id: m.id }
                              })
                          });

                          if (!extractResponse.ok) {
                              throw new Error(`Text extraction service returned status ${extractResponse.status}: ${await extractResponse.text()}`);
                          }

                          const extractResult = await extractResponse.json();
                          if (extractResult.error) {
                              throw new Error(extractResult.error);
                          }

                          extractedText = extractResult.text || '';
                          if (extractedText.trim().length === 0) {
                              throw new Error("No text content could be extracted from this PDF.");
                          }

                          timingLogs.extraction = Date.now() - extStart;
                          status = 'extracted';
                          currentStep = 'extraction';

                          await upsertIndexingState(supabaseClient, {
                              ...state,
                              extracted_text: extractedText,
                              status,
                              current_step: currentStep,
                              timing_logs: timingLogs
                          });
                          console.log(`✓ Extraction completed for ${m.title} in ${timingLogs.extraction}ms`);
                      }

                      // Stage 2 & 3: Chunk, Embed and Store using shared indexText()
                      console.log(`Indexing text for PDF: ${m.title}`);
                      const indexStart = Date.now();

                      await upsertIndexingState(supabaseClient, {
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
                          supabaseClient,
                          vercelTarget,
                          gatewaySecret
                      });

                      timingLogs.embedding = Date.now() - indexStart;
                      timingLogs.total = Date.now() - mStart;
                      status = 'completed';
                      currentStep = 'completed';

                      await upsertIndexingState(supabaseClient, {
                          ...state,
                          status,
                          current_step: currentStep,
                          error_message: null,
                          timing_logs: timingLogs
                      });
                      console.log(`✓ Indexing successfully completed for PDF material ${m.title} in ${timingLogs.total}ms!`);

                  } catch (materialError: any) {
                      console.error(`Error during processing material ${m.title}:`, materialError);
                      const errStr = materialError.message || String(materialError);

                      await upsertIndexingState(supabaseClient, {
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
                  // Fallback to title and description for non-PDFs or failed extractions
                  console.log(`Indexing non-PDF material: ${m.title}`);
                  await indexText({
                      sourceType: 'material',
                      sourceId: m.id,
                      courseId: course_id,
                      title: m.title,
                      text: `Material Title: ${m.title}\nDescription: ${m.description || ''}`,
                      supabaseClient,
                      vercelTarget,
                      gatewaySecret
                  });
              }
          }
      }

      return new Response(JSON.stringify({ success: true, message: `Successfully completed indexing for course ${course_id}` }), {
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
