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

async function getExistingChunkIndexes(supabaseClient: any, materialId: string, activeVersion: string) {
  try {
    const { data } = await supabaseClient
      .from('knowledge_embeddings')
      .select('metadata, embedding_version')
      .eq('source_id', materialId);
    if (data && data.length > 0) {
      const mismatch = data.some((d: any) => d.embedding_version !== activeVersion);
      if (mismatch) {
        console.warn(`Embedding model version mismatch for ${materialId}. Re-indexing required.`);
        return { chunkIndexes: new Set(), versionMismatch: true };
      }
      return {
        chunkIndexes: new Set(data.map((d: any) => d.metadata?.chunk_index).filter((idx: any) => idx !== undefined && idx !== null)),
        versionMismatch: false
      };
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
        const splitSemantically = (rawText: string, limit: number): string[] => {
            const paragraphs = rawText.split(/\r?\n{2,}/);
            const subChunks: string[] = [];
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

    const generateEmbeddings = async (chunks: any[]) => {
        if (chunks.length === 0) return [];
        const batchSize = 10;
        const batches = [];
        for (let i = 0; i < chunks.length; i += batchSize) {
            batches.push(chunks.slice(i, i + batchSize));
        }

        const fetchWithBackoff = async (url: string, options: any, maxRetries = 5, initialDelay = 1000): Promise<any> => {
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
                } catch (err: any) {
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

        const batchResults = await parallelLimit(batches, 4, async (batch) => {
            const embeddingResponse = await fetchWithBackoff(vercelTarget!, {
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

            const embeddingResult = await embeddingResponse.json();
            return embeddingResult.embeddings;
        });

        return batchResults.flat();
    };

    const activeVersion = "gemini-embedding-001"; // Default model version

    const upsertKnowledgeEmbeddings = async ({
        sourceType,
        sourceId,
        courseId,
        title,
        chunks,
        embeddings,
        isAtomicReplace = false
    }: {
        sourceType: string;
        sourceId: string;
        courseId: string;
        title: string;
        chunks: any[];
        embeddings: any[];
        isAtomicReplace?: boolean;
    }) => {
        if (chunks.length === 0) return;

        if (isAtomicReplace) {
            const records = chunks.map((chunk, idx) => ({
                content: chunk.content,
                embedding: embeddings[idx],
                metadata: chunk.metadata
            }));

            console.log(`Performing ATOMIC delete-and-insert for ${sourceType} ${sourceId}`);
            const { error } = await supabaseClient.rpc('atomic_update_embeddings', {
                p_source_type: sourceType,
                p_source_id: sourceId,
                p_course_id: courseId,
                p_embedding_version: activeVersion,
                p_records: records
            });
            if (error) throw error;
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

            const { error } = await supabaseClient.from('knowledge_embeddings').insert(fullRecords);
            if (error) throw error;
        }
    };

    const normalizedText = normalizeText(text);

    const chunks = chunkText(normalizedText);

    // Fetch already indexed chunk indexes from DB
    const { chunkIndexes: existingChunkIndexes, versionMismatch } = await getExistingChunkIndexes(supabaseClient, sourceId, activeVersion);

    const isAtomicReplace = versionMismatch || (existingChunkIndexes.size === 0);

    const chunksToProcess = isAtomicReplace ? chunks : chunks.filter((c: any) => !existingChunkIndexes.has(c.metadata?.chunk_index));

    if (chunksToProcess.length === 0) {
        console.log(`✓ All chunks for ${sourceType} ${sourceId} are already fully indexed. Skipping.`);
        return;
    }

    console.log(`Found ${chunksToProcess.length} chunks to process (out of ${chunks.length} total, isAtomicReplace: ${isAtomicReplace}) for ${sourceType} ${sourceId}.`);

    const embeddings = await generateEmbeddings(chunksToProcess);

    await upsertKnowledgeEmbeddings({
        sourceType,
        sourceId,
        courseId,
        title,
        chunks: chunksToProcess,
        embeddings,
        isAtomicReplace
    });
}

async function fetchCourseMetadata(courseId: string, supabaseClient: any) {
  try {
    const [
      { data: course },
      { data: topics },
      { data: lessons },
      { data: materials }
    ] = await Promise.all([
      supabaseClient.from('courses').select('*').eq('id', courseId).maybeSingle(),
      supabaseClient.from('topics').select('*').eq('course_id', courseId).limit(100),
      supabaseClient.from('lessons').select('id, title, content, topic_id').eq('course_id', courseId).limit(100),
      supabaseClient.from('materials').select('id, title, description, file_url, file_type').eq('course_id', courseId).limit(100)
    ]);

    return {
      course: course || null,
      topics: topics || [],
      lessons: lessons || [],
      materials: materials || []
    };
  } catch (err) {
    console.error('fetchCourseMetadata failed:', err);
    return { course: null, topics: [], lessons: [], materials: [] };
  }
}

function crossEncoderReranker(query: string, candidates: any[]) {
  if (!query || !candidates || candidates.length === 0) return candidates;

  const queryLower = query.toLowerCase().trim();
  const stopWords = new Set(['the', 'and', 'a', 'of', 'to', 'is', 'in', 'that', 'it', 'for', 'on', 'with', 'as', 'at', 'by', 'an']);
  const queryTerms = queryLower.split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));

  const scoredCandidates = candidates.map(c => {
    const textLower = c.content.toLowerCase();
    let overlapScore = 0;

    // Word Overlap / Keyword matching density
    queryTerms.forEach(term => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
        const wordMatches = textLower.match(regex);
        if (wordMatches) {
          overlapScore += wordMatches.length * 2.0; // Term match frequency weight
        }
      } catch (e) {
        if (textLower.includes(term)) {
          overlapScore += 1.5;
        }
      }
    });

    // Semantic proximity & sequence overlap boost
    if (queryTerms.length > 1) {
      for (let i = 0; i < queryTerms.length - 1; i++) {
        const pair = `${queryTerms[i]} ${queryTerms[i+1]}`;
        if (textLower.includes(pair)) {
          overlapScore += 5.0; // Bigram boost
        }
      }
    }

    // Direct substring query match bonus
    if (textLower.includes(queryLower)) {
      overlapScore += 10.0;
    }

    // Combine with original semantic score (Reranking calculation)
    const interactionScore = Math.min(1.0, overlapScore / (queryTerms.length * 4.0 || 1));
    const rerankedScore = (0.4 * (c.hybrid_score || c.similarity || 0.5)) + (0.6 * interactionScore);

    return {
      ...c,
      reranked_score: Number(rerankedScore.toFixed(4))
    };
  });

  // Sort by reranked score descending
  return scoredCandidates.sort((a, b) => b.reranked_score - a.reranked_score);
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

      // 1. Fetch full course structural metadata
      const { course, topics, lessons, materials } = await fetchCourseMetadata(course_id, supabaseClient);
      if (course) {
        vercelPayload.course_title = course.title;
      }

      // 2. Identify the active topic(s) using lexical (keyword) analysis on the user message
      const normMessage = message.toLowerCase();
      let activeTopic: any = null;
      let highestTopicScore = 0;

      for (const topic of topics) {
        const topicWords = topic.title.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2);
        let score = 0;
        for (const word of topicWords) {
          if (normMessage.includes(word)) score += 10;
        }
        if (topic.description) {
          const descWords = topic.description.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2);
          for (const word of descWords) {
            if (normMessage.includes(word)) score += 1;
          }
        }
        if (score > highestTopicScore) {
          highestTopicScore = score;
          activeTopic = topic;
        }
      }

      vercelPayload.active_topic = activeTopic;

      // 3. Generate embedding for user message
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

      // Read threshold dynamically from course metadata if configured, allowing fully customizable tuning per course
      const customThreshold = (course && course.metadata && typeof course.metadata.match_threshold === 'number')
        ? course.metadata.match_threshold
        : 0.3; // Default fallback to 0.3

      const customMatchCount = (course && course.metadata && typeof course.metadata.match_count === 'number')
        ? course.metadata.match_count
        : 20; // Default fallback to 20 candidates

      // Broader candidate set retrieval
      const { data: matches, error: matchError } = await supabaseClient.rpc('match_knowledge', {
          query_embedding: userMessageEmbedding,
          match_threshold: customThreshold,
          match_count: customMatchCount,
          p_course_id: course_id
      });

      if (matchError) {
          console.warn('Semantic search failed, falling back to empty matches:', matchError.message);
      }

      // 4. Forward everything to Vercel
      vercelPayload.semantic_matches = matches || [];
      vercelPayload.course_metadata = { course, topics, lessons, materials };
    } else if (type === 'index_course') {
      const { course_id, material_id } = payload;
      if (!course_id) throw new Error('course_id is required');

      const lockKey = material_id ? `indexing_lock_${material_id}` : `indexing_lock_${course_id}`;
      const lockRequester = 'req_' + Math.random().toString(36).substring(2) + Date.now();

      // Acquire Distributed Lock
      const { data: acquired, error: lockErr } = await supabaseClient.rpc('acquire_indexing_lock', {
          p_lock_key: lockKey,
          p_locked_by: lockRequester,
          p_lease_duration: '10 minutes'
      });

      if (lockErr) throw new Error(`Lock acquisition failed: ${lockErr.message}`);
      if (!acquired) {
          return new Response(JSON.stringify({ error: `Indexing operation already in progress for this ${material_id ? 'material' : 'course'}. Please try again later.` }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              status: 409,
          });
      }

      try {
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

          // Prepare parallelizable concurrent task queue
          const tasks: any[] = [];

          // 1. Index course info itself (only if course-level indexing)
          if (course && !existingCourses.has(course_id)) {
              tasks.push(async () => {
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
              });
          }

          // 2. Index topics (only if course-level indexing)
          if (topics && topics.length > 0) {
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
                              supabaseClient,
                              vercelTarget,
                              gatewaySecret
                          });
                      });
                  }
              }
          }

          // 3. Index lessons (only if course-level indexing)
          if (lessons && lessons.length > 0) {
              const topicsMap: Record<string, string> = {};
              if (topics) {
                  topics.forEach((t: any) => {
                      topicsMap[t.id] = t.title;
                  });
              }

              for (const l of lessons) {
                  if (!existingLessons.has(l.id)) {
                      tasks.push(async () => {
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
                      });
                  }
              }
          }

          if (materials) {
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
                              return;
                          }

                          try {
                              // Stage 1: Download & Text Extraction (Skip if extractedText is already truthy and populated to support full resumption)
                              if (extractedText && extractedText.trim().length > 0) {
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
                  });
              }
          }

          // Execute concurrent tasks with parallel limit pool
          await parallelLimit(tasks, 4, async (task) => await task());

          return new Response(JSON.stringify({ success: true, message: `Successfully completed indexing for course ${course_id}` }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              status: 200,
          });
      } finally {
          // Release distributed lock under all execution paths
          try {
              await supabaseClient.rpc('release_indexing_lock', {
                  p_lock_key: lockKey,
                  p_locked_by: lockRequester
              });
          } catch (releaseErr: any) {
              console.warn('Failed to release indexing distributed lock:', releaseErr.message);
          }
      }
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
