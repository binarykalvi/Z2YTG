const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const https = require('https');

const OAuth2 = google.auth.OAuth2;

const client_id = process.env.YOUTUBE_CLIENT_ID;
const client_secret = process.env.YOUTUBE_CLIENT_SECRET;
const refresh_token = process.env.YOUTUBE_REFRESH_TOKEN;

const baseTitle = process.env.VIDEO_TITLE;
const description = process.env.VIDEO_DESCRIPTION;
const privacyStatus = process.env.VIDEO_VISIBILITY;

const ZOOM_ACCOUNT_ID    = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID     = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;
const ZOOM_MEETING_UUID  = process.env.ZOOM_MEETING_UUID;

if (!client_id || !client_secret || !refresh_token) {
  process.exit(1);
}

const oauth2Client = new OAuth2(
  client_id,
  client_secret,
  'https://developers.google.com/oauthplayground'
);
oauth2Client.setCredentials({ refresh_token: refresh_token });

const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

function getAllMp4Files(dir, fileList = []) {
  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);

    if (item.isDirectory() && item.name !== 'node_modules' && !item.name.startsWith('.')) {
      getAllMp4Files(fullPath, fileList);
    } else if (item.isFile() && item.name.toLowerCase().endsWith('.mp4')) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

function filterHighestQualityVideos(allFiles) {
  if (allFiles.length === 1) {
    return allFiles;
  }

  const grouped = {};

  for (const filePath of allFiles) {
    const fileName = path.basename(filePath);
    if (fileName.includes('_avo_')) continue;

    const match = fileName.match(/GMT\d+-\d+/);
    const key = match ? match[0] : filePath;

    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(filePath);
  }

  const selectedFiles = [];

  for (const key in grouped) {
    const group = grouped[key];
    let best = group.find(f => f.endsWith('1280x720.mp4') && !f.includes('_as_'));

    if (!best) {
      best = group.find(f => f.includes('1280x720.mp4'));
    }

    if (!best) {
      best = group.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
    }

    if (best) {
      selectedFiles.push(best);
    }
  }

  if (selectedFiles.length === 0 && allFiles.length > 0) {
    return allFiles;
  }

  return selectedFiles.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

async function uploadSingleVideo(videoPath, videoTitle) {
  const res = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: {
        title: videoTitle,
        description: description,
      },
      status: {
        privacyStatus: privacyStatus,
      },
    },
    media: {
      body: fs.createReadStream(videoPath),
    },
  });

  fs.unlinkSync(videoPath);

  return res.data.id;
}

function getZoomAccessToken() {
  return new Promise((resolve, reject) => {
    const postData = `grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`;
    const auth = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');

    const options = {
      hostname: 'zoom.us',
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.access_token) resolve(json.access_token);
          else reject(new Error('Zoom token error'));
        } catch (e) {
          reject(new Error('Zoom token parse error'));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function deleteZoomRecording(accessToken, meetingId) {
  return new Promise((resolve, reject) => {
    let encodedId = encodeURIComponent(meetingId);
    if (meetingId.startsWith('/') || meetingId.includes('//')) {
      encodedId = encodeURIComponent(encodedId);
    }

    const options = {
      hostname: 'api.zoom.us',
      path: `/v2/meetings/${encodedId}/recordings?action=trash`,
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        if (res.statusCode === 204) resolve(true);
        else reject(new Error(`Zoom delete failed (${res.statusCode})`));
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const allFiles = getAllMp4Files(process.cwd());

  if (allFiles.length === 0) {
    process.exit(1);
  }

  const filesToUpload = filterHighestQualityVideos(allFiles);

  for (let i = 0; i < filesToUpload.length; i++) {
    const file = filesToUpload[i];
    const finalTitle = filesToUpload.length > 1
      ? `${baseTitle} (Part ${i + 1}/${filesToUpload.length})`
      : baseTitle;

    try {
      await uploadSingleVideo(file, finalTitle);
    } catch (error) {
      process.exit(1);
    }
  }

  if (ZOOM_MEETING_UUID && ZOOM_ACCOUNT_ID) {
    try {
      const zoomToken = await getZoomAccessToken();
      await deleteZoomRecording(zoomToken, ZOOM_MEETING_UUID);
    } catch (err) {
    }
  }

  const remainingFiles = getAllMp4Files(process.cwd());
  for (const remaining of remainingFiles) {
    if (fs.existsSync(remaining)) {
      fs.unlinkSync(remaining);
    }
  }
}

main();
