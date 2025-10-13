// Enhanced Cloudflare Worker with Firebase token validation
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, User-Token',
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
      const { messages, userToken, model = 'gpt-3.5-turbo', max_tokens = 500 } = await request.json();

      // === FIREBASE TOKEN VALIDATION ===
      if (userToken) {
        const hasTokens = await validateUserAndDeductTokens(userToken, env);
        if (!hasTokens) {
          return new Response(JSON.stringify({ 
            error: 'Insufficient tokens' 
          }), { 
            status: 402, // Payment Required
            headers: { 
              'Content-Type': 'application/json', 
              'Access-Control-Allow-Origin': origin
            }
          });
        }
      }

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
            error: 'Rate limit exceeded. Please wait 1 minute.' 
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
          model: model,
          messages: messages,
          max_tokens: max_tokens,
        }),
      });

      if (!openaiResponse.ok) {
        const errorData = await openaiResponse.json();
        throw new Error(`OpenAI API error: ${errorData.error?.message || openaiResponse.statusText}`);
      }

      const data = await openaiResponse.json();
      
      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': origin,
        },
      });
    } catch (error) {
      console.error('Worker Error:', error);
      return new Response(JSON.stringify({ 
        error: 'AI service temporarily unavailable. Please try again.' // ✅ User-friendly
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': origin,
        },
      });
    }
  },
};

// ✅ ADD THIS FUNCTION TO YOUR CLOUDFLARE WORKER
async function validateUserAndDeductTokens(userId, env) {
  try {
    // Call Firebase to check and deduct tokens
    const firebaseUrl = `https://firestore.googleapis.com/v1/projects/surveymonk-service/databases/(default)/documents/users/${userId}`;
    
    // First, get current token balance
    const userDoc = await fetch(firebaseUrl, {
      headers: {
        'Authorization': `Bearer ${env.FIREBASE_ADMIN_TOKEN}` // You'll need to set this up
      }
    });
    
    if (!userDoc.ok) {
      console.error('Firebase user fetch failed');
      return false;
    }
    
    const userData = await userDoc.json();
    const tokensRemaining = userData.fields?.tokensRemaining?.integerValue || 0;
    
    if (tokensRemaining <= 0) {
      return false;
    }
    
    // Deduct 1 token
    const updateUrl = `${firebaseUrl}?updateMask.fieldPaths=tokensRemaining`;
    const updateResponse = await fetch(updateUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${env.FIREBASE_ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          tokensRemaining: { integerValue: tokensRemaining - 1 }
        }
      })
    });
    
    return updateResponse.ok;
    
  } catch (error) {
    console.error('Token validation failed:', error);
    return false;
  }
}

// In-memory rate limiting (resets on worker restart)
const RATE_LIMITS = new Map();
