// Supabase Edge Function: notify
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
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing environment variables: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    }

    const supabaseClient = createClient(supabaseUrl, supabaseServiceKey);

    // Verify Authorization: Strictly use custom x-session-id header
    const sessionId = req.headers.get('x-session-id');
    if (!sessionId) {
      return new Response(JSON.stringify({ error: 'Missing x-session-id header' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401,
      });
    }

    // Identify user and role from session ID
    const { data: secretData, error: secretError } = await supabaseClient
        .from('user_secrets')
        .select('email')
        .eq('session_id', sessionId)
        .single();

    if (secretError || !secretData) {
        return new Response(JSON.stringify({ error: 'Invalid session' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 401,
        });
    }

    const { data: userData, error: userError } = await supabaseClient
        .from('users')
        .select('role, full_name')
        .eq('email', secretData.email)
        .single();

    if (userError || !userData) {
        return new Response(JSON.stringify({ error: 'User not found' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 404,
        });
    }

    const isAdmin = userData.role === 'admin';
    const isTeacher = userData.role === 'teacher';

    if (!isAdmin && !isTeacher) {
        return new Response(JSON.stringify({ error: 'Unauthorized: Admin or Teacher privileges required' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 403,
        });
    }

    const { type, payload } = await req.json();

    if (!type || !payload) {
      return new Response(JSON.stringify({ error: 'Missing request type or payload' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      });
    }

    const { title, message, link, course_id, target_role, target_email, expires_in } = payload;

    if (!title || !message) {
        return new Response(JSON.stringify({ error: 'Title and message are required' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        });
    }

    // Authorization & Validation Logic
    if (isTeacher && !isAdmin) {
        if (course_id) {
            // Verify teacher owns the course
            const { data: course, error: cErr } = await supabaseClient
                .from('courses')
                .select('teacher_email')
                .eq('id', course_id)
                .single();

            if (cErr || !course || course.teacher_email !== secretData.email) {
                return new Response(JSON.stringify({ error: 'Unauthorized: You do not own this course' }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    status: 403,
                });
            }
        } else if (type === 'broadcast') {
            return new Response(JSON.stringify({ error: 'Teachers must specify a course_id for broadcasts' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 400,
            });
        }
    }

    if (type === 'broadcast') {
      // Single record insertion for efficiency
      const { error: bErr } = await supabaseClient
        .from('broadcasts')
        .insert({
            id: crypto.randomUUID(),
            course_id: course_id || null,
            teacher_email: secretData.email,
            target_role: target_role === 'all' ? null : (target_role || null),
            title: title,
            message: message,
            link: link || null,
            expires_at: new Date(Date.now() + (parseInt(expires_in || '30') * 24 * 60 * 60 * 1000)).toISOString()
        });

      if (bErr) throw bErr;

      return new Response(JSON.stringify({ success: true, message: 'Broadcast delivered to engine' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      });
    }

    if (type === 'notify') {
        if (!target_email) {
            return new Response(JSON.stringify({ error: 'target_email is required for targeted notifications' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 400,
            });
        }

        const { error: nErr } = await supabaseClient.rpc('notify_user', {
            p_email: target_email,
            p_title: title,
            p_message: message,
            p_link: link || null,
            p_type: payload.notif_type || 'system'
        });

        if (nErr) throw nErr;

        return new Response(JSON.stringify({ success: true, message: 'Notification delivered' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        });
    }

    return new Response(JSON.stringify({ error: `Unsupported notification type: ${type}` }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    });

  } catch (error) {
    console.error('Edge Function Error:', error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
})
