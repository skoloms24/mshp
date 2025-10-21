import OpenAI from "openai";
import { Redis } from "@upstash/redis";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Connect to Redis with MSHP prefix
let redis;
try {
  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  if (redisUrl && redisToken) {
    redis = new Redis({
      url: redisUrl,
      token: redisToken
    });
    console.log('✅ Redis connected successfully');
  } else {
    console.log('❌ Redis credentials not found');
  }
} catch (error) {
  console.error('Redis connection error:', error);
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
};

const responseCache = new Map();
const CACHE_TTL = 3600000;
const SIMILARITY_THRESHOLD = 0.6;

let assistantId = null;
const ASSISTANT_VERSION = "v4";

function normalizeMessage(message) {
  return message.toLowerCase()
    .trim()
    .replace(/[?!.,]/g, '')
    .replace(/\s+/g, ' ');
}

function findSimilarInCache(message) {
  const normalized = normalizeMessage(message);
  const words = normalized.split(' ');
  
  if (responseCache.has(normalized)) {
    const cached = responseCache.get(normalized);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return cached;
    }
  }
  
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

// Helper function to check if message is actually a question
function isActualQuestion(message) {
  const text = message.toLowerCase().trim();
  
  if (text.length < 8) return false;
  
  const nonQuestions = [
    'yes', 'ye', 'no', 'ok', 'okay', 'thanks', 'thank you', 
    'nope', 'yep', 'yeah', 'nah', 'sure', 'fine', 'alright',
    'hello', 'hi', 'hey', 'bye', 'goodbye'
  ];
  if (nonQuestions.includes(text)) return false;
  
  const questionIndicators = [
    'how', 'what', 'when', 'where', 'why', 'who', 'which', 
    'can i', 'do i', 'should i', 'is the', 'is there', 'are there', 
    'will', 'would', 'could', 'does', 'am i', 'may i', '?'
  ];
  
  return questionIndicators.some(indicator => text.includes(indicator));
}

// Categorize questions for MSHP
function categorizeQuestion(question) {
  const q = question.toLowerCase();

  if (
    q.includes("salary") ||
    q.includes("pay") ||
    q.includes("wage") ||
    q.includes("compensation") ||
    (q.includes("how much") && (q.includes("make") || q.includes("earn") || q.includes("paid")))
  ) {
    return { category: "Salary / Pay / Compensation", icon: "💰" };
  }

  // Day in the life / Experience questions
  if (
    (q.includes("what") && q.includes("like") && (q.includes("being") || q.includes("working"))) ||
    q.includes("day in the life") ||
    q.includes("typical day") ||
    (q.includes("what") && q.includes("do") && (q.includes("daily") || q.includes("day to day"))) ||
    q.includes("experience")
  ) {
    return { category: "Day-to-Day / Trooper Experience", icon: "👮" };
  }

  if (
    q.includes("location") ||
    (q.includes("troop") && !q.includes("trooper")) ||
    (q.includes("where") && (q.includes("work") || q.includes("posted") || q.includes("stationed"))) ||
    q.includes("which area") ||
    q.includes("post")
  ) {
    return { category: "Locations / Troop Assignments", icon: "📍" };
  }

  if (
    q.includes("qualification") ||
    q.includes("requirement") ||
    q.includes("eligible") ||
    q.includes("diploma") ||
    q.includes("ged") ||
    q.includes("degree") ||
    q.includes("education") ||
    q.includes("high school") ||
    q.includes("citizen") ||
    q.includes("qualify")
  ) {
    return { category: "Qualifications / Requirements", icon: "✅" };
  }

  if (
    q.includes("fitness") ||
    q.includes("physical") ||
    q.includes("test") && (q.includes("physical") || q.includes("fitness")) ||
    q.includes("500") ||
    q.includes("mile") ||
    q.includes("row")
  ) {
    return { category: "Fitness Test / Physical Requirements", icon: "💪" };
  }

  if (
    (q.includes("how") && (q.includes("apply") || q.includes("application"))) ||
    q.includes("hiring process") ||
    q.includes("application process") ||
    (q.includes("how long") && (q.includes("process") || q.includes("take"))) ||
    q.includes("steps to")
  ) {
    return { category: "Hiring Process / How to Apply", icon: "📝" };
  }

  if (
    q.includes("background") ||
    q.includes("criminal") ||
    q.includes("felony") ||
    q.includes("record") ||
    q.includes("conviction")
  ) {
    return { category: "Background Check / Criminal Record", icon: "🔍" };
  }

  if (
    q.includes("benefit") ||
    q.includes("insurance") ||
    q.includes("health") ||
    q.includes("vacation") ||
    q.includes("time off") ||
    q.includes("retirement")
  ) {
    return { category: "Benefits / Insurance", icon: "🏥" };
  }

  if (
    q.includes("academy") ||
    q.includes("training") ||
    q.includes("graduation") ||
    q.includes("cadet")
  ) {
    return { category: "Training / Academy", icon: "🎓" };
  }

  if (
    q.includes("contact") ||
    q.includes("recruiter") ||
    q.includes("phone") ||
    q.includes("email") ||
    q.includes("call") ||
    q.includes("reach out")
  ) {
    return { category: "Contact / Recruiter", icon: "📞" };
  }

  return { category: "Other Questions", icon: "❓" };
}

