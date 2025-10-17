// Enhanced Cloudflare Worker with comprehensive debugging
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
            return new Response(JSON.stringify({ 
                error: 'Method not allowed',
                detail: 'Only POST requests are accepted'
            }), { 
                status: 405,
                headers: corsHeaders
            });
        }

        // Enhanced secret verification with comprehensive debugging
        const authHeader = request.headers.get('Authorization');
        
        // DEBUG: Log authentication details
        console.log('=== CLOUDFLARE WORKER DEBUG ===');
        console.log('URL:', request.url);
        console.log('Method:', request.method);
        console.log('Auth Header:', authHeader);
        console.log('WORKER_SECRET exists:', !!env.WORKER_SECRET);
        console.log('OPENAI_API_KEY exists:', !!env.OPENAI_API_KEY);
        
        if (!env.WORKER_SECRET) {
            console.error('WORKER_SECRET is not set in environment variables');
            return new Response(JSON.stringify({ 
                error: 'Server configuration error',
                detail: 'WORKER_SECRET not configured'
            }), { 
                status: 500, 
                headers: corsHeaders 
            });
        }

        const expectedSecret = `Bearer ${env.WORKER_SECRET}`;
        console.log('Expected Secret Prefix:', expectedSecret.substring(0, 20) + '...');
        console.log('Auth Match:', authHeader === expectedSecret);

        if (authHeader !== expectedSecret) {
            console.error('Authentication failed:', {
                received: authHeader,
                expected: expectedSecret.substring(0, 20) + '...'
            });
            return new Response(JSON.stringify({ 
                error: 'Unauthorized access to proxy',
                detail: 'Check WORKER_SECRET configuration'
            }), { 
                status: 401, 
                headers: corsHeaders 
            });
        }

        console.log('✅ Authentication successful');

        try {
            const requestBody = await request.json();
            console.log('Request Body Received');
            
            const { messages, userIdForLogging, model = 'gpt-3.5-turbo', max_tokens = 500 } = requestBody;

            // Enhanced validation
            if (!messages || !Array.isArray(messages)) {
                console.error('Validation failed: messages array missing');
                return new Response(JSON.stringify({ 
                    error: 'Invalid request: messages array is required'
                }), { 
                    status: 400, 
                    headers: corsHeaders 
                });
            }

            if (messages.length === 0) {
                console.error('Validation failed: empty messages array');
                return new Response(JSON.stringify({ 
                    error: 'Invalid request: messages array cannot be empty'
                }), { 
                    status: 400, 
                    headers: corsHeaders 
                });
            }

            console.log(`[REQUEST] User: ${userIdForLogging}, Model: ${model}, Messages: ${messages.length}, MaxTokens: ${max_tokens}`);
            console.log(`[MESSAGE SAMPLE] First message: ${messages[0]?.content?.substring(0, 100)}...`);

            // Check OpenAI API key
            if (!env.OPENAI_API_KEY) {
                console.error('OPENAI_API_KEY not configured');
                return new Response(JSON.stringify({ 
                    error: 'OpenAI API key not configured'
                }), { 
                    status: 500, 
                    headers: corsHeaders 
                });
            }

            console.log('Making OpenAI API request...');

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
                    temperature: 0.7
                }),
            });

            console.log(`OpenAI Response Status: ${openaiResponse.status}`);

            if (!openaiResponse.ok) {
                const errorText = await openaiResponse.text();
                console.error(`OpenAI API Error ${openaiResponse.status}:`, errorText);
                
                let errorDetail = `OpenAI API error: ${openaiResponse.status}`;
                try {
                    const errorData = JSON.parse(errorText);
                    errorDetail = errorData.error?.message || errorText;
                } catch (e) {
                    errorDetail = errorText;
                }
                
                return new Response(JSON.stringify({ 
                    error: 'AI service error',
                    detail: errorDetail
                }), {
                    status: openaiResponse.status,
                    headers: corsHeaders
                });
            }

            const data = await openaiResponse.json();
            console.log(`[SUCCESS] User: ${userIdForLogging}, Tokens: ${data.usage?.total_tokens}`);
            
            return new Response(JSON.stringify(data), {
                headers: corsHeaders
            });

        } catch (error) {
            console.error('Worker Unhandled Error:', error);
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
