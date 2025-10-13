// Enhanced Cloudflare Worker with better error reporting
export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '*';
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
                headers: corsHeaders
            });
        }

        // Enhanced secret verification with logging
        const authHeader = request.headers.get('Authorization');
        const expectedSecret = `Bearer ${env.WORKER_SECRET}`;
        
        console.log(`[AUTH] Received: ${authHeader ? authHeader.substring(0, 10) + '...' : 'MISSING'}`);
        console.log(`[AUTH] Expected: ${expectedSecret.substring(0, 10)}...`);

        if (authHeader !== expectedSecret) {
            return new Response(JSON.stringify({ 
                error: 'Unauthorized access to proxy',
                detail: 'Check WORKER_SECRET configuration'
            }), { 
                status: 401, 
                headers: corsHeaders 
            });
        }

        try {
            const requestBody = await request.json();
            const { messages, userIdForLogging, model = 'gpt-3.5-turbo', max_tokens = 500 } = requestBody;

            console.log(`[REQUEST] User: ${userIdForLogging}, Model: ${model}, Messages: ${messages.length}`);

            // Your existing OpenAI call logic...
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
                console.error(`[OPENAI ERROR] ${openaiResponse.status}:`, errorData);
                throw new Error(`OpenAI API error: ${errorData.error?.message || openaiResponse.statusText}`);
            }

            const data = await openaiResponse.json();
            console.log(`[SUCCESS] User: ${userIdForLogging}, Tokens: ${data.usage?.total_tokens}`);
            
            return new Response(JSON.stringify(data), {
                headers: corsHeaders
            });

        } catch (error) {
            console.error('Worker Error:', error);
            return new Response(JSON.stringify({ 
                error: 'AI service temporarily unavailable.',
                detail: error.message
            }), {
                status: 500,
                headers: corsHeaders
            });
        }
    },
};
