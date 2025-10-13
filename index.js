// In-memory rate limiting (resets on worker restart)
const RATE_LIMITS = new Map();

// Enhanced Cloudflare Worker for AI Proxy
export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '*';

        // Define CORS headers once
        const corsHeaders = {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': origin
        };
        
        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    ...corsHeaders,
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
                    ...corsHeaders,
                    'Content-Type': 'text/plain'
                }
            });
        }

        // --- NEW: SECRET AUTH CHECK ---
        // This key must match the secret configured in your Cloudflare secrets.
        const WORKER_SECRET = env.WORKER_SECRET; 

        if (request.headers.get('Authorization') !== `Bearer ${WORKER_SECRET}`) {
            return new Response(JSON.stringify({ error: 'Unauthorized access to proxy' }), { 
                status: 401, 
                headers: corsHeaders 
            });
        }
        // --- END NEW SECRET AUTH CHECK ---

        try {
            // Updated destructuring: userToken is replaced by userIdForLogging
            // The Firebase Cloud Function now sends the actual userId here for logging/rate limiting.
            const { messages, userIdForLogging, model = 'gpt-3.5-turbo', max_tokens = 500 } = await request.json();

            // === RATE LIMITING (Now applied to the secure caller ID) ===
            // This rate limits the Cloud Function's calls per user, preventing abuse.
            if (userIdForLogging) {
                const now = Date.now();
                const userKey = `rate_limit_${userIdForLogging}`;
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
                        headers: corsHeaders
                    });
                }
                
                // Increment counter
                userLimits.count++;
                RATE_LIMITS.set(userKey, userLimits);
            }

            // === USAGE TRACKING (Updated to use userIdForLogging) ===
            console.log(`[USAGE] User: ${userIdForLogging || 'unknown_function'}, Messages: ${messages.length}, Timestamp: ${new Date().toISOString()}`);

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
            
            // Final response uses the pre-defined corsHeaders
            return new Response(JSON.stringify(data), {
                headers: corsHeaders
            });
        } catch (error) {
            console.error('Worker Error:', error);
            return new Response(JSON.stringify({ 
                error: 'AI service temporarily unavailable. Please try again.'
            }), {
                status: 500,
                headers: corsHeaders
            });
        }
    },
};
// Note: All Firebase/Google Auth helper functions (validateUserAndDeductTokens, getAccessToken, etc.) 
// have been successfully removed as per the security migration plan.
