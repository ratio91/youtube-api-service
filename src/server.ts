import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { YouTubeService } from './youtube';
import { basicAuth } from './auth';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const youtubeService = new YouTubeService();

// Health check endpoint (no auth required)
app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'ok',
    authorized: youtubeService.isAuthorized(),
    timestamp: new Date().toISOString()
  });
});

// OAuth flow endpoints
app.get('/auth/url', (req: Request, res: Response) => {
  try {
    const authUrl = youtubeService.getAuthUrl();
    res.json({ 
      authUrl,
      instructions: 'Visit this URL to authorize the application, then use the code with POST /auth/callback'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/auth/callback', express.json(), async (req: Request, res: Response) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: 'Authorization code required' });
    }
    
    await youtubeService.authorize(code);
    res.json({ success: true, message: 'Authorization successful' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Protected endpoints (require basic auth)
app.get('/videos', basicAuth, async (req: Request, res: Response) => {
  try {
    const videos = await youtubeService.fetchWatchLaterVideos();
    
    res.json({
      count: videos.length,
      videos: videos,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Error in /videos endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/transcript/:videoId', basicAuth, async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;
    const transcript = await youtubeService.getTranscript(videoId);
    
    res.json({
      videoId,
      transcript,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error(`Error fetching transcript for ${req.params.videoId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/batch-transcripts', basicAuth, express.json(), async (req: Request, res: Response) => {
  try {
    const { videoIds } = req.body;
    
    if (!Array.isArray(videoIds)) {
      return res.status(400).json({ error: 'videoIds must be an array' });
    }

    const transcripts = await youtubeService.getBatchTranscripts(videoIds);
    
    res.json({
      transcripts,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Error in /batch-transcripts endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.listen(PORT, () => {
  console.log(`YouTube service listening on port ${PORT}`);
  console.log(`Authorized: ${youtubeService.isAuthorized()}`);
  if (!youtubeService.isAuthorized()) {
    console.log('To authorize: GET /auth/url to get authorization URL');
  }
});
