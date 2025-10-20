import { kv } from '@vercel/kv';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export default async function handler(req, res) {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // GET - Retrieve analytics
    if (req.method === 'GET') {
      // Get top 20 questions from sorted set
      const topQuestions = await kv.zrange('mshp:questions:ranked', 0, 19, {
        rev: true,
        withScores: true
      });

      // Format the response
      const questions = [];
      for (let i = 0; i < topQuestions.length; i += 2) {
        const question = topQuestions[i];
        const count = topQuestions[i + 1];
        questions.push({
          question,
          count
        });
      }

      // Calculate stats
      const totalQuestions = questions.reduce((sum, q) => sum + q.count, 0);
      const uniqueQuestions = questions.length;
      const mostPopularCount = questions.length > 0 ? questions[0].count : 0;

      return res.status(200).json({
        success: true,
        stats: {
          totalQuestions,
          uniqueQuestions,
          mostPopularCount
        },
        questions
      });
    }

    // DELETE - Clear all analytics
    if (req.method === 'DELETE') {
      // Get all questions
      const allQuestions = await kv.zrange('mshp:questions:ranked', 0, -1);
      
      // Delete individual question counters
      const deletePromises = allQuestions.map(q => 
        kv.del(`mshp:analytics:${q}`)
      );
      await Promise.all(deletePromises);
      
      // Delete the sorted set
      await kv.del('mshp:questions:ranked');

      return res.status(200).json({
        success: true,
        message: 'Analytics cleared successfully'
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('Error in analytics handler:', error);
    return res.status(500).json({
      error: 'Failed to process request',
      details: error.message,
      success: false
    });
  }
}
