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
        error: 'AI service temporarily unavailable. Please try again.'
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

// ✅ UPDATED: Firebase Admin SDK Integration
async function validateUserAndDeductTokens(userId, env) {
  try {
    // Use Firebase REST API
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}`;
    
    // Get current user data using Service Account token
    const accessToken = await getAccessToken(env);
    const userResponse = await fetch(firestoreUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!userResponse.ok) {
      console.error('Failed to fetch user:', await userResponse.text());
      return false;
    }

    const userData = await userResponse.json();
    const tokensRemaining = userData.fields?.tokensRemaining?.integerValue || 0;

    // Check if user has tokens
    if (tokensRemaining <= 0) {
      return false;
    }

    // Deduct 1 token using Firestore REST API
    const updateResponse = await fetch(firestoreUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          tokensRemaining: { integerValue: tokensRemaining - 1 },
          lastTokenUse: { timestampValue: new Date().toISOString() },
          totalTokensUsed: { integerValue: (userData.fields?.totalTokensUsed?.integerValue || 0) + 1 }
        }
      })
    });

    if (!updateResponse.ok) {
      console.error('Failed to update tokens:', await updateResponse.text());
      return false;
    }

    console.log(`✅ Deducted 1 token from user ${userId}. Remaining: ${tokensRemaining - 1}`);
    return true;

  } catch (error) {
    console.error('Token validation failed:', error);
    return false;
  }
}

// ✅ Get Google Access Token using Service Account
async function getAccessToken(env) {
  try {
    // For Cloudflare Workers, we need to use the Service Account key directly
    // This is a simplified approach using the private key
    const serviceAccount = {
      "type": "service_account",
      "project_id": env.FIREBASE_PROJECT_ID,
      "private_key_id": env.FIREBASE_PRIVATE_KEY_ID,
      "private_key": env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      "client_email": env.FIREBASE_CLIENT_EMAIL,
      "client_id": env.FIREBASE_CLIENT_ID,
      "auth_uri": "https://accounts.google.com/o/oauth2/auth",
      "token_uri": "https://oauth2.googleapis.com/token",
      "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs"
    };

    // Create JWT manually
    const header = {
      alg: 'RS256',
      typ: 'JWT',
      kid: serviceAccount.private_key_id
    };

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: serviceAccount.token_uri,
      exp: now + 3600,
      iat: now
    };

    // Base64 encode header and payload
    const base64Header = btoa(JSON.stringify(header)).replace(/=/g, '');
    const base64Payload = btoa(JSON.stringify(payload)).replace(/=/g, '');
    const signatureInput = `${base64Header}.${base64Payload}`;

    // Import the crypto module for signing
    const encoder = new TextEncoder();
    const data = encoder.encode(signatureInput);
    
    // Import the private key
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      base64ToArrayBuffer(serviceAccount.private_key),
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256'
      },
      false,
      ['sign']
    );

    // Sign the JWT
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      privateKey,
      data
    );

    const base64Signature = arrayBufferToBase64(signature);
    const jwt = `${signatureInput}.${base64Signature}`;

    // Exchange JWT for access token
    const response = await fetch(serviceAccount.token_uri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
    });

    const tokenData = await response.json();
    return tokenData.access_token;

  } catch (error) {
    console.error('Failed to get access token:', error);
    throw error;
  }
}

// Helper functions for crypto operations
function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/=/g, '');
}

// In-memory rate limiting (resets on worker restart)
const RATE_LIMITS = new Map();
