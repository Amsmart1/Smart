// Vercel Serverless Function: api/voice-assistant.js
// Handles Voice Assistant native audio dialog using Gemini 2.5 Flash.
// Complete model separation from Gemma 4 31B public assistant.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

module.exports = async function handler(req, res) {
  console.log("Voice Assistant Request:", {
    method: req.method,
    headers: req.headers
  });

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, corsHeaders);
    res.end('ok');
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  try {
    const { message, history = [], audioConfig = {} } = req.body || {};

    // Validate inputs
    if (!message && !audioConfig.audioData) {
      res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing message or audio payload' }));
      return;
    }

    const apiKey = process.env.GEMINI_VOICE_API_KEY || process.env.GEMINI_PLATFORM_API_KEY;
    if (!apiKey) {
      res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Gemini Voice API Key not configured' }));
      return;
    }

    // Voice Assistant uses Gemini 2.5 Flash for Native Audio Dialog capabilities
    const voiceModel = 'gemini-2.5-flash';
    const systemPrompt = `You are the "SmartLMS Voice Assistant", optimized for real-time voice and high-quality audio dialog.
  You respond to users with natural, conversational, and concise language suitable for text-to-speech rendering.`;

    const contents = [
      ...history.map(h => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.content }]
      })),
      { role: 'user', parts: [{ text: message || "Listen to this audio input" }] }
    ];

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${voiceModel}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        system_instruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.6,
          topP: 0.9,
          maxOutputTokens: 1024,
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      res.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Upstream Voice Model returned ${response.status}: ${errorText}` }));
      return;
    }

    const data = await response.json();
    const aiResponse = {
      content: data.candidates?.[0]?.content?.parts?.[0]?.text || 'No voice response generated.',
      raw: data
    };

    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(aiResponse));

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('Voice Assistant Gateway Error:', errorMsg);
    res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: errorMsg,
      timestamp: new Date().toISOString(),
      type: 'voice_gateway_error'
    }));
  }
};
