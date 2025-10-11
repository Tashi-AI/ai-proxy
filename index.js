const RATE_LIMITS = new Map();

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { 
        status: 405,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Content-Type': 'text/plain'
        }
      });
    }

    try {
      const { messages, userToken } = await request.json();

      // === RATE LIMITING ===
      if (userToken) {
        const now = Date.now();
        const userKey = `rate_limit_${userToken}`;
        const windowMs = 60000; // 1 minute
        const maxRequests = 10; // 10 requests per minute
        
        const userLimits = RATE_LIMITS.get(userKey) || { 
          count: 0, 
          resetTime: now + windowMs 
        };
        
        // Reset counter if window expired
        if (now > userLimits.resetTime) {
          userLimits.count = 0;
          userLimits.resetTime = now + windowMs;
        }
        
        // Check if user exceeded limit
        if (userLimits.count >= maxRequests) {
          return new Response(JSON.stringify({ 
            error: 'Rate limit exceeded. Please wait 1 minute or upgrade to premium.' 
          }), { 
            status: 429,
            headers: { 
              'Content-Type': 'application/json', 
              'Access-Control-Allow-Origin': origin
            }
          });
        }
        
        // Increment counter
        userLimits.count++;
        RATE_LIMITS.set(userKey, userLimits);
      }

      // === USAGE TRACKING ===
      console.log(`[USAGE] User: ${userToken || 'anonymous'}, Messages: ${messages.length}, Timestamp: ${new Date().toISOString()}`);

      // === AI REQUEST ===
      const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-3.5-turbo',
          messages,
          max_tokens: 500,
        }),
      });

      const data = await openaiResponse.json();
      
      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': origin,
        },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': origin,
        },
      });
    }
  },
};
