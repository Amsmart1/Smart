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
    const { data: authContext, error: authError } = await supabaseClient.rpc('get_ai_access_context', {
        p_operation_type: type,
        p_payload: payload
    });

    if (authError) {
        throw new Error(`Authorization RPC failed: ${authError.message}`);
    }

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
    const vercelProjectUrl = Deno.env.get('VERCEL_PROJECT_URL');
    if (!vercelProjectUrl) {
      throw new Error('Missing environment variable: VERCEL_PROJECT_URL');
    }

    const cleanBaseUrl = vercelProjectUrl.replace(/\/$/, '');
    const vercelTarget = `${cleanBaseUrl}/api/ai-gateway`;

    // Enrich payload with verified identity from DB for context tracking
    const vercelPayload = {
      ...payload,
      email: userEmail,
      role: userRole
    };

    // Forward the fully validated & authorized request to Vercel
    const vercelResponse = await fetch(vercelTarget, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-supabase-signature': gatewaySecret,
        'x-session-id': sessionId
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
    const errorMsg = error instanceof Error ? error.message : String(error);
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