// Track analytics with MSHP prefix
async function logAnalytics(question) {
  if (!redis) {
    console.log('Redis not available, skipping analytics');
    return;
  }
  
  if (!isActualQuestion(question)) {
    console.log('⚠️ Skipping non-question:', question);
    return;
  }
  
  try {
    const { category, icon } = categorizeQuestion(question);
    const analyticsKey = `mshp:question:${Date.now()}`;
    
    await redis.set(analyticsKey, {
      question: question,
      category: category,
      icon: icon,
      timestamp: new Date().toISOString(),
    });
    
    await redis.expire(analyticsKey, 30 * 24 * 60 * 60);
    
    console.log(`✅ MSHP Analytics logged: "${question}" → ${icon} ${category}`);
  } catch (error) {
    console.error('❌ Analytics logging error:', error);
  }
}

async function getOrCreateAssistant() {
  const storedVersion = process.env.ASSISTANT_VERSION || "v1";
  
  if (assistantId && storedVersion === ASSISTANT_VERSION) {
    return assistantId;
  }
  
  try {
    const assistant = await openai.beta.assistants.create({
      name: "Missouri State Highway Patrol Recruiting Assistant",
      instructions: `You are the Missouri State Highway Patrol Recruiting Assistant. Tone: warm, concise, plain English.

CRITICAL INSTRUCTIONS:
- Answer questions in 2-5 short sentences using ONLY information provided in these instructions or from the files you have access to
- When asked about salary in ANY way (pay, money, earn, compensation, wages, etc.), you MUST use the EXACT numbers: Starting pay is $66,432, which increases to $73,824 upon graduation from the academy.
- When asked about "troop locations" or "where can I work" or "locations" or "posts", provide specific troop headquarters and coverage areas if available in your documents.
- When asked about qualifications, requirements, or eligibility, explain the minimum qualifications clearly from your documents.
- When asked about the hiring process, application steps, or requirements, explain the process clearly from your documents.
- When asked about the FITNESS TEST, PHYSICAL FITNESS TEST, FITNESS ASSESSMENT, or FITNESS EVALUATION, respond with this EXACT information: The Missouri State Highway Patrol fitness test is designed to evaluate overall endurance and cardiovascular fitness. The assessment consists of two events: the 500-meter row and the 1.5-mile run. Upon completion, the percentile scores from both events are averaged to determine the overall fitness score. To successfully pass the test, applicants must achieve an overall score above the 40th percentile, and no individual event score may fall below the 6th percentile.
- NEVER use numbered lists or bullet points. Write in natural paragraphs with line breaks between thoughts.
- NEVER include source citations, file names, or document references in your responses
- Break longer responses into 2-3 short paragraphs with blank lines between them
- If you're not certain about specific information (other than salary and fitness test which are provided above), say "For specific details about this, please complete the contact form at the bottom of this page and a recruiter can provide more information." and include [SCROLL_TO_FORM]
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

export default async function handler(req, res) {
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

    // Log analytics (with filtering and categorization)
    await logAnalytics(message);

    const cached = findSimilarInCache(message);
    if (cached) {
      console.log("Smart cache hit for:", message);
      return res.status(200).json({
        reply: cached.reply,
        threadId: cached.threadId,
        scrollToForm: cached.scrollToForm,
        cached: true,
        success: true
      });
    }

    const assistId = await getOrCreateAssistant();

    let thread;
    if (threadId) {
      thread = { id: threadId };
    } else {
      thread = await openai.beta.threads.create();
    }

    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message
    });

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

      const normalizedKey = normalizeMessage(message);
      responseCache.set(normalizedKey, {
        reply: cleanReply,
        threadId: thread.id,
        scrollToForm: shouldScrollToForm,
        timestamp: Date.now()
      });

      if (responseCache.size > 100) {
        const oldestKey = responseCache.keys().next().value;
        responseCache.delete(oldestKey);
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
