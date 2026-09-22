import express, { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { YouTubeService } from './youtube';
import { basicAuth } from './auth';
import { config } from './config';
import { HealthReport } from './health';
import { TranscriptService, TranscriptFormat } from './transcripts/service';
import { toTranscriptError } from './transcripts/service';
import { VIDEO_ID_RE } from './transcripts/ytdlp';
import { log, errorMessage } from './log';

export interface AppDeps {
  /** null → transcript-only mode */
  youtube: YouTubeService | null;
  transcripts: TranscriptService;
  health: () => Promise<HealthReport>;
  batchMax?: number;
}

// BCP-47-ish: "en", "de", "en-US", "zh-Hans", "pt-PT"
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const langParam = z.string().regex(LANG_RE, 'lang must be a language code such as "en" or "de-DE"').optional();
const formatParam = z.enum(['json', 'text']).default('json');

const transcriptQuerySchema = z.object({ lang: langParam, format: formatParam });
const batchBodySchema = z.object({
  videoIds: z.array(z.string().regex(VIDEO_ID_RE, 'invalid YouTube video id')),
  lang: langParam,
  format: formatParam,
});

function firstIssue(err: z.ZodError): string {
  const i = err.issues[0];
  return i ? `${i.path.join('.') || 'body'}: ${i.message}` : 'invalid input';
}

export function createApp(deps: AppDeps) {
  const app = express();
  const batchMax = deps.batchMax ?? config.TRANSCRIPT_BATCH_MAX;

  app.use(express.json({ limit: '256kb' }));

  // Health check endpoint (no auth required). Always HTTP 200; `status` says degraded.
  app.get('/health', async (_req: Request, res: Response) => {
    try {
      res.json(await deps.health());
    } catch (error) {
      log('error', 'health.failed', { error: errorMessage(error) });
      res.status(500).json({ status: 'error', error: errorMessage(error) });
    }
  });

  // --- OAuth / playlist routes (503 in transcript-only mode) -----------------

  const requireOAuth = (_req: Request, res: Response, next: NextFunction) => {
    if (!deps.youtube) {
      return res.status(503).json({ error: 'oauth disabled' });
    }
    next();
  };
  const yt = () => deps.youtube as YouTubeService;

  app.get('/auth/url', requireOAuth, (_req: Request, res: Response) => {
    try {
      const authUrl = yt().getAuthUrl();
      res.json({
        authUrl,
        instructions: 'Visit this URL to authorize the application, then use the code with POST /auth/callback'
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Google redirects here (OAUTH_REDIRECT_URI ends in /oauth/callback)
  app.get('/oauth/callback', requireOAuth, async (req: Request, res: Response) => {
    const code = req.query.code as string | undefined;
    if (!code) {
      return res.status(400).send('<html><body><h1>Missing authorization code</h1></body></html>');
    }

    try {
      await yt().authorize(code);
      res.send('<html><body><h1>Authorization successful</h1><p>You can close this tab.</p></body></html>');
    } catch (error: any) {
      res.status(500).send(`<html><body><h1>Authorization failed</h1><p>${error.message}</p></body></html>`);
    }
  });

  // Manual fallback: paste the code from the redirect URL
  app.post('/auth/callback', requireOAuth, async (req: Request, res: Response) => {
    try {
      const { code } = req.body ?? {};
      if (!code) {
        return res.status(400).json({ error: 'Authorization code required' });
      }

      await yt().authorize(code);
      res.json({ success: true, message: 'Authorization successful' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/playlists', basicAuth, requireOAuth, async (_req: Request, res: Response) => {
    try {
      const playlists = await yt().listMyPlaylists();

      res.json({
        count: playlists.length,
        playlists: playlists.map((p: any) => ({
          id: p.id,
          title: p.snippet.title,
          description: p.snippet.description,
          itemCount: p.contentDetails?.itemCount || 0,
          publishedAt: p.snippet.publishedAt
        })),
        timestamp: new Date().toISOString()
      });
    } catch (error: any) {
      log('error', 'route.playlists_failed', { error: errorMessage(error) });
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/playlist/:playlistId', basicAuth, requireOAuth, async (req: Request, res: Response) => {
    try {
      const { playlistId } = req.params;
      const videos = await yt().fetchPlaylistVideos(playlistId);

      res.json({
        playlistId,
        count: videos.length,
        videos: videos,
        timestamp: new Date().toISOString()
      });
    } catch (error: any) {
      log('error', 'route.playlist_failed', { playlistId: req.params.playlistId, error: errorMessage(error) });
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/videos', basicAuth, requireOAuth, async (req: Request, res: Response) => {
    const playlistId = (req.query.playlistId as string) || config.DEFAULT_PLAYLIST_ID;
    if (!playlistId) {
      return res.status(400).json({
        error: 'No playlist specified. Pass ?playlistId=... or set DEFAULT_PLAYLIST_ID in the environment.'
      });
    }

    try {
      const videos = await yt().fetchPlaylistVideos(playlistId);

      res.json({
        playlistId,
        count: videos.length,
        videos: videos,
        timestamp: new Date().toISOString()
      });
    } catch (error: any) {
      log('error', 'route.videos_failed', { playlistId, error: errorMessage(error) });
      res.status(500).json({ error: error.message });
    }
  });

  // --- Transcripts -------------------------------------------------------------

  app.get('/transcript/:videoId', basicAuth, async (req: Request, res: Response) => {
    const { videoId } = req.params;
    if (!VIDEO_ID_RE.test(videoId)) {
      return res.status(400).json({ error: 'invalid YouTube video id' });
    }
    const query = transcriptQuerySchema.safeParse(req.query);
    if (!query.success) {
      return res.status(400).json({ error: firstIssue(query.error) });
    }

    try {
      const result = await deps.transcripts.getTranscript(videoId, query.data);
      res.json({ ...result, timestamp: new Date().toISOString() });
    } catch (error) {
      const te = toTranscriptError(error);
      if (te.httpStatus >= 500) {
        log('error', 'route.transcript_failed', { videoId, code: te.code, reason: te.reason });
      }
      res.status(te.httpStatus).json({ videoId, ...te.toJSON() });
    }
  });

  app.post('/batch-transcripts', basicAuth, async (req: Request, res: Response) => {
    const body = batchBodySchema.safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      const msg = issue?.path[0] === 'videoIds' && issue.code === 'invalid_type' ? 'videoIds must be an array' : firstIssue(body.error);
      return res.status(400).json({ error: msg });
    }
    const { videoIds, lang, format } = body.data;
    if (videoIds.length > batchMax) {
      return res.status(400).json({ error: `too many videoIds: ${videoIds.length} > ${batchMax} (TRANSCRIPT_BATCH_MAX)` });
    }

    try {
      const result = await deps.transcripts.getBatch(videoIds, { lang, format: format as TranscriptFormat });
      res.json({ ...result, timestamp: new Date().toISOString() });
    } catch (error) {
      log('error', 'route.batch_failed', { error: errorMessage(error) });
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  return app;
}
