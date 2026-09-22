import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import * as fs from 'fs';
import * as path from 'path';
import { OAuthConfig } from './config';
import { log, errorMessage } from './log';

const SCOPES = ['https://www.googleapis.com/auth/youtube.readonly'];

interface VideoInfo {
  videoId: string;
  title: string;
  channel: string;
  channelId: string;
  description: string;
  duration: string;
  publishedAt: string;
  thumbnails: {
    default: string;
    medium: string;
    high: string;
  };
}

export type OAuthStatus = 'ok' | 'expired' | 'unauthorized' | 'error';

export interface OAuthCheck {
  status: OAuthStatus;
  checkedAt: string;
  error?: string;
}

export class YouTubeService {
  private oauth2Client: OAuth2Client;
  private youtube: any;
  private readonly tokenPath: string;

  constructor(oauth: OAuthConfig, tokenPath: string) {
    this.tokenPath = tokenPath;
    this.oauth2Client = new google.auth.OAuth2(oauth.clientId, oauth.clientSecret, oauth.redirectUri);

    // Persist refreshed access tokens; keep the existing refresh_token
    // when the event doesn't include a new one.
    this.oauth2Client.on('tokens', (tokens) => {
      try {
        const merged = { ...this.oauth2Client.credentials, ...tokens };
        if (!tokens.refresh_token && this.oauth2Client.credentials.refresh_token) {
          merged.refresh_token = this.oauth2Client.credentials.refresh_token;
        }
        this.oauth2Client.setCredentials(merged);
        this.saveTokens(merged);
      } catch (error) {
        log('error', 'oauth.persist_failed', { error: errorMessage(error) });
      }
    });

    this.youtube = google.youtube({
      version: 'v3',
      auth: this.oauth2Client,
    });

    this.loadTokens();
  }

  private loadTokens() {
    try {
      if (fs.existsSync(this.tokenPath)) {
        const tokens = JSON.parse(fs.readFileSync(this.tokenPath, 'utf-8'));
        this.oauth2Client.setCredentials(tokens);
        log('info', 'oauth.tokens_loaded', { path: this.tokenPath });
      } else {
        log('info', 'oauth.no_tokens', { path: this.tokenPath });
      }
    } catch (error) {
      log('error', 'oauth.tokens_load_failed', { path: this.tokenPath, error: errorMessage(error) });
    }
  }

  private saveTokens(tokens: any) {
    try {
      const dir = path.dirname(this.tokenPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.tokenPath, JSON.stringify(tokens, null, 2));
      log('info', 'oauth.tokens_saved', { path: this.tokenPath });
    } catch (error) {
      log('error', 'oauth.tokens_save_failed', { path: this.tokenPath, error: errorMessage(error) });
      throw error;
    }
  }

  getAuthUrl(): string {
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
    });
  }

  async authorize(code: string): Promise<void> {
    const { tokens } = await this.oauth2Client.getToken(code);
    this.oauth2Client.setCredentials(tokens);
    this.saveTokens(tokens);
  }

  /** Cheap local check: does a stored access token exist? Not proof it still works. */
  isAuthorized(): boolean {
    const credentials = this.oauth2Client.credentials;
    return !!(credentials && credentials.access_token);
  }

  hasRefreshToken(): boolean {
    return !!this.oauth2Client.credentials?.refresh_token;
  }

  /**
   * Actually exchange the refresh token for a new access token. Google answers
   * `invalid_grant` once a Testing-mode refresh token has expired (7 days).
   * `refreshAccessToken()` is marked deprecated in google-auth-library 9.15.1 but
   * is the only public method that forces a refresh regardless of expiry.
   */
  async verifyRefresh(): Promise<OAuthCheck> {
    const checkedAt = new Date().toISOString();
    if (!this.hasRefreshToken()) {
      return { status: 'unauthorized', checkedAt };
    }
    try {
      await this.oauth2Client.refreshAccessToken();
      return { status: 'ok', checkedAt };
    } catch (error) {
      const message = errorMessage(error);
      const status: OAuthStatus = /invalid_grant/i.test(message) ? 'expired' : 'error';
      log('warn', 'oauth.refresh_failed', { status, error: message });
      return { status, checkedAt, error: message };
    }
  }

  async fetchPlaylistVideos(playlistId: string): Promise<VideoInfo[]> {
    if (!this.isAuthorized()) {
      throw new Error('Not authorized. Please complete OAuth flow first.');
    }

    const videos: VideoInfo[] = [];
    let pageToken: string | undefined = undefined;

    try {
      log('info', 'playlist.fetch', { playlistId });

      do {
        const playlistResponse: any = await this.youtube.playlistItems.list({
          part: ['snippet', 'contentDetails'],
          playlistId: playlistId,
          maxResults: 50,
          pageToken: pageToken,
        });

        if (!playlistResponse.data.items || playlistResponse.data.items.length === 0) {
          break;
        }

        const videoIds = playlistResponse.data.items.map(
          (item: any) => item.contentDetails.videoId
        );

        const videoResponse: any = await this.youtube.videos.list({
          part: ['snippet', 'contentDetails'],
          id: videoIds.join(','),
        });

        for (const video of videoResponse.data.items) {
          videos.push({
            videoId: video.id,
            title: video.snippet.title,
            channel: video.snippet.channelTitle,
            channelId: video.snippet.channelId,
            description: video.snippet.description,
            duration: video.contentDetails.duration,
            publishedAt: video.snippet.publishedAt,
            thumbnails: {
              default: video.snippet.thumbnails.default?.url || '',
              medium: video.snippet.thumbnails.medium?.url || '',
              high: video.snippet.thumbnails.high?.url || '',
            },
          });
        }

        pageToken = playlistResponse.data.nextPageToken;
      } while (pageToken);

      return videos;
    } catch (error: any) {
      log('error', 'playlist.fetch_failed', { playlistId, error: errorMessage(error) });
      throw new Error(`Failed to fetch playlist: ${error.message}`);
    }
  }

  async listMyPlaylists(): Promise<any[]> {
    if (!this.isAuthorized()) {
      throw new Error('Not authorized. Please complete OAuth flow first.');
    }

    try {
      const playlistsResponse = await this.youtube.playlists.list({
        part: ['snippet', 'contentDetails'],
        mine: true,
        maxResults: 50
      });

      return playlistsResponse.data.items || [];
    } catch (error: any) {
      log('error', 'playlists.list_failed', { error: errorMessage(error) });
      throw new Error(`Failed to fetch playlists: ${error.message}`);
    }
  }
}
