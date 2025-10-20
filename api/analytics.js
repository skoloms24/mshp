import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req, res) {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const allQuestions = [];

    // Get all MSHP questions with timestamp keys
    try {
      const keys = await redis.keys('mshp:question:*');
      console.log('Found question keys:', keys?.length || 0);
      
      if (keys && keys.length > 0) {
        for (const key of keys) {
          try {
            const data = await redis.get(key);
            if (data && data.question) {
              allQuestions.push({
                question: data.question,
                category: data.category || 'Other Questions',
                icon: data.icon || '❓',
                timestamp: data.timestamp || new Date().toISOString(),
                count: 1
              });
            }
          } catch (e) {
            console.error(`Error getting data for key ${key}:`, e);
          }
        }
      }
    } catch (e) {
      console.error('Error fetching questions:', e);
    }

    // If no questions found, return empty response
    if (allQuestions.length === 0) {
      console.log('No questions found');
      return res.status(200).json({
        success: true,
        totalQuestions: 0,
        uniqueQuestions: 0,
        questions: [],
        timestamp: new Date().toISOString()
      });
    }

    // Sort by timestamp (most recent first)
    allQuestions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Calculate stats
    const totalQuestions = allQuestions.length;
    const uniqueQuestions = new Set(allQuestions.map(q => q.question.toLowerCase())).size;

    console.log(`Returning ${totalQuestions} total questions, ${uniqueQuestions} unique`);

    return res.status(200).json({
      success: true,
      totalQuestions,
      uniqueQuestions,
      questions: allQuestions,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error fetching analytics:', error);
    
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch analytics',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
}
