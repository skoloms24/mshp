import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const responseCache = new Map();
const CACHE_TTL = 3600000; // 1 hour
const SIMILARITY_THRESHOLD = 0.6;

let assistantId = null;

// Smart cache key generation
function normalizeMessage(message) {
  return message.toLowerCase()
    .trim()
    .replace(/[?!.,]/g, '')
    .replace(/\s+/g, ' ');
}

// Find similar cached responses
function findSimilarInCache(message) {
  const normalized = normalizeMessage(message);
  const words = normalized.split(' ');
  
  // Try exact match first
  if (responseCache.has(normalized)) {
    const cached = responseCache.get(normalized);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return cached;
    }
  }
  
  // Find similar queries (60%+ word overlap)
  for (const [cachedKey, cachedValue] of responseCache.entries()) {
    if (Date.now() - cachedValue.timestamp >= CACHE_TTL) continue;
    
    const cachedWords = cachedKey.split(' ');
    const commonWords = words.filter(w => w.length > 3 && cachedWords.includes(w));
    const similarity = commonWords.length / Math.max(words.length, cachedWords.length);
    
    if (similarity >= SIMILARITY_THRESHOLD) {
      console.log(`Cache hit with ${Math.round(similarity * 100)}% similarity`);
      return cachedValue;
    }
  }
  
  return null;
}

async function getOrCreateAssistant() {
  if (assistantId) return assistantId;
  
  try {
    const assistant = await openai.beta.assistants.create({
      name: "Missouri State Highway Patrol Recruiting Assistant",
      instructions: `You are the Missouri State Highway Patrol Recruiting Assistant. Tone: warm, concise, plain English.

CRITICAL INSTRUCTIONS:
- Answer questions in 2-5 short sentences using ONLY information from the files you have access to
- When asked about salary in ANY way (pay, money, earn, compensation, wages, etc.), you MUST use the EXACT numbers: Starting pay is $66,432, which increases to $73,824 upon graduation from the academy.
- When asked about "troop locations" or "where can I work" or "locations" or "posts", provide specific troop headquarters and coverage areas if available in your documents.
- When asked about qualifications, requirements, or eligibility, explain the minimum qualifications clearly from your documents.
- When asked about the hiring process, application steps, or requirements, explain the process clearly from your documents.
- NEVER use numbered lists or bullet points. Write in natural paragraphs with line breaks between thoughts.
- NEVER include source citations, file names, or document references in your responses
- Break longer responses into 2-3 short paragraphs with blank lines between them
- If you're not certain about specific information, say "For specific details about this, please complete the contact form at the bottom of this page and a recruiter can provide more information." and include [SCROLL_TO_FORM]
- DO NOT automatically mention the contact form unless: (1) you don't know the answer, (2) the user asks about applying, contacting someone, or next steps, (3) the user asks for specific location details not in your documents

When the user asks about applying, contacting a recruiter, or next steps, tell them: "Please complete the contact form at the bottom of this page and a recruiter will reach out to you." and include this exact tag: [SCROLL_TO_FORM]`,
      model: "gpt-4o-mini",
      tools: [{ type: "file_search" }],
      tool_resources: {
        file_search: {
          vector_store_ids: ["vs_68efc55ad9108191af23dc3b86942e71"]
        }
      }
    });
    
    assistantId = assistant.id;
    console.log("Created assistant:", assistantId);
    return assistantId;
  } catch (error) {
    console.error("Error creating assistant:", error);
    throw error;
  }
}

function removeCitations(text) {
  let cleaned = text.replace(/【\d+:\d+†[^】]+】/g, '');
  cleaned = cleaned.replace(/\[\d+:\d+†[^\]]+\]/g, '');
  cleaned = cleaned.replace(/\[\d+\]/g, '');
  cleaned = cleaned.replace(/†[^\s]+\.pdf/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

function getCacheKey(message) {
  return message.toLowerCase().trim();
}

export default async function handler(req, res) {
  // Set CORS headers
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Check for API key
    if (!process.env.OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY not found");
      return res.status(500).json({ 
        error: 'Server configuration error',
        details: 'API key not configured',
        success: false
      });
    }

    const { message, threadId } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Check cache
    const cacheKey = getCacheKey(message);
    const cached = responseCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log("Cache hit for:", message);
      return res.status(200).json({
        reply: cached.reply,
        threadId: cached.threadId,
        scrollToForm: cached.scrollToForm,
        cached: true,
        success: true
      });
    }

    // Get or create assistant
    const assistId = await getOrCreateAssistant();

    // Create or use existing thread
    let thread;
    if (threadId) {
      thread = { id: threadId };
    } else {
      thread = await openai.beta.threads.create();
    }

    // Add message to thread
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message
    });

    // Run the assistant
    const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
      assistant_id: assistId
    });

    if (run.status === 'completed') {
      const messages = await openai.beta.threads.messages.list(thread.id);
      const lastMessage = messages.data[0];
      let reply = lastMessage.content[0].text.value;
      
      reply = removeCitations(reply);
      
      const shouldScrollToForm = reply.includes('[SCROLL_TO_FORM]');
      const cleanReply = reply.replace('[SCROLL_TO_FORM]', '').trim();

      // Cache the response
      responseCache.set(cacheKey, {
        reply: cleanReply,
        threadId: thread.id,
        scrollToForm: shouldScrollToForm,
        timestamp: Date.now()
      });

      // Limit cache size
      if (responseCache.size > 100) {
        const firstKey = responseCache.keys().next().value;
        responseCache.delete(firstKey);
      }

      return res.status(200).json({ 
        reply: cleanReply,
        threadId: thread.id,
        scrollToForm: shouldScrollToForm,
        cached: false,
        success: true 
      });
    } else {
      console.error("Run failed with status:", run.status);
      return res.status(500).json({ 
        error: 'Failed to get response',
        details: `Run status: ${run.status}`,
        success: false
      });
    }

  } catch (error) {
    console.error('Error in chat handler:', error);
    return res.status(500).json({ 
      error: 'Failed to process request',
      details: error.message,
      success: false
    });
  }
}
