import { config } from './config';
import { YouTubeService } from './youtube';
import { createApp } from './app';

const youtubeService = new YouTubeService();
const app = createApp(youtubeService);

app.listen(config.PORT, () => {
  console.log(`YouTube service listening on port ${config.PORT}`);
  console.log(`Authorized: ${youtubeService.isAuthorized()}`);
  if (!youtubeService.isAuthorized()) {
    console.log('To authorize: GET /auth/url to get authorization URL');
  }
});
