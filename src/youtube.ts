import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import * as fs from 'fs';
import * as path from 'path';
import { YoutubeTranscript } from 'youtube-transcript';

const TOKEN_PATH = '/data/tokens.json';
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

interface TranscriptEntry {
  text: string;
  duration: number;
  offset: number;
}

export class YouTubeService {
  private oauth2Client: OAuth2Client;
  private youtube: any;

  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.YOUTUBE_CLIENT_ID,
      process.env.YOUTUBE_CLIENT_SECRET,
      process.env.YOUTUBE_REDIRECT_URI
    );

    this.youtube = google.youtube({
      version: 'v3',
      auth: this.oauth2Client,
    });

    this.loadTokens();
  }

  private loadTokens() {
    try {
      if (fs.existsSync(TOKEN_PATH)) {
        const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
        this.oauth2Client.setCredentials(tokens);
        console.log('Loaded existing tokens from', TOKEN_PATH);
      } else {
        console.log('No existing tokens found. Authorization needed.');
      }
    } catch (error) {
      console.error('Error loading tokens:', error);
    }
  }

  private saveTokens(tokens: any) {
    try {
      const dir = path.dirname(TOKEN_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      console.log('Tokens saved to', TOKEN_PATH);
    } catch (error) {
      console.error('Error saving tokens:', error);
      throw error;
    }
  }

  getAuthUrl(): string {
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
    });
  }

  async authorize(code: string): Promise<void> {
    const { tokens } = await this.oauth2Client.getToken(code);
    this.oauth2Client.setCredentials(tokens);
    this.saveTokens(tokens);
  }

  isAuthorized(): boolean {
    const credentials = this.oauth2Client.credentials;
    return !!(credentials && credentials.access_token);
  }

  async fetchWatchLaterVideos(): Promise<VideoInfo[]> {
    if (!this.isAuthorized()) {
      throw new Error('Not authorized. Please complete OAuth flow first.');
    }

    const videos: VideoInfo[] = [];
    let pageToken: string | undefined = undefined;

    try {
      // First, get the Watch Later playlist ID (it's a special playlist)
      // For Watch Later, we use the special playlist ID format
      const channelResponse = await this.youtube.channels.list({
        part: ['contentDetails'],
        mine: true,
      });

      const watchLaterPlaylistId = 'WL'; // Special ID for Watch Later

      // Fetch all videos from the playlist
      do {
        const playlistResponse: any = await this.youtube.playlistItems.list({
          part: ['snippet', 'contentDetails'],
          playlistId: watchLaterPlaylistId,
          maxResults: 50,
          pageToken: pageToken,
        });

        const videoIds = playlistResponse.data.items.map(
          (item: any) => item.contentDetails.videoId
        );

        // Get detailed video information
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
      console.error('Error fetching Watch Later videos:', error);
      throw new Error(`Failed to fetch videos: ${error.message}`);
    }
  }

  async getTranscript(videoId: string): Promise<TranscriptEntry[]> {
    try {
      const transcript = await YoutubeTranscript.fetchTranscript(videoId);
      return transcript.map((entry: any) => ({
        text: entry.text,
        duration: entry.duration,
        offset: entry.offset,
      }));
    } catch (error: any) {
      console.error(`Error fetching transcript for ${videoId}:`, error);
      throw new Error(`Failed to fetch transcript: ${error.message}`);
    }
  }

  async getBatchTranscripts(videoIds: string[]): Promise<{ [videoId: string]: TranscriptEntry[] | null }> {
    const results: { [videoId: string]: TranscriptEntry[] | null } = {};

    for (const videoId of videoIds) {
      try {
        results[videoId] = await this.getTranscript(videoId);
      } catch (error) {
        console.error(`Failed to get transcript for ${videoId}`);
        results[videoId] = null;
      }
    }

    return results;
  }
}